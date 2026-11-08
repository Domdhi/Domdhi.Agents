// SA-1: actual renderer/install boundary; source edits, output conflicts and paths.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { renderSharedAgents, syncSharedAgents, syncStartupInstructions } = require('../../../.agents/core/_lib/shared-agents');
const { runInstall } = require('../../../.agents/core/install');
const { preparePilot, updatePilot, copyToolkit, snapshotDigests, changedPaths } = require('./_helpers/shared-pilot.cjs');
const { scanAll: scanSkillRefs } = require('../../../.agents/core/skill-resolution');
const { parseAgentSections, extractSkillsList } = require('../../../.agents/core/_lib/agent-merger');
let tmp;
beforeEach(() => { tmp = createTmpDir(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });

function seed(root) {
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  };
  write('.agents/skills/review-specialize/SKILL.md', '---\nname: review-specialize\ndescription: Use when specializing a project.\n---\n\n# Specialize\n\nSHARED_SKILL_V1\n');
  write('.agents/roles/qa-engineer.md', '---\nname: qa-engineer\nnickname: Murphy\ndescription: Quality assurance.\nskills:\n  - review-specialize\n---\n\n# Murphy\n\nSoul.\n\n## Skills\n\nSHARED_ROLE_V1\n');
  write('.claude/shared-agents.json', JSON.stringify({ roles: { 'qa-engineer': { model: 'sonnet', tools: 'Read, Bash', memory: 'project' } } }));
  write('.codex/shared-agents.json', JSON.stringify({ roles: { 'qa-engineer': { model_reasoning_effort: 'high' } } }));
  write('.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/example.cjs"' }] }] } }));
  write('.claude/hooks/example.cjs', 'process.stdout.write("hook-ok");\n');
}

describe('NA6 native trust sidecar render boundary', () => {
  function setup() {
    seed(tmp.root);
    const config = { hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: ['guardrail', 'commit-guard'].map(name => ({ type: 'command', command: `node -e "process.argv[2]='${name}.cjs'"`, timeout: 15 })) }] } };
    const source = path.join(tmp.root, '.agents/adapters/codex/hooks-config.json');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify(config));
    return { config, source, sidecar: path.join(tmp.root, '.codex/hook-identities.json') };
  }
  it('NA6 native trust renders a managed sidecar with one stable entry per handler', () => {
    seed(tmp.root);
    const hooks = { hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: "node -e \"process.argv[2]='guardrail.cjs'\"" }] }] } };
    const source = path.join(tmp.root, '.agents/adapters/codex/hooks-config.json');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, JSON.stringify(hooks));
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    const sidecar = path.join(tmp.root, '.codex/hook-identities.json');
    expect(fs.existsSync(sidecar)).toBe(true);
    const data = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    expect(data.handlers).toHaveLength(1);
    expect(data.handlers[0].fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(renderSharedAgents(tmp.root)).toEqual({ changed: [], conflicts: [] });
  });
  it('warns with exact affected counts for reorder and edit, then stays quiet on repeat', () => {
    const f = setup();
    renderSharedAgents(tmp.root);
    f.config.hooks.PreToolUse[0].hooks.reverse(); fs.writeFileSync(f.source, JSON.stringify(f.config));
    expect(renderSharedAgents(tmp.root).warnings).toEqual(['this change invalidates trust for 2 handlers']);
    expect(renderSharedAgents(tmp.root).warnings).toBeUndefined();
    f.config.hooks.PreToolUse[0].hooks[0].timeout = 25; fs.writeFileSync(f.source, JSON.stringify(f.config));
    expect(renderSharedAgents(tmp.root).warnings).toEqual(['this change invalidates trust for 1 handlers']);
  });
  for (const dryRun of [true, false]) it(`preserves an adopter-owned sidecar and every native output (dryRun=${dryRun})`, () => {
    const f = setup(); fs.mkdirSync(path.dirname(f.sidecar), { recursive: true });
    fs.writeFileSync(f.sidecar, '{"project":"owned"}\n');
    const result = renderSharedAgents(tmp.root, { dryRun });
    expect(result.conflicts).toContain('.codex/hook-identities.json');
    expect(fs.readFileSync(f.sidecar, 'utf8')).toBe('{"project":"owned"}\n');
    expect(fs.existsSync(path.join(tmp.root, '.codex/hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, '.agents/render-state.json'))).toBe(false);
  });
  it('preflights a conflicting hooks projection before sidecar or ledger mutation', () => {
    const f = setup(); renderSharedAgents(tmp.root);
    const before = fs.readFileSync(f.sidecar); const ledger = fs.readFileSync(path.join(tmp.root, '.agents/render-state.json'));
    fs.appendFileSync(path.join(tmp.root, '.codex/hooks.json'), '\nproject-edit');
    f.config.hooks.PreToolUse[0].hooks.reverse(); fs.writeFileSync(f.source, JSON.stringify(f.config));
    expect(renderSharedAgents(tmp.root).conflicts).toContain('.codex/hooks.json');
    expect(fs.readFileSync(f.sidecar)).toEqual(before);
    expect(fs.readFileSync(path.join(tmp.root, '.agents/render-state.json'))).toEqual(ledger);
  });
  it('keeps selected/deferred outputs and dry-run write-free', () => {
    const f = setup(); renderSharedAgents(tmp.root, { dryRun: true });
    expect(fs.existsSync(f.sidecar)).toBe(false);
    renderSharedAgents(tmp.root, { onlyOutputs: new Set(['.codex/hooks.json']) });
    expect(fs.existsSync(f.sidecar)).toBe(false);
    renderSharedAgents(tmp.root, { deferredOutputs: new Set(['.codex/hook-identities.json']) });
    expect(fs.existsSync(f.sidecar)).toBe(false);
    renderSharedAgents(tmp.root); expect(fs.existsSync(f.sidecar)).toBe(true);
  });
  for (const operation of ['sync', 'install-keep', 'install-overwrite']) for (const dryRun of [true, false]) it(`preserves a project helper at the new canonical path (${operation}, dryRun=${dryRun})`, () => {
    const source = path.join(tmp.root, 'source'); const target = path.join(tmp.root, 'target');
    seed(source); seed(target); renderSharedAgents(source); renderSharedAgents(target);
    const rel = '.agents/core/_lib/codex-hook-identities.js';
    for (const [root, text] of [[source, 'module.exports = "toolkit";\n'], [target, 'module.exports = "project-owned";\n']]) {
      const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    }
    const before = snapshotDigests(target);
    const result = operation === 'sync' ? syncSharedAgents(source, target, { merge: true, dryRun })
      : runInstall({ source, target, dryRun, force: operation === 'install-overwrite', keepAll: operation === 'install-keep' });
    expect(result.conflicts).toContain(rel);
    expect(snapshotDigests(target)).toEqual(before);
  });
  it('review F1 refuses direct-render ownership laundering of a different project helper', () => {
    seed(tmp.root);
    const rel = '.agents/core/_lib/codex-hook-identities.js'; const file = path.join(tmp.root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'module.exports = "project-owned";\n');
    const before = snapshotDigests(tmp.root);
    expect(renderSharedAgents(tmp.root).conflicts).toContain(rel);
    expect(snapshotDigests(tmp.root)).toEqual(before);
  });
  for (const selection of [{ onlyOutputs: new Set(['.codex/hook-identities.json']) }, { deferredOutputs: new Set(['.codex/hooks.json']) }]) it('review F2 refuses sidecar-only baseline advancement before native hooks change', () => {
    const f = setup(); renderSharedAgents(tmp.root); const before = snapshotDigests(tmp.root);
    f.config.hooks.PreToolUse[0].hooks.reverse(); fs.writeFileSync(f.source, JSON.stringify(f.config));
    const expected = snapshotDigests(tmp.root);
    expect(renderSharedAgents(tmp.root, selection).conflicts).toContain('.codex/hooks.json');
    expect(snapshotDigests(tmp.root)).toEqual(expected);
    expect(fs.readFileSync(f.sidecar, 'utf8')).toBeTruthy();
    expect(renderSharedAgents(tmp.root).warnings).toEqual(['this change invalidates trust for 2 handlers']);
    expect(before).not.toEqual(expected);
  });
  it('prints the exact trust warning through the native renderer CLI', () => {
    const f = setup(); renderSharedAgents(tmp.root);
    f.config.hooks.PreToolUse[0].hooks.reverse(); fs.writeFileSync(f.source, JSON.stringify(f.config));
    const result = spawnSync(process.execPath, [path.resolve('.codex/core/render-shared-agents.js'), '--root', tmp.root], { encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe('this change invalidates trust for 2 handlers');
  });
});

describe('NA4.28 runtime model tiers', () => {
  const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const tierNames = ['audit', 'deep', 'fast', 'standard'];
  const put = (root, rel, value) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const load = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const mapPath = runtime => `.agents/adapters/${runtime}/model-tiers.json`;
  function tierSeed(root) {
    seed(root);
    for (const runtime of ['claude', 'codex']) {
      put(root, mapPath(runtime), { tiers: { fast: null, standard: runtime === 'claude' ? 'sonnet' : null, deep: runtime === 'claude' ? 'opus' : null, audit: runtime === 'claude' ? 'opus' : null } });
      put(root, `.agents/adapters/${runtime}/shared-agents.json`, { roles: { 'qa-engineer': { tier: 'standard' } } });
    }
    put(root, '.claude/shared-agents.json', { roles: { 'qa-engineer': { tools: 'Read, Bash', memory: 'project' } } });
  }

  it('ships four alias-only Claude tiers and four unassigned Codex tiers with no shipped model identifiers in the Codex notes', () => {
    const claude = load(toolkit, mapPath('claude'));
    const codex = load(toolkit, mapPath('codex'));
    expect(Object.keys(claude.tiers).sort()).toEqual(tierNames);
    expect(Object.keys(codex.tiers).sort()).toEqual(tierNames);
    expect(claude.tiers).toEqual({ fast: null, standard: 'sonnet', deep: 'opus', audit: 'opus' });
    expect(codex.tiers).toEqual({ fast: null, standard: null, deep: null, audit: null });
    expect(codex.notes).toMatch(/inherit/i);
    expect(codex.notes).toMatch(/no model identifiers/i);
    for (const runtime of ['claude', 'codex']) {
      const registry = load(toolkit, `.agents/adapters/${runtime}/shared-agents.json`);
      expect(Object.keys(registry.roles)).toHaveLength(11);
      for (const settings of Object.values(registry.roles)) {
        expect(tierNames).toContain(settings.tier);
        expect(settings).not.toHaveProperty('model');
      }
      expect(registry.roles['security-auditor'].tier).toBe('audit');
      expect(load(toolkit, mapPath(runtime))).not.toHaveProperty('providers');
    }
  });

  it('resolves canonical defaults beneath native settings and omits unassigned Codex models', () => {
    tierSeed(tmp.root);
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    const readRole = runtime => fs.readFileSync(path.join(tmp.root, `.${runtime}/agents/qa-engineer.${runtime === 'claude' ? 'md' : 'toml'}`), 'utf8');
    expect(readRole('claude')).toContain('model: "sonnet"');
    expect(readRole('claude')).toContain('tools: "Read, Bash"');
    expect(readRole('codex')).toContain('model_reasoning_effort = "high"');
    expect(readRole('codex')).not.toMatch(/^model\s*=/m);
    expect(readRole('codex')).not.toContain('sonnet');
    expect(readRole('claude')).not.toMatch(/^tier:/m);
    const claude = load(tmp.root, mapPath('claude'));
    const codex = load(tmp.root, mapPath('codex'));
    claude.tiers.standard = 'opus'; codex.tiers.standard = 'fixture-codex-model';
    put(tmp.root, mapPath('claude'), claude); put(tmp.root, mapPath('codex'), codex);
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    expect(readRole('claude')).toContain('model: "opus"');
    expect(readRole('codex')).toContain('model = "fixture-codex-model"');
    for (const runtime of ['claude', 'codex']) {
      const registry = load(tmp.root, `.${runtime}/shared-agents.json`);
      registry.roles['qa-engineer'].model = `custom-${runtime}`;
      put(tmp.root, `.${runtime}/shared-agents.json`, registry);
    }
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    expect(readRole('claude')).toContain('model: "custom-claude"');
    expect(readRole('codex')).toContain('model = "custom-codex"');
    expect(renderSharedAgents(tmp.root)).toEqual({ changed: [], conflicts: [] });
  });

  it.each([
    ['unknown tier', root => {
      put(root, '.agents/adapters/claude/shared-agents.json', { roles: { 'qa-engineer': { tier: 'unknown' } } });
    }, /unknown.*tier/i],
    ['missing Claude tier file', root => fs.unlinkSync(path.join(root, mapPath('claude'))), /model-tiers\.json/i],
    ['missing Codex tier file', root => fs.unlinkSync(path.join(root, mapPath('codex'))), /model-tiers\.json/i],
    ['unassigned audit', root => {
      const map = load(root, mapPath('claude')); map.tiers.audit = null; put(root, mapPath('claude'), map);
    }, /audit/i],
    ['extra tier', root => {
      const map = load(root, mapPath('codex')); map.tiers.extra = null; put(root, mapPath('codex'), map);
    }, /tiers/i],
    ['missing tier', root => {
      const map = load(root, mapPath('codex')); delete map.tiers.fast; put(root, mapPath('codex'), map);
    }, /tiers/i],
    ['non-string model', root => {
      const map = load(root, mapPath('codex')); map.tiers.standard = {}; put(root, mapPath('codex'), map);
    }, /tier|model/i],
    ['malformed map', root => put(root, mapPath('codex'), '{'), /JSON|property|position/i],
    ['unassigned Claude role', root => {
      put(root, '.claude/shared-agents.json', { roles: { 'qa-engineer': { tier: 'fast' } } });
    }, /unassigned|fast/i],
    ['unknown native override', root => {
      put(root, '.codex/shared-agents.json', { roles: { 'qa-engineer': { tier: 'unknown' } } });
    }, /unknown.*tier/i],
  ])('refuses %s before writing any output', (_name, corrupt, error) => {
    tierSeed(tmp.root);
    corrupt(tmp.root);
    const before = snapshotDigests(tmp.root);
    expect(() => renderSharedAgents(tmp.root)).toThrow(error);
    expect(snapshotDigests(tmp.root)).toEqual(before);
  });

  it('uses incoming tier maps during ordinary sync and preserves explicit adopter choices on repeat', () => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'adopter');
    tierSeed(source);
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    const map = load(source, mapPath('claude')); map.tiers.standard = 'opus';
    put(source, mapPath('claude'), map);
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(target, '.claude/agents/qa-engineer.md'), 'utf8')).toContain('model: "opus"');
    put(target, '.claude/shared-agents.json', { roles: { 'qa-engineer': { model: 'custom-sonnet', tools: 'Read' } } });
    expect(renderSharedAgents(target).conflicts).toEqual([]);
    const before = snapshotDigests(target);
    const again = syncSharedAgents(source, target, { merge: true });
    expect(again.conflicts).toEqual([]);
    expect(again.changed).toEqual([]);
    expect(snapshotDigests(target)).toEqual(before);
  });

  it.each(['malformed JSON', 'unknown tier'])('native render CLI exits nonzero without writes for %s', failure => {
    tierSeed(tmp.root);
    if (failure === 'malformed JSON') put(tmp.root, mapPath('codex'), '{');
    else put(tmp.root, '.claude/shared-agents.json', { roles: { 'qa-engineer': { tier: 'unknown' } } });
    const before = snapshotDigests(tmp.root);
    const result = spawnSync(process.execPath, [path.join(toolkit, '.codex/core/render-shared-agents.js'), tmp.root], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(failure === 'malformed JSON' ? /JSON|property|position/i : /unknown.*tier/i);
    expect(snapshotDigests(tmp.root)).toEqual(before);
  });

  it('propagates an unexpected tier read exception before writing any output', () => {
    tierSeed(tmp.root);
    const before = snapshotDigests(tmp.root);
    const read = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (file === path.join(tmp.root, mapPath('codex'))) throw new Error('injected tier read failure');
      return read(file, ...args);
    });
    try { expect(() => renderSharedAgents(tmp.root)).toThrow('injected tier read failure'); }
    finally { spy.mockRestore(); }
    expect(snapshotDigests(tmp.root)).toEqual(before);
  });

  it('keeps every current Claude role byte unchanged when rendered from the real tier registries', () => {
    for (const rel of ['.agents/roles', '.claude/agents']) {
      fs.cpSync(path.join(toolkit, rel), path.join(tmp.root, rel), { recursive: true });
    }
    for (const runtime of ['claude', 'codex']) for (const rel of [mapPath(runtime), `.agents/adapters/${runtime}/shared-agents.json`, `.${runtime}/shared-agents.json`]) {
      put(tmp.root, rel, fs.readFileSync(path.join(toolkit, rel), 'utf8'));
    }
    const names = fs.readdirSync(path.join(tmp.root, '.claude/agents'));
    expect(names).toHaveLength(11);
    const before = names.map(name => fs.readFileSync(path.join(tmp.root, '.claude/agents', name)));
    const result = renderSharedAgents(tmp.root);
    expect(result.conflicts).toEqual([]);
    expect(result.changed.filter(rel => rel.startsWith('.claude/agents/'))).toEqual([]);
    expect(names.map(name => fs.readFileSync(path.join(tmp.root, '.claude/agents', name)))).toEqual(before);
  });

  it('records session-wide refusal control and keeps forced-subagent-model settings out of committed configuration', () => {
    const fallback = load(toolkit, mapPath('claude')).auditFallback;
    expect(fallback.environment).toEqual({ CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1' });
    expect(fallback.scope).toBe('session-wide');
    expect(fallback).not.toHaveProperty('observedVersion');
    expect(fallback).not.toHaveProperty('observedDate');
    expect(fallback.notes).not.toMatch(/locally installed version/i);
    expect(fallback.documentation).toContain('https://code.claude.com/docs/en/env-vars');
    const forbidden = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';
    const scan = files => [...files].filter(([, text]) => text.includes(forbidden)).map(([rel]) => rel);
    const paths = execFileSync('git', ['ls-files', '-z'], { cwd: toolkit, encoding: 'utf8', windowsHide: true }).split('\0')
      .filter(rel => /(?:^|\/)(?:settings(?:\.[^/]+)?\.json|config\.toml)$/.test(rel));
    expect(paths.length).toBeGreaterThan(0);
    expect(scan(paths.map(rel => [rel, fs.readFileSync(path.join(toolkit, rel), 'utf8')]))).toEqual([]);
    expect(scan([['settings.json', JSON.stringify({ env: { [forbidden]: '1' } })]])).toEqual(['settings.json']);
  });
});

