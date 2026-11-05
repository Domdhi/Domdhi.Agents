#!/usr/bin/env node

/**
 * Secret Scanner
 *
 * Detects secrets, credentials, and sensitive data in file content.
 * Used by both Claude Code hooks (PreToolUse:Write/Edit) and git pre-commit.
 *
 * Pattern library and scanning logic live in secret-patterns.cjs (shared module).
 *
 * Usage:
 *   Claude hook:  Reads tool input from stdin (JSON with file_path + content/new_string)
 *   Git hook:     node secret-scanner.cjs --git-precommit
 *   Manual:       node secret-scanner.cjs --file <path>
 *
 * Exit codes:
 *   Claude hook mode:  0 = clean/allow, 2 = secrets found (BLOCKS the tool call —
 *                      Claude Code only blocks a PreToolUse call on exit 2; any
 *                      other non-zero is a non-blocking error and the write
 *                      would proceed. Do NOT "normalize" this back to 1.)
 *   CLI modes (--git-precommit, --file):  0 = clean, 1 = secrets found
 *                      (conventional CLI failure; commit.js treats non-zero as
 *                      a failed pre-commit gate)
 *
 * Known limitations:
 *   - Base64 or hex-encoded secrets are not detected
 *   - Secrets split across multiple lines or concatenated strings are not detected
 *   - Unicode homoglyph substitutions can bypass detection
 */

const fs = require('fs');
const path = require('path');
const {
    isHardSkipPath,
    isTestFilePath,
    scanContent,
    formatFindings,
    readStdin,
} = require('./secret-patterns.cjs');

// Anchor git subprocess invocations to the repo root — not the caller's CWD.
// Without this, a prior `cd src && ...` in the same shell session leaves the
// scanner's CWD at `src/`, and `git diff --cached`/`git show :<file>` either
// fail or return results scoped to a nested repo. Match the convention used by
// gate.js, command-usage-logger.cjs, memory-benchmark.js, and the other core
// scripts: CLAUDE_PROJECT_DIR env var first, else resolve from __dirname (hook
// lives at .claude/hooks/, so ../../ is repo root).
//
// Resolved lazily (not at module load) so in-process tests can set
// CLAUDE_PROJECT_DIR per test case via beforeEach/afterEach without having to
// reload the module. The real hook/CLI invocation path is unaffected — the env
// var is either set by Claude Code or the __dirname fallback kicks in.
function getProjectRoot() {
    return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
}

/**
 * Record a secret-scanner BLOCK as a source-tagged guardrail event so it shows
 * up in the /review:feedback digest (feedback-digest.js readScannerBlocks counts
 * guardrail-events.jsonl entries where source==='secret-scanner'). Without this,
 * the scanner blocks silently via exit-code and the digest reads 0 (S-PI.5 gap).
 *
 * Best-effort + lazily required: telemetry must NEVER break the scanner's
 * load-bearing exit code, and a missing telemetry lib (older/partial install)
 * must not crash the block. One event per block action, not per finding.
 *
 * @returns {object|null} The event written, or null on any failure.
 */
function recordScannerBlock() {
    try {
        const { emitGuardrailHit } = require('../core/_lib/hook-telemetry');
        return emitGuardrailHit({
            decision: 'block',
            rule: 'secret-scanner',
            source: 'secret-scanner',
        });
    } catch {
        return null;
    }
}

// ============================================
// Testable core functions
// ============================================

/**
 * Process a single parsed Claude tool event.
 * Returns null (allow) or { block: true, feedback: string, exitCode: 2 } (block).
 * exitCode MUST be 2 — Claude Code only blocks a PreToolUse call on exit 2;
 * any other non-zero is a non-blocking error and the write proceeds.
 *
 * @param {{ tool_name: string, tool_input: { file_path?: string, notebook_path?: string, content?: string, new_string?: string, new_source?: string, edits?: Array<{ new_string?: string }> } }} parsedJson
 * @returns {{ block: true, feedback: string, exitCode: 2 } | null}
 */
