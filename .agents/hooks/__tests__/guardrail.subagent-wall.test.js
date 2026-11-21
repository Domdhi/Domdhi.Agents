// SF-1.8 review findings M1/J-2 and M2/J-6 for the Bash guard (`guardrail.cjs`).
//
//   M2/J-6  The Bash guard checked deletes against the path tiers but never passed `agent_id`, so a
//           subagent could `rm` a protected file, and every other Bash spelling of a write (`sed -i`, `cp`,
//           `mv`, `tee`, `dd of=`, a redirect, an inline `node -e`) was not path-checked at all. A subagent
//           now has its Bash writes checked against the same `subagentReadOnlyPaths` tier, best effort.
//           This is NOT a wall (an interpreter script, a variable-built path or a nested `claude -p` run
//           writes anywhere): the tests pin what IS caught and name what is not (NOT COVERED below).
//   M1/J-2  Top-level requires sit inside a try: a dependency that fails to load exits 2 for every payload
//           (the hook cannot tell the main thread from a subagent), never the non-blocking status 1.
//
// Every in-process case runs the real `processEvent` against the AUTHORED `.agents/config/guardrail-rules.yaml`
// copied into a scratch project.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { spawnSync, spawn } = require('node:child_process');

const HOOK_DIR = path.resolve(__dirname, '..');
const AGENTS_DIR = path.resolve(HOOK_DIR, '..');
const AUTHORED_RULES = path.join(AGENTS_DIR, 'config', 'guardrail-rules.yaml');
const GUARDRAIL = path.join(HOOK_DIR, 'guardrail.cjs');

