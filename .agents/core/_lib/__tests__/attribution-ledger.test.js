// Tests for attribution-ledger.js — cross-subagent change-attribution ledger (S-PI.7).
//
// AC → source map:
//   AC1 (per-run ledger attribution-{date}.jsonl records per-dispatch
//        {story_id, agent, model, files_touched, status}) → appendAttribution + readAttribution
//   AC4 (regression test for the ledger writer — entry shape + append) → this file
//   AC2 (do.md Step 9c / run-todo.md Phase 2 Step 4b append) → [inspection] (command wiring)
//   AC3 (end.md wrap-up surfaces ledger before staging + never-revert guidance) → [inspection]

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir.js');
const { appendAttribution, readAttribution, dateStamp } = require('../../../../.agents/core/_lib/attribution-ledger.js');

let tmp;
let prevEnv;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'attribution-ledger-' });
    prevEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
    if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevEnv;
    tmp.cleanup();
});

describe('appendAttribution', () => {
    it('appendAttribution_validEntry_writesLineWithAll5KeysPlusTimestamp', () => {
        const written = appendAttribution({
            story_id: 'S-PI.7',
            agent: 'general-purpose',
            model: 'opus',
            files_touched: ['a.js', 'b.js'],
            status: 'DONE',
        });
        // returned entry carries the 5 keys + auto timestamp
        expect(written.story_id).toBe('S-PI.7');
        expect(written.agent).toBe('general-purpose');
        expect(written.model).toBe('opus');
        expect(written.files_touched).toEqual(['a.js', 'b.js']);
        expect(written.status).toBe('DONE');
        expect(typeof written.timestamp).toBe('string');
        expect(written.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // persisted and readable back
        const entries = readAttribution();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            story_id: 'S-PI.7',
            agent: 'general-purpose',
            model: 'opus',
            files_touched: ['a.js', 'b.js'],
            status: 'DONE',
        });
        expect(entries[0].timestamp).toBeTruthy();
    });

    it('appendAttribution_twoAppends_accumulateInSameDayFile', () => {
        appendAttribution({ story_id: 'S-1', agent: 'a', model: 'sonnet', files_touched: ['x'], status: 'DONE' });
        appendAttribution({ story_id: 'S-2', agent: 'b', model: 'opus', files_touched: ['y'], status: 'BLOCKED' });
        const entries = readAttribution();
        expect(entries).toHaveLength(2);
        expect(entries.map(e => e.story_id)).toEqual(['S-1', 'S-2']);
    });

    it('appendAttribution_badEntry_doesNotThrow_andCoercesDefaults', () => {
        // null entry — must not throw, must coerce to a well-formed record
        expect(() => appendAttribution(null)).not.toThrow();
        // entry missing files_touched / model — defaults applied
        const written = appendAttribution({ story_id: 7, status: 'DONE' });
        expect(written.story_id).toBe('7');       // coerced to String
        expect(written.model).toBeNull();          // missing → null
        expect(written.agent).toBeNull();
        expect(written.files_touched).toEqual([]); // missing → []
        const entries = readAttribution();
        expect(entries).toHaveLength(2); // null entry + the partial entry both persisted
    });
});

// F1 (council-260715-2244): getProjectRoot() must route through the
// worktree-safe _lib/project-root.js resolveProjectRoot() instead of the naive
// `CLAUDE_PROJECT_DIR || path.resolve(__dirname,...)` fallback — the latter
// anchors the GITIGNORED docs/.output/.state/telemetry ledger to whichever
// worktree happens to be current instead of the shared main worktree.
describe('getProjectRoot routes through resolveProjectRoot (F1 — worktree-safe root)', () => {
    it('invokes resolveProjectRoot() with the module fallbackDir and writes under ITS resolved root, not a naive __dirname fallback', () => {
        const projectRootCachePath = require.resolve('../../../../.agents/core/_lib/project-root.js');
        const ledgerCachePath = require.resolve('../../../../.agents/core/_lib/attribution-ledger.js');
        const savedProjectRoot = require.cache[projectRootCachePath];
        const savedLedger = require.cache[ledgerCachePath];

        // A fake resolved root, distinct from both CLAUDE_PROJECT_DIR (unset in
        // this test) and the real repo path that a naive __dirname fallback
        // would produce. fs writes are spied/no-op'd so this never touches disk
        // regardless of which path the implementation actually resolves.
        // path.resolve makes the fake root platform-absolute ('C:\fake\…' on win32) so
        // the implementation's path.join output still startsWith it — a bare '/fake/…'
        // gets its separators flipped by win32 path.join and the prefix check fails.
        const fakeRoot = path.resolve('/fake/f1-main-worktree-root');
        let calledWithFallback = null;

        require.cache[projectRootCachePath] = {
            id: projectRootCachePath, filename: projectRootCachePath, loaded: true, children: [], paths: [],
            exports: {
                resolveProjectRoot: (fallbackDir) => { calledWithFallback = fallbackDir; return fakeRoot; },
                resolveWorktreeRoot: (fallbackDir) => fallbackDir,
            },
        };
        delete require.cache[ledgerCachePath];

        const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
        const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
        const savedEnv = process.env.CLAUDE_PROJECT_DIR;
        delete process.env.CLAUDE_PROJECT_DIR;

        try {
            const fresh = require('../../../../.agents/core/_lib/attribution-ledger.js');
            fresh.appendAttribution({ story_id: 'S', agent: 'a', model: 'm', files_touched: [], status: 'DONE' });

            expect(calledWithFallback).toBeTruthy(); // resolveProjectRoot() was actually called
            const call = appendSpy.mock.calls.find(([p]) => typeof p === 'string' && p.includes('attribution-'));
            expect(call).toBeTruthy();
            expect(call[0].startsWith(fakeRoot)).toBe(true);
        } finally {
            mkdirSpy.mockRestore();
            appendSpy.mockRestore();
            if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = savedEnv;
            require.cache[projectRootCachePath] = savedProjectRoot;
            if (savedLedger) require.cache[ledgerCachePath] = savedLedger;
            else delete require.cache[ledgerCachePath];
        }
    });
});

describe('readAttribution', () => {
    it('readAttribution_missingFile_returnsEmptyArray', () => {
        // No appends in this fresh tmp root → file does not exist
        expect(readAttribution()).toEqual([]);
    });

    it('readAttribution_explicitDate_isolatesByDayStamp', () => {
        appendAttribution({ story_id: 'S-1', agent: 'a', model: null, files_touched: [], status: 'DONE' });
        // today's stamp returns the entry; an unrelated past stamp returns []
        expect(readAttribution(dateStamp())).toHaveLength(1);
        expect(readAttribution('000101')).toEqual([]);
    });
});
