// commit-guard: anything that skips or disables the git hooks that run the secret scan is blocked the way an
// inline `-m` is (SEC-MAJOR-5, SEC-MINOR-3, CR-M4, CR-n4, SEC-NIT-1 of the git-hooks review).
//
// Coverage:
//   - --no-verify / -n on commit in every spelling (long, abbreviated, clusters), and --no-verify on merge, am,
//     rebase, pull, push, cherry-pick, revert; git commit-tree
//   - at any command head: wrappers, chains, keywords, global options, absolute git paths, line continuations,
//     and NOT excused by a commit.js helper elsewhere in the command
//   - shell quoting is normalised before matching: "git", $'-n', "core.hooks"Path, '--no-verify'
//   - hooks configuration: -c / --config-env (also as a separate argument), include.path / includeIf, git config
//     writes and unsets, GIT_CONFIG_* in the environment, aliases (resolved in the repository) and -c alias.x=
//   - core.hooksPath only counts as a config key in argument position, never inside a file name
//   - benign look-alikes pass, `git commit -F` is never blocked, reads of the setting pass
//   - the block message tells the agent to stop and ask the user and does NOT hand over the bypass

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { processEvent, hasNoVerifyFlag, tokenize, hooksConfigKey } = require('../../../.agents/hooks/commit-guard.cjs');

const evt = (command) => ({ tool_input: { command } });
const isBlocked = (cmd) => {
  const r = processEvent(evt(cmd));
  return !!(r && r.block);
};
const table = (title, cmds, expected) => describe(title, () => {
  for (const cmd of cmds) {
    it(`${expected ? 'blocks' : 'passes'}: ${cmd}`, () => {
      expect(isBlocked(cmd)).toBe(expected);
    });
  }
});

table('commit-guard --no-verify / -n: the flag in every spelling is blocked', [
  'git commit --no-verify',
  'git commit --no-verify -F docs/.output/.state/.commit-msg',
  'git commit -F docs/.output/.state/.commit-msg --no-verify',
  'git commit --amend --no-verify',
  'git commit --no-verif -F f',        // git accepts any unambiguous abbreviation
  'git commit --no-veri -F f',
  'git commit -n',
  'git commit -n -F f',
  'git commit -F f -n',
  'git commit -nm "x"',                // combined short flags
  'git commit -nF f',
  'git commit -an',
  'git commit -anm "x"',
  'git commit -qn',
  'git commit -ns',
  'git commit -a -n --amend',
  'git commit --amend --no-edit -n',
  'git commit "-n" -F f',              // quoted flag is still the flag
  "git commit '--no-verify' -F f",
  'git commit -m "x" -n',              // the value is skipped, the later flag is not
  'git commit -F f -m x -n',
  'git commit --message x --no-verify',
], true);

table('commit-guard: shell quoting is normalised before matching (SEC-MAJOR-5)', [
  '"git" commit -n -F f',              // quoted head
  "'git' commit --no-verify -F f",
  'g\\it commit -n -F f',              // backslash inside the word
  "git commit $'-n' -F f",             // ANSI-C quoting
  "git commit $'--no-verify' -F f",
  "git commit $'\\x2dn' -F f",         // -n spelled as an escape
  'git "commit" -n -F f',              // quoted subcommand
  'git comm"it" -n -F f',
  'git -c "core.hooks"Path=/dev/null commit -F f', // split key
  "git -c core.hooks'Path'=/dev/null commit -F f",
  "git -c $'core.hooksPath'=/dev/null commit -F f",
  'git -c "core.hooksPath=/dev/null" commit -F f',
  'sudo "git" commit -n -F f',         // quoted head behind a wrapper
  'FOO=bar "git" commit --no-verify -F f',
], true);

table('commit-guard --no-verify / -n: wrappers, chains and global options', [
  'sudo git commit --no-verify -F f',
  'env FOO=bar git commit -n -F f',
  'FOO=bar git commit --no-verify -F f',
  'time nice -n 10 git commit -n -F f',
  'git add -A && git commit -n -F f',
  'git add -A; git commit --no-verify -F f',
  'git status | cat; git commit -an -F f',
  'sleep 1 & git commit -n -F f',
  'if true; then git commit --no-verify -F f; fi',
  'for i in 1; do git commit -n -F f; done',
  'git -c user.name=x commit --no-verify -F f',
  'git -C /some/path commit -n -F f',
  'git --no-pager commit -an -F f',
  '/usr/bin/git commit --no-verify -F f',
  'git.exe commit -n -F f',
  'C:\\Git\\bin\\git.exe commit --no-verify -F f',
  'git commit \\\n--no-verify -F f',   // line continuation rejoins the flag
  'xargs -I{} git commit -n -F f',
  // The helper elsewhere in the command does not excuse a hooks-skipping commit (chained evasion).
  'node .claude/core/commit.js --dry-run && git commit -n -F f',
  'git commit --no-verify -F f # node .claude/core/commit.js',
  'echo node .claude/core/commit.js; git commit -an -F f',
], true);

