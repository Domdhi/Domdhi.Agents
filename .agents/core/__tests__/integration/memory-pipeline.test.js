/**
 * TDD-6.1 — Memory Pipeline End-to-End Integration Test
 *
 * AC → Stage map:
 *   AC-1  Stage 1  Seed 3 daily log files (backdated before 2026-04-12) via daily-log-fixture
 *   AC-2  Stage 2  Run MemoryCompiler.compile() → assert concept files land in concepts/
 *   AC-3  Stage 3  Run MemoryPromoter.scan({top: 5}) → assert 5 ranked concepts returned
 *   AC-4  Stage 4  Seed 3 memories via MemoryManager.createMemory (simulating promotion)
 *   AC-5  Stage 5  Run MemoryBenchmark.benchmark() with mocked Haiku → assert JSONL records,
 *                  hit: true for seeded slugs
 *   AC-6  Stage 6  Run MemoryBenchmark.report() → assert output includes non-zero hit rate
 *
 * Critical constraints:
 *   - Daily log dates must be before 2026-04-12 (MemoryBenchmark.MIN_AGE_DAYS = 7, today 2026-04-19)
 *   - MemoryPromoter.isEligible requires sources.length >= 2
 *   - MemoryPromoter.CATEGORIES does NOT include 'rejected-approaches'
 *   - MemoryBenchmark needs createConceptIndex before benchmark() (readIndexMd must return non-null)
 *   - Spy on instance methods bench.checkClaudeCli / bench.invokeModel — not execSync
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fs = require('node:fs');

const MemoryCompiler  = require('../../../../.agents/core/memory-compiler');
const MemoryPromoter  = require('../../../../.agents/core/memory-promoter');
const MemoryManager   = require('../../../../.agents/core/memory-manager');
const MemoryBenchmark = require('../../../../.agents/core/memory-benchmark');

const { createTmpDir }                         = require('../_helpers/tmp-dir');
const { createDailyLog }                       = require('../_helpers/daily-log-fixture');
const { createConcept, createConceptIndex }    = require('../_helpers/concept-fixture');
const { buildEnvelope }                        = require('../_helpers/claude-mock');

// ─── Per-test sandbox ────────────────────────────────────────────────────────

let tmp;
let origProjectDir;
const managers = [];

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'mem-pipeline-' });
    origProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
    // Close any opened SQLite DB handles to avoid resource leaks
    for (const m of managers) {
        if (m.db) {
            try { m.db.close(); } catch { /* non-fatal */ }
            m.db = null;
        }
    }
    managers.length = 0;

    vi.restoreAllMocks();

    if (origProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origProjectDir;

    tmp.cleanup();
});

// ─── Integration test ─────────────────────────────────────────────────────────

