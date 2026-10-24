// Regression guard for the node:sqlite FTS5 false-negative bug.
//
// Context: memory-manager.js once hardcoded sqliteSupportsFts5 = false for the
// node:sqlite backend (it was only ever set true in the better-sqlite3 branch).
// On Node 24+, node:sqlite ships FTS5 compiled in, so search worked — but the
// REPORT claimed FTS5 was unavailable. That false negative sent a whole work
// session down a phantom "mandatory npm install" remediation. This test asserts
// the report is honest: when the runtime can create an FTS5 virtual table, the
// backend detection must say so.
//
// The test gates on the runtime's ACTUAL FTS5 capability (probed here the same
// way the module does), NOT on a Node version number — so it runs and asserts on
// any runtime that supports FTS5, and skips gracefully where it genuinely can't.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const MemoryManager = require('../../../.agents/core/memory-manager');
const { createTmpDir } = require('./_helpers/tmp-dir');

// Probe FTS5 support directly — mirrors memory-manager.js's own probe.
function runtimeSupportsFts5() {
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
}

const FTS5 = runtimeSupportsFts5();

let tmp;
let originalEnv;
let managers;

function makeManager() {
  const m = new MemoryManager();
  managers.push(m);
  return m;
}

beforeEach(() => {
  managers = [];
  tmp = createTmpDir();
  originalEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
  for (const m of managers) {
    if (m.db) { try { m.db.close(); } catch { /* non-fatal */ } m.db = null; }
  }
  if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalEnv;
  tmp.cleanup();
});

describe('memory backend FTS5 detection', () => {
  it.runIf(FTS5)('reports sqliteSupportsFts5 = true when the runtime supports FTS5', async () => {
    const m = makeManager();
    const report = await m.generateReport();
    expect(report.storage).toBeDefined();
    // The whole point of the regression: this must NOT be a hardcoded false.
    expect(report.storage.sqliteSupportsFts5).toBe(true);
    // node:sqlite (built-in) or better-sqlite3 — both are valid FTS5-capable backends.
    expect(['node:sqlite', 'better-sqlite3']).toContain(report.storage.sqliteBackend);
  });

  it.runIf(FTS5)('search returns FTS5-ranked results (not JSON-fallback-only)', async () => {
    const m = makeManager();
    await m.createMemory('patterns', 'fts-probe-memory', {
      description: 'distinctive zorptastic indexing keyword for fts retrieval',
      importance: 3,
    });
    const results = await m.searchMemories('zorptastic');
    expect(Array.isArray(results)).toBe(true);
    const hit = results.find((r) => r.id === 'fts-probe-memory');
    expect(hit).toBeDefined();
    // FTS5 path attaches a numeric relevance score.
    expect(typeof hit.relevance).toBe('number');
    expect(hit.relevance).toBeGreaterThan(0);
  });

  it.skipIf(FTS5)('skips FTS5 assertions when the runtime genuinely lacks FTS5', () => {
    // Documented no-op: on a runtime without FTS5 (e.g. old Node, no better-sqlite3),
    // search degrades to a JSON scan and these assertions don't apply.
    expect(FTS5).toBe(false);
  });
});
