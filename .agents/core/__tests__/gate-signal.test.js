/**
 * SF-3.4 — gate-signal.js: classify the last gate result.
 *
 * PINNED CONTRACT (the implementer must match these names and shapes):
 *
 *   module.exports = { classify, readGateSignal }
 *
 *   readGateSignal(root: string) -> Signal
 *     Reads `<root>/docs/.output/.state/telemetry/_latest-summary.json` with `readSummary`
 *     (_lib/gate-summary.js), reads the last commit time of `root`, and classifies. Never
 *     throws: a missing/corrupt summary, a non-git root or a root that does not exist is `unknown`.
 *
 *   classify(summary: object|null, lastCommitMs: number|null) -> Signal
 *     Pure. `summary` is what `readSummary` returned (null = missing/corrupt/non-boolean overall);
 *     `lastCommitMs` is the last commit's committer time in epoch ms (null = unavailable).
 *     Freshness is the summary's own `timestamp` field (ISO string, written by gate.js),
 *     compared with `lastCommitMs`. An unparseable or missing timestamp, or a null
 *     `lastCommitMs`, is never `green` and never `red`.
 *
 *   Signal = { state: 'green'|'red'|'killed'|'stale'|'unknown',
 *              signature: string, reason: string, ts: string|null, failureNames: string[] }
 *     ts           = the summary's `timestamp` (null when there is no usable summary)
 *     failureNames = summary.test.failureNames (empty array when there are none)
 *     signature    = hex hash of (sorted failureNames, mode, build-failed flag, lint-failed flag)
 *
 *   CLI: `node .agents/core/gate-signal.js` (root = CLAUDE_PROJECT_DIR || cwd) prints the Signal
 *   as JSON on stdout and ALWAYS exits 0.
 *
 * Decisions the AC leaves open and these tests deliberately do NOT pin: the exact `state` of an
 * in-progress or build-only summary (only that it is never `green`/`red`), the `signature` of a
 * non-red state, and the `reason` wording (only that it is a non-empty string).
 *
 * Receipt behaviour (F6), partial runs (F7) and visual/timeout handling (F12) are pinned in the
 * review-fix describe blocks at the end of this file.
 * NOT COVERED: a `verifyReceiptForRoot` that THROWS (it cannot be made to throw through the real
 * module from a fixture); that branch is `unknown` by reading the code only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo } = require('./_helpers/git-fixture');

const __filename = fileURLToPath(import.meta.url);
const CORE_DIR = path.resolve(path.dirname(__filename), '..');
const SCRIPT = path.join(CORE_DIR, 'gate-signal.js');
const SUMMARY_REL = path.join('docs', '.output', '.state', 'telemetry', '_latest-summary.json');

// Fixed instants (never "now"): the last commit, a summary 1h after it, a summary 1h before it.
const T_COMMIT = '2026-01-01T00:00:00.000Z';
const T_NEW = '2026-01-01T01:00:00.000Z';
const T_OLD = '2025-12-31T23:00:00.000Z';
const COMMIT_MS = Date.parse(T_COMMIT);

const load = () => require('../gate-signal');

// ── summary builders (shapes copied from gate.js ~2016-2060) ─────────────────────────────────

const greenSummary = (over = {}) => ({
  timestamp: T_NEW,
  mode: 'BUILD + TEST',
  stack: 'node',
  overall: true,
  durationMs: 1200,
  build: { succeeded: true, errorCount: 0, warningCount: 0 },
  test: {
    succeeded: true, passed: 3, failed: 0, skipped: 0, total: 3,
    zeroCollected: false, timedOut: false, failureNames: [],
  },
  lint: { succeeded: true, errorCount: 0, warningCount: 0, skipped: true },
  ...over,
});

const redSummary = (over = {}) => ({
  timestamp: T_NEW,
  mode: 'BUILD + TEST',
  stack: 'node',
  overall: false,
  durationMs: 1200,
  build: { succeeded: true, errorCount: 0, warningCount: 0 },
  test: {
    succeeded: false, passed: 1, failed: 2, skipped: 0, total: 3,
    zeroCollected: false, timedOut: false, failureNames: ['b test', 'a test'],
  },
  lint: { succeeded: true, errorCount: 0, warningCount: 0, skipped: true },
  ...over,
});

// ── fixture: a temp git repo whose last commit is T_COMMIT ───────────────────────────────────

const tmps = [];
afterEach(() => { while (tmps.length) tmps.pop().cleanup(); });

/**
 * @param {{summary?: object, raw?: string}} [opts] `summary` is written as JSON, `raw` verbatim;
 *   neither = no summary file. The file mtime is set to the summary's own timestamp.
 */
function makeRepo({ summary, raw } = {}) {
  const tmp = createTmpDir({ prefix: 'gate-signal-' });
  tmps.push(tmp);
  const repo = createGitRepo({ root: tmp.root });
  repo.addCommitOnDate('last commit', T_COMMIT);
  if (summary !== undefined || raw !== undefined) {
    const file = path.join(tmp.root, SUMMARY_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw !== undefined ? raw : JSON.stringify(summary, null, 2));
    if (summary && summary.timestamp) {
      const when = new Date(summary.timestamp);
      fs.utimesSync(file, when, when);
    }
  }
  return tmp.root;
}

function runCli(cwd) {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return res;
}

// ── AC1: shape, CLI contract, exit 0 always ──────────────────────────────────────────────────

describe('gate-signal AC1: JSON shape and exit-0 contract', () => {
  it('module_exports_classifyAndReadGateSignal', () => {
    const mod = load();

    expect(typeof mod.classify).toBe('function');
    expect(typeof mod.readGateSignal).toBe('function');
  });

  it('readGateSignal_anyState_returnsExactlyTheFiveSeamKeys', () => {
    const root = makeRepo({ summary: redSummary() });

    const signal = load().readGateSignal(root);

    expect(Object.keys(signal).sort()).toEqual(['failureNames', 'reason', 'signature', 'state', 'ts']);
    expect(Array.isArray(signal.failureNames)).toBe(true);
    expect(typeof signal.reason).toBe('string');
    expect(signal.reason.length).toBeGreaterThan(0);
  });

  it('cli_redSummary_printsSignalJsonAndExitsZero', () => {
    const root = makeRepo({ summary: redSummary() });

    const res = runCli(root);

    expect(res.status).toBe(0);
    const signal = JSON.parse(res.stdout);
    expect(signal.state).toBe('red');
    expect(signal.ts).toBe(T_NEW);
    expect(signal.failureNames).toEqual(['a test', 'b test']);
  });

  it('cli_greenSummary_printsGreenAndExitsZero', () => {
    const root = makeRepo({ summary: greenSummary() });

    const res = runCli(root);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).state).toBe('green');
  });

  it.each([
    ['missing summary', () => makeRepo()],
    ['corrupt summary', () => makeRepo({ raw: '{ not json' })],
    ['non-boolean overall', () => makeRepo({ summary: greenSummary({ overall: 'true' }) })],
  ])('cli_%s_exitsZeroAndPrintsUnknown', (_label, build) => {
    const root = build();

    const res = runCli(root);

    expect(res.status).toBe(0);
    const signal = JSON.parse(res.stdout);
    expect(signal.state).toBe('unknown');
    expect(signal.ts).toBeNull();
    expect(signal.failureNames).toEqual([]);
  });

  it('cli_rootIsNotAGitRepo_stillExitsZeroWithValidJson', () => {
    const tmp = createTmpDir({ prefix: 'gate-signal-nogit-' });
    tmps.push(tmp);
    const file = path.join(tmp.root, SUMMARY_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(greenSummary()));

    const res = runCli(tmp.root);

    expect(res.status).toBe(0);
    const signal = JSON.parse(res.stdout);
    expect(signal.state).not.toBe('green');
    expect(signal.state).not.toBe('red');
  });

  it('readGateSignal_rootDoesNotExist_returnsUnknownWithoutThrowing', () => {
    const tmp = createTmpDir({ prefix: 'gate-signal-gone-' });
    tmps.push(tmp);
    const missing = path.join(tmp.root, 'no', 'such', 'dir');

    const signal = load().readGateSignal(missing);

    expect(signal.state).toBe('unknown');
  });

  it('gateSignalSource_usesReadSummaryAndVerifyReceiptForRootDirectly', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');

    expect(source).toMatch(/readSummary/);
    expect(source).toMatch(/verifyReceiptForRoot/);
    expect(source).toMatch(/gate-summary/);
    expect(source).toMatch(/gate-receipt/);
  });
});

