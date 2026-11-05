#!/usr/bin/env node

/**
 * Metrics — Compute workflow metrics from telemetry, git, and TODO data.
 *
 * Usage:
 *   node .claude/core/metrics.js report           # JSON to stdout
 *   node .claude/core/metrics.js report --pretty  # Human-readable output
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getJsonlPath } = require('./_lib/telemetry-paths');
const { compartmentDir } = require('./_lib/output-paths');

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');

// ── Telemetry ────────────────────────────────────────────────────

function computeTelemetry() {
  const telemetryPath = getJsonlPath(PROJECT_ROOT, 'command-usage.jsonl');

  if (!fs.existsSync(telemetryPath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(telemetryPath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  if (events.length === 0) return null;

  const command_frequency = {};
  const gate_results = {};

  for (const evt of events) {
    if (evt.type === 'command_invocation') {
      const cmd = evt.command || 'unknown';
      command_frequency[cmd] = (command_frequency[cmd] || 0) + 1;
    } else if (evt.type === 'gate_run') {
      const cmd = evt.command || 'unknown';
      if (!gate_results[cmd]) {
        gate_results[cmd] = { pass: 0, fail: 0, pass_rate: 0 };
      }
      // Normalize outcome vocab: 'success'/'failure' (current schema) plus
      // legacy 'pass'/'fail' from pre-A4 JSONL. 'unknown' carries no signal —
      // ignore it (matches status.js). Counting it as fail inflates fail rate.
      if (evt.outcome === 'success' || evt.outcome === 'pass') {
        gate_results[cmd].pass++;
      } else if (evt.outcome === 'failure' || evt.outcome === 'fail') {
        gate_results[cmd].fail++;
      }
    }
  }

  // Compute pass rates
  for (const cmd of Object.keys(gate_results)) {
    const r = gate_results[cmd];
    const total = r.pass + r.fail;
    r.pass_rate = total > 0 ? parseFloat(((r.pass / total) * 100).toFixed(1)) : 0;
  }

  return {
    command_frequency,
    gate_results,
    total_events: events.length,
  };
}

// ── Git ──────────────────────────────────────────────────────────

function computeGit() {
  let raw;
  try {
    raw = execSync('git log --oneline --date=short --format="%ad %s" -100', {
      encoding: 'utf8',
      timeout: 5000,
      cwd: PROJECT_ROOT,
      windowsHide: true,
    });
  } catch {
    return null;
  }

  if (!raw || !raw.trim()) return null;

  const lines = raw.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const commits_by_day = {};
  const type_breakdown = { feat: 0, fix: 0, docs: 0, refactor: 0, chore: 0 };
  let commits_last_30d = 0;

  for (const line of lines) {
    // Format: "2026-04-11 feat: wave 1 — ..."
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/);
    if (!dateMatch) continue;

    const date = dateMatch[1];
    const subject = dateMatch[2];

    if (date >= cutoffStr) {
      commits_last_30d++;
      commits_by_day[date] = (commits_by_day[date] || 0) + 1;
    }

    // Detect conventional commit type prefix
    const typeMatch = subject.match(/^(feat|fix|docs|refactor|chore)[\s(:]/i);
    if (typeMatch) {
      const t = typeMatch[1].toLowerCase();
      if (t in type_breakdown) {
        type_breakdown[t]++;
      }
    }
  }

  return {
    commits_last_30d,
    commits_by_day,
    type_breakdown,
  };
}

// ── TODOs ────────────────────────────────────────────────────────

function findTodoFiles() {
  const found = new Set();
  const SKIP_DIRS = new Set(['.archive', '.output', 'node_modules', '.git']);

  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /^TODO.*\.md$/i.test(entry.name)) {
        found.add(full);
      } else if (entry.isDirectory()) {
        scanDir(full);
      }
    }
  };

  scanDir(path.join(PROJECT_ROOT, 'docs'));
  return [...found].sort();
}

function parseTodoFileStories(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const stories = { total: 0, done: 0, in_progress: 0, blocked: 0, deferred: 0, pending: 0 };

  const isMasterIndex = /## Phase Map/i.test(content) || /## Epic Index/i.test(content);

  if (isMasterIndex) {
    // Parse phase map table for story counts
    let section = null;
    for (const line of lines) {
      if (/## Phase Map/i.test(line)) { section = 'phases'; continue; }
      if (/## Epic Index/i.test(line)) { section = 'epics'; continue; }
      if (/^## /.test(line) && section) { section = null; continue; }

      if (section === 'phases' && line.startsWith('|') && !line.includes('---') && !line.includes('Phase')) {
        const cols = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length >= 7) {
          stories.total += parseInt(cols[4]) || 0;
          stories.done += parseInt(cols[5]) || 0;
        }
      }

      if (section === 'epics' && line.startsWith('|') && !line.includes('---') && !line.includes('Epic')) {
        // Epic index has status in column 5 (0-indexed)
        const cols = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length >= 6) {
          const storyCount = parseInt(cols[3]) || 0;
          const statusRaw = cols[5].trim();
          const status = /\[x\]/i.test(statusRaw) ? 'done'
            : /\[>\]/.test(statusRaw) ? 'in_progress'
              : /\[!\]/.test(statusRaw) ? 'blocked'
                : /\[~\]/.test(statusRaw) ? 'deferred'
                  : 'pending';
          if (stories.total === 0) {
            // Only accumulate from epics if phases didn't provide counts
            stories.total += storyCount;
            stories[status] = (stories[status] || 0) + storyCount;
          }
        }
      }
    }

    // If phases provided totals, compute pending from remainder
    if (stories.total > 0) {
      stories.pending = stories.total - stories.done - stories.in_progress - stories.blocked - stories.deferred;
      if (stories.pending < 0) stories.pending = 0;
    }
  } else {
    // Checklist: count story-level checkboxes.
    // Kept deliberately in lockstep with status.js's parseChecklist() — this is a
    // SECOND, independent implementation of the same count, and it carried the same
    // two defects:
    //   1. Matching against `line.trim()` counted INDENTED bold AC bullets as stories.
    //   2. No bold-vs-table mutual exclusion, so a file carrying BOTH a body checklist
    //      and a Story Index table had every story counted twice (an 80-story file
    //      reported 141: 80 bold + 61 table).
    // Both tests below now match the RAW line, and the table path is suppressed when
    // top-level bold stories exist — same rule, same result, as status.js.
    const hasBoldCheckboxStories = lines.some(l => /^- \[.\] \*\*/.test(l));
    for (const line of lines) {
      const checkboxMatch = line.match(/- \[([ x>!~])\]/);
      const tableStatusMatch = hasBoldCheckboxStories ? null : line.match(/\|\s*\[([ x>!~])\]\s*\|/);
      const marker = checkboxMatch ? checkboxMatch[1] : tableStatusMatch ? tableStatusMatch[1] : null;

      if (marker === null) continue;

      // Only count story-level checkboxes (bold, at column 0): - [ ] **4.1 ...
      if (checkboxMatch) {
        const isBoldStory = /^- \[.\] \*\*/.test(line);
        if (!isBoldStory) continue;
      }

      stories.total++;
      switch (marker) {
        case 'x': stories.done++; break;
        case '>': stories.in_progress++; break;
        case '!': stories.blocked++; break;
        case '~': stories.deferred++; break;
        default: stories.pending++; break;
      }
    }
  }

  return stories;
}

