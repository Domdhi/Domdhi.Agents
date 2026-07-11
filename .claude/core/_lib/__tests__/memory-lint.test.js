// AC→source map (M2 / memory-lint broken_refs):
//   lintMemories(allMemories, { calculateDecayedConfidence, categories, maxPerCategory })
//   Check 1 (broken_refs) must recognize the toolkit's ACTUAL cross-reference forms:
//     - "[[wiki-link]]" slugs in content.description / content.evidence
//     - a top-level content.references[] array of slug ids
//   and flag any that point at an id not in the store, while leaving valid ones alone.
//   Pre-fix the regex matched neither form, so broken_refs always reported 0.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { lintMemories } = require('../memory-lint');

// Decay is irrelevant to the broken_refs check — stub it fresh so stale/decay
// checks never fire and we isolate Check 1.
const noDecay = () => 1.0;
const CATEGORIES = ['patterns', 'constraints', 'decisions', 'workflows', 'rejected-approaches'];

// Build the { category, summary, full } shape lintMemories consumes. `updated` is
// "now" so the orphaned/stale checks stay quiet.
function mem(id, content, category = 'patterns') {
  return {
    category,
    summary: { id },
    full: {
      id,
      category,
      updated: new Date().toISOString(),
      usage_count: 1,
      metadata: { confidence: 0.9 },
      content,
    },
  };
}

function run(memories) {
  return lintMemories(memories, { calculateDecayedConfidence: noDecay, categories: CATEGORIES });
}

describe('memory-lint broken_refs (M2)', () => {
  it('flags a dangling [[wiki-link]] in the description', () => {
    const memories = [
      mem('known-target', { description: 'A real memory.' }),
      mem('has-dangling', { description: 'See related work. Related: [[bad-slug]]' }),
    ];

    const { checks } = run(memories);

    expect(checks.broken_refs.count).toBe(1);
    expect(checks.broken_refs.findings[0].referenced_id).toBe('bad-slug');
    expect(checks.broken_refs.findings[0].memory).toBe('patterns/has-dangling');
  });

  it('does NOT flag a [[wiki-link]] that points at an existing id', () => {
    const memories = [
      mem('known-one', { description: 'Points forward. Related: [[known-two]]' }),
      mem('known-two', { description: 'The target.' }),
    ];

    const { checks } = run(memories);

    expect(checks.broken_refs.count).toBe(0);
  });

  it('detects a wiki-link inside content.evidence too', () => {
    const memories = [
      mem('evidence-ref', {
        description: 'A finding.',
        evidence: 'Cross-checked against [[missing-evidence-id]].',
      }),
    ];

    const { checks } = run(memories);

    expect(checks.broken_refs.count).toBe(1);
    expect(checks.broken_refs.findings[0].referenced_id).toBe('missing-evidence-id');
  });

  it('walks a content.references[] array and flags only the missing entries', () => {
    const memories = [
      mem('known-a', { description: 'A.' }),
      mem('has-refs', {
        description: 'Depends on others.',
        references: ['known-a', 'missing-ref'],
      }),
    ];

    const { checks } = run(memories);

    const flagged = checks.broken_refs.findings.map(f => f.referenced_id);
    expect(flagged).toContain('missing-ref');
    expect(flagged).not.toContain('known-a');
    expect(checks.broken_refs.count).toBe(1);
  });

  it('mixes forms: a valid wiki-link + a dangling references[] entry', () => {
    const memories = [
      mem('anchor', { description: 'The anchor.' }),
      mem('mixed', {
        description: 'Well-linked. Related: [[anchor]]',
        references: ['ghost-id'],
      }),
    ];

    const { checks } = run(memories);

    expect(checks.broken_refs.count).toBe(1);
    expect(checks.broken_refs.findings[0].referenced_id).toBe('ghost-id');
  });
});
