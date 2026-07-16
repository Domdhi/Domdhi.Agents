// AC→source map (TDD-5.2 / guardrail):
//   - parseYaml: fixture YAML with block list, confirm list, nested keys, comments, quoted strings
//   - stripComment: inline comments, # inside quotes preserved, empty lines
//   - matchPatterns: exact match, prefix/substring match, regex match → correct block/confirm/pass
//   - checkRules: rm -rf / → block; git push --force → confirm; ls → allow
//   - processEvent: end-to-end with fixture rules file; rules missing → graceful default
//
// Note: AC named the function "matchesRule" and "checkRules(command, rules)".
//   matchesRule → source name preserved as matchPatterns (takes an array, not a rule).
//   checkRules is a NEW named function extracted from runClaudeHook during refactor.
//
// CJS cache-busting strategy:
//   guardrail.cjs loads rules via loadRules() which reads CLAUDE_PROJECT_DIR at call time.
//   The module exports are pure functions OR functions that read env at call time.
//   loadRules() reads CLAUDE_PROJECT_DIR every invocation — no cache-busting needed for
//   processEvent tests; we manipulate CLAUDE_PROJECT_DIR and use tmp dirs instead.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
    processEvent,
    parseYaml,
    stripComment,
    matchPatterns,
    stripCommitMessages,
    checkRules,
    loadRules,
    classifyDeletePath,
    PATH_CLASS_ENUM,
} = require('../guardrail.cjs');

