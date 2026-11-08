#!/usr/bin/env node

/**
 * Secret Scanner
 *
 * Detects secrets, credentials, and sensitive data in file content.
 * Used by both Claude Code hooks (PreToolUse:Write/Edit) and git pre-commit.
 *
 * Detection runs the pinned Betterleaks engine through secret-patterns.cjs / secret-engine.cjs.
 * FAIL CLOSED: if the engine is missing, fails or times out, the write (hook mode) or the commit
 * (--git-precommit) is blocked with an install hint; it is never read as "no secrets".
 * A reviewed false positive gets a betterleaks:allow comment on the same line, or an entry in
 * the engine's .betterleaksignore file. Never on a real key.
 *
 * Usage:
 *   Claude hook:  Reads tool input from stdin (JSON with file_path + content/new_string)
 *   Git hooks (the toolkit-managed shims written by core/git-hooks.js run these):
 *                 node secret-scanner.cjs --git-precommit             pre-commit, pre-merge-commit, pre-applypatch
 *                 node secret-scanner.cjs --commit-msg <file>         commit-msg
 *                 node secret-scanner.cjs --pre-push <remote> [url]   pre-push (stdin: git's ref lines)
 *                 node secret-scanner.cjs --hook-bypass <hook>        CLAUDE_COMMIT_NO_SCAN=1: record, skip
 *                 node secret-scanner.cjs --hook-protocol             print the protocol version the shims check
 *   Manual:       node secret-scanner.cjs --file <path>
 *
 * In every git mode the repository root is what git says it is for the working directory (git runs a hook
 * in the work tree it is committing in): no environment variable redirects a commit or push scan.
 * Every git mode honors CLAUDE_COMMIT_NO_SCAN=1 itself (the audited bypass: record the event, scan nothing),
 * so a hook written by an owner who calls these modes directly gets the same bypass as the managed shims.
 *
 * Exit codes:
 *   Claude hook mode:  0 = clean/allow, 2 = secrets found (BLOCKS the tool call —
 *                      Claude Code only blocks a PreToolUse call on exit 2; any
 *                      other non-zero is a non-blocking error and the write
 *                      would proceed. Do NOT "normalize" this back to 1.)
 *   CLI modes (git modes, --file):  0 = clean, 1 = secrets found or any fault (fail closed), 2 = usage
 *
 * Known limitations:
 *   - Secrets split across lines or concatenated strings are not detected
 *   - Unicode homoglyph substitutions can bypass detection
 *   - Encoded secrets are found only where the engine's own decoder reaches them
 */

const fs = require('fs');
const path = require('path');
const {
    isHardSkipPath,
    isTestFilePath,
    scanContent,
    formatFindings,
    readStdin,
    isEngineError,
    installHint,
    bypassAdvice,
} = require('./secret-patterns.cjs');
const { GIT_HOOK_PROTOCOL, PROTOCOL_LINE_PREFIX } = require('../core/_lib/git-hook-protocol');

/**
 * Record a secret-scanner BLOCK as a source-tagged guardrail event so it shows
 * up in the /review:feedback digest (feedback-digest.js readScannerBlocks counts
 * guardrail-events.jsonl entries where source==='secret-scanner'). Without this,
 * the scanner blocks silently via exit-code and the digest reads 0 (S-PI.5 gap).
 *
 * The event carries the rule NAMES that fired (`patterns`) and how many findings
 * there were (`count`), never a matched value, so the digest can show which rules
 * are noisy. One event per block action, not per finding.
 *
 * Best-effort + lazily required: telemetry must NEVER break the scanner's
 * load-bearing exit code, and a missing telemetry lib (older/partial install)
 * must not crash the block.
 *
 * @param {{ patterns?: string[], count?: number }} [details]
 * @returns {object|null} The event written, or null on any failure.
 */
