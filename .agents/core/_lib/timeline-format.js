/**
 * Timeline Format — concept/memory/ADR → timeline-node/edge converters.
 *
 * Extracted from decision-viz.js:383-450 (buildTimelineItems) and the inline
 * network-graph builder block at decision-viz.js:655-720. Those blocks were
 * tightly coupled to the generateHtml template literal, making them untestable.
 * Separating the data transformation from the HTML template allows unit testing
 * of the shape-mapping logic without rendering HTML.
 *
 * Consumers:
 *   - decision-html.js calls toTimelineNodes() and toNetworkGraph() internally.
 *   - decision-viz.js (orchestrator) may call them independently for --text-only.
 */

'use strict';

// ── HTML escaping helper (local to this module) ───────────────────────────────

/**
 * Escape HTML special characters for embedding in HTML attribute/text content.
 * Imported from `_lib/html-escape.js` — shared by decision-html, status-html,
 * and this module since P2.4 code-review M-2 deduplicated three copies.
 */
const { esc } = require('./html-escape');

// ── Category → color mapping (must stay in sync with decision-html.js CSS) ───

const CATEGORY_COLORS = {
  decisions: '#3fb950',
  patterns: '#1f6feb',
  constraints: '#da3633',
  workflows: '#d29922',
  commits: '#8b949e',
  adrs: '#a371f7',
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert normalized decision data into vis.js Timeline item objects.
 *
 * Sources: concepts (by earliest source date or created), git commits, ADRs
 * (by date), and daily log entries (by log date).
 *
 * Items without a determinable date are excluded (concepts with no sources
 * and no created field).
 *
 * @param {object} data  Normalized data from loadDecisionData()
 * @param {object[]} data.concepts
 * @param {object[]} data.commits
 * @param {object[]} data.adrs
 * @param {object[]} data.dailyLogs
 * @returns {Array<{id: number, content: string, start: string, group: string, className: string, type: string, title: string, confidence: number, slug?: string}>}
 */
function toTimelineNodes(data) {
  const items = [];
  let id = 0;

  // Concepts — use earliest source date, or created date
  for (const c of data.concepts) {
    const date = (c.sources && c.sources[0]) || (c.created ? c.created.slice(0, 10) : null);
    if (!date) continue;
    items.push({
      id: id++,
      content: esc(c.title),
      start: date,
      group: c.category,
      className: `cat-${c.category}`,
      slug: c.slug,
      type: 'concept',
      title: `${esc(c.title)}\nCategory: ${esc(c.category)}\nConfidence: ${c.confidence.toFixed(2)}\nSources: ${(c.sources || []).length}\n${esc(c.summary || '')}`,
      confidence: c.confidence,
    });
  }

  // Git commits
  for (const commit of data.commits) {
    const date = commit.date ? commit.date.slice(0, 10) : null;
    if (!date) continue;
    items.push({
      id: id++,
      content: esc(commit.message.slice(0, 60)),
      start: date,
      group: 'commits',
      className: 'cat-commits',
      type: 'commit',
      title: `${esc(commit.message)}\nHash: ${esc(commit.hash.slice(0, 8))}\nDate: ${esc(commit.date)}`,
      confidence: 1.0,
    });
  }

  // ADRs
  for (const adr of data.adrs) {
    if (!adr.date) continue;
    items.push({
      id: id++,
      content: esc(`ADR-${adr.number}: ${adr.title}`),
      start: adr.date,
      group: 'decisions',
      className: 'cat-adrs',
      type: 'adr',
      title: `ADR-${adr.number}: ${esc(adr.title)}\nStatus: ${esc(adr.status)}\n${esc(adr.summary || '')}`,
      confidence: 1.0,
    });
  }

  // Daily log entries
  for (const log of data.dailyLogs) {
    items.push({
      id: id++,
      content: esc(`${log.trigger}${log.branch ? ` (${log.branch})` : ''}`),
      start: log.date,
      group: 'workflows',
      className: 'cat-workflows',
      type: 'daily-log',
      title: `Daily log: ${esc(log.trigger)}\nDate: ${esc(log.date)} ${esc(log.time)}\nBranch: ${esc(log.branch || 'unknown')}`,
      confidence: 1.0,
    });
  }

  return items;
}

/**
 * Convert normalized decision data into vis.js Network node and edge arrays.
 *
 * Nodes: one per concept (dot shape, sized by confidence) + one per ADR (diamond).
 * Edges: one per unique cross-reference pair (deduplicated by sorted slug pair).
 *
 * @param {object} data  Normalized data from loadDecisionData()
 * @param {object[]} data.concepts
 * @param {object[]} data.adrs
 * @param {object}   data.crossReferences
 * @returns {{ nodes: object[], edges: object[] }}
 */
function toNetworkGraph(data) {
  const nodes = [];
  const edges = [];
  const edgeSet = new Set();

  // Build nodes from concepts
  for (const c of data.concepts) {
    // esc()'d for consistency with the sibling `title`/`content` fields below —
    // vis-network renders `label` as plain text today (no `font.multi` is set
    // anywhere in this file), so this isn't exploitable yet, but it becomes a
    // stored-XSS sink the instant a future change sets `font: {multi: 'html'}`.
    const label = esc(c.title.length > 30 ? c.title.slice(0, 27) + '...' : c.title);
    const size = 10 + (c.confidence * 20); // 10-30px range
    const color = CATEGORY_COLORS[c.category] || '#8b949e';
    const related = ((data.crossReferences[c.slug] || {}).related || []).length;
    nodes.push({
      id: c.slug,
      label,
      title: `${esc(c.title)}\\nCategory: ${esc(c.category)}\\nConfidence: ${c.confidence.toFixed(2)}\\nSources: ${(c.sources || []).length}\\nRelated: ${related}`,
      size,
      color: {
        background: color,
        border: color,
        highlight: { background: color, border: '#f0f6fc' },
        hover: { background: color, border: '#f0f6fc' },
      },
      opacity: 1.0,
      font: { color: '#c9d1d9', size: 11 },
      shape: 'dot',
      category: c.category,
    });
  }

  // Build nodes from ADRs (diamond shape)
  for (const adr of data.adrs) {
    const adrId = `adr-${adr.number}`;
    const shortTitle = adr.title.length > 20 ? adr.title.slice(0, 17) + '...' : adr.title;
    nodes.push({
      id: adrId,
      // esc()'d for the same reason as the concept label above — consistency
      // with the tooltip `title` field, defensive against a future font.multi flip.
      label: `ADR-${adr.number}: ${esc(shortTitle)}`,
      title: `ADR-${adr.number}: ${esc(adr.title)}\\nStatus: ${esc(adr.status)}\\n${esc(adr.summary || '')}`,
      size: 20,
      color: {
        background: '#a371f7',
        border: '#a371f7',
        highlight: { background: '#a371f7', border: '#f0f6fc' },
        hover: { background: '#a371f7', border: '#f0f6fc' },
      },
      opacity: 1.0,
      font: { color: '#c9d1d9', size: 11, bold: true },
      shape: 'diamond',
      category: 'decisions',
    });
  }

  // Build edges from cross-references (deduplicated)
  for (const slug of Object.keys(data.crossReferences)) {
    const entry = data.crossReferences[slug];
    if (!entry || !entry.related) continue;
    for (const relSlug of entry.related) {
      const key = [slug, relSlug].sort().join('|');
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({
        from: slug,
        to: relSlug,
        color: { color: '#30363d', highlight: '#8b949e', hover: '#8b949e' },
        width: 1,
      });
    }
  }

  return { nodes, edges };
}

module.exports = {
  toTimelineNodes,
  toNetworkGraph,
  CATEGORY_COLORS,
  esc,
};
