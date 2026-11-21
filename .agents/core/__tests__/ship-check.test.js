// SF-1.3: tests for `.agents/core/ship-check.js` (`seal` and `verify`): the judge that decides whether a wave may be
// committed, and the one place that carries an audited bypass (`--skip`).
//
// PINNED CONTRACT. The implementer must match these names, signatures and shapes; the tests are the spec.
//
// Exports (CommonJS; the CLI is guarded by `require.main === module`, so requiring the file never exits):
//   seal(opts)    -> result     write the ship seal (after running ac-verify itself)
//   verify(opts)  -> result     judge a wave or task against its seal
//   main(argv = process.argv.slice(2)) -> exit code number; prints exactly ONE JSON document (the result) to stdout
//   opts = { root (absolute), kind, plan, wave, todo, stories: string[], docs: string[], skip, env = process.env }
//     `todo` and `plan` are paths (absolute, or relative to `root` in-process; relative to the cwd on the CLI).
//   Neither export ever throws: any exception (even a hostile `opts`) becomes { ok:false, exitCode: 2, errors:[{rule:'exception'}] }.
//
// CLI (the repository root is the working directory's repo root, `CLAUDE_PROJECT_DIR` when set):
//   ship-check.js seal   [--docs a,b] [--todo T --stories A,B]
//   ship-check.js verify --kind wave|task [--plan P] [--wave N] [--todo T] [--stories A,B] [--skip "<reason>"]
//   Every flag takes a value, appears at most once, and an unknown flag or verb is exit 2. `--todo` and `--stories`
//   come together or not at all. `--kind wave` requires --plan, --wave (a positive integer), --todo and --stories.
//   `--kind task` requires none of them (ad-hoc /do), but never `--stories` without `--todo`.
//
// Result (stdout JSON, success and failure alike):
//   { ok, exitCode, errors: [{ rule, message, fix }], warnings: [], notices: [{ rule, message }],
//     skipped: [{ rule, message, reason? }], stories: [{ id, bindings, manual, status }], mode?, seal? }
//   exitCode: 0 ok; 1 refused (a check failed); 2 invalid input or an internal error. ok === (exitCode === 0).
//   stderr: for each error one line `[ship-check] refusing: {message}. Fix: {fix}` (the shape pull-request.js uses).
//   Both verbs COLLECT every failing condition (no short-circuit), so one reason can be asserted in isolation. The two
//   exceptions: a malformed gate config stops everything with rule `config` (nothing can be judged), and a missing or
//   malformed seal reports `no-seal` / `bad-seal` and skips the other seal-based comparisons (there is nothing to compare
//   against) while the completion check and the review entry are still evaluated.
//   `stories[].status` is ac-verify's report status: 'passed' | 'failed' | 'no-bindings'.
//
// Seal file: docs/.output/.state/telemetry/ship-seal.json, EXACTLY the keys
//   { head, receiptId|null, mode ('receipt'|'summary'), codeHash, recordsHash, docs: string[], sealedAt (ISO-8601) }
//   head = git HEAD; codeHash = codeTreeHash(root); recordsHash = 64-hex sha256 over the selected stories' record files;
//   docs = the `--docs` paths, repo-relative with forward slashes ([] when none); receiptId = the gate receipt's `id`.
//   `result.seal` equals the file's content. A refused seal leaves NO seal file (an existing one is removed).
//
// Mode (the gate config is `.claude/gate.config.json`): `receipt` when the config has a `receipts` object (the
// condition gate.js uses to activate receipts) or `shipCheck.requireReceipt === true`; otherwise `summary`.
//   receipt: gr.verifyReceiptForRoot must be ok. summary: `_latest-summary.json` has overall === true, no `killed`,
//   and its file mtime is newer than the mtime of the newest tracked file outside docs/ (a docs/**.md change never counts).
//   A malformed gate config (unparseable JSON, or not an object) refuses seal AND verify with rule `config`: the mode
//   and the `enabled` switch are unknowable, so neither downgrade nor bypass is allowed by breaking the file.
//   Only the boolean `false` disables the check (`enabled: 'false'`, `0`, or a non-object `shipCheck` leave it on).
//
// Rule names (errors[].rule):
//   seal:   receipt | summary | docs-path | ac-run | ac-check | config | invalid-args | exception
//   verify: no-seal | bad-seal | head-mismatch | code-drift | records-drift | record-missing | record-refused |
//           record-timeout | record-tree-changed | record-unmet | record-stale | ac-check | completion | review |
//           receipt | config | invalid-args | exception
//   notices/skipped rules: disabled (shipCheck.enabled false) | no-todo (task kind without --todo) | skip (--skip honoured)
//   `seal` runs `ac-verify run` (exit != 0 -> rule ac-run) and `ac-verify check` (exit != 0 -> rule ac-check) ITSELF and
//   seals the records it just produced; `verify` re-runs `ac-verify check` only (never `run`).
//   `verify` does NOT call verifyReceiptForRoot (the wave's doc edits move the full-tree receipt hash): in receipt mode
//   it requires that a receipt exists and that its `id` equals seal.receiptId (rule `receipt`).
//
// Review entry (rule `review`): the plan holds a line `**Review — Wave N**` (em dash, en dash or hyphen) followed
// directly by five bullets (`- Label: text`), each with non-empty text. N is matched exactly (Wave 10 is not Wave 1).
//
// Skip: `--skip "<reason>"` bypasses the SEAL-based conditions (seal, head, code, records, ac-check, receipt). The
// completion check and the review entry are still required. An honoured skip records ONE guardrail event, written the
// way commit.js records a scan bypass (emitGuardrailHit): docs/.output/.state/telemetry/guardrail-events.jsonl line
// { event:'guardrail', decision:'bypass', rule:'ship-check-skip', source:'ship-check' }, and lists the reason in `skipped`.
//
// Pinned beyond the AC text (security-conservative, flagged for the reviewer):
//   * a skip whose bypass event cannot be written is REFUSED (commit.js's scan bypass is best effort; this one is
//     the judge, and "no bypass is silent");
//   * `verify` recomputes `met` from exit === expectedExit and never trusts a record's own `met`;
//   * a review that sits inside a code fence, or whose bullets are unfilled `{...}` placeholders, does not count;
//   * `--docs` and `--plan` outside the repository (lexically or through a symlink) are refused, before anything runs;
//   * a symlinked ship-seal.json is never written through.
//
// SF-1.3 review fixes (docs/.output/findings/reviews/261118-1228-software-factory-wave3-{security,review}.md), one describe
// per finding id near the end of this file: the receipt is the DEFAULT evidence (summary mode only when the COMMITTED gate
// config sets shipCheck.requireReceipt:false), the seal also holds { gateCodeHash, todo }, `enabled:false` is an audited
// bypass read from the committed config, the skip event is written against the repo root with its reason, and verify
// refuses `unstaged-code` (index differs from the working tree). The pinned text above predates them.
//
// NOT COVERED (reported to the owner): the toolkit's own gate config setting receipts on (the toolkit tracks no
// `.claude/gate.config.json`, and it is not in the story's Files list); `--kind task` without `--todo` cannot run
// `ac-verify check` (it needs a TODO), so "freeze checks still apply" is only covered through the code hash; a skip
// that also fails completion (no event asserted); the reason is not persisted by emitGuardrailHit (only the stdout
// `skipped` entry carries it); `test.projects` configs as a receipts trigger; extraExclude config for the code hash;
// Windows (symlink cases are skipped there); two concurrent seals.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve('.agents/core/ship-check.js');
const gr = require('../_lib/gate-receipt');
const { writeSummary } = require('../_lib/gate-summary');
const subject = () => require('../ship-check');

vi.setConfig({ testTimeout: 120000 });

const isWindows = process.platform === 'win32';
const HEX64 = /^[0-9a-f]{64}$/;
const RECORD_DIR = 'docs/.output/.state/telemetry/ac-verify';
const SEAL_REL = 'docs/.output/.state/telemetry/ship-seal.json';
const EVENTS_REL = 'docs/.output/.state/telemetry/guardrail-events.jsonl';
const PLAN_REL = 'docs/.output/plans/261118-0000-run-todo-fixture.md';
const A_TEST = 'src/__tests__/a.test.js';
const IMPL = 'src/impl.js';
const RECEIPT_ID = 'abc123def456';
const SEAL_KEYS = ['codeHash', 'docs', 'gateCodeHash', 'head', 'mode', 'receiptId', 'recordsHash', 'sealedAt', 'stories', 'todo'];
// Summary mode is selected only by the COMMITTED gate config (SF-1.3 review M3/security M3): receipts are the default.
const SUMMARY_CONFIG = { shipCheck: { requireReceipt: false } };

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

// ── fixtures ────────────────────────────────────────────────────────

const SCRIPTS = {
  'ok.js': "console.log('ok');\n",
  'exit.js': 'process.exit(Number(process.argv[2]));\n',
  'mark.js': "require('fs').writeFileSync('MARKER', 'ran');\n",
  'sleep.js': 'setTimeout(() => {}, 60000);\n',
  // Leaves a trace line in the ignored state zone (never in the code hash) each time it actually runs.
  'trace.js': "const fs = require('fs'); fs.mkdirSync('docs/.output/.state', { recursive: true }); fs.appendFileSync('docs/.output/.state/trace.log', 'ran\\n');\n",
  [A_TEST]: 'expect(1).toBe(1);\n',
  [IMPL]: 'module.exports = 1;\n',
  'docs/notes.md': 'notes\n',
};

const RECEIPT_CONFIG = { receipts: { maxAgeHours: 24 } };
const DEFAULT_STORIES = {
  'T-1.1': { criteria: ['Adds the thing. verify: node ok.js', 'A manual criterion with no binding'], files: [A_TEST, IMPL] },
};

/** TODO text: every story and criterion is complete ([x]); `criteria` are bullet texts without the box. */
function todoText(stories, { done = true } = {}) {
  const box = done ? 'x' : ' ';
  const parts = ['# TODO: ship fixture\n'];
  for (const [id, story] of Object.entries(stories)) {
    const bullets = story.criteria.map((c) => `    * [${box}] ${c}\n`).join('');
    const files = story.files.map((f) => `    * \`${f}\` — fixture file\n`).join('');
    parts.push(`* [${box}] **Story ${id} (S): Title ${id}**\n  * **AC:**\n${bullets}  * **Files:**\n${files}  * **Estimate:** S\n`);
  }
  return parts.join('\n');
}

const REVIEW_BULLETS = ['Reviewed: code-reviewer read the diff', 'Fixed now: none needed', 'Deferred: none', 'Skipped or light: none', 'Risk call: none'];
function reviewBlock(wave = 1, { dash = '—', bullets = REVIEW_BULLETS } = {}) {
  return `**Review ${dash} Wave ${wave}**\n${bullets.map((b) => `- ${b}`).join('\n')}\n`;
}
const PLAN_HEAD = '# Plan: fixture run\n\n### Wave 1 (2026-11-18)\n- **Stories:** T-1.1\n- **Commit:** {pending}\n\n';
const PLAN_NO_REVIEW = PLAN_HEAD;
const PLAN_WITH_REVIEW = `${PLAN_HEAD}${reviewBlock(1)}`;

function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim(); }

const STRIPPED_ENV = new Set(['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'AC_VERIFY_TIMEOUT_MS', 'AGENTS_RUNTIME', 'CI']);
function childEnv(root, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIPPED_ENV.has(k) || k === 'VITEST' || k.startsWith('VITEST_')) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_PROJECT_DIR: root, ...extra };
}

