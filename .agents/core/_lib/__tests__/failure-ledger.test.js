// Tests for failure-ledger.js — SF-1.5: failure ledger, budget parser, gate recording.
//
// PINNED CONTRACT (these tests are the interface; the implementation must match them)
// ----------------------------------------------------------------------------------
// Module `.agents/core/_lib/failure-ledger.js` (zero-dependency CommonJS; also a CLI).
//
// Exports
//   getLedgerPath(root) -> string
//       <root>/docs/.output/.state/telemetry/gate-failures.jsonl
//   signature({ ids, detail, mode, root }) -> string
//       sha256 hex (64 chars) over the SORTED, de-duplicated, normalized ids plus the normalized
//       detail. Normalization strips ANSI, makes paths under `root` root-relative, and removes
//       durations, timestamps, hex ids / uuids and line:col. Plain numbers survive. An EMPTY ids
//       array returns `empty:<mode>` whatever the detail says.
//   extractFailures(text, { root }) -> { ids: string[], assertions: [{ id, expected, saw, file, line }],
//                                         firstError: string|null }
//       Reads runner output text. vitest: ` FAIL  <id>` lines (de-duplicated, in order),
//       `AssertionError: expected <saw> to be <expected>` and `... to deeply equal <expected>`,
//       and the first `❯ <file>:<line>:<col>` after the FAIL line (file root-relative, line a number).
//       pytest: `FAILED <id> - <msg>` lines. dotnet: `Failed <id> [<time>]` lines.
//       firstError: the first pytest `E   <msg>` line (message trimmed), otherwise the first line
//       matching /\b(Error|Exception)\b/ (trimmed), otherwise null.
//   currentHead(root) -> string|null
//       Opaque working-tree identity: null when root is not a git work tree. In a git work tree it
//       changes with HEAD, a tracked edit or an untracked file, and is IGNORANT of
//       `docs/.output/.state/` (writing the ledger itself must not change it).
//   appendFailure(row, { root }) -> row|null
//       Appends one JSONL row through jsonl-writer.appendJsonl with tail-rotation 2000 -> 1500.
//       Row keys, always exactly: ts (ISO, filled when absent), head (string|null), sig (string|null),
//       legs (string[]), passed (boolean, default false), killed (string|null, default null).
//       Optional keys, present only when given: `cls` ('environment') and `log` (string).
//       Never throws; returns null when the write fails.
//   readLedger({ root }) -> row[]      file order; missing file -> []; corrupt lines skipped.
//   classify(rows) -> { class, sig, count }
//       Looks at the newest row that is not killed.
//         none         no rows (sig null, count 0)
//         pass         newest is a pass row (sig null, count 0)
//         environment  newest has cls 'environment' (count 0)
//         flaky        newest failure's head (non-null) also has a PASS row anywhere earlier (count 0)
//         noop         newest failure has the same sig AND the same non-null head as the row just
//                      before it in the counted run (count is NOT incremented by it)
//         genuine      anything else (count >= 1)
//       count = consecutive trailing failure rows with the newest row's sig, counting a row only
//       when its head differs from the head of the next-newer counted row (a null head is unknown
//       and always counts). A pass row, or a different sig, ends the run. Killed rows and
//       environment rows are skipped (neutral), they neither count nor end the run.
//   streak(rows) -> number              classify(rows).count
//   recordGateRun({ root, mode, legs, passed, killed, timedOut, ids, detail, log, head })
//       -> { recorded, row, sig, class, count }
//       Never throws (garbage input or an unwritable directory give a result object; an unwritable
//       directory gives recorded:false). A missing root defaults to the ambient project root.
//       passed        -> appends a pass row (passed true, sig null, killed null, legs as given or []).
//       killed or timedOut -> appends a failure row with killed = the signal name, or 'TIMEOUT'
//                        for a timeout; result class 'neutral', count unchanged.
//       otherwise     -> appends a failure row; sig = signature({ ids, detail, mode, root }) where mode
//                        defaults to legs.join('+'); a detail containing ECONNREFUSED, EADDRINUSE,
//                        ENOSPC, ENOMEM or "heap out of memory" sets cls 'environment'.
//       head defaults to currentHead(root). The result class/count come from classify(readLedger()).
//   lastPrompt({ root }) -> string
//       Text for the newest non-killed FAILURE row. First line:
//         `failure signature <sig.slice(0,12)> seen <N> times in a row`
//       Then, when the row's `log` file is readable and holds vitest output, one line per assertion:
//         `expected <expected> | saw <saw> | <file>:<line>`
//       Otherwise (non-vitest output) the failing ids, the first error line and the log path, and NO
//       `expected ... | saw ...` line. No failure rows -> a string containing `no failure recorded`.
//   parseBudget(line) -> { [key]: number }
//       Keys attempts, gate-failures, dispatches, minutes; separated by spaces and/or commas; optional
//       `**Budget:**` prefix (and a leading `- `). Only the given keys are returned. Throws on an
//       unknown key (message names the key), a non-integer or negative value, or no pairs at all.
//   budget({ root, since, limits, now }) -> { used, limits, exceeded: string[], ok }
//       since = `YYMMDD-HHMM` (local time); limits = parseBudget output; now = Date (default new Date()).
//       used['gate-failures'] = failure rows since `since` that are not killed (any class);
//       used.dispatches = readAttribution entries since `since` (all days from since to now);
//       used.attempts = the largest per-story_id dispatch count since `since` (null story_id ignored);
//       used.minutes = floor((now - since) / 60000). A key is exceeded when used > limit (strict);
//       a key with no limit is never exceeded.
//
// CLI  `node .agents/core/_lib/failure-ledger.js <verb> ...` (project root from the usual env/root
//      resolution, so CLAUDE_PROJECT_DIR wins). Usage errors exit 2 with a message on stderr.
//   record --leg L --exit N --output-file F [--head H] [--mode M]
//       N = 0 records a pass row. N != 0 records a failure from the text in F (ids and detail via
//       extractFailures; mode defaults to L; row.log = F exactly as given) and prints
//       `failure signature <id> seen <N> times in a row`. Exit 0. Missing --leg / non-integer --exit /
//       unreadable F -> exit 2.
//   streak                       prints the integer count, exit 0
//   last [--format prompt|json]  json (default) prints the newest non-killed failure row, or `null`;
//                                prompt prints lastPrompt
//   budget --since STAMP --limits <line|file>
//       prints `attempts: U/L`, `gate-failures: U/L`, `dispatches: U/L`, `minutes: U/L` for each limited
//       key, then `budget: ok` or `budget: EXHAUSTED (key, key)`. Exit 12 when any key is exceeded,
//       else 0. A file is searched for its `**Budget:**` line. Missing --since, a malformed STAMP, an
//       unknown key or a file without a Budget line -> exit 2.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(here, '..', 'failure-ledger.js');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir.js');
const { dateStamp } = require('../attribution-ledger.js');

// Lazy so a missing module fails each test with "Cannot find module", not the whole file at import.
const L = new Proxy({}, { get: (_, key) => require(LIB)[key] });

let tmp;
let root;
beforeEach(() => {
    tmp = createTmpDir({ prefix: 'failure-ledger-' });
    root = tmp.root;
});
afterEach(() => tmp.cleanup());

