// AC→source map (TDD-5.5 / damage-control):
//   - processEvent: exported named function; returns null on success, feedback object on failure
//   - classifyError: extracted from inline run() logic; returns { failed, reason, errorBlock, pattern }
//     - reason: "Command was interrupted" | `Exit code ${exitCode}`
//     - errorBlock: first 15 lines of stderr + overflow note
//     - failed: interrupted || (exitCode !== 0 && exitCode !== null && exitCode !== undefined)
//     - pattern: 'permission' (EACCES) | 'divergence' (non-fast-forward) |
//                'missing_module' (Cannot find module) | null (no match)
//
// Note: classifyError did NOT exist in source. It is extracted from run().
//   The pattern field is NEW — added during this refactor per AC Reconciliation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const { processEvent, classifyError, isTestCommand } = require('../../../.agents/hooks/damage-control.cjs');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir.js');
const HOOK_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'damage-control.cjs');

// ─── classifyError ────────────────────────────────────────────────────────────

describe('damage-control', () => {
    describe('classifyError', () => {
        it('classifyError_isExported', () => {
            expect(typeof classifyError).toBe('function');
        });

        it('classifyError_success_returnsFailedFalse', () => {
            const result = classifyError('ls', 0, '', false);
            expect(result.failed).toBe(false);
        });

        it('classifyError_nonZeroExitCode_returnsFailedTrue', () => {
            const result = classifyError('npm install', 1, '', false);
            expect(result.failed).toBe(true);
        });

        it('classifyError_interrupted_returnsFailedTrue', () => {
            const result = classifyError('sleep 10', 0, '', true);
            expect(result.failed).toBe(true);
        });

        it('classifyError_interrupted_reasonIsInterrupted', () => {
            const result = classifyError('sleep 10', 0, '', true);
            expect(result.reason).toBe('Command was interrupted');
        });

        it('classifyError_nonZeroExit_reasonContainsExitCode', () => {
            const result = classifyError('node app.js', 2, '', false);
            expect(result.reason).toBe('Exit code 2');
        });

        it('classifyError_nullExitCode_returnsFailedFalse', () => {
            // null exit code without interrupted → not a failure
            const result = classifyError('ls', null, '', false);
            expect(result.failed).toBe(false);
        });

        it('classifyError_undefinedExitCode_returnsFailedFalse', () => {
            const result = classifyError('ls', undefined, '', false);
            expect(result.failed).toBe(false);
        });

        it('classifyError_stderrUnder15Lines_noOverflow', () => {
            const stderr = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');
            const result = classifyError('cmd', 1, stderr, false);
            expect(result.errorBlock).not.toMatch(/more lines/);
            expect(result.errorBlock).toContain('line 1');
        });

        it('classifyError_stderrOver15Lines_includesOverflowNote', () => {
            const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
            const stderr = lines.join('\n');
            const result = classifyError('cmd', 1, stderr, false);
            expect(result.errorBlock).toMatch(/more lines/);
            // Only first 15 lines in block
            expect(result.errorBlock).toContain('line 15');
            expect(result.errorBlock).not.toContain('line 16');
        });

        // ─── Pattern classification ───────────────────────────────────────────

        it('classifyError_EACCES_returnsPermissionPattern', () => {
            const result = classifyError('npm install', 1, 'npm error EACCES: permission denied', false);
            expect(result.failed).toBe(true);
            expect(result.pattern).toBe('permission');
        });

        it('classifyError_nonFastForward_returnsDivergence', () => {
            const result = classifyError('git push', 1, 'error: failed to push some refs (non-fast-forward)', false);
            expect(result.pattern).toBe('divergence');
        });

        it('classifyError_CannotFindModule_returnsMissingModule', () => {
            const result = classifyError('node app.js', 1, "Error: Cannot find module 'express'", false);
            expect(result.pattern).toBe('missing_module');
        });

        it('classifyError_unknownError_patternIsNull', () => {
            const result = classifyError('cmd', 1, 'some unrecognized error output', false);
            expect(result.pattern).toBeNull();
        });

        it('classifyError_emptyStderr_patternIsNull', () => {
            const result = classifyError('cmd', 1, '', false);
            expect(result.pattern).toBeNull();
        });
    });

    // ─── processEvent ──────────────────────────────────────────────────────────

    describe('processEvent', () => {
        it('processEvent_isExported', () => {
            expect(typeof processEvent).toBe('function');
        });

        it('processEvent_successCommand_returnsNull', () => {
            const result = processEvent({
                tool_input: { command: 'ls' },
                tool_response: { exit_code: 0, error: '' }
            });
            expect(result).toBeNull();
        });

        it('processEvent_nonZeroExit_returnsFeedbackObject', () => {
            const result = processEvent({
                tool_input: { command: 'npm install' },
                tool_response: { exit_code: 1, error: 'npm error EACCES: permission denied' }
            });
            expect(result).not.toBeNull();
            expect(typeof result.feedback).toBe('string');
        });

        it('processEvent_nonZeroExit_feedbackContainsDamageControl', () => {
            const result = processEvent({
                tool_input: { command: 'npm install' },
                tool_response: { exit_code: 1, error: 'something went wrong' }
            });
            expect(result.feedback).toMatch(/DAMAGE CONTROL/);
        });

        it('processEvent_nonZeroExit_feedbackContainsCommand', () => {
            const result = processEvent({
                tool_input: { command: 'npm install' },
                tool_response: { exit_code: 1, error: 'something went wrong' }
            });
            expect(result.feedback).toContain('npm install');
        });

        it('processEvent_interrupted_returnsFeedbackObject', () => {
            const result = processEvent({
                tool_input: { command: 'sleep 100' },
                tool_response: { exit_code: 0, interrupted: true, error: '' }
            });
            expect(result).not.toBeNull();
            expect(result.feedback).toMatch(/interrupted/i);
        });

        it('processEvent_missingToolInput_returnsNull', () => {
            // No command means nothing to classify
            const result = processEvent({
                tool_input: {},
                tool_response: { exit_code: 0, error: '' }
            });
            expect(result).toBeNull();
        });
    });
});

