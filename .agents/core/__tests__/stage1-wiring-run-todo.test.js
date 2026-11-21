// SF-1.6 — /run-todo wiring for the stage-1 walls: budget, recorded red, freeze, the retry state
// machine, the seal after the Step 7 review fixes, and the ship-checked wave commit. The wave 4 review
// fixes (freeze for every story, no leaked locks, the retry machine at the failure point, --docs, the
// scaled budget) are pinned in the "wave 4 review fixes" blocks at the end.
// Pins the workflow strings the helpers depend on so a later edit cannot silently drop a wall.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../../..');
const SOURCE = '.agents/skills/run-todo/references/workflow.md';
const text = () => fs.readFileSync(path.join(ROOT, SOURCE), 'utf8');

/** The body of one `#### Step N...` section (up to the next `#### ` heading). */
function step(heading) {
  const t = text();
  const start = t.indexOf(heading);
  expect(start, `heading ${heading}`).toBeGreaterThanOrEqual(0);
  const next = t.indexOf('\n#### ', start + heading.length);
  return t.slice(start, next < 0 ? undefined : next);
}

describe('plan template (SF-1.6 AC1)', () => {
  it('carries the default Budget line in the budget-seam grammar, parseable by failure-ledger parseBudget', () => {
    const line = '**Budget:** attempts=3 gate-failures=6 dispatches=40 minutes=240';
    expect(text()).toContain(line);
    const { parseBudget } = require('../_lib/failure-ledger');
    const parsed = parseBudget(line);
    expect(parsed).toMatchObject({ attempts: 3, 'gate-failures': 6, dispatches: 40, minutes: 240 });
  });

  it('the wave-log field list has a Red line', () => {
    expect(text()).toMatch(/^- \*\*Red:\*\* /m);
  });
});

describe('Step 2b recorded red (AC2)', () => {
  it('runs ac-verify red and pastes the digest into the plan before dispatch, instead of "expect the tests to fail"', () => {
    const body = step('#### Step 2b');
    expect(body).toContain('node .claude/core/ac-verify.js red --todo');
    expect(body).toMatch(/digest/i);
    expect(body).not.toContain('Expect the tests to fail at this point');
  });

  it('keeps the existing skip conditions', () => {
    expect(step('#### Step 2b')).toContain('**Skip when:**');
  });
});

describe('freeze and unfreeze around dispatch (AC3)', () => {
  it('freezes after the tests are written and unfreezes after the agents finish', () => {
    const t = text();
    const freeze = t.indexOf('node .claude/core/ac-verify.js freeze --todo');
    const unfreeze = t.indexOf('node .claude/core/ac-verify.js unfreeze --todo');
    expect(freeze).toBeGreaterThan(t.indexOf('#### Step 2b'));
    expect(unfreeze).toBeGreaterThan(freeze);
  });

  it('a legitimate Main Agent test edit re-baselines with freeze --reason', () => {
    expect(text()).toMatch(/ac-verify\.js freeze --todo [^\n]*--reason/);
  });
});

describe('Step 5 gate and the failure ledger (AC4)', () => {
  it('runs gate.js test for the wave so a receipt exists', () => {
    expect(step('#### Step 5')).toContain('node .claude/core/gate.js test');
  });

  it('a failing focused run is recorded with failure-ledger record --output-file', () => {
    expect(step('#### Step 5')).toContain('node .claude/core/_lib/failure-ledger.js record --leg test --exit');
    expect(step('#### Step 5')).toContain('--output-file');
  });
});

