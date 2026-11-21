// Final core review (M4 remedy text, m1 evolve apply wiring, m3 protected-path dispatch rule): the workflow prose that
// tells the Main Agent what to do must match what the helpers actually do. These pin the load-bearing wording.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (skill) => fs.readFileSync(path.resolve(`.agents/skills/${skill}/references/workflow.md`), 'utf8');
const RUN_TODO = read('run-todo');
const DO = read('do');
const TODO = read('todo');
const EVOLVE = read('review-evolve-skills');

describe('M4: the infra remedy of `ac-verify red` is accurate', () => {
  it.each([['run-todo', RUN_TODO], ['do', DO]])('%s says a created module is already a real red and needs no stub', (_name, text) => {
    expect(text).toContain('`expected module {path} | saw Cannot find module | {test file:line}`');
    expect(text).toContain('no stub file is needed');
  });

  it.each([['run-todo', RUN_TODO], ['do', DO]])('%s keeps a missing helper or an unlisted path as the infra case with the right remedy', (_name, text) => {
    expect(text).toContain('`Cannot find module` on a test helper or on a path the Files list does not mark created');
    expect(text).toContain('or add the missing created path to the story\'s Files list');
  });
});

describe('m1: the evolve apply step runs the protected-set diff check', () => {
  const step6 = EVOLVE.slice(EVOLVE.indexOf('### Step 6'));

  it('records the base and a baseline outside the repository before the edit, then checks, before rendering', () => {
    const snapshot = step6.indexOf('improvement-scope.js snapshot --base "$base" --out');
    const check = step6.indexOf('improvement-scope.js check --base "$base" --target <skill-name> --baseline');
    const render = step6.indexOf('render-shared-agents.js\n');
    expect(snapshot).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(snapshot);
    expect(render).toBeGreaterThan(check);
  });

  it('stops on any non-zero exit and names the real exit codes (1 refused, 2 could not run)', () => {
    expect(step6).toContain('Any non-zero exit stops here: exit 1 lists the refused paths');
    expect(step6).toContain('exit 2 means the check could not run');
    expect(step6).toContain('Never render, commit or claim the change applied past a non-zero check');
  });
});

describe('m3: a story on a protected path is never dispatched to an implementer subagent', () => {
  it('run-todo path selection names the tier and the two allowed routes', () => {
    const rule = RUN_TODO.slice(RUN_TODO.indexOf('**Protected paths override the table.**'));
    expect(rule.startsWith('**Protected paths override the table.**')).toBe(true);
    expect(rule).toContain('`guardrail:subagentReadOnlyPaths`');
    expect(rule).toContain('Path A (the Main Agent writes it directly)');
    expect(rule).toContain('returning a patch that the Main Agent applies');
  });

  it('the rule sits in Step 3 path selection, before the Path A section', () => {
    expect(RUN_TODO.indexOf('**Protected paths override the table.**')).toBeGreaterThan(RUN_TODO.indexOf('Size the wave to decide the implementation strategy'));
    expect(RUN_TODO.indexOf('**Protected paths override the table.**')).toBeLessThan(RUN_TODO.indexOf('### Path A: Main Agent Implements Directly'));
  });

  it('the /todo Ownership line carries the same rule', () => {
    const line = TODO.split('\n').find((l) => l.includes('**Ownership:** production {agent type}'));
    expect(line).toBeDefined();
    expect(line).toContain('`guardrail:subagentReadOnlyPaths`');
    expect(line).toContain('names the Main Agent as its production owner');
    expect(line).toContain('scratch-copy patch');
  });
});
