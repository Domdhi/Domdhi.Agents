#!/usr/bin/env node

/**
 * fs-safe-lint.js — trust-boundary fs-safe regression lint.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/.output/findings/reviews/retro-full-review-260716.md` found the same
 * defect shape three separate times across one epic: a raw `fs.writeFileSync`/
 * `fs.rmSync`-class call bypassing the symlink-safe wrappers in `_lib/fs-safe.js`
 * at a site that crosses the adopter trust boundary (fleet.js/publish.js's
 * `pruneEmptyDirs`, install.js's zone-copy sites, template-updater.js's merge
 * writes). Coverage was reviewer-memory-dependent — this lint makes it mechanical.
 *
 * SCOPE — deliberately NOT `core/`/`hooks/`/`tools/`-wide.
 * -------------------------------------------------------
 * "Trust boundary crossing" is a semantic property (does this write's destination
 * come from an adopter-controlled path?), not something derivable from directory
 * alone. A directory-wide raw-fs-call scan would flag dozens of legitimate
 * workshop-local writes (gate.js reports, telemetry logs, memory store files —
 * none of which ever touch an adopter's tree) and the noise would make the lint
 * something people learn to ignore. Instead `TRUST_BOUNDARY_FILES` hardcodes the
 * confirmed fileset: every module that writes into a *target/adopter* directory
 * — the canonical install, update, scaffold, merger and distribution sources
 * listed below (the `.claude/core/` and `.codex/core/` files of the same names
 * are ten-line generated wrappers with no filesystem call, so they are never
 * listed). If a new module starts writing into an adopter tree, add it to the
 * list — same operating model as path-drift-lint.js's EXTRA_ROOTS/EXTRA_FILES.
 *
 * THE DEFAULT RUN FAILS CLOSED
 * ----------------------------
 * A clean result is only evidence when the list names real sources, so the
 * default fileset is checked as well as scanned:
 *   MISSING_ENTRY  ERROR  a shipped entry (every `.agents/` one, which an
 *                         installation always carries) that cannot be read.
 *   VACUOUS_ENTRY  ERROR  a listed file that is a generated compatibility
 *                         wrapper or holds no filesystem call (`fs.` or a
 *                         `safe*` wrapper outside comments): scanning it proves
 *                         nothing. List the canonical source that does the writing.
 * Workshop-only entries (`tools/`, which an adopter does not carry) are skipped
 * and counted when absent. An explicit path list keeps its lenient behavior.
 *
 * RULES
 *   UNGUARDED_WRITE   ERROR  raw fs.writeFileSync/copyFileSync/cpSync with no
 *                            fs-safe-lint:local marker on the line. Fix: route
 *                            through safeWrite/safeCopy (_lib/fs-safe.js), or
 *                            mark the line if the destination is confirmed
 *                            workshop-local (not adopter-controlled).
 *   UNGUARDED_DELETE  ERROR  raw fs.rmSync/rmdirSync with no marker AND no
 *                            assertNoSymlinkedAncestor() call within the
 *                            preceding GUARD_WINDOW lines (the established
 *                            pattern: guard immediately before the delete, as
 *                            fleet.js/publish.js's pruneEmptyDirs does).
 *
 * Lines carrying the `fs-safe-lint:local` marker are a curated exception, same
 * convention as path-drift-lint.js's KEEP_MARKERS — reserved for destinations
 * hand-verified as workshop-local, not a blanket escape hatch.
 *
 * USAGE
 *   node .claude/core/fs-safe-lint.js [--root <dir>] [paths…]
 *
 * Exit codes: 0 clean · 1 any ERROR · 2 usage error.
 */

const fs = require('fs');
const path = require('path');

