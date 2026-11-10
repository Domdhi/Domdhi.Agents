// AC→source map (TDD-5.4 / command-usage-logger + P1.3 A4 schema enrichment):
//   - inferGateRun: gate.js --test / gate.js test → 'gate:test'
//   - inferGateRun: gate.js build / gate.js (bare) → 'gate:build'
//   - inferGateRun: unrelated command → null
//   - inferGateRun: null/empty → null
//   - appendJsonl: creates file and parent dirs, writes valid JSONL
//   - appendJsonl: over MAX_JSONL_LINES (1000) → tail-rotates to TAIL_KEEP_LINES (500)
//   - appendJsonl: rotation preserves most-recent entries
//   - processEvent: skill event (/do, /todo, /run-todo) → appends command_invocation entry
//   - processEvent: /do skill → REGRESSION test (was not captured)
//   - processEvent: gate run (gate.js test) → appends gate_run entry with success/failure/unknown outcome
//   - processEvent: unrelated bash command → no file written, returns null
//   - processEvent: no skill and no gate run → returns null
//   - processEvent: gate pass (exit_code 0) → outcome: 'success'
//   - processEvent: gate fail (exit_code 1) → outcome: 'failure'
//   - processEvent: no exit_code, no summary → outcome: 'unknown'  [A4]
//   - processEvent: duration_ms present as null on all events       [A4]
//
// appendJsonl extracts inline logic from main(). No child_process usage in either hook.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const { processEvent, inferGateRun, appendJsonl, MAX_JSONL_LINES, TAIL_KEEP_LINES } = require('../../../.agents/hooks/command-usage-logger.cjs');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

// ─── inferGateRun ─────────────────────────────────────────────────────────────

