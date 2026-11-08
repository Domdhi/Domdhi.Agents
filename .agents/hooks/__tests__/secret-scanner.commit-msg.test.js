// secret-scanner.cjs git-hook modes: --commit-msg <file> and --hook-bypass <hook>, plus the shared
// message scan commit.js uses. Real engine, real git (hook-repo.js); key fixtures are built from parts.
//
// Coverage:
//   - scanCommitMessage: one implementation for commit.js and the commit-msg hook, scanning the WHOLE text
//   - --commit-msg: clean 0, key 1, a key below (or above) a scissors line still blocked (no hiding place),
//     unreadable file / missing argument / missing engine / broken engine all fail closed with exit 1
//   - --hook-bypass: one event per bypassed commit (pre-commit records, commit-msg only when it ran alone),
//     records are never suppressed by an environment variable, and "recorded" is only said after the write
//   - the git modes honor CLAUDE_COMMIT_NO_SCAN=1 themselves (an owner-written hook gets the bypass too)
//   - no environment variable redirects the repository a git mode scans

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { gitAvailable } = require('../../core/__tests__/_helpers/git-fixture');
const R = require('../../core/__tests__/_helpers/hook-repo');
const scanner = require('../secret-scanner.cjs');

const SCANNER = path.resolve(__dirname, '..', 'secret-scanner.cjs');
const SCISSORS = '# ------------------------ >8 ------------------------';
const sh = it.skipIf(!gitAvailable());

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'scanner-modes-' }); });
afterEach(() => tmp.cleanup());

function run(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], { cwd, env: R.cleanEnv(cwd, env), encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('scanCommitMessage (the one implementation)', () => {
  it('reports clean, findings (redacted) and an empty message', () => {
    expect(scanner.scanCommitMessage('fix: a clean message\n')).toEqual({ status: 'clean' });
    expect(scanner.scanCommitMessage('  \n')).toEqual({ status: 'clean' });
    const r = scanner.scanCommitMessage(`fix: rotate ${R.AWS_KEY}\n`);
    expect(r.status).toBe('findings');
    expect(r.findings[0]).toMatchObject({ name: 'AWS Access Key', file: '<commit-message>' });
    expect(JSON.stringify(r)).not.toContain(R.AWS_KEY);
  });

  it('scans the whole text: a key below a scissors line (real or forged) is found', () => {
    expect(scanner.scanCommitMessage(`subject\n${SCISSORS}\n+${R.AWS_KEY}\n`).status).toBe('findings');
    expect(scanner.scanCommitMessage(`subject\n${SCISSORS}\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+${R.AWS_KEY}\n`).status).toBe('findings');
  });

  it('reports an engine that cannot run as an engine error, never as clean', () => {
    const prev = process.env.AGENTS_SECRET_ENGINE_BIN;
    process.env.AGENTS_SECRET_ENGINE_BIN = path.join(tmp.root, 'no-such-engine');
    try {
      const secretEngine = require('../secret-engine.cjs');
      secretEngine.resetForTests && secretEngine.resetForTests();
      expect(scanner.scanCommitMessage('fix: x\n').status).toBe('engine-error');
    } finally {
      if (prev === undefined) delete process.env.AGENTS_SECRET_ENGINE_BIN; else process.env.AGENTS_SECRET_ENGINE_BIN = prev;
      const secretEngine = require('../secret-engine.cjs');
      secretEngine.resetForTests && secretEngine.resetForTests();
    }
  });
});

describe('--commit-msg <file>', () => {
  const msg = text => R.writeMessage(tmp.root, text);

  it('exits 0 on a clean message', () => {
    expect(run(['--commit-msg', msg('feat: add a thing\n\nBody.\n')], tmp.root).status).toBe(0);
  });

  it('exits 1 on a key, names the rule and never prints the value', () => {
    const r = run(['--commit-msg', msg(`fix: rotate\n\nold key ${R.AWS_KEY}\n`)], tmp.root);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(r.out).toMatch(/commit message contains what looks like a secret/);
    expect(r.out).not.toContain(R.AWS_KEY);
  });

  it('blocks a key hidden below a forged scissors line, and one above it; a clean verbose-style message passes', () => {
    const forged = run(['--commit-msg', msg(`subject\n${SCISSORS}\ndiff\n+${R.AWS_KEY}\n`)], tmp.root);
    expect(forged.status).toBe(1);
    expect(forged.out).not.toContain(R.AWS_KEY);
    expect(run(['--commit-msg', msg(`subject ${R.AWS_KEY}\n${SCISSORS}\ndiff\n`)], tmp.root).status).toBe(1);
    expect(run(['--commit-msg', msg(`subject\n${SCISSORS}\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+const x = 1;\n`)], tmp.root).status).toBe(0);
  });

  it('fails closed (exit 1) on an unreadable file', () => {
    const r = run(['--commit-msg', path.join(tmp.root, 'missing')], tmp.root);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL-CLOSED: could not read the commit message file/);
  });

  it('fails closed (exit 1) without a file argument', () => {
    expect(run(['--commit-msg'], tmp.root).status).toBe(1);
    expect(run(['--commit-msg', '--file'], tmp.root).status).toBe(1);
  });

  it('fails closed with an install hint when the engine is missing', () => {
    const r = run(['--commit-msg', msg('fix: x\n')], tmp.root, { AGENTS_SECRET_ENGINE_BIN: path.join(tmp.root, 'no-such-engine') });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL-CLOSED/);
    expect(r.out).toMatch(/secret-engine-install/);
  });
});

