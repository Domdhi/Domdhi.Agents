// Tests for the inbox pattern (R-A): sub-agents flag draft memories to
// .state/memory-inbox/, Main Agent promotes/discards on return.
//
// Plan: docs/.output/plans/2026-05-11-do-r-a-inbox-pattern.md

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const MemoryManager = require('../memory-manager');
const { createTmpDir } = require('./_helpers/tmp-dir');

let tmp;
let originalEnv;
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

function inboxDir() {
  // Split store (ADR 0006 Am. 2): inbox is transient state → .state/memory-inbox
  // (inboxDir per _lib/memory-paths.js), no longer under the JSON source.
  return path.join(tmp.root, 'docs', '.output', '.state', 'memory-inbox');
}

function writeInboxFile(id, payload) {
  fs.mkdirSync(inboxDir(), { recursive: true });
  const filePath = path.join(inboxDir(), `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function makeDraft(overrides = {}) {
  return {
    category: 'constraints',
    suggested_id: overrides.suggested_id ?? 'sample-constraint',
    content: overrides.content ?? {
      description: 'Sample inbox draft for tests.',
      evidence: 'Added in inbox tests.',
      confidence: 0.7,
    },
    flagged_by: overrides.flagged_by ?? 'general-purpose',
    flagged_at: overrides.flagged_at ?? '2026-05-11T16:45:00Z',
    ...overrides,
  };
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

describe('memory-manager inbox', () => {

  describe('inboxList', () => {

    it('inboxList_emptyDir_returnsEmptyArray', async () => {
      const m = makeManager();
      const result = await m.inboxList();
      expect(result).toEqual([]);
    });

    it('inboxList_threeEntries_returnsAllSorted', async () => {
      writeInboxFile('2026-05-11-1700-c-third', makeDraft({ suggested_id: 'third' }));
      writeInboxFile('2026-05-11-1645-a-first', makeDraft({ suggested_id: 'first' }));
      writeInboxFile('2026-05-11-1655-b-second', makeDraft({ suggested_id: 'second' }));
      const m = makeManager();

      const result = await m.inboxList();

      expect(result).toHaveLength(3);
      // Lex-sorted = chronological
      expect(result[0].id).toBe('2026-05-11-1645-a-first');
      expect(result[1].id).toBe('2026-05-11-1655-b-second');
      expect(result[2].id).toBe('2026-05-11-1700-c-third');
    });

    it('inboxList_includesCategoryAndFlaggedBy', async () => {
      writeInboxFile('2026-05-11-1645-x', makeDraft({
        flagged_by: 'qa-engineer',
        category: 'patterns',
      }));
      const m = makeManager();

      const [entry] = await m.inboxList();

      expect(entry.category).toBe('patterns');
      expect(entry.flagged_by).toBe('qa-engineer');
      expect(entry.id).toBe('2026-05-11-1645-x');
    });

    it('inboxList_skipsNonJsonFiles', async () => {
      fs.mkdirSync(inboxDir(), { recursive: true });
      fs.writeFileSync(path.join(inboxDir(), '.gitkeep'), '');
      fs.writeFileSync(path.join(inboxDir(), 'README.md'), 'docs');
      writeInboxFile('2026-05-11-1700-real', makeDraft());
      const m = makeManager();

      const result = await m.inboxList();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2026-05-11-1700-real');
    });

  });

  describe('inboxPromote', () => {

    it('inboxPromote_happyPath_createsMemoryAndDeletesInboxFile', async () => {
      const filePath = writeInboxFile('2026-05-11-1645-w', makeDraft({
        suggested_id: 'happy-path-promotion',
        category: 'patterns',
        content: { description: 'Promoted from inbox.', confidence: 0.7 },
      }));
      const m = makeManager();

      const result = await m.inboxPromote('2026-05-11-1645-w');

      expect(result.promoted).toBe(true);
      expect(result.category).toBe('patterns');
      expect(result.id).toBe('happy-path-promotion');
      // Inbox file removed
      expect(fs.existsSync(filePath)).toBe(false);
      // Memory created at proper path
      const memory = await m.readMemory('patterns', 'happy-path-promotion');
      expect(memory).not.toBeNull();
      expect(memory.content.description).toBe('Promoted from inbox.');
    });

    it('inboxPromote_categoryOverride_writesToOverrideCategory', async () => {
      writeInboxFile('2026-05-11-1700-w', makeDraft({
        suggested_id: 'wrong-cat-test',
        category: 'patterns',           // agent's guess
        content: { description: 'Should land in constraints.' },
      }));
      const m = makeManager();

      const result = await m.inboxPromote('2026-05-11-1700-w', {
        categoryOverride: 'constraints',
      });

      expect(result.promoted).toBe(true);
      expect(result.category).toBe('constraints');
      const memory = await m.readMemory('constraints', 'wrong-cat-test');
      expect(memory).not.toBeNull();
    });

    it('inboxPromote_idOverride_usesOverrideAsMemoryId', async () => {
      writeInboxFile('2026-05-11-1715-w', makeDraft({
        suggested_id: 'agent-suggested-slug',
        category: 'workflows',
      }));
      const m = makeManager();

      const result = await m.inboxPromote('2026-05-11-1715-w', {
        idOverride: 'curator-renamed-slug',
      });

      expect(result.promoted).toBe(true);
      expect(result.id).toBe('curator-renamed-slug');
      const memory = await m.readMemory('workflows', 'curator-renamed-slug');
      expect(memory).not.toBeNull();
    });

    it('inboxPromote_missingFile_returnsError', async () => {
      const m = makeManager();
      const result = await m.inboxPromote('2026-05-11-9999-nonexistent');
      expect(result.promoted).toBe(false);
      expect(result.error).toMatch(/not found|missing|ENOENT/i);
    });

    it('inboxPromote_malformedJson_returnsError', async () => {
      fs.mkdirSync(inboxDir(), { recursive: true });
      fs.writeFileSync(
        path.join(inboxDir(), '2026-05-11-1730-bad.json'),
        '{this is not valid json',
      );
      const m = makeManager();

      const result = await m.inboxPromote('2026-05-11-1730-bad');

      expect(result.promoted).toBe(false);
      expect(result.error).toMatch(/parse|JSON|malformed/i);
    });

    it('inboxPromote_invalidCategory_returnsError', async () => {
      writeInboxFile('2026-05-11-1745-w', makeDraft({
        category: 'invalid-not-a-real-category',
      }));
      const m = makeManager();

      const result = await m.inboxPromote('2026-05-11-1745-w');

      expect(result.promoted).toBe(false);
      expect(result.error).toMatch(/category/i);
    });

    it('inboxPromote_idCollision_returnsDistinctErrorAndKeepsOriginal', async () => {
      // F10: promoting into an id that already holds a real memory must not
      // silently clobber it — and the error must name the collision, not
      // read as a generic "category full" failure.
      const m = makeManager();
      await m.createMemory('constraints', 'already-taken', { description: 'pre-existing memory' });
      writeInboxFile('2026-05-11-1800-w', makeDraft({
        suggested_id: 'already-taken',
        category: 'constraints',
        content: { description: 'draft trying to land on the same id' },
      }));

      const result = await m.inboxPromote('2026-05-11-1800-w');

      expect(result.promoted).toBe(false);
      expect(result.error).toMatch(/collision/i);
      const onDisk = await m.readMemory('constraints', 'already-taken');
      expect(onDisk.content.description).toBe('pre-existing memory');
    });

    it('inboxPromote_unsafeIdOverride_returnsErrorWithoutThrowing', async () => {
      // F13: inboxPromote's JSDoc promises {promoted:false,error} never-throw —
      // an unsafe derived memoryId must be caught here, not left to createMemory's
      // thrown "Invalid id" error.
      writeInboxFile('2026-05-11-1815-w', makeDraft({ category: 'patterns' }));
      const m = makeManager();

      const result = await m.inboxPromote('2026-05-11-1815-w', {
        idOverride: '../../../escape-attempt',
      });

      expect(result.promoted).toBe(false);
      expect(result.error).toMatch(/invalid.*id/i);
    });

  });

  describe('inboxDiscard', () => {

    it('inboxDiscard_existingFile_deletes', async () => {
      const filePath = writeInboxFile('2026-05-11-1800-w', makeDraft());
      const m = makeManager();

      const result = await m.inboxDiscard('2026-05-11-1800-w');

      expect(result.discarded).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('inboxDiscard_missingFile_returnsError', async () => {
      const m = makeManager();
      const result = await m.inboxDiscard('2026-05-11-9999-nonexistent');
      expect(result.discarded).toBe(false);
      expect(result.error).toMatch(/not found|missing|ENOENT/i);
    });

  });

});
