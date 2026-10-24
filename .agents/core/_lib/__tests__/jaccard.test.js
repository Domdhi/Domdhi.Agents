// AC→source map (Task #13 / jaccard):
//   Two exports from _lib/jaccard.js:
//     - jaccardFromSets(setA, setB)  — pure Set-based kernel
//     - jaccardFromText(a, b, opts)  — tokenizes text, delegates to jaccardFromSets
//   Semantics preserved from the 3 extracted sites:
//     empty-empty → 0, identical → 1, disjoint → 0, symmetric.
//     Text version uses `w.length > minTokenLen` (default 2 = keep 3+ char tokens).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { jaccardFromSets, jaccardFromText } = require('../../../../.agents/core/_lib/jaccard');

// ─── jaccardFromSets ─────────────────────────────────────────────────────────

describe('jaccardFromSets', () => {

  it('jaccardFromSets_identical_returnsOne', () => {
    const a = new Set(['x', 'y', 'z']);
    const b = new Set(['x', 'y', 'z']);
    expect(jaccardFromSets(a, b)).toBe(1);
  });

  it('jaccardFromSets_disjoint_returnsZero', () => {
    const a = new Set(['x', 'y']);
    const b = new Set(['p', 'q']);
    expect(jaccardFromSets(a, b)).toBe(0);
  });

  it('jaccardFromSets_partialOverlap_returnsFraction', () => {
    // |A ∩ B| = 1 (only 'y'); |A ∪ B| = 3 ('x','y','z') → 1/3
    const a = new Set(['x', 'y']);
    const b = new Set(['y', 'z']);
    expect(jaccardFromSets(a, b)).toBeCloseTo(1 / 3, 5);
  });

  it('jaccardFromSets_bothEmpty_returnsZero', () => {
    // Convention from original sources — empty/empty is 0 (not NaN, not 1)
    expect(jaccardFromSets(new Set(), new Set())).toBe(0);
  });

  it('jaccardFromSets_oneEmpty_returnsZero', () => {
    const a = new Set(['x', 'y']);
    const b = new Set();
    expect(jaccardFromSets(a, b)).toBe(0);
    expect(jaccardFromSets(b, a)).toBe(0);
  });

  it('jaccardFromSets_symmetric', () => {
    const a = new Set(['alpha', 'beta', 'gamma']);
    const b = new Set(['beta', 'delta']);
    expect(jaccardFromSets(a, b)).toBe(jaccardFromSets(b, a));
  });

});

// ─── jaccardFromText ─────────────────────────────────────────────────────────

describe('jaccardFromText', () => {

  it('jaccardFromText_identicalStrings_returnsOne', () => {
    expect(jaccardFromText('alpha beta gamma', 'alpha beta gamma')).toBe(1);
  });

  it('jaccardFromText_caseInsensitive', () => {
    expect(jaccardFromText('Alpha Beta', 'alpha BETA')).toBe(1);
  });

  it('jaccardFromText_filtersTokensAtOrBelowMinLength', () => {
    // Default minTokenLen=2 → keep tokens with length > 2 (3+ chars).
    // "a x is" tokenizes to ['a', 'x', 'is'] — none survive filter → empty set.
    // Same on both sides → empty/empty → 0 per convention.
    expect(jaccardFromText('a x is', 'a x is')).toBe(0);
  });

  it('jaccardFromText_partialOverlap_returnsFraction', () => {
    // "auth middleware jwt" tokens (>2 chars): ['auth','middleware','jwt']
    // "jwt session cookie"  tokens:            ['jwt','session','cookie']
    // overlap: {'jwt'} = 1; union: 5; → 1/5
    expect(jaccardFromText('auth middleware jwt', 'jwt session cookie')).toBeCloseTo(1 / 5, 5);
  });

  it('jaccardFromText_nonWordSeparators_tokenizeOnAll', () => {
    // Hyphens, commas, punctuation all split — should all be word boundaries
    const a = 'error-handling, retry.logic';
    const b = 'retry logic error handling';
    // a tokens: ['error','handling','retry','logic']
    // b tokens: ['retry','logic','error','handling']
    // Identical sets → 1
    expect(jaccardFromText(a, b)).toBe(1);
  });

  it('jaccardFromText_customMinTokenLen_respected', () => {
    // minTokenLen=0 → keep tokens with length > 0 (all non-empty tokens)
    // "a b c" vs "a b d" → intersection {'a','b'}, union {'a','b','c','d'} → 2/4 = 0.5
    expect(jaccardFromText('a b c', 'a b d', { minTokenLen: 0 })).toBe(0.5);
  });

  it('jaccardFromText_coerceNonStringsToString', () => {
    // Callers occasionally pass JSON.stringify output — verify the fn doesn't
    // break on numeric or other non-string inputs
    expect(() => jaccardFromText(123, 456)).not.toThrow();
  });

});
