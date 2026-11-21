// _lib/git.js: the reader for the Ship-Check commit trailer (readShipTrailers, shipCheckValue). Real git, temp repositories.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('../../__tests__/_helpers/git-fixture');
const trailer = require('../git');

const sh = it.skipIf(!gitAvailable());
const HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2';

let tmp;
let root;
beforeEach(() => {
  tmp = createTmpDir({ prefix: 'ship-trailer-' });
  if (gitAvailable()) root = fs.realpathSync(createGitRepo({ root: tmp.root }).repoPath);
});
afterEach(() => tmp.cleanup());

let n = 0;
function commitWith(message) {
  n += 1;
  fs.writeFileSync(path.join(root, `f${n}.txt`), `${n}\n`);
  execFileSync('git', ['add', '-A'], { cwd: root });
  const file = path.join(tmp.root, `msg${n}`);
  fs.writeFileSync(file, message);
  execFileSync('git', ['commit', '-q', '--no-verify', '-F', file], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

describe('shipCheckValue', () => {
  it('is the first 12 characters of the code hash', () => {
    expect(trailer.shipCheckValue(HASH)).toBe('a1b2c3d4e5f6');
    expect(trailer.SHIP_CHECK_VALUE_LENGTH).toBe(12);
  });
});

describe('readShipTrailers', () => {
  sh('reads a Ship-Check trailer from a named sha (full or abbreviated), and HEAD (null) when HEAD has none', () => {
    const first = commitWith('feat: one\n\nShip-Check: a1b2c3d4e5f6\n');
    commitWith('feat: two\n');
    expect(trailer.readShipTrailers(root, first)).toEqual({ state: 'ok', shipCheck: 'a1b2c3d4e5f6', skip: false });
    expect(trailer.readShipTrailers(root, first.slice(0, 7))).toEqual({ state: 'ok', shipCheck: 'a1b2c3d4e5f6', skip: false });
    expect(trailer.readShipTrailers(root, null)).toEqual({ state: 'ok', shipCheck: null, skip: false });
  });

  sh('reports the audited skip trailer, and a skip is not a ship check', () => {
    commitWith('feat: skipped\n\nShip-Check-Skip: CI-only matrix job\n');
    expect(trailer.readShipTrailers(root, null)).toEqual({ state: 'ok', shipCheck: null, skip: true });
  });

  sh('a Ship-Check line in the body (not the trailer block) is not a trailer', () => {
    commitWith('feat: prose\n\nShip-Check: a1b2c3d4e5f6\n\nand then some more prose follows.\n');
    expect(trailer.readShipTrailers(root, null).shipCheck).toBeNull();
  });

  sh.each([
    ['too short', 'Ship-Check: a1b2c3d4e5f'],
    ['too long', 'Ship-Check: a1b2c3d4e5f67'],
    ['upper case', 'Ship-Check: A1B2C3D4E5F6'],
    ['not hex', 'Ship-Check: zzzzzzzzzzzz'],
    ['empty', 'Ship-Check: '],
  ])('a malformed value (%s) does not count', (_label, line) => {
    commitWith(`feat: bad\n\n${line}\n`);
    expect(trailer.readShipTrailers(root, null).shipCheck).toBeNull();
  });

  sh('a commit that does not exist, or a non-sha argument, is an error with a reason (never a pass)', () => {
    commitWith('feat: one\n');
    const missing = trailer.readShipTrailers(root, 'deadbeefdeadbeef');
    expect(missing.state).toBe('error');
    expect(missing.reason).toMatch(/cannot read commit deadbeefdeadbeef/);
    for (const bad of ['--all', 'HEAD~1', 'main', 'abc']) {
      expect(trailer.readShipTrailers(root, bad), bad).toMatchObject({ state: 'error' });
    }
  });

  it('a directory that is not a repository is an error, not a throw', () => {
    // tmp.root holds the fixture repository itself, so the plain directory lives beside it, not inside it.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-trailer-plain-'));
    try {
      expect(trailer.readShipTrailers(plain, null)).toMatchObject({ state: 'error' });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
