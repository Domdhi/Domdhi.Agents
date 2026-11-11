#!/usr/bin/env node
'use strict';

/**
 * git-hooks.js — the toolkit-managed git hooks that run the secret scan where git creates and publishes commits.
 *
 * commit.js scans what it commits, but a raw `git commit -F <file>` from a terminal (or any tool that shells
 * out to git) never touched it. Small POSIX sh shims close that gap, each running the scanner in
 * `.agents/hooks/secret-scanner.cjs` of the work tree it runs in:
 *
 *   pre-commit         --git-precommit        the staged files           `git commit`
 *   commit-msg         --commit-msg <file>    the whole message          `git commit`, `git merge`'s commit
 *   pre-merge-commit   --git-precommit        the merge result           `git merge` that creates a commit
 *   pre-applypatch     --git-precommit        the patch result           `git am`
 *   pre-push           --pre-push <remote>    every object the push would publish that the remote does not vouch for
 *
 * WHAT THIS COVERS, AND WHAT IT DOES NOT. The commit hooks cover commit, merge and am. Git has paths that run
 * no commit hook at all (`commit-tree` + `update-ref`, cherry-pick, rebase, `stash` merges, `reset --soft`), a
 * human can `--no-verify`, and a hook is only as trustworthy as the `node` and the scanner it finds. The
 * pre-push hook is the backstop for all of those: a secret that was committed by any route is stopped when it
 * would leave the machine. Nothing here protects a commit that is never pushed.
 *
 * WHERE THEY LIVE. The hooks are never tracked. They are written into the directory git actually runs hooks
 * from (`git rev-parse --git-path hooks`, which resolves core.hooksPath and linked worktrees) and ONLY when
 * that directory is inside the repository's git common dir. A core.hooksPath that points at a tracked or
 * project directory (husky's .husky, a .githooks fossil from the retired 2026-05 template) is never written
 * to: the helper reports it and prints the exact line the owner adds to their own hook. (The retired
 * .githooks/pre-commit was committed non-executable, so git printed "hook ignored" on every commit, and it
 * kept calling a renamed scanner file. An untracked file in the git dir cannot rot that way.)
 *
 * OWNERSHIP. A hook is ours when its first comment line is `# domdhi-agents managed hook: <name> v<N>`
 * (right under the shebang). Install and update rewrite a marker hook whose content or mode differs; a hook
 * without the marker is never touched; `--remove` deletes marker hooks only.
 *
 * FAIL CLOSED. A shim that cannot find node, the scanner, or a scanner that speaks the hook protocol it
 * expects (a checkout whose toolkit predates the managed hooks) prints how to fix it (or how to remove the
 * hook) and exits non-zero. The audited bypass is CLAUDE_COMMIT_NO_SCAN=1: it skips the scan and records a
 * 'bypass' guardrail event, and the shim says honestly whether the event was recorded.
 *
 * KNOWN LIMITS. A different `node` earlier on PATH, `NODE_OPTIONS=--require …`, and a tampered scanner in the
 * branch being committed run as the hook; so does anything a branch controls. The pre-push scan runs the same
 * way. Compressed archives are not opened (a deflated zip or .gz holding a key is not seen).
 *
 * Usage:
 *   node .agents/core/git-hooks.js [install] [dir] [--dry-run]   install or refresh (default)
 *   node .agents/core/git-hooks.js --check [dir]                  status; exit 1 when the hooks are not active
 *   node .agents/core/git-hooks.js --remove [dir] [--dry-run]     delete the hooks this helper wrote
 *   (also .claude/core/git-hooks.js or .codex/core/git-hooks.js, whichever the runtime installed)
 *
 * Exports (install.js, template-updater.js, uninstall.js, commit.js): ensureHooks, installHooks,
 * removeHooks, inspectHooks, isActive, renderHook, HOOK_NAMES.
 *
 * Node builtins and the git CLI only.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { git, gitSafe } = require('./_lib/git');
const { safeWrite, safeDelete } = require('./_lib/fs-safe');
const { GIT_HOOK_PROTOCOL, PROTOCOL_LINE_PREFIX } = require('./_lib/git-hook-protocol');

const HOOK_VERSION = 2;
const SCANNER_REL = '.agents/hooks/secret-scanner.cjs';
const CLI = 'node .agents/core/git-hooks.js';          // canonical; present wherever the scanner is
const REMOVE_COMMAND = `${CLI} --remove`;
const INSTALL_COMMAND = CLI;

// What each hook scans, and how the shim calls the scanner.
const HOOKS = {
    'pre-commit': { what: 'the staged files', call: 'exec node "$scanner" --git-precommit </dev/null' },
    'commit-msg': { what: 'the commit message', call: 'exec node "$scanner" --commit-msg "$msgfile" </dev/null' },
    'pre-merge-commit': { what: 'the merge result held in the index', call: 'exec node "$scanner" --git-precommit </dev/null' },
    'pre-applypatch': { what: 'the patch result held in the index (git am)', call: 'exec node "$scanner" --git-precommit </dev/null' },
    // Not redirected from /dev/null: git feeds the refs being pushed on stdin.
    'pre-push': { what: 'every object the push would publish that the remote does not vouch for (blobs, commit and tag messages)', call: 'exec node "$scanner" --pre-push "$1" "$2"' },
};
const HOOK_NAMES = Object.keys(HOOKS);
const COMMIT_HOOKS = ['pre-commit', 'commit-msg'];   // the pair commit.js may leave the commit scan to

const markerLine = name => `# domdhi-agents managed hook: ${name} v${HOOK_VERSION}`;
// Ours only when the marker is the FIRST comment line, right under the shebang: a foreign hook that quotes it elsewhere is not ours.
const markerRe = name => new RegExp(`^(?:#![^\\n]*\\n)?# domdhi-agents managed hook: ${name}\\b`);

// ── the shims ─────────────────────────────────────────────────────────────────

/**
 * The exact text of one managed hook. LF endings, no trailing whitespace. The text is the same in every
 * repository (the root is resolved when the hook runs), which is what lets `isActive` compare bytes.
 */
