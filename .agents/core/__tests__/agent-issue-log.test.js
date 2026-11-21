// SF-4.2: tests for `.agents/core/agent-issue-log.js`: structured agent-issue rows in the day's human log.
// Standard tier: one test per AC behaviour (plus table-driven refusals).
//
// PINNED CONTRACT. The implementer must match these names, signatures and shapes; the tests are the spec.
//
// Exports (CommonJS; the CLI is guarded by `require.main === module`, so requiring the file never exits):
//   add(opts)  -> result    append one row; opts { root, skill, step, agent, issue, fix, signature?, story?, session?, now? }
//   main(argv = process.argv.slice(2), env = process.env) -> exit code number; prints exactly ONE JSON document to stdout
//   `root` is the absolute project root (CLI: CLAUDE_PROJECT_DIR when set, else the repo root); `now` is the clock (a Date,
//   local time); `session` is the session id for the run pointer. No export throws: a hostile `opts` (null, a number, a
//   number for root...) or any internal exception becomes { exitCode: 2, errors: [{ rule, message }, ...] }.
//   Result: success { exitCode: 0, file }, where `file` is the log's repo-relative path with forward slashes;
//   refusal { exitCode: 2, errors: [{ rule, message }] }. Rules used: invalid-args (bad or missing input), unknown-skill,
//   unsafe-path (the log file is not a regular file, e.g. a symlink), exception (anything unforeseen).
//
// CLI:
//   agent-issue-log.js add --skill <dir> --step <id> --agent <role> --issue <text> --fix <text>
//                          [--signature <hash>] [--story <ID>] [--session <id>]
//   A flag's value is the next argv element verbatim unless it starts with `--`. Every flag takes a value and appears at
//   most once; an unknown flag, an unknown or missing verb, a missing required flag or a flag without a value is exit 2.
//   Beyond the AC text: `--story` (the /do and /run-tests call sites have no wave) and `--session` (the Bash tool keeps no
//   shell state; the default is env CLAUDE_CODE_SESSION_ID, as for run-record.js). stdout: exactly one JSON document with
//   `exitCode`; for exit 2 also stderr `[agent-issue-log] refusing: {message}`. A refused call writes nothing anywhere.
//
// WHAT IT WRITES: `docs/.output/evolution/agents/{YYYY-MM-DD}.md` (date = the local date of `now`).
//   A new file starts `# Agent issues — {date}` then a blank line. Rows live under a heading `## {date} — Wave N` (N from
//   the session's run pointer, `current-run-{session}.json`, read through `_lib/run-pointer.js`); with no wave the heading
//   is `## {date} — {story}` (the --story value), else `## {date} — Ad hoc`. An existing heading with the same text, or the
//   same text followed by ` (...)` (the human logs write `## 2026-11-18 — Wave 4 (SF-1.6, SF-1.7)`), is the same section;
//   `Wave 40` is not `Wave 4`. The section holds `### Agent Issues` and a table whose header is exactly
//     | Agent | Story | Skill | Step | Signature | Run | Issue | Fix Applied |
//   followed by a separator row of eight cells, then one row per call, in call order:
//     | {agent} | {story} | {skill} | {step} | {signature} | {run_id} | {issue} | {fix} |
//   Story = --story, else the pointer's story, else `-`. Run = the pointer's run_id, else `-`. Signature = --signature, else
//   the newest failure row of the failure ledger (see below), else `-`. A new row goes after the last row of the section's
//   LAST `### Agent Issues` table when that table has the structured header; otherwise (no table, or a legacy 4-column
//   table) a new `### Agent Issues` subsection with the structured header goes at the end of the section. Nothing else in the
//   file ever changes: existing lines stay byte-identical and in order (per-row parsing of the new rows is SF-4.5).
//
// VALIDATION (exit 2, nothing written):
//   --skill   must name a DIRECTORY directly under `<root>/.agents/skills/` (rule unknown-skill for a name that is absent,
//             a file, or not a plain name: `..`, `a/b`, an absolute path); chars [A-Za-z0-9._-] only, first char [A-Za-z0-9]
//   --step    /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/        --agent  /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,59}$/
//   --story   /^[A-Za-z0-9][A-Za-z0-9._,-]{0,99}$/       --issue, --fix  non-blank text
//   --signature  /^[0-9a-f]{12,64}$/ (a full sha256 or the 12-character prefix the status line prints) or /^empty:[A-Za-z0-9+_.-]+$/
//   Text cells: `|` is written `\|` and every run of whitespace, newlines included, becomes one space, so a value can never
//   add a column, a row or a heading.
//
// FAILURE SIGNATURE (SF-1.5 ledger, `docs/.output/.state/telemetry/gate-failures.jsonl`, rows { ts, head, sig, legs, passed,
//   killed }): when --signature is absent, take the newest row that is not killed; when that row is a failure (passed is not
//   true) its `sig` is the cell; when it is a pass, or no row exists, the cell is `-`. Corrupt ledger lines are skipped.
//   An explicit --signature always wins.
//
// REVIEW FIXES (wave 7 review, SF-4.2 findings A-1..A-8), each pinned by a describe named by its id at the end of the file:
//   A-1 the read-modify-write runs under a lock file (`docs/.output/.state/agent-issue-log-{date}.lock`); a lock held past
//       `lockWaitMs` is refusal rule `busy` (exit 2); A-2 the automatic signature counts only inside the run's scope (the
//       pointer's `since`, else the 60 minutes before `now`); A-3 backslashes before a pipe are doubled; A-4/A-5 the workflow
//       snippets pass `--session` and never tell the model to hand-write; A-6 the skill dir needs a SKILL.md; A-7 `--flag=value`
//       and a 2000-character cell cap; A-8 a random temp-file suffix.
//
// NOT COVERED (reported to the owner): a FIFO in place
//   of the log or the ledger; Windows (the symlink case is skipped there); a linked-worktree session (log root vs pointer
//   root); a stale (over 24 h) pointer, which run-pointer.js owns and run-record.test.js covers.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve('.agents/core/agent-issue-log.js');
const fl = require('../_lib/failure-ledger');
const { pointerFilePath } = require('../_lib/run-pointer');
const subject = () => require('../agent-issue-log');

