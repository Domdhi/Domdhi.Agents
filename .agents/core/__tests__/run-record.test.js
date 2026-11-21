// SF-3.1: tests for `.agents/core/run-record.js`: a run's id, session pointer, result and exit codes. Deep tier: the
// persisted record shape and the exit codes are consumed by schedulers (SF-3.6, SF-3.8), the row writers (SF-3.2,
// SF-3.3) and the scoreboard (SF-4.1).
//
// PINNED CONTRACT. The implementer must match these names, signatures and shapes; the tests are the spec.
//
// Exports (CommonJS; the CLI is guarded by `require.main === module`, so requiring the file never exits):
//   start(opts)        -> result   open a run: write runs/{runId}.json and the session pointer
//   wave(opts)         -> result   move the session pointer to a wave (and record the wave on the run)
//   finish(opts)       -> result   write the run's result, append/replace the plan line, drop the pointer
//   readPointer({ root, session }) -> pointer object | null   (absent, unreadable, corrupt or wrong-shape -> null, never throws)
//   main(argv = process.argv.slice(2), env = process.env) -> exit code number; prints exactly ONE JSON document to stdout
//   Common opts: root (absolute project root), session (session id), now (Date; the clock for every timestamp and stamp).
//     start:  { command, input, runId, budget }
//     wave:   { wave (positive integer), story, plan }
//     finish: { runId, status, commit, plan, receipt, shipToken, fixRounds, reviewMajor, misalignments, outputTokens }
//   No export ever throws: any exception, even a hostile `opts` (null, a number for root, ...), becomes
//   { exitCode: 2, errors: [{ rule: 'exception', message }] }. Every result has `exitCode`; errors use
//   { exitCode: 2, errors: [{ rule, message }] } with rule `invalid-args` for bad input.
//
// CLI (root = CLAUDE_PROJECT_DIR when set, else the repo root; relative `--plan` is relative to the cwd):
//   run-record.js start  --command do|run-todo --input ID [--run-id X] [--budget "<plan Budget line>"] [--session S]
//   run-record.js wave   --wave N [--story ID[,ID...]] [--plan PATH] [--session S]
//   run-record.js finish --status passed|failed|blocked|needs-human|budget-exhausted|killed [--run-id X]
//                        [--commit SHA] [--plan PATH] [--receipt ID] [--ship-token OK|SKIP]
//                        [--fix-rounds N] [--review-major N] [--misalignments N] [--output-tokens N] [--session S]
//   run-record.js current [--session S]        (the read verb: prints the pointer JSON, or the literal `null`; exit 0)
//   A flag's value is the next argv element verbatim unless it starts with `--` (so `--review-major -1` is a bad value, not a
//   missing one). Every flag takes a value, appears at most once; an unknown flag, an unknown or missing verb, a missing required
//   flag or a flag without a value is exit 2. Beyond the AC text: `--session`, `--run-id` on finish, the `current` verb
//   and `wave --plan/--story`; the AC lists `finish --commit/--plan/--receipt` unbracketed but "unknown values are null"
//   makes them optional, so only `--status` is required (plus a resolvable run).
//   stdout: exactly one JSON document, `exitCode` included; for exit 2 also stderr `[run-record] refusing: {message}`.
//
// SESSION SOURCE (justified): `--session S`, else env CLAUDE_CODE_SESSION_ID. Claude Code sets that variable in every
// subprocess it spawns (command-usage-logger.cjs resolveSessionId reads the same variable first), so a bare
// `run-record.js start` from the Bash tool works with no flag; the explicit flag exists because the Bash tool keeps no
// shell state, so a scheduler or a headless wrapper (SF-3.6) cannot export a variable across calls and passes it
// per call. The hook payload's `session_id` is a hook-only source; a CLI has no payload. Neither source set ->
// exit 2 (start, wave, current; finish only when no `--run-id` is given). A session id is a filename component:
// /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/ or exit 2, and a refused id writes nothing anywhere.
//
// Run id: `{stamp}-{command}-{slug(input)}` where stamp = stamp(now) from `_lib/run-stamp.js` (YYMMDD-HHMM, local) and
// slug(input) = lowercase, every run of characters outside [a-z0-9] collapsed to one '-', leading/trailing '-' trimmed
// (empty slug or empty input -> exit 2). `--run-id X` is honored when X matches /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
// (else exit 2). `start` NEVER overwrites a run file: an explicit id that exists is exit 2; a derived id that exists
// (two sessions starting the same command and input in the same minute) gets `-2`, `-3`, ... until free.
//
// Files (under docs/.output/.state/telemetry/):
//   runs/{runId}.json  at start: { run_id, command, input, session_id, budget (parseBudget output | null), since
//                      (the YYMMDD-HHMM start stamp), started_at (ISO of now), waves: [] } (extra keys allowed);
//                      each `wave` call appends { wave, story, ts }; finish adds
//                      result: { status, exit_code, commit, receipt, ship_token, plan (repo-relative, forward slashes | null),
//                                finished_at (ISO of now), record } where `record` is the plan-line object below.
//   current-run-{session_id}.json  EXACTLY the keys { run_id, plan, wave, story, since } (the "run id and session
//                      pointer" seam). start: plan null, wave null, story null. wave sets wave (number), story (the given
//                      string, or null when not given), plan (repo-relative when given, else retained). finish removes
//                      the pointer of the finishing session when it points at the finished run (a stale pointer would
//                      stamp later rows with a dead run id); another session's pointer is untouched.
//   Budget: `--budget` goes through parseBudget imported from `_lib/failure-ledger.js`; run-record defines no
//   parser, key list or regex of its own. The parsed limits object is stored in the run file.
//
// finish resolves the run from `--run-id` when given (the run file must exist), else from the session pointer; neither
// -> exit 2. It validates every input (status, commit /^[0-9a-f]{7,40}$/i, receipt /^[A-Za-z0-9._-]{1,64}$/, ship-token
// OK|SKIP, the four counters as non-negative integers, plan) BEFORE writing anything; a refused finish changes nothing.
// Exit codes (the "run result and exit codes" seam): passed 0, failed 1, needs-human 10, blocked 11,
// budget-exhausted 12, killed 13; invalid input 2. The CLI process exit code equals result.exitCode.
//
// Plan line: when `plan` is given (must be an existing regular file matching `docs/.output/plans/*.md` inside the repository, reached
// without a symlink; else exit 2 and the file is untouched: Wave 4 review M1) finish keeps exactly ONE line `**Run record:** {json}` per run id in the plan. A first finish
// appends it as the last line (the file ends with one newline). A repeated finish for the same run id REPLACES that
// line in place (latest wins; never a second line for the run). A different run id in the same plan appends its own
// line. A `**Run record:**` line that is not valid JSON, or belongs to another run, is left untouched. Without `plan`
// the plan is never touched (the pointer's plan is not used). {json} is the single-line `result.record` object:
//   { run_id, command, input, status, commit, receipt, ship_token, waves, stories, gate_runs, gate_failures,
//     first_pass_green_waves, fix_rounds, review_major, dispatches, misalignments, stops, output_tokens }
// where each of the last eleven is { value, source } with source 'derived' (waves, stories, gate_runs, gate_failures,
// first_pass_green_waves, dispatches, stops) or 'reported' (fix_rounds, review_major, misalignments, output_tokens).
// An unknown value is null, never omitted, and its source label stays.
// Derivations (since = the run's `since` stamp; all counts are of rows with ts >= since):
//   waves / stories   distinct wave numbers / distinct story ids (the `story` strings split on commas) recorded by
//                     `wave`; 0 when none; null when the run file is unreadable or corrupt.
//   gate_runs         rows of command-usage.jsonl with type 'gate_run' and run_id === the run id; null when the file is absent.
//   gate_failures     gate-failures.jsonl rows with passed !== true and no `killed` (environment and flaky rows count,
//                     as in `failure-ledger budget`); null when the ledger file is absent.
//   first_pass_green_waves  a wave's window runs from its first `wave` call to the next distinct wave's first call (the
//                     last wave: to finish); a wave is first-pass green when the first ledger row in its window that
//                     is not killed has passed === true (killed rows are neutral; an empty window is not green); null
//                     when the ledger is absent or the run file is unreadable.
//   dispatches        attribution-{YYMMDD}.jsonl rows (days since..now) with timestamp >= since, EXCLUDING rows whose
//                     run_id is a string other than this run (SF-3.2 stamps it); rows without run_id count; null when
//                     no attribution file exists for any day in the window.
//   stops             1 for blocked, needs-human, budget-exhausted, killed; 0 for passed and failed. Never null.
//   Reported fields take the flag value (0 stays 0) or null.
// Corrupt JSONL lines are skipped; an absent or corrupt source degrades its field to null and never crashes.
//
// RETENTION DECISION (the story left it open): runs/{runId}.json is kept indefinitely. A run file is a few hundred
// bytes, the scoreboard reads them, and cleanup-logs.js prunes only telemetry/logs; run-record prunes nothing.
//
// NOT COVERED (reported to the owner): two truly concurrent `start` calls racing for one derived id (needs exclusive
// create, `wx`; covered only sequentially); Windows (the symlink case is skipped there); a pointer or run file
// swapped for a FIFO; atomic-rename behavior of the writes; a transcript-derived `output_tokens` (the model reports it).

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve('.agents/core/run-record.js');
const SOURCE_FILE = SCRIPT;
const fl = require('../_lib/failure-ledger');
const { createLinkedWorktree } = require('./_helpers/linked-worktree');
const { pointerFilePath, readRunPointer } = require('../_lib/run-pointer');
const { ledgerFilename, dateStamp } = require('../_lib/attribution-ledger');
const subject = () => require('../run-record');

const isWindows = process.platform === 'win32';
const TELEMETRY = 'docs/.output/.state/telemetry';
const RUNS = `${TELEMETRY}/runs`;
const PLAN_REL = 'docs/.output/plans/261118-1200-run-todo-fixture.md';
const PLAN_TEXT = '# Plan: fixture\n\n**Status:** complete\n\n## Wave Execution Log\n\n### Wave 1\n- done\n';
const RECORD_RE = /^\*\*Run record:\*\* (.+)$/;
const FIELD_SOURCES = {
  waves: 'derived', stories: 'derived', gate_runs: 'derived', gate_failures: 'derived',
  first_pass_green_waves: 'derived', fix_rounds: 'reported', review_major: 'reported',
  dispatches: 'derived', misalignments: 'reported', stops: 'derived', output_tokens: 'reported',
};
const RECORD_KEYS = ['run_id', 'command', 'input', 'status', 'commit', 'receipt', 'ship_token', ...Object.keys(FIELD_SOURCES)].sort();
const STATUS_EXIT = [
  ['passed', 0], ['failed', 1], ['needs-human', 10], ['blocked', 11], ['budget-exhausted', 12], ['killed', 13],
];

// Fixed local clock: every in-process call is given `now`, so nothing depends on the wall clock or the time zone.
const T0 = new Date(2026, 10, 18, 12, 0, 0);
const at = (min) => new Date(T0.getTime() + min * 60000);
const iso = (min) => at(min).toISOString();
const RUN_ID = '261118-1200-run-todo-sf-3-1';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

