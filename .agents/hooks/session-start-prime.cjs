#!/usr/bin/env node

/**
 * SessionStart Context Prime Hook
 *
 * Injects a bulleted list of the top-N structured memories as a
 * system-reminder at the opening of every Claude Code session. These are
 * the JSON memories produced by the Haiku extractor (or hand-created via
 * memory-manager.js) — the substantive, curated lessons — not the
 * compaction-snapshot concept articles at .state/memory-concepts/ (which tend
 * to be branch-activity meta-noise).
 *
 * Source: docs/.output/.memory/{category}/*.json
 *   where category in {patterns, constraints, decisions, workflows, rejected-approaches}
 *
 * Ranking (ME-4.2): importance_floored_decayed × recency_factor, with usage as a
 * TIEBREAKER only (not a primary multiplier — usage_count is a lower bound that
 * passive injection can't see, so it must not dominate ranking).
 *   - importance:         1–5 write-time score, applied as a retention-floor
 *                         factor on top of decayed_confidence (importance ≤2
 *                         sinks, ≥4 resists) — mirrors MemoryManager's own
 *                         adapter logic, computed locally (see below)
 *   - decayed_confidence: via the STANDALONE calculateDecayedConfidence() from
 *                         _lib/memory-decay.js (importance-aware), called directly
 *                         with activeDays omitted — NOT MemoryManager's method,
 *                         which would resolve activeDays via a synchronous
 *                         `git log` (see the HARD_TIMEOUT_MS note below for why
 *                         that's deliberately kept off this hot path). Decay here
 *                         is therefore calendar-days-based, same as the resolver's
 *                         own no-git fallback.
 *   - recency_factor:     1 / (1 + daysSinceLastUpdated); 1.0 if missing
 *   - usage tiebreaker:   halved-on-silence LIVE usage (SQLite index, MEM-7 —
 *                         the tracked JSON's usage_count is ~always 0), only
 *                         breaks score ties; falls back to raw_usage when unindexed
 *   - size budget:        top-N slice (N = MEMORY_PRIME_COUNT or DEFAULT_N=8, ≤MAX_N)
 *                         forces ranking down even when nothing has aged
 *   - superseded memories (invalid_at set) are never injected
 *
 * Output: XML-tagged markdown block written to stdout. Claude Code injects
 * hook stdout as a session system-reminder — no JSON envelope required.
 *
 * Gating:
 *   - MEMORY_PROFILE=minimal       → exits 0 with empty output
 *   - MEMORY_PRIME_COUNT env var   → overrides default N=8 (clamped 1..20)
 *
 * Safety: wraps everything in try/catch + a 2s hard timeout for ASYNC hangs
 * (e.g. a promise that never resolves). That timeout is a `setTimeout`, which
 * cannot preempt synchronous blocking code — it only fires once the event loop
 * is free. This module deliberately avoids any synchronous blocking call on
 * its main path (see the `calculateDecayedConfidence` note above and the
 * HARD_TIMEOUT_MS comment below) so the hard timeout's async-hang coverage is
 * not a false guarantee for this path. On any failure exits 0 silently so a
 * bug here can never block session start.
 *
 * Exit codes: always 0
 */

const fs = require('fs');
const path = require('path');
// Background rebuild spawn. spawnBackground resolves child_process.spawn
// at call time, so tests observe it with vi.spyOn(childProcess, 'spawn').
const { spawnBackground } = require('../core/_lib/hook-spawners');
const { isAtLeast } = require('../core/profile');
const CONSTANTS = require('../core/constants');
const { resolveProjectRoot } = require('../core/_lib/project-root');
const { memoryPaths } = require('../core/_lib/memory-paths');
const { appendJsonl } = require('../core/_lib/jsonl-writer');
const { readIndexRows, readRebuildStatus, indexDivergence, hasDivergence } = require('../core/_lib/memory-index-divergence');
// Referenced via the module object (not destructured) so tests can
// vi.spyOn(memoryDecay, 'calculateDecayedConfidence') and have it take effect
// here — a destructured const would freeze the original reference at require
// time, invisible to a later property-level mock under plain CJS `require`.
const memoryDecay = require('../core/_lib/memory-decay');
const { halveUsageCount } = memoryDecay;