/** Run the real CLI. It must print exactly one JSON document, so a missing script fails here, not silently. */
function cli(root, args, { env = {}, cwd = root } = {}) {
  expect(fs.existsSync(SCRIPT), 'ship-check.js must exist at .agents/core/ship-check.js').toBe(true);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: childEnv(root, env), encoding: 'utf8', windowsHide: true, timeout: 120000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
  expect(json, `stdout must be exactly one JSON document (status ${r.status}, stderr: ${r.stderr})`).not.toBeNull();
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const rules = (out) => [...new Set(out.json.errors.map((e) => e.rule))].sort();

/** A fresh repo holding the fixture files, one commit, and (optionally) the freeze baseline and gate evidence. */
function shipRepo({ stories = DEFAULT_STORIES, config = RECEIPT_CONFIG, evidence = 'receipt', freeze = true, plan = PLAN_NO_REVIEW, extra = {}, prep } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-check-')));
  roots.push(root);
  const write = (rel, content) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write('.gitignore', 'docs/.output/.state/\nnode_modules\n');
  for (const [rel, content] of Object.entries({ ...SCRIPTS, ...extra })) write(rel, content);
  if (config !== null) write('.claude/gate.config.json', typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  const todoPath = write('docs/TODO_fixture.md', todoText(stories));
  const planPath = write(PLAN_REL, plan);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const repo = {
    root, write, todoPath, planPath, ids: Object.keys(stories),
    git: (...args) => git(root, ...args),
    head: () => git(root, 'rev-parse', 'HEAD'),
    sealFile: path.join(root, SEAL_REL),
    seal: () => JSON.parse(fs.readFileSync(path.join(root, SEAL_REL), 'utf8')),
    recordFile: (id) => path.join(root, RECORD_DIR, `${id}.json`),
    records: (id) => JSON.parse(fs.readFileSync(path.join(root, RECORD_DIR, `${id}.json`), 'utf8')),
    traceLines: () => {
      const file = path.join(root, 'docs/.output/.state/trace.log');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
    },
    events: () => {
      const file = path.join(root, EVENTS_REL);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
  if (prep) prep(repo);
  if (freeze) {
    const out = spawnSync(process.execPath, [path.resolve('.agents/core/ac-verify.js'), 'freeze', '--todo', todoPath, '--stories', repo.ids.join(',')], {
      cwd: root, env: childEnv(root), encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    if (out.status !== 0) throw new Error(`fixture: ac-verify freeze (SF-1.2) must succeed first: ${out.stdout}${out.stderr}`);
  }
  if (evidence === 'receipt') writeGateReceipt(repo);
  else if (evidence === 'summary') writeGateSummary(repo);
  return repo;
}

/** A passing receipt for the tree exactly as it is now (hand-written; the control test proves the real judge accepts it). */
function writeGateReceipt(repo, over = {}) {
  const snap = gr.treeSnapshot(repo.root);
  if (!snap.ok) throw new Error(`fixture: tree hash unavailable: ${snap.reason}`);
  gr.writeReceipt(repo.root, {
    schema: gr.RECEIPT_SCHEMA, id: RECEIPT_ID, status: 'passed', exitCode: 0, mode: 'normal', changedOnly: false,
    head: gr.headSha(repo.root), treeHashStart: snap.hash, treeHashEnd: snap.hash, engine: gr.engineIdentity(repo.root),
    configHash: gr.readGateConfigFile(repo.root).hash, build: { status: 'passed' }, projects: [],
    test: { status: 'passed', passed: 1, failed: 0, skipped: 0, total: 1 }, codeHash: gr.codeTreeHash(repo.root).hash, ...over,
  });
}

/** `_latest-summary.json` with a file mtime `ageMs` in the past; every tracked file outside docs/ is aged `codeAgeMs`. */
function writeGateSummary(repo, { ageMs = 0, codeAgeMs = 600000, over = {} } = {}) {
  const now = Date.now();
  for (const rel of git(repo.root, 'ls-files').split('\n').filter((f) => f && !f.startsWith('docs/'))) {
    const t = new Date(now - codeAgeMs);
    fs.utimesSync(path.join(repo.root, rel), t, t);
  }
  writeSummary(repo.root, { timestamp: new Date(now - ageMs).toISOString(), mode: 'TEST ONLY', stack: 'node', overall: true, build: { succeeded: true },
    test: { succeeded: true, passed: 1, failed: 0, skipped: 0, total: 1, zeroCollected: false, timedOut: false }, ...over });
  const summaryFile = path.join(repo.root, 'docs/.output/.state/telemetry/_latest-summary.json');
  const t = new Date(now - ageMs);
  fs.utimesSync(summaryFile, t, t);
}

const sealArgs = (repo, { docs, ids = repo.ids, todo = true } = {}) => [
  'seal', ...(docs === undefined ? [] : ['--docs', docs]), ...(todo ? ['--todo', repo.todoPath, '--stories', ids.join(',')] : []),
];
const sealCli = (repo, options = {}) => cli(repo.root, sealArgs(repo, options), { env: options.env });
function sealOk(repo, options) {
  const out = sealCli(repo, options);
  expect(out.status, `fixture seal must succeed: ${out.stdout}${out.stderr}`).toBe(0);
  return out;
}

function verifyArgs(repo, { kind = 'wave', wave = 1, ids = repo.ids, plan = repo.planPath, todo = repo.todoPath, skip } = {}) {
  return ['verify', '--kind', kind,
    ...(plan === null ? [] : ['--plan', plan]), ...(wave === null ? [] : ['--wave', String(wave)]),
    ...(todo === null ? [] : ['--todo', todo, '--stories', ids.join(',')]),
    ...(skip === undefined ? [] : ['--skip', skip])];
}
const verifyCli = (repo, options = {}) => cli(repo.root, verifyArgs(repo, options), { env: options.env });

/** The standard sealed fixture: gate evidence, freeze, seal, and then the review entry the wave writes after sealing. */
function sealedRepo(options = {}) {
  const repo = shipRepo(options);
  sealOk(repo);
  repo.write(PLAN_REL, PLAN_WITH_REVIEW);
  return repo;
}

const editRecords = (repo, id, fn) => {
  const records = repo.records(id);
  fn(records);
  fs.writeFileSync(repo.recordFile(id), `${JSON.stringify(records, null, 2)}\n`);
};
const expectFixLines = (out) => {
  expect(out.stderr).toContain('[ship-check] refusing');
  for (const e of out.json.errors) {
    expect(typeof e.fix, `error ${e.rule} must carry a Fix`).toBe('string');
    expect(e.fix.length).toBeGreaterThan(0);
    expect(out.stderr).toContain(`Fix: ${e.fix}`);
  }
};

// ── module shape ────────────────────────────────────────────────────

describe('module shape', () => {
  it('exports seal, verify and main without running the CLI on require', () => {
    const mod = subject();
    for (const name of ['seal', 'verify', 'main']) expect(typeof mod[name], name).toBe('function');
  });

  it('the fixture receipt is accepted by the real receipt judge (control: a refusal below is ship-check, not the fixture)', () => {
    const repo = shipRepo();

    expect(gr.verifyReceiptForRoot({ root: repo.root }).ok).toBe(true);
  });
});

// ── AC1: seal ───────────────────────────────────────────────────────

describe('seal: receipt mode (AC1)', () => {
  it('writes the seal with exactly the pinned fields, from the current head, code hash and receipt id', () => {
    const repo = shipRepo();

    const out = sealCli(repo, { docs: 'docs/notes.md,docs/TODO_fixture.md' });

    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: true, exitCode: 0, errors: [] });
    const seal = repo.seal();
    expect(Object.keys(seal).sort()).toEqual(SEAL_KEYS);
    expect(seal).toMatchObject({ head: repo.head(), receiptId: RECEIPT_ID, mode: 'receipt', docs: ['docs/notes.md', 'docs/TODO_fixture.md'] });
    // SF-1.3 review (--docs made functional): `codeHash` excludes the --docs paths, `gateCodeHash` is the plain hash
    // the receipt and the records were taken on, and `todo` is the sealed TODO (security m3).
    expect(seal.codeHash).toBe(gr.codeTreeHash(repo.root, { extraExclude: ['docs/notes.md', 'docs/TODO_fixture.md'] }).hash);
    expect(seal.gateCodeHash).toBe(gr.codeTreeHash(repo.root).hash);
    expect(seal.todo).toBe('docs/TODO_fixture.md');
    expect(seal.recordsHash).toMatch(HEX64);
    expect(new Date(seal.sealedAt).toISOString()).toBe(seal.sealedAt);
    expect(out.json.seal).toEqual(seal);
    expect(out.json.mode).toBe('receipt');
  });

  it('defaults docs to an empty list', () => {
    const repo = shipRepo();

    sealOk(repo);

    expect(repo.seal().docs).toEqual([]);
  });

  it.each([
    ['no receipt exists', (repo) => fs.rmSync(path.join(repo.root, 'docs/.output/.state/telemetry/gate-receipt.json'))],
    ['the tree changed after the receipt', (repo) => repo.write('src/late.js', 'late edit\n')],
    ['the receipt is not a pass', (repo) => writeGateReceipt(repo, { status: 'failed', exitCode: 1 })],
    ['the receipt was taken at another head', (repo) => writeGateReceipt(repo, { head: 'a'.repeat(40) })],
  ])('refuses non-zero with a Fix line and writes no seal when %s', (_label, mutate) => {
    const repo = shipRepo();
    mutate(repo);

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(out.json.ok).toBe(false);
    expect(rules(out)).toEqual(['receipt']);
    expect(out.stderr).toMatch(/Fix: .*gate\.js/);
    expectFixLines(out);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it('a missing receipt never falls back to a summary seal, even when a passing summary exists', () => {
    const repo = shipRepo({ evidence: 'summary' });

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it('shipCheck.requireReceipt forces receipt mode even when the config has no receipts block', () => {
    const repo = shipRepo({ config: { shipCheck: { requireReceipt: true } } });

    const out = sealCli(repo);

    expect(out.status).toBe(0);
    expect(repo.seal()).toMatchObject({ mode: 'receipt', receiptId: RECEIPT_ID });
  });

  it('shipCheck.requireReceipt with only a passing summary refuses instead of sealing in summary mode', () => {
    const repo = shipRepo({ config: { shipCheck: { requireReceipt: true } }, evidence: 'summary' });

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });
});

describe('seal: summary mode (AC1)', () => {
  it('seals in summary mode with a null receipt id when the project does not use receipts and the summary is a fresh pass', () => {
    const repo = shipRepo({ config: SUMMARY_CONFIG, evidence: 'summary' });

    const out = sealCli(repo);

    expect(out.status).toBe(0);
    expect(repo.seal()).toMatchObject({ mode: 'summary', receiptId: null });
    expect(Object.keys(repo.seal()).sort()).toEqual(SEAL_KEYS);
  });

  it('a config with unrelated keys and no receipts block is summary mode too', () => {
    const repo = shipRepo({ config: { stack: 'node', ...SUMMARY_CONFIG }, evidence: 'summary' });

    sealOk(repo);

    expect(repo.seal().mode).toBe('summary');
  });

  it('a docs-only change newer than the summary does not make it stale', () => {
    const repo = shipRepo({ config: SUMMARY_CONFIG, evidence: 'summary' });
    const future = new Date(Date.now() + 60000);
    fs.utimesSync(path.join(repo.root, 'docs/notes.md'), future, future);

    expect(sealCli(repo).status).toBe(0);
  });

  it.each([
    ['the summary is missing', (repo) => fs.rmSync(path.join(repo.root, 'docs/.output/.state/telemetry/_latest-summary.json'))],
    ['the summary is malformed JSON', (repo) => fs.writeFileSync(path.join(repo.root, 'docs/.output/.state/telemetry/_latest-summary.json'), '{not json')],
    ['overall is false', (repo) => writeGateSummary(repo, { over: { overall: false } })],
    ['overall is the string "true"', (repo) => writeGateSummary(repo, { over: { overall: 'true' } })],
    ['the run was killed', (repo) => writeGateSummary(repo, { over: { killed: 'SIGTERM' } })],
    ['a tracked non-doc file is newer than the summary', (repo) => {
      const future = new Date(Date.now() + 60000);
      fs.utimesSync(path.join(repo.root, IMPL), future, future);
    }],
  ])('refuses non-zero with a Fix line and writes no seal when %s', (_label, mutate) => {
    const repo = shipRepo({ config: SUMMARY_CONFIG, evidence: 'summary' });
    mutate(repo);

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['summary']);
    expect(out.stderr).toMatch(/Fix: .*gate\.js/);
    expectFixLines(out);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });
});

describe('seal: --docs and gate config validation (AC1, fail closed)', () => {
  const outside = (repo) => path.join(path.dirname(repo.root), 'outside.md');

  it.each([
    ['a parent-directory escape', () => '../outside.md'],
    ['an escape through a nested segment', () => 'docs/../../outside.md'],
    ['an absolute path outside the repository', (repo) => outside(repo)],
    ['one escaping path among valid ones', () => 'docs/notes.md,../outside.md'],
  ])('refuses %s with non-zero, writes no seal and runs no binding', (_label, docsFor) => {
    const repo = shipRepo({ stories: { 'T-1.1': { criteria: ['Traces. verify: node trace.js'], files: [A_TEST, IMPL] } } });

    const out = sealCli(repo, { docs: docsFor(repo) });

    expect(out.status).not.toBe(0);
    expect(rules(out)).toEqual(['docs-path']);
    expectFixLines(out);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
    expect(repo.traceLines()).toBe(0);
  });

  it.skipIf(isWindows)('refuses a --docs path that leaves the repository through a symlink', () => {
    const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-check-linktarget-')));
    roots.push(target);
    const repo = shipRepo({
      prep: (r) => { fs.symlinkSync(target, path.join(r.root, 'linkdir')); r.git('add', 'linkdir'); r.git('commit', '-q', '-m', 'link'); },
    });

    const out = sealCli(repo, { docs: 'linkdir/x.md' });

    expect(out.status).not.toBe(0);
    expect(rules(out)).toEqual(['docs-path']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it.each(['{not json', '[]', '"receipts"'])('a malformed gate config (%s) refuses seal with rule config and writes no seal', (raw) => {
    const repo = shipRepo({ config: raw, evidence: 'summary' });

    const out = sealCli(repo);

    expect(out.status).not.toBe(0);
    expect(rules(out)).toEqual(['config']);
    expectFixLines(out);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });
});

// ── AC8 (m7): seal does not trust records on disk ───────────────────

describe('seal runs ac-verify itself (AC8, wave 1 security m7)', () => {
  const failing = { 'T-1.1': { criteria: ['Needs exit 0 but exits 3. verify: node exit.js 3'], files: [A_TEST, IMPL] } };

  it('a forged met:true record written before the seal does not survive: the real run overwrites it and the seal is refused', () => {
    const repo = shipRepo({ stories: failing });
    const forged = {
      story: 'T-1.1', acLine: 4, command: 'node exit.js 3', expectedExit: 0, exit: 0, met: true, status: 'ran', durationMs: 1,
      outputTail: 'FORGED', codeHash: gr.codeTreeHash(repo.root).hash, head: repo.head(), ranAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(repo.root, RECORD_DIR), { recursive: true });
    fs.writeFileSync(repo.recordFile('T-1.1'), JSON.stringify([forged]));

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['ac-run']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
    const [record] = repo.records('T-1.1');
    expect(record.exit).toBe(3);
    expect(record.met).toBe(false);
    expect(record.outputTail).not.toBe('FORGED');
  });

  it('a forged record for a passing binding is replaced by the genuine one the seal then covers', () => {
    const repo = shipRepo({ stories: { 'T-1.1': { criteria: ['Traces. verify: node trace.js'], files: [A_TEST, IMPL] } } });
    fs.mkdirSync(path.join(repo.root, RECORD_DIR), { recursive: true });
    fs.writeFileSync(repo.recordFile('T-1.1'), JSON.stringify([{
      story: 'T-1.1', acLine: 4, command: 'node trace.js', expectedExit: 0, exit: 0, met: true, status: 'ran', durationMs: 1,
      outputTail: 'FORGED', codeHash: gr.codeTreeHash(repo.root).hash, head: repo.head(), ranAt: '2000-01-01T00:00:00.000Z',
    }]));

    sealOk(repo);

    expect(repo.traceLines()).toBe(1);
    const [record] = repo.records('T-1.1');
    expect(record.outputTail).not.toBe('FORGED');
    expect(record.ranAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(record.codeHash).toBe(repo.seal().codeHash);
  });

  it('seal runs each binding once and verify re-runs only the check, never the bindings', () => {
    const repo = shipRepo({ stories: { 'T-1.1': { criteria: ['Traces. verify: node trace.js'], files: [A_TEST, IMPL] } } });
    sealOk(repo);
    expect(repo.traceLines()).toBe(1);
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo);

    expect(out.status).toBe(0);
    expect(repo.traceLines()).toBe(1);
  });

  it('a frozen check file edited before the seal is caught by the seal itself (ac-verify check), with no seal written', () => {
    const repo = shipRepo({ evidence: 'none' });
    fs.writeFileSync(path.join(repo.root, A_TEST), 'expect(1).toBe(1); // weakened\n');
    writeGateReceipt(repo);

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['ac-check']);
    expectFixLines(out);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it.each([
    ['an unmet exit', { criteria: ['Exits 3. verify: node exit.js 3'], files: [A_TEST, IMPL] }, {}],
    ['a refused command', { criteria: ['Refused head. verify: node -e 1'], files: [A_TEST, IMPL] }, {}],
    ['a command past the time cap', { criteria: ['Sleeps. verify: node sleep.js'], files: [A_TEST, IMPL] }, { AC_VERIFY_TIMEOUT_MS: '1500' }],
    ['a command that changes the tree', { criteria: ['Writes a marker. verify: node mark.js'], files: [A_TEST, IMPL] }, {}],
  ])('a binding that is not met (%s) refuses the seal with rule ac-run and leaves no seal', (_label, story, env) => {
    const repo = shipRepo({ stories: { 'T-1.1': story } });

    const out = sealCli(repo, { env });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['ac-run']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it('a refused seal removes a seal that was valid before it', () => {
    const repo = shipRepo();
    sealOk(repo);
    expect(fs.existsSync(repo.sealFile)).toBe(true);
    fs.rmSync(path.join(repo.root, 'docs/.output/.state/telemetry/gate-receipt.json'));

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it.skipIf(isWindows)('never writes through a symlinked ship-seal.json', () => {
    const repo = shipRepo();
    const victim = path.join(repo.root, 'VICTIM.txt');
    fs.writeFileSync(victim, 'untouched');
    // The victim is untracked, so it must exist before the receipt.
    writeGateReceipt(repo);
    fs.mkdirSync(path.dirname(repo.sealFile), { recursive: true });
    fs.symlinkSync(victim, repo.sealFile);

    sealCli(repo); // refusing, or replacing the link with a regular file: both are safe; writing through it is not

    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    if (fs.existsSync(repo.sealFile)) expect(fs.lstatSync(repo.sealFile).isSymbolicLink()).toBe(false);
  });
});

// ── AC2: verify ─────────────────────────────────────────────────────

describe('verify --kind wave: the passing path (AC2)', () => {
  it('exits 0 for a sealed tree with met records, an untouched freeze, a complete story and a review written after the seal', () => {
    const repo = sealedRepo();

    const out = verifyCli(repo);

    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: true, exitCode: 0, errors: [] });
    expect(out.json.stories.find((s) => s.id === 'T-1.1')).toMatchObject({ bindings: 1, manual: 1, status: 'passed' });
  });

  it('editing the plan and TODO prose after the seal (docs the code hash excludes) does not invalidate it', () => {
    const repo = sealedRepo();
    fs.appendFileSync(repo.planPath, '\nA later note.\n');
    fs.appendFileSync(repo.todoPath, '\nA trailing note.\n');
    repo.write('docs/.output/handoff.md', 'handoff\n');

    expect(verifyCli(repo).status).toBe(0);
  });

  it.each([['an em dash', '—'], ['an en dash', '–'], ['a hyphen', '-']])('accepts the review heading written with %s', (_label, dash) => {
    const repo = sealedRepo();
    repo.write(PLAN_REL, `${PLAN_HEAD}${reviewBlock(1, { dash })}`);

    expect(verifyCli(repo).status).toBe(0);
  });
});

describe('verify: seal conditions (AC2)', () => {
  it('a new commit after the seal is a head mismatch (and the receipt, taken at the old head, no longer holds)', () => {
    const repo = sealedRepo();
    repo.git('commit', '-q', '--allow-empty', '-m', 'moved on');

    const out = verifyCli(repo);

    // The receipt is now judged in full at verify (SF-1.3 security M3), so its own HEAD binding refuses too.
    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['head-mismatch', 'receipt']);
    expectFixLines(out);
  });

  it.each([
    // A tracked edit or delete is code drift; it is unstaged-code only when the path is staged with other bytes.
    ['an edited tracked code file', (repo) => fs.appendFileSync(path.join(repo.root, IMPL), '// late edit\n'), ['code-drift']],
    ['a new untracked code file', (repo) => repo.write('src/late.js', 'late\n'), ['code-drift']],
    ['a deleted tracked code file', (repo) => fs.rmSync(path.join(repo.root, IMPL)), ['code-drift']],
  ])('%s after the seal is code drift', (_label, mutate, expected) => {
    const repo = sealedRepo();
    mutate(repo);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(expected);
    expect(out.stderr).toMatch(/Fix: .*gate\.js/);
    expectFixLines(out);
  });

  it('a record file changed after the seal is records drift', () => {
    const repo = sealedRepo();
    editRecords(repo, 'T-1.1', (records) => { records[0].durationMs += 1; });

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['records-drift']);
    expectFixLines(out);
  });

  it('a story added to the selection after the seal has no sealed record: missing record, never a pass', () => {
    const stories = { ...DEFAULT_STORIES, 'T-1.2': { criteria: ['Second. verify: node ok.js'], files: [A_TEST] } };
    const repo = shipRepo({ stories });
    sealOk(repo, { ids: ['T-1.1'] });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo, { ids: ['T-1.1', 'T-1.2'] });

    expect(out.status).toBe(1);
    expect(rules(out)).toContain('record-missing');
  });
});

describe('verify: bad record classes (AC3)', () => {
  const tamper = (label, rulesExpected, mutate) => [label, rulesExpected, mutate]; // one table row
  it.each([
    tamper('an exit that is not the expected exit', ['record-unmet', 'records-drift'], (r) => { r.exit = 3; r.met = false; }),
    tamper('a forged met:true over an exit that is not the expected exit (met is recomputed, never trusted)', ['record-unmet', 'records-drift'], (r) => { r.exit = 3; r.met = true; }),
    tamper('a met:false record over a matching exit', ['record-unmet', 'records-drift'], (r) => { r.met = false; }),
    tamper('a refused record', ['record-refused', 'records-drift'], (r) => { r.status = 'refused'; r.exit = null; r.met = false; }),
    tamper('a timeout record', ['record-timeout', 'records-drift'], (r) => { r.status = 'timeout'; r.exit = null; r.met = false; }),
    tamper('a tree-changed record', ['record-tree-changed', 'records-drift'], (r) => { r.status = 'tree-changed'; r.met = false; }),
    tamper('a record with a stale code hash', ['record-stale', 'records-drift'], (r) => { r.codeHash = 'f'.repeat(64); }),
  ])('%s is refused with the matching rule', (_label, expected, mutate) => {
    const repo = sealedRepo();
    editRecords(repo, 'T-1.1', (records) => mutate(records[0]));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(expected);
    expectFixLines(out);
  });

  it('a deleted record file is a missing record', () => {
    const repo = sealedRepo();
    fs.rmSync(repo.recordFile('T-1.1'));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['record-missing', 'records-drift']);
  });

  it('a record file truncated to an empty list for a story that has a binding is a missing record', () => {
    const repo = sealedRepo();
    fs.writeFileSync(repo.recordFile('T-1.1'), '[]\n');

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['record-missing', 'records-drift']);
  });

  it('every bad record is reported, one rule entry each, not just the first', () => {
    const stories = {
      'T-1.1': { criteria: ['One. verify: node ok.js', 'Two. verify: node ok.js'], files: [A_TEST] },
    };
    const repo = sealedRepo({ stories });
    editRecords(repo, 'T-1.1', (records) => { records[0].status = 'timeout'; records[0].met = false; records[0].exit = null; records[1].codeHash = 'f'.repeat(64); });

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(out.json.errors.filter((e) => e.rule === 'record-timeout')).toHaveLength(1);
    expect(out.json.errors.filter((e) => e.rule === 'record-stale')).toHaveLength(1);
  });

  it('a story with no bindings is a manual count, not a failure', () => {
    const stories = {
      'T-1.1': { criteria: ['Adds the thing. verify: node ok.js', 'A manual criterion'], files: [A_TEST] },
      'T-1.2': { criteria: ['Manual one', 'Manual two'], files: [IMPL] },
    };
    const repo = sealedRepo({ stories });

    const out = verifyCli(repo, { ids: ['T-1.1', 'T-1.2'] });

    expect(out.status).toBe(0);
    expect(out.json.errors).toEqual([]);
    expect(out.json.stories.find((s) => s.id === 'T-1.2')).toMatchObject({ bindings: 0, manual: 2, status: 'no-bindings' });
    expect(out.json.stories.find((s) => s.id === 'T-1.1')).toMatchObject({ bindings: 1, manual: 1, status: 'passed' });
  });
});

describe('verify: freeze check, completion and review (AC2)', () => {
  it('a verify: line edited after the seal is caught by the re-run ac-verify check, and only by it', () => {
    const repo = sealedRepo();
    fs.writeFileSync(repo.todoPath, fs.readFileSync(repo.todoPath, 'utf8').replace('verify: node ok.js', 'verify: node exit.js 0'));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['ac-check']);
    expectFixLines(out);
  });

  it('a frozen check file edited after the seal is reported by the freeze check (alongside the code drift it causes)', () => {
    const repo = sealedRepo();
    fs.writeFileSync(path.join(repo.root, A_TEST), 'expect(1).toBe(1); // weakened\n');

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['ac-check', 'code-drift']);
  });

  it.each([
    ['an unticked story marker', (text) => text.replace('* [x] **Story T-1.1', '* [ ] **Story T-1.1')],
    ['an unticked criterion', (text) => text.replace('* [x] A manual criterion with no binding', '* [ ] A manual criterion with no binding')],
  ])('%s is a completion failure and nothing else', (_label, edit) => {
    const repo = sealedRepo();
    fs.writeFileSync(repo.todoPath, edit(fs.readFileSync(repo.todoPath, 'utf8')));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['completion']);
    expectFixLines(out);
  });

  it('a story id that is not in the TODO is refused', () => {
    const repo = sealedRepo();

    const out = verifyCli(repo, { ids: ['T-9.9'] });

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
    expect(rules(out)).toContain('completion');
  });

  it.each([
    ['no review entry at all', PLAN_NO_REVIEW],
    ['a review for another wave', `${PLAN_HEAD}${reviewBlock(2)}`],
    ['a review for wave 10 when wave 1 is asked', `${PLAN_HEAD}${reviewBlock(10)}`],
    ['only four bullets', `${PLAN_HEAD}${reviewBlock(1, { bullets: REVIEW_BULLETS.slice(0, 4) })}`],
    ['an empty bullet', `${PLAN_HEAD}${reviewBlock(1, { bullets: [...REVIEW_BULLETS.slice(0, 2), 'Deferred:', ...REVIEW_BULLETS.slice(3)] })}`],
    ['a whitespace-only bullet', `${PLAN_HEAD}${reviewBlock(1, { bullets: [...REVIEW_BULLETS.slice(0, 2), 'Deferred:    ', ...REVIEW_BULLETS.slice(3)] })}`],
    ['the unfilled template placeholders', `${PLAN_HEAD}${reviewBlock(1, { bullets: ['Reviewed: {scope}', 'Fixed now: {finding}', 'Deferred: {finding}', 'Skipped or light: {what}', 'Risk call: {call}'] })}`],
    ['a review that sits inside a code fence', `${PLAN_HEAD}\`\`\`markdown\n${reviewBlock(1)}\`\`\`\n`],
    ['a heading with the wrong label', `${PLAN_HEAD}**Summary — Wave 1**\n${REVIEW_BULLETS.map((b) => `- ${b}`).join('\n')}\n`],
  ])('%s is refused with rule review and nothing else', (_label, plan) => {
    const repo = sealedRepo();
    repo.write(PLAN_REL, plan);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['review']);
    expectFixLines(out);
  });

  it.each([
    ['an extra bullet in the middle', [...REVIEW_BULLETS.slice(0, 2), 'Fixed differently / no change needed: F3 (by design)', ...REVIEW_BULLETS.slice(2)]],
    ['an extra bullet at the end', [...REVIEW_BULLETS, 'Notes: worktrees used for the hotspot group']],
    ['the five labels in another order', [REVIEW_BULLETS[4], ...REVIEW_BULLETS.slice(0, 4)]],
  ])('a complete entry with %s passes the review rule (first adopter run, 2026-11-20)', (_label, bullets) => {
    const repo = sealedRepo();
    repo.write(PLAN_REL, `${PLAN_HEAD}${reviewBlock(1, { bullets })}`);

    const out = verifyCli(repo);

    expect(rules(out)).not.toContain('review');
  });

  it('the refusal names the missing and the empty labels', () => {
    const repo = sealedRepo();
    repo.write(PLAN_REL, `${PLAN_HEAD}${reviewBlock(1, { bullets: [REVIEW_BULLETS[0], 'Fixed now:', REVIEW_BULLETS[2], REVIEW_BULLETS[4]] })}`);

    const out = verifyCli(repo);

    expect(rules(out)).toEqual(['review']);
    expect(out.stdout + out.stderr).toMatch(/missing skipped or light; empty or a placeholder: fixed now/);
  });

  it('a missing plan file is a review failure, never a skip', () => {
    const repo = sealedRepo();
    fs.rmSync(repo.planPath);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['review']);
  });

  it('a plan outside the repository is refused', () => {
    const repo = sealedRepo();
    const elsewhere = path.join(path.dirname(repo.root), 'outside-plan.md');
    fs.writeFileSync(elsewhere, PLAN_WITH_REVIEW);
    roots.push(elsewhere);

    const out = verifyCli(repo, { plan: elsewhere });

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
  });
});

// ── AC4: --kind task ────────────────────────────────────────────────

describe('verify --kind task (AC4)', () => {
  it('without --todo skips the completion and record checks by the named rule no-todo and still passes on a good seal', () => {
    const repo = shipRepo({ stories: DEFAULT_STORIES });
    sealOk(repo, { todo: false });

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null, todo: null });

    expect(out.status).toBe(0);
    expect(out.json.skipped.map((s) => s.rule)).toEqual(['no-todo']);
    expect(out.stdout).toContain('no-todo');
  });

  it('without --todo the seal still applies: no seal is refused', () => {
    const repo = shipRepo();

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null, todo: null });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['no-seal']);
  });

  it('without --todo the code-hash drift still applies', () => {
    const repo = shipRepo();
    sealOk(repo, { todo: false });
    fs.appendFileSync(path.join(repo.root, IMPL), '// late\n');

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null, todo: null });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['code-drift']);
  });

  it('without --todo a failed receipt check at seal time still refuses', () => {
    const repo = shipRepo();
    fs.rmSync(path.join(repo.root, 'docs/.output/.state/telemetry/gate-receipt.json'));

    const out = sealCli(repo, { todo: false });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
  });

  it('with --todo only the review entry is skipped: no plan and no review are needed', () => {
    const repo = shipRepo();
    sealOk(repo);

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null });

    expect(out.status).toBe(0);
    expect(out.json.skipped.map((s) => s.rule)).not.toContain('no-todo');
  });

  it('with --todo the completion check still applies', () => {
    const repo = shipRepo();
    sealOk(repo);
    fs.writeFileSync(repo.todoPath, fs.readFileSync(repo.todoPath, 'utf8').replace('* [x] **Story T-1.1', '* [ ] **Story T-1.1'));

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['completion']);
  });

  it('with --todo the record check still applies', () => {
    const repo = shipRepo();
    sealOk(repo);
    editRecords(repo, 'T-1.1', (records) => { records[0].status = 'timeout'; records[0].met = false; records[0].exit = null; });

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null });

    expect(out.status).toBe(1);
    expect(rules(out)).toContain('record-timeout');
  });

  it('--kind wave never gets the no-todo shortcut: a missing --todo is invalid input', () => {
    const repo = shipRepo();
    sealOk(repo, { todo: false });

    const out = cli(repo.root, ['verify', '--kind', 'wave', '--plan', repo.planPath, '--wave', '1']);

    expect(out.status).toBe(2);
    expect(out.json.ok).toBe(false);
  });
});

