import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { renderSharedAgents, syncSharedAgents } = require('../_lib/shared-agents');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const claude = { fast: null, standard: 'sonnet', deep: 'opus', audit: 'opus' };
const codex = { fast: null, standard: null, deep: null, audit: null };
let tmp;
beforeEach(() => { tmp = createTmpDir(); });
afterEach(() => tmp.cleanup());
const prose = () => require('../_lib/model-prose');
const tierPath = runtime => `.agents/adapters/${runtime}/model-tiers.json`;
const workflow = '.agents/skills/fixture/references/workflow.md';
function seed(root = tmp.root) {
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  for (const [runtime, tiers] of Object.entries({ claude, codex })) {
    put(tierPath(runtime), JSON.stringify({ tiers }));
    put(`.agents/adapters/${runtime}/shared-agents.json`, JSON.stringify({ roles: { fixture: { tier: 'standard' } } }));
  }
  put('.agents/adapters/workflows.json', JSON.stringify({ fixture: '.claude/commands/fixture.md' }));
  put('.agents/skills/fixture/SKILL.md', '---\nname: fixture\ndescription: Fixture.\n---\n\n{{model-arg:standard}}\n');
  put(workflow, '# Fixture\n\nAgent({{model-arg:deep}}, prompt: "run")\n');
  put('.agents/roles/fixture.md', '---\nname: fixture\ndescription: Fixture role.\n---\n\n# Fixture\n\n## Model Routing\n\nUse {{model-arg:deep}}.\n');
  return put;
}

