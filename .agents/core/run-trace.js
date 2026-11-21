#!/usr/bin/env node
'use strict';

/**
 * run-trace.js — a per-run trace: plan, wave, story, dispatch, gate retries and cost read together (SF-3.7).
 *
 * A /do or /run-todo run stamps its telemetry rows with a run id (SF-3.2, SF-3.3). This helper joins those rows
 * to the run file (`runs/{runId}.json`, run-record.js), the plan's Wave Execution Log and one session-timesplit
 * window per wave, and writes a derived report. It is READ-ONLY apart from the report folder and the snapshot file.
 *
 *   report RUN_ID [--plan PATH] [--transcript PATH] [--project-dir DIR]
 *       writes docs/.output/.state/work/{YYYY-MM-DD}/{runId}/run-trace.{json,md}
 *   snapshot [--run-id X] [--wave N] [--session S]
 *       appends one `wave_close` row (the wave's row counts) to telemetry/run-trace-{runId}.jsonl
 *
 * Why a snapshot. The telemetry streams tail-rotate (command-usage at 6000 lines, skill-usage and the attribution
 * day files likewise), so a long run's early rows can be gone by the time anyone asks for the trace. `snapshot`
 * is called at wave close and keeps the counts in a file that is APPENDED to and NEVER rotated; `report` takes,
 * per count, the larger of the live count and the latest snapshot (rows only grow and rotation only removes them, so
 * a row appended after the snapshot is never hidden by it), and falls back to the live count for a count the snapshot
 * holds as null. A missing, empty, rotated-away or all-corrupt stream degrades to null counts, never an error. A stream
 * whose earliest row is newer than the wave's start was rotated past it: that wave's count from the stream is null
 * (unknown), not 0. The attribution day files are the exception below their tail-keep (500 rows): such a file was
 * never rotated, so a late first row means the run began appending late, and the count stands.
 *
 * Reuse: the pointer and session charset are `_lib/run-pointer.js`'s, attribution rows are read through
 * `readAttribution`, day stamps through failure-ledger's `dayStamps`/`parseStamp`, the transcript split through
 * session-timesplit's `analyzeSession` (its `--since`/`--until` window), and writes follow fs-safe.
 *
 * Exit codes: 0 ok, 1 the run file is missing (`run-not-found`) or not a JSON object (`run-unreadable`), 2 invalid
 * input (`invalid-args`) or any other failure (`exception`). Every export returns `{ exitCode, ... }` and never throws.
 *
 * Zero runtime dependencies (node built-ins and sibling modules only).
 */

const fs = require('fs');
const path = require('path');
const { readAttribution } = require('./_lib/attribution-ledger');
const { dayStamps, parseStamp } = require('./_lib/failure-ledger');
const { getTelemetryDir, getJsonlPath } = require('./_lib/telemetry-paths');
const { assertNoSymlinkedAncestor, safeWrite } = require('./_lib/fs-safe');
const { SESSION_RE, RUN_ID_RE, pointerRoot, sourceDir, readPointerFile } = require('./_lib/run-pointer');
const { analyzeSession, resolveTranscript } = require('./session-timesplit');

const MAX_BYTES = 64 * 1024 * 1024; // bound on any one stream, run file or plan read
const WORK_SUBPATH = ['docs', '.output', '.state', 'work'];
/** The attribution day files' tail-keep (`appendJsonl`'s default): a file with fewer rows was never rotated. */
const ATTRIBUTION_TAIL_KEEP = 500;
const COUNT_FIELDS = ['attribution', 'gate_runs', 'gate_failures', 'command_invocations', 'agent_dispatches'];

// ── helpers ─────────────────────────────────────────────────────────

