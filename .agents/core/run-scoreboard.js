#!/usr/bin/env node
'use strict';

/**
 * Run scoreboard: one read-only report that answers "are the agents good".
 *
 * It rolls up the gate pass rate and TODO completion (both owned by metrics.js, imported here and never recounted),
 * the `**Run record:**` lines and `**Status:**` lines of the plans under docs/.output/plans/, and optional
 * session-timesplit JSON into a per-run table and a rolling-N summary, as markdown or JSON.
 *
 * Usage:
 *   node .claude/core/run-scoreboard.js [--json] [--rolling N] [--timesplit FILE]...
 *
 * Missing DATA degrades its field to null (markdown `n/a`) and the exit code stays 0. A bad ARGUMENT is a usage error,
 * not missing data: a `--rolling` that is not a positive integer, or a `--timesplit` FILE that is missing, unreadable,
 * not JSON or not a session-timesplit report, prints the reason on stderr, writes nothing to stdout and exits 2 (a
 * silently dropped input would make the section vanish from the report). Nothing is ever written to disk.
 *
 * What counts as a run: a plan under docs/.output/plans/ is a run when its file name carries `-run-todo-` or `-do-`
 * (the `{stamp}-{command}-{slug}.md` convention) or it holds a `**Run record:**` line. Other plan documents (design,
 * decisions, planning) are reported once as `other_plans` and never appear in the Runs table. A run without a record
 * line is a `without_record` row: the per-run fields stay null until a record is written.
 *
 * The plan-line contract (`**Run record:** {json}`, each counter `{ value, source }`) is owned by run-record.js;
 * this file only parses that line shape and imports nothing from run-record.
 *
 * Ship-check trail (security review m4). A run record's `ship_token` is the Main Agent's own word. Each run row that names a
 * `commit` also carries `ship_check`, read from the commit itself (the `Ship-Check` trailer `commit.js --ship-check` writes on
 * a passing check, via _lib/git.js): `sealed` (trailer present), `skipped` (the audited `Ship-Check-Skip` trailer),
 * `missing` (the commit exists and carries neither: it did not go through `commit.js --ship-check`) or `unknown` (the commit
 * cannot be read from this checkout: not a repository, or a commit from another clone). A row with no commit has `null`.
 * `plans.ship_check` counts the four states and the report lists every run whose commit lacks the trailer.
 */

const fs = require('fs');
const path = require('path');
const { computeTelemetry, computeTodos } = require('./metrics');
const { readShipTrailers } = require('./_lib/git');

const PLANS_DIR = ['docs', '.output', 'plans'];
const DEFAULT_ROLLING = 10;
const RECORD_LINE = /^\*\*Run record:\*\* (.+)$/;
const STATUS_LINE = /^\*\*Status:\*\*(.*)$/;
const STATUS_WORD = /^[A-Za-z][A-Za-z-]*/;
const RUN_PLAN_NAME = /-(run-todo|do)-/; // `{YYMMDD-HHMM}-{command}-{slug}.md`: the command is `run-todo` or `do` for a run
// The run record's per-run gate counter (gate rates themselves come from metrics.js, never from raw rows here).
const GATE_RUNS_KEY = 'gate_runs';
const COUNTERS = [
  'waves', 'stories', GATE_RUNS_KEY, 'gate_failures', 'first_pass_green_waves',
  'fix_rounds', 'review_major', 'dispatches', 'misalignments', 'stops', 'output_tokens',
];

// ── helpers ──────────────────────────────────────────────────────

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (n, digits) => parseFloat(n.toFixed(digits));
const percent = (part, whole) => (whole > 0 ? round((part / whole) * 100, 1) : null);

/** Run a section builder; any exception degrades that section to `fallback` (the scoreboard never throws). */
function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function mean(values) {
  const known = values.filter(isNumber);
  if (known.length === 0) return null;
  return round(known.reduce((a, b) => a + b, 0) / known.length, 2);
}

// ── gate and TODO completion (numbers owned by metrics.js) ───────

