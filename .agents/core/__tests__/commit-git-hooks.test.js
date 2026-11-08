// commit.js x the managed git hooks.
//
// When the hooks are installed, current and active, commit.js leaves the staged and message scans to
// them (one scan, not two); otherwise it scans itself exactly as before. The bypass reaches the hooks
// through the child's environment and is recorded once.
//
// "Scans once" is proven with an instrumented fake engine that appends a line to a file on every engine run
// (`dir` for the batched staged set, `stdin` for the message) and reports a byte count that matches in both
// modes, so the staged set really takes the batch path:
//   hooks active   -> dir, stdin               (pre-commit: the staged set in one run; commit-msg: the message)
//   commit.js only -> dir, stdin               (its own staged scan + its own message scan)
//   both running   -> dir, stdin, dir, stdin   (the double scan this design removes)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { gitAvailable } = require('./_helpers/git-fixture');
const { createFakeEngineKit } = require('../../hooks/__tests__/_helpers/fake-engine');
const hooks = require('../git-hooks');
const commit = require('../commit');
const R = require('./_helpers/hook-repo');

const sh = it.skipIf(!gitAvailable());

let tmp;
let repo;
let kit;
beforeEach(() => {
  tmp = createTmpDir({ prefix: 'commit-hooks-' });
  kit = createFakeEngineKit(path.join(tmp.root, 'fake'));
  if (gitAvailable()) repo = R.createHookRepo(path.join(tmp.root, 'repo'));
});
afterEach(() => {
  kit.restore();
  tmp.cleanup();
});

// A clean engine that logs every run by subcommand. Its byte report is exact in both modes (`dir` sums the
// staged files, `stdin` counts its input), so the batch path is the one exercised, not the per-file fallback.
const COUNTING = `
const fs = require('fs'); const path = require('path');
const sub = process.argv[2];
fs.appendFileSync(process.env.FAKE_COUNT_FILE, sub + '\\n');
const total = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? total(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
if (sub === 'dir') {
  process.stderr.write('INF scanned ~' + total(process.argv[3]) + ' bytes (x) in 1ms\\n');
  console.log('[]');
} else {
  const chunks = []; process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => { const n = Buffer.concat(chunks).length; process.stderr.write('INF scanned ~' + n + ' bytes (' + n + ' bytes) in 1ms\\n'); console.log('[]'); });
}`;

function countingEnv() {
  const countFile = path.join(tmp.root, 'scans.log');
  fs.writeFileSync(countFile, '');
  return {
    env: { ...kit.childEnv(COUNTING), AGENTS_SECRET_ENGINE_BIN: kit.exe(), FAKE_COUNT_FILE: countFile },
    runs: () => fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean),
  };
}

function stagedApp() {
  R.stage(repo, 'app.js', 'const x = 1;\n');
  return R.writeMessage(tmp.root, 'feat: add app\n');
}

