// AC→source map (Task #12 / daily-log-parser):
//   - parseDailyFile returns {date, time, heading, rawText} — superset of both
//     compiler's and extractor's prior shapes
//   - Split regex: lookahead for `## HH:MM — ` — keeps heading as part of chunk
//   - extractKeywords filters length > 2, lowercases, extracts from:
//     Branch, Source, Recent Commits, In-Progress Work, Key Decisions

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { parseDailyFile, extractKeywords } = require('../../../../.agents/core/_lib/daily-log-parser');

// ─── parseDailyFile ──────────────────────────────────────────────────────────

describe('parseDailyFile', () => {

  it('parseDailyFile_emptyContent_returnsEmptyArray', () => {
    expect(parseDailyFile('', '2026-04-24')).toEqual([]);
  });

  it('parseDailyFile_noHeadings_returnsEmptyArray', () => {
    expect(parseDailyFile('# not a compaction heading\nsome text', '2026-04-24')).toEqual([]);
  });

  it('parseDailyFile_singleEntry_returnsOneEntryWithAllFields', () => {
    const content = '## 14:30 — Pre-Compaction\n\nSome body text.';
    const result = parseDailyFile(content, '2026-04-24');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      date: '2026-04-24',
      time: '14:30',
      heading: '## 14:30 — Pre-Compaction',
    });
    expect(result[0].rawText).toContain('Some body text.');
  });

  it('parseDailyFile_multipleEntries_splitsOnHeadings', () => {
    const content = [
      '## 09:00 — Morning',
      'morning body',
      '',
      '## 15:30 — Afternoon [extracted]',
      'afternoon body',
    ].join('\n');
    const result = parseDailyFile(content, '2026-04-22');
    expect(result).toHaveLength(2);
    expect(result[0].time).toBe('09:00');
    expect(result[0].heading).toBe('## 09:00 — Morning');
    expect(result[1].time).toBe('15:30');
    expect(result[1].heading).toBe('## 15:30 — Afternoon [extracted]');
  });

  it('parseDailyFile_extractedMarker_preservedInHeading', () => {
    // extractor uses `[extracted]` markers in the heading — must be preserved
    const content = '## 10:00 — Pre-Compaction [extracted]\nbody';
    const [entry] = parseDailyFile(content, '2026-04-22');
    expect(entry.heading).toContain('[extracted]');
  });

  it('parseDailyFile_headingWithoutEmDash_skipped', () => {
    // The regex requires `## HH:MM — ` — a heading without the em-dash is NOT
    // a compaction entry and should not be split on
    const content = '## 10:00 Not a compaction heading\nbody';
    expect(parseDailyFile(content, '2026-04-22')).toEqual([]);
  });

});

// ─── extractKeywords ─────────────────────────────────────────────────────────

describe('extractKeywords', () => {

  it('extractKeywords_branchName_tokensAdded', () => {
    const entry = { rawText: '**Branch:** feat/auth-middleware\n' };
    const kw = extractKeywords(entry);
    expect(kw.has('feat')).toBe(true);
    expect(kw.has('auth')).toBe(true);
    expect(kw.has('middleware')).toBe(true);
  });

  it('extractKeywords_ingestedBranch_skipped', () => {
    // The literal branch "ingested" is a sentinel from legacy recaps — skip it
    const entry = { rawText: '**Branch:** ingested\n' };
    const kw = extractKeywords(entry);
    expect(kw.has('ingested')).toBe(false);
  });

  it('extractKeywords_commitSubjects_firstFourWordsOnly', () => {
    const entry = { rawText: [
      '### Recent Commits',
      '```',
      'abc1234 feat: add authentication middleware for admin routes',
      '```',
    ].join('\n') };
    const kw = extractKeywords(entry);
    // Expected: first 4 meaningful words after skipping hash + "feat:"
    // "add authentication middleware for" — 4 words (skipping hash "abc1234" + "feat:")
    expect(kw.has('add')).toBe(true);
    expect(kw.has('authentication')).toBe(true);
    expect(kw.has('middleware')).toBe(true);
    // 4th word — "for" is only 3 chars, filter rejects it (length > 2 means 3+ chars, so "for" IS kept)
    // "for" length is 3 — passes filter
    expect(kw.has('for')).toBe(true);
    // 5th word "admin" should NOT be present (take 4 only)
    expect(kw.has('admin')).toBe(false);
  });

  it('extractKeywords_inProgressStory_storyNameTokensAdded', () => {
    const entry = { rawText: [
      '### In-Progress Work',
      '- [>] Story 3.2: OAuth integration',
    ].join('\n') };
    const kw = extractKeywords(entry);
    expect(kw.has('story')).toBe(true);
    expect(kw.has('oauth')).toBe(true);
    expect(kw.has('integration')).toBe(true);
  });

  it('extractKeywords_decisionTable_cellsTokenized', () => {
    const entry = { rawText: [
      '### Key Decisions',
      '| Decision | Rationale | Outcome |',
      '|---|---|---|',
      '| use JWT tokens | stateless auth | approved |',
    ].join('\n') };
    const kw = extractKeywords(entry);
    expect(kw.has('jwt')).toBe(true);
    expect(kw.has('tokens')).toBe(true);
    expect(kw.has('stateless')).toBe(true);
    expect(kw.has('auth')).toBe(true);
  });

  it('extractKeywords_shortWords_filtered', () => {
    // Only tokens with length > 2 are kept
    const entry = { rawText: '**Branch:** a-b-c\n' };
    const kw = extractKeywords(entry);
    expect(kw.has('a')).toBe(false);
    expect(kw.has('b')).toBe(false);
    expect(kw.has('c')).toBe(false);
  });

  it('extractKeywords_emptyRawText_returnsEmptySet', () => {
    expect(extractKeywords({ rawText: '' }).size).toBe(0);
  });

  it('extractKeywords_undefinedRawText_returnsEmptySet', () => {
    // Defensive: the fn coerces missing rawText to '' and doesn't throw
    expect(() => extractKeywords({})).not.toThrow();
    expect(extractKeywords({}).size).toBe(0);
  });

});
