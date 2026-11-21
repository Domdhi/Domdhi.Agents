#!/usr/bin/env node
'use strict';

/**
 * run-record.js — a run's id, session pointer, result and exit codes (SF-3.1).
 *
 * A /do or /run-todo run gets an id (the start time's stamp plus the command and input slug; pass --run-id to
 * reuse a plan's own stamp), a per-session pointer that the telemetry row writers read (SF-3.2, SF-3.3), and a
 * machine-readable result that a scheduler or wrapper can judge without a human (SF-3.6, SF-3.8). The Bash tool
 * keeps no shell state, so the pointer is a file under the telemetry folder, not an environment variable.
 *
 * One root for writer and readers: the pointer lives under `pointerRoot()` of `_lib/run-pointer.js` (the main
 * worktree), which every row writer (hooks, attribution-ledger) resolves the same way. The Bash tool has no
 * CLAUDE_PROJECT_DIR and the hooks do, so a root derived from the environment would split a linked-worktree
 * session in two. The pointer path and the reader are `_lib/run-pointer.js`'s; this file has no copy.
 *
 * Session id source. Claude: `CLAUDE_CODE_SESSION_ID` (the Bash tool and the hooks both see it; a hook falls
 * back to the payload's `session_id`). Codex: NO verified session-id environment variable exists in this
 * repository, so under `.codex/core/run-record.js` the caller MUST pass `--session` with the same id the Codex
 * hook payload's `session_id` carries, or the hooks never match the pointer (start refuses without one). This is
 * a documented limit, not a runtime-aware helper (SF-3.6: the headless wrapper owns passing it).
 *
 * Concurrency. Writers of one run file (`wave`, `finish`) take a short lock (`runs/{runId}.lock`, created
 * exclusively, stale after 15 s) around their read-modify-write, so parallel `wave` calls never lose a wave.
 * `finish` refuses to change a recorded result: a second `finish` with the same status is an idempotent retry
 * (it rewrites the record and repairs a plan line a failed first call did not write); a different status is
 * refused with exit 2. The plan line is only ever written to `docs/.output/plans/*.md`.
 *
 * Failure kinds: every refusal is exit 2 (the seam fixes the codes), and `errors[0].kind` says why:
 * `invalid-input` (a validation refusal) or `io` (a write or read fault after validation, e.g. a full disk).
 * A retry after an `io` fault is safe: `finish` is idempotent for the same status.
 *
 * `passed` is judged on the record, not on exit 0 alone: for a /do or /run-todo run `finish --status passed`
 * requires `--commit`, `--receipt` and `--ship-token` (a self-report with the proof missing is refused), and
 * SF-3.6 and SF-4.1 judge the record's `ship_token` and `commit`. `--receipt none` is the spelling for "no gate
 * receipt": an audited SKIP commit has none, and so does a summary-mode OK commit (the committed gate config sets
 * `shipCheck.requireReceipt: false`, so the ship seal carries `mode: summary` and `receiptId: null`; the seal on disk
 * is what `finish` checks, never the caller's word).
 *
 * `--ship-token OK` is not taken on the caller's word: the commit named by `--commit` (HEAD when none is named) must carry
 * the `Ship-Check: <12 hex>` trailer that `commit.js --ship-check` writes on a passing check (_lib/git.js), or
 * `finish` refuses (exit 2). A commit made with a plain `git commit -F`, or with commit.js without the flag, has none, so
 * it cannot be recorded as ship-checked; the scoreboard reports run commits that lack it. `--ship-token SKIP` keeps the
 * audited `Ship-Check-Skip` trailer's own record and is not affected.
 *
 * `nothing-to-do` (exit 0, like passed) is the result of a run that found no work (the release slice is complete, or
 * every story is already done): it ships nothing, so it takes no `--commit`, `--receipt` or `--ship-token`, and it is
 * refused for a run that recorded a wave (a run that dispatched work is passed, failed or a stop). Its record has
 * `commit`, `receipt` and `ship_token` null, which is how a wrapper tells it from `passed`.
 *
 *   start   open a run: runs/{runId}.json and current-run-{session}.json
 *   wave    move the pointer to a wave and record the wave on the run
 *   finish  write the result, keep one `**Run record:** {json}` line per run id in the plan, drop the pointer
 *   current print the session's pointer JSON, or the literal `null`
 *
 * Exit codes (finish): 0 passed or nothing-to-do, 1 failed, 10 needs-human, 11 blocked, 12 budget-exhausted, 13 killed; 2 is
 * invalid input everywhere (gate.js uses 3 for a held lock, hence the 10+ block). Every export returns
 * `{ exitCode, ... }` and never throws; every refusal is `{ exitCode: 2, errors: [{ rule, message }] }`.
 *
 * Reuse, not re-implementation: the run stamp is `_lib/run-stamp.js`, the budget shape is `parseBudget` from
 * `_lib/failure-ledger.js` (the only budget parser), derived counts read the failure ledger and the
 * attribution ledger through their own readers, and writes follow ship-check.js (ancestor-symlink guard,
 * temp file and rename). Retention: run files are kept indefinitely (a few hundred bytes each, the scoreboard
 * reads them, cleanup-logs.js prunes only telemetry/logs); this module prunes nothing.
 *
 * CLI: node run-record.js start|wave|finish|current [flags]  (flags listed in FLAGS below)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stamp } = require('./_lib/run-stamp');
const { parseBudget, readLedger, getLedgerPath, parseStamp, dayStamps, isKilled } = require('./_lib/failure-ledger');
const { readAttribution, ledgerFilename } = require('./_lib/attribution-ledger');
const { getTelemetryDir, getJsonlPath } = require('./_lib/telemetry-paths');
const { assertNoSymlinkedAncestor } = require('./_lib/fs-safe');
const { resolveWorktreeRoot } = require('./_lib/project-root');
const { readShipTrailers, SHIP_CHECK_KEY } = require('./_lib/git');
const { SESSION_RE, RUN_ID_RE, pointerFilePath, pointerRoot, sourceDir, readPointerFile } = require('./_lib/run-pointer');

// ── constants ───────────────────────────────────────────────────────

const COMMANDS = new Set(['do', 'run-todo']);
/** status -> process exit code (a Map: a status like `constructor` must not resolve through the prototype). */
const STATUS_EXIT = new Map([
    ['passed', 0], ['nothing-to-do', 0], ['failed', 1], ['needs-human', 10], ['blocked', 11], ['budget-exhausted', 12], ['killed', 13],
]);
const STOP_STATUSES = new Set(['blocked', 'needs-human', 'budget-exhausted', 'killed']);
const SHIP_TOKENS = new Set(['OK', 'SKIP']);
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const RECEIPT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RECORD_PREFIX = '**Run record:**';
const SEAL_FILE = 'ship-seal.json'; // ship-check.js writes it under the telemetry folder
const MAX_SLUG = 60; // keeps `{stamp}-{command}-{slug}` plus a collision suffix inside the 100-character run id limit
const MAX_INPUT = 200;
const MAX_STORY = 500;
const MAX_COLLISIONS = 1000;
const MAX_JSON_BYTES = 256 * 1024; // run file and pointer
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_BYTES = 16 * 1024 * 1024;
const PLAN_PATH_RE = /^docs\/\.output\/plans\/[^/]+\.md$/; // the only files `--plan` may name (and finish may rewrite)
const LOCK_STALE_MS = 15000;
const LOCK_WAIT_MS = 10000;