const isWindows = process.platform === 'win32';
const LOG_DIR = 'docs/.output/evolution/agents';
const HEADER = '| Agent | Story | Skill | Step | Signature | Run | Issue | Fix Applied |';
const LEGACY_HEADER = '| Agent | Story | Issue | Fix Applied |';
const SEP_RE = /^\|(?: ?-+ ?\|){8}$/;
const T0 = new Date(2026, 10, 18, 12, 0, 0); // local clock: nothing depends on the wall clock or the time zone
const DATE = '2026-11-18';
const SIG64 = 'a'.repeat(64);
const SIG_LEDGER = 'b'.repeat(64);
const RUN_ID = '261118-1200-run-todo-sf-4-2';
const WAVE_HEADING = `## ${DATE} — Wave 3`;

const roots = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** A project root with two skill directories and a file (not a directory) under `.agents/skills`. */
function mkRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-issue-log-')));
  roots.push(root);
  for (const skill of ['qa-engineer', 'run-todo']) {
    fs.mkdirSync(path.join(root, '.agents/skills', skill), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents/skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  fs.writeFileSync(path.join(root, '.agents/skills/README.md'), '# skills\n');
  return root;
}
const logPath = (root, date = DATE) => path.join(root, LOG_DIR, `${date}.md`);
const readLog = (root, date = DATE) => fs.readFileSync(logPath(root, date), 'utf8');
const hasLog = (root, date = DATE) => fs.existsSync(logPath(root, date));
const seedLog = (root, text, date = DATE) => {
  fs.mkdirSync(path.join(root, LOG_DIR), { recursive: true });
  fs.writeFileSync(logPath(root, date), text);
};
/** Every file under `dir`, relative, sorted: proves "nothing written anywhere". */
function listAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}
const snapshot = (root) => listAll(root).map((rel) => `${rel}:${fs.readFileSync(path.join(root, rel), 'utf8')}`);

function writePointer(root, session, fields = {}) {
  const file = pointerFilePath(root, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ run_id: RUN_ID, plan: null, wave: 3, story: null, since: '261118-1200', ...fields }));
}

