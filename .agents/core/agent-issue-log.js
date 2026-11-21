#!/usr/bin/env node
'use strict';

/**
 * agent-issue-log.js — structured agent-issue rows in the day's human log (SF-4.2).
 *
 * `/do`, `/run-todo` and `/run-tests` used to hand-write a free-text section into
 * `docs/.output/evolution/agents/{YYYY-MM-DD}.md`, with no skill name, step id or failure signature, so the
 * intake had to guess the skill from prose. This helper appends one table row instead:
 *
 *   | Agent | Story | Skill | Step | Signature | Run | Issue | Fix Applied |
 *
 * under `## {date} — Wave N` (N from the session's run pointer; without a wave the heading is
 * `## {date} — {story}`, else `## {date} — Ad hoc`) and a `### Agent Issues` table, creating the file,
 * section or table when absent. Existing text never changes: a row goes after the last row of the section's
 * last structured table, and a section holding only a legacy table (or none) gets a new subsection at its end.
 * `skill-evolution.js intake` parses the rows back (it imports HEADER, so the column set is defined once).
 *
 * Reuse, not re-implementation: the run id, wave and story come from `_lib/run-pointer.js` (read under
 * `pointerRoot`, the same root the writer and the hooks use), the failure signature from the SF-1.5 ledger
 * through `_lib/failure-ledger.js` (`readLedger`, `isKilled`; corrupt lines are skipped by the reader), and the
 * write refuses a symlinked ancestor with `_lib/fs-safe.js`.
 *
 * Automatic signature scope (A-2): the newest non-killed ledger row supplies the signature only when it is a
 * failure AND belongs to this run: with a run pointer its `ts` must not be older than the pointer's `since`; with no
 * pointer (or one without a parsable `since`) it must be at most SIGNATURE_WINDOW_MS older than `now`. Anything older
 * is another session's failure and the cell is `-`. An explicit `--signature` always wins.
 *
 * Concurrency (A-1): the read-modify-write of the day's log runs under an exclusive lock file
 * (`docs/.output/.state/agent-issue-log-{date}.lock`, the run-record per-run lock pattern: `wx` create, bounded retry
 * with jitter, a lock older than LOCK_STALE_MS is a crashed writer's and is broken). A lock that stays held for
 * LOCK_WAIT_MS refuses with rule `busy`, never a silent success.
 *
 * Text cells: whitespace runs collapse to one space, every pipe is written `\|` and the backslashes right before a
 * pipe are doubled first (a run of n backslashes before a pipe becomes 2n+1), so a parity-aware splitter (an odd
 * backslash run escapes the pipe; decode n=2k+1 to k backslashes plus the pipe) round-trips every value. A cell
 * longer than MAX_CELL_CHARS is cut and ends with TRUNCATION_MARK.
 *
 * Every export returns `{ exitCode, ... }` and never throws. A refusal is `{ exitCode: 2, errors: [{ rule,
 * message }] }` and writes nothing; rules: invalid-args, unknown-skill, unsafe-path, busy, exception.
 *
 * CLI: node agent-issue-log.js add --skill <dir> --step <id> --agent <role> --issue <text> --fix <text>
 *                                  [--signature <hash>] [--story <ID>] [--session <id>]
 * A flag's value is the next argv element verbatim unless it starts with `--`; a value that must start with `--`
 * is written `--flag=value` (everything after the first `=` is the value).
 */

const fs = require('fs');
const path = require('path');
const { readLedger, isKilled, parseStamp } = require('./_lib/failure-ledger');
const { assertNoSymlinkedAncestor } = require('./_lib/fs-safe');
const { resolveWorktreeRoot } = require('./_lib/project-root');
const { SESSION_RE, pointerRoot, sourceDir, readPointerFile } = require('./_lib/run-pointer');

// ── constants ───────────────────────────────────────────────────────

