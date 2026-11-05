#!/usr/bin/env node

/**
 * Status — Parse TODO files and generate an HTML dashboard.
 *
 * Scans for TODO files in docs/, parses checkbox markers, and produces:
 *   - A compact text summary to stdout
 *   - An HTML dashboard at docs/.output/.state/status.html
 *
 * Usage:
 *   node .claude/core/status.js              # Full scan + HTML
 *   node .claude/core/status.js --text-only  # Text summary only (no HTML)
 *
 * Supported TODO formats:
 *   - Master index (TODO_{Project}.md) — Phase Map + Epic Index tables
 *   - Per-epic checklists (TODO_epic*.md) — flat checkbox lists
 *   - /todo output — Story Index tables with Status column
 *
 * Architecture note (P2.4):
 *   Metrics loading is delegated to _lib modules:
 *     loadCodeMetrics   — LOC + file count
 *     loadMemoryMetrics — memory store health via MemoryManager API
 *     loadGitMetrics    — commit count, branch, 7-day velocity
 *     readSummary       — last gate build/test outcome
 *   HTML generation is delegated to _lib/status-html.js.
 *   TODO parsing (findTodoFiles, parseTodoFile) stays inline — tightly coupled to
 *   output formatter, no other consumer.
 */

const fs = require('fs');
const path = require('path');
const { globSync } = (() => {
  try { return require('glob'); } catch { return { globSync: null }; }
})();

const { loadCodeMetrics }   = require('./_lib/code-metrics');
const { loadMemoryMetrics } = require('./_lib/memory-metrics');
const { loadGitMetrics }    = require('./_lib/git-metrics');
const { readSummary }       = require('./_lib/gate-summary');
const { generateHtml, esc } = require('./_lib/status-html');
const { getJsonlPath }      = require('./_lib/telemetry-paths');
const { OUTPUT_ROOT, compartmentDir } = require('./_lib/output-paths');
const { DOC_PATHS }         = require('./constants');

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
// ADR 0006: generated dashboards are regenerable state → docs/.output/.state/.
// OUTPUT_DIR feeds both status.html and the decisions.html link below (line ~688),
// so both land in .state together. The `docs/.output` prefix comes from the
// output-paths.js "only door" (OUTPUT_ROOT); `.state` is the stable zone segment.
const OUTPUT_DIR   = path.join(PROJECT_ROOT, OUTPUT_ROOT, '.state');
const OUTPUT_FILE  = path.join(OUTPUT_DIR, 'status.html');
const TEXT_ONLY    = process.argv.includes('--text-only');

// ── Find TODO files ──────────────────────────────────────────────

// `_archive` (underscore) is the documented toolkit convention for retired
// checklists — see docs/CLAUDE.md's taxonomy. Archived copies include stale
// duplicates of the master index itself, which parse as a SECOND `type:'master'`
// file and get summed into the grand total by computeGrandTotals. The
// dot-prefixed `.archive` alias is kept for older layouts.
// ONE constant, TWO consumers: the globSync `ignore` list and the fallback
// directory scanner. They drifted once — the skip list lived inside the fallback
// `else` branch only, so any adopter where `glob` resolves silently re-counted
// archived masters while this repo (no `glob` installed) looked correct.
const SKIP_DIRS = ['_archive', '.archive', '.output', 'node_modules', '.git'];
const SKIP_DIR_SET = new Set(SKIP_DIRS);
// Both forms per dir: `**/x/**` (nested) and `x/**` (at the glob cwd root).
const SKIP_GLOBS = SKIP_DIRS.flatMap(d => [`**/${d}/**`, `${d}/**`]);

function findTodoFiles() {
  const patterns = [
    'docs/TODO_*.md',
    'docs/work/todo/TODO_*.md',
    'docs/work/todo/TODO*.md',
    'docs/modules/**/TODO*.md',
  ];
  const found = new Set();
  if (globSync) {
    for (const pattern of patterns) {
      for (const f of globSync(pattern, { cwd: PROJECT_ROOT, ignore: SKIP_GLOBS })) {
        found.add(path.join(PROJECT_ROOT, f));
      }
    }
  } else {
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIR_SET.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile() && /^TODO.*\.md$/i.test(entry.name)) found.add(full);
        else if (entry.isDirectory()) scanDir(full);
      }
    };
    scanDir(path.join(PROJECT_ROOT, 'docs'));
  }
  return [...found].sort();
}

// ── Parse a TODO file ────────────────────────────────────────────

function parseTodoFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
  const titleMatch = content.match(/^#\s+TODO:\s*(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(filePath, '.md');
  const isMasterIndex = /## Phase Map/i.test(content) || /## Epic Index/i.test(content);
  const result = {
    path: relativePath, title,
    type: isMasterIndex ? 'master' : 'checklist',
    stories: { total: 0, done: 0, inProgress: 0, blocked: 0, deferred: 0, pending: 0 },
    epics: [], phases: [],
  };
  if (isMasterIndex) parseMasterIndex(lines, result);
  else parseChecklist(lines, result);
  return result;
}

