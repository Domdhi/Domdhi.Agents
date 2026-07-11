// AC→source map (P2.3 / guardrail-rules):
//   - loadRules(yamlPath): missing file → empty-rules; malformed → empty-rules; valid → rules object
//   - matchesPattern(command, pattern): substring match, case-insensitive, regex /pattern/ form
//   - evaluate(command, rules): block > confirm > pass precedence; returns {decision, reason, pattern}
//
// These tests MUST FAIL before guardrail-rules.js is created, then pass after.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const path = require('node:path');

const { loadRules, matchesPattern, evaluate, hasEscalationMarker, globMatchesPath } = require('../guardrail-rules');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

// ─── loadRules ────────────────────────────────────────────────────────────────

describe('loadRules', () => {
    let tmp;

    beforeEach(() => { tmp = createTmpDir({ prefix: 'guardrail-rules-test-' }); });
    afterEach(() => { tmp.cleanup(); });

    it('loadRules_missingFile_returnsEmptyRulesObject', () => {
        // Arrange — path to a nonexistent file
        const missingPath = path.join(tmp.root, 'nonexistent.yaml');

        // Act
        const rules = loadRules(missingPath);

        // Assert — graceful degradation: empty arrays, not null/throw
        expect(rules).not.toBeNull();
        expect(Array.isArray(rules.block_patterns)).toBe(true);
        expect(rules.block_patterns).toHaveLength(0);
        expect(Array.isArray(rules.confirm_patterns)).toBe(true);
        expect(rules.confirm_patterns).toHaveLength(0);
    });

    it('loadRules_malformedYaml_returnsEmptyRulesObject', () => {
        // Arrange — write content that triggers parseYaml to produce non-arrays
        // for block_patterns (causes validation to fall back to empty-rules)
        const yamlPath = tmp.write('rules.yaml', ': this is invalid yaml with no valid top-level key\n');

        // Act
        const rules = loadRules(yamlPath);

        // Assert — graceful degradation
        expect(Array.isArray(rules.block_patterns)).toBe(true);
        expect(Array.isArray(rules.confirm_patterns)).toBe(true);
    });

    it('loadRules_validFile_returnsRulesObject', () => {
        // Arrange
        const yamlPath = tmp.write('rules.yaml', `
block_patterns:
  - "rm -rf /"
confirm_patterns:
  - "git push --force"
`);

        // Act
        const rules = loadRules(yamlPath);

        // Assert
        expect(Array.isArray(rules.block_patterns)).toBe(true);
        expect(rules.block_patterns).toContain('rm -rf /');
        expect(Array.isArray(rules.confirm_patterns)).toBe(true);
        expect(rules.confirm_patterns).toContain('git push --force');
    });

    it('loadRules_fileWithPathRules_passesThrough', () => {
        // Arrange — path_rules present; loadRules should return it but evaluate() must not act on it
        // Note: flow sequences ([]) are NOT supported by this parser — use indented list syntax
        const yamlPath = tmp.write('rules.yaml', `
block_patterns:
  - "rm -rf /"
confirm_patterns:
  - "git push --force"
path_rules:
  zero_access:
    - .env
`);

        // Act
        const rules = loadRules(yamlPath);

        // Assert — path_rules is passed through as-is
        expect(rules.path_rules).toBeDefined();
        expect(rules.path_rules.zero_access).toContain('.env');
    });

    it('loadRules_emptyFile_returnsEmptyRulesObject', () => {
        // Arrange
        const yamlPath = tmp.write('rules.yaml', '');

        // Act
        const rules = loadRules(yamlPath);

        // Assert
        expect(Array.isArray(rules.block_patterns)).toBe(true);
        expect(Array.isArray(rules.confirm_patterns)).toBe(true);
    });
});

// ─── matchesPattern ───────────────────────────────────────────────────────────

describe('matchesPattern', () => {
    it('matchesPattern_exactSubstringMatch_returnsTrue', () => {
        expect(matchesPattern('rm -rf /tmp/foo', 'rm -rf /')).toBe(true);
    });

    it('matchesPattern_caseInsensitiveSubstring_returnsTrue', () => {
        expect(matchesPattern('git push --force origin', 'GIT PUSH --FORCE')).toBe(true);
    });

    it('matchesPattern_noSubstringMatch_returnsFalse', () => {
        expect(matchesPattern('ls -la', 'rm -rf /')).toBe(false);
    });

    it('matchesPattern_regexPattern_matchesWhenRegexMatches', () => {
        expect(matchesPattern('dangerous command here', '/dangerous.*/')).toBe(true);
    });

    it('matchesPattern_regexPattern_noMatchWhenNotMatches', () => {
        expect(matchesPattern('safe command', '/dangerous.*/')).toBe(false);
    });

    it('matchesPattern_invalidRegex_returnsFalse', () => {
        // A bad regex pattern should not throw — returns false
        expect(matchesPattern('any command', '/[invalid/')).toBe(false);
    });

    it('matchesPattern_emptyPattern_returnsFalse', () => {
        expect(matchesPattern('some command', '')).toBe(false);
    });
});

// ─── evaluate ────────────────────────────────────────────────────────────────

