// Regression test for the circular-require ordering bug introduced by the
// memory-manager CLI split (Task #11). When memory-manager.js is invoked as the
// entry point, it delegates to memory-manager-cli.js, which re-requires
// memory-manager.js — at that moment the exports must already be populated,
// or the CLI sees `{}` and fails with "MemoryManager is not a constructor".
//
// Caught 2026-04-24 during session attempting to create a workflow memory via
// the CLI. Unit tests didn't cover the CLI entry path, so the bug hid.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(__dirname, '../../../.agents/core', '..', '..');
const managerScript = path.join(projectRoot, '.claude', 'core', 'memory-manager.js');

function runCli(args) {
    const result = spawnSync('node', [managerScript, ...args], {
        cwd: projectRoot,
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 10_000,
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

describe('memory-manager CLI entry point', () => {
    it('does not fail with "not a constructor" on invocation', () => {
        const { status, stderr } = runCli(['lint']);
        expect(stderr).not.toContain('not a constructor');
        expect(stderr).not.toContain('Cannot read');
        expect(status).toBe(0);
    });

    it('prints usage when invoked with no command', () => {
        const { status, stdout } = runCli([]);
        expect(stdout).toContain('Usage:');
        expect(status).toBe(0);
    });

    // F40: an unknown/typo'd subcommand must exit non-zero (false-success guard).
    // Siblings memory-curator.js/memory-benchmark.js do process.exit(command ? 1 : 0).
    it('exits 1 for an unrecognized command', () => {
        const { status } = runCli(['not-a-real-command']);
        expect(status).toBe(1);
    });

    it('exits 0 for bare help (no command)', () => {
        const { status } = runCli([]);
        expect(status).toBe(0);
    });

    it('returns lint output as valid JSON', () => {
        const { status, stdout } = runCli(['lint']);
        expect(status).toBe(0);
        expect(() => JSON.parse(stdout)).not.toThrow();
        const parsed = JSON.parse(stdout);
        expect(parsed).toHaveProperty('total_memories');
    });
});

// Regression: create/update silently double-nested when the content JSON was
// wrapped in a redundant { "content": {…} } envelope — the memory's description
// ended up at content.content.description, read as empty, and injected as
// "(no summary)" at SessionStart. 6 stored memories were corrupted this way
// before the guard existed (caught 2026-06-09 during a /sweep defrag).
describe('unwrapContentEnvelope (create/update content guard)', () => {
    const { unwrapContentEnvelope } = require('../../../.agents/core/memory-manager-cli');

    it('unwraps a redundant { content: {…} } envelope', () => {
        const got = unwrapContentEnvelope({ content: { description: 'X', importance: 3 } });
        expect(got).toEqual({ description: 'X', importance: 3 });
    });

    it('leaves a correct flat content object untouched', () => {
        const flat = { description: 'X', evidence: 'Y', importance: 4 };
        expect(unwrapContentEnvelope(flat)).toBe(flat);
    });

    it('does NOT unwrap when real content fields sit beside a content key', () => {
        // A legitimate memory could carry both — never strip the top-level fields.
        const obj = { description: 'real', content: { nested: 'no' } };
        expect(unwrapContentEnvelope(obj)).toBe(obj);
    });

    it('does not unwrap a pattern-style flat object (uses `pattern`, not `description`)', () => {
        const flat = { pattern: 'do X when Y', importance: 3 };
        expect(unwrapContentEnvelope(flat)).toBe(flat);
    });

    it('ignores non-object / array inputs', () => {
        expect(unwrapContentEnvelope(null)).toBe(null);
        expect(unwrapContentEnvelope('str')).toBe('str');
        const arr = [{ content: {} }];
        expect(unwrapContentEnvelope(arr)).toBe(arr);
    });
});
