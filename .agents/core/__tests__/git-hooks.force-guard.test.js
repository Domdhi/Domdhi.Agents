// The pre-push FORCE GUARD (security review M1, item 1): the managed pre-push shim refuses every deletion and every
// non-fast-forward update, whatever git route or configuration source produced it, unless the owner sets
// AGENTS_ALLOW_FORCE_PUSH=1. Real git, a real local bare remote in a temp dir, and the real scanner: no push in
// this file touches any remote but that bare repository.

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
const OVERRIDE = { AGENTS_ALLOW_FORCE_PUSH: '1' };
const NO_SCAN = { CLAUDE_COMMIT_NO_SCAN: '1' };
const IDENT = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];

let tmp;
let repo;
let remote;
let counter = 0;
beforeEach(() => {
  tmp = createTmpDir({ prefix: 'git-hooks-force-' });
  if (!gitAvailable()) return;
  repo = R.createHookRepo(path.join(tmp.root, 'repo'));
  hooks.installHooks(repo);
  remote = R.addRemote(repo, tmp.root);
  const first = R.git(repo, ['push', '-q', '-u', 'origin', 'main']);
  expect(first.status, first.out).toBe(0);
});
afterEach(() => tmp.cleanup());

const remoteRefs = () => R.gitOut(remote, ['for-each-ref', '--format=%(refname) %(objectname)']);
const remoteHead = (ref = 'main') => R.gitOut(remote, ['rev-parse', ref]);
const localHead = () => R.gitOut(repo, ['rev-parse', 'HEAD']);
function commit(dir, name, text = `${name}\n`) {
  R.stage(dir, name, text);
  const r = R.git(dir, ['commit', '-F', R.writeMessage(tmp.root, `add ${name}\n`, `MSG${++counter}`)]);
  expect(r.status, r.out).toBe(0);
}
/** Push `keepme` to the remote, then drop it locally: a mirror or prune push now wants to delete it there. */
function remoteOnlyBranch() {
  expect(R.git(repo, ['branch', 'keepme']).status).toBe(0);
  const pushed = R.git(repo, ['push', '-q', 'origin', 'keepme']);
  expect(pushed.status, pushed.out).toBe(0);
  expect(R.git(repo, ['branch', '-q', '-D', 'keepme']).status).toBe(0);
}
/** Rewrite the last commit so local main and the remote's main diverge. */
function diverge() {
  R.stage(repo, 'rewritten.txt', 'rewritten\n');
  const r = R.git(repo, ['commit', '--amend', '-F', R.writeMessage(tmp.root, 'rewritten\n', `MSG${++counter}`)]);
  expect(r.status, r.out).toBe(0);
}
const REFUSED = /refusing to/;

describe('the shim text', () => {
  it('only pre-push carries the guard, and it runs before node, the scanner and the audited bypass', () => {
    for (const name of hooks.HOOK_NAMES) {
      const text = hooks.renderHook(name);
      if (name !== 'pre-push') {
        expect(text, name).not.toContain('AGENTS_ALLOW_FORCE_PUSH');
        continue;
      }
      const guard = text.indexOf('git merge-base --is-ancestor');
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(text.indexOf('if [ "${CLAUDE_COMMIT_NO_SCAN:-}" = "1" ]'));
      expect(guard).toBeLessThan(text.indexOf('command -v node'));
      expect(text).toContain(`${hooks.FORCE_OVERRIDE_ENV}=1`);
    }
    expect(hooks.FORCE_OVERRIDE_ENV).toBe('AGENTS_ALLOW_FORCE_PUSH');
  });

  sh('an installed hook from before the guard (v2) is reported outdated and refreshed', () => {
    const file = path.join(R.gitOut(repo, ['rev-parse', '--absolute-git-dir']), 'hooks', 'pre-push');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('pre-push v3', 'pre-push v2'), { mode: 0o755 });
    expect(hooks.inspectHooks(repo).active).toBe(false);
    const result = hooks.installHooks(repo);
    expect(result.changed).toEqual(['pre-push']);
    expect(hooks.inspectHooks(repo).active).toBe(true);
  });
});

