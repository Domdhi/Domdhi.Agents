// SF-3.7: tests for `.agents/core/run-trace.js`: a per-run trace that joins the rows, the plan's Wave Execution Log
// and per-wave session-timesplit windows. Standard tier (read-only derived reporting): one test per AC behaviour.
// The window flags of `session-timesplit.js` (AC 1) are tested in session-timesplit.test.js, `describe('SF-3.7 window flags')`.
//
// PINNED CONTRACT. The implementer must match these names, signatures and shapes; the tests are the spec.
//
// Exports (CommonJS, all SYNCHRONOUS; the CLI is guarded by `require.main === module`, so requiring the file never exits):
//   report(opts)   -> result   AC 2: join the run's rows, the plan's Wave Execution Log and per-wave timesplit windows;
//                              write the derived report
//   snapshot(opts) -> result   AC 3: append ONE wave-close row to telemetry/run-trace-{runId}.jsonl
//   main(argv = process.argv.slice(2), env = process.env) -> exit code number; prints exactly ONE JSON document
//   Common opts: root (absolute project root), now (Date, the clock for every timestamp and the report's date folder).
//     report:   { runId, plan, transcript, projectDir, home }
//     snapshot: { runId, wave, session }
//   No export ever throws: any exception, even a hostile `opts` (null, a number for root, ...), becomes
//   { exitCode: 2, errors: [{ rule: 'exception', message }] }. Every result has `exitCode`; errors are
//   { exitCode, errors: [{ rule, message }] } with exit 1 rules `run-not-found` (no runs/{runId}.json) and
//   `run-unreadable` (that file is not a JSON object), exit 2 rule `invalid-args`.
//   A run id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/ (the run-record / run-pointer charset), else exit 2 and
//   NOTHING is written anywhere (a `../x` id must not reach outside the work folder).
//
// CLI (root = CLAUDE_PROJECT_DIR when set, else the repo root; a relative path flag is relative to the cwd):
//   run-trace.js report RUN_ID [--plan PATH] [--transcript PATH] [--project-dir DIR]
//   run-trace.js snapshot [--run-id X] [--wave N] [--session S]
//   Every flag takes a value and appears at most once; an unknown flag or verb, a missing verb, a missing RUN_ID on
//   `report`, or a flag without a value (next argv absent or starting with `--`) is exit 2. The CLI process exit code
//   equals result.exitCode; stdout is one JSON document (the result, `exitCode` included) and for a refusal stderr also
//   carries `[run-trace] refusing: {message}`.
//   Session source for `snapshot`: `--session S`, else env CLAUDE_CODE_SESSION_ID (same rule as run-record.js).
//
// INPUT STREAMS (all under docs/.output/.state/telemetry/; rows join to the run by `run_id === runId` ONLY, so rows of
// another run and rows without a run_id are never part of the trace; a corrupt JSONL line is skipped, never an error):
//   runs/{runId}.json          run record from run-record.js (SF-3.1): { run_id, command, input, session_id, since
//                              (YYMMDD-HHMM), started_at, waves: [{ wave, story, ts (ISO) }], result?: { status, plan
//                              (repo-relative | null), finished_at (ISO), ... } }. REQUIRED: it gives the wave windows.
//   attribution-{YYMMDD}.jsonl rows { timestamp, ..., run_id?, wave? }: every day file from the run's `since` date through
//                              the date of `now` (inclusive), concatenated in day order (the midnight read gap).
//   command-usage.jsonl        rows with type 'gate_run' (outcome 'success' | 'failure' | ...) and 'command_invocation'
//   skill-usage.jsonl          rows with type 'agent_dispatch' (other types, e.g. skill_read, are not dispatches)
//   gate counts: gate_runs = gate_run rows; gate_failures = gate_run rows whose outcome === 'failure'.
//
// PLAN: opts.plan (absolute, or relative to root) wins; else run.result.plan; else none. The Wave Execution Log is the
//   `### Wave {N} (...)` blocks after `## Wave Execution Log`. A block runs from its heading line to the line before the
//   next `##`/`###` heading (so `### Wave Summary` and later text are not part of the last wave). A missing, unreadable
//   or log-less plan degrades every wave's `log` and `commit` to null.
//
// report result and trace (the trace object is also the content of run-trace.json):
//   result = { exitCode: 0, run_id, dir, json, md, trace }   dir/json/md are repo-relative with forward slashes:
//     dir  = docs/.output/.state/work/{YYYY-MM-DD}/{runId}   (local date of `now`; slug = the run id)
//     json = {dir}/run-trace.json   (JSON.stringify of `trace`)      md = {dir}/run-trace.md
//   trace = {
//     run_id, command, input, session_id          from the run file
//     status        run.result.status, or null when the run is unfinished
//     plan          repo-relative forward-slash path of the plan used, or null
//     rows: { attribution, gate_run, command_invocation, agent_dispatch }
//                   each an ARRAY of the joined rows verbatim (file order), or null when that stream has no parseable row
//                   at all (file absent, empty or all-corrupt; this is also how a ROTATED-away stream reads)
//     waves: [ one per DISTINCT wave number in run.waves, in order of first call: {
//       wave, story    the first call's story string (null when absent)
//       since, until   window: since = that first call's ts; until = the NEXT distinct wave's first ts, or for the last
//                      wave run.result.finished_at, or null when the run is unfinished
//       log, commit    the plan block text (starts with its `### Wave N` heading) or null; commit = the `- **Commit:** x`
//                      value, null when absent or still a `{pending ...}` placeholder
//       counts: { attribution, gate_runs, gate_failures, command_invocations, agent_dispatches }
//                      number|null: rows of THIS wave (row.wave === N); null when the stream is null; rows with wave
//                      null/absent are in `rows` but in no wave's counts. A stream whose earliest row is newer than the
//                      wave's `since` was tail-rotated past the wave: null (m8). A wave-close snapshot (below) merges:
//                      per field, the LATEST type 'wave_close' row for that wave in run-trace-{runId}.jsonl is taken
//                      when its value is a number, but never below the live count (m7: the larger of the two);
//                      a null snapshot field falls back to the live count, a null live count takes the snapshot.
//       timesplit      session-timesplit.analyzeSession(transcript, { since, until }) for the wave window (its `window`
//                      key included), or null when no transcript is found or analysing it throws
//     } ]
//   }
//   Transcript: opts.transcript (path) else session-timesplit.resolveTranscript(run.session_id, { projectDir, home }).
//   run-trace.md: starts with `# Run trace: {runId}`; per wave a `## Wave {N}` heading and the labelled lines
//   `Gate runs: {n}`, `Gate failures: {n}` (a null count prints `-`).
//   report is READ-ONLY apart from the work folder: it never edits a stream, the run file, the plan or a snapshot file.
//
// snapshot result and row:
//   Run id: opts.runId / --run-id, else the session pointer (`_lib/run-pointer.js` readPointerFile under the root
//   run-record.js writes: current-run-{session}.json {run_id, plan, wave, story, since}). Wave: opts.wave / --wave (a
//   positive integer), else the pointer's wave. Neither run id resolvable, or no wave, or a bad wave -> exit 2;
//   the run file missing -> exit 1. Nothing is written on any refusal.
//   result = { exitCode: 0, run_id, wave, path, row }   path = docs/.output/.state/telemetry/run-trace-{runId}.jsonl (repo-relative)
//   row = EXACTLY { ts: now ISO, type: 'wave_close', run_id, wave, attribution, gate_runs, gate_failures,
//                   command_invocations, agent_dispatches } with the per-wave counts of `trace.waves[].counts` (live
//                   streams only), number|null: a stream with no parseable row at all (absent, empty = rotated away, or
//                   all corrupt) is null, never a thrown error; a stream with rows but none for the wave is 0.
//   The file is APPENDED to (one JSON line per call) and is NEVER tail-rotated.
//
// NOT COVERED: reading the live gate-failures ledger or `cost` beyond the per-wave timesplit token counts (the story's
// "gate retries and cost" are read from gate_run rows and timesplit; no separate cost field is pinned). The rotated-
// stream detector (m8) is the stream's earliest row against the wave start; a stream that was rotated yet still begins
// before the wave (it cannot happen: rotation only removes the oldest rows) is not a case.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve('.agents/core/run-trace.js');
const subject = () => require('../run-trace');
const { createTmpDir } = require('./_helpers/tmp-dir.js');

