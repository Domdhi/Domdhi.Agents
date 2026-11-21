// The pre-push AUTO BRANCH GUARD (security review M3, item b): the managed pre-push shim refuses any push whose remote
// ref is refs/heads/auto/*, whatever local ref is pushed to it, unless the owner sets AGENTS_ALLOW_AUTO_PUSH=1. An auto/*
// branch is where the self-improvement cycle's model-written change stops, and nothing publishes it but the owner. Real git,
// a real local bare remote in a temp dir, and the real scanner: no push in this file touches any remote but that bare repository.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { gitAvailable } = require('./_helpers/git-fixture');
const hooks = require('../git-hooks');
const R = require('./_helpers/hook-repo');

const sh = it.skipIf(!gitAvailable());
const OVERRIDE = { AGENTS_ALLOW_AUTO_PUSH: '1' };
const FORCE_OVERRIDE = { AGENTS_ALLOW_FORCE_PUSH: '1' };
const NO_SCAN = { CLAUDE_COMMIT_NO_SCAN: '1' };

let tmp;
let repo;
let remote;
let counter = 0;
beforeEach(() => {
  tmp = createTmpDir({ prefix: 'git-hooks-auto-' });
  if (!gitAvailable()) return;
  repo = R.createHookRepo(path.join(tmp.root, 'repo'));
  hooks.installHooks(repo);
  remote = R.addRemote(repo, tmp.root);
  const first = R.git(repo, ['push', '-q', '-u', 'origin', 'main']);
  expect(first.status, first.out).toBe(0);
});
afterEach(() => tmp.cleanup());

const remoteRefs = () => R.gitOut(remote, ['for-each-ref', '--format=%(refname) %(objectname)']);
const localHead = () => R.gitOut(repo, ['rev-parse', 'HEAD']);
function commit(dir, name, text = `${name}\n`) {
  R.stage(dir, name, text);
  const r = R.git(dir, ['commit', '-F', R.writeMessage(tmp.root, `add ${name}\n`, `MSG${++counter}`)]);
  expect(r.status, r.out).toBe(0);
}
const REFUSED = /refusing to push to refs\/heads\/auto\//;

