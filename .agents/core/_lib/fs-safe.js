/**
 * FS Safe — symlink-aware write/copy across the adopter trust boundary.
 *
 * `fs.writeFileSync` and `fs.copyFileSync` FOLLOW a destination symlink: if the
 * destination path is a symlink, they overwrite the REAL target the link points
 * at, silently. Worse, a symlinked ANCESTOR directory escapes the same way — a
 * leaf-only guard does NOT close the hole, because `mkdirSync(dirname,{recursive})`
 * is a no-op on an already-existing symlinked ancestor and the write then follows
 * it out of the tree (e.g. `<adopter>/.claude/skills -> /external`, then a write to
 * `.claude/skills/victim.md` lands on `/external/victim.md`). A malicious or
 * compromised adopter repo can pre-place such a symlink at a well-known template
 * path so the next `fleet:sync` / scaffold clobbers an arbitrary file.
 *
 * safeWrite / safeCopy close BOTH holes:
 *   1. Ancestor guard (when `containRoot` is given) — before writing, every existing
 *      directory between `path.dirname(dstPath)` and `containRoot` (exclusive of
 *      `containRoot` and everything above it) is `lstat`-checked; if any is a
 *      symlink, the write is REFUSED (throws a clear security error). This is the
 *      static defense against a symlinked ancestor.
 *   2. Leaf guard + O_NOFOLLOW — any existing leaf symlink is unlinked, then the
 *      real write opens the path with O_NOFOLLOW (where supported) so a symlink
 *      swapped in during the lstat→open race window is not followed (open fails
 *      closed rather than clobbering the target). This is the leaf-race hardening.
 *
 * `containRoot` is optional and backward-compatible: omit it for today's leaf-only
 * behavior; pass the destination project root at the automated trust-boundary
 * callers (template-updater, zone-copy, scaffold, sync-work) so the ancestor guard
 * is active on fleet:sync. Neither function creates parent directories — callers
 * already `mkdirSync`, and keeping that responsibility with the caller keeps these
 * two minimal.
 *
 * Residual (accepted): the ancestor guard is a static check; a live TOCTOU race that
 * swaps an ANCESTOR to a symlink between the check and the open is not closed (that
 * needs per-component openat(O_NOFOLLOW), disproportionate machinery for a local
 * automated sync with no concurrent adversary). The leaf race IS closed by O_NOFOLLOW.
 *
 * HOOK STATE WRITES (L1H, review C1 part 2). Hooks run OUTSIDE any sandbox, and a hook's state
 * file lives under `docs/.output/.state/`, which is gitignored and so is whatever the working tree
 * says it is. A symlink planted there (`memory-daily/<date>.md -> ~/.bashrc`, or `.state` itself
 * pointing out of the tree) turned an ordinary append into an arbitrary write outside the
 * checkout. The append / mkdir / atomic-write family below closes the same two holes for hook
 * state: every ancestor between the file and the project root is `lstat`-checked and the leaf is
 * opened with O_NOFOLLOW (and lstat-checked, so Windows, which has no O_NOFOLLOW, refuses too).
 * Their `containRoot` argument is OPTIONAL and DERIVES the root when omitted: the directory above
 * the first `docs/.output` segment of the path (`stateContainRoot`), or no ancestor guard when
 * the path has no such segment (the leaf guard still applies). Pass `null` to opt out and an
 * explicit root to pin it. A refused write throws an error that `isRefusal` recognizes;
 * hook callers catch it, call `reportRefusal` (one stderr line) and skip the write: hooks are
 * fail-soft for state, never blocked and never crashed by a refused write.
 *
 * Never calls process.cwd(). All paths are explicit arguments.
 *
 * @module fs-safe
 */

'use strict';

const fs = require('fs');
const path = require('path');

// A refusal is marked by a property, NOT by `error.code`: other callers print `error.code` (fleet's failed-prune
// list, ship-check's reasons), and the refusals they already raise must keep reading as before.
function refusal(message) {
    const error = new Error(message);
    error.fsSafeRefusal = true;
    return error;
}

