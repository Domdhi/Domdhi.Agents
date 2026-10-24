#!/usr/bin/env node

/**
 * Command Usage Logger Hook
 *
 * PostToolUse hook — logs slash-command invocations and gate runs to a local
 * JSONL file for telemetry. Feeds /retro with actual usage data.
 *
 * Despite the previous name ("command-usage-logger"), this does NOT track skill
 * invocations. Skills are markdown files auto-loaded into agent context via
 * frontmatter — there is no "skill invoked" event to hook. What this logs is:
 *
 *   PostToolUse:Skill — when a /command is invoked (exact command name from tool_input.skill)
 *   PostToolUse:Bash  — when gate.js is run (build/test gate signal)
 *
 * Output: docs/.output/.state/telemetry/command-usage.jsonl
 *
 * Exit codes:
 *   0 = always (PostToolUse hooks cannot block)
 *
 * KNOWN COVERAGE GAP — user-typed slash commands (audited 2026-05-10):
 *   This hook only captures `command_invocation` events when Claude Code
 *   actually invokes the Skill tool. Empirically (verified by tailing the
 *   JSONL after a fresh /prime in this very session), USER-TYPED slash
 *   commands like `/prime`, `/run-todo`, `/do` do NOT fire PostToolUse:Skill
 *   in current Claude Code 2.x — the command markdown is expanded directly
 *   into the user message instead of being routed through the Skill tool.
 *
 *   What still gets captured:
 *     - `session-handoff` — invoked programmatically by /end and /run-todo
 *     - `find-skills`     — invoked programmatically when Claude searches skills
 *     - any Skill tool call Claude makes itself
 *     - all gate_run events (PostToolUse:Bash fires reliably)
 *
 *   Symptom in telemetry: `/run-todo` runs an entire epic to completion, but
 *   command-usage.jsonl shows only `gate_run` entries and the trailing
 *   `session-handoff` from the embedded /end. The `/run-todo` invocation
 *   itself is absent.
 *
 *   This is platform behavior, not a hook bug — there is no PostToolUse event
 *   to hook for user-typed slash commands. Adding fallback field reads here
 *   (e.g., tool_input.name, tool_input.command) would not help; the hook
 *   simply isn't being called for those events.
 *
 *   Fix path (IMPLEMENTED for opted-in commands): `.claude/core/telemetry-log.js`
 *   lets a slash command self-instrument from its preamble —
 *   `node .claude/core/telemetry-log.js <name>` appends a command_invocation
 *   row tagged `source: 'self-instrumented'`. `/onboard` adopts it (Step 0);
 *   other user-typed commands can opt in the same way. The platform-event path
 *   (a future PostUserSlashCommand) would supersede this if Claude Code adds it.
 *
 *   Retro reference: `docs/.output/findings/reviews/retro-platform-alignment-may-2026.md`
 *   System Improvements row "Telemetry coverage".
 *
 * Event schema (A4 enrichment — adopted from gstack:
 *   docs/.output/findings/research/competitive/_hooks-and-core-scripts-comparison.md A4):
 *
 * @typedef {Object} TelemetryEvent
 * @property {string} timestamp - ISO 8601
 * @property {'command_invocation'|'gate_run'} type
 * @property {string} command - skill name or gate type ('gate:build'|'gate:test')
 * @property {number|null} duration_ms - Event duration if available (null until P1.6)
 * @property {'success'|'failure'|'unknown'} outcome - Success/failure signal; 'unknown' when no exit_code and no summary
 * @property {string|null} session_id - Stable per-session identifier (isolates one session's own
 *   command chain from a concurrent session sharing the working tree). Read from
 *   `CLAUDE_CODE_SESSION_ID` (set by Claude Code in every spawned subprocess's env, hooks included),
 *   falling back to the hook JSON payload's own `session_id` field if the env var is absent. Null
 *   only if neither source is available.
 */