const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');

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
`;

// ─── parseYaml ────────────────────────────────────────────────────────────────

describe('guardrail', () => {
    describe('parseYaml', () => {
        it('parseYaml_blockPatterns_parsedAsArray', () => {
            // Arrange / Act
            const result = parseYaml(FIXTURE_YAML);

            // Assert
            expect(Array.isArray(result.block_patterns)).toBe(true);
            expect(result.block_patterns).toContain('rm -rf /');
            expect(result.block_patterns).toContain('/dangerous.*/');
        });

        it('parseYaml_confirmPatterns_parsedAsArray', () => {
            // Arrange / Act
            const result = parseYaml(FIXTURE_YAML);

            // Assert
            expect(Array.isArray(result.confirm_patterns)).toBe(true);
            expect(result.confirm_patterns).toContain('git push --force');
        });

        it('parseYaml_nestedKeys_parsedAsObject', () => {
            // Arrange / Act
            const result = parseYaml(FIXTURE_YAML);

            // Assert
            expect(typeof result.nested).toBe('object');
            expect(result.nested).not.toBeNull();
            expect(result.nested.sub_key).toBe('value with # hash inside');
        });

        it('parseYaml_nestedList_parsedAsArray', () => {
            // Arrange / Act
            const result = parseYaml(FIXTURE_YAML);

            // Assert
            expect(Array.isArray(result.nested.another)).toBe(true);
            expect(result.nested.another).toContain('item1');
            expect(result.nested.another).toContain('item2');
        });

        it('parseYaml_quotedStringValue_stripsQuotes', () => {
            // Arrange / Act
            const result = parseYaml(FIXTURE_YAML);

            // Assert
            expect(result.string_val).toBe('quoted value');
        });

        it('parseYaml_unquotedValue_preservedAsIs', () => {
            // Arrange / Act
            const result = parseYaml(FIXTURE_YAML);

            // Assert
            expect(result.unquoted).toBe('plain text');
        });

        it('parseYaml_topLevelComment_ignored', () => {
            // Arrange / Act
            const result = parseYaml(FIXTURE_YAML);

            // Assert — "# Test rules" line should not appear as a key
            const keys = Object.keys(result);
            expect(keys.every(k => !k.startsWith('#'))).toBe(true);
        });

        it('parseYaml_hashInsideQuotedSubKey_preserved', () => {
            // Arrange — the fixture has: sub_key: "value with # hash inside"
            // Act
            const result = parseYaml(FIXTURE_YAML);

            // Assert — the # is inside quotes, so it must NOT be stripped
            expect(result.nested.sub_key).toContain('# hash inside');
        });

        it('parseYaml_emptyInput_returnsEmptyObject', () => {
            // Arrange / Act
            const result = parseYaml('');

            // Assert
            expect(result).toEqual({});
        });
    });

    // ─── stripComment ──────────────────────────────────────────────────────────

    describe('stripComment', () => {
        it('stripComment_noHash_returnsLineUnchanged', () => {
            // Arrange / Act / Assert
            expect(stripComment('plain text here')).toBe('plain text here');
        });

        it('stripComment_hashOutsideQuotes_stripsFromHash', () => {
            // stripComment returns line.slice(0, hashIdx) — preserves the space
            // before the #. Don't trim; downstream parsers do that.
            expect(stripComment('key: value # inline comment')).toBe('key: value ');
        });

        it('stripComment_hashInsideDoubleQuotes_preserved', () => {
            // Arrange / Act / Assert
            const line = 'sub_key: "value with # hash inside"';
            expect(stripComment(line)).toBe(line);
        });

        it('stripComment_hashInsideSingleQuotes_preserved', () => {
            // Arrange / Act / Assert
            const line = "sub_key: 'value with # hash inside'";
            expect(stripComment(line)).toBe(line);
        });

        it('stripComment_hashAtStart_returnsEmpty', () => {
            // Arrange / Act / Assert
            expect(stripComment('# full line comment').trim()).toBe('');
        });

        it('stripComment_emptyLine_returnsEmpty', () => {
            // Arrange / Act / Assert
            expect(stripComment('')).toBe('');
        });
    });

    // ─── matchPatterns ────────────────────────────────────────────────────────

    describe('matchPatterns', () => {
        it('matchPatterns_exactSubstringMatch_returnsMatchedPattern', () => {
            // Arrange
            const patterns = ['rm -rf /'];
            const command = 'rm -rf /tmp/foo';

            // Act
            const result = matchPatterns(command, patterns);

            // Assert
            expect(result).toBe('rm -rf /');
        });

        it('matchPatterns_caseInsensitiveMatch_returnsPattern', () => {
            // Arrange
            const patterns = ['GIT PUSH --FORCE'];
            const command = 'git push --force origin main';

            // Act
            const result = matchPatterns(command, patterns);

            // Assert
            expect(result).toBe('GIT PUSH --FORCE');
        });

        it('matchPatterns_prefixSubstringMatch_returnsPattern', () => {
            // Arrange
            const patterns = ['git push'];
            const command = 'git push --force main';

            // Act
            const result = matchPatterns(command, patterns);

            // Assert
            expect(result).toBe('git push');
        });

        it('matchPatterns_regexPattern_matchesWhenRegexMatches', () => {
            // Arrange
            const patterns = ['/dangerous.*/'];
            const command = 'dangerous command here';

            // Act
            const result = matchPatterns(command, patterns);

            // Assert
            expect(result).toBe('/dangerous.*/');
        });

        it('matchPatterns_regexPattern_noMatchWhenRegexDoesNotMatch', () => {
            // Arrange
            const patterns = ['/dangerous.*/'];
            const command = 'safe command here';

            // Act
            const result = matchPatterns(command, patterns);

            // Assert
            expect(result).toBeNull();
        });

        it('matchPatterns_noMatchingPattern_returnsNull', () => {
            // Arrange
            const patterns = ['rm -rf /', 'git push --force'];
            const command = 'ls -la';

            // Act
            const result = matchPatterns(command, patterns);

            // Assert
            expect(result).toBeNull();
        });

        it('matchPatterns_emptyPatternArray_returnsNull', () => {
            // Arrange / Act / Assert
            expect(matchPatterns('rm -rf /', [])).toBeNull();
        });

        it('matchPatterns_nonArrayPatterns_returnsNull', () => {
            // Arrange / Act / Assert
            expect(matchPatterns('rm -rf /', null)).toBeNull();
            expect(matchPatterns('rm -rf /', undefined)).toBeNull();
        });

        it('matchPatterns_invalidRegex_skipsAndContinues', () => {
            // Arrange — invalid regex followed by a valid plain pattern
            const patterns = ['/[invalid/', 'rm -rf /'];
            const command = 'rm -rf /tmp';

            // Act
            const result = matchPatterns(command, patterns);

            // Assert — skips the bad regex, matches the plain pattern
            expect(result).toBe('rm -rf /');
        });
    });

    // ─── checkRules ───────────────────────────────────────────────────────────

    describe('checkRules', () => {
        const rules = {
            block_patterns: ['rm -rf /'],
            confirm_patterns: ['git push --force'],
        };

        it('checkRules_commandMatchesBlockPattern_returnsBlock', () => {
            // Arrange / Act
            const result = checkRules('rm -rf /tmp/foo', rules);

            // Assert
            expect(result.action).toBe('block');
            expect(result.pattern).toBe('rm -rf /');
        });

        it('checkRules_commandMatchesConfirmPattern_returnsConfirm', () => {
            // Arrange / Act
            const result = checkRules('git push --force main', rules);

            // Assert
            expect(result.action).toBe('confirm');
            expect(result.pattern).toBe('git push --force');
        });

        it('checkRules_commandMatchesNeither_returnsAllow', () => {
            // Arrange / Act
            const result = checkRules('ls -la', rules);

            // Assert
            expect(result.action).toBe('allow');
            expect(result.pattern).toBeUndefined();
        });

        it('checkRules_blockPatternTakesPrecedenceOverConfirm', () => {
            // Arrange — command that could match both if both lists had it
            const overlappingRules = {
                block_patterns: ['git push'],
                confirm_patterns: ['git push --force'],
            };

            // Act
            const result = checkRules('git push --force main', overlappingRules);

            // Assert — block wins because it is checked first
            expect(result.action).toBe('block');
        });

        it('checkRules_emptyRules_returnsAllow', () => {
            // Arrange / Act
            const result = checkRules('rm -rf /', { block_patterns: [], confirm_patterns: [] });

            // Assert
            expect(result.action).toBe('allow');
        });

        it('checkRules_missingPatternKeys_returnsAllow', () => {
            // Arrange — rules object without block_patterns or confirm_patterns
            const result = checkRules('rm -rf /', {});

            // Assert
            expect(result.action).toBe('allow');
        });
    });

    // ─── processEvent ─────────────────────────────────────────────────────────

    describe('processEvent', () => {
        let tmp;
        let originalDir;

        beforeEach(() => {
            tmp = createTmpDir();
            originalDir = process.env.CLAUDE_PROJECT_DIR;
        });

        afterEach(() => {
            if (originalDir === undefined) {
                delete process.env.CLAUDE_PROJECT_DIR;
            } else {
                process.env.CLAUDE_PROJECT_DIR = originalDir;
            }
            tmp.cleanup();
        });

        function writeRules(content) {
            tmp.write('.claude/guardrail-rules.yaml', content);
            process.env.CLAUDE_PROJECT_DIR = tmp.root;
        }

        const STANDARD_RULES = `