function recordScannerBlock(details) {
    try {
        const { emitGuardrailHit } = require('../core/_lib/hook-telemetry');
        return emitGuardrailHit({
            decision: 'block',
            rule: 'secret-scanner',
            source: 'secret-scanner',
            patterns: details && details.patterns,
            count: details && details.count,
        });
    } catch {
        return null;
    }
}

/** Distinct finding names and the finding count, for recordScannerBlock. */
function summarizeFindings(findings) {
    return { patterns: [...new Set(findings.map(f => f.name))], count: findings.length };
}

/**
 * The ONE commit-message scan: commit.js (its own scan, when the managed hooks are not active) and the
 * `--commit-msg` mode of the managed commit-msg hook both go through here, so they cannot drift.
 * Same engine and the same fail-closed contract as the staged-file scan: an engine that is missing or
 * broken is reported as an engine error, never read as "no secrets".
 *
 * The WHOLE text is scanned. A `git commit -v` message file carries the staged diff below a scissors line;
 * that content was already scanned by pre-commit, so scanning it again is safe, and not special-casing the
 * scissors line leaves nobody a place to hide text in a forged one (git keeps text below a scissors line
 * under the default cleanup of `-F`). A non-engine error propagates to the caller.
 *
 * @param {string} text
 * @returns {{ status: 'clean' } | { status: 'findings', findings: Array } | { status: 'engine-error', error: Error }}
 */
function scanCommitMessage(text) {
    const body = String(text);
    if (!body.trim()) return { status: 'clean' };
    let findings;
    try {
        findings = scanContent(body, '<commit-message>');
    } catch (err) {
        if (!isEngineError(err)) throw err;
        return { status: 'engine-error', error: err };
    }
    return findings.length ? { status: 'findings', findings } : { status: 'clean' };
}

/**
 * The block message for an engine that is missing or broken. The write or commit is refused
 * (fail closed) and the message says how to fix it.
 */
