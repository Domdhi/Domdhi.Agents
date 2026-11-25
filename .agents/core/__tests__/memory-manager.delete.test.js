// Tests for deleteMemory (R-B): support for the /review:memory-defrag command's
// merge operations. Mirrors the inbox method shape ({deleted: bool, error?}).
//
// Plan: docs/.output/plans/2026-05-11-do-r-b-memory-defrag.md

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const MemoryManager = require('../../../.agents/core/memory-manager');
const { createTmpDir } = require('./_helpers/tmp-dir');

const projectRoot = path.resolve(__dirname, '../../../.agents/core', '..', '..');
const managerScript = path.join(projectRoot, '.claude', 'core', 'memory-manager.js');

let tmp;
let originalEnv;
let managersThisTest = [];

function makeManager() {
  const m = new MemoryManager();
  managersThisTest.push(m);
  return m;
}

function closeManagers() {
  for (const m of managersThisTest) {
    if (m.db) {
      try { m.db.close(); } catch { /* non-fatal */ }
      m.db = null;
    }
  }
  managersThisTest = [];
}

beforeEach(() => {
  managersThisTest = [];
  tmp = createTmpDir();
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
  closeManagers();
  if (originalEnv === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalEnv;
  }
  tmp.cleanup();
});

describe('memory-manager deleteMemory', () => {

  it('deleteMemory_existingMemory_unlinkAndDeindex', async () => {
    const m = makeManager();
    await m.createMemory('patterns', 'to-delete', { description: 'doomed' });
    const filePath = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'to-delete.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const result = await m.deleteMemory('patterns', 'to-delete');

    expect(result.deleted).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    // After delete, readMemory returns null
    const reread = await m.readMemory('patterns', 'to-delete');
    expect(reread).toBeNull();
  });

  it('deleteMemory_missing_returnsError', async () => {
    const m = makeManager();
    const result = await m.deleteMemory('patterns', 'never-existed');
    expect(result.deleted).toBe(false);
    expect(result.error).toMatch(/not found|missing|ENOENT/i);
  });

  it('deleteMemory_invalidCategory_returnsError', async () => {
    const m = makeManager();
    const result = await m.deleteMemory('not-a-real-category', 'whatever');
    expect(result.deleted).toBe(false);
    expect(result.error).toMatch(/category/i);
  });

  it('deleteMemory_existingMemory_searchNoLongerSurfaces', async () => {
    const m = makeManager();
    await m.createMemory('constraints', 'unique-search-term-zzqxv', {
      description: 'A memory with a unique-search-term-zzqxv that proves indexing.',
    });

    // Confirm it surfaces
    const beforeDelete = await m.searchMemories('unique-search-term-zzqxv');
    expect(beforeDelete.length).toBeGreaterThan(0);

    await m.deleteMemory('constraints', 'unique-search-term-zzqxv');

    const afterDelete = await m.searchMemories('unique-search-term-zzqxv');
    expect(afterDelete.length).toBe(0);
  });

  it('deleteMemory_doesNotAffectSiblings', async () => {
    const m = makeManager();
    await m.createMemory('patterns', 'keep-me', { description: 'survivor' });
    await m.createMemory('patterns', 'doomed', { description: 'goner' });

    await m.deleteMemory('patterns', 'doomed');

    const survivor = await m.readMemory('patterns', 'keep-me');
    expect(survivor).not.toBeNull();
    expect(survivor.content.description).toBe('survivor');
  });

  it('cli_delete_happyPath_exits0', async () => {
    const m = makeManager();
    await m.createMemory('workflows', 'cli-test-target', { description: 'cli test' });
    closeManagers(); // release sqlite lock before spawning subprocess

    const result = spawnSync('node', [managerScript, 'delete', 'workflows', 'cli-test-target'], {
      cwd: projectRoot,
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root },
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Deleted');
    const filePath = path.join(tmp.root, 'docs', '.output', '.memory', 'workflows', 'cli-test-target.json');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('cli_delete_missing_exits1', () => {
    const result = spawnSync('node', [managerScript, 'delete', 'patterns', 'never-existed-cli'], {
      cwd: projectRoot,
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root },
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not found|missing|failed/i);
  });

  it('cli_delete_missingArgs_exits1', () => {
    const result = spawnSync('node', [managerScript, 'delete'], {
      cwd: projectRoot,
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root },
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires|category/i);
  });

});

describe('memory-manager deleteMemory refuses a referenced memory', () => {
  it.each([
    ['a [[wiki-link]] in prose', { description: 'See [[target-mem]] for the rule.' }],
    ['a references[] entry', { description: 'x', references: ['target-mem'] }],
    ['a related[] entry', { description: 'x', related: ['target-mem'] }],
    ['a see_also { id } entry', { description: 'x', see_also: [{ category: 'patterns', id: 'target-mem' }] }],
  ])('refuses when another memory cites it by %s, and lists the referrer', async (_name, content) => {
    const m = makeManager();
    await m.createMemory('patterns', 'target-mem', { description: 'the target' });
    await m.createMemory('constraints', 'citing-mem', content);

    const result = await m.deleteMemory('patterns', 'target-mem');

    expect(result.deleted).toBe(false);
    expect(result.referencedBy).toEqual(['constraints/citing-mem']);
    expect(result.error).toMatch(/RESOLVED note/);
    expect(await m.readMemory('patterns', 'target-mem')).not.toBeNull();
  });

  it('deletes a referenced memory with force', async () => {
    const m = makeManager();
    await m.createMemory('patterns', 'target-mem', { description: 'the target' });
    await m.createMemory('patterns', 'citing-mem', { description: 'See [[target-mem]].' });

    const result = await m.deleteMemory('patterns', 'target-mem', { force: true });

    expect(result.deleted).toBe(true);
  });

  it('a memory citing a longer id with the same prefix is not a referrer', async () => {
    const m = makeManager();
    await m.createMemory('patterns', 'target-mem', { description: 'the target' });
    await m.createMemory('patterns', 'other-mem', { description: 'See [[target-mem-two]].', see_also: ['target-mem-two'] });

    expect((await m.deleteMemory('patterns', 'target-mem')).deleted).toBe(true);
  });

  it('CLI delete exits 1 naming the referrer, and --force deletes', async () => {
    const m = makeManager();
    await m.createMemory('patterns', 'target-mem', { description: 'the target' });
    await m.createMemory('patterns', 'citing-mem', { description: 'See [[target-mem]].' });
    closeManagers();
    const env = { ...process.env, CLAUDE_PROJECT_DIR: tmp.root };
    const opts = { cwd: tmp.root, env, encoding: 'utf-8', windowsHide: true, timeout: 15_000 };

    const refused = spawnSync('node', [managerScript, 'delete', 'patterns', 'target-mem'], opts);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('patterns/citing-mem');

    const forced = spawnSync('node', [managerScript, 'delete', 'patterns', 'target-mem', '--force'], opts);
    expect(forced.status).toBe(0);
  });
});
