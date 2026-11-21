// Code review M4: the missing-module rule of `ac-verify red` (inlined in `.agents/core/ac-verify.js`).
// A specifier that names a file the story creates is the red the check exists to prove; anything else stays infrastructure.
// The real-runner cases feed the helper the actual output of node and vitest in a temp repo.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { missingModuleDigest } = require('../ac-verify');
const TOOLKIT_NODE_MODULES = path.resolve('node_modules');
const isWindows = process.platform === 'win32';

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'VITEST' && !k.startsWith('VITEST_') && k !== 'CI'));
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function tempRepo(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'missing-module-')));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const source = (root, extra = {}) => ({ root, created: ['src/m.js'], tests: ['tests/m.test.js'], ...extra });

describe('missingModuleDigest: specifier resolution', () => {
  const output = (specifier) => `Error: Cannot find module '${specifier}'\nRequire stack:\n- /repo/tests/m.test.js\n    at Object.<anonymous> (/repo/tests/m.test.js:2:11)\n`;

  it('resolves a specifier relative to the test file and names the module, the saw text and the test file:line', () => {
    expect(missingModuleDigest(output('../src/m.js'), source('/repo')))
      .toBe('expected module src/m.js | saw Cannot find module | tests/m.test.js:2');
  });

  it.each([
    ['an extensionless relative specifier', '../src/m'],
    ['a specifier relative to the root', 'src/m.js'],
    ['an absolute specifier inside the root (node ESM prints the resolved path)', '/repo/src/m.js'],
  ])('%s resolves to the created file', (_label, specifier) => {
    expect(missingModuleDigest(output(specifier), source('/repo'))).toContain('expected module src/m.js |');
  });

  it('resolves a directory specifier to its created index file and a `.js` import to a created `.ts` source', () => {
    expect(missingModuleDigest(output('../src/pkg'), source('/repo', { created: ['src/pkg/index.js'] }))).toContain('expected module src/pkg/index.js |');
    expect(missingModuleDigest(output('../src/m.js'), source('/repo', { created: ['src/m.ts'] }))).toContain('expected module src/m.ts |');
  });

  it('keeps a missing helper, a package and a path outside the Files list as infrastructure (null)', () => {
    expect(missingModuleDigest(output('./helpers/util'), source('/repo'))).toBeNull();
    expect(missingModuleDigest(output('lodash'), source('/repo'))).toBeNull();
    expect(missingModuleDigest(output('../src/other.js'), source('/repo'))).toBeNull();
  });

  it('an absolute specifier outside the repository root is infrastructure', () => {
    expect(missingModuleDigest(output('/elsewhere/src/m.js'), source('/repo'))).toBeNull();
  });

  it('is null when the story creates no non-test file, or the output names no missing module', () => {
    expect(missingModuleDigest(output('../src/m.js'), source('/repo', { created: [] }))).toBeNull();
    expect(missingModuleDigest('AssertionError: expected 1 to be 2\n', source('/repo'))).toBeNull();
  });

  it('is red only when EVERY missing specifier is a created file (one helper miss keeps it infrastructure)', () => {
    const both = `${output('../src/m.js')}${output('./helpers/util')}`;
    expect(missingModuleDigest(both, source('/repo'))).toBeNull();
    const two = `${output('../src/m.js')}${output('../src/n.js')}`;
    expect(missingModuleDigest(two, source('/repo', { created: ['src/m.js', 'src/n.js'] })))
      .toContain('expected module src/m.js, src/n.js |');
  });

  it('falls back to the first listed test file, then to (see output), when no location is printed', () => {
    expect(missingModuleDigest("Cannot find module '../src/m.js'", source('/repo'))).toBe('expected module src/m.js | saw Cannot find module | tests/m.test.js');
    expect(missingModuleDigest("Cannot find module '../src/m.js'", source('/repo', { tests: [] }))).toBeNull();
    expect(missingModuleDigest("Cannot find module 'src/m.js'", source('/repo', { tests: [] }))).toBe('expected module src/m.js | saw Cannot find module | (see output)');
  });
});

