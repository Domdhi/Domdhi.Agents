#!/usr/bin/env node

/**
 * Decision Viz — Orchestrator. Parse decision data sources and generate an
 * interactive HTML visualization.
 *
 * After the P2.1 split, this file is a thin orchestrator: arg parsing,
 * data loading (delegated to _lib/decision-graph.js), timeline/network
 * formatting (delegated to _lib/timeline-format.js), and HTML rendering
 * (delegated to _lib/decision-html.js).
 *
 * Usage:
 *   node .claude/core/decision-viz.js              # Full scan + HTML
 *   node .claude/core/decision-viz.js --text-only  # JSON summary to stdout (no HTML)
 *   node .claude/core/decision-viz.js --days 30    # Limit to last 30 days (default: 90)
 *
 * Public API (unchanged from pre-split):
 *   collectData()                  — returns the normalized data object
 *   generateHtml(data)             — renders HTML (delegates to renderDecisionHtml)
 *   printTextSummary(data)         — prints text summary to stdout
 *   esc(str)                       — HTML escape helper
 *   generateDecisionsHtml(opts)    — integration entry point for status.js
 */

const fs = require('fs');
const path = require('path');
const CONSTANTS = require('./constants');
const { loadDecisionData } = require('./_lib/decision-graph');
const { renderDecisionHtml, printTextSummary, esc } = require('./_lib/decision-html');
const { OUTPUT_ROOT } = require('./_lib/output-paths');

// ── Constants ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
// ADR 0006: generated dashboards are regenerable state → docs/.output/.state/.
// The `docs/.output` prefix comes from the output-paths.js "only door" (OUTPUT_ROOT);
// `.state` is the stable regenerable-state zone segment.
const OUTPUT_DIR = path.join(PROJECT_ROOT, OUTPUT_ROOT, '.state');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'decisions.html');
const TEXT_ONLY = process.argv.includes('--text-only');

// Parse --days N flag (default 90)
const daysIdx = process.argv.indexOf('--days');
const MAX_DAYS = daysIdx !== -1 && process.argv[daysIdx + 1]
  ? parseInt(process.argv[daysIdx + 1], 10)
  : 90;
const CUTOFF_DATE = new Date();
CUTOFF_DATE.setDate(CUTOFF_DATE.getDate() - MAX_DAYS);

const CATEGORIES = Object.values(CONSTANTS.MEMORY_CATEGORIES);

// ── Public API (backward-compat wrappers) ─────────────────────────────────────

/**
 * Collect all decision data from the project root.
 * Backward-compat wrapper — was collectData() in the original.
 *
 * @returns {{ concepts, crossReferences, commits, adrs, memories, dailyLogs }}
 */
function collectData() {
  return loadDecisionData({
    projectRoot: PROJECT_ROOT,
    cutoffDate: CUTOFF_DATE,
    categories: CATEGORIES,
  });
}

/**
 * F8: resolve the display name from PROJECT_ROOT — the renderer's own fallback
 * reads process.cwd(), so a dashboard generated from any other working
 * directory silently picked up the WRONG project name. This is the anchoring
 * convention every other caller-side path already follows.
 */
function projectNameFromRoot(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch { /* no/invalid package.json — use the folder name */ }
  return path.basename(root);
}

/**
 * Render the decisions HTML from a data object.
 * Backward-compat wrapper — was generateHtml(data) in the original.
 *
 * @param {object} data  Normalized data from collectData()
 * @returns {string}
 */
function generateHtml(data) {
  return renderDecisionHtml(data, { _maxDays: MAX_DAYS, _projectName: projectNameFromRoot(PROJECT_ROOT) });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const data = collectData();

  printTextSummary(data, MAX_DAYS);

  if (!TEXT_ONLY) {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    // renderDecisionHtml internally invokes toTimelineNodes + toNetworkGraph on
    // `data`; no need to call them here separately.
    const html = renderDecisionHtml(data, { _maxDays: MAX_DAYS, _projectName: projectNameFromRoot(PROJECT_ROOT) });
    fs.writeFileSync(OUTPUT_FILE, html, 'utf8');
    console.log(`  Dashboard: ${path.relative(PROJECT_ROOT, OUTPUT_FILE)}`);
    console.log('');
  }
}

/**
 * Integration entry point: generate decisions.html and write it to a given path.
 * Called by status.js after it writes status.html. Wrapped in try/catch by caller.
 *
 * @param {object} opts
 * @param {string} [opts.outputPath]  Absolute path for decisions.html (defaults to OUTPUT_FILE)
 * @returns {{ html: string, outputPath: string }}
 */
function generateDecisionsHtml({ outputPath } = {}) {
  const dest = outputPath || OUTPUT_FILE;
  const data = collectData();
  const html = generateHtml(data);
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(dest, html, 'utf8');
  return { html, outputPath: dest };
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  collectData,
  generateHtml,
  printTextSummary: (data) => printTextSummary(data, MAX_DAYS),
  esc,
  generateDecisionsHtml,
};