// ── AC2: red / killed / stale / unknown / green rules ────────────────────────────────────────

describe('gate-signal AC2: red', () => {
  it('readGateSignal_overallFalseNotKilledNewerThanCommit_isRedWithItsFailureNames', () => {
    const root = makeRepo({ summary: redSummary() });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('red');
    expect(signal.ts).toBe(T_NEW);
    expect(signal.failureNames).toEqual(['a test', 'b test']);
  });

  it('readGateSignal_buildFailureWithNoTestLeg_isRed', () => {
    const root = makeRepo({
      summary: {
        timestamp: T_NEW, mode: 'BUILD', stack: 'node', overall: false, durationMs: 10,
        build: { succeeded: false, errorCount: 2, warningCount: 0 },
      },
    });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('red');
    expect(signal.failureNames).toEqual([]);
  });

  it('classify_overallFalseExactlyAtLastCommitTime_isStaleNotRed', () => {
    const signal = load().classify(redSummary({ timestamp: T_COMMIT }), COMMIT_MS);

    expect(signal.state).toBe('stale');
  });

  it('classify_overallFalseOneSecondAfterLastCommit_isRed', () => {
    const signal = load().classify(redSummary({ timestamp: '2026-01-01T00:00:01.000Z' }), COMMIT_MS);

    expect(signal.state).toBe('red');
  });

  // Review n2: the reason named the summary header ("BUILD + TEST") instead of the legs that failed.
  it.each([
    ['only the test leg failed', redSummary(), 'the gate failed (test leg)'],
    ['only the build leg failed', redSummary({ test: undefined, build: { succeeded: false, errorCount: 2, warningCount: 0 } }), 'the gate failed (build leg)'],
    ['the build and lint legs failed', redSummary({
      test: undefined,
      build: { succeeded: false, errorCount: 1, warningCount: 0 },
      lint: { succeeded: false, errorCount: 3, warningCount: 0 },
    }), 'the gate failed (build and lint legs)'],
    ['the test and e2e legs failed', redSummary({ e2e: { succeeded: false, failureNames: ['e2e one'] } }), 'the gate failed (test and e2e legs)'],
    ['overall is false but no leg records a failure', redSummary({ test: { succeeded: true, total: 3, failureNames: [] } }), 'the gate failed (no failing leg is recorded in the summary)'],
  ])('classify_redReasonNamesTheFailedLegs_%s', (_label, summary, reason) => {
    const signal = load().classify(summary, COMMIT_MS);

    expect(signal.state).toBe('red');
    expect(signal.reason).toBe(reason);
  });

  it('classify_redReasonNeverRepeatsTheSummaryHeaderText', () => {
    const signal = load().classify(redSummary({ mode: 'BUILD + TEST' }), COMMIT_MS);

    expect(signal.reason).not.toContain('BUILD');
  });
});

describe('gate-signal AC2: killed is never red', () => {
  it('readGateSignal_topLevelKilledOverallFalseNewerThanCommit_isKilledNotRed', () => {
    const root = makeRepo({
      summary: {
        timestamp: T_NEW, mode: 'TEST', overall: false, durationMs: 5,
        killed: 'SIGINT',
        build: { succeeded: true, errorCount: 0, warningCount: 0 },
      },
    });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('killed');
  });

  it('readGateSignal_killedRunStillCarryingFailureNames_isKilledNotRed', () => {
    const root = makeRepo({ summary: redSummary({ killed: 'SIGTERM' }) });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('killed');
  });

  it('readGateSignal_onlyALegCarriesKilledBy_isNeverRed', () => {
    const root = makeRepo({
      summary: redSummary({ build: { succeeded: false, errorCount: 0, warningCount: 0, killedBy: 'SIGTERM' } }),
    });

    const signal = load().readGateSignal(root);

    expect(signal.state).not.toBe('red');
    expect(signal.state).not.toBe('green');
  });
});

describe('gate-signal AC2: stale', () => {
  it('readGateSignal_passingSummaryOlderThanLastCommit_isStale', () => {
    const root = makeRepo({ summary: greenSummary({ timestamp: T_OLD }) });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('stale');
    expect(signal.ts).toBe(T_OLD);
  });

  it('readGateSignal_failingSummaryOlderThanLastCommit_isStaleNotRed', () => {
    const root = makeRepo({ summary: redSummary({ timestamp: T_OLD }) });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('stale');
  });
});

describe('gate-signal AC2: unknown', () => {
  it('readGateSignal_noSummaryFile_isUnknown', () => {
    const root = makeRepo();

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('unknown');
    expect(signal.ts).toBeNull();
  });

  it.each([
    ['truncated JSON', '{ "overall": tr'],
    ['empty file', ''],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
  ])('readGateSignal_corruptSummary_%s_isUnknown', (_label, raw) => {
    const root = makeRepo({ raw });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('unknown');
  });

  it.each([
    ['string "true"', 'true'],
    ['string "false"', 'false'],
    ['number 1', 1],
    ['null', null],
  ])('readGateSignal_overallIsNotBoolean_%s_isUnknown', (_label, overall) => {
    const root = makeRepo({ summary: greenSummary({ overall }) });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('unknown');
  });

  it('classify_nullSummary_isUnknown', () => {
    const signal = load().classify(null, COMMIT_MS);

    expect(signal.state).toBe('unknown');
    expect(signal.ts).toBeNull();
  });
});

describe('gate-signal AC2: green', () => {
  it('readGateSignal_overallTrueTestLegPassedNewerThanCommit_isGreen', () => {
    const root = makeRepo({ summary: greenSummary() });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('green');
    expect(signal.ts).toBe(T_NEW);
    expect(signal.failureNames).toEqual([]);
  });

  it('classify_passingSummaryExactlyAtLastCommitTime_isGreen', () => {
    const signal = load().classify(greenSummary({ timestamp: T_COMMIT }), COMMIT_MS);

    expect(signal.state).toBe('green');
  });
});

