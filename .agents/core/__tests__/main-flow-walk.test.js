// T1: one scripted walk of the software-factory main flow, through the real helper CLIs, in a temp git repo.
//
// The per-helper suites pin each seam; this file chains them in the order /run-todo drives them, so a break between
// two helpers (a field one writes and the next does not read, a verdict the workflow's next step cannot act on) fails
// here and not in the first real run. Nothing about a judge is mocked: every step spawns the real script from this
// checkout with CLAUDE_PROJECT_DIR pointing at the temp repo.
//
//   run-record start -> wave -> ac-verify red -> freeze -> (implement) -> gate.js test -> ac-verify run
//   -> ship-check seal -> commit.js --ship-check -> story-checkpoint check -> run-record finish
//
// The gate runs a ten-line runner that prints a vitest-style summary (the gate cannot parse `node --test` output; that
// is existing gate behaviour, not part of this flow).
//
// Post-fix contract. Two assertions cross behaviour that packages E and B of the software-factory ship-gate fix set
// change; they are written against the fixed contract and use expect.soft, so the rest of the walk still runs when
// they fail:
//   * package E: `ac-verify red` is `red` (exit 0) when the test fails only because it imports a module that the
//     story's Files list marks as created and that does not exist yet.
//   * package B: a passing `commit.js --ship-check` adds a `Ship-Check: <first 12 hex of the seal's codeHash>` trailer,
//     and `run-record finish --ship-token OK` requires that trailer on the `--commit` commit.
//
// NOT COVERED: the --ship-token SKIP path (ship-check.test.js and commit.test.js cover the audited skip), Windows (the
// gate and the allowlisted `node` binding are POSIX-tested here), and worktree-isolated runs (SF-2.6 is workflow text).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('./_helpers/git-fixture');

const CORE = path.resolve(__dirname, '..');
const script = (name) => path.join(CORE, name);

const RUN_ID = '261118-0000-run-todo-walk';
const SESSION = 'walk-session-1';
const TODO_REL = 'docs/TODO_walk.md';
const PLAN_REL = `docs/.output/plans/${RUN_ID}.md`;
const MODULE_REL = 'src/m.js';
const TEST_REL = 'tests/m.test.js';
const STORY = 'W-1.1';
const TELEMETRY = 'docs/.output/.state/telemetry';

// The env a spawned CLI sees: vitest, CI and git markers would change a judge's behaviour, so they are dropped.
const DROPPED = new Set(['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'AC_VERIFY_TIMEOUT_MS', 'AGENTS_RUNTIME', 'CI', 'CLAUDE_CODE_SESSION_ID']);
function cleanEnv(root) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (DROPPED.has(k) || k === 'VITEST' || k.startsWith('VITEST_') || k.startsWith('GIT_')) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_PROJECT_DIR: root, CLAUDE_CODE_SESSION_ID: SESSION };
}

