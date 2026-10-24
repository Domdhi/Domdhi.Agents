/**
 * claude-mock — helpers for mocking `claude -p --output-format json` responses.
 * CommonJS (not ESM) — loaded via createRequire() bridge in test files.
 *
 * All three Haiku-invoking scripts (memory-extractor, memory-curator, memory-benchmark)
 * call execSync('claude -p ... --output-format json --bare', { encoding: 'utf8' }).
 * With --bare the CLI returns raw text. These helpers build canned responses and
 * canned mocks so tests don't invoke the real claude CLI.
 *
 * PRIMARY API for source-module tests (Wave 5+):
 *
 *   installExecSyncMock(vi, loadSourceFn, methods? = ['execSync'])
 *     → { mock, mocks, source }
 *     Injects vi.fn()-backed fakes for child_process methods into require.cache
 *     BEFORE loading the source, so `const { execSync } = require('child_process')`
 *     destructures our mock. Cleans up the cache override after load.
 *     Use for any source that destructures child_process at module load.
 *
 * Low-level builders (for custom envelope shapes, used by Epic TDD-4+):
 *
 *   buildEnvelope(inner, usageOpts?)  → JSON string with { result, usage }
 *   buildTextEnvelope(text)           → JSON string with { text }
 *   buildContentEnvelope(texts)       → JSON string with { content: [{text},...] }
 *   makeMockExecSync(responseOrFn)    → (cmd, opts) => string
 *
 * DEPRECATED for source-module tests (see individual JSDoc below):
 *
 *   mockClaudeP(vi, { result, usage? })         — fine for testing this file directly
 *   mockClaudePNotInstalled(vi)                 — fine for testing this file directly
 *   expectClaudePCalledWith(execSyncMock, ...)  — still useful as an assertion helper
 */

const childProcess = require('node:child_process');

// ---------------------------------------------------------------------------
// Low-level envelope builders
// ---------------------------------------------------------------------------

/**
 * Build the primary `{ result, usage }` envelope.
 *
 * @param {string | object} inner - The payload. Objects are JSON.stringify-ed.
 * @param {{ input_tokens?: number, output_tokens?: number }} [usageOpts]
 * @returns {string} JSON-stringified envelope.
 */
function buildEnvelope(inner, usageOpts = {}) {
    const resultText = typeof inner === 'string' ? inner : JSON.stringify(inner);
    const envelope = {
        result: resultText,
        usage: {
            input_tokens: usageOpts.input_tokens ?? 100,
            output_tokens: usageOpts.output_tokens ?? 50,
        },
    };
    return JSON.stringify(envelope);
}

/**
 * Build the `{ text }` envelope shape (tolerated by curator/benchmark parsers).
 *
 * @param {string} text
 * @returns {string} JSON-stringified envelope.
 */
function buildTextEnvelope(text) {
    return JSON.stringify({ text });
}

/**
 * Build the `{ content: [{text}, ...] }` envelope shape (tolerated by curator/benchmark parsers).
 *
 * @param {string[]} texts - Array of text strings, one per content block.
 * @returns {string} JSON-stringified envelope.
 */
function buildContentEnvelope(texts) {
    return JSON.stringify({ content: texts.map(t => ({ text: t })) });
}

// ---------------------------------------------------------------------------
// makeMockExecSync — low-level factory for test spies
// ---------------------------------------------------------------------------

/**
 * Returns a mock implementation for execSync that returns canned responses.
 *
 * `responseOrFn` can be:
 *   - string  → always return this string
 *   - function (cmd: string) => string  → call to get response per command
 *
 * Usage:
 *   const impl = makeMockExecSync(buildEnvelope(['learning1']));
 *   vi.spyOn(childProcess, 'execSync').mockImplementation(impl);
 *
 * @param {string | ((cmd: string) => string)} responseOrFn
 * @returns {(cmd: string, opts?: object) => string}
 */
