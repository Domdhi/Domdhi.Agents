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
 * @returns {{ feedback: string } | null}
 */
function processEvent(parsedJson) {
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
        '4. If this is the 2nd+ failure on the same problem: STOP and surface to user',
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

module.exports = { processEvent, classifyError };
