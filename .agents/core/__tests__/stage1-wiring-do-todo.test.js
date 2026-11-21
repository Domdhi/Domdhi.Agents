// SF-1.7 — /do, /todo, /create-project-epics-todo, verification-before-completion and startup-reference
// wiring for the stage-1 walls: the `verify:` binding in the authoring template, recorded red and freeze in
// /do Step 5, ac-verify run and the seal in /do Step 8, the same-signature retry with one deep-tier attempt,
// the ship-checked task commit, and the real gate-config path in the reference.
// Pins the workflow strings the helpers depend on so a later edit cannot silently drop a wall.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const DO = '.agents/skills/do/references/workflow.md';
const TODO = '.agents/skills/todo/references/workflow.md';
const EPICS = '.agents/skills/create-project-epics-todo/references/workflow.md';
const VBC = '.agents/skills/verification-before-completion/SKILL.md';
const REF = '.agents/startup-reference.md';

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The text from `start` up to (not including) the first `end` after it; the end of file when `end` is omitted. */
function slice(rel, start, end) {
  const t = read(rel);
  const from = t.indexOf(start);
  expect(from, `${rel}: marker ${JSON.stringify(start)}`).toBeGreaterThanOrEqual(0);
  if (end === undefined) return t.slice(from);
  const to = t.indexOf(end, from + start.length);
  expect(to, `${rel}: end marker ${JSON.stringify(end)}`).toBeGreaterThan(from);
  return t.slice(from, to);
}

const lineWith = (text, needle) => text.split('\n').find(l => l.includes(needle)) ?? '';

describe('/todo AC template, Template Rules and Phase 3b state the verify binding (AC1)', () => {
  it('the AC template bullet shows an inline verify: command with the default => exit', () => {
    const bullet = lineWith(read(TODO), '{Specific, testable acceptance criterion}');
    expect(bullet).toContain('* [ ] ');
    expect(bullet).toContain('verify:');
    expect(bullet).toMatch(/=> exit \d|=> exit N/);
  });

  it('Template Rules state inline-on-the-bullet, one command, default => exit 0 and no checkbox marker', () => {
    const rules = slice(TODO, '### Template Rules', '### Complexity Score');
    expect(rules).toContain('`verify:`');
    expect(rules).toMatch(/inline/i);
    expect(rules).toMatch(/one command/i);
    expect(rules).toContain('=> exit 0');
    expect(rules).toMatch(/checkbox marker/i);
  });

  it('Template Rules point a non-testable criterion at the [manual] and [CI-pending] tags', () => {
    const rules = slice(TODO, '### Template Rules', '### Complexity Score');
    expect(rules).toContain('[manual]');
    expect(rules).toContain('[CI-pending]');
  });

  it('the Phase 3b mechanical checks list has a bullet that every testable AC has a verify: or a [manual]/[CI-pending] tag', () => {
    const mech = slice(TODO, '**Mechanical plan checks', "These checks prove the plan's structure only");
    const bullet = mech.split('\n').find(l => l.startsWith('- [ ]') && l.includes('verify:')) ?? '';
    expect(bullet, 'a mechanical-check bullet naming verify:').not.toBe('');
    expect(bullet).toMatch(/every testable AC/i);
    expect(bullet).toContain('[manual]');
    expect(bullet).toContain('[CI-pending]');
  });

  it('the Phase 3b automatic-failure list refuses a verify: line that contains a checkbox marker', () => {
    const phase = slice(TODO, '## Phase 3b', '## Phase 4');
    expect(phase).toMatch(/verify:[^\n]*checkbox marker|checkbox marker[^\n]*verify:/i);
  });

  it('keeps the release-slice --strict text unchanged', () => {
    const line = '- [ ] Release slices — `node .claude/core/release-slice.js "{TODO_PATH}" --strict` exits 0: every Story Index row has a `core`/`later` Release and a `deep`/`standard` Tier, a core slice exists, no core story depends on a later story, and no later wave starts before the last core wave';
    expect(read(TODO)).toContain(line);
  });
});

