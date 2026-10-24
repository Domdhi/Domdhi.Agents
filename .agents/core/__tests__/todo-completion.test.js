import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const subject = () => require('../todo-completion');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { renderSharedAgents } = require('../_lib/shared-agents');
const script = path.resolve('.agents/core/todo-completion.js');
const verify = (text, storyIds = ['NI-1']) => subject().verifyTodoCompletion(text, { storyIds });
const index = (marker = '[x]', id = 'NI-1') => `\n## Story Index\n\n| Story | Title | Status |\n|---|---|---|\n| ${id} | First | ${marker} |\n`;

it.each(['##', '###'])('heading %s detects unfinished AC despite completed marker', heading => {
  const result = verify(`${heading} Story NI-1 (S): First [x]\n**AC:**\n- [ ] Required implementation\n`);
  expect(result.ok).toBe(false);
  expect(result.unchecked).toEqual([{ storyId: 'NI-1', line: 3, text: 'Required implementation' }]);
  expect(result.errors.some(error => error.code === 'UNCHECKED_CRITERION')).toBe(true);
});

it.each(['1.2', 'E11-S1', 'BO-B.2', 'NI-1'])('recognizes exact dotted/alphanumeric/hyphenated ID %s', id => {
  const result = verify(`### Story ${id} (S): First\n- [x] Done\n` + index('[x]', id), [id]);
  expect(result.ok).toBe(true);
  expect(result.stories.map(story => story.id)).toEqual([id]);
});

it.each(['* **Story NI-1 (S): First** [x]', '- **Story NI-1 (S): First [x]**', '* [x] **Story NI-1 (S): First**'])('recognizes authored bold-bullet story %s', header => {
  const result = verify(`${header}\n  **AC:**\n  * [x] Done\n`);
  expect(result.ok).toBe(true);
  expect(result.stories[0].criteria).toHaveLength(1);
});

it('authored todo template shape verifies nested AC with table completion', () => {
  const result = verify('* **Story NI-1 (S): First**\n  * **AC:**\n    * [x] Done\n  * **Files:**\n    * `app.js`\n\n---\n' + index());
  expect(result.ok).toBe(true);
  expect(result.stories[0].criteria).toHaveLength(1);
});

it('table status is authoritative over conflicting inline marker and title markers', () => {
  expect(verify('## Story NI-1 [ ]\n- [x] Done\n' + index()).ok).toBe(true);
  const text = '## Story NI-1 [x]\n- [x] Done\n' + index('[ ]');
  expect(verify(text).errors.some(error => error.code === 'STORY_NOT_COMPLETE')).toBe(true);
  expect(verify('## Story NI-1 [x]\n- [x] Done\n\n## Story Index\n| Story | Title | Status |\n|---|---|---|\n| NI-1 | Title [x] | [ ] |').ok).toBe(false);
});

it('recognizes existing Story Index and Wave Plan with combined story/title cell', () => {
  expect(verify('### Story NI-1 (S): First\n- [x] Done\n\n## Story Index and Wave Plan\n| Story | Size | Status |\n|---|---|---|\n| NI-1 First title | S | [x] |').ok).toBe(true);
});

it('ambiguous table columns and shifted title markers cannot authorize completion', () => {
  const story = '## Story NI-1 [x]\n- [x] Done\n## Story Index\n';
  expect(verify(story + '| Story | Status | Status |\n|---|---|---|\n| NI-1 | [x] | [ ] |').ok).toBe(false);
  const shifted = verify(story + '| Story | Title | Status |\n|---|---|---|\n| NI-1 | title \\| [x] | [ ] |');
  expect(shifted.ok).toBe(false);
  expect(shifted.errors.some(error => error.code === 'UNRECOGNIZED_INDEX_ROW')).toBe(true);
});

it.each(['', '[ ]', '[>]', '[!]', '[~]'])('missing or unfinished inline completion marker %s fails closed', marker => {
  expect(verify(`## Story NI-1 ${marker}\n- [x] Done`).errors.some(error => error.code === 'STORY_NOT_COMPLETE')).toBe(true);
});

it.each([
  ['missing selected story', '## Story NI-2 [x]\n- [x] Done', 'MISSING_STORY'],
  ['duplicate selected declaration', '## Story NI-1 [x]\n- [x] Done\n### Story NI-1 [x]\n- [x] Again', 'DUPLICATE_STORY'],
  ['unrecognized selected declaration', '## Story NI-1??? [x]\n- [x] Done', 'MISSING_STORY'],
  ['prefix ID does not match', '## Story NI-10 [x]\n- [x] Done', 'MISSING_STORY'],
  ['selected story absent from index', '## Story NI-1 [x]\n- [x] Done' + index('[x]', 'NI-2'), 'MISSING_INDEX_STORY'],
  ['duplicate selected index row', '## Story NI-1 [x]\n- [x] Done' + index() + '| NI-1 | Again | [x] |', 'DUPLICATE_INDEX_STORY'],
  ['missing index status column', '## Story NI-1 [x]\n- [x] Done\n## Story Index\n| Story | Title |\n|---|---|\n| NI-1 | First |', 'MISSING_INDEX_STORY'],
  ['no parsed criteria', '## Story NI-1 [x]\nordinary prose', 'NO_CRITERIA'],
])('%s fails with its own evidence', (_label, text, code) => {
  expect(verify(text).errors.some(error => error.code === code)).toBe(true);
});