function processEvent(parsedJson) {
    const toolName = parsedJson.tool_name || '';

    // Scan every write-capable tool this hook is wired on in settings.json
    const SCANNED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
    if (!SCANNED_TOOLS.includes(toolName)) return null;

    const toolInput = parsedJson.tool_input || {};
    const filePath = toolInput.file_path || toolInput.notebook_path || '';

    // Hard-skip (scanner internals, VCS/package-manager plumbing) is a full
    // pass. A test/spec file is NOT hard-skipped — a real provider secret
    // pasted there is still a leak — it's scanned below in namedProvidersOnly
    // mode instead (only the generic Password/Secret Assignment patterns,
    // which false-positive on fixture noise, are suppressed).
    if (isHardSkipPath(filePath)) return null;
    const namedProvidersOnly = isTestFilePath(filePath);

    // Scan each content piece separately so a finding's line number refers to
    // the piece it was found in (a concatenated pseudo-document would report
    // line numbers that don't exist in the file). Empty pieces are dropped —
    // matching the long-standing "no content, nothing to scan" behavior —
    // while whitespace-only content IS scanned so the high-risk-filename
    // check (which fires from the path alone) still runs.
    const pieces = [];
    const direct = toolInput.content || toolInput.new_string || toolInput.new_source || '';
    if (direct) pieces.push({ label: '', text: direct });
    if (Array.isArray(toolInput.edits)) {
        toolInput.edits.forEach((e, i) => {
            if (e && e.new_string) pieces.push({ label: `edit #${i + 1}`, text: e.new_string });
        });
    }
    if (pieces.length === 0) return null;

    const findings = [];
    let sawHighRiskFile = false;
    for (const piece of pieces) {
        for (const f of scanContent(piece.text, filePath, { namedProvidersOnly })) {
            if (f.type === 'HIGH_RISK_FILE') {
                // Path-derived, identical for every piece — report once.
                if (sawHighRiskFile) continue;
                sawHighRiskFile = true;
            } else if (piece.label) {
                f.file = `${filePath} (${piece.label})`;
            }
            findings.push(f);
        }
    }
    if (findings.length > 0) {
        return {
            block: true,
            feedback: formatFindings(findings),
            exitCode: 2,
        };
    }

    return null;
}

/**
 * Scan a single file by path.
 * Unlike runFileScan, does NOT call process.exit — returns data instead.
 *
 * @param {string} filePath  Absolute path to file
 * @returns {{ error: string, findings: null, skipped: false }
 *          | { findings: null, skipped: true }
 *          | { findings: Array, skipped: false }}
 */
function scanFile(filePath) {
    const resolved = path.resolve(filePath);

    // Hard-skip check comes first — cheaper than fs.existsSync and means
    // skipped paths don't need to exist on disk. A test/spec file is NOT
    // hard-skipped — see processEvent's comment — it's scanned below in
    // namedProvidersOnly mode.
    if (isHardSkipPath(resolved)) {
        return { findings: null, skipped: true };
    }

    if (!fs.existsSync(resolved)) {
        return { error: 'File not found', findings: null, skipped: false };
    }

    const content = fs.readFileSync(resolved, 'utf8');
    const findings = scanContent(content, filePath, { namedProvidersOnly: isTestFilePath(resolved) });
    return { findings, skipped: false };
}

/**
 * Determine whether a staged file is binary, via `git diff --cached --numstat`
 * scoped to that single file (numstat reports "-\t-\t<path>" for a binary
 * diff, and "<added>\t<deleted>\t<path>" for a text diff). Only called on the
 * (rare) path where `git show :<file>` itself failed, so the extra subprocess
 * cost is paid only for files that need the classification.
 *
 * @param {string} file - staged file path, as reported by `git diff --name-only`
 * @param {string} root - project root (cwd for the git subprocess)
 * @returns {boolean}
 */
function isBinaryStagedFile(file, root) {
    try {
        const { execFileSync } = require('child_process');
        // `-z` for the same reason the enumeration below uses it: without it git
        // C-quotes non-ASCII paths under the default `core.quotepath`, and the
        // `-- <pathspec>` we pass would then not match the real path.
        const output = execFileSync(
            'git', ['diff', '--cached', '--numstat', '-z', '--', file],
            { cwd: root, encoding: 'utf8', windowsHide: true }
        ).trim();
        return /^-\t-\t/.test(output);
    } catch {
        // Can't even determine binary-ness — treat as NOT binary so the caller
        // fails closed rather than silently skipping.
        return false;
    }
}

