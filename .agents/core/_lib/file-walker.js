/**
 * File Walker — yields all file paths under a directory, skipping named subdirs.
 *
 * Callers pass an explicit skipList so the walker has no hardcoded opinions about
 * which directories to ignore — that policy lives in the orchestrator
 * (template-updater.js) which passes ALWAYS_SKIP_DIRS.
 *
 * Never calls process.cwd(). All paths are anchored to the rootDir argument.
 *
 * @module file-walker
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Recursively walk a directory and yield absolute file paths.
 *
 * Directories whose basename appears in skipList are pruned entirely — their
 * contents are never visited.
 *
 * Symlinks are followed by RESOLVED TYPE, not by the Dirent flags: a symlink
 * Dirent reports `isDirectory() === false` AND `isFile() === false`, so a naive
 * walker branching only on those two silently DROPS every symlinked file/dir (the
 * exact bug that stripped an adopter's symlinked bespoke skills on sync). Here, a
 * Dirent that is neither a plain dir nor a plain file is probed with `statSync`
 * (which follows the link) — resolving to a directory recurses, to a file yields.
 * A broken symlink (statSync throws) is skipped silently. Symlink CYCLES are
 * guarded by a visited-realpath set: each directory entered is recorded by its
 * `realpathSync`, and a directory whose real path was already visited is not
 * re-entered, so a `sub/loop -> parent` cycle terminates.
 *
 * @param {string}   rootDir   — absolute path to the directory to walk
 * @param {string[]} skipList  — directory basenames to skip (e.g. ['__tests__', 'node_modules'])
 * @param {object}   [opts]
 * @param {boolean}  [opts.skipHidden=false] — also prune every dot-prefixed
 *                   directory (a name-pattern rule a basename skipList can't
 *                   express; F2 — lets code-metrics.js share this walker).
 * @yields {string}  absolute file path
 */
function* walkDir(rootDir, skipList, { skipHidden = false } = {}) {
    if (!fs.existsSync(rootDir)) return;
    yield* walkInner(rootDir, new Set(skipList), new Set(), skipHidden);
}

/**
 * Inner recursion carrying the shared skipSet and visited-realpath set.
 *
 * @param {string}      dir
 * @param {Set<string>} skipSet
 * @param {Set<string>} visited  — realpaths of directories already entered
 * @param {boolean}     skipHidden
 * @yields {string}
 */
function* walkInner(dir, skipSet, visited, skipHidden) {
    let realDir;
    try {
        realDir = fs.realpathSync(dir);
    } catch {
        return; // broken/inaccessible — nothing to walk
    }
    if (visited.has(realDir)) return; // cycle — already walked this real directory
    visited.add(realDir);

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    const skipDirName = (name) => skipSet.has(name) || (skipHidden && name.startsWith('.'));

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (skipDirName(entry.name)) continue;
            yield* walkInner(fullPath, skipSet, visited, skipHidden);
        } else if (entry.isFile()) {
            yield fullPath;
        } else {
            // Symlink (or other non-dir/non-file Dirent) — resolve its real type.
            let st;
            try {
                st = fs.statSync(fullPath); // follows the link
            } catch {
                continue; // broken symlink — skip silently
            }
            if (st.isDirectory()) {
                if (skipDirName(entry.name)) continue; // skipList prunes symlinked dirs too
                yield* walkInner(fullPath, skipSet, visited, skipHidden);
            } else if (st.isFile()) {
                yield fullPath;
            }
        }
    }
}

module.exports = { walkDir };
