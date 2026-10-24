// AC→source: _lib/sqlite-backend.js — the ONE SQLite backend resolution shared
// by memory-manager.js and memory-backup.js (F36, council-260715-2244). Guards:
// the resolved shape, read-only opener semantics (the backup integrity gate's
// contract), and that both former hosts consume the shared module instead of
// re-implementing their own probe/preference logic.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { probeFts5, resolveSqliteBackend, resolveSqliteOpener } = require('../../../.agents/core/_lib/sqlite-backend');
const { createTmpDir } = require('./_helpers/tmp-dir');

const resolved = resolveSqliteBackend();
const HAS_DRIVER = resolved.DatabaseSync !== null;
let optionalDriver = null;
try { optionalDriver = require('better-sqlite3'); } catch { /* optional dependency */ }

describe('optional better-sqlite3 fallback', () => {
  it.skipIf(!optionalDriver)('uses the real optional driver when built-in SQLite is unavailable', () => {
    const sandbox = {
      module: { exports: {} },
      process: { versions: { node: '22.12.0' } },
      require(name) {
        if (name === 'node:sqlite') throw new Error('built-in unavailable');
        if (name === 'better-sqlite3') return optionalDriver;
        throw new Error(`Unexpected module: ${name}`);
      },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../../../.agents/core/_lib/sqlite-backend'), 'utf8'), sandbox);
    const fallback = sandbox.module.exports.resolveSqliteBackend();
    expect(fallback.backend).toBe('better-sqlite3');
    expect(fallback.supportsFts5).toBe(true);
    const db = new fallback.DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE docs USING fts5(body)');
      db.prepare('INSERT INTO docs(body) VALUES (?)').run('canary memory');
      expect(db.prepare('SELECT body FROM docs WHERE docs MATCH ?').get('canary').body).toBe('canary memory');
    } finally {
      db.close();
    }
  });
});

describe('resolveSqliteBackend()', () => {
  it('returns a coherent shape', () => {
    expect(['node:sqlite', 'better-sqlite3', 'json-only']).toContain(resolved.backend);
    if (resolved.backend === 'json-only') {
      expect(resolved.DatabaseSync).toBeNull();
      expect(resolved.supportsFts5).toBe(false);
    } else {
      expect(typeof resolved.DatabaseSync).toBe('function');
    }
  });

  it.skipIf(!HAS_DRIVER)('supportsFts5 is an honest capability probe', () => {
    // The flag must agree with what the resolved constructor can actually do —
    // the false-negative here once sent a session down a phantom npm-install
    // remediation (see memory-backend-detect.test.js).
    expect(resolved.supportsFts5).toBe(probeFts5(resolved.DatabaseSync));
  });

  it.skipIf(!HAS_DRIVER)('resolved constructor round-trips a real database file', () => {
    const tmp = createTmpDir({ prefix: 'sqlite-backend-' });
    try {
      const dbPath = path.join(tmp.root, 'probe.db');
      const db = new resolved.DatabaseSync(dbPath);
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
      db.close();

      const again = new resolved.DatabaseSync(dbPath);
      expect(again.prepare('SELECT v FROM t').get().v).toBe('hello');
      again.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe('resolveSqliteOpener()', () => {
  it('agrees with resolveSqliteBackend about driver availability', () => {
    const opener = resolveSqliteOpener({ readOnly: true });
    expect(opener === null).toBe(!HAS_DRIVER);
  });

  it.skipIf(!HAS_DRIVER)('readOnly opener reads but refuses writes', () => {
    const tmp = createTmpDir({ prefix: 'sqlite-opener-ro-' });
    try {
      const dbPath = path.join(tmp.root, 'store.db');
      const rw = new resolved.DatabaseSync(dbPath);
      rw.exec('CREATE TABLE t (v TEXT)');
      rw.prepare('INSERT INTO t (v) VALUES (?)').run('kept');
      rw.close();

      const open = resolveSqliteOpener({ readOnly: true });
      const ro = open(dbPath);
      try {
        expect(ro.prepare('SELECT v FROM t').get().v).toBe('kept');
        expect(ro.prepare('PRAGMA integrity_check').get()).toBeTruthy();
        expect(() => ro.exec("INSERT INTO t (v) VALUES ('nope')")).toThrow();
      } finally {
        try { ro.close(); } catch { /* non-fatal */ }
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('F36 dedup guard — both hosts consume the shared module', () => {
  const coreDir = path.resolve(__dirname, '../../../.agents/core');

  it.each(['memory-manager.js', 'memory-backup.js'])('%s requires _lib/sqlite-backend', (file) => {
    const src = fs.readFileSync(path.join(coreDir, file), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/_lib\/sqlite-backend['"]\)/);
  });

  it('memory-backup.js no longer declares its own resolver', () => {
    const src = fs.readFileSync(path.join(coreDir, 'memory-backup.js'), 'utf8');
    expect(src).not.toMatch(/function resolveSqliteOpener\s*\(/);
  });

  it('memory-manager.js no longer declares its own probe/adopt functions', () => {
    const src = fs.readFileSync(path.join(coreDir, 'memory-manager.js'), 'utf8');
    expect(src).not.toMatch(/function probeFts5\s*\(/);
    expect(src).not.toMatch(/function tryBetterSqlite3\s*\(/);
    expect(src).not.toMatch(/function tryNodeSqlite\s*\(/);
  });
});