describe('inherited workflow project additions', () => {
  it('ordinary canonical sync keeps inherited blocks and all projections byte-stable on repeat', () => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'adopter with spaces');
    seed(source);
    const relative = '.agents/skills/fixture-workflow/references/workflow.md';
    const put = (rel, text) => { const file = path.join(source, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    const block = '<!-- @@project-additions:start -->\nInherited project rule.\n<!-- @@project-additions:end -->';
    const content = `# Workflow\n\n## Execute\n\nOld shared instruction.\n\n${block}\n\n## Finish\n\nReport.\n`;
    put('.agents/skills/fixture-workflow/SKILL.md', '---\nname: fixture-workflow\ndescription: A fixture workflow.\n---\n\n# Fixture\n');
    put(relative, content);
    put('.agents/adapters/workflows.json', JSON.stringify({ 'fixture-workflow': '.claude/commands/fixture-workflow.md' }));
    fs.mkdirSync(target, { recursive: true });
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    put(relative, content.replace('Old shared instruction.', 'New shared instruction.'));
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    const after = snapshotDigests(target);
    for (const rel of [relative, '.claude/commands/fixture-workflow.md', '.claude/skills/fixture-workflow/references/workflow.md']) {
      const text = fs.readFileSync(path.join(target, rel), 'utf8');
      expect(text.split(block).length - 1).toBe(1);
      expect(text).toContain('New shared instruction.');
    }
    const repeated = syncSharedAgents(source, target, { merge: true });
    expect(repeated.conflicts).toEqual([]);
    expect(repeated.changed).toEqual([]);
    expect(changedPaths(after, snapshotDigests(target))).toEqual([]);
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
  });
});