table('commit-guard: --no-verify on the other commands that run hooks (SEC-MAJOR-5, CR-M4)', [
  'git merge --no-verify branch',
  'git merge --no-ff --no-verify -m "x" branch',
  'git rebase --no-verify main',
  'git rebase -i --no-verify HEAD~3',
  'git am --no-verify p.patch',
  'git am -n p.patch',
  'git pull --no-verify',
  'git push --no-verify',
  'git push --no-verify origin main',
  'git cherry-pick --no-verify abc',
  'git revert --no-verify HEAD',
  'git merge --no-veri branch',
  'sudo git push --no-verify',
  'git -C repo merge --no-verify branch',
  'git commit-tree HEAD^{tree} -p HEAD -m x',      // writes a commit with no hook at all
  'git commit-tree abc123 -m x && git update-ref refs/heads/main abc',
], true);

table('commit-guard: core.hooksPath, include paths and config redirection (SEC-MAJOR-5, CR-M4)', [
  'git -c core.hooksPath=/dev/null commit -F f',
  'git -c core.hooksPath=/nonexistent commit -F f',
  'git -c core.hookspath=/dev/null commit -F f',
  'git -c CORE.HOOKSPATH=/dev/null commit -F f',
  'git --config-env=core.hooksPath=NOHOOKS commit -F f',
  'git --config-env core.hooksPath=NOHOOKS commit -F f',            // separate argument
  'HP=/dev/null git --config-env core.hooksPath=HP commit -F f',
  'sudo git -c core.hooksPath=/dev/null commit -F f',
  'git -c core.hooksPath=/dev/null status',                         // any subcommand: it is the redirection that is refused
  'git -c include.path=/tmp/evil.cfg commit -F f',
  'git -c includeIf.gitdir:/x/.path=/tmp/evil.cfg commit -F f',
  'git --config-env include.path=EVIL commit -F f',
  'git config core.hooksPath /dev/null',
  'git config core.hooksPath /dev/null; git commit -F f',
  'git config --local core.hooksPath x',
  'git config --global core.hooksPath x',
  'git config --worktree core.hooksPath x',
  'git config --system core.hooksPath x',
  'git config --unset core.hooksPath',
  'git config --global --unset-all core.hooksPath',
  'git config --add core.hooksPath x',
  'git config "core.hooks"Path /dev/null',
  'git config include.path /tmp/evil.cfg',
  'git config includeIf.onbranch:main.path /tmp/evil.cfg',
  'git -C repo config core.hooksPath /dev/null',
  // git >= 2.46 subcommand syntax, every scope form (closure pass: MAJOR-5 leftover)
  'git config set core.hooksPath /dev/null',
  'git config unset core.hooksPath',
  'git config set --local core.hooksPath /dev/null',
  'git config set --global core.hooksPath /dev/null',
  'git config set --worktree core.hooksPath /dev/null',
  'git config set --system core.hooksPath /dev/null',
  'git config set --file /tmp/evil.cfg core.hooksPath /dev/null',
  'git config unset --local core.hooksPath',
  'git config unset --global core.hooksPath',
  'git config unset --worktree core.hooksPath',
  'git config unset --system core.hooksPath',
  'git config unset --file .git/config core.hooksPath',
  'git config --local set core.hooksPath /dev/null',
  'git config set "core.hooks"Path /dev/null',
  'git config set include.path /tmp/evil.cfg',
  'git config set alias.ci "commit --no-verify"',
  'git -C repo config set core.hooksPath /dev/null',
  // url rewriting: the push scan's ls-remote follows insteadOf to a decoy while the push goes elsewhere (NEW-2)
  'git -c url./tmp/decoy.git.insteadOf=/srv/origin.git push origin main',
  'git -c url./srv/origin.git.pushInsteadOf=/srv/origin.git push origin main',
  'git -c url./tmp/d.insteadOf=/srv/o.git -c url./srv/o.git.pushInsteadOf=/srv/o.git push origin main',
  'git -c URL./tmp/d.INSTEADOF=/srv/o.git push origin main',
  'git -c "url./tmp/d.insteadOf"=/srv/o.git push origin main',
  'git --config-env url./tmp/d.insteadOf=DECOY push origin main',
  'git --config-env=url./tmp/d.pushInsteadOf=O push origin main',
  'git -c url.https://github.com/.insteadOf=gh: fetch',                  // any subcommand: it is the rewriting that is refused
  'git config url./tmp/decoy.git.insteadOf /srv/origin.git',
  'git config url./srv/origin.git.pushInsteadOf /srv/origin.git',
  'git config --local url./tmp/d.insteadOf /srv/o.git',
  'git config --global url./tmp/d.insteadOf /srv/o.git',
  'git config --worktree url./tmp/d.pushInsteadOf /srv/o.git',
  'git config --system url./tmp/d.insteadOf /srv/o.git',
  'git config --file /tmp/x.cfg url./tmp/d.insteadOf /srv/o.git',
  'git config --add url./tmp/d.insteadOf /srv/o.git',
  'git config --replace-all url./tmp/d.insteadOf /srv/o.git',
  'git config --unset url./tmp/d.insteadOf',
  'git config --unset-all url./tmp/d.pushInsteadOf',
  'git config set url./tmp/d.insteadOf /srv/o.git',
  'git config set --local url./tmp/d.pushInsteadOf /srv/o.git',
  'git config unset url./tmp/d.insteadOf',
  'git config unset --global url./tmp/d.pushInsteadOf',
  'git config "url./tmp/d.insteadOf" /srv/o.git',
  'git config url./tmp/d."insteadOf" /srv/o.git',
  "git config $'url./tmp/d.insteadOf' /srv/o.git",
  'git -C repo config url./tmp/d.insteadOf /srv/o.git',
  'export GIT_CONFIG_PARAMETERS="\'url./tmp/d.insteadof\'=\'/srv/o.git\'"',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url./tmp/d.insteadOf GIT_CONFIG_VALUE_0=/srv/o.git git push origin main',
], true);