// Every negative input, driven through readGateSignal on a real summary file.
// `state: null` means the AC does not fix the state: only "never green" (and, where the
// run did pass or did not finish, "never red") is asserted.
describe('gate-signal AC2: negative inputs never yield green', () => {
  const negatives = [
    ['killed (top-level killed marker)', redSummary({ killed: 'SIGINT' }), 'killed'],
    ['killed while every leg looks passing', greenSummary({ killed: 'SIGTERM' }), 'killed'],
    ['stale (passing summary older than the last commit)', greenSummary({ timestamp: T_OLD }), 'stale'],
    ['in progress (gate runMarker: overall false + inProgress)', {
      timestamp: T_NEW, mode: 'TEST', overall: false, durationMs: 1, inProgress: true, pid: 4242,
    }, null],
    ['in progress even with overall true and a passed test leg', greenSummary({ inProgress: true, pid: 4242 }), null],
    ['build-only (overall true, no test leg)', {
      timestamp: T_NEW, mode: 'BUILD', stack: 'node', overall: true, durationMs: 1,
      build: { succeeded: true, errorCount: 0, warningCount: 0 },
    }, null],
    ['test leg present but not succeeded despite overall true', greenSummary({
      test: { succeeded: false, passed: 2, failed: 1, skipped: 0, total: 3, zeroCollected: false, timedOut: false, failureNames: ['x'] },
    }), null],
    ['test leg timed out', greenSummary({
      test: { succeeded: false, passed: 0, failed: 0, skipped: 0, total: 0, zeroCollected: false, timedOut: true, failureNames: [] },
    }), null],
  ];

  it.each(negatives)('readGateSignal_%s_neverGreen', (_label, summary, expectedState) => {
    const root = makeRepo({ summary });

    const signal = load().readGateSignal(root);

    expect(signal.state).not.toBe('green');
    if (expectedState) expect(signal.state).toBe(expectedState);
    else expect(signal.state).not.toBe('red');
  });

  it('readGateSignal_missingSummary_neverGreen', () => {
    const signal = load().readGateSignal(makeRepo());

    expect(signal.state).not.toBe('green');
    expect(signal.state).toBe('unknown');
  });

  it('readGateSignal_corruptSummary_neverGreen', () => {
    const signal = load().readGateSignal(makeRepo({ raw: '{"overall": true, "test": ' }));

    expect(signal.state).not.toBe('green');
    expect(signal.state).toBe('unknown');
  });

  it('classify_passingSummaryWithUnparseableTimestamp_isNeitherGreenNorRed', () => {
    const signal = load().classify(greenSummary({ timestamp: 'not-a-date' }), COMMIT_MS);

    expect(signal.state).not.toBe('green');
    expect(signal.state).not.toBe('red');
  });

  it('classify_failingSummaryWithUnparseableTimestamp_isNeitherGreenNorRed', () => {
    const signal = load().classify(redSummary({ timestamp: 'not-a-date' }), COMMIT_MS);

    expect(signal.state).not.toBe('green');
    expect(signal.state).not.toBe('red');
  });

  it('classify_passingSummaryWhenLastCommitTimeUnavailable_neverGreen', () => {
    const signal = load().classify(greenSummary(), null);

    expect(signal.state).not.toBe('green');
  });
});

// ── AC3: signature ───────────────────────────────────────────────────────────────────────────

describe('gate-signal AC3: signature dedupes the same failure', () => {
  const sigOf = (summary) => {
    const signal = load().classify(summary, COMMIT_MS);
    expect(signal.state).toBe('red');
    return signal.signature;
  };
  const failing = (failureNames, over = {}) => redSummary({
    test: {
      succeeded: false, passed: 0, failed: failureNames.length, skipped: 0, total: failureNames.length,
      zeroCollected: false, timedOut: false, failureNames,
    },
    ...over,
  });

  it('signature_redState_isNonEmptyHexHashNotTheRawNames', () => {
    const signature = sigOf(failing(['alpha-test', 'beta-test']));

    expect(signature).toMatch(/^[0-9a-f]{8,}$/);
    expect(signature).not.toContain('alpha');
  });

  it('signature_sameFailuresInDifferentOrder_isIdentical', () => {
    const one = sigOf(failing(['a test', 'b test', 'c test']));
    const two = sigOf(failing(['c test', 'a test', 'b test']));

    expect(two).toBe(one);
  });

  it('signature_sameFailureOnTwoReposAndTimes_isIdentical', () => {
    const rootOne = makeRepo({ summary: failing(['a test', 'b test'], { timestamp: T_NEW, durationMs: 100 }) });
    const rootTwo = makeRepo({ summary: failing(['b test', 'a test'], { timestamp: '2026-01-02T05:00:00.000Z', durationMs: 99999 }) });

    const one = load().readGateSignal(rootOne);
    const two = load().readGateSignal(rootTwo);

    expect(one.state).toBe('red');
    expect(two.state).toBe('red');
    expect(two.signature).toBe(one.signature);
  });

  it('signature_differentFailureNames_differ', () => {
    const one = sigOf(failing(['a test', 'b test']));
    const two = sigOf(failing(['a test', 'c test']));

    expect(two).not.toBe(one);
  });

  it('signature_oneFailureVersusTwo_differ', () => {
    const one = sigOf(failing(['a test']));
    const two = sigOf(failing(['a test', 'b test']));

    expect(two).not.toBe(one);
  });

  it('signature_namesThatJoinToTheSameString_differ', () => {
    const one = sigOf(failing(['ab', 'c']));
    const two = sigOf(failing(['a', 'bc']));

    expect(two).not.toBe(one);
  });

  it('signature_differentMode_differ', () => {
    const one = sigOf(failing(['a test'], { mode: 'TEST' }));
    const two = sigOf(failing(['a test'], { mode: 'BUILD + TEST' }));

    expect(two).not.toBe(one);
  });

  it('signature_buildFailedFlagFlips_differ', () => {
    const buildOk = sigOf(failing(['a test']));
    const buildFailed = sigOf(failing(['a test'], { build: { succeeded: false, errorCount: 1, warningCount: 0 } }));

    expect(buildFailed).not.toBe(buildOk);
  });

  it('signature_lintFailedFlagFlips_differ', () => {
    const lintOk = sigOf(failing(['a test']));
    const lintFailed = sigOf(failing(['a test'], { lint: { succeeded: false, errorCount: 3, warningCount: 0, skipped: false } }));

    expect(lintFailed).not.toBe(lintOk);
  });

  it('signature_buildErrorCountChangesButFlagDoesNot_isIdentical', () => {
    const one = sigOf(failing([], { build: { succeeded: false, errorCount: 1, warningCount: 0 }, test: undefined }));
    const two = sigOf(failing([], { build: { succeeded: false, errorCount: 7, warningCount: 4 }, test: undefined }));

    expect(two).toBe(one);
  });
});

// ── AC4: readSummary is not widened ──────────────────────────────────────────────────────────

describe('gate-signal AC4: readSummary validation is not widened', () => {
  const { readSummary } = require('../_lib/gate-summary');

  it.each([
    ['string "true"', 'true'],
    ['number 1', 1],
    ['null', null],
    ['missing', undefined],
  ])('readSummary_overallIs_%s_returnsNull', (_label, overall) => {
    const root = makeRepo({ summary: { ...greenSummary(), overall } });

    expect(readSummary(root)).toBeNull();
  });

  it('readSummary_overallIsBoolean_returnsTheParsedObject', () => {
    const root = makeRepo({ summary: greenSummary({ overall: false }) });

    const parsed = readSummary(root);

    expect(parsed).not.toBeNull();
    expect(parsed.overall).toBe(false);
  });

  it('readGateSignal_summaryReadSummaryRejects_staysUnknownNeverRescuedIntoAVerdict', () => {
    const root = makeRepo({ summary: { ...redSummary(), overall: 'false' } });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('unknown');
    expect(signal.failureNames).toEqual([]);
  });
});

// ── Review-fix regression tests (software-factory wave 1) ────────────────────────────────────

const receiptLib = require('../_lib/gate-receipt');

