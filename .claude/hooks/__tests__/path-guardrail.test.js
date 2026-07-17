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
    delete require.cache[require.resolve('../path-guardrail.cjs')];
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
        const { processEvent } = require('../path-guardrail.cjs');
        const result = processEvent({ tool_name: 'Bash', tool_input: { command: 'ls' } });
        expect(result).toBeNull();
    });

    it('returns null for Read tool (not gated)', () => {
        const { processEvent } = require('../path-guardrail.cjs');
        const result = processEvent({ tool_name: 'Read', tool_input: { file_path: '.env' } });
        expect(result).toBeNull();
    });

    it('returns null when Write tool has no file_path', () => {
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
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

        const { processEvent } = require('../path-guardrail.cjs');
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

        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'NotebookEdit',
            tool_input: { new_source: 'x' },
        });
        expect(result).toBeNull();
    });

    it('returns null for MultiEdit when file_path is missing', () => {
        writeRules('block_patterns:\nconfirm_patterns:\n');
        const { processEvent } = require('../path-guardrail.cjs');
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
        const { processEvent } = require('../path-guardrail.cjs');
        const result = processEvent({
            tool_name: 'NotebookEdit',
            tool_input: { notebook_path: 'safe.ipynb', file_path: '.env' },
        });
        expect(result).toBeNull();
    });
});

describe('path-guardrail getTargetPath', () => {
    it('returns notebook_path for NotebookEdit', () => {
        const { getTargetPath } = require('../path-guardrail.cjs');
        expect(getTargetPath('NotebookEdit', { notebook_path: 'a.ipynb' })).toBe('a.ipynb');
    });

    it('returns file_path for Write/Edit/MultiEdit', () => {
        const { getTargetPath } = require('../path-guardrail.cjs');
        expect(getTargetPath('Write', { file_path: 'a.txt' })).toBe('a.txt');
        expect(getTargetPath('Edit', { file_path: 'b.txt' })).toBe('b.txt');
        expect(getTargetPath('MultiEdit', { file_path: 'c.txt' })).toBe('c.txt');
    });

    it('returns empty string when path field is absent', () => {
        const { getTargetPath } = require('../path-guardrail.cjs');
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
    const hookPath = require.resolve('../path-guardrail.cjs');
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