function makeMockExecSync(responseOrFn) {
    if (typeof responseOrFn === 'string') {
        return (_cmd, _opts) => responseOrFn;
    }
    if (typeof responseOrFn === 'function') {
        return (cmd, _opts) => responseOrFn(cmd);
    }
    throw new TypeError('[claude-mock] makeMockExecSync: argument must be a string or function');
}

// ---------------------------------------------------------------------------
// High-level helpers (primary TDD-3.8 API)
// ---------------------------------------------------------------------------

/**
 * Stub child_process.execSync to return a canned claude -p response.
 *
 * @deprecated For source-module tests, use `installExecSyncMock` instead. This
 * helper uses `vi.spyOn(childProcess, 'execSync')`, which does NOT intercept
 * references that the source module already captured via destructuring
 * (`const { execSync } = require('child_process')`). It still works when a test
 * calls `childProcess.execSync` directly — which is why it's retained here and
 * exercised by this file's own tests. New source-module tests (Wave 5 hooks,
 * future memory modules) must use `installExecSyncMock`.
 *
 * @param {object} vi - Vitest's `vi` object (passed from the test file).
 * @param {{ result: string | object, usage?: { input_tokens?: number, output_tokens?: number } }} options
 * @returns {{ mock: import('vitest').SpyInstance, response: string }}
 *   `mock` is the spied-on execSync. `response` is the canned JSON string.
 */
function mockClaudeP(vi, { result, usage = { input_tokens: 100, output_tokens: 50 } } = {}) {
    const response = buildEnvelope(result, usage);
    const mock = vi.spyOn(childProcess, 'execSync').mockImplementation((_cmd, _opts) => response);
    return { mock, response };
}

/**
 * Stub child_process.execSync to throw a 'claude: command not found' error,
 * simulating the claude CLI not being installed.
 *
 * @deprecated For source-module tests, use `installExecSyncMock` and
 * `mock.mockImplementation(() => { const e = new Error('claude: command not found'); e.stderr = ...; throw e; })`
 * instead. This helper shares the same spy-vs-destructure limitation as `mockClaudeP`.
 *
 * @param {object} vi - Vitest's `vi` object.
 * @returns {import('vitest').SpyInstance}
 */
function mockClaudePNotInstalled(vi) {
    const err = new Error('claude: command not found');
    err.stderr = 'claude: command not found';
    return vi.spyOn(childProcess, 'execSync').mockImplementation(() => {
        throw err;
    });
}

/**
 * Assert that execSyncMock was called with a command containing `promptContains`
 * and the `--model <model>` flag.
 *
 * Throws an AssertionError (via a thrown Error) if either check fails.
 * Designed for use inside Vitest test bodies — throws on failure so vitest
 * surfaces it as a test failure.
 *
 * @param {import('vitest').SpyInstance} execSyncMock - The spy returned by mockClaudeP.
 * @param {{ promptContains?: string, model?: string }} options
 */
function expectClaudePCalledWith(execSyncMock, { promptContains, model } = {}) {
    if (!execSyncMock.mock || execSyncMock.mock.calls.length === 0) {
        throw new Error('[claude-mock] expectClaudePCalledWith: execSync was never called');
    }

    // First positional arg is the command string
    const calledWith = execSyncMock.mock.calls.map(call => call[0]);

    if (promptContains) {
        const found = calledWith.some(cmd => typeof cmd === 'string' && cmd.includes(promptContains));
        if (!found) {
            throw new Error(
                `[claude-mock] expectClaudePCalledWith: no call contained prompt substring "${promptContains}".\n` +
                `Calls were:\n${calledWith.map(c => `  ${String(c).slice(0, 200)}`).join('\n')}`
            );
        }
    }

    if (model) {
        const flag = `--model ${model}`;
        const found = calledWith.some(cmd => typeof cmd === 'string' && cmd.includes(flag));
        if (!found) {
            throw new Error(
                `[claude-mock] expectClaudePCalledWith: no call contained model flag "${flag}".\n` +
                `Calls were:\n${calledWith.map(c => `  ${String(c).slice(0, 200)}`).join('\n')}`
            );
        }
    }
}

