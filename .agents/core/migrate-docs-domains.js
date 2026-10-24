#!/usr/bin/env node

/**
 * migrate-docs-domains — the one deterministic, unit-tested codemod that moves
 * docs/ from the flat `_project-*.md` + scattered-folder layout into the seven
 * concern-domains (ADR 2026-06-20 "docs/ Domain Taxonomy").
 *
 * It lives in `.claude/core/` (not tools/) ON PURPOSE: it propagates to adopters
 * on `fleet:sync`, so each adopter re-aligns its OWN docs/ with one command
 * (`node .claude/core/migrate-docs-domains.js --move docs/ --apply`) — a
 * history-preserving migration, not a hand-move.
 *
 * Two tables, one taxonomy:
 *   FILE_MOVES   — real files/dirs to `git mv` (drives --move). docs-relative.
 *                  ORDERED: pull specific files out of a dir BEFORE moving the dir.
 *   REF_REWRITES — string path references to rewrite (drives --refs/--verify).
 *                  Sorted longest-first at load so a specific token always wins
 *                  over a substring of it (the `_project-design` ⊂ `…-design.md`
 *                  collision). Boundary-anchored so a token only matches a real
 *                  path occurrence, never a fragment of a longer identifier.
 *
 * Modes:
 *   --refs   [--apply] [--root <dir>] [paths…]   rewrite references (dry-run default)
 *   --move   <docsRoot> [--apply]                git mv the real tree (incl. ADR corpus)
 *   --verify [--root <dir>] [paths…]             grep for surviving legacy tokens; exit 1 if any
 *
 * Safety: dry-run first (prints a unified-ish diff), idempotent (re-run is a
 * no-op — new paths don't match old tokens), self-verifying, and skip-allowlisted
 * (never touches _archive/, generated .output/, CHANGELOG, or the load-bearing
 * legacy-literal files — doc-drift.js & this script — which are hand-patched).
 * A line carrying the `migrate:keep` marker is skipped verbatim.
 *
 * Exit codes: 0 ok · 1 verify found survivors · 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── FILE_MOVES (docs-relative) — drives --move ──────────────────────────────
// Order is load-bearing: `todo/_backlog.md` is promoted to `work/backlog.md`
// BEFORE the residual `todo/` dir is moved to `work/todo/`, else _backlog.md
// would ride the dir move into the wrong home.
const FILE_MOVES = [
    ['_project-brief.md', 'product/brief.md'],
    ['_project-requirements.md', 'product/requirements.md'],
    ['_project-context.md', 'product/context.md'],
    ['_brainstorm.md', 'product/brainstorm.md'],
    ['_research.md', 'product/research.md'],
    ['_project-architecture.md', 'architecture/overview.md'],
    ['_project-design.md', 'design/spec.md'],
    ['design/_wireframes.md', 'design/wireframes.md'],
    ['design/_design.light.md', 'design/theme.light.md'],
    ['design/_design.dark.md', 'design/theme.dark.md'],
    ['design/_mock-layout.html', 'design/mock.html'],
    ['reference/engineering-conventions.md', 'engineering/conventions.md'],
    ['_project-timeline.md', 'work/timeline.md'],
    ['todo/_backlog.md', 'work/backlog.md'],            // promote OUT of todo/ first
    ['todo/_feature-ideas.md', 'work/todo/feature-ideas.md'],  // drop _, into work/todo/
    ['todo/', 'work/todo/'],                            // dir: TODO_*, _archive, _design-notes
    ['app/', 'modules/'],                               // dir: per-feature docs
    // NOTE: docs/.output/work/ deliberately NOT moved — task working files stay
    // in the generated zone (docs/.output/work/{date}/{task}/). There is no
    // work/scratch/.
];

// ── REF_REWRITES — drives --refs / --verify ─────────────────────────────────
// [oldToken, newToken]. Declared unordered for readability; sorted longest-first
// below so the most-specific token always matches before any substring of it.
// Specific *file* tokens carry both bare and `.md` forms (prose cites both). The
// generic *directory* tokens are docs/-prefix-anchored only — a bare `todo/` or
// `app/` is too collision-prone to auto-rewrite and is left for the residue
// report + hand-patch (plan T3.3).
const REF_REWRITES_RAW = [
    // ── skill-owned template ASSETS (rename to flat domain names) ──────────────
    // `assets/`-anchored so they match BOTH the full manifest path
    // (.claude/skills/X/assets/_project-Y.md) AND the relative refs inside a
    // skill's own SKILL.md (assets/_project-Y.md, ../assets/_project-Y.md). They
    // win over the generic file tokens below (longest-first) so an asset ref never
    // becomes a bogus `assets/<domain>/<file>.md` subdir. The asset FILES are
    // git-mv'd to match these flat names.
    ['assets/_project-design.md', 'assets/spec.md'],
    ['assets/_wireframes.md', 'assets/wireframes.md'],
    ['assets/_design.light.md', 'assets/theme.light.md'],
    ['assets/_design.dark.md', 'assets/theme.dark.md'],
    ['assets/_mock-layout.html', 'assets/mock.html'],
    ['assets/_project-architecture.md', 'assets/overview.md'],
    ['assets/_project-context.md', 'assets/context.md'],
    ['assets/_project-brief.md', 'assets/brief.md'],
    ['assets/_project-requirements.md', 'assets/requirements.md'],
    ['assets/_feature-ideas.md', 'assets/feature-ideas.md'],
    ['assets/_backlog.md', 'assets/backlog.md'],
    // product/
    ['_project-brief.md', 'product/brief.md'],
    ['_project-brief', 'product/brief'],
    ['_project-requirements.md', 'product/requirements.md'],
    ['_project-requirements', 'product/requirements'],
    ['_project-context.md', 'product/context.md'],
    ['_project-context', 'product/context'],
    ['_brainstorm.md', 'product/brainstorm.md'],
    ['_research.md', 'product/research.md'],
    // architecture/
    ['_project-architecture.md', 'architecture/overview.md'],
    ['_project-architecture', 'architecture/overview'],
    // design/
    ['_project-design.md', 'design/spec.md'],
    ['_project-design', 'design/spec'],
    ['design/_wireframes.md', 'design/wireframes.md'],
    ['design/_design.light.md', 'design/theme.light.md'],
    ['design/_design.dark.md', 'design/theme.dark.md'],
    ['design/_mock-layout.html', 'design/mock.html'],
    // ── BARE basenames (underscore-drop / design rename) ───────────────────────
    // The directory-prefixed rules above only fire where a dir prefix is present.
    // Command/agent/skill PROSE cites these files bare as shorthand (`_backlog.md`,
    // `_wireframes.md`); those refs are now stale (the files dropped the `_` /were
    // renamed). Map bare→bare (drop the `_` only) — NOT bare→full-path — so a ref
    // already inside a `docs/design/ (…)` or `docs/work/` context doesn't double
    // the directory. Longest-first ordering means the prefixed rules above still
    // win wherever a prefix exists; these only catch the standalone basename.
    // Legacy-DETECTION prose that intentionally cites the old name (onboard.md,
    // check-sync.md, doc-drift.js) is protected by the `migrate:keep` marker / the
    // skip-allowlist — without that guard this rule would corrupt it.
    ['_backlog.md', 'backlog.md'],
    ['_feature-ideas.md', 'feature-ideas.md'],
    ['_brief.md', 'brief.md'],          // module brief: modules/{name}/_brief.md → brief.md
    ['_wireframes.md', 'wireframes.md'],
    ['_design.light.md', 'theme.light.md'],
    ['_design.dark.md', 'theme.dark.md'],
    ['_mock-layout.html', 'mock.html'],
    // engineering/
    ['reference/engineering-conventions.md', 'engineering/conventions.md'],
    // work/
    ['_project-timeline.md', 'work/timeline.md'],
    ['_project-timeline', 'work/timeline'],
    ['docs/todo/_backlog.md', 'docs/work/backlog.md'],
    ['todo/_backlog.md', 'work/backlog.md'],
    ['docs/todo/_feature-ideas.md', 'docs/work/todo/feature-ideas.md'],
    ['todo/_feature-ideas.md', 'work/todo/feature-ideas.md'],
    ['docs/todo/_archive', 'docs/work/todo/_archive'],
    ['docs/todo/', 'docs/work/todo/'],
    ['docs/todo', 'docs/work/todo'],                    // no-slash dir ref (e.g. scaffold extraDirs)
    // NOTE: docs/.output/work/ is NOT rewritten — task working files stay in the
    // generated zone; there is no work/scratch/ target.
    // modules (fractal axis)
    ['docs/app/', 'docs/modules/'],
    ['docs/app', 'docs/modules'],                       // no-slash dir ref
];

// Longest-first: a longer old-token is a superset match and must win.
const REF_REWRITES = [...REF_REWRITES_RAW].sort((a, b) => b[0].length - a[0].length);

// ── Skip-allowlist ──────────────────────────────────────────────────────────
// Paths that intentionally retain legacy tokens (history, generated output) or
// whose legacy literals are load-bearing and hand-patched instead.
const SKIP_PATH_RES = [
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)_archive(\/|$)/,
    /(^|\/)\.archive(\/|$)/,
    /(^|\/)\.output(\/|$)/,            // generated reports/memories (incl. the ADR + this plan)
    // ADRs are immutable as-of-date history (append-only, "never deleted") — the
    // codemod MOVES them into architecture/decisions/ but must not rewrite their
    // bodies, exactly as it leaves _archive prose alone. Without this, --verify
    // would flag legacy tokens inside historical decision records.
    /(^|\/)architecture\/decisions(\/|$)/,
    /(^|\/)CHANGELOG\.md$/,            // historical release notes
    // Load-bearing legacy literals — these files reference OLD names on purpose
    // (drift detector / this codemod & its fixtures); hand-patched, never blind-rewritten.
    /(^|\/)doc-drift\.js$/,
    /(^|\/)doc-drift\.test\.js$/,
    /(^|\/)migrate-docs-domains\.js$/,
    /(^|\/)migrate-docs-domains\.test\.js$/,
];

// Default fileset roots walked when --refs/--verify get no explicit paths.
const TEMPLATE_FILESET = ['.claude', 'tools', 'docs/reference', 'docs/guides', 'docs/concepts'];
const TEMPLATE_FILES = ['CLAUDE.md', 'docs/CLAUDE.md', 'README.md'];

const TEXT_EXT = new Set(['.md', '.js', '.cjs', '.mjs', '.json', '.yaml', '.yml', '.html', '.txt']);
const LINE_KEEP_MARKER = 'migrate:keep';

// Boundary classes. A path token only matches when the char immediately before
// is NOT an identifier char (so `_project-brief.md` matches in `docs/_project-brief.md`
// but not in `my_project-brief.md`), and — for tokens that don't self-terminate
// with `/` — the char immediately after is likewise not an identifier char (so
// bare `_project-design` won't clobber inside `_project-designs`).
const IDENT_RE = /[A-Za-z0-9_-]/;

function isPathSkipped(relPath) {
    const norm = relPath.replace(/\\/g, '/');
    return SKIP_PATH_RES.some((re) => re.test(norm));
}

/**
 * True if `oldTok` matches `line` starting at `i` with valid path boundaries.
 * Leading: the char before the match must not be an identifier char (so
 * `_project-brief.md` matches in `docs/_project-brief.md` but not `my_project-brief.md`).
 * Trailing: tokens ending in `/` self-terminate; others need a non-identifier
 * char after (so bare `_project-design` won't clobber inside `_project-designs`).
 */