block_patterns:
  - "rm -rf /"
confirm_patterns:
  - "git push --force"
`;

        it('processEvent_rmRfSlash_returnsBlock', () => {
            // Arrange
            writeRules(STANDARD_RULES);

            // Act
            const result = processEvent({ tool_input: { command: 'rm -rf /tmp/foo' } });

            // Assert
            expect(result).not.toBeNull();
            expect(result.block).toBe(true);
            expect(result.feedback).toEqual(expect.stringContaining('BLOCKED'));
        });

        it('processEvent_gitPushForce_returnsConfirm', () => {
            // Arrange
            writeRules(STANDARD_RULES);

            // Act
            const result = processEvent({ tool_input: { command: 'git push --force main' } });

            // Assert
            expect(result).not.toBeNull();
            expect(result.confirm).toBe(true);
            expect(typeof result.reason).toBe('string');
            expect(result.reason).toContain('git push --force');
        });

        it('processEvent_safeCommand_returnsNull', () => {
            // Arrange
            writeRules(STANDARD_RULES);

            // Act
            const result = processEvent({ tool_input: { command: 'ls -la' } });

            // Assert
            expect(result).toBeNull();
        });

        const NUDGE_RULES = `
block_patterns:
  - "rm -rf /"
nudge_patterns:
  - "rm -rf"
confirm_patterns:
  - "git push --force"
`;

        it('processEvent_nudgeMatch_returnsSoftDenyWithAlternativeMessage', () => {
            // Arrange
            writeRules(NUDGE_RULES);

            // Act — plain destructive command, no escalation marker
            const result = processEvent({ tool_input: { command: 'rm -rf build' } });

            // Assert — delivered on the block channel (exit 2) but with the nudge message
            expect(result).not.toBeNull();
            expect(result.block).toBe(true);
            expect(result.feedback).toEqual(expect.stringContaining('SAFER ALTERNATIVE'));
            expect(result.feedback).toEqual(expect.stringContaining('# guardrail:confirm'));
        });

        it('processEvent_nudgeWithEscalationMarker_returnsConfirm', () => {
            // Arrange
            writeRules(NUDGE_RULES);

            // Act — same command, re-run with the escalation marker
            const result = processEvent({ tool_input: { command: 'rm -rf build  # guardrail:confirm' } });

            // Assert — now the user is prompted
            expect(result).not.toBeNull();
            expect(result.confirm).toBe(true);
            expect(result.reason).toContain('rm -rf build');
        });

        it('processEvent_rulesMissing_returnsNullAndWarnsStderr', () => {
            // Arrange — point to an empty tmp dir with no rules file
            process.env.CLAUDE_PROJECT_DIR = tmp.root;
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

            try {
                // Act
                const result = processEvent({ tool_input: { command: 'rm -rf /tmp/foo' } });

                // Assert
                expect(result).toBeNull();
                expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[guardrail]'));
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_emptyCommand_returnsNull', () => {
            // Arrange
            writeRules(STANDARD_RULES);

            // Act
            const result = processEvent({ tool_input: { command: '' } });

            // Assert
            expect(result).toBeNull();
        });

        it('processEvent_missingToolInput_returnsNull', () => {
            // Arrange
            writeRules(STANDARD_RULES);

            // Act
            const result = processEvent({});

            // Assert
            expect(result).toBeNull();
        });

        it('processEvent_commitMessageContainingBlockedPhrase_notBlocked', () => {
            // Arrange — commit message mentions "rm -rf /" but the actual command is just git commit
            writeRules(STANDARD_RULES);
            const command = `git commit -m "fix: prevent rm -rf / accidents"`;

            // Act
            const result = processEvent({ tool_input: { command } });

            // Assert — stripCommitMessages removes the -m content so no false positive
            expect(result).toBeNull();
        });

        // ─── hit-counter telemetry metadata (emitted by runClaudeHook, carried on
        //     the processEvent result so it can be asserted without side effects) ──

        it('processEvent_block_carriesTelemetryMetadata', () => {
            writeRules(STANDARD_RULES);
            const result = processEvent({ tool_input: { command: 'rm -rf /tmp/foo' } });
            // pathClass=tmp: this IS a delete-style command on /tmp/foo (C1).
            expect(result.telemetry).toEqual({ decision: 'block', rule: 'rm -rf /', tier: null, pathClass: 'tmp' });
        });

        it('processEvent_confirm_carriesTelemetryMetadata', () => {
            writeRules(STANDARD_RULES);
            const result = processEvent({ tool_input: { command: 'git push --force main' } });
            // pathClass=null: not a delete-style command (C1).
            expect(result.telemetry).toEqual({ decision: 'confirm', rule: 'git push --force', tier: null, pathClass: null });
        });

        it('processEvent_nudge_carriesTelemetryMetadata', () => {
            writeRules(`
nudge_patterns:
  - "rm -rf build"
`);
            const result = processEvent({ tool_input: { command: 'rm -rf build' } });
            expect(result.telemetry.decision).toBe('nudge');
            expect(result.telemetry.rule).toBe('rm -rf build');
        });

        it('processEvent_allow_hasNoTelemetry', () => {
            writeRules(STANDARD_RULES);
            const result = processEvent({ tool_input: { command: 'ls -la' } });
            expect(result).toBeNull();   // allows are never counted
        });

        // ─── pathClass on delete-relevant telemetry (C1) ────────────────────────
        it('processEvent_nudgeOnDelete_carriesPathClass', () => {
            writeRules(`
