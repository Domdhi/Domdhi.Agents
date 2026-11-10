#!/usr/bin/env node

/**
 * Memory Recall Hook (UserPromptSubmit) — per-prompt hybrid recall of full memories.
 *
 * Why: in the fact-recall test (Domdhi.Vault, 13 tasks, Haiku 5.5) per-prompt retrieval of the top three
 * full memories passed 72% against 35% for a startup list of eight titles and 16% for no memory.
 *
 * Corpus: the markdown memory dir (Claude's native auto-memory dir unless MEMORY_DIR) plus the engine's
 * tracked JSON memories (read-only). Ranking: BM25 + embedding cosine fused with RRF; keyword-only when no
 * embedder answers (see core/_lib/memory-recall.js).
 *
 * Output: JSON `additionalContext` with up to 3 memories, 1800 chars each, 6000 total — far below Claude
 * Code's ~10 KB hook-output limit. A memory is never injected twice in one session. Prompts under 20
 * characters, slash commands and machine-generated messages (teammate/task notifications, delegated-task
 * envelopes) are skipped: on real projects those were 23 to 47% of all prompts and always pure noise.
 *
 * Safety: ALWAYS exits 0 with no output on any problem; hard timeout; never waits for a server (the query
 * embedding has a 400 ms budget, documents are never embedded here). When the vector index is stale and an
 * embedder is reachable, one detached `memory-capture.js index` is started (at most every 10 minutes).
 *
 * Tuning: MEMORY_RECALL_MAX (1 to 5, default 3), MEMORY_RECALL_FLOOR (cosine floor, 0.3 to 0.95, default 0.70),
 * MEMORY_RECALL_KW_SCORE (keyword-only score per ln(1+N), 0.25 to 4, default 1.75; lower it on a large store).
 * Disable: MEMORY_RECALL=off, or MEMORY_PROFILE=minimal. Codex has no registered UserPromptSubmit hook;
 * Codex agents recall through `memory-capture.js recall`.
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { isAtLeast } = require('../core/profile');
const { readHookInput } = require('../core/_lib/hook-input');
const { notesContext, recallEnabled } = require('../core/_lib/memory-context');
const { loadCorpus } = require('../core/_lib/memory-notes');
const { recall, embedConfig, tuningFromEnv, DEFAULT_FLOOR } = require('../core/_lib/memory-recall');
const { appendJsonl } = require('../core/_lib/jsonl-writer');

const MIN_PROMPT = 20;
const MAX_HITS = 3;          // MEMORY_RECALL_MAX (1 to 5)
// MEMORY_RECALL_FLOOR (0.3 to 0.95) overrides the cosine floor of the hybrid ranker (default in core/_lib/memory-recall.js)
// Prompts the harness or another agent wrote, not the user: nothing in them to recall against.
const MACHINE_PROMPT = /^(?:<(?:teammate-message|task-notification|local-command|command-(?:name|message)|system-reminder)\b|Another Claude session sent a message|Delegated task node:)/;
const PER_MEMORY = 1800;
const TOTAL = 6000;
const HARD_TIMEOUT_MS = 2500;
const INDEX_RESPAWN_MS = 10 * 60 * 1000;
const SEEN_TTL_MS = 7 * 24 * 3600 * 1000;

const HEADER = 'Memories recalled for this prompt (matched by meaning and keywords; they can be stale, so check them against the current files before relying on them):';

function tuning(env) {
    const max = Math.round(Number(env.MEMORY_RECALL_MAX));
    const { floor, kwScore } = tuningFromEnv(env);
    return {
        maxHits: Number.isFinite(max) && env.MEMORY_RECALL_MAX !== '' ? Math.min(5, Math.max(1, max)) : MAX_HITS,
        floor,
        kwScore,
    };
}

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }

function seenPath(stateDir, sessionId) {
    return path.join(stateDir, 'seen', `${String(sessionId || 'x').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'x'}.json`);
}

function pruneSeen(dir) {
    try {
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (Date.now() - fs.statSync(p).mtimeMs > SEEN_TTL_MS) fs.unlinkSync(p);
        }
    } catch { /* best effort */ }
}

