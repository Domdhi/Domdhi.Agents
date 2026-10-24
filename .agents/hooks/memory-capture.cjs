#!/usr/bin/env node

/**
 * Memory Capture Hook — raw daily-log capture + strict-mode curator
 *
 * Fires on:
 *   - Stop event: captures daily log and runs curator (strict profile only)
 *   - PostToolUse:Bash event: captures commit context on git commit (PMC-3)
 *
 * Stop pipeline (all fire-and-forget, non-blocking):
 *   1. daily-log.js capture    — raw session log (30-min dedup)
 *   2. memory-curator.js       — Haiku dedup/contradiction analyzer (MEMORY_PROFILE=strict only)
 *
 * Memory extraction is NOT triggered here. It fires from the session-handoff
 * skill (Step 6) on every /do, /run-todo wave, /run-tests, /todo, /end.
 * The compiler pipeline was retired 2026-04-20 (produced ceremony, not knowledge).
 *
 * Exit codes: always 0 (non-blocking)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { isAtLeast } = require('../core/profile');
const { readHookInput } = require('../core/_lib/hook-input');
const { spawnDailyLogCapture, spawnBackground } = require('../core/_lib/hook-spawners');
const DailyLog = require('../core/daily-log');

const DEDUP_MINUTES = 30;
// Shell tools whose PostToolUse events carry a command: Bash, and the PowerShell tool
// Claude Code offers on Windows (registered together in the Claude settings adapter).
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

const { resolveProjectRoot } = require('../core/_lib/project-root');

function getProjectDir() {
    // Anchor to the MAIN worktree so daily-log + curator writes land in the one
    // shared store, not a throwaway worktree-local copy (the worktree memory-loss
    // fix). git show/captureCommit still work — objects live in the shared .git.
    return resolveProjectRoot(path.resolve(__dirname, '..', '..'));
}

function getDailyLogPath() {
    return require('../core/_lib/daily-log-paths').getDailyLogPath(new Date(), getProjectDir());
}

/**
 * Check if a daily log capture is needed (time-based dedup).
 * Returns true if we should capture.
 */
function shouldCapture() {
    try {
        const stat = fs.statSync(getDailyLogPath());
        const minutesSinceUpdate = (Date.now() - stat.mtimeMs) / 60000;
        return minutesSinceUpdate >= DEDUP_MINUTES;
    } catch {
        // File doesn't exist — first capture of the day
        return true;
    }
}

/**
 * Spawn daily-log.js capture asynchronously (fire and forget).
 * Does NOT block the calling process. Thin wrapper over the shared helper.
 */
function spawnCapture(trigger) {
    spawnDailyLogCapture(getProjectDir(), trigger);
}

/**
 * Spawn memory-curator.js curate asynchronously (fire and forget).
 * Haiku-powered dedup/contradiction/merge analyzer. Runs only when MEMORY_PROFILE=strict.
 * Through the shared spawnBackground: detached on Windows, where a
 * non-detached child is killed when this hook exits.
 */
function spawnCurate() {
    if (!isAtLeast('strict')) return;
    const projectDir = getProjectDir();
    const curatorPath = path.join(projectDir, '.claude', 'core', 'memory-curator.js');
    if (!fs.existsSync(curatorPath)) return;
    spawnBackground('node', [curatorPath, 'curate'], { cwd: projectDir });
}

/**
 * Handle Stop events — capture daily log; run curator under strict profile.
 *
 * Extraction is NOT triggered here. It fires from the session-handoff skill
 * (Step 6) on every /do, /run-todo wave, /run-tests, /todo, /end completion.
 * The compiler pipeline was retired 2026-04-20.
 */
function handleStop() {
    if (shouldCapture()) {
        spawnCapture('auto-stop');
    }
    spawnCurate();
}

/**
 * Recognize a command that produces a commit whose context we want to capture.
 *
 * Two forms produce a commit in this repo:
 *   1. a plain `git commit …`
 *   2. `node .claude/core/commit.js …` — the MANDATED path (commit-guard blocks
 *      inline `git commit -m`). commit.js runs `git commit -F` in a CHILD
 *      process, so the PostToolUse hook only ever sees the commit.js invocation,
 *      never a bare `git commit`. Missing form 2 meant the diffstat/hash/daily-log
 *      enrichment never fired for the repo's normal commit flow (F64).
 */
function isCommitCommand(command) {
    return /^git\s+commit\b/.test(command) ||
        /(?:^|\s)node\s+\S*commit\.js(?:\s|$)/.test(command);
}

/**
 * Handle PostToolUse:Bash events — detect commits and enrich daily log.
 *
 * Payload shape note (2026-04-20): Claude Code sends the command's output under
 * `tool_response.stdout`. The `tool_output` field was the older shape; kept as
 * a fallback for backward compatibility.
 */