/** A receipt that `verifyReceiptForRoot` accepts for the repo as it is right now. */
function writeMatchingReceipt(root, over = {}) {
  const snapshot = receiptLib.treeSnapshot(root);
  if (!snapshot.ok) throw new Error(`fixture tree cannot be hashed: ${snapshot.reason}`);
  receiptLib.writeReceipt(root, {
    schema: receiptLib.RECEIPT_SCHEMA, status: 'passed', exitCode: 0, mode: 'full', changedOnly: false,
    treeHashStart: snapshot.hash, treeHashEnd: snapshot.hash, head: receiptLib.headSha(root),
    engine: receiptLib.engineIdentity(root), configHash: receiptLib.readGateConfigFile(root).hash,
    build: { status: 'passed' }, projects: [], ...over,
  });
}

describe('F6 green requires the receipt to match the tree (when the project keeps receipts)', () => {
  it('F6_greenSummaryWithAReceiptThatMatchesTheTree_isGreen', () => {
    const root = makeRepo({ summary: greenSummary() });
    writeMatchingReceipt(root);
    expect(receiptLib.verifyReceiptForRoot({ root }).ok).toBe(true);

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('green');
    expect(signal.reason).toContain('receipt matches the tree');
  });

  it('F6_aFileAddedAfterTheGreenGate_isStale', () => {
    const root = makeRepo({ summary: greenSummary() });
    writeMatchingReceipt(root);
    fs.writeFileSync(path.join(root, 'edited-after-the-gate.js'), 'module.exports = 1;\n');

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('stale');
    expect(signal.reason).toContain('treeHash');
  });

  it('F6_theGateConfigChangedAfterTheGreenGate_isStale', () => {
    const root = makeRepo({ summary: greenSummary() });
    writeMatchingReceipt(root, { configHash: 'not-the-current-config-hash' });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('stale');
    expect(signal.reason).toContain('config');
  });

  it('F6_aReceiptThatRecordsAFailedRun_isNeverGreen', () => {
    const root = makeRepo({ summary: greenSummary() });
    writeMatchingReceipt(root, { status: 'failed', exitCode: 1 });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('unknown');
  });

  it('F6_anUnreadableReceiptFile_isNeverGreen', () => {
    const root = makeRepo({ summary: greenSummary() });
    fs.mkdirSync(path.dirname(receiptLib.receiptPath(root)), { recursive: true });
    fs.writeFileSync(receiptLib.receiptPath(root), '{ not json');

    expect(load().readGateSignal(root).state).toBe('unknown');
  });

  it('F6_noReceiptAtAll_keepsTheFreshnessOnlyRuleAndSaysSo', () => {
    const root = makeRepo({ summary: greenSummary() });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('green');
    expect(signal.reason).toContain('does not use receipts');
  });

  it('F6_aMismatchingReceiptNeverTurnsARedGateGreenOrStale', () => {
    const root = makeRepo({ summary: redSummary() });
    writeMatchingReceipt(root, { configHash: 'not-the-current-config-hash' });

    expect(load().readGateSignal(root).state).toBe('red');
  });
});

describe('F7 a partial or zero-test run is never green', () => {
  const testLeg = (total, extra = {}) => ({ succeeded: true, passed: total, failed: 0, skipped: 0, total, zeroCollected: false, timedOut: false, failureNames: [], ...extra });
  const withoutTotal = (() => { const leg = testLeg(3); delete leg.total; return leg; })();

  it.each([
    ['a change-scoped run that found tests', { mode: 'TEST (changed only)', test: testLeg(2) }],
    ['a change-scoped run with zero tests (--passWithNoTests)', { mode: 'TEST (changed only)', test: testLeg(0) }],
    ['a whole-suite run whose test leg ran zero tests', { test: testLeg(0) }],
    ['a test leg without a total', { test: withoutTotal }],
  ])('F7_%s_isUnknownNotGreen', (_label, over) => {
    const root = makeRepo({ summary: greenSummary(over) });

    const signal = load().readGateSignal(root);

    expect(signal.state).toBe('unknown');
    expect(signal.reason.length).toBeGreaterThan(0);
  });

  it('F7_aFullRunWithTests_isStillGreen', () => {
    expect(load().classify(greenSummary(), COMMIT_MS).state).toBe('green');
  });
});

describe('F12 any leg timing out is killed; visual and E2E failures have their own signatures', () => {
  it.each([
    ['visual', { visual: { succeeded: false, passed: 0, failed: 0, total: 0, zeroCollected: false, skipped: false, timedOut: true, failureNames: [] } }],
    ['build', { build: { succeeded: false, errorCount: 0, warningCount: 0, timedOut: true } }],
    ['lint', { lint: { succeeded: false, errorCount: 0, warningCount: 0, skipped: false, timedOut: true } }],
    ['e2e', { e2e: { succeeded: false, passed: 0, failed: 0, skipped: 0, total: 0, timedOut: true } }],
  ])('F12_aTimedOut_%s_leg_isKilledNotRed', (_leg, over) => {
    const signal = load().classify(redSummary({ test: undefined, ...over }), COMMIT_MS);

    expect(signal.state).toBe('killed');
  });

  const sigOf = summary => {
    const signal = load().classify(summary, COMMIT_MS);
    expect(signal.state).toBe('red');
    return signal.signature;
  };
  const visualFailing = names => redSummary({
    visual: { succeeded: false, passed: 0, failed: names.length, total: names.length, zeroCollected: false, skipped: false, timedOut: false, failureNames: names },
  });

  it('F12_twoVisualFailuresWithDifferentNames_haveDifferentSignatures', () => {
    expect(sigOf(visualFailing(['snap a']))).not.toBe(sigOf(visualFailing(['snap b'])));
  });

  it('F12_theSameVisualFailuresInAnotherOrder_haveTheSameSignature', () => {
    expect(sigOf(visualFailing(['snap a', 'snap b']))).toBe(sigOf(visualFailing(['snap b', 'snap a'])));
  });

  it('F12_aVisualFailureAndNoVisualFailure_haveDifferentSignatures', () => {
    const plain = redSummary();
    expect(sigOf(visualFailing([]))).not.toBe(sigOf(plain));
  });

  it('F12_anE2eFailure_changesTheSignature', () => {
    const e2eFailed = redSummary({ e2e: { succeeded: false, passed: 0, failed: 1, skipped: 0, total: 1 } });
    expect(sigOf(e2eFailed)).not.toBe(sigOf(redSummary()));
  });

  it('F12_aSkippedVisualLegThatSucceeded_doesNotChangeTheSignature', () => {
    const skipped = redSummary({ visual: { succeeded: true, passed: 0, failed: 0, total: 0, skipped: true, timedOut: false, failureNames: [] } });
    expect(sigOf(skipped)).toBe(sigOf(redSummary()));
  });
});

