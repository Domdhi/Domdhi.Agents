// AC→source map (session-start-prime, structured-memory source):
//   - parseMemory: parses JSON memory; handles missing fields; returns null on bad JSON;
//                  extracts importance (top-level/content, default 3) + invalid_at + raw_usage
//                  (unfloored — MEM-9, no artificial floor of 1)
//   - rankConcepts (ME-4.2): importance-floored decayed × recency primary; usage tiebreaker only;
//                  tiebreak + primary-score usage input both prefer the LIVE SQLite index
//                  count over the ~always-0 tracked-JSON baseline (MEM-7)
//   - renderOutput: returns '<project_memory>...' XML block with slug/conf/summary lines
//   - processEvent: profile gate (minimal → null); missing memoriesDir → null; with memories → output string
//   - processEvent: CLAUDE_PROJECT_DIR env var controls source path
//   - processEvent: reads from memories/{category}/*.json, ignores memories/concepts/

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { createMemory } = require('../../core/__tests__/_helpers/memory-fixture');
const MemoryManager = require('../../../.agents/core/memory-manager');
const memoryDecay = require('../../../.agents/core/_lib/memory-decay');

// Probe FTS5 support directly — mirrors memory-manager.test.js's own probe.
const hasSqlite = (() => {
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
})();

const { processEvent, rankConcepts, renderOutput, parseMemory } = require('../../../.agents/hooks/session-start-prime.cjs');

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------
const origProjectDir = process.env.CLAUDE_PROJECT_DIR;
const origMemoryProfile = process.env.MEMORY_PROFILE;
const origPrimeCount = process.env.MEMORY_PRIME_COUNT;
const origStartup = process.env.MEMORY_STARTUP;

let tmp;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'session-start-prime-' });
    process.env.MEMORY_PROFILE = 'standard';
    delete process.env.MEMORY_PRIME_COUNT;
    // The ranking/index/telemetry tests below exercise the title list. The default for a Claude
    // session with recall on is the importance>=4 "core" (see 'startup modes'), so pin the title mode here.
    process.env.MEMORY_STARTUP = 'titles';
});

afterEach(() => {
    tmp.cleanup();
    process.env.MEMORY_PROFILE = origMemoryProfile ?? 'standard';
    if (origPrimeCount === undefined) delete process.env.MEMORY_PRIME_COUNT;
    else process.env.MEMORY_PRIME_COUNT = origPrimeCount;
    if (origStartup === undefined) delete process.env.MEMORY_STARTUP;
    else process.env.MEMORY_STARTUP = origStartup;
    // rankConcepts tests spy on the shared memoryDecay module object (necessary
    // because session-start-prime.cjs references it live, not destructured —
    // see that file's import comment) — restore after every test so a spy never
    // leaks into an unrelated test.
    vi.restoreAllMocks();
});