const USAGE_HALVE_EVERY_DAYS = CONSTANTS.MEMORY_DECAY.USAGE_HALVE_EVERY_DAYS;
const IMPORTANCE_DEFAULT = CONSTANTS.MEMORY_FILTERS.IMPORTANCE_DEFAULT;

// ME-2.2 importance retention floor, computed locally rather than via
// MemoryManager.calculateDecayedConfidence() (which this file deliberately
// avoids — see the calculateDecayedConfidence note in the module header).
// Mirrors memory-manager.js's clampImportance/IMPORTANCE_MIN/MAX (not exported
// there, and that file is out of scope this pass) — a trivial 1–5 int clamp,
// safe to keep in sync manually if the range ever changes.
const IMPORTANCE_MIN = 1;
const IMPORTANCE_MAX = 5;
function clampImportance(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return IMPORTANCE_DEFAULT;
    return Math.max(IMPORTANCE_MIN, Math.min(IMPORTANCE_MAX, n));
}

// Covers ASYNC hangs only (a setTimeout can't preempt a blocked event loop, so
// it can never interrupt synchronous work). rankConcepts() is kept free of any
// synchronous blocking call (notably MemoryManager's git-log-backed
// calculateDecayedConfidence — see that function's own comment) specifically
// so this timeout's guarantee stays real for this path.
const HARD_TIMEOUT_MS = 2000;
const SOFT_BUDGET_MS = 500;
const DEFAULT_N = 8;
const MAX_N = 20;
const SUMMARY_MAX = 160;
const MEMORY_CATEGORIES = Object.values(CONSTANTS.MEMORY_CATEGORIES);

function parseMemory(content, category, filename) {
    let json;
    try {
        json = JSON.parse(content);
    } catch {
        return null;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

    const slug = filename.replace(/\.json$/, '');
    const id = typeof json.id === 'string' && json.id ? json.id : slug;

    let summary = '';
    if (json.content && typeof json.content === 'object') {
        if (typeof json.content.description === 'string') {
            summary = json.content.description;
        } else if (typeof json.content.summary === 'string') {
            summary = json.content.summary;
        }
    } else if (typeof json.content === 'string') {
        summary = json.content;
    }
    summary = summary.trim();
    if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 3) + '...';

    let confidence = 0.6;
    if (json.metadata && Number.isFinite(json.metadata.confidence)) {
        confidence = json.metadata.confidence;
    } else if (Number.isFinite(json.confidence)) {
        confidence = json.confidence;
    }

    // MEM-9: no artificial floor — a never-used memory must read as 0 usage, not 1.
    // Flooring to 1 gave every memory a uniform +USAGE_BOOST in the primary decay
    // score regardless of real usage (this JSON value is ~always 0 anyway per F44;
    // see rankConcepts, which prefers the live SQLite count over this baseline).
    const rawUsage = Number.isFinite(json.usage_count) ? json.usage_count : 0;
    const usage_count = rawUsage;

    // ME-4.2: importance (1–5) is the PRIMARY ranking signal — top-level, then
    // content, default IMPORTANCE_DEFAULT. raw_usage (unfloored) is the tiebreaker input.
    let importance = IMPORTANCE_DEFAULT;
    if (Number.isFinite(json.importance)) importance = json.importance;
    else if (json.content && Number.isFinite(json.content.importance)) importance = json.content.importance;

    // Supersession (ME-3.x): a superseded memory must never be injected.
    const invalid_at = typeof json.invalid_at === 'string' ? json.invalid_at : null;

    const updated = typeof json.updated === 'string' ? json.updated : null;
    const created = typeof json.created === 'string' ? json.created : null;

    return {
        slug: id,
        title: id,
        category,
        confidence,
        updated,
        created,
        usage_count,
        raw_usage: rawUsage,
        importance,
        invalid_at,
        summary: summary || '(no summary)'
    };
}