// ─── SF-1.5: ledger-backed repeat-failure text ───────────────────────────────────
//
// Contract: when a FAILED Bash command contains `gate.js`, `run-toolkit-tests`, `vitest`, `jest`,
// `pytest`, `dotnet test` or `npm test`, the static "2nd+ failure" line of the REQUIRED BEFORE RETRYING
// block is replaced by text read from the failure ledger
// (docs/.output/.state/telemetry/gate-failures.jsonl under the project root, which is
// `processEvent(event, { root })` or, by default, the usual project-root resolution / CLAUDE_PROJECT_DIR):
//   - every readable state with a failure signature starts with
//       `failure signature <sig.slice(0,12)> seen <N> times in a row`
//   - N = 2 (genuine repeat on a changed tree):  contains `CHANGE STRATEGY` and `one escalation`
//   - N >= 3:                                     contains `STOP AND ASK`
//   - N = 1:                                      neither of the two
//   - class flaky / environment (never counted):  names the class word, neither of the two
//   - no ledger / no rows / newest row a pass / unreadable ledger: the static line stays (fail safe)
// Non-test commands keep today's text exactly and never consult the ledger. The hook is read-only
// (it never writes the ledger) and always exits 0.
describe('damage-control ledger-backed repeat-failure text (SF-1.5)', () => {
    const STATIC_LINE = '4. If this is the 2nd+ failure on the same problem: STOP and surface to user';
    const SIG_A = 'abcdef012345' + 'a'.repeat(52);
    const SIG_B = '0123456789ab' + 'b'.repeat(52);
    const row = (sig, head, extra = {}) => ({ ts: new Date().toISOString(), head, sig, legs: ['test'], passed: false, killed: null, ...extra });
    const passRow = head => row(null, head, { passed: true, legs: [] });

    let tmp;
    let root;
    beforeEach(() => { tmp = createTmpDir({ prefix: 'damage-control-ledger-' }); root = tmp.root; });
    afterEach(() => tmp.cleanup());

    const ledgerPath = () => path.join(root, 'docs', '.output', '.state', 'telemetry', 'gate-failures.jsonl');
    const writeLedger = (lines) => {
        fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
        fs.writeFileSync(ledgerPath(), lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    };
    const failed = (command, error = 'boom') => ({ tool_input: { command }, tool_response: { exit_code: 1, error } });
    const feedbackFor = (command, rootOverride = root) => processEvent(failed(command), { root: rootOverride }).feedback;

    const TEST_COMMANDS = [
        ['gate.js', 'node .claude/core/gate.js test'],
        ['run-toolkit-tests', 'node tools/run-toolkit-tests.cjs focused a.test.js'],
        ['vitest', 'npx vitest run src/a.test.js'],
        ['jest', 'npx jest --ci'],
        ['pytest', 'python -m pytest -x tests/'],
        ['dotnet test', 'dotnet test --no-build'],
        ['npm test', 'npm test'],
    ];
    const NON_TEST_COMMANDS = ['ls -la', 'git push origin main', 'npm install', 'dotnet build', 'npm run build', 'node app.js'];

    describe('the second identical signature', () => {
        beforeEach(() => writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2')]));

        it.each(TEST_COMMANDS)('processEvent_%s_secondIdenticalSignature_saysChangeStrategyWithOneEscalation', (_name, command) => {
            const text = feedbackFor(command);

            expect(text).toContain('failure signature abcdef012345 seen 2 times in a row');
            expect(text).toContain('CHANGE STRATEGY');
            expect(text).toContain('one escalation');
            expect(text).not.toContain('STOP AND ASK');
            expect(text).not.toContain('2nd+ failure');
        });

        it('processEvent_secondIdenticalSignature_keepsTheRestOfTheDamageControlBlock', () => {
            const text = feedbackFor('npm test');

            expect(text).toContain('DAMAGE CONTROL');
            expect(text).toContain('Command : npm test');
            expect(text).toContain('Failure : Exit code 1');
            expect(text).toContain('REQUIRED BEFORE RETRYING');
            expect(text).toContain('1. Read the error above fully');
            expect(text).toContain('3. Propose ONE targeted fix');
        });
    });

    describe('the third identical signature', () => {
        beforeEach(() => writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2'), row(SIG_A, 'h3')]));

        it.each(TEST_COMMANDS)('processEvent_%s_thirdIdenticalSignature_saysStopAndAsk', (_name, command) => {
            const text = feedbackFor(command);

            expect(text).toContain('failure signature abcdef012345 seen 3 times in a row');
            expect(text).toContain('STOP AND ASK');
            expect(text).not.toContain('CHANGE STRATEGY');
            expect(text).not.toContain('2nd+ failure');
        });
    });

    it('processEvent_firstOccurrence_namesTheSignatureWithoutEscalating', () => {
        writeLedger([row(SIG_A, 'h1')]);

        const text = feedbackFor('npx vitest run');

        expect(text).toContain('failure signature abcdef012345 seen 1 times in a row');
        expect(text).not.toContain('CHANGE STRATEGY');
        expect(text).not.toContain('STOP AND ASK');
        expect(text).not.toContain('2nd+ failure');
    });

    it('processEvent_aPassBetweenFailures_resetsTheCountToOne', () => {
        writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2'), passRow('h3'), row(SIG_A, 'h4')]);

        const text = feedbackFor('npm test');

        expect(text).toContain('seen 1 times in a row');
        expect(text).not.toContain('STOP AND ASK');
    });

    it('processEvent_aDifferentSignatureAfterRepeats_startsAtOne', () => {
        writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2'), row(SIG_B, 'h3')]);

        const text = feedbackFor('npm test');

        expect(text).toContain('failure signature 0123456789ab seen 1 times in a row');
        expect(text).not.toContain('CHANGE STRATEGY');
    });

    it('processEvent_sameSignatureOnTheSameTree_doesNotEscalate', () => {
        writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h1')]);

        const text = feedbackFor('npm test');

        expect(text).toContain('seen 1 times in a row');
        expect(text).not.toContain('CHANGE STRATEGY');
    });

    it('processEvent_killedRowsBetweenRepeats_areNeutral', () => {
        writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2', { killed: 'TIMEOUT' }), row(SIG_A, 'h3')]);

        const text = feedbackFor('npm test');

        expect(text).toContain('seen 2 times in a row');
        expect(text).toContain('CHANGE STRATEGY');
    });

    it('processEvent_flakyFailure_namesTheClassAndNeverEscalates', () => {
        writeLedger([row(SIG_A, 'h1'), passRow('h1'), row(SIG_A, 'h1')]);

        const text = feedbackFor('npm test');

        expect(text).toMatch(/flaky/i);
        expect(text).not.toContain('CHANGE STRATEGY');
        expect(text).not.toContain('STOP AND ASK');
        expect(text).not.toContain('2nd+ failure');
    });

    it('processEvent_environmentFailure_namesTheClassAndNeverEscalates', () => {
        writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2'), row(SIG_A, 'h3', { cls: 'environment' })]);

        const text = feedbackFor('npm test');

        expect(text).toMatch(/environment/i);
        expect(text).not.toContain('CHANGE STRATEGY');
        expect(text).not.toContain('STOP AND ASK');
        expect(text).not.toContain('2nd+ failure');
    });

    it('processEvent_corruptLedgerLinesBetweenRows_areSkipped', () => {
        writeLedger([row(SIG_A, 'h1'), 'not json at all', '{"half": ', row(SIG_A, 'h2')]);

        const text = feedbackFor('npm test');

        expect(text).toContain('seen 2 times in a row');
        expect(text).toContain('CHANGE STRATEGY');
    });

    describe('fail-safe: no usable ledger information keeps the static line', () => {
        it('processEvent_noLedgerFile_keepsTheStaticLine', () => {
            expect(feedbackFor('npm test')).toContain(STATIC_LINE);
        });

        it('processEvent_ledgerWithNoRows_keepsTheStaticLine', () => {
            fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
            fs.writeFileSync(ledgerPath(), '');
            expect(feedbackFor('npm test')).toContain(STATIC_LINE);
        });

        it('processEvent_newestRowIsAPass_keepsTheStaticLine', () => {
            writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2'), passRow('h3')]);
            const text = feedbackFor('npm test');
            expect(text).toContain(STATIC_LINE);
            expect(text).not.toContain('STOP AND ASK');
        });

        it('processEvent_ledgerPathIsADirectory_keepsTheStaticLineAndStillReturnsFeedback', () => {
            fs.mkdirSync(ledgerPath(), { recursive: true });
            const result = processEvent(failed('npm test'), { root });
            expect(result).not.toBeNull();
            expect(result.feedback).toContain(STATIC_LINE);
        });
    });

    describe('commands that are not test runs keep today\'s behavior', () => {
        it.each(NON_TEST_COMMANDS)('processEvent_nonTestCommand_%s_keepsTheStaticLineEvenWithARepeatedLedger', (command) => {
            writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2'), row(SIG_A, 'h3')]);

            const text = feedbackFor(command);

            expect(text).toContain(STATIC_LINE);
            expect(text).not.toContain('STOP AND ASK');
            expect(text).not.toContain('CHANGE STRATEGY');
            expect(text).not.toContain('failure signature');
        });

        it('processEvent_nonTestCommand_feedbackIsIdenticalWithAndWithoutALedger', () => {
            const emptyRoot = createTmpDir({ prefix: 'damage-control-empty-' });
            try {
                writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2')]);
                expect(feedbackFor('git push origin main')).toBe(feedbackFor('git push origin main', emptyRoot.root));
            } finally {
                emptyRoot.cleanup();
            }
        });

        it('processEvent_successfulTestCommand_stillReturnsNull', () => {
            writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2')]);
            expect(processEvent({ tool_input: { command: 'npm test' }, tool_response: { exit_code: 0, error: '' } }, { root })).toBeNull();
        });
    });

    it('processEvent_aTestCommandFailure_neverWritesTheLedger', () => {
        writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2')]);
        const before = fs.readFileSync(ledgerPath(), 'utf8');

        feedbackFor('npm test');

        expect(fs.readFileSync(ledgerPath(), 'utf8')).toBe(before);
    });

    describe('as a hook process', () => {
        const runHook = (payload, env = {}) => spawnSync(process.execPath, [HOOK_PATH], {
            input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
        });

        it('hook_thirdIdenticalSignatureOnATestCommand_printsStopAndAskAndExitsZero', () => {
            writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2'), row(SIG_A, 'h3')]);

            const result = runHook(failed('node .claude/core/gate.js test'));

            expect(result.status).toBe(0);
            const out = JSON.parse(result.stdout.trim().split('\n').pop());
            expect(out.feedback).toContain('STOP AND ASK');
            expect(out.feedback).not.toContain('2nd+ failure');
        });

        it('hook_secondIdenticalSignature_readsTheLedgerFromTheEnvironmentProjectRoot', () => {
            writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2')]);

            const result = runHook(failed('python -m pytest'));

            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout.trim().split('\n').pop()).feedback).toContain('CHANGE STRATEGY');
        });

        it('hook_unreadableLedger_stillExitsZeroWithTheStaticLine', () => {
            fs.mkdirSync(ledgerPath(), { recursive: true });

            const result = runHook(failed('npm test'));

            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout.trim().split('\n').pop()).feedback).toContain(STATIC_LINE);
        });

        it('hook_nonTestCommandWithARepeatedLedger_keepsTheStaticLineAndExitsZero', () => {
            writeLedger([row(SIG_A, 'h1'), row(SIG_A, 'h2'), row(SIG_A, 'h3')]);

            const result = runHook(failed('git push'));

            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout.trim().split('\n').pop()).feedback).toContain(STATIC_LINE);
        });
    });
});