function engineFailureMessage(err) {
    const hint = err && err.code === 'ENGINE_UNAVAILABLE' ? `\n  ${installHint()}` : '';
    return `[secret-scanner] FAIL-CLOSED: the secret engine could not scan this content.\n  ${err && err.message ? err.message : String(err)}${hint}\n`;
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
 * @returns {{ block: true, feedback: string, exitCode: 2, patterns: string[], count: number } | null}
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
    // Only a Write's `content` is a whole file, so only there do .betterleaksignore line numbers mean
    // anything. An Edit's new_string (and each MultiEdit fragment) restarts at line 1.
    const wholeFile = toolName === 'Write' && Boolean(toolInput.content);
    if (direct) pieces.push({ label: '', text: direct, wholeFile });
    if (Array.isArray(toolInput.edits)) {
        toolInput.edits.forEach((e, i) => {
            if (e && e.new_string) pieces.push({ label: `edit #${i + 1}`, text: e.new_string });
        });
    }
    if (pieces.length === 0) return null;

    const findings = [];
    let sawHighRiskFile = false;
    for (const piece of pieces) {
        for (const f of scanContent(piece.text, filePath, { namedProvidersOnly, wholeFile: Boolean(piece.wholeFile) })) {
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
            ...summarizeFindings(findings),
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
    const findings = scanContent(content, filePath, { namedProvidersOnly: isTestFilePath(resolved), wholeFile: true });
    return { findings, skipped: false };
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
        if (isEngineError(err)) {
            recordScannerBlock({ patterns: ['engine-' + (err.code === 'ENGINE_UNAVAILABLE' ? 'unavailable' : 'failed')], count: 0 });
            process.stderr.write(engineFailureMessage(err));
            process.exit(2);
        }
        recordScannerBlock();
        process.stderr.write(
            '[secret-scanner] FAIL-CLOSED: unexpected error during scan — blocking the write to be safe.\n' +
            '  ' + (err && err.message ? err.message : String(err)) + '\n'
        );
        process.exit(2);
    }

    if (result) {
        recordScannerBlock({ patterns: result.patterns, count: result.count }); // source-tagged guardrail event for the feedback digest
        // Output to stderr so Claude sees the warning
        process.stderr.write(result.feedback + '\n');
        process.exit(result.exitCode);
    }

    process.exit(0);
}

// ============================================
// Git hook modes
// ============================================

const BYPASS_ENV = 'CLAUDE_COMMIT_NO_SCAN';
const bypassRequested = () => process.env[BYPASS_ENV] === '1';

/** Load the git-scan library and the repository root git resolves for this process. Fail closed. */
function gitContext() {
    const gitScan = require('./secret-git-scan.cjs');
    try {
        return { gitScan, root: gitScan.toplevel(process.cwd()) };
    } catch (err) {
        console.error(`[secret-scanner] FAIL-CLOSED: ${err.message}, so there is nothing to scan. Blocking.`);
        process.exit(1);
    }
}

function engineBlock(err, what, content) {
    recordScannerBlock({ patterns: ['engine-' + (err.code === 'ENGINE_UNAVAILABLE' ? 'unavailable' : 'failed')], count: 0 });
    console.error(engineFailureMessage(err));
    console.error(`${what} blocked: ${content} were not scanned.\n`);
    process.exit(1);
}

/** The block report for findings, never printing a value. */
function reportFindings(findings, what) {
    recordScannerBlock(summarizeFindings(findings)); // source-tagged guardrail event for the feedback digest
    console.error(formatFindings(findings));
    console.error(`\n${what} blocked. Remove secrets and try again.`);
    console.error(bypassAdvice(findings));
    process.exit(1);
}

/**
 * Collect the findings of scan results in order; an unreadable or unscannable entry blocks (fail closed).
 * `label(rel)` names an entry in output.
 */
function collectFindings(order, results, label, what) {
    const all = [];
    for (const rel of order) {
        const result = results.get(rel);
        const shown = label(rel);
        if (!result || result.error) {
            console.error(result && result.unreadable
                ? `[secret-scanner] FAIL-CLOSED: could not read the content of "${shown}" (${result.error}). Blocking ${what} — verify the file manually and retry.`
                : `[secret-scanner] FAIL-CLOSED: could not scan "${shown}" (${result ? result.error : 'no result'}). Blocking ${what}.`);
            process.exit(1);
        }
        for (const f of result.findings) all.push(f.file === rel ? { ...f, file: shown } : f);
    }
    return all;
}

/**
 * Git pre-commit mode (also pre-merge-commit and pre-applypatch, where the index holds the result):
 * scans the staged blobs, addressed by id, in as few engine runs as the size allows.
 */
async function runGitPrecommit() {
    if (bypassRequested()) runHookBypass('pre-commit');
    const { gitScan, root } = gitContext();
    let scan;
    try {
        scan = gitScan.scanStaged(root);
    } catch (err) {
        if (isEngineError(err)) engineBlock(err, 'Commit', 'the staged files');
        console.error(`[secret-scanner] FAIL-CLOSED: the staged files could not be scanned (${err && err.message ? err.message : err}). Blocking the commit.`);
        process.exit(1);
    }
    await require('./secret-engine.cjs').settleSignals(); // a signal that arrived during the scan ends the process here, not after the verdict
    for (const sub of scan.gitlinks) {
        console.error(`[secret-scanner] "${sub}" is a submodule pointer (a commit id, no content) — not scanned here; the submodule's own repository scans its content.`);
    }
    const findings = collectFindings(scan.order, scan.results, rel => rel, 'the commit');
    if (findings.length > 0) {
        console.error('');
        reportFindings(findings, 'Commit');
    }
    process.exit(0);
}

/**
 * Git commit-msg mode — scans the whole message file git hands the hook. Fail closed on every fault:
 * an unreadable file, an engine that cannot scan, an unexpected error all exit 1.
 */
function runCommitMsg(file) {
    if (bypassRequested()) runHookBypass('commit-msg');
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        console.error(`[secret-scanner] FAIL-CLOSED: could not read the commit message file "${file}" (${err.message}). Blocking the commit.`);
        process.exit(1);
    }
    let result;
    try {
        result = scanCommitMessage(text);
    } catch (err) {
        console.error('[secret-scanner] FAIL-CLOSED: unexpected error while scanning the commit message — blocking the commit.\n  ' + (err && err.message ? err.message : String(err)));
        process.exit(1);
    }
    if (result.status === 'engine-error') {
        engineBlock(result.error, 'Commit', 'the commit message');
    }
    if (result.status === 'findings') {
        recordScannerBlock(summarizeFindings(result.findings));
        console.error(formatFindings(result.findings));
        console.error('\nCommit blocked: the commit message contains what looks like a secret. Remove it and commit again.');
        process.exit(1);
    }
    process.exit(0);
}

