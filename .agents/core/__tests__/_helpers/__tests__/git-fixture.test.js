import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Up two directory levels: __tests__/_helpers/__tests__ -> __tests__/_helpers
const { createGitRepo, gitAvailable, copyGitRepo } = require('../git-fixture');
const { createTmpDir } = require('../tmp-dir');
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

describe('git-fixture', () => {
  let tmp;

  beforeEach(() => {
    tmp = createTmpDir();
    tmp.root = fs.realpathSync(tmp.root);
  });

  afterEach(() => {
    tmp?.cleanup();
  });

  // ---------------------------------------------------------------------------
  // gitAvailable smoke check (runs unconditionally — useful CI diagnostic)
  // ---------------------------------------------------------------------------

  it('gitAvailable_normalShell_returnsBoolean', () => {
    // Arrange / Act
    const result = gitAvailable();

    // Assert — just confirm the return type; the actual value depends on the env
    expect(typeof result).toBe('boolean');
  });

  it('gitAvailable_normalShell_returnsTrue', () => {
    // Arrange (git is expected to be available in this dev environment)
    // Act
    const result = gitAvailable();

    // Assert
    // If this test fails it means git is not on PATH — all skipIf tests will also skip
    expect(result).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // createGitRepo error handling (no git required)
  // ---------------------------------------------------------------------------

  it('createGitRepo_noRoot_throws', () => {
    // Arrange / Act / Assert
    expect(() => createGitRepo({})).toThrow('[git-fixture] createGitRepo requires { root }');
  });

  it('createGitRepo_noArgs_throws', () => {
    // Arrange / Act / Assert
    expect(() => createGitRepo()).toThrow('[git-fixture] createGitRepo requires { root }');
  });

  function snapshot(root) {
    const entries = [];
    const walk = directory => {
      for (const name of fs.readdirSync(directory).sort()) {
        const target = path.join(directory, name);
        if (fs.lstatSync(target).isDirectory()) walk(target);
        else entries.push([path.relative(root, target), fs.readFileSync(target).toString('base64')]);
      }
    };
    walk(root);
    return entries;
  }

  function emptySeed() {
    const seed = path.join(tmp.root, 'seed');
    fs.mkdirSync(seed);
    tmp.mkdir('seed/.git/objects/info');
    return seed;
  }

  it('copyGitRepo_missingInputs_refusesWithoutWriting', () => {
    expect(copyGitRepo).toBeTypeOf('function');
    for (const input of [undefined, {}, { source: tmp.root }, { source: '', root: tmp.root }, { source: 1, root: tmp.root }]) {
      expect(() => copyGitRepo(input)).toThrow('copyGitRepo requires');
    }
    expect(fs.readdirSync(tmp.root)).toEqual([]);
  });

  it('copyGitRepo_independentCopies_preserveSeedBytesAndRealGitState', () => {
    expect(copyGitRepo).toBeTypeOf('function');
    const seed = path.join(tmp.root, 'seed');
    createGitRepo({ root: seed, commits: [{ message: 'seed content', files: [{ path: 'seed.txt', content: 'seed bytes' }] }] });
    const before = snapshot(seed);
    const first = path.join(tmp.root, 'first');
    const second = path.join(tmp.root, 'second');
    fs.mkdirSync(second);
    expect(copyGitRepo({ source: seed, root: first })).toEqual({ repoPath: first });
    copyGitRepo({ source: seed, root: second });
    expect(snapshot(first)).toEqual(before);
    expect(snapshot(second)).toEqual(before);
    for (const [relative] of before) {
      const original = fs.statSync(path.join(seed, relative));
      const copied = fs.statSync(path.join(first, relative));
      if (original.ino && copied.ino) expect([original.dev, original.ino]).not.toEqual([copied.dev, copied.ino]);
    }
    const git = (...args) => execFileSync('git', args, { cwd: first, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('config', 'fixture.changed', 'yes');
    fs.writeFileSync(path.join(first, 'unique.txt'), 'first-only fixture change\n');
    git('add', '--', 'unique.txt');
    expect(fs.readFileSync(path.join(first, '.git/index'))).not.toEqual(fs.readFileSync(path.join(second, '.git/index')));
    git('commit', '-qm', 'isolated-change');
    git('switch', '-c', 'changed');
    expect(git('rev-list', '--count', 'HEAD')).toBe('3');
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: second, encoding: 'utf8' }).trim()).toBe('main');
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: second, encoding: 'utf8' }).trim()).toBe('2');
    expect(snapshot(second)).toEqual(before);
    expect(snapshot(seed)).toEqual(before);
  });

  it.each(['directory', 'file'])('copyGitRepo_occupiedDestination_%s_refusesWithoutOverwriting', kind => {
    expect(copyGitRepo).toBeTypeOf('function');
    const source = emptySeed();
    const destination = kind === 'directory' ? tmp.mkdir('occupied') : tmp.write('occupied', 'preserved');
    if (kind === 'directory') tmp.write('occupied/keep.txt', 'preserved');
    const before = snapshot(tmp.root);
    expect(() => copyGitRepo({ source, root: destination })).toThrow();
    expect(snapshot(tmp.root)).toEqual(before);
  });

  it.each(['', 'child', '.git/copied'])('copyGitRepo_selfOrDescendant_%s_refusesWithoutWriting', suffix => {
    expect(copyGitRepo).toBeTypeOf('function');
    const source = emptySeed();
    const before = snapshot(source);
    expect(() => copyGitRepo({ source, root: path.join(source, suffix) })).toThrow();
    expect(snapshot(source)).toEqual(before);
  });

  it.each(['commondir', 'gitdir', 'worktrees', 'objects/info/alternates', 'objects/info/http-alternates'])('copyGitRepo_sharedMetadata_%s_refusesBeforeCreatingDestination', entry => {
    expect(copyGitRepo).toBeTypeOf('function');
    const source = emptySeed();
    if (entry === 'worktrees') tmp.mkdir('seed/.git/worktrees');
    else tmp.write(`seed/.git/${entry}`, 'external metadata');
    const destination = path.join(tmp.root, 'copy');
    expect(() => copyGitRepo({ source, root: destination })).toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('copyGitRepo_linkedWorktreeSource_refusesSharedGitMetadata', () => {
    expect(copyGitRepo).toBeTypeOf('function');
    const source = path.join(tmp.root, 'seed');
    createGitRepo({ root: source });
    const linked = path.join(tmp.root, 'linked');
    execFileSync('git', ['worktree', 'add', '-b', 'linked', linked], { cwd: source, stdio: 'pipe' });
    const destination = path.join(tmp.root, 'copy');
    expect(() => copyGitRepo({ source: linked, root: destination })).toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it.each(['source', 'metadata', 'content', 'destination', 'sourceAncestor', 'destinationAncestor', 'danglingDestination'])('copyGitRepo_symbolicLink_%s_refusesWithoutCopying', kind => {
    expect(copyGitRepo).toBeTypeOf('function');
    const source = emptySeed();
    const outside = tmp.mkdir('outside');
    let selectedSource = source;
    let destination = path.join(tmp.root, 'copy');
    const link = path.join(tmp.root, kind === 'content' ? 'seed/linked-content' : 'linked');
    try {
      if (kind === 'metadata') {
        fs.renameSync(path.join(source, '.git'), path.join(outside, 'metadata'));
        fs.symlinkSync(path.join(outside, 'metadata'), path.join(source, '.git'), 'junction');
      } else if (kind === 'sourceAncestor') {
        fs.symlinkSync(tmp.root, link, 'junction'); selectedSource = path.join(link, 'seed');
      } else if (kind === 'destinationAncestor') {
        fs.symlinkSync(outside, link, 'junction'); destination = path.join(link, 'copy');
      } else if (kind === 'danglingDestination') {
        fs.symlinkSync(path.join(outside, 'missing'), link, 'junction'); destination = link;
      } else {
        fs.symlinkSync(kind === 'source' ? source : outside, link, 'junction');
        if (kind === 'source') selectedSource = link;
        if (kind === 'destination') destination = link;
      }
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }
    expect(() => copyGitRepo({ source: selectedSource, root: destination })).toThrow();
    expect(fs.readdirSync(outside)).toEqual(kind === 'metadata' ? ['metadata'] : []);
    expect(fs.existsSync(path.join(tmp.root, 'copy'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('copyGitRepo_specialFile_refusesBeforeCopying', () => {
    expect(copyGitRepo).toBeTypeOf('function');
    const source = emptySeed();
    execFileSync('mkfifo', [path.join(source, 'fifo')]);
    const destination = path.join(tmp.root, 'copy');
    expect(() => copyGitRepo({ source, root: destination })).toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Core creation (requires git)
  // ---------------------------------------------------------------------------

  it.skipIf(!gitAvailable())('createGitRepo_valid_returnsHandleWithRepoPath', () => {
    // Arrange
    const repoRoot = path.join(tmp.root, 'repo-a');

    // Act
    const repo = createGitRepo({ root: repoRoot });

    // Assert
    expect(repo).not.toBeNull();
    expect(repo.repoPath).toBe(repoRoot);
  });

  it.skipIf(!gitAvailable())('createGitRepo_initialState_hasOneCommitOnMain', () => {
    // Arrange
    const repoRoot = path.join(tmp.root, 'repo-b');

    // Act
    const repo = createGitRepo({ root: repoRoot });
    const log = execSync('git log --oneline', { cwd: repo.repoPath })
      .toString()
      .trim();
    const branch = execSync('git branch --show-current', { cwd: repo.repoPath })
      .toString()
      .trim();

    // Assert — exactly one line ("initial" commit), on `main`
    expect(log.split('\n')).toHaveLength(1);
    expect(log).toContain('initial');
    expect(branch).toBe('main');
  });

  // ---------------------------------------------------------------------------
  // addCommit (requires git)
  // ---------------------------------------------------------------------------

  it.skipIf(!gitAvailable())('addCommit_withFiles_appearsInGitLog', () => {
    // Arrange
    const repoRoot = path.join(tmp.root, 'repo-c');
    const repo = createGitRepo({ root: repoRoot });

    // Act
    repo.addCommit({
      message: 'add-hello',
      files: [{ path: 'hello.txt', content: 'world' }],
    });
    const log = execSync('git log --oneline', { cwd: repo.repoPath })
      .toString()
      .trim();

    // Assert
    expect(log).toContain('add-hello');
  });

  it.skipIf(!gitAvailable())('addCommit_multipleCommits_allAppearInLog', () => {
    // Arrange
    const repoRoot = path.join(tmp.root, 'repo-d');
    const repo = createGitRepo({ root: repoRoot });

    // Act
    repo.addCommit({ message: 'commit-one' });
    repo.addCommit({ message: 'commit-two' });
    repo.addCommit({ message: 'commit-three' });
    const log = execSync('git log --oneline', { cwd: repo.repoPath })
      .toString()
      .trim()
      .split('\n');

    // Assert — 3 new commits + 1 "initial" = 4 lines
    expect(log).toHaveLength(4);
    const messages = log.map((l) => l.replace(/^[0-9a-f]+ /, ''));
    expect(messages).toContain('commit-one');
    expect(messages).toContain('commit-two');
    expect(messages).toContain('commit-three');
  });

  // ---------------------------------------------------------------------------
  // addCommitOnDate (requires git)
  // ---------------------------------------------------------------------------

  it.skipIf(!gitAvailable())('addEmptyCommitsOnDates_preservesEveryDateMessageAndParentTree', () => {
    const repo = createGitRepo({ root: path.join(tmp.root, 'dated-batch') });
    repo.addCommit({ message: 'base', files: [{ path: 'keep.txt', content: 'preserved\n' }] });
    const commits = Array.from({ length: 40 }, (_, i) => ({
      message: `dated ${i} — "quoted"\nsecond line`,
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString(),
    }));
    expect(repo.addEmptyCommitsOnDates).toBeTypeOf('function');
    repo.addEmptyCommitsOnDates(commits);
    const run = command => execSync(command, { cwd: repo.repoPath, encoding: 'utf8' }).trim();
    expect(run('git rev-list --count HEAD')).toBe('42');
    const actual = run('git log -40 --reverse --format=%at%x09%ct').split('\n');
    expect(actual).toEqual(commits.map(c => `${Date.parse(c.date) / 1000}\t${Date.parse(c.date) / 1000}`));
    const messages = run('git log -40 --reverse --format=%B%x00').split('\0').slice(0, -1).map(s => s.trim());
    expect(messages).toEqual(commits.map(c => c.message));
    expect(run('git rev-list -40 HEAD | git diff-tree --stdin --no-commit-id --name-only -r')).toBe('');
    expect(run('git status --porcelain')).toBe('');
    expect(fs.readFileSync(path.join(repo.repoPath, 'keep.txt'), 'utf8')).toBe('preserved\n');
  });

  it.skipIf(!gitAvailable())('addEmptyCommitsOnDates_invalidBatch_preservesHistory', () => {
    const repo = createGitRepo({ root: path.join(tmp.root, 'invalid-batch') });
    expect(repo.addEmptyCommitsOnDates).toBeTypeOf('function');
    const before = execSync('git rev-parse HEAD', { cwd: repo.repoPath, encoding: 'utf8' });
    expect(() => repo.addEmptyCommitsOnDates([{ message: 'valid', date: '2020-01-01T00:00:00Z' }, { message: 'invalid', date: 'bad-date' }])).toThrow(/date/i);
    expect(execSync('git rev-parse HEAD', { cwd: repo.repoPath, encoding: 'utf8' })).toBe(before);
  });

  it.skipIf(!gitAvailable())('addCommitOnDate_specificDate_setsAuthorDate', () => {
    // Arrange
    const repoRoot = path.join(tmp.root, 'repo-e');
    const repo = createGitRepo({ root: repoRoot });
    const isoDate = '2024-06-15T12:00:00';
    const expectedShort = '2024-06-15';

    // Act
    repo.addCommitOnDate('dated-commit', isoDate);
    const authorDate = execSync(
      'git log -n 1 --format=%ad --date=short',
      { cwd: repo.repoPath }
    )
      .toString()
      .trim();

    // Assert
    expect(authorDate).toBe(expectedShort);
  });

  it.skipIf(!gitAvailable())('addCommitOnDate_differentDates_eachCommitHasCorrectDate', () => {
    // Arrange
    const repoRoot = path.join(tmp.root, 'repo-f');
    const repo = createGitRepo({ root: repoRoot });

    // Act
    repo.addCommitOnDate('day-one', '2024-01-10T09:00:00');
    repo.addCommitOnDate('day-two', '2024-03-20T14:30:00');

    // git log is newest-first; first entry is day-two, second is day-one
    const dates = execSync(
      'git log --format=%ad --date=short',
      { cwd: repo.repoPath }
    )
      .toString()
      .trim()
      .split('\n');

    // Assert — dates[0] = day-two, dates[1] = day-one, dates[2] = initial
    expect(dates[0]).toBe('2024-03-20');
    expect(dates[1]).toBe('2024-01-10');
  });

  // ---------------------------------------------------------------------------
  // Initial commits seed via factory (requires git)
  // ---------------------------------------------------------------------------

  it.skipIf(!gitAvailable())('createGitRepo_withInitialCommits_seedsRepo', () => {
    // Arrange / Act
    const repoRoot = path.join(tmp.root, 'repo-g');
    const repo = createGitRepo({
      root: repoRoot,
      commits: [
        { message: 'seed-1', files: [{ path: 'seed.txt', content: 'seeded' }] },
        { message: 'seed-2' },
      ],
    });
    const log = execSync('git log --oneline', { cwd: repo.repoPath })
      .toString()
      .trim();

    // Assert
    expect(log).toContain('seed-1');
    expect(log).toContain('seed-2');
    // initial commit also present
    expect(log.split('\n')).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // Cleanup via tmp.cleanup() (no git required — just needs a dir on disk)
  // ---------------------------------------------------------------------------

  it('cleanup_viaTmpDir_removesRepoFromDisk', () => {
    // Arrange — create repo only if git is available, else create plain dir
    const repoRoot = path.join(tmp.root, 'repo-h');
    if (gitAvailable()) {
      createGitRepo({ root: repoRoot });
    } else {
      fs.mkdirSync(repoRoot, { recursive: true });
    }
    expect(fs.existsSync(repoRoot)).toBe(true);

    // Act — tmp.cleanup() removes the entire tmp tree (including repoRoot)
    tmp.cleanup();
    // Null out so afterEach doesn't try to call cleanup() again
    tmp = null;

    // Assert
    expect(fs.existsSync(repoRoot)).toBe(false);
  });
});
