// Test suite for memory-eval.js — the retrieval-accuracy (hit@k) harness.
//
// SCOPE NOTE: this harness has NO model/LLM/network seam. Despite the task
// framing it as a "model-invocation" path, the only external dependency is
// MemoryManager.searchMemories() (FTS5 on Node 24+, else JSON linear scan) over
// a LOCAL temp store. Every test below is therefore fully offline and
// deterministic by construction — there is nothing to stub for network reasons.
// We exercise the REAL imported functions (no re-implementations): the pure
// scoring math (hitAtK), the store-backed pass (runPass / makeManager /
// seedTempStores), the report formatter (printReport), and the full main() eval
// path against the bundled fixture in a tmp store, with process.argv / console /
// process.exit stubbed only to drive and observe the run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const memEval = require('../../../.agents/core/memory-eval');
const {
    loadFixture,
    DEFAULT_QUERIES,
    FIXTURE_PATH,
    hitAtK,
    runPass,
    makeManager,
    seedTempStores,
    printReport,
    main,
} = memEval;

const { createTmpDir } = require('./_helpers/tmp-dir');

// ─── Shared sandbox: each test gets a fresh CLAUDE_PROJECT_DIR + console capture ─

let tmp;
let originalEnv;
let originalArgv;
let logSpy;
let errSpy;
// Track managers built via makeManager/seedTempStores so we can close SQLite
// handles before cleanup (Windows EPERM on locked .db).
let managersToClose = [];

function trackManager(m) {
    managersToClose.push(m);
    return m;
}

function closeTracked() {
    for (const m of managersToClose) {
        if (m && m.db) {
            try { m.db.close(); } catch { /* non-fatal */ }
            m.db = null;
        }
    }
    managersToClose = [];
}

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'memory-eval-test-' });
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    originalArgv = process.argv;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    managersToClose = [];
});

afterEach(() => {
    closeTracked();
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.argv = originalArgv;
    if (originalEnv === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
    } else {
        process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    tmp.cleanup();
});

// Collect everything written to console.log across a run into one string.
function loggedText() {
    return logSpy.mock.calls.map(c => c.join(' ')).join('\n');
}

// ─── loadFixture ────────────────────────────────────────────────────────────

describe('loadFixture', () => {
    it('loads the bundled external fixture (present in the workshop)', () => {
        // FIXTURE_PATH points at the real bundled fixture; it exists in this repo.
        expect(fs.existsSync(FIXTURE_PATH)).toBe(true);
        const fixture = loadFixture();
        expect(Array.isArray(fixture)).toBe(true);
        expect(fixture.length).toBeGreaterThan(0);
        // Each entry must carry query + expected[].
        for (const entry of fixture) {
            expect(typeof entry.query).toBe('string');
            expect(Array.isArray(entry.expected)).toBe(true);
        }
    });

    it('parses the explicit external fixture when given its path', () => {
        const data = loadFixture(FIXTURE_PATH);
        expect(data[0]).toHaveProperty('query');
        expect(data[0]).toHaveProperty('expected');
    });

    it('falls back to inlined DEFAULT_QUERIES when the fixture is missing', () => {
        const missing = path.join(tmp.root, 'does-not-exist.json');
        const data = loadFixture(missing);
        expect(data).toBe(DEFAULT_QUERIES);
        expect(loggedText()).toContain('fixture not present');
    });

    it('process.exits(1) on a present-but-malformed fixture (not an array)', () => {
        const badPath = path.join(tmp.root, 'bad-object.json');
        fs.writeFileSync(badPath, JSON.stringify({ not: 'an array' }));
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`__exit__${code}`);
        });
        try {
            expect(() => loadFixture(badPath)).toThrow('__exit__1');
            const errText = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
            expect(errText).toContain('present but unreadable');
        } finally {
            exitSpy.mockRestore();
        }
    });

    it('process.exits(1) on a present-but-invalid-JSON fixture', () => {
        const badPath = path.join(tmp.root, 'bad-syntax.json');
        fs.writeFileSync(badPath, '{ this is not json');
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`__exit__${code}`);
        });
        try {
            expect(() => loadFixture(badPath)).toThrow('__exit__1');
        } finally {
            exitSpy.mockRestore();
        }
    });
});

