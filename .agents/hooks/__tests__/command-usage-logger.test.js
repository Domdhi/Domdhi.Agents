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
        it.each([
            ['grep -n "gate.js" .agents/skills/do/references/workflow.md'],
            ['sed -n 1,40p .claude/core/gate.js'],
            ['cat .claude/core/gate.js | head'],
            ['node .claude/core/gate.js stop'],
            ['node .claude/core/gate.js verify-receipt --json'],
        ])('inferGateRun_aCommandThatOnlyNamesOrQueriesTheGate_isNotAGateRun: %s', (command) => {
            expect(inferGateRun(command)).toBeNull();
        });

        it('inferGateRun_aChainedOrFullInvocation_isStillCounted', () => {
            expect(inferGateRun('cd /x && node .claude/core/gate.js test 2>&1 | tail -5')).toBe('gate:test');
            expect(inferGateRun('node .claude/core/gate.js full test')).toBe('gate:test');
            expect(inferGateRun('node "/a b/.claude/core/gate.js" build')).toBe('gate:build');
        });

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

// ─── SF-3.2: run_id and wave on gate_run and command_invocation rows ──────────
//
// PINNED CONTRACT (the tests are the spec; the implementer must not edit them).
//   Source of the pointer: docs/.output/.state/telemetry/current-run-{session}.json under the hook's resolved project
//   root (the same root command-usage.jsonl is written under): { run_id, plan, wave, story, since } (the "run id and
//   session pointer" seam, written by run-record.js, SF-3.1). The session is the SAME one the row's `session_id` uses:
//   env CLAUDE_CODE_SESSION_ID first, else the hook payload's `session_id`; neither -> no pointer is read.
//   Stamping: a usable pointer (a regular file, <= 64 KiB, JSON object, run_id a non-empty string) adds EXACTLY two keys
//   to command_invocation and gate_run rows: run_id (the pointer's string) and wave (the pointer's number, else null; a
//   freshly started run has wave null). Any other state (no session, absent, unreadable, directory, symlink, FIFO,
//   oversized, corrupt, wrong shape, another session's pointer, an unsafe session id) leaves the row exactly as before
//   SF-3.2: the two keys are ABSENT (not null), the row is still written, the hook still exits 0 and never blocks. A
//   pointer is never followed through a symlink and a FIFO is never opened blockingly (memory:
//   hook-reads-of-agent-writable-paths-must-reject-fifos). Every "unchanged" case is paired with a control: the same
//   path rewritten as a valid pointer MUST stamp, so a green "unchanged" is the reader refusing the shape, not the
//   reader looking in the wrong place.
//   telemetry-log.js start rows (self-instrumented command_invocation) are NOT stamped (they are written before the
//   pointer exists); the hook source documents that they join by session_id and timestamp.
//   gate.js is not edited (no run id logic there).

