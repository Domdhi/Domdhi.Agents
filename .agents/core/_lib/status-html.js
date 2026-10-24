/**
 * Status HTML — HTML dashboard generation for status.js.
 *
 * Extracted from status.js (P2.4) to reduce the orchestrator file to ≤350 LOC.
 * All rendering logic lives here; status.js owns data loading and coordinates calls.
 *
 * Exports:
 *   generateHtml(files, telemetry, gitMetrics, outputDir) → string  — full HTML page
 *   renderMemoryHitRateBox(mb) → string                             — inline HTML fragment
 *   esc(str) → string                                               — HTML escape
 */

const fs = require('fs');
const path = require('path');
const { esc } = require('./html-escape');

/**
 * Memory Hit Rate summary box with traffic-light color (AMEM-8.1).
 * Green >=70%, Yellow 50-69%, Red <50% per design review Addendum A.
 *
 * @param {{ rate: number, hits: number, total: number, meanRank: number|null }|null} mb
 * @returns {string}  HTML fragment or empty string
 */
function renderMemoryHitRateBox(mb) {
    if (!mb) return '';
    const color = mb.rate >= 70 ? '#3fb950' : mb.rate >= 50 ? '#d29922' : '#da3633';
    return `<div class="summary-box" title="${mb.hits} hits / ${mb.total} runs (last 30d)${mb.meanRank !== null ? `, mean rank ${mb.meanRank}` : ''}">
          <div class="number" style="color:${color}">${mb.rate}%</div>
          <div class="label">Memory Hit Rate (30d)</div>
        </div>`;
}

/**
 * Memory Health summary box surfacing memory store metrics from
 * _lib/memory-metrics.loadMemoryMetrics. Score is on a 0–70 scale (lint score),
 * traffic-light colored. Stale count and total are shown in the title.
 * Closes the M-3 deferred integration from the P2.4 code review.
 *
 * @param {{ total: number, byCategory: Record<string, number>, healthScore: number, staleCount: number }|null} mm
 * @returns {string}  HTML fragment or empty string
 */
function renderMemoryHealthBox(mm) {
    if (!mm || mm.total === 0) return '';
    // healthScore is 0-70 (lintMemories scale). Traffic-light at 50/35.
    const color = mm.healthScore >= 50 ? '#3fb950' : mm.healthScore >= 35 ? '#d29922' : '#da3633';
    const topCats = Object.entries(mm.byCategory)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([k, v]) => `${esc(k)}:${v}`)
        .join(' / ');
    const titleParts = [`${mm.total} memories`, `${mm.staleCount} stale`];
    if (topCats) titleParts.push(`top: ${topCats}`);
    return `<div class="summary-box" title="${esc(titleParts.join(' • '))}">
          <div class="number" style="color:${color}">${mm.healthScore}<span style="font-size:0.6em;color:#8b949e">/70</span></div>
          <div class="label">Memory Health</div>
        </div>`;
}

/**
 * Build-gate status box from the latest gate run summary
 * (_latest-summary.json via _lib/gate-summary.readSummary). PASS/FAIL
 * traffic-light; test counts and duration in the hover title.
 *
 * @param {{ overall: boolean, mode?: string, stack?: string, durationMs?: number, test?: { passed?: number, failed?: number, total?: number } }|null} gs
 * @returns {string}  HTML fragment or empty string
 */
function renderGateStatusBox(gs) {
    if (!gs || typeof gs.overall !== 'boolean') return '';
    const color = gs.overall ? '#3fb950' : '#da3633';
    const titleParts = [];
    if (gs.mode) titleParts.push(esc(gs.mode));
    if (gs.stack) titleParts.push(esc(gs.stack));
    if (gs.test && typeof gs.test.total === 'number' && gs.test.total > 0) {
        titleParts.push(`${gs.test.passed ?? 0}/${gs.test.total} tests passed`);
    }
    if (typeof gs.durationMs === 'number') titleParts.push(`${(gs.durationMs / 1000).toFixed(1)}s`);
    return `<div class="summary-box" title="${titleParts.join(' • ')}">
          <div class="number" style="color:${color}">${gs.overall ? 'PASS' : 'FAIL'}</div>
          <div class="label">Build Gate</div>
        </div>`;
}

