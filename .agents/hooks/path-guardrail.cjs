#!/usr/bin/env node

/**
 * Path Guardrail — PreToolUse:Write/Edit Hook
 *
 * Consumes the four-tier path schema from `.claude/guardrail-rules.yaml`
 * (`zeroAccessPaths` / `readOnlyPaths` / `noDeletePaths`) and the freeze-state
 * file at `docs/.output/.state/freeze-state.json` to gate Write and Edit tool calls
 * BEFORE Claude executes them. Companion to the existing PreToolUse:Bash
 * guardrail (`.claude/hooks/guardrail.cjs`) which gates only Bash deletes.
 *
 * P2.5 shipped the library APIs (`_lib/guardrail-rules.checkPathAccess`,
 * `_lib/command-blocker.checkFreezeState` + `buildHookResponse`) but only wired
 * Bash enforcement; this hook closes the deferred Edit/Write surface.
 *
 * Exit codes (Claude Code semantics):
 *   0 = pass — proceed silently
 *   2 = blocked — hard stop (exit 1 is non-blocking in Claude Code)
 *
 * Failure mode: any unexpected error → exit 0 (graceful pass-through).
 * The hook never crashes Claude Code.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { readHookInput } = require('../core/_lib/hook-input');
const { loadRules, checkPathAccess } = require('../core/_lib/guardrail-rules');
const { buildHookResponse, checkFreezeState } = require('../core/_lib/command-blocker');
const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');

// 5000ms ceiling on the stdin read (blocking-hook parity). Env override exists
// ONLY so a fail-closed timeout test can shrink the wait for a real spawned
// process without changing production behavior — same pattern as
// secret-scanner.cjs's SECRET_SCANNER_STDIN_TIMEOUT_MS.
const STDIN_TIMEOUT_MS = parseInt(process.env.HOOK_STDIN_TIMEOUT_MS, 10) || 5000;

// Tools whose tool_input includes a file path the guardrail should gate.
// Write / Edit / MultiEdit all use `tool_input.file_path`.
// NotebookEdit uses `tool_input.notebook_path` — see getTargetPath below.
const GATED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Extract the target file path from a parsed tool_input, accounting for the
 * NotebookEdit field-name divergence. Returns '' when no path is present.
 */
function getTargetPath(toolName, toolInput) {
    if (!toolInput) return '';
    if (toolName === 'NotebookEdit') return toolInput.notebook_path || '';
    return toolInput.file_path || '';
}

// ─── Path resolution ──────────────────────────────────────────────────────────

function getProjectRoot() {
    return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
}

function resolveRulesPath() {
    return path.join(getProjectRoot(), '.claude', 'guardrail-rules.yaml');
}

function resolveAbsPath(p) {
    if (!p) return '';
    if (path.isAbsolute(p)) return p;
    return path.resolve(getProjectRoot(), p);
}

// ─── Event processor (testable core logic) ────────────────────────────────────

/**
 * Process a parsed PreToolUse hook payload. Returns a block result or null.
 *
 * @param {object} parsedJson  Parsed hook payload — {tool_name, tool_input:{file_path}}
 * @returns {null | { block: true, feedback: string }}
 */
