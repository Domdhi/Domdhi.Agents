#!/usr/bin/env node

/**
 * path-drift-lint.js — writer/reader path-drift lint (recurring health check).
 *
 * WHY THIS EXISTS
 * ---------------
 * The v4.95-window retro counted FOUR independent instances of one defect shape:
 * a path changes where it lives or how it's named, and at least one consumer —
 * a glob, a reader function, or a paragraph of prose — is not updated in the
 * same pass (skill-evolution readers, pre-compaction paths, the handoff-prune
 * glob, CLAUDE.md's handoff prose). The `migrate-all-readers-of-a-shared-path-
 * in-one-wave` workflow memory was being re-learned per instance; this lint is
 * its mechanical form.
 *
 * It is the FORWARD-looking companion to `migrate-output-layout.js --verify`:
 * --verify scans for residue of the one-time ADR-0006 migration (legacy tokens),
 * while this lint additionally checks that literals match the CURRENT resolvers'
 * shape — and is meant to keep running long after the migrator fossilizes.
 * Ground truth is imported, never restated: the legacy-token table and fileset
 * walker come from migrate-output-layout.js, the compartment registry from
 * constants.js OUTPUT_PATHS, and the handoff shape from handoff-path.js.
 *
 * RULES
 *   LEGACY_TOKEN        ERROR  pre-taxonomy `.output/…` token survives
 *                              (effectiveRefRewrites — honors the tracked-work
 *                              carve-out, same as --verify)
 *   FLAT_HANDOFF        ERROR  a literal/glob addresses a file DIRECTLY under
 *                              handoffs/ with no {YYYY-MM} month segment.
 *                              handoff-path.js buildWritePath() is
 *                              unconditionally month-bucketed; a flat reader
 *                              glob silently misses every current handoff (the
 *                              F2/F3/F4 defect, reproduced live)
 *   UNKNOWN_COMPARTMENT WARN   a literal `.output/<seg>` first segment (or a
 *                              findings/evolution child) not in OUTPUT_PATHS.
 *                              WARN, not ERROR — the taxonomy is OPEN (adopters
 *                              grow compartments); in the workshop it usually
 *                              means drift
 *
 * Placeholder/glob segments (`{stamp}`, `*`, `${var}`) are never judged by
 * UNKNOWN_COMPARTMENT — only literal names are. Lines carrying `migrate:keep`
 * or `path-lint:keep` are skipped (load-bearing legacy examples). Test trees
 * (`__tests__/`, `_helpers/`) are skipped entirely: fixtures legitimately
 * exercise legacy/flat shapes.
 *
 * USAGE
 *   node .claude/core/path-drift-lint.js [--root <dir>] [paths…]
 *
 * Fileset defaults to the migrator's template fileset (.claude/, tools/,
 * docs/reference/, CLAUDE.md, docs/CLAUDE.md, README.md) plus docs/engineering/
 * (durable conventions prose cites .output paths too).
 *
 * Exit codes: 0 clean or WARN-only · 1 any ERROR · 2 usage error.
 */

const fs = require('fs');
const path = require('path');
const { OUTPUT_PATHS } = require('./constants');
const {
    REF_REWRITES,
    effectiveRefRewrites,
    findSurvivors,
    resolveFileset,
    collectFiles,
} = require('./migrate-output-layout');

const KEEP_MARKERS = ['migrate:keep', 'path-lint:keep'];
const IDENT_RE = /[A-Za-z0-9_-]/;

// Extra default roots/files beyond the migrator's fileset (durable prose that
// cites paths). The LIVING plan files are listed individually — the rest of
// docs/work/ (scratch/, timeline.md, drained-cycle todo/ checklists) is
// historical as-of-date record where old paths are correct-in-context and
// rewriting them would falsify history (/evolve archives them instead).
const EXTRA_ROOTS = ['docs/engineering'];
const EXTRA_FILES = ['docs/work/backlog.md', 'docs/work/roadmap.md'];

// Fixtures deliberately exercise legacy/flat shapes; this file and its test carry
// rule patterns as data. version.json's inline changelog narrates old paths as
// release history (same nature as CHANGELOG.md, which the migrator skips), and
// migrate-memory-store-paths.js is the Amendment-2 codemod whose old tokens ARE
// its rewrite table.
const SELF_SKIP_RES = [
    /(^|\/)__tests__(\/|$)/,
    /(^|\/)_helpers(\/|$)/,
    /(^|\/)path-drift-lint(\.test)?\.js$/,
    /(^|\/)migrate-memory-store-paths(\.test)?\.js$/,
    /(^|\/)version\.json$/,
];