nudge_patterns:
  - "rm -rf"
`);
            const result = processEvent({ tool_input: { command: 'rm -rf ./src' } });
            expect(result.telemetry.decision).toBe('nudge');
            expect(result.telemetry.pathClass).toBe('project-path');
        });

        it('processEvent_blockOnDelete_carriesPathClass', () => {
            writeRules(`
block_patterns:
  - "rm -rf"
`);
            const result = processEvent({ tool_input: { command: 'rm -rf node_modules' } });
            expect(result.telemetry.decision).toBe('block');
            expect(result.telemetry.pathClass).toBe('node_modules');
        });

        it('processEvent_nonDeleteRule_pathClassIsNull', () => {
            writeRules(STANDARD_RULES);
            const result = processEvent({ tool_input: { command: 'git push --force main' } });
            expect(result.telemetry.decision).toBe('confirm');
            expect(result.telemetry.pathClass).toBeNull();
        });
    });

    // ─── loadRules (missing file) ─────────────────────────────────────────────

    describe('loadRules', () => {
        let tmp;
        let originalDir;

        beforeEach(() => {
            tmp = createTmpDir();
            originalDir = process.env.CLAUDE_PROJECT_DIR;
        });

        afterEach(() => {
            if (originalDir === undefined) {
                delete process.env.CLAUDE_PROJECT_DIR;
            } else {
                process.env.CLAUDE_PROJECT_DIR = originalDir;
            }
            tmp.cleanup();
        });

        it('loadRules_missingFile_returnsNull', () => {
            // Arrange — empty tmp dir, no guardrail-rules.yaml
            process.env.CLAUDE_PROJECT_DIR = tmp.root;
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

            try {
                // Act
                const result = loadRules();

                // Assert
                expect(result).toBeNull();
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('loadRules_missingFile_writesWarningToStderr', () => {
            // Arrange
            process.env.CLAUDE_PROJECT_DIR = tmp.root;
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

            try {
                // Act
                loadRules();

                // Assert
                expect(stderrSpy).toHaveBeenCalledWith(
                    expect.stringContaining('guardrail-rules.yaml not found')
                );
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('loadRules_validFile_returnsRulesObject', () => {
            // Arrange
            tmp.write('.claude/guardrail-rules.yaml', `
block_patterns:
  - "rm -rf /"
confirm_patterns:
  - "git push --force"
`);
            process.env.CLAUDE_PROJECT_DIR = tmp.root;

            // Act
            const result = loadRules();

            // Assert
            expect(result).not.toBeNull();
            expect(Array.isArray(result.block_patterns)).toBe(true);
            expect(Array.isArray(result.confirm_patterns)).toBe(true);
        });

        // ── W2-2: F12 regex validation must reach the LIVE Bash hook ───────────
        // The hook previously used its own loader that returned raw parsed
        // patterns verbatim, so a malformed /regex/ in a pattern tier silently
        // no-op'd at match time (matchesPattern swallows the RegExp throw). The
        // hook now delegates to the F12-validated _lib loader, so a malformed
        // regex drops that tier to [] (fail-safe) with a loud warning — never a
        // silent dead rule at the one hook that guards destructive commands.
        it('loadRules_malformedRegexInBlockTier_reachesLiveHook_dropsTierWithWarning', () => {
            // An operator typo'd an unbalanced paren into a block pattern.
            tmp.write('.claude/guardrail-rules.yaml', `
block_patterns:
  - "/curl.*(|bash/"
`);
            process.env.CLAUDE_PROJECT_DIR = tmp.root;
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            try {
                const result = loadRules();
                // Fail-safe reached the live hook: the malformed tier is dropped
                // to [] rather than carried verbatim (the old shadow-loader bug).
                expect(result).not.toBeNull();
                expect(result.block_patterns).toEqual([]);
                // Loud, non-silent operator warning naming the offending tier.
                expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('block_patterns'));
            } finally {
                errSpy.mockRestore();
            }
        });

        it('loadRules_validRegexTiers_surviveDelegation_noFalseDrop', () => {
            tmp.write('.claude/guardrail-rules.yaml', `
block_patterns:
  - "/curl.*bash/"
  - "rm -rf /"
