// Retired outputs: files the toolkit renamed or dropped are removed from a checkout only when
// provably unedited, and every other one is reported (never deleted, never left unreported).
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { renderSharedAgents, planRetirement, removeRetired, describeRetiredConflict } = require('../_lib/shared-agents');
const { preparePilot, updatePilot, copyToolkit, snapshotDigests, changedPaths } = require('./_helpers/shared-pilot.cjs');
const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sha = text => createHash('sha256').update(text).digest('hex');
const LIST = '.agents/adapters/retired-outputs.json';
let tmp;
let logged;
beforeEach(() => { tmp = createTmpDir(); logged = []; vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.join(' ')); }); });
afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const lexists = (root, rel) => Boolean(fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false }));
const text = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ledgerOf = root => JSON.parse(text(root, '.agents/render-state.json'));
const put = (root, rel, content) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

describe('renderSharedAgents retires renamed toolkit files', () => {
  const SKILL_BODY = '---\nname: old-skill\ndescription: Retired skill.\n---\n\n# Old skill\n';
  const STALE = {
    '.agents/core/old-helper.js': 'old helper\n', '.claude/core/old-helper.js': 'old helper claude\n', '.codex/core/old-helper.js': 'old helper codex\n',
    '.claude/skills/old-skill/SKILL.md': 'old skill native\n', '.claude/commands/old-command.md': 'old command\n',
    '.agents/skills/old-skill/SKILL.md': SKILL_BODY, '.agents/skills/old-skill/references/workflow.md': '# Old workflow\n',
  };
  const entries = () => Object.entries(STALE).map(([rel, body]) => ({ path: rel, digests: [sha(body)], replacedBy: rel.replace('old-', 'new-') }));
  const writeList = (retired) => put(tmp.root, LIST, JSON.stringify({ retired }));

  /** A checkout that rendered the previous release: stale files on disk plus (optionally) ledger entries. */
  function checkout({ ledger = true, retired = entries() } = {}) {
    put(tmp.root, '.agents/core/new-helper.js', "'use strict';\nmodule.exports = { name: 'new-helper' };\n");
    writeList(retired);
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    const state = ledgerOf(tmp.root);
    for (const [rel, body] of Object.entries(STALE)) { put(tmp.root, rel, body); if (ledger && !rel.startsWith('.agents/')) state[rel] = sha(body); }
    fs.writeFileSync(path.join(tmp.root, '.agents/render-state.json'), JSON.stringify(state, null, 2) + '\n');
    return Object.keys(STALE);
  }

  it('dryRun_reportsEveryUneditedRetiredFileAndRemovesNothing', () => {
    const paths = checkout();
    const before = snapshotDigests(tmp.root);
    const result = renderSharedAgents(tmp.root, { dryRun: true });
    expect(result.conflicts).toEqual([]);
    expect(result.retired).toEqual([...paths].sort());
    expect(changedPaths(before, snapshotDigests(tmp.root))).toEqual([]);
  });

  it('render_removesUneditedRetiredFilesTheirLedgerEntriesAndEmptySkillDirectories', () => {
    const paths = checkout();
    const result = renderSharedAgents(tmp.root);
    expect(result.conflicts).toEqual([]);
    for (const rel of paths) { expect(exists(tmp.root, rel), rel).toBe(false); expect(ledgerOf(tmp.root)[rel], rel).toBeUndefined(); }
    expect(exists(tmp.root, '.agents/skills/old-skill')).toBe(false);
    expect(exists(tmp.root, '.claude/skills/old-skill')).toBe(false);
    expect(exists(tmp.root, '.agents/core')).toBe(true);
    expect(exists(tmp.root, '.claude/core/new-helper.js')).toBe(true);
    const again = renderSharedAgents(tmp.root, { dryRun: true });
    expect(again.retired).toBeUndefined();
    expect(again.changed).toEqual([]);
  });

  it('render_retiredFileEditedByTheAdopter_isReportedKeptAndBlocksTheWholeRender', () => {
    const paths = checkout();
    fs.appendFileSync(path.join(tmp.root, '.claude/core/old-helper.js'), '// ADOPTER_EDIT\n');
    for (const dryRun of [true, false]) {
      const result = renderSharedAgents(tmp.root, { dryRun });
      expect(result.conflicts, `dryRun=${dryRun}`).toEqual(['.claude/core/old-helper.js']);
      expect(result.retiredConflicts).toEqual(['.claude/core/old-helper.js']);
    }
    for (const rel of paths) expect(exists(tmp.root, rel), rel).toBe(true);
    expect(text(tmp.root, '.claude/core/old-helper.js')).toContain('ADOPTER_EDIT');
    expect(ledgerOf(tmp.root)['.claude/core/old-helper.js']).toBeTruthy();
  });

  // m1: a restored backup or reset ledger must not wedge the update on files whose shipped bytes are known.
  it('render_nativeFilesWithNoLedgerEntries_areRetiredFromTheirListedHistoricalDigests', () => {
    const paths = checkout({ ledger: false });
    const result = renderSharedAgents(tmp.root);
    expect(result.conflicts).toEqual([]);
    for (const rel of paths) expect(exists(tmp.root, rel), rel).toBe(false);
  });

  it('render_nativeFileWithNoLedgerEntryAndNoListedDigest_isReportedNotDeleted', () => {
    checkout({ ledger: false, retired: entries().map(e => e.path === '.claude/commands/old-command.md' ? { path: e.path, replacedBy: e.replacedBy } : e) });
    const result = renderSharedAgents(tmp.root);
    expect(result.conflicts).toEqual(['.claude/commands/old-command.md']);
    expect(exists(tmp.root, '.claude/commands/old-command.md')).toBe(true);
  });

  it('render_canonicalFileIsNeverVouchedForByTheLedger', () => {
    checkout({ retired: entries().map(e => e.path === '.agents/core/old-helper.js' ? { path: e.path } : e) });
    const state = ledgerOf(tmp.root);
    state['.agents/core/old-helper.js'] = sha(STALE['.agents/core/old-helper.js']);
    fs.writeFileSync(path.join(tmp.root, '.agents/render-state.json'), JSON.stringify(state, null, 2) + '\n');
    expect(renderSharedAgents(tmp.root).conflicts).toEqual(['.agents/core/old-helper.js']);
    expect(exists(tmp.root, '.agents/core/old-helper.js')).toBe(true);
  });

  it('render_editedCanonicalRetiredSkill_isReportedBecauseItsDigestIsNotAShippedVersion', () => {
    checkout();
    fs.appendFileSync(path.join(tmp.root, '.agents/skills/old-skill/SKILL.md'), 'ADOPTER_EDIT\n');
    const result = renderSharedAgents(tmp.root, { files: new Map(), dryRun: true });
    expect(result.conflicts).toEqual(['.agents/skills/old-skill/SKILL.md']);
    expect(exists(tmp.root, '.agents/skills/old-skill/SKILL.md')).toBe(true);
  });

  it('render_listedFileAlreadyGone_onlyForgetsItsLedgerEntry', () => {
    const paths = checkout();
    for (const rel of paths) fs.rmSync(path.join(tmp.root, rel), { force: true });
    const result = renderSharedAgents(tmp.root);
    expect(result.conflicts).toEqual([]);
    expect(result.retired).toBeUndefined();
    for (const rel of paths) expect(ledgerOf(tmp.root)[rel], rel).toBeUndefined();
  });

  // M1: a list entry can only name toolkit-owned template files, wherever the list came from.
  describe('a list entry that is not a toolkit-owned file', () => {
    const REJECTED = [
      ['invalid: parent traversal', '.agents/../outside.js', /invalid retired path/],
      ['invalid: outside the toolkit trees', 'src/app.js', /invalid retired path/],
      ['invalid: a bare directory root', '.claude/', /invalid retired path/],
      ['project settings', '.claude/settings.json', /project-owned, local or state/],
      ['local settings', '.claude/settings.local.json', /project-owned, local or state/],
      ['update config', '.claude/update-config.json', /project-owned, local or state/],
      ['runtime shared-agents settings', '.codex/shared-agents.json', /project-owned, local or state/],
      ['intake identity', '.agents/intake/identity.json', /project-owned, local or state/],
      ['legacy intake policy', '.agents/learning-intake/policy.json', /project-owned, local or state/],
      ['agent memory', '.claude/agent-memory/qa-engineer/MEMORY.md', /project-owned, local or state/],
      ['state directory', '.claude/core/.state/lock.json', /project-owned, local or state/],
      ['the render ledger', '.agents/render-state.json', /project-owned, local or state/],
      ['the retired list itself', LIST, /project-owned, local or state/],
      ['the gate configuration', '.agents/gate.config.json', /project-owned, local or state/],
      ['a mixed-zone role', '.agents/roles/qa-engineer.md', /mixed zone/],
      ['a mixed-zone native agent', '.claude/agents/qa-engineer.md', /mixed zone/],
      ['a project-exception skill', '.agents/skills/brand-guidelines/SKILL.md', /zone, not toolkit-owned/],
      ['an unowned native file', '.claude/README.md', /unknown zone, not toolkit-owned/],
      ['canonical adapters outside the owned trees', '.agents/adapters/workflows.json', /outside the toolkit-owned trees/],
    ];
    it.each(REJECTED)('render_listing_%s_failsClosedAndDeletesNothing', (_label, bad, message) => {
      put(tmp.root, '.agents/core/new-helper.js', "'use strict';\n");
      const body = bad.endsWith('.json') ? '{"roles":{}}\n' : 'adopter-owned bytes\n';
      if (!bad.endsWith('/') && !bad.includes('..')) put(tmp.root, bad, body);
      const ledger = bad.startsWith('.agents/') ? {} : { [bad]: sha(body) };
      fs.writeFileSync(path.join(tmp.root, '.agents/render-state.json'), JSON.stringify(ledger));
      put(tmp.root, LIST, JSON.stringify({ retired: [{ path: bad, digests: [sha(body)] }] }));
      const before = snapshotDigests(tmp.root);
      expect(() => renderSharedAgents(tmp.root)).toThrow(message);
      expect(changedPaths(before, snapshotDigests(tmp.root))).toEqual([]);
    });

    it('render_listingALiveOutput_failsClosedAndDeletesNothing', () => {
      checkout();
      writeList([...entries(), { path: '.claude/core/new-helper.js' }]);
      const before = snapshotDigests(tmp.root);
      expect(() => renderSharedAgents(tmp.root)).toThrow(/still a current output/);
      expect(changedPaths(before, snapshotDigests(tmp.root))).toEqual([]);
    });
  });

  it('render_listingALiveCanonicalSourceOfTheIncomingToolkit_failsClosedAndDeletesNothing', () => {
    const paths = checkout();
    const incoming = text(tmp.root, '.agents/core/new-helper.js');
    writeList([...entries(), { path: '.agents/core/new-helper.js', digests: [sha(incoming)] }]);
    const before = snapshotDigests(tmp.root);
    expect(() => renderSharedAgents(tmp.root, { files: new Map([['.agents/core/new-helper.js', incoming]]) })).toThrow(/canonical source of the toolkit being installed/);
    expect(changedPaths(before, snapshotDigests(tmp.root))).toEqual([]);
    for (const rel of paths) expect(exists(tmp.root, rel), rel).toBe(true);
  });

  // m2: the plan is re-verified when the file is actually removed.
  describe('removeRetired', () => {
    const REL = '.claude/core/old-helper.js';
    const known = [sha('old helper claude\n')];

    it('file_editedAfterPlanning_isKeptAndReportedChanged', () => {
      put(tmp.root, REL, 'old helper claude\n');
      fs.writeFileSync(path.join(tmp.root, REL), 'old helper claude\nEDITED_AFTER_PLAN\n');
      expect(removeRetired(tmp.root, REL, known)).toBe('changed');
      expect(text(tmp.root, REL)).toContain('EDITED_AFTER_PLAN');
    });

    it('file_alreadyGone_isTreatedAsRetiredWithoutThrowing', () => {
      expect(removeRetired(tmp.root, REL, known)).toBe('gone');
    });

    it('file_unchangedSincePlanning_isRemoved', () => {
      put(tmp.root, REL, 'old helper claude\n');
      expect(removeRetired(tmp.root, REL, known)).toBe('removed');
      expect(lexists(tmp.root, REL)).toBe(false);
    });

    it('file_replacedByASymlinkAfterPlanning_isKept', () => {
      const outside = path.join(tmp.root, 'outside.txt');
      fs.writeFileSync(outside, 'old helper claude\n');
      fs.mkdirSync(path.join(tmp.root, '.claude/core'), { recursive: true });
      fs.symlinkSync(outside, path.join(tmp.root, REL));
      expect(removeRetired(tmp.root, REL, known)).toBe('changed');
      expect(fs.existsSync(outside)).toBe(true);
    });
  });

  // m2 through a render: an edit that lands after planning (here, while outputs are being written) is kept.
  it('render_fileEditedBetweenPlanAndRemoval_isReportedAndKeepsItsLedgerEntry', () => {
    checkout();
    put(tmp.root, '.agents/core/another-helper.js', "'use strict';\n");
    const target = path.join(tmp.root, '.claude/core/old-helper.js');
    const original = fs.writeFileSync;
    let raced = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(function (...args) {
      if (!raced) { raced = true; fs.appendFileSync(target, '// RACE_EDIT\n'); }
      return original.apply(this, args);
    });
    const result = renderSharedAgents(tmp.root);
    vi.restoreAllMocks();
    expect(raced).toBe(true);
    expect(result.conflicts).toEqual(['.claude/core/old-helper.js']);
    expect(result.retired).not.toContain('.claude/core/old-helper.js');
    expect(text(tmp.root, '.claude/core/old-helper.js')).toContain('RACE_EDIT');
    expect(ledgerOf(tmp.root)['.claude/core/old-helper.js']).toBe(sha(STALE['.claude/core/old-helper.js']));
    expect(exists(tmp.root, '.codex/core/old-helper.js')).toBe(false);
  });

  // m3: a symlinked ancestor is a conflict with an accurate reason, not an abort of the whole render.
  it('render_symlinkedAncestorOfARetiredFile_isReportedAsAConflictNotAnAbort', () => {
    checkout();
    const outside = path.join(tmp.root, 'outside-skill');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'SKILL.md'), STALE['.claude/skills/old-skill/SKILL.md']);
    fs.rmSync(path.join(tmp.root, '.claude/skills/old-skill'), { recursive: true });
    fs.symlinkSync(outside, path.join(tmp.root, '.claude/skills/old-skill'), 'dir');
    let result;
    expect(() => { result = renderSharedAgents(tmp.root, { dryRun: true }); }).not.toThrow();
    expect(result.conflicts).toContain('.claude/skills/old-skill/SKILL.md');
    expect(result.retiredReasons['.claude/skills/old-skill/SKILL.md']).toMatch(/symlink/);
    expect(describeRetiredConflict(tmp.root, '.claude/skills/old-skill/SKILL.md', result.retiredReasons)).toMatch(/symlink/);
    expect(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8')).toBe(STALE['.claude/skills/old-skill/SKILL.md']);
  });

  // m5: the conflict names where the file went.
  it('describeRetiredConflict_namesTheSuccessorAndOnlyDescribesRetiredFiles', () => {
    checkout();
    const message = describeRetiredConflict(tmp.root, '.agents/skills/old-skill/SKILL.md', { '.agents/skills/old-skill/SKILL.md': 'edited' });
    expect(message).toContain('replaced by .agents/skills/new-skill/SKILL.md');
    expect(message).toContain('edited');
    expect(describeRetiredConflict(tmp.root, '.claude/core/new-helper.js')).toBeNull();
  });

  // N2: pruning follows the file up to its retired skill root and no further.
  it('render_deeplyNestedRetiredSkillFile_leavesNoEmptyDirectoriesAndNeverPrunesAboveTheSkill', () => {
    const nested = '.agents/skills/old-skill/references/deep/er/page.md';
    STALE[nested] = '# Deep\n';
    try {
      checkout();
      put(tmp.root, '.agents/skills/old-skill/references/keep.md', '# Not retired\n');
      renderSharedAgents(tmp.root);
      expect(exists(tmp.root, '.agents/skills/old-skill/references/deep')).toBe(false);
      expect(exists(tmp.root, '.agents/skills/old-skill/references/keep.md')).toBe(true);
      expect(exists(tmp.root, '.agents/skills')).toBe(true);
    } finally { delete STALE[nested]; }
  });

  it('render_retiredSkillWithNothingElseLeft_isRemovedWholeButItsParentSkillsDirectoryStays', () => {
    const nested = '.agents/skills/old-skill/references/deep/er/page.md';
    STALE[nested] = '# Deep\n';
    try {
      checkout();
      renderSharedAgents(tmp.root);
      expect(exists(tmp.root, '.agents/skills/old-skill')).toBe(false);
      expect(exists(tmp.root, '.agents')).toBe(true);
    } finally { delete STALE[nested]; }
  });

  // N3: entries expire, so a project may later reuse a retired path.
  describe('expiry', () => {
    const versionFile = version => put(tmp.root, '.agents/config/version.json', JSON.stringify({ version }));

    it('entryPastItsUntilVersion_isIgnoredSoTheProjectMayReuseThePath', () => {
      const reused = '.claude/commands/old-command.md';
      put(tmp.root, '.agents/core/new-helper.js', "'use strict';\n");
      writeList([{ path: reused, digests: [sha('old command\n')], until: '1.0' }]);
      put(tmp.root, reused, '# The project now owns this command\n');
      versionFile('1.0');
      expect(renderSharedAgents(tmp.root, { dryRun: true }).conflicts).toEqual([reused]);
      versionFile('1.1');
      const result = renderSharedAgents(tmp.root);
      expect(result.conflicts).toEqual([]);
      expect(result.retired).toBeUndefined();
      expect(text(tmp.root, reused)).toBe('# The project now owns this command\n');
    });

    it.each(['1.0', '0.9', '1.0.0'])('entryAtOrBeforeItsUntilVersion_%s_isStillProcessed', (version) => {
      checkout({ retired: entries().map(e => ({ ...e, until: '1.0' })) });
      versionFile(version);
      expect(renderSharedAgents(tmp.root, { dryRun: true }).retired).toHaveLength(Object.keys(STALE).length);
    });

    it('incomingToolkitVersion_decidesExpiryNotTheCheckoutsOwn', () => {
      checkout({ retired: entries().map(e => ({ ...e, until: '1.0' })) });
      versionFile('0.5');
      const files = new Map([['.agents/config/version.json', JSON.stringify({ version: '2.0' })]]);
      expect(renderSharedAgents(tmp.root, { dryRun: true, files }).retired).toBeUndefined();
    });
  });
});

