// AC→source map (path-guardrail.cjs):
//   GATED_TOOLS contains 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'
//   processEvent({tool_name not in GATED_TOOLS}) → null
//   processEvent({tool_name:'Write', no file_path}) → null
//   processEvent on zeroAccessPaths match → block result
//   processEvent on readOnlyPaths write match → block result
//   processEvent on noDeletePaths write → null (write is allowed in noDelete tier)
//   processEvent on safe path → null
//   frozen path takes precedence over tier check → block with FROZEN PATH stderr
//   missing rules file → null (graceful pass-through)
//   MultiEdit blocks via tool_input.file_path
//   NotebookEdit blocks via tool_input.notebook_path
//   NotebookEdit without notebook_path → null
//   getTargetPath returns notebook_path for NotebookEdit, file_path otherwise

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

let tmp;
let savedProjectDir;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'path-guardrail-' });
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    // Force re-require so getProjectRoot() picks up the new env var.
    delete require.cache[require.resolve('../../../.agents/hooks/path-guardrail.cjs')];
});

afterEach(() => {
    tmp.cleanup();
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
});

function writeRules(yamlContent) {
    return tmp.write('.claude/guardrail-rules.yaml', yamlContent);
}

function writeFreezeState(absPaths) {
    return tmp.write('docs/.output/.state/freeze-state.json', JSON.stringify({ frozen: absPaths }));
}

// ─── tool dispatch ────────────────────────────────────────────────────────────

describe('path-guardrail processEvent — tool dispatch', () => {
    it('returns null for Bash tool (not gated)', () => {
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({ tool_name: 'Bash', tool_input: { command: 'ls' } });
        expect(result).toBeNull();
    });

    it('returns null for Read tool (not gated)', () => {
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({ tool_name: 'Read', tool_input: { file_path: '.env' } });
        expect(result).toBeNull();
    });

    it('returns null when Write tool has no file_path', () => {
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({ tool_name: 'Write', tool_input: {} });
        expect(result).toBeNull();
    });
});

// ─── tier enforcement ─────────────────────────────────────────────────────────

describe('path-guardrail processEvent — tier enforcement', () => {
    it('blocks Write to a zeroAccessPaths-matched path', () => {
        writeRules([
            'block_patterns:',
            'confirm_patterns:',
            'zeroAccessPaths:',
            '  - .env',
            'readOnlyPaths:',
            'noDeletePaths:',
            '',
        ].join('\n'));
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'Write',
            tool_input: { file_path: '.env', content: 'FOO=bar' },
        });
        expect(result).not.toBeNull();
        expect(result.block).toBe(true);
        expect(result.feedback).toContain('BLOCKED');
        expect(result.feedback).toContain('zeroAccessPaths');
    });

    it('blocks Edit on a readOnlyPaths-matched path', () => {
        writeRules([
            'block_patterns:',
            'confirm_patterns:',
            'zeroAccessPaths:',
            'readOnlyPaths:',
            '  - package-lock.json',
            'noDeletePaths:',
            '',
        ].join('\n'));
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'Edit',
            tool_input: { file_path: 'package-lock.json', new_string: 'x' },
        });
        expect(result).not.toBeNull();
        expect(result.block).toBe(true);
        expect(result.feedback).toContain('readOnlyPaths');
    });

    it('allows Write to a noDeletePaths-only-matched path (write is permitted)', () => {
        writeRules([
            'block_patterns:',
            'confirm_patterns:',
            'zeroAccessPaths:',
            'readOnlyPaths:',
            'noDeletePaths:',
            '  - logs/',
            '',
        ].join('\n'));
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'Write',
            tool_input: { file_path: 'logs/output.log', content: 'x' },
        });
        expect(result).toBeNull();
    });

    it('allows Write to a path matching no tier', () => {
        writeRules([
            'block_patterns:',
            'confirm_patterns:',
            'zeroAccessPaths:',
            '  - .env',
            'readOnlyPaths:',
            'noDeletePaths:',
            '',
        ].join('\n'));
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'Write',
            tool_input: { file_path: 'src/app.ts', content: 'x' },
        });
        expect(result).toBeNull();
    });
});

// ─── freeze-state precedence ──────────────────────────────────────────────────

describe('path-guardrail processEvent — freeze-state', () => {
    it('blocks Edit on a frozen absolute path', () => {
        writeRules('block_patterns:\nconfirm_patterns:\n');
        // Freeze the absolute path the hook will resolve to.
        const targetRel = 'src/under-investigation.ts';
        const targetAbs = path.resolve(tmp.root, targetRel);
        writeFreezeState([targetAbs]);

        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'Edit',
            tool_input: { file_path: targetRel, new_string: 'x' },
        });
        expect(result).not.toBeNull();
        expect(result.block).toBe(true);
        expect(result.feedback).toContain('FROZEN PATH');
        expect(result.feedback).toContain(targetAbs);
    });

    it('frozen path takes precedence over tier rules', () => {
        // Even though .eslintrc is in readOnlyPaths, the frozen-state response
        // is what surfaces — proving freeze-state runs first.
        writeRules([
            'block_patterns:',
            'confirm_patterns:',
            'readOnlyPaths:',
            '  - .eslintrc.json',
            '',
        ].join('\n'));
        const targetRel = '.eslintrc.json';
        const targetAbs = path.resolve(tmp.root, targetRel);
        writeFreezeState([targetAbs]);

        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'Edit',
            tool_input: { file_path: targetRel, new_string: 'x' },
        });
        expect(result).not.toBeNull();
        expect(result.feedback).toContain('FROZEN PATH'); // freeze message, not tier message
    });
});

// ─── graceful degradation ─────────────────────────────────────────────────────

describe('path-guardrail processEvent — graceful degradation', () => {
    it('passes through when guardrail-rules.yaml is missing', () => {
        // No writeRules() — file simply doesn't exist.
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'Write',
            tool_input: { file_path: '.env', content: 'x' },
        });
        // loadRules() returns emptyRules() on missing → checkPathAccess sees no
        // tiers populated → all paths allowed.
        expect(result).toBeNull();
    });

    it('passes through when tool_input is missing entirely', () => {
        writeRules('block_patterns:\nconfirm_patterns:\n');
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({ tool_name: 'Write' });
        expect(result).toBeNull();
    });
});

// ─── MultiEdit + NotebookEdit dispatch (2026-04-25 extension) ─────────────────

describe('path-guardrail processEvent — MultiEdit + NotebookEdit', () => {
    it('blocks MultiEdit on a zeroAccessPaths-matched path (file_path field)', () => {
        writeRules([
            'block_patterns:',
            'confirm_patterns:',
            'zeroAccessPaths:',
            '  - .env',
            'readOnlyPaths:',
            'noDeletePaths:',
            '',
        ].join('\n'));
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'MultiEdit',
            tool_input: { file_path: '.env', edits: [{ old_string: 'a', new_string: 'b' }] },
        });
        expect(result).not.toBeNull();
        expect(result.block).toBe(true);
        expect(result.feedback).toContain('zeroAccessPaths');
    });

    it('blocks NotebookEdit on a zeroAccessPaths-matched path (notebook_path field)', () => {
        writeRules([
            'block_patterns:',
            'confirm_patterns:',
            'zeroAccessPaths:',
            '  - secrets.ipynb',
            'readOnlyPaths:',
            'noDeletePaths:',
            '',
        ].join('\n'));
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'NotebookEdit',
            tool_input: { notebook_path: 'secrets.ipynb', new_source: 'x' },
        });
        expect(result).not.toBeNull();
        expect(result.block).toBe(true);
        expect(result.feedback).toContain('zeroAccessPaths');
    });

    it('returns null for NotebookEdit when notebook_path is missing', () => {
        writeRules('block_patterns:\nconfirm_patterns:\n');
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'NotebookEdit',
            tool_input: { new_source: 'x' },
        });
        expect(result).toBeNull();
    });

    it('returns null for MultiEdit when file_path is missing', () => {
        writeRules('block_patterns:\nconfirm_patterns:\n');
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'MultiEdit',
            tool_input: { edits: [] },
        });
        expect(result).toBeNull();
    });

    it('NotebookEdit ignores file_path field (uses notebook_path only)', () => {
        // Belt-and-suspenders: if a payload accidentally includes both fields,
        // NotebookEdit must read notebook_path. .env is in zero-access; safe.ipynb
        // is not. If we read file_path by mistake we'd block; the right behavior
        // is to read notebook_path and pass.
        writeRules([
            'block_patterns:',
            'confirm_patterns:',
            'zeroAccessPaths:',
            '  - .env',
            'readOnlyPaths:',
            'noDeletePaths:',
            '',
        ].join('\n'));
        const { processEvent } = require('../../../.agents/hooks/path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'NotebookEdit',
            tool_input: { notebook_path: 'safe.ipynb', file_path: '.env' },
        });
        expect(result).toBeNull();
    });
});

