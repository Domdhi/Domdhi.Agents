/**
 * Tests for .claude/core/_lib/timeline-format.js
 *
 * W2-4: vis.js renders a timeline item's `content` as the visible innerHTML and
 * its `title` as the hover tooltip — both are HTML sinks. `content` was already
 * esc()'d; the `title` tooltips (repo-sourced concept titles/summaries, commit
 * messages, ADR titles, daily-log triggers) were left raw. These tests pin the
 * tooltip escaping so a `<`/`"`/`'`/`&` in repo-sourced text cannot reach the
 * tooltip unescaped — defense-in-depth parity with the `content` sink.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toTimelineNodes, toNetworkGraph } = require('../_lib/timeline-format');

describe('timeline-format — title tooltip escaping (W2-4)', () => {
  it('toTimelineNodes_escapes_concept_title_and_summary_in_tooltip', () => {
    const data = {
      concepts: [{
        title: '<script>alert(1)</script>',
        category: 'patterns',
        confidence: 0.7,
        sources: ['2026-04-01'],
        summary: `it's "risky" & <b>bold</b>`,
        slug: 'x',
        created: '2026-04-01',
      }],
      commits: [], adrs: [], dailyLogs: [],
    };
    const [item] = toTimelineNodes(data);
    expect(item.title).not.toContain('<script>');
    expect(item.title).toContain('&lt;script&gt;');
    expect(item.title).toContain('&#39;'); // apostrophe escaped
    expect(item.title).toContain('&amp;'); // ampersand escaped
  });

  it('toTimelineNodes_escapes_commit_message_in_tooltip', () => {
    const data = {
      concepts: [],
      commits: [{ message: '<img src=x onerror=alert(1)>', hash: 'abcdef123456', date: '2026-04-01T00:00:00Z' }],
      adrs: [], dailyLogs: [],
    };
    const [item] = toTimelineNodes(data);
    expect(item.title).not.toContain('<img');
    expect(item.title).toContain('&lt;img');
  });

  it('toTimelineNodes_escapes_adr_and_dailyLog_tooltips', () => {
    const data = {
      concepts: [], commits: [],
      adrs: [{ number: 7, title: '<b>Pick</b> DB', status: '<accepted>', summary: 'a & b', date: '2026-04-01' }],
      dailyLogs: [{ trigger: '<end>', branch: 'feat/<x>', date: '2026-04-01', time: '10:00' }],
    };
    const items = toTimelineNodes(data);
    const adr = items.find(i => i.type === 'adr');
    const log = items.find(i => i.type === 'daily-log');
    expect(adr.title).not.toMatch(/<b>|<accepted>/);
    expect(adr.title).toContain('&lt;b&gt;');
    expect(log.title).toContain('&lt;end&gt;');
    expect(log.title).toContain('feat/&lt;x&gt;');
  });

  it('toNetworkGraph_escapes_concept_and_adr_node_tooltips', () => {
    const data = {
      concepts: [{ title: '<script>x</script>', category: 'patterns', confidence: 0.7, sources: [], slug: 'x' }],
      adrs: [{ number: 3, title: '<i>hi</i>', status: 'ok', summary: '' }],
      crossReferences: {},
    };
    const { nodes } = toNetworkGraph(data);
    const conceptNode = nodes.find(n => n.id === 'x');
    const adrNode = nodes.find(n => n.id === 'adr-3');
    expect(conceptNode.title).not.toContain('<script>');
    expect(conceptNode.title).toContain('&lt;script&gt;');
    expect(adrNode.title).not.toContain('<i>');
    expect(adrNode.title).toContain('&lt;i&gt;');
  });

  // Wave 7 NIT: `label` wasn't esc()'d like its sibling `title`/`content` fields —
  // not exploitable today (vis-network renders label as plain text, no font.multi
  // set anywhere in this file), but a stored-XSS sink the instant that changes.
  it('toNetworkGraph_escapes_concept_and_adr_node_labels', () => {
    const data = {
      concepts: [{ title: '<script>x</script>', category: 'patterns', confidence: 0.7, sources: [], slug: 'x' }],
      adrs: [{ number: 3, title: '<i>hi</i>', status: 'ok', summary: '' }],
      crossReferences: {},
    };
    const { nodes } = toNetworkGraph(data);
    const conceptNode = nodes.find(n => n.id === 'x');
    const adrNode = nodes.find(n => n.id === 'adr-3');
    expect(conceptNode.label).not.toContain('<script>');
    expect(conceptNode.label).toContain('&lt;script&gt;');
    expect(adrNode.label).not.toContain('<i>');
    expect(adrNode.label).toContain('&lt;i&gt;');
  });
});