describe('the retry state machine (AC5)', () => {
  it('is a table with the three failure rows', () => {
    const t = text();
    expect(t).toContain('| Gate failure | Same signature? | Action |');
    expect(t).toMatch(/^\| 1 \|/m);
    expect(t).toMatch(/^\| 2 \| yes, on a changed tree \|/m);
    expect(t).toMatch(/^\| 3 \|[^\n]*stop and ask/im);
  });

  it('failure 1 re-dispatches the owning story with a PRIOR FAILURE block from the ledger', () => {
    const t = text();
    expect(t).toContain('PRIOR FAILURE');
    expect(t).toContain('node .claude/core/_lib/failure-ledger.js last --format prompt');
    expect(t).toMatch(/File Ownership Matrix/);
  });

  it('failure 2 gives one deep-tier subagent attempt with both signatures, logged as a raised tier', () => {
    const t = text();
    expect(t).toContain('Tier: raised from standard: same-signature x2');
    expect(t).toMatch(/both signatures/i);
  });

  it('the model-selection paragraph names the single exception with the deep model token, never a model name', () => {
    const t = text();
    const para = t.slice(t.indexOf('**Model selection.**'), t.indexOf('**Echo the dispatch plan'));
    expect(para).toContain('{{model-arg:deep}}');
    expect(para).toMatch(/same-signature/);
    expect(para).toMatch(/one exception|single exception/i);
  });

  it('the budget is checked before each dispatch and exit 12 stops the run for the owner', () => {
    const t = text();
    expect(t).toContain('node .claude/core/_lib/failure-ledger.js budget --since');
    expect(t).toMatch(/exit(?:s)? 12/i);
  });
});

