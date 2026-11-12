// git-hooks.js and the hooks it installs: the regression tests for the deep code and security review of the
// managed git hooks (docs/.output/findings/reviews/261107-1900-git-hooks-{code,security}-review.md). Every
// describe is named by the finding it pins; each test fails without that finding's fix.
//
// Real git in temp repositories; `.agents` links to this toolkit (hook-repo.js) so the hooks run the real
// scanner and the real engine. Key-shaped fixtures are built from parts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { gitAvailable } = require('./_helpers/git-fixture');
const hooks = require('../git-hooks');
const R = require('./_helpers/hook-repo');

const isWin = process.platform === 'win32';
const sh = it.skipIf(!gitAvailable());
const shPosix = it.skipIf(!gitAvailable() || isWin);

let tmp;
let repo;
beforeEach(() => {
  tmp = createTmpDir({ prefix: 'git-hooks-review-' });
  if (gitAvailable()) {
    repo = R.createHookRepo(path.join(tmp.root, 'repo'));
    hooks.installHooks(repo);
  }
});
afterEach(() => tmp.cleanup());

let msgCounter = 0;
const gitDir = (dir = repo) => R.gitOut(dir, ['rev-parse', '--absolute-git-dir']);
const hookFile = (name, dir = repo) => path.join(gitDir(dir), 'hooks', name);
const commitF = (dir, text, env = {}, extra = []) => R.git(dir, ['commit', '-F', R.writeMessage(tmp.root, text, `MSG${++msgCounter}`), ...extra], { env });
const BYPASS = { CLAUDE_COMMIT_NO_SCAN: '1' };
const events = (dir = repo) => R.guardrailEvents(dir);
const count = (dir = repo) => R.commitCount(dir);
const keyFile = (rel = 'leak.txt') => R.stage(repo, rel, `k=${R.AWS_KEY}\n`);
/** Commit the staged key past the hooks (the audited bypass), the way a reviewed false positive or a plumbing path would. */
const bypassCommit = (text = 'chore: key\n') => {
  const r = commitF(repo, text, BYPASS);
  expect(r.status, r.out).toBe(0);
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-CRITICAL-1 / CR-M1: a staged name that looks like a revision is scanned as itself', () => {
  for (const prefix of ['0:', '1:', '2:', '3:', ':']) {
    // Git for Windows refuses a ':' in an index path (core.protectNTFS), so these names exist on POSIX only.
    shPosix(`a file named "${prefix}README" holding a key is blocked for the key (README is clean)`, () => {
      R.stage(repo, 'README', 'hello\n');
      R.stageBlob(repo, `${prefix}README`, `k=${R.AWS_KEY}\n`);
      const before = count();
      const r = commitF(repo, 'docs: readme\n');
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/AWS Access Key/);          // blocked for the KEY, not for an unreadable blob
      expect(r.out).not.toMatch(/could not read/);
      expect(count()).toBe(before);
    });
  }

  shPosix('commit.js without the hooks blocks the same staged name', () => {
    hooks.removeHooks(repo);
    R.stage(repo, 'README', 'hello\n');
    R.stageBlob(repo, '0:README', `k=${R.AWS_KEY}\n`);
    const before = count();
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'docs: readme\n'));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(count()).toBe(before);
  });

  shPosix('negative control: clean "0:README" and README commit normally', () => {
    R.stage(repo, 'README', 'hello\n');
    R.stageBlob(repo, '0:README', 'also clean\n');
    const r = commitF(repo, 'docs: readme\n');
    expect(r.status, r.out).toBe(0);
  });

  it('no scanner or commit.js code reads a blob by `:<path>` (the revision syntax parses a stage prefix)', () => {
    const files = ['hooks/secret-scanner.cjs', 'hooks/secret-git-scan.cjs', 'hooks/secret-engine.cjs', 'core/commit.js']
      .map(rel => [rel, fs.readFileSync(path.join(R.TOOLKIT_AGENTS, rel), 'utf8')]);
    for (const [rel, text] of files) {
      const code = text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(code, rel).not.toMatch(/['"`]:\$\{[^}]*(?:file|path|f)\}['"`]/);
      expect(code, rel).not.toMatch(/\bgit\b[^\n]*\bshow\b[^\n]*`:\$\{/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-MAJOR-1 / CR-M2: no environment variable redirects the repository a scan reads', () => {
  for (const variable of ['AGENTS_GIT_HOOK_ROOT', 'CLAUDE_PROJECT_DIR']) {
    sh(`${variable}=<clean decoy repo> cannot make commit.js (hooks inactive) commit a staged key`, () => {
      hooks.removeHooks(repo);
      const decoy = R.createHookRepo(path.join(tmp.root, 'decoy'));
      keyFile();
      const before = count();
      const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: x\n'), [], { [variable]: decoy });
      expect(r.status, r.out).not.toBe(0);
      expect(count()).toBe(before);
    });

    sh(`${variable}=<clean decoy repo> cannot make a raw git commit past the installed hooks`, () => {
      const decoy = R.createHookRepo(path.join(tmp.root, 'decoy'));
      keyFile();
      const before = count();
      const r = commitF(repo, 'feat: x\n', { [variable]: decoy });
      expect(r.status, r.out).not.toBe(0);
      expect(count()).toBe(before);
    });
  }

  sh('the scanner resolves the root from the working directory, also from a subdirectory', () => {
    keyFile();
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(repo, '.agents', 'hooks', 'secret-scanner.cjs'), '--git-precommit'], { cwd: sub, env: R.cleanEnv(repo), encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AWS Access Key/);
  });

  sh('outside a work tree every git mode fails closed', () => {
    const outside = tmp.mkdir('outside');
    for (const args of [['--git-precommit'], ['--pre-push', 'origin']]) {
      const r = spawnSync(process.execPath, [path.join(R.TOOLKIT_AGENTS, 'hooks', 'secret-scanner.cjs'), ...args], { cwd: outside, env: R.cleanEnv(outside), encoding: 'utf8', input: '' });
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/FAIL-CLOSED: not inside a git work tree/);
    }
  });

  it('AGENTS_GIT_HOOK_ROOT is gone from every source file', () => {
    for (const rel of ['hooks/secret-scanner.cjs', 'hooks/secret-git-scan.cjs', 'hooks/secret-engine.cjs', 'core/git-hooks.js', 'core/commit.js']) {
      const text = fs.readFileSync(path.join(R.TOOLKIT_AGENTS, rel), 'utf8');
      expect(text.split('\n').filter(l => /AGENTS_GIT_HOOK_ROOT/.test(l) && !/^\s*(\/\/|\*)/.test(l)), rel).toEqual([]);
    }
    expect(hooks.renderHook('pre-commit')).not.toContain('AGENTS_GIT_HOOK_ROOT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-MAJOR-2 / CR-M3 / CR-m5: one unforgeable audit record per bypassed commit', () => {
  sh('AGENTS_SCAN_BYPASS_RECORDED=1 hides nothing: the bypass is still recorded exactly once', () => {
    keyFile();
    const r = commitF(repo, 'feat: x\n', { ...BYPASS, AGENTS_SCAN_BYPASS_RECORDED: '1' });
    expect(r.status, r.out).toBe(0);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ decision: 'bypass', rule: 'git-hook-no-scan', source: 'secret-scanner' });
  });

  sh('a bypassed commit says "recorded" only because the write happened', () => {
    keyFile();
    const r = commitF(repo, 'feat: x\n', BYPASS);
    expect(r.out).toMatch(/recorded in guardrail-events\.jsonl/);
    expect(r.out).not.toMatch(/NOT recorded/);
  });

  sh('when the event cannot be written the message says NOT recorded (it never claims a record that is not there)', () => {
    keyFile();
    const notADir = path.join(tmp.root, 'file-not-dir');
    fs.writeFileSync(notADir, 'x');
    const r = commitF(repo, 'feat: x\n', { ...BYPASS, CLAUDE_PROJECT_DIR: notADir });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/NOT recorded: guardrail-events\.jsonl could not be written/);
    expect(r.out).not.toMatch(/recorded in guardrail-events/);
  });

  sh('code-review NIT: no marker is written when the event could not be written, so commit-msg never claims "already recorded"', () => {
    const notADir = path.join(tmp.root, 'file-not-dir');
    fs.writeFileSync(notADir, 'x');
    const env = R.cleanEnv(repo, { ...BYPASS, CLAUDE_PROJECT_DIR: notADir });
    const msg = R.writeMessage(tmp.root, 'x\n', 'M-NIT');
    const pre = spawnSync('sh', [hookFile('pre-commit')], { cwd: repo, env, encoding: 'utf8' });
    expect(pre.stderr).toMatch(/NOT recorded: guardrail-events\.jsonl could not be written/);
    expect(fs.existsSync(path.join(gitDir(), 'domdhi-bypass-marker.json'))).toBe(false);
    const post = spawnSync('sh', [hookFile('commit-msg'), msg], { cwd: repo, env, encoding: 'utf8' });
    expect(post.stderr).not.toMatch(/already recorded/);
    expect(post.stderr).toMatch(/NOT recorded/);
  });

  sh('a recorded pre-commit still writes the marker (the dedupe works)', () => {
    spawnSync('sh', [hookFile('pre-commit')], { cwd: repo, env: R.cleanEnv(repo, BYPASS), encoding: 'utf8' });
    expect(fs.existsSync(path.join(gitDir(), 'domdhi-bypass-marker.json'))).toBe(true);
  });

  sh('commit-msg alone (a reword: no pre-commit before it) records the bypass', () => {
    const msg = R.writeMessage(tmp.root, 'reword\n', 'REWORD');
    const r = spawnSync('sh', [hookFile('commit-msg'), msg], { cwd: repo, env: R.cleanEnv(repo, BYPASS), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ rule: 'git-hook-no-scan', patterns: ['commit-msg'] });
  });

  sh('pre-commit then commit-msg of one commit record once; a stale marker does not suppress a later record', () => {
    const msg = R.writeMessage(tmp.root, 'x\n', 'M1');
    const run = (name, args = []) => spawnSync('sh', [hookFile(name), ...args], { cwd: repo, env: R.cleanEnv(repo, BYPASS), encoding: 'utf8' });
    run('pre-commit');
    run('commit-msg', [msg]);
    expect(events()).toHaveLength(1);

    run('pre-commit');
    const markerFile = path.join(gitDir(), 'domdhi-bypass-marker.json');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    fs.writeFileSync(markerFile, JSON.stringify({ ...marker, at: Date.now() - 10 * 60 * 1000 }));
    run('commit-msg', [msg]);
    expect(events()).toHaveLength(3); // the second pre-commit (2) and the stale-marker commit-msg (3)
  });

  sh('a merge commit (pre-merge-commit + commit-msg) records once', () => {
    R.stage(repo, 'base.txt', 'base\n');
    bypassCommit('base\n');
    R.git(repo, ['checkout', '-q', '-b', 'side']);
    keyFile();
    bypassCommit('side key\n');
    R.git(repo, ['checkout', '-q', 'main']);
    R.stage(repo, 'other.txt', 'other\n');
    expect(commitF(repo, 'other\n').status).toBe(0);
    const before = events().length;
    const merged = R.git(repo, ['merge', '--no-ff', 'side', '-m', 'merge side'], { env: BYPASS });
    expect(merged.status, merged.out).toBe(0);
    expect(events().length - before).toBe(1);
  });

  sh('commit.js --no-scan with the hooks active adds no event of its own; the hooks record once', () => {
    keyFile();
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: x\n'), ['--no-scan']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/managed git hooks record the bypass/);
    expect(events().map(e => e.rule)).toEqual(['git-hook-no-scan']);
  });

  sh('commit.js --no-scan without the hooks records its own event and says so', () => {
    hooks.removeHooks(repo);
    keyFile();
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: x\n'), ['--no-scan']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/Recorded in guardrail-events\.jsonl/);
    expect(events().map(e => e.rule)).toEqual(['commit-no-scan']);
  });

  sh('commit.js says NOT recorded when its own event cannot be written', () => {
    hooks.removeHooks(repo);
    keyFile();
    const notADir = path.join(tmp.root, 'file-not-dir');
    fs.writeFileSync(notADir, 'x');
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: x\n'), ['--no-scan'], { CLAUDE_PROJECT_DIR: notADir });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/NOT recorded/);
  });

  it('AGENTS_SCAN_BYPASS_RECORDED is gone from every source file', () => {
    for (const rel of ['hooks/secret-scanner.cjs', 'core/commit.js', 'core/git-hooks.js']) {
      const text = fs.readFileSync(path.join(R.TOOLKIT_AGENTS, rel), 'utf8');
      expect(text.split('\n').filter(l => /AGENTS_SCAN_BYPASS_RECORDED/.test(l) && !/^\s*(\/\/|\*)/.test(l)), rel).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-MAJOR-3 / CR-m4: the shim trusts only a scanner that speaks the hook protocol', () => {
  // The scanner of a checkout whose toolkit predates the managed hooks: it knows no --hook-protocol or --commit-msg and,
  // handed stdin that is empty, exits 0 (it read the call as a Claude Write/Edit event).
  const OLD_SCANNER = "process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));\n";
  const protocolScanner = n => `if (process.argv.includes('--hook-protocol')) { console.log('domdhi-agents-hook-protocol ${n}'); process.exit(0); }\nprocess.exit(0);\n`;

  sh('an old scanner is refused: a key in the message is NOT committed, and the message names the options', () => {
    R.useScanner(repo, tmp.root, OLD_SCANNER);
    const before = count();
    const r = commitF(repo, `fix: rotate ${R.AWS_KEY}\n`, {}, ['--allow-empty']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/predates the managed git hooks/);
    expect(r.out).toMatch(/Merge or update the toolkit on this branch/);
    expect(r.out).toMatch(/CLAUDE_COMMIT_NO_SCAN=1/);
    expect(count()).toBe(before);
  });

  sh('a scanner that reports an older protocol is refused too', () => {
    R.useScanner(repo, tmp.root, protocolScanner(1));
    const r = commitF(repo, 'chore: x\n', {}, ['--allow-empty']);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/hook protocol 1, needs 2/);
  });

  sh('a scanner at or above the expected protocol is used', () => {
    R.useScanner(repo, tmp.root, protocolScanner(99));
    expect(commitF(repo, 'chore: x\n', {}, ['--allow-empty']).status).toBe(0);
  });

  sh('--check reports an old scanner as not active, and says why', () => {
    R.useScanner(repo, tmp.root, OLD_SCANNER);
    expect(hooks.scannerStatus(repo)).toBe('old');
    const state = hooks.inspectHooks(repo);
    expect(state.active).toBe(false);
    const r = R.runGitHooksCli(['--check'], repo);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/PREDATES the managed hooks/);
    expect(r.out).toMatch(/NOT active/);
  });

  sh('isActive is false for an old scanner, so commit.js scans the commit itself and blocks a key', () => {
    R.useScanner(repo, tmp.root, OLD_SCANNER);
    expect(hooks.isActive(repo)).toBe(false);
    keyFile();
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: x\n'));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
  });

  sh('install refuses to write hooks that an old scanner would leave blocking every commit', () => {
    hooks.removeHooks(repo);
    R.useScanner(repo, tmp.root, OLD_SCANNER);
    const result = hooks.installHooks(repo);
    expect(result).toMatchObject({ status: 'blocked', active: false });
    expect(result.summary).toMatch(/predates the managed hooks/);
    expect(fs.existsSync(hookFile('pre-commit'))).toBe(false);
  });

  sh('the bypass works with an old scanner and says it could not record', () => {
    R.useScanner(repo, tmp.root, OLD_SCANNER);
    const r = commitF(repo, 'chore: x\n', BYPASS, ['--allow-empty']);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/bypass was NOT recorded/);
    expect(events()).toEqual([]);
  });

  sh('the real scanner prints exactly one protocol line, and rejects an unknown flag instead of reading it as a Claude hook', () => {
    const scanner = path.join(R.TOOLKIT_AGENTS, 'hooks', 'secret-scanner.cjs');
    const proto = spawnSync(process.execPath, [scanner, '--hook-protocol'], { encoding: 'utf8' });
    expect(proto.stdout).toBe('domdhi-agents-hook-protocol 2\n');
    const unknown = spawnSync(process.execPath, [scanner, '--commit-mgs', 'x'], { encoding: 'utf8', input: '' });
    expect(unknown.status).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-MAJOR-4: the commit paths beyond `git commit`', () => {
  const sideBranchWithKey = () => {
    R.stage(repo, 'base.txt', 'base\n');
    expect(commitF(repo, 'base\n').status).toBe(0);
    R.git(repo, ['checkout', '-q', '-b', 'side']);
    keyFile();
    bypassCommit('side: key\n');
    R.git(repo, ['checkout', '-q', 'main']);
  };

  sh('pre-merge-commit: a merge that brings in a key is blocked and creates no commit', () => {
    sideBranchWithKey();
    R.stage(repo, 'other.txt', 'other\n');
    expect(commitF(repo, 'other\n').status).toBe(0);
    const before = count();
    const r = R.git(repo, ['merge', '--no-ff', 'side', '-m', 'merge side']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(count()).toBe(before);
    R.git(repo, ['merge', '--abort']);
  });

  sh('pre-applypatch: git am of a patch that adds a key is blocked', () => {
    sideBranchWithKey();
    const patch = path.join(tmp.root, 'key.patch');
    fs.writeFileSync(patch, R.git(repo, ['format-patch', '-1', 'side', '--stdout']).stdout);
    const before = count();
    const r = R.git(repo, ['am', patch]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(count()).toBe(before);
    R.git(repo, ['am', '--abort']);
  });

  sh('pre-applypatch lets a clean patch through', () => {
    R.stage(repo, 'base.txt', 'base\n');
    expect(commitF(repo, 'base\n').status).toBe(0);
    R.git(repo, ['checkout', '-q', '-b', 'clean']);
    R.stage(repo, 'ok.txt', 'ok\n');
    expect(commitF(repo, 'ok\n').status).toBe(0);
    R.git(repo, ['checkout', '-q', 'main']);
    const patch = path.join(tmp.root, 'ok.patch');
    fs.writeFileSync(patch, R.git(repo, ['format-patch', '-1', 'clean', '--stdout']).stdout);
    const r = R.git(repo, ['am', patch]);
    expect(r.status, r.out).toBe(0);
  });

  describe('pre-push: the backstop for every commit that ran no hook', () => {
    let remote;
    beforeEach(() => {
      if (!gitAvailable()) return;
      remote = R.addRemote(repo, tmp.root);
      R.stage(repo, 'base.txt', 'base\n');
      expect(commitF(repo, 'base\n').status).toBe(0);
      const first = R.git(repo, ['push', '-q', '-u', 'origin', 'main']);
      expect(first.status, first.out).toBe(0);
    });
    const remoteHead = () => R.gitOut(remote, ['rev-parse', 'main']);

    sh('a clean push passes and publishes', () => {
      R.stage(repo, 'ok.txt', 'ok\n');
      expect(commitF(repo, 'ok\n').status).toBe(0);
      const r = R.git(repo, ['push', 'origin', 'main']);
      expect(r.status, r.out).toBe(0);
      expect(remoteHead()).toBe(R.gitOut(repo, ['rev-parse', 'main']));
    });

    sh('a bypassed commit holding a key cannot be pushed', () => {
      keyFile();
      bypassCommit();
      const before = remoteHead();
      const r = R.git(repo, ['push', 'origin', 'main']);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/AWS Access Key/);
      expect(r.out).toMatch(/leak\.txt \(commit [0-9a-f]{12}\)/);
      expect(r.out).not.toContain(R.AWS_KEY);
      expect(remoteHead()).toBe(before);
    });

    sh('commit-tree + update-ref (no hook at all) is caught at push', () => {
      R.stageBlob(repo, 'plumbing.txt', `k=${R.AWS_KEY}\n`);
      const tree = R.gitOut(repo, ['write-tree']);
      const commit = R.gitOut(repo, ['commit-tree', tree, '-p', 'HEAD', '-m', 'plumbing']);
      R.git(repo, ['update-ref', 'refs/heads/main', commit]);
      const before = remoteHead();
      const r = R.git(repo, ['push', 'origin', 'main']);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/AWS Access Key/);
      expect(remoteHead()).toBe(before);
    });

    sh('cherry-pick of a commit with a key is caught at push', () => {
      R.git(repo, ['checkout', '-q', '-b', 'side']);
      keyFile();
      bypassCommit('side key\n');
      R.git(repo, ['checkout', '-q', 'main']);
      const picked = R.git(repo, ['cherry-pick', 'side']);
      expect(picked.status, picked.out).toBe(0);
      const r = R.git(repo, ['push', 'origin', 'main']);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/AWS Access Key/);
    });

    sh('stash + fast-forward merge (no hook) is caught at push', () => {
      keyFile();
      R.git(repo, ['stash', '-q']);
      const ff = R.git(repo, ['merge', '--ff-only', 'stash@{0}']);
      expect(ff.status, ff.out).toBe(0);
      const r = R.git(repo, ['push', 'origin', 'main']);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/AWS Access Key/);
    });

    sh('a key in the message of a pushed commit is caught', () => {
      const tree = R.gitOut(repo, ['write-tree']);
      const commit = R.gitOut(repo, ['commit-tree', tree, '-p', 'HEAD', '-m', `rotate ${R.AWS_KEY}`]);
      R.git(repo, ['update-ref', 'refs/heads/main', commit]);
      const r = R.git(repo, ['push', 'origin', 'main']);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/<commit message of [0-9a-f]{12}>/);
      expect(r.out).not.toContain(R.AWS_KEY);
    });

    sh('only commits the remote lacks are scanned: an old key already on the remote does not block a clean push', () => {
      keyFile();
      bypassCommit();
      const pushedWithBypass = R.git(repo, ['push', 'origin', 'main'], { env: BYPASS });
      expect(pushedWithBypass.status, pushedWithBypass.out).toBe(0);
      expect(events().map(e => (e.patterns || [])[0])).toContain('pre-push');
      R.stage(repo, 'ok.txt', 'ok\n');
      expect(commitF(repo, 'ok\n').status).toBe(0);
      const r = R.git(repo, ['push', 'origin', 'main']);
      expect(r.status, r.out).toBe(0);
    });

    sh('a deletion push publishes nothing and passes', () => {
      R.git(repo, ['branch', 'gone']);
      expect(R.git(repo, ['push', '-q', 'origin', 'gone']).status).toBe(0);
      const r = R.git(repo, ['push', 'origin', ':gone']);
      expect(r.status, r.out).toBe(0);
    });

    sh('a pushed tag is scanned through the commits it publishes', () => {
      keyFile();
      bypassCommit();
      R.git(repo, ['tag', 'v1']);
      const r = R.git(repo, ['push', 'origin', 'v1']);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/AWS Access Key/);
    });

    sh('.betterleaksignore is read from the commit that introduced the blob', () => {
      // The ignore file and the key arrive together: reviewed in the same commit, so the push passes.
      R.stage(repo, '.betterleaksignore', 'leak.txt:domdhi-aws-access-key:1\n');
      keyFile();
      expect(commitF(repo, 'chore: reviewed false positive\n').status).toBe(0);
      expect(R.git(repo, ['push', 'origin', 'main']).status).toBe(0);
    });

    sh('an ignore file added in a LATER commit does not excuse an earlier commit that lacked it', () => {
      keyFile();
      bypassCommit('chore: key\n');
      R.stage(repo, '.betterleaksignore', 'leak.txt:domdhi-aws-access-key:1\n');
      expect(commitF(repo, 'chore: ignore it\n').status).toBe(0);
      const r = R.git(repo, ['push', 'origin', 'main']);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/AWS Access Key/);
    });

    // ── a reviewed VALUE already in unpushed history: value-sha256 in the TIP's .betterleaksignore ──────────
    describe('value-sha256 entries in the pushed tip cover one reviewed value anywhere in the push', () => {
      // A generic match (no provider prefix), the shape of a reviewed public key; built from parts.
      const PUB = ['Zk3', 'pQ9xL2mN7vB4cR8tY1wE6', 'uI0oP5aS3dF9gH2jK7lZ4x='].join('');
      const PUB2 = ['Qw8', 'rT5yU2iO9pA4sD7fG1hJ3', 'kL6zX0cV8bN5mQ2wE9rT4y='].join('');
      const valueKey = v => `value-sha256:${crypto.createHash('sha256').update(v, 'utf8').digest('hex')}`;
      const commitValue = (rel, value, msg) => {
        R.stage(repo, rel, `key = "${value}"\n`);
        bypassCommit(msg);
      };
      const allowInTip = text => {
        R.stage(repo, '.betterleaksignore', text);
        const r = commitF(repo, 'chore: owner-reviewed value\n');
        expect(r.status, r.out).toBe(0);
      };

      sh('an older commit introduced the value; the tip pins its hash: the push passes', () => {
        commitValue('deploy/install.sh', PUB, 'feat: installer\n');
        commitValue('deploy/install.ps1', PUB, 'feat: windows installer\n');
        R.stage(repo, 'ok.txt', 'ok\n');
        expect(commitF(repo, 'ok\n').status).toBe(0);
        allowInTip(`${valueKey(PUB)} # RustDesk-style server public key, reviewed by the owner\n`);
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).toBe(0);
        expect(R.gitOut(remote, ['rev-parse', 'main'])).toBe(R.gitOut(repo, ['rev-parse', 'HEAD']));
      });

      sh('the block report prints the value hash for a generic finding, never the value', () => {
        commitValue('deploy/install.sh', PUB, 'feat: installer\n');
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toContain(`Allow: ${valueKey(PUB)}`);
        expect(r.out).toMatch(/value-sha256:<hash>/);
        expect(r.out).not.toContain(PUB);
      });

      sh('a different value in the same range still blocks, and only it is reported', () => {
        commitValue('deploy/install.sh', PUB, 'feat: installer\n');
        commitValue('deploy/other.sh', PUB2, 'feat: other\n');
        allowInTip(`${valueKey(PUB)}\n`);
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toContain(`Allow: ${valueKey(PUB2)}`);
        expect(r.out).not.toContain(`Allow: ${valueKey(PUB)}`);
        expect(r.out).toMatch(/deploy\/other\.sh/);
      });

      sh('a prefix or malformed hash in the tip allows nothing', () => {
        commitValue('deploy/install.sh', PUB, 'feat: installer\n');
        const full = valueKey(PUB);
        allowInTip(`${full.slice(0, full.length - 1)}\n${full}0\n${full.slice(0, 30)}\n`);
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toContain(`Allow: ${full}`);
      });

      sh('a value hash committed BEFORE the tip and removed again does not count (only the tip list does)', () => {
        commitValue('deploy/install.sh', PUB, 'feat: installer\n');
        allowInTip(`${valueKey(PUB)}\n`);
        R.git(repo, ['rm', '-q', '.betterleaksignore']);
        expect(commitF(repo, 'chore: drop the list\n').status).toBe(0);
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).not.toBe(0);
      });

      sh('two pushed refs: an entry counts only when every tip lists it', () => {
        commitValue('deploy/install.sh', PUB, 'feat: installer\n');
        R.git(repo, ['branch', 'side']);
        allowInTip(`${valueKey(PUB)}\n`);
        const both = R.git(repo, ['push', 'origin', 'main', 'side']);
        expect(both.status, both.out).not.toBe(0);
        const mainOnly = R.git(repo, ['push', 'origin', 'main']);
        expect(mainOnly.status, mainOnly.out).toBe(0);
      });

      sh('a value hash does not excuse a key in a commit message', () => {
        const tree = R.gitOut(repo, ['write-tree']);
        const commit = R.gitOut(repo, ['commit-tree', tree, '-p', 'HEAD', '-m', `rotate ${R.AWS_KEY}`]);
        R.git(repo, ['update-ref', 'refs/heads/main', commit]);
        allowInTip(`${valueKey(R.AWS_KEY)}\n`);
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/<commit message of [0-9a-f]{12}>/);
      });

      sh('path:rule:line entries keep per-commit semantics: in the tip only, they do not reach older commits', () => {
        R.stage(repo, 'deploy/install.sh', `key = "${PUB}"\n`);
        bypassCommit('feat: installer\n');
        allowInTip('deploy/install.sh:generic-api-key:1\n');
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/deploy\/install\.sh/);
      });
    });

    sh('CLAUDE_COMMIT_NO_SCAN=1 on the push is the audited bypass for the push scan, recorded', () => {
      keyFile();
      bypassCommit();
      const before = events().length;
      const r = R.git(repo, ['push', 'origin', 'main'], { env: BYPASS });
      expect(r.status, r.out).toBe(0);
      expect(events().length - before).toBe(1);
      expect(events().pop()).toMatchObject({ rule: 'git-hook-no-scan', patterns: ['pre-push'] });
    });

    // ── NEW-1 (closure pass): the push scan lists OBJECTS, and trusts only what the remote vouches for ──────
    describe('NEW-1: tags, trees, blobs and forged remote-tracking refs', () => {
      const tagFile = text => R.writeMessage(tmp.root, text, `TAG${++msgCounter}`);
      const blobWithKey = () => R.gitOut(repo, ['hash-object', '-w', R.writeMessage(tmp.root, `k=${R.AWS_KEY}\n`, 'KEYBLOB')]);
      const remoteRefs = () => R.gitOut(remote, ['for-each-ref', '--format=%(refname)']);

      sh('a tag that points straight at a blob holding a key is blocked, and nothing reaches the remote', () => {
        R.git(repo, ['tag', 'blobtag', blobWithKey()]);
        const r = R.git(repo, ['push', 'origin', 'blobtag']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/AWS Access Key/);
        expect(r.out).toMatch(/pushed object [0-9a-f]{12}/);
        expect(r.out).not.toContain(R.AWS_KEY);
        expect(remoteRefs()).not.toMatch(/blobtag/);
      });

      sh('a tag that points at a tree holding a key is blocked', () => {
        R.stageBlob(repo, 'inside/leak.txt', `k=${R.AWS_KEY}\n`);
        R.git(repo, ['tag', 'treetag', R.gitOut(repo, ['write-tree'])]);
        const r = R.git(repo, ['push', 'origin', 'treetag']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/AWS Access Key/);
        expect(r.out).toMatch(/inside\/leak\.txt \(pushed object/);
        expect(remoteRefs()).not.toMatch(/treetag/);
      });

      sh('an annotated tag on a blob, and an annotated tag on that tag (nested), are blocked', () => {
        const blob = blobWithKey();
        R.git(repo, ['tag', '-a', 'inner', '-m', 'inner', blob]);
        R.git(repo, ['tag', '-a', 'outer', '-m', 'outer', 'refs/tags/inner']);
        for (const name of ['inner', 'outer']) {
          const r = R.git(repo, ['push', 'origin', name]);
          expect(r.status, `${name}: ${r.out}`).not.toBe(0);
          expect(r.out, name).toMatch(/AWS Access Key/);
        }
        expect(remoteRefs()).not.toMatch(/inner|outer/);
      });

      sh('an annotated tag whose MESSAGE carries a key is blocked (a clean commit underneath)', () => {
        R.git(repo, ['tag', '-a', 'v1', '-F', tagFile(`release notes\n\nrotated ${R.AWS_KEY}\n`), 'HEAD']);
        const r = R.git(repo, ['push', 'origin', 'v1']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/<tag message of [0-9a-f]{12}>/);
        expect(r.out).not.toContain(R.AWS_KEY);
        expect(remoteRefs()).not.toMatch(/v1/);
      });

      sh('a clean annotated tag, a clean tag on a blob and a clean tag on a tree push normally', () => {
        R.git(repo, ['tag', '-a', 'ok', '-m', 'a clean release', 'HEAD']);
        const cleanBlob = R.gitOut(repo, ['hash-object', '-w', R.writeMessage(tmp.root, 'clean\n', 'CLEANBLOB')]);
        R.git(repo, ['tag', 'cleanblob', cleanBlob]);
        R.git(repo, ['tag', 'cleantree', 'HEAD^{tree}']);
        const r = R.git(repo, ['push', 'origin', 'ok', 'cleanblob', 'cleantree']);
        expect(r.status, r.out).toBe(0);
      });

      sh('a commit hidden behind a FORGED remote-tracking ref (git fetch . main:refs/remotes/origin/hide) is still scanned', () => {
        keyFile();
        R.git(repo, ['stash', '-q']);
        expect(R.git(repo, ['merge', '--ff-only', 'stash@{0}']).status).toBe(0);
        const forged = R.git(repo, ['fetch', '-q', '.', 'main:refs/remotes/origin/hide']);
        expect(forged.status, forged.out).toBe(0);
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/AWS Access Key/);
        expect(R.gitOut(remote, ['rev-parse', 'main'])).not.toBe(R.gitOut(repo, ['rev-parse', 'main']));
      });

      sh('the same with update-ref, and with the ref named for the pushed remote', () => {
        const tree = R.gitOut(repo, ['write-tree']);
        R.stageBlob(repo, 'plumbing.txt', `k=${R.AWS_KEY}\n`);
        const commit = R.gitOut(repo, ['commit-tree', R.gitOut(repo, ['write-tree']), '-p', 'HEAD', '-m', 'plumbing']);
        expect(tree).toBeTruthy();
        R.git(repo, ['update-ref', 'refs/heads/main', commit]);
        R.git(repo, ['update-ref', 'refs/remotes/origin/main', commit]);
        R.git(repo, ['update-ref', 'refs/remotes/origin/HEAD', commit]);
        const r = R.git(repo, ['push', 'origin', 'main']);
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/AWS Access Key/);
      });

      sh('what the remote advertises is vouched for: a new branch on top of a commit origin already holds is not rescanned', () => {
        keyFile();
        bypassCommit();
        expect(R.git(repo, ['push', 'origin', 'main'], { env: BYPASS }).status).toBe(0);   // the key commit is on the remote now
        R.git(repo, ['checkout', '-q', '-b', 'feature']);
        R.stage(repo, 'ok.txt', 'ok\n');
        expect(commitF(repo, 'ok\n').status).toBe(0);
        const r = R.git(repo, ['push', 'origin', 'feature']);                               // no remote sha on stdin: ls-remote vouches for main
        expect(r.status, r.out).toBe(0);
      });

      sh('when the remote cannot be asked nothing extra is excluded: the history is scanned, never skipped', () => {
        const gitScan = require('../../hooks/secret-git-scan.cjs');
        expect(gitScan.remoteAdvertised(repo, path.join(tmp.root, 'no-such-remote.git'))).toBeNull();
        keyFile();
        bypassCommit();
        const head = R.gitOut(repo, ['rev-parse', 'HEAD']);
        const scan = gitScan.scanPush(repo, 'origin', path.join(tmp.root, 'no-such-remote.git'), [{ localRef: 'refs/heads/main', localSha: head, remoteRef: 'refs/heads/main', remoteSha: '0'.repeat(40) }]);
        const found = scan.order.flatMap(rel => scan.results.get(rel).findings || []);
        expect(found.map(f => f.name)).toContain('AWS Access Key');
      });

      // ── NEW-2: `ls-remote` applies url.<base>.insteadOf rewriting that the push can sidestep (an identity
      // pushInsteadOf). The decoy repository below holds the secret commit, so asking IT "vouches" for the commit
      // while the push goes to the real remote. The advertisement is used only when ls-remote contacts the push URL.
      describe('NEW-2: a decoy that ls-remote is redirected to must not vouch for the secret commit', () => {
        const secretCommitAndDecoy = () => {
          keyFile();
          R.git(repo, ['stash', '-q']);
          expect(R.git(repo, ['merge', '--ff-only', 'stash@{0}']).status).toBe(0);   // a key commit no commit hook ever saw
          const decoy = path.join(tmp.root, 'decoy.git');
          R.git(tmp.root, ['init', '-q', '--bare', '-b', 'main', decoy]);
          expect(R.git(decoy, ['fetch', '-q', repo, 'main:refs/heads/main']).status).toBe(0);
          return { decoy, keyCommit: R.gitOut(repo, ['rev-parse', 'HEAD']) };
        };
        const remoteHasObject = sha => R.git(remote, ['cat-file', '-e', sha]).status === 0;

        sh('q05, inline -c insteadOf + identity pushInsteadOf: the push exits non-zero and the remote never receives the key', () => {
          const { decoy, keyCommit } = secretCommitAndDecoy();
          const before = remoteHead();
          const r = R.git(repo, ['-c', `url.${decoy}.insteadOf=${remote}`, '-c', `url.${remote}.pushInsteadOf=${remote}`, 'push', 'origin', 'main']);
          expect(r.status, r.out).not.toBe(0);
          expect(r.out).toMatch(/AWS Access Key/);
          expect(remoteHead()).toBe(before);
          expect(remoteHasObject(keyCommit)).toBe(false);
        });

        sh('q04, the same rewriting in persistent config (git config url...): blocked, the remote never receives the key', () => {
          const { decoy, keyCommit } = secretCommitAndDecoy();
          R.git(repo, ['config', `url.${decoy}.insteadOf`, remote]);
          R.git(repo, ['config', `url.${remote}.pushInsteadOf`, remote]);
          const before = remoteHead();
          const r = R.git(repo, ['push', 'origin', 'main']);
          expect(r.status, r.out).not.toBe(0);
          expect(r.out).toMatch(/AWS Access Key/);
          expect(remoteHead()).toBe(before);
          expect(remoteHasObject(keyCommit)).toBe(false);
        });

        sh('control: without any rewriting the same push is blocked too (the decoy changes nothing), and with a clean commit it passes', () => {
          const { keyCommit } = secretCommitAndDecoy();
          expect(R.git(repo, ['push', 'origin', 'main']).status).not.toBe(0);
          expect(remoteHasObject(keyCommit)).toBe(false);
          R.git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
          R.stage(repo, 'ok.txt', 'ok\n');
          expect(commitF(repo, 'ok\n').status).toBe(0);
          const clean = R.git(repo, ['-c', `url.${remote}.pushInsteadOf=${remote}`, 'push', 'origin', 'main']);
          expect(clean.status, clean.out).toBe(0);                                  // an identity pushInsteadOf on its own is harmless
        });

        sh('remoteAdvertised answers only when ls-remote provably contacts the pushed URL', () => {
          const gitScan = require('../../hooks/secret-git-scan.cjs');
          const advertised = gitScan.remoteAdvertised(repo, remote);
          expect(advertised).toContain(R.gitOut(remote, ['rev-parse', 'main']));    // plain: trusted
          expect(gitScan.remoteAdvertised(repo, '')).toBeNull();                      // no URL (a remote NAME is not enough)
          expect(gitScan.remoteAdvertised(repo, 'origin')).toBeNull();                // a name resolves to its fetch URL: doubt
          R.git(repo, ['config', `url.${path.join(tmp.root, 'elsewhere.git')}.insteadOf`, remote]);
          expect(gitScan.remoteAdvertised(repo, remote)).toBeNull();                  // rewritten: ignored
        });

        sh('a rewritten URL costs a longer scan, never a skipped one: an unrelated clean push still goes through', () => {
          R.git(repo, ['config', `url.${path.join(tmp.root, 'elsewhere.git')}.insteadOf`, remote]);
          R.git(repo, ['config', `url.${remote}.pushInsteadOf`, remote]);
          R.stage(repo, 'ok.txt', 'ok\n');
          expect(commitF(repo, 'ok\n').status).toBe(0);
          const r = R.git(repo, ['push', 'origin', 'main']);
          expect(r.status, r.out).toBe(0);
        });
      });

      // ── BINARY-HISTORY: found by a real-size push (1,843 commits, 40,538 objects): three versions of one .xlsx, an
      // OOXML zip of ~80 KB, made the engine quit on its signature while the parent was still writing (EPIPE), and
      // the whole push failed closed with "secret engine could not run". A binary is scanned through its printable
      // strings; it is never skipped, and it never fails a push by itself.
      describe('BINARY-HISTORY: a history full of images, PDFs, spreadsheets and archives', () => {
        const history = (key) => R.fastImport(repo, [
          { message: 'add the logo and the spec\n', files: { 'assets/logo.png': R.makePng({ text: 'logo', padBytes: 70000, seed: 11 }), 'docs/spec.pdf': R.makePdf({ text: 'spec', padBytes: 90000, seed: 12 }) } },
          { message: 'add the budget template\n', files: { 'src/public/downloads/budget.xlsx': R.makeXlsxLike({ text: key ? `token=${R.AWS_KEY}` : 'quarterly budget', padBytes: 120000, seed: 13 }) } },
          { message: 'add the data archive\n', files: { 'archives/data.zip': R.makeZip({ 'readme.txt': 'plain archive', 'blob.bin': R.noise(100000, 14) }), 'README.md': '# project\n' } },
          { message: 'update the budget template\n', files: { 'src/public/downloads/budget.xlsx': R.makeXlsxLike({ text: key ? `token=${R.AWS_KEY}` : 'quarterly budget v2', padBytes: 130000, seed: 15 }) } },
        ], { branch: 'bin' });

        sh('a key in the printable strings of one binary blocks the push, names the rule and the path, and publishes nothing', () => {
          history(true);
          const r = R.git(repo, ['push', 'origin', 'bin']);
          expect(r.status, r.out).not.toBe(0);
          expect(r.out).toMatch(/AWS Access Key/);
          expect(r.out).toMatch(/src\/public\/downloads\/budget\.xlsx \(commit [0-9a-f]{12}\)/);
          expect(r.out).not.toMatch(/could not run|EPIPE/);
          expect(r.out).not.toContain(R.AWS_KEY);
          expect(R.git(remote, ['rev-parse', '--verify', '-q', 'refs/heads/bin']).status).not.toBe(0);
        });

        sh('the same history without the key pushes (the spreadsheets are far bigger than a pipe, the case that failed)', () => {
          history(false);
          const r = R.git(repo, ['push', 'origin', 'bin']);
          expect(r.status, r.out).toBe(0);
          expect(R.git(remote, ['rev-parse', '--verify', '-q', 'refs/heads/bin']).status).toBe(0);
        });

        // Text that merely STARTS with a signature the engine refuses, and is bigger than a pipe: it is not a binary
        // (it keeps its real line numbers through the shifted rescan), and the engine quitting on its signature used
        // to raise EPIPE out of the per-file scan and fail the whole push.
        const bigSignedText = key => `%PDF-1.4 release notes\n${'a line of release notes\n'.repeat(8000)}${key ? `token=${R.AWS_KEY}\n` : 'the end\n'}`;

        sh('a big TEXT file that starts with a refused signature, key on its last line: blocked, on the real line', () => {
          R.fastImport(repo, [{ message: 'notes\n', files: { 'notes/release.txt': bigSignedText(true) } }], { branch: 'signed' });
          const r = R.git(repo, ['push', 'origin', 'signed']);
          expect(r.status, r.out).not.toBe(0);
          expect(r.out).toMatch(/AWS Access Key/);
          expect(r.out).toMatch(/notes\/release\.txt \(commit [0-9a-f]{12}\):8002/);
          expect(r.out).not.toMatch(/could not run|EPIPE/);
        });

        sh('the same file without the key pushes', () => {
          R.fastImport(repo, [{ message: 'notes\n', files: { 'notes/release.txt': bigSignedText(false) } }], { branch: 'signed' });
          const r = R.git(repo, ['push', 'origin', 'signed']);
          expect(r.status, r.out).toBe(0);
        });

        sh('a binary committed past the hooks (the audited bypass) is still caught at the push', () => {
          R.stage(repo, 'src/budget.xlsx', R.makeXlsxLike({ text: `token=${R.AWS_KEY}`, padBytes: 100000, seed: 21 }));
          expect(commitF(repo, 'chore: budget\n', BYPASS).status).toBe(0);
          const r = R.git(repo, ['push', 'origin', 'main']);
          expect(r.status, r.out).not.toBe(0);
          expect(r.out).toMatch(/AWS Access Key/);
        });

        sh('a staged binary is scanned at commit time too (no "is binary — skipping"), clean and with a key', () => {
          fs.writeFileSync(path.join(repo, 'clean.xlsx'), R.makeXlsxLike({ text: 'clean', padBytes: 100000, seed: 22 }));
          R.git(repo, ['add', 'clean.xlsx']);
          expect(commitF(repo, 'chore: clean sheet\n').status).toBe(0);
          fs.writeFileSync(path.join(repo, 'leaky.xlsx'), R.makeXlsxLike({ text: `token=${R.AWS_KEY}`, padBytes: 100000, seed: 23 }));
          R.git(repo, ['add', 'leaky.xlsx']);
          const r = commitF(repo, 'chore: leaky sheet\n');
          expect(r.status, r.out).not.toBe(0);
          expect(r.out).toMatch(/AWS Access Key/);
          expect(r.out).toMatch(/leaky\.xlsx/);
        });

        sh('a real-scale history (2,000 commits, a binary every tenth) is scanned in a bounded number of engine runs: seconds, not minutes', () => {
          const kinds = [
            (i) => ['xlsx', R.makeXlsxLike({ text: `sheet ${i}`, padBytes: 60000, seed: i + 1 })],
            (i) => ['pdf', R.makePdf({ text: `doc ${i}`, padBytes: 50000, seed: i + 1 })],
            (i) => ['png', R.makePng({ text: `img ${i}`, padBytes: 40000, seed: i + 1 })],
            (i) => ['zip', R.makeZip({ 'a.txt': `archive ${i}`, 'b.bin': R.noise(40000, i + 1) })],
          ];
          const commits = [];
          for (let i = 1; i <= 2000; i++) {
            const files = { [`src/mod${i % 40}/file${i}.js`]: `export const n${i} = ${i};\n${'// filler\n'.repeat(20)}`, [`docs/note${i}.md`]: `# note ${i}\n` };
            if (i % 10 === 0) { const [ext, data] = kinds[(i / 10) % kinds.length](i); files[`assets/v${i}/file.${ext}`] = data; }
            commits.push({ message: `commit ${i}\n`, files });
          }
          R.fastImport(repo, commits, { branch: 'scale' });
          const started = Date.now();
          const r = R.git(repo, ['push', 'origin', 'scale']);
          const elapsed = Date.now() - started;
          expect(r.status, r.out).toBe(0);
          expect(elapsed).toBeLessThan(90000);
          expect(R.git(remote, ['rev-parse', '--verify', '-q', 'refs/heads/scale']).status).toBe(0);

          // ...and a key hidden in the printable strings of ONE more binary is found in that same big range
          R.fastImport(repo, [{ message: 'one more\n', files: { 'assets/late/budget.xlsx': R.makeXlsxLike({ text: `token=${R.AWS_KEY}`, padBytes: 60000, seed: 7 }) } }], { branch: 'scale', from: R.gitOut(repo, ['rev-parse', 'refs/heads/scale']) });
          const blocked = R.git(repo, ['push', 'origin', 'scale']);
          expect(blocked.status, blocked.out).not.toBe(0);
          expect(blocked.out).toMatch(/assets\/late\/budget\.xlsx/);
        }, 240000);
      });

      sh('a pushed id that is not in this repository fails the push closed', () => {
        const r = spawnSync(process.execPath, [path.join(repo, '.agents', 'hooks', 'secret-scanner.cjs'), '--pre-push', 'origin', remote], {
          cwd: repo, env: R.cleanEnv(repo), encoding: 'utf8', input: `refs/heads/x ${'a'.repeat(40)} refs/heads/x ${'0'.repeat(40)}\n`,
        });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/FAIL-CLOSED: the commits to push could not be scanned/);
      });

      sh('a long history is scanned whole in one pass, and a key at the very end is found (300 commits, 900 files)', () => {
        const stream = [];
        const add = text => stream.push(text);
        let prev = null;
        for (let i = 1; i <= 300; i++) {
          const files = [0, 1, 2].map(j => `lib/c${i}/f${j}.txt`);
          add(`commit refs/heads/long\nmark :${i}\ncommitter T <t@example.invalid> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(`commit ${i}\n`)}\ncommit ${i}\n`);
          if (prev) add(`from :${prev}\n`); else add(`from ${R.gitOut(repo, ['rev-parse', 'HEAD'])}\n`);
          for (const f of files) { const body = i === 300 && f.endsWith('f2.txt') ? `k=${R.AWS_KEY}\n` : `content of ${f}\n`; add(`M 100644 inline ${f}\ndata ${Buffer.byteLength(body)}\n${body}\n`); }
          prev = i;
        }
        const imported = spawnSync('git', ['fast-import', '--quiet'], { cwd: repo, input: stream.join(''), encoding: 'utf8', env: R.cleanEnv(repo) });
        expect(imported.status, imported.stderr).toBe(0);
        const started = Date.now();
        const r = R.git(repo, ['push', 'origin', 'long']);
        const elapsed = Date.now() - started;
        expect(r.status, r.out).not.toBe(0);
        expect(r.out).toMatch(/AWS Access Key/);
        expect(r.out).toMatch(/lib\/c300\/f2\.txt \(commit/);
        expect(elapsed).toBeLessThan(60000);
      }, 120000);
    });

    sh('50 pushed commits are scanned in one pass, well inside a human wait', () => {
      // The history is imported, not committed through the hooks: this measures the push scan only
      // (50 hooked commits alone took most of the old 30 s budget on Windows).
      R.fastImport(repo, Array.from({ length: 50 }, (_, i) => ({ message: `chore: file ${i}\n`, files: { [`files/f${i}.txt`]: `content ${i}\n` } })), { branch: 'main' });
      R.git(repo, ['reset', '-q', '--hard', 'main']);
      const started = Date.now();
      const r = R.git(repo, ['push', 'origin', 'main']);
      const elapsed = Date.now() - started;
      expect(r.status, r.out).toBe(0);
      expect(elapsed).toBeLessThan(30000);
      expect(remoteHead()).toBe(R.gitOut(repo, ['rev-parse', 'main']));
    }, 120000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-MAJOR-6 / CR-m2: a submodule pointer is skipped, not a reason to block every commit', () => {
  sh('adding a submodule commits (nothing to scan in a commit id)', () => {
    const sub = path.join(tmp.root, 'subrepo');
    R.createHookRepo(sub);
    expect(R.git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub']).status).toBe(0);
    const r = commitF(repo, 'chore: add submodule\n');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/submodule pointer/);
  });

  sh('with a key in another staged file the commit is blocked for the key, not for the pointer', () => {
    const sub = path.join(tmp.root, 'subrepo');
    R.createHookRepo(sub);
    R.git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub']);
    keyFile();
    const r = commitF(repo, 'chore: add submodule\n');
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(r.out).not.toMatch(/could not read/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-MAJOR-7: .betterleaksignore counts once it is part of the reviewed commit', () => {
  const FINGERPRINT = 'leak.txt:domdhi-aws-access-key:1\n';

  sh('an untracked ignore file suppresses nothing', () => {
    fs.writeFileSync(path.join(repo, '.betterleaksignore'), FINGERPRINT);
    keyFile();
    const before = count();
    const r = commitF(repo, 'feat: x\n');
    expect(r.status, r.out).not.toBe(0);
    expect(count()).toBe(before);
  });

  sh('an unstaged edit of a committed ignore file suppresses nothing; the committed list still applies', () => {
    R.stage(repo, '.betterleaksignore', '# reviewed\n');
    expect(commitF(repo, 'chore: ignore list\n').status).toBe(0);
    fs.writeFileSync(path.join(repo, '.betterleaksignore'), FINGERPRINT);   // modified, NOT staged
    keyFile();
    const r = commitF(repo, 'feat: x\n');
    expect(r.status, r.out).not.toBe(0);
  });

  sh('a staged ignore file counts: the entry travels in the same reviewed commit', () => {
    R.stage(repo, '.betterleaksignore', FINGERPRINT);
    keyFile();
    const r = commitF(repo, 'chore: reviewed false positive\n');
    expect(r.status, r.out).toBe(0);
    expect(R.gitOut(repo, ['show', 'HEAD:.betterleaksignore'])).toBe(FINGERPRINT.trim());
  });

  sh('an ignore entry committed earlier keeps applying to later commits (HEAD/index version)', () => {
    R.stage(repo, '.betterleaksignore', FINGERPRINT);
    expect(commitF(repo, 'chore: ignore list\n').status).toBe(0);
    keyFile();
    expect(commitF(repo, 'feat: x\n').status).toBe(0);
  });

  sh('the guardrail keeps an agent from authoring the list', () => {
    const rules = fs.readFileSync(path.join(R.TOOLKIT_AGENTS, 'config', 'guardrail-rules.yaml'), 'utf8');
    expect(rules).toMatch(/readOnlyPaths:[\s\S]*- \.betterleaksignore[\s\S]*- \.gitleaksignore/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-MAJOR-8: a large or binary-looking staged file is scanned, never skipped', () => {
  sh('a 70 MiB file that opens with a NUL and ends with a key is blocked', () => {
    const file = path.join(repo, 'big.dat');
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, Buffer.from([0, 10]));
    const chunk = Buffer.alloc(1024 * 1024, 'a\n');
    for (let i = 0; i < 70; i++) fs.writeSync(fd, chunk);
    fs.writeSync(fd, `k=${R.AWS_KEY}\n`);
    fs.closeSync(fd);
    R.git(repo, ['add', 'big.dat']);
    const before = count();
    const r = commitF(repo, 'chore: data\n');
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(r.out).not.toMatch(/is binary/);
    expect(count()).toBe(before);
  }, 120000);

  sh('a clean large binary blob commits', () => {
    const buf = Buffer.alloc(8 * 1024 * 1024, 0x61);
    buf[0] = 0;
    fs.writeFileSync(path.join(repo, 'blob.bin'), buf);
    R.git(repo, ['add', 'blob.bin']);
    const r = commitF(repo, 'chore: blob\n');
    expect(r.status, r.out).toBe(0);
  });

  sh('a blob git cannot resolve fails the scan closed', () => {
    R.git(repo, ['update-index', '--add', '--cacheinfo', `100644,${'1'.repeat(40)},ghost.bin`]);
    const r = commitF(repo, 'chore: ghost\n');
    expect(r.status).not.toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('moved or copied committed content is not rescanned; changed content is', () => {
  // Moving a folder of already-committed design files re-raised old false positives at commit, because the
  // staged scan lists a rename as a new file. A blob already committed adds nothing new.
  sh('a rename of a committed file holding a key commits without a finding', () => {
    keyFile('old/leak.txt');
    bypassCommit();
    R.git(repo, ['mv', 'old', 'new']);
    const r = commitF(repo, 'chore: move folder\n');
    expect(r.status, r.out).toBe(0);
    expect(R.gitOut(repo, ['ls-files'])).toContain('new/leak.txt');
  });

  sh('a byte-identical copy of committed content commits without a finding', () => {
    keyFile('leak.txt');
    bypassCommit();
    R.stage(repo, 'copy/leak.txt', `k=${R.AWS_KEY}\n`);
    const r = commitF(repo, 'chore: copy\n');
    expect(r.status, r.out).toBe(0);
  });

  sh('a moved file with ANY change is a new blob and is scanned', () => {
    keyFile('leak.txt');
    bypassCommit();
    R.git(repo, ['mv', 'leak.txt', 'moved.txt']);
    R.stage(repo, 'moved.txt', `k=${R.AWS_KEY}\nextra line\n`);
    const before = count();
    const r = commitF(repo, 'chore: move and edit\n');
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(count()).toBe(before);
  });

  sh('a new key is still caught next to a moved committed file', () => {
    keyFile('old.txt');
    bypassCommit();
    R.git(repo, ['mv', 'old.txt', 'renamed.txt']);
    R.stage(repo, 'fresh.txt', `token=${R.AWS_KEY.replace(/.$/, 'Q')}\n`);
    const r = commitF(repo, 'chore: move plus new key\n');
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/fresh\.txt/);
    expect(r.out).not.toMatch(/renamed\.txt/);
  });

  sh('pushing a rename of content already on the remote passes', () => {
    const remote = R.addRemote(repo, tmp.root);
    keyFile('old/leak.txt');
    bypassCommit();
    const first = R.git(repo, ['push', '-q', '-u', 'origin', 'main'], { env: BYPASS });
    expect(first.status, first.out).toBe(0);
    R.git(repo, ['mv', 'old', 'new']);
    expect(commitF(repo, 'chore: move\n').status).toBe(0);
    const r = R.git(repo, ['push', 'origin', 'main']);
    expect(r.status, r.out).toBe(0);
    expect(R.gitOut(remote, ['rev-parse', 'main'])).toBe(R.gitOut(repo, ['rev-parse', 'main']));
  });
});

describe('CR-m1: core.hooksPath that is not a directory means "hooks disabled", reported, never thrown', () => {
  sh('core.hooksPath=/dev/null: install reports it, no stack trace, nothing written', () => {
    hooks.removeHooks(repo);
    R.git(repo, ['config', 'core.hooksPath', '/dev/null']);
    const result = hooks.installHooks(repo);
    expect(result).toMatchObject({ status: 'blocked', active: false });
    const text = result.problems.flat().join('\n');
    expect(text).toMatch(/not a directory: git runs NO hook at all/);
    expect(text).toMatch(/hooks disabled/);
    expect(text).toContain('git config --unset core.hooksPath');
    expect(text).not.toMatch(/ENOTDIR|EACCES/);
  });

  sh('--check prints the disabled state and exits 1 without a stack trace', () => {
    R.git(repo, ['config', 'core.hooksPath', '/dev/null']);
    const r = R.runGitHooksCli(['--check'], repo);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/hooks disabled/);
    expect(r.out).not.toMatch(/ENOTDIR|at .*\.js:\d+/);
  });

  sh('a regular file as the hooks directory is the same state', () => {
    const file = path.join(gitDir(), 'hooks-file');
    fs.writeFileSync(file, 'x');
    R.git(repo, ['config', 'core.hooksPath', file]);
    expect(hooks.installHooks(repo).problems.flat().join('\n')).toMatch(/hooks disabled/);
    expect(hooks.isActive(repo)).toBe(false);
  });

  sh('isActive is false (and silent) for core.hooksPath=/dev/null, even when our hooks sit in .git/hooks', () => {
    R.git(repo, ['config', 'core.hooksPath', '/dev/null']);
    expect(hooks.isActive(repo)).toBe(false);
    // ...and removal still finds and deletes the managed hooks left in .git/hooks
    expect(hooks.removeHooks(repo).removed).toHaveLength(hooks.HOOK_NAMES.length);
  });

  sh('isActive sees a GIT_CONFIG_COUNT/KEY/VALUE override of core.hooksPath in the environment', () => {
    expect(hooks.isActive(repo)).toBe(true);
    const saved = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = '/dev/null';
    try {
      expect(hooks.isActive(repo)).toBe(false);
      process.env.GIT_CONFIG_VALUE_0 = tmp.mkdir('elsewhere');
      expect(hooks.isActive(repo)).toBe(false);
    } finally {
      for (const [name, v] of [['GIT_CONFIG_COUNT', saved.c], ['GIT_CONFIG_KEY_0', saved.k], ['GIT_CONFIG_VALUE_0', saved.v]]) {
        if (v === undefined) delete process.env[name]; else process.env[name] = v;
      }
    }
    expect(hooks.isActive(repo)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('CR-m3: a hook the owner wrote honors the documented bypass', () => {
  sh('a husky-style hook with the owner line: blocks a key, and CLAUDE_COMMIT_NO_SCAN=1 commits and records', () => {
    hooks.removeHooks(repo);
    const husky = path.join(repo, '.husky');
    fs.mkdirSync(husky);
    fs.writeFileSync(path.join(husky, 'pre-commit'), `#!/bin/sh\n${hooks.ownerLine('pre-commit')}\n`, { mode: 0o755 });
    R.git(repo, ['config', 'core.hooksPath', '.husky']);
    keyFile();
    const before = count();
    const blocked = commitF(repo, 'feat: x\n');
    expect(blocked.status, blocked.out).not.toBe(0);
    expect(count()).toBe(before);

    const bypassed = commitF(repo, 'feat: x\n', BYPASS);
    expect(bypassed.status, bypassed.out).toBe(0);
    expect(events().filter(e => e.decision === 'bypass').map(e => e.rule)).toEqual(['git-hook-no-scan']);
  });

  sh('commit.js --no-scan in a husky repo works (it used to record and then be blocked by the owner hook)', () => {
    hooks.removeHooks(repo);
    fs.mkdirSync(path.join(repo, '.husky'));
    fs.writeFileSync(path.join(repo, '.husky', 'pre-commit'), `#!/bin/sh\n${hooks.ownerLine('pre-commit')}\n`, { mode: 0o755 });
    R.git(repo, ['config', 'core.hooksPath', '.husky']);
    keyFile();
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: x\n'), ['--no-scan']);
    expect(r.status, r.out).toBe(0);
    expect(events().length).toBeGreaterThanOrEqual(1);
  });

  it('every owner line is a single, complete shell line for its hook', () => {
    for (const name of hooks.HOOK_NAMES) {
      const line = hooks.ownerLine(name);
      expect(line).not.toContain('\n');
      expect(line).toContain('secret-scanner.cjs');
      expect(line.endsWith('|| exit 1')).toBe(true);
    }
    expect(hooks.ownerLine('pre-push')).toContain('--pre-push "$1" "$2"');
    expect(hooks.ownerLine('commit-msg')).toContain('--commit-msg "$1"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('CR-n1: the bypass is checked before the node and scanner presence checks, and is honest', () => {
  shPosix('node missing: the bypass still commits, and says the bypass was NOT recorded', () => {
    const bin = tmp.mkdir('only-git');
    const gitBin = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(gitBin, path.join(bin, 'git'));
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const r = commitF(repo, 'feat: x\n', { ...BYPASS, PATH: bin });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/bypass was NOT recorded/);
  });

  shPosix('without the bypass, node missing blocks and says how a bypass would behave', () => {
    const bin = tmp.mkdir('only-git');
    const gitBin = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(gitBin, path.join(bin, 'git'));
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const r = commitF(repo, 'feat: x\n', { PATH: bin });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/node is not on PATH/);
    expect(r.out).toMatch(/unrecorded here because node is missing/);
  });

  sh('scanner missing: the bypass still commits, unrecorded, and says so', () => {
    fs.unlinkSync(path.join(repo, '.agents'));
    R.stage(repo, 'app.js', 'const x = 1;\n');
    const r = commitF(repo, 'feat: x\n', BYPASS);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/bypass was NOT recorded/);
    expect(events()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('CR-n2: shim messages name a path that exists where the shim runs', () => {
  it('the helper path in the messages is the canonical .agents/core/git-hooks.js, which ships with the scanner', () => {
    for (const name of hooks.HOOK_NAMES) {
      const text = hooks.renderHook(name);
      const named = [...text.matchAll(/node (\S+git-hooks\.js)/g)].map(m => m[1]);
      expect(named.length, name).toBeGreaterThan(0);
      for (const rel of named) {
        expect(rel).toBe('.agents/core/git-hooks.js');
        expect(fs.existsSync(path.join(path.dirname(R.TOOLKIT_AGENTS), rel)), rel).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('CR-n3: the marker counts only as the first comment line', () => {
  sh('a foreign hook that quotes the marker later in the file is foreign: kept, never overwritten or removed', () => {
    const foreign = `#!/bin/sh\n# my own hook\n# note: ${'# domdhi-agents managed hook: pre-commit v2'}\necho mine\n`;
    fs.writeFileSync(hookFile('pre-commit'), foreign, { mode: 0o755 });
    expect(hooks.inspectHook(path.dirname(hookFile('pre-commit')), 'pre-commit').state).toBe('foreign');
    const installed = hooks.installHooks(repo);
    expect(installed.status).toBe('blocked');
    expect(fs.readFileSync(hookFile('pre-commit'), 'utf8')).toBe(foreign);
    hooks.removeHooks(repo);
    expect(fs.readFileSync(hookFile('pre-commit'), 'utf8')).toBe(foreign);
  });

  sh('a quoted marker on the same line as other text is not ours either', () => {
    fs.writeFileSync(hookFile('commit-msg'), '#!/bin/sh\necho "# domdhi-agents managed hook: commit-msg v2"\n', { mode: 0o755 });
    expect(hooks.inspectHook(path.dirname(hookFile('commit-msg')), 'commit-msg').state).toBe('foreign');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('SEC-NIT-2 / SEC-MAJOR-4: what the output and the shims claim', () => {
  sh('--check states the true coverage, not "every commit path"', () => {
    const r = R.runGitHooksCli(['--check'], repo);
    expect(r.out).toMatch(/Commit, merge and am run the secret scan, and push scans every commit it would publish/);
    expect(r.out).not.toMatch(/every commit path/i);
  });

  it('no source or doc claims "every commit path" any more', () => {
    const base = path.dirname(R.TOOLKIT_AGENTS);
    for (const rel of ['.agents/core/git-hooks.js', '.agents/core/commit.js', '.agents/hooks/secret-scanner.cjs', 'README.md', 'docs/reference/agents/concepts/hooks.md', '.agents/startup-reference.md']) {
      const text = fs.readFileSync(path.join(base, rel), 'utf8');
      expect(text, rel).not.toMatch(/every commit path/i);
    }
  });
});

describe('isNullDevice', () => {
  it('treats /dev/null as the null device everywhere and NUL only on Windows', () => {
    expect(hooks.isNullDevice('/dev/null', 'linux')).toBe(true);
    expect(hooks.isNullDevice(' /dev/null ', 'win32')).toBe(true);
    expect(hooks.isNullDevice('NUL', 'win32')).toBe(true);
    expect(hooks.isNullDevice('nul', 'linux')).toBe(false); // an ordinary relative directory on POSIX
    expect(hooks.isNullDevice('.githooks', 'win32')).toBe(false);
    expect(hooks.isNullDevice(undefined, 'win32')).toBe(false);
  });
});
