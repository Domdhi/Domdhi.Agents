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
const SOURCE = '.agents/skills/run-todo/references/workflow.md';
const START = '<!-- workflow-routes:diagram:start -->';
const END = '<!-- workflow-routes:diagram:end -->';
const routes = () => require('../_lib/workflow-routes');
const row = overrides => ({ step: 'research', role: 'general-purpose', tier: 'standard', condition: 'Research missing', output: 'Persisted findings', ...overrides });
const document = (rows = [row()], body = 'Agent(subagent_type: "general-purpose", prompt: "Research")') =>
  '# Fixture\n\n```workflow-routes\n' + JSON.stringify(rows, null, 2) + '\n```\n\n' + START + '\nold diagram\n' + END + '\n\n```\n' + body + '\n```\n';
let tmp;
beforeEach(() => { tmp = createTmpDir(); });
afterEach(() => tmp.cleanup());
function seed(root = tmp.root, text = document()) {
  const put = (rel, content) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };
  put(SOURCE, text);
  put('.agents/skills/run-todo/SKILL.md', '---\nname: run-todo\ndescription: Fixture.\n---\n\nRead references/workflow.md.\n');
  put('.agents/adapters/workflows.json', JSON.stringify({ 'run-todo': '.claude/commands/run-todo.md' }));
  for (const runtime of ['claude', 'codex']) put(`.agents/adapters/${runtime}/shared-agents.json`, JSON.stringify({ roles: {} }));
  return put;
}
function cli(root, ...args) {
  return spawnSync(process.execPath, [path.join(ROOT, '.codex/core/render-shared-agents.js'), '--root', root, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENTS_PROJECT_DIR: root, AGENT_SHARED_STATE_ROOT: root } });
}

describe('workflow route schema and deterministic diagram (AC1)', () => {
  it('exports_the_missing_route_surface', () => {
    expect(fs.existsSync(path.join(ROOT, '.agents/core/_lib/workflow-routes.js'))).toBe(true);
  });
  it('render_preserves_body_and_emits_exact_deterministic_diagram', () => {
    const input = document();
    const rendered = routes().renderWorkflowRoutes(input);
    expect(rendered).toContain('```mermaid\nflowchart TD\n');
    expect(rendered).toContain('r0["research: general-purpose / standard"]');
    expect(rendered).toContain('main -->|"Research missing"| r0');
    expect(rendered).toContain('r0 -->|"Persisted findings"| main');
    expect(rendered.split(START)[0]).toBe(input.split(START)[0]);
    expect(rendered.split(END)[1]).toBe(input.split(END)[1]);
    expect(routes().renderWorkflowRoutes(rendered)).toBe(rendered);
    expect(routes().renderWorkflowRoutes(input)).toBe(rendered);
    expect(() => routes().checkWorkflowRoutes(rendered)).not.toThrow();
  });
  it('render_escapes_Mermaid_markup_and_normalizes_only_managed_newlines', () => {
    const input = document([row({ condition: 'a "quote" <tag> [x] | &\nline' })]).replace(/\n/g, '\r\n');
    const rendered = routes().renderWorkflowRoutes(input);
    const diagram = rendered.split(START)[1].split(END)[0];
    expect(diagram).not.toContain('<tag>');
    expect(diagram).not.toContain('"quote"');
    expect(diagram).not.toContain('[x]');
    expect(diagram).toContain('#34;');
    expect(rendered.split(START)[0]).toBe(input.split(START)[0]);
    expect(routes().renderWorkflowRoutes(rendered)).toBe(rendered);
  });
  it.each(['step', 'role', 'tier', 'condition', 'output'])('parse_rejects_missing_%s', field => {
    const record = row(); delete record[field];
    expect(() => routes().parseWorkflowRoutes(document([record]))).toThrow(/route/i);
  });
  it.each([[], [row(), row()], [row({ tier: 'unknown' })], [row({ role: '../role' })], [row({ output: '' })], [row({ step: 3 })], [row({ extra: true })]].map(records => [records]))('parse_rejects_invalid_schema_%j', records => {
    expect(() => routes().parseWorkflowRoutes(document(records))).toThrow(/route/i);
  });
  it.each([
    text => text.replace('[\n', '{\n'),
    text => text + text,
    text => text.replace(END, ''),
    text => text + '\n' + START,
    text => text.replace('```workflow-routes', '```workflow-routes-invalid'),
  ])('render_rejects_malformed_or_ambiguous_markers', mutation => {
    expect(() => routes().renderWorkflowRoutes(mutation(document()))).toThrow(/route|diagram/i);
  });
  it('no_route_documents_remain_byte_identical', () => {
    const text = '# No routes\r\nAgent(subagent_type: "architect")\r\n';
    expect(routes().renderWorkflowRoutes(text)).toBe(text);
    expect(() => routes().checkWorkflowRoutes(text)).not.toThrow();
  });
  it('CRLF_checkout_of_a_fresh_diagram_stays_current', () => {
    const checkout = routes().renderWorkflowRoutes(document()).replace(/\n/g, '\r\n');
    expect(() => routes().checkWorkflowRoutes(checkout)).not.toThrow();
    expect(routes().renderWorkflowRoutes(checkout)).toBe(checkout);
  });
});

