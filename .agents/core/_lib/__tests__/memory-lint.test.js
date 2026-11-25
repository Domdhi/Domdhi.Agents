// AC→source map (M2 / memory-lint broken_refs):
//   lintMemories(allMemories, { calculateDecayedConfidence, categories })
//   Check 1 (broken_refs) must recognize the toolkit's ACTUAL cross-reference forms:
//     - "[[wiki-link]]" slugs in content.description / content.evidence
//     - a top-level content.references[] array of slug ids
//   and flag any that point at an id not in the store, while leaving valid ones alone.
//   Pre-fix the regex matched neither form, so broken_refs always reported 0.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { lintMemories } = require('../../../../.agents/core/_lib/memory-lint');

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

// A memory corrected by editing its body (instead of a new memory plus `supersede`) keeps the
// wrong claim live in recall, and its id keeps naming the old idea. Seen at scale in the
// largest store: 35 corrected-in-place bodies against 16 records ever superseded.
describe('memory-lint corrected_in_place and id_drift', () => {
  it('flags an upper-case correction marker in the body', () => {
    const r = run([mem('agent-file-changes-need-hand-propagation', { description: 'CORRECTED 2026-06-09 (the prior claim was WRONG). Edits DO propagate.' })]);
    expect(r.checks.corrected_in_place.count).toBe(1);
    expect(r.checks.corrected_in_place.findings[0]).toMatchObject({ memory: 'patterns/agent-file-changes-need-hand-propagation', marker: 'CORRECTED' });
  });

  it('flags a correction phrase in any case', () => {
    const r = run([mem('cache-keys-include-tenant-id', { description: 'Cache keys include the tenant. The earlier guidance was wrong about the region.' })]);
    expect(r.checks.corrected_in_place.count).toBe(1);
  });

  it('leaves ordinary lower-case uses of "obsolete" or "corrected" alone', () => {
    const r = run([mem('remove-obsolete-build-output', { description: 'The cleaner removes obsolete build output; a corrected path is logged.' })]);
    expect(r.checks.corrected_in_place.count).toBe(0);
  });

  it('flags an id whose words mostly appear nowhere in the body', () => {
    const r = run([mem('inmemory-provider-proves-sql-queries', { description: 'Integration tests must run against a real database server; the fake data layer hides translation errors.' })]);
    expect(r.checks.id_drift.count).toBe(1);
    expect(r.checks.id_drift.findings[0].missing_terms).toEqual(expect.arrayContaining(['inmemory', 'provider', 'proves']));
  });

  it('does not flag an id paraphrased by its body, matching by word stem', () => {
    const r = run([mem('caching-layer-invalidates-tenant-entries', { description: 'The cache layer must invalidate every entry for a tenant on rename.' })]);
    expect(r.checks.id_drift.count).toBe(0);
  });

  it('skips ids too short to judge', () => {
    const r = run([mem('use-pnpm', { description: 'Something else entirely.' })]);
    expect(r.checks.id_drift.count).toBe(0);
  });
});

describe('memory-lint see_also and schema_drift', () => {
  it('flags see_also links, as slugs or {category, id} objects, that point at no memory', () => {
    const r = run([
      mem('cache-keys-include-tenant-id', { description: 'Cache keys include the tenant id.', see_also: [{ category: 'patterns', id: 'gone-memory-id' }, 'also-gone-id'] }),
      mem('tenant-id-comes-from-claims', { description: 'Tenant id comes from claims.', see_also: [{ category: 'patterns', id: 'cache-keys-include-tenant-id' }] }),
    ]);
    expect(r.checks.broken_refs.findings.map(f => f.referenced_id).sort()).toEqual(['also-gone-id', 'gone-memory-id']);
  });

  it('flags a memory with neither description nor summary, and an importance off the 1-5 scale', () => {
    const noText = mem('orphan-pattern-without-text', { pattern: 'Only a pattern key.' });
    const offScale = mem('importance-out-of-range-memory', { description: 'Has text.' });
    offScale.full.importance = 7;
    const r = run([noText, offScale]);
    expect(r.checks.schema_drift.findings.map(f => [f.memory, f.problems])).toEqual([
      ['patterns/orphan-pattern-without-text', ['empty description']],
      ['patterns/importance-out-of-range-memory', ['importance 7 is off the 1-5 scale']],
    ]);
  });

  it('accepts content.summary in place of a description, and a missing importance', () => {
    const r = run([mem('summary-only-memory-record', { summary: 'Startup reads summary when description is absent.' })]);
    expect(r.checks.schema_drift.count).toBe(0);
  });
});