function matchesAt(line, i, oldTok) {
    if (!line.startsWith(oldTok, i)) return false;
    const before = i === 0 ? '' : line[i - 1];
    const afterPos = i + oldTok.length;
    const after = afterPos >= line.length ? '' : line[afterPos];
    const leadingOk = before === '' || !IDENT_RE.test(before);
    const trailingOk = oldTok.endsWith('/') || after === '' || !IDENT_RE.test(after);
    return leadingOk && trailingOk;
}

/**
 * Rewrite all REF_REWRITES occurrences in one line of text via a SINGLE
 * left-to-right scan. At each position the longest matching token wins; on a
 * match we emit the replacement and jump past the matched SOURCE, never
 * re-examining emitted output — so an inserted segment (e.g. the new `work/`)
 * can't be re-matched by a shorter rule. This makes the pass collision-safe and
 * inherently idempotent. Lines bearing the keep-marker pass through verbatim.
 */
function rewriteLine(line) {
    if (line.includes(LINE_KEEP_MARKER)) return { text: line, changed: false };
    let out = '';
    let i = 0;
    let changed = false;
    while (i < line.length) {
        let matched = null;
        for (const [oldTok, newTok] of REF_REWRITES) {   // REF_REWRITES is longest-first
            if (matchesAt(line, i, oldTok)) { matched = [oldTok, newTok]; break; }
        }
        if (matched) {
            out += matched[1];
            i += matched[0].length;
            changed = true;
        } else {
            out += line[i];
            i++;
        }
    }
    return { text: out, changed };
}