describe('native gate checkout boundary', () => {
  function fixtures() {
    const installed = path.join(tmp.root, 'installed');
    const foreign = path.join(tmp.root, 'foreign');
    const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const put = (root, rel, value) => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
    };
    seed(installed);
    for (const rel of ['gate.js', '_lib/telemetry-paths.js', '_lib/gate-summary.js', '_lib/owned-process-tree.js', '_lib/windows-process-job.ps1']) {
      put(installed, `.agents/core/${rel}`, fs.readFileSync(path.join(toolkit, '.agents/core', rel)));
    }
    put(installed, '.agents/core/context-probe.js', 'console.log(JSON.stringify({legacy:process.env.CLAUDE_PROJECT_DIR,neutral:process.env.AGENTS_PROJECT_DIR,keep:process.env.B4_KEEP_ENV}));\n');
    const marker = 'const fs=require("fs");fs.writeFileSync("marker.json",JSON.stringify({cwd:process.cwd(),legacy:process.env.CLAUDE_PROJECT_DIR,neutral:process.env.AGENTS_PROJECT_DIR,keep:process.env.B4_KEEP_ENV,lockPresent:fs.existsSync("docs/.output/.state/telemetry/.gate.lock"),runtime:process.env.AGENTS_RUNTIME||null}));console.log("SYNTHETIC_LOCAL_BUILD");\n';
    for (const root of [installed, foreign]) {
      put(root, 'marker.cjs', marker);
      put(root, '.claude/gate.config.json', JSON.stringify({ stack: root === installed ? 'installed-fixture' : 'foreign-fixture', build: { argv: [process.execPath, 'marker.cjs'], timeout: 5000 } }));
    }
    put(foreign, 'marker.json', 'foreign-original-bytes\r\n');
    expect(renderSharedAgents(installed).conflicts).toEqual([]);
    expect(renderSharedAgents(installed)).toEqual({ changed: [], conflicts: [] });
    return { installed, foreign, env: { ...process.env, AGENTS_RUNTIME: '', AGENT_RUNTIME: '', CLAUDE_PROJECT_DIR: foreign, AGENTS_PROJECT_DIR: foreign, CODEX_PROJECT_DIR: foreign, B4_KEEP_ENV: 'preserved' } };
  }

  it.each(['claude', 'codex'])('%s_nativeGateCLI_usesInstalledCheckout_despiteForeignCwdAndRootEnvironment', runtime => {
    const { installed, foreign, env } = fixtures();
    const foreignMarker = fs.readFileSync(path.join(foreign, 'marker.json'));
    const result = spawnSync(process.execPath, [path.join(installed, `.${runtime}/core/gate.js`), 'build'], { cwd: foreign, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const diagnostic = `native gate status=${result.status}; stdout=${(result.stdout || '').slice(-8192)}; stderr=${(result.stderr || '').slice(-8192)}`;
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);
    const output = result.stdout;
    expect(output).toContain('Detected stack: installed-fixture');
    expect(JSON.parse(fs.readFileSync(path.join(installed, 'marker.json'), 'utf8'))).toEqual({ cwd: installed, legacy: installed, neutral: installed, keep: 'preserved', lockPresent: true, runtime: runtime === 'codex' ? 'codex' : null });
    expect(JSON.parse(fs.readFileSync(path.join(installed, 'docs/.output/.state/telemetry/_latest-summary.json'), 'utf8')).stack).toBe('installed-fixture');
    expect(fs.readFileSync(path.join(foreign, 'marker.json'))).toEqual(foreignMarker);
    expect(fs.existsSync(path.join(foreign, 'docs/.output/.state/telemetry'))).toBe(false);
    expect(env.CLAUDE_PROJECT_DIR).toBe(foreign); expect(env.AGENTS_PROJECT_DIR).toBe(foreign);
  });

  it.each(['claude', 'codex'])('%s_nativeGateCLI_honorsInstalledCheckoutLock_despiteForeignRootEnvironment', runtime => {
    const { installed, foreign, env } = fixtures();
    const lockFile = path.join(installed, 'docs/.output/.state/telemetry/.gate.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const lock = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
    fs.writeFileSync(lockFile, lock);
    const result = spawnSync(process.execPath, [path.join(installed, `.${runtime}/core/gate.js`), 'build'], { cwd: foreign, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    expect(result.status, result.stdout + result.stderr).toBe(3);
    expect(result.stderr).toContain('Another gate is already running');
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(lock);
    expect(fs.existsSync(path.join(installed, 'marker.json'))).toBe(false);
    expect(fs.readFileSync(path.join(foreign, 'marker.json'), 'utf8')).toBe('foreign-original-bytes\r\n');
    expect(fs.existsSync(path.join(foreign, 'docs/.output/.state/telemetry'))).toBe(false);
  });

  it.each(['claude', 'codex'])('%s_importedGate_preservesExplicitSharedHelperRootSeam', runtime => {
    const { installed, foreign, env } = fixtures();
    const script = `const gate=require(${JSON.stringify(path.join(installed, `.${runtime}/core/gate.js`))});console.log(JSON.stringify({stack:gate.loadConfig().stack,legacy:process.env.CLAUDE_PROJECT_DIR,neutral:process.env.AGENTS_PROJECT_DIR}));`;
    const output = execFileSync(process.execPath, ['-e', script], { cwd: installed, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    expect(JSON.parse(output)).toEqual({ stack: 'foreign-fixture', legacy: foreign, neutral: foreign });
    expect(fs.readFileSync(path.join(foreign, 'marker.json'), 'utf8')).toBe('foreign-original-bytes\r\n');
    expect(fs.existsSync(path.join(installed, 'marker.json'))).toBe(false);
  });

  it.each(['claude', 'codex'])('%s_unrelatedNativeWrapper_preservesInheritedContext', runtime => {
    const { installed, foreign, env } = fixtures();
    const output = execFileSync(process.execPath, [path.join(installed, `.${runtime}/core/context-probe.js`)], { cwd: foreign, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    expect(JSON.parse(output)).toEqual({ legacy: foreign, neutral: foreign, keep: 'preserved' });
  });
});

describe('NA2.3 managed startup roots', () => {
  const { applyManagedBlock } = require('../../../.agents/core/scaffold');
  const start = brand => `# === ${brand}.Agents managed block — do not edit between markers ===`;
  const end = brand => `# === End ${brand}.Agents managed block ===`;
  const block = (brand, body) => `${start(brand)}\n${body}\n${end(brand)}`;
  const directive = rel => rel === 'CLAUDE.md' ? '@.agents/startup.md' : 'Read `.agents/startup.md` before task work and retain its required rules on resume. Read `.agents/startup-reference.md` only for sections triggered by the current task; preserve project-owned instructions. In Codex, execute helper commands through `.codex/core/`; translate `.claude/core/` examples in shared guidance to that prefix.';
  const roots = ['CLAUDE.md', 'AGENTS.md'];
  const put = (root, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const snapshot = root => roots.map(rel => fs.readFileSync(path.join(root, rel)));
  const expected = rel => `# ${rel} project rules  \n\n` + block('Domdhi', directive(rel)) + '\n\nKEEP_PROJECT_RULE\twith trailing spaces.  \n\n';
  const seedRoots = (root, brand) => roots.forEach(rel => put(root, rel, (`# ${rel} project rules  \n\n` + block(brand, 'STALE_STARTUP') + '\n\nKEEP_PROJECT_RULE\twith trailing spaces.  \n\n').replace(/\n/g, '\r\n')));

  it.each(['Domdhi', 'Example'])('syncStartup_%sRoots_previewsWithoutWritesAndMigratesExactlyOnce', brand => {
    put(tmp.root, '.agents/startup.md', 'Shared startup.\n');
    seedRoots(tmp.root, brand);
    const before = snapshot(tmp.root);

    expect(syncStartupInstructions(tmp.root, { applyManagedBlock, dryRun: true })).toEqual(roots);
    expect(snapshot(tmp.root)).toEqual(before);
    expect(syncStartupInstructions(tmp.root, { applyManagedBlock })).toEqual(roots);

    roots.forEach(rel => expect(fs.readFileSync(path.join(tmp.root, rel), 'utf8')).toBe(expected(rel)));
    const after = snapshot(tmp.root);
    expect(syncStartupInstructions(tmp.root, { applyManagedBlock })).toEqual([]);
    expect(snapshot(tmp.root)).toEqual(after);
  });

  it.each(['Domdhi', 'Example'])('syncStartup_%sEndOnlyInSecondRoot_abortsBothRootWrites', brand => {
    put(tmp.root, '.agents/startup.md', 'Shared startup.\n');
    seedRoots(tmp.root, 'Domdhi');
    put(tmp.root, 'AGENTS.md', '# KEEP_CORRUPT_PROJECT\r\n' + end(brand) + '\r\n');
    const before = snapshot(tmp.root);

    for (const dryRun of [true, false]) {
      expect(() => syncStartupInstructions(tmp.root, { applyManagedBlock, dryRun })).toThrow(/corrupt managed block/i);
      expect(snapshot(tmp.root)).toEqual(before);
    }
  });

  it('syncStartup_malformedSecondDuplicate_abortsPreviewBeforeReplacingFirstRoot', () => {
    put(tmp.root, '.agents/startup.md', 'Shared startup.\n');
    seedRoots(tmp.root, 'Domdhi');
    fs.appendFileSync(path.join(tmp.root, 'AGENTS.md'), start('Example') + '\nKEEP_UNCLOSED_RULE\n');
    const before = snapshot(tmp.root);

    expect(() => syncStartupInstructions(tmp.root, { applyManagedBlock })).toThrow(/corrupt managed block/i);

    expect(snapshot(tmp.root)).toEqual(before);
  });

  it.each(['Domdhi', 'Example'])('installUpdate_%sRoots_preservesAdopterRulesWithoutImportingWorkshopProse', brand => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'adopter with spaces');
    seed(source);
    put(source, '.agents/startup.md', '# Shared startup rules\n');
    put(source, 'CLAUDE.md', '# WORKSHOP_ONLY_CLAUDE_ROOT\n');
    put(source, 'AGENTS.md', '# WORKSHOP_ONLY_AGENTS_ROOT\n');
    expect(renderSharedAgents(source).conflicts).toEqual([]);
    seedRoots(target, brand);
    const before = snapshot(target);

    expect(runInstall({ source, target, dryRun: true }).ok).toBe(true);
    expect(snapshot(target)).toEqual(before);
    const installed = runInstall({ source, target });
    expect(installed.ok).toBe(true);
    expect(installed.conflicts).toEqual([]);

    roots.forEach(rel => expect(fs.readFileSync(path.join(target, rel), 'utf8')).toBe(expected(rel)));
    const afterInstall = snapshot(target);
    for (let attempt = 0; attempt < 2; attempt++) {
      const updated = updatePilot(source, target);
      expect(updated.errors).toBe(0);
      expect(updated.conflicts).toEqual([]);
      expect(snapshot(target)).toEqual(afterInstall);
    }
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
  });

  it('update_mixedDuplicateRoots_collapsesBlocksAndRepeatRetainsExactProjectProse', () => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'adopter');
    fs.mkdirSync(target, { recursive: true });
    seed(source);
    put(source, '.agents/startup.md', '# Shared startup rules\n');
    expect(renderSharedAgents(source).conflicts).toEqual([]);
    expect(runInstall({ source, target }).ok).toBe(true);
    roots.forEach(rel => put(target, rel, '# KEEP_BEFORE\n\n' + block('Domdhi', 'STALE_OLD') + '\n\nKEEP_BETWEEN  \n\n' + block('Example', 'STALE_NEW') + '\nKEEP_AFTER\n'));
    const before = snapshot(target);

    expect(updatePilot(source, target, { dryRun: true }).errors).toBe(0);
    expect(snapshot(target)).toEqual(before);
    const result = updatePilot(source, target);
    expect(result.errors).toBe(0);
    expect(result.conflicts).toEqual([]);

    roots.forEach(rel => expect(fs.readFileSync(path.join(target, rel), 'utf8')).toBe('# KEEP_BEFORE\n\n' + block('Domdhi', directive(rel)) + '\n\nKEEP_BETWEEN  \n\n\nKEEP_AFTER\n'));
    const after = snapshot(target);
    const repeat = updatePilot(source, target);
    expect(repeat.errors).toBe(0);
    expect(repeat.copied).toBe(0);
    expect(repeat.merged).toBe(0);
    expect(snapshot(target)).toEqual(after);
  });

  it('migration_generatedOutputEdit_remainsAnOwnershipConflictAndPreservesBytes', () => {
    seed(tmp.root);
    put(tmp.root, '.agents/startup.md', '# Shared startup rules\n');
    seedRoots(tmp.root, 'Domdhi');
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    const output = path.join(tmp.root, '.claude/agents/qa-engineer.md');
    fs.appendFileSync(output, '\nADOPTER_NATIVE_EDIT\n');
    const before = fs.readFileSync(output);
    const canonicalBefore = fs.readFileSync(path.join(tmp.root, '.agents/roles/qa-engineer.md'));

    syncStartupInstructions(tmp.root, { applyManagedBlock });
    expect(renderSharedAgents(tmp.root).conflicts).toEqual(['.claude/agents/qa-engineer.md']);

    roots.forEach(rel => expect(fs.readFileSync(path.join(tmp.root, rel), 'utf8')).toBe(expected(rel)));
    expect(fs.readFileSync(output)).toEqual(before);
    expect(fs.readFileSync(path.join(tmp.root, '.agents/roles/qa-engineer.md'))).toEqual(canonicalBefore);
  });
});

describe('shared canonical rendering', () => {

  // NA7.17 (the user's decision of 2026-10-12): the Playwright configuration is tracked by default and
  // only the directories Playwright writes its runtime output to are ignored.
  it('canonicalBrowserTemplate_isTrackableAndOnlyPlaywrightRuntimeOutputIsIgnored', () => {
    const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    // Workshop root ignores are project-owned; test the actual distributable scaffold.
    fs.writeFileSync(path.join(tmp.root, '.gitignore'), fs.readFileSync(path.join(toolkit, '.agents/templates/root/gitignore')));
    execFileSync('git', ['init', '-q'], { cwd: tmp.root });
    const check = rel => spawnSync('git', ['check-ignore', '--no-index', '--', rel], { cwd: tmp.root, encoding: 'utf8' }).status;
    for (const config of [
      '.agents/templates/root/.playwright/cli.config.json',
      '.claude/templates/root/.playwright/cli.config.json',
      '.playwright/cli.config.json',
    ]) expect(check(config), config).toBe(1);
    for (const output of ['.playwright-cli/page-1.yml', '.playwright-cli/trace/trace-1.zip', '.playwright-mcp/console-1.log']) {
      expect(check(output), output).toBe(0);
    }
  });

  it('render_browserScaffoldAsset_preservesActualCanonicalConfigAndRepeatIsStable', () => {
    const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const relative = '.agents/templates/root/.playwright/cli.config.json';
    const canonical = path.join(toolkit, relative);
    expect(fs.existsSync(canonical)).toBe(true);
    const actual = fs.readFileSync(canonical);
    expect(actual).toEqual(Buffer.from(fs.readFileSync(path.join(toolkit, '.claude/templates/root/.playwright/cli.config.json'), 'utf8').replace(/\r\n/g, '\n')));
    seed(tmp.root);
    const staged = path.join(tmp.root, relative);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, actual);
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(tmp.root, '.claude/templates/root/.playwright/cli.config.json'))).toEqual(actual);
    const { runScaffold } = require('../../../.agents/core/scaffold');
    runScaffold(tmp.root, { silent: true });
    expect(JSON.parse(fs.readFileSync(path.join(tmp.root, '.playwright/cli.config.json'), 'utf8'))).toEqual({
      browser: { browserName: 'chromium', launchOptions: { channel: 'chrome' } },
      outputDir: 'docs/.output/.state/screenshots',
    });
    expect(renderSharedAgents(tmp.root)).toEqual({ changed: [], conflicts: [] });
  });

  it('installs Codex helper routing in fresh root instructions while preserving project rules', () => {
    const root = path.join(tmp.root, 'fresh');
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents/startup.md'), 'Shared startup rules.');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Project rules\nKeep our project context.\n');
    const { applyManagedBlock } = require('../../../.agents/core/scaffold');
    syncStartupInstructions(root, { applyManagedBlock });
    const instructions = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('Keep our project context.');
    expect(instructions).toContain('In Codex, execute helper commands through `.codex/core/`');
    expect(instructions).toContain('translate `.claude/core/` examples');
    expect(syncStartupInstructions(root, { applyManagedBlock })).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('@.agents/startup.md');
  });

  it.each(['.codex/agents', '.claude/agents', '.agents'])('rejects unsafe %s output/state ancestors in preview and live sync before any write', unsafeDir => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'target');
    seed(source); seed(target); renderSharedAgents(target);
    const external = path.join(tmp.root, 'external');
    fs.renameSync(path.join(target, unsafeDir), external);
    fs.symlinkSync(external, path.join(target, unsafeDir), 'dir');
    const role = path.join(source, '.agents/roles/qa-engineer.md');
    fs.writeFileSync(role, fs.readFileSync(role, 'utf8').replace('SHARED_ROLE_V1', 'SHARED_ROLE_V2'));
    const paths = ['.agents/roles/qa-engineer.md', '.claude/agents/qa-engineer.md', '.codex/agents/qa-engineer.toml', '.agents/render-state.json'];
    const before = paths.map(rel => fs.readFileSync(path.join(target, rel)));
    for (const dryRun of [true, false]) {
      expect(() => syncSharedAgents(source, target, { merge: true, dryRun })).toThrow(/symlinked ancestor/);
      paths.forEach((rel, i) => expect(fs.readFileSync(path.join(target, rel))).toEqual(before[i]));
    }
  });

  it.each([true, false])('preflights installer generated destinations before copies (dryRun=%s)', dryRun => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'target');
    seed(source); seed(target); renderSharedAgents(target);
    const external = path.join(tmp.root, 'external');
    fs.renameSync(path.join(target, '.codex/agents'), external);
    fs.symlinkSync(external, path.join(target, '.codex/agents'), 'dir');
    const role = path.join(source, '.agents/roles/qa-engineer.md');
    fs.writeFileSync(role, fs.readFileSync(role, 'utf8').replace('SHARED_ROLE_V1', 'SHARED_ROLE_V2'));
    const paths = ['.agents/roles/qa-engineer.md', '.claude/agents/qa-engineer.md', '.codex/agents/qa-engineer.toml', '.agents/render-state.json', '.claude/settings.json'];
    const before = paths.map(rel => fs.readFileSync(path.join(target, rel)));
    expect(() => runInstall({ source, target, force: true, dryRun })).toThrow(/symlinked ancestor/);
    paths.forEach((rel, i) => expect(fs.readFileSync(path.join(target, rel))).toEqual(before[i]));
  });

  it.each([false, true])('uses one exclusion set for canonical, legacy and selector install paths (force=%s)', force => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'target');
    seed(source);
    const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put(source, '.claude/skills/legacy-only/SKILL.md', 'legacy skill');
    put(source, '.claude/commands/review/hidden.md', '# hidden selector');
    put(source, '.agents/skills/review-specialize/references/support.md', 'excluded support');
    renderSharedAgents(source);
    put(target, '.claude/update-config.json', JSON.stringify({ skillExclude: ['review-specialize', 'legacy-only', 'review-hidden'] }));
    expect(runInstall({ source, target, force, keepAll: !force }).ok).toBe(true);
    for (const rel of ['.agents/skills/review-specialize', '.claude/skills/review-specialize', '.claude/skills/legacy-only', '.agents/skills/review-hidden', '.claude/commands/review/hidden.md', '.claude/commands/review/specialize.md']) {
      expect(fs.existsSync(path.join(target, rel))).toBe(false);
    }
    // Opt-outs suppress delivery; existing adopter files remain their property.
    put(target, '.agents/skills/review-specialize/SKILL.md', '---\nname: review-specialize\ndescription: Project skill.\n---\n\nLOCAL_CANONICAL\n');
    put(target, '.claude/skills/review-specialize/SKILL.md', 'LOCAL_NATIVE');
    put(target, '.claude/commands/review/hidden.md', 'LOCAL_SELECTOR');
    expect(runInstall({ source, target, force, keepAll: !force }).ok).toBe(true);
    expect(fs.readFileSync(path.join(target, '.agents/skills/review-specialize/SKILL.md'), 'utf8')).toContain('LOCAL_CANONICAL');
    expect(fs.readFileSync(path.join(target, '.claude/skills/review-specialize/SKILL.md'), 'utf8')).toBe('LOCAL_NATIVE');
    expect(fs.readFileSync(path.join(target, '.claude/commands/review/hidden.md'), 'utf8')).toBe('LOCAL_SELECTOR');
  });

  it('updates a generated command selector into an authored skill and retires its output state', () => {
    const source = path.join(tmp.root, 'source');
    const target = path.join(tmp.root, 'target');
    seed(source);
    const command = '.claude/commands/review/specialize.md';
    const skill = '.agents/skills/review-specialize/SKILL.md';
    fs.mkdirSync(path.join(target, path.dirname(command)), { recursive: true });
    fs.writeFileSync(path.join(target, command), '---\ndescription: Specialize.\n---\n\nLEGACY_SPECIALIZE\n');
    expect(renderSharedAgents(target).conflicts).toEqual([]);
    fs.mkdirSync(path.join(source, '.agents/adapters'), { recursive: true });
    fs.writeFileSync(path.join(source, '.agents/adapters/workflows.json'), JSON.stringify({
      'review-specialize': command,
    }));
    fs.writeFileSync(path.join(source, '.agents/adapters/legacy-hashes.json'), JSON.stringify({
      [command]: [createHash('sha256').update(fs.readFileSync(path.join(target, command))).digest('hex')],
    }));
    const preview = syncSharedAgents(source, target, { merge: true, dryRun: true });
    expect(preview.conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(target, skill), 'utf8')).toContain('Generated command entry point');
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(target, skill), 'utf8')).toContain('SHARED_SKILL_V1');
    expect(fs.readFileSync(path.join(target, command), 'utf8')).toContain('SHARED_SKILL_V1');
    expect(JSON.parse(fs.readFileSync(path.join(target, '.agents/render-state.json'), 'utf8'))).not.toHaveProperty(skill);
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
    const again = syncSharedAgents(source, target, { merge: true });
    expect(again.conflicts).toEqual([]);
    expect(again.changed).toEqual([]);
  });

  // Installs and updates every toolkit role with two renders: seconds alone, over the default 30 s on a machine
  // under heavy external load, so it carries its own timeout instead of failing on the clock.
  it('ships every toolkit role through install and legacy update with both native projections and preserved customization', { timeout: 120000 }, () => {
    const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const roleNames = dir => fs.readdirSync(path.join(toolkit, dir)).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
    const names = roleNames('.claude/agents');
    expect(names).toHaveLength(11);
    expect(roleNames('.agents/roles')).toEqual(names);
    expect(fs.readdirSync(path.join(toolkit, '.codex/agents')).filter(f => f.endsWith('.toml')).map(f => f.slice(0, -5)).sort()).toEqual(names);
    const installed = path.join(tmp.root, 'fresh install with spaces');
    fs.mkdirSync(installed);
    expect(runInstall({ source: toolkit, target: installed }).conflicts).toEqual([]);
    for (const name of names) {
      expect(fs.existsSync(path.join(installed, `.agents/roles/${name}.md`))).toBe(true);
      expect(fs.readFileSync(path.join(installed, `.codex/agents/${name}.toml`), 'utf8')).toContain(`name = "${name}"`);
    }
    expect(scanSkillRefs(path.join(installed, '.claude/agents'), path.join(installed, '.claude/skills'))).toEqual([]);
    const legacy = path.join(tmp.root, 'legacy adopter');
    fs.mkdirSync(path.join(legacy, '.claude/agents'), { recursive: true });
    // Brand guidance is project-owned and intentionally never replaced by update.
    fs.cpSync(path.join(installed, '.claude/skills/brand-guidelines'), path.join(legacy, '.claude/skills/brand-guidelines'), { recursive: true });
    const originals = new Map();
    for (const name of names) {
      const text = fs.readFileSync(path.join(installed, `.claude/agents/${name}.md`), 'utf8')
        .replace(/^<!-- Generated from[^\n]*-->\n/gm, '')
        .replace(/^nickname:.*$/m, `nickname: Canary-${name}`)
        .replace(/^# .+$/m, `# LEGACY_SOUL_${name}`) + `\n\n## Project Context\n\nLEGACY_CONTEXT_${name}\n`;
      originals.set(name, parseAgentSections(text));
      fs.writeFileSync(path.join(legacy, `.claude/agents/${name}.md`), text);
    }
    const updated = updatePilot(toolkit, legacy);
    expect(updated.errors).toBe(0);
    expect(updated.conflicts).toEqual([]);
    for (const name of names) {
      const canonical = fs.readFileSync(path.join(legacy, `.agents/roles/${name}.md`), 'utf8');
      const parsed = parseAgentSections(canonical);
      expect(parsed.soulZone).toBe(originals.get(name).soulZone);
      expect(parsed.projectCtx).toBe(originals.get(name).projectCtx);
      expect(parsed.frontmatter).not.toMatch(/^(model|tools|memory|permissionMode|disallowedTools|maxTurns):/m);
      for (const rel of [`.claude/agents/${name}.md`, `.codex/agents/${name}.toml`]) {
        const projection = fs.readFileSync(path.join(legacy, rel), 'utf8');
        expect(projection).toContain(`Canary-${name}`);
        expect(projection).toContain(`LEGACY_SOUL_${name}`);
        expect(projection).toContain(`LEGACY_CONTEXT_${name}`);
      }
    }
    expect(scanSkillRefs(path.join(legacy, '.claude/agents'), path.join(legacy, '.claude/skills'))).toEqual([]);
    const adapter = JSON.parse(fs.readFileSync(path.join(legacy, '.claude/shared-agents.json')));
    expect(adapter.roles['security-auditor'].model).toBe('opus');
    expect(renderSharedAgents(legacy)).toEqual({ changed: [], conflicts: [] });
    const repeat = updatePilot(toolkit, legacy);
    expect(repeat.errors).toBe(0);
    expect(repeat.copied).toBe(0);
    expect(repeat.merged).toBe(0);
  });

  it('pilot_realSourcesAndOrdinaryUpdate_preservesBothRuntimesAndApplicationGates', () => {
    const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const { source, target } = preparePilot(tmp.root, toolkit);
    const before = fs.readFileSync(path.join(target, '.agents/roles/qa-engineer.md'), 'utf8');
    expect(updatePilot(source, target, { dryRun: true }).copied).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(target, '.agents/roles/qa-engineer.md'), 'utf8')).toBe(before);
    const result = updatePilot(source, target);
    expect(result.errors).toBe(0); expect(result.conflicts).toEqual([]);
    for (const rel of ['.agents/roles/qa-engineer.md', '.claude/agents/qa-engineer.md', '.codex/agents/qa-engineer.toml']) {
      const text = fs.readFileSync(path.join(target, rel), 'utf8');
      for (const marker of ['SHARED_PILOT_ROLE_V2', 'CANARY_DISTINCT_SOUL', 'CANARY_DISTINCT_CONTEXT']) expect(text).toContain(marker);
      expect(text).toContain('Canary');
    }
    for (const rel of ['.agents/skills/review-specialize/SKILL.md', '.claude/skills/review-specialize/SKILL.md', '.claude/commands/review/specialize.md']) {
      const text = fs.readFileSync(path.join(target, rel), 'utf8');
      expect(text).toContain('SHARED_PILOT_SKILL_V2'); expect(text).toContain('CANARY_DISTINCT_SKILL');
    }
    expect(scanSkillRefs(path.join(target, '.claude/agents'), path.join(target, '.claude/skills'))).toEqual([]);
    for (const runtime of ['.agents', '.claude']) for (const reference of ['specialization-report.md', 'seed-memory.md']) {
      expect(fs.existsSync(path.join(target, runtime, 'skills/review-specialize/references', reference))).toBe(true);
    }
    expect(fs.existsSync(path.join(target, '.claude/core/__tests__'))).toBe(false);
    const again = updatePilot(source, target);
    expect(again.copied).toBe(0); expect(again.merged).toBe(0);
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
    const config = JSON.parse(fs.readFileSync(path.join(target, '.claude/gate.config.json')));
    expect(config.lint.command).toBe('node application-check.cjs lint');
    expect(execFileSync(process.execPath, [path.join(target, '.claude/core/gate.js'), 'test'], { cwd: target, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: target } })).toContain('Tests: PASSED (2 passed, 0 failed, 1 skipped)');
    execFileSync(process.execPath, [path.join(target, 'application-check.cjs'), 'preflight'], { cwd: target });
    const records = fs.readFileSync(path.join(target, 'application-checks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.map(r => r.mode)).toEqual(['build', 'test', 'lint', 'preflight', 'build', 'test', 'security']);
  // Copies the real toolkit, runs the real updater three times and spawns a gate:
  // 10-19 s alone, 37.7 s under full-suite load, so it carries its own limit; the global 30 s stays.
  }, 120_000);

  it('render_canonicalPilot_emitsClaudeAndCodexNativeEntryPoints', () => {
    seed(tmp.root);
    const result = renderSharedAgents(tmp.root);
    expect(result.conflicts).toEqual([]);
    const claude = fs.readFileSync(path.join(tmp.root, '.claude/agents/qa-engineer.md'), 'utf8');
    const codex = fs.readFileSync(path.join(tmp.root, '.codex/agents/qa-engineer.toml'), 'utf8');
    expect(claude).toContain('model: "sonnet"');
    expect(claude).toContain('tools: "Read, Bash"');
    expect(codex).toContain('model_reasoning_effort = "high"');
    expect(codex).not.toContain('sonnet');
    expect(codex).toContain('developer_instructions = ');
    expect(claude).toContain('SHARED_ROLE_V1');
    expect(codex).toContain('SHARED_ROLE_V1');
    expect(fs.readFileSync(path.join(tmp.root, '.claude/commands/review/specialize.md'), 'utf8')).toContain('SHARED_SKILL_V1');
    expect(fs.readFileSync(path.join(tmp.root, '.claude/skills/review-specialize/SKILL.md'), 'utf8')).toContain('SHARED_SKILL_V1');
    // Codex discovers the canonical SKILL.md directly, with no duplicate selector.
    expect(fs.existsSync(path.join(tmp.root, '.codex/skills'))).toBe(false);
  });

  it('render_repeatAndCanonicalEdit_isStableThenRefreshesBothRuntimes', () => {
    seed(tmp.root); renderSharedAgents(tmp.root);
    expect(renderSharedAgents(tmp.root).changed).toEqual([]);
    const role = path.join(tmp.root, '.agents/roles/qa-engineer.md');
    fs.writeFileSync(role, fs.readFileSync(role, 'utf8').replace('SHARED_ROLE_V1', 'SHARED_ROLE_V2'));
    const skill = path.join(tmp.root, '.agents/skills/review-specialize/SKILL.md');
    fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('SHARED_SKILL_V1', 'SHARED_SKILL_V2'));
    const result = renderSharedAgents(tmp.root);
    expect(result.conflicts).toEqual([]);
    for (const file of ['.claude/agents/qa-engineer.md', '.codex/agents/qa-engineer.toml']) {
      expect(fs.readFileSync(path.join(tmp.root, file), 'utf8')).toContain('SHARED_ROLE_V2');
    }
    expect(fs.readFileSync(skill, 'utf8')).toContain('SHARED_SKILL_V2');
    expect(fs.readFileSync(path.join(tmp.root, '.claude/skills/review-specialize/SKILL.md'), 'utf8')).toContain('SHARED_SKILL_V2');
    expect(renderSharedAgents(tmp.root).changed).toEqual([]);
  });

  it('render_generatedOutputEdit_reportsConflictWithoutImportingOrOverwriting', () => {
    seed(tmp.root); renderSharedAgents(tmp.root);
    const output = path.join(tmp.root, '.claude/agents/qa-engineer.md');
    fs.appendFileSync(output, '\nLOCAL_OUTPUT_EDIT\n');
    const result = renderSharedAgents(tmp.root);
    expect(result.conflicts).toEqual(['.claude/agents/qa-engineer.md']);
    expect(fs.readFileSync(output, 'utf8')).toContain('LOCAL_OUTPUT_EDIT');
    expect(fs.readFileSync(path.join(tmp.root, '.agents/roles/qa-engineer.md'), 'utf8')).not.toContain('LOCAL_OUTPUT_EDIT');
  });

  // The repeated-update refusal observed in the Platform pilot: the project's own unanchored
  // `.playwright*/` ignore re-ignores the nested template directory after the first render, so the
  // canonical source drops out of the render while its output keeps a ledger entry on disk.
  describe('a ledger entry that is no longer an output', () => {
    const TEMPLATE = '.agents/templates/root/.playwright/cli.config.json';
    const OUTPUT = '.claude/templates/root/.playwright/cli.config.json';
    const PLATFORM_SHAPE_IGNORE = '!.claude/templates/root/.playwright/\n.playwright*/\n';

    function gitCheckout(root) {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
      const init = spawnSync('git', ['init', '--initial-branch=main', '-q'], { cwd: root, env, encoding: 'utf8' });
      expect(init.status, init.stderr).toBe(0);
      return env;
    }

    function renderedThenIgnored() {
      seed(tmp.root);
      const env = gitCheckout(tmp.root);
      fs.mkdirSync(path.dirname(path.join(tmp.root, TEMPLATE)), { recursive: true });
      fs.writeFileSync(path.join(tmp.root, TEMPLATE), '{"browser":{"browserName":"chromium"}}\n');
      expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
      const output = path.join(tmp.root, OUTPUT);
      expect(fs.existsSync(output)).toBe(true);
      const ledger = JSON.parse(fs.readFileSync(path.join(tmp.root, '.agents/render-state.json'), 'utf8'));
      expect(ledger[OUTPUT]).toBeTruthy();
      fs.writeFileSync(path.join(tmp.root, '.gitignore'), PLATFORM_SHAPE_IGNORE);
      // The fixture is only meaningful when Git now ignores the canonical source.
      const ignored = spawnSync('git', ['check-ignore', '--', TEMPLATE], { cwd: tmp.root, env, encoding: 'utf8' });
      expect(ignored.status, 'the unanchored ignore must hit the canonical template').toBe(0);
      return { output, ledger };
    }

    it('render_retiredOutputWithUnchangedBytes_isNotReportedAsAnEditedGeneratedFile', () => {
      const { output, ledger } = renderedThenIgnored();
      const bytes = fs.readFileSync(output);
      const state = fs.readFileSync(path.join(tmp.root, '.agents/render-state.json'));

      for (const dryRun of [true, false]) {
        const result = renderSharedAgents(tmp.root, { dryRun });
        expect(result.conflicts, `dryRun=${dryRun}`).toEqual([]);
        expect(result.changed, `dryRun=${dryRun}`).toEqual([]);
      }
      // Nothing written, nothing removed, and the entry is kept for the day the source returns.
      expect(fs.readFileSync(output).equals(bytes)).toBe(true);
      expect(fs.readFileSync(path.join(tmp.root, '.agents/render-state.json')).equals(state)).toBe(true);
      expect(JSON.parse(state.toString('utf8'))[OUTPUT]).toBe(ledger[OUTPUT]);
    });

    it('syncSharedAgents_repeatedUpdateOnAPlatformShapedTarget_reportsNoConflictAndWritesNothingMore', () => {
      const source = path.join(tmp.root, 'source');
      const target = path.join(tmp.root, 'target');
      for (const root of [source, target]) {
        seed(root);
        fs.mkdirSync(path.dirname(path.join(root, TEMPLATE)), { recursive: true });
        fs.writeFileSync(path.join(root, TEMPLATE), '{"browser":{"browserName":"chromium"}}\n');
        gitCheckout(root);
      }
      // The first update's render, then the project's own ignore rule hides the canonical template.
      expect(renderSharedAgents(target).conflicts).toEqual([]);
      fs.writeFileSync(path.join(target, '.gitignore'), PLATFORM_SHAPE_IGNORE);
      const bytes = fs.readFileSync(path.join(target, OUTPUT));

      for (const label of ['second update', 'third update']) {
        const result = syncSharedAgents(source, target, {});
        expect(result.conflicts, label).toEqual([]);
      }
      expect(fs.readFileSync(path.join(target, OUTPUT)).equals(bytes)).toBe(true);
      expect(renderSharedAgents(target, { dryRun: true }).conflicts).toEqual([]);
    });

    it('render_retiredOutputWhoseSourceWasRemoved_isStillReportedEvenWithUnchangedBytes', () => {
      renderedThenIgnored();
      // The source is gone, not hidden: that is the stale-owned-output report, which stays.
      fs.unlinkSync(path.join(tmp.root, TEMPLATE));
      expect(renderSharedAgents(tmp.root, { dryRun: true }).conflicts).toEqual([OUTPUT]);
      expect(fs.existsSync(path.join(tmp.root, OUTPUT))).toBe(true);
    });

    it('render_retiredOutputWithEditedBytes_isStillReportedAsAnEditedGeneratedFile', () => {
      const { output } = renderedThenIgnored();
      fs.appendFileSync(output, '\nLOCAL_OUTPUT_EDIT\n');
      for (const dryRun of [true, false]) {
        expect(renderSharedAgents(tmp.root, { dryRun }).conflicts, `dryRun=${dryRun}`).toEqual([OUTPUT]);
      }
      expect(fs.readFileSync(output, 'utf8')).toContain('LOCAL_OUTPUT_EDIT');
    });

    it('render_retiredOutputWithCrlfCheckout_isNotReportedWhenTheNormalizedBytesMatch', () => {
      const { output } = renderedThenIgnored();
      fs.writeFileSync(output, fs.readFileSync(output, 'utf8').replace(/\n/g, '\r\n'));
      expect(renderSharedAgents(tmp.root, { dryRun: true }).conflicts).toEqual([]);
    });
  });

  it('render_dryRun_writesNothing', () => {
    seed(tmp.root);
    const result = renderSharedAgents(tmp.root, { dryRun: true });
    expect(result.changed).toContain('.claude/agents/qa-engineer.md');
    expect(fs.existsSync(path.join(tmp.root, '.claude/agents'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, '.agents/render-state.json'))).toBe(false);
  });

  it('install_destinationWithSpaces_keepsHookWiringPortableAndRendersFromInstalledSources', () => {
    const source = path.join(tmp.root, 'source'); seed(source);
    renderSharedAgents(source);
    const target = path.join(tmp.root, 'neutral adopter with spaces'); fs.mkdirSync(target);
    const stats = runInstall({ source, target });
    expect(stats.ok).toBe(true);
    expect(fs.readFileSync(path.join(target, '.codex/agents/qa-engineer.toml'), 'utf8')).toContain('SHARED_ROLE_V1');
    const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json')));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toBe('node "$CLAUDE_PROJECT_DIR/.claude/hooks/example.cjs"');
    expect(command).not.toContain(source);
    const script = command.match(/"\$CLAUDE_PROJECT_DIR\/(.*?)"/)[1];
    const { execFileSync } = require('node:child_process');
    expect(execFileSync(process.execPath, [path.join(target, script)], { encoding: 'utf8', cwd: target })).toBe('hook-ok');
    expect(renderSharedAgents(target).changed).toEqual([]);
  });
});