const LOG_DIR = ['docs', '.output', 'evolution', 'agents'];
const HEADER = '| Agent | Story | Skill | Step | Signature | Run | Issue | Fix Applied |';
const SEPARATOR = '|-------|-------|-------|------|-----------|-----|-------|-------------|';
const SUBSECTION = '### Agent Issues';
const MAX_LOG_BYTES = 8 * 1024 * 1024; // a day's log is a few KB; the cap only bounds a hostile file
const LEDGER_TAIL_BYTES = 256 * 1024;
const SIGNATURE_WINDOW_MS = 60 * 60 * 1000; // no run pointer: a failure older than this is not this session's
const MAX_CELL_CHARS = 2000;
const TRUNCATION_MARK = ' …[truncated]';
const LOCK_STALE_MS = 10000; // a held lock covers one small read-modify-write, so older is a crashed writer's
const LOCK_WAIT_MS = 8000;
const STATE_DIR = ['docs', '.output', '.state'];

const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STEP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,59}$/;
const STORY_RE = /^[A-Za-z0-9][A-Za-z0-9._,-]{0,99}$/;
const SIGNATURE_RE = /^(?:[0-9a-f]{12,64}|empty:[A-Za-z0-9+_.-]+)$/;

const FLAGS = ['skill', 'step', 'agent', 'issue', 'fix', 'signature', 'story', 'session'];
const REQUIRED = ['skill', 'step', 'agent', 'issue', 'fix'];

// ── results ─────────────────────────────────────────────────────────

const refuse = (rule, message) => ({ exitCode: 2, errors: [{ rule, message }] });
const isString = (v) => typeof v === 'string';

/** A text cell: runs of whitespace (newlines included) collapse to one space, the text is cut to MAX_CELL_CHARS and
 *  every `|` is escaped with the backslashes before it doubled (see the header), so a value can never add a column,
 *  a row or a heading and the escape is unambiguous. */
function cell(text) {
    let t = String(text).replace(/\s+/g, ' ').trim();
    if (t.length > MAX_CELL_CHARS) {
        let cut = t.slice(0, MAX_CELL_CHARS - TRUNCATION_MARK.length);
        if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1); // never leave half a surrogate pair
        t = cut.trimEnd() + TRUNCATION_MARK;
    }
    return t.replace(/(\\*)\|/g, (_m, slashes) => `${slashes}${slashes}\\|`);
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── validation ──────────────────────────────────────────────────────

/** The first invalid input as a refusal, or null. Order: skill name shape, then the other flags. */
function validate(o) {
    if (!isString(o.root) || !path.isAbsolute(o.root)) return refuse('invalid-args', 'root must be an absolute path');
    if (o.now !== undefined && !(o.now instanceof Date && Number.isFinite(o.now.getTime()))) return refuse('invalid-args', 'now must be a valid Date');
    if (o.pointerRoot !== undefined && (!isString(o.pointerRoot) || !path.isAbsolute(o.pointerRoot))) return refuse('invalid-args', 'pointerRoot must be an absolute path');
    if (o.lockWaitMs !== undefined && !(Number.isFinite(o.lockWaitMs) && o.lockWaitMs >= 0)) return refuse('invalid-args', 'lockWaitMs must be a non-negative number');
    if (o.session !== undefined && !isString(o.session)) return refuse('invalid-args', '--session must be text');
    if (!isString(o.skill) || o.skill === '') return refuse('invalid-args', '--skill is required');
    if (!isString(o.step) || !STEP_RE.test(o.step)) return refuse('invalid-args', '--step must match [A-Za-z0-9][A-Za-z0-9._-]{0,39}');
    if (!isString(o.agent) || !AGENT_RE.test(o.agent)) return refuse('invalid-args', '--agent must match [A-Za-z0-9][A-Za-z0-9._ ()-]{0,59}');
    if (!isString(o.issue) || !o.issue.trim()) return refuse('invalid-args', '--issue is required and must not be blank');
    if (!isString(o.fix) || !o.fix.trim()) return refuse('invalid-args', '--fix is required and must not be blank');
    if (o.story !== undefined && (!isString(o.story) || !STORY_RE.test(o.story))) return refuse('invalid-args', '--story must match [A-Za-z0-9][A-Za-z0-9._,-]{0,99}');
    if (o.signature !== undefined && (!isString(o.signature) || !SIGNATURE_RE.test(o.signature))) {
        return refuse('invalid-args', '--signature must be 12-64 hex characters or empty:<mode>');
    }
    return null;
}