function spawnIndexOnce(ctx, env) {
    try {
        const marker = path.join(ctx.stateDir, 'index-spawned');
        let last = 0;
        try { last = fs.statSync(marker).mtimeMs; } catch { /* first time */ }
        if (Date.now() - last < INDEX_RESPAWN_MS) return false;
        fs.mkdirSync(ctx.stateDir, { recursive: true });
        fs.writeFileSync(marker, new Date().toISOString());
        const cli = path.join(__dirname, '..', 'core', 'memory-capture.js');
        const child = childProcess.spawn(process.execPath, [cli, 'index'], { cwd: ctx.projectRoot, stdio: 'ignore', windowsHide: true, detached: true, env });
        child.unref();
        return true;
    } catch { return false; }
}

/**
 * Precision telemetry: one line per prompt that reached the ranker (docs/.output/.state/telemetry/memory-recall.jsonl),
 * so the injection rate and the cosines can be measured in real use. Never fails the hook, never stores prompt text.
 */
function recordRecall(ctx, sessionId, result, injected) {
    try {
        appendJsonl(path.join(path.dirname(ctx.stateDir), 'telemetry', 'memory-recall.jsonl'), {
            timestamp: new Date().toISOString(), type: 'memory_recall', source: result.source,
            candidates: result.hits.length, injected_count: injected.length, injected_ids: injected.map(h => h.name),
            top_cos: result.hits.length ? result.hits[0].cos : null, session_proxy: String(sessionId || '').slice(0, 8),
        });
    } catch { /* telemetry is observability, not correctness */ }
}

/**
 * @param {object} input  parsed hook JSON ({prompt, session_id, ...})
 * @returns {Promise<object|null>} the hook output object, or null for "inject nothing"
 */
async function processEvent(input, { env = process.env, fallbackDir = path.resolve(__dirname, '..', '..'), fetchImpl } = {}) {
    if (!isAtLeast('standard') || !recallEnabled(env) || env.MEMORY_CAPTURE_INNER) return null;   // INNER: the capture's own claude -p child needs no memories
    const prompt = String((input && input.prompt) || '').trim();
    if (prompt.length < MIN_PROMPT || prompt.startsWith('/') || MACHINE_PROMPT.test(prompt)) return null;

    const ctx = notesContext(fallbackDir, env);
    const corpus = loadCorpus({ memoryDir: ctx.memoryDir, engineRoot: ctx.engineRoot });
    if (!Object.keys(corpus).length) return null;

    const sp = seenPath(ctx.stateDir, input.session_id);
    const seen = new Set(readJson(sp, []));
    const { maxHits, floor, kwScore } = tuning(env);
    const result = await recall({
        corpus, query: prompt.slice(0, 2000), k: maxHits + seen.size, floor, kwScore, stateDir: ctx.stateDir,
        cfg: embedConfig(env), sync: false, timeoutMs: 400, fetchImpl,
    });
    if (result.stale && /^hybrid/.test(result.source)) spawnIndexOnce(ctx, env);
    const hits = result.hits.filter(h => !seen.has(h.key)).slice(0, maxHits);
    if (!hits.length) { recordRecall(ctx, input.session_id, result, []); return null; }

    const blocks = [];
    let size = 0;
    for (const h of hits) {
        const block = `### ${h.name}\n${h.body.slice(0, PER_MEMORY)}`;
        if (size + block.length > TOTAL) break;
        blocks.push(block);
        size += block.length;
        seen.add(h.key);
    }
    if (!blocks.length) return null;
    recordRecall(ctx, input.session_id, result, hits.slice(0, blocks.length));
    try {
        fs.mkdirSync(path.dirname(sp), { recursive: true });
        fs.writeFileSync(sp, JSON.stringify([...seen].sort()));
        if (Math.random() < 0.05) pruneSeen(path.dirname(sp));
    } catch { /* dedupe is best effort; the injection still goes out */ }
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `${HEADER}\n\n${blocks.join('\n\n')}` } };
}

module.exports = { processEvent, tuning, HEADER, MIN_PROMPT, MAX_HITS, DEFAULT_FLOOR, PER_MEMORY, TOTAL };

if (require.main === module) {
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const token = startHookTiming('memory-recall');
    let outcome = 'success';
    const hard = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS);
    hard.unref();
    process.on('uncaughtException', () => process.exit(0));
    process.on('unhandledRejection', () => process.exit(0));
    (async () => {
        try {
            const raw = await readHookInput({ timeoutMs: 800 });
            const out = raw && raw.trim() ? await processEvent(JSON.parse(raw)) : null;
            if (out) process.stdout.write(JSON.stringify(out));
        } catch {
            outcome = 'failure';
        }
        try { emitHookEvent(token, outcome); } catch { /* telemetry never fails a prompt */ }
        process.exit(0);
    })();
}
