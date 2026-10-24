/**
 * git-ignored.js — the one Git-ignored source filter for every front door that
 * walks a tree from the filesystem (install, update, canonicalFiles,
 * commandFiles and the workshop publisher).
 *
 * An untracked file Git ignores is local state by definition: Claude Code
 * harness files such as `.claude/scheduled_tasks.lock` (a live session id and
 * pid, ignored through `.git/info/exclude`), `*.log`, `*.local.*` and the like.
 * A filesystem walk would otherwise copy or render them into adopters and
 * artifacts.
 *
 * Contract:
 *   - Tracked files are never reported, so a tracked file that matches an
 *     ignore pattern still ships.
 *   - A root is a Git source only when it is a checkout's top level, or is
 *     tracked content of the checkout that encloses it. A root with no `.git`
 *     on its ancestor chain, or one that merely sits inside an unrelated
 *     checkout (for example an extracted release under an umbrella repository,
 *     ignored or untracked there), is a plain tree: the result is null, the
 *     outer repository's ignore rules are never applied, and no ignore query
 *     runs.
 *   - Inside a real checkout, a failed query throws; callers refuse before any
 *     write instead of shipping unfiltered files.
 *   - Inherited Git location overrides (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE
 *     and similar) would point the query at another repository, so a Git
 *     source refuses them instead of failing open. The distribution front doors
 *     already refuse them in preflight; this covers direct renders too.
 *
 * Paths are relative to the given root, forward-slash separated. Ignored
 * directories are reported once with a trailing slash (`--directory`).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./git');

// Trace sinks must never receive bytes from a read-only query.
const READ_ONLY_GIT_ENV = { GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' };
const LOCATION_OVERRIDES = /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE)$/i;
const DEFAULT_FAILURE = 'Git ignored-file query failed; refusing to use unfiltered files.';

function nearestGitAncestor(realRoot) {
    let directory = realRoot;
    for (;;) {
        try {
            fs.lstatSync(path.join(directory, '.git'));
            return directory;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const parent = path.dirname(directory);
        if (parent === directory) return null;
        directory = parent;
    }
}

function refuseLocationOverrides(message) {
    const keys = Object.keys(process.env).filter(key => LOCATION_OVERRIDES.test(key) && process.env[key] !== '');
    if (keys.length) throw new Error(`${message} Inherited Git location override present: ${keys.sort().join(', ')}.`);
}

/**
 * The checkout top level when `root` is Git source content, otherwise null
 * (also for a missing root: nothing to walk).
 *
 * @param {string} root
 * @param {{ failureMessage?: string }} [options]
 * @returns {string | null}
 */
function gitCheckoutRoot(root, options = {}) {
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const top = nearestGitAncestor(realRoot);
    if (!top) return null;
    const message = options.failureMessage || DEFAULT_FAILURE;
    refuseLocationOverrides(message);
    if (top === realRoot) return top;
    // Nested inside an enclosing checkout: a Git source only when the
    // enclosing work tree actually tracks content under this root.
    let tracked;
    try {
        tracked = git(['--no-optional-locks', 'ls-files', '-z', '--', '.'], { cwd: realRoot, env: READ_ONLY_GIT_ENV, raw: true });
    } catch (error) {
        throw new Error(message, { cause: error });
    }
    return tracked ? top : null;
}

/**
 * Untracked, Git-ignored paths under `root`.
 *
 * @param {string} root
 * @param {{ failureMessage?: string }} [options]
 * @returns {{ files: Set<string>, dirs: string[] } | null} null for a plain (non-Git-source) root
 */
function ignoredPaths(root, options = {}) {
    if (!gitCheckoutRoot(root, options)) return null;
    let output;
    try {
        output = git(['--no-optional-locks', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
            cwd: root, env: READ_ONLY_GIT_ENV, raw: true,
        });
    } catch (error) {
        throw new Error(options.failureMessage || DEFAULT_FAILURE, { cause: error });
    }
    const entries = output.split('\0').map(entry => entry.replace(/\\/g, '/')).filter(Boolean);
    return {
        files: new Set(entries.filter(entry => !entry.endsWith('/'))),
        dirs: entries.filter(entry => entry.endsWith('/')),
    };
}

/** True when `relPath` (relative to the queried root) is an ignored file or lies in an ignored directory. */
function isIgnoredPath(relPath, ignored) {
    if (!ignored) return false;
    const rel = relPath.replace(/\\/g, '/');
    return ignored.files.has(rel) || ignored.dirs.some(dir => rel.startsWith(dir));
}

/**
 * Query once and return a predicate over paths relative to `root`.
 *
 * @param {string} root
 * @param {{ failureMessage?: string }} [options]
 * @returns {(relPath: string) => boolean}
 */
function ignoredFilter(root, options) {
    const ignored = ignoredPaths(root, options);
    return relPath => isIgnoredPath(relPath, ignored);
}

module.exports = { gitCheckoutRoot, ignoredPaths, isIgnoredPath, ignoredFilter, READ_ONLY_GIT_ENV };