/**
 * Find legacy-token survivors in a line (for --verify) via the same single-pass
 * longest-first scan, so each position yields at most one (the longest) hit —
 * no double-counting an `.md` token and the bare token nested inside it.
 * Returns [{token, col}].
 */
function findSurvivors(line) {
    if (line.includes(LINE_KEEP_MARKER)) return [];
    const hits = [];
    let i = 0;
    while (i < line.length) {
        let matched = null;
        for (const [oldTok] of REF_REWRITES) {
            if (matchesAt(line, i, oldTok)) { matched = oldTok; break; }
        }
        if (matched) { hits.push({ token: matched, col: i + 1 }); i += matched.length; }
        else { i++; }
    }
    return hits;
}

/** Recursively collect text-file paths under a root, honoring the skip-allowlist. */
function collectFiles(absRoot, projectRoot, acc) {
    let stat;
    try { stat = fs.statSync(absRoot); } catch { return acc; }
    const rel = path.relative(projectRoot, absRoot);
    if (rel && isPathSkipped(rel)) return acc;
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(absRoot)) {
            collectFiles(path.join(absRoot, entry), projectRoot, acc);
        }
    } else if (stat.isFile()) {
        if (TEXT_EXT.has(path.extname(absRoot))) acc.push(absRoot);
    }
    return acc;
}

