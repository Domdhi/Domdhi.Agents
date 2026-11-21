// SF-4.1: tests for `.agents/core/run-scoreboard.js`: "are the agents good". Standard tier (read-only reporting): one test
// per AC behaviour; every displayed number is asserted as an exact value computed by hand from the fixtures below.
//
// PINNED CONTRACT. The implementer must match these names, signatures and shapes; the tests are the spec.
//
// Exports (CommonJS; the CLI is guarded by `require.main === module`, so requiring the file never exits or prints):
//   buildScoreboard({ root, now, rolling, timesplit }) -> scoreboard object (never throws, never writes)
//     root       absolute project root (required for tests; the CLI defaults it to CLAUDE_PROJECT_DIR, else the repo root)
//     now        Date; the clock for `generated`
//     rolling    window size N (default 10); anything that is not a positive integer falls back to 10
//     timesplit  optional array of `session-timesplit.js --json` objects (analyzeSession shape)
//   renderMarkdown(scoreboard) -> string
//
// metrics.js owns the numbers it already computes. buildScoreboard IMPORTS computeTelemetry / computeTodos from
// `./metrics` and never recounts `gate_run` rows (a source test pins this). metrics.js resolves its root once at module
// load, so the implementer must give `computeTelemetry` and `computeTodos` an optional `root` argument (the default stays
// the module-scope root; metrics.js is outside the story's Files list and is expanded for this).
//
// Scoreboard JSON (top-level keys, exactly): generated, gate, todos, plans, runs, rolling, timesplit
//   generated  now.toISOString()
//   gate       null when command-usage.jsonl is absent/empty (metrics' computeTelemetry() is null); else
//              { build, test }, each { pass, fail, total, pass_rate } or null when metrics has no `gate:build`/`gate:test`
//              key. pass/fail are metrics' counts, total = pass + fail, pass_rate is metrics' percent (1 decimal, e.g.
//              86.1) EXCEPT total 0 -> null (metrics reports 0 there; a rate over nothing is null, never 0 or NaN).
//   todos      null when metrics' computeTodos() is null, else { files, total, done, completion_rate } copied from it.
//   plans      null when docs/.output/plans does not exist, else (every *.md under it, recursively, is one plan)
//              { total, with_record, without_record, other_plans, malformed_records, by_status, ship_check }
//                ship_check       { sealed, skipped, missing, unknown }: the run records' commits counted by what their trailer
//                                 says (the `Ship-Check` trailer commit.js --ship-check writes; the audited `Ship-Check-Skip`;
//                                 neither; or the commit cannot be read from this checkout). A record with no commit counts nowhere.
//                with_record      run plans with >= 1 VALID `**Run record:**` line
//                without_record   run plans with none. A RUN plan is one whose file name carries `-run-todo-` or `-do-`, or that
//                                 holds any `**Run record:**` line (m9); total = with_record + without_record + other_plans
//                other_plans      plan documents that are not runs (no run-shaped name and no record line): counted, never a row
//                malformed_records  count of `**Run record:**` lines skipped: JSON that does not parse, or parses to
//                                 something other than an object with a string run_id (a number, an array, ...)
//                by_status        counts over the RUN plans, keyed by the first word of the plan's `**Status:**` line,
//                                 lower-cased (/^[A-Za-z][A-Za-z-]*/), key `unknown` when the plan has no Status line
//   runs       [] when plans is null. One row per VALID record line (a plan may hold several), plus ONE row for each plan
//              with no valid record line. Sorted ascending by (run_id ?? basename of plan), a plain string compare.
//              Row keys (exactly): plan (repo-relative, forward slashes), run_id, command, input, has_record, status,
//              commit, ship_token (the record's own fields, null when absent), ship_check (sealed|skipped|missing|unknown,
//              null when the record names no commit),
//              plan_status (the Status text after `**Status:**`, trimmed, null when absent), waves, stories, gate_runs,
//              gate_failures, first_pass_green_waves, first_pass_green, fix_rounds, review_major, dispatches,
//              misalignments, stops, output_tokens.
//              The eleven counters (waves .. output_tokens, minus first_pass_green) are the record's `{ value, source }`
//              objects UNWRAPPED to the bare number; a value that is null, a field that is missing, or a field that is not
//              the `{ value, source }` shape is null. `first_pass_green` is true when waves > 0 and
//              first_pass_green_waves === waves, false when waves > 0 and fewer, null when either is null or waves is 0.
//              A plan with no valid record is a row with has_record false, plan_status, plan, and EVERY other key null.
//   rolling    over the LAST N rows that have a record (by the run order above): { window, runs, success_rate,
//              first_pass_green_rate, mean_fix_rounds, mean_review_major, mean_dispatches, mean_output_tokens,
//              mean_gate_failures, mean_stops }
//                window  N;  runs  how many records are in the window (0 when none)
//                success_rate  runs with status 'passed' / runs, as a percent with 1 decimal (2 of 3 -> 66.7)
//                first_pass_green_rate  sum(first_pass_green_waves) / sum(waves) as a percent with 1 decimal, over the
//                  window's runs where both are non-null and waves > 0 (wave-weighted); null when no run qualifies
//                mean_*  the mean of the non-null values (null is excluded, never counted as 0); null when none; rounded
//                  to 2 decimals
//              Anything divided by zero or averaged over nothing is null, never NaN, never 0.
//   timesplit  null when no timesplit objects are given or none is usable, else sums over the usable ones
//              { sessions, agent_runs, agent_hours, fix_rounds } from subagents.runs, subagents.totalHours,
//              subagents.fixRounds.rounds. An entry that is not an object with an object `subagents` is skipped.
//
// Markdown (renderMarkdown, and the CLI default): `# Agent scoreboard`, then `## Gate`, `## Plans`, `## Rolling`,
// `## Runs`. Facts are `- {label}: {value}` lines; a null shows as `n/a`; a rate shows with one decimal and `%`
// (`75.0%`); a mean shows as the JSON number (`2`, `0.25`); counts bare. Labels, in order of use:
//   Gate:    `test pass rate` and `build pass rate`, value `{rate}% ({pass} of {total})`
//            `todo completion`, value `{completion_rate}% ({done} of {total})`
//   Plans:   `plans`, `plans with run record`, `plans without run record`, `malformed run records`
//   Rolling: `runs in window`, `success rate`, `first-pass-green rate`, `mean fix rounds`, `mean review major`,
//            `mean dispatches`, `mean output tokens`, `mean gate failures`, `mean stops`
//   Runs:    a table; the data rows (after the header and separator rows) each start `| {run_id, or the plan path when the
//            row has no record} |`, in the `runs` order.
//   The text never contains NaN, undefined or null.
//
// CLI: `node run-scoreboard.js [--json] [--rolling N] [--timesplit FILE]...` (root = CLAUDE_PROJECT_DIR, else the repo root)
//   default: the markdown; `--json`: exactly one JSON document (the scoreboard). `--timesplit` is repeatable. Missing DATA
//   (an empty root, no plans, no telemetry) and an unknown flag exit 0 with null fields. A bad ARGUMENT exits 2 with the
//   reason on stderr and nothing on stdout (m9): `--rolling` that is not a positive integer or has no value, a `--timesplit`
//   with no value, or a FILE that is missing, unreadable, not JSON or not a session-timesplit report. It is read-only.
//
// `npm run scoreboard` exists: package.json scripts.scoreboard runs `node .claude/core/run-scoreboard.js`.
//
// NOT COVERED: the AC's "written into Key Findings as the zero-cost baseline" (a documentation deliverable, not code);
// the baseline's "rework commits within 7 days from git log" and "review-fix rounds per story where transcripts exist"
// (no AC bullet defines a scoreboard field for them; the optional timesplit roll-up is covered); the `.claude/core` wrapper
// (generated by the renderer, covered by `render-shared-agents.js --check`).

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve('.agents/core/run-scoreboard.js');
const REPO_ROOT = path.resolve('.');
const subject = () => require('../run-scoreboard');