describe('commit.js with the managed hooks active', () => {
  sh('scans once, not twice: the hooks do the staged and the message scan', () => {
    hooks.installHooks(repo);
    const msg = stagedApp();
    const { env, runs } = countingEnv();
    const before = R.commitCount(repo);
    const r = R.runCommitJs(repo, msg, [], env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/handled by the managed git hooks/);
    expect(R.commitCount(repo)).toBe(before + 1);
    expect(runs()).toEqual(['dir', 'stdin']);
  });

  sh('still blocks a staged key', () => {
    hooks.installHooks(repo);
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const msg = R.writeMessage(tmp.root, 'feat: add config\n');
    const before = R.commitCount(repo);
    const r = R.runCommitJs(repo, msg);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/Commit blocked/);
    expect(r.out).toMatch(/git commit failed/);
    expect(R.commitCount(repo)).toBe(before);
  });

  sh('still blocks a key in the message (inline -m too)', () => {
    hooks.installHooks(repo);
    stagedApp();
    const msg = R.writeMessage(tmp.root, 'unused\n');
    const before = R.commitCount(repo);
    const file = R.runCommitJs(repo, R.writeMessage(tmp.root, `fix: rotate ${R.AWS_KEY}\n`, 'KEYMSG'));
    expect(file.status).not.toBe(0);
    const inline = R.runCommitJs(repo, msg, ['-m', `fix: rotate ${R.AWS_KEY}`]);
    expect(inline.status).not.toBe(0);
    expect(inline.out).toMatch(/commit message contains what looks like a secret/);
    expect(R.commitCount(repo)).toBe(before);
  });

  sh('--no-scan is recorded exactly once, by the hooks (commit.js adds none), and the key commits', () => {
    hooks.installHooks(repo);
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const msg = R.writeMessage(tmp.root, 'feat: add config\n');
    const before = R.commitCount(repo);
    const r = R.runCommitJs(repo, msg, ['--no-scan']);
    expect(r.status, r.out).toBe(0);
    expect(R.commitCount(repo)).toBe(before + 1);
    const events = R.guardrailEvents(repo);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'bypass', rule: 'git-hook-no-scan', source: 'secret-scanner' });
  });

  sh('CLAUDE_COMMIT_NO_SCAN=1 through commit.js is also one event', () => {
    hooks.installHooks(repo);
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const msg = R.writeMessage(tmp.root, 'feat: add config\n');
    const r = R.runCommitJs(repo, msg, [], { CLAUDE_COMMIT_NO_SCAN: '1' });
    expect(r.status, r.out).toBe(0);
    expect(R.guardrailEvents(repo).map(e => e.rule)).toEqual(['git-hook-no-scan']);
  });

  sh('a bypassed commit never runs the engine at all', () => {
    hooks.installHooks(repo);
    const msg = stagedApp();
    const { env, runs } = countingEnv();
    expect(R.runCommitJs(repo, msg, ['--no-scan'], env).status).toBe(0);
    expect(runs()).toEqual([]);
  });
});

describe('commit.js without active hooks keeps scanning itself', () => {
  sh('no hooks installed: scans twice (staged + message) and says nothing about hooks', () => {
    const msg = stagedApp();
    const { env, runs } = countingEnv();
    const r = R.runCommitJs(repo, msg, [], env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/managed git hooks/);
    expect(runs()).toEqual(['dir', 'stdin']);
  });

  sh('no hooks installed: still blocks a staged key', () => {
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const before = R.commitCount(repo);
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: add config\n'));
    expect(r.status).not.toBe(0);
    expect(R.commitCount(repo)).toBe(before);
  });

  sh('an outdated managed hook is not active: commit.js scans itself', () => {
    hooks.installHooks(repo);
    const hookPath = path.join(R.gitOut(repo, ['rev-parse', '--absolute-git-dir']), 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\n# domdhi-agents managed hook: pre-commit v0\nexit 0\n', { mode: 0o755 });
    const msg = stagedApp();
    const { env, runs } = countingEnv();
    const r = R.runCommitJs(repo, msg, [], env);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/managed git hooks/);
    // commit.js's own staged + message scans, the stale pre-commit does nothing, the current commit-msg scans the message.
    expect(runs()).toEqual(['dir', 'stdin', 'stdin']);
  });

  sh('a foreign core.hooksPath is not active: commit.js scans itself and the key is blocked', () => {
    fs.mkdirSync(path.join(repo, '.husky'));
    R.git(repo, ['config', 'core.hooksPath', '.husky']);
    hooks.installHooks(repo); // refused: reports only
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: add config\n'));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/secret scan blocked the commit/);
  });

  sh('hooks installed but the scanner file gone: not active, commit.js scans itself, git blocks at the hook', () => {
    hooks.installHooks(repo);
    fs.unlinkSync(path.join(repo, '.agents'));
    expect(hooks.isActive(repo)).toBe(false);
    stagedApp();
    const r = R.runCommitJs(repo, R.writeMessage(tmp.root, 'feat: add app\n'));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/secret scanner is missing/);
  });
});

describe('commit.js helpers', () => {
  it('bypassEnv hands the bypass to the child hooks and nothing else (no flag that could suppress the audit record)', () => {
    const env = commit.bypassEnv(true);
    expect(env.CLAUDE_COMMIT_NO_SCAN).toBe('1');
    expect(Object.keys(env).filter(k => !(k in process.env) && k !== 'CLAUDE_COMMIT_NO_SCAN')).toEqual([]);
    expect(commit.bypassEnv(false)).toBe(process.env);
  });

  it('managedHooksActive answers false outside a repository instead of throwing', () => {
    const prev = process.cwd();
    process.chdir(tmp.root);
    try { expect(commit.managedHooksActive()).toBe(false); } finally { process.chdir(prev); }
  });
});
