/**
 * Command Blocker — hook response builder for guardrail decisions.
 *
 * Extracted from .claude/hooks/guardrail.cjs as part of the P2.3 guardrail
 * split. Extended by P2.5 with:
 *   - Freeze-state consultation (A2 from gstack `/freeze` pattern)
 *   - Path-tier block response formatting (for zeroAccess / readOnly /
 *     noDelete matches surfaced by `guardrail-rules.checkPathAccess`)
 *
 * Competitor-pattern provenance:
 *   A2 — freeze-state from gstack — the function `checkFreezeState` mirrors
 *        gstack's posture: during an /investigate session, enumerated paths
 *        are "frozen" and any Edit/Write/Delete against them gets a
 *        block response with `reason: "File is frozen by /investigate"`.
 *
 * EXIT CODE CONTRACT (SACRED — do not change)
 * ────────────────────────────────────────────
 *   exitCode 0                    = pass — silent, command executes
 *   exitCode 0 + stdout JSON      = confirm — Claude Code prompts user yes/no
 *   exitCode 2                    = block — command is hard-stopped
 *
 * Note: exitCode 1 is NOT used. Claude Code treats exit 1 as non-blocking —
 * the command still executes. Only exit 2 prevents execution.
 */

'use strict';

const { isFrozen } = require('./freeze-state');

// ─── Block message formatter ───────────────────────────────────────────────────

/**
 * Format the stderr block message for a blocked command.
 *
 * @param {string} command        - The original command (before sanitization)
 * @param {string} matchedPattern - The rule pattern that triggered the block
 * @param {string} [tier]         - Optional path-tier name (zeroAccessPaths / readOnlyPaths / noDeletePaths / dangerousPatterns)
 * @returns {string}
 */
function formatBlocked(command, matchedPattern, tier) {
    const tierLine = tier ? ['  Tier    : ' + tier] : [];
    // A configuration-file tier can be lifted by the project-owned override; the
    // managed rules file is template-zone and must not be edited for it.
    const liftable = tier === 'readOnlyPaths' || tier === 'noDeletePaths';
    const options = liftable
        ? [
            '    1. A person makes the change in their own editor or terminal',
            '    2. Have a person list the exact entry under `except:` in the',
            '       project-owned .claude/guardrail-rules.project.yaml (updates never',
            '       overwrite it; that file is itself read-only to agents)',
        ]
        : [
            '    1. Run the command manually in your terminal',
            '    2. Ask the toolkit maintainers to change the shipped rule (an edit of',
            '       guardrail-rules.yaml is overwritten by the next update)',
        ];
    return [
        '',
        '========================================',
        '  GUARDRAIL — COMMAND BLOCKED',
        '========================================',
        '',
        '  Command : ' + command,
        '  Matched : ' + matchedPattern,
        ...tierLine,
        '  Reason  : This command matches a block_pattern in',
        '            .claude/guardrail-rules.yaml and has been',
        '            stopped before execution.',
        '',
        '  To allow this command, either:',
        ...options,
        '========================================',
        '',
    ].join('\n');
}

/**
 * Format the stderr block message for a frozen path.
 *
 * @param {string} command - The original command (before sanitization)
 * @param {string} frozenPath - The frozen path that blocked the command
 * @returns {string}
 */
function formatFrozen(command, frozenPath) {
    return [
        '',
        '========================================',
        '  GUARDRAIL — FROZEN PATH',
        '========================================',
        '',
        '  Command : ' + command,
        '  Path    : ' + frozenPath,
        '  Reason  : File is frozen by /investigate — the active',
        '            investigation has marked this path read-locked to',
        '            preserve the state under investigation.',
        '',
        '  To unfreeze: exit the investigation (/investigate end),',
        '  then re-run the command.',
        '========================================',
        '',
    ].join('\n');
}

// ─── Nudge message formatter ───────────────────────────────────────────────────