// ─── Review-fix regression tests (software-factory wave 1) ───────────────────────
//
// F5: the ledger text may only describe a failure the hook has actually just seen: a command that
// RUNS the gate or a test runner, a recent newest row, and (when known) the row's own tree.
describe('F5 damage-control uses ledger text only for a recent, matching, runner-started failure', () => {
    const STATIC_LINE = '4. If this is the 2nd+ failure on the same problem: STOP and surface to user';
    const SIG_A = 'abcdef012345' + 'a'.repeat(52);
    const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString();
    const row = (head, extra = {}) => ({ ts: new Date().toISOString(), head, sig: SIG_A, legs: ['test'], passed: false, killed: null, ...extra });

    let tmp;
    let root;
    beforeEach(() => { tmp = createTmpDir({ prefix: 'damage-control-f5-' }); root = tmp.root; });
    afterEach(() => tmp.cleanup());

    const ledgerPath = () => path.join(root, 'docs', '.output', '.state', 'telemetry', 'gate-failures.jsonl');
    const writeLedger = rows => {
        fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
        fs.writeFileSync(ledgerPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    };
    const feedbackFor = command => processEvent({ tool_input: { command }, tool_response: { exit_code: 1, error: 'boom' } }, { root }).feedback;
    const threeRows = (extra = {}) => [row('h1', extra), row('h2', extra), row('h3', extra)];

    it('F5_threeOctoberRowsAndAnUnrelatedFailingTestRun_keepTheStaticLine', () => {
        writeLedger(threeRows({ ts: '2026-10-01T10:00:00.000Z' }));

        const text = feedbackFor('npx vitest run unrelated.test.js');

        expect(text).toContain(STATIC_LINE);
        expect(text).not.toContain('STOP AND ASK');
        expect(text).not.toContain('failure signature');
    });

    it('F5_newestRowJustPastTheWindow_keepsTheStaticLine_andJustInsideItUsesTheLedger', () => {
        writeLedger(threeRows({ ts: hoursAgo(3) }));
        expect(feedbackFor('npm test')).toContain(STATIC_LINE);

        writeLedger(threeRows({ ts: hoursAgo(1) }));
        expect(feedbackFor('npm test')).toContain('STOP AND ASK');
    });

    it('F5_aFreshKilledRowAfterOldFailures_doesNotRefreshTheOldFailures', () => {
        writeLedger([...threeRows({ ts: hoursAgo(30) }), row('h4', { killed: 'TIMEOUT' })]);

        expect(feedbackFor('npm test')).toContain(STATIC_LINE);
    });

    it.each([
        'grep -n foo .agents/core/gate.js',
        'cat vitest.config.js',
        'git log --oneline -- tools/run-toolkit-tests.cjs',
        'echo npm test',
        'node scripts/other.js gate.js',
        'ls docs/ | grep jest',
    ])('F5_aCommandThatOnlyMentionsARunner_%s_keepsTheStaticLine', command => {
        writeLedger(threeRows());

        const text = feedbackFor(command);

        expect(text).toContain(STATIC_LINE);
        expect(text).not.toContain('STOP AND ASK');
        expect(text).not.toContain('failure signature');
    });

    it.each([
        'node .claude/core/gate.js test',
        'node .codex/core/gate.js full test',
        'node "C:\\work\\.claude\\core\\gate.js" test',
        'cd /repo && node .claude/core/gate.js test',
        'FORCE_COLOR=0 npx vitest run a.test.js',
        'timeout 600 node tools/run-toolkit-tests.cjs focused a.test.js',
        'python3 -m pytest -x tests/',
        'npm run test',
        'dotnet test --no-build 2>&1 | tail -20',
    ])('F5_aCommandThatRunsTheGateOrARunner_%s_usesTheLedger', command => {
        writeLedger(threeRows());

        expect(feedbackFor(command)).toContain('STOP AND ASK');
    });

    it('F5_isTestCommand_isExportedAndRejectsNonStrings', () => {
        expect(isTestCommand('node .claude/core/gate.js test')).toBe(true);
        expect(isTestCommand('ls')).toBe(false);
        expect(isTestCommand(undefined)).toBe(false);
        expect(isTestCommand(42)).toBe(false);
    });

    it('F5_theStatusLineIsInsideTheNumberedList_followedByItsAdvice', () => {
        writeLedger([row('h1'), row('h2')]);

        const lines = feedbackFor('npm test').split('\n');
        const status = lines.findIndex(l => l.includes('failure signature abcdef012345 seen 2 times in a row'));

        expect(lines[status]).toMatch(/^4\. /);
        expect(lines[status + 1]).toMatch(/^5\. CHANGE STRATEGY/);
        expect(lines.findIndex(l => l.startsWith('3. Propose ONE targeted fix'))).toBe(status - 1);
    });

    describe('in a git work tree the newest row must be for the tree as it is now', () => {
        const git = args => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
        beforeEach(() => {
            git(['init', '-q']);
            fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
            git(['add', 'a.txt']);
            git(['commit', '-q', '-m', 'init']);
        });
        const currentHead = () => require('../../core/_lib/failure-ledger.js').currentHead(root);

        it('F5_rowsForThisTree_useTheLedger', () => {
            const head = currentHead();
            expect(typeof head).toBe('string');
            // Three genuine repeats need three distinct heads; only the newest row's head is compared.
            writeLedger([row('x1'), row('x2'), row(head)]);

            expect(feedbackFor('npm test')).toContain('STOP AND ASK');
        });

        it('F5_aNewestRowForADifferentTree_keepsTheStaticLine', () => {
            writeLedger(threeRows());

            const text = feedbackFor('npm test');

            expect(text).toContain(STATIC_LINE);
            expect(text).not.toContain('failure signature');
        });

        it('F5_afterAnEditSinceTheRecordedFailure_keepsTheStaticLine', () => {
            const head = currentHead();
            writeLedger([row('x1'), row('x2'), row(head)]);
            fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');

            expect(feedbackFor('npm test')).toContain(STATIC_LINE);
        });

        it('F5_editingAPlanUnderDocsOutputSinceTheFailure_doesNotMakeItStale', () => {
            const head = currentHead();
            writeLedger([row('x1'), row('x2'), row(head)]);
            fs.mkdirSync(path.join(root, 'docs', '.output', 'plans'), { recursive: true });
            fs.writeFileSync(path.join(root, 'docs', '.output', 'plans', 'p.md'), 'plan\n');

            expect(feedbackFor('npm test')).toContain('STOP AND ASK');
        });
    });

    describe('m4 the ledger can never block the hook', () => {
        it.skipIf(process.platform === 'win32')('m4_ledgerReplacedByAFifo_hookStillAnswersWithTheStaticLine', () => {
            fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
            expect(spawnSync('mkfifo', [ledgerPath()]).status).toBe(0);

            const result = spawnSync(process.execPath, [HOOK_PATH], {
                input: JSON.stringify({ tool_input: { command: 'npm test' }, tool_response: { exit_code: 1, error: 'boom' } }),
                encoding: 'utf8', timeout: 8000, env: { ...process.env, CLAUDE_PROJECT_DIR: root },
            });

            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout.trim().split('\n').pop()).feedback).toContain(STATIC_LINE);
        });
    });
});
