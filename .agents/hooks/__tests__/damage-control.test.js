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

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { processEvent, classifyError } = require('../../../.agents/hooks/damage-control.cjs');

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
