// NA5.18: one shared Git-ignored source filter for every front door that walks
// the filesystem (install, update, canonicalFiles and the publisher).
//   AC1 ignored files (info/exclude, .gitignore, ignored directories) are
//       reported; tracked files matching an ignore pattern and untracked
//       non-ignored files are not; a non-Git root reports null.
//   AC2 a failed query inside a real checkout throws the caller's message.
//   AC3 canonicalFiles and commandFiles use the shared filter.
// Wave 15 review: MAJOR-1 (commandFiles), MAJOR-2 (a plain tree nested in an
// unrelated checkout), NIT-4 (inherited location overrides), MINOR-5 (the
// adopter-render conflict fail-safe).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { gitCheckoutRoot, ignoredPaths, ignoredFilter } = require('../../../.agents/core/_lib/git-ignored');
const { canonicalFiles, commandFiles, projectionPaths, renderSharedAgents, syncSharedAgents } = require('../../../.agents/core/_lib/shared-agents');
const { createTmpDir } = require('./_helpers/tmp-dir');

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'git-ignored-test-' }); });
afterEach(() => { tmp.cleanup(); });

const gitEnv = () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp.root, 'empty-gitconfig') };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|TRACE.*)$/.test(key)) delete env[key];
  return env;
};
const gitAt = (root, args) => execFileSync('git', ['-C', root, ...args], { env: gitEnv(), encoding: 'utf8', windowsHide: true });

function seedRepo() {
  tmp.write('empty-gitconfig', '');
  const root = tmp.mkdir('repo');
  gitAt(root, ['init', '--quiet', '--initial-branch=main']);
  tmp.write('repo/.git/info/exclude', '.claude/scheduled_tasks.lock\n.claude/worktrees/\n*.log\n');
  tmp.write('repo/.gitignore', '*.local.*\n');
  tmp.write('repo/.claude/scheduled_tasks.lock', 'LOCAL_SESSION');
  tmp.write('repo/.claude/worktrees/w1/file.txt', 'LOCAL_WORKTREE');
  tmp.write('repo/.agents/config/settings.local.json', 'LOCAL_SETTINGS');
  tmp.write('repo/.agents/skills/demo/SKILL.md', '---\nname: demo\ndescription: Demo.\n---\n\n# Demo\n');
  tmp.write('repo/.agents/skills/demo/notes.log', 'LOCAL_LOG');
  tmp.write('repo/.agents/skills/demo/kept.log', 'tracked despite the pattern');
  tmp.write('repo/.claude/core/new-untracked.js', 'untracked but not ignored');
  tmp.write('repo/.claude/core/tracked.js', 'tracked');
  gitAt(root, ['add', '-f', '--', '.agents/skills/demo/kept.log', '.agents/skills/demo/SKILL.md', '.claude/core/tracked.js']);
  return root;
}

// MAJOR-2 fixtures: one outer checkout that ignores vendor/ and *.log, with a
// plain tree under the ignored directory, a plain tree under an untracked
// (not ignored) directory, and a vendored tree whose content the outer tracks.
function seedOuter() {
  tmp.write('empty-gitconfig', '');
  const outer = tmp.mkdir('outer');
  gitAt(outer, ['init', '--quiet', '--initial-branch=main']);
  tmp.write('outer/.gitignore', 'vendor/\n*.log\n');
  for (const dir of ['vendor', 'extracted', 'tracked']) {
    tmp.write(`outer/${dir}/tool/.claude/core/a.js`, 'payload');
    tmp.write(`outer/${dir}/tool/.claude/core/run.log`, 'payload log');
  }
  gitAt(outer, ['add', '--', 'tracked/tool/.claude/core/a.js']);
  return outer;
}

