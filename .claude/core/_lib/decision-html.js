/**
 * Decision HTML — HTML + vis.js Timeline payload renderer for the decision-viz pipeline.
 *
 * Extracted from decision-viz.js:454-857 (generateHtml template literal, serializeSafe,
 * printTextSummary, buildTimelineItems inline usage). The vis.js physics/options block
 * (lines ~723-737 in the original) is LOAD-BEARING and copied verbatim — do not
 * parameterize or simplify it without cross-checking vis.js behavior.
 *
 * Exports:
 *   renderDecisionHtml(data, options) — consumes normalized data from loadDecisionData()
 *                                        and emits a complete HTML string.
 *   serializeSafe(value)              — JSON.stringify with </script> escaping.
 *                                        MUST be used for any data embedded in <script>
 *                                        tags to prevent XSS via inline script injection.
 *
 * The `options._now` and `options._maxDays` escape hatches allow tests to pin the
 * generated timestamp and day-window for deterministic output (AC-7 byte-identical test).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { toTimelineNodes, toNetworkGraph } = require('./timeline-format');

// ── HTML escaping ─────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters for embedding in HTML attribute/text content.
 * Imported from `_lib/html-escape.js` — three modules shared independent
 * copies of this helper before P2.4 code-review M-2 consolidated them.
 */
const { esc } = require('./html-escape');

// ── Inline-script serialization ───────────────────────────────────────────────

/**
 * Serialize a value as JSON safe for embedding inside an HTML <script> block.
 *
 * The classic XSS vector: if a JSON payload contains the literal string
 * `</script>`, the browser parser ends the script block at that point,
 * potentially executing attacker-controlled HTML that follows. This function
 * escapes all `</script>` occurrences (case-insensitive) so the resulting
 * JSON can be safely embedded between <script> and </script> tags.
 *
 * Must escape `<`, `>`, `&`, `"` is handled by the `</script>` replacement;
 * the replacement specifically targets the closing sequence `</script>` in any
 * casing (`</SCRIPT>`, `</Script>`, etc.).
 *
 * @param {*} value  Any JSON-serializable value
 * @returns {string} JSON string with </script> sequences escaped as <\/script>
 */
function serializeSafe(value) {
  return JSON.stringify(value).replace(/<\/(script)/gi, '<\\/$1');
}

// ── Text summary (called by orchestrator for --text-only) ─────────────────────

/**
 * Print a human-readable summary of the collected data to stdout.
 * The orchestrator calls this for --text-only mode.
 *
 * @param {object} data   Normalized data from loadDecisionData()
 * @param {number} maxDays  Window in days (for display purposes)
 */
function printTextSummary(data, maxDays = 90) {
  console.log('');
  console.log('  Decision Log Visualization — Data Summary');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Concept articles:  ${data.concepts.length}`);
  console.log(`  Cross-ref pairs:   ${Object.keys(data.crossReferences).length} slugs`);
  console.log(`  Git commits:       ${data.commits.length} (last ${maxDays} days)`);
  console.log(`  ADRs:              ${data.adrs.length}`);
  console.log(`  Daily log entries: ${data.dailyLogs.length} (last ${maxDays} days)`);
  console.log(`  Memory records:    ${data.memories.length}`);
  console.log('');

  // Category breakdown for concepts
  const catCounts = {};
  for (const c of data.concepts) {
    catCounts[c.category] = (catCounts[c.category] || 0) + 1;
  }
  if (data.concepts.length > 0) {
    console.log('  Concepts by category:');
    for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cat}: ${count}`);
    }
    console.log('');
  }

  // Stale/archived counts
  const stale = data.concepts.filter(c => c.confidence < 0.3 && c.confidence >= 0.1).length;
  const archived = data.concepts.filter(c => c.confidence < 0.1).length;
  if (stale || archived) {
    console.log(`  Stale (< 0.3): ${stale}  |  Archived (< 0.1): ${archived}`);
    console.log('');
  }
}

// ── HTML renderer ─────────────────────────────────────────────────────────────

