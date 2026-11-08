// The real install.js / template-updater.js / uninstall.js entry points put the managed git hooks in place
// (and take them out), end to end, in a temp adopter repository.
//
// Coverage:
//   - install.js into a git repo: both hooks installed, one log line, a raw `git commit -F` of a staged key is
//     blocked by the ADOPTER'S OWN copy of the scanner (the toolkit is really installed there)
//   - template-updater.js update: installs, is idempotent, refreshes an outdated marker hook, reports a foreign hook
//     without touching it and without failing the update
//   - a target that is not a git repository is left alone and the run still succeeds
//   - uninstall.js (apply) removes the marker hooks and nothing else

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { gitAvailable } = require('./_helpers/git-fixture');
const hooks = require('../git-hooks');
const R = require('./_helpers/hook-repo');

const TOOLKIT = path.resolve(__dirname, '..', '..', '..');
const sh = it.skipIf(!gitAvailable());

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'git-hooks-wiring-' }); });
afterEach(() => tmp.cleanup());

function adopter(name = 'adopter') {
  const root = path.join(tmp.root, name);
  fs.mkdirSync(root, { recursive: true });
  R.git(root, ['init', '-q', '-b', 'main']);
  R.git(root, ['config', 'user.email', 'fixture@example.invalid']);
  R.git(root, ['config', 'user.name', 'Fixture']);
  R.git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'app.js'), 'const x = 1;\n');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'version.json'), '{"version":"0.1"}\n');
  R.git(root, ['add', '-A']);
  R.git(root, ['commit', '-q', '-F', R.writeMessage(tmp.root, 'seed\n', 'SEED')]);
  return root;
}

function toolkit(entry, args) {
  const r = spawnSync(process.execPath, [path.join(TOOLKIT, entry), ...args], {
    cwd: TOOLKIT, env: R.cleanEnv(TOOLKIT, { CLAUDE_PROJECT_DIR: TOOLKIT }), encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  expect(r.error).toBeUndefined();
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const hookPath = (root, name) => path.join(root, '.git', 'hooks', name);

describe('install.js', () => {
  sh('installs the hooks in a git target and the adopter\'s own scanner blocks a raw commit of a key', () => {
    const root = adopter();
    const r = toolkit('.agents/core/install.js', [root, '--no-deps']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^Git hooks: wrote .* in \.git\/hooks$/m);
    expect(hooks.isActive(root)).toBe(true);

    R.stage(root, 'config.js', `const k = "${R.CG_KEY}";\n`);
    const blocked = R.git(root, ['commit', '-F', R.writeMessage(tmp.root, 'feat: add config\n')]);
    expect(blocked.status).not.toBe(0);
    expect(blocked.out).toMatch(/Commit blocked/);
    expect(R.git(root, ['log', '-1', '--format=%s']).stdout.trim()).toBe('seed');
  });

  sh('--dry-run reports and writes no hook', () => {
    const root = adopter();
    const r = toolkit('.agents/core/install.js', [root, '--no-deps', '--dry-run']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Git hooks: \(dry run\)/);
    expect(fs.existsSync(hookPath(root, 'pre-commit'))).toBe(false);
  });

  sh('a target that is not a git repository gets one "skipped" line and the install still succeeds', () => {
    const root = path.join(tmp.root, 'plain');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'version.json'), '{"version":"0.1"}\n');
    const r = toolkit('.agents/core/install.js', [root, '--no-deps']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^Git hooks: skipped \(/m);
  });
});

describe('template-updater.js update', () => {
  sh('installs the hooks, then a second update leaves them alone', () => {
    const root = adopter();
    const first = toolkit('.agents/core/template-updater.js', ['update', root, '--merge']);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toMatch(/^Git hooks: wrote .* in \.git\/hooks$/m);
    const second = toolkit('.agents/core/template-updater.js', ['update', root, '--merge']);
    expect(second.code, second.out).toBe(0);
    expect(second.out).toMatch(/^Git hooks: already current in \.git\/hooks$/m);
  });

  sh('refreshes an outdated marker hook', () => {
    const root = adopter();
    toolkit('.agents/core/template-updater.js', ['update', root, '--merge']);
    fs.writeFileSync(hookPath(root, 'commit-msg'), '#!/bin/sh\n# domdhi-agents managed hook: commit-msg v0\nexit 0\n', { mode: 0o755 });
    const r = toolkit('.agents/core/template-updater.js', ['update', root, '--merge']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^Git hooks: wrote commit-msg in \.git\/hooks$/m);
    expect(fs.readFileSync(hookPath(root, 'commit-msg'), 'utf8')).toBe(hooks.renderHook('commit-msg'));
  });

  sh('a foreign hook is reported with the line to add, left untouched, and does not fail the update', () => {
    const root = adopter();
    const foreign = '#!/bin/sh\necho my own hook\n';
    fs.mkdirSync(path.dirname(hookPath(root, 'pre-commit')), { recursive: true });
    fs.writeFileSync(hookPath(root, 'pre-commit'), foreign, { mode: 0o755 });
    const r = toolkit('.agents/core/template-updater.js', ['update', root, '--merge']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(hooks.ownerLine('pre-commit'));
    expect(fs.readFileSync(hookPath(root, 'pre-commit'), 'utf8')).toBe(foreign);
  });

  sh('a husky-style core.hooksPath is never written to and the update still succeeds', () => {
    const root = adopter();
    fs.mkdirSync(path.join(root, '.husky'));
    R.git(root, ['config', 'core.hooksPath', '.husky']);
    const before = fs.readdirSync(path.join(root, '.husky'));
    const r = toolkit('.agents/core/template-updater.js', ['update', root, '--merge']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/core\.hooksPath points to "\.husky"/);
    expect(fs.readdirSync(path.join(root, '.husky'))).toEqual(before);
  });
});

describe('uninstall.js', () => {
  sh('removes the marker hooks after the toolkit files, and a foreign hook stays', () => {
    const root = adopter();
    expect(toolkit('.agents/core/template-updater.js', ['update', root, '--merge']).code).toBe(0);
    fs.writeFileSync(hookPath(root, 'post-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(hooks.isActive(root)).toBe(true);

    const planFile = path.join(tmp.root, 'plan.json');
    const dry = toolkit('.agents/core/uninstall.js', [root, '--source', TOOLKIT]);
    expect(dry.code, dry.out).toBe(0);
    fs.writeFileSync(planFile, dry.out.slice(dry.out.indexOf('{')));
    // Dry run: nothing removed yet.
    expect(fs.existsSync(hookPath(root, 'pre-commit'))).toBe(true);

    const live = toolkit('.agents/core/uninstall.js', [root, '--source', TOOLKIT, '--apply', planFile]);
    expect(live.code, live.out).toBe(0);
    expect(fs.existsSync(hookPath(root, 'pre-commit'))).toBe(false);
    expect(fs.existsSync(hookPath(root, 'commit-msg'))).toBe(false);
    expect(fs.existsSync(hookPath(root, 'post-commit'))).toBe(true);
    expect(JSON.parse(live.out).hooks).toMatchObject({ status: 'removed' });
  });
});