// ── plain helpers ───────────────────────────────────────────────────

class Refusal extends Error {}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = (message) => { throw new Refusal(message); };
const clip = (text, max = 300) => String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').slice(0, max);
/** `kind` says why exit 2 was returned: `invalid-input` (validation) or `io` (a read or write fault after validation). */
const failResult = (rule, message) => ({ exitCode: 2, errors: [{ rule, kind: rule === 'invalid-args' ? 'invalid-input' : 'io', message }] });

/** Run `fn(opts)`; a Refusal is `invalid-args` (kind invalid-input), anything else `exception` (kind io). Never throws. */
function guarded(fn, opts) {
    try {
        return fn(isPlain(opts) ? opts : {});
    } catch (error) {
        if (error instanceof Refusal) return failResult('invalid-args', error.message);
        return failResult('exception', `run-record failed: ${clip(error && error.message, 200) || 'unknown failure'}`);
    }
}

function requireRoot(opts) {
    if (typeof opts.root !== 'string' || !opts.root || !path.isAbsolute(opts.root)) refuse('root must be an absolute project path');
    return opts.root;
}

/** A session id, or null when absent and not required. A session id is a filename component, so it is validated. */
function sessionOf(opts, required) {
    const session = opts.session;
    if (session === undefined || session === null || session === '') {
        if (required) refuse('a session id is required (--session, or the CLAUDE_CODE_SESSION_ID environment variable)');
        return null;
    }
    if (typeof session !== 'string' || !SESSION_RE.test(session)) refuse('session id must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}');
    return session;
}

function nowOf(opts) {
    return opts.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
}

/** A reported counter: a non-negative safe integer, or null when not given. */
function counterOf(value, label) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuse(`${label} must be a non-negative integer`);
    return value;
}

function slugOf(input) {
    return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG).replace(/-+$/, '');
}

/** `YYMMDD-HHMM` (local) -> Date, or null when it is not a real date (failure-ledger's parser, which throws). */
function parseSince(value) {
    if (typeof value !== 'string') return null;
    try { return parseStamp(value); } catch { return null; }
}

function timeOf(value) {
    if (typeof value !== 'string') return null;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

// ── paths and files ─────────────────────────────────────────────────

const runFilePath = (root, runId) => path.join(getTelemetryDir(root), 'runs', `${runId}.json`);
const lockFilePath = (root, runId) => path.join(getTelemetryDir(root), 'runs', `${runId}.lock`);
const pointerPath = pointerFilePath; // one path, defined in _lib/run-pointer.js

/** A bounded read of an ordinary, non-symlinked file: `{state:'ok', bytes}`, `{state:'missing'}` or `{state:'bad'}`. */
function readBounded(file, maxBytes) {
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
        return { state: error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'bad' };
    }
    if (!stat.isFile() || stat.size > maxBytes) return { state: 'bad' };
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        if (!fs.fstatSync(fd).isFile()) return { state: 'bad' };
        return { state: 'ok', bytes: fs.readFileSync(fd) };
    } catch {
        return { state: 'bad' };
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to release */ } }
    }
}