/**
 * Git pre-push mode — scans every object the push would publish that the remote does not vouch for: the blobs,
 * every commit message and every tag message. The backstop for commit paths that ran no commit hook.
 */
async function runPrePush(remote, url) {
    if (bypassRequested()) runHookBypass('pre-push');
    const { gitScan, root } = gitContext();
    let updates;
    try {
        updates = gitScan.parsePushLines(fs.readFileSync(0, 'utf8'));
    } catch (err) {
        console.error(`[secret-scanner] FAIL-CLOSED: could not read git's list of refs to push (${err.message}). Blocking the push.`);
        process.exit(1);
    }
    let scan;
    try {
        scan = gitScan.scanPush(root, remote, url, updates);
    } catch (err) {
        if (isEngineError(err)) engineBlock(err, 'Push', 'the commits to push');
        console.error(`[secret-scanner] FAIL-CLOSED: the commits to push could not be scanned (${err && err.message ? err.message : err}). Blocking the push.`);
        process.exit(1);
    }
    await require('./secret-engine.cjs').settleSignals();
    const findings = collectFindings(scan.order, scan.results, scan.label, 'the push');
    if (findings.length > 0) {
        console.error(`\n[secret-scanner] ${scan.commits.length} commit(s) and ${scan.tags.length} tag(s) would be published; some of that content holds what looks like a secret:`);
        reportFindings(findings, 'Push');
    }
    process.exit(0);
}

/** Print the hook protocol the shims check before trusting this scanner. */
function runHookProtocol() {
    process.stdout.write(`${PROTOCOL_LINE_PREFIX}${GIT_HOOK_PROTOCOL}\n`);
    process.exit(0);
}

// The marker that lets commit-msg tell a commit whose pre-commit already recorded the bypass from one that ran
// commit-msg alone (a reword). A file in the git dir, not an environment flag: nothing a caller can set in the
// environment suppresses the audit record.
const MARKER_FILE = 'domdhi-bypass-marker.json';
const MARKER_TTL_MS = 2 * 60 * 1000;

function bypassMarkerContext() {
    const { spawnSync } = require('child_process');
    const run = args => { const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.trim() : null; };
    const gitDir = run(['rev-parse', '--absolute-git-dir']);
    if (!gitDir) return null;
    return { file: path.join(gitDir, MARKER_FILE), key: `${run(['write-tree']) || 'no-tree'}:${run(['rev-parse', '--verify', '-q', 'HEAD']) || 'unborn'}` };
}

/**
 * The audited bypass for the git hooks: CLAUDE_COMMIT_NO_SCAN=1. Records ONE 'bypass' guardrail event per
 * bypassed commit, from whichever hook sees it first: pre-commit / pre-merge-commit / pre-applypatch write
 * the marker, commit-msg records only when no fresh marker for the same tree and HEAD exists (a commit that
 * ran commit-msg alone: a reword). pre-push always records. The message says "recorded" only when the
 * event was written.
 */