describe('evaluate', () => {
    const rules = {
        block_patterns: ['rm -rf /'],
        confirm_patterns: ['git push --force'],
    };

    it('evaluate_commandMatchesBlockPattern_returnsBlock', () => {
        const result = evaluate('rm -rf /tmp/foo', rules);
        expect(result.decision).toBe('block');
        expect(result.pattern).toBe('rm -rf /');
    });

    it('evaluate_commandMatchesConfirmPattern_returnsConfirm', () => {
        const result = evaluate('git push --force main', rules);
        expect(result.decision).toBe('confirm');
        expect(result.pattern).toBe('git push --force');
    });

    it('evaluate_commandMatchesNeither_returnsPass', () => {
        const result = evaluate('ls -la', rules);
        expect(result.decision).toBe('pass');
        expect(result.pattern).toBeUndefined();
    });

    it('evaluate_blockTakesPrecedenceOverConfirm', () => {
        const overlapping = {
            block_patterns: ['git push'],
            confirm_patterns: ['git push --force'],
        };
        const result = evaluate('git push --force main', overlapping);
        expect(result.decision).toBe('block');
    });

    it('evaluate_emptyRules_returnsPass', () => {
        const result = evaluate('rm -rf /', { block_patterns: [], confirm_patterns: [] });
        expect(result.decision).toBe('pass');
    });

    it('evaluate_missingPatternKeys_returnsPass', () => {
        const result = evaluate('rm -rf /', {});
        expect(result.decision).toBe('pass');
    });

    it('evaluate_pathRulesPresent_notActedOn', () => {
        // path_rules must be ignored by evaluate() — legacy key; four-tier schema (zeroAccessPaths/readOnlyPaths/noDeletePaths) is the enforced replacement (P2.5)
        const rulesWithPath = {
            block_patterns: [],
            confirm_patterns: [],
            path_rules: { zero_access: ['.env'] },
        };
        const result = evaluate('cat .env', rulesWithPath);
        // Should pass — path_rules enforcement is NOT implemented here
        expect(result.decision).toBe('pass');
    });
});

describe('evaluate — nudge tier', () => {
    const rules = {
        block_patterns: ['rm -rf /'],
        nudge_patterns: ['/rm\\s+-[a-z]*[rf][a-z]*\\s+/'],
        confirm_patterns: ['git push --force'],
    };

    it('evaluate_nudgeMatch_noMarker_returnsNudge', () => {
        const result = evaluate('rm -rf dist', rules);
        expect(result.decision).toBe('nudge');
        expect(result.pattern).toBe('/rm\\s+-[a-z]*[rf][a-z]*\\s+/');
    });

    it('evaluate_nudgeMatch_withMarker_returnsConfirmEscalated', () => {
        const result = evaluate('rm -rf dist  # guardrail:confirm', rules);
        expect(result.decision).toBe('confirm');
        expect(result.escalated).toBe(true);
        expect(result.reason).toContain('no reversible alternative');
    });

    it('evaluate_blockTakesPrecedenceOverNudge_markerIgnored', () => {
        // A hard block is never escalatable, even with the marker present.
        const result = evaluate('rm -rf /  # guardrail:confirm', rules);
        expect(result.decision).toBe('block');
    });

    it('evaluate_nudgeCheckedBeforeConfirm', () => {
        // When a command matches both a nudge and a confirm pattern, nudge wins
        // (it is earlier in precedence) so the agent gets the alternative-first path.
        const overlap = {
            block_patterns: [],
            nudge_patterns: ['rm -rf'],
            confirm_patterns: ['rm'],
        };
        expect(evaluate('rm -rf build', overlap).decision).toBe('nudge');
    });

    it('hasEscalationMarker_detectsCommentForm_caseInsensitive', () => {
        expect(hasEscalationMarker('rm -rf x # guardrail:confirm')).toBe(true);
        expect(hasEscalationMarker('rm -rf x #guardrail:confirm')).toBe(true);
        expect(hasEscalationMarker('rm -rf x  # GUARDRAIL:CONFIRM')).toBe(true);
        expect(hasEscalationMarker('rm -rf x')).toBe(false);
        // Bare phrase without a leading # is NOT the marker (must read as a comment).
        expect(hasEscalationMarker('echo guardrail confirm')).toBe(false);
    });

    // ── C3: whitespace-normalized plain matching ─────────────────────────────
    it('matchesPattern_plain_normalizesWhitespace (C3)', () => {
        // Double space and tabs between tokens must not evade a plain pattern.
        expect(matchesPattern('git  push  --force', 'git push --force')).toBe(true);
        expect(matchesPattern('git\tpush\t--force', 'git push --force')).toBe(true);
        expect(matchesPattern('format  c:', 'format c:')).toBe(true);
        // Single-space still matches; an unrelated command still does not.
        expect(matchesPattern('git push --force', 'git push --force')).toBe(true);
        expect(matchesPattern('git status', 'git push --force')).toBe(false);
    });

    // ── m2 / G2: segment-boundary + exact-dir glob matching ──────────────────
    it('globMatchesPath_dirGlob_isSegmentBoundaryAnchored (m2)', () => {
        // `bin/` must NOT match an unrelated path that merely contains "bin".
        expect(globMatchesPath('bin/', '/repo/cabin/foo')).toBe(false);
        expect(globMatchesPath('web/', '/repo/cobweb/index.html')).toBe(false);
        // …but DOES match the directory itself and files under it.
        expect(globMatchesPath('bin/', '/repo/bin/tool')).toBe(true);
        expect(globMatchesPath('bin/', '/repo/bin')).toBe(true);           // exact dir, no trailing slash (G2)
        expect(globMatchesPath('.git/', '/repo/.git')).toBe(true);         // path.resolve drops the trailing slash
        expect(globMatchesPath('.git/', '/repo/.git/config')).toBe(true);
    });
});