/**
 * @param {Array<object>} concepts - parsed memories to rank in place
 * @param {object} manager - MemoryManager instance. Kept for call-signature
 *   compatibility with memory-stability.js (CONTRACT NOTE below) — no longer
 *   used to compute decay (see the calculateDecayedConfidence note in the
 *   module header for why: manager.calculateDecayedConfidence() resolves
 *   activeDays via a synchronous `git log`, which this hot path avoids).
 * @param {Map<string, number>} [liveUsage] - MEM-7: live usage_count keyed by
 *   memory id, read ONCE via manager._indexUsageMap() by the caller. The tracked
 *   JSON's usage_count is permanently ~0 (F44 — live usage lives only in the
 *   gitignored SQLite index), so this is the real source for the TIEBREAK ONLY
 *   (see the PRIMARY-score note below for why it must not feed the primary score
 *   too). Falls back to raw_usage/0 per-concept when a slug isn't in the map
 *   (SQLite unavailable, or never indexed).
 */
function rankConcepts(concepts, manager, liveUsage = new Map()) {
    const now = Date.now();

    for (const c of concepts) {
        const importance = Number.isFinite(c.importance) ? c.importance : IMPORTANCE_DEFAULT;
        const rawUsage = Number.isFinite(c.raw_usage) ? c.raw_usage : 0;
        // MEM-7: prefer the live SQLite count over the ~always-0 JSON baseline —
        // TIEBREAK input only (see below for why the primary score never sees usage at all).
        const effectiveUsage = liveUsage.has(c.slug) ? liveUsage.get(c.slug) : rawUsage;

        let decayed = 0.6;
        try {
            // importance is the PRIMARY signal, expressed through decayed_confidence
            // (a low-importance memory sinks, a high-importance one resists decay) —
            // applied below as a separate factor (see the standalone-function note).
            // MEM-9/wave-5 hardening: usageCount is HARDCODED to 0 here, never
            // rawUsage or effectiveUsage — calculateDecayedConfidence adds
            // usageCount*USAGE_BOOST to the PRIMARY score, and this file's own
            // contract (see the comment a few lines below, and the module header)
            // is "usage breaks ties, never a primary factor." Wave 4 relied on
            // rawUsage staying ~0 in practice (F44) to keep this term negligible;
            // wave-5 code review (via a test that fed a synthetic large raw_usage)
            // proved that's a landmine, not a guarantee — a memory with a non-zero
            // tracked usage_count (e.g. a hand-created or legacy memory) would let
            // usage inflate the PRIMARY score, not just the tiebreak. Hardcoding 0
            // removes the dependency on that invariant entirely: usage reaches
            // ranking exclusively through usageTiebreak below.
            //
            // Call the STANDALONE calculateDecayedConfidence (imported directly from
            // _lib/memory-decay.js) rather than manager.calculateDecayedConfidence().
            // The manager method resolves `activeDays` via a synchronous `git log`
            // (createActiveDaysResolver -> getActiveDaysSince), which this file's
            // HARD_TIMEOUT_MS setTimeout cannot preempt once the call stack is
            // blocked inside it. `activeDays` is intentionally omitted here so the
            // pure function falls back to calendar days (its documented behavior
            // when the arg is absent) — the same fallback the resolver itself uses
            // when git is unavailable, so this is a pre-existing, exercised code
            // path, not a new decay regime.
            //
            // The standalone function does NOT take `importance` (it only knows
            // confidence/category/usage/updated/activeDays) — the ME-2.2 importance
            // retention floor is applied as a SEPARATE factor afterward, replicating
            // manager.calculateDecayedConfidence()'s own adapter logic exactly
            // (base * (clampedImportance / IMPORTANCE_DEFAULT), capped at 1.0).
            const base = memoryDecay.calculateDecayedConfidence({
                confidence: c.confidence,
                category: c.category,
                updated: c.updated || new Date().toISOString(),
                usageCount: 0
            });
            const importanceFactor = clampImportance(importance) / IMPORTANCE_DEFAULT;
            decayed = Math.min(1.0, base * importanceFactor);
        } catch {
            decayed = c.confidence;
        }

        let recency = 1.0;
        let daysSinceUpdated = 0;
        if (c.updated) {
            const days = (now - new Date(c.updated).getTime()) / (1000 * 60 * 60 * 24);
            if (Number.isFinite(days) && days >= 0) {
                daysSinceUpdated = days;
                recency = 1 / (1 + days);
            }
        }

        // Primary score: importance-floored decay × recency. Usage is NOT a factor
        // here — it only breaks ties below (it's a lower bound, must not dominate).
        c.score = decayed * recency;
        c.decayed = decayed;
        // Tiebreaker: live usage (falling back to raw), halved as it goes silent
        // (TinyLFU-style aging) so a once-popular-now-cold memory doesn't win ties
        // forever.
        c.usageTiebreak = halveUsageCount(effectiveUsage, daysSinceUpdated, USAGE_HALVE_EVERY_DAYS);
    }

    // Importance-floored decay × recency is primary; usage only breaks ties.
    concepts.sort((a, b) => {
        if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
        return (b.usageTiebreak || 0) - (a.usageTiebreak || 0);
    });
    return concepts;
}

