// git-hooks.js — the toolkit-managed pre-commit + commit-msg hooks.
//
// Real git in temp repositories. Each repository's `.agents` links to this toolkit's, so the hooks run the
// real scanner and the real engine. Key-shaped fixtures are built from string parts (hook-repo.js).
//
// Coverage:
//   - install: both hooks, executable, LF, marker; idempotent; refreshed when outdated or not executable
//   - the hooks gate a raw `git commit -F`: staged key, key in the message, clean, audited bypass
//   - fail closed: missing scanner, missing node
//   - never clobber a foreign hook; never write to a core.hooksPath outside the git dir; fossil cleanup text
//   - linked worktrees use the hooks in the common dir
//   - --remove deletes marker hooks only; --check exit codes; requireRoot; install wiring never throws

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { gitAvailable } = require('./_helpers/git-fixture');
const hooks = require('../git-hooks');
const R = require('./_helpers/hook-repo');

const isWin = process.platform === 'win32';
const sh = it.skipIf(!gitAvailable());

let tmp;
let repo;
beforeEach(() => {
  tmp = createTmpDir({ prefix: 'git-hooks-' });
  if (gitAvailable()) repo = R.createHookRepo(path.join(tmp.root, 'repo'));
});
afterEach(() => tmp.cleanup());

const hookFile = (name, dir = repo) => path.join(R.gitOut(dir, ['rev-parse', '--absolute-git-dir']), 'hooks', name);
const commitF = (dir, text, env = {}) => R.git(dir, ['commit', '-F', R.writeMessage(tmp.root, text)], { env });
const install = (dir = repo, options) => hooks.installHooks(dir, options);

