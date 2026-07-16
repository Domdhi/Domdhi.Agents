#!/usr/bin/env node

/**
 * Post-Tool-Use Secret Scrubber + Redactor
 *
 * PostToolUse hook for `Read` AND `Bash`. Scans tool output for secrets and
 * REDACTS them from Claude's view via `hookSpecificOutput.updatedToolOutput`,
 * in addition to writing a stderr warning.
 *
 * Historical note: this file was originally `post-read-scrubber.cjs` covering
 * only `Read` and only warning (no redaction). Expanded 2026-05-10 (R7 from
 * `docs/.output/findings/research/2026-05-09-landscape-refresh.md`) to also cover Bash
 * tool output and to actually redact, not just warn. File name kept for
 * minimal blast radius (still referenced by SKIP_PATHS in secret-patterns.cjs
 * and by .claude/settings.json).
 *
 * Behavior:
 *   - Read event with secret in content → emit redaction JSON to stdout AND
 *     stderr warning. Original content is replaced in Claude's context with
 *     `<REDACTED:PatternName>` markers.
 *   - Bash event with secret in stdout → emit redaction JSON to stdout. No
 *     stderr warning for Bash because there's no useful filepath to cite.
 *   - Clean content → no output, no rewrite.
 *
 * Pattern library shared with secret-scanner.cjs via secret-patterns.cjs.
 *
 * Spec note: `hookSpecificOutput.updatedToolOutput` is documented in the
 * Claude Code 2.1.x changelog as "PostToolUse hooks can rewrite output for
 * any tool" (previously MCP-only). The exact wire format may vary by version;
 * if Claude Code ignores the JSON, the stderr warning is still emitted, so we
 * never lose the existing warn-only behavior — this is purely additive.
 *
 * Empirical verification (2026-05-10, Claude Code 2.x as of this commit):
 *   The hook IS invoked on Read events (proven by debug probe). The stderr
 *   warning IS shown to the user. However, the `updatedToolOutput` JSON is
 *   NOT honored — the rendered tool output that reaches the model still
 *   contains the original (unredacted) text. So today this hook works as a
 *   warn-only safety net, not as a true redactor. The redaction codepath is
 *   left in place for forward-compat: when Claude Code begins honoring the
 *   `updatedToolOutput` field for Read (or whatever the eventual wire format
 *   becomes), the hook will silently start redacting without code change.
 *   Test fixture used for verification: a file containing AKIAIOSFODNN7EXAMPLE
 *   (well-known fake AWS key); rendered output showed the literal string, not
 *   `<REDACTED:AWS Access Key>`.
 *
 * Exit codes:
 *   0 = always (post-tool-use hooks cannot block)
 */

const {
    shouldSkipPath,
    scanContent,
    redactSecretsInText,
    readStdin,
} = require('./secret-patterns.cjs');

/**
 * Extract textual output from a Claude Code PostToolUse payload.
 *
 * Tolerates payload-shape variation:
 *   - tool_response.stdout   (Bash, current format)
 *   - tool_response.stderr   (Bash, current format — F8: a command that prints
 *                             a secret to stderr, e.g. a failing `curl` echoing
 *                             a token, was never scanned/redacted)
 *   - tool_response.content  (Read, current format)
 *   - tool_response.text     (some MCP tools)
 *   - tool_response (string) (legacy)
 *   - tool_output            (legacy fallback)
 *
 * stdout and stderr are concatenated (newline-joined, empty pieces dropped) so
 * a secret split across both streams — or present in only one — is caught by
 * one scan pass; the caller applies the same capForScan treatment to the
 * combined text as it did to stdout alone.
 *
 * @param {object} parsedJson - Hook event payload
 * @returns {string} Extracted text, or '' if none found
 */
function extractOutput(parsedJson) {
    const resp = parsedJson && parsedJson.tool_response;
    const out = parsedJson && parsedJson.tool_output;

    if (typeof resp === 'string') return resp;
    if (resp && typeof resp === 'object') {
        if (resp.stdout || resp.stderr) {
            return [resp.stdout, resp.stderr].filter(Boolean).join('\n');
        }
        return resp.content || resp.text || '';
    }
    if (typeof out === 'string') return out;
    if (out && typeof out === 'object') {
        if (out.content || out.stdout || out.stderr) {
            return out.content || [out.stdout, out.stderr].filter(Boolean).join('\n') || '';
        }
        return out.text || '';
    }
    return '';
}

/**
 * F70: cap how much Bash stdout gets the 55-regex sweep. This hook fires on
 * EVERY Bash call, and build/install/test logs are effectively unbounded —
 * measured ~6.1ms per 1000 lines, i.e. >1s of synchronous hook latency on a
 * 200k-line log. Secrets in command output cluster near config/echo/env lines
 * at the start or the error/summary lines at the end, not the noisy middle,
 * so scan the head + tail and skip the middle. Redaction (rare, only on a
 * finding) still runs over the FULL output, so a mid-log secret that also
 * appears in head/tail context is still fully redacted.
 *
 * Read output is deliberately NOT capped: the harness already bounds Read to
 * ~2000 lines, and Read warnings cite file:line so fidelity matters there.
 */