const ledgerFile = (r = root) => path.join(r, 'docs', '.output', '.state', 'telemetry', 'gate-failures.jsonl');
const writeRows = (rows, r = root) => {
    fs.mkdirSync(path.dirname(ledgerFile(r)), { recursive: true });
    fs.writeFileSync(ledgerFile(r), rows.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');
};
const readRaw = (r = root) => fs.readFileSync(ledgerFile(r), 'utf8').split('\n').filter(Boolean);
const rowsOnDisk = (r = root) => readRaw(r).map(l => JSON.parse(l));

const SIG_A = 'a'.repeat(64);
const SIG_B = 'b'.repeat(64);
const mkRow = (sig, head, extra = {}) => ({ ts: new Date().toISOString(), head, sig, legs: ['test'], passed: false, killed: null, ...extra });
const passRow = head => mkRow(null, head, { passed: true, legs: [] });
const killedRow = (sig, head, k = 'SIGKILL') => mkRow(sig, head, { killed: k });
const envRow = (sig, head) => mkRow(sig, head, { cls: 'environment' });

const stamp = (d) => {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const minutesAgo = n => new Date(Date.now() - n * 60000);

const cli = (args, r = root, env = {}) => {
    const res = spawnSync(process.execPath, [LIB, ...args], {
        encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: r, ...env },
    });
    return { code: res.status, out: res.stdout, err: res.stderr };
};

// Real vitest 5 output (colour off), two failing tests in one file.
const VITEST_OUT = [
    ' RUN  v5.0.3 /somewhere/project',
    '',
    ' ❯ src/a.test.js (2 tests | 2 failed) 6ms',
    '   × adds 4ms',
    '   × objs 1ms',
    '',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
    '',
    ' FAIL  src/a.test.js > adds',
    'AssertionError: expected 2 to be 3 // Object.is equality',
    '',
    '- Expected',
    '+ Received',
    '',
    '- 3',
    '+ 2',
    '',
    ' ❯ src/a.test.js:2:34',
    "      1| import { it, expect } from 'vitest';",
    "      2| it('adds', () => { expect(1 + 1).toBe(3); });",
    '       |                                  ^',
    '',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
    '',
    ' FAIL  src/a.test.js > objs',
    'AssertionError: expected { a: 1 } to deeply equal { a: 2 }',
    '',
    '- Expected',
    '+ Received',
    '',
    '  {',
    '-   "a": 2,',
    '+   "a": 1,',
    '  }',
    '',
    ' ❯ src/a.test.js:3:37',
    "      3| it('objs', () => { expect({ a: 1 }).toEqual({ a: 2 }); });",
    '',
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯',
    '',
    ' Test Files  1 failed (1)',
    '      Tests  2 failed (2)',
    '   Duration  87ms (transform 39%, tests 26%, import 25%, worker 10%)',
    '',
].join('\n');

const PYTEST_OUT = [
    '============================= test session starts ==============================',
    'collected 2 items',
    '',
    'tests/test_math.py F.                                                    [100%]',
    '',
    '=================================== FAILURES ===================================',
    '________________________________ test_add ______________________________________',
    '',
    '    def test_add():',
    '>       assert add(1, 2) == 4',
    'E       assert 3 == 4',
    '',
    'tests/test_math.py:4: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED tests/test_math.py::test_add - assert 3 == 4',
    '========================= 1 failed, 1 passed in 0.03s ==========================',
    '',
].join('\n');

const DOTNET_OUT = [
    '  Failed MathTests.Adds [5 ms]',
    '  Error Message:',
    '   Assert.Equal() Failure: Values differ',
    'Expected: 4',
    'Actual:   3',
    '  Stack Trace:',
    '     at MathTests.Adds() in /src/MathTests.cs:line 12',
    '',
    'Failed!  - Failed:     1, Passed:     1, Skipped:     0, Total:     2, Duration: 12 ms',
    '',
].join('\n');

const NODE_CRASH_OUT = [
    "Error: Cannot find module 'foo'",
    '    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1:1)',
    '',
].join('\n');

// ─── getLedgerPath ───────────────────────────────────────────────────────────────

describe('getLedgerPath', () => {
    it('getLedgerPath_projectRoot_returnsGateFailuresJsonlUnderTelemetry', () => {
        expect(L.getLedgerPath(root)).toBe(path.join(root, 'docs', '.output', '.state', 'telemetry', 'gate-failures.jsonl'));
    });
});

// ─── signature ───────────────────────────────────────────────────────────────────

describe('signature', () => {
    const sig = (over = {}) => L.signature({ ids: ['src/a.test.js > adds'], detail: 'expected 2 to be 3', mode: 'test', root, ...over });

    it('signature_anyInput_isSha256Hex', () => {
        expect(sig()).toMatch(/^[0-9a-f]{64}$/);
    });

    it('signature_sameInputTwice_isDeterministic', () => {
        expect(sig()).toBe(sig());
    });

    it('signature_ansiEscapesInDetailAndIds_areStripped', () => {
        const plain = sig({ ids: ['FAIL x'], detail: 'boom' });
        const colored = sig({ ids: ['\u001b[31mFAIL\u001b[39m x'], detail: '\u001b[1m\u001b[31mboom\u001b[39m\u001b[22m' });
        expect(colored).toBe(plain);
    });

    it('signature_sameFailureUnderDifferentAbsoluteRoots_isTheSame', () => {
        const other = createTmpDir({ prefix: 'failure-ledger-other-' });
        try {
            const rootB = other.root;
            const a = L.signature({ ids: [`${root}/src/a.test.js > adds`], detail: `at ${root}/src/a.test.js`, mode: 'test', root });
            const b = L.signature({ ids: [`${rootB}/src/a.test.js > adds`], detail: `at ${rootB}/src/a.test.js`, mode: 'test', root: rootB });
            expect(a).toBe(b);
        } finally {
            other.cleanup();
        }
    });

    it.each([
        ['millisecond durations', 'took 123ms in worker', 'took 4ms in worker'],
        ['spaced millisecond durations', 'slow (12 ms)', 'slow (905 ms)'],
        ['second durations', 'Duration 1.23s total', 'Duration 0.5s total'],
        ['ISO timestamps', 'at 2026-11-18T12:00:00.123Z failed', 'at 2025-01-02T01:02:03Z failed'],
        ['clock times', 'Start at  12:31:33 failed', 'Start at  03:04:05 failed'],
        ['0x hex ids', 'object 0xdeadbeef leaked', 'object 0x1234abcd leaked'],
        ['bare hex ids', 'commit a1b2c3d4e5f6a7b8 broke', 'commit 0f9e8d7c6b5a4938 broke'],
        ['uuids', 'run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 died', 'run 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d died'],
        ['line and column', 'at src/a.js:12:34', 'at src/a.js:99:1'],
        ['line only', 'at src/a.js:12', 'at src/a.js:40'],
    ])('signature_volatileToken_%s_areStrippedSoSignaturesMatch', (_label, a, b) => {
        expect(sig({ detail: a })).toBe(sig({ detail: b }));
    });

    it('signature_differentFailingIds_differ', () => {
        expect(sig({ ids: ['a'] })).not.toBe(sig({ ids: ['b'] }));
    });

    it('signature_supersetOfFailingIds_differs', () => {
        expect(sig({ ids: ['a'] })).not.toBe(sig({ ids: ['a', 'b'] }));
    });

    it('signature_differentDetail_differs', () => {
        expect(sig({ detail: 'expected 2 to be 3' })).not.toBe(sig({ detail: 'expected 2 to be 4' }));
    });

    it('signature_idOrderAndDuplicates_doNotMatter', () => {
        expect(sig({ ids: ['b', 'a', 'a'] })).toBe(sig({ ids: ['a', 'b'] }));
    });

    it('signature_emptyIds_isEmptyColonMode', () => {
        expect(L.signature({ ids: [], detail: '', mode: 'test', root })).toBe('empty:test');
    });

    it('signature_emptyIdsWithDetail_isStillEmptyColonMode', () => {
        expect(L.signature({ ids: [], detail: 'a stack trace', mode: 'build', root })).toBe('empty:build');
    });

    it('signature_emptyIdsDifferentModes_differ', () => {
        expect(L.signature({ ids: [], mode: 'build', root })).not.toBe(L.signature({ ids: [], mode: 'test', root }));
    });
});

// ─── extractFailures ─────────────────────────────────────────────────────────────

describe('extractFailures', () => {
    it('extractFailures_vitestOutput_returnsFailingIdsInOrder', () => {
        const r = L.extractFailures(VITEST_OUT, { root });
        expect(r.ids).toEqual(['src/a.test.js > adds', 'src/a.test.js > objs']);
    });

    it('extractFailures_vitestOutput_returnsExpectedSawFileAndLinePerAssertion', () => {
        const r = L.extractFailures(VITEST_OUT, { root });
        expect(r.assertions).toEqual([
            { id: 'src/a.test.js > adds', expected: '3', saw: '2', file: 'src/a.test.js', line: 2 },
            { id: 'src/a.test.js > objs', expected: '{ a: 2 }', saw: '{ a: 1 }', file: 'src/a.test.js', line: 3 },
        ]);
    });

    it('extractFailures_vitestOutputWithAnsi_isReadTheSameAsPlain', () => {
        const colored = VITEST_OUT.replace(/^( FAIL  )(.*)$/gm, '\u001b[41m$1\u001b[49m\u001b[31m$2\u001b[39m');
        expect(L.extractFailures(colored, { root }).ids).toEqual(['src/a.test.js > adds', 'src/a.test.js > objs']);
    });

    it('extractFailures_absoluteFilePathUnderRoot_isReturnedRootRelative', () => {
        const text = VITEST_OUT.replace(/^ ❯ src\/a\.test\.js:2:34$/m, ` ❯ ${root}/src/a.test.js:2:34`);
        const r = L.extractFailures(text, { root });
        expect(r.assertions[0].file).toBe('src/a.test.js');
        expect(r.assertions[0].line).toBe(2);
    });

    it('extractFailures_repeatedFailLine_isListedOnce', () => {
        const r = L.extractFailures(VITEST_OUT + '\n FAIL  src/a.test.js > adds\n', { root });
        expect(r.ids).toEqual(['src/a.test.js > adds', 'src/a.test.js > objs']);
    });

    it('extractFailures_pytestOutput_returnsFailedIdAndTheEErrorLine', () => {
        const r = L.extractFailures(PYTEST_OUT, { root });
        expect(r.ids).toEqual(['tests/test_math.py::test_add']);
        expect(r.firstError).toBe('assert 3 == 4');
        expect(r.assertions).toEqual([]);
    });

    it('extractFailures_dotnetOutput_returnsFailedTestName', () => {
        const r = L.extractFailures(DOTNET_OUT, { root });
        expect(r.ids).toEqual(['MathTests.Adds']);
    });

    it('extractFailures_nodeCrashWithNoTestNames_returnsNoIdsAndTheErrorLine', () => {
        const r = L.extractFailures(NODE_CRASH_OUT, { root });
        expect(r.ids).toEqual([]);
        expect(r.firstError).toBe("Error: Cannot find module 'foo'");
    });

    it('extractFailures_cleanOutput_returnsNothing', () => {
        expect(L.extractFailures('Tests: 3 passed, 0 failed\n', { root })).toEqual({ ids: [], assertions: [], firstError: null });
    });
});

// ─── currentHead ─────────────────────────────────────────────────────────────────

describe('currentHead', () => {
    const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });

    it('currentHead_notAGitWorkTree_isNull', () => {
        expect(L.currentHead(root)).toBeNull();
    });

    describe('in a git work tree', () => {
        let repo;
        beforeEach(() => {
            repo = tmp.mkdir('repo');
            git(['init', '-q'], repo);
            fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
            git(['add', 'a.txt'], repo);
            git(['commit', '-q', '-m', 'init'], repo);
        });

        it('currentHead_cleanTreeTwice_isStable', () => {
            const first = L.currentHead(repo);
            expect(typeof first).toBe('string');
            expect(first.length).toBeGreaterThan(0);
            expect(L.currentHead(repo)).toBe(first);
        });

        it('currentHead_trackedFileEdited_changes', () => {
            const clean = L.currentHead(repo);
            fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
            expect(L.currentHead(repo)).not.toBe(clean);
        });

        it('currentHead_sameFileEditedAgainToDifferentContent_changesAgain', () => {
            fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
            const first = L.currentHead(repo);
            fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
            expect(L.currentHead(repo)).not.toBe(first);
        });

        it('currentHead_untrackedFileAdded_changes', () => {
            const clean = L.currentHead(repo);
            fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
            expect(L.currentHead(repo)).not.toBe(clean);
        });

        it('currentHead_editReverted_returnsToTheCleanValue', () => {
            const clean = L.currentHead(repo);
            fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
            fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
            expect(L.currentHead(repo)).toBe(clean);
        });

        it('currentHead_fileWrittenUnderDocsOutputState_doesNotChangeIt', () => {
            const clean = L.currentHead(repo);
            const state = path.join(repo, 'docs', '.output', '.state', 'telemetry');
            fs.mkdirSync(state, { recursive: true });
            fs.writeFileSync(path.join(state, 'gate-failures.jsonl'), '{}\n');
            expect(L.currentHead(repo)).toBe(clean);
        });

        it('currentHead_newCommit_changes', () => {
            const before = L.currentHead(repo);
            fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
            git(['add', 'b.txt'], repo);
            git(['commit', '-q', '-m', 'second'], repo);
            expect(L.currentHead(repo)).not.toBe(before);
        });
    });
});

// ─── appendFailure / readLedger ──────────────────────────────────────────────────

