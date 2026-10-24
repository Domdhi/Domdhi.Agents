// Tests for telemetry-log.js — self-instrumentation for user-typed slash
// commands that don't fire PostToolUse:Skill (the documented coverage gap in
// command-usage-logger.cjs). Verifies logCommand writes a well-formed
// command_invocation row to command-usage.jsonl under the resolved project root.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { logCommand, MAX_JSONL_LINES, TAIL_KEEP_LINES } = require('../../../.agents/core/telemetry-log');
const { createTmpDir } = require('./_helpers/tmp-dir');

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'telemetry-log-test-' }); });
afterEach(() => { tmp.cleanup(); vi.restoreAllMocks(); });

function readRows(root) {
    const p = path.join(root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
    return fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// logCommand — write path
// ---------------------------------------------------------------------------

describe('telemetry-log.logCommand', () => {
    it('writesCommandInvocationRow_withSelfInstrumentedSource', () => {
        logCommand('onboard', null, tmp.root);

        const rows = readRows(tmp.root);
        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe('command_invocation');
        expect(rows[0].command).toBe('onboard');
        expect(rows[0].source).toBe('self-instrumented');
        expect(rows[0].duration_ms).toBeNull();
        expect(typeof rows[0].timestamp).toBe('string');
    });

    it('coercesNumericDuration_andLeavesNaNAsNull', () => {
        logCommand('run-todo', 8500, tmp.root);
        logCommand('do', Number('nope'), tmp.root);

        const rows = readRows(tmp.root);
        expect(rows[0].duration_ms).toBe(8500);
        expect(rows[1].duration_ms).toBeNull();
    });

    it('appendsRatherThanOverwrites', () => {
        logCommand('onboard', null, tmp.root);
        logCommand('prime', null, tmp.root);

        const rows = readRows(tmp.root);
        expect(rows.map(r => r.command)).toEqual(['onboard', 'prime']);
    });

    it('returns the written event object', () => {
        const event = logCommand('sweep', 1234, tmp.root);
        expect(event.type).toBe('command_invocation');
        expect(event.command).toBe('sweep');
        expect(event.duration_ms).toBe(1234);
        expect(event.source).toBe('self-instrumented');
    });

    it('treats non-number durationMs as null', () => {
        // Passing a string that looks like a number (not a JS number) → null
        const event = logCommand('do', undefined, tmp.root);
        expect(event.duration_ms).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// trim-to-tail path
// ---------------------------------------------------------------------------

describe('telemetry-log trim-to-tail', () => {
    it('trims file to TAIL_KEEP_LINES when line count exceeds MAX_JSONL_LINES', () => {
        // Pre-fill the JSONL file with MAX_JSONL_LINES rows
        const jsonlPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'command-usage.jsonl');
        fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });

        // Write exactly MAX_JSONL_LINES rows
        const prefillLines = Array.from({ length: MAX_JSONL_LINES }, (_, i) =>
            JSON.stringify({ type: 'command_invocation', command: `cmd-${i}`, seq: i })
        ).join('\n') + '\n';
        fs.writeFileSync(jsonlPath, prefillLines, 'utf8');

        // One more append pushes it over the limit → triggers tail rotation
        logCommand('trigger-trim', null, tmp.root);

        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.trim().split('\n');

        // After trim: exactly TAIL_KEEP_LINES rows remain
        expect(lines.length).toBe(TAIL_KEEP_LINES);

        // The last line must be the row we just appended
        const last = JSON.parse(lines[lines.length - 1]);
        expect(last.command).toBe('trigger-trim');
    });
});

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('telemetry-log exports', () => {
    it('exports MAX_JSONL_LINES and TAIL_KEEP_LINES as positive integers', () => {
        expect(typeof MAX_JSONL_LINES).toBe('number');
        expect(MAX_JSONL_LINES).toBeGreaterThan(0);
        expect(typeof TAIL_KEEP_LINES).toBe('number');
        expect(TAIL_KEEP_LINES).toBeGreaterThan(0);
        expect(TAIL_KEEP_LINES).toBeLessThan(MAX_JSONL_LINES);
    });
});

// ---------------------------------------------------------------------------
// getProjectRoot — covered by calling logCommand without explicit projectRoot
// (the function reads CLAUDE_PROJECT_DIR at call time, not load time)
// ---------------------------------------------------------------------------

describe('telemetry-log.getProjectRoot (via env)', () => {
    it('uses CLAUDE_PROJECT_DIR when no explicit projectRoot is passed', () => {
        const savedEnv = process.env.CLAUDE_PROJECT_DIR;
        try {
            process.env.CLAUDE_PROJECT_DIR = tmp.root;
            // Call logCommand without the 3rd arg → getProjectRoot() runs (line 48)
            logCommand('env-test');
        } finally {
            if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = savedEnv;
        }

        const rows = readRows(tmp.root);
        expect(rows.some(r => r.command === 'env-test')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// CLI main guard — in-process coverage via Module._compile injection
//
// Background: require.main === module is always false when a file is loaded
// via require() rather than being the Node entry point. The standard fix is
// to spawn a subprocess (execFileSync), but subprocess execution does not
// contribute to the parent's v8 coverage instrument.
//
// Workaround: monkey-patch Module.prototype._compile to prepend
// `require.main = module;` to the target file's source before it executes.
// This makes the main guard fire in-process, so v8 instruments lines 74-84.
// The patch is scoped to the target file only and is always restored.
// ---------------------------------------------------------------------------

describe('telemetry-log CLI main guard (in-process via _compile injection)', () => {
    const Module = require('node:module');
    const TELEMETRY_LOG_JS = path.resolve(__dirname, '../../../.agents/core/telemetry-log.js');

    /**
     * Run telemetry-log.js's main guard in-process by:
     *  1. Prepending `require.main = module;` via _compile hook
     *  2. Injecting process.argv
     *  3. Catching process.exit via spy
     *  4. Restoring everything in finally
     */
    function runMainInProcess(argv) {
        const origCompile = Module.prototype._compile;
        const origArgv = process.argv;
        const origEnv = process.env.CLAUDE_PROJECT_DIR;

        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        process.argv = ['node', TELEMETRY_LOG_JS, ...argv];

        // Inject `require.main = module;` into the module source so the main guard
        // fires when require() re-executes the file. Must be inserted AFTER the
        // shebang line (if present) — `#!` is only valid on line 1.
        Module.prototype._compile = function (code, filename) {
            if (filename === TELEMETRY_LOG_JS) {
                if (code.startsWith('#!')) {
                    const nlIdx = code.indexOf('\n');
                    code = code.slice(0, nlIdx + 1) + 'require.main = module;\n' + code.slice(nlIdx + 1);
                } else {
                    code = 'require.main = module;\n' + code;
                }
            }
            return origCompile.call(this, code, filename);
        };

        delete require.cache[TELEMETRY_LOG_JS];

        let exitCode;
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            exitCode = code;
            throw new Error(`process.exit(${code})`);
        });

        try {
            require(TELEMETRY_LOG_JS);
        } catch (e) {
            // Expected: process.exit() throws via our spy
        } finally {
            Module.prototype._compile = origCompile;
            process.argv = origArgv;
            if (origEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = origEnv;
            delete require.cache[TELEMETRY_LOG_JS];
            exitSpy.mockRestore();
        }

        return { exitCode };
    }

    it('exits with code 2 when no command name is provided', () => {
        const { exitCode } = runMainInProcess([]);
        expect(exitCode).toBe(2);
    });

    it('exits with code 0 when a command name is provided', () => {
        const { exitCode } = runMainInProcess(['onboard']);
        expect(exitCode).toBe(0);
    });

    it('writes a row to command-usage.jsonl when called with a command name', () => {
        runMainInProcess(['prime']);

        const rows = readRows(tmp.root);
        expect(rows.some(r => r.command === 'prime')).toBe(true);
    });

    it('parses optional duration_ms argument from process.argv', () => {
        runMainInProcess(['do', '4200']);

        const rows = readRows(tmp.root);
        const row = rows.find(r => r.command === 'do');
        expect(row).toBeDefined();
        expect(row.duration_ms).toBe(4200);
    });

    it('treats non-numeric duration arg as null', () => {
        runMainInProcess(['sweep', 'notanumber']);

        const rows = readRows(tmp.root);
        const row = rows.find(r => r.command === 'sweep');
        expect(row).toBeDefined();
        expect(row.duration_ms).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// CLI main guard — subprocess via execFileSync (correctness verification)
// These run in a subprocess so don't count toward in-process v8 coverage,
// but verify the real CLI behavior is correct.
// ---------------------------------------------------------------------------

describe('telemetry-log CLI main guard (subprocess)', () => {
    const { execFileSync } = require('node:child_process');
    const TELEMETRY_LOG_JS = path.resolve(__dirname, '../../../.agents/core/telemetry-log.js');

    function runCli(argv, envOverrides = {}) {
        try {
            const stdout = execFileSync(
                'node',
                [TELEMETRY_LOG_JS, ...argv],
                {
                    encoding: 'utf8',
                    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, ...envOverrides },
                }
            );
            return { status: 0, stdout };
        } catch (e) {
            return { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
        }
    }

    it('exits with code 2 when no command name is provided', () => {
        const { status } = runCli([]);
        expect(status).toBe(2);
    });

    it('exits with code 0 when a command name is provided', () => {
        const { status } = runCli(['onboard']);
        expect(status).toBe(0);
    });
});
