// AC→source: memory-backup.js — out-of-repo backup of the gitignored memory store.
// Covers the pure arg/stamp/prune/integrity-classification helpers. The fs mirror
// + rotation IO is integration-only.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('./_helpers/tmp-dir');
const { parseArgs, dateStamp, fullStamp, snapshotsToPrune, isCorrupt, SNAPSHOT_RE, DEFAULT_DEST } = require('../../../.agents/core/memory-backup');

describe('parseArgs', () => {
  it('defaults: dest, keep=14, rotate=true', () => {
    const o = parseArgs([]);
    expect(o.to).toBe(DEFAULT_DEST);
    expect(o.keep).toBe(14);
    expect(o.rotate).toBe(true);
  });
  it('honors --to, --keep, --no-rotate', () => {
    const o = parseArgs(['--to', '/tmp/bk', '--keep', '5', '--no-rotate']);
    expect(o.to).toBe('/tmp/bk');
    expect(o.keep).toBe(5);
    expect(o.rotate).toBe(false);
  });
  it('clamps a bad --keep to a sane floor of 1', () => {
    expect(parseArgs(['--keep', '0']).keep).toBe(1);
    expect(parseArgs(['--keep', 'abc']).keep).toBe(14);
  });
});

describe('DEFAULT_DEST', () => {
  it('is a repo-derived sibling path, not a machine-specific literal', () => {
    expect(DEFAULT_DEST).toMatch(/_[^/\\]+-memory-backup$/);
    expect(DEFAULT_DEST).not.toMatch(/_legacy-backup/);
  });
});

describe('date stamps', () => {
  const d = new Date(2026, 5, 21, 9, 7, 3); // local 2026-06-21 09:07:03
  it('dateStamp is zero-padded YYYY-MM-DD', () => {
    expect(dateStamp(d)).toBe('2026-06-21');
    expect(SNAPSHOT_RE.test(`memories-${dateStamp(d)}`)).toBe(true);
  });
  it('fullStamp appends HHMMSS', () => {
    expect(fullStamp(d)).toBe('2026-06-21_090703');
  });
});

describe('snapshotsToPrune', () => {
  it('keeps the newest N, returns the oldest excess (chronological by name)', () => {
    const names = [
      'memories-2026-06-18', 'memories-2026-06-19', 'memories-2026-06-20', 'memories-2026-06-21',
      'memories-latest', 'memories-SUSPECT-2026-06-20_010101', 'random',
    ];
    expect(snapshotsToPrune(names, 2)).toEqual(['memories-2026-06-18', 'memories-2026-06-19']);
  });
  it('never touches non-snapshot dirs (latest / SUSPECT / junk)', () => {
    expect(snapshotsToPrune(['memories-latest', 'memories-SUSPECT-x', 'foo'], 1)).toEqual([]);
  });
  it('returns nothing when under the keep limit', () => {
    expect(snapshotsToPrune(['memories-2026-06-21'], 14)).toEqual([]);
  });
});

describe('isCorrupt', () => {
  it('treats ok / unavailable / missing as NOT corrupt (still backs up)', () => {
    expect(isCorrupt('ok')).toBe(false);
    expect(isCorrupt('unavailable')).toBe(false);
    expect(isCorrupt('missing')).toBe(false);
  });
  it('treats any real verdict as corrupt', () => {
    expect(isCorrupt('error: malformed')).toBe(true);
    expect(isCorrupt('*** in database main ***')).toBe(true);
  });
});

// F37 (council-260715-2244): main() must source its memory/db paths from
// _lib/memory-paths.js's memoryPaths() (built on the worktree-safe
// _lib/project-root.js resolvers) instead of hand-building
// `path.join(PROJECT_ROOT, 'docs', '.output', '.memory')` /
// `.../memory-index/memories.db` — the naive hand-built form reintroduces the
// git-worktree memory-loss bug that memory-paths.js/project-root.js exist to
// fix (see project memory `worktree-root-retrofit-must-sweep-all-callsites`).
describe('main() routes memory/db paths through _lib/memory-paths.js (F37)', () => {
  it('sources memoriesDir/dbPath from memoryPaths(), not a hand-built docs/.output path', () => {
    const memoryPathsCachePath = require.resolve('../../../.agents/core/_lib/memory-paths');
    const projectRootCachePath = require.resolve('../../../.agents/core/_lib/project-root');
    const memoryBackupCachePath = require.resolve('../../../.agents/core/memory-backup');
    const savedMemoryPaths = require.cache[memoryPathsCachePath];
    const savedProjectRoot = require.cache[projectRootCachePath];
    const savedMemoryBackup = require.cache[memoryBackupCachePath];

    const tmp = createTmpDir({ prefix: 'memory-backup-f37-' });
    tmp.write('src/.memory/patterns/x.json', '{"marker":"f37"}');
    const jsonRoot = path.join(tmp.root, 'src', '.memory');
    const dbPath = path.join(tmp.root, 'src', '.state', 'memory-index', 'memories.db');
    const destDir = path.join(tmp.root, 'dest');

    let calledWithFallback = null;

    require.cache[memoryPathsCachePath] = {
      id: memoryPathsCachePath, filename: memoryPathsCachePath, loaded: true, children: [], paths: [],
      exports: {
        memoryPaths: (fallbackDir) => {
          calledWithFallback = fallbackDir;
          return {
            jsonRoot, dbPath,
            inboxDir: '', dailyDir: '', conceptsDir: '', pendingDir: '', extractedDir: '', stateRoot: '',
          };
        },
      },
    };
    require.cache[projectRootCachePath] = {
      id: projectRootCachePath, filename: projectRootCachePath, loaded: true, children: [], paths: [],
      exports: {
        resolveProjectRoot: (fallbackDir) => fallbackDir,
        resolveWorktreeRoot: (fallbackDir) => fallbackDir,
      },
    };
    delete require.cache[memoryBackupCachePath];

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const fresh = require('../../../.agents/core/memory-backup');
      fresh.main(['--to', destDir, '--no-rotate']);

      expect(calledWithFallback).toBeTruthy(); // memoryPaths() was actually invoked
      expect(
        fs.existsSync(path.join(destDir, 'memories-latest', 'memories', 'patterns', 'x.json'))
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      require.cache[memoryPathsCachePath] = savedMemoryPaths;
      require.cache[projectRootCachePath] = savedProjectRoot;
      if (savedMemoryBackup) require.cache[memoryBackupCachePath] = savedMemoryBackup;
      else delete require.cache[memoryBackupCachePath];
      tmp.cleanup();
    }
  });
});
