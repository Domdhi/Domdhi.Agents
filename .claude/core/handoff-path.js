#!/usr/bin/env node

/**
 * handoff-path.js — resolve the path of the session handoff file.
 *
 * WHY THIS EXISTS
 * ---------------
 * The session handoff used to be a single fixed path (`docs/__handoff.md`) that
 * every session OVERWROTE. With multiple agents working in parallel branches,
 * that one path is rewritten by every `/end`, `/do`, `/run-todo` wave,
 * `/run-tests`, and `/todo` — so it conflicts on every PR merge.
 *
 * The fix: handoffs are per-session, stamped, and branch-tagged, living under
 * `docs/.output/handoffs/{YYYY-MM}/{stamp}-{caller}-{branch}.md` (month-bucketed,
 * ADR 0006; readers also accept legacy flat files). Every run writes a
 * uniquely-named file, so parallel branches never touch the same path → zero
 * merge conflicts. The files are TRACKED (the .output gitignore block excludes
 * memories/telemetry/sessions, NOT handoffs/), so they stay portable across
 * machines — `git pull` brings your handoffs with you.
 *
 * Eight call sites need the SAME stamp/branch/resolution logic (6 writer
 * commands + /prime + pre-compaction-archive.cjs). This is that single source.
 *
 * USAGE (CLI)
 *   node .claude/core/handoff-path.js write <caller>
 *       Ensure the handoffs/ dir exists and print the path THIS run should
 *       write. Capture it ONCE per command run and reuse the same string for
 *       both the Write and the `git add` (per the Run-Stamp Convention — one
 *       stamp per run, so /run-todo's waves overwrite one file, not N).
 *
 *   node .claude/core/handoff-path.js latest
 *       Print the newest handoff for the CURRENT branch (falls back to the
 *       newest across all branches if this branch has none — e.g. a freshly
 *       cut branch inherits the last main handoff). Empty output = none found.
 *       Used by /prime (cold-start read) and the pre-compaction hook.
 *
 *   node .claude/core/handoff-path.js branch
 *       Print the slugified current branch (debugging / scripting).
 *
 * Exit codes: 0 ok, 2 bad usage. Resolution never throws on a missing dir —
 * it prints empty and exits 0 (the caller falls back to scanning the backlog).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { stamp } = require('./_lib/run-stamp');

const HANDOFF_DIR = 'docs/.output/handoffs';
const CALLERS = ['end', 'do', 'run-todo', 'run-tests', 'todo'];
// Longest alternatives first so `run-todo`/`run-tests` match before `do`/`todo`.
const FILE_RE = /^(\d{6}-\d{4})-(run-todo|run-tests|end|do|todo)-(.+)\.md$/;

/** Slugify a branch name into a filename-safe, lowercase token. */
function slugBranch(raw) {
    return String(raw || '')
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-') // path-separators & spaces → dash
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'nobranch';
}

/** Current git branch, slugified. Detached HEAD → 'head'. */
function currentBranchSlug(cwd = process.cwd()) {
    try {
        const raw = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return slugBranch(raw);
    } catch {
        return 'nobranch';
    }
}

// stamp() is the universal Run-Stamp Convention helper, now single-sourced in
// _lib/run-stamp.js and shared with output-paths.js. Re-exported below so existing
// `require('./handoff-path').stamp` callers keep working.

/** Month-bucket folder (YYYY-MM) derived from a YYMMDD-HHMM stamp string. */
function monthFromStamp(s) {
    const m = /^(\d{2})(\d{2})\d{2}-\d{4}$/.exec(s);
    return m ? `20${m[1]}-${m[2]}` : null;
}

/**
 * Build the path this run should write — month-bucketed (ADR 0006):
 * docs/.output/handoffs/{YYYY-MM}/{stamp}-{caller}-{branch}.md
 */
function buildWritePath(caller, { cwd = process.cwd(), runStamp, branch } = {}) {
    if (!CALLERS.includes(caller)) {
        throw new Error(`unknown caller "${caller}" — expected one of: ${CALLERS.join(', ')}`);
    }
    const s = runStamp || stamp();
    const b = branch || currentBranchSlug(cwd);
    const month = monthFromStamp(s) || 'undated';
    return `${HANDOFF_DIR}/${month}/${s}-${caller}-${b}.md`;
}