const TELEMETRY = 'docs/.output/.state/telemetry';
const PLANS = 'docs/.output/plans';
const NOW = new Date(2026, 10, 18, 12, 0, 0);

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

// ── fixtures ────────────────────────────────────────────────────────

function mkRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-scoreboard-')));
  roots.push(root);
  return root;
}
function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const f = (value, source = 'derived') => ({ value, source });
/** A full plan-line record per the run-record.js contract; `over` replaces fields (undefined drops one). */
function rec(runId, over = {}) {
  return {
    run_id: runId, command: 'run-todo', input: 'SF-X', status: 'passed', commit: null, receipt: null, ship_token: null,
    waves: f(1), stories: f(1), gate_runs: f(1), gate_failures: f(0), first_pass_green_waves: f(1),
    fix_rounds: f(0, 'reported'), review_major: f(0, 'reported'), dispatches: f(0), misalignments: f(0, 'reported'),
    stops: f(0), output_tokens: f(null, 'reported'), ...over,
  };
}
const recLine = (r) => `**Run record:** ${JSON.stringify(r)}`;
const plan = (status, lines = []) => `# Plan\n\n${status === null ? '' : `**Status:** ${status}\n\n`}## Wave Execution Log\n\n${lines.join('\n')}${lines.length ? '\n' : ''}`;

const R1 = '261101-1000-run-todo-a';
const R2 = '261102-1000-run-todo-b';
const R3 = '261103-1000-do-c';
const R4 = '261104-1000-do-d';
const REC1 = rec(R1, {
  input: 'SF-1', waves: f(2), stories: f(3), gate_runs: f(4), gate_failures: f(0), first_pass_green_waves: f(2),
  fix_rounds: f(1, 'reported'), review_major: f(0, 'reported'), dispatches: f(10), misalignments: f(0, 'reported'),
  stops: f(0), output_tokens: f(1000, 'reported'),
});
const REC2 = rec(R2, {
  input: 'SF-2', status: 'failed', waves: f(2), stories: f(2), gate_runs: f(5), gate_failures: f(2),
  first_pass_green_waves: f(1), fix_rounds: f(2, 'reported'), review_major: f(1, 'reported'), dispatches: f(20),
  misalignments: f(1, 'reported'), stops: f(0), output_tokens: f(3000, 'reported'),
});
const REC3 = rec(R3, {
  command: 'do', input: 'SF-3', status: 'blocked', waves: f(1), stories: f(1), gate_runs: f(2), gate_failures: f(1),
  first_pass_green_waves: f(0), fix_rounds: f(null, 'reported'), review_major: f(null, 'reported'), dispatches: f(30),
  misalignments: f(null, 'reported'), stops: f(1), output_tokens: f(null, 'reported'),
});
const REC4 = rec(R4, {
  command: 'do', input: 'SF-4', waves: f(null), stories: f(null), gate_runs: f(null), gate_failures: f(1),
  first_pass_green_waves: f(null), fix_rounds: f(3, 'reported'), review_major: f(2, 'reported'), dispatches: f(null),
  misalignments: undefined, stops: f(0), output_tokens: f(5000, 'reported'),
});

const P_BOTH = `${PLANS}/261120-0900-run-todo-a.md`; // R1 + R2; the file stamp is later than the run ids on purpose
const P_BLOCKED = `${PLANS}/2026-11/261103-1000-do-c.md`; // R3
const P_MALFORMED_PLUS_VALID = `${PLANS}/261104-1000-do-d.md`; // R4 + one unparsable record line
const P_PLANNING = `${PLANS}/261105-1000-do-e.md`; // no record
const P_NO_STATUS = `${PLANS}/261106-1000-do-f.md`; // no record, no Status line
const P_ONLY_BAD = `${PLANS}/261107-1000-do-g.md`; // two bad record lines, nothing valid

