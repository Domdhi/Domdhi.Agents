/**
 * run-pointer — the one path, root and reader of a session's run pointer (SF-3.2, SF-3.3).
 *
 * `run-record.js start` writes `docs/.output/.state/telemetry/current-run-{session}.json`
 * (`{run_id, plan, wave, story, since}`) so every row writer in that session can join its
 * rows to the run. An environment variable cannot carry the id (the Bash tool keeps no shell
 * state), hence the file. Row writers (attribution-ledger, command-usage-logger, skill-usage-logger,
 * subagent-stop) call `readRunPointer` and spread the result onto the row when it is non-null;
 * run-record.js reads the full pointer through `readPointerFile`. There is no second reader.
 *
 * ONE ROOT FOR WRITER AND READERS. The Bash tool (where run-record.js runs) has no CLAUDE_PROJECT_DIR; hooks
 * do, and in a linked-worktree session it names the LINKED worktree. `resolveProjectRoot` would therefore
 * hand the writer the main worktree and the hooks the linked one: the pointer is written where the hooks never
 * look and every row goes unstamped, silently. `pointerRoot(hint)` removes the disagreement: it takes the
 * directory a caller already knows (CLAUDE_PROJECT_DIR, a resolved project root, or its own location) and
 * returns the MAIN worktree of that repository (the git common dir), or AGENT_SHARED_STATE_ROOT when set.
 * A linked worktree, its main worktree and the git common dir all give the same root. A non-git directory
 * is its own root (tests, standalone templates).
 *
 * This runs inside hooks that fire on every Bash and Skill call, so it must never throw and
 * never block:
 *   - the session id must match SESSION_RE (the same charset run-record.js writes), so a hostile
 *     id cannot traverse out of the telemetry folder;
 *   - the path is lstat-checked (a symlink is refused, never followed), opened O_NOFOLLOW and O_NONBLOCK and
 *     fstat-checked again for a regular file (a FIFO would otherwise block the open forever);
 *   - at most MAX_POINTER_BYTES are read; a larger file is treated as corrupt, not truncated;
 *   - the run id must match RUN_ID_RE (a 100-character cap), so a hostile pointer cannot copy a huge string onto
 *     every telemetry row;
 *   - a pointer untouched for MAX_POINTER_AGE_MS is stale (a run that was killed before `finish`, or a
 *     wrapper-path finish that could not name the session) and is ignored by the row writers. Every `wave`
 *     rewrites the pointer, so a live run keeps it fresh.
 *
 * Exports:
 *   readRunPointer({ root, session, now? })    -> { run_id: string, wave: number|null } | null  (row stamp; honours the TTL)
 *   readPointerFile({ root, session, maxAgeMs?, now? }) -> { run_id, plan, wave, story, since } | null  (full pointer)
 *   pointerRoot(hintDir, env?)                 -> absolute root the pointer lives under
 *   sourceDir(fallbackDir, env?)               -> the directory a CLI or hook hints pointerRoot with
 *   pointerFilePath(root, session), SESSION_RE, RUN_ID_RE, MAX_POINTER_BYTES, MAX_POINTER_AGE_MS
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getTelemetryDir } = require('./telemetry-paths');
const { resolveMainWorktree } = require('./project-root');

// Same charset as run-record.js SESSION_RE: the pointer file name is `current-run-{session}.json`.
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_POINTER_BYTES = 64 * 1024; // a pointer is under 1 KiB; the cap only bounds a hostile file
const MAX_POINTER_AGE_MS = 24 * 60 * 60 * 1000; // idle time after which a row writer ignores a pointer

/**
 * Absolute path of a session's pointer file. Does not validate the session; callers that read
 * go through readPointerFile / readRunPointer.
 * @param {string} root     Pointer root (see pointerRoot).
 * @param {string} session  Session id.
 * @returns {string}
 */
function pointerFilePath(root, session) {
    return path.join(getTelemetryDir(root), `current-run-${session}.json`);
}

/**
 * The directory that hints pointerRoot for a caller with no project root of its own (a CLI): the neutral
 * source override (AGENTS_PROJECT_DIR, AGENT_SOURCE_ROOT, CODEX_PROJECT_DIR), else CLAUDE_PROJECT_DIR, else
 * the caller's own location. Same override order as `resolveProjectRoot` / `resolveWorktreeRoot`.
 * @param {string} fallbackDir  The caller's `path.resolve(__dirname, ...)` repo location.
 * @param {object} [env]        Defaults to process.env.
 * @returns {string}
 */