function resolveFileset(projectRoot, explicitPaths) {
    if (explicitPaths && explicitPaths.length) {
        const acc = [];
        for (const p of explicitPaths) collectFiles(path.resolve(projectRoot, p), projectRoot, acc);
        return acc;
    }
    const acc = [];
    for (const r of TEMPLATE_FILESET) collectFiles(path.join(projectRoot, r), projectRoot, acc);
    for (const f of TEMPLATE_FILES) {
        const abs = path.join(projectRoot, f);
        if (fs.existsSync(abs)) collectFiles(abs, projectRoot, acc);
    }
    return acc;
}

// ── --refs ──────────────────────────────────────────────────────────────────
/**
 * Rewrite references across a fileset.
 * @returns {{ changedFiles: Array<{file, hunks: Array<{line, before, after}>}>, scanned: number }}
 */
function runRefs(projectRoot, { apply = false, paths = null } = {}) {
    const files = resolveFileset(projectRoot, paths);
    const changedFiles = [];
    for (const abs of files) {
        const rel = path.relative(projectRoot, abs);
        if (isPathSkipped(rel)) continue;
        let content;
        try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        const hunks = [];
        let fileChanged = false;
        const outLines = lines.map((line, i) => {
            const { text, changed } = rewriteLine(line);
            if (changed) {
                fileChanged = true;
                hunks.push({ line: i + 1, before: line, after: text });
            }
            return text;
        });
        if (fileChanged) {
            changedFiles.push({ file: rel, hunks });
            if (apply) fs.writeFileSync(abs, outLines.join('\n'));
        }
    }
    return { changedFiles, scanned: files.length };
}