describe('/create-project-epics-todo keeps verify: out of backlog.md (AC2)', () => {
  it('states that verify: is added when /todo materializes a story, not in backlog.md', () => {
    const line = read(EPICS).split('\n').find(l => l.includes('verify:') && /materializ/i.test(l) && l.includes('backlog.md')) ?? '';
    expect(line, 'a line naming verify:, materialize and backlog.md').not.toBe('');
    expect(line).toContain('/todo');
    expect(line).toMatch(/not in `?backlog\.md`?|never in `?backlog\.md`?/i);
  });
});

describe('/do Step 5 recorded red and freeze (AC3)', () => {
  it('runs ac-verify red before the implementation, with --todo and --stories', () => {
    const body = slice(DO, '## Step 5: Write Tests from AC', '## Step 6: Implement');
    expect(body).toMatch(/node \.claude\/core\/ac-verify\.js red --todo [^\n]*--stories /);
  });

  it('freezes after the red, in the same step', () => {
    const body = slice(DO, '## Step 5: Write Tests from AC', '## Step 6: Implement');
    const red = body.indexOf('ac-verify.js red');
    const freeze = body.indexOf('node .claude/core/ac-verify.js freeze --todo');
    expect(red).toBeGreaterThanOrEqual(0);
    expect(freeze).toBeGreaterThan(red);
    expect(body).toMatch(/node \.claude\/core\/ac-verify\.js freeze --todo [^\n]*--stories /);
  });
});

describe('/do Step 7 same-signature retry (AC3)', () => {
  const body = () => slice(DO, '## Step 7: Build + Test Gate', '## Step 8: Verify Acceptance Criteria');

  it('records a failing gate run in the failure ledger with its output file', () => {
    expect(body()).toContain('node .claude/core/_lib/failure-ledger.js record --leg test --exit');
    expect(body()).toContain('--output-file');
  });

  it('a second identical-signature failure gives one deep-tier subagent attempt written with the deep model token', () => {
    expect(body()).toMatch(/same-signature|same signature/i);
    expect(body()).toContain('{{model-arg:deep}}');
    expect(body()).toMatch(/both signatures/i);
    expect(body()).toContain('node .claude/core/_lib/failure-ledger.js last --format prompt');
  });

  it('keeps the stop-and-ask line for repeated failures', () => {
    expect(body()).toMatch(/stop[^\n]*ask the user/i);
  });
});

describe('/do B1a names the one deep-tier exception (AC3)', () => {
  const body = () => slice(DO, '##### B1a.', '#### B2. Assemble implementation prompt');

  it('carries the same-signature rule with the deep model token', () => {
    expect(body()).toMatch(/same-signature|same signature/i);
    expect(body()).toContain('{{model-arg:deep}}');
  });

  it('calls it the one or single exception to the standard-tier subagent rule', () => {
    expect(body()).toMatch(/one exception|single exception|the one exception/i);
  });

  it('no longer forbids the deep model token to a subagent without qualification', () => {
    expect(body()).not.toMatch(/Do not pass `\{\{model-arg:deep\}\}` to a subagent[;.]/);
  });
});