// Normalize a table cell for identity comparison: strip markdown emphasis
// (`**bold**`, `__bold__`, `*italic*`, `` `code` ``) and surrounding whitespace,
// lowercased. Used for header/Total-row RECOGNITION only, never for value parsing.
function normCellText(cell) {
  return String(cell || '')
    .replace(/[*_`]/g, '')
    .trim()
    .toLowerCase();
}

// A table's grand-total row. Recognized by NORMALIZED first-cell text, so a plain
// `| Total |` works exactly like the canonical bold `| **Total** |` — the old
// `/^\|\s*\*\*Total\*\*/i` test was bold-only, and on a plain-Total tracker it
// silently fell through to summing the per-phase rows (which overshoots whenever
// one checklist spans several phases).
function isTotalCell(cell) {
  return normCellText(cell) === 'total';
}

function parseMasterIndex(lines, result) {
  let section = null;
  // The Phase Map's explicit `**Total**` row, when present. Preferred over summing
  // the per-phase rows: summing assumes phases partition the work, which is false
  // whenever ONE checklist spans several phases (a multi-phase subsystem tracked
  // in a single doc). Such a file is counted once per phase it appears in, so the
  // row sum overshoots — the Total row is already deduped by regenerateMasterIndex.
  let explicitTotal = null;
  for (const line of lines) {
    if (/## Phase Map/i.test(line)) { section = 'phases'; continue; }
    if (/## Epic Index/i.test(line)) { section = 'epics'; continue; }
    if (/^## /.test(line) && section) { section = null; continue; }
    if (section === 'phases' && line.startsWith('|') && isTotalCell(splitRow(line)[0])) {
      // Positional split (empty cells preserved) so columns line up with the
      // phase header; filter(Boolean) would collapse this row's blank Name/Goal
      // cells and misalign it.
      const raw = splitRow(line);
      const n = (c) => parseInt(String(c || '').replace(/\D/g, ''), 10);
      if (raw.length >= 6 && Number.isFinite(n(raw[4])) && Number.isFinite(n(raw[5]))) {
        explicitTotal = { total: n(raw[4]) || 0, done: n(raw[5]) || 0 };
      }
      continue;
    }
    // Header detection by EXACT first-cell text, never `line.includes('Phase')`:
    // a substring test silently DROPS any data row whose text contains the word
    // (a phase named "Phase Zero Prep", an epic titled "Epic Rewrite Engine").
    if (section === 'phases' && line.startsWith('|') && !line.includes('---')
        && !/^phase$/i.test(normCellText(splitRow(line)[0]))) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 7) {
        const stories = parseInt(cols[4]) || 0;
        const done = parseInt(cols[5]) || 0;
        result.phases.push({ id: cols[0], name: cols[1], goal: cols[2], epics: parseInt(cols[3]) || 0, stories, done, status: cols[6] });
        result.stories.total += stories;
        result.stories.done += done;
      }
    }
    if (section === 'epics' && line.startsWith('|') && !line.includes('---')
        && !/^epic$/i.test(normCellText(splitRow(line)[0]))) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 7) {
        const statusRaw = cols[5].trim();
        const status = /\[x\]/i.test(statusRaw) ? 'done'
          : /\[>\]/.test(statusRaw) ? 'in_progress'
          : /\[!\]/.test(statusRaw) ? 'blocked'
          : /\[~\]/.test(statusRaw) ? 'deferred' : 'pending';
        result.epics.push({ id: cols[0], title: cols[1], phase: cols[2], stories: parseInt(cols[3]) || 0, estHours: parseFloat(cols[4]) || 0, status });
      }
    }
  }
  if (explicitTotal && explicitTotal.total > 0) {
    result.stories.total = explicitTotal.total;
    result.stories.done = explicitTotal.done;
  }
  if (result.stories.total === 0 && result.epics.length > 0) {
    result.stories.total = result.epics.reduce((s, e) => s + e.stories, 0);
    result.stories.done = result.epics.filter(e => e.status === 'done').reduce((s, e) => s + e.stories, 0);
  }
  result.stories.pending = result.stories.total - result.stories.done - result.stories.inProgress - result.stories.blocked - result.stories.deferred;
}

function parseChecklist(lines, result) {
  // The canonical per-epic format generated by /create:project-epics-todo puts
  // each story behind a `## Story N.M:` header, with plain `- [ ] task`
  // checkboxes (and footer ACs) underneath — NOT bold-prefixed checkbox lines.
  // If this file uses that format, count STORIES (the headers), deriving each
  // story's status from its task checkboxes (F20). Otherwise fall back to the
  // legacy checkbox/table parse below.
  // Accept BOTH story-ID styles after "Story ": dotted (`1.2`) AND epic-story
  // (`E11-S1`, `E0-S2`). The old `[\d.]+` only matched dotted IDs, so the
  // brownfield `## Story E11-S1` headers fell through to the legacy parser and
  // counted 0 (C13). `[A-Za-z]*\d` = optional letters then a required digit, so
  // a non-story header like `## Story Index` (no digit) still won't match.
  const storyHeader = /^##\s+Story\s+[A-Za-z]*\d[\w.-]*/i;
  if (lines.some(l => storyHeader.test(l.trim()))) {
    parseStoryHeaderChecklist(lines, result, storyHeader);
    return;
  }
  // A file tracks stories EITHER as bold checkbox lines (`- [x] **1.2** Title`)
  // OR as a status table (`| 1.2 | Title | [x] |`) — these are two renderings of
  // the same story set, not two disjoint sets. Counting both double-counts every
  // story in any file that carries a body checklist AND a "Story Index" summary
  // table, which is a common and deliberate authoring style. Bold checkboxes win
  // when present; pure-table checklists (no bold checkbox anywhere) still count
  // via the table path exactly as before.
  // A story bullet is ALWAYS top-level. Both tests below match the RAW line (no
  // `.trim()`) so an INDENTED bold checkbox — an AC bullet nested under a story —
  // can never be counted as a story. Trimming here caused two distinct defects:
  //   1. A file with 9 indented bold AC bullets and 0 top-level ones counted 9
  //      "stories" for a 16-story epic.
  //   2. Worse, and silent: a file with 32 indented AC bullets flipped
  //      `hasBoldCheckboxStories` to true, which SUPPRESSED the table path that
  //      would have read its Story Index correctly — 32 instead of 34.
  // Checklists that legitimately use bold-checkbox stories put them at column 0
  // and are unaffected.
  const hasBoldCheckboxStories = lines.some(l => /^- \[.\] \*\*/.test(l));
  for (const line of lines) {
    const checkboxMatch = line.match(/- \[([ x>!~])\]/);
    const tableStatusMatch = hasBoldCheckboxStories ? null : line.match(/\|\s*\[([ x>!~])\]\s*\|/);
    const marker = checkboxMatch ? checkboxMatch[1] : tableStatusMatch ? tableStatusMatch[1] : null;
    if (marker === null) continue;
    if (checkboxMatch) {
      if (!/^- \[.\] \*\*/.test(line)) continue;
    }
    result.stories.total++;
    switch (marker) {
      case 'x': result.stories.done++; break;
      case '>': result.stories.inProgress++; break;
      case '!': result.stories.blocked++; break;
      case '~': result.stories.deferred++; break;
      default:  result.stories.pending++; break;
    }
  }
}

// Parse a per-epic checklist where each story is a `## Story N.M:` header.
//
// Story-level status is taken from the STORY HEADER's own marker when it has one
// — e.g. `## Story 3.1 (Config): Title \`[x]\``. `/run-todo` Step 8a marks the
// story done at the header at wave commit, so the header marker is authoritative
// (R7). Only when the header carries NO status marker do we fall back to deriving
// status from the story's task checkboxes (done = all `[x]`, in-progress = some,
// etc.) — that keeps the F20/F21 behavior for generators that don't mark headers.
//
// A non-Story `## ` heading (`## Validation`, `## Notes`, `## Dependencies`…)
// ENDS the current story, so trailing-section checkboxes never leak into the last
// story's task list (R7). Bold prose annotations between stories are ignored —
// they aren't under a `## Story` header (F20/F21).
function parseStoryHeaderChecklist(lines, result, storyHeader) {
  let current = null; // { headerMarker: string|null, markers: [] }
  const flush = () => {
    if (!current) return;
    result.stories.total++;
    const hm = current.headerMarker;
    if (hm) {
      // Header marker is authoritative.
      switch (hm) {
        case 'x': result.stories.done++; break;
        case '>': result.stories.inProgress++; break;
        case '!': result.stories.blocked++; break;
        case '~': result.stories.deferred++; break;
        default:  result.stories.pending++; break;
      }
    } else {
      // No header marker — derive from the story's task checkboxes.
      const m = current.markers;
      if (m.length > 0 && m.every(x => x === 'x'))      result.stories.done++;
      else if (m.some(x => x === '!'))                  result.stories.blocked++;
      else if (m.some(x => x === '~'))                  result.stories.deferred++;
      else if (m.some(x => x === 'x' || x === '>'))     result.stories.inProgress++;
      else                                              result.stories.pending++;
    }
    current = null;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (storyHeader.test(trimmed)) {
      flush();
      // Capture the header's own status marker if present. Matches a single
      // status char in brackets (`[x]`, `\`[ ]\``, `[>]`) — a descriptive
      // annotation like `[CP — critical path]` is multi-char and won't match.
      const hm = trimmed.match(/\[([ x>!~])\]/);
      current = { headerMarker: hm ? hm[1] : null, markers: [] };
      continue;
    }
    // Any OTHER `## ` heading closes the current story (R7 — stops a trailing
    // `## Validation`/`## Notes` section's checkboxes leaking into the last story).
    if (/^##\s+/.test(trimmed)) { flush(); continue; }
    if (!current) continue;
    const cb = line.match(/- \[([ x>!~])\]/);
    if (cb) current.markers.push(cb[1]);
  }
  flush();
}

// ── Inline telemetry metrics (commands + gates + sessions) ───────
// NOTE: git data delegated to loadGitMetrics(); only JSONL parsing and
// session-count remain inline — both are tightly coupled to the telemetry
// directory layout and have no other consumers.

function computeTelemetryMetrics(projectRoot) {
  const telemetryFile = getJsonlPath(projectRoot, 'command-usage.jsonl');
  if (!fs.existsSync(telemetryFile)) return null;
  let raw;
  try { raw = fs.readFileSync(telemetryFile, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const commands = {};
  const gates = {};
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'command_invocation' && entry.command)
      commands[entry.command] = (commands[entry.command] || 0) + 1;
    if (entry.type === 'gate_run' && entry.command) {
      if (!gates[entry.command]) gates[entry.command] = { pass: 0, fail: 0, rate: 0 };
      // A4 telemetry schema: outcome is 'success' | 'failure' | 'unknown'.
      // 'pass'/'fail' are retained for backward-compat with any pre-A4 JSONL
      // still lingering in the file (the schema rename shipped in Wave 2 of
      // Phase 1's core-hooks-refactor — commit 6c8e474).
      if (entry.outcome === 'success' || entry.outcome === 'pass') gates[entry.command].pass++;
      else if (entry.outcome === 'failure' || entry.outcome === 'fail') gates[entry.command].fail++;
      // 'unknown' is ignored — no signal, neither pass nor fail.
    }
  }
  for (const name of Object.keys(gates)) {
    const g = gates[name];
    const total = g.pass + g.fail;
    g.rate = total > 0 ? Math.round((g.pass / total) * 100) : 0;
  }

  let sessions = 0;
  const sessionsDir = path.join(projectRoot, compartmentDir('state/sessions'));
  try {
    if (fs.existsSync(sessionsDir))
      sessions = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter(e => e.isDirectory()).length;
  } catch { /* non-fatal */ }

  const memoryBenchmark = parseMemoryBenchmark(projectRoot);
  return { commands, gates, sessions, memoryBenchmark };
}

// Parse memory-benchmark.jsonl for last-30-days hit rate (AMEM-8.1).
function parseMemoryBenchmark(projectRoot) {
  const file = getJsonlPath(projectRoot, 'memory-benchmark.jsonl');
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const cutoffISO = cutoff.toISOString();
  let total = 0; let hits = 0; const ranks = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'memory_benchmark') continue;
    if (typeof entry.timestamp !== 'string' || entry.timestamp < cutoffISO) continue;
    total++;
    if (entry.hit) hits++;
    if (typeof entry.retrieval_rank === 'number') ranks.push(entry.retrieval_rank);
  }
  if (total === 0) return null;
  const rate = Math.round((hits / total) * 100);
  const meanRank = ranks.length > 0 ? Number((ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(2)) : null;
  return { total, hits, rate, meanRank };
}

// ── Grand-total aggregation (dedup master vs per-epic) ───────────
// A master index (TODO_{Project}.md) already aggregates every story via its
// Epic Index; the per-epic checklists (TODO_epic*.md) re-count those same
// stories. Summing both double-counts (F21). When a master index is present it
// is the canonical aggregate, so the grand TOTAL derives from master files
// only; per-epic files are still shown individually but not summed in. With no
// master index, fall back to summing the checklists.
function computeGrandTotals(files) {
  const masters = files.filter(f => f.type === 'master');
  const source = masters.length > 0 ? masters : files;
  return source.reduce((acc, f) => {
    acc.total += f.stories.total; acc.done += f.stories.done;
    acc.inProgress += f.stories.inProgress; acc.blocked += f.stories.blocked;
    acc.deferred += f.stories.deferred; acc.pending += f.stories.pending;
    return acc;
  }, { total: 0, done: 0, inProgress: 0, blocked: 0, deferred: 0, pending: 0 });
}

// ── Text output ──────────────────────────────────────────────────

function printTextSummary(files, telemetry, gitMetrics, memMetrics, gateSummary = null, codeMetrics = null) {
  if (files.length === 0) { console.log('No TODO files found.'); return; }
  console.log('');
  for (const f of files) {
    const s = f.stories;
    const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
    const bar = progressBar(pct, 20);
    console.log(`  ${f.title}`);
    console.log(`  ${f.path}`);
    console.log(`  ${bar} ${pct}%  (${s.done}/${s.total} done`
      + (s.inProgress ? `, ${s.inProgress} active` : '')
      + (s.blocked ? `, ${s.blocked} blocked` : '')
      + (s.deferred ? `, ${s.deferred} deferred` : '') + ')');
    if (f.epics.length > 0) {
      for (const e of f.epics) {
        const icon = e.status === 'done' ? '[x]' : e.status === 'in_progress' ? '[>]' : e.status === 'blocked' ? '[!]' : e.status === 'deferred' ? '[~]' : '[ ]';
        console.log(`    ${icon} Epic ${e.id}: ${e.title} (${e.stories} stories, ~${e.estHours}h)`);
      }
    }
    console.log('');
  }
  const totals = computeGrandTotals(files);
  if (files.length > 1) {
    const pct = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;
    console.log(`  TOTAL: ${totals.done}/${totals.total} stories (${pct}%)`);
    console.log('');
  }
  if (!telemetry) {
    console.log('  Metrics: No telemetry data available');
  } else {
    console.log('  Metrics');
    const topCmds = Object.entries(telemetry.commands).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name} (${count})`).join(', ');
    console.log(`    Commands: ${topCmds || 'none'}`);
    const gateEntries = Object.entries(telemetry.gates);
    if (gateEntries.length > 0) {
      console.log(`    Gates: ${gateEntries.map(([name, g]) => `${name.replace('gate:', '')} ${g.rate}% pass`).join(', ')}`);
    } else {
      console.log('    Gates: no gate data');
    }
    const commitVelocity = gitMetrics ? gitMetrics.commits7d : 0;
    console.log(`    Commits (7d): ${commitVelocity}  |  Sessions: ${telemetry.sessions}`);
    if (telemetry.memoryBenchmark) {
      const mb = telemetry.memoryBenchmark;
      const tag = mb.rate >= 70 ? 'Green' : mb.rate >= 50 ? 'Yellow' : 'Red';
      console.log(`    Memory Hit Rate (30d): ${mb.rate}% [${tag}]  (${mb.hits}/${mb.total}${mb.meanRank !== null ? `, mean rank ${mb.meanRank}` : ''})`);
    }
    if (memMetrics && memMetrics.total > 0) {
      const tag = memMetrics.healthScore >= 50 ? 'Green' : memMetrics.healthScore >= 35 ? 'Yellow' : 'Red';
      const topCats = Object.entries(memMetrics.byCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      console.log(`    Memory: ${memMetrics.healthScore}/70 [${tag}]  (${memMetrics.total} total, ${memMetrics.staleCount} stale${topCats ? ` — ${topCats}` : ''})`);
    }
  }
  if (gateSummary && typeof gateSummary.overall === 'boolean') {
    const t = gateSummary.test || {};
    const tests = typeof t.total === 'number' && t.total > 0 ? `, ${t.passed ?? 0}/${t.total} tests` : '';
    const dur = typeof gateSummary.durationMs === 'number' ? `, ${(gateSummary.durationMs / 1000).toFixed(1)}s` : '';
    console.log(`    Build gate: ${gateSummary.overall ? 'PASS' : 'FAIL'} (${gateSummary.stack || 'unknown'}${tests}${dur})`);
  }
  if (codeMetrics && codeMetrics.fileCount > 0) {
    console.log(`    Code: ${codeMetrics.loc.toLocaleString('en-US')} LOC in ${codeMetrics.fileCount} source files`);
  }
  console.log('');
}

function progressBar(pct, width) {
  const filled = Math.round((pct / 100) * width);
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
}

// ── Master-index regeneration (S-PI.9) ───────────────────────────
//
// regenerateMasterIndex refreshes the generated projection — the master tracker
// TODO_{Project}.md — from its SINGLE source of record: the per-epic checklists
// (TODO_epicNN_*.md) plus backlog.md's phase→epic grouping. It NEVER invents
// rows. For every EXISTING row it refreshes BOTH the numerator (Done) AND the
// denominator (Stories) from the same checklists, so the two never diverge:
//   • Epic Index — Stories count + Status marker (resolved epics only).
//   • Phase Map  — per-phase Stories + Done + Status, and the grand Total row.
// SINGLE-SOURCE INVARIANT (the fix for the "Done 33 of 16" drift): when /todo
// splits an epic into more stories than the backlog planned (Markets Epic 7:
// planned 6 → scaffolded 24), the OLD regen recomputed Done from the expanded
// checklists but left Stories at the stale plan — so Done could exceed the total.
// Now Stories is recomputed from the same checklists, so a fully-built expanded
// epic reads 24/24, the phase reads 33/35, never 33/16. Unscaffolded epics (no
// checklist yet) keep their planned Stories count as the denominator fallback.
//
// Idempotent + offline: pure file reads + line-level string rewrites, no network,
// no new Date() unless opts.today is omitted. Running twice on the same checkbox
// state produces byte-identical output. Best-effort by contract — if no master
// index exists it returns { skipped:true } and writes nothing, so the lifecycle
// commands (/do, /end, /run-todo, /run-tests) can call it unconditionally.

// Split a markdown table row into trimmed cells (drops the leading/trailing ||).
function splitRow(line) {
  return line.split('|').slice(1, -1).map(c => c.trim());
}

// Reassemble a table row from cells, preserving the `| a | b |` shape.
function joinRow(cells) {
  return '| ' + cells.join(' | ') + ' |';
}

// Resolve a column index by NORMALIZED header name from a header row's cells.
// Header text is matched case-insensitively, trimmed, with a trailing period
// dropped ("Est." → "est"). Returns -1 when absent. Resolving columns by header
// — instead of a hardcoded index — keeps regen correct when a project's master
// tracker drifts from the canonical column layout (e.g. an adopter inserted a
// "Ph" column into the Epic Index, shifting Status from index 4 to 5; the old
// hardcoded cells[4] then clobbered the Est. column instead of Status).
function colIndex(headerCells, name) {
  const norm = (s) => String(s).toLowerCase().replace(/\.\s*$/, '').trim();
  const target = norm(name);
  return headerCells.findIndex((c) => norm(c) === target);
}

// Resolve an epic's per-epic checklist file from its Epic Index row.
// Prefer the link target in the Checklist column; fall back to globbing
// docs/work/todo/TODO_epic{NN}*.md. Returns an absolute path or null.
function resolveEpicChecklist(projectRoot, epicId, checklistCell) {
  const linkMatch = checklistCell && checklistCell.match(/\(([^)]+\.md)\)/);
  if (linkMatch) {
    const rel = linkMatch[1].replace(/^\.\//, '');
    const candidate = path.isAbsolute(rel) ? rel : path.join(projectRoot, 'docs', rel);
    if (fs.existsSync(candidate)) return candidate;
    // The link may be docs-root-relative without the docs/ prefix.
    const alt = path.join(projectRoot, rel);
    if (fs.existsSync(alt)) return alt;
  }
  const num = String(epicId).match(/\d+/);
  if (!num) return null;
  const nn = num[0].padStart(2, '0');
  const todoDir = path.join(projectRoot, 'docs', DOC_PATHS.todo);
  if (!fs.existsSync(todoDir)) return null;
  let entries;
  try { entries = fs.readdirSync(todoDir); } catch { return null; }
  const re = new RegExp(`^TODO_epic0*${num[0]}([^0-9].*)?\\.md$`, 'i');
  const hit = entries.find(f => re.test(f)) || entries.find(f => new RegExp(`^TODO_epic${nn}`, 'i').test(f));
  return hit ? path.join(todoDir, hit) : null;
}

// Build a phase-number → Set(epic-id strings) map from backlog.md's
// `## Phase N:` / `### Epic N:` grouping. Returns null if the backlog is
// absent/unparseable — callers then leave per-phase Done cells unchanged.
function buildPhaseEpicMap(projectRoot) {
  const backlogPath = path.join(projectRoot, 'docs', DOC_PATHS.backlog);
  if (!fs.existsSync(backlogPath)) return null;
  let content;
  try { content = fs.readFileSync(backlogPath, 'utf8'); } catch { return null; }
  const map = new Map();
  let currentPhase = null;
  for (const line of content.split('\n')) {
    const ph = line.match(/^##\s+Phase\s+(\d+)\b/i);
    if (ph) { currentPhase = ph[1]; if (!map.has(currentPhase)) map.set(currentPhase, new Set()); continue; }
    const ep = line.match(/^###\s+Epic\s+(\d+)\b/i);
    if (ep && currentPhase !== null) map.get(currentPhase).add(ep[1]);
  }
  return map.size > 0 ? map : null;
}

function regenerateMasterIndex(projectRoot, opts = {}) {
  const root = projectRoot || PROJECT_ROOT;
  // Find the master index via the existing finder (uses module-level PROJECT_ROOT).
  const masterFiles = findTodoFiles()
    .map(p => ({ path: p, parsed: parseTodoFile(p) }))
    .filter(f => f.parsed.type === 'master');
  if (masterFiles.length === 0) return { skipped: true, reason: 'no master index' };

  const masterPath = masterFiles[0].path;
  let content;
  try { content = fs.readFileSync(masterPath, 'utf8'); } catch (err) {
    return { skipped: true, reason: `unreadable master: ${err.message}` };
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const today = opts.today || new Date().toISOString().slice(0, 10);

  // Pass 1 — recompute each epic's real done/total from its checklist, and
  // capture its PLANNED story count (the Epic Index "Stories" cell) as the
  // denominator fallback for epics that aren't scaffolded yet.
  // epicStats: idKey -> { done, total, resolved:boolean, planned:number }
  //   resolved   → checklist exists; done/total come from it.
  //   !resolved  → no checklist; total falls back to planned, done is 0.
  const epicStats = new Map();

  // Several Epic Index rows may legitimately resolve to the SAME execution doc —
  // e.g. a multi-epic subsystem tracked in one checklist, which the master index
  // usually flags with a footnote. `parseTodoFile` then returns an identical
  // snapshot per referencing row, so summing over epic ids counts that file's
  // stories once PER ROW. Dedupe by resolved absolute path: a shared checklist
  // contributes exactly once. Unresolved epics carry no path and each keep their
  // own planned count, so this is a no-op for a 1:1 epic↔checklist project.
  // M1: Done must not regress while an epic is unresolved, because an unresolved
  // epic's progress cannot be recomputed and the prior value may be the only
  // record of it. But a prior figure is only trustworthy as a carry for THAT
  // un-recomputable part. Bounding it by `doneSum + unresolvedTotal` means a
  // stale prior — including one recorded against a since-corrected, inflated
  // denominator — can never inflate the result or push it past the total.
  // (A plain `max(doneSum, priorDone)` let a 627 survive a total correction to
  // 148; a plain `min(totalSum, …)` then just pinned it to 148/148 = 100%.)
  const clampCarriedDone = ({ doneSum, unresolvedTotal, priorDone, anyUnresolved }) => {
    if (!anyUnresolved) return doneSum;
    return Math.min(doneSum + unresolvedTotal, Math.max(doneSum, priorDone));
  };

  // A checklist referenced by MORE THAN ONE epic row is counted exactly once
  // in every total (that is what dedupeByChecklist above guarantees), but each referencing row still
  // renders that file's FULL Stories/Done figures. Summing the visible rows therefore overshoots the
  // headline total, which reads like an arithmetic bug rather than the deliberate dedupe it is —
  // and keeping those rows' Done cells maintained makes it louder, because they land on the same
  // number instead of drifting apart. Annotating the row is the honest fix; changing the parser
  // would break the dedupe that keeps the totals correct.
  // LAZY, not an IIFE: `epicStats` is declared empty here and populated further down, so computing
  // this eagerly yields an empty set and the annotation silently never fires. (It did exactly that
  // on the first run of this change — the marker count came back 0.) Memoized so the scan runs once
  // per regen rather than once per rendered row.
  let _sharedChecklists = null;
  const isSharedChecklist = (checklist) => {
    if (!checklist) return false;
    if (_sharedChecklists === null) {
      const counts = new Map();
      for (const s of epicStats.values()) {
        if (!s || !s.checklist) continue;
        counts.set(s.checklist, (counts.get(s.checklist) || 0) + 1);
      }
      _sharedChecklists = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k));
    }
    return _sharedChecklists.has(checklist);
  };
  // Idempotent by construction: regen runs repeatedly over its own output, so the marker is only
  // appended when absent. Kept free-text and confined to the Checklist column — never the numeric
  // cells, which parseMasterIndex reads back.
  const SHARED_MARKER = '— shared checklist, counted once in totals';

  const dedupeByChecklist = (stats) => {
    const seen = new Set();
    const out = [];
    for (const s of stats) {
      if (s && s.checklist) {
        if (seen.has(s.checklist)) continue;
        seen.add(s.checklist);
      }
      out.push(s);
    }
    return out;
  };
  let section = null;
  let epicHeader = null; // Epic Index header cells (for header-based columns)
  for (const line of lines) {
    if (/##\s+Phase Map/i.test(line)) { section = 'phases'; continue; }
    if (/##\s+Epic Index/i.test(line)) { section = 'epics'; epicHeader = null; continue; }
    if (/^##\s/.test(line)) { section = null; continue; }
    if (section !== 'epics' || !line.trim().startsWith('|') || line.includes('---')) continue;
    const cells = splitRow(line);
    if (/^epic$/i.test(normCellText(cells[0]))) { epicHeader = cells; continue; } // header row
    if (!epicHeader || cells.length < 2 || !/\d/.test(cells[0])) continue; // skip spacer/non-data
    const epicId = cells[0];
    const idKey = (epicId.match(/\d+/) || [epicId])[0];
    const storiesIdx = colIndex(epicHeader, 'Stories');
    const checklistIdx = colIndex(epicHeader, 'Checklist');
    const planned = parseInt(String(storiesIdx >= 0 ? cells[storiesIdx] : '').replace(/\D/g, ''), 10) || 0;
    const checklistPath = resolveEpicChecklist(root, epicId, checklistIdx >= 0 ? cells[checklistIdx] : '');
    if (checklistPath) {
      const parsed = parseTodoFile(checklistPath);
      epicStats.set(idKey, {
        done: parsed.stories.done, total: parsed.stories.total,
        blocked: parsed.stories.blocked, deferred: parsed.stories.deferred,
        resolved: true, planned,
        // Retained so sums can dedupe: several epic rows may share ONE checklist.
        checklist: path.resolve(checklistPath),
      });
    } else {
      epicStats.set(idKey, { done: 0, total: planned, blocked: 0, deferred: 0, resolved: false, planned, checklist: null });
    }
  }

  // Status marker from the checklist's story markers. all done → [x]; any story
  // blocked → [!]; some done → [>]; any deferred → [~]; none → [ ]. Deriving
  // blocked/deferred from the checklist (M4) stops regen from silently reverting
  // a hand-set [!] BLOCKED / [~] DEFERRED epic to [>] on every /do,/end call.
  const markerFor = (done, total, blocked = 0, deferred = 0) => {
    if (total > 0 && done >= total) return '[x]';
    if (blocked > 0) return '[!]';
    if (done > 0) return '[>]';
    if (deferred > 0) return '[~]';
    return '[ ]';
  };
  // An epic's denominator: actual checklist total when resolved, else the plan.
  const totalOf = (s) => (s.resolved ? s.total : s.planned);

  // Grand total across EVERY epic (resolved contributes actual, unresolved
  // contributes planned total + 0 done), deduped by shared checklist. One
  // computation, two consumers: the Phase Map Total row and the Epic Index Total
  // row — they must never disagree.
  const grandTotals = () => {
    let doneSum = 0; let totalSum = 0; let anyUnresolved = false; let unresolvedTotal = 0;
    for (const s of dedupeByChecklist(epicStats.values())) {
      totalSum += totalOf(s);
      if (s.resolved) doneSum += s.done; else { anyUnresolved = true; unresolvedTotal += totalOf(s); }
    }
    return { doneSum, totalSum, anyUnresolved, unresolvedTotal };
  };

  const phaseEpicMap = buildPhaseEpicMap(root);
  let epicsRefreshed = 0;
  // Silent-no-op counters. Every one of these paths previously left a row
  // frozen and still reported "master tracker refreshed", so a tracker could go
  // stale indefinitely with no signal. They are DIAGNOSTICS, not failures — regen
  // stays best-effort by contract.
  const backlogMapMissing = phaseEpicMap === null;
  let phasesSkipped = 0;
  const epicsUnresolved = [...epicStats.entries()].filter(([, s]) => !s.resolved).map(([id]) => id);

  // Pass 2 — rewrite Epic Index Stories+Status cells, Phase Map Stories+Done+
  // Status (per-phase and Total), and the Last-updated date. Columns are resolved
  // by HEADER NAME (colIndex), never hardcoded indices — see colIndex's note.
  section = null;
  epicHeader = null;
  let phaseHeader = null;
  const out = lines.map((line) => {
    // Last updated line.
    if (/^>\s*Last updated:/i.test(line)) {
      return line.replace(/(Last updated:\s*).*/i, `$1${today}`);
    }
    if (/##\s+Phase Map/i.test(line)) { section = 'phases'; phaseHeader = null; return line; }
    if (/##\s+Epic Index/i.test(line)) { section = 'epics'; epicHeader = null; return line; }
    if (/^##\s/.test(line)) { section = null; return line; }

    if (!line.trim().startsWith('|') || line.includes('---')) return line;

    if (section === 'epics') {
      const cells = splitRow(line);
      if (/^epic$/i.test(normCellText(cells[0]))) { epicHeader = cells; return line; } // header
      if (!epicHeader) return line;
      const storiesIdx = colIndex(epicHeader, 'Stories');
      const doneIdx = colIndex(epicHeader, 'Done');
      const statusIdx = colIndex(epicHeader, 'Status');

      // The Epic Index's own grand-total row, when the tracker carries one. It was
      // unreachable before — the `/\d/.test(cells[0])` data-row guard rejects
      // `**Total**` — so an Epic Index Total went stale forever alongside a
      // correctly-refreshed Phase Map Total.
      if (isTotalCell(cells[0])) {
        const g = grandTotals();
        const priorDone = parseInt(String(cells[doneIdx >= 0 ? doneIdx : -1] || '').replace(/\D/g, ''), 10) || 0;
        const newDone = clampCarriedDone({ ...g, priorDone });
        if (storiesIdx >= 0) cells[storiesIdx] = `**${g.totalSum}**`;
        if (doneIdx >= 0) cells[doneIdx] = `**${newDone}**`;
        return joinRow(cells);
      }

      if (!/\d/.test(cells[0] || '')) return line;
      const idKey = (cells[0].match(/\d+/) || [cells[0]])[0];
      const stat = epicStats.get(idKey);
      if (!stat || !stat.resolved) return line; // missing checklist → unchanged
      if (storiesIdx >= 0) cells[storiesIdx] = String(stat.total);
      // Done was never refreshed here, only Stories+Status — so a shrinking
      // denominator left rows like "Stories 18 / Done 52" in the live tracker.
      if (doneIdx >= 0) cells[doneIdx] = String(stat.done);
      if (statusIdx >= 0) cells[statusIdx] = markerFor(stat.done, stat.total, stat.blocked, stat.deferred);
      const checklistIdx = colIndex(epicHeader, 'Checklist');
      if (checklistIdx >= 0 && isSharedChecklist(stat.checklist)) {
        const cur = String(cells[checklistIdx] || '');
        if (!cur.includes(SHARED_MARKER)) cells[checklistIdx] = `${cur.trim()} ${SHARED_MARKER}`.trim();
      }
      epicsRefreshed++;
      return joinRow(cells);
    }

    if (section === 'phases') {
      const cells = splitRow(line);
      if (/^phase$/i.test(normCellText(cells[0]))) { phaseHeader = cells; return line; } // header
      if (!phaseHeader) return line;
      const storiesIdx = colIndex(phaseHeader, 'Stories');
      const doneIdx = colIndex(phaseHeader, 'Done');
      const statusIdx = colIndex(phaseHeader, 'Status');
      if (doneIdx < 0 || storiesIdx < 0) return line; // unrecognizable Phase Map

      // Recognized by normalized text, so a plain `| Total |` behaves exactly like
      // the canonical bold `| **Total** |`.
      if (isTotalCell(cells[0])) {
        // Grand total: Stories AND Done both summed across EVERY epic, so
        // numerator and denominator share one source. Done never lowers while any
        // epic is unresolved (M1 — it may carry un-recomputable prior progress).
        const { doneSum, totalSum, anyUnresolved, unresolvedTotal } = grandTotals();
        const priorDone = parseInt(String(cells[doneIdx]).replace(/\D/g, ''), 10) || 0;
        const newDone = clampCarriedDone({ doneSum, unresolvedTotal, priorDone, anyUnresolved });
        const pct = totalSum > 0 ? Math.round((newDone / totalSum) * 100) : 0;
        cells[storiesIdx] = `**${totalSum}**`;
        cells[doneIdx] = `**${newDone}**`;
        if (statusIdx >= 0) cells[statusIdx] = `**${pct}%**`;
        return joinRow(cells);
      }

      // Per-phase row: recompute Stories + Done from this phase's epics (needs the
      // backlog phase→epic map). Without it, leave the row unchanged.
      const phaseId = (cells[0].match(/\d+/) || [])[0];
      if (!phaseEpicMap || phaseId == null || !phaseEpicMap.has(phaseId)) { phasesSkipped++; return line; }
      const epicsInPhase = phaseEpicMap.get(phaseId);
      let doneSum = 0; let totalSum = 0; let allResolvedDone = true;
      let anyResolved = false; let anyUnresolved = false; let unresolvedTotal = 0;
      // Dedupe WITHIN the phase too — two epics in one phase can share a checklist.
      for (const s of dedupeByChecklist([...epicsInPhase].map(eid => epicStats.get(eid)))) {
        if (!s) { allResolvedDone = false; anyUnresolved = true; continue; }
        totalSum += totalOf(s);
        if (!s.resolved) { allResolvedDone = false; anyUnresolved = true; unresolvedTotal += totalOf(s); continue; }
        anyResolved = true;
        doneSum += s.done;
        if (!(s.total > 0 && s.done >= s.total)) allResolvedDone = false;
      }
      // Stories: the recomputed denominator (actual where built, planned where
      // not). Done: refreshed from resolved epics, but NEVER LOWERED while the
      // phase has an unresolved epic (M1 — only moves forward).
      const priorDone = parseInt(String(cells[doneIdx]).replace(/\D/g, ''), 10) || 0;
      const newDone = clampCarriedDone({ doneSum, unresolvedTotal, priorDone, anyUnresolved });
      cells[storiesIdx] = String(totalSum);
      cells[doneIdx] = String(newDone);
      // COMPLETE only when every epic in the phase is resolved AND done; a partial
      // phase with real work shows IN PROGRESS, never a premature COMPLETE.
      if (statusIdx >= 0) {
        if (anyResolved && allResolvedDone && epicsInPhase.size > 0) cells[statusIdx] = 'COMPLETE';
        else if (newDone > 0) cells[statusIdx] = 'IN PROGRESS';
        else cells[statusIdx] = 'PENDING';
      }
      return joinRow(cells);
    }

    return line;
  });

  const newContent = out.join(eol);
  if (newContent !== content) {
    try { fs.writeFileSync(masterPath, newContent, 'utf8'); } catch (err) {
      return { skipped: true, reason: `write failed: ${err.message}` };
    }
  }
  return {
    updated: true,
    path: path.relative(root, masterPath).replace(/\\/g, '/'),
    epicsRefreshed,
    changed: newContent !== content,
    backlogMapMissing,
    phasesSkipped,
    epicsUnresolved,
  };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  // --regen-master: refresh the master tracker projection only, NO HTML dashboard.
  // Best-effort + silent no-op when no master index exists (lifecycle commands
  // call this unconditionally). Default `node status.js` behavior is unchanged.
  if (process.argv.includes('--regen-master')) {
    const res = regenerateMasterIndex(PROJECT_ROOT);
    if (res.skipped) { console.log(`  [status] master tracker: skipped (${res.reason})`); return; }
    console.log(`  [status] master tracker refreshed: ${res.path} (${res.epicsRefreshed} epics)`);
    // Surface the partial-refresh paths — silently frozen rows used to read as a
    // clean success.
    if (res.backlogMapMissing) {
      console.log(`  [status] warning: no '## Phase N' / '### Epic N' grouping found in the backlog — every per-phase row left unchanged`);
    } else if (res.phasesSkipped > 0) {
      console.log(`  [status] warning: ${res.phasesSkipped} phase row(s) left unchanged (no numeric phase id, or phase absent from the backlog map)`);
    }
    if (res.epicsUnresolved.length > 0) {
      console.log(`  [status] warning: ${res.epicsUnresolved.length} epic(s) left unchanged — no checklist resolved: ${res.epicsUnresolved.join(', ')}`);
    }
    return;
  }

  const todoFiles = findTodoFiles();
  const parsed    = todoFiles.map(parseTodoFile);

  // Load metrics — three delegated loaders + inline telemetry
  const codeMetrics     = loadCodeMetrics(PROJECT_ROOT);
  const memMetricsPromise = loadMemoryMetrics(PROJECT_ROOT);
  const gitMetrics      = loadGitMetrics(PROJECT_ROOT);
  const gateSummary     = readSummary(PROJECT_ROOT) ?? null;
  const telemetry       = computeTelemetryMetrics(PROJECT_ROOT);

  const memMetrics = await memMetricsPromise;

  printTextSummary(parsed, telemetry, gitMetrics, memMetrics, gateSummary, codeMetrics);

  if (!TEXT_ONLY) {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const html = generateHtml(parsed, telemetry, gitMetrics, OUTPUT_DIR, memMetrics, gateSummary, codeMetrics);
    fs.writeFileSync(OUTPUT_FILE, html, 'utf8');
    console.log(`  Dashboard: ${path.relative(PROJECT_ROOT, OUTPUT_FILE)}`);
    try {
      const { generateDecisionsHtml } = require('./decision-viz');
      const decisionsFile = path.join(OUTPUT_DIR, 'decisions.html');
      generateDecisionsHtml({ outputPath: decisionsFile });
      console.log(`  Decisions:  ${path.relative(PROJECT_ROOT, decisionsFile)}`);
    } catch (err) {
      process.stderr.write(`  [status] decisions.html skipped: ${err.message}\n`);
    }
    console.log('');
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}

// Public API — note: `generateHtml` and `esc` are re-exports from `_lib/status-html`.
// After the P2.4 split, `generateHtml(files, telemetry, gitMetrics, outputDir)`
// is the canonical signature. Earlier single-arg callers (if any existed in
// downstream projects) must migrate — the new signature is NOT backward-compat.
module.exports = { findTodoFiles, parseTodoFile, computeTelemetryMetrics, computeGrandTotals, generateHtml, printTextSummary, esc, regenerateMasterIndex };