const TEL = 'docs/.output/.state/telemetry';
const PLAN_REL = 'docs/.output/plans/261117-2350-run-todo-fixture.md';
const RUN = '261117-2350-run-todo-fixture';
const OTHER = '261117-2300-do-other';
const SESSION = 'sess-a';

// Timeline in seconds from T0; every timestamp is an absolute ISO string, so nothing depends on the clock or zone.
const T0 = Date.UTC(2026, 10, 18, 10, 0, 0);
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
const NOW = new Date(2026, 10, 18, 15, 0, 0); // local: the date folder is 2026-11-18 and the attribution days are 261117, 261118
const NOW_FOLDER = '2026-11-18';

const jsonl = (rows, extra = []) => [...rows.map((r) => JSON.stringify(r)), ...extra].join('\n') + '\n';

const PLAN_TEXT = [
  '# Plan: fixture',
  '',
  '**Status:** complete',
  '',
  '## Wave Execution Log',
  '',
  '### Wave 1 (2026-11-17)',
  '- **Stories:** SF-1.1',
  '- **Commit:** abc1234',
  '- **Red:** 3 red',
  '',
  '**Review — Wave 1**',
  '- Reviewed: Main Agent read',
  '',
  '### Wave 2 (2026-11-18)',
  '- **Stories:** SF-1.2, SF-1.3',
  '- **Commit:** {pending — set in 8f}',
  '',
  '### Wave Summary',
  'SUMMARYMARK',
  '',
  `**Run record:** {"run_id":"${RUN}"}`,
  '',
].join('\n');

const attr = (run, wave, extra = {}) => ({
  timestamp: iso(1), story_id: 'SF-1.1', agent: 'general-purpose', model: 'm', files_touched: [], status: 'done',
  ...(run ? { run_id: run } : {}), ...(wave !== undefined ? { wave } : {}), ...extra,
});
const gate = (run, wave, outcome) => ({ timestamp: iso(2), type: 'gate_run', command: 'gate:test', duration_ms: 5, outcome, session_id: SESSION, ...(run ? { run_id: run, wave } : {}) });
const cmd = (run, wave) => ({ timestamp: iso(3), type: 'command_invocation', command: 'run-todo', duration_ms: null, session_id: SESSION, ...(run ? { run_id: run, wave } : {}) });
const dispatch = (run, wave, type = 'agent_dispatch') => ({ timestamp: iso(4), type, agent: 'general-purpose', skills: [], description: 'd', ...(run ? { run_id: run, wave } : {}) });

const RUN_FILE = {
  run_id: RUN, command: 'run-todo', input: 'fixture', session_id: SESSION, budget: null, since: '261117-2350', started_at: iso(-1000),
  waves: [{ wave: 1, story: 'SF-1.1', ts: iso(0) }, { wave: 2, story: 'SF-1.2,SF-1.3', ts: iso(600) }],
  result: { status: 'passed', exit_code: 0, commit: null, receipt: null, ship_token: null, plan: PLAN_REL, finished_at: iso(1200), record: {} },
};

let tmp;
let root;
let transcript;

const write = (rel, text) => tmp.write(rel, text);
const writeRows = (rel, rows, extra) => write(rel, jsonl(rows, extra));
const abs = (rel) => path.join(root, rel);
const exists = (rel) => fs.existsSync(abs(rel));
const readJson = (rel) => JSON.parse(fs.readFileSync(abs(rel), 'utf8'));
const lines = (rel) => fs.readFileSync(abs(rel), 'utf8').split('\n').filter(Boolean);

function seedRunFile(patch = {}) {
  write(`${TEL}/runs/${RUN}.json`, JSON.stringify({ ...RUN_FILE, ...patch }, null, 2));
}

// A row older than the whole run (and with no run id): the stream "starts before the run began", so it was not
// tail-rotated past wave 1 (m8). Streams seeded without one read as rotated for wave 1 and count null there.
const HISTORY_TS = iso(-5000);
const before = (row) => ({ ...row, timestamp: HISTORY_TS });

