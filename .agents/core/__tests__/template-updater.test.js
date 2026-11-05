// AC→source map (TDD-3.4 / template-updater):
//   - classifyClaudeFile returns: 'template' | 'project' | 'project-exception' | 'mixed' | 'unknown'
//   - parseAgentSections returns: { frontmatter, soulZone, skillsZone, projectCtx }
//   - mergeAgentFile: personalized dest preserves soulZone; skills always from src
//   - walkDir skips ALWAYS_SKIP_DIRS = ['__tests__', '_helpers', 'node_modules']
//   - --dry-run via runUpdate(path, { dryRun: true }) — walks + classifies, no writes
//   - globToRegex: *.md matches flat, **/*.md matches nested

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const updater = require('../../../.agents/core/template-updater');
const { createTmpDir } = require('./_helpers/tmp-dir');

const {
  globToRegex,
  classifyClaudeFile,
  parseAgentSections,
  mergeAgentFile,
  walkDir,
  runUpdate,
  loadExcludedSkills,
  listSkillDirs,
} = updater;

const nodeFs = require('node:fs');
const { renderSharedAgents } = require('../../../.agents/core/_lib/shared-agents');
const { runInstall } = require('../../../.agents/core/install');
const { prepareReleasePair, updatePilot, snapshotDigests, changedPaths } = require('./_helpers/shared-pilot.cjs');

let tmp;

beforeEach(() => {
  tmp = createTmpDir();
});

// CLI fixtures use ordinary non-Git projects, with no distribution declaration.
function permitUpdate(target) {
  return { target: fs.realpathSync.native(target), args: [], env: cliEnv() };
}

afterEach(() => {
  tmp.cleanup();
});