/**
 * Decide how to handle a staged file whose content `git show` failed to read.
 * A detectably binary file is skipped — there's no secret text to leak in
 * binary content, matching the long-standing behavior. Any OTHER failure
 * (maxBuffer exceeded, a transient git error, etc.) on a non-binary file now
 * FAILS the commit closed — warn-and-continue previously let a staged secret
 * sail through silently whenever `git show` happened to error on it, which is
 * exactly the failure mode a large generated report (the likeliest place to
 * carry a leaked key) would trigger.
 *
 * @param {string} file
 * @param {Error} err - the error `git show` threw
 * @param {string} root - project root (cwd for the git subprocess)
 * @returns {{ action: 'skip' | 'fail', message: string }}
 */
function classifyUnreadableStagedFile(file, err, root) {
    if (isBinaryStagedFile(file, root)) {
        return { action: 'skip', message: `[secret-scanner] "${file}" is binary — skipping.` };
    }
    return {
        action: 'fail',
        message:
            `[secret-scanner] FAIL-CLOSED: could not read staged content for "${file}" ` +
            `(${(err && err.message) || 'unknown error'}) and it is not detectably binary. ` +
            `Blocking the commit — verify the file manually and retry.`,
    };
}

// ============================================
// Modes
// ============================================

/**
 * Claude Code hook mode — reads tool input from stdin
 */
async function runClaudeHook() {
    let input;
    try {
        // failClosedOnTimeout: a wedged pipe or a truncated read must BLOCK, not
        // silently pass through as "nothing to scan" — see the readStdin doc
        // comment in secret-patterns.cjs for why this differs from every other
        // blocking hook's bounded-and-fail-open stdin timeout.
        input = await readStdin({ failClosedOnTimeout: true });
    } catch (err) {
        recordScannerBlock();
        process.stderr.write(
            '[secret-scanner] FAIL-CLOSED: stdin read did not complete — blocking the write to be safe.\n' +
            '  ' + (err && err.message ? err.message : String(err)) + '\n'
        );
        process.exit(2);
    }
    if (!input) process.exit(0);

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        // FAIL CLOSED. Malformed JSON on this channel is not expected in
        // ordinary operation (Claude Code's own harness writes it) — the
        // realistic cause is a truncated/garbled stdin read, which could well
        // contain a real secret in the part that didn't parse. Blindly
        // treating unparseable input as "nothing to scan" would silently let
        // that content through unscanned. Block instead.
        recordScannerBlock();
        process.stderr.write(
            '[secret-scanner] FAIL-CLOSED: could not parse stdin payload as JSON — blocking the write to be safe.\n'
        );
        process.exit(2);
    }

    let result;
    try {
        result = processEvent(data);
    } catch (err) {
        // FAIL CLOSED. An unexpected error while scanning (non-string content, a
        // regex/runtime fault, an unforeseen payload shape) must NEVER let the
        // write proceed unscanned. Claude Code blocks a PreToolUse call ONLY on
        // exit 2 — exiting 1 here would be a NON-blocking error and the write
        // would go through unscanned (the fail-open class fixed in 10325a7,
        // re-entering via an uncaught exception). So block on any error.
        recordScannerBlock();
        process.stderr.write(
            '[secret-scanner] FAIL-CLOSED: unexpected error during scan — blocking the write to be safe.\n' +
            '  ' + (err && err.message ? err.message : String(err)) + '\n'
        );
        process.exit(2);
    }

    if (result) {
        recordScannerBlock(); // source-tagged guardrail event for the feedback digest
        // Output to stderr so Claude sees the warning
        process.stderr.write(result.feedback + '\n');
        process.exit(result.exitCode);
    }

    process.exit(0);
}

/**
 * Git pre-commit mode — scans staged files
 */
