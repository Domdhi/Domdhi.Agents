// AC→source map (TDD-3.2):
//   - deleteMemory() unlinks JSON + deindexes; returns {deleted,error?} (no throw)
//   - MEMORY_DECAY.RATES[category] (nested), not MEMORY_DECAY[category]
//   - Decay formula: base*rate^activeDays + usage*USAGE_BOOST + (recent?RECENT_UPDATE_BOOST:0), cap 1.0
//   - lintMemories deductions: error=3, warning=2, info=1 (not 10)
//   - pruneStaleMemories deletes files (no archive tier)
//   - Category limit → createMemory returns null at 51st

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const MemoryManager = require('../memory-manager');
const CONSTANTS = require('../constants');
// Constant-relative so a change to the cap OR the near-limit fraction doesn't re-break these tests.
const CAP = CONSTANTS.MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY;
const NEAR_PCT = CONSTANTS.MEMORY_FILTERS.MEMORY_NEAR_LIMIT_PCT;
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo } = require('./_helpers/git-fixture');

// Probe FTS5 support directly — mirrors memory-manager.js's own probe (and
// memory-backend-detect.test.js). A version-number gate here once read `>= 25`
// and silently skipped these tests on Node 24, which ships FTS5 natively.
const hasSqlite = (() => {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE _probe USING fts5(x)');
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
})();

// ─── Per-test sandbox ────────────────────────────────────────────────────────

let tmp;
let originalEnv;
// Track all MemoryManager instances created per test so we can close their
// SQLite db before tmp.cleanup() — otherwise Windows EPERM on locked .db file.
let managersThisTest = [];

function makeManager() {
  const m = new MemoryManager();
  managersThisTest.push(m);
  return m;
}

function closeManagers() {
  for (const m of managersThisTest) {
    if (m.db) {
      try { m.db.close(); } catch { /* non-fatal */ }
      m.db = null;
    }
  }
  managersThisTest = [];
}

beforeEach(() => {
  managersThisTest = [];
  tmp = createTmpDir();
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
  closeManagers();
  if (originalEnv === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = originalEnv;
  }
  tmp.cleanup();
});

// ─── describe('memory-manager') ──────────────────────────────────────────────