afterAll(() => {
    if (origProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origProjectDir;
});

// ---------------------------------------------------------------------------
// parseMemory
// ---------------------------------------------------------------------------

describe('parseMemory', () => {
    it('parseMemory_validJson_returnsMemoryObject', () => {
        const json = JSON.stringify({
            id: 'test-pattern',
            category: 'patterns',
            updated: '2026-04-19T00:00:00.000Z',
            usage_count: 3,
            content: { description: 'Use pattern X when Y happens' },
            metadata: { confidence: 0.8 },
        });
        const result = parseMemory(json, 'patterns', 'test-pattern.json');
        expect(result).not.toBeNull();
        expect(result.slug).toBe('test-pattern');
        expect(result.category).toBe('patterns');
        expect(result.confidence).toBe(0.8);
        expect(result.updated).toBe('2026-04-19T00:00:00.000Z');
        expect(result.usage_count).toBe(3);
        expect(result.summary).toBe('Use pattern X when Y happens');
    });

    it('parseMemory_invalidJson_returnsNull', () => {
        const result = parseMemory('not json {{{', 'patterns', 'bad.json');
        expect(result).toBeNull();
    });

    it('parseMemory_missingOptionalFields_usesDefaults', () => {
        const json = JSON.stringify({
            id: 'minimal',
            content: { description: 'Some lesson' },
        });
        const result = parseMemory(json, 'constraints', 'minimal.json');
        expect(result).not.toBeNull();
        expect(result.confidence).toBe(0.6);
        expect(result.usage_count).toBe(0);
        expect(result.updated).toBeNull();
        expect(result.summary).toBe('Some lesson');
    });

    it('parseMemory_zeroUsage_noLongerFloored', () => {
        // MEM-9: usage_count is no longer floored to 1 — a never-used memory
        // must read as 0, not a false "used once", so it doesn't get a uniform
        // +USAGE_BOOST in the primary decay score.
        const json = JSON.stringify({
            id: 'unused',
            content: { description: 'A memory nobody has touched' },
            usage_count: 0,
            metadata: { confidence: 1 },
        });
        const result = parseMemory(json, 'patterns', 'unused.json');
        expect(result.usage_count).toBe(0);
        expect(result.raw_usage).toBe(0);
    });

    it('parseMemory_importance_topLevelThenContentThenDefault', () => {
        const top = parseMemory(JSON.stringify({ id: 'a', importance: 5, content: { description: 'x' } }), 'patterns', 'a.json');
        expect(top.importance).toBe(5);
        const inContent = parseMemory(JSON.stringify({ id: 'b', content: { description: 'x', importance: 2 } }), 'patterns', 'b.json');
        expect(inContent.importance).toBe(2);
        const def = parseMemory(JSON.stringify({ id: 'c', content: { description: 'x' } }), 'patterns', 'c.json');
        expect(def.importance).toBe(3);
    });

    it('parseMemory_invalidAt_surfacedForSupersededSkip', () => {
        const sup = parseMemory(JSON.stringify({ id: 'd', invalid_at: '2026-01-01T00:00:00.000Z', content: { description: 'x' } }), 'patterns', 'd.json');
        expect(sup.invalid_at).toBe('2026-01-01T00:00:00.000Z');
        const live = parseMemory(JSON.stringify({ id: 'e', content: { description: 'x' } }), 'patterns', 'e.json');
        expect(live.invalid_at).toBeNull();
    });

    it('parseMemory_missingId_fallsBackToFilename', () => {
        const json = JSON.stringify({
            content: { description: 'No id field' },
        });
        const result = parseMemory(json, 'patterns', 'filename-slug.json');
        expect(result.slug).toBe('filename-slug');
    });

    it('parseMemory_longSummary_truncates', () => {
        const longText = 'x'.repeat(500);
        const json = JSON.stringify({
            id: 'long',
            content: { description: longText },
        });
        const result = parseMemory(json, 'patterns', 'long.json');
        expect(result.summary.length).toBeLessThanOrEqual(160);
        expect(result.summary.endsWith('...')).toBe(true);
    });

    it('parseMemory_contentStringShape_extracted', () => {
        // Some hand-created memories store content as a plain string
        const json = JSON.stringify({
            id: 'string-content',
            content: 'Short lesson text',
            metadata: { confidence: 0.7 },
        });
        const result = parseMemory(json, 'patterns', 'string-content.json');
        expect(result.summary).toBe('Short lesson text');
    });
});

// ---------------------------------------------------------------------------
// rankConcepts
// ---------------------------------------------------------------------------

describe('rankConcepts', () => {
    it('rankConcepts_ordersByImportanceFlooredDecayTimesRecency_usageNotPrimary', () => {
        const today = new Date().toISOString().slice(0, 10);
        vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockImplementation(({ confidence }) => confidence);
        const concepts = [
            { slug: 'low-conf', confidence: 0.3, updated: today, usage_count: 10, raw_usage: 10, category: 'patterns' },
            { slug: 'high-conf', confidence: 0.9, updated: today, usage_count: 10, raw_usage: 10, category: 'patterns' },
            { slug: 'stale', confidence: 0.9, updated: '2025-01-01', usage_count: 10, raw_usage: 10, category: 'patterns' },
        ];
        const ranked = rankConcepts(concepts, null);
        expect(ranked[0].slug).toBe('high-conf');
        expect(ranked[0].slug).not.toBe('stale');
    });

    it('rankConcepts_usageIsNoLongerPrimary_highUsageLowConfRanksBelowLowUsageHighConf', () => {
        // Under the OLD formula (decayed × recency × log(1+usage)) the heavy-usage
        // low-confidence memory would win. Under ME-4.2 it must NOT — usage is only
        // a tiebreaker, so the high-confidence memory ranks first.
        const today = new Date().toISOString().slice(0, 10);
        vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockImplementation(({ confidence }) => confidence);
        const concepts = [
            { slug: 'heavy-usage-low-conf', confidence: 0.3, updated: today, usage_count: 100, raw_usage: 100, category: 'patterns' },
            { slug: 'light-usage-high-conf', confidence: 0.9, updated: today, usage_count: 1, raw_usage: 1, category: 'patterns' },
        ];
        const ranked = rankConcepts(concepts, null);
        expect(ranked[0].slug).toBe('light-usage-high-conf');
    });

    it('rankConcepts_usageBreaksTies_whenScoresEqual', () => {
        // Identical confidence + recency → equal primary score → usage breaks the tie.
        const today = new Date().toISOString().slice(0, 10);
        vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockImplementation(({ confidence }) => confidence);
        const concepts = [
            { slug: 'tie-low-usage', confidence: 0.7, updated: today, usage_count: 1, raw_usage: 1, category: 'patterns' },
            { slug: 'tie-high-usage', confidence: 0.7, updated: today, usage_count: 9, raw_usage: 9, category: 'patterns' },
        ];
        const ranked = rankConcepts(concepts, null);
        expect(ranked[0].slug).toBe('tie-high-usage');
    });

    it('rankConcepts_importanceAppliedAsLocalRetentionFloor_notPassedIntoStandaloneCall', () => {
        // Wave 5D: the standalone _lib/memory-decay.js calculateDecayedConfidence
        // does NOT accept `importance` (unlike the old manager.calculateDecayedConfidence
        // adapter) — the ME-2.2 retention floor is now applied AFTER that call,
        // locally in rankConcepts. Prove both halves: (1) the standalone call is
        // NOT given an `importance` key, and (2) the floor still functionally
        // applies (high importance resists decay, low importance sinks further).
        const today = new Date().toISOString().slice(0, 10);
        const spy = vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockReturnValue(0.6);
        const concepts = [
            { slug: 'high-importance', confidence: 0.6, updated: today, usage_count: 0, raw_usage: 0, importance: 5, category: 'patterns' },
            { slug: 'low-importance', confidence: 0.6, updated: today, usage_count: 0, raw_usage: 0, importance: 1, category: 'patterns' },
        ];
        rankConcepts(concepts, null);

        for (const call of spy.mock.calls) {
            expect(call[0]).not.toHaveProperty('importance');
        }

        const high = concepts.find(c => c.slug === 'high-importance');
        const low = concepts.find(c => c.slug === 'low-importance');
        // importance 5 -> factor 5/3 (capped at 1.0); importance 1 -> factor 1/3.
        expect(high.decayed).toBeCloseTo(Math.min(1.0, 0.6 * (5 / 3)), 6);
        expect(low.decayed).toBeCloseTo(0.6 * (1 / 3), 6);
        expect(high.decayed).toBeGreaterThan(low.decayed);
    });

    it('rankConcepts_mutatesConceptsWithScore', () => {
        const today = new Date().toISOString().slice(0, 10);
        vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockReturnValue(0.7);
        const concepts = [
            { slug: 'a', confidence: 0.7, updated: today, usage_count: 5, category: 'patterns' }
        ];
        rankConcepts(concepts, null);
        expect(typeof concepts[0].score).toBe('number');
        expect(concepts[0].score).toBeGreaterThan(0);
    });

    it('rankConcepts_decayFunctionThrows_fallsBackToStoredConfidence', () => {
        const today = new Date().toISOString().slice(0, 10);
        vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockImplementation(() => { throw new Error('boom'); });
        const concepts = [
            { slug: 'fallback', confidence: 0.75, updated: today, usage_count: 2, category: 'patterns' }
        ];
        expect(() => rankConcepts(concepts, null)).not.toThrow();
        expect(typeof concepts[0].score).toBe('number');
        expect(concepts[0].decayed).toBe(0.75);
    });

    it('rankConcepts_returnsSameArrayReference', () => {
        const today = new Date().toISOString().slice(0, 10);
        vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockReturnValue(0.5);
        const concepts = [
            { slug: 'x', confidence: 0.5, updated: today, usage_count: 1, category: 'patterns' }
        ];
        const result = rankConcepts(concepts, null);
        expect(result).toBe(concepts);
    });

    // -----------------------------------------------------------------------
    // Wave 5D (MINOR): the "2s hard timeout" is a setTimeout, which cannot
    // preempt a blocked event loop — so it can't actually bound the synchronous
    // `git log` inside MemoryManager.calculateDecayedConfidence. Option A:
    // rankConcepts now calls the STANDALONE _lib/memory-decay.js function
    // directly (activeDays omitted -> calendar-days fallback), never touching
    // manager.calculateDecayedConfidence / the git-log-backed active-days
    // resolver at all. These two tests are the regression guard.
    // -----------------------------------------------------------------------

    it('rankConcepts_neverInvokesManagerCalculateDecayedConfidence_staysOffSyncGitLogPath', () => {
        const today = new Date().toISOString().slice(0, 10);
        const explodingManager = {
            calculateDecayedConfidence: vi.fn(() => {
                throw new Error('should never be called — this routes through a synchronous git log');
            }),
        };
        const concepts = [
            { slug: 'a', confidence: 0.6, updated: today, usage_count: 0, raw_usage: 0, category: 'patterns' },
        ];
        expect(() => rankConcepts(concepts, explodingManager)).not.toThrow();
        expect(explodingManager.calculateDecayedConfidence).not.toHaveBeenCalled();
    });

    it('rankConcepts_decayOmitsActiveDays_matchesCalendarDaysStandaloneFormula', () => {
        // A 30-day-old `updated` clears RECENT_UPDATE_BOOST's 7-day window and
        // usage_count 0 clears USAGE_BOOST, isolating the pure decay curve so the
        // comparison below isn't muddied by other additive terms.
        const updated = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const concepts = [
            { slug: 'calendar-based', confidence: 0.6, updated, usage_count: 0, raw_usage: 0, category: 'patterns' },
        ];
        rankConcepts(concepts, null);

        // Recompute via the REAL standalone function with activeDays explicitly
        // omitted. If rankConcepts ever again routed through a git-log-backed
        // active-days value, this would diverge from the calendar-day count.
        const expectedBase = memoryDecay.calculateDecayedConfidence({
            confidence: 0.6,
            category: 'patterns',
            updated,
            usageCount: 0,
        });
        // importance omitted on the concept -> IMPORTANCE_DEFAULT -> factor 1.0
        expect(concepts[0].decayed).toBeCloseTo(expectedBase, 6);
    });

    // -----------------------------------------------------------------------
    // MEM-9: unfloored usage feeds the primary decay-score call
    // -----------------------------------------------------------------------

    it('rankConcepts_zeroUsageGetsNoBoost_unflooredInputReachesDecayCalc', () => {
        // MEM-9: parseMemory used to floor usage_count to Math.max(1, raw), so a
        // never-used memory silently got the SAME +USAGE_BOOST as a used one.
        // This reproduces calculateDecayedConfidence's real usage_count*BOOST term
        // (constants.js MEMORY_DECAY.USAGE_BOOST = 0.01) to prove the unfloored
        // (0) value now reaches it untouched.
        const BOOST = 0.01;
        const spy = vi.spyOn(memoryDecay, 'calculateDecayedConfidence')
            .mockImplementation(({ confidence, usageCount }) => confidence + usageCount * BOOST);
        const today = new Date().toISOString().slice(0, 10);
        const concepts = [
            { slug: 'never-used', confidence: 0.5, updated: today, usage_count: 0, raw_usage: 0, category: 'patterns' },
        ];
        rankConcepts(concepts, null);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ usageCount: 0 })
        );
        // Old floor-of-1 behavior would have produced 0.5 + (1 * 0.01) = 0.51;
        // the fix keeps a genuinely-unused memory at exactly 0.5.
        expect(concepts[0].decayed).toBe(0.5);
    });

    // -----------------------------------------------------------------------
    // MEM-7: live SQLite usage index feeds the TIEBREAK ONLY, not the ~always-0
    // tracked-JSON baseline. (It deliberately does NOT feed the primary decay
    // score — see the MEM-9 test above and the code comment in rankConcepts:
    // that would let a heavily-recalled memory's primary score climb past the
    // "usage only breaks ties" contract.)
    // -----------------------------------------------------------------------

    it('rankConcepts_liveUsageMap_breaksTieOverStaleJsonBaseline', () => {
        // Unit-level proof that a liveUsage Map (as produced by the real
        // manager._indexUsageMap()) overrides raw_usage per-concept, and that a
        // slug absent from the map correctly falls back to raw_usage.
        const today = new Date().toISOString().slice(0, 10);
        vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockImplementation(({ confidence }) => confidence);
        const concepts = [
            { slug: 'in-index', confidence: 0.7, updated: today, usage_count: 0, raw_usage: 0, category: 'patterns' },
            { slug: 'not-in-index', confidence: 0.7, updated: today, usage_count: 0, raw_usage: 0, category: 'patterns' },
        ];
        const liveUsage = new Map([['in-index', 5]]); // 'not-in-index' absent → falls back to raw_usage (0)

        const ranked = rankConcepts(concepts, null, liveUsage);

        // Both raw_usage values are 0 (stale JSON baseline) — without the live
        // map, this would be an unresolved tie. The live map differentiates it.
        expect(ranked[0].slug).toBe('in-index');
        expect(ranked[0].usageTiebreak).toBe(5);
        expect(ranked[1].usageTiebreak).toBe(0);
    });

    it('rankConcepts_missingLiveUsageParam_defaultsToEmptyMapAndFallsBackToRawUsage', () => {
        // Backward-compat: callers (e.g. memory-stability.js) that still invoke
        // rankConcepts(concepts, manager) with only 2 args must keep working —
        // the third param defaults to an empty Map, which falls back to raw_usage
        // for every concept exactly like the pre-MEM-7 behavior.
        const today = new Date().toISOString().slice(0, 10);
        vi.spyOn(memoryDecay, 'calculateDecayedConfidence').mockImplementation(({ confidence }) => confidence);
        const concepts = [
            { slug: 'legacy-caller', confidence: 0.7, updated: today, usage_count: 4, raw_usage: 4, category: 'patterns' },
        ];
        rankConcepts(concepts, null);
        expect(concepts[0].usageTiebreak).toBe(4);
    });

    describe.skipIf(!hasSqlite)('rankConcepts — real SQLite-backed liveUsage (MEM-7 integration)', () => {
        let manager;
        let tmpSqlite;

        beforeEach(() => {
            tmpSqlite = createTmpDir({ prefix: 'session-start-prime-sqlite-' });
            process.env.CLAUDE_PROJECT_DIR = tmpSqlite.root;
        });

        afterEach(() => {
            if (manager && manager.db) {
                try { manager.db.close(); } catch { /* non-fatal */ }
            }
            manager = null;
            tmpSqlite.cleanup();
        });

        it('rankConcepts_realIndexUsageMap_reflectsGenuineRecallsOverStaleJson', async () => {
            manager = new MemoryManager();
            await manager.createMemory('patterns', 'recalled-often', { description: 'uniquekiwiMEM7 recalled often lesson' });
            await manager.createMemory('patterns', 'recalled-never', { description: 'Never recalled lesson' });

            // Genuine recalls (F44 — the ONLY place usage_count grows) for one memory.
            await manager.searchMemories('uniquekiwiMEM7');
            await manager.searchMemories('uniquekiwiMEM7');
            await manager.searchMemories('uniquekiwiMEM7');

            const liveUsage = manager._indexUsageMap();
            const oftenLive = liveUsage.get('recalled-often');
            expect(oftenLive).toBeGreaterThanOrEqual(1);
            expect(liveUsage.get('recalled-never') ?? 0).toBe(0);

            // The TRACKED JSON usage_count is still 0 for BOTH (never written back —
            // F44 / ADR 0006 Am. 2), so parsing straight from JSON gives an equal
            // (0, 0) raw_usage tie.
            const fsSync = require('fs');
            const nodePath = require('path');
            const memoriesDir = nodePath.join(tmpSqlite.root, 'docs', '.output', '.memory', 'patterns');
            const often = parseMemory(fsSync.readFileSync(nodePath.join(memoriesDir, 'recalled-often.json'), 'utf8'), 'patterns', 'recalled-often.json');
            const never = parseMemory(fsSync.readFileSync(nodePath.join(memoriesDir, 'recalled-never.json'), 'utf8'), 'patterns', 'recalled-never.json');
            expect(often.raw_usage).toBe(0);
            expect(never.raw_usage).toBe(0);

            // Force an equal primary score so the tiebreak is the only thing that
            // can differentiate ranking.
            const today = new Date().toISOString();
            often.confidence = never.confidence = 0.8;
            often.importance = never.importance = 3;
            often.updated = never.updated = today;

            const concepts = [never, often]; // deliberately reverse input order

            // Wave 5D: rankConcepts now computes decay via the standalone
            // calendar-days formula, which reads Date.now() fresh INSIDE each
            // per-concept call (unlike the old git-log-backed active-days value,
            // which was time-of-call-independent). Freeze time so both concepts'
            // decay calls see an identical "now" — otherwise the exact equality
            // below could flake on sub-millisecond jitter between the two calls.
            vi.useFakeTimers();
            vi.setSystemTime(new Date(today));
            try {
                rankConcepts(concepts, manager, liveUsage);
            } finally {
                vi.useRealTimers();
            }

            // Prove the primary scores are GENUINELY tied — MEM-9's fix keeps live
            // usage OUT of the primary decay score (rawUsage feeds it instead, and
            // both raw_usage are 0), so this equality isn't an artifact of rounding.
            // Without this, "often" could win on primary score alone and the
            // assertions below would pass even if the tiebreak itself were broken.
            expect(concepts[0].score).toBe(concepts[1].score);

            // Without MEM-7, both raw_usage are 0 → tie unresolved → stable input
            // order (never first). With the fix, live usage breaks the tie.
            expect(concepts[0].slug).toBe('recalled-often');
            expect(concepts[0].usageTiebreak).toBe(oftenLive);
            expect(concepts[1].usageTiebreak).toBe(0);
        });
    });
});