describe('appendFailure and readLedger', () => {
    it('appendFailure_minimalRow_writesExactlyTheSixLedgerKeys', () => {
        const written = L.appendFailure({ sig: SIG_A, head: 'h1', legs: ['test'] }, { root });

        const onDisk = rowsOnDisk();
        expect(onDisk).toHaveLength(1);
        expect(Object.keys(onDisk[0]).sort()).toEqual(['head', 'killed', 'legs', 'passed', 'sig', 'ts']);
        expect(onDisk[0]).toMatchObject({ sig: SIG_A, head: 'h1', legs: ['test'], passed: false, killed: null });
        expect(onDisk[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(written).toEqual(onDisk[0]);
    });

    it('appendFailure_optionalClsAndLog_arePersisted', () => {
        L.appendFailure({ sig: SIG_A, head: 'h1', legs: ['test'], cls: 'environment', log: '/x/y.log' }, { root });
        expect(rowsOnDisk()[0]).toMatchObject({ cls: 'environment', log: '/x/y.log' });
    });

    it('appendFailure_createsTheTelemetryDirectoryWhenMissing', () => {
        expect(fs.existsSync(path.join(root, 'docs'))).toBe(false);
        L.appendFailure({ sig: SIG_A, head: null, legs: ['build'] }, { root });
        expect(fs.existsSync(ledgerFile())).toBe(true);
    });

    it('appendFailure_twoAppends_keepFileOrder', () => {
        L.appendFailure({ sig: SIG_A, head: 'h1', legs: ['test'] }, { root });
        L.appendFailure({ sig: SIG_B, head: 'h2', legs: ['lint'] }, { root });
        expect(rowsOnDisk().map(r => r.sig)).toEqual([SIG_A, SIG_B]);
    });

    it('appendFailure_directoryWhereTheLedgerFileShouldBe_returnsNullAndDoesNotThrow', () => {
        fs.mkdirSync(ledgerFile(), { recursive: true });
        const result = L.appendFailure({ sig: SIG_A, head: 'h1', legs: ['test'] }, { root });
        expect(result).toBeNull();
    });

    it('appendFailure_telemetryParentIsAFile_returnsNull', () => {
        fs.writeFileSync(path.join(root, 'docs'), 'not a directory');
        expect(L.appendFailure({ sig: SIG_A, head: 'h1', legs: ['test'] }, { root })).toBeNull();
    });

    it('appendFailure_ledgerAtTwoThousandLines_doesNotRotate', () => {
        writeRows(Array.from({ length: 1999 }, (_, i) => mkRow(SIG_A, `h${i}`)));
        L.appendFailure({ sig: SIG_B, head: 'new', legs: ['test'] }, { root });
        expect(readRaw()).toHaveLength(2000);
    });

    it('appendFailure_appendPushingPastTwoThousandLines_rotatesToTheLast1500', () => {
        writeRows(Array.from({ length: 2000 }, (_, i) => mkRow(SIG_A, `h${i}`)));
        L.appendFailure({ sig: SIG_B, head: 'new', legs: ['test'] }, { root });

        const rows = rowsOnDisk();
        expect(rows).toHaveLength(1500);
        expect(rows[0].head).toBe('h501');
        expect(rows[rows.length - 1].head).toBe('new');
    });

    it('readLedger_missingFile_returnsEmptyArray', () => {
        expect(L.readLedger({ root })).toEqual([]);
    });

    it('readLedger_corruptLinesBetweenValidRows_areSkipped', () => {
        writeRows([mkRow(SIG_A, 'h1'), 'this is not json', '{"half": ', mkRow(SIG_B, 'h2')]);
        expect(L.readLedger({ root }).map(r => r.sig)).toEqual([SIG_A, SIG_B]);
    });

    it('readLedger_directoryInPlaceOfTheFile_returnsEmptyArray', () => {
        fs.mkdirSync(ledgerFile(), { recursive: true });
        expect(L.readLedger({ root })).toEqual([]);
    });
});

// ─── classify / streak ───────────────────────────────────────────────────────────

describe('classify and streak', () => {
    it('classify_noRows_isNoneWithZeroCount', () => {
        expect(L.classify([])).toEqual({ class: 'none', sig: null, count: 0 });
    });

    it('classify_firstFailure_isGenuineCountOne', () => {
        expect(L.classify([mkRow(SIG_A, 'h1')])).toEqual({ class: 'genuine', sig: SIG_A, count: 1 });
    });

    it('classify_sameSignatureOnAChangedTree_isGenuineRepeat', () => {
        expect(L.classify([mkRow(SIG_A, 'h1'), mkRow(SIG_A, 'h2')])).toEqual({ class: 'genuine', sig: SIG_A, count: 2 });
    });

    it('classify_threeGenuineRepeats_countThree', () => {
        expect(L.classify([mkRow(SIG_A, 'h1'), mkRow(SIG_A, 'h2'), mkRow(SIG_A, 'h3')]).count).toBe(3);
    });

    it('classify_sameSignatureOnTheSameTree_isNoopAndDoesNotCount', () => {
        expect(L.classify([mkRow(SIG_A, 'h1'), mkRow(SIG_A, 'h1')])).toEqual({ class: 'noop', sig: SIG_A, count: 1 });
    });

    it('classify_noopAfterAGenuineRepeat_keepsTheCountAtTwo', () => {
        const rows = [mkRow(SIG_A, 'h1'), mkRow(SIG_A, 'h2'), mkRow(SIG_A, 'h2'), mkRow(SIG_A, 'h2')];
        expect(L.classify(rows)).toEqual({ class: 'noop', sig: SIG_A, count: 2 });
    });

    it('classify_aPassBetweenFailures_resetsTheStreak', () => {
        const rows = [mkRow(SIG_A, 'h1'), mkRow(SIG_A, 'h2'), passRow('h3'), mkRow(SIG_A, 'h4')];
        expect(L.classify(rows)).toEqual({ class: 'genuine', sig: SIG_A, count: 1 });
    });

    it('classify_newestRowIsAPass_isPassWithZeroCount', () => {
        expect(L.classify([mkRow(SIG_A, 'h1'), passRow('h2')])).toEqual({ class: 'pass', sig: null, count: 0 });
    });

    it('classify_aDifferentSignature_startsANewRun', () => {
        const rows = [mkRow(SIG_A, 'h1'), mkRow(SIG_A, 'h2'), mkRow(SIG_B, 'h3')];
        expect(L.classify(rows)).toEqual({ class: 'genuine', sig: SIG_B, count: 1 });
    });

    it('classify_aKilledRowBetweenRepeats_isNeutralAndDoesNotBreakTheRun', () => {
        const rows = [mkRow(SIG_A, 'h1'), killedRow(SIG_A, 'h2'), mkRow(SIG_A, 'h3')];
        expect(L.classify(rows)).toEqual({ class: 'genuine', sig: SIG_A, count: 2 });
    });

    it('classify_aTimeoutRowBetweenRepeatsOfDifferentSig_isNeutralToo', () => {
        const rows = [mkRow(SIG_A, 'h1'), killedRow(SIG_B, 'h2', 'TIMEOUT'), mkRow(SIG_A, 'h3')];
        expect(L.classify(rows).count).toBe(2);
    });

    it('classify_newestRowIsKilled_looksThroughToTheLastRealOutcome', () => {
        const rows = [mkRow(SIG_A, 'h1'), mkRow(SIG_A, 'h2'), killedRow(SIG_A, 'h3')];
        expect(L.classify(rows)).toEqual({ class: 'genuine', sig: SIG_A, count: 2 });
    });

    it('classify_onlyKilledRows_isNone', () => {
        expect(L.classify([killedRow(SIG_A, 'h1')]).class).toBe('none');
    });

    it('classify_failureOnATreeThatAlreadyPassed_isFlakyAndCountsZero', () => {
        const rows = [passRow('h1'), mkRow(SIG_A, 'h1')];
        expect(L.classify(rows)).toEqual({ class: 'flaky', sig: SIG_A, count: 0 });
    });

    it('classify_failPassFailOnTheSameTree_isFlaky', () => {
        const rows = [mkRow(SIG_A, 'h1'), passRow('h1'), mkRow(SIG_A, 'h1')];
        expect(L.classify(rows)).toEqual({ class: 'flaky', sig: SIG_A, count: 0 });
    });

    it('classify_aPassOnADifferentTree_doesNotMakeTheFailureFlaky', () => {
        const rows = [passRow('h1'), mkRow(SIG_A, 'h2')];
        expect(L.classify(rows).class).toBe('genuine');
    });

    it('classify_unknownTreesWithNullHeads_neverCountAsFlaky', () => {
        const rows = [passRow(null), mkRow(SIG_A, null)];
        expect(L.classify(rows)).toEqual({ class: 'genuine', sig: SIG_A, count: 1 });
    });

    it('classify_nullHeadsOnRepeatedFailures_countEveryRun', () => {
        expect(L.classify([mkRow(SIG_A, null), mkRow(SIG_A, null)])).toEqual({ class: 'genuine', sig: SIG_A, count: 2 });
    });

    it('classify_newestFailureIsEnvironment_isEnvironmentWithZeroCount', () => {
        const rows = [mkRow(SIG_A, 'h1'), envRow(SIG_B, 'h2')];
        expect(L.classify(rows)).toEqual({ class: 'environment', sig: SIG_B, count: 0 });
    });

    it('classify_anEnvironmentRowBetweenRepeats_isNeutral', () => {
        const rows = [mkRow(SIG_A, 'h1'), envRow(SIG_B, 'h2'), mkRow(SIG_A, 'h3')];
        expect(L.classify(rows)).toEqual({ class: 'genuine', sig: SIG_A, count: 2 });
    });

    it('streak_returnsTheClassifyCount', () => {
        expect(L.streak([mkRow(SIG_A, 'h1'), mkRow(SIG_A, 'h2')])).toBe(2);
        expect(L.streak([])).toBe(0);
        expect(L.streak([mkRow(SIG_A, 'h1'), passRow('h2')])).toBe(0);
        expect(L.streak([passRow('h1'), mkRow(SIG_A, 'h1')])).toBe(0);
    });
});

// ─── recordGateRun ───────────────────────────────────────────────────────────────

describe('recordGateRun', () => {
    const fail = (over = {}) => L.recordGateRun({
        root, legs: ['test'], passed: false, killed: null, timedOut: false,
        ids: ['src/a.test.js > adds'], detail: 'expected 2 to be 3', head: 'h1', ...over,
    });

    it('recordGateRun_failingRun_appendsOneRowWithTheLedgerShape', () => {
        const result = fail();

        const rows = rowsOnDisk();
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0]).sort()).toEqual(['head', 'killed', 'legs', 'passed', 'sig', 'ts']);
        expect(rows[0]).toMatchObject({ head: 'h1', legs: ['test'], passed: false, killed: null });
        expect(rows[0].sig).toMatch(/^[0-9a-f]{64}$/);
        expect(result).toMatchObject({ recorded: true, sig: rows[0].sig, class: 'genuine', count: 1 });
    });

    it('recordGateRun_logPath_isStoredOnTheRow', () => {
        fail({ log: '/some/where/gate.log' });
        expect(rowsOnDisk()[0].log).toBe('/some/where/gate.log');
    });

    it('recordGateRun_sameSignatureOnAChangedTree_incrementsTheStreak', () => {
        fail({ head: 'h1' });
        expect(fail({ head: 'h2' })).toMatchObject({ class: 'genuine', count: 2 });
    });

    it('recordGateRun_sameSignatureOnTheSameTree_isANoop', () => {
        fail({ head: 'h1' });
        expect(fail({ head: 'h1' })).toMatchObject({ class: 'noop', count: 1 });
    });

    it('recordGateRun_durationNoiseInTheDetail_doesNotChangeTheSignature', () => {
        const a = fail({ detail: 'expected 2 to be 3 took 12ms', head: 'h1' });
        const b = fail({ detail: 'expected 2 to be 3 took 905ms', head: 'h2' });
        expect(b.sig).toBe(a.sig);
        expect(b.count).toBe(2);
    });

    it('recordGateRun_aDifferentFailingSet_restartsTheStreak', () => {
        fail({ head: 'h1' });
        expect(fail({ ids: ['src/b.test.js > other'], head: 'h2' })).toMatchObject({ class: 'genuine', count: 1 });
    });

    it('recordGateRun_noFailingIds_usesEmptyColonMode', () => {
        const result = fail({ ids: [], detail: '', legs: ['test'] });
        expect(result.sig).toBe('empty:test');
        expect(rowsOnDisk()[0].sig).toBe('empty:test');
    });

    it('recordGateRun_modeOption_overridesTheLegsJoinInTheEmptySignature', () => {
        expect(fail({ ids: [], legs: ['test', 'lint'], mode: 'e2e' }).sig).toBe('empty:e2e');
        expect(fail({ ids: [], legs: ['test', 'lint'], mode: undefined, head: 'h2' }).sig).toBe('empty:test+lint');
    });

    it('recordGateRun_passingRun_appendsAPassRowAndResetsTheStreak', () => {
        fail({ head: 'h1' });
        fail({ head: 'h2' });

        const result = L.recordGateRun({ root, legs: [], passed: true, head: 'h3' });

        const rows = rowsOnDisk();
        expect(rows).toHaveLength(3);
        expect(rows[2]).toMatchObject({ passed: true, sig: null, killed: null, head: 'h3' });
        expect(result).toMatchObject({ recorded: true, class: 'pass', count: 0 });
        expect(fail({ head: 'h4' })).toMatchObject({ class: 'genuine', count: 1 });
    });

    it('recordGateRun_signalKilledRun_recordsKilledAndLeavesTheStreakUntouched', () => {
        fail({ head: 'h1' });
        fail({ head: 'h2' });

        const result = L.recordGateRun({ root, legs: ['test'], passed: false, killed: 'SIGKILL', ids: ['x'], head: 'h3' });

        expect(rowsOnDisk()[2]).toMatchObject({ passed: false, killed: 'SIGKILL' });
        expect(result).toMatchObject({ recorded: true, class: 'neutral', count: 2 });
        expect(fail({ head: 'h4' })).toMatchObject({ count: 3 });
    });

    it('recordGateRun_timedOutRun_recordsKilledTimeoutAndIsNeutral', () => {
        fail({ head: 'h1' });

        const result = L.recordGateRun({ root, legs: ['test'], passed: false, killed: null, timedOut: true, ids: [], head: 'h2' });

        expect(rowsOnDisk()[1]).toMatchObject({ passed: false, killed: 'TIMEOUT' });
        expect(result).toMatchObject({ class: 'neutral', count: 1 });
    });

    it.each([
        'Error: connect ECONNREFUSED 127.0.0.1:5432',
        'Error: listen EADDRINUSE: address already in use :::3000',
        'Error: ENOSPC: no space left on device, write',
        'Error: spawn ENOMEM',
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    ])('recordGateRun_environmentDetail_%s_isClassifiedEnvironmentAndNeverCounts', (detail) => {
        const result = fail({ detail });

        expect(rowsOnDisk()[0].cls).toBe('environment');
        expect(result).toMatchObject({ class: 'environment', count: 0 });
    });

    it('recordGateRun_ordinaryFailure_carriesNoClsKey', () => {
        fail();
        expect('cls' in rowsOnDisk()[0]).toBe(false);
    });

    it('recordGateRun_failureOnATreeThatPassed_isFlaky', () => {
        L.recordGateRun({ root, legs: [], passed: true, head: 'h1' });
        expect(fail({ head: 'h1' })).toMatchObject({ class: 'flaky', count: 0 });
    });

    it('recordGateRun_headOmitted_usesCurrentHeadWhichIsNullOutsideGit', () => {
        L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['a'], detail: '' });
        expect(rowsOnDisk()[0].head).toBeNull();
    });

    it('recordGateRun_corruptLinesAlreadyInTheLedger_doNotChangeTheCount', () => {
        writeRows([mkRow(SIG_A, 'h1'), 'garbage', '{"x":']);
        const first = L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['a'], detail: '', head: 'h2' });
        const second = L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['a'], detail: '', head: 'h3' });
        expect(first.count).toBe(1);
        expect(second.count).toBe(2);
    });

    it('recordGateRun_unwritableTelemetryDirectory_returnsNotRecordedInsteadOfThrowing', () => {
        fs.writeFileSync(path.join(root, 'docs'), 'a file where the docs directory should be');
        const result = fail();
        expect(result.recorded).toBe(false);
    });

    it('recordGateRun_ledgerPathIsADirectory_returnsNotRecordedInsteadOfThrowing', () => {
        fs.mkdirSync(ledgerFile(), { recursive: true });
        expect(fail().recorded).toBe(false);
    });

    it.each([
        ['undefined input', undefined],
        ['null input', null],
        ['empty object', {}],
        ['non-array legs and ids', { root: '', legs: 'test', ids: 5, detail: {} }],
    ])('recordGateRun_garbage_%s_returnsAResultInsteadOfThrowing', (_label, input) => {
        // A missing root falls back to the ambient project root: point it at the temp dir so a
        // defaulted write can never land in the real checkout's ledger.
        const prev = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = root;
        try {
            const result = L.recordGateRun(input);
            expect(typeof result).toBe('object');
            expect(typeof result.recorded).toBe('boolean');
        } finally {
            if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = prev;
        }
    });
});