function gateCounts(entry) {
  if (!isObject(entry)) return null;
  const pass = isNumber(entry.pass) ? entry.pass : 0;
  const fail = isNumber(entry.fail) ? entry.fail : 0;
  const total = pass + fail;
  // metrics reports a 0% rate over zero runs; a rate over nothing is null here.
  return { pass, fail, total, pass_rate: total > 0 && isNumber(entry.pass_rate) ? entry.pass_rate : null };
}

function buildGate(root) {
  const telemetry = computeTelemetry(root);
  if (!telemetry) return null;
  const results = isObject(telemetry.gate_results) ? telemetry.gate_results : {};
  return { build: gateCounts(results['gate:build']), test: gateCounts(results['gate:test']) };
}

function buildTodos(root) {
  const todos = computeTodos(root);
  if (!todos) return null;
  return { files: todos.files, total: todos.total, done: todos.done, completion_rate: todos.completion_rate };
}

// ── plans and run records ────────────────────────────────────────

function listPlanFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listPlanFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** `{ value, source }` -> the bare number; anything else (null value, missing field, other shape) -> null. */
function unwrap(field) {
  if (!isObject(field) || !('value' in field) || !('source' in field)) return null;
  return isNumber(field.value) ? field.value : null;
}

function firstPassGreen(waves, greenWaves) {
  if (waves === null || greenWaves === null || waves <= 0) return null;
  return greenWaves === waves;
}

/**
 * What the commit a run record names says about its ship check: 'sealed' | 'skipped' | 'missing' | 'unknown', or null when
 * the record names no commit. `cache` holds one answer per commit (a run's commit repeats across its plan line and run file).
 */
function shipCheckState(root, record, cache) {
  if (typeof record.commit !== 'string' || record.commit === '') return null;
  if (cache.has(record.commit)) return cache.get(record.commit);
  const found = safely(() => readShipTrailers(root, record.commit), { state: 'error' });
  const state = found.state !== 'ok' ? 'unknown' : found.shipCheck ? 'sealed' : found.skip ? 'skipped' : 'missing';
  cache.set(record.commit, state);
  return state;
}

function recordRow(plan, planStatus, record, root, cache) {
  const row = {
    plan,
    run_id: record.run_id,
    command: typeof record.command === 'string' ? record.command : null,
    input: typeof record.input === 'string' ? record.input : null,
    has_record: true,
    status: typeof record.status === 'string' ? record.status : null,
    plan_status: planStatus,
    commit: typeof record.commit === 'string' ? record.commit : null,
    ship_token: typeof record.ship_token === 'string' ? record.ship_token : null,
    ship_check: shipCheckState(root, record, cache),
  };
  for (const key of COUNTERS) row[key] = unwrap(record[key]);
  row.first_pass_green = firstPassGreen(row.waves, row.first_pass_green_waves);
  return row;
}

function recordlessRow(plan, planStatus) {
  const row = { plan, run_id: null, command: null, input: null, has_record: false, status: null, plan_status: planStatus, commit: null, ship_token: null, ship_check: null };
  for (const key of COUNTERS) row[key] = null;
  row.first_pass_green = null;
  return row;
}

/** Parse one plan's text into its Status text and its valid run records; count the record lines it skipped. */
function parsePlan(text) {
  let planStatus = null;
  let malformed = 0;
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (planStatus === null) {
      const status = STATUS_LINE.exec(line);
      if (status && status[1].trim() !== '') planStatus = status[1].trim();
    }
    const match = RECORD_LINE.exec(line);
    if (!match) continue;
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      malformed++;
      continue;
    }
    if (isObject(parsed) && typeof parsed.run_id === 'string') records.push(parsed);
    else malformed++;
  }
  return { planStatus, records, malformed };
}

