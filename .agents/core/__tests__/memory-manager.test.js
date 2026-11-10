// AC→source map (TDD-3.2):
//   - deleteMemory() unlinks JSON + deindexes; returns {deleted,error?} (no throw)
//   - MEMORY_DECAY.RATES[category] (nested), not MEMORY_DECAY[category]
//   - Decay formula: base*rate^activeDays + usage*USAGE_BOOST + (recent?RECENT_UPDATE_BOOST:0), cap 1.0
//   - lintMemories deductions: error=3, warning=2, info=1 (not 10)
//   - pruneStaleMemories deletes files (no archive tier)
//   - Category limit → createMemory returns null at 51st

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const MemoryManager = require('../../../.agents/core/memory-manager');
const CONSTANTS = require('../../../.agents/core/constants');
// Constant-relative so a change to the cap OR the near-limit fraction doesn't re-break these tests.
const CAP = CONSTANTS.MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY;
const NEAR_PCT = CONSTANTS.MEMORY_FILTERS.MEMORY_NEAR_LIMIT_PCT;
const { createTmpDir } = require('./_helpers/tmp-dir');
const { createGitRepo } = require('./_helpers/git-fixture');

function seedActiveDates(repo, count, year, prefix = 'commit ') {
  const history = Array.from({ length: count }, (_, i) => ({
    message: `${prefix}${i + 1}`, date: new Date(Date.UTC(year, 0, i + 1)).toISOString(),
  }));
  repo.addEmptyCommitsOnDates(history);
  const dates = require('node:child_process').execFileSync('git', ['log', `-${count}`, '--reverse', '--format=%at'], {
    cwd: repo.repoPath, encoding: 'utf8', timeout: 10000,
  }).trim().split('\n');
  expect(dates).toEqual(history.map(c => String(Date.parse(c.date) / 1000)));
}

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

    it('createMemory_idCollision_refusesByDefault_returnsNullAndKeepsOriginal', async () => {
      // F10: a second createMemory at the same (category, id) must not silently
      // clobber the prior file's content/history.
      const manager = makeManager();
      await manager.createMemory('patterns', 'collide_me', { description: 'original' });

      const result = await manager.createMemory('patterns', 'collide_me', { description: 'attempted overwrite' });

      expect(result).toBeNull();
      const onDisk = await manager.readMemory('patterns', 'collide_me');
      expect(onDisk.content.description).toBe('original');
    });

    it('createMemory_idCollision_overwriteTrue_replacesContent', async () => {
      // F10: {overwrite:true} is the explicit opt-in for a sanctioned rewrite.
      const manager = makeManager();
      await manager.createMemory('patterns', 'collide_overwrite', { description: 'original' });

      const result = await manager.createMemory(
        'patterns', 'collide_overwrite', { description: 'replaced' }, { overwrite: true }
      );

      expect(result).not.toBeNull();
      const onDisk = await manager.readMemory('patterns', 'collide_overwrite');
      expect(onDisk.content.description).toBe('replaced');
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

    // F43 (council-260715-2244): listMemories reads every JSON file to build
    // its summaries — includeFull hands callers that already-parsed record so
    // they never re-read per id (the systemic double file-read).
    it('listMemories_includeFull_attachesTheParsedRecord_noSecondRead (F43)', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'full_mem', { description: 'the full record', marker: 42 });

      const withFull = await manager.listMemories('patterns', { includeFull: true });
      expect(withFull).toHaveLength(1);
      expect(withFull[0].full).toBeTruthy();
      expect(withFull[0].full.content.marker).toBe(42); // full content available without readMemory
      expect(withFull[0].full.id).toBe(withFull[0].id);

      // Default shape stays lean — no full record serialized into reports.
      const summariesOnly = await manager.listMemories('patterns');
      expect(summariesOnly[0].full).toBeUndefined();
    });

    it('lintMemories performs ONE read per file (F43 single-pass)', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'single_read_a', { description: 'alpha single read probe' });
      await manager.createMemory('patterns', 'single_read_b', { description: 'beta single read probe' });

      // listMemories now reads store files directly (no readMemory round-trip),
      // so count actual JSON reads via the shared CJS fs.promises object.
      const fsp = require('fs').promises;
      const readSpy = vi.spyOn(fsp, 'readFile');
      await manager.lintMemories();
      const storeReads = readSpy.mock.calls.filter(([p]) =>
        String(p).startsWith(manager.memoriesDir) && String(p).endsWith('.json'));
      // 2 files in the store → exactly 2 reads (inside listMemories), zero re-reads.
      expect(storeReads.length).toBe(2);
      readSpy.mockRestore();
    });

    // Retro codereview-260715 regression: listMemories used to derive an id from
    // each FILENAME and push it back through readMemory's SAFE_ID_RE guard. But
    // idToFilename is lossy ('_' -> '-'), so a perfectly valid leading-underscore
    // id (e.g. '_lib-...', explicitly allowed by SAFE_ID_RE) produced a
    // leading-'-' filename that the guard rejected — the memory silently vanished
    // from report/analytics/lint/prune. Same for legacy files whose stored id
    // contains uppercase. listMemories must read enumerated files directly.
    it('listMemories_includesLeadingUnderscoreIds_andLegacyUppercaseFiles', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', '_lib_probe_mem', { description: 'leading underscore id' });
      // Seed a legacy uppercase-id file the way old stores actually hold them.
      const legacy = {
        id: 'legacy-camelCase-mem',
        category: 'patterns',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        usage_count: 0,
        content: { description: 'legacy uppercase id' },
        metadata: {}
      };
      fs.writeFileSync(
        path.join(manager.memoriesDir, 'patterns', 'legacy-camelCase-mem.json'),
        JSON.stringify(legacy, null, 2));

      const list = await manager.listMemories('patterns');
      const ids = list.map((m) => m.id);
      expect(ids).toContain('_lib_probe_mem');
      expect(ids).toContain('legacy-camelCase-mem');
    });

  }); // CRUD

  // ── Path-traversal guard (F42) ───────────────────────────────────────────────
  // createMemory/readMemory/updateMemory/deleteMemory all join caller-supplied
  // `id` straight into a `.json` filename. Verify each entry point refuses the
  // three attack shapes (parent-dir traversal, embedded traversal, absolute
  // path) BEFORE any path is built, and that no file escapes the store.

  describe('path-traversal guard (F42)', () => {
    const BAD_IDS = ['../../etc/x', 'a/../../b', '/etc/passwd'];

    // Any file that would land outside docs/.output/.memory/{category}/ as a
    // result of a successful escape — checked after each attempt to prove
    // nothing was written/read/deleted outside the store.
    function escapeCandidates() {
      return [
        path.join(tmp.root, 'docs', '.output', 'etc', 'x.json'),
        path.join(tmp.root, 'docs', '.output', 'b.json'),
        path.join(tmp.root, 'docs', '.output', '.memory', 'patterns', 'etc', 'passwd.json'),
        path.join(tmp.root, 'etc', 'x.json'),
      ];
    }

    for (const badId of BAD_IDS) {
      it(`createMemory_rejects_${badId}`, async () => {
        const manager = makeManager();
        await expect(manager.createMemory('patterns', badId, { description: 'x' })).rejects.toThrow(/Invalid id/);
        for (const candidate of escapeCandidates()) {
          expect(fs.existsSync(candidate)).toBe(false);
        }
      });

      it(`readMemory_refuses_${badId}`, async () => {
        const manager = makeManager();
        // Plant a sentinel file at a plausible escape target — if the guard
        // failed, readMemory would happily read this back.
        const sentinelPath = path.join(tmp.root, 'docs', '.output', 'etc', 'x.json');
        fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
        fs.writeFileSync(sentinelPath, JSON.stringify({ id: 'sentinel', content: { secret: true } }));

        const result = await manager.readMemory('patterns', badId);
        expect(result).toBeNull();
      });

      it(`updateMemory_refuses_${badId}`, async () => {
        const manager = makeManager();
        const result = await manager.updateMemory('patterns', badId, { content: { x: 1 } });
        expect(result).toBeNull();
      });

      it(`deleteMemory_refuses_${badId}`, async () => {
        const manager = makeManager();
        // Plant a sentinel file at a plausible escape target — if the guard
        // failed, deleteMemory would happily unlink this file.
        const sentinelPath = path.join(tmp.root, 'docs', '.output', 'etc', 'x.json');
        fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
        fs.writeFileSync(sentinelPath, 'sentinel');

        const result = await manager.deleteMemory('patterns', badId);
        expect(result.deleted).toBe(false);
        expect(result.error).toMatch(/Invalid id/);
        expect(fs.existsSync(sentinelPath)).toBe(true); // untouched
      });
    }

    it('createMemory_normalId_stillWorks_noFalseRejection', async () => {
      const manager = makeManager();
      const result = await manager.createMemory('patterns', 'safe-normal-id_123', { description: 'fine' });
      expect(result).not.toBeNull();
      expect(result.id).toBe('safe-normal-id_123');
    });

    it('readMemory_updateMemory_deleteMemory_normalId_stillWork_noFalseRejection', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'safe_round_trip', { a: 1 });

      const read = await manager.readMemory('patterns', 'safe_round_trip');
      expect(read).not.toBeNull();
      expect(read.content.a).toBe(1);

      const updated = await manager.updateMemory('patterns', 'safe_round_trip', { content: { b: 2 } });
      expect(updated).not.toBeNull();
      expect(updated.content.b).toBe(2);

      const deleted = await manager.deleteMemory('patterns', 'safe_round_trip');
      expect(deleted).toEqual({ deleted: true });
    });

    // ── W2-1: inbox entry points (sibling sinks the F42 first pass missed) ──────
    // inboxPromote/inboxDiscard take the raw CLI-supplied `id` straight into
    // path.join(inboxDir, id + '.json') — an unguarded `../`-laden id READS +
    // then UNLINKS (promote) or UNLINKS (discard) an arbitrary .json file
    // outside the inbox root. Verify both refuse traversal and leave the victim
    // intact.
    for (const badId of BAD_IDS) {
      it(`inboxDiscard_refuses_${badId}`, async () => {
        const manager = makeManager();
        const victim = path.join(tmp.root, 'docs', '.output', 'victim.json');
        fs.mkdirSync(path.dirname(victim), { recursive: true });
        fs.writeFileSync(victim, JSON.stringify({ keep: true }));

        const result = await manager.inboxDiscard(badId);
        expect(result.discarded).toBe(false);
        expect(result.error).toMatch(/Invalid inbox id/);
        expect(fs.existsSync(victim)).toBe(true); // never deleted
      });

      it(`inboxPromote_refuses_${badId}`, async () => {
        const manager = makeManager();
        // Plant a would-be-ingested file at a plausible escape target.
        const victim = path.join(tmp.root, 'docs', '.output', 'victim.json');
        fs.mkdirSync(path.dirname(victim), { recursive: true });
        fs.writeFileSync(victim, JSON.stringify({ category: 'patterns', suggested_id: 'x', content: { leaked: true } }));

        const result = await manager.inboxPromote(badId);
        expect(result.promoted).toBe(false);
        expect(result.error).toMatch(/Invalid inbox id/);
        expect(fs.existsSync(victim)).toBe(true); // never read-then-unlinked
      });
    }
  }); // path-traversal guard (F42)

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

  // ── F44: usage_count read-back from the SQLite index ─────────────────────────

  describe.skipIf(!hasSqlite)('F44 usage_count read-back', () => {

    it('recall bumps usage_count that report/analytics/listMemories all see', async () => {
      // Arrange — usage_count lives ONLY in the SQLite index (_recordRecall bumps
      // it there, never the git-tracked JSON). Before F44 every read path sourced
      // usage_count from the stale JSON (~always 0), so a genuinely-recalled memory
      // read back as never-used and looked like a prune/dead-weight candidate.
      const manager = makeManager();
      await manager.createMemory('patterns', 'readback_mem', { description: 'uniquekiwiF44 read-back token' });

      // Act — a genuine recall (the ONLY place usage_count grows).
      const results = await manager.searchMemories('uniquekiwiF44');
      expect(results.some(r => r.id === 'readback_mem')).toBe(true);

      // Assert — listMemories surfaces the live index value, not the JSON 0.
      const list = await manager.listMemories('patterns');
      const summary = list.find(m => m.id === 'readback_mem');
      expect(summary.usage_count).toBeGreaterThanOrEqual(1);

      // Assert — report total_usage reflects it.
      const report = await manager.generateReport();
      expect(report.categories.patterns.total_usage).toBeGreaterThanOrEqual(1);

      // Assert — analytics: appears in top_used with live count, and is NOT flagged
      // as a prune or dead-weight candidate (both key off usage_count === 0).
      const analytics = await manager.generateAnalytics();
      expect(analytics.usage.top_used.some(u => u.id === 'readback_mem' && u.usage_count >= 1)).toBe(true);
      expect(analytics.prune.candidates.some(c => c.id === 'readback_mem')).toBe(false);
      expect(analytics.dead_weight.candidates.some(c => c.id === 'readback_mem')).toBe(false);
    });

    it('rebuildIndex preserves accumulated usage_count (not reset to 0)', async () => {
      // Arrange — before F44, rebuildIndex re-seeded usage_count from the JSON
      // baseline via INSERT OR REPLACE, destroying accumulated real usage on every
      // rebuild. The pre-DELETE snapshot must carry the live value across the wipe.
      const manager = makeManager();
      await manager.createMemory('patterns', 'rebuild_mem', { description: 'uniquemangoF44 survive rebuild' });

      await manager.searchMemories('uniquemangoF44');
      const before = (await manager.listMemories('patterns')).find(m => m.id === 'rebuild_mem').usage_count;
      expect(before).toBeGreaterThanOrEqual(1);

      // Act
      await manager.rebuildIndex();

      // Assert — the count SURVIVES the rebuild.
      const after = (await manager.listMemories('patterns')).find(m => m.id === 'rebuild_mem').usage_count;
      expect(after).toBe(before);
    });

  }); // F44 usage_count read-back

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
      seedActiveDates(repo, 30, 2024, 'commit day ');

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
        content: { description: 'Has a dangling ref.', note: 'related: ghost-concept' },
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

    // NA5.8 — a retired (invalid_at) memory is history, not a nonexistent id.
    it('lintMemories_referenceToRetiredMemory_notBrokenButMissingIdStillIs', async () => {
      writeFixtureMemory('constraints', 'retired-concept', {
        invalid_at: '2026-10-09T00:00:00.000Z',
        content: { description: 'obsolete recipe' },
        metadata: { invalidation: { reason: 'obsolete', story: 'NA5.M8' } }
      });
      writeFixtureMemory('patterns', 'cites-retired-history', {
        updated: new Date().toISOString(),
        usage_count: 1,
        content: { note: 'See [[retired-concept]] and see: ghost-concept.', references: ['retired-concept'] },
      });
      const manager = makeManager();

      const result = await manager.lintMemories();

      expect(result.checks.broken_refs.findings.map(f => f.referenced_id)).toEqual(['ghost-concept']);
      expect(result.checks.broken_refs.count).toBe(1);
    });

    it('lintMemories_retiredMemory_excludedFromEveryOtherCheckAndTotal', async () => {
      // A retired record that would otherwise be orphaned, stale and low-decay.
      writeFixtureMemory('constraints', 'retired-and-old', {
        invalid_at: '2026-10-09T00:00:00.000Z',
        created: '2019-01-01T00:00:00.000Z',
        updated: '2019-01-01T00:00:00.000Z',
        usage_count: 0,
        content: { description: 'obsolete recipe' },
        metadata: { confidence: 0.1 }
      });
      writeFixtureMemory('patterns', 'live-one', {
        updated: new Date().toISOString(),
        usage_count: 1,
        content: { note: 'related: retired-and-old' },
      });
      const manager = makeManager();

      const result = await manager.lintMemories();

      expect(result.total_memories).toBe(1);
      expect(result.checks.broken_refs.count).toBe(0);
      const mentions = Object.values(result.checks).flatMap(c => c.findings).filter(f => JSON.stringify(f).includes('retired-and-old'));
      expect(mentions).toEqual([]);
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
      seedActiveDates(repo, 30, 2020);

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
      seedActiveDates(repo, 40, 2020);

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

    // NA5.11 — the rebuild is one write transaction that reports exactly what it indexed.
    const memDir = cat => path.join(tmp.root, 'docs', '.output', '.memory', cat);
    const dbFile = () => path.join(tmp.root, 'docs', '.output', '.state', 'memory-index', 'memories.db');
    const statusFile = () => path.join(tmp.root, 'docs', '.output', '.state', 'memory-index', 'rebuild-status.json');
    const countRows = () => {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbFile());
      try {
        return {
          rows: db.prepare('SELECT COUNT(*) AS c FROM memories').get().c,
          fts: db.prepare('SELECT COUNT(*) AS c FROM memories_fts').get().c,
          usage: db.prepare('SELECT usage_count FROM memories').all().map(r => r.usage_count),
        };
      } finally { db.close(); }
    };
    const runCli = args => new Promise(resolve => {
      const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, '../../../.agents/core/memory-manager-cli.js'), ...args], {
        cwd: tmp.root, env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      child.on('close', code => resolve({ code, out }));
    });

    it.skipIf(!hasSqlite)('rebuildIndex_unindexableRecord_countsOnlyIndexedAndWritesStatus', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'good_one', { description: 'first good record' });
      await manager.createMemory('patterns', 'good_two', { description: 'second good record' });
      // A hand-authored record without `created` violates the index's NOT NULL column.
      fs.writeFileSync(path.join(memDir('patterns'), 'no-created.json'), JSON.stringify({ id: 'no-created', type: 'pattern', category: 'patterns', content: { description: 'missing created' }, metadata: { confidence: 1 } }, null, 2));

      const result = await manager.rebuildIndex();

      expect(result.indexed).toBe(2);
      expect(result.failed.map(f => f.file)).toEqual(['patterns/no-created.json']);
      expect(result.failed[0].id).toBe('no-created');
      const status = JSON.parse(fs.readFileSync(statusFile(), 'utf8'));
      expect(status.indexed).toBe(2);
      expect(status.failed.map(f => f.file)).toEqual(['patterns/no-created.json']);
      expect(Number.isNaN(Date.parse(status.completed_at))).toBe(false);
      manager.db.close(); manager.db = null;
      expect(countRows().rows).toBe(2);
    });

    it.skipIf(!hasSqlite)('rebuildIndex_cleanStore_writesStatusWithNoFailures', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'only_one', { description: 'single record' });

      const result = await manager.rebuildIndex();

      expect(result).toEqual({ indexed: 1, failed: [] });
      expect(JSON.parse(fs.readFileSync(statusFile(), 'utf8')).failed).toEqual([]);
    });

    it.each(['{broken', 'null', '[]'])('R1_rebuildIndex_badJson_%s_isNamedInResultStatusAndCli', async raw => {
      if (!hasSqlite) return;
      const manager = makeManager();
      await manager.createMemory('patterns', 'damaged', { description: 'previous usable record' });
      fs.writeFileSync(path.join(memDir('patterns'), 'damaged.json'), raw);

      const result = await manager.rebuildIndex();

      expect(result.indexed).toBe(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({ file: 'patterns/damaged.json', id: null });
      expect(result.failed[0].error).toBeTruthy();
      expect(JSON.parse(fs.readFileSync(statusFile(), 'utf8')).failed).toEqual(result.failed);
      if (raw !== '[]') expect(await manager.listMemories('patterns')).toEqual([]); // preserve summary compatibility
      const cli = await runCli(['rebuild-index']);
      expect(cli.code).toBe(1);
      expect(cli.out).toContain('patterns/damaged.json');
      expect(cli.out).not.toContain('✅ Rebuilt');
    });

    it.skipIf(!hasSqlite)('R1_rebuildIndex_fileReadFailure_isNamedWhileOtherRecordsIndex', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'unreadable', { description: 'blocked record' });
      await manager.createMemory('patterns', 'readable', { description: 'usable record' });
      const original = fs.promises.readFile;
      const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((file, ...args) => {
        if (String(file) === path.join(memDir('patterns'), 'unreadable.json')) {
          return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
        }
        return original(file, ...args);
      });
      let result;
      try { result = await manager.rebuildIndex(); } finally { spy.mockRestore(); }
      expect(result.indexed).toBe(1);
      expect(result.failed).toEqual([expect.objectContaining({ file: 'patterns/unreadable.json', error: expect.stringMatching(/permission denied|EACCES/) })]);
      expect(JSON.parse(fs.readFileSync(statusFile(), 'utf8')).failed).toEqual(result.failed);
    });

    it.skipIf(!hasSqlite)('R1_rebuildIndex_categoryEnumerationFailure_abortsBeforeDeletingPriorRows', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'keep', { description: 'retained prior index' });
      manager.db.prepare('UPDATE memories SET usage_count = 7 WHERE id = ?').run('keep');
      const original = fs.promises.readdir;
      const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((dir, ...args) => {
        if (String(dir) === memDir('patterns')) return Promise.reject(Object.assign(new Error('directory unavailable'), { code: 'EACCES' }));
        return original(dir, ...args);
      });
      let result;
      try { result = await manager.rebuildIndex(); } finally { spy.mockRestore(); }
      expect(result.failed).toEqual([expect.objectContaining({ file: 'patterns/', error: expect.stringMatching(/directory unavailable|EACCES/) })]);
      expect(countRows()).toEqual({ rows: 1, fts: 1, usage: [7] });
      expect(JSON.parse(fs.readFileSync(statusFile(), 'utf8')).failed).toEqual(result.failed);
    });

    it.skipIf(!hasSqlite)('R1_rebuildIndex_absentOptionalCategory_isAnEmptySnapshot', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'keep', { description: 'remaining source' });
      fs.rmdirSync(memDir('constraints'));
      expect(await manager.rebuildIndex()).toEqual({ indexed: 1, failed: [] });
    });

    it.skipIf(!hasSqlite)('rebuildIndex_errorMidRebuild_rollsBackToThePriorCompleteIndex', async () => {
      const manager = makeManager();
      for (const id of ['keep_a', 'keep_b', 'keep_c']) await manager.createMemory('patterns', id, { description: `${id} record` });
      manager.db.prepare('UPDATE memories SET usage_count = 5').run();
      let calls = 0;
      const real = manager.indexMemory.bind(manager);
      vi.spyOn(manager, 'indexMemory').mockImplementation((...a) => { if (++calls === 2) throw new Error('disk full'); return real(...a); });

      await expect(manager.rebuildIndex()).rejects.toThrow('disk full');

      manager.db.close(); manager.db = null;
      const after = countRows();
      expect(after.rows).toBe(3);
      expect(after.fts).toBe(3);
      expect(after.usage).toEqual([5, 5, 5]);
    });

    it.skipIf(!hasSqlite)('rebuildIndex_twoOverlappingProcesses_keepEveryRowAndLiveUsage', async () => {
      const manager = makeManager();
      const N = 120;
      expect(manager.initDb()).toBe(true);
      // Setup still writes every real JSON record and index entry. One commit
      // avoids spending the concurrency test's deadline on hundreds of fsyncs.
      manager.db.exec('BEGIN');
      try {
        for (let i = 0; i < N; i++) {
          expect(await manager.createMemory('patterns', `overlap_${i}`, { description: `overlap record number ${i}` })).not.toBeNull();
        }
        manager.db.exec('COMMIT');
      } catch (error) {
        manager.db.exec('ROLLBACK');
        throw error;
      }
      manager.db.prepare('UPDATE memories SET usage_count = 7').run();
      manager.db.close(); manager.db = null;

      const [a, b] = await Promise.all([runCli(['rebuild-index']), runCli(['rebuild-index'])]);

      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      expect(a.out).not.toMatch(/database is locked/);
      expect(b.out).not.toMatch(/database is locked/);
      const after = countRows();
      expect(after.rows).toBe(N);
      expect(after.fts).toBe(N);
      expect(after.usage.filter(u => u !== 7)).toEqual([]);
    }, 60000);

    it.skipIf(!hasSqlite)('rebuildIndexCli_unindexableRecord_exitsNonZeroAndNamesTheFile', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'good_one', { description: 'good record' });
      manager.db.close(); manager.db = null;
      fs.writeFileSync(path.join(memDir('patterns'), 'no-created.json'), JSON.stringify({ id: 'no-created', type: 'pattern', category: 'patterns', content: { description: 'missing created' }, metadata: { confidence: 1 } }, null, 2));

      const r = await runCli(['rebuild-index']);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/1 memories indexed, 1 failed \(patterns\/no-created\.json\)/);
    }, 30000);

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
    // Writes the full category cap of real memories: 11-12 s alone, 30.18 s under full-suite load; global 30 s unchanged.
    }, 120_000);

    it('capEnvOverride_lowersEffectiveCap', async () => {
      // MP-2.1: MEMORY_MAX_PER_CATEGORY env override changes the effective cap.
      // The cap is a module-load-time const, so reload the module with the env set.
      const origLog = console.log;
      console.log = () => {};
      const modPath = require.resolve('../../../.agents/core/memory-manager');
      const origCap = process.env.MEMORY_MAX_PER_CATEGORY;
      let reloaded;
      try {
        process.env.MEMORY_MAX_PER_CATEGORY = '2';
        delete require.cache[modPath];
        const ReloadedMM = require('../../../.agents/core/memory-manager');
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
        require('../../../.agents/core/memory-manager');
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

    it('searchMemories_recordRecallFalse_doesNotBumpUsageCountOrLogAccess', async () => {
      // F11: diagnostic callers (health-check probe, benchmark, eval --real pass)
      // must be able to search without polluting usage analytics.
      const manager = makeManager();
      if (!manager.initDb()) return;
      await manager.createMemory('patterns', 'diag_probe_mem', { description: 'diagnostic token here' });

      const results = await manager.searchMemories('diagnostic', { recordRecall: false });
      expect(results.length).toBeGreaterThan(0);

      const idxCount = manager.db
        .prepare('SELECT usage_count AS n FROM memories WHERE id = ?').get('diag_probe_mem').n;
      expect(idxCount).toBe(0);

      const logPath = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'memory-injection.jsonl');
      expect(fs.existsSync(logPath)).toBe(false);
    });
  }); // honest usage

  // ── Wave 4A correctness fixes (full-review-260716) ───────────────────────────

  describe('Wave 4A correctness fixes', () => {

    // Seed a memory JSON directly (bypasses createMemory's updated=now stamp so we
    // can control the `updated` date the decay curve reads).
    function seedMem(manager, category, id, overrides = {}) {
      const base = {
        id, type: category.slice(0, -1), category,
        created: '2024-01-01T00:00:00.000Z', updated: '2024-01-01T00:00:00.000Z',
        usage_count: 0, content: { description: 'seed token here' }, metadata: { confidence: 1.0 },
        ...overrides,
      };
      const dir = path.join(manager.memoriesDir, category);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id.replace(/_/g, '-')}.json`), JSON.stringify(base, null, 2));
      return base;
    }

    // ── MEM-1: FTS-path decay uses the per-category RATE, not DEFAULT_RATE ────────
    it.skipIf(!hasSqlite)('MEM-1_ftsPath_decisionsMemory_usesPointNineEightRateNotDefault', async () => {
      // A 30-active-day decisions memory must decay at 0.98^30 (≈0.545), NOT the
      // 0.95 DEFAULT_RATE (0.95^30 ≈ 0.215) it fell back to when mockMemory omitted
      // `category`. Git fixture supplies ~30 active work-days since the 2024-01-01
      // `updated`; rebuildIndex indexes the seeded old-dated memory into FTS.
      const repo = createGitRepo({ root: tmp.root });
      seedActiveDates(repo, 30, 2024);
      const manager = makeManager();
      seedMem(manager, 'decisions', 'mem1_decision', {
        content: { description: 'mem1uniquetoken decisions decay probe' },
      });
      await manager.rebuildIndex(); // index the seeded old-dated memory

      const results = await manager.searchMemories('mem1uniquetoken', { recordRecall: false });
      const hit = results.find(r => r.id === 'mem1_decision');
      expect(hit).toBeTruthy();

      // Precise value: 0.98^30 with tolerance for the ±1 active-day fuzz (mirrors
      // the calculateDecayedConfidence sibling test). Bracket EXCLUDES the wrong
      // 0.95-rate value (0.215) with wide margin.
      const expected = Math.pow(0.98, 30);
      expect(Math.abs(hit.decayed_confidence - expected)).toBeLessThan(0.05);
      expect(hit.decayed_confidence).toBeGreaterThan(0.4); // never the 0.215 over-decay
    });

    // ── MEM-2: JSON-scan search survives a metadata-less hand-authored memory ─────
    it('MEM-2_jsonScan_memoryMissingMetadata_doesNotCrash', async () => {
      const manager = makeManager();
      // Hand-authored minimal record: no metadata, no usage_count, no importance.
      seedMem(manager, 'patterns', 'mem2_bare', {
        metadata: undefined, usage_count: undefined,
        content: { description: 'mem2barewordxyz' },
      });
      // Force the JSON-scan path (the calculateRelevance null-deref site).
      manager.initDb = () => false;

      // Pre-fix this threw a TypeError on memory.metadata.confidence, aborting the
      // whole search. It must now return the memory with a numeric relevance.
      const results = await manager.searchMemories('mem2barewordxyz');
      expect(results.length).toBeGreaterThanOrEqual(1);
      const hit = results.find(r => r.id === 'mem2_bare');
      expect(hit).toBeTruthy();
      expect(typeof hit.relevance).toBe('number');
      expect(Number.isFinite(hit.relevance)).toBe(true);
    });

    it('MEM-2_calculateRelevance_missingMetadataAndUsage_returnsFiniteScore', () => {
      const manager = makeManager();
      // Directly exercise the guarded arithmetic with an object missing both fields.
      const bare = { content: { description: 'token here' }, updated: new Date().toISOString() };
      const score = manager.calculateRelevance(bare, 'token');
      expect(Number.isFinite(score)).toBe(true);
    });

    // ── MEM-4: a clean zero-result FTS query returns [] without a JSON-scan ───────
    it.skipIf(!hasSqlite)('MEM-4_zeroResultFtsQuery_returnsEmpty_withoutJsonScanFallthrough', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem4_present', { description: 'mem4presenttoken' });

      // A valid single-token query that legitimately matches nothing in FTS must NOT
      // fall through to the JSON linear scan (which listMemories drives).
      const listSpy = vi.spyOn(manager, 'listMemories');
      const results = await manager.searchMemories('mem4zzzznomatchzzzz');
      expect(results).toEqual([]);
      // The JSON-scan fallback is the ONLY caller of listMemories inside search —
      // a clean zero-result FTS branch must return [] before reaching it.
      expect(listSpy).not.toHaveBeenCalled();
      listSpy.mockRestore();
    });

    // ── MEM-3: listMemories decay reflects the live-merged usage_count ────────────
    it.skipIf(!hasSqlite)('MEM-3_listMemories_decayConsistentWithMergedUsageCount', async () => {
      // Old-dated memory so decay leaves headroom below the 1.0 cap (usage boost is
      // observable). Recall it several times to accumulate live index usage_count,
      // then confirm the summary's decayed_confidence was computed from that SAME
      // merged usage — not the stale JSON baseline of 0.
      const repo = createGitRepo({ root: tmp.root });
      seedActiveDates(repo, 30, 2024);
      const manager = makeManager();
      seedMem(manager, 'decisions', 'mem3_probe', {
        content: { description: 'mem3uniquetoken decay merge probe' },
      });
      await manager.rebuildIndex();

      await manager.searchMemories('mem3uniquetoken');
      await manager.searchMemories('mem3uniquetoken');
      await manager.searchMemories('mem3uniquetoken');

      const list = await manager.listMemories('decisions', { includeFull: true });
      const summary = list.find(m => m.id === 'mem3_probe');
      expect(summary.usage_count).toBeGreaterThanOrEqual(1); // live index value

      const withMerged = manager.calculateDecayedConfidence({
        ...summary.full, usage_count: summary.usage_count,
      });
      const withStaleZero = manager.calculateDecayedConfidence({
        ...summary.full, usage_count: 0,
      });
      // The summary must equal the merged-usage computation …
      expect(summary.decayed_confidence).toBeCloseTo(withMerged, 10);
      // … and that differs from the stale-usage computation (proving the fix bites).
      expect(withMerged).toBeGreaterThan(withStaleZero);
    });

    // ── MEM-5: supersede signals indexStale when the SQLite update throws ─────────
    it.skipIf(!hasSqlite)('MEM-5_supersede_indexUpdateThrows_returnsIndexStaleWarning', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem5_old', { description: 'wombat token findme' });
      await manager.createMemory('patterns', 'mem5_new', { description: 'wombat token findme better' });
      expect(manager.initDb()).toBe(true);

      // Make every prepared statement in the index-update block throw.
      manager.db.prepare = () => { throw new Error('simulated index failure'); };

      const res = await manager.supersede('patterns', 'mem5_old', 'mem5_new');
      // JSON is still stamped (source of truth), but the caller is warned the index
      // may still surface the memory until a rebuild.
      expect(res.superseded).toBe(true);
      expect(res.indexStale).toBe(true);
      expect(res.warning).toMatch(/index/i);
      // JSON was stamped despite the index failure.
      const oldMem = await manager.readMemory('patterns', 'mem5_old');
      expect(oldMem.invalid_at).toBeTruthy();
      expect(oldMem.superseded_by).toBe('mem5_new');
    });

    it('MEM-5_supersede_indexSucceeds_noIndexStaleFlag', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem5b_old', { description: 'quokka token findme' });
      await manager.createMemory('patterns', 'mem5b_new', { description: 'quokka token findme better' });
      const res = await manager.supersede('patterns', 'mem5b_old', 'mem5b_new');
      expect(res.superseded).toBe(true);
      expect(res.indexStale).toBeUndefined();
      expect(res.warning).toBeUndefined();
    });

    // ── MEM-6: getMemoryCount counts live memories only ──────────────────────────
    it('MEM-6_getMemoryCount_excludesSupersededHistory', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem6_live', { description: 'alpha' });
      await manager.createMemory('patterns', 'mem6_dead', { description: 'beta' });
      await manager.createMemory('patterns', 'mem6_repl', { description: 'gamma' });

      expect(await manager.getMemoryCount('patterns')).toBe(3);

      const res = await manager.supersede('patterns', 'mem6_dead', 'mem6_repl');
      expect(res.superseded).toBe(true);

      // The tombstone file still exists on disk, but the LIVE count drops to 2 —
      // dead history must not eat into the per-category cap.
      expect(await manager.getMemoryCount('patterns')).toBe(2);
      const deadFile = path.join(manager.memoriesDir, 'patterns', 'mem6-dead.json');
      expect(fs.existsSync(deadFile)).toBe(true); // history preserved
    });

    // The cheap path skips JSON.parse for a file that never mentions the key. The JSON
    // files stay the authority, so every shape of `invalid_at` must still count correctly.
    it('MEM-6_getMemoryCount_invalidAtShapes_countOnlyTombstones', async () => {
      const manager = makeManager();
      const dir = path.join(manager.memoriesDir, 'patterns');
      fs.mkdirSync(dir, { recursive: true });
      const write = (name, body) => fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
      write('live-plain.json', { id: 'live-plain', description: 'no tombstone key at all' });
      write('live-prose.json', { id: 'live-prose', description: 'mentions invalid_at in prose only' });
      write('live-null.json', { id: 'live-null', invalid_at: null });
      write('dead-set.json', { id: 'dead-set', invalid_at: '2026-01-01T00:00:00.000Z' });
      fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json "invalid_at"');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored: not a .json file');

      // plain + prose + explicit null are live; the set one is dead; the malformed file is skipped
      expect(await manager.getMemoryCount('patterns')).toBe(3);
    });

    it('MEM-6_getMemoryCount_missingCategory_isZero', async () => {
      expect(await makeManager().getMemoryCount('patterns')).toBe(0);
    });

    it('MEM-6_createMemory_noPrune_scansTheCategoryOnce', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'scan_seed', { description: 'seed' });
      const spy = vi.spyOn(manager, 'getMemoryCount');

      await manager.createMemory('patterns', 'scan_second', { description: 'second' });

      // Below the prune threshold nothing is deleted, so the first count is still exact.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('MEM-6_createMemory_overThresholdAndPruneRan_recountsBeforeDecidingTheCap', async () => {
      const manager = makeManager();
      vi.spyOn(manager, 'getMemoryCount').mockResolvedValueOnce(500).mockResolvedValueOnce(10);
      const prune = vi.spyOn(manager, 'pruneStaleMemories').mockResolvedValue(3);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const created = await manager.createMemory('patterns', 'scan_after_prune', { description: 'fits now' });

      // The prune freed room, so the fresh count (not the stale 500) decides the cap.
      expect(prune).toHaveBeenCalledTimes(1);
      expect(manager.getMemoryCount).toHaveBeenCalledTimes(2);
      expect(created).not.toBeNull();
    });

    it('MEM-6_createMemory_overCapAndNothingPruned_refusesWithoutASecondScan', async () => {
      const manager = makeManager();
      vi.spyOn(manager, 'getMemoryCount').mockResolvedValue(500);
      vi.spyOn(manager, 'pruneStaleMemories').mockResolvedValue(0);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const created = await manager.createMemory('patterns', 'scan_refused', { description: 'no room' });

      // Nothing was deleted, so the store is unchanged since the first scan.
      expect(created).toBeNull();
      expect(manager.getMemoryCount).toHaveBeenCalledTimes(1);
    });

    // ── MEM-8: supersede refuses a non-existent successor ─────────────────────────
    it('MEM-8_supersede_nonexistentSuccessor_refusesWithError', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem8_old', { description: 'seed' });

      const res = await manager.supersede('patterns', 'mem8_old', 'mem8_ghost_successor');
      expect(res.superseded).toBe(false);
      expect(res.error).toMatch(/successor.*not found/i);

      // The old memory must remain LIVE — no dangling superseded_by pointer written.
      const oldMem = await manager.readMemory('patterns', 'mem8_old');
      expect(oldMem.invalid_at == null).toBe(true);
      expect(oldMem.superseded_by == null).toBe(true);
    });

    // ── MEM-8 (wave-4 code review): self-supersede refused ────────────────────────
    it('MEM-8_supersede_selfReference_refusesWithoutStampingInvalidAt', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem8_self', { description: 'seed' });

      const res = await manager.supersede('patterns', 'mem8_self', 'mem8_self');
      expect(res.superseded).toBe(false);
      expect(res.error).toMatch(/cannot supersede itself/i);

      // Must remain LIVE — a self-reference must never stamp its own invalid_at.
      const mem = await manager.readMemory('patterns', 'mem8_self');
      expect(mem.invalid_at == null).toBe(true);
      expect(mem.superseded_by == null).toBe(true);
    });

    // ── class-closure sibling of MEM-3 (wave-4 code review): the JSON-scan
    // fallback path must also score/decay off the live-merged usage_count, not
    // the stale-JSON baseline `.full` carries. ─────────────────────────────────
    it.skipIf(!hasSqlite)('searchMemories_ftsThrows_jsonFallbackUsesLiveMergedUsage', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'json_fallback_a', { description: 'zephyrmarker searchable text alpha' });
      await manager.createMemory('patterns', 'json_fallback_b', { description: 'zephyrmarker searchable text beta' });
      expect(manager.initDb()).toBe(true);

      // Lower confidence below 1.0 on both so the decay ceiling (Math.min(…,1.0))
      // doesn't mask the usage-boost delta this test needs to observe.
      await manager.updateMemory('patterns', 'json_fallback_a', { metadata: { confidence: 0.5 } });
      await manager.updateMemory('patterns', 'json_fallback_b', { metadata: { confidence: 0.5 } });

      // Bump LIVE usage_count for 'a' only, directly in the index (plumbing test,
      // not a genuine-recall test — real recall accounting is covered elsewhere).
      manager.db.prepare('UPDATE memories SET usage_count = usage_count + 5 WHERE id = ?').run('json_fallback_a');

      // Force the FTS branch to throw on every attempt (both the primary and the
      // tokenized-retry query) so searchMemories falls through to the JSON-scan
      // fallback — while non-FTS statements (e.g. _indexUsageMap's SELECT, used
      // by listMemories inside the fallback) keep working normally.
      const origPrepare = manager.db.prepare.bind(manager.db);
      manager.db.prepare = (sql) => {
        if (sql.includes('memories_fts')) throw new Error('simulated FTS failure');
        return origPrepare(sql);
      };

      const results = await manager.searchMemories('zephyrmarker', { recordRecall: false });
      const a = results.find(r => r.id === 'json_fallback_a');
      const b = results.find(r => r.id === 'json_fallback_b');
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();

      // 'a' has live usage_count=5, 'b' has 0 — the stale JSON baseline is 0 for
      // BOTH (usage_count only ever grows in the SQLite index, F44), so if the
      // fallback were still reading `.full`'s stale usage, these would be equal.
      expect(a.relevance).toBeGreaterThan(b.relevance);
      expect(a.decayed_confidence).toBeGreaterThan(b.decayed_confidence);
    });

    // ── MEM-10: importance is a top-level field only (never lingers in content) ────
    it('MEM-10_createMemory_stripsImportanceFromStoredContent', async () => {
      const manager = makeManager();
      const input = { description: 'x', importance: 5 };
      await manager.createMemory('patterns', 'mem10_create', input);

      const mem = await manager.readMemory('patterns', 'mem10_create');
      expect(mem.importance).toBe(5);                       // promoted top-level
      expect(mem.content.importance).toBeUndefined();       // stripped from content
      expect(mem.content.description).toBe('x');            // rest of content intact
      // Caller's input object is NOT mutated.
      expect(input.importance).toBe(5);
    });

    it('MEM-10_updateMemory_repromotesContentImportance_andStrips', async () => {
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem10_update', { description: 'x', importance: 2 });

      const updated = await manager.updateMemory('patterns', 'mem10_update', {
        content: { importance: 5, note: 'n' },
      });
      // Top-level re-promoted, content stripped, other content merged.
      expect(updated.importance).toBe(5);
      expect(updated.content.importance).toBeUndefined();
      expect(updated.content.note).toBe('n');
      expect(updated.content.description).toBe('x');

      // Persisted to disk the same way.
      const onDisk = await manager.readMemory('patterns', 'mem10_update');
      expect(onDisk.importance).toBe(5);
      expect(onDisk.content.importance).toBeUndefined();
    });

    it('MEM-10_updateMemory_legacyContentImportance_promotedOnUpdate', async () => {
      // A legacy record that still carries importance inside content (written before
      // the strip) gets it promoted to top-level on the next update.
      const manager = makeManager();
      seedMem(manager, 'patterns', 'mem10_legacy', {
        importance: undefined,
        content: { description: 'legacy', importance: 4 },
      });
      const updated = await manager.updateMemory('patterns', 'mem10_legacy', {
        metadata: { confidence: 0.9 },
      });
      expect(updated.importance).toBe(4);
      expect(updated.content.importance).toBeUndefined();
    });

    // ── MEM-11: FTS indexes human-readable VALUES, not JSON field names ────────────
    it.skipIf(!hasSqlite)('MEM-11_ftsSearch_fieldNameDoesNotMatch_butValueDoes', async () => {
      const manager = makeManager();
      // 'description'/'evidence'/'confidence' are FIELD NAMES here — they must not be
      // searchable terms. 'mem11phosphorus' is a VALUE — it must be.
      await manager.createMemory('patterns', 'mem11_probe', {
        description: 'mem11phosphorus token',
        evidence: 'some corroborating note',
        confidence: 0.8,
      });

      // Field names must NOT surface the memory (they're no longer indexed).
      const byFieldName = await manager.searchMemories('description', { recordRecall: false });
      expect(byFieldName.some(r => r.id === 'mem11_probe')).toBe(false);
      const byConfidence = await manager.searchMemories('confidence', { recordRecall: false });
      expect(byConfidence.some(r => r.id === 'mem11_probe')).toBe(false);

      // The actual content value still matches.
      const byValue = await manager.searchMemories('mem11phosphorus', { recordRecall: false });
      expect(byValue.some(r => r.id === 'mem11_probe')).toBe(true);
    });

    it.skipIf(!hasSqlite)('MEM-11_ftsSearch_nestedAndArrayStringValues_areIndexed', async () => {
      // collectContentText must recurse into nested objects + string arrays.
      const manager = makeManager();
      await manager.createMemory('patterns', 'mem11_nested', {
        description: 'top level',
        detail: { note: 'mem11nestedtoken' },
        references: ['mem11arraytoken', 'other ref'],
      });

      expect((await manager.searchMemories('mem11nestedtoken', { recordRecall: false }))
        .some(r => r.id === 'mem11_nested')).toBe(true);
      expect((await manager.searchMemories('mem11arraytoken', { recordRecall: false }))
        .some(r => r.id === 'mem11_nested')).toBe(true);
    });

    // ── MEM-12: recall bumps every result's usage_count in one batched UPDATE ──────
    it.skipIf(!hasSqlite)('MEM-12_recall_bumpsAllResultUsageCountsByOne', async () => {
      const manager = makeManager();
      expect(manager.initDb()).toBe(true);
      await manager.createMemory('patterns', 'mem12_a', { description: 'mem12sharedtoken alpha' });
      await manager.createMemory('patterns', 'mem12_b', { description: 'mem12sharedtoken beta' });

      const results = await manager.searchMemories('mem12sharedtoken');
      expect(results.length).toBeGreaterThanOrEqual(2);

      const countOf = (id) => manager.db
        .prepare('SELECT usage_count AS n FROM memories WHERE id = ?').get(id).n;
      // One search = one recall = exactly +1 for BOTH matched ids (the batched UPDATE
      // must hit every result id, not just one).
      expect(countOf('mem12_a')).toBe(1);
      expect(countOf('mem12_b')).toBe(1);
    });

    it('MEM-12_recordRecall_emptyResults_noThrow', async () => {
      const manager = makeManager();
      manager.initDb();
      // An empty result set must be a safe no-op (invalid `IN ()` SQL avoided).
      await expect(manager._recordRecall([])).resolves.toBeUndefined();
    });

  }); // Wave 4A correctness fixes

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
  const { buildFtsQuery } = require('../../../.agents/core/memory-manager');

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
