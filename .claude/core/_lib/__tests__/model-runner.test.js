// AC→source map (Task #3 / model-runner):
//   Five exports from _lib/model-runner.js:
//     - checkClaudeCli()                  — boolean probe
//     - invokeModel(prompt, opts)         — returns raw stdout string or null
//     - parseModelResult(raw)             — envelope-aware, extracts inner JSON
//     - tryParseInnerJson(text)           — primitive, strips fences, JSON.parse
//     - extractTokenCounts(raw)           — { input, output }; returns zeros on failure

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
    parseModelResult,
    tryParseInnerJson,
    extractTokenCounts,
    invokeModel,
} = require('../model-runner');

// Note: `invokeModel` + `checkClaudeCli` hit the real subprocess by design.
// The existing curator/benchmark/extractor test suites cover those paths by
// mocking execSync via require.cache injection (see claude-mock.js). Here we
// test only the pure parsers that don't need a subprocess — plus the model-id
// validation guard, which rejects BEFORE any subprocess is spawned.

// ─── invokeModel model-id guard (sec-n2) ─────────────────────────────────────

describe('invokeModel model-id validation', () => {
    // A model carrying shell metacharacters was interpolated unquoted into the
    // shelled `claude -p … --model ${model}` command. The guard must reject it and
    // return null WITHOUT spawning — so these calls never reach the real CLI.
    it('returns null for a model containing shell metacharacters', () => {
        expect(invokeModel('hi', { model: 'sonnet; rm -rf /', logTag: null })).toBeNull();
        expect(invokeModel('hi', { model: 'x$(whoami)', logTag: null })).toBeNull();
        expect(invokeModel('hi', { model: 'a`id`', logTag: null })).toBeNull();
        expect(invokeModel('hi', { model: 'a b', logTag: null })).toBeNull();
    });
});

// ─── parseModelResult ────────────────────────────────────────────────────────

describe('parseModelResult', () => {

  it('parseModelResult_nullInput_returnsNull', () => {
    expect(parseModelResult(null)).toBeNull();
    expect(parseModelResult('')).toBeNull();
  });

  it('parseModelResult_resultEnvelope_extractsInnerJson', () => {
    const inner = { dedup_candidates: [], contradictions: [] };
    const envelope = JSON.stringify({ result: JSON.stringify(inner), usage: { input_tokens: 100 } });
    expect(parseModelResult(envelope)).toEqual(inner);
  });

  it('parseModelResult_textEnvelope_extractsInnerJson', () => {
    const inner = { learnings: [{ title: 'x' }] };
    const envelope = JSON.stringify({ text: JSON.stringify(inner) });
    expect(parseModelResult(envelope)).toEqual(inner);
  });

  it('parseModelResult_outputEnvelope_extractsInnerJson', () => {
    const inner = { kind: 'alt' };
    const envelope = JSON.stringify({ output: JSON.stringify(inner) });
    expect(parseModelResult(envelope)).toEqual(inner);
  });

  it('parseModelResult_contentEnvelope_concatenatesAndParses', () => {
    const inner = { pieces: 2 };
    const part1 = JSON.stringify(inner).slice(0, 10);
    const part2 = JSON.stringify(inner).slice(10);
    const envelope = JSON.stringify({ content: [{ text: part1 }, { text: part2 }] });
    expect(parseModelResult(envelope)).toEqual(inner);
  });

  it('parseModelResult_markdownFencedInner_stripped', () => {
    // Model occasionally wraps the inner payload in ```json fences despite --bare
    const inner = { a: 1 };
    const envelope = JSON.stringify({ result: '```json\n' + JSON.stringify(inner) + '\n```' });
    expect(parseModelResult(envelope)).toEqual(inner);
  });

  it('parseModelResult_nonJsonInputWithFences_stripsAndParses', () => {
    // When raw isn't valid top-level JSON, the parser delegates to
    // tryParseInnerJson, which strips markdown fences.
    const inner = { hello: 'world' };
    const raw = '```json\n' + JSON.stringify(inner) + '\n```';
    expect(parseModelResult(raw)).toEqual(inner);
  });

  it('parseModelResult_envelopeWithoutKnownField_returnsNull', () => {
    // Envelopes that don't expose result/text/output/content are unrecognized.
    // Callers that want payload-direct parsing should use tryParseInnerJson.
    expect(parseModelResult(JSON.stringify({ some_unknown_field: 'foo' }))).toBeNull();
    expect(parseModelResult(JSON.stringify([1, 2, 3]))).toBeNull();
  });

});

// ─── tryParseInnerJson ───────────────────────────────────────────────────────

describe('tryParseInnerJson', () => {

  it('tryParseInnerJson_validJson_returnsParsed', () => {
    expect(tryParseInnerJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseInnerJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('tryParseInnerJson_jsonFences_stripped', () => {
    expect(tryParseInnerJson('```json\n{"x":true}\n```')).toEqual({ x: true });
    expect(tryParseInnerJson('```\n[1]\n```')).toEqual([1]);
  });

  it('tryParseInnerJson_invalidJson_returnsNull', () => {
    expect(tryParseInnerJson('this is not json')).toBeNull();
    expect(tryParseInnerJson('{unterminated')).toBeNull();
  });

  it('tryParseInnerJson_nonStringInput_returnsNull', () => {
    expect(tryParseInnerJson(null)).toBeNull();
    expect(tryParseInnerJson(undefined)).toBeNull();
    expect(tryParseInnerJson(42)).toBeNull();
  });

  it('tryParseInnerJson_whitespaceAndFencesCombined_stripped', () => {
    expect(tryParseInnerJson('   \n  ```json\n{"k":"v"}\n```  \n  ')).toEqual({ k: 'v' });
  });

});

// ─── extractTokenCounts ──────────────────────────────────────────────────────

describe('extractTokenCounts', () => {

  it('extractTokenCounts_validEnvelope_returnsTokens', () => {
    const envelope = JSON.stringify({ result: '{}', usage: { input_tokens: 123, output_tokens: 45 } });
    expect(extractTokenCounts(envelope)).toEqual({ input: 123, output: 45 });
  });

  it('extractTokenCounts_missingUsage_returnsZeros', () => {
    const envelope = JSON.stringify({ result: '{}' });
    expect(extractTokenCounts(envelope)).toEqual({ input: 0, output: 0 });
  });

  it('extractTokenCounts_malformedJson_returnsZeros', () => {
    expect(extractTokenCounts('not json at all')).toEqual({ input: 0, output: 0 });
  });

  it('extractTokenCounts_partialUsage_fillsWithZero', () => {
    const envelope = JSON.stringify({ usage: { input_tokens: 100 } });
    expect(extractTokenCounts(envelope)).toEqual({ input: 100, output: 0 });
  });

});
