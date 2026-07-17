// Tests for the `supersede` CLI command (ME-3.3).
// Verifies arg validation, success path (old memory stamped with invalid_at and
// hidden from default list/search), idempotency, and failure paths.
//
// Runs in isolation: npx vitest run .claude/core/__tests__/memory-manager-cli.supersede.test.js

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const MemoryManager = require('../memory-manager');
const { main: cliMain } = require('../memory-manager-cli');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const cliScript = path.join(projectRoot, '.claude', 'core', 'memory-manager-cli.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Seed a memory by writing JSON directly to the expected path under tmp.root.
 */
function seedMemory(tmp, category, id, overrides = {}) {
    const now = new Date().toISOString();
    const content = {
        id,
        category,
        created: now,
        updated: now,
        confidence: 0.7,
        usage_count: 0,
        content: { description: `Test memory ${id}` },
        ...overrides,
    };
    const dir = path.join(tmp.root, 'docs', '.output', '.memory', category);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(content, null, 2));
}

/**
 * Read a memory JSON file from tmp, return parsed object (or null if absent).
 */
function readMemory(tmp, category, id) {
    const filePath = path.join(tmp.root, 'docs', '.output', '.memory', category, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Run the CLI via spawnSync with CLAUDE_PROJECT_DIR set to tmp.root.
 */
function runCli(args, tmp) {
    const result = spawnSync('node', [cliScript, ...args], {
        cwd: projectRoot,
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root },
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 15_000,
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

// ─── Per-test sandbox ────────────────────────────────────────────────────────

let tmp;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'cli-supersede-test-' });
});

