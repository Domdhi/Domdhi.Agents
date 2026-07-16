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
 * Never calls process.cwd(). All paths are explicit arguments.
 *
 * @module fs-safe
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
    if (!containRoot) return;
    const root = path.resolve(containRoot);
    let dir = path.resolve(path.dirname(dstPath));
    const chain = [];
    // Collect ancestors from the leaf's parent up to (but not including) root.
    while (dir !== root && dir !== path.dirname(dir)) {
        chain.push(dir);
        dir = path.dirname(dir);
    }
    if (dir !== root) {
        throw new Error(
            `fs-safe: refusing write — destination ${dstPath} is not contained within ${root}`
        );
    }
    for (const component of chain) {
        const st = fs.lstatSync(component, { throwIfNoEntry: false });
        if (st && st.isSymbolicLink()) {
            throw new Error(
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

module.exports = { safeWrite, safeCopy, safeDelete, assertNoSymlinkedAncestor };