// Legacy tokens beyond the taxonomy migrator's table: the ADR-0006 Amendment 2
// split-store migration (memories/ → .memory + .state/memory-*) has its own
// codemod (migrate-memory-store-paths.js RULES — dual string/path.join forms,
// too specialized to import). For drift DETECTION the bare catch-all suffices.
const EXTRA_LEGACY = [
    ['.output/memories', '.output/.memory (split store — sub-path mapping in migrate-memory-store-paths.js)'],
];

// ── registry-derived ground truth ────────────────────────────────────────────
/** First path segments that legitimately live directly under docs/.output/. */
function knownTopSegments() {
    return new Set(Object.values(OUTPUT_PATHS).map((e) => e.dir.split('/')[0]));
}

/** { findings: Set(reviews,…), evolution: Set(intake,…) } from grouping compartments. */
function groupChildren() {
    const groups = {};
    for (const e of Object.values(OUTPUT_PATHS)) {
        if (e.group) groups[e.dir] = new Set();
    }
    for (const e of Object.values(OUTPUT_PATHS)) {
        const [top, child] = e.dir.split('/');
        if (child && groups[top]) groups[top].add(child);
    }
    return groups;
}

/** First segments of legacy tokens — R1 territory; R3 must not double-report them.
 *  Built from the FULL table (not the effective set) so a tracked-work carve-out
 *  suppressing the `.output/work` rewrite doesn't turn those intentional literals
 *  into UNKNOWN_COMPARTMENT warnings. */
function legacyTopSegments() {
    return new Set([...REF_REWRITES, ...EXTRA_LEGACY]
        .map(([oldTok]) => oldTok.slice('.output/'.length).split('/')[0]));
}

// ── rule: FLAT_HANDOFF ───────────────────────────────────────────────────────
// A "path token" segment may carry placeholders/globs ({stamp}, *, ${var}).
const SEG_RE = /^[A-Za-z0-9._*{}$-]+/;
const MONTH_SEG_RE = /^(\{YYYY-MM\}|\d{4}-\d{2}|\*\*?)$/;
const STAMP_START_RE = /^(\{stamp\}|\d{6}-\d{4})/;

/**
 * Flag file-looking segments sitting DIRECTLY under handoffs/ (no month segment,
 * no directory descent). Returns [{ col, token }].
 */
function checkFlatHandoff(line) {
    const hits = [];
    const needle = 'handoffs/';
    let idx = 0;
    while ((idx = line.indexOf(needle, idx)) !== -1) {
        const before = idx === 0 ? '' : line[idx - 1];
        if (before && IDENT_RE.test(before)) { idx += 1; continue; }
        const after = line.slice(idx + needle.length);
        const m = SEG_RE.exec(after);
        const seg = m ? m[0] : '';
        const descends = seg && after[seg.length] === '/';
        if (seg && !descends && !MONTH_SEG_RE.test(seg)) {
            // Only file-looking segments — a bare word after handoffs/ in prose is fine.
            if (/\.md$/.test(seg) || STAMP_START_RE.test(seg)) {
                hits.push({ col: idx + 1, token: needle + seg });
            }
        }
        idx += needle.length;
    }
    return hits;
}

// ── rule: UNKNOWN_COMPARTMENT ────────────────────────────────────────────────
// Literal-only segment (no placeholders/globs — those are never judged).
const LITERAL_SEG_RE = /^[A-Za-z0-9._-]+/;

/**
 * Flag literal `.output/<seg>` first segments (and findings/evolution children)
 * absent from the OUTPUT_PATHS registry. Returns [{ col, token }].
 */
function checkCompartments(line, { known, groups, legacyTops } = {}) {
    const k = known || knownTopSegments();
    const g = groups || groupChildren();
    const legacy = legacyTops || legacyTopSegments();
    const hits = [];
    const needle = '.output/';
    let idx = 0;
    while ((idx = line.indexOf(needle, idx)) !== -1) {
        const before = idx === 0 ? '' : line[idx - 1];
        if (before && IDENT_RE.test(before)) { idx += 1; continue; }
        const after = line.slice(idx + needle.length);
        const m = LITERAL_SEG_RE.exec(after);
        // Strip trailing dots: sentence punctuation glued to a path in prose
        // ("…the door into docs/.output/."), never part of a real segment name.
        const rawSeg = m ? m[0] : '';
        const seg = rawSeg.replace(/\.+$/, '');
        if (!seg) { idx += needle.length; continue; }
        if (legacy.has(seg)) { idx += needle.length; continue; } // R1's territory
        if (!k.has(seg)) {
            hits.push({ col: idx + 1, token: needle + seg });
        } else if (g[seg] && after[rawSeg.length] === '/') {
            const m2 = LITERAL_SEG_RE.exec(after.slice(rawSeg.length + 1));
            const child = (m2 ? m2[0] : '').replace(/\.+$/, '');
            if (child && !g[seg].has(child) && !/^\d{4}-\d{2}$/.test(child)) {
                hits.push({ col: idx + 1, token: `${needle}${seg}/${child}` });
            }
        }
        idx += needle.length;
    }
    return hits;
}

