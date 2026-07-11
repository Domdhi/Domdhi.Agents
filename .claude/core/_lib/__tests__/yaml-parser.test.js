// AC→source map (P2.3 / yaml-parser):
//   - parseYaml: top-level keys, indented list items, nested key+list, comments, quoted scalars
//   - stripComment: inline comments, # inside quotes preserved, empty lines
//   - parseScalar: quoted strings strip quotes; unquoted pass through
//
// These tests MUST FAIL before yaml-parser.js is created, then pass after.
// The module will be created at .claude/core/_lib/yaml-parser.js.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { parseYaml, stripComment, parseScalar } = require('../yaml-parser');

// ─── Fixture YAML ─────────────────────────────────────────────────────────────

const FIXTURE_YAML = `
# Test rules
block_patterns:
  - "rm -rf /"
  - "/dangerous.*/"

confirm_patterns:
  - "git push --force"

nested:
  sub_key: "value with # hash inside"
  another:
    - item1
    - item2

string_val: "quoted value"
unquoted: plain text
bool_true: true
bool_false: false
`;

// ─── parseYaml ────────────────────────────────────────────────────────────────

describe('parseYaml', () => {
    it('parseYaml_blockPatterns_parsedAsArray', () => {
        const result = parseYaml(FIXTURE_YAML);
        expect(Array.isArray(result.block_patterns)).toBe(true);
        expect(result.block_patterns).toContain('rm -rf /');
        expect(result.block_patterns).toContain('/dangerous.*/');
    });

    it('parseYaml_confirmPatterns_parsedAsArray', () => {
        const result = parseYaml(FIXTURE_YAML);
        expect(Array.isArray(result.confirm_patterns)).toBe(true);
        expect(result.confirm_patterns).toContain('git push --force');
    });

    it('parseYaml_nestedKeys_parsedAsObject', () => {
        const result = parseYaml(FIXTURE_YAML);
        expect(typeof result.nested).toBe('object');
        expect(result.nested).not.toBeNull();
        expect(result.nested.sub_key).toBe('value with # hash inside');
    });

    it('parseYaml_nestedList_parsedAsArray', () => {
        const result = parseYaml(FIXTURE_YAML);
        expect(Array.isArray(result.nested.another)).toBe(true);
        expect(result.nested.another).toContain('item1');
        expect(result.nested.another).toContain('item2');
    });

    it('parseYaml_quotedStringValue_stripsQuotes', () => {
        const result = parseYaml(FIXTURE_YAML);
        expect(result.string_val).toBe('quoted value');
    });

    it('parseYaml_unquotedValue_preservedAsIs', () => {
        const result = parseYaml(FIXTURE_YAML);
        expect(result.unquoted).toBe('plain text');
    });

    it('parseYaml_topLevelComment_ignored', () => {
        const result = parseYaml(FIXTURE_YAML);
        const keys = Object.keys(result);
        expect(keys.every(k => !k.startsWith('#'))).toBe(true);
    });

    it('parseYaml_hashInsideQuotedSubKey_preserved', () => {
        const result = parseYaml(FIXTURE_YAML);
        expect(result.nested.sub_key).toContain('# hash inside');
    });

    it('parseYaml_emptyInput_returnsEmptyObject', () => {
        const result = parseYaml('');
        expect(result).toEqual({});
    });

    it('parseYaml_topLevelScalarValue_parsedInline', () => {
        const yaml = 'key: some value\n';
        const result = parseYaml(yaml);
        expect(result.key).toBe('some value');
    });

    it('parseYaml_multipleTopLevelKeys_allParsed', () => {
        const yaml = 'a:\n  - one\nb:\n  - two\n';
        const result = parseYaml(yaml);
        expect(result.a).toContain('one');
        expect(result.b).toContain('two');
    });

    it('parseYaml_blankLinesBetweenSections_handled', () => {
        const yaml = 'block_patterns:\n\n  - "rm -rf /"\n\nconfirm_patterns:\n  - "git push"\n';
        const result = parseYaml(yaml);
        expect(Array.isArray(result.block_patterns)).toBe(true);
        expect(Array.isArray(result.confirm_patterns)).toBe(true);
    });

    // ─── Empty flow forms (2026-04-25 — closes P2.5 latent-bug class) ────

    it('parseYaml_topLevelEmptyFlowSequence_parsedAsEmptyArray', () => {
        const result = parseYaml('dangerousPatterns: []\n');
        expect(Array.isArray(result.dangerousPatterns)).toBe(true);
        expect(result.dangerousPatterns).toEqual([]);
    });

    it('parseYaml_topLevelEmptyFlowMapping_parsedAsEmptyArray', () => {
        // `key: {}` is treated identically to `key: []` for our use case
        // (both signal "no entries"). Documented in module header.
        const result = parseYaml('readOnlyPaths: {}\n');
        expect(Array.isArray(result.readOnlyPaths)).toBe(true);
        expect(result.readOnlyPaths).toEqual([]);
    });

    it('parseYaml_emptyFlowDoesNotConsumeFollowingTopLevelKey', () => {
        const yaml = 'dangerousPatterns: []\nblock_patterns:\n  - "rm -rf"\n';
        const result = parseYaml(yaml);
        expect(result.dangerousPatterns).toEqual([]);
        expect(result.block_patterns).toEqual(['rm -rf']);
    });

    it('parseYaml_subKeyEmptyFlow_parsedAsEmptyArray', () => {
        // Empty flow form under a sub-key parses as [] and does not consume
        // the next sibling sub-key.
        const yaml = 'parent:\n  child_a: []\n  child_b:\n    - item1\n';
        const result = parseYaml(yaml);
        expect(result.parent.child_a).toEqual([]);
        expect(result.parent.child_b).toEqual(['item1']);
    });
});