describe('memory-manager', () => {

  // ── CRUD ───────────────────────────────────────────────────────────────────

  describe('CRUD', () => {

    it('C5_constructor_emptyDir_selfHealsAllCategoryDirs', () => {
      // C5: a brownfield onboard never writes a memory, so the store used to stay
      // unseeded and read-only tools ran against missing dirs. Construction alone
      // must now self-heal the 5 category dirs (no SQLite required).
      const manager = makeManager();
      const memDir = path.join(tmp.root, 'docs', '.output', '.memory');
      for (const category of manager.categories) {
        expect(fs.existsSync(path.join(memDir, category))).toBe(true);
      }
      expect(manager.categories.length).toBe(5);
    });

    it('createMemory_writesJsonFile_atCategoryPath', async () => {
      // Arrange
      const manager = makeManager();

      // Act
      const result = await manager.createMemory('patterns', 'test_pattern_one', { description: 'hello' });

      // Assert — returned object
      expect(result).not.toBeNull();
      expect(result.id).toBe('test_pattern_one');
      expect(result.type).toBe('pattern');
      expect(result.category).toBe('patterns');
      expect(result.usage_count).toBe(0);
      expect(result.content.description).toBe('hello');
      expect(result.metadata.confidence).toBe(1.0);
      expect(new Date(result.created).getTime()).not.toBeNaN();
      expect(new Date(result.updated).getTime()).not.toBeNaN();

      // Assert — file on disk (underscores → hyphens)
      const filePath = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'test-pattern-one.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(parsed.id).toBe('test_pattern_one');
      expect(parsed.content.description).toBe('hello');
    });

    it('createMemory_invalidCategory_throws', async () => {
      // Arrange
      const manager = makeManager();

      // Act / Assert
      await expect(manager.createMemory('bogus', 'x', {})).rejects.toThrow(/Invalid category/);
    });

    it('readMemory_existingId_roundTripsContent', async () => {
      // Arrange
      const manager = makeManager();
      await manager.createMemory('patterns', 'round_trip', { value: 42 });

      // Act
      const read = await manager.readMemory('patterns', 'round_trip');

      // Assert
      expect(read).not.toBeNull();
      expect(read.content.value).toBe(42);
    });

    it('readMemory_missingId_returnsNull', async () => {
      // Arrange
      const manager = makeManager();

      // Act
      const result = await manager.readMemory('patterns', 'nonexistent');

      // Assert
      expect(result).toBeNull();
    });

    it('readMemory_underscoreId_findsHyphenatedFile', async () => {
      // Arrange
      const manager = makeManager();
      await manager.createMemory('patterns', 'under_score_id', { tag: 'test' });

      // Act — read with same underscore id
      const result = await manager.readMemory('patterns', 'under_score_id');

      // Assert
      expect(result).not.toBeNull();
      expect(result.id).toBe('under_score_id');
    });

    it('updateMemory_mergesContent_doesNotIncrementUsageCount', async () => {
      // ME-4.1: a write (content/metadata patch) is NOT a genuine recall, so
      // updateMemory no longer bumps usage_count — the honest increment moved to
      // searchMemories(). It still merges content and refreshes `updated`.
      const manager = makeManager();
      const created = await manager.createMemory('patterns', 'update_me', { a: 1 });
      const originalUpdated = created.updated;

      // Ensure a small time gap so updated timestamp differs
      await new Promise(r => setTimeout(r, 10));

      // Act
      const updated = await manager.updateMemory('patterns', 'update_me', { content: { b: 2 } });

      // Assert
      expect(updated).not.toBeNull();
      expect(updated.content.a).toBe(1);
      expect(updated.content.b).toBe(2);
      expect(updated.usage_count).toBe(0); // unchanged — update is not a recall
      expect(updated.updated).not.toBe(originalUpdated);
    });

    it('updateMemory_setsLastAccessedTimestamp', async () => {
      // Arrange — MP-2.1: updateMemory stamps last_accessed for hit-rate attribution
      const manager = makeManager();
      await manager.createMemory('patterns', 'access_me', { a: 1 });

      // Act
      const updated = await manager.updateMemory('patterns', 'access_me', { content: { b: 2 } });

      // Assert — last_accessed is set, equals the update timestamp, and is ISO-8601
      expect(updated.last_accessed).toBe(updated.updated);
      expect(typeof updated.last_accessed).toBe('string');
      expect(updated.last_accessed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('updateMemory_missingMemory_returnsNull', async () => {
      // Arrange
      const manager = makeManager();

      // Act
      const result = await manager.updateMemory('patterns', 'does_not_exist', { content: { x: 1 } });

      // Assert
      expect(result).toBeNull();
    });

    it('deleteMemory_existing_removesFileAndReturnsDeleted', async () => {
      // Arrange
      const manager = makeManager();
      await manager.createMemory('patterns', 'delete_me', { description: 'temp' });
      const filePath = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'delete-me.json');
      expect(fs.existsSync(filePath)).toBe(true);

      // Act
      const result = await manager.deleteMemory('patterns', 'delete_me');

      // Assert
      expect(result).toEqual({ deleted: true });
      expect(fs.existsSync(filePath)).toBe(false);
      expect(await manager.readMemory('patterns', 'delete_me')).toBeNull();
    });

    it('deleteMemory_missing_returnsErrorNotThrow', async () => {
      const manager = makeManager();
      const result = await manager.deleteMemory('patterns', 'never_existed');
      expect(result.deleted).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it('deleteMemory_invalidCategory_returnsError', async () => {
      const manager = makeManager();
      const result = await manager.deleteMemory('bogus', 'x');
      expect(result.deleted).toBe(false);
      expect(result.error).toMatch(/Invalid category/);
    });

    it('listMemories_populatedCategory_returnsSummaries', async () => {
      // Arrange
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem_a', { x: 1 });
      await manager.createMemory('patterns', 'mem_b', { x: 2 });
      await manager.createMemory('patterns', 'mem_c', { x: 3 });

      // Act
      const list = await manager.listMemories('patterns');

      // Assert
      expect(list.length).toBe(3);
      for (const summary of list) {
        expect(summary).toHaveProperty('id');
        expect(summary).toHaveProperty('created');
        expect(summary).toHaveProperty('updated');
        expect(summary).toHaveProperty('usage_count');
        expect(summary).toHaveProperty('confidence');
        expect(summary).toHaveProperty('decayed_confidence');
      }
    });

    it('listMemories_emptyCategory_returnsEmptyArray', async () => {
      // Arrange
      const manager = makeManager();

      // Act
      const list = await manager.listMemories('patterns');

      // Assert
      expect(list).toEqual([]);
    });

  }); // CRUD

  // ── Inbox staging ───────────────────────────────────────────────────────────

  describe('inbox', () => {
    /** Write a draft JSON into the inbox dir the way a sub-agent would (Write tool). */
    function writeDraft(manager, id, draft) {
      const dir = manager._inboxDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(draft));
    }

    it('inboxList_empty_returnsEmptyArray', async () => {
      const manager = makeManager();
      expect(await manager.inboxList()).toEqual([]);
    });

    it('inboxList_returnsDraftsChronologically', async () => {
      const manager = makeManager();
      writeDraft(manager, '2026-06-02-1200-beta', { category: 'patterns', suggested_id: 'beta', content: { description: 'B' } });
      writeDraft(manager, '2026-06-02-0900-alpha', { category: 'constraints', suggested_id: 'alpha', content: { description: 'A' } });

      const list = await manager.inboxList();
      expect(list.map(e => e.id)).toEqual(['2026-06-02-0900-alpha', '2026-06-02-1200-beta']);
      expect(list[0]).toMatchObject({ category: 'constraints', suggested_id: 'alpha', content_preview: 'A' });
    });

    it('inboxPromote_validDraft_createsMemoryAndRemovesDraft', async () => {
      const manager = makeManager();
      writeDraft(manager, '2026-06-02-1000-gotcha', {
        category: 'constraints',
        suggested_id: 'windows-cr-strip',
        content: { description: 'CRLF gotcha', confidence: 0.7 },
      });

      const result = await manager.inboxPromote('2026-06-02-1000-gotcha');
      expect(result).toEqual({ promoted: true, category: 'constraints', id: 'windows-cr-strip' });
      // Real memory now exists; draft is gone.
      expect(await manager.readMemory('constraints', 'windows-cr-strip')).not.toBeNull();
      expect(await manager.inboxList()).toEqual([]);
    });

    it('inboxPromote_categoryOverride_respected', async () => {
      const manager = makeManager();
      writeDraft(manager, 'd1', { category: 'patterns', suggested_id: 'thing', content: { description: 'x' } });
      const result = await manager.inboxPromote('d1', { categoryOverride: 'decisions', idOverride: 'thing-renamed' });
      expect(result).toMatchObject({ promoted: true, category: 'decisions', id: 'thing-renamed' });
      expect(await manager.readMemory('decisions', 'thing-renamed')).not.toBeNull();
    });

    it('inboxPromote_missingDraft_returnsErrorNotThrow', async () => {
      const manager = makeManager();
      const result = await manager.inboxPromote('nope');
      expect(result.promoted).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });

    it('inboxPromote_invalidCategory_returnsError', async () => {
      const manager = makeManager();
      writeDraft(manager, 'd2', { category: 'bogus', suggested_id: 'x', content: {} });
      const result = await manager.inboxPromote('d2');
      expect(result.promoted).toBe(false);
      expect(result.error).toMatch(/Invalid category/);
    });

    it('inboxDiscard_removesDraftWithoutPromoting', async () => {
      const manager = makeManager();
      writeDraft(manager, 'd3', { category: 'patterns', suggested_id: 'junk', content: {} });
      const result = await manager.inboxDiscard('d3');
      expect(result).toEqual({ discarded: true });
      expect(await manager.inboxList()).toEqual([]);
      expect(await manager.readMemory('patterns', 'junk')).toBeNull();
    });

    it('inboxDiscard_missing_returnsError', async () => {
      const manager = makeManager();
      const result = await manager.inboxDiscard('nope');
      expect(result.discarded).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  }); // inbox

  // ── searchMemories ─────────────────────────────────────────────────────────

  describe('searchMemories', () => {

    it.skipIf(!hasSqlite)('searchMemories_sqlitePath_findsByTerm', async () => {
      // Arrange
      const manager = makeManager();
      await manager.createMemory('patterns', 'zebra_mem', { description: 'uniquezebra' });

      // Act
      const results = await manager.searchMemories('uniquezebra');

      // Assert
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].category).toBe('patterns');
    });

    it('searchMemories_jsonFallback_matchesSubstring', async () => {
      // Arrange
      const manager = makeManager();
      await manager.createMemory('patterns', 'fallback_mem', { description: 'uniquepineapple42' });
      // Force JSON fallback by overriding initDb so it always returns false
      manager.initDb = () => false;

      // Act
      const results = await manager.searchMemories('uniquepineapple42');

      // Assert
      expect(results.length).toBeGreaterThanOrEqual(1);
      const r = results[0];
      expect(r).toHaveProperty('category');
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('relevance');
      expect(r).toHaveProperty('confidence');
      expect(r).toHaveProperty('decayed_confidence');
    });

    it('searchMemories_logsMemoryAccessEvent', async () => {
      // Arrange — MP-2.1: a recall (search) emits a memory_access telemetry event
      // (the numerator for hit-rate). Force JSON fallback for determinism.
      const manager = makeManager();
      manager.initDb = () => false;
      await manager.createMemory('patterns', 'access_log_mem', { description: 'uniquemango99' });

      // Act
      const results = await manager.searchMemories('uniquemango99');

      // Assert — the returned ids are logged as one memory_access event
      expect(results.length).toBeGreaterThanOrEqual(1);
      const logPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'memory-injection.jsonl');
      expect(fs.existsSync(logPath)).toBe(true);
      const accessEvents = fs.readFileSync(logPath, 'utf8')
        .split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
        .filter(e => e.type === 'memory_access');
      expect(accessEvents.length).toBeGreaterThanOrEqual(1);
      const last = accessEvents[accessEvents.length - 1];
      expect(last.accessed_ids).toEqual(results.map(r => r.id));
      expect(last.session_proxy).toBe(last.timestamp.slice(0, 16));
    });

  }); // searchMemories

  // ── buildFtsQuery ──────────────────────────────────────────────────────────

  describe('buildFtsQuery', () => {
    const { buildFtsQuery } = MemoryManager;

    it('buildFtsQuery_singleWord_passesThrough', () => {
      expect(buildFtsQuery('publish')).toBe('publish');
    });

    it('buildFtsQuery_multipleWords_orJoins', () => {
      expect(buildFtsQuery('publish tooling refactor')).toBe('publish OR tooling OR refactor');
    });

    it('buildFtsQuery_dropsShortTokens', () => {
      // "to", "a" filtered (length <= 1 not strictly — "to" is len 2, "a" is len 1)
      expect(buildFtsQuery('a tooling x refactor')).toBe('tooling OR refactor');
    });

    it('buildFtsQuery_explicitOR_passesThrough', () => {
      expect(buildFtsQuery('foo OR bar')).toBe('foo OR bar');
    });

    it('buildFtsQuery_quotedPhrase_passesThrough', () => {
      expect(buildFtsQuery('"key files"')).toBe('"key files"');
    });

    it('buildFtsQuery_specialChars_strippedFromTokens', () => {
      // path-like input becomes OR-joined word tokens
      expect(buildFtsQuery('publish tooling tools/ refactor PATH_REMAPS'))
        .toBe('publish OR tooling OR tools OR refactor OR PATH_REMAPS');
    });

    it('buildFtsQuery_emptyOrNull_returnsAsIs', () => {
      expect(buildFtsQuery('')).toBe('');
      expect(buildFtsQuery(null)).toBe(null);
    });

    it('buildFtsQuery_hyphenatedMultiWord_splitsToOr', () => {
      // Regression: "-" is an FTS5 operator. Pre-fix, "walk-forward folds" became
      // "walk-forward OR folds" → MATCH threw "no such column: forward" → fell to
      // the JSON substring scan → []. Hyphens must split like any separator.
      expect(buildFtsQuery('walk-forward folds')).toBe('walk OR forward OR folds');
      expect(buildFtsQuery('cache-anchored replay')).toBe('cache OR anchored OR replay');
    });

    it('buildFtsQuery_loneHyphenatedToken_splitsToOr', () => {
      // A single kebab term must not pass through verbatim (it would hit the
      // operator-hyphen and throw). It splits into OR-joined parts.
      expect(buildFtsQuery('look-ahead')).toBe('look OR ahead');
      expect(buildFtsQuery('rejected-approaches')).toBe('rejected OR approaches');
    });

    it('buildFtsQuery_degenerateHyphen_returnsHyphenFree', () => {
      // N1: "x-ray" — the 1-char "x" fails the min-length-2 filter, but silently
      // searching for just "ray" drops half the term. When 2+ raw tokens existed,
      // keep them all as a hyphen-free join instead of losing the dropped one.
      expect(buildFtsQuery('x-ray')).toBe('x ray');
      // "a-b": both parts dropped → 0 tokens → hyphen-stripped original, never raw.
      expect(buildFtsQuery('a-b')).toBe('a b');
    });

    it.skipIf(!hasSqlite)('buildFtsQuery_orDefaultRetrievesMultiWordHits', async () => {
      // End-to-end: a query whose terms span multiple memories should hit
      // BOTH (one per term). Pre-fix this returned [] under FTS5 AND-default
      // because no single memory contained every term.
      // Terms must be plain alphanumeric — FTS5's default unicode61 tokenizer
      // splits on hyphens, so hyphenated test strings are unreliable.
      const manager = makeManager();
      await manager.createMemory('patterns', 'memalpha', { description: 'xenonmarker word' });
      await manager.createMemory('patterns', 'membeta', { description: 'yttriummarker word' });

      const results = await manager.searchMemories('xenonmarker yttriummarker');

      // OR-join means BOTH memories should match, since each contains one term
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

  }); // buildFtsQuery

  // ── M1: prose queries (punctuation + hyphen) must not silently return [] ──────

  describe('M1 prose-query regression', () => {
    it.skipIf(!hasSqlite)('searchMemories_fullSentenceWithParensAndHyphen_findsRelevantMemory', async () => {
      // Reproduces the findings' end-to-end repro. buildFtsQuery passes a string
      // through raw when it carries FTS5-looking punctuation ("(" / ")"); ordinary
      // prose descriptions trip that, and a hyphenated word in the raw string then
      // makes FTS5 MATCH throw ("no such column: …"). Pre-fix, both the FTS path and
      // the whole-query JSON substring fallback failed together → [] for a query
      // against a directly relevant memory. The tokenized-OR retry must now find it.
      const manager = makeManager();
      await manager.createMemory('patterns', 'file-based-store-notes', {
        description: 'file-based memory store notes',
      });

      const results = await manager.searchMemories(
        'For our file-based memory store, usage_count is a broken eviction instrument (see notes).'
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.id === 'file-based-store-notes')).toBe(true);
    });

    it.skipIf(!hasSqlite)('detectOverlap_prosePunctuationHyphenDescription_flagsSupersedesCandidate', async () => {
      // detectOverlap runs buildFtsQuery(content.description) on EVERY createMemory —
      // exactly the punctuation+hyphen shape that tripped M1, silently no-op'ing
      // write-time supersession detection. A new memory whose prose description
      // overlaps an existing one must now surface it as a supersedes candidate.
      const manager = makeManager();
      await manager.createMemory('constraints', 'publish-script-path-old', {
        description: 'The publish workflow uses the tools/publish.js path.',
      });

      const created = await manager.createMemory('constraints', 'publish-script-path-new', {
        description: 'Publish workflow tooling lives at tools/publish.js (not the old .claude/core path).',
      });

      expect(created.supersedes_candidates).toBeDefined();
      expect(created.supersedes_candidates).toContain('publish-script-path-old');
    });
  }); // M1 prose-query regression

  // ── calculateDecayedConfidence ─────────────────────────────────────────────

  describe('calculateDecayedConfidence', () => {

    it('calculateDecayedConfidence_todayMemory_returnsCappedAt1', async () => {
      // Arrange
      const manager = makeManager();
      const memory = {
        category: 'decisions',
        updated: new Date().toISOString(),
        usage_count: 0,
        metadata: { confidence: 1.0 }
      };

      // Act
      const result = manager.calculateDecayedConfidence(memory);

      // Assert — fresh memory with no active days beyond now caps at 1.0
      expect(result).toBeLessThanOrEqual(1.0);
      expect(result).toBeGreaterThan(0.9);
    });

    it('calculateDecayedConfidence_30DaysOldDecisions_appliesRate', () => {
      // Arrange — git-fixture with 30 commits at tmp.root so it aligns with
      // CLAUDE_PROJECT_DIR (already set to tmp.root in beforeEach), and the
      // manager's internal `git log` execSync runs inside this fixture repo.
      const repo = createGitRepo({ root: tmp.root });
      for (let i = 1; i <= 30; i++) {
        const isoDate = new Date(2024, 0, i).toISOString();
        repo.addCommitOnDate(`commit day ${i}`, isoDate);
      }

      const manager = makeManager();
      // Controlled memory: updated at 2024-01-01, no usage, no recent boost (30 cal days)
      const memory = {
        category: 'decisions',
        updated: '2024-01-01T12:00:00.000Z',
        usage_count: 0,
        metadata: { confidence: 1.0 }
      };

      // Act
      const result = manager.calculateDecayedConfidence(memory);

      // Assert — formula: 1.0 * 0.98^activeDays; 30 work days → ≈ 0.545
      // We allow generous tolerance since activeDays includes the initial empty commit "today"
      const expected = Math.pow(0.98, 30);
      expect(Math.abs(result - expected)).toBeLessThan(0.05);
    });

  }); // calculateDecayedConfidence

  // ── getActiveDaysSince ─────────────────────────────────────────────────────

  describe('getActiveDaysSince', () => {

    it('getActiveDaysSince_gitFixture3Commits_returns3', () => {
      // Arrange — git repo at tmp.root aligns with CLAUDE_PROJECT_DIR.
      const repo = createGitRepo({ root: tmp.root });
      repo.addCommitOnDate('day 1', '2024-01-01T12:00:00');
      repo.addCommitOnDate('day 2', '2024-01-02T12:00:00');
      repo.addCommitOnDate('day 3', '2024-01-03T12:00:00');

      const manager = makeManager();

      // Act — query from earliest date; initial empty commit at "today" adds 1 more
      const count = manager.getActiveDaysSince('2024-01-01T00:00:00Z');

      // Assert — 3 fixture commits + possibly today's initial commit
      expect(count).toBeGreaterThanOrEqual(3);
      expect(count).toBeLessThanOrEqual(4);
    });

    it('getActiveDaysSince_calledTwice_returnsSameResult', () => {
      // Arrange — git repo at tmp.root aligns with CLAUDE_PROJECT_DIR.
      // Behavioral test: repeated calls must return the same count regardless
      // of whether the underlying cache is a Set, Map, or closure variable.
      // (Cache-identity assertions belong to _lib/__tests__/memory-decay.test.js;
      // here we just prove the public API is idempotent.)
      const repo = createGitRepo({ root: tmp.root });
      repo.addCommitOnDate('commit a', '2024-03-01T12:00:00');
      repo.addCommitOnDate('commit b', '2024-03-02T12:00:00');

      const manager = makeManager();

      // Act
      const first = manager.getActiveDaysSince('2024-03-01T00:00:00Z');
      const second = manager.getActiveDaysSince('2024-03-01T00:00:00Z');

      // Assert — consistent result across calls (proves caching works AND
      // that it returns a stable value for the same input)
      expect(first).toBe(second);
      expect(first).toBeGreaterThanOrEqual(2);
    });

    it('getActiveDaysSince_gitUnavailable_fallsBackToCalendar', () => {
      // Arrange — tmp.root (set as CLAUDE_PROJECT_DIR in beforeEach) is not a
      // git repo, so the resolver's `git log` execSync throws → permanent
      // calendar-day fallback for the lifetime of the manager instance.
      const manager = makeManager();
      const past = new Date(Date.now() - 7 * 86400000).toISOString();

      // Act
      const result = manager.getActiveDaysSince(past);

      // Assert — calendar fallback: ~7 days with ±0.1 tolerance
      expect(result).toBeGreaterThan(6.9);
      expect(result).toBeLessThan(7.1);
    });

  }); // getActiveDaysSince

  // ── lintMemories ───────────────────────────────────────────────────────────

  describe('lintMemories', () => {

    // Helper: write fixture JSON directly into the tmp memory tree
    function writeFixtureMemory(category, id, overrides = {}) {
      const base = {
        id,
        type: category.slice(0, -1),
        category,
        created: '2020-01-01T00:00:00.000Z',
        updated: '2020-01-01T00:00:00.000Z',
        usage_count: 0,
        content: { description: 'default' },
        metadata: { confidence: 1.0 }
      };
      if (overrides.content !== undefined) base.content = overrides.content;
      if (overrides.metadata !== undefined) base.metadata = { ...base.metadata, ...overrides.metadata };
      // Apply remaining scalar overrides
      for (const [k, v] of Object.entries(overrides)) {
        if (k !== 'content' && k !== 'metadata') base[k] = v;
      }
      const filename = id.replace(/_/g, '-');
      tmp.write(`docs/.output/.memory/${category}/${filename}.json`, JSON.stringify(base, null, 2));
      return base;
    }

    it('lintMemories_emptyRepo_returns70', async () => {
      // Arrange
      const manager = makeManager();

      // Act
      const result = await manager.lintMemories();

      // Assert
      expect(result.score).toBe(70);
      expect(result.total_memories).toBe(0);
      for (const check of Object.values(result.checks)) {
        expect(check.count).toBe(0);
      }
    });

    it('lintMemories_brokenRef_flagsError', async () => {
      // Arrange — memory references a non-existent id.
      // Give it a fresh updated date + usage_count > 0 so it does NOT trigger
      // orphaned, stale, or decay_validation checks. Only broken_refs fires.
      writeFixtureMemory('patterns', 'has_broken_ref', {
        updated: new Date().toISOString(),
        usage_count: 1,
        content: { note: 'related: ghost-concept' },
        metadata: { confidence: 1.0 }
      });
      const manager = makeManager();

      // Act
      const result = await manager.lintMemories();

      // Assert — broken_refs is an error (deduction 3), score = 70 - 3 = 67
      expect(result.checks.broken_refs.count).toBe(1);
      expect(result.score).toBe(67);
      const finding = result.checks.broken_refs.findings[0];
      // finding.memory is `${category}/${full.id}` — id preserves underscores as stored
      expect(finding.memory).toContain('has_broken_ref');
    });

    it('lintMemories_fileCitation_notFlaggedAsBrokenRef', async () => {
      // A prose source citation ("Ref: docs/.output/…") is a file path, not a
      // cross-reference — it must NOT be mis-read as a bare id "docs".
      writeFixtureMemory('patterns', 'cites_a_file', {
        updated: new Date().toISOString(),
        usage_count: 1,
        content: { note: 'Surfaced 2026-06-14. Ref: docs/.output/findings/research/260614-applied.md' },
        metadata: { confidence: 1.0 }
      });
      const manager = makeManager();

      const result = await manager.lintMemories();

      expect(result.checks.broken_refs.count).toBe(0);
    });

    it('lintMemories_sentenceFinalBrokenRef_stillFlagged', async () => {
      // Guard the file-citation fix against over-correction: a genuine broken ref
      // that ends a sentence ("see: ghost-concept.") must STILL be flagged — the
      // trailing period is punctuation, not a file extension.
      writeFixtureMemory('patterns', 'has_trailing_dot_ref', {
        updated: new Date().toISOString(),
        usage_count: 1,
        content: { note: 'As noted, see: ghost-concept.' },
        metadata: { confidence: 1.0 }
      });
      const manager = makeManager();

      const result = await manager.lintMemories();

      expect(result.checks.broken_refs.count).toBe(1);
      expect(result.checks.broken_refs.findings[0].referenced_id).toBe('ghost-concept');
    });

    it('lintMemories_orphanedMemory_flagsWarning', async () => {
      // Arrange — zero usage_count, updated far in the past (> 30 days)
      writeFixtureMemory('patterns', 'orphan_mem', {
        usage_count: 0,
        updated: '2020-01-01T00:00:00.000Z'
      });
      const manager = makeManager();

      // Act
      const result = await manager.lintMemories();

      // Assert
      expect(result.checks.orphaned.count).toBeGreaterThanOrEqual(1);
    });

    it('lintMemories_duplicateMemories_flagsWarning', async () => {
      // Arrange — two memories with identical content (Jaccard = 1.0)
      const content = { rule: 'always use the fast path when available in the system' };
      writeFixtureMemory('patterns', 'dup_alpha', { content });
      writeFixtureMemory('patterns', 'dup_beta', { content });
      const manager = makeManager();

      // Act
      const result = await manager.lintMemories();

      // Assert
      expect(result.checks.duplicates.count).toBeGreaterThanOrEqual(1);
    });

    it('lintMemories_contradictions_flagsWarning', async () => {
      // Arrange — two patterns with high overlap (shared filler) + conflicting signals
      const filler = 'cache system layer application request response service data store';
      writeFixtureMemory('patterns', 'contra_positive', {
        content: { rule: `always use cache here ${filler} always use cache here ${filler}` }
      });
      writeFixtureMemory('patterns', 'contra_negative', {
        content: { rule: `never use cache here ${filler} never use cache here ${filler}` }
      });
      const manager = makeManager();

      // Act
      const result = await manager.lintMemories();

      // Assert
      expect(result.checks.contradictions.count).toBeGreaterThanOrEqual(1);
    });

    it('lintMemories_staleMemory_flagsWarning', async () => {
      // Arrange — old updated date + low confidence → decayed well below 0.3
      writeFixtureMemory('patterns', 'stale_mem', {
        updated: '2020-01-01T00:00:00.000Z',
        metadata: { confidence: 0.2 }
      });
      const manager = makeManager();

      // Act
      const result = await manager.lintMemories();

      // Assert
      expect(result.checks.stale.count).toBeGreaterThanOrEqual(1);
    });

    it('lintMemories_decayValidation_flagsInfo', async () => {
      // Arrange — high raw confidence (≥ 0.7) but old enough to decay below 0.3.
      // Need activeDays > 23 for patterns (rate=0.95): 0.95^24 ≈ 0.29.
      // Use a git-fixture with 30 commits so getActiveDaysSince returns 30+ active days.
      // Git repo at tmp.root so the manager's git log sees these commits AND
      // writeFixtureMemory writes under the same project root the manager reads.
      const repo = createGitRepo({ root: tmp.root });
      for (let i = 1; i <= 30; i++) {
        repo.addCommitOnDate(`commit ${i}`, new Date(2020, 0, i).toISOString());
      }

      writeFixtureMemory('patterns', 'decay_val_mem', {
        updated: '2020-01-01T00:00:00.000Z',
        metadata: { confidence: 0.9 }
      });
      const manager = makeManager();

      // Act
      const result = await manager.lintMemories();

      // Assert — decay_validation is info (deduction 1)
      expect(result.checks.decay_validation.count).toBeGreaterThanOrEqual(1);
      expect(result.checks.decay_validation.severity).toBe('info');
    });

    it('lintMemories_categoryBalance_flagsAt80Percent', async () => {
      // Arrange — fill to exactly the near-limit threshold (matches memory-lint's Math.floor)
      const threshold = Math.floor(CAP * NEAR_PCT);
      for (let i = 0; i < threshold; i++) {
        writeFixtureMemory('patterns', `pat_${i}`, { content: { x: i } });
      }
      const manager = makeManager();

      // Act
      const result = await manager.lintMemories();

      // Assert
      expect(result.checks.category_balance.count).toBe(1);
      const finding = result.checks.category_balance.findings[0];
      expect(finding.count).toBe(threshold);
      expect(finding.threshold).toBe(threshold);
      expect(finding.limit).toBe(CAP);
    });

  }); // lintMemories

  // ── pruneStaleMemories ─────────────────────────────────────────────────────

  describe('pruneStaleMemories', () => {

    it('pruneStaleMemories_oldLowConfidence_deletes', async () => {
      // Arrange — git-fixture with 40 commits on 40 distinct dates (well past 30 active days)
      // Git repo at tmp.root so the manager's git log sees these commits AND
      // writeFixtureMemory writes under the same project root the manager reads.
      const repo = createGitRepo({ root: tmp.root });
      for (let i = 1; i <= 40; i++) {
        const isoDate = new Date(2020, 0, i).toISOString();
        repo.addCommitOnDate(`commit ${i}`, isoDate);
      }

      const manager = makeManager();
      // Write fixture memory directly (old date, low confidence)
      const memContent = {
        id: 'stale_target',
        type: 'pattern',
        category: 'patterns',
        created: '2020-01-01T00:00:00.000Z',
        updated: '2020-01-01T00:00:00.000Z',
        usage_count: 0,
        content: { description: 'old low conf' },
        metadata: { confidence: 0.05 }
      };
      const memDir = path.join(manager.memoriesDir, 'patterns');
      fs.mkdirSync(memDir, { recursive: true });
      const filePath = path.join(memDir, 'stale-target.json');
      fs.writeFileSync(filePath, JSON.stringify(memContent, null, 2));

      // Act
      const pruned = await manager.pruneStaleMemories('patterns');

      // Assert
      expect(pruned).toBe(1);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('pruneStaleMemories_freshLowConfidence_keeps', async () => {
      // Arrange — fresh updated date, so activeDays will be small (< 30)
      const manager = makeManager();
      const memContent = {
        id: 'fresh_low',
        type: 'pattern',
        category: 'patterns',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        usage_count: 0,
        content: { description: 'fresh but low' },
        metadata: { confidence: 0.05 }
      };
      const memDir = path.join(manager.memoriesDir, 'patterns');
      fs.mkdirSync(memDir, { recursive: true });
      const filePath = path.join(memDir, 'fresh-low.json');
      fs.writeFileSync(filePath, JSON.stringify(memContent, null, 2));

      // Act
      const pruned = await manager.pruneStaleMemories('patterns');

      // Assert — activeDays is tiny (near 0), not > 30
      expect(pruned).toBe(0);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('pruneStaleMemories_oldHighConfidence_keeps', async () => {
      // Arrange — old date but high confidence → confidence guard blocks deletion
      const manager = makeManager();
      const memContent = {
        id: 'old_high_conf',
        type: 'pattern',
        category: 'patterns',
        created: '2020-01-01T00:00:00.000Z',
        updated: '2020-01-01T00:00:00.000Z',
        usage_count: 0,
        content: { description: 'old but trusted' },
        metadata: { confidence: 0.9 }
      };
      const memDir = path.join(manager.memoriesDir, 'patterns');
      fs.mkdirSync(memDir, { recursive: true });
      const filePath = path.join(memDir, 'old-high-conf.json');
      fs.writeFileSync(filePath, JSON.stringify(memContent, null, 2));

      // Act
      const pruned = await manager.pruneStaleMemories('patterns');

      // Assert — confidence 0.9 >= 0.3 threshold, not pruned
      expect(pruned).toBe(0);
      expect(fs.existsSync(filePath)).toBe(true);
    });

  }); // pruneStaleMemories

  // ── rebuildIndex ────────────────────────────────────────────────────────────

  describe('rebuildIndex', () => {

    it.skipIf(!hasSqlite)('rebuildIndex_afterCreates_searchFindsByTerm', async () => {
      // Arrange
      const manager = makeManager();
      await manager.createMemory('patterns', 'zeta_mem', { tag: 'zeta_marker_one' });
      await manager.createMemory('patterns', 'omega_mem', { tag: 'omega_marker_two' });

      // Act
      await manager.rebuildIndex();
      const results = await manager.searchMemories('zeta_marker_one');

      // Assert
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

  }); // rebuildIndex

  // ── category limits ─────────────────────────────────────────────────────────

  describe('category limits', () => {

    it('createMemory_atCapPlusOne_returnsNullAndKeepsCountAtCap', async () => {
      // Arrange — suppress console noise
      const origLog = console.log;
      console.log = () => {};

      try {
        const manager = makeManager();

        // Fill exactly to the cap with fresh memories (so pruneStale won't remove any)
        for (let i = 0; i < CAP; i++) {
          const result = await manager.createMemory('patterns', `pat_fresh_${i}`, { n: i });
          expect(result).not.toBeNull();
        }

        // Act — the cap+1 write
        const overflow = await manager.createMemory('patterns', 'pat_overflow', { n: CAP });

        // Assert
        expect(overflow).toBeNull();
        const count = await manager.getMemoryCount('patterns');
        expect(count).toBe(CAP);
      } finally {
        console.log = origLog;
      }
    });

    it('capEnvOverride_lowersEffectiveCap', async () => {
      // MP-2.1: MEMORY_MAX_PER_CATEGORY env override changes the effective cap.
      // The cap is a module-load-time const, so reload the module with the env set.
      const origLog = console.log;
      console.log = () => {};
      const modPath = require.resolve('../memory-manager');
      const origCap = process.env.MEMORY_MAX_PER_CATEGORY;
      let reloaded;
      try {
        process.env.MEMORY_MAX_PER_CATEGORY = '2';
        delete require.cache[modPath];
        const ReloadedMM = require('../memory-manager');
        // CLAUDE_PROJECT_DIR is already tmp.root (beforeEach)
        reloaded = new ReloadedMM();

        expect(await reloaded.createMemory('patterns', 'cap_a', { n: 1 })).not.toBeNull();
        expect(await reloaded.createMemory('patterns', 'cap_b', { n: 2 })).not.toBeNull();
        // 3rd write exceeds the env-lowered cap of 2 → blocked
        expect(await reloaded.createMemory('patterns', 'cap_c', { n: 3 })).toBeNull();
        expect(await reloaded.getMemoryCount('patterns')).toBe(2);
      } finally {
        if (reloaded && reloaded.db) {
          try { reloaded.db.close(); } catch { /* non-fatal */ }
          reloaded.db = null;
        }
        // Restore env + module cache so later tests see the default-cap module
        if (origCap === undefined) delete process.env.MEMORY_MAX_PER_CATEGORY;
        else process.env.MEMORY_MAX_PER_CATEGORY = origCap;
        delete require.cache[modPath];
        require('../memory-manager');
        console.log = origLog;
      }
    });

  }); // category limits

  // ── generateAnalytics (MP-3.1) ──────────────────────────────────────────────

  describe('generateAnalytics', () => {

    function writeInjectionLog(lines) {
      tmp.write(
        'docs/.output/.state/telemetry/memory-injection.jsonl',
        lines.map(l => JSON.stringify(l)).join('\n') + '\n'
      );
    }

    it('generateAnalytics_seededStore_returnsCapDecayUsageSections', async () => {
      // Arrange — 3 fresh memories (usage_count 0, recent → not stale)
      const manager = makeManager();
      await manager.createMemory('patterns', 'an_a', { description: 'alpha' });
      await manager.createMemory('patterns', 'an_b', { description: 'beta' });
      await manager.createMemory('constraints', 'an_c', { description: 'gamma' });

      // Act
      const a = await manager.generateAnalytics();

      // Assert — (a) cap utilization
      expect(a.cap).toBe(CAP);
      expect(a.cap_utilization.patterns.count).toBe(2);
      expect(a.cap_utilization.patterns.cap).toBe(CAP);
      expect(a.cap_utilization.patterns.near_limit).toBe(false);
      expect(a.cap_utilization.constraints.count).toBe(1);
      // (b) decay distribution — fresh memories are not stale
      expect(a.decay.total_stale).toBe(0);
      expect(a.decay.total_archive_candidates).toBe(0);
      // (c) usage distribution — all freshly created, usage_count 0
      expect(a.usage.never_used).toBe(3);
      expect(Array.isArray(a.usage.top_used)).toBe(true);
      // (d) prune list — nothing stale yet
      expect(a.prune.current_size).toBe(3);
      expect(a.prune.candidates.length).toBe(0);
      expect(a.prune.projected_size_after).toBe(3);
    });

    it('generateAnalytics_withInjectionAndAccess_computesHitRate', async () => {
      // Arrange — one injection of 2 ids, one access of 1 of them (after injection)
      const manager = makeManager();
      writeInjectionLog([
        { timestamp: '2026-06-03T10:00:00.000Z', type: 'memory_injection', injected_count: 2, total_available: 2, injected_ids: ['mem-a', 'mem-b'], session_proxy: '2026-06-03T10:00' },
        { timestamp: '2026-06-03T10:05:00.000Z', type: 'memory_access', accessed_ids: ['mem-a'], session_proxy: '2026-06-03T10:05' },
      ]);

      // Act
      const a = await manager.generateAnalytics();

      // Assert — 1 of 2 injected ids recalled → 0.5
      expect(a.hit_rate.has_telemetry).toBe(true);
      expect(a.hit_rate.denominator).toBe(2);
      expect(a.hit_rate.numerator).toBe(1);
      expect(a.hit_rate.value).toBe(0.5);
      expect(a.hit_rate.lower_bound).toBe(true);
      expect(a.injection.has_telemetry).toBe(true);
      expect(a.injection.avg_injected_count).toBe(2);
    });

    it('generateAnalytics_missingInjectionLog_degradesGracefully', async () => {
      // Arrange — store exists, no telemetry file at all
      const manager = makeManager();
      await manager.createMemory('patterns', 'no_tel', { description: 'x' });

      // Act / Assert — no throw, hit-rate + injection sections flagged absent
      const a = await manager.generateAnalytics();
      expect(a.hit_rate.has_telemetry).toBe(false);
      expect(a.hit_rate.value).toBeNull();
      expect(a.hit_rate.denominator).toBe(0);
      expect(a.injection.has_telemetry).toBe(false);
      expect(a.injection.avg_injected_count).toBeNull();
    });

    // ME-1.1 — decay-independent dead-weight flagger
    function writeBackdated(category, id, createdISO, overrides = {}) {
      const base = {
        id,
        type: category.slice(0, -1),
        category,
        created: createdISO,
        updated: createdISO,
        usage_count: 0,
        content: { description: 'seed' },
        metadata: { confidence: 1.0 },
        ...overrides,
      };
      tmp.write(`docs/.output/.memory/${category}/${id.replace(/_/g, '-')}.json`, JSON.stringify(base, null, 2));
      return base;
    }

    it('generateAnalytics_neverUsedExposed40Days_flaggedAsDeadWeight', async () => {
      // Arrange — tmp.root is not a git repo, so getActiveDaysSince falls back to
      // calendar days. A never-used memory created 40 calendar-days ago is exposed
      // past the 30-day window; a never-used 5-day-old one is NOT.
      const manager = makeManager();
      const old = new Date(Date.now() - 40 * 86400000).toISOString();
      const recent = new Date(Date.now() - 5 * 86400000).toISOString();
      writeBackdated('patterns', 'dead_old', old);
      writeBackdated('patterns', 'fresh_new', recent);

      // Act
      const a = await manager.generateAnalytics();

      // Assert — dead_weight section shape + correct flagging
      expect(a.dead_weight).toBeDefined();
      expect(a.dead_weight.exposure_min_active_days).toBe(30);
      const ids = a.dead_weight.candidates.map(c => c.id);
      expect(ids).toContain('dead_old');
      expect(ids).not.toContain('fresh_new');

      const cand = a.dead_weight.candidates.find(c => c.id === 'dead_old');
      expect(cand.category).toBe('patterns');
      expect(cand.active_days_since_created).toBeGreaterThanOrEqual(30);
      expect(typeof cand.decayed_confidence).toBe('number');

      // current → projected accounting + lower-bound caveat
      expect(a.dead_weight.current_size).toBeGreaterThanOrEqual(2);
      expect(a.dead_weight.projected_size_after).toBe(
        a.dead_weight.current_size - a.dead_weight.candidates.length
      );
      expect(typeof a.dead_weight.caveat).toBe('string');
      expect(a.dead_weight.caveat.toLowerCase()).toContain('lower bound');
    });

    it('generateAnalytics_usedButOldMemory_notDeadWeight', async () => {
      // A memory with usage_count > 0 is never dead-weight regardless of exposure.
      const manager = makeManager();
      const old = new Date(Date.now() - 60 * 86400000).toISOString();
      writeBackdated('patterns', 'old_but_used', old, { usage_count: 3 });

      const a = await manager.generateAnalytics();

      const ids = a.dead_weight.candidates.map(c => c.id);
      expect(ids).not.toContain('old_but_used');
    });

  }); // generateAnalytics

  // ── importance (ME-2.1) ──────────────────────────────────────────────────────

  describe('importance', () => {
    it('createMemory_authorImportance_persistsTopLevelAndList', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'imp_five', { description: 'x', importance: 5 });

      // Top-level on the stored JSON (mirrors usage_count), not in content/metadata
      const mem = await manager.readMemory('patterns', 'imp_five');
      expect(mem.importance).toBe(5);

      // Surfaced in the listMemories summary
      const list = await manager.listMemories('patterns');
      expect(list.find(m => m.id === 'imp_five').importance).toBe(5);
    });

    it('createMemory_noImportance_defaultsToThree', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'imp_def', { description: 'x' });
      const mem = await manager.readMemory('patterns', 'imp_def');
      expect(mem.importance).toBe(3);
      const list = await manager.listMemories('patterns');
      expect(list.find(m => m.id === 'imp_def').importance).toBe(3);
    });

    it('createMemory_outOfRangeImportance_clampedToOneFive', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'imp_hi', { description: 'x', importance: 9 });
      await manager.createMemory('patterns', 'imp_lo', { description: 'x', importance: 0 });
      expect((await manager.readMemory('patterns', 'imp_hi')).importance).toBe(5);
      expect((await manager.readMemory('patterns', 'imp_lo')).importance).toBe(1);
    });

    it('listMemories_legacyMemoryNoImportance_backfillsThree', async () => {
      // Legacy memory written before the importance field existed.
      const manager = makeManager();
      const legacy = {
        id: 'legacy_mem', type: 'pattern', category: 'patterns',
        created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z',
        usage_count: 0, content: { description: 'old' }, metadata: { confidence: 1.0 },
      };
      tmp.write('docs/.output/.memory/patterns/legacy-mem.json', JSON.stringify(legacy, null, 2));

      const list = await manager.listMemories('patterns');
      expect(list.find(m => m.id === 'legacy_mem').importance).toBe(3);
    });

    it('ensureColumn_preExistingDbWithoutColumn_migratesIdempotently', async () => {
      // Backend-agnostic (node:sqlite OR better-sqlite3): use the manager's own
      // db handle. Simulate the pre-migration adopter schema by DROPping the
      // importance column, then prove ensureColumn re-adds it and is a no-op on
      // a second call. Skips only if SQLite is entirely unavailable.
      const probe = makeManager();
      if (!probe.initDb()) return; // JSON-only env — migration path N/A

      // Simulate "old" DB: remove the column CREATE TABLE just added.
      probe.db.exec('ALTER TABLE memories DROP COLUMN importance');
      let cols = probe.db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
      expect(cols).not.toContain('importance');

      // Act — the migration seam re-adds it.
      probe.ensureColumn('memories', 'importance', 'importance INTEGER DEFAULT 3');
      cols = probe.db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
      expect(cols).toContain('importance');

      // Idempotent — a second call does not throw and adds nothing.
      probe.ensureColumn('memories', 'importance', 'importance INTEGER DEFAULT 3');
      const count = probe.db.prepare('PRAGMA table_info(memories)').all()
        .filter(c => c.name === 'importance').length;
      expect(count).toBe(1);

      // A new memory persists its importance to the migrated column.
      await probe.createMemory('patterns', 'mig_mem', { description: 'x', importance: 4 });
      const row = probe.db.prepare('SELECT importance FROM memories WHERE id = ?').get('mig_mem');
      expect(row.importance).toBe(4);
    });
  }); // importance

  // ── importance retention floor (ME-2.2) ──────────────────────────────────────

  describe('importance retention floor', () => {
    it('calculateDecayedConfidence_lowImportanceNeverUsed_crossesStaleHighDoesNot', () => {
      // Two memories identical except importance, both never used, on an "active
      // repo" (tmp has no git → calendar fallback; ~14 days of decay puts the base
      // decayed_confidence in a band where the importance factor decides STALE).
      const manager = makeManager();
      const updated = new Date(Date.now() - 14 * 86400000).toISOString();
      const base = { category: 'patterns', usage_count: 0, updated, metadata: { confidence: 1.0 } };

      const dLow = manager.calculateDecayedConfidence({ ...base, importance: 1 });
      const dMid = manager.calculateDecayedConfidence({ ...base, importance: 3 });
      const dHigh = manager.calculateDecayedConfidence({ ...base, importance: 5 });

      // importance-1 falls below the 0.3 STALE_THRESHOLD; importance-5 does not
      expect(dLow).toBeLessThan(0.3);
      expect(dHigh).toBeGreaterThanOrEqual(0.3);
      // monotonic in importance
      expect(dLow).toBeLessThan(dMid);
      expect(dMid).toBeLessThan(dHigh);
    });

    it('calculateDecayedConfidence_defaultAndLegacy_unchangedFromBaseCurve', () => {
      // importance 3 (default) and a legacy memory with NO importance must produce
      // the SAME decayed_confidence — the importance factor is normalized at 3 so
      // existing memories are untouched (AC: no change to the decay curve itself).
      const manager = makeManager();
      // Pin active-days so both calls use the SAME decay power. Without this the manager
      // recomputes activeDays from a live Date.now() per call (git-unavailable fallback in
      // _lib/memory-decay), so the two readings differ by microseconds and the result
      // diverges at ~1e-10 — a racy comparison that exact-equality at 10 digits cannot hold
      // as the decay derivative grows. Pinning makes the importance-factor equivalence the
      // only thing under test, which is the point.
      manager._activeDaysResolver = { getActiveDaysSince: () => 10 };
      const updated = new Date(Date.now() - 10 * 86400000).toISOString();
      const base = { category: 'patterns', usage_count: 0, updated, metadata: { confidence: 1.0 } };

      const dDefault = manager.calculateDecayedConfidence({ ...base, importance: 3 });
      const dLegacy = manager.calculateDecayedConfidence({ ...base }); // no importance field
      expect(dLegacy).toBeCloseTo(dDefault, 10);
    });

    it('calculateRelevance_higherImportance_scoresStrictlyHigher', () => {
      // JSON fallback scoring site (:858-equivalent): identical except importance.
      const manager = makeManager();
      const mk = (importance) => ({
        content: { description: 'a searchable token here' },
        updated: new Date().toISOString(),
        usage_count: 0,
        importance,
        metadata: { confidence: 1.0 },
      });
      const sLow = manager.calculateRelevance(mk(1), 'token');
      const sHigh = manager.calculateRelevance(mk(5), 'token');
      expect(sHigh).toBeGreaterThan(sLow);
    });

    it('calculateRelevance_weightsSingleSourcedFromConstants', () => {
      // Sync guard (still-catches): the JSON-fallback weights must stay wired to
      // MEMORY_SCORING. If anyone re-hardcodes a divergent multiplier, the exact
      // expected score derived from constants no longer matches.
      const S = CONSTANTS.MEMORY_SCORING;
      const manager = makeManager();
      const memory = {
        content: { description: 'token token token' }, // 3 literal occurrences
        updated: new Date().toISOString(),             // < RECENCY_RECENT_DAYS → recent bonus
        usage_count: 2,
        importance: 4,
        metadata: { confidence: 0.5 },
      };
      const matches = (JSON.stringify(memory.content).toLowerCase().match(/token/g) || []).length;
      const expected =
        matches * S.MATCH_MULTIPLIER +
        S.RECENCY_RECENT_POINTS +
        memory.usage_count * S.USAGE_MULTIPLIER +
        memory.metadata.confidence * S.CONFIDENCE_MULTIPLIER +
        memory.importance * S.IMPORTANCE_MULTIPLIER;
      expect(manager.calculateRelevance(memory, 'token')).toBe(expected);
    });

    it('searchMemories_sqlitePath_higherImportanceRelevanceStrictlyHigher', async () => {
      // SQLite FTS relevance site (:578-equivalent). Identical content so FTS rank,
      // confidence, and usage all match — only the importance term differs.
      const manager = makeManager();
      if (!manager.initDb()) return; // requires SQLite FTS path
      await manager.createMemory('patterns', 'imp_low_s', { description: 'zebrafish marker token', importance: 1 });
      await manager.createMemory('patterns', 'imp_high_s', { description: 'zebrafish marker token', importance: 5 });

      const results = await manager.searchMemories('zebrafish');
      const low = results.find(r => r.id === 'imp_low_s');
      const high = results.find(r => r.id === 'imp_high_s');
      expect(low).toBeTruthy();
      expect(high).toBeTruthy();
      expect(high.relevance).toBeGreaterThan(low.relevance);
    });
  }); // importance retention floor

  // ── supersession (ME-3.1) ────────────────────────────────────────────────────

  describe('supersession filter', () => {
    function writeMem(category, id, overrides = {}) {
      const base = {
        id, type: category.slice(0, -1), category,
        created: '2024-01-01T00:00:00.000Z', updated: '2024-01-01T00:00:00.000Z',
        usage_count: 0, content: { description: 'seed token here' }, metadata: { confidence: 1.0 },
        ...overrides,
      };
      tmp.write(`docs/.output/.memory/${category}/${id.replace(/_/g, '-')}.json`, JSON.stringify(base, null, 2));
      return base;
    }

    it('listMemories_supersededMemory_hiddenByDefaultVisibleWithFlag', async () => {
      const manager = makeManager();
      writeMem('patterns', 'live_one');
      writeMem('patterns', 'dead_one', { invalid_at: '2024-02-01T00:00:00.000Z', superseded_by: 'live_one' });

      const def = await manager.listMemories('patterns');
      expect(def.map(m => m.id)).toContain('live_one');
      expect(def.map(m => m.id)).not.toContain('dead_one');

      const all = await manager.listMemories('patterns', { includeSuperseded: true });
      expect(all.map(m => m.id)).toContain('dead_one');
      // summary surfaces invalid_at for downstream (ME-3.2 count)
      expect(all.find(m => m.id === 'dead_one').invalid_at).toBe('2024-02-01T00:00:00.000Z');
    });

    it('listMemories_legacyNoSupersedeColumns_treatedAsNotSuperseded', async () => {
      // default-on-read: a memory with no invalid_at field is live
      const manager = makeManager();
      writeMem('patterns', 'legacy_live'); // no invalid_at key at all
      const def = await manager.listMemories('patterns');
      expect(def.map(m => m.id)).toContain('legacy_live');
    });

    it('searchMemories_sqlitePath_excludesSupersededByDefault', async () => {
      const manager = makeManager();
      if (!manager.initDb()) return;
      await manager.createMemory('patterns', 'srch_live', { description: 'kangaroo token' });
      await manager.createMemory('patterns', 'srch_dead', { description: 'kangaroo token' });
      // Mark one superseded directly in the db (ME-3.2 adds the supersede() method).
      manager.db.prepare('UPDATE memories SET invalid_at = ? WHERE id = ?')
        .run('2024-02-01T00:00:00.000Z', 'srch_dead');

      const def = await manager.searchMemories('kangaroo');
      expect(def.map(r => r.id)).toContain('srch_live');
      expect(def.map(r => r.id)).not.toContain('srch_dead');

      const all = await manager.searchMemories('kangaroo', { includeSuperseded: true });
      expect(all.map(r => r.id)).toContain('srch_dead');
    });

    it('ensureColumn_supersedeColumns_addedIdempotently', async () => {
      const manager = makeManager();
      if (!manager.initDb()) return;
      const cols = manager.db.prepare('PRAGMA table_info(memories)').all().map(c => c.name);
      expect(cols).toContain('invalid_at');
      expect(cols).toContain('superseded_by');
    });
  }); // supersession filter

  // ── supersede + overlap detection (ME-3.2) ───────────────────────────────────

  describe('supersede and overlap', () => {
    it('createMemory_overlappingSameCategory_flagsPredecessor', async () => {
      const manager = makeManager();
      if (!manager.initDb()) return; // FTS5 required
      await manager.createMemory('patterns', 'overlap_old', { description: 'kangaroo marsupial pouch token' });
      const created = await manager.createMemory('patterns', 'overlap_new', { description: 'kangaroo marsupial pouch token' });

      // Detection FLAGS the predecessor on the returned object — does NOT auto-supersede
      expect(Array.isArray(created.supersedes_candidates)).toBe(true);
      expect(created.supersedes_candidates).toContain('overlap_old');
      // old memory is still live (flag only)
      const oldMem = await manager.readMemory('patterns', 'overlap_old');
      expect(oldMem.invalid_at == null).toBe(true);
    });

    it('createMemory_noOverlap_noCandidatesOrEmpty', async () => {
      const manager = makeManager();
      if (!manager.initDb()) return;
      const created = await manager.createMemory('patterns', 'unique_one', { description: 'xylophone quokka zeppelin' });
      expect(created.supersedes_candidates ?? []).toEqual([]);
    });

    it('supersede_marksOldInvalidHidesFromReads_idempotent', async () => {
      const manager = makeManager();
      if (!manager.initDb()) return;
      await manager.createMemory('patterns', 'sup_old', { description: 'wombat token findme' });
      await manager.createMemory('patterns', 'sup_new', { description: 'wombat token findme improved' });

      const res = await manager.supersede('patterns', 'sup_old', 'sup_new');
      expect(res.superseded).toBe(true);

      // JSON now carries invalid_at + superseded_by
      const oldMem = await manager.readMemory('patterns', 'sup_old');
      expect(typeof oldMem.invalid_at).toBe('string');
      expect(oldMem.superseded_by).toBe('sup_new');

      // hidden from default list + search; new one still present
      const list = await manager.listMemories('patterns');
      expect(list.map(m => m.id)).not.toContain('sup_old');
      const found = await manager.searchMemories('wombat');
      expect(found.map(r => r.id)).not.toContain('sup_old');

      // idempotent — re-run does not error and keeps the original timestamp
      const firstTs = oldMem.invalid_at;
      const res2 = await manager.supersede('patterns', 'sup_old', 'sup_new');
      expect(res2.superseded).toBe(true);
      expect((await manager.readMemory('patterns', 'sup_old')).invalid_at).toBe(firstTs);
    });

    it('generateAnalytics_reportsSupersededCount', async () => {
      const manager = makeManager();
      if (!manager.initDb()) return;
      await manager.createMemory('patterns', 'an_live', { description: 'active one' });
      await manager.createMemory('patterns', 'an_old', { description: 'old one' });
      await manager.createMemory('patterns', 'an_repl', { description: 'replacement' });
      await manager.supersede('patterns', 'an_old', 'an_repl');

      const a = await manager.generateAnalytics();
      expect(a.supersession).toBeDefined();
      expect(a.supersession.superseded).toBe(1);
      // active count excludes the superseded memory
      expect(a.supersession.active).toBe(2);
    });
  }); // supersede and overlap

  // ── honest usage (ME-4.1) ────────────────────────────────────────────────────

  describe('honest usage', () => {
    it('updateMemory_noLongerIncrementsUsageCount', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'upd_mem', { description: 'seed' });
      expect((await manager.readMemory('patterns', 'upd_mem')).usage_count).toBe(0);

      // a metadata/content patch is NOT a recall — usage must stay put
      await manager.updateMemory('patterns', 'upd_mem', { content: { extra: 'patch' } });
      expect((await manager.readMemory('patterns', 'upd_mem')).usage_count).toBe(0);
    });

    it('searchMemories_genuineRecall_recordsInIndexNotTrackedJson_survivesReload', async () => {
      const manager = makeManager();
      // usage_count lives in the .state/ index; a JSON-only env has nowhere to record it.
      if (!manager.initDb()) return;
      await manager.createMemory('patterns', 'recall_mem', { description: 'platypus token here' });
      expect((await manager.readMemory('patterns', 'recall_mem')).usage_count).toBe(0);

      // Each search = one genuine recall = +1, recorded ONLY in the gitignored
      // .state/ index — never the tracked .memory/ JSON (writing it there churned
      // the synced source on every recall; W1B store split / ADR 0006 Am. 2).
      await manager.searchMemories('platypus');
      await manager.searchMemories('platypus');

      // the tracked JSON source is NOT mutated by a read (the regression guard)
      expect((await manager.readMemory('patterns', 'recall_mem')).usage_count).toBe(0);
      // …but the index recorded both recalls
      const idxCount = () => manager.db
        .prepare('SELECT usage_count AS n FROM memories WHERE id = ?').get('recall_mem').n;
      expect(idxCount()).toBe(2);

      // survives a reload (new manager reading the same persisted index)
      const reopened = makeManager();
      reopened.initDb();
      expect(reopened.db
        .prepare('SELECT usage_count AS n FROM memories WHERE id = ?').get('recall_mem').n).toBe(2);
    });
  }); // honest usage

  // ── ingestAgentMemory ───────────────────────────────────────────────────────

  describe('ingestAgentMemory', () => {

    function writeMd(relPath, frontmatter, body) {
      const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
      const content = `---\n${fm}\n---\n\n${body}`;
      return tmp.write(relPath, content);
    }

    it('ingest_singleMarkdownFile_createsJsonMemory', async () => {
      // Arrange
      const manager = makeManager();
      const mdPath = writeMd(
        'agent-memory/general-purpose/feedback_sample_rule.md',
        { name: 'Sample rule', description: 'one-line summary', type: 'feedback' },
        'Body paragraph with a useful rule.\n\nSecond paragraph.'
      );

      // Act
      const report = await manager.ingestAgentMemory(mdPath);

      // Assert — report shape
      expect(report.ingested).toBe(1);
      expect(report.skipped).toBe(0);
      expect(report.errors).toEqual([]);

      // Assert — JSON on disk
      const memory = await manager.readMemory('patterns', 'feedback-sample-rule');
      expect(memory).not.toBeNull();
      expect(memory.content.description).toBe('one-line summary');
      expect(memory.content.body).toContain('Body paragraph');
      expect(memory.content.body).toContain('Second paragraph');
      expect(memory.content.source).toBe('agent-memory');
    });

    it('ingest_directory_walksRecursively', async () => {
      // Arrange — two files in sibling agent subdirs
      const manager = makeManager();
      const dirRoot = tmp.mkdir('agent-memory');
      writeMd(
        'agent-memory/general-purpose/feedback_alpha.md',
        { name: 'Alpha', description: 'alpha desc', type: 'feedback' },
        'Alpha body'
      );
      writeMd(
        'agent-memory/architect/pattern_beta.md',
        { name: 'Beta', description: 'beta desc', type: 'pattern' },
        'Beta body'
      );

      // Act
      const report = await manager.ingestAgentMemory(dirRoot);

      // Assert — ids are namespaced by the agent (parent) dir relative to the walked
      // root (M9), so two agents' same-named files can't collide.
      expect(report.ingested).toBe(2);
      const alpha = await manager.readMemory('patterns', 'general-purpose-feedback-alpha');
      const beta = await manager.readMemory('patterns', 'architect-pattern-beta');
      expect(alpha).not.toBeNull();
      expect(beta).not.toBeNull();
    });

    it('ingest_sameBasenameDifferentAgentDirs_noCollision', async () => {
      // M9: all 11 agents recommend the SAME generic filenames (feedback_testing.md,
      // user_role.md, …). Basename-only ids collided two agents' files onto one
      // (category, id) and silently dropped the second (skipped as "already exists").
      // Namespacing by the agent dir must keep both — distinct ids, both ingested.
      const manager = makeManager();
      const dirRoot = tmp.mkdir('agent-memory');
      writeMd(
        'agent-memory/general-purpose/feedback_testing.md',
        { name: 'GP testing', description: 'general-purpose take on testing', type: 'feedback' },
        'GP body'
      );
      writeMd(
        'agent-memory/architect/feedback_testing.md',
        { name: 'Arch testing', description: 'architect take on testing', type: 'feedback' },
        'Architect body'
      );

      const report = await manager.ingestAgentMemory(dirRoot);

      // Both survive — neither silently skipped as a false duplicate.
      expect(report.ingested).toBe(2);
      expect(report.skipped).toBe(0);
      const gp = await manager.readMemory('patterns', 'general-purpose-feedback-testing');
      const arch = await manager.readMemory('patterns', 'architect-feedback-testing');
      expect(gp).not.toBeNull();
      expect(arch).not.toBeNull();
      expect(gp.content.description).toBe('general-purpose take on testing');
      expect(arch.content.description).toBe('architect take on testing');
    });

    it('ingest_mapsTypeToCategoryCorrectly', async () => {
      // Arrange — one file per category mapping
      const manager = makeManager();
      writeMd('m/constraint_one.md',         { name: 'C', description: 'c', type: 'constraint' },         'body');
      writeMd('m/decision_one.md',           { name: 'D', description: 'd', type: 'decision' },           'body');
      writeMd('m/workflow_one.md',           { name: 'W', description: 'w', type: 'workflow' },           'body');
      writeMd('m/rejected-approach_one.md',  { name: 'R', description: 'r', type: 'rejected-approach' },  'body');

      // Act
      await manager.ingestAgentMemory(tmp.mkdir('m'));

      // Assert
      expect(await manager.readMemory('constraints', 'constraint-one')).not.toBeNull();
      expect(await manager.readMemory('decisions', 'decision-one')).not.toBeNull();
      expect(await manager.readMemory('workflows', 'workflow-one')).not.toBeNull();
      expect(await manager.readMemory('rejected-approaches', 'rejected-approach-one')).not.toBeNull();
    });

    it('ingest_existingMemory_skipsWithoutOverwriting', async () => {
      // Arrange
      const manager = makeManager();
      await manager.createMemory('patterns', 'feedback-dup', { description: 'original' });
      writeMd(
        'agent-memory/feedback_dup.md',
        { name: 'Dup', description: 'would-be-ingested', type: 'feedback' },
        'new body'
      );

      // Act
      const report = await manager.ingestAgentMemory(path.join(tmp.root, 'agent-memory'));

      // Assert
      expect(report.ingested).toBe(0);
      expect(report.skipped).toBe(1);
      const still = await manager.readMemory('patterns', 'feedback-dup');
      expect(still.content.description).toBe('original'); // not overwritten
    });

    it('ingest_unknownTypeIsError_notThrow', async () => {
      // Arrange
      const manager = makeManager();
      writeMd(
        'agent-memory/bad.md',
        { name: 'Bad', description: 'x', type: 'gibberish' },
        'body'
      );

      // Act
      const report = await manager.ingestAgentMemory(path.join(tmp.root, 'agent-memory'));

      // Assert
      expect(report.ingested).toBe(0);
      expect(report.errors.length).toBe(1);
      expect(report.errors[0].reason).toMatch(/unknown type/i);
    });

    it('ingest_missingFrontmatter_isError', async () => {
      // Arrange
      const manager = makeManager();
      tmp.write('agent-memory/no-fm.md', 'Just a body with no frontmatter.\n');

      // Act
      const report = await manager.ingestAgentMemory(path.join(tmp.root, 'agent-memory'));

      // Assert
      expect(report.errors.length).toBe(1);
      expect(report.errors[0].reason).toMatch(/frontmatter/i);
    });

    it('ingest_skipsMemoryMdIndexFiles', async () => {
      // Arrange — MEMORY.md index files have no frontmatter; must be filtered, not errored
      const manager = makeManager();
      tmp.write('agent-memory/general-purpose/MEMORY.md', '# Index\n- [foo](foo.md)\n');
      writeMd(
        'agent-memory/general-purpose/feedback_real.md',
        { name: 'Real', description: 'r', type: 'feedback' },
        'real body'
      );

      // Act
      const report = await manager.ingestAgentMemory(path.join(tmp.root, 'agent-memory'));

      // Assert
      expect(report.ingested).toBe(1);
      expect(report.errors).toEqual([]);
      expect(report.skipped).toBe(0);
    });

    it('ingest_dryRun_writesNothing', async () => {
      // Arrange
      const manager = makeManager();
      writeMd(
        'agent-memory/feedback_preview.md',
        { name: 'Preview', description: 'p', type: 'feedback' },
        'body'
      );

      // Act
      const report = await manager.ingestAgentMemory(
        path.join(tmp.root, 'agent-memory'),
        { dryRun: true }
      );

      // Assert
      expect(report.ingested).toBe(1); // reports as "would ingest"
      const actual = await manager.readMemory('patterns', 'feedback-preview');
      expect(actual).toBeNull(); // nothing on disk
    });

    it('ingest_preservesMarkdownCodeBlocks', async () => {
      // Arrange — real-world-ish markdown with code fences
      const manager = makeManager();
      const body = [
        'Use the wrapper pattern:',
        '',
        '```js',
        "const wrapper = function() { return 'x'; };",
        '```',
        '',
        'Why: destructured imports capture the reference at load time.',
      ].join('\n');
      writeMd(
        'agent-memory/feedback_with_code.md',
        { name: 'Code-bearing', description: 'short desc', type: 'feedback' },
        body
      );

      // Act
      await manager.ingestAgentMemory(path.join(tmp.root, 'agent-memory'));

      // Assert
      const memory = await manager.readMemory('patterns', 'feedback-with-code');
      expect(memory.content.body).toContain('```js');
      expect(memory.content.body).toContain("return 'x'");
      expect(memory.content.body).toContain('```');
    });

    it('ingest_windowsLineEndings_parsedCorrectly', async () => {
      // Arrange — CRLF line endings (Windows git checkout default)
      const manager = makeManager();
      const crlfContent =
        '---\r\nname: CRLF\r\ndescription: win\r\ntype: feedback\r\n---\r\n\r\nBody line.\r\n';
      tmp.write('agent-memory/feedback_crlf.md', crlfContent);

      // Act
      const report = await manager.ingestAgentMemory(path.join(tmp.root, 'agent-memory'));

      // Assert
      expect(report.ingested).toBe(1);
      expect(report.errors).toEqual([]);
      const memory = await manager.readMemory('patterns', 'feedback-crlf');
      expect(memory.content.description).toBe('win');
    });

  }); // ingestAgentMemory

}); // memory-manager

// ─── buildFtsQuery (Dispatch port-back 2026-06-02) ───────────────────────────
describe('buildFtsQuery', () => {
  const { buildFtsQuery } = require('../memory-manager');

  it('OR-joins multi-word terms so any keyword matches', () => {
    expect(buildFtsQuery('memory inbox protocol')).toBe('memory OR inbox OR protocol');
  });

  it('passes a single token through unchanged', () => {
    expect(buildFtsQuery('inbox')).toBe('inbox');
  });

  it('does not touch strings already using FTS5 operators', () => {
    expect(buildFtsQuery('memory AND inbox')).toBe('memory AND inbox');
    expect(buildFtsQuery('"exact phrase"')).toBe('"exact phrase"');
    expect(buildFtsQuery('prefix*')).toBe('prefix*');
  });

  it('drops sub-2-char tokens then OR-joins the rest', () => {
    expect(buildFtsQuery('a memory b inbox')).toBe('memory OR inbox');
  });

  it('returns non-string input unchanged', () => {
    expect(buildFtsQuery('')).toBe('');
    expect(buildFtsQuery(null)).toBe(null);
  });
});