describe('the intake name', () => {
  const { loadExcludedSkills } = require('../template-updater');

  it('exclusionOfTheOldSkillName_carriesOverToTheNewOne', () => {
    put(tmp.root, '.claude/update-config.json', JSON.stringify({ skillExclude: ['learning-intake', 'tailwind-css-patterns'] }));
    expect([...loadExcludedSkills(path.join(tmp.root, '.claude'))].sort()).toEqual(['intake', 'learning-intake', 'tailwind-css-patterns']);
    put(tmp.root, '.claude/update-config.json', JSON.stringify({ skillExclude: ['tailwind-css-patterns'] }));
    expect([...loadExcludedSkills(path.join(tmp.root, '.claude'))]).toEqual(['tailwind-css-patterns']);
  });

  it('theTwoUnrelatedIntakesAreDisambiguatedWhereEachIsDescribed', () => {
    expect(text(toolkitRoot, '.agents/skills/intake/references/workflow.md')).toMatch(/Not to be confused with `\/listen`/);
    expect(text(toolkitRoot, '.agents/skills/listen/references/workflow.md')).toMatch(/Not to be confused with `\/intake`/);
    expect(text(toolkitRoot, '.agents/skills/intake/SKILL.md')).toContain('not `/listen`');
    expect(text(toolkitRoot, 'docs/reference/agents/guides/intake.md')).toContain('Terminology: "intake"');
  });
});