describe('route drift and undeclared dispatch fixtures (AC2)', () => {
  it('changed_block_without_regeneration_fails_the_guard', () => {
    const fresh = routes().renderWorkflowRoutes(document());
    const stale = fresh.replace('"Research missing"', '"New condition"');
    expect(() => routes().checkWorkflowRoutes(stale)).toThrow(/stale.*diagram/i);
    expect(() => routes().checkWorkflowRoutes(routes().renderWorkflowRoutes(stale))).not.toThrow();
  });
  it.each([
    'Agent(subagent_type: "architect", prompt: "Do work")',
    'Agent({ subagent_type: "architect", prompt: "Do work" })',
    'Task(architect, "Do work")',
    'Agent(subagent_type: roleVariable, prompt: "Do work")',
    'Agent.call(null, { subagent_type: "architect" })',
    'const dispatch = Agent; dispatch({ subagent_type: "architect" })',
    'Dispatch `architect` agents to inspect the code.',
  ])('undeclared_or_dynamic_dispatch_is_rejected_%s', body => {
    expect(() => routes().renderWorkflowRoutes(document([row()], body))).toThrow(/undeclared|dynamic|unsupported.*dispatch/i);
  });
  it('comments_and_strings_cannot_satisfy_a_missing_declaration', () => {
    const body = '// Agent(subagent_type: "architect")\nconst example = \'Agent(subagent_type: "architect")\';\nAgent(subagent_type: "general-purpose")';
    expect(() => routes().renderWorkflowRoutes(document([row()], body))).not.toThrow();
    expect(() => routes().renderWorkflowRoutes(document([row({ role: 'architect' })], body))).toThrow(/undeclared.*general-purpose/i);
  });
  it('pseudocode_task_notes_and_shell_comments_do_not_hide_real_dispatches', () => {
    const body = "TaskCreate: \"Wave\" (blocks next wave's context)\n# shell comment\nAgent(subagent_type: \"general-purpose\")";
    expect(() => routes().renderWorkflowRoutes(document([row()], body))).not.toThrow();
    expect(routes().extractDispatchRoles(document([row()], body))).toEqual(['general-purpose']);
  });
  it.each(['Agent({ "subagent_type": "architect" })', 'Agent(makeOptions())'])('quoted_keys_and_opaque_call_arguments_fail_closed_%s', body => {
    expect(() => routes().renderWorkflowRoutes(document([row()], body))).toThrow(/undeclared|dynamic/i);
  });
  it('declarations_and_generated_diagram_do_not_count_as_body_dispatches', () => {
    const text = routes().renderWorkflowRoutes(document([row({ role: 'architect' })], 'No dispatch here.'));
    expect(routes().extractDispatchRoles(text)).toEqual([]);
  });
  it.each([['```js', '````'], ['  ```js', '  ```']])('CommonMark_fences_cannot_hide_dispatches_%s_%s', (open, close) => {
    const text = document([row()], 'Agent(subagent_type: "architect")').replace('\n```\nAgent', '\n' + open + '\nAgent').replace(/```\n$/, close + '\n');
    expect(() => routes().renderWorkflowRoutes(text)).toThrow(/undeclared.*architect/i);
  });
  it('HTML_comment_delimiters_inside_code_strings_cannot_hide_a_dispatch', () => {
    const body = 'const before = "<!--";\nAgent(subagent_type: "architect");\nconst after = "-->";';
    expect(() => routes().renderWorkflowRoutes(document([row()], body))).toThrow(/undeclared.*architect/i);
  });
  it.each(['const invoke = Task; invoke("architect")', 'Task.call(null, "architect")'])('Task_alias_or_chain_is_refused_%s', body => {
    expect(() => routes().renderWorkflowRoutes(document([row()], body))).toThrow(/unsupported.*dispatch/i);
  });
  it('opaque_nested_options_cannot_credit_a_literal_role_in_an_inner_call', () => {
    expect(() => routes().renderWorkflowRoutes(document([row()], 'Agent(makeOptions({subagent_type: "general-purpose"}))'))).toThrow(/dynamic/i);
  });
  it.each(['Agent({ options: makeOptions({ subagent_type: "general-purpose" }) })', 'Agent({ options: { subagent_type: "general-purpose" } })'])('only_a_direct_outer_role_property_can_declare_the_dispatch_%s', body => {
    expect(() => routes().renderWorkflowRoutes(document([row()], body))).toThrow(/dynamic/i);
  });
  it('direct_named_role_after_other_fields_is_valid', () => {
    const text = document([row()], 'Agent(prompt: "Do work", subagent_type: "general-purpose")');
    expect(() => routes().renderWorkflowRoutes(text)).not.toThrow();
    expect(routes().extractDispatchRoles(text)).toEqual(['general-purpose']);
  });
  it('pins_the_natural_language_limit_instead_of_claiming_semantic_completeness', () => {
    expect(routes().extractDispatchRoles('Ask an architecture specialist to inspect the code.')).toEqual([]);
  });
});

describe('native render/update integration', () => {
  it('explicit_refresh_changes_only_the_diagram_and_repeat_is_a_noop', () => {
    seed();
    const before = tmp.read(SOURCE);
    const check = cli(tmp.root, '--routes', '--check');
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/stale.*diagram/i);
    expect(tmp.read(SOURCE)).toBe(before);
    expect(cli(tmp.root, '--routes', '--dry-run').status).toBe(0);
    expect(tmp.read(SOURCE)).toBe(before);
    expect(cli(tmp.root, '--routes').status).toBe(0);
    const after = tmp.read(SOURCE);
    expect(after).toBe(routes().renderWorkflowRoutes(before));
    expect(cli(tmp.root, '--routes', '--check').status).toBe(0);
    expect(cli(tmp.root, '--routes').stdout).not.toMatch(/^ROUTES /m);
    expect(tmp.read(SOURCE)).toBe(after);
    expect(fs.existsSync(path.join(tmp.root, '.agents/render-state.json'))).toBe(false);
  });
  it('default_renderer_and_Codex_prose_generate_diagrams_without_mutating_source', () => {
    seed();
    const before = tmp.read(SOURCE);
    const expected = routes().renderWorkflowRoutes(before);
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    expect(tmp.read('.claude/commands/run-todo.md')).toContain(expected);
    expect(tmp.read('.claude/skills/run-todo/references/workflow.md')).toBe(expected);
    const view = cli(tmp.root, '--prose', SOURCE, '--runtime', 'codex');
    expect(view.status, view.stderr).toBe(0);
    expect(view.stdout).toBe(expected);
    expect(tmp.read(SOURCE)).toBe(before);
    expect(renderSharedAgents(tmp.root)).toEqual({ changed: [], conflicts: [] });
    expect(cli(tmp.root, '--check').status).toBe(1);
  });
  it('invalid_route_exits_nonzero_and_does_not_write_any_projection_or_source', () => {
    const invalid = document([row()], 'Agent(subagent_type: "architect")');
    seed(tmp.root, invalid);
    for (const args of [['--routes'], [], ['--prose', SOURCE, '--runtime', 'codex']]) {
      const result = cli(tmp.root, ...args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/undeclared.*architect/i);
      expect(tmp.read(SOURCE)).toBe(invalid);
      expect(fs.existsSync(path.join(tmp.root, '.agents/render-state.json'))).toBe(false);
      expect(fs.existsSync(path.join(tmp.root, '.claude/commands/run-todo.md'))).toBe(false);
    }
  });
  it('refresh_validates_all_inputs_before_writes', () => {
    seed();
    const second = '.agents/skills/second/references/workflow.md';
    tmp.write(second, document([row()], 'Agent(subagent_type: "architect")'));
    const before = tmp.read(SOURCE);
    expect(cli(tmp.root, '--routes').status).toBe(1);
    expect(tmp.read(SOURCE)).toBe(before);
  });
  it('refresh_honors_project_skill_exclusions', () => {
    seed();
    tmp.write('.claude/update-config.json', JSON.stringify({ skillExclude: ['run-todo'] }));
    const before = tmp.read(SOURCE);
    expect(cli(tmp.root, '--routes').status).toBe(0);
    expect(cli(tmp.root, '--routes', '--check').status).toBe(0);
    expect(tmp.read(SOURCE)).toBe(before);
  });
  it('refresh_refuses_a_symlinked_ancestor_without_changing_its_target', () => {
    seed();
    const external = path.join(tmp.root, 'external');
    fs.renameSync(path.join(tmp.root, '.agents/skills/run-todo/references'), external);
    fs.symlinkSync(external, path.join(tmp.root, '.agents/skills/run-todo/references'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = fs.readFileSync(path.join(external, 'workflow.md'), 'utf8');
    const result = cli(tmp.root, '--routes');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/symlink|link/i);
    expect(fs.readFileSync(path.join(external, 'workflow.md'), 'utf8')).toBe(before);
  });
  it('nonroute_symlinked_workflow_remains_outside_canonical_refresh', () => {
    seed();
    const external = tmp.mkdir('external');
    fs.writeFileSync(path.join(external, 'workflow.md'), '# Project workflow\nNo route metadata.\n');
    tmp.mkdir('.agents/skills/local');
    fs.symlinkSync(external, path.join(tmp.root, '.agents/skills/local/references'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = cli(tmp.root, '--routes');
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(external, 'workflow.md'), 'utf8')).toBe('# Project workflow\nNo route metadata.\n');
  });
  it('projection_conflict_preserves_source_ledger_and_other_outputs', () => {
    const put = seed();
    renderSharedAgents(tmp.root);
    tmp.write('.claude/commands/run-todo.md', 'Project edit');
    const ledger = tmp.read('.agents/render-state.json');
    const reference = tmp.read('.claude/skills/run-todo/references/workflow.md');
    put(SOURCE, document([row({ condition: 'Updated' })]));
    expect(renderSharedAgents(tmp.root).conflicts).toContain('.claude/commands/run-todo.md');
    expect(tmp.read('.agents/render-state.json')).toBe(ledger);
    expect(tmp.read('.claude/skills/run-todo/references/workflow.md')).toBe(reference);
  });
  it('update_renders_queued_incoming_routes_and_preserves_adopter_additions', () => {
    const source = path.join(tmp.root, 'source'); const target = path.join(tmp.root, 'target');
    const put = seed(source); fs.mkdirSync(target);
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    fs.appendFileSync(path.join(target, SOURCE), '\n<!-- @@project-additions -->\nProject policy.\n');
    put(SOURCE, routes().renderWorkflowRoutes(document([row({ condition: 'Incoming condition' })])));
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    const native = fs.readFileSync(path.join(target, '.claude/commands/run-todo.md'), 'utf8');
    expect(native).toContain('main -->|"Incoming condition"| r0');
    expect(native).toContain('Project policy.');
    expect(syncSharedAgents(source, target, { merge: true }).changed).toEqual([]);
  });
});

describe('actual pilot and workflow inventory (AC3)', () => {
  it('checks_the_real_pilot_and_all_six_routes', () => {
    const text = fs.readFileSync(path.join(ROOT, SOURCE), 'utf8');
    expect(routes().parseWorkflowRoutes(text)).toHaveLength(6);
    expect(() => routes().checkWorkflowRoutes(text)).not.toThrow();
    expect(routes().extractDispatchRoles(text)).toEqual(['code-reviewer', 'doc-writer', 'general-purpose']);
  });
  it('routes_or_lists_as_pending_every_current_dispatching_workflow', () => {
    // A new dispatching workflow must either carry a routes block or be added to this list on purpose.
    const PENDING = [
    '.agents/skills/brainstorm/references/workflow.md',
    '.agents/skills/create-project-architecture/references/workflow.md',
    '.agents/skills/create-project-brief/references/workflow.md',
    '.agents/skills/create-project-design/references/workflow.md',
    '.agents/skills/create-project-epics-todo/references/workflow.md',
    '.agents/skills/create-project-epics/references/workflow.md',
    '.agents/skills/create-project-requirements/references/workflow.md',
    '.agents/skills/create-project-todo/references/workflow.md',
    '.agents/skills/do/references/workflow.md',
    '.agents/skills/onboard/references/workflow.md',
    '.agents/skills/research/references/workflow.md',
    '.agents/skills/retro/references/workflow.md',
    '.agents/skills/review-changelog/references/workflow.md',
    '.agents/skills/review-check-readiness/references/workflow.md',
    '.agents/skills/review-check-sync/references/workflow.md',
    '.agents/skills/review-check-templates/references/workflow.md',
    '.agents/skills/review-code-review/references/workflow.md',
    '.agents/skills/review-optimize-agents/references/workflow.md',
    '.agents/skills/review-optimize-backlog/references/workflow.md',
    '.agents/skills/review-personalize/references/workflow.md',
    '.agents/skills/review-qa/references/workflow.md',
    '.agents/skills/review-security/references/workflow.md',
    '.agents/skills/review-update-docs/references/workflow.md',
    '.agents/skills/run-tests/references/workflow.md',
    '.agents/skills/todo/references/workflow.md',
    ];
    const live = fs.readdirSync(path.join(ROOT, '.agents/skills')).map(name => `.agents/skills/${name}/references/workflow.md`).filter(rel => fs.existsSync(path.join(ROOT, rel))).sort();
    const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const routed = live.filter(rel => read(rel).includes('```workflow-routes'));
    const dispatching = live.filter(rel => read(rel).includes('subagent_type'));
    expect(routed).toEqual([SOURCE]);
    expect(dispatching.filter(rel => !routed.includes(rel))).toEqual(PENDING);
    for (const rel of routed) expect(() => routes().checkWorkflowRoutes(read(rel)), rel).not.toThrow();
  });
});
