/**
 * Hook Telemetry — duration instrumentation wrapper for hook execution.
 *
 * Hook-duration telemetry is a blind-spot opportunity noted in Section D of
 * the competitive comparison; no competitor measures hook execution time.
 * See `docs/.output/findings/research/competitive/_hooks-and-core-scripts-comparison.md` §D.
 *
 * Usage from a hook:
 *
 *     const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
 *     const t = startHookTiming('my-hook');
 *     try { ... } finally { emitHookEvent(t, outcome); }
 *
 * Events land at docs/.output/.state/telemetry/hook-events.jsonl and can be consumed
 * by a future /retro or /listen command for latency analysis.
 *
 * Hook adoption shipped in P1.7 (command-usage-logger.cjs, damage-control.cjs,
 * memory-capture.cjs); path-guardrail.cjs also wraps its body in
 * startHookTiming/emitHookEvent.
 */

const path = require('path');
const { appendJsonl } = require('./jsonl-writer');
const { getJsonlPath } = require('./telemetry-paths');
const { resolveProjectRoot } = require('./project-root');

// Match command-usage-logger's caps so hook-events.jsonl tail-rotates the same
// way command-usage.jsonl does. Without these, the file grows unbounded —
// every Bash hook + every Write/Edit hook + every Stop hook appends per
// invocation, ~12 events per /do, ~50+ per /run-todo wave.
const HOOK_EVENTS_MAX_LINES = 1000;
const HOOK_EVENTS_TAIL_KEEP = 500;

// Guardrail hits are RARE (only an actual block/nudge/confirm appends — allows
// do not), so guardrail-events.jsonl gets a far larger cap than hook-events:
// this file IS the longitudinal hit counter consumed by guardrail-stats.js, so
// it should retain many months of history rather than tail-rotate within a day.
const GUARDRAIL_EVENTS_MAX_LINES = 5000;
const GUARDRAIL_EVENTS_TAIL_KEEP = 4000;

function getProjectRoot() {
    // F1/CR-3.1 sibling: the telemetry `.state/` writes are gitignored and
    // shared across linked worktrees, so anchor to the git-common-dir via
    // resolveProjectRoot (CLAUDE_PROJECT_DIR still wins) rather than the naive
    // __dirname fallback, which loses events into a worktree-local path.
    return resolveProjectRoot(path.resolve(__dirname, '..', '..', '..'));
}

/**
 * Start a timing token for a hook invocation.
 *
 * @param {string} hookName  Name of the hook (used as the event `name` field)
 * @returns {{ hookName: string, startMs: number }}
 */
function startHookTiming(hookName) {
    return { hookName, startMs: Date.now() };
}

/**
 * Emit a hook event to the JSONL log. Computes duration from the token's
 * startMs and appends {event:'hook', name, duration_ms, outcome, timestamp}.
 *
 * @param {{ hookName: string, startMs: number }} token  Timing token from startHookTiming
 * @param {string} outcome  Outcome label (e.g. 'success', 'failure', 'unknown')
 */
function emitHookEvent(token, outcome) {
    // Best-effort (matches emitGuardrailHit): telemetry must never crash a hook.
    try {
        const now = Date.now();
        const entry = {
            event: 'hook',
            name: token.hookName,
            duration_ms: Math.max(0, now - token.startMs),
            outcome,
            timestamp: new Date(now).toISOString(),
        };
        appendJsonl(getJsonlPath(getProjectRoot(), 'hook-events.jsonl'), entry, {
            maxLines: HOOK_EVENTS_MAX_LINES,
            tailKeep: HOOK_EVENTS_TAIL_KEEP,
        });
    } catch { /* swallow — observability is not load-bearing */ }
}

/** Rule names for a telemetry event: strings only, at most 20, each cut to 64 characters; null when none. */
function boundedPatternNames(patterns) {
    if (!Array.isArray(patterns)) return null;
    const names = patterns.filter(p => typeof p === 'string' && p).slice(0, 20).map(p => p.slice(0, 64));
    return names.length ? names : null;
}

