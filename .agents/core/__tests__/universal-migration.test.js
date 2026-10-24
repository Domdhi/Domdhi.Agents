import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { renderSharedAgents, canonicalFiles, syncSharedAgents } = require('../../../.agents/core/_lib/shared-agents');
function fixture(run) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'universal agents '));
 const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root,rel)),{recursive:true}); fs.writeFileSync(path.join(root,rel),text); };
 try { return run(root,put); } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
describe('universal portable canonical delivery', () => {
 it('enumerates helpers/hooks/templates and projects wrappers with CLI and exports from outside cwd', () => fixture((root,put) => {
  put('.agents/core/example.js', "module.exports = { answer: 42 }; if (require.main === module) console.log(process.argv[2]);\n");
  put('.agents/hooks/example.cjs', "module.exports = { hook: true }; if (require.main === module) console.log('hook');\n");
  put('.agents/templates/example.md','template\n');
  expect(canonicalFiles(root)).toContain('.agents/core/example.js');
  expect(renderSharedAgents(root).conflicts).toEqual([]);
  expect(require(path.join(root,'.claude/core/example.js')).answer).toBe(42);
  expect(execFileSync(process.execPath,[path.join(root,'.claude/core/example.js'),'argument with spaces'],{cwd:os.tmpdir(),encoding:'utf8'})).toBe('argument with spaces\n');
  expect(execFileSync(process.execPath,[path.join(root,'.claude/hooks/example.cjs')],{cwd:os.tmpdir(),encoding:'utf8'})).toBe('hook\n');
  expect(fs.readFileSync(path.join(root,'.claude/templates/example.md'),'utf8')).toBe('template\n');
  expect(renderSharedAgents(root)).toEqual({changed:[],conflicts:[]});
 }));
 it('defaults native Codex CLI and imports to Codex while honoring explicit runtime overrides', () => fixture((root, put) => {
  put('.agents/core/runtime.js', "module.exports = { get runtime() { return process.env.AGENTS_RUNTIME || process.env.AGENT_RUNTIME || 'claude'; } }; if (require.main === module) console.log(module.exports.runtime);\n");
  renderSharedAgents(root);
  const baseEnv = { ...process.env };
  for (const key of ['AGENTS_RUNTIME', 'AGENT_RUNTIME', 'CODEX_PROJECT_DIR']) delete baseEnv[key];
  const codex = path.join(root, '.codex/core/runtime.js');
  const claude = path.join(root, '.claude/core/runtime.js');
  const invoke = (args, extra = {}) => execFileSync(process.execPath, args, { cwd: os.tmpdir(), encoding: 'utf8', env: { ...baseEnv, ...extra } }).trim();
  expect(invoke([codex])).toBe('codex');
  expect(invoke(['-e', `const helper = require(${JSON.stringify(codex)}); console.log(helper.runtime);`])).toBe('codex');
  for (const key of ['AGENTS_RUNTIME', 'AGENT_RUNTIME']) {
    expect(invoke([codex], { [key]: 'claude' })).toBe('claude');
    expect(invoke(['-e', `const helper = require(${JSON.stringify(codex)}); console.log(helper.runtime);`], { [key]: 'claude' })).toBe('claude');
  }
  expect(invoke(['-e', `const helper = require(${JSON.stringify(codex)}); process.env.AGENTS_RUNTIME = 'claude'; console.log(helper.runtime);`])).toBe('claude');
  expect(invoke([claude])).toBe('claude');
  expect(invoke([claude], { AGENT_RUNTIME: 'codex' })).toBe('codex');
 }));
 it('selects the Codex model adapter through the actual generated model-runner import and CLI dependency', () => fixture((root, put) => {
  for (const rel of ['core/_lib/model-runner.js', 'core/_lib/model-policy.js', 'adapters/codex/core/_lib/model-runner.js', 'adapters/claude/core/_lib/model-runner.js']) {
   put(`.agents/${rel}`, fs.readFileSync(require.resolve(`../../../.agents/${rel}`), 'utf8'));
  }
  put('.agents/core/inspect-model.js', "console.log(require('./_lib/model-runner').DEFAULT_MODEL);\n");
  renderSharedAgents(root);
  const env = { ...process.env, CODEX_MEMORY_MODEL: 'codex-test-model', CLAUDE_MEMORY_MODEL: 'claude-test-model' };
  for (const key of ['AGENTS_RUNTIME', 'AGENT_RUNTIME', 'CODEX_PROJECT_DIR']) delete env[key];
  const modelRunner = path.join(root, '.codex/core/_lib/model-runner.js');
  const imported = execFileSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(modelRunner)}).DEFAULT_MODEL);`], { cwd: os.tmpdir(), encoding: 'utf8', env });
  expect(imported.trim()).toBe('codex-test-model');
  const cli = path.join(root, '.codex/core/inspect-model.js');
  expect(execFileSync(process.execPath, [cli], { cwd: os.tmpdir(), encoding: 'utf8', env }).trim()).toBe('codex-test-model');
  expect(execFileSync(process.execPath, [cli], { cwd: os.tmpdir(), encoding: 'utf8', env: { ...env, AGENT_RUNTIME: 'claude' } }).trim()).toBe('claude-test-model');
 }));
 it('reports stale owned output without deleting native or project files', () => fixture((root,put) => {
  put('.agents/core/example.js','module.exports = 1;\n');
  renderSharedAgents(root);
  put('.claude/core/bespoke.js','project-owned\n');
  fs.unlinkSync(path.join(root,'.agents/core/example.js'));
  expect(renderSharedAgents(root,{dryRun:true}).conflicts).toContain('.claude/core/example.js');
  expect(fs.existsSync(path.join(root,'.claude/core/example.js'))).toBe(true);
  expect(fs.readFileSync(path.join(root,'.claude/core/bespoke.js'),'utf8')).toBe('project-owned\n');
 }));
 it('retains installed canonical helper customization when updating', () => fixture((source,put) => {
  put('.agents/core/example.js','module.exports = 1;\n');
  fixture((target,write) => {
   expect(syncSharedAgents(source,target).conflicts).toEqual([]);
   write('.agents/core/example.js','module.exports = 99;\n');
   put('.agents/core/example.js','module.exports = 2;\n');
   expect(syncSharedAgents(source,target).conflicts).toContain('.agents/core/example.js');
   expect(fs.readFileSync(path.join(target,'.agents/core/example.js'),'utf8')).toContain('99');
  });
 }));
 it('renders workflow references into Claude commands while canonical entrypoint reads the shared body',()=>fixture((root,put)=>{
  put('.agents/skills/do/SKILL.md','---\nname: do\ndescription: Run do.\n---\n\nRead `references/workflow.md`.\n');
  put('.agents/skills/do/references/workflow.md','# Do\n\nShared workflow.\n');
  put('.agents/adapters/workflows.json',JSON.stringify({do:'.claude/commands/do.md'}));
  renderSharedAgents(root);
  expect(fs.readFileSync(path.join(root,'.claude/commands/do.md'),'utf8')).toContain('Shared workflow.');
 }));
 it('retains a locally edited legacy helper as an explicit atomic migration conflict',()=>fixture((source,put)=>{
  put('.agents/core/example.js','module.exports = 1;\n');
  fixture((target,write)=>{
   write('.claude/core/example.js','module.exports = 99;\n');
   const result=syncSharedAgents(source,target,{merge:true});
   expect(result.conflicts).toContain('.claude/core/example.js');
   expect(fs.existsSync(path.join(target,'.agents/core/example.js'))).toBe(false);
   expect(fs.readFileSync(path.join(target,'.claude/core/example.js'),'utf8')).toContain('99');
  });
 }));
});