/**
 * Code-size box from _lib/code-metrics.loadCodeMetrics — a point-in-time
 * LOC snapshot (no history is kept, so no trend line). Top directories
 * in the hover title.
 *
 * @param {{ loc: number, fileCount: number, byDir: Record<string, number> }|null} cm
 * @returns {string}  HTML fragment or empty string
 */
function renderCodeSizeBox(cm) {
    if (!cm || cm.fileCount === 0) return '';
    const topDirs = Object.entries(cm.byDir)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${esc(k)}: ${v.toLocaleString('en-US')}`)
        .join(' • ');
    const title = `${cm.fileCount} source files${topDirs ? ` • ${topDirs}` : ''}`;
    return `<div class="summary-box" title="${title}">
          <div class="number">${cm.loc.toLocaleString('en-US')}</div>
          <div class="label">Lines of Code</div>
        </div>`;
}

/**
 * Generate the full project status HTML dashboard.
 *
 * @param {Array}  files      Parsed TODO file objects from parseTodoFile()
 * @param {object|null} telemetry  Telemetry metrics from computeTelemetryMetrics()
 * @param {object|null} gitMetrics Git metrics from loadGitMetrics()
 * @param {string} outputDir  Absolute path to docs/.output/ (for decisions.html link check)
 * @param {object|null} [memMetrics] Memory metrics from loadMemoryMetrics() —
 *   `{ total, byCategory, healthScore, staleCount }`. When null/empty, the
 *   memory box is omitted (backward-compat with pre-P2.4-followup callers).
 * @param {object|null} [gateSummary] Latest gate run from readSummary() —
 *   renders a PASS/FAIL Build Gate box; omitted when null.
 * @param {object|null} [codeMetrics] Snapshot from loadCodeMetrics() —
 *   renders a Lines of Code box; omitted when null/empty.
 * @returns {string}  Complete HTML page as a string
 */
function generateHtml(files, telemetry, gitMetrics, outputDir, memMetrics = null, gateSummary = null, codeMetrics = null) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Dedup master vs per-epic before aggregating — a master index already
    // counts every story, so summing it with the per-epic checklists
    // double-counts (F21). Mirrors computeGrandTotals() in status.js (inlined
    // here to avoid a require cycle — status.js requires this module).
    const masters = files.filter(f => f.type === 'master');
    const totalSource = masters.length > 0 ? masters : files;
    const totals = totalSource.reduce((acc, f) => {
        acc.total += f.stories.total;
        acc.done += f.stories.done;
        acc.inProgress += f.stories.inProgress;
        acc.blocked += f.stories.blocked;
        acc.deferred += f.stories.deferred;
        acc.pending += f.stories.pending;
        return acc;
    }, { total: 0, done: 0, inProgress: 0, blocked: 0, deferred: 0, pending: 0 });

    const overallPct = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;

    let fileCards = '';
    for (const f of files) {
        const s = f.stories;
        const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;

        let epicRows = '';
        if (f.epics.length > 0) {
            epicRows = `<table class="epic-table">
        <tr><th>Epic</th><th>Title</th><th>Stories</th><th>Est.</th><th>Status</th></tr>
        ${f.epics.map(e => `<tr>
          <td>${esc(e.id)}</td>
          <td>${esc(e.title)}</td>
          <td>${e.stories}</td>
          <td>${e.estHours}h</td>
          <td><span class="badge badge-${e.status}">${e.status.replace('_', ' ')}</span></td>
        </tr>`).join('\n')}
      </table>`;
        }

        fileCards += `
    <div class="card">
      <h2>${esc(f.title)}</h2>
      <p class="filepath">${esc(f.path)}</p>
      <div class="progress-container">
        <div class="progress-bar" style="width: ${pct}%"></div>
        <span class="progress-label">${pct}%</span>
      </div>
      <div class="stats">
        <span class="stat stat-done">${s.done} done</span>
        <span class="stat stat-active">${s.inProgress} active</span>
        <span class="stat stat-blocked">${s.blocked} blocked</span>
        <span class="stat stat-deferred">${s.deferred} deferred</span>
        <span class="stat stat-pending">${s.pending} pending</span>
        <span class="stat stat-total">${s.total} total</span>
      </div>
      ${epicRows}
    </div>`;
    }

    // Build metrics card
    const commitVelocity = gitMetrics ? gitMetrics.commits7d : 0;
    const sessions = telemetry ? telemetry.sessions : 0;
    const memoryBenchmark = telemetry ? telemetry.memoryBenchmark : null;

    let metricsCard;
    if (!telemetry) {
        metricsCard = `
    <div class="card">
      <h2>Workflow Metrics</h2>
      <p class="no-data" style="padding: 1.5rem 0;">No telemetry data available</p>
    </div>`;
    } else {
        const topCmds = Object.entries(telemetry.commands)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        const maxCount = topCmds.length > 0 ? topCmds[0][1] : 1;

        const cmdBars = topCmds.length === 0
            ? '<p style="color:#8b949e;font-size:0.85rem;">No command data</p>'
            : topCmds.map(([name, count]) => {
                const barPct = Math.round((count / maxCount) * 100);
                return `<div class="cmd-row">
            <span class="cmd-label">${esc(name)}</span>
            <div class="cmd-bar-container">
              <div class="cmd-bar" style="width:${barPct}%"></div>
            </div>
            <span class="cmd-count">${count}</span>
          </div>`;
            }).join('\n');

        const gateEntries = Object.entries(telemetry.gates);
        const gateBadges = gateEntries.length === 0
            ? '<span style="color:#8b949e;font-size:0.85rem;">No gate data</span>'
            : gateEntries.map(([name, g]) => {
                const cls = g.rate >= 80 ? 'badge-gate-green' : g.rate >= 50 ? 'badge-gate-yellow' : 'badge-gate-red';
                const label = esc(name.replace('gate:', ''));
                return `<span class="badge-gate ${cls}">${label} ${g.rate}%</span>`;
            }).join(' ');

        metricsCard = `
    <div class="card">
      <h2>Workflow Metrics</h2>
      <div class="metrics-grid">
        <div class="metrics-section">
          <h3 class="metrics-section-title">Command Frequency</h3>
          <div class="cmd-chart">${cmdBars}</div>
        </div>
        <div class="metrics-section">
          <h3 class="metrics-section-title">Gate Pass Rate</h3>
          <div class="gate-badges">${gateBadges}</div>
        </div>
      </div>
      <div class="metrics-summary">
        <div class="summary-box">
          <div class="number">${commitVelocity}</div>
          <div class="label">Commits (7d)</div>
        </div>
        <div class="summary-box">
          <div class="number">${sessions}</div>
          <div class="label">Sessions</div>
        </div>
        ${renderGateStatusBox(gateSummary)}
        ${renderCodeSizeBox(codeMetrics)}
        ${renderMemoryHitRateBox(memoryBenchmark)}
        ${renderMemoryHealthBox(memMetrics)}
      </div>
    </div>`;
    }

    const decisionsLink = fs.existsSync(path.join(outputDir, 'decisions.html'))
        ? '<a href="decisions.html" style="background:#21262d;border:1px solid #30363d;color:#c9d1d9;border-radius:6px;padding:4px 12px;font-size:0.8rem;text-decoration:none;">View Decisions</a>'
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Project Status</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { color: #f0f6fc; margin-bottom: 0.25rem; font-size: 1.5rem; }
  .meta { color: #8b949e; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .summary { display: flex; gap: 1.5rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .summary-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.5rem; text-align: center; min-width: 120px; }
  .summary-box .number { font-size: 2rem; font-weight: 700; color: #f0f6fc; }
  .summary-box .label { font-size: 0.8rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary-box.highlight .number { color: #3fb950; }
  .progress-container { background: #21262d; border-radius: 4px; height: 24px; position: relative; margin: 0.75rem 0; overflow: hidden; }
  .progress-bar { background: linear-gradient(90deg, #238636, #3fb950); height: 100%; border-radius: 4px; transition: width 0.3s; min-width: 2px; }
  .progress-label { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 0.75rem; font-weight: 600; color: #f0f6fc; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
  .card h2 { font-size: 1.1rem; color: #f0f6fc; margin-bottom: 0.25rem; }
  .filepath { font-size: 0.75rem; color: #8b949e; font-family: monospace; margin-bottom: 0.5rem; }
  .stats { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.5rem; font-size: 0.8rem; }
  .stat { padding: 2px 8px; border-radius: 12px; }
  .stat-done { background: #238636; color: #fff; }
  .stat-active { background: #1f6feb; color: #fff; }
  .stat-blocked { background: #da3633; color: #fff; }
  .stat-deferred { background: #d29922; color: #fff; }
  .stat-pending { background: #30363d; color: #8b949e; }
  .stat-total { background: transparent; color: #8b949e; border: 1px solid #30363d; }
  .epic-table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.85rem; }
  .epic-table th { text-align: left; color: #8b949e; border-bottom: 1px solid #30363d; padding: 0.4rem 0.5rem; font-weight: 500; }
  .epic-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #21262d; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 500; }
  .badge-done { background: #238636; color: #fff; }
  .badge-in_progress { background: #1f6feb; color: #fff; }
  .badge-blocked { background: #da3633; color: #fff; }
  .badge-deferred { background: #d29922; color: #fff; }
  .badge-pending { background: #30363d; color: #8b949e; }
  .no-data { text-align: center; color: #8b949e; padding: 3rem; }
  .metrics-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin: 1rem 0; }
  .metrics-section h3.metrics-section-title { font-size: 0.8rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; font-weight: 500; }
  .cmd-chart { display: flex; flex-direction: column; gap: 0.5rem; }
  .cmd-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; }
  .cmd-label { width: 140px; color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
  .cmd-bar-container { flex: 1; background: #21262d; border-radius: 3px; height: 14px; overflow: hidden; }
  .cmd-bar { background: linear-gradient(90deg, #238636, #3fb950); height: 100%; border-radius: 3px; min-width: 2px; }
  .cmd-count { width: 28px; text-align: right; color: #8b949e; font-size: 0.78rem; flex-shrink: 0; }
  .gate-badges { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .badge-gate { padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
  .badge-gate-green { background: #238636; color: #fff; }
  .badge-gate-yellow { background: #d29922; color: #fff; }
  .badge-gate-red { background: #da3633; color: #fff; }
  .metrics-summary { display: flex; gap: 1rem; margin-top: 1rem; flex-wrap: wrap; }
  .metrics-summary .summary-box { background: #21262d; border: 1px solid #30363d; border-radius: 8px; padding: 0.75rem 1.25rem; text-align: center; min-width: 110px; }
  .metrics-summary .summary-box .number { font-size: 1.75rem; font-weight: 700; color: #f0f6fc; }
  .metrics-summary .summary-box .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  @media (max-width: 600px) { .metrics-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.25rem;">
<h1>Project Status</h1>
${decisionsLink}
</div>
<p class="meta">Generated ${esc(timestamp)} &mdash; ${files.length} TODO file${files.length !== 1 ? 's' : ''} found</p>

<div class="summary">
  <div class="summary-box highlight"><div class="number">${overallPct}%</div><div class="label">Complete</div></div>
  <div class="summary-box"><div class="number">${totals.done}</div><div class="label">Done</div></div>
  <div class="summary-box"><div class="number">${totals.inProgress}</div><div class="label">Active</div></div>
  <div class="summary-box"><div class="number">${totals.blocked}</div><div class="label">Blocked</div></div>
  <div class="summary-box"><div class="number">${totals.total}</div><div class="label">Total</div></div>
</div>

<div class="progress-container" style="height: 32px; margin-bottom: 2rem;">
  <div class="progress-bar" style="width: ${overallPct}%"></div>
  <span class="progress-label">${totals.done} / ${totals.total}</span>
</div>

${files.length > 0 ? fileCards : '<div class="no-data">No TODO files found in docs/</div>'}

${metricsCard}

</body>
</html>`;
}

module.exports = { generateHtml, renderMemoryHitRateBox, renderMemoryHealthBox, renderGateStatusBox, renderCodeSizeBox, esc };