// ─── lastPrompt ──────────────────────────────────────────────────────────────────

describe('lastPrompt', () => {
    const logFile = (name, text) => tmp.write(name, text);

    it('lastPrompt_vitestLog_printsExpectedSawAndFileLinePerAssertion', () => {
        const log = logFile('out/vitest.log', VITEST_OUT);
        L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['src/a.test.js > adds', 'src/a.test.js > objs'], detail: 'x', head: 'h1', log });

        const text = L.lastPrompt({ root });

        expect(text).toContain('expected 3 | saw 2 | src/a.test.js:2');
        expect(text).toContain('expected { a: 2 } | saw { a: 1 } | src/a.test.js:3');
    });

    it('lastPrompt_firstLine_isTheSignatureAndStreakLine', () => {
        const log = logFile('out/vitest.log', VITEST_OUT);
        const rec = L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['a'], detail: 'x', head: 'h1', log });
        L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['a'], detail: 'x', head: 'h2', log });

        const first = L.lastPrompt({ root }).split('\n')[0];

        expect(first).toBe(`failure signature ${rec.sig.slice(0, 12)} seen 2 times in a row`);
    });

    it.each([
        ['pytest', PYTEST_OUT, 'tests/test_math.py::test_add', 'assert 3 == 4'],
        ['dotnet', DOTNET_OUT, 'MathTests.Adds', 'Assert.Equal() Failure'],
    ])('lastPrompt_%sLog_fallsBackToIdsFirstErrorAndLogPathWithoutExpectedSaw', (_name, out, id, errorBit) => {
        const log = logFile('out/runner.log', out);
        L.recordGateRun({ root, legs: ['test'], passed: false, ids: [id], detail: out, head: 'h1', log });

        const text = L.lastPrompt({ root });

        expect(text).toContain(id);
        expect(text).toContain(log);
        expect(text).toContain(errorBit);
        expect(text).not.toMatch(/expected .* \| saw /);
    });

    it('lastPrompt_nodeCrashLogWithNoTestIds_stillNamesTheErrorLineAndLogPath', () => {
        const log = logFile('out/crash.log', NODE_CRASH_OUT);
        L.recordGateRun({ root, legs: ['test'], passed: false, ids: [], detail: NODE_CRASH_OUT, head: 'h1', log });

        const text = L.lastPrompt({ root });

        expect(text).toContain("Error: Cannot find module 'foo'");
        expect(text).toContain(log);
    });

    it('lastPrompt_logFileMissing_stillNamesTheSignatureAndTheLogPath', () => {
        const log = path.join(root, 'out', 'gone.log');
        const rec = L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['a'], detail: 'x', head: 'h1', log });

        const text = L.lastPrompt({ root });

        expect(text).toContain(rec.sig.slice(0, 12));
        expect(text).toContain(log);
    });

    it('lastPrompt_noFailureRows_saysSo', () => {
        expect(L.lastPrompt({ root })).toContain('no failure recorded');
    });

    it('lastPrompt_newestRowIsKilled_describesTheLastRealFailure', () => {
        const log = logFile('out/vitest.log', VITEST_OUT);
        L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['a'], detail: 'x', head: 'h1', log });
        L.recordGateRun({ root, legs: ['test'], passed: false, killed: 'SIGKILL', ids: [], head: 'h2' });

        expect(L.lastPrompt({ root })).toContain('expected 3 | saw 2 | src/a.test.js:2');
    });

    it('lastPrompt_ansiColouredVitestLog_isStillParsed', () => {
        const colored = VITEST_OUT.replace(/^(AssertionError.*)$/gm, '\u001b[31m$1\u001b[39m').replace(/^ ❯ (.*)$/gm, ' \u001b[2m❯\u001b[22m \u001b[36m$1\u001b[39m');
        const log = logFile('out/colored.log', colored);
        L.recordGateRun({ root, legs: ['test'], passed: false, ids: ['a'], detail: 'x', head: 'h1', log });

        expect(L.lastPrompt({ root })).toContain('expected 3 | saw 2 | src/a.test.js:2');
    });
});

// ─── parseBudget ─────────────────────────────────────────────────────────────────

describe('parseBudget', () => {
    const FULL = { attempts: 3, 'gate-failures': 6, dispatches: 40, minutes: 240 };

    it('parseBudget_theSeamLine_returnsAllFourLimits', () => {
        expect(L.parseBudget('**Budget:** attempts=3 gate-failures=6 dispatches=40 minutes=240')).toEqual(FULL);
    });

    it('parseBudget_commaSeparated_returnsTheSameLimits', () => {
        expect(L.parseBudget('**Budget:** attempts=3,gate-failures=6,dispatches=40,minutes=240')).toEqual(FULL);
    });

    it('parseBudget_commaAndSpaceSeparated_returnsTheSameLimits', () => {
        expect(L.parseBudget('**Budget:** attempts=3, gate-failures=6, dispatches=40, minutes=240')).toEqual(FULL);
    });

    it('parseBudget_withoutTheBoldPrefix_isAccepted', () => {
        expect(L.parseBudget('attempts=3 gate-failures=6 dispatches=40 minutes=240')).toEqual(FULL);
    });

    it('parseBudget_bulletedPlanLine_isAccepted', () => {
        expect(L.parseBudget('- **Budget:** attempts=3 gate-failures=6 dispatches=40 minutes=240')).toEqual(FULL);
    });

    it('parseBudget_aSubsetOfKeys_returnsOnlyThoseKeys', () => {
        expect(L.parseBudget('**Budget:** attempts=2 minutes=30')).toEqual({ attempts: 2, minutes: 30 });
    });

    it('parseBudget_unknownKey_throwsNamingTheKey', () => {
        expect(() => L.parseBudget('**Budget:** attempts=3 bogus=9')).toThrow(/bogus/);
    });

    it.each([
        ['non-integer value', 'attempts=abc'],
        ['decimal value', 'attempts=2.5'],
        ['negative value', 'attempts=-1'],
        ['empty value', 'attempts='],
        ['no pairs', '**Budget:**'],
        ['empty line', ''],
    ])('parseBudget_%s_throws', (_label, line) => {
        // Precondition: the parser works on a valid line, so a throw below is the parser's own rejection.
        expect(L.parseBudget('attempts=1')).toEqual({ attempts: 1 });
        expect(() => L.parseBudget(line)).toThrow();
    });
});