describe('N3 the CLI flushes before exit and resolves its root like gate.js', () => {
  it('N3_aHugeFailureNamesList_isPrintedWholeAndParses', () => {
    const names = Array.from({ length: 200000 }, (_, i) => `failing test number ${i}`);
    const root = makeRepo({ summary: redSummary({ test: { succeeded: false, passed: 0, failed: names.length, skipped: 0, total: names.length, zeroCollected: false, timedOut: false, failureNames: names } }) });

    const res = spawnSync(process.execPath, [SCRIPT], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });

    expect(res.status).toBe(0);
    const signal = JSON.parse(res.stdout);
    expect(signal.state).toBe('red');
    expect(signal.failureNames).toHaveLength(200000);
  });

  it('N3_theCliSource_endsWithExitCodeNotExit', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    const cli = source.slice(source.indexOf('if (require.main === module)'));
    expect(cli).toContain('process.exitCode = 0');
    expect(cli).not.toMatch(/process\.exit\(/);
  });

  it('N3_claudeProjectDirWinsOverTheWorkingDirectory', () => {
    const root = makeRepo({ summary: redSummary() });
    const elsewhere = createTmpDir({ prefix: 'gate-signal-cwd-' });
    tmps.push(elsewhere);

    const res = spawnSync(process.execPath, [SCRIPT], { cwd: elsewhere.root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

    expect(JSON.parse(res.stdout).ts).toBe(T_NEW);
  });

  it('N3_withNoProjectDirEnv_theRootIsTheScriptsCheckoutNotTheWorkingDirectory', () => {
    const cwdRepo = makeRepo({ summary: redSummary() });
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;

    const res = spawnSync(process.execPath, [SCRIPT], { cwd: cwdRepo, encoding: 'utf8', windowsHide: true, env });

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).ts).not.toBe(T_NEW);
  });
});

// ── SF-3.5: the `--only-if-red` and `--mark-seen` CLI modes ──────────────────────────────────
//
// PINNED CLI CONTRACT (SF-3.5):
//
//   node gate-signal.js                     unchanged: the Signal JSON, exit 0 always.
//   node gate-signal.js --only-if-red       read-only. Exit 0 always. Prints the Signal JSON (exactly the
//                                           five seam keys, no `quiet` key) ONLY when state is `red` AND its
//                                           signature differs from the one in listen-gate-seen.json.
//                                           Anything else prints `{quiet: true, state, signature, reason}`.
//   node gate-signal.js --mark-seen <sig>   writes `{signature, markedAt}` to listen-gate-seen.json
//                                           (regular file only, no symlink follow, temp file + rename).
//                                           <sig> must be 16 lowercase hex characters. Exit 0 and prints
//                                           `{marked: true, signature, changed}` (`changed` false when the file
//                                           already held that signature: idempotent, bytes untouched).
//                                           Exit 2 and prints `{marked: false, error}` for a bad signature or a
//                                           refused path (symlink, directory, symlinked ancestor).
//
// A corrupt, oversized, symlinked or non-regular seen file reads as "nothing seen", so a red gate is
// reported again rather than hidden.

const SEEN_REL = path.join('docs', '.output', '.state', 'telemetry', 'listen-gate-seen.json');
const SIG_RE = /^[0-9a-f]{16}$/;

function runCliArgs(cwd, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
}

const seenFile = root => path.join(root, SEEN_REL);
const redSignature = root => JSON.parse(runCliArgs(root, []).stdout).signature;

function seedSeen(root, content) {
  const file = seenFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const canSymlinkHere = (() => {
  const probe = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gate-signal-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probe, 't'), 'x');
    fs.symlinkSync(path.join(probe, 't'), path.join(probe, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

describe('SF-3.5 --only-if-red: the red-and-unseen gate is the only thing it prints in full', () => {
  it('onlyIfRed_redAndNothingSeen_printsTheSignalExactlyAndExitsZero', () => {
    const root = makeRepo({ summary: redSummary() });
    const plain = JSON.parse(runCliArgs(root, []).stdout);

    const res = runCliArgs(root, ['--only-if-red']);

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out).toEqual(plain);
    expect(Object.keys(out).sort()).toEqual(['failureNames', 'reason', 'signature', 'state', 'ts']);
    expect(out.state).toBe('red');
    expect(out.signature).toMatch(SIG_RE);
  });

  it('onlyIfRed_isReadOnly_itNeverCreatesTheSeenFile', () => {
    const root = makeRepo({ summary: redSummary() });

    runCliArgs(root, ['--only-if-red']);

    expect(fs.existsSync(seenFile(root))).toBe(false);
  });

  it('onlyIfRed_redAndTheSignatureIsTheSeenOne_isQuiet', () => {
    const root = makeRepo({ summary: redSummary() });
    const sig = redSignature(root);
    seedSeen(root, JSON.stringify({ signature: sig, markedAt: T_NEW }));

    const res = runCliArgs(root, ['--only-if-red']);

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.quiet).toBe(true);
    expect(out.state).toBe('red');
    expect(out.signature).toBe(sig);
    expect(Object.keys(out).sort()).toEqual(['quiet', 'reason', 'signature', 'state']);
    expect(out.reason).toMatch(/already (recorded|seen)/i);
  });

  it('onlyIfRed_redWithADifferentSeenSignature_printsTheSignal', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, JSON.stringify({ signature: '0123456789abcdef', markedAt: T_NEW }));

    const out = JSON.parse(runCliArgs(root, ['--only-if-red']).stdout);

    expect(out.quiet).toBeUndefined();
    expect(out.state).toBe('red');
  });

  it('onlyIfRed_aDifferentFailureAfterTheSeenOne_printsTheSignalAgain', () => {
    const rootA = makeRepo({ summary: redSummary() });
    const sigA = redSignature(rootA);
    const rootB = makeRepo({ summary: redSummary({ test: { succeeded: false, passed: 0, failed: 1, skipped: 0, total: 1, zeroCollected: false, timedOut: false, failureNames: ['c test'] } }) });
    seedSeen(rootB, JSON.stringify({ signature: sigA, markedAt: T_NEW }));

    const out = JSON.parse(runCliArgs(rootB, ['--only-if-red']).stdout);

    expect(out.quiet).toBeUndefined();
    expect(out.signature).not.toBe(sigA);
  });

  it.each([
    ['green', () => makeRepo({ summary: greenSummary() }), 'green'],
    ['stale', () => makeRepo({ summary: redSummary({ timestamp: T_OLD }) }), 'stale'],
    ['killed', () => makeRepo({ summary: redSummary({ killed: 'user' }) }), 'killed'],
    ['unknown (no summary)', () => makeRepo(), 'unknown'],
    ['unknown (corrupt summary)', () => makeRepo({ raw: '{not json' }), 'unknown'],
  ])('onlyIfRed_%s_isQuietWithTheRealStateAndNoSeenFileWritten', (_label, build, state) => {
    const root = build();

    const res = runCliArgs(root, ['--only-if-red']);

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.quiet).toBe(true);
    expect(out.state).toBe(state);
    expect(typeof out.reason).toBe('string');
    expect(out.reason.length).toBeGreaterThan(0);
    expect(fs.existsSync(seenFile(root))).toBe(false);
  });

  it('onlyIfRed_aNonGitRoot_isQuietUnknownAndExitsZero', () => {
    const tmp = createTmpDir({ prefix: 'gate-signal-nogit-' });
    tmps.push(tmp);

    const res = runCliArgs(tmp.root, ['--only-if-red']);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ quiet: true, state: 'unknown' });
  });

  it('plainRun_withASeenFilePresent_isUnchangedAndStillExitsZero', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, JSON.stringify({ signature: redSignature(root), markedAt: T_NEW }));

    const res = runCliArgs(root, []);

    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.quiet).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['failureNames', 'reason', 'signature', 'state', 'ts']);
  });
});