describe('memory-lint corrected_in_place, structured form', () => {
  it.each([
    [{ description: 'New rule.', correction: 'The old rule was fixed in wave 5.' }, 'correction field'],
    [{ description: 'New rule.', historical_description: 'The old rule.' }, 'historical_description field'],
    [{ description: 'CURRENT: new rule, the old one is kept below.' }, 'CURRENT: prefix'],
  ])('flags the old claim kept in a side field or a CURRENT: prefix (%j)', (content, marker) => {
    const r = run([mem('rule-kept-beside-its-history', content)]);
    expect(r.checks.corrected_in_place.findings[0]?.marker).toBe(marker);
  });
});

describe('memory-lint bracketed list refs', () => {
  it('strips [[…]] from see_also and references before the lookup and warns "use bare ids"', () => {
    const memories = [
      mem('known-target', { description: 'A real memory.' }),
      mem('has-brackets', {
        description: 'Lists written in the wiki-link form.',
        see_also: ['[[known-target]]', { category: 'patterns', id: '[[known-target]]' }],
        references: ['[[known-target]]'],
      }),
    ];

    const { checks } = run(memories);

    expect(checks.broken_refs.count).toBe(0);
    expect(checks.bracketed_refs.count).toBe(3);
    expect(checks.bracketed_refs.severity).toBe('warning');
    expect(checks.bracketed_refs.findings[0].detail).toContain('use bare ids');
  });

  it('still flags a bracketed list entry whose bare id does not exist', () => {
    const memories = [mem('lonely-one', { description: 'x', see_also: ['[[missing-id]]'] })];

    const { checks } = run(memories);

    expect(checks.broken_refs.count).toBe(1);
    expect(checks.broken_refs.findings[0].referenced_id).toBe('missing-id');
    expect(checks.bracketed_refs.count).toBe(1);
  });

  it('does not warn on bare ids', () => {
    const memories = [
      mem('known-target', { description: 'A real memory.' }),
      mem('bare-refs', { description: 'x', see_also: ['known-target'], references: ['known-target'] }),
    ];

    expect(run(memories).checks.bracketed_refs.count).toBe(0);
  });
});

describe('memory-lint score does not saturate', () => {
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const orphan = (id) => {
    const m = mem(id, { description: `Never recalled memory ${id}.` });
    m.full.usage_count = 0;
    m.full.updated = old;
    return m;
  };

  it('treats zero-usage orphans as info and caps their deduction', () => {
    const memories = Array.from({ length: 60 }, (_, i) => orphan(`orphan-memory-${i}`));

    const { score, checks } = run(memories);

    expect(checks.orphaned.severity).toBe('info');
    expect(checks.orphaned.count).toBe(60);
    expect(checks.orphaned.deduction).toBe(3);
    expect(score).toBeGreaterThan(0);
  });

  it('moves when a real error is fixed, even beside many orphans', () => {
    const orphans = Array.from({ length: 60 }, (_, i) => orphan(`orphan-memory-${i}`));
    const broken = mem('has-dangling', { description: 'Related: [[missing-one]] and [[missing-two]]' });
    const fixed = mem('has-dangling', { description: 'No dangling links now.' });

    const before = run([...orphans, broken]).score;
    const after = run([...orphans, fixed]).score;

    expect(after - before).toBe(6);
  });
});