function seedStreams() {
  writeRows(`${TEL}/attribution-261117.jsonl`, [before(attr(null)), attr(RUN, 1), attr(OTHER, 1), attr(null)]);
  writeRows(`${TEL}/attribution-261118.jsonl`, [attr(RUN, 2), attr(RUN, null)]);
  writeRows(`${TEL}/command-usage.jsonl`, [
    before(gate(null)), gate(RUN, 1, 'failure'), gate(RUN, 1, 'success'), gate(RUN, 2, 'success'), gate(OTHER, 1, 'failure'), gate(null),
    cmd(RUN, 1), cmd(RUN, 2), cmd(OTHER, 1), cmd(null),
  ]);
  writeRows(`${TEL}/skill-usage.jsonl`, [
    before(dispatch(null)), dispatch(RUN, 1), dispatch(RUN, 1), dispatch(RUN, 2), dispatch(OTHER, 1), dispatch(null), dispatch(RUN, 1, 'skill_read'),
  ]);
}

/** A main thread plus one subagent, in seconds from T0: wave 1 is [0, 600], wave 2 is [600, 1200]. */
function seedTranscript() {
  const user = (sec, text) => ({ type: 'user', timestamp: iso(sec), message: { role: 'user', content: text } });
  const reply = (sec, text, extra = {}) => ({ type: 'assistant', timestamp: iso(sec), message: { role: 'assistant', content: [{ type: 'text', text }], ...extra } });
  transcript = write(
    `proj/${SESSION}.jsonl`,
    // wave 1 holds 5, 10, 20; wave 2 holds 700, 730; 1500 is after the run finished.
    jsonl([user(5, 'go'), reply(10, 'a'), reply(20, 'b'), reply(700, 'c'), reply(730, 'd'), reply(1500, 'late')]),
  );
  write(`proj/${SESSION}/subagents/agent-s1.jsonl`, jsonl([user(50, 'p'), reply(60, 'x', { id: 'm1', usage: { output_tokens: 7 } })]));
  write(`proj/${SESSION}/subagents/agent-s1.meta.json`, JSON.stringify({ description: 'Implement widget' }));
}

const base = () => ({ root, now: NOW, home: root, runId: RUN, transcript });

