#!/usr/bin/env node

/**
 * Brownfield Installer — copies .claude/ from this template into an existing repo.
 *
 * Design goal: zero runtime dependencies, pure Node builtins + sibling utilities.
 * Works out of the box on Node 24+ (node:sqlite ships FTS5). On Node <24 we print
 * a one-line informational note about the optional better-sqlite3 fallback; we
 * never run npm install.
 *
 * Usage:
 *   node .claude/core/install.js [target-path] [flags]
 *
 * Flags:
 *   --dry-run         Compute stats and print plan; write nothing.
 *   --force           Alias for --overwrite-all.
 *   --overwrite-all   Overwrite every conflicting file without prompting.
 *   --keep            Keep every conflicting file without prompting.
 *   --no-deps         No-op / explicit form of the default: install.js never
 *                     runs npm install regardless. Documented alias only.
 *
 * Exit codes:
 *   0  — success (including headless keep-with-notes mode)
 *   1  — preflight error (target missing, not a directory)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Sibling utilities ─────────────────────────────────────────────────────────
//
// We load template-updater's glob helpers and copyFile rather than re-inventing
// them. import path is relative to this file's own __dirname (always correct even
// when run from an adopter project via the bin entry-point).

const { matchesAnyGlob, copyFile } = require('./template-updater');
const { safeWrite } = require('./_lib/fs-safe');

// ── Do-not-ship patterns (relative to .claude/) ───────────────────────────────
//
// Matches publish.js DEFAULT_EXCLUDES for the .claude/-scoped subset plus the
// node_modules/.git guards handled separately during the walk.

const DO_NOT_SHIP = [
    'agent-memory/**',
    'skills-optional/**',
    'agents-optional/**',
    'settings.local.json',
    'push-guardrail.json',
];

// ── parseArgs ─────────────────────────────────────────────────────────────────

/**
 * Parse raw argv array (after process.argv.slice(2)) into a structured options
 * object. All callers — including tests — use this to avoid duplicated logic.
 *
 * @param {string[]} argv
 * @returns {{ target: string, dryRun: boolean, overwriteAll: boolean, keepAll: boolean, force: boolean, noDeps: boolean }}
 */
function parseArgs(argv) {
    const flags = new Set(argv.filter(a => a.startsWith('--')));
    const positional = argv.filter(a => !a.startsWith('--'));

    return {
        target:       positional[0] || '.',
        dryRun:       flags.has('--dry-run'),
        overwriteAll: flags.has('--overwrite-all') || flags.has('--force'),
        keepAll:      flags.has('--keep'),
        force:        flags.has('--force'),
        noDeps:       flags.has('--no-deps'), // documented no-op — install never runs npm
    };
}

// ── resolveConflict ───────────────────────────────────────────────────────────

/**
 * Decide whether to keep or overwrite an already-existing file.
 *
 * Precedence (high → low):
 *   1. force / overwriteAll → 'overwrite'
 *   2. keepAll              → 'keep'
 *   3. interactive + TTY    → call choiceFn(relPath); on 'diff', call again
 *   4. headless (default)   → 'keep'
 *
 * @param {string} relPath   — path relative to the .claude/ directory
 * @param {{
 *   overwriteAll?: boolean,
 *   keepAll?:      boolean,
 *   force?:        boolean,
 *   interactive?:  boolean,
 *   choiceFn?:     (relPath: string) => 'keep'|'overwrite'|'diff',
 * }} opts
 * @returns {'keep'|'overwrite'}
 */
function resolveConflict(relPath, opts) {
    opts = opts || {};

    if (opts.force || opts.overwriteAll) return 'overwrite';
    if (opts.keepAll)                    return 'keep';

    if (opts.interactive && typeof opts.choiceFn === 'function') {
        let choice = opts.choiceFn(relPath);
        // 'diff' means: show diff then re-ask. The caller's choiceFn is
        // expected to handle the diff internally and return a final answer.
        // For robustness in test mocks that return 'diff' once, loop once more.
        if (choice === 'diff') {
            choice = opts.choiceFn(relPath);
        }
        return choice === 'overwrite' ? 'overwrite' : 'keep';
    }

    // Headless default: keep existing, record the conflict.
    return 'keep';
}

// ── walkClaudeDir ─────────────────────────────────────────────────────────────

/**
 * Recursively enumerate all files under `sourceClaudeDir`, yielding their
 * paths relative to that directory (always forward-slash separated).
 *
 * Skips:
 *   - the `node_modules` directory
 *   - the `.git` directory
 *
 * @param {string} sourceClaudeDir — absolute path to the source .claude/
 * @param {string} [base]          — internal accumulator, do not pass
 * @yields {string} relative path (e.g. 'core/install.js')
 */