/** The full fixture: 6 plans, 4 valid records (R1..R4), 3 malformed lines, gate rows, a TODO file. */
function mkFixture() {
  const root = mkRoot();
  put(root, P_BOTH, plan('complete', [recLine(REC2), recLine(REC1)]));
  put(root, P_BLOCKED, plan('blocked — waiting on the owner', [recLine(REC3)]));
  put(root, P_MALFORMED_PLUS_VALID, plan('complete', ['**Run record:** {not json', recLine(REC4)]));
  put(root, P_PLANNING, plan('planning'));
  put(root, P_NO_STATUS, plan(null));
  put(root, P_ONLY_BAD, plan('complete', ['**Run record:** {"run_id":', '**Run record:** [1,2]']));
  const gate = (command, outcome) => ({ timestamp: '2026-11-18T10:00:00.000Z', type: 'gate_run', command, outcome });
  const rows = [
    gate('gate:test', 'success'), gate('gate:test', 'success'), gate('gate:test', 'success'), gate('gate:test', 'failure'),
    gate('gate:test', 'unknown'), gate('gate:build', 'success'), gate('gate:build', 'success'),
    { timestamp: '2026-11-18T10:00:00.000Z', type: 'command_invocation', command: 'do' },
  ];
  put(root, `${TELEMETRY}/command-usage.jsonl`, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n{broken line\n`);
  put(root, 'docs/TODO_fixture.md', '# TODO\n\n- [x] **S1 a**\n- [x] **S2 b**\n- [x] **S3 c**\n- [ ] **S4 d**\n');
  return root;
}

const build = (root, opts = {}) => subject().buildScoreboard({ root, now: NOW, ...opts });
const COUNTERS = ['waves', 'stories', 'gate_runs', 'gate_failures', 'first_pass_green_waves', 'fix_rounds', 'review_major', 'dispatches', 'misalignments', 'stops', 'output_tokens'];
const ROW_KEYS = ['plan', 'run_id', 'command', 'input', 'has_record', 'status', 'plan_status', 'commit', 'ship_token', 'ship_check', ...COUNTERS, 'first_pass_green'].sort();
const rowOf = (sb, runId) => sb.runs.find((r) => r.run_id === runId);
const ROLLING_KEYS = ['window', 'runs', 'success_rate', 'first_pass_green_rate', 'mean_fix_rounds', 'mean_review_major', 'mean_dispatches', 'mean_output_tokens', 'mean_gate_failures', 'mean_stops'].sort();

function runCli(args, root, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', cwd: root, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
}
function snapshot(dir, base = dir, out = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(full, base, out);
    else out[path.relative(base, full)] = `${fs.statSync(full).mtimeMs}:${fs.readFileSync(full, 'utf8')}`;
  }
  return out;
}
const mdValue = (md, label) => {
  const m = md.match(new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (.*)$`, 'm'));
  return m ? m[1] : undefined;
};
function tableFirstCells(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === '## Runs');
  if (start < 0) return null;
  const rows = [];
  for (const l of lines.slice(start + 1)) {
    if (/^## /.test(l)) break;
    if (l.startsWith('|')) rows.push(l.split('|')[1].trim());
  }
  return rows.slice(2); // header row + separator row
}

// ── AC1: roll-up inputs ─────────────────────────────────────────────

describe('run-scoreboard: gate pass rate comes from metrics.js (AC1)', () => {
  it('buildScoreboard_gateRows_reportsPassFailTotalAndRatePerGate', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const sb = build(root);

    // Assert: test = 3 success + 1 failure (the `unknown` row carries no signal); build = 2 success
    expect(sb.gate).toEqual({
      test: { pass: 3, fail: 1, total: 4, pass_rate: 75 },
      build: { pass: 2, fail: 0, total: 2, pass_rate: 100 },
    });
  });

  it('buildScoreboard_gateCountsOnFixture_equalMetricsComputeTelemetryNumbers', () => {
    // Arrange
    const root = mkFixture();
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;
    delete require.cache[require.resolve('../metrics')];

    // Act
    let expected;
    try { expected = require('../metrics').computeTelemetry().gate_results; } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev;
      delete require.cache[require.resolve('../metrics')];
    }
    const sb = build(root);

    // Assert
    expect(sb.gate.test).toEqual({ pass: expected['gate:test'].pass, fail: expected['gate:test'].fail, total: 4, pass_rate: expected['gate:test'].pass_rate });
    expect(sb.gate.build).toEqual({ pass: expected['gate:build'].pass, fail: expected['gate:build'].fail, total: 2, pass_rate: expected['gate:build'].pass_rate });
  });

  it('source_gateCounts_importedFromMetricsAndNeverRecountedFromGateRunRows', () => {
    // Arrange / Act
    const src = fs.readFileSync(SCRIPT, 'utf8');

    // Assert
    expect(src).toMatch(/require\(\s*['"]\.\/metrics(\.js)?['"]\s*\)/);
    expect(src).not.toMatch(/gate_run\b/);
  });

  it('buildScoreboard_gateTestOnlyUnknownOutcomes_totalZeroRateIsNullNotZeroOrNaN', () => {
    // Arrange: a `gate:test` key exists (metrics creates it) with 0 pass and 0 fail
    const root = mkRoot();
    put(root, `${TELEMETRY}/command-usage.jsonl`, `${JSON.stringify({ type: 'gate_run', command: 'gate:test', outcome: 'unknown' })}\n`);

    // Act
    const sb = build(root);

    // Assert
    expect(sb.gate).toEqual({ test: { pass: 0, fail: 0, total: 0, pass_rate: null }, build: null });
  });

  it('buildScoreboard_noCommandUsageFile_gateIsNull', () => {
    // Arrange
    const root = mkRoot();

    // Act / Assert
    expect(build(root).gate).toBeNull();
  });
});

describe('run-scoreboard: TODO completion comes from metrics.js (AC1)', () => {
  it('buildScoreboard_todoFileWithThreeOfFourDone_reportsFilesTotalDoneAndRate', () => {
    // Arrange
    const root = mkFixture();

    // Act / Assert
    expect(build(root).todos).toEqual({ files: 1, total: 4, done: 3, completion_rate: 75 });
  });

  it('buildScoreboard_noTodoFiles_todosIsNull', () => {
    // Arrange
    const root = mkRoot();

    // Act / Assert
    expect(build(root).todos).toBeNull();
  });
});

describe('run-scoreboard: plan roll-up (AC1)', () => {
  it('buildScoreboard_sixPlansThreeWithValidRecords_countsPlansAndMalformedLines', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const { plans } = build(root);

    // Assert
    expect(plans.total).toBe(6);
    expect(plans.with_record).toBe(3);
    expect(plans.without_record).toBe(3);
    expect(plans.malformed_records).toBe(3);
  });

  it('buildScoreboard_statusLines_countedByFirstWordLowercasedWithUnknownForMissing', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const { plans } = build(root);

    // Assert
    expect(plans.by_status).toEqual({ complete: 3, blocked: 1, planning: 1, unknown: 1 });
  });

  it('buildScoreboard_plansInDatedSubfolder_areFoundRecursively', () => {
    // Arrange: only plan lives under plans/2026-11/
    const root = mkRoot();
    put(root, `${PLANS}/2026-11/261103-1000-do-c.md`, plan('complete', [recLine(REC3)]));

    // Act
    const sb = build(root);

    // Assert
    expect(sb.plans.total).toBe(1);
    expect(sb.runs.map((r) => r.plan)).toEqual([`${PLANS}/2026-11/261103-1000-do-c.md`]);
  });

  it('buildScoreboard_noPlansDirectory_plansIsNullAndRunsEmpty', () => {
    // Arrange
    const root = mkRoot();

    // Act
    const sb = build(root);

    // Assert
    expect(sb.plans).toBeNull();
    expect(sb.runs).toEqual([]);
  });
});