// ─── budget (function) ───────────────────────────────────────────────────────────

describe('budget function', () => {
    it('budget_countsGateFailuresAttemptsDispatchesAndMinutesAgainstTheLimits', () => {
        const now = new Date(2026, 10, 18, 12, 0, 0);
        const since = '261118-1000';
        writeRows([
            mkRow(SIG_A, 'h1', { ts: new Date(2026, 10, 18, 10, 5).toISOString() }),
            mkRow(SIG_A, 'h2', { ts: new Date(2026, 10, 18, 10, 30).toISOString() }),
        ]);

        const result = L.budget({ root, since, limits: { 'gate-failures': 2, minutes: 120, dispatches: 5, attempts: 3 }, now });

        expect(result.used).toEqual({ 'gate-failures': 2, minutes: 120, dispatches: 0, attempts: 0 });
        expect(result.exceeded).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it('budget_hookWrittenLaunchesCountWhenNoAttributionWasAppended', () => {
        const now = new Date(2026, 10, 18, 12, 0, 0);
        const at = (h, m) => new Date(2026, 10, 18, h, m).toISOString();
        const rows = [
            { type: 'agent_dispatch', timestamp: at(9, 59), agent: 'general-purpose' },
            { type: 'agent_dispatch', timestamp: at(10, 5), agent: 'general-purpose' },
            { type: 'agent_dispatch', timestamp: at(10, 6), agent: 'code-reviewer' },
            { type: 'agent_dispatch', timestamp: at(10, 40), hook_event_name: 'SubagentStop', agent: 'general-purpose' },
            { type: 'skill_read', timestamp: at(10, 7), skill: 'x' },
        ];
        tmp.write('docs/.output/.state/telemetry/skill-usage.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\nnot json\n');

        const result = L.budget({ root, since: '261118-1000', limits: { dispatches: 1 }, now });

        expect(result.used.dispatches).toBe(2);
        expect(result.exceeded).toEqual(['dispatches']);
    });

    it('budget_oneMinuteOverTheMinutesLimit_isExceeded', () => {
        const now = new Date(2026, 10, 18, 12, 0, 0);
        const result = L.budget({ root, since: '261118-1000', limits: { minutes: 119 }, now });
        expect(result.exceeded).toEqual(['minutes']);
        expect(result.ok).toBe(false);
    });

    it('budget_aKeyWithNoLimit_isNeverExceeded', () => {
        writeRows(Array.from({ length: 50 }, (_, i) => mkRow(SIG_A, `h${i}`)));
        const result = L.budget({ root, since: stamp(minutesAgo(5)), limits: { attempts: 3 } });
        expect(result.exceeded).toEqual([]);
        expect(result.ok).toBe(true);
    });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────────

describe('CLI record', () => {
    const outFile = (name, text) => tmp.write(`out/${name}`, text);

    it('record_failingFocusedRun_appendsARowAndPrintsTheSignatureLine', () => {
        const file = outFile('focused.log', VITEST_OUT);

        const r = cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h1']);

        expect(r.code).toBe(0);
        const rows = rowsOnDisk();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ legs: ['test'], passed: false, killed: null, head: 'h1', log: file });
        expect(rows[0].sig).toMatch(/^[0-9a-f]{64}$/);
        expect(r.out).toContain(`failure signature ${rows[0].sig.slice(0, 12)} seen 1 times in a row`);
    });

    it('record_sameFailureOnAChangedTree_printsSeenTwoTimes', () => {
        const file = outFile('focused.log', VITEST_OUT);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h1']);

        const r = cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h2']);

        expect(r.out).toMatch(/failure signature \S+ seen 2 times in a row/);
    });

    it('record_sameFailureOnTheSameTree_doesNotCountAgain', () => {
        const file = outFile('focused.log', VITEST_OUT);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h1']);

        const r = cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h1']);

        expect(r.out).toMatch(/failure signature \S+ seen 1 times in a row/);
        expect(cli(['streak']).out.trim()).toBe('1');
    });

    it('record_outputsDifferingOnlyInVolatileTokens_shareASignature', () => {
        const a = outFile('a.log', VITEST_OUT);
        const noisy = VITEST_OUT.replace('87ms', '412ms').replace('src/a.test.js:2:34', 'src/a.test.js:9:1').replace(`/somewhere/project`, root);
        const b = outFile('b.log', noisy);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', a, '--head', 'h1']);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', b, '--head', 'h2']);

        const rows = rowsOnDisk();
        expect(rows[1].sig).toBe(rows[0].sig);
    });

    it('record_sameTestsButADifferentAssertedValue_isADifferentSignature', () => {
        const a = outFile('a.log', VITEST_OUT);
        const b = outFile('b.log', VITEST_OUT.replace('expected 2 to be 3', 'expected 5 to be 3'));
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', a, '--head', 'h1']);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', b, '--head', 'h2']);

        const rows = rowsOnDisk();
        expect(rows[1].sig).not.toBe(rows[0].sig);
    });

    it('record_outputWithNoFailingIds_usesEmptyColonLeg', () => {
        const file = outFile('crash.log', 'something went wrong\n');
        cli(['record', '--leg', 'build', '--exit', '1', '--output-file', file, '--head', 'h1']);
        expect(rowsOnDisk()[0]).toMatchObject({ sig: 'empty:build', legs: ['build'] });
    });

    it('record_modeOption_overridesTheLegInTheEmptySignature', () => {
        const file = outFile('crash.log', 'something went wrong\n');
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h1', '--mode', 'focused']);
        expect(rowsOnDisk()[0].sig).toBe('empty:focused');
    });

    it('record_exitZero_recordsAPassRowAndResetsTheStreak', () => {
        const file = outFile('focused.log', VITEST_OUT);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h1']);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h2']);

        const r = cli(['record', '--leg', 'test', '--exit', '0', '--output-file', file, '--head', 'h3']);

        expect(r.code).toBe(0);
        expect(rowsOnDisk()[2]).toMatchObject({ passed: true, sig: null });
        expect(cli(['streak']).out.trim()).toBe('0');
    });

    it('record_environmentOutput_isStoredAsEnvironmentAndDoesNotCount', () => {
        // F3: the marker sits inside the failing test's own block (as vitest prints it), not before it.
        const file = outFile('env.log', ' FAIL  src/db.test.js > connects\nError: connect ECONNREFUSED 127.0.0.1:5432\n');
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h1']);

        expect(rowsOnDisk()[0].cls).toBe('environment');
        expect(cli(['streak']).out.trim()).toBe('0');
    });

    it.each([
        ['missing --leg', ['record', '--exit', '1', '--output-file', 'x']],
        ['non-integer --exit', ['record', '--leg', 'test', '--exit', 'abc', '--output-file', 'x']],
        ['missing --exit', ['record', '--leg', 'test', '--output-file', 'x']],
    ])('record_%s_exitsTwoWithUsageAndWritesNothing', (_label, args) => {
        const r = cli(args);
        expect(r.code).toBe(2);
        expect(r.err.length).toBeGreaterThan(0);
        expect(fs.existsSync(ledgerFile())).toBe(false);
    });

    it('record_unreadableOutputFile_exitsTwoAndWritesNothing', () => {
        const r = cli(['record', '--leg', 'test', '--exit', '1', '--output-file', path.join(root, 'nope.log')]);
        expect(r.code).toBe(2);
        expect(fs.existsSync(ledgerFile())).toBe(false);
    });

    it('record_ledgerPathIsADirectory_stillExitsZeroForAFailingRun', () => {
        fs.mkdirSync(ledgerFile(), { recursive: true });
        const file = outFile('focused.log', VITEST_OUT);
        const r = cli(['record', '--leg', 'test', '--exit', '1', '--output-file', file, '--head', 'h1']);
        expect(r.code).toBe(0);
    });
});

describe('CLI streak and last', () => {
    it('streak_emptyLedger_printsZero', () => {
        const r = cli(['streak']);
        expect(r.code).toBe(0);
        expect(r.out.trim()).toBe('0');
    });

    it('streak_twoGenuineRepeatsWithACorruptLine_printsTwo', () => {
        writeRows([mkRow(SIG_A, 'h1'), '###', mkRow(SIG_A, 'h2')]);
        expect(cli(['streak']).out.trim()).toBe('2');
    });

    it('last_default_printsTheNewestFailureRowAsJson', () => {
        writeRows([mkRow(SIG_A, 'h1'), mkRow(SIG_B, 'h2'), killedRow(SIG_A, 'h3')]);
        const r = cli(['last']);
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out)).toMatchObject({ sig: SIG_B, head: 'h2' });
    });

    it('last_emptyLedger_printsNull', () => {
        const r = cli(['last']);
        expect(r.code).toBe(0);
        expect(r.out.trim()).toBe('null');
    });

    it('last_formatPrompt_printsTheExpectedSawLine', () => {
        const log = tmp.write('out/vitest.log', VITEST_OUT);
        writeRows([mkRow(SIG_A, 'h1', { log })]);

        const r = cli(['last', '--format', 'prompt']);

        expect(r.code).toBe(0);
        expect(r.out).toContain('expected 3 | saw 2 | src/a.test.js:2');
    });

    it('last_formatPromptForPytest_printsIdsErrorLineAndLogPath', () => {
        const log = tmp.write('out/pytest.log', PYTEST_OUT);
        writeRows([mkRow(SIG_A, 'h1', { log })]);

        const r = cli(['last', '--format', 'prompt']);

        expect(r.out).toContain('tests/test_math.py::test_add');
        expect(r.out).toContain('assert 3 == 4');
        expect(r.out).toContain(log);
        expect(r.out).not.toMatch(/expected .* \| saw /);
    });

    it('last_unknownFormat_exitsTwo', () => {
        expect(cli(['last', '--format', 'yaml']).code).toBe(2);
    });

    it('cli_unknownVerbOrNoVerb_exitsTwo', () => {
        expect(cli(['frobnicate']).code).toBe(2);
        expect(cli([]).code).toBe(2);
    });
});