describe('git-ignored shared filter — NA5.18', () => {
  it('ignoredFilter_reportsIgnoredFilesAndDirectories_butNotTrackedOrUntrackedNonIgnored', () => {
    const root = seedRepo();
    const isIgnored = ignoredFilter(root);
    for (const rel of ['.claude/scheduled_tasks.lock', '.claude/worktrees/w1/file.txt', '.agents/config/settings.local.json', '.agents/skills/demo/notes.log']) {
      expect(isIgnored(rel), rel).toBe(true);
    }
    for (const rel of ['.agents/skills/demo/kept.log', '.agents/skills/demo/SKILL.md', '.claude/core/new-untracked.js']) {
      expect(isIgnored(rel), rel).toBe(false);
    }
    expect(isIgnored('.claude/worktrees-sibling/file.txt')).toBe(false);
  });

  it('ignoredPaths_isRelativeToTheGivenRoot_whenRootIsATrackedSubdirectoryOfTheCheckout', () => {
    const root = seedRepo();
    const ignored = ignoredPaths(path.join(root, '.claude'));
    expect(ignored.files.has('scheduled_tasks.lock')).toBe(true);
    expect(ignored.dirs).toContain('worktrees/');
    expect(gitCheckoutRoot(path.join(root, '.claude'))).toBe(fs.realpathSync(root));
  });

  it('nonGitRoot_reportsNullAndFiltersNothing', () => {
    const plain = tmp.mkdir('plain');
    tmp.write('plain/.claude/scheduled_tasks.lock', 'x');
    expect(gitCheckoutRoot(plain)).toBe(null);
    expect(ignoredPaths(plain)).toBe(null);
    expect(ignoredFilter(plain)('.claude/scheduled_tasks.lock')).toBe(false);
  });

  it('failedQueryInsideARealCheckout_throwsTheCallersMessage', () => {
    const root = seedRepo();
    tmp.write('repo/.git/index', 'not a git index');
    expect(() => ignoredPaths(root, { failureMessage: 'FIXTURE_REFUSAL' })).toThrow('FIXTURE_REFUSAL');
    expect(() => ignoredFilter(root)).toThrow(/^Git ignored-file query failed/);
  });

  it('canonicalFiles_skipsGitIgnoredSourcesButKeepsTrackedPatternMatches', () => {
    const root = seedRepo();
    const files = canonicalFiles(root);
    expect(files).toContain('.agents/skills/demo/SKILL.md');
    expect(files).toContain('.agents/skills/demo/kept.log');
    expect(files).not.toContain('.agents/skills/demo/notes.log');
    expect(files).not.toContain('.agents/config/settings.local.json');
  });

  // MAJOR-2: an outer checkout's ignore rules never apply to a plain tree
  // nested inside it, whether the outer repo ignores that directory or merely
  // leaves it untracked; a tracked vendored subdirectory is still a Git source.
  it('plainTreeInsideAnIgnoredDirectoryOfAnOuterCheckout_isNotAGitSource', () => {
    const outer = seedOuter();
    const tool = path.join(outer, 'vendor/tool');
    expect(gitCheckoutRoot(tool)).toBe(null);
    expect(ignoredPaths(tool)).toBe(null);
    expect(ignoredFilter(tool)('.claude/core/run.log')).toBe(false);
  });

  it('plainTreeInsideAnUntrackedDirectoryOfAnOuterCheckout_keepsFilesTheOuterRulesWouldIgnore', () => {
    const outer = seedOuter();
    const tool = path.join(outer, 'extracted/tool');
    expect(gitCheckoutRoot(tool)).toBe(null);
    expect(ignoredFilter(tool)('.claude/core/run.log')).toBe(false);
  });

  it('trackedVendoredSubdirectory_isStillAGitSourceAndFiltered', () => {
    const outer = seedOuter();
    const tool = path.join(outer, 'tracked/tool');
    expect(gitCheckoutRoot(tool)).toBe(fs.realpathSync(outer));
    const isIgnored = ignoredFilter(tool);
    expect(isIgnored('.claude/core/run.log')).toBe(true);
    expect(isIgnored('.claude/core/a.js')).toBe(false);
  });

  // NIT-4: an inherited location override would aim the query at another
  // repository; a Git source refuses it, a plain tree is unaffected.
  it('inheritedGitLocationOverride_refusesForAGitSource_butNotForAPlainTree', () => {
    const root = seedRepo();
    const plain = tmp.mkdir('plain-tree');
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(tmp.root, 'elsewhere', '.git');
    try {
      expect(() => ignoredPaths(root, { failureMessage: 'FIXTURE_REFUSAL' })).toThrow(/^FIXTURE_REFUSAL Inherited Git location override present: GIT_DIR\./);
      expect(ignoredPaths(plain)).toBe(null);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
    }
  });

  // MAJOR-1: an ignored local command must not become a selector skill in the
  // source projection or in an adopter through the shared update.
  it('commandFiles_skipsAnIgnoredCommand_soNoSelectorReachesTheSourceProjectionOrAnAdopter', () => {
    const root = seedRepo();
    tmp.write('repo/.claude/commands/.gitignore', 'private-local.md\n');
    tmp.write('repo/.claude/commands/private-local.md', '---\ndescription: Local only.\n---\n\nPRIVATE_LOCAL_COMMAND\n');
    tmp.write('repo/.claude/commands/team-shared.md', '---\ndescription: Shared.\n---\n\nTEAM_SHARED_COMMAND\n');
    expect(commandFiles(root)).toContain('.claude/commands/team-shared.md');
    expect(commandFiles(root)).not.toContain('.claude/commands/private-local.md');
    const projections = [...projectionPaths(root)];
    expect(projections.some(p => p.includes('private-local'))).toBe(false);
    expect(projections.some(p => p.includes('team-shared'))).toBe(true);

    const target = tmp.mkdir('adopter');
    tmp.write('adopter/.claude/settings.json', '{}\n');
    const result = syncSharedAgents(root, target, {});
    expect(result.conflicts).toEqual([]);
    expect(fs.existsSync(path.join(target, '.agents/skills/private-local/SKILL.md'))).toBe(false);
    expect(fs.readFileSync(path.join(target, '.agents/skills/team-shared/SKILL.md'), 'utf8')).toContain('team-shared');
  });

  // MINOR-5 (explicit decision, amended by the repeated-update fix): adopter renders filter too. A
  // projection rendered before its source became ignored stops being an output and is left in place;
  // nothing is written or deleted. Unchanged, it is not a conflict (a project's own ignore rule must not
  // make every later update refuse); edited, it is still reported.
  it('adopterRender_projectionWhoseSourceBecameIgnored_isLeftInPlaceAndNothingIsWritten', () => {
    const root = seedRepo();
    tmp.write('repo/.agents/skills/local-only/SKILL.md', '---\nname: local-only\ndescription: Local.\n---\n\n# Local only\n');
    const first = renderSharedAgents(root);
    expect(first.conflicts).toEqual([]);
    const projection = path.join(root, '.claude/skills/local-only/SKILL.md');
    const before = fs.readFileSync(projection);
    fs.appendFileSync(path.join(root, '.git/info/exclude'), '.agents/skills/local-only/\n');

    const second = renderSharedAgents(root);

    expect(second.conflicts).toEqual([]);
    expect(second.changed).toEqual([]);
    expect(fs.readFileSync(projection)).toEqual(before);
  });

  it('adopterRender_editedProjectionWhoseSourceBecameIgnored_isAConflictAndNothingIsWritten', () => {
    const root = seedRepo();
    tmp.write('repo/.agents/skills/local-only/SKILL.md', '---\nname: local-only\ndescription: Local.\n---\n\n# Local only\n');
    expect(renderSharedAgents(root).conflicts).toEqual([]);
    const projection = path.join(root, '.claude/skills/local-only/SKILL.md');
    fs.appendFileSync(projection, '\nLOCAL_EDIT\n');
    const edited = fs.readFileSync(projection);
    fs.appendFileSync(path.join(root, '.git/info/exclude'), '.agents/skills/local-only/\n');

    const second = renderSharedAgents(root);

    expect(second.conflicts).toContain('.claude/skills/local-only/SKILL.md');
    expect(second.changed).toEqual([]);
    expect(fs.readFileSync(projection)).toEqual(edited);
  });
});