describe('SF-3.5 --only-if-red: a damaged seen file never hides a red gate', () => {
  it.each([
    ['garbage', 'not json at all'],
    ['an array', '[]'],
    ['a signature that is not a string', JSON.stringify({ signature: 42 })],
    ['an empty file', ''],
    ['more than 64 KiB', JSON.stringify({ signature: 'x', pad: 'y'.repeat(70 * 1024) })],
  ])('onlyIfRed_seenFileIs_%s_readsAsNothingSeen', (_label, content) => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, content);

    const res = runCliArgs(root, ['--only-if-red']);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).quiet).toBeUndefined();
  });

  it('onlyIfRed_seenFileIsADirectory_readsAsNothingSeen', () => {
    const root = makeRepo({ summary: redSummary() });
    fs.mkdirSync(seenFile(root), { recursive: true });

    const res = runCliArgs(root, ['--only-if-red']);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).quiet).toBeUndefined();
  });

  it.skipIf(!canSymlinkHere)('onlyIfRed_seenFileIsASymlinkHoldingTheMatchingSignature_isNotFollowed', () => {
    const root = makeRepo({ summary: redSummary() });
    const sig = redSignature(root);
    const outside = path.join(root, 'outside-seen.json');
    fs.writeFileSync(outside, JSON.stringify({ signature: sig, markedAt: T_NEW }));
    fs.mkdirSync(path.dirname(seenFile(root)), { recursive: true });
    fs.symlinkSync(outside, seenFile(root));

    const res = runCliArgs(root, ['--only-if-red']);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).quiet).toBeUndefined();
  });
});

describe('SF-3.5 --mark-seen: an atomic, regular-file-only write', () => {
  it('markSeen_aValidSignature_writesTheSeenFileAndThenOnlyIfRedIsQuiet', () => {
    const root = makeRepo({ summary: redSummary() });
    const sig = redSignature(root);

    const res = runCliArgs(root, ['--mark-seen', sig]);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ marked: true, signature: sig, changed: true });
    const stored = JSON.parse(fs.readFileSync(seenFile(root), 'utf8'));
    expect(stored.signature).toBe(sig);
    expect(typeof stored.markedAt).toBe('string');
    expect(Number.isNaN(Date.parse(stored.markedAt))).toBe(false);
    expect(JSON.parse(runCliArgs(root, ['--only-if-red']).stdout).quiet).toBe(true);
  });

  it('markSeen_createsTheTelemetryFolderWhenItIsMissing', () => {
    const tmp = createTmpDir({ prefix: 'gate-signal-mark-' });
    tmps.push(tmp);

    const res = runCliArgs(tmp.root, ['--mark-seen', 'abcdef0123456789']);

    expect(res.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(seenFile(tmp.root), 'utf8')).signature).toBe('abcdef0123456789');
  });

  it('markSeen_theSameSignatureTwice_isIdempotentAndLeavesTheBytesUntouched', () => {
    const root = makeRepo({ summary: redSummary() });
    runCliArgs(root, ['--mark-seen', 'abcdef0123456789']);
    const before = fs.readFileSync(seenFile(root), 'utf8');

    const res = runCliArgs(root, ['--mark-seen', 'abcdef0123456789']);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ marked: true, signature: 'abcdef0123456789', changed: false });
    expect(fs.readFileSync(seenFile(root), 'utf8')).toBe(before);
  });

  it('markSeen_aDifferentSignature_replacesTheOldOne', () => {
    const root = makeRepo({ summary: redSummary() });
    runCliArgs(root, ['--mark-seen', 'abcdef0123456789']);

    const res = runCliArgs(root, ['--mark-seen', '0123456789abcdef']);

    expect(JSON.parse(res.stdout)).toEqual({ marked: true, signature: '0123456789abcdef', changed: true });
    expect(JSON.parse(fs.readFileSync(seenFile(root), 'utf8')).signature).toBe('0123456789abcdef');
  });

  it('markSeen_leavesNoTempFileBehind', () => {
    const root = makeRepo({ summary: redSummary() });

    runCliArgs(root, ['--mark-seen', 'abcdef0123456789']);
    runCliArgs(root, ['--mark-seen', '0123456789abcdef']);

    const names = fs.readdirSync(path.dirname(seenFile(root))).sort();
    expect(names).toEqual(['_latest-summary.json', 'listen-gate-seen.json']);
  });

  it('markSeen_overACorruptRegularFile_replacesItWithValidJson', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, '{{{ corrupt');

    const res = runCliArgs(root, ['--mark-seen', 'abcdef0123456789']);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(seenFile(root), 'utf8')).signature).toBe('abcdef0123456789');
  });

  it.each([
    ['no argument', []],
    ['an empty string', ['']],
    ['uppercase hex', ['ABCDEF0123456789']],
    ['too short', ['abcdef']],
    ['too long', ['abcdef01234567890']],
    ['a path traversal', ['../../etc/passwd']],
    ['non-hex letters', ['ghijklmnopqrstuv']],
    ['another flag in its place', ['--only-if-red']],
  ])('markSeen_withInvalidSignature_%s_exitsTwoAndWritesNothing', (_label, extra) => {
    const root = makeRepo({ summary: redSummary() });

    const res = runCliArgs(root, ['--mark-seen', ...extra]);

    expect(res.status).toBe(2);
    const out = JSON.parse(res.stdout);
    expect(out.marked).toBe(false);
    expect(typeof out.error).toBe('string');
    expect(fs.existsSync(seenFile(root))).toBe(false);
  });

  it('markSeen_seenPathIsADirectory_exitsTwoAndLeavesItAlone', () => {
    const root = makeRepo({ summary: redSummary() });
    fs.mkdirSync(seenFile(root), { recursive: true });

    const res = runCliArgs(root, ['--mark-seen', 'abcdef0123456789']);

    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout).marked).toBe(false);
    expect(fs.statSync(seenFile(root)).isDirectory()).toBe(true);
  });

  it.skipIf(!canSymlinkHere)('markSeen_seenPathIsASymlink_exitsTwoAndNeverWritesThroughIt', () => {
    const root = makeRepo({ summary: redSummary() });
    const victim = path.join(root, 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    fs.mkdirSync(path.dirname(seenFile(root)), { recursive: true });
    fs.symlinkSync(victim, seenFile(root));

    const res = runCliArgs(root, ['--mark-seen', 'abcdef0123456789']);

    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout).marked).toBe(false);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
    expect(fs.lstatSync(seenFile(root)).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!canSymlinkHere)('markSeen_theTelemetryFolderIsASymlink_exitsTwoAndWritesNothingOutside', () => {
    const tmp = createTmpDir({ prefix: 'gate-signal-anc-' });
    tmps.push(tmp);
    const outside = createTmpDir({ prefix: 'gate-signal-outside-' });
    tmps.push(outside);
    const stateDir = path.join(tmp.root, 'docs', '.output', '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.symlinkSync(outside.root, path.join(stateDir, 'telemetry'), process.platform === 'win32' ? 'junction' : 'dir');

    const res = runCliArgs(tmp.root, ['--mark-seen', 'abcdef0123456789']);

    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout).marked).toBe(false);
    expect(fs.readdirSync(outside.root)).toEqual([]);
  });

  it('markSeen_theSource_writesATempFileThenRenamesAndRefusesAnythingButARegularFile', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');

    expect(source).toContain('renameSync');
    expect(source).toContain('O_EXCL');
    expect(source).toContain('O_NOFOLLOW');
    expect(source).toContain('assertNoSymlinkedAncestor');
    expect(source).toContain('lstatSync');
  });
});

// ── M3: a seen mark expires when the gate has passed since it was written ─────────────────────

const LEDGER_REL = path.join('docs', '.output', '.state', 'telemetry', 'gate-failures.jsonl');
const T_AFTER_MARK = '2026-01-01T02:00:00.000Z'; // an hour after the seeded markedAt (T_NEW)
const T_BEFORE_MARK = '2026-01-01T00:30:00.000Z';