it.each([undefined, [], ['NI-1', 'NI-1'], ['../NI-1'], ['NI-1', 7]].map(storyIds => ({ storyIds })))('invalid selection $storyIds cannot return success', ({ storyIds }) => {
  const result = subject().verifyTodoCompletion('## Story NI-1 [x]\n- [x] Done', { storyIds });
  expect(result.ok).toBe(false);
  expect(result.errors.some(error => error.code === 'INVALID_STORY_IDS')).toBe(true);
});

it.each(['cut', 'superseded', 'moved', 'not-applicable'])('explicit %s disposition remains visible without cosmetic ticking', type => {
  const text = `## Story NI-1 [x]\n- [ ] Criterion [${type}: explained by NI-9]\n`;
  const result = verify(text);
  expect(result.ok).toBe(true);
  expect(result.unchecked).toEqual([]);
  expect(result.stories[0].criteria[0]).toMatchObject({ checked: false, disposition: { type, reason: 'explained by NI-9' } });
  expect(text).toContain('- [ ]');
});

it.each(['cut from notes', '[cut: ]', '[superseded]', '[moved: ]', '[not-applicable:]', '`[cut: example]`', '``[cut: example with ` punctuation]``', '[cut: first] [moved: second]'])('incidental, ambiguous or empty disposition %s cannot waive a criterion', annotation => {
  expect(verify(`## Story NI-1 [x]\n- [ ] Criterion ${annotation}`).unchecked).toHaveLength(1);
});

it('fenced examples cannot create stories, index markers, or unchecked criteria', () => {
  const text = '## Story NI-1 [x]\n- [x] Done\n```markdown\n## Story NI-1 [ ]\n- [ ] Example\n## Story Index\n| Story | Status |\n|---|---|\n| NI-1 | [ ] |\n```\n~~~~md\n- [ ] Other example\n~~~\n~~~~\n';
  expect(verify(text).ok).toBe(true);
});

it('unclosed fence fails rather than concealing required criteria', () => {
  expect(verify('## Story NI-1 [x]\n- [x] Done\n```\n- [ ] Hidden criterion').errors.some(error => error.code === 'UNCLOSED_FENCE')).toBe(true);
});

it('nested fenced example cannot hide a real unfinished criterion after it', () => {
  const result = verify('## Story NI-1 [x]\n- [x] Done\n    ```md\n    - [ ] Example\n    ```\n  - [ ] Real work');
  expect(result.unchecked.map(item => item.text)).toEqual(['Real work']);
});

it('null options and oversized input refuse with structured evidence', () => {
  expect(subject().verifyTodoCompletion('', null).errors[0].code).toBe('INVALID_STORY_IDS');
  expect(verify('x'.repeat(2 * 1024 * 1024 + 1)).errors[0].code).toBe('INVALID_TODO');
});

it.each(['## Validation', '### Notes', '#### Validation', '**Notes:**'])('nonstory %s checkboxes are excluded', heading => {
  const result = verify(`## Story NI-1 [x]\n### Acceptance Criteria\n- [x] Done\n${heading}\n- [ ] Project-wide work`);
  expect(result.ok).toBe(true);
  expect(result.stories[0].criteria).toHaveLength(1);
});

it('nested subtasks are checked, unrelated stories remain untouched and unsupported states fail', () => {
  const text = '## Story NI-1 [x]\n- [x] Parent\n  * [ ] Nested work\n  + [>] Pending work\n## Story NI-2 [ ]\n- [ ] Another story\n';
  const result = verify(text);
  expect(result.unchecked.map(item => item.text)).toEqual(['Nested work', 'Pending work']);
  expect(result.stories).toHaveLength(1);
});

it.each(['- [S] Skipped work', '1. [ ] Numbered work', '2) [ ] Numbered work'])('unfinished alternate checklist form %s cannot disappear', task => {
  const result = verify('## Story NI-1 [x]\n- [x] Done\n' + task);
  expect(result.ok).toBe(false);
  expect(result.unchecked).toHaveLength(1);
});