// ── AC5: --skip ─────────────────────────────────────────────────────

describe('verify --skip (AC5)', () => {
  it.each([['an empty reason', ''], ['a whitespace-only reason', '   ']])('%s exits 2, records nothing and passes nothing', (_label, reason) => {
    const repo = sealedRepo();

    const out = verifyCli(repo, { skip: reason });

    expect(out.status).toBe(2);
    expect(out.json.ok).toBe(false);
    expect(repo.events()).toEqual([]);
  });

  it('an honoured skip with no seal passes, lists the reason, and records exactly one audited bypass event', () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo, { skip: 'CI-only matrix job; no local runner' });

    expect(out.status).toBe(0);
    expect(out.json.ok).toBe(true);
    expect(out.json.skipped).toHaveLength(1);
    expect(out.json.skipped[0]).toMatchObject({ rule: 'skip', reason: 'CI-only matrix job; no local runner' });
    const events = repo.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'guardrail', decision: 'bypass', rule: 'ship-check-skip', source: 'ship-check' });
    expect(new Date(events[0].timestamp).toISOString()).toBe(events[0].timestamp);
  });

  it('bypasses a drifted tree and a head mismatch too (the seal-based conditions), still with one event', () => {
    const repo = sealedRepo();
    fs.appendFileSync(path.join(repo.root, IMPL), '// late\n');
    repo.git('commit', '-q', '--allow-empty', '-m', 'moved on');

    const out = verifyCli(repo, { skip: 'manual UI-only criterion' });

    expect(out.status).toBe(0);
    expect(repo.events()).toHaveLength(1);
  });

  it('does not bypass the completion check', () => {
    const repo = sealedRepo();
    fs.writeFileSync(repo.todoPath, fs.readFileSync(repo.todoPath, 'utf8').replace('* [x] **Story T-1.1', '* [ ] **Story T-1.1'));

    const out = verifyCli(repo, { skip: 'cannot run locally' });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['completion']);
  });

  it('does not bypass the review entry', () => {
    const repo = sealedRepo();
    repo.write(PLAN_REL, PLAN_NO_REVIEW);

    const out = verifyCli(repo, { skip: 'cannot run locally' });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['review']);
  });

  it('is refused when its bypass event cannot be written: no bypass is silent', () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    fs.mkdirSync(path.join(repo.root, EVENTS_REL), { recursive: true }); // a directory where the event log must be

    const out = verifyCli(repo, { skip: 'cannot run locally' });

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
    expect(out.json.skipped.map((s) => s.rule)).not.toContain('skip');
  });

  it('without --skip a missing seal is never silently passed and records no event', () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['no-seal']);
    expect(repo.events()).toEqual([]);
  });
});