describe('missingModuleDigest: a path alias in tsc (TS2307) output (first adopter run, 2026-11-20)', () => {
  const src = { root: '/repo', created: ['src/app/lib/money/drift.ts', 'src/app/schemas/domain/ledger.ts'], tests: ['src/app/lib/money/__tests__/drift.test.ts'] };
  const tsc = (...specifiers) => specifiers.map((specifier, at) => `app/lib/money/__tests__/drift.test.ts(${at + 2},30): error TS2307: Cannot find module '${specifier}' or its corresponding type declarations.`).join('\n');

  it.each(['~', '@', '#'])('resolves %s/ to the one created file ending with the alias tail', (alias) => {
    expect(missingModuleDigest(tsc(`${alias}/lib/money/drift`), src)).toMatch(/^expected module src\/app\/lib\/money\/drift\.ts \| saw Cannot find module/);
  });

  it('is red only when every aliased module is a created file', () => {
    expect(missingModuleDigest(tsc('~/lib/money/drift', '~/schemas/domain/ledger'), src))
      .toMatch(/^expected module src\/app\/lib\/money\/drift\.ts, src\/app\/schemas\/domain\/ledger\.ts \|/);
    expect(missingModuleDigest(tsc('~/lib/money/drift', '~/lib/money/helper'), src)).toBeNull();
  });

  it('keeps a bare package name and an unmatched alias tail as infrastructure', () => {
    expect(missingModuleDigest(tsc('lodash'), src)).toBeNull();
    expect(missingModuleDigest(tsc('~/lib/nope'), src)).toBeNull();
  });

  it('an alias tail that two created files end with is ambiguous, so infrastructure', () => {
    const twin = { ...src, created: ['src/app/lib/money/drift.ts', 'packages/other/lib/money/drift.ts'] };
    expect(missingModuleDigest(tsc('~/lib/money/drift'), twin)).toBeNull();
  });
});

describe('missingModuleDigest: real runner output', () => {
  it('plain node: the require stack names the test file and line', () => {
    const root = tempRepo({ 'tests/m.test.js': "const m = require('../src/m.js');\nm.add();\n" });
    const run = spawnSync(process.execPath, ['tests/m.test.js'], { cwd: root, encoding: 'utf8' });
    expect(run.status).not.toBe(0);

    const digest = missingModuleDigest((run.stdout + run.stderr).replace(ANSI, ''), source(root));

    expect(digest).toBe('expected module src/m.js | saw Cannot find module | tests/m.test.js:1');
  });

  it('node ESM: the absolute resolved path in the error resolves inside the root', () => {
    const root = tempRepo({ 'tests/m.test.mjs': "import { add } from '../src/m.js';\nadd();\n" });
    const run = spawnSync(process.execPath, ['tests/m.test.mjs'], { cwd: root, encoding: 'utf8' });
    expect(run.status).not.toBe(0);

    const digest = missingModuleDigest((run.stdout + run.stderr).replace(ANSI, ''), source(root, { tests: ['tests/m.test.mjs'] }));

    expect(digest).toMatch(/^expected module src\/m\.js \| saw Cannot find module \| tests\/m\.test\.mjs/);
  });

  it.skipIf(isWindows)('vitest: the `FAIL` suite error resolves and carries the test file:line', () => {
    const root = tempRepo({ 'tests/v.test.js': "import { it, expect } from 'vitest';\nimport { add } from '../src/v.js';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n" });
    fs.symlinkSync(TOOLKIT_NODE_MODULES, path.join(root, 'node_modules'));
    const run = spawnSync(path.join(root, 'node_modules/.bin/vitest'), ['run', 'tests/v.test.js'], { cwd: root, encoding: 'utf8', timeout: 60000, env: cleanEnv() });
    expect(run.status).not.toBe(0);

    const digest = missingModuleDigest((run.stdout + run.stderr).replace(ANSI, ''), { root, created: ['src/v.js'], tests: ['tests/v.test.js'] });

    expect(digest).toBe('expected module src/v.js | saw Cannot find module | tests/v.test.js:2');
  });
});