// ─── stripComment ─────────────────────────────────────────────────────────────

describe('stripComment', () => {
    it('stripComment_noHash_returnsLineUnchanged', () => {
        expect(stripComment('plain text here')).toBe('plain text here');
    });

    it('stripComment_hashOutsideQuotes_stripsFromHash', () => {
        // Returns line.slice(0, hashIdx) — preserves the space before #.
        expect(stripComment('key: value # inline comment')).toBe('key: value ');
    });

    it('stripComment_hashInsideDoubleQuotes_preserved', () => {
        const line = 'sub_key: "value with # hash inside"';
        expect(stripComment(line)).toBe(line);
    });

    it('stripComment_hashInsideSingleQuotes_preserved', () => {
        const line = "sub_key: 'value with # hash inside'";
        expect(stripComment(line)).toBe(line);
    });

    it('stripComment_hashAtStart_returnsEmpty', () => {
        expect(stripComment('# full line comment').trim()).toBe('');
    });

    it('stripComment_emptyLine_returnsEmpty', () => {
        expect(stripComment('')).toBe('');
    });
});

// ─── parseScalar ─────────────────────────────────────────────────────────────

describe('parseScalar', () => {
    it('parseScalar_doubleQuotedString_stripsQuotes', () => {
        expect(parseScalar('"hello world"')).toBe('hello world');
    });

    it('parseScalar_singleQuotedString_stripsQuotes', () => {
        expect(parseScalar("'hello world'")).toBe('hello world');
    });

    it('parseScalar_unquotedString_returnsAsIs', () => {
        expect(parseScalar('plain text')).toBe('plain text');
    });

    it('parseScalar_emptyDoubleQuotes_returnsEmptyString', () => {
        expect(parseScalar('""')).toBe('');
    });

    it('parseScalar_mixedQuotes_notStripped', () => {
        // "foo' does not match quote-strip rule — returned as-is
        expect(parseScalar('"foo\'')).toBe('"foo\'');
    });

    // ── sec-m1: prototype-pollution guard ────────────────────────────────────
    describe('prototype pollution', () => {
        afterEach(() => {
            // Belt-and-suspenders: ensure no test leaves the global polluted.
            delete Object.prototype.polluted;
        });

        it('does not pollute Object.prototype via a nested __proto__ key', () => {
            const result = parseYaml('__proto__:\n  polluted: PWNED\n');
            // The classic gadget: nested assignment under __proto__.
            expect(({}).polluted).toBeUndefined();
            expect(Object.prototype.polluted).toBeUndefined();
            // The unsafe key is dropped, not surfaced as data.
            expect(result.polluted).toBeUndefined();
        });

        it('drops constructor / prototype keys at the top level too', () => {
            const result = parseYaml('constructor:\n  x: 1\nprototype:\n  y: 2\nblock_patterns:\n  - "rm -rf /"\n');
            // Legitimate sibling keys still parse.
            expect(result.block_patterns).toContain('rm -rf /');
            // No pollution and no data leakage from the unsafe keys.
            expect(Object.prototype.x).toBeUndefined();
            expect(Object.prototype.y).toBeUndefined();
        });
    });
});