describe('what passes', () => {
  sh('a plain fast-forward push publishes', () => {
    commit(repo, 'ff.txt');
    const r = R.git(repo, ['push', 'origin', 'main']);
    expect(r.status, r.out).toBe(0);
    expect(remoteHead()).toBe(localHead());
  });

  sh('a new branch (remote sha all zeros) publishes', () => {
    commit(repo, 'topic.txt');
    const r = R.git(repo, ['push', 'origin', 'HEAD:refs/heads/topic']);
    expect(r.status, r.out).toBe(0);
    expect(remoteHead('topic')).toBe(localHead());
  });

  sh('a new tag publishes', () => {
    expect(R.git(repo, ['tag', 'v1']).status).toBe(0);
    const r = R.git(repo, ['push', 'origin', 'v1']);
    expect(r.status, r.out).toBe(0);
  });

  sh('the secret scan still runs on a fast-forward push (the ref lines reach the scanner)', () => {
    R.stage(repo, 'leak.txt', `k=${R.AWS_KEY}\n`);
    const bypassed = R.git(repo, ['commit', '-F', R.writeMessage(tmp.root, 'chore: key\n', `MSG${++counter}`)], { env: NO_SCAN });
    expect(bypassed.status, bypassed.out).toBe(0);
    const before = remoteHead();
    const r = R.git(repo, ['push', 'origin', 'main']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/AWS Access Key/);
    expect(r.out).not.toMatch(REFUSED);
    expect(remoteHead()).toBe(before);
  });
});

describe('what is refused (each leaves the remote exactly as it was)', () => {
  sh('git push --mirror (it deletes the remote-only branch and overwrites main)', () => {
    remoteOnlyBranch();
    diverge();
    const before = remoteRefs();
    const r = R.git(repo, ['push', '--mirror', 'origin']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/refusing a mirror push/);
    expect(r.out).toMatch(/refusing to update refs\/heads\/main: it is not a fast-forward/);
    expect(remoteRefs()).toBe(before);
  });

  // Git does not report a mirror push's deletions to the hook, so a mirror push that only deletes (every other ref
  // is already up to date) shows the hook no refusable line. Each sign below must catch it on its own.
  sh('a pure-deletion mirror push is refused: first by the remote-tracking refs it carries, then by the command line alone', () => {
    remoteOnlyBranch();
    const before = remoteRefs();
    const flag = R.git(repo, ['push', '--mirror', 'origin']);
    expect(flag.status, flag.out).not.toBe(0);
    expect(flag.out).toMatch(/refusing a mirror push \(/);
    expect(remoteRefs()).toBe(before);

    // No remote-tracking refs to give it away: the abbreviated flag is still on the command line.
    for (const ref of R.gitOut(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes']).split('\n').filter(Boolean)) {
      expect(R.git(repo, ['update-ref', '-d', ref]).status).toBe(0);
    }
    const abbreviated = R.git(repo, ['push', '--mirro', 'origin']);
    expect(abbreviated.status, abbreviated.out).not.toBe(0);
    expect(abbreviated.out).toMatch(/the push command line asks for --mirror/);
    expect(remoteRefs()).toBe(before);
  });

  sh('refs/remotes/* in a push is the mirror-shaped sign, even without the flag on the command line', () => {
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin', 'refs/remotes/origin/main:refs/remotes/origin/main']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/only a mirror push does/);
    expect(remoteRefs()).toBe(before);
  });

  sh('git push --prune with a wildcard refspec (the form no text rule asked about)', () => {
    remoteOnlyBranch();
    const before = remoteRefs();
    const r = R.git(repo, ['push', '--prune', 'origin', 'refs/heads/*:refs/heads/*']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/refusing to DELETE refs\/heads\/keepme/);
    expect(remoteRefs()).toBe(before);
  });

  sh('git remote add --mirror=push <url>, then a plain push to it (no flag on the push line)', () => {
    remoteOnlyBranch();
    expect(R.git(repo, ['remote', 'add', '--mirror=push', 'm2', remote]).status).toBe(0);
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'm2']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/refusing a mirror push \(remote\.m2\.mirror is true\)/);
    expect(remoteRefs()).toBe(before);
  });

  sh('remote.<name>.mirror=true injected through git config, then a plain push', () => {
    remoteOnlyBranch();
    expect(R.git(repo, ['config', 'remote.origin.mirror', 'true']).status).toBe(0);
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/refusing a mirror push \(remote\.origin\.mirror is true\)/);
    expect(remoteRefs()).toBe(before);
  });

  sh('git push --force of a rewritten main', () => {
    diverge();
    const before = remoteRefs();
    const r = R.git(repo, ['push', '--force', 'origin', 'main']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/refusing to update refs\/heads\/main: it is not a fast-forward/);
    expect(remoteRefs()).toBe(before);
  });

  sh('a +refspec force push', () => {
    diverge();
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin', '+main:main']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(REFUSED);
    expect(remoteRefs()).toBe(before);
  });

  sh('git push --force-with-lease of a rewritten main', () => {
    diverge();
    const before = remoteRefs();
    const r = R.git(repo, ['push', '--force-with-lease', 'origin', 'main']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(REFUSED);
    expect(remoteRefs()).toBe(before);
  });

  sh('git push --delete and the :ref spelling', () => {
    remoteOnlyBranch();
    const before = remoteRefs();
    for (const args of [['--delete', 'origin', 'keepme'], ['origin', ':keepme']]) {
      const r = R.git(repo, ['push', ...args]);
      expect(r.status, r.out).not.toBe(0);
      expect(r.out).toMatch(/refusing to DELETE refs\/heads\/keepme/);
    }
    expect(remoteRefs()).toBe(before);
  });

  sh('an update whose remote commit this repository does not have (cannot be shown to be a fast-forward) is refused', () => {
    const clone = path.join(tmp.root, 'other');
    expect(R.git(tmp.root, ['clone', '-q', remote, clone]).status).toBe(0);
    R.stage(clone, 'theirs.txt', 'theirs\n');
    const committed = R.git(clone, [...IDENT, 'commit', '-q', '-m', 'theirs'], { env: NO_SCAN });
    expect(committed.status, committed.out).toBe(0);
    expect(R.git(clone, ['push', '-q', 'origin', 'HEAD:main']).status).toBe(0);
    commit(repo, 'mine.txt');
    const before = remoteRefs();
    const r = R.git(repo, ['push', '--force', 'origin', 'main']);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/which this repository does not have/);
    expect(remoteRefs()).toBe(before);
  });

  sh('the audited scan bypass (CLAUDE_COMMIT_NO_SCAN=1) skips the scan only, never the guard', () => {
    remoteOnlyBranch();
    const before = remoteRefs();
    const r = R.git(repo, ['push', '--delete', 'origin', 'keepme'], { env: NO_SCAN });
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/refusing to DELETE refs\/heads\/keepme/);
    expect(remoteRefs()).toBe(before);
  });

  sh('one refused ref refuses the whole push, even beside a fast-forward', () => {
    remoteOnlyBranch();
    commit(repo, 'ff.txt');
    const before = remoteRefs();
    const r = R.git(repo, ['push', 'origin', 'main', ':keepme']);
    expect(r.status, r.out).not.toBe(0);
    expect(remoteRefs()).toBe(before);
  });

  sh('the refusal names the owner override', () => {
    remoteOnlyBranch();
    const r = R.git(repo, ['push', '--delete', 'origin', 'keepme']);
    expect(r.out).toContain('AGENTS_ALLOW_FORCE_PUSH=1 git push');
  });
});