describe('SF-1.8 review M2/J-6 — a subagent’s Bash writes are checked against the subagent tier', () => {
    let tmp;
    let originalDir;
    let processEvent;
    let extractWriteTargets;
    let extractInlineScriptTargets;
    const SUBAGENT = { agent_id: 'agent-3', agent_type: 'implementer' };

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'guardrail-sf18-' });
        originalDir = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        tmp.write('.claude/guardrail-rules.yaml', fs.readFileSync(AUTHORED_RULES, 'utf8'));
        ({ processEvent, extractWriteTargets, extractInlineScriptTargets } = require('../guardrail.cjs'));
    });

    afterEach(() => {
        if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = originalDir;
        tmp.cleanup();
    });

    const run = (command, extra = {}) => processEvent({ tool_name: 'Bash', tool_input: { command }, ...extra });
    const tierOf = (result) => (result && result.telemetry ? result.telemetry.tier : undefined);

    describe('deletes carry agent_id into checkPathAccess', () => {
        it.each([
            ['rm .agents/core/gate.js'],
            ['rm .claude/settings.json'],
            ['rm -f .agents/core/_lib/hook-input.js'],
            ['Remove-Item .agents/hooks/path-guardrail.cjs'],
            ['unlink .claude/settings.local.json'],
            ['rm docs/.output/.state/freeze-state.json'],
        ])('processEvent_subagent_%s_isBlockedBySubagentReadOnlyPaths', (command) => {
            const result = run(command, SUBAGENT);

            expect(result).toMatchObject({ block: true });
            expect(tierOf(result)).toBe('subagentReadOnlyPaths');
        });

        it('processEvent_mainThreadDeleteOfTheSameFile_isNotBlockedByTheSubagentTier', () => {
            expect(run('rm .agents/core/gate.js')).toBeNull();
            expect(run('rm .claude/settings.json')).toBeNull();
        });

        it.each([
            ['an empty string', ''],
            ['zero', 0],
            ['null', null],
            ['false', false],
        ])('processEvent_agentIdThatIs_%s_stillCountsAsASubagent', (_label, agentId) => {
            expect(run('rm .agents/core/gate.js', { agent_id: agentId })).toMatchObject({ block: true });
        });

        it('processEvent_agentTypeWithoutAgentId_isTheMainThread', () => {
            expect(run('rm .agents/core/gate.js', { agent_type: 'implementer' })).toBeNull();
        });
    });

    describe('write verbs target the tier', () => {
        it.each([
            ["sed -i 's/exit(2)/exit(0)/' .agents/hooks/path-guardrail.cjs"],
            ['sed -i.bak s/a/b/ .agents/core/gate.js'],
            ['sed --in-place s/a/b/ .claude/settings.json'],
            ['sed -Ei s/a/b/ .agents/core/_lib/hook-input.js'],
            ["perl -pi -e 's/a/b/' .agents/core/ship-check.js"],
            ['cp /tmp/evil.js .agents/core/gate.js'],
            ['cp -f /tmp/evil.js .agents/core/_lib/yaml-parser.js'],
            ['cp /tmp/gate.js .agents/core/'],
            ['cp /tmp/x.js .agents/hooks/'],
            ['cp -t .agents/core /tmp/gate.js'],
            ['mv /tmp/evil.js .agents/core/gate.js'],
            ['mv .agents/core/gate.js /tmp/gate.bak'],
            ['install -m 644 /tmp/x .agents/core/commit.js'],
            ['ln -sf /tmp/evil.js .agents/core/gate.js'],
            ['tee .agents/core/gate.js < /tmp/evil.js'],
            ['echo x | tee -a .claude/settings.local.json'],
            ['dd if=/tmp/evil of=.agents/core/gate.js'],
            ['cat /tmp/e >> .agents/core/gate.js'],
            ["echo '{\"disableAllHooks\":true}' > .claude/settings.local.json"],
            ['sudo cp /tmp/evil.js .agents/core/gate.js'],
            ['/bin/cp /tmp/evil.js .agents/core/gate.js'],
            ['ls && cp /tmp/evil.js .agents/core/gate.js; echo done'],
            ['if true; then cp /tmp/evil.js .agents/core/gate.js; fi'],
            ['sed -i s/a/b/ vitest.config.mjs'],
            ['cp /tmp/evil.js vitest.config.mjs'],
            // security M3 / m3 / M4: the runner package, the configs vitest ranks first, the hook-loaded libraries
            ['echo x > node_modules/vitest/vitest.mjs'],
            ['cp /tmp/evil.js node_modules/vitest/dist/reporters.js'],
            ["sed -i 's/fail/pass/' node_modules/vitest/vitest.mjs"],
            ['cp /tmp/evil.js vitest.config.ts'],
            ['echo x > vite.config.ts'],
            ['sed -i s/a/b/ .agents/core/_lib/memory-context.js'],
            ['cp /tmp/evil.js .agents/core/_lib/memory-recall.js'],
            ['tee .agents/core/profile.js < /tmp/evil.js'],
            ['cp /tmp/x docs/.output/.state/telemetry/gate-failures.jsonl'],
            ['tee docs/.output/.state/freeze-state.json < /dev/null'],
        ])('processEvent_subagent_%s_isBlockedBySubagentReadOnlyPaths', (command) => {
            const result = run(command, SUBAGENT);

            expect(result).toMatchObject({ block: true });
            expect(tierOf(result)).toBe('subagentReadOnlyPaths');
        });

        it('processEvent_subagentCopyOntoTheProjectOverride_isBlockedByTheReadOnlyTier', () => {
            // The escalation path in the review: `cp` of a file with `except: subagentReadOnlyPaths` lifts the wall.
            const result = run('cp /tmp/x .claude/guardrail-rules.project.yaml', SUBAGENT);

            expect(result).toMatchObject({ block: true });
            expect(tierOf(result)).toBe('readOnlyPaths');
        });

        it.each([
            ['cp /tmp/a.txt src/a.txt'],
            ['sed -i s/a/b/ src/app.js'],
            ["sed -i 's/exit(2)/exit(0)/' src/app.js"],
            ['tee out.log'],
            ['mv src/a.js src/b.js'],
            ['cp .agents/core/gate.js /tmp/gate.copy'],
            ['cat .agents/core/gate.js'],
            ['sed -n 1,5p .agents/core/gate.js'],
            ['grep -r hook .agents/hooks/'],
            ['git diff -- .agents/core/gate.js'],
            ['ls .claude/'],
            ['cat /tmp/e > src/out.txt'],
            ['cat node_modules/vitest/package.json'],
            ['npm install'],
            ['npx vitest run'],
        ])('processEvent_subagent_%s_isNotOverBlocked', (command) => {
            expect(run(command, SUBAGENT)).toBeNull();
        });

        it('processEvent_mainThreadWriteToTheSameFiles_isNotBlockedByTheSubagentTier', () => {
            expect(run("sed -i 's/exit(2)/exit(0)/' .agents/hooks/path-guardrail.cjs")).toBeNull();
            expect(run('cp /tmp/evil.js .agents/core/gate.js')).toBeNull();
            expect(run('tee .claude/settings.local.json < /tmp/x')).toBeNull();
        });

        it('processEvent_aProjectOverrideThatLiftsAnEntry_isHonoredForBashWritesToo', () => {
            tmp.write('.claude/guardrail-rules.project.yaml', 'except:\n  subagentReadOnlyPaths:\n    - .agents/core/gate.js\n');

            expect(run('cp /tmp/evil.js .agents/core/gate.js', SUBAGENT)).toBeNull();
            expect(run('cp /tmp/evil.js .agents/core/commit.js', SUBAGENT)).toMatchObject({ block: true });
        });
    });

    describe('inline interpreter scripts (best effort)', () => {
        it.each([
            ["node -e \"require('fs').writeFileSync('.agents/core/gate.js','')\""],
            ['node -e \'require("fs").appendFileSync(".claude/settings.json","x")\''],
            ["python3 -c \"open('.agents/core/gate.js','w').write('')\""],
            ["python -c \"import shutil; shutil.copy('/tmp/e', '.claude/settings.local.json')\""],
            ["node -p \"require('fs').renameSync('/tmp/e','.agents/core/commit.js')\""],
            ["pwsh -Command \"Set-Content -Path '.claude/settings.json' -Value x\""],
        ])('processEvent_subagent_%s_isBlocked', (command) => {
            const result = run(command, SUBAGENT);

            expect(result).toMatchObject({ block: true });
            expect(tierOf(result)).toBe('subagentReadOnlyPaths');
        });

        it.each([
            ["node -e \"console.log(require('./package.json').version)\""],
            ["node -e \"require('fs').writeFileSync('out.txt','x')\""],
            ["python3 -c \"print(open('.agents/core/gate.js').read())\""],
            ["node -e \"console.log(require('fs').readFileSync('.agents/core/gate.js','utf8').length)\""],
        ])('processEvent_subagent_%s_isNotOverBlocked', (command) => {
            expect(run(command, SUBAGENT)).toBeNull();
        });

        it('extractInlineScriptTargets_aCommandWithoutAnInterpreterInlineFlagAndWriteApi_yieldsNothing', () => {
            expect(extractInlineScriptTargets("node script.js '.agents/core/gate.js'")).toEqual([]);
            expect(extractInlineScriptTargets("echo 'writeFileSync .agents/core/gate.js'")).toEqual([]);
            expect(extractInlineScriptTargets("node -e \"console.log('.agents/core/gate.js')\"")).toEqual([]);
        });

        it('extractInlineScriptTargets_nestedLiterals_areAllReturned', () => {
            expect(extractInlineScriptTargets("node -e \"fs.writeFileSync('a/b.js','c')\"")).toContain('a/b.js');
        });

        it('extractInlineScriptTargets_nonStringInput_yieldsNothing', () => {
            expect(extractInlineScriptTargets(undefined)).toEqual([]);
            expect(extractInlineScriptTargets(42)).toEqual([]);
        });
    });

    describe('extractWriteTargets', () => {
        it.each([
            ['cp a b', ['b', 'b/a']],
            ['cp -t dest a b', ['dest', 'dest/a', 'dest/b']],
            ['cp --target-directory=dest a', ['dest', 'dest/a']],
            ['mv a b', ['b', 'b/a', 'a']],
            ['tee -a f g', ['f', 'g']],
            ['dd if=x of=y', ['y']],
            ['sed -i s/a/b/ f', ['s/a/b/', 'f']],
            ["sed -i 's/(a)/(b)/' f", ['s/(a)/(b)/', 'f']],
            ['sed -n 1p f', []],
            ['awk -i inplace x f', ['x', 'f']],
            ['ls -la', []],
        ])('extractWriteTargets_%s', (command, expected) => {
            expect(extractWriteTargets(command)).toEqual(expected);
        });

        it('extractWriteTargets_nonStringOrEmpty_yieldsNothing', () => {
            expect(extractWriteTargets('')).toEqual([]);
            expect(extractWriteTargets(null)).toEqual([]);
        });
    });

    describe('an unusable rules file does not free a subagent', () => {
        it('processEvent_missingRulesFile_subagentBashWriteToTheGateIsBlockedByTheBuiltInDefaults', () => {
            fs.rmSync(path.join(tmp.root, '.claude', 'guardrail-rules.yaml'));

            expect(run('cp /tmp/evil.js .agents/core/gate.js', SUBAGENT)).toMatchObject({ block: true });
            expect(run('rm .agents/core/gate.js', SUBAGENT)).toMatchObject({ block: true });
        });

        it('processEvent_missingRulesFile_mainThreadStillPassesThrough', () => {
            fs.rmSync(path.join(tmp.root, '.claude', 'guardrail-rules.yaml'));

            expect(run('cp /tmp/evil.js .agents/core/gate.js')).toBeNull();
        });

        it('processEvent_missingRulesFile_subagentOrdinaryCommandStillPasses', () => {
            fs.rmSync(path.join(tmp.root, '.claude', 'guardrail-rules.yaml'));

            expect(run('cp /tmp/a.txt src/a.txt', SUBAGENT)).toBeNull();
        });

        it('processEvent_parsedRulesFileWithoutTheTierKey_subagentBashWriteIsStillBlocked', () => {
            tmp.write('.claude/guardrail-rules.yaml', 'zeroAccessPaths:\n  - secrets.txt\n');

            expect(run('sed -i s/a/b/ .agents/core/gate.js', SUBAGENT)).toMatchObject({ block: true });
            expect(run('sed -i s/a/b/ .agents/core/gate.js')).toBeNull();
        });
    });

    // NOT COVERED (stated in the guardrail.cjs and path-guardrail.cjs headers and the yaml tier comment, and
    // the reason the ship seal's code hash plus review stay the backstop): a script FILE that writes, a path
    // built from variables, a symlink onto a protected path, a `cd` to a variable-built directory, and a
    // nested `claude -p` / `codex exec` run (a new main thread with no agent_id).
    it('commands_outsideTheBestEffortCoverage_arePassedAndTheLimitIsDocumentedInTheHeader', () => {
        // Arrange: the honest limits, pinned so a reader knows the tier is not a Bash wall
        const source = fs.readFileSync(GUARDRAIL, 'utf8');
        const header = source.slice(0, source.indexOf("'use strict'"));

        // Assert: the documented limits match behavior
        expect(run('node write-gate.js', SUBAGENT)).toBeNull();
        expect(run('claude -p "edit the gate"', SUBAGENT)).toBeNull();
        expect(header).toMatch(/BEST-EFFORT/);
        expect(header).toMatch(/NOT a wall/);
        expect(header).toMatch(/claude -p/);
        expect(header).toMatch(/code hash/);
    });
});