describe('Memory Pipeline Integration', () => {
    it('fullPipeline_seedsCompilesPromotesBenchmarks_producesHits', async () => {

        // ── Stage 1: Seed 3 daily logs (backdated before 2026-04-12) ──────────
        // Use January dates — well clear of the MIN_AGE_DAYS=7 cutoff from 2026-04-19.
        // Each log covers a distinct topic so the compiler produces distinct concept groups.

        // Seed 12 entries across 3 files so MemoryBenchmark.sampleEntries caps at 10
        // (MAX_ENTRIES_PER_RUN = 10). AC requires JSONL records to contain 10 entries.
        const makeEntry = (time, trigger, branch, commitHash, commitMsg, storyId, decision) => ({
            time, trigger, branch,
            commits: [{ hash: commitHash, message: commitMsg }],
            inProgress: [storyId],
            decisions: [decision],
        });

        createDailyLog(tmp, '2026-01-01', [
            makeEntry('09:00', 'Stop',           'feature/authentication', 'aaa1111', 'feat: add JWT authentication middleware',    'Story 1.1: Auth flow',        'Use JWT tokens for session management'),
            makeEntry('11:30', 'Pre-Compaction', 'feature/authentication', 'aaa2222', 'feat: add session token refresh logic',      'Story 1.2: Refresh tokens',   'Store refresh tokens in httpOnly cookies'),
            makeEntry('14:00', 'Stop',           'feature/authentication', 'aaa3333', 'feat: add password hashing with argon2',     'Story 1.3: Password hash',    'Use argon2 for password hashing'),
            makeEntry('16:30', 'Pre-Compaction', 'feature/authentication', 'aaa4444', 'feat: add rate limiting on auth endpoints',  'Story 1.4: Rate limit auth',  'Rate-limit auth endpoints to 10/min'),
        ]);

        createDailyLog(tmp, '2026-01-02', [
            makeEntry('10:00', 'Stop',           'feature/caching', 'bbb1111', 'feat: add Redis cache layer for API responses', 'Story 2.1: Cache layer',       'Use Redis for distributed caching'),
            makeEntry('12:00', 'Pre-Compaction', 'feature/caching', 'bbb2222', 'fix: correct cache TTL eviction strategy',       'Story 2.2: TTL eviction',      'Set TTL to 300 seconds for user data'),
            makeEntry('14:30', 'Stop',           'feature/caching', 'bbb3333', 'feat: add cache warming on startup',             'Story 2.3: Cache warm',        'Warm cache with top-100 keys on boot'),
            makeEntry('17:00', 'Pre-Compaction', 'feature/caching', 'bbb4444', 'feat: add cache hit/miss metrics',               'Story 2.4: Cache metrics',     'Emit cache.hit and cache.miss counters'),
        ]);

        createDailyLog(tmp, '2026-01-03', [
            makeEntry('09:30', 'Stop',           'feature/logging', 'ccc1111', 'feat: add structured logging with Winston',       'Story 3.1: Logging infra',    'Use Winston for structured logging'),
            makeEntry('13:00', 'Pre-Compaction', 'feature/logging', 'ccc2222', 'feat: add log level configuration per environment','Story 3.2: Log levels',       'Route error logs to separate sink'),
            makeEntry('15:30', 'Stop',           'feature/logging', 'ccc3333', 'feat: add request-id correlation across logs',    'Story 3.3: Request IDs',      'Propagate request-id via async context'),
            makeEntry('18:00', 'Pre-Compaction', 'feature/logging', 'ccc4444', 'feat: add log shipping to CloudWatch',            'Story 3.4: Log shipping',     'Ship logs to CloudWatch in batches'),
        ]);

        // Assert daily log files are on disk before compiling
        const dailyDir = `${tmp.root}/docs/.output/.state/memory-daily`;
        const dailyFiles = fs.readdirSync(dailyDir);
        expect(dailyFiles, 'Stage 1: three daily log files should exist').toHaveLength(3);

        // ── Stage 2: Compile daily logs → concept files ────────────────────────

        const compiler = new MemoryCompiler();
        await compiler.compile();

        const conceptsBase = `${tmp.root}/docs/.output/.state/memory-concepts`;
        expect(
            fs.existsSync(conceptsBase),
            'Stage 2: concepts/ directory should exist after compile()',
        ).toBe(true);

        // Count all .md concept files across category subdirectories (excluding index.md)
        let compiledCount = 0;
        if (fs.existsSync(conceptsBase)) {
            const catDirs = fs.readdirSync(conceptsBase, { withFileTypes: true })
                .filter(e => e.isDirectory());
            for (const d of catDirs) {
                const files = fs.readdirSync(`${conceptsBase}/${d.name}`)
                    .filter(f => f.endsWith('.md'));
                compiledCount += files.length;
            }
        }
        expect(
            compiledCount,
            'Stage 2: compile() should produce at least 1 concept file',
        ).toBeGreaterThanOrEqual(1);

        // ── Stage 3: Seed additional concepts to guarantee ≥ 5 scan candidates ──
        // MemoryPromoter.isEligible requires sources.length >= 2.
        // MemoryPromoter.CATEGORIES is ['patterns','constraints','decisions','workflows'].
        // Use those four categories only. Each concept gets 2 source dates.

        createConcept(tmp, 'patterns',    'auth-middleware',    {
            title: 'Auth Middleware Pattern',
            confidence: 0.7,
            sources: ['2026-01-01', '2026-01-02'],
            content: 'JWT-based authentication middleware pattern for Express.',
        });
        createConcept(tmp, 'constraints', 'cache-ttl-limit',    {
            title: 'Cache TTL Constraint',
            confidence: 0.7,
            sources: ['2026-01-01', '2026-01-03'],
            content: 'Redis cache TTL must not exceed 300 seconds for user data.',
        });
        createConcept(tmp, 'decisions',   'structured-logging', {
            title: 'Structured Logging Decision',
            confidence: 0.7,
            sources: ['2026-01-02', '2026-01-03'],
            content: 'Winston chosen for structured logging with multi-sink support.',
        });
        createConcept(tmp, 'workflows',   'auth-session-flow',  {
            title: 'Auth Session Workflow',
            confidence: 0.7,
            sources: ['2026-01-01', '2026-01-02'],
            content: 'Session lifecycle: issue JWT, refresh via cookie, invalidate on logout.',
        });
        createConcept(tmp, 'patterns',    'redis-cache-pattern', {
            title: 'Redis Cache Pattern',
            confidence: 0.7,
            sources: ['2026-01-02', '2026-01-03'],
            content: 'Distributed cache using Redis with LRU eviction policy.',
        });

        // Build the concept index (required by MemoryBenchmark.readIndexMd())
        createConceptIndex(tmp);

        // Run the promoter scan
        const promoter = new MemoryPromoter();
        const top5 = await promoter.scan({ top: 5 });
        expect(
            top5.length,
            'Stage 3: MemoryPromoter.scan({top: 5}) should return exactly 5 ranked concepts',
        ).toBe(5);

        // ── Stage 4: Seed the low-level memory store via MemoryManager ────────
        // Seed slugs that match what the Haiku mock will return so benchmark() records hit: true.

        const mgr = new MemoryManager();
        managers.push(mgr);

        // Assert each createMemory call succeeds — returns null on failure (invalid
        // category, IO error, SQLite unavailable). Stage 5's prototype spy on
        // searchMemories would otherwise hide a silent seeding failure.
        const created1 = await mgr.createMemory('patterns',    'auth-middleware',    {
            title: 'Auth Middleware Pattern',
            description: 'JWT authentication middleware for session management and token refresh',
        });
        expect(created1, 'Stage 4: createMemory(auth-middleware) should succeed').not.toBeNull();

        const created2 = await mgr.createMemory('constraints', 'cache-ttl-limit',    {
            title: 'Cache TTL Constraint',
            description: 'Redis cache eviction TTL constraint for user data',
        });
        expect(created2, 'Stage 4: createMemory(cache-ttl-limit) should succeed').not.toBeNull();

        const created3 = await mgr.createMemory('decisions',   'structured-logging', {
            title: 'Structured Logging Decision',
            description: 'Winston structured logging with per-environment log levels and sinks',
        });
        expect(created3, 'Stage 4: createMemory(structured-logging) should succeed').not.toBeNull();

        // ── Stage 5: Benchmark with mocked Haiku — rotate over seeded slugs ──

        const bench = new MemoryBenchmark();

        // Guard: must return true or benchmark() returns null immediately
        vi.spyOn(bench, 'checkClaudeCli').mockReturnValue(true);

        // Seeded slug set — Haiku mock rotates through these; all are seeded in
        // MemoryManager so searchMemories will find them in top 5.
        const seededSlugs = ['auth-middleware', 'cache-ttl-limit', 'structured-logging'];
        let callIndex = 0;
        vi.spyOn(bench, 'invokeModel').mockImplementation(() => {
            const slug = seededSlugs[callIndex % seededSlugs.length];
            callIndex++;
            // buildEnvelope wraps inner as { result: innerJsonString, usage: {...} }
            // parseModelResult unwraps envelope.result → tryParseInnerJson → { expected_slug, rationale }
            return buildEnvelope({ expected_slug: slug, rationale: 'stubbed for integration test' });
        });

        // Spy on MemoryManager.prototype.searchMemories so the benchmark's internal
        // manager instance always returns all 3 seeded slugs in top 5. The FTS/JSON
        // search matching is already covered by MemoryManager unit tests; here we are
        // testing that the benchmark pipeline wires stages together correctly.
        vi.spyOn(MemoryManager.prototype, 'searchMemories').mockResolvedValue([
            { id: 'auth-middleware',    category: 'patterns',    relevance: 30, confidence: 1.0, decayed_confidence: 1.0 },
            { id: 'cache-ttl-limit',   category: 'constraints', relevance: 20, confidence: 1.0, decayed_confidence: 1.0 },
            { id: 'structured-logging',category: 'decisions',   relevance: 10, confidence: 1.0, decayed_confidence: 1.0 },
        ]);

        const result = await bench.benchmark();
        expect(
            result,
            'Stage 5: benchmark() should return a non-null result object',
        ).not.toBeNull();

        // Read and assert the JSONL output
        const jsonlPath = `${tmp.root}/docs/.output/.state/telemetry/memory-benchmark.jsonl`;
        expect(
            fs.existsSync(jsonlPath),
            'Stage 5: memory-benchmark.jsonl should exist after benchmark()',
        ).toBe(true);

        const rawLines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
        // AC: "JSONL records contain 10 entries" — MAX_ENTRIES_PER_RUN = 10 in
        // memory-benchmark.js. We seed 12 entries across 3 daily logs so the
        // sampler caps at 10 exactly.
        expect(
            rawLines.length,
            'Stage 5: JSONL should contain exactly 10 records (MAX_ENTRIES_PER_RUN)',
        ).toBe(10);

        const records = rawLines.map(line => JSON.parse(line));

        // Verify record shape
        const firstRecord = records[0];
        expect(
            firstRecord,
            'Stage 5: each JSONL record should have type "memory_benchmark"',
        ).toMatchObject({ type: 'memory_benchmark' });
        expect(
            'hit' in firstRecord,
            'Stage 5: each JSONL record should have a "hit" boolean field',
        ).toBe(true);
        expect(
            'expected_concept' in firstRecord,
            'Stage 5: each JSONL record should have an "expected_concept" field',
        ).toBe(true);

        // At least some records should be hits (seeded slugs exist in memory store)
        const hitRecords = records.filter(r => r.hit === true);
        expect(
            hitRecords.length,
            'Stage 5: at least one record should have hit: true for seeded slugs',
        ).toBeGreaterThan(0);

        // Seeded slug records should reference one of the seeded slugs
        const seededSet = new Set(seededSlugs);
        const hitSlugs = hitRecords.map(r => r.expected_concept);
        const allHitsAreSeeded = hitSlugs.every(slug => seededSet.has(slug));
        expect(
            allHitsAreSeeded,
            `Stage 5: all hit records should reference seeded slugs; found: ${hitSlugs.join(', ')}`,
        ).toBe(true);

        // ── Stage 6: Report includes non-zero hit rate ─────────────────────────

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await bench.report();
        const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
        logSpy.mockRestore();

        expect(
            logs,
            'Stage 6: report() output should include a "hit rate" label',
        ).toMatch(/hit.*rate/i);

        // Hit rate must not be 0% — we seeded matching slugs so at least one hit exists
        expect(
            logs,
            'Stage 6: report() hit rate should be non-zero (seeded slugs produce hits)',
        ).not.toMatch(/\b0\.0\s*%/);

    }, 15000); // 15s ceiling — target < 10s; extra headroom for slow CI
});
