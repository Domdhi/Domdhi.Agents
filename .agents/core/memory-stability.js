#!/usr/bin/env node

/**
 * memory-stability.js — Does store SIZE change what gets injected, and does it
 * beat nothing? A measurement harness for the value of the memory system.
 *
 * WHY THIS EXISTS (vs memory-eval.js)
 *   memory-eval.js answers "given that memories matter, does pruning improve
 *   hit@k retrieval?" — it presupposes the system has value and optimizes
 *   ranking. This harness answers the prior questions:
 *
 *     Q1 (SIZE):     As the store grows 19 → 100 → 1000, do the genuinely
 *                    high-value memories stay in the injected top-N, or does
 *                    accumulation bury them? At what size does growth start
 *                    costing you?  → synthetic-growth simulation
 *     Q2 (CHURN):    How much does the injected set actually move session to
 *                    session in real history?  → empirical, from telemetry
 *
 *   It drives the REAL injection ranker (rankConcepts from
 *   session-start-prime.cjs) — not a reimplementation — so it measures the
 *   selection logic that actually runs in production.
 *
 * WHAT IT DOES NOT ANSWER
 *   The full counterfactual "memory-on vs memory-off changes the agent's
 *   OUTPUT quality" requires running real tasks both ways and judging the
 *   results (the Phase-2 ablation protocol, documented in the findings doc).
 *   This harness measures the channel (injection) and its degradation with
 *   size — a necessary, cheap precondition, not the whole benefit case.
 *
 * THE CORE IDEA
 *   Injection is a fixed top-N slice. Extra memories only matter if they reach
 *   that slice. So "does size matter" reduces to: as filler accumulates, how
 *   many of today's real top-N survive in the top-N? If it stays N/N, store
 *   size past today is FREE (extra memories never inject — only add search /
 *   lint noise). If it drops, growth is actively burying signal and size HURTS.
 *   The answer depends entirely on what accumulating memories look like, so we
 *   bracket it with three filler profiles.
 *
 * USAGE
 *   node .claude/core/memory-stability.js                 # real store, all profiles
 *   node .claude/core/memory-stability.js --profile decoy # one profile
 *   node .claude/core/memory-stability.js --n 8 --sizes 50,100,250,500,1000
 *   node .claude/core/memory-stability.js --json          # machine-readable
 *
 * FILLER PROFILES (what does accumulating cruft look like?)
 *   mirror  — filler ~ the real store's own (importance, confidence, age) joint
 *             distribution. "Future memories look like current ones." Neutral.
 *   decoy   — filler is FRESH (0–2 days) with top-quartile importance. Worst
 *             case: self-important, recent noise competing on recency.
 *   lowval  — filler is OLD and importance 1–2. Best case: cruft is genuinely
 *             low-value and decays/sinks on its own.
 *
 * EXIT 0 always (analysis tool). Deterministic: seeded PRNG, no Math.random.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// F49: a deliberate, documented core/→hooks/ import — the benchmark MUST drive
// the hook's real ranker (a _lib copy would drift and benchmark the wrong
// thing). The hook's module.exports carries the matching contract note; this
// is the single sanctioned exception to the hooks-consume-core direction.
const { rankConcepts, parseMemory } = require('../hooks/session-start-prime.cjs');
const MemoryManager = require('./memory-manager');
const CONSTANTS = require('./constants');
const { memoryPaths } = require('./_lib/memory-paths');

const MEMORY_CATEGORIES = Object.values(CONSTANTS.MEMORY_CATEGORIES);
const DEFAULT_N = 8;
const DEFAULT_SIZES = [50, 100, 250, 500, 1000];
const PROFILES = ['mirror', 'decoy', 'lowval'];
const MS_PER_DAY = 1000 * 60 * 60 * 24;

// ─── Seeded PRNG (mulberry32) — deterministic, reproducible runs ───────────────
function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ─── Load the real store (using the production parser) ─────────────────────────
function loadRealConcepts(memoriesDir) {
    const out = [];
    for (const category of MEMORY_CATEGORIES) {
        const catDir = path.join(memoriesDir, category);
        if (!fs.existsSync(catDir)) continue;
        let files;
        try { files = fs.readdirSync(catDir).filter(f => f.endsWith('.json')); }
        catch { continue; }
        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(catDir, file), 'utf8');
                const parsed = parseMemory(content, category, file);
                if (parsed && !parsed.invalid_at) out.push(parsed);
            } catch { /* skip */ }
        }
    }
    return out;
}

// Age in days from an ISO `updated` string (0 if missing/invalid).
function ageDays(updated, now) {
    if (!updated) return 0;
    const d = (now - new Date(updated).getTime()) / MS_PER_DAY;
    return Number.isFinite(d) && d >= 0 ? d : 0;
}

function isoForAge(days, now) {
    return new Date(now - days * MS_PER_DAY).toISOString();
}

