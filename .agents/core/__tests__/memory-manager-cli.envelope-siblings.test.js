// Regression: the create/update CLI unwrapped a redundant { "content": {…} }
// envelope but silently DROPPED fields written beside it, so
// '{"content":{"description":"x"},"importance":5,"see_also":["a-b"]}' stored a
// memory with the default importance and no see_also. Siblings that the store
// reads from content (importance, related, see_also, confidence) are now merged;
// a sibling that contradicts the same key inside the envelope exits 2.
// Cross-reference lists are also normalized to bare ids on write ("[[a-b]]" -> "a-b").

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const MemoryManager = require('../../../.agents/core/memory-manager');
const { unwrapContentEnvelope, EnvelopeClashError } = require('../../../.agents/core/memory-manager-cli');
const { createTmpDir } = require('./_helpers/tmp-dir');

const projectRoot = path.resolve(__dirname, '../../../.agents/core', '..', '..');
const cliScript = path.join(projectRoot, '.agents', 'core', 'memory-manager-cli.js');

function runCli(args, cwdRoot) {
  const result = spawnSync('node', [cliScript, ...args], {
    cwd: cwdRoot,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwdRoot },
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('unwrapContentEnvelope sibling fields', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('merges importance, related, see_also and confidence beside the envelope', () => {
    const got = unwrapContentEnvelope({
      content: { description: 'X' },
      importance: 5,
      related: ['r-one'],
      see_also: ['s-one'],
      confidence: 0.8,
    });
    expect(got).toEqual({ description: 'X', importance: 5, related: ['r-one'], see_also: ['s-one'], confidence: 0.8 });
  });

  it('accepts a sibling equal to the same key inside the envelope', () => {
    const got = unwrapContentEnvelope({ content: { description: 'X', importance: 4 }, importance: 4 });
    expect(got).toEqual({ description: 'X', importance: 4 });
  });

  it('throws EnvelopeClashError when a sibling contradicts the envelope', () => {
    expect(() => unwrapContentEnvelope({ content: { description: 'X', importance: 2 }, importance: 5 }))
      .toThrow(EnvelopeClashError);
    expect(() => unwrapContentEnvelope({ content: { description: 'X', see_also: ['a-b'] }, see_also: ['c-d'] }))
      .toThrow(EnvelopeClashError);
  });

  it('warns about and ignores an unrecognized sibling instead of dropping it silently', () => {
    const got = unwrapContentEnvelope({ content: { description: 'X' }, category: 'patterns' });
    expect(got).toEqual({ description: 'X' });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('category'));
  });
});

describe('memory-manager CLI envelope siblings (temp store)', () => {
  let tmp;
  beforeEach(() => { tmp = createTmpDir(); });
  afterEach(() => { tmp.cleanup(); });

  const stored = (id) => JSON.parse(fs.readFileSync(
    path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', `${id}.json`), 'utf-8'));

  it('create stores the merged siblings (importance top-level, see_also bare in content)', () => {
    const { status, stderr } = runCli(['create', 'patterns', 'envelope-merge',
      JSON.stringify({ content: { description: 'merged' }, importance: 5, see_also: ['[[other-id]]'] })], tmp.root);
    expect(stderr).not.toContain('Error');
    expect(status).toBe(0);
    const m = stored('envelope-merge');
    expect(m.importance).toBe(5);
    expect(m.content.description).toBe('merged');
    expect(m.content.see_also).toEqual(['other-id']);
    expect(m.content.content).toBeUndefined();
  });

  it('create exits 2 and writes nothing on a clashing sibling', () => {
    const { status, stderr } = runCli(['create', 'patterns', 'envelope-clash',
      JSON.stringify({ content: { description: 'x', importance: 2 }, importance: 5 })], tmp.root);
    expect(status).toBe(2);
    expect(stderr).toContain('importance');
    expect(fs.existsSync(path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'envelope-clash.json'))).toBe(false);
  });

  it('update exits 2 on a clashing sibling', () => {
    const { status } = runCli(['update', 'patterns', 'any-id',
      JSON.stringify({ content: { related: ['a-b'] }, related: ['c-d'] })], tmp.root);
    expect(status).toBe(2);
  });

  it('help documents where importance, related and see_also live', () => {
    const { stdout } = runCli([], tmp.root);
    expect(stdout).toMatch(/importance \(1–5\)[^]*stored top-level/);
    expect(stdout).toMatch(/related, see_also,[^]*stored inside content/);
  });
});

describe('cross-reference lists are normalized to bare ids on write', () => {
  let tmp;
  let originalEnv;
  let manager;
  beforeEach(() => {
    tmp = createTmpDir();
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    if (manager?.db) { try { manager.db.close(); } catch { /* non-fatal */ } }
    manager = null;
    if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalEnv;
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it('createMemory strips [[…]] from see_also, references and related, and keeps the caller input intact', async () => {
    manager = new MemoryManager();
    const input = {
      description: 'd',
      see_also: ['[[a-one]]', { category: 'patterns', id: '[[b-two]]' }],
      references: ['[[c-three]]', 'd-four'],
      related: ['[[e-five]]'],
    };
    const m = await manager.createMemory('patterns', 'normalize-create', input);
    expect(m.content.see_also).toEqual(['a-one', { category: 'patterns', id: 'b-two' }]);
    expect(m.content.references).toEqual(['c-three', 'd-four']);
    expect(m.content.related).toEqual(['e-five']);
    expect(input.see_also[0]).toBe('[[a-one]]');
  });

  it('updateMemory normalizes the merged lists', async () => {
    manager = new MemoryManager();
    await manager.createMemory('patterns', 'normalize-update', { description: 'd' });
    const m = await manager.updateMemory('patterns', 'normalize-update', { content: { see_also: ['[[z-ten]]'] } });
    expect(m.content.see_also).toEqual(['z-ten']);
  });
});