/** True for an error thrown by a refusal of this module (a symlinked ancestor or leaf, an escaping path). */
function isRefusal(error) {
    return Boolean(error) && error.fsSafeRefusal === true;
}

/**
 * The fail-soft report for a hook: when `error` is a refusal, write ONE line to stderr and return true
 * (the caller skips the write); any other error returns false so the caller keeps its own handling.
 */
function reportRefusal(error, stream = process.stderr) {
    if (!isRefusal(error)) return false;
    try { stream.write(`[fs-safe] state write skipped: ${String(error.message).split('\n')[0]}\n`); } catch { /* stderr closed */ }
    return true;
}

/**
 * Refuse the write if any existing directory strictly between `path.dirname(dstPath)`
 * and `containRoot` (walking UP, NOT including `containRoot` or anything above it) is
 * a symbolic link. Also refuses when `dstPath` is not contained within `containRoot`
 * at all. No-op when `containRoot` is falsy.
 *
 * @param {string} dstPath
 * @param {string} [containRoot]
 * @throws {Error} when a symlinked ancestor is found, or dstPath escapes containRoot
 */
function assertNoSymlinkedAncestor(dstPath, containRoot) {
    assertNoSymlinkedDirs(path.dirname(dstPath), dstPath, containRoot);
}

/** The shared walk: `startDir` and every directory above it, up to (not including) `containRoot`. */
function assertNoSymlinkedDirs(startDir, dstPath, containRoot) {
    if (!containRoot) return;
    const root = path.resolve(containRoot);
    let dir = path.resolve(startDir);
    const chain = [];
    // Collect ancestors from the leaf's parent up to (but not including) root.
    while (dir !== root && dir !== path.dirname(dir)) {
        chain.push(dir);
        dir = path.dirname(dir);
    }
    if (dir !== root) {
        throw refusal(
            `fs-safe: refusing write — destination ${dstPath} is not contained within ${root}`
        );
    }
    for (const component of chain) {
        const st = fs.lstatSync(component, { throwIfNoEntry: false });
        if (st && st.isSymbolicLink()) {
            throw refusal(
                `fs-safe: refusing to write through symlinked ancestor directory ${component} ` +
                `(destination ${dstPath}, contained root ${root})`
            );
        }
    }
}

/**
 * If `dstPath` exists and is a symbolic link, unlink it (so a following write lands
 * on a real file at that path, not the link's target). Returns whether a symlink was
 * removed. A non-existent path or a regular file/dir is a no-op.
 *
 * @param {string} dstPath
 * @returns {boolean} true when an existing symlink was unlinked
 */
function unlinkIfSymlink(dstPath) {
    const st = fs.lstatSync(dstPath, { throwIfNoEntry: false });
    if (st && st.isSymbolicLink()) {
        fs.unlinkSync(dstPath);
        return true;
    }
    return false;
}

/**
 * Open flags for the hardened write: create/truncate for writing, plus O_NOFOLLOW
 * where the platform defines it (POSIX; absent on Windows) so a leaf symlink is
 * never followed by the open itself.
 *
 * @returns {number}
 */
function writeFlags() {
    let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;
    if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
    return flags;
}

/**
 * Write `data` to `dstPath` without ever following a symlink at the leaf OR at any
 * ancestor directory up to `containRoot`.
 *
 * @param {string} dstPath
 * @param {string|Buffer} data
 * @param {object|string} [options]   — passed through to fs.writeFileSync
 * @param {string} [containRoot]      — enable the symlinked-ancestor guard
 * @returns {{ symlinkReplaced: boolean }}
 */