/** A refusal with the exit code and rule it reports. */
class Failure extends Error {
    constructor(exitCode, rule, message) {
        super(message);
        this.exitCode = exitCode;
        this.rule = rule;
    }
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (text, max = 300) => String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').slice(0, max);
const invalid = (message) => new Failure(2, 'invalid-args', message);
const fwd = (p) => p.split(path.sep).join('/');

/** Run `fn(opts)`; a Failure keeps its exit code and rule, anything else is exit 2 `exception`. Never throws. */
function guarded(fn, opts) {
    try {
        return fn(isPlain(opts) ? opts : {});
    } catch (error) {
        if (error instanceof Failure) return { exitCode: error.exitCode, errors: [{ rule: error.rule, message: error.message }] };
        return { exitCode: 2, errors: [{ rule: 'exception', message: `run-trace failed: ${clip(error && error.message, 200) || 'unknown failure'}` }] };
    }
}

function rootOf(opts) {
    if (typeof opts.root !== 'string' || !opts.root || !path.isAbsolute(opts.root)) throw invalid('root must be an absolute project path');
    return opts.root;
}

function nowOf(opts) {
    return opts.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
}

function runIdOf(value) {
    if (typeof value !== 'string' || !RUN_ID_RE.test(value)) throw invalid('run id must match [A-Za-z0-9][A-Za-z0-9._-]{0,99}');
    return value;
}

/** Local `YYYY-MM-DD` of a Date (the report's date folder). */
function dateFolder(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Text of an ordinary regular file within MAX_BYTES, or null (absent, a directory, oversized, unreadable). */
function readText(file) {
    try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > MAX_BYTES) return null;
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/** Plain-object rows of a JSONL file in file order; null when the file has no parseable object row at all. */
function readRows(file) {
    const text = readText(file);
    if (text === null) return null;
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (isPlain(parsed)) rows.push(parsed);
        } catch { /* a corrupt line is skipped */ }
    }
    return rows.length ? rows : null;
}

// ── the run file ────────────────────────────────────────────────────

const runFilePath = (root, runId) => path.join(getTelemetryDir(root), 'runs', `${runId}.json`);

/** The run record object; exit 1 `run-not-found` / `run-unreadable` otherwise. */
function readRunFile(root, runId) {
    const file = runFilePath(root, runId);
    let st;
    try {
        st = fs.lstatSync(file);
    } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw new Failure(1, 'run-not-found', `no run file for ${runId}`);
        throw new Failure(1, 'run-unreadable', `run file for ${runId} cannot be read`);
    }
    if (!st.isFile() || st.size > MAX_BYTES) throw new Failure(1, 'run-unreadable', `run file for ${runId} is not a readable regular file`);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw new Failure(1, 'run-unreadable', `run file for ${runId} is not valid JSON`);
    }
    if (!isPlain(parsed)) throw new Failure(1, 'run-unreadable', `run file for ${runId} is not a JSON object`);
    return parsed;
}

/** Distinct waves of a run in order of first call: `{wave, story, since, until, untilIsNextWave}`; until = the next wave's first ts, the run's finish, or null. */
function wavesOf(run) {
    const calls = Array.isArray(run.waves) ? run.waves : [];
    const firsts = [];
    const seen = new Set();
    for (const c of calls) {
        if (!isPlain(c) || !Number.isSafeInteger(c.wave) || seen.has(c.wave)) continue;
        seen.add(c.wave);
        firsts.push({ wave: c.wave, story: typeof c.story === 'string' ? c.story : null, since: typeof c.ts === 'string' ? c.ts : null });
    }
    const finished = isPlain(run.result) && typeof run.result.finished_at === 'string' ? run.result.finished_at : null;
    return firsts.map((w, i) => ({ ...w, until: i + 1 < firsts.length ? firsts[i + 1].since : finished, untilIsNextWave: i + 1 < firsts.length }));
}

// ── streams and counts ──────────────────────────────────────────────

/** The date the run's attribution day files start from: its `since` stamp, else its start time, else `now`; never after `now`. */
function startOf(run, now) {
    let from = null;
    if (typeof run.since === 'string') {
        try { from = parseStamp(run.since); } catch { from = null; }
    }
    if (!from && typeof run.started_at === 'string') {
        const t = Date.parse(run.started_at);
        if (Number.isFinite(t)) from = new Date(t);
    }
    return !from || from.getTime() > now.getTime() ? now : from;
}

/** Epoch ms of the earliest parseable row timestamp (`timestamp`, else `ts`) in `rows`, or null when there is none. */
function earliestMs(rows) {
    if (rows === null) return null;
    let min = null;
    for (const r of rows) {
        const t = Date.parse(typeof r.timestamp === 'string' ? r.timestamp : typeof r.ts === 'string' ? r.ts : '');
        if (Number.isFinite(t) && (min === null || t < min)) min = t;
    }
    return min;
}

/**
 * The run's streams: `rows` per stream (arrays of the run's rows verbatim, or null when that stream has no
 * parseable row at all) and `starts` (epoch ms of each whole stream's earliest row, null when unknown), which
 * tells a rotated-past stream from a quiet one.
 */