describe('run-scoreboard: per-run rows (AC1)', () => {
  it('buildScoreboard_fixture_hasOneRowPerValidRecordPlusOnePerRecordlessPlanSortedByRunId', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const sb = build(root);

    // Assert: R1/R2 come from one plan written in the opposite order; no-record rows sort by plan basename
    expect(sb.runs.map((r) => r.run_id ?? r.plan)).toEqual([
      R1, R2, R3, R4,
      `${PLANS}/261105-1000-do-e.md`, `${PLANS}/261106-1000-do-f.md`, `${PLANS}/261107-1000-do-g.md`,
    ]);
    expect(sb.runs.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(ROW_KEYS))).toBe(true);
  });

  it('buildScoreboard_completeRecord_unwrapsEveryCounterToItsBareNumber', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const row = rowOf(build(root), R2);

    // Assert
    expect(row).toEqual({
      plan: P_BOTH, run_id: R2, command: 'run-todo', input: 'SF-2', has_record: true, status: 'failed',
      plan_status: 'complete', commit: null, ship_token: null, ship_check: null, waves: 2, stories: 2, gate_runs: 5, gate_failures: 2, first_pass_green_waves: 1,
      first_pass_green: false, fix_rounds: 2, review_major: 1, dispatches: 20, misalignments: 1, stops: 0, output_tokens: 3000,
    });
  });

  it('buildScoreboard_recordWithNullValuesAndAMissingField_surfacesEachAsNull', () => {
    // Arrange: R4 has null waves/gate_runs/dispatches and no `misalignments` key at all
    const root = mkFixture();

    // Act
    const row = rowOf(build(root), R4);

    // Assert
    expect(row).toEqual({
      plan: P_MALFORMED_PLUS_VALID, run_id: R4, command: 'do', input: 'SF-4', has_record: true, status: 'passed',
      plan_status: 'complete', commit: null, ship_token: null, ship_check: null, waves: null, stories: null, gate_runs: null, gate_failures: 1, first_pass_green_waves: null,
      first_pass_green: null, fix_rounds: 3, review_major: 2, dispatches: null, misalignments: null, stops: 0, output_tokens: 5000,
    });
  });

  it.each([
    ['every wave first-pass green', R1, true],
    ['one of two waves first-pass green', R2, false],
    ['zero of one wave first-pass green', R3, false],
    ['waves unknown', R4, null],
  ])('buildScoreboard_%s_firstPassGreenIs_%s', (_name, runId, expected) => {
    // Arrange
    const root = mkFixture();

    // Act / Assert
    expect(rowOf(build(root), runId).first_pass_green).toBe(expected);
  });

  it('buildScoreboard_recordWithZeroWaves_firstPassGreenIsNullNotNaNOrTrue', () => {
    // Arrange: 0 waves, 0 first-pass-green: 0 === 0 must not read as "all green"
    const root = mkRoot();
    put(root, `${PLANS}/261101-1000-do-z.md`, plan('complete', [recLine(rec('261101-1000-do-z', { waves: f(0), first_pass_green_waves: f(0) }))]));

    // Act
    const sb = build(root);

    // Assert
    expect(sb.runs[0].first_pass_green).toBeNull();
    expect(sb.rolling.first_pass_green_rate).toBeNull();
  });

  it('buildScoreboard_recordFieldNotInValueSourceShape_isNullNotCrash', () => {
    // Arrange: fix_rounds is a bare number and dispatches a string: neither is the contract's { value, source }
    const root = mkRoot();
    put(root, `${PLANS}/261101-1000-do-s.md`, plan('complete', [recLine(rec('261101-1000-do-s', { fix_rounds: 5, dispatches: 'many' }))]));

    // Act
    const row = build(root).runs[0];

    // Assert
    expect(row.fix_rounds).toBeNull();
    expect(row.dispatches).toBeNull();
  });

  it('buildScoreboard_planWithoutValidRecord_isRowWithEveryRunFieldNull', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const sb = build(root);
    const row = sb.runs.find((r) => r.plan === P_PLANNING);

    // Assert: the "runs that have no run record" the dogfood AC counts
    const nulls = Object.fromEntries([...COUNTERS, 'run_id', 'command', 'input', 'status', 'first_pass_green', 'commit', 'ship_token', 'ship_check'].map((k) => [k, null]));
    expect(row).toEqual({ plan: P_PLANNING, has_record: false, plan_status: 'planning', ...nulls });
    expect(sb.runs.filter((r) => !r.has_record).length).toBe(sb.plans.without_record);
  });

  it('buildScoreboard_planWithNoStatusLine_planStatusIsNull', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const row = build(root).runs.find((r) => r.plan === P_NO_STATUS);

    // Assert
    expect(row.plan_status).toBeNull();
  });

  it('buildScoreboard_statusLineWithProse_planStatusIsTheTrimmedTextAfterTheLabel', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const row = rowOf(build(root), R3);

    // Assert
    expect(row.plan_status).toBe('blocked — waiting on the owner');
  });
});

describe('run-scoreboard: malformed record lines are skipped and counted, never crash (AC1)', () => {
  it.each([
    ['unparsable JSON', '**Run record:** {not json'],
    ['a JSON number', '**Run record:** 42'],
    ['a JSON array', '**Run record:** [1,2]'],
    ['an object without a string run_id', '**Run record:** {"status":"passed"}'],
  ])('buildScoreboard_%s_isSkippedAndCountedAsMalformed', (_name, line) => {
    // Arrange
    const root = mkRoot();
    put(root, `${PLANS}/261101-1000-do-m.md`, plan('complete', [line]));

    // Act
    const sb = build(root);

    // Assert
    expect(sb.plans).toEqual({ total: 1, with_record: 0, without_record: 1, other_plans: 0, malformed_records: 1, by_status: { complete: 1 }, ship_check: { sealed: 0, skipped: 0, missing: 0, unknown: 0 } });
    expect(sb.runs.map((r) => r.has_record)).toEqual([false]);
  });

  it('buildScoreboard_validRecordBesideAMalformedOne_stillCountsTheValidRun', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const sb = build(root);

    // Assert
    expect(rowOf(sb, R4).status).toBe('passed');
  });
});