const BASE = { skill: 'qa-engineer', step: '8c', agent: 'general-purpose', issue: 'wrong selector', fix: 'used role query' };
/** In-process call. Every call defaults to the fixed clock and no session (so no pointer). */
function add(root, opts = {}) {
  return subject().add({ root, now: T0, ...BASE, ...opts });
}
const tableLines = (text) => text.split('\n').filter((l) => l.startsWith('|'));
const rowCells = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
/** The data rows (header and separator excluded) of every structured table in `text`. */
const dataRows = (text) => tableLines(text).filter((l) => l !== HEADER && !SEP_RE.test(l) && l !== LEGACY_HEADER && !/^\|-+\|/.test(l));
const headingsOf = (text) => text.split('\n').filter((l) => /^## /.test(l));
const expectedRow = (o = {}) => {
  const c = { agent: 'general-purpose', story: '-', skill: 'qa-engineer', step: '8c', sig: '-', run: '-', issue: 'wrong selector', fix: 'used role query', ...o };
  return `| ${c.agent} | ${c.story} | ${c.skill} | ${c.step} | ${c.sig} | ${c.run} | ${c.issue} | ${c.fix} |`;
};
/** True when every line of `before` appears in `after`, in order: the file only ever grew. */
function isSubsequence(before, after) {
  const a = after.split('\n');
  let i = 0;
  for (const line of before.split('\n')) {
    while (i < a.length && a[i] !== line) i++;
    if (i === a.length) return false;
    i++;
  }
  return true;
}

// ── AC1: add writes a structured row under the day's Wave section ───

describe('agent-issue-log add: the structured row and its section', () => {
  it('add_noLogYet_createsDayFileWithTitleWaveSectionTableAndExactRow', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a');

    const res = add(root, { session: 'sess-a', story: 'SF-4.2' });

    expect(res.exitCode).toBe(0);
    expect(res.file).toBe(`${LOG_DIR}/${DATE}.md`);
    const lines = readLog(root).split('\n');
    expect(lines[0]).toBe(`# Agent issues — ${DATE}`);
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe(WAVE_HEADING);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('### Agent Issues');
    expect(lines[5]).toBe(HEADER);
    expect(lines[6]).toMatch(SEP_RE);
    expect(lines[7]).toBe(expectedRow({ story: 'SF-4.2', run: RUN_ID }));
    expect(lines.slice(8)).toEqual(['']);
  });

  it('add_twoCallsSameWave_appendsRowsInCallOrderUnderOneSectionAndOneTable', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a');

    add(root, { session: 'sess-a', issue: 'first issue' });
    add(root, { session: 'sess-a', issue: 'second issue', skill: 'run-todo' });

    const text = readLog(root);
    expect(headingsOf(text)).toEqual([WAVE_HEADING]);
    expect(text.split('\n').filter((l) => l === '### Agent Issues')).toHaveLength(1);
    expect(tableLines(text).filter((l) => l === HEADER)).toHaveLength(1);
    expect(dataRows(text)).toEqual([
      expectedRow({ run: RUN_ID, issue: 'first issue' }),
      expectedRow({ run: RUN_ID, issue: 'second issue', skill: 'run-todo' }),
    ]);
  });

  it('add_differentWave_appendsASecondSectionAndLeavesEarlierTextUnchanged', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a', { wave: 3 });
    add(root, { session: 'sess-a' });
    const before = readLog(root);
    writePointer(root, 'sess-a', { wave: 4 });

    add(root, { session: 'sess-a', issue: 'wave four issue' });

    const after = readLog(root);
    expect(after.startsWith(before)).toBe(true);
    expect(headingsOf(after)).toEqual([WAVE_HEADING, `## ${DATE} — Wave 4`]);
    expect(dataRows(after).at(-1)).toBe(expectedRow({ run: RUN_ID, issue: 'wave four issue' }));
  });

  it('add_existingLogWithoutThisWave_appendsNewSectionAndKeepsTheFileAsAPrefix', () => {
    const root = mkRoot();
    const original = `# Agent issues — ${DATE} (hand written)\n\n## ${DATE} — Wave 1\n\n### Agent Issues\n${LEGACY_HEADER}\n|-------|-------|-------|-------------|\n| qa-engineer | SF-1.1 | old issue | old fix |\n`;
    seedLog(root, original);
    writePointer(root, 'sess-a', { wave: 2 });

    add(root, { session: 'sess-a' });

    const after = readLog(root);
    expect(after.startsWith(original)).toBe(true);
    expect(headingsOf(after)).toEqual([`## ${DATE} — Wave 1`, `## ${DATE} — Wave 2`]);
  });

  it('add_sectionHeadingHasSuffixAndTableFollowedBySubsections_insertsRowAtTableEndInThatSection', () => {
    const root = mkRoot();
    const seeded = [
      `# Agent issues — ${DATE}`, '',
      `## ${DATE} — Wave 3 (SF-4.1, SF-4.2)`, '',
      '### Agent Issues', HEADER, '|-------|-------|-------|------|-----------|-----|-------|-------------|',
      expectedRow({ issue: 'earlier' }), '',
      '### New Decisions', '- a decision', '',
      `## ${DATE} — Wave 4`, '',
      '### Agent Issues', HEADER, '|-------|-------|-------|------|-----------|-----|-------|-------------|',
      expectedRow({ issue: 'wave four' }), '',
    ].join('\n');
    seedLog(root, seeded);
    writePointer(root, 'sess-a', { wave: 3 });

    add(root, { session: 'sess-a', issue: 'late arrival' });

    const after = readLog(root);
    const lines = after.split('\n');
    const newRow = lines.indexOf(expectedRow({ run: RUN_ID, issue: 'late arrival' }));
    expect(newRow).toBeGreaterThan(-1);
    expect(lines[newRow - 1]).toBe(expectedRow({ issue: 'earlier' }));
    expect(newRow).toBeLessThan(lines.indexOf('### New Decisions'));
    expect(headingsOf(after)).toEqual([`## ${DATE} — Wave 3 (SF-4.1, SF-4.2)`, `## ${DATE} — Wave 4`]);
    expect(isSubsequence(seeded, after)).toBe(true);
  });

  it('add_waveFortyExistsAndWaveFourIsAsked_createsWaveFourAsItsOwnSection', () => {
    const root = mkRoot();
    const seeded = `# Agent issues — ${DATE}\n\n## ${DATE} — Wave 40\n\n### Agent Issues\n${HEADER}\n|-|-|-|-|-|-|-|-|\n${expectedRow({ issue: 'forty' })}\n`;
    seedLog(root, seeded);
    writePointer(root, 'sess-a', { wave: 4 });

    add(root, { session: 'sess-a' });

    const after = readLog(root);
    expect(headingsOf(after)).toEqual([`## ${DATE} — Wave 40`, `## ${DATE} — Wave 4`]);
    expect(after.startsWith(seeded)).toBe(true);
  });

  it('add_sectionHoldsLegacyFourColumnTable_leavesItByteIdenticalAndAddsStructuredSubsection', () => {
    const root = mkRoot();
    const seeded = [
      `# Agent issues — ${DATE}`, '',
      `## ${DATE} — Wave 3 (SF-1.1)`, '',
      '### Agent Issues', LEGACY_HEADER, '|-------|-------|-------|-------------|',
      '| general-purpose | SF-1.1 | legacy issue | legacy fix |', '',
      '### Prompt Improvements Needed', '- be precise', '',
      `## ${DATE} — Wave 4`, '', 'next section text', '',
    ].join('\n');
    seedLog(root, seeded);
    writePointer(root, 'sess-a', { wave: 3 });

    add(root, { session: 'sess-a' });

    const after = readLog(root);
    expect(isSubsequence(seeded, after)).toBe(true);
    expect(tableLines(after).filter((l) => l === HEADER)).toHaveLength(1);
    expect(dataRows(after).filter((l) => l === expectedRow({ run: RUN_ID }))).toHaveLength(1);
    const lines = after.split('\n');
    const structured = lines.indexOf(HEADER);
    expect(structured).toBeGreaterThan(lines.indexOf('| general-purpose | SF-1.1 | legacy issue | legacy fix |'));
    expect(structured).toBeLessThan(lines.indexOf(`## ${DATE} — Wave 4`));
  });

  it('add_otherDaysLogExists_leavesItUntouched', () => {
    const root = mkRoot();
    seedLog(root, '# Agent issues — 2026-11-17\n\n## 2026-11-17 — Wave 1\n\nbody\n', '2026-11-17');
    const before = readLog(root, '2026-11-17');

    add(root);

    expect(readLog(root, '2026-11-17')).toBe(before);
    expect(fs.readdirSync(path.join(root, LOG_DIR)).sort()).toEqual(['2026-11-17.md', `${DATE}.md`]);
  });

  it('add_noWaveButStory_usesTheStoryAsTheSectionHeading', () => {
    const root = mkRoot();

    add(root, { story: 'SF-4.2' });

    expect(headingsOf(readLog(root))).toEqual([`## ${DATE} — SF-4.2`]);
    expect(dataRows(readLog(root))).toEqual([expectedRow({ story: 'SF-4.2' })]);
  });

  it('add_noWaveAndNoStory_usesAdHocAsTheSectionHeadingAndDashesForStoryAndRun', () => {
    const root = mkRoot();

    add(root);

    expect(headingsOf(readLog(root))).toEqual([`## ${DATE} — Ad hoc`]);
    expect(dataRows(readLog(root))).toEqual([expectedRow()]);
  });
});

// ── run id, wave and story stamping from the run pointer ────────────

