// AC→source map (L1H, wave-L1 review C1 part 2 — unsandboxed hook state writers follow symlinks):
//   - stateContainRoot(p): the directory above the FIRST `docs/.output` segment, else null
//   - safeAppend / safeOpenAppend: a symlinked leaf, a symlinked ancestor up to the root, and a FIFO leaf are
//     REFUSED (a refusal `isRefusal` recognizes) and the link's target is never written; a real file is appended to
//   - safeMkdirp: a symlinked ancestor is refused BEFORE the mkdir, so nothing is created inside the target
//   - safeWriteAtomic: a symlinked ancestor is refused; a symlinked leaf is displaced, never written through
//   - reportRefusal: one stderr line for a refusal, false (and silence) for any other error
//   - the derived root is only a default: an explicit root pins it, null opts out of the ancestor guard

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const {
  isRefusal, reportRefusal, stateContainRoot,
  safeAppend, safeOpenAppend, safeMkdirp, safeWriteAtomic, assertSafeLeaf, assertNoSymlinkedAncestor,
} = require('../../../.agents/core/_lib/fs-safe');
const { createTmpDir } = require('./_helpers/tmp-dir');

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
let project; // <tmp>/project with docs/.output/.state/telemetry inside
let state;
let victimDir;
let victimFile;

beforeEach(() => {
  tmp = createTmpDir({ prefix: 'fs-safe-state-' });
  project = path.join(tmp.root, 'project');
  state = path.join(project, 'docs', '.output', '.state');
  fs.mkdirSync(path.join(state, 'telemetry'), { recursive: true });
  victimDir = path.join(tmp.root, 'victim-dir');
  fs.mkdirSync(victimDir);
  victimFile = path.join(tmp.root, 'victim.txt');
  fs.writeFileSync(victimFile, 'VICTIM-CONTENT');
});

afterEach(() => tmp.cleanup());

const listing = dir => fs.readdirSync(dir).sort();

describe('stateContainRoot', () => {
  it('returns the directory above the first docs/.output segment', () => {
    expect(stateContainRoot(path.join(project, 'docs', '.output', '.state', 'memory-daily', 'd.md'))).toBe(project);
    expect(stateContainRoot(path.join(project, 'docs', '.output'))).toBe(project);
  });

  it('uses the FIRST segment, so a deeper docs/.output planted in the state folder cannot shorten the checked chain', () => {
    const deeper = path.join(project, 'docs', '.output', '.state', 'x', 'docs', '.output', '.state', 'f.md');
    expect(stateContainRoot(deeper)).toBe(project);
  });

  it('returns null for a path with no docs/.output segment', () => {
    expect(stateContainRoot(path.join(tmp.root, 'elsewhere', 'file.md'))).toBeNull();
    expect(stateContainRoot(path.join(tmp.root, 'docs', 'other', 'file.md'))).toBeNull();
  });
});

