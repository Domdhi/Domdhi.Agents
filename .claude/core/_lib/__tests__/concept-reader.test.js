// AC→source map (Task #21 / concept-reader):
//   Single export: readConcepts({ conceptsDir, categories, activeDaysResolver })
//   Walks cat dirs, parses FM, computes decay, returns superset shape.
//   Consumes _lib/frontmatter.js + _lib/memory-decay.js.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { readConcepts } = require('../concept-reader');
const { createActiveDaysResolver } = require('../memory-decay');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { createConcept } = require('../../__tests__/_helpers/concept-fixture');

const CATEGORIES = ['patterns', 'constraints', 'decisions', 'workflows', 'rejected-approaches'];

let tmp;

beforeEach(() => { tmp = createTmpDir({ prefix: 'concept-reader-' }); });
afterEach(() => { tmp.cleanup(); });

function makeResolver() {
    // tmp.root is NOT a git repo — resolver falls back to calendar days.
    // Matches production behavior in test harnesses.
    return createActiveDaysResolver({ projectRoot: tmp.root });
}

describe('readConcepts', () => {

  it('readConcepts_emptyConceptsDir_returnsEmptyArray', async () => {
    const conceptsDir = tmp.mkdir('docs/.output/.state/memory-concepts');
    const result = await readConcepts({
      conceptsDir,
      categories: CATEGORIES,
      activeDaysResolver: makeResolver(),
    });
    expect(result).toEqual([]);
  });

  it('readConcepts_singleConcept_returnsSupersetShape', async () => {
    createConcept(tmp, 'patterns', 'alpha-concept', {
      title: 'Alpha Concept',
      confidence: 0.7,
      sources: ['2026-01-01', '2026-01-02'],
      usage_count: 3,
    });
    const conceptsDir = require('node:path').join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');

    const result = await readConcepts({
      conceptsDir,
      categories: CATEGORIES,
      activeDaysResolver: makeResolver(),
    });

    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.slug).toBe('alpha-concept');
    expect(c.title).toBe('Alpha Concept');
    expect(c.category).toBe('patterns');
    expect(c.confidence).toBeCloseTo(0.7);
    expect(c.usageCount).toBe(3);
    expect(c.sources).toEqual(['2026-01-01', '2026-01-02']);
    expect(c.promotedTo).toBeNull();
    expect(typeof c.decayedConfidence).toBe('number');
    expect(c.decayedConfidence).toBeGreaterThan(0);
    expect(c.decayedConfidence).toBeLessThanOrEqual(1.0);
    expect(typeof c.content).toBe('string'); // superset shape includes content
    expect(c.updated).toBeDefined();
  });

  it('readConcepts_multipleCategories_allReturned', async () => {
    createConcept(tmp, 'patterns',    'p1', { title: 'P1', confidence: 0.7, sources: ['2026-01-01'] });
    createConcept(tmp, 'constraints', 'c1', { title: 'C1', confidence: 0.7, sources: ['2026-01-01'] });
    createConcept(tmp, 'decisions',   'd1', { title: 'D1', confidence: 0.7, sources: ['2026-01-01'] });
    const conceptsDir = require('node:path').join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');

    const result = await readConcepts({
      conceptsDir,
      categories: CATEGORIES,
      activeDaysResolver: makeResolver(),
    });

    expect(result).toHaveLength(3);
    const cats = result.map(c => c.category).sort();
    expect(cats).toEqual(['constraints', 'decisions', 'patterns']);
  });

  it('readConcepts_promotedConcept_promotedToPopulated', async () => {
    // The shared concept-fixture doesn't support promoted_to, so write the file
    // directly with the extra frontmatter field.
    const md = [
      '---',
      'title: Already Promoted',
      'category: patterns',
      'confidence: 0.8',
      'sources:',
      '  - 2026-01-01',
      'promoted_to: CLAUDE.md',
      'promoted_at: 2026-04-22',
      '---',
      '## Summary',
      '',
      'body',
    ].join('\n');
    tmp.write('docs/.output/.state/memory-concepts/patterns/promoted.md', md);
    const conceptsDir = require('node:path').join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');

    const result = await readConcepts({
      conceptsDir,
      categories: CATEGORIES,
      activeDaysResolver: makeResolver(),
    });

    expect(result[0].promotedTo).toBe('CLAUDE.md');
  });

  it('readConcepts_missingCategoryDir_skipsGracefully', async () => {
    // Only create patterns/; other 4 dirs don't exist at all
    createConcept(tmp, 'patterns', 'lonely', { title: 'Lonely', confidence: 0.6, sources: ['2026-01-01'] });
    const conceptsDir = require('node:path').join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');

    const result = await readConcepts({
      conceptsDir,
      categories: CATEGORIES,
      activeDaysResolver: makeResolver(),
    });

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('lonely');
  });

  it('readConcepts_nonMdFile_ignored', async () => {
    createConcept(tmp, 'patterns', 'valid', { title: 'V', confidence: 0.7, sources: ['2026-01-01'] });
    // Drop a non-.md file in the same dir — must be ignored
    tmp.write('docs/.output/.state/memory-concepts/patterns/not-a-concept.txt', 'junk content');
    const conceptsDir = require('node:path').join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');

    const result = await readConcepts({
      conceptsDir,
      categories: CATEGORIES,
      activeDaysResolver: makeResolver(),
    });

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('valid');
  });

  // Regression (MEM-13): `parseFloat(fm.confidence) || 0.6` silently rebumped
  // a genuine confidence of 0 up to the 0.6 default, since `0 || 0.6` is 0.6.
  it('readConcepts_zeroConfidence_returnsExactZeroNotDefault', async () => {
    createConcept(tmp, 'patterns', 'zero-confidence', {
      title: 'Zero Confidence',
      confidence: 0,
      sources: ['2026-01-01'],
    });
    const conceptsDir = require('node:path').join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');

    const result = await readConcepts({
      conceptsDir,
      categories: CATEGORIES,
      activeDaysResolver: makeResolver(),
    });

    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0);
  });

  it('readConcepts_invalidFrontmatter_entrySkipped', async () => {
    // Valid concept alongside an .md file with no frontmatter — reader must skip the bad one
    createConcept(tmp, 'patterns', 'valid', { title: 'V', confidence: 0.7, sources: ['2026-01-01'] });
    tmp.write('docs/.output/.state/memory-concepts/patterns/no-fm.md', '# just a heading, no frontmatter\n');
    const conceptsDir = require('node:path').join(tmp.root, 'docs', '.output', '.state', 'memory-concepts');

    const result = await readConcepts({
      conceptsDir,
      categories: CATEGORIES,
      activeDaysResolver: makeResolver(),
    });

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('valid');
  });

});