describe('agent-issue-log add: run pointer stamping', () => {
  it('add_pointerForSession_stampsRunIdStoryAndWaveHeading', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a', { wave: 7, story: 'SF-1.1,SF-1.5' });

    add(root, { session: 'sess-a' });

    expect(headingsOf(readLog(root))).toEqual([`## ${DATE} — Wave 7`]);
    expect(dataRows(readLog(root))).toEqual([expectedRow({ run: RUN_ID, story: 'SF-1.1,SF-1.5' })]);
  });

  it('add_storyFlagAndPointerStory_flagWinsForTheStoryCell', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a', { story: 'SF-1.1' });

    add(root, { session: 'sess-a', story: 'SF-9.9' });

    expect(rowCells(dataRows(readLog(root))[0])[1]).toBe('SF-9.9');
  });

  it('add_sessionFromOtherSession_ignoresThePointer', () => {
    const root = mkRoot();
    writePointer(root, 'sess-other');

    add(root, { session: 'sess-a' });

    expect(headingsOf(readLog(root))).toEqual([`## ${DATE} — Ad hoc`]);
    expect(rowCells(dataRows(readLog(root))[0])[5]).toBe('-');
  });

  it('add_corruptPointer_writesTheRowWithDashesInsteadOfFailing', () => {
    const root = mkRoot();
    fs.mkdirSync(path.dirname(pointerFilePath(root, 'sess-a')), { recursive: true });
    fs.writeFileSync(pointerFilePath(root, 'sess-a'), '{not json');

    const res = add(root, { session: 'sess-a' });

    expect(res.exitCode).toBe(0);
    expect(dataRows(readLog(root))).toEqual([expectedRow()]);
  });
});

// ── the failure signature comes from the SF-1.5 ledger ──────────────

describe('agent-issue-log add: failure signature', () => {
  const sigCell = (root) => rowCells(dataRows(readLog(root))[0])[4];
  const fail = (root, sig, extra = {}) => fl.appendFailure({ head: 'h1', sig, legs: ['test'], passed: false, ts: T0.toISOString(), ...extra }, { root });

  it('add_explicitFullSignature_isWrittenVerbatim', () => {
    const root = mkRoot();

    add(root, { signature: SIG64 });

    expect(sigCell(root)).toBe(SIG64);
  });

  it('add_explicitTwelveCharPrefixAndEmptyModeSignatures_areAccepted', () => {
    const root = mkRoot();

    add(root, { signature: SIG64.slice(0, 12), issue: 'prefix' });
    add(root, { signature: 'empty:build', issue: 'empty mode' });

    expect(dataRows(readLog(root)).map((l) => rowCells(l)[4])).toEqual([SIG64.slice(0, 12), 'empty:build']);
  });

  it('add_noSignatureAndNewestLedgerRowIsAFailure_usesTheLedgerSignature', () => {
    const root = mkRoot();
    fail(root, 'c'.repeat(64));
    fail(root, SIG_LEDGER, { head: 'h2' });

    add(root);

    expect(sigCell(root)).toBe(SIG_LEDGER);
  });

  it('add_explicitSignatureAndLedgerFailure_explicitWins', () => {
    const root = mkRoot();
    fail(root, SIG_LEDGER);

    add(root, { signature: SIG64 });

    expect(sigCell(root)).toBe(SIG64);
  });

  it('add_newestLedgerRowIsAPass_writesADashBecauseTheFailureWasResolved', () => {
    const root = mkRoot();
    fail(root, SIG_LEDGER);
    fl.appendFailure({ head: 'h2', sig: null, legs: ['test'], passed: true, ts: T0.toISOString() }, { root });

    add(root);

    expect(sigCell(root)).toBe('-');
  });

  it('add_killedRowAfterAFailure_skipsTheNeutralRowAndUsesTheFailureSignature', () => {
    const root = mkRoot();
    fail(root, SIG_LEDGER);
    fl.appendFailure({ head: 'h2', sig: null, legs: ['test'], passed: false, killed: 'TIMEOUT', ts: T0.toISOString() }, { root });

    add(root);

    expect(sigCell(root)).toBe(SIG_LEDGER);
  });

  it('add_noLedgerFile_writesADash', () => {
    const root = mkRoot();

    add(root);

    expect(sigCell(root)).toBe('-');
  });

  it('add_corruptLedgerLineBeforeAndAfterAFailure_isSkippedAndTheSignatureStillRead', () => {
    const root = mkRoot();
    const ledger = fl.getLedgerPath(root);
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `{broken\n${JSON.stringify({ ts: T0.toISOString(), head: 'h1', sig: SIG_LEDGER, legs: ['test'], passed: false, killed: null })}\nnot json at all\n[1,2]\n`);

    const res = add(root);

    expect(res.exitCode).toBe(0);
    expect(sigCell(root)).toBe(SIG_LEDGER);
  });
});

// ── AC3: unknown skill, and every other malformed input, exits 2 without writing ──

