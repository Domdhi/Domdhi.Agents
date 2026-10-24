// AC→source map (TDD-3.8 / claude-mock):
//   - mockClaudeP → returns { mock, response }; response is JSON envelope with { result, usage }
//   - mockClaudePNotInstalled → execSync throws 'claude: command not found'
//   - expectClaudePCalledWith → throws on missing promptContains or model flag
//   - buildEnvelope, buildTextEnvelope, buildContentEnvelope → low-level builders
//   - makeMockExecSync → returns (cmd, opts) => string

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const childProcess = require('node:child_process');
const {
    mockClaudeP,
    mockClaudePNotInstalled,
    expectClaudePCalledWith,
    buildEnvelope,
    buildTextEnvelope,
    buildContentEnvelope,
    makeMockExecSync,
    installExecSyncMock,
} = require('../claude-mock');

const FIXTURE_PATH = '../fixtures/destructure-fixture.cjs';
const FIXTURE_RESOLVED = require.resolve(FIXTURE_PATH);

// ---------------------------------------------------------------------------
// Helpers used by multiple tests — mimic the parseModelResult logic from
// memory-curator.js:281-303 and memory-benchmark.js:187-204.
// ---------------------------------------------------------------------------

function parseModelResult(raw) {
    if (!raw) return null;
    let envelope;
    try {
        envelope = JSON.parse(raw);
    } catch {
        // Not JSON at envelope level — try raw as payload
        return tryParseInner(raw);
    }
    let text = null;
    if (typeof envelope === 'string') text = envelope;
    else if (envelope && typeof envelope === 'object') {
        text = envelope.result || envelope.text || envelope.output || null;
        if (!text && Array.isArray(envelope.content)) {
            text = envelope.content.map(c => c.text || '').join('');
        }
    }
    if (text) return tryParseInner(text);
    return null;
}

