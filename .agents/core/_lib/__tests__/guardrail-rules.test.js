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

const { loadRules, matchesPattern, evaluate, hasEscalationMarker, globMatchesPath } = require('../../../../.agents/core/_lib/guardrail-rules');
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

describe('evaluate — static Git push normalization', () => {
    it.each([
        ['dangerousPatterns', 'block'],
        ['block_patterns', 'block'],
        ['nudge_patterns', 'nudge'],
        ['confirm_patterns', 'confirm'],
    ])('preserves the %s decision and matched rule', (tier, decision) => {
        const pattern = '/git\\b\\s+push\\b[^;&|\\n]*\\s--delete(?:\\s|$)/';
        const result = evaluate('git -c "test.key=x;y" push "up|stream" "--delete"; echo ok', { [tier]: [pattern] });
        expect(result.decision).toBe(decision);
        expect(result.pattern).toBe(pattern);
    });

    it('retains precedence, nudge escalation, malformed-pattern handling and raw rules', () => {
        const pattern = 'git push --delete';
        const command = 'git "push" "--delete" # guardrail:confirm';
        expect(evaluate(command, {
            dangerousPatterns: [pattern], nudge_patterns: [pattern], confirm_patterns: [pattern],
        })).toMatchObject({ decision: 'block', tier: 'dangerousPatterns', pattern });
        expect(evaluate(command, { nudge_patterns: [pattern] })).toMatchObject({ decision: 'confirm', escalated: true });
        expect(evaluate(command, { block_patterns: [null, '/[/'], confirm_patterns: [pattern] }).decision).toBe('confirm');
        expect(evaluate('custom dangerous command', { block_patterns: ['custom dangerous'] }).decision).toBe('block');
    });

    it('handles line continuations and escaped separators without executing them', () => {
        const rules = loadRules(path.resolve('.agents/config/guardrail-rules.yaml'));
        for (const command of [
            'git \\\npush origin \\:refs/heads/main',
            'git \\\r\npush origin \\:main',
            'git push up\\;stream \\:refs/tags/v1.0',
            'git push up\\&stream \\:refs/heads/main',
            'git push up\\|stream \\:main',
        ]) expect(evaluate(command, rules).decision, command).toBe('confirm');
        expect(evaluate('git push origin main:main; echo -d', rules).decision).toBe('pass');
        expect(evaluate('git push origin main:main && echo -fv', rules).decision).toBe('pass');
    });

    it('drops indented continuations without inventing an empty argument', () => {
        const rules = loadRules(path.resolve('.agents/config/guardrail-rules.yaml'));
        for (const continuation of ['\\\n  ', '\\\r\n  ', '`\n  ']) {
            expect(evaluate(`git ${continuation}push origin \\:refs/tags/v1.0`, rules).decision).toBe('confirm');
            expect(evaluate(`git -c ${continuation}"test.key=x;y" push origin \\:refs/tags/v1.0`, rules).decision).toBe('confirm');
            expect(evaluate(`git ${continuation}push origin "+refs/tags/v1.0:refs/tags/v1.0"`, rules).decision).toBe('block');
        }
        // Actual empty quoted arguments must survive normalization.
        expect(evaluate('git "" "push" origin \\:refs/tags/v1.0', rules).decision).toBe('pass');
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

// ─── project-owned override ───────────────────────────────────────────────────
// `<rules>.project.yaml` next to the shipped rules is project-owned: additions only strengthen the
// ruleset, and `except` may lift exact entries from the configuration-file tiers. Anything else is
// refused with a warning and the shipped rules stand.

describe('loadRules — project-owned override', () => {
    const fs = require('node:fs');
    const { checkPathAccess } = require('../../../../.agents/core/_lib/guardrail-rules');
    let tmp;
    let warnings;

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'guardrail-override-test-' });
        warnings = [];
        vi.spyOn(console, 'error').mockImplementation((message) => { warnings.push(String(message)); });
    });
    afterEach(() => { vi.restoreAllMocks(); tmp.cleanup(); });

    const SHIPPED = `
zeroAccessPaths:
  - .env
readOnlyPaths:
  - .editorconfig
  - .prettierrc*
noDeletePaths:
  - docs/
block_patterns:
  - "wipe the volume"
`;
    const shippedPath = () => tmp.write('.claude/guardrail-rules.yaml', SHIPPED);
    const override = (text) => tmp.write('.claude/guardrail-rules.project.yaml', text);

    it('loadRules_noOverrideFile_returnsTheShippedRulesUnchanged', () => {
        const rules = loadRules(shippedPath());
        expect(rules.readOnlyPaths).toEqual(['.editorconfig', '.prettierrc*']);
        expect(warnings).toEqual([]);
    });

    it('loadRules_exceptLiftsAnExactReadOnlyEntry_andOtherEntriesStayFrozen', () => {
        const yamlPath = shippedPath();
        override('except:\n  readOnlyPaths:\n    - .editorconfig\n');
        const rules = loadRules(yamlPath);
        expect(rules.readOnlyPaths).toEqual(['.prettierrc*']);
        expect(rules.zeroAccessPaths).toEqual(['.env']);
        expect(checkPathAccess('/repo/.editorconfig', 'write', rules).allowed).toBe(true);
        expect(checkPathAccess('/repo/.prettierrc.json', 'write', rules).allowed).toBe(false);
        expect(checkPathAccess('/repo/.env', 'write', rules).allowed).toBe(false);
        expect(warnings).toEqual([]);
        // The shipped file itself is never rewritten.
        expect(fs.readFileSync(yamlPath, 'utf8')).toBe(SHIPPED);
    });

    it('loadRules_additionsAreUnionedWithoutDuplicates_andOnlyStrengthenTheRuleset', () => {
        const yamlPath = shippedPath();
        override('readOnlyPaths:\n  - .editorconfig\n  - appsettings.Production.json\nblock_patterns:\n  - "drop database"\n');
        const rules = loadRules(yamlPath);
        expect(rules.readOnlyPaths).toEqual(['.editorconfig', '.prettierrc*', 'appsettings.Production.json']);
        expect(rules.block_patterns).toEqual(['wipe the volume', 'drop database']);
    });

    it.each([
        ['an exception for the zero-access tier', 'except:\n  zeroAccessPaths:\n    - .env\n'],
        ['an exception for a command tier', 'except:\n  block_patterns:\n    - "wipe the volume"\n'],
        ['an unknown top-level key', 'allow_everything: true\n'],
        ['an invalid regex in a command tier', 'block_patterns:\n  - "/(/"\n'],
        ['a non-list tier', 'readOnlyPaths: .editorconfig\n'],
        ['an unparsable file', ': not yaml at all\n'],
    ])('loadRules_override_%s_isRefusedWithAWarningAndTheShippedRulesStand', (_label, text) => {
        const yamlPath = shippedPath();
        const baseline = loadRules(yamlPath);
        warnings.length = 0;
        // A valid addition rides along so a partial application would show.
        override(text + (text.startsWith('except') ? 'readOnlyPaths:\n  - extra.cfg\n' : ''));
        const rules = loadRules(yamlPath);
        expect(rules).toEqual(baseline);
        expect(warnings.join('\n')).toMatch(/project override/i);
    });

    it('loadRules_staleException_warnsAndStillAppliesTheOthers', () => {
        const yamlPath = shippedPath();
        override('except:\n  readOnlyPaths:\n    - .editorconfig\n    - .not-in-shipped\n');
        const rules = loadRules(yamlPath);
        expect(rules.readOnlyPaths).toEqual(['.prettierrc*']);
        expect(warnings.join('\n')).toMatch(/\.not-in-shipped/);
    });

    it('loadRules_liftingAReadOnlyEntry_liftsDeleteToo_unlessTheSameFileKeepsItInNoDeletePaths', () => {
        const yamlPath = shippedPath();
        override('except:\n  readOnlyPaths:\n    - .editorconfig\n');
        const lifted = loadRules(yamlPath);
        expect(checkPathAccess('/repo/.editorconfig', 'delete', lifted).allowed).toBe(true);
        override('except:\n  readOnlyPaths:\n    - .editorconfig\nnoDeletePaths:\n  - .editorconfig\n');
        const kept = loadRules(yamlPath);
        expect(checkPathAccess('/repo/.editorconfig', 'write', kept).allowed).toBe(true);
        expect(checkPathAccess('/repo/.editorconfig', 'delete', kept).allowed).toBe(false);
    });

    it('loadRules_overrideLargerThanTheCap_isRefusedWithAWarning', () => {
        const yamlPath = shippedPath();
        const baseline = loadRules(yamlPath);
        warnings.length = 0;
        override('readOnlyPaths:\n' + '  - generated-entry.cfg\n'.repeat(4000));
        expect(loadRules(yamlPath)).toEqual(baseline);
        expect(warnings.join('\n')).toMatch(/project override .*larger than/i);
    });

    it('loadRules_emptyExceptFromBadIndentation_warnsInsteadOfLiftingNothingSilently', () => {
        const yamlPath = shippedPath();
        override('except:\nreadOnlyPaths:\n  - .editorconfig\n');
        loadRules(yamlPath);
        expect(warnings.join('\n')).toMatch(/empty "except"/);
    });

    it.each(['except: []', 'except: {}'])('loadRules_override_%s_warnsAsEmptyAndStillAppliesAdditions', (line) => {
        const yamlPath = shippedPath();
        override(`${line}\nreadOnlyPaths:\n  - extra.cfg\n`);
        const rules = loadRules(yamlPath);
        expect(warnings.join('\n')).toMatch(/empty "except"/);
        expect(rules.readOnlyPaths).toContain('extra.cfg');
    });

    it('loadRules_overrideWithoutShippedFile_returnsEmptyRules', () => {
        override('readOnlyPaths:\n  - extra.cfg\n');
        const rules = loadRules(path.join(tmp.root, '.claude/guardrail-rules.yaml'));
        expect(rules.readOnlyPaths).toEqual([]);
    });

    it('pathGuardrailHook_realShippedRulesWithAnEditorconfigException_allowsOnlyThatEdit', () => {
        const shipped = fs.readFileSync(path.join(__dirname, '../../../../.agents/config/guardrail-rules.yaml'), 'utf8');
        expect(shipped).toMatch(/^\s*- \.editorconfig\b/m);
        tmp.write('.claude/guardrail-rules.yaml', shipped);
        const saved = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = tmp.root;
        const hookPath = require.resolve('../../../../.agents/hooks/path-guardrail.cjs');
        try {
            const run = (file) => {
                delete require.cache[hookPath];
                return require(hookPath).processEvent({ tool_name: 'Edit', tool_input: { file_path: path.join(tmp.root, file) } });
            };
            expect(run('.editorconfig')).toMatchObject({ block: true });
            // The override file itself is read-only to agents: it cannot be written to lift its own guardrails.
            expect(run('.claude/guardrail-rules.project.yaml')).toMatchObject({ block: true });
            override('except:\n  readOnlyPaths:\n    - .editorconfig\n');
            expect(run('.editorconfig')).toBeNull();
            expect(run('.eslintrc.json')).toMatchObject({ block: true });
            expect(run('.env')).toMatchObject({ block: true });
        } finally {
            delete require.cache[hookPath];
            if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
        }
    });
});