`);
            process.env.CLAUDE_PROJECT_DIR = tmp.root;

            const result = loadRules();
            expect(result.block_patterns).toContain('/curl.*bash/');
            expect(result.block_patterns).toContain('rm -rf /');
        });
    });
});

// ─── classifyDeletePath (C1 — coarse, secret-safe path class) ─────────────────
describe('classifyDeletePath', () => {
    it('returns null for non-delete commands (no path to classify)', () => {
        expect(classifyDeletePath('git push --force')).toBeNull();
        expect(classifyDeletePath('ls -la')).toBeNull();
        expect(classifyDeletePath('echo rm -rf /tmp')).toBeNull(); // not a delete verb at start
        expect(classifyDeletePath('')).toBeNull();
    });

    it('classifies build-artifact dirs', () => {
        for (const cmd of [
            'rm -rf bin/', 'rm -rf ./obj', 'rm -rf dist', 'rm -rf build/',
            'rm -rf out', 'rm -rf target/', 'rm -rf coverage', 'rm -rf TestResults/',
            'rm -rf .next',
        ]) {
            expect(classifyDeletePath(cmd)).toBe(PATH_CLASS_ENUM.BUILD_ARTIFACT);
        }
    });

    it('classifies tmp paths (relative, absolute, vars, mktemp, sandbox)', () => {
        for (const cmd of [
            'rm -rf tmp/', 'rm -rf ./tmp/scratch', 'rm -rf /tmp/x',
            'rm -rf "$TMPDIR/foo"', 'rm -rf $T', 'rm -rf mktemp',
            'rm -rf /var/folders/ab/cd/T/x', 'rm -rf .sandbox/mfahub',
        ]) {
            expect(classifyDeletePath(cmd)).toBe(PATH_CLASS_ENUM.TMP);
        }
    });

    it('returns null for a bare short /flag-like first token (extractDeletePaths drops it)', () => {
        // extractDeletePaths treats a short single-segment `/tmp` (≤5 chars, no
        // second slash) as a flag and drops it, so there is no path to classify.
        // `/tmp/...` (with a sub-path) classifies as tmp — covered above.
        expect(classifyDeletePath('rm -rf /tmp')).toBeNull();
    });

    it('classifies node_modules', () => {
        expect(classifyDeletePath('rm -rf node_modules')).toBe(PATH_CLASS_ENUM.NODE_MODULES);
        expect(classifyDeletePath('rm -rf ./node_modules/foo')).toBe(PATH_CLASS_ENUM.NODE_MODULES);
    });

    it('classifies output-or-vcs (.output / .git / .worktrees)', () => {
        expect(classifyDeletePath('rm -rf .output/')).toBe(PATH_CLASS_ENUM.OUTPUT_OR_VCS);
        expect(classifyDeletePath('rm -rf ./.output/findings/reviews')).toBe(PATH_CLASS_ENUM.OUTPUT_OR_VCS);
        expect(classifyDeletePath('rm -rf .git')).toBe(PATH_CLASS_ENUM.OUTPUT_OR_VCS);
        expect(classifyDeletePath('rm -rf .worktrees/feat')).toBe(PATH_CLASS_ENUM.OUTPUT_OR_VCS);
    });

    it('classifies home-or-root paths', () => {
        // Note: bare `/` and short single-segment absolutes like `/etc` are
        // dropped by extractDeletePaths' flag heuristic (≤5 chars, no 2nd slash),
        // so use ~ forms and multi-segment absolutes here.
        for (const cmd of [
            'rm -rf ~', 'rm -rf ~/Documents', 'rm -rf /usr/local', 'rm -rf /etc/passwd',
        ]) {
            expect(classifyDeletePath(cmd)).toBe(PATH_CLASS_ENUM.HOME_OR_ROOT);
        }
    });

    it('classifies other relative repo paths as project-path', () => {
        expect(classifyDeletePath('rm -rf ./src')).toBe(PATH_CLASS_ENUM.PROJECT_PATH);
        expect(classifyDeletePath('rm -rf docs/work')).toBe(PATH_CLASS_ENUM.PROJECT_PATH);
        expect(classifyDeletePath('rm -rf README.md')).toBe(PATH_CLASS_ENUM.PROJECT_PATH);
        expect(classifyDeletePath('rm -rf somefile')).toBe(PATH_CLASS_ENUM.PROJECT_PATH);
    });

    it('classifies del / unlink / Remove-Item delete verbs too', () => {
        expect(classifyDeletePath('del /s /q bin')).toBe(PATH_CLASS_ENUM.BUILD_ARTIFACT);
        expect(classifyDeletePath('unlink ./src/x.js')).toBe(PATH_CLASS_ENUM.PROJECT_PATH);
        expect(classifyDeletePath('Remove-Item node_modules -Recurse')).toBe(PATH_CLASS_ENUM.NODE_MODULES);
    });

    it('classifies the FIRST path only (later tokens do not change the class)', () => {
        // First arg is a real project path → project-path even though bin/ trails.
        expect(classifyDeletePath('rm -rf ~/important && echo bin/')).toBe(PATH_CLASS_ENUM.HOME_OR_ROOT);
        expect(classifyDeletePath('rm -rf ./src dist/')).toBe(PATH_CLASS_ENUM.PROJECT_PATH);
    });
});

// ─── Live guardrail-rules.yaml (the REAL repo file, not a fixture) ─────────────
// These lock in the narrowed rm -rf / find -exec confirm patterns against the
// actual shipped rule file — fixtures wouldn't catch a regression in the real
// YAML. (fixture-test-checker-not-live-tree lesson.)

const path = require('path');
const REPO_ROOT = path.resolve(path.dirname(require.resolve('../guardrail.cjs')), '..', '..');

describe('guardrail — live rules (tmp-exempt rm -rf + destructive find -exec)', () => {
    let originalDir;

    beforeEach(() => {
        originalDir = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = REPO_ROOT;
    });

    afterEach(() => {
        if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = originalDir;
    });

    const decision = (command) => {
        const r = processEvent({ tool_input: { command } });
        if (r === null) return 'pass';
        if (r.confirm) return 'confirm';
        // A nudge is delivered via the block channel (exit 2) but with the
        // "try a safer alternative first" message — distinguish by feedback.
        if (r.block) return r.feedback && r.feedback.includes('SAFER ALTERNATIVE') ? 'nudge' : 'block';
        return '?';
    };

    it('rmRf_tmpVar_passesWithoutConfirm', () => {
        // sub-agent tmp cleanup — the exact shape that used to prompt every run
        expect(decision('rm -rf "$T"')).toBe('pass');
        expect(decision('rm -rf "$TMPDIR/scratch"')).toBe('pass');
    });

    it('rmRf_tmpPath_passesWithoutConfirm', () => {
        expect(decision('rm -rf /tmp/tmp.abc123')).toBe('pass');
    });

    it('rmRf_realProjectPath_nudges', () => {
        // Real project-path deletes now NUDGE first (try a safer alternative)
        // rather than going straight to a confirm prompt.
        expect(decision('rm -rf dist')).toBe('nudge');
        expect(decision('rm -fr build')).toBe('nudge');
    });

    it('rmRf_realProjectPath_withEscalationMarker_confirms', () => {
        // Re-running with the escalation marker flips the nudge to a user confirm.
        expect(decision('rm -rf dist  # guardrail:confirm')).toBe('confirm');
        expect(decision('rm -fr build # guardrail:confirm')).toBe('confirm');
    });

    it('findExec_readOnlyCommand_passes', () => {
        expect(decision('find . -name "*.js" -exec grep foo {} ;')).toBe('pass');
        expect(decision('find . -type f -exec cat {} ;')).toBe('pass');
    });

    it('findExec_destructiveCommand_nudges', () => {
        // Destructive find -exec moved confirm→nudge (2026-06-06): try a tighter
        // scope or dry -print first, escalate with the marker when intended.
        expect(decision('find . -exec rm {} ;')).toBe('nudge');
        expect(decision('find /var -name x -exec mv {} /dest ;')).toBe('nudge');
        expect(decision('find . -exec rm {} ;  # guardrail:confirm')).toBe('confirm');
    });

    it('localDestructiveGit_nudges_remoteAndPublish_confirm', () => {
        // Local, reversible destructive git → nudge (stash/backup/dry-run first).
        expect(decision('git reset --hard HEAD~1')).toBe('nudge');
        expect(decision('git clean -fd')).toBe('nudge');
        expect(decision('git rebase main')).toBe('nudge');
        expect(decision('git stash clear')).toBe('nudge');
        expect(decision('npm uninstall -g typescript')).toBe('nudge');
        // Escalation marker flips the nudge to a user confirm.
        expect(decision('git reset --hard HEAD~1  # guardrail:confirm')).toBe('confirm');
        // Outward-facing / irreversible-external → still an immediate confirm.
        expect(decision('git push origin --delete feature')).toBe('confirm');
        expect(decision('npm publish')).toBe('confirm');
    });

    it('gitPushForce_stillBlocked', () => {
        expect(decision('git push --force')).toBe('block');
    });

    it('zeroAccessPath_delete_isHardBlock_notEscalatableViaNudge', () => {
        // sweep A1: `rm -rf .env` matches the nudge rm pattern, but .env is a
        // zeroAccessPath. The path-tier hard block runs BEFORE the nudge/confirm
        // decision, so it wins and IGNORES the escalation marker — a protected
        // secret file can never be escalated to a user-approvable confirm.
        expect(decision('rm -rf .env')).toBe('block');
        expect(decision('rm -rf .env  # guardrail:confirm')).toBe('block');
        expect(decision('rm -rf .env.production')).toBe('block');
    });

    it('dotGit_delete_isHardBlock_evenChainedWithMarker_butGitignoreGithubUnaffected', () => {
        // sweep C-followup: deleting .git destroys all VCS history — catastrophic
        // and irreversible, so it is a zeroAccessPath (non-escalatable hard block).
        // The security audit demonstrated `x && rm -rf .git # guardrail:confirm`
        // downgrading to a user-confirm because .git was never a protected tier.
        expect(decision('rm -rf .git')).toBe('block');
        expect(decision('rm -rf .git  # guardrail:confirm')).toBe('block');
        expect(decision('true && rm -rf .git # guardrail:confirm')).toBe('block');
        // Segment-anchored matching: sibling dot-git paths are NOT elevated to a
        // hard block — they stay escalatable (nudge → confirm) or pass as before.
        expect(decision('rm -rf .gitignore  # guardrail:confirm')).toBe('confirm');
        expect(decision('rm -rf .github/workflows # guardrail:confirm')).toBe('confirm');
    });
});

