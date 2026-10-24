// In-process tests for worktree.cjs.
//
// worktree.test.js runs the hook as a child process (the real contract: standard input, standard
// output, exit code). The v8 coverage provider does not measure code that only a child process runs,
// so the same rules are exercised here through the module's exports, against real temporary
// repositories, to keep the hook's measured coverage honest. Each case asserts behavior, not lines.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const hook = require('../../../.agents/hooks/worktree.cjs');
const { Refusal } = hook;

let base;
let parent;
let repo;
let emptyConfig;
const savedEnv = {};
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'AGENTS_WORKTREE_ROOT'];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root, rel, content = 'x\n') {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeRepo(directory) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ['init', '--initial-branch=main']);
  git(directory, ['config', 'user.name', 'Fixture Maintainer']);
  git(directory, ['config', 'user.email', 'fixture@example.invalid']);
  write(directory, 'a.txt', 'a\n');
  write(directory, '.gitignore', '.env\nsecrets/\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-m', 'init']);
  return directory;
}

const expectedDest = name => path.join(parent, '.worktrees', path.basename(repo), `worktree-${name}`);

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wt inproc ')));
  emptyConfig = path.join(base, 'empty-gitconfig');
  fs.writeFileSync(emptyConfig, '');
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TERMINAL_PROMPT = '0';
  delete process.env.AGENTS_WORKTREE_ROOT;
  parent = path.join(base, 'code dir');
  repo = makeRepo(path.join(parent, 'my repo'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe('create', () => {
  it('worktreeInProcess_create_placesTheWorktreeUnderTheSiblingRootAndCreatesTheBranch', () => {
    const dest = hook.create({ cwd: repo, name: 'one' }, {});

    expect(dest).toBe(expectedDest('one'));
    expect(fs.existsSync(path.join(dest, 'a.txt'))).toBe(true);
    expect(git(repo, ['branch', '--list', 'worktree-one'])).toContain('worktree-one');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('worktreeInProcess_create_overrideRootIsRootRepoBranch', () => {
    const root = path.join(base, 'override roots');

    const dest = hook.create({ cwd: repo, name: 'ov' }, { AGENTS_WORKTREE_ROOT: root });

    expect(dest).toBe(path.join(root, 'my repo', 'worktree-ov'));
  });

  it('worktreeInProcess_create_fromInsideAWorktreeResolvesTheMainCheckout', () => {
    const first = hook.create({ cwd: repo, name: 'first' }, {});

    const second = hook.create({ cwd: first, name: 'second' }, {});

    expect(second).toBe(expectedDest('second'));
  });

  it.each([
    ['a traversal', { name: '../x' }],
    ['a space', { name: 'a b' }],
    ['a lock suffix', { name: 'x.lock' }],
    ['a number', { name: 7 }],
    ['no name', {}],
  ])('worktreeInProcess_create_invalidName_%s_isRefused', (_, extra) => {
    expect(() => hook.create({ cwd: repo, ...extra }, {})).toThrow(Refusal);
    expect(fs.existsSync(path.join(parent, '.worktrees'))).toBe(false);
  });

  it.each([
    ['no working directory', { cwd: undefined }],
    ['a relative working directory', { cwd: 'my repo' }],
    ['a directory outside any repository', { cwd: os.tmpdir() }],
  ])('worktreeInProcess_create_%s_isRefused', (_, extra) => {
    expect(() => hook.create({ cwd: repo, name: 'x', ...extra }, {})).toThrow(Refusal);
  });

  it('worktreeInProcess_create_anExistingDestinationIsRefusedAndUntouched', () => {
    const dest = hook.create({ cwd: repo, name: 'dup' }, {});
    write(dest, 'keep.txt', 'keep\n');

    expect(() => hook.create({ cwd: repo, name: 'dup' }, {})).toThrow(/already exists/);
    expect(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it.each([
    ['a relative override', () => 'relative/dir', /absolute directory/],
    ['an override inside the checkout', () => path.join(repo, 'wts'), /outside the main checkout/],
    ['a dot-dot prefixed name inside the checkout', () => path.join(repo, '..wts'), /outside the main checkout/],
    ['the checkout itself', () => repo, /outside the main checkout/],
  ])('worktreeInProcess_create_%s_isRefused', (_, override, message) => {
    expect(() => hook.create({ cwd: repo, name: 'r' }, { AGENTS_WORKTREE_ROOT: override() })).toThrow(message);
  });

  it('worktreeInProcess_create_aLinkAsTheRepoDirectoryIsRefused', () => {
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const root = path.join(base, 'roots');
    fs.mkdirSync(root);
    fs.symlinkSync(elsewhere, path.join(root, 'my repo'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => hook.create({ cwd: repo, name: 'l' }, { AGENTS_WORKTREE_ROOT: root })).toThrow(/symbolic link or junction/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('worktreeInProcess_create_aRootThatIsAFileIsRefused', () => {
    const file = write(base, 'a-file-root', 'x');

    expect(() => hook.create({ cwd: repo, name: 'f' }, { AGENTS_WORKTREE_ROOT: file })).toThrow(/not a directory|ENOTDIR/);
  });

  it('worktreeInProcess_create_aFailingPostCheckoutHookRollsEverythingBack', () => {
    const script = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const worktrees = git(repo, ['worktree', 'list', '--porcelain']);
    const branches = git(repo, ['branch', '--list']);

    expect(() => hook.create({ cwd: repo, name: 'hooked' }, {})).toThrow(/git worktree add failed/);

    expect(git(repo, ['worktree', 'list', '--porcelain'])).toBe(worktrees);
    expect(git(repo, ['branch', '--list'])).toBe(branches);
    expect(fs.existsSync(path.join(parent, '.worktrees'))).toBe(false);
  });

  function failingHook() {
    write(repo, '.git/hooks/post-checkout', '#!/bin/sh\necho ORIGINAL_CHECKOUT_FAILURE >&2\nexit 1\n');
    fs.chmodSync(path.join(repo, '.git/hooks/post-checkout'), 0o755);
  }

  // Reload only the hook so its captured execFileSync drives real Git except at
  // the precise cleanup fault boundary. Fixture/setup Git keeps the real function.
  function cleanupFaultHook(fault) {
    const childProcess = require('node:child_process');
    const original = childProcess.execFileSync;
    vi.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, opts) => {
      if (file === 'git') fault(args, opts);
      return original(file, args, opts);
    });
    const modulePath = require.resolve('../../../.agents/hooks/worktree.cjs');
    delete require.cache[modulePath];
    const injected = require(modulePath);
    delete require.cache[modulePath];
    return injected;
  }

  function creationFailure(injected, name) {
    try { injected.create({ cwd: repo, name }, {}); }
    catch (error) {
      expect(error).toBeInstanceOf(injected.Refusal);
      expect(error.message).toContain('ORIGINAL_CHECKOUT_FAILURE');
      return error.message;
    }
    throw new Error('Expected creation refusal');
  }

  it('R3_worktree_failedRemoveAndRm_namesSurvivingDestinationRegistrationBranchAndDirs', () => {
    failingHook();
    const dest = expectedDest('locked');
    const injected = cleanupFaultHook(args => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('forced remove denied');
    });
    const originalRm = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (target === dest) throw Object.assign(new Error('locked file'), { code: 'EPERM' });
      return originalRm(target, options);
    });

    const message = creationFailure(injected, 'locked');

    expect(message).not.toContain('nothing was left behind');
    expect(message).toContain(dest);
    expect(message).toMatch(/registration|registered/);
    expect(message).toMatch(/branch.*worktree-locked/);
    expect(message).toContain(path.dirname(dest));
    expect(message).toContain(path.join(parent, '.worktrees'));
    expect(fs.existsSync(path.join(dest, 'a.txt'))).toBe(true);
    expect(hook.registeredWorktrees(repo).some(w => w.path === dest)).toBe(true);
    expect(git(repo, ['branch', '--list', 'worktree-locked'])).toContain('worktree-locked');
  });

  it('R3_worktree_failedPrune_namesSurvivingRegistrationAfterFallbackRemovesDirectory', () => {
    failingHook();
    const dest = expectedDest('prune');
    const injected = cleanupFaultHook(args => {
      if (args[0] === 'worktree' && ['remove', 'prune'].includes(args[1])) throw new Error(`${args[1]} denied`);
    });

    const message = creationFailure(injected, 'prune');

    expect(fs.existsSync(dest)).toBe(false);
    expect(hook.registeredWorktrees(repo).some(w => w.path === dest)).toBe(true);
    expect(message).not.toContain('nothing was left behind');
    expect(message).toMatch(/registration|registered/);
    expect(message).toContain(dest);
    expect(message).toContain('prune');
  });

  it('R3_worktree_failedBranchDelete_namesTheNewBranchThatSurvived', () => {
    failingHook();
    const injected = cleanupFaultHook(args => {
      if (args[0] === 'branch' && args[1] === '-D') throw new Error('branch deletion denied');
    });

    const message = creationFailure(injected, 'branch-left');

    expect(message).not.toContain('nothing was left behind');
    expect(message).toMatch(/branch.*worktree-branch-left/);
    expect(git(repo, ['branch', '--list', 'worktree-branch-left'])).toContain('worktree-branch-left');
    expect(fs.existsSync(expectedDest('branch-left'))).toBe(false);
  });

  it('R3_worktree_failedDirectoryCleanup_namesOnlyDirectoriesCreatedByThisCall', () => {
    failingHook();
    const repoDir = path.dirname(expectedDest('dirs'));
    const existingRoot = path.dirname(repoDir);
    fs.mkdirSync(existingRoot);
    write(existingRoot, 'user.txt', 'keep user data');
    const originalRmdir = fs.rmdirSync;
    vi.spyOn(fs, 'rmdirSync').mockImplementation(dir => {
      if (dir === repoDir) throw new Error('directory cleanup denied');
      return originalRmdir(dir);
    });

    const message = creationFailure(hook, 'dirs');

    expect(message).not.toContain('nothing was left behind');
    expect(message).toContain(repoDir);
    expect(fs.existsSync(repoDir)).toBe(true);
    expect(fs.readFileSync(path.join(existingRoot, 'user.txt'), 'utf8')).toBe('keep user data');
  });

  it('R3_worktree_fallbackRefusesALinkSwappedIntoTheDestinationAndPreservesItsTarget', () => {
    failingHook();
    const dest = expectedDest('swapped');
    const foreign = path.join(base, 'user-directory');
    write(foreign, 'keep.txt', 'user data');
    const injected = cleanupFaultHook(args => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.symlinkSync(foreign, dest, process.platform === 'win32' ? 'junction' : 'dir');
        throw new Error('destination changed');
      }
    });

    const message = creationFailure(injected, 'swapped');

    expect(message).not.toContain('nothing was left behind');
    expect(message).toContain(dest);
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8')).toBe('user data');
  });

  it('R3_worktree_fallbackPreservesAUserDirectorySwappedIntoTheDestination', () => {
    failingHook();
    const dest = expectedDest('user-swap');
    const injected = cleanupFaultHook(args => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        fs.rmSync(dest, { recursive: true, force: true });
        write(dest, 'user.txt', 'keep user data');
        throw new Error('destination replaced by user directory');
      }
    });

    const message = creationFailure(injected, 'user-swap');

    expect(message).not.toContain('nothing was left behind');
    expect(message).toContain(dest);
    expect(fs.readFileSync(path.join(dest, 'user.txt'), 'utf8')).toBe('keep user data');
  });

  it('worktreeInProcess_create_aPreExistingBranchIsKeptWhenGitRefusesTheCreation', () => {
    git(repo, ['branch', 'worktree-pre']);

    expect(() => hook.create({ cwd: repo, name: 'pre' }, {})).toThrow(/git worktree add failed/);

    expect(git(repo, ['branch', '--list', 'worktree-pre'])).toContain('worktree-pre');
    expect(fs.existsSync(path.join(parent, '.worktrees'))).toBe(false);
  });

  it('worktreeInProcess_create_aDestinationInsideAnotherWorktreeIsRefused', () => {
    const first = hook.create({ cwd: repo, name: 'outer' }, {});

    expect(() => hook.create({ cwd: repo, name: 'inner' }, { AGENTS_WORKTREE_ROOT: path.join(first, 'nested') })).toThrow(/inside the worktree/);
  });

  it.each(['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_TRACE', 'GIT_REDIRECT_STDERR'])('worktreeInProcess_environment_%s_isRefused', variable => {
    expect(() => hook.checkEnvironment({ [variable]: 'x' })).toThrow(/inherited Git redirection/);
    expect(() => hook.checkEnvironment({ [variable]: '' })).not.toThrow();
  });

  it('worktreeInProcess_environment_configIsolationVariablesAreAllowed', () => {
    expect(() => hook.checkEnvironment({ GIT_CONFIG_GLOBAL: 'x', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })).not.toThrow();
  });
});

describe('base ref and paths', () => {
  it('worktreeInProcess_baseRef_fallsBackToHeadWhenNoBranchNameIsKnown', () => {
    git(repo, ['branch', '-m', 'main', 'trunk']);

    expect(hook.baseRef(repo)).toBe('HEAD');
  });

  it('worktreeInProcess_baseRef_prefersTheRemoteDefaultOverLocalMain', () => {
    write(repo, 'b.txt');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'second']);
    const first = git(repo, ['rev-parse', 'HEAD~1']);
    git(repo, ['update-ref', 'refs/remotes/origin/trunk', first]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);

    expect(hook.baseRef(repo)).toBe('refs/remotes/origin/HEAD');
  });

  it('worktreeInProcess_inside_treatsADotDotPrefixedNameAsAChildNotATraversal', () => {
    const root = path.join(base, 'r');

    expect(hook.inside(root, path.join(root, '..x', 'y'))).toBe(true);
    expect(hook.inside(root, path.join(root, '..'))).toBe(false);
    expect(hook.inside(root, root)).toBe(true);
    expect(hook.inside(root, path.join(base, 'other'))).toBe(false);
  });

  it('worktreeInProcess_canonical_resolvesTheDeepestExistingAncestorAndKeepsTheMissingTail', () => {
    const missing = path.join(repo, 'no', 'such', 'dir');

    expect(hook.canonical(missing)).toBe(path.join(fs.realpathSync.native(repo), 'no', 'such', 'dir'));
    expect(hook.canonical(repo)).toBe(fs.realpathSync.native(repo));
  });

  it('worktreeInProcess_registeredWorktrees_listsTheMainCheckoutAndEachLinkedWorktreeWithItsBranch', () => {
    const dest = hook.create({ cwd: repo, name: 'listed' }, {});

    const list = hook.registeredWorktrees(repo);

    expect(list.map(entry => path.resolve(entry.path)).sort()).toEqual([path.resolve(repo), path.resolve(dest)].sort());
    expect(list.find(entry => path.resolve(entry.path) === path.resolve(dest)).branch).toBe('worktree-listed');
  });

  it('worktreeInProcess_mainCheckout_aBareRepositoryIsRefused', () => {
    const bare = path.join(base, 'bare.git');
    git(base, ['init', '--bare', bare]);

    expect(() => hook.mainCheckout(bare)).toThrow(Refusal);
  });
});

