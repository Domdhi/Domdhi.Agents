/**
 * Model Runner — shared `claude -p` invocation + envelope parsing for the
 * memory LLM utilities (curator, extractor, benchmark).
 *
 * Replaces three near-verbatim implementations:
 *   - memory-curator.js   (checkClaudeCli, invokeModel, parseModelResult, tryParseInnerJson, extractTokenCounts)
 *   - memory-benchmark.js (identical shape, pipeline-specific payload fallback was dropped)
 *   - memory-extractor.js (inline, raw-payload parsing — uses tryParseInnerJson primitive)
 *
 * Consumers differ on two axes:
 *   - Timeout: curator/benchmark use 90s; extractor uses 30s → configurable via opts.timeout.
 *   - Envelope: curator/benchmark expect `{result, usage}` envelope → parseModelResult.
 *                extractor expects raw JSON payload (no envelope)   → tryParseInnerJson.
 *
 * MODEL SELECTION (defaults to Sonnet — Haiku is not trusted for memory work: the
 * recorded evidence, 2026-06-02 on Haiku 4.5, is that it fabricated dedup/extraction
 * results, and the rule stays in force until the bounded `fast`-tier eval passes).
 * To run a different model, either:
 *   - set the CLAUDE_MEMORY_MODEL env var (applies to every memory LLM call), or
 *   - pass opts.model to a single invokeModel() call (highest priority).
 */

// NOTE: intentionally `require('child_process')`, not `'node:child_process'` — the
// consumer test suites (memory-curator/-benchmark/-extractor) mock this module via
// require.cache injection keyed on the bare specifier 'child_process'; the 'node:'
// prefix resolves to a DIFFERENT cache key and would silently bypass those mocks.
const { execSync, execFileSync } = require('child_process');

const DEFAULT_MODEL = process.env.CLAUDE_MEMORY_MODEL || 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// invokeModel delivers argv to execFileSync — no shell, so the prompt and model
// can never be interpreted as shell metacharacters (was the win32 RCE: cmd.exe
// ignores single quotes, so bash-only escaping left `&|^%<>"'` live). The model
// flag is still constrained to the characters real model IDs use (e.g.
// claude-sonnet-4-6, claude-opus-4-8) as defense-in-depth / input validation —
// a bad value is a config error surfaced as an invocation failure (null), not a
// thrown exception.
const SAFE_MODEL_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Build the argv for a `claude -p` invocation.
 *
 * TOOL GRANT (sec-hardening, Wave 3 Story 3A): the memory LLM utilities
 * (curator/extractor/benchmark) are pure text→text — none need filesystem tools,
 * yet they embed UNTRUSTED sub-agent memory/daily-log text in the prompt. A
 * prompt-injection payload in that text must not be able to make the model `Read`
 * `settings.local.json`/`.env` and echo it into a tracked memory file. So by
 * default we grant NO tools at all.
 *
 * VERIFIED against `claude --help` (CLI 2.1.211): the `--tools <tools...>` flag
 * documents `Use "" to disable all tools`. Passing `--tools ''` therefore removes
 * every built-in tool from availability (strictly stronger than merely omitting
 * an `--allowedTools` allowlist, which only governs auto-approval and could still
 * expose tools under a permissive permission mode). An empty-string argv element
 * is consumed as the single variadic value and is immediately followed by a
 * `--`-prefixed flag, so commander cannot greedily absorb later args.
 *
 * OPT-IN: a caller that genuinely needs tools passes a non-empty `allowedTools`
 * array; those names are made available (`--tools`) AND pre-approved
 * (`--allowedTools`) — nothing beyond them.
 *
 * @param {string} prompt
 * @param {string} model
 * @param {string[]} allowedTools  Tool names to grant (default: none → text-only)
 * @returns {string[]}
 */
function buildInvokeArgs(prompt, model, allowedTools = []) {
    const toolArgs = (Array.isArray(allowedTools) && allowedTools.length > 0)
        ? ['--tools', allowedTools.join(','), '--allowedTools', allowedTools.join(',')]
        : ['--tools', '']; // disable ALL built-in tools — provable zero filesystem access
    return ['-p', String(prompt), '--model', model, ...toolArgs, '--output-format', 'json', '--bare'];
}

/**
 * Probe whether the `claude` CLI is on PATH.
 * @returns {boolean}
 */
function checkClaudeCli() {
    try {
        execSync('claude --version', { stdio: 'ignore', timeout: 5000, windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

/**
 * Invoke `claude -p <prompt>` with the given prompt. Returns the raw stdout
 * string, or null on failure. Errors are logged via the optional `logTag`
 * prefix — consumers that want silence can omit the logger.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.cwd]         Working directory for the subprocess (required for CWD-anchored projects)
 * @param {number} [opts.timeout]     Subprocess timeout in ms (default: 90000)
 * @param {string} [opts.model]       Model flag (default: claude-sonnet-4-6)
 * @param {string} [opts.logTag]      Prefix for stderr warnings on failure; pass null for silent
 * @param {string[]} [opts.allowedTools]  Tool names to grant (default: [] → NO tools; text-only)
 * @returns {string|null}
 */
function invokeModel(prompt, { cwd, timeout = DEFAULT_TIMEOUT_MS, model = DEFAULT_MODEL, logTag = 'model-runner', allowedTools = [] } = {}) {
    // Reject a model that isn't a plain model ID before spawning — argv delivery
    // already prevents injection, but this catches a malformed/garbage config
    // value early with a clear failure instead of an opaque CLI error.
    if (!SAFE_MODEL_RE.test(String(model))) {
        if (logTag) process.stderr.write(`[${logTag}] refusing unsafe model id: ${JSON.stringify(model)}\n`);
        return null;
    }
    try {
        return execFileSync(
            'claude',
            buildInvokeArgs(prompt, model, allowedTools),
            {
                cwd,
                encoding: 'utf8',
                timeout,
                stdio: ['pipe', 'pipe', 'pipe'],
                maxBuffer: MAX_BUFFER_BYTES,
                windowsHide: true,
            }
        );
    } catch (e) {
        if (logTag) {
            const errMsg = e.stderr ? String(e.stderr).trim() : e.message;
            process.stderr.write(`[${logTag}] model invocation failed: ${errMsg}\n`);
        }
        return null;
    }
}

/**
 * Parse a Claude `--output-format json` envelope and return the inner JSON payload.
 * Handles these envelope shapes:
 *   - { result: "<json-string>", usage: {...} }   — primary shape
 *   - { text: "<json-string>" }                    — alternate
 *   - { output: "<json-string>" }                  — alternate
 *   - { content: [{text: "..."}, ...] }            — alternate (concatenated)
 *
 * Returns null when the envelope is unrecognized or the inner JSON is malformed.
 * For consumers that expect the raw payload directly (no envelope), use
 * `tryParseInnerJson` instead.
 *
 * @param {string|null} raw
 * @returns {object|Array|null}
 */
const { tryParseInnerJson, parseModelResult, extractTokenCounts } = require('../../../../core/_lib/model-policy');

module.exports = {
    checkClaudeCli,
    invokeModel,
    buildInvokeArgs,
    parseModelResult,
    tryParseInnerJson,
    extractTokenCounts,
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MS,
};