function buildPlans(root) {
  const dir = path.join(root, ...PLANS_DIR);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { plans: null, runs: [] };

  const summary = {
    total: 0, with_record: 0, without_record: 0, other_plans: 0, malformed_records: 0, by_status: {},
    ship_check: { sealed: 0, skipped: 0, missing: 0, unknown: 0 },
  };
  const runs = [];
  const shipCache = new Map();
  for (const file of listPlanFiles(dir)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const text = safely(() => fs.readFileSync(file, 'utf8'), '');
    const { planStatus, records, malformed } = parsePlan(text);

    summary.total++;
    summary.malformed_records += malformed;
    // A plan document that is not a run (no run-shaped name, no record line at all): counted, not a run row.
    if (!RUN_PLAN_NAME.test(path.basename(file)) && records.length === 0 && malformed === 0) {
        summary.other_plans++;
        continue;
    }
    const word = planStatus === null ? null : STATUS_WORD.exec(planStatus);
    const key = word ? word[0].toLowerCase() : 'unknown';
    summary.by_status[key] = (summary.by_status[key] || 0) + 1;

    if (records.length === 0) {
      summary.without_record++;
      runs.push(recordlessRow(rel, planStatus));
    } else {
      summary.with_record++;
      for (const record of records) {
        const row = recordRow(rel, planStatus, record, root, shipCache);
        if (row.ship_check !== null) summary.ship_check[row.ship_check]++;
        runs.push(row);
      }
    }
  }

  const sortKey = (row) => (row.run_id !== null ? row.run_id : path.posix.basename(row.plan));
  // Array.prototype.sort is stable, so rows with one key keep the plan order (the file walk is sorted).
  runs.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { plans: summary, runs };
}

// ── rolling-N ────────────────────────────────────────────────────

function buildRolling(runs, window) {
  const rows = runs.filter((r) => r.has_record).slice(-window);

  const greenRows = rows.filter((r) => r.waves !== null && r.first_pass_green_waves !== null && r.waves > 0);
  const waveSum = greenRows.reduce((sum, r) => sum + r.waves, 0);
  const greenSum = greenRows.reduce((sum, r) => sum + r.first_pass_green_waves, 0);

  return {
    window,
    runs: rows.length,
    success_rate: percent(rows.filter((r) => r.status === 'passed').length, rows.length),
    first_pass_green_rate: percent(greenSum, waveSum),
    mean_fix_rounds: mean(rows.map((r) => r.fix_rounds)),
    mean_review_major: mean(rows.map((r) => r.review_major)),
    mean_dispatches: mean(rows.map((r) => r.dispatches)),
    mean_output_tokens: mean(rows.map((r) => r.output_tokens)),
    mean_gate_failures: mean(rows.map((r) => r.gate_failures)),
    mean_stops: mean(rows.map((r) => r.stops)),
  };
}

// ── session-timesplit roll-up ────────────────────────────────────

function buildTimesplit(objects) {
  if (!Array.isArray(objects)) return null;
  const usable = objects.filter((o) => isObject(o) && isObject(o.subagents));
  if (usable.length === 0) return null;
  const sum = (pick) => usable.reduce((total, o) => {
    const value = pick(o.subagents);
    return total + (isNumber(value) ? value : 0);
  }, 0);
  return {
    sessions: usable.length,
    agent_runs: sum((s) => s.runs),
    agent_hours: round(sum((s) => s.totalHours), 2),
    fix_rounds: sum((s) => (isObject(s.fixRounds) ? s.fixRounds.rounds : null)),
  };
}

// ── public API ───────────────────────────────────────────────────

/**
 * @param {{ root?: string, now?: Date, rolling?: number, timesplit?: object[] }} [options]
 * @returns {object} the scoreboard; never throws and never writes
 */
function buildScoreboard(options) {
  const opts = isObject(options) ? options : {};
  const root = typeof opts.root === 'string' && opts.root ? opts.root : process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
  const now = opts.now instanceof Date && !Number.isNaN(opts.now.getTime()) ? opts.now : new Date();
  const window = Number.isInteger(opts.rolling) && opts.rolling > 0 ? opts.rolling : DEFAULT_ROLLING;

  const { plans, runs } = safely(() => buildPlans(root), { plans: null, runs: [] });
  return {
    generated: now.toISOString(),
    gate: safely(() => buildGate(root), null),
    todos: safely(() => buildTodos(root), null),
    plans,
    runs,
    rolling: buildRolling(runs, window),
    timesplit: safely(() => buildTimesplit(opts.timesplit), null),
  };
}