// ── the commits `finish --ship-token OK` is checked against (security review m4) ──────────────
// `--ship-token OK` is accepted only when the named (or HEAD) commit carries a `Ship-Check:` trailer, so the fixtures
// need real commits. The fixture roots are not repositories (and the writtenFiles checks count every file in them),
// so the commits live in bare repositories outside the roots and finish is pointed at one through GIT_DIR.
const GIT_IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const trailerRepos = [];
function trailerGit(dir, args, input) {
  const r = spawnSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8', windowsHide: true, input: input === undefined ? '' : input, env: { ...process.env, ...GIT_IDENTITY } });
  if (r.status !== 0) throw new Error(`fixture: git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
/** A bare repository whose only commit has `message` and is HEAD. Returns { dir, sha }. */
function trailerRepo(message) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-record-trailers-')));
  trailerRepos.push(dir);
  trailerGit(dir, ['init', '-q', '--bare', '-b', 'main']);
  const tree = trailerGit(dir, ['mktree']);
  const sha = trailerGit(dir, ['commit-tree', tree, '-m', message]);
  trailerGit(dir, ['update-ref', 'refs/heads/main', sha]);
  return { dir, sha };
}
afterAll(() => { for (const d of trailerRepos.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const SHIPPED = trailerRepo('feat: shipped\n\nShip-Check: a1b2c3d4e5f6');
const SHIP_SHA = SHIPPED.sha;
const TRAILER_GIT_DIR = SHIPPED.dir;
/** Run `fn` with GIT_DIR pointing at the trailer repository (for the in-process finish calls). */
function withTrailers(fn, dir = TRAILER_GIT_DIR) {
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = dir;
  try { return fn(); } finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; }
}

// ── fixtures ────────────────────────────────────────────────────────

function mkRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-record-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'docs/.output/plans'), { recursive: true });
  fs.writeFileSync(path.join(root, PLAN_REL), PLAN_TEXT);
  return root;
}
const abs = (root, rel) => path.join(root, rel);
const runFile = (root, runId = RUN_ID) => abs(root, `${RUNS}/${runId}.json`);
const pointerFile = (root, session) => abs(root, `${TELEMETRY}/current-run-${session}.json`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readPlan = (root) => fs.readFileSync(abs(root, PLAN_REL), 'utf8');
const recordLines = (text) => text.split('\n').filter((l) => l.startsWith('**Run record:**'));

/** Every file under `dir` (relative paths); [] when it does not exist. */
function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}
/** Everything in the root except the fixture plan. */
const writtenFiles = (root) => listFiles(root).filter((f) => f !== PLAN_REL.split('/').join(path.sep));

function seedLedger(root, rows) {
  for (const r of rows) {
    const written = fl.appendFailure({ head: 'h', sig: null, legs: ['test'], passed: false, killed: null, ...r }, { root });
    expect(written, 'seeding the failure ledger must succeed').not.toBeNull();
  }
}
const passRow = (min) => ({ ts: iso(min), passed: true });
const failRow = (min, sig = 'sig-a') => ({ ts: iso(min), sig });
const killedRow = (min) => ({ ts: iso(min), killed: 'TIMEOUT' });

function seedJsonl(root, name, rows, extraLines = []) {
  const file = abs(root, `${TELEMETRY}/${name}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = rows.map((r) => JSON.stringify(r));
  fs.appendFileSync(file, `${[...lines, ...extraLines].join('\n')}\n`);
  return file;
}
function seedAttribution(root, rows, extraLines = []) {
  const byDay = new Map();
  for (const r of rows) {
    const day = ledgerFilename(dateStamp(new Date(r.timestamp)));
    byDay.set(day, [...(byDay.get(day) || []), r]);
  }
  for (const [name, dayRows] of byDay) seedJsonl(root, name, dayRows, extraLines);
}
const attrRow = (min, extra = {}) => ({ timestamp: iso(min), story_id: 'S-1', agent: 'general-purpose', model: null, files_touched: [], status: 'done', ...extra });
const gateRunRow = (min, runId) => ({ timestamp: iso(min), type: 'gate_run', command: 'gate:test', outcome: 'success', session_id: 'x', ...(runId === undefined ? {} : { run_id: runId }) });

const STRIPPED_ENV = new Set(['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'AGENTS_RUNTIME', 'CI']);
function childEnv(root, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIPPED_ENV.has(k) || k === 'VITEST' || k.startsWith('VITEST_')) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_PROJECT_DIR: root, ...extra };
}
/** Run the real CLI. It must print exactly one JSON document (or the literal `null` for `current`). */
function cli(root, args, { env = {}, cwd = root } = {}) {
  expect(fs.existsSync(SCRIPT), 'run-record.js must exist at .agents/core/run-record.js').toBe(true);
  const trailerEnv = args.includes('OK') ? { GIT_DIR: TRAILER_GIT_DIR } : {};
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: childEnv(root, { ...trailerEnv, ...env }), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  expect(json, `stdout must be exactly one JSON document (status ${r.status}, stderr: ${r.stderr})`).not.toBeUndefined();
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** In-process start for a session at T0 (or `now`); asserts success unless `expectOk` is false. */
function begin(root, { session = 'sess-a', command = 'run-todo', input = 'SF-3.1', now = T0, ...rest } = {}) {
  const res = subject().start({ root, session, command, input, now, ...rest });
  expect(res.exitCode, JSON.stringify(res)).toBe(0);
  return res;
}
// m6: a `passed` finish needs the proof of shipping (commit, receipt, ship token); the default carries it.
const PROOF = { commit: SHIP_SHA, receipt: 'rcpt-1', shipToken: 'OK' };
const NO_PROOF = { commit: undefined, receipt: undefined, shipToken: undefined };
function fin(root, opts = {}, gitDir = TRAILER_GIT_DIR) {
  return withTrailers(() => subject().finish({ root, session: 'sess-a', now: at(40), status: 'passed', ...PROOF, ...opts }), gitDir);
}
const rules = (res) => [...new Set((res.errors || []).map((e) => e.rule))].sort();

// ── start: the record, the pointer and the run id ───────────────────

describe('run-record start: files and shapes', () => {
  it('start_validInput_writesRunRecordAndSessionPointerAtTheSeamPaths', () => {
    const root = mkRoot();

    const res = begin(root);

    expect(res.run_id).toBe(RUN_ID);
    expect(readJson(runFile(root))).toMatchObject({
      run_id: RUN_ID, command: 'run-todo', input: 'SF-3.1', session_id: 'sess-a', budget: null,
      since: '261118-1200', started_at: T0.toISOString(), waves: [],
    });
    expect(listFiles(abs(root, TELEMETRY))).toEqual(
      ['current-run-sess-a.json', `runs${path.sep}${RUN_ID}.json`].sort(),
    );
  });

  it('start_validInput_pointerHasExactlyTheSeamKeysWithNullWaveStoryPlan', () => {
    const root = mkRoot();

    begin(root);

    expect(readJson(pointerFile(root, 'sess-a'))).toEqual({ run_id: RUN_ID, plan: null, wave: null, story: null, since: '261118-1200' });
  });

  it.each([
    ['run-todo', 'SF-3.1', '261118-1200-run-todo-sf-3-1'],
    ['do', 'Fix the Thing!', '261118-1200-do-fix-the-thing'],
    ['do', '  --Weird__Input.v2  ', '261118-1200-do-weird-input-v2'],
  ])('start_derivedRunId_isStampCommandSlug (%s, %j)', (command, input, expected) => {
    const root = mkRoot();

    const res = begin(root, { command, input });

    expect(res.run_id).toBe(expected);
    expect(fs.existsSync(runFile(root, expected))).toBe(true);
  });

  it('start_derivedRunId_usesTheRunStampModuleAndTheInjectedClock', () => {
    const root = mkRoot();
    const source = fs.readFileSync(SOURCE_FILE, 'utf8');

    const res = begin(root, { now: new Date(2027, 0, 5, 3, 7, 59) });

    expect(source).toMatch(/require\(\s*['"]\.\/_lib\/run-stamp['"]\s*\)/);
    expect(res.run_id).toBe('270105-0307-run-todo-sf-3-1');
    expect(readJson(pointerFile(root, 'sess-a')).since).toBe('270105-0307');
  });

  it('start_explicitRunId_isHonoredVerbatimAndSinceStaysTheStartStamp', () => {
    const root = mkRoot();

    const res = begin(root, { runId: '261118-1200-run-todo-my.custom_run-1' });

    expect(res.run_id).toBe('261118-1200-run-todo-my.custom_run-1');
    expect(readJson(runFile(root, '261118-1200-run-todo-my.custom_run-1')).since).toBe('261118-1200');
    expect(readJson(pointerFile(root, 'sess-a')).run_id).toBe('261118-1200-run-todo-my.custom_run-1');
  });

  it.each([
    ['empty', ''], ['parent traversal', '../x'], ['subdirectory', 'a/b'], ['backslash', 'a\\b'], ['leading dot', '.hidden'],
    ['dotdot', '..'], ['space', 'x y'], ['colon', 'a:b'], ['leading dash', '-lead'], ['101 chars', 'x'.repeat(101)],
  ])('start_invalidExplicitRunId_%s_exits2AndWritesNothing', (_name, runId) => {
    const root = mkRoot();

    const res = subject().start({ root, session: 'sess-a', command: 'do', input: 'x', runId, now: T0 });

    expect(res.exitCode).toBe(2);
    expect(rules(res)).toEqual(['invalid-args']);
    expect(writtenFiles(root)).toEqual([]);
  });

  it('start_explicitRunIdThatAlreadyExists_exits2AndLeavesTheExistingRecordUntouched', () => {
    const root = mkRoot();
    begin(root, { runId: 'fixed-run-1' });
    const before = fs.readFileSync(runFile(root, 'fixed-run-1'), 'utf8');

    const res = subject().start({ root, session: 'sess-b', command: 'do', input: 'other', runId: 'fixed-run-1', now: at(5) });

    expect(res.exitCode).toBe(2);
    expect(fs.readFileSync(runFile(root, 'fixed-run-1'), 'utf8')).toBe(before);
    expect(fs.existsSync(pointerFile(root, 'sess-b'))).toBe(false);
  });

  it('start_twoSessionsSameCommandInputSameMinute_getDistinctRunIdsAndSeparatePointers', () => {
    const root = mkRoot();

    const a = begin(root, { session: 'sess-a' });
    const b = begin(root, { session: 'sess-b' });
    const c = begin(root, { session: 'sess-c' });

    expect([a.run_id, b.run_id, c.run_id]).toEqual([RUN_ID, `${RUN_ID}-2`, `${RUN_ID}-3`]);
    expect(readJson(pointerFile(root, 'sess-a')).run_id).toBe(RUN_ID);
    expect(readJson(pointerFile(root, 'sess-b')).run_id).toBe(`${RUN_ID}-2`);
    expect(readJson(pointerFile(root, 'sess-c')).run_id).toBe(`${RUN_ID}-3`);
    expect(readJson(runFile(root, `${RUN_ID}-2`)).session_id).toBe('sess-b');
  });

  it('start_sameSessionStartsAgain_pointerMovesToTheNewRunAndTheOldRunFileStays', () => {
    const root = mkRoot();
    begin(root, { session: 'sess-a', command: 'do', input: 'first' });

    const second = begin(root, { session: 'sess-a', command: 'do', input: 'second', now: at(3) });

    expect(readJson(pointerFile(root, 'sess-a')).run_id).toBe(second.run_id);
    expect(second.run_id).toBe('261118-1203-do-second');
    expect(fs.existsSync(runFile(root, '261118-1200-do-first'))).toBe(true);
  });

  it.each([
    ['empty', ''], ['traversal', '../../escape'], ['slash', 'a/b'], ['space', 'a b'], ['leading dash', '-x'], ['129 chars', 's'.repeat(129)],
  ])('start_invalidSessionId_%s_exits2AndWritesNothingAnywhere', (_name, session) => {
    const root = mkRoot();

    const res = subject().start({ root, session, command: 'do', input: 'x', now: T0 });

    expect(res.exitCode).toBe(2);
    expect(writtenFiles(root)).toEqual([]);
    expect(fs.existsSync(path.join(path.dirname(root), 'escape.json'))).toBe(false);
  });

  it.each([
    ['unknown command', { command: 'deploy', input: 'x' }],
    ['missing command', { input: 'x' }],
    ['missing input', { command: 'do' }],
    ['empty input', { command: 'do', input: '' }],
    ['input with no letters or digits', { command: 'do', input: '***' }],
  ])('start_%s_exits2AndWritesNothing', (_name, extra) => {
    const root = mkRoot();

    const res = subject().start({ root, session: 'sess-a', now: T0, ...extra });

    expect(res.exitCode).toBe(2);
    expect(rules(res)).toEqual(['invalid-args']);
    expect(writtenFiles(root)).toEqual([]);
  });
});

// ── --budget: one parser, parseBudget from failure-ledger ───────────

describe('run-record start: --budget goes through parseBudget', () => {
  it.each([
    ['bare pairs', 'attempts=3 gate-failures=6 dispatches=40 minutes=240'],
    ['the plan line with its bold label', '**Budget:** attempts=3 gate-failures=6 dispatches=40 minutes=240'],
    ['a bullet, commas and a subset of keys', '- **Budget:** attempts=2,minutes=60'],
  ])('start_budget_%s_storesExactlyWhatParseBudgetReturns', (_name, line) => {
    const root = mkRoot();

    begin(root, { budget: line });

    const stored = readJson(runFile(root)).budget;
    expect(stored).toEqual(fl.parseBudget(line));
    expect(Object.keys(stored).length).toBeGreaterThan(0);
  });

  it.each([
    ['an unknown key', 'attempts=3 turbo=9'],
    ['a duplicate key', 'attempts=3 attempts=4'],
    ['a negative value', 'attempts=-1'],
    ['a non-integer value', 'minutes=1.5'],
    ['no pairs', '**Budget:**'],
    ['a token without an equals sign', 'attempts'],
    ['a non-string', 42],
  ])('start_budget_%s_exits2WritesNothingAndParseBudgetRejectsItToo', (_name, line) => {
    const root = mkRoot();
    expect(() => fl.parseBudget(line)).toThrow();

    const res = subject().start({ root, session: 'sess-a', command: 'do', input: 'x', budget: line, now: T0 });

    expect(res.exitCode).toBe(2);
    expect(writtenFiles(root)).toEqual([]);
  });

  it('start_noBudget_storesNull', () => {
    const root = mkRoot();

    begin(root);

    expect(readJson(runFile(root)).budget).toBeNull();
  });

  it('source_runRecord_importsParseBudgetFromFailureLedgerAndDefinesNoParserOrKeyList', () => {
    const raw = fs.readFileSync(SOURCE_FILE, 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code).toMatch(/require\(\s*['"]\.\/_lib\/failure-ledger['"]\s*\)/);
    expect(code).toMatch(/parseBudget/);
    expect(code).not.toMatch(/function\s+parseBudget|parseBudget\s*=\s*(?:\(|function|async|[a-z]+\s*=>)/);
    expect(code).not.toMatch(/BUDGET_KEYS|['"`]attempts['"`]|['"`]gate-failures['"`]/);
  });
});

// ── wave ────────────────────────────────────────────────────────────

describe('run-record wave: the pointer follows the run', () => {
  it('wave_afterStart_updatesPointerWaveStoryAndPlanKeepingRunIdAndSince', () => {
    const root = mkRoot();
    begin(root);

    const res = subject().wave({ root, session: 'sess-a', wave: 2, story: 'SF-1.1', plan: PLAN_REL, now: at(10) });

    expect(res.exitCode).toBe(0);
    expect(readJson(pointerFile(root, 'sess-a'))).toEqual({ run_id: RUN_ID, plan: PLAN_REL, wave: 2, story: 'SF-1.1', since: '261118-1200' });
  });

  it('wave_withoutStoryOrPlan_resetsStoryToNullAndRetainsThePlan', () => {
    const root = mkRoot();
    begin(root);
    subject().wave({ root, session: 'sess-a', wave: 1, story: 'SF-1.1', plan: PLAN_REL, now: at(1) });

    subject().wave({ root, session: 'sess-a', wave: 2, now: at(2) });

    expect(readJson(pointerFile(root, 'sess-a'))).toEqual({ run_id: RUN_ID, plan: PLAN_REL, wave: 2, story: null, since: '261118-1200' });
  });

  it('wave_calls_appendWaveEntriesToTheRunFile', () => {
    const root = mkRoot();
    begin(root);

    subject().wave({ root, session: 'sess-a', wave: 1, story: 'SF-1.1', now: at(1) });
    subject().wave({ root, session: 'sess-a', wave: 2, now: at(2) });

    expect(readJson(runFile(root)).waves).toEqual([
      { wave: 1, story: 'SF-1.1', ts: iso(1) },
      { wave: 2, story: null, ts: iso(2) },
    ]);
  });

  it('wave_planGivenAbsoluteInsideTheRepo_isStoredRepoRelativeWithForwardSlashes', () => {
    const root = mkRoot();
    begin(root);

    subject().wave({ root, session: 'sess-a', wave: 1, plan: abs(root, PLAN_REL), now: at(1) });

    expect(readJson(pointerFile(root, 'sess-a')).plan).toBe(PLAN_REL);
  });

  it.each([['zero', 0], ['negative', -1], ['fraction', 1.5], ['a string', 'two'], ['missing', undefined], ['NaN', NaN]])(
    'wave_number_%s_exits2AndLeavesThePointerUnchanged',
    (_name, waveNo) => {
      const root = mkRoot();
      begin(root);
      const before = fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8');

      const res = subject().wave({ root, session: 'sess-a', wave: waveNo, now: at(1) });

      expect(res.exitCode).toBe(2);
      expect(fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8')).toBe(before);
    },
  );

  it.each([['dotdot', '../outside.md'], ['absolute elsewhere', path.join(os.tmpdir(), 'elsewhere-plan.md')]])(
    'wave_planOutsideTheRepo_%s_exits2AndLeavesThePointerUnchanged',
    (_name, plan) => {
      const root = mkRoot();
      begin(root);
      const before = fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8');

      const res = subject().wave({ root, session: 'sess-a', wave: 1, plan, now: at(1) });

      expect(res.exitCode).toBe(2);
      expect(fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8')).toBe(before);
    },
  );

  it('wave_noPointerForTheSession_exits2AndWritesNothing', () => {
    const root = mkRoot();

    const res = subject().wave({ root, session: 'sess-a', wave: 1, now: at(1) });

    expect(res.exitCode).toBe(2);
    expect(writtenFiles(root)).toEqual([]);
  });

  it.each([['not JSON', '{nope'], ['empty file', ''], ['a JSON array', '[]'], ['JSON without run_id', '{"wave":1}']])(
    'wave_corruptPointer_%s_exits2AndLeavesTheBytesAlone',
    (_name, content) => {
      const root = mkRoot();
      fs.mkdirSync(abs(root, TELEMETRY), { recursive: true });
      fs.writeFileSync(pointerFile(root, 'sess-a'), content);

      const res = subject().wave({ root, session: 'sess-a', wave: 1, now: at(1) });

      expect(res.exitCode).toBe(2);
      expect(fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8')).toBe(content);
    },
  );

  it('wave_twoSessionsInOneTree_eachMovesOnlyItsOwnPointer', () => {
    const root = mkRoot();
    begin(root, { session: 'sess-a' });
    begin(root, { session: 'sess-b' });
    const bBefore = fs.readFileSync(pointerFile(root, 'sess-b'), 'utf8');

    subject().wave({ root, session: 'sess-a', wave: 3, story: 'SF-9.9', now: at(2) });

    expect(readJson(pointerFile(root, 'sess-a')).wave).toBe(3);
    expect(fs.readFileSync(pointerFile(root, 'sess-b'), 'utf8')).toBe(bBefore);
    expect(readJson(runFile(root, `${RUN_ID}-2`)).waves).toEqual([]);
  });
});

// ── finish: the exit-code seam ──────────────────────────────────────

describe('run-record finish: status to exit code', () => {
  it.each(STATUS_EXIT)('finish_cliStatus_%s_exitsWith%i', (status, code) => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    const started = cli(root, ['start', '--command', 'do', '--input', 'exit-table'], { env });
    expect(started.status).toBe(0);

    const out = cli(root, ['finish', '--status', status, '--commit', SHIP_SHA, '--receipt', 'rc-1', '--ship-token', 'OK'], { env });

    expect(out.status).toBe(code);
    expect(out.json.exitCode).toBe(code);
    const run = readJson(runFile(root, started.json.run_id));
    expect(run.result).toMatchObject({ status, exit_code: code });
  });

  it.each(STATUS_EXIT)('finish_inProcessStatus_%s_returnsExitCode%i', (status, code) => {
    const root = mkRoot();
    begin(root);

    const res = fin(root, { status });

    expect(res.exitCode).toBe(code);
    expect(readJson(runFile(root)).result.finished_at).toBe(at(40).toISOString());
  });

  it.each([['unknown word', 'success'], ['wrong case', 'PASSED'], ['empty', ''], ['missing', undefined], ['underscore variant', 'needs_human']])(
    'finish_status_%s_exits2AndChangesNothing',
    (_name, status) => {
      const root = mkRoot();
      begin(root);
      const before = [fs.readFileSync(runFile(root), 'utf8'), fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8')];

      const res = fin(root, { status, plan: PLAN_REL });

      expect(res.exitCode).toBe(2);
      expect([fs.readFileSync(runFile(root), 'utf8'), fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8')]).toEqual(before);
      expect(readPlan(root)).toBe(PLAN_TEXT);
    },
  );

  it('finish_afterFinishing_removesThisSessionsPointerButNotAnotherSessions', () => {
    const root = mkRoot();
    begin(root, { session: 'sess-a' });
    begin(root, { session: 'sess-b' });

    fin(root, { session: 'sess-a' });

    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(false);
    expect(readJson(pointerFile(root, 'sess-b')).run_id).toBe(`${RUN_ID}-2`);
  });

  // m2 changed this pin: the run's own session pointer (named by the run file's session_id) is dropped even when the
  // finish names no session; only a pointer of ANOTHER run survives.
  it('finish_withExplicitRunIdAndNoSession_finishesThatRunDropsItsOwnPointerAndLeavesForeignPointers', () => {
    const root = mkRoot();
    begin(root, { session: 'sess-a' });
    begin(root, { session: 'sess-b', input: 'second' });

    const res = subject().finish({ root, runId: RUN_ID, status: 'failed', now: at(40) });

    expect(res.exitCode).toBe(1);
    expect(readJson(runFile(root)).result.status).toBe('failed');
    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(false);
    expect(readJson(pointerFile(root, 'sess-b')).run_id).toBe('261118-1200-run-todo-second');
  });

  it.each([
    ['unknown run id', { runId: 'no-such-run' }],
    ['no pointer and no run id', { session: 'sess-none' }],
  ])('finish_%s_exits2AndWritesNothing', (_name, extra) => {
    const root = mkRoot();

    const res = subject().finish({ root, status: 'passed', now: at(40), ...extra });

    expect(res.exitCode).toBe(2);
    expect(writtenFiles(root)).toEqual([]);
  });

  it.each([
    ['commit too short', { commit: 'abc12' }], ['commit not hex', { commit: 'zzzzzzz' }], ['commit with a flag shape', { commit: '--force' }],
    ['receipt with a slash', { receipt: '../r' }], ['receipt 65 chars', { receipt: 'r'.repeat(65) }],
    ['ship token lowercase', { shipToken: 'ok' }], ['ship token unknown', { shipToken: 'MAYBE' }],
    ['negative fix rounds', { fixRounds: -1 }], ['fractional review major', { reviewMajor: 1.5 }],
    ['string misalignments', { misalignments: 'many' }], ['NaN output tokens', { outputTokens: NaN }],
  ])('finish_%s_exits2AndChangesNothing', (_name, extra) => {
    const root = mkRoot();
    begin(root);
    const before = [fs.readFileSync(runFile(root), 'utf8'), fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8')];

    const res = fin(root, { plan: PLAN_REL, ...extra });

    expect(res.exitCode).toBe(2);
    expect([fs.readFileSync(runFile(root), 'utf8'), fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8')]).toEqual(before);
    expect(readPlan(root)).toBe(PLAN_TEXT);
  });

  it('finish_validIdentifiers_areStoredAndAbsentOnesAreNull', () => {
    const root = mkRoot();
    begin(root, { session: 'sess-a' });
    begin(root, { session: 'sess-b', input: 'second' });

    fin(root, { session: 'sess-a', commit: 'ABCDEF1234567', receipt: 'abc123def456', shipToken: 'SKIP' });
    fin(root, { session: 'sess-b', status: 'failed', ...NO_PROOF });

    expect(readJson(runFile(root)).result).toMatchObject({ commit: 'ABCDEF1234567', receipt: 'abc123def456', ship_token: 'SKIP', plan: null });
    expect(readJson(runFile(root, '261118-1200-run-todo-second')).result).toMatchObject({ commit: null, receipt: null, ship_token: null, plan: null });
  });
});

// ── finish: the tracked plan line ───────────────────────────────────

describe('run-record finish: the **Run record:** plan line', () => {
  it('finish_withPlan_appendsExactlyOneLineWhoseJsonIsTheResultRecord', () => {
    const root = mkRoot();
    begin(root);

    const res = fin(root, { plan: PLAN_REL, commit: SHIP_SHA, receipt: 'rcpt-1', shipToken: 'OK', fixRounds: 2, reviewMajor: 1, misalignments: 0, outputTokens: 123456 });

    const text = readPlan(root);
    const lines = recordLines(text);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(RECORD_RE.exec(lines[0])[1]);
    expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
    expect(record).toEqual(res.record);
    expect(readJson(runFile(root)).result.record).toEqual(record);
    expect(readJson(runFile(root)).result.plan).toBe(PLAN_REL);
    expect(text.startsWith(PLAN_TEXT)).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(PLAN_TEXT.length)).toBe(`${lines[0]}\n`);
  });

  it('finish_withPlan_recordCarriesIdentityOutcomeAndASourceLabelPerField', () => {
    const root = mkRoot();
    begin(root);

    const res = fin(root, { plan: PLAN_REL, status: 'killed', commit: SHIP_SHA, receipt: 'rcpt-1', shipToken: 'OK', fixRounds: 2, reviewMajor: 1, misalignments: 0, outputTokens: 123456 });

    expect(res.exitCode).toBe(13);
    expect(res.record).toMatchObject({ run_id: RUN_ID, command: 'run-todo', input: 'SF-3.1', status: 'killed', commit: SHIP_SHA, receipt: 'rcpt-1', ship_token: 'OK' });
    for (const [field, source] of Object.entries(FIELD_SOURCES)) {
      expect(Object.keys(res.record[field]).sort(), field).toEqual(['source', 'value']);
      expect(res.record[field].source, field).toBe(source);
    }
    expect(res.record.fix_rounds).toEqual({ value: 2, source: 'reported' });
    expect(res.record.review_major).toEqual({ value: 1, source: 'reported' });
    expect(res.record.misalignments).toEqual({ value: 0, source: 'reported' });
    expect(res.record.output_tokens).toEqual({ value: 123456, source: 'reported' });
  });

  it('finish_unknownReportedValues_areNullWithTheirSourceLabelNotOmitted', () => {
    const root = mkRoot();
    begin(root);

    const res = fin(root, { plan: PLAN_REL, status: 'failed', ...NO_PROOF });

    expect(res.record.fix_rounds).toEqual({ value: null, source: 'reported' });
    expect(res.record.review_major).toEqual({ value: null, source: 'reported' });
    expect(res.record.misalignments).toEqual({ value: null, source: 'reported' });
    expect(res.record.output_tokens).toEqual({ value: null, source: 'reported' });
    expect(res.record).toMatchObject({ commit: null, receipt: null, ship_token: null });
  });

  it('finish_planWithoutTrailingNewline_getsOneNewlineThenTheLine', () => {
    const root = mkRoot();
    fs.writeFileSync(abs(root, PLAN_REL), '# Plan\n- no trailing newline');
    begin(root);

    fin(root, { plan: PLAN_REL });

    const text = readPlan(root);
    expect(text.startsWith('# Plan\n- no trailing newline\n**Run record:** ')).toBe(true);
    expect(recordLines(text)).toHaveLength(1);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('finish_repeatedForTheSameRun_replacesTheLineInPlaceAndNeverAddsASecond', () => {
    const root = mkRoot();
    begin(root);
    fin(root, { plan: PLAN_REL, status: 'failed' });
    const firstText = readPlan(root);

    // m5 changed this pin: a retry keeps the recorded status (a different one is refused); the line is replaced in place.
    const second = fin(root, { plan: PLAN_REL, status: 'failed', fixRounds: 3, runId: RUN_ID, now: at(50) });

    const text = readPlan(root);
    expect(second.exitCode).toBe(1);
    expect(recordLines(text)).toHaveLength(1);
    expect(JSON.parse(RECORD_RE.exec(recordLines(text)[0])[1])).toMatchObject({ run_id: RUN_ID, status: 'failed', fix_rounds: { value: 3, source: 'reported' } });
    expect(text.split('\n')).toHaveLength(firstText.split('\n').length);
    expect(text.startsWith(PLAN_TEXT)).toBe(true);
    expect(readJson(runFile(root)).result).toMatchObject({ status: 'failed', exit_code: 1, finished_at: at(50).toISOString() });
  });

  it('finish_repeatedInTheMiddleOfAPlan_replacesInPlaceAndKeepsTheTextAfterIt', () => {
    const root = mkRoot();
    begin(root);
    fin(root, { plan: PLAN_REL, status: 'blocked' });
    const withTail = `${readPlan(root)}\n## Appendix\n- after the line\n`;
    fs.writeFileSync(abs(root, PLAN_REL), withTail);

    fin(root, { plan: PLAN_REL, runId: RUN_ID, status: 'blocked', now: at(55) });

    const text = readPlan(root);
    expect(recordLines(text)).toHaveLength(1);
    expect(text.endsWith('\n## Appendix\n- after the line\n')).toBe(true);
    expect(JSON.parse(RECORD_RE.exec(recordLines(text)[0])[1]).status).toBe('blocked');
  });

  it('finish_twoRunsFinishingIntoOnePlan_eachKeepsItsOwnSingleLine', () => {
    const root = mkRoot();
    begin(root, { session: 'sess-a' });
    begin(root, { session: 'sess-b', input: 'second' });

    fin(root, { session: 'sess-a', plan: PLAN_REL });
    fin(root, { session: 'sess-b', plan: PLAN_REL, status: 'failed' });

    const ids = recordLines(readPlan(root)).map((l) => JSON.parse(RECORD_RE.exec(l)[1]).run_id);
    expect(ids).toEqual([RUN_ID, '261118-1200-run-todo-second']);
  });

  it('finish_planHoldsAMalformedRunRecordLine_leavesItAndStillWritesOurOwn', () => {
    const root = mkRoot();
    const junk = '**Run record:** {not json';
    fs.writeFileSync(abs(root, PLAN_REL), `${PLAN_TEXT}${junk}\n`);
    begin(root);

    const res = fin(root, { plan: PLAN_REL });

    const lines = recordLines(readPlan(root));
    expect(res.exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(junk);
    expect(JSON.parse(RECORD_RE.exec(lines[1])[1]).run_id).toBe(RUN_ID);
  });

  it('finish_withoutAPlanPath_neverTouchesThePlanAndStillWritesTheResult', () => {
    const root = mkRoot();
    begin(root);
    subject().wave({ root, session: 'sess-a', wave: 1, plan: PLAN_REL, now: at(1) });

    const res = fin(root, { status: 'needs-human' });

    expect(res.exitCode).toBe(10);
    expect(readPlan(root)).toBe(PLAN_TEXT);
    expect(readJson(runFile(root)).result).toMatchObject({ status: 'needs-human', plan: null });
  });

  it.each([
    ['dotdot', () => '../outside.md'],
    ['absolute elsewhere', () => path.join(os.tmpdir(), 'run-record-outside-plan.md')],
    ['a missing file', (root) => abs(root, 'docs/.output/plans/never-created.md')],
    ['a directory', (root) => abs(root, 'docs/.output/plans')],
  ])('finish_plan_%s_exits2AndWritesNoResult', (_name, planFor) => {
    const root = mkRoot();
    begin(root);
    const before = fs.readFileSync(runFile(root), 'utf8');

    const res = fin(root, { plan: planFor(root), status: 'failed' });

    expect(res.exitCode).toBe(2);
    expect(rules(res)).toEqual(['invalid-args']);
    expect(fs.readFileSync(runFile(root), 'utf8')).toBe(before);
    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(true);
    expect(readPlan(root)).toBe(PLAN_TEXT);
  });

  it.skipIf(isWindows)('finish_planSymlinkPointingOutsideTheRepo_exits2AndTheTargetIsUntouched', () => {
    const root = mkRoot();
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-record-outside-')));
    roots.push(outsideDir);
    const outside = path.join(outsideDir, 'plan.md');
    fs.writeFileSync(outside, '# outside plan\n');
    fs.symlinkSync(outside, abs(root, 'docs/linked-plan.md'));
    begin(root);

    const res = fin(root, { plan: 'docs/linked-plan.md' });

    expect(res.exitCode).toBe(2);
    expect(fs.readFileSync(outside, 'utf8')).toBe('# outside plan\n');
  });
});

// ── finish: derived and reported fields ─────────────────────────────

describe('run-record finish: derived fields', () => {
  /** A run with four waves at 12:01, :10, :20, :30 and the finish at 12:40. */
  function fourWaveRun(root) {
    begin(root);
    subject().wave({ root, session: 'sess-a', wave: 1, story: 'S-1.1', now: at(1) });
    subject().wave({ root, session: 'sess-a', wave: 2, story: 'S-1.2, S-1.3', now: at(10) });
    subject().wave({ root, session: 'sess-a', wave: 3, story: 'S-1.3', now: at(20) });
    subject().wave({ root, session: 'sess-a', wave: 4, now: at(30) });
  }

  it('finish_waveAndStoryCounts_areDistinctValuesRecordedByWave', () => {
    const root = mkRoot();
    fourWaveRun(root);
    subject().wave({ root, session: 'sess-a', wave: 4, story: 'S-1.1', now: at(31) });

    const res = fin(root);

    expect(res.record.waves).toEqual({ value: 4, source: 'derived' });
    expect(res.record.stories).toEqual({ value: 3, source: 'derived' });
  });

  it('wave_aRunTodoWaveWithoutStory_isRefused_butAnAdHocDoWaveIsNot', () => {
    const root = mkRoot();
    begin(root, { command: 'run-todo' });
    const refused = subject().wave({ root, session: 'sess-a', wave: 1, now: at(1), storyRequiredForRunTodo: true });
    expect(refused.exitCode).toBe(2);
    expect(JSON.stringify(refused.errors)).toMatch(/requires --story/);

    const doRoot = mkRoot();
    begin(doRoot, { command: 'do', input: 'ad-hoc task' });
    expect(subject().wave({ root: doRoot, session: 'sess-a', wave: 1, now: at(1), storyRequiredForRunTodo: true }).exitCode).toBe(0);
  });

  it('finish_aWaveRecordedWithNoStoryList_makesTheStoryCountUnknown', () => {
    const root = mkRoot();
    fourWaveRun(root);
    subject().wave({ root, session: 'sess-a', wave: 5, now: at(32) });

    const res = fin(root);

    expect(res.record.stories).toEqual({ value: null, source: 'derived' });
  });

  it('finish_dispatchesTakeTheLargerOfAttributionAndThisRunsHookLaunches', () => {
    const root = mkRoot();
    const runId = begin(root).run_id;
    const iso = (m) => at(m).toISOString();
    const rows = [
      { type: 'agent_dispatch', timestamp: iso(2), run_id: runId },
      { type: 'agent_dispatch', timestamp: iso(3), run_id: runId },
      { type: 'agent_dispatch', timestamp: iso(4), run_id: runId, hook_event_name: 'SubagentStop' },
      { type: 'agent_dispatch', timestamp: iso(5), run_id: 'another-run' },
    ];
    fs.mkdirSync(path.join(root, 'docs/.output/.state/telemetry'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/.output/.state/telemetry/skill-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const res = fin(root);

    expect(res.record.dispatches).toEqual({ value: 2, source: 'derived' });
  });

  it('finish_aRunWithNoWaveCalls_countsZeroWavesAndZeroStories', () => {
    const root = mkRoot();
    begin(root);

    const res = fin(root);

    expect(res.record.waves).toEqual({ value: 0, source: 'derived' });
    expect(res.record.stories).toEqual({ value: 0, source: 'derived' });
  });

  it('finish_ledgerRows_giveGateFailuresAndFirstPassGreenWavesPerWaveWindow', () => {
    const root = mkRoot();
    fourWaveRun(root);
    seedLedger(root, [
      { ts: new Date(T0.getTime() - 2 * 86400000).toISOString(), sig: 'old-failure' }, // two days before the run: excluded
      passRow(5), // wave 1: pass first -> green
      failRow(12), passRow(15), // wave 2: fail then pass -> not first-pass green
      killedRow(22), passRow(25), // wave 3: killed is neutral, pass first -> green
      // wave 4: no ledger rows -> not green
    ]);

    const res = fin(root);

    expect(res.record.gate_failures).toEqual({ value: 1, source: 'derived' });
    expect(res.record.first_pass_green_waves).toEqual({ value: 2, source: 'derived' });
  });

  it('finish_gateFailures_countEnvironmentRowsAndSkipKilledAndPassedRows', () => {
    const root = mkRoot();
    begin(root);
    seedLedger(root, [
      failRow(2, 'a'), { ts: iso(3), sig: 'b', cls: 'environment' }, killedRow(4), passRow(5), failRow(6, 'a'),
    ]);

    const res = fin(root);

    expect(res.record.gate_failures).toEqual({ value: 3, source: 'derived' });
  });

  it('finish_gateRuns_countsOnlyGateRunRowsCarryingThisRunId', () => {
    const root = mkRoot();
    begin(root);
    seedJsonl(root, 'command-usage.jsonl', [
      gateRunRow(5, RUN_ID), gateRunRow(6, RUN_ID), gateRunRow(7, RUN_ID),
      gateRunRow(8, 'some-other-run'), gateRunRow(9), // another run, and a row with no run_id
      { timestamp: iso(10), type: 'command_invocation', command: 'do', run_id: RUN_ID }, // right run, wrong type
    ], ['{corrupt']);

    const res = fin(root);

    expect(res.record.gate_runs).toEqual({ value: 3, source: 'derived' });
  });

  it('finish_dispatches_countAttributionRowsSinceStartExcludingOtherRunsRows', () => {
    const root = mkRoot();
    begin(root);
    seedAttribution(root, [
      attrRow(-1), // before the run
      attrRow(5), // counted
      attrRow(12, { run_id: RUN_ID }), // counted
      attrRow(20, { run_id: 'a-different-run' }), // another run's work in the same tree
      attrRow(25), // counted
    ], ['not json at all']);

    const res = fin(root);

    expect(res.record.dispatches).toEqual({ value: 3, source: 'derived' });
  });

  it.each([
    ['passed', 0], ['failed', 0], ['blocked', 1], ['needs-human', 1], ['budget-exhausted', 1], ['killed', 1],
  ])('finish_stopsForStatus_%s_is%i', (status, stops) => {
    const root = mkRoot();
    begin(root);

    const res = fin(root, { status });

    expect(res.record.stops).toEqual({ value: stops, source: 'derived' });
  });

  it('finish_reportedZeroCounters_stayZeroNotNull', () => {
    const root = mkRoot();
    begin(root);

    const res = fin(root, { fixRounds: 0, reviewMajor: 0, misalignments: 0, outputTokens: 0 });

    expect([res.record.fix_rounds.value, res.record.review_major.value, res.record.misalignments.value, res.record.output_tokens.value]).toEqual([0, 0, 0, 0]);
  });
});

describe('run-record finish: absent or corrupt sources degrade to null', () => {
  it('finish_noLedgerNoAttributionNoCommandUsage_ledgerAndRowDerivedFieldsAreNull', () => {
    const root = mkRoot();
    begin(root);

    const res = fin(root);

    expect(res.exitCode).toBe(0);
    expect(res.record.gate_runs).toEqual({ value: null, source: 'derived' });
    expect(res.record.gate_failures).toEqual({ value: null, source: 'derived' });
    expect(res.record.first_pass_green_waves).toEqual({ value: null, source: 'derived' });
    expect(res.record.dispatches).toEqual({ value: null, source: 'derived' });
    expect(res.record.waves).toEqual({ value: 0, source: 'derived' });
  });

  it('finish_corruptLedgerAndAttributionLines_areSkippedAndTheValidRowsStillCount', () => {
    const root = mkRoot();
    begin(root);
    seedLedger(root, [failRow(3), passRow(4)]);
    fs.appendFileSync(abs(root, `${TELEMETRY}/gate-failures.jsonl`), '{broken\n[1,2]\n"str"\n');
    seedAttribution(root, [attrRow(2), attrRow(3)], ['{broken', '[]']);

    const res = fin(root);

    expect(res.exitCode).toBe(0);
    expect(res.record.gate_failures).toEqual({ value: 1, source: 'derived' });
    expect(res.record.dispatches).toEqual({ value: 2, source: 'derived' });
  });

  it('finish_ledgerRowWithGarbageTimestamp_isIgnoredWithoutCrashing', () => {
    const root = mkRoot();
    begin(root);
    seedJsonl(root, 'gate-failures.jsonl', [{ ts: null, passed: false }, { ts: {}, passed: false }, { ts: 'yesterday-ish', passed: false }, { passed: false }]);
    seedLedger(root, [failRow(3)]);

    const res = fin(root);

    expect(res.exitCode).toBe(0);
    expect(res.record.gate_failures).toEqual({ value: 1, source: 'derived' });
  });

  it.each([['not JSON', '{nope'], ['empty file', ''], ['a JSON array', '[]'], ['a JSON string', '"run"']])(
    'finish_corruptRunFile_%s_stillFinishesFromThePointerWithNullRunDerivedFields',
    (_name, content) => {
      const root = mkRoot();
      begin(root);
      fs.writeFileSync(runFile(root), content);

      const res = fin(root, { plan: PLAN_REL, status: 'failed' });

      expect(res.exitCode).toBe(1);
      expect(res.record.run_id).toBe(RUN_ID);
      expect(res.record.command).toBeNull();
      expect(res.record.input).toBeNull();
      expect(res.record.waves).toEqual({ value: null, source: 'derived' });
      expect(res.record.stories).toEqual({ value: null, source: 'derived' });
      expect(res.record.first_pass_green_waves).toEqual({ value: null, source: 'derived' });
      expect(recordLines(readPlan(root))).toHaveLength(1);
    },
  );

  it('finish_pointerPointsAtARunWhoseFileIsGone_stillFinishesWithNullRunDerivedFields', () => {
    const root = mkRoot();
    begin(root);
    fs.rmSync(runFile(root));

    const res = fin(root, { status: 'killed' });

    expect(res.exitCode).toBe(13);
    expect(res.record).toMatchObject({ run_id: RUN_ID, command: null, waves: { value: null, source: 'derived' } });
  });

  it.each([['not JSON', '{nope'], ['empty file', ''], ['a JSON array', '[]'], ['JSON without run_id', '{"wave":1}']])(
    'finish_corruptPointerAndNoRunId_%s_exits2WithoutCrashing',
    (_name, content) => {
      const root = mkRoot();
      fs.mkdirSync(abs(root, TELEMETRY), { recursive: true });
      fs.writeFileSync(pointerFile(root, 'sess-a'), content);

      const res = fin(root, { plan: PLAN_REL });

      expect(res.exitCode).toBe(2);
      expect(readPlan(root)).toBe(PLAN_TEXT);
    },
  );
});

// ── pointer reads ───────────────────────────────────────────────────

describe('run-record readPointer and the current verb', () => {
  it('readPointer_afterStartAndWave_returnsTheSeamShape', () => {
    const root = mkRoot();
    begin(root);
    subject().wave({ root, session: 'sess-a', wave: 2, story: 'S-2', plan: PLAN_REL, now: at(1) });

    const pointer = subject().readPointer({ root, session: 'sess-a' });

    expect(pointer).toEqual({ run_id: RUN_ID, plan: PLAN_REL, wave: 2, story: 'S-2', since: '261118-1200' });
  });

  it.each([['absent', null], ['not JSON', '{nope'], ['empty', ''], ['an array', '[]'], ['no run_id', '{"wave":1}']])(
    'readPointer_%s_returnsNullAndNeverThrows',
    (_name, content) => {
      const root = mkRoot();
      if (content !== null) {
        fs.mkdirSync(abs(root, TELEMETRY), { recursive: true });
        fs.writeFileSync(pointerFile(root, 'sess-a'), content);
      }

      expect(subject().readPointer({ root, session: 'sess-a' })).toBeNull();
    },
  );

  it('readPointer_invalidSessionOrHostileOpts_returnsNull', () => {
    const root = mkRoot();

    expect(subject().readPointer({ root, session: '../x' })).toBeNull();
    expect(subject().readPointer(null)).toBeNull();
    expect(subject().readPointer({ root: 7, session: {} })).toBeNull();
  });

  it('readPointer_pointerIsADirectory_returnsNull', () => {
    const root = mkRoot();
    fs.mkdirSync(pointerFile(root, 'sess-a'), { recursive: true });

    expect(subject().readPointer({ root, session: 'sess-a' })).toBeNull();
  });

  it('current_cliWithPointer_printsThePointerAndExits0', () => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    const started = cli(root, ['start', '--command', 'do', '--input', 'cur'], { env });

    const out = cli(root, ['current'], { env });

    expect(out.status).toBe(0);
    expect(out.json).toEqual({ run_id: started.json.run_id, plan: null, wave: null, story: null, since: expect.stringMatching(/^\d{6}-\d{4}$/) });
  });

  it('current_cliWithoutPointer_printsNullAndExits0', () => {
    const root = mkRoot();

    const out = cli(root, ['current'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-none' } });

    expect(out.status).toBe(0);
    expect(out.json).toBeNull();
  });
});

// ── CLI: grammar, session source, output contract ───────────────────

describe('run-record CLI', () => {
  it('cli_start_usesTheSessionEnvVarWhenNoFlagAndStampsTheRunIdFromTheClock', () => {
    const root = mkRoot();
    const before = new Date();

    const out = cli(root, ['start', '--command', 'run-todo', '--input', 'SF-3.1', '--budget', '**Budget:** attempts=3 minutes=60'], { env: { CLAUDE_CODE_SESSION_ID: 'env-session' } });

    const after = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stampOf = (d) => `${pad(d.getFullYear() % 100)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    expect(out.status).toBe(0);
    expect(out.json.exitCode).toBe(0);
    expect([stampOf(before), stampOf(after)]).toContain(out.json.run_id.slice(0, 11));
    expect(out.json.run_id.slice(11)).toBe('-run-todo-sf-3-1');
    expect(readJson(pointerFile(root, 'env-session')).run_id).toBe(out.json.run_id);
    expect(readJson(runFile(root, out.json.run_id))).toMatchObject({ session_id: 'env-session', budget: { attempts: 3, minutes: 60 } });
  });

  it('cli_start_sessionFlagWinsOverTheEnvVar', () => {
    const root = mkRoot();

    const out = cli(root, ['start', '--command', 'do', '--input', 'x', '--session', 'flag-session'], { env: { CLAUDE_CODE_SESSION_ID: 'env-session' } });

    expect(out.status).toBe(0);
    expect(fs.existsSync(pointerFile(root, 'flag-session'))).toBe(true);
    expect(fs.existsSync(pointerFile(root, 'env-session'))).toBe(false);
  });

  it.each([['start', ['--command', 'do', '--input', 'x']], ['wave', ['--wave', '1']], ['current', []], ['finish', ['--status', 'passed']]])(
    'cli_%s_noSessionFlagAndNoEnv_exits2',
    (verb, rest) => {
      const root = mkRoot();

      const out = cli(root, [verb, ...rest]);

      expect(out.status).toBe(2);
      expect(out.json.exitCode).toBe(2);
      expect(out.stderr).toMatch(/\[run-record\] refusing: /);
      expect(writtenFiles(root)).toEqual([]);
    },
  );

  it('cli_finish_withRunIdNeedsNoSession', () => {
    const root = mkRoot();
    const started = cli(root, ['start', '--command', 'do', '--input', 'x', '--session', 's1']);

    const out = cli(root, ['finish', '--status', 'blocked', '--run-id', started.json.run_id]);

    expect(out.status).toBe(11);
  });

  it.each([
    ['no verb', []],
    ['an unknown verb', ['begin']],
    ['an unknown flag', ['start', '--command', 'do', '--input', 'x', '--turbo', '1']],
    ['a repeated flag', ['start', '--command', 'do', '--command', 'do', '--input', 'x']],
    ['a flag without a value', ['start', '--command', 'do', '--input']],
    ['a missing required flag', ['finish']],
    ['wave without --wave', ['wave']],
    ['a stray positional', ['start', 'extra', '--command', 'do', '--input', 'x']],
  ])('cli_grammar_%s_exits2WithOneJsonDocumentAndAStderrLine', (_name, args) => {
    const root = mkRoot();

    const out = cli(root, args, { env: { CLAUDE_CODE_SESSION_ID: 'sess-cli' } });

    expect(out.status).toBe(2);
    expect(out.json.exitCode).toBe(2);
    expect(out.json.errors.length).toBeGreaterThan(0);
    expect(out.stderr).toMatch(/\[run-record\] refusing: /);
    expect(writtenFiles(root)).toEqual([]);
  });

  it.each([['fix-rounds', 'abc'], ['fix-rounds', '1.5'], ['review-major', '-1'], ['misalignments', ''], ['output-tokens', 'lots']])(
    'cli_finish_%s_%j_exits2AndChangesNothing',
    (flag, value) => {
      const root = mkRoot();
      const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
      const started = cli(root, ['start', '--command', 'do', '--input', 'x'], { env });
      const before = fs.readFileSync(runFile(root, started.json.run_id), 'utf8');

      const out = cli(root, ['finish', '--status', 'passed', `--${flag}`, value], { env });

      expect(out.status).toBe(2);
      expect(fs.readFileSync(runFile(root, started.json.run_id), 'utf8')).toBe(before);
    },
  );

  it('cli_fullRun_startWaveFinishAppendsTheLineAndExitsWithTheSeamCode', () => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    const started = cli(root, ['start', '--command', 'run-todo', '--input', 'SF-3.1', '--run-id', 'cli-run-1'], { env });
    expect(started.json.run_id).toBe('cli-run-1');

    const waved = cli(root, ['wave', '--wave', '1', '--story', 'SF-3.1', '--plan', PLAN_REL], { env });
    // Orchestrator correction: the pointer is read before `finish`, which removes it (the seam rule).
    const pointerAfterWave = readJson(pointerFile(root, 'sess-cli'));
    const done = cli(root, ['finish', '--status', 'budget-exhausted', '--commit', 'a1b2c3d', '--plan', PLAN_REL, '--receipt', 'rc-1', '--ship-token', 'SKIP', '--fix-rounds', '2', '--review-major', '1', '--misalignments', '0', '--output-tokens', '9000'], { env });

    expect(waved.status).toBe(0);
    expect(pointerAfterWave).toEqual({ run_id: 'cli-run-1', plan: PLAN_REL, wave: 1, story: 'SF-3.1', since: expect.stringMatching(/^\d{6}-\d{4}$/) });
    expect(done.status).toBe(12);
    expect(fs.existsSync(pointerFile(root, 'sess-cli'))).toBe(false);
    const lines = recordLines(readPlan(root));
    expect(lines).toHaveLength(1);
    const record = JSON.parse(RECORD_RE.exec(lines[0])[1]);
    expect(record).toMatchObject({
      run_id: 'cli-run-1', status: 'budget-exhausted', commit: 'a1b2c3d', receipt: 'rc-1', ship_token: 'SKIP',
      fix_rounds: { value: 2, source: 'reported' }, review_major: { value: 1, source: 'reported' },
      misalignments: { value: 0, source: 'reported' }, output_tokens: { value: 9000, source: 'reported' },
      waves: { value: 1, source: 'derived' }, stories: { value: 1, source: 'derived' }, stops: { value: 1, source: 'derived' },
    });
  });

  it('cli_planOutsideTheRepo_exits2AndWritesNoResult', () => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    const started = cli(root, ['start', '--command', 'do', '--input', 'x'], { env });
    const before = fs.readFileSync(runFile(root, started.json.run_id), 'utf8');

    const out = cli(root, ['finish', '--status', 'failed', '--plan', '../outside.md'], { env });

    expect(out.status).toBe(2);
    expect(fs.readFileSync(runFile(root, started.json.run_id), 'utf8')).toBe(before);
  });
});

// ── hostile input, never throws ─────────────────────────────────────

describe('run-record never throws', () => {
  it.each([
    ['start', undefined], ['start', null], ['start', 5], ['start', { root: 123, session: 's', command: 'do', input: 'x' }],
    ['wave', undefined], ['wave', { root: {}, session: [] }], ['finish', undefined], ['finish', null],
    ['finish', { root: 7, status: 'passed' }], ['finish', { root: '/definitely/not/a/dir/xyz', session: 's', status: 'passed' }],
  ])('%s_hostileOpts_%j_returnsExit2ObjectInsteadOfThrowing', (fn, opts) => {
    const res = subject()[fn](opts);

    expect(res.exitCode).toBe(2);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('start_rootCannotBeWrittenBecauseATelemetryPathIsAFile_exits2InsteadOfThrowing', () => {
    const root = mkRoot();
    fs.mkdirSync(abs(root, 'docs/.output/.state'), { recursive: true });
    fs.writeFileSync(abs(root, TELEMETRY), 'i am a file, not a directory');

    const res = subject().start({ root, session: 'sess-a', command: 'do', input: 'x', now: T0 });

    expect(res.exitCode).toBe(2);
  });

  it('main_inProcessWithAnEmptyArgv_returnsExit2', () => {
    const exit = subject().main([], {});

    expect(exit).toBe(2);
  });
});

// ── retention decision (regression guard) ───────────────────────────

describe('run-record retention', () => {
  // Regression guard for the decision in the header: cleanup-logs.js prunes only telemetry/logs, so a run record
  // (and a pointer) survives it however old it is. This passes before run-record.js exists; it fails if cleanup-logs
  // ever widens to the runs folder without the retention decision being revisited.
  it('cleanupLogs_oldRunRecord_survives', () => {
    const root = mkRoot();
    const file = runFile(root, 'old-run-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"run_id":"old-run-1"}\n');
    const longAgo = new Date(Date.now() - 400 * 86400000);
    fs.utimesSync(file, longAgo, longAgo);

    const r = spawnSync(process.execPath, [path.resolve('.agents/core/cleanup-logs.js'), '--days', '1'], { env: childEnv(root), encoding: 'utf8', windowsHide: true, timeout: 60000 });

    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"run_id":"old-run-1"}\n');
  });
});


// ═══════════════════════════════════════════════════════════════════
// Wave 4 Group B review fixes (M1-M2, m1-m10 and the nits). One describe per finding id.
//
// NOT COVERED: the 10-second wait for a lock that stays held (waiting that long would slow the suite; only the
// stale-lock reclaim is exercised); the O_NOFOLLOW open in the pointer reader (a swap between lstat and open cannot
// be raced deterministically); a Windows run (the symlink and FIFO cases are skipped there).
// ═══════════════════════════════════════════════════════════════════

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitIt = hasGit ? it : it.skip;
const posixIt = isWindows ? it.skip : it;

/** The child's environment the Bash tool gives a helper: no CLAUDE_PROJECT_DIR. */
function bashToolEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIPPED_ENV.has(k) || k === 'CLAUDE_PROJECT_DIR' || k === 'VITEST' || k.startsWith('VITEST_')) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

/** Run a script asynchronously; resolves `{ status, stdout, stderr }`. */
function runAsync(script, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('M1 finish --plan only rewrites docs/.output/plans/*.md', () => {
  const outsideFile = (root, rel, text = 'module.exports = 1;\n') => {
    fs.mkdirSync(path.dirname(abs(root, rel)), { recursive: true });
    fs.writeFileSync(abs(root, rel), text);
    return text;
  };

  it.each([
    ['a source file', '.agents/core/gate.js'],
    ['a dotfile', '.gitignore'],
    ['a markdown file outside the plans folder', 'docs/work/todo/TODO_x.md'],
    ['a nested file under plans', 'docs/.output/plans/sub/nested.md'],
    ['a non-markdown file under plans', 'docs/.output/plans/notes.txt'],
  ])('finish_planIs_%s_exits2AndTheFileIsByteIdentical', (_name, rel) => {
    const root = mkRoot();
    const text = outsideFile(root, rel);
    begin(root);

    const res = fin(root, { plan: rel });

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].kind).toBe('invalid-input');
    expect(fs.readFileSync(abs(root, rel), 'utf8')).toBe(text);
    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(true);
    expect(readJson(runFile(root)).result).toBeUndefined();
  });

  it('wave_planIsASourceFile_exits2AndTheFileAndPointerAreUntouched', () => {
    const root = mkRoot();
    const text = outsideFile(root, '.agents/core/gate.js');
    begin(root);
    const before = fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8');

    const res = subject().wave({ root, session: 'sess-a', wave: 1, plan: '.agents/core/gate.js', now: at(1) });

    expect(res.exitCode).toBe(2);
    expect(fs.readFileSync(abs(root, '.agents/core/gate.js'), 'utf8')).toBe(text);
    expect(fs.readFileSync(pointerFile(root, 'sess-a'), 'utf8')).toBe(before);
    expect(readJson(runFile(root)).waves).toEqual([]);
  });

  posixIt.each([
    ['a plan symlink to another plan', 'docs/.output/plans/261118-1300-alias.md', PLAN_REL],
    ['a plan symlink to a source file', 'docs/.output/plans/261118-1301-evil.md', '.agents/core/gate.js'],
  ])('finish_planLeafIs_%s_isRefusedAndTheTargetIsUntouched', (_name, link, target) => {
    const root = mkRoot();
    const targetText = target === PLAN_REL ? PLAN_TEXT : outsideFile(root, target);
    fs.symlinkSync(abs(root, target), abs(root, link));
    begin(root);

    const res = fin(root, { plan: link });

    expect(res.exitCode).toBe(2);
    expect(fs.readFileSync(abs(root, target), 'utf8')).toBe(targetText);
  });

  it('cli_finishPlanIsASourceFile_exits2AndLeavesTheFileByteIdentical', () => {
    const root = mkRoot();
    const text = outsideFile(root, '.agents/core/gate.js');
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    cli(root, ['start', '--command', 'do', '--input', 'x'], { env });

    const out = cli(root, ['finish', '--status', 'failed', '--plan', '.agents/core/gate.js'], { env });

    expect(out.status).toBe(2);
    expect(fs.readFileSync(abs(root, '.agents/core/gate.js'), 'utf8')).toBe(text);
  });

  it('finish_planIsAPlansFile_stillWritesTheLine', () => {
    const root = mkRoot();
    begin(root);

    const res = fin(root, { plan: PLAN_REL });

    expect(res.exitCode).toBe(0);
    expect(recordLines(readPlan(root))).toHaveLength(1);
  });
});

describe('M2 one pointer root for the writer and every reader (a linked-worktree session)', () => {
  const COPY = ['.agents/core/run-record.js', '.agents/core/constants.js', '.agents/core/_lib', '.agents/hooks/command-usage-logger.cjs'];
  let fx;
  afterEach(() => { if (fx) { fx.cleanup(); fx = null; } });

  const telemetry = (base) => path.join(base, ...TELEMETRY.split('/'));
  const gateEvent = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node .claude/core/gate.js test' }, tool_response: { exit_code: 0 } });

  gitIt('e2e_startFromALinkedWorktreeThenTheRealHookStampsTheRow_andFinishCountsItAndWritesThePlanThere', () => {
    fx = createLinkedWorktree({ copy: COPY });
    const script = path.join(fx.linked, '.agents/core/run-record.js');
    const env = bashToolEnv({ CLAUDE_CODE_SESSION_ID: 'sess-e2e' });
    const plan = path.join(fx.linked, 'docs/.output/plans/261118-1200-wt-plan.md');
    fs.mkdirSync(path.dirname(plan), { recursive: true });
    fs.writeFileSync(plan, PLAN_TEXT);

    // 1. the Bash tool: no CLAUDE_PROJECT_DIR, cwd in the linked worktree
    const started = spawnSync(process.execPath, [script, 'start', '--command', 'do', '--input', 'wt', '--run-id', 'wt-run-1'], { cwd: fx.linked, env, encoding: 'utf8', windowsHide: true });
    expect(started.status, started.stderr).toBe(0);
    expect(fs.existsSync(path.join(telemetry(fx.main), 'current-run-sess-e2e.json'))).toBe(true);
    expect(fs.existsSync(path.join(telemetry(fx.linked), 'current-run-sess-e2e.json'))).toBe(false);

    // 2. the real hook process: CLAUDE_PROJECT_DIR names the LINKED worktree, as Claude Code sets it for hooks
    const hook = spawnSync(process.execPath, [path.join(fx.linked, '.agents/hooks/command-usage-logger.cjs')], {
      cwd: fx.linked, env: { ...env, CLAUDE_PROJECT_DIR: fx.linked }, input: gateEvent, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    expect(hook.status, hook.stderr).toBe(0);
    const rows = fs.readFileSync(path.join(telemetry(fx.linked), 'command-usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'gate_run', session_id: 'sess-e2e', run_id: 'wt-run-1', wave: null });

    // 3. finish from the linked worktree: the plan lives there, the hook row sits under its telemetry, the pointer is main's
    const shipped = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'feat: shipped\n\nShip-Check: a1b2c3d4e5f6'], { cwd: fx.main, encoding: 'utf8', windowsHide: true });
    expect(shipped.status, shipped.stderr).toBe(0);
    const shippedSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fx.main, encoding: 'utf8', windowsHide: true }).stdout.trim();
    const done = spawnSync(process.execPath, [script, 'finish', '--status', 'passed', '--commit', shippedSha, '--receipt', 'rc-1', '--ship-token', 'OK', '--plan', 'docs/.output/plans/261118-1200-wt-plan.md'], { cwd: fx.linked, env, encoding: 'utf8', windowsHide: true });
    expect(done.status, done.stderr).toBe(0);
    expect(JSON.parse(done.stdout).record.gate_runs).toEqual({ value: 1, source: 'derived' });
    expect(recordLines(fs.readFileSync(plan, 'utf8'))).toHaveLength(1);
    expect(fs.existsSync(path.join(telemetry(fx.main), 'current-run-sess-e2e.json'))).toBe(false);
  });

  gitIt('e2e_attributionLedgerInALinkedWorktreeStampsFromTheMainWorktreePointer', () => {
    fx = createLinkedWorktree({ copy: COPY });
    const env = bashToolEnv({ CLAUDE_CODE_SESSION_ID: 'sess-attr' });
    const started = spawnSync(process.execPath, [path.join(fx.linked, '.agents/core/run-record.js'), 'start', '--command', 'do', '--input', 'attr', '--run-id', 'attr-run'], { cwd: fx.linked, env, encoding: 'utf8', windowsHide: true });
    expect(started.status, started.stderr).toBe(0);

    const ledger = path.join(fx.linked, '.agents/core/_lib/attribution-ledger.js');
    const bash = spawnSync(process.execPath, [ledger, 'append', '{"story_id":"S-1"}'], { cwd: fx.linked, env, encoding: 'utf8', windowsHide: true });
    const hookLike = spawnSync(process.execPath, [ledger, 'append', '{"story_id":"S-2"}'], { cwd: fx.linked, env: { ...env, CLAUDE_PROJECT_DIR: fx.linked }, encoding: 'utf8', windowsHide: true });

    expect(JSON.parse(bash.stdout)).toMatchObject({ story_id: 'S-1', run_id: 'attr-run', wave: null });
    expect(JSON.parse(hookLike.stdout)).toMatchObject({ story_id: 'S-2', run_id: 'attr-run', wave: null });
  });

  gitIt('finish_aPlanInALinkedWorktree_isAcceptedWhenTheWorktreeTopIsAPlanRootAndRefusedWhenItIsNot', () => {
    fx = createLinkedWorktree({ copy: ['.agents/core/constants.js'] });
    const rel = 'docs/.output/plans/261118-1200-wt.md';
    const plan = path.join(fx.linked, rel);
    fs.mkdirSync(path.dirname(plan), { recursive: true });
    fs.writeFileSync(plan, PLAN_TEXT);
    const start = subject().start({ root: fx.main, session: 'sess-a', command: 'do', input: 'wt', now: T0 });
    expect(start.exitCode).toBe(0);

    const refused = subject().finish({ root: fx.main, session: 'sess-a', status: 'failed', plan, now: at(5) });
    const accepted = subject().finish({ root: fx.main, session: 'sess-a', status: 'failed', plan, planRoots: [fx.linked], now: at(5) });

    expect(refused.exitCode).toBe(2);
    expect(accepted.exitCode).toBe(1);
    expect(recordLines(fs.readFileSync(plan, 'utf8'))).toHaveLength(1);
  });
});

describe('m1 the finish window starts at started_at, not the minute-floored since', () => {
  const startedAtSecond = (sec) => new Date(T0.getTime() + sec * 1000);

  it('finish_rowsFromEarlierInTheStartMinute_areNotCounted', () => {
    const root = mkRoot();
    begin(root, { now: startedAtSecond(40) });
    seedLedger(root, [{ ts: startedAtSecond(10).toISOString(), sig: 'earlier' }, { ts: startedAtSecond(50).toISOString(), sig: 'later' }]);
    seedAttribution(root, [{ ...attrRow(0), timestamp: startedAtSecond(10).toISOString() }, { ...attrRow(0), timestamp: startedAtSecond(50).toISOString() }]);

    const res = fin(root);

    expect(res.record.gate_failures).toEqual({ value: 1, source: 'derived' });
    expect(res.record.dispatches).toEqual({ value: 1, source: 'derived' });
  });

  it('finish_runFileWithoutStartedAt_fallsBackToTheMinuteFlooredSince', () => {
    const root = mkRoot();
    begin(root, { now: startedAtSecond(40) });
    const run = readJson(runFile(root));
    delete run.started_at;
    fs.writeFileSync(runFile(root), JSON.stringify(run));
    seedLedger(root, [{ ts: startedAtSecond(10).toISOString(), sig: 'earlier' }]);

    const res = fin(root);

    expect(res.record.gate_failures).toEqual({ value: 1, source: 'derived' });
  });
});

describe('m2 a finished or abandoned run leaves no live pointer', () => {
  it('finish_byRunIdFromAnotherSession_dropsThePointerOfTheSessionTheRunStartedIn', () => {
    const root = mkRoot();
    begin(root, { session: 'sess-a' });

    const res = subject().finish({ root, session: 'sess-wrapper', runId: RUN_ID, status: 'blocked', now: at(40) });

    expect(res.exitCode).toBe(11);
    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(false);
  });

  it('finish_byRunId_keepsAPointerThatNowNamesALaterRunInTheSameSession', () => {
    const root = mkRoot();
    begin(root, { session: 'sess-a' });
    begin(root, { session: 'sess-a', input: 'second' });

    subject().finish({ root, runId: RUN_ID, status: 'blocked', now: at(40) });

    expect(readJson(pointerFile(root, 'sess-a')).run_id).toBe('261118-1200-run-todo-second');
  });
});

describe('m3 one pointer path and one run id rule', () => {
  it('start_writesThePointerWhereTheSharedReaderLooksAndTheReaderReadsIt', () => {
    const root = mkRoot();

    begin(root);

    expect(fs.existsSync(pointerFilePath(root, 'sess-a'))).toBe(true);
    expect(readRunPointer({ root, session: 'sess-a' })).toEqual({ run_id: RUN_ID, wave: null });
    expect(subject().readPointer({ root, session: 'sess-a' })).toEqual({ run_id: RUN_ID, plan: null, wave: null, story: null, since: '261118-1200' });
  });

  it('readPointer_aHugeRunIdInThePointer_isNullInTheWriterAndTheRowReader', () => {
    const root = mkRoot();
    fs.mkdirSync(abs(root, TELEMETRY), { recursive: true });
    fs.writeFileSync(pointerFile(root, 'sess-a'), JSON.stringify({ run_id: 'r'.repeat(60000), plan: null, wave: 1, story: null, since: '261118-1200' }));

    expect(subject().readPointer({ root, session: 'sess-a' })).toBeNull();
    expect(readRunPointer({ root, session: 'sess-a' })).toBeNull();
  });

  it('run-record.js_hasNoPointerPathOrRunIdRuleOfItsOwn', () => {
    const source = fs.readFileSync(SOURCE_FILE, 'utf8');

    expect(source).toMatch(/pointerFilePath[^;]*require\('\.\/_lib\/run-pointer'\)/);
    expect(source).not.toMatch(/current-run-\$\{/);
    expect(source).not.toMatch(/RUN_ID_RE\s*=\s*\//);
  });
});

describe('m4 parallel wave calls never lose a wave', () => {
  it('wave_twelveParallelProcesses_recordTwelveWavesAndLeaveNoLock', async () => {
    const root = mkRoot();
    const env = childEnv(root, { CLAUDE_CODE_SESSION_ID: 'sess-par' });
    expect(cli(root, ['start', '--command', 'run-todo', '--input', 'par', '--run-id', 'par-run'], { env }).status).toBe(0);

    const results = await Promise.all(Array.from({ length: 12 }, (_v, i) => runAsync(SCRIPT, ['wave', '--wave', String(i + 1), '--story', `S-${i + 1}`], { cwd: root, env })));

    expect(results.map((r) => r.status)).toEqual(Array(12).fill(0));
    const waves = readJson(runFile(root, 'par-run')).waves;
    expect(waves.map((w) => w.wave).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_v, i) => i + 1));
    expect(listFiles(abs(root, RUNS))).toEqual(['par-run.json']);
  });

  it('wave_aStaleLockFromACrashedWriter_isReclaimed', () => {
    const root = mkRoot();
    begin(root);
    const lock = abs(root, `${RUNS}/${RUN_ID}.lock`);
    fs.writeFileSync(lock, '999999\n');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);

    const res = subject().wave({ root, session: 'sess-a', wave: 1, now: at(1) });

    expect(res.exitCode).toBe(0);
    expect(readJson(runFile(root)).waves).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('m5 finish never overwrites a recorded result', () => {
  it.each([['killed', 'passed'], ['passed', 'failed'], ['blocked', 'killed']])('finish_%s_thenADifferentStatus_%s_exits2AndChangesNothing', (first, second) => {
    const root = mkRoot();
    begin(root);
    expect(fin(root, { status: first, plan: PLAN_REL }).exitCode).toBe(STATUS_EXIT.find(([s]) => s === first)[1]);
    const before = [fs.readFileSync(runFile(root), 'utf8'), readPlan(root)];

    const res = withTrailers(() => subject().finish({ root, runId: RUN_ID, status: second, ...PROOF, plan: abs(root, PLAN_REL), now: at(90) }));

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].kind).toBe('invalid-input');
    expect(res.errors[0].message).toMatch(new RegExp(`already finished as ${first}`));
    expect([fs.readFileSync(runFile(root), 'utf8'), readPlan(root)]).toEqual(before);
  });

  it('finish_theSameStatusAgain_isAnIdempotentRetryThatRepairsAMissingPlanLine', () => {
    const root = mkRoot();
    begin(root);
    fin(root, { status: 'blocked' }); // no plan on the first call: the plan write "failed"
    expect(recordLines(readPlan(root))).toHaveLength(0);

    const retry = subject().finish({ root, runId: RUN_ID, status: 'blocked', plan: abs(root, PLAN_REL), now: at(41) });

    expect(retry.exitCode).toBe(11);
    expect(recordLines(readPlan(root))).toHaveLength(1);
    expect(readJson(runFile(root)).result.status).toBe('blocked');
  });

  it('cli_finishKilledThenPassed_exits13ThenExits2AndTheRecordStaysKilled', () => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    const started = cli(root, ['start', '--command', 'do', '--input', 'x'], { env });
    const first = cli(root, ['finish', '--status', 'killed'], { env });

    const second = cli(root, ['finish', '--status', 'passed', '--commit', SHIP_SHA, '--receipt', 'rc-1', '--ship-token', 'OK', '--run-id', started.json.run_id], { env });

    expect(first.status).toBe(13);
    expect(second.status).toBe(2);
    expect(readJson(runFile(root, started.json.run_id)).result.status).toBe('killed');
  });
});

describe('m6 a passed run needs the proof of shipping', () => {
  it.each([
    ['no commit', { commit: undefined }, '--commit'],
    ['no receipt', { receipt: undefined }, '--receipt'],
    ['no ship token', { shipToken: undefined }, '--ship-token'],
    ['no proof at all', NO_PROOF, '--commit, --receipt, --ship-token'],
  ])('finish_passedWith_%s_exits2NamingTheMissingFlagsAndChangesNothing', (_name, extra, named) => {
    const root = mkRoot();
    begin(root);
    const before = [fs.readFileSync(runFile(root), 'utf8'), readPlan(root)];

    const res = fin(root, { plan: PLAN_REL, ...extra });

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].message).toContain(named);
    expect([fs.readFileSync(runFile(root), 'utf8'), readPlan(root)]).toEqual(before);
    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(true);
  });

  it('finish_passedWithAnAuditedSkipToken_isAccepted', () => {
    const root = mkRoot();
    begin(root);

    expect(fin(root, { shipToken: 'SKIP' }).exitCode).toBe(0);
  });

  it.each(['failed', 'needs-human', 'blocked', 'budget-exhausted', 'killed'])('finish_%s_withNoProof_isAccepted', (status) => {
    const root = mkRoot();
    begin(root);

    expect(fin(root, { status, ...NO_PROOF }).exitCode).toBe(STATUS_EXIT.find(([s]) => s === status)[1]);
  });

  it('cli_finishPassedWithoutTheProofFlags_exits2', () => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    cli(root, ['start', '--command', 'run-todo', '--input', 'x'], { env });

    const out = cli(root, ['finish', '--status', 'passed'], { env });

    expect(out.status).toBe(2);
    expect(out.stderr).toContain('--commit');
  });
});

describe('m7 exit 2 says whether the input or the disk was at fault', () => {
  it('start_invalidInput_carriesKindInvalidInput', () => {
    const root = mkRoot();

    const res = subject().start({ root, session: 'sess-a', command: 'nope', input: 'x', now: T0 });

    expect(res.errors[0]).toMatchObject({ rule: 'invalid-args', kind: 'invalid-input' });
  });

  it('start_aWriteFaultAfterValidation_carriesKindIoAndStillExit2', () => {
    const root = mkRoot();
    fs.mkdirSync(abs(root, 'docs/.output/.state'), { recursive: true });
    fs.writeFileSync(abs(root, TELEMETRY), 'i am a file, not a directory');

    const res = subject().start({ root, session: 'sess-a', command: 'do', input: 'x', now: T0 });

    expect(res.exitCode).toBe(2);
    expect(res.errors[0]).toMatchObject({ rule: 'exception', kind: 'io' });
  });

  it('cli_jsonErrors_carryTheKind', () => {
    const root = mkRoot();

    const out = cli(root, ['finish'], { env: { CLAUDE_CODE_SESSION_ID: 'sess-cli' } });

    expect(out.json.errors[0].kind).toBe('invalid-input');
  });
});

describe('m8 the Codex session id limit is documented where a Codex author reads it', () => {
  it('header_namesTheClaudeSessionVariableTheCodexLimitAndTheSessionFlag', () => {
    const header = fs.readFileSync(SOURCE_FILE, 'utf8').slice(0, 6000);

    expect(header).toMatch(/CLAUDE_CODE_SESSION_ID/);
    expect(header).toMatch(/Codex[\s\S]{0,300}NO verified session-id/);
    expect(header).toMatch(/--session/);
  });
});

describe('m10 the time-window helpers are failure-ledger\'s', () => {
  it('failureLedger_exportsTheSharedWindowHelpers', () => {
    expect(typeof fl.dayStamps).toBe('function');
    expect(typeof fl.isKilled).toBe('function');
    expect(typeof fl.parseStamp).toBe('function');
  });

  it('run-record.js_importsThemInsteadOfRedefiningThem', () => {
    const source = fs.readFileSync(SOURCE_FILE, 'utf8');

    expect(source).toMatch(/parseStamp, dayStamps, isKilled[^;]*require\('\.\/_lib\/failure-ledger'\)/);
    expect(source).not.toMatch(/function dayStamps|const isKilled\s*=/);
  });
});

describe('nits: start warns when it replaces an unfinished run, and the first write of a run file is whole', () => {
  it('start_overAnUnfinishedRunInTheSameSession_warnsNamingIt', () => {
    const root = mkRoot();
    begin(root);

    const res = begin(root, { input: 'second' });

    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain(RUN_ID);
  });

  it('start_overAFinishedRun_doesNotWarn', () => {
    const root = mkRoot();
    begin(root);
    // A finish that crashed after writing the result and before dropping the pointer: the pointer names a finished run.
    fs.writeFileSync(runFile(root), JSON.stringify({ ...readJson(runFile(root)), result: { status: 'failed' } }));

    const res = begin(root, { input: 'second' });

    expect(res.warnings).toBeUndefined();
  });

  it('start_eightParallelProcessesWithOneExplicitRunId_exactlyOneWinsAndTheFileIsWhole', async () => {
    const root = mkRoot();
    const results = await Promise.all(Array.from({ length: 8 }, (_v, i) => runAsync(SCRIPT, ['start', '--command', 'do', '--input', 'race', '--run-id', 'race-run', '--session', `sess-${i}`], { cwd: root, env: childEnv(root) })));

    expect(results.filter((r) => r.status === 0)).toHaveLength(1);
    expect(results.filter((r) => r.status === 2)).toHaveLength(7);
    expect(readJson(runFile(root, 'race-run'))).toMatchObject({ run_id: 'race-run', waves: [] });
    expect(listFiles(abs(root, RUNS))).toEqual(['race-run.json']);
  });
});

// ── SF-3.6: the headless contract wired into /do and /run-todo ───────────────────────────────────────────────────
// Prose wiring, pinned the way the stage-1 wiring tests pin their workflows: a later edit cannot silently drop a
// flag, a converted stop, a record call or the order between them. The CLI flags below mirror run-record.js FLAGS and
// run-trace.js VERBS; the verbs and flags a workflow quotes must exist there.
describe('SF-3.6 headless wiring', () => {
  const DO = '.agents/skills/do/references/workflow.md';
  const RT = '.agents/skills/run-todo/references/workflow.md';
  const text = (rel) => fs.readFileSync(path.resolve(rel), 'utf8');

  /** The text from `start` up to (not including) the first `end` after it; the end of the file when `end` is omitted. */
  function slice(rel, start, end) {
    const body = text(rel);
    const from = body.indexOf(start);
    expect(from, `${rel}: marker ${JSON.stringify(start)}`).toBeGreaterThanOrEqual(0);
    if (end === undefined) return body.slice(from);
    const to = body.indexOf(end, from + start.length);
    expect(to, `${rel}: end marker ${JSON.stringify(end)}`).toBeGreaterThan(from);
    return body.slice(from, to);
  }

  const RUN_RECORD_FLAGS = {
    start: ['command', 'input', 'run-id', 'budget', 'session'],
    wave: ['wave', 'story', 'plan', 'session'],
    finish: ['status', 'run-id', 'commit', 'plan', 'receipt', 'ship-token', 'fix-rounds', 'review-major', 'misalignments', 'output-tokens', 'session'],
    current: ['session'],
  };
  const SNAPSHOT_FLAGS = ['run-id', 'wave', 'session'];
  const VALID_STATUSES = [...STATUS_EXIT.map(([status]) => status), 'nothing-to-do'];

  /** Every `node .claude/core/<helper>.js <verb> ...` line of a workflow, one per physical line. */
  const helperLines = (rel, helper) => text(rel).split('\n').filter((l) => l.includes(`.claude/core/${helper}.js `) && /^\s*node /.test(l));

  describe('the three flags are in both Variables blocks', () => {
    const doVars = () => slice(DO, '## Variables', '## Task Status Markers');
    const rtVars = () => slice(RT, '**Flags** (parsed from `$ARGUMENTS`):', '**Verification cadence');

    it.each([['/do', doVars], ['/run-todo', rtVars]])('%s_listsRunIdBudgetAndNoAskAsFlags', (_name, vars) => {
      for (const flag of ['--run-id', '--budget', '--no-ask']) {
        expect(vars(), flag).toMatch(new RegExp(`^- \`${flag}[ \`]`, 'm'));
      }
    });

    it.each([['/do', doVars], ['/run-todo', rtVars]])('%s_runIdFlagFeedsRunRecordStartAndBudgetFlagIsThePlanBudgetShape', (_name, vars) => {
      const runId = vars().split('\n').find((l) => l.startsWith('- `--run-id')) ?? '';
      const budget = vars().split('\n').find((l) => l.startsWith('- `--budget')) ?? '';
      expect(runId).toContain('run-record.js start --run-id');
      expect(budget).toContain('**Budget:**');
      expect(budget).toContain('attempts=3 gate-failures=6 dispatches=40 minutes=240');
      expect(budget).toContain('run-record.js start --budget');
      expect(budget).toContain('budget-exhausted');
    });

    it.each([['/do', doVars], ['/run-todo', rtVars]])('%s_noAskFlagNamesAllThreeResultStatuses', (_name, vars) => {
      const noAsk = vars().split('\n').find((l) => l.startsWith('- `--no-ask')) ?? '';
      for (const status of ['needs-human', 'blocked', 'budget-exhausted']) expect(noAsk, status).toContain(status);
      expect(noAsk).toMatch(/intake line/);
    });
  });

  describe('the Headless contract section states the record contract once per workflow', () => {
    const contract = (rel) => slice(rel, '### Headless contract', '\n---\n');

    it.each([DO, RT])('%s_carriesTheExitCodesAndJudgesTheRecordNotExitZero', (rel) => {
      const body = contract(rel);
      expect(body).toMatch(/0 passed, 1 failed, 2 invalid input, 10 needs-human, 11 blocked, 12 budget-exhausted, 13 killed/);
      expect(body).toMatch(/`ship_token` and `commit`, never exit 0 alone/);
      expect(body).toMatch(/refused without `--commit`, `--receipt` and `--ship-token`/);
      expect(body).toMatch(/never overwritten/);
      expect(body).toMatch(/same status again is an idempotent retry/);
    });

    it.each([DO, RT])('%s_codexPassesTheSessionIdOnEveryCall', (rel) => {
      const body = contract(rel);
      expect(body).toContain('CLAUDE_CODE_SESSION_ID');
      expect(body).toMatch(/Codex[^\n]*pass `--session \{session_id\}`[^\n]*every `run-record\.js` and `run-trace\.js` call/);
    });

    it.each([DO, RT])('%s_aResumedRunPassesAFreshRunIdBecauseStartRefusesAnExistingId', (rel) => {
      // M7: the id is per invocation; the plan's old id is finished, and `start` refuses it.
      expect(contract(rel)).toMatch(/resum[^\n]*fresh, unused `--run-id`[^\n]*never the plan's earlier id[^\n]*refuses an existing run id/i);
    });

    it.each([DO, RT])('%s_aResumeRewritesThePlansRunIdLineAndKeepsEarlierRunRecordLines', (rel) => {
      // M7: without the rewrite, `run-trace.js snapshot --run-id` and `finish` would name the finished run.
      const body = contract(rel);
      expect(body).toMatch(/write it over the plan's `\*\*Run id:\*\*` line/);
      expect(body).toMatch(/earlier `\*\*Run record:\*\*` lines stay, one per run id/);
    });

    it.each([DO, RT])('%s_convertsStopsNeverSuppressesThem', (rel) => {
      const body = contract(rel);
      expect(body).toMatch(/converted, never suppressed/);
      expect(body).toMatch(/never skipped past/);
    });

    it.each([DO, RT])('%s_proceduresFinishBeforeTheIntakeLineAndEndsTheRun', (rel) => {
      const body = contract(rel);
      const finish = body.indexOf('run-record.js finish --status {status}');
      const intake = body.indexOf('**Intake line.**');
      expect(finish, 'finish call in the stop procedure').toBeGreaterThanOrEqual(0);
      expect(intake, 'intake paragraph').toBeGreaterThan(finish);
      expect(body).toMatch(/one-line report that names the status and the reason/);
      expect(body).toMatch(/never stash, reset or discard/);
    });

    it.each([DO, RT])('%s_intakeLineUsesTheExistingListenSignalFile', (rel) => {
      const body = contract(rel);
      expect(body).toContain('docs/.output/evolution/intake/{YYYY-MM-DD}.md');
      expect(body).toContain('- [origin: run] ');
      expect(body).toMatch(/`\/listen` signal file, not the `\/intake` lessons channel/);
      expect(body).toContain('## Run {HH:MM}');
    });

    it('do_aStopBeforeStep4bStartsThenFinishesTheRecord', () => {
      expect(contract(DO)).toMatch(/before Step 4b no run exists[^\n]*run-record\.js start --command do --input[^\n]*unresolved-task[^\n]*then `finish`/);
    });

    it('runTodo_aStopBeforeThePlanExistsStartsThenFinishesTheRecord', () => {
      expect(contract(RT)).toMatch(/before the plan exists no run exists[^\n]*run-record\.js start --command run-todo --input[^\n]*then `finish`/);
    });

    it.each([
      [DO, 'failed'],
      [RT, 'failed'],
    ])('%s_failedIsNotAStop', (rel, status) => {
      expect(contract(rel)).toMatch(new RegExp(`\`${status}\` is for a run that`));
    });
  });

  describe('every converted stop names its status', () => {
    // [workflow, start marker, end marker, statuses the slice must name]; each slice must also say `--no-ask`.
    const STOPS = [
      [DO, '## Step 1: Determine What to Do', '## Step 2:', ['needs-human']],
      [DO, '### 6a. Check for pending commits', '### 6b.', ['needs-human']],
      [DO, '### 6c. Decision Principles', '### Path A: Main Agent Implements Directly', ['needs-human']],
      [DO, '#### B4. Handle agent status', '#### B5.', ['blocked', 'needs-human']],
      [DO, '## Step 7: Build + Test Gate', '## Step 8:', ['needs-human', 'budget-exhausted']],
      [DO, '### 8d. Review once, at the end', '**Seal, after the last review fix.**', ['needs-human']],
      [RT, '### 1. Locate the TODO', '### 2. Parse the TODO', ['needs-human']],
      [RT, '### 4. Owner decisions, in one round', '### 5. Pre-flight checks', ['needs-human']],
      [RT, '### 5. Pre-flight checks', '## Phase 1: Planning', ['needs-human', 'blocked']],
      [RT, '#### Step 1: Pre-wave check', '#### Step 2: Assemble context packages', ['needs-human']],
      [RT, '**Budget check, before every fan-out', 'Size the wave to decide', ['budget-exhausted']],
      [RT, '**3. Integrate, then gate once.**', 'Dev agent prompt template:', ['blocked']],
      [RT, '**Supervised runs (wave agents).**', '// All stories in wave', ['needs-human']],
      [RT, '**4a. Read each agent', '**4b. Check for known failure modes:**', ['blocked', 'needs-human']],
      [RT, '**Retry state machine (every path, Path A included).**', '- **Pass** (required builds', ['needs-human', 'budget-exhausted']],
      [RT, '- **Row 3 of the table**', '- **Gate-hang escalation.**', ['needs-human']],
      [RT, '#### Step 7: Wave review', '#### Step 8: Document + Commit', ['needs-human']],
      [RT, '#### Step 9a: Ship gate', '#### Step 9b: Mid-epic review', ['needs-human']],
      [RT, '#### Step 9b: Mid-epic review', '## Phase 3: Post-Execution', ['needs-human']],
    ];

    it.each(STOPS.map((s) => [`${s[0].split('/')[2]} ${s[1].replace(/\*/g, '').slice(0, 48)}`, ...s]))('%s', (_label, rel, start, end, statuses) => {
      const body = slice(rel, start, end);
      expect(body, 'the stop says what --no-ask does').toContain('--no-ask');
      for (const status of statuses) expect(body, status).toContain(status);
    });

    it('do_stepSevenRowThreeKeepsAskTheUserAndAddsTheNoAskOutcome', () => {
      const row = slice(DO, '## Step 7: Build + Test Gate', '## Step 8:').split('\n').find((l) => /^\| 3 \|/.test(l)) ?? '';
      expect(row).toMatch(/stop[^|]*ask the user/i);
      expect(row).toMatch(/--no-ask[^|]*needs-human/);
    });

    it('runTodo_retryTableRowThreeKeepsStopAndAskTheOwnerAndAddsTheNoAskOutcome', () => {
      const row = slice(RT, '| Gate failure | Same signature? | Action |', '**Before any re-dispatch').split('\n').find((l) => /^\| 3 \|/.test(l)) ?? '';
      expect(row).toMatch(/Stop and ask the owner/);
      expect(row).toMatch(/--no-ask[^|]*needs-human/);
    });

    it('runTodo_ownerDecisionsWithNoAskAreRecordedOpenNotAsked', () => {
      const body = slice(RT, '### 4. Owner decisions, in one round', '### 5. Pre-flight checks');
      expect(body).toMatch(/With `--no-ask`[^\n]*AskUserQuestion[^\n]*is not used/);
      expect(body).toMatch(/recorded `open`/);
      expect(body).toMatch(/`Later slice go` is `not given`/);
    });

    it('runTodo_everyStoryBlockedAndNothingElseToRunEndsTheRunBlocked', () => {
      const body = slice(RT, '**4a. Read each agent', '**4b. Check for known failure modes:**');
      expect(body).toMatch(/no story left to run[^\n]*finish `blocked`/);
    });
  });

  describe('the budget ends the run budget-exhausted', () => {
    it('runTodo_exitTwelveKeepsTheInteractiveStopAndConvertsItUnderNoAsk', () => {
      const body = slice(RT, '**Budget check, before every fan-out', 'Size the wave to decide');
      expect(body).toMatch(/Exit 12 means a limit is spent: stop, do not dispatch, and ask the owner/);
      expect(body).toMatch(/needs-human stop, not the end of the run/);
      expect(body).toMatch(/With `--no-ask`[^\n]*run-record\.js finish --status budget-exhausted/);
    });

    it('runTodo_theRetryDispatchBudgetCheckAlsoEndsBudgetExhausted', () => {
      const body = slice(RT, '**Before any re-dispatch (retry, deep attempt or `NEEDS_CONTEXT`):**', '- **Pass** (required builds');
      expect(body).toMatch(/exit 12[^\n]*budget-exhausted/);
    });

    it('runTodo_budgetFlagIsTheOwnersLineInTheScalingRule', () => {
      const body = slice(RT, '**Set the Budget line when the plan is created', 'Template:');
      expect(body).toContain('unless the owner gave one');
      expect(body).toMatch(/`--budget`[^\n]*the owner's line/);
    });

    it('do_aBudgetLineChecksBeforeDispatchAndBeforeEveryRetry', () => {
      const body = slice(DO, '## Step 7: Build + Test Gate', '## Step 8:');
      expect(body).toContain('node .claude/core/_lib/failure-ledger.js budget --since "{run since}" --limits "{the plan\'s **Budget:** line}"');
      expect(body).not.toContain('--since "{plan stamp}"');
      expect(body).toMatch(/Exit 12 means a limit is spent: stop, do not dispatch/);
      expect(body).toMatch(/--no-ask[^\n]*run-record\.js finish --status budget-exhausted/);
      expect(slice(DO, '#### B3. Dispatch', '#### B4.')).toMatch(/Step 7 budget check/);
    });

    it('do_thePlanTemplateCarriesTheBudgetAndRunIdLines', () => {
      const template = slice(DO, '# /do Plan — {story-id or slug}', '<!-- Completion section will be appended in Step 10. -->');
      expect(template).toMatch(/^\*\*Budget:\*\* /m);
      expect(template).toMatch(/^\*\*Run id:\*\* /m);
    });
  });

  describe('the record calls sit at the right steps, in order', () => {
    it('do_step4bOpensTheRecordAfterThePlanIsOnDisk', () => {
      const body = slice(DO, '### 4b. Create the plan and write it to disk immediately', '`TaskUpdate: "Write plan" → completed`');
      const template = body.indexOf('<!-- Completion section will be appended in Step 10. -->');
      const start = body.indexOf('node .claude/core/run-record.js start --command do --input');
      const wave = body.indexOf('node .claude/core/run-record.js wave --wave 1');
      expect(template, 'the template ends before the record opens').toBeGreaterThanOrEqual(0);
      expect(start).toBeGreaterThan(template);
      expect(wave).toBeGreaterThan(start);
      const startLine = body.slice(start, body.indexOf('\n', start));
      expect(startLine).toMatch(/\[--run-id "\{run id\}"\] \[--budget "\{Budget line\}"\]/);
      expect(body.slice(wave, body.indexOf('\n', wave))).toContain('--plan docs/.output/plans/{YYMMDD-HHMM}-do-');
      expect(body).toMatch(/session pointer/);
    });

    it('do_aResumedPlanStillOpensARecordForThisSession', () => {
      const body = slice(DO, '### 4a. Check for existing plan', '### 4b.');
      expect(body).toContain('run-record.js current');
      expect(body).toMatch(/prints `null`[^\n]*start/);
    });

    it('do_step10FinishesTheRunBeforeThePlanCommitWithTheProof', () => {
      const body = slice(DO, '## Step 10: Append completion to the plan file', '## Ad-Hoc Mode');
      const finish = body.indexOf('node .claude/core/run-record.js finish --status passed');
      const commit = body.indexOf('Commit this plan update');
      expect(finish).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(finish);
      const line = body.slice(finish, body.indexOf('\n', finish));
      for (const flag of ['--commit', '--receipt', '--ship-token', '--plan']) expect(line, flag).toContain(flag);
      expect(body).toContain('docs/.output/.state/telemetry/ship-seal.json');
      expect(body).toMatch(/`SHIP_CHECK_OK` → `OK`/);
      expect(body).toMatch(/`SHIP_CHECK_SKIP` → `SKIP`/);
    });

    it('runTodo_phase1Step3OpensTheRecordAfterThePlanIsOnDisk', () => {
      const body = slice(RT, '### Step 3: Write execution plan file', '### Step 4: Double-check TaskList + plan alignment');
      const template = body.indexOf('<!-- Updated after each wave');
      const start = body.indexOf('node .claude/core/run-record.js start --command run-todo --input "{TODO_PATH}"');
      expect(template).toBeGreaterThanOrEqual(0);
      expect(start).toBeGreaterThan(template);
      expect(body.slice(start, body.indexOf('\n', start))).toMatch(/\[--run-id "\{run id\}"\] \[--budget "\{Budget line\}"\]/);
      expect(body).toMatch(/^\*\*Run id:\*\* \{run id from run-record\.js start\}$/m);
    });

    it('runTodo_aResumedPlanStillOpensARecordForThisSession', () => {
      const body = slice(RT, '### 3. Check for existing execution plan', '### 4. Owner decisions, in one round');
      expect(body).toContain('run-record.js current');
      expect(body).toMatch(/prints `null`[^\n]*start/);
    });

    it('runTodo_everyWaveMovesThePointerAfterMarkingTheStoriesInProgress', () => {
      const body = slice(RT, '#### Step 1: Pre-wave check', '#### Step 2: Assemble context packages');
      const marked = body.indexOf('then mark them `[>]` in the TODO file');
      const wave = body.indexOf('node .claude/core/run-record.js wave --wave {N} --story "{wave story IDs}" --plan docs/.output/plans/{YYMMDD-HHMM}-run-todo-{slug}.md');
      expect(marked).toBeGreaterThanOrEqual(0);
      expect(wave).toBeGreaterThan(marked);
    });

    it('runTodo_step8dSnapshotsTheWaveAfterTheWaveEntryIsComplete', () => {
      const body = slice(RT, '**8d. Update the execution plan file**', '**8e. Regenerate the session handoff');
      const entry = body.indexOf('**Review — Wave {N}**');
      const snapshot = body.indexOf('node .claude/core/run-trace.js snapshot --run-id "{run id}" --wave {N}');
      expect(entry).toBeGreaterThanOrEqual(0);
      expect(snapshot).toBeGreaterThan(entry);
      expect(body).toMatch(/never a reason to stop/);
    });

    it('runTodo_phase3Step6FinishesBeforeTheFinalPlanCommit', () => {
      const body = slice(RT, '### 6. Final plan commit', '## Verification-Only Waves');
      const finish = body.indexOf('node .claude/core/run-record.js finish --status passed');
      const add = body.indexOf('git add docs/.output/plans/');
      expect(finish).toBeGreaterThanOrEqual(0);
      expect(add).toBeGreaterThan(finish);
      const line = body.slice(finish, body.indexOf('\n', finish));
      for (const flag of ['--commit', '--receipt', '--ship-token', '--plan']) expect(line, flag).toContain(flag);
      expect(body).toMatch(/last wave's/);
      expect(body).toMatch(/`passed` only when every in-scope story is `\[x\]`/);
    });

    it('runTodo_shipGateFinishesNeedsHumanBeforeItsCommitWhenThereIsNoRecordedGo', () => {
      const body = slice(RT, '#### Step 9a: Ship gate', '#### Step 9b: Mid-epic review');
      const finish = body.indexOf('run-record.js finish --status needs-human');
      const commit = body.indexOf('Commit the plan and handoff');
      expect(finish).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThanOrEqual(0);
      const item3 = body.slice(commit, body.indexOf('\n', commit));
      expect(item3).toContain('run-record.js finish --status needs-human');
      expect(item3).toMatch(/with `--no-ask` and no recorded go/);
    });
  });

  describe('every helper call the workflows quote exists in the CLI', () => {
    it.each([DO, RT])('%s_runRecordVerbsFlagsAndStatusesAreReal', (rel) => {
      const lines = helperLines(rel, 'run-record');
      expect(lines.length, 'the workflow quotes run-record.js calls').toBeGreaterThan(0);
      for (const line of lines) {
        const verb = /run-record\.js (\w+)/.exec(line)[1];
        expect(Object.keys(RUN_RECORD_FLAGS), line).toContain(verb);
        for (const flag of line.match(/--[a-z-]+/g) ?? []) expect(RUN_RECORD_FLAGS[verb], `${line} :: ${flag}`).toContain(flag.slice(2));
        const status = /--status ([a-z-]+|\{status\})/.exec(line);
        if (status && status[1] !== '{status}') expect(VALID_STATUSES, line).toContain(status[1]);
      }
    });

    it.each([DO, RT])('%s_everyStatusWordInAStatusClauseIsAValidFinishStatus', (rel) => {
      for (const match of text(rel).matchAll(/finish --status ([a-z-]+)/g)) expect(VALID_STATUSES, match[0]).toContain(match[1]);
    });

    it('runTodo_snapshotCallUsesOnlyRealRunTraceFlags', () => {
      const lines = helperLines(RT, 'run-trace');
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(/run-trace\.js snapshot /);
        for (const flag of line.match(/--[a-z-]+/g) ?? []) expect(SNAPSHOT_FLAGS, line).toContain(flag.slice(2));
      }
    });

    it('do_doesNotSnapshot_aSingleTaskHasNoWaveClose', () => {
      expect(helperLines(DO, 'run-trace')).toEqual([]);
    });
  });

  describe('the intake-lifecycle constraints still hold', () => {
    it.each([DO, RT])('%s_referencesTheSharedHandoffSkillAndCopiesNoLifecycleCommand', (rel) => {
      const body = text(rel);
      expect(body).toMatch(/\.(?:claude|agents)\/skills\/session-handoff\/SKILL\.md/);
      expect(body).not.toMatch(/^\s*node\s+\.(?:claude|codex)\/core\/intake\.js\s+lifecycle/m);
    });
  });
});

describe('orchestrator: --receipt none only for an audited skip', () => {
  it('passed with --receipt none and --ship-token SKIP records receipt null', () => {
    const root = mkRoot();
    begin(root);
    const res = fin(root, { receipt: 'none', shipToken: 'SKIP' });
    expect(res.exitCode).toBe(0);
    expect(readJson(runFile(root)).result.receipt).toBeNull();
  });

  it('--receipt none with --ship-token OK is refused (exit 2)', () => {
    const root = mkRoot();
    begin(root);
    const res = fin(root, { receipt: 'none', shipToken: 'OK' });
    expect(res.exitCode).toBe(2);
  });
});

// ── Wave 6 review M10: a run always ends in a recorded result ──────────────────────────────────────────────
describe('M10 summary mode: --receipt none with --ship-token OK, only when the seal says so', () => {
  const SEAL = `${TELEMETRY}/ship-seal.json`;
  const writeSeal = (root, seal) => {
    fs.mkdirSync(path.dirname(abs(root, SEAL)), { recursive: true });
    fs.writeFileSync(abs(root, SEAL), typeof seal === 'string' ? seal : JSON.stringify(seal));
  };
  const SUMMARY_SEAL = { head: 'h', receiptId: null, mode: 'summary', codeHash: 'c', recordsHash: 'r', docs: [], sealedAt: iso(30) };

  it('finish_summarySeal_receiptNoneWithOk_isRecordedWithReceiptNull', () => {
    const root = mkRoot();
    begin(root);
    writeSeal(root, SUMMARY_SEAL);

    const res = fin(root, { receipt: 'none', shipToken: 'OK', plan: PLAN_REL });

    expect(res.exitCode).toBe(0);
    expect(res.record).toMatchObject({ status: 'passed', receipt: null, ship_token: 'OK', commit: PROOF.commit });
    expect(readJson(runFile(root)).result.receipt).toBeNull();
  });

  it.each([
    ['no seal at all', null],
    ['a receipt-mode seal', { ...SUMMARY_SEAL, mode: 'receipt', receiptId: 'a1b2c3d4e5f6' }],
    ['a summary seal that names a receipt', { ...SUMMARY_SEAL, receiptId: 'a1b2c3d4e5f6' }],
    ['a seal with no mode', { head: 'h', receiptId: null }],
    ['a seal that is not JSON', '{ not json'],
    ['a seal that is a JSON array', '[]'],
  ])('finish_receiptNoneWithOk_%s_isRefusedAndChangesNothing', (_label, seal) => {
    const root = mkRoot();
    begin(root);
    if (seal !== null) writeSeal(root, seal);
    const before = [fs.readFileSync(runFile(root), 'utf8'), readPlan(root)];

    const res = fin(root, { receipt: 'none', shipToken: 'OK', plan: PLAN_REL });

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].message).toMatch(/summary mode/);
    expect([fs.readFileSync(runFile(root), 'utf8'), readPlan(root)]).toEqual(before);
  });

  it('finish_summarySeal_doesNotLetANonNoneReceiptOrAnotherTokenThrough', () => {
    const root = mkRoot();
    begin(root);
    writeSeal(root, SUMMARY_SEAL);

    expect(fin(root, { receipt: 'none', shipToken: 'SKIP' }).exitCode).toBe(0);
  });

  it('cli_summaryMode_receiptNoneWithOk_exitsZero_andWithoutTheSealExitsTwo', () => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    cli(root, ['start', '--command', 'run-todo', '--input', 'x'], { env });
    const refused = cli(root, ['finish', '--status', 'passed', '--commit', SHIP_SHA, '--receipt', 'none', '--ship-token', 'OK'], { env });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/summary mode/);

    writeSeal(root, SUMMARY_SEAL);
    const accepted = cli(root, ['finish', '--status', 'passed', '--commit', SHIP_SHA, '--receipt', 'none', '--ship-token', 'OK'], { env });

    expect(accepted.status).toBe(0);
    expect(accepted.json.record).toMatchObject({ receipt: null, ship_token: 'OK' });
  });
});

describe('M10 nothing-to-do: a run with no work ends in a valid recorded result', () => {
  it('finish_nothingToDo_exitsZeroWithNoProofAndRecordsNullShippingFields', () => {
    const root = mkRoot();
    begin(root);

    const res = fin(root, { status: 'nothing-to-do', ...NO_PROOF, plan: PLAN_REL });

    expect(res.exitCode).toBe(0);
    expect(res.status).toBe('nothing-to-do');
    expect(res.record).toMatchObject({ status: 'nothing-to-do', commit: null, receipt: null, ship_token: null, waves: { value: 0 }, stops: { value: 0 } });
    expect(readJson(runFile(root)).result).toMatchObject({ status: 'nothing-to-do', exit_code: 0 });
    expect(recordLines(readPlan(root))).toHaveLength(1);
    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(false);
  });

  it.each([
    ['--commit', { commit: 'a1b2c3d4e5f6' }],
    ['--receipt', { receipt: 'rcpt-1' }],
    ['--ship-token', { shipToken: 'OK' }],
  ])('finish_nothingToDoWith_%s_isRefused_aRunThatShipsNothingHasNoProof', (flag, extra) => {
    const root = mkRoot();
    begin(root);
    const before = fs.readFileSync(runFile(root), 'utf8');

    const res = fin(root, { status: 'nothing-to-do', ...NO_PROOF, ...extra });

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].message).toContain(flag);
    expect(fs.readFileSync(runFile(root), 'utf8')).toBe(before);
  });

  it('finish_nothingToDoAfterAWaveWasRecorded_isRefusedAndChangesNothing', () => {
    const root = mkRoot();
    begin(root);
    expect(subject().wave({ root, session: 'sess-a', wave: 1, story: 'S-1', now: at(5) }).exitCode).toBe(0);
    const before = [fs.readFileSync(runFile(root), 'utf8'), readPlan(root)];

    const res = fin(root, { status: 'nothing-to-do', ...NO_PROOF, plan: PLAN_REL });

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].message).toMatch(/recorded 1 wave\(s\)/);
    expect([fs.readFileSync(runFile(root), 'utf8'), readPlan(root)]).toEqual(before);
    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(true);
  });

  it('finish_nothingToDo_theSameStatusAgainIsAnIdempotentRetry_aDifferentOneIsRefused', () => {
    const root = mkRoot();
    begin(root);
    expect(fin(root, { status: 'nothing-to-do', ...NO_PROOF }).exitCode).toBe(0);

    const again = subject().finish({ root, runId: RUN_ID, status: 'nothing-to-do', now: at(41) });
    const other = withTrailers(() => subject().finish({ root, runId: RUN_ID, status: 'passed', ...PROOF, now: at(42) }));

    expect(again.exitCode).toBe(0);
    expect(other.exitCode).toBe(2);
    expect(other.errors[0].message).toMatch(/already finished as nothing-to-do/);
  });

  it('cli_finishNothingToDo_exitsZeroAndIsNotAStop', () => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    const started = cli(root, ['start', '--command', 'run-todo', '--input', 'x'], { env });

    const out = cli(root, ['finish', '--status', 'nothing-to-do'], { env });

    expect(out.status).toBe(0);
    expect(out.json.record).toMatchObject({ status: 'nothing-to-do', stops: { value: 0 } });
    expect(readJson(runFile(root, started.json.run_id)).result.exit_code).toBe(0);
  });

  it('theExitCodeTableKeepsItsExistingCodes_nothingToDoAddsNoNewOne', () => {
    for (const [status, code] of STATUS_EXIT) {
      const root = mkRoot();
      begin(root);
      expect(fin(root, { status }).exitCode, status).toBe(code);
    }
  });
});

// ── Wave 6 review: the headless contract, pinned where the review found it open ────────────────────────────
describe('Wave 6 review headless pins', () => {
  const DO = '.agents/skills/do/references/workflow.md';
  const RT = '.agents/skills/run-todo/references/workflow.md';
  const text = (rel) => fs.readFileSync(path.resolve(rel), 'utf8');
  const lines = (rel) => text(rel).split('\n');
  const contract = (rel) => {
    const body = text(rel);
    const from = body.indexOf('### Headless contract');
    expect(from, `${rel}: Headless contract`).toBeGreaterThanOrEqual(0);
    return body.slice(from, body.indexOf('\n---\n', from));
  };

  describe('M5 a converted stop leaves a tree that the next headless resume accepts', () => {
    it.each([DO, RT])('%s_theStopCommitsItsOwnDocsOnlyStateWithExactPaths_andPartialCodeStaysOut', (rel) => {
      const body = contract(rel);
      expect(body).toContain("**The run's own state.**");
      expect(body).toMatch(/commits the docs-only part \(the plan, the TODO and the intake file, whichever exist\) with exact paths: `git add -- \{those paths\}`/);
      expect(body).toMatch(/`node \.claude\/core\/commit\.js`/);
      expect(body).toMatch(/partial code is never part of that commit/);
      expect(body).toMatch(/When `git diff --cached --name-only` shows any other staged path, do not commit \(another writer's staged work is never swept into this commit\)/);
      expect(body).toMatch(/A refused or skipped commit leaves those files uncommitted/);
      expect(body).not.toMatch(/The run does not commit it/);
    });

    it.each([DO, RT])('%s_aHeadlessResumeTreatsChangesConfinedToTheRunsOwnPathsAsItsOwn', (rel) => {
      const body = contract(rel);
      expect(body).toMatch(/treats uncommitted changes confined to the run's own paths as its own/);
      expect(body).toMatch(/finishes `needs-human` only for a changed path outside them/);
    });

    it.each([DO, RT])('%s_theStopProcedureCommitsAfterTheIntakeLineAndBeforeTheOneLineReport', (rel) => {
      const body = contract(rel);
      const finish = body.indexOf('run-record.js finish --status {status}');
      const intake = body.indexOf('append the intake line; commit the run\'s own docs-only state');
      const report = body.indexOf('end the run with a one-line report');
      expect(finish).toBeGreaterThanOrEqual(0);
      expect(intake).toBeGreaterThan(finish);
      expect(report).toBeGreaterThan(intake);
    });

    it('runTodo_phase0Step5AndPhase2Step1AcceptTheRunsOwnPathsUnderNoAsk_andTheResumePointCarriesPartialWork', () => {
      const t = text(RT);
      const step5 = t.slice(t.indexOf('### 5. Pre-flight checks'), t.indexOf('## Phase 1: Planning'));
      expect(step5).toMatch(/changes confined to the run's own paths \(Headless contract, "The run's own state"\) are the run's own/);
      expect(step5).toMatch(/a changed path outside them finishes `needs-human`/);
      expect(step5).toMatch(/skips the baseline for those stories[^\n]*`baseline: skipped, partial work of \{stories\}`/);
      const step1 = t.slice(t.indexOf('#### Step 1: Pre-wave check'), t.indexOf('#### Step 2: Assemble context packages'));
      expect(step1).toContain('"The run\'s own state"');
      expect(step1).toMatch(/still `\[ \]` \(or `\[>\]` for a story a resume found started/);
      expect(t).toMatch(/^- \*\*Partial work:\*\* \{uncommitted paths of started `\[>\]` stories, or none\}$/m);
    });

    it('do_step6aAcceptsTheRunsOwnPathsUnderNoAsk', () => {
      const t = text(DO);
      const step6a = t.slice(t.indexOf('### 6a. Check for pending commits'), t.indexOf('### 6b.'));
      expect(step6a).toContain('"The run\'s own state"');
      expect(step6a).toMatch(/a changed path outside them finishes `needs-human`/);
    });
  });

  describe('M8 every human ask in the two workflows is converted under --no-ask, line by line', () => {
    // A line that asks a person. The check is per line: a `--no-ask` somewhere else in a large slice never covers it.
    const ASK = /AskUserQuestion|\bstop and ask\b|\bask the (?:owner|user)\b|\b(?:is|are) asked\b|^- Ask |\bAsk every\b|\balso asks\b|\bmust ask\b|\bask user\b/i;
    const CONVERTED = (line) => /--no-ask|\bnot asked\b|\bnothing is asked\b|\bnot an ask\b/i.test(line)
      || (/^\|/.test(line) && /needs-human|blocked|budget-exhausted|nothing-to-do/.test(line));
    // The one-round Owner Decisions list (Phase 0 Step 4) is converted as a block by its `With --no-ask` bullet and the
    // `Later slice go` default; the budget paragraph's interactive stop is converted by the paragraph after it.
    const ALLOWED = {
      [RT]: [
        ["Read the TODO's `## Owner Decisions` section", 'interactive one-round ask; converted by the `With --no-ask` bullet of the same list'],
        ['- Ask with AskUserQuestion, batched', 'the interactive default of the bullet above it, which names `--no-ask`'],
        ["- Ask the run's scope in the same round", 'the interactive default; headless scope is "everything not blocked by a gate" (the `--no-ask` bullet)'],
        ['- When the TODO has a later slice, the round also asks', 'headless sets `Later slice go` to `not given` (the `--no-ask` bullet)'],
        ['`{run since}` is the `since` stamp', 'interactive exit 12 stop; the next paragraph starts `With --no-ask` and converts it'],
      ],
      [DO]: [],
    };

    it.each([DO, RT])('%s_everyAskingLineNamesItsNoAskConversionOrIsAllowlistedWithAReason', (rel) => {
      const unconverted = lines(rel)
        .map((line, at) => ({ line, at: at + 1 }))
        .filter(({ line }) => ASK.test(line) && !CONVERTED(line))
        .filter(({ line }) => !ALLOWED[rel].some(([start]) => line.startsWith(start)));

      expect(unconverted.map(({ at, line }) => `${rel}:${at} ${line.slice(0, 100)}`)).toEqual([]);
    });

    it.each([DO, RT])('%s_everyAllowlistEntryStillMatchesExactlyOneAskingLine', (rel) => {
      for (const [start] of ALLOWED[rel]) {
        const hits = lines(rel).filter((line) => line.startsWith(start));
        expect(hits, start).toHaveLength(1);
        expect(ASK.test(hits[0]), `${start} no longer asks, drop it from the allowlist`).toBe(true);
      }
    });

    it('theCheckSeesTheOriginalGap_theUnpredictedDecisionLineWithoutItsConversionWouldFail', () => {
      const original = "- A decision that could not have been predicted is asked when it appears and added to the plan's block the same way.";
      expect(ASK.test(original) && !CONVERTED(original)).toBe(true);
    });

    it('runTodo_theUnpredictedDecisionBulletConvertsUnderNoAsk', () => {
      const bullet = lines(RT).find((line) => line.startsWith('- A decision that could not have been predicted is asked when it appears')) ?? '';
      expect(bullet).toMatch(/With `--no-ask`, nothing is asked: record it `open` in Owner Decisions/);
      expect(bullet).toMatch(/block the stories that name it, continue with every un-gated story and finish `needs-human` when none is left/);
    });

    it.each([
      [RT, /^\| A decision nobody could predict, found mid-run[^|]*\|[^|]*\| not asked: recorded `open`[^|]*`needs-human` when no un-gated story is left \|$/m],
      [DO, /^\| A decision nobody could predict, found mid-run \| 6c \| `needs-human` \|$/m],
    ])('%s_theStopsTableHasARowForTheUnpredictedDecision', (rel, row) => {
      expect(contract(rel)).toMatch(row);
    });

    it('do_stepSixCTableRowCoversAnUnpredictedDecision', () => {
      const t = text(DO);
      const row = t.split('\n').find((line) => line.startsWith('| **User Challenge** |')) ?? '';
      expect(row).toMatch(/including one nobody could predict before the work began/);
      expect(row).toMatch(/--no-ask[^|]*needs-human/);
    });
  });

  describe('M10 a run always ends in a recorded result', () => {
    it.each([DO, RT])('%s_aRefusedFinishIsFixedOnceThenRecordedBlockedNeverLooped', (rel) => {
      const body = contract(rel);
      expect(body).toContain('**A refused `finish`.**');
      expect(body).toMatch(/read the error, fix the argument once and run it again/);
      expect(body).toMatch(/`finish --status blocked`, which needs no proof/);
      expect(body).toMatch(/never called a third time with the same arguments/);
    });

    it.each([DO, RT])('%s_aRunWithNoWorkFinishesNothingToDoWithNoProofAndNoIntakeLine', (rel) => {
      const body = contract(rel);
      expect(body).toContain('**A run with no work.**');
      expect(body).toMatch(/run-record\.js finish --status nothing-to-do/);
      expect(body).toMatch(/no `--commit`, `--receipt` or `--ship-token`/);
      expect(body).toMatch(/exits 0 and is not a stop: no intake line is written/);
      expect(body).toMatch(/`nothing-to-do` is the result of a run that found no work/);
    });

    it('runTodo_theNoWorkTriggersAreNamedAndPhase0Step2PointsAtTheResult', () => {
      expect(contract(RT)).toMatch(/`phase` `complete`, or every story of the TODO is `\[x\]`/);
      expect(text(RT)).toContain('`complete` means nothing is left (a run with no work, Headless contract).');
    });

    it('do_anAlreadyDoneStoryIsTheNoWorkResult', () => {
      const t = text(DO);
      expect(t).toMatch(/A story that is already `\[x\]` has nothing to do: report it and stop \(with `--no-ask`, the `nothing-to-do` result, Headless contract\)/);
      expect(contract(DO)).toMatch(/^\| The story is already `\[x\]`, nothing to do \| 1 \| `nothing-to-do` \(a result, not a stop\) \|$/m);
    });

    it.each([
      [DO, '## Step 10: Append completion to the plan file', '## Ad-Hoc Mode'],
      [RT, '### 6. Final plan commit', '## Verification-Only Waves'],
    ])('%s_theFinishProofExplainsSummaryModeReceiptNone', (rel, start, end) => {
      const t = text(rel);
      const body = t.slice(t.indexOf(start), t.indexOf(end));
      expect(body).toMatch(/`--receipt none`|pass `--receipt none`/);
      expect(body).toMatch(/`mode: summary` and `receiptId: null`/);
      expect(body).toMatch(/requireReceipt: false/);
      expect(body).toMatch(/`finish` reads the seal and refuses `none` with `OK` otherwise/);
      expect(body).toMatch(/Headless contract/);
      expect(body).toContain('docs/.output/.state/telemetry/ship-seal.json');
    });

    it('runTodo_m6_theProofIsTheLatestShippedCommitNotJustTheLastWaves', () => {
      const t = text(RT);
      const body = t.slice(t.indexOf('### 6. Final plan commit'), t.indexOf('## Verification-Only Waves'));
      expect(body).toMatch(/the latest commit made with a ship token/);
      expect(body).toMatch(/unless a Phase 3 Step 1 fix was committed after it/);
      expect(body).not.toMatch(/`--receipt` is the `\{receiptId\}` after `@`/);
    });
  });

  describe('m11 exits 10 to 13 are the success of recording', () => {
    it.each([DO, RT])('%s_saysAnExitTenToThirteenIsARecordedResultNeverARetry', (rel) => {
      expect(contract(rel)).toMatch(/Exits 10 to 13 mean the result was recorded: the call succeeded, so never retry or loop on them/);
    });
  });

  describe('m12 the --no-ask branch pre-flight keeps a repo main-direct convention', () => {
    it('do_branchPreflightAndItsStopsRowHonourAMainDirectConvention', () => {
      const t = text(DO);
      const para = t.split('\n').find((line) => line.startsWith('**Branch pre-flight (run before any work):**')) ?? '';
      expect(para).toMatch(/With `--no-ask` this is not an ask: nobody can say to work on main, so honour the repo's own CLAUDE\.md convention exactly as an interactive run does \(a main-direct convention works on main\)/);
      expect(para).not.toMatch(/no one can say to work on main, so create the branch/);
      const row = contract(DO).split('\n').find((line) => line.startsWith('| Branch pre-flight on the default branch')) ?? '';
      expect(row).toMatch(/honour a main-direct convention in the repo's own CLAUDE\.md/);
    });
  });

  describe('m10 the run origin and /listen', () => {
    it.each([DO, RT])('%s_theIntakeLineSaysListenKnowsTheRunOriginAndTheStopCommitsIt', (rel) => {
      const body = contract(rel);
      expect(body).toMatch(/`\/listen` knows the `run` origin and does not let a file that holds only these run sections move its window; the stop procedure above commits the file/);
    });

    it('listen_theOriginSetIncludesRun_andTheWindowIgnoresARunOnlyFile', () => {
      const listen = text('.agents/skills/listen/references/workflow.md');
      expect(listen).toContain('- [origin: {git|telemetry|agent-updates|backlog|external|gate|run}] {signal}');
      expect(listen).toMatch(/newest filename date among the files that hold a sweep as the lower bound/);
      expect(listen).toMatch(/a log of unattended-run stops written by `\/do` and `\/run-todo` \(`\[origin: run\]` bullets, which `\/listen` never writes\), not a sweep, so it does not move the window/);
      expect(listen).toMatch(/Default: since the most recent existing `intake\/\*\.md` that holds a sweep \(Step 1\)/);
    });
  });

  describe('n1 n2 n3 small corrections', () => {
    it('n1_theArgumentHintsOfDoAndRunTodoListTheHeadlessFlags', () => {
      const meta = JSON.parse(text('.agents/adapters/claude/workflow-metadata.json'));
      for (const name of ['do', 'run-todo']) {
        const hint = (meta[name].match(/argument-hint: (.*)$/m) ?? [])[1] ?? '';
        for (const flag of ['--run-id ID', '--budget LINE', '--no-ask']) expect(hint, `${name} ${flag}`).toContain(flag);
      }
    });

    it('n2_thePlanModeHeadingSaysToSkipItUnderNoAsk', () => {
      expect(text(RT)).toMatch(/^## Phase 1: Planning \(Main Agent — Enter Plan Mode; skip plan mode with `--no-ask`, it needs an approval that never comes\)$/m);
    });

    it('n3_theGateHeaderDocumentsTheByIdArchive', () => {
      const header = text('.agents/core/gate.js').split('\n').slice(0, 60).join('\n');
      expect(header).toMatch(/gate-receipts\/by-id\/\s+— Every receipt by id \(\{id\}\.json; failed\/ holds the non-passing ones\); story checkpoints resolve through it/);
    });
  });
});

// ── security review m4: --ship-token OK is proved by the commit's Ship-Check trailer ─────────────

describe('run-record finish: --ship-token OK needs a commit that carries the Ship-Check trailer', () => {
  const PLAIN = trailerRepo('feat: committed with a plain git commit -F');
  const SKIPPED = trailerRepo('feat: skipped\n\nShip-Check-Skip: CI-only matrix job');
  const MALFORMED = trailerRepo('feat: typed by hand\n\nShip-Check: not-a-hash');

  function started() {
    const root = mkRoot();
    begin(root);
    return root;
  }
  const onlyOpenRun = (root) => {
    expect(readJson(runFile(root)).result).toBeUndefined();
    expect(fs.existsSync(pointerFile(root, 'sess-a'))).toBe(true);
  };

  it('finish_okWithACommitThatHasTheTrailer_isRecorded', () => {
    const root = started();

    const res = fin(root, { commit: SHIP_SHA.slice(0, 7) });

    expect(res.exitCode, JSON.stringify(res)).toBe(0);
    expect(res.record).toMatchObject({ commit: SHIP_SHA.slice(0, 7), ship_token: 'OK' });
  });

  it('finish_okWithACommitMadeWithoutTheShipCheck_isRefusedAndRecordsNothing', () => {
    const root = started();

    const res = fin(root, { commit: PLAIN.sha }, PLAIN.dir);

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].message).toMatch(/--ship-token OK is refused: commit [0-9a-f]{40} carries no Ship-Check trailer/);
    expect(res.errors[0].message).toContain('commit.js --ship-check');
    onlyOpenRun(root);
  });

  it.each([
    ['an audited-skip commit (that is a SKIP, not a ship check)', SKIPPED],
    ['a hand-typed malformed trailer', MALFORMED],
  ])('finish_ok_%s_isRefused', (_label, repo) => {
    const root = started();

    const res = fin(root, { commit: repo.sha }, repo.dir);

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].message).toMatch(/carries no Ship-Check trailer/);
    onlyOpenRun(root);
  });

  it('finish_okWithACommitTheRepositoryDoesNotHave_isRefusedAsUnconfirmable', () => {
    const root = started();

    const res = fin(root, { commit: 'deadbeef' }, PLAIN.dir);

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].message).toMatch(/--ship-token OK cannot be confirmed: cannot read commit deadbeef/);
    onlyOpenRun(root);
  });

  it('finish_okInADirectoryThatIsNotARepository_isRefusedNotPassed', () => {
    const root = started();
    const before = process.env.GIT_DIR;
    delete process.env.GIT_DIR;

    const res = subject().finish({ root, session: 'sess-a', now: at(40), status: 'passed', ...PROOF });

    if (before !== undefined) process.env.GIT_DIR = before;
    expect(res.exitCode).toBe(2);
    expect(res.errors[0].message).toMatch(/--ship-token OK cannot be confirmed/);
    onlyOpenRun(root);
  });

  it('finish_okWithNoNamedCommit_checksHead', () => {
    const killedOk = (dir) => {
      const root = started();
      return { root, res: withTrailers(() => subject().finish({ root, session: 'sess-a', now: at(40), status: 'killed', shipToken: 'OK' }), dir) };
    };

    const good = killedOk(TRAILER_GIT_DIR);
    expect(good.res.exitCode, JSON.stringify(good.res)).toBe(13);
    expect(good.res.record).toMatchObject({ ship_token: 'OK', commit: null });

    const bad = killedOk(PLAIN.dir);
    expect(bad.res.exitCode).toBe(2);
    expect(bad.res.errors[0].message).toMatch(/HEAD carries no Ship-Check trailer/);
  });

  it('finish_skipToken_isNotAffected_itKeepsItsOwnAuditedTrailerAndNeedsNoShipCheck', () => {
    const root = started();

    const res = fin(root, { commit: PLAIN.sha, receipt: 'none', shipToken: 'SKIP' }, PLAIN.dir);

    expect(res.exitCode, JSON.stringify(res)).toBe(0);
    expect(res.record).toMatchObject({ ship_token: 'SKIP', receipt: null });
  });

  it('cli_finishOkWithoutTheTrailer_exitsTwoWithTheReasonOnStderr', () => {
    const root = mkRoot();
    const env = { CLAUDE_CODE_SESSION_ID: 'sess-cli' };
    cli(root, ['start', '--command', 'do', '--input', 'trailer'], { env });

    const refused = cli(root, ['finish', '--status', 'passed', '--commit', PLAIN.sha, '--receipt', 'rc-1', '--ship-token', 'OK'], { env: { ...env, GIT_DIR: PLAIN.dir } });

    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/carries no Ship-Check trailer/);
  });
});
