// AC→source map (CR-1.1 — symlink-safe writes & walks, F23/F81/F86/F55/F9/F80):
//   - safeWrite(dstPath, data): a symlinked destination is NOT followed — the link is
//     unlinked, a real file is written, the link's target is untouched
//   - safeCopy(srcPath, dstPath): same guard for the copyFileSync path
//   - both return { symlinkReplaced: boolean }
//   - walkDir yields symlinked FILES and traverses symlinked DIRS (stat-resolution,
//     not Dirent.isDirectory/isFile which are both false for a symlink)
//   - walkDir guards symlink CYCLES via a visited-realpath set (terminates)
//   - walkDir skipList pruning still applies to symlinked dirs

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const { safeWrite, safeCopy, safeDelete } = require('../../../.agents/core/_lib/fs-safe');
const { walkDir } = require('../../../.agents/core/_lib/file-walker');
const { createTmpDir } = require('./_helpers/tmp-dir');

// Symlink-capability probe — Windows checkouts without Developer Mode cannot
// create symlinks; skip rather than fail there (mirrors the hasSqlite probe style).
const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probeDir, 't.txt'), 'x');
    fs.symlinkSync(path.join(probeDir, 't.txt'), path.join(probeDir, 'l.txt'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

let tmp;

beforeEach(() => {
  tmp = createTmpDir();
});

afterEach(() => {
  tmp.cleanup();
});

describe.skipIf(!canSymlink)('fs-safe: safeWrite', () => {
  it('does not follow a symlinked destination — target untouched, link replaced by real file', () => {
    const victim = path.join(tmp.path, 'victim.txt');
    const link = path.join(tmp.path, 'link.txt');
    fs.writeFileSync(victim, 'VICTIM-CONTENT');
    fs.symlinkSync(victim, link);

    const result = safeWrite(link, 'PAYLOAD');

    expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM-CONTENT');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf8')).toBe('PAYLOAD');
    expect(result.symlinkReplaced).toBe(true);
  });

  it('writes normally to a non-symlink destination', () => {
    const dst = path.join(tmp.path, 'plain.txt');
    const result = safeWrite(dst, 'hello');

    expect(fs.readFileSync(dst, 'utf8')).toBe('hello');
    expect(result.symlinkReplaced).toBe(false);
  });

  it('overwrites an existing regular file in place', () => {
    const dst = path.join(tmp.path, 'existing.txt');
    fs.writeFileSync(dst, 'old');
    const result = safeWrite(dst, 'new');

    expect(fs.readFileSync(dst, 'utf8')).toBe('new');
    expect(result.symlinkReplaced).toBe(false);
  });
});

describe.skipIf(!canSymlink)('fs-safe: safeCopy', () => {
  it('does not follow a symlinked destination — target untouched, link replaced by real copy', () => {
    const src = path.join(tmp.path, 'src.txt');
    const victim = path.join(tmp.path, 'victim.txt');
    const link = path.join(tmp.path, 'link.txt');
    fs.writeFileSync(src, 'TEMPLATE-BYTES');
    fs.writeFileSync(victim, 'VICTIM-CONTENT');
    fs.symlinkSync(victim, link);

    const result = safeCopy(src, link);

    expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM-CONTENT');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf8')).toBe('TEMPLATE-BYTES');
    expect(result.symlinkReplaced).toBe(true);
  });

  it('copies normally to a non-symlink destination', () => {
    const src = path.join(tmp.path, 'src.txt');
    const dst = path.join(tmp.path, 'dst.txt');
    fs.writeFileSync(src, 'bytes');

    const result = safeCopy(src, dst);

    expect(fs.readFileSync(dst, 'utf8')).toBe('bytes');
    expect(result.symlinkReplaced).toBe(false);
  });
});

describe.skipIf(!canSymlink)('fs-safe: safeDelete (F3)', () => {
  it('deletes a plain file within containRoot', () => {
    const dst = path.join(tmp.path, 'gone.txt');
    fs.writeFileSync(dst, 'bye');

    safeDelete(dst, tmp.path);

    expect(fs.existsSync(dst)).toBe(false);
  });

  it('refuses to delete through a symlinked ancestor directory, leaving the victim untouched', () => {
    const victim = path.join(tmp.path, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'secret.txt'), 'VICTIM-CONTENT');
    const root = path.join(tmp.path, 'root');
    fs.mkdirSync(root);
    fs.symlinkSync(victim, path.join(root, 'linked-dir'), 'dir');

    expect(() => safeDelete(path.join(root, 'linked-dir', 'secret.txt'), root)).toThrow(/symlinked ancestor/);
    expect(fs.existsSync(path.join(victim, 'secret.txt'))).toBe(true);
  });

  it('is a no-op (does not throw) on a missing path', () => {
    expect(() => safeDelete(path.join(tmp.path, 'never-existed.txt'), tmp.path)).not.toThrow();
  });
});

describe.skipIf(!canSymlink)('file-walker: symlink handling (F9)', () => {
  it('yields a symlinked file instead of silently dropping it', () => {
    const outside = path.join(tmp.path, 'outside.txt');
    fs.writeFileSync(outside, 'x');
    const root = path.join(tmp.path, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'real.txt'), 'r');
    fs.symlinkSync(outside, path.join(root, 'linked.txt'));

    const found = [...walkDir(root, [])].map(p => path.basename(p)).sort();

    expect(found).toContain('real.txt');
    expect(found).toContain('linked.txt');
  });

  it('traverses a symlinked directory instead of silently dropping it', () => {
    const shared = path.join(tmp.path, 'shared-skills');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'SKILL.md'), 'skill');
    const root = path.join(tmp.path, 'root');
    fs.mkdirSync(root);
    fs.symlinkSync(shared, path.join(root, 'my-skill'), 'dir');

    const found = [...walkDir(root, [])];

    expect(found.some(p => p.endsWith(path.join('my-skill', 'SKILL.md')))).toBe(true);
  });

  it('terminates on a symlink cycle (visited-realpath guard)', () => {
    const root = path.join(tmp.path, 'root');
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'file.txt'), 'f');
    fs.symlinkSync(root, path.join(sub, 'loop'), 'dir');

    const found = [...walkDir(root, [])];

    expect(found.some(p => p.endsWith('file.txt'))).toBe(true);
    // Finite: the cycle is visited at most once, not expanded unboundedly.
    expect(found.length).toBeLessThan(10);
  });

  it('still prunes skipList names, including when symlinked', () => {
    const shared = path.join(tmp.path, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'inner.txt'), 'x');
    const root = path.join(tmp.path, 'root');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'd');
    fs.writeFileSync(path.join(root, 'keep.txt'), 'k');
    fs.symlinkSync(shared, path.join(root, '__tests__'), 'dir');

    const found = [...walkDir(root, ['node_modules', '__tests__'])].map(p => path.basename(p));

    expect(found).toContain('keep.txt');
    expect(found).not.toContain('dep.js');
    expect(found).not.toContain('inner.txt');
  });
});