describe('run-scoreboard: rolling-N math and null handling (AC4)', () => {
  const nullRolling = (window) => ({
    window, runs: 0, success_rate: null, first_pass_green_rate: null, mean_fix_rounds: null, mean_review_major: null,
    mean_dispatches: null, mean_output_tokens: null, mean_gate_failures: null, mean_stops: null,
  });

  it('buildScoreboard_defaultWindowOverFourRecords_rollsUpEveryMetricExactly', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const { rolling } = build(root);

    // Assert: success 2 of 4; first-pass 3 of 5 waves (R4 has no waves); means skip nulls
    expect(rolling).toEqual({
      window: 10, runs: 4, success_rate: 50, first_pass_green_rate: 60,
      mean_fix_rounds: 2, // (1 + 2 + 3) / 3, R3 null
      mean_review_major: 1, // (0 + 1 + 2) / 3
      mean_dispatches: 20, // (10 + 20 + 30) / 3, R4 null
      mean_output_tokens: 3000, // (1000 + 3000 + 5000) / 3, R3 null
      mean_gate_failures: 1, // (0 + 2 + 1 + 1) / 4
      mean_stops: 0.25, // (0 + 0 + 1 + 0) / 4
    });
    expect(Object.keys(rolling).sort()).toEqual(ROLLING_KEYS);
  });

  it('buildScoreboard_windowOfTwo_usesTheTwoLatestRunsByRunIdAndKeepsZeroDistinctFromNull', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const { rolling } = build(root, { rolling: 2 });

    // Assert: R3 + R4. first-pass 0 of 1 wave is 0 (a real rate), not null.
    expect(rolling).toEqual({
      window: 2, runs: 2, success_rate: 50, first_pass_green_rate: 0, mean_fix_rounds: 3, mean_review_major: 2,
      mean_dispatches: 30, mean_output_tokens: 5000, mean_gate_failures: 1, mean_stops: 0.5,
    });
  });

  it('buildScoreboard_windowOfOneWhereAFieldIsNull_thatMeanIsNullNotZeroOrNaN', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const { rolling } = build(root, { rolling: 1 });

    // Assert: R4 only: dispatches and waves are null
    expect(rolling).toEqual({
      window: 1, runs: 1, success_rate: 100, first_pass_green_rate: null, mean_fix_rounds: 3, mean_review_major: 2,
      mean_dispatches: null, mean_output_tokens: 5000, mean_gate_failures: 1, mean_stops: 0,
    });
  });

  it('buildScoreboard_windowOfThree_roundsRateToOneDecimal', () => {
    // Arrange
    const root = mkFixture();

    // Act: R2 failed, R3 blocked, R4 passed -> 1 of 3
    const { rolling } = build(root, { rolling: 3 });

    // Assert
    expect(rolling.success_rate).toBe(33.3);
  });

  it('buildScoreboard_recordlessPlansAreNotCountedInTheWindow', () => {
    // Arrange: 3 recordless plans sit after R4 in run order; a window of 4 must still be R1..R4
    const root = mkFixture();

    // Act
    const { rolling } = build(root, { rolling: 4 });

    // Assert
    expect(rolling.runs).toBe(4);
    expect(rolling.success_rate).toBe(50);
  });

  it.each([[0], [-3], [2.5], ['abc'], [null], [undefined]])('buildScoreboard_rollingOption_%s_fallsBackToTen', (n) => {
    // Arrange
    const root = mkFixture();

    // Act / Assert
    expect(build(root, { rolling: n }).rolling.window).toBe(10);
  });

  it('buildScoreboard_onlyRecordlessPlans_everyRollingFieldIsNullAndRunsIsZero', () => {
    // Arrange
    const root = mkRoot();
    put(root, P_PLANNING, plan('planning'));

    // Act
    const sb = build(root);

    // Assert
    expect(sb.rolling).toEqual(nullRolling(10));
  });

  it('buildScoreboard_emptyRoot_rollingIsAllNull', () => {
    // Arrange
    const root = mkRoot();

    // Act / Assert
    expect(build(root).rolling).toEqual(nullRolling(10));
  });
});

describe('run-scoreboard: optional session-timesplit roll-up (AC1)', () => {
  const S1 = { wallHours: 2, subagents: { runs: 5, totalHours: 1.5, fixRounds: { rounds: 2 } } };
  const S2 = { wallHours: 1, subagents: { runs: 3, totalHours: 0.75, fixRounds: { rounds: 1 } } };

  it('buildScoreboard_twoTimesplitSessions_sumsSessionsAgentRunsHoursAndFixRounds', () => {
    // Arrange
    const root = mkRoot();

    // Act
    const sb = build(root, { timesplit: [S1, S2] });

    // Assert
    expect(sb.timesplit).toEqual({ sessions: 2, agent_runs: 8, agent_hours: 2.25, fix_rounds: 3 });
  });

  it('buildScoreboard_unusableTimesplitEntries_areSkippedNotCounted', () => {
    // Arrange: null, a string and an object without `subagents`
    const root = mkRoot();

    // Act
    const sb = build(root, { timesplit: [S1, null, 'junk', { wallHours: 9 }] });

    // Assert
    expect(sb.timesplit).toEqual({ sessions: 1, agent_runs: 5, agent_hours: 1.5, fix_rounds: 2 });
  });

  it.each([[undefined], [[]], [[null, 'junk']]])('buildScoreboard_timesplitInput_%j_isNull', (input) => {
    // Arrange
    const root = mkRoot();

    // Act / Assert
    expect(build(root, { timesplit: input }).timesplit).toBeNull();
  });
});

describe('run-scoreboard: shape, read-only and degradation (AC1)', () => {
  it('buildScoreboard_fixture_hasExactlyTheDocumentedTopLevelKeysAndGeneratedClock', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const sb = build(root);

    // Assert
    expect(Object.keys(sb).sort()).toEqual(['gate', 'generated', 'plans', 'rolling', 'runs', 'timesplit', 'todos']);
    expect(sb.generated).toBe(NOW.toISOString());
  });

  it('buildScoreboard_fixture_writesNothingAndChangesNothing', () => {
    // Arrange
    const root = mkFixture();
    const before = snapshot(root);

    // Act
    build(root, { timesplit: [{ subagents: { runs: 1, totalHours: 1, fixRounds: { rounds: 0 } } }] });

    // Assert
    expect(snapshot(root)).toEqual(before);
  });

  it('buildScoreboard_nonexistentRoot_returnsEveryInputNullWithoutThrowing', () => {
    // Arrange
    const root = path.join(mkRoot(), 'does-not-exist');

    // Act
    const sb = build(root);

    // Assert
    expect([sb.gate, sb.todos, sb.plans, sb.timesplit]).toEqual([null, null, null, null]);
    expect(sb.runs).toEqual([]);
  });

  it('buildScoreboard_planFileWithCrlfLineEndings_stillParsesStatusAndRecord', () => {
    // Arrange
    const root = mkRoot();
    put(root, `${PLANS}/261101-1000-run-todo-a.md`, plan('complete', [recLine(REC1)]).replace(/\n/g, '\r\n'));

    // Act
    const sb = build(root);

    // Assert
    expect(sb.runs.map((r) => [r.run_id, r.plan_status])).toEqual([[R1, 'complete']]);
  });
});

// ── AC1: markdown ───────────────────────────────────────────────────

