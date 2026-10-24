// Tests for the `prune-unused` CLI command (ME-1.2).
// Covers dry-run (default), --commit, [category] filter, --min-exposure filter,
// and the dead-weight analytics block in `analytics`.
//
// The CLI is run as a subprocess via spawnSync so that module-load-time constants
// (EXPOSURE_MIN_ACTIVE_DAYS) are read fresh in each subprocess, making env vars
// like MEMORY_EXPOSURE_MIN_DAYS effective.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');

const projectRoot = path.resolve(__dirname, '../../../.agents/core', '..', '..');
const cliScript = path.join(projectRoot, '.claude', 'core', 'memory-manager-cli.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Seed a backdated never-used memory by writing JSON directly to the expected
 * path under tmp.root. Sets `created` to daysAgo calendar days in the past.
 */
function seedMemory(tmp, category, id, daysAgo, overrides = {}) {
    const created = new Date(Date.now() - daysAgo * 86400000).toISOString();
    const content = {
        id,
        category,
        created,
        updated: created,
        confidence: 0.7,
        usage_count: 0,
        content: { description: `Test memory ${id} seeded at ${daysAgo} days ago` },
        ...overrides,
    };
    const dir = path.join(tmp.root, 'docs', '.output', '.memory', category);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(content, null, 2));
}

/**
 * Run the CLI via spawnSync, returning { status, stdout, stderr }.
 * CLAUDE_PROJECT_DIR is always set to tmp.root.
 */
function runCli(args, tmp, extraEnv = {}) {
    const result = spawnSync('node', [cliScript, ...args], {
        cwd: projectRoot,
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, ...extraEnv },
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
    tmp = createTmpDir({ prefix: 'cli-prune-test-' });
});

afterEach(() => {
    tmp.cleanup();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('prune-unused CLI command', () => {

    // AC-3: dry run is the default — no --commit means nothing is deleted

    it('dryRun_noCommitFlag_listsVictimsWithoutDeleting', () => {
        // Arrange — one 40-day-old never-used memory (qualifies past 30-day threshold)
        seedMemory(tmp, 'patterns', 'dead-old-one', 40);

        const filePath = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'dead-old-one.json');
        expect(fs.existsSync(filePath)).toBe(true); // pre-condition

        // Act — prune-unused with no flags
        const { status, stdout } = runCli(['prune-unused'], tmp);

        // Assert — exits 0, says DRY RUN, lists the candidate, file still exists
        expect(status).toBe(0);
        expect(stdout).toMatch(/dry run/i);
        expect(stdout).toContain('patterns/dead-old-one');
        expect(stdout).toMatch(/WOULD DELETE/i);
        expect(fs.existsSync(filePath)).toBe(true); // key: not deleted
    });

    it('dryRun_recentMemory_notListed', () => {
        // Arrange — 5-day-old memory does not qualify (below 30-day threshold)
        seedMemory(tmp, 'patterns', 'fresh-one', 5);

        const { status, stdout } = runCli(['prune-unused'], tmp);

        expect(status).toBe(0);
        expect(stdout).not.toContain('patterns/fresh-one');
        expect(stdout).toContain('No dead-weight candidates');
    });

    it('dryRun_withCategoryFilter_onlyShowsThatCategory', () => {
        // Arrange — two old memories in different categories
        seedMemory(tmp, 'patterns', 'old-pattern', 40);
        seedMemory(tmp, 'constraints', 'old-constraint', 40);

        // Act — filter to patterns only
        const { status, stdout } = runCli(['prune-unused', 'patterns'], tmp);

        expect(status).toBe(0);
        expect(stdout).toContain('patterns/old-pattern');
        expect(stdout).not.toContain('constraints/old-constraint');
    });

    it('dryRun_withMinExposureFilter_tightensThreshold', () => {
        // Arrange — two old memories: 35 and 42 days old
        seedMemory(tmp, 'patterns', 'just-old', 35);
        seedMemory(tmp, 'patterns', 'very-old', 42);

        // Act — require at least 40 active-days, so only very-old qualifies
        const { status, stdout } = runCli(['prune-unused', '--min-exposure', '40'], tmp);

        expect(status).toBe(0);
        expect(stdout).toContain('patterns/very-old');
        expect(stdout).not.toContain('patterns/just-old');
    });

    it('commit_deletesQualifyingMemories', () => {
        // Arrange — two 40-day-old never-used memories
        seedMemory(tmp, 'patterns', 'victim-a', 40);
        seedMemory(tmp, 'patterns', 'victim-b', 40);

        const pathA = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'victim-a.json');
        const pathB = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'victim-b.json');
        expect(fs.existsSync(pathA)).toBe(true);
        expect(fs.existsSync(pathB)).toBe(true);

        // Act
        const { status, stdout } = runCli(['prune-unused', '--commit'], tmp);

        // Assert — exits 0, says DELETED, files are gone
        expect(status).toBe(0);
        expect(stdout).toMatch(/DELETED/i);
        expect(fs.existsSync(pathA)).toBe(false);
        expect(fs.existsSync(pathB)).toBe(false);
    });

    it('commit_withCategoryFilter_onlyDeletesFilteredCategory', () => {
        // Arrange
        seedMemory(tmp, 'patterns', 'del-pat', 40);
        seedMemory(tmp, 'constraints', 'keep-con', 40);

        const pathPat = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'del-pat.json');
        const pathCon = path.join(tmp.root, 'docs', '.output', '.memory', 'constraints', 'keep-con.json');

        // Act — only delete patterns category
        const { status } = runCli(['prune-unused', 'patterns', '--commit'], tmp);

        expect(status).toBe(0);
        expect(fs.existsSync(pathPat)).toBe(false); // deleted
        expect(fs.existsSync(pathCon)).toBe(true);  // untouched
    });

    it('commit_usedMemory_notDeleted', () => {
        // Arrange — old but has usage_count > 0 (not dead-weight)
        seedMemory(tmp, 'patterns', 'used-old', 40, { usage_count: 2 });

        const filePath = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'used-old.json');

        const { status, stdout } = runCli(['prune-unused', '--commit'], tmp);

        expect(status).toBe(0);
        expect(fs.existsSync(filePath)).toBe(true); // not deleted — usage_count > 0
        // Confirm it wasn't listed as a deletion
        expect(stdout).not.toContain('patterns/used-old');
    });

    it('dryRun_emptyStore_exits0WithNoCandidatesMessage', () => {
        // Arrange — empty store (just ensure the memories dir exists to avoid any
        // path issues, but leave it empty so there are no candidates)
        fs.mkdirSync(path.join(tmp.root, 'docs', '.output', '.memory'), { recursive: true });

        const { status, stdout } = runCli(['prune-unused'], tmp);

        expect(status).toBe(0);
        expect(stdout).toMatch(/dry run/i);
        expect(stdout).toContain('No dead-weight candidates');
    });

});