// ── AC6: gate config ────────────────────────────────────────────────

describe('gate config shipCheck (AC6)', () => {
  // SF-1.3 review M2/security M2: `enabled: false` is an audited bypass that still requires the review entry.
  it('shipCheck.enabled false prints a notice, records one audited bypass event and exits 0 without a seal (review entry present)', () => {
    const repo = shipRepo({ config: { shipCheck: { enabled: false } }, evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo);

    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: true, exitCode: 0, errors: [] });
    expect(out.json.notices.map((n) => n.rule)).toEqual(['disabled']);
    expect(out.stdout).toContain('disabled');
    expect(repo.events()).toHaveLength(1);
    expect(repo.events()[0]).toMatchObject({ decision: 'bypass', rule: 'ship-check-disabled', source: 'ship-check' });
  });

  it('shipCheck.enabled false also passes a task verify with no TODO', () => {
    const repo = shipRepo({ config: { shipCheck: { enabled: false } }, evidence: 'none', freeze: false });

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null, todo: null });

    expect(out.status).toBe(0);
    expect(out.json.notices.map((n) => n.rule)).toEqual(['disabled']);
    expect(repo.events().map((e) => e.rule)).toEqual(['ship-check-disabled']);
  });

  it.each([
    ['the boolean true', { shipCheck: { enabled: true } }],
    ['no shipCheck block at all', { receipts: {} }],
    ['the string "false"', { shipCheck: { enabled: 'false' } }],
    ['the number 0', { shipCheck: { enabled: 0 } }],
    ['a shipCheck that is not an object', { shipCheck: false }],
  ])('%s leaves the check on: a missing seal is refused', (_label, config) => {
    const repo = shipRepo({ config, evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['no-seal']);
    expect(out.json.notices.map((n) => n.rule)).not.toContain('disabled');
  });

  it.each(['{not json', '[]', '"off"'])('a malformed gate config (%s) refuses verify with rule config, never a disable or a default', (raw) => {
    const repo = shipRepo({ config: raw, evidence: 'none', freeze: false });

    const out = verifyCli(repo);

    expect(out.status).not.toBe(0);
    expect(rules(out)).toEqual(['config']);
    expectFixLines(out);
  });

  it('a seal downgraded to summary mode is refused when the project uses receipts', () => {
    const repo = sealedRepo();
    fs.writeFileSync(repo.sealFile, JSON.stringify({ ...repo.seal(), mode: 'summary', receiptId: null }));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
  });

  it('a summary seal is refused once the config demands receipts', () => {
    const repo = shipRepo({ config: SUMMARY_CONFIG, evidence: 'summary' });
    sealOk(repo);
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    expect(verifyCli(repo).status, 'control: a summary seal verifies while receipts are not required').toBe(0);
    // The switch changes only through a commit (SF-1.3 security M2): commit the config that demands receipts.
    repo.write('.claude/gate.config.json', JSON.stringify({ shipCheck: { requireReceipt: true } }));
    repo.git('add', '.claude/gate.config.json');
    repo.git('commit', '-q', '-m', 'require receipts');

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toContain('receipt');
  });
});

