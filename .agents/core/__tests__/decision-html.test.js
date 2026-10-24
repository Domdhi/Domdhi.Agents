// Tests for _lib/decision-html.js — renderDecisionHtml, printTextSummary, serializeSafe.
//
// Coverage strategy:
//   - printTextSummary: exercise with empty data, with concepts (category breakdown),
//     and with stale/archived concepts to hit the conditional logging path (lines 94-97).
//   - renderDecisionHtml: exercise via the _projectName override seam (avoids fs reads)
//     and also without the override to hit the package.json read path (lines 127-138).
//   - serializeSafe: XSS escaping contract (</script> sequences).
//
// The existing _lib/__tests__/decision-html.test.js covers serializeSafe and
// renderDecisionHtml structural assertions. This file targets the *uncovered*
// printTextSummary function and the projectName-detection fallback branches.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderDecisionHtml, serializeSafe, printTextSummary } = require('../../../.agents/core/_lib/decision-html');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function minimalData() {
    return {
        concepts: [],
        crossReferences: {},
        commits: [],
        adrs: [],
        memories: [],
        dailyLogs: [],
    };
}

function dataWithConcepts() {
    return {
        concepts: [
            {
                slug: 'active-concept',
                title: 'Active Concept',
                category: 'decisions',
                confidence: 0.8,
                created: '2026-01-01',
                updated: '2026-01-15',
                sources: ['2026-01-01'],
                tags: ['decisions'],
                summary: 'An active decision.',
            },
            {
                slug: 'stale-concept',
                title: 'Stale Concept',
                category: 'patterns',
                confidence: 0.15,  // stale: >= 0.1 and < 0.3
                created: '2025-01-01',
                updated: '2025-06-01',
                sources: ['2025-01-01'],
                tags: ['patterns'],
                summary: 'A stale pattern.',
            },
            {
                slug: 'archived-concept',
                title: 'Archived Concept',
                category: 'constraints',
                confidence: 0.05, // archived: < 0.1
                created: '2024-01-01',
                updated: '2024-06-01',
                sources: ['2024-01-01'],
                tags: ['constraints'],
                summary: 'An archived constraint.',
            },
        ],
        crossReferences: { 'active-concept': ['stale-concept'] },
        commits: [
            { hash: 'abcdef1234567890abcdef1234567890abcdef12', date: '2026-04-01 12:00:00 +0000', message: 'feat: test commit' },
            { hash: 'bbcdef1234567890abcdef1234567890abcdef12', date: '2026-03-15 09:00:00 +0000', message: 'fix: bug fix' },
        ],
        adrs: [
            { number: 1, title: 'Use Node.js', status: 'Accepted', date: '2026-01-10', summary: 'Adopt Node.' },
        ],
        memories: [],
        dailyLogs: [
            { date: '2026-04-01', time: '09:00', trigger: 'Stop hook', branch: 'main', hasCommits: true, hasDecisions: false },
        ],
    };
}

// ─── printTextSummary ─────────────────────────────────────────────────────────
// Lines 67-98 in _lib/decision-html.js are the printTextSummary function.
// None of those lines are exercised by the existing _lib/__tests__/decision-html.test.js.