function renderHook(name) {
    const spec = HOOKS[name];
    if (!spec) throw new Error(`git-hooks: unknown hook "${name}"`);
    const msgfileCheck = name === 'commit-msg'
        ? `msgfile=$1
if [ -z "$msgfile" ] && [ "\${CLAUDE_COMMIT_NO_SCAN:-}" != "1" ]; then
  echo "domdhi-agents $hook hook: git passed no message file, so the secret scan cannot run. Commit blocked." >&2
  exit 1
fi
`
        : '';
    return `#!/bin/sh
${markerLine(name)}
# Written by the toolkit (${INSTALL_COMMAND}). It lives in the git directory and is never
# tracked. It scans ${spec.what} for secrets, and it fails closed.
# Audited bypass: CLAUDE_COMMIT_NO_SCAN=1 (recorded as a guardrail event). Remove it: ${REMOVE_COMMAND}
hook=${name}
${msgfileCheck}root=$(git rev-parse --show-toplevel 2>/dev/null)
scanner="$root/${SCANNER_REL}"
protocol_ok() {
  seen=$(node "$scanner" --hook-protocol 2>/dev/null </dev/null) || return 1
  proto=\${seen#${PROTOCOL_LINE_PREFIX}}
  [ "$proto" != "$seen" ] || return 1
  case "$proto" in ''|*[!0-9]*) return 1 ;; esac
  [ "$proto" -ge ${GIT_HOOK_PROTOCOL} ]
}
if [ "\${CLAUDE_COMMIT_NO_SCAN:-}" = "1" ]; then
  if [ -n "$root" ] && command -v node >/dev/null 2>&1 && [ -f "$scanner" ] && protocol_ok; then
    node "$scanner" --hook-bypass "$hook" </dev/null
  else
    echo "domdhi-agents $hook hook: secret scan bypassed (CLAUDE_COMMIT_NO_SCAN=1); the bypass was NOT recorded, because node or a current scanner is unavailable here." >&2
  fi
  exit 0
fi
if [ -z "$root" ]; then
  echo "domdhi-agents $hook hook: cannot resolve the repository root, so the secret scan cannot run. Blocked." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "domdhi-agents $hook hook: node is not on PATH, so the secret scan cannot run. Blocked." >&2
  echo "  Put node on PATH, or delete this hook file if you no longer want it: $0" >&2
  echo "  (CLAUDE_COMMIT_NO_SCAN=1 skips the scan, unrecorded here because node is missing.)" >&2
  exit 1
fi
if [ ! -f "$scanner" ]; then
  echo "domdhi-agents $hook hook: the secret scanner is missing ($scanner). Blocked." >&2
  echo "  Restore it: git checkout -- ${SCANNER_REL}, or re-run the toolkit install or update." >&2
  echo "  If the toolkit was removed on purpose, remove this hook: ${REMOVE_COMMAND}" >&2
  echo "  (or delete $0 if that script is gone too). CLAUDE_COMMIT_NO_SCAN=1 skips the scan, unrecorded here." >&2
  exit 1
fi
if ! protocol_ok; then
  echo "domdhi-agents $hook hook: the toolkit in this checkout ($scanner) predates the managed git hooks (hook protocol \${proto:-none}, needs ${GIT_HOOK_PROTOCOL}), so it cannot be trusted to scan. Blocked." >&2
  echo "  Merge or update the toolkit on this branch (for example: node <toolkit>/.agents/core/template-updater.js update .)," >&2
  echo "  or, for a human-reviewed case, CLAUDE_COMMIT_NO_SCAN=1 (audited: recorded when the scanner can record it)." >&2
  echo "  If the managed hooks are no longer wanted: ${REMOVE_COMMAND}  (or delete $0)." >&2
  exit 1
fi
${spec.call}
`;
}