// (Sized in UTF-16 code units via String.length/slice, not true bytes — the
// cap is a latency heuristic, so ±multi-byte drift is deliberately fine.)
const BASH_SCAN_HEAD_BYTES = 64 * 1024;
const BASH_SCAN_TAIL_BYTES = 64 * 1024;

/**
 * Return the scan-eligible slice of a Bash output: whole string when small,
 * head + tail (joined with a newline so no synthetic cross-boundary line can
 * form) when it exceeds the cap.
 *
 * @param {string} text
 * @returns {string}
 */
function capForScan(text) {
    if (text.length <= BASH_SCAN_HEAD_BYTES + BASH_SCAN_TAIL_BYTES) return text;
    return text.slice(0, BASH_SCAN_HEAD_BYTES) + '\n' + text.slice(-BASH_SCAN_TAIL_BYTES);
}

/**
 * Determine the tool kind for a payload. Prefer explicit `tool_name`; fall
 * back to inferring from `tool_input` shape (file_path → Read, command → Bash).
 *
 * @param {object} parsedJson - Hook event payload
 * @returns {'Read'|'Bash'|'unknown'}
 */
function inferToolKind(parsedJson) {
    const explicit = parsedJson && parsedJson.tool_name;
    if (explicit === 'Read' || explicit === 'Bash') return explicit;

    const input = (parsedJson && parsedJson.tool_input) || {};
    if (input.file_path) return 'Read';
    if (input.command) return 'Bash';
    return 'unknown';
}

/**
 * Process a PostToolUse hook event.
 *
 * Always returns null — non-blocking semantics. The redaction-side-effect
 * happens via process.stdout.write (consumed by Claude Code) and the
 * warning-side-effect via process.stderr.write (visible to user).
 *
 * @param {object} parsedJson - Hook event payload
 * @returns {null}
 */
function processEvent(parsedJson) {
    if (!parsedJson) return null;

    const toolKind = inferToolKind(parsedJson);
    if (toolKind === 'unknown') return null;

    const toolInput = parsedJson.tool_input || {};

    // Determine file context for findings + skip-path check
    let fileContext;
    if (toolKind === 'Read') {
        fileContext = toolInput.file_path || '';
        if (!fileContext) return null;
        if (shouldSkipPath(fileContext)) return null;
    } else {
        // Bash — no file_path; use a synthetic context for findings labels.
        // shouldSkipPath is bypassed because there's nothing to skip on.
        fileContext = '<bash output>';
    }

    const toolOutput = extractOutput(parsedJson);
    if (!toolOutput) return null;

    // F70: Bash stdout is scanned head+tail only past the cap (see capForScan).
    const scanTarget = toolKind === 'Bash' ? capForScan(toolOutput) : toolOutput;
    const findings = scanContent(scanTarget, fileContext);
    if (findings.length === 0) return null;

    // Build the redacted version. This may be byte-identical to the original
    // if all findings are HIGH_RISK_FILE meta-flags (no in-content match);
    // when that happens we fall through to warning-only without emitting JSON.
    const redactedOutput = redactSecretsInText(toolOutput);
    const didRedact = redactedOutput !== toolOutput;

    // Stderr warning — Read only (Bash has no meaningful file path to cite,
    // and the redaction itself is the user-visible signal).
    if (toolKind === 'Read') {
        process.stderr.write('\n');
        process.stderr.write('  ⚠ SECRET SCRUBBER — secrets detected in read file\n');
        process.stderr.write(`  File: ${fileContext}\n`);
        process.stderr.write(`  Found: ${findings.length} potential secret(s)\n`);
        for (const f of findings) {
            const loc = f.line > 0 ? `:${f.line}` : '';
            process.stderr.write(`    - ${f.name} at ${f.file}${loc} (${f.match})\n`);
        }
        if (didRedact) {
            process.stderr.write('  Output redacted before reaching the model.\n');
        } else {
            process.stderr.write('  These secrets are now in the conversation context.\n');
            process.stderr.write('  Consider removing them from the source file.\n');
        }
        process.stderr.write('\n');
    }

    // Emit hookSpecificOutput.updatedToolOutput so Claude Code replaces the
    // tool output Claude sees. Only emit when actually rewriting — empty/no-op
    // emissions would be noise and risk confusing future-version Claude Code.
    if (didRedact) {
        const payload = {
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                updatedToolOutput: redactedOutput,
            },
        };
        process.stdout.write(JSON.stringify(payload) + '\n');
    }

    return null;
}

async function main() {
    const input = await readStdin();
    if (!input) process.exit(0);

    let data;
    try {
        data = JSON.parse(input);
    } catch {
        process.exit(0);
    }

    processEvent(data);

    // Always exit 0 — post-tool-use cannot block
    process.exit(0);
}

if (require.main === module) {
    // P1.7 — hook duration instrumentation (F71), same pattern as siblings.
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('post-read-scrubber');
    process.on('exit', () => {
        try { emitHookEvent(_hookToken, 'success'); } catch { /* never fail on telemetry */ }
    });
    main();
}

module.exports = { processEvent, extractOutput, inferToolKind, capForScan, BASH_SCAN_HEAD_BYTES, BASH_SCAN_TAIL_BYTES };