/** Ensure docs/.output/handoffs/ (and, if given, a stamp's month folder) exists. */
function ensureDir(cwd = process.cwd(), runStamp) {
    const month = runStamp ? monthFromStamp(runStamp) : null;
    const dir = month ? path.join(cwd, HANDOFF_DIR, month) : path.join(cwd, HANDOFF_DIR);
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * Newest handoff for `branch` (default: current). Falls back to the newest
 * across ALL branches when the branch has none. Returns a repo-relative path
 * string, or null if the dir is empty/absent.
 *
 * `any: true` skips the branch preference entirely and returns the newest
 * handoff across all branches. Callers like /prime compare the two: when the
 * branch-preferred pick is NOT the global newest, a more recent session ended
 * on another branch (a just-merged feature, a parallel worktree) and its
 * handoff is usually the context the user actually wants surfaced too. The
 * branch preference itself must stay the default — parallel /run-todo
 * worktrees rely on it to not leak sibling branches' handoffs.
 */
function resolveLatest({ cwd = process.cwd(), branch, any = false } = {}) {
    const root = path.join(cwd, HANDOFF_DIR);
    const parsed = [];

    // Collect parseable handoffs from a directory, tagging each with its repo-
    // relative path (sub = '' for legacy flat files, or the YYYY-MM month folder).
    const collect = (absDir, sub) => {
        let entries;
        try {
            entries = fs.readdirSync(absDir);
        } catch {
            return;
        }
        for (const name of entries) {
            const m = FILE_RE.exec(name);
            if (m) parsed.push({ name, sub, stampStr: m[1], caller: m[2], branch: m[3] });
        }
    };

    // Legacy flat files (pre-migration) live directly under handoffs/; new files
    // live under handoffs/{YYYY-MM}/. Scan both so the resolver tolerates a mixed
    // tree during/after migration. The filename stamp sorts both eras together.
    collect(root, '');
    let monthDirs;
    try {
        monthDirs = fs.readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
            .map((d) => d.name);
    } catch {
        monthDirs = [];
    }
    for (const m of monthDirs) collect(path.join(root, m), m);

    if (parsed.length === 0) return null;

    // Sort by stamp prefix (chronological), then pick newest for the branch.
    parsed.sort((a, b) => (a.stampStr < b.stampStr ? -1 : a.stampStr > b.stampStr ? 1 : 0));
    const b = branch || currentBranchSlug(cwd);
    const mine = any ? [] : parsed.filter((e) => e.branch === b);
    const pool = mine.length ? mine : parsed;
    const pick = pool[pool.length - 1];
    return pick.sub ? `${HANDOFF_DIR}/${pick.sub}/${pick.name}` : `${HANDOFF_DIR}/${pick.name}`;
}

module.exports = {
    HANDOFF_DIR,
    CALLERS,
    slugBranch,
    currentBranchSlug,
    stamp,
    monthFromStamp,
    buildWritePath,
    resolveLatest,
    ensureDir,
};

// ---- CLI ----
if (require.main === module) {
    const [cmd, arg] = process.argv.slice(2);
    try {
        if (cmd === 'write') {
            if (!CALLERS.includes(arg)) {
                process.stderr.write(`usage: handoff-path.js write <${CALLERS.join('|')}>\n`);
                process.exit(2);
            }
            // One stamp for both the mkdir and the path, so the month folder can't
            // disagree with the filename stamp at a minute/month boundary.
            const s = stamp();
            ensureDir(process.cwd(), s);
            process.stdout.write(buildWritePath(arg, { runStamp: s }) + '\n');
        } else if (cmd === 'latest') {
            // `latest` = newest for the current branch (worktree-safe default);
            // `latest --any` = newest across ALL branches (cross-branch recall).
            const p = resolveLatest({ any: arg === '--any' });
            if (p) process.stdout.write(p + '\n');
            // empty output + exit 0 when none — caller falls back to backlog
        } else if (cmd === 'branch') {
            process.stdout.write(currentBranchSlug() + '\n');
        } else {
            process.stderr.write('usage: handoff-path.js <write <caller>|latest [--any]|branch>\n');
            process.exit(2);
        }
    } catch (err) {
        process.stderr.write(`handoff-path.js: ${err.message}\n`);
        process.exit(2);
    }
}