// ─── Real rules file: rm autonomy exemptions (regression for 2026-06-05 widen) ──
//
// Guards the actual shipped .claude/guardrail-rules.yaml so the temp-path
// exemption that keeps autonomous sub-agents from stalling on `rm -rf` cleanups
// can't silently regress, while real project-path deletes still confirm.
describe('real guardrail-rules.yaml — rm -rf autonomy exemptions', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { fileURLToPath } = require('node:url');
    // fileURLToPath is Windows-safe; new URL(import.meta.url).pathname returns
    // '/C:/...' which path.resolve turns into the bogus 'C:\C:\...'.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const realRules = parseYaml(
        fs.readFileSync(path.resolve(here, '..', '..', 'guardrail-rules.yaml'), 'utf8')
    );
    const act = (cmd) => checkRules(cmd, realRules).action;

    it('allows recursive deletes of clearly-disposable paths (no confirm)', () => {
        for (const cmd of [
            'rm -rf /tmp/install-test-xY',
            'rm -rf /tmp',
            'rm -rf "$TMPDIR/foo"',
            'rm -rf ./tmp/scratch',
            'rm -rf node_modules',
            'rm -rf .sandbox/mfahub',
            'rm -rf /var/folders/ab/cd/T/scratch',
        ]) {
            expect(act(cmd)).toBe('allow');
        }
    });

    it('nudges recursive deletes of real project paths (then confirm on escalation)', () => {
        for (const cmd of [
            'rm -rf ./src',
            'rm -rf /home/user/code/my-project',
            'rm -rf ~/Documents',
            'sudo rm -fr /etc',
        ]) {
            expect(act(cmd)).toBe('nudge');
            // Same command, escalation marker appended → user confirm.
            expect(act(cmd + '  # guardrail:confirm')).toBe('confirm');
        }
    });

    it('nudges dangerous deletes even when an exempt token appears LATER on the line (no whole-line bypass)', () => {
        // Regression for the whole-line-lookahead bypass: a trailing /tmp, a
        // chained safe rm, a node_modules comment, etc. must NOT disarm the guard
        // for a dangerous first target. The exemption binds to the FIRST arg.
        for (const cmd of [
            'rm -rf ~/important && echo /tmp',
            'rm -rf ~/important && echo done; ls /tmp',
            'rm -rf "$HOME" --no-preserve-root; mktemp -d',
            'rm -rf ~/data && npm run build  # node_modules',
            'rm -rf /tmp/a && rm -rf ~/b',          // chained: dangerous 2nd rm
            'rm -rf ~/node_modules_backup_critical', // substring look-alike
            'rm -rf ~/my-tmp/photos',
        ]) {
            expect(act(cmd)).toBe('nudge');
        }
    });

    it('exempts git rm (the history-preserving reversible alternative the nudge recommends)', () => {
        // `git rm` stages a removal that git checkout/restore fully reverses, so
        // it must NOT trip the rm -rf nudge — nudging it would loop the agent
        // against its own advice. (2026-06-06)
        expect(act('git rm -r .claude/skills/orphan')).toBe('allow');
        expect(act('git rm -rf src/legacy')).toBe('allow');
        expect(act('git rm --cached -r build')).toBe('allow');
        // A bare `rm -rf` of the same real path still nudges.
        expect(act('rm -rf .claude/skills/orphan')).toBe('nudge');
    });

    it('nudges PowerShell recursive force-remove in either flag order (sweep A2)', () => {
        // The old `/Remove-Item .+-Recurse .+-Force/` needed ≥1 char BETWEEN the
        // flags, so the canonical single-space form silently PASSed. The fixed
        // pattern matches single-space and reverse flag order.
        expect(act('Remove-Item foo -Recurse -Force')).toBe('nudge');
        expect(act('Remove-Item foo -Force -Recurse')).toBe('nudge');
        expect(act('Remove-Item -Recurse -Force ./build')).toBe('nudge');
        expect(act('Remove-Item foo')).toBe('allow');          // no recurse/force
        expect(act('Remove-Item foo -Recurse')).toBe('allow');  // recurse only
    });

    it('anchors the git rm exemption to a real git invocation (sweep A3)', () => {
        // A standalone `git rm` is exempt; a word ending in "git" (`legit`) or a
        // var-assignment prefix (`X=git`, where git is the value and rm is a real
        // command) is NOT a git invocation, so a real rm still nudges.
        expect(act('git rm -rf src/legacy')).toBe('allow');
        expect(act('cd x && git rm -rf src')).toBe('allow');
        expect(act('legit rm -rf ~/x')).toBe('nudge');
        expect(act('X=git rm -rf ~/x')).toBe('nudge');
    });

    it('still blocks catastrophic commands', () => {
        expect(act('git push --force')).toBe('block');
        expect(act('mkfs.ext4 /dev/sda')).toBe('block');
    });

    // ── B2: build-artifact dirs exempted from the rm nudge (2026-06-21) ──────────
    it('exempts regenerable build-artifact dirs as the rm first arg (B2)', () => {
        // bin/ obj/ dist/ coverage/ TestResults/ — both bare and ./-prefixed.
        // The trailing slash is required (mirrors the \.?\/?tmp\/ exemption form),
        // so these match the lookahead and pass with no nudge.
        for (const cmd of [
            'rm -rf bin/',
            'rm -rf ./bin/',
            'rm -rf obj/',
            'rm -rf ./obj/',
            'rm -rf dist/',
            'rm -rf ./dist/',
            'rm -rf coverage/',
            'rm -rf ./coverage/',
            'rm -rf TestResults/',
            'rm -rf ./TestResults/',
            'rm -rf testresults/',   // case-insensitive match
        ]) {
            expect(act(cmd)).toBe('allow');
        }
    });

    it('still nudges output/vcs/worktree dirs and real project paths (B2 non-exempt)', () => {
        // .output/ and .worktrees/ are deliberately NOT exempt — deleting them
        // destroys generated reports / live worktrees. `dist` WITHOUT a trailing
        // slash is also not exempt (the exemption requires the slash).
        for (const cmd of [
            'rm -rf .output/',
            'rm -rf ./.output/',
            'rm -rf .worktrees/',
            'rm -rf ./src',
            'rm -rf ~',
            'rm -rf dist',          // no trailing slash → not exempt
            'rm -rf binaries/x',    // `bin` substring but not the bin/ dir
        ]) {
            expect(act(cmd)).toBe('nudge');
        }
    });

    it('keeps the build-dir exemption bound to the FIRST arg only (no trailing-token bypass)', () => {
        // A trailing exempt token must NOT disarm the guard for a dangerous
        // first target — the exemption binds to the rm's first argument.
        expect(act('rm -rf ~/important && echo bin/')).toBe('nudge');
        expect(act('rm -rf ~/important && cp -r dist/ /backup')).toBe('nudge');
    });

    // ── B1: narrowed git reset nudge (2026-06-21) ───────────────────────────────
    it('nudges only git reset --hard, not safe non-hard resets (B1)', () => {
        // Only the work-losing --hard variant nudges.
        expect(act('git reset --hard')).toBe('nudge');
        expect(act('git reset --hard HEAD~1')).toBe('nudge');
        // Safe/reversible resets no longer nudge (they never touch the work tree).
        expect(act('git reset -- somefile')).toBe('allow');
        expect(act('git reset --soft HEAD~1')).toBe('allow');
        expect(act('git reset HEAD~1')).toBe('allow');
        expect(act('git reset --mixed HEAD')).toBe('allow');
    });
});