describe('agent-issue-log add: refusals write nothing', () => {
  it.each([
    ['unknown name', 'no-such-skill'],
    ['parent traversal', '..'],
    ['nested traversal', '../../etc'],
    ['path separator', 'qa-engineer/SKILL.md'],
    ['backslash', 'qa-engineer\\x'],
    ['absolute path', '/etc'],
    ['dot', '.'],
    ['a file, not a directory', 'README.md'],
    ['empty', ''],
  ])('add_skill_%s_exitsTwoAndWritesNothing', (_label, skill) => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    const before = snapshot(root);

    const res = add(root, { skill });

    expect(res.exitCode).toBe(2);
    expect(res.errors.map((e) => e.rule)).toEqual([skill === '' ? 'invalid-args' : 'unknown-skill']);
    expect(snapshot(root)).toEqual(before);
    expect(hasLog(root)).toBe(false);
  });

  it('add_projectWithoutSkillsDirectory_exitsTwoUnknownSkill', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-issue-log-bare-')));
    roots.push(root);

    const res = add(root);

    expect(res.exitCode).toBe(2);
    expect(res.errors[0].rule).toBe('unknown-skill');
    expect(listAll(root)).toEqual([]);
  });

  it.each([
    ['step with a pipe', { step: '8c|x' }],
    ['step with a space', { step: 'step 8' }],
    ['empty step', { step: '' }],
    ['step too long', { step: 'a'.repeat(41) }],
    ['agent with a pipe', { agent: 'a|b' }],
    ['agent with a newline', { agent: 'a\nb' }],
    ['empty agent', { agent: '' }],
    ['blank issue', { issue: '   ' }],
    ['missing issue', { issue: undefined }],
    ['blank fix', { fix: '' }],
    ['missing fix', { fix: undefined }],
    ['missing skill', { skill: undefined }],
    ['story with a pipe', { story: 'SF|1' }],
    ['story with a newline', { story: 'SF-1\n## injected' }],
    ['signature not hex', { signature: 'zzzzzzzzzzzz' }],
    ['signature too short', { signature: 'abc123' }],
    ['signature with a pipe', { signature: 'abcdef123456|x' }],
    ['signature too long', { signature: 'a'.repeat(65) }],
    ['empty signature mode', { signature: 'empty:' }],
  ])('add_%s_exitsTwoInvalidArgsAndWritesNothing', (_label, override) => {
    const root = mkRoot();
    const before = snapshot(root);

    const res = add(root, override);

    expect(res.exitCode).toBe(2);
    expect(res.errors.map((e) => e.rule)).toEqual(['invalid-args']);
    expect(snapshot(root)).toEqual(before);
  });

  it.each([null, 42, 'text'])('add_hostileOpts_%s_returnsExitTwoWithAnErrorInsteadOfThrowing', (opts) => {
    const res = subject().add(opts);

    expect(res.exitCode).toBe(2);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('add_rootIsNotAString_returnsExitTwoWithAnErrorInsteadOfThrowing', () => {
    const res = subject().add({ ...BASE, root: 12345, now: T0 });

    expect(res.exitCode).toBe(2);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});

// ── safety of the text cells and of the log path ────────────────────

describe('agent-issue-log add: cell and path safety', () => {
  it('add_issueAndFixWithPipesAndNewlines_neverAddsAColumnRowOrHeading', () => {
    const root = mkRoot();

    add(root, { issue: 'bad | pipe\n## 2026-11-18 — Wave 99\n### Agent Issues', fix: 'fix\r\n\twith   spaces | too' });

    const text = readLog(root);
    expect(headingsOf(text)).toEqual([`## ${DATE} — Ad hoc`]);
    expect(text.split('\n').filter((l) => l === '### Agent Issues')).toHaveLength(1);
    const rows = dataRows(text);
    expect(rows).toHaveLength(1);
    expect(rowCells(rows[0])).toHaveLength(8);
    expect(rows[0]).toBe(expectedRow({ issue: 'bad \\| pipe ## 2026-11-18 — Wave 99 ### Agent Issues', fix: 'fix with spaces \\| too' }));
  });

  it.skipIf(isWindows)('add_logFileIsASymlink_exitsTwoUnsafePathAndLeavesTheTargetUntouched', () => {
    const root = mkRoot();
    const target = path.join(root, 'victim.md');
    fs.writeFileSync(target, 'precious\n');
    fs.mkdirSync(path.join(root, LOG_DIR), { recursive: true });
    fs.symlinkSync(target, logPath(root));

    const res = add(root);

    expect(res.exitCode).toBe(2);
    expect(res.errors.map((e) => e.rule)).toEqual(['unsafe-path']);
    expect(fs.readFileSync(target, 'utf8')).toBe('precious\n');
    expect(fs.lstatSync(logPath(root)).isSymbolicLink()).toBe(true);
  });

  it('add_logPathIsADirectory_exitsTwoUnsafePath', () => {
    const root = mkRoot();
    fs.mkdirSync(logPath(root), { recursive: true });

    const res = add(root);

    expect(res.exitCode).toBe(2);
    expect(res.errors.map((e) => e.rule)).toEqual(['unsafe-path']);
  });
});

// ── the CLI ─────────────────────────────────────────────────────────

const STRIPPED_ENV = new Set(['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'AGENTS_RUNTIME', 'CI']);
function childEnv(root, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIPPED_ENV.has(k) || k === 'VITEST' || k.startsWith('VITEST_')) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_PROJECT_DIR: root, ...extra };
}
function cli(root, args, env = {}) {
  expect(fs.existsSync(SCRIPT), 'agent-issue-log.js must exist at .agents/core/agent-issue-log.js').toBe(true);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env: childEnv(root, env), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json;
  try { json = JSON.parse(r.stdout); } catch { json = undefined; }
  expect(json, `stdout must be exactly one JSON document (status ${r.status}, stderr: ${r.stderr})`).not.toBeUndefined();
  return { status: r.status, json, stderr: r.stderr };
}
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const FLAGS = ['add', '--skill', 'qa-engineer', '--step', '8c', '--agent', 'general-purpose', '--issue', 'wrong selector', '--fix', 'used role query'];

describe('agent-issue-log CLI', () => {
  it('cli_addWithSessionFromEnvAndPointer_exitsZeroPrintsOneJsonAndWritesTodaysLog', () => {
    const root = mkRoot();
    writePointer(root, 'sess-env', { wave: 2 });
    const before = localDate(new Date());

    const r = cli(root, [...FLAGS, '--story', 'SF-4.2', '--signature', SIG64], { CLAUDE_CODE_SESSION_ID: 'sess-env' });

    const after = localDate(new Date());
    expect(r.status).toBe(0);
    expect(r.json.exitCode).toBe(0);
    const files = fs.readdirSync(path.join(root, LOG_DIR));
    expect(files).toHaveLength(1);
    expect([`${before}.md`, `${after}.md`]).toContain(files[0]);
    expect(r.json.file).toBe(`${LOG_DIR}/${files[0]}`);
    const date = files[0].replace(/\.md$/, '');
    expect(dataRows(readLog(root, date))).toEqual([expectedRow({ story: 'SF-4.2', sig: SIG64, run: RUN_ID })]);
    expect(headingsOf(readLog(root, date))).toEqual([`## ${date} — Wave 2`]);
  });

  it('cli_sessionFlag_isUsedWhenTheEnvironmentHasNoSession', () => {
    const root = mkRoot();
    writePointer(root, 'sess-flag', { wave: 5 });

    const r = cli(root, [...FLAGS, '--session', 'sess-flag']);

    expect(r.status).toBe(0);
    const date = fs.readdirSync(path.join(root, LOG_DIR))[0].replace(/\.md$/, '');
    expect(headingsOf(readLog(root, date))).toEqual([`## ${date} — Wave 5`]);
  });

  it('cli_issueStartingWithASingleDash_isTakenVerbatimAsTheValue', () => {
    const root = mkRoot();

    const r = cli(root, ['add', '--skill', 'qa-engineer', '--step', '8c', '--agent', 'general-purpose', '--issue', '-1 exit code', '--fix', 'fixed']);

    expect(r.status).toBe(0);
    const date = fs.readdirSync(path.join(root, LOG_DIR))[0].replace(/\.md$/, '');
    expect(rowCells(dataRows(readLog(root, date))[0])[6]).toBe('-1 exit code');
  });

  it('cli_unknownSkill_exitsTwoPrintsRefusingOnStderrAndWritesNothing', () => {
    const root = mkRoot();
    const before = snapshot(root);

    const r = cli(root, ['add', '--skill', 'no-such-skill', '--step', '8c', '--agent', 'general-purpose', '--issue', 'x', '--fix', 'y']);

    expect(r.status).toBe(2);
    expect(r.json.exitCode).toBe(2);
    expect(r.json.errors.map((e) => e.rule)).toEqual(['unknown-skill']);
    expect(r.stderr).toContain('[agent-issue-log] refusing:');
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    ['no verb', []],
    ['unknown verb', ['append']],
    ['unknown flag', [...FLAGS, '--bogus', 'x']],
    ['duplicate flag', [...FLAGS, '--step', '9c']],
    ['flag without a value', ['add', '--skill', 'qa-engineer', '--step', '8c', '--agent', 'general-purpose', '--issue', '--fix', 'y']],
    ['missing required flag', FLAGS.filter((_, i) => i < 9)],
  ])('cli_%s_exitsTwoWithOneJsonDocumentAndWritesNothing', (_label, args) => {
    const root = mkRoot();
    const before = snapshot(root);

    const r = cli(root, args);

    expect(r.status).toBe(2);
    expect(r.json.exitCode).toBe(2);
    expect(snapshot(root)).toEqual(before);
  });
});

// ── AC2 + AC4: the workflows call the helper instead of hand-writing markdown ──

describe('SF-4.2 workflow wiring', () => {
  const read = (skill) => fs.readFileSync(path.resolve(`.agents/skills/${skill}/references/workflow.md`), 'utf8');
  const between = (text, startRe, endRe) => {
    const start = text.search(startRe);
    expect(start, `anchor ${startRe} must exist`).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const end = rest.search(endRe);
    return end === -1 ? text.slice(start) : text.slice(start, start + 1 + end);
  };
  const CALL = /node \.claude\/core\/agent-issue-log\.js add\b/;

  const sites = [
    ['run-todo', 'run-todo 8c (Log agent issues)', () => between(read('run-todo'), /\*\*8c\. Log agent issues/, /\*\*8d\./)],
    ['do', 'do 9c (Log agent issues)', () => between(read('do'), /### 9c\. Log agent issues/, /\*\*Attribution ledger|\n### \d/)],
    ['run-tests', 'run-tests rule 10 (Log agent issues)', () => between(read('run-tests'), /^10\. Log agent issues/m, /\n11\. /)],
  ];

  it.each(sites)('%s_logAgentIssuesStep_callsAgentIssueLogAddWithEveryRequiredFlag', (_skill, _label, section) => {
    const text = section();

    expect(text).toMatch(CALL);
    for (const flag of ['--skill', '--step', '--agent', '--issue', '--fix']) expect(text).toContain(flag);
  });

  it.each(sites)('%s_logAgentIssuesStep_mentionsTheOptionalSignatureAndNamesTheLogItWrites', (_skill, _label, section) => {
    const text = section();

    expect(text).toContain('--signature');
    expect(text).toContain('docs/.output/evolution/agents/');
  });

  it.each(sites.slice(0, 2))('%s_logAgentIssuesStep_nolongerCarriesTheHandWrittenIssueTable', (_skill, _label, section) => {
    const text = section();

    expect(text).not.toContain(LEGACY_HEADER);
    expect(text).not.toContain('- **{agent-type}**:');
  });
});

// ── review fixes (wave 7): one describe per finding id ──────────────

/** Async CLI call, so several children run at the same moment. Resolves { status, json }. */
function cliAsync(root, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: root, env: childEnv(root, env), windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('close', (status) => {
      let json;
      try { json = JSON.parse(out); } catch { json = undefined; }
      resolve({ status, json });
    });
  });
}
const lockFiles = (root) => {
  const dir = path.join(root, 'docs/.output/.state');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.lock')) : [];
};

describe('A-1 concurrent adds keep every row', () => {
  it('cli_twelveConcurrentAdds_allExitZeroAndTwelveRowsLand', async () => {
    const root = mkRoot();
    const calls = Array.from({ length: 12 }, (_, i) => cliAsync(root, ['add', '--skill', 'qa-engineer', '--step', '8c', '--agent', 'general-purpose', '--issue', `concurrent issue ${i}`, '--fix', 'fixed']));

    const results = await Promise.all(calls);

    expect(results.map((r) => r.status)).toEqual(Array(12).fill(0));
    const date = fs.readdirSync(path.join(root, LOG_DIR)).filter((f) => f.endsWith('.md'))[0].replace(/\.md$/, '');
    const issues = dataRows(readLog(root, date)).map((l) => rowCells(l)[6]).sort();
    expect(issues).toEqual(Array.from({ length: 12 }, (_, i) => `concurrent issue ${i}`).sort());
    expect(lockFiles(root)).toEqual([]);
  }, 60000);

  it('add_lockHeldByAnotherWriter_refusesBusyExitTwoAndWritesNoRow', () => {
    const root = mkRoot();
    const lock = path.join(root, 'docs/.output/.state', `agent-issue-log-${DATE}.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'other-writer\n');

    const res = add(root, { lockWaitMs: 60 });

    expect(res.exitCode).toBe(2);
    expect(res.errors.map((e) => e.rule)).toEqual(['busy']);
    expect(hasLog(root)).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe('other-writer\n');
  });

  it('add_lockOlderThanTheStaleLimit_isBrokenAndTheRowIsWritten', () => {
    const root = mkRoot();
    const lock = path.join(root, 'docs/.output/.state', `agent-issue-log-${DATE}.lock`);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'crashed-writer\n');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);

    const res = add(root);

    expect(res.exitCode).toBe(0);
    expect(dataRows(readLog(root))).toEqual([expectedRow()]);
    expect(lockFiles(root)).toEqual([]);
  });

  it('add_refusalInsideTheLock_stillReleasesTheLock', () => {
    const root = mkRoot();
    fs.mkdirSync(logPath(root), { recursive: true });

    const res = add(root);

    expect(res.errors.map((e) => e.rule)).toEqual(['unsafe-path']);
    expect(lockFiles(root)).toEqual([]);
  });

  it('add_invalidLockWaitMs_exitsTwoInvalidArgs', () => {
    const root = mkRoot();

    const res = add(root, { lockWaitMs: -1 });

    expect(res.errors.map((e) => e.rule)).toEqual(['invalid-args']);
  });
});

describe('A-2 the automatic signature is scoped to the run', () => {
  const sigCell = (root) => rowCells(dataRows(readLog(root))[0])[4];
  const ts = (minutesFromT0) => new Date(T0.getTime() + minutesFromT0 * 60000).toISOString();
  const failAt = (root, minutes, sig = SIG_LEDGER) => fl.appendFailure({ head: 'h1', sig, legs: ['test'], passed: false, ts: ts(minutes) }, { root });

  it('add_pointerAndNewestFailureBeforeSince_writesADash', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a', { since: '261118-1200' });
    failAt(root, -30);

    add(root, { session: 'sess-a' });

    expect(sigCell(root)).toBe('-');
  });

  it('add_pointerAndFailureAfterSince_usesTheLedgerSignature', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a', { since: '261118-1200' });
    failAt(root, 5);

    add(root, { session: 'sess-a' });

    expect(sigCell(root)).toBe(SIG_LEDGER);
  });

  it('add_pointerAndFailureExactlyAtSince_usesTheLedgerSignature', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a', { since: '261118-1200' });
    failAt(root, 0);

    add(root, { session: 'sess-a' });

    expect(sigCell(root)).toBe(SIG_LEDGER);
  });

  it('add_pointerSinceIsLongerThanTheWindow_aTwoHourOldRunFailureStillCounts', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a', { since: '261118-0900' });
    failAt(root, -90);

    add(root, { session: 'sess-a' });

    expect(sigCell(root)).toBe(SIG_LEDGER);
  });

  it('add_noPointerAndFailureOlderThanTheWindow_writesADash', () => {
    const root = mkRoot();
    failAt(root, -61);

    add(root);

    expect(sigCell(root)).toBe('-');
  });

  it('add_noPointerAndFailureInsideTheWindow_usesTheLedgerSignature', () => {
    const root = mkRoot();
    failAt(root, -59);

    add(root);

    expect(sigCell(root)).toBe(SIG_LEDGER);
  });

  it('add_pointerWithoutParsableSince_fallsBackToTheWindow', () => {
    const root = mkRoot();
    writePointer(root, 'sess-a', { since: 'not-a-stamp' });
    failAt(root, -120, 'c'.repeat(64));
    failAt(root, -10);

    add(root, { session: 'sess-a' });

    expect(sigCell(root)).toBe(SIG_LEDGER);
  });

  it('add_failureRowWithoutAParsableTs_writesADash', () => {
    const root = mkRoot();
    const ledger = fl.getLedgerPath(root);
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `${JSON.stringify({ head: 'h1', sig: SIG_LEDGER, legs: ['test'], passed: false, killed: null, ts: 'yesterday-ish' })}\n`);

    add(root);

    expect(sigCell(root)).toBe('-');
  });

  it('add_explicitSignatureOnAnOutOfScopeFailure_stillWins', () => {
    const root = mkRoot();
    failAt(root, -600);

    add(root, { signature: SIG64 });

    expect(sigCell(root)).toBe(SIG64);
  });
});

describe('A-3 the pipe escape is unambiguous', () => {
  /** A parity-aware splitter (SF-4.5's rule): a pipe preceded by an odd run of backslashes is escaped. */
  const splitRow = (line) => {
    const cells = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '|') {
        let n = 0;
        while (n < cur.length && cur[cur.length - 1 - n] === '\\') n++;
        if (n % 2 === 0) { cells.push(cur); cur = ''; continue; }
      }
      cur += line[i];
    }
    return cells.slice(1).map((c) => c.trim());
  };
  const decode = (c) => c.replace(/(\\+)\|/g, (_m, b) => `${'\\'.repeat((b.length - 1) / 2)}|`);

  it.each([
    ['a pipe', 'x|y'],
    ['a backslash then a pipe', 'c\\|d'],
    ['two backslashes then a pipe', 'a\\\\|b'],
    ['three backslashes then a pipe', 'a\\\\\\|b'],
    ['a pipe at the end', 'tail|'],
    ['a backslash with no pipe', 'path\\to\\file'],
    ['a trailing backslash', 'ends with \\'],
  ])('add_issueWith%s_roundTripsThroughAParityAwareSplitter', (_label, value) => {
    const root = mkRoot();

    add(root, { issue: value, fix: 'f|g' });

    const cells = splitRow(dataRows(readLog(root))[0]);
    expect(cells).toHaveLength(8);
    expect(decode(cells[6])).toBe(value);
    expect(decode(cells[7])).toBe('f|g');
  });

  it('add_backslashThenPipe_isWrittenWithTheBackslashDoubled', () => {
    const root = mkRoot();

    add(root, { issue: 'c\\|d' });

    expect(rowCells(dataRows(readLog(root))[0])[6]).toBe('c\\\\\\|d');
  });
});

describe('A-4 and A-5 the workflow snippets pass --session and never tell the model to hand-write', () => {
  const read = (skill) => fs.readFileSync(path.resolve(`.agents/skills/${skill}/references/workflow.md`), 'utf8');
  const callLine = (text) => text.split('\n').filter((l) => l.includes('agent-issue-log.js add'));

  it.each(['do', 'run-todo', 'run-tests'])('%s_agentIssueLogCall_showsTheCodexSessionFlag', (skill) => {
    const lines = callLine(read(skill));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[--session {session_id}]');
  });

  it('do_doneWithConcernsRow_pointsAtTheHelperInsteadOfHandWriting', () => {
    const text = read('do');

    expect(text).not.toMatch(/Log the concern to docs\/\.output\/evolution\/agents/);
    expect(text).toMatch(/\*\*DONE_WITH_CONCERNS\*\*[^\n]*helper call in Step 9c/);
  });

  it('runTests_doneWithConcernsRow_pointsAtTheHelperInsteadOfHandWriting', () => {
    const text = read('run-tests');

    expect(text).not.toMatch(/Log to `docs\/\.output\/evolution\/agents/);
    expect(text).toMatch(/\*\*DONE_WITH_CONCERNS\*\*[^\n]*helper call in rule 10/);
  });

  it('runTests_helperCall_namesTheSkillRunTestsNotAPlaceholder', () => {
    const [line] = callLine(read('run-tests'));

    expect(line).toContain('--skill run-tests');
    expect(line).not.toContain('<skill-dir>');
  });

  it.each(['do', 'run-todo', 'run-tests'])('%s_helperText_documentsTheScopedSignatureTheDashFlagFormAndTheCap', (skill) => {
    const text = read(skill);

    expect(text).toContain('`--flag=value`');
    expect(text).toContain('2000 characters');
    expect(text).toContain('within the last hour');
  });
});

describe('A-6 --skill needs a SKILL.md', () => {
  it('add_skillDirectoryWithoutSkillMd_exitsTwoUnknownSkillAndWritesNothing', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.agents/skills/notaskill-no-skillmd'));
    const before = snapshot(root);

    const res = add(root, { skill: 'notaskill-no-skillmd' });

    expect(res.exitCode).toBe(2);
    expect(res.errors.map((e) => e.rule)).toEqual(['unknown-skill']);
    expect(snapshot(root)).toEqual(before);
    expect(hasLog(root)).toBe(false);
  });

  it('add_skillMdIsADirectory_exitsTwoUnknownSkill', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.agents/skills/odd/SKILL.md'), { recursive: true });

    const res = add(root, { skill: 'odd' });

    expect(res.errors.map((e) => e.rule)).toEqual(['unknown-skill']);
  });

  it('add_skillDirectoryWithSkillMd_isAccepted', () => {
    const root = mkRoot();

    expect(add(root, { skill: 'run-todo' }).exitCode).toBe(0);
  });
});