function tree() {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

beforeEach(() => {
  tmp = createTmpDir({ prefix: 'run-trace-test-' });
  root = tmp.root;
  seedRunFile();
  seedStreams();
  write(PLAN_REL, PLAN_TEXT);
  seedTranscript();
});

afterEach(() => {
  tmp.cleanup();
});

// ── AC 2: report joins rows, the Wave Execution Log and per-wave timesplit windows ──────────────────────────────

describe('report: the join by run_id', () => {
  it('report_joinsAttributionGateCommandAndDispatchRowsOfTheRun', () => {
    const r = subject().report(base());

    expect(r.exitCode).toBe(0);
    expect(r.trace.run_id).toBe(RUN);
    expect(r.trace.rows.attribution.map((x) => x.wave)).toEqual([1, 2, null]);
    expect(r.trace.rows.gate_run.map((x) => x.outcome)).toEqual(['failure', 'success', 'success']);
    expect(r.trace.rows.command_invocation.map((x) => x.wave)).toEqual([1, 2]);
    expect(r.trace.rows.agent_dispatch.map((x) => x.wave)).toEqual([1, 1, 2]);
  });

  it('report_excludesRowsOfAnotherRunRowsWithoutARunIdAndNonDispatchSkillRows', () => {
    const { rows } = subject().report(base()).trace;
    const all = [...rows.attribution, ...rows.gate_run, ...rows.command_invocation, ...rows.agent_dispatch];

    expect(all.length).toBe(11); // 3 attribution + 3 gate_run + 2 command_invocation + 3 agent_dispatch
    expect(all.every((x) => x.run_id === RUN)).toBe(true);
    expect(rows.agent_dispatch.every((x) => x.type === 'agent_dispatch')).toBe(true);
  });

  it('report_readsAttributionFromEveryDayFileFromTheRunStartThroughNow', () => {
    // Run started on 261117 and `now` is 261118: the midnight crossing must not hide either day's rows.
    const r = subject().report(base());

    expect(r.trace.rows.attribution.length).toBe(3);
    expect(r.trace.waves.map((w) => w.counts.attribution)).toEqual([1, 1]);
  });

  it('report_countsRowsPerWaveAndLeavesWaveLessRowsOutOfEveryWave', () => {
    const { waves } = subject().report(base()).trace;

    expect(waves.map((w) => w.counts)).toEqual([
      { attribution: 1, gate_runs: 2, gate_failures: 1, command_invocations: 1, agent_dispatches: 2 },
      { attribution: 1, gate_runs: 1, gate_failures: 0, command_invocations: 1, agent_dispatches: 1 },
    ]);
  });

  it('report_carriesTheRunIdentityStatusAndPlanPath', () => {
    const { trace } = subject().report(base());

    expect(trace.command).toBe('run-todo');
    expect(trace.input).toBe('fixture');
    expect(trace.session_id).toBe(SESSION);
    expect(trace.status).toBe('passed');
    expect(trace.plan).toBe(PLAN_REL);
  });
});

describe('report: waves, windows and the plan Wave Execution Log', () => {
  it('report_buildsOneWavePerDistinctWaveWithWindowsFromTheRunFile', () => {
    const { waves } = subject().report(base()).trace;

    expect(waves.map((w) => [w.wave, w.story, w.since, w.until])).toEqual([
      [1, 'SF-1.1', iso(0), iso(600)],
      [2, 'SF-1.2,SF-1.3', iso(600), iso(1200)],
    ]);
  });

  it('report_unfinishedRun_leavesTheLastWaveWindowOpenAndHasNoPlanLog', () => {
    seedRunFile({ result: undefined });

    const { trace } = subject().report(base());

    expect(trace.status).toBeNull();
    expect(trace.plan).toBeNull();
    expect(trace.waves[1].until).toBeNull();
    expect(trace.waves.map((w) => w.log)).toEqual([null, null]);
  });

  it('report_joinsTheWaveBlockOfThePlanByWaveNumber', () => {
    const { waves } = subject().report(base()).trace;

    expect(waves[0].log.startsWith('### Wave 1 (2026-11-17)')).toBe(true);
    expect(waves[0].log).toContain('- **Red:** 3 red');
    expect(waves[0].log).toContain('**Review — Wave 1**');
    expect(waves[0].log).not.toContain('### Wave 2');
    expect(waves[0].commit).toBe('abc1234');
    expect(waves[1].log).toContain('- **Stories:** SF-1.2, SF-1.3');
  });

  it('report_lastWaveBlockStopsAtTheWaveSummaryHeadingAndAPendingCommitIsNull', () => {
    const { waves } = subject().report(base()).trace;

    expect(waves[1].log).not.toContain('SUMMARYMARK');
    expect(waves[1].log).not.toContain('Run record');
    expect(waves[1].commit).toBeNull();
  });

  // Review n1: `run-record.js finish` appends the record directly after the last wave block, with no heading between.
  it('report_lastWaveBlockStopsAtTheFirstRunRecordLineWhenNoHeadingFollows', () => {
    write(PLAN_REL, [
      '## Wave Execution Log', '',
      '### Wave 1 (2026-11-17)', '- **Commit:** abc1234', '',
      '### Wave 2 (2026-11-18)', '- **Stories:** SF-1.2', '- **Commit:** def5678', '- **Red:** 2 red', '',
      `**Run record:** {"run_id":"${RUN}","status":"passed"}`, 'trailing prose after the record', '',
    ].join('\n'));

    const { waves } = subject().report(base()).trace;

    expect(waves[1].log).toBe('### Wave 2 (2026-11-18)\n- **Stories:** SF-1.2\n- **Commit:** def5678\n- **Red:** 2 red');
    expect(waves[1].commit).toBe('def5678');
    expect(waves[0].log).toBe('### Wave 1 (2026-11-17)\n- **Commit:** abc1234');
  });

  it('report_aRunRecordLineInsideACodeFenceDoesNotEndTheWaveBlock', () => {
    write(PLAN_REL, [
      '## Wave Execution Log', '',
      '### Wave 2 (2026-11-18)', '- **Commit:** def5678', '```', '**Run record:** {"example":true}', '```', '- **Red:** after the fence', '',
    ].join('\n'));

    const { waves } = subject().report(base()).trace;

    expect(waves[1].log).toContain('{"example":true}');
    expect(waves[1].log).toContain('- **Red:** after the fence');
  });

  it('report_planOption_winsOverThePlanNamedByTheRunResult', () => {
    write('docs/.output/plans/other.md', '## Wave Execution Log\n\n### Wave 1 (2026-11-17)\n- **Commit:** fffffff\n');

    const { trace } = subject().report({ ...base(), plan: 'docs/.output/plans/other.md' });

    expect(trace.plan).toBe('docs/.output/plans/other.md');
    expect(trace.waves[0].commit).toBe('fffffff');
    expect(trace.waves[1].log).toBeNull();
  });

  it('report_runsSessionTimesplitOverEachWaveWindow', () => {
    const { waves } = subject().report(base()).trace;

    expect(waves[0].timesplit.window).toEqual({ since: iso(0), until: iso(600) });
    expect(waves[0].timesplit.wallSeconds).toBe(15); // events at 5, 10, 20
    expect(waves[0].timesplit.subagents.runs).toBe(1);
    expect(waves[0].timesplit.subagents.byRole.build.outputTokens).toBe(7);
    expect(waves[1].timesplit.window).toEqual({ since: iso(600), until: iso(1200) });
    expect(waves[1].timesplit.wallSeconds).toBe(30); // events at 700, 730; the 1500 event is after the run finished
    expect(waves[1].timesplit.subagents.runs).toBe(0);
  });

  it('report_findsTheTranscriptFromTheRunSessionIdAndProjectDirWhenNoPathIsGiven', () => {
    const r = subject().report({ root, now: NOW, home: root, runId: RUN, projectDir: path.join(root, 'proj') });

    expect(r.trace.waves[0].timesplit.wallSeconds).toBe(15);
  });
});

describe('report: the derived report location', () => {
  it('report_writesJsonAndMarkdownUnderWorkDateRunId', () => {
    const r = subject().report(base());
    const dir = `docs/.output/.state/work/${NOW_FOLDER}/${RUN}`;

    expect(r.dir).toBe(dir);
    expect(r.json).toBe(`${dir}/run-trace.json`);
    expect(r.md).toBe(`${dir}/run-trace.md`);
    expect(readJson(r.json)).toEqual(JSON.parse(JSON.stringify(r.trace)));
    const md = fs.readFileSync(abs(r.md), 'utf8');
    expect(md.startsWith(`# Run trace: ${RUN}`)).toBe(true);
    expect(md).toContain('## Wave 1');
    expect(md).toContain('## Wave 2');
    expect(md).toContain('Gate runs: 2');
    expect(md).toContain('Gate failures: 1');
  });

  it('report_changesNothingOutsideTheWorkFolder', () => {
    const before = tree();

    expect(subject().report(base()).exitCode).toBe(0);

    const after = tree();
    const outside = Object.keys(after).filter((p) => !p.startsWith('docs/.output/.state/work/'));
    expect(outside.sort()).toEqual(Object.keys(before).sort());
    for (const p of outside) expect(after[p]).toBe(before[p]);
  });
});

describe('report: missing and corrupt sources degrade, never crash', () => {
  it('report_withNoStreamsPlanOrTranscript_stillWritesAReportWithNulls', () => {
    for (const f of fs.readdirSync(abs(TEL))) if (f !== 'runs') fs.rmSync(abs(`${TEL}/${f}`), { recursive: true });
    fs.rmSync(abs(PLAN_REL));
    fs.rmSync(abs('proj'), { recursive: true });

    const r = subject().report({ root, now: NOW, home: root, runId: RUN });

    expect(r.exitCode).toBe(0);
    expect(r.trace.rows).toEqual({ attribution: null, gate_run: null, command_invocation: null, agent_dispatch: null });
    expect(r.trace.waves.map((w) => w.counts)).toEqual([
      { attribution: null, gate_runs: null, gate_failures: null, command_invocations: null, agent_dispatches: null },
      { attribution: null, gate_runs: null, gate_failures: null, command_invocations: null, agent_dispatches: null },
    ]);
    expect(r.trace.waves.map((w) => [w.log, w.commit, w.timesplit])).toEqual([[null, null, null], [null, null, null]]);
    expect(exists(r.json)).toBe(true);
    expect(fs.readFileSync(abs(r.md), 'utf8')).toContain('Gate runs: -');
  });

  it('report_corruptJsonlLinesAreSkippedAndTheGoodRowsStillCount', () => {
    writeRows(`${TEL}/command-usage.jsonl`, [before(gate(null)), gate(RUN, 1, 'failure'), gate(RUN, 1, 'success')], ['{not json', '', '[1,2', '"just a string"']);

    const r = subject().report(base());

    expect(r.exitCode).toBe(0);
    expect(r.trace.rows.gate_run.length).toBe(2);
    expect(r.trace.waves[0].counts.gate_runs).toBe(2);
  });

  it('report_aStreamWithNoParseableRowAtAll_isNullNotZero', () => {
    write(`${TEL}/command-usage.jsonl`, '');
    write(`${TEL}/skill-usage.jsonl`, '{garbage\n');

    const { trace } = subject().report(base());

    expect(trace.rows.gate_run).toBeNull();
    expect(trace.rows.command_invocation).toBeNull();
    expect(trace.rows.agent_dispatch).toBeNull();
    expect(trace.waves[0].counts.agent_dispatches).toBeNull();
  });

  it('report_aTranscriptThatCannotBeAnalysed_degradesEveryWaveTimesplitToNull', () => {
    const r = subject().report({ ...base(), transcript: abs('proj') }); // a directory, not a transcript file

    expect(r.exitCode).toBe(0);
    expect(r.trace.waves.map((w) => w.timesplit)).toEqual([null, null]);
  });

  it('report_aPlanWithoutAWaveExecutionLog_degradesTheLogsToNull', () => {
    write(PLAN_REL, '# Plan: fixture\n\nno log here\n');

    const { trace } = subject().report(base());

    expect(trace.waves.map((w) => [w.log, w.commit])).toEqual([[null, null], [null, null]]);
  });

  it('report_missingRunFile_exitsOneAndWritesNoReport', () => {
    fs.rmSync(abs(`${TEL}/runs/${RUN}.json`));

    const r = subject().report(base());

    expect(r.exitCode).toBe(1);
    expect(r.errors[0].rule).toBe('run-not-found');
    expect(exists('docs/.output/.state/work')).toBe(false);
  });

  it('report_corruptRunFile_exitsOneAndWritesNoReport', () => {
    write(`${TEL}/runs/${RUN}.json`, '{"run_id": ');

    const r = subject().report(base());

    expect(r.exitCode).toBe(1);
    expect(r.errors[0].rule).toBe('run-unreadable');
    expect(exists('docs/.output/.state/work')).toBe(false);
  });

  it.each([['../evil'], ['a/b'], [''], ['x'.repeat(101)], [undefined]])('report_invalidRunId_%j_exitsTwoAndWritesNothing', (runId) => {
    const before = tree();

    const r = subject().report({ ...base(), runId });

    expect(r.exitCode).toBe(2);
    expect(r.errors[0].rule).toBe('invalid-args');
    expect(tree()).toEqual(before);
    expect(exists('docs/.output/.state/work')).toBe(false);
  });

  it.each([[null], [undefined], [{ root: 42, runId: RUN }]])('report_hostileOpts_%j_returnsExitTwoInsteadOfThrowing', (opts) => {
    const r = subject().report(opts);

    expect(r.exitCode).toBe(2);
    expect(typeof r.errors[0].rule).toBe('string');
  });
});

// ── AC 3: snapshot appends a wave-close row to a non-rotated run-trace-{runId}.jsonl ─────────────────────────────

describe('snapshot: the wave-close row', () => {
  const SNAP = `${TEL}/run-trace-${RUN}.jsonl`;

  it('snapshot_appendsOneWaveCloseRowWithTheWaveCounts', () => {
    const r = subject().snapshot({ root, now: NOW, runId: RUN, wave: 1 });

    expect(r.exitCode).toBe(0);
    expect(r.path).toBe(SNAP);
    expect(r.row).toEqual({
      ts: NOW.toISOString(), type: 'wave_close', run_id: RUN, wave: 1,
      attribution: 1, gate_runs: 2, gate_failures: 1, command_invocations: 1, agent_dispatches: 2,
    });
    expect(lines(SNAP).map((l) => JSON.parse(l))).toEqual([r.row]);
  });

  it('snapshot_calledForEachWave_appendsAndNeverOverwrites', () => {
    subject().snapshot({ root, now: NOW, runId: RUN, wave: 1 });
    subject().snapshot({ root, now: NOW, runId: RUN, wave: 2 });

    const rows = lines(SNAP).map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.wave, x.gate_runs, x.gate_failures])).toEqual([[1, 2, 1], [2, 1, 0]]);
  });

  it('snapshot_fileIsNeverTailRotated', () => {
    // 6100 pre-existing rows is above the largest stream ceiling (command-usage rotates at 6000): all must survive.
    const seeded = Array.from({ length: 6100 }, (_, i) => ({ ts: iso(0), type: 'wave_close', run_id: RUN, wave: 1, seq: i }));
    writeRows(SNAP, seeded);

    subject().snapshot({ root, now: NOW, runId: RUN, wave: 2 });

    const all = lines(SNAP);
    expect(all.length).toBe(6101);
    expect(JSON.parse(all[0]).seq).toBe(0);
    expect(JSON.parse(all[6100]).wave).toBe(2);
  });

  it('snapshot_missingEmptyOrUnparseableStreams_degradeTheirCountsToNullsAndStillWriteTheRow', () => {
    for (const f of fs.readdirSync(abs(TEL))) if (/^attribution-/.test(f)) fs.rmSync(abs(`${TEL}/${f}`)); // absent
    write(`${TEL}/command-usage.jsonl`, ''); // empty: rotated away
    write(`${TEL}/skill-usage.jsonl`, '{garbage\n[1\n'); // all corrupt

    const r = subject().snapshot({ root, now: NOW, runId: RUN, wave: 1 });

    expect(r.exitCode).toBe(0);
    expect(r.row).toEqual({
      ts: NOW.toISOString(), type: 'wave_close', run_id: RUN, wave: 1,
      attribution: null, gate_runs: null, gate_failures: null, command_invocations: null, agent_dispatches: null,
    });
    expect(lines(SNAP).length).toBe(1);
  });

  it('snapshot_aStreamWithRowsButNoneForTheWave_countsZeroNotNull', () => {
    const r = subject().snapshot({ root, now: NOW, runId: RUN, wave: 9 });

    expect(r.row).toEqual({
      ts: NOW.toISOString(), type: 'wave_close', run_id: RUN, wave: 9,
      attribution: 0, gate_runs: 0, gate_failures: 0, command_invocations: 0, agent_dispatches: 0,
    });
  });

  it('snapshot_withoutRunIdOrWave_takesBothFromTheSessionPointer', () => {
    write(`${TEL}/current-run-${SESSION}.json`, JSON.stringify({ run_id: RUN, plan: null, wave: 2, story: 'SF-1.2', since: '261117-2350' }));

    const r = subject().snapshot({ root, now: NOW, session: SESSION });

    expect(r.exitCode).toBe(0);
    expect(r.row.run_id).toBe(RUN);
    expect(r.row.wave).toBe(2);
    expect(r.row.gate_runs).toBe(1);
  });

  it('snapshot_explicitWave_winsOverThePointerWave', () => {
    write(`${TEL}/current-run-${SESSION}.json`, JSON.stringify({ run_id: RUN, plan: null, wave: 2, story: null, since: '261117-2350' }));

    const r = subject().snapshot({ root, now: NOW, session: SESSION, wave: 1 });

    expect(r.row.wave).toBe(1);
    expect(r.row.gate_runs).toBe(2);
  });

  it.each([
    ['noRunIdAndNoSession', { wave: 1 }, 2],
    ['aSessionWithNoPointer', { session: 'sess-none', wave: 1 }, 2],
    ['aPointerWaveOfNullAndNoWaveOption', { session: SESSION }, 2],
    ['aZeroWave', { runId: RUN, wave: 0 }, 2],
    ['aNonIntegerWave', { runId: RUN, wave: 1.5 }, 2],
    ['aTraversalRunId', { runId: '../evil', wave: 1 }, 2],
    ['aRunWithNoRunFile', { runId: '261117-0000-do-missing', wave: 1 }, 1],
  ])('snapshot_%s_exitsNonZeroAndWritesNothing', (_name, extra, exitCode) => {
    write(`${TEL}/current-run-${SESSION}.json`, JSON.stringify({ run_id: RUN, plan: null, wave: null, story: null, since: '261117-2350' }));
    const before = tree();

    const r = subject().snapshot({ root, now: NOW, ...extra });

    expect(r.exitCode).toBe(exitCode);
    expect(tree()).toEqual(before);
  });

  it.each([[null], [{ root: 42, runId: RUN, wave: 1 }]])('snapshot_hostileOpts_%j_returnsExitTwoInsteadOfThrowing', (opts) => {
    expect(subject().snapshot(opts).exitCode).toBe(2);
  });
});