// ─── DEFAULT_QUERIES / FIXTURE_PATH shape ─────────────────────────────────────

describe('DEFAULT_QUERIES + FIXTURE_PATH', () => {
    it('DEFAULT_QUERIES is a non-empty array of {query, expected[]} pairs', () => {
        expect(Array.isArray(DEFAULT_QUERIES)).toBe(true);
        expect(DEFAULT_QUERIES.length).toBeGreaterThan(0);
        for (const q of DEFAULT_QUERIES) {
            expect(typeof q.query).toBe('string');
            expect(Array.isArray(q.expected)).toBe(true);
            expect(q.expected.length).toBeGreaterThan(0);
        }
    });

    it('FIXTURE_PATH points under __tests__/_fixtures', () => {
        expect(FIXTURE_PATH).toContain(path.join('__tests__', '_fixtures'));
        expect(FIXTURE_PATH.endsWith('memory-eval-queries.json')).toBe(true);
    });
});

// ─── hitAtK (pure scoring math) ───────────────────────────────────────────────

describe('hitAtK', () => {
    const results = [
        { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ];

    it('returns true when an expected id is within the top-k window', () => {
        expect(hitAtK(results, ['b'], 3)).toBe(true);
    });

    it('returns false when the expected id is outside the top-k window', () => {
        // 'd' is at index 3 — outside top-3.
        expect(hitAtK(results, ['d'], 3)).toBe(false);
    });

    it('returns true when the expected id is exactly at position k', () => {
        // 'd' at index 3 is included when k=4.
        expect(hitAtK(results, ['d'], 4)).toBe(true);
    });

    it('treats expected as an OR set — any one match is a hit', () => {
        expect(hitAtK(results, ['zzz', 'c'], 3)).toBe(true);
    });

    it('returns false on empty results', () => {
        expect(hitAtK([], ['a'], 3)).toBe(false);
    });

    it('returns false when no expected id appears at all', () => {
        expect(hitAtK(results, ['nope'], 3)).toBe(false);
    });

    it('honors k=1 (only the single top result counts)', () => {
        expect(hitAtK(results, ['a'], 1)).toBe(true);
        expect(hitAtK(results, ['b'], 1)).toBe(false);
    });
});

// ─── makeManager ──────────────────────────────────────────────────────────────

describe('makeManager', () => {
    it('binds the manager to the given storeDir and restores env afterward', () => {
        const storeDir = path.join(tmp.root, 'store-a');
        fs.mkdirSync(storeDir, { recursive: true });
        // env currently points at tmp.root (set in beforeEach).
        const before = process.env.CLAUDE_PROJECT_DIR;
        const mgr = trackManager(makeManager(storeDir));
        expect(mgr).toBeTruthy();
        expect(typeof mgr.searchMemories).toBe('function');
        // The manager's store dir must be under storeDir, not tmp.root.
        expect(mgr.memoriesDir).toContain(storeDir);
        // env must be restored to its pre-call value.
        expect(process.env.CLAUDE_PROJECT_DIR).toBe(before);
    });

    it('restores a previously-undefined CLAUDE_PROJECT_DIR to undefined', () => {
        delete process.env.CLAUDE_PROJECT_DIR;
        const storeDir = path.join(tmp.root, 'store-b');
        fs.mkdirSync(storeDir, { recursive: true });
        const mgr = trackManager(makeManager(storeDir));
        expect(mgr.memoriesDir).toContain(storeDir);
        expect(process.env.CLAUDE_PROJECT_DIR).toBeUndefined();
        // Restore for afterEach symmetry (afterEach handles cleanup regardless).
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
    });
});

// ─── seedTempStores + runPass (store-backed, offline) ─────────────────────────

describe('seedTempStores + runPass', () => {
    it('seeds pruned + noisy stores and runs a measurable eval pass', async () => {
        const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-eval-seed-'));
        try {
            const { prunedManager, noisyManager } = await seedTempStores(seedRoot);
            trackManager(prunedManager);
            trackManager(noisyManager);

            expect(prunedManager).toBeTruthy();
            expect(noisyManager).toBeTruthy();

            const queries = DEFAULT_QUERIES;

            // Pruned pass: superseded history is deindexed, so correct answers
            // should rank well. We assert structure + that at least one query hits
            // (the real FTS / JSON-scan backend is deterministic for a fixed store).
            const pruned = await runPass(prunedManager, queries, 3, false);
            expect(pruned.total).toBe(queries.length);
            expect(pruned.perQuery).toHaveLength(queries.length);
            for (const pq of pruned.perQuery) {
                expect(pq).toHaveProperty('query');
                expect(pq).toHaveProperty('expected');
                expect(pq).toHaveProperty('topK');
                expect(pq).toHaveProperty('hit');
                expect(Array.isArray(pq.topK)).toBe(true);
                expect(pq.topK.length).toBeLessThanOrEqual(3);
            }
            expect(pruned.hits).toBeGreaterThan(0);
            expect(pruned.hits).toBeLessThanOrEqual(pruned.total);

            // Noisy pass: same queries against the keep-everything store.
            const noisy = await runPass(noisyManager, queries, 3, false);
            expect(noisy.total).toBe(queries.length);

            // Core methodology claim: a well-managed (pruned) store retrieves at
            // least as accurately as the noisy one.
            expect(pruned.hits).toBeGreaterThanOrEqual(noisy.hits);
        } finally {
            closeTracked();
            fs.rmSync(seedRoot, { recursive: true, force: true });
        }
    });

    it('runPass honors the includeSuperseded flag without throwing', async () => {
        const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-eval-seed2-'));
        try {
            // seedTempStores opens BOTH managers; track both so closeTracked()
            // releases every SQLite handle before rmSync (an untracked open handle
            // locks the .db file and fails the cleanup with EPERM on Windows).
            const { prunedManager, noisyManager } = await seedTempStores(seedRoot);
            trackManager(prunedManager);
            trackManager(noisyManager);
            const withSuperseded = await runPass(prunedManager, DEFAULT_QUERIES, 3, true);
            expect(withSuperseded.total).toBe(DEFAULT_QUERIES.length);
            expect(withSuperseded.perQuery).toHaveLength(DEFAULT_QUERIES.length);
        } finally {
            closeTracked();
            fs.rmSync(seedRoot, { recursive: true, force: true });
        }
    });
});

// ─── printReport (formatter — all delta branches) ─────────────────────────────

describe('printReport', () => {
    function passResult(hits, total, perQuery) {
        return { hits, total, perQuery };
    }

    it('prints the IMPROVED branch when pruned beats noisy (delta > 0)', () => {
        const pruned = passResult(2, 2, [
            { query: 'q1', expected: ['x'], topK: ['x'], hit: true },
            { query: 'q2', expected: ['y'], topK: ['y'], hit: true },
        ]);
        const noisy = passResult(1, 2, [
            { query: 'q1', expected: ['x'], topK: ['x'], hit: true },
            { query: 'q2', expected: ['y'], topK: ['z'], hit: false },
        ]);
        printReport(pruned, noisy, 3);
        const out = loggedText();
        expect(out).toContain('hit@3');
        expect(out).toContain('IMPROVED retrieval accuracy');
        // Noisy-store miss breakdown should list the failing query.
        expect(out).toContain('NOISY store misses');
    });

    it('prints the no-difference branch when delta == 0', () => {
        const same = passResult(1, 2, [
            { query: 'q1', expected: ['x'], topK: ['x'], hit: true },
            { query: 'q2', expected: ['y'], topK: ['z'], hit: false },
        ]);
        printReport(same, { ...same, perQuery: [...same.perQuery] }, 3);
        const out = loggedText();
        expect(out).toContain('No accuracy difference observed');
    });

    it('prints the DEGRADED branch when pruned is worse than noisy (delta < 0)', () => {
        const pruned = passResult(0, 2, [
            { query: 'q1', expected: ['x'], topK: ['z'], hit: false },
            { query: 'q2', expected: ['y'], topK: ['z'], hit: false },
        ]);
        const noisy = passResult(2, 2, [
            { query: 'q1', expected: ['x'], topK: ['x'], hit: true },
            { query: 'q2', expected: ['y'], topK: ['y'], hit: true },
        ]);
        printReport(pruned, noisy, 3);
        const out = loggedText();
        expect(out).toContain('DEGRADED retrieval accuracy');
    });

    it('truncates a very long query label in the per-query breakdown', () => {
        const longQuery = 'x'.repeat(80);
        const pruned = passResult(0, 1, [
            { query: longQuery, expected: ['a'], topK: [], hit: false },
        ]);
        printReport(pruned, pruned, 3);
        const out = loggedText();
        // Truncated form ends with an ellipsis and shows the no-results marker.
        expect(out).toContain('...');
        expect(out).toContain('(no results)');
    });

    it('handles an all-pass noisy store (no miss-breakdown section)', () => {
        const allPass = passResult(2, 2, [
            { query: 'q1', expected: ['x'], topK: ['x'], hit: true },
            { query: 'q2', expected: ['y'], topK: ['y'], hit: true },
        ]);
        printReport(allPass, allPass, 1);
        const out = loggedText();
        expect(out).not.toContain('NOISY store misses');
    });
});

// ─── main() — full eval path, in-process, offline ─────────────────────────────

describe('main (full eval path against the bundled fixture)', () => {
    it('runs the self-seeding demo to completion and prints a report', async () => {
        process.argv = ['node', 'memory-eval.js'];
        await main();
        const out = loggedText();
        expect(out).toContain('Self-seeding demo');
        expect(out).toContain('Memory Retrieval Accuracy');
        expect(out).toContain('Cleaned up temp dir');
        // No fatal error path was hit.
        expect(errSpy).not.toHaveBeenCalled();
    });

    it('runs --k 5 (k>1) and also emits the sharper hit@1 demonstration', async () => {
        process.argv = ['node', 'memory-eval.js', '--seed', '--k', '5'];
        await main();
        const out = loggedText();
        expect(out).toContain('hit@5');
        expect(out).toContain('Also running hit@1');
        expect(out).toContain('hit@1');
    });

    it('evaluates the real project store with --real without throwing', async () => {
        // Point the "real" store at our isolated tmp dir so we never touch the
        // developer's actual memory store. main() with --real constructs a
        // MemoryManager() that reads CLAUDE_PROJECT_DIR (= tmp.root here).
        process.argv = ['node', 'memory-eval.js', '--real'];
        await main();
        const out = loggedText();
        expect(out).toContain('Using real store at');
        expect(out).toContain('pruned pass');
        expect(out).toContain('keep-everything pass');
        // Track the manager main() created so its db handle is closed. main()
        // already closes managers in its finally block, so this is belt-and-braces.
    });

    it('rejects a non-numeric --k via process.exit(1)', async () => {
        process.argv = ['node', 'memory-eval.js', '--k', 'abc'];
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`__exit__${code}`);
        });
        try {
            await expect(main()).rejects.toThrow('__exit__1');
            const errText = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
            expect(errText).toContain('--k must be a positive integer');
        } finally {
            exitSpy.mockRestore();
        }
    });

    it('rejects --k 0 (below the positive-integer floor)', async () => {
        process.argv = ['node', 'memory-eval.js', '--k', '0'];
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`__exit__${code}`);
        });
        try {
            await expect(main()).rejects.toThrow('__exit__1');
        } finally {
            exitSpy.mockRestore();
        }
    });
});