describe('run-scoreboard: markdown output (AC1)', () => {
  it('renderMarkdown_fixture_showsEveryNumberAsTheExactComputedValue', () => {
    // Arrange
    const md = subject().renderMarkdown(build(mkFixture()));

    // Act / Assert
    const got = Object.fromEntries([
      'test pass rate', 'build pass rate', 'todo completion', 'plans', 'plans with run record', 'plans without run record',
      'malformed run records', 'runs in window', 'success rate', 'first-pass-green rate', 'mean fix rounds',
      'mean review major', 'mean dispatches', 'mean output tokens', 'mean gate failures', 'mean stops',
    ].map((label) => [label, mdValue(md, label)]));
    expect(got).toEqual({
      'test pass rate': '75.0% (3 of 4)', 'build pass rate': '100.0% (2 of 2)', 'todo completion': '75.0% (3 of 4)',
      plans: '6', 'plans with run record': '3', 'plans without run record': '3', 'malformed run records': '3',
      'runs in window': '4', 'success rate': '50.0%', 'first-pass-green rate': '60.0%', 'mean fix rounds': '2',
      'mean review major': '1', 'mean dispatches': '20', 'mean output tokens': '3000', 'mean gate failures': '1',
      'mean stops': '0.25',
    });
  });

  it('renderMarkdown_fixture_listsOneTableRowPerRunInRunOrder', () => {
    // Arrange
    const md = subject().renderMarkdown(build(mkFixture()));

    // Act / Assert
    expect(tableFirstCells(md)).toEqual([
      R1, R2, R3, R4, `${PLANS}/261105-1000-do-e.md`, `${PLANS}/261106-1000-do-f.md`, `${PLANS}/261107-1000-do-g.md`,
    ]);
  });

  it('renderMarkdown_emptyRoot_showsNotAvailableForEveryNullAndNeverNaNOrNullText', () => {
    // Arrange
    const md = subject().renderMarkdown(build(mkRoot()));

    // Act
    const got = ['test pass rate', 'build pass rate', 'todo completion', 'plans', 'success rate', 'first-pass-green rate', 'mean dispatches']
      .map((label) => mdValue(md, label));

    // Assert
    expect(got).toEqual(['n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a', 'n/a']);
    expect(mdValue(md, 'runs in window')).toBe('0');
    expect(md).not.toMatch(/NaN|undefined|null/);
  });
});

// ── AC1: CLI ────────────────────────────────────────────────────────

describe('run-scoreboard: CLI (AC1)', () => {
  it('cli_jsonFlag_printsExactlyOneJsonDocumentEqualToTheApiResultAndExitsZero', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const r = runCli(['--json'], root);

    // Assert
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    const api = JSON.parse(JSON.stringify(build(root)));
    expect({ ...doc, generated: null }).toEqual({ ...api, generated: null });
  });

  it('cli_noFlags_printsTheMarkdownScoreboardAndExitsZero', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const r = runCli([], root);

    // Assert
    expect(r.status).toBe(0);
    expect(mdValue(r.stdout, 'success rate')).toBe('50.0%');
    expect(tableFirstCells(r.stdout).length).toBe(7);
  });

  it('cli_rollingFlag_changesTheWindowAndShowsNotAvailableForNullMeans', () => {
    // Arrange
    const root = mkFixture();

    // Act
    const r = runCli(['--rolling', '1'], root);

    // Assert: R4 only
    expect(r.status).toBe(0);
    expect(mdValue(r.stdout, 'runs in window')).toBe('1');
    expect(mdValue(r.stdout, 'success rate')).toBe('100.0%');
    expect(mdValue(r.stdout, 'mean dispatches')).toBe('n/a');
    expect(mdValue(r.stdout, 'first-pass-green rate')).toBe('n/a');
  });

  it('cli_timesplitFlagRepeated_sumsTheReadableFiles', () => {
    // Arrange (m9: the unreadable and missing files this test used to include are now usage errors, pinned in the m9 describe)
    const root = mkRoot();
    const a = put(root, 'ts-a.json', JSON.stringify({ subagents: { runs: 5, totalHours: 1.5, fixRounds: { rounds: 2 } } }));
    const b = put(root, 'ts-b.json', JSON.stringify({ subagents: { runs: 3, totalHours: 0.75, fixRounds: { rounds: 1 } } }));

    // Act
    const r = runCli(['--json', '--timesplit', a, '--timesplit', b], root);

    // Assert
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).timesplit).toEqual({ sessions: 2, agent_runs: 8, agent_hours: 2.25, fix_rounds: 3 });
  });

  it('cli_emptyRoot_exitsZeroWithEveryInputNull', () => {
    // Arrange
    const root = mkRoot();

    // Act
    const r = runCli(['--json'], root);

    // Assert
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect([doc.gate, doc.todos, doc.plans, doc.timesplit]).toEqual([null, null, null, null]);
    expect(doc.runs).toEqual([]);
    expect(doc.rolling.runs).toBe(0);
  });

  it.each([
    ['an unknown flag', ['--json', '--frobnicate']],
  ])('cli_%s_stillExitsZeroAndPrintsTheScoreboard', (_name, args) => {
    // Arrange
    const root = mkFixture();

    // Act
    const r = runCli(args, root);

    // Assert
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).plans.total).toBe(6);
  });

  it('cli_run_isReadOnly', () => {
    // Arrange
    const root = mkFixture();
    const before = snapshot(root);

    // Act
    const json = runCli(['--json'], root);
    const md = runCli([], root);

    // Assert
    expect([json.status, md.status]).toEqual([0, 0]);
    expect(snapshot(root)).toEqual(before);
  });
});

// ── m9: what counts as a run, bad arguments, the gate caveat ─────────────────────────────────────

