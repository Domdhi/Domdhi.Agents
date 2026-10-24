// Tests for worktree.cjs — the Claude Code WorktreeCreate / WorktreeRemove hook.
//
// The real script runs against real temporary repositories (with spaces in their paths), so each
// case exercises the actual Git commands, links and file copies, not a model of them.
//
// Contract under test: worktrees land under <parent of repo>/.worktrees/<repo>/<branch> (or the
// absolute AGENTS_WORKTREE_ROOT override as <root>/<repo>/<branch>), standard output carries only the
// created path, any refusal exits non-zero without creating anything, `.worktreeinclude` copies only
// Git-ignored matching files, and removal never forces.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const HOOK = path.join(REPO_ROOT, '.agents/hooks/worktree.cjs');
const WRAPPER = path.join(REPO_ROOT, '.claude/hooks/worktree.cjs');
const SETTINGS_SOURCE = path.join(REPO_ROOT, '.agents/adapters/claude/settings.json');
const SETTINGS_PROJECTION = path.join(REPO_ROOT, '.claude/settings.json');

let base;
let parent;
let repo;
let emptyConfig;

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE2: '0', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function write(root, rel, content = 'x\n') {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeRepo(directory, branch = 'main') {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ['init', `--initial-branch=${branch}`]);
  git(directory, ['config', 'user.name', 'Fixture Maintainer']);
  git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  write(directory, 'a.txt', 'a\n');
  write(directory, '.gitignore', '.env\nsecrets/\nnode_modules/\nbuild-output.log\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-m', 'init']);
  return directory;
}

function run(event, { env = {}, script = HOOK } = {}) {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (/^GIT_/i.test(key) || key === 'AGENTS_WORKTREE_ROOT') delete inherited[key];
  }
  const result = spawnSync(process.execPath, [script], {
    input: typeof event === 'string' ? event : JSON.stringify(event), encoding: 'utf8',
    env: { ...inherited, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const create = (name, extra = {}, options) => run({ hook_event_name: 'WorktreeCreate', cwd: repo, name, ...extra }, options);
const remove = (worktreePath, extra = {}, options) => run({ hook_event_name: 'WorktreeRemove', cwd: repo, worktree_path: worktreePath, ...extra }, options);
const lastLine = out => out.trim().split(/\r?\n/).filter(Boolean).pop();
const expectedDest = name => path.join(parent, '.worktrees', path.basename(repo), `worktree-${name}`);

// Every directory and file entry under the root, without following links.
function entries(root) {
  const found = [];
  (function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const abs = path.join(directory, entry.name);
      found.push(path.relative(root, abs).replace(/\\/g, '/'));
      if (entry.isDirectory()) walk(abs);
    }
  })(root);
  return found.sort();
}

function link(target, at) {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt hook ')));
  emptyConfig = path.join(base, 'empty-gitconfig');
  fs.writeFileSync(emptyConfig, '');
  parent = path.join(base, 'code dir');
  repo = makeRepo(path.join(parent, 'my repo'));
});

afterEach(() => {
  // rmSync removes a junction entry itself and never follows it, so linked worktrees clean up safely.
  fs.rmSync(base, { recursive: true, force: true });
});