describe('report: wave-close snapshots survive telemetry rotation', () => {
  const SNAP = `${TEL}/run-trace-${RUN}.jsonl`;
  const closeRow = (wave, fields) => ({ ts: iso(wave * 600), type: 'wave_close', run_id: RUN, wave, attribution: 7, gate_runs: 4, gate_failures: 2, command_invocations: 3, agent_dispatches: 5, ...fields });

  it('report_whenTheLiveStreamsAreGone_usesTheSnapshotCountsAndLeavesUnsnapshottedWavesNull', () => {
    for (const f of fs.readdirSync(abs(TEL))) if (f !== 'runs') fs.rmSync(abs(`${TEL}/${f}`));
    writeRows(SNAP, [closeRow(1, {})]);

    const { trace } = subject().report(base());

    expect(trace.rows.gate_run).toBeNull();
    expect(trace.waves[0].counts).toEqual({ attribution: 7, gate_runs: 4, gate_failures: 2, command_invocations: 3, agent_dispatches: 5 });
    expect(trace.waves[1].counts).toEqual({ attribution: null, gate_runs: null, gate_failures: null, command_invocations: null, agent_dispatches: null });
  });

  it('report_theLatestSnapshotRowOfAWaveWinsOverLiveCountsAndANullFieldFallsBackToLive', () => {
    writeRows(SNAP, [closeRow(1, { gate_runs: 3 }), closeRow(1, { gate_runs: 9, attribution: null })], ['{corrupt']);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts.gate_runs).toBe(9); // later snapshot row beats the earlier one and the live 2
    expect(trace.waves[0].counts.attribution).toBe(1); // snapshot null -> live count
    expect(trace.waves[0].counts.gate_failures).toBe(2); // snapshot 2 beats live 1
    expect(trace.waves[1].counts.gate_runs).toBe(1); // wave 2 has no snapshot: live
  });
});