describe('the shim text', () => {
  it('only pre-push carries the auto guard, and it runs before node, the scanner and the audited bypass', () => {
    for (const name of hooks.HOOK_NAMES) {
      const text = hooks.renderHook(name);
      if (name !== 'pre-push') {
        expect(text, name).not.toContain('AGENTS_ALLOW_AUTO_PUSH');
        continue;
      }
      const guard = text.indexOf('refs/heads/auto/*)');
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(text.indexOf('if [ "${CLAUDE_COMMIT_NO_SCAN:-}" = "1" ]'));
      expect(guard).toBeLessThan(text.indexOf('command -v node'));
      expect(text).toContain(`${hooks.AUTO_OVERRIDE_ENV}=1`);
    }
    expect(hooks.AUTO_OVERRIDE_ENV).toBe('AGENTS_ALLOW_AUTO_PUSH');
  });

  it('the auto override is its own variable: the force override is not the auto override', () => {
    expect(hooks.AUTO_OVERRIDE_ENV).not.toBe(hooks.FORCE_OVERRIDE_ENV);
  });

  sh('a pre-push installed before the auto guard is outdated and is refreshed to the guarded text', () => {
    const file = path.join(R.gitOut(repo, ['rev-parse', '--absolute-git-dir']), 'hooks', 'pre-push');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('refs/heads/auto/*)');
    const stripped = text.slice(0, text.indexOf('if [ "${AGENTS_ALLOW_AUTO_PUSH:-}"')) + text.slice(text.indexOf('root=$(git rev-parse --show-toplevel'));
    fs.writeFileSync(file, stripped, { mode: 0o755 });
    expect(hooks.inspectHooks(repo).active).toBe(false);
    expect(hooks.installHooks(repo).changed).toEqual(['pre-push']);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});

describe('what is refused (each leaves the remote exactly as it was)', () => {
  sh.each([
    ['a new branch pushed to auto/x by refspec', () => ['push', 'origin', 'HEAD:refs/heads/auto/x']],
    ['main pushed to auto/y with a short refspec', () => ['push', 'origin', 'main:auto/y']],
    ['a local auto/* branch pushed under its own name', () => ['push', 'origin', 'auto/z']],
    ['a nested auto name', () => ['push', 'origin', 'HEAD:refs/heads/auto/evolve/2026-11-18/alpha']],
  ])('%s', (_name, argv) => {
    R.git(repo, ['branch', 'auto/z']);
    commit(repo, 'change.txt');
    const before = remoteRefs();
    const r = R.git(repo, argv());
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(REFUSED);
    expect(remoteRefs()).toBe(before);
  });

  sh('one auto/* ref refuses the whole push, even beside a fast-forward of main', () => {
    commit(repo, 'ff.txt');
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin', 'main', 'HEAD:refs/heads/auto/x']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(REFUSED);
    expect(remoteRefs()).toBe(before);
  });

  sh('the audited scan bypass (CLAUDE_COMMIT_NO_SCAN=1) skips the scan only, never the guard', () => {
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin', 'HEAD:refs/heads/auto/x'], { env: NO_SCAN });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(REFUSED);
    expect(remoteRefs()).toBe(before);
  });

  sh('the force override does not publish an auto/* branch: it is a different variable', () => {
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin', 'HEAD:refs/heads/auto/x'], { env: FORCE_OVERRIDE });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(REFUSED);
    expect(remoteRefs()).toBe(before);
  });

  sh('the refusal names the owner override', () => {
    const r = R.git(repo, ['push', 'origin', 'HEAD:refs/heads/auto/x']);
    expect(r.out).toContain('AGENTS_ALLOW_AUTO_PUSH=1 git push');
  });

  sh('the guard also refuses to delete an auto/* ref that is on the remote', () => {
    expect(R.git(repo, ['push', 'origin', 'HEAD:refs/heads/auto/x'], { env: OVERRIDE }).status).toBe(0);
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin', '--delete', 'auto/x'], { env: FORCE_OVERRIDE });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(REFUSED);
    expect(remoteRefs()).toBe(before);
  });
});

describe('what passes', () => {
  sh.each([
    ['a branch that merely contains auto/ later in its name', 'HEAD:refs/heads/feature/auto/x'],
    ['a branch that starts with auto but has no slash', 'HEAD:refs/heads/autopilot'],
    ['a branch called auto', 'HEAD:refs/heads/auto'],
    ['a tag under auto/', 'HEAD:refs/tags/auto/v1'],
  ])('%s publishes', (_name, refspec) => {
    commit(repo, 'topic.txt');
    const r = R.git(repo, ['push', 'origin', refspec]);
    expect(r.status, r.out).toBe(0);
  });

  sh('a plain fast-forward of main publishes', () => {
    commit(repo, 'ff.txt');
    const r = R.git(repo, ['push', 'origin', 'main']);
    expect(r.status, r.out).toBe(0);
    expect(R.gitOut(remote, ['rev-parse', 'main'])).toBe(localHead());
  });
});

describe('the owner override', () => {
  sh('AGENTS_ALLOW_AUTO_PUSH=1 publishes an auto/* branch', () => {
    const r = R.git(repo, ['push', 'origin', 'HEAD:refs/heads/auto/x'], { env: OVERRIDE });
    expect(r.status, r.out).toBe(0);
    expect(remoteRefs()).toContain('refs/heads/auto/x');
  });

  sh('AGENTS_ALLOW_AUTO_PUSH=1 leaves the force guard in force', () => {
    R.stage(repo, 'rewritten.txt', 'rewritten\n');
    expect(R.git(repo, ['commit', '--amend', '-F', R.writeMessage(tmp.root, 'rewritten\n', `MSG${++counter}`)]).status).toBe(0);
    const before = remoteRefs();
    const r = R.git(repo, ['push', '--force', 'origin', 'main'], { env: OVERRIDE });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/refusing to update refs\/heads\/main: it is not a fast-forward/);
    expect(remoteRefs()).toBe(before);
  });

  sh('AGENTS_ALLOW_AUTO_PUSH=1 still runs the secret scan on what it publishes', () => {
    R.stage(repo, 'leak.txt', `k=${R.AWS_KEY}\n`);
    expect(R.git(repo, ['commit', '-F', R.writeMessage(tmp.root, 'chore: key\n', `MSG${++counter}`)], { env: NO_SCAN }).status).toBe(0);
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin', 'HEAD:refs/heads/auto/x'], { env: OVERRIDE });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(remoteRefs()).toBe(before);
  });

  sh('only the exact value 1 overrides', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      const r = R.git(repo, ['push', 'origin', 'HEAD:refs/heads/auto/x'], { env: { AGENTS_ALLOW_AUTO_PUSH: value } });
      expect(r.status, `value ${JSON.stringify(value)}: ${r.out}`).not.toBe(0);
      expect(r.out).toMatch(REFUSED);
    }
  });
});