describe('command-usage-logger', () => {
    describe('inferGateRun', () => {
        it('inferGateRun_gateTestFlag_returnsGateTest', () => {
            // Arrange / Act / Assert
            expect(inferGateRun('node .claude/core/gate.js --test')).toBe('gate:test');
        });

        it('inferGateRun_gateTestWord_returnsGateTest', () => {
            // Arrange / Act / Assert
            expect(inferGateRun('node gate.js test')).toBe('gate:test');
        });

        it('inferGateRun_gateBuildExplicit_returnsGateBuild', () => {
            // Arrange / Act / Assert
            expect(inferGateRun('node .claude/core/gate.js build')).toBe('gate:build');
        });

        it('inferGateRun_gateBare_returnsGateBuild', () => {
            // Arrange / Act / Assert — bare gate.js with no mode → gate:build
            expect(inferGateRun('node .claude/core/gate.js')).toBe('gate:build');
        });

        it('inferGateRun_gateJsNoPath_returnsGateBuild', () => {
            // Arrange / Act / Assert
            expect(inferGateRun('node gate.js')).toBe('gate:build');
        });

        it('inferGateRun_unrelatedCommand_returnsNull', () => {
            // Arrange / Act / Assert
            expect(inferGateRun('ls -la')).toBeNull();
        });

        it('inferGateRun_emptyString_returnsNull', () => {
            // Arrange / Act / Assert
            expect(inferGateRun('')).toBeNull();
        });

        it('inferGateRun_null_returnsNull', () => {
            // Arrange / Act / Assert
            expect(inferGateRun(null)).toBeNull();
        });

        it('inferGateRun_npmTest_returnsNull', () => {
            // Arrange / Act / Assert — npm test does not contain gate.js
            expect(inferGateRun('npm test')).toBeNull();
        });
    });

    // ─── appendJsonl ──────────────────────────────────────────────────────────

    describe('appendJsonl', () => {
        let tmp;

        beforeEach(() => {
            tmp = createTmpDir();
        });

        afterEach(() => {
            tmp.cleanup();
        });

        it('appendJsonl_singleEntry_createsFileWithValidJsonl', () => {
            // Arrange
            const jsonlPath = path.join(tmp.root, 'telemetry', 'log.jsonl');

            // Act
            appendJsonl(jsonlPath, { type: 'command_invocation', command: 'do' });

            // Assert
            expect(fs.existsSync(jsonlPath)).toBe(true);
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            expect(lines).toHaveLength(1);
            const entry = JSON.parse(lines[0]);
            expect(entry.type).toBe('command_invocation');
            expect(entry.command).toBe('do');
        });

        it('appendJsonl_multipleEntries_appendsEach', () => {
            // Arrange
            const jsonlPath = path.join(tmp.root, 'telemetry', 'log.jsonl');

            // Act
            appendJsonl(jsonlPath, { seq: 0 });
            appendJsonl(jsonlPath, { seq: 1 });
            appendJsonl(jsonlPath, { seq: 2 });

            // Assert
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            expect(lines).toHaveLength(3);
            expect(JSON.parse(lines[0]).seq).toBe(0);
            expect(JSON.parse(lines[2]).seq).toBe(2);
        });

        it('appendJsonl_createsParentDirs_whenMissing', () => {
            // Arrange — deeply nested path that doesn't exist
            const jsonlPath = path.join(tmp.root, 'a', 'b', 'c', 'log.jsonl');

            // Act — should not throw
            appendJsonl(jsonlPath, { x: 1 });

            // Assert
            expect(fs.existsSync(jsonlPath)).toBe(true);
        });

        it('appendJsonl_overMaxLines_rotatesAndDropsOldest', () => {
            // Derive counts from the exported caps so this test survives cap
            // re-sizing (command-usage was raised 1000/500 → 6000/5000 on
            // 2026-06-03 to preserve longitudinal history). Rotation mechanics
            // are exhaustively covered in jsonl-writer.test.js with small caps;
            // here we only confirm the logger passes its caps through.
            const jsonlPath = path.join(tmp.root, 'telemetry', 'log.jsonl');
            const total = MAX_JSONL_LINES + 200;

            // Act
            for (let i = 0; i < total; i++) {
                appendJsonl(jsonlPath, { seq: i });
            }

            // Assert — size stays ≤ MAX, oldest entries dropped, newest kept.
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            expect(lines.length).toBeLessThanOrEqual(MAX_JSONL_LINES);
            expect(lines.length).toBeLessThan(total);
            expect(TAIL_KEEP_LINES).toBeLessThan(MAX_JSONL_LINES); // rotation sheds, never zeroes
            const firstSeq = JSON.parse(lines[0]).seq;
            expect(firstSeq).toBeGreaterThan(0);
            const lastSeq = JSON.parse(lines[lines.length - 1]).seq;
            expect(lastSeq).toBe(total - 1);
        });

        it('appendJsonl_rotation_preservesLastEntries', () => {
            // Arrange
            const jsonlPath = path.join(tmp.root, 'telemetry', 'log.jsonl');

            // Act
            for (let i = 0; i < 1200; i++) {
                appendJsonl(jsonlPath, { seq: i });
            }

            // Assert — last entry must be seq 1199 (most recent)
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            const last = JSON.parse(lines[lines.length - 1]);
            expect(last.seq).toBe(1199);
        });
    });

    // ─── processEvent ─────────────────────────────────────────────────────────
    //
    // processEvent tests isolate writes via CLAUDE_PROJECT_DIR — the hook
    // resolves its output path lazily from the env var (see getProjectRoot()
    // in command-usage-logger.cjs). Setting it per-test in beforeEach, and
    // restoring the caller's prior value in afterEach, guarantees test runs
    // never touch the real repo's `docs/.output/.state/telemetry/command-usage.jsonl`.

    describe('processEvent', () => {
        let tmp;
        let priorClaudeProjectDir;

        beforeEach(() => {
            tmp = createTmpDir();
            priorClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
            process.env.CLAUDE_PROJECT_DIR = tmp.root;
        });

        afterEach(() => {
            if (priorClaudeProjectDir === undefined) {
                delete process.env.CLAUDE_PROJECT_DIR;
            } else {
                process.env.CLAUDE_PROJECT_DIR = priorClaudeProjectDir;
            }
            tmp.cleanup();
        });

        it('processEvent_skillEvent_appendsCommandInvocationEntry', () => {
            // Arrange
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            processEvent({ tool_input: { skill: 'todo' } });

            // Assert
            expect(fs.existsSync(jsonlPath)).toBe(true);
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            expect(lines).toHaveLength(1);
            const entry = JSON.parse(lines[0]);
            expect(entry.type).toBe('command_invocation');
            expect(entry.command).toBe('todo');
            expect(typeof entry.timestamp).toBe('string');
        });

        it('processEvent_doSkillEvent_capturesCorrectly', () => {
            // REGRESSION: /do used to not match — this test will fail if /do invocations
            // are silently dropped instead of captured.
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            processEvent({ tool_input: { skill: 'do' } });

            // Assert
            expect(fs.existsSync(jsonlPath)).toBe(true);
            const entries = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
            expect(entries.some(e => e.command === 'do')).toBe(true);
        });

        it('processEvent_runTodoSkillEvent_capturesCorrectly', () => {
            // Arrange
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            processEvent({ tool_input: { skill: 'run-todo' } });

            // Assert
            expect(fs.existsSync(jsonlPath)).toBe(true);
            const entries = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
            expect(entries.some(e => e.command === 'run-todo')).toBe(true);
        });

        it('processEvent_gateTestPass_appendsGateRunPassEntry', () => {
            // Arrange
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js --test' },
                tool_response: { exit_code: 0 },
            });

            // Assert
            expect(fs.existsSync(jsonlPath)).toBe(true);
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            const entry = JSON.parse(lines[0]);
            expect(entry.type).toBe('gate_run');
            expect(entry.command).toBe('gate:test');
            expect(entry.outcome).toBe('success');
        });

        it('processEvent_gateBuildFail_appendsGateRunFailEntry', () => {
            // Arrange
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js build' },
                tool_response: { exit_code: 1 },
            });

            // Assert
            expect(fs.existsSync(jsonlPath)).toBe(true);
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            const entry = JSON.parse(lines[0]);
            expect(entry.type).toBe('gate_run');
            expect(entry.command).toBe('gate:build');
            expect(entry.outcome).toBe('failure');
        });

        it('processEvent_gateExitCodeFromToolOutput_usedWhenToolResponseMissing', () => {
            // Arrange — exit_code from tool_output (fallback path)
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            processEvent({
                tool_input: { command: 'node gate.js test' },
                tool_output: { exit_code: 0 },
            });

            // Assert
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            const entry = JSON.parse(lines[0]);
            expect(entry.outcome).toBe('success');
        });

        it('processEvent_gateNoExitCode_summaryOverallTrue_outcomePass', () => {
            // REGRESSION: Claude Code's PostToolUse:Bash payload does NOT include
            // exit_code on tool_response. The hook must fall back to reading
            // _latest-summary.json (which gate.js writes immediately before exit).
            // Without this fallback, every gate_run logged outcome:fail despite
            // the gate actually passing — bug surfaced in TDD-3, TDD-5, TDD-6 retros.

            // Arrange — write the summary file gate.js produces, NO exit_code on event
            const summaryPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json');
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, JSON.stringify({
                overall: true,
                stack: 'node',
                build: { succeeded: true },
                test: { succeeded: true, passed: 787, failed: 0 },
            }));

            // Act — production-shape payload: tool_response without exit_code
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js --test' },
                tool_response: { stdout: '...', stderr: '', interrupted: false, isImage: false },
            });

            // Assert — outcome reflects summary.overall, not the absent exit_code
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            const entry = JSON.parse(lines[0]);
            expect(entry.outcome).toBe('success');
        });

        it('processEvent_gateNoExitCode_summaryOverallFalse_outcomeFail', () => {
            // Arrange
            const summaryPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json');
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, JSON.stringify({
                overall: false,
                test: { succeeded: false, passed: 786, failed: 1 },
            }));

            // Act
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js --test' },
                tool_response: { stdout: '...', stderr: '', interrupted: false, isImage: false },
            });

            // Assert
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            const entry = JSON.parse(lines[0]);
            expect(entry.outcome).toBe('failure');
        });

        it.each([
            [{ overall: false, killed: 'SIGKILL' }, 'SIGKILL'],
            [{ overall: false, inProgress: true, pid: 1 }, 'unfinished'],
        ])('processEvent_gateKilledOrUnfinished_isUnknownWithTheKill_notAFailure (%j)', (summaryBody, killed) => {
            // A killed gate is no verdict on the code; an unfinished one left its in-progress
            // marker instead of a stale earlier verdict.
            const summaryPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json');
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, JSON.stringify(summaryBody));

            processEvent({
                tool_input: { command: 'node .claude/core/gate.js test' },
                tool_response: { stdout: '', stderr: '', interrupted: true, isImage: false },
            });

            const entry = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')[0]);
            expect(entry.outcome).toBe('unknown');
            expect(entry.killed).toBe(killed);
        });

        it('processEvent_gateNoExitCode_noSummaryFile_outcomeUnknown', () => {
            // A4 schema: no exit_code AND no summary file → outcome 'unknown'.
            // Previously defaulted to 'fail', but that misrepresented the absence
            // of any signal as a negative result. 'unknown' is correct here.

            // Arrange — no summary file exists
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js --test' },
                tool_response: { stdout: '...' },
            });

            // Assert
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            const entry = JSON.parse(lines[0]);
            expect(entry.outcome).toBe('unknown');
        });

        it('processEvent_gateExitCodeTakesPrecedenceOverSummary', () => {
            // exit_code is preferred when present (backward compat). If a future
            // Claude Code version adds exit_code to tool_response, the hook
            // should keep using it instead of switching to the file read.

            // Arrange — write a contradictory summary; exit_code says fail, summary says pass
            const summaryPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json');
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, JSON.stringify({ overall: true }));

            // Act — exit_code:1 (fail) provided, summary says pass — exit_code wins
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js --test' },
                tool_response: { exit_code: 1 },
            });

            // Assert
            const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
            const entry = JSON.parse(lines[0]);
            expect(entry.outcome).toBe('failure');
        });

        it('processEvent_unrelatedBashCommand_noFileWritten', () => {
            // Arrange
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            const result = processEvent({ tool_input: { command: 'ls -la' } });

            // Assert
            expect(result).toBeNull();
            expect(fs.existsSync(jsonlPath)).toBe(false);
        });

        it('processEvent_noSkillNoCommand_returnsNull', () => {
            // Arrange
            const result = processEvent({ tool_input: {} });

            // Assert
            expect(result).toBeNull();
        });

        it('processEvent_alwaysReturnsNull', () => {
            // Arrange — even on a successful skill event, return value is null
            const result = processEvent({ tool_input: { skill: 'prime' } });

            // Assert
            expect(result).toBeNull();
        });

        it('processEvent_ignoresCwdFieldOnPayload_usesProjectRootOnly', () => {
            // REGRESSION: earlier versions of the hook used `parsedJson.cwd` or
            // `process.cwd()` to resolve the output path, which meant a prior
            // `cd src && ...` in the same Bash shell would misroute telemetry
            // into `src/docs/.output/`. The hook must now ignore cwd entirely
            // and resolve exclusively from CLAUDE_PROJECT_DIR / __dirname.

            // Arrange — event payload includes a bogus `cwd` pointing outside tmp
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            const bogusCwd = path.join(tmp.root, 'subdir-that-should-not-be-used');
            fs.mkdirSync(bogusCwd, { recursive: true });

            // Act
            processEvent({
                tool_input: { skill: 'end' },
                cwd: bogusCwd,
            });

            // Assert — file lands at CLAUDE_PROJECT_DIR (tmp.root), not at bogusCwd
            expect(fs.existsSync(jsonlPath)).toBe(true);
            const bogusJsonlPath = path.join(bogusCwd, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            expect(fs.existsSync(bogusJsonlPath)).toBe(false);
        });

        // ─── A4 schema enrichment tests ───────────────────────────────────────
        // duration_ms: command_invocation stays null (a PostToolUse hook has no
        // start signal); gate_run is populated from gate.js's summary.durationMs
        // (P1.6 — implemented), falling back to null for older summaries.

        it('processEvent_a4_commandInvocation_hasDurationMsNull', () => {
            // command_invocation events carry duration_ms: null — there is no
            // start time available to a PostToolUse-only hook.
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act
            processEvent({ tool_input: { skill: 'do' } });

            // Assert
            const entry = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')[0]);
            expect(entry).toHaveProperty('duration_ms');
            expect(entry.duration_ms).toBeNull();
        });

        it('processEvent_gateRun_summaryWithDurationMs_populatesDuration', () => {
            // P1.6: gate.js stamps wall-clock durationMs into the summary; the
            // hook copies it onto the gate_run telemetry entry.
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            const summaryPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json');
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, JSON.stringify({ overall: true, durationMs: 4213 }));

            // Act — production-shape payload (no exit_code on tool_response)
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js --test' },
                tool_response: { stdout: '...' },
            });

            // Assert
            const entry = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')[0]);
            expect(entry.duration_ms).toBe(4213);
            expect(entry.outcome).toBe('success');
        });

        it('processEvent_gateRun_summaryWithoutDurationMs_durationNull', () => {
            // Backward-compat: a summary from an older gate.js (no durationMs)
            // yields duration_ms: null rather than undefined/NaN.
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            const summaryPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json');
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, JSON.stringify({ overall: true }));

            // Act
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js --test' },
                tool_response: { stdout: '...' },
            });

            // Assert
            const entry = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')[0]);
            expect(entry).toHaveProperty('duration_ms');
            expect(entry.duration_ms).toBeNull();
        });

        it('processEvent_a4_gateNoSignal_outcomeUnknown', () => {
            // A4: no exit_code AND no summary file → outcome 'unknown' (not 'fail')
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');

            // Act — no summary file in tmp, no exit_code in payload
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js test' },
                tool_response: { stdout: 'some output', stderr: '', interrupted: false },
            });

            // Assert
            const entry = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')[0]);
            expect(entry.outcome).toBe('unknown');
        });

        it('processEvent_a4_summaryOverallFalse_outcomeFailure', () => {
            // A4: summary reports overall: false → outcome 'failure' (not 'fail')
            const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
            const summaryPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', '_latest-summary.json');
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, JSON.stringify({ overall: false, test: { failed: 2 } }));

            // Act
            processEvent({
                tool_input: { command: 'node .claude/core/gate.js --test' },
                tool_response: { stdout: '...' },
            });

            // Assert
            const entry = JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim().split('\n')[0]);
            expect(entry.outcome).toBe('failure');
        });
    });
});
