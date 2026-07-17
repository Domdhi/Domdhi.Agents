// AC→source map (TDD-5.5 / post-read-scrubber):
//   - processEvent: exported named function
//   - Secret in tool_output → writes warning to stderr, returns null (non-blocking)
//   - Path in skip list (node_modules) → no warning, returns null
//   - No file_path → returns null, no warning
//   - No tool_output / empty → returns null, no warning
//   - Clean content → no warning, returns null
//
// Note: post-read-scrubber.cjs currently has only a main() + require.main guard.
//   After refactor it must export processEvent as a pure function.
//   The AWS key in the secret test uses runtime concatenation to avoid the pre-commit hook.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { processEvent, extractOutput, inferToolKind } = require('../post-read-scrubber.cjs');

// ─── Fake secret builders (runtime concatenation avoids pre-commit hook) ──────

function fakeAwsKey() {
    return 'AKIA' + 'FAKETESTKEY' + 'X'.repeat(5);
}

// ─── processEvent ─────────────────────────────────────────────────────────────

describe('post-read-scrubber', () => {
    describe('processEvent', () => {
        let stderrSpy;

        beforeEach(() => {
            stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        });

        afterEach(() => {
            stderrSpy.mockRestore();
        });

        it('processEvent_isExported', () => {
            expect(typeof processEvent).toBe('function');
        });

        it('processEvent_secretInContent_writesWarningToStderr', () => {
            const fakeKey = fakeAwsKey();
            processEvent({
                tool_input: { file_path: '/some/file.js' },
                tool_output: `export const key = "${fakeKey}";`
            });
            expect(stderrSpy).toHaveBeenCalled();
            const output = stderrSpy.mock.calls.map(c => c[0]).join('');
            expect(output).toMatch(/AWS Access Key|SECRET SCRUBBER/);
        });

        it('processEvent_secretInContent_returnsNull', () => {
            // Non-blocking: always returns null regardless of findings
            const fakeKey = fakeAwsKey();
            const result = processEvent({
                tool_input: { file_path: '/some/file.js' },
                tool_output: `export const key = "${fakeKey}";`
            });
            expect(result).toBeNull();
        });

        it('processEvent_skipPath_noWarning', () => {
            processEvent({
                tool_input: { file_path: 'node_modules/foo/index.js' },
                tool_output: 'whatever'
            });
            expect(stderrSpy).not.toHaveBeenCalled();
        });

        it('processEvent_noFilePath_returnsNull', () => {
            const result = processEvent({
                tool_input: {},
                tool_output: `export const key = "${fakeAwsKey()}";`
            });
            expect(result).toBeNull();
            expect(stderrSpy).not.toHaveBeenCalled();
        });

        it('processEvent_noToolOutput_returnsNull', () => {
            const result = processEvent({
                tool_input: { file_path: '/some/file.js' },
                tool_output: ''
            });
            expect(result).toBeNull();
            expect(stderrSpy).not.toHaveBeenCalled();
        });

        it('processEvent_cleanContent_noWarning', () => {
            processEvent({
                tool_input: { file_path: '/some/clean.js' },
                tool_output: 'const x = 42;\nconsole.log(x);\n'
            });
            expect(stderrSpy).not.toHaveBeenCalled();
        });

        // ── Dispatch port-back 2026-06-02: Bash coverage + redaction ──────────
        it('processEvent_bashOutputWithSecret_emitsRedactionJson', () => {
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Bash',
                    tool_input: { command: 'cat .env' },
                    tool_response: { stdout: `AWS_KEY=${fakeAwsKey()}` },
                });
                const out = stdoutSpy.mock.calls.map(c => c[0]).join('');
                expect(out).toMatch(/updatedToolOutput/);
                expect(out).toMatch(/<REDACTED:/);
                // Bash path writes no stderr warning (no useful file path)
                expect(stderrSpy).not.toHaveBeenCalled();
            } finally {
                stdoutSpy.mockRestore();
            }
        });

        // F8 (260716 code review): stderr was never included in the scan
        // target — a command that only prints a secret to stderr (e.g. a
        // failing curl echoing a leaked token) reached the model unscrubbed.
        it('processEvent_bashStderrOnlySecret_emitsRedactionJson', () => {
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Bash',
                    tool_input: { command: 'curl https://example.com' },
                    tool_response: { stdout: '', stderr: `curl: auth failed for token=${fakeAwsKey()}` },
                });
                const out = stdoutSpy.mock.calls.map(c => c[0]).join('');
                expect(out).toMatch(/updatedToolOutput/);
                expect(out).toMatch(/<REDACTED:/);
            } finally {
                stdoutSpy.mockRestore();
            }
        });

        it('processEvent_bashStdoutAndStderrSecrets_bothRedacted', () => {
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Bash',
                    tool_input: { command: 'some-script' },
                    tool_response: {
                        stdout: `out: ${fakeAwsKey()}`,
                        stderr: `err: ${fakeAwsKey()}`,
                    },
                });
                const out = stdoutSpy.mock.calls.map(c => c[0]).join('');
                const payload = JSON.parse(out);
                const redacted = payload.hookSpecificOutput.updatedToolOutput;
                expect(redacted).not.toContain(fakeAwsKey());
                expect(redacted).toContain('<REDACTED:');
            } finally {
                stdoutSpy.mockRestore();
            }
        });

        it('processEvent_readSecret_redactionNoteInWarning', () => {
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Read',
                    tool_input: { file_path: '/some/file.js' },
                    tool_response: { content: `const k = "${fakeAwsKey()}";` },
                });
                const warn = stderrSpy.mock.calls.map(c => c[0]).join('');
                expect(warn).toMatch(/redacted before reaching the model/);
            } finally {
                stdoutSpy.mockRestore();
            }
        });
    });

    describe('inferToolKind', () => {
        it('prefers explicit tool_name', () => {
            expect(inferToolKind({ tool_name: 'Bash', tool_input: { file_path: 'x' } })).toBe('Bash');
        });
        it('infers Read from file_path and Bash from command', () => {
            expect(inferToolKind({ tool_input: { file_path: 'x' } })).toBe('Read');
            expect(inferToolKind({ tool_input: { command: 'ls' } })).toBe('Bash');
        });
        it('returns unknown when nothing matches', () => {
            expect(inferToolKind({ tool_input: {} })).toBe('unknown');
        });
    });

    describe('extractOutput', () => {
        it('reads stdout, content, text, and legacy/string shapes', () => {
            expect(extractOutput({ tool_response: { stdout: 'a' } })).toBe('a');
            expect(extractOutput({ tool_response: { content: 'b' } })).toBe('b');
            expect(extractOutput({ tool_response: 'c' })).toBe('c');
            expect(extractOutput({ tool_output: 'd' })).toBe('d');
            expect(extractOutput({})).toBe('');
        });

        // F8 (260716 code review): stderr must be part of the scan target.
        it('reads stderr-only Bash output', () => {
            expect(extractOutput({ tool_response: { stdout: '', stderr: 'err text' } })).toBe('err text');
        });

        it('concatenates stdout and stderr when both are present', () => {
            expect(extractOutput({ tool_response: { stdout: 'out text', stderr: 'err text' } }))
                .toBe('out text\nerr text');
        });
    });

    // F70/F9 (260716 full-review MED, SEC-4): post-read-scrubber previously
    // capped the 55-regex sweep over Bash stdout to a head+tail 64 KB window
    // (128 KB total), so a secret ONLY in the skipped middle of a large log
    // produced no finding, no warning, and no redaction. The cap was removed
    // in favor of an always-full-length scan (early-exit on clean content is
    // the cost mitigation instead). These tests pin the fix.
    describe('full-length scan (no head/tail cap)', () => {
        const OLD_CAP_BYTES = 128 * 1024; // the retired 64+64 KB cap, for sizing fixtures past it

        it('small output is still scanned and redacted (unchanged behavior)', () => {
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Bash',
                    tool_input: { command: 'env' },
                    tool_response: { stdout: `AWS_KEY=${fakeAwsKey()}` },
                });
                const out = stdoutSpy.mock.calls.map(c => c[0]).join('');
                expect(out).toMatch(/<REDACTED:/);
            } finally {
                stdoutSpy.mockRestore();
            }
        });

        it('a secret in the HEAD or TAIL of a >128 KB Bash log is still detected', () => {
            const filler = 'x'.repeat(200) + '\n';
            const noise = filler.repeat(Math.ceil((OLD_CAP_BYTES * 2) / filler.length));
            for (const stdout of [`AWS_KEY=${fakeAwsKey()}\n${noise}`, `${noise}\nAWS_KEY=${fakeAwsKey()}`]) {
                const writes = [];
                const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
                try {
                    processEvent({ tool_name: 'Bash', tool_input: { command: 'env' }, tool_response: { stdout } });
                } finally {
                    stdoutSpy.mockRestore();
                }
                expect(writes.join('')).toContain('REDACTED');
            }
        });

        it('FIXED: a secret ONLY in the middle of a >128 KB Bash log IS now detected (was previously missed)', () => {
            const filler = 'x'.repeat(200) + '\n';
            const half = filler.repeat(Math.ceil(OLD_CAP_BYTES / filler.length));
            const stdout = `${half}AWS_KEY=${fakeAwsKey()}\n${half}`;
            expect(stdout.length).toBeGreaterThan(OLD_CAP_BYTES);

            const writes = [];
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
            let result;
            try {
                result = processEvent({ tool_name: 'Bash', tool_input: { command: 'env' }, tool_response: { stdout } });
            } finally {
                stdoutSpy.mockRestore();
            }
            expect(result).toBeNull(); // still non-blocking
            expect(writes.join('')).toContain('REDACTED');
        });
    });
});