// ── AC7: fail closed ────────────────────────────────────────────────

describe('fail closed (AC7)', () => {
  it('a missing seal is refused with a Fix that names the seal command', () => {
    const repo = shipRepo({ freeze: false, evidence: 'none' });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['no-seal']);
    expect(out.stderr).toMatch(/Fix: .*ship-check\.js seal/);
    expectFixLines(out);
  });

  it.each([
    ['invalid JSON', () => '{not json'],
    ['an empty file', () => ''],
    ['a JSON array', () => '[]'],
    ['JSON null', () => 'null'],
    ...SEAL_KEYS.filter((key) => key !== 'docs').map((key) => [`a seal without ${key}`, (seal) => { delete seal[key]; return JSON.stringify(seal); }]),
    ['a numeric code hash', (seal) => JSON.stringify({ ...seal, codeHash: 12345 })],
    ['an unknown mode', (seal) => JSON.stringify({ ...seal, mode: 'trust-me' })],
    ['a docs field that is not a list', (seal) => JSON.stringify({ ...seal, docs: 'docs/notes.md' })],
  ])('%s is a malformed seal: refused, never passed', (_label, corrupt) => {
    const repo = sealedRepo();
    fs.writeFileSync(repo.sealFile, corrupt({ ...repo.seal() }));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['bad-seal']);
    expectFixLines(out);
  });

  it('a receipt-mode seal whose receipt file was deleted is refused', () => {
    const repo = sealedRepo();
    fs.rmSync(path.join(repo.root, 'docs/.output/.state/telemetry/gate-receipt.json'));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
    expectFixLines(out);
  });

  it('a receipt-mode seal whose receipt was replaced by another run is refused', () => {
    const repo = sealedRepo();
    writeGateReceipt(repo, { id: '000000000000' });

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
  });

  it.each(['seal', 'verify'])('%s on an object whose properties throw returns a non-zero result instead of throwing', (name) => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });

    const result = subject()[name](hostile);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.errors.map((e) => e.rule)).toEqual(['exception']);
  });

  it.each(['seal', 'verify'])('%s with no options at all is invalid input, not a crash', (name) => {
    const result = subject()[name]();

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('a working directory that is not a git repository is refused non-zero with one JSON document', () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-check-plain-')));
    roots.push(plain);

    const out = cli(plain, ['verify', '--kind', 'task']);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
  });

  it('a seal whose head cannot be read (a repository with no commit) is refused even with a passing summary', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-check-nocommit-')));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    writeSummary(root, { timestamp: new Date().toISOString(), mode: 'TEST ONLY', stack: 'node', overall: true, build: { succeeded: true } });

    const out = cli(root, ['seal']);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
    expect(fs.existsSync(path.join(root, SEAL_REL))).toBe(false);
  });
});

// ── CLI contract ────────────────────────────────────────────────────

describe('CLI argument handling', () => {
  const repoFor = () => shipRepo({ evidence: 'none', freeze: false });
  const T = 'docs/TODO_fixture.md';

  it.each([
    ['no verb', []],
    ['an unknown verb', ['approve']],
    ['seal with --todo but no --stories', ['seal', '--todo', T]],
    ['seal with --stories but no --todo', ['seal', '--stories', 'T-1.1']],
    ['seal with --docs and no value', ['seal', '--docs']],
    ['seal with an unknown flag', ['seal', '--force', 'yes']],
    ['seal with a repeated flag', ['seal', '--docs', 'a', '--docs', 'b']],
    ['seal with a stray positional', ['seal', 'extra']],
  ])('seal: %s is exit 2 and writes no seal', (_label, args) => {
    const repo = repoFor();

    const out = cli(repo.root, args);

    expect(out.status).toBe(2);
    expect(out.json.ok).toBe(false);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it.each([
    ['no --kind', ['verify']],
    ['an unknown kind', ['verify', '--kind', 'epic']],
    ['wave without --plan', ['verify', '--kind', 'wave', '--wave', '1', '--todo', T, '--stories', 'T-1.1']],
    ['wave without --wave', ['verify', '--kind', 'wave', '--plan', PLAN_REL, '--todo', T, '--stories', 'T-1.1']],
    ['wave without --stories', ['verify', '--kind', 'wave', '--plan', PLAN_REL, '--wave', '1', '--todo', T]],
    ['--wave abc', ['verify', '--kind', 'wave', '--plan', PLAN_REL, '--wave', 'abc', '--todo', T, '--stories', 'T-1.1']],
    ['--wave 0', ['verify', '--kind', 'wave', '--plan', PLAN_REL, '--wave', '0', '--todo', T, '--stories', 'T-1.1']],
    ['--wave -1', ['verify', '--kind', 'wave', '--plan', PLAN_REL, '--wave', '-1', '--todo', T, '--stories', 'T-1.1']],
    ['--wave 1.5', ['verify', '--kind', 'wave', '--plan', PLAN_REL, '--wave', '1.5', '--todo', T, '--stories', 'T-1.1']],
    ['task with --stories but no --todo', ['verify', '--kind', 'task', '--stories', 'T-1.1']],
    ['task with --todo but no --stories', ['verify', '--kind', 'task', '--todo', T]],
    ['an unknown flag', ['verify', '--kind', 'task', '--force', 'yes']],
    ['a repeated --kind', ['verify', '--kind', 'task', '--kind', 'wave']],
    ['--skip with no value', ['verify', '--kind', 'task', '--skip']],
  ])('verify: %s is exit 2', (_label, args) => {
    const repo = repoFor();

    const out = cli(repo.root, args);

    expect(out.status).toBe(2);
    expect(out.json.ok).toBe(false);
    expect(repo.events()).toEqual([]);
  });

  it('main(argv) returns the exit code, prints exactly one JSON document, and does not throw on bad input', () => {
    const writes = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    let code;
    try { code = subject().main(['approve']); } finally { spy.mockRestore(); }

    expect(code).toBe(2);
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.ok).toBe(false);
  });
});

// ── wave-2 review fixes (docs/.output/findings/reviews/261118-1228-software-factory-wave2-review.md) ──

describe('seal: a wave that edits an earlier story\'s frozen test is refused at its own seal (first adopter run, 2026-11-20)', () => {
  const B_TEST = 'src/__tests__/b.test.js';
  const TWO = {
    'T-1.1': { criteria: ['Earlier. verify: node ok.js'], files: [A_TEST, IMPL] },
    'T-1.2': { criteria: ['Current. verify: node ok.js'], files: [B_TEST] },
  };

  it('control: sealing only the current story passes while the earlier baseline is intact', () => {
    const repo = shipRepo({ stories: TWO, extra: { [B_TEST]: 'expect(2).toBe(2);\n' } });

    const out = sealCli(repo, { ids: ['T-1.2'] });

    expect(out.status).toBe(0);
  });

  it('refuses naming the earlier story and its file, with the re-baseline fix', () => {
    const repo = shipRepo({ stories: TWO, extra: { [B_TEST]: 'expect(2).toBe(2);\n' } });
    repo.write(A_TEST, 'expect(1).toBe(1); // edited in a later wave\n');
    writeGateReceipt(repo);

    const out = sealCli(repo, { ids: ['T-1.2'] });

    expect(out.status).not.toBe(0);
    expect(rules(out)).toContain('ac-check');
    const message = out.json.errors.map((e) => e.message).join('\n');
    expect(message).toContain('FROZEN_FILE_CHANGED');
    expect(message).toContain(A_TEST);
    expect(out.json.errors.find((e) => e.rule === 'ac-check').fix).toContain('--stories T-1.1');
  });
});

describe('verify: a commit naming different stories from the seal is a clear mismatch, not records-drift (first adopter run, 2026-11-20)', () => {
  const B_TEST = 'src/__tests__/b.test.js';
  const TWO = {
    'T-1.1': { criteria: ['Earlier. verify: node ok.js'], files: [A_TEST, IMPL] },
    'T-1.2': { criteria: ['Current. verify: node ok.js'], files: [B_TEST] },
  };

  it('refuses with stories-mismatch naming both sets, and no records-drift', () => {
    const repo = shipRepo({ stories: TWO, extra: { [B_TEST]: 'expect(2).toBe(2);\n' } });
    sealOk(repo);
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo, { ids: ['T-1.2'] });

    expect(out.status).not.toBe(0);
    expect(rules(out)).toContain('stories-mismatch');
    expect(rules(out)).not.toContain('records-drift');
    expect(out.json.errors.find((e) => e.rule === 'stories-mismatch').message).toContain('T-1.1,T-1.2');
  });

  it('the seal records its stories, sorted', () => {
    const repo = shipRepo({ stories: TWO, extra: { [B_TEST]: 'expect(2).toBe(2);\n' } });
    sealOk(repo, { ids: ['T-1.2', 'T-1.1'] });

    expect(repo.seal().stories).toEqual(['T-1.1', 'T-1.2']);
  });
});

describe('wave-2 review F9: the ac-verify freeze baselines are inside the seal', () => {
  const baselineFile = (repo) => path.join(repo.root, RECORD_DIR, 'T-1.1.freeze.json');
  const editBaseline = (repo, fn) => {
    const baseline = JSON.parse(fs.readFileSync(baselineFile(repo), 'utf8'));
    fn(baseline);
    fs.writeFileSync(baselineFile(repo), `${JSON.stringify(baseline, null, 2)}\n`);
  };

  it('control: an untouched baseline verifies', () => {
    const repo = sealedRepo();

    expect(verifyCli(repo).status).toBe(0);
  });

  it('a baseline rewritten to drop a frozen file after the seal is records drift, although ac-verify check and the code hash still pass', () => {
    const repo = sealedRepo();
    editBaseline(repo, (baseline) => { baseline.files = {}; });
    // The attack is real: with the baseline emptied, ac-verify check no longer watches the test file.
    const checked = spawnSync(process.execPath, [path.resolve('.agents/core/ac-verify.js'), 'check', '--todo', repo.todoPath, '--stories', 'T-1.1'], {
      cwd: repo.root, env: childEnv(repo.root), encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    expect(checked.status, 'precondition: the rewritten baseline passes ac-verify check on its own').toBe(0);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['records-drift']);
    expect(out.json.errors[0].message).toMatch(/freeze baselines/);
    expectFixLines(out);
  });

  it('any other rewrite of the baseline bytes (here: an extra history entry) is records drift too', () => {
    const repo = sealedRepo();
    editBaseline(repo, (baseline) => { baseline.history.push({ at: new Date().toISOString(), reason: 'rebaselined by hand' }); });

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['records-drift']);
  });

  it('a baseline deleted after the seal is refused (ac-check for the missing baseline and records drift)', () => {
    const repo = sealedRepo();
    fs.rmSync(baselineFile(repo));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['ac-check', 'records-drift']);
  });
});