function appendLedger(root, rows) {
  const file = path.join(root, LEDGER_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
const passRow = (ts, over = {}) => ({ ts, head: 'abc+def', sig: null, legs: ['build', 'test'], passed: true, killed: null, ...over });
const onlyIfRedOut = root => JSON.parse(runCliArgs(root, ['--only-if-red']).stdout);

describe('M3 --only-if-red re-reports the same red that comes back after a green', () => {
  it('onlyIfRed_markedThenAPassingRowThenTheSameRed_printsTheSignalInFull', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, JSON.stringify({ signature: redSignature(root), markedAt: T_NEW }));
    expect(onlyIfRedOut(root).quiet).toBe(true); // the mark holds before any green

    appendLedger(root, [passRow(T_AFTER_MARK)]);
    const out = onlyIfRedOut(root);

    expect(out.quiet).toBeUndefined();
    expect(out.state).toBe('red');
    expect(Object.keys(out).sort()).toEqual(['failureNames', 'reason', 'signature', 'state', 'ts']);
  });

  it('onlyIfRed_endToEndWithTheRealMarkSeen_aLaterPassingRowReArmsTheReport', () => {
    const root = makeRepo({ summary: redSummary() });
    const sig = redSignature(root);
    runCliArgs(root, ['--mark-seen', sig]);
    expect(onlyIfRedOut(root).quiet).toBe(true);

    appendLedger(root, [passRow(new Date(Date.now() + 60 * 1000).toISOString())]);

    expect(onlyIfRedOut(root).quiet).toBeUndefined();
  });

  it('onlyIfRed_aPassingRowOlderThanTheMark_staysQuiet', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, JSON.stringify({ signature: redSignature(root), markedAt: T_NEW }));
    appendLedger(root, [passRow(T_BEFORE_MARK)]);

    expect(onlyIfRedOut(root).quiet).toBe(true);
  });

  it('onlyIfRed_aFailureRowOrAKilledRowAfterTheMark_staysQuiet', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, JSON.stringify({ signature: redSignature(root), markedAt: T_NEW }));
    appendLedger(root, [
      { ts: T_AFTER_MARK, head: 'x', sig: 'f'.repeat(64), legs: ['test'], passed: false, killed: null },
      { ts: T_AFTER_MARK, head: 'x', sig: null, legs: ['test'], passed: false, killed: 'TIMEOUT' },
      passRow(T_AFTER_MARK, { killed: 'SIGTERM' }),
    ]);

    expect(onlyIfRedOut(root).quiet).toBe(true);
  });

  it('onlyIfRed_aPassRowWithAnUnparseableTimestamp_neverExpiresTheMark', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, JSON.stringify({ signature: redSignature(root), markedAt: T_NEW }));
    appendLedger(root, [passRow('not a date')]);

    expect(onlyIfRedOut(root).quiet).toBe(true);
  });

  it('onlyIfRed_aCorruptLedger_leavesTheMarkLive', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, JSON.stringify({ signature: redSignature(root), markedAt: T_NEW }));
    const file = path.join(root, LEDGER_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{{{ not jsonl\n');

    expect(onlyIfRedOut(root).quiet).toBe(true);
  });

  it.each([
    ['no markedAt', JSON.stringify({ signature: 'PLACEHOLDER' })],
    ['an unparseable markedAt', JSON.stringify({ signature: 'PLACEHOLDER', markedAt: 'yesterday-ish' })],
    ['a non-string markedAt', JSON.stringify({ signature: 'PLACEHOLDER', markedAt: 12345 })],
  ])('onlyIfRed_aMatchingSignatureWith_%s_isNotTrustedAndReportsAgain', (_label, template) => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, template.replace('PLACEHOLDER', redSignature(root)));

    expect(onlyIfRedOut(root).quiet).toBeUndefined();
  });

  it('onlyIfRed_isStillReadOnlyWhenTheMarkExpired_theSeenFileBytesAreUntouched', () => {
    const root = makeRepo({ summary: redSummary() });
    seedSeen(root, JSON.stringify({ signature: redSignature(root), markedAt: T_NEW }));
    appendLedger(root, [passRow(T_AFTER_MARK)]);
    const before = fs.readFileSync(seenFile(root), 'utf8');
    const ledgerBefore = fs.readFileSync(path.join(root, LEDGER_REL), 'utf8');

    expect(onlyIfRedOut(root).quiet).toBeUndefined();

    expect(fs.readFileSync(seenFile(root), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(root, LEDGER_REL), 'utf8')).toBe(ledgerBefore);
  });

  it('markSeen_aSignatureWhoseMarkExpired_isRewrittenWithAFreshMarkedAtAndGoesQuietAgain', () => {
    const root = makeRepo({ summary: redSummary() });
    const sig = redSignature(root);
    seedSeen(root, JSON.stringify({ signature: sig, markedAt: T_NEW }));
    appendLedger(root, [passRow(T_AFTER_MARK)]);
    expect(onlyIfRedOut(root).quiet).toBeUndefined();

    const res = JSON.parse(runCliArgs(root, ['--mark-seen', sig]).stdout);

    expect(res).toEqual({ marked: true, signature: sig, changed: true });
    expect(Date.parse(JSON.parse(fs.readFileSync(seenFile(root), 'utf8')).markedAt)).toBeGreaterThan(Date.parse(T_AFTER_MARK));
    expect(onlyIfRedOut(root).quiet).toBe(true); // no re-report loop: the same pass row is now older than the mark
  });

  it('markSeen_aLiveMarkForTheSameSignature_isStillAnIdempotentNoOp', () => {
    const root = makeRepo({ summary: redSummary() });
    runCliArgs(root, ['--mark-seen', 'abcdef0123456789']);
    appendLedger(root, [passRow(T_BEFORE_MARK)]); // older than the real markedAt (now)
    const before = fs.readFileSync(seenFile(root), 'utf8');

    const res = JSON.parse(runCliArgs(root, ['--mark-seen', 'abcdef0123456789']).stdout);

    expect(res.changed).toBe(false);
    expect(fs.readFileSync(seenFile(root), 'utf8')).toBe(before);
  });
});

// ── SF-3.5 wiring: the listen workflow strings the acceptance criteria name ──────────────────

const LISTEN_WORKFLOW = path.resolve(CORE_DIR, '..', 'skills', 'listen', 'references', 'workflow.md');
const listenSource = () => fs.readFileSync(LISTEN_WORKFLOW, 'utf8');
/** Text of the `## ` / `### ` section whose heading line starts with `heading`, up to the next heading of the same or higher level. */
function sectionOf(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.startsWith(heading));
  if (start === -1) return '';
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  let inFence = false; // a `# ` line inside a fenced example is not a heading
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('```')) { inFence = !inFence; continue; }
    const m = !inFence && lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