function safeWrite(dstPath, data, options, containRoot) {
    assertNoSymlinkedAncestor(dstPath, containRoot);
    const symlinkReplaced = unlinkIfSymlink(dstPath);
    const mode = (options && typeof options === 'object' && options.mode != null)
        ? options.mode
        : 0o666;
    // O_NOFOLLOW leaf hardening: after unlinking any leaf symlink, open with
    // O_NOFOLLOW so a symlink re-created in the race window fails the open (ELOOP)
    // instead of being followed. Write through the fd, then close.
    const fd = fs.openSync(dstPath, writeFlags(), mode);
    try {
        fs.writeFileSync(fd, data, options);
    } finally {
        fs.closeSync(fd);
    }
    return { symlinkReplaced };
}

/**
 * Copy `srcPath` to `dstPath` without ever following a symlink at the leaf OR at any
 * ancestor directory up to `containRoot`. Implemented as read-source + symlink-safe
 * write so it shares safeWrite's leaf/ancestor hardening (template files are small
 * config/text, so the buffered copy is equivalent to a kernel copyFileSync here).
 *
 * @param {string} srcPath
 * @param {string} dstPath
 * @param {string} [containRoot]  — enable the symlinked-ancestor guard
 * @returns {{ symlinkReplaced: boolean }}
 */
function safeCopy(srcPath, dstPath, containRoot) {
    return safeWrite(dstPath, fs.readFileSync(srcPath), undefined, containRoot);
}

/**
 * Delete `dstPath` without ever following a symlinked ANCESTOR directory up to
 * `containRoot` (a prune/delete counterpart to safeWrite/safeCopy). `fs.rmSync`
 * on a symlinked LEAF already only unlinks the link itself (never follows it to
 * delete the target), so the residual hole this closes is an ancestor escape —
 * e.g. a mirror target's `skills -> /external` lets a naive `rmSync('skills/x')`
 * delete `/external/x`. `force: true` matches the historical prune behavior
 * (missing path is a no-op, not a throw).
 *
 * @param {string} dstPath
 * @param {string} [containRoot]  — enable the symlinked-ancestor guard
 */
function safeDelete(dstPath, containRoot) {
    assertNoSymlinkedAncestor(dstPath, containRoot);
    fs.rmSync(dstPath, { force: true });
}

/**
 * The project root a hook-state path lives under: the directory above the FIRST `docs/.output`
 * segment, or null when the path has none. First, not last: a deeper `docs/.output` that a working
 * tree planted inside the state folder must not shorten the chain that gets checked.
 *
 * @param {string} p an absolute path (or a path resolvable against the cwd)
 * @returns {string|null}
 */
function stateContainRoot(p) {
    const abs = path.resolve(p);
    const { root } = path.parse(abs);
    const segments = abs.slice(root.length).split(path.sep);
    for (let i = 0; i < segments.length - 1; i++) {
        if (segments[i] === 'docs' && segments[i + 1] === '.output') return path.join(root, ...segments.slice(0, i));
    }
    return null;
}

/** `containRoot` omitted means "derive it from the path"; null or '' means no ancestor guard. */
function resolveContainRoot(p, containRoot) {
    return containRoot === undefined ? stateContainRoot(p) : containRoot;
}

/**
 * Refuse an existing leaf that is a symlink, a FIFO or a device (a FIFO would block the open forever).
 * A missing leaf is fine. Exported for callers that open the file themselves (a SQLite database).
 *
 * @param {string} dstPath
 * @throws {Error} a refusal (see `isRefusal`)
 */
function assertSafeLeaf(dstPath) {
    const st = fs.lstatSync(dstPath, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isSymbolicLink()) throw refusal(`fs-safe: refusing to write through symlink ${dstPath}`);
    // A directory is an ordinary failure (the open reports EISDIR, nothing is written through it); a FIFO or a
    // device is refused, because opening one for writing can block the hook forever or write somewhere else.
    if (!st.isFile() && !st.isDirectory()) throw refusal(`fs-safe: refusing to write to ${dstPath}: it is not a regular file`);
}