// ─── Guardrail hardening — adversarial bypass regressions ─────────────────────
// Every string below is a documented bypass from the 2026-07-09 security audit /
// hooks code review that used to resolve to the WRONG decision. Mandatory per
// the code-review skill's "security-control changes = bypass-attempt tests" rule.
// These run against the REAL shipped guardrail-rules.yaml, not a fixture.

describe('guardrail hardening — documented bypasses now blocked', () => {
    let originalDir;
    beforeEach(() => {
        originalDir = process.env.CLAUDE_PROJECT_DIR;
        process.env.CLAUDE_PROJECT_DIR = REPO_ROOT;
    });
    afterEach(() => {
        if (originalDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = originalDir;
    });

    const decision = (command) => {
        const r = processEvent({ tool_input: { command } });
        if (r === null) return 'pass';
        if (r.confirm) return 'confirm';
        if (r.block) return r.feedback && r.feedback.includes('SAFER ALTERNATIVE') ? 'nudge' : 'block';
        return '?';
    };

    it('C3 — whitespace-evaded catastrophic commands still block', () => {
        // Double-spaced / tab-separated force-push and format used to ALLOW.
        expect(decision('git  push  --force origin main')).toBe('block');
        expect(decision('git\tpush\t--force')).toBe('block');
        expect(decision('format  c:')).toBe('block');
        // Single-token catastrophic commands never regressed — assert they hold.
        expect(decision('mkfs.ext4 /dev/sda')).toBe('block');
        expect(decision('dd  if=/dev/zero of=/dev/sda')).toBe('block');
        expect(decision('fdisk /dev/sda')).toBe('block');
        expect(decision('diskpart')).toBe('block');
    });

    it('hooks-m1 — git push --force-with-lease is a CONFIRM, not a hard block', () => {
        // Block rule excludes --force-with-lease (negative lookahead), so its
        // confirm rule is now reachable instead of dead code.
        expect(decision('git push --force-with-lease')).toBe('confirm');
        expect(decision('git push --force-with-lease origin main')).toBe('confirm');
        // The plain force push is still a hard block.
        expect(decision('git push --force')).toBe('block');
    });

    it('G1/M1 — chained delete of a zero-access path is a hard block, not confirm', () => {
        // Prefixing any command used to downgrade the non-escalatable .env block
        // to a user-approvable confirm. The four-tier check now scans every
        // segment, so these BLOCK regardless of the escalation marker.
        expect(decision('echo hi && rm -rf .env # guardrail:confirm')).toBe('block');
        expect(decision('true && rm -rf .env # guardrail:confirm')).toBe('block');
        expect(decision('cd /tmp; rm -rf .env')).toBe('block');
        expect(decision('$(rm -rf .env.production)')).toBe('block');
    });

    it('M2/G2 — allowlist-prefix path traversal deletes are hard-blocked', () => {
        // `node_modules/../.git` resolves to PROJECT/.git; `dist/../../etc/...`
        // escapes the project. Both used to ALLOW via the textual prefix.
        expect(decision('rm -rf node_modules/../.git')).toBe('block');
        expect(decision('rm -rf dist/../../../../etc/passwd')).toBe('block');
        expect(decision('rm -rf ./coverage/../.env')).toBe('block');
    });

    it('G3 — alternate deletion verbs against a protected path are blocked', () => {
        // find -delete / truncate / shred / redirection targeting .env used to
        // sidestep the rm-only detection entirely.
        expect(decision('find . -name .env -delete')).toBe('block');
        expect(decision('truncate -s 0 .env')).toBe('block');
        expect(decision('shred .env.production')).toBe('block');
        expect(decision('cat /dev/null > .env')).toBe('block');
        expect(decision(': > .env.local')).toBe('block');
    });

    it('does not over-block benign uses of the same verbs', () => {
        // Only PROTECTED targets escalate to a hard block — ordinary redirects,
        // finds and truncations of non-protected paths stay out of the way.
        expect(decision('echo hi > README.md')).toBe('pass');
        expect(decision('node app.js 2>&1')).toBe('pass');
        // `find … -delete` carries a general nudge (escalatable) on ANY target.
        expect(decision('find . -name "*.log" -delete')).toBe('nudge');
        // truncate/shred/redirect are checked ONLY against protected tiers — a
        // non-protected target is a clean pass, no blanket nudge noise.
        expect(decision('truncate -s 0 build/output.txt')).toBe('pass');
    });
});