// ── --verify ──────────────────────────────────────────────────────────────────
/** @returns {{ violations: Array<{file, line, token, col}>, scanned: number }} */
function runVerify(projectRoot, { paths = null } = {}) {
    const files = resolveFileset(projectRoot, paths);
    const violations = [];
    for (const abs of files) {
        const rel = path.relative(projectRoot, abs);
        if (isPathSkipped(rel)) continue;
        let content;
        try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        content.split('\n').forEach((line, i) => {
            for (const h of findSurvivors(line)) {
                violations.push({ file: rel, line: i + 1, token: h.token, col: h.col });
            }
        });
    }
    return { violations, scanned: files.length };
}

// ── --move ──────────────────────────────────────────────────────────────────
function isGitTracked(docsRoot) {
    try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: docsRoot, stdio: 'ignore', windowsHide: true });
        return true;
    } catch { return false; }
}

function moveOne(fromAbs, toAbs, gitCwd, apply, results) {
    if (!fs.existsSync(fromAbs)) { results.skipped.push({ from: fromAbs, reason: 'absent' }); return; }
    results.moves.push({ from: fromAbs, to: toAbs });
    if (!apply) return;
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    if (gitCwd) {
        // Run git mv FROM INSIDE the repo so the rename is staged against the
        // right work tree (history-preserving). Fall back to a plain rename only
        // if git refuses (e.g. the file isn't tracked).
        try { execFileSync('git', ['mv', fromAbs, toAbs], { cwd: gitCwd, stdio: 'ignore', windowsHide: true }); return; }
        catch { /* fall through to plain rename */ }
    }
    fs.renameSync(fromAbs, toAbs);
}

/**
 * Migrate the ADR corpus: docs/.output/reviews/<date>-adr-*.md →
 * docs/architecture/decisions/NNNN-<slug>.md, numbered chronologically by the
 * date prefix (deterministic sort). Slug = the filename minus the date prefix
 * and the `adr-` tag.
 * @returns {Array<{from, to}>}
 */
function migrateAdrCorpus(docsRoot, gitCwd, apply, results) {
    const reviewsDir = path.join(docsRoot, '.output', 'reviews');
    const decisionsDir = path.join(docsRoot, 'architecture', 'decisions');
    let entries = [];
    try {
        entries = fs.readdirSync(reviewsDir)
            .filter((f) => /^\d{4}-\d{2}-\d{2}-adr-.*\.md$/.test(f))
            .sort();   // ISO date prefix → chronological
    } catch { return []; }
    const planned = [];
    entries.forEach((f, i) => {
        const num = String(i + 1).padStart(4, '0');
        const slug = f.replace(/^\d{4}-\d{2}-\d{2}-adr-/, '').replace(/\.md$/, '');
        const fromAbs = path.join(reviewsDir, f);
        const toAbs = path.join(decisionsDir, `${num}-${slug}.md`);
        planned.push({ from: path.relative(docsRoot, fromAbs), to: path.relative(docsRoot, toAbs) });
        moveOne(fromAbs, toAbs, gitCwd, apply, results);
    });
    return planned;
}

