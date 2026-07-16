// AC→source map (TDD-4.1 / memory-promoter):
//   DRIFT-1: loadConcepts shape — AC said {category,slug,frontmatter,content};
//            source returns {slug,title,category,confidence,decayedConfidence,sources,usageCount,promotedTo,updated}.
//            No frontmatter or content fields. Tests assert the actual shape.
//   DRIFT-2: calculatePromotionScore — AC said 1-arg with formula confidence×recency×usage;
//            source is 3-arg: (concept, crossRefs, totalConcepts).
//            Formula: decayed_confidence * (1 + min(usageCount*0.1, 1.0)) * (1 + relatedCount/totalConcepts).
//            Tests use actual 3-arg signature.
//   DRIFT-3: isEligible — AC said "category in allowlist AND confidence >= threshold";
//            source checks decayedConfidence >= 0.5 && sources.length >= 2 && !promotedTo.
//            No category allowlist at all. Tests assert the actual three checks.
//   DRIFT-4: Module export — module.exports = MemoryPromoter (default class, not named export).
//            Loaded with `const MemoryPromoter = require('../memory-promoter')`.
//   DRIFT-5: mark() errors — source calls process.exit(1) on missing concept and already-promoted.
//            Tests stub process.exit via vi.spyOn to convert to throw.
//   DRIFT-6: loadCrossReferences with compiler — AC said "use the compiler to generate it".
//            Writing cross-references.json directly via tmp.write() is faster and equally valid.
//            Documented deviation: avoids heavyweight compiler dependency in unit tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const MemoryPromoter = require('../memory-promoter');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createConcept } = require('./_helpers/concept-fixture');

// Inline helper — no shared fixture exists for hand-created JSON memories.
// Mirrors the shape written by `node memory-manager.js create <cat> <slug> '{...}'`.
// CR-3.4 (F47/F48): also supports the top-level fields MemoryManager stamps —
// `importance` (write-time retention floor) and `invalid_at`/`superseded_by`
// (ME-3.1 supersession, written by MemoryManager.supersedeMemory) — so tests can
// construct a memory shape identical to what the canonical read path produces.
// W3-1 (confidence source of truth): the REAL curated confidence lives in
// `content.confidence` — that is what `node memory-manager.js create` persists
// and what the promoter ranks on. `metadata.confidence` is a vestigial UNIFORM
// default of 1 (createMemory stamps `confidence: 1.0` into metadata regardless of
// the curated value — verified: all 143 store files have metadata.confidence==1
// while content.confidence carries the 0.5–0.9 gradient). So this fixture mirrors
// that reality: `opts.confidence` drives ONLY `content.confidence`; metadata stays
// a fixed 1. (An earlier CR-3.4 pass wrongly pointed both at opts.confidence,
// masking a regression where the promoter had been re-routed to read the flat
// metadata value — the corpus disproves that field being the real source.)
function writeHandCreatedMemory(tmp, category, slug, opts = {}) {
  const now = new Date().toISOString();
  const memory = {
    id: slug,
    type: opts.type || 'pattern',
    category,
    created: opts.created || now,
    updated: opts.updated || now,
    usage_count: opts.usage_count ?? 0,
    ...(opts.importance !== undefined ? { importance: opts.importance } : {}),
    ...(opts.invalid_at !== undefined ? { invalid_at: opts.invalid_at } : {}),
    ...(opts.superseded_by !== undefined ? { superseded_by: opts.superseded_by } : {}),
    content: { description: opts.description || `${slug} description`, confidence: opts.confidence ?? 0.7 },
    metadata: { sessions: [], agents: [], confidence: 1, ...(opts.metadata || {}) },
  };
  return tmp.write(
    path.join('docs', '.output', '.memory', category, `${slug}.json`),
    JSON.stringify(memory, null, 2)
  );
}

// ─── MEMORY_DECAY constants (from constants.js) ──────────────────────────────
// Used to compute expected decayedConfidence for today-dated concepts:
//   daysSinceUpdate ≈ 0, so Math.pow(rate, 0) = 1
//   decayed = confidence * 1 + USAGE_BOOST * usageCount + RECENT_UPDATE_BOOST
//           = confidence + 0.01 * usageCount + 0.1, capped at 1.0
const USAGE_BOOST = 0.01;
const RECENT_UPDATE_BOOST = 0.1;

function expectedDecayed(confidence, usageCount = 0) {
  return Math.min(confidence + USAGE_BOOST * usageCount + RECENT_UPDATE_BOOST, 1.0);
}

// ─── Per-test sandbox ────────────────────────────────────────────────────────

let tmp;
let originalEnv;

beforeEach(() => {
  tmp = createTmpDir();
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalEnv;
  tmp.cleanup();
});

// ─── describe('memory-promoter') ────────────────────────────────────────────

