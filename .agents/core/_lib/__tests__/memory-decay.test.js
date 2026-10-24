// AC→source map (Task #19 / memory-decay):
//   Two exports from _lib/memory-decay.js:
//     - calculateDecayedConfidence({ confidence, category, usageCount, updated, activeDays })
//         → pure fn, decay formula. Uses activeDays for Math.pow(rate, N); calendar days
//           for RECENT_UPDATE_BOOST check. Cap at 1.0.
//     - createActiveDaysResolver({ projectRoot })
//         → returns { getActiveDaysSince(sinceDate): number } with lazy git-log cache
//           + calendar-day fallback when git is unavailable.
//   Formula preserved from memory-manager.js:417-427 exactly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const { calculateDecayedConfidence, createActiveDaysResolver, halveUsageCount } = require('../../../../.agents/core/_lib/memory-decay');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('../../__tests__/_helpers/git-fixture');

// Constants mirror MEMORY_DECAY in constants.js — kept inline here so the test
// fails loudly if someone changes the shared constants without updating tests.
const RATES = {
  decisions: 0.98,
  constraints: 0.97,
  patterns: 0.95,
  workflows: 0.93,
  'rejected-approaches': 0.90,
};
const DEFAULT_RATE = 0.95;
const USAGE_BOOST = 0.01;
const RECENT_UPDATE_BOOST = 0.1;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ─── calculateDecayedConfidence ──────────────────────────────────────────────

describe('calculateDecayedConfidence', () => {

  it('calculateDecayedConfidence_today_activeDaysZero_returnsConfidencePlusBoosts', () => {
    // Arrange — activeDays=0 means no decay from the power; recent update adds 0.1;
    // 2 uses × 0.01 = 0.02 usage boost
    const result = calculateDecayedConfidence({
      confidence: 0.7,
      category: 'patterns',
      usageCount: 2,
      updated: new Date().toISOString(),
      activeDays: 0,
    });

    // Assert — 0.7 + 0.02 + 0.1 = 0.82
    expect(result).toBeCloseTo(0.82, 2);
  });

  it('calculateDecayedConfidence_30ActiveDaysDecisions_appliesRate', () => {
    // Arrange — rate 0.98 for decisions, 30 active days, no recent boost (30 cal days > 7)
    const result = calculateDecayedConfidence({
      confidence: 1.0,
      category: 'decisions',
      usageCount: 0,
      updated: isoDaysAgo(30),
      activeDays: 30,
    });

    // Assert — 1.0 * 0.98^30 = ~0.545, no boosts
    expect(result).toBeCloseTo(Math.pow(0.98, 30), 3);
  });

  it('calculateDecayedConfidence_cappedAtOne', () => {
    // Arrange — 0.95 + 0.01*20 + 0.1 = 1.25, must clamp to 1.0
    const result = calculateDecayedConfidence({
      confidence: 0.95,
      category: 'decisions',
      usageCount: 20,
      updated: new Date().toISOString(),
      activeDays: 0,
    });

    // Assert
    expect(result).toBe(1.0);
  });

  it('calculateDecayedConfidence_unknownCategory_usesDefaultRate', () => {
    // Arrange — category not in RATES → DEFAULT_RATE = 0.95
    const result = calculateDecayedConfidence({
      confidence: 1.0,
      category: 'foobar-not-a-category',
      usageCount: 0,
      updated: new Date().toISOString(),
      activeDays: 5,
    });

    // Assert — 1.0 * 0.95^5 + 0.1 (recent) = ~0.8738
    const expected = 1.0 * Math.pow(DEFAULT_RATE, 5) + RECENT_UPDATE_BOOST;
    expect(result).toBeCloseTo(expected, 3);
  });

  it('calculateDecayedConfidence_recentBoost_usesCalendarDays_notActiveDays', () => {
    // This is the key semantic preserved from memory-manager:417-427 —
    // RECENT_UPDATE_BOOST keys off "updated in last 7 real-time days," NOT work days.
    // activeDays is 0 in both cases (simulating a dormant repo with no commits).

    // Case A: updated 3 calendar days ago → within 7-day window → boost applies
    const recent = calculateDecayedConfidence({
      confidence: 0.5,
      category: 'patterns',
      usageCount: 0,
      updated: isoDaysAgo(3),
      activeDays: 0,
    });
    expect(recent).toBeCloseTo(0.6, 3); // 0.5 * 1 + 0 + 0.1

    // Case B: updated 10 calendar days ago → past 7-day window → no boost
    const old = calculateDecayedConfidence({
      confidence: 0.5,
      category: 'patterns',
      usageCount: 0,
      updated: isoDaysAgo(10),
      activeDays: 0,
    });
    expect(old).toBeCloseTo(0.5, 3); // 0.5 * 1 + 0 + 0

    // The gap IS the boost — proves calendar-day semantics for the boost check
    expect(recent - old).toBeCloseTo(RECENT_UPDATE_BOOST, 3);
  });

  it('calculateDecayedConfidence_appliesUsageBoostLinearly', () => {
    // Arrange — verify USAGE_BOOST stacks per usage count (0.01 * n)
    const baseline = calculateDecayedConfidence({
      confidence: 0.5,
      category: 'patterns',
      usageCount: 0,
      updated: isoDaysAgo(30), // no recent boost
      activeDays: 0,
    });
    const with5Uses = calculateDecayedConfidence({
      confidence: 0.5,
      category: 'patterns',
      usageCount: 5,
      updated: isoDaysAgo(30),
      activeDays: 0,
    });

    // Assert — 5 * 0.01 = 0.05 gap
    expect(with5Uses - baseline).toBeCloseTo(5 * USAGE_BOOST, 3);
  });

});