/**
 * Format the stderr message for a `nudge` decision — a soft deny (exit 2) that
 * tells the agent to try a reversible alternative first, and exactly how to
 * escalate to a user confirm if there genuinely is none.
 *
 * @param {string} command        - The original command (before sanitization)
 * @param {string} matchedPattern - The nudge_pattern that triggered the nudge
 * @returns {string}
 */
function formatNudge(command, matchedPattern) {
    return [
        '',
        '========================================',
        '  GUARDRAIL — TRY A SAFER ALTERNATIVE FIRST',
        '========================================',
        '',
        '  Command : ' + command,
        '  Matched : ' + matchedPattern,
        '  Reason  : This is destructive / hard to reverse. Before running it,',
        '            prefer a reversible alternative:',
        '              - move the target aside (mv to a temp dir) instead of deleting',
        '              - `git rm` for tracked files (keeps history)',
        '              - trash/recycle, or scope the path more tightly',
        '              - dry-run first (e.g. `git clean -n`, `rm -i`)',
        '',
        '  If you have genuinely confirmed there is no reversible alternative,',
        '  re-run the SAME command with the escalation marker appended and the',
        '  user will be asked to approve it:',
        '',
        '      ' + command + '  # guardrail:confirm',
        '',
        '========================================',
        '',
    ].join('\n');
}

// ─── Confirm message formatter ─────────────────────────────────────────────────

function formatConfirmJson(reason) {
    const output = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: reason,
        },
    };
    return JSON.stringify(output);
}

// ─── buildHookResponse ─────────────────────────────────────────────────────────

/**
 * Convert a guardrail decision into a hook response object.
 *
 * The hook entry point (guardrail.cjs) uses this return value to:
 *   - Write result.stdout to process.stdout (empty string = no write needed)
 *   - Write result.stderr to process.stderr (empty string = no write needed)
 *   - Call process.exit(result.exitCode)
 *
 * @param {'block'|'nudge'|'confirm'|'pass'|'frozen'|string} decision - Decision label
 * @param {object} [opts]
 * @param {string} [opts.command]      - Original command (for block message)
 * @param {string} [opts.pattern]      - Matched pattern (for block message)
 * @param {string} [opts.tier]         - Matched tier name (optional)
 * @param {string} [opts.reason]       - Reason string (for confirm message)
 * @param {string} [opts.frozenPath]   - Frozen path (for `frozen` decision)
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
function buildHookResponse(decision, opts = {}) {
    if (decision === 'block') {
        return {
            stdout: '',
            stderr: formatBlocked(opts.command || '', opts.pattern || '', opts.tier),
            exitCode: 2,
        };
    }

    if (decision === 'frozen') {
        return {
            stdout: '',
            stderr: formatFrozen(opts.command || '', opts.frozenPath || ''),
            exitCode: 2,
        };
    }

    if (decision === 'nudge') {
        return {
            stdout: '',
            stderr: formatNudge(opts.command || '', opts.pattern || ''),
            exitCode: 2,
        };
    }

    if (decision === 'confirm') {
        return {
            stdout: formatConfirmJson(opts.reason || ''),
            stderr: '',
            exitCode: 0,
        };
    }

    // 'pass' and any unknown/unrecognized decision — safe default
    return {
        stdout: '',
        stderr: '',
        exitCode: 0,
    };
}

// ─── Freeze-state consultation ────────────────────────────────────────────────

/**
 * Check whether a path is frozen by an active /investigate session.
 * Returns a response-ready object the caller can pass into buildHookResponse.
 *
 * Currently called only for Bash delete operations (rm/del/unlink) since
 * that is the only path-aware surface the guardrail presently owns.
 * Future Edit/Write hook integrations will consult this for those ops too.
 *
 * @param {string} absPath
 * @returns {{ blocked: boolean, frozenPath?: string }}
 */
function checkFreezeState(absPath) {
    if (isFrozen(absPath)) {
        return { blocked: true, frozenPath: absPath };
    }
    return { blocked: false };
}

module.exports = { buildHookResponse, checkFreezeState };
