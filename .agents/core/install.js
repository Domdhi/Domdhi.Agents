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
 * The CLI runs preflightInstall (operation `install`, scope installScope(source))
 * before any target read that selects mutation; runInstall is the internal engine.
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
 *   1  — preflight refusal (request, assets, target path, config),
 *        generated projection conflict, scaffold failure or a failed write
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Sibling utilities ─────────────────────────────────────────────────────────
//
// We load template-updater's glob helpers and copyFile rather than re-inventing
// them. import path is relative to this file's own __dirname (always correct even
// when run from an adopter project via the bin entry-point).

const { matchesAnyGlob, copyFile, loadExcludedSkills, preflightFrontDoor, ROOT_DOC_REDIRECT } = require('./template-updater');
const { safeWrite, assertNoSymlinkedAncestor } = require('./_lib/fs-safe');
const { WORKSHOP_ONLY_SHARED } = require('./_lib/zone-classifier');
const { stripExcludedSkills } = require('./_lib/agent-merger');
const { renderSharedAgents, syncStartupInstructions, projectionPaths, canonicalFiles, commandFiles, workflowMap, isExcludedSkillPath, STATE_PATH } = require('./_lib/shared-agents');
const { applyManagedBlock, TEMPLATE_RENAMES } = require('./scaffold');
const { ignoredFilter } = require('./_lib/git-ignored');

// The install-complete marker. It is rendered (or, for a legacy source, copied)
// only after every earlier phase succeeded, so a present marker never describes
// a partial install.
const VERSION_MARKER = '.claude/version.json';

// Target roots every install touches regardless of source: the shared canonical
// tree and both native runtimes, the startup-instruction merge into AGENTS.md /
// CLAUDE.md (or the CLAUDE.md stub), and the docs/ scaffold.
const INSTALL_FIXED_SCOPE = ['.agents', '.claude', '.codex', 'AGENTS.md', 'CLAUDE.md', 'docs'];

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
    // Project-owned guardrail override: an adopter's own copy is never replaced.
    'guardrail-rules.project.yaml',
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

// ── installScope / preflightInstall ──────────────────────────────────────────

/**
 * Every target-relative root a direct install may read or write: the fixed set
 * plus each top-level entry of the source's and the target's existing
 * .claude/templates/root/ (which the docs scaffold copies to the project root),
 * mapped through scaffold's TEMPLATE_RENAMES (`gitignore` → `.gitignore`).
 * Sorted, de-duplicated.
 *
 * @param {string} source — toolkit root (contains .claude/)
 * @param {string} [target] — adopter root; its kept root templates are also copied
 * @returns {string[]}
 */