describe('CLI budget', () => {
    const LINE = '**Budget:** attempts=3 gate-failures=6 dispatches=40 minutes=240';
    const since = () => stamp(minutesAgo(30));
    const attribution = (entries) => {
        // Attribution files are day-rotated by the entry's own local date.
        const byDay = new Map();
        for (const e of entries) {
            const day = dateStamp(new Date(e.timestamp));
            byDay.set(day, [...(byDay.get(day) || []), JSON.stringify(e)]);
        }
        for (const [day, lines] of byDay) {
            const file = path.join(root, 'docs', '.output', '.state', 'telemetry', `attribution-${day}.jsonl`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, lines.join('\n') + '\n');
        }
    };
    const dispatch = (story, minsAgo = 5) => ({
        timestamp: minutesAgo(minsAgo).toISOString(), story_id: story, agent: 'general-purpose', model: 'sonnet', files_touched: [], status: 'DONE',
    });
    const freshRows = (n, extra = {}) => Array.from({ length: n }, (_, i) => mkRow(SIG_A, `h${i}`, extra));

    it('budget_everythingWithinLimits_printsEachCounterAndExitsZero', () => {
        writeRows(freshRows(1));
        attribution([dispatch('S1'), dispatch('S2')]);

        const r = cli(['budget', '--since', since(), '--limits', LINE]);

        expect(r.code).toBe(0);
        expect(r.out).toContain('attempts: 1/3');
        expect(r.out).toContain('gate-failures: 1/6');
        expect(r.out).toContain('dispatches: 2/40');
        expect(r.out).toMatch(/minutes: (30|31)\/240/);
        expect(r.out).toContain('budget: ok');
    });

    it('budget_gateFailuresOverTheLimit_exitsTwelveAndNamesTheKey', () => {
        writeRows(freshRows(7));

        const r = cli(['budget', '--since', since(), '--limits', LINE]);

        expect(r.code).toBe(12);
        expect(r.out).toContain('gate-failures: 7/6');
        expect(r.out).toContain('budget: EXHAUSTED (gate-failures)');
    });

    it('budget_gateFailuresExactlyAtTheLimit_isNotExceeded', () => {
        writeRows(freshRows(6));
        const r = cli(['budget', '--since', since(), '--limits', LINE]);
        expect(r.code).toBe(0);
        expect(r.out).toContain('gate-failures: 6/6');
    });

    it('budget_killedAndPassRows_doNotCountAsGateFailures', () => {
        writeRows([...freshRows(6), killedRow(SIG_A, 'k1'), killedRow(SIG_A, 'k2', 'TIMEOUT'), passRow('p1')]);

        const r = cli(['budget', '--since', since(), '--limits', LINE]);

        expect(r.code).toBe(0);
        expect(r.out).toContain('gate-failures: 6/6');
    });

    it('budget_failureRowsBeforeSince_areNotCounted', () => {
        const old = freshRows(5, { ts: minutesAgo(300).toISOString() });
        writeRows([...old, ...freshRows(2)]);

        const r = cli(['budget', '--since', since(), '--limits', LINE]);

        expect(r.out).toContain('gate-failures: 2/6');
    });

    it('budget_dispatchesOverTheLimit_exitsTwelve', () => {
        attribution([dispatch('S1'), dispatch('S2'), dispatch('S3')]);

        const r = cli(['budget', '--since', since(), '--limits', '**Budget:** dispatches=2']);

        expect(r.code).toBe(12);
        expect(r.out).toContain('dispatches: 3/2');
    });

    it('budget_dispatchesBeforeSince_areNotCounted', () => {
        attribution([dispatch('S1', 300), dispatch('S2', 200), dispatch('S3', 5)]);

        const r = cli(['budget', '--since', since(), '--limits', '**Budget:** dispatches=40']);

        expect(r.out).toContain('dispatches: 1/40');
    });

    it('budget_attemptsIsTheLargestPerStoryDispatchCount', () => {
        attribution([dispatch('S1', 20), dispatch('S1', 15), dispatch('S1', 10), dispatch('S1', 5), dispatch('S2', 5)]);

        const r = cli(['budget', '--since', since(), '--limits', '**Budget:** attempts=3']);

        expect(r.code).toBe(12);
        expect(r.out).toContain('attempts: 4/3');
        expect(r.out).toContain('budget: EXHAUSTED (attempts)');
    });

    it('budget_dispatchesSpreadAcrossStories_keepAttemptsAtTheMaxNotTheSum', () => {
        attribution([dispatch('S1', 20), dispatch('S1', 15), dispatch('S2', 10), dispatch('S2', 5)]);

        const r = cli(['budget', '--since', since(), '--limits', '**Budget:** attempts=3 dispatches=40']);

        expect(r.code).toBe(0);
        expect(r.out).toContain('attempts: 2/3');
        expect(r.out).toContain('dispatches: 4/40');
    });

    it('budget_dispatchesWithoutAStoryId_countAsDispatchesButNotAsAttempts', () => {
        attribution([{ ...dispatch('S1'), story_id: null }, { ...dispatch('S1'), story_id: null }]);

        const r = cli(['budget', '--since', since(), '--limits', '**Budget:** attempts=1 dispatches=40']);

        expect(r.out).toContain('attempts: 0/1');
        expect(r.out).toContain('dispatches: 2/40');
    });

    it('budget_elapsedMinutesOverTheLimit_exitsTwelve', () => {
        const r = cli(['budget', '--since', stamp(minutesAgo(300)), '--limits', LINE]);

        expect(r.code).toBe(12);
        expect(r.out).toMatch(/minutes: (300|301)\/240/);
        expect(r.out).toContain('budget: EXHAUSTED (minutes)');
    });

    it('budget_severalKeysOver_listsThemAll', () => {
        writeRows(freshRows(3));
        attribution([dispatch('S1'), dispatch('S1')]);

        const r = cli(['budget', '--since', since(), '--limits', '**Budget:** attempts=1 gate-failures=2 dispatches=40']);

        expect(r.code).toBe(12);
        expect(r.out).toContain('budget: EXHAUSTED (attempts, gate-failures)');
    });

    it('budget_aKeyAbsentFromTheLimits_isNotPrintedOrEnforced', () => {
        writeRows(freshRows(40));

        const r = cli(['budget', '--since', since(), '--limits', '**Budget:** attempts=3']);

        expect(r.code).toBe(0);
        expect(r.out).not.toContain('gate-failures:');
    });

    it('budget_limitsFromAPlanFile_usesItsBudgetLine', () => {
        const plan = tmp.write('plan.md', ['# Plan', '', 'Some prose with attempts=99 in it.', '', LINE.replace('gate-failures=6', 'gate-failures=1'), '', '- **Red:** none', ''].join('\n'));
        writeRows(freshRows(2));

        const r = cli(['budget', '--since', since(), '--limits', plan]);

        expect(r.code).toBe(12);
        expect(r.out).toContain('gate-failures: 2/1');
    });

    it('budget_corruptLedgerLines_areToleratedAndTheRestCounted', () => {
        writeRows([...freshRows(2), 'not json', '{"half":']);
        const r = cli(['budget', '--since', since(), '--limits', LINE]);
        expect(r.code).toBe(0);
        expect(r.out).toContain('gate-failures: 2/6');
    });

    it('budget_noLedgerAndNoAttribution_printsZerosAndExitsZero', () => {
        const r = cli(['budget', '--since', since(), '--limits', LINE]);
        expect(r.code).toBe(0);
        expect(r.out).toContain('gate-failures: 0/6');
        expect(r.out).toContain('dispatches: 0/40');
    });

    it.each([
        ['an unknown key', ['budget', '--since', '261118-1000', '--limits', '**Budget:** bogus=3']],
        ['a plan file with no Budget line', ['budget', '--since', '261118-1000', '--limits', '__PLAN_WITHOUT_BUDGET__']],
        ['a missing --since', ['budget', '--limits', LINE]],
        ['a malformed --since', ['budget', '--since', 'yesterday', '--limits', LINE]],
        ['a missing --limits', ['budget', '--since', '261118-1000']],
        ['a limits file that does not exist', ['budget', '--since', '261118-1000', '--limits', '/no/such/plan.md']],
    ])('budget_%s_exitsTwo', (_label, args) => {
        const resolved = args.map(a => (a === '__PLAN_WITHOUT_BUDGET__' ? tmp.write('nobudget.md', '# Plan\n\nNothing here.\n') : a));
        const r = cli(resolved);
        expect(r.code).toBe(2);
        expect(r.err.length).toBeGreaterThan(0);
    });

    it('budget_unknownKey_namesTheKeyOnStderr', () => {
        expect(cli(['budget', '--since', '261118-1000', '--limits', '**Budget:** bogus=3']).err).toContain('bogus');
    });
});

// ─── Review-fix regression tests (software-factory wave 1) ───────────────────────

// A gate log shaped like gate.js writes it (section headers, one per leg).
const gateLog = ({ build = '', tests = '', lint = '', visual = '' } = {}) => [
    'Gate started',
    '='.repeat(60),
    '--- Build ---', build,
    '--- Tests ---', tests,
    '--- Lint ---', lint,
    ...(visual ? ['--- Visual ---', visual] : []),
    '='.repeat(60),
    'Overall: FAILED',
].join('\n');

const buildErr = (file, code, message, line = 10) => ({ file, line, column: 5, code, message });