describe('printTextSummary', () => {

    it('printTextSummary_minimalData_printsSummaryHeader', () => {
        // Arrange
        const data = minimalData();
        const lines = [];
        const original = console.log;
        console.log = (...args) => lines.push(args.join(' '));

        try {
            // Act
            printTextSummary(data);
        } finally {
            console.log = original;
        }

        // Assert — header line must appear
        expect(lines.some(l => l.includes('Decision Log Visualization'))).toBe(true);
        expect(lines.some(l => l.includes('Data Summary'))).toBe(true);
    });

    it('printTextSummary_minimalData_printsZeroCounts', () => {
        const data = minimalData();
        const lines = [];
        const original = console.log;
        console.log = (...args) => lines.push(args.join(' '));
        try {
            printTextSummary(data);
        } finally {
            console.log = original;
        }
        const all = lines.join('\n');
        // Every count is 0 for minimal data
        expect(all).toContain('Concept articles:  0');
        expect(all).toContain('Git commits:       0');
        expect(all).toContain('ADRs:              0');
        expect(all).toContain('Memory records:    0');
    });

    it('printTextSummary_withCommitsAndMaxDays_showsMaxDaysInCommitLine', () => {
        const data = { ...minimalData(), commits: [{ hash: 'a', date: '2026-01-01', message: 'x' }] };
        const lines = [];
        const original = console.log;
        console.log = (...args) => lines.push(args.join(' '));
        try {
            printTextSummary(data, 30);
        } finally {
            console.log = original;
        }
        const all = lines.join('\n');
        // "last 30 days" appears in the commit line
        expect(all).toContain('last 30 days');
        expect(all).toContain('Git commits:       1');
    });

    it('printTextSummary_withConcepts_printsCategoryBreakdown', () => {
        // This hits lines 79-89 (catCounts build + category output loop)
        const data = dataWithConcepts();
        const lines = [];
        const original = console.log;
        console.log = (...args) => lines.push(args.join(' '));
        try {
            printTextSummary(data);
        } finally {
            console.log = original;
        }
        const all = lines.join('\n');
        // "Concepts by category:" header
        expect(all).toContain('Concepts by category:');
        // Each category that has a concept should be listed
        expect(all).toContain('decisions: 1');
        expect(all).toContain('patterns: 1');
        expect(all).toContain('constraints: 1');
    });

    it('printTextSummary_withStaleAndArchivedConcepts_printsStaleArchivedCounts', () => {
        // This hits lines 92-97 — the stale/archived conditional block.
        // Stale: confidence >= 0.1 and < 0.3; archived: confidence < 0.1
        const data = dataWithConcepts(); // has 1 stale (0.15) + 1 archived (0.05)
        const lines = [];
        const original = console.log;
        console.log = (...args) => lines.push(args.join(' '));
        try {
            printTextSummary(data);
        } finally {
            console.log = original;
        }
        const all = lines.join('\n');
        // The stale/archived counts line must appear
        expect(all).toMatch(/Stale \(< 0\.3\)/);
        expect(all).toMatch(/Archived \(< 0\.1\)/);
        // Correct numeric values: 1 stale (confidence 0.15), 1 archived (confidence 0.05)
        expect(all).toContain('Stale (< 0.3): 1');
        expect(all).toContain('Archived (< 0.1): 1');
    });

    it('printTextSummary_withOnlyActiveConceptsConfidence_doesNotPrintStaleArchivedLine', () => {
        // When stale + archived = 0, that block is skipped (branch coverage)
        const data = {
            ...minimalData(),
            concepts: [{
                slug: 'high-conf',
                title: 'High Confidence',
                category: 'decisions',
                confidence: 0.9,
                created: '2026-01-01',
                updated: '2026-01-01',
                sources: [],
                tags: [],
                summary: '',
            }],
        };
        const lines = [];
        const original = console.log;
        console.log = (...args) => lines.push(args.join(' '));
        try {
            printTextSummary(data);
        } finally {
            console.log = original;
        }
        const all = lines.join('\n');
        // Stale/archived line must NOT appear when both counts are 0
        expect(all).not.toContain('Stale (< 0.3)');
    });

    it('printTextSummary_defaultMaxDays_uses90InCommitLine', () => {
        // Default maxDays = 90 when not passed
        const data = minimalData();
        const lines = [];
        const original = console.log;
        console.log = (...args) => lines.push(args.join(' '));
        try {
            printTextSummary(data);
        } finally {
            console.log = original;
        }
        const all = lines.join('\n');
        expect(all).toContain('last 90 days');
    });

});

// ─── renderDecisionHtml — projectName detection ────────────────────────────────
// Lines 127-138 in _lib/decision-html.js: the project-name detection logic.
// When _projectName is NOT passed, the function reads process.cwd()/package.json.
// The catch block at 132-135 (path.basename fallback) is hard to trigger in a
// normal test environment (cwd always resolves), so we cover the success path
// and the _projectName override seam.

describe('renderDecisionHtml — projectName paths', () => {

    it('renderDecisionHtml_withProjectNameOverride_usesProvidedName', () => {
        // _projectName override seam bypasses all fs reads (lines 127-138)
        const data = minimalData();
        const html = renderDecisionHtml(data, { _projectName: 'my-test-project' });
        expect(html).toContain('my-test-project');
        expect(html).toContain('Decision Log');
    });

    it('renderDecisionHtml_withoutProjectNameOverride_readsFromEnvironment', () => {
        // No _projectName — function reads package.json from cwd (lines 127-131).
        // The project's package.json name is "domdhi-agents" (or similar);
        // we don't assert the exact name but do assert the HTML is valid and non-empty.
        const data = minimalData();
        const html = renderDecisionHtml(data);
        expect(typeof html).toBe('string');
        expect(html.length).toBeGreaterThan(100);
        expect(html).toContain('<!DOCTYPE html>');
    });

    it('renderDecisionHtml_nowOverride_usesProvidedTimestamp', () => {
        const data = minimalData();
        const fixedDate = new Date('2026-03-15T10:30:00Z');
        const html = renderDecisionHtml(data, { _projectName: 'proj', _now: fixedDate });
        // Timestamp in format "2026-03-15 10:30:00" appears in the meta line
        expect(html).toContain('2026-03-15 10:30:00');
    });

    it('renderDecisionHtml_maxDaysOverride_usesProvidedDayWindow', () => {
        const data = minimalData();
        const html = renderDecisionHtml(data, { _projectName: 'proj', _maxDays: 30, _now: new Date('2026-04-01T00:00:00Z') });
        // "last 30 days" appears in the meta paragraph
        expect(html).toContain('last 30 days');
    });

});