// ─── createActiveDaysResolver ────────────────────────────────────────────────

describe('createActiveDaysResolver', () => {
  let tmp;

  beforeEach(() => {
    tmp = createTmpDir({ prefix: 'memory-decay-resolver-' });
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('createActiveDaysResolver_noGitRepo_fallsBackToCalendarDays', () => {
    // Arrange — tmp.root is NOT a git repo; git log will fail inside the resolver.
    // Resolver must fall back to calendar-day calculation.
    const resolver = createActiveDaysResolver({ projectRoot: tmp.root });

    // Act — ask for days since a date 7 calendar days ago
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = resolver.getActiveDaysSince(sevenDaysAgo);

    // Assert — calendar days fallback returns ~7.0 (tolerance: test runtime)
    expect(result).toBeGreaterThan(6.9);
    expect(result).toBeLessThan(7.1);
  });

  it.skipIf(!gitAvailable())(
    'createActiveDaysResolver_gitAvailable_countsCommitDatesAfterSince',
    () => {
      // Arrange — create git repo with 3 commits on 3 distinct dates
      const repo = createGitRepo({ root: tmp.root });
      repo.addCommitOnDate('day 1', '2024-01-01T12:00:00');
      repo.addCommitOnDate('day 2', '2024-01-05T12:00:00');
      repo.addCommitOnDate('day 3', '2024-01-10T12:00:00');

      const resolver = createActiveDaysResolver({ projectRoot: tmp.root });

      // Act — sinceDate is before all commits → all 3 distinct commit-dates count
      // (plus "initial" commit which is on test-run date — that's a 4th active day)
      const result = resolver.getActiveDaysSince('2023-12-01T00:00:00Z');

      // Assert — 3 controlled commits + 1 initial today = 4. Allow +/-1 tolerance
      // for date-boundary edge cases in createGitRepo's "initial" empty commit.
      expect(result).toBeGreaterThanOrEqual(3);
      expect(result).toBeLessThanOrEqual(5);
    }
  );

  it.skipIf(!gitAvailable())(
    'createActiveDaysResolver_gitAvailable_cachesGitLogAcrossCalls',
    () => {
      // Arrange — verify resolver caches the git log (one subprocess call, not N)
      // by measuring that a second call is effectively instant relative to the first.
      // We can't easily spy on execSync from another module without CJS-cache trick,
      // so use timing as a proxy: second call should be ≪ first call.
      const repo = createGitRepo({ root: tmp.root });
      for (let i = 1; i <= 5; i++) {
        repo.addCommitOnDate(`commit ${i}`, `2024-01-${String(i).padStart(2, '0')}T12:00:00`);
      }

      const resolver = createActiveDaysResolver({ projectRoot: tmp.root });

      // Act — first call populates the cache (git log subprocess)
      const t1 = process.hrtime.bigint();
      resolver.getActiveDaysSince('2023-12-01T00:00:00Z');
      const firstDuration = process.hrtime.bigint() - t1;

      // Second call should hit the cache (no subprocess)
      const t2 = process.hrtime.bigint();
      resolver.getActiveDaysSince('2023-12-01T00:00:00Z');
      const secondDuration = process.hrtime.bigint() - t2;

      // Assert — second call is at least 5x faster. Subprocess spawn is ~50-200ms,
      // cache hit is sub-millisecond. Generous 5x to avoid CI flake.
      expect(Number(secondDuration)).toBeLessThan(Number(firstDuration) / 5);
    }
  );

  it.skipIf(!gitAvailable())(
    'createActiveDaysResolver_gitAvailable_onlyCountsCommitsAfterSinceDate',
    () => {
      // Arrange — create repo with commits spanning several months
      const repo = createGitRepo({ root: tmp.root });
      repo.addCommitOnDate('jan', '2024-01-15T12:00:00');
      repo.addCommitOnDate('feb', '2024-02-15T12:00:00');
      repo.addCommitOnDate('mar', '2024-03-15T12:00:00');

      const resolver = createActiveDaysResolver({ projectRoot: tmp.root });

      // Act — sinceDate = 2024-03-01, only "mar" commit is after that
      // (plus "initial" empty commit which is on test-run date — will also be after 2024-03-01
      // IF the test runs after March 2024, which it does since we're in 2026)
      const result = resolver.getActiveDaysSince('2024-03-01T00:00:00Z');

      // Assert — only mar + initial-today count. Initial is on test-run date (~2026).
      // So expected = 2 (mar + initial). Allow 1-3 range.
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(3);
    }
  );

  // ── halveUsageCount (ME-4.1) ───────────────────────────────────────────────
  describe('halveUsageCount', () => {
    it('halves once per full halving period of silent active days', () => {
      expect(halveUsageCount(8, 14, 14)).toBe(4);   // exactly one halving
      expect(halveUsageCount(8, 28, 14)).toBe(2);   // two halvings
      expect(halveUsageCount(8, 42, 14)).toBe(1);   // three halvings
    });

    it('does not reduce before a full period has elapsed', () => {
      expect(halveUsageCount(8, 0, 14)).toBe(8);
      expect(halveUsageCount(8, 13, 14)).toBe(8);   // <1 period → unchanged (floor)
    });

    it('returns 0 for a zero/invalid counter and is safe on bad inputs', () => {
      expect(halveUsageCount(0, 100, 14)).toBe(0);
      expect(halveUsageCount(-5, 100, 14)).toBe(0);
      expect(halveUsageCount(NaN, 100, 14)).toBe(0);
    });

    it('disabled (halveEveryDays <= 0) leaves the counter unchanged', () => {
      expect(halveUsageCount(8, 100, 0)).toBe(8);
    });
  });

});
