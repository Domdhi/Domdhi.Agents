import { describe, it, expect } from 'vitest';
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

// ── SF-1.1: `verify:` bindings on criterion objects ─────────────────
//
// Pinned contract: an AC checkbox bullet may carry `verify: <command> [=> exit N]`. The parsed
// binding is `criterion.verify = { command, expectedExit }` (expectedExit defaults to 0). A
// bullet without a binding has NO `verify` key, so the existing criterion shape is unchanged.
// A malformed binding yields an error `{ code: 'BAD_VERIFY', storyId, line, message }`, which makes
// the result not ok (CLI exit 1). The bullet's `text` stays the full bullet content, binding included.

const story = (...bullets) => `## Story NI-1 [x]\n**AC:**\n${bullets.map(b => `- [x] ${b}`).join('\n')}\n`;

describe('verify binding parse (SF-1.1)', () => {
  it.each([
    ['plain command, default exit', 'Given X, then Y. verify: node check.js', { command: 'node check.js', expectedExit: 0 }],
    ['explicit exit 0', 'Then Y. verify: node check.js => exit 0', { command: 'node check.js', expectedExit: 0 }],
    ['explicit non-zero exit', 'Then Y. verify: node check.js => exit 3', { command: 'node check.js', expectedExit: 3 }],
    ['upper boundary exit 255', 'Then Y. verify: node check.js => exit 255', { command: 'node check.js', expectedExit: 255 }],
    ['arguments and quotes are kept verbatim', 'Then Y. verify: node check.js "two words" --flag=1 => exit 1', { command: 'node check.js "two words" --flag=1', expectedExit: 1 }],
    ['extra whitespace is trimmed', 'Then Y. verify:   node check.js   =>   exit   2  ', { command: 'node check.js', expectedExit: 2 }],
    ['binding with no prose before it', 'verify: git status => exit 0', { command: 'git status', expectedExit: 0 }],
  ])('%s', (_label, bullet, expected) => {
    const result = verify(story(bullet));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.stories[0].criteria[0].verify).toEqual(expected);
  });

  it('keeps the bullet text unchanged (binding included) and the criterion keys exactly as before', () => {
    const bullet = 'Then Y. verify: node check.js => exit 0';
    const criterion = verify(story(bullet)).stories[0].criteria[0];
    expect(criterion.text).toBe(bullet);
    expect(Object.keys(criterion).sort()).toEqual(['checked', 'disposition', 'line', 'text', 'verify']);
  });

  it('a bullet with no binding has no verify key, so the existing criterion shape is unchanged', () => {
    const criterion = verify(story('Plain criterion with no command')).stories[0].criteria[0];
    expect(Object.keys(criterion).sort()).toEqual(['checked', 'disposition', 'line', 'text']);
    expect(criterion.verify).toBeUndefined();
  });

  it('the result envelope keeps its exact keys and unchecked entries keep their exact shape', () => {
    const result = verify('## Story NI-1 [x]\n- [ ] Open work verify: node check.js => exit 0\n');
    expect(Object.keys(result).sort()).toEqual(['errors', 'ok', 'stories', 'unchecked']);
    expect(result.unchecked).toEqual([{ storyId: 'NI-1', line: 2, text: 'Open work verify: node check.js => exit 0' }]);
    expect(result.errors.some(error => error.code === 'UNCHECKED_CRITERION')).toBe(true);
  });

  it('only the bullets that carry a binding get a verify field, in a mixed story', () => {
    const result = verify(story('First verify: node a.js', 'Second is manual', 'Third verify: node c.js => exit 4'));
    expect(result.stories[0].criteria.map(c => c.verify)).toEqual([
      { command: 'node a.js', expectedExit: 0 },
      undefined,
      { command: 'node c.js', expectedExit: 4 },
    ]);
  });

  it('a binding does not change the completion verdict of the story', () => {
    expect(verify(story('Done verify: node check.js')).ok).toBe(true);
    expect(verify('## Story NI-1 [ ]\n- [x] Done verify: node check.js\n').errors.map(e => e.code)).toEqual(['STORY_NOT_COMPLETE']);
  });

  it('a word that merely ends in verify: is not a binding', () => {
    const result = verify(story('We reverify: node check.js after release'));
    expect(result.errors).toEqual([]);
    expect(result.stories[0].criteria[0].verify).toBeUndefined();
  });

  it('a non-checkbox Verify line inside the story is not a binding and not an error', () => {
    const result = verify('* **Story NI-1 (S): First** [x]\n  * **AC:**\n    * [x] Done\n  * **Verify:** after render: node tools/run.cjs focused a.test.js\n');
    expect(result.ok).toBe(true);
    expect(result.stories[0].criteria).toHaveLength(1);
    expect(result.stories[0].criteria[0].verify).toBeUndefined();
  });

  it('nested and numbered checkbox bullets carry bindings too', () => {
    const result = verify('## Story NI-1 [x]\n- [x] Parent\n  * [x] Nested verify: node n.js => exit 2\n1. [x] Numbered verify: node m.js\n');
    expect(result.stories[0].criteria.map(c => c.verify)).toEqual([undefined, { command: 'node n.js', expectedExit: 2 }, { command: 'node m.js', expectedExit: 0 }]);
  });

  it.each([
    ['missing exit code', 'Then Y. verify: node check.js => exit'],
    ['non-numeric exit code', 'Then Y. verify: node check.js => exit abc'],
    ['negative exit code', 'Then Y. verify: node check.js => exit -1'],
    ['exit code above 255', 'Then Y. verify: node check.js => exit 256'],
    ['fractional exit code', 'Then Y. verify: node check.js => exit 1.5'],
    ['empty command before the arrow', 'Then Y. verify: => exit 0'],
    ['empty command, no arrow', 'Then Y. verify:'],
    ['two arrows', 'Then Y. verify: node check.js => exit 1 => exit 2'],
    ['trailing text after the exit code', 'Then Y. verify: node check.js => exit 1 and more'],
  ])('malformed binding (%s) yields BAD_VERIFY with the bullet line', (_label, bullet) => {
    const result = verify(story('Fine verify: node ok.js', bullet));
    expect(result.ok).toBe(false);
    const bad = result.errors.filter(error => error.code === 'BAD_VERIFY');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ code: 'BAD_VERIFY', storyId: 'NI-1', line: 4 });
    expect(typeof bad[0].message).toBe('string');
    expect(bad[0].message.length).toBeGreaterThan(0);
    expect(result.errors.map(error => error.code)).toEqual(['BAD_VERIFY']);
    expect(result.stories[0].criteria[1].verify).toBeUndefined();
    expect(result.stories[0].criteria[0].verify).toEqual({ command: 'node ok.js', expectedExit: 0 });
  });

  it('each malformed bullet is its own BAD_VERIFY error', () => {
    const result = verify(story('A verify: node a.js => exit x', 'B verify: node b.js => exit y'));
    expect(result.errors.map(error => [error.code, error.line])).toEqual([['BAD_VERIFY', 3], ['BAD_VERIFY', 4]]);
  });

  it('BAD_VERIFY on an unselected story does not fail the selected story', () => {
    const text = '## Story NI-1 [x]\n- [x] Fine verify: node ok.js\n## Story NI-2 [x]\n- [x] Broken verify: node b.js => exit nope\n';
    expect(verify(text).ok).toBe(true);
  });

  it('CLI exits non-zero and reports BAD_VERIFY for a malformed binding even in a finished story', () => {
    const tmp = createTmpDir();
    try {
      const file = tmp.write('todo.md', '## Story NI-1 [x]\n- [x] Done verify: node check.js => exit abc\n');
      const result = spawnSync(process.execPath, [script, file, '--stories', 'NI-1'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).errors.map(error => error.code)).toEqual(['BAD_VERIFY']);
    } finally { tmp.cleanup(); }
  });

  it('CLI prints the parsed binding on the criterion and exits 0 for a well-formed one', () => {
    const tmp = createTmpDir();
    try {
      const file = tmp.write('todo.md', '## Story NI-1 [x]\n- [x] Done verify: node check.js => exit 2\n');
      const result = spawnSync(process.execPath, [script, file, '--stories', 'NI-1'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).stories[0].criteria[0].verify).toEqual({ command: 'node check.js', expectedExit: 2 });
    } finally { tmp.cleanup(); }
  });
});

