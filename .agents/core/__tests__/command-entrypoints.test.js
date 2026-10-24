// Native selector/install/update boundary; model execution is recorded separately.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { renderSharedAgents, canonicalFiles, syncStartupInstructions: syncStartupInstructionsImpl } = require('../../../.agents/core/_lib/shared-agents');
const { applyManagedBlock } = require('../../../.agents/core/scaffold');
const syncStartupInstructions = (root, options = {}) => syncStartupInstructionsImpl(root, { ...options, applyManagedBlock });
const { runInstall } = require('../../../.agents/core/install');
const { updatePilot } = require('./_helpers/shared-pilot.cjs');
let tmp;
beforeEach(() => {
  tmp = createTmpDir();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });
function seed(prefix = 'source') {
  tmp.write(`${prefix}/.claude/commands/todo.md`, '---\ndescription: Plan work.\n---\n\nAUTHORED_TODO_BODY\n');
  tmp.write(`${prefix}/.claude/commands/review/qa.md`, '---\ndescription: Review QA.\n---\n\nQA_BODY\n');
  tmp.write(`${prefix}/.agents/startup.md`, '# Required rules\n\nSHARED_RULE_V1\n');
  tmp.write(`${prefix}/.agents/startup-reference.md`, '# Optional details\n');
  return path.join(tmp.root, prefix);
}
describe('Codex command entry points and shared startup', () => {
  it('renders_lazyNativeSelectors_withoutTreatingThemAsCanonicalOrDuplicatingSpecialize', () => {
    const source = seed();
    tmp.write('source/.agents/skills/review-specialize/SKILL.md', '---\nname: review-specialize\ndescription: Specialize project.\n---\n\nSPECIALIZE_BODY\n');
    renderSharedAgents(source);
    const text = fs.readFileSync(path.join(source, '.agents/skills/todo/SKILL.md'), 'utf8');
    expect(text).toContain('name: todo');
    expect(text).toContain('Read `.claude/commands/todo.md` before acting');
    expect(text).not.toContain('AUTHORED_TODO_BODY');
    expect(text).toContain('read `.agents/adapters/codex/execution.md`');
    const adapter = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.agents/adapters/codex/execution.md'), 'utf8');
    expect(adapter).toContain('TaskCreate/TaskUpdate');
    expect(adapter).toContain('Agent means native subagent delegation');
    expect(fs.existsSync(path.join(source, '.agents/skills/review-qa/SKILL.md'))).toBe(true);
    expect(canonicalFiles(source)).not.toContain('.agents/skills/todo/SKILL.md');
    expect(canonicalFiles(source)).toContain('.agents/skills/review-specialize/SKILL.md');
    expect(renderSharedAgents(source)).toEqual({ changed: [], conflicts: [] });
    expect(fs.existsSync(path.join(source, '.claude/skills/todo/SKILL.md'))).toBe(false);
    expect(fs.readFileSync(path.join(source, '.agents/skills/review-specialize/SKILL.md'), 'utf8')).toContain('SPECIALIZE_BODY');
  });
  it('rejects_flattenedNameCollisions_beforeWritingSelectors', () => {
    const source = seed();
    tmp.write('source/.claude/commands/review-qa.md', '---\ndescription: Collision.\n---\n');
    expect(() => renderSharedAgents(source)).toThrow('command skill name collision: review-qa');
    expect(fs.existsSync(path.join(source, '.agents/skills/todo/SKILL.md'))).toBe(false);
  });
  it('honors_existingSkillExclusions_forNewNativeCommandSelectors', () => {
    const source = seed();
    renderSharedAgents(source, { excludedSkills: new Set(['todo']) });
    expect(fs.existsSync(path.join(source, '.agents/skills/todo/SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(source, '.agents/skills/review-qa/SKILL.md'))).toBe(true);
  });
  it('preserves_editedGeneratedSelector_andReportsConflict', () => {
    const source = seed(); renderSharedAgents(source);
    const selector = path.join(source, '.agents/skills/todo/SKILL.md');
    fs.appendFileSync(selector, '\nLOCAL_OUTPUT_EDIT\n');
    expect(renderSharedAgents(source).conflicts).toContain('.agents/skills/todo/SKILL.md');
    expect(fs.readFileSync(selector, 'utf8')).toContain('LOCAL_OUTPUT_EDIT');
    fs.writeFileSync(selector, fs.readFileSync(selector, 'utf8').replace(/<!-- Generated command entry point[^\n]*-->\n/, ''));
    expect(renderSharedAgents(source).conflicts).toContain('.agents/skills/todo/SKILL.md');
    expect(fs.existsSync(path.join(source, '.claude/skills/todo/SKILL.md'))).toBe(false);
  });
  it('installs_fromUnrenderedCommands_andRetainsBothRootProseAndLocalSettings', () => {
    const source = seed();
    const target = path.join(tmp.root, 'target with spaces');
    tmp.write('target with spaces/CLAUDE.md', '# App\nCLAUDE_PROJECT_ADDITION\n');
    tmp.write('target with spaces/AGENTS.md', '# App\nCODEX_PROJECT_ADDITION\n');
    tmp.write('target with spaces/.claude/settings.local.json', '{"local":"KEEP"}\n');
    expect(runInstall({ source, target }).ok).toBe(true);
    expect(fs.existsSync(path.join(target, '.agents/skills/todo/SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toContain('CLAUDE_PROJECT_ADDITION');
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toContain('@.agents/startup.md');
    expect(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8')).toContain('CODEX_PROJECT_ADDITION');
    expect(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8')).toContain('Read `.agents/startup.md`');
    expect(fs.readFileSync(path.join(target, '.claude/settings.local.json'), 'utf8')).toBe('{"local":"KEEP"}\n');
    expect(syncStartupInstructions(target)).toEqual([]);
  });
  it('ordinaryUpdate_addsNewCommand_preservesMarkedStartupAdditions_thenIsNoop', () => {
    const source = seed();
    const target = path.join(tmp.root, 'target');
    tmp.write('target/.claude/settings.local.json', '{"local":"KEEP"}\n');
    tmp.write('target/CLAUDE.md', 'APP_ROOT_RULE\n');
    tmp.write('target/AGENTS.md', 'CODEX_ROOT_RULE\n');
    expect(updatePilot(source, target).errors).toBe(0);
    fs.appendFileSync(path.join(target, '.agents/startup.md'), '\n<!-- @@project-additions -->\nPROJECT_STARTUP_RULE\n');
    fs.writeFileSync(path.join(source, '.agents/startup.md'), '# Required rules\n\nSHARED_RULE_V2\n');
    tmp.write('source/.claude/commands/run-todo.md', '---\ndescription: Execute work.\n---\n\nRUN_TODO_BODY\n');
    const preview = updatePilot(source, target, { dryRun: true });
    expect(preview.errors).toBe(0);
    expect(fs.existsSync(path.join(target, '.agents/skills/run-todo/SKILL.md'))).toBe(false);
    const result = updatePilot(source, target);
    expect(result.errors).toBe(0); expect(result.conflicts).toEqual([]);
    expect(fs.existsSync(path.join(target, '.agents/skills/run-todo/SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(target, '.claude/commands/run-todo.md'), 'utf8')).toContain('RUN_TODO_BODY');
    expect(fs.readFileSync(path.join(target, '.agents/startup.md'), 'utf8')).toContain('SHARED_RULE_V2');
    expect(fs.readFileSync(path.join(target, '.agents/startup.md'), 'utf8')).toContain('PROJECT_STARTUP_RULE');
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toContain('APP_ROOT_RULE');
    expect(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8')).toContain('CODEX_ROOT_RULE');
    const again = updatePilot(source, target);
    expect(again.errors).toBe(0); expect(again.copied).toBe(0); expect(again.merged).toBe(0);
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
  });
  it('startupDryRun_writesNothing_andMalformedProjectBlockFailsBeforeOtherRootWrite', () => {
    const source = seed();
    expect(syncStartupInstructions(source, { dryRun: true })).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(fs.existsSync(path.join(source, 'CLAUDE.md'))).toBe(false);
    tmp.write('source/AGENTS.md', '# === Domdhi.Agents managed block — do not edit between markers ===\nBROKEN\n');
    expect(() => syncStartupInstructions(source)).toThrow('Corrupt managed block');
    expect(fs.existsSync(path.join(source, 'CLAUDE.md'))).toBe(false);
  });
  it('refusedSharedUpdate_doesNotCreateRootPointersToMissingStartup', () => {
    const source = seed();
    const target = path.join(tmp.root, 'target');
    tmp.write('target/.claude/settings.local.json', '{}\n');
    tmp.write('target/.agents/skills/local/SKILL.md', '---\nname: local\ndescription: Local.\n---\n\nLOCAL\n');
    renderSharedAgents(target);
    fs.appendFileSync(path.join(target, '.claude/skills/local/SKILL.md'), '\nEDITED_OUTPUT\n');
    const result = updatePilot(source, target);
    expect(result.conflicts).toContain('.claude/skills/local/SKILL.md');
    expect(fs.existsSync(path.join(target, '.agents/startup.md'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'CLAUDE.md'))).toBe(false);
  });
});