describe('model prose tokens', () => {
  it.each(['standard', 'deep', 'audit'])('resolves Claude %s from the adapter', tier => {
    expect(prose().renderModelProse(`Agent({{model-arg:${tier}}})`, 'claude', claude)).toBe(`Agent(model: ${JSON.stringify(claude[tier])})`);
  });
  it.each(Object.keys(codex))('instructs omission for empty Codex %s without an alias or inherit', tier => {
    const text = prose().renderModelProse(`{{model-arg:${tier}}}`, 'codex', codex);
    expect(text).toBe('/* omit the model parameter */');
    expect(text).not.toMatch(/sonnet|opus|haiku|inherit|model\s*:/i);
  });
  it('uses an assigned Codex ID without special-casing provider names', () => {
    expect(prose().renderModelProse('{{model-arg:deep}}', 'codex', { ...codex, deep: 'fixture-native-model' })).toBe('model: "fixture-native-model"');
  });
  it.each([
    ['{{model-arg:unknown}}', 'claude', claude],
    ['{{model-arg:deep}', 'claude', claude],
    ['{{model-arg:}}', 'claude', claude],
    ['{{model-arg:fast}}', 'claude', claude],
    ['{{model-arg:deep}}', 'other', claude],
    ['{{model-arg:deep}}', 'codex', { ...codex, deep: 7 }],
    ['{{model-arg:deep}}', 'codex', { ...codex, deep: 'opus' }],
    ['{{model-arg:deep}}', 'codex', { ...codex, deep: 'inherit' }],
    ['{{model-arg:deep}}', 'codex', { ...codex, deep: 'claude-opus-4-8' }],
  ])('refuses invalid token/runtime/value %s (%s)', (text, runtime, tiers) => {
    expect(() => prose().renderModelProse(text, runtime, tiers)).toThrow(/model|tier|runtime/i);
  });
  it('renders command, skill, reference and both role bodies while retaining canonical tokens', () => {
    seed();
    const canonical = tmp.read(workflow);
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    for (const rel of ['.claude/commands/fixture.md', '.claude/skills/fixture/SKILL.md', '.claude/skills/fixture/references/workflow.md', '.claude/agents/fixture.md']) {
      expect(tmp.read(rel)).toMatch(/model: "(?:opus|sonnet)"/);
      expect(tmp.read(rel)).not.toContain('{{model-arg:');
    }
    const native = tmp.read('.codex/agents/fixture.toml');
    expect(native).toContain('omit the model parameter');
    expect(native).not.toMatch(/sonnet|opus|haiku|inherit|\{\{model-arg:/i);
    expect(tmp.read(workflow)).toBe(canonical);
    expect(fs.existsSync(path.join(tmp.root, '.codex/skills'))).toBe(false);
    expect(renderSharedAgents(tmp.root)).toEqual({ changed: [], conflicts: [] });
  });
  it('invalid token refuses before any projection or ledger write', () => {
    const put = seed();
    put(workflow, '{{model-arg:unknown}}');
    expect(() => renderSharedAgents(tmp.root)).toThrow(/unknown.*tier/i);
    expect(fs.existsSync(path.join(tmp.root, '.agents/render-state.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, '.claude/commands/fixture.md'))).toBe(false);
  });
  it.each(['claude', 'codex'])('refuses mismatched %s tier sets and undeclared role tiers', runtime => {
    const put = seed();
    const tiers = { ...(runtime === 'claude' ? claude : codex) };
    delete tiers.deep;
    put(tierPath(runtime), JSON.stringify({ tiers }));
    expect(() => renderSharedAgents(tmp.root)).toThrow(/tiers/i);
    put(tierPath(runtime), JSON.stringify({ tiers: runtime === 'claude' ? claude : codex }));
    put(`.agents/adapters/${runtime}/shared-agents.json`, JSON.stringify({ roles: { fixture: { tier: 'missing' } } }));
    expect(() => renderSharedAgents(tmp.root)).toThrow(/unknown.*tier/i);
    expect(fs.existsSync(path.join(tmp.root, '.agents/render-state.json'))).toBe(false);
  });
  it('incoming tier update changes prose and preserves adopter additions and explicit role models on repeat', () => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'adopter with spaces');
    const put = seed(source);
    fs.mkdirSync(target);
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    const targetWorkflow = path.join(target, workflow);
    fs.appendFileSync(targetWorkflow, '\n<!-- @@project-additions -->\nLocal policy.\n');
    fs.mkdirSync(path.join(target, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(target, '.codex/shared-agents.json'), JSON.stringify({ roles: { fixture: { model: 'project-choice' } } }));
    put(tierPath('claude'), JSON.stringify({ tiers: { ...claude, deep: 'fixture-updated' } }));
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(target, '.claude/commands/fixture.md'), 'utf8')).toContain('model: "fixture-updated"');
    expect(fs.readFileSync(path.join(target, '.claude/commands/fixture.md'), 'utf8')).toContain('Local policy.');
    expect(fs.readFileSync(path.join(target, '.codex/agents/fixture.toml'), 'utf8')).toContain('model = "project-choice"');
    expect(syncSharedAgents(source, target, { merge: true }).changed).toEqual([]);
  });
  it('native read-only CLI resolves canonical workflow for Codex without modifying it', () => {
    seed();
    const before = tmp.read(workflow);
    const result = spawnSync(process.execPath, [path.join(ROOT, '.codex/core/render-shared-agents.js'), '--root', tmp.root, '--prose', workflow, '--runtime', 'codex'], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Agent(/* omit the model parameter */, prompt: "run")');
    expect(result.stdout).not.toMatch(/sonnet|opus|haiku|inherit|\{\{model-arg:/i);
    expect(tmp.read(workflow)).toBe(before);
    expect(fs.existsSync(path.join(tmp.root, '.agents/render-state.json'))).toBe(false);
  });
  it('resolves every inventoried real prose file for both runtimes and the actual Codex CLI', () => {
    const files = [
      ...['do', 'retro', 'review-code-review', 'review-evolve-skills', 'run-tests', 'run-todo', 'sweep', 'todo'].map(name => `.agents/skills/${name}/references/workflow.md`),
      ...['architect', 'code-reviewer', 'general-purpose', 'product-strategist', 'project-planner', 'ux-designer'].map(name => `.agents/roles/${name}.md`),
      '.agents/skills/agent-creator/SKILL.md', '.agents/startup-reference.md',
    ];
    expect(files).toHaveLength(16);
    for (const rel of files) {
      const canonical = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(canonical, rel).toContain('{{model-arg:');
      for (const [runtime, tiers] of Object.entries({ claude, codex })) {
        const rendered = prose().renderModelProse(canonical, runtime, tiers);
        expect(rendered, rel).not.toContain('{{model-arg:');
        if (runtime === 'codex') {
          expect(rendered, rel).toContain('omit the model parameter');
          expect(rendered, rel).not.toMatch(/\bmodel\s*:\s*["']?(?:sonnet|opus|haiku|inherit)\b/i);
        }
      }
    }
    const result = spawnSync(process.execPath, [path.join(ROOT, '.codex/core/render-shared-agents.js'), '--prose', files[0], '--runtime', 'codex'], { encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('omit the model parameter');
    expect(result.stdout).not.toContain('{{model-arg:');
    expect(fs.readFileSync(path.join(ROOT, '.agents/adapters/codex/execution.md'), 'utf8')).toContain('--prose .agents/skills/{name}/references/workflow.md --runtime codex');
  });
  it.each(['../outside.md', '.agents/skills/../../outside.md', '.agents/core/model-prose.js'])('CLI refuses a noncanonical path %s', rel => {
    seed();
    const result = spawnSync(process.execPath, [path.join(ROOT, '.codex/core/render-shared-agents.js'), '--root', tmp.root, '--prose', rel, '--runtime', 'codex'], { encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
  it.each(['{{model-arg:missing}}', '{{model-arg:deep}'])('CLI exits nonzero without output for invalid prose %s', text => {
    seed()(workflow, text);
    const result = spawnSync(process.execPath, [path.join(ROOT, '.codex/core/render-shared-agents.js'), '--root', tmp.root, '--prose', workflow, '--runtime', 'codex'], { encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(fs.existsSync(path.join(tmp.root, '.agents/render-state.json'))).toBe(false);
  });
});

describe('authored model literal guard', () => {
  it.each(['model: "sonnet"', "model: 'opus'", 'model: haiku', 'model:\n  "opus"', '"model": "opus"', '// model: "opus"', 'claude-sonnet-4-6', 'claude-fable-5-1', 'gpt-6.1'])('detects a forbidden control %s in a new source path', literal => {
    tmp.write('.agents/skills/new/references/new.md', `# New\n${literal}\n`);
    const report = prose().scanModelLiterals(tmp.root);
    expect(report.scanned).toBe(1);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].path).toBe('.agents/skills/new/references/new.md');
  });
  it('allows tier files, tests, legacy hashes and explicitly excluded executable constants; still scans other code', () => {
    for (const rel of ['.agents/adapters/claude/model-tiers.json', '.agents/adapters/legacy-hashes.json', '.agents/core/__tests__/fixture.js', '.agents/adapters/claude/core/_lib/model-runner.js', '.agents/core/statusline.sh']) tmp.write(rel, 'model: "opus"');
    tmp.write('.agents/skills/new/SKILL.md', '{{model-arg:deep}}');
    tmp.write('.agents/core/new.js', 'const model = "gpt-6.1";');
    const report = prose().scanModelLiterals(tmp.root);
    expect(report.scanned).toBe(2);
    expect(report.violations.map(hit => hit.path)).toEqual(['.agents/core/new.js']);
  });
  it('finds no forbidden literals across a nonempty live authored tree', () => {
    const report = prose().scanModelLiterals(ROOT);
    expect(report.scanned).toBeGreaterThan(0);
    expect(report.violations).toEqual([]);
  });
  it('checks real adapter parity and every declared role tier', () => {
    const maps = {};
    for (const runtime of ['claude', 'codex']) {
      maps[runtime] = JSON.parse(fs.readFileSync(path.join(ROOT, tierPath(runtime)), 'utf8')).tiers;
      const roles = JSON.parse(fs.readFileSync(path.join(ROOT, `.agents/adapters/${runtime}/shared-agents.json`), 'utf8')).roles;
      expect(Object.keys(roles).length).toBeGreaterThan(0);
      for (const role of Object.values(roles)) expect(Object.hasOwn(maps[runtime], role.tier)).toBe(true);
    }
    expect(Object.keys(maps.claude).sort()).toEqual(Object.keys(maps.codex).sort());
  });
});