/**
 * Open `dstPath` for appending (created when absent) and return the fd. Refuses a symlinked ancestor up
 * to the contain root, a symlinked or non-regular leaf, and opens with O_NOFOLLOW so a link swapped in
 * between the check and the open fails closed. The caller closes the fd. Never creates directories.
 *
 * @param {string} dstPath
 * @param {string|null} [containRoot] omitted: derived from the path (see the header)
 * @returns {number} fd
 * @throws {Error} a refusal (see `isRefusal`) when the ancestor, the leaf or the open is refused
 */
function safeOpenAppend(dstPath, containRoot) {
    assertNoSymlinkedAncestor(dstPath, resolveContainRoot(dstPath, containRoot));
    assertSafeLeaf(dstPath);
    let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND;
    if (fs.constants.O_NOFOLLOW) flags |= fs.constants.O_NOFOLLOW;
    try {
        return fs.openSync(dstPath, flags, 0o666);
    } catch (error) {
        if (error && error.code === 'ELOOP') throw refusal(`fs-safe: refusing to write through symlink ${dstPath}`);
        throw error;
    }
}

/**
 * Append `data` to `dstPath` without ever following a symlink at the leaf or at any ancestor up to the
 * contain root. A leaf symlink is REFUSED (never replaced): an append has no business creating a file in
 * a link's place. Does not create directories: use `safeMkdirp` first.
 *
 * @param {string} dstPath
 * @param {string|Buffer} data
 * @param {object|string} [options] passed to fs.writeFileSync
 * @param {string|null} [containRoot] omitted: derived from the path (see the header)
 */
function safeAppend(dstPath, data, options, containRoot) {
    const fd = safeOpenAppend(dstPath, containRoot);
    try {
        fs.writeFileSync(fd, data, options);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * `mkdir -p` that refuses to create or reuse a directory beneath a symlinked ancestor: the symlinked
 * ancestor check runs on `dir` itself and everything above it BEFORE the mkdir, so a `.state -> /elsewhere`
 * link never has a directory created inside its target.
 *
 * @param {string} dir
 * @param {string|null} [containRoot] omitted: derived from the path (see the header)
 */
function safeMkdirp(dir, containRoot) {
    assertNoSymlinkedDirs(dir, dir, resolveContainRoot(dir, containRoot));
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write `data` to `dstPath` through a temp file in the same directory and a rename (readers see the old
 * or the new content, never a partial file). Guards the ancestors, creates the parent with `safeMkdirp`,
 * and writes the temp file with `safeWrite` (O_NOFOLLOW). The rename replaces a leaf symlink instead of
 * following it, so a planted link at `dstPath` is displaced, never written through.
 *
 * @param {string} dstPath
 * @param {string|Buffer} data
 * @param {string|null} [containRoot] omitted: derived from the path (see the header)
 */
function safeWriteAtomic(dstPath, data, containRoot) {
    const root = resolveContainRoot(dstPath, containRoot);
    assertNoSymlinkedAncestor(dstPath, root);
    safeMkdirp(path.dirname(dstPath), root);
    const tmp = `${dstPath}.tmp-${process.pid}-${Date.now()}`;
    safeWrite(tmp, data, undefined, root);
    try {
        fs.renameSync(tmp, dstPath);
    } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        throw error;
    }
}

/**
 * Do two paths name the same directory? Git reports a directory's long form, and Node's JavaScript
 * realpath keeps 8.3 short names (a TEMP under the profile often has one), so both sides
 * are resolved natively; Windows paths compare case-insensitively. Throws when either path cannot be resolved.
 */
function sameRealDir(a, b) {
    const norm = p => { const r = fs.realpathSync.native(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
    return norm(a) === norm(b);
}

module.exports = {
    safeWrite, safeCopy, safeDelete, assertNoSymlinkedAncestor, sameRealDir,
    isRefusal, reportRefusal,
    stateContainRoot, assertSafeLeaf, safeOpenAppend, safeAppend, safeMkdirp, safeWriteAtomic,
};