describe('/do Step 8 runs the bindings and seals after the last edit (AC3)', () => {
  const step8 = () => slice(DO, '## Step 8: Verify Acceptance Criteria', '## Step 9: Document + Commit');

  it('runs ac-verify run with --todo and --stories', () => {
    expect(step8()).toMatch(/node \.claude\/core\/ac-verify\.js run --todo [^\n]*--stories /);
  });

  it('seals the evidence with ship-check.js seal, after ac-verify run and after the 8d review', () => {
    const body = step8();
    const run = body.indexOf('node .claude/core/ac-verify.js run --todo');
    const seal = body.indexOf('node .claude/core/ship-check.js seal');
    expect(run).toBeGreaterThanOrEqual(0);
    expect(seal).toBeGreaterThan(run);
    expect(seal).toBeGreaterThan(body.indexOf('### 8d. Review once, at the end'));
  });

  it('introduces the seal as taken after the last review fix', () => {
    const body = step8();
    const seal = body.indexOf('node .claude/core/ship-check.js seal');
    expect(body.slice(Math.max(0, seal - 800), seal)).toMatch(/review fix/i);
  });

  it('a review fix re-runs Step 7 and ac-verify run, then re-seals', () => {
    const body = step8();
    // Reworded by the wave 4 review (m2): a review fix needs a new gate receipt, so the pin now names it.
    expect(body).toMatch(/re-?runs? Step 7 \(including a new `gate\.js test` receipt[^)]*\) and `ac-verify\.js run`/);
    expect(body).toMatch(/re-?seal/i);
  });
});

describe('/do 8c and 9e pass the ship-check options (AC3)', () => {
  it('8c names the ship-checked task commit as the thing the token precondition protects', () => {
    const body = slice(DO, '### 8c. Ship-token precondition', '## Step 9: Document + Commit');
    expect(body).toContain('--ship-check --sc-kind task');
    expect(body).toContain('ship-check.js');
  });

  it('9e commits through commit.js --ship-check --sc-kind task with --sc-todo when a TODO exists', () => {
    const body = slice(DO, '### 9e. Commit', '### 9f. Verify commit');
    expect(body).toMatch(/node \.claude\/core\/commit\.js --ship-check --sc-kind task/);
    expect(body).toContain('--sc-todo');
  });

  it('9e: an ad-hoc /do (no TODO) commits ship-checked under the no-todo rule', () => {
    const body = slice(DO, '### 9e. Commit', '### 9f. Verify commit');
    expect(body).toContain('no-todo');
    expect(body).toMatch(/ad-hoc/i);
  });

  it('the Ad-Hoc Mode section states the no-todo rule', () => {
    expect(slice(DO, '## Ad-Hoc Mode', '## Rules')).toContain('no-todo');
  });
});

describe('/do Step 9 completion check (AC3)', () => {
  it('runs todo-completion.js for the story when a TODO exists, before the commit', () => {
    const body = slice(DO, '## Step 9: Document + Commit', '## Step 10');
    const completion = body.search(/node \.claude\/core\/todo-completion\.js "\{[A-Z_]*TODO[A-Z_]*\}" --stories /);
    expect(completion, 'a todo-completion.js call with --stories').toBeGreaterThanOrEqual(0);
    expect(completion).toBeLessThan(body.indexOf('commit.js --ship-check'));
    expect(body).toMatch(/when a TODO exists|if the task is in a TODO/i);
  });
});

describe('verification-before-completion consumer list (AC4)', () => {
  const consumers = () => slice(VBC, '**Consumers.**', '\n## Critic vs Judge');

  it('names ship-check.js as the enforcement behind both ship literals, on one line', () => {
    const line = lineWith(consumers(), 'ship-check.js');
    expect(line, 'a line naming ship-check.js').not.toBe('');
    expect(line).toContain('SHIP_CHECK_OK');
    expect(line).toContain('SHIP_CHECK_SKIP');
    expect(line).toMatch(/enforc/i);
  });

  it('still lists /do and /run-todo as the gating commands', () => {
    expect(consumers()).toContain('`/do`');
    expect(consumers()).toContain('`/run-todo`');
  });
});