/**
 * Render the complete decisions.html document from normalized data.
 *
 * @param {object} data   Normalized data from loadDecisionData()
 * @param {object} [options]
 * @param {boolean} [options.textOnly=false]  Ignored by this function (handled by orchestrator).
 *                                             Accepted to match the orchestrator's call signature.
 * @param {Date}   [options._now]             Override for the current date (test seam, determinism).
 * @param {number} [options._maxDays]         Override for the day-window label (test seam).
 * @param {string} [options._projectName]     Override for the project name (test seam).
 * @returns {string}  Complete HTML document as a string
 */
function renderDecisionHtml(data, options = {}) {
  const {
    _now: now = new Date(),
    _maxDays: maxDays = 90,
    _projectName: overrideProjectName,
  } = options;

  const timestamp = now.toISOString().replace('T', ' ').slice(0, 19);

  // Detect project name (not anchored to projectRoot here — renderer is pure).
  // F8: the production caller (decision-viz.js) ALWAYS passes _projectName,
  // derived from its PROJECT_ROOT — the cwd-reading fallback below only serves
  // bare/test invocations and must never become the production path again.
  let projectName = overrideProjectName;
  if (!projectName) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
      projectName = pkg.name;
    } catch {
      try {
        projectName = path.basename(process.cwd());
      } catch {
        projectName = 'Project';
      }
    }
  }

  const items = toTimelineNodes(data);
  const { nodes: networkNodes, edges: networkEdges } = toNetworkGraph(data);
  const itemsJson = serializeSafe(items);
  const dataJson = serializeSafe(data);
  const networkNodesJson = serializeSafe(networkNodes);
  const networkEdgesJson = serializeSafe(networkEdges);

  // Compute initial zoom window: last 30 days
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const staleCount = data.concepts.filter(c => c.confidence < 0.3).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Decision Log — ${esc(projectName)}</title>
<script src="https://unpkg.com/vis-timeline/standalone/umd/vis-timeline-graph2d.min.js"><\/script>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"><\/script>
<link href="https://unpkg.com/vis-timeline/styles/vis-timeline-graph2d.min.css" rel="stylesheet" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; max-width: 1200px; margin: 0 auto; }
  h1 { color: #f0f6fc; margin-bottom: 0.25rem; font-size: 1.5rem; display: inline-block; }
  .header { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.25rem; }
  .meta { color: #8b949e; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .nav-link { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; border-radius: 6px; padding: 4px 12px; font-size: 0.8rem; text-decoration: none; }
  .nav-link:hover { background: #30363d; }
  .stats { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .stat-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 0.75rem 1.25rem; text-align: center; min-width: 100px; }
  .stat-box .number { font-size: 1.75rem; font-weight: 700; color: #f0f6fc; }
  .stat-box .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-box.highlight .number { color: #3fb950; }
  .section-label { font-size: 0.9rem; color: #f0f6fc; margin-bottom: 0.5rem; font-weight: 600; }
  .controls { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; align-items: center; flex-wrap: wrap; }
  .toggle-btn { padding: 4px 12px; border-radius: 12px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; font-size: 0.78rem; cursor: pointer; user-select: none; }
  .toggle-btn:hover { background: #30363d; }
  .toggle-btn.active { border-color: var(--cat-color); color: #fff; }
  .toggle-btn.active.cat-decisions { background: #238636; --cat-color: #3fb950; }
  .toggle-btn.active.cat-patterns { background: #1a4fa0; --cat-color: #1f6feb; }
  .toggle-btn.active.cat-constraints { background: #a12828; --cat-color: #da3633; }
  .toggle-btn.active.cat-workflows { background: #9a7b1a; --cat-color: #d29922; }
  .toggle-btn.active.cat-commits { background: #484f58; --cat-color: #8b949e; }
  #timeline-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 1rem; overflow: hidden; }
  #network-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 1rem; }

  /* vis.js Timeline dark theme overrides */
  .vis-timeline { border: none; font-family: inherit; }
  .vis-panel.vis-background, .vis-panel.vis-center { background: #161b22; }
  .vis-time-axis .vis-text { color: #8b949e; font-size: 0.75rem; }
  .vis-time-axis .vis-grid.vis-minor { border-color: #21262d; }
  .vis-time-axis .vis-grid.vis-major { border-color: #30363d; }
  .vis-labelset .vis-label { color: #c9d1d9; background: #161b22; border-bottom: 1px solid #21262d; }
  .vis-foreground .vis-group { border-bottom: 1px solid #21262d; }
  .vis-item { border-radius: 4px; font-size: 0.78rem; border: none; padding: 2px 6px; }
  .vis-item.vis-selected { border: 2px solid #f0f6fc; }
  .vis-item.cat-decisions { background: #3fb950; color: #0d1117; }
  .vis-item.cat-patterns { background: #1f6feb; color: #fff; }
  .vis-item.cat-constraints { background: #da3633; color: #fff; }
  .vis-item.cat-workflows { background: #d29922; color: #0d1117; }
  .vis-item.cat-commits { background: #484f58; color: #c9d1d9; font-size: 0.7rem; }
  .vis-item.cat-adrs { background: #a371f7; color: #0d1117; font-weight: 600; }
  .vis-item.stale { opacity: 0.4; border: 1px dashed #8b949e; }
  .vis-item.archived { opacity: 0.2; border: 1px dotted #484f58; }
  .vis-cluster { background: #30363d !important; color: #c9d1d9 !important; border-radius: 12px !important; font-weight: 600; }
  .vis-tooltip { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 0.8rem; white-space: pre-line; max-width: 400px; }
</style>
</head>
<body>
<div class="header">
  <h1>Decision Log &mdash; ${esc(projectName)}</h1>
  <a href="status.html" class="nav-link">View Status</a>
</div>
<p class="meta">Generated ${esc(timestamp)} &mdash; last ${maxDays} days &mdash; ${data.concepts.length} concepts, ${data.commits.length} commits</p>

<div class="stats">
  <div class="stat-box highlight"><div class="number">${data.concepts.length}</div><div class="label">Concepts</div></div>
  <div class="stat-box"><div class="number">${data.commits.length}</div><div class="label">Commits</div></div>
  <div class="stat-box"><div class="number">${data.adrs.length}</div><div class="label">ADRs</div></div>
  <div class="stat-box"><div class="number">${data.memories.length}</div><div class="label">Memories</div></div>
  <div class="stat-box"><div class="number">${staleCount}</div><div class="label">Stale</div></div>
</div>

<div class="controls" id="filter-bar">
  <button class="toggle-btn active cat-decisions" data-cat="decisions" onclick="toggleCategory(this)">Decisions</button>
  <button class="toggle-btn active cat-patterns" data-cat="patterns" onclick="toggleCategory(this)">Patterns</button>
  <button class="toggle-btn active cat-constraints" data-cat="constraints" onclick="toggleCategory(this)">Constraints</button>
  <button class="toggle-btn active cat-workflows" data-cat="workflows" onclick="toggleCategory(this)">Workflows</button>
  <button class="toggle-btn active cat-commits" data-cat="commits" onclick="toggleCategory(this)">Commits</button>
  <span style="color:#30363d;margin:0 0.25rem;">|</span>
  <button class="toggle-btn" id="archived-toggle" onclick="toggleArchived(this)">Show Archived</button>
</div>

<p class="section-label">Timeline</p>
<div id="timeline-container" style="height: 45vh; min-height: 300px;"></div>

<p class="section-label">Network Graph</p>
<div id="network-container" style="height: 45vh; min-height: 300px;"></div>

<script>
// ── Data ──
const DATA = ${dataJson};
const ITEMS_RAW = ${itemsJson};
const SHOW_ARCHIVED = { value: false };

// ── Category colors ──
const CAT_COLORS = {
  decisions: '#3fb950', patterns: '#1f6feb',
  constraints: '#da3633', workflows: '#d29922',
  commits: '#8b949e', adrs: '#a371f7'
};

// ── Confidence tiers ──
function confidenceTier(c) {
  if (c < 0.1) return 'archived';
  if (c < 0.3) return 'stale';
  return 'active';
}

// ── Build vis.js items with confidence classes ──
function buildVisItems(items, showArchived) {
  return items
    .filter(function(item) {
      var tier = confidenceTier(item.confidence);
      if (tier === 'archived' && !showArchived) return false;
      return true;
    })
    .map(function(item) {
      var tier = confidenceTier(item.confidence);
      var cls = item.className;
      if (tier === 'stale') cls += ' stale';
      if (tier === 'archived') cls += ' archived';
      return {
        id: item.id,
        content: item.content,
        start: item.start,
        group: item.group,
        className: cls,
        title: item.title
      };
    });
}

// ── Groups ──
var groups = new vis.DataSet([
  { id: 'decisions', content: 'Decisions', style: 'color: #3fb950' },
  { id: 'patterns', content: 'Patterns', style: 'color: #1f6feb' },
  { id: 'constraints', content: 'Constraints', style: 'color: #da3633' },
  { id: 'workflows', content: 'Workflows', style: 'color: #d29922' },
  { id: 'commits', content: 'Commits', style: 'color: #8b949e' }
]);

// ── Timeline init ──
var container = document.getElementById('timeline-container');
var visItems = new vis.DataSet(buildVisItems(ITEMS_RAW, false));

var options = {
  stack: true,
  showTooltips: true,
  tooltip: { followMouse: true, overflowMethod: 'cap' },
  start: '${thirtyDaysAgo.toISOString().slice(0, 10)}',
  end: '${now.toISOString().slice(0, 10)}',
  zoomMin: 1000 * 60 * 60 * 24,       // 1 day
  zoomMax: 1000 * 60 * 60 * 24 * 365,  // 1 year
  cluster: {
    titleTemplate: '{count} events',
    maxItems: 3,
    clusterCriteria: function(a, b) {
      // Cluster items on the same day in the same group
      if (a.group !== b.group) return false;
      var dA = new Date(a.start).toISOString().slice(0, 10);
      var dB = new Date(b.start).toISOString().slice(0, 10);
      return dA === dB;
    }
  },
  margin: { item: { horizontal: 3, vertical: 3 } },
  orientation: { axis: 'top' }
};

var timeline = new vis.Timeline(container, visItems, groups, options);

// ── Detail on click ──
timeline.on('select', function(properties) {
  if (properties.items.length === 0) return;
  var itemId = properties.items[0];
  var item = ITEMS_RAW.find(function(i) { return i.id === itemId; });
  if (item) {
    window.dispatchEvent(new CustomEvent('timeline-select', { detail: item }));
  }
});

// ── Network Graph ──
var networkNodes = ${networkNodesJson};
var networkEdges = ${networkEdgesJson};
var neighborMap = {};

// Build neighbor map from nodes and edges
networkNodes.forEach(function(n) {
  neighborMap[n.id] = new Set();
});
networkEdges.forEach(function(e) {
  if (neighborMap[e.from]) neighborMap[e.from].add(e.to);
  if (neighborMap[e.to]) neighborMap[e.to].add(e.from);
});

var nodesDataSet = new vis.DataSet(networkNodes);
var edgesDataSet = new vis.DataSet(networkEdges);

var networkContainer = document.getElementById('network-container');
var network = new vis.Network(networkContainer, { nodes: nodesDataSet, edges: edgesDataSet }, {
  physics: {
    barnesHut: { gravitationalConstant: -2000, springLength: 120, springConstant: 0.02 },
    stabilization: { iterations: 150, fit: true }
  },
  interaction: {
    hover: true,
    tooltipDelay: 200,
    dragNodes: true,
    zoomView: true
  },
  layout: { improvedLayout: true },
  nodes: { borderWidth: 2, borderWidthSelected: 3 },
  edges: { smooth: { type: 'continuous' } }
});

// ── Focus mode: double-click to show only neighbors ──
var focusActive = false;

network.on('doubleClick', function(params) {
  if (params.nodes.length === 0) {
    // Double-click on empty space: restore all nodes
    if (focusActive) {
      nodesDataSet.forEach(function(node) {
        nodesDataSet.update({ id: node.id, hidden: false });
      });
      focusActive = false;
    }
    return;
  }

  var nodeId = params.nodes[0];
  var neighbors = neighborMap[nodeId] || new Set();

  nodesDataSet.forEach(function(node) {
    var show = node.id === nodeId || neighbors.has(node.id);
    nodesDataSet.update({ id: node.id, hidden: !show });
  });

  focusActive = true;
  network.focus(nodeId, { scale: 1.2, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
});

// ── Linked Interaction: Timeline ↔ Network ──

// Timeline click → highlight in Network
window.addEventListener('timeline-select', function(e) {
  var item = e.detail;
  if (!item || !item.slug) return;
  // Select the matching node in the network
  var nodeIds = nodesDataSet.getIds();
  if (nodeIds.indexOf(item.slug) !== -1) {
    network.selectNodes([item.slug]);
    network.focus(item.slug, { scale: 1.0, animation: { duration: 300 } });
    // Highlight connected edges
    var connEdges = network.getConnectedEdges(item.slug);
    network.selectEdges(connEdges);
  }
});

// Network click → scroll Timeline
network.on('selectNode', function(params) {
  if (params.nodes.length === 0) return;
  var slug = params.nodes[0];
  // Find matching timeline item
  var timelineItem = ITEMS_RAW.find(function(i) { return i.slug === slug; });
  if (timelineItem) {
    timeline.setSelection([timelineItem.id]);
    timeline.moveTo(timelineItem.start, { animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
  }
});

// ── Category Filters ──
var visibleCategories = new Set(['decisions', 'patterns', 'constraints', 'workflows', 'commits']);

function toggleCategory(btn) {
  var cat = btn.getAttribute('data-cat');
  if (visibleCategories.has(cat)) {
    visibleCategories.delete(cat);
    btn.classList.remove('active');
  } else {
    visibleCategories.add(cat);
    btn.classList.add('active');
  }
  applyFilters();
}

function toggleArchived(btn) {
  SHOW_ARCHIVED.value = !SHOW_ARCHIVED.value;
  if (SHOW_ARCHIVED.value) {
    btn.classList.add('active');
    btn.textContent = 'Hide Archived';
  } else {
    btn.classList.remove('active');
    btn.textContent = 'Show Archived';
  }
  applyFilters();
}

function applyFilters() {
  // Update timeline
  var filtered = buildVisItems(ITEMS_RAW, SHOW_ARCHIVED.value)
    .filter(function(item) {
      // Map className back to category
      for (var cat of visibleCategories) {
        if (item.className.indexOf('cat-' + cat) !== -1) return true;
      }
      // Check for ADRs (shown when decisions visible)
      if (item.className.indexOf('cat-adrs') !== -1 && visibleCategories.has('decisions')) return true;
      return false;
    });
  visItems.clear();
  visItems.add(filtered);

  // Update network nodes visibility
  nodesDataSet.forEach(function(node) {
    var show = visibleCategories.has(node.category);
    if (!show) { nodesDataSet.update({ id: node.id, hidden: true }); return; }
    var concept = DATA.concepts.find(function(c) { return c.slug === node.id; });
    if (concept) {
      var tier = confidenceTier(concept.confidence);
      if (tier === 'archived' && !SHOW_ARCHIVED.value) { nodesDataSet.update({ id: node.id, hidden: true }); return; }
    }
    nodesDataSet.update({ id: node.id, hidden: false });
  });
}

// Expose toggleCategory and toggleArchived to onclick handlers
window.toggleCategory = toggleCategory;
window.toggleArchived = toggleArchived;
<\/script>
</body>
</html>`;
}

module.exports = {
  renderDecisionHtml,
  serializeSafe,
  printTextSummary,
  esc,
};