function computeTodos() {
  const files = findTodoFiles();
  if (files.length === 0) return null;

  const totals = { total: 0, done: 0, in_progress: 0, blocked: 0, deferred: 0, pending: 0 };

  for (const f of files) {
    const s = parseTodoFileStories(f);
    if (!s) continue;
    totals.total += s.total;
    totals.done += s.done;
    totals.in_progress += s.in_progress;
    totals.blocked += s.blocked;
    totals.deferred += s.deferred;
    totals.pending += s.pending;
  }

  if (totals.total === 0) return null;

  const completion_rate = parseFloat(((totals.done / totals.total) * 100).toFixed(1));

  return {
    files: files.length,
    total: totals.total,
    done: totals.done,
    in_progress: totals.in_progress,
    blocked: totals.blocked,
    deferred: totals.deferred,
    pending: totals.pending,
    completion_rate,
  };
}

// ── Sessions ─────────────────────────────────────────────────────

function computeSessions() {
  // ADR 0006 "only door": resolve the sessions compartment through output-paths.js
  // (registered as OUTPUT_PATHS['state/sessions']) rather than re-deriving the literal.
  const sessionsDir = path.join(PROJECT_ROOT, compartmentDir('state/sessions'));

  if (!fs.existsSync(sessionsDir)) return null;

  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const dates = entries
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort();

  if (dates.length === 0) return null;

  return {
    total: dates.length,
    dates,
  };
}

