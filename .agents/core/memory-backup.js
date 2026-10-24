#!/usr/bin/env node
/**
 * memory-backup.js — copy the memory store to an out-of-repo backup location.
 *
 * WHY: the split store (ADR 0006 Am. 2) keeps the curated JSON source at the
 * TRACKED docs/.output/.memory/ — git now protects that — but the rebuilt FTS5
 * index at docs/.output/.state/memory-index/memories.db stays gitignored, and a
 * `git clean -fdx`, in-repo `rm`, disk corruption, or machine loss can still
 * reach the JSON working copy between commits. This mirrors the JSON source to a
 * sibling folder OUTSIDE the repo tree, so a repo-level wipe can't reach it.
 *
 * WHAT IT WRITES (under --to, default `<repo-parent>/_<repo>-memory-backup`):
 *   memories-latest/         — full mirror, refreshed each run (fast restore)
 *   memories-YYYY-MM-DD/     — dated snapshot (corruption today can't clobber
 *                              a good copy from a prior day); pruned to --keep.
 *
 * SAFETY: runs PRAGMA integrity_check on the db first. If the live db is
 * CORRUPT, the "latest" mirror is NOT overwritten (preserving the last-good
 * copy); the suspect state is written to memories-SUSPECT-<stamp>/ and the run
 * exits non-zero so a scheduler surfaces it.
 *
 * RESTORE: copy a backup's memories/ back over docs/.output/.memory/, then
 *   node .claude/core/memory-manager-cli.js rebuild-index     (if you kept json)
 *   node .claude/core/memory-manager-cli.js restore-from-db   (if you kept only the db)
 *
 * USAGE:
 *   node .claude/core/memory-backup.js [--to <dir>] [--keep N] [--no-rotate]
 *     --to <dir>    backup root (default: sibling of the repo, named after it)
 *     --keep N      dated snapshots to retain (default 14)
 *     --no-rotate   skip the dated snapshot + pruning (latest mirror only)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveProjectRoot } = require('./_lib/project-root');
const { memoryPaths } = require('./_lib/memory-paths');
const { resolveSqliteOpener } = require('./_lib/sqlite-backend');

// Worktree-safe: anchor to the MAIN worktree (git-common-dir), not whichever
// linked worktree happens to be current — see _lib/project-root.js header.
const PROJECT_ROOT = resolveProjectRoot(path.resolve(__dirname, '..', '..'));
// Generic default: a sibling of the repo named after it, so no two adopters
// collide and the path carries no machine-specific assumptions.
const DEFAULT_DEST = path.resolve(PROJECT_ROOT, '..', `_${path.basename(PROJECT_ROOT)}-memory-backup`);
const SNAPSHOT_RE = /^memories-\d{4}-\d{2}-\d{2}$/; // strict — pruning only ever touches these

function parseArgs(argv, defaultDest = DEFAULT_DEST) {
  const opts = { to: defaultDest, keep: 14, rotate: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--to' && argv[i + 1]) opts.to = argv[++i];
    else if (argv[i] === '--keep' && argv[i + 1]) {
      // Distinguish garbage (NaN → default 14) from an explicit small/zero value
      // (clamp to a floor of 1) — `|| 14` would wrongly send --keep 0 to 14.
      const n = parseInt(argv[++i], 10);
      opts.keep = Number.isNaN(n) ? 14 : Math.max(1, n);
    } else if (argv[i] === '--no-rotate') opts.rotate = false;
  }
  return opts;
}

/** Local-date stamp (YYYY-MM-DD) — dated snapshot folder name. */
function dateStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Full local stamp for one-off SUSPECT folders. */
function fullStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${dateStamp(d)}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Given existing snapshot dir names and a keep count, return the names to prune
 * (oldest-first beyond `keep`). Pure — the caller does the deletion. Lexical
 * sort == chronological for the YYYY-MM-DD names SNAPSHOT_RE admits.
 */
function snapshotsToPrune(names, keep) {
  const snaps = names.filter((n) => SNAPSHOT_RE.test(n)).sort();
  return snaps.slice(0, Math.max(0, snaps.length - keep));
}

/** PRAGMA integrity_check on the db. Returns 'ok' | '<error text>' | 'unavailable' | 'missing'.
 *
 * The opener comes from _lib/sqlite-backend.js (F36) — the SAME resolution
 * memory-manager.js uses (M7 backend order, construction-probed drivers), so
 * the corruption gate fires on a plain `git clone` (no `npm install`) and a
 * driver-missing case stays cleanly separated from a genuine open/integrity
 * failure on the actual file (which stays a corruption verdict). */