const fs = require('fs');
const path = require('path');
const { appendJsonl: appendJsonlLib } = require('../core/_lib/jsonl-writer');
const { readHookInput } = require('../core/_lib/hook-input');
const { getJsonlPath } = require('../core/_lib/telemetry-paths');
const { readSummary } = require('../core/_lib/gate-summary');
const { resolveProjectRoot } = require('../core/_lib/project-root');

function resolveSessionId(parsedJson) {
    return process.env.CLAUDE_CODE_SESSION_ID || parsedJson?.session_id || null;
}

// Anchor telemetry writes to the repo root — not the caller's CWD. Without this,
// a prior `cd src && ...` in the same shell session leaves the Bash tool's CWD at
// `src/`, and the next PostToolUse hook dumps telemetry into `src/docs/.output/`
// instead of the real `docs/.output/`. Match the convention used by gate.js,
// memory-benchmark.js, decision-viz.js, and ~10 other core scripts:
// CLAUDE_PROJECT_DIR env var first, else resolve from __dirname (hook lives at
// .claude/hooks/, so ../../ is repo root).
//
// Resolved lazily (not at module load) so in-process tests can set
// CLAUDE_PROJECT_DIR per test case via beforeEach/afterEach without having to
// reload the module. The real hook invocation path is unaffected — the env var
// is either set by Claude Code or the __dirname fallback kicks in.
function getProjectRoot() {
    // F72-class sibling (CR-3.1 sweep): command-usage.jsonl is a gitignored
    // `.state/` telemetry file shared across linked worktrees — anchor to the
    // git-common-dir via resolveProjectRoot (still reads CLAUDE_PROJECT_DIR at
    // call time, so per-test lazy resolution is preserved) rather than the
    // naive __dirname fallback that loses history into a worktree-local path.
    return resolveProjectRoot(path.resolve(__dirname, '..', '..'));
}

// command-usage.jsonl is the longitudinal record consumed by /retro, /status,
// /timeline, and metrics.js — its value is the HISTORY, not the latest tail.
// It's append-mostly (a few hundred lines/week) and is never loaded by /prime
// (Key-File-banned), so a large cap is cheap. Sized to retain ~8-10 months at
// typical rates; the small tail caps (1000/500) used by high-churn logs like
// hook-events would silently discard weeks of history in a single rotation.
const MAX_JSONL_LINES = 6000;
const TAIL_KEEP_LINES = 5000;

/**
 * Infer whether a bash command is a gate.js invocation and return the gate type.
 *
 * @param {string|null} command - The bash command string
 * @returns {'gate:test'|'gate:build'|null}
 */
function inferGateRun(command) {
    if (!command || !command.includes('gate.js')) return null;
    // Match: gate.js --test, gate.js test → gate:test
    // Match: gate.js build, gate.js (bare) → gate:build
    if (/gate\.js\s+(--test|test)\b/.test(command)) return 'gate:test';
    if (/gate\.js/.test(command)) return 'gate:build';
    return null;
}

/**
 * Read gate.js's `_latest-summary.json` to determine the most recent gate's
 * pass/fail outcome. Used as a fallback when Claude Code's PostToolUse:Bash
 * payload omits exit_code (which it always does as of this writing — the
 * tool_response shape is { stdout, stderr, interrupted, isImage }, no exit code).
 *
 * Without this fallback every gate_run telemetry entry logs outcome:fail —
 * surfaced as a 3-strikes finding across TDD-3, TDD-5, and TDD-6 retros.
 *
 * @returns {{ overall: boolean } | null} Parsed summary, or null on any read/parse failure
 */
function readGateSummary() {
    return readSummary(getProjectRoot());
}

/**
 * Append a JSONL entry. Thin adapter over _lib/jsonl-writer; preserves the
 * module-level export shape for backward compatibility with existing tests.
 *
 * @param {string} jsonlPath - Absolute path to the JSONL file
 * @param {object} event - The event object to append
 */