function processEvent(parsedJson) {
    const toolName = (parsedJson && parsedJson.tool_name) || '';
    if (!GATED_TOOLS.has(toolName)) return null;

    const toolInput = parsedJson.tool_input || {};
    const targetPath = getTargetPath(toolName, toolInput);
    if (!targetPath) return null;

    const absPath = resolveAbsPath(targetPath);

    // 1. Freeze-state check (A2) — /investigate-locked paths.
    const freeze = checkFreezeState(absPath);
    if (freeze.blocked) {
        const resp = buildHookResponse('frozen', {
            command: `${toolName} ${targetPath}`,
            frozenPath: freeze.frozenPath,
        });
        return { block: true, feedback: resp.stderr };
    }

    // 2. Four-tier path check (A3). Missing/malformed rules file → emptyRules
    // → all paths pass; matches the Bash hook's graceful posture.
    //
    // hooks-m3 — fail CLOSED on an UNEXPECTED error. `_lib/loadRules` is graceful
    // (missing/unreadable/malformed → emptyRules(), never throws), so the soft
    // tiers still pass through when rules are simply absent. Reaching a catch
    // here means a genuine surprise where we cannot classify the target's tier —
    // block rather than silently permit what could be a zeroAccessPaths write.
    let rules;
    try {
        rules = loadRules(resolveRulesPath());
    } catch {
        const resp = buildHookResponse('block', {
            command: `${toolName} ${targetPath}`,
            pattern: 'guardrail rule-load error — failing closed',
            tier: 'zeroAccessPaths',
        });
        return { block: true, feedback: resp.stderr };
    }

    let access;
    try {
        access = checkPathAccess(absPath, toolInput.codex_operation === 'delete' ? 'delete' : 'write', rules);
    } catch {
        const resp = buildHookResponse('block', {
            command: `${toolName} ${targetPath}`,
            pattern: 'guardrail tier-check error — failing closed',
            tier: 'zeroAccessPaths',
        });
        return { block: true, feedback: resp.stderr };
    }
    if (!access.allowed) {
        const resp = buildHookResponse('block', {
            command: `${toolName} ${targetPath}`,
            pattern: access.reason || 'path-tier enforcement',
            tier: access.tier,
        });
        return { block: true, feedback: resp.stderr };
    }

    return null;
}

// ─── Hook entry point ─────────────────────────────────────────────────────────

async function runClaudeHook() {
    const t = startHookTiming('path-guardrail');
    let outcome = 'success';

    try {
        // Fail CLOSED on a wedged/truncated stdin read or an unparseable non-empty
        // payload. Either means the Write/Edit target never arrived intact — the
        // graceful outer catch below (exit 0) would let it through with NO path-tier
        // enforcement, silently permitting what could be a zeroAccessPaths write.
        // Block instead, matching secret-scanner.cjs and the two Bash guards. A
        // clean `end` (even empty) still resolves, so a legitimate empty-stdin
        // invocation is unaffected. These blocks emit + exit BEFORE the outer catch
        // so the rejection is not reclassified as a graceful failure. (finding 2)
        let input;
        try {
            input = await readHookInput({ timeoutMs: STDIN_TIMEOUT_MS, failClosedOnTimeout: true });
        } catch (err) {
            outcome = 'blocked';
            process.stderr.write('[path-guardrail] BLOCKED (fail-closed): stdin read did not complete — ' + (err && err.message) + '\n');
            try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
            process.exit(2);
        }
        if (!input.trim()) return;

        let data;
        try {
            data = JSON.parse(input);
        } catch {
            outcome = 'blocked';
            process.stderr.write('[path-guardrail] BLOCKED (fail-closed): could not parse stdin payload as JSON.\n');
            try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
            process.exit(2);
        }

        const result = processEvent(data);
        if (result && result.block) {
            outcome = 'blocked';
            process.stderr.write(result.feedback);
            try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
            process.exit(2);
        }
    } catch (err) {
        outcome = 'failure';
        // Graceful — never crash Claude Code on a hook error.
        try { process.stderr.write(`[path-guardrail] non-fatal error: ${err.message}\n`); } catch { /* swallow */ }
    } finally {
        try { emitHookEvent(t, outcome); } catch { /* never crash on telemetry */ }
    }

    process.exit(0);
}

if (require.main === module) {
    runClaudeHook();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    processEvent,
    resolveAbsPath,
    getTargetPath,
    GATED_TOOLS,
};

// Suppress lint warning for fs being unused at top-level — kept for symmetry
// with the Bash guardrail and for future fs-dependent extensions (e.g.
// dropping the rules-file path resolution into an isFile probe).
void fs;