/**
 * Record a guardrail HIT (a block / nudge / confirm — never an allow). This is
 * the counter the guardrail never had: it captures WHICH rule fired and WHAT it
 * did, so guardrail-stats.js can report hit frequency by rule and decision.
 *
 * SECRET SAFETY: the raw command is deliberately NOT logged. Guardrail commands
 * are precisely the ones likely to carry secrets (`rm -rf .env`, inline keys),
 * and a telemetry file is read by post-read-scrubber. We log only the matched
 * rule pattern, the decision, and the path tier (for path-tier blocks).
 *
 * Best-effort: never throws — a telemetry write must never break the guardrail
 * (the guardrail's exit code is load-bearing for blocking dangerous commands).
 *
 * The optional `source` field tags WHO emitted the hit. The Bash guardrail
 * (guardrail.cjs) omits it (source=null); the secret-scanner tags its blocks
 * with source:'secret-scanner'. guardrail-stats.js counts only un-sourced
 * (Bash-guardrail) events, while feedback-digest's readScannerBlocks counts the
 * scanner-sourced ones — both readers share this one file, partitioned by source.
 *
 * The optional `pathClass` field (C1) is a BOUNDED enum class for the first path
 * of a delete-style command (e.g. 'build-artifact', 'tmp', 'node_modules',
 * 'project-path') — NOT the raw path. It preserves the secret-safety contract
 * above (never the command) while letting guardrail-stats answer "is this rule
 * just noise on disposable paths?". null for non-delete rules.
 *
 * The optional `patterns` (rule NAMES, never matched values) and `count` fields let the
 * secret-scanner say which detection rules fired and how many findings a block held, so the
 * feedback digest can show the noisy rules. Both are bounded here: at most 20 names of at
 * most 64 characters, and a non-negative integer count. Anything else is dropped.
 *
 * @param {{ decision: string, rule?: string|null, tier?: string|null, source?: string|null, pathClass?: string|null, patterns?: string[]|null, count?: number|null }} hit
 * @returns {object|null} The event written, or null on any failure.
 */
function emitGuardrailHit(hit) {
    try {
        if (!hit || !hit.decision) return null;
        const entry = {
            event: 'guardrail',
            decision: hit.decision,            // 'block' | 'nudge' | 'confirm'
            rule: hit.rule != null ? hit.rule : null,
            tier: hit.tier != null ? hit.tier : null,
            source: hit.source != null ? hit.source : null,  // e.g. 'secret-scanner'; null = Bash guardrail
            pathClass: hit.pathClass != null ? hit.pathClass : null,  // C1: bounded delete-path class; null = non-delete
            timestamp: new Date().toISOString(),
        };
        const patterns = boundedPatternNames(hit.patterns);
        if (patterns) entry.patterns = patterns;
        if (Number.isInteger(hit.count) && hit.count >= 0) entry.count = hit.count;
        let writeFailed = false;
        appendJsonl(getJsonlPath(getProjectRoot(), 'guardrail-events.jsonl'), entry, {
            maxLines: GUARDRAIL_EVENTS_MAX_LINES,
            tailKeep: GUARDRAIL_EVENTS_TAIL_KEEP,
            onError: () => { writeFailed = true; },
        });
        // appendJsonl swallows I/O errors by design; the caller learns of one from the null, so a message
        // that says "recorded" (the secret-scan bypass) is only ever printed after the write happened.
        return writeFailed ? null : entry;
    } catch {
        return null;
    }
}

module.exports = {
    startHookTiming,
    emitHookEvent,
    emitGuardrailHit,
    HOOK_EVENTS_MAX_LINES,
    HOOK_EVENTS_TAIL_KEEP,
    GUARDRAIL_EVENTS_MAX_LINES,
    GUARDRAIL_EVENTS_TAIL_KEEP,
};
