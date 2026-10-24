// NA7.17: the managed .gitignore block ignores what Playwright writes at runtime
// (.playwright-cli/, .playwright-mcp/) and never the configuration the toolkit installs
// (.playwright/cli.config.json and its templates/root copies). Evidence for the output
// directory names: docs/.output/findings/investigations/261012-na717-evidence/.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { applyManagedBlock } = require('../../../.agents/core/scaffold');

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEMPLATE = fs.readFileSync(path.join(TOOLKIT, '.agents/templates/root/gitignore'), 'utf8');

const CONFIG_PATHS = [
  '.playwright/cli.config.json',
  '.agents/templates/root/.playwright/cli.config.json',
  '.claude/templates/root/.playwright/cli.config.json',
];
const OUTPUT_PATHS = [
  '.playwright-cli/page-2026-02-14T19-22-42-679Z.yml',
  '.playwright-cli/trace/trace-1.zip',
  '.playwright-mcp/console-2026-02-14.log',
  '.playwright-mcp/page-1.yml',
  'packages/web/.playwright-cli/page-1.yml',
  'docs/.output/.state/screenshots/shot.png',
  'test-results/a.png',
  'playwright-report/index.html',
];

// The Playwright lines of the managed block shipped through release 0.5.
const RELEASE_05_BLOCK = '# Runtime artifacts\n/.playwright*/\ntest-results/\nplaywright-report/\n';

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'na717-' }); });

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Rule that ignores `rel`, or null when the path is not ignored (git check-ignore -v exits 1). */
function ignoredBy(root, rel) {
  try { return git(root, ['check-ignore', '-v', '--', rel]).split('\t')[0]; } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

function scratchRepo(gitignoreText) {
  const root = tmp.mkdir('repo');
  git(root, ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, '.gitignore'), gitignoreText);
  return root;
}

describe('managed .gitignore block — Playwright output versus configuration (NA7.17)', () => {
  it('managedBlock_template_ignoresNoWholePlaywrightConfigDirectory', () => {
    const lines = TEMPLATE.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));

    expect(lines).toContain('.playwright-cli/');
    expect(lines).toContain('.playwright-mcp/');
    // Any rule naming the .playwright directory itself (anchored, unanchored, globbed, contents-only) would
    // hide the installed config; the output directories have their own names.
    const hidesConfigDir = lines.filter(line => /^!?\/?\.playwright(?:\*|\/|$)/.test(line));
    expect(hidesConfigDir).toEqual([]);
  });

  it('managedBlock_scratchRepo_configFilesAreNotIgnoredAndOutputIs', () => {
    const root = scratchRepo('node_modules/\n');
    applyManagedBlock(path.join(root, '.gitignore'), TEMPLATE);

    for (const rel of CONFIG_PATHS) expect(ignoredBy(root, rel), rel).toBeNull();
    for (const rel of OUTPUT_PATHS) expect(ignoredBy(root, rel), rel).not.toBeNull();
  });

  it('managedBlock_scratchRepo_untrackedConfigFilesStageWithoutForce', () => {
    const root = scratchRepo('node_modules/\n');
    applyManagedBlock(path.join(root, '.gitignore'), TEMPLATE);
    for (const rel of [...CONFIG_PATHS, ...OUTPUT_PATHS]) {
      fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), '{}\n');
    }

    git(root, ['add', '--', ...CONFIG_PATHS]);

    expect(git(root, ['ls-files']).split('\n').filter(Boolean).sort()).toEqual([...CONFIG_PATHS].sort());
  });

  it('managedBlock_nativeProjection_isTheCanonicalTemplate', () => {
    const projection = fs.readFileSync(path.join(TOOLKIT, '.claude/templates/root/gitignore'), 'utf8');
    expect(projection).toBe(TEMPLATE);
  });

  it('managedBlock_oldBlockBetweenProjectLines_updatesInPlaceAndLeavesProjectLinesByteIdentical', () => {
    const root = tmp.mkdir('adopter');
    const file = path.join(root, '.gitignore');
    const top = '# project rules before the block\nbin/\nobj/\n!keep.me\n';
    const bottom = '\n# project rules after the block\n.playwright*/\n*.user\n';
    fs.writeFileSync(file, top);
    expect(applyManagedBlock(file, RELEASE_05_BLOCK)).toBe('appended');
    fs.appendFileSync(file, bottom);
    const old = fs.readFileSync(file, 'utf8');
    expect(old).toContain('/.playwright*/');

    const action = applyManagedBlock(file, TEMPLATE);

    const updated = fs.readFileSync(file, 'utf8');
    expect(action).toBe('replaced');
    expect(updated.startsWith(top)).toBe(true);
    expect(updated.endsWith(bottom)).toBe(true);
    expect(updated).not.toContain('/.playwright*/');
    expect(updated).toContain('.playwright-cli/\n');
    expect(updated).toContain('.playwright-mcp/\n');
    expect(updated.match(/managed block/g)).toHaveLength(2); // one START and one END marker
    // Idempotent: the next merge changes nothing.
    expect(applyManagedBlock(file, TEMPLATE)).toBe('unchanged');
  });
});
