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

const { processEvent, extractOutput, inferToolKind, capForScan, BASH_SCAN_HEAD_BYTES, BASH_SCAN_TAIL_BYTES } = require('../post-read-scrubber.cjs');

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

    // F70 (council-260715-2244): the 55-regex sweep over Bash stdout is capped —
    // head + tail only past the byte cap, so a 200k-line build log can't add
    // ~1s+ of synchronous hook latency to every Bash call.
    describe('capForScan (F70 Bash stdout cap)', () => {
        it('returns small input unchanged', () => {
            expect(capForScan('short output')).toBe('short output');
        });

        it('bounds large input to head + tail (never scans the full log)', () => {
            const line = 'npm WARN deprecated something@1.0.0: use another package\n';
            const big = line.repeat(Math.ceil((BASH_SCAN_HEAD_BYTES + BASH_SCAN_TAIL_BYTES) * 4 / line.length));
            const capped = capForScan(big);
            expect(capped.length).toBeLessThanOrEqual(BASH_SCAN_HEAD_BYTES + BASH_SCAN_TAIL_BYTES + 1);
            expect(capped.startsWith(big.slice(0, 200))).toBe(true);
            expect(capped.endsWith(big.slice(-200))).toBe(true);
        });

        it('a secret in the HEAD or TAIL of an over-cap Bash log is still detected', () => {
            const filler = 'x'.repeat(200) + '\n';
            const noise = filler.repeat(Math.ceil((BASH_SCAN_HEAD_BYTES + BASH_SCAN_TAIL_BYTES) * 2 / filler.length));
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

        it('DOCUMENTED DEGRADATION: a secret ONLY in the skipped middle of an over-cap log is NOT detected', () => {
            // This pins the F70 trade-off exactly. If the cap is ever widened,
            // narrowed, or removed, this test flags the change in either direction.
            const filler = 'x'.repeat(200) + '\n';
            const half = filler.repeat(Math.ceil((BASH_SCAN_HEAD_BYTES + BASH_SCAN_TAIL_BYTES) / filler.length));
            const stdout = `${half}AWS_KEY=${fakeAwsKey()}\n${half}`;
            const writes = [];
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
            let result;
            try {
                result = processEvent({ tool_name: 'Bash', tool_input: { command: 'env' }, tool_response: { stdout } });
            } finally {
                stdoutSpy.mockRestore();
            }
            expect(result).toBeNull();
            expect(writes.join('')).not.toContain('REDACTED');
        });
    });
});