/** @returns {{ moves, skipped, adr }} */
function runMove(docsRoot, { apply = false } = {}) {
    const absDocs = path.resolve(docsRoot);
    const gitCwd = isGitTracked(absDocs) ? absDocs : null;
    const results = { moves: [], skipped: [], adr: [] };
    for (const [from, to] of FILE_MOVES) {
        moveOne(path.join(absDocs, from), path.join(absDocs, to), gitCwd, apply, results);
    }
    results.adr = migrateAdrCorpus(absDocs, gitCwd, apply, results);
    return results;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function getRoot(argv) {
    const i = argv.indexOf('--root');
    if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
    return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
}

function positional(argv) {
    // everything that isn't a flag or a flag-value
    const out = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--root') { i++; continue; }
        if (a.startsWith('--')) continue;
        out.push(a);
    }
    return out;
}

function main() {
    const argv = process.argv.slice(2);
    const apply = argv.includes('--apply');

    if (argv.includes('--move')) {
        const docsRoot = argv[argv.indexOf('--move') + 1];
        if (!docsRoot || docsRoot.startsWith('--')) {
            process.stderr.write('usage: migrate-docs-domains.js --move <docsRoot> [--apply]\n');
            process.exit(2);
        }
        const r = runMove(docsRoot, { apply });
        const verb = apply ? 'MOVED' : 'DRY-RUN (no changes)';
        process.stdout.write(`docs migration — ${verb}\n\n`);
        for (const m of r.moves) process.stdout.write(`  mv  ${path.relative(process.cwd(), m.from)}  →  ${path.relative(process.cwd(), m.to)}\n`);
        if (r.adr.length) {
            process.stdout.write(`\n  ADR corpus → architecture/decisions/ (${r.adr.length}):\n`);
            for (const a of r.adr) process.stdout.write(`    ${a.from}  →  ${a.to}\n`);
        }
        if (r.skipped.length) process.stdout.write(`\n  skipped (absent): ${r.skipped.length}\n`);
        process.stdout.write(`\n${r.moves.length} move(s)${apply ? ' applied' : ' planned'}.\n`);
        process.exit(0);
    }

    if (argv.includes('--verify')) {
        const root = getRoot(argv);
        const paths = positional(argv);
        const { violations, scanned } = runVerify(root, { paths: paths.length ? paths : null });
        if (violations.length === 0) {
            process.stdout.write(`--verify: clean — 0 legacy tokens across ${scanned} files.\n`);
            process.exit(0);
        }
        process.stdout.write(`--verify: ${violations.length} surviving legacy token(s):\n\n`);
        for (const v of violations) process.stdout.write(`  ${v.file}:${v.line}:${v.col}  ${v.token}\n`);
        process.exit(1);
    }

    if (argv.includes('--refs')) {
        const root = getRoot(argv);
        const paths = positional(argv);
        const { changedFiles, scanned } = runRefs(root, { apply, paths: paths.length ? paths : null });
        const verb = apply ? 'APPLIED' : 'DRY-RUN (no writes)';
        process.stdout.write(`--refs ${verb} — ${changedFiles.length}/${scanned} files would change\n\n`);
        for (const f of changedFiles) {
            process.stdout.write(`── ${f.file} (${f.hunks.length})\n`);
            for (const h of f.hunks) {
                process.stdout.write(`  ${h.line}- ${h.before.trim()}\n`);
                process.stdout.write(`  ${h.line}+ ${h.after.trim()}\n`);
            }
        }
        process.exit(0);
    }

    process.stderr.write('usage: migrate-docs-domains.js [--refs|--move <docsRoot>|--verify] [--apply] [--root <dir>] [paths…]\n');
    process.exit(2);
}

if (require.main === module) main();

module.exports = {
    FILE_MOVES,
    REF_REWRITES,
    rewriteLine,
    findSurvivors,
    isPathSkipped,
    runRefs,
    runVerify,
    runMove,
    migrateAdrCorpus,
    collectFiles,
    resolveFileset,
};