describe('SF-3.5 wiring: /listen gate source, flags, and the /loop recipe', () => {
  it('scope_theSourceListNamesGate', () => {
    const scope = sectionOf(listenSource(), '## Variables');

    expect(scope).toMatch(/A source name \(([^)]*)\)/);
    const names = scope.match(/A source name \(([^)]*)\)/)[1].split(',').map(s => s.trim());
    expect(names).toEqual(['`git`', '`telemetry`', '`agent-updates`', '`backlog`', '`external`', '`gate`']);
  });

  it('scope_bothFlagsAreDocumented', () => {
    const scope = sectionOf(listenSource(), '## Variables');

    expect(scope).toContain('`--only-if-red`');
    expect(scope).toContain('`--no-commit`');
  });

  it('gateSource_readsGateSignalJsAndTagsTheOrigin', () => {
    const sweep = sectionOf(listenSource(), '### Step 2');

    expect(sweep).toContain('node .claude/core/gate-signal.js');
    expect(sweep).toContain('[origin: gate]');
    expect(sweep).toContain('2f. `gate`');
  });

  it('gateSource_onlyARedStateIsASignal_otherStatesAreNeverReportedAsFailures', () => {
    const gate = listenSource().slice(listenSource().indexOf('**2f. `gate`'));

    expect(gate).toMatch(/`red`/);
    expect(gate).toMatch(/`killed`/);
    expect(gate).toMatch(/`stale`/);
    expect(gate).toMatch(/`unknown`/);
    expect(gate).toMatch(/_No new signals\._/);
  });

  it('onlyIfRed_runsTheMechanicalCheckAndStopsSilentlyOnTheQuietKey', () => {
    const text = listenSource();

    expect(text).toContain('node .claude/core/gate-signal.js --only-if-red');
    expect(text).toContain('"quiet": true');
    expect(text).toContain('docs/.output/.state/telemetry/listen-gate-seen.json');
    expect(text).toMatch(/writes nothing/i);
    expect(text).toMatch(/no intake file/i);
  });

  it('seenState_isMarkedThroughTheCliAfterTheIntakeFileIsWritten', () => {
    const step3 = sectionOf(listenSource(), '### Step 3');

    expect(step3).toContain('node .claude/core/gate-signal.js --mark-seen');
    expect(step3.indexOf('MUST write')).toBeLessThan(step3.indexOf('--mark-seen'));
  });

  it('noCommit_step4SkipsTheCommit', () => {
    const step4 = sectionOf(listenSource(), '### Step 4');

    expect(step4).toContain('`--no-commit`');
    expect(step4).toMatch(/skip/i);
  });

  it('sameDayRerun_withNoChange_appendsNoDuplicateRunSection', () => {
    const step3 = sectionOf(listenSource(), '### Step 3');

    expect(step3).toMatch(/same-day rerun/i);
    expect(step3).toContain('appends no `## Run` section');
    expect(step3).toContain('`signature:');
  });

  it('output_isLimitedToTheIntakeFileAndTheSeenStateFile', () => {
    const text = listenSource();

    expect(text).toContain('writes only the intake file and `docs/.output/.state/telemetry/listen-gate-seen.json`');
  });

  it('antiPattern_theQuietExitIsTheOneExceptionToOmittingAnEmptySection', () => {
    const bullet = listenSource().split('\n').find(line => line.includes('**Omitting an empty section.**'));

    expect(bullet).toBeTruthy();
    expect(bullet).toContain('`--only-if-red`');
    expect(bullet).toMatch(/one exception/i);
  });

  it('loopRecipe_hasItsOwnSectionWithTheFlagsAsTheStatefulPart', () => {
    const loop = sectionOf(listenSource(), '## Repeated runs via `/loop`');

    expect(loop).not.toBe('');
    expect(loop).toContain('/loop 1h /listen gate --only-if-red --no-commit');
    expect(loop).toMatch(/flags carry the state/i);
    expect(loop).toContain('listen-gate-seen.json');
  });

  it('loopRecipe_hasNoInternalPollLoop_isSessionScopedAndExpiresAfterSevenDays', () => {
    const loop = sectionOf(listenSource(), '## Repeated runs via `/loop`');

    expect(loop).toMatch(/no internal poll loop/i);
    expect(loop).toMatch(/session-scoped/i);
    expect(loop).toContain('7 days');
  });

  it('loopRecipe_pointsDurableSchedulingAtTheScheduledRunsGuide', () => {
    const loop = sectionOf(listenSource(), '## Repeated runs via `/loop`');

    expect(loop).toContain('docs/reference/agents/guides/scheduled-runs.md');
  });
});

describe('m1 /listen: suppressed red marks seen, quiet polls leave no self-log row', () => {
  const telemetry = () => sectionOf(listenSource(), '## Telemetry (run first)');
  const step0 = () => sectionOf(listenSource(), '### Step 0');
  const markParagraph = () => {
    const step3 = sectionOf(listenSource(), '### Step 3');
    return step3.slice(step3.indexOf('**Mark the gate signature seen.**'));
  };

  it('telemetry_underOnlyIfRed_selfLogsOnlyWhenStep0DoesNotExitQuiet', () => {
    const t = telemetry();

    expect(t).toContain('node .claude/core/telemetry-log.js listen');
    expect(t).toContain('`--only-if-red`');
    expect(t).toMatch(/self-log only when Step 0 does not exit quiet/);
  });

  it('step0_theQuietExitWritesNoSelfLogRowAndTheRedPathSelfLogsBeforeContinuing', () => {
    const s = step0();

    expect(s).toMatch(/no telemetry self-log row/);
    expect(s).toMatch(/Self-log the invocation now/);
    expect(s).not.toMatch(/the telemetry self-log row aside/);
  });

  it('step0_aSuppressedGateBulletIsStillMarkedSeen', () => {
    expect(step0()).toMatch(/suppresses the gate bullet[^\n]*still marked seen in Step 3/);
  });

  it('step3_marksSeenForAWrittenAlreadyPresentOrSuppressedRedBullet', () => {
    const p = markParagraph();

    expect(p).toContain('node .claude/core/gate-signal.js --mark-seen');
    expect(p).toMatch(/wrote the bullet/);
    expect(p).toMatch(/already in today's file/);
    expect(p).toMatch(/Step 1b suppressed it/);
    expect(p).not.toMatch(/a run that wrote nothing new for the gate does not/);
  });

  it('output_theOutputStatementCarvesOutTheQuietExitFromTheSelfLogRow', () => {
    const line = listenSource().split('\n').find(l => l.startsWith('A run writes only the intake file')) || '';

    expect(line).toContain('quiet `--only-if-red` exit does not write');
  });
});

describe('M3 /listen docs: the seen mark expires on a later pass', () => {
  it('step0_andTheLoopRecipeStateThatAPassExpiresTheMark', () => {
    const text = listenSource();

    expect(sectionOf(text, '### Step 0')).toMatch(/no passing gate run has been recorded since/);
    expect(sectionOf(text, '## Repeated runs via `/loop`')).toMatch(/passing gate run is recorded, after which the same failure coming back is reported again/);
    expect(text).not.toContain('until the failure changes or the gate goes green and fails differently');
  });
});

describe('n1 /listen discoverability: the generated command metadata names the gate source and both flags', () => {
  it('workflowMetadata_listenEntryNamesGateOnlyIfRedAndNoCommit', () => {
    const meta = JSON.parse(fs.readFileSync(path.resolve(CORE_DIR, '..', 'adapters', 'claude', 'workflow-metadata.json'), 'utf8'));

    expect(meta.listen).toContain('gate');
    expect(meta.listen).toContain('--only-if-red');
    expect(meta.listen).toContain('--no-commit');
  });

  it('startupReference_theListenCatalogLineNamesTheGateSourceAndBothFlags', () => {
    const line = fs.readFileSync(path.resolve(CORE_DIR, '..', 'startup-reference.md'), 'utf8').split('\n').find(l => l.startsWith('- `/listen`')) || '';

    expect(line).toContain('gate result');
    expect(line).toContain('--only-if-red');
    expect(line).toContain('--no-commit');
  });
});