function runHookBypass(hook) {
    const { emitGuardrailHit } = (() => { try { return require('../core/_lib/hook-telemetry'); } catch { return {}; } })();
    let record = true;
    let marker = null;
    if (hook !== 'pre-push') {
        marker = bypassMarkerContext();
        if (marker && hook === 'commit-msg') {
            try {
                const seen = JSON.parse(fs.readFileSync(marker.file, 'utf8'));
                if (seen && seen.key === marker.key && Date.now() - seen.at < MARKER_TTL_MS) record = false;
                fs.rmSync(marker.file, { force: true });
            } catch { /* no marker: this hook records */ }
        }
    }
    let recorded = false;
    if (record) {
        try { recorded = Boolean(emitGuardrailHit && emitGuardrailHit({ decision: 'bypass', rule: 'git-hook-no-scan', source: 'secret-scanner', patterns: [hook] })); } catch { recorded = false; }
        // The marker says "the first hook recorded this commit": write it only when that is true, so commit-msg never
        // claims a record that pre-commit reported it could not make.
        if (marker && hook !== 'commit-msg' && recorded) {
            try { fs.writeFileSync(marker.file, JSON.stringify({ key: marker.key, at: Date.now(), hook }), { mode: 0o600 }); } catch { /* the next hook may record a second event: honest, not silent */ }
        }
    }
    const tail = !record ? 'already recorded by the first hook of this commit'
        : recorded ? 'recorded in guardrail-events.jsonl'
            : 'NOT recorded: guardrail-events.jsonl could not be written';
    process.stderr.write(`[secret-scanner] WARNING: secret scan bypassed (${BYPASS_ENV}=1, ${hook} hook); ${tail}.\n`);
    process.exit(0);
}

/**
 * Single file mode — scan a specific file (CLI wrapper around scanFile)
 */
function runFileScan(filePath) {
    let result;
    try {
        result = scanFile(filePath);
    } catch (err) {
        if (!isEngineError(err)) throw err;
        console.error(engineFailureMessage(err));
        process.exit(1);
    }

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
    engineFailureMessage,
    scanCommitMessage,
    GIT_HOOK_PROTOCOL,
};

// ============================================
// Entry point
// ============================================

/** An unexpected fault in an async git mode must block, never fall out as an unhandled rejection that a caller could read as success. */
function failClosed(err) {
    console.error(`[secret-scanner] FAIL-CLOSED: unexpected error (${err && err.message ? err.message : err}). Blocking.`);
    process.exit(1);
}

const GIT_FLAGS = ['--git-precommit', '--commit-msg', '--pre-push', '--hook-bypass', '--hook-protocol'];

if (require.main === module) {
    const args = process.argv.slice(2);
    const flagArgs = args.filter(a => a.startsWith('--'));
    const known = [...GIT_FLAGS, '--file'];
    const unknown = flagArgs.find(a => !known.includes(a));

    if (unknown) {
        // An unknown flag must never fall through to the Claude-hook mode (which reads stdin and exits 0 on
        // empty input): a shim written for a newer scanner would scan nothing.
        console.error(`[secret-scanner] unknown option ${unknown}`);
        process.exit(2);
    } else if (args.includes('--hook-protocol')) {
        runHookProtocol();
    } else if (args.includes('--git-precommit')) {
        runGitPrecommit().catch(failClosed);
    } else if (args.includes('--commit-msg')) {
        const msgFile = args[args.indexOf('--commit-msg') + 1];
        if (msgFile && !msgFile.startsWith('--')) {
            runCommitMsg(msgFile);
        } else {
            console.error('Usage: secret-scanner.cjs --commit-msg <file>');
            process.exit(1);
        }
    } else if (args.includes('--pre-push')) {
        const remote = args[args.indexOf('--pre-push') + 1];
        const url = args[args.indexOf('--pre-push') + 2];
        runPrePush(remote && !remote.startsWith('--') ? remote : '', url && !url.startsWith('--') ? url : '').catch(failClosed);
    } else if (args.includes('--hook-bypass')) {
        runHookBypass(args[args.indexOf('--hook-bypass') + 1] || 'unknown');
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