// ── Review fixes (wave 1): verify parsing hardening ─────────────────

describe('review fix m6: a binding written in a variant form is BAD_VERIFY, not a silent manual criterion', () => {
  it.each([
    ['a capital Verify:', 'Then Y. Verify: node check.js'],
    ['an all-caps VERIFY:', 'Then Y. VERIFY: node check.js'],
    ['a space before the colon', 'Then Y. verify : node check.js'],
    ['a full-width colon', 'Then Y. verify： node check.js'],
    ['a backtick-wrapped binding', 'Then Y. `verify: node check.js`'],
    ['a double-backtick-wrapped binding', 'Then Y. ``verify: node check.js``'],
    ['a bold-labelled binding followed by a command', 'Then Y. **verify:** node check.js'],
    ['an italic-labelled binding followed by a command', 'Then Y. *verify:* npm test'],
    ['a capital Verify inside backticks', 'Then Y. `Verify: git status`'],
  ])('%s yields BAD_VERIFY with the bullet line and no verify field', (_label, bullet) => {
    const result = verify(story('Fine verify: node ok.js', bullet));

    expect(result.ok).toBe(false);
    expect(result.errors.map(error => [error.code, error.storyId, error.line])).toEqual([['BAD_VERIFY', 'NI-1', 4]]);
    expect(result.errors[0].message).toMatch(/variant form/);
    expect(result.stories[0].criteria[1].verify).toBeUndefined();
  });

  it.each(['node', 'npx', 'npm', 'git', 'pytest', 'dotnet', 'cargo', 'go'])('every allowed command head (%s) is recognised after a variant label', (head) => {
    expect(verify(story(`Then Y. Verify: ${head} something`)).errors.map(error => error.code)).toEqual(['BAD_VERIFY']);
  });

  it.each([
    ['a code-span mention of the label with a placeholder', 'Given `verify: <command> => exit N`, then it runs'],
    ['a code-span mention of the label alone', 'A criterion with no `verify:` is manual'],
    ['a code-span mention followed by prose', 'The `verify:` line is parsed by the helper'],
    ['a capital Verify followed by prose', 'Verify the output looks right'],
    ['a Verify label followed by prose that is not a command', 'Verify: the page renders'],
    ['a bold prose label', '**E2E verify:** seed a store, run it, then read the log'],
    ['a bold prose label that mentions an arrow', '**E2E verify:** seed a store => exit 0'],
    ['a bold label ahead of a real binding', '**Check** verify: node real.js'],
  ])('leaves %s alone', (_label, bullet) => {
    const result = verify(story(bullet));

    expect(result.errors).toEqual([]);
    if (bullet.startsWith('**Check**')) expect(result.stories[0].criteria[0].verify).toEqual({ command: 'node real.js', expectedExit: 0 });
    else expect(result.stories[0].criteria[0].verify).toBeUndefined();
  });

  it('a real binding next to a defanged mention is still the binding', () => {
    const result = verify(story('Given `Verify: node old.js` is gone. verify: node new.js => exit 1'));

    expect(result.errors).toEqual([]);
    expect(result.stories[0].criteria[0].verify).toEqual({ command: 'node new.js', expectedExit: 1 });
  });

  it('the toolkit TODOs that mention the label in prose still parse (no false BAD_VERIFY)', () => {
    const text = '## Story NI-1 [x]\n- [x] Given an AC bullet carrying `verify: <command> => exit N`, when it runs, then it records\n- [x] An edit to a `verify:` line is detected\n';
    expect(verify(text).errors).toEqual([]);
  });
});