describe('wave-2 review N: CODE_FILE_IN_DOCS has one definition', () => {
  it('gate-receipt exports the code-file test and ship-check does not define its own copy', () => {
    expect(gr.CODE_FILE_IN_DOCS).toBeInstanceOf(RegExp);
    for (const code of ['docs/x.js', 'docs/x.mjs', 'docs/tool.py', 'docs/run.sh', 'docs/a.TS']) expect(gr.CODE_FILE_IN_DOCS.test(code), code).toBe(true);
    for (const doc of ['docs/x.md', 'docs/notes.txt', 'docs/data.json']) expect(gr.CODE_FILE_IN_DOCS.test(doc), doc).toBe(false);
    const source = fs.readFileSync(path.resolve('.agents/core/ship-check.js'), 'utf8');
    expect(source).not.toMatch(/const CODE_FILE_IN_DOCS = \//);
    expect(source).toContain('gateReceipt');
  });
});

describe('receipt mode is the default (review m5: the toolkit "receipts on" with no gate config)', () => {
  it('seals in receipt mode when a receipt exists and the config says nothing about receipts', () => {
    const repo = shipRepo({ config: null, evidence: 'receipt' });
    sealOk(repo);
    expect(repo.seal().mode).toBe('receipt');
    expect(repo.seal().receiptId).toEqual(expect.any(String));
  });

  it('a receipt on disk that does not verify refuses, instead of falling back to summary', () => {
    const repo = shipRepo({ config: null, evidence: 'receipt' });
    writeGateSummary(repo);
    writeGateReceipt(repo, { status: 'failed', exitCode: 1 });
    const out = sealCli(repo);
    expect(out.status).toBe(1);
    expect(rules(out)).toContain('receipt');
  });

  it('shipCheck.requireReceipt: false opts out: summary mode even with a receipt on disk', () => {
    const repo = shipRepo({ config: { shipCheck: { requireReceipt: false } }, evidence: 'summary' });
    writeGateReceipt(repo);
    sealOk(repo);
    expect(repo.seal().mode).toBe('summary');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SF-1.3 review fixes: one describe per finding id
// (security: M1-M4, m1-m4, n1-n3; review: M1-M3, m1-m6, N1-N5; ids are prefixed by the report they come from)
// ═══════════════════════════════════════════════════════════════════

const writeCommitted = (repo, rel, content, message = 'change') => {
  repo.write(rel, content);
  repo.git('add', rel);
  repo.git('commit', '-q', '-m', message);
};

describe('security M1 / review M2: verify refuses code whose index differs from the working tree (rule unstaged-code)', () => {
  /** Stage BAD, then restore the working tree to the sealed content: the working-tree hash cannot see the stage. */
  function staleStage() {
    const repo = shipRepo();
    fs.writeFileSync(path.join(repo.root, IMPL), 'module.exports = "BAD-V1";\n');
    repo.git('add', IMPL);
    fs.writeFileSync(path.join(repo.root, IMPL), SCRIPTS[IMPL]);
    sealOk(repo);
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    return repo;
  }

  it('T4: staged content that differs from the sealed working tree is refused even though the code hash matches', () => {
    const repo = staleStage();
    expect(repo.git('diff', '--cached', '--name-only'), 'precondition: the bad content really is staged').toContain(IMPL);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['unstaged-code']);
    expect(out.json.errors[0].message).toContain('src/impl.js');
    expectFixLines(out);
  });

  it('control: once the sealed content is what is staged, the same verify passes', () => {
    const repo = staleStage();
    repo.git('add', IMPL);

    expect(verifyCli(repo).status).toBe(0);
  });

  // Orchestrator change: an UNSTAGED edit is not unstaged-code (commit.js stages it from the working tree and then checks
  // the staged set matches it); only a path staged with bytes that differ from the working tree is. The edit is still
  // code drift against the seal.
  it('a tracked code file edited and left unstaged is code drift, not unstaged-code', () => {
    const repo = sealedRepo();
    fs.appendFileSync(path.join(repo.root, IMPL), '// late\n');

    expect(rules(verifyCli(repo))).toEqual(['code-drift']);
  });

  it('an unsealed tree whose wave edits are not yet staged passes verify (the commit helper verifies before staging)', () => {
    const repo = sealedRepo();
    // sealedRepo's code edits are committed or staged per its fixture; unstaging them must not refuse.
    execFileSync('git', ['reset', '-q'], { cwd: repo.root });
    expect(rules(verifyCli(repo))).not.toContain('unstaged-code');
  });

  it('paths the code hash excludes (docs/.output, TODO, a --docs path) may differ between the index and the working tree', () => {
    const repo = shipRepo();
    sealOk(repo, { docs: 'docs/notes.md' });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    fs.appendFileSync(path.join(repo.root, 'docs/notes.md'), 'edited after the seal\n');
    fs.appendFileSync(repo.todoPath, '\nnote\n');

    expect(repo.git('diff', '--name-only').split('\n').sort()).toEqual([PLAN_REL, 'docs/TODO_fixture.md', 'docs/notes.md']);
    expect(verifyCli(repo).status).toBe(0);
  });

  it('--skip bypasses the index check with the other seal-based conditions (audited)', () => {
    const repo = staleStage();

    const out = verifyCli(repo, { skip: 'stage is intentional' });

    expect(out.status).toBe(0);
    expect(repo.events()).toHaveLength(1);
  });
});

describe('security M2 / review M3: the shipCheck switches come from the committed gate config', () => {
  const workingConfig = (repo, shipCheck, base = RECEIPT_CONFIG) => repo.write('.claude/gate.config.json', JSON.stringify({ ...base, shipCheck }));

  it('an uncommitted enabled:false is refused with rule config: no pass, no event (T1)', () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    workingConfig(repo, { enabled: false });

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['config']);
    expect(out.json.errors[0].message).toMatch(/differ from the ones committed at HEAD/);
    expectFixLines(out);
    expect(repo.events()).toEqual([]);
  });

  it('an untracked gate config that turns the check off is refused when HEAD has no config at all', () => {
    const repo = shipRepo({ config: null, evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    repo.write('.claude/gate.config.json', JSON.stringify({ shipCheck: { enabled: false } }));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['config']);
  });

  it('an uncommitted requireReceipt:false is refused by seal (no downgrade to summary) and by verify', () => {
    const repo = shipRepo({ evidence: 'summary' });
    workingConfig(repo, { requireReceipt: false });

    const sealed = sealCli(repo);
    const verified = verifyCli(repo);

    expect(sealed.status).toBe(1);
    expect(rules(sealed)).toEqual(['config']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
    expect(verified.status).toBe(1);
    expect(rules(verified)).toEqual(['config']);
  });

  it('deleting the committed switch from the working tree does not switch the check back on or off silently', () => {
    const repo = shipRepo({ config: { shipCheck: { enabled: false } }, evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    fs.rmSync(path.join(repo.root, '.claude/gate.config.json'));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['config']);
  });

  it('a committed enabled:false is an audited bypass: the event carries the rule, source and the verdict context', () => {
    const repo = shipRepo({ config: { shipCheck: { enabled: false } }, evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo);

    expect(out.status).toBe(0);
    expect(repo.events()).toHaveLength(1);
    expect(repo.events()[0]).toMatchObject({ event: 'guardrail', decision: 'bypass', rule: 'ship-check-disabled', source: 'ship-check', kind: 'wave', wave: 1, stories: ['T-1.1'], head: repo.head() });
    expect(repo.events()[0].reason).toMatch(/enabled is false/);
  });

  it('a committed enabled:false still requires the completion check and the review entry, and records no event while refused', () => {
    const repo = shipRepo({ config: { shipCheck: { enabled: false } }, evidence: 'none', freeze: false });
    fs.writeFileSync(repo.todoPath, fs.readFileSync(repo.todoPath, 'utf8').replace('* [x] **Story T-1.1', '* [ ] **Story T-1.1'));
    repo.write(PLAN_REL, PLAN_NO_REVIEW);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['completion', 'review']);
    expect(repo.events()).toEqual([]);
  });

  it('a committed enabled:false is refused when its audit event cannot be written', () => {
    const repo = shipRepo({ config: { shipCheck: { enabled: false } }, evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    fs.mkdirSync(path.join(repo.root, EVENTS_REL), { recursive: true });

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['disabled']);
    expectFixLines(out);
  });

  it('enabled:false together with --skip records both bypasses', () => {
    const repo = shipRepo({ config: { shipCheck: { enabled: false } }, evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    const out = verifyCli(repo, { skip: 'both' });

    expect(out.status).toBe(0);
    expect(repo.events().map((e) => e.rule)).toEqual(['ship-check-disabled', 'ship-check-skip']);
  });

  it('a committed config change takes effect: committing requireReceipt:false selects summary mode', () => {
    const repo = shipRepo({ evidence: 'summary' });
    writeCommitted(repo, '.claude/gate.config.json', JSON.stringify({ ...RECEIPT_CONFIG, ...SUMMARY_CONFIG }), 'opt out of receipts');
    writeGateSummary(repo);

    expect(sealCli(repo).status).toBe(0);
    expect(repo.seal().mode).toBe('summary');
  });
});

describe('security M3 / review M1 / review m5: gate evidence', () => {
  const writeSummaryFile = (repo, value) => {
    fs.mkdirSync(path.join(repo.root, 'docs/.output/.state/telemetry'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, 'docs/.output/.state/telemetry/_latest-summary.json'), JSON.stringify(value));
  };

  it('receipt mode is the default: with no gate config and no receipt, a passing summary never seals (T2 downgrade by deletion)', () => {
    const repo = shipRepo({ config: null, evidence: 'summary' });

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
    expect(out.json.errors[0].message).toMatch(/no gate receipt/);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it('a hand-written {"overall":true} summary does not seal even in summary mode (T2)', () => {
    const repo = shipRepo({ config: SUMMARY_CONFIG, evidence: 'none' });
    writeSummaryFile(repo, { overall: true });

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['summary']);
    expect(out.json.errors.map((e) => e.message).join(' ')).toMatch(/no passing test leg/);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it.each([
    ['an e2e run with no e2e script (skipped)', { mode: 'E2E', test: undefined, e2e: { skipped: true } }],
    ['a build-only run', { mode: 'BUILD', test: undefined }],
    ['a change-scoped test run', { mode: 'TEST (changed only)' }],
    ['a test leg that collected nothing', { test: { succeeded: true, total: 0, zeroCollected: true } }],
    ['a test leg that timed out', { test: { succeeded: true, total: 1, zeroCollected: false, timedOut: true } }],
    ['a test leg that did not succeed', { test: { succeeded: false, total: 1 } }],
    ['a failed build', { build: { succeeded: false } }],
    ['no build record', { build: undefined }],
  ])('summary evidence is refused for %s', (_label, over) => {
    const repo = shipRepo({ config: SUMMARY_CONFIG, evidence: 'none' });
    writeGateSummary(repo, { over });

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['summary']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it('T3: summary-mode verify re-reads the summary: a hand-written summary-mode seal with no summary on disk is refused', () => {
    const repo = shipRepo({ config: SUMMARY_CONFIG, evidence: 'none', freeze: false });
    const code = gr.codeTreeHash(repo.root).hash;
    fs.mkdirSync(path.dirname(repo.sealFile), { recursive: true });
    fs.writeFileSync(repo.sealFile, JSON.stringify({
      head: repo.head(), receiptId: null, mode: 'summary', codeHash: code, gateCodeHash: code,
      recordsHash: crypto.createHash('sha256').update('').digest('hex'), docs: [], todo: null, stories: [], sealedAt: new Date().toISOString(),
    }));

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null, todo: null });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['summary']);
    expectFixLines(out);
  });

  it('summary-mode verify refuses a genuine seal once the summary stops being a fresh pass', () => {
    const repo = shipRepo({ config: SUMMARY_CONFIG, evidence: 'summary' });
    sealOk(repo);
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    writeSummaryFile(repo, { overall: true });

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['summary']);
  });

  it('T5: a forged {"id","status"} receipt with a forged seal naming it is refused (the receipt is judged in full)', () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    const code = gr.codeTreeHash(repo.root).hash;
    fs.mkdirSync(path.dirname(repo.sealFile), { recursive: true });
    fs.writeFileSync(path.join(repo.root, 'docs/.output/.state/telemetry/gate-receipt.json'), JSON.stringify({ id: 'x', status: 'passed' }));
    fs.writeFileSync(repo.sealFile, JSON.stringify({
      head: repo.head(), receiptId: 'x', mode: 'receipt', codeHash: code, gateCodeHash: code,
      recordsHash: crypto.createHash('sha256').update('').digest('hex'), docs: [], todo: null, stories: [], sealedAt: new Date().toISOString(),
    }));

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null, todo: null });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
  });

  it('a genuine receipt from an older code tree plus a re-sealed seal is refused at verify (gate on Monday, edit on Tuesday)', () => {
    const repo = sealedRepo();
    writeGateReceipt(repo, { codeHash: 'f'.repeat(64) });

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
    expect(out.json.errors[0].message).toMatch(/code hash/);
  });

  it.each([
    ['a receipt with no code hash (written by an older gate)', { codeHash: undefined }, /no code hash/],
    ['a receipt for other code', { codeHash: 'a'.repeat(64) }, /code hash: the receipt covers/],
    ['a receipt with no test leg (a build-only run)', { test: undefined }, /no test leg/],
    ['a receipt whose test leg failed', { test: { status: 'failed' } }, /test leg is "failed"/],
    ['a change-scoped receipt', { changedOnly: true }, /change-scoped/],
    ['a receipt from another engine', { engine: 'other' }, /engine changed/],
    ['a receipt for another gate config', { configHash: 'other' }, /gate config changed/],
  ])('seal refuses %s', (_label, over, message) => {
    const repo = shipRepo();
    writeGateReceipt(repo, over);

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
    expect(out.json.errors[0].message).toMatch(message);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it('verify judges the receipt the seal names for code, not for the whole tree: doc edits after the gate pass', () => {
    const repo = sealedRepo();
    repo.write('docs/.output/handoff.md', 'a handoff written after the seal\n');
    fs.appendFileSync(repo.planPath, '\nlater\n');

    expect(verifyCli(repo).status).toBe(0);
  });

  it('review m5: the receipt path comes from gate-receipt.js, not a hard-coded copy', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');

    expect(source).toContain('gateReceipt.receiptPath(root)');
    expect(source).not.toMatch(/path\.join\([^)]*'gate-receipt\.json'/);
  });
});

describe('security M4 / review m4: the skip audit', () => {
  const skipRepo = () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    return repo;
  };

  it('the event records reason, kind, wave, stories and head', () => {
    const repo = skipRepo();

    const out = verifyCli(repo, { skip: 'CI-only matrix job' });

    expect(out.status).toBe(0);
    expect(repo.events()).toHaveLength(1);
    expect(repo.events()[0]).toEqual({
      event: 'guardrail', decision: 'bypass', rule: 'ship-check-skip', tier: null, source: 'ship-check', pathClass: null,
      timestamp: repo.events()[0].timestamp, reason: 'CI-only matrix job', kind: 'wave', wave: 1, stories: ['T-1.1'], head: repo.head(),
    });
  });

  it('a task skip records kind task and no wave', () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null, todo: null, skip: 'manual UI check' });

    expect(out.status).toBe(0);
    const [event] = repo.events();
    expect(event).toMatchObject({ kind: 'task', reason: 'manual UI check', head: repo.head(), stories: [] });
    expect(Object.keys(event)).not.toContain('wave');
  });

  it('T6: AGENT_SHARED_STATE_ROOT and AGENTS_PROJECT_DIR cannot redirect the event away from the repository', () => {
    const repo = skipRepo();
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-check-void-')));
    roots.push(elsewhere);

    const out = verifyCli(repo, { skip: 'redirect attempt', env: { AGENT_SHARED_STATE_ROOT: elsewhere } });

    expect(out.status).toBe(0);
    expect(repo.events()).toHaveLength(1);
    expect(fs.existsSync(path.join(elsewhere, 'docs'))).toBe(false);
  });

  it.skipIf(isWindows)('T6b: an events file that is a symlink (to /dev/null or a file) refuses the skip and is never written through', () => {
    const repo = skipRepo();
    const target = path.join(path.dirname(repo.root), `ship-events-target-${process.pid}.jsonl`);
    fs.writeFileSync(target, '');
    roots.push(target);
    fs.mkdirSync(path.dirname(path.join(repo.root, EVENTS_REL)), { recursive: true });
    fs.symlinkSync(target, path.join(repo.root, EVENTS_REL));

    const out = verifyCli(repo, { skip: 'swallow attempt' });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['skip']);
    expect(out.json.skipped.map((s) => s.rule)).not.toContain('skip');
    expect(fs.readFileSync(target, 'utf8')).toBe('');
    expectFixLines(out);
  });

  it.skipIf(isWindows)('a symlinked telemetry directory refuses the skip and nothing is written outside the repository', () => {
    const repo = skipRepo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-check-telemetry-')));
    roots.push(outside);
    fs.mkdirSync(path.join(repo.root, 'docs/.output/.state'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo.root, 'docs/.output/.state/telemetry'));

    const out = verifyCli(repo, { skip: 'swallow attempt' });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['skip']);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('a root that is not the top of its git working tree is refused: the event is written only against the verified repository root', () => {
    const repo = skipRepo();
    const inner = path.join(repo.root, 'src');

    const out = subject().verify({ root: inner, kind: 'task', skip: 'wrong root', env: childEnv(repo.root) });

    expect(out.ok).toBe(false);
    expect(out.errors.map((e) => e.rule)).toEqual(['skip']);
    expect(fs.existsSync(path.join(inner, 'docs'))).toBe(false);
    expect(repo.events()).toEqual([]);
  });

  it('a skip refused for another reason records no event', () => {
    const repo = skipRepo();
    fs.writeFileSync(repo.todoPath, fs.readFileSync(repo.todoPath, 'utf8').replace('* [x] **Story T-1.1', '* [ ] **Story T-1.1'));

    const out = verifyCli(repo, { skip: 'cannot run locally' });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['completion']);
    expect(repo.events()).toEqual([]);
  });

  it('review m4 (reason in the audit): the reason survives in the event even for a long one-line reason (bounded to 500)', () => {
    const repo = skipRepo();

    const out = verifyCli(repo, { skip: 'r'.repeat(500) });

    expect(out.status).toBe(0);
    expect(repo.events()[0].reason).toBe('r'.repeat(500));
  });
});

describe('security m3: the seal is bound to its TODO, and the plan to docs/.output/plans/', () => {
  it('a copy of the TODO with the same verify: lines and every story ticked is refused: todo-mismatch', () => {
    const repo = sealedRepo();
    const copy = path.join(repo.root, 'docs/TODO_copy.md');
    fs.copyFileSync(repo.todoPath, copy);

    const out = verifyCli(repo, { todo: copy });

    expect(out.status).toBe(1);
    expect(rules(out)).toContain('todo-mismatch');
    expect(out.json.errors.find((e) => e.rule === 'todo-mismatch').message).toContain('docs/TODO_fixture.md');
    expectFixLines(out);
  });

  it('the TODO named by a relative path or from another directory still matches the sealed one', () => {
    const repo = sealedRepo();

    const out = cli(repo.root, verifyArgs(repo, { todo: '../docs/TODO_fixture.md' }), { cwd: path.join(repo.root, 'src') });

    expect(out.status).toBe(0);
  });

  it('a seal made with a TODO refuses a verify with none (the completion check must not be dropped)', () => {
    const repo = sealedRepo();

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null, todo: null });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['todo-mismatch']);
  });

  it('a seal made with no TODO refuses a verify that names one', () => {
    const repo = shipRepo();
    sealOk(repo, { todo: false });

    const out = verifyCli(repo, { kind: 'task', wave: null, plan: null });

    expect(out.status).toBe(1);
    expect(rules(out)).toContain('todo-mismatch');
  });

  it.each([
    ['an ignored scratch file under docs/.output/.state/', 'docs/.output/.state/scratch-plan.md'],
    ['a tracked document outside the plans directory', 'docs/notes.md'],
    ['a plan-looking file elsewhere', 'src/plan.md'],
  ])('--plan must resolve inside docs/.output/plans/: %s is invalid input', (_label, rel) => {
    const repo = sealedRepo();
    repo.write(rel, PLAN_WITH_REVIEW);

    const out = verifyCli(repo, { plan: path.join(repo.root, rel) });

    expect(out.status).toBe(2);
    expect(rules(out)).toEqual(['invalid-args']);
    expect(out.json.errors[0].message).toContain('docs/.output/plans/');
  });
});