afterEach(() => {
    tmp.cleanup();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('supersede CLI command — success path', () => {

    it('stamps invalid_at on the old memory JSON', async () => {
        // Arrange
        seedMemory(tmp, 'patterns', 'old-pattern');
        seedMemory(tmp, 'patterns', 'new-pattern');

        // Act
        const { status, stdout } = runCli(['supersede', 'patterns', 'old-pattern', 'new-pattern'], tmp);

        // Assert exit 0 and success output
        expect(status).toBe(0);
        expect(stdout).toContain('Superseded');
        expect(stdout).toContain('patterns/old-pattern');
        expect(stdout).toContain('new-pattern');

        // Assert JSON file has invalid_at stamped
        const oldMem = readMemory(tmp, 'patterns', 'old-pattern');
        expect(oldMem).not.toBeNull();
        expect(oldMem.invalid_at).toBeTruthy();
        expect(typeof oldMem.invalid_at).toBe('string');
    });

    it('sets superseded_by to the newId', () => {
        // Arrange
        seedMemory(tmp, 'constraints', 'old-constraint');
        seedMemory(tmp, 'constraints', 'new-constraint');

        // Act
        runCli(['supersede', 'constraints', 'old-constraint', 'new-constraint'], tmp);

        // Assert
        const oldMem = readMemory(tmp, 'constraints', 'old-constraint');
        expect(oldMem.superseded_by).toBe('new-constraint');
    });

    it('old memory is absent from default list after supersession', () => {
        // Arrange
        seedMemory(tmp, 'patterns', 'obsolete');
        seedMemory(tmp, 'patterns', 'replacement');

        // Supersede
        runCli(['supersede', 'patterns', 'obsolete', 'replacement'], tmp);

        // Act — list all patterns (default = no includeSuperseded)
        const { status, stdout } = runCli(['list', 'patterns'], tmp);

        expect(status).toBe(0);
        const listed = JSON.parse(stdout);
        const ids = listed.map(m => m.id);
        expect(ids).not.toContain('obsolete');
        expect(ids).toContain('replacement');
    });

    it('prints invalid_at in the success line', () => {
        // Arrange
        seedMemory(tmp, 'decisions', 'old-decision');
        seedMemory(tmp, 'decisions', 'new-decision');

        // Act
        const { stdout } = runCli(['supersede', 'decisions', 'old-decision', 'new-decision'], tmp);

        // Assert the success line contains the timestamp clause
        expect(stdout).toMatch(/invalid_at/);
        // The timestamp should look like an ISO date
        expect(stdout).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

});

describe('supersede CLI command — idempotency', () => {

    it('running supersede twice keeps the original invalid_at', () => {
        // Arrange
        seedMemory(tmp, 'patterns', 'idempotent-old');
        seedMemory(tmp, 'patterns', 'idempotent-new');

        // First supersede
        runCli(['supersede', 'patterns', 'idempotent-old', 'idempotent-new'], tmp);
        const firstMem = readMemory(tmp, 'patterns', 'idempotent-old');
        const firstInvalidAt = firstMem.invalid_at;

        // Second supersede (idempotent re-run)
        const { status } = runCli(['supersede', 'patterns', 'idempotent-old', 'idempotent-new'], tmp);

        // Assert still exits 0 and invalid_at unchanged
        expect(status).toBe(0);
        const secondMem = readMemory(tmp, 'patterns', 'idempotent-old');
        expect(secondMem.invalid_at).toBe(firstInvalidAt);
    });

});

describe('supersede CLI command — error handling', () => {

    it('exits 1 with error when category arg is missing', () => {
        const { status, stderr } = runCli(['supersede'], tmp);

        expect(status).toBe(1);
        expect(stderr).toContain('Error');
        expect(stderr).toContain('supersede requires');
    });

    it('exits 1 with error when oldId arg is missing', () => {
        const { status, stderr } = runCli(['supersede', 'patterns'], tmp);

        expect(status).toBe(1);
        expect(stderr).toContain('Error');
    });

    it('exits 1 with error when newId arg is missing', () => {
        const { status, stderr } = runCli(['supersede', 'patterns', 'old-id'], tmp);

        expect(status).toBe(1);
        expect(stderr).toContain('Error');
    });

    it('exits 1 when category is invalid', () => {
        // Arrange — seed with valid category but call with invalid one
        seedMemory(tmp, 'patterns', 'some-memory');

        const { status, stderr } = runCli(['supersede', 'not-a-category', 'some-memory', 'other-memory'], tmp);

        expect(status).toBe(1);
        expect(stderr).toContain('Supersede failed');
        expect(stderr).toContain('Invalid category');
    });

    it('exits 1 when old memory does not exist', () => {
        // No memory seeded
        const { status, stderr } = runCli(['supersede', 'patterns', 'nonexistent-id', 'new-id'], tmp);

        expect(status).toBe(1);
        expect(stderr).toContain('Supersede failed');
        expect(stderr).toContain('not found');
    });

});

// MEM-5 regression: supersede() can return { superseded: true, indexStale: true,
// warning: '...' } when the JSON write succeeds but the SQLite FTS update fails.
// The CLI must surface that warning, not print an indistinguishable flat success line.
describe('supersede CLI command — stale index warning (MEM-5)', () => {

    const originalArgv = process.argv;
    const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;

    afterEach(() => {
        process.argv = originalArgv;
        if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
        vi.restoreAllMocks();
    });

    it('prints the warning to stderr when supersede() reports indexStale', async () => {
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        vi.spyOn(MemoryManager.prototype, 'supersede').mockResolvedValue({
            superseded: true,
            category: 'patterns',
            oldId: 'old-id',
            newId: 'new-id',
            invalid_at: '2026-07-17T00:00:00.000Z',
            indexStale: true,
            warning: 'SQLite index update failed; JSON is stamped but the FTS index may still surface this memory until rebuild-index runs',
        });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        process.argv = ['node', 'memory-manager-cli.js', 'supersede', 'patterns', 'old-id', 'new-id'];
        await cliMain();

        const allOutput = [...warnSpy.mock.calls, ...errSpy.mock.calls, ...logSpy.mock.calls]
            .map((call) => call.join(' ')).join('\n');
        expect(allOutput).toContain('SQLite index update failed');
        expect(allOutput).toContain('rebuild-index');
    });

    it('does NOT print a warning when supersede() succeeds cleanly (no indexStale)', async () => {
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        vi.spyOn(MemoryManager.prototype, 'supersede').mockResolvedValue({
            superseded: true,
            category: 'patterns',
            oldId: 'old-id',
            newId: 'new-id',
            invalid_at: '2026-07-17T00:00:00.000Z',
        });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        process.argv = ['node', 'memory-manager-cli.js', 'supersede', 'patterns', 'old-id', 'new-id'];
        await cliMain();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(errSpy).not.toHaveBeenCalled();
        expect(logSpy.mock.calls.join(' ')).toContain('Superseded');
    });

});

describe('supersede CLI command — usage text', () => {

    it('usage block includes the supersede command', () => {
        // The default case (no command) prints usage
        const { status, stdout } = runCli([], tmp);

        expect(status).toBe(0);
        expect(stdout).toContain('supersede');
        expect(stdout).toContain('<oldId>');
        expect(stdout).toContain('<newId>');
    });

});