// NA5.1 AC1 + AC2: one real install of the actual toolkit sources into a Acme-like
// adopter carrying every customization class, then ordinary updates through the
// real updater. Each class is asserted on its own, in every runtime that has a
// projection; refusals and the failed substep run against the same messy target.
describe('NA5.1 Acme-like messy adopter install and update', () => {
  const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const skillsOf = text => extractSkillsList(parseAgentSections(text).frontmatter.split('\n')).items;
  const managedBlocks = text => text.split('Domdhi.Agents managed block — do not edit between markers').length - 1;
  const ORG_BLOCK = '**Organization standards (conditional).**';
  const ACME_ROLES = ['qa-engineer', 'general-purpose', 'architect'];
  const projections = name => [`.claude/agents/${name}.md`, `.codex/agents/${name}.toml`];
  // A pre-Wave-10 Shadow: customized, nickname, no `## Skills` section, and a
  // Project Context preceded by two blank lines (NA5.5 round-trip boundary).
  const LEGACY_SHADOW = [
    '---', 'name: shadow', 'nickname: Ghost', 'aliases: [writer, acme-writer]',
    'description: ACME_SHADOW_DESCRIPTION long-form Acme.App release notes and customer explainers.',
    'skills:', '  - ghostwriting', '  - content-formats', '---', '',
    '# Ghost', '', 'ACME_SHADOW_SOUL: I write Acme.App release notes for staff and partner customers.', '',
    '## Identity', '', 'ACME_SHADOW_IDENTITY: plain American English, verified figures only.', '', '',
    '## Project Context', '', 'ACME_SHADOW_CONTEXT: Acme audiences are staff and customers.', '',
  ].join('\n');
  const INLINE = '<!-- @@project-additions:start -->\nACME_STANDARDS_INLINE: Acme.App registers its audit factory Scoped; read backend-data.md first.\n<!-- @@project-additions:end -->\n\n';
  const TAIL = '\n<!-- @@project-additions -->\n## Acme.App specialization\n\nACME_SPECIALIZE_TAIL: keep the web factory guard tests.\n';
  const ACME_SKILL = '---\nname: acme-data-access\ndescription: Use when changing Acme.App web data access.\n---\n\n# Acme data access\n\nACME_LOCAL_SKILL: one IDbContextFactory context per operation.\n';
  const failClosedExit = () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`process.exit(${code})`); });
  };

  it('hubLike_freshInstallOrdinaryUpdateRefusalsAndFailedSubstep_preserveEveryCustomizationClassInBothRuntimesAndRepeatIsNoOp', () => {
    const source = path.join(tmp.root, 'acme release');
    const target = path.join(tmp.root, 'Acme App adopter with spaces');
    const fixture = path.join(toolkit, '.agents/core/__tests__/_fixtures/neutral-adopter');
    copyToolkit(toolkit, source);
    put(source, '.agents/skills/baseline-fixture/SKILL.md', '---\nname: baseline-fixture\ndescription: Disposable fixture guidance.\n---\n\n# Baseline fixture\n\nLoad only the necessary domain fixture.\n');
    for (const name of ['auth-security', 'backend-data', 'brand', 'components', 'engineering', 'infrastructure', 'observability', 'pipelines', 'writing']) {
      put(source, `.agents/skills/baseline-fixture/references/${name}.md`, `# Disposable ${name} fixture\n`);
    }
    // The fixture adds template skills prose to exercise updates for a skill-less legacy persona.
    fs.appendFileSync(path.join(source, '.agents/roles/shadow.md'), '\n## Skills\n\nDisposable writing fixture guidance.\n');
    const roleNames = fs.readdirSync(path.join(source, '.agents/roles')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
    expect(roleNames).toHaveLength(11);
    const standardsFiles = Object.keys(snapshotDigests(path.join(source, '.agents/skills/baseline-fixture'))).sort();
    expect(standardsFiles).toEqual(['SKILL.md', ...['auth-security', 'backend-data', 'brand', 'components', 'engineering', 'infrastructure', 'observability', 'pipelines', 'writing'].map(n => `references/${n}.md`)]);

    // ── Project-owned before install: instructions, local settings, an opt-out, an application gate.
    const roots = {
      'CLAUDE.md': '# Acme.App\n\nACME_CLAUDE_RULE: use IDbContextFactory in every service.\n',
      'AGENTS.md': '# Acme.App agents\n\nACME_AGENTS_RULE: run the application gate before review.\n',
    };
    for (const [rel, text] of Object.entries(roots)) put(target, rel, text);
    const local = '{\n  "permissions": { "allow": ["Bash(dotnet build:*)"] },\n  "ACME_LOCAL": "keep"\n}\n';
    put(target, '.claude/settings.local.json', local);
    const updateConfig = JSON.stringify({ skillExclude: ['tailwind-css-patterns'] }) + '\n';
    put(target, '.claude/update-config.json', updateConfig);
    const gate = {
      stack: 'acme-app-application',
      build: { command: 'npm run build', timeout: 30000 },
      test: { command: 'npm test', timeout: 30000 },
      lint: { command: 'node application-check.cjs lint', timeout: 30000 },
      e2e: { command: 'node application-check.cjs integration --isolated', timeout: 30000 },
    };
    put(target, '.agents/gate.config.json', JSON.stringify(gate, null, 2) + '\n');
    for (const file of ['package.json', 'application.cjs', 'application-check.cjs']) fs.copyFileSync(path.join(fixture, file), path.join(target, file));
    const application = ['package.json', 'application.cjs', 'application-check.cjs'].map(rel => [rel, fs.readFileSync(path.join(target, rel))]);

    // ── Fresh install.
    const installed = runInstall({ source, target });
    expect(installed.ok).toBe(true);
    expect(installed.conflicts).toEqual([]);
    const afterInstallRoots = {};
    for (const [rel, prose] of Object.entries(roots)) {
      const text = read(target, rel);
      expect(text.startsWith(prose)).toBe(true);
      expect(managedBlocks(text)).toBe(1);
      afterInstallRoots[rel] = text;
    }
    expect(read(target, '.claude/settings.local.json')).toBe(local);
    expect(read(target, '.claude/update-config.json')).toBe(updateConfig);
    expect(JSON.parse(read(target, '.claude/gate.config.json'))).toEqual(gate);
    for (const runtime of ['.agents', '.claude']) {
      expect(fs.existsSync(path.join(target, runtime, 'skills/tailwind-css-patterns'))).toBe(false);
      expect(Object.keys(snapshotDigests(path.join(target, runtime, 'skills/baseline-fixture'))).sort()).toEqual(standardsFiles);
    }
    for (const rel of standardsFiles.filter(r => r !== 'SKILL.md')) {
      expect(read(target, `.claude/skills/baseline-fixture/${rel}`)).toBe(read(source, `.agents/skills/baseline-fixture/${rel}`));
    }
    // Codex discovers skills through canonical .agents; no separate Codex skill tree.
    expect(fs.existsSync(path.join(target, '.codex/skills'))).toBe(false);

    // ── Acme customizations after install (canonical edits, then the adopter renders).
    for (const name of ACME_ROLES) {
      const rel = `.agents/roles/${name}.md`;
      let text = read(target, rel).replace(/^nickname:.*$/m, `nickname: Acme-${name}`).replace(/^# .+$/m, `# ACME_SOUL_${name}`);
      if (name === 'architect') text = text.replace(/^description:.*$/m, 'description: ACME_TUNED_DESCRIPTION architecture for Acme.App web services.');
      if (name === 'general-purpose') text = text.replace('  - using-git-worktrees\n', '  - using-git-worktrees\n  - acme-data-access\n');
      put(target, rel, text + `\n## Project Context\n\nACME_CONTEXT_${name}: Acme.App is a web application.\n`);
    }
    put(target, '.agents/skills/acme-data-access/SKILL.md', ACME_SKILL);
    put(target, '.agents/roles/shadow.md', LEGACY_SHADOW);
    fs.appendFileSync(path.join(target, '.agents/skills/review-specialize/SKILL.md'), TAIL);
    const standards = path.join(target, '.agents/skills/baseline-fixture/SKILL.md');
    expect(read(target, '.agents/skills/baseline-fixture/SKILL.md')).toContain('\nLoad only the necessary domain');
    fs.writeFileSync(standards, read(target, '.agents/skills/baseline-fixture/SKILL.md').replace('\nLoad only the necessary domain', `\n${INLINE}Load only the necessary domain`));
    const settings = JSON.parse(read(target, '.claude/settings.json'));
    settings.permissions.allow.push('Bash(dotnet test:*)');
    settings.env = { ...settings.env, ACME_ENV: 'keep' };
    put(target, '.claude/settings.json', JSON.stringify(settings, null, 2) + '\n');
    const codexAdapter = JSON.parse(read(target, '.codex/shared-agents.json'));
    codexAdapter.roles['qa-engineer'] = { model_reasoning_effort: 'low' };
    put(target, '.codex/shared-agents.json', JSON.stringify(codexAdapter, null, 2) + '\n');
    put(target, '.codex/config.toml', '# ACME_CODEX_LOCAL\n');
    expect(renderSharedAgents(target).conflicts).toEqual([]);
    // Brand guidance edited after the render, so the native copy is stale until update renders it.
    const brandRel = '.agents/skills/brand-guidelines/SKILL.md';
    fs.appendFileSync(path.join(target, brandRel), '\n## Acme.App palette\n\nACME_BRAND_PALETTE: Corp Light primary for every Acme surface.\n');
    const hubBrand = read(target, brandRel);
    expect(read(target, '.claude/skills/brand-guidelines/SKILL.md')).not.toContain('ACME_BRAND_PALETTE');
    const shadowBefore = parseAgentSections(LEGACY_SHADOW);

    // ── The next release: shared changes to roles, skills, the organization skill and its reference.
    const toolkitVersion = JSON.parse(read(source, '.agents/config/version.json'));
    put(source, '.agents/config/version.json', JSON.stringify({ ...toolkitVersion, version: `${toolkitVersion.version}-acme-v2` }, null, 2) + '\n');
    for (const name of [...ACME_ROLES, 'shadow']) fs.appendFileSync(path.join(source, `.agents/roles/${name}.md`), '\nV2_ROLE\n');
    for (const [rel, marker] of [
      ['.agents/skills/review-specialize/SKILL.md', 'V2_SPECIALIZE'],
      ['.agents/skills/baseline-fixture/SKILL.md', 'V2_STANDARDS'],
      ['.agents/skills/baseline-fixture/references/engineering.md', 'V2_REFERENCE'],
      [brandRel, 'V2_BRAND_MUST_NOT_ARRIVE'],
    ]) fs.appendFileSync(path.join(source, rel), `\n${marker}\n`);

    // ── AC1: ordinary update.
    const updated = updatePilot(source, target);
    expect(updated.errors).toBe(0);
    expect(updated.conflicts).toEqual([]);
    expect(updated.mergeWarned).toBe(0);
    expect(JSON.parse(read(target, '.claude/version.json')).version).toBe(`${toolkitVersion.version}-acme-v2`);

    // Class: role personalization (nickname, soul, Project Context) in canonical and both projections.
    for (const name of ACME_ROLES) {
      for (const rel of [`.agents/roles/${name}.md`, ...projections(name)]) {
        const text = read(target, rel);
        for (const marker of [`Acme-${name}`, `ACME_SOUL_${name}`, `ACME_CONTEXT_${name}`, 'V2_ROLE']) expect(text, `${rel} ${marker}`).toContain(marker);
      }
    }
    // Class: tuned description.
    expect(parseAgentSections(read(target, '.agents/roles/architect.md')).frontmatter).toMatch(/^description: ACME_TUNED_DESCRIPTION architecture for Acme\.App web services\.$/m);
    expect(read(target, '.codex/agents/architect.toml')).toContain('description = "ACME_TUNED_DESCRIPTION architecture for Acme.App web services."');
    // Class: bespoke local skill unioned after the template-owned list, in both runtimes.
    expect(skillsOf(read(target, '.agents/roles/general-purpose.md'))).toEqual([...skillsOf(read(source, '.agents/roles/general-purpose.md')), 'acme-data-access']);
    expect(read(target, '.claude/agents/general-purpose.md')).toContain('  - acme-data-access\n');
    expect(read(target, '.codex/agents/general-purpose.toml')).toContain('- .agents/skills/acme-data-access/SKILL.md');
    expect(read(target, '.agents/skills/acme-data-access/SKILL.md')).toBe(ACME_SKILL);
    expect(read(target, '.claude/skills/acme-data-access/SKILL.md')).toContain('ACME_LOCAL_SKILL');
    // Class: customized skill-less legacy Shadow is preserved (not retired) and round-trips exactly.
    const shadow = read(target, '.agents/roles/shadow.md');
    const shadowAfter = parseAgentSections(shadow);
    expect(shadowAfter.soulZone).toBe(shadowBefore.soulZone);
    expect(shadowAfter.projectCtx).toBe(shadowBefore.projectCtx);
    expect(shadowAfter.frontmatter).toMatch(/^nickname: Ghost$/m);
    expect(shadowAfter.frontmatter).toMatch(/^aliases: \[writer, acme-writer\]$/m);
    expect(shadowAfter.frontmatter).toMatch(/^description: ACME_SHADOW_DESCRIPTION /m);
    expect(skillsOf(shadow)).toEqual(skillsOf(read(source, '.agents/roles/shadow.md')));
    expect(shadowAfter.skillsZone).toContain('V2_ROLE');
    for (const rel of projections('shadow')) {
      const text = read(target, rel);
      for (const marker of ['Ghost', 'ACME_SHADOW_SOUL', 'ACME_SHADOW_IDENTITY', 'ACME_SHADOW_CONTEXT', 'V2_ROLE']) expect(text, `${rel} ${marker}`).toContain(marker);
    }
    // Class: whole-tail skill additions in the canonical skill, native skill and slash command.
    for (const rel of ['.agents/skills/review-specialize/SKILL.md', '.claude/skills/review-specialize/SKILL.md', '.claude/commands/review/specialize.md']) {
      const text = read(target, rel);
      expect(text, rel).toContain('ACME_SPECIALIZE_TAIL'); expect(text, rel).toContain('V2_SPECIALIZE');
    }
    // Class: inline-fenced additions inside the actual organization skill, in both runtimes.
    for (const rel of ['.agents/skills/baseline-fixture/SKILL.md', '.claude/skills/baseline-fixture/SKILL.md']) {
      const text = read(target, rel);
      expect(text.split('ACME_STANDARDS_INLINE').length - 1, rel).toBe(1);
      expect(text.split('<!-- @@project-additions:start -->').length - 1, rel).toBe(1);
      expect(text, rel).toContain('V2_STANDARDS');
    }
    for (const rel of ['.agents/skills/baseline-fixture/references/engineering.md', '.claude/skills/baseline-fixture/references/engineering.md']) {
      expect(read(target, rel)).toBe(read(source, '.agents/skills/baseline-fixture/references/engineering.md'));
    }
    // Class: project instructions outside the managed startup block.
    for (const rel of Object.keys(roots)) expect(read(target, rel)).toBe(afterInstallRoots[rel]);
    // Class: local settings (Claude local file, opt-out, project settings sections, Codex local files).
    expect(read(target, '.claude/settings.local.json')).toBe(local);
    expect(read(target, '.claude/update-config.json')).toBe(updateConfig);
    const merged = JSON.parse(read(target, '.claude/settings.json'));
    expect(merged.permissions.allow).toEqual(settings.permissions.allow);
    expect(merged.env.ACME_ENV).toBe('keep');
    expect(Object.keys(merged.hooks).sort()).toEqual(Object.keys(JSON.parse(read(source, '.agents/adapters/claude/settings.json')).hooks).sort());
    expect(JSON.parse(read(target, '.codex/shared-agents.json')).roles['qa-engineer']).toEqual({ model_reasoning_effort: 'low' });
    expect(read(target, '.codex/agents/qa-engineer.toml')).toContain('model_reasoning_effort = "low"');
    expect(read(target, '.codex/config.toml')).toBe('# ACME_CODEX_LOCAL\n');
    for (const runtime of ['.agents', '.claude']) expect(fs.existsSync(path.join(target, runtime, 'skills/tailwind-css-patterns'))).toBe(false);
    // Class: application gate stays project-owned and application-only.
    expect(read(target, '.agents/gate.config.json')).toBe(JSON.stringify(gate, null, 2) + '\n');
    expect(JSON.parse(read(target, '.claude/gate.config.json'))).toEqual(gate);
    for (const [rel, bytes] of application) expect(fs.readFileSync(path.join(target, rel))).toEqual(bytes);
    // Class: brand exception — update never overwrites the project-edited canonical file,
    // and the render keeps the Claude copy consistent with it.
    expect(read(target, brandRel)).toBe(hubBrand);
    expect(read(target, '.claude/skills/brand-guidelines/SKILL.md')).toContain('ACME_BRAND_PALETTE');
    expect(read(target, '.claude/skills/brand-guidelines/SKILL.md')).not.toContain('V2_BRAND_MUST_NOT_ARRIVE');
    // Every shipped role's declared skill resolves; disposable fixture guidance is
    // test-owned, never a mandatory production dependency.
    for (const name of roleNames) {
      const canonical = read(target, `.agents/roles/${name}.md`);
      expect(skillsOf(canonical), name).not.toContain('baseline-fixture');
      for (const skill of skillsOf(canonical)) {
        expect(fs.existsSync(path.join(target, '.agents/skills', skill, 'SKILL.md')), `${name}: ${skill}`).toBe(true);
      }
      expect(read(target, `.claude/agents/${name}.md`), name).not.toContain(ORG_BLOCK);
      expect(read(target, `.codex/agents/${name}.toml`), name).not.toContain(ORG_BLOCK);
    }
    expect(scanSkillRefs(path.join(target, '.claude/agents'), path.join(target, '.claude/skills'))).toEqual([]);
    expect(fs.existsSync(path.join(target, '.claude/core/__tests__'))).toBe(false);

    // ── AC2: repeated update and render are no-ops after success.
    const settled = snapshotDigests(target);
    const repeat = updatePilot(source, target);
    expect(repeat.errors).toBe(0);
    expect(repeat.copied).toBe(0);
    expect(repeat.merged).toBe(0);
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
    expect(changedPaths(settled, snapshotDigests(target))).toEqual([]);

    // ── AC2: a further release (V3) against the same messy target.
    put(source, '.agents/config/version.json', JSON.stringify({ ...toolkitVersion, version: `${toolkitVersion.version}-acme-v3` }, null, 2) + '\n');
    fs.appendFileSync(path.join(source, '.agents/roles/qa-engineer.md'), '\nV3_ROLE\n');
    const v2Marker = read(target, '.claude/version.json');

    // A genuine hand edit to a generated projection refuses before any write.
    const handEdited = path.join(target, '.claude/agents/architect.md');
    const pristineProjection = fs.readFileSync(handEdited);
    fs.appendFileSync(handEdited, '\nACME_HAND_EDIT\n');
    let before = snapshotDigests(target);
    const conflicted = updatePilot(source, target);
    expect(conflicted.errors).toBe(0);
    expect(conflicted.conflicts).toEqual(['.claude/agents/architect.md']);
    expect(changedPaths(before, snapshotDigests(target))).toEqual([]);
    fs.writeFileSync(handEdited, pristineProjection);

    // A malformed release source (truncated role frontmatter) refuses before any write and exits non-zero.
    const sourceRole = path.join(source, '.agents/roles/qa-engineer.md');
    const sourceRoleBytes = fs.readFileSync(sourceRole);
    fs.writeFileSync(sourceRole, '---\nname: qa-engineer\nnickname: Murphy\ndescription: truncated release file\n');
    before = snapshotDigests(target);
    let exit = failClosedExit();
    expect(() => updatePilot(source, target)).toThrow('process.exit(1)');
    exit.mockRestore();
    expect(changedPaths(before, snapshotDigests(target))).toEqual([]);
    fs.writeFileSync(sourceRole, sourceRoleBytes);

    // A failed substep (corrupt startup root) exits non-zero and withholds the version marker.
    // Observed existing behavior: the shared phase already wrote its canonical changes.
    const agentsRoot = read(target, 'AGENTS.md');
    const corrupt = agentsRoot + '# === Domdhi.Agents managed block — do not edit between markers ===\nACME_UNCLOSED\n';
    put(target, 'AGENTS.md', corrupt);
    exit = failClosedExit();
    expect(() => updatePilot(source, target)).toThrow('process.exit(1)');
    exit.mockRestore();
    expect(read(target, '.claude/version.json')).toBe(v2Marker);
    expect(read(target, 'AGENTS.md')).toBe(corrupt);
    expect(JSON.parse(read(target, '.agents/config/version.json')).version).toBe(`${toolkitVersion.version}-acme-v3`);
    expect(read(target, '.agents/roles/qa-engineer.md')).toContain('V3_ROLE');
    put(target, 'AGENTS.md', agentsRoot);

    // Retry completes, writes the marker last and keeps every customization; repeat is a no-op.
    const retried = updatePilot(source, target);
    expect(retried.errors).toBe(0);
    expect(retried.conflicts).toEqual([]);
    expect(JSON.parse(read(target, '.claude/version.json')).version).toBe(`${toolkitVersion.version}-acme-v3`);
    expect(read(target, 'AGENTS.md')).toBe(agentsRoot);
    for (const rel of ['.agents/roles/qa-engineer.md', ...projections('qa-engineer')]) {
      const text = read(target, rel);
      for (const marker of ['Acme-qa-engineer', 'ACME_SOUL_qa-engineer', 'ACME_CONTEXT_qa-engineer', 'V3_ROLE']) expect(text, `${rel} ${marker}`).toContain(marker);
    }
    expect(parseAgentSections(read(target, '.agents/roles/shadow.md')).soulZone).toBe(shadowBefore.soulZone);
    expect(skillsOf(read(target, '.agents/roles/general-purpose.md')).at(-1)).toBe('acme-data-access');
    expect(parseAgentSections(read(target, '.agents/roles/architect.md')).frontmatter).toMatch(/^description: ACME_TUNED_DESCRIPTION /m);
    expect(fs.readFileSync(handEdited)).toEqual(pristineProjection);
    const final = snapshotDigests(target);
    const again = updatePilot(source, target);
    expect(again.errors).toBe(0);
    expect(again.copied).toBe(0);
    expect(again.merged).toBe(0);
    expect(renderSharedAgents(target)).toEqual({ changed: [], conflicts: [] });
    expect(changedPaths(final, snapshotDigests(target))).toEqual([]);
  // Copies the real toolkit, installs once and runs the real updater seven times
  // (17.7 s alone): it carries its own limit like the neutral pilot above. The global limit stays.
  }, 240_000);
});