function installScope(source, target) {
    const scope = new Set(INSTALL_FIXED_SCOPE);
    // Scaffold copies the TARGET's installed .claude/templates/root/ (a kept,
    // pre-existing copy can carry extra entries), so its names are in scope too.
    // Check ancestors before reading either root-template tree.
    for (const base of [source, target]) {
        if (!base) continue;
        const rootTemplates = path.join(base, '.claude', 'templates', 'root');
        assertNoSymlinkedAncestor(rootTemplates, path.resolve(base));
        const stat = fs.lstatSync(rootTemplates, { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory()) continue;
        for (const name of fs.readdirSync(rootTemplates)) {
            scope.add(Object.hasOwn(TEMPLATE_RENAMES, name) ? TEMPLATE_RENAMES[name].dest : name);
        }
    }
    return [...scope].sort();
}

function sourceHas(source, rel, kind) {
    const stat = fs.statSync(path.join(source, rel), { throwIfNoEntry: false });
    return Boolean(stat && (kind === 'dir' ? stat.isDirectory() : stat.isFile()));
}

/**
 * Direct `install` preflight: request shape → required source assets → shared
 * contained target scope for operation `install` over installScope(source) →
 * strict target .claude/update-config.json. Read-only; never throws; a refusal
 * is `{ ok: false, exitCode: 1, errors: [{ code, message }], dryRun }`.
 *
 * @param {{ source: string, target: string, dryRun?: boolean }} request
 */
function preflightInstall(request) {
    return preflightFrontDoor(request, {
        operation: 'install',
        scope: installScope,
        assetsPresent: source => sourceHas(source, '.claude', 'dir')
            && sourceHas(source, '.claude/core/scaffold.js', 'file')
            && sourceHas(source, '.claude/templates', 'dir')
            && (sourceHas(source, '.agents/config/version.json', 'file') || sourceHas(source, '.claude/version.json', 'file')),
    });
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
 *   - the `.git`, `__tests__`, and `_helpers` directories (toolkit-only tests)
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
            if (['node_modules', '.git', '__tests__', '_helpers'].includes(entry.name)) continue;
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
          'any Domdhi.Agents improvements manually, or re-run with `--overwrite-all` ' +
          'to replace them.\n\n';

    const section =
        `## Install run ${timestamp}\n\n` +
        conflicts.map(c => `- \`${c.startsWith('.') ? c : '.claude/' + c}\``).join('\n') +
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
 *   ok:               boolean,  — false on projection conflict or scaffold failure
 *   error?:           string,
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

    // This release adds a helper at a formerly project-owned path. Refuse an
    // unowned collision before copy choices, including KEEP and overwrite-all:
    // continuing would either clobber the adopter or install an unusable helper.
    const hookHelper = '.agents/core/_lib/codex-hook-identities.js';
    const incomingHelper = path.join(source, hookHelper);
    const targetHelper = path.join(target, hookHelper);
    if (fs.existsSync(incomingHelper)) {
        assertNoSymlinkedAncestor(targetHelper, target);
        const existing = fs.lstatSync(targetHelper, { throwIfNoEntry: false });
        if (existing?.isSymbolicLink()) throw new Error(`install: refusing symlinked ${hookHelper}`);
        if (existing) {
            const ledgerPath = path.join(target, STATE_PATH);
            assertNoSymlinkedAncestor(ledgerPath, target);
            const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : {};
            if (!ledger[hookHelper] && !fs.readFileSync(targetHelper).equals(fs.readFileSync(incomingHelper))) {
                stats.ok = false;
                stats.conflicts.push(hookHelper);
                stats.error = `${hookHelper}: adopter-owned helper collision; install refused before any write`;
                console.error(`ERROR: ${stats.error}`);
                return stats;
            }
        }
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
        console.log('      For a true re-sync (zone-aware, preserving customizations), use:');
        console.log(`        node .claude/core/template-updater.js update "${target}"`);
        console.log('      Continuing in merge mode (conflicts will be kept by default).\n');
    }

    // ── Node version note ──────────────────────────────────────────────────────

    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor < 22) {
        console.log(
            `NOTE: Node ${process.versions.node} detected. ` +
            `Memory search uses the JSON fallback when SQLite is unavailable. ` +
            `Use Node 24+ for built-in FTS5 search; the optional better-sqlite3 13 driver requires Node 22+.`
        );
    } else if (nodeMajor < 24) {
        console.log(
            `NOTE: Node ${process.versions.node} detected. ` +
            `Node 24+ provides built-in FTS5 memory search. To install the optional fallback, run ` +
            `\`npm install --prefix .claude/core --no-save better-sqlite3@^13.0.3\`; ` +
            `otherwise memory search retains its available built-in SQLite or JSON fallback.`
        );
    }

    // ── Copy .claude/ files ────────────────────────────────────────────────────

    if (!fs.existsSync(sourceClaudeDir)) {
        console.error(`ERROR: source .claude/ not found at ${sourceClaudeDir}`);
        stats.ok = false;
        stats.error = `source .claude/ not found at ${sourceClaudeDir}`;
        return stats;
    }

    // Git-ignored source files are local state (for example the harness's
    // .claude/scheduled_tasks.lock); they never install. A failed query in a
    // real checkout throws here, before any target write.
    const isIgnored = ignoredFilter(source, { failureMessage: 'Install source ignored-file query failed; nothing was installed.' });
    const excludedSkills = loadExcludedSkills(targetClaudeDir);
    const workflows = workflowMap(source);
    const projections = projectionPaths(source);
    const pendingCopies = [];
    const files = new Map();
    // A legacy source ships the marker as an ordinary .claude/ file instead of a
    // projection; it is still held back and copied only after every phase succeeds.
    let markerCopy = null;
    // `content`, when given, is written instead of the source bytes (a role stripped of the skills
    // the project excludes, so the install already matches what the first update would produce).
    const planCopy = (src, dest, rel, content) => {
        assertNoSymlinkedAncestor(dest, target);
        if (rel === VERSION_MARKER) { markerCopy = [src, dest]; return; }
        pendingCopies.push([src, dest, content]);
        const text = content !== undefined ? content : (rel.endsWith('.md') ? fs.readFileSync(src, 'utf8') : null);
        files.set(rel, text !== null ? text.replace(/\r\n/g, '\n') : fs.readFileSync(src));
    };
    for (const relPath of walkClaudeDir(sourceClaudeDir)) {
        // Normalize to forward slashes for glob matching
        const rel = relPath.replace(/\\/g, '/');

        if (isExcludedSkillPath(`.claude/${rel}`, excludedSkills, workflows)) continue;
        if (isIgnored(`.claude/${rel}`)) continue;

        // Canonical pilot outputs are rendered at the installed destination.
        if (projections.has(`.claude/${rel}`)) continue;

        // Skip do-not-ship set
        if (matchesAnyGlob(rel, DO_NOT_SHIP)) {
            continue;
        }

        const srcAbs  = path.join(sourceClaudeDir, relPath);
        const destAbs = path.join(targetClaudeDir, relPath);

        if (!fs.existsSync(destAbs)) {
            // ── New file: create ───────────────────────────────────────────────
            planCopy(srcAbs, destAbs, `.claude/${rel}`);
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
                planCopy(srcAbs, destAbs, `.claude/${rel}`);
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

    // Install canonical skills/roles and the Codex native adapter via the same
    // conflict front door. Never ship the workshop's generated-state hashes.
    const sharedFiles = canonicalFiles(source);
    for (const runtime of ['codex']) {
        const rel = `.${runtime}/shared-agents.json`;
        if (fs.existsSync(path.join(source, rel))) sharedFiles.push(rel);
    }
    for (const rel of sharedFiles) {
        if (isExcludedSkillPath(rel, excludedSkills, workflows)) continue;
        // Workshop distribution authority never ships; the same shared
        // rule keeps the updater from delivering it and its projection is never rendered.
        if (WORKSHOP_ONLY_SHARED.has(rel)) continue;
        const srcAbs = path.join(source, rel);
        const destAbs = path.join(target, rel);
        // A role drops the skills the project excludes, as the updater's merge does.
        const stripped = excludedSkills.size > 0 && /^\.agents\/roles\/[^/]+\.md$/.test(rel)
            ? stripExcludedSkills(fs.readFileSync(srcAbs, 'utf8'), excludedSkills)
            : undefined;
        if (!fs.existsSync(destAbs)) {
            planCopy(srcAbs, destAbs, rel, stripped);
            stats.created++;
            console.log(`  CREATE   ${rel}`);
        } else if (resolveConflict(rel, { overwriteAll, keepAll, interactive, choiceFn }) === 'overwrite') {
            planCopy(srcAbs, destAbs, rel, stripped);
            stats.merged++;
            console.log(`  OVERWRITE ${rel}`);
        } else {
            stats.skipped++;
            stats.conflicts.push(rel);
            console.log(`  KEEP     ${rel} (conflict — kept existing)`);
        }
    }
    // The doc redirect the updater applies (the toolkit's CLAUDE.md as the template docs at
    // .claude/README.md): an install that left it out made the first update after it write
    // a new file, so install and update disagreed about the same release.
    const redirectSrc = path.join(source, ROOT_DOC_REDIRECT.src);
    const redirectDest = path.join(target, ROOT_DOC_REDIRECT.dest);
    if (fs.existsSync(redirectSrc)) {
        if (!fs.existsSync(redirectDest)) {
            planCopy(redirectSrc, redirectDest, ROOT_DOC_REDIRECT.dest);
            stats.created++;
            console.log(`  CREATE   ${ROOT_DOC_REDIRECT.dest}`);
        } else if (!fs.readFileSync(redirectSrc).equals(fs.readFileSync(redirectDest))) {
            // Named like the walked .claude/ files: relative to .claude/, as the prompt and MERGE-NOTES expect.
            const redirectRel = ROOT_DOC_REDIRECT.dest.replace(/^\.claude\//, '');
            if (resolveConflict(redirectRel, { overwriteAll, keepAll, interactive, choiceFn }) === 'overwrite') {
                planCopy(redirectSrc, redirectDest, ROOT_DOC_REDIRECT.dest);
                stats.merged++;
                console.log(`  OVERWRITE ${ROOT_DOC_REDIRECT.dest}`);
            } else {
                stats.skipped++;
                stats.conflicts.push(redirectRel);
                console.log(`  KEEP     ${ROOT_DOC_REDIRECT.dest} (conflict — kept existing)`);
            }
        }
    }
    // Plan native outputs against the accepted copy choices before persisting
    // any canonical or legacy input. Preview and live installs share containment.
    const commands = [...new Set([...commandFiles(target), ...[...files.keys()].filter(rel => rel.startsWith('.claude/commands/') && rel.endsWith('.md'))])];
    // The version marker is deferred out of the main render and rendered last.
    const markerOnly = new Set([VERSION_MARKER]);
    const renderOptions = { force: overwriteAll, excludedSkills, files, commands, deferredOutputs: markerOnly };
    const preview = projections.size ? renderSharedAgents(target, { ...renderOptions, dryRun: true }) : { changed: [], conflicts: [] };
    for (const warning of preview.warnings || []) console.warn(warning);

    // A generated projection with local edits is a genuine conflict, unlike a
    // copy-level KEEP: refuse before ANY write (copies, MERGE-NOTES, scaffold,
    // stub, startup merge, marker) so the target stays exactly as it was.
    if (preview.conflicts.length > 0) {
        for (const rel of preview.conflicts) {
            stats.conflicts.push(rel);
            console.error(`  CONFLICT ${rel} — generated output has local edits; review canonical source before rendering.`);
        }
        stats.ok = false;
        stats.error = `generated projection conflict (${preview.conflicts.join(', ')}); install refused before any write`;
        console.error(`\nERROR: ${stats.error}.`);
        return stats;
    }

    if (!dryRun) {
        for (const [src, dest, content] of pendingCopies) {
            if (content === undefined) copyFile(src, dest, target);
            else { fs.mkdirSync(path.dirname(dest), { recursive: true }); safeWrite(dest, content, 'utf8', target); }
        }
        if (projections.size) {
            const rendered = renderSharedAgents(target, renderOptions);
            if (rendered.conflicts.length === 0) stats.created += rendered.changed.length;
            for (const rel of rendered.conflicts) {
                stats.conflicts.push(rel);
                console.error(`  CONFLICT ${rel} — generated output has local edits; review canonical source before rendering.`);
            }
            if (rendered.conflicts.length > 0) {
                stats.ok = false;
                stats.error = `generated projection conflict (${rendered.conflicts.join(', ')}); native outputs were not rendered`;
            }
        }
    } else {
        for (const rel of preview.changed) console.log(`  RENDER   ${rel} (from installed canonical sources)`);
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

    if (!dryRun && stats.ok) {
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
                // A failed scaffold leaves the install incomplete: report failure and
                // withhold the CLAUDE.md stub, startup merge and version marker.
                console.error(`\n  ERROR: scaffold.js threw — ${err.message}`);
                console.error('  The .claude/ copy succeeded but the install is incomplete; after fixing the cause, run:');
                console.error(`    node .claude/core/scaffold.js  (from within ${target})`);
                stats.scaffoldError = err.message;
                stats.ok = false;
                stats.error = `scaffold failed: ${err.message}`;
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
    if (!stats.ok) {
        console.error('\n  SKIP     CLAUDE.md stub, startup instructions and .claude/version.json (install incomplete)');
    } else if (fs.existsSync(targetClaudeMd)) {
        console.log('\n  NOTE: existing CLAUDE.md preserved — /onboard will offer to merge Domdhi.Agents guidance.');
    } else if (!dryRun) {
        const stub =
            '# CLAUDE.md\n\n' +
            'This project uses the Domdhi.Agents toolkit.\n' +
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

    if (stats.ok) {
        for (const rel of syncStartupInstructions(target, { dryRun, applyManagedBlock, available: fs.existsSync(path.join(source, '.agents/startup.md')) })) {
            console.log(`  ${dryRun ? 'PLAN' : 'MERGE'}    ${rel} (shared startup rules; project prose retained)`);
            stats.merged++;
        }
    }

    // ── Version marker — last (install-complete marker) ───────────────────────
    //
    // Reached only when no projection conflict, scaffold failure or thrown write
    // occurred above (a throw propagates out of runInstall before this point).

    if (stats.ok) {
        if (projections.has(VERSION_MARKER)) {
            if (dryRun) {
                console.log(`  PLAN     ${VERSION_MARKER} (last — install marker)`);
            } else {
                const marker = renderSharedAgents(target, { onlyOutputs: markerOnly, adoptPaths: markerOnly, excludedSkills, files, commands });
                if (marker.conflicts.length > 0) {
                    stats.conflicts.push(...marker.conflicts);
                    stats.ok = false;
                    stats.error = `generated version marker conflict (${marker.conflicts.join(', ')})`;
                    console.error(`  CONFLICT ${VERSION_MARKER} — version marker could not be rendered.`);
                } else if (marker.changed.length > 0) {
                    stats.created += marker.changed.length;
                    console.log(`  RENDER   ${VERSION_MARKER} (last — install marker)`);
                }
            }
        } else if (markerCopy) {
            if (dryRun) {
                console.log(`  PLAN     ${VERSION_MARKER} (last — install marker)`);
            } else {
                copyFile(markerCopy[0], markerCopy[1], target);
                console.log(`  COPY     ${VERSION_MARKER} (last — install marker)`);
            }
        }
    }

    // ── Report ─────────────────────────────────────────────────────────────────

    console.log('');
    console.log(`  Result: Created ${stats.created} / Skipped (kept) ${stats.skipped} / Overwritten ${stats.merged}`);
    if (dryRun) {
        console.log('  (dry-run — no files were written)');
    }
    if (!stats.ok) {
        console.error(`  FAILED: ${stats.error}`);
        return stats;
    }
    console.log('');
    console.log('  Next steps:');
    console.log('    1. Review the changes:  git diff --stat');
    console.log('    2. Stage reviewed install changes, including .agents/, .codex/, AGENTS.md, CLAUDE.md and .gitignore when created or changed.');
    console.log('    3. Run /onboard in Claude Code or $onboard in a fresh Codex session.');

    return stats;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

function main() {
    const argv = process.argv.slice(2);
    const helpRequested = argv.includes('--help') || argv.includes('-h');
    if (helpRequested) {
        console.log('domdhi-agents-install — brownfield installer for the Domdhi.Agents toolkit\n');
        console.log('Usage:');
        console.log('  node .claude/core/install.js [target] [flags]\n');
        console.log('Arguments:');
        console.log('  target           Path to the project to install into (default: .)');
        console.log('');
        console.log('Flags:');
        console.log('  --dry-run        Print what would happen; write nothing (preflight still runs).');
        console.log('  --force          Overwrite all conflicting files.');
        console.log('  --overwrite-all  Same as --force.');
        console.log('  --keep           Keep all conflicting files without prompting.');
        console.log('  --no-deps        No-op. install.js never runs npm install by default.');
        console.log('');
        console.log('Preflight:');
        console.log('  Source assets, target path containment and symbolic links are checked before');
        console.log("  mutation. The target's .claude/update-config.json, when present, must be valid.");
        console.log('  A refusal prints a fixed CODE: message and writes nothing.');
        process.exit(0);
    }

    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        console.error(`install: ${err.message}`);
        process.exitCode = 1;
        return;
    }
    const source = path.resolve(__dirname, '..', '..');
    const targetAbs = path.resolve(opts.target);

    console.log(`Domdhi.Agents Installer${opts.dryRun ? ' (DRY RUN)' : ''}`);
    console.log(`  Source : ${source}`);
    console.log(`  Target : ${targetAbs}`);
    console.log('');

    const verified = preflightInstall({ source, target: targetAbs, dryRun: opts.dryRun });
    if (!verified.ok) {
        for (const error of verified.errors) console.error(`  ${error.code}: ${error.message}${error.reason ? ` [${error.reason}]` : ''}`);
        console.error('install: preflight refused; nothing was written.');
        process.exitCode = 1;
        return;
    }
    console.log('  Preflight: source assets and target paths verified');
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

    let stats;
    try {
        stats = runInstall({
            source,
            target:       verified.target,
            dryRun:       opts.dryRun,
            overwriteAll: opts.overwriteAll,
            keepAll:      opts.keepAll,
            force:        opts.force,
            noDeps:       opts.noDeps,
            interactive,
            choiceFn,
        });
    } catch (err) {
        // A thrown write (symlink guard, filesystem error) aborts before the
        // version marker; report it as a failed install rather than a stack trace.
        console.error(`install: ERROR — ${err.message}`);
        console.error('install: incomplete; the version marker was not written.');
        process.exitCode = 1;
        return;
    }

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

module.exports = { runInstall, resolveConflict, writeMergeNotes, DO_NOT_SHIP, parseArgs, installScope, preflightInstall };