/** True when `.agents/skills/<skill>` is a directory directly under the project's skills folder and holds a SKILL.md. */
function skillExists(root, skill) {
    if (!SKILL_RE.test(skill)) return false; // `..`, `a/b`, an absolute path, `.`: never a plain skill name
    try {
        const dir = path.join(root, '.agents', 'skills', skill);
        return fs.statSync(dir).isDirectory() && fs.statSync(path.join(dir, 'SKILL.md')).isFile();
    } catch {
        return false;
    }
}

// ── signature and run pointer ───────────────────────────────────────

/** The earliest `ts` (ms) that still counts as this run's: the pointer's `since` stamp, else `now` minus the window. */
function scopeStartMs(pointer, now) {
    if (pointer && isString(pointer.since)) {
        try { return parseStamp(pointer.since).getTime(); } catch { /* a malformed stamp falls back to the window */ }
    }
    return now.getTime() - SIGNATURE_WINDOW_MS;
}

/** The newest non-killed ledger row's signature when that row is a failure inside the run's scope, else '-'
 *  (a pass resolved it; an older failure belongs to another run or session). */
function ledgerSignature(root, pointer, now) {
    const rows = readLedger({ root, tailBytes: LEDGER_TAIL_BYTES });
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (!row || isKilled(row)) continue;
        if (row.passed === true) return '-';
        const ts = isString(row.ts) ? Date.parse(row.ts) : NaN;
        if (!Number.isFinite(ts) || ts < scopeStartMs(pointer, now)) return '-';
        return isString(row.sig) && SIGNATURE_RE.test(row.sig) ? row.sig : '-';
    }
    return '-';
}

// ── the log file ────────────────────────────────────────────────────

/** Read an existing log through a no-follow, non-blocking descriptor; the caller has lstat-checked the path. */
function readLog(file) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile()) return { error: 'the log is not a regular file' };
        if (st.size > MAX_LOG_BYTES) return { error: 'the log is larger than 8 MiB' };
        const buf = Buffer.alloc(st.size);
        let offset = 0;
        while (offset < st.size) {
            const n = fs.readSync(fd, buf, offset, st.size - offset, offset);
            if (n <= 0) break;
            offset += n;
        }
        return { text: buf.toString('utf8', 0, offset) };
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
}

const bare = (line) => line.replace(/\r$/, '');
const isSectionBreak = (line) => /^#{1,2} /.test(line);

/**
 * The log text after adding `row` under `heading`. Existing lines are never touched: the row is inserted after the
 * last row of the section's last structured table, or a new `### Agent Issues` subsection goes at the section's end,
 * or a new section goes at the end of the file.
 */
function insertRow(text, { title, heading, row }) {
    if (text.length === 0) text = `${title}\n\n`;
    const cr = text.includes('\r\n') ? '\r' : '';
    const withCr = (lines) => lines.map((l) => l + cr);
    const block = [SUBSECTION, HEADER, SEPARATOR, row];

    const lines = text.split('\n');
    const start = lines.findIndex((l) => {
        const t = bare(l);
        return t === heading || t.startsWith(`${heading} (`);
    });

    if (start === -1) {
        let out = text.endsWith('\n') ? text : `${text}\n`;
        if (!/\n\r?\n$/.test(out)) out += `${cr}\n`;
        return out + [heading, '', ...block].map((l) => `${l}${cr}\n`).join('');
    }

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (isSectionBreak(lines[i])) { end = i; break; }
    }

    let sub = -1;
    for (let i = start + 1; i < end; i++) if (bare(lines[i]).trimEnd() === SUBSECTION) sub = i;
    if (sub !== -1) {
        let first = sub + 1;
        while (first < end && bare(lines[first]).trim() === '') first++;
        if (first < end && lines[first].startsWith('|') && bare(lines[first]).trimEnd() === HEADER) {
            let last = first;
            while (last + 1 < end && lines[last + 1].startsWith('|')) last++;
            lines.splice(last + 1, 0, ...withCr([row]));
            return finish(lines);
        }
    }

    let tail = end - 1;
    while (tail > start && bare(lines[tail]).trim() === '') tail--;
    lines.splice(tail + 1, 0, ...withCr(['', ...block]));
    return finish(lines);
}

const finish = (lines) => {
    const out = lines.join('\n');
    return out.endsWith('\n') ? out : `${out}\n`;
};