function renderOutput(topConcepts, totalCount) {
    const lines = topConcepts.map(c => {
        const confStr = c.decayed.toFixed(2);
        const cat = c.category ? ` [${c.category}]` : '';
        return `- **${c.slug}**${cat} (conf: ${confStr}) — ${c.summary}`;
    });

    return `<project_memory>
# Project Memory

Top ${topConcepts.length} of ${totalCount} structured memories (ranked by importance-floored confidence × recency; usage breaks ties).

${lines.join('\n')}
</project_memory>
`;
}

/**
 * Cross-machine self-heal (ADR 0006 Amendment 2): the curated JSON source is now
 * TRACKED and syncs over git, but the FTS5 index (.state/memory-index/memories.db)
 * is gitignored and per-machine. After a `git pull` brings in new/updated .memory
 * JSON, the local db is stale (or absent on a fresh clone) — search would miss the
 * synced memories until something rebuilds. This check rebuilds it on stale:
 * if the newest .memory JSON file is newer than the db (or the db is missing), it
 * fires a background `rebuild-index` and returns immediately. Fire-and-forget so
 * session start never blocks; the child goes through the shared spawnBackground
 * (stdio ignored, windowsHide, detached on Windows so it survives this hook's exit —
 * constraints/windows-hook-background-child-needs-detached).
 * Staleness = newest JSON mtime under any .memory category dir vs the db mtime.
 * Until the rebuild lands, search degrades to the JSON-scan fallback — never empty.
 * Mtime cannot see a PARTIAL index that incremental writes keep newer than the
 * JSON, or a row whose eligibility went stale; processEvent covers both with
 * healDivergentIndex.
 * Returns true when it started a rebuild, so processEvent never spawns a second.
 */
function maybeRebuildIndex(jsonRoot, dbPath, projectDir, newestJsonMtime) {
    try {
        // F78: processEvent's memory-read loop already stats every JSON file —
        // it passes the newest mtime in, so this hot SessionStart path walks
        // the store ONCE, not twice. The self-scan below remains for callers
        // that don't have the value in hand.
        let newestJson = typeof newestJsonMtime === 'number' ? newestJsonMtime : 0;
        if (newestJson === 0 && newestJsonMtime === undefined) {
            for (const category of MEMORY_CATEGORIES) {
                let files;
                try { files = fs.readdirSync(path.join(jsonRoot, category)); } catch { continue; }
                for (const f of files) {
                    if (!f.endsWith('.json')) continue;
                    const m = fs.statSync(path.join(jsonRoot, category, f)).mtimeMs;
                    if (m > newestJson) newestJson = m;
                }
            }
        }
        if (newestJson === 0) return false;           // no source → nothing to rebuild
        let dbMtime = 0;
        try { dbMtime = fs.statSync(dbPath).mtimeMs; } catch { dbMtime = 0; }  // absent → 0
        if (dbMtime >= newestJson) return false;      // index fresh by mtime (completeness: see processEvent)
        return spawnRebuild(projectDir);
    } catch { return false; /* never block session start */ }
}