async function runGitPrecommit() {
    const { execFileSync } = require('child_process');

    // --diff-filter=ACMRT: Added/Copied/Modified/Renamed/Type-changed. Renamed
    // (R) MUST be included — a rename ≥50% similar that ALSO modifies content
    // (e.g. `git mv old.js new.js` + appending a secret) reports status R, and
    // the old ACM-only filter silently excluded it: `--name-only` still prints
    // just the new path, so `git show :<newpath>` below reads the staged
    // (modified) content correctly once the file survives this filter.
    //
    // `-z` (NUL-separated, RAW paths) is load-bearing, not a tidy-up. Without it
    // git honours `core.quotepath` and prints a non-ASCII path C-QUOTED — a staged
    // `café.md` comes out as the literal 15-character string `"caf\303\251.md"`.
    // `git show :"caf\303\251.md"` then fails, `isBinaryStagedFile`'s numstat
    // pathspec matches nothing (→ "not binary"), and the fail-closed path blocked
    // EVERY commit staging a non-ASCII filename while blaming binary-ness. `-z`
    // also removes the (theoretical) newline-in-filename split hazard.
    let stagedFiles;
    try {
        stagedFiles = execFileSync(
            'git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT'],
            { cwd: getProjectRoot(), encoding: 'utf8', windowsHide: true }
        ).split('\0').filter(Boolean);
    } catch {
        console.error('Failed to get staged files');
        process.exit(1);
    }

    const allFindings = [];

    for (const file of stagedFiles) {
        // Hard-skip only — a test/spec file is still scanned below in
        // namedProvidersOnly mode, same as the Claude-hook path.
        if (isHardSkipPath(file)) continue;

        // Get the staged content (not the working copy)
        let content;
        try {
            content = execFileSync(
                'git', ['show', `:${file}`],
                // maxBuffer: the 1MB default ENOBUFS'd on a 2MB staged report and the
                // scan SKIPPED it (fail-open on exactly the large generated reviews
                // most likely to echo a secret — observed 2026-07-16).
                { cwd: getProjectRoot(), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
            );
        } catch (err) {
            const decision = classifyUnreadableStagedFile(file, err, getProjectRoot());
            if (decision.action === 'skip') {
                console.error(decision.message);
                continue;
            }
            console.error(decision.message);
            console.error('\nCommit blocked. Remove secrets and try again.');
            console.error('To bypass (NOT recommended): git commit --no-verify\n');
            process.exit(1);
        }

        const findings = scanContent(content, file, { namedProvidersOnly: isTestFilePath(file) });
        allFindings.push(...findings);
    }

    if (allFindings.length > 0) {
        recordScannerBlock(); // source-tagged guardrail event for the feedback digest
        const report = formatFindings(allFindings);
        console.error(report);
        console.error('\nCommit blocked. Remove secrets and try again.');
        console.error('To bypass (NOT recommended): git commit --no-verify\n');
        process.exit(1);
    }

    process.exit(0);
}

/**
 * Single file mode — scan a specific file (CLI wrapper around scanFile)
 */
function runFileScan(filePath) {
    const result = scanFile(filePath);

    if (result.error) {
        const resolved = path.resolve(filePath);
        console.error(`File not found: ${resolved}`);
        process.exit(1);
    }

    if (result.skipped) {
        console.log('File is in skip list, no scan performed.');
        process.exit(0);
    }

    if (result.findings.length > 0) {
        console.error(formatFindings(result.findings));
        process.exit(1);
    }

    console.log('No secrets detected.');
    process.exit(0);
}

// ============================================
// Exports (for tests and programmatic use)
// ============================================

module.exports = {
    processEvent,
    scanFile,
    recordScannerBlock,
    isBinaryStagedFile,
    classifyUnreadableStagedFile,
};

// ============================================
// Entry point
// ============================================

if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.includes('--git-precommit')) {
        runGitPrecommit();
    } else if (args.includes('--file')) {
        const fileIdx = args.indexOf('--file');
        const targetFile = args[fileIdx + 1];
        if (targetFile) {
            runFileScan(targetFile);
        } else {
            console.error('Usage: secret-scanner.cjs --file <path>');
            process.exit(1);
        }
    } else {
        // Default: Claude Code hook mode (reads stdin)
        runClaudeHook();
    }
}