describe('startup-reference.md (AC4)', () => {
  it('Hard Gates cites ship-check.js as the tool enforcement behind the ship token', () => {
    const gates = slice(REF, '## Hard Gates', '\n## TODO Hierarchy');
    const line = gates.split('\n').find(l => l.includes('ship-check.js')) ?? '';
    expect(line, 'a Hard Gates line naming ship-check.js').not.toBe('');
    expect(line).toContain('SHIP_CHECK_OK');
    expect(line).toMatch(/enforc/i);
  });

  it('the model policy names the one deep-tier retry exception', () => {
    const policy = slice(REF, '**Model hierarchy:**', '\n## Commands');
    expect(policy).toMatch(/same-signature|same signature/i);
    expect(policy).toMatch(/retry/i);
    expect(policy).toMatch(/one exception|single exception/i);
  });

  it('the Build & Test Gate section names .claude/gate.config.json as the gate config path', () => {
    const gate = slice(REF, '## Build & Test Gate', '\n## Publishing');
    expect(gate).toContain('.claude/gate.config.json');
  });

  // Orchestrator correction: `.agents/gate.config.json` is the authored, project-owned source that the renderer writes
  // to `.claude/gate.config.json`; gate.js and ship-check read only the rendered file. The doc must say both.
  it('names .claude/gate.config.json as the file the gate reads, rendered from the authored .agents/gate.config.json', () => {
    const gate = slice(REF, '## Build & Test Gate', '\n## Publishing');
    expect(gate).toMatch(/\.agents\/gate\.config\.json[^\n]*\.claude\/gate\.config\.json|\.claude\/gate\.config\.json[^\n]*\.agents\/gate\.config\.json/);
    expect(gate).toMatch(/render/i);
  });

  it('documents shipCheck.enabled in the Build & Test Gate section', () => {
    const gate = slice(REF, '## Build & Test Gate', '\n## Publishing');
    expect(gate).toContain('shipCheck.enabled');
  });
});

describe('guard-test hygiene across the SF-1.7 files (AC5)', () => {
  const phrase = ['every', 'commit', 'path'].join(' ');
  const files = [DO, TODO, EPICS, VBC, REF];

  it.each(files)('%s does not contain the phrase the git-hooks review guard forbids', rel => {
    expect(read(rel).toLowerCase()).not.toContain(phrase);
  });

  it.each([DO, TODO, VBC])('%s has no model-name literal (tokens only)', rel => {
    expect(read(rel)).not.toMatch(/\b(sonnet|opus|haiku)\b/i);
  });

  // EPICS and REF carried model names before SF-1.7, so a whole-file count is brittle (an unrelated edit that removes one
  // literal would let a new one in). Assert only the text the SF-1.7 work and its review fixes added.
  it('the sentence added to the epics workflow has no model-name literal', () => {
    expect(slice(EPICS, '**Next step**', '\n').toLowerCase()).not.toMatch(/\b(sonnet|opus|haiku)\b/);
  });

  it.each([
    ['Hard Gates', '## Hard Gates', '\n## TODO Hierarchy'],
    ['Build & Test Gate (incl. Ship check)', '## Build & Test Gate', '\n### Gate receipts, reuse'],
  ])('the startup-reference %s text added by SF-1.7 has no model-name literal', (_name, start, end) => {
    expect(slice(REF, start, end)).not.toMatch(/\b(sonnet|opus|haiku)\b/i);
  });
});

// ---------------------------------------------------------------------------------------------
// Wave 4 review fixes (docs/.output/findings/reviews/261118-1228-software-factory-wave4a-review.md)
// ---------------------------------------------------------------------------------------------

const FREEZE_CMD = 'node .claude/core/ac-verify.js freeze --todo';
const UNFREEZE_CMD = 'node .claude/core/ac-verify.js unfreeze --todo';
const CHECK_CMD = 'node .claude/core/ac-verify.js check --todo';
const step5 = () => slice(DO, '## Step 5: Write Tests from AC', '## Step 6: Implement');
const step7 = () => slice(DO, '## Step 7: Build + Test Gate', '## Step 8: Verify Acceptance Criteria');
const step8 = () => slice(DO, '## Step 8: Verify Acceptance Criteria', '## Step 9: Document + Commit');