// ── m7: a wave-close snapshot never hides rows that arrived after it ───────────────────────────────────────────────

describe('m7 report: snapshot and live counts merge as the larger of the two', () => {
  const SNAP = `${TEL}/run-trace-${RUN}.jsonl`;
  const appendRows = (rel, rows) => fs.appendFileSync(abs(rel), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  it('report_rowsAppendedAfterTheSnapshot_areNotHiddenByIt', () => {
    subject().snapshot({ root, now: NOW, runId: RUN, wave: 1 }); // gate_runs 2, gate_failures 1, attribution 1, command 1, dispatch 2
    appendRows(`${TEL}/command-usage.jsonl`, [gate(RUN, 1, 'success'), gate(RUN, 1, 'success'), gate(RUN, 1, 'failure'), cmd(RUN, 1)]);
    appendRows(`${TEL}/skill-usage.jsonl`, [dispatch(RUN, 1)]);
    appendRows(`${TEL}/attribution-261118.jsonl`, [attr(RUN, 1)]);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts).toEqual({ attribution: 2, gate_runs: 5, gate_failures: 2, command_invocations: 2, agent_dispatches: 3 });
  });

  it('report_perFieldTheLargerWins_aHigherSnapshotFieldNextToAHigherLiveField', () => {
    writeRows(SNAP, [{ ts: iso(600), type: 'wave_close', run_id: RUN, wave: 1, attribution: 7, gate_runs: 1, gate_failures: 0, command_invocations: 1, agent_dispatches: 9 }]);

    const { trace } = subject().report(base());

    // live is attribution 1, gate_runs 2, gate_failures 1, commands 1, dispatches 2
    expect(trace.waves[0].counts).toEqual({ attribution: 7, gate_runs: 2, gate_failures: 1, command_invocations: 1, agent_dispatches: 9 });
  });

  it('report_aSnapshotEqualToTheLiveCount_changesNothing', () => {
    subject().snapshot({ root, now: NOW, runId: RUN, wave: 1 });
    const withSnapshot = subject().report(base()).trace.waves[0].counts;
    fs.rmSync(abs(SNAP));

    expect(subject().report(base()).trace.waves[0].counts).toEqual(withSnapshot);
  });
});