describe('review fix F8: a bold label is not a binding, and a checkbox marker is rejected', () => {
  it('"**E2E verify:** text" is a manual criterion with no verify field and no error', () => {
    const result = verify(story('**E2E verify:** seed a tmp store + an injection event'));

    expect(result.ok).toBe(true);
    expect(result.stories[0].criteria[0].verify).toBeUndefined();
  });

  it('"**verify:**" and "verify:**" labels are not bindings either', () => {
    expect(verify(story('**verify:** seed a store')).stories[0].criteria[0].verify).toBeUndefined();
    expect(verify(story('Run it. verify:** seed a store')).stories[0].criteria[0].verify).toBeUndefined();
  });

  it.each(['[ ]', '[x]', '[X]', '[>]', '[!]', '[~]', '[*]', '[B]', '[C]'])('a %s marker inside the command is BAD_VERIFY', (marker) => {
    const result = verify(story(`Then Y. verify: node check.js ${marker} => exit 0`));

    expect(result.errors.map(error => [error.code, error.line])).toEqual([['BAD_VERIFY', 3]]);
    expect(result.errors[0].message).toMatch(/checkbox marker/);
    expect(result.stories[0].criteria[0].verify).toBeUndefined();
  });

  it('a marker in the prose before the binding does not matter, and brackets that are not markers are fine', () => {
    const result = verify(story('Then [see note] Y. verify: node check.js "a[0]" => exit 2'));

    expect(result.errors).toEqual([]);
    expect(result.stories[0].criteria[0].verify).toEqual({ command: 'node check.js "a[0]"', expectedExit: 2 });
  });
});

describe('review fix n7: story ids that would collide as record file names', () => {
  const ids = (list) => subject().verifyTodoCompletion('## Story NI-1 [x]\n- [x] Done\n', { storyIds: list });

  it.each(['CON', 'con', 'PRN', 'AUX', 'NUL', 'Nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'NUL.1', 'con.x-1'])('refuses the Windows device name %s', (id) => {
    expect(ids([id]).errors.map(error => error.code)).toEqual(['INVALID_STORY_IDS']);
  });

  it.each(['CON-1', 'NULL', 'COM10', 'LPT', 'CONSOLE', 'X.CON', 'SF-1.1'])('still accepts %s', (id) => {
    expect(ids([id]).errors.map(error => error.code)).not.toContain('INVALID_STORY_IDS');
  });

  it('refuses two ids that differ only by case', () => {
    expect(ids(['SF-1.1', 'sf-1.1']).errors.map(error => error.code)).toEqual(['INVALID_STORY_IDS']);
    expect(ids(['A', 'b', 'B']).errors.map(error => error.code)).toEqual(['INVALID_STORY_IDS']);
  });

  it('still accepts distinct ids', () => {
    expect(ids(['SF-1.1', 'SF-1.2']).errors.map(error => error.code)).not.toContain('INVALID_STORY_IDS');
  });
});