describe('m9 run-scoreboard: only run-shaped plans are runs', () => {
  const DESIGN = `${PLANS}/261110-0900-design-the-thing.md`;
  const DECISIONS = `${PLANS}/261110-0901-decisions.md`;
  const RUN_NO_RECORD = `${PLANS}/261111-1000-run-todo-nothing-recorded.md`;
  const DO_NO_RECORD = `${PLANS}/261111-1100-do-small-thing.md`;
  const ODD_NAME_WITH_RECORD = `${PLANS}/261112-1000-sweep-with-record.md`;
  const ODD_NAME_BAD_RECORD = `${PLANS}/261113-1000-sweep-bad-record.md`;

  function mkMixed() {
    const root = mkRoot();
    put(root, DESIGN, plan('design'));
    put(root, DECISIONS, plan('decisions'));
    put(root, RUN_NO_RECORD, plan('complete'));
    put(root, DO_NO_RECORD, plan('in progress'));
    put(root, ODD_NAME_WITH_RECORD, plan('complete', [recLine(rec(R1))]));
    put(root, ODD_NAME_BAD_RECORD, plan('complete', ['**Run record:** {not json']));
    return root;
  }

  it('buildScoreboard_designAndDecisionPlans_areOtherPlansNotRunsAndNotInTheRunsTable', () => {
    const sb = build(mkMixed());

    expect(sb.plans.total).toBe(6);
    expect(sb.plans.other_plans).toBe(2);
    expect(sb.runs.map((r) => r.plan)).not.toContain(DESIGN);
    expect(sb.runs.map((r) => r.plan)).not.toContain(DECISIONS);
  });

  it('buildScoreboard_runShapedPlansWithoutARecord_areTheRunsThatHaveNoRunRecord', () => {
    const sb = build(mkMixed());

    expect(sb.plans.without_record).toBe(3); // run-todo and do named plans + the odd-named plan whose only record line is malformed
    expect(sb.plans.with_record).toBe(1);
    expect(sb.runs.filter((r) => !r.has_record).map((r) => r.plan).sort()).toEqual([DO_NO_RECORD, ODD_NAME_BAD_RECORD, RUN_NO_RECORD].sort());
  });

  it('buildScoreboard_aPlanWithAValidRecordIsARunWhateverItsName', () => {
    const sb = build(mkMixed());

    expect(rowOf(sb, R1).plan).toBe(ODD_NAME_WITH_RECORD);
  });

  it('buildScoreboard_theCountsAddUp_totalIsWithPlusWithoutPlusOther', () => {
    const { plans } = build(mkMixed());

    expect(plans.with_record + plans.without_record + plans.other_plans).toBe(plans.total);
  });

  it('buildScoreboard_byStatusCountsRunPlansOnly_designAndDecisionsStatusesDoNotAppear', () => {
    const { plans } = build(mkMixed());

    expect(plans.by_status).toEqual({ complete: 3, in: 1 });
  });

  it('buildScoreboard_aNonRunPlanWithAMalformedRecordLine_stillCountsTheMalformedLine', () => {
    const root = mkRoot();
    put(root, DESIGN, plan('design', ['**Run record:** {broken']));

    const { plans } = build(root);

    expect(plans.malformed_records).toBe(1);
    expect(plans.other_plans).toBe(0); // a record line, even a bad one, makes it a run plan
  });

  it('renderMarkdown_showsTheOtherPlanDocumentsCountAndNoRunsRowForThem', () => {
    const md = subject().renderMarkdown(build(mkMixed()));

    expect(md).toContain('- other plan documents (not runs): 2');
    expect(md).not.toContain('design-the-thing');
  });
});

describe('m9 run-scoreboard CLI: bad arguments are usage errors (exit 2), not silently dropped', () => {
  it.each([
    ['abc', 'abc'],
    ['zero', '0'],
    ['negative', '-3'],
    ['fractional', '2.5'],
    ['empty', ''],
  ])('cli_rolling_%s_exits2WithAMessageAndNothingOnStdout', (_name, value) => {
    const root = mkFixture();

    const r = runCli(['--json', '--rolling', value], root);

    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--rolling');
    expect(r.stderr).toContain('Usage:');
  });

  it('cli_rollingEqualsForm_isValidatedToo', () => {
    const root = mkFixture();

    expect(runCli(['--json', '--rolling=abc'], root).status).toBe(2);
    expect(JSON.parse(runCli(['--json', '--rolling=2'], root).stdout).rolling.window).toBe(2);
  });

  it('cli_rollingWithoutAValue_exits2', () => {
    const r = runCli(['--json', '--rolling'], mkFixture());

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--rolling needs a value');
  });

  it('cli_timesplitWithoutAValue_exits2', () => {
    const r = runCli(['--timesplit'], mkFixture());

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--timesplit needs a value');
  });

  it('cli_timesplitFileMissing_exits2NamingTheFile', () => {
    const root = mkFixture();
    const missing = path.join(root, 'nope.json');

    const r = runCli(['--json', '--timesplit', missing], root);

    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(missing);
  });

  it('cli_timesplitFileNotJson_exits2', () => {
    const root = mkFixture();
    const bad = put(root, 'ts-bad.json', '{nope');

    const r = runCli(['--json', '--timesplit', bad], root);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain(bad);
  });

  it('cli_timesplitFileThatIsJsonButNotATimesplitReport_exits2', () => {
    const root = mkFixture();
    const wrong = put(root, 'ts-wrong.json', JSON.stringify({ wallHours: 9 }));

    const r = runCli(['--json', '--timesplit', wrong], root);

    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a session-timesplit/);
  });

  it('cli_aGoodTimesplitFileNextToABadOne_stillExits2AndReportsEveryProblem', () => {
    const root = mkFixture();
    const good = put(root, 'ts-good.json', JSON.stringify({ subagents: { runs: 1, totalHours: 1, fixRounds: { rounds: 0 } } }));

    const r = runCli(['--json', '--rolling', 'x', '--timesplit', good, '--timesplit', path.join(root, 'gone.json')], root);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--rolling');
    expect(r.stderr).toContain('gone.json');
  });

  it('cli_aUsageError_writesNothingToDisk', () => {
    const root = mkFixture();
    const before = snapshot(root);

    runCli(['--rolling', 'abc'], root);

    expect(snapshot(root)).toEqual(before);
  });

  it('buildScoreboard_apiStillFallsBackToTenOnABadRolling_onlyTheCliRejects', () => {
    expect(build(mkFixture(), { rolling: 'abc' }).rolling.window).toBe(10);
  });
});

describe('m9 run-scoreboard markdown: the gate section carries the red-first caveat', () => {
  it('renderMarkdown_gateSection_hasOneCaveatLineBeforeTheRates', () => {
    const md = subject().renderMarkdown(build(mkFixture()));
    const gateSection = md.split('## Plans')[0];

    expect(gateSection).toMatch(/- note: the test pass rate counts intended red-first runs/);
    expect(gateSection.indexOf('- note:')).toBeLessThan(gateSection.indexOf('- test pass rate:'));
    expect(md).not.toMatch(/NaN|undefined|null/);
  });
});

// ── AC2: npm script ─────────────────────────────────────────────────

describe('run-scoreboard: npm script (AC2)', () => {
  it('packageJson_scripts_scoreboardRunsTheCoreScript', () => {
    // Arrange
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

    // Act / Assert
    expect(pkg.scripts.scoreboard).toMatch(/^node \.claude\/core\/run-scoreboard\.js(\s|$)/);
  });
});

// ── AC3: dogfood on this repo ───────────────────────────────────────