function* walkClaudeDir(sourceClaudeDir, base) {
    base = base || '';
    const entries = fs.readdirSync(path.join(sourceClaudeDir, base) || sourceClaudeDir,
        { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            yield* walkClaudeDir(sourceClaudeDir, base ? `${base}/${entry.name}` : entry.name);
        } else if (entry.isFile()) {
            yield base ? `${base}/${entry.name}` : entry.name;
        }
    }
}

// ── writeMergeNotes ───────────────────────────────────────────────────────────

/**
 * Append a list of conflict paths to <targetClaudeDir>/MERGE-NOTES.md.
 * Creates the file (with a header) if absent. Appends to an existing file
 * so repeated installs accumulate history rather than overwriting it.
 *
 * @param {string}   targetClaudeDir — absolute path to target .claude/
 * @param {string[]} conflicts       — relative paths (relative to .claude/)
 * @param {string}   [containRoot]   — project root; enables the symlinked-ancestor guard
 */
function writeMergeNotes(targetClaudeDir, conflicts, containRoot) {
    const notesPath = path.join(targetClaudeDir, 'MERGE-NOTES.md');
    const timestamp = new Date().toISOString();

    // Preserve prior history ONLY from a genuine regular file. A symlinked
    // MERGE-NOTES.md leaf must never be followed to its target — the old
    // `fs.appendFileSync` followed the link and appended INTO an external victim
    // (the same symlink-containment class this wave closes elsewhere). We read
    // via lstat+isFile (never through a link), and the write goes through
    // safeWrite, whose unlinkIfSymlink drops a leaf symlink and O_NOFOLLOW blocks
    // a race-recreated one — so a symlinked notes file is replaced by a fresh
    // real file, never written through.
    let prior = '';
    try {
        if (fs.lstatSync(notesPath).isFile()) prior = fs.readFileSync(notesPath, 'utf8');
    } catch { /* absent — no prior history */ }

    const header = prior
        ? ''
        : '# .claude/ Merge Notes\n\n' +
          'Files that were kept from your existing installation because they ' +
          'conflicted with the incoming template. Review each one and merge ' +
          'any Domdhi improvements manually, or re-run with `--overwrite-all` ' +
          'to replace them.\n\n';

    const section =
        `## Install run ${timestamp}\n\n` +
        conflicts.map(c => `- \`.claude/${c}\``).join('\n') +
        '\n\n';

    fs.mkdirSync(targetClaudeDir, { recursive: true });
    safeWrite(notesPath, prior + header + section, 'utf8', containRoot);
}

// ── runInstall ────────────────────────────────────────────────────────────────

/**
 * Main installer entry point. Pure enough to call headlessly from tests.
 *
 * @param {{
 *   source?:       string,   — absolute path to repo root (contains .claude/)
 *   target?:       string,   — absolute path to target project root
 *   dryRun?:       boolean,
 *   overwriteAll?: boolean,
 *   keepAll?:      boolean,
 *   force?:        boolean,
 *   noDeps?:       boolean,
 *   interactive?:  boolean,
 *   choiceFn?:     Function,
 * }} opts
 * @returns {{
 *   created:          number,
 *   skipped:          number,
 *   merged:           number,
 *   conflicts:        string[],
 *   dryRun:           boolean,
 *   recommendedReSync?: boolean,
 * }}
 */
