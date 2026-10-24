// AC→source map (P2.1 / decision-html):
//   Exports: renderDecisionHtml(data, options) and serializeSafe(value)
//   Extracted from decision-viz.js:454-857 (generateHtml + inline script block).
//   serializeSafe must escape </script> sequences to prevent XSS via inline scripts.
//   renderDecisionHtml consumes normalized data from loadDecisionData.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderDecisionHtml, serializeSafe } = require('../../../../.agents/core/_lib/decision-html');

// ─── Minimal data fixture ─────────────────────────────────────────────────────

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

function dataWithConcept() {
  return {
    concepts: [{
      slug: 'test-pattern',
      title: 'Test Pattern',
      category: 'patterns',
      confidence: 0.8,
      created: '2026-01-15',
      updated: '2026-01-15',
      sources: ['2026-01-15'],
      tags: ['patterns'],
      summary: 'A test concept for rendering.',
    }],
    crossReferences: {},
    commits: [{
      hash: 'abc1234abc1234abc1234abc1234abc1234abc1234',
      date: '2026-04-01 12:00:00 +0000',
      message: 'feat: test commit',
    }],
    adrs: [{
      number: 1,
      title: 'Use Node.js',
      status: 'Accepted',
      date: '2026-01-10',
      summary: 'Node.js for core scripts.',
    }],
    memories: [],
    dailyLogs: [{
      date: '2026-04-01',
      time: '09:00',
      trigger: 'Stop hook',
      branch: 'main',
      hasCommits: true,
      hasDecisions: false,
    }],
  };
}

// ─── serializeSafe ────────────────────────────────────────────────────────────

describe('serializeSafe', () => {

  it('serializeSafe_plainObject_returnsValidJsonString', () => {
    // Arrange
    const obj = { foo: 'bar', count: 42 };

    // Act
    const result = serializeSafe(obj);

    // Assert — valid JSON, round-trips correctly
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toEqual(obj);
  });

  it('serializeSafe_scriptClosingTag_isEscaped', () => {
    // AC-required XSS test: </script> inside embedded JSON must not break out
    // of the surrounding <script> tag.
    const malicious = { payload: '</script><script>alert(1)</script>' };

    // Act
    const result = serializeSafe(malicious);

    // Assert — raw </script> is NOT present; escaped form IS present
    expect(result).not.toContain('</script>');
    expect(result.toLowerCase()).not.toMatch(/<\/script>/);
    // The escaped form that vis.js / JSON.parse will still interpret correctly
    // is <\/script> or its unicode variant
    expect(result).toContain('<\\/script>');
  });

  it('serializeSafe_scriptOpenTag_passesThrough', () => {
    // <script> (opening) is not an injection vector; it should survive unchanged
    const obj = { value: '<script>harmless</script>' };
    const result = serializeSafe(obj);

    // Assert — closing tag escaped, opening is left (JSON-serialized)
    expect(result).toContain('<script>');
    expect(result).not.toContain('</script>');
  });

  it('serializeSafe_nestedScriptTag_allInstancesEscaped', () => {
    // Multiple </script> occurrences — all must be escaped
    const obj = {
      a: '</script>',
      b: ['</script>', 'safe', '</SCRIPT>'],
    };
    const result = serializeSafe(obj);

    expect(result).not.toMatch(/<\/script>/i);
  });

  it('serializeSafe_normalStrings_notMangled', () => {
    // Strings without </script> must not be altered
    const obj = { greeting: 'Hello & World', angle: '<em>hi</em>' };
    const result = serializeSafe(obj);
    // Round-trip: parsed value should equal original
    expect(JSON.parse(result)).toEqual(obj);
  });

});

// ─── renderDecisionHtml ───────────────────────────────────────────────────────

describe('renderDecisionHtml', () => {

  it('renderDecisionHtml_minimalData_returnsCompleteHtmlDocument', () => {
    // Arrange
    const data = minimalData();

    // Act
    const html = renderDecisionHtml(data);

    // Assert — structural validity
    expect(typeof html).toBe('string');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<body');
    expect(html).toContain('</body>');
  });

  it('renderDecisionHtml_minimalData_includesVisJsScriptTags', () => {
    // vis.js Timeline and Network are always included in the full render
    const html = renderDecisionHtml(minimalData());

    expect(html).toContain('vis-timeline');
    expect(html).toContain('vis-network');
  });

  it('renderDecisionHtml_minimalData_embeddedScriptDoesNotContainRawScriptClosingTag', () => {
    // The DATA and ITEMS_RAW embedded in <script> must not contain raw </script>
    // (serializeSafe must have been applied)
    const data = {
      ...minimalData(),
      concepts: [{ slug: 'x', title: '</script><script>alert(1)</script>', category: 'patterns', confidence: 0.5, created: '2026-01-01', updated: '2026-01-01', sources: [], tags: [], summary: '' }],
    };
    const html = renderDecisionHtml(data);

    // The injected script-close marker embedded via JSON must be escaped
    // Find content between <script> tags
    const scriptMatches = html.match(/<script>([\s\S]*?)<\/script>/g);
    // The inline DATA script block should not contain raw </script> in the JSON payload
    // (the literal closing tags for the script elements themselves are fine)
    // We check by verifying no embedded string contains the literal token:
    expect(html).not.toContain('</script><script>alert');
  });

  it('renderDecisionHtml_withConcept_includesConceptCountInStats', () => {
    // Stat box should reflect data.concepts.length
    const data = dataWithConcept();
    const html = renderDecisionHtml(data);

    // Stat box: 1 concept
    expect(html).toContain('1</div><div class="label">Concepts');
  });

  it('renderDecisionHtml_withCommits_includesCommitCountInMeta', () => {
    const data = dataWithConcept();
    const html = renderDecisionHtml(data);

    // Meta line mentions the commit count
    expect(html).toMatch(/1 commit/i);
  });

  it('renderDecisionHtml_withADR_includesADRCountInStats', () => {
    const data = dataWithConcept(); // has 1 ADR
    const html = renderDecisionHtml(data);

    expect(html).toContain('1</div><div class="label">ADRs');
  });

  it('renderDecisionHtml_textOnlyOption_notImplementedByThisModule', () => {
    // textOnly: true is handled by the orchestrator (printTextSummary), not this module.
    // renderDecisionHtml always returns HTML regardless of textOnly.
    // This test confirms the function accepts the option without throwing.
    expect(() => renderDecisionHtml(minimalData(), { textOnly: true })).not.toThrow();
    const html = renderDecisionHtml(minimalData(), { textOnly: true });
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  it('renderDecisionHtml_givenFixedData_outputIsStable', () => {
    // Regression / byte-identical test: same input → same output.
    // This is the AC-7 snapshot test: given a fixed normalized-data fixture,
    // two calls to renderDecisionHtml must produce identical strings.
    const data = dataWithConcept();

    const html1 = renderDecisionHtml(data, { _now: new Date('2026-04-24T12:00:00Z'), _maxDays: 90 });
    const html2 = renderDecisionHtml(data, { _now: new Date('2026-04-24T12:00:00Z'), _maxDays: 90 });

    expect(html1).toBe(html2);
  });

});