/** `{state:'ok', value}` | `{state:'missing'}` | `{state:'bad'}` (unreadable, oversize, not a regular file or not JSON). */
function readJsonFile(file) {
    const read = readBounded(file, MAX_JSON_BYTES);
    if (read.state !== 'ok') return read;
    try { return { state: 'ok', value: JSON.parse(read.bytes.toString('utf8')) }; } catch { return { state: 'bad' }; }
}

/** Write through an unpredictable temp name and a rename: a leaf symlink is replaced, never followed. */
function writeAtomic(root, file, text, mode) {
    assertNoSymlinkedAncestor(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, text, mode === undefined ? { flag: 'wx' } : { flag: 'wx', mode });
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* the original error is the one to report */ }
        throw error;
    }
}

/**
 * Create `file` only when it does not exist (a symlink at the path counts as existing). Returns false when it
 * exists. The content is written to a temp file and hard-linked into place, so a concurrent reader sees the
 * whole file or no file, never an empty one; a filesystem without hard links falls back to an exclusive write.
 */
function createExclusive(root, file, text) {
    assertNoSymlinkedAncestor(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    try {
        fs.linkSync(tmp, file);
        return true;
    } catch (error) {
        if (error && error.code === 'EEXIST') return false;
        try {
            fs.writeFileSync(file, text, { flag: 'wx' });
            return true;
        } catch (fallback) {
            if (fallback && fallback.code === 'EEXIST') return false;
            throw fallback;
        }
    } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* a stray temp file is harmless */ }
    }
}

const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available: spin on the next try */ } };

/**
 * Run `fn` holding the run's lock (`runs/{runId}.lock`, created exclusively). A lock older than LOCK_STALE_MS is
 * a crashed writer's and is broken; a lock that stays held for LOCK_WAIT_MS is an `io` failure, not a hang.
 */
function withRunLock(root, runId, fn) {
    const file = lockFilePath(root, runId);
    assertNoSymlinkedAncestor(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
            break;
        } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
            let age;
            try { age = Date.now() - fs.lstatSync(file).mtimeMs; } catch { continue; } // released meanwhile: try again
            if (age > LOCK_STALE_MS) { try { fs.rmSync(file, { force: true }); } catch { /* another waiter broke it */ } continue; }
            if (Date.now() > deadline) throw new Error(`run ${runId} is locked by another writer`);
            sleepMs(5 + Math.floor(Math.random() * 20));
        }
    }
    try {
        return fn();
    } finally {
        try { fs.rmSync(file, { force: true }); } catch { /* the stale rule reclaims it */ }
    }
}

const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

function isRegularFile(file) {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Parsed object rows of the newest bytes of a JSONL file; null when it is absent or not a regular file. */
function readJsonlRows(file) {
    let fd;
    try {
        if (!fs.statSync(file).isFile()) return null;
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile()) return null;
        const len = Math.min(st.size, MAX_JSONL_BYTES);
        const start = st.size - len;
        const buf = Buffer.alloc(len);
        let offset = 0;
        while (offset < len) {
            const n = fs.readSync(fd, buf, offset, len - offset, start + offset);
            if (n <= 0) break;
            offset += n;
        }
        let text = buf.toString('utf8', 0, offset);
        if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
        const rows = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (isPlain(parsed)) rows.push(parsed);
            } catch { /* corrupt line */ }
        }
        return rows;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to release */ } }
    }
}

// ── plan path containment ───────────────────────────────────────────