function runInstall(opts) {
    opts = opts || {};

    // ── Resolve paths ──────────────────────────────────────────────────────────

    // SOURCE: the repo root that contains .claude/ (i.e. where install.js lives,
    // two levels up: .claude/core/install.js → ../../ = repo root).
    const source = opts.source
        ? path.resolve(opts.source)
        : path.resolve(__dirname, '..', '..');

    const target = opts.target
        ? path.resolve(opts.target)
        : path.resolve('.');

    const sourceClaudeDir = path.join(source, '.claude');
    const targetClaudeDir = path.join(target, '.claude');

    const dryRun      = Boolean(opts.dryRun);
    const overwriteAll = Boolean(opts.overwriteAll || opts.force);
    const keepAll     = Boolean(opts.keepAll);
    const interactive = Boolean(opts.interactive);
    const choiceFn    = opts.choiceFn;

    const stats = {
        ok:        true,
        created:   0,
        skipped:   0,
        merged:    0,
        conflicts: [],
        dryRun,
    };

    // ── Preflight ──────────────────────────────────────────────────────────────

    if (!fs.existsSync(target)) {
        console.error(`ERROR: target path does not exist: ${target}`);
        stats.ok = false;
        stats.error = `target path does not exist: ${target}`;
        return stats;
    }
    if (!fs.statSync(target).isDirectory()) {
        console.error(`ERROR: target path is not a directory: ${target}`);
        stats.ok = false;
        stats.error = `target path is not a directory: ${target}`;
        return stats;
    }

    const hasGit = fs.existsSync(path.join(target, '.git'));
    if (!hasGit) {
        console.warn(`WARN: target is not a git repository — run \`git init\` in ${target} first.`);
    }

    // Detect existing .claude/ → recommend template-updater for a proper re-sync.
    let recommendedReSync = false;
    if (fs.existsSync(targetClaudeDir)) {
        recommendedReSync = true;
        stats.recommendedReSync = true;
        console.log('NOTE: target already has a .claude/ directory.');
        console.log('      For a true re-sync (zone-aware, preserving customisations), use:');
        console.log(`        node .claude/core/template-updater.js update ${target}`);
        console.log('      Continuing in merge mode (conflicts will be kept by default).\n');
    }

    // ── Node version note ──────────────────────────────────────────────────────

    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor < 24) {
        console.log(
            `NOTE: Node ${process.versions.node} detected. ` +
            `Run \`npm install\` in .claude/core/ to enable the optional ` +
            `better-sqlite3 FTS5 fallback for memory search.`
        );
    }

    // ── Copy .claude/ files ────────────────────────────────────────────────────

    if (!fs.existsSync(sourceClaudeDir)) {
        console.error(`ERROR: source .claude/ not found at ${sourceClaudeDir}`);
        stats.ok = false;
        stats.error = `source .claude/ not found at ${sourceClaudeDir}`;
        return stats;
    }

    for (const relPath of walkClaudeDir(sourceClaudeDir)) {
        // Normalise to forward slashes for glob matching
        const rel = relPath.replace(/\\/g, '/');

        // Skip do-not-ship set
        if (matchesAnyGlob(rel, DO_NOT_SHIP)) {
            continue;
        }

        const srcAbs  = path.join(sourceClaudeDir, relPath);
        const destAbs = path.join(targetClaudeDir, relPath);

        if (!fs.existsSync(destAbs)) {
            // ── New file: create ───────────────────────────────────────────────
            if (!dryRun) {
                copyFile(srcAbs, destAbs, target);
            }
            console.log(`  CREATE   .claude/${rel}`);
            stats.created++;
        } else {
            // ── Conflict: existing file ────────────────────────────────────────
            const decision = resolveConflict(rel, {
                overwriteAll,
                keepAll,
                force: opts.force,
                interactive,
                choiceFn,
            });

            if (decision === 'overwrite') {
                if (!dryRun) {
                    copyFile(srcAbs, destAbs, target);
                }
                console.log(`  OVERWRITE .claude/${rel}`);
                stats.merged++;
            } else {
                // keep existing
                console.log(`  KEEP     .claude/${rel} (conflict — kept existing)`);
                stats.skipped++;
                stats.conflicts.push(rel);
            }
        }
    }

    // ── Write MERGE-NOTES if conflicts occurred (not dry-run) ─────────────────

    if (!dryRun && stats.conflicts.length > 0) {
        writeMergeNotes(targetClaudeDir, stats.conflicts, target);
        console.log(`\n  MERGE-NOTES written → .claude/MERGE-NOTES.md (${stats.conflicts.length} conflict(s))`);
    }

    // ── Delegate docs scaffold ─────────────────────────────────────────────────
    //
    // We require the TARGET's copy of scaffold.js (just installed), so adopters
    // benefit from any scaffold improvements that shipped with this install.

    if (!dryRun) {
        const targetScaffoldPath = path.join(targetClaudeDir, 'core', 'scaffold.js');
        if (fs.existsSync(targetScaffoldPath)) {
            try {
                const scaffold = require(targetScaffoldPath);
                // IMPORTANT: never forward install's --force into scaffold. They mean
                // different things — install --force overwrites conflicting *.claude/*
                // files; scaffold's force overwrites the adopter's *docs/ and repo-root*
                // files (including their root .gitignore). Conflating them would let
                // `install --force` silently clobber an adopter's .gitignore/docs. Always
                // run scaffold with its safe skip-if-exists default.
                scaffold.runScaffold(target, { force: false });
                console.log('\n  Docs scaffold complete.');
            } catch (err) {
                console.error(`\n  WARN: scaffold.js threw — ${err.message}`);
                console.error('  The .claude/ copy succeeded; run scaffold manually if needed:');
                console.error(`    node .claude/core/scaffold.js  (from within ${target})`);
                stats.scaffoldError = err.message;
            }
        } else {
            console.warn(
                '\n  WARN: scaffold.js not found in target after copy. ' +
                'Run `node .claude/core/scaffold.js` manually.'
            );
        }
    }

    // ── CLAUDE.md handling ─────────────────────────────────────────────────────
    //
    // If the target already has CLAUDE.md at its project root, leave it alone and
    // inform the user. If absent, write a minimal stub so /onboard can merge guidance.

    const targetClaudeMd = path.join(target, 'CLAUDE.md');
    if (fs.existsSync(targetClaudeMd)) {
        console.log('\n  NOTE: existing CLAUDE.md preserved — /onboard will offer to merge Domdhi guidance.');
    } else if (!dryRun) {
        const stub =
            '# CLAUDE.md\n\n' +
            'This project uses the Domdhi Agents template.\n' +
            'Run `/onboard` in Claude Code to complete project setup.\n';
        // safeWrite (not raw writeFileSync): a DANGLING `CLAUDE.md` symlink passes
        // the `fs.existsSync` check above (existsSync follows the link → the absent
        // target reads as false), and a raw write would then FOLLOW the link and
        // create the stub at the external target. unlinkIfSymlink drops the link
        // first; O_NOFOLLOW blocks a race. containRoot=target (dirname is target,
        // so the ancestor walk is a no-op, but the leaf guard is what matters here).
        safeWrite(targetClaudeMd, stub, 'utf8', target);
        console.log('\n  CREATE   CLAUDE.md (minimal stub — run /onboard to complete setup)');
        stats.created++;
    }

    // ── Report ─────────────────────────────────────────────────────────────────

    console.log('');
    console.log(`  Result: Created ${stats.created} / Skipped (kept) ${stats.skipped} / Overwritten ${stats.merged}`);
    if (dryRun) {
        console.log('  (dry-run — no files were written)');
    }
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Review the changes:  git diff --stat');
    console.log('    2. Stage and commit:    git add .claude/ CLAUDE.md && git commit -m "chore: install domdhi-agents template"');
    console.log('    3. Open Claude Code and run: /onboard');

    return stats;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('domdhi-install — brownfield installer for the Domdhi Agents template\n');
        console.log('Usage:');
        console.log('  node .claude/core/install.js [target] [flags]\n');
        console.log('Arguments:');
        console.log('  target           Path to the project to install into (default: .)');
        console.log('');
        console.log('Flags:');
        console.log('  --dry-run        Print what would happen; write nothing.');
        console.log('  --force          Overwrite all conflicting files.');
        console.log('  --overwrite-all  Same as --force.');
        console.log('  --keep           Keep all conflicting files without prompting.');
        console.log('  --no-deps        No-op. install.js never runs npm install by default.');
        process.exit(0);
    }

    const opts = parseArgs(argv);
    const targetAbs = path.resolve(opts.target);

    console.log(`Domdhi Agents Installer${opts.dryRun ? ' (DRY RUN)' : ''}`);
    console.log(`  Source : ${path.resolve(__dirname, '..', '..')}`);
    console.log(`  Target : ${targetAbs}`);
    console.log('');

    const interactive = Boolean(process.stdout.isTTY) && !opts.overwriteAll && !opts.keepAll;

    let choiceFn;
    if (interactive) {
        choiceFn = (relPath) => {
            // Synchronous prompt: write the question, then read a full LINE from
            // fd 0 (not a single byte — a one-byte read would leave the trailing
            // newline buffered and silently consume the NEXT conflict's prompt).
            process.stdout.write(
                `\n  CONFLICT .claude/${relPath}\n` +
                '  [k]eep existing / [o]verwrite ? '
            );
            try {
                const line = readLineSync();
                const answer = line.toLowerCase().trim();
                return answer === 'o' || answer === 'overwrite' ? 'overwrite' : 'keep';
            } catch (_) {
                return 'keep';
            }
        };
    }

    const stats = runInstall({
        source:       path.resolve(__dirname, '..', '..'),
        target:       targetAbs,
        dryRun:       opts.dryRun,
        overwriteAll: opts.overwriteAll,
        keepAll:      opts.keepAll,
        force:        opts.force,
        noDeps:       opts.noDeps,
        interactive,
        choiceFn,
    });

    process.exitCode = stats.ok === false ? 1 : 0;
}

// Read one line from stdin (fd 0) synchronously, byte by byte until newline or
// EOF. Returns the line without the trailing newline. Used only for the
// interactive TTY prompt; tests inject choiceFn and never reach this.
function readLineSync() {
    const bytes = [];
    const buf = Buffer.alloc(1);
    while (true) {
        let n;
        try { n = fs.readSync(0, buf, 0, 1, null); } catch { break; }
        if (n === 0) break;                 // EOF
        if (buf[0] === 0x0a) break;          // newline → end of line
        if (buf[0] !== 0x0d) bytes.push(buf[0]); // skip CR
    }
    return Buffer.from(bytes).toString('utf8');
}

if (require.main === module) { main(); }

module.exports = { runInstall, resolveConflict, writeMergeNotes, DO_NOT_SHIP, parseArgs };