// ─── M1/J-2: a load failure exits 2 ──────────────────────────────────────────

describe('SF-1.8 review M1/J-2 — guardrail.cjs fails closed when a dependency does not load', () => {
    let tmp;

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'guardrail-load-' });
        const hooksDir = path.join(tmp.root, '.agents', 'hooks');
        const libDir = path.join(tmp.root, '.agents', 'core', '_lib');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.mkdirSync(libDir, { recursive: true });
        fs.copyFileSync(GUARDRAIL, path.join(hooksDir, 'guardrail.cjs'));
        const sourceLib = path.join(AGENTS_DIR, 'core', '_lib');
        for (const name of fs.readdirSync(sourceLib)) {
            if (name.endsWith('.js')) fs.copyFileSync(path.join(sourceLib, name), path.join(libDir, name));
        }
        tmp.write('.claude/guardrail-rules.yaml', fs.readFileSync(AUTHORED_RULES, 'utf8'));
    });

    afterEach(() => tmp.cleanup());

    const copyHook = () => path.join(tmp.root, '.agents', 'hooks', 'guardrail.cjs');
    const lib = (name) => path.join(tmp.root, '.agents', 'core', '_lib', name);
    const spawnCopy = (stdin, env = {}) => {
        const r = spawnSync(process.execPath, [copyHook()], {
            input: stdin,
            env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, ...env },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000,
        });
        return { exitCode: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
    };
    const benign = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls src' } });
    const subagent = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls src' }, agent_id: 'a1' });

    it('control_anIntactCopy_passesABenignCommandFromTheMainThreadAndASubagent', () => {
        expect(spawnCopy(benign).exitCode).toBe(0);
        expect(spawnCopy(subagent).exitCode).toBe(0);
    });

    it.each([
        ['a syntax error in hook-input.js', () => fs.appendFileSync(lib('hook-input.js'), '\n)(\n')],
        ['a throw at load in yaml-parser.js', () => fs.appendFileSync(lib('yaml-parser.js'), "\nthrow new Error('boom at load');\n")],
        ['a missing command-blocker.js', () => fs.rmSync(lib('command-blocker.js'))],
        ['a syntax error in shell-command-split.js', () => fs.appendFileSync(lib('shell-command-split.js'), '\n}}}\n')],
        ['a missing hook-telemetry.js', () => fs.rmSync(lib('hook-telemetry.js'))],
    ])('spawnedHook_with_%s_exits2ForAnyPayload', (_label, corrupt) => {
        corrupt();

        for (const stdin of [benign, subagent, '', 'not json']) {
            const result = spawnCopy(stdin);

            expect(result.exitCode, `stdin=${JSON.stringify(stdin)} stderr=${result.stderr}`).toBe(2);
            expect(result.stderr).toContain('could not load its dependencies');
        }
    });

    it('require_aCopyWithABrokenDependency_throwsInsteadOfExportingAHalfLoadedHook', () => {
        fs.appendFileSync(lib('hook-input.js'), '\n)(\n');

        expect(() => require(copyHook())).toThrow();
    });

    it('spawnedHook_stdinThatNeverCloses_pastTheDeadline_exits2WithTheDeadlineNamed', async () => {
        const child = spawn(process.execPath, [copyHook()], {
            env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, HOOK_STDIN_TIMEOUT_MS: '30000', HOOK_DEADLINE_MS: '250' },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        child.stdin.write('{"tool_name":"Bash"'); // truncated; stdin intentionally left open
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c; });
        const exitCode = await new Promise((resolve) => child.on('exit', resolve));

        expect(exitCode).toBe(2);
        expect(stderr).toContain('deadline');
    }, 15000);
});