describe('review m1: a review entry hidden from a reader does not count', () => {
  const refusedAs = (plan) => {
    const repo = sealedRepo();
    repo.write(PLAN_REL, plan);
    const out = verifyCli(repo);
    expect(out.status, JSON.stringify(out.json.errors)).toBe(1);
    expect(rules(out)).toEqual(['review']);
  };
  const acceptedAs = (plan) => {
    const repo = sealedRepo();
    repo.write(PLAN_REL, plan);
    expect(verifyCli(repo).status).toBe(0);
  };
  const indent = (text, prefix) => text.split('\n').map((line) => (line ? `${prefix}${line}` : line)).join('\n');

  it.each([
    ['a whole block inside a multi-line HTML comment', `${PLAN_HEAD}<!--\n${reviewBlock(1)}-->\n`],
    ['a whole block inside a one-line-per-line HTML comment', `${PLAN_HEAD}<!-- **Review — Wave 1** -->\n${REVIEW_BULLETS.map((b) => `<!-- - ${b} -->`).join('\n')}\n`],
    ['only the heading inside a comment', `${PLAN_HEAD}<!-- **Review — Wave 1** -->\n${REVIEW_BULLETS.map((b) => `- ${b}`).join('\n')}\n`],
    ['one bullet hidden by a comment', `${PLAN_HEAD}**Review — Wave 1**\n${REVIEW_BULLETS.map((b, i) => (i === 2 ? `<!-- - ${b} -->` : `- ${b}`)).join('\n')}\n`],
    ['a block indented four spaces (an indented code block)', `${PLAN_HEAD}${indent(reviewBlock(1), '    ')}`],
    ['a heading indented by a tab', `${PLAN_HEAD}\t**Review — Wave 1**\n${REVIEW_BULLETS.map((b) => `- ${b}`).join('\n')}\n`],
  ])('is refused: %s', (_label, plan) => refusedAs(plan));

  it.each([
    ['a heading indented three spaces', `${PLAN_HEAD}${indent(reviewBlock(1).split('\n')[0], '   ')}\n${REVIEW_BULLETS.map((b) => `- ${b}`).join('\n')}\n`],
    ['a heading written as a list item', `${PLAN_HEAD}- **Review — Wave 1**\n${REVIEW_BULLETS.map((b) => `  - ${b}`).join('\n')}\n`],
    ['an entry after a closed HTML comment', `${PLAN_HEAD}<!-- a note -->\n${reviewBlock(1)}`],
    ['an entry on the line after a comment that closes on its own line', `${PLAN_HEAD}<!--\nnote\n-->\n${reviewBlock(1)}`],
    ['a heading followed by a closed comment on the same line', `${PLAN_HEAD}**Review — Wave 1** <!-- filled below -->\n${REVIEW_BULLETS.map((b) => `- ${b}`).join('\n')}\n`],
  ])('is accepted (control): %s', (_label, plan) => acceptedAs(plan));
});

