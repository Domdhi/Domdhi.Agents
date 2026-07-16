#!/usr/bin/env node

/**
 * telemetry-log.js — self-instrumentation for user-typed slash commands.
 *
 * WHY THIS EXISTS
 * ---------------
 * command-usage-logger.cjs only captures `command_invocation` telemetry when
 * Claude Code routes a command through the Skill tool (PostToolUse:Skill).
 * USER-TYPED slash commands (`/onboard`, `/run-todo`, `/do`, …) are expanded
 * directly into the user message in Claude Code 2.x — no PostToolUse:Skill
 * event fires, so they leave NO record in command-usage.jsonl. (This is the
 * documented coverage gap at the top of command-usage-logger.cjs.)
 *
 * The fix path named there is: "instrument the slash commands themselves to
 * write a telemetry entry from their preamble." This is that instrument. A
 * command markdown calls it once near the top of its workflow:
 *
 *     node .claude/core/telemetry-log.js onboard
 *
 * and the invocation shows up in command-usage.jsonl with source
 * 'self-instrumented' (so it's distinguishable from Skill-tool-captured rows).
 *
 * DURATION: a single preamble call cannot measure how long the command took
 * (it hasn't finished). duration_ms is therefore null for command_invocation
 * rows — gate_run rows carry real durations (stamped by gate.js). A command
 * that wants its own duration can pass it explicitly once it completes.
 *
 * Usage:
 *   node .claude/core/telemetry-log.js <command-name> [duration_ms]
 *
 * Exit codes: 0 on success, 2 on bad usage. Never throws on write failure —
 * telemetry is best-effort observability, not a gate.
 */

const path = require('path');
const { appendJsonl } = require('./_lib/jsonl-writer');
const { getJsonlPath } = require('./_lib/telemetry-paths');
const { resolveProjectRoot } = require('./_lib/project-root');

// Mirror command-usage-logger.cjs's sizing for command-usage.jsonl — it's the
// longitudinal record consumed by /retro, /status, /timeline, and metrics.js,
// so a large cap retains ~8-10 months of history. Keep these in sync with that
// hook's MAX_JSONL_LINES / TAIL_KEEP_LINES.
const MAX_JSONL_LINES = 6000;
const TAIL_KEEP_LINES = 5000;

function getProjectRoot() {
    // W3-2 / F72-class: telemetry-log.js writes command-usage.jsonl — the SAME
    // gitignored `.state/` file the fixed command-usage-logger.cjs hook writes —
    // as an in-session preamble from 10+ commands. It must anchor to the
    // git-common-dir via resolveProjectRoot (CLAUDE_PROJECT_DIR still wins) or a
    // linked worktree writes self-instrumented rows to a worktree-local file that
    // is deleted with the worktree, split-braining the log the hook hardened.
    return resolveProjectRoot(path.resolve(__dirname, '..', '..'));
}

/**
 * Append a self-instrumented command_invocation entry to command-usage.jsonl.
 *
 * @param {string} commandName  Slash-command name without the leading slash (e.g. 'onboard')
 * @param {number|null} [durationMs]  Optional run duration; null when unknown
 * @param {string} [projectRoot]  Override the resolved project root (tests)
 * @returns {object} The event that was written
 */
function logCommand(commandName, durationMs = null, projectRoot = getProjectRoot()) {
    const event = {
        timestamp: new Date().toISOString(),
        type: 'command_invocation',
        command: commandName,
        duration_ms: typeof durationMs === 'number' && !Number.isNaN(durationMs) ? durationMs : null,
        source: 'self-instrumented',
        // Stable per-session identifier — set by Claude Code in every spawned subprocess's env
        // (this script runs via the Bash tool), so it's present here the same way it is in
        // command-usage-logger.cjs's hook subprocess. Lets one session's command chain be isolated
        // from a concurrent session sharing the working tree.
        session_id: process.env.CLAUDE_CODE_SESSION_ID || null,
    };

    const jsonlPath = getJsonlPath(projectRoot, 'command-usage.jsonl');
    appendJsonl(jsonlPath, event, { maxLines: MAX_JSONL_LINES, tailKeep: TAIL_KEEP_LINES });
    return event;
}

if (require.main === module) {
    const [, , name, durArg] = process.argv;
    if (!name) {
        console.error('usage: telemetry-log.js <command-name> [duration_ms]');
        process.exit(2);
    }
    try {
        logCommand(name, durArg !== undefined ? Number(durArg) : null);
    } catch {
        // Best-effort: never fail a command because telemetry couldn't be written.
    }
    process.exit(0);
}

module.exports = { logCommand, MAX_JSONL_LINES, TAIL_KEEP_LINES };