describe('remove', () => {
  it('worktreeInProcess_remove_deletesTheWorktreeAndItsMergedBranch', () => {
    const dest = hook.create({ cwd: repo, name: 'gone' }, {});

    hook.remove({ cwd: repo, worktree_path: dest }, {});

    expect(fs.existsSync(dest)).toBe(false);
    expect(git(repo, ['branch', '--list', 'worktree-gone'])).toBe('');
  });

  it('worktreeInProcess_remove_keepsABranchWithUnmergedCommits', () => {
    const dest = hook.create({ cwd: repo, name: 'ahead' }, {});
    write(dest, 'new.txt');
    git(dest, ['add', '.']);
    git(dest, ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'ahead']);

    hook.remove({ cwd: repo, worktree_path: dest }, {});

    expect(fs.existsSync(dest)).toBe(false);
    expect(git(repo, ['branch', '--list', 'worktree-ahead'])).toContain('worktree-ahead');
  });

  it('worktreeInProcess_remove_neverForcesOverUntrackedWork', () => {
    const dest = hook.create({ cwd: repo, name: 'dirty' }, {});
    write(dest, 'untracked.txt', 'keep me\n');

    expect(() => hook.remove({ cwd: repo, worktree_path: dest }, {})).toThrow(/uncommitted or untracked work stays/);
    expect(fs.readFileSync(path.join(dest, 'untracked.txt'), 'utf8')).toBe('keep me\n');
  });

  it('worktreeInProcess_remove_aDirectoryThatIsNotAWorktreeIsRefused', () => {
    const plain = path.join(parent, '.worktrees', 'my repo', 'worktree-plain');
    write(plain, 'f.txt');

    expect(() => hook.remove({ cwd: repo, worktree_path: plain }, {})).toThrow(/not inside a Git checkout|not a linked worktree/);
    expect(fs.existsSync(plain)).toBe(true);
  });

  it('worktreeInProcess_remove_theMainCheckoutIsRefused', () => {
    expect(() => hook.remove({ cwd: repo, worktree_path: repo }, {})).toThrow(/not a linked worktree/);
  });

  it('worktreeInProcess_remove_aWorktreeOutsideTheResolvedRootIsRefused', () => {
    const foreign = path.join(base, 'foreign', 'wt');
    git(repo, ['worktree', 'add', '-b', 'foreign', foreign]);

    expect(() => hook.remove({ cwd: repo, worktree_path: foreign }, {})).toThrow(/not under the worktree root/);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('worktreeInProcess_remove_aMissingUnregisteredPathIsIdempotentOnlyUnderTheRoot', () => {
    const underRoot = path.join(parent, '.worktrees', 'my repo', 'worktree-never');
    const outside = path.join(base, 'nowhere', 'worktree-x');

    expect(() => hook.remove({ cwd: repo, worktree_path: underRoot }, {})).not.toThrow();
    expect(() => hook.remove({ cwd: repo, worktree_path: outside }, {})).toThrow(/not under the worktree root/);
  });

  it('worktreeInProcess_remove_aMissingButRegisteredWorktreeFailsInsteadOfClaimingRemoval', () => {
    const dest = hook.create({ cwd: repo, name: 'vanished' }, {});
    fs.rmSync(dest, { recursive: true, force: true });

    expect(() => hook.remove({ cwd: repo, worktree_path: dest }, {})).toThrow(/still registered/);
  });

  it.each([
    ['a relative path', { worktree_path: 'relative/worktree' }],
    ['no path', {}],
  ])('worktreeInProcess_remove_%s_isRefused', (_, extra) => {
    expect(() => hook.remove({ cwd: repo, ...extra }, {})).toThrow(/absolute worktree_path/);
  });
});

describe('handle', () => {
  it('worktreeInProcess_handle_dispatchesCreateAndRemoveByEventName', () => {
    const dest = hook.handle(JSON.stringify({ hook_event_name: 'WorktreeCreate', cwd: repo, name: 'via-handle' }), undefined, {});
    expect(dest).toBe(expectedDest('via-handle'));

    const removed = hook.handle(JSON.stringify({ hook_event_name: 'WorktreeRemove', cwd: repo, worktree_path: dest }), undefined, {});
    expect(removed).toBeNull();
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('worktreeInProcess_handle_theKindMayComeFromTheCommandLine', () => {
    const dest = hook.handle(JSON.stringify({ cwd: repo, name: 'by-argv' }), 'create', {});

    expect(dest).toBe(expectedDest('by-argv'));
  });

  it.each([
    ['text that is not JSON', '{nope', /not a JSON event/],
    ['a JSON null', 'null', /not a JSON object/],
    ['a JSON array', '[]', /not a JSON object/],
    ['an unsupported event', JSON.stringify({ hook_event_name: 'PreToolUse' }), /unsupported event/],
  ])('worktreeInProcess_handle_%s_isRefused', (_, text, message) => {
    expect(() => hook.handle(text, undefined, {})).toThrow(message);
  });
});

describe('copyIncludes', () => {
  const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

  it('worktreeInProcess_copyIncludes_copiesOnlyIgnoredMatchesAndNeverOverwrites', () => {
    write(repo, '.worktreeinclude', '.env\nsecrets/**\na.txt\nmissing.txt\n');
    write(repo, '.env', 'TOKEN=1\n');
    write(repo, 'secrets/deep/key.json', '{}\n');
    const dest = path.join(base, 'dest');
    fs.mkdirSync(dest);
    write(dest, '.env', 'LOCAL=1\n');

    const copied = hook.copyIncludes(repo, dest);

    // a.txt is tracked, so it is never copied from the working tree; the existing .env is not overwritten.
    expect(copied.sort()).toEqual(['secrets/deep/key.json']);
    expect(fs.readFileSync(path.join(dest, '.env'), 'utf8')).toBe('LOCAL=1\n');
    expect(fs.existsSync(path.join(dest, 'a.txt'))).toBe(false);
  });

  it('worktreeInProcess_copyIncludes_noIncludeFileCopiesNothing', () => {
    expect(hook.copyIncludes(repo, path.join(base, 'dest'))).toEqual([]);
  });

  it('worktreeInProcess_copyIncludes_anIncludeFileThatIsADirectoryCopiesNothing', () => {
    fs.mkdirSync(path.join(repo, '.worktreeinclude'));

    expect(hook.copyIncludes(repo, path.join(base, 'dest'))).toEqual([]);
  });

  it('worktreeInProcess_copyIncludes_aMatchThatIsOnlyIgnoredByThePatternListCopiesNothing', () => {
    write(repo, '.worktreeinclude', 'notes.txt\n');
    write(repo, 'notes.txt', 'untracked and not ignored\n');
    const dest = path.join(base, 'dest');
    fs.mkdirSync(dest);

    expect(hook.copyIncludes(repo, dest)).toEqual([]);
    expect(fs.existsSync(path.join(dest, 'notes.txt'))).toBe(false);
  });

  it('worktreeInProcess_copyIncludes_aSourceBehindALinkIsSkipped', () => {
    const outside = path.join(base, 'outside');
    write(outside, 'secret.txt', 'outside\n');
    link(outside, path.join(repo, 'secrets'));
    write(repo, '.worktreeinclude', 'secrets/**\n');
    const dest = path.join(base, 'dest');
    fs.mkdirSync(dest);

    expect(hook.copyIncludes(repo, dest)).toEqual([]);
    expect(fs.existsSync(path.join(dest, 'secrets'))).toBe(false);
  });

  it('worktreeInProcess_copyIncludes_aConflictOnOnePathDoesNotAbortTheRest', () => {
    write(repo, '.worktreeinclude', 'secrets/**\n.env\n');
    write(repo, 'secrets/key.json', '{}\n');
    write(repo, '.env', 'T=1\n');
    const dest = path.join(base, 'dest');
    fs.mkdirSync(dest);
    // A file where the directory `secrets` is needed.
    write(dest, 'secrets', 'i am a file\n');

    const copied = hook.copyIncludes(repo, dest);

    expect(copied).toEqual(['.env']);
    expect(fs.readFileSync(path.join(dest, 'secrets'), 'utf8')).toBe('i am a file\n');
  });
});