table('commit-guard: GIT_CONFIG_* in the environment of a command that commits (SEC-MAJOR-5, CR-M4)', [
  'GIT_CONFIG_GLOBAL=/tmp/evil.cfg git commit -F f',
  'GIT_CONFIG_SYSTEM=/tmp/evil.cfg git commit -F f',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -F f',
  'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x; git commit -F f',
  "export GIT_CONFIG_PARAMETERS=\"'core.hookspath'='/dev/null'\"; git commit -F f",
  'export GIT_CONFIG_GLOBAL=/tmp/evil.cfg\ngit commit -F f',
  'env GIT_CONFIG_GLOBAL=/tmp/evil.cfg git merge branch',
  'GIT_CONFIG_GLOBAL=/tmp/evil.cfg; git push origin main',
  'export GIT_CONFIG_KEY_0=core.hooksPath',                          // a value naming the setting is refused on its own
  'export GIT_CONFIG_PARAMETERS="\'core.hookspath\'=\'/dev/null\'"',
], true);

describe('commit-guard: aliases are resolved in the repository and evaluated (SEC-MAJOR-5, CR-M4)', () => {
  let repo;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-alias-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'alias.ci', 'commit --no-verify'], { cwd: repo });
    execFileSync('git', ['config', 'alias.safe', 'commit -F'], { cwd: repo });
    execFileSync('git', ['config', 'alias.chain', 'ci'], { cwd: repo });
    execFileSync('git', ['config', 'alias.shellci', '!git commit -n "$@"'], { cwd: repo });
    execFileSync('git', ['config', 'alias.st', 'status -s'], { cwd: repo });
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  // PowerShell writes a Windows path with backslashes and no quotes; the POSIX reading of that text mangles the
  // directory (each \x is an escape), found no alias there, and once allowed the alias through. Both readings are judged.
  it('blocks the alias when the -C path is written the Windows way, with backslashes and no quotes', () => {
    const winPath = repo.split(path.sep).join('\\');
    // On POSIX a backslash path names no real directory, so there is no alias to find there.
    expect(isBlocked(`git -C ${winPath} ci -F f`)).toBe(process.platform === 'win32');
    expect(isBlocked(`git -C ${winPath} st`)).toBe(false);
  });
  it('blocks an alias whose expansion carries --no-verify (git -C <repo> ci)', () => {
    expect(isBlocked(`git -C ${repo} ci -F f`)).toBe(true);
  });
  it('blocks an alias of an alias', () => {
    expect(isBlocked(`git -C ${repo} chain -F f`)).toBe(true);
  });
  it('blocks a shell alias that runs git commit -n, and passes the extra arguments through the evaluation', () => {
    expect(isBlocked(`git -C ${repo} shellci -F f`)).toBe(true);
  });
  it('blocks a harmless alias when the arguments given to it add -n', () => {
    expect(isBlocked(`git -C ${repo} safe f -n`)).toBe(true);           // alias.safe = "commit -F", so this is: commit -F f -n
  });
  it('passes an alias that is harmless', () => {
    expect(isBlocked(`git -C ${repo} st`)).toBe(false);
    expect(isBlocked(`git -C ${repo} safe docs/.output/.state/.commit-msg`)).toBe(false);
  });
  it('resolves through the working directory when no -C is given', () => {
    const prev = process.cwd();
    process.chdir(repo);
    try {
      expect(isBlocked('git ci -F f')).toBe(true);
      expect(isBlocked('git st')).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });
  it('blocks defining the alias, and using it from the same command line (-c alias.x=)', () => {
    expect(isBlocked('git config alias.ci "commit --no-verify"')).toBe(true);
    expect(isBlocked('git config alias.ci "!git commit -n"')).toBe(true);
    expect(isBlocked('git -c alias.ci="commit --no-verify" ci -F f')).toBe(true);
    expect(isBlocked("git -c 'alias.x=merge --no-verify' x branch")).toBe(true);
    expect(isBlocked('git config alias.st "status -s"')).toBe(false);
    expect(isBlocked('git -c alias.st="status -s" st')).toBe(false);
  });
  it('an unknown subcommand with no alias passes, and a missing repository is not an error', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-plain-'));
    try {
      expect(isBlocked(`git -C ${plain} frobnicate -n`)).toBe(false);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

table('commit-guard: what must still pass', [
  'git commit -F docs/.output/.state/.commit-msg',           // -F is never blocked
  'sudo git commit -F docs/.output/.state/.commit-msg',
  'git -c user.name=x commit -F f',
  'git commit --amend',
  'git commit --amend --no-edit',
  'git commit',
  'git commit -a',
  'git commit -s -S',
  'git commit -uno',                                          // -u takes an attached value; the n belongs to it
  'git commit -Fn',                                           // a file literally named n
  'git commit -F n',
  'git commit -F f -- -n',                                    // after `--` the words are paths
  'git commit --no-verbose',                                  // a different option
  'git commit --verbose',
  'git commit --dry-run',
  'node .claude/core/commit.js --all',
  'CLAUDE_COMMIT_NO_SCAN=1 node .claude/core/commit.js --all', // the helper path (the guardrail asks the user about this one)
  'node .claude/core/commit.js --paths a b --no-scan',
  'git push -n',                                              // -n is --dry-run for push
  'git push origin main',
  'git merge -n branch',                                      // -n is --no-stat for merge
  'git merge branch',
  'git rebase -n main',                                       // --no-stat
  'git pull --rebase',
  'git am p.patch',
  'git cherry-pick abc',
  'git revert -n HEAD',                                       // --no-commit
  'git status',
  'git log --oneline',
  'echo "git commit --no-verify"',                            // a mention inside a quoted argument
  'grep -r "git commit -n" .',
  'legit commit -n',                                          // other binaries named *git
  'git-lfs commit -n',
  'GIT_CONFIG_NOSYSTEM=1 git status',                         // not one of the redirecting variables
  'GIT_CONFIG_GLOBAL=/dev/null git status',                   // no hook-running subcommand in the command
  'GIT_CONFIG_GLOBAL=/dev/null git config --list',
], false);

table('commit-guard: reading the setting, and a file name that merely contains it (CR-n4 / SEC-NIT-1)', [
  'git config core.hooksPath',
  'git config --get core.hooksPath',
  'git config --local --get core.hooksPath',
  'git config --get-all core.hooksPath',
  'git config --get url./tmp/d.insteadOf',
  'git config --get-regexp "^url\\."',
  'git config get url./tmp/d.insteadOf',
  'git ls-remote --get-url origin',
  'git remote get-url origin',
  'git remote -v',
  'git config get core.hooksPath',
  'git config get --local core.hooksPath',
  'git config list',
  'git config set user.name Test',
  'git config unset user.name',
  'git config set alias.st "status -s"',
  'git config --list',
  'git config user.name "Test"',
  'git config --global user.email a@b.c',
  'git commit -F docs/core.hooksPath-notes.md',               // a file name, not a config key
  'git commit -F core.hooksPath',
  'git add docs/core.hooksPath.md',
  'git commit -F f -- core.hooksPath',
  'cat .git/config',
  'git -c user.name=x -c color.ui=never commit -F f',
], false);

describe('commit-guard: the block message', () => {
  it('tells the agent to stop and ask the user, and does not hand over a bypass', () => {
    for (const cmd of ['git commit --no-verify -F f', 'git -c core.hooksPath=/dev/null commit -F f', 'git push --no-verify', 'git config core.hooksPath x']) {
      const r = processEvent(evt(cmd));
      expect(r.block, cmd).toBe(true);
      expect(r.feedback, cmd).toMatch(/Stop and ask the user/);
      expect(r.feedback, cmd).toMatch(/only the user decides/);
      expect(r.feedback, cmd).not.toContain('CLAUDE_COMMIT_NO_SCAN');
      expect(r.feedback, cmd).not.toContain('--no-scan');
      expect(r.feedback, cmd).not.toContain('commit.js');
    }
  });

  it('names what was blocked', () => {
    expect(processEvent(evt('git commit -n -F f')).feedback).toMatch(/git commit --no-verify \/ -n/);
    expect(processEvent(evt('git push --no-verify')).feedback).toMatch(/git push --no-verify/);
    expect(processEvent(evt('git commit-tree abc')).feedback).toMatch(/commit-tree/);
  });

  it('inline -m still gets its own message, with the helper', () => {
    const r = processEvent(evt('git commit -m "x"'));
    expect(r.feedback).toContain('inline `git commit -m` is disabled');
    expect(r.feedback).toContain('commit.js');
  });
});

describe('commit-guard: helpers', () => {
  it('tokenize splits like the shell: quotes group and join, backslashes escape, $\'..\' decodes, a word-start # ends the command', () => {
    expect(tokenize(' -m "a b" -F  f')).toEqual(['-m', 'a b', '-F', 'f']);
    expect(tokenize(" '--no-verify' x\\ y")).toEqual(['--no-verify', 'x y']);
    expect(tokenize('"core.hooks"Path=x')).toEqual(['core.hooksPath=x']);
    expect(tokenize("$'-n' $'\\x2dn' $'a\\tb'")).toEqual(['-n', '-n', 'a\tb']);
    expect(tokenize('commit -F f # -n not a flag')).toEqual(['commit', '-F', 'f']);
    expect(tokenize('a#b')).toEqual(['a#b']);
    expect(tokenize('')).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it('hasNoVerifyFlag reads clusters left to right and stops at a value-taking option', () => {
    expect(hasNoVerifyFlag(' -an')).toBe(true);
    expect(hasNoVerifyFlag(' -anm x')).toBe(true);
    expect(hasNoVerifyFlag(" $'-n'")).toBe(true);
    expect(hasNoVerifyFlag(' -mn')).toBe(false);   // `n` is the message
    expect(hasNoVerifyFlag(' -Fn')).toBe(false);
    expect(hasNoVerifyFlag(' -m n')).toBe(false);  // `n` is the message, detached
    expect(hasNoVerifyFlag(' -F -n')).toBe(false); // `-n` is the file name
    expect(hasNoVerifyFlag(' --message -n')).toBe(false);
    expect(hasNoVerifyFlag(' -- -n')).toBe(false);
  });

  it('hooksConfigKey matches the keys in any case, with or without a value, and nothing else', () => {
    for (const kv of ['core.hooksPath=/x', 'CORE.HOOKSPATH', 'core.hookspath', 'include.path=/x', 'includeIf.gitdir:/x/.path=/y']) expect(hooksConfigKey(kv), kv).toBe(true);
    for (const kv of ['user.name=x', 'core.editor=vim', 'core.hooksPath-notes', 'alias.ci=commit', '', undefined]) expect(hooksConfigKey(kv), String(kv)).toBe(false);
  });
});

describe('commit-guard: fail closed', () => {
  it('a command that is only a mention, or empty, passes; a non-string command does not throw', () => {
    expect(processEvent(evt(''))).toBeNull();
    expect(processEvent({})).toBeNull();
    expect(processEvent(evt('echo hello'))).toBeNull();
  });
});
