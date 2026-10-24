/**
 * sqlite-backend.js — the ONE SQLite backend resolution for the memory system (F36).
 *
 * Extracted from memory-manager.js so memory-backup.js stops re-implementing
 * its own probe/preference logic — the backup's corruption gate (the PRAGMA
 * integrity_check that decides whether the last-good mirror may be overwritten)
 * must agree with the store's own reader about which driver is present and
 * healthy, or the two silently diverge.
 *
 * Preference order:
 *   1. node:sqlite (built-in, Node 22+ flagged / 24+ stable) — on Node 24+ this
 *      ships WITH FTS5 compiled in, so full-text search works with ZERO npm
 *      dependencies. Older bundles may not have it, so don't assume either way:
 *      we PROBE FTS5 capability (in-memory CREATE VIRTUAL TABLE ... USING fts5).
 *   2. better-sqlite3 (npm, optionalDependency) — ships its own SQLite compiled
 *      with FTS5. The fallback for Node < 24 (where it leads the order).
 *   3. json-only — no driver; callers fall back to a linear JSON scan.
 *
 * All paths satisfy the same minimal API: new DatabaseSync(path[, {readOnly}]),
 * db.exec(sql), db.prepare(sql).run/get/all, db.close().
 *
 * NOTE: supportsFts5 is a CAPABILITY PROBE, not a backend label. A prior
 * version hardcoded it false for node:sqlite — which produced a misleading
 * health report (search worked fine, but the report claimed FTS5 was
 * unavailable) and sent a whole work session down a phantom "mandatory npm
 * install" remediation. Probe; never assume.
 */

'use strict';

// Probe whether a DatabaseSync constructor can create an FTS5 virtual table.
// Cheap (in-memory), never throws to callers.
function probeFts5(DS) {
  let probe = null;
  try {
    probe = new DS(':memory:');
    probe.exec('CREATE VIRTUAL TABLE _fts5_probe USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    if (probe) { try { probe.close(); } catch { /* non-fatal */ } }
  }
}

// Try to adopt better-sqlite3. `require()` only loads the JS wrapper — the native
// .node binary loads lazily at construction and can fail on an ABI mismatch (a
// better-sqlite3 built for a different Node major). So we PROBE (construct an
// in-memory FTS5 table) before committing; a broken native binding falls through
// instead of silently degrading every later `new DatabaseSync()` to a throw.
// (Known coverage gap: on Node 24+ node:sqlite always wins first, so this branch
// only executes on Node < 24 or a runtime whose built-in sqlite is absent.)
function tryBetterSqlite3() {
  try {
    let BetterSqlite3;
    try { BetterSqlite3 = require('better-sqlite3'); }
    catch {
      // Retain legacy optional-driver installations under .claude/core.
      const legacyCore = require('path').resolve(__dirname, '../../../.claude/core');
      BetterSqlite3 = require(require.resolve('better-sqlite3', { paths: [legacyCore] }));
    }
    // Wrapper normalizes the cross-driver option shape: { readOnly } maps to
    // better-sqlite3's { readonly }.
    const DS = function (dbPath, opts = {}) {
      return new BetterSqlite3(dbPath, opts.readOnly ? { readonly: true } : {});
    };
    if (!probeFts5(DS)) return null; // wrapper loaded but native binding is broken
    return { DatabaseSync: DS, backend: 'better-sqlite3', supportsFts5: true };
  } catch {
    return null;
  }
}

function tryNodeSqlite() {
  try {
    const { DatabaseSync: NodeDatabaseSync } = require('node:sqlite');
    new NodeDatabaseSync(':memory:').close(); // probe: module present & constructs
    const DS = function (dbPath, opts = {}) {
      return new NodeDatabaseSync(dbPath, opts.readOnly ? { readOnly: true } : {});
    };
    // Node 24+ bundles FTS5; older bundles may not. Probe, don't assume.
    return { DatabaseSync: DS, backend: 'node:sqlite', supportsFts5: probeFts5(NodeDatabaseSync) };
  } catch {
    return null;
  }
}

/**
 * Resolve the SQLite backend. On Node 24+, the built-in node:sqlite is
 * preferred — it's zero-dependency and immune to native-ABI fragility. On older
 * Node it is absent or unstable, so better-sqlite3 leads. Either way both
 * branches probe, so a broken candidate is skipped rather than half-adopted.
 *
 * @returns {{ DatabaseSync: Function|null, backend: string, supportsFts5: boolean }}
 *          backend is 'node:sqlite' | 'better-sqlite3' | 'json-only' (DatabaseSync null).
 */
function resolveSqliteBackend() {
  const nodeMajor = Number(process.versions.node.split('.')[0]) || 0;
  const order = nodeMajor >= 24 ? [tryNodeSqlite, tryBetterSqlite3] : [tryBetterSqlite3, tryNodeSqlite];
  for (const attempt of order) {
    const resolved = attempt();
    if (resolved) return resolved;
  }
  return { DatabaseSync: null, backend: 'json-only', supportsFts5: false };
}

/**
 * Resolve a `(dbPath) => db` opener factory, or null when no driver can be
 * loaded — the shape memory-backup.js's integrity gate consumes. Built on the
 * same resolution as the store's own reader, so both always agree on which
 * driver is in play (a driver-missing case stays cleanly separated from a
 * genuine open/integrity failure on the real file).
 *
 * Deliberate trade-off: this inherits the full resolution's FTS5 requirement
 * for better-sqlite3 even though a PRAGMA integrity_check doesn't need FTS5 —
 * an FTS5-less better-sqlite3 (never shipped in practice) reads 'unavailable'
 * here. Accepted: decoupling the opener's adoption predicate would reintroduce
 * the exact manager/backup divergence F36 removed.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.readOnly=false] open databases read-only
 * @returns {((dbPath: string) => object)|null}
 */
function resolveSqliteOpener({ readOnly = false } = {}) {
  const { DatabaseSync } = resolveSqliteBackend();
  if (!DatabaseSync) return null;
  return (dbPath) => new DatabaseSync(dbPath, { readOnly });
}

module.exports = { probeFts5, resolveSqliteBackend, resolveSqliteOpener };