const isInside = (root, target) => {
    const rel = path.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** The real path of `target` through its deepest existing ancestor; null when unresolvable. */
function realDeepest(target) {
    let existing = path.resolve(target);
    const missing = [];
    for (;;) {
        try { return path.join(fs.realpathSync(existing), ...missing.reverse()); } catch {
            const parent = path.dirname(existing);
            if (parent === existing) return null;
            missing.push(path.basename(existing));
            existing = parent;
        }
    }
}

/**
 * A plan path resolved against `cwd`: `{ rel, real }` (rel is repo-relative with forward slashes). `finish` REWRITES
 * this file, so it is held to the one place plans live: an existing regular file whose repo-relative path matches
 * PLAN_PATH_RE (`docs/.output/plans/*.md`) under one of `roots` (the worktree top and the main worktree), reached
 * without a symlink at the leaf; a leaf or ancestor symlink that resolves elsewhere is refused by the same rule.
 */
function resolvePlan(roots, cwd, raw) {
    if (typeof raw !== 'string' || !raw.trim() || /[\0\r\n]/.test(raw)) refuse('plan must be a path to an existing plan file inside the repository');
    const leaf = path.resolve(cwd, raw);
    const real = realDeepest(leaf);
    let rel = null;
    for (const root of roots) {
        let realRoot;
        try { realRoot = fs.realpathSync(root); } catch { continue; }
        if (real && isInside(realRoot, real)) { rel = path.relative(realRoot, real).split(path.sep).join('/'); break; }
    }
    if (rel === null) refuse('plan must be inside the repository');
    if (!PLAN_PATH_RE.test(rel)) refuse('plan must be a docs/.output/plans/*.md file');
    let stat;
    try { stat = fs.lstatSync(leaf); } catch { refuse('plan file does not exist'); }
    if (stat.isSymbolicLink()) refuse('plan must not be a symlink');
    if (!stat.isFile()) refuse('plan must be an existing regular file');
    return { rel, real };
}

// ── pointer and run file reads ──────────────────────────────────────

/** The session's pointer `{run_id, plan, wave, story, since}`, or null (absent, unreadable, corrupt or wrong shape). Never throws. No idle limit: the writer can always finish its own run. */
function readPointer(opts) {
    if (!isPlain(opts)) return null;
    return readPointerFile({ root: opts.root, session: opts.session, maxAgeMs: Infinity });
}

/** Remove the session's pointer when it still names `runId` (another run's pointer is never removed). */
function dropPointer(root, session, runId) {
    const current = readPointer({ root, session });
    if (!current || current.run_id !== runId) return;
    const file = pointerPath(root, session);
    assertNoSymlinkedAncestor(file, root);
    fs.rmSync(file, { force: true });
}

/** Valid wave entries of a run file (`{wave, story, tsMs}`), or null when the file has no usable waves array. */
function waveEntries(run) {
    if (!isPlain(run) || !Array.isArray(run.waves)) return null;
    const entries = [];
    for (const w of run.waves) {
        if (!isPlain(w) || !Number.isInteger(w.wave)) continue;
        const tsMs = timeOf(w.ts);
        if (tsMs === null) continue;
        entries.push({ wave: w.wave, story: typeof w.story === 'string' ? w.story : null, tsMs });
    }
    return entries;
}

/** True when the ship seal on disk is a summary-mode seal: `mode: summary` and no receipt id (ship-check.js, requireReceipt false). */
function summarySealed(root) {
    const read = readJsonFile(path.join(getTelemetryDir(root), SEAL_FILE));
    return read.state === 'ok' && isPlain(read.value) && read.value.mode === 'summary' && read.value.receiptId === null;
}

// ── start ───────────────────────────────────────────────────────────

function start(opts) {
    return guarded((o) => {
        const root = requireRoot(o);
        const session = sessionOf(o, true);
        if (typeof o.command !== 'string' || !COMMANDS.has(o.command)) refuse('command must be one of: do, run-todo');
        if (typeof o.input !== 'string' || !o.input.trim()) refuse('input must be a non-empty string');
        const input = o.input.trim();
        if (input.length > MAX_INPUT || /[\0-\x1f\x7f]/.test(input)) refuse(`input must be at most ${MAX_INPUT} characters without control characters`);
        const explicit = o.runId !== undefined && o.runId !== null;
        if (explicit && (typeof o.runId !== 'string' || !RUN_ID_RE.test(o.runId))) refuse('run id must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}');
        let budget = null;
        if (o.budget !== undefined && o.budget !== null) {
            try { budget = parseBudget(o.budget); } catch (error) { refuse(`budget: ${clip(error && error.message, 200)}`); }
        }
        const now = nowOf(o);
        const since = stamp(now);
        let base = null;
        if (!explicit) {
            const slug = slugOf(input);
            if (!slug) refuse('input must contain at least one letter or digit');
            base = `${since}-${o.command}-${slug}`;
        }

        const run = (runId) => jsonText({
            run_id: runId, command: o.command, input, session_id: session, budget, since, started_at: now.toISOString(), waves: [],
        });
        let runId = null;
        if (explicit) {
            if (!createExclusive(root, runFilePath(root, o.runId), run(o.runId))) refuse(`run ${o.runId} already exists`);
            runId = o.runId;
        } else {
            for (let n = 1; n <= MAX_COLLISIONS && runId === null; n++) {
                const candidate = n === 1 ? base : `${base}-${n}`;
                if (createExclusive(root, runFilePath(root, candidate), run(candidate))) runId = candidate;
            }
            if (runId === null) refuse(`no free run id after ${MAX_COLLISIONS} tries`);
        }

        // Starting over an unfinished run in this session replaces its pointer: say so instead of doing it silently.
        const warnings = [];
        const prior = readPointer({ root, session });
        if (prior && prior.run_id !== runId) {
            const priorRun = readJsonFile(runFilePath(root, prior.run_id));
            if (priorRun.state === 'ok' && isPlain(priorRun.value) && !isPlain(priorRun.value.result)) {
                warnings.push(`replaced the pointer of unfinished run ${prior.run_id} in session ${session}`);
            }
        }
        try {
            writeAtomic(root, pointerPath(root, session), `${JSON.stringify({ run_id: runId, plan: null, wave: null, story: null, since })}\n`);
        } catch (error) {
            try { fs.rmSync(runFilePath(root, runId), { force: true }); } catch { /* the pointer error is the one to report */ }
            throw error;
        }
        const started = { exitCode: 0, run_id: runId, since };
        if (warnings.length) started.warnings = warnings;
        return started;
    }, opts);
}

// ── wave ────────────────────────────────────────────────────────────

function wave(opts) {
    return guarded((o) => {
        const root = requireRoot(o);
        const session = sessionOf(o, true);
        if (!Number.isSafeInteger(o.wave) || o.wave < 1) refuse('wave must be a positive integer');
        let story = null;
        if (o.story !== undefined && o.story !== null && o.story !== '') {
            if (typeof o.story !== 'string' || o.story.length > MAX_STORY || /[\0-\x1f\x7f]/.test(o.story)) refuse(`story must be a string of at most ${MAX_STORY} characters without control characters`);
            story = o.story.trim() || null;
        }
        const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : root;
        const plan = o.plan === undefined || o.plan === null ? null : resolvePlan(planRootsOf(o, root), cwd, o.plan).rel;
        const now = nowOf(o);

        const pointer = readPointer({ root, session });
        if (!pointer) refuse(`no readable run pointer for session ${session}; run start first`);

        // The run file is a read-modify-write: hold the run's lock so parallel `wave` calls each keep their wave.
        return withRunLock(root, pointer.run_id, () => {
            const warnings = [];
            const file = runFilePath(root, pointer.run_id);
            const read = readJsonFile(file);
            // A /run-todo wave names its stories, or the run's story count comes out short (first adopter run, 2026-11-20);
            // an ad-hoc /do has no story and drops --story.
            if (o.storyRequiredForRunTodo && !story && read.state === 'ok' && isPlain(read.value) && read.value.command === 'run-todo') refuse('a run-todo wave requires --story "{wave story IDs}"');
            if (read.state === 'ok' && isPlain(read.value) && Array.isArray(read.value.waves)) {
                const run = { ...read.value, waves: [...read.value.waves, { wave: o.wave, story, ts: now.toISOString() }] };
                writeAtomic(root, file, jsonText(run));
            } else {
                warnings.push(`run file for ${pointer.run_id} is ${read.state === 'missing' ? 'missing' : 'unreadable'}; only the pointer was updated`);
            }
            const next = { run_id: pointer.run_id, plan: plan === null ? pointer.plan : plan, wave: o.wave, story, since: pointer.since };
            writeAtomic(root, pointerPath(root, session), `${JSON.stringify(next)}\n`);
            const result = { exitCode: 0, run_id: next.run_id, wave: next.wave, story: next.story, plan: next.plan };
            if (warnings.length) result.warnings = warnings;
            return result;
        });
    }, opts);
}

/** The roots a plan may live under: an explicit `planRoots` list (the CLI passes the worktree top), then the state root. */
function planRootsOf(o, root) {
    const given = Array.isArray(o.planRoots) ? o.planRoots.filter((r) => typeof r === 'string' && path.isAbsolute(r)) : [];
    return [...new Set([...given, root])];
}

// ── finish: derived fields ──────────────────────────────────────────

const field = (value, source) => ({ value, source });

/** PostToolUse `agent_dispatch` rows of this run at or after sinceMs across the row roots, or null when no file exists. */
function hookLaunches(roots, runId, sinceMs) {
    let count = null;
    for (const r of roots) {
        const rows = readJsonlRows(getJsonlPath(r, 'skill-usage.jsonl'));
        if (rows === null) continue;
        if (count === null) count = 0;
        for (const e of rows) {
            if (!isPlain(e) || e.type !== 'agent_dispatch' || e.hook_event_name === 'SubagentStop' || e.run_id !== runId) continue;
            const t = timeOf(e.timestamp);
            if (t !== null && t >= sinceMs) count++;
        }
    }
    return count;
}

/** Every derived count for a run; an absent or corrupt source gives null for the fields that depend on it. */
function derive({ root, rowRoots, runId, entries, sinceMs, now }) {
    const out = {};
    const roots = [...new Set([root, ...(rowRoots || [])])]; // hook rows land under the hook's own root: read every candidate

    const storyIds = new Set();
    if (entries) for (const e of entries) for (const id of (e.story || '').split(',')) if (id.trim()) storyIds.add(id.trim());
    out.waves = entries ? new Set(entries.map((e) => e.wave)).size : null;
    // A wave with no story list in any of its entries makes the count unknown, never a short count.
    const wavesWithStories = new Set(entries ? entries.filter((e) => e.story).map((e) => e.wave) : []);
    out.stories = entries && entries.every((e) => wavesWithStories.has(e.wave)) ? storyIds.size : null;

    let gateRuns = null;
    if (sinceMs !== null) {
        const sources = roots.map((r) => readJsonlRows(getJsonlPath(r, 'command-usage.jsonl'))).filter((rows) => rows !== null);
        if (sources.length) {
            gateRuns = sources.flat().filter((r) => {
                const t = timeOf(r.timestamp);
                return r.type === 'gate_run' && r.run_id === runId && t !== null && t >= sinceMs;
            }).length;
        }
    }
    out.gate_runs = gateRuns;

    let gateFailures = null;
    let firstPassGreen = null;
    if (sinceMs !== null && isRegularFile(getLedgerPath(root))) {
        const rows = readLedger({ root }).map((r) => ({ r, t: timeOf(r.ts) })).filter((x) => x.t !== null);
        gateFailures = rows.filter(({ r, t }) => t >= sinceMs && r.passed !== true && !isKilled(r)).length;
        if (entries) {
            const starts = [];
            const seen = new Set();
            for (const e of entries) if (!seen.has(e.wave)) { seen.add(e.wave); starts.push(e.tsMs); }
            firstPassGreen = 0;
            starts.forEach((windowStart, i) => {
                const windowEnd = i + 1 < starts.length ? starts[i + 1] : Infinity;
                const first = rows.find(({ r, t }) => t >= windowStart && t < windowEnd && !isKilled(r));
                if (first && first.r.passed === true) firstPassGreen++;
            });
        }
    }
    out.gate_failures = gateFailures;
    out.first_pass_green_waves = firstPassGreen;

    let dispatches = null;
    if (sinceMs !== null) {
        const sinceDate = new Date(sinceMs);
        const end = now.getTime() > sinceMs ? now : sinceDate;
        for (const day of dayStamps(sinceDate, end)) {
            for (const r of roots) {
                if (!isRegularFile(getJsonlPath(r, ledgerFilename(day)))) continue;
                if (dispatches === null) dispatches = 0;
                for (const e of readAttribution(day, { root: r })) {
                    const t = isPlain(e) ? timeOf(e.timestamp) : null;
                    if (t === null || t < sinceMs) continue;
                    if (typeof e.run_id === 'string' && e.run_id !== runId) continue; // another run's work in the same tree
                    dispatches++;
                }
            }
        }
    }
    // The attribution rows are appended by hand and can be skipped; the hook-written launch rows carry the run id too.
    // Take the larger, as the budget does (first adopter run, 2026-11-20: 18 derived against 39 launches).
    const launches = sinceMs === null ? null : hookLaunches(roots, runId, sinceMs);
    out.dispatches = dispatches === null ? launches : launches === null ? dispatches : Math.max(dispatches, launches);
    return out;
}

// ── finish: the plan line ───────────────────────────────────────────

/** Keep exactly one `**Run record:**` line for this run id: replace it in place, else append. Foreign and unparsable lines stay. */
function upsertPlanLine(real, runId, line) {
    const read = readBounded(real, MAX_PLAN_BYTES);
    if (read.state !== 'ok') refuse('plan cannot be read (missing, oversize or not a regular file)');
    const text = read.bytes.toString('utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split('\n');
    let replaced = false;
    const kept = [];
    for (const raw of lines) {
        const cr = raw.endsWith('\r') ? '\r' : '';
        const body = cr ? raw.slice(0, -1) : raw;
        let mine = false;
        if (body.startsWith(RECORD_PREFIX)) {
            try {
                const parsed = JSON.parse(body.slice(RECORD_PREFIX.length).trim());
                mine = isPlain(parsed) && parsed.run_id === runId;
            } catch { /* a malformed record line belongs to nobody: leave it */ }
        }
        if (!mine) kept.push(raw);
        else if (!replaced) { replaced = true; kept.push(`${line}${cr}`); }
        // a second line for the same run id is dropped: one line per run
    }
    let next;
    if (replaced) next = kept.join('\n');
    else if (text === '') next = `${line}\n`;
    else if (text.endsWith('\n')) next = `${text}${line}${eol}`;
    else next = `${text}${eol}${line}${eol}`;
    let mode;
    try { mode = fs.statSync(real).mode & 0o777; } catch { mode = undefined; }
    writeAtomic(path.dirname(real), real, next, mode);
}

// ── finish ──────────────────────────────────────────────────────────

function finish(opts) {
    return guarded((o) => {
        const root = requireRoot(o);
        const status = o.status;
        if (typeof status !== 'string' || !STATUS_EXIT.has(status)) refuse(`status must be one of: ${[...STATUS_EXIT.keys()].join(', ')}`);
        const exitCode = STATUS_EXIT.get(status);
        if (o.commit != null && (typeof o.commit !== 'string' || !COMMIT_RE.test(o.commit))) refuse('commit must be a 7 to 40 character hex sha');
        if (o.receipt != null && (typeof o.receipt !== 'string' || !RECEIPT_RE.test(o.receipt))) refuse('receipt must match [A-Za-z0-9._-]{1,64}');
        if (o.shipToken != null && (typeof o.shipToken !== 'string' || !SHIP_TOKENS.has(o.shipToken))) refuse('ship token must be OK or SKIP');
        if (status === 'passed') {
            // Exit 0 must mean shipped: a self-reported pass with the proof missing is refused, not recorded.
            const missing = [['commit', o.commit], ['receipt', o.receipt], ['ship-token', o.shipToken]].filter(([, v]) => v == null).map(([name]) => `--${name}`);
            if (missing.length) refuse(`a passed run needs ${missing.join(', ')} (commit, gate receipt and ship token are the proof of shipping)`);
        }
        if (status === 'nothing-to-do') {
            const given = [['commit', o.commit], ['receipt', o.receipt], ['ship-token', o.shipToken]].filter(([, v]) => v != null).map(([name]) => `--${name}`);
            if (given.length) refuse(`a nothing-to-do run ships nothing and takes no ${given.join(', ')}`);
        }
        // `--receipt none` is the one spelling for "no gate receipt": an audited SHIP_CHECK_SKIP commit has none, and so does
        // a summary-mode commit, which the ship seal on disk must confirm (a caller cannot claim summary mode by itself).
        if (o.receipt === 'none' && o.shipToken !== 'SKIP' && !(o.shipToken === 'OK' && summarySealed(root))) {
            refuse('--receipt none is allowed only with --ship-token SKIP (an audited skip has no receipt), or with --ship-token OK when the ship seal is in summary mode (receiptId null)');
        }
        // The token is a claim, the trailer is the proof: only a commit that went through a passing `commit.js --ship-check` has it.
        if (o.shipToken === 'OK') {
            const named = o.commit == null ? null : o.commit;
            const trailers = readShipTrailers(root, named);
            if (trailers.state !== 'ok') refuse(`--ship-token OK cannot be confirmed: ${trailers.reason}`);
            if (!trailers.shipCheck) {
                refuse(`--ship-token OK is refused: ${named === null ? 'HEAD' : `commit ${named}`} carries no ${SHIP_CHECK_KEY} trailer, so no passing ship check produced it. Commit with \`commit.js --ship-check\` (it writes the trailer), or record --ship-token SKIP when the audited skip applied`);
            }
        }
        const fixRounds = counterOf(o.fixRounds, 'fix rounds');
        const reviewMajor = counterOf(o.reviewMajor, 'review major');
        const misalignments = counterOf(o.misalignments, 'misalignments');
        const outputTokens = counterOf(o.outputTokens, 'output tokens');
        const cwd = typeof o.cwd === 'string' && o.cwd ? o.cwd : root;
        const planInfo = o.plan === undefined || o.plan === null ? null : resolvePlan(planRootsOf(o, root), cwd, o.plan);
        const now = nowOf(o);

        // Resolve the run: --run-id (its file must exist), else the session pointer.
        const session = sessionOf(o, o.runId === undefined || o.runId === null);
        let runId;
        let pointer = null;
        if (o.runId !== undefined && o.runId !== null) {
            if (typeof o.runId !== 'string' || !RUN_ID_RE.test(o.runId)) refuse('run id must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}');
            runId = o.runId;
        } else {
            pointer = readPointer({ root, session });
            if (!pointer) refuse(`no readable run pointer for session ${session}; pass --run-id or run start first`);
            runId = pointer.run_id;
        }
        const file = runFilePath(root, runId);

        // Everything is validated. Read, check and write the run file under the run's lock, then the plan line, then drop the pointers.
        const done = withRunLock(root, runId, () => {
            const read = readJsonFile(file);
            if (read.state === 'missing' && pointer === null) refuse(`run ${runId} does not exist`);
            const run = read.state === 'ok' && isPlain(read.value) ? read.value : null;
            if (status === 'nothing-to-do' && run && Array.isArray(run.waves) && run.waves.length) {
                refuse(`run ${runId} recorded ${run.waves.length} wave(s): a run that dispatched work finishes passed, failed or with a stop status, not nothing-to-do`);
            }
            const recorded = run && isPlain(run.result) && typeof run.result.status === 'string' ? run.result.status : null;
            if (recorded !== null && recorded !== status) {
                refuse(`run ${runId} already finished as ${recorded}; a recorded result is never overwritten (finish again with the same status to retry)`);
            }

            // The window is the run's own start instant, not the minute-floored stamp (which also swallows the minute before it).
            const sinceText = run && typeof run.since === 'string' ? run.since : (pointer ? pointer.since : null);
            const startedMs = run ? timeOf(run.started_at) : null;
            const sinceDate = parseSince(sinceText);
            const sinceMs = startedMs !== null ? startedMs : (sinceDate ? sinceDate.getTime() : null);
            const derived = derive({ root, rowRoots: o.rowRoots, runId, entries: waveEntries(run), sinceMs, now });

            const record = {
                run_id: runId,
                command: run && typeof run.command === 'string' ? run.command : null,
                input: run && typeof run.input === 'string' ? run.input : null,
                status,
                commit: o.commit == null ? null : o.commit,
                receipt: o.receipt == null || o.receipt === 'none' ? null : o.receipt,
                ship_token: o.shipToken == null ? null : o.shipToken,
                waves: field(derived.waves, 'derived'),
                stories: field(derived.stories, 'derived'),
                gate_runs: field(derived.gate_runs, 'derived'),
                gate_failures: field(derived.gate_failures, 'derived'),
                first_pass_green_waves: field(derived.first_pass_green_waves, 'derived'),
                fix_rounds: field(fixRounds, 'reported'),
                review_major: field(reviewMajor, 'reported'),
                dispatches: field(derived.dispatches, 'derived'),
                misalignments: field(misalignments, 'reported'),
                stops: field(STOP_STATUSES.has(status) ? 1 : 0, 'derived'),
                output_tokens: field(outputTokens, 'reported'),
            };
            const result = {
                status, exit_code: exitCode, commit: record.commit, receipt: record.receipt, ship_token: record.ship_token,
                plan: planInfo ? planInfo.rel : null, finished_at: now.toISOString(), record,
            };
            writeAtomic(root, file, jsonText({ ...(run || { run_id: runId }), result }));
            if (planInfo) upsertPlanLine(planInfo.real, runId, `${RECORD_PREFIX} ${JSON.stringify(record)}`);
            return { result, record, runSession: run && typeof run.session_id === 'string' ? run.session_id : null };
        });

        // The pointers of a finished run are gone: the calling session's, and the session the run was started under
        // (a wrapper that finishes by --run-id names no session of its own).
        const sessions = new Set();
        if (session) sessions.add(session);
        if (done.runSession && SESSION_RE.test(done.runSession)) sessions.add(done.runSession);
        for (const s of sessions) dropPointer(root, s, runId);
        return { exitCode, run_id: runId, status, plan: done.result.plan, record: done.record };
    }, opts);
}

// ── CLI ─────────────────────────────────────────────────────────────

const FLAGS = new Map([
    ['start', { flags: ['command', 'input', 'run-id', 'budget', 'session'], required: ['command', 'input'] }],
    ['wave', { flags: ['wave', 'story', 'plan', 'session'], required: ['wave'] }],
    ['finish', {
        flags: ['status', 'run-id', 'commit', 'plan', 'receipt', 'ship-token', 'fix-rounds', 'review-major', 'misalignments', 'output-tokens', 'session'],
        required: ['status'],
    }],
    ['current', { flags: ['session'], required: [] }],
]);

/** `{verb, flags}` or `{error}`. A flag's value is the next argument verbatim unless it starts with `--`. */
function parseArgs(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return { error: 'missing verb (start, wave, finish or current)' };
    const spec = FLAGS.get(argv[0]);
    if (!spec) return { error: `unknown verb "${clip(argv[0], 40)}" (start, wave, finish or current)` };
    const flags = {};
    for (let i = 1; i < argv.length; i += 2) {
        const token = argv[i];
        if (typeof token !== 'string' || !token.startsWith('--')) return { error: `unexpected argument "${clip(token, 40)}"` };
        const name = token.slice(2);
        if (!spec.flags.includes(name)) return { error: `unknown flag ${clip(token, 40)} for ${argv[0]}` };
        if (Object.prototype.hasOwnProperty.call(flags, name)) return { error: `flag ${token} given more than once` };
        const value = argv[i + 1];
        if (typeof value !== 'string' || value.startsWith('--')) return { error: `flag ${token} needs a value` };
        flags[name] = value;
    }
    for (const name of spec.required) if (!Object.prototype.hasOwnProperty.call(flags, name)) return { error: `${argv[0]} requires --${name}` };
    return { verb: argv[0], flags };
}

/** A CLI counter string -> number; anything that is not plain digits becomes NaN so the verb refuses it. */
const numberFlag = (value) => (value === undefined ? undefined : (/^\d+$/.test(value) ? Number(value) : NaN));

function emit(doc, exitCode, message) {
    try { process.stdout.write(`${JSON.stringify(doc)}\n`); } catch { /* a closed stdout must not change the exit code */ }
    if (exitCode === 2 && message) { try { process.stderr.write(`[run-record] refusing: ${message}\n`); } catch { /* same */ } }
}

function main(argv = process.argv.slice(2), env = process.env) {
    let doc;
    try {
        const parsed = parseArgs(argv);
        if (parsed.error) {
            doc = failResult('invalid-args', parsed.error);
        } else {
            const f = parsed.flags;
            const fallback = path.resolve(__dirname, '..', '..');
            // One root for the pointer, whichever process asks: the main worktree of the repository the caller hints at
            // (see _lib/run-pointer.js). A plan lives in the caller's own worktree top, which may be a linked worktree.
            const hint = sourceDir(fallback, env);
            const root = pointerRoot(hint, env);
            const worktreeTop = resolveWorktreeRoot(hint);
            const session = f.session !== undefined ? f.session : (env.CLAUDE_CODE_SESSION_ID || undefined);
            const base = { root, cwd: process.cwd(), session, now: new Date(), planRoots: [path.resolve(worktreeTop)], rowRoots: [path.resolve(worktreeTop)] };
            if (parsed.verb === 'start') {
                doc = start({ ...base, command: f.command, input: f.input, runId: f['run-id'], budget: f.budget });
            } else if (parsed.verb === 'wave') {
                doc = wave({ ...base, wave: numberFlag(f.wave), story: f.story, plan: f.plan, storyRequiredForRunTodo: true });
            } else if (parsed.verb === 'finish') {
                doc = finish({
                    ...base, status: f.status, runId: f['run-id'], commit: f.commit, plan: f.plan, receipt: f.receipt, shipToken: f['ship-token'],
                    fixRounds: numberFlag(f['fix-rounds']), reviewMajor: numberFlag(f['review-major']),
                    misalignments: numberFlag(f.misalignments), outputTokens: numberFlag(f['output-tokens']),
                });
            } else {
                const checked = guarded((o) => ({ session: sessionOf(o, true) }), base);
                doc = checked.exitCode === 2 && checked.errors ? checked : { exitCode: 0, pointer: readPointer({ root, session: checked.session }) };
            }
        }
    } catch (error) {
        doc = failResult('exception', `run-record failed: ${clip(error && error.message, 200) || 'unknown failure'}`);
    }
    const exitCode = doc.exitCode;
    // `current` prints the pointer itself (or the literal null), not a result wrapper.
    const printed = Object.prototype.hasOwnProperty.call(doc, 'pointer') ? doc.pointer : doc;
    emit(printed, exitCode, exitCode === 2 && doc.errors && doc.errors[0] ? doc.errors[0].message : null);
    return exitCode;
}

module.exports = { start, wave, finish, readPointer, main };
if (require.main === module) process.exitCode = main();
