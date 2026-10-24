#!/usr/bin/env node

/**
 * memory-eval.js — Retrieval-accuracy harness for the memory store.
 *
 * PURPOSE
 *   Proves that pruning, importance scoring, and supersession IMPROVE retrieval
 *   correctness rather than just shrinking the store. Methodology mirrors
 *   LongMemEval: run hit@k against a fixture of known-good (query, expected-id)
 *   pairs on TWO search passes — "pruned" (default, superseded excluded) and
 *   "keep-everything" (includeSuperseded: true) — then report the accuracy delta.
 *   A healthy store shows pruned >= keep-everything.
 *
 * USAGE
 *   # Self-seeding demo (seeds a temp store, evaluates, cleans up):
 *   node .claude/core/memory-eval.js
 *   node .claude/core/memory-eval.js --seed          # explicit
 *   node .claude/core/memory-eval.js --seed --k 5   # top-5 instead of top-3
 *
 *   # Evaluate against the REAL store in the current project:
 *   node .claude/core/memory-eval.js --real
 *   node .claude/core/memory-eval.js --real --k 5
 *
 *   # Include superseded in BOTH passes (shows them side-by-side):
 *   # (default behavior already does this — both passes are always run)
 *
 * npm script: "memory:eval": "node .claude/core/memory-eval.js"
 *
 * EXIT CODES
 *   0 — harness ran to completion (even if accuracy is 0%)
 *   1 — fatal error (fixture missing, manager threw, etc.)
 *
 * ACCEPTANCE CRITERIA (ME-5.1)
 *   - Loads fixture { query, expected[] } pairs.
 *   - Runs searchMemories() for each query and computes hit@k.
 *   - Runs BOTH pruned (default) AND keep-everything pass, prints delta.
 *   - Self-seeding: works headless with no preconditions (--seed or empty store).
 *   - Does NOT break the Vitest suite (this file is not a test).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const FIXTURE_PATH = path.join(
    __dirname, '__tests__', '_fixtures', 'memory-eval-queries.json'
);

const DEFAULT_K = 3;

// Inlined fallback for the query fixture. CRITICAL: the fixture above lives under
// __tests__/, which template-updater.js EXCLUDES from propagation — so adopters
// receive memory-eval.js WITHOUT the fixture and the harness used to die on a
// missing-file FATAL. These queries mirror the SEED_MEMORIES below (which are
// already inlined), keeping the self-seeding demo fully self-contained for any
// adopter. The external fixture, when present (the workshop), takes precedence.
const DEFAULT_QUERIES = [
    { query: 'DataContext factory concurrent rendering', expected: ['ssr-context-factory'] },
    { query: 'integration tests database no mocks', expected: ['integration-test-real-db'] },
    { query: 'terse responses no summary trailing', expected: ['terse-response-style'] },
    { query: 'git clean destructive delete untracked', expected: ['destructive-git-guard'] },
    { query: 'memory pruning importance supersession retrieval accuracy', expected: ['memory-pruning-improves-retrieval'] },
    { query: 'slash command telemetry usage logs', expected: ['command-usage-telemetry'] },
    { query: 'worktree isolation feature branch', expected: ['worktree-isolation-pattern'] },
    { query: 'secret scanner credential hook write edit', expected: ['secret-scanner-hook'] },
    { query: 'skill SKILL.md progressive disclosure references', expected: ['skill-progressive-disclosure'] },
    { query: 'memory decay active work days confidence', expected: ['memory-decay-active-days'] },
    { query: 'publish public repo manifest allowlist', expected: ['publish-two-repo-workflow'] },
    { query: 'sqlite FTS5 fulltext search fallback json scan', expected: ['sqlite-fts5-backend'] },
    { query: 'importance floor retention low importance memory', expected: ['importance-retention-floor'] },
    { query: 'hard gate prerequisite command sequence', expected: ['hard-gate-prereq'] },
    { query: 'agent memory inbox draft review promotion', expected: ['inbox-staging-protocol'] },
];

// Synthetic memories for the self-seeding demo.
// Each entry: { category, id, content, importance, supersede? }
// "supersede" means we create it THEN immediately supersede it with a newer id
// so it becomes noise in the keep-everything pass.
const SEED_MEMORIES = [
    // ── HIGH-IMPORTANCE LIVE MEMORIES (correct answers) ──────────────────────
    {
        category: 'constraints',
        id: 'ssr-context-factory',
        importance: 5,
        content: {
            description: 'Server-rendered UI requires AddDataContextFactory instead of AddDataContext. Components render concurrently within a circuit — a shared scoped DataContext causes InvalidOperationException. Each service method must call _contextFactory.CreateDataContext().',
            evidence: 'CLAUDE.md global instructions, Server-rendered UI section.',
            confidence: 0.9,
        },
    },
    {
        category: 'constraints',
        id: 'integration-test-real-db',
        importance: 4,
        content: {
            description: 'Integration tests must hit a real database — never mock the database. A prior incident showed mocked tests passed while the production migration failed silently.',
            evidence: 'Feedback from user: "we got burned last quarter when mocked tests passed but the prod migration failed".',
            confidence: 0.85,
        },
    },
    {
        category: 'constraints',
        id: 'destructive-git-guard',
        importance: 5,
        content: {
            description: 'Never run git clean -fd, git clean -f, git reset --hard, or rm -rf on user directories without explicit permission. Always show a dry-run and ask first. Deleting user work is unacceptable.',
            evidence: 'CLAUDE.md global section: ABSOLUTELY FORBIDDEN COMMANDS.',
            confidence: 0.95,
        },
    },
    {
        category: 'constraints',
        id: 'secret-scanner-hook',
        importance: 4,
        content: {
            description: 'The secret scanner runs ONLY as a Claude Code PreToolUse:Write/Edit hook. The legacy .githooks/pre-commit fallback was retired 2026-05-09. Manual git commit outside Claude Code gets no scan.',
            evidence: 'CLAUDE.md Hooks table; secret-scanner.cjs hook definition.',
            confidence: 0.8,
        },
    },
    {
        category: 'constraints',
        id: 'memory-decay-active-days',
        importance: 4,
        content: {
            description: 'Memory confidence decay is based on active work days (days with git commits), not calendar days. A project untouched for months has zero decay. Rates: decisions 0.98^days, constraints 0.97^days, patterns 0.95^days, workflows 0.93^days.',
            evidence: 'CLAUDE.md Memory System section; constants.js MEMORY_DECAY.',
            confidence: 0.85,
        },
    },
    {
        category: 'constraints',
        id: 'sqlite-fts5-backend',
        importance: 3,
        content: {
            description: 'Full-text search uses SQLite FTS5. On Node 24+ the built-in node:sqlite ships FTS5 compiled in, so search works with ZERO npm dependencies; better-sqlite3 is only an optional fallback for older Node. Falls back to a JSON linear scan if neither backend is available.',
            evidence: 'memory-manager.js SQLite backend resolution comment block; constraint memory node24-nodesqlite-ships-fts5-zero-deps.',
            confidence: 0.8,
        },
    },
    {
        category: 'patterns',
        id: 'memory-pruning-improves-retrieval',
        importance: 5,
        content: {
            description: 'Pruning superseded and low-importance memories improves hit@k retrieval accuracy. Keeping everything (includeSuperseded: true) surfaces stale noise above correct answers in top-k results, reducing accuracy. This pattern was validated by the ME-5.1 retrieval harness.',
            evidence: 'memory-eval.js self-seeding demo, ME-5.1 story.',
            confidence: 0.8,
        },
    },
    {
        category: 'patterns',
        id: 'command-usage-telemetry',
        importance: 3,
        content: {
            description: 'Slash command usage is logged to docs/.output/.state/telemetry/command-usage.jsonl by the command-usage-logger.cjs hook. Gate pass/fail outcome is read from _latest-summary.json and appended to the same file.',
            evidence: 'CLAUDE.md Hooks table; command-usage-logger.cjs.',
            confidence: 0.8,
        },
    },
    {
        category: 'patterns',
        id: 'skill-progressive-disclosure',
        importance: 4,
        content: {
            description: 'Heavy skill content should be moved out of SKILL.md into references/ subdirectories. SKILL.md loads on every activation; references/ files load only when a pointer in SKILL.md calls for them. This is the largest recurring token win in the system.',
            evidence: 'CLAUDE.md Skill Authoring section; split is described as "the largest recurring token win".',
            confidence: 0.85,
        },
    },
    {
        category: 'patterns',
        id: 'importance-retention-floor',
        importance: 4,
        content: {
            description: 'Memory importance (1-5) acts as a retention floor on the decay curve. Importance 3 = neutral factor 1.0. Importance <= 2 means a never-recalled memory can cross STALE_THRESHOLD even on an active repo. Importance >= 4 resists decay. Capped at 1.0.',
            evidence: 'memory-manager.js calculateDecayedConfidence; ME-2.2 comment.',
            confidence: 0.8,
        },
    },
    {
        category: 'workflows',
        id: 'worktree-isolation-pattern',
        importance: 3,
        content: {
            description: 'Use git worktrees for isolated feature branch work. Default location is a sibling root outside every repository: <parent of the main checkout>/.worktrees/<repo>/<branch>. Override order: explicit user request > project instruction > AGENTS_WORKTREE_ROOT (absolute) > the derived default. Base the branch on the current integration tip (origin/HEAD first). A directory inside the checkout must be Git-ignored; never edit .gitignore.',
            evidence: 'using-git-worktrees SKILL.md; finishing-a-development-branch SKILL.md.',
            confidence: 0.8,
        },
    },
    {
        category: 'workflows',
        id: 'publish-two-repo-workflow',
        importance: 3,
        content: {
            description: 'Publishing uses a two-repo workflow: private workshop repo publishes a curated subset to a public storefront repo via npm run publish:public. Only files in tools/publish-manifest.json are shipped. DEFAULT_EXCLUDES in publish.js always strips working state.',
            evidence: 'CLAUDE.md Publishing section.',
            confidence: 0.8,
        },
    },
    {
        category: 'workflows',
        id: 'hard-gate-prereq',
        importance: 3,
        content: {
            description: 'Create commands enforce prerequisite checks. /create:project-requirements needs a brief/brainstorm/research. /create:project-architecture needs requirements. /create:project-epics needs both requirements AND architecture. --yolo bypasses all gates.',
            evidence: 'CLAUDE.md Hard Gates table.',
            confidence: 0.85,
        },
    },
    {
        category: 'workflows',
        id: 'inbox-staging-protocol',
        importance: 4,
        content: {
            description: 'Sub-agents drop draft memories to docs/.output/.state/memory-inbox/ — never write directly to the curated store. Main Agent reviews with inbox-list, promotes keepers via inbox-promote (with optional category/id override), discards the rest with inbox-discard.',
            evidence: 'CLAUDE.md Memory System section; Memory Inbox Protocol in agent definitions.',
            confidence: 0.85,
        },
    },
    {
        category: 'constraints',
        id: 'terse-response-style',
        importance: 3,
        content: {
            description: 'User wants terse responses with no trailing summaries. Do not recap what was just done at the end of every response — they can read the diff.',
            evidence: 'Feedback from user about response style.',
            confidence: 0.8,
        },
    },

    // ── LOW-IMPORTANCE LIVE MEMORIES (noise — should stay below correct answers) ─
    {
        category: 'patterns',
        id: 'low-importance-noise-1',
        importance: 1,
        content: {
            description: 'Old note about DataContext usage in console apps. Not relevant to Server-rendered UI. This is noise.',
            evidence: 'Fictional old session.',
            confidence: 0.3,
        },
    },
    {
        category: 'patterns',
        id: 'low-importance-noise-2',
        importance: 1,
        content: {
            description: 'Rough note: integration tests ran slowly once. Might be due to database setup. Unclear.',
            evidence: 'Fictional old session.',
            confidence: 0.2,
        },
    },
    {
        category: 'patterns',
        id: 'low-importance-noise-3',
        importance: 1,
        content: {
            description: 'Vague note about git operations being slow on large repos.',
            evidence: 'Fictional old session.',
            confidence: 0.2,
        },
    },

    // ── MEMORIES THAT WILL BE SUPERSEDED (stale history — noise in keep-everything) ─
    // These have the SAME keywords as their successor queries so they rank in
    // top-k in the keep-everything pass, displacing the correct answer. That
    // demonstrates why pruned >= keep-everything on a well-managed store.
    {
        category: 'constraints',
        id: 'ssr-context-old',
        importance: 3,
        content: {
            description: 'Server-rendered UI concurrent rendering uses AddDataContext scoped per circuit. DataContext factory not required in older versions. (SUPERSEDED — factory pattern is now mandatory)',
            evidence: 'Old session note pre-factory-pattern.',
            confidence: 0.5,
        },
        supersedeWith: 'ssr-context-factory',
    },
    {
        category: 'patterns',
        id: 'memory-pruning-old',
        importance: 3,
        content: {
            description: 'Memory pruning importance supersession retrieval accuracy is unclear — may not improve results. Keeping everything may be safer. (SUPERSEDED — ME-5.1 harness confirms pruned beats keep-everything)',
            evidence: 'Speculative note before harness validation.',
            confidence: 0.4,
        },
        supersedeWith: 'memory-pruning-improves-retrieval',
    },
    {
        category: 'workflows',
        id: 'worktree-old',
        importance: 3,
        content: {
            description: 'Git worktrees create isolation for feature branch work but the workflow is informal. No standard directory or branch naming convention established yet. (SUPERSEDED — using-git-worktrees skill formalizes this)',
            evidence: 'Old note before skill was written.',
            confidence: 0.35,
        },
        supersedeWith: 'worktree-isolation-pattern',
    },
    {
        category: 'workflows',
        id: 'hard-gate-old',
        importance: 3,
        content: {
            description: 'Hard gate prerequisite command sequence is partially implemented. Some commands check for prior docs, others do not. Enforcement is inconsistent. (SUPERSEDED — full gate matrix now in CLAUDE.md)',
            evidence: 'Old note during gate implementation.',
            confidence: 0.3,
        },
        supersedeWith: 'hard-gate-prereq',
    },
    {
        category: 'workflows',
        id: 'inbox-staging-old',
        importance: 3,
        content: {
            description: 'Agent memory inbox draft promotion: agents write directly to memory store. Main agent reviews on /end. No staging layer. (SUPERSEDED — inbox-staging-protocol adds the required review gate)',
            evidence: 'Old incorrect note before inbox was introduced.',
            confidence: 0.3,
        },
        supersedeWith: 'inbox-staging-protocol',
    },
    {
        category: 'constraints',
        id: 'git-destructive-old',
        importance: 3,
        content: {
            description: 'Git clean destructive delete untracked files: show warning but proceed. The user trusts Claude to handle cleanup. (SUPERSEDED — always ask first, never auto-run git clean)',
            evidence: 'Old incorrect policy note.',
            confidence: 0.3,
        },
        supersedeWith: 'destructive-git-guard',
    },
    {
        category: 'constraints',
        id: 'integration-test-old',
        importance: 3,
        content: {
            description: 'Integration tests database no mocks: mocking is acceptable when real DB is slow or unavailable. (SUPERSEDED — never mock after the migration incident)',
            evidence: 'Old policy note before the incident.',
            confidence: 0.4,
        },
        supersedeWith: 'integration-test-real-db',
    },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load fixture query pairs from disk.
 * @returns {Array<{query: string, expected: string[]}>}
 */