/** Write through a temp file in the same directory and rename, so a crash never leaves a half-written log. */
function writeAtomic(file, content) {
    // A random suffix as well as the pid: a crashed writer's leftover must never collide with a reused pid (`wx` would fail).
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
    try {
        fs.writeFileSync(tmp, content, { flag: 'wx' });
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
        throw error;
    }
}

// ── lock ────────────────────────────────────────────────────────────

const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available: spin on the next try */ } };

class BusyError extends Error {}

/**
 * Run `fn` holding the exclusive lock `lockFile` (created with `wx`). A lock older than LOCK_STALE_MS is a crashed
 * writer's and is broken; one that stays held for LOCK_WAIT_MS throws BusyError. The lock is released only when it
 * still holds this call's token, so a lock broken as stale by another writer is never deleted from under it.
 */
function withLock(lockFile, root, fn, waitMs = LOCK_WAIT_MS) {
    assertNoSymlinkedAncestor(lockFile, root);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}\n`;
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            fs.writeFileSync(lockFile, token, { flag: 'wx' });
            break;
        } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
            let age;
            try { age = Date.now() - fs.lstatSync(lockFile).mtimeMs; } catch { continue; } // released meanwhile: try again
            if (age > LOCK_STALE_MS) { try { fs.rmSync(lockFile, { force: true }); } catch { /* another waiter broke it */ } continue; }
            if (Date.now() > deadline) throw new BusyError('another agent-issue-log writer holds the log lock');
            sleepMs(5 + Math.floor(Math.random() * 20));
        }
    }
    try {
        return fn();
    } finally {
        try {
            if (fs.readFileSync(lockFile, 'utf8') === token) fs.rmSync(lockFile, { force: true });
        } catch { /* already gone: the stale rule reclaims anything left */ }
    }
}

// ── add ─────────────────────────────────────────────────────────────

/**
 * Append one structured issue row. Never throws.
 * @param {object} opts { root, skill, step, agent, issue, fix, signature?, story?, session?, now?, pointerRoot?, lockWaitMs? }
 *   `lockWaitMs` (default LOCK_WAIT_MS) bounds the wait for the log lock before refusing with rule `busy`.
 *   `root` is the project root (skills and the log live under it); `pointerRoot` (default `root`) is where the run
 *   pointer and the failure ledger live (`pointerRoot()` of `_lib/run-pointer.js`).
 * @returns {{exitCode: 0, file: string}|{exitCode: 2, errors: Array<{rule: string, message: string}>}}
 */
function add(opts) {
    try {
        if (!opts || typeof opts !== 'object') return refuse('invalid-args', 'add needs an options object');
        const bad = validate(opts);
        if (bad) return bad;
        if (!skillExists(opts.root, opts.skill)) return refuse('unknown-skill', `--skill "${opts.skill.slice(0, 60)}" is not a directory under .agents/skills`);

        const now = opts.now || new Date();
        const date = localDate(now);
        const stateRoot = opts.pointerRoot || opts.root;
        const pointer = isString(opts.session) && SESSION_RE.test(opts.session) ? readPointerFile({ root: stateRoot, session: opts.session }) : null;
        const wave = pointer && Number.isInteger(pointer.wave) && pointer.wave >= 0 ? pointer.wave : null;

        const label = wave !== null ? `Wave ${wave}` : (opts.story !== undefined ? opts.story : 'Ad hoc');
        const story = opts.story !== undefined ? opts.story : (pointer && pointer.story ? cell(pointer.story) : '-');
        const signature = opts.signature !== undefined ? opts.signature : ledgerSignature(stateRoot, pointer, now);
        const row = `| ${opts.agent} | ${story || '-'} | ${opts.skill} | ${opts.step} | ${signature} | ${pointer ? pointer.run_id : '-'} | ${cell(opts.issue)} | ${cell(opts.fix)} |`;

        const logDir = path.join(opts.root, ...LOG_DIR);
        const file = path.join(logDir, `${date}.md`);
        try {
            assertNoSymlinkedAncestor(file, opts.root);
        } catch (error) {
            return refuse('unsafe-path', `the log path is not safe: ${String(error && error.message).slice(0, 160)}`);
        }

        const lockFile = path.join(opts.root, ...STATE_DIR, `agent-issue-log-${date}.lock`);
        // Read, insert and write are one critical section: two parallel adds must both keep their row.
        return withLock(lockFile, opts.root, () => {
            let text = '';
            let st = null;
            try { st = fs.lstatSync(file); } catch { /* no log yet today */ }
            if (st) {
                if (!st.isFile()) return refuse('unsafe-path', 'the day\'s log exists but is not a regular file (symlink or directory)');
                const read = readLog(file);
                if (read.error) return refuse('unsafe-path', read.error);
                text = read.text;
            }

            const next = insertRow(text, { title: `# Agent issues — ${date}`, heading: `## ${date} — ${label}`, row });
            fs.mkdirSync(logDir, { recursive: true });
            writeAtomic(file, next);
            return { exitCode: 0, file: path.relative(opts.root, file).split(path.sep).join('/') };
        }, opts.lockWaitMs);
    } catch (error) {
        if (error instanceof BusyError) return refuse('busy', error.message);
        return refuse('exception', `agent-issue-log failed: ${String(error && error.message).slice(0, 200) || 'unknown failure'}`);
    }
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return { error: 'missing verb (add)' };
    if (argv[0] !== 'add') return { error: `unknown verb "${String(argv[0]).slice(0, 40)}" (add)` };
    const flags = {};
    for (let i = 1; i < argv.length;) {
        const token = argv[i];
        if (!isString(token) || !token.startsWith('--')) return { error: `unexpected argument "${String(token).slice(0, 40)}"` };
        // `--flag=value` carries its value in the token, so a value may itself start with `--`.
        const eq = token.indexOf('=');
        const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
        const shown = `--${name}`.slice(0, 40);
        if (!FLAGS.includes(name)) return { error: `unknown flag ${shown} for add` };
        if (Object.prototype.hasOwnProperty.call(flags, name)) return { error: `flag ${shown} given more than once` };
        let value;
        if (eq !== -1) {
            value = token.slice(eq + 1);
            i += 1;
        } else {
            value = argv[i + 1];
            if (!isString(value) || value.startsWith('--')) return { error: `flag ${shown} needs a value (write --${name}=<value> when the value starts with --)` };
            i += 2;
        }
        flags[name] = value;
    }
    for (const name of REQUIRED) if (!Object.prototype.hasOwnProperty.call(flags, name)) return { error: `add requires --${name}` };
    return { flags };
}