it.each(['**AC:**', '**Tasks:**', '### Acceptance Criteria'])('explicit %s after story Notes resumes criterion verification', section => {
  const result = verify('## Story NI-1 [x]\n- [x] Done\n**Notes:**\n- [ ] Unrelated note\n'+section+'\n- [ ] Required criterion');
  expect(result.ok).toBe(false);
  expect(result.unchecked.map(item=>item.text)).toEqual(['Required criterion']);
});

it('CLI refuses malformed UTF-8 rather than decoding away an unchecked task', () => {
  const tmp = createTmpDir();
  try {
    const file = tmp.write('todo.md', '## Story NI-1 [x]\n- [x] Done\n');
    fs.appendFileSync(file, Buffer.from([45,32,91,255,93,32,82,101,113,117,105,114,101,100,10]));
    const result = spawnSync(process.execPath, [script,file,'--stories','NI-1'],{encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).errors[0].code).toBe('INVALID_TODO_FILE');
  } finally { tmp.cleanup(); }
});

it.each(['\ud800', '\udc00'])('exported verifier refuses lone surrogate input', invalid => {
  const result = verify('## Story NI-1 [x]\n- [x] Done\n- [x] Invalid Unicode '+invalid);
  expect(result.ok).toBe(false);
  expect(result.errors[0].code).toBe('INVALID_TODO');
  expect(verify('## Story NI-1 [x]\n- [x] Valid Unicode 🤖').ok).toBe(true);
});

it('bold story ownership resumes after Notes only for its explicit criterion section', () => {
  const result = verify('* **Story NI-1 (S): First** [x]\n  - [x] Done\n  **Notes:**\n  - [ ] Note\n  **AC:**\n  1. [ ] Required criterion\n');
  expect(result.ok).toBe(false);
  expect(result.unchecked.map(item=>item.text)).toEqual(['Required criterion']);
});

it.each(['*', 'B', 'C', '?'])('persistent or annotated task state [%s] requires explicit disposition', marker => {
  const result = verify(`## Story NI-1 [x]\n- [x] Done\n- [${marker}] Unresolved task`);
  expect(result.ok).toBe(false);
  expect(result.unchecked.map(item => item.text)).toEqual(['Unresolved task']);
});

it('bounded standalone self-test proves unfinished criteria are detected and checked control passes', () => {
  const output = execFileSync(process.execPath, [script, '--self-test'], { encoding: 'utf8' });
  expect(JSON.parse(output)).toMatchObject({ ok: true, positiveControl: 'unfinished criterion detected', checkedControl: 'passed' });
});

it('CLI returns structured failure, refuses malformed arguments and never writes the TODO', () => {
  const tmp = createTmpDir();
  try {
    const text = '## Story NI-1 [x]\n- [ ] Required implementation\n';
    const file = tmp.write('todo.md', text);
    const failed = spawnSync(process.execPath, [script, file, '--stories', 'NI-1'], { encoding: 'utf8' });
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout).unchecked[0]).toMatchObject({ storyId: 'NI-1', text: 'Required implementation' });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    for (const args of [[], [file], [file, '--stories', 'NI-1,NI-1'], [file, '--stories', 'NI-1', '--skip']]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
    }
    expect(spawnSync(process.execPath, [script, tmp.root, '--stories', 'NI-1'], { encoding: 'utf8' }).status).not.toBe(0);
  } finally { tmp.cleanup(); }
});

it.each(['claude', 'codex'])('%s rendered native helper verifies a real fixture TODO and positive control', runtime => {
  const tmp = createTmpDir();
  try {
    tmp.write('.agents/core/todo-completion.js', fs.readFileSync(script));
    const file = tmp.write('todo.md', '### Story NI-1 (S): First\n- [x] Complete\n' + index());
    expect(renderSharedAgents(tmp.root).conflicts).toEqual([]);
    const entry = path.join(tmp.root, `.${runtime}/core/todo-completion.js`);
    const result = JSON.parse(execFileSync(process.execPath, [entry, file, '--stories', 'NI-1'], { cwd: tmp.root, encoding: 'utf8' }));
    expect(result.ok).toBe(true);
    expect(result.stories[0].criteria).toHaveLength(1);
    expect(JSON.parse(execFileSync(process.execPath, [entry, '--self-test'], { encoding: 'utf8' })).ok).toBe(true);
  } finally { tmp.cleanup(); }
});

it('workflow blocks index cascade on selected-story verification after the TODO update', () => {
  const text = fs.readFileSync(path.resolve('.agents/skills/run-todo/references/workflow.md'), 'utf8');
  const start = text.indexOf('**8a. Update TODO');
  const end = text.indexOf('**8b. Cascade to master index**', start);
  const block = text.slice(start, end);
  expect(block).toContain('todo-completion.js --self-test');
  expect(block).toContain('todo-completion.js "{TODO_PATH}" --stories "{comma-separated wave story IDs}"');
  expect(block).toContain('never tick a box to tidy the table');
  expect(block).toContain('Do not proceed to 8b');
});