describe('--hook-bypass <hook>', () => {
  const repoWith = () => R.createHookRepo(path.join(tmp.root, 'repo'));

  sh('pre-commit records one bypass event with the git-hook rule and says it was recorded', () => {
    const repo = repoWith();
    const r = run(['--hook-bypass', 'pre-commit'], repo);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/secret scan bypassed/);
    expect(r.out).toMatch(/recorded in guardrail-events\.jsonl/);
    expect(R.guardrailEvents(repo)).toMatchObject([{ decision: 'bypass', rule: 'git-hook-no-scan', source: 'secret-scanner', patterns: ['pre-commit'] }]);
  });

  sh('commit-msg run alone (no marker from a pre-commit of this commit) records', () => {
    const repo = repoWith();
    expect(run(['--hook-bypass', 'commit-msg'], repo).status).toBe(0);
    expect(R.guardrailEvents(repo)).toMatchObject([{ rule: 'git-hook-no-scan', patterns: ['commit-msg'] }]);
  });

  sh('pre-commit then commit-msg of the same commit: one event', () => {
    const repo = repoWith();
    run(['--hook-bypass', 'pre-commit'], repo);
    const second = run(['--hook-bypass', 'commit-msg'], repo);
    expect(second.out).toMatch(/already recorded by the first hook of this commit/);
    expect(R.guardrailEvents(repo)).toHaveLength(1);
  });

  for (const hook of ['pre-merge-commit', 'pre-applypatch', 'pre-push']) {
    sh(`${hook} records`, () => {
      const repo = repoWith();
      run(['--hook-bypass', hook], repo);
      expect(R.guardrailEvents(repo)).toMatchObject([{ rule: 'git-hook-no-scan', patterns: [hook] }]);
    });
  }

  sh('no environment variable suppresses the record (the old AGENTS_SCAN_BYPASS_RECORDED flag is inert)', () => {
    const repo = repoWith();
    run(['--hook-bypass', 'pre-commit'], repo, { AGENTS_SCAN_BYPASS_RECORDED: '1' });
    expect(R.guardrailEvents(repo)).toHaveLength(1);
  });

  sh('NOT recorded is reported when the event cannot be written', () => {
    const repo = repoWith();
    const notADir = path.join(tmp.root, 'file-not-dir');
    fs.writeFileSync(notADir, 'x');
    const r = run(['--hook-bypass', 'pre-commit'], repo, { CLAUDE_PROJECT_DIR: notADir });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/NOT recorded: guardrail-events\.jsonl could not be written/);
    expect(r.out).not.toMatch(/recorded in guardrail-events/);
  });
});

describe('CLAUDE_COMMIT_NO_SCAN=1 in the git modes themselves (a hook the owner wrote)', () => {
  const BYPASS = { CLAUDE_COMMIT_NO_SCAN: '1' };

  sh('--git-precommit skips the scan and records', () => {
    const repo = R.createHookRepo(path.join(tmp.root, 'repo'));
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    expect(run(['--git-precommit'], repo).status).toBe(1);
    const r = run(['--git-precommit'], repo, BYPASS);
    expect(r.status).toBe(0);
    expect(R.guardrailEvents(repo).filter(e => e.decision === 'bypass')).toHaveLength(1);
  });

  sh('--commit-msg and --pre-push skip the scan under the bypass', () => {
    const repo = R.createHookRepo(path.join(tmp.root, 'repo'));
    const msg = R.writeMessage(tmp.root, `fix: ${R.AWS_KEY}\n`);
    expect(run(['--commit-msg', msg], repo, BYPASS).status).toBe(0);
    expect(run(['--pre-push', 'origin'], repo, BYPASS).status).toBe(0);
  });
});

describe('the repository root of the git modes comes from git only', () => {
  sh('CLAUDE_PROJECT_DIR=<clean repo> does not redirect --git-precommit', () => {
    const repo = R.createHookRepo(path.join(tmp.root, 'repo'));
    const other = R.createHookRepo(path.join(tmp.root, 'other'));
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    expect(run(['--git-precommit'], repo, { CLAUDE_PROJECT_DIR: other }).status).toBe(1);
  });

  sh('AGENTS_GIT_HOOK_ROOT=<clean repo> does not redirect it either', () => {
    const repo = R.createHookRepo(path.join(tmp.root, 'repo'));
    const other = R.createHookRepo(path.join(tmp.root, 'other'));
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    expect(run(['--git-precommit'], repo, { AGENTS_GIT_HOOK_ROOT: other }).status).toBe(1);
  });

  sh('the scan follows the working directory: the clean repo is clean, the other holds the key', () => {
    const repo = R.createHookRepo(path.join(tmp.root, 'repo'));
    const other = R.createHookRepo(path.join(tmp.root, 'other'));
    R.stage(repo, 'config.js', `const k = "${R.CG_KEY}";\n`);
    expect(run(['--git-precommit'], other, { CLAUDE_PROJECT_DIR: repo }).status).toBe(0);
  });
});