describe('reportRefusal and isRefusal', () => {
  it('writes ONE line to the stream and returns true for a refusal', () => {
    const chunks = [];
    const error = Object.assign(new Error('fs-safe: refusing to write through symlink /x\nsecond line'), { fsSafeRefusal: true });
    expect(isRefusal(error)).toBe(true);
    expect(reportRefusal(error, { write: s => chunks.push(s) })).toBe(true);
    expect(chunks).toEqual(['[fs-safe] state write skipped: fs-safe: refusing to write through symlink /x\n']);
  });

  it('returns false and writes nothing for any other error', () => {
    const chunks = [];
    expect(reportRefusal(new Error('ENOENT'), { write: s => chunks.push(s) })).toBe(false);
    expect(reportRefusal(null, { write: s => chunks.push(s) })).toBe(false);
    expect(isRefusal(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false);
    expect(chunks).toEqual([]);
  });

  it('does not throw when the stream itself fails', () => {
    const error = Object.assign(new Error('refused'), { fsSafeRefusal: true });
    expect(reportRefusal(error, { write() { throw new Error('stderr closed'); } })).toBe(true);
  });
});

describe('assertNoSymlinkedAncestor keeps its contract', () => {
  it.skipIf(!canSymlink)('a refusal carries NO error.code (fleet and ship-check print it, so their output must not change)', () => {
    fs.symlinkSync(victimDir, path.join(project, 'linked'), 'dir');
    let caught;
    try { assertNoSymlinkedAncestor(path.join(project, 'linked', 'f.txt'), project); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(caught.code).toBeUndefined();
  });

  it.skipIf(!canSymlink)('throws an error carrying the refusal code, with the established message', () => {
    fs.symlinkSync(victimDir, path.join(project, 'linked'), 'dir');
    let caught;
    try { assertNoSymlinkedAncestor(path.join(project, 'linked', 'f.txt'), project); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(caught.message).toMatch(/refusing to write through symlinked ancestor directory/);
  });

  it('throws a refusal when the destination is not contained in the root', () => {
    let caught;
    try { assertNoSymlinkedAncestor(path.join(tmp.root, 'outside.txt'), project); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(caught.message).toMatch(/not contained within/);
  });
});

describe('safeAppend', () => {
  it('appends to a real file and creates it when absent', () => {
    const file = path.join(state, 'telemetry', 'log.jsonl');
    safeAppend(file, 'one\n', 'utf8');
    safeAppend(file, 'two\n', 'utf8');
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it.skipIf(!canSymlink)('REFUSES a symlinked leaf and leaves the target untouched', () => {
    const link = path.join(state, 'telemetry', 'log.jsonl');
    fs.symlinkSync(victimFile, link);
    let caught;
    try { safeAppend(link, 'PAYLOAD\n', 'utf8'); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true); // refused, not replaced
  });

  it.skipIf(!canSymlink)('REFUSES a dangling symlinked leaf and never creates its target', () => {
    const target = path.join(tmp.root, 'not-yet.txt');
    const link = path.join(state, 'telemetry', 'dangling.jsonl');
    fs.symlinkSync(target, link);
    expect(() => safeAppend(link, 'PAYLOAD\n', 'utf8')).toThrow(/refusing to write through symlink/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.skipIf(!canSymlink)('REFUSES a symlinked ancestor between the file and the project root', () => {
    fs.rmSync(path.join(state, 'telemetry'), { recursive: true });
    fs.symlinkSync(victimDir, path.join(state, 'telemetry'), 'dir');
    const file = path.join(state, 'telemetry', 'log.jsonl');
    let caught;
    try { safeAppend(file, 'PAYLOAD\n', 'utf8'); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(listing(victimDir)).toEqual([]);
  });

  it.skipIf(!canSymlink)('REFUSES when the state folder itself is the symlink', () => {
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');
    expect(() => safeAppend(path.join(state, 'x.md'), 'PAYLOAD\n', 'utf8')).toThrow(/symlinked ancestor/);
    expect(listing(victimDir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('REFUSES a FIFO leaf (opening one for writing would block the hook)', () => {
    const fifo = path.join(state, 'telemetry', 'pipe.jsonl');
    const made = spawnSync('mkfifo', [fifo], { windowsHide: true });
    if (made.status !== 0) return; // no mkfifo on this machine: nothing to prove
    let caught;
    try { safeAppend(fifo, 'PAYLOAD\n', 'utf8'); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(caught.message).toMatch(/not a regular file/);
  });

  it('treats a directory leaf as an ordinary failure, not a refusal', () => {
    const dir = path.join(state, 'telemetry', 'as-dir');
    fs.mkdirSync(dir);
    let caught;
    try { safeAppend(dir, 'x', 'utf8'); } catch (error) { caught = error; }
    expect(caught).toBeDefined();
    expect(isRefusal(caught)).toBe(false);
  });

  it.skipIf(!canSymlink)('an explicit null opts out of the ancestor guard, the leaf guard still applies', () => {
    fs.rmSync(path.join(state, 'telemetry'), { recursive: true });
    fs.symlinkSync(victimDir, path.join(state, 'telemetry'), 'dir');
    safeAppend(path.join(state, 'telemetry', 'log.jsonl'), 'ok\n', 'utf8', null);
    expect(fs.readFileSync(path.join(victimDir, 'log.jsonl'), 'utf8')).toBe('ok\n');
    fs.symlinkSync(victimFile, path.join(victimDir, 'leaf.jsonl'));
    expect(() => safeAppend(path.join(state, 'telemetry', 'leaf.jsonl'), 'x', 'utf8', null)).toThrow(/symlink/);
  });

  it.skipIf(!canSymlink)('an explicit root pins the guard where the path has no docs/.output segment', () => {
    const root = path.join(tmp.root, 'plain');
    fs.mkdirSync(root);
    fs.symlinkSync(victimDir, path.join(root, 'logs'), 'dir');
    expect(() => safeAppend(path.join(root, 'logs', 'a.log'), 'x', 'utf8', root)).toThrow(/symlinked ancestor/);
    expect(listing(victimDir)).toEqual([]);
  });
});

describe('safeOpenAppend', () => {
  it('returns an fd the caller writes through and closes', () => {
    const file = path.join(state, 'telemetry', 'fd.log');
    const fd = safeOpenAppend(file);
    try { fs.writeSync(fd, 'via-fd\n'); } finally { fs.closeSync(fd); }
    expect(fs.readFileSync(file, 'utf8')).toBe('via-fd\n');
  });

  it.skipIf(!canSymlink)('refuses a symlinked leaf', () => {
    const link = path.join(state, 'telemetry', 'fd.log');
    fs.symlinkSync(victimFile, link);
    expect(() => safeOpenAppend(link)).toThrow(/refusing to write through symlink/);
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
  });
});

describe('assertSafeLeaf', () => {
  it('accepts a missing leaf and a regular file', () => {
    expect(() => assertSafeLeaf(path.join(state, 'missing'))).not.toThrow();
    fs.writeFileSync(path.join(state, 'regular'), 'x');
    expect(() => assertSafeLeaf(path.join(state, 'regular'))).not.toThrow();
  });

  it.skipIf(!canSymlink)('refuses a symlink', () => {
    fs.symlinkSync(victimFile, path.join(state, 'link'));
    expect(() => assertSafeLeaf(path.join(state, 'link'))).toThrow(/symlink/);
  });
});

describe('safeMkdirp', () => {
  it('creates nested directories under a real tree', () => {
    const dir = path.join(state, 'sessions', '2026-11-19');
    safeMkdirp(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it.skipIf(!canSymlink)('refuses a symlinked ancestor BEFORE creating anything inside its target', () => {
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');
    let caught;
    try { safeMkdirp(path.join(state, 'memory-daily')); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(listing(victimDir)).toEqual([]);
  });

  it.skipIf(!canSymlink)('refuses when the directory itself is an existing symlink', () => {
    fs.symlinkSync(victimDir, path.join(state, 'memory-daily'), 'dir');
    expect(() => safeMkdirp(path.join(state, 'memory-daily'))).toThrow(/symlinked ancestor/);
  });
});

describe('safeWriteAtomic', () => {
  it('writes through a temp file and leaves none behind', () => {
    const file = path.join(state, 'memory-notes', 'ledger.json');
    safeWriteAtomic(file, '{"a":1}');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(listing(path.dirname(file))).toEqual(['ledger.json']);
  });

  it.skipIf(!canSymlink)('refuses a symlinked ancestor and creates nothing in its target', () => {
    fs.rmSync(state, { recursive: true });
    fs.symlinkSync(victimDir, state, 'dir');
    let caught;
    try { safeWriteAtomic(path.join(state, 'memory-notes', 'ledger.json'), 'PAYLOAD'); } catch (error) { caught = error; }
    expect(isRefusal(caught)).toBe(true);
    expect(listing(victimDir)).toEqual([]);
  });

  it.skipIf(!canSymlink)('displaces a symlinked leaf instead of writing through it', () => {
    const link = path.join(state, 'telemetry', 'ledger.json');
    fs.symlinkSync(victimFile, link);
    safeWriteAtomic(link, 'PAYLOAD');
    expect(fs.readFileSync(victimFile, 'utf8')).toBe('VICTIM-CONTENT');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(link, 'utf8')).toBe('PAYLOAD');
  });

  it('removes the temp file and rethrows when the rename fails', () => {
    const target = path.join(state, 'telemetry', 'a-directory');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'occupied'), 'x'); // a non-empty directory cannot be replaced by a file
    expect(() => safeWriteAtomic(target, 'PAYLOAD')).toThrow();
    expect(listing(path.join(state, 'telemetry')).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
});