/**
 * Start one background `rebuild-index` that survives this hook's exit (shared
 * spawnBackground: detached on Windows, where a non-detached child is killed with
 * its parent's job; stdio ignored; windowsHide; unref). Non-blocking.
 * Returns true when the child was started.
 */
function spawnRebuild(projectDir) {
    try {
        const cli = path.join(__dirname, '..', 'core', 'memory-manager-cli.js');
        spawnBackground(process.execPath, [cli, 'rebuild-index'], { cwd: projectDir });
        return true;
    } catch {
        return false; // never block session start
    }
}

/**
 * Content self-heal the mtime check cannot provide. Any incremental index
 * write (createMemory, updateMemory, a recall's usage bump) keeps the db newer than
 * every JSON record, so a partial index, or a row whose eligibility went stale after
 * a pulled retirement, would read as fresh forever. Compare the store with the index
 * (shared _lib/memory-index-divergence.js) and start one background rebuild when
 * they diverge. Files the last rebuild could not index are excused until they
 * change, and named on stderr. No index (SQLite unavailable) → nothing to heal.
 *
 * @returns {boolean} true when a rebuild was started
 */
function healDivergentIndex(manager, records, dbPath, projectDir) {
    if (!manager.db) return false;
    const rows = readIndexRows(manager.db);
    if (!rows) return false;
    const divergence = indexDivergence(records, rows, readRebuildStatus(dbPath));
    if (divergence.excused.length > 0) {
        process.stderr.write(`[session-start-prime] memory index skips ${divergence.excused.length} record(s) the last rebuild could not index: ${divergence.excused.join(', ')}; fix them, then run memory-manager rebuild-index\n`);
    }
    return hasDivergence(divergence) ? spawnRebuild(projectDir) : false;
}