// ---------------------------------------------------------------------------
// renderOutput
// ---------------------------------------------------------------------------

describe('renderOutput', () => {
    it('renderOutput_producesProjectMemoryXmlBlock', () => {
        const today = new Date().toISOString().slice(0, 10);
        const topConcepts = [
            { slug: 'my-memory', decayed: 0.82, summary: 'A test summary', category: 'patterns', updated: today }
        ];
        const output = renderOutput(topConcepts, 5);
        expect(output).toContain('<project_memory>');
        expect(output).toContain('</project_memory>');
        expect(output).toContain('my-memory');
        expect(output).toContain('0.82');
        expect(output).toContain('A test summary');
    });

    it('renderOutput_includesTotalCountInHeader', () => {
        const today = new Date().toISOString().slice(0, 10);
        const topConcepts = [
            { slug: 'a', decayed: 0.9, summary: 'Summary A', category: 'patterns', updated: today }
        ];
        const output = renderOutput(topConcepts, 42);
        expect(output).toContain('42');
    });

    it('renderOutput_includesCategoryTag', () => {
        const today = new Date().toISOString().slice(0, 10);
        const topConcepts = [
            { slug: 'a', decayed: 0.9, summary: 'Summary A', category: 'constraints', updated: today }
        ];
        const output = renderOutput(topConcepts, 1);
        expect(output).toContain('[constraints]');
    });
});