function emit(doc, message) {
    try { process.stdout.write(`${JSON.stringify(doc)}\n`); } catch { /* a closed stdout must not change the exit code */ }
    if (message) { try { process.stderr.write(`[agent-issue-log] refusing: ${message}\n`); } catch { /* same */ } }
}

/** CLI entry: prints exactly one JSON document and returns the exit code. */
function main(argv = process.argv.slice(2), env = process.env) {
    let doc;
    try {
        const parsed = parseArgs(argv);
        if (parsed.error) {
            doc = refuse('invalid-args', parsed.error);
        } else {
            const f = parsed.flags;
            const hint = sourceDir(path.resolve(__dirname, '..', '..'), env);
            const explicit = env.AGENTS_PROJECT_DIR || env.AGENT_SOURCE_ROOT || env.CODEX_PROJECT_DIR || env.CLAUDE_PROJECT_DIR;
            doc = add({
                root: path.resolve(explicit ? hint : resolveWorktreeRoot(hint)),
                pointerRoot: pointerRoot(hint, env),
                skill: f.skill, step: f.step, agent: f.agent, issue: f.issue, fix: f.fix,
                signature: f.signature, story: f.story,
                session: f.session !== undefined ? f.session : (env.CLAUDE_CODE_SESSION_ID || undefined),
                now: new Date(),
            });
        }
    } catch (error) {
        doc = refuse('exception', `agent-issue-log failed: ${String(error && error.message).slice(0, 200) || 'unknown failure'}`);
    }
    emit(doc, doc.exitCode === 2 && doc.errors && doc.errors[0] ? doc.errors[0].message : null);
    return doc.exitCode;
}

module.exports = { add, main, HEADER };
if (require.main === module) process.exitCode = main();