// ─── serializeSafe (via top-level import) ─────────────────────────────────────
// These are parallel to the _lib/__tests__/decision-html.test.js tests but
// ensure the export is reachable from the top-level __tests__/ directory.

describe('serializeSafe', () => {

    it('serializeSafe_plainValue_roundTrips', () => {
        const obj = { key: 'value', n: 42 };
        const result = serializeSafe(obj);
        expect(JSON.parse(result)).toEqual(obj);
    });

    it('serializeSafe_scriptClosingTag_isEscaped', () => {
        const obj = { x: '</script>' };
        const result = serializeSafe(obj);
        // Raw </script> must not appear in the output
        expect(result).not.toMatch(/<\/script>/i);
        // The escaped form must be present
        expect(result).toContain('<\\/script>');
    });

    it('serializeSafe_multipleCases_allEscaped', () => {
        const obj = { a: '</script>', b: '</SCRIPT>' };
        const result = serializeSafe(obj);
        expect(result).not.toMatch(/<\/script>/i);
    });

});

// ─── renderDecisionHtml — structural assertions ────────────────────────────────
// Covers core rendering paths with rich data to exercise the template literal.

describe('renderDecisionHtml — with data', () => {

    it('renderDecisionHtml_withDataAndConcepts_reflectsConceptsInStats', () => {
        const data = dataWithConcepts();
        const html = renderDecisionHtml(data, { _projectName: 'test-proj', _now: new Date('2026-04-24T00:00:00Z') });
        // 3 concepts → stat box shows "3"
        expect(html).toContain('3</div><div class="label">Concepts');
    });

    it('renderDecisionHtml_withDataAndADRs_reflectsADRCountInStats', () => {
        const data = dataWithConcepts();
        const html = renderDecisionHtml(data, { _projectName: 'test-proj', _now: new Date('2026-04-24T00:00:00Z') });
        expect(html).toContain('1</div><div class="label">ADRs');
    });

    it('renderDecisionHtml_withDataAndCommits_reflectsCommitCountInMeta', () => {
        const data = dataWithConcepts();
        const html = renderDecisionHtml(data, { _projectName: 'test-proj', _now: new Date('2026-04-24T00:00:00Z') });
        expect(html).toMatch(/2 commits/);
    });

    it('renderDecisionHtml_staleCount_appearsInStaleStatBox', () => {
        // data has 2 concepts with confidence < 0.3 (stale=0.15 + archived=0.05)
        const data = dataWithConcepts();
        const html = renderDecisionHtml(data, { _projectName: 'test-proj', _now: new Date('2026-04-24T00:00:00Z') });
        // staleCount = concepts with confidence < 0.3 (both stale AND archived)
        expect(html).toContain('2</div><div class="label">Stale');
    });

    it('renderDecisionHtml_htmlEscapesProjectNameInTitle', () => {
        const data = minimalData();
        const html = renderDecisionHtml(data, { _projectName: '<script>xss</script>' });
        // Project name is HTML-escaped in the title
        expect(html).toContain('&lt;script&gt;xss&lt;/script&gt;');
        // Raw injection must not appear
        expect(html).not.toContain('<script>xss</script>');
    });

    it('renderDecisionHtml_sameInput_producesIdenticalOutput', () => {
        // Stability / idempotency: calling twice with same args yields identical HTML
        const data = dataWithConcepts();
        const opts = { _projectName: 'stable-proj', _now: new Date('2026-04-24T12:00:00Z'), _maxDays: 90 };
        const html1 = renderDecisionHtml(data, opts);
        const html2 = renderDecisionHtml(data, opts);
        expect(html1).toBe(html2);
    });

});