function tryParseInner(text) {
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

// ---------------------------------------------------------------------------
// Restore all spies after each test
// ---------------------------------------------------------------------------

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// buildEnvelope
// ---------------------------------------------------------------------------

describe('buildEnvelope', () => {
    it('buildEnvelope_stringInner_parsesToResultAndUsage', () => {
        const envelope = buildEnvelope('hello');
        const parsed = JSON.parse(envelope);

        expect(parsed.result).toBe('hello');
        expect(parsed.usage).toBeDefined();
        expect(typeof parsed.usage.input_tokens).toBe('number');
        expect(typeof parsed.usage.output_tokens).toBe('number');
        // Non-zero usage defaults
        expect(parsed.usage.input_tokens).toBeGreaterThan(0);
        expect(parsed.usage.output_tokens).toBeGreaterThan(0);
    });

    it('buildEnvelope_objectInner_resultFieldContainsStringifiedObject', () => {
        const inner = { foo: 1 };
        const envelope = buildEnvelope(inner);
        const parsed = JSON.parse(envelope);

        // result must be a string (the stringified inner object)
        expect(typeof parsed.result).toBe('string');
        expect(JSON.parse(parsed.result)).toEqual({ foo: 1 });
    });

    it('buildEnvelope_customUsage_overridesDefaults', () => {
        const envelope = buildEnvelope('data', { input_tokens: 42, output_tokens: 7 });
        const parsed = JSON.parse(envelope);

        expect(parsed.usage.input_tokens).toBe(42);
        expect(parsed.usage.output_tokens).toBe(7);
    });

    it('buildEnvelope_partialUsage_fillsInMissingTokens', () => {
        const envelope = buildEnvelope('data', { input_tokens: 20 });
        const parsed = JSON.parse(envelope);

        expect(parsed.usage.input_tokens).toBe(20);
        expect(parsed.usage.output_tokens).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// buildTextEnvelope
// ---------------------------------------------------------------------------

describe('buildTextEnvelope', () => {
    it('buildTextEnvelope_text_parsesToTextShape', () => {
        const envelope = buildTextEnvelope('hi');
        const parsed = JSON.parse(envelope);

        expect(parsed.text).toBe('hi');
        // Must not have result or usage fields
        expect(parsed.result).toBeUndefined();
        expect(parsed.usage).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// buildContentEnvelope
// ---------------------------------------------------------------------------

describe('buildContentEnvelope', () => {
    it('buildContentEnvelope_twoTexts_parsesToContentArray', () => {
        const envelope = buildContentEnvelope(['a', 'b']);
        const parsed = JSON.parse(envelope);

        expect(Array.isArray(parsed.content)).toBe(true);
        expect(parsed.content).toHaveLength(2);
        expect(parsed.content[0]).toEqual({ text: 'a' });
        expect(parsed.content[1]).toEqual({ text: 'b' });
    });

    it('buildContentEnvelope_empty_parsesToEmptyContentArray', () => {
        const envelope = buildContentEnvelope([]);
        const parsed = JSON.parse(envelope);

        expect(Array.isArray(parsed.content)).toBe(true);
        expect(parsed.content).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// makeMockExecSync
// ---------------------------------------------------------------------------

describe('makeMockExecSync', () => {
    it('makeMockExecSync_stringArg_returnsStringForAnyCommand', () => {
        const impl = makeMockExecSync('canned');
        expect(impl('anything', {})).toBe('canned');
        expect(impl('other-command')).toBe('canned');
    });

    it('makeMockExecSync_functionArg_commandMatchingWorks', () => {
        const impl = makeMockExecSync(cmd => (cmd.includes('foo') ? 'FOO' : 'BAR'));
        expect(impl('claude -p foo')).toBe('FOO');
        expect(impl('claude -p bar')).toBe('BAR');
    });

    it('makeMockExecSync_invalidArg_throws', () => {
        expect(() => makeMockExecSync(42)).toThrow('[claude-mock]');
    });
});

// ---------------------------------------------------------------------------
// mockClaudeP — primary TDD-3.8 AC
// ---------------------------------------------------------------------------

describe('mockClaudeP', () => {
    it('mockClaudeP_stringResult_responseIsJsonEnvelope', () => {
        const { mock, response } = mockClaudeP(vi, { result: 'hello world' });

        // response is a JSON string
        const parsed = JSON.parse(response);
        expect(parsed.result).toBe('hello world');
        expect(parsed.usage).toBeDefined();
        expect(typeof parsed.usage.input_tokens).toBe('number');
        expect(typeof parsed.usage.output_tokens).toBe('number');
    });

    it('mockClaudeP_callingExecSync_returnsCannedResponse', () => {
        const { mock, response } = mockClaudeP(vi, { result: 'inner payload' });

        // execSync is now wired to return the canned response
        const actual = childProcess.execSync('claude -p "some prompt" --model claude-haiku-4-5', {
            encoding: 'utf8',
        });

        expect(actual).toBe(response);
        expect(mock).toHaveBeenCalledOnce();
    });

    it('mockClaudeP_customUsage_appliedToEnvelope', () => {
        const { response } = mockClaudeP(vi, {
            result: 'data',
            usage: { input_tokens: 200, output_tokens: 99 },
        });

        const parsed = JSON.parse(response);
        expect(parsed.usage.input_tokens).toBe(200);
        expect(parsed.usage.output_tokens).toBe(99);
    });

    it('mockClaudeP_objectResult_stringifiesInnerResult', () => {
        const { response } = mockClaudeP(vi, { result: { learning: 'one' } });
        const parsed = JSON.parse(response);

        expect(typeof parsed.result).toBe('string');
        expect(JSON.parse(parsed.result)).toEqual({ learning: 'one' });
    });
});

// ---------------------------------------------------------------------------
// mockClaudePNotInstalled — TDD-3.8 AC
// ---------------------------------------------------------------------------

describe('mockClaudePNotInstalled', () => {
    it('mockClaudePNotInstalled_callingExecSync_throwsCommandNotFound', () => {
        mockClaudePNotInstalled(vi);

        expect(() =>
            childProcess.execSync('claude -p "prompt"', { encoding: 'utf8' })
        ).toThrow('claude: command not found');
    });

    it('mockClaudePNotInstalled_errorHasSterrField', () => {
        mockClaudePNotInstalled(vi);

        let caughtErr;
        try {
            childProcess.execSync('claude -p "prompt"');
        } catch (e) {
            caughtErr = e;
        }

        expect(caughtErr).toBeDefined();
        expect(caughtErr.stderr).toBe('claude: command not found');
    });
});

// ---------------------------------------------------------------------------
// expectClaudePCalledWith — TDD-3.8 AC
// ---------------------------------------------------------------------------

describe('expectClaudePCalledWith', () => {
    it('expectClaudePCalledWith_promptContains_passesWhenSubstringPresent', () => {
        const { mock } = mockClaudeP(vi, { result: 'ok' });

        childProcess.execSync('claude -p "extract learnings please" --model claude-haiku-4-5', {
            encoding: 'utf8',
        });

        // Should not throw
        expect(() =>
            expectClaudePCalledWith(mock, { promptContains: 'extract learnings' })
        ).not.toThrow();
    });

    it('expectClaudePCalledWith_promptContains_throwsWhenSubstringAbsent', () => {
        const { mock } = mockClaudeP(vi, { result: 'ok' });

        childProcess.execSync('claude -p "something else" --model claude-haiku-4-5', {
            encoding: 'utf8',
        });

        expect(() =>
            expectClaudePCalledWith(mock, { promptContains: 'extract learnings' })
        ).toThrow('extract learnings');
    });

    it('expectClaudePCalledWith_model_passesWhenModelFlagPresent', () => {
        const { mock } = mockClaudeP(vi, { result: 'ok' });

        childProcess.execSync('claude -p "prompt" --model claude-haiku-4-5', {
            encoding: 'utf8',
        });

        expect(() =>
            expectClaudePCalledWith(mock, { model: 'claude-haiku-4-5' })
        ).not.toThrow();
    });

    it('expectClaudePCalledWith_model_throwsWhenModelFlagAbsent', () => {
        const { mock } = mockClaudeP(vi, { result: 'ok' });

        // Call without --model flag
        childProcess.execSync('claude -p "prompt"', { encoding: 'utf8' });

        expect(() =>
            expectClaudePCalledWith(mock, { model: 'claude-haiku-4-5' })
        ).toThrow('claude-haiku-4-5');
    });

    it('expectClaudePCalledWith_neverCalled_throws', () => {
        const { mock } = mockClaudeP(vi, { result: 'ok' });
        // Do NOT call execSync

        expect(() =>
            expectClaudePCalledWith(mock, { promptContains: 'anything' })
        ).toThrow('never called');
    });
});

// ---------------------------------------------------------------------------
// Round-trip: envelope → parseModelResult (mirrors memory-curator/benchmark logic)
// ---------------------------------------------------------------------------

describe('round-trip parseModelResult', () => {
    it('roundTrip_buildEnvelope_primaryShape_innerTextRecovered', () => {
        const innerPayload = JSON.stringify({ dedup_candidates: [], contradiction_pairs: [] });
        const envelope = buildEnvelope(innerPayload);

        // parseModelResult receives the full envelope string (as execSync would return)
        const parsed = parseModelResult(envelope);

        expect(parsed).toEqual({ dedup_candidates: [], contradiction_pairs: [] });
    });

    it('roundTrip_buildTextEnvelope_innerTextRecovered', () => {
        const innerPayload = JSON.stringify({ expected_slug: 'my-concept' });
        const envelope = buildTextEnvelope(innerPayload);

        const parsed = parseModelResult(envelope);

        expect(parsed).toEqual({ expected_slug: 'my-concept' });
    });

    it('roundTrip_buildContentEnvelope_textsJoinedAndParsed', () => {
        // content envelope: join texts then parse inner JSON
        const innerPayload = JSON.stringify({ expected_slug: 'joined' });
        const envelope = buildContentEnvelope([innerPayload]);

        const parsed = parseModelResult(envelope);

        expect(parsed).toEqual({ expected_slug: 'joined' });
    });

    it('roundTrip_rawJsonString_extractor_parsedDirectly', () => {
        // With --bare the extractor (memory-extractor.js:112-115) gets raw JSON and
        // calls JSON.parse() directly on stdout — NOT via parseModelResult.
        // This test mirrors that direct-parse path (not the curator/benchmark envelope path).
        const rawArray = JSON.stringify([
            { category: 'pattern', title: 'mock usage', content: 'use mocks', confidence: 0.7 },
        ]);

        // Extractor path: trim, strip fences, JSON.parse
        const trimmed = rawArray.trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '');
        const parsed = JSON.parse(trimmed);

        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].category).toBe('pattern');
    });

    it('roundTrip_makeMockExecSync_withBuildEnvelope_integrates', () => {
        const innerPayload = JSON.stringify({ dedup_candidates: [{ slug_a: 'a', slug_b: 'b' }] });
        const canned = buildEnvelope(innerPayload);

        const impl = makeMockExecSync(canned);
        const returned = impl('claude -p "some prompt" --model claude-haiku-4-5', { encoding: 'utf8' });

        expect(returned).toBe(canned);
        const parsed = parseModelResult(returned);
        expect(parsed.dedup_candidates).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// installExecSyncMock — Wave-5 replacement for mockClaudeP's broken behavior
// against source modules that destructure execSync at module load.
// ---------------------------------------------------------------------------

describe('installExecSyncMock', () => {
    beforeEach(() => {
        // Flush the fixture so every test re-destructures a fresh mock.
        delete require.cache[FIXTURE_RESOLVED];
    });

    afterEach(() => {
        // Belt-and-suspenders: ensure no test leaves a cache override behind.
        delete require.cache['child_process'];
        delete require.cache[FIXTURE_RESOLVED];
    });

    it('installExecSyncMock_loadedSourceCallsExecSync_mockReceivesCall', () => {
        const { mock, source } = installExecSyncMock(vi, () => require(FIXTURE_PATH));

        source.runExec('ls -la');

        expect(mock).toHaveBeenCalledOnce();
        expect(mock).toHaveBeenCalledWith('ls -la', undefined);
    });

    it('installExecSyncMock_mockImplementation_returnsCannedResponse', () => {
        const { mock, source } = installExecSyncMock(vi, () => require(FIXTURE_PATH));
        mock.mockImplementation(() => 'canned-response');

        const result = source.runExec('claude -p "prompt"');

        expect(result).toBe('canned-response');
    });

    it('installExecSyncMock_afterLoad_cacheEntryDeleted', () => {
        installExecSyncMock(vi, () => require(FIXTURE_PATH));

        // The cache override must be gone once the helper returns, so
        // unrelated modules requiring child_process later get the real one.
        expect(require.cache['child_process']).toBeUndefined();
    });

    it('installExecSyncMock_afterLoad_freshRequireReturnsRealChildProcess', () => {
        installExecSyncMock(vi, () => require(FIXTURE_PATH));

        // Fresh require of child_process must yield the real module, not our fake.
        const cp = require('child_process');
        expect(typeof cp.execSync).toBe('function');
        // Real execSync is a native-ish function — our vi.fn() would carry .mock.
        expect(cp.execSync.mock).toBeUndefined();
    });

    it('installExecSyncMock_multipleMethods_allMockedAndExposed', () => {
        const { mocks, source } = installExecSyncMock(
            vi,
            () => require(FIXTURE_PATH),
            ['execSync', 'spawn']
        );
        mocks.spawn.mockImplementation(() => ({ unref: () => {} }));

        source.runExec('cmd');
        source.runSpawn('node', ['script.js']);

        expect(mocks.execSync).toHaveBeenCalledOnce();
        expect(mocks.spawn).toHaveBeenCalledOnce();
        expect(mocks.spawn).toHaveBeenCalledWith('node', ['script.js'], undefined);
    });

    it('installExecSyncMock_mockProperty_equalsMocksExecSync', () => {
        const { mock, mocks } = installExecSyncMock(vi, () => require(FIXTURE_PATH));
        expect(mock).toBe(mocks.execSync);
    });

    it('installExecSyncMock_missingVi_throws', () => {
        expect(() => installExecSyncMock(null, () => require(FIXTURE_PATH))).toThrow('[claude-mock]');
        expect(() => installExecSyncMock({}, () => require(FIXTURE_PATH))).toThrow('[claude-mock]');
    });

    it('installExecSyncMock_notAFunction_throws', () => {
        expect(() => installExecSyncMock(vi, null)).toThrow('[claude-mock]');
        expect(() => installExecSyncMock(vi, 'not-a-function')).toThrow('[claude-mock]');
    });

    it('installExecSyncMock_sourceReturnedVerbatim', () => {
        const { source } = installExecSyncMock(vi, () => require(FIXTURE_PATH));
        expect(typeof source.runExec).toBe('function');
        expect(typeof source.runSpawn).toBe('function');
    });

    it('installExecSyncMock_mockReset_clearsCallHistory', () => {
        const { mock, source } = installExecSyncMock(vi, () => require(FIXTURE_PATH));
        source.runExec('first');
        expect(mock).toHaveBeenCalledOnce();

        mock.mockReset();
        expect(mock).not.toHaveBeenCalled();

        // Post-reset the mock keeps intercepting — the destructured ref is the same vi.fn().
        source.runExec('second');
        expect(mock).toHaveBeenCalledOnce();
        expect(mock).toHaveBeenCalledWith('second', undefined);
    });

    it('installExecSyncMock_defaultMethods_onlyExecSyncMocked', () => {
        // Default methods = ['execSync']. Source calling spawn would hit the real one,
        // so we don't actually invoke it — just verify mocks object shape.
        const { mocks } = installExecSyncMock(vi, () => require(FIXTURE_PATH));
        expect(mocks.execSync).toBeDefined();
        expect(mocks.spawn).toBeUndefined();
    });

    it('installExecSyncMock_loadFnThrows_cacheStillCleanedUp', () => {
        expect(() =>
            installExecSyncMock(vi, () => { throw new Error('load failed'); })
        ).toThrow('load failed');

        // Even when the loader throws, the helper must clean the cache override
        // so unrelated tests aren't affected.
        expect(require.cache['child_process']).toBeUndefined();
    });
});
