// AC→source: MEMORY_DECAY.RATES (nested), MEMORY_CATEGORIES is an object — see TDD-2.1

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const constants = require('../constants');

describe('constants', () => {
  it('memoryDecay_rates_containsExpectedCategories', () => {
    // Arrange
    const rates = constants.MEMORY_DECAY.RATES;

    // Act / Assert
    for (const key of ['decisions', 'constraints', 'patterns', 'workflows']) {
      expect(typeof rates[key]).toBe('number');
      expect(rates[key]).toBeGreaterThanOrEqual(0.9);
      expect(rates[key]).toBeLessThanOrEqual(0.99);
    }
  });

  it('memoryFilters_maxPerCategory_is150', () => {
    // Arrange / Act / Assert — the single source of truth for the per-category
    // cap (env-overridden at call sites). Static 150 keeps require() deterministic.
    expect(constants.MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY).toBe(150);
  });

  it('memoryFilters_nearLimitPct_is080', () => {
    // Single source for the prune/warn/near-limit threshold — read by
    // memory-manager, memory-guard, and memory-lint (never re-hardcode 0.8).
    expect(constants.MEMORY_FILTERS.MEMORY_NEAR_LIMIT_PCT).toBe(0.8);
  });

  it('memoryCategories_values_matchExpectedStrings', () => {
    // Arrange
    const expected = ['patterns', 'workflows', 'constraints', 'decisions', 'rejected-approaches'];

    // Act
    const values = Object.values(constants.MEMORY_CATEGORIES);

    // Assert
    for (const cat of expected) {
      expect(values).toContain(cat);
    }
  });

  it('phaseArtifacts_existsAndNonEmpty', () => {
    // Arrange
    const pa = constants.PHASE_ARTIFACTS;

    // Act / Assert
    expect(pa).toBeDefined();
    expect(typeof pa).toBe('object');
    for (const key of [1, 2, 3, 4]) {
      expect(Array.isArray(pa[key])).toBe(true);
      expect(pa[key].length).toBeGreaterThan(0);
    }
  });

  it('docChain_existsAndHasFeeds', () => {
    // Arrange
    const dc = constants.DOC_CHAIN;

    // Act
    const entriesWithFeeds = Object.values(dc).filter(
      (entry) => Array.isArray(entry.feeds) && entry.feeds.length > 0
    );

    // Assert
    expect(dc).toBeDefined();
    expect(typeof dc).toBe('object');
    expect(entriesWithFeeds.length).toBeGreaterThan(0);
  });

  it('docPaths_existsAndUsesDomainTaxonomy', () => {
    // Arrange — the canonical docs/-relative path map (ADR 2026-06-20).
    const dp = constants.DOC_PATHS;

    // Act / Assert — each domain has its canonical entry, docs/-relative.
    expect(dp).toBeDefined();
    expect(dp.brief).toBe('product/brief.md');
    expect(dp.requirements).toBe('product/requirements.md');
    expect(dp.architecture).toBe('architecture/overview.md');
    expect(dp.design).toBe('design/spec.md');
    expect(dp.backlog).toBe('work/backlog.md');
    expect(dp.timeline).toBe('work/timeline.md');
    expect(dp.modules).toBe('modules');
    // No value carries a leading docs/ — callers compose with docsDir.
    for (const v of Object.values(dp)) {
      expect(v.startsWith('docs/')).toBe(false);
      expect(v.startsWith('/')).toBe(false);
    }
  });

  it('docChain_referencesDomainPaths_notLegacyProjectNames', () => {
    // The chain now flows through domain paths; the legacy flat `_project-*`
    // names must be gone from feeds (brainstorm/research keys are exempt — they
    // are ideation inputs not yet assigned a domain).
    const dc = constants.DOC_CHAIN;
    const allFeeds = Object.values(dc).flatMap((e) => e.feeds);
    for (const f of allFeeds) {
      expect(f).not.toMatch(/_project-/);
    }
    expect(dc['product/requirements.md'].feeds).toContain('work/backlog.md');
  });
});