describe('run-scoreboard: dogfood on this repository (AC3)', () => {
  function liveMetrics() {
    const prev = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = REPO_ROOT;
    delete require.cache[require.resolve('../metrics')];
    try {
      const m = require('../metrics');
      return { telemetry: m.computeTelemetry(), todos: m.computeTodos() };
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev;
      delete require.cache[require.resolve('../metrics')];
    }
  }
  const expectedGate = (gr) => (gr ? { pass: gr.pass, fail: gr.fail, total: gr.pass + gr.fail, pass_rate: gr.pass + gr.fail > 0 ? gr.pass_rate : null } : null);
  function walkPlans(dir) {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) n += walkPlans(full); else if (e.name.endsWith('.md')) n += 1;
    }
    return n;
  }

  it('buildScoreboard_liveRepo_gatePassRatesEqualWhatMetricsReportsAtRunTime', () => {
    // Arrange: both are read back to back from the same live telemetry
    const live = liveMetrics();

    // Act
    const sb = build(REPO_ROOT);

    // Assert: null on a checkout with no ignored telemetry, the live numbers otherwise
    const gr = live.telemetry ? live.telemetry.gate_results : {};
    if (!live.telemetry) expect(sb.gate).toBeNull();
    else expect(sb.gate).toEqual({ build: expectedGate(gr['gate:build']), test: expectedGate(gr['gate:test']) });
  });

  it('buildScoreboard_liveRepo_todoCompletionEqualsMetrics', () => {
    // Arrange
    const live = liveMetrics();

    // Act
    const sb = build(REPO_ROOT);

    // Assert
    const t = live.todos;
    expect(sb.todos).toEqual({ files: t.files, total: t.total, done: t.done, completion_rate: t.completion_rate });
  });

  it('buildScoreboard_liveRepo_plansCountMatchesTheFilesOnDiskAndSplitsIntoWithAndWithoutRecord', () => {
    // Arrange
    const onDisk = walkPlans(path.join(REPO_ROOT, PLANS));

    // Act
    const { plans, runs } = build(REPO_ROOT);

    // Assert
    expect(onDisk).toBeGreaterThan(0);
    expect(plans.total).toBe(onDisk);
    expect(plans.with_record + plans.without_record + plans.other_plans).toBe(plans.total);
    expect(runs.filter((r) => !r.has_record).length).toBe(plans.without_record);
    expect(runs.filter((r) => !r.has_record).every((r) => r.waves === null && r.fix_rounds === null && r.output_tokens === null)).toBe(true);
  });
});

// ── security review m4: the ship-check trail is read from the commits, not from the self-reported token ──

describe('run-scoreboard: ship-check trail (security review m4)', () => {
  const IDENT = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
  const gitIn = (cwd, ...args) => {
    const r = spawnSync('git', [...IDENT, ...args], { cwd, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`fixture: git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commitWith = (root, message) => {
    gitIn(root, 'commit', '--allow-empty', '-q', '-m', message);
    return gitIn(root, 'rev-parse', 'HEAD');
  };
  const SEALED_RUN = '261110-1000-run-todo-sealed';
  const SKIPPED_RUN = '261111-1000-run-todo-skipped';
  const PLAIN_RUN = '261112-1000-run-todo-plain';
  const GONE_RUN = '261113-1000-run-todo-gone';
  const NONE_RUN = '261114-1000-run-todo-nocommit';

  function shipFixture({ git = true } = {}) {
    const root = mkRoot();
    let shas = { sealed: 'a1b2c3d', skipped: 'b2c3d4e', plain: 'c3d4e5f' };
    if (git) {
      gitIn(root, 'init', '-q', '-b', 'main');
      shas = {
        sealed: commitWith(root, 'feat: shipped\n\nShip-Check: a1b2c3d4e5f6'),
        skipped: commitWith(root, 'feat: skipped\n\nShip-Check-Skip: CI-only matrix job'),
        plain: commitWith(root, 'feat: plain git commit -F'),
      };
    }
    put(root, `${PLANS}/261110-1000-run-todo-ship.md`, plan('complete', [
      recLine(rec(SEALED_RUN, { commit: shas.sealed, receipt: 'rc-1', ship_token: 'OK' })),
      recLine(rec(SKIPPED_RUN, { commit: shas.skipped, receipt: null, ship_token: 'SKIP' })),
      recLine(rec(PLAIN_RUN, { commit: shas.plain, receipt: 'rc-2', ship_token: 'OK' })),
      recLine(rec(GONE_RUN, { commit: 'deadbeef', receipt: 'rc-3', ship_token: 'OK' })),
      recLine(rec(NONE_RUN, { status: 'killed', commit: null })),
    ]));
    return { root, shas };
  }

  it('buildScoreboard_eachRunRowCarriesTheStateOfItsCommitsTrailer', () => {
    const { root, shas } = shipFixture();

    const sb = build(root);

    const byRun = Object.fromEntries(sb.runs.map((r) => [r.run_id, [r.commit, r.ship_token, r.ship_check]]));
    expect(byRun).toEqual({
      [SEALED_RUN]: [shas.sealed, 'OK', 'sealed'],
      [SKIPPED_RUN]: [shas.skipped, 'SKIP', 'skipped'],
      [PLAIN_RUN]: [shas.plain, 'OK', 'missing'],
      [GONE_RUN]: ['deadbeef', 'OK', 'unknown'],
      [NONE_RUN]: [null, null, null],
    });
    expect(sb.plans.ship_check).toEqual({ sealed: 1, skipped: 1, missing: 1, unknown: 1 });
  });

  it('buildScoreboard_aRootThatIsNotARepository_reportsUnknownNeverSealed', () => {
    const { root } = shipFixture({ git: false });

    const sb = build(root);

    expect(sb.runs.filter((r) => r.commit !== null).map((r) => r.ship_check)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(sb.plans.ship_check).toEqual({ sealed: 0, skipped: 0, missing: 0, unknown: 4 });
  });

  it('renderMarkdown_listsEveryRunWhoseCommitLacksTheTrailer', () => {
    const { root, shas } = shipFixture();

    const md = subject().renderMarkdown(build(root));

    expect(mdValue(md, 'commits with the trailer (sealed)')).toBe('1');
    expect(mdValue(md, 'commits with the audited skip trailer')).toBe('1');
    expect(mdValue(md, 'commits WITHOUT the trailer (not ship-checked)')).toBe('1');
    expect(mdValue(md, 'commits not readable from this checkout')).toBe('1');
    expect(md).toContain(`  - ${PLAIN_RUN}: commit ${shas.plain} (token OK) lacks the Ship-Check trailer`);
    expect(md).not.toContain(`${SEALED_RUN}: commit`);
  });

  it('cli_withAMissingTrailer_stillExitsZeroAndWritesNothing', () => {
    const { root } = shipFixture();
    const before = snapshot(root);

    const r = runCli([], root);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('commits WITHOUT the trailer (not ship-checked): 1');
    expect(snapshot(root)).toEqual(before);
  });
});