const LOCAL_MARKER = 'fs-safe-lint:local';
const WRITE_RE = /fs\.(writeFileSync|copyFileSync|cpSync)\s*\(/;
const DELETE_RE = /fs\.(rmSync|rmdirSync)\s*\(/;
const GUARD_RE = /assertNoSymlinkedAncestor\s*\(/;
const GUARD_WINDOW = 6; // lines to look back for a preceding ancestor-symlink guard

// Confirmed adopter-trust-boundary-crossing modules (see header). Relative to
// the project root passed to runLint: the canonical `.agents/` sources, then the
// workshop-only tools.
const TRUST_BOUNDARY_FILES = [
    '.agents/core/install.js',
    '.agents/core/uninstall.js',
    '.agents/core/template-updater.js',
    '.agents/core/scaffold.js',
    '.agents/core/_lib/skill-merger.js',
    '.agents/core/_lib/agent-merger.js',
    '.agents/core/_lib/zone-copy.js',
    '.agents/core/_lib/settings-merger.js',
    '.agents/core/_lib/shared-agents.js',
    '.agents/core/_lib/git-ignored.js',
    'tools/fleet.js',
    'tools/publish.js',
    'tools/sync-work.js',
];
// Entries an adopter does not carry: absent means skipped and counted, not an error.
const WORKSHOP_ONLY_FILES = TRUST_BOUNDARY_FILES.filter((rel) => rel.startsWith('tools/'));
// The marker every generated compatibility wrapper carries within its first lines.
const WRAPPER_HEADER = /^(?:[^\r\n]*\r?\n){0,11}[^\r\n]*Generated compatibility entry point/;
// A filesystem call outside comments: a raw `fs.` use or a `safe*` wrapper call.
const FS_REFERENCE = /\bfs\.\w+|\bsafe(?:Write|Copy|Delete|Mkdir|Rename|Append)\w*\s*\(/;

/**
 * The text with `//` and block comments removed. String, template and quote-delimited text is kept
 * verbatim, so a `/*` inside a string never swallows real code. A lexical approximation (a regular
 * expression literal holding a quote can mislead it), used only to decide whether a file holds any
 * filesystem call at all; the write rules below scan the full text.
 */
function stripComments(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (ch === '/' && next === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (ch === '/' && next === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 2;
        } else if (ch === '"' || ch === '\'' || ch === '`') {
            let j = i + 1;
            while (j < text.length && text[j] !== ch && !(ch !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

/**
 * Scan file text for raw fs write/delete calls that bypass fs-safe.js.
 * @param {string} text
 * @returns {Array<{line:number, rule:string, severity:string, token:string, hint:string}>}
 */
function scanText(text) {
    const lines = text.split('\n');
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(LOCAL_MARKER)) continue;

        if (WRITE_RE.test(line)) {
            findings.push({
                line: i + 1,
                rule: 'UNGUARDED_WRITE',
                severity: 'ERROR',
                token: line.trim(),
                hint: 'raw fs write/copy — route through safeWrite/safeCopy (_lib/fs-safe.js), or mark the line `fs-safe-lint:local` if the destination is a confirmed workshop-local path (not adopter-controlled)',
            });
            continue;
        }

        if (DELETE_RE.test(line)) {
            const windowStart = Math.max(0, i - GUARD_WINDOW);
            const guarded = lines.slice(windowStart, i).some((l) => GUARD_RE.test(l));
            if (!guarded) {
                findings.push({
                    line: i + 1,
                    rule: 'UNGUARDED_DELETE',
                    severity: 'ERROR',
                    token: line.trim(),
                    hint: 'raw fs delete — route through safeDelete, or call assertNoSymlinkedAncestor() immediately before it, or mark the line `fs-safe-lint:local`',
                });
            }
        }
    }
    return findings;
}

/**
 * Lint the trust-boundary fileset (or an explicit override). The default fileset
 * fails closed (see the header); an explicit list scans what exists.
 * @param {string} projectRoot
 * @param {{ files?: string[] }} [opts]
 * @returns {{ findings: Array, scanned: number, skipped: number }}
 */
function runLint(projectRoot, { files } = {}) {
    const explicit = Boolean(files && files.length);
    const fileset = explicit ? files : TRUST_BOUNDARY_FILES;
    const findings = [];
    let scanned = 0;
    let skipped = 0;
    for (const rel of fileset) {
        const abs = path.join(projectRoot, rel);
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch (error) {
            const absent = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
            if (absent && (explicit || WORKSHOP_ONLY_FILES.includes(rel))) { skipped++; continue; }
            if (explicit) { skipped++; continue; }
            findings.push({
                file: rel, line: 0, rule: 'MISSING_ENTRY', severity: 'ERROR', token: rel,
                hint: absent
                    ? 'a required trust-boundary source is missing; update TRUST_BOUNDARY_FILES to the real source path'
                    : `a trust-boundary source exists but could not be read (${(error && error.code) || 'unknown error'}); fix its permissions or type`,
            });
            continue;
        }
        if (!explicit && (WRAPPER_HEADER.test(text) || !FS_REFERENCE.test(stripComments(text)))) {
            findings.push({
                file: rel, line: 1, rule: 'VACUOUS_ENTRY', severity: 'ERROR', token: rel,
                hint: 'this entry is a generated wrapper or holds no filesystem call, so scanning it proves nothing; list the canonical source that does the writing',
            });
            continue;
        }
        scanned++;
        for (const hit of scanText(text)) {
            findings.push({ file: rel, ...hit });
        }
    }
    return { findings, scanned, skipped };
}

function formatReport({ findings, scanned, skipped = 0 }) {
    const skippedNote = skipped ? ` (${skipped} workshop-only file${skipped === 1 ? '' : 's'} absent and skipped)` : '';
    if (findings.length === 0) {
        return `fs-safe-lint: clean — ${scanned} files scanned${skippedNote}.\n`;
    }
    const errors = findings.filter((f) => f.severity === 'ERROR');
    const lines = [`fs-safe-lint: ${errors.length} error(s) across ${scanned} files${skippedNote}\n`];
    for (const f of findings) {
        lines.push(`  ${f.severity.padEnd(5)} ${f.file}:${f.line} ${f.rule} '${f.token}' — ${f.hint}`);
    }
    lines.push('');
    return lines.join('\n');
}

module.exports = {
    TRUST_BOUNDARY_FILES,
    WORKSHOP_ONLY_FILES,
    scanText,
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
            if (!argv[i]) { process.stderr.write('usage: fs-safe-lint.js [--root <dir>] [paths…]\n'); process.exit(2); }
        } else if (argv[i].startsWith('-')) {
            process.stderr.write(`fs-safe-lint.js: unknown flag ${argv[i]}\nusage: fs-safe-lint.js [--root <dir>] [paths…]\n`);
            process.exit(2);
        } else {
            explicit.push(argv[i]);
        }
    }
    const result = runLint(root, { files: explicit.length ? explicit : undefined });
    process.stdout.write(formatReport(result));
    process.exit(result.findings.some((f) => f.severity === 'ERROR') ? 1 : 0);
}