// ---------------------------------------------------------------------------
// installExecSyncMock — primary Wave-5 API for source modules that destructure
// child_process at module load.
// ---------------------------------------------------------------------------

/**
 * Install a vi.fn()-backed child_process mock via require.cache injection, load
 * the source module under test, then clean up the cache override.
 *
 * Works for source modules that do `const { execSync, spawn } = require('child_process')`
 * at the top of the file — the destructured references are captured by Node's
 * module linker at load time. The spy pattern (`vi.spyOn(childProcess, 'execSync')`)
 * fails in that case because the spy installs AFTER the source has already held
 * a reference to the original function. This helper pre-populates require.cache
 * with a fake `child_process` before invoking `loadSourceFn`, so the destructure
 * captures our mock.
 *
 * Pattern origin: TDD-4.3 `memory-curator.test.js` hand-rolled this trick; TDD-4.2
 * (`memory-extractor.test.js`) invented a monkey-patch wrapper variant, and TDD-4.4
 * (`memory-benchmark.test.js`) routed around by spying on instance methods. This
 * helper consolidates those three divergent workarounds into one.
 *
 * @param {object} vi - Vitest's `vi` object (passed from the test file).
 *                      Must be the vitest-imported vi, not a plain object.
 * @param {() => any} loadSourceFn - Synchronous function that requires the
 *                      source module. Invoked after the cache override is in place.
 * @param {string[]} [methods=['execSync']] - child_process exports to mock.
 *                      Pass `['execSync', 'spawn']` for sources that use both.
 * @returns {{ mock: import('vitest').Mock, mocks: Record<string, import('vitest').Mock>, source: any }}
 *   - `mock`: convenience alias for `mocks.execSync` (present only when execSync is mocked).
 *   - `mocks`: object keyed by method name — e.g., `{ execSync, spawn }`.
 *   - `source`: whatever `loadSourceFn` returned (the source module's exports).
 *
 * Usage (common — execSync only):
 *   const { mock: execSyncMock, source } = installExecSyncMock(
 *       vi, () => require('../memory-curator')
 *   );
 *   const { MemoryCurator } = source;
 *   beforeEach(() => { execSyncMock.mockReset(); });
 *
 * Usage (execSync + spawn, e.g., memory-capture.cjs):
 *   const { mocks, source } = installExecSyncMock(
 *       vi, () => require('../memory-capture'), ['execSync', 'spawn']
 *   );
 */
function installExecSyncMock(vi, loadSourceFn, methods = ['execSync']) {
    if (!vi || typeof vi.fn !== 'function') {
        throw new TypeError(
            '[claude-mock] installExecSyncMock: first argument must be Vitest\'s `vi` object (import { vi } from "vitest")'
        );
    }
    if (typeof loadSourceFn !== 'function') {
        throw new TypeError(
            '[claude-mock] installExecSyncMock: second argument must be a function that requires the source module, e.g. () => require(\'../memory-curator\')'
        );
    }

    const mocks = {};
    const fake = {};
    for (const name of methods) {
        const fn = vi.fn();
        mocks[name] = fn;
        fake[name] = fn;
    }

    // Built-in module cache key is the bare module name.
    require.cache['child_process'] = {
        id: 'child_process',
        filename: 'child_process',
        loaded: true,
        exports: fake,
        children: [],
        paths: [],
        parent: null,
    };

    try {
        const source = loadSourceFn();
        return { mock: mocks.execSync, mocks, source };
    } finally {
        // Always clean up — even if loadSourceFn throws — so unrelated modules
        // that require child_process after this call get the real one.
        delete require.cache['child_process'];
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    // Primary Wave-5 API — source modules that destructure child_process
    installExecSyncMock,
    // Assertion helper (works with either mock style)
    expectClaudePCalledWith,
    // Low-level builders (for Epic TDD-4 custom envelope shapes)
    buildEnvelope,
    buildTextEnvelope,
    buildContentEnvelope,
    makeMockExecSync,
    // Deprecated — kept for this file's own tests + TDD-3.8 backward compat
    mockClaudeP,
    mockClaudePNotInstalled,
};