describe('M1: /do freezes every TODO story, not only those with bindings or tests', () => {
  it('the freeze subsection is not headed or gated by "when a TODO exists ... whose AC carry verify: bindings"', () => {
    const body = step5();
    expect(body).toContain('### Record the red run, then freeze (TODO stories)');
    expect(body).not.toContain('### Record the red run, then freeze (when a TODO exists)');
    const freezeBlock = body.slice(body.indexOf('**Freeze every TODO story before implementing, always.**'));
    expect(freezeBlock.length).toBeGreaterThan(0);
    expect(freezeBlock).toMatch(/does not depend on the red run, on the tests above being written, or on the story having `verify:` bindings/);
    expect(freezeBlock).toContain('BASELINE_MISSING');
    expect(freezeBlock).toMatch(/no test files in the Files list/);
  });

  it('the freeze command sits after the red-run block and outside the bindings-gated paragraph', () => {
    const body = step5();
    const gated = body.indexOf('When the task is a TODO story whose AC carry `verify:` bindings');
    const always = body.indexOf('**Freeze every TODO story before implementing, always.**');
    expect(gated).toBeGreaterThanOrEqual(0);
    expect(always).toBeGreaterThan(gated);
    expect(body.indexOf(FREEZE_CMD)).toBeGreaterThan(always);
  });

  it('the skip conditions say skipping tests never skips the freeze', () => {
    expect(step5()).toContain('Skipping the tests never skips the freeze: for a TODO story the freeze below still runs.');
  });

  it('only an ad-hoc /do skips the freeze, because its seal takes no --todo', () => {
    expect(step5()).toMatch(/An ad-hoc `\/do` has no TODO, so no `verify:` bindings and no freeze: the seal takes no `--todo` there/);
  });

  it('Step 7 no longer says to skip the unfreeze "when Step 5 recorded no freeze"', () => {
    expect(read(DO)).not.toContain('skip it when Step 5 recorded no freeze');
  });
});