// ─── Synthetic filler generator ───────────────────────────────────────────────
// Produces concept objects in parseMemory's output shape so they feed straight
// into the real rankConcepts(). Distribution is set by `profile`, sampled from
// the real store's own (importance, confidence, age) tuples where relevant.
function makeFiller(realConcepts, profile, count, rng, now) {
    const imps = realConcepts.map(c => c.importance);
    const confs = realConcepts.map(c => c.confidence);
    const ages = realConcepts.map(c => ageDays(c.updated, now));
    const topQuartileImp = [...imps].sort((a, b) => b - a)
        .slice(0, Math.max(1, Math.ceil(imps.length / 4)));

    const filler = [];
    for (let i = 0; i < count; i++) {
        let importance, confidence, age;
        if (profile === 'mirror') {
            // i.i.d. from the real joint distribution (sample a real row whole-cloth)
            const j = Math.floor(rng() * realConcepts.length);
            importance = imps[j]; confidence = confs[j]; age = ages[j] * (0.5 + rng());
        } else if (profile === 'decoy') {
            importance = pick(rng, topQuartileImp);
            confidence = 0.75 + rng() * 0.2;
            age = rng() * 2;                       // fresh: 0–2 days
        } else { // lowval
            importance = 1 + Math.floor(rng() * 2); // 1–2
            confidence = 0.2 + rng() * 0.3;
            age = 30 + rng() * 120;                 // old: 30–150 days
        }
        const updated = isoForAge(age, now);
        filler.push({
            slug: `synthetic-${profile}-${i}`,
            title: `synthetic-${profile}-${i}`,
            category: pick(rng, ['patterns', 'constraints', 'workflows']),
            confidence,
            updated,
            usage_count: 1,
            raw_usage: 0,
            importance,
            invalid_at: null,
            summary: `synthetic filler (${profile})`,
            __synthetic: true,
        });
    }
    return filler;
}

// rankConcepts mutates + sorts in place, so hand it a shallow-cloned array each call.
function rankedTopN(concepts, manager, n) {
    const copies = concepts.map(c => ({ ...c }));
    rankConcepts(copies, manager);
    return copies.slice(0, n);
}

const jaccard = (a, b) => {
    const A = new Set(a), B = new Set(b);
    const inter = [...A].filter(x => B.has(x)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 1 : inter / union;
};

// ─── Q1: synthetic-growth simulation ──────────────────────────────────────────
function runGrowth(realConcepts, profile, sizes, n, manager, now, seed) {
    const rng = makeRng(seed);
    const baseTop = rankedTopN(realConcepts, manager, n);
    const baseTopIds = baseTop.map(c => c.slug);
    const realIds = new Set(realConcepts.map(c => c.slug));

    const rows = [];
    let prevTopIds = baseTopIds;
    let burialSize = null;

    for (const size of sizes) {
        if (size <= realConcepts.length) continue;
        const filler = makeFiller(realConcepts, profile, size - realConcepts.length, rng, now);
        const top = rankedTopN([...realConcepts, ...filler], manager, n);
        const topIds = top.map(c => c.slug);

        const coreRetained = baseTopIds.filter(id => topIds.includes(id)).length;
        const syntheticInTop = topIds.filter(id => !realIds.has(id)).length;
        const churn = 1 - jaccard(prevTopIds, topIds);

        if (burialSize === null && coreRetained < n) burialSize = size;

        rows.push({ size, coreRetained, n, syntheticInTop, churnVsPrev: churn });
        prevTopIds = topIds;
    }
    return { profile, baseTopIds, rows, burialSize };
}

// ─── Q2: empirical churn from injection telemetry ─────────────────────────────
function runEmpirical(telemetryPath) {
    if (!fs.existsSync(telemetryPath)) return null;
    let records;
    try {
        records = fs.readFileSync(telemetryPath, 'utf8')
            .split('\n').filter(Boolean).map(l => JSON.parse(l))
            .filter(r => Array.isArray(r.injected_ids));
    } catch { return null; }
    records.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

    const rows = [];
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const churn = i === 0 ? null : 1 - jaccard(records[i - 1].injected_ids, r.injected_ids);
        rows.push({
            session: (r.timestamp || '').slice(0, 16),
            totalAvailable: r.total_available,
            injected: r.injected_count,
            churnVsPrev: churn,
        });
    }
    return rows;
}

// ─── Reporting ────────────────────────────────────────────────────────────────
function pct(x) { return (x * 100).toFixed(0) + '%'; }

