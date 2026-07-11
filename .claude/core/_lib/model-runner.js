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
 * MODEL SELECTION (defaults to Sonnet — Haiku is not trusted for memory work; it
 * fabricates dedup/extraction results). To run a different model, either:
 *   - set the CLAUDE_MEMORY_MODEL env var (applies to every memory LLM call), or
 *   - pass opts.model to a single invokeModel() call (highest priority).
 */

const { execSync } = require('child_process');

const DEFAULT_MODEL = process.env.CLAUDE_MEMORY_MODEL || 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// A model flag is interpolated unquoted into the shelled `claude -p …` command
// (the prompt is single-quote-escaped; the model must be too). Rather than quote
// it, constrain it to the characters real model IDs use (e.g. claude-sonnet-4-6,
// claude-opus-4-8) — anything with shell metacharacters is rejected, so the model
// can never break out of the command. Config/env-sourced, so a bad value is a
// config error surfaced as an invocation failure (null), not a thrown exception.
const SAFE_MODEL_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Probe whether the `claude` CLI is on PATH.
 * @returns {boolean}
 */
function checkClaudeCli() {
    try {
        execSync('claude --version', { stdio: 'ignore', timeout: 5000 });
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
 * @returns {string|null}
 */
function invokeModel(prompt, { cwd, timeout = DEFAULT_TIMEOUT_MS, model = DEFAULT_MODEL, logTag = 'model-runner' } = {}) {
    // Reject a model that isn't a plain model ID before it reaches the shell — this
    // closes the `--model ${model}` injection (the model was the one unescaped
    // interpolation; the prompt is escaped below).
    if (!SAFE_MODEL_RE.test(String(model))) {
        if (logTag) process.stderr.write(`[${logTag}] refusing unsafe model id: ${JSON.stringify(model)}\n`);
        return null;
    }
    const escapedPrompt = String(prompt).replace(/'/g, "'\\''");
    try {
        return execSync(
            `claude -p '${escapedPrompt}' --model ${model} --allowedTools Read --output-format json --bare`,
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
function parseModelResult(raw) {
    if (!raw) return null;
    let envelope;
    try {
        envelope = JSON.parse(raw);
    } catch {
        // Not JSON at the envelope level — try parsing raw as the payload directly
        return tryParseInnerJson(raw);
    }

    let text = null;
    if (typeof envelope === 'string') text = envelope;
    else if (envelope && typeof envelope === 'object') {
        text = envelope.result || envelope.text || envelope.output || null;
        if (!text && Array.isArray(envelope.content)) {
            text = envelope.content.map(c => c.text || '').join('');
        }
    }

    if (text) return tryParseInnerJson(text);
    return null;
}

/**
 * Strip leading/trailing ```json fences, then JSON.parse.
 * The `--bare` flag should suppress fences but models occasionally emit them anyway —
 * this is a defensive tolerance. Returns null on any parse failure.
 *
 * @param {string} text
 * @returns {object|Array|null}
 */
function tryParseInnerJson(text) {
    if (typeof text !== 'string') return null;
    const stripped = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
    try {
        return JSON.parse(stripped);
    } catch {
        return null;
    }
}

/**
 * Pull input/output token counts from the `{usage: {input_tokens, output_tokens}}`
 * field of a Claude envelope. Returns zeros when the envelope is absent or malformed —
 * token counts are a cost-accounting signal, not load-bearing.
 *
 * @param {string} raw
 * @returns {{input: number, output: number}}
 */
function extractTokenCounts(raw) {
    try {
        const envelope = JSON.parse(raw);
        if (envelope && envelope.usage) {
            return {
                input: envelope.usage.input_tokens || 0,
                output: envelope.usage.output_tokens || 0,
            };
        }
    } catch { /* envelope malformed or absent — return zeros */ }
    return { input: 0, output: 0 };
}

module.exports = {
    checkClaudeCli,
    invokeModel,
    parseModelResult,
    tryParseInnerJson,
    extractTokenCounts,
    DEFAULT_MODEL,
    DEFAULT_TIMEOUT_MS,
};