// ── Report ───────────────────────────────────────────────────────

function buildReport() {
  return {
    telemetry: computeTelemetry(),
    git: computeGit(),
    todos: computeTodos(),
    sessions: computeSessions(),
    generated: new Date().toISOString(),
  };
}

// ── Pretty Output ────────────────────────────────────────────────

function prettyReport(report) {
  const date = report.generated.slice(0, 10);
  const lines = [];

  lines.push(`Workflow Metrics (${date})`);
  lines.push('');

  // Telemetry
  if (report.telemetry) {
    const t = report.telemetry;
    lines.push('  Telemetry');

    const cmdEntries = Object.entries(t.command_frequency)
      .sort((a, b) => b[1] - a[1]);
    if (cmdEntries.length > 0) {
      const cmdStr = cmdEntries.map(([k, v]) => `${k} (${v})`).join(', ');
      lines.push(`    Commands: ${cmdStr}`);
    }

    const gateEntries = Object.entries(t.gate_results)
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (gateEntries.length > 0) {
      const gateStr = gateEntries.map(([k, v]) => {
        const label = k.replace('gate:', '');
        const total = v.pass + v.fail;
        return `${label} ${v.pass_rate}% pass (${v.pass}/${total})`;
      }).join(', ');
      lines.push(`    Gates: ${gateStr}`);
    }

    lines.push(`    Total events: ${t.total_events}`);
  } else {
    lines.push('  Telemetry: no data');
  }

  lines.push('');

  // Git
  if (report.git) {
    const g = report.git;
    lines.push('  Git (last 30 days)');
    lines.push(`    Commits: ${g.commits_last_30d}`);

    const typeEntries = Object.entries(g.type_breakdown)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (typeEntries.length > 0) {
      const typeStr = typeEntries.map(([k, v]) => `${k} (${v})`).join(', ');
      lines.push(`    Types: ${typeStr}`);
    }
  } else {
    lines.push('  Git: no data');
  }

  lines.push('');

  // TODOs
  if (report.todos) {
    const td = report.todos;
    lines.push('  TODOs');
    lines.push(`    ${td.files} file${td.files !== 1 ? 's' : ''}, ${td.total} stories, ${td.completion_rate}% complete`);
    lines.push(`    Done: ${td.done}, Active: ${td.in_progress}, Blocked: ${td.blocked}, Pending: ${td.pending}`);
  } else {
    lines.push('  TODOs: no data');
  }

  lines.push('');

  // Sessions
  if (report.sessions) {
    lines.push(`  Sessions: ${report.sessions.total}`);
  } else {
    lines.push('  Sessions: no data');
  }

  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const pretty = args.includes('--pretty');

  if (command === 'report') {
    const report = buildReport();
    if (pretty) {
      console.log(prettyReport(report));
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
  } else {
    const msg = [
      'Usage:',
      '  node metrics.js report           # JSON report to stdout',
      '  node metrics.js report --pretty  # Human-readable output',
    ].join('\n');
    console.error(msg);
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { buildReport, prettyReport, computeTelemetry, computeGit, computeTodos, findTodoFiles, parseTodoFileStories };