function printReport(realConcepts, growthResults, empirical, n) {
    const byCat = {};
    for (const c of realConcepts) byCat[c.category] = (byCat[c.category] || 0) + 1;
    const catStr = Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(', ');

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  MEMORY INJECTION STABILITY — does store size change injection?');
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log(`  Real store: ${realConcepts.length} memories (${catStr})`);
    console.log(`  Injection budget N = ${n} (the production top-N slice)\n`);

    console.log('  Current injected top-N (real store, real ranker):');
    const base = growthResults[0].baseTopIds;
    base.forEach((id, i) => console.log(`    ${String(i + 1).padStart(2)}. ${id}`));
    console.log('');

    console.log('  Q1 — SYNTHETIC GROWTH: how many of today\'s top-N survive as the');
    console.log('       store grows? (core_retained = signal kept; the rest is buried)\n');

    for (const g of growthResults) {
        console.log(`  ── profile: ${g.profile} ──────────────────────────────────────`);
        console.log('     size │ core kept │ synthetic in top │ churn vs prev');
        console.log('     ─────┼───────────┼──────────────────┼──────────────');
        for (const r of g.rows) {
            const kept = `${r.coreRetained}/${r.n}`.padStart(7);
            const syn = String(r.syntheticInTop).padStart(10);
            const ch = pct(r.churnVsPrev).padStart(8);
            console.log(`     ${String(r.size).padStart(4)} │  ${kept}  │ ${syn}       │ ${ch}`);
        }
        if (g.burialSize) {
            console.log(`     ⚠  signal burial begins at size ${g.burialSize} ` +
                `(first real memory pushed out of top-${n})`);
        } else {
            console.log(`     ✓  no burial up to size ${g.rows.at(-1)?.size ?? '—'} ` +
                `— extra memories never reach injection (size is free here)`);
        }
        console.log('');
    }

    console.log('  Q2 — EMPIRICAL CHURN (from memory-injection.jsonl):');
    if (!empirical || empirical.length === 0) {
        console.log('     (no injection telemetry yet)\n');
    } else {
        console.log('     session          │ total avail │ injected │ churn vs prev');
        console.log('     ─────────────────┼─────────────┼──────────┼──────────────');
        for (const r of empirical) {
            const ch = r.churnVsPrev === null ? '   —' : pct(r.churnVsPrev);
            console.log(`     ${r.session.padEnd(16)} │ ${String(r.totalAvailable).padStart(11)} │ ` +
                `${String(r.injected).padStart(8)} │ ${ch.padStart(8)}`);
        }
        console.log(`     (${empirical.length} sessions — churn here is real history, ` +
            `but only over the size range the store has actually traversed)\n`);
    }

    console.log('  HOW TO READ THIS');
    console.log('     • core kept stays N/N at every size  → store size past today is');
    console.log('       FREE: extra memories never inject, they only add search/lint');
    console.log('       noise. The cap debate is then about noise, not injection value.');
    console.log('     • core kept DROPS → growth is burying high-value memories; size');
    console.log('       actively hurts, and the burial size is your real ceiling.');
    console.log('     • Compare profiles: mirror = honest baseline, decoy = worst case,');
    console.log('       lowval = if cruft is genuinely low-value. The truth is bracketed.');
    console.log('');
    console.log('  NOT ANSWERED HERE: whether injection changes the agent\'s OUTPUT');
    console.log('  (memory-on vs off). That needs the Phase-2 task ablation — see the');
    console.log('  findings doc. This measures the channel and its decay with size.');
    console.log('═══════════════════════════════════════════════════════════════');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
    const args = process.argv.slice(2);
    const getFlag = (name, def) => {
        const i = args.indexOf(name);
        return i !== -1 && args[i + 1] ? args[i + 1] : def;
    };
    const n = parseInt(getFlag('--n', String(DEFAULT_N)), 10) || DEFAULT_N;
    const sizes = getFlag('--sizes', DEFAULT_SIZES.join(','))
        .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
    const profileArg = getFlag('--profile', null);
    const profiles = profileArg ? [profileArg] : PROFILES;
    const asJson = args.includes('--json');
    const seed = parseInt(getFlag('--seed', '1337'), 10) || 1337;

    // Worktree-safe resolution (M5): the tracked .memory/ source follows the CURRENT
    // worktree while the gitignored .state/ telemetry anchors to the MAIN worktree —
    // memoryPaths() splits both, matching memory-manager.js.
    const paths = memoryPaths(path.resolve(__dirname, '..', '..'));
    const memoriesDir = paths.jsonRoot;
    const telemetryPath = path.join(paths.stateRoot, 'telemetry', 'memory-injection.jsonl');

    const realConcepts = loadRealConcepts(memoriesDir);
    if (realConcepts.length === 0) {
        console.error('[memory-stability] No real memories found at ' + memoriesDir);
        process.exit(0);
    }

    const manager = new MemoryManager();
    const now = Date.now();
    try {
        const growthResults = profiles.map(p =>
            runGrowth(realConcepts, p, sizes, n, manager, now, seed));
        const empirical = runEmpirical(telemetryPath);

        if (asJson) {
            console.log(JSON.stringify({
                realStoreSize: realConcepts.length, n, sizes,
                growth: growthResults, empirical,
            }, null, 2));
        } else {
            printReport(realConcepts, growthResults, empirical, n);
        }
    } finally {
        if (manager && manager.db) { try { manager.db.close(); } catch { /* */ } }
    }
}

// F50: guard like every sibling CLI in this zone — requiring this module as a
// library must never hit the real memory store or print a report.
if (require.main === module) main();