function processEvent(_parsedJson) {
    if (!isAtLeast('standard')) {
        return { output: null };
    }

    // Split store (ADR 0006 Amendment 2): prime from the TRACKED JSON source
    // (jsonRoot, current worktree — git checks it out everywhere). projectDir
    // keeps the MAIN-worktree anchor for the gitignored .state/ telemetry write
    // below (shared across worktrees, the memory-loss fix).
    const projectDir = resolveProjectRoot(path.resolve(__dirname, '..', '..'));
    const { jsonRoot: memoriesDir, dbPath } = memoryPaths(path.resolve(__dirname, '..', '..'));

    const rawN = parseInt(process.env.MEMORY_PRIME_COUNT, 10);
    const N = Number.isFinite(rawN)
        ? Math.min(MAX_N, Math.max(1, rawN))
        : DEFAULT_N;

    // F78: ONE pass over the store — this loop reads every memory anyway, so it
    // also tracks the newest JSON mtime for the index-freshness check below
    // (maybeRebuildIndex used to run its own second readdir+stat traversal
    // first, on a latency-budgeted SessionStart path).
    const memories = [];
    const records = [];
    let incompleteSnapshot = false;
    let newestJsonMtime = 0;
    for (const category of MEMORY_CATEGORIES) {
        const catDir = path.join(memoriesDir, category);
        if (!fs.existsSync(catDir)) continue;
        let files;
        try {
            files = fs.readdirSync(catDir).filter(f => f.endsWith('.json'));
        } catch (error) {
            incompleteSnapshot = true;
            process.stderr.write(`[session-start-prime] cannot enumerate memory source ${category}/: ${error.message}; fix it, then run memory-manager rebuild-index\n`);
            continue;
        }
        for (const file of files) {
            const filePath = path.join(catDir, file);
            try {
                const m = fs.statSync(filePath).mtimeMs;
                if (m > newestJsonMtime) newestJsonMtime = m;
                const content = fs.readFileSync(filePath, 'utf8');
                const parsed = parseMemory(content, category, file);
                if (parsed) {
                    // Every record, live and retired, for the index comparison.
                    records.push({
                        file: `${category}/${file}`, id: parsed.slug, invalid_at: parsed.invalid_at,
                        updated: parsed.updated, created: parsed.created, mtimeMs: m,
                    });
                    // Never inject a superseded memory (ME-3.x / ME-4.2).
                    if (!parsed.invalid_at) memories.push(parsed);
                } else {
                    process.stderr.write(`[session-start-prime] cannot read memory source ${category}/${file}: invalid memory JSON; fix it, then run memory-manager rebuild-index\n`);
                }
            } catch (error) {
                process.stderr.write(`[session-start-prime] cannot read memory source ${category}/${file}: ${error.message}; fix it, then run memory-manager rebuild-index\n`);
            }
        }
    }

    // Self-heal the FTS5 index from the synced JSON source (background,
    // non-blocking spawn — ordering vs the JSON reads above is irrelevant,
    // they never touch the db). Newest mtime handed in from the single pass.
    const rebuildStarted = !incompleteSnapshot && maybeRebuildIndex(memoriesDir, dbPath, projectDir, newestJsonMtime);

    // Empty source still needs to remove orphaned live rows in an existing
    // index. Avoid creating an index solely to check an empty fresh project.
    if (memories.length === 0 && !fs.existsSync(dbPath)) return { output: null };

    const MemoryManager = require('../core/memory-manager');
    const manager = new MemoryManager();
    // MEM-7: one query for the live SQLite usage counts, threaded through so the
    // tiebreak (and MEM-9's primary-score input) reads real usage instead of the
    // ~always-0 tracked-JSON baseline. Degrades to an empty Map (raw_usage
    // fallback) if SQLite is unavailable.
    const liveUsage = manager._indexUsageMap();
    // Heal a divergent index the mtime check cannot see (at most one spawn
    // per start; one small id/invalid_at/updated query).
    if (!rebuildStarted && !incompleteSnapshot) healDivergentIndex(manager, records, dbPath, projectDir);
    if (memories.length === 0) return { output: null };
    rankConcepts(memories, manager, liveUsage);

    // Size budget (ME-4.2): hard top-N cap. Even on an active project where
    // nothing has aged below threshold, this forces ranking down to the budget so
    // the injected tier always earns its tokens.
    const top = memories.slice(0, N);
    const output = renderOutput(top, memories.length);

    // MP-1.2: record which memories were surfaced this session start, so hit-rate
    // analysis has a denominator. Best-effort — a telemetry failure here must
    // never break injection, so the whole write is wrapped and swallowed.
    // When 0 memories are injected the function returns earlier (line ~179), so
    // this only logs real injections (injected_count >= 1).
    try {
        const ts = new Date().toISOString();
        const jsonlPath = path.join(projectDir, 'docs', '.output', '.state', 'telemetry', 'memory-injection.jsonl');
        appendJsonl(jsonlPath, {
            timestamp: ts,
            type: 'memory_injection',
            injected_count: top.length,
            total_available: memories.length,
            injected_ids: top.map(c => c.slug),
            session_proxy: ts.slice(0, 16),   // ISO-8601 truncated to the minute — session join key
        });
    } catch {
        // best-effort — injection output still prints
    }

    return { output };
}

if (require.main === module) {
    const hardExit = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS);
    hardExit.unref();

    process.on('uncaughtException', () => process.exit(0));
    process.on('unhandledRejection', () => process.exit(0));

    (async () => {
        const start = process.hrtime.bigint();

        try {
            const result = processEvent({});

            if (result.output !== null) {
                process.stdout.write(result.output);

                const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
                if (elapsedMs > SOFT_BUDGET_MS) {
                    process.stderr.write(
                        `[session-start-prime] ${elapsedMs.toFixed(0)}ms (budget ${SOFT_BUDGET_MS}ms)\n`
                    );
                }
            }
        } catch {
            // Never break session start
        }

        process.exit(0);
    })();
}

// CONTRACT (F49): rankConcepts + parseMemory are consumed by
// .claude/core/memory-stability.js — the benchmark deliberately drives THIS
// file's real injection ranker, not a reimplementation. Renaming or inlining
// either export breaks that tool; update both files together.
module.exports = { processEvent, rankConcepts, renderOutput, parseMemory };