describe('install', () => {
  sh('writes both hooks into the git dir: executable, LF only, with the marker; nothing tracked', () => {
    const result = install();
    expect(result).toMatchObject({ status: 'installed', active: true, problems: [] });
    expect(result.changed.sort()).toEqual([...hooks.HOOK_NAMES].sort());
    for (const name of hooks.HOOK_NAMES) {
      const text = fs.readFileSync(hookFile(name), 'utf8');
      expect(text).toBe(hooks.renderHook(name));
      expect(text).not.toContain('\r');
      expect(text.startsWith('#!/bin/sh\n')).toBe(true);
      expect(text).toContain(`# domdhi-agents managed hook: ${name} v2`);
      if (!isWin) expect(fs.statSync(hookFile(name)).mode & 0o111).toBe(0o111);
    }
    expect(R.git(repo, ['status', '--porcelain']).stdout).toBe('');
    expect(hooks.isActive(repo)).toBe(true);
  });

  sh('is idempotent: a second install changes nothing', () => {
    install();
    const before = ['pre-commit', 'commit-msg'].map(n => fs.statSync(hookFile(n)).mtimeMs);
    const again = install();
    expect(again).toMatchObject({ status: 'current', changed: [], active: true });
    expect(['pre-commit', 'commit-msg'].map(n => fs.statSync(hookFile(n)).mtimeMs)).toEqual(before);
  });

  sh('refreshes an outdated marker hook (update) and restores a lost execute bit', () => {
    install();
    fs.writeFileSync(hookFile('pre-commit'), '#!/bin/sh\n# domdhi-agents managed hook: pre-commit v0\nexit 0\n');
    expect(hooks.isActive(repo)).toBe(false);
    const updated = install();
    expect(updated).toMatchObject({ status: 'updated', changed: ['pre-commit'], active: true });
    expect(fs.readFileSync(hookFile('pre-commit'), 'utf8')).toBe(hooks.renderHook('pre-commit'));
    if (!isWin) {
      fs.chmodSync(hookFile('commit-msg'), 0o644);
      expect(hooks.isActive(repo)).toBe(false);
      expect(install()).toMatchObject({ status: 'updated', changed: ['commit-msg'] });
      expect(fs.statSync(hookFile('commit-msg')).mode & 0o111).toBe(0o111);
    }
  });

  sh('rewrites CRLF line endings back to LF', () => {
    install();
    fs.writeFileSync(hookFile('commit-msg'), hooks.renderHook('commit-msg').replace(/\n/g, '\r\n'));
    expect(install()).toMatchObject({ status: 'updated', changed: ['commit-msg'] });
    expect(fs.readFileSync(hookFile('commit-msg'), 'utf8')).not.toContain('\r');
  });

  sh('--dry-run writes nothing and says what it would do', () => {
    const result = install(repo, { dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.summary).toMatch(/would write/);
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
  });

  sh('skips a directory that is not a git work tree, and a missing directory', () => {
    const plain = tmp.mkdir('plain');
    expect(install(plain)).toMatchObject({ status: 'skipped', active: false });
    expect(install(path.join(tmp.root, 'nope'))).toMatchObject({ status: 'skipped', summary: expect.stringContaining('does not exist') });
  });

  sh('refuses to install hooks that would block every commit because the scanner is absent', () => {
    fs.unlinkSync(path.join(repo, '.agents'));
    const result = install();
    expect(result).toMatchObject({ status: 'blocked', active: false });
    expect(result.summary).toMatch(/secret-scanner\.cjs is not in/);
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
  });

  sh('requireRoot refuses a target that is a subdirectory of another repository', () => {
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    expect(hooks.installHooks(sub, { requireRoot: true })).toMatchObject({ status: 'skipped' });
    expect(hooks.removeHooks(sub, { requireRoot: true })).toMatchObject({ status: 'skipped' });
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
    expect(hooks.installHooks(sub)).toMatchObject({ status: 'installed' }); // the CLI default is lenient
  });
});

describe('the installed hooks gate a raw `git commit -F`', () => {
  sh('blocks a staged key: no commit is written', () => {
    install();
    const before = R.commitCount(repo);
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const r = commitF(repo, 'feat: add config\n');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Commit blocked/);
    expect(r.out).not.toContain(R.CG_KEY);
    expect(R.commitCount(repo)).toBe(before);
  });

  sh('blocks a key in the message file, even with clean staged files', () => {
    install();
    const before = R.commitCount(repo);
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const r = commitF(repo, `fix: rotate\n\nthe old key was ${R.AWS_KEY}\n`);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/commit message contains what looks like a secret/);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(r.out).not.toContain(R.AWS_KEY);
    expect(R.commitCount(repo)).toBe(before);
  });

  sh('lets a clean commit through', () => {
    install();
    const before = R.commitCount(repo);
    R.stage(repo, 'app.js', 'const x = 1;\nconsole.log(x);\n');
    const r = commitF(repo, 'feat: add app\n\nA clean body.\n');
    expect(r.status, r.out).toBe(0);
    expect(R.commitCount(repo)).toBe(before + 1);
  });

  sh('blocks a key hidden below a forged scissors line (the whole message file is scanned)', () => {
    install();
    const before = R.commitCount(repo);
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const text = `feat: add app\n\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+${R.AWS_KEY}\n`;
    const r = commitF(repo, text);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/commit message contains what looks like a secret/);
    expect(R.commitCount(repo)).toBe(before);
  });

  sh('a clean message with a verbose-style diff below the scissors line passes', () => {
    install();
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const text = `feat: add app\n\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/app.js b/app.js\n+const x = 1;\n`;
    const r = commitF(repo, text);
    expect(r.status, r.out).toBe(0);
  });

  sh('CLAUDE_COMMIT_NO_SCAN=1 commits a staged key and records exactly one bypass event from the hook', () => {
    install();
    const before = R.commitCount(repo);
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const r = commitF(repo, 'feat: add config\n', { CLAUDE_COMMIT_NO_SCAN: '1' });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/secret scan bypassed/);
    expect(R.commitCount(repo)).toBe(before + 1);
    const events = R.guardrailEvents(repo);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'bypass', rule: 'git-hook-no-scan', source: 'secret-scanner' });
  });

  sh('fails closed with a restore/remove message when the scanner file is missing', () => {
    install();
    fs.unlinkSync(path.join(repo, '.agents'));
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const r = commitF(repo, 'feat: add app\n');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/secret scanner is missing/);
    expect(r.out).toMatch(/git checkout -- \.agents\/hooks\/secret-scanner\.cjs/);
    expect(r.out).toMatch(/node \.agents\/core\/git-hooks\.js --remove/);
  });

  it.skipIf(!gitAvailable() || isWin)('fails closed with a message when node is not on PATH', () => {
    install();
    const bin = tmp.mkdir('only-git');
    const gitBin = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(gitBin, path.join(bin, 'git'));
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const r = commitF(repo, 'feat: add app\n', { PATH: bin });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/node is not on PATH/);
    expect(R.commitCount(repo)).toBe(1);
  });

  sh('a missing or broken engine blocks the commit (fail closed)', () => {
    install();
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const r = commitF(repo, 'feat: add app\n', { AGENTS_SECRET_ENGINE_BIN: path.join(tmp.root, 'no-such-engine') });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/FAIL-CLOSED/);
    expect(R.commitCount(repo)).toBe(1);
  });

  sh('scans the tree git is committing in, even when CLAUDE_PROJECT_DIR names another checkout', () => {
    install();
    const other = tmp.mkdir('other');
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const r = commitF(repo, 'feat: add config\n', { CLAUDE_PROJECT_DIR: other });
    expect(r.status).not.toBe(0);
    expect(R.commitCount(repo)).toBe(1);
  });
});