// ---------------------------------------------------------------------------
// processEvent
// ---------------------------------------------------------------------------

describe('processEvent', () => {
    it('processEvent_profileMinimal_returnsOutputNull', () => {
        process.env.MEMORY_PROFILE = 'minimal';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        const result = processEvent({});
        expect(result).toEqual({ output: null });
    });

    it('processEvent_missingMemoriesDir_returnsOutputNull', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        const result = processEvent({});
        expect(result).toEqual({ output: null });
    });

    it('processEvent_emptyCategoryDirs_returnsOutputNull', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        tmp.mkdir('docs/.output/.memory/patterns');
        tmp.mkdir('docs/.output/.memory/constraints');
        const result = processEvent({});
        expect(result).toEqual({ output: null });
    });

    it('processEvent_withMemories_returnsProjectMemoryOutput', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        createMemory(tmp, 'patterns', 'test-pattern', {
            description: 'Wave plans should enumerate file ownership to enable parallel dispatch',
            confidence: 0.9,
        });
        const result = processEvent({});
        expect(result).toHaveProperty('output');
        expect(result.output).toContain('<project_memory>');
        expect(result.output).toContain('test-pattern');
        expect(result.output).toContain('Wave plans should enumerate');
    });

    it('processEvent_pullsFromMultipleCategories', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        createMemory(tmp, 'patterns', 'pat-one', { description: 'Pattern one' });
        createMemory(tmp, 'constraints', 'con-one', { description: 'Constraint one' });
        const result = processEvent({});
        expect(result.output).toContain('pat-one');
        expect(result.output).toContain('con-one');
        expect(result.output).toContain('2'); // total count
    });

    it('processEvent_ignoresConceptsSubdir', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        // concepts/ is the old compaction-snapshot output — the new hook MUST ignore it
        tmp.write(
            'docs/.output/.state/memory-concepts/decisions/old-noise.md',
            '---\ntitle: Old Noise\nconfidence: 0.9\n---\n\n> [!abstract] Summary\n> Activity observed...\n'
        );
        const result = processEvent({});
        expect(result).toEqual({ output: null });
    });

    it('processEvent_primecountEnvVar_limitsTopN', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        process.env.MEMORY_PRIME_COUNT = '1';
        createMemory(tmp, 'patterns', 'm-1', { description: 'One', confidence: 0.9 });
        createMemory(tmp, 'patterns', 'm-2', { description: 'Two', confidence: 0.8 });
        createMemory(tmp, 'patterns', 'm-3', { description: 'Three', confidence: 0.7 });
        const result = processEvent({});
        const bulletLines = result.output.split('\n').filter(l => l.startsWith('- **'));
        expect(bulletLines).toHaveLength(1);
    });

    it('processEvent_skipsNonJsonFiles', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        createMemory(tmp, 'patterns', 'valid', { description: 'Valid memory' });
        tmp.write('docs/.output/.memory/patterns/readme.md', '# Not a memory');
        const result = processEvent({});
        expect(result.output).toContain('valid');
        expect(result.output).not.toContain('readme');
    });
});