describe('canonical-only config files are not projected to .claude/', () => {
  function seedConfig(root) {
    seed(root);
    for (const [rel, text] of [
      ['.agents/config/guardrail-rules.yaml', 'block_patterns: []\n'],
      ['.agents/config/secret-engine.toml', 'title = "x"\n'],
      ['.agents/config/secret-engine.json', '{"version":"1.0.0"}\n'],
    ]) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  }

  it('mirrors guardrail-rules.yaml, which the runtime reads from .claude/, and not the secret-engine files, which are read from .agents/config/ only', () => {
    seedConfig(tmp.root);
    renderSharedAgents(tmp.root);
    expect(fs.existsSync(path.join(tmp.root, '.claude/guardrail-rules.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmp.root, '.claude/secret-engine.toml'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.root, '.claude/secret-engine.json'))).toBe(false);
  });

  it('the engine wrapper reads its rules and pins from .agents/config/ (so a .claude/ copy would be dead weight)', () => {
    const wrapper = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../hooks/secret-engine.cjs'), 'utf8');
    const bin = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../_lib/secret-engine-bin.js'), 'utf8');
    expect(wrapper).toMatch(/__dirname, '\.\.', 'config', 'secret-engine\.toml'/);
    expect(bin).toMatch(/__dirname, '\.\.', '\.\.', 'config', 'secret-engine\.json'/);
    expect(`${wrapper}${bin}`).not.toMatch(/\.claude[/\\'"]+,?\s*'?secret-engine/);
  });
});