function handleBashPostToolUse(input) {
    const command = input.tool_input.command || '';
    const stdout =
        (input.tool_response && input.tool_response.stdout) ||
        (input.tool_output && input.tool_output.stdout) ||
        '';

    // Only capture successful commits (git commit OR commit.js), not --amend
    if (!isCommitCommand(command) || /--amend/.test(command)) {
        return;
    }

    // Parse commit hash and subject from git output
    // Format: "[branch hash] subject"
    const commitMatch = stdout.match(/\[[\w/.-]+\s+([a-f0-9]{7,})\]\s+(.+)/);
    if (!commitMatch) {
        return;
    }

    const hash = commitMatch[1];
    const subject = commitMatch[2];

    const projectDir = getProjectDir();
    const dailyLogPath = getDailyLogPath();

    // Count files changed from output (e.g., "3 files changed")
    const filesMatch = stdout.match(/(\d+)\s+files?\s+changed/);
    const filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;

    // Dedup: check if this commit hash is already in today's daily log
    try {
        const content = fs.readFileSync(dailyLogPath, 'utf8');
        if (content.includes(hash)) {
            return; // Already captured
        }
    } catch {
        // File doesn't exist yet — proceed with capture
    }

    // Diffstat enrichment (AMEM-2.1): run git show --numstat, sum insertions/deletions
    // Non-fatal — if git show fails (rare race, shallow clone, hash gone), capture without diffstat
    let insertions, deletions;
    try {
        const numstat = execSync(`git show --numstat --format= ${hash}`, {
            cwd: projectDir,
            encoding: 'utf8',
            timeout: 2000,
            windowsHide: true
        });
        let ins = 0, del = 0;
        for (const line of numstat.split('\n')) {
            const parts = line.split('\t');
            if (parts.length < 3) continue;
            // Binary files show '-' instead of numbers — skip those for the sum
            const i = parseInt(parts[0], 10);
            const d = parseInt(parts[1], 10);
            if (Number.isFinite(i)) ins += i;
            if (Number.isFinite(d)) del += d;
        }
        insertions = ins;
        deletions = del;
    } catch {
        // Leave insertions/deletions undefined — captureCommit will omit the line
    }

    // Use DailyLog.captureCommit if available, otherwise append directly via the
    // shared formatter. Both branches build the entry text through
    // DailyLog.formatCommitEntry, so the two paths can never drift in format —
    // this fallback exists only for when the DailyLog class/fs operations
    // themselves are unavailable (e.g. permissions, bad path), not to
    // independently reproduce the string template.
    try {
        const log = new DailyLog(projectDir);
        log.captureCommit(hash, subject, filesChanged, insertions, deletions);
    } catch {
        const now = new Date();
        const timeLabel = now.toISOString().slice(11, 16);
        const entry = DailyLog.formatCommitEntry(hash, subject, filesChanged, insertions, deletions, timeLabel);
        const dailyDir = path.join(projectDir, 'docs', '.output', '.state', 'memory-daily');
        fs.mkdirSync(dailyDir, { recursive: true });
        fs.appendFileSync(dailyLogPath, entry, 'utf8');
    }
}

/**
 * Route a parsed event (or null for Stop) to the appropriate handler.
 *
 * - If profile gate fails (isAtLeast('standard') false) → return null, no side-effects
 * - If parsedJson is null/empty → handleStop() → return null
 * - If tool_name is a shell tool ('Bash', or Claude Code's Windows 'PowerShell') && tool_input.command
 *   → handleBashPostToolUse(parsedJson) → return null
 * - Else → handleStop() → return null
 *
 * @param {object|null} parsedJson - Parsed stdin JSON, or null for Stop events
 * @returns {null} Always returns null (side effects only)
 */
function processEvent(parsedJson) {
    // MEMORY_PROFILE gate — minimal profile skips the whole hook
    if (!isAtLeast('standard')) {
        return null;
    }

    // Null/empty input → Stop event
    if (!parsedJson || Object.keys(parsedJson).length === 0) {
        handleStop();
        return null;
    }

    // Route based on input structure
    if (SHELL_TOOLS.has(parsedJson.tool_name) && parsedJson.tool_input && parsedJson.tool_input.command) {
        handleBashPostToolUse(parsedJson);
        return null;
    }

    // Default: Stop event with some JSON payload
    handleStop();
    return null;
}

// ---------------------------------------------------------------------------
// Exports — for testability
// ---------------------------------------------------------------------------

module.exports = {
    processEvent,
    handleStop,
    handleBashPostToolUse,
    isCommitCommand,
    shouldCapture,
};

// ---------------------------------------------------------------------------
// Main — determine event type and route
// ---------------------------------------------------------------------------

if (require.main === module) {
    // P1.7 — hook duration instrumentation (A4/Section-D blind-spot).
    // emitHookEvent appends one JSONL line to docs/.output/.state/telemetry/hook-events.jsonl
    // on every run. The try/catch around emit keeps the hook from ever failing
    // because of a telemetry write — telemetry is observability, not correctness.
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('memory-capture');
    let _hookOutcome = 'success';

    (async () => {
        try {
            // Preserve memory-capture's historical 500ms timeout.
            const raw = await readHookInput({ timeoutMs: 500 });

            let parsedJson = null;
            if (raw && raw.trim().length > 0) {
                try {
                    parsedJson = JSON.parse(raw);
                } catch {
                    // Unparseable — treat as Stop event (null parsedJson)
                }
            }

            processEvent(parsedJson);
        } catch {
            // Never block Claude Code — exit cleanly on any error
            _hookOutcome = 'failure';
        }

        try { emitHookEvent(_hookToken, _hookOutcome); } catch { /* never fail on telemetry */ }
        process.exit(0);
    })();
}
