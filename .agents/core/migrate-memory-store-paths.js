#!/usr/bin/env node
'use strict';

/**
 * migrate-memory-store-paths.js — one-shot, idempotent codemod for ADR 0006
 * Amendment 2 (the memory store split). Rewrites every literal reference to the
 * old colocated store `docs/.output/memories/...` onto the split layout:
 *
 *   docs/.output/memories/<category>      → docs/.output/.memory/<category>      (TRACKED source)
 *   docs/.output/memories/memories.db     → docs/.output/.state/memory-index/memories.db
 *   docs/.output/memories/daily           → docs/.output/.state/memory-daily
 *   docs/.output/memories/_inbox          → docs/.output/.state/memory-inbox
 *   docs/.output/memories/concepts        → docs/.output/.state/memory-concepts
 *   docs/.output/memories/pending-curation→ docs/.output/.state/memory-pending-curation
 *   docs/.output/memories/extracted       → docs/.output/.state/memory-extracted
 *   docs/.output/memories  (bare/catch-all)→ docs/.output/.memory
 *
 * Handles BOTH the string form (`'docs/.output/memories/daily'`, comments) and the
 * path.join array form (`'docs', '.output', 'memories', 'daily'`). Specific-suffix
 * rules run BEFORE the bare catch-all, so each literal is rewritten exactly once;
 * the result no longer contains `.output/memories`, making the pass idempotent.
 *
 * SCAN SAFETY: the walker never descends into vendored/VCS dirs, test trees,
 * archived history (`.archive/`/`_archive/`), `worktrees/`, or ANY directory holding
 * a `.git` entry (a linked worktree / submodule / nested clone — a foreign checkout,
 * not ours to rewrite). Without this an adopter run would corrupt archived records and
 * a separate worktree's tree.
 *
 * CODE SCOPE: .js/.cjs under .claude/core/ + .claude/hooks/. EXCLUDED (hand-edited —
 * a literal rewrite would be semantically wrong there):
 *   - memory-guard.cjs       — detects the store via a bare `'memories'` token (logic, not a path literal)
 *   - template-updater.js    — a v4.63 HISTORY comment naming the old path must stay accurate
 *   - decision-graph.js, memory-promoter.js, memory-backup.js, feedback-digest.js
 *                            — derive subdirs via path.join(<base>, 'daily'|'concepts'|'memories.db'),
 *                              so they route through the _lib/memory-paths.js accessor instead
 *   - this script + _lib/memory-paths.js (the accessor — already correct)
 *
 * PROSE SCOPE: .md under .claude/ + docs/ + root CLAUDE.md/README.md (the same
 * RULES — every sub-path mapping is identical for prose). EXCLUDED as
 * historical/append-only records where the old path is correct-in-context and a
 * rewrite would falsify history:
 *   - docs/architecture/decisions/   — ADRs (append-only)
 *   - docs/work/scratch/             — dated research/working files
 *   - docs/.output/                  — generated: handoffs, plans, the .memory JSON store, daily logs
 *   - docs/work/todo/TODO_wave-1b-memory-split.md — the migration's own plan (describes the before-state)
 *   - CHANGELOG.md                   — release history
 * NOTE: the ~4 doctrine claims ("local-only / gitignored" → "tracked source, syncs
 * over git") are NOT path literals, so this codemod can't fix them — they are
 * hand-edited separately (CLAUDE.md F5/F9, onboard.md, evolve.md).
 *
 * USAGE:  node migrate-memory-store-paths.js            # dry-run (default) — prints the diff summary
 *         node migrate-memory-store-paths.js --apply    # write the changes
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['.claude/core', '.claude/hooks'];
const EXCLUDE_BASENAMES = new Set([
    'migrate-memory-store-paths.js',
    'memory-paths.js',
    'memory-guard.cjs',
    'template-updater.js',
    'decision-graph.js',
    'memory-promoter.js',
    'memory-backup.js',
    'feedback-digest.js',
]);

// ── Prose (.md) pass ──────────────────────────────────────────────────────
const MD_SCAN_DIRS = ['.claude', 'docs'];
const MD_ROOT_FILES = ['CLAUDE.md', 'README.md'];
// Path prefixes (POSIX, relative to ROOT) whose .md are historical/append-only.
const MD_SKIP_PREFIXES = [
    'docs/architecture/decisions/',
    'docs/work/scratch/',
    'docs/.output/',
    'docs/work/todo/TODO_wave-1b-memory-split.md',
    'docs/work/timeline.md',
];
const MD_SKIP_BASENAMES = new Set(['CHANGELOG.md']);

function isSkippedMd(relPosix, base) {
    if (MD_SKIP_BASENAMES.has(base)) return true;
    return MD_SKIP_PREFIXES.some((p) => relPosix === p || relPosix.startsWith(p));
}

// Ordered rules — specific suffixes first, bare catch-all last, in BOTH forms.
// `\s*` tolerates whatever spacing a path.join array used.
const RULES = [
    // ── path.join array form ──────────────────────────────────────────────
    [/'\.output',\s*'memories',\s*'concepts'/g, "'.output', '.state', 'memory-concepts'"],
    [/'\.output',\s*'memories',\s*'daily'/g, "'.output', '.state', 'memory-daily'"],
    [/'\.output',\s*'memories',\s*'pending-curation'/g, "'.output', '.state', 'memory-pending-curation'"],
    [/'\.output',\s*'memories',\s*'extracted'/g, "'.output', '.state', 'memory-extracted'"],
    [/'\.output',\s*'memories',\s*'_inbox'/g, "'.output', '.state', 'memory-inbox'"],
    [/'\.output',\s*'memories'/g, "'.output', '.memory'"],
    // ── string form ───────────────────────────────────────────────────────
    [/docs\/\.output\/memories\/memories\.db/g, 'docs/.output/.state/memory-index/memories.db'],
    [/docs\/\.output\/memories\/daily/g, 'docs/.output/.state/memory-daily'],
    [/docs\/\.output\/memories\/concepts/g, 'docs/.output/.state/memory-concepts'],
    [/docs\/\.output\/memories\/pending-curation/g, 'docs/.output/.state/memory-pending-curation'],
    [/docs\/\.output\/memories\/extracted/g, 'docs/.output/.state/memory-extracted'],
    [/docs\/\.output\/memories\/_inbox/g, 'docs/.output/.state/memory-inbox'],
    // Bare catch-all — `(?![\w-])` blocks over-matching a longer token
    // (e.g. `docs/.output/memories-backup`) while still allowing the `/` separator.
    [/docs\/\.output\/memories(?![\w-])/g, 'docs/.output/.memory'],
];

// Dir names never descended into: vendored/VCS, test trees (fixtures hold
// intentional old-path strings as regression assertions — rewriting breaks them),
// archived history (a rewrite would falsify the record), and `worktrees/` (the
// conventional home for linked git worktrees — a separate checkout, not ours to touch).
const SKIP_DIR_NAMES = new Set([
    'node_modules', '.git', '__tests__', '_helpers', '.archive', '_archive', 'worktrees',
]);

// A directory holding a `.git` entry is a FOREIGN checkout — a linked worktree (.git
// file), submodule, or nested clone — regardless of where it sits. Never rewrite inside
// it. Belt-and-braces with SKIP_DIR_NAMES so a worktree placed outside `worktrees/` is
// still skipped.
function isNestedCheckout(dir) {
    try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

// Generic walker — collects every file, skipping vendored/VCS/archive/worktree dirs.
function walk(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (SKIP_DIR_NAMES.has(ent.name)) continue;
            if (isNestedCheckout(full)) continue;
            walk(full, out);
        } else {
            out.push(full);
        }
    }
    return out;
}

// The set of files to rewrite: .js/.cjs in the code dirs + .md across the prose dirs.
function collectFiles() {
    const files = [];
    for (const d of SCAN_DIRS) {
        const abs = path.join(ROOT, d);
        if (!fs.existsSync(abs)) continue;
        for (const f of walk(abs)) {
            const base = path.basename(f);
            if (/\.(js|cjs)$/.test(base) && !EXCLUDE_BASENAMES.has(base)) files.push(f);
        }
    }
    for (const d of MD_SCAN_DIRS) {
        const abs = path.join(ROOT, d);
        if (!fs.existsSync(abs)) continue;
        for (const f of walk(abs)) {
            const base = path.basename(f);
            if (!base.endsWith('.md')) continue;
            const relPosix = path.relative(ROOT, f).split(path.sep).join('/');
            if (isSkippedMd(relPosix, base)) continue;
            files.push(f);
        }
    }
    for (const base of MD_ROOT_FILES) {
        const abs = path.join(ROOT, base);
        if (fs.existsSync(abs)) files.push(abs);
    }
    return files;
}

function transform(text) {
    let out = text;
    let hits = 0;
    for (const [re, rep] of RULES) {
        out = out.replace(re, (m) => { hits++; return rep; });
    }
    return { out, hits };
}

function main() {
    const apply = process.argv.includes('--apply');
    const files = collectFiles();

    let changedFiles = 0;
    let totalHits = 0;
    const report = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        const { out, hits } = transform(text);
        if (hits === 0 || out === text) continue;
        changedFiles++;
        totalHits += hits;
        report.push(`  ${path.relative(ROOT, file)}  (${hits} replacement${hits === 1 ? '' : 's'})`);
        if (apply) fs.writeFileSync(file, out);
    }

    const mode = apply ? 'APPLIED' : 'DRY-RUN (no files written — pass --apply to write)';
    console.log(`\nmigrate-memory-store-paths.js — ${mode}`);
    console.log(`Files changed: ${changedFiles}   Total replacements: ${totalHits}\n`);
    console.log(report.join('\n') || '  (nothing to change — already migrated)');
    console.log('');
}

if (require.main === module) main();

// Exported for unit tests (the pure transforms + the prose/dir skip predicates).
module.exports = { transform, isSkippedMd, walk, isNestedCheckout, SKIP_DIR_NAMES, RULES };