function checkDbIntegrity(dbPath) {
  if (!fs.existsSync(dbPath)) return 'missing';
  const open = resolveSqliteOpener({ readOnly: true });
  if (!open) return 'unavailable'; // no driver at all — skip the check, still back up the bytes
  try {
    const db = open(dbPath);
    try {
      const row = db.prepare('PRAGMA integrity_check').get();
      const val = row && (row.integrity_check ?? Object.values(row)[0]);
      return val === 'ok' ? 'ok' : String(val);
    } finally {
      try { db.close(); } catch { /* non-fatal */ }
    }
  } catch (e) {
    // Driver loaded but opening/checking the real file threw — that is a corruption
    // signal, not a missing driver, so it stays an 'error:' verdict (isCorrupt → true).
    return `error: ${e.message}`;
  }
}

/** True when integrity_check returned an actual corruption verdict (not ok/skipped). */
function isCorrupt(integrity) {
  return !(integrity === 'ok' || integrity === 'unavailable' || integrity === 'missing');
}

/**
 * Replace destDir with a fresh recursive copy of srcDir, atomically (M8).
 *
 * The old rm-then-cp deleted the last-good mirror BEFORE writing the new one, so a
 * crash/kill/disk-full landing mid-copy destroyed the very backup this script
 * exists to protect. Instead: build the full copy in a temp sibling FIRST (the
 * slow step now runs while destDir is still intact — a crash here leaves last-good
 * untouched), then swap it in with a fast rm + rename. renameSync can't overwrite a
 * non-empty dir, hence rm-then-rename; the remaining failure window is two metadata
 * ops rather than the whole copy. destDir is always under the backup root, never
 * the source.
 */
function mirror(srcDir, destDir) {
  const tmpDir = `${destDir}.tmp-${process.pid}`;
  fs.rmSync(tmpDir, { recursive: true, force: true }); // clear any prior aborted run
  fs.cpSync(srcDir, tmpDir, { recursive: true });       // parent of destDir now exists
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, destDir);
}

function countJson(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name.endsWith('.json')) n++;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

function main(argv) {
  // Split store (ADR 0006 Am. 2): mirror the curated JSON source (.memory/);
  // the integrity check runs against the rebuilt db under .state/memory-index/.
  // Sourced from the single accessor (_lib/memory-paths.js) instead of hand-
  // building the paths — keeps this in sync with every other memory script and
  // resolves worktree-safely (jsonRoot via the current worktree since it's
  // TRACKED, dbPath via the main worktree since it's gitignored).
  const paths = memoryPaths(path.resolve(__dirname, '..', '..'));
  const memoriesDir = paths.jsonRoot;
  const dbPath = paths.dbPath;
  const opts = parseArgs(argv);
  const now = new Date();

  if (!fs.existsSync(memoriesDir)) {
    console.error(`✖ Source not found: ${memoriesDir}`);
    process.exit(1);
  }

  const jsonCount = countJson(memoriesDir);
  const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const integrity = checkDbIntegrity(dbPath);

  fs.mkdirSync(opts.to, { recursive: true });

  console.log(`Memory backup`);
  console.log(`  source:    ${memoriesDir}`);
  console.log(`  dest:      ${opts.to}`);
  console.log(`  json files:${jsonCount}   db:${(dbBytes / 1024).toFixed(0)} KB   integrity:${integrity}`);

  if (isCorrupt(integrity)) {
    // Preserve last-good 'latest'; quarantine the suspect bytes; fail loudly.
    const suspectDir = path.join(opts.to, `memories-SUSPECT-${fullStamp(now)}`, 'memories');
    mirror(memoriesDir, suspectDir);
    console.error(`✖ DB integrity FAILED (${integrity}).`);
    console.error(`  'latest' mirror left UNTOUCHED (last-good preserved).`);
    console.error(`  suspect copy → ${path.dirname(suspectDir)}`);
    process.exit(2);
  }

  // 1) latest mirror
  const latestDir = path.join(opts.to, 'memories-latest', 'memories');
  mirror(memoriesDir, latestDir);
  console.log(`  ✓ latest mirror → ${path.dirname(latestDir)}`);

  // 2) dated snapshot + prune
  if (opts.rotate) {
    const snapDir = path.join(opts.to, `memories-${dateStamp(now)}`, 'memories');
    mirror(memoriesDir, snapDir);
    console.log(`  ✓ dated snapshot → ${path.dirname(snapDir)}`);

    const names = fs.readdirSync(opts.to, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    const excess = snapshotsToPrune(names, opts.keep);
    for (const name of excess) {
      fs.rmSync(path.join(opts.to, name), { recursive: true, force: true });
      console.log(`  · pruned old snapshot ${name}`);
    }
    const kept = names.filter((n) => SNAPSHOT_RE.test(n)).length - excess.length;
    if (kept > 0) console.log(`  retained ${kept} dated snapshot(s) (keep=${opts.keep})`);
  }

  console.log(`✅ Backup complete.`);
}

module.exports = {
  parseArgs, dateStamp, fullStamp, snapshotsToPrune, checkDbIntegrity, isCorrupt,
  SNAPSHOT_RE, DEFAULT_DEST, main,
};

if (require.main === module) main(process.argv.slice(2));