/** The line an owner adds to their own hook so it runs the same scan (printed when we must not write). */
function ownerLine(name) {
    const call = {
        'pre-commit': '--git-precommit',
        'pre-merge-commit': '--git-precommit',
        'pre-applypatch': '--git-precommit',
        'commit-msg': '--commit-msg "$1"',
        'pre-push': '--pre-push "$1" "$2"',
    }[name];
    // The scanner itself honors CLAUDE_COMMIT_NO_SCAN=1 (record, skip), so the documented bypass works in any hook that calls it.
    return `root=$(git rev-parse --show-toplevel) && node "$root/${SCANNER_REL}" ${call} || exit 1`;
}

// ── locating the hooks directory ──────────────────────────────────────────────

/** realpath of the nearest existing ancestor, plus the not-yet-existing remainder. */
function realish(p) {
    const rest = [];
    let current = path.resolve(p);
    for (;;) {
        try {
            return path.join(fs.realpathSync.native(current), ...[...rest].reverse());
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(p);
            rest.push(path.basename(current));
            current = parent;
        }
    }
}

function within(parent, child) {
    const rel = path.relative(parent, child);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

const slash = p => p.split(path.sep).join('/');

/** `git rev-parse --path-format=absolute <args>` from `cwd`; older git (< 2.31) falls back to resolving the relative answer. */
function revParsePath(args, cwd) {
    try {
        return git(['rev-parse', '--path-format=absolute', ...args], { cwd });
    } catch {
        return path.resolve(cwd, git(['rev-parse', ...args], { cwd }));
    }
}

/** core.hooksPath set to the null device by name. Git for Windows resolves /dev/null to a path that does not exist. */
function isNullDevice(hooksPath, platform = process.platform) {
    if (typeof hooksPath !== 'string') return false;
    const p = hooksPath.trim();
    // NUL is a device only on Windows; on POSIX a relative "nul" is an ordinary directory name.
    return p === '/dev/null' || (platform === 'win32' && /^(?:\/dev\/null|nul)$/i.test(p));
}

/** Is the configured hooks "directory" something git cannot run hooks from (/dev/null, a file, a path under a file)? */
function notADirectory(dir) {
    try {
        const st = fs.statSync(dir, { throwIfNoEntry: false });
        return Boolean(st) && !st.isDirectory();
    } catch {
        return true; // ENOTDIR / EACCES on the way: nothing can run from there
    }
}

/**
 * Where git runs hooks for the repository containing `dir`. With `requireRoot`, `dir` must be that repository's
 * work tree root: install, update and uninstall act on a target project, and a target nested inside some other
 * repository must never reach that repository's hooks.
 * @returns {{ ok: false, reason: string }
 *   | { ok: true, toplevel: string, commonDir: string, hooksDir: string, hooksPath: string|null, inside: boolean, disabled: boolean }}
 *   disabled: core.hooksPath names something that is not a directory (core.hooksPath=/dev/null is the common
 *   idiom): git runs no hook at all.
 */
function locate(dir, { requireRoot = false } = {}) {
    if (!fs.existsSync(dir)) return { ok: false, reason: 'the directory does not exist' };
    let toplevel;
    try {
        toplevel = git(['rev-parse', '--show-toplevel'], { cwd: path.resolve(dir) });
    } catch (err) {
        return { ok: false, reason: err && err.code === 'ENOENT' ? 'git is not installed' : 'not a git work tree' };
    }
    if (requireRoot && !samePath(realish(dir), realish(toplevel))) {
        return { ok: false, reason: `the target is inside the work tree of ${realish(toplevel)}, not its root` };
    }
    try {
        const commonDir = realish(revParsePath(['--git-common-dir'], toplevel));
        const hooksDir = realish(revParsePath(['--git-path', 'hooks'], toplevel));
        const hooksPath = gitSafe(['config', '--get', 'core.hooksPath'], { cwd: toplevel }) || null;
        return {
            ok: true, toplevel: realish(toplevel), commonDir, hooksDir, hooksPath,
            inside: within(commonDir, hooksDir), disabled: notADirectory(hooksDir) || isNullDevice(hooksPath),
        };
    } catch (err) {
        return { ok: false, reason: `could not resolve the git hooks directory (${err.message.split('\n')[0]})` };
    }
}

// ── inspecting ────────────────────────────────────────────────────────────────

function isExecutable(stat) {
    // Git for Windows runs hooks through its own sh and ignores the mode bit.
    return process.platform === 'win32' || (stat.mode & 0o100) !== 0;
}

/**
 * State of one hook file: missing | current | outdated (ours, content differs) | not-executable (ours, the
 * mode lost its execute bit, so git would print "hook ignored") | foreign (not ours, a link, unreadable, or
 * the directory is not a directory: never touched).
 */
function inspectHook(hooksDir, name) {
    const file = path.join(hooksDir, name);
    let stat;
    try { stat = fs.lstatSync(file, { throwIfNoEntry: false }); } catch { return { name, file, state: 'foreign', text: '' }; }
    if (!stat) return { name, file, state: 'missing' };
    if (stat.isSymbolicLink() || !stat.isFile()) return { name, file, state: 'foreign', text: '' };
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { name, file, state: 'foreign', text: '' }; }
    if (!markerRe(name).test(text)) return { name, file, state: 'foreign', text };
    if (text !== renderHook(name)) return { name, file, state: 'outdated', text };
    if (!isExecutable(stat)) return { name, file, state: 'not-executable', text };
    return { name, file, state: 'current', text };
}

