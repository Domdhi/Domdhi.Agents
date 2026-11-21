/**
 * Damage Control Hook
 *
 * PostToolUse:Bash — runs after every Bash command.
 * When a command fails (non-zero exit or interrupted), surfaces a structured
 * error analysis prompt that forces diagnosis before any retry.
 *
 * Pattern: Pi Agent — capture the error, require root cause, prevent spin loops.
 *
 * Output: JSON feedback message shown in Claude's context (never blocks the tool).
 * Exit: Always 0 — this hook informs, it does not block.
 */

const { readHookInput } = require('../core/_lib/hook-input');

// SF-1.5: a failed test/gate command gets ledger-backed repeat-failure text instead of the
// static "2nd+ failure" line. Read-only; the ledger is written by gate.js / failure-ledger.js.
//
// The ledger text is only used when it plausibly describes the failure just seen:
//   - the command RUNS a test runner or the gate (a segment that starts with it; a `grep gate.js`
//     or `cat vitest.config.js` merely mentions one),
//   - the newest counted ledger row is recent (LEDGER_FRESH_MS), and
//   - when both identities are known, that row is for the tree as it is now (gate.js writes its row
//     just before the failure is reported, so the tree has not moved since).
// Anything else keeps the static line: a stale or unrelated row must never tell an agent to stop.
const COMMAND_SEPARATOR_RE = /&&|\|\||[;|\n]/;
const LEADING_WRAPPERS_RE = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|time|nice|command|exec|env)\s+|timeout\s+\S+\s+)+/;
const TEST_COMMAND_PATTERNS = [
    /^node(?:js)?\s+(?:-\S+\s+)*["']?(?:\S*[\\/])?gate\.js["']?(?:\s|$)/,
    /^node(?:js)?\s+(?:-\S+\s+)*["']?(?:\S*[\\/])?run-toolkit-tests\.cjs["']?(?:\s|$)/,
    /^(?:npx(?:\s+-\S+)*\s+)?(?:vitest|jest|pytest)(?:\s|$)/,
    /^(?:python3?|py)\s+(?:-\S+\s+)*-m\s+pytest(?:\s|$)/,
    /^dotnet\s+test(?:\s|$)/,
    /^npm\s+(?:run\s+)?test(?:\s|$)/,
];
const STATIC_RETRY_LINE = '4. If this is the 2nd+ failure on the same problem: STOP and surface to user';
// Newest ~256 KB of the ledger is far more than the 2000-line cap's recent tail needs
// and keeps the hook fast; classification only looks at the newest rows.
const LEDGER_TAIL_BYTES = 256 * 1024;
const LEDGER_FRESH_MS = 2 * 60 * 60 * 1000;

/** True when `command` runs the gate or a test runner (any `&&`, `;` or `|` segment of it does). */
function isTestCommand(command) {
    if (typeof command !== 'string') return false;
    return command.split(COMMAND_SEPARATOR_RE).some(segment => {
        const bare = segment.trim().replace(LEADING_WRAPPERS_RE, '');
        return TEST_COMMAND_PATTERNS.some(re => re.test(bare));
    });
}

const isKilledRow = r => r.killed != null && r.killed !== false && r.killed !== '';

/**
 * Ledger-backed replacement for the static retry line, or null when the command is not a
 * test/gate run, the ledger holds nothing usable, or what it holds is old or for another tree
 * (the caller keeps the static line).
 *
 * @param {string} command
 * @param {string} [root] — project root override (testing)
 * @returns {string[]|null}
 */
function ledgerRetryLines(command, root) {
    if (!isTestCommand(command)) return null;
    try {
        const ledger = require('../core/_lib/failure-ledger');
        const rootDir = root || ledger.getProjectRoot();
        const rows = ledger.readLedger({ root: rootDir, tailBytes: LEDGER_TAIL_BYTES });
        const newest = [...rows].reverse().find(r => r && typeof r === 'object' && !isKilledRow(r));
        if (!newest) return null;
        const ageMs = Math.abs(Date.now() - Date.parse(newest.ts));
        if (!Number.isFinite(ageMs) || ageMs > LEDGER_FRESH_MS) return null;
        if (newest.head != null) {
            const current = ledger.currentHead(rootDir);
            if (current != null && current !== newest.head) return null;
        }
        const c = ledger.classify(rows);
        if (c.class === 'none' || c.class === 'pass') return null;

        const lines = [`4. ${ledger.seenLine(c)}`];
        if (c.class === 'flaky') {
            lines.push('5. This failure is classed flaky: the same tree also passed. It does not count toward escalation. Look for nondeterminism (ordering, timing, shared state) instead of changing the code under test.');
        } else if (c.class === 'environment') {
            lines.push('5. This failure is classed environment (network, port, disk or memory). It does not count toward escalation. Fix the environment, then re-run; do not change code to chase it.');
        } else if (c.count >= 3) {
            lines.push(
                `5. STOP AND ASK: this exact failure has now repeated ${c.count} times on changed code. Do not attempt another fix.`,
                '   Per systematic-debugging: three failed fixes mean question the architecture, not the next hypothesis.',
                '   Record each rejected approach first (rejected-approaches memory, /remember), then surface the situation to the user.'
            );
        } else if (c.count === 2) {
            lines.push(
                '5. CHANGE STRATEGY: the same failure came back after a fix. Do not retry the same kind of fix.',
                '   Form a new hypothesis from the evidence (systematic-debugging Phase 1) or take one escalation (a deeper-tier subagent attempt).',
                '   If the next run fails with the same signature, stop and ask the user.'
            );
        } else {
            lines.push('5. First occurrence of this failure: fix the root cause, then re-run. A repeat of the same signature means changing strategy.');
        }
        return lines;
    } catch {
        return null; // fail safe: never let ledger trouble change the hook's behavior
    }
}

/**
 * Classify the result of a Bash tool invocation.
 *
 * @param {string} command — The command that was run
 * @param {number|null|undefined} exitCode — The process exit code
 * @param {string} stderr — Stderr output (may be empty)
 * @param {boolean} interrupted — Whether the command was interrupted
 * @returns {{ failed: boolean, reason: string, errorBlock: string, pattern: string|null }}
 */
function classifyError(command, exitCode, stderr, interrupted) {
    const hasNonZeroExit = exitCode !== undefined && exitCode !== null && exitCode !== 0;
    const failed = interrupted || hasNonZeroExit;

    const reason = interrupted
        ? 'Command was interrupted'
        : `Exit code ${exitCode}`;

    // Format the error preview (cap at 15 lines to keep feedback readable)
    const errorLines = stderr ? stderr.split('\n') : [];
    const previewLines = errorLines.slice(0, 15);
    const overflow = errorLines.length - previewLines.length;
    const errorBlock = previewLines.join('\n') + (overflow > 0 ? `\n... (${overflow} more lines)` : '');

    // Pattern classification — identifies common failure categories
    let pattern = null;
    if (/EACCES/.test(stderr)) {
        pattern = 'permission';
    } else if (/non-fast-forward/.test(stderr)) {
        pattern = 'divergence';
    } else if (/Cannot find module/.test(stderr)) {
        pattern = 'missing_module';
    }

    return { failed, reason, errorBlock, pattern };
}

/**
 * Process a PostToolUse:Bash hook event.
 *
 * @param {object} parsedJson — Hook event payload
 * @param {{ root?: string }} [opts] — root overrides the project root the ledger is read from
 * @returns {{ feedback: string } | null}
 */
function processEvent(parsedJson, opts = {}) {
    const toolInput = (parsedJson && parsedJson.tool_input) || {};
    const toolResponse = (parsedJson && parsedJson.tool_response) || {};

    const command = toolInput.command || '';
    const error = (toolResponse.error || '').trim();
    const interrupted = toolResponse.interrupted === true;

    // Check exit code — Claude Code may expose it under different field names
    const exitCode =
        toolResponse.exit_code ??
        toolResponse.exitCode ??
        toolResponse.returncode ??
        toolResponse.return_code;

    const result = classifyError(command, exitCode, error, interrupted);
    if (!result.failed) return null;

    const commandPreview = command.length > 120
        ? command.slice(0, 120) + '...'
        : command;

    const lines = [
        '━━ DAMAGE CONTROL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `Command : ${commandPreview}`,
        `Failure : ${result.reason}`,
    ];

    if (result.errorBlock) {
        lines.push('', 'Stderr:', result.errorBlock);
    }

    lines.push(
        '',
        '━━ REQUIRED BEFORE RETRYING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '1. Read the error above fully — identify the ROOT CAUSE',
        '2. State what specifically failed and why',
        '3. Propose ONE targeted fix — not a blind retry of the same command',
        ...(ledgerRetryLines(command, opts && opts.root) || [STATIC_RETRY_LINE]),
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    );

    return { feedback: lines.join('\n') };
}

async function run() {
    // Bounded ceiling — a wedged pipe resolves with partial data instead of hanging.
    const input = await readHookInput({ timeoutMs: 5000 });
    if (!input) process.exit(0);

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        process.exit(0);
    }

    const result = processEvent(data);
    if (result) {
        console.log(JSON.stringify(result));
    }
    process.exit(0); // Always 0 — inform only, never block
}

if (require.main === module) {
    // P1.7 — hook duration instrumentation (Section-D blind-spot).
    // process.on('exit') is the minimal-diff shim: run()'s internal
    // process.exit(0) calls fire this handler synchronously before the
    // process terminates, so we emit timing without restructuring run()'s
    // existing exit paths. The try/catch keeps telemetry failures from
    // surfacing as hook errors.
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('damage-control');
    process.on('exit', () => {
        try { emitHookEvent(_hookToken, 'success'); } catch { /* never fail on telemetry */ }
    });
    run();
}

module.exports = { processEvent, classifyError, isTestCommand };