describe('the toolkit retired list', () => {
  const list = () => JSON.parse(fs.readFileSync(path.join(toolkitRoot, LIST), 'utf8'));

  it('namesNoFileTheCurrentToolkitStillShips', () => {
    expect(list().retired.length).toBeGreaterThan(0);
    for (const { path: rel } of list().retired) expect(exists(toolkitRoot, rel), `${rel} is retired and must not ship`).toBe(false);
  });

  it('keepsTheWorkshopRenderCurrent', () => {
    const result = renderSharedAgents(toolkitRoot, { dryRun: true });
    expect(result.conflicts).toEqual([]);
    expect(result.retired).toBeUndefined();
    expect(result.changed).toEqual([]);
  });

  it('givesEveryEntryASuccessorAnExpiryAndHistoricalDigestsForEveryShippedFile', () => {
    for (const entry of list().retired) {
      expect(entry.replacedBy, entry.path).toMatch(/^\.(agents|claude|codex)\//);
      expect(entry.until, entry.path).toMatch(/^\d+(\.\d+)*$/);
      expect(entry.digests?.length, `${entry.path} needs its shipped digests so a missing ledger cannot wedge an update`).toBeGreaterThan(0);
    }
  });

  it('passesItsOwnOwnershipValidation', () => {
    const plan = planRetirement(toolkitRoot, new Map(), {});
    expect(plan.paths.size).toBe(list().retired.length);
  });
});

// The real list against a real old-layout adopter: install the previous release, then run the real update.
const OLD_COMMIT = '69995c59';
const hasOldCommit = (() => { try { execFileSync('git', ['cat-file', '-e', `${OLD_COMMIT}^{commit}`], { cwd: toolkitRoot, stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasOldCommit)('an adopter installed from the pre-rename release', () => {
  let oldRoot;
  const retiredPaths = () => JSON.parse(fs.readFileSync(path.join(toolkitRoot, LIST), 'utf8')).retired.map(entry => entry.path);

  beforeAll(() => {
    oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'domdhi-old-layout-'));
    const archive = execFileSync('git', ['archive', OLD_COMMIT], { cwd: toolkitRoot, maxBuffer: 1 << 28 });
    execFileSync('tar', ['-x', '-C', oldRoot], { input: archive });
  });
  afterAll(() => { fs.rmSync(oldRoot, { recursive: true, force: true }); });

  function adopter({ version } = {}) {
    const { source: oldSource, target } = preparePilot(path.join(tmp.root, 'pilot'), oldRoot);
    const source = path.join(tmp.root, 'new');
    copyToolkit(toolkitRoot, source);
    fs.copyFileSync(path.join(oldSource, '.agents/gate.config.json'), path.join(source, '.agents/gate.config.json'));
    if (version) {
      const file = path.join(source, '.agents/config/version.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version }, null, 2) + '\n');
    }
    for (const rel of retiredPaths()) expect(lexists(target, rel), `${rel} must exist in the old layout`).toBe(true);
    return { source, target };
  }
  const gone = (target) => retiredPaths().filter(rel => lexists(target, rel));
  const REPLACEMENTS = ['.claude/commands/intake.md', '.claude/skills/intake/SKILL.md', '.claude/core/intake.js', '.codex/core/intake.js',
    '.claude/core/_lib/intake-store.js', '.codex/core/_lib/intake-store.js', '.agents/core/intake-github.js'];

  it('update_removesEveryRetiredFileAndShipsTheRenamedOnes', () => {
    const { source, target } = adopter();
    const stats = updatePilot(source, target);
    expect(stats.conflicts).toEqual([]);
    expect(stats.errors).toBe(0);
    expect(gone(target)).toEqual([]);
    for (const rel of ['.claude/skills/learning-intake', '.agents/skills/learning-intake']) expect(lexists(target, rel), rel).toBe(false);
    for (const rel of REPLACEMENTS) expect(exists(target, rel), rel).toBe(true);
    expect(Object.keys(ledgerOf(target)).filter(rel => rel.includes('learning-intake'))).toEqual([]);
    expect(renderSharedAgents(target, { dryRun: true }).changed).toEqual([]);
    expect(updatePilot(source, target).conflicts).toEqual([]);
  });

  it('update_dryRun_changesNoByteAnywhereInTheAdopter', () => {
    const { source, target } = adopter();
    const before = snapshotDigests(target);
    const stats = updatePilot(source, target, { dryRun: true });
    expect(stats.conflicts).toEqual([]);
    expect(changedPaths(before, snapshotDigests(target))).toEqual([]);
    expect(logged.some(line => /PLAN .*learning-intake/.test(line))).toBe(true);
  });

  it('update_editedStaleFile_isReportedWithItsSuccessorKeptAndTheVersionMarkerHeldBack', () => {
    const { source, target } = adopter({ version: '6.5.1' });
    const marker = text(target, '.claude/version.json');
    fs.appendFileSync(path.join(target, '.agents/core/learning-intake.js'), '// ADOPTER_EDIT\n');
    const stats = updatePilot(source, target);
    expect(stats.conflicts).toEqual(['.agents/core/learning-intake.js']);
    expect(gone(target)).toEqual(retiredPaths());
    expect(text(target, '.agents/core/learning-intake.js')).toContain('ADOPTER_EDIT');
    expect(text(target, '.claude/version.json')).toBe(marker);
    expect(logged.join('\n')).toContain('replaced by .agents/core/intake.js');
    // After the adopter moves the change and deletes the file, the same update completes and advances the marker.
    fs.rmSync(path.join(target, '.agents/core/learning-intake.js'));
    expect(updatePilot(source, target).conflicts).toEqual([]);
    expect(text(target, '.claude/version.json')).toContain('6.5.1');
    expect(gone(target)).toEqual([]);
  });

  it('update_editedNativeStaleFile_isReportedAndKept', () => {
    const { source, target } = adopter();
    fs.appendFileSync(path.join(target, '.claude/core/learning-intake.js'), '// ADOPTER_EDIT\n');
    expect(updatePilot(source, target).conflicts).toEqual(['.claude/core/learning-intake.js']);
    expect(gone(target)).toEqual(retiredPaths());
  });

  it('update_missingLedgerEntriesForTheNativeFiles_stillRetiresThemFromTheirHistoricalDigests', () => {
    const { source, target } = adopter();
    const ledger = ledgerOf(target);
    for (const rel of retiredPaths()) delete ledger[rel];
    fs.writeFileSync(path.join(target, '.agents/render-state.json'), JSON.stringify(ledger, null, 2) + '\n');
    const stats = updatePilot(source, target);
    expect(stats.conflicts).toEqual([]);
    expect(gone(target)).toEqual([]);
  });

  it('update_symlinkAtARetiredPath_isReportedAndNeitherItNorItsTargetIsTouched', () => {
    const { source, target } = adopter();
    const outside = path.join(tmp.root, 'outside-command.md');
    fs.copyFileSync(path.join(target, '.claude/commands/learning-intake.md'), outside);
    fs.rmSync(path.join(target, '.claude/commands/learning-intake.md'));
    fs.symlinkSync(outside, path.join(target, '.claude/commands/learning-intake.md'));
    const stats = updatePilot(source, target);
    expect(stats.conflicts).toContain('.claude/commands/learning-intake.md');
    expect(fs.lstatSync(path.join(target, '.claude/commands/learning-intake.md')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    expect(gone(target)).toEqual(retiredPaths());
  });

  it('update_symlinkedDirectoryAboveARetiredFile_isReportedNotAnAbort', () => {
    const { source, target } = adopter();
    const real = path.join(tmp.root, 'real-skill');
    fs.renameSync(path.join(target, '.claude/skills/learning-intake'), real);
    fs.symlinkSync(real, path.join(target, '.claude/skills/learning-intake'), 'dir');
    const stats = updatePilot(source, target);
    expect(stats.conflicts.some(rel => rel.startsWith('.claude/skills/learning-intake/'))).toBe(true);
    expect(fs.existsSync(path.join(real, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.agents/core/learning-intake.js'))).toBe(true);
  });

  it.each([
    ['a project-owned path', '.claude/settings.json', /project-owned, local or state/],
    ['the intake configuration directory', '.agents/intake/policy.json', /project-owned, local or state/],
    ['a current output of the new release', '.claude/core/intake.js', /still a current output/],
  ])('update_listEntryNaming_%s_isRefusedBeforeAnyWrite', (_label, bad, message) => {
    const { source, target } = adopter();
    put(target, '.agents/intake/policy.json', '{"adopter":"policy"}\n');
    const listFile = path.join(source, LIST);
    const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    const body = fs.existsSync(path.join(target, bad)) ? fs.readFileSync(path.join(target, bad), 'utf8') : 'x';
    list.retired.push({ path: bad, digests: [sha(body)] });
    fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
    const before = snapshotDigests(target);
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => updatePilot(source, target)).toThrow(/process\.exit/);
    expect(failures.mock.calls.flat().join('\n')).toMatch(message);
    expect(changedPaths(before, snapshotDigests(target))).toEqual([]);
  });

  it('update_failureHalfwayThrough_isRepairedByTheNextUpdate', () => {
    if (process.getuid && process.getuid() === 0) return;
    const { source, target } = adopter();
    const locked = path.join(target, '.codex/core');
    fs.chmodSync(locked, 0o555);
    try {
      expect(() => updatePilot(source, target)).toThrow(/process\.exit/);
    } finally { fs.chmodSync(locked, 0o755); }
    const stats = updatePilot(source, target);
    expect(stats.conflicts).toEqual([]);
    expect(gone(target)).toEqual([]);
    expect(Object.keys(ledgerOf(target)).filter(rel => rel.includes('learning-intake'))).toEqual([]);
  });

  it('update_lockLeftByACrashedSubmit_staysWhereTheUpgradedStoreLooksForIt', () => {
    const { source, target } = adopter();
    const lock = 'docs/.output/.state/learning-intake/11111111-1111-4111-8111-111111111111.lock.json';
    put(target, lock, '{"crashed":"submit"}\n');
    expect(updatePilot(source, target).conflicts).toEqual([]);
    expect(text(target, lock)).toBe('{"crashed":"submit"}\n');
    const { OUTPUT_PATHS } = require(path.join(target, '.agents/core/constants.js'));
    expect(OUTPUT_PATHS['state/learning-intake'].dir).toBe('.state/learning-intake');
    expect(fs.readFileSync(path.join(target, '.agents/core/_lib/intake-store.js'), 'utf8')).toContain("compartmentDir('state/learning-intake')");
  });

  // m4: the new generic names can collide with an adopter's own files.
  it.each([
    ['command', '.claude/commands/intake.md', '.claude/commands/intake.md'],
    ['native skill', '.claude/skills/intake/SKILL.md', '.claude/skills/intake/'],
    ['canonical skill', '.agents/skills/intake/SKILL.md', '.agents/skills/intake/'],
  ])('update_adopterOwned_%s_namedIntake_isReportedAsAConflictNotOverwritten', (_kind, rel, reported) => {
    const { source, target } = adopter();
    put(target, rel, '# My own intake process\n');
    const stats = updatePilot(source, target);
    expect(stats.conflicts).toContain(reported);
    expect(text(target, rel)).toBe('# My own intake process\n');
    expect(exists(target, '.claude/core/intake.js')).toBe(false);
    expect(gone(target)).toEqual(retiredPaths());
  });

  // m5: an exclusion of the old skill name carries over to the new one.
  it('update_adopterWhoExcludedLearningIntake_doesNotReceiveIntakeButStillLosesTheStaleFiles', () => {
    const { source, target } = adopter();
    put(target, '.claude/update-config.json', JSON.stringify({ skillExclude: ['learning-intake'] }));
    const stats = updatePilot(source, target);
    expect(stats.conflicts).toEqual([]);
    for (const rel of ['.claude/skills/intake', '.agents/skills/intake', '.claude/commands/intake.md']) expect(lexists(target, rel), rel).toBe(false);
    expect(gone(target)).toEqual([]);
  });
});