describe('M2: /do never leaks a freeze lock', () => {
  it('Step 7 checks, then unfreezes, before the gate runs, on every path', () => {
    const body = step7();
    const check = body.indexOf(CHECK_CMD);
    const unfreeze = body.indexOf(UNFREEZE_CMD);
    const gate = body.indexOf('node .claude/core/gate.js build');
    expect(check).toBeGreaterThanOrEqual(0);
    expect(unfreeze).toBeGreaterThan(check);
    expect(gate).toBeGreaterThan(unfreeze);
    expect(body).toMatch(/This runs on every path, direct or delegated/);
    expect(body).toMatch(/An ad-hoc `\/do` has no freeze and skips both commands/);
  });

  it('the legitimate re-baseline is check, unfreeze, edit, freeze --reason, then unfreeze again', () => {
    const body = step5();
    const seq = body.slice(body.indexOf('the legitimate edit is a sequence that ends unfrozen'));
    const order = ['`ac-verify.js check`', '`unfreeze`', 'edit the test', '`freeze ... --reason "{why}"`', 'then `unfreeze` again'];
    let at = 0;
    for (const needle of order) {
      const i = seq.indexOf(needle, at);
      expect(i, needle).toBeGreaterThanOrEqual(at);
      at = i;
    }
  });

  it('a re-dispatch re-freezes with a reason after a check and unfreezes when the subagent reports', () => {
    const body = step7();
    expect(body).toMatch(/Before any re-dispatch[^\n]*run `ac-verify\.js check`, then re-freeze with `node \.claude\/core\/ac-verify\.js freeze --todo "\{TODO_PATH\}" --stories "\{story ID\}" --reason/);
    expect(body).toMatch(/`unfreeze` when it reports/);
  });
});

describe('M3: /do wires the retry machine where the failure is observed', () => {
  it('says how to read the streak (failure-ledger streak, "seen N times in a row", the N-to-row mapping)', () => {
    const body = step7();
    expect(body).toContain('node .claude/core/_lib/failure-ledger.js streak');
    expect(body).toContain('seen N times in a row');
    expect(body).toMatch(/Take the table row by N/);
  });

  it('says how to keep both signatures: last returns only the newest, so each block is pasted into the plan', () => {
    const body = step7();
    expect(body).toMatch(/`last` returns only the newest failure and the ledger has no history option/);
    expect(body).toMatch(/paste each failure's `last --format prompt` block into the plan's Gate failures section/);
    expect(read(DO)).toContain('## Gate failures');
  });

  it('the implementation prompt has a PRIOR FAILURE block that is omitted unless re-dispatched', () => {
    const body = slice(DO, '#### B2. Assemble implementation prompt', '#### B2a.');
    expect(body).toContain('8b. PRIOR FAILURE (only when this is a re-dispatch after a failing gate; omit otherwise)');
    expect(body.indexOf('8b. PRIOR FAILURE')).toBeGreaterThan(body.indexOf('8. PRIOR LEARNINGS'));
    expect(body.indexOf('8b. PRIOR FAILURE')).toBeLessThan(body.indexOf('9. TEST SELF-VERIFY'));
  });

  it('a focused run saves its output to a file before it is recorded', () => {
    expect(step7()).toMatch(/redirect its output to a file when you run it/);
    expect(step7()).toMatch(/a failing `--exit` without `--output-file` exits 2/);
  });
});

describe('M4: /do seal --docs guidance', () => {
  it('names --docs "{TODO_PATH},{other doc}", docs/modules/**, code-drift and the documents-only limit, after the seal command', () => {
    const body = step8();
    const seal = body.indexOf('node .claude/core/ship-check.js seal --todo');
    const docs = body.indexOf('--docs "{TODO_PATH},{other doc}"');
    expect(seal).toBeGreaterThanOrEqual(0);
    expect(docs).toBeGreaterThan(seal);
    expect(body).toContain('docs/modules/**');
    expect(body).toContain('code-drift');
    expect(body).toMatch(/documents only \(no code file, no directory\)/);
    expect(body).toMatch(/must not change between the gate and the seal/);
  });

  it('the seal note says the story was frozen in Step 5', () => {
    expect(step8()).toMatch(/The story was frozen in Step 5 \(the seal refuses one with no freeze baseline\)/);
  });
});

describe('m1: --stories takes one ID or a comma-separated list, defined in Variables', () => {
  it('Variables says {story ID} is a single ID and several are comma-separated with no spaces', () => {
    const vars = slice(DO, '## Variables', '## Task Status Markers');
    expect(vars).toMatch(/`--stories` argument takes that one ID; several IDs, if ever passed, are comma-separated with no spaces/);
  });
});

describe('m2: a review fix needs a new gate receipt', () => {
  it('the 8d seal paragraph names the new gate.js test receipt', () => {
    expect(step8()).toMatch(/re-runs Step 7 \(including a new `gate\.js test` receipt: the seal refuses a receipt that does not match the code\)/);
  });
});

describe('m7: a docs-only or no-gate /do commits with the audited skip, since it cannot seal', () => {
  it('8d says not to seal and names docs-only change: no code to verify as the --sc-skip reason', () => {
    const body = step8();
    const note = body.slice(body.indexOf('**No code to verify.**'));
    expect(note).toContain('Do not seal');
    expect(note).toContain('--sc-skip "docs-only change: no code to verify"');
    expect(note).toContain('no gate configured');
    expect(note).toMatch(/completion check is still required/);
  });

  it('8c lists no gate configured and docs-only as SHIP_CHECK_SKIP cases', () => {
    const body = slice(DO, '### 8c. Ship-token precondition', '## Step 9: Document + Commit');
    expect(body).toMatch(/no gate configured, a docs-only change with no code to verify\) → emit `SHIP_CHECK_SKIP: <reason>`/);
  });

  it('9e shows the full skip commit, and the Ad-Hoc Mode section says such a task is not sealed', () => {
    const body = slice(DO, '### 9e. Commit', '### 9f. Verify commit');
    expect(body).toMatch(/commit\.js --ship-check --sc-kind task --sc-todo "\{TODO_PATH\}" --sc-stories "\{story ID\}" --sc-skip "docs-only change: no code to verify"/);
    expect(slice(DO, '## Ad-Hoc Mode', '## Rules')).toContain('commits with `--sc-skip`');
  });
});

describe('m6: the enforcement claim is as strong as the mechanism', () => {
  it('/do 8c says the check is enforced when the commit passes --ship-check, which a plain commit.js skips', () => {
    const body = slice(DO, '### 8c. Ship-token precondition', '## Step 9: Document + Commit');
    expect(body).toMatch(/enforced when the commit goes through `commit\.js --ship-check`/);
    expect(body).toMatch(/A plain `commit\.js` skips it/);
  });

  it('the verification-before-completion consumer line says the same, and the old unqualified line is gone', () => {
    const vbc = read(VBC);
    expect(vbc).toMatch(/enforced when the commit goes through `commit\.js --ship-check`/);
    expect(vbc).toMatch(/No hook forces the flag/);
    expect(vbc).not.toContain('is the tool enforcement behind `SHIP_CHECK_OK` and `SHIP_CHECK_SKIP`: both commands');
  });

  it('startup-reference Hard Gates calls the token tool-checked through --ship-check, not "tool-enforced"', () => {
    const gates = slice(REF, '## Hard Gates', '\n## TODO Hierarchy');
    expect(gates).toContain('tool-checked, unlike the template-stub gate above, when the commit goes through `commit.js --ship-check`');
    expect(gates).not.toContain('the commit-time ship token is tool-enforced');
    expect(gates).toMatch(/No hook forces the flag/);
  });

  it('the Ship check subsection names the audited bypasses in the same terms', () => {
    const ship = slice(REF, '### Ship check (`ship-check.js`)', '### Gate receipts, reuse');
    expect(ship).toContain('`--sc-skip "<reason>"` is the audited bypass');
    expect(ship).toContain('`shipCheck.enabled` — default `true`');
  });
});

describe('m6: the startup-reference Ship check subsection matches ship-check.js', () => {
  const gate = () => slice(REF, '## Build & Test Gate', '\n### Gate receipts, reuse');

  it('says the renderer writes .claude/gate.config.json only, and that Codex reads that same file', () => {
    expect(gate()).toContain('which the renderer writes to `.claude/gate.config.json` only (it writes no `.codex/gate.config.json`)');
    expect(gate()).toMatch(/the Codex wrappers run the same shared helpers, so Codex reads that same file/);
    expect(gate()).not.toContain('(`.codex/` for Codex)');
  });

  it('summary mode lists every condition: overall, a succeeded non-empty test leg, a succeeded build, full and unkilled, newer than the newest non-doc file', () => {
    const line = gate().split('\n').find(l => l.startsWith('- `shipCheck.requireReceipt`')) ?? '';
    expect(line).toContain('`overall: true`');
    expect(line).toContain('a succeeded, non-empty test leg and a succeeded build');
    expect(line).toContain('full (not change-scoped), unkilled run');
    expect(line).toContain('newer than the newest non-document file in the tree');
    expect(line).toContain('`no succeeded build`');
    expect(line).toContain('`not older than the gate summary`');
  });

  it('documents seal --docs and the code-hash exclusions', () => {
    const line = gate().split('\n').find(l => l.startsWith('- `seal --docs a,b`')) ?? '';
    expect(line).toContain('`docs/.output/`, `docs/work/` and a direct-child `docs/TODO_*.md`');
    expect(line).toContain('`docs/modules/**`');
    expect(line).toContain('`code-drift`');
  });
});

describe('m9: the epics workflow says its checklists carry no verify: bindings', () => {
  it('the Next step line points at /todo or hand-written verify: lines', () => {
    const next = slice(EPICS, '**Next step**', '\n');
    expect(next).toContain('seals every story as all-manual');
    expect(next).toContain('`/todo`');
    expect(next).toContain('`verify:`');
  });
});