// ── markdown ─────────────────────────────────────────────────────

const NA = 'n/a';
const text = (v) => (v === null || v === undefined ? NA : String(v));
const rate = (v) => (isNumber(v) ? `${v.toFixed(1)}%` : NA);
const cell = (v) => text(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const yesNo = (v) => (v === true ? 'yes' : v === false ? 'no' : NA);

function rateWithCounts(entry) {
  if (!entry || !isNumber(entry.pass_rate)) return NA;
  return `${entry.pass_rate.toFixed(1)}% (${entry.pass} of ${entry.total})`;
}

function completionWithCounts(todos) {
  if (!todos || !isNumber(todos.completion_rate)) return NA;
  return `${todos.completion_rate.toFixed(1)}% (${todos.done} of ${todos.total})`;
}

function renderMarkdown(scoreboard) {
  const sb = isObject(scoreboard) ? scoreboard : {};
  const gate = sb.gate || {};
  const plans = sb.plans || null;
  const rolling = sb.rolling || {};
  const runs = Array.isArray(sb.runs) ? sb.runs : [];

  const lines = ['# Agent scoreboard', '', `Generated: ${text(sb.generated)}`, ''];

  lines.push('## Gate', '');
  lines.push('- note: the test pass rate counts intended red-first runs (a failure the author wanted) and has no per-run attribution, so it understates first-pass success');
  lines.push(`- test pass rate: ${rateWithCounts(gate.test)}`);
  lines.push(`- build pass rate: ${rateWithCounts(gate.build)}`);
  lines.push(`- todo completion: ${completionWithCounts(sb.todos)}`, '');

  lines.push('## Plans', '');
  lines.push(`- plans: ${text(plans && plans.total)}`);
  lines.push(`- plans with run record: ${text(plans && plans.with_record)}`);
  lines.push(`- plans without run record: ${text(plans && plans.without_record)}`);
  lines.push(`- other plan documents (not runs): ${text(plans && plans.other_plans)}`);
  lines.push(`- malformed run records: ${text(plans && plans.malformed_records)}`);
  if (plans && isObject(plans.by_status)) {
    for (const key of Object.keys(plans.by_status).sort()) lines.push(`- status ${key}: ${plans.by_status[key]}`);
  }
  lines.push('');

  const ship = plans && isObject(plans.ship_check) ? plans.ship_check : null;
  lines.push('## Ship-check trail', '');
  lines.push('- note: a run record\'s ship token is self-reported; this reads the commit itself for the `Ship-Check` trailer `commit.js --ship-check` writes');
  lines.push(`- commits with the trailer (sealed): ${text(ship && ship.sealed)}`);
  lines.push(`- commits with the audited skip trailer: ${text(ship && ship.skipped)}`);
  lines.push(`- commits WITHOUT the trailer (not ship-checked): ${text(ship && ship.missing)}`);
  lines.push(`- commits not readable from this checkout: ${text(ship && ship.unknown)}`);
  for (const r of runs.filter((row) => row.ship_check === 'missing')) {
    lines.push(`  - ${cell(r.run_id !== null && r.run_id !== undefined ? r.run_id : r.plan)}: commit ${cell(r.commit)} (token ${cell(r.ship_token)}) lacks the Ship-Check trailer`);
  }
  lines.push('');

  lines.push('## Rolling', '');
  lines.push(`- window size: ${text(rolling.window)}`);
  lines.push(`- runs in window: ${text(rolling.runs)}`);
  lines.push(`- success rate: ${rate(rolling.success_rate)}`);
  lines.push(`- first-pass-green rate: ${rate(rolling.first_pass_green_rate)}`);
  lines.push(`- mean fix rounds: ${text(rolling.mean_fix_rounds)}`);
  lines.push(`- mean review major: ${text(rolling.mean_review_major)}`);
  lines.push(`- mean dispatches: ${text(rolling.mean_dispatches)}`);
  lines.push(`- mean output tokens: ${text(rolling.mean_output_tokens)}`);
  lines.push(`- mean gate failures: ${text(rolling.mean_gate_failures)}`);
  lines.push(`- mean stops: ${text(rolling.mean_stops)}`, '');

  if (sb.timesplit) {
    lines.push('## Timesplit', '');
    lines.push(`- sessions: ${text(sb.timesplit.sessions)}`);
    lines.push(`- agent runs: ${text(sb.timesplit.agent_runs)}`);
    lines.push(`- agent hours: ${text(sb.timesplit.agent_hours)}`);
    lines.push(`- fix rounds: ${text(sb.timesplit.fix_rounds)}`, '');
  }

  lines.push('## Runs', '');
  lines.push('| Run | Command | Input | Status | Plan status | Waves | First-pass green | Fix rounds | Review major | Dispatches | Stops | Output tokens |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    lines.push(`| ${[
      cell(r.run_id !== null && r.run_id !== undefined ? r.run_id : r.plan), cell(r.command), cell(r.input), cell(r.status),
      cell(r.plan_status), cell(r.waves), yesNo(r.first_pass_green), cell(r.fix_rounds), cell(r.review_major),
      cell(r.dispatches), cell(r.stops), cell(r.output_tokens),
    ].join(' | ')} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────

const POSITIVE_INT = /^[1-9]\d*$/;

/**
 * A flag's value is the next argv element (or the part after `=`) unless it is missing or starts with `--`.
 * Unknown flags are ignored. `errors` lists every usage problem: a `--rolling` with no value or a value that is not a
 * positive integer, a `--timesplit` with no value.
 */
function parseArgs(argv) {
  const args = { json: false, rolling: undefined, timesplit: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const takesValue = flag === '--rolling' || flag === '--timesplit';
    if (flag === '--json') {
      args.json = true;
    } else if (takesValue) {
      let value;
      if (flag !== arg) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) value = argv[++i];
      if (value === undefined) {
        args.errors.push(`${flag} needs a value`);
      } else if (flag === '--rolling') {
        if (POSITIVE_INT.test(value) && Number.isSafeInteger(Number(value))) args.rolling = Number(value);
        else args.errors.push(`--rolling must be a positive integer (got ${JSON.stringify(value)})`);
      } else {
        args.timesplit.push(value);
      }
    }
  }
  return args;
}