describe('review m2: the code is hashed before the evidence is judged and again after the bindings ran', () => {
  it('code that changes while the bindings run refuses the seal with rule tree-changed and writes no seal', () => {
    const repo = shipRepo();
    const ac = require('../ac-verify');
    const original = ac.run;
    const spy = vi.spyOn(ac, 'run').mockImplementation((...args) => {
      fs.writeFileSync(path.join(repo.root, 'src/concurrent.js'), 'written by a concurrent writer\n');
      return original.apply(ac, args);
    });
    let out;
    try { out = subject().seal({ root: repo.root, todo: repo.todoPath, stories: repo.ids, env: childEnv(repo.root) }); } finally { spy.mockRestore(); }

    expect(out.ok).toBe(false);
    expect(out.errors.map((e) => e.rule)).toEqual(['tree-changed']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it('control: with no concurrent writer the same in-process seal succeeds', () => {
    const repo = shipRepo();

    const out = subject().seal({ root: repo.root, todo: repo.todoPath, stories: repo.ids, env: childEnv(repo.root) });

    expect(out.ok, JSON.stringify(out.errors)).toBe(true);
    expect(fs.existsSync(repo.sealFile)).toBe(true);
  });

  it('a receipt replaced while the bindings run refuses the seal', () => {
    const repo = shipRepo();
    const ac = require('../ac-verify');
    const original = ac.run;
    const spy = vi.spyOn(ac, 'run').mockImplementation((...args) => {
      const result = original.apply(ac, args);
      writeGateReceipt(repo, { id: 'replaced00000' });
      return result;
    });
    let out;
    try { out = subject().seal({ root: repo.root, todo: repo.todoPath, stories: repo.ids, env: childEnv(repo.root) }); } finally { spy.mockRestore(); }

    expect(out.ok).toBe(false);
    expect(out.errors.map((e) => e.rule)).toEqual(['receipt']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });
});

describe('security m4: the symlink posture is the same for every state-zone read and for removeSeal', () => {
  it.skipIf(isWindows)('a symlinked telemetry directory never has its ship-seal.json removed by a seal (removeSeal)', () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-check-victim-')));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, 'ship-seal.json'), 'victim');
    fs.mkdirSync(path.join(repo.root, 'docs/.output/.state'), { recursive: true });
    fs.symlinkSync(outside, path.join(repo.root, 'docs/.output/.state/telemetry'));

    const out = sealCli(repo);

    expect(out.status).not.toBe(0);
    expect(fs.readFileSync(path.join(outside, 'ship-seal.json'), 'utf8')).toBe('victim');
  });

  it.skipIf(isWindows)('a symlinked gate-receipt.json is refused as evidence (not followed)', () => {
    const repo = shipRepo();
    const receiptFile = path.join(repo.root, 'docs/.output/.state/telemetry/gate-receipt.json');
    const real = path.join(repo.root, 'docs/.output/.state/telemetry/real-receipt.json');
    fs.renameSync(receiptFile, real);
    fs.symlinkSync(real, receiptFile);

    const out = sealCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['receipt']);
    expect(out.json.errors[0].message).toMatch(/is a symlink/);
  });

  it.skipIf(isWindows)('verify refuses records read through a symlinked ac-verify directory', () => {
    const repo = sealedRepo();
    const dir = path.join(repo.root, RECORD_DIR);
    const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-check-records-')));
    roots.push(copy);
    fs.cpSync(dir, copy, { recursive: true });
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(copy, dir);

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(expect.arrayContaining(['record-missing', 'records-drift']));
  });

  it.skipIf(isWindows)('a TODO that is a symlink leaving the repository is refused before anything runs', () => {
    const repo = shipRepo();
    const outside = path.join(path.dirname(repo.root), `outside-todo-${process.pid}.md`);
    fs.copyFileSync(repo.todoPath, outside);
    roots.push(outside);
    const link = path.join(repo.root, 'docs/TODO_link.md');
    fs.symlinkSync(outside, link);

    const out = cli(repo.root, ['seal', '--todo', link, '--stories', 'T-1.1']);

    expect(out.status).toBe(2);
    expect(rules(out)).toEqual(['invalid-args']);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });
});

describe('security n2 / review N1: Fix hints name the runtime the script runs from', () => {
  const missingSealFix = (out) => out.json.errors.find((e) => e.rule === 'no-seal').fix;

  it('from a source checkout the hint follows AGENTS_RUNTIME (claude by default, codex when set)', () => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);

    expect(missingSealFix(verifyCli(repo))).toContain('node .claude/core/ship-check.js seal');
    expect(missingSealFix(verifyCli(repo, { env: { AGENTS_RUNTIME: 'codex' } }))).toContain('node .codex/core/ship-check.js seal');
  });

  it.each([['.codex', undefined], ['.codex', 'claude'], ['.claude', 'codex']])('a script installed under %s names that directory (AGENTS_RUNTIME=%s does not override its own location)', (dir, runtime) => {
    const repo = shipRepo({ evidence: 'none', freeze: false });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    const installed = path.join(repo.root, '..', `installed-${process.pid}-${dir.slice(1)}-${runtime || 'none'}`);
    roots.push(installed);
    // ac-verify requires ../hooks/secret-patterns.cjs, so an install copies the hooks next to core.
    fs.cpSync(path.resolve('.agents/core'), path.join(installed, dir, 'core'), { recursive: true, filter: (src) => !src.includes('__tests__') });
    fs.cpSync(path.resolve('.agents/hooks'), path.join(installed, dir, 'hooks'), { recursive: true, filter: (src) => !src.includes('__tests__') });
    const script = path.join(installed, dir, 'core', 'ship-check.js');

    const r = spawnSync(process.execPath, [script, ...verifyArgs(repo)], {
      cwd: repo.root, env: childEnv(repo.root, runtime ? { AGENTS_RUNTIME: runtime } : {}), encoding: 'utf8', windowsHide: true, timeout: 120000,
    });

    expect(JSON.parse(r.stdout).errors.find((e) => e.rule === 'no-seal').fix).toContain(`node ${dir}/core/ship-check.js seal`);
  });
});

describe('review N2: --docs is functional (excluded from the code hash for seal and verify, recorded in the seal)', () => {
  it('a document listed in --docs may be edited after the seal; without --docs the same edit is code drift', () => {
    const listed = shipRepo();
    sealOk(listed, { docs: 'docs/notes.md' });
    listed.write(PLAN_REL, PLAN_WITH_REVIEW);
    fs.appendFileSync(path.join(listed.root, 'docs/notes.md'), 'edited after the seal\n');
    const unlisted = shipRepo();
    sealOk(unlisted);
    unlisted.write(PLAN_REL, PLAN_WITH_REVIEW);
    fs.appendFileSync(path.join(unlisted.root, 'docs/notes.md'), 'edited after the seal\n');

    expect(verifyCli(listed).status).toBe(0);
    const out = verifyCli(unlisted);
    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['code-drift']);
  });

  it('the seal records the docs list, and its codeHash excludes them while gateCodeHash covers them', () => {
    const repo = shipRepo();

    sealOk(repo, { docs: 'docs/notes.md' });

    expect(repo.seal().docs).toEqual(['docs/notes.md']);
    expect(repo.seal().codeHash).toBe(gr.codeTreeHash(repo.root, { extraExclude: ['docs/notes.md'] }).hash);
    expect(repo.seal().gateCodeHash).toBe(gr.codeTreeHash(repo.root).hash);
    expect(repo.seal().codeHash).not.toBe(repo.seal().gateCodeHash);
  });

  it('with no --docs the two hashes in the seal are equal, and a seal that says otherwise is malformed', () => {
    const repo = shipRepo();
    sealOk(repo);
    expect(repo.seal().codeHash).toBe(repo.seal().gateCodeHash);
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    fs.writeFileSync(repo.sealFile, JSON.stringify({ ...repo.seal(), gateCodeHash: 'e'.repeat(64) }));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toContain('bad-seal');
  });

  it.each([
    ['a path outside docs/', 'src/impl.js'],
    ['a code file under docs/', 'docs/helper.js'],
    ['a directory', 'docs'],
    ['the docs directory with a slash', 'docs/'],
    ['a docs sub-directory', 'docs/.output'],
  ])('seal refuses %s with rule docs-path and runs no binding', (_label, docs) => {
    const repo = shipRepo({ extra: { 'docs/helper.js': 'module.exports = 1;\n' } });

    const out = sealCli(repo, { docs });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['docs-path']);
    expectFixLines(out);
    expect(fs.existsSync(repo.sealFile)).toBe(false);
  });

  it.each(['CLAUDE.md', 'AGENTS.md'])('seal accepts the root instruction file %s in --docs, and it leaves the sealed code hash', (doc) => {
    const repo = shipRepo({ extra: { [doc]: '# instructions\n' } });

    sealOk(repo, { docs: doc });

    expect(repo.seal().docs).toEqual([doc]);
    expect(repo.seal().codeHash).toBe(gr.codeTreeHash(repo.root, { extraExclude: [doc] }).hash);
    expect(repo.seal().codeHash).not.toBe(repo.seal().gateCodeHash);
  });

  it('a nested CLAUDE.md outside docs/ is still refused', () => {
    const repo = shipRepo({ extra: { 'src/CLAUDE.md': '# nested\n' } });

    const out = sealCli(repo, { docs: 'src/CLAUDE.md' });

    expect(out.status).toBe(1);
    expect(rules(out)).toEqual(['docs-path']);
  });

  it('a forged seal that lists a code file or a non-docs path as excluded is refused at verify', () => {
    const repo = sealedRepo();
    fs.writeFileSync(repo.sealFile, JSON.stringify({ ...repo.seal(), docs: ['src/impl.js'] }));

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toContain('docs-path');
  });

  it('a listed document that becomes a directory after the seal is refused (it could hide code)', () => {
    const repo = shipRepo();
    sealOk(repo, { docs: 'docs/notes.md' });
    repo.write(PLAN_REL, PLAN_WITH_REVIEW);
    fs.rmSync(path.join(repo.root, 'docs/notes.md'));
    repo.write('docs/notes.md/payload.txt', 'hidden\n');

    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(rules(out)).toContain('docs-path');
  });
});

describe('review N3: the header states what the freeze check covers with no --todo', () => {
  it('names the code hash as the only freeze coverage for an ad-hoc task, and the threat-model residual', () => {
    const header = fs.readFileSync(SCRIPT, 'utf8').split('*/')[0];

    expect(header).toContain('the ac-verify freeze check cannot run (it needs a TODO)');
    expect(header).toContain('THREAT MODEL');
    expect(header).toContain('not adversarial integrity');
  });
});

describe('security review M6: verify warns on stderr when the managed git hooks are not active', () => {
  const AGENTS_DIR = path.resolve(__dirname, '../../../.agents');
  const hooksLib = require('../git-hooks');

  it('prints the refusal-level warning, and the verdict and exit code are exactly what they were', () => {
    const repo = shipRepo();
    const out = verifyCli(repo);

    expect(out.stderr).toContain('[ship-check] WARNING: the managed git hooks are NOT active in this checkout');
    expect(out.stderr).toContain('pre-push: missing');
    expect(out.stderr).toContain('nothing refuses a force, mirror or delete push');
    expect(out.stderr).toMatch(/node \.(?:claude|codex)\/core\/git-hooks\.js/);
    expect(out.status).toBe(1);
    expect(rules(out)).toContain('no-seal');
    expect(out.stdout).not.toContain('NOT active');
  });

  it('a passing verify still passes and still warns (the warning never decides the verdict)', () => {
    const repo = sealedRepo();
    const out = verifyCli(repo);

    expect(out.status, out.stderr).toBe(0);
    expect(out.json.ok).toBe(true);
    expect(out.stderr).toContain('WARNING: the managed git hooks are NOT active');
  });

  it('seal does not print it: the warning belongs to the judge', () => {
    const repo = shipRepo();
    const out = sealCli(repo);

    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).not.toContain('git hooks');
  });

  it.skipIf(isWindows)('prints nothing about hooks once the managed hooks are installed and current', () => {
    const repo = shipRepo();
    fs.symlinkSync(AGENTS_DIR, path.join(repo.root, '.agents'), 'dir');
    fs.appendFileSync(path.join(repo.root, '.git', 'info', 'exclude'), '/.agents\n');
    expect(hooksLib.installHooks(repo.root)).toMatchObject({ active: true });
    const out = verifyCli(repo);

    expect(out.status).toBe(1);
    expect(out.stderr).not.toContain('git hooks');
  });

  it('warnHooksMissing reports a failure to find out instead of swallowing it', () => {
    const lines = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((text) => { lines.push(String(text)); return true; });
    const real = hooksLib.backstopWarning;
    hooksLib.backstopWarning = () => { throw new Error('probe exploded'); };
    try {
      subject().warnHooksMissing(process.cwd(), {});
    } finally {
      hooksLib.backstopWarning = real;
      spy.mockRestore();
    }
    expect(lines.join('')).toContain('WARNING: could not check whether the managed git hooks are active (probe exploded)');
  });
});