function appendJsonl(jsonlPath, event) {
    appendJsonlLib(jsonlPath, event, {
        maxLines: MAX_JSONL_LINES,
        tailKeep: TAIL_KEEP_LINES,
    });
}

/**
 * Process a PostToolUse event and append a telemetry entry if relevant.
 *
 * The output path is resolved from CLAUDE_PROJECT_DIR (or __dirname fallback);
 * `parsedJson.cwd` is intentionally ignored — relying on the caller's CWD was
 * the source bug this hook had to fix.
 *
 * @param {object} parsedJson - { tool_name, tool_input, tool_output, tool_response }
 * @returns {null} Always returns null
 */
function processEvent(parsedJson) {
    let event = null;

    // Check for command invocation (PostToolUse:Skill)
    const skillName = parsedJson?.tool_input?.skill;
    if (skillName) {
        event = {
            timestamp: new Date().toISOString(),
            type: 'command_invocation',
            command: skillName,
            duration_ms: null,
            session_id: resolveSessionId(parsedJson),
        };
    }

    // Check for gate run (PostToolUse:Bash)
    const bashCommand = parsedJson?.tool_input?.command || '';
    const gateCommand = inferGateRun(bashCommand);
    if (gateCommand) {
        // Outcome resolution precedence:
        //   1. exit_code from tool_response/tool_output if present (preferred —
        //      backward-compatible with any future Claude Code version that
        //      adds exit_code to the Bash hook payload)
        //   2. _latest-summary.json from gate.js (current production path —
        //      Claude Code's PostToolUse:Bash payload does NOT include exit_code,
        //      so without this fallback every gate_run logged 'fail')
        //   3. 'unknown' — no exit_code AND no summary; previously defaulted to
        //      'fail' but that masked the absence of any signal (A4 schema)
        const exitCode = parsedJson?.tool_response?.exit_code ?? parsedJson?.tool_output?.exit_code ?? null;

        // Read the gate summary once — it carries both the outcome fallback AND
        // the wall-clock duration. gate.js stamps `durationMs` into the summary
        // immediately before exit; the PostToolUse:Bash payload has no timing of
        // its own, so the summary is the only source for gate_run duration.
        const summary = readGateSummary();

        let outcome;
        if (exitCode !== null) {
            outcome = exitCode === 0 ? 'success' : 'failure';
        } else if (summary === null) {
            outcome = 'unknown';
        } else {
            outcome = summary.overall === true ? 'success' : 'failure';
        }

        // duration_ms: real value from gate.js when available, else null (an
        // older gate.js predating the durationMs field, or no summary written).
        const durationMs = typeof summary?.durationMs === 'number' ? summary.durationMs : null;

        event = {
            timestamp: new Date().toISOString(),
            type: 'gate_run',
            command: gateCommand,
            duration_ms: durationMs,
            outcome,
            session_id: resolveSessionId(parsedJson),
        };
    }

    if (!event) { return null; }

    // Write to JSONL — always under the resolved project root, regardless of
    // caller CWD or anything in the event payload.
    const jsonlPath = getJsonlPath(getProjectRoot(), 'command-usage.jsonl');

    appendJsonl(jsonlPath, event);

    return null;
}

async function main() {
    const input = await readHookInput();
    if (!input) { process.exit(0); }

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        process.exit(0);
    }

    processEvent(data);
    process.exit(0);
}

if (require.main === module) {
    // P1.7 — hook duration instrumentation (Section-D blind-spot).
    // process.on('exit') handler fires synchronously on every exit path in
    // main() (three of them — empty input, JSON parse failure, normal run).
    // Telemetry write is wrapped in try/catch so a JSONL append failure
    // never surfaces as a hook error — observability is optional.
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('command-usage-logger');
    process.on('exit', () => {
        try { emitHookEvent(_hookToken, 'success'); } catch { /* never fail on telemetry */ }
    });
    main().catch(() => process.exit(0));
}

module.exports = { processEvent, inferGateRun, appendJsonl, MAX_JSONL_LINES, TAIL_KEEP_LINES };