/** One helper CLI in the temp repo: { status, out (stdout + stderr), json (the stdout document, when it is one) }. */
function run(root, name, args) {
  const r = spawnSync(process.execPath, [script(name), ...args], { cwd: root, env: cleanEnv(root), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* a verb that prints text */ }
  return { status: r.status, out, stdout: r.stdout || '', json };
}

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();

const TODO = [
  '# TODO: walk fixture',
  '',
  '## Story Index',
  '',
  '| Story | Title | Size | Complexity | Release | Tier | Wave | Status | Dependencies |',
  '|-------|-------|------|-----------|---------|------|------|--------|--------------|',
  `| ${STORY} | Adds add | S | 1 | core | standard | 1 | [ ] | None |`,
  '',
  `* [ ] **Story ${STORY} (S): Adds add**`,
  '  * **As a** user, **I want** add, **So that** sums work.',
  '  * **AC:**',
  `    * [ ] add(1, 2) is 3. verify: node ${TEST_REL}`,
  '    * [ ] A manual criterion with no binding',
  '  * **Estimate:** S',
  '  * **Complexity:** 1',
  '  * **Release:** core',
  '  * **Risk tier:** standard',
  '  * **Dependencies:** None',
  '  * **Files:**',
  `    * \`${MODULE_REL}\` (new) - the add function`,
  `    * \`${TEST_REL}\` - its test`,
  '',
].join('\n');

const TEST_SRC = [
  "const assert = require('node:assert');",
  "const { add } = require('../src/m.js');",
  'assert.strictEqual(add(1, 2), 3);',
  '',
].join('\n');

// The gate's test leg: runs the story test and prints the summary lines the gate parses.
const RUNNER = [
  "const { spawnSync } = require('node:child_process');",
  "const r = spawnSync(process.execPath, ['tests/m.test.js'], { stdio: 'inherit' });",
  "const ok = r.status === 0;",
  "console.log(' Test Files  ' + (ok ? '1 passed (1)' : '1 failed (1)'));",
  "console.log('      Tests  ' + (ok ? '1 passed (1)' : '1 failed (1)'));",
  'process.exit(ok ? 0 : 1);',
  '',
].join('\n');

const GATE_CONFIG = JSON.stringify({
  build: { command: 'node -e "process.exit(0)"', timeout: 60000 },
  test: { command: 'node runner.js', timeout: 120000 },
  receipts: { maxAgeHours: 24 },
});

const PLAN_HEAD = [
  '# Plan: walk fixture',
  '',
  '**Budget:** attempts=3 gate-failures=6 dispatches=40 minutes=240',
  '',
  '### Wave 1 (2026-11-18)',
  `- **Stories:** ${STORY}`,
  '- **Commit:** {pending}',
  '',
].join('\n');

const REVIEW = [
  '**Review — Wave 1**',
  '- Reviewed: code-reviewer read the diff',
  '- Fixed now: none needed',
  '- Deferred: none',
  '- Skipped or light: none',
  '- Risk call: none',
  '',
].join('\n');

describe('main-flow walk: run-record -> red -> freeze -> gate -> run -> seal -> commit -> checkpoint -> finish', () => {
  it.skipIf(!gitAvailable())('chains the real helper CLIs end to end in a temp repo', () => {
    const tmp = createTmpDir({ prefix: 'main-flow-walk-' });
    try {
      const root = fs.realpathSync(createGitRepo({ root: tmp.root }).repoPath);
      const write = (rel, content) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      };
      const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
      const readJson = (rel) => JSON.parse(read(rel));

      // ── fixture: committed gate config (receipt mode), the story, its test (module not written yet), the plan ──
      write('.gitignore', 'docs/.output/.state/\nnode_modules\n');
      write('.claude/gate.config.json', GATE_CONFIG);
      write('runner.js', RUNNER);
      write(TEST_REL, TEST_SRC);
      write(TODO_REL, TODO);
      write(PLAN_REL, PLAN_HEAD);
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'init', '--no-verify');

      // ── run-record start, wave ─────────────────────────────────────────────────────────────────────────────
      const start = run(root, 'run-record.js', ['start', '--command', 'run-todo', '--input', TODO_REL, '--run-id', RUN_ID, '--budget', 'attempts=3 gate-failures=6 dispatches=40 minutes=240']);
      expect(start.status, start.out).toBe(0);
      expect(start.json.run_id).toBe(RUN_ID);
      const wave = run(root, 'run-record.js', ['wave', '--wave', '1', '--story', STORY, '--plan', PLAN_REL]);
      expect(wave.status, wave.out).toBe(0);
      const pointer = JSON.parse(run(root, 'run-record.js', ['current']).stdout);
      expect(pointer).toMatchObject({ run_id: RUN_ID, plan: PLAN_REL, wave: 1, story: STORY });

      // ── ac-verify red: the test fails before the module exists ─────────────────────────────────────────────
      const stories = ['--todo', path.join(root, TODO_REL), '--stories', STORY];
      const red = run(root, 'ac-verify.js', ['red', ...stories]);
      // package E: a test that imports a module the story creates is a real red, not `infra: Cannot find module`.
      expect.soft(red.status, red.out).toBe(0);
      expect.soft(red.json?.stories?.[0]?.results?.[0]?.verdict, red.out).toBe('red');

      // ── freeze the check files and the verify: lines ───────────────────────────────────────────────────────
      const freeze = run(root, 'ac-verify.js', ['freeze', ...stories]);
      expect(freeze.status, freeze.out).toBe(0);
      expect(fs.existsSync(path.join(root, TELEMETRY, 'ac-verify', `${STORY}.freeze.json`))).toBe(true);
      expect(run(root, 'ac-verify.js', ['check', ...stories]).status).toBe(0);

      // ── implement, then the gate ───────────────────────────────────────────────────────────────────────────
      write(MODULE_REL, 'module.exports = { add: (a, b) => a + b };\n');
      const gate = run(root, 'gate.js', ['test']);
      expect(gate.status, gate.out).toBe(0);
      const receipt = readJson(`${TELEMETRY}/gate-receipt.json`);
      expect(receipt.status).toBe('passed');
      expect(typeof receipt.id).toBe('string');
      expect(receipt.codeHash).toMatch(/^[0-9a-f]{64}$/);

      // The story is done: tick it and its criteria (the freeze hashes verify: bindings, never checkbox state).
      write(TODO_REL, TODO.replace(/\[ \]/g, '[x]'));
      expect(run(root, 'ac-verify.js', ['check', ...stories]).status, 'ticking boxes is not tampering').toBe(0);

      // ── ac-verify run: records the binding, keyed to the same code hash as the gate receipt ────────────────
      const acRun = run(root, 'ac-verify.js', ['run', ...stories]);
      expect(acRun.status, acRun.out).toBe(0);
      const records = readJson(`${TELEMETRY}/ac-verify/${STORY}.json`);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ status: 'ran', exit: 0, expectedExit: 0, met: true, codeHash: receipt.codeHash });

      // ── ship-check seal ────────────────────────────────────────────────────────────────────────────────────
      const seal = run(root, 'ship-check.js', ['seal', '--todo', path.join(root, TODO_REL), '--stories', STORY]);
      expect(seal.status, seal.out).toBe(0);
      const sealed = readJson(`${TELEMETRY}/ship-seal.json`);
      expect(sealed).toMatchObject({ mode: 'receipt', receiptId: receipt.id, codeHash: receipt.codeHash, head: git(root, 'rev-parse', 'HEAD') });

      // The wave's doc edits after the seal: the review entry and the story checkpoint line (neither moves the code hash).
      const hash = run(root, 'story-checkpoint.js', ['hash', path.join(root, TODO_REL), STORY]);
      expect(hash.status, hash.out).toBe(0);
      const checkpoint = `${STORY}=${hash.stdout.trim().slice(0, 12)}@${receipt.id}`;
      write(PLAN_REL, `${PLAN_HEAD}- **Story checkpoints:** ${checkpoint}\n\n${REVIEW}`);

      // ── commit.js --ship-check ─────────────────────────────────────────────────────────────────────────────
      const msg = path.join(root, 'docs/.output/.state/.commit-msg');
      fs.mkdirSync(path.dirname(msg), { recursive: true });
      fs.writeFileSync(msg, 'feat: wave 1 walk\n');
      const before = Number(git(root, 'rev-list', '--count', 'HEAD'));
      const commit = spawnSync(process.execPath, [script('commit.js'), '--file', msg, '--ship-check', '--sc-kind', 'wave', '--sc-plan', PLAN_REL, '--sc-wave', '1', '--sc-todo', TODO_REL, '--sc-stories', STORY, '--paths', MODULE_REL, TODO_REL, PLAN_REL],
        { cwd: root, env: cleanEnv(root), encoding: 'utf8', windowsHide: true, timeout: 60000 });
      expect(commit.status, `${commit.stdout}${commit.stderr}`).toBe(0);
      expect(commit.stdout).toMatch(/ship check passed/);
      expect(Number(git(root, 'rev-list', '--count', 'HEAD'))).toBe(before + 1);
      const shipped = git(root, 'rev-parse', 'HEAD');
      // package B: the passing check leaves a Ship-Check trailer, the first 12 hex of the sealed code hash.
      expect.soft(git(root, 'log', '-1', '--format=%(trailers:key=Ship-Check,valueonly)').trim()).toBe(sealed.codeHash.slice(0, 12));

      // ── story-checkpoint: unchanged inputs skip; an edited input is stale green ────────────────────────────
      const skip = run(root, 'story-checkpoint.js', ['check', path.join(root, TODO_REL), STORY, '--plan', path.join(root, PLAN_REL)]);
      expect(skip.status, skip.out).toBe(0);
      expect(skip.json).toMatchObject({ id: STORY, decision: 'skip', code: 'UNCHANGED' });
      write(MODULE_REL, 'module.exports = { add: (a, b) => b + a };\n');
      const stale = run(root, 'story-checkpoint.js', ['check', path.join(root, TODO_REL), STORY, '--plan', path.join(root, PLAN_REL)]);
      expect(stale.status, stale.out).toBe(1);
      expect(stale.json).toMatchObject({ id: STORY, decision: 'rerun', code: 'STALE_GREEN' });
      write(MODULE_REL, 'module.exports = { add: (a, b) => a + b };\n');
      expect(git(root, 'status', '--porcelain', '--', MODULE_REL), 'the edit was put back').toBe('');

      // ── run-record finish ──────────────────────────────────────────────────────────────────────────────────
      // package B: --ship-token OK needs the trailer on the commit, so the parent commit (no trailer) is refused.
      const parent = git(root, 'rev-parse', 'HEAD~1');
      const untrailed = run(root, 'run-record.js', ['finish', '--status', 'passed', '--commit', parent, '--receipt', receipt.id, '--ship-token', 'OK', '--plan', PLAN_REL, '--run-id', RUN_ID]);
      expect.soft(untrailed.status, untrailed.out).toBe(2);
      const finish = run(root, 'run-record.js', ['finish', '--status', 'passed', '--commit', shipped, '--receipt', receipt.id, '--ship-token', 'OK', '--plan', PLAN_REL, '--run-id', RUN_ID]);
      expect(finish.status, finish.out).toBe(0);
      expect(finish.json).toMatchObject({ run_id: RUN_ID, status: 'passed', record: { commit: shipped, receipt: receipt.id, ship_token: 'OK' } });
      expect(readJson(`${TELEMETRY}/runs/${RUN_ID}.json`)).toMatchObject({ run_id: RUN_ID, waves: [{ wave: 1, story: STORY }], result: { status: 'passed', exit_code: 0, commit: shipped, receipt: receipt.id, ship_token: 'OK' } });
      expect(read(PLAN_REL).split('\n').filter((l) => l.startsWith('**Run record:**'))).toHaveLength(1);
      expect(run(root, 'run-record.js', ['current']).stdout.trim(), 'the pointer is dropped at finish').toBe('null');
    } finally {
      tmp.cleanup();
    }
  }, 60000);
});