describe('SF-3.2 command-usage rows carry run_id and wave from the session pointer', () => {
    const { spawnSync } = require('node:child_process');
    const { fileURLToPath } = require('node:url');
    const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'command-usage-logger.cjs');
    const GATE_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'gate.js');
    const TELEMETRY = ['docs', '.output', '.state', 'telemetry'];
    const POINTER = { run_id: '261118-1200-run-todo-software-factory', plan: 'docs/.output/plans/p.md', wave: 3, story: 'SF-3.2', since: '261118-1200' };
    const SKILL_KEYS = ['command', 'duration_ms', 'session_id', 'timestamp', 'type'];
    const GATE_KEYS = ['command', 'duration_ms', 'outcome', 'session_id', 'timestamp', 'type'];
    const SKILL_EVENT = { tool_input: { skill: 'do' } };
    const GATE_EVENT = { tool_input: { command: 'node .claude/core/gate.js --test' }, tool_response: { exit_code: 0 } };
    const posixIt = process.platform === 'win32' ? it.skip : it;
    const nonRootPosixIt = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? it.skip : it;
    let tmp;
    let priorProjectDir;
    let priorSession;

    const telemetryDir = () => path.join(tmp.root, ...TELEMETRY);
    const jsonlPath = () => path.join(telemetryDir(), 'command-usage.jsonl');
    const pointerPath = (session) => path.join(telemetryDir(), `current-run-${session}.json`);
    const plant = (session, body) => {
        const p = pointerPath(session);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
        return p;
    };
    const unplant = (p) => fs.rmSync(p, { recursive: true, force: true });
    const rows = () => (fs.existsSync(jsonlPath()) ? fs.readFileSync(jsonlPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
    const lastRow = () => rows().at(-1);
    const keysOf = (row) => Object.keys(row).sort();
    // Run the real hook as the harness does: stdin JSON, env, exit code. A hard timeout turns a blocked read into a failure.
    const runHook = (payload, session = 'sess-a') => spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, CLAUDE_CODE_SESSION_ID: session },
        encoding: 'utf8',
        timeout: 15000,
    });

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'cul-sf32-' });
        priorProjectDir = process.env.CLAUDE_PROJECT_DIR;
        priorSession = process.env.CLAUDE_CODE_SESSION_ID;
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        process.env.CLAUDE_CODE_SESSION_ID = 'sess-a';
    });

    afterEach(() => {
        if (priorProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = priorProjectDir;
        if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
        else process.env.CLAUDE_CODE_SESSION_ID = priorSession;
        tmp.cleanup();
    });

    // ── stamping ──────────────────────────────────────────────────────────

    it.each([
        ['command_invocation', SKILL_EVENT, SKILL_KEYS],
        ['gate_run', GATE_EVENT, GATE_KEYS],
    ])('processEvent_%s_pointerForEnvSession_stampsRunIdAndWaveAndNothingElse', (_type, event, baseKeys) => {
        plant('sess-a', POINTER);

        processEvent(event);

        const row = lastRow();
        expect(row.run_id).toBe(POINTER.run_id);
        expect(row.wave).toBe(3);
        expect(row.session_id).toBe('sess-a');
        expect(keysOf(row)).toEqual([...baseKeys, 'run_id', 'wave'].sort());
    });

    it('processEvent_killedGateRun_stillStampsRunIdAndWave', () => {
        plant('sess-a', POINTER);
        fs.writeFileSync(path.join(telemetryDir(), '_latest-summary.json'), JSON.stringify({ overall: false, killed: 'SIGKILL' }));

        processEvent({ tool_input: { command: 'node .claude/core/gate.js test' }, tool_response: { stdout: '' } });

        expect(lastRow()).toMatchObject({ type: 'gate_run', outcome: 'unknown', killed: 'SIGKILL', run_id: POINTER.run_id, wave: 3 });
    });

    it('processEvent_noEnvSessionPayloadSessionIdFallback_stampsFromPayloadSessionPointer', () => {
        delete process.env.CLAUDE_CODE_SESSION_ID;
        plant('sess-p', { ...POINTER, run_id: 'run-p', wave: 4 });

        processEvent({ ...SKILL_EVENT, session_id: 'sess-p' });

        expect(lastRow()).toMatchObject({ session_id: 'sess-p', run_id: 'run-p', wave: 4 });
    });

    it('processEvent_envSessionAndDifferentPayloadSession_usesTheEnvSessionTheRowReports', () => {
        plant('sess-a', { ...POINTER, run_id: 'run-env', wave: 1 });
        plant('sess-p', { ...POINTER, run_id: 'run-payload', wave: 2 });

        processEvent({ ...SKILL_EVENT, session_id: 'sess-p' });

        expect(lastRow()).toMatchObject({ session_id: 'sess-a', run_id: 'run-env', wave: 1 });
    });

    it('processEvent_pointerJustAfterStartWithNullWave_stampsRunIdAndNullWave', () => {
        plant('sess-a', { ...POINTER, wave: null, story: null, plan: null });

        processEvent(GATE_EVENT);

        expect(lastRow().run_id).toBe(POINTER.run_id);
        expect('wave' in lastRow()).toBe(true);
        expect(lastRow().wave).toBeNull();
    });

    it('processEvent_pointerWaveIsNotANumber_stampsRunIdAndNullWave', () => {
        plant('sess-a', { ...POINTER, wave: '3' });

        processEvent(SKILL_EVENT);

        expect(lastRow().run_id).toBe(POINTER.run_id);
        expect(lastRow().wave).toBeNull();
    });

    it('processEvent_pointerMovesToNextWaveBetweenEvents_eachRowCarriesItsOwnWave', () => {
        plant('sess-a', { ...POINTER, wave: 1 });
        processEvent(GATE_EVENT);
        plant('sess-a', { ...POINTER, wave: 2 });
        processEvent(GATE_EVENT);

        expect(rows().map(r => r.wave)).toEqual([1, 2]);
    });

    it('processEvent_twoSessionsInOneTree_eachRowCarriesItsOwnSessionsRun', () => {
        plant('sess-a', { ...POINTER, run_id: 'run-a', wave: 1 });
        plant('sess-b', { ...POINTER, run_id: 'run-b', wave: 9 });

        processEvent(GATE_EVENT);
        process.env.CLAUDE_CODE_SESSION_ID = 'sess-b';
        processEvent(GATE_EVENT);

        expect(rows().map(r => [r.session_id, r.run_id, r.wave])).toEqual([['sess-a', 'run-a', 1], ['sess-b', 'run-b', 9]]);
    });

    it('processEvent_cwdFieldOnPayload_doesNotRedirectThePointerRead', () => {
        const decoy = path.join(tmp.root, 'decoy');
        fs.mkdirSync(path.join(decoy, ...TELEMETRY), { recursive: true });
        fs.writeFileSync(path.join(decoy, ...TELEMETRY, 'current-run-sess-a.json'), JSON.stringify({ ...POINTER, run_id: 'run-decoy' }));
        plant('sess-a', POINTER);

        processEvent({ ...SKILL_EVENT, cwd: decoy });

        expect(lastRow().run_id).toBe(POINTER.run_id);
    });

    it('processEvent_unrelatedBashCommandWithPointer_writesNothing', () => {
        plant('sess-a', POINTER);

        const result = processEvent({ tool_input: { command: 'ls -la' } });

        expect(result).toBeNull();
        expect(fs.existsSync(jsonlPath())).toBe(false);
    });

    // ── unchanged when absent ─────────────────────────────────────────────

    it.each([
        ['command_invocation', SKILL_EVENT, SKILL_KEYS],
        ['gate_run', GATE_EVENT, GATE_KEYS],
    ])('processEvent_%s_absentPointer_rowKeysExactlyAsBefore', (_type, event, baseKeys) => {
        processEvent(event);

        expect(keysOf(lastRow())).toEqual(baseKeys);
        expect('run_id' in lastRow()).toBe(false);
        expect('wave' in lastRow()).toBe(false);
    });

    it('processEvent_noSessionAtAll_rowUnchangedEvenWhenPointerFilesExist', () => {
        delete process.env.CLAUDE_CODE_SESSION_ID;
        plant('sess-a', POINTER);
        plant('undefined', POINTER);
        plant('null', POINTER);
        plant('', POINTER);

        processEvent(SKILL_EVENT);
        processEvent({ ...SKILL_EVENT, session_id: 'sess-a' });

        expect(keysOf(rows()[0])).toEqual(SKILL_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    it('processEvent_onlyAnotherSessionsPointerExists_rowUnchangedAndThatSessionStillStamps', () => {
        plant('sess-b', POINTER);

        processEvent(GATE_EVENT);
        process.env.CLAUDE_CODE_SESSION_ID = 'sess-b';
        processEvent(GATE_EVENT);

        expect(keysOf(rows()[0])).toEqual(GATE_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    // ── adversarial pointers: rows unchanged, hook exits 0, a valid pointer in the same place still stamps ──

    const CORRUPT = [
        ['not JSON', '{nope'],
        ['empty file', ''],
        ['truncated JSON', '{"run_id":"r1","wa'],
        ['a JSON array', '[]'],
        ['a JSON string', '"run-1"'],
        ['JSON null', 'null'],
        ['no run_id', '{"wave":1,"plan":null,"story":null,"since":"261118-1200"}'],
        ['run_id a number', '{"run_id":7,"wave":1}'],
        ['run_id empty string', '{"run_id":"","wave":1}'],
        ['run_id an object', '{"run_id":{"a":1},"wave":1}'],
        ['binary garbage', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]).toString('latin1')],
    ];

    it.each(CORRUPT)('processEvent_corruptPointer_%s_rowStillWrittenUnchangedThenValidPointerStamps', (_name, body) => {
        const p = plant('sess-a', body);

        const returned = processEvent(GATE_EVENT);
        unplant(p);
        plant('sess-a', POINTER);
        processEvent(GATE_EVENT);

        expect(returned).toBeNull();
        expect(rows()).toHaveLength(2);
        expect(keysOf(rows()[0])).toEqual(GATE_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    it.each(CORRUPT)('hookProcess_corruptPointer_%s_exits0AndWritesTheUnchangedRow', (_name, body) => {
        plant('sess-a', body);

        const res = runHook(SKILL_EVENT);

        expect(res.error).toBeUndefined();
        expect(res.status).toBe(0);
        expect(rows()).toHaveLength(1);
        expect(keysOf(rows()[0])).toEqual(SKILL_KEYS);
    });

    it('hookProcess_validPointer_exits0AndStampsTheRow', () => {
        plant('sess-a', POINTER);

        const res = runHook(GATE_EVENT);

        expect(res.status).toBe(0);
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toMatchObject({ type: 'gate_run', run_id: POINTER.run_id, wave: 3, session_id: 'sess-a' });
    });

    it('processEvent_pointerPathIsADirectory_rowUnchangedThenValidPointerStamps', () => {
        const p = pointerPath('sess-a');
        fs.mkdirSync(p, { recursive: true });

        processEvent(SKILL_EVENT);
        unplant(p);
        plant('sess-a', POINTER);
        processEvent(SKILL_EVENT);

        expect(keysOf(rows()[0])).toEqual(SKILL_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    it('hookProcess_pointerPathIsADirectory_exits0AndWritesTheUnchangedRow', () => {
        fs.mkdirSync(pointerPath('sess-a'), { recursive: true });

        const res = runHook(GATE_EVENT);

        expect(res.status).toBe(0);
        expect(keysOf(lastRow())).toEqual(GATE_KEYS);
    });

    nonRootPosixIt('processEvent_pointerUnreadableMode000_rowUnchangedThenReadablePointerStamps', () => {
        const p = plant('sess-a', POINTER);
        fs.chmodSync(p, 0o000);

        processEvent(GATE_EVENT);
        fs.chmodSync(p, 0o600);
        processEvent(GATE_EVENT);

        expect(keysOf(rows()[0])).toEqual(GATE_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    nonRootPosixIt('hookProcess_pointerUnreadableMode000_exits0AndWritesTheUnchangedRow', () => {
        const p = plant('sess-a', POINTER);
        fs.chmodSync(p, 0o000);

        const res = runHook(SKILL_EVENT);

        expect(res.status).toBe(0);
        expect(keysOf(lastRow())).toEqual(SKILL_KEYS);
    });

    it('processEvent_pointerOverTheSizeCap_treatedAsCorruptRowUnchanged', () => {
        // Valid JSON padded to 2 MiB: a pointer is < 1 KiB, so a reader that slurps the whole file has no cap.
        const p = plant('sess-a', JSON.stringify(POINTER) + ' '.repeat(2 * 1024 * 1024));

        processEvent(GATE_EVENT);
        unplant(p);
        plant('sess-a', POINTER);
        processEvent(GATE_EVENT);

        expect(keysOf(rows()[0])).toEqual(GATE_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    posixIt('processEvent_pointerIsASymlinkToAValidPointer_notFollowedRowUnchanged', () => {
        const target = path.join(tmp.root, 'elsewhere.json');
        fs.writeFileSync(target, JSON.stringify(POINTER));
        const p = pointerPath('sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.symlinkSync(target, p);

        processEvent(SKILL_EVENT);
        unplant(p);
        plant('sess-a', POINTER);
        processEvent(SKILL_EVENT);

        expect(keysOf(rows()[0])).toEqual(SKILL_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    posixIt('hookProcess_pointerIsASymlinkToAValidPointer_exits0NotFollowedRowUnchanged', () => {
        const target = path.join(tmp.root, 'elsewhere.json');
        fs.writeFileSync(target, JSON.stringify(POINTER));
        const p = pointerPath('sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.symlinkSync(target, p);

        const res = runHook(GATE_EVENT);

        expect(res.status).toBe(0);
        expect(keysOf(lastRow())).toEqual(GATE_KEYS);
    });

    posixIt('processEvent_pointerIsADanglingSymlink_rowUnchangedThenValidPointerStamps', () => {
        const p = pointerPath('sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.symlinkSync(path.join(tmp.root, 'does-not-exist.json'), p);

        processEvent(SKILL_EVENT);
        unplant(p);
        plant('sess-a', POINTER);
        processEvent(SKILL_EVENT);

        expect(keysOf(rows()[0])).toEqual(SKILL_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    posixIt('hookProcess_pointerIsAFifo_neverBlocksExits0AndWritesTheUnchangedRow', () => {
        // A hook must never block: a plain open of a FIFO with no writer hangs forever. The hard spawnSync timeout
        // turns that hang into res.error (ETIMEDOUT) instead of a stuck suite.
        const p = pointerPath('sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        expect(spawnSync('mkfifo', [p]).status).toBe(0);

        const res = runHook(GATE_EVENT);

        expect(res.error).toBeUndefined();
        expect(res.signal).toBeNull();
        expect(res.status).toBe(0);
        expect(keysOf(lastRow())).toEqual(GATE_KEYS);
    });

    posixIt('hookProcess_fifoReplacedByValidPointer_nextRowStamps', () => {
        // Control for the FIFO case: the same path as a regular file stamps, so the unchanged row above is the
        // reader refusing the FIFO, not the reader looking in the wrong place.
        const p = pointerPath('sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        expect(spawnSync('mkfifo', [p]).status).toBe(0);
        const first = runHook(GATE_EVENT);
        unplant(p);
        plant('sess-a', POINTER);

        const second = runHook(GATE_EVENT);

        expect(first.status).toBe(0);
        expect(second.status).toBe(0);
        expect(keysOf(rows()[0])).toEqual(GATE_KEYS);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    it.each([['../evil'], ['a/b'], ['..'], ['a b'], ['sess*'], ['']])(
        'processEvent_unsafePayloadSessionId_%j_rowUnchangedAndNothingReadOutsideTheTelemetryDir',
        (unsafe) => {
            // Traps: pointers a naive `current-run-${session}.json` join would resolve to for the traversal ids.
            delete process.env.CLAUDE_CODE_SESSION_ID;
            fs.mkdirSync(path.join(telemetryDir(), 'current-run-..'), { recursive: true });
            fs.writeFileSync(path.join(telemetryDir(), 'current-run-..', 'current-run-evil.json'), JSON.stringify(POINTER));
            fs.writeFileSync(path.join(telemetryDir(), 'current-run-.json'), JSON.stringify(POINTER));
            fs.writeFileSync(path.join(tmp.root, 'docs', '.output', '.state', 'current-run-evil.json'), JSON.stringify(POINTER));
            plant('sess-a', POINTER);

            processEvent({ ...SKILL_EVENT, session_id: unsafe });
            processEvent({ ...SKILL_EVENT, session_id: 'sess-a' });

            expect(keysOf(rows()[0])).toEqual(['command', 'duration_ms', 'session_id', 'timestamp', 'type']);
            expect(rows()[1].run_id).toBe(POINTER.run_id);
        },
    );

    it.each([[undefined], [null], [{}], [42]])('processEvent_nonStringPayloadSessionId_%j_rowUnchangedAndNoThrow', (weird) => {
        delete process.env.CLAUDE_CODE_SESSION_ID;
        plant('sess-a', POINTER);

        processEvent({ ...SKILL_EVENT, session_id: weird });
        processEvent({ ...SKILL_EVENT, session_id: 'sess-a' });

        expect(rows()).toHaveLength(2);
        expect('run_id' in rows()[0]).toBe(false);
        expect(rows()[1].run_id).toBe(POINTER.run_id);
    });

    // ── self-instrumented start rows and gate.js stay as they are ─────────

    it('logCommand_telemetryLogStartRowWithPointerPresent_carriesNoRunIdOrWave', () => {
        // Guard (green by design): the start row is written before the pointer exists and joins by session_id and
        // timestamp. A pointer left over from an earlier run in this session must not leak onto it.
        const { logCommand } = require('../../../.agents/core/telemetry-log');
        plant('sess-a', POINTER);

        const event = logCommand('do', null, tmp.root);

        expect(keysOf(event)).toEqual(['command', 'duration_ms', 'session_id', 'source', 'timestamp', 'type']);
        expect(keysOf(lastRow())).toEqual(['command', 'duration_ms', 'session_id', 'source', 'timestamp', 'type']);
    });

    it('commandUsageLoggerSource_documentsThatSelfInstrumentedStartRowsCannotCarryRunId', () => {
        // AC: "documented, not changed". The hook header is where the self-instrumented gap is already described.
        const src = fs.readFileSync(HOOK, 'utf8');
        const comments = src.split('\n').filter(l => /^\s*(\/\/|\/?\*)/.test(l)).join('\n');

        expect(comments).toMatch(/(telemetry-log|self-instrumented)[\s\S]{0,400}run_id|run_id[\s\S]{0,400}(telemetry-log|self-instrumented)/);
        expect(comments).toMatch(/session_id[\s\S]{0,200}timestamp|timestamp[\s\S]{0,200}session_id/);
    });

    it('gateJs_isNotEditedForRunIdStamping_hasNoPointerOrRunIdLogic', () => {
        // Guard (green by design): AC "gate.js is not edited". The row writers do the stamping from the hook side.
        const src = fs.readFileSync(GATE_JS, 'utf8');

        expect(src).not.toMatch(/current-run|run_id/);
    });
});


// ── Wave 4 Group B review: M2 (the pointer root) and the project-root nit ─────────────────────────────────────
describe('M2 a linked-worktree hook reads the pointer run-record.js wrote under the main worktree', () => {
    const { spawnSync } = require('node:child_process');
    const { createLinkedWorktree } = require('../../core/__tests__/_helpers/linked-worktree');
    const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
    const gitIt = hasGit ? it : it.skip;
    const TELEMETRY = ['docs', '.output', '.state', 'telemetry'];
    const POINTER = { run_id: '261118-1200-run-todo-wt', plan: null, wave: 2, story: null, since: '261118-1200' };
    const GATE_EVENT = { tool_input: { command: 'node .claude/core/gate.js --test' }, tool_response: { exit_code: 0 } };
    let fx = null;
    let priorProjectDir;
    let priorSession;

    beforeEach(() => {
        priorProjectDir = process.env.CLAUDE_PROJECT_DIR;
        priorSession = process.env.CLAUDE_CODE_SESSION_ID;
        process.env.CLAUDE_CODE_SESSION_ID = 'sess-wt';
    });
    afterEach(() => {
        if (priorProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = priorProjectDir;
        if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
        else process.env.CLAUDE_CODE_SESSION_ID = priorSession;
        if (fx) { fx.cleanup(); fx = null; }
    });

    gitIt('processEvent_claudeProjectDirIsTheLinkedWorktree_stampsFromThePointerUnderTheMainWorktree', () => {
        fx = createLinkedWorktree();
        process.env.CLAUDE_PROJECT_DIR = fx.linked;
        const pointer = path.join(fx.main, ...TELEMETRY, 'current-run-sess-wt.json');
        fs.mkdirSync(path.dirname(pointer), { recursive: true });
        fs.writeFileSync(pointer, JSON.stringify(POINTER));

        processEvent(GATE_EVENT);

        const rows = fs.readFileSync(path.join(fx.linked, ...TELEMETRY, 'command-usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ type: 'gate_run', run_id: POINTER.run_id, wave: 2 });
    });

    gitIt('processEvent_aPointerOnlyUnderTheLinkedWorktree_isNotRead', () => {
        // The writer never puts one there; reading it would let a stray file stamp rows.
        fx = createLinkedWorktree();
        process.env.CLAUDE_PROJECT_DIR = fx.linked;
        const pointer = path.join(fx.linked, ...TELEMETRY, 'current-run-sess-wt.json');
        fs.mkdirSync(path.dirname(pointer), { recursive: true });
        fs.writeFileSync(pointer, JSON.stringify(POINTER));

        processEvent(GATE_EVENT);

        const row = JSON.parse(fs.readFileSync(path.join(fx.linked, ...TELEMETRY, 'command-usage.jsonl'), 'utf8').trim());
        expect('run_id' in row).toBe(false);
    });

    it('processEvent_resolvesTheProjectRootOncePerGateRow', () => {
        const tmpRoot = createTmpDir({ prefix: 'cul-once-' });
        process.env.CLAUDE_PROJECT_DIR = tmpRoot.root;
        const projectRoot = require('../../core/_lib/project-root');
        const original = projectRoot.resolveProjectRoot;
        const hookPath = require.resolve('../../../.agents/hooks/command-usage-logger.cjs');
        let calls = 0;
        projectRoot.resolveProjectRoot = (...args) => { calls++; return original(...args); };
        delete require.cache[hookPath];
        try {
            require(hookPath).processEvent(GATE_EVENT);
        } finally {
            projectRoot.resolveProjectRoot = original;
            delete require.cache[hookPath];
            tmpRoot.cleanup();
        }

        expect(calls).toBe(1);
    });
});