describe('WorktreeCreate', () => {
  it('worktreeCreate_derivesTheSiblingRoot_printsOnlyThePathAndCreatesTheBranch', () => {
    const result = create('feat-x');

    expect(result.code, result.err).toBe(0);
    expect(result.out.trim().split(/\r?\n/)).toEqual([expectedDest('feat-x')]);
    expect(fs.existsSync(path.join(expectedDest('feat-x'), 'a.txt'))).toBe(true);
    expect(git(repo, ['branch', '--list', 'worktree-feat-x'])).toContain('worktree-feat-x');
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(expectedDest('feat-x').replace(/\\/g, '/'));
    // Nothing is created inside the checkout.
    expect(fs.existsSync(path.join(repo, '.worktrees'))).toBe(false);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('worktreeCreate_runsThroughTheGeneratedWrapperAsRegisteredInSettings', () => {
    expect(fs.existsSync(WRAPPER)).toBe(true);

    const result = create('via-wrapper', {}, { script: WRAPPER });

    expect(result.code, result.err).toBe(0);
    expect(lastLine(result.out)).toBe(expectedDest('via-wrapper'));
  });

  it('worktreeCreate_fromInsideAWorktree_resolvesTheMainCheckout', () => {
    const first = create('one');
    expect(first.code, first.err).toBe(0);

    const second = run({ hook_event_name: 'WorktreeCreate', cwd: lastLine(first.out), name: 'two' });

    expect(second.code, second.err).toBe(0);
    expect(lastLine(second.out)).toBe(expectedDest('two'));
  });

  it('worktreeCreate_basesTheBranchOnTheRemoteDefaultWhenOneExistsWithoutFetching', () => {
    const remoteTip = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', remoteTip]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    write(repo, 'local-only.txt', 'local\n');
    git(repo, ['add', 'local-only.txt']);
    git(repo, ['commit', '-m', 'local commit past the remote']);

    const result = create('from-remote');

    expect(result.code, result.err).toBe(0);
    expect(git(lastLine(result.out), ['rev-parse', 'HEAD'])).toBe(remoteTip);
    expect(fs.existsSync(path.join(lastLine(result.out), 'local-only.txt'))).toBe(false);
  });

  it('worktreeCreate_withNoNamedBaseBranch_fallsBackToHead', () => {
    const trunk = makeRepo(path.join(parent, 'trunk repo'), 'trunk');
    const result = run({ hook_event_name: 'WorktreeCreate', cwd: trunk, name: 'on-trunk' });

    expect(result.code, result.err).toBe(0);
    expect(git(lastLine(result.out), ['rev-parse', 'HEAD'])).toBe(git(trunk, ['rev-parse', 'HEAD']));
  });

  it('worktreeCreate_overrideRoot_usesRootRepoBranch', () => {
    const root = path.join(base, 'custom roots');

    const result = create('ov', {}, { env: { AGENTS_WORKTREE_ROOT: root } });

    expect(result.code, result.err).toBe(0);
    expect(lastLine(result.out)).toBe(path.join(root, 'my repo', 'worktree-ov'));
    expect(fs.existsSync(path.join(parent, '.worktrees'))).toBe(false);
  });

  it.each([
    ['a relative override', () => 'relative/dir'],
    ['an override inside the main checkout', () => path.join(repo, 'wts')],
    ['an override that is the checkout itself', () => repo],
    ['an override that holds the checkout (the destination would be inside it)', () => parent],
    ['an override inside the checkout whose name merely starts with two dots', () => path.join(repo, '..wts')],
  ])('worktreeCreate_%s_refusesWithoutCreatingAnything', (_, override) => {
    const before = entries(base);

    const result = create('bad-root', {}, { env: { AGENTS_WORKTREE_ROOT: override() } });

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/worktree hook: refused/);
    expect(entries(base)).toEqual(before);
    expect(git(repo, ['branch', '--list', 'worktree-bad-root'])).toBe('');
  });

  it.each([
    ['a parent traversal', '../x'],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['an empty name', ''],
    ['a lock suffix', 'x.lock'],
    ['a leading dash', '-x'],
    ['a space', 'a b'],
    ['an embedded dot dot', 'a..b'],
    ['a trailing dot', 'x.'],
    ['an over-long name', 'n'.repeat(80)],
    ['a number', 7],
    ['a missing name', undefined],
  ])('worktreeCreate_invalidSlug_%s_refusesWithoutCreatingAnything', (_, name) => {
    const before = entries(base);

    const result = run({ hook_event_name: 'WorktreeCreate', cwd: repo, name });

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(entries(base)).toEqual(before);
  });

  it('worktreeCreate_existingDestination_refusesAndLeavesItUntouched', () => {
    const first = create('dup');
    expect(first.code, first.err).toBe(0);
    write(expectedDest('dup'), 'keep.txt', 'keep\n');

    const again = create('dup');

    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
    expect(fs.readFileSync(path.join(expectedDest('dup'), 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('worktreeCreate_aSymbolicLinkOrJunctionAsTheWorktreeRoot_refuses', () => {
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const linkedRoot = path.join(base, 'linked root');
    link(elsewhere, linkedRoot);

    const result = create('through-link', {}, { env: { AGENTS_WORKTREE_ROOT: linkedRoot } });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/symbolic link or junction/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('worktreeCreate_aSymbolicLinkOrJunctionAsTheRepoDirectory_refuses', () => {
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const root = path.join(base, 'roots');
    fs.mkdirSync(root);
    link(elsewhere, path.join(root, 'my repo'));

    const result = create('through-repo-link', {}, { env: { AGENTS_WORKTREE_ROOT: root } });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/symbolic link or junction/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('worktreeCreate_aLinkedDestination_refuses', () => {
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const root = path.join(base, 'roots');
    fs.mkdirSync(path.join(root, 'my repo'), { recursive: true });
    link(elsewhere, path.join(root, 'my repo', 'worktree-linked'));

    const result = create('linked', {}, { env: { AGENTS_WORKTREE_ROOT: root } });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/already exists/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('worktreeCreate_aJunctionAboveTheOverrideRootThatPointsIntoTheCheckout_refuses', () => {
    const alias = path.join(base, 'alias to repo');
    link(repo, alias);
    const before = entries(repo);

    const result = create('through-alias', {}, { env: { AGENTS_WORKTREE_ROOT: path.join(alias, 'wts') } });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/outside the main checkout/);
    expect(entries(repo)).toEqual(before);
  });

  it('worktreeCreate_aFailingPostCheckoutHook_rollsBackTheWorktreeBranchAndDirectories', () => {
    const hook = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\necho "lfs-like failure" >&2\nexit 1\n', { mode: 0o755 });
    const outside = () => entries(base).filter(entry => !entry.startsWith('code dir/my repo/.git/'));
    const before = outside();
    const worktrees = git(repo, ['worktree', 'list', '--porcelain']);
    const branches = git(repo, ['branch', '--list']);

    const result = create('hooked');

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/git worktree add failed/);
    expect(outside()).toEqual(before);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toBe(worktrees);
    expect(git(repo, ['branch', '--list'])).toBe(branches);
    // A retry is not stuck on a leftover name once the hook is healthy again.
    fs.rmSync(hook);
    expect(create('hooked').code).toBe(0);
  });

  it('worktreeCreate_aGitFailureBeforeAnyWorktreeExists_leavesNoEmptyRootDirectories', () => {
    git(repo, ['branch', 'worktree-dup']);
    const before = entries(base);

    const result = create('dup');

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/git worktree add failed/);
    expect(entries(base)).toEqual(before);
    expect(git(repo, ['branch', '--list', 'worktree-dup'])).toContain('worktree-dup');
  });

  // Four commits on one line of history: tips.a (oldest) < b < c < d. HEAD is detached at the newest (d), which is
  // never a branch tip below, so a fallback to HEAD would be visible. Each case names the refs that exist and
  // the commit the worktree must be based on.
  it.each([
    ['origin/HEAD wins over every named branch', { 'refs/remotes/origin/HEAD': 'd', 'refs/remotes/origin/main': 'c', 'refs/heads/main': 'b', 'refs/remotes/origin/master': 'a' }, 'd'],
    ['origin/main wins over local main and the master names', { 'refs/remotes/origin/main': 'c', 'refs/heads/main': 'b', 'refs/remotes/origin/master': 'a', 'refs/heads/master': 'a' }, 'c'],
    ['local main wins over the master names', { 'refs/heads/main': 'b', 'refs/remotes/origin/master': 'a', 'refs/heads/master': 'a' }, 'b'],
    ['origin/master wins over local master', { 'refs/remotes/origin/master': 'c', 'refs/heads/master': 'b' }, 'c'],
    ['local master is used when it is the only name', { 'refs/heads/master': 'b' }, 'b'],
    ['HEAD is the last resort', {}, 'd'],
  ])('worktreeCreate_baseRef_%s', (_, refs, expected) => {
    const tips = {};
    for (const label of ['a', 'b', 'c', 'd']) {
      write(repo, `tip-${label}.txt`, `${label}\n`);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', label]);
      tips[label] = git(repo, ['rev-parse', 'HEAD']);
    }
    git(repo, ['checkout', '--detach', tips.d]);
    git(repo, ['branch', '-D', 'main']);
    for (const [ref, label] of Object.entries(refs)) {
      if (ref === 'refs/remotes/origin/HEAD') {
        git(repo, ['update-ref', 'refs/remotes/origin/trunk', tips[label]]);
        git(repo, ['symbolic-ref', ref, 'refs/remotes/origin/trunk']);
      } else {
        git(repo, ['update-ref', ref, tips[label]]);
      }
    }

    const result = create('based');

    expect(result.code, result.err).toBe(0);
    expect(git(lastLine(result.out), ['rev-parse', 'HEAD'])).toBe(tips[expected]);
  });

  it.each([
    'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
    'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_SHALLOW_FILE', 'GIT_TRACE', 'GIT_TRACE2_EVENT', 'GIT_REDIRECT_STDERR',
  ])('worktreeCreate_inheritedGitVariable_%s_refuses', variable => {
    const before = entries(base);

    const result = create('inherited', {}, { env: { [variable]: path.join(base, 'somewhere') } });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/inherited Git redirection/);
    expect(entries(base)).toEqual(before);
  });

  it('worktreeCreate_inheritedGitRedirection_refuses', () => {
    const other = makeRepo(path.join(base, 'other repo'));

    const result = create('redirected', {}, { env: { GIT_DIR: path.join(other, '.git') } });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/inherited Git redirection/);
    expect(git(other, ['worktree', 'list'])).not.toMatch(/worktree-redirected/);
  });

  it.each([
    ['a missing working directory', { cwd: undefined }],
    ['a relative working directory', { cwd: 'my repo' }],
    ['a directory that is not a repository', { cwd: os.tmpdir() }],
  ])('worktreeCreate_%s_refuses', (_, override) => {
    const result = run({ hook_event_name: 'WorktreeCreate', cwd: repo, name: 'x', ...override });

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
  });

  it.each([
    ['a non-JSON event', '{not json'],
    ['a JSON null event', 'null'],
    ['a JSON array event', '[]'],
    ['an unsupported event', JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '' })],
  ])('worktreeHook_%s_exitsNonZeroWithNothingOnStandardOutput', (_, event) => {
    const result = run(event);

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    // A refusal, never an uncaught property access on the parsed value.
    expect(result.err).toMatch(/worktree hook: refused/);
  });
});

describe('.worktreeinclude', () => {
  it('copyIncludes_aDestinationDirectoryThatIsALink_isSkippedAndNothingIsWrittenThroughIt', () => {
    const { copyIncludes } = require('../../../.agents/hooks/worktree.cjs');
    write(repo, '.worktreeinclude', 'linked/**\n');
    write(repo, '.gitignore', '.env\nlinked/\n');
    write(repo, 'linked/secret.txt', 'secret\n');
    const dest = path.join(base, 'fake worktree');
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(dest);
    fs.mkdirSync(elsewhere);
    link(elsewhere, path.join(dest, 'linked'));

    const copied = copyIncludes(repo, dest);

    expect(copied).toEqual([]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('worktreeCreate_copiesOnlyIgnoredMatchingFiles_neverTrackedUntrackedOrThroughLinks', () => {
    write(repo, '.worktreeinclude', ['.env', 'secrets/**', 'a.txt', 'notes.txt', 'linked/**', ''].join('\n'));
    git(repo, ['add', '.worktreeinclude']);
    git(repo, ['commit', '-m', 'include list']);
    write(repo, '.env', 'TOKEN=1\n');
    write(repo, 'secrets/deep/key.json', '{}\n');
    write(repo, 'node_modules/big.js', '//\n');            // ignored, but not matched by the include list
    write(repo, 'notes.txt', 'untracked and not ignored\n'); // matched, but not Git-ignored
    const outside = path.join(base, 'outside');
    write(outside, 'stolen.txt', 'must not be copied\n');
    link(outside, path.join(repo, 'linked'));              // a junction inside the checkout

    const result = create('inc');

    expect(result.code, result.err).toBe(0);
    const dest = lastLine(result.out);
    expect(fs.readFileSync(path.join(dest, '.env'), 'utf8')).toBe('TOKEN=1\n');
    expect(fs.readFileSync(path.join(dest, 'secrets/deep/key.json'), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'notes.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'linked', 'stolen.txt'))).toBe(false);
    // The tracked file came from the commit, not from a copy of the working tree.
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('a\n');
    expect(result.err).toMatch(/copied 2 \.worktreeinclude file/);
  });

  it('worktreeCreate_aTrackedFileMatchedByTheIncludeListIsNotCopiedFromTheWorkingTree', () => {
    write(repo, '.worktreeinclude', 'a.txt\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'local uncommitted edit\n');

    const result = create('tracked');

    expect(result.code, result.err).toBe(0);
    expect(fs.readFileSync(path.join(lastLine(result.out), 'a.txt'), 'utf8')).toBe('a\n');
  });

  it('worktreeCreate_aMalformedIncludeEntry_isReportedAndNeverFailsTheCreation', () => {
    fs.mkdirSync(path.join(repo, '.worktreeinclude'));

    const result = create('bad-include');

    expect(result.code, result.err).toBe(0);
    expect(result.err).toMatch(/not a regular file/);
    expect(fs.existsSync(path.join(lastLine(result.out), 'a.txt'))).toBe(true);
  });
});

describe('WorktreeRemove', () => {
  it('worktreeRemove_aCleanMergedWorktree_isRemovedWithItsMergedBranch', () => {
    const created = create('gone');
    const dest = lastLine(created.out);
    write(dest, '.env', 'ignored build output\n');

    const result = remove(dest);

    expect(result.code, result.err).toBe(0);
    expect(fs.existsSync(dest)).toBe(false);
    expect(git(repo, ['branch', '--list', 'worktree-gone'])).toBe('');
    expect(git(repo, ['worktree', 'list'])).not.toMatch(/worktree-gone/);
  });

  it('worktreeRemove_anUnmergedBranch_isKeptAndReported', () => {
    const dest = lastLine(create('work').out);
    write(dest, 'n.txt', 'new work\n');
    git(dest, ['add', 'n.txt']);
    git(dest, ['commit', '-m', 'unmerged work']);

    const result = remove(dest);

    expect(result.code, result.err).toBe(0);
    expect(fs.existsSync(dest)).toBe(false);
    expect(git(repo, ['branch', '--list', 'worktree-work'])).toContain('worktree-work');
    expect(result.err).toMatch(/kept branch worktree-work/);
  });

  it('worktreeRemove_uncommittedWork_isNeverForcedAway', () => {
    const dest = lastLine(create('dirty').out);
    write(dest, 'wip.txt', 'work in progress\n');

    const result = remove(dest);

    expect(result.code).toBe(1);
    expect(fs.readFileSync(path.join(dest, 'wip.txt'), 'utf8')).toBe('work in progress\n');
    expect(git(repo, ['worktree', 'list'])).toMatch(/worktree-dirty/);
    expect(git(repo, ['branch', '--list', 'worktree-dirty'])).toContain('worktree-dirty');
  });

  it('worktreeRemove_theMainCheckout_isRefused', () => {
    const result = remove(repo);

    expect(result.code).toBe(1);
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
  });

  it('worktreeRemove_aWorktreeOutsideTheResolvedRoot_isRefusedAndLeftInPlace', () => {
    const foreign = path.join(base, 'foreign worktree');
    git(repo, ['worktree', 'add', '-b', 'worktree-foreign', foreign]);

    const result = remove(foreign);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not under the worktree root/);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('worktreeRemove_aDirectoryThatIsNotAWorktree_isRefusedAndLeftInPlace', () => {
    const plain = path.join(parent, '.worktrees', 'my repo', 'worktree-plain');
    write(plain, 'file.txt', 'not a worktree\n');

    const result = remove(plain);

    expect(result.code).toBe(1);
    expect(fs.existsSync(path.join(plain, 'file.txt'))).toBe(true);
  });

  it('worktreeRemove_anAlreadyMissingUnregisteredPath_exitsZeroNothingToRemove', () => {
    const gone = path.join(parent, '.worktrees', 'my repo', 'worktree-never');

    const result = remove(gone);

    expect(result.code, result.err).toBe(0);
    expect(result.err).toMatch(/nothing to remove/);
  });

  it('worktreeRemove_aMissingPathOutsideTheResolvedRoot_isRefused', () => {
    const result = remove(path.join(base, 'never-here', 'worktree-x'));

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/not under the worktree root/);
  });

  it('worktreeRemove_aMissingButStillRegisteredWorktree_failsInsteadOfClaimingRemoval', () => {
    const dest = lastLine(create('vanished').out);
    fs.rmSync(dest, { recursive: true, force: true });

    const result = remove(dest);

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/still registered/);
  });

  it.each([
    ['a relative path', { worktree_path: 'relative/worktree' }],
    ['no path', { worktree_path: undefined }],
  ])('worktreeRemove_%s_refuses', (_, override) => {
    const result = run({ hook_event_name: 'WorktreeRemove', cwd: repo, ...override });

    expect(result.code).toBe(1);
  });
});

describe('registration', () => {
  const registered = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).hooks;

  it.each([['the authored template', SETTINGS_SOURCE], ['the rendered projection', SETTINGS_PROJECTION]])('worktreeHook_isRegisteredForBothEventsIn_%s', (_, file) => {
    const hooks = registered(file);
    for (const event of ['WorktreeCreate', 'WorktreeRemove']) {
      expect(hooks[event], event).toEqual([{
        matcher: '',
        hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/worktree.cjs"' }],
      }]);
    }
  });

  it('worktreeHook_isDeliveredToAnExistingProjectByTheSettingsMerger', () => {
    const { mergeSettingsFile } = require('../../../.agents/core/_lib/settings-merger');
    const adopter = path.join(base, 'adopter-settings.json');
    fs.writeFileSync(adopter, JSON.stringify({ hooks: { PreToolUse: [] }, permissions: { allow: ['Bash(ls:*)'], deny: [] } }));

    const result = mergeSettingsFile(SETTINGS_SOURCE, adopter, {});

    expect(result.action).not.toBe('skipped');
    const merged = JSON.parse(fs.readFileSync(adopter, 'utf8'));
    for (const event of ['WorktreeCreate', 'WorktreeRemove']) {
      expect(merged.hooks[event], event).toEqual(registered(SETTINGS_SOURCE)[event]);
    }
    // The adopter's own permission choices are not replaced by the merge.
    expect(merged.permissions.allow).toContain('Bash(ls:*)');
  });
});
