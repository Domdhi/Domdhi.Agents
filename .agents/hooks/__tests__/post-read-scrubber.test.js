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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const { processEvent, extractOutput, inferToolKind } = require('../../../.agents/hooks/post-read-scrubber.cjs');

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

        // The redactor is given the file path, so a code reference in a source file that
        // sits beside a real secret is not redacted along with it.
        // The read path mirrors the scanner's write path: a test/spec file is NOT skipped, it is
        // scanned for named providers only. The union skip used here before let a real provider key
        // in a `.test.ts` be write-BLOCKED yet read back into context completely unredacted.
        it('processEvent_readTestFileWithRealProviderKey_isRedacted', () => {
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Read',
                    tool_input: { file_path: '/repo/src/auth.test.ts' },
                    tool_response: { content: `const key = "${fakeAwsKey()}";` },
                });
                const out = stdoutSpy.mock.calls.map(c => c[0]).join('');
                expect(out).toMatch(/<REDACTED:AWS Access Key>/);
                expect(out).not.toContain(fakeAwsKey());
            } finally {
                stdoutSpy.mockRestore();
            }
        });

        it('processEvent_readTestFileWithGenericPasswordFixture_isLeftAlone', () => {
            // Named providers only: a generic Password Assignment fixture in a test is not a leak.
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Read',
                    tool_input: { file_path: '/repo/src/auth.test.ts' },
                    tool_response: { content: 'const fixture = { password: "correct-horse-battery" };' },
                });
                expect(stdoutSpy.mock.calls.map(c => c[0]).join('')).toBe('');
            } finally {
                stdoutSpy.mockRestore();
            }
        });

        it('processEvent_readHardSkippedPath_isNotScanned', () => {
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Read',
                    tool_input: { file_path: '/repo/package-lock.json' },
                    tool_response: { content: `"integrity": "${fakeAwsKey()}"` },
                });
                expect(stdoutSpy.mock.calls.map(c => c[0]).join('')).toBe('');
            } finally {
                stdoutSpy.mockRestore();
            }
        });

        it('processEvent_readSourceFile_redactsSecretButKeepsCodeReference', () => {
            const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
            try {
                processEvent({
                    tool_name: 'Read',
                    tool_input: { file_path: '/repo/src/app.ts' },
                    tool_response: { content: `const password = String(body.password ?? "");\nconst k = "${fakeAwsKey()}";` },
                });
                const out = stdoutSpy.mock.calls.map(c => c[0]).join('');
                expect(out).toMatch(/<REDACTED:AWS Access Key>/);
                expect(out).toContain('String(body.password ?? \\"\\")');
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

// ─── The scrubber never blocks, even when the secret engine cannot run ───────────
// A PostToolUse hook cannot block, and it must not leave tool output unredacted just because
// the engine is missing or broken: it falls back to the named-provider list. (The Write/Edit
// hook and the commit scan fail CLOSED on the same condition; see secret-engine.test.js.)

describe('post-read-scrubber with a broken engine (spawned hook)', () => {
    const hook = path.join(__dirname, '..', 'post-read-scrubber.cjs');
    const { createFakeEngineKit } = require('./_helpers/fake-engine');
    let tmp;
    let kit;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scrubber-engine-'));
        kit = createFakeEngineKit(path.join(tmp, 'kit'));
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const run = (engineBin, payload, extra = {}) => spawnSync(process.execPath, [hook], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, AGENTS_SECRET_ENGINE_BIN: engineBin, CLAUDE_PROJECT_DIR: tmp, ...extra },
    });
    const bash = stdout => ({ tool_name: 'Bash', tool_input: { command: 'env' }, tool_response: { stdout } });
    const fake = body => ({ engine: kit.exe(path.join(tmp, 'engine' + (process.platform === 'win32' ? '.exe' : ''))), env: kit.childEnv(body) });

    it.each([
        ['missing', () => ({ engine: path.join(tmp, 'no-such-engine'), env: {} })],
        ['exiting non-zero', () => fake("process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(6));")],
        ['printing garbage', () => fake("process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('}{'));")],
        ['reporting that it scanned nothing', () => fake("process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>{process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n');console.log('[]');});")],
    ])('exits 0 and still redacts a named-provider key when the engine is %s', (_name, make) => {
        const { engine, env } = make();
        const r = run(engine, bash(`AWS_KEY=${fakeAwsKey()}\n`), env);
        expect(r.status).toBe(0);
        const payload = JSON.parse(r.stdout.trim());
        expect(payload.hookSpecificOutput.updatedToolOutput).toBe('AWS_KEY=<REDACTED:AWS Access Key>\n');
        expect(r.stderr).toMatch(/named-provider fallback/);
    });

    it('exits 0 and prints nothing for clean output when the engine is missing', () => {
        const r = run(path.join(tmp, 'no-such-engine'), bash('all good\n'));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
    });
});
