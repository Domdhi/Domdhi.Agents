// NA7.18 / NA7.19: an ignore rule that hides a file the toolkit manages is named in the update output
// (and in fleet status, see tools/__tests__/fleet.test.js), and an adopter that carries Platform's
// unanchored .playwright*/ line still installs, updates and repeats cleanly without organization flags.

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { hiddenManagedFiles, describeHidden, managedFiles } = require('../../../.agents/core/_lib/ignored-managed');
const { applyManagedBlock } = require('../../../.agents/core/scaffold');

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NOTICE = /Ignore rules hide managed files/;
const PLATFORM_LINES = '# Playwright\n!.claude/templates/root/.playwright/\n.playwright*/\n';
const CONFIG = '.playwright/cli.config.json';
const CLAUDE_COPY = '.claude/templates/root/.playwright/cli.config.json';
const AGENTS_COPY = '.agents/templates/root/.playwright/cli.config.json';

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'na718-' }); });

function cliEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) || key === 'CLAUDE_PROJECT_DIR' || key === 'AGENTS_RUNTIME' || key === 'AGENT_RUNTIME') delete env[key];
  }
  return { ...env, ...extra };
}

function runEntry(entry, args) {
  const result = spawnSync(process.execPath, [path.join(TOOLKIT, entry), ...args], {
    cwd: TOOLKIT, env: cliEnv(), encoding: 'utf8', timeout: 90000,
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function gitAt(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    env: cliEnv({ GIT_CONFIG_NOSYSTEM: '1' }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function snapshotTree(root) {
  const files = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (entry.isDirectory()) { files[`${rel}/`] = 'directory'; walk(abs); }
      else files[rel] = fs.readFileSync(abs).toString('base64');
    }
  })(root);
  return files;
}

function seedRepo(root, gitignore) {
  fs.mkdirSync(root, { recursive: true });
  gitAt(root, ['init', '--initial-branch=main']);
  gitAt(root, ['config', 'user.name', 'Fixture Maintainer']);
  gitAt(root, ['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), '# Project baseline\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# PROJECT_OWNED_INSTRUCTIONS\n\nKeep this project rule.\n');
  const add = ['README.md', 'CLAUDE.md'];
  if (gitignore !== null) { fs.writeFileSync(path.join(root, '.gitignore'), gitignore); add.push('.gitignore'); }
  gitAt(root, ['add', '--', ...add]);
  gitAt(root, ['commit', '-m', 'adopter baseline']);
  return root;
}

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

/** A checkout holding a ledger and the three Playwright config files, all untracked. */
function ledgerAdopter(gitignore) {
  const root = seedRepo(path.join(tmp.root, 'ledger-adopter'), gitignore);
  write(root, '.agents/render-state.json', JSON.stringify({
    [CLAUDE_COPY]: 'x', [AGENTS_COPY]: 'x', '.claude/skills/a/SKILL.md': 'y', '.claude/missing.md': 'z',
  }));
  write(root, CLAUDE_COPY, '{}\n');
  write(root, AGENTS_COPY, '{}\n');
  write(root, CONFIG, '{}\n'); // seeded at the project root from the template root
  write(root, '.claude/skills/a/SKILL.md', '# a\n');
  return root;
}

describe('hiddenManagedFiles — NA7.18', () => {
  it('managedFiles_ledgerFixedAndSeededRootFiles_listsOnlyWhatIsOnDisk', () => {
    const root = ledgerAdopter(null);
    write(root, '.claude/version.json', '{}\n');
    expect(managedFiles(root)).toEqual([
      '.agents/render-state.json', AGENTS_COPY, CLAUDE_COPY, '.claude/skills/a/SKILL.md', '.claude/version.json', CONFIG,
    ].sort());
  });

  it('hiddenManagedFiles_projectRule_namesPathSourceLineAndPattern', () => {
    const root = ledgerAdopter(`node_modules/\n${PLATFORM_LINES}`);

    const result = hiddenManagedFiles(root);

    expect(result.unavailable).toBeNull();
    expect(result.hidden).toEqual([
      { path: AGENTS_COPY, source: '.gitignore', line: 4, pattern: '.playwright*/', origin: 'project' },
      { path: CLAUDE_COPY, source: '.gitignore', line: 4, pattern: '.playwright*/', origin: 'project' },
      { path: CONFIG, source: '.gitignore', line: 4, pattern: '.playwright*/', origin: 'project' },
    ]);
  });

  it('hiddenManagedFiles_noHidingRule_reportsNothing', () => {
    const root = ledgerAdopter('node_modules/\n');
    expect(hiddenManagedFiles(root)).toEqual({ hidden: [], unavailable: null });
    expect(describeHidden(hiddenManagedFiles(root))).toEqual([]);
  });

  it('hiddenManagedFiles_trackedFile_isNotReportedEvenWhenARuleMatchesIt', () => {
    const root = ledgerAdopter(`${PLATFORM_LINES}`);
    gitAt(root, ['add', '-f', '--', CLAUDE_COPY]);

    const paths = hiddenManagedFiles(root).hidden.map(item => item.path);

    expect(paths).not.toContain(CLAUDE_COPY);
    expect(paths).toContain(AGENTS_COPY);
  });

  it('hiddenManagedFiles_ruleInsideTheManagedBlock_isClassifiedAsManagedBlock', () => {
    const root = ledgerAdopter('bin/\n');
    applyManagedBlock(path.join(root, '.gitignore'), '# old block\n/.playwright*/\n');
    fs.appendFileSync(path.join(root, '.gitignore'), '*.user\n');

    const result = hiddenManagedFiles(root);

    expect(result.hidden.length).toBeGreaterThan(0);
    for (const item of result.hidden) {
      expect(item).toMatchObject({ source: '.gitignore', pattern: '/.playwright*/', origin: 'managed-block' });
    }
    expect(result.hidden.map(item => item.path)).toContain(CONFIG);
  });

  it('hiddenManagedFiles_notAGitCheckout_reportsNothing', () => {
    const root = path.join(tmp.root, 'plain');
    write(root, '.agents/render-state.json', JSON.stringify({ [CLAUDE_COPY]: 'x' }));
    write(root, CLAUDE_COPY, '{}\n');
    write(root, '.gitignore', PLATFORM_LINES);

    expect(hiddenManagedFiles(root)).toEqual({ hidden: [], unavailable: null });
  });

  it('describeHidden_groupsByRuleAndNamesHowToResolve', () => {
    const lines = describeHidden(hiddenManagedFiles(ledgerAdopter(`${PLATFORM_LINES}`)));

    const text = lines.join('\n');
    expect(text).toMatch(NOTICE);
    expect(text).toContain('.gitignore:3 ".playwright*/" (project-owned rule) hides 3 managed files:');
    expect(text).toContain(`      ${CONFIG}`);
    expect(text).toMatch(/Resolve a project-owned rule: narrow or remove it where it is defined/);
    expect(text).toMatch(/check-ignore -v <path>/);
    expect(lines.filter(line => line.includes('.gitignore:3'))).toHaveLength(1);
  });

  it('describeHidden_unavailableQuery_isOneNoteLineNeverAThrow', () => {
    expect(describeHidden({ hidden: [], unavailable: 'Git ignored-file query failed' }))
      .toEqual(['NOTE     could not check for ignore rules that hide managed files (Git ignored-file query failed)']);
  });
});

describe('update and install with an unanchored .playwright*/ project line — NA7.18, NA7.19', () => {
  const OPS = {
    install: { scope: ['.agents', '.claude', '.codex', '.gitignore', '.playwright', 'AGENTS.md', 'CLAUDE.md', 'docs'] },
    update: { scope: ['.agents', '.claude', '.codex', '.gitignore', 'AGENTS.md', 'CLAUDE.md'] },
  };

  function policyFor(root, target) {
    const policyPath = path.join(root, 'policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
      schemaVersion: 1, trustedRoots: [root], allowedAzureOrganizations: ['fixture-internal'],
      targets: [{
        id: 'Internal.App', name: path.basename(target), path: target, branch: 'main', mode: 'fixture',
        remote: { organization: 'fixture-internal', project: 'Engineering', repository: 'Internal.App' },
        operations: OPS, localException: { reason: 'Disposable NA7.18 adopter checkout', operations: Object.keys(OPS) },
      }],
    }, null, 2));
    return policyPath;
  }

  function adopter(gitignore) {
    const root = fs.realpathSync.native(tmp.mkdir('run'));
    const target = seedRepo(path.join(root, 'Internal.App'), gitignore);
    return { root, target, policy: policyFor(root, target) };
  }

  const args = (target, policy, extra = []) => ['update', target, ...extra];
  const install = (target, policy) => runEntry('.codex/core/install.js', [target]);

  it('installUpdateRepeat_platformShapedGitignore_areCleanAndTheRepeatIsANoOp', () => {
    const { target, policy } = adopter(PLATFORM_LINES);

    const installed = install(target, policy);
    expect(installed.code, installed.output).toBe(0);
    const afterInstall = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
    expect(afterInstall.startsWith(PLATFORM_LINES)).toBe(true);
    expect(afterInstall).toMatch(/\.playwright-cli\/\n/);
    expect(afterInstall).not.toContain('/.playwright*/');

    const first = runEntry('.agents/core/template-updater.js', args(target, policy));
    expect(first.code, first.output).toBe(0);
    expect(first.output).not.toMatch(/CONFLICT|INCOMPLETE|REFUSED/);
    expect(fs.readFileSync(path.join(target, '.gitignore'), 'utf8').startsWith(PLATFORM_LINES)).toBe(true);
    const settled = snapshotTree(target);

    const second = runEntry('.agents/core/template-updater.js', args(target, policy));

    expect(second.code, second.output).toBe(0);
    expect(second.output).not.toMatch(/CONFLICT|INCOMPLETE|REFUSED/);
    expect(second.output).toMatch(/Copied\s*: 0\n\s*Merged\s*: 0/);
    expect(second.output).toMatch(/Warned\s*: 0/);
    expect(snapshotTree(target)).toEqual(settled);
  }, 240000);

  it('update_platformShapedGitignore_namesTheProjectLineForEveryHiddenManagedFile', () => {
    const { target, policy } = adopter(PLATFORM_LINES);
    expect(install(target, policy).code).toBe(0);
    const before = snapshotTree(target);

    const dryRun = runEntry('.agents/core/template-updater.js', args(target, policy, ['--dry-run']));

    expect(dryRun.code, dryRun.output).toBe(0);
    expect(dryRun.output).toMatch(NOTICE);
    expect(dryRun.output).toContain('.gitignore:3 ".playwright*/" (project-owned rule) hides');
    for (const rel of [CONFIG, CLAUDE_COPY, AGENTS_COPY]) expect(dryRun.output, rel).toContain(`      ${rel}`);
    expect(dryRun.output).toMatch(/Resolve a project-owned rule/);
    expect(dryRun.output).toMatch(/Warned\s*: 0/);
    expect(snapshotTree(target)).toEqual(before);
  }, 240000);

  it('update_sameAdopterWithoutTheHidingRule_printsNoNotice', () => {
    const { target, policy } = adopter('bin/\nobj/\n');
    expect(install(target, policy).code).toBe(0);

    const live = runEntry('.agents/core/template-updater.js', args(target, policy));
    const dryRun = runEntry('.agents/core/template-updater.js', args(target, policy, ['--dry-run']));

    for (const run of [live, dryRun]) {
      expect(run.code, run.output).toBe(0);
      expect(run.output).not.toMatch(NOTICE);
    }
    // The installed managed config is visible to Git without a force add.
    expect(gitAt(target, ['ls-files', '--others', '--exclude-standard', '--', CONFIG, CLAUDE_COPY, AGENTS_COPY]).split('\n').sort())
      .toEqual([AGENTS_COPY, CLAUDE_COPY, CONFIG].sort());
  }, 240000);

  it('update_projectOnlyRuleWithAChangingBlock_dryRunDoesNotClaimTheBlockWillChangeTheRule', () => {
    const { target, policy } = adopter(PLATFORM_LINES);
    expect(install(target, policy).code).toBe(0);
    expect(applyManagedBlock(path.join(target, '.gitignore'), '# stale block without a Playwright rule\n')).toBe('replaced');

    const dryRun = runEntry('.agents/core/template-updater.js', args(target, policy, ['--dry-run']));

    expect(dryRun.code, dryRun.output).toBe(0);
    expect(dryRun.output).toMatch(NOTICE);
    expect(dryRun.output).toMatch(/MERGE\s+\.gitignore \(managed block/);
    expect(dryRun.output).not.toMatch(/dry run: the managed \.gitignore block change/);
  }, 240000);

  it('update_oldManagedBlockHidingTheConfig_dryRunNamesItAndLiveUpdateRepairsIt', () => {
    const { target, policy } = adopter('bin/\n');
    expect(install(target, policy).code).toBe(0);
    const ignoreFile = path.join(target, '.gitignore');
    // Put the release 0.5 block back, as an adopter installed from an earlier release has it.
    expect(applyManagedBlock(ignoreFile, '# Runtime artifacts\n/.playwright*/\ntest-results/\n')).toBe('replaced');
    expect(gitAt(target, ['check-ignore', '-v', '--', CONFIG])).toContain('/.playwright*/');

    const dryRun = runEntry('.agents/core/template-updater.js', args(target, policy, ['--dry-run']));
    expect(dryRun.code, dryRun.output).toBe(0);
    expect(dryRun.output).toContain('"/.playwright*/" (rule inside the toolkit\'s managed block) hides 1 managed file');
    expect(dryRun.output).toMatch(/dry run: the managed \.gitignore block change planned above is not applied/);

    const live = runEntry('.agents/core/template-updater.js', args(target, policy));
    expect(live.code, live.output).toBe(0);
    expect(live.output).not.toMatch(NOTICE);
    expect(fs.readFileSync(ignoreFile, 'utf8').startsWith('bin/\n')).toBe(true);
    expect(() => gitAt(target, ['check-ignore', '-q', '--', CONFIG])).toThrow();
  }, 240000);
});

describe('hiddenManagedFiles edge cases — NA7.18 review', () => {
  const ledgerOf = (root, rels) => {
    write(root, '.agents/render-state.json', JSON.stringify(Object.fromEntries(rels.map(rel => [rel, 'x']))));
    for (const rel of rels) write(root, rel, '# managed\n');
  };

  it('hiddenManagedFiles_failedQuery_returnsUnavailableAndNeverThrows', () => {
    const root = ledgerAdopter(PLATFORM_LINES);
    process.env.GIT_DIR = path.join(root, 'elsewhere');
    let result;
    try { result = hiddenManagedFiles(root); } finally { delete process.env.GIT_DIR; }

    expect(result.hidden).toEqual([]);
    expect(result.unavailable).toMatch(/Inherited Git location override present: GIT_DIR/);
    expect(describeHidden(result)).toEqual([`NOTE     could not check for ignore rules that hide managed files (${result.unavailable})`]);
  });

  it('hiddenManagedFiles_pathReIncludedByANegation_isNotReported', () => {
    const root = seedRepo(path.join(tmp.root, 'negated'), '.claude/skills/*\n!.claude/skills/a/\n');
    ledgerOf(root, ['.claude/skills/a/SKILL.md', '.claude/skills/b/SKILL.md']);

    const hidden = hiddenManagedFiles(root).hidden;

    expect(hidden.map(item => item.path)).toEqual(['.claude/skills/b/SKILL.md']);
    expect(hidden[0]).toMatchObject({ source: '.gitignore', line: 1, pattern: '.claude/skills/*', origin: 'project' });
  });

  it('hiddenManagedFiles_moreThanOneQueryChunk_reportsEveryPath', () => {
    const root = seedRepo(path.join(tmp.root, 'bulk'), 'bulk/\n');
    const rels = Array.from({ length: 250 }, (_, index) => `bulk/file-${String(index).padStart(3, '0')}.md`);
    ledgerOf(root, rels);

    const hidden = hiddenManagedFiles(root).hidden;

    expect(hidden.map(item => item.path).sort()).toEqual(rels);
    expect(hidden.every(item => item.line === 1 && item.pattern === 'bulk/')).toBe(true);
  });

  it('describeHidden_morePathsThanTheCap_listsFiveAndCountsTheRest', () => {
    const hidden = Array.from({ length: 7 }, (_, index) => ({ path: `bulk/${index}.md`, source: '.gitignore', line: 1, pattern: 'bulk/', origin: 'project' }));

    const lines = describeHidden({ hidden, unavailable: null });

    expect(lines.filter(line => /^ {6}bulk\//.test(line))).toHaveLength(5);
    expect(lines).toContain('      ... and 2 more');
    expect(lines.join('\n')).toContain('hides 7 managed files:');
  });

  it('hiddenManagedFiles_crlfGitignoreWithTheBlock_classifiesTheRuleAsManagedBlock', () => {
    const root = ledgerAdopter('bin/\n');
    const ignoreFile = path.join(root, '.gitignore');
    applyManagedBlock(ignoreFile, '# old block\n/.playwright*/\n');
    fs.writeFileSync(ignoreFile, fs.readFileSync(ignoreFile, 'utf8').replace(/\n/g, '\r\n'));

    const hidden = hiddenManagedFiles(root).hidden;

    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every(item => item.origin === 'managed-block' && item.source === '.gitignore')).toBe(true);
  });

  it('hiddenManagedFiles_namesWithSpacesQuotesAndUnicode_areReportedExactly', () => {
    const rels = ["dir with space/a'b [x] #1.md", 'ünï/ö.md'];
    const root = seedRepo(path.join(tmp.root, 'names'), 'dir with space/\nünï/\n');
    ledgerOf(root, rels);

    expect(hiddenManagedFiles(root).hidden.map(item => item.path).sort()).toEqual([...rels].sort());
  });

  it('hiddenManagedFiles_ruleFromGitInfoExclude_isNamedWithThatSourceAsProjectOwned', () => {
    const root = seedRepo(path.join(tmp.root, 'exclude'), null);
    write(root, '.git/info/exclude', '# local\nbulk/\n');
    ledgerOf(root, ['bulk/a.md']);

    expect(hiddenManagedFiles(root).hidden).toEqual([
      { path: 'bulk/a.md', source: '.git/info/exclude', line: 2, pattern: 'bulk/', origin: 'project' },
    ]);
  });

  it('hiddenManagedFiles_adopterNestedInAnotherCheckout_namesTheRuleRelativeToTheAdopter', () => {
    const outer = seedRepo(path.join(tmp.root, 'outer'), null);
    const root = path.join(outer, 'adopter');
    write(root, 'README.md', '# nested adopter\n');
    gitAt(outer, ['add', '--', 'adopter/README.md']);
    gitAt(outer, ['commit', '-m', 'nested adopter']);
    write(root, '.gitignore', 'bin/\n');
    applyManagedBlock(path.join(root, '.gitignore'), '# old block\n/.playwright*/\n');
    ledgerOf(root, ['.playwright/cli.config.json']);

    const hidden = hiddenManagedFiles(root).hidden;

    expect(hidden).toEqual([
      { path: '.playwright/cli.config.json', source: '.gitignore', line: 5, pattern: '/.playwright*/', origin: 'managed-block' },
    ]);
  });

  it('hiddenManagedFiles_enclosingCheckoutsRuleAtALineInsideTheBlock_isProjectOwnedAndNamedOutsideTheAdopter', () => {
    const outer = seedRepo(path.join(tmp.root, 'outer2'), 'a/\nb/\nc/\nd/\n.playwright/\n');
    const root = path.join(outer, 'adopter');
    write(root, 'README.md', '# nested adopter\n');
    gitAt(outer, ['add', '--', 'adopter/README.md']);
    gitAt(outer, ['commit', '-m', 'nested adopter']);
    write(root, '.gitignore', 'bin/\n');
    // The adopter's block spans lines 3 to 7, so line 5 of the ENCLOSING file falls inside its range.
    applyManagedBlock(path.join(root, '.gitignore'), '# one\n# two\n# three\n');
    ledgerOf(root, ['.playwright/cli.config.json']);

    const hidden = hiddenManagedFiles(root).hidden;

    expect(hidden).toEqual([
      { path: '.playwright/cli.config.json', source: '../.gitignore', line: 5, pattern: '.playwright/', origin: 'project' },
    ]);
  });
});

describe('git() input option — NA7.18 review', () => {
  const { git } = require('../../../.agents/core/_lib/git');
  const blobHash = text => require('node:crypto').createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');

  it('git_inputGiven_isWrittenToStdin', () => {
    expect(git(['hash-object', '--stdin'], { cwd: tmp.root, input: 'abc' })).toBe(blobHash('abc'));
  });

  it('git_noInput_leavesStdinClosedSoTheQueryReadsNothing', () => {
    expect(git(['hash-object', '--stdin'], { cwd: tmp.root })).toBe(blobHash(''));
  });
});