function liveStreams(root, runId, run, now) {
    const attribution = [];
    let attributionRotatable = false;
    for (const day of dayStamps(startOf(run, now), now)) {
        const dayRows = readAttribution(day, { root });
        if (dayRows.length >= ATTRIBUTION_TAIL_KEEP) attributionRotatable = true;
        for (const row of dayRows) if (isPlain(row)) attribution.push(row);
    }
    const attributionRows = attribution.length ? attribution : null;
    const usage = readRows(getJsonlPath(root, 'command-usage.jsonl'));
    const skills = readRows(getJsonlPath(root, 'skill-usage.jsonl'));
    const mine = (rows, type) => (rows === null ? null : rows.filter((r) => r.run_id === runId && (type === undefined || r.type === type)));
    return {
        rows: {
            attribution: mine(attributionRows),
            gate_run: mine(usage, 'gate_run'),
            command_invocation: mine(usage, 'command_invocation'),
            agent_dispatch: mine(skills, 'agent_dispatch'),
        },
        starts: {
            // A day file below the writer's tail-keep was never rotated, so a first row newer than the wave start
            // means no earlier rows, not lost ones (a run that starts appending mid-run; first adopter run, 2026-11-20).
            attribution: attributionRotatable ? earliestMs(attributionRows) : null,
            gate_run: earliestMs(usage),
            command_invocation: earliestMs(usage),
            agent_dispatch: earliestMs(skills),
        },
    };
}

/**
 * Row counts of one wave (`row.wave === n`) from the live streams. A null stream gives null counts, and so does a
 * stream whose earliest row is newer than the wave's start (`sinceMs`): the stream was tail-rotated past the wave, so
 * a count from it would be a false 0 or a short count. A wave with no known start cannot be judged and is counted.
 */
function waveCounts(streams, n, sinceMs = null) {
    const { rows, starts } = streams;
    const of = (key, keep) => {
        const list = rows[key];
        if (list === null) return null;
        if (sinceMs !== null && starts[key] !== null && starts[key] > sinceMs) return null;
        return list.filter((r) => r.wave === n && (keep === undefined || keep(r))).length;
    };
    return {
        attribution: of('attribution'),
        gate_runs: of('gate_run'),
        gate_failures: of('gate_run', (r) => r.outcome === 'failure'),
        command_invocations: of('command_invocation'),
        agent_dispatches: of('agent_dispatch'),
    };
}

/** Epoch ms of an ISO timestamp string, or null. */
function msOf(iso) {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : null;
}

const snapshotPath = (root, runId) => getJsonlPath(root, `run-trace-${runId}.jsonl`);

/** The latest `wave_close` row of wave `n` in the run's snapshot file, or null. */
function latestSnapshot(snapshots, runId, n) {
    if (snapshots === null) return null;
    let latest = null;
    for (const r of snapshots) if (r.type === 'wave_close' && r.run_id === runId && r.wave === n) latest = r;
    return latest;
}

/**
 * Live counts merged with the latest snapshot, per field: the larger of the two when both are numbers (rows only
 * grow and rotation only removes them, so the truth is at least the larger), the snapshot alone when the live count
 * is null (rotated away or absent), the live count when the snapshot field is not a number.
 */
function mergeSnapshot(live, snapshot) {
    if (!snapshot) return live;
    const out = { ...live };
    for (const f of COUNT_FIELDS) {
        if (typeof snapshot[f] !== 'number' || !Number.isFinite(snapshot[f])) continue;
        out[f] = typeof live[f] === 'number' ? Math.max(live[f], snapshot[f]) : snapshot[f];
    }
    return out;
}

// ── the plan's Wave Execution Log ───────────────────────────────────