// ---------------------------------------------------------------------------
// NA5.10 — index self-heal by content, not mtime. Any incremental index write
// (createMemory, updateMemory, a recall's usage bump) keeps the db newer than every
// JSON record, so the mtime check calls a partial index, or a row whose eligibility
// went stale after a pulled retirement, "fresh" forever. The hook compares the
// store with the index through the shared _lib/memory-index-divergence.js (NA5.11)
// and starts exactly one background rebuild-index on divergence. The spawn is
// observed through the shared child_process module object, never executed.
// ---------------------------------------------------------------------------

const divergence = require('../../../.agents/core/_lib/memory-index-divergence');

describe('memory index divergence (NA5.10 / NA5.11)', () => {
    const rec = (id, extra = {}) => ({ file: `patterns/${id}.json`, id, invalid_at: null, updated: '2026-10-01T00:00:00.000Z', created: '2026-09-01T00:00:00.000Z', mtimeMs: 1000, ...extra });
    const row = (extra = {}) => ({ invalid_at: null, updated: '2026-10-01T00:00:00.000Z', ...extra });
    const none = { completedAtMs: 0, failed: new Set() };

    it('indexDivergence_matchingStoreAndIndex_reportsNothing', () => {
        const d = divergence.indexDivergence([rec('a'), rec('b', { invalid_at: '2026-10-09T00:00:00.000Z' })], new Map([['a', row()], ['b', row({ invalid_at: '2026-10-09T00:00:00.000Z' })]]), none);
        expect(d).toEqual({ missing: [], staleEligibility: [], staleUpdated: [], orphaned: [], excused: [], ambiguous: [] });
        expect(divergence.hasDivergence(d)).toBe(false);
    });

    it('indexDivergence_liveRecordWithoutRow_isMissing_retiredWithoutRowIsNot', () => {
        const d = divergence.indexDivergence([rec('a'), rec('gone', { invalid_at: '2026-10-09T00:00:00.000Z' })], new Map(), none);
        expect(d.missing).toEqual(['a']);
        expect(divergence.hasDivergence(d)).toBe(true);
    });

    it('indexDivergence_retiredInStoreLiveInIndex_isStaleEligibility', () => {
        const d = divergence.indexDivergence([rec('a', { invalid_at: '2026-10-09T00:00:00.000Z' })], new Map([['a', row()]]), none);
        expect(d.staleEligibility).toEqual(['a']);
        expect(divergence.hasDivergence(d)).toBe(true);
    });

    it('indexDivergence_updatedDiffers_isStale_andFallsBackToCreatedLikeTheIndex', () => {
        const d = divergence.indexDivergence([rec('a', { updated: '2026-10-05T00:00:00.000Z' }), rec('b', { updated: null })], new Map([['a', row()], ['b', row({ updated: '2026-09-01T00:00:00.000Z' })]]), none);
        expect(d.staleUpdated).toEqual(['a']);
    });

    it('indexDivergence_liveRowWithoutRecord_isOrphaned_retiredRowIsNot', () => {
        const d = divergence.indexDivergence([], new Map([['deleted', row()], ['history', row({ invalid_at: '2026-10-09T00:00:00.000Z' })]]), none);
        expect(d.orphaned).toEqual(['deleted']);
    });

    it('indexDivergence_fileThatFailedTheLastRebuild_isExcusedUntilItChanges', () => {
        const status = { completedAtMs: 5000, failed: new Set(['patterns/bad.json']) };
        const unchanged = divergence.indexDivergence([rec('bad', { mtimeMs: 4000 })], new Map(), status);
        expect(unchanged.excused).toEqual(['patterns/bad.json']);
        expect(divergence.hasDivergence(unchanged)).toBe(false);
        const edited = divergence.indexDivergence([rec('bad', { mtimeMs: 6000 })], new Map(), status);
        expect(edited.missing).toEqual(['bad']);
    });

    it('indexDivergence_idSharedByTwoRecords_isAmbiguousNotDivergent', () => {
        const d = divergence.indexDivergence([rec('dup', { file: 'patterns/one.json' }), rec('dup', { file: 'workflows/two.json', updated: '2026-10-07T00:00:00.000Z' })], new Map([['dup', row()]]), none);
        expect(d.ambiguous).toEqual(['dup']);
        expect(divergence.hasDivergence(d)).toBe(false);
    });

    it('readRebuildStatus_absentOrUnreadable_excusesNothing', () => {
        const status = divergence.readRebuildStatus(path.join(tmp.root, 'no-such-dir', 'memories.db'));
        expect(status.completedAtMs).toBe(0);
        expect([...status.failed]).toEqual([]);
    });
});