describe('analytics CLI dead-weight section', () => {

    it('analytics_withDeadWeightMemory_rendersDeadWeightBlock', () => {
        // Arrange — 40-day-old never-used memory
        seedMemory(tmp, 'patterns', 'dw-render-test', 40);

        const { status, stdout } = runCli(['analytics'], tmp);

        expect(status).toBe(0);
        expect(stdout).toContain('Dead-weight candidates (REVIEW, do not auto-delete)');
        expect(stdout).toContain('patterns/dw-render-test');
        // Should include active-days and decayed confidence
        expect(stdout).toMatch(/active-days ago/);
        expect(stdout).toMatch(/decayed \d+\.\d{3}/);
        // Should include store size accounting
        expect(stdout).toMatch(/Store size:/);
        // Should include the lower-bound caveat
        expect(stdout).toMatch(/lower bound/i);
    });

    it('analytics_deadWeightSection_appearsAfterPruneSectionBeforeInjection', () => {
        // Arrange — 40-day-old memory to trigger a non-empty dead-weight block
        seedMemory(tmp, 'patterns', 'dw-order-test', 40);

        const { status, stdout } = runCli(['analytics'], tmp);

        expect(status).toBe(0);

        // Locate positions of key section headers
        const pruneIdx = stdout.indexOf('Prune candidates');
        const deadWeightIdx = stdout.indexOf('Dead-weight candidates');
        const injectionIdx = stdout.indexOf('Injection economics');

        expect(pruneIdx).toBeGreaterThanOrEqual(0);
        expect(deadWeightIdx).toBeGreaterThanOrEqual(0);
        expect(injectionIdx).toBeGreaterThanOrEqual(0);

        // Dead-weight must appear AFTER prune and BEFORE injection economics
        expect(deadWeightIdx).toBeGreaterThan(pruneIdx);
        expect(deadWeightIdx).toBeLessThan(injectionIdx);
    });

    it('analytics_deadWeightSection_includesCategorySummary', () => {
        // Arrange — old memories in two categories
        seedMemory(tmp, 'patterns', 'dw-cat-pat', 40);
        seedMemory(tmp, 'constraints', 'dw-cat-con', 40);

        const { status, stdout } = runCli(['analytics'], tmp);

        expect(status).toBe(0);
        // Per-category summary line
        expect(stdout).toMatch(/By category:/);
        expect(stdout).toMatch(/patterns: \d+/);
        expect(stdout).toMatch(/constraints: \d+/);
    });

});
