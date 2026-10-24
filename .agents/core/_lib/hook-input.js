/**
 * Hook Input — unified stdin reader.
 *
 * Extracted from 5 hooks that each rolled their own stdin parser with subtly
 * different behavior (different timeouts, some missing TTY check, some missing
 * error handler). This module consolidates them behind one API while preserving
 * each caller's historical timeout:
 *
 *   - command-usage-logger.cjs, edit-capture.cjs: 1000ms timeout (default)
 *   - memory-capture.cjs: 500ms timeout (pass { timeoutMs: 500 })
 *   - damage-control.cjs, guardrail.cjs, path-guardrail.cjs, commit-guard.cjs:
 *     5000ms ceiling (pass { timeoutMs: 5000 }) — generous but bounded so a
 *     wedged pipe can't hang the blocking tool call indefinitely.
 */

const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Read stdin to completion. Resolves '' if stdin is a TTY. By default resolves
 * with whatever partial data was received on error or timeout (fail-open) and
 * never rejects.
 *
 * `failClosedOnTimeout` flips the error/timeout paths to REJECT instead of
 * resolving-with-partial-data, so a security-gate hook can BLOCK a
 * wedged/truncated read rather than proceed as "nothing to check". It changes
 * ONLY the abnormal paths: a clean `end` still resolves normally (with the full
 * data, empty or not), so the legitimate empty-stdin case is unaffected — the
 * same distinction secret-scanner.cjs's readStdin draws. Used by guardrail.cjs,
 * path-guardrail.cjs, and commit-guard.cjs (finding 2, full-review-260716).
 *
 * @param {object} [opts]
 * @param {number|null} [opts.timeoutMs=1000] — milliseconds to wait after first
 *   event before resolving with accumulated data. Pass `null` (or 0) to disable
 *   the timeout entirely and wait for stdin `end`/`error` naturally. memory-capture
 *   uses 500ms; the 4 blocking hooks (damage-control, guardrail, path-guardrail,
 *   commit-guard) use a 5000ms ceiling; the rest use the 1000ms default.
 * @param {boolean} [opts.failClosedOnTimeout=false] — when true, a stream error
 *   or timeout REJECTS (Error) instead of resolving with partial data. A clean
 *   `end` still resolves normally.
 * @returns {Promise<string>}
 */
function readHookInput(opts = {}) {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, failClosedOnTimeout = false } = opts;
    return new Promise((resolve, reject) => {
        if (process.stdin.isTTY) { resolve(''); return; }

        let data = '';
        let settled = false;
        const finish = (ok, value) => {
            if (settled) return;
            settled = true;
            ok ? resolve(value) : reject(value);
        };

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => finish(true, data));
        process.stdin.on('error', (err) => {
            if (failClosedOnTimeout) finish(false, err instanceof Error ? err : new Error(String(err)));
            else finish(true, '');
        });

        if (timeoutMs !== null && timeoutMs !== 0) {
            setTimeout(() => {
                if (failClosedOnTimeout) {
                    finish(false, new Error(`stdin read did not complete within ${timeoutMs}ms`));
                } else {
                    finish(true, data);
                }
            }, timeoutMs);
        }
    });
}

/**
 * Parse a JSON payload from a hook's stdin string. Returns null on any failure
 * (invalid JSON, empty input) instead of throwing — hooks should never crash
 * Claude Code.
 *
 * @param {string} jsonText
 * @returns {object|null}
 */
function parseHookPayload(jsonText) {
    if (!jsonText || typeof jsonText !== 'string') return null;
    try {
        return JSON.parse(jsonText);
    } catch {
        return null;
    }
}

module.exports = {
    readHookInput,
    parseHookPayload,
};