// SA-2: exercise the ordinary update front door, without a migration-history file.
describe('canonical shared updates', () => {
  const role = '---\nname: qa-engineer\nnickname: Murphy\ndescription: QA role.\nskills:\n  - review-specialize\n---\n\n# Murphy\n\nTemplate soul.\n\n## Skills\n\nSHARED_V1\n';
  const skill = '---\nname: review-specialize\ndescription: Use when specializing projects.\n---\n\n# Specialize\n\n## Rules\n\nSHARED_V1\n';
  function seed() {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'target with spaces');
    tmp.write('source/.agents/roles/qa-engineer.md', role);
    tmp.write('source/.agents/skills/review-specialize/SKILL.md', skill);
    tmp.write('source/.claude/shared-agents.json', '{"roles":{"qa-engineer":{"model":"sonnet"}}}\n');
    tmp.write('source/.codex/shared-agents.json', '{"roles":{"qa-engineer":{}}}\n');
    tmp.write('source/.claude/settings.json', '{"hooks":{},"permissions":{"allow":[]}}\n');
    tmp.write('target with spaces/.claude/settings.local.json', '{"local":"KEEP_LOCAL"}\n');
    tmp.write('target with spaces/.claude/settings.json', '{"hooks":{},"permissions":{"allow":["KEEP_TRUST"]},"env":{"LOCAL":"KEEP_ENV"}}\n');
    tmp.write('target with spaces/.codex/config.toml', '# KEEP_CODEX_LOCAL\n');
    return { source, target };
  }
  function update(source, target, options = {}) {
    const old = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = source;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { return runUpdate(target, { merge: true, ...options }); }
    finally { log.mockRestore(); if (old === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = old; }
  }

  it.each([
    '.agents/core/local-probe.js',
    '.agents/hooks/local-probe.cjs',
    '.agents/templates/local-probe.txt',
    '.agents/config/local-probe.json',
    '.agents/adapters/local-probe.json',
  ])('update_editRenderUpdate_preservesIncomingBaselineAndRefusesLocalChangesTo %s', rel => {
    const { source, target } = seed();
    tmp.write('source/.agents/config/version.json', '{"version":"test-release"}\n');
    const original = '"RELEASE_V1"\n';
    const local = '"LOCAL_BEHAVIOR"\n';
    tmp.write(`source/${rel}`, original);
    expect(update(source, target).conflicts).toEqual([]);
    // Exercise an ordinary second update before editing, rather than only install/render.
    tmp.write(`source/${rel}`, '"RELEASE_V2"\n');
    expect(update(source, target).conflicts).toEqual([]);
    const stateFile = path.join(target, '.agents/render-state.json');
    const acceptedHash = JSON.parse(fs.readFileSync(stateFile, 'utf8'))[rel];
    expect(acceptedHash).toBe(createHash('sha256').update('"RELEASE_V2"\n').digest('hex'));
    tmp.write(`target with spaces/${rel}`, local);
    expect(update(source, target, { dryRun: true }).conflicts).toEqual([rel]);

    // Full, forced and subset renders must all leave the incoming-source baseline intact.
    for (const options of [{}, { force: true }, { onlyOutputs: new Set() }]) {
      expect(renderSharedAgents(target, options).conflicts).toEqual([]);
      expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))[rel]).toBe(acceptedHash);
    }
    const before = snapshotDigests(target);
    for (const dryRun of [true, false]) {
      const result = update(source, target, { dryRun });
      expect(result.conflicts).toEqual([rel]);
      expect(changedPaths(before, snapshotDigests(target))).toEqual([]);
    }
    const refused = spawnSync(process.execPath, [require.resolve('../../../.agents/core/template-updater'), 'update', target], {
      encoding: 'utf8', env: { ...cliEnv(), CLAUDE_PROJECT_DIR: source },
    });
    expect(refused.status, refused.stdout + refused.stderr).toBe(1);
    expect(refused.stdout).toContain(`CONFLICT ${rel}`);
    expect(changedPaths(before, snapshotDigests(target))).toEqual([]);
    expect(fs.readFileSync(path.join(target, rel), 'utf8')).toBe(local);

    // Restoring the accepted input permits a new release and advances only its accepted hash.
    tmp.write(`target with spaces/${rel}`, '"RELEASE_V2"\n');
    tmp.write(`source/${rel}`, '"RELEASE_V3"\n');
    expect(update(source, target).conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(target, rel), 'utf8')).toBe('"RELEASE_V3"\n');
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))[rel]).toBe(createHash('sha256').update('"RELEASE_V3"\n').digest('hex'));
    const settled = snapshotDigests(target);
    expect(update(source, target).conflicts).toEqual([]);
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
    expect(changedPaths(settled, snapshotDigests(target))).toEqual([]);
  });

  it.each(['core/probe.js', 'hooks/probe.cjs'])('update_editRenderUpdate_retainsExecutableLocalBehaviorIn %s', suffix => {
    const { source, target } = seed();
    const rel = `.agents/${suffix}`;
    tmp.write(`source/${rel}`, 'module.exports = () => "RELEASE_BEHAVIOR";\n');
    expect(update(source, target).conflicts).toEqual([]);
    const local = 'module.exports = () => "LOCAL_BEHAVIOR";\n';
    tmp.write(`target with spaces/${rel}`, local);
    expect(renderSharedAgents(target).conflicts).toEqual([]);
    const run = runtime => execFileSync(process.execPath, ['-e', 'process.stdout.write(require(process.argv[1])())', path.join(target, `.${runtime}/${suffix}`)], { encoding: 'utf8' });
    for (const runtime of ['claude', 'codex']) expect(run(runtime)).toBe('LOCAL_BEHAVIOR');
    const before = snapshotDigests(target);

    expect(update(source, target).conflicts).toEqual([rel]);

    expect(changedPaths(before, snapshotDigests(target))).toEqual([]);
    expect(fs.readFileSync(path.join(target, rel), 'utf8')).toBe(local);
    for (const runtime of ['claude', 'codex']) expect(run(runtime)).toBe('LOCAL_BEHAVIOR');
  });

  it('persists canonical input hashes with no selected outputs so a config-only failed update can retry', () => {
    const source = tmp.mkdir('config-only-source');
    const target = tmp.mkdir('config-only-target');
    tmp.write('config-only-source/.agents/config/version.json', '{"version":"NEW"}\n');
    tmp.write('config-only-source/.claude/templates/root/gitignore', 'managed-ignore/\n');
    renderSharedAgents(source);
    tmp.write('config-only-target/.agents/config/version.json', '{"version":"OLD"}\n');
    renderSharedAgents(target);
    tmp.write('config-only-target/.gitignore', '# === Domdhi.Agents managed block — do not edit between markers ===\n');
    const permit = permitUpdate(target);
    const run = () => spawnSync(process.execPath, [require.resolve('../../../.agents/core/template-updater'), 'update', permit.target, '--merge', ...permit.args], { encoding: 'utf8', env: { ...permit.env, CLAUDE_PROJECT_DIR: source } });
    expect(run().status).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(target, '.claude/version.json'))).version).toBe('OLD');
    const canonical = fs.readFileSync(path.join(target, '.agents/config/version.json'), 'utf8');
    const state = JSON.parse(fs.readFileSync(path.join(target, '.agents/render-state.json')));
    expect(state['.agents/config/version.json']).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(state['.claude/version.json']).not.toBe(state['.agents/config/version.json']);
    tmp.write('config-only-target/.gitignore', '# Project-owned ignore rules\n');
    const retry = run();
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stdout).not.toContain('CONFLICT');
    expect(JSON.parse(fs.readFileSync(path.join(target, '.claude/version.json'))).version).toBe('NEW');
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
  });

  it.each(['AGENTS.md', '.gitignore'])('retains the old sync marker and ledger after %s failure, then advances on retry', corruptRoot => {
    const { source, target } = seed();
    tmp.write('source/.agents/config/version.json', '{"version":"OLD"}\n');
    tmp.write('source/.agents/startup.md', '# Shared startup rules\n');
    tmp.write('source/.agents/templates/root/gitignore', 'managed-ignore/\n');
    tmp.write('source/.claude/commands/selector.md', '# Existing command selector\n');
    renderSharedAgents(source);
    update(source, target);
    const statePath = path.join(target, '.agents/render-state.json');
    const oldMarker = fs.readFileSync(path.join(target, '.claude/version.json'));
    const oldState = JSON.parse(fs.readFileSync(statePath));
    const oldDigest = oldState['.claude/version.json'];
    const selectorDigest = oldState['.agents/skills/selector/SKILL.md'];
    expect(selectorDigest).toBeTruthy();
    tmp.write('source/.agents/config/version.json', '{"version":"NEW"}\n');
    renderSharedAgents(source);
    fs.writeFileSync(path.join(target, corruptRoot), '# === Domdhi.Agents managed block — do not edit between markers ===\n');
    const permit = permitUpdate(target);
    const run = () => spawnSync(process.execPath, [require.resolve('../../../.agents/core/template-updater'), 'update', permit.target, '--merge', ...permit.args], { encoding: 'utf8', env: { ...permit.env, CLAUDE_PROJECT_DIR: source } });
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('Corrupt managed block');
    expect(fs.readFileSync(path.join(target, '.claude/version.json'))).toEqual(oldMarker);
    expect(JSON.parse(fs.readFileSync(statePath))['.claude/version.json']).toBe(oldDigest);
    fs.writeFileSync(path.join(target, corruptRoot), '# Project-owned root content\n');
    const retry = run();
    expect(retry.status, retry.stderr).toBe(0);
    const marker = fs.readFileSync(path.join(target, '.claude/version.json'), 'utf8');
    expect(JSON.parse(marker).version).toBe('NEW');
    const finalState = JSON.parse(fs.readFileSync(statePath));
    expect(finalState['.claude/version.json']).toBe(createHash('sha256').update(marker).digest('hex'));
    expect(finalState['.agents/skills/selector/SKILL.md']).toBe(selectorDigest);
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
    expect(run().status).toBe(0);
  });

  it('update_sharedChanges_preservesIdentityContextSkillFencesAndLocalSettingsInBothRuntimes', () => {
    const { source, target } = seed(); update(source, target);
    const rolePath = path.join(target, '.agents/roles/qa-engineer.md');
    fs.writeFileSync(rolePath, fs.readFileSync(rolePath, 'utf8').replace('nickname: Murphy', 'nickname: Sentinel').replace('Template soul.', 'DISTINCT_SOUL').replace('  - review-specialize', '  - review-specialize\n  - neutral-project-tests') + '\n## Project Context\n\nDISTINCT_CONTEXT\n');
    tmp.write('target with spaces/.agents/skills/neutral-project-tests/SKILL.md', '---\nname: neutral-project-tests\ndescription: Use when testing the neutral fixture.\n---\n\n# Project Tests\n');
    tmp.write('target with spaces/.codex/shared-agents.json', '{"roles":{"qa-engineer":{"model_reasoning_effort":"low"}}}\n');
    const skillPath = path.join(target, '.agents/skills/review-specialize/SKILL.md');
    fs.appendFileSync(skillPath, '\n<!-- @@project-additions:start -->\nDISTINCT_INLINE\n<!-- @@project-additions:end -->\n\n<!-- @@project-additions -->\n## Local Guidance\n\nDISTINCT_TAIL\n');
    renderSharedAgents(target);
    fs.writeFileSync(path.join(source, '.agents/roles/qa-engineer.md'), role.replace('SHARED_V1', 'SHARED_V2'));
    fs.writeFileSync(path.join(source, '.agents/skills/review-specialize/SKILL.md'), skill.replace('SHARED_V1', 'SHARED_V2'));

    const result = update(source, target);

    expect(result.errors).toBe(0);
    for (const rel of ['.agents/roles/qa-engineer.md', '.claude/agents/qa-engineer.md', '.codex/agents/qa-engineer.toml']) {
      const text = fs.readFileSync(path.join(target, rel), 'utf8');
      expect(text).toContain('SHARED_V2'); expect(text).toContain('DISTINCT_SOUL'); expect(text).toContain('DISTINCT_CONTEXT');
      expect(text).toContain('neutral-project-tests');
    }
    for (const rel of ['.agents/skills/review-specialize/SKILL.md', '.claude/skills/review-specialize/SKILL.md', '.claude/commands/review/specialize.md']) {
      const text = fs.readFileSync(path.join(target, rel), 'utf8');
      expect(text).toContain('SHARED_V2'); expect(text).toContain('DISTINCT_INLINE'); expect(text).toContain('DISTINCT_TAIL');
    }
    expect(fs.readFileSync(path.join(target, '.claude/settings.local.json'), 'utf8')).toBe('{"local":"KEEP_LOCAL"}\n');
    const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual(['KEEP_TRUST']); expect(settings.env.LOCAL).toBe('KEEP_ENV');
    expect(fs.readFileSync(path.join(target, '.codex/config.toml'), 'utf8')).toBe('# KEEP_CODEX_LOCAL\n');
    const codex = fs.readFileSync(path.join(target, '.codex/agents/qa-engineer.toml'), 'utf8');
    expect(codex).toContain('nickname: Sentinel'); expect(codex).toContain('model_reasoning_effort = "low"');
    expect(update(source, target).copied).toBe(0);
    expect(update(source, target).merged).toBe(0);
    expect(renderSharedAgents(target).changed).toEqual([]);
  });

  // NA5.18 (Wave 15 review NIT-3): a Git-ignored local skill in the source is
  // not template-owned, so it must not make the skills union strip an
  // adopter's same-named specialization from the role's frontmatter.
  it('update_gitIgnoredSourceSkill_isNotTemplateOwned_adopterSpecializationSurvives', () => {
    const { source, target } = seed(); update(source, target);
    const rolePath = path.join(target, '.agents/roles/qa-engineer.md');
    fs.writeFileSync(rolePath, fs.readFileSync(rolePath, 'utf8').replace('  - review-specialize', '  - review-specialize\n  - neutral-project-tests'));
    tmp.write('target with spaces/.agents/skills/neutral-project-tests/SKILL.md', '---\nname: neutral-project-tests\ndescription: Use when testing the neutral fixture.\n---\n\n# Project Tests\n');
    renderSharedAgents(target);
    tmp.write('empty-gitconfig', '');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp.root, 'empty-gitconfig') };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|TRACE.*)$/.test(key)) delete env[key];
    execFileSync('git', ['-C', source, 'init', '--quiet', '--initial-branch=main'], { env, windowsHide: true });
    tmp.write('source/.git/info/exclude', '.agents/skills/neutral-project-tests/\n');
    tmp.write('source/.agents/skills/neutral-project-tests/SKILL.md', '---\nname: neutral-project-tests\ndescription: Local, ignored.\n---\n\n# LOCAL_IGNORED_SKILL\n');
    fs.writeFileSync(path.join(source, '.agents/roles/qa-engineer.md'), role.replace('SHARED_V1', 'SHARED_V2'));

    const result = update(source, target);

    expect(result.errors).toBe(0);
    for (const rel of ['.agents/roles/qa-engineer.md', '.claude/agents/qa-engineer.md']) {
      const text = fs.readFileSync(path.join(target, rel), 'utf8');
      expect(text).toContain('SHARED_V2');
      expect(text).toContain('neutral-project-tests');
    }
    expect(fs.readFileSync(path.join(target, '.agents/skills/neutral-project-tests/SKILL.md'), 'utf8')).toContain('# Project Tests');
  });

  it('update_newSharedSkillAndReferences_arriveThroughDryRunThenOrdinaryUpdateWithoutHistory', () => {
    const { source, target } = seed(); update(source, target);
    tmp.write('source/.agents/skills/new-shared/SKILL.md', '---\nname: new-shared\ndescription: Use when running the new workflow.\n---\n\n# New\n\nSee references/example.md.\n');
    tmp.write('source/.agents/skills/new-shared/references/example.md', '# New Reference\n');
    const dry = update(source, target, { dryRun: true });
    expect(dry.copied).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, '.agents/skills/new-shared'))).toBe(false);
    const live = update(source, target);
    expect(live.errors).toBe(0);
    expect(fs.readFileSync(path.join(target, '.agents/skills/new-shared/references/example.md'), 'utf8')).toBe('# New Reference\n');
    expect(fs.readFileSync(path.join(target, '.claude/skills/new-shared/references/example.md'), 'utf8')).toBe('# New Reference\n');
  });

  it('update_outputEdit_dryRunAndLiveReportConflictAndLeaveCanonicalSourceUntouched', () => {
    const { source, target } = seed(); update(source, target);
    const output = path.join(target, '.claude/agents/qa-engineer.md'); fs.appendFileSync(output, '\nEDITED_PROJECTION\n');
    const canonical = path.join(target, '.agents/roles/qa-engineer.md'); const before = fs.readFileSync(canonical, 'utf8');
    fs.writeFileSync(path.join(source, '.agents/roles/qa-engineer.md'), role.replace('SHARED_V1', 'SHARED_V2'));
    expect(update(source, target, { dryRun: true }).conflicts).toContain('.claude/agents/qa-engineer.md');
    expect(update(source, target).conflicts).toContain('.claude/agents/qa-engineer.md');
    expect(fs.readFileSync(canonical, 'utf8')).toBe(before);
    expect(fs.readFileSync(output, 'utf8')).toContain('EDITED_PROJECTION');
  });

  it('update_legacyNativeRole_bootstrapsCanonicalIdentityAndContextThroughExistingMerger', () => {
    const { source, target } = seed();
    tmp.write('target with spaces/.claude/agents/qa-engineer.md', role.replace('nickname: Murphy', 'nickname: Legacy').replace('Template soul.', 'LEGACY_SOUL') + '\n## Project Context\n\nLEGACY_CONTEXT\n');
    update(source, target);
    const canonical = fs.readFileSync(path.join(target, '.agents/roles/qa-engineer.md'), 'utf8');
    expect(canonical).toContain('nickname: Legacy'); expect(canonical).toContain('LEGACY_SOUL'); expect(canonical).toContain('LEGACY_CONTEXT');
    expect(fs.readFileSync(path.join(target, '.codex/agents/qa-engineer.toml'), 'utf8')).toContain('LEGACY_CONTEXT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// globToRegex
// ─────────────────────────────────────────────────────────────────────────────

describe('globToRegex', () => {
  describe('*.md (single-star — no slashes)', () => {
    it('globToRegex_singleStar_matchesFlatFile', () => {
      const re = globToRegex('*.md');
      expect(re.test('foo.md')).toBe(true);
    });

    it('globToRegex_singleStar_rejectsNestedPath', () => {
      const re = globToRegex('*.md');
      expect(re.test('foo/bar.md')).toBe(false);
    });

    it('globToRegex_singleStar_rejectsNonMdExtension', () => {
      const re = globToRegex('*.md');
      expect(re.test('foo.js')).toBe(false);
    });
  });

  describe('**/*.md (double-star — matches any depth)', () => {
    it('globToRegex_doubleStar_matchesFlatFile', () => {
      const re = globToRegex('**/*.md');
      expect(re.test('foo.md')).toBe(true);
    });

    it('globToRegex_doubleStar_matchesNestedFile', () => {
      const re = globToRegex('**/*.md');
      expect(re.test('foo/bar.md')).toBe(true);
    });

    it('globToRegex_doubleStar_matchesDeeplyNestedFile', () => {
      const re = globToRegex('**/*.md');
      expect(re.test('a/b/c/file.md')).toBe(true);
    });

    it('globToRegex_doubleStar_rejectsNonMdExtension', () => {
      const re = globToRegex('**/*.md');
      expect(re.test('foo/bar.js')).toBe(false);
    });
  });

  describe('.claude/agents/*.md (directory prefix + single-star)', () => {
    it('globToRegex_dirPrefix_matchesCorrectNesting', () => {
      const re = globToRegex('agents/*.md');
      expect(re.test('agents/forge.md')).toBe(true);
    });

    it('globToRegex_dirPrefix_rejectsTooDeep', () => {
      const re = globToRegex('agents/*.md');
      expect(re.test('agents/subdir/forge.md')).toBe(false);
    });

    it('globToRegex_dirPrefix_rejectsWrongDir', () => {
      const re = globToRegex('agents/*.md');
      expect(re.test('commands/forge.md')).toBe(false);
    });
  });

  describe('commands/**/*.md (double-star mid-pattern)', () => {
    it('globToRegex_midDoubleStar_matchesDirectChild', () => {
      const re = globToRegex('commands/**/*.md');
      expect(re.test('commands/build.md')).toBe(true);
    });

    it('globToRegex_midDoubleStar_matchesNestedChild', () => {
      const re = globToRegex('commands/**/*.md');
      expect(re.test('commands/review/code-review.md')).toBe(true);
    });

    it('globToRegex_midDoubleStar_rejectsDifferentPrefix', () => {
      const re = globToRegex('commands/**/*.md');
      expect(re.test('skills/code-reviewer/SKILL.md')).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyClaudeFile
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyClaudeFile', () => {
  it('classifyClaudeFile_commandsMd_isTemplate', () => {
    expect(classifyClaudeFile('commands/do.md')).toBe('template');
  });

  it('classifyClaudeFile_commandsNestedMd_isTemplate', () => {
    expect(classifyClaudeFile('commands/review/code-review.md')).toBe('template');
  });

  it('classifyClaudeFile_coreJs_isTemplate', () => {
    expect(classifyClaudeFile('core/gate.js')).toBe('template');
  });

  it('classifyClaudeFile_hooksCjs_isTemplate', () => {
    expect(classifyClaudeFile('hooks/secret-scanner.cjs')).toBe('template');
  });

  it('classifyClaudeFile_skillsSKILL_isTemplate', () => {
    expect(classifyClaudeFile('skills/qa-engineer/SKILL.md')).toBe('template');
  });

  it('classifyClaudeFile_skillsOptional_isTemplate', () => {
    expect(classifyClaudeFile('skills-optional/minimalist-ui/SKILL.md')).toBe('template');
  });

  it('classifyClaudeFile_versionJson_isTemplate', () => {
    expect(classifyClaudeFile('version.json')).toBe('template');
  });

  it('classifyClaudeFile_guardrailYaml_isTemplate', () => {
    expect(classifyClaudeFile('guardrail-rules.yaml')).toBe('template');
  });

  it('classifyClaudeFile_settingsJson_isProject', () => {
    expect(classifyClaudeFile('settings.json')).toBe('project');
  });

  it('classifyClaudeFile_settingsLocalJson_isProject', () => {
    expect(classifyClaudeFile('settings.local.json')).toBe('project');
  });

  it('classifyClaudeFile_brandGuidelines_isProjectException', () => {
    expect(classifyClaudeFile('skills/brand-guidelines/SKILL.md')).toBe('project-exception');
  });

  it('classifyClaudeFile_brandGuidelinesSubdoc_isProjectException', () => {
    expect(classifyClaudeFile('skills/brand-guidelines/palette.md')).toBe('project-exception');
  });

  it('classifyClaudeFile_brandGuidelinesNestedSubdoc_isProjectException', () => {
    expect(classifyClaudeFile('skills/brand-guidelines/examples/logo-v1.png')).toBe('project-exception');
  });

  it('classifyClaudeFile_skillsReferencesMd_isTemplate', () => {
    expect(classifyClaudeFile('skills/skill-authoring/anthropic-best-practices.md')).toBe('template');
  });

  it('classifyClaudeFile_skillsReferencesSubdir_isTemplate', () => {
    expect(classifyClaudeFile('skills/playwright-cli/references/tracing.md')).toBe('template');
  });

  it('classifyClaudeFile_skillsReferenceTs_isTemplate', () => {
    expect(classifyClaudeFile('skills/systematic-debugging/references/condition-based-waiting-example.ts')).toBe('template');
  });

  it('classifyClaudeFile_skillsScriptsShellScript_isTemplate', () => {
    expect(classifyClaudeFile('skills/systematic-debugging/scripts/find-polluter.sh')).toBe('template');
  });

  it('classifyClaudeFile_agentMd_isMixed', () => {
    expect(classifyClaudeFile('agents/general-purpose.md')).toBe('mixed');
  });

  it('classifyClaudeFile_agentMdForge_isMixed', () => {
    expect(classifyClaudeFile('agents/forge.md')).toBe('mixed');
  });

  it('classifyClaudeFile_unknownFile_isUnknown', () => {
    expect(classifyClaudeFile('some-random-file.txt')).toBe('unknown');
  });

  it('classifyClaudeFile_backslashPath_normalizes', () => {
    // Windows paths with backslashes must still classify correctly
    expect(classifyClaudeFile('agents\\general-purpose.md')).toBe('mixed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAgentSections
// ─────────────────────────────────────────────────────────────────────────────

// Minimal fixture: full agent with all zones
const FIXTURE_PERSONALIZED = `---
name: general-purpose
nickname: Forge
model: sonnet
---

# Forge — General Purpose Developer

I am the one who builds.

## Skills

No default skills.

## Project Context

This project uses React and TypeScript.
`;

// Generic agent — no nickname
const FIXTURE_GENERIC = `---
name: code-reviewer
model: sonnet
---

# Code Reviewer

I review code thoroughly.

## Skills

code-reviewer, code-review-playbook
`;

// Agent without Project Context
const FIXTURE_NO_PROJECT_CTX = `---
name: doc-writer
model: haiku
---

# Doc Writer

I document things.

## Skills

documentation
`;

// Agent with no frontmatter
const FIXTURE_NO_FRONTMATTER = `# Bare Agent

Just some content without a frontmatter block.

## Skills

some-skill
`;

describe('parseAgentSections', () => {
  it('parseAgentSections_personalized_extractsFrontmatter', () => {
    const result = parseAgentSections(FIXTURE_PERSONALIZED);
    expect(result.frontmatter).toContain('name: general-purpose');
    expect(result.frontmatter).toContain('nickname: Forge');
    // No --- delimiters
    expect(result.frontmatter).not.toContain('---');
  });

  it('parseAgentSections_personalized_extractsSoulZone', () => {
    const result = parseAgentSections(FIXTURE_PERSONALIZED);
    expect(result.soulZone).toContain('# Forge — General Purpose Developer');
    expect(result.soulZone).toContain('I am the one who builds');
    // Soul zone does NOT include ## Skills heading
    expect(result.soulZone).not.toContain('## Skills');
  });

  it('parseAgentSections_personalized_extractsSkillsZone', () => {
    const result = parseAgentSections(FIXTURE_PERSONALIZED);
    expect(result.skillsZone).toContain('## Skills');
    expect(result.skillsZone).toContain('No default skills');
    // Skills zone does NOT bleed into projectCtx
    expect(result.skillsZone).not.toContain('## Project Context');
  });

  it('parseAgentSections_personalized_extractsProjectCtx', () => {
    const result = parseAgentSections(FIXTURE_PERSONALIZED);
    expect(result.projectCtx).toContain('## Project Context');
    expect(result.projectCtx).toContain('React and TypeScript');
  });

  it('parseAgentSections_generic_hasEmptyNickname', () => {
    const result = parseAgentSections(FIXTURE_GENERIC);
    expect(result.frontmatter).not.toContain('nickname');
  });

  it('parseAgentSections_noProjectCtx_returnsEmptyString', () => {
    const result = parseAgentSections(FIXTURE_NO_PROJECT_CTX);
    expect(result.projectCtx).toBe('');
  });

  it('parseAgentSections_noFrontmatter_entireBodyIsSoulZone', () => {
    const result = parseAgentSections(FIXTURE_NO_FRONTMATTER);
    expect(result.frontmatter).toBe('');
    expect(result.soulZone).toContain('# Bare Agent');
    expect(result.soulZone).toContain('Just some content');
  });

  it('parseAgentSections_noFrontmatter_skillsZoneStillParsed', () => {
    const result = parseAgentSections(FIXTURE_NO_FRONTMATTER);
    expect(result.skillsZone).toContain('## Skills');
    expect(result.skillsZone).toContain('some-skill');
  });

  it('parseAgentSections_crlfNormalized', () => {
    // CRLF line endings should not break parsing
    const crlf = FIXTURE_PERSONALIZED.replace(/\n/g, '\r\n');
    const result = parseAgentSections(crlf);
    expect(result.frontmatter).toContain('nickname: Forge');
    expect(result.skillsZone).toContain('## Skills');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mergeAgentFile
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAgentFile', () => {
  it('mergeAgentFile_destMissing_copiesFile', () => {
    // Arrange
    const srcPath = tmp.write('src/agents/forge.md', FIXTURE_PERSONALIZED);
    const destPath = path.join(tmp.root, 'dest/agents/forge.md');
    // destPath does NOT exist

    // Act
    const result = mergeAgentFile(srcPath, destPath);

    // Assert — result.detail is the human-readable merge label (new API: { changed, detail })
    expect(result.detail).toContain('copied');
    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath, 'utf8')).toContain('# Forge — General Purpose Developer');
  });

  it('mergeAgentFile_personalized_preservesSoulZone', () => {
    // Arrange: src has updated soul content; dest has personalized (nickname) soul
    const srcContent = `---
name: general-purpose
model: sonnet
---

# Forge — General Purpose Developer (UPDATED VERSION)

New soul content from template.

## Skills

updated-skill-list
`;

    const destContent = `---
name: general-purpose
nickname: Forge
model: sonnet
---

# Forge — My Custom Soul Zone

Custom description written by the project owner.

## Skills

old-skill-list

## Project Context

This is my project context.
`;

    const srcPath = tmp.write('src/agents/general-purpose.md', srcContent);
    const destPath = tmp.write('dest/agents/general-purpose.md', destContent);

    // Act
    const result = mergeAgentFile(srcPath, destPath);

    // Assert
    const merged = fs.readFileSync(destPath, 'utf8');

    // Soul zone preserved from dest (personalized)
    expect(merged).toContain('Custom description written by the project owner');
    expect(merged).not.toContain('UPDATED VERSION');

    // Skills zone from src
    expect(merged).toContain('updated-skill-list');
    expect(merged).not.toContain('old-skill-list');

    // Project context preserved from dest
    expect(merged).toContain('## Project Context');
    expect(merged).toContain('This is my project context');

    // nickname preserved in frontmatter
    expect(merged).toContain('nickname: Forge');

    expect(result.detail).toContain('merged');
  });

  it('mergeAgentFile_preservesBlankLineAfterFrontmatter', () => {
    // Regression — earlier bug: parseAgentSections stripped the leading blank line
    // after the closing `---`, and reassembly used a single `\n` between the
    // closing `---` and soul zone, producing `---\n# Heading` (no blank line).
    // Standard markdown convention is `---\n\n# Heading`.
    const srcContent = `---
name: architect
model: inherit
---

# Mason — System Architect

Body content here.

## Skills

- architecture
`;
    const srcPath = tmp.write('src/agents/architect.md', srcContent);
    const destPath = tmp.write('dest/agents/architect.md', srcContent);

    // Act
    mergeAgentFile(srcPath, destPath);

    // Assert — merged file MUST have a blank line between `---` and the next heading
    const merged = fs.readFileSync(destPath, 'utf8');
    expect(merged).toContain('---\n\n# Mason — System Architect');
    expect(merged).not.toContain('---\n# Mason — System Architect');
  });

  it('mergeAgentFile_notPersonalized_overwritesSoulZone', () => {
    // Arrange: dest has no nickname — generic install
    const srcContent = `---
name: code-reviewer
model: sonnet
---

# Code Reviewer (NEW TEMPLATE)

Updated reviewer soul.

## Skills

code-reviewer-v2
`;

    const destContent = `---
name: code-reviewer
model: sonnet
---

# Code Reviewer (OLD)

Old reviewer soul.

## Skills

code-reviewer-v1
`;

    const srcPath = tmp.write('src/agents/code-reviewer.md', srcContent);
    const destPath = tmp.write('dest/agents/code-reviewer.md', destContent);

    // Act
    mergeAgentFile(srcPath, destPath);

    // Assert
    const merged = fs.readFileSync(destPath, 'utf8');

    // Soul zone overwritten (not personalized)
    expect(merged).toContain('NEW TEMPLATE');
    expect(merged).not.toContain('OLD');

    // Skills from src
    expect(merged).toContain('code-reviewer-v2');
  });

  it('mergeAgentFile_preservesFrontmatterNicknameAndAliases', () => {
    const srcContent = `---
name: doc-writer
model: haiku
---

# Doc Writer

Write docs.

## Skills

documentation
`;

    const destContent = `---
name: doc-writer
nickname: Penny
aliases: [penny, doc]
model: haiku
---

# Penny — Doc Writer

Custom doc writer.

## Skills

old-docs
`;

    const srcPath = tmp.write('src/agents/doc-writer.md', srcContent);
    const destPath = tmp.write('dest/agents/doc-writer.md', destContent);

    mergeAgentFile(srcPath, destPath);

    const merged = fs.readFileSync(destPath, 'utf8');
    expect(merged).toContain('nickname: Penny');
    expect(merged).toContain('aliases: [penny, doc]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// walkDir
// ─────────────────────────────────────────────────────────────────────────────

describe('walkDir', () => {
  it('walkDir_flatDir_returnsAllFiles', () => {
    tmp.write('flat/a.md', 'a');
    tmp.write('flat/b.js', 'b');
    tmp.write('flat/c.cjs', 'c');

    const results = walkDir(path.join(tmp.root, 'flat'));
    const names = results.map(f => path.basename(f)).sort();
    expect(names).toEqual(['a.md', 'b.js', 'c.cjs']);
  });

  it('walkDir_nested_returnsFilesRecursively', () => {
    tmp.write('tree/a.md', 'a');
    tmp.write('tree/sub/b.md', 'b');
    tmp.write('tree/sub/deep/c.md', 'c');

    const results = walkDir(path.join(tmp.root, 'tree'));
    expect(results).toHaveLength(3);
  });

  it('walkDir_skipsTestsDir', () => {
    tmp.write('proj/__tests__/foo.test.js', 'test');
    tmp.write('proj/real.js', 'real');

    const results = walkDir(path.join(tmp.root, 'proj'));
    const names = results.map(f => path.basename(f));
    expect(names).toContain('real.js');
    expect(names).not.toContain('foo.test.js');
  });

  it('walkDir_skipsHelpersDir', () => {
    tmp.write('proj/_helpers/helper.js', 'helper');
    tmp.write('proj/main.js', 'main');

    const results = walkDir(path.join(tmp.root, 'proj'));
    const names = results.map(f => path.basename(f));
    expect(names).toContain('main.js');
    expect(names).not.toContain('helper.js');
  });

  it('walkDir_skipsNodeModules', () => {
    tmp.write('proj/node_modules/dep/index.js', 'dep');
    tmp.write('proj/src/index.js', 'src');

    const results = walkDir(path.join(tmp.root, 'proj'));
    // Assert explicit paths — count-based checks can pass if node_modules leaks a same-named file
    expect(results).toContain(path.join(tmp.root, 'proj', 'src', 'index.js'));
    expect(results).not.toContain(path.join(tmp.root, 'proj', 'node_modules', 'dep', 'index.js'));
  });

  it('walkDir_allSkippedDirsTogether_noneLeakThrough', () => {
    tmp.write('proj/__tests__/test.js', 't');
    tmp.write('proj/_helpers/util.js', 'u');
    tmp.write('proj/node_modules/pkg/index.js', 'n');
    tmp.write('proj/legit/real.js', 'r');

    const results = walkDir(path.join(tmp.root, 'proj'));
    // Assert by explicit path membership — order-independent and leak-sensitive
    expect(results).toContain(path.join(tmp.root, 'proj', 'legit', 'real.js'));
    expect(results).not.toContain(path.join(tmp.root, 'proj', '__tests__', 'test.js'));
    expect(results).not.toContain(path.join(tmp.root, 'proj', '_helpers', 'util.js'));
    expect(results).not.toContain(path.join(tmp.root, 'proj', 'node_modules', 'pkg', 'index.js'));
    expect(results).toHaveLength(1);
  });

  it('walkDir_nonexistentDir_returnsEmptyArray', () => {
    const results = walkDir(path.join(tmp.root, 'does-not-exist'));
    expect(results).toEqual([]);
  });

  it('walkDir_returnsAbsolutePaths', () => {
    tmp.write('proj/file.md', 'content');
    const results = walkDir(path.join(tmp.root, 'proj'));
    expect(results[0]).toBe(path.join(tmp.root, 'proj', 'file.md'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --dry-run (runUpdate with { dryRun: true })
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate dry-run', () => {
  /**
   * Build a minimal fake source .claude/ + target .claude/ in tmp.
   * The source must look like PROJECT_ROOT — template-updater reads from
   * process.env.CLAUDE_PROJECT_DIR (or __dirname/../..).
   * We redirect CLAUDE_PROJECT_DIR to our tmp source dir.
   */
  let originalProjectDir;

  beforeEach(() => {
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    if (originalProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    }
  });

  it('dryRun_writesNoFiles', () => {
    // Arrange: create a minimal source layout
    const srcRoot = tmp.mkdir('src');
    // A template-zone file
    tmp.write('src/.claude/core/gate.js', '// gate stub');
    // A project-zone file
    tmp.write('src/.claude/settings.json', '{}');

    // Create the target with an existing .claude/ dir
    const targetRoot = tmp.mkdir('target');
    tmp.mkdir('target/.claude');

    // Point CLAUDE_PROJECT_DIR at our fake source root
    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    // Spy on console.log to verify dry-run output (optional)
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Act
    runUpdate(path.join(tmp.root, 'target'), { dryRun: true });

    // Assert: target .claude/core/gate.js was NOT written
    const destGate = path.join(tmp.root, 'target', '.claude', 'core', 'gate.js');
    expect(fs.existsSync(destGate)).toBe(false);

    spy.mockRestore();
  });

  it('dryRun_logsWouldCopyMessage', () => {
    // Arrange
    const srcRoot = tmp.mkdir('src');
    tmp.write('src/.claude/core/gate.js', '// gate stub');

    const targetRoot = tmp.mkdir('target');
    tmp.mkdir('target/.claude');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    const logged = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    // Act
    runUpdate(path.join(tmp.root, 'target'), { dryRun: true });

    spy.mockRestore();

    // Assert: at least one log line mentions COPY or DRY RUN
    const hasDryRunHeader = logged.some(l => l.includes('DRY RUN'));
    expect(hasDryRunHeader).toBe(true);
  });

  it('dryRun_doesNotWriteSkippedDirs', () => {
    // Arrange: source has files in __tests__ that walkDir would skip
    const srcRoot = tmp.mkdir('src');
    tmp.write('src/.claude/__tests__/foo.test.js', 'test');
    tmp.write('src/.claude/core/real.js', '// real');

    tmp.mkdir('target');
    tmp.mkdir('target/.claude');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runUpdate(path.join(tmp.root, 'target'), { dryRun: true });

    spy.mockRestore();

    // Neither the test file nor the real file should be written in dry-run
    expect(fs.existsSync(path.join(tmp.root, 'target', '.claude', '__tests__', 'foo.test.js'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, 'target', '.claude', 'core', 'real.js'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-project skill exclusion (update-config.json → skillExclude)
// ─────────────────────────────────────────────────────────────────────────────

describe('loadExcludedSkills', () => {
  it('returns empty set when update-config.json is absent', () => {
    const claudeDir = tmp.mkdir('t1/.claude');
    expect(loadExcludedSkills(claudeDir).size).toBe(0);
  });

  it('reads the skillExclude array', () => {
    tmp.mkdir('t2/.claude');
    tmp.write('t2/.claude/update-config.json', JSON.stringify({ skillExclude: ['tailwind-css-patterns', 'redesign-existing-projects'] }));
    const set = loadExcludedSkills(path.join(tmp.root, 't2', '.claude'));
    expect(set.has('tailwind-css-patterns')).toBe(true);
    expect(set.has('redesign-existing-projects')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('returns empty set (no throw) on malformed JSON', () => {
    tmp.mkdir('t3/.claude');
    tmp.write('t3/.claude/update-config.json', '{ not valid json');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const set = loadExcludedSkills(path.join(tmp.root, 't3', '.claude'));
    spy.mockRestore();
    expect(set.size).toBe(0);
  });

  it('returns empty set when skillExclude is missing or not an array', () => {
    tmp.mkdir('t4/.claude');
    tmp.write('t4/.claude/update-config.json', JSON.stringify({ skillExclude: 'tailwind' }));
    expect(loadExcludedSkills(path.join(tmp.root, 't4', '.claude')).size).toBe(0);
  });
});

describe('runUpdate — skill exclusion', () => {
  let originalProjectDir;
  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  it('skips an excluded skill but copies others', () => {
    // Source ships two skills
    tmp.write('src/.claude/skills/tailwind-css-patterns/SKILL.md', '# tailwind');
    tmp.write('src/.claude/skills/architecture/SKILL.md', '# architecture');
    // Target opts out of tailwind
    tmp.mkdir('target/.claude');
    tmp.write('target/.claude/update-config.json', JSON.stringify({ skillExclude: ['tailwind-css-patterns'] }));

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), {});
    spy.mockRestore();

    const twPath = path.join(tmp.root, 'target', '.claude', 'skills', 'tailwind-css-patterns', 'SKILL.md');
    const awPath = path.join(tmp.root, 'target', '.claude', 'skills', 'architecture', 'SKILL.md');
    expect(fs.existsSync(twPath)).toBe(false);   // excluded — not copied
    expect(fs.existsSync(awPath)).toBe(true);    // not excluded — copied
  });

  it('copies all skills when no update-config.json exists', () => {
    tmp.write('src/.claude/skills/tailwind-css-patterns/SKILL.md', '# tailwind');
    tmp.mkdir('target/.claude');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), {});
    spy.mockRestore();

    const twPath = path.join(tmp.root, 'target', '.claude', 'skills', 'tailwind-css-patterns', 'SKILL.md');
    expect(fs.existsSync(twPath)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE.md → .claude/README.md redirect (template documentation, not project doc)
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate — CLAUDE.md handling', () => {
  let originalProjectDir;

  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  it('runUpdate_writesSourceClaudeMdToTargetClaudeReadme', () => {
    // Arrange — source has CLAUDE.md (template documentation)
    tmp.mkdir('src/.claude');
    tmp.write('src/CLAUDE.md', '# Template Documentation\n\nDescribes the template.');

    tmp.mkdir('target');
    tmp.mkdir('target/.claude');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Act
    runUpdate(path.join(tmp.root, 'target'), {});
    spy.mockRestore();

    // Assert — written to .claude/README.md, not root CLAUDE.md
    const readmePath = path.join(tmp.root, 'target', '.claude', 'README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
    expect(fs.readFileSync(readmePath, 'utf8')).toContain('# Template Documentation');
  });

  it('runUpdate_doesNotTouchTargetRootClaudeMd', () => {
    // Arrange — target already has its own root CLAUDE.md (project-specific)
    tmp.mkdir('src/.claude');
    tmp.write('src/CLAUDE.md', '# Template Documentation');

    tmp.mkdir('target/.claude');
    const projectClaudeMd = '# My Project\n\nProject-specific instructions.';
    tmp.write('target/CLAUDE.md', projectClaudeMd);

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Act
    runUpdate(path.join(tmp.root, 'target'), {});
    spy.mockRestore();

    // Assert — target's root CLAUDE.md is untouched
    const targetRootClaude = fs.readFileSync(path.join(tmp.root, 'target', 'CLAUDE.md'), 'utf8');
    expect(targetRootClaude).toBe(projectClaudeMd);
  });

  it('runUpdate_doesNotEmitMergeMessageForClaudeMd', () => {
    // Arrange — make sure --merge does NOT trigger any CLAUDE.md merge log
    tmp.mkdir('src/.claude');
    tmp.write('src/CLAUDE.md', '# Template');

    tmp.mkdir('target/.claude');
    tmp.write('target/CLAUDE.md', '# Project');

    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    const logged = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.join(' '));
    });

    // Act — even with --merge, root CLAUDE.md should not appear in any merge line
    runUpdate(path.join(tmp.root, 'target'), { merge: true });
    spy.mockRestore();

    // Assert — no log line mentions merging CLAUDE.md (the bare root file)
    const claudeMdMerges = logged.filter(l => /MERGE\s+CLAUDE\.md/.test(l));
    expect(claudeMdMerges).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Active root .gitignore — managed-block merge from templates/root/gitignore
// (template-updater previously synced only the inert template copy, so v4.63's
// "untrack docs/.output/.state/" rule never reached existing adopters.)
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate — root .gitignore managed block', () => {
  const START = '# === Domdhi.Agents managed block — do not edit between markers ===';
  const END   = '# === End Domdhi.Agents managed block ===';
  let originalProjectDir;

  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  const run = (opts) => {
    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), opts || {});
    spy.mockRestore();
  };
  const gi = () => path.join(tmp.root, 'target', '.gitignore');

  it('appends a managed block when the target .gitignore has none', () => {
    tmp.write('src/.claude/templates/root/gitignore', 'docs/.output/.state/\n');
    tmp.mkdir('target/.claude');
    tmp.write('target/.gitignore', 'node_modules/\nmy-custom-rule/\n');

    run({});

    const out = fs.readFileSync(gi(), 'utf8');
    expect(out).toContain('my-custom-rule/');          // adopter's own rules preserved
    expect(out).toContain(START);
    expect(out).toContain('docs/.output/.state/');   // new rule propagated
    expect(out).toContain(END);
  });

  it('replaces an existing managed block in place (idempotent refresh)', () => {
    tmp.write('src/.claude/templates/root/gitignore', 'docs/.output/.state/\nnew-rule/\n');
    tmp.mkdir('target/.claude');
    tmp.write(
      'target/.gitignore',
      `keep-me/\n${START}\nold-stale-rule/\n${END}\nalso-keep/\n`,
    );

    run({});

    const out = fs.readFileSync(gi(), 'utf8');
    expect(out).toContain('keep-me/');         // content before the block preserved
    expect(out).toContain('also-keep/');       // content after the block preserved
    expect(out).not.toContain('old-stale-rule/'); // stale block content replaced
    expect(out).toContain('new-rule/');        // refreshed with source content
    // exactly one managed block
    expect(out.split(START)).toHaveLength(2);
  });

  it('creates .gitignore when the target has none', () => {
    tmp.write('src/.claude/templates/root/gitignore', 'docs/.output/.state/\n');
    tmp.mkdir('target/.claude');

    run({});

    expect(fs.existsSync(gi())).toBe(true);
    expect(fs.readFileSync(gi(), 'utf8')).toContain('docs/.output/.state/');
  });

  it('does NOT write the .gitignore under --dry-run', () => {
    tmp.write('src/.claude/templates/root/gitignore', 'docs/.output/.state/\n');
    tmp.mkdir('target/.claude');
    tmp.write('target/.gitignore', 'node_modules/\n');

    run({ dryRun: true });

    // unchanged on disk — no managed block written
    expect(fs.readFileSync(gi(), 'utf8')).toBe('node_modules/\n');
  });

  it('is a no-op when the source ships no gitignore template', () => {
    // no src/.claude/templates/root/gitignore
    tmp.mkdir('src/.claude');
    tmp.mkdir('target/.claude');
    tmp.write('target/.gitignore', 'node_modules/\n');

    run({});

    expect(fs.readFileSync(gi(), 'utf8')).toBe('node_modules/\n'); // untouched
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Skill project-additions merge (template-zone escape hatch under --merge)
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate skill --merge preserves project additions', () => {
  let originalProjectDir;
  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  const MARKER = '<!-- @@project-additions -->';
  const SRC_SKILL = `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\nTemplate body v2.\n`;

  function arrange() {
    tmp.mkdir('src/.claude');
    tmp.mkdir('target/.claude');
    tmp.write('src/.claude/skills/tailwind-css-patterns/SKILL.md', SRC_SKILL);
    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');
  }

  it('preserves the project-additions tail and refreshes the head under --merge', () => {
    arrange();
    const destRel = 'target/.claude/skills/tailwind-css-patterns/SKILL.md';
    tmp.write(destRel,
      `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\nTemplate body v1.\n\n${MARKER}\n\n## Project Additions\n\nuses obsidian-void palette.\n`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), { merge: true });
    spy.mockRestore();

    const out = fs.readFileSync(path.join(tmp.root, destRel), 'utf8');
    expect(out).toContain('Template body v2.');      // head refreshed
    expect(out).not.toContain('Template body v1.');
    expect(out).toContain('obsidian-void palette.');  // tail preserved
    expect(out.split(MARKER).length - 1).toBe(1);     // exactly one marker
  });

  it('overwrites a markerless skill (no project additions to keep)', () => {
    arrange();
    const destRel = 'target/.claude/skills/tailwind-css-patterns/SKILL.md';
    tmp.write(destRel, `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\nTemplate body v1.\n`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), { merge: true });
    spy.mockRestore();

    expect(fs.readFileSync(path.join(tmp.root, destRel), 'utf8')).toBe(SRC_SKILL);
  });

  it('without --merge, a skill with a tail is still overwritten (escape hatch is opt-in)', () => {
    arrange();
    const destRel = 'target/.claude/skills/tailwind-css-patterns/SKILL.md';
    tmp.write(destRel,
      `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\nold.\n\n${MARKER}\n\nproject stuff.\n`);

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runUpdate(path.join(tmp.root, 'target'), {}); // no merge
    spy.mockRestore();

    const out = fs.readFileSync(path.join(tmp.root, destRel), 'utf8');
    expect(out).toBe(SRC_SKILL);          // clobbered
    expect(out).not.toContain('project stuff.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runUpdate skill --merge — a suppressed head refresh / orphaned block must WARN
// (full-review-260716 wave 6A, Finding 1: it used to log a clean-looking MERGE line
// and never touch stats.warned, so the fleet rollup couldn't see it happened.)
// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate skill --merge surfaces a suppressed head refresh as a WARN', () => {
  let originalProjectDir;
  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  const MARKER = '<!-- @@project-additions -->';
  // Two headings in the source body — enough for the rewrite heuristic's
  // collisionCount >= 2 bar when the dest's tail repeats both of them.
  const SRC_SKILL = `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\n## Section A\n\nbody v2\n\n## Section B\n\nbody v2\n`;

  it('logs a WARN line, counts stats.warned, and lists the message in Warnings', () => {
    tmp.mkdir('src/.claude');
    tmp.mkdir('target/.claude');
    tmp.write('src/.claude/skills/tailwind-css-patterns/SKILL.md', SRC_SKILL);
    process.env.CLAUDE_PROJECT_DIR = path.join(tmp.root, 'src');

    // The dest's marker TAIL re-uses both of the source's headings ("## Section A"
    // and "## Section B") — the rewrite heuristic reads this as a full-file rewrite
    // (not a genuine new addition) and suppresses the head refresh entirely.
    const destRel = 'target/.claude/skills/tailwind-css-patterns/SKILL.md';
    tmp.write(destRel,
      `---\nname: tailwind-css-patterns\n---\n\n# Tailwind\n\n## Section A\n\nbody v1\n\n${MARKER}\n\n## Section A\n\nrewritten\n\n## Section B\n\nrewritten\n`);

    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    runUpdate(path.join(tmp.root, 'target'), { merge: true });
    spy.mockRestore();

    const out = logs.join('\n');
    expect(out).toMatch(/WARN\s+.*head refresh SUPPRESSED/);
    expect(out).toMatch(/Warned\s*:\s*1/);
    expect(out).toMatch(/\nWarnings:\n/);
    expect(out).toMatch(/! .*head refresh SUPPRESSED/);

    // The head genuinely was NOT refreshed — "body v1" (dest's own head) survives,
    // "body v2" (the source's refreshed head) does not appear.
    const written = fs.readFileSync(path.join(tmp.root, destRel), 'utf8');
    expect(written).toContain('body v1');
    expect(written).not.toContain('body v2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listSkillDirs — counts symlinked skill dirs (the bespoke-skill-preservation fix)
// ─────────────────────────────────────────────────────────────────────────────

describe('listSkillDirs', () => {
  it('listSkillDirs_countsSymlinkedSkillDir', () => {
    // A real skill dir, a SYMLINKED skill dir (the shape adopters use for bespoke
    // skills into ../.agents/skills/), a loose file, and a broken symlink.
    tmp.write('skills/real-skill/SKILL.md', 'x');
    const linkTarget = tmp.mkdir('agents-skills/linked-skill');
    nodeFs.symlinkSync(linkTarget, path.join(tmp.root, 'skills/linked-skill'), 'dir');
    tmp.write('skills/loose-file.md', 'x');
    nodeFs.symlinkSync(path.join(tmp.root, 'nonexistent'), path.join(tmp.root, 'skills/broken-link'), 'dir');

    const result = listSkillDirs(path.join(tmp.root, 'skills'));
    expect(result.has('real-skill')).toBe(true);
    expect(result.has('linked-skill')).toBe(true);   // the fix: symlinked dir counts
    expect(result.has('loose-file.md')).toBe(false); // a file is not a skill dir
    expect(result.has('broken-link')).toBe(false);   // broken symlink guarded out
  });

  it('listSkillDirs_missingDir_returnsEmptySet', () => {
    const result = listSkillDirs(path.join(tmp.root, 'does-not-exist'));
    expect(result.size).toBe(0);
  });
});

// Direct updater front doors exercise real canonical and native entry points.

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UPDATE_ENTRIES = ['.agents/core/template-updater.js', '.claude/core/template-updater.js', '.codex/core/template-updater.js'];
const EXPECTED_UPDATE_SCOPE = ['.agents', '.claude', '.codex', '.gitignore', 'AGENTS.md', 'CLAUDE.md'];

function cliEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) || key === 'CLAUDE_PROJECT_DIR' || key === 'AGENTS_RUNTIME' || key === 'AGENT_RUNTIME') delete env[key];
  }
  return { ...env, ...extra };
}

function runEntry(entry, args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(TOOLKIT, entry), ...args], {
    cwd: TOOLKIT, env: cliEnv(env), encoding: 'utf8', timeout: 90000,
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function gitAt(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    env: cliEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' }),
    encoding: 'utf8',
  }).trim();
}

function snapshotTree(root) {
  const files = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) files[rel] = `symlink:${fs.readlinkSync(abs)}`;
      else if (entry.isDirectory()) { files[`${rel}/`] = 'directory'; walk(abs); }
      else files[rel] = fs.readFileSync(abs).toString('base64');
    }
  })(root);
  return files;
}

/** Disposable legacy adopter: pre-canonical .claude only, plus project-owned work. */
function seedLegacyAdopter(root) {
  const target = path.join(root, 'Internal.App with spaces');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  gitAt(target, ['init', '--initial-branch=main']);
  gitAt(target, ['config', 'user.name', 'Fixture Maintainer']);
  gitAt(target, ['config', 'user.email', 'fixture@example.invalid']);
  fs.writeFileSync(path.join(target, '.claude/version.json'), '{ "version": "5.2", "changelog": "legacy upstream install" }\n');
  fs.writeFileSync(path.join(target, '.claude/settings.local.json'), '{ "local": "KEEP_LOCAL" }\n');
  fs.writeFileSync(path.join(target, '.claude/update-config.json'), '{ "skillExclude": ["tailwind-css-patterns"] }\n');
  fs.writeFileSync(path.join(target, 'CLAUDE.md'), '# PROJECT_OWNED_INSTRUCTIONS\n\nKeep this project rule.\n');
  fs.writeFileSync(path.join(target, 'README.md'), '# Project baseline\n');
  gitAt(target, ['add', '--', '.claude', 'CLAUDE.md', 'README.md']);
  gitAt(target, ['commit', '-m', 'legacy adopter baseline']);
  fs.writeFileSync(path.join(target, 'README.md'), '# Existing staged project work\n');
  gitAt(target, ['add', '--', 'README.md']);
  fs.writeFileSync(path.join(target, 'unstaged-notes.txt'), 'existing unstaged project work\n');
  return target;
}

const toolkitVersion = () => JSON.parse(fs.readFileSync(path.join(TOOLKIT, '.agents/config/version.json'), 'utf8'));

describe('direct update front door', () => {
  let root;
  beforeEach(() => { root = fs.realpathSync.native(tmp.mkdir('direct-update')); });

  it('updateCli_legacyAdopter_updatesThroughTheCodexWrapperAndWritesTheVersionLast', () => {
    const target = seedLegacyAdopter(root);
    const keep = ['.claude/settings.local.json', '.claude/update-config.json', '.git/index', 'unstaged-notes.txt']
      .map(rel => [rel, fs.readFileSync(path.join(target, rel))]);
    const head = gitAt(target, ['rev-parse', 'HEAD']);

    const result = runEntry('.codex/core/template-updater.js',
      ['update', target, '--merge']);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/\.claude\/version\.json \(last — sync marker\)/);
    expect(JSON.parse(fs.readFileSync(path.join(target, '.claude/version.json'), 'utf8'))).toEqual(toolkitVersion());
    expect(fs.existsSync(path.join(target, '.agents/startup.md'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toContain('# PROJECT_OWNED_INSTRUCTIONS\n\nKeep this project rule.');
    for (const [rel, bytes] of keep) expect(fs.readFileSync(path.join(target, rel)), rel).toEqual(bytes);
    expect(gitAt(target, ['rev-parse', 'HEAD'])).toBe(head);
    expect(gitAt(target, ['diff', '--cached', '--name-only'])).toBe('README.md');
  }, 120000);

  it('updateCli_installedAdopterWithSpaces_ordinaryUpdateThroughTheClaudeWrapperIsRepeatStable', () => {
    const target = seedLegacyAdopter(root);
    const args = ['update', target, '--merge'];
    expect(runEntry('.agents/core/template-updater.js', args).code).toBe(0);

    const first = runEntry('.claude/core/template-updater.js', args);
    expect(first.code, first.output).toBe(0);
    const settled = snapshotTree(target);
    const second = runEntry('.claude/core/template-updater.js', args);
    expect(second.code, second.output).toBe(0);
    expect(snapshotTree(target)).toEqual(settled);
  }, 180000);

  it.each([
    ['invalid JSON', '{ not json'],
    ['non-array skillExclude', JSON.stringify({ skillExclude: 'tailwind-css-patterns' })],
    ['array root', JSON.stringify(['tailwind-css-patterns'])],
  ])('updateCli_malformedProjectUpdateConfig_%s_refusesBeforeAnyWrite', (_label, bytes) => {
    const target = seedLegacyAdopter(root);
    fs.writeFileSync(path.join(target, '.claude/update-config.json'), bytes);
    const before = snapshotTree(target);

    const result = runEntry('.agents/core/template-updater.js',
      ['update', target, '--merge']);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/CONFIG/);
    expect(snapshotTree(target)).toEqual(before);
  }, 60000);

  it.each(UPDATE_ENTRIES)('updateCli_%s_missingSourceAssets_refusesBeforeAnyWrite', entry => {
    const target = seedLegacyAdopter(root);
    const source = path.join(root, 'incomplete source');
    fs.mkdirSync(path.join(source, '.claude'), { recursive: true });
    const before = snapshotTree(target);
    const result = runEntry(entry, ['update', target], { CLAUDE_PROJECT_DIR: source });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/ASSETS/);
    expect(snapshotTree(target)).toEqual(before);
  });

  it('preflightFrontDoor_scopeOutsideTheProject_refuses', () => {
    const target = seedLegacyAdopter(root);
    const before = snapshotTree(target);
    const result = updater.preflightFrontDoor({ source: TOOLKIT, target }, {
      operation: 'update', assetsPresent: () => true, scope: () => ['../outside'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('PATH');
    expect(snapshotTree(target)).toEqual(before);
  });

  it('preflightUpdate_missingSourceAssets_refusesWhileTheCompleteToolkitPasses', () => {
    const target = seedLegacyAdopter(root);
    const incomplete = path.join(root, 'incomplete-toolkit');
    fs.mkdirSync(path.join(incomplete, '.agents'), { recursive: true });
    const before = snapshotTree(target);

    const missing = updater.preflightUpdate({ source: incomplete, target });
    expect(missing.ok).toBe(false);
    expect(missing.exitCode).toBe(1);
    expect(missing.errors.map(error => error.code)).toEqual(['ASSETS']);

    const complete = updater.preflightUpdate({ source: TOOLKIT, target, dryRun: true });
    expect(complete).toMatchObject({ ok: true, exitCode: 0, operation: 'update', dryRun: true });
    expect(complete.scope).toEqual(EXPECTED_UPDATE_SCOPE);
    expect(updater.UPDATE_SCOPE).toEqual(EXPECTED_UPDATE_SCOPE);
    expect(snapshotTree(target)).toEqual(before);
  }, 60000);

  it('updateCli_generatedProjectionConflict_exitsNonzeroWithoutMarkerAndKeepsInstructionsSettingsAndIndex', () => {
    const target = seedLegacyAdopter(root);
    const args = ['update', target, '--merge'];
    expect(runEntry('.agents/core/template-updater.js', args).code).toBe(0);
    const marker = '{ "version": "0.0" }\n';
    fs.writeFileSync(path.join(target, '.claude/version.json'), marker);
    const generated = path.join(target, '.codex/agents/qa-engineer.toml');
    const pristine = fs.readFileSync(generated);
    fs.appendFileSync(generated, '\n# LOCAL GENERATED EDIT\n');
    fs.appendFileSync(path.join(target, 'CLAUDE.md'), '\nLater project rule.\n');
    // Without the managed block, a completed update would append it again.
    fs.writeFileSync(path.join(target, '.gitignore'), '# project-owned ignore rules only\n');
    const kept = ['.claude/version.json', 'CLAUDE.md', 'AGENTS.md', '.gitignore', '.claude/settings.local.json', '.claude/update-config.json', '.git/index', 'unstaged-notes.txt']
      .map(rel => [rel, fs.readFileSync(path.join(target, rel))]);

    const conflicted = runEntry('.codex/core/template-updater.js', args);

    expect(conflicted.code, conflicted.output).toBe(1);
    expect(conflicted.output).toMatch(/CONFLICT[^\n]*\.codex\/agents\/qa-engineer\.toml/);
    expect(conflicted.output).toMatch(/Update INCOMPLETE/);
    expect(conflicted.output).not.toMatch(/Update complete/);
    for (const [rel, bytes] of kept) expect(fs.readFileSync(path.join(target, rel)), rel).toEqual(bytes);

    // Positive control: once the generated edit is resolved, the same update
    // completes and replaces the stale marker last.
    fs.writeFileSync(generated, pristine);
    const resolved = runEntry('.codex/core/template-updater.js', args);
    expect(resolved.code, resolved.output).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(target, '.claude/version.json'), 'utf8'))).toEqual(toolkitVersion());
    expect(fs.readFileSync(path.join(target, '.gitignore'), 'utf8')).toMatch(/^# project-owned ignore rules only\n[\s\S]*managed block/);
  }, 180000);

  it.each(UPDATE_ENTRIES)('publicEntry_%s_refusesMissingTargets', entry => {
    const target = path.join(root, 'missing target');
    const result = runEntry(entry, ['update', target]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/TARGET/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it.each(['.claude/core', '.agents/roles', '.codex/agents', 'AGENTS.md', '.gitignore'])('publicEntry_symlinkAt_%s_refusesBeforeAnyReadOrWrite', rel => {
    const target = seedLegacyAdopter(root);
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'sentinel.txt'), 'EXTERNAL_KEEP\n');
    fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
    fs.symlinkSync(external, path.join(target, rel), 'dir');
    const before = snapshotTree(target);
    const outside = snapshotTree(external);
    for (const entry of UPDATE_ENTRIES) {
      for (const dryRun of [false, true]) {
        const result = runEntry(entry, ['update', target, '--merge', ...(dryRun ? ['--dry-run'] : [])]);
        expect(result.code, result.output).toBe(1);
        expect(result.output).toMatch(/PATH/);
        expect(snapshotTree(target)).toEqual(before);
        expect(snapshotTree(external)).toEqual(outside);
      }
    }
  });

  it.each(UPDATE_ENTRIES)('publicEntry_%s_ignoresSymlinksInsideNodeModulesButRefusesOtherLinksAtTheSameDepth', entry => {
    const target = seedLegacyAdopter(root);
    // A package manager's dependency tree inside the scope: .bin entries are links.
    const bin = path.join(target, '.agents/mcp-server/node_modules/.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(target, '.agents/mcp-server/node_modules/tool/bin'), { recursive: true });
    fs.writeFileSync(path.join(target, '.agents/mcp-server/node_modules/tool/bin/tool'), '#!/bin/sh\n');
    fs.symlinkSync('../tool/bin/tool', path.join(bin, 'tool'));

    const accepted = runEntry(entry, ['update', target, '--merge', '--dry-run']);
    expect(accepted.code, accepted.output).toBe(0);

    // The same link outside node_modules is still a write-through hazard and is refused.
    const linked = path.join(target, '.agents/mcp-server/vendored');
    fs.symlinkSync(path.join(target, '.agents/mcp-server/node_modules/tool'), linked, 'dir');
    const before = snapshotTree(target);
    const refused = runEntry(entry, ['update', target, '--merge']);
    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toMatch(/PATH/);
    expect(snapshotTree(target)).toEqual(before);
  });

  it.each(UPDATE_ENTRIES)('updateCli_%s_acceptsNeutralNonGitProjectsWithoutPolicyFlags', entry => {
    const target = path.join(root, 'neutral project with spaces');
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(target, 'project.txt'), 'KEEP_PROJECT\n');
    const result = runEntry(entry, ['update', target, '--merge']);
    expect(result.code, result.output).toBe(0);
    expect(fs.readFileSync(path.join(target, 'project.txt'), 'utf8')).toBe('KEEP_PROJECT\n');
    expect(fs.existsSync(path.join(target, '.claude/version.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(false);
  }, 120000);

  it.each(UPDATE_ENTRIES)('updateCli_%s_dryRunWritesNothing', entry => {
    const target = seedLegacyAdopter(root);
    const before = snapshotTree(target);
    const result = runEntry(entry, ['update', target, '--merge', '--dry-run']);
    expect(result.code, result.output).toBe(0);
    expect(snapshotTree(target)).toEqual(before);
  }, 60000);

});

// NA7.14: merging is the default. An update that skipped roles and the settings hooks without a flag was
// only partly applied; the fleet always passed --merge, so a direct update now behaves the same way.
describe('direct update default merge — NA7.14', () => {
  let root;
  beforeEach(() => { root = fs.realpathSync.native(tmp.mkdir('na714-merge')); });

  it('updateCli_noMergeFlag_appliesTheMergesAndASecondRunIsANoOp', () => {
    const target = seedLegacyAdopter(root);
    const args = ['update', target];

    const first = runEntry('.agents/core/template-updater.js', args);
    expect(first.code, first.output).toBe(0);
    expect(first.output).not.toMatch(/use --merge|skipped under --no-merge/);
    // The fixture excludes tailwind-css-patterns: a role written fresh already lacks its pointer, so the
    // second run has nothing left to merge away.
    expect(fs.readFileSync(path.join(target, '.agents/roles/ux-designer.md'), 'utf8')).not.toContain('tailwind-css-patterns/SKILL.md');
    const settled = snapshotTree(target);
    const second = runEntry('.agents/core/template-updater.js', args);

    expect(second.code, second.output).toBe(0);
    expect(second.output).not.toMatch(/skipped under --no-merge/);
    expect(snapshotTree(target)).toEqual(settled);
  }, 180000);

  it('updateCli_defaultAndExplicitMerge_writeTheSameBytes', () => {
    const left = seedLegacyAdopter(fs.realpathSync.native(tmp.mkdir('na714-left')));
    const right = seedLegacyAdopter(fs.realpathSync.native(tmp.mkdir('na714-right')));

    expect(runEntry('.agents/core/template-updater.js', ['update', left]).code).toBe(0);
    expect(runEntry('.agents/core/template-updater.js', ['update', right, '--merge']).code).toBe(0);

    const strip = tree => Object.fromEntries(Object.entries(tree).filter(([rel]) => !rel.startsWith('.git/')));
    expect(strip(snapshotTree(left))).toEqual(strip(snapshotTree(right)));
  }, 180000);

  it('updateCli_noMerge_optsOutAndNamesTheSkippedRoles', () => {
    const target = seedLegacyAdopter(root);
    const args = ['update', target];
    expect(runEntry('.agents/core/template-updater.js', args).code).toBe(0);

    const optOut = runEntry('.agents/core/template-updater.js', [...args, '--no-merge', '--dry-run']);

    expect(optOut.code, optOut.output).toBe(0);
    expect(optOut.output).toMatch(/\.agents\/roles\/[a-z-]+\.md: mixed zone; skipped under --no-merge/);
  }, 180000);

  it('updateCli_mergeAndNoMergeTogether_refusesBeforeAnyWrite', () => {
    const target = seedLegacyAdopter(root);
    const before = snapshotTree(target);

    const result = runEntry('.agents/core/template-updater.js', ['update', target, '--merge', '--no-merge']);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/--merge and --no-merge contradict each other/);
    expect(snapshotTree(target)).toEqual(before);
  }, 60000);
});

// ── NA5.1 AC3: previous-release restoration through the supported updater ────
//
// Two immutable local release checkouts are built from the current toolkit
// (no Git history needed). The adopter installs the previous release, adds
// project-owned work, updates forward and restores the previous release by
// running the ordinary updater with that release as its source — never a Git
// checkout/reset of the adopter, a forced install or a snapshot overwrite.
// The exact changed-path lists and the unsupported residual cases are asserted
// on the observed behavior, so the record is executable.

describe('NA5.1 previous-release restoration', () => {
  const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const MEMORY = 'docs/.output/.memory/constraints/acme-adopter-memory.json';
  const PROJECT_FILE = 'docs/modules/acme/brief.md';
  const TAIL = '\n<!-- @@project-additions -->\n## Acme.App\n\nACME_SKILL_TAIL: keep the factory guard tests.\n';
  // Canonical file -> every runtime path that carries its content.
  const CARRIERS = {
    role: ['.agents/roles/qa-engineer.md', '.claude/agents/qa-engineer.md', '.codex/agents/qa-engineer.toml'],
    skill: ['.agents/skills/review-specialize/SKILL.md', '.claude/skills/review-specialize/SKILL.md', '.claude/commands/review/specialize.md'],
    standards: ['.agents/skills/baseline-fixture/SKILL.md', '.claude/skills/baseline-fixture/SKILL.md'],
    reference: ['.agents/skills/baseline-fixture/references/engineering.md', '.claude/skills/baseline-fixture/references/engineering.md'],
  };
  // Files only the newer release ships, with their native projections.
  const NEXT_ONLY_PATHS = [
    '.agents/core/release-next-only.js',
    '.agents/skills/baseline-fixture/references/release-next-only.md',
    '.claude/core/release-next-only.js',
    '.claude/skills/baseline-fixture/references/release-next-only.md',
    '.codex/core/release-next-only.js',
  ];

  it('releasePair_forwardThenRestorePrevious_retainsProjectWorkWithExactChanges_unsupportedResidual_newerOnlyFilesRemainAndInstallKeepDoesNotRestore', () => {
    const quiet = ['log', 'warn', 'error'].map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      const pair = prepareReleasePair(tmp.root, TOOLKIT);
      // Each release checkout carries toolkit tests and its own project memory.
      for (const release of [pair.previous, pair.next]) {
        expect(fs.existsSync(path.join(release, '.agents/core/__tests__/shared-agents.test.js'))).toBe(true);
        expect(fs.existsSync(path.join(release, '.agents/core/__tests__/_helpers/shared-pilot.cjs'))).toBe(true);
        expect(fs.existsSync(path.join(release, 'docs/.output/.memory/constraints/release-source-only-memory.json'))).toBe(true);
      }
      const target = path.join(tmp.root, 'Acme adopter with spaces');
      fs.mkdirSync(target);

      const installed = runInstall({ source: pair.previous, target });
      expect(installed.ok).toBe(true);
      expect(installed.conflicts).toEqual([]);

      // Project-owned additions on the previous release.
      const role = path.join(target, '.agents/roles/qa-engineer.md');
      fs.writeFileSync(role, read(target, '.agents/roles/qa-engineer.md').replace(/^nickname:.*$/m, 'nickname: Acme-Canary').replace(/^# .+$/m, '# ACME_SOUL_QA') + '\n## Project Context\n\nACME_CONTEXT_QA: Acme.App is a web application.\n');
      fs.appendFileSync(path.join(target, '.agents/skills/review-specialize/SKILL.md'), TAIL);
      for (const [rel, text] of [[PROJECT_FILE, '# Acme module\n\nACME_PROJECT_FILE\n'], [MEMORY, JSON.stringify({ id: 'acme-adopter-memory', content: { description: 'ACME_ADOPTER_MEMORY' } }, null, 2) + '\n']]) {
        fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
        fs.writeFileSync(path.join(target, rel), text);
      }
      expect(renderSharedAgents(target).conflicts).toEqual([]);
      const projectFile = fs.readFileSync(path.join(target, PROJECT_FILE));
      const memory = fs.readFileSync(path.join(target, MEMORY));
      const baseline = snapshotDigests(target);

      const expectRelease = (label, other, stage) => {
        expect(JSON.parse(read(target, '.claude/version.json')).version, stage).toBe(pair.versions[label]);
        expect(JSON.parse(read(target, '.agents/config/version.json')).version, stage).toBe(pair.versions[label]);
        for (const [kind, rels] of Object.entries(CARRIERS)) {
          for (const rel of rels) {
            const text = read(target, rel);
            expect(text, `${stage} ${rel}`).toContain(pair.markers[label][kind]);
            expect(text, `${stage} ${rel}`).not.toContain(pair.markers[other][kind]);
          }
        }
      };
      const expectProjectWork = stage => {
        for (const rel of CARRIERS.role) {
          const text = read(target, rel);
          for (const marker of ['Acme-Canary', 'ACME_SOUL_QA', 'ACME_CONTEXT_QA']) expect(text, `${stage} ${rel} ${marker}`).toContain(marker);
        }
        for (const rel of CARRIERS.skill) expect(read(target, rel), `${stage} ${rel}`).toContain('ACME_SKILL_TAIL');
        expect(fs.readFileSync(path.join(target, PROJECT_FILE)), stage).toEqual(projectFile);
        expect(fs.readFileSync(path.join(target, MEMORY)), stage).toEqual(memory);
        const files = Object.keys(snapshotDigests(target));
        // The adopter's memory is its own, and no release checkout's memory or toolkit tests arrive.
        expect(files.filter(rel => rel.startsWith('docs/.output/.memory/')), stage).toEqual([MEMORY]);
        expect(files.filter(rel => /(^|\/)(__tests__|_helpers|agent-memory)\//.test(rel) || /release-source|RELEASE_SOURCE/.test(rel)), stage).toEqual([]);
      };
      expectRelease('previous', 'next', 'installed');
      expectProjectWork('installed');

      // ── Forward to the next release.
      const forward = updatePilot(pair.next, target);
      expect(forward.errors).toBe(0);
      expect(forward.conflicts).toEqual([]);
      const afterForward = snapshotDigests(target);
      // Exact forward change record. NA5.6: the canonical Claude settings adapter serializes exactly as
      // the settings merger writes it, so an ordinary update leaves .claude/settings.json untouched.
      expect(changedPaths(baseline, afterForward)).toEqual([
        '.agents/config/version.json',
        '.agents/core/release-next-only.js',
        '.agents/render-state.json',
        '.agents/roles/qa-engineer.md',
        '.agents/skills/baseline-fixture/SKILL.md',
        '.agents/skills/baseline-fixture/references/engineering.md',
        '.agents/skills/baseline-fixture/references/release-next-only.md',
        '.agents/skills/review-specialize/SKILL.md',
        '.claude/agents/qa-engineer.md',
        '.claude/commands/review/specialize.md',
        '.claude/core/release-next-only.js',
        '.claude/skills/baseline-fixture/SKILL.md',
        '.claude/skills/baseline-fixture/references/engineering.md',
        '.claude/skills/baseline-fixture/references/release-next-only.md',
        '.claude/skills/review-specialize/SKILL.md',
        '.claude/version.json',
        '.codex/agents/qa-engineer.toml',
        '.codex/core/release-next-only.js',
      ]);
      expect(read(target, '.claude/settings.json')).toBe(read(pair.previous, '.agents/adapters/claude/settings.json'));
      // ...and render keeps managing it: the ledger digest still matches the adopter's file.
      expect(JSON.parse(read(target, '.agents/render-state.json'))['.claude/settings.json']).toBe(createHash('sha256').update(read(target, '.claude/settings.json')).digest('hex'));
      expectRelease('next', 'previous', 'forward');
      expectProjectWork('forward');

      // ── Unsupported: re-running the installer from the previous release with --keep does not
      // restore it. Every existing file is a kept conflict; only MERGE-NOTES is written.
      const keep = runInstall({ source: pair.previous, target, keepAll: true });
      expect(keep.ok).toBe(true);
      expect(keep.conflicts.filter(rel => Object.values(pair.marked).includes(rel)).sort()).toEqual(Object.values(pair.marked).sort());
      const afterKeep = snapshotDigests(target);
      expect(changedPaths(afterForward, afterKeep)).toEqual(['.claude/MERGE-NOTES.md']);
      expectRelease('next', 'previous', 'install --keep');

      // ── Supported restoration: the ordinary updater with the previous release as its source.
      const restore = updatePilot(pair.previous, target);
      expect(restore.errors).toBe(0);
      expect(restore.conflicts).toEqual([]);
      const afterRestore = snapshotDigests(target);
      expect(changedPaths(afterKeep, afterRestore)).toEqual([
        '.agents/config/version.json',
        '.agents/render-state.json',
        '.agents/roles/qa-engineer.md',
        '.agents/skills/baseline-fixture/SKILL.md',
        '.agents/skills/baseline-fixture/references/engineering.md',
        '.agents/skills/review-specialize/SKILL.md',
        '.claude/agents/qa-engineer.md',
        '.claude/commands/review/specialize.md',
        '.claude/skills/baseline-fixture/SKILL.md',
        '.claude/skills/baseline-fixture/references/engineering.md',
        '.claude/skills/review-specialize/SKILL.md',
        '.claude/version.json',
        '.codex/agents/qa-engineer.toml',
      ]);
      expectRelease('previous', 'next', 'restored');
      expectProjectWork('restored');

      // Exact residual against the pre-forward adopter. Every restorable file is byte-identical;
      // unsupported residuals: newer-release-only files (and their projections) are not removed,
      // the ledger still tracks them and the kept-install MERGE-NOTES stays.
      expect(changedPaths(baseline, afterRestore)).toEqual([
        '.agents/core/release-next-only.js',
        '.agents/render-state.json',
        '.agents/skills/baseline-fixture/references/release-next-only.md',
        '.claude/MERGE-NOTES.md',
        '.claude/core/release-next-only.js',
        '.claude/skills/baseline-fixture/references/release-next-only.md',
        '.codex/core/release-next-only.js',
      ]);
      for (const rel of NEXT_ONLY_PATHS.filter(r => r.endsWith('.md'))) expect(read(target, rel), rel).toContain('RELEASE_NEXT_ONLY_REFERENCE');
      expect(read(target, '.agents/core/release-next-only.js')).toContain('RELEASE_NEXT_ONLY_HELPER');
      for (const rel of ['.claude/core/release-next-only.js', '.codex/core/release-next-only.js']) {
        expect(read(target, rel), rel).toContain('"../../.agents/core/release-next-only.js"');
      }
      // The render ledger keeps tracking them, so a later render re-emits their projections.
      const ledger = JSON.parse(read(target, '.agents/render-state.json'));
      expect(NEXT_ONLY_PATHS.filter(rel => /^[0-9a-f]{64}$/.test(ledger[rel] || ''))).toEqual([
        '.agents/core/release-next-only.js',
        '.claude/core/release-next-only.js',
        '.claude/skills/baseline-fixture/references/release-next-only.md',
        '.codex/core/release-next-only.js',
      ]);

      // Restoration is repeat-stable, and neither release checkout was mutated.
      const repeat = updatePilot(pair.previous, target);
      expect(repeat.errors).toBe(0);
      expect(repeat.copied).toBe(0);
      expect(repeat.merged).toBe(0);
      expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
      expect(changedPaths(afterRestore, snapshotDigests(target))).toEqual([]);
      expect(changedPaths(pair.digests.previous, snapshotDigests(pair.previous))).toEqual([]);
      expect(changedPaths(pair.digests.next, snapshotDigests(pair.next))).toEqual([]);
    } finally {
      quiet.forEach(spy => spy.mockRestore());
    }
  // Two rendered toolkit copies, two installs and three real updater runs (20.1 s alone):
  // it carries its own limit; the global limit stays.
  }, 240_000);
});

// NA5.18 AC1/AC2: update walks the source .claude/ tree, and a Git-ignored file
// inside a template-zone directory (here a *.log under a shipped skill) would be
// copied into every adopter. Ignored files never update; a tracked file matching
// an ignore pattern still does; a failed ignore query refuses before any write.
describe('runUpdate — Git-ignored source files never update (NA5.18)', () => {
  let originalProjectDir;
  beforeEach(() => { originalProjectDir = process.env.CLAUDE_PROJECT_DIR; });
  afterEach(() => {
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  });

  function gitSource() {
    tmp.write('src/.claude/skills/architecture/SKILL.md', '# architecture');
    tmp.write('src/.claude/skills/architecture/notes.log', 'LOCAL_LOG_SENTINEL');
    tmp.write('src/.claude/skills/architecture/kept.log', 'TRACKED_LOG');
    tmp.write('src/.claude/scheduled_tasks.lock', 'LOCAL_SESSION_SENTINEL');
    tmp.write('empty-gitconfig', '');
    const source = path.join(tmp.root, 'src');
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp.root, 'empty-gitconfig') };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|TRACE.*)$/.test(key)) delete env[key];
    execFileSync('git', ['-C', source, 'init', '--quiet', '--initial-branch=main'], { env, windowsHide: true });
    tmp.write('src/.git/info/exclude', '.claude/scheduled_tasks.lock\n*.log\n');
    execFileSync('git', ['-C', source, 'add', '-f', '--', '.claude/skills/architecture/kept.log'], { env, windowsHide: true });
    tmp.mkdir('target/.claude');
    process.env.CLAUDE_PROJECT_DIR = source;
    return path.join(tmp.root, 'target');
  }

  it('runUpdate_gitIgnoredTemplateZoneFile_isNotCopied_trackedPatternMatchIs', () => {
    const target = gitSource();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { runUpdate(target, {}); } finally { spy.mockRestore(); }

    expect(fs.readFileSync(path.join(target, '.claude/skills/architecture/SKILL.md'), 'utf8')).toBe('# architecture');
    expect(fs.readFileSync(path.join(target, '.claude/skills/architecture/kept.log'), 'utf8')).toBe('TRACKED_LOG');
    expect(fs.existsSync(path.join(target, '.claude/skills/architecture/notes.log'))).toBe(false);
    // Not a filter check: the zone map classifies scheduled_tasks.lock as unknown
    // and update skips it either way; notes.log above is the filter's proof.
    expect(fs.existsSync(path.join(target, '.claude/scheduled_tasks.lock'))).toBe(false);
  });

  it('runUpdate_failedIgnoreQueryInARealCheckout_refusesBeforeAnyTargetWrite', () => {
    const target = gitSource();
    tmp.write('src/.git/index', 'not a git index');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(() => runUpdate(target, {})).toThrow(/^Update source ignored-file query failed/); } finally { spy.mockRestore(); }
    expect(fs.readdirSync(path.join(target, '.claude'))).toEqual([]);
  });
});
