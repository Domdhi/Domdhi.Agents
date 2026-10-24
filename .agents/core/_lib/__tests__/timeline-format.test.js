// AC→source map (P2.1 / timeline-format):
//   Exports: toTimelineNodes(data) and toNetworkGraph(data)
//   Extracted from decision-viz.js:383-450 (buildTimelineItems) and
//   decision-viz.js:655-720 (inline network node/edge builders).
//
//   toTimelineNodes: concept/commit/ADR/daily-log → timeline item array
//   toNetworkGraph:  concept/ADR/crossRef → { nodes, edges }

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toTimelineNodes, toNetworkGraph } = require('../../../../.agents/core/_lib/timeline-format');

// ─── Shared fixtures ──────────────────────────────────────────────────────────

function emptyData() {
  return {
    concepts: [],
    crossReferences: {},
    commits: [],
    adrs: [],
    memories: [],
    dailyLogs: [],
  };
}

function richData() {
  return {
    concepts: [
      {
        slug: 'pattern-alpha',
        title: 'Pattern Alpha',
        category: 'patterns',
        confidence: 0.85,
        created: '2026-01-10',
        updated: '2026-01-15',
        sources: ['2026-01-10'],
        tags: ['patterns'],
        summary: 'Alpha pattern for testing.',
      },
      {
        slug: 'decision-beta',
        title: 'Decision Beta',
        category: 'decisions',
        confidence: 0.9,
        created: '2026-02-01',
        updated: '2026-02-05',
        sources: ['2026-02-01'],
        tags: ['decisions'],
        summary: 'A key architectural decision.',
      },
    ],
    crossReferences: {
      'pattern-alpha': { related: ['decision-beta'] },
    },
    commits: [
      {
        hash: 'deadbeef0000000000000000000000000000dead',
        date: '2026-03-15 10:00:00 +0000',
        message: 'feat: implement new system',
      },
    ],
    adrs: [
      {
        number: 2,
        title: 'Adopt TypeScript',
        status: 'Proposed',
        date: '2026-02-20',
        summary: 'Migrate frontend to TypeScript.',
      },
    ],
    memories: [],
    dailyLogs: [
      {
        date: '2026-04-01',
        time: '09:30',
        trigger: 'Stop hook',
        branch: 'feature-x',
        hasCommits: true,
        hasDecisions: false,
      },
    ],
  };
}

// ─── toTimelineNodes ──────────────────────────────────────────────────────────

describe('toTimelineNodes', () => {

  it('toTimelineNodes_emptyData_returnsEmptyArray', () => {
    const result = toTimelineNodes(emptyData());
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('toTimelineNodes_withConcepts_eachHasRequiredShape', () => {
    // Each node must have id, content, start, group, className
    const result = toTimelineNodes(richData());

    const conceptNodes = result.filter(n => n.type === 'concept');
    expect(conceptNodes.length).toBeGreaterThan(0);

    for (const node of conceptNodes) {
      expect(node).toHaveProperty('id');
      expect(node).toHaveProperty('content');
      expect(node).toHaveProperty('start');
      expect(node).toHaveProperty('group');
      expect(node).toHaveProperty('className');
    }
  });

  it('toTimelineNodes_withCommit_includesCommitNode', () => {
    const result = toTimelineNodes(richData());

    const commitNodes = result.filter(n => n.type === 'commit');
    expect(commitNodes).toHaveLength(1);
    expect(commitNodes[0].group).toBe('commits');
    expect(commitNodes[0].start).toBe('2026-03-15');
  });

  it('toTimelineNodes_withADR_includesADRNode', () => {
    const result = toTimelineNodes(richData());

    const adrNodes = result.filter(n => n.type === 'adr');
    expect(adrNodes).toHaveLength(1);
    expect(adrNodes[0].start).toBe('2026-02-20');
    expect(adrNodes[0].content).toContain('ADR-2');
  });

  it('toTimelineNodes_withDailyLog_includesDailyLogNode', () => {
    const result = toTimelineNodes(richData());

    const logNodes = result.filter(n => n.type === 'daily-log');
    expect(logNodes).toHaveLength(1);
    expect(logNodes[0].start).toBe('2026-04-01');
    expect(logNodes[0].group).toBe('workflows');
  });

  it('toTimelineNodes_conceptWithoutDate_excluded', () => {
    // Concepts with no date (no sources, no created) must not appear in timeline
    const data = {
      ...emptyData(),
      concepts: [{
        slug: 'dateless',
        title: 'Dateless Concept',
        category: 'patterns',
        confidence: 0.5,
        created: null,
        updated: null,
        sources: [],
        tags: [],
        summary: '',
      }],
    };
    const result = toTimelineNodes(data);
    expect(result).toHaveLength(0);
  });

  it('toTimelineNodes_contentXssEscaped', () => {
    // content field must have HTML-special chars escaped (via esc())
    const data = {
      ...emptyData(),
      concepts: [{
        slug: 'xss-test',
        title: '<script>alert(1)</script>',
        category: 'patterns',
        confidence: 0.7,
        created: '2026-01-01',
        updated: '2026-01-01',
        sources: ['2026-01-01'],
        tags: [],
        summary: '',
      }],
    };
    const result = toTimelineNodes(data);
    expect(result).toHaveLength(1);
    expect(result[0].content).not.toContain('<script>');
    expect(result[0].content).toContain('&lt;script&gt;');
  });

});

// ─── toNetworkGraph ───────────────────────────────────────────────────────────

describe('toNetworkGraph', () => {

  it('toNetworkGraph_emptyData_returnsEmptyNodesAndEdges', () => {
    const result = toNetworkGraph(emptyData());
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('edges');
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('toNetworkGraph_withConcepts_returnsNodePerConcept', () => {
    const result = toNetworkGraph(richData());

    // Two concepts + 1 ADR = 3 nodes
    const conceptNodes = result.nodes.filter(n => n.shape === 'dot');
    expect(conceptNodes).toHaveLength(2);
  });

  it('toNetworkGraph_withADR_returnsADRNodeWithDiamondShape', () => {
    const result = toNetworkGraph(richData());

    const adrNodes = result.nodes.filter(n => n.shape === 'diamond');
    expect(adrNodes).toHaveLength(1);
    expect(adrNodes[0].id).toBe('adr-2');
  });

  it('toNetworkGraph_withCrossReferences_returnsEdgePerPair', () => {
    const result = toNetworkGraph(richData());

    // pattern-alpha → decision-beta (one undirected edge)
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0];
    const endpoints = [edge.from, edge.to].sort();
    expect(endpoints).toContain('pattern-alpha');
    expect(endpoints).toContain('decision-beta');
  });

  it('toNetworkGraph_duplicateCrossRefEdge_deduplicatedToOne', () => {
    // If A→B and B→A both appear in crossReferences, only one edge should emit
    const data = {
      ...emptyData(),
      concepts: [
        { slug: 'a', title: 'A', category: 'patterns', confidence: 0.8, created: '2026-01-01', updated: '2026-01-01', sources: ['2026-01-01'], tags: [], summary: '' },
        { slug: 'b', title: 'B', category: 'patterns', confidence: 0.8, created: '2026-01-01', updated: '2026-01-01', sources: ['2026-01-01'], tags: [], summary: '' },
      ],
      crossReferences: {
        'a': { related: ['b'] },
        'b': { related: ['a'] },
      },
    };
    const result = toNetworkGraph(data);
    expect(result.edges).toHaveLength(1);
  });

});