describe('Step 6 run, Step 7 seal, Step 8f ship-checked commit (AC6)', () => {
  it('Step 6 runs ac-verify run', () => {
    expect(step('#### Step 6')).toContain('node .claude/core/ac-verify.js run --todo');
  });

  it('the seal is created at the end of Step 7, after the last review fix, and a review fix re-runs Step 5 and ac-verify run first', () => {
    const body = step('#### Step 7');
    const seal = body.indexOf('node .claude/core/ship-check.js seal');
    expect(seal).toBeGreaterThan(0);
    expect(body.slice(seal - 600, seal)).toMatch(/review fix/i);
    // Reworded by the wave 4 review (m2): a review fix needs a new gate receipt, so the pin now names it.
    expect(body).toMatch(/re-?runs? Step 5 \(including item 5's `gate\.js test`[^)]*\) and `ac-verify\.js run`/);
    expect(step('#### Step 6')).not.toContain('ship-check.js seal');
  });

  it("Step 8f's commit call carries --ship-check with the --sc-* options", () => {
    const t = text();
    const s8f = t.slice(t.indexOf('**8f. Commit'), t.indexOf('**8g. Verify commit**'));
    expect(s8f).toMatch(/node \.claude\/core\/commit\.js --ship-check --sc-kind wave --sc-plan [^\n]+ --sc-wave [^\n]+ --sc-todo [^\n]+ --sc-stories /);
  });
});

describe('workflow routes (AC7)', () => {
  it('gains exactly the deep retry route', () => {
    const routes = require('../_lib/workflow-routes').parseWorkflowRoutes(text());
    const retry = routes.filter(r => r.step === 'wave-implementation-deep-retry');
    expect(retry).toEqual([{
      step: 'wave-implementation-deep-retry', role: 'general-purpose', tier: 'deep',
      condition: 'after two identical-signature failures of the same story',
      output: expect.any(String),
    }]);
  });

  it('the new text avoids the phrase the git-hooks review guard forbids', () => {
    expect(text().toLowerCase()).not.toContain(['every', 'commit', 'path'].join(' '));
  });
});

// ---------------------------------------------------------------------------------------------
// Wave 4 review fixes (docs/.output/findings/reviews/261118-1228-software-factory-wave4a-review.md)
// ---------------------------------------------------------------------------------------------

/** The text between two markers of the whole workflow; both must exist, in order. */
function between(start, end) {
  const t = text();
  const from = t.indexOf(start);
  expect(from, `marker ${JSON.stringify(start)}`).toBeGreaterThanOrEqual(0);
  const to = t.indexOf(end, from + start.length);
  expect(to, `end marker ${JSON.stringify(end)}`).toBeGreaterThan(from);
  return t.slice(from, to);
}

const FREEZE_CMD = 'node .claude/core/ac-verify.js freeze --todo';
const UNFREEZE_CMD = 'node .claude/core/ac-verify.js unfreeze --todo';
const CHECK_CMD = 'node .claude/core/ac-verify.js check --todo';

describe('M1: every story is frozen, whatever Step 2b does', () => {
  it('the freeze command lives in its own Step 2c, not inside Step 2b whose skip list would gate it', () => {
    expect(step('#### Step 2b')).not.toContain(FREEZE_CMD);
    const body = step('#### Step 2c');
    expect(body).toContain(FREEZE_CMD);
    expect(body).toMatch(/always/i);
    expect(text().indexOf('#### Step 2c')).toBeGreaterThan(text().indexOf('#### Step 2b'));
    expect(text().indexOf('#### Step 2c')).toBeLessThan(text().indexOf('#### Step 3: Implement'));
  });

  it('Step 2c names every path the skip lists cover and why the freeze cannot be skipped (BASELINE_MISSING)', () => {
    const body = step('#### Step 2c');
    for (const path of ['Path A', 'Path B', 'one-round dispatch', 'test-authoring epic', '`[manual]`', 'no `verify:` bindings']) {
      expect(body, path).toContain(path);
    }
    expect(body).toContain('BASELINE_MISSING');
    expect(body).toContain("Step 2b's skip list does not apply");
    expect(body).toMatch(/no test files in the Files list/);
  });

  it('Step 2b skip conditions, and the test-authoring-epic bullet, say the freeze still runs', () => {
    expect(step('#### Step 2b')).toMatch(/Skipping Step 2b skips the tests and the red run only; the freeze \(Step 2c\) still runs for every story/);
    expect(step('#### Step 2b')).toMatch(/Step 2c still freezes each story first/);
  });
});

describe('M2: no freeze lock outlives the wave', () => {
  it('the unfreeze command is in Step 3b (both paths), preceded by a tamper check, and not in the Path-B-only Step 4', () => {
    const body = step('#### Step 3b');
    expect(body).toContain(UNFREEZE_CMD);
    expect(body.indexOf(CHECK_CMD)).toBeGreaterThanOrEqual(0);
    expect(body.indexOf(CHECK_CMD)).toBeLessThan(body.indexOf(UNFREEZE_CMD));
    expect(body).toMatch(/both paths/i);
    expect(step('#### Step 4')).not.toContain(UNFREEZE_CMD);
    expect(text().indexOf('#### Step 3b')).toBeLessThan(text().indexOf('#### Step 4'));
  });

  it('Path A is sent through Step 3b before the gate', () => {
    const pathA = between('### Path A: Main Agent Implements Directly', '### Path B: Delegate to agents');
    expect(pathA).toContain('lift the freeze (Step 3b)');
  });

  it('a story removed as blocked is unfrozen too', () => {
    expect(step('#### Step 3b')).toMatch(/including a story later marked `\[!\]` and removed from the wave/);
  });

  it('the legitimate re-baseline is the four-command sequence: check, unfreeze, freeze --reason, unfreeze', () => {
    const body = step('#### Step 2c');
    const list = body.slice(body.indexOf('**Every freeze is lifted'));
    const at = (needle, from = 0) => {
      const i = list.indexOf(needle, from);
      expect(i, needle).toBeGreaterThanOrEqual(from);
      return i;
    };
    const check = at('ac-verify.js check --todo');
    const unfreeze1 = at('ac-verify.js unfreeze --todo', check);
    const freeze = at('ac-verify.js freeze --todo', unfreeze1);
    const unfreeze2 = at('ac-verify.js unfreeze --todo', freeze);
    expect(list.slice(freeze, unfreeze2)).toContain('--reason');
  });

  it('a retry or re-dispatch re-freezes with a reason after a check, and unfreezes when the subagent reports', () => {
    const body = step('#### Step 5');
    const para = body.slice(body.indexOf('**Before any re-dispatch'));
    expect(para).toContain('ac-verify.js check');
    expect(para).toMatch(/freeze --todo "\{TODO_PATH\}" --stories "\{ID\}" --reason/);
    expect(para).toMatch(/`unfreeze` when it reports/);
  });
});

describe('M3: the retry state machine is wired where failures are observed (Step 5)', () => {
  it('the table moved out of the Path-B-only Step 4 into Step 5, which every path passes', () => {
    expect(step('#### Step 4')).not.toContain('| Gate failure | Same signature? | Action |');
    expect(step('#### Step 5')).toContain('| Gate failure | Same signature? | Action |');
    expect(step('#### Step 5')).toMatch(/every path, Path A included/);
  });

  it('Step 5 no longer says the Main Agent diagnoses a failure unqualified, and no longer stops after "3 consecutive failures"', () => {
    const body = step('#### Step 5');
    expect(body).not.toContain('Main Agent diagnoses, fixes');
    expect(body).not.toContain('**3 consecutive failures**');
    const fail = body.split('\n').find(l => l.startsWith('- **Fail**')) ?? '';
    expect(fail).toMatch(/retry state machine/);
  });

  it('row 3 only fires on the same signature a third time; different signatures restart at row 1', () => {
    const row3 = step('#### Step 5').split('\n').find(l => l.startsWith('- **Row 3 of the table**')) ?? '';
    expect(row3).toMatch(/same signature a third time on a changed tree/);
    expect(row3).toMatch(/different signatures? (are not row 3|restarts?)/);
  });

  it('says how to read the streak: failure-ledger streak, the "seen N times in a row" line, and the N-to-row mapping', () => {
    const body = step('#### Step 5');
    expect(body).toContain('node .claude/core/_lib/failure-ledger.js streak');
    expect(body).toContain('seen N times in a row');
    expect(body).toMatch(/N = 1 is row 1, N = 2 is row 2, N = 3 is row 3/);
  });

  it('says how to keep both prior failures: last returns only the newest, so each block is pasted into the wave entry Failures field', () => {
    const body = step('#### Step 5');
    expect(body).toMatch(/`last` returns only the newest failure/);
    expect(body).toMatch(/paste each failure's `last --format prompt` block into the wave entry's Failures field/);
    expect(between('### Wave {N} ({YYYY-MM-DD})', '**Review — Wave {N}**')).toMatch(/^- \*\*Failures:\*\* /m);
  });

  it('the dev prompt template has a PRIOR FAILURE block, empty unless re-dispatched', () => {
    const template = between('Dev agent prompt template:', '**Model selection.**');
    expect(template).toContain('PRIOR FAILURE (only when this is a re-dispatch after a failing gate; omit the block otherwise)');
    expect(template.indexOf('PRIOR FAILURE')).toBeGreaterThan(template.indexOf('PRIOR LEARNINGS'));
    expect(template.indexOf('PRIOR FAILURE')).toBeLessThan(template.indexOf('CONSTRAINTS:'));
  });

  it('a focused run saves its output to a file before it is recorded (a failing --exit needs --output-file)', () => {
    expect(step('#### Step 5')).toMatch(/redirect its output to a file/);
    expect(step('#### Step 5')).toMatch(/a failing `--exit` without `--output-file` exits 2/);
  });

  it('the Pass bullet counts the item-5 gate.js test run and its receipt', () => {
    const pass = step('#### Step 5').split('\n').find(l => l.startsWith('- **Pass**')) ?? '';
    expect(pass).toMatch(/item-5 `gate\.js test` run and its receipt/);
  });
});

describe('M4: seal --docs guidance for a TODO outside the code-hash exclusions', () => {
  it('names --docs "{TODO_PATH}", the docs/modules case and the code-drift refusal', () => {
    const body = step('#### Step 7');
    expect(body).toContain('--docs "{TODO_PATH},{other doc}"');
    expect(body).toContain('docs/modules/**');
    expect(body).toContain('code-drift');
    expect(body).toMatch(/documents only \(no code file, no directory\)/);
    expect(body).toMatch(/must not change between the gate and the seal/);
  });

  it('the --docs sentence follows the seal command', () => {
    const body = step('#### Step 7');
    expect(body.indexOf('--docs "{TODO_PATH}')).toBeGreaterThan(body.indexOf('node .claude/core/ship-check.js seal'));
  });

  it('the Step 7 AC edit to a later story is made after the seal when the TODO is sealed with --docs', () => {
    expect(step('#### Step 7')).toMatch(/make that edit after the seal/);
  });
});

describe('M5: the budget is scaled at plan creation, checked before every fan-out and stops for the owner', () => {
  it('Phase 1 states the scaling rule and warns a pre-existing plan has no line', () => {
    const t = text();
    expect(t).toContain('`minutes` = 60 x open waves');
    expect(t).toContain('`dispatches` = 8 x open stories');
    expect(t).toMatch(/unless the owner gave one/);
    expect(t).toMatch(/A plan that predates this line has none: add the line from the rule at resume/);
  });

  it('Step 3 runs the budget command first, before the wave strategy and any dispatch, and covers retries', () => {
    const body = step('#### Step 3: Implement');
    const budget = body.indexOf('node .claude/core/_lib/failure-ledger.js budget --since');
    expect(budget).toBeGreaterThanOrEqual(0);
    expect(budget).toBeLessThan(body.indexOf('Size the wave to decide the implementation strategy'));
    expect(body).toMatch(/before every fan-out \(including Wave 1\) and before every retry or re-dispatch/);
  });

  it('exit 12 is a needs-human stop with the ledger numbers; exit 2 is not a pass; the raise is an owner decision', () => {
    const body = step('#### Step 3: Implement');
    expect(body).toMatch(/Exit 12 means a limit is spent: stop, do not dispatch, and ask the owner/);
    expect(body).toMatch(/needs-human stop, not the end of the run/);
    expect(body).toMatch(/Exit 2 is a usage error[^\n]*never a pass/);
    expect(body).toContain('Owner Decisions');
  });

  it('M6: the window is the invocation\'s own run record, not the plan stamp, and the ledgers are project-wide', () => {
    const body = step('#### Step 3: Implement');
    expect(body).toContain('failure-ledger.js budget --since "{run since}"');
    expect(body).not.toContain('--since "{plan stamp}"');
    expect(body).toMatch(/`\{run since\}` is the `since` stamp[^\n]*of this invocation's run record[^\n]*`run-record\.js current`[^\n]*never the plan filename's stamp/);
    expect(body).toMatch(/`minutes` is the active time since this invocation's `start`[^\n]*project-wide ledgers/);
    expect(body).toMatch(/earlier session's usage and the time between sessions are not counted/);
  });

  it('changing the Budget line mid-run needs a logged reason, in a Budget field of the wave entry', () => {
    expect(step('#### Step 3: Implement')).toMatch(/needs a logged reason in the wave entry's Budget field/);
    expect(between('### Wave {N} ({YYYY-MM-DD})', '**Review — Wave {N}**')).toMatch(/^- \*\*Budget:\*\* \{unchanged \| changed to/m);
  });

  it('the budget command is no longer only in Step 4a (the old placement ran after the first fan-out)', () => {
    expect(step('#### Step 4')).not.toContain('failure-ledger.js budget');
  });
});

describe('m1: {wave story IDs} is defined as comma-separated with no spaces before its first use', () => {
  it('Variables defines it, and the definition precedes every use', () => {
    const t = text();
    const def = t.indexOf('{wave story IDs}: the IDs of the stories in the wave being run, comma-separated with no spaces');
    expect(def).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('{wave story IDs}')).toBe(def);
    expect(t).toContain('INVALID_STORY_IDS');
  });

  it('the Step 2c, seal and 8f commands repeat that it is comma-separated', () => {
    expect(step('#### Step 2c')).toMatch(/`\{wave story IDs\}` is comma-separated with no spaces/);
    expect(step('#### Step 7')).toMatch(/`\{wave story IDs\}` is comma-separated with no spaces/);
    const s8f = between('**8f. Commit', '**8g. Verify commit**');
    expect(s8f).toMatch(/`\{wave story IDs\}`: comma-separated, no spaces/);
  });
});

describe('m2: Step 7 review-fix wording and the receipt run versus the checkpoint cadence', () => {
  it('a review fix needs a new gate.js test receipt, and the old "does not need a full suite" wording is gone', () => {
    const body = step('#### Step 7');
    expect(body).toMatch(/it needs a new `gate\.js test` receipt \(Step 5 item 5\) and `ac-verify\.js run` before the seal/);
    expect(body).not.toContain('does not by itself call for a full suite (the checkpoints');
  });

  it('the cadence paragraph says how the per-wave receipt run relates to the full-suite checkpoints', () => {
    const t = text();
    const para = t.slice(t.indexOf('**Verification cadence (default'), t.indexOf('## Phase 0: Pre-Flight'));
    expect(para).toMatch(/Every wave also runs `gate\.js test` once for the ship receipt/);
    expect(para).toMatch(/counts as a checkpoint only when it falls on a due one/);
  });
});

describe('m3, m4: the Red line has an entry to go into, and a green-by-design binding is recordable', () => {
  it('Step 2b creates the wave block now and 8d completes it instead of appending a second one', () => {
    expect(step('#### Step 2b')).toMatch(/First create this wave's block under \*\*Wave Execution Log\*\*/);
    expect(step('#### Step 2b')).toMatch(/never appends a second `### Wave \{N\}`/);
    expect(between('**8d. Update the execution plan file**', '**8e.')).toMatch(/Complete this wave's block under \*\*Wave Execution Log\*\*/);
  });

  it('a binding that is green before implementation by design is recorded as "green by design", only for the two named classes', () => {
    const body = step('#### Step 2b');
    expect(body).toContain('green by design: {why}');
    expect(body).toMatch(/F32 cross-story check/);
    expect(body).toMatch(/Any other vacuous pass means the test is wrong/);
  });
});

describe('m5: prose that named no exception to the standard-tier subagent rule', () => {
  it('the route condition and the Supervised-runs line name the deep retry exception', () => {
    const impl = require('../_lib/workflow-routes').parseWorkflowRoutes(text()).find(r => r.step === 'wave-implementation-standard');
    expect(impl.condition).toBe('Delegate path; every developer story (subagents run on the standard tier; the one exception is the deep retry route below)');
    expect(text()).toContain('as above (the deep-tier retry attempt is the one exception)');
  });

  it('keeps the route count at 9', () => {
    expect(require('../_lib/workflow-routes').parseWorkflowRoutes(text())).toHaveLength(9);
  });

  it('the raised retry tier has its own Retry field and no longer overloads the risk-tier field', () => {
    const entry = between('### Wave {N} ({YYYY-MM-DD})', '**Review — Wave {N}**');
    expect(entry).toMatch(/^- \*\*Tier:\*\* \{the wave's risk tier: deep \| standard\}$/m);
    expect(entry).toMatch(/^- \*\*Retry:\*\* \{none \| `Tier: raised from standard: same-signature x2`/m);
    expect(entry).not.toMatch(/raised from standard: reason/);
  });
});

describe('m8: Step 6 run results are not ignored', () => {
  it('a non-zero ac-verify run exit means the unmet criteria are FAIL in the AC table', () => {
    expect(step('#### Step 6')).toMatch(/A non-zero exit means at least one bound criterion is unmet: those criteria are FAIL in the AC table/);
  });
});

describe('guard-test hygiene for the new prose', () => {
  it('has no model-name literal (tokens only)', () => {
    expect(text()).not.toMatch(/\b(sonnet|opus|haiku)\b/i);
  });
});