describe('a hook that is not ours', () => {
  sh('is never overwritten, and the owner is told the exact line to add', () => {
    const foreign = '#!/bin/sh\necho my own hook\n';
    fs.mkdirSync(path.dirname(hookFile('pre-commit')), { recursive: true });
    fs.writeFileSync(hookFile('pre-commit'), foreign, { mode: 0o755 });
    const result = install();
    expect(fs.readFileSync(hookFile('pre-commit'), 'utf8')).toBe(foreign);
    expect(result.status).toBe('blocked');
    expect(result.active).toBe(false);
    expect(result.changed).not.toContain('pre-commit'); // the other hooks are ours to write
    expect(result.changed).toContain('commit-msg');
    const text = result.problems.flat().join('\n');
    expect(text).toContain('was not written by the toolkit');
    expect(text).toContain(hooks.ownerLine('pre-commit'));
    expect(hooks.ownerLine('pre-commit')).toContain('secret-scanner.cjs" --git-precommit || exit 1');
    expect(hooks.ownerLine('commit-msg')).toContain('--commit-msg "$1" || exit 1');
    expect(hooks.isActive(repo)).toBe(false);
  });

  sh('stays untouched through remove and re-install', () => {
    const foreign = '#!/bin/sh\necho mine\n';
    fs.writeFileSync(hookFile('commit-msg'), foreign, { mode: 0o755 });
    install();
    hooks.removeHooks(repo);
    install();
    hooks.removeHooks(repo);
    expect(fs.readFileSync(hookFile('commit-msg'), 'utf8')).toBe(foreign);
  });

  sh('a symlinked hook is foreign too', () => {
    const real = path.join(tmp.root, 'real-hook.sh');
    fs.writeFileSync(real, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try { fs.symlinkSync(real, hookFile('pre-commit')); } catch { return; }
    expect(install().status).toBe('blocked');
    expect(fs.readFileSync(real, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
  });

  sh('the retired .githooks fossil is recognised and the known cleanup is printed, not run', () => {
    const fossil = '#!/bin/sh\n#\n# Git pre-commit hook — Secret Scanner\n#\nnode .claude/hooks/secret-scanner.cjs --git-precommit\n';
    fs.mkdirSync(path.join(repo, '.githooks'));
    fs.writeFileSync(path.join(repo, '.githooks', 'pre-commit'), fossil); // committed non-executable, like the adopters' copies
    R.git(repo, ['add', '.githooks/pre-commit']);
    R.git(repo, ['config', 'core.hooksPath', '.githooks']);
    const result = install();
    expect(result.status).toBe('blocked');
    const text = result.problems.flat().join('\n');
    expect(text).toContain('core.hooksPath points to ".githooks"');
    expect(text).toContain('retired toolkit hook');
    expect(text).toContain('git rm .githooks/pre-commit');
    expect(text).toContain('git config --unset core.hooksPath');
    // Nothing was written or removed anywhere.
    expect(fs.readFileSync(path.join(repo, '.githooks', 'pre-commit'), 'utf8')).toBe(fossil);
    expect(R.git(repo, ['config', '--get', 'core.hooksPath']).stdout.trim()).toBe('.githooks');
    expect(fs.existsSync(path.join(repo, '.githooks', 'commit-msg'))).toBe(false);
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
  });
});

describe('core.hooksPath', () => {
  sh('pointing at a tracked/project directory is refused and reported; nothing is written there', () => {
    fs.mkdirSync(path.join(repo, '.husky'));
    R.git(repo, ['config', 'core.hooksPath', '.husky']);
    const result = install();
    expect(result).toMatchObject({ status: 'blocked', active: false });
    expect(fs.readdirSync(path.join(repo, '.husky'))).toEqual([]);
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
    const text = result.problems.flat().join('\n');
    expect(text).toContain('core.hooksPath points to ".husky"');
    expect(text).toContain(hooks.ownerLine('pre-commit'));
    expect(text).toContain(hooks.ownerLine('commit-msg'));
    expect(hooks.isActive(repo)).toBe(false);
  });

  sh('an absolute path outside the repository is refused too', () => {
    const outside = tmp.mkdir('shared-hooks');
    R.git(repo, ['config', 'core.hooksPath', outside]);
    expect(install().status).toBe('blocked');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  sh('a directory inside the git dir is honoured: the hooks go where git runs them', () => {
    R.git(repo, ['config', 'core.hooksPath', '.git/our-hooks']);
    expect(install().status).toBe('installed');
    const dir = path.join(R.gitOut(repo, ['rev-parse', '--absolute-git-dir']), 'our-hooks');
    expect(fs.existsSync(path.join(dir, 'pre-commit'))).toBe(true);
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    expect(commitF(repo, 'feat: add config\n').status).not.toBe(0);
  });
});

describe('linked worktrees', () => {
  sh('a commit in a worktree runs the hooks installed once in the common dir, against the worktree tree', () => {
    install();
    const wt = path.join(tmp.root, 'wt');
    expect(R.git(repo, ['worktree', 'add', '-b', 'side', wt]).status).toBe(0);
    R.linkToolkit(wt);
    const before = R.commitCount(wt);

    R.stage(wt, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const blocked = commitF(wt, 'feat: add config\n');
    expect(blocked.status).not.toBe(0);
    expect(R.commitCount(wt)).toBe(before);

    R.git(wt, ['rm', '--cached', '-q', 'config.js']);
    R.stage(wt, 'ok.js', 'const y = 2;\n');
    const ok = commitF(wt, 'feat: add ok\n');
    expect(ok.status, ok.out).toBe(0);
    expect(R.commitCount(wt)).toBe(before + 1);
    expect(hooks.isActive(wt)).toBe(true);
  });

  sh('installing from inside a worktree writes into the common dir', () => {
    const wt = path.join(tmp.root, 'wt2');
    R.git(repo, ['worktree', 'add', '-b', 'side2', wt]);
    R.linkToolkit(wt);
    expect(install(wt).status).toBe('installed');
    expect(fs.existsSync(hookFile('pre-commit', repo))).toBe(true);
  });
});

describe('--remove', () => {
  sh('deletes marker hooks only and leaves everything else in the hooks dir', () => {
    install();
    fs.writeFileSync(hookFile('post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = hooks.removeHooks(repo);
    expect(result.status).toBe('removed');
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
    expect(fs.existsSync(hookFile('commit-msg'))).toBe(false);
    expect(fs.existsSync(hookFile('post-commit'))).toBe(true);
    expect(hooks.removeHooks(repo)).toMatchObject({ status: 'none', removed: [] });
  });

  sh('removes our hook and keeps a foreign one beside it', () => {
    install();
    fs.rmSync(hookFile('commit-msg'));
    fs.writeFileSync(hookFile('commit-msg'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    const result = hooks.removeHooks(repo);
    expect(result.removed.map(f => path.basename(f)).sort()).toEqual(hooks.HOOK_NAMES.filter(n => n !== 'commit-msg').sort());
    expect(result.kept.map(f => path.basename(f))).toEqual(['commit-msg']);
    expect(fs.readFileSync(hookFile('commit-msg'), 'utf8')).toContain('echo mine');
  });

  sh('re-install after remove is the same as a first install', () => {
    install();
    hooks.removeHooks(repo);
    expect(install()).toMatchObject({ status: 'installed', active: true });
  });

  sh('--dry-run removes nothing', () => {
    install();
    expect(hooks.removeHooks(repo, { dryRun: true }).status).toBe('dry-run');
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(true);
  });

  sh('also cleans <git dir>/hooks after core.hooksPath moved away from it', () => {
    install();
    fs.mkdirSync(path.join(repo, '.husky'));
    R.git(repo, ['config', 'core.hooksPath', '.husky']);
    expect(hooks.removeHooks(repo).removed).toHaveLength(hooks.HOOK_NAMES.length);
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
  });
});

describe('the CLI', () => {
  sh('--check exits 1 before the install and 0 after, and says why', () => {
    const before = R.runGitHooksCli(['--check'], repo);
    expect(before.status).toBe(1);
    expect(before.out).toMatch(/pre-commit: missing/);
    expect(before.out).toMatch(/NOT active/);
    expect(R.runGitHooksCli([], repo)).toMatchObject({ status: 0 });
    const after = R.runGitHooksCli(['--check'], repo);
    expect(after.status).toBe(0);
    expect(after.out).toMatch(/pre-commit: current/);
    expect(after.out).toMatch(/Git hooks: active/);
  });

  sh('install exits non-zero when a foreign hook leaves commits uncovered', () => {
    fs.writeFileSync(hookFile('pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = R.runGitHooksCli(['install'], repo);
    expect(r.status).toBe(1);
    expect(r.out).toContain(hooks.ownerLine('pre-commit'));
  });

  sh('--remove then --check reports not active', () => {
    R.runGitHooksCli([], repo);
    expect(R.runGitHooksCli(['--remove'], repo)).toMatchObject({ status: 0 });
    expect(R.runGitHooksCli(['--check'], repo).status).toBe(1);
  });

  it('rejects an unknown option', () => {
    expect(R.runGitHooksCli(['--frobnicate'], tmp.root).status).toBe(2);
  });
});

describe('ensureHooks (the install / update / uninstall wiring)', () => {
  sh('logs one summary line, installs without a prompt and reports problems under it', () => {
    const lines = [];
    const result = hooks.ensureHooks(repo, { log: l => lines.push(l) });
    expect(result.status).toBe('installed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Git hooks: wrote .* in \.git\/hooks$/);

    fs.rmSync(hookFile('pre-commit'));
    fs.writeFileSync(hookFile('pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const again = [];
    hooks.ensureHooks(repo, { log: l => again.push(l) });
    expect(again[0]).toMatch(/^Git hooks: /);
    expect(again.slice(1).join('\n')).toContain(hooks.ownerLine('pre-commit'));
  });

  sh('never throws, even when git itself fails', () => {
    const lines = [];
    expect(() => hooks.ensureHooks(path.join(tmp.root, 'missing-dir'), { log: l => lines.push(l) })).not.toThrow();
    expect(lines[0]).toMatch(/skipped/);
    const saved = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => hooks.ensureHooks(repo, { log: l => lines.push(l) })).not.toThrow();
    } finally { process.env.PATH = saved; }
  });

  sh('a dry run reports and writes nothing', () => {
    const lines = [];
    hooks.ensureHooks(repo, { dryRun: true, log: l => lines.push(l) });
    expect(lines[0]).toMatch(/\(dry run\)/);
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
  });

  it('is wired into install.js, template-updater.js and uninstall.js', () => {
    const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(read('install.js')).toMatch(/require\('\.\/git-hooks'\)\.ensureHooks\(verified\.target/);
    expect(read('template-updater.js')).toMatch(/require\('\.\/git-hooks'\)\.ensureHooks\(verified\.target/);
    expect(read('uninstall.js')).toMatch(/removeHooks\(plan\.target, \{ requireRoot: true \}\)/);
  });
});

describe('the hook text', () => {
  it('is the same in every repository and only contains LF', () => {
    for (const name of hooks.HOOK_NAMES) {
      const text = hooks.renderHook(name);
      expect(text).not.toMatch(/\r|[ \t]+\n/);
      expect(text.endsWith('\n')).toBe(true);
      expect(text).toContain('git rev-parse --show-toplevel');
      expect(text).toContain('.agents/hooks/secret-scanner.cjs');
      expect(text).toContain('node .agents/core/git-hooks.js --remove');
    }
    expect(hooks.renderHook('pre-commit')).toContain('--git-precommit');
    expect(hooks.renderHook('commit-msg')).toContain('--commit-msg "$msgfile"');
    expect(hooks.renderHook('pre-push')).toContain('--pre-push "$1" "$2"');
    for (const name of ['pre-merge-commit', 'pre-applypatch']) expect(hooks.renderHook(name)).toContain('--git-precommit');
    expect(() => hooks.renderHook('post-commit')).toThrow(/unknown hook/);
  });

  it.skipIf(isWin)('parses as POSIX sh', () => {
    for (const name of hooks.HOOK_NAMES) {
      const file = path.join(tmp.root, `syntax-${name}`);
      fs.writeFileSync(file, hooks.renderHook(name));
      const r = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
    }
  });

  it.skipIf(isWin || os.platform() === 'darwin')('the commit-msg shim fails closed when git passes no message file', () => {
    const file = path.join(tmp.root, 'commit-msg-hook');
    fs.writeFileSync(file, hooks.renderHook('commit-msg'), { mode: 0o755 });
    const r = spawnSync('sh', [file], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/passed no message file/);
  });
});
