// SF-1.8 review finding M1/J-2 (wrapper half): Claude Code blocks a PreToolUse call only on exit status 2.
// The generated entry point `.claude/hooks/path-guardrail.cjs` used to pass the child's status straight
// through (`status === null ? 1 : status`), so a hook that died before it could exit 2 (a syntax error in a
// required module exits 1) let the Write proceed. Every blocking PreToolUse hook's generated wrapper now
// fails closed: only a clean exit 0 passes; a crash, a spawn error, a signal and a timeout exit 2.
//
// Cases spawn the REAL generated wrapper text (from `compatibilityWrapper`) around a stub hook in a temp
// tree, so they pin the behaviour of the code Claude Code runs.
//
// NOT COVERED: a `spawnSync` start failure (`result.error` with code ENOENT/EACCES) cannot be induced for
// `process.execPath`; the timeout case covers the other `result.error` shape (ETIMEDOUT) through the same branch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { spawnSync } = require('node:child_process');
const { compatibilityWrapper, FAIL_CLOSED_HOOKS } = require('../_lib/shared-agents');
const { createTmpDir } = require('./_helpers/tmp-dir');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SETTINGS = path.join(ROOT, '.agents', 'adapters', 'claude', 'settings.json');

describe('SF-1.8 review M1/J-2 — blocking PreToolUse hook wrappers fail closed', () => {
    let tmp;
    beforeEach(() => { tmp = createTmpDir({ prefix: 'hook-wrapper-' }); });
    afterEach(() => tmp.cleanup());

    // Lay out a stub hook at its canonical path and the generated wrapper at the native path.
    function install(source, stubBody, output = `.claude/hooks/${path.posix.basename(source)}`) {
        tmp.write(source, stubBody);
        return tmp.write(output, compatibilityWrapper(source, output));
    }
    const runWrapper = (wrapperPath, env = {}) => {
        const r = spawnSync(process.execPath, [wrapperPath], {
            input: '{"tool_name":"Write"}',
            env: { ...process.env, ...env },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000,
        });
        return { exitCode: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
    };

    const SOURCES = [...FAIL_CLOSED_HOOKS.keys()];

    it('failClosedHooks_areExactlyTheBlockingPreToolUseHooksRegisteredInTheAuthoredSettings', () => {
        const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
        const registered = new Set();
        for (const group of settings.hooks.PreToolUse) {
            for (const hook of group.hooks) {
                const m = /\.claude\/hooks\/([A-Za-z0-9_.-]+\.cjs)/.exec(hook.command);
                if (m) registered.add(`.agents/hooks/${m[1]}`);
            }
        }

        expect([...registered].sort()).toEqual([...SOURCES].sort());
    });

    describe.each(SOURCES)('%s', (source) => {
        it('exit0_passesThrough_andTheChildsStdoutIsKept', () => {
            const wrapper = install(source, "process.stdout.write('{\"permissionDecision\":\"ask\"}'); process.exit(0);\n");

            const result = runWrapper(wrapper);

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe('{"permissionDecision":"ask"}');
        });

        it.each([
            [1, 'the non-blocking status a crash leaves'],
            [2, 'a block'],
            [3, 'an unknown status'],
            [70, 'a higher status'],
            [255, 'the highest status'],
        ])('exit%i_%s_becomesExit2', (status) => {
            const wrapper = install(source, `process.exit(${status});\n`);

            expect(runWrapper(wrapper).exitCode).toBe(2);
        });

        it('aSyntaxErrorInTheHookSource_whichNodeExitsWith1_becomesExit2', () => {
            const wrapper = install(source, 'this is not javascript ((\n');

            const result = runWrapper(wrapper);

            expect(result.exitCode).toBe(2);
        });

        it('anUncaughtThrowAtLoad_becomesExit2', () => {
            const wrapper = install(source, "throw new Error('boom at load');\n");

            expect(runWrapper(wrapper).exitCode).toBe(2);
        });

        it('aChildKilledBySignal_becomesExit2WithTheCauseNamed', () => {
            if (process.platform === 'win32') return; // NOT COVERED on win32: no POSIX signals
            const wrapper = install(source, "process.kill(process.pid, 'SIGKILL');\n");

            const result = runWrapper(wrapper);

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('BLOCKED (fail-closed)');
            expect(result.stderr).toContain('SIGKILL');
        });

        it('aMissingHookSource_becomesExit2', () => {
            const output = `.claude/hooks/${path.posix.basename(source)}`;
            const wrapper = tmp.write(output, compatibilityWrapper(source, output));

            expect(runWrapper(wrapper).exitCode).toBe(2);
        });

        it('theCodexProjection_isTheSameFailClosedWrapper_withTheRuntimeDefault', () => {
            const output = `.codex/hooks/${path.posix.basename(source)}`;
            const text = compatibilityWrapper(source, output);

            expect(text).toContain("process.env.AGENTS_RUNTIME = 'codex'");
            expect(text).toContain('result.status === 0 ? 0 : 2');
            const wrapper = install(source, 'process.exit(1);\n', output);
            expect(runWrapper(wrapper).exitCode).toBe(2);
        });

        it('theWrapperKeepsTheGeneratedHeaderTheUninstallerAndTheLintLookFor', () => {
            const output = `.claude/hooks/${path.posix.basename(source)}`;
            const text = compatibilityWrapper(source, output);

            expect(text).toContain(`// Generated compatibility entry point from ${source}.`);
            expect(text).toContain('windowsHide: true');
        });

        it('requiredAsAModule_exportsTheHooksExports_unchangedByTheStrictMain', () => {
            const wrapper = install(source, 'module.exports = { marker: 42 };\n');

            expect(require(wrapper)).toEqual({ marker: 42 });
        });
    });

    describe.each(SOURCES.filter((source) => FAIL_CLOSED_HOOKS.get(source) !== null))('%s with a spawn bound', (source) => {
        it('aSynchronousStallInTheHook_isCutOffByTheWrapperTimeout_andBecomesExit2', () => {
            // Atomics.wait blocks the event loop, so no in-process timer could fire: only the parent can end it.
            const wrapper = install(source, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);\n');
            const started = Date.now();

            const result = runWrapper(wrapper, { HOOK_WRAPPER_TIMEOUT_MS: '400' });

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('ETIMEDOUT');
            expect(Date.now() - started).toBeLessThan(15000);
        }, 30000);

        it('theDefaultSpawnBound_isAboveTheHooksInternalDeadlineAndBelowTheSettingsTimeout', () => {
            const output = `.claude/hooks/${path.posix.basename(source)}`;
            const wrapperBound = FAIL_CLOSED_HOOKS.get(source);
            const hookSource = fs.readFileSync(path.join(ROOT, source), 'utf8');
            const internal = Number(/HOOK_DEADLINE_MS, 10\) \|\| (\d+)/.exec(hookSource)[1]);

            expect(compatibilityWrapper(source, output)).toContain(`|| ${wrapperBound}`);
            // internal deadline < wrapper bound < the settings.json hook timeout (10 s)
            expect(internal).toBeLessThan(wrapperBound);
            expect(wrapperBound).toBeLessThan(10 * 1000);
        });
    });

    describe('hooks outside the blocking set', () => {
        it('aNonBlockingHookWrapper_stillPassesTheChildsStatusThrough_unchanged', () => {
            const source = '.agents/hooks/damage-control.cjs';
            const wrapper = install(source, 'process.exit(1);\n');

            expect(runWrapper(wrapper).exitCode).toBe(1);
            expect(compatibilityWrapper(source, '.claude/hooks/damage-control.cjs')).not.toContain('fail closed');
        });
    });

    describe('the checked-in generated wrappers', () => {
        it.each(SOURCES)('renderedWrappers_of_%s_equalTheGeneratorOutput_forClaudeAndCodex', (source) => {
            const name = path.posix.basename(source);
            for (const native of [`.claude/hooks/${name}`, `.codex/hooks/${name}`]) {
                expect(fs.readFileSync(path.join(ROOT, native), 'utf8'), native).toBe(compatibilityWrapper(source, native));
            }
        });
    });
});
