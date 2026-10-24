'use strict';

/**
 * memory-index-divergence.js — one implementation of "does the derived FTS index
 * still describe the curated JSON store?" for every consumer (consumed by
 * the SessionStart self-heal in session-start-prime.cjs and by memory-health-check).
 *
 * An mtime comparison alone cannot answer it: any incremental index write
 * (createMemory, updateMemory, a recall's usage bump) makes the db newer than every
 * JSON file, so a partial index, or a row whose eligibility went stale after a
 * pulled retirement, reads as "fresh" forever. This compares content instead:
 *
 *   missing           a live record with no index row
 *   staleEligibility  a row whose invalid_at null-ness differs from its record
 *   staleUpdated      a row whose `updated` differs from the record's
 *                     (`updated ?? created`, exactly what indexMemory stores)
 *   orphaned          a live row with no record (deleted from the store)
 *
 * A file that failed the last rebuild (rebuild-status.json, written by
 * MemoryManager.rebuildIndex) and has not changed since is EXCUSED rather than
 * missing, so one unindexable record cannot trigger a rebuild on every session.
 * Ids shared by several records are ambiguous (the index holds one row) and are
 * reported but never count as divergence, for the same reason.
 *
 * Pure apart from readRebuildStatus/readIndexRows; never writes.
 */

const fs = require('fs');
const path = require('path');

const REBUILD_STATUS_FILE = 'rebuild-status.json';

// How long an index open/statement waits on another process's lock (writers in
// MemoryManager, the health check's read-only reader) instead of failing busy.
const INDEX_BUSY_TIMEOUT_MS = 5000;

/** Absolute path of the rebuild status beside the index db. */
function rebuildStatusPath(dbPath) {
    return path.join(path.dirname(dbPath), REBUILD_STATUS_FILE);
}

/**
 * Read the last rebuild's status. Absent or unreadable → nothing excused.
 * @returns {{ completedAtMs: number, failed: Set<string> }} failed = 'category/file.json'
 */
function readRebuildStatus(dbPath) {
    try {
        const status = JSON.parse(fs.readFileSync(rebuildStatusPath(dbPath), 'utf8'));
        const completedAtMs = Date.parse(status.completed_at);
        return {
            completedAtMs: Number.isFinite(completedAtMs) ? completedAtMs : 0,
            failed: new Set((Array.isArray(status.failed) ? status.failed : []).map(f => f && f.file).filter(Boolean)),
        };
    } catch {
        return { completedAtMs: 0, failed: new Set() };
    }
}

/**
 * One query: every index row's eligibility and freshness.
 * @param {object} db - an open node:sqlite DatabaseSync
 * @returns {Map<string, {invalid_at: string|null, updated: string|null}> | null} null when unreadable
 */
function readIndexRows(db) {
    try {
        const rows = new Map();
        for (const r of db.prepare('SELECT id, invalid_at, updated FROM memories').all()) {
            rows.set(r.id, { invalid_at: r.invalid_at ?? null, updated: r.updated ?? null });
        }
        return rows;
    } catch {
        return null;
    }
}

/**
 * Compare store records with index rows.
 *
 * @param {Array<{file: string, id: string, invalid_at: string|null, updated: string|null, created: string|null, mtimeMs: number}>} records
 *        every parsed store record, live AND retired; `file` is 'category/name.json'
 * @param {Map<string, {invalid_at: string|null, updated: string|null}>} rows - readIndexRows()
 * @param {{completedAtMs: number, failed: Set<string>}} [status] - readRebuildStatus()
 */
function indexDivergence(records, rows, status = { completedAtMs: 0, failed: new Set() }) {
    const result = { missing: [], staleEligibility: [], staleUpdated: [], orphaned: [], excused: [], ambiguous: [] };
    const seen = new Map();
    for (const r of records) seen.set(r.id, (seen.get(r.id) || 0) + 1);
    for (const r of records) {
        if (seen.get(r.id) > 1) {
            if (!result.ambiguous.includes(r.id)) result.ambiguous.push(r.id);
            continue;
        }
        const live = !r.invalid_at;
        const row = rows.get(r.id);
        if (!row) {
            if (status.failed.has(r.file) && r.mtimeMs <= status.completedAtMs) result.excused.push(r.file);
            else if (live) result.missing.push(r.id);
            continue;
        }
        if (Boolean(row.invalid_at) !== Boolean(r.invalid_at)) result.staleEligibility.push(r.id);
        if ((row.updated ?? null) !== (r.updated ?? r.created ?? null)) result.staleUpdated.push(r.id);
    }
    for (const [id, row] of rows) {
        if (!row.invalid_at && !seen.has(id)) result.orphaned.push(id);
    }
    return result;
}

/** True when the index no longer describes the store (excused/ambiguous never count). */
function hasDivergence(d) {
    return d.missing.length + d.staleEligibility.length + d.staleUpdated.length + d.orphaned.length > 0;
}

module.exports = {
    REBUILD_STATUS_FILE,
    INDEX_BUSY_TIMEOUT_MS,
    rebuildStatusPath,
    readRebuildStatus,
    readIndexRows,
    indexDivergence,
    hasDivergence,
};