// ── m8: a stream rotated past the wave reads null, not 0 ───────────────────────────────────────────────────────────

describe('m8 report and snapshot: a tail-rotated stream is unknown, not zero', () => {
  const SNAP = `${TEL}/run-trace-${RUN}.jsonl`;

  it('report_commandUsageHoldingOnlyRowsNewerThanTheWaveStart_isNullForThatWaveNotZero', () => {
    // wave 1 starts at iso(0); the stream's first row is iso(2) and holds nothing for wave 1: the early rows are gone
    writeRows(`${TEL}/command-usage.jsonl`, [gate(null, undefined, 'failure'), gate(RUN, 2, 'success'), cmd(RUN, 2)]);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts.gate_runs).toBeNull();
    expect(trace.waves[0].counts.gate_failures).toBeNull();
    expect(trace.waves[0].counts.command_invocations).toBeNull();
    expect(trace.waves[1].counts.gate_runs).toBe(1); // the stream does cover wave 2 (it starts before iso(600))
    expect(trace.waves[1].counts.command_invocations).toBe(1);
    expect(trace.waves[0].counts.agent_dispatches).toBe(2); // other streams are judged on their own start
  });

  it('report_skillUsageStartingAfterTheWaveStart_isNullToo', () => {
    writeRows(`${TEL}/skill-usage.jsonl`, [dispatch(RUN, 1), dispatch(RUN, 2)]);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts.agent_dispatches).toBeNull();
    expect(trace.waves[1].counts.agent_dispatches).toBe(1);
  });

  it('report_attributionFileBelowItsTailKeep_wasNeverRotated_soItCounts', () => {
    // First adopter run, 2026-11-20: appends began in wave 4, so the day file's first row was newer than the wave start.
    for (const f of fs.readdirSync(abs(TEL))) if (/^attribution-/.test(f)) fs.rmSync(abs(`${TEL}/${f}`));
    writeRows(`${TEL}/attribution-261118.jsonl`, [attr(RUN, 1), attr(RUN, 2)]);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts.attribution).toBe(1);
    expect(trace.waves[1].counts.attribution).toBe(1);
  });

  it('report_attributionFileAtItsTailKeep_startingAfterTheWaveStart_isNull', () => {
    for (const f of fs.readdirSync(abs(TEL))) if (/^attribution-/.test(f)) fs.rmSync(abs(`${TEL}/${f}`));
    writeRows(`${TEL}/attribution-261118.jsonl`, [...Array.from({ length: 499 }, () => attr(OTHER, 2)), attr(RUN, 2)]);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts.attribution).toBeNull();
    expect(trace.waves[1].counts.attribution).toBe(1);
  });

  it('report_aStreamThatStartsExactlyAtTheWaveStart_isNotRotated', () => {
    writeRows(`${TEL}/command-usage.jsonl`, [{ ...gate(RUN, 1, 'success'), timestamp: iso(0) }]);

    expect(subject().report(base()).trace.waves[0].counts.gate_runs).toBe(1);
  });

  it('report_aStreamWithNoParseableTimestamps_cannotBeJudgedRotatedAndKeepsItsCount', () => {
    writeRows(`${TEL}/command-usage.jsonl`, [{ type: 'gate_run', outcome: 'success', run_id: RUN, wave: 1 }, { type: 'gate_run', timestamp: 'garbage', outcome: 'failure', run_id: RUN, wave: 1 }]);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts.gate_runs).toBe(2);
    expect(trace.waves[0].counts.gate_failures).toBe(1);
  });

  it('report_theRowsArrayStillHoldsTheRunsRowsWhenTheWaveCountIsNull', () => {
    writeRows(`${TEL}/command-usage.jsonl`, [gate(RUN, 1, 'success')]);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts.gate_runs).toBeNull();
    expect(trace.rows.gate_run.length).toBe(1);
  });

  it('report_aRotatedStreamWithASnapshot_takesTheSnapshotCountNotAFalseLiveZero', () => {
    writeRows(`${TEL}/command-usage.jsonl`, [gate(RUN, 2, 'success')]);
    writeRows(SNAP, [{ ts: iso(600), type: 'wave_close', run_id: RUN, wave: 1, attribution: null, gate_runs: 4, gate_failures: 1, command_invocations: null, agent_dispatches: null }]);

    const { trace } = subject().report(base());

    expect(trace.waves[0].counts.gate_runs).toBe(4);
    expect(trace.waves[0].counts.gate_failures).toBe(1);
    expect(trace.waves[0].counts.command_invocations).toBeNull();
  });

  it('snapshot_ofARotatedStream_writesNullNotAFrozenZero', () => {
    writeRows(`${TEL}/command-usage.jsonl`, [gate(RUN, 2, 'success')]);

    const r = subject().snapshot({ root, now: NOW, runId: RUN, wave: 1 });

    expect(r.row.gate_runs).toBeNull();
    expect(r.row.gate_failures).toBeNull();
    expect(r.row.command_invocations).toBeNull();
    expect(r.row.attribution).toBe(1);
    expect(subject().snapshot({ root, now: NOW, runId: RUN, wave: 2 }).row.gate_runs).toBe(1);
  });

  it('snapshot_aWaveNotInTheRunFile_hasNoStartAndIsCountedNotJudgedRotated', () => {
    writeRows(`${TEL}/command-usage.jsonl`, [gate(RUN, 9, 'success')]);

    expect(subject().snapshot({ root, now: NOW, runId: RUN, wave: 9 }).row.gate_runs).toBe(1);
  });

  it('report_everyWaveNullWhenTheStreamStartsAfterTheRunEnded', () => {
    writeRows(`${TEL}/command-usage.jsonl`, [{ ...gate(RUN, 2, 'success'), timestamp: iso(5000) }]);

    const { trace } = subject().report(base());

    expect(trace.waves.map((w) => [w.counts.gate_runs, w.counts.gate_failures, w.counts.command_invocations])).toEqual([[null, null, null], [null, null, null]]);
  });
});

