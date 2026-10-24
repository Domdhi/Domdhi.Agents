// AC→source map (guardrail-stats):
//   - aggregate(events): total + byDecision + byRule + range, ignoring non-guardrail records
//   - aggregate({since}): drops events before the ISO date bound
//   - parseEvents: skips malformed JSONL lines
//   - formatReport: renders totals, decision + rule breakdown, empty-state line

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { aggregate, parseEvents, formatReport } = require('../../../.agents/core/guardrail-stats.js');

const EVENTS = [
    { event: 'guardrail', decision: 'block',   rule: 'rm -rf /',        tier: null,        timestamp: '2026-06-01T10:00:00.000Z' },
    { event: 'guardrail', decision: 'block',   rule: 'rm -rf /',        tier: null,        timestamp: '2026-06-03T10:00:00.000Z' },
    { event: 'guardrail', decision: 'nudge',   rule: 'rm -rf build',    tier: null,        timestamp: '2026-06-05T10:00:00.000Z' },
    { event: 'guardrail', decision: 'confirm', rule: 'git push --force', tier: null,       timestamp: '2026-06-07T10:00:00.000Z' },
    { event: 'guardrail', decision: 'block',   rule: 'path-tier',       tier: 'zeroAccess', timestamp: '2026-06-07T11:00:00.000Z' },
];

describe('aggregate', () => {
    it('counts total, by decision, and by rule', () => {
        const agg = aggregate(EVENTS);
        expect(agg.total).toBe(5);
        expect(agg.byDecision).toEqual({ block: 3, nudge: 1, confirm: 1 });
        expect(agg.byRule['rm -rf /']).toBe(2);
        expect(agg.byRule['path-tier']).toBe(1);
        expect(agg.range.first).toBe('2026-06-01T10:00:00.000Z');
        expect(agg.range.last).toBe('2026-06-07T11:00:00.000Z');
    });

    it('honors the --since lower bound (inclusive)', () => {
        const agg = aggregate(EVENTS, { since: '2026-06-05' });
        expect(agg.total).toBe(3);   // nudge + confirm + path-tier block
        expect(agg.byDecision.block).toBe(1);
    });

    it('ignores non-guardrail records mixed into the stream', () => {
        const mixed = [...EVENTS, { event: 'hook', name: 'memory-capture', outcome: 'success' }];
        expect(aggregate(mixed).total).toBe(5);
    });

    it('excludes secret-scanner-sourced events (counted by the digest, not the Bash hit counter)', () => {
        const mixed = [
            ...EVENTS,
            { event: 'guardrail', decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', timestamp: '2026-06-13T00:00:00Z' },
            { event: 'guardrail', decision: 'block', rule: 'secret-scanner', source: 'secret-scanner', timestamp: '2026-06-13T00:00:01Z' },
        ];
        const agg = aggregate(mixed);
        expect(agg.total).toBe(5); // unchanged — scanner blocks not counted here
        expect(agg.byRule['secret-scanner']).toBeUndefined();
    });

    it('returns a zeroed shape for no events', () => {
        const agg = aggregate([]);
        expect(agg.total).toBe(0);
        expect(agg.byDecision).toEqual({});
        expect(agg.byPathClass).toEqual({});
        expect(agg.range).toEqual({ first: null, last: null });
    });

    it('aggregates byPathClass, skipping null/undefined pathClass (C1)', () => {
        const events = [
            { event: 'guardrail', decision: 'nudge', rule: 'rm -rf', pathClass: 'build-artifact', timestamp: '2026-06-21T10:00:00Z' },
            { event: 'guardrail', decision: 'nudge', rule: 'rm -rf', pathClass: 'build-artifact', timestamp: '2026-06-21T10:01:00Z' },
            { event: 'guardrail', decision: 'nudge', rule: 'rm -rf', pathClass: 'project-path', timestamp: '2026-06-21T10:02:00Z' },
            { event: 'guardrail', decision: 'confirm', rule: 'git push --force', pathClass: null, timestamp: '2026-06-21T10:03:00Z' },
            { event: 'guardrail', decision: 'block', rule: 'mkfs', timestamp: '2026-06-21T10:04:00Z' }, // no pathClass field
        ];
        const agg = aggregate(events);
        expect(agg.total).toBe(5);
        expect(agg.byPathClass).toEqual({ 'build-artifact': 2, 'project-path': 1 });
    });
});

describe('parseEvents', () => {
    it('parses valid lines and skips malformed ones', () => {
        const raw = '{"event":"guardrail","decision":"block"}\nnot json\n\n{"event":"guardrail","decision":"nudge"}';
        const parsed = parseEvents(raw);
        expect(parsed).toHaveLength(2);
        expect(parsed[1].decision).toBe('nudge');
    });
});

describe('formatReport', () => {
    it('renders totals, decision and rule breakdowns', () => {
        const out = formatReport(aggregate(EVENTS));
        expect(out).toContain('Total: 5');
        expect(out).toContain('block');
        expect(out).toContain('rm -rf /');
        expect(out).toContain('git push --force');
    });

    it('caps the per-rule list with --top and notes the remainder', () => {
        const out = formatReport(aggregate(EVENTS), { top: 1 });
        expect(out).toContain('more rule(s)');
    });

    it('shows an empty-state line when there are no hits', () => {
        expect(formatReport(aggregate([]))).toContain('No guardrail hits recorded yet');
    });

    it('prints a "By path class" section when delete-style hits carry a pathClass (C1)', () => {
        const events = [
            { event: 'guardrail', decision: 'nudge', rule: 'rm -rf', pathClass: 'build-artifact', timestamp: '2026-06-21T10:00:00Z' },
            { event: 'guardrail', decision: 'nudge', rule: 'rm -rf', pathClass: 'project-path', timestamp: '2026-06-21T10:01:00Z' },
        ];
        const out = formatReport(aggregate(events));
        expect(out).toContain('By path class');
        expect(out).toContain('build-artifact');
        expect(out).toContain('project-path');
    });

    it('omits the "By path class" section when no hit carried a pathClass', () => {
        // EVENTS has no pathClass on any record → section suppressed.
        expect(formatReport(aggregate(EVENTS))).not.toContain('By path class');
    });
});