describe('path-guardrail getTargetPath', () => {
    it('returns notebook_path for NotebookEdit', () => {
        const { getTargetPath } = require('../../../.agents/hooks/path-guardrail.cjs');
        expect(getTargetPath('NotebookEdit', { notebook_path: 'a.ipynb' })).toBe('a.ipynb');
    });

    it('returns file_path for Write/Edit/MultiEdit', () => {
        const { getTargetPath } = require('../../../.agents/hooks/path-guardrail.cjs');
        expect(getTargetPath('Write', { file_path: 'a.txt' })).toBe('a.txt');
        expect(getTargetPath('Edit', { file_path: 'b.txt' })).toBe('b.txt');
        expect(getTargetPath('MultiEdit', { file_path: 'c.txt' })).toBe('c.txt');
    });

    it('returns empty string when path field is absent', () => {
        const { getTargetPath } = require('../../../.agents/hooks/path-guardrail.cjs');
        expect(getTargetPath('Write', {})).toBe('');
        expect(getTargetPath('NotebookEdit', {})).toBe('');
        expect(getTargetPath('Write', null)).toBe('');
    });
});

// ── Finding 2 (retry): fail CLOSED on a truncated/wedged stdin read. Claude Code
//    only blocks a Write/Edit call on exit 2; a wedged pipe / truncated JSON must
//    BLOCK (never exit 0, which would let the write proceed with NO path-tier
//    enforcement), WHILE a legitimate empty/valid payload still passes. This
//    hook's graceful outer catch previously reclassified these as exit 0. ──
describe('path-guardrail runClaudeHook fail-closed on stdin (spawned process)', () => {
    const { execFileSync, spawn } = require('node:child_process');
    const hookPath = require.resolve('../../../.agents/hooks/path-guardrail.cjs');
    const REPO = path.resolve(path.dirname(hookPath), '..', '..');

    function runHook(input) {
        try {
            const stdout = execFileSync('node', [hookPath], {
                input,
                env: { ...process.env, CLAUDE_PROJECT_DIR: REPO },
                stdio: 'pipe',
            });
            return { exitCode: 0, stdout: stdout.toString(), stderr: '' };
        } catch (err) {
            return { exitCode: err.status, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
        }
    }

    it('malformed/truncated JSON on non-empty stdin → BLOCKS (exit 2), not exit 0', () => {
        const result = runHook('{"tool_name":"Write","tool_input":');
        expect(result.exitCode).not.toBe(0); // never silently unchecked
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('fail-closed');
    });

    it('wedged pipe (stdin never closes) → times out and BLOCKS (exit 2)', async () => {
        const child = spawn('node', [hookPath], {
            env: { ...process.env, CLAUDE_PROJECT_DIR: REPO, HOOK_STDIN_TIMEOUT_MS: '150' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.write('{"tool_name":"Write"'); // truncated; stdin intentionally left open
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c; });
        const exitCode = await new Promise((resolve) => child.on('exit', resolve));
        expect(exitCode).toBe(2);
        expect(stderr).toContain('fail-closed');
    });

    it('legitimate EMPTY stdin (clean end) → passes (exit 0), no regression', () => {
        expect(runHook('').exitCode).toBe(0);
    });

    it('legitimate VALID JSON (benign write target) → passes (exit 0), no regression', () => {
        const result = runHook(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/pg-benign/hello.js' } }));
        expect(result.exitCode).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SF-1.8 — subagentReadOnlyPaths tier, agent_id plumbing, fail-closed path hook
//
// AC→test map (docs/TODO_software-factory.md, Story SF-1.8):
//   AC2 hook passes agent_id/agent_type ............ 'SF-1.8 path-guardrail — agent_id plumbing (in-process)'
//   AC2 any defined agent_id is a subagent ......... '... agent_id values'
//   AC2 every GATED_TOOLS tool, subagent 2 / main 0 .. 'SF-1.8 path-guardrail — subagent tier (spawned hook)'
//   AC3 shipped entries block a subagent ........... 'SF-1.8 path-guardrail — shipped entries'
//   AC4 fail closed: rules missing/malformed ....... 'SF-1.8 path-guardrail — fail closed on unusable rules'
//   AC4 exception inside processEvent exits 2 ...... 'SF-1.8 path-guardrail — an exception inside processEvent'
//   AC4 symlink / .. / case / doubled segments ..... 'SF-1.8 path-guardrail — adversarial target paths'
//   AC4 stale header line corrected ................ 'SF-1.8 path-guardrail — header comment'
//   AC5 (recorded live probe) ...................... NOT COVERED here: orchestrator-owned.
// ═════════════════════════════════════════════════════════════════════════════

describe('SF-1.8 path-guardrail', () => {
    const { spawnSync } = require('node:child_process');
    const os = require('node:os');
    const HOOK = require.resolve('../../../.agents/hooks/path-guardrail.cjs');
    // .agents/hooks → .agents → config/guardrail-rules.yaml: the authored shipped rules
    const SHIPPED_YAML = path.resolve(path.dirname(HOOK), '..', 'config', 'guardrail-rules.yaml');
    const GATED = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

    // [shipped tier entry, a repo-relative target it must protect]
    const SHIPPED_TARGETS = [
        ['gate.config.json', 'gate.config.json'],
        ['.agents/core/gate.js', '.agents/core/gate.js'],
        ['.agents/core/_lib/gate-receipt.js', '.agents/core/_lib/gate-receipt.js'],
        ['.agents/core/_lib/failure-ledger.js', '.agents/core/_lib/failure-ledger.js'],
        ['.agents/core/_lib/freeze-state.js', '.agents/core/_lib/freeze-state.js'],
        ['.agents/core/_lib/guardrail-rules.js', '.agents/core/_lib/guardrail-rules.js'],
        ['.agents/core/ac-verify.js', '.agents/core/ac-verify.js'],
        ['.agents/core/ship-check.js', '.agents/core/ship-check.js'],
        ['.agents/core/commit.js', '.agents/core/commit.js'],
        ['.agents/core/todo-completion.js', '.agents/core/todo-completion.js'],
        ['.agents/hooks/', '.agents/hooks/path-guardrail.cjs'],
        ['.claude/hooks/', '.claude/hooks/path-guardrail.cjs'],
        ['.codex/hooks/', '.codex/hooks/path-guardrail.cjs'],
        ['.agents/config/guardrail-rules.yaml', '.agents/config/guardrail-rules.yaml'],
        ['guardrail-rules.yaml', '.claude/guardrail-rules.yaml'],
        ['.agents/adapters/claude/settings.json', '.agents/adapters/claude/settings.json'],
        ['.claude/settings.json', '.claude/settings.json'],
        ['docs/.output/.state/telemetry/ac-verify/', 'docs/.output/.state/telemetry/ac-verify/SF-1.8.freeze.json'],
        ['docs/.output/.state/telemetry/ship-seal.json', 'docs/.output/.state/telemetry/ship-seal.json'],
        // review C1/J-1: the require() closure of the hooks and the judges (a test walks the graph; these pin each entry)
        ['.agents/core/story-checkpoint.js', '.agents/core/story-checkpoint.js'],
        ['.agents/core/plan-check.js', '.agents/core/plan-check.js'],
        ['.agents/core/release-slice.js', '.agents/core/release-slice.js'],
        ['.agents/core/runtime-context.js', '.agents/core/runtime-context.js'],
        ['.agents/core/git-hooks.js', '.agents/core/git-hooks.js'],
        ['.agents/core/build-lock-recovery.js', '.agents/core/build-lock-recovery.js'],
        ['.agents/core/_lib/attribution-ledger.js', '.agents/core/_lib/attribution-ledger.js'],
        ['.agents/core/_lib/command-blocker.js', '.agents/core/_lib/command-blocker.js'],
        ['.agents/core/_lib/fs-safe.js', '.agents/core/_lib/fs-safe.js'],
        ['.agents/core/_lib/gate-summary.js', '.agents/core/_lib/gate-summary.js'],
        ['.agents/core/_lib/git-hook-protocol.js', '.agents/core/_lib/git-hook-protocol.js'],
        ['.agents/core/_lib/git.js', '.agents/core/_lib/git.js'],
        ['.agents/core/_lib/hook-input.js', '.agents/core/_lib/hook-input.js'],
        ['.agents/core/_lib/hook-telemetry.js', '.agents/core/_lib/hook-telemetry.js'],
        ['.agents/core/_lib/jsonl-writer.js', '.agents/core/_lib/jsonl-writer.js'],
        ['.agents/core/_lib/owned-process-tree.js', '.agents/core/_lib/owned-process-tree.js'],
        ['.agents/core/_lib/project-root.js', '.agents/core/_lib/project-root.js'],
        ['.agents/core/_lib/run-pointer.js', '.agents/core/_lib/run-pointer.js'],
        ['.agents/core/_lib/secret-engine-bin.js', '.agents/core/_lib/secret-engine-bin.js'],
        ['.agents/core/_lib/shell-command-split.js', '.agents/core/_lib/shell-command-split.js'],
        ['.agents/core/_lib/telemetry-paths.js', '.agents/core/_lib/telemetry-paths.js'],
        ['.agents/core/_lib/yaml-parser.js', '.agents/core/_lib/yaml-parser.js'],
        // review M3: hook registration and transport files
        ['.claude/settings.local.json', '.claude/settings.local.json'],
        ['.agents/adapters/codex/', '.agents/adapters/codex/hooks.js'],
        ['.codex/hooks.json', '.codex/hooks.json'],
        ['.codex/hook-identities.json', '.codex/hook-identities.json'],
        // review M4: the judge's state files
        ['docs/.output/.state/telemetry/gate-failures.jsonl', 'docs/.output/.state/telemetry/gate-failures.jsonl'],
        ['docs/.output/.state/telemetry/gate-receipt.json', 'docs/.output/.state/telemetry/gate-receipt.json'],
        ['docs/.output/.state/telemetry/gate-receipts/', 'docs/.output/.state/telemetry/gate-receipts/by-id/SF-1.8.json'],
        ['docs/.output/.state/freeze-state.json', 'docs/.output/.state/freeze-state.json'],
        // review M5: the gate's command inputs (the real test-config path is the ROOT vitest.config.mjs)
        ['vitest.config.mjs', 'vitest.config.mjs'],
        ['tools/run-toolkit-tests.cjs', 'tools/run-toolkit-tests.cjs'],
        // security M3 / m3: the test runner package and every config vitest would rank above the walled one
        ['node_modules/', 'node_modules/vitest/vitest.mjs'],
        ['node_modules/', 'node_modules/vitest/dist/reporters.js'],
        ['vitest.config.ts', 'vitest.config.ts'],
        ['vitest.config.mts', 'vitest.config.mts'],
        ['vitest.config.cts', 'vitest.config.cts'],
        ['vitest.config.js', 'vitest.config.js'],
        ['vitest.config.cjs', 'vitest.config.cjs'],
        ['vite.config.cts', 'vite.config.cts'],
        ['vite.config.cjs', 'vite.config.cjs'],
        ['vite.config.mts', 'vite.config.mts'],
        ['vite.config.js', 'vite.config.js'],
        ['vite.config.ts', 'vite.config.ts'],
        ['vite.config.mjs', 'vite.config.mjs'],
        // security M4: libraries the non-blocking hooks load (UserPromptSubmit / SessionStart output reaches the Main Agent)
        ['.agents/core/_lib/daily-log-paths.js', '.agents/core/_lib/daily-log-paths.js'],
        ['.agents/core/_lib/doc-drift.js', '.agents/core/_lib/doc-drift.js'],
        ['.agents/core/_lib/frontmatter.js', '.agents/core/_lib/frontmatter.js'],
        ['.agents/core/_lib/hook-spawners.js', '.agents/core/_lib/hook-spawners.js'],
        ['.agents/core/_lib/jaccard.js', '.agents/core/_lib/jaccard.js'],
        ['.agents/core/_lib/memory-context.js', '.agents/core/_lib/memory-context.js'],
        ['.agents/core/_lib/memory-decay.js', '.agents/core/_lib/memory-decay.js'],
        ['.agents/core/_lib/memory-extract.js', '.agents/core/_lib/memory-extract.js'],
        ['.agents/core/_lib/memory-index-divergence.js', '.agents/core/_lib/memory-index-divergence.js'],
        ['.agents/core/_lib/memory-ingest.js', '.agents/core/_lib/memory-ingest.js'],
        ['.agents/core/_lib/memory-lint.js', '.agents/core/_lib/memory-lint.js'],
        ['.agents/core/_lib/memory-notes.js', '.agents/core/_lib/memory-notes.js'],
        ['.agents/core/_lib/memory-paths.js', '.agents/core/_lib/memory-paths.js'],
        ['.agents/core/_lib/memory-recall.js', '.agents/core/_lib/memory-recall.js'],
        ['.agents/core/_lib/memory-sync.js', '.agents/core/_lib/memory-sync.js'],
        ['.agents/core/_lib/output-paths.js', '.agents/core/_lib/output-paths.js'],
        ['.agents/core/_lib/run-stamp.js', '.agents/core/_lib/run-stamp.js'],
        ['.agents/core/_lib/sqlite-backend.js', '.agents/core/_lib/sqlite-backend.js'],
        ['.agents/core/constants.js', '.agents/core/constants.js'],
        ['.agents/core/daily-log.js', '.agents/core/daily-log.js'],
        ['.agents/core/handoff-path.js', '.agents/core/handoff-path.js'],
        ['.agents/core/memory-capture.js', '.agents/core/memory-capture.js'],
        ['.agents/core/memory-manager-cli.js', '.agents/core/memory-manager-cli.js'],
        ['.agents/core/memory-manager.js', '.agents/core/memory-manager.js'],
        ['.agents/core/profile.js', '.agents/core/profile.js'],
    ];
    const GATE_REL = '.agents/core/gate.js';
    const SUBAGENT = { agent_id: 'agent-7', agent_type: 'implementer' };

    const installShippedRules = () => tmp.write('.claude/guardrail-rules.yaml', fs.readFileSync(SHIPPED_YAML, 'utf8'));
    const payload = (tool, target, extra = {}) => ({
        tool_name: tool,
        tool_input: tool === 'NotebookEdit' ? { notebook_path: target, new_source: 'x' } : { file_path: target, content: 'x' },
        ...extra,
    });
    const abs = (rel) => path.join(tmp.root, rel);

    function spawnHook(data, { root = tmp.root } = {}) {
        const r = spawnSync('node', [HOOK], {
            input: JSON.stringify(data),
            env: { ...process.env, CLAUDE_PROJECT_DIR: root },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000,
        });
        return { exitCode: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
    }

    // Patch a CJS module export for one test; the hook must be required AFTER patching
    // (it destructures at load). Restored in afterEach.
    const patched = [];
    afterEach(() => {
        while (patched.length) {
            const [mod, name, original] = patched.pop();
            mod[name] = original;
        }
    });
    function patchExport(modulePath, name, replacement) {
        const mod = require(modulePath);
        patched.push([mod, name, mod[name]]);
        mod[name] = replacement;
    }
    const loadHook = () => require('../../../.agents/hooks/path-guardrail.cjs');

    // ── AC2: payload plumbing ────────────────────────────────────────────────

    describe('agent_id plumbing (in-process)', () => {
        function spyOnCheckPathAccess() {
            const rulesMod = require('../../core/_lib/guardrail-rules');
            const original = rulesMod.checkPathAccess;
            const calls = [];
            patchExport('../../core/_lib/guardrail-rules', 'checkPathAccess', (...args) => { calls.push(args); return original(...args); });
            return calls;
        }

        it('processEvent_subagentPayload_passesAgentIdAndAgentTypeAsTheFourthArgument', () => {
            installShippedRules();
            const calls = spyOnCheckPathAccess();
            const { processEvent } = loadHook();

            processEvent(payload('Write', abs('src/app.js'), { agent_id: 'agent-7', agent_type: 'qa-engineer' }));

            expect(calls).toHaveLength(1);
            expect(calls[0][3]).toEqual({ agentId: 'agent-7', agentType: 'qa-engineer' });
        });

        it('processEvent_emptyStringAgentId_isPassedThroughAsAnEmptyStringNotCoercedAway', () => {
            installShippedRules();
            const calls = spyOnCheckPathAccess();
            const { processEvent } = loadHook();

            processEvent(payload('Write', abs('src/app.js'), { agent_id: '' }));

            expect(calls[0][3].agentId).toBe('');
        });

        it('processEvent_mainThreadPayload_carriesNoAgentIdIntoTheCheck', () => {
            installShippedRules();
            const calls = spyOnCheckPathAccess();
            const { processEvent } = loadHook();

            processEvent(payload('Write', abs('src/app.js')));

            expect(calls).toHaveLength(1);
            expect(calls[0][3]?.agentId).toBeUndefined();
        });

        it('processEvent_agentTypeWithoutAgentId_isTheMainThread_soAProtectedPathIsAllowed', () => {
            // `claude --agent X` stamps agent_type on the main thread; only agent_id marks a subagent.
            installShippedRules();
            const { processEvent } = loadHook();

            const result = processEvent(payload('Write', abs(GATE_REL), { agent_type: 'implementer' }));

            expect(result).toBeNull();
        });

        it('GATED_TOOLS_isExactlyTheFourToolsTheTierIsTestedFor', () => {
            const { GATED_TOOLS } = loadHook();
            expect([...GATED_TOOLS].sort()).toEqual([...GATED].sort());
        });
    });

    // ── AC2: any defined agent_id is a subagent ──────────────────────────────

    describe('agent_id values', () => {
        it.each([
            ['an empty string', ''],
            ['zero', 0],
            ['a number', 123],
            ['an empty object', {}],
            ['an empty array', []],
            ['false', false],
            ['a normal string', 'agent-abc'],
        ])('spawnedHook_agentIdIs_%s_countsAsASubagentAndExits2OnAProtectedPath', (_label, agentId) => {
            installShippedRules();

            const result = spawnHook(payload('Write', abs(GATE_REL), { agent_id: agentId }));

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('subagentReadOnlyPaths');
        });

        it('spawnedHook_noAgentIdKey_isTheMainThreadAndExits0OnTheSameProtectedPath', () => {
            installShippedRules();

            expect(spawnHook(payload('Write', abs(GATE_REL))).exitCode).toBe(0);
        });
    });

    // ── AC2: every tool in GATED_TOOLS ───────────────────────────────────────

    describe('subagent tier (spawned hook)', () => {
        it.each(GATED)('spawnedHook_%s_fromASubagentToAProtectedPath_exits2WithTheTierNamed', (tool) => {
            installShippedRules();

            const result = spawnHook(payload(tool, abs(GATE_REL), SUBAGENT));

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('subagentReadOnlyPaths');
        });

        it.each(GATED)('spawnedHook_%s_fromTheMainThreadToTheSameProtectedPath_exits0', (tool) => {
            installShippedRules();

            expect(spawnHook(payload(tool, abs(GATE_REL))).exitCode).toBe(0);
        });

        it.each(GATED)('spawnedHook_%s_fromASubagentToAnUnprotectedPath_exits0', (tool) => {
            installShippedRules();

            expect(spawnHook(payload(tool, abs('src/feature/app.js'), SUBAGENT)).exitCode).toBe(0);
        });

        it('processEvent_subagentDeleteOperationOnAProtectedPath_isBlocked_andTheMainThreadDeleteIsNot', () => {
            installShippedRules();
            const { processEvent } = loadHook();
            const del = (extra) => ({ tool_name: 'Write', tool_input: { file_path: abs(GATE_REL), codex_operation: 'delete' }, ...extra });

            expect(processEvent(del(SUBAGENT))).toMatchObject({ block: true });
            expect(processEvent(del({}))).toBeNull();
        });

        it.each([
            'src/app.js',
            '.agents/core/gate-signal.js',
            '.agents/skills/qa-engineer/SKILL.md',
            '.claude/settings.example.json',
            'docs/.output/.state/telemetry/gate-signal.json',
            'tools/harness-eval.js',
            'src/vitest-helpers.js',
            'src/vite-env.d.ts',
            'src/memory-context-widget.js',
            'src/node_modules_notes.md',
        ])('processEvent_subagentWriteTo_%s_isAllowed', (rel) => {
            installShippedRules();
            const { processEvent } = loadHook();

            expect(processEvent(payload('Write', abs(rel), SUBAGENT))).toBeNull();
        });

        it('spawnedHook_adopterLiftedEntry_isAllowedForASubagent_whileOtherEntriesStayBlocked', () => {
            installShippedRules();
            tmp.write('.claude/guardrail-rules.project.yaml', 'except:\n  subagentReadOnlyPaths:\n    - .codex/hooks/\n');

            expect(spawnHook(payload('Write', abs('.codex/hooks/new-hook.cjs'), SUBAGENT)).exitCode).toBe(0);
            expect(spawnHook(payload('Write', abs('.claude/hooks/new-hook.cjs'), SUBAGENT)).exitCode).toBe(2);
        });
    });

    // ── AC3: every shipped entry ─────────────────────────────────────────────

    describe('shipped entries', () => {
        it.each(SHIPPED_TARGETS)('spawnedHook_subagentWriteMatching_%s_exits2', (_entry, rel) => {
            installShippedRules();

            const result = spawnHook(payload('Write', abs(rel), SUBAGENT));

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('subagentReadOnlyPaths');
        });

        it.each(SHIPPED_TARGETS)('processEvent_mainThreadWriteMatching_%s_isAllowed', (_entry, rel) => {
            installShippedRules();
            const { processEvent } = loadHook();

            expect(processEvent(payload('Write', abs(rel)))).toBeNull();
        });

        it.each(GATED)('processEvent_%s_toEveryShippedEntry_blocksASubagent', (tool) => {
            installShippedRules();
            const { processEvent } = loadHook();

            const blocked = SHIPPED_TARGETS.filter(([, rel]) => {
                const result = processEvent(payload(tool, abs(rel), SUBAGENT));
                return result && result.block === true;
            });

            expect(blocked.map(([entry]) => entry)).toEqual(SHIPPED_TARGETS.map(([entry]) => entry));
        });
    });

    // ── AC4: fail closed on unusable rules ───────────────────────────────────

    describe('fail closed on unusable rules', () => {
        // Each installer leaves the project's rules file missing or unusable.
        const FIXTURES = [
            ['the rules file is missing', () => {}],
            ['the rules file is unparseable garbage', () => { tmp.write('.claude/guardrail-rules.yaml', '[unclosed\n  - {{{\n'); }],
            ['the rules file is binary noise', () => { tmp.write('.claude/guardrail-rules.yaml', '\u0000\u0001\u0002\n'); }],
            ['the subagent tier has the wrong type', () => { tmp.write('.claude/guardrail-rules.yaml', 'zeroAccessPaths:\n  - secrets.txt\nsubagentReadOnlyPaths: not-a-list\n'); }],
            ['the rules path is a directory', () => { tmp.mkdir('.claude/guardrail-rules.yaml'); }],
        ];

        describe.each(FIXTURES)('when %s', (_label, install) => {
            it.each(SHIPPED_TARGETS)('processEvent_subagentWriteMatching_%s_isStillBlockedByTheBuiltInDefaults', (_entry, rel) => {
                install();
                const { processEvent } = loadHook();

                const result = processEvent(payload('Write', abs(rel), SUBAGENT));

                expect(result).toMatchObject({ block: true });
                expect(typeof result.feedback).toBe('string');
                expect(result.feedback.length).toBeGreaterThan(0);
            });

            it('spawnedHook_subagentWriteToTheGateScript_exits2', () => {
                install();

                expect(spawnHook(payload('Write', abs(GATE_REL), SUBAGENT)).exitCode).toBe(2);
            });

            it('spawnedHook_mainThreadWriteToTheGateScript_stillExits0_theGracefulPostureIsKept', () => {
                install();

                expect(spawnHook(payload('Write', abs(GATE_REL))).exitCode).toBe(0);
            });

            it('processEvent_subagentWriteToAnOrdinarySourceFile_isNotOverBlockedByTheDefaults', () => {
                install();
                const { processEvent } = loadHook();

                expect(processEvent(payload('Write', abs('src/app.js'), SUBAGENT))).toBeNull();
            });
        });
    });

    // ── AC4: an exception inside processEvent must exit 2, not 0 ─────────────

    describe('an exception inside processEvent', () => {
        it.each([
            ['a number', 123],
            ['an object', { nested: true }],
            ['an array', ['a']],
            ['true', true],
        ])('spawnedHook_writeWithFilePathThatIs_%s_exits2NotZero', (_label, badPath) => {
            installShippedRules();

            const result = spawnHook({ tool_name: 'Write', tool_input: { file_path: badPath } });

            expect(result.exitCode).toBe(2);
            expect(result.stderr.length).toBeGreaterThan(0);
        });

        it('spawnedHook_notebookEditWithANonStringNotebookPath_exits2NotZero', () => {
            installShippedRules();

            expect(spawnHook({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 42 } }).exitCode).toBe(2);
        });

        it('spawnedHook_subagentWithAMalformedFilePath_exits2', () => {
            installShippedRules();

            expect(spawnHook({ tool_name: 'Edit', tool_input: { file_path: 123 }, ...SUBAGENT }).exitCode).toBe(2);
        });

        it('processEvent_nonStringFilePath_returnsABlockResultInsteadOfThrowing', () => {
            installShippedRules();
            const { processEvent } = loadHook();

            // resolveAbsPath(123) throws a TypeError; it must be caught inside processEvent.
            const result = processEvent({ tool_name: 'Write', tool_input: { file_path: 123 } });

            expect(result).toMatchObject({ block: true });
            expect(result.feedback.length).toBeGreaterThan(0);
        });

        it('processEvent_checkFreezeStateThrows_returnsABlockResultInsteadOfThrowing', () => {
            installShippedRules();
            patchExport('../../core/_lib/command-blocker', 'checkFreezeState', () => { throw new Error('freeze-state exploded'); });
            const { processEvent } = loadHook();

            const result = processEvent(payload('Write', abs('src/app.js')));

            expect(result).toMatchObject({ block: true });
            expect(result.feedback.length).toBeGreaterThan(0);
        });

        it('processEvent_checkFreezeStateThrowsForASubagent_stillBlocks', () => {
            installShippedRules();
            patchExport('../../core/_lib/command-blocker', 'checkFreezeState', () => { throw new Error('freeze-state exploded'); });
            const { processEvent } = loadHook();

            expect(processEvent(payload('Write', abs('src/app.js'), SUBAGENT))).toMatchObject({ block: true });
        });

        it('processEvent_checkPathAccessThrows_stillFailsClosed_noRegressionOfTheExistingGuard', () => {
            installShippedRules();
            patchExport('../../core/_lib/guardrail-rules', 'checkPathAccess', () => { throw new Error('tier check exploded'); });
            const { processEvent } = loadHook();

            expect(processEvent(payload('Write', abs('src/app.js'), SUBAGENT))).toMatchObject({ block: true });
        });
    });

    // ── AC4: adversarial target paths ────────────────────────────────────────

    describe('adversarial target paths', () => {
        // Every target below resolves to (or is spelled like) a protected path.
        const ADVERSARIAL = [
            ['a relative path', () => GATE_REL],
            ['a relative path with a .. detour', () => '.agents/core/sub/../gate.js'],
            ['a relative path that leaves and re-enters via ..', () => 'src/../.agents/core/gate.js'],
            ['a relative path with doubled slashes', () => '.agents//core//gate.js'],
            ['an absolute path', () => abs(GATE_REL)],
            ['an absolute path with a .. detour inside the protected tail', () => `${abs('.agents/core')}/sub/../gate.js`],
            ['an absolute settings path with a .. detour', () => `${abs('.claude')}/x/../settings.json`],
            ['an absolute path that leaves and re-enters via ..', () => `${tmp.root}/src/../.agents/core/gate.js`],
            ['an absolute path that enters the hooks directory via ..', () => `${abs('.agents/core')}/../hooks/new-hook.cjs`],
            ['an absolute evidence path with a .. detour', () => `${abs('docs/.output/.state/telemetry')}/x/../ac-verify/SF-1.8.freeze.json`],
            ['an absolute path with doubled slashes', () => `${tmp.root}/.agents//core//gate.js`],
            ['an absolute path with dot segments', () => `${tmp.root}/.agents/./core/./gate.js`],
            ['a mixed-case gate script path', () => `${tmp.root}/.AGENTS/Core/GATE.js`],
            ['a mixed-case settings path', () => `${tmp.root}/.Claude/Settings.JSON`],
            ['a mixed-case hooks directory path', () => `${tmp.root}/.Agents/HOOKS/new-hook.cjs`],
            ['a path with Windows separators', () => `${tmp.root}\\.agents\\core\\gate.js`],
        ];

        it.each(ADVERSARIAL)('spawnedHook_subagentWriteVia_%s_exits2', (_label, build) => {
            installShippedRules();

            const result = spawnHook(payload('Write', build(), SUBAGENT));

            expect(result.exitCode).toBe(2);
        });

        it.each(ADVERSARIAL)('processEvent_mainThreadWriteVia_%s_isStillAllowed', (_label, build) => {
            installShippedRules();
            const { processEvent } = loadHook();

            expect(processEvent(payload('Write', build()))).toBeNull();
        });

        // Symlinks need a privilege on some hosts (Windows without developer mode); an unprivileged
        // host cannot build the fixture, so it is skipped there and the gap is stated, not hidden.
        // NOT COVERED on a host that cannot create symlinks: the four symlink cases below.
        const CAN_SYMLINK = (() => {
            const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-symlink-probe-'));
            try {
                fs.symlinkSync(probe, path.join(probe, 'l'));
                return true;
            } catch {
                return false;
            } finally {
                fs.rmSync(probe, { recursive: true, force: true });
            }
        })();

        const link = (target, rel) => {
            fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
            fs.symlinkSync(target, abs(rel));
        };

        it.skipIf(!CAN_SYMLINK)('spawnedHook_subagentWriteThroughASymlinkToTheGateScript_exits2', () => {
            installShippedRules();
            tmp.write(GATE_REL, '// gate');
            link(abs(GATE_REL), 'innocuous.js');

            expect(spawnHook(payload('Write', abs('innocuous.js'), SUBAGENT)).exitCode).toBe(2);
        });

        it.skipIf(!CAN_SYMLINK)('spawnedHook_subagentWriteOfANewFileThroughASymlinkedHooksDirectory_exits2', () => {
            installShippedRules();
            tmp.mkdir('.agents/hooks');
            link(abs('.agents/hooks'), 'shortcut');

            expect(spawnHook(payload('Write', abs('shortcut/brand-new-hook.cjs'), SUBAGENT)).exitCode).toBe(2);
        });

        it.skipIf(!CAN_SYMLINK)('spawnedHook_subagentWriteThroughAChainOfDirectorySymlinks_usingARelativePath_exits2', () => {
            installShippedRules();
            tmp.mkdir('.agents/hooks');
            link(abs('.agents/hooks'), 'b');
            link(abs('b'), 'a');

            expect(spawnHook(payload('Write', 'a/brand-new-hook.cjs', SUBAGENT)).exitCode).toBe(2);
        });

        it.skipIf(!CAN_SYMLINK)('spawnedHook_subagentWriteThroughADanglingSymlinkToAnAbsentSealFile_exits2', () => {
            // Writing through a dangling symlink creates its target: the seal does not exist yet.
            installShippedRules();
            tmp.mkdir('docs/.output/.state/telemetry');
            link(abs('docs/.output/.state/telemetry/ship-seal.json'), 'notes.json');

            expect(spawnHook(payload('Write', abs('notes.json'), SUBAGENT)).exitCode).toBe(2);
        });

        it.skipIf(!CAN_SYMLINK)('processEvent_mainThreadWriteThroughTheSameSymlinks_isStillAllowed', () => {
            installShippedRules();
            tmp.write(GATE_REL, '// gate');
            link(abs(GATE_REL), 'innocuous.js');
            const { processEvent } = loadHook();

            expect(processEvent(payload('Write', abs('innocuous.js')))).toBeNull();
        });

        it.skipIf(!CAN_SYMLINK)('processEvent_subagentWriteThroughASymlinkOutOfAProtectedDirToAnUnprotectedFile_isNotOverBlocked', () => {
            installShippedRules();
            tmp.write('src/real.js', '// real');
            link(abs('src/real.js'), 'alias.js');
            const { processEvent } = loadHook();

            expect(processEvent(payload('Write', abs('alias.js'), SUBAGENT))).toBeNull();
        });
    });

    // ── AC4: the stale header comment ────────────────────────────────────────

    describe('header comment', () => {
        const source = fs.readFileSync(HOOK, 'utf8');
        const header = source.slice(0, source.indexOf("'use strict'"));

        it('headerComment_noLongerClaimsAnyUnexpectedErrorExitsZero', () => {
            // The stale line 20 read: "Failure mode: any unexpected error → exit 0 (graceful pass-through)."
            expect(header).not.toMatch(/any unexpected error\s*(?:→|->|=>)\s*exit 0/i);
            expect(header).not.toMatch(/graceful pass-through/i);
        });

        it('headerComment_statesTheHookFailsClosedWithExit2', () => {
            expect(header).toMatch(/fail(?:s|ed|ing)?[ -]closed/i);
        });

        it('headerComment_stillDocumentsTheExitCodeContract', () => {
            expect(header).toMatch(/0 = pass/);
            expect(header).toMatch(/2 = blocked/);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SF-1.8 generated wrappers — author-added (the story's frozen tests do not pin these).
// `.claude/core/*.js` and `.codex/core/*.js` are generated entry points that require() the
// authored gate/judge files; repointing one runs a weakened judge while the authored file stays
// untouched, so the subagent tier must cover them. Also pins the built-in defaults to the shipped
// yaml and the "parsed vs unloadable rules" distinction the fallback relies on.
// ═════════════════════════════════════════════════════════════════════════════

describe('SF-1.8 generated wrappers', () => {
    const { spawnSync } = require('node:child_process');
    const HOOK = require.resolve('../../../.agents/hooks/path-guardrail.cjs');
    const SHIPPED_YAML = path.resolve(path.dirname(HOOK), '..', 'config', 'guardrail-rules.yaml');
    const SUBAGENT = { agent_id: 'agent-9', agent_type: 'implementer' };
    const WRAPPERS = [
        '.claude/core/gate.js',
        '.claude/core/ship-check.js',
        '.claude/core/commit.js',
        '.claude/core/ac-verify.js',
        '.claude/core/todo-completion.js',
        '.claude/core/_lib/gate-receipt.js',
        '.claude/core/_lib/failure-ledger.js',
        '.claude/core/_lib/freeze-state.js',
        '.claude/core/_lib/guardrail-rules.js',
        '.codex/core/gate.js',
        '.codex/core/ship-check.js',
        '.codex/core/commit.js',
        '.codex/core/ac-verify.js',
        '.codex/core/todo-completion.js',
        '.codex/core/_lib/gate-receipt.js',
        '.codex/core/_lib/failure-ledger.js',
        '.codex/core/_lib/freeze-state.js',
        '.codex/core/_lib/guardrail-rules.js',
    ];
    const abs = (rel) => path.join(tmp.root, rel);
    const write = (target, extra = {}) => ({ tool_name: 'Write', tool_input: { file_path: target, content: 'x' }, ...extra });
    const installShipped = () => tmp.write('.claude/guardrail-rules.yaml', fs.readFileSync(SHIPPED_YAML, 'utf8'));
    const loadHook = () => require('../../../.agents/hooks/path-guardrail.cjs');

    function spawnRaw(stdin) {
        const r = spawnSync('node', [HOOK], {
            input: stdin,
            env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000,
        });
        return { exitCode: r.status, stderr: r.stderr || '' };
    }

    it.each(WRAPPERS)('processEvent_subagentWriteTo_%s_isBlockedByTheShippedTier', (rel) => {
        installShipped();
        const result = loadHook().processEvent(write(abs(rel), SUBAGENT));
        expect(result).toMatchObject({ block: true });
        expect(result.feedback).toContain('subagentReadOnlyPaths');
    });

    it.each(WRAPPERS)('processEvent_mainThreadWriteTo_%s_isAllowed', (rel) => {
        installShipped();
        expect(loadHook().processEvent(write(abs(rel)))).toBeNull();
    });

    it.each(WRAPPERS)('processEvent_subagentWriteTo_%s_isBlockedByTheBuiltInDefaultsWhenTheRulesFileIsMissing', (rel) => {
        expect(loadHook().processEvent(write(abs(rel), SUBAGENT))).toMatchObject({ block: true });
    });

    it('builtInDefaults_equalTheShippedYamlTierInContentAndOrder', () => {
        const { loadRules } = require('../../core/_lib/guardrail-rules');
        expect([...loadHook().BUILTIN_SUBAGENT_READ_ONLY_PATHS]).toEqual(loadRules(SHIPPED_YAML).subagentReadOnlyPaths);
    });

    it('processEvent_parsedRulesFileWithoutTheTierKey_holdsASubagentToTheBuiltInDefaults_m4', () => {
        // Review m4: the shipped file always names the tier key, so a parsed file without it is tampering, a
        // truncation or an update not yet rendered, and the wall must not vanish with it.
        tmp.write('.claude/guardrail-rules.yaml', 'zeroAccessPaths:\n  - secrets.txt\n');
        const hook = loadHook();
        expect(hook.processEvent(write(abs('.agents/core/gate.js'), SUBAGENT))).toMatchObject({ block: true });
        expect(hook.processEvent(write(abs('secrets.txt'), SUBAGENT))).toMatchObject({ block: true });
        // The main thread keeps the graceful posture: the same file gives it no subagent wall.
        expect(hook.processEvent(write(abs('.agents/core/gate.js')))).toBeNull();
    });

    it('processEvent_tierKeyPresentButEmpty_isHonoredAndASubagentIsNotHeldToTheDefaults', () => {
        // An adopter who lifted every entry on purpose is not overridden by the fallback.
        tmp.write('.claude/guardrail-rules.yaml', 'subagentReadOnlyPaths:\n');
        expect(loadHook().processEvent(write(abs('.agents/core/gate.js'), SUBAGENT))).toBeNull();
    });

    it('processEvent_tierConfiguredAndEveryEntryLiftedByTheProjectOverride_isHonored', () => {
        tmp.write('.claude/guardrail-rules.yaml', 'subagentReadOnlyPaths:\n  - .agents/core/gate.js\n');
        tmp.write('.claude/guardrail-rules.project.yaml', 'except:\n  subagentReadOnlyPaths:\n    - .agents/core/gate.js\n');
        expect(loadHook().processEvent(write(abs('.agents/core/gate.js'), SUBAGENT))).toBeNull();
    });

    it.each([
        ['null', 'null'],
        ['a number', '42'],
        ['an array', '[]'],
        ['a string', '"x"'],
    ])('spawnedHook_validJsonThatIsNotAnObjectPayload_%s_exits2', (_label, body) => {
        installShipped();
        const result = spawnRaw(body);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('not a JSON object');
    });

    it('spawnedHook_ordinaryMainThreadWriteAndTestFileWrite_exit0', () => {
        installShipped();
        for (const rel of ['src/app.js', 'src/__tests__/app.test.js']) {
            expect(spawnRaw(JSON.stringify(write(abs(rel)))).exitCode).toBe(0);
        }
    });

    it('realpathLenient_followsADanglingSymlinkChainToTheEventualTarget', () => {
        const probe = path.join(tmp.root, 'probe');
        fs.mkdirSync(probe);
        try {
            fs.symlinkSync(path.join(probe, 'missing', 'target.json'), path.join(probe, 'l1'));
            fs.symlinkSync(path.join(probe, 'l1'), path.join(probe, 'l2'));
        } catch {
            return; // NOT COVERED on a host that cannot create symlinks.
        }
        expect(loadHook().realpathLenient(path.join(probe, 'l2'))).toBe(path.join(fs.realpathSync(probe), 'missing', 'target.json'));
    });

    it('realpathLenient_aSymlinkLoop_throwsSoTheHookFailsClosed', () => {
        const probe = path.join(tmp.root, 'loop');
        fs.mkdirSync(probe);
        try {
            fs.symlinkSync(path.join(probe, 'b'), path.join(probe, 'a'));
            fs.symlinkSync(path.join(probe, 'a'), path.join(probe, 'b'));
        } catch {
            return; // NOT COVERED on a host that cannot create symlinks.
        }
        expect(() => loadHook().realpathLenient(path.join(probe, 'a'))).toThrow();
        expect(loadHook().processEvent(write(path.join(probe, 'a')))).toMatchObject({ block: true });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SF-1.8 wave-7 review regressions (security-auditor C1, M1-M5, m1-m4, n1, n2; code-reviewer J-1..J-8).
// One describe per finding id. Findings C1/J-1 (closure) are also walked by
// `_lib/__tests__/subagent-tier-closure.test.js`; the per-entry pins live in SHIPPED_TARGETS above.
// ═════════════════════════════════════════════════════════════════════════════

describe('SF-1.8 review', () => {
    const { spawnSync, spawn } = require('node:child_process');
    const HOOK = require.resolve('../../../.agents/hooks/path-guardrail.cjs');
    const AGENTS_DIR = path.resolve(path.dirname(HOOK), '..');
    const SHIPPED_YAML = path.join(AGENTS_DIR, 'config', 'guardrail-rules.yaml');
    const SUBAGENT = { agent_id: 'agent-11', agent_type: 'implementer' };
    const abs = (rel) => path.join(tmp.root, rel);
    const write = (target, extra = {}) => ({ tool_name: 'Write', tool_input: { file_path: target, content: 'x' }, ...extra });
    const installShipped = () => tmp.write('.claude/guardrail-rules.yaml', fs.readFileSync(SHIPPED_YAML, 'utf8'));
    const loadHook = () => require('../../../.agents/hooks/path-guardrail.cjs');

    function spawnScript(script, data, env = {}) {
        const r = spawnSync(process.execPath, [script], {
            input: typeof data === 'string' ? data : JSON.stringify(data),
            env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, ...env },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 30000,
        });
        return { exitCode: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
    }

    // A runnable copy of the hook and its whole _lib, so a dependency can be broken without touching the repo.
    function makeHookCopy() {
        const hooksDir = path.join(tmp.root, '.agents', 'hooks');
        const libDir = path.join(tmp.root, '.agents', 'core', '_lib');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.mkdirSync(libDir, { recursive: true });
        fs.copyFileSync(HOOK, path.join(hooksDir, 'path-guardrail.cjs'));
        const sourceLib = path.join(AGENTS_DIR, 'core', '_lib');
        for (const name of fs.readdirSync(sourceLib)) {
            if (name.endsWith('.js')) fs.copyFileSync(path.join(sourceLib, name), path.join(libDir, name));
        }
        installShipped();
        return {
            hook: path.join(hooksDir, 'path-guardrail.cjs'),
            lib: (name) => path.join(libDir, name),
        };
    }

    describe('C1/J-1 the hook is not switchable from the inside', () => {
        it.each([
            '.agents/core/_lib/hook-input.js',
            '.agents/core/_lib/yaml-parser.js',
            '.agents/core/_lib/command-blocker.js',
            '.agents/core/_lib/hook-telemetry.js',
            '.agents/core/_lib/shell-command-split.js',
            '.agents/core/_lib/project-root.js',
            '.agents/core/_lib/telemetry-paths.js',
            '.agents/core/_lib/fs-safe.js',
            '.agents/core/_lib/gate-summary.js',
            '.agents/core/story-checkpoint.js',
        ])('spawnedHook_subagentWriteTo_%s_exits2_soTheHookAndTheJudgeCannotBeRewrittenFromBelow', (rel) => {
            installShipped();

            const result = spawnScript(HOOK, write(abs(rel), SUBAGENT));

            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('subagentReadOnlyPaths');
        });

        it('spawnedHook_theReviewExploit_aSubagentCannotWriteHookInput_soTheHookKeepsGatingTheGate', () => {
            // The review's exploit began with one Write to hook-input.js that made every later call return early.
            installShipped();
            const copy = makeHookCopy();

            const exploit = spawnScript(copy.hook, write(abs('.agents/core/_lib/hook-input.js'), SUBAGENT));
            const followUp = spawnScript(copy.hook, write(abs('.agents/core/gate.js'), SUBAGENT));

            expect(exploit.exitCode).toBe(2);
            expect(followUp.exitCode).toBe(2);
        });
    });

    describe('M1/J-2 a load-time failure exits 2, never the non-blocking 1', () => {
        const benign = write('/tmp/pg-load/a.js');
        const subagent = write('/tmp/pg-load/a.js', SUBAGENT);

        it('control_anIntactCopy_passesAnOrdinaryWriteAndBlocksTheGate', () => {
            const copy = makeHookCopy();

            expect(spawnScript(copy.hook, benign).exitCode).toBe(0);
            expect(spawnScript(copy.hook, write(abs('.agents/core/gate.js'), SUBAGENT)).exitCode).toBe(2);
        });

        it.each([
            ['a syntax error in hook-input.js', (c) => fs.appendFileSync(c.lib('hook-input.js'), '\n)(\n')],
            ['a syntax error in hook-telemetry.js (the review’s exit-1 repro)', (c) => fs.appendFileSync(c.lib('hook-telemetry.js'), '\n)(\n')],
            ['a throw at load in yaml-parser.js', (c) => fs.appendFileSync(c.lib('yaml-parser.js'), "\nthrow new Error('boom at load');\n")],
            ['a missing command-blocker.js (a half-applied update)', (c) => fs.rmSync(c.lib('command-blocker.js'))],
            ['a syntax error in guardrail-rules.js', (c) => fs.appendFileSync(c.lib('guardrail-rules.js'), '\n}}}\n')],
        ])('spawnedHook_with_%s_exits2ForAnyPayload', (_label, corrupt) => {
            const copy = makeHookCopy();
            corrupt(copy);

            for (const stdin of [JSON.stringify(benign), JSON.stringify(subagent), '', 'not json']) {
                const result = spawnScript(copy.hook, stdin);

                expect(result.exitCode, `stdin=${JSON.stringify(stdin)} stderr=${result.stderr}`).toBe(2);
                expect(result.stderr).toContain('could not load its dependencies');
            }
        });

        it('require_aCopyWithABrokenDependency_throwsInsteadOfExportingAHalfLoadedHook', () => {
            const copy = makeHookCopy();
            fs.appendFileSync(copy.lib('hook-input.js'), '\n)(\n');

            expect(() => require(copy.hook)).toThrow();
        });
    });

    describe('M3 hook registration and transport files are in the tier', () => {
        it.each([
            '.claude/settings.local.json',
            '.agents/adapters/codex/hooks.js',
            '.agents/adapters/codex/hooks-config.json',
            '.codex/hooks.json',
            '.codex/hook-identities.json',
        ])('spawnedHook_subagentWriteTo_%s_exits2_andTheMainThreadMayWriteIt', (rel) => {
            installShipped();

            expect(spawnScript(HOOK, write(abs(rel), SUBAGENT)).exitCode).toBe(2);
            expect(spawnScript(HOOK, write(abs(rel))).exitCode).toBe(0);
        });

        it('spawnedHook_subagentWriteOfDisableAllHooksToTheLocalSettings_isBlocked', () => {
            installShipped();
            const payload = { tool_name: 'Write', tool_input: { file_path: abs('.claude/settings.local.json'), content: '{"disableAllHooks":true}' }, ...SUBAGENT };

            expect(spawnScript(HOOK, payload).exitCode).toBe(2);
        });
    });

    describe('M4 the hook’s own freeze-state input and the judge’s state files are in the tier', () => {
        it.each([
            'docs/.output/.state/freeze-state.json',
            'docs/.output/.state/telemetry/gate-failures.jsonl',
            'docs/.output/.state/telemetry/gate-receipt.json',
            'docs/.output/.state/telemetry/gate-receipts/by-id/SF-1.8.json',
            'docs/.output/.state/telemetry/gate-receipts/0123abcd.json',
        ])('spawnedHook_subagentWriteTo_%s_exits2_andTheMainThreadMayWriteIt', (rel) => {
            installShipped();

            expect(spawnScript(HOOK, write(abs(rel), SUBAGENT)).exitCode).toBe(2);
            expect(spawnScript(HOOK, write(abs(rel))).exitCode).toBe(0);
        });

        it('spawnedHook_aSubagentCannotEmptyTheLockListThatFreezesAPath', () => {
            installShipped();
            tmp.write('docs/.output/.state/freeze-state.json', JSON.stringify({ frozen: [abs('src/frozen.js')] }));

            const unfreeze = spawnScript(HOOK, write(abs('docs/.output/.state/freeze-state.json'), SUBAGENT));
            const frozenWrite = spawnScript(HOOK, write(abs('src/frozen.js'), SUBAGENT));

            expect(unfreeze.exitCode).toBe(2);
            expect(frozenWrite.exitCode).toBe(2);
            expect(frozenWrite.stderr.toLowerCase()).toContain('frozen');
        });
    });

    describe('M5 the gate’s command inputs are in the tier', () => {
        it.each([
            'vitest.config.mjs',
            'tools/run-toolkit-tests.cjs',
        ])('spawnedHook_subagentWriteTo_%s_exits2_andTheMainThreadMayWriteIt', (rel) => {
            installShipped();

            expect(spawnScript(HOOK, write(abs(rel), SUBAGENT)).exitCode).toBe(2);
            expect(spawnScript(HOOK, write(abs(rel))).exitCode).toBe(0);
        });

        it('theRealTestConfigPathIsTheRootVitestConfigNotAToolsOne_andTheRunnerNamesIt', () => {
            // The review named tools/vitest.config.mjs; the file the runner actually loads is the root one.
            const repo = path.resolve(AGENTS_DIR, '..');
            const runner = fs.readFileSync(path.join(repo, 'tools', 'run-toolkit-tests.cjs'), 'utf8');

            expect(fs.existsSync(path.join(repo, 'vitest.config.mjs'))).toBe(true);
            expect(fs.existsSync(path.join(repo, 'tools', 'vitest.config.mjs'))).toBe(false);
            expect(runner).toContain("'vitest.config.mjs'");
        });

        // Orchestrator decision: package.json is not shipped in the tier (ordinary dependency work edits it).
        it('spawnedHook_packageJsonIsNotInTheShippedTier_aSubagentMayEditIt', () => {
            installShipped();

            expect(spawnScript(HOOK, write(abs('package.json'), SUBAGENT)).exitCode).toBe(0);
            expect(spawnScript(HOOK, write(abs('vitest.config.mjs'), SUBAGENT)).exitCode).toBe(2);
        });

        it('spawnedHook_anAdopterWhoLiftsVitestConfig_mayLetItsSubagentsEditIt', () => {
            installShipped();
            tmp.write('.claude/guardrail-rules.project.yaml', 'except:\n  subagentReadOnlyPaths:\n    - vitest.config.mjs\n');

            expect(spawnScript(HOOK, write(abs('vitest.config.mjs'), SUBAGENT)).exitCode).toBe(0);
        });

        it('spawnedHook_anAdopterWhoLiftsItsOwnVitestConfigTs_stillHasTheOtherConfigNamesWalled', () => {
            // The names are listed one by one so a lift is exact: lifting vitest.config.ts does not lift the family.
            installShipped();
            tmp.write('.claude/guardrail-rules.project.yaml', 'except:\n  subagentReadOnlyPaths:\n    - vitest.config.ts\n');

            expect(spawnScript(HOOK, write(abs('vitest.config.ts'), SUBAGENT)).exitCode).toBe(0);
            expect(spawnScript(HOOK, write(abs('vitest.config.mts'), SUBAGENT)).exitCode).toBe(2);
            expect(spawnScript(HOOK, write(abs('vite.config.ts'), SUBAGENT)).exitCode).toBe(2);
            expect(spawnScript(HOOK, write(abs('vitest.config.mjs'), SUBAGENT)).exitCode).toBe(2);
        });
    });

    describe('m1 an internal deadline fails the hook closed', () => {
        it('spawnedHook_stdinThatNeverCloses_pastTheDeadline_exits2WithTheDeadlineNamed', async () => {
            const child = spawn(process.execPath, [HOOK], {
                env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, HOOK_STDIN_TIMEOUT_MS: '30000', HOOK_DEADLINE_MS: '250' },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            child.stdin.write('{"tool_name":"Write"'); // truncated; stdin intentionally left open
            let stderr = '';
            child.stderr.on('data', (c) => { stderr += c; });
            const exitCode = await new Promise((resolve) => child.on('exit', resolve));

            expect(exitCode).toBe(2);
            expect(stderr).toContain('deadline');
        }, 15000);

        it('spawnedHook_aNormalRunUnderADeadline_isNotCutShort', () => {
            installShipped();

            const result = spawnScript(HOOK, write(abs('src/a.js')), { HOOK_DEADLINE_MS: '5000' });

            expect(result.exitCode).toBe(0);
        });

        it('settings_everyPathGuardrailAndGuardrailEntryCarriesATimeoutAboveTheInternalDeadlineAndTheWrapperBound', () => {
            const settings = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, 'adapters', 'claude', 'settings.json'), 'utf8'));
            const entries = settings.hooks.PreToolUse.flatMap((group) => group.hooks)
                .filter((hook) => /hooks\/(path-guardrail|guardrail)\.cjs/.test(hook.command));

            // 4 gated tools for path-guardrail + the one Bash|PowerShell entry for guardrail
            expect(entries.length).toBe(5);
            // internal deadline 8 s < wrapper spawn bound 9 s < hook timeout 10 s: our own failure always wins
            for (const entry of entries) expect(entry.timeout, entry.command).toBe(10);
        });
    });

    describe('m2 Windows path spellings', () => {
        const { hasWindowsAliasSegment } = loadHookExports();

        function loadHookExports() {
            // The pure helper does not read the project root, so it can be loaded once at describe time.
            return require('../../../.agents/hooks/path-guardrail.cjs');
        }

        it.each([
            ['a trailing dot', '.claude\\settings.json.'],
            ['a trailing space', '.agents/core/gate.js '],
            ['a dotted directory segment', '.agents\\core.\\gate.js'],
            ['an alternate data stream', '.claude\\settings.json::$DATA'],
            ['a stream on a drive path', 'C:\\proj\\.claude\\settings.json:evil'],
            ['an 8.3 short name', 'C:\\proj\\CLAUDE~1\\settings.json'],
            ['a short name in an extended path', '\\\\?\\C:\\proj\\AGENTS~1\\core\\gate.js'],
            ['a wildcard', '.agents/core/g*.js'],
            ['a question mark', '.agents/core/gate.j?'],
            ['an angle bracket', '.agents/core/<gate>.js'],
        ])('hasWindowsAliasSegment_%s_isRefused', (_label, p) => {
            expect(hasWindowsAliasSegment(p)).toBe(true);
        });

        it.each([
            ['a drive-letter path', 'C:\\work\\proj\\.claude\\settings.json'],
            ['a lower-case drive with forward slashes', 'c:/proj/.agents/core/gate.js'],
            ['an extended-length path', '\\\\?\\C:\\proj\\.agents\\core\\gate.js'],
            ['a device-namespace path', '\\\\.\\C:\\proj\\a.js'],
            ['an extended UNC path', '\\\\?\\UNC\\server\\share\\proj\\a.js'],
            ['a plain UNC path', '\\\\server\\share\\proj\\a.js'],
            ['a relative path with dot segments', './src/../src/a.js'],
            ['an ordinary POSIX path', '/srv/proj/src/a.js'],
            ['a dotfile directory', '.agents/hooks/x.cjs'],
            ['a name with an inner dot run', 'src/a..b.js'],
        ])('hasWindowsAliasSegment_%s_isAllowed', (_label, p) => {
            expect(hasWindowsAliasSegment(p)).toBe(false);
        });

        it.each([[undefined], [null], [42], [{}]])('hasWindowsAliasSegment_nonString_%s_isFalseNotAThrow', (value) => {
            expect(hasWindowsAliasSegment(value)).toBe(false);
        });

        function withPlatform(value, fn) {
            const original = Object.getOwnPropertyDescriptor(process, 'platform');
            Object.defineProperty(process, 'platform', { value, configurable: true });
            try { return fn(); } finally { Object.defineProperty(process, 'platform', original); }
        }

        it('processEvent_onWin32_aSubagentWriteThroughAnAliasSpelling_isBlockedAsFailClosed', () => {
            installShipped();
            const { processEvent } = loadHook();

            const result = withPlatform('win32', () => processEvent(write(abs('.claude/settings.json::$DATA'), SUBAGENT)));

            expect(result).toMatchObject({ block: true });
            expect(result.feedback).toContain('Windows path alias');
            expect(result.feedback).toContain('fail-closed');
        });

        it('processEvent_onWin32_theMainThreadMayUseAnAliasSpelling_theAliasRuleIsSubagentOnly', () => {
            installShipped();
            const { processEvent } = loadHook();

            expect(withPlatform('win32', () => processEvent(write(abs('src/notes.txt.'))))).toBeNull();
        });

        it('processEvent_offWin32_aTrailingDotNameIsNotOverBlockedForASubagent', () => {
            installShipped();
            const { processEvent } = loadHook();

            expect(processEvent(write(abs('src/notes.'), SUBAGENT))).toBeNull();
        });

        it.each([
            ['a drive-letter backslash path', (root) => `C:\\proj\\.agents\\core\\gate.js`],
            ['an extended-length path', () => '\\\\?\\C:\\proj\\.agents\\core\\gate.js'],
            ['a forward-slash extended path', () => '//?/C:/proj/.agents/core/gate.js'],
            ['a UNC path', () => '\\\\server\\share\\proj\\.agents\\core\\gate.js'],
            ['upper-cased directories with a drive', () => 'D:\\PROJ\\.AGENTS\\CORE\\GATE.JS'],
            ['mixed separators', (root) => `${root}\\.agents/core\\gate.js`],
            ['a long-s spelling NTFS folds onto the ASCII name', (root) => `${root}/.claude/\u017Fettings.json`],
        ])('spawnedHook_subagentWriteVia_%s_exits2', (_label, build) => {
            installShipped();

            const result = spawnScript(HOOK, write(build(tmp.root), SUBAGENT));

            expect(result.exitCode).toBe(2);
        });
    });

    describe('m3 the wall applies only to sessions whose payload carries agent_id, and the docs say so', () => {
        const source = fs.readFileSync(HOOK, 'utf8');
        const header = source.slice(0, source.indexOf("'use strict'"));
        const yaml = fs.readFileSync(SHIPPED_YAML, 'utf8');
        const tierComment = yaml.slice(yaml.indexOf('# Tier 4'), yaml.indexOf('subagentReadOnlyPaths:\n'));

        it.each([
            ['the header names headless main-thread runs', header, /headless/i],
            ['the header names scheduled runs', header, /scheduled/i],
            ['the header names agent-team teammates', header, /teammate/i],
            ['the header names Codex payloads', header, /Codex/],
            ['the header names nested claude -p runs', header, /claude -p/],
            ['the header says Bash is best effort', header, /best-effort/i],
            ['the header names the ship seal code hash as the backstop', header, /code hash/],
            ['the yaml comment names headless main-thread runs', tierComment, /headless/i],
            ['the yaml comment says Bash coverage is not a wall', tierComment, /NOT a wall/],
            ['the yaml comment names the ship seal code hash as the backstop', tierComment, /code hash/],
            ['the yaml comment names Codex payloads without agent_id', tierComment, /Codex/],
            ['the yaml comment warns the matcher is an unanchored suffix match (n2)', tierComment, /UNANCHORED/],
            ['the yaml comment notes hook tests are blocked for subagents (J-7)', tierComment, /hook tests/],
            ['the yaml comment explains why package.json is not listed', tierComment, /package\.json` is deliberately NOT listed/],
        ])('docs_%s', (_label, text, pattern) => {
            expect(text).toMatch(pattern);
        });

        it('docs_theHeaderNoLongerPromisesAWallBeyondTheEditTools', () => {
            expect(header).not.toMatch(/Bash (?:is|are) (?:fully )?(?:covered|protected)/i);
            expect(header).toMatch(/Windows aliases/);
        });
    });

    describe('m4 a rules file that parses but lacks the tier key', () => {
        it('spawnedHook_keylessRulesFile_subagentGateWriteExits2_andTheMainThreadStillExits0', () => {
            tmp.write('.claude/guardrail-rules.yaml', 'zeroAccessPaths:\n  - secrets.txt\n');

            expect(spawnScript(HOOK, write(abs('.agents/core/gate.js'), SUBAGENT)).exitCode).toBe(2);
            expect(spawnScript(HOOK, write(abs('.agents/core/gate.js'))).exitCode).toBe(0);
        });

        it('spawnedHook_keylessRulesFile_stillEnforcesTheTiersItDoesHave', () => {
            tmp.write('.claude/guardrail-rules.yaml', 'zeroAccessPaths:\n  - secrets.txt\n');

            expect(spawnScript(HOOK, write(abs('secrets.txt'), SUBAGENT)).exitCode).toBe(2);
            expect(spawnScript(HOOK, write(abs('src/ok.js'), SUBAGENT)).exitCode).toBe(0);
        });
    });

    describe('n1 internal-error blocks name the fail-closed class, not the zero-access tier', () => {
        it('processEvent_nonStringPath_feedbackLabelsTheTierFailClosed', () => {
            installShipped();
            const { processEvent } = loadHook();

            const result = processEvent({ tool_name: 'Write', tool_input: { file_path: 123 } });

            expect(result).toMatchObject({ block: true });
            expect(result.feedback).toContain('Tier    : fail-closed');
            expect(result.feedback).not.toContain('zeroAccessPaths');
        });
    });
});