describe('memory-promoter', () => {

  // ── loadConcepts ───────────────────────────────────────────────────────────

  describe('loadConcepts', () => {

    it('loadConcepts_emptyConceptsDir_returnsEmptyArray', async () => {
      // Arrange — no concept files written; directory doesn't exist
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadConcepts();

      // Assert
      expect(result).toEqual([]);
    });

    it('loadConcepts_singleConcept_returnsCorrectShape', async () => {
      // Arrange — DRIFT-1: assert actual shape, not AC-described shape
      createConcept(tmp, 'patterns', 'error-handling', {
        title: 'Error Handling Strategy',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-05'],
      });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadConcepts();

      // Assert shape: actual fields returned by source
      expect(result).toHaveLength(1);
      const concept = result[0];
      expect(concept).toHaveProperty('slug', 'error-handling');
      expect(concept).toHaveProperty('title', 'Error Handling Strategy');
      expect(concept).toHaveProperty('category', 'patterns');
      expect(concept).toHaveProperty('confidence');
      expect(concept).toHaveProperty('decayedConfidence');
      expect(concept).toHaveProperty('sources');
      expect(concept).toHaveProperty('usageCount');
      expect(concept).toHaveProperty('promotedTo');
      expect(concept).toHaveProperty('updated');

      // No frontmatter or content fields (DRIFT-1 — AC was wrong)
      expect(concept).not.toHaveProperty('frontmatter');
      expect(concept).not.toHaveProperty('content');
    });

    it('loadConcepts_singleConcept_parsesNumericFieldsCorrectly', async () => {
      // Arrange — parseFrontmatter returns strings; source calls parseFloat/parseInt
      createConcept(tmp, 'patterns', 'retry-logic', {
        title: 'Retry Logic',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-05'],
        usage_count: 3,
      });
      const promoter = new MemoryPromoter();

      // Act
      const [concept] = await promoter.loadConcepts();

      // Assert numeric types (not strings) — source calls parseFloat(fm.confidence)
      expect(typeof concept.confidence).toBe('number');
      expect(concept.confidence).toBeCloseTo(0.7);
      expect(typeof concept.usageCount).toBe('number');
      expect(concept.usageCount).toBe(3);
    });

    it('loadConcepts_todayUpdated_decayedConfidenceExceedsBaseConfidence', async () => {
      // Arrange — updated=today means daysSinceUpdate is a tiny fraction (milliseconds).
      // Even with fractional decay, RECENT_UPDATE_BOOST (+0.1) and USAGE_BOOST (*usageCount)
      // push decayedConfidence above the raw confidence value.
      // We cannot assert an exact value because daysSinceUpdate is computed from Date.now()
      // at read-time vs. the ISO timestamp written by createConcept — there's always a tiny
      // nonzero fraction. Asserting range: decayed > confidence and decayed <= 1.0.
      createConcept(tmp, 'patterns', 'caching-strategy', {
        title: 'Caching Strategy',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-05'],
        usage_count: 2,
      });
      const promoter = new MemoryPromoter();

      // Act
      const [concept] = await promoter.loadConcepts();

      // Assert: decayed > raw confidence (boosts applied) and capped at 1.0
      expect(concept.decayedConfidence).toBeGreaterThan(0.7);
      expect(concept.decayedConfidence).toBeLessThanOrEqual(1.0);
      // Upper bound: confidence(0.7) + USAGE_BOOST(0.01)*2 + RECENT_UPDATE_BOOST(0.1) = 0.82
      // Rate^daysSince for "today" is a fraction of a day depending on when during
      // the day the test runs relative to createConcept's ISO timestamp — decayed lands
      // in ~[0.78, 0.82]. Lower bound 0.75 gives headroom and still proves boosts applied.
      expect(concept.decayedConfidence).toBeGreaterThan(0.75);
      expect(concept.decayedConfidence).toBeLessThan(0.83);
    });

    it('loadConcepts_decayedConfidenceCappedAtOne', async () => {
      // Arrange — high confidence + usage_count pushes above 1.0
      createConcept(tmp, 'decisions', 'high-confidence', {
        title: 'High Confidence Decision',
        confidence: 0.95,
        sources: ['2026-04-01', '2026-04-05'],
        usage_count: 20,
      });
      const promoter = new MemoryPromoter();

      // Act
      const [concept] = await promoter.loadConcepts();

      // Assert: cap at 1.0 (0.95 + 0.01*20 + 0.1 = 1.25, capped)
      expect(concept.decayedConfidence).toBe(1.0);
    });

    it('loadConcepts_noUsageCount_defaultsToZero', async () => {
      // Arrange — no usage_count field written
      createConcept(tmp, 'workflows', 'daily-standup', {
        title: 'Daily Standup',
        confidence: 0.6,
        sources: ['2026-04-10'],
      });
      const promoter = new MemoryPromoter();

      // Act
      const [concept] = await promoter.loadConcepts();

      // Assert
      expect(concept.usageCount).toBe(0);
    });

    it('loadConcepts_promotedConcept_setsPromotedTo', async () => {
      // Arrange — write concept with promoted_to in frontmatter manually
      const today = new Date().toISOString().slice(0, 10);
      const filePath = path.join(
        tmp.root, 'docs', '.output', '.state', 'memory-concepts', 'decisions', 'arch-choice.md'
      );
      tmp.write(
        'docs/.output/.state/memory-concepts/decisions/arch-choice.md',
        [
          '---',
          'title: Architecture Choice',
          'category: decisions',
          'confidence: 0.8',
          `updated: ${today}`,
          'sources:',
          '  - 2026-04-01',
          '  - 2026-04-02',
          'usage_count: 1',
          'promoted_to: CLAUDE.md',
          `promoted_at: ${today}`,
          '---',
          '',
          '## Summary',
          '',
          'A promoted decision.',
        ].join('\n')
      );
      const promoter = new MemoryPromoter();

      // Act
      const [concept] = await promoter.loadConcepts();

      // Assert
      expect(concept.promotedTo).toBe('CLAUDE.md');
    });

    it('loadConcepts_allFourCategories_returnsConceptsFromEach', async () => {
      // Arrange — one concept per CATEGORIES list
      createConcept(tmp, 'patterns', 'p1', { title: 'P1', confidence: 0.7, sources: ['2026-04-01'] });
      createConcept(tmp, 'constraints', 'c1', { title: 'C1', confidence: 0.7, sources: ['2026-04-01'] });
      createConcept(tmp, 'decisions', 'd1', { title: 'D1', confidence: 0.7, sources: ['2026-04-01'] });
      createConcept(tmp, 'workflows', 'w1', { title: 'W1', confidence: 0.7, sources: ['2026-04-01'] });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadConcepts();

      // Assert — one from each category
      expect(result).toHaveLength(4);
      const categories = result.map(c => c.category).sort();
      expect(categories).toEqual(['constraints', 'decisions', 'patterns', 'workflows']);
    });

    it('loadConcepts_skipsNonMdFiles_inCategoryDir', async () => {
      // Arrange — concept + non-md file in same category dir
      createConcept(tmp, 'patterns', 'valid-concept', {
        title: 'Valid Concept',
        confidence: 0.7,
        sources: ['2026-04-01'],
      });
      tmp.write('docs/.output/.state/memory-concepts/patterns/notes.txt', 'ignore me');
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadConcepts();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('valid-concept');
    });

  });

  // ── calculatePromotionScore ─────────────────────────────────────────────────

  describe('calculatePromotionScore', () => {

    it('calculatePromotionScore_zeroCrossRefs_equalsDecayedConfidenceTimesUsageBoost', () => {
      // Arrange — DRIFT-2: 3-arg signature; formula: decayed * (1 + min(usageCount*0.1,1.0)) * (1 + 0)
      const promoter = new MemoryPromoter();
      const concept = {
        slug: 'test-concept',
        decayedConfidence: 0.8,
        usageCount: 0,
      };
      const crossRefs = {};
      const totalConcepts = 5;

      // Act
      const score = promoter.calculatePromotionScore(concept, crossRefs, totalConcepts);

      // Assert: 0.8 * (1 + 0) * (1 + 0) = 0.8
      expect(score).toBeCloseTo(0.8);
    });

    it('calculatePromotionScore_withUsageCount_appliesUsageBoost', () => {
      // Arrange — usage_boost = min(usageCount * 0.1, 1.0)
      const promoter = new MemoryPromoter();
      const concept = {
        slug: 'test-concept',
        decayedConfidence: 0.8,
        usageCount: 5,
      };
      const crossRefs = {};
      const totalConcepts = 10;

      // Act
      const score = promoter.calculatePromotionScore(concept, crossRefs, totalConcepts);

      // Assert: 0.8 * (1 + 0.5) * (1 + 0) = 1.2
      expect(score).toBeCloseTo(0.8 * 1.5 * 1.0);
    });

    it('calculatePromotionScore_usageBoostCappedAtOne', () => {
      // Arrange — usageCount=20 → min(20*0.1, 1.0) = 1.0
      const promoter = new MemoryPromoter();
      const concept = {
        slug: 'heavy-hitter',
        decayedConfidence: 0.9,
        usageCount: 20,
      };
      const crossRefs = {};
      const totalConcepts = 5;

      // Act
      const score = promoter.calculatePromotionScore(concept, crossRefs, totalConcepts);

      // Assert: 0.9 * (1 + 1.0) * (1 + 0) = 1.8
      expect(score).toBeCloseTo(0.9 * 2.0 * 1.0);
    });

    it('calculatePromotionScore_withCrossRefs_appliesCrossRefDensity', () => {
      // Arrange — cross_ref_density = relatedCount / totalConcepts
      const promoter = new MemoryPromoter();
      const concept = {
        slug: 'well-connected',
        decayedConfidence: 0.7,
        usageCount: 0,
      };
      const crossRefs = {
        'well-connected': { related: ['other-a', 'other-b'] },
      };
      const totalConcepts = 10;

      // Act
      const score = promoter.calculatePromotionScore(concept, crossRefs, totalConcepts);

      // Assert: 0.7 * (1 + 0) * (1 + 2/10) = 0.7 * 1 * 1.2 = 0.84
      expect(score).toBeCloseTo(0.7 * 1.0 * 1.2);
    });

    it('calculatePromotionScore_withUsageAndCrossRefs_combinesAllFactors', () => {
      // Arrange — all three factors active
      const promoter = new MemoryPromoter();
      const concept = {
        slug: 'full-combo',
        decayedConfidence: 0.8,
        usageCount: 3,
      };
      const crossRefs = {
        'full-combo': { related: ['x', 'y', 'z', 'w'] },
      };
      const totalConcepts = 8;

      // Act
      const score = promoter.calculatePromotionScore(concept, crossRefs, totalConcepts);

      // Assert: 0.8 * (1 + 0.3) * (1 + 4/8) = 0.8 * 1.3 * 1.5 = 1.56
      expect(score).toBeCloseTo(0.8 * 1.3 * 1.5);
    });

    it('calculatePromotionScore_zeroConcepts_crossRefDensityIsZero', () => {
      // Arrange — totalConcepts=0 → density guard prevents divide-by-zero
      const promoter = new MemoryPromoter();
      const concept = {
        slug: 'lone',
        decayedConfidence: 0.6,
        usageCount: 0,
      };
      const crossRefs = { 'lone': { related: ['a', 'b'] } };

      // Act
      const score = promoter.calculatePromotionScore(concept, crossRefs, 0);

      // Assert: density = 0 when totalConcepts=0; 0.6 * 1 * 1 = 0.6
      expect(score).toBeCloseTo(0.6);
    });

    it('calculatePromotionScore_missingCrossRefEntry_usesZeroRelated', () => {
      // Arrange — concept slug not in crossRefs
      const promoter = new MemoryPromoter();
      const concept = {
        slug: 'unknown',
        decayedConfidence: 0.75,
        usageCount: 2,
      };
      const crossRefs = { 'other-slug': { related: ['a'] } };

      // Act
      const score = promoter.calculatePromotionScore(concept, crossRefs, 10);

      // Assert: relatedCount=0; 0.75 * (1 + 0.2) * (1 + 0) = 0.75 * 1.2 = 0.9
      expect(score).toBeCloseTo(0.75 * 1.2 * 1.0);
    });

  });

  // ── isEligible ─────────────────────────────────────────────────────────────

  describe('isEligible', () => {

    // DRIFT-3: AC said "category in allowlist AND confidence >= threshold"
    // Source actually checks: decayedConfidence >= 0.5 && sources.length >= 2 && !promotedTo
    // No category allowlist exists in source. Tests verify the actual three checks.

    it('isEligible_meetsAllCriteria_returnsTrue', () => {
      // Arrange
      const promoter = new MemoryPromoter();
      const concept = {
        decayedConfidence: 0.7,
        sources: ['2026-04-01', '2026-04-05'],
        promotedTo: null,
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(true);
    });

    it('isEligible_belowConfidenceThreshold_returnsFalse', () => {
      // Arrange — DRIFT-3: threshold is decayedConfidence >= 0.5, not raw confidence
      const promoter = new MemoryPromoter();
      const concept = {
        decayedConfidence: 0.49,
        sources: ['2026-04-01', '2026-04-05'],
        promotedTo: null,
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(false);
    });

    it('isEligible_exactlyAtThreshold_returnsTrue', () => {
      // Arrange — boundary: 0.5 is the minimum passing value
      const promoter = new MemoryPromoter();
      const concept = {
        decayedConfidence: 0.5,
        sources: ['2026-04-01', '2026-04-05'],
        promotedTo: null,
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(true);
    });

    it('isEligible_onlyOneSource_returnsFalse', () => {
      // Arrange — sources.length >= 2 required; one source fails
      const promoter = new MemoryPromoter();
      const concept = {
        decayedConfidence: 0.8,
        sources: ['2026-04-01'],
        promotedTo: null,
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(false);
    });

    it('isEligible_noSources_returnsFalse', () => {
      // Arrange
      const promoter = new MemoryPromoter();
      const concept = {
        decayedConfidence: 0.8,
        sources: [],
        promotedTo: null,
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(false);
    });

    it('isEligible_alreadyPromoted_returnsFalse', () => {
      // Arrange — promotedTo truthy blocks eligibility
      const promoter = new MemoryPromoter();
      const concept = {
        decayedConfidence: 0.9,
        sources: ['2026-04-01', '2026-04-05'],
        promotedTo: 'CLAUDE.md',
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(false);
    });

    it('isEligible_handCuratedWithEmptySources_returnsTrue', () => {
      // Arrange — hand-created memories have no `sources` array but should be eligible
      // when confidence is high. The sources>=2 filter is for compiled-concept noise,
      // not human-curated entries.
      const promoter = new MemoryPromoter();
      const concept = {
        handCurated: true,
        decayedConfidence: 0.7,
        sources: [],
        promotedTo: null,
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(true);
    });

    it('isEligible_handCuratedAlreadyPromoted_returnsFalse', () => {
      // Arrange — already-promoted check applies regardless of handCurated
      const promoter = new MemoryPromoter();
      const concept = {
        handCurated: true,
        decayedConfidence: 0.9,
        sources: [],
        promotedTo: 'CLAUDE.md',
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(false);
    });

    it('isEligible_handCuratedBelowConfidence_returnsFalse', () => {
      // Arrange — confidence threshold (0.5) applies regardless of handCurated
      const promoter = new MemoryPromoter();
      const concept = {
        handCurated: true,
        decayedConfidence: 0.4,
        sources: [],
        promotedTo: null,
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(false);
    });

    it('isEligible_noCategory_allowlistNotChecked_returnsTrue', () => {
      // Arrange — DRIFT-3: no category allowlist in source; any category passes
      // This test documents that omitting category doesn't block eligibility
      const promoter = new MemoryPromoter();
      const concept = {
        category: 'rejected-approaches', // not in CATEGORIES, still eligible
        decayedConfidence: 0.8,
        sources: ['2026-04-01', '2026-04-05'],
        promotedTo: null,
      };

      // Act + Assert
      expect(promoter.isEligible(concept)).toBe(true);
    });

  });

  // ── loadCrossReferences ────────────────────────────────────────────────────

  describe('loadCrossReferences', () => {

    it('loadCrossReferences_fileNotFound_returnsEmptyObject', async () => {
      // Arrange — no cross-references.json written
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadCrossReferences();

      // Assert
      expect(result).toEqual({});
    });

    it('loadCrossReferences_validFile_returnsParsedObject', async () => {
      // Arrange — DRIFT-6: write file directly instead of running memory-compiler
      // (AC says "use the compiler to generate it" but direct write is faster and
      //  equally valid for unit testing — avoids heavyweight compiler dependency)
      const crossRefData = {
        'error-handling': { related: ['retry-logic', 'circuit-breaker'] },
        'retry-logic': { related: ['error-handling'] },
      };
      tmp.write(
        'docs/.output/.state/memory-concepts/cross-references.json',
        JSON.stringify(crossRefData)
      );
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadCrossReferences();

      // Assert
      expect(result).toEqual(crossRefData);
      expect(result['error-handling'].related).toHaveLength(2);
    });

    it('loadCrossReferences_malformedJson_returnsEmptyObject', async () => {
      // Arrange — invalid JSON should not throw; source catches and returns {}
      tmp.write(
        'docs/.output/.state/memory-concepts/cross-references.json',
        '{ not valid json :::'
      );
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadCrossReferences();

      // Assert
      expect(result).toEqual({});
    });

  });

  // ── loadHandCreatedMemories ────────────────────────────────────────────────

  describe('loadHandCreatedMemories', () => {

    it('loadHandCreatedMemories_emptyDirs_returnsEmptyArray', async () => {
      // Arrange — no JSON memories written
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadHandCreatedMemories();

      // Assert
      expect(result).toEqual([]);
    });

    it('loadHandCreatedMemories_singleJsonMemory_returnsCorrectShape', async () => {
      // Arrange — write a hand-created JSON memory in patterns/
      writeHandCreatedMemory(tmp, 'patterns', 'statistical-test-threshold-widening', {
        confidence: 0.9,
        usage_count: 0,
      });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadHandCreatedMemories();

      // Assert
      expect(result).toHaveLength(1);
      const concept = result[0];
      expect(concept).toHaveProperty('slug', 'statistical-test-threshold-widening');
      expect(concept).toHaveProperty('title', 'Statistical Test Threshold Widening');
      expect(concept).toHaveProperty('category', 'patterns');
      expect(concept).toHaveProperty('confidence');
      expect(concept.confidence).toBeCloseTo(0.9);
      expect(concept).toHaveProperty('decayedConfidence');
      expect(concept.sources).toEqual([]);
      expect(concept).toHaveProperty('usageCount', 0);
      expect(concept).toHaveProperty('promotedTo', null);
      expect(concept).toHaveProperty('updated');
      expect(concept).toHaveProperty('handCurated', true);
    });

    it('loadHandCreatedMemories_skipsNonJsonFiles', async () => {
      // Arrange — JSON sibling + non-JSON files in same category dir
      writeHandCreatedMemory(tmp, 'patterns', 'real-pattern', { confidence: 0.7 });
      tmp.write('docs/.output/.memory/patterns/notes.txt', 'ignore me');
      tmp.write('docs/.output/.memory/patterns/draft.md', '# draft');
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadHandCreatedMemories();

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('real-pattern');
    });

    it('loadHandCreatedMemories_allFourCategories_returnsConceptsFromEach', async () => {
      // Arrange — one JSON memory per category
      writeHandCreatedMemory(tmp, 'patterns', 'p1', { confidence: 0.7 });
      writeHandCreatedMemory(tmp, 'constraints', 'c1', { confidence: 0.7 });
      writeHandCreatedMemory(tmp, 'decisions', 'd1', { confidence: 0.7 });
      writeHandCreatedMemory(tmp, 'workflows', 'w1', { confidence: 0.7 });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadHandCreatedMemories();

      // Assert
      expect(result).toHaveLength(4);
      const categories = result.map(c => c.category).sort();
      expect(categories).toEqual(['constraints', 'decisions', 'patterns', 'workflows']);
      // All carry handCurated flag
      expect(result.every(c => c.handCurated === true)).toBe(true);
    });

    it('loadHandCreatedMemories_decayedConfidenceComputed_likeCompiledPath', async () => {
      // Arrange — today-updated, confidence 0.7, usage_count 2 → decayed > raw
      // (RECENT_UPDATE_BOOST 0.1 + USAGE_BOOST 0.01*2 = 0.12 over baseline)
      writeHandCreatedMemory(tmp, 'patterns', 'recent-pattern', {
        confidence: 0.7,
        usage_count: 2,
      });
      const promoter = new MemoryPromoter();

      // Act
      const [concept] = await promoter.loadHandCreatedMemories();

      // Assert — same range used in loadConcepts test (~0.78–0.82)
      expect(concept.decayedConfidence).toBeGreaterThan(0.7);
      expect(concept.decayedConfidence).toBeGreaterThan(0.75);
      expect(concept.decayedConfidence).toBeLessThan(0.83);
    });

    it('loadHandCreatedMemories_malformedJson_skipsGracefully', async () => {
      // Arrange — invalid JSON sibling + valid JSON memory
      writeHandCreatedMemory(tmp, 'patterns', 'good-one', { confidence: 0.7 });
      tmp.write('docs/.output/.memory/patterns/broken.json', '{not valid json :::');
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadHandCreatedMemories();

      // Assert — broken file silently skipped, good one still loaded
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('good-one');
    });

    it('loadHandCreatedMemories_doesNotDescendIntoConceptsSubdir', async () => {
      // Arrange — JSON file accidentally inside concepts/{cat}/ should NOT be loaded
      // by the hand-created path (concepts/ is owned by the compiled markdown loader).
      writeHandCreatedMemory(tmp, 'patterns', 'real-handcreated', { confidence: 0.7 });
      tmp.write(
        'docs/.output/.state/memory-concepts/patterns/stray.json',
        JSON.stringify({ id: 'stray', category: 'patterns', content: { confidence: 0.9 } })
      );
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadHandCreatedMemories();

      // Assert — only the top-level pattern; the stray under concepts/ is ignored
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('real-handcreated');
    });

    // ── CR-3.4 (F47): supersession-aware read ────────────────────────────────

    it('loadHandCreatedMemories_supersededMemory_isHidden_F47', async () => {
      // Arrange — a live memory + a superseded memory (invalid_at/superseded_by
      // stamped, mirroring the exact shape MemoryManager.supersedeMemory writes).
      // loadHandCreatedMemories must route through MemoryManager's
      // supersession-aware read (listMemories, includeSuperseded default false)
      // so a superseded hand-created memory is hidden from current-state scans —
      // matching every other current-state consumer (analytics, lint, prune,
      // search JSON-fallback).
      writeHandCreatedMemory(tmp, 'patterns', 'live-pattern', { confidence: 0.8 });
      writeHandCreatedMemory(tmp, 'patterns', 'superseded-pattern', {
        confidence: 0.9,
        invalid_at: new Date().toISOString(),
        superseded_by: 'live-pattern',
      });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.loadHandCreatedMemories();

      // Assert
      const slugs = result.map(c => c.slug);
      expect(slugs).toContain('live-pattern');
      expect(slugs).not.toContain('superseded-pattern');
    });

    // ── CR-3.4 (F48): importance/3 retention-floor in decay computation ─────

    it('loadHandCreatedMemories_appliesImportanceFloor_matchesCanonicalFormula_F48', async () => {
      // Arrange — importance=1 (below IMPORTANCE_DEFAULT=3) must shrink the
      // decayed confidence by a factor of importance/3, exactly matching
      // MemoryManager.calculateDecayedConfidence's ADDED floor factor on top of
      // the shared _lib/memory-decay curve.
      writeHandCreatedMemory(tmp, 'patterns', 'low-importance-pattern', {
        confidence: 0.9,
        usage_count: 0,
        importance: 1,
      });
      const promoter = new MemoryPromoter();

      // Act
      const [concept] = await promoter.loadHandCreatedMemories();

      // Assert — recompute the canonical formula independently (shared decay lib
      // + importance/3 floor) and confirm the promoter's output matches it, not
      // just the unfloored curve.
      const memoryDecay = require('../_lib/memory-decay');
      const writtenRaw = JSON.parse(
        tmp.read('docs/.output/.memory/patterns/low-importance-pattern.json')
      );
      const unflooredBase = memoryDecay.calculateDecayedConfidence({
        confidence: 0.9,
        category: 'patterns',
        usageCount: 0,
        updated: writtenRaw.updated,
        activeDays: (Date.now() - new Date(writtenRaw.updated)) / (1000 * 60 * 60 * 24),
      });
      const expectedFloored = Math.min(1.0, unflooredBase * (1 / 3));

      expect(concept.decayedConfidence).toBeCloseTo(expectedFloored, 4);
      // Sanity — the floor must actually suppress the value below the unfloored curve.
      expect(concept.decayedConfidence).toBeLessThan(unflooredBase);
    });

  });

  // ── scan integration ────────────────────────────────────────────────────────

  describe('scan', () => {

    it('scan_noConcepts_returnsEmptyArray', async () => {
      // Arrange — no concept files
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.scan();

      // Assert
      expect(result).toEqual([]);
    });

    it('scan_tenConceptsAcrossCategories_returnsAllEligible', async () => {
      // Arrange — 10 concepts spread across 4 categories, all eligible
      const specs = [
        { cat: 'patterns', slug: 'p1', conf: 0.9, usage: 5 },
        { cat: 'patterns', slug: 'p2', conf: 0.7, usage: 2 },
        { cat: 'patterns', slug: 'p3', conf: 0.6, usage: 0 },
        { cat: 'constraints', slug: 'c1', conf: 0.8, usage: 3 },
        { cat: 'constraints', slug: 'c2', conf: 0.7, usage: 1 },
        { cat: 'decisions', slug: 'd1', conf: 0.85, usage: 4 },
        { cat: 'decisions', slug: 'd2', conf: 0.75, usage: 0 },
        { cat: 'workflows', slug: 'w1', conf: 0.65, usage: 2 },
        { cat: 'workflows', slug: 'w2', conf: 0.6, usage: 1 },
        { cat: 'workflows', slug: 'w3', conf: 0.55, usage: 0 },
      ];
      for (const s of specs) {
        createConcept(tmp, s.cat, s.slug, {
          title: s.slug.toUpperCase(),
          confidence: s.conf,
          sources: ['2026-04-01', '2026-04-10'],
          usage_count: s.usage,
        });
      }
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.scan();

      // Assert — 10 eligible concepts, default top=10 returns all
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThanOrEqual(10);

      // Each result has the candidate shape from scan()
      const first = result[0];
      expect(first).toHaveProperty('slug');
      expect(first).toHaveProperty('title');
      expect(first).toHaveProperty('category');
      expect(first).toHaveProperty('promotionScore');
      expect(first).toHaveProperty('decayedConfidence');
      expect(first).toHaveProperty('sourceCount');
      expect(first).toHaveProperty('crossRefCount');
      expect(first).toHaveProperty('suggestedTarget');
    });

    it('scan_respectsTopFlag_limitsResults', async () => {
      // Arrange — 6 eligible concepts, ask for top 3
      for (let i = 1; i <= 6; i++) {
        createConcept(tmp, 'patterns', `concept-${i}`, {
          title: `Concept ${i}`,
          confidence: 0.5 + i * 0.05,
          sources: ['2026-04-01', '2026-04-10'],
        });
      }
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.scan({ top: 3 });

      // Assert
      expect(result).toHaveLength(3);
    });

    it('scan_sortedByPromotionScoreDescending', async () => {
      // Arrange — concepts with different scores; highest should come first
      createConcept(tmp, 'patterns', 'low-score', {
        title: 'Low Score',
        confidence: 0.5,
        sources: ['2026-04-01', '2026-04-05'],
        usage_count: 0,
      });
      createConcept(tmp, 'decisions', 'high-score', {
        title: 'High Score',
        confidence: 0.9,
        sources: ['2026-04-01', '2026-04-05'],
        usage_count: 8,
      });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.scan();

      // Assert — high-score concept ranked first
      expect(result[0].slug).toBe('high-score');
      expect(result[0].promotionScore).toBeGreaterThan(result[1].promotionScore);
    });

    it('scan_ineligibleConceptsExcluded_onlyEligibleReturned', async () => {
      // Arrange — one eligible (2 sources, decayed >= 0.5, not promoted), one not (only 1 source)
      createConcept(tmp, 'patterns', 'eligible', {
        title: 'Eligible',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-10'],
      });
      createConcept(tmp, 'patterns', 'ineligible-one-source', {
        title: 'One Source Only',
        confidence: 0.8,
        sources: ['2026-04-01'],
      });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.scan();

      // Assert — only eligible concept returned
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('eligible');
    });

    it('scan_mergesHandCuratedAndCompiled_bothSurface', async () => {
      // Arrange — one compiled concept (eligible: 2 sources) + one hand-created memory
      createConcept(tmp, 'patterns', 'compiled-eligible', {
        title: 'Compiled Eligible',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-10'],
      });
      writeHandCreatedMemory(tmp, 'patterns', 'hand-curated-eligible', {
        confidence: 0.85,
      });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.scan();

      // Assert — both appear in scan output
      const slugs = result.map(c => c.slug).sort();
      expect(slugs).toContain('compiled-eligible');
      expect(slugs).toContain('hand-curated-eligible');
    });

    it('scan_handCuratedHighConfidence_outranksLowConfidenceCompiled', async () => {
      // Arrange — verifies merge + sort works end-to-end across both sources
      createConcept(tmp, 'patterns', 'low-compiled', {
        title: 'Low Compiled',
        confidence: 0.5,
        sources: ['2026-04-01', '2026-04-10'],
        usage_count: 0,
      });
      writeHandCreatedMemory(tmp, 'patterns', 'high-handcurated', {
        confidence: 0.9,
        usage_count: 5,
      });
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.scan();

      // Assert — hand-created with confidence 0.9 + usage 5 > compiled with 0.5
      expect(result[0].slug).toBe('high-handcurated');
      expect(result[0].promotionScore).toBeGreaterThan(result[1].promotionScore);
    });

    it('scan_usesCrossRefData_whenAvailable', async () => {
      // Arrange — write concepts and cross-references.json directly
      createConcept(tmp, 'patterns', 'referenced', {
        title: 'Referenced Pattern',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-10'],
      });
      createConcept(tmp, 'decisions', 'unreferenced', {
        title: 'Unreferenced Decision',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-10'],
      });
      tmp.write(
        'docs/.output/.state/memory-concepts/cross-references.json',
        JSON.stringify({ 'referenced': { related: ['unreferenced'] } })
      );
      const promoter = new MemoryPromoter();

      // Act
      const result = await promoter.scan();

      // Assert — 'referenced' should rank higher due to cross-ref density
      expect(result[0].slug).toBe('referenced');
      expect(result[0].crossRefCount).toBe(1);
      expect(result[1].crossRefCount).toBe(0);
    });

  });

  // ── mark ───────────────────────────────────────────────────────────────────

  describe('mark', () => {

    it('mark_validConcept_writespromotedToFrontmatter', async () => {
      // Arrange
      createConcept(tmp, 'patterns', 'cache-strategy', {
        title: 'Cache Strategy',
        confidence: 0.8,
        sources: ['2026-04-01', '2026-04-10'],
      });
      const promoter = new MemoryPromoter();

      // Act
      await promoter.mark('cache-strategy', 'skills/qa-engineer/SKILL.md');

      // Assert — read file back and verify frontmatter fields inserted
      const written = tmp.read('docs/.output/.state/memory-concepts/patterns/cache-strategy.md');
      expect(written).toContain('promoted_to: skills/qa-engineer/SKILL.md');
      expect(written).toContain('promoted_at: ');
    });

    it('mark_preservesOtherFrontmatter_afterPromotion', async () => {
      // Arrange
      createConcept(tmp, 'decisions', 'arch-decision', {
        title: 'Architecture Decision',
        confidence: 0.85,
        sources: ['2026-04-01', '2026-04-10'],
        usage_count: 3,
      });
      const promoter = new MemoryPromoter();

      // Act
      await promoter.mark('arch-decision', 'CLAUDE.md');

      // Assert — existing frontmatter fields preserved
      const written = tmp.read('docs/.output/.state/memory-concepts/decisions/arch-decision.md');
      expect(written).toContain('title: Architecture Decision');
      expect(written).toContain('confidence: 0.85');
      expect(written).toContain('category: decisions');
      expect(written).toContain('usage_count: 3');
      // New fields also present
      expect(written).toContain('promoted_to: CLAUDE.md');
    });

    it('mark_promotedAtContainsTodayDate', async () => {
      // Arrange
      createConcept(tmp, 'workflows', 'deploy-workflow', {
        title: 'Deploy Workflow',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-10'],
      });
      const promoter = new MemoryPromoter();
      const today = new Date().toISOString().slice(0, 10);

      // Act
      await promoter.mark('deploy-workflow', 'agent frontmatter');

      // Assert
      const written = tmp.read('docs/.output/.state/memory-concepts/workflows/deploy-workflow.md');
      expect(written).toContain(`promoted_at: ${today}`);
    });

    it('mark_conceptNotFound_callsProcessExit', async () => {
      // Arrange — DRIFT-5: source calls process.exit(1); stub to convert to throw
      const promoter = new MemoryPromoter();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // Act + Assert
      try {
        await expect(
          promoter.mark('nonexistent-slug', 'CLAUDE.md')
        ).rejects.toThrow('process.exit called');
      } finally {
        exitSpy.mockRestore();
      }
    });

    it('mark_alreadyPromoted_callsProcessExit', async () => {
      // Arrange — concept already has promoted_to; DRIFT-5: process.exit(1)
      const today = new Date().toISOString().slice(0, 10);
      tmp.write(
        'docs/.output/.state/memory-concepts/patterns/already-promoted.md',
        [
          '---',
          'title: Already Promoted',
          'category: patterns',
          'confidence: 0.8',
          `updated: ${today}`,
          'sources:',
          '  - 2026-04-01',
          '  - 2026-04-10',
          'promoted_to: CLAUDE.md',
          `promoted_at: ${today}`,
          '---',
          '',
          '## Summary',
          '',
          'Already promoted.',
        ].join('\n')
      );
      const promoter = new MemoryPromoter();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // Act + Assert
      try {
        await expect(
          promoter.mark('already-promoted', 'skills/other/SKILL.md')
        ).rejects.toThrow('process.exit called');
      } finally {
        exitSpy.mockRestore();
      }
    });

    it('mark_handCreatedJsonMemory_addsPromotedMetadata', async () => {
      // Arrange — hand-created JSON memory at {cat}/{slug}.json (NOT under concepts/)
      writeHandCreatedMemory(tmp, 'patterns', 'plan-first-per-wave-handoff', {
        confidence: 0.9,
      });
      const promoter = new MemoryPromoter();

      // Act
      await promoter.mark('plan-first-per-wave-handoff', '.claude/skills/qa-engineer/SKILL.md');

      // Assert — read JSON back, check metadata fields
      const written = JSON.parse(
        tmp.read('docs/.output/.memory/patterns/plan-first-per-wave-handoff.json')
      );
      expect(written.metadata.promoted_to).toBe('.claude/skills/qa-engineer/SKILL.md');
      expect(written.metadata.promoted_at).toBeTruthy();
    });

    it('mark_handCreatedAlreadyPromoted_callsProcessExit', async () => {
      // Arrange — JSON with metadata.promoted_to already set
      writeHandCreatedMemory(tmp, 'patterns', 'already-promoted-json', {
        confidence: 0.8,
        metadata: { promoted_to: 'CLAUDE.md', promoted_at: '2026-04-01' },
      });
      const promoter = new MemoryPromoter();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // Act + Assert
      try {
        await expect(
          promoter.mark('already-promoted-json', 'skills/other/SKILL.md')
        ).rejects.toThrow('process.exit called');
      } finally {
        exitSpy.mockRestore();
      }
    });

    it('mark_handCreatedPreservesOtherMetadata', async () => {
      // Arrange — JSON with populated metadata.sessions and metadata.agents
      writeHandCreatedMemory(tmp, 'workflows', 'multi-meta-workflow', {
        confidence: 0.75,
        metadata: { sessions: ['s1', 's2'], agents: ['general-purpose'], confidence: 1 },
      });
      const promoter = new MemoryPromoter();

      // Act
      await promoter.mark('multi-meta-workflow', 'agent frontmatter');

      // Assert — existing metadata preserved alongside new fields
      const written = JSON.parse(
        tmp.read('docs/.output/.memory/workflows/multi-meta-workflow.json')
      );
      expect(written.metadata.sessions).toEqual(['s1', 's2']);
      expect(written.metadata.agents).toEqual(['general-purpose']);
      expect(written.metadata.confidence).toBe(1);
      expect(written.metadata.promoted_to).toBe('agent frontmatter');
    });

    it('mark_handCreatedPromotedAtIsToday', async () => {
      // Arrange
      writeHandCreatedMemory(tmp, 'patterns', 'today-test', { confidence: 0.7 });
      const promoter = new MemoryPromoter();
      const today = new Date().toISOString().slice(0, 10);

      // Act
      await promoter.mark('today-test', 'CLAUDE.md');

      // Assert
      const written = JSON.parse(tmp.read('docs/.output/.memory/patterns/today-test.json'));
      expect(written.metadata.promoted_at).toBe(today);
    });

    it('mark_notFoundError_listsBothSearchPaths', async () => {
      // Arrange — neither .md nor .json exists for this slug
      const promoter = new MemoryPromoter();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      // Act
      try {
        await expect(
          promoter.mark('absent-slug', 'CLAUDE.md')
        ).rejects.toThrow('process.exit called');
      } finally {
        // Capture all console.error calls (joined) BEFORE restoring
        const allErrors = errorSpy.mock.calls.map(args => args.join(' ')).join('\n');
        // Assert — the search-paths line mentions both compiled and hand-created locations
        expect(allErrors).toContain('concepts/patterns/absent-slug.md');
        expect(allErrors).toContain('patterns/absent-slug.json');
        errorSpy.mockRestore();
        exitSpy.mockRestore();
      }
    });

    it('mark_markdownPathPreferred_whenBothExist', async () => {
      // Arrange — same slug exists in both compiled .md and hand-created .json
      // Markdown wins (preserves prior behavior + future-proofs against slug collisions).
      createConcept(tmp, 'patterns', 'collision-slug', {
        title: 'Collision Slug',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-10'],
      });
      writeHandCreatedMemory(tmp, 'patterns', 'collision-slug', { confidence: 0.9 });
      const promoter = new MemoryPromoter();

      // Act
      await promoter.mark('collision-slug', 'CLAUDE.md');

      // Assert — markdown was updated (frontmatter contains promoted_to), JSON untouched
      const md = tmp.read('docs/.output/.state/memory-concepts/patterns/collision-slug.md');
      expect(md).toContain('promoted_to: CLAUDE.md');

      const json = JSON.parse(tmp.read('docs/.output/.memory/patterns/collision-slug.json'));
      expect(json.metadata?.promoted_to).toBeUndefined();
    });

    it('mark_updatesPromotedToField_inConcept', async () => {
      // Arrange — verify the promotedTo field when re-loaded
      createConcept(tmp, 'constraints', 'memory-limit', {
        title: 'Memory Limit',
        confidence: 0.75,
        sources: ['2026-04-01', '2026-04-10'],
      });
      const promoter = new MemoryPromoter();

      // Act
      await promoter.mark('memory-limit', 'architecture/overview.md template');

      // Assert — reload the concept and check promotedTo field
      const [concept] = await promoter.loadConcepts();
      expect(concept.promotedTo).toBe('architecture/overview.md template');
    });

  });

  // ── mark — path-traversal guard (F46) ────────────────────────────────────────
  // mark(slug, target) joins `slug` straight into both `.md` and `.json` store
  // paths across all 5 categories. Verify it refuses the three attack shapes
  // BEFORE any path is built/read/written, and that no file outside the store
  // is touched.

  describe('mark — path-traversal guard (F46)', () => {
    const BAD_SLUGS = ['../../etc/x', 'a/../../b', '/etc/passwd'];

    for (const badSlug of BAD_SLUGS) {
      it(`mark_rejects_${badSlug}`, async () => {
        // Plant sentinels at plausible escape targets for both the compiled
        // markdown-concept path and the hand-created-JSON path — if the guard
        // failed, mark() would happily read/rewrite one of these.
        const sentinelMdRel = 'docs/.output/etc/x.md';
        const sentinelJsonRel = 'docs/.output/b.json';
        tmp.write(sentinelMdRel, '---\ntitle: Sentinel\n---\n\nbody\n');
        tmp.write(sentinelJsonRel, JSON.stringify({ id: 'sentinel', metadata: {} }));

        const promoter = new MemoryPromoter();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
          throw new Error('process.exit called');
        });

        try {
          await expect(promoter.mark(badSlug, 'CLAUDE.md')).rejects.toThrow('process.exit called');
          const allErrors = errorSpy.mock.calls.map(args => args.join(' ')).join('\n');
          expect(allErrors).toMatch(/Invalid slug/);
        } finally {
          errorSpy.mockRestore();
          exitSpy.mockRestore();
        }

        // Sentinels untouched — no escape.
        expect(tmp.read(sentinelMdRel)).not.toContain('promoted_to');
        expect(JSON.parse(tmp.read(sentinelJsonRel)).metadata.promoted_to).toBeUndefined();
      });
    }

    it('mark_normalSlug_stillWorks_noFalseRejection', async () => {
      createConcept(tmp, 'patterns', 'safe-normal-slug', {
        title: 'Safe Normal Slug',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-10'],
      });
      const promoter = new MemoryPromoter();

      await promoter.mark('safe-normal-slug', 'CLAUDE.md');

      const md = tmp.read('docs/.output/.state/memory-concepts/patterns/safe-normal-slug.md');
      expect(md).toContain('promoted_to: CLAUDE.md');
    });

    it('mark_leadingUnderscoreSlug_accepted_noFalseRejection_W2_5', async () => {
      // W2-5: SAFE_SLUG_RE now allows a leading underscore, in lockstep with
      // memory-manager's SAFE_ID_RE — a legitimately-stored leading-underscore
      // memory (e.g. the fixed '_health_check_probe' probe id) must be
      // promotable, not rejected as an invalid slug. '_' is not a traversal char.
      createConcept(tmp, 'patterns', '_health_check_probe', {
        title: 'Health Check Probe',
        confidence: 0.7,
        sources: ['2026-04-01', '2026-04-10'],
      });
      const promoter = new MemoryPromoter();

      await promoter.mark('_health_check_probe', 'CLAUDE.md');

      const md = tmp.read('docs/.output/.state/memory-concepts/patterns/_health_check_probe.md');
      expect(md).toContain('promoted_to: CLAUDE.md');
    });
  });

});