// ── n4: adjacent windows are half-open and the transcript is parsed once ───────────────────────────────────────────

describe('n4 report: wave windows share a boundary without double counting, and the transcript is read once', () => {
  const user = (sec, text) => ({ type: 'user', timestamp: iso(sec), message: { role: 'user', content: text } });
  const reply = (sec, text) => ({ type: 'assistant', timestamp: iso(sec), message: { role: 'assistant', content: [{ type: 'text', text }] } });

  it('report_anEventExactlyOnTheWaveBoundary_countsInTheLaterWaveOnly', () => {
    transcript = write(`proj/${SESSION}.jsonl`, jsonl([user(5, 'go'), reply(10, 'a'), reply(600, 'edge'), reply(610, 'b')]));

    const { trace } = subject().report(base());

    expect(trace.waves[0].timesplit.wallSeconds).toBe(5); // events at 5 and 10; the iso(600) event is wave 2's
    expect(trace.waves[1].timesplit.wallSeconds).toBe(10); // events at 600 and 610
    expect(trace.waves[0].timesplit.window).toEqual({ since: iso(0), until: iso(600) }); // the reported window is unchanged
  });

  it('report_theLastWavesWindowStaysInclusiveAtTheRunFinish', () => {
    transcript = write(`proj/${SESSION}.jsonl`, jsonl([user(700, 'go'), reply(1200, 'at finish')]));

    const { trace } = subject().report(base());

    expect(trace.waves[1].timesplit.wallSeconds).toBe(500); // 700 -> 1200, the finish instant included
  });

  it('report_readsTheTranscriptAndEachSubagentFileOnceAcrossAllWaves', () => {
    const subagent = path.join(root, 'proj', SESSION, 'subagents', 'agent-s1.jsonl');
    const spy = vi.spyOn(fs, 'readFileSync');
    try {
      const { trace } = subject().report(base());
      const reads = (file) => spy.mock.calls.filter((c) => String(c[0]) === file).length;

      expect(trace.waves.length).toBe(2);
      expect(reads(transcript)).toBe(1);
      expect(reads(subagent)).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('report_perWaveTimesplitIsIdenticalWithAndWithoutTheSharedParse', () => {
    const { trace } = subject().report(base());
    const direct = require('../session-timesplit').analyzeSession(transcript, { since: iso(0), until: iso(600), untilExclusive: true });

    expect(trace.waves[0].timesplit).toEqual(direct);
  });
});

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('CLI', () => {
  const cliEnv = () => {
    const e = { ...process.env, CLAUDE_PROJECT_DIR: root };
    for (const k of ['AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'AGENT_SHARED_STATE_ROOT', 'CLAUDE_CODE_SESSION_ID']) delete e[k];
    return e;
  };
  const run = (args, env = cliEnv()) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, cwd: root });

  it('requiringTheModule_doesNotRunTheCliOrExit', () => {
    expect(typeof subject().main).toBe('function');
    expect(typeof subject().report).toBe('function');
    expect(typeof subject().snapshot).toBe('function');
  });

  it('report_printsOneJsonDocumentAndWritesTheReportUnderTheWorkFolder', () => {
    const r = run(['report', RUN, '--transcript', transcript]);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.exitCode).toBe(0);
    expect(out.run_id).toBe(RUN);
    expect(out.dir).toMatch(new RegExp(`^docs/\\.output/\\.state/work/\\d{4}-\\d{2}-\\d{2}/${RUN}$`));
    expect(exists(out.json)).toBe(true);
    expect(readJson(out.json).waves[0].timesplit.wallSeconds).toBe(15);
  });

  it('report_missingRunFile_exitsOne', () => {
    const r = run(['report', '261117-0000-do-missing']);

    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).exitCode).toBe(1);
  });

  it('snapshot_withRunIdAndWave_appendsTheRowAndPrintsIt', () => {
    const r = run(['snapshot', '--run-id', RUN, '--wave', '1']);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.path).toBe(`${TEL}/run-trace-${RUN}.jsonl`);
    expect(out.row.gate_runs).toBe(2);
    expect(lines(out.path).length).toBe(1);
  });

  it('snapshot_withSessionFromTheEnvironment_readsThePointer', () => {
    write(`${TEL}/current-run-${SESSION}.json`, JSON.stringify({ run_id: RUN, plan: null, wave: 2, story: null, since: '261117-2350' }));

    const r = run(['snapshot'], { ...cliEnv(), CLAUDE_CODE_SESSION_ID: SESSION });

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).row.wave).toBe(2);
  });

  it.each([
    ['noVerb', []],
    ['unknownVerb', ['frobnicate']],
    ['reportWithoutARunId', ['report']],
    ['unknownFlag', ['report', RUN, '--bogus', 'x']],
    ['flagWithoutAValue', ['report', RUN, '--plan']],
    ['flagFollowedByAnotherFlag', ['report', RUN, '--plan', '--transcript', 'x']],
    ['repeatedFlag', ['snapshot', '--wave', '1', '--wave', '2']],
    ['snapshotWithABadWave', ['snapshot', '--run-id', RUN, '--wave', 'x']],
  ])('cli_%s_exitsTwoAndWritesNothing', (_name, argv) => {
    const before = tree();

    const r = run(argv);

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/\[run-trace\] refusing:/);
    expect(tree()).toEqual(before);
  });
});