/** `{n: blockText}` of the `### Wave {N}` blocks under `## Wave Execution Log`; a block ends before the next `##`/`###` heading. */
function parseWaveBlocks(text) {
    const blocks = new Map();
    if (typeof text !== 'string') return blocks;
    let inLog = false;
    let fence = false;
    let current = null;
    const close = () => {
        if (current && !blocks.has(current.n)) blocks.set(current.n, current.lines.join('\n').replace(/\s+$/, ''));
        current = null;
    };
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        const heading = !fence && /^#{2,3}\s/.test(line);
        if (heading) {
            close();
            if (/^##\s+Wave Execution Log\b/.test(line)) { inLog = true; continue; }
            const m = /^###\s+Wave\s+(\d+)\b/.exec(line);
            if (inLog && m) { current = { n: Number(m[1]), lines: [line] }; continue; }
            if (/^##\s/.test(line)) inLog = false;
            continue;
        }
        // `run-record.js finish` appends `**Run record:** {json}` after the last wave block, with no heading between them:
        // the block ends at the first such line, so the record never reads as part of the last wave's log.
        if (current && !fence && /^\s*\*\*Run record:\*\*/.test(line)) close();
        if (current) current.lines.push(line);
    }
    close();
    return blocks;
}

/** The `- **Commit:** x` value of a wave block, or null when absent or still a `{pending ...}` placeholder. */
function commitOf(block) {
    const m = block ? /^\s*-\s+\*\*Commit:\*\*[ \t]*(.*)$/m.exec(block) : null;
    const value = m ? m[1].trim() : '';
    return !value || value.startsWith('{') ? null : value;
}

/** The plan to read: `opts.plan` wins, else the run result's plan (kept inside the root). `{ rel, abs }` or null. */
function planOf(root, run, opts) {
    let named = null;
    let trusted = false;
    if (typeof opts.plan === 'string' && opts.plan.trim()) { named = opts.plan; trusted = true; }
    else if (isPlain(run.result) && typeof run.result.plan === 'string' && run.result.plan.trim()) named = run.result.plan;
    if (named === null || /\0/.test(named)) return null;
    const abs = path.resolve(root, named);
    const rel = path.relative(root, abs);
    const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    if (!inside && !trusted) return null;
    return { rel: fwd(inside ? rel : abs), abs };
}

// ── transcript and timesplit ────────────────────────────────────────

/** The transcript file to split: `opts.transcript`, else the run's session id resolved with session-timesplit. Null when none. */
function transcriptOf(root, run, opts) {
    if (typeof opts.transcript === 'string' && opts.transcript) return path.resolve(root, opts.transcript);
    if (typeof run.session_id !== 'string' || !SESSION_RE.test(run.session_id)) return null;
    return resolveTranscript(run.session_id, { projectDir: opts.projectDir, home: opts.home, cwd: opts.cwd || root });
}

/**
 * session-timesplit over one wave window, or null when there is no transcript or it cannot be analysed. A window that
 * ends at the next wave's first ts is half-open (`since <= ts < until`), so an event exactly on the boundary belongs
 * to the later wave only; the last wave's window ends at the run's finish, inclusive.
 */
function timesplitOf(transcript, since, until, untilExclusive, eventCache) {
    if (!transcript) return null;
    try {
        return analyzeSession(transcript, { since, until, untilExclusive: untilExclusive === true, eventCache });
    } catch {
        return null;
    }
}

// ── report ──────────────────────────────────────────────────────────

const num = (n) => (typeof n === 'number' ? String(n) : '-');

function renderMarkdown(trace) {
    const lines = [`# Run trace: ${trace.run_id}`, ''];
    lines.push(`- Command: ${trace.command === null ? '-' : trace.command}`);
    lines.push(`- Input: ${trace.input === null ? '-' : clip(trace.input, 200)}`);
    lines.push(`- Session: ${trace.session_id === null ? '-' : trace.session_id}`);
    lines.push(`- Status: ${trace.status === null ? 'unfinished' : trace.status}`);
    lines.push(`- Plan: ${trace.plan === null ? '-' : trace.plan}`, '');
    for (const w of trace.waves) {
        lines.push(`## Wave ${w.wave}`, '');
        lines.push(`- Story: ${w.story === null ? '-' : w.story}`);
        lines.push(`- Window: ${w.since || '-'} -> ${w.until || '-'}`);
        lines.push(`- Commit: ${w.commit === null ? '-' : w.commit}`);
        lines.push(`- Attribution rows: ${num(w.counts.attribution)}`);
        lines.push(`- Gate runs: ${num(w.counts.gate_runs)}`);
        lines.push(`- Gate failures: ${num(w.counts.gate_failures)}`);
        lines.push(`- Command invocations: ${num(w.counts.command_invocations)}`);
        lines.push(`- Agent dispatches: ${num(w.counts.agent_dispatches)}`);
        if (w.timesplit) {
            const sa = w.timesplit.subagents;
            const tokens = Object.values(sa.byRole).reduce((sum, r) => sum + r.outputTokens, 0);
            lines.push(`- Main-thread wall clock: ${w.timesplit.wallSeconds} s`);
            lines.push(`- Subagent runs: ${sa.runs}, ${Math.round(sa.totalSeconds)} agent-seconds, ${tokens} output tokens`);
        } else {
            lines.push('- Timesplit: -');
        }
        if (w.log) lines.push('', ...w.log.split('\n').map((l) => `> ${l}`));
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Join the run's rows, the plan's Wave Execution Log and per-wave timesplit windows, and write the derived report.
 * @param {object} opts  { root, runId, plan?, transcript?, projectDir?, home?, cwd?, now? }
 * @returns {{exitCode: number, run_id?: string, dir?: string, json?: string, md?: string, trace?: object, errors?: object[]}}
 */
function report(opts) {
    return guarded((o) => {
        const root = rootOf(o);
        const runId = runIdOf(o.runId);
        const now = nowOf(o);
        const run = readRunFile(root, runId);

        const streams = liveStreams(root, runId, run, now);
        const rows = streams.rows;
        const snapshots = readRows(snapshotPath(root, runId));
        const plan = planOf(root, run, o);
        const blocks = plan ? parseWaveBlocks(readText(plan.abs)) : new Map();
        const transcript = transcriptOf(root, run, o);
        const eventCache = new Map(); // one parse of the transcript and each subagent file across every wave window

        const waves = wavesOf(run).map((w) => {
            const log = blocks.has(w.wave) ? blocks.get(w.wave) : null;
            return {
                wave: w.wave,
                story: w.story,
                since: w.since,
                until: w.until,
                log,
                commit: commitOf(log),
                counts: mergeSnapshot(waveCounts(streams, w.wave, msOf(w.since)), latestSnapshot(snapshots, runId, w.wave)),
                timesplit: timesplitOf(transcript, w.since, w.until, w.untilIsNextWave, eventCache),
            };
        });

        const trace = {
            run_id: runId,
            command: typeof run.command === 'string' ? run.command : null,
            input: typeof run.input === 'string' ? run.input : null,
            session_id: typeof run.session_id === 'string' ? run.session_id : null,
            status: isPlain(run.result) && typeof run.result.status === 'string' ? run.result.status : null,
            plan: plan ? plan.rel : null,
            rows,
            waves,
        };

        const dirRel = [...WORK_SUBPATH, dateFolder(now), runId].join('/');
        const dirAbs = path.join(root, ...dirRel.split('/'));
        const jsonRel = `${dirRel}/run-trace.json`;
        const mdRel = `${dirRel}/run-trace.md`;
        assertNoSymlinkedAncestor(path.join(dirAbs, 'run-trace.json'), root);
        fs.mkdirSync(dirAbs, { recursive: true });
        safeWrite(path.join(dirAbs, 'run-trace.json'), `${JSON.stringify(trace, null, 2)}\n`, undefined, root);
        safeWrite(path.join(dirAbs, 'run-trace.md'), renderMarkdown(trace), undefined, root);
        return { exitCode: 0, run_id: runId, dir: dirRel, json: jsonRel, md: mdRel, trace };
    }, opts);
}

// ── snapshot ────────────────────────────────────────────────────────

/**
 * Append ONE `wave_close` row (the wave's live row counts) to telemetry/run-trace-{runId}.jsonl. The file is never rotated.
 * @param {object} opts  { root, runId?, wave?, session?, now? }  runId and wave default to the session's run pointer.
 * @returns {{exitCode: number, run_id?: string, wave?: number, path?: string, row?: object, errors?: object[]}}
 */
function snapshot(opts) {
    return guarded((o) => {
        const root = rootOf(o);
        const now = nowOf(o);

        let pointer = null;
        // readPointerFile refuses a session id outside the pointer charset, so an odd id (or none) just means no pointer.
        if (typeof o.session === 'string' && o.session) pointer = readPointerFile({ root, session: o.session, maxAgeMs: Infinity });

        let runId = o.runId;
        if (runId === undefined || runId === null || runId === '') {
            if (!pointer) throw invalid('no run id: pass --run-id, or run in a session with a run pointer (--session, or CLAUDE_CODE_SESSION_ID)');
            runId = pointer.run_id;
        }
        runIdOf(runId);

        let wave = o.wave;
        if (wave === undefined || wave === null) wave = pointer && pointer.run_id === runId ? pointer.wave : null; // another run's pointer wave is not this run's
        if (!Number.isSafeInteger(wave) || wave < 1) throw invalid('wave must be a positive integer (pass --wave, or let the run pointer carry it)');

        const run = readRunFile(root, runId);
        const first = wavesOf(run).find((w) => w.wave === wave);
        const row = { ts: now.toISOString(), type: 'wave_close', run_id: runId, wave, ...waveCounts(liveStreams(root, runId, run, now), wave, first ? msOf(first.since) : null) };

        const file = snapshotPath(root, runId);
        assertNoSymlinkedAncestor(file, root);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Appended with O_NOFOLLOW (a leaf symlink is refused, never followed); never through jsonl-writer, which tail-rotates.
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o666);
        try {
            fs.writeSync(fd, `${JSON.stringify(row)}\n`);
        } finally {
            fs.closeSync(fd);
        }
        return { exitCode: 0, run_id: runId, wave, path: fwd(path.relative(root, file)), row };
    }, opts);
}

// ── CLI ─────────────────────────────────────────────────────────────

const VERBS = new Map([
    ['report', { positional: 'RUN_ID', flags: ['plan', 'transcript', 'project-dir'] }],
    ['snapshot', { positional: null, flags: ['run-id', 'wave', 'session'] }],
]);

/** `{ verb, positional?, flags }` or `{ error }`. Every flag takes a value and appears at most once. */
function parseArgs(argv) {
    if (!Array.isArray(argv) || argv.length === 0) return { error: 'usage: run-trace.js report RUN_ID [--plan PATH] [--transcript PATH] [--project-dir DIR] | snapshot [--run-id X] [--wave N] [--session S]' };
    const spec = VERBS.get(argv[0]);
    if (!spec) return { error: `unknown verb "${clip(argv[0], 40)}" (report or snapshot)` };
    let i = 1;
    let positional;
    if (spec.positional) {
        if (typeof argv[1] !== 'string' || argv[1].startsWith('--')) return { error: `${argv[0]} requires a ${spec.positional}` };
        positional = argv[1];
        i = 2;
    }
    const flags = {};
    for (; i < argv.length; i += 2) {
        const token = argv[i];
        if (typeof token !== 'string' || !token.startsWith('--')) return { error: `unexpected argument "${clip(token, 40)}"` };
        const name = token.slice(2);
        if (!spec.flags.includes(name)) return { error: `unknown flag ${clip(token, 40)} for ${argv[0]}` };
        if (Object.prototype.hasOwnProperty.call(flags, name)) return { error: `flag ${token} given more than once` };
        const value = argv[i + 1];
        if (typeof value !== 'string' || value.startsWith('--')) return { error: `flag ${token} needs a value` };
        flags[name] = value;
    }
    return { verb: argv[0], positional, flags };
}

function emit(doc) {
    try { process.stdout.write(`${JSON.stringify(doc)}\n`); } catch { /* a closed stdout must not change the exit code */ }
    if (doc.errors && doc.errors[0]) { try { process.stderr.write(`[run-trace] refusing: ${doc.errors[0].message}\n`); } catch { /* same */ } }
}

function main(argv = process.argv.slice(2), env = process.env) {
    let doc;
    try {
        const parsed = parseArgs(argv);
        if (parsed.error) {
            doc = { exitCode: 2, errors: [{ rule: 'invalid-args', message: parsed.error }] };
        } else {
            const f = parsed.flags;
            const cwd = process.cwd();
            // The root every writer of the run's files uses: the main worktree of the repository the caller hints at.
            const root = pointerRoot(sourceDir(path.resolve(__dirname, '..', '..'), env), env);
            const abs = (p) => (p === undefined ? undefined : path.resolve(cwd, p)); // a relative path flag is relative to the cwd
            if (parsed.verb === 'report') {
                doc = report({ root, runId: parsed.positional, plan: abs(f.plan), transcript: abs(f.transcript), projectDir: abs(f['project-dir']), cwd, now: new Date() });
            } else {
                const session = f.session !== undefined ? f.session : (env.CLAUDE_CODE_SESSION_ID || undefined);
                doc = snapshot({ root, runId: f['run-id'], wave: f.wave === undefined ? undefined : (/^\d+$/.test(f.wave) ? Number(f.wave) : NaN), session, now: new Date() });
            }
        }
    } catch (error) {
        doc = { exitCode: 2, errors: [{ rule: 'exception', message: `run-trace failed: ${clip(error && error.message, 200) || 'unknown failure'}` }] };
    }
    emit(doc);
    return doc.exitCode;
}

module.exports = { report, snapshot, main };
if (require.main === module) process.exitCode = main();