function loadFixture(fixturePath = FIXTURE_PATH) {
    // Prefer the external fixture (workshop). When it's absent — the normal case
    // in an adopter project, since __tests__/ isn't propagated — fall back to the
    // inlined DEFAULT_QUERIES so the harness still runs. Only a malformed (present
    // but invalid) fixture is fatal. (fixturePath is parameterized for testability;
    // the CLI always calls loadFixture() with the default.)
    if (!fs.existsSync(fixturePath)) {
        console.log(`[memory-eval] fixture not present (expected in adopter projects); using ${DEFAULT_QUERIES.length} inlined queries`);
        return DEFAULT_QUERIES;
    }
    try {
        const raw = fs.readFileSync(fixturePath, 'utf-8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) throw new Error('Fixture must be a JSON array');
        return data;
    } catch (err) {
        console.error(`[memory-eval] FATAL: fixture at ${fixturePath} is present but unreadable`);
        console.error(`  ${err.message}`);
        process.exit(1);
    }
}

/**
 * Compute hit@k for a single query result set against expected ids.
 *
 * @param {Array<{id: string}>} results - ordered search results
 * @param {string[]} expectedIds        - any one of these counts as a hit
 * @param {number} k                    - window size
 * @returns {boolean}
 */
function hitAtK(results, expectedIds, k) {
    const topK = results.slice(0, k).map(r => r.id);
    return expectedIds.some(eid => topK.includes(eid));
}

/**
 * Run one full evaluation pass (all fixture queries) against the manager.
 *
 * @param {object} manager         - MemoryManager instance
 * @param {Array}  queries         - fixture query entries
 * @param {number} k               - hit@k window
 * @param {boolean} includeSuperseded
 * @param {boolean} [recordRecall=true] - F11: pass false for the --real pass
 *   against the actual project store, so this evaluation run doesn't inflate
 *   usage_count / pollute memory-injection.jsonl hit-rate analytics. The
 *   self-seeding demo passes (throwaway temp stores) leave this true — nothing
 *   downstream reads their analytics.
 * @returns {Promise<{hits: number, total: number, perQuery: Array}>}
 */
async function runPass(manager, queries, k, includeSuperseded, recordRecall = true) {
    let hits = 0;
    const perQuery = [];

    for (const entry of queries) {
        const results = await manager.searchMemories(entry.query, { includeSuperseded, recordRecall });
        const hit = hitAtK(results, entry.expected, k);
        if (hit) hits++;

        const topKIds = results.slice(0, k).map(r => r.id);
        perQuery.push({
            query: entry.query,
            expected: entry.expected,
            topK: topKIds,
            hit,
        });
    }

    return { hits, total: queries.length, perQuery };
}

/**
 * Create a MemoryManager pointing at `storeDir` (a subdirectory under tmpDir).
 * Does NOT set process.env.CLAUDE_PROJECT_DIR — we pass storeDir directly via
 * env before each `new MemoryManager()` call and restore it after.
 *
 * @param {string} storeDir - absolute path for this store's CLAUDE_PROJECT_DIR
 * @returns {object} MemoryManager instance
 */
function makeManager(storeDir) {
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = storeDir;
    const MemoryManager = require('./memory-manager');
    const m = new MemoryManager();
    // Restore so subsequent calls with a different storeDir work correctly.
    // (MemoryManager reads env only in constructor — instance is now bound to storeDir.)
    if (saved === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
    } else {
        process.env.CLAUDE_PROJECT_DIR = saved;
    }
    return m;
}

/**
 * Seed two temp stores for the self-seeding demo:
 *
 * - **pruned** store: correct live memories + stale ones properly superseded
 *   (deindexed from FTS). This is what a well-maintained store looks like.
 *
 * - **noisy** store: same correct memories + stale ones still LIVE (not
 *   superseded). This simulates "keep-everything" — a store where old,
 *   contradicted memories compete with the correct answers in FTS ranking.
 *
 * Running hit@k against both stores produces a measurable accuracy delta that
 * demonstrates why pruning/supersession improves retrieval (not just shrinks
 * the store).
 *
 * @param {string} tmpDir    - root temp dir (caller owns cleanup)
 * @param {number} k         - hit@k window (used in logging only)
 * @returns {Promise<{prunedManager: object, noisyManager: object}>}
 */
async function seedTempStores(tmpDir) {
    const prunedDir = path.join(tmpDir, 'pruned');
    const noisyDir = path.join(tmpDir, 'noisy');
    fs.mkdirSync(prunedDir, { recursive: true });
    fs.mkdirSync(noisyDir, { recursive: true });

    const prunedMgr = makeManager(prunedDir);
    const noisyMgr = makeManager(noisyDir);

    const supersededSpecs = SEED_MEMORIES.filter(s => s.supersedeWith);
    const liveSpecs = SEED_MEMORIES.filter(s => !s.supersedeWith);

    console.log('  Seeding PRUNED store (correct answers + superseded history deindexed)...');
    for (const spec of SEED_MEMORIES) {
        const content = { ...spec.content, importance: spec.importance };
        await prunedMgr.createMemory(spec.category, spec.id, content);
    }
    for (const spec of supersededSpecs) {
        await prunedMgr.supersede(spec.category, spec.id, spec.supersedeWith);
    }
    console.log(`    ${liveSpecs.length} live, ${supersededSpecs.length} superseded (deindexed from FTS)`);

    console.log('  Seeding NOISY store (same memories, but stale ones NOT superseded)...');
    for (const spec of SEED_MEMORIES) {
        const content = { ...spec.content, importance: spec.importance };
        await noisyMgr.createMemory(spec.category, spec.id, content);
    }
    // Intentionally NO supersede calls — old entries stay live in FTS,
    // competing with the correct answers for top-k positions.
    console.log(`    ${SEED_MEMORIES.length} live (${supersededSpecs.length} stale entries polluting FTS)\n`);

    return { prunedManager: prunedMgr, noisyManager: noisyMgr };
}

/**
 * Print a formatted evaluation report to stdout.
 */
function printReport(prunedResult, keepAllResult, k) {
    const prunedAccuracy = (prunedResult.hits / prunedResult.total * 100).toFixed(1);
    const keepAllAccuracy = (keepAllResult.hits / keepAllResult.total * 100).toFixed(1);
    const delta = (prunedResult.hits / prunedResult.total - keepAllResult.hits / keepAllResult.total) * 100;
    const deltaStr = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Memory Retrieval Accuracy — hit@${k} Evaluation`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('  PRUNED store  (correct answers live, stale entries deindexed)');
    console.log(`    hit@${k}: ${prunedResult.hits}/${prunedResult.total} = ${prunedAccuracy}%`);
    console.log('');
    console.log('  NOISY store   (keep-everything: stale entries compete in FTS for top-k)');
    console.log(`    hit@${k}: ${keepAllResult.hits}/${keepAllResult.total} = ${keepAllAccuracy}%`);
    console.log('');
    console.log(`  DELTA (pruned - noisy): ${deltaStr}pp`);
    if (delta > 0) {
        console.log('  --> Pruning IMPROVED retrieval accuracy (expected result)');
    } else if (delta === 0) {
        console.log('  --> No accuracy difference observed (stale entries may not compete in top-k)');
    } else {
        console.log('  --> Pruning DEGRADED retrieval accuracy (investigate store health)');
    }
    console.log('');

    // Per-query breakdown
    console.log('  Per-query breakdown (PRUNED store):');
    console.log('  ─────────────────────────────────────────────────────────────');
    for (const q of prunedResult.perQuery) {
        const status = q.hit ? 'PASS' : 'FAIL';
        const label = q.query.length > 50 ? q.query.slice(0, 47) + '...' : q.query.padEnd(50);
        console.log(`  [${status}] "${label}"`);
        if (!q.hit) {
            console.log(`         expected: [${q.expected.join(', ')}]`);
            console.log(`         got top-${k}: [${q.topK.join(', ') || '(no results)'}]`);
        }
    }
    console.log('');

    // Per-query breakdown for noisy store (only show failures)
    const keepAllFails = keepAllResult.perQuery.filter(q => !q.hit);
    if (keepAllFails.length > 0) {
        console.log('  Per-query NOISY store misses (queries where stale entries displaced the answer):');
        console.log('  ─────────────────────────────────────────────────────────────');
        for (const q of keepAllFails) {
            const label = q.query.length > 50 ? q.query.slice(0, 47) + '...' : q.query;
            console.log(`  [FAIL] "${label}"`);
            console.log(`         expected: [${q.expected.join(', ')}]`);
            console.log(`         got top-${k}: [${q.topK.join(', ') || '(no results)'}]`);
        }
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════════════\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const useRealStore = args.includes('--real');
    const forceSeed = args.includes('--seed');
    const kIdx = args.findIndex(a => a === '--k' || a === '-k');
    const k = kIdx !== -1 && args[kIdx + 1] ? parseInt(args[kIdx + 1], 10) : DEFAULT_K;

    if (isNaN(k) || k < 1) {
        console.error('[memory-eval] --k must be a positive integer');
        process.exit(1);
    }

    const queries = loadFixture();
    console.log(`[memory-eval] Loaded ${queries.length} query pairs from fixture`);
    console.log(`[memory-eval] hit@${k} evaluation\n`);

    let prunedManager = null;
    let noisyManager = null;
    let realManager = null;
    let tmpDir = null;

    try {
        if (useRealStore) {
            // Evaluate against the real project store.
            // pruned pass = default (superseded excluded by searchMemories)
            // noisy pass = includeSuperseded: true (but note: supersede() deindexes
            // from FTS, so both paths hit the same FTS index — delta is only visible
            // if the real store has live low-importance noise competing with answers)
            const MemoryManager = require('./memory-manager');
            realManager = new MemoryManager();
            console.log(`[memory-eval] Using real store at: ${realManager.memoriesDir}\n`);

            console.log('[memory-eval] Running pruned pass (default: superseded excluded from FTS)...');
            const prunedResult = await runPass(realManager, queries, k, false, false);

            console.log('[memory-eval] Running keep-everything pass (includeSuperseded: true)...');
            const keepAllResult = await runPass(realManager, queries, k, true, false);

            printReport(prunedResult, keepAllResult, k);
        } else {
            // Self-seeding demo: two separate temp stores demonstrate the delta.
            //
            // PRUNED store: correct memories live + stale ones superseded (deindexed
            //   from FTS). Represents a well-maintained store.
            //
            // NOISY store: same correct memories + stale ones NOT superseded (still
            //   active in FTS). Represents "keep-everything" where contradicted /
            //   stale entries compete with correct answers for top-k positions.
            //
            // Hit@k(pruned) >= hit@k(noisy) proves the claim.
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-eval-'));
            console.log(`[memory-eval] Self-seeding demo in: ${tmpDir}`);
            const stores = await seedTempStores(tmpDir);
            prunedManager = stores.prunedManager;
            noisyManager = stores.noisyManager;

            console.log('[memory-eval] Running PRUNED store pass (correct answers, stale entries deindexed)...');
            const prunedResult = await runPass(prunedManager, queries, k, false);

            console.log('[memory-eval] Running NOISY store pass (keep-everything: stale entries compete in FTS)...');
            const noisyResult = await runPass(noisyManager, queries, k, false);

            printReport(prunedResult, noisyResult, k);

            // For self-seeding demo: also show hit@1 when k > 1. The delta is most
            // visible at k=1 because stale entries are more likely to displace the
            // single top result than to push the correct answer past position 3.
            if (k > 1) {
                console.log('[memory-eval] Also running hit@1 for sharper delta demonstration...');
                const pruned1 = await runPass(prunedManager, queries, 1, false);
                const noisy1 = await runPass(noisyManager, queries, 1, false);
                printReport(pruned1, noisy1, 1);
            }
        }

        // Exit 0 always — accuracy of 0% is still a valid run
    } finally {
        // Close SQLite DB handles before rmSync — on Windows, an open file
        // handle causes EPERM on directory removal even with { force: true }.
        for (const mgr of [prunedManager, noisyManager, realManager]) {
            if (mgr && mgr.db) {
                try { mgr.db.close(); } catch { /* non-fatal */ }
            }
        }
        if (tmpDir) {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                console.log(`[memory-eval] Cleaned up temp dir: ${tmpDir}`);
            } catch (e) {
                // Non-fatal — OS may delay file handle release on Windows.
                console.error(`[memory-eval] Warning: could not clean up ${tmpDir}: ${e.message}`);
            }
        }
    }
}

// Run as CLI only when invoked directly; importing the module (e.g. from tests)
// must NOT trigger a full eval.
if (require.main === module) {
    main().catch(err => {
        console.error('[memory-eval] FATAL:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
}

module.exports = {
    loadFixture,
    DEFAULT_QUERIES,
    FIXTURE_PATH,
    // Deterministic helpers exposed for in-process testing (test-coverage only —
    // no behavior change). hitAtK/runPass/makeManager/seedTempStores/printReport
    // are pure or store-backed (no network, no LLM); main runs the full eval path.
    hitAtK,
    runPass,
    makeManager,
    seedTempStores,
    printReport,
    main,
};