describe.skipIf(!hasSqlite)('processEvent index self-heal (NA5.10)', () => {
    const childProcess = require('child_process');
    const nodePath = require('path');
    const fsSync = require('fs');
    const PAST = new Date('2026-01-01T00:00:00Z');

    const patternsDir = root => nodePath.join(root, 'docs', '.output', '.memory', 'patterns');
    function backdateJson(root) {
        for (const f of fsSync.readdirSync(patternsDir(root))) fsSync.utimesSync(nodePath.join(patternsDir(root), f), PAST, PAST);
    }
    function dbPath(root) {
        return nodePath.join(root, 'docs', '.output', '.state', 'memory-index', 'memories.db');
    }
    function rebuildSpawns(spy) {
        return spy.mock.calls.filter(([, args]) => Array.isArray(args) && args[1] === 'rebuild-index');
    }
    async function indexOnly(id) {
        const manager = new MemoryManager();
        await manager.createMemory('patterns', id, { description: `${id} lesson indexed by an incremental write` });
        manager.db.close();
    }
    function editJson(root, id, fn) {
        const p = nodePath.join(patternsDir(root), `${id}.json`);
        const rec = JSON.parse(fsSync.readFileSync(p, 'utf8'));
        fn(rec);
        fsSync.writeFileSync(p, JSON.stringify(rec, null, 2));
    }
    const spySpawn = () => vi.spyOn(childProcess, 'spawn').mockReturnValue({ unref() {} });

    beforeEach(() => {
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
    });

    it('processEvent_freshButPartialIndex_spawnsOneBackgroundRebuild_outputAndTelemetryUnchanged', async () => {
        await indexOnly('indexed-one');
        createMemory(tmp, 'patterns', 'unindexed-two', { description: 'Synced record the index never saw' });
        backdateJson(tmp.root); // the db is now newer than every JSON file: the mtime check calls it fresh
        const spy = spySpawn();

        const result = processEvent({});

        const calls = rebuildSpawns(spy);
        expect(calls).toHaveLength(1);
        expect(calls[0][1][0]).toMatch(/memory-manager-cli\.js$/);
        expect(calls[0][2]).toMatchObject({ stdio: 'ignore', windowsHide: true });
        expect(result.output).toContain('indexed-one');
        expect(result.output).toContain('unindexed-two');
        const events = fsSync.readFileSync(injectionLogPath(tmp.root), 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(events).toHaveLength(1);
        expect([...events[0].injected_ids].sort()).toEqual(['indexed-one', 'unindexed-two']);
    });

    it('processEvent_staleAndPartialIndex_spawnsExactlyOneRebuild', async () => {
        await indexOnly('indexed-one');
        createMemory(tmp, 'patterns', 'unindexed-two', { description: 'Synced record the index never saw' });
        fsSync.utimesSync(dbPath(tmp.root), PAST, PAST); // the mtime check also fires
        const spy = spySpawn();

        processEvent({});

        expect(rebuildSpawns(spy)).toHaveLength(1);
    });

    it.each(['last-file', 'category', 'store', 'all-retired'])('R2_processEvent_emptyInjection_%s_repairsLiveIndexWithoutLoggingInjection', async mode => {
        await indexOnly('last-live');
        if (mode === 'all-retired') {
            editJson(tmp.root, 'last-live', r => { r.invalid_at = '2026-10-09T00:00:00.000Z'; });
            backdateJson(tmp.root);
        } else if (mode === 'last-file') fsSync.unlinkSync(nodePath.join(patternsDir(tmp.root), 'last-live.json'));
        else fsSync.rmSync(mode === 'category' ? patternsDir(tmp.root) : nodePath.dirname(patternsDir(tmp.root)), { recursive: true, force: true });
        const spy = spySpawn();

        expect(processEvent({})).toEqual({ output: null });

        const calls = rebuildSpawns(spy);
        expect(calls).toHaveLength(1);
        expect(calls[0][1][0]).toMatch(/memory-manager-cli\.js$/);
        expect(calls[0][2]).toMatchObject({ stdio: 'ignore', windowsHide: true, cwd: tmp.root });
        expect(fsSync.existsSync(injectionLogPath(tmp.root))).toBe(false);
    });

    it('R2_processEvent_emptyMatchingIndex_doesNotSpawnOrLogInjection', async () => {
        await indexOnly('gone');
        fsSync.unlinkSync(nodePath.join(patternsDir(tmp.root), 'gone.json'));
        const manager = new MemoryManager();
        await manager.rebuildIndex();
        manager.db.close();
        const spy = spySpawn();
        expect(processEvent({})).toEqual({ output: null });
        expect(rebuildSpawns(spy)).toHaveLength(0);
        expect(fsSync.existsSync(injectionLogPath(tmp.root))).toBe(false);
    });

    it.each(['{broken', 'null'])('R1_processEvent_badSource_%s_isNamedEvenWithoutInjection', async raw => {
        await indexOnly('damaged');
        fsSync.writeFileSync(nodePath.join(patternsDir(tmp.root), 'damaged.json'), raw);
        backdateJson(tmp.root);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        spySpawn();
        expect(processEvent({})).toEqual({ output: null });
        expect(stderr.mock.calls.map(c => String(c[0])).join('')).toContain('patterns/damaged.json');
        expect(fsSync.existsSync(injectionLogPath(tmp.root))).toBe(false);
    });

    it('processEvent_freshCompleteIndex_spawnsNoRebuild', async () => {
        await indexOnly('indexed-one');
        await indexOnly('indexed-two');
        backdateJson(tmp.root);
        const spy = spySpawn();

        const result = processEvent({});

        expect(rebuildSpawns(spy)).toHaveLength(0);
        expect(result.output).toContain('indexed-two');
    });

    it('processEvent_retirementPulledAfterIndexing_spawnsOneRebuild', async () => {
        await indexOnly('indexed-one');
        await indexOnly('retired-later');
        // A pulled retirement: the JSON gains invalid_at, the index row stays live, and
        // a later recall keeps the db newer than the JSON (backdated here).
        editJson(tmp.root, 'retired-later', r => { r.invalid_at = '2026-10-09T00:00:00.000Z'; });
        backdateJson(tmp.root);
        const spy = spySpawn();

        const result = processEvent({});

        expect(rebuildSpawns(spy)).toHaveLength(1);
        expect(result.output).not.toContain('retired-later');
    });

    it('processEvent_retiredInStoreAndIndex_spawnsNoRebuild', async () => {
        await indexOnly('indexed-one');
        await indexOnly('retired-both');
        editJson(tmp.root, 'retired-both', r => { r.invalid_at = '2026-10-09T00:00:00.000Z'; });
        const manager = new MemoryManager();
        await manager.rebuildIndex();
        manager.db.close();
        backdateJson(tmp.root);
        const spy = spySpawn();

        processEvent({});

        expect(rebuildSpawns(spy)).toHaveLength(0);
    });

    it('processEvent_retiredRecordMissingFromIndex_doesNotCountAsPartial', async () => {
        await indexOnly('indexed-one');
        createMemory(tmp, 'patterns', 'retired-unindexed', { description: 'Retired history' });
        editJson(tmp.root, 'retired-unindexed', r => { r.invalid_at = '2026-10-09T00:00:00.000Z'; });
        backdateJson(tmp.root);
        const spy = spySpawn();

        const result = processEvent({});

        expect(rebuildSpawns(spy)).toHaveLength(0);
        expect(result.output).not.toContain('retired-unindexed');
    });

    it('processEvent_unindexableRecordFromTheLastRebuild_isExcusedUntilItChanges', async () => {
        await indexOnly('indexed-one');
        fsSync.writeFileSync(nodePath.join(patternsDir(tmp.root), 'no-created.json'), JSON.stringify({ id: 'no-created', type: 'pattern', category: 'patterns', content: { description: 'missing created' }, metadata: { confidence: 1 } }, null, 2));
        backdateJson(tmp.root);
        const manager = new MemoryManager();
        expect((await manager.rebuildIndex()).failed.map(f => f.file)).toEqual(['patterns/no-created.json']);
        manager.db.close();
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
        const spy = spySpawn();

        processEvent({});

        expect(rebuildSpawns(spy)).toHaveLength(0);
        expect(stderr.mock.calls.map(c => String(c[0])).join('')).toMatch(/1 record\(s\) the last rebuild could not index: patterns\/no-created\.json/);

        // Editing the file lifts the excuse: one rebuild attempt per change.
        const later = new Date(Date.now() + 60000);
        fsSync.utimesSync(nodePath.join(patternsDir(tmp.root), 'no-created.json'), later, later);
        processEvent({});
        expect(rebuildSpawns(spy)).toHaveLength(1);
    });

    it('processEvent_sqliteUnavailable_spawnsNoRebuildAndOutputUnchanged', async () => {
        await indexOnly('indexed-one');
        await indexOnly('indexed-two');
        backdateJson(tmp.root);
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
        try {
            const control = processEvent({}).output;
            const spy = spySpawn();
            vi.spyOn(MemoryManager.prototype, 'initDb').mockReturnValue(false);

            const result = processEvent({});

            expect(rebuildSpawns(spy)).toHaveLength(0);
            expect(result.output).toBe(control);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ---------------------------------------------------------------------------
// Injection telemetry (MP-1.2)
//   - a real injection appends exactly one parseable `memory_injection` event
//   - injected_ids equals the slugs of the rendered (injected) memories
//   - an empty store injects nothing → writes no telemetry
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

function injectionLogPath(root) {
    return path.join(root, 'docs', '.output', '.state', 'telemetry', 'memory-injection.jsonl');
}

describe('injection telemetry', () => {
    it('processEvent_withMemories_appendsOneMemoryInjectionEvent', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        createMemory(tmp, 'patterns', 'mp12-alpha', { description: 'Alpha lesson', confidence: 0.9 });
        createMemory(tmp, 'decisions', 'mp12-beta', { description: 'Beta lesson', confidence: 0.8 });

        const result = processEvent({});
        expect(result.output).toBeTruthy();

        const logPath = injectionLogPath(tmp.root);
        expect(fs.existsSync(logPath)).toBe(true);

        const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
        expect(lines).toHaveLength(1);

        const event = JSON.parse(lines[0]);
        expect(event.type).toBe('memory_injection');
        expect(event.injected_count).toBe(2);
        expect(event.total_available).toBe(2);
        expect(Array.isArray(event.injected_ids)).toBe(true);
        // injected_ids match the rendered memories (denominator for hit-rate)
        expect(event.injected_ids.slice().sort()).toEqual(['mp12-alpha', 'mp12-beta']);
        expect(event.session_proxy).toBe(event.timestamp.slice(0, 16));
    });

    it('processEvent_emptyStore_writesNoInjectionLog', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        // no memories seeded → nothing injected
        const result = processEvent({});
        expect(result).toEqual({ output: null });
        expect(fs.existsSync(injectionLogPath(tmp.root))).toBe(false);
    });

    it('processEvent_injectedIdsMatchRenderedSlugs', () => {
        process.env.MEMORY_PROFILE = 'standard';
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        process.env.MEMORY_PRIME_COUNT = '1';
        createMemory(tmp, 'patterns', 'top-mem', { description: 'Top', confidence: 0.95 });
        createMemory(tmp, 'patterns', 'low-mem', { description: 'Low', confidence: 0.5 });

        const result = processEvent({});
        const event = JSON.parse(
            fs.readFileSync(injectionLogPath(tmp.root), 'utf8').trim().split('\n').pop()
        );
        // only the top-1 was rendered, so only its id is logged
        expect(event.injected_count).toBe(1);
        expect(event.total_available).toBe(2);
        expect(event.injected_ids).toEqual(['top-mem']);
        expect(result.output).toContain('top-mem');
        expect(result.output).not.toContain('low-mem');
    });
});

// ---------------------------------------------------------------------------
// Startup modes — the title list scored 35% (no memory 16%, per-prompt recall 72%), so where
// memory-recall.cjs delivers, the startup block is the importance>=4 always-on core.
// ---------------------------------------------------------------------------

describe('startup modes', () => {
    const saved = {};
    const KEYS = ['MEMORY_RECALL', 'AGENTS_RUNTIME', 'AGENT_RUNTIME', 'CODEX_PROJECT_DIR'];
    beforeEach(() => {
        for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
        delete process.env.MEMORY_STARTUP;
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        createMemory(tmp, 'constraints', 'always-on-rule', { description: 'Never pkill -f your own pattern', importance: 5 });
        createMemory(tmp, 'patterns', 'ordinary-note', { description: 'An ordinary lesson', importance: 3 });
    });
    afterEach(() => {
        for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    });

    it('defaults to the core for a Claude session with recall on: only importance >= 4, and says the rest arrives per prompt', () => {
        const out = processEvent({}).output;
        expect(out).toContain('always-on-rule');
        expect(out).not.toContain('ordinary-note');
        expect(out).toMatch(/Always-on core: 1 of 1/);
        expect(out).toContain('attached to your prompts');
    });
    it('keeps the full title list when recall is off (nothing else would deliver the memories)', () => {
        process.env.MEMORY_RECALL = 'off';
        const out = processEvent({}).output;
        expect(out).toContain('always-on-rule');
        expect(out).toContain('ordinary-note');
        expect(out).toMatch(/Top 2 of 2/);
    });
    it('keeps the full title list on Codex, which registers no per-prompt recall hook', () => {
        process.env.AGENTS_RUNTIME = 'codex';
        expect(processEvent({}).output).toContain('ordinary-note');
    });
    it('MEMORY_STARTUP forces a mode: titles, core, or off', () => {
        process.env.MEMORY_STARTUP = 'titles';
        expect(processEvent({}).output).toContain('ordinary-note');
        process.env.MEMORY_STARTUP = 'core';
        process.env.AGENTS_RUNTIME = 'codex';
        expect(processEvent({}).output).not.toContain('ordinary-note');
        process.env.MEMORY_STARTUP = 'off';
        expect(processEvent({})).toEqual({ output: null });
    });
    it('core mode with no importance >= 4 memory injects nothing', () => {
        fs.rmSync(path.join(tmp.root, 'docs/.output/.memory/constraints/always-on-rule.json'));
        expect(processEvent({})).toEqual({ output: null });
    });
    it('records only what was injected in telemetry', () => {
        processEvent({});
        const lines = fs.readFileSync(path.join(tmp.root, 'docs/.output/.state/telemetry/memory-injection.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(lines.at(-1).injected_ids).toEqual(['always-on-rule']);
    });
});

describe('pending capture candidates reminder', () => {
    beforeEach(() => { process.env.CLAUDE_PROJECT_DIR = tmp.root; delete process.env.AGENTS_RUNTIME; });
    const stage = n => { for (let i = 0; i < n; i++) tmp.write(`docs/.output/.state/memory-notes/candidates/aaa00${i}-thing.md`, 'x'); };

    it('adds one line naming the review command when candidates wait, even with no memories', () => {
        stage(2);
        const out = processEvent({}).output;
        expect(out).toContain('<memory_candidates>');
        expect(out).toContain('2 captured memory candidates await review');
        expect(out).toContain('node .claude/core/memory-capture.js list');
    });
    it('uses the singular and the Codex helper path where applicable; ignores dot files and the discarded folder', () => {
        stage(1);
        tmp.write('docs/.output/.state/memory-notes/candidates/.hidden.md', 'x');
        tmp.write('docs/.output/.state/memory-notes/candidates/.discarded/old.md', 'x');
        process.env.AGENTS_RUNTIME = 'codex';
        const out = processEvent({}).output;
        expect(out).toContain('1 captured memory candidate await');
        expect(out).toContain('node .codex/core/memory-capture.js list');
    });
    it('adds nothing when there are none, and nothing under MEMORY_PROFILE=minimal', () => {
        expect(processEvent({})).toEqual({ output: null });
        stage(1);
        process.env.MEMORY_PROFILE = 'minimal';
        expect(processEvent({})).toEqual({ output: null });
    });
});

describe('notes sync at session start (opt-in: MEMORY_SYNC=on)', () => {
    const note = (dir, file, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), `---\nname: ${file.slice(0, -3)}\ndescription: "d"\n---\n\n${body}\n`); };
    let memDir;
    beforeEach(() => {
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        memDir = path.join(tmp.root, 'notes-dir');
        process.env.MEMORY_DIR = memDir;
    });
    afterEach(() => { delete process.env.MEMORY_SYNC; delete process.env.MEMORY_DIR; });

    it('pulls notes other machines committed, silently', () => {
        note(path.join(tmp.root, 'docs/.output/.memory/notes'), 'theirs.md', 'from elsewhere');
        process.env.MEMORY_SYNC = 'on';
        expect(processEvent({}).output || '').not.toContain('<memory_sync>');
        expect(fs.existsSync(path.join(memDir, 'theirs.md'))).toBe(true);
    });
    it('does not touch anything while MEMORY_SYNC is off', () => {
        note(path.join(tmp.root, 'docs/.output/.memory/notes'), 'theirs.md', 'from elsewhere');
        processEvent({});
        expect(fs.existsSync(path.join(memDir, 'theirs.md'))).toBe(false);
    });
    it('names the resolve command, once, when a note changed on both sides', () => {
        process.env.MEMORY_SYNC = 'on';
        const tracked = path.join(tmp.root, 'docs/.output/.memory/notes');
        note(memDir, 'n.md', 'v1');
        note(tracked, 'n.md', 'v1');
        processEvent({});
        note(memDir, 'n.md', 'mine');
        note(tracked, 'n.md', 'theirs');
        const out = processEvent({}).output;
        expect(out).toContain('<memory_sync>');
        expect(out).toContain('n.md');
        expect(out).toContain('sync --prefer local|tracked');
    });
});