describe('A-7 values starting with -- and the cell cap', () => {
  const REST = ['add', '--skill', 'qa-engineer', '--step', '8c', '--agent', 'general-purpose', '--fix', 'fixed'];
  const firstIssue = (root) => {
    const date = fs.readdirSync(path.join(root, LOG_DIR))[0].replace(/\.md$/, '');
    return rowCells(dataRows(readLog(root, date))[0])[6];
  };

  it('cli_flagEqualsValueWithLeadingDoubleDash_isTakenVerbatim', () => {
    const root = mkRoot();

    const r = cli(root, [...REST, '--issue=--force push was refused']);

    expect(r.status).toBe(0);
    expect(firstIssue(root)).toBe('--force push was refused');
  });

  it('cli_flagEqualsValueContainingEquals_keepsEverythingAfterTheFirstEquals', () => {
    const root = mkRoot();

    const r = cli(root, [...REST, '--issue=a=b=c']);

    expect(r.status).toBe(0);
    expect(firstIssue(root)).toBe('a=b=c');
  });

  it('cli_separateValueWithLeadingDoubleDash_isRefusedWithAHintToUseTheEqualsForm', () => {
    const root = mkRoot();
    const before = snapshot(root);

    const r = cli(root, [...REST, '--issue', '--force push']);

    expect(r.status).toBe(2);
    expect(r.json.errors[0].message).toContain('--issue=<value>');
    expect(snapshot(root)).toEqual(before);
  });

  it('cli_emptyEqualsValue_isRefusedAsABlankIssue', () => {
    const root = mkRoot();

    const r = cli(root, [...REST, '--issue=']);

    expect(r.status).toBe(2);
    expect(r.json.errors.map((e) => e.rule)).toEqual(['invalid-args']);
  });

  it('cli_duplicateFlagAcrossFormsAndUnknownEqualsFlag_exitTwo', () => {
    const root = mkRoot();

    expect(cli(root, [...REST, '--issue=a', '--issue', 'b']).status).toBe(2);
    expect(cli(root, [...REST, '--issue=a', '--bogus=x']).status).toBe(2);
  });

  it('add_issueLongerThanTheCap_isCutToTwoThousandCharsEndingWithTheMarker', () => {
    const root = mkRoot();

    const res = add(root, { issue: 'x'.repeat(100000), fix: 'y'.repeat(2000) });

    expect(res.exitCode).toBe(0);
    const cells = rowCells(dataRows(readLog(root))[0]);
    expect(cells).toHaveLength(8);
    expect(cells[6]).toHaveLength(2000);
    expect(cells[6].endsWith(' …[truncated]')).toBe(true);
    expect(cells[7]).toBe('y'.repeat(2000));
  });

  it('add_issueOfExactlyTheCap_isNotTruncated', () => {
    const root = mkRoot();

    add(root, { issue: 'z'.repeat(2000) });

    expect(rowCells(dataRows(readLog(root))[0])[6]).toBe('z'.repeat(2000));
  });

  it('add_cutLandingInsideASurrogatePair_dropsTheHalfPair', () => {
    const root = mkRoot();
    const marker = ' …[truncated]';
    const issue = 'a'.repeat(2000 - marker.length - 1) + '😀' + 'b'.repeat(50);

    add(root, { issue });

    const cell = rowCells(dataRows(readLog(root))[0])[6];
    expect(cell).toBe('a'.repeat(2000 - marker.length - 1) + marker);
    expect(Buffer.from(cell, 'utf8').toString('utf8')).toBe(cell);
  });
});

describe('A-8 the temp file name cannot collide with a crashed run', () => {
  it('add_leftoverTempFileNamedWithThisPid_doesNotBlockTheWrite', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, LOG_DIR), { recursive: true });
    const leftover = path.join(root, LOG_DIR, `.${DATE}.md.${process.pid}.tmp`);
    fs.writeFileSync(leftover, 'crashed run\n');

    const res = add(root);

    expect(res.exitCode).toBe(0);
    expect(dataRows(readLog(root))).toEqual([expectedRow()]);
    expect(fs.readFileSync(leftover, 'utf8')).toBe('crashed run\n');
    expect(fs.readdirSync(path.join(root, LOG_DIR)).filter((f) => f.endsWith('.tmp'))).toEqual([path.basename(leftover)]);
  });
});