describe('the owner override', () => {
  sh('AGENTS_ALLOW_FORCE_PUSH=1 lets a mirror push through', () => {
    remoteOnlyBranch();
    const r = R.git(repo, ['push', '--mirror', 'origin'], { env: OVERRIDE });
    expect(r.status, r.out).toBe(0);
    expect(remoteRefs()).not.toContain('refs/heads/keepme');
  });

  sh('AGENTS_ALLOW_FORCE_PUSH=1 lets a deletion through', () => {
    remoteOnlyBranch();
    const r = R.git(repo, ['push', '--delete', 'origin', 'keepme'], { env: OVERRIDE });
    expect(r.status, r.out).toBe(0);
    expect(remoteRefs()).not.toContain('keepme');
  });

  sh('AGENTS_ALLOW_FORCE_PUSH=1 lets a force push through, and the scan still runs on it', () => {
    diverge();
    const r = R.git(repo, ['push', '--force', 'origin', 'main'], { env: OVERRIDE });
    expect(r.status, r.out).toBe(0);
    expect(remoteHead()).toBe(localHead());

    R.stage(repo, 'leak.txt', `k=${R.AWS_KEY}\n`);
    expect(R.git(repo, ['commit', '-F', R.writeMessage(tmp.root, 'chore: key\n', `MSG${++counter}`)], { env: NO_SCAN }).status).toBe(0);
    const before = remoteHead();
    const leaked = R.git(repo, ['push', 'origin', 'main'], { env: OVERRIDE });
    expect(leaked.status, leaked.out).not.toBe(0);
    expect(leaked.out).toMatch(/AWS Access Key/);
    expect(remoteHead()).toBe(before);
  });

  sh('only the exact value 1 overrides', () => {
    remoteOnlyBranch();
    for (const value of ['0', 'true', 'yes', '']) {
      const r = R.git(repo, ['push', '--delete', 'origin', 'keepme'], { env: { AGENTS_ALLOW_FORCE_PUSH: value } });
      expect(r.status, `value ${JSON.stringify(value)}: ${r.out}`).not.toBe(0);
    }
  });
});
