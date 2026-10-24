'use strict';
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


function validateModel(model, { allowNull = false } = {}) { return (allowNull && model === null) || (typeof model === 'string' && /^[A-Za-z0-9._:-]+$/.test(model)); }
function writeFailure(logTag, message) { if (logTag) process.stderr.write(`[${logTag}] ${message}\n`); }
module.exports = {tryParseInnerJson,parseModelResult,extractTokenCounts,validateModel,writeFailure};