describe('F2 non-test legs get real failure ids', () => {
    const record = (over = {}) => L.recordGateRun({ root, passed: false, head: 'h1', ...over });

    it('F2_twoDifferentBuildFailures_haveDifferentSignatures', () => {
        const a = record({ legs: ['build'], results: { build: { errors: [buildErr('src/a.ts', 'TS2304', "Cannot find name 'x'.")] } } });
        const b = record({ legs: ['build'], head: 'h2', results: { build: { errors: [buildErr('src/a.ts', 'TS2304', "Cannot find name 'x'."), buildErr('src/b.ts', 'TS2322', 'Type string is not assignable.')] } } });
        expect(a.sig).toMatch(/^[0-9a-f]{64}$/);
        expect(b.sig).toMatch(/^[0-9a-f]{64}$/);
        expect(b.sig).not.toBe(a.sig);
        expect(b.count).toBe(1);
    });

    it('F2_sameBuildFailureTwice_withMovedLinesAndColumns_hasTheSameSignatureAndCountsTwice', () => {
        const first = record({ legs: ['build'], results: { build: { errors: [buildErr('src/a.ts', 'TS2304', "Cannot find name 'x'.", 10)] } } });
        const second = record({ legs: ['build'], head: 'h2', results: { build: { errors: [buildErr('src/a.ts', 'TS2304', "Cannot find name 'x'.", 99)] } } });
        expect(second.sig).toBe(first.sig);
        expect(second.count).toBe(2);
    });

    it('F2_threeDifferentBuildFailures_neverBuildAStreak', () => {
        const counts = ['one', 'two', 'three'].map((m, i) => record({ legs: ['build'], head: `h${i}`, results: { build: { errors: [buildErr('src/a.ts', 'TS1', m)] } } }).count);
        expect(counts).toEqual([1, 1, 1]);
    });

    it('F2_lintFailures_differByRuleAndMessage', () => {
        const a = record({ legs: ['lint'], results: { lint: { errors: [buildErr('src/a.js', 'no-unused-vars', "'x' is defined but never used")] } } });
        const b = record({ legs: ['lint'], head: 'h2', results: { lint: { errors: [buildErr('src/a.js', 'eqeqeq', "Expected '===' and instead saw '=='")] } } });
        expect(b.sig).not.toBe(a.sig);
    });

    it('F2_theSameErrorTextInBuildAndLint_isNotTheSameSignature', () => {
        const err = [buildErr('src/a.js', 'X1', 'boom')];
        const a = record({ legs: ['build'], results: { build: { errors: err } } });
        const b = record({ legs: ['lint'], head: 'h2', results: { lint: { errors: err } } });
        expect(b.sig).not.toBe(a.sig);
    });

    it('F2_visualFailures_differByFailureName', () => {
        const a = record({ legs: ['visual'], output: gateLog({ visual: 'no names here' }), results: { visual: { failures: [{ name: 'snap a' }] } } });
        const b = record({ legs: ['visual'], head: 'h2', output: gateLog({ visual: 'no names here' }), results: { visual: { failures: [{ name: 'snap b' }] } } });
        expect(a.sig).toMatch(/^[0-9a-f]{64}$/);
        expect(b.sig).not.toBe(a.sig);
    });

    it('F2_visualFailuresRead_fromTheVisualSectionsRunnerOutput', () => {
        const a = record({ legs: ['visual'], output: gateLog({ visual: ' FAIL  vis.spec.js > home page\nAssertionError: expected 1 to be 2' }), results: { visual: { failures: [] } } });
        const b = record({ legs: ['visual'], head: 'h2', output: gateLog({ visual: ' FAIL  vis.spec.js > about page\nAssertionError: expected 1 to be 2' }), results: { visual: { failures: [] } } });
        expect(b.sig).not.toBe(a.sig);
    });

    it('F2_e2eFailures_differByTestId', () => {
        const e2e = name => `E2E gate started\n${'='.repeat(60)}\n--- E2E ---\n FAIL  e2e/${name}.spec.js > flow\nAssertionError: expected 1 to be 2\n\n${'='.repeat(60)}\nE2E gate completed\n`;
        const a = record({ legs: ['e2e'], output: e2e('login'), results: { e2e: { failures: [] } } });
        const b = record({ legs: ['e2e'], head: 'h2', output: e2e('checkout'), results: { e2e: { failures: [] } } });
        expect(b.sig).not.toBe(a.sig);
    });

    it('F2_aLegThatProducedNothing_keepsTheEmptyColonLegSignature', () => {
        expect(record({ legs: ['build'], results: { build: { errors: [] } } }).sig).toBe('empty:build');
        expect(record({ legs: ['lint'], head: 'h2', results: {} }).sig).toBe('empty:lint');
    });

    it('F2_testIdsComeOnlyFromTheTestsSection_notFromABuildOrLintSection', () => {
        const noise = ' FAIL  build-noise.test.js > not a test failure';
        const withNoise = record({ legs: ['test'], output: gateLog({ build: noise, tests: VITEST_OUT, lint: noise }), results: { test: { failures: [] } } });
        const clean = record({ legs: ['test'], head: 'h2', output: gateLog({ tests: VITEST_OUT }), results: { test: { failures: [] } } });
        expect(withNoise.sig).toBe(clean.sig);
    });

    it('F2_aGateRunAndAFocusedRunOfTheSameFailingTests_shareASignature', () => {
        const gate = record({ legs: ['test'], output: gateLog({ tests: VITEST_OUT }), results: { test: { failures: [] } } });
        const focused = record({ legs: ['test'], head: 'h2', output: VITEST_OUT });
        expect(focused.sig).toBe(gate.sig);
    });

    it('F2_combinedFailedLegs_signatureCoversEveryLeg', () => {
        const buildOnly = record({ legs: ['build'], results: { build: { errors: [buildErr('a.ts', 'T1', 'one')] } } });
        const both = record({ legs: ['build', 'lint'], head: 'h2', results: { build: { errors: [buildErr('a.ts', 'T1', 'one')] }, lint: { errors: [buildErr('a.js', 'R1', 'two')] } } });
        expect(both.sig).not.toBe(buildOnly.sig);
    });
});

describe('F3 environment class reads only the failing material', () => {
    const NOISE = ['stderr | other.test.js > handled error', 'Error: connect ECONNREFUSED handled ok', ''].join('\n');
    const record = (over = {}) => L.recordGateRun({ root, legs: ['test'], passed: false, ...over });

    it('F3_markerOnlyInPassingTestsOutput_assertionFailureStaysGenuineAndEscalates', () => {
        const output = NOISE + VITEST_OUT;
        const counts = ['h1', 'h2', 'h3'].map(head => record({ head, output }).count);
        expect(counts).toEqual([1, 2, 3]);
        expect(rowsOnDisk().every(r => !('cls' in r))).toBe(true);
    });

    it('F3_markerOnlyInPassingOutput_thrownErrorFailureStaysGenuine', () => {
        const output = NOISE + ' FAIL  a.test.js > boom\nTypeError: x is not a function\n';
        const result = record({ head: 'h1', output });
        expect(result.class).toBe('genuine');
        expect('cls' in rowsOnDisk()[0]).toBe(false);
    });

    it('F3_markerInsideTheFailingTestsThrownError_isEnvironment', () => {
        const output = NOISE + ' FAIL  a.test.js > connects\nError: connect ECONNREFUSED 127.0.0.1:5432\n';
        const result = record({ head: 'h1', output });
        expect(rowsOnDisk()[0].cls).toBe('environment');
        expect(result).toMatchObject({ class: 'environment', count: 0 });
    });

    it('F3_markerInsideAnAssertionMessage_isALogicFailureNotEnvironment', () => {
        const output = [' FAIL  a.test.js > mentions it', "AssertionError: expected 'ENOSPC' to be 'ok' // Object.is equality", ''].join('\n');
        const result = record({ head: 'h1', output });
        expect('cls' in rowsOnDisk()[0]).toBe(false);
        expect(result.class).toBe('genuine');
    });

    it('F3_gateLogWithTheMarkerInAPassingBuildSection_failingTestsStayGenuine', () => {
        const output = gateLog({ build: 'warn: retried after ENOSPC (recovered)', tests: VITEST_OUT });
        const result = record({ head: 'h1', output, results: { test: { failures: [] } } });
        expect('cls' in rowsOnDisk()[0]).toBe(false);
        expect(result.class).toBe('genuine');
    });

    it('F3_aBuildErrorNamingTheMarker_isEnvironment', () => {
        record({ legs: ['build'], head: 'h1', results: { build: { errors: [buildErr('', '', 'ENOSPC: no space left on device')] } } });
        expect(rowsOnDisk()[0].cls).toBe('environment');
    });

    it('F3_extractFailures_firstErrorIsReadFromInsideTheFailureBlocksOnly', () => {
        const r = L.extractFailures(NOISE + VITEST_OUT, { root });
        expect(r.firstError).toBeNull();
        const thrown = L.extractFailures(NOISE + ' FAIL  a.test.js > x\nError: real problem\n', { root });
        expect(thrown.firstError).toBe('Error: real problem');
    });
});

describe('F9 flaky compares runs over the same legs', () => {
    it('F9_aLintPassOnTheTree_doesNotMakeATestFailureFlaky', () => {
        const rows = [mkRow(null, 'h1', { passed: true, legs: ['lint'] }), mkRow(SIG_A, 'h1', { legs: ['test'] })];
        expect(L.classify(rows)).toEqual({ class: 'genuine', sig: SIG_A, count: 1 });
    });

    it('F9_aFocusedTestPass_doesNotMakeAFullGateLintFailureFlaky', () => {
        const rows = [mkRow(null, 'h1', { passed: true, legs: ['test'] }), mkRow(SIG_A, 'h1', { legs: ['lint'] })];
        expect(L.classify(rows).class).toBe('genuine');
    });

    it('F9_aFullGatePassCoveringTheFailedLeg_makesTheFailureFlaky', () => {
        const rows = [mkRow(null, 'h1', { passed: true, legs: ['build', 'test', 'lint'] }), mkRow(SIG_A, 'h1', { legs: ['test'] })];
        expect(L.classify(rows)).toEqual({ class: 'flaky', sig: SIG_A, count: 0 });
    });

    it('F9_aPassThatMissedOneOfTheFailedLegs_isNotEnough', () => {
        const rows = [mkRow(null, 'h1', { passed: true, legs: ['test'] }), mkRow(SIG_A, 'h1', { legs: ['test', 'lint'] })];
        expect(L.classify(rows).class).toBe('genuine');
    });

    it('F9_twoDifferentSignaturesOnOneTreeWithNoPass_areTwoFailuresNotFlaky', () => {
        const rows = [mkRow(SIG_A, 'h1'), mkRow(SIG_B, 'h1')];
        expect(L.classify(rows)).toEqual({ class: 'genuine', sig: SIG_B, count: 1 });
    });
});

describe('F9 legsCover is exported so a second reader applies the same flaky rule', () => {
    it.each([
        ['every failed leg ran in the pass', ['build', 'test', 'lint'], ['test'], true],
        ['a failed leg the pass did not run', ['lint'], ['test'], false],
        ['one of two failed legs missing from the pass', ['test'], ['test', 'lint'], false],
        ['a pass row with no legs recorded', [], ['test'], true],
        ['a failure row with no legs recorded', ['lint'], [], true],
        ['legs absent (not arrays)', undefined, null, true],
    ])('F9_legsCover_%s', (_name, passLegs, failLegs, expected) => {
        expect(L.legsCover(passLegs, failLegs)).toBe(expected);
    });
});