function sourceDir(fallbackDir, env = process.env) {
    const explicit = env.AGENTS_PROJECT_DIR || env.AGENT_SOURCE_ROOT || env.CODEX_PROJECT_DIR || env.CLAUDE_PROJECT_DIR;
    return path.resolve(explicit || fallbackDir);
}

/**
 * The root a run pointer is written and read under: AGENT_SHARED_STATE_ROOT, else the MAIN worktree of the
 * repository containing `hintDir`, else `hintDir` itself (not a git repository). Never throws.
 * @param {string} hintDir  A directory inside the project (a linked worktree top, a resolved root, ...).
 * @param {object} [env]    Defaults to process.env.
 * @returns {string}
 */
function pointerRoot(hintDir, env = process.env) {
    if (env.AGENT_SHARED_STATE_ROOT) return path.resolve(env.AGENT_SHARED_STATE_ROOT);
    const hint = path.resolve(hintDir);
    try {
        // A `.git` DIRECTORY marks a main worktree top: no need to spawn git for the common case.
        if (fs.statSync(path.join(hint, '.git')).isDirectory()) return hint;
    } catch { /* no .git here: ask git */ }
    return resolveMainWorktree(hint) || hint;
}

/**
 * Read the session's full run pointer. Never throws.
 *
 * @param {object} opts
 * @param {string} opts.root         Pointer root (see pointerRoot).
 * @param {string} opts.session      Session id.
 * @param {number} [opts.maxAgeMs]   Idle limit in ms (default MAX_POINTER_AGE_MS; Infinity disables it).
 * @param {Date}   [opts.now]        Clock for the idle check (default now).
 * @returns {{run_id: string, plan: string|null, wave: number|null, story: string|null, since: string|null}|null}
 *   null when the session is missing or unsafe, or the pointer is absent, unreadable, not a regular file,
 *   over the cap, stale, corrupt, or has no valid run id.
 */
function readPointerFile(opts) {
    let fd;
    try {
        const root = opts && opts.root;
        const session = opts && opts.session;
        if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
        if (typeof session !== 'string' || !SESSION_RE.test(session)) return null;

        const file = pointerFilePath(root, session);
        const pre = fs.lstatSync(file);
        if (!pre.isFile()) return null; // symlink, directory, FIFO, device: refused before any open
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > MAX_POINTER_BYTES) return null; // a swap after lstat, or oversized

        const maxAge = opts.maxAgeMs === undefined ? MAX_POINTER_AGE_MS : opts.maxAgeMs;
        const nowMs = opts.now instanceof Date ? opts.now.getTime() : Date.now();
        if (Number.isFinite(maxAge) && nowMs - st.mtimeMs > maxAge) return null; // stale

        const buf = Buffer.alloc(st.size);
        let offset = 0;
        while (offset < st.size) {
            const n = fs.readSync(fd, buf, offset, st.size - offset, offset);
            if (n <= 0) break;
            offset += n;
        }
        const parsed = JSON.parse(buf.toString('utf8', 0, offset));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        if (typeof parsed.run_id !== 'string' || !RUN_ID_RE.test(parsed.run_id)) return null;
        return {
            run_id: parsed.run_id,
            plan: typeof parsed.plan === 'string' ? parsed.plan : null,
            wave: typeof parsed.wave === 'number' && Number.isFinite(parsed.wave) ? parsed.wave : null,
            story: typeof parsed.story === 'string' ? parsed.story : null,
            since: typeof parsed.since === 'string' ? parsed.since : null,
        };
    } catch {
        return null; // absent, unreadable or corrupt: the row stays as it was
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
}

/**
 * Read the session's run pointer and reduce it to the two row-stamp fields.
 *
 * @param {object} opts
 * @param {string} opts.root     Pointer root the row is written under (see pointerRoot).
 * @param {string} opts.session  Session id (same source the row's session_id uses).
 * @param {Date}   [opts.now]    Clock for the idle check.
 * @returns {{run_id: string, wave: number|null}|null}  null for everything readPointerFile refuses, plus a
 *   stale pointer. `wave` is the pointer's finite number, else null.
 */
function readRunPointer(opts) {
    const pointer = readPointerFile(opts);
    return pointer ? { run_id: pointer.run_id, wave: pointer.wave } : null;
}

module.exports = {
    readRunPointer, readPointerFile, pointerRoot, sourceDir, pointerFilePath,
    SESSION_RE, RUN_ID_RE, MAX_POINTER_BYTES, MAX_POINTER_AGE_MS,
};