/** The retired toolkit hook (.githooks/pre-commit, removed 2026-05): its header, whatever scanner path it calls. */
function isRetiredToolkitHook(text) {
    return /^# Git pre-commit hook .{1,4} Secret Scanner/m.test(text || '')
        && /secret-scanner\.(?:cjs|js)\s+--git-precommit/.test(text);
}

/**
 * The scanner in the work tree as the shims will find it: 'ok' (speaks hook protocol >= the one the shims
 * need), 'old' (present but predates the managed hooks, or does not answer), 'missing'.
 */
function scannerStatus(toplevel) {
    const file = path.join(toplevel, ...SCANNER_REL.split('/'));
    if (!fs.existsSync(file)) return 'missing';
    const r = spawnSync(process.execPath, [file, '--hook-protocol'], { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    const out = String(r.stdout || '').trim();
    if (r.error || r.status !== 0 || !out.startsWith(PROTOCOL_LINE_PREFIX)) return 'old';
    const n = out.slice(PROTOCOL_LINE_PREFIX.length);
    return /^\d+$/.test(n) && Number(n) >= GIT_HOOK_PROTOCOL ? 'ok' : 'old';
}

/**
 * Where the hooks stand for the repository containing `dir`.
 * `active`: every managed hook is ours, current and executable where git runs hooks, and the scanner speaks
 * the hook protocol. `commitCovered`: the same for pre-commit + commit-msg alone, which is what commit.js
 * needs to leave the commit scan to git. Any doubt is false.
 */
function inspectHooks(dir = process.cwd(), { requireRoot = false } = {}) {
    const loc = locate(dir, { requireRoot });
    if (!loc.ok) return { repo: false, reason: loc.reason, active: false, commitCovered: false, hooks: [] };
    const hooks = loc.disabled
        ? HOOK_NAMES.map(name => ({ name, file: path.join(loc.hooksDir, name), state: 'disabled' }))
        : HOOK_NAMES.map(name => inspectHook(loc.hooksDir, name));
    const scanner = scannerStatus(loc.toplevel);
    const current = names => hooks.filter(h => names.includes(h.name)).every(h => h.state === 'current');
    return {
        repo: true,
        ...loc,
        scanner,
        hooks,
        active: loc.inside && !loc.disabled && scanner === 'ok' && current(HOOK_NAMES),
        commitCovered: loc.inside && !loc.disabled && scanner === 'ok' && current(COMMIT_HOOKS),
    };
}

/** Will git run our current commit hooks (pre-commit + commit-msg) for a commit made from `dir`? Any doubt is false. */
function isActive(dir = process.cwd()) {
    try { return inspectHooks(dir).commitCovered; } catch { return false; }
}

// ── reporting a hook we must not write ────────────────────────────────────────

function relToTop(loc, file) {
    return slash(path.relative(loc.toplevel, file));
}

function cleanupLines(loc, hook) {
    if (!isRetiredToolkitHook(hook.text)) return [];
    const rel = relToTop(loc, hook.file);
    const tracked = gitSafe(['ls-files', '--error-unmatch', '--', rel], { cwd: loc.toplevel }) !== '';
    const lines = [`  ${rel} is the retired toolkit hook (the 2026-05 .githooks template; it calls a renamed scanner file). Known cleanup, NOT run by this helper:`,
        `    ${tracked ? `git rm ${rel}` : `rm ${rel}`}`];
    if (loc.hooksPath) lines.push('    git config --unset core.hooksPath');
    lines.push(`  Then run ${INSTALL_COMMAND} again.`);
    return lines;
}

function foreignProblem(loc, hook) {
    const where = loc.inside ? relToTop(loc, hook.file) : hook.file;
    return [
        `${where} exists and was not written by the toolkit; it was left untouched. Add this line to it so the secret scan runs there:`,
        `    ${ownerLine(hook.name)}`,
        ...cleanupLines(loc, hook),
    ];
}

function outsideProblem(loc) {
    if (loc.disabled) {
        return [
            `core.hooksPath points to ${loc.hooksPath ? `"${loc.hooksPath}"` : loc.hooksDir}, which is not a directory: git runs NO hook at all in this repository (hooks disabled), so nothing is scanned at commit or push time.`,
            `The toolkit wrote nothing. To use the managed hooks, unset it: git config --unset core.hooksPath  (then run ${INSTALL_COMMAND}).`,
        ];
    }
    const lines = [
        `core.hooksPath points to ${loc.hooksPath ? `"${loc.hooksPath}"` : loc.hooksDir}, outside the git directory (${loc.commonDir}), so the toolkit wrote nothing there: hook files must never be tracked.`,
        'Add these lines to your own hooks in that directory so the secret scan runs there:',
    ];
    for (const name of HOOK_NAMES) {
        lines.push(`  ${name}:  ${ownerLine(name)}`);
        const hook = inspectHook(loc.hooksDir, name);
        if (hook.state === 'foreign') lines.push(...cleanupLines(loc, hook));
    }
    return lines;
}

// ── install / remove ──────────────────────────────────────────────────────────

function writeHook(loc, name) {
    const file = path.join(loc.hooksDir, name);
    fs.mkdirSync(loc.hooksDir, { recursive: true });
    // safeWrite refuses a symlinked ancestor between the git common dir and the hook, and a leaf symlink.
    safeWrite(file, renderHook(name), { encoding: 'utf8', mode: 0o755 }, loc.commonDir);
    fs.chmodSync(file, 0o755); // the open() mode is masked by umask and ignored when the file already existed
}

const SCANNER_PROBLEM = {
    missing: top => [`The hooks run ${SCANNER_REL} from the repository root and would block every commit without it. Install the toolkit at the repository root (${top}), then run ${INSTALL_COMMAND}.`],
    old: top => [`${SCANNER_REL} in ${top} predates the managed git hooks (it does not speak hook protocol ${GIT_HOOK_PROTOCOL}); the hooks would block every commit. Update the toolkit there, then run ${INSTALL_COMMAND}.`],
};

/**
 * Install or refresh the managed hooks in the repository containing `dir`. Never throws for an expected
 * condition; it reports. Writes nothing outside the git common dir and nothing over a hook we did not write.
 *
 * @param {string} dir
 * @param {{ dryRun?: boolean, requireScanner?: boolean, requireRoot?: boolean }} [options]  requireScanner (default
 *   true) refuses to install hooks that would block every commit because the scanner is absent or too old;
 *   requireRoot refuses a directory that is not the work tree root (see locate).
 * @returns {{ status: 'installed'|'updated'|'current'|'blocked'|'skipped'|'dry-run', active: boolean,
 *   changed: string[], summary: string, problems: string[][] }}
 *   problems: one array of lines per problem (the first line states it, the rest tell the owner what to do).
 */
function installHooks(dir = process.cwd(), { dryRun = false, requireScanner = true, requireRoot = false } = {}) {
    const state = inspectHooks(dir, { requireRoot });
    if (!state.repo) {
        return { status: 'skipped', active: false, changed: [], summary: `skipped (${state.reason})`, problems: [] };
    }
    if (!state.inside || state.disabled) {
        return {
            status: 'blocked', active: false, changed: [],
            summary: state.disabled ? 'not installed (core.hooksPath disables git hooks)' : 'not installed (core.hooksPath is outside the git directory)',
            problems: [outsideProblem(state)],
        };
    }
    if (requireScanner && state.scanner !== 'ok') {
        return {
            status: 'blocked', active: false, changed: [],
            summary: state.scanner === 'missing' ? `not installed (${SCANNER_REL} is not in ${state.toplevel})` : `not installed (${SCANNER_REL} predates the managed hooks)`,
            problems: [SCANNER_PROBLEM[state.scanner](state.toplevel)],
        };
    }

    const problems = [];
    const changed = [];
    const created = [];
    for (const hook of state.hooks) {
        if (hook.state === 'foreign') { problems.push(foreignProblem(state, hook)); continue; }
        if (hook.state === 'current') continue;
        if (!dryRun) writeHook(state, hook.name);
        (hook.state === 'missing' ? created : changed).push(hook.name);
    }
    const touched = [...created, ...changed];
    const blocked = problems.length > 0;
    const where = relOrAbs(state);
    const verb = dryRun ? 'would write' : 'wrote';
    let status;
    let summary;
    if (blocked) {
        status = 'blocked';
        summary = touched.length
            ? `${verb} ${touched.join(', ')} in ${where}, but a hook that is not ours was left untouched, so that step is not scanned`
            : 'not installed (a hook that is not ours was left untouched)';
    } else if (!touched.length) {
        status = 'current';
        summary = `already current in ${where}`;
    } else {
        status = dryRun ? 'dry-run' : (changed.length ? 'updated' : 'installed');
        summary = `${verb} ${touched.join(', ')} in ${where}`;
    }
    // Active once written; in a dry run only when nothing would change.
    const active = !blocked && (dryRun ? touched.length === 0 : true);
    return { status, active, changed: touched, summary, problems };
}

// The hooks directory as the owner knows it: relative to the work tree when it is inside it (.git/hooks), else absolute.
function relOrAbs(loc) {
    const rel = slash(path.relative(loc.toplevel, loc.hooksDir));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : loc.hooksDir;
}

/**
 * Delete the managed hooks (the ones carrying the marker) from the repository containing `dir`. Anything
 * else in the hooks directory stays. Looks in the active hooks directory when it is inside the git dir, and
 * always in <git dir>/hooks, where a hook is left behind if core.hooksPath was changed after the install.
 */
function removeHooks(dir = process.cwd(), { dryRun = false, requireRoot = false } = {}) {
    const loc = locate(dir, { requireRoot });
    if (!loc.ok) return { status: 'skipped', removed: [], kept: [], summary: `skipped (${loc.reason})` };
    const dirs = [...new Set([loc.inside && !loc.disabled ? loc.hooksDir : null, path.join(loc.commonDir, 'hooks')].filter(Boolean))];
    const removed = [];
    const kept = [];
    for (const hooksDir of dirs) {
        for (const name of HOOK_NAMES) {
            const hook = inspectHook(hooksDir, name);
            if (hook.state === 'missing') continue;
            if (hook.state === 'foreign') { kept.push(hook.file); continue; }
            if (!dryRun) safeDelete(hook.file, loc.commonDir);
            removed.push(hook.file);
        }
    }
    const summary = removed.length
        ? `${dryRun ? 'would remove' : 'removed'} ${removed.map(f => path.basename(f)).join(', ')}`
        : 'no managed hooks found';
    return { status: removed.length ? (dryRun ? 'dry-run' : 'removed') : 'none', removed, kept, summary };
}

/**
 * The install/update wiring: one log line, problems reported under it, never throws, no prompt.
 * Used by install.js and template-updater.js after the toolkit files are in place.
 */
function ensureHooks(target, { dryRun = false, log = console.log } = {}) {
    let result;
    try {
        result = installHooks(target, { dryRun, requireScanner: !dryRun, requireRoot: true });
    } catch (err) {
        log(`Git hooks: could not be installed (${err.message}). Run ${INSTALL_COMMAND} to retry.`);
        return { status: 'failed', active: false, changed: [], summary: err.message, problems: [] };
    }
    log(`Git hooks: ${dryRun && result.status !== 'skipped' ? '(dry run) ' : ''}${result.summary}`);
    for (const problem of result.problems) for (const line of problem) log(`  ${line}`);
    return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function describeState(state) {
    if (!state.repo) return [`Git hooks: not a git work tree (${state.reason})`];
    const lines = [`Git hooks directory: ${state.hooksDir}${state.hooksPath ? ` (core.hooksPath=${state.hooksPath})` : ''}`];
    if (state.disabled) lines.push('  not a directory: git runs NO hook here (hooks disabled)');
    else if (!state.inside) lines.push(`  outside the git directory ${state.commonDir}: the toolkit does not write there`);
    for (const hook of state.hooks) lines.push(`  ${hook.name}: ${hook.state}`);
    lines.push(`  scanner (${SCANNER_REL}): ${{ ok: 'present, speaks hook protocol ' + GIT_HOOK_PROTOCOL, old: 'present but PREDATES the managed hooks (hook protocol too old or none)', missing: 'MISSING' }[state.scanner]}`);
    lines.push(state.active
        ? 'Git hooks: active. Commit, merge and am run the secret scan, and push scans every commit it would publish.'
        : `Git hooks: NOT active. Install them with: ${INSTALL_COMMAND}`);
    return lines;
}

function main(argv = process.argv.slice(2)) {
    const flags = new Set(argv.filter(a => a.startsWith('--')));
    const known = new Set(['--check', '--remove', '--dry-run']);
    const unknown = [...flags].find(f => !known.has(f));
    if (unknown) {
        console.error(`git-hooks: unknown option ${unknown}\nUsage: git-hooks.js [install] [dir] [--dry-run] | --check [dir] | --remove [dir] [--dry-run]`);
        return 2;
    }
    const positional = argv.filter(a => !a.startsWith('--') && a !== 'install');
    const dir = positional[0] || process.cwd();
    const dryRun = flags.has('--dry-run');

    if (flags.has('--check')) {
        const state = inspectHooks(dir);
        for (const line of describeState(state)) console.log(line);
        if (state.repo && (!state.inside || state.disabled)) for (const line of outsideProblem(state)) console.log(`  ${line}`);
        return state.active ? 0 : 1;
    }
    if (flags.has('--remove')) {
        const result = removeHooks(dir, { dryRun });
        console.log(`Git hooks: ${result.summary}`);
        for (const file of result.kept) console.log(`  left ${file}: not written by the toolkit`);
        return 0;
    }
    const result = installHooks(dir, { dryRun });
    console.log(`Git hooks: ${dryRun && result.status !== 'skipped' ? '(dry run) ' : ''}${result.summary}`);
    for (const problem of result.problems) for (const line of problem) console.log(`  ${line}`);
    if (dryRun) return 0;
    return result.active ? 0 : 1;
}

if (require.main === module) {
    try { process.exitCode = main(); } catch (err) {
        console.error(`git-hooks: ${err.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    HOOK_NAMES, COMMIT_HOOKS, HOOK_VERSION, SCANNER_REL, renderHook, ownerLine, locate, inspectHook, inspectHooks, isActive,
    isRetiredToolkitHook, scannerStatus, installHooks, removeHooks, ensureHooks, main, isNullDevice,
};