// ── driver ───────────────────────────────────────────────────────────────────
function isSelfSkipped(relPath) {
    const p = relPath.split(path.sep).join('/');
    return SELF_SKIP_RES.some((re) => re.test(p));
}

/**
 * Lint the fileset. @returns {{ findings: Array<{file,line,col,rule,severity,token,hint}>, scanned: number }}
 */
function runLint(projectRoot, { paths = null } = {}) {
    const { rules: baseRules } = effectiveRefRewrites(projectRoot);
    // Longest-first so a longer old-token (superset match) always wins.
    const rules = [...baseRules, ...EXTRA_LEGACY].sort((a, b) => b[0].length - a[0].length);
    const rewriteMap = new Map(rules);
    const known = knownTopSegments();
    const groups = groupChildren();
    const legacyTops = legacyTopSegments();

    let files = resolveFileset(projectRoot, paths && paths.length ? paths : null);
    if (!paths || !paths.length) {
        for (const r of EXTRA_ROOTS) collectFiles(path.join(projectRoot, r), projectRoot, files);
        for (const f of EXTRA_FILES) collectFiles(path.join(projectRoot, f), projectRoot, files);
    }
    files = [...new Set(files)];

    const findings = [];
    let scanned = 0;
    for (const abs of files) {
        const rel = path.relative(projectRoot, abs);
        if (isSelfSkipped(rel)) continue;
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        scanned++;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (KEEP_MARKERS.some((mk) => line.includes(mk))) continue;
            for (const { token, col } of findSurvivors(line, rules)) {
                findings.push({
                    file: rel, line: i + 1, col, rule: 'LEGACY_TOKEN', severity: 'ERROR',
                    token, hint: `→ ${rewriteMap.get(token)}`,
                });
            }
            for (const { token, col } of checkFlatHandoff(line)) {
                findings.push({
                    file: rel, line: i + 1, col, rule: 'FLAT_HANDOFF', severity: 'ERROR',
                    token, hint: 'handoffs are month-bucketed: handoffs/{YYYY-MM}/… (resolve via handoff-path.js; a flat glob misses every current handoff)',
                });
            }
            for (const { token, col } of checkCompartments(line, { known, groups, legacyTops })) {
                findings.push({
                    file: rel, line: i + 1, col, rule: 'UNKNOWN_COMPARTMENT', severity: 'WARN',
                    token, hint: 'not in constants.js OUTPUT_PATHS — drift, or an intentional open-taxonomy compartment (register it there)',
                });
            }
        }
    }
    return { findings, scanned };
}

function formatReport({ findings, scanned }) {
    const errors = findings.filter((f) => f.severity === 'ERROR');
    const warns = findings.filter((f) => f.severity === 'WARN');
    if (findings.length === 0) {
        return `path-drift-lint: clean — ${scanned} files scanned.\n`;
    }
    const lines = [`path-drift-lint: ${errors.length} error(s), ${warns.length} warning(s) across ${scanned} files\n`];
    for (const f of findings) {
        lines.push(`  ${f.severity.padEnd(5)} ${f.file}:${f.line}:${f.col} ${f.rule} '${f.token}' ${f.hint}`);
    }
    lines.push('');
    return lines.join('\n');
}

module.exports = {
    checkFlatHandoff,
    checkCompartments,
    knownTopSegments,
    groupChildren,
    legacyTopSegments,
    runLint,
    formatReport,
};

// ---- CLI ----
if (require.main === module) {
    const argv = process.argv.slice(2);
    let root = process.cwd();
    const explicit = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root') {
            root = path.resolve(argv[++i] || '');
            if (!argv[i]) { process.stderr.write('usage: path-drift-lint.js [--root <dir>] [paths…]\n'); process.exit(2); }
        } else if (argv[i].startsWith('-')) {
            process.stderr.write(`path-drift-lint.js: unknown flag ${argv[i]}\nusage: path-drift-lint.js [--root <dir>] [paths…]\n`);
            process.exit(2);
        } else {
            explicit.push(argv[i]);
        }
    }
    const result = runLint(root, { paths: explicit });
    process.stdout.write(formatReport(result));
    process.exit(result.findings.some((f) => f.severity === 'ERROR') ? 1 : 0);
}