/** `{ objects, errors }`: every `--timesplit` FILE must be a readable JSON object with an object `subagents` (a session-timesplit --json report). */
function readTimesplitFiles(files) {
  const objects = [];
  const errors = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    } catch (err) {
      errors.push(`--timesplit ${file}: cannot read it as JSON (${err && err.code ? err.code : 'not valid JSON'})`);
      continue;
    }
    if (!isObject(parsed) || !isObject(parsed.subagents)) {
      errors.push(`--timesplit ${file}: not a session-timesplit --json report (no "subagents" object)`);
      continue;
    }
    objects.push(parsed);
  }
  return { objects, errors };
}

/** Run the CLI; returns the exit code (0, or 2 for a usage error) and prints nothing to stdout on a usage error. */
function main(argv) {
  const args = parseArgs(argv);
  const timesplit = readTimesplitFiles(args.timesplit);
  const errors = [...args.errors, ...timesplit.errors];
  if (errors.length > 0) {
    for (const message of errors) process.stderr.write(`[run-scoreboard] ${message}\n`);
    process.stderr.write('Usage: node .claude/core/run-scoreboard.js [--json] [--rolling N] [--timesplit FILE]...\n');
    return 2;
  }
  const scoreboard = buildScoreboard({
    root: process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..'),
    now: new Date(),
    rolling: args.rolling,
    timesplit: args.timesplit.length > 0 ? timesplit.objects : undefined,
  });
  process.stdout.write(args.json ? `${JSON.stringify(scoreboard, null, 2)}\n` : renderMarkdown(scoreboard));
  return 0;
}

module.exports = { buildScoreboard, renderMarkdown };

if (require.main === module) {
  process.exitCode = 0;
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // Reporting must never fail a caller: say what went wrong on stderr and still exit 0.
    process.stderr.write(`[run-scoreboard] ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 0;
  }
}