describe('F10 currentHead uses the shared code-tree definition', () => {
    const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
    const put = (repo, rel, text) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), text);
    };
    let repo;
    beforeEach(() => {
        repo = tmp.mkdir('repo');
        git(['init', '-q'], repo);
        put(repo, 'a.txt', 'one\n');
        put(repo, 'docs/TODO_x.md', '# todo\n');
        git(['add', '.'], repo);
        git(['commit', '-q', '-m', 'init'], repo);
    });

    it.each([
        ['a plan under docs/.output/plans', 'docs/.output/plans/plan.md'],
        ['a handoff under docs/.output/handoffs', 'docs/.output/handoffs/2026-11/h.md'],
        ['a memory note under docs/.output/.memory', 'docs/.output/.memory/notes/n.md'],
        ['a file under docs/work', 'docs/work/todo/t.md'],
    ])('F10_%s_doesNotChangeIt', (_label, rel) => {
        const clean = L.currentHead(repo);
        put(repo, rel, 'new text\n');
        expect(L.currentHead(repo)).toBe(clean);
    });

    it('F10_appendingToATopLevelTodoDocument_doesNotChangeIt', () => {
        const clean = L.currentHead(repo);
        fs.appendFileSync(path.join(repo, 'docs', 'TODO_x.md'), '- [x] done\n');
        expect(L.currentHead(repo)).toBe(clean);
    });

    it('F10_aCodeEditOrADocsFileOutsideTheExcludedPaths_changesIt', () => {
        const clean = L.currentHead(repo);
        put(repo, 'docs/guide.md', 'guide\n');
        const withDoc = L.currentHead(repo);
        expect(withDoc).not.toBe(clean);
        put(repo, 'a.txt', 'two\n');
        expect(L.currentHead(repo)).not.toBe(withDoc);
    });

    it('F10_theIdentityCarriesTheSharedCodeTreeHash', () => {
        const { codeTreeHash } = require('../gate-receipt.js');
        const result = codeTreeHash(repo);
        expect(result.ok).toBe(true);
        expect(L.currentHead(repo).endsWith(`+${result.hash.slice(0, 16)}`)).toBe(true);
    });

    it('F10_aProjectRootBelowTheRepositoryRoot_appliesTheSameExclusions', () => {
        const sub = path.join(repo, 'sub');
        put(repo, 'sub/code.js', 'a\n');
        git(['add', '.'], repo);
        git(['commit', '-q', '-m', 'sub'], repo);
        const clean = L.currentHead(sub);
        expect(typeof clean).toBe('string');

        put(repo, 'sub/docs/.output/plans/p.md', 'x\n');
        put(repo, 'sub/docs/work/w.md', 'x\n');
        put(repo, 'sub/docs/TODO_y.md', 'x\n');
        expect(L.currentHead(sub)).toBe(clean);

        put(repo, 'sub/code.js', 'b\n');
        expect(L.currentHead(sub)).not.toBe(clean);
    });
});

describe('F11 CLI record has a neutral path for a killed or timed-out run', () => {
    const outFile = (name, text) => tmp.write(`out/${name}`, text);
    const failing = (head) => cli(['record', '--leg', 'test', '--exit', '1', '--output-file', outFile('f.log', VITEST_OUT), '--head', head]);

    it('F11_killed_recordsANeutralRowWithTheSignalAndLeavesTheStreak', () => {
        failing('h1');
        failing('h2');

        const r = cli(['record', '--leg', 'test', '--exit', '137', '--killed', 'SIGKILL', '--head', 'h3']);

        expect(r.code).toBe(0);
        expect(rowsOnDisk()[2]).toMatchObject({ legs: ['test'], passed: false, killed: 'SIGKILL', head: 'h3', sig: null });
        expect(r.out).toContain('neutral');
        expect(cli(['streak']).out.trim()).toBe('2');
        expect(failing('h4').out).toMatch(/seen 3 times in a row/);
    });

    it('F11_timedOut_recordsATimeoutRowAndIsNeutral', () => {
        failing('h1');

        const r = cli(['record', '--leg', 'test', '--exit', '124', '--timed-out', '--head', 'h2']);

        expect(r.code).toBe(0);
        expect(rowsOnDisk()[1]).toMatchObject({ passed: false, killed: 'TIMEOUT' });
        expect(cli(['streak']).out.trim()).toBe('1');
    });

    it('F11_timedOutWithAnOutputFile_storesTheLogWithoutReadingIt', () => {
        const file = outFile('partial.log', 'partial output\n');
        cli(['record', '--leg', 'test', '--exit', '124', '--timed-out', '--output-file', file, '--head', 'h1']);
        expect(rowsOnDisk()[0]).toMatchObject({ killed: 'TIMEOUT', log: file });
    });

    it('F11_exitZeroWithKilled_isStillAPass', () => {
        cli(['record', '--leg', 'test', '--exit', '0', '--killed', 'SIGKILL', '--head', 'h1']);
        expect(rowsOnDisk()[0]).toMatchObject({ passed: true, killed: null });
    });

    it('F11_usageText_documentsBothFlags', () => {
        const r = cli(['frobnicate']);
        expect(r.err).toContain('--killed');
        expect(r.err).toContain('--timed-out');
    });
});

describe('m4 reads never block on a special file and are size-capped', () => {
    const isWin = process.platform === 'win32';
    const mkfifo = file => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const res = spawnSync('mkfifo', [file]);
        if (res.status !== 0) throw new Error(`mkfifo failed: ${res.stderr}`);
    };
    // Runs `code` in a child with a hard timeout: a blocking read shows as a null status, not a hung worker.
    const child = (code, args = []) => spawnSync(process.execPath, ['-e', code, LIB, root, ...args], { encoding: 'utf8', timeout: 8000, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

    it.skipIf(isWin)('m4_ledgerReplacedByAFifo_readLedgerReturnsEmptyWithoutBlocking', () => {
        mkfifo(ledgerFile());
        const res = child('process.stdout.write(JSON.stringify(require(process.argv[1]).readLedger({ root: process.argv[2] })))');
        expect(res.status).toBe(0);
        expect(res.stdout).toBe('[]');
    });

    it.skipIf(isWin)('m4_ledgerReplacedByAFifo_tailReadAlsoReturnsEmpty', () => {
        mkfifo(ledgerFile());
        const res = child('process.stdout.write(JSON.stringify(require(process.argv[1]).readLedger({ root: process.argv[2], tailBytes: 1024 })))');
        expect(res.status).toBe(0);
        expect(res.stdout).toBe('[]');
    });

    it.skipIf(isWin)('m4_aRowLogThatIsAFifo_lastPromptStillAnswers', () => {
        const fifo = path.join(root, 'out', 'row.fifo');
        mkfifo(fifo);
        writeRows([mkRow(SIG_A, 'h1', { log: fifo })]);
        const res = child('process.stdout.write(require(process.argv[1]).lastPrompt({ root: process.argv[2] }))');
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('failure signature');
        expect(res.stdout).toContain('none parsed');
    });

    it.skipIf(isWin)('m4_outputFileThatIsAFifo_isRefusedWithExitTwo', () => {
        const fifo = path.join(root, 'out', 'out.fifo');
        mkfifo(fifo);
        const res = spawnSync(process.execPath, [LIB, 'record', '--leg', 'test', '--exit', '1', '--output-file', fifo], { encoding: 'utf8', timeout: 8000, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
        expect(res.status).toBe(2);
        expect(res.stderr).toContain('not a regular file');
        expect(fs.existsSync(ledgerFile())).toBe(false);
    });

    it.skipIf(isWin)('m4_outputFileDevZero_isRefusedInsteadOfReadingWithoutBound', () => {
        const res = spawnSync(process.execPath, [LIB, 'record', '--leg', 'test', '--exit', '1', '--output-file', '/dev/zero'], { encoding: 'utf8', timeout: 8000, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
        expect(res.status).toBe(2);
    });

    it('m4_outputFileLargerThanTheCap_isReadOnlyUpToTheCap', () => {
        const base = tmp.write('out/base.log', VITEST_OUT);
        const huge = tmp.write('out/huge.log', `${VITEST_OUT}${' '.repeat(5 * 1024 * 1024)}\n FAIL  late.test.js > beyond the cap\n`);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', base, '--head', 'h1']);
        cli(['record', '--leg', 'test', '--exit', '1', '--output-file', huge, '--head', 'h2']);
        const rows = rowsOnDisk();
        expect(rows[1].sig).toBe(rows[0].sig);
    });
});

describe('m5 --output-file is stored absolute', () => {
    it('m5_relativeOutputFile_isStoredAsAnAbsolutePathAndLastPromptWorksFromElsewhere', () => {
        tmp.write('out/rel.log', VITEST_OUT);
        const rec = spawnSync(process.execPath, [LIB, 'record', '--leg', 'test', '--exit', '1', '--output-file', path.join('out', 'rel.log'), '--head', 'h1'], {
            cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        });
        expect(rec.status).toBe(0);
        expect(rowsOnDisk()[0].log).toBe(path.resolve(root, 'out', 'rel.log'));

        const elsewhere = tmp.mkdir('elsewhere');
        const last = spawnSync(process.execPath, [LIB, 'last', '--format', 'prompt'], { cwd: elsewhere, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
        expect(last.stdout).toContain('expected 3 | saw 2 | src/a.test.js:2');
    });

    it('m5_aRelativeLogInAnOlderRow_isResolvedAgainstTheProjectRoot', () => {
        tmp.write('out/old.log', VITEST_OUT);
        writeRows([mkRow(SIG_A, 'h1', { log: path.join('out', 'old.log') })]);
        expect(L.lastPrompt({ root })).toContain('expected 3 | saw 2 | src/a.test.js:2');
    });
});

describe('n8 --limits is bounded and a literal budget line is never a file name', () => {
    const LINE = '**Budget:** attempts=3';
    const cliIn = (cwd, args) => {
        const res = spawnSync(process.execPath, [LIB, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
        return { code: res.status, out: res.stdout, err: res.stderr };
    };

    it('n8_budgetLineFarBeyondTheReadCap_isNotFound', () => {
        const plan = tmp.write('big-late.md', `# Plan\n${'x'.repeat(5 * 1024 * 1024)}\n${LINE}\n`);
        const r = cli(['budget', '--since', stamp(minutesAgo(5)), '--limits', plan]);
        expect(r.code).toBe(2);
        expect(r.err).toContain('no **Budget:** line');
    });

    it('n8_budgetLineAtTheTopOfALargePlan_isFound', () => {
        const plan = tmp.write('big-early.md', `# Plan\n${LINE}\n${'x'.repeat(5 * 1024 * 1024)}\n`);
        const r = cli(['budget', '--since', stamp(minutesAgo(5)), '--limits', plan]);
        expect(r.code).toBe(0);
        expect(r.out).toContain('attempts: 0/3');
    });

    it.skipIf(process.platform === 'win32')('n8_aLiteralBudgetLine_isNotReadAsAFileEvenWhenAFileHasThatName', () => {
        const cwd = tmp.mkdir('cwd');
        fs.writeFileSync(path.join(cwd, '**Budget:** attempts=1'), '# plan\n**Budget:** attempts=99\n');
        const r = cliIn(cwd, ['budget', '--since', stamp(minutesAgo(5)), '--limits', '**Budget:** attempts=1']);
        expect(r.out).toContain('attempts: 0/1');
        expect(r.out).not.toContain('attempts: 0/99');
    });
});

describe('F13 module header documents the row fields', () => {
    it('F13_headerNamesTheOptionalClsAndLogFieldsAndTheKilledValues', () => {
        const header = fs.readFileSync(LIB, 'utf8').split("'use strict';")[0];
        expect(header).toMatch(/`cls`/);
        expect(header).toMatch(/`log`/);
        expect(header).toMatch(/killed {2}null, or a string/);
        expect(header).toMatch(/opaque working-tree identity/);
    });
});

// NOT COVERED: behavior of `record` / `budget` when two CLI processes append concurrently (appendJsonl's
// per-process line cache makes rotation approximate across processes by design).
// NOT COVERED: currentHead on Windows path/line-ending variants (these tests run where git is available).
