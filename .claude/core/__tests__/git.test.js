// AC→source: _lib/git.js — the ONE git-exec wrapper for every core/ CLI (F27,
// council-260715-2244). Covers the trim/raw semantics (the porcelain fix that
// only branch-audit.js's copy used to carry), the safe/ok variants, and a
// source-scan guard that none of the three former hosts re-declares a local
// wrapper (the exact divergence F27 exists to prevent).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { git, gitSafe, gitOk } = require('../_lib/git');
const { createGitRepo, gitAvailable } = require('./_helpers/git-fixture');
const { createTmpDir } = require('./_helpers/tmp-dir');

describe.skipIf(!gitAvailable())('git() argv-array wrapper', () => {
  it('returns trimmed output by default', () => {
    const out = git(['--version']);
    expect(out).toMatch(/^git version /);
    expect(out).toBe(out.trim());
  });

  it('raw mode preserves leading whitespace (porcelain XY status lines)', () => {
    const tmp = createTmpDir({ prefix: 'lib-git-raw-' });
    try {
      const repo = createGitRepo({
        root: path.join(tmp.root, 'repo'),
        commits: [{ message: 'seed', files: [{ path: 'a.txt', content: 'one\n' }] }],
      });
      fs.writeFileSync(path.join(repo.repoPath, 'a.txt'), 'two\n');

      const raw = git(['status', '--porcelain'], { cwd: repo.repoPath, raw: true });
      // ' M a.txt' — the leading space is the X column; a blanket trim would
      // eat it and shift the path. Trailing newlines still drop.
      expect(raw).toBe(' M a.txt');

      const trimmed = git(['status', '--porcelain'], { cwd: repo.repoPath });
      expect(trimmed).toBe('M a.txt');
    } finally {
      tmp.cleanup();
    }
  });

  it('honors cwd', () => {
    const tmp = createTmpDir({ prefix: 'lib-git-cwd-' });
    try {
      const repo = createGitRepo({
        root: path.join(tmp.root, 'repo'),
        commits: [{ message: 'seed', files: [{ path: 'b.txt', content: 'x\n' }] }],
      });
      const top = git(['rev-parse', '--show-toplevel'], { cwd: repo.repoPath });
      // .native expands Windows 8.3 short-name aliases (a dotted-username profile
      // sets %TEMP% to DBACA~1-style paths) — plain realpathSync keeps the alias
      // while git emits the long name, failing exact equality on such machines.
      expect(fs.realpathSync.native(top)).toBe(fs.realpathSync.native(repo.repoPath));
    } finally {
      tmp.cleanup();
    }
  });

  it('throws on a failing command (no shell, argv only)', () => {
    expect(() => git(['definitely-not-a-git-subcommand-xyz'])).toThrow();
  });

  it('gitSafe swallows failure to empty string', () => {
    expect(gitSafe(['definitely-not-a-git-subcommand-xyz'])).toBe('');
    expect(gitSafe(['--version'])).toMatch(/^git version /);
  });

  it('gitOk is a boolean probe', () => {
    expect(gitOk(['--version'])).toBe(true);
    expect(gitOk(['definitely-not-a-git-subcommand-xyz'])).toBe(false);
  });
});

describe('F27 dedup guard — no CLI re-declares its own git wrapper', () => {
  const coreDir = path.resolve(__dirname, '..');
  const formerHosts = ['commit.js', 'pull-request.js', 'branch-audit.js'];

  it.each(formerHosts)('%s imports _lib/git instead of declaring function git(', (file) => {
    const src = fs.readFileSync(path.join(coreDir, file), 'utf8');
    expect(src).not.toMatch(/function git\s*\(/);
    expect(src).toMatch(/require\(['"]\.\/_lib\/git['"]\)/);
  });

  it('branch-audit re-exports the shared trio for its existing consumers', () => {
    const ba = require('../branch-audit');
    expect(ba.git).toBe(git);
    expect(ba.gitSafe).toBe(gitSafe);
    expect(ba.gitOk).toBe(gitOk);
  });
});
