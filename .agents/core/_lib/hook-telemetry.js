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

const fs = require('fs');
const path = require('path');
const { appendJsonl } = require('./jsonl-writer');
const { assertNoSymlinkedAncestor } = require('./fs-safe');
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

/** The shared guardrail event shape (emitGuardrailHit and emitGuardrailHitAt write the same fields). */
function guardrailEntry(hit) {
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
    return entry;
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
        const entry = guardrailEntry(hit);
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

const AUDIT_REASON_MAX = 500;
const AUDIT_STORIES_MAX = 50;

/**
 * Record an AUDITED guardrail hit (a bypass that must not be silent) against an explicit, already verified
 * repository root. Unlike `emitGuardrailHit` it never consults AGENT_SHARED_STATE_ROOT, AGENTS_PROJECT_DIR or
 * CLAUDE_PROJECT_DIR (an environment variable can redirect that event to a directory nobody reads), it refuses a
 * symlinked ancestor or a symlinked / non-regular events file (an append through a symlink to /dev/null "succeeds"),
 * and it opens the file with O_NOFOLLOW. The event carries the same fields as `emitGuardrailHit` plus the bounded
 * audit fields `reason` (one line, at most 500 characters), `kind`, `wave` (a positive integer), `stories` (at most 50
 * ids) and `head` (a commit id). No rotation: bypasses are rare and the history is the point.
 *
 * Never throws; returns the event written, or null when it could not be written (the caller must then refuse the
 * bypass: no bypass is silent).
 *
 * @param {string} root absolute repository root
 * @param {{ decision: string, rule?: string|null, source?: string|null, reason?: string, kind?: string, wave?: number, stories?: string[], head?: string }} hit
 * @returns {object|null}
 */
function emitGuardrailHitAt(root, hit) {
    let fd;
    try {
        if (!hit || !hit.decision || typeof root !== 'string' || !path.isAbsolute(root)) return null;
        const entry = guardrailEntry(hit);
        if (typeof hit.reason === 'string' && hit.reason) entry.reason = hit.reason.replace(/[\0-\x1f\x7f]+/g, ' ').slice(0, AUDIT_REASON_MAX);
        if (typeof hit.kind === 'string' && hit.kind) entry.kind = hit.kind.slice(0, 32);
        if (Number.isInteger(hit.wave) && hit.wave >= 1) entry.wave = hit.wave;
        if (Array.isArray(hit.stories)) entry.stories = hit.stories.filter(id => typeof id === 'string' && id).slice(0, AUDIT_STORIES_MAX).map(id => id.slice(0, 64));
        if (typeof hit.head === 'string' && /^[0-9a-f]{40,64}$/.test(hit.head)) entry.head = hit.head;
        const file = getJsonlPath(path.resolve(root), 'guardrail-events.jsonl');
        assertNoSymlinkedAncestor(file, path.resolve(root));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let stat = null;
        try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') return null; }
        if (stat && !stat.isFile()) return null;
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o644);
        if (!fs.fstatSync(fd).isFile()) return null;
        const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
        if (fs.writeSync(fd, line) !== line.length) return null;
        return entry;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing to release */ } }
    }
}

module.exports = {
    startHookTiming,
    emitHookEvent,
    emitGuardrailHit,
    emitGuardrailHitAt,
    HOOK_EVENTS_MAX_LINES,
    HOOK_EVENTS_TAIL_KEEP,
    GUARDRAIL_EVENTS_MAX_LINES,
    GUARDRAIL_EVENTS_TAIL_KEEP,
};
