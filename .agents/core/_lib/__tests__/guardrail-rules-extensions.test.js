import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

/**
 * Tests for P2.5 guardrail extensions — four-tier YAML schema (A3),
 * hand-rolled schema validation at load time (D1), and checkPathAccess (A3).
 */

function writeYaml(tmpRoot, content) {
    const yamlPath = path.join(tmpRoot, 'rules.yaml');
    fs.writeFileSync(yamlPath, content);
    return yamlPath;
}

describe('guardrail-rules P2.5 extensions', () => {
    let tmpRoot;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-ext-'));
    });

    afterEach(() => {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ── loadRules: schema validation (D1) ───────────────────────────────────────

    it('loadRules_validFourTierSchema_returnsAllTiers', () => {
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        // Minimal parser does NOT support YAML flow sequences `[]`, so
        // "empty" arrays must be expressed as key-with-no-children.
        const yamlPath = writeYaml(tmpRoot, [
            'block_patterns:',
            '  - rm -rf',
            'confirm_patterns:',
            'dangerousPatterns:',
            '  - "^format c:"',
            'zeroAccessPaths:',
            '  - .env',
            'readOnlyPaths:',
            '  - .eslintrc.json',
            'noDeletePaths:',
            '  - .githooks/',
            '',
        ].join('\n'));
        const rules = loadRules(yamlPath);
        expect(Array.isArray(rules.dangerousPatterns)).toBe(true);
        expect(rules.dangerousPatterns).toContain('^format c:');
        expect(rules.zeroAccessPaths).toContain('.env');
        expect(rules.readOnlyPaths).toContain('.eslintrc.json');
        expect(rules.noDeletePaths).toContain('.githooks/');
    });

    it('loadRules_missingTierKeys_defaultsEmptyArrays', () => {
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        const yamlPath = writeYaml(tmpRoot, 'block_patterns:\n  - rm -rf\nconfirm_patterns:\n');
        const rules = loadRules(yamlPath);
        // Backward-compat: the four new tier keys should be empty arrays if absent.
        expect(rules.dangerousPatterns).toEqual([]);
        expect(rules.zeroAccessPaths).toEqual([]);
        expect(rules.readOnlyPaths).toEqual([]);
        expect(rules.noDeletePaths).toEqual([]);
    });

    it('loadRules_tierFieldWrongType_failsSafeToEmptyRules', () => {
        // D1 fail-safe: if schema validation fails, guardrail falls back to
        // block-all defaults — NOT pass-through. Verify by checking that an
        // invalid schema returns an empty-tier rules object.
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        const yamlPath = writeYaml(tmpRoot, [
            'block_patterns: not-an-array',
            'confirm_patterns: []',
            '',
        ].join('\n'));
        const rules = loadRules(yamlPath);
        // The loader previously handled this case by returning emptyRules();
        // four-tier extension continues that behavior.
        expect(rules.block_patterns).toEqual([]);
        expect(rules.confirm_patterns).toEqual([]);
        expect(rules.dangerousPatterns).toEqual([]);
    });

    it('loadRules_invalidRegexInDangerousPatterns_returnsEmptyTierList', () => {
        // D1: dangerousPatterns entries should be valid RegExp sources.
        // A malformed regex invalidates the schema → fail-safe.
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        const yamlPath = writeYaml(tmpRoot, [
            'block_patterns: []',
            'confirm_patterns: []',
            'dangerousPatterns:',
            '  - "([malformed"',
            '',
        ].join('\n'));
        const rules = loadRules(yamlPath);
        // Schema fails validation → dangerousPatterns falls back to []
        expect(rules.dangerousPatterns).toEqual([]);
    });

    // ── F12: block_patterns/nudge_patterns/confirm_patterns regex validation ────
    // The YAML header documents that all four pattern tiers support the
    // `/regex/` form, and evaluate()/matchesPattern() treat all four
    // identically at match time — but loadRules() previously validated ONLY
    // dangerousPatterns as regex sources. A malformed `/regex/` in block/
    // nudge/confirm silently became a no-op (a broken block pattern = a hole).
    // These tests pin the fix: malformed regex → per-tier fail-safe (drop to
    // []) + a loud stderr warning — never a silent no-op.

    it('loadRules_malformedRegexInBlockPatterns_dropsTierAndWarnsLoudly', () => {
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const yamlPath = writeYaml(tmpRoot, [
            'block_patterns:',
            '  - "/(/"',
            'confirm_patterns:',
            '  - "git push --force"',
            '',
        ].join('\n'));

        const rules = loadRules(yamlPath);

        // Malformed regex drops ONLY the block_patterns tier (per-tier
        // fail-safe, matching dangerousPatterns) — never a silent no-op that
        // just lets the bad pattern quietly match nothing while looking valid.
        expect(rules.block_patterns).toEqual([]);
        // Other tiers are unaffected — this is a per-tier, not a global, failure.
        expect(rules.confirm_patterns).toContain('git push --force');
        // Non-silent: a warning was written to stderr (console.error) naming
        // the offending tier.
        expect(warnSpy).toHaveBeenCalled();
        const warned = warnSpy.mock.calls.some(args => args.join(' ').includes('block_patterns'));
        expect(warned).toBe(true);

        warnSpy.mockRestore();
    });

    it('loadRules_malformedRegexInNudgePatterns_dropsTierAndWarnsLoudly', () => {
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const yamlPath = writeYaml(tmpRoot, [
            'block_patterns:',
            '  - rm -rf /',
            'nudge_patterns:',
            '  - "/[invalid/"',
            '',
        ].join('\n'));

        const rules = loadRules(yamlPath);

        expect(rules.nudge_patterns).toEqual([]);
        expect(rules.block_patterns).toContain('rm -rf /');
        expect(warnSpy).toHaveBeenCalled();
        const warned = warnSpy.mock.calls.some(args => args.join(' ').includes('nudge_patterns'));
        expect(warned).toBe(true);

        warnSpy.mockRestore();
    });

    it('loadRules_malformedRegexInConfirmPatterns_dropsTierAndWarnsLoudly', () => {
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const yamlPath = writeYaml(tmpRoot, [
            'confirm_patterns:',
            '  - "/(unterminated"',
            'block_patterns:',
            '  - format c:',
            '',
        ].join('\n'));

        const rules = loadRules(yamlPath);

        expect(rules.confirm_patterns).toEqual([]);
        expect(rules.block_patterns).toContain('format c:');
        expect(warnSpy).toHaveBeenCalled();
        const warned = warnSpy.mock.calls.some(args => args.join(' ').includes('confirm_patterns'));
        expect(warned).toBe(true);

        warnSpy.mockRestore();
    });

    it('loadRules_validRegexAndPlainStringPatterns_allTiersStillWork', () => {
        // Regression: plain-string (non-`/…/`) patterns and valid `/regex/`
        // patterns must keep working across all four tiers after adding
        // regex-source validation to block/nudge/confirm.
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        const yamlPath = writeYaml(tmpRoot, [
            'block_patterns:',
            '  - format c:',
            '  - "/git.+--force/"',
            'nudge_patterns:',
            '  - git reset --hard',
            'confirm_patterns:',
            '  - npm publish',
            'dangerousPatterns:',
            '  - "^format c:"',
            '',
        ].join('\n'));

        const rules = loadRules(yamlPath);

        expect(rules.block_patterns).toContain('format c:');
        expect(rules.block_patterns).toContain('/git.+--force/');
        expect(rules.nudge_patterns).toContain('git reset --hard');
        expect(rules.confirm_patterns).toContain('npm publish');
        expect(rules.dangerousPatterns).toContain('^format c:');
    });

    it('loadRules_malformedRegexInDangerousPatterns_alsoWarnsLoudly', () => {
        // dangerousPatterns already had per-tier fail-safe (drop to []); the
        // fix adds the same loud stderr warning there for consistency.
        const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
        const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const yamlPath = writeYaml(tmpRoot, [
            'dangerousPatterns:',
            '  - "([malformed"',
            '',
        ].join('\n'));

        const rules = loadRules(yamlPath);

        expect(rules.dangerousPatterns).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
        const warned = warnSpy.mock.calls.some(args => args.join(' ').includes('dangerousPatterns'));
        expect(warned).toBe(true);

        warnSpy.mockRestore();
    });

    // ── checkPathAccess (A3) ────────────────────────────────────────────────────

    it('checkPathAccess_zeroAccessTierMatch_blocksRead', () => {
        const { checkPathAccess } = require('../../../../.agents/core/_lib/guardrail-rules');
        const rules = {
            block_patterns: [], confirm_patterns: [],
            dangerousPatterns: [], zeroAccessPaths: ['.env'], readOnlyPaths: [], noDeletePaths: [],
        };
        const result = checkPathAccess('/repo/.env', 'read', rules);
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('zeroAccessPaths');
        expect(result.reason).toMatch(/zero.access/i);
    });

    it('checkPathAccess_readOnlyTierAllowsReadBlocksWrite', () => {
        const { checkPathAccess } = require('../../../../.agents/core/_lib/guardrail-rules');
        const rules = {
            block_patterns: [], confirm_patterns: [],
            dangerousPatterns: [], zeroAccessPaths: [], readOnlyPaths: ['package-lock.json'], noDeletePaths: [],
        };
        expect(checkPathAccess('/repo/package-lock.json', 'read', rules).allowed).toBe(true);
        const wr = checkPathAccess('/repo/package-lock.json', 'write', rules);
        expect(wr.allowed).toBe(false);
        expect(wr.tier).toBe('readOnlyPaths');
    });

    it('checkPathAccess_noDeleteTierAllowsWriteBlocksDelete', () => {
        const { checkPathAccess } = require('../../../../.agents/core/_lib/guardrail-rules');
        const rules = {
            block_patterns: [], confirm_patterns: [],
            dangerousPatterns: [], zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: ['.githooks/'],
        };
        expect(checkPathAccess('/repo/.githooks/pre-commit', 'write', rules).allowed).toBe(true);
        const del = checkPathAccess('/repo/.githooks/pre-commit', 'delete', rules);
        expect(del.allowed).toBe(false);
        expect(del.tier).toBe('noDeletePaths');
    });

    it('checkPathAccess_pathNotMatchingAnyTier_allowsAllOps', () => {
        const { checkPathAccess } = require('../../../../.agents/core/_lib/guardrail-rules');
        const rules = {
            block_patterns: [], confirm_patterns: [],
            dangerousPatterns: [], zeroAccessPaths: ['.env'], readOnlyPaths: [], noDeletePaths: [],
        };
        expect(checkPathAccess('/repo/src/app.ts', 'read', rules).allowed).toBe(true);
        expect(checkPathAccess('/repo/src/app.ts', 'write', rules).allowed).toBe(true);
        expect(checkPathAccess('/repo/src/app.ts', 'delete', rules).allowed).toBe(true);
    });

    it('checkPathAccess_zeroAccessTakesPrecedenceOverReadOnly', () => {
        const { checkPathAccess } = require('../../../../.agents/core/_lib/guardrail-rules');
        const rules = {
            block_patterns: [], confirm_patterns: [],
            dangerousPatterns: [],
            zeroAccessPaths: ['.env'],
            readOnlyPaths: ['.env'],   // conflicting — zero-access wins
            noDeletePaths: [],
        };
        const result = checkPathAccess('/repo/.env', 'read', rules);
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('zeroAccessPaths');
    });

    // ── dangerousPatterns integration (A3 — bash-level) ──────────────────────────

    it('evaluate_dangerousPatternMatch_returnsBlockDecision', () => {
        const { evaluate } = require('../../../../.agents/core/_lib/guardrail-rules');
        const rules = {
            block_patterns: [],
            confirm_patterns: [],
            dangerousPatterns: ['format c:'],
            zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: [],
        };
        const result = evaluate('format c: /q', rules);
        expect(result.decision).toBe('block');
    });

    it('evaluate_dangerousPatternWithRegex_matchesVariants', () => {
        const { evaluate } = require('../../../../.agents/core/_lib/guardrail-rules');
        // Pattern format: /regex/ — matchesPattern applies the `i` flag,
        // so do NOT append a trailing `i` flag in the pattern string itself.
        const rules = {
            block_patterns: [],
            confirm_patterns: [],
            dangerousPatterns: ['/^\\s*dd if=\\/dev\\/random/'],
            zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: [],
        };
        expect(evaluate('dd if=/dev/random of=/dev/sda', rules).decision).toBe('block');
        expect(evaluate('echo "hello"', rules).decision).toBe('pass');
    });
});

// ── SF-1.8: subagentReadOnlyPaths tier ───────────────────────────────────────
//
// AC→test map (docs/TODO_software-factory.md, Story SF-1.8):
//   AC1 tier in loader/validation/emptyRules ........ 'SF-1.8 subagentReadOnlyPaths — loader and validation'
//   AC1 checkPathAccess 4th arg {agentId, agentType}  'SF-1.8 checkPathAccess — agent context'
//   AC3 each shipped entry matches its intended path  'SF-1.8 shipped subagentReadOnlyPaths entries — globMatchesPath'
//   AC1 override union / except lift .............. see guardrail-rules.test.js 'SF-1.8 project override — subagentReadOnlyPaths'
//   AC2/AC4 hook behaviour ........................ see hooks/__tests__/path-guardrail.test.js

describe('SF-1.8 subagentReadOnlyPaths — loader and validation', () => {
    const { loadRules } = require('../../../../.agents/core/_lib/guardrail-rules');
    let root;

    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf18-loader-')); });
    afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

    const write = (text) => {
        const p = path.join(root, 'rules.yaml');
        fs.writeFileSync(p, text);
        return p;
    };

    it('loadRules_validYamlWithTier_returnsTheEntriesInOrder', () => {
        const rules = loadRules(write('subagentReadOnlyPaths:\n  - .agents/hooks/\n  - gate.config.json\n'));
        expect(rules.subagentReadOnlyPaths).toEqual(['.agents/hooks/', 'gate.config.json']);
    });

    it('loadRules_tierKeyAbsent_defaultsToAnEmptyArray', () => {
        const rules = loadRules(write('block_patterns:\n  - rm -rf\n'));
        expect(rules.subagentReadOnlyPaths).toEqual([]);
    });

    it('loadRules_tierKeyWithNoChildren_isCoercedToAnEmptyArrayNotAFailSafeReset', () => {
        // The minimal YAML parser reads a childless key as {}; an empty tier must not
        // invalidate the whole ruleset (sibling tiers keep their entries).
        const rules = loadRules(write('zeroAccessPaths:\n  - secrets.txt\nsubagentReadOnlyPaths:\n'));
        expect(rules.subagentReadOnlyPaths).toEqual([]);
        expect(rules.zeroAccessPaths).toEqual(['secrets.txt']);
    });

    it('loadRules_missingFile_returnsEmptySubagentTier', () => {
        const rules = loadRules(path.join(root, 'nope.yaml'));
        expect(rules.subagentReadOnlyPaths).toEqual([]);
    });

    it('loadRules_malformedYaml_returnsEmptySubagentTierNotUndefined', () => {
        const rules = loadRules(write(': not yaml at all\n'));
        expect(rules.subagentReadOnlyPaths).toEqual([]);
    });

    it.each([
        ['a scalar', 'subagentReadOnlyPaths: .agents/hooks/\n'],
        ['a non-empty mapping', 'subagentReadOnlyPaths:\n  key: value\n'],
    ])('loadRules_tierIs_%s_failsSafeToEmptyRulesLikeTheSiblingPathTiers', (_label, tierYaml) => {
        const rules = loadRules(write('zeroAccessPaths:\n  - secrets.txt\n' + tierYaml));
        expect(rules.subagentReadOnlyPaths).toEqual([]);
        // Sibling string tiers fail-safe to emptyRules() as a whole; the new tier joins them.
        expect(rules.zeroAccessPaths).toEqual([]);
    });
});

describe('SF-1.8 checkPathAccess — agent context', () => {
    const { checkPathAccess } = require('../../../../.agents/core/_lib/guardrail-rules');
    const rules = () => ({
        block_patterns: [], nudge_patterns: [], confirm_patterns: [], dangerousPatterns: [],
        zeroAccessPaths: [], readOnlyPaths: ['.eslintrc*'], noDeletePaths: [],
        subagentReadOnlyPaths: ['.agents/core/gate.js', '.agents/hooks/'],
    });
    const GATE = '/repo/.agents/core/gate.js';

    it.each(['write', 'delete', 'read'])('checkPathAccess_noFourthArgument_%s_onATierPathIsAllowedExactlyAsToday', (op) => {
        expect(checkPathAccess(GATE, op, rules())).toEqual({ allowed: true });
    });

    it.each([
        ['an empty context', {}],
        ['an agentType alone (the main thread can carry one)', { agentType: 'implementer' }],
        ['an explicit undefined agentId', { agentId: undefined, agentType: 'implementer' }],
    ])('checkPathAccess_%s_isNotASubagent_andTheTierPathStaysAllowed', (_label, ctx) => {
        expect(checkPathAccess(GATE, 'write', rules(), ctx)).toEqual({ allowed: true });
    });

    it('checkPathAccess_subagentWriteToATierPath_isBlockedWithTierAndMatchedGlob', () => {
        const result = checkPathAccess(GATE, 'write', rules(), { agentId: 'agent-1', agentType: 'implementer' });
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('subagentReadOnlyPaths');
        expect(result.reason).toContain('.agents/core/gate.js');
    });

    it('checkPathAccess_subagentDeleteOfATierPath_isBlocked', () => {
        const result = checkPathAccess('/repo/.agents/hooks/path-guardrail.cjs', 'delete', rules(), { agentId: 'agent-1' });
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('subagentReadOnlyPaths');
    });

    it('checkPathAccess_subagentReadOfATierPath_isAllowed_theTierIsWriteOnly', () => {
        expect(checkPathAccess(GATE, 'read', rules(), { agentId: 'agent-1' })).toEqual({ allowed: true });
    });

    it.each([
        ['empty string', ''],
        ['zero', 0],
        ['a number', 123],
        ['an empty object', {}],
        ['an empty array', []],
        ['false', false],
        ['a normal id', 'agent-abc'],
    ])('checkPathAccess_agentIdIs_%s_countsAsASubagent', (_label, agentId) => {
        const result = checkPathAccess(GATE, 'write', rules(), { agentId });
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('subagentReadOnlyPaths');
    });

    it('checkPathAccess_subagentWriteToAnUnlistedPath_isAllowed', () => {
        expect(checkPathAccess('/repo/src/app.js', 'write', rules(), { agentId: 'agent-1' })).toEqual({ allowed: true });
    });

    it('checkPathAccess_rulesObjectWithoutTheTierKey_subagentIsAllowedAndNothingThrows', () => {
        const legacy = rules();
        delete legacy.subagentReadOnlyPaths;
        expect(checkPathAccess(GATE, 'write', legacy, { agentId: 'agent-1' })).toEqual({ allowed: true });
    });

    it('checkPathAccess_existingReadOnlyTier_blocksASubagentWithTheExistingTier', () => {
        const result = checkPathAccess('/repo/.eslintrc.json', 'write', rules(), { agentId: 'agent-1' });
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('readOnlyPaths');
    });

    it('checkPathAccess_existingReadOnlyTier_blocksTheMainThreadToo_unchangedByTheNewTier', () => {
        const result = checkPathAccess('/repo/.eslintrc.json', 'write', rules());
        expect(result.allowed).toBe(false);
        expect(result.tier).toBe('readOnlyPaths');
    });
});

describe('SF-1.8 shipped subagentReadOnlyPaths entries — globMatchesPath', () => {
    const { loadRules, globMatchesPath } = require('../../../../.agents/core/_lib/guardrail-rules');
    // .agents/core/_lib → .agents → config/guardrail-rules.yaml (the authored shipped file)
    const SHIPPED_YAML = path.resolve(path.dirname(require.resolve('../../../../.agents/core/_lib/guardrail-rules')), '..', '..', 'config', 'guardrail-rules.yaml');

    // [shipped entry, a path it is intended to protect]
    const INTENDED = [
        ['gate.config.json', '/repo/gate.config.json'],
        ['gate.config.json', '/repo/.claude/gate.config.json'],
        ['.agents/core/gate.js', '/repo/.agents/core/gate.js'],
        ['.agents/core/_lib/gate-receipt.js', '/repo/.agents/core/_lib/gate-receipt.js'],
        ['.agents/core/_lib/failure-ledger.js', '/repo/.agents/core/_lib/failure-ledger.js'],
        ['.agents/core/_lib/freeze-state.js', '/repo/.agents/core/_lib/freeze-state.js'],
        ['.agents/core/_lib/guardrail-rules.js', '/repo/.agents/core/_lib/guardrail-rules.js'],
        ['.agents/core/ac-verify.js', '/repo/.agents/core/ac-verify.js'],
        ['.agents/core/ship-check.js', '/repo/.agents/core/ship-check.js'],
        ['.agents/core/commit.js', '/repo/.agents/core/commit.js'],
        ['.agents/core/todo-completion.js', '/repo/.agents/core/todo-completion.js'],
        ['.agents/hooks/', '/repo/.agents/hooks/path-guardrail.cjs'],
        ['.agents/hooks/', '/repo/.agents/hooks/__tests__/path-guardrail.test.js'],
        ['.claude/hooks/', '/repo/.claude/hooks/path-guardrail.cjs'],
        ['.codex/hooks/', '/repo/.codex/hooks/path-guardrail.cjs'],
        ['.agents/config/guardrail-rules.yaml', '/repo/.agents/config/guardrail-rules.yaml'],
        ['guardrail-rules.yaml', '/repo/.claude/guardrail-rules.yaml'],
        ['.agents/adapters/claude/settings.json', '/repo/.agents/adapters/claude/settings.json'],
        ['.claude/settings.json', '/repo/.claude/settings.json'],
        ['docs/.output/.state/telemetry/ac-verify/', '/repo/docs/.output/.state/telemetry/ac-verify/SF-1.8.json'],
        ['docs/.output/.state/telemetry/ac-verify/', '/repo/docs/.output/.state/telemetry/ac-verify/SF-1.8.freeze.json'],
        ['docs/.output/.state/telemetry/ship-seal.json', '/repo/docs/.output/.state/telemetry/ship-seal.json'],
        // review C1/J-1: the require() closure of the hooks and the judges
        ['.agents/core/story-checkpoint.js', '/repo/.agents/core/story-checkpoint.js'],
        ['.agents/core/plan-check.js', '/repo/.agents/core/plan-check.js'],
        ['.agents/core/release-slice.js', '/repo/.agents/core/release-slice.js'],
        ['.agents/core/runtime-context.js', '/repo/.agents/core/runtime-context.js'],
        ['.agents/core/git-hooks.js', '/repo/.agents/core/git-hooks.js'],
        ['.agents/core/build-lock-recovery.js', '/repo/.agents/core/build-lock-recovery.js'],
        ['.agents/core/_lib/attribution-ledger.js', '/repo/.agents/core/_lib/attribution-ledger.js'],
        ['.agents/core/_lib/command-blocker.js', '/repo/.agents/core/_lib/command-blocker.js'],
        ['.agents/core/_lib/fs-safe.js', '/repo/.agents/core/_lib/fs-safe.js'],
        ['.agents/core/_lib/gate-summary.js', '/repo/.agents/core/_lib/gate-summary.js'],
        ['.agents/core/_lib/git-hook-protocol.js', '/repo/.agents/core/_lib/git-hook-protocol.js'],
        ['.agents/core/_lib/git.js', '/repo/.agents/core/_lib/git.js'],
        ['.agents/core/_lib/hook-input.js', '/repo/.agents/core/_lib/hook-input.js'],
        ['.agents/core/_lib/hook-telemetry.js', '/repo/.agents/core/_lib/hook-telemetry.js'],
        ['.agents/core/_lib/jsonl-writer.js', '/repo/.agents/core/_lib/jsonl-writer.js'],
        ['.agents/core/_lib/owned-process-tree.js', '/repo/.agents/core/_lib/owned-process-tree.js'],
        ['.agents/core/_lib/project-root.js', '/repo/.agents/core/_lib/project-root.js'],
        ['.agents/core/_lib/run-pointer.js', '/repo/.agents/core/_lib/run-pointer.js'],
        ['.agents/core/_lib/secret-engine-bin.js', '/repo/.agents/core/_lib/secret-engine-bin.js'],
        ['.agents/core/_lib/shell-command-split.js', '/repo/.agents/core/_lib/shell-command-split.js'],
        ['.agents/core/_lib/telemetry-paths.js', '/repo/.agents/core/_lib/telemetry-paths.js'],
        ['.agents/core/_lib/yaml-parser.js', '/repo/.agents/core/_lib/yaml-parser.js'],
        // review M3: hook registration and transport files
        ['.claude/settings.local.json', '/repo/.claude/settings.local.json'],
        ['.agents/adapters/codex/', '/repo/.agents/adapters/codex/hooks.js'],
        ['.agents/adapters/codex/', '/repo/.agents/adapters/codex/hooks-config.json'],
        ['.codex/hooks.json', '/repo/.codex/hooks.json'],
        ['.codex/hook-identities.json', '/repo/.codex/hook-identities.json'],
        // review M4: the judge's state files
        ['docs/.output/.state/freeze-state.json', '/repo/docs/.output/.state/freeze-state.json'],
        ['docs/.output/.state/telemetry/gate-failures.jsonl', '/repo/docs/.output/.state/telemetry/gate-failures.jsonl'],
        ['docs/.output/.state/telemetry/gate-receipt.json', '/repo/docs/.output/.state/telemetry/gate-receipt.json'],
        ['docs/.output/.state/telemetry/gate-receipts/', '/repo/docs/.output/.state/telemetry/gate-receipts/abc123.json'],
        ['docs/.output/.state/telemetry/gate-receipts/', '/repo/docs/.output/.state/telemetry/gate-receipts/by-id/SF-1.8.json'],
        // review M5: the gate's command inputs (the real test-config path is the ROOT vitest.config.mjs)
        ['vitest.config.mjs', '/repo/vitest.config.mjs'],
        ['tools/run-toolkit-tests.cjs', '/repo/tools/run-toolkit-tests.cjs'],
    ];

    it.each(INTENDED)('globMatchesPath_shippedEntry_%s_matches_%s', (entry, target) => {
        expect(globMatchesPath(entry, target)).toBe(true);
    });

    it.each([...new Set(INTENDED.map(([entry]) => entry))])('shippedYaml_subagentReadOnlyPaths_lists_%s', (entry) => {
        const rules = loadRules(SHIPPED_YAML);
        expect(rules.subagentReadOnlyPaths).toContain(entry);
    });

    it('shippedYaml_subagentReadOnlyPaths_hasNoDuplicateEntries', () => {
        const list = loadRules(SHIPPED_YAML).subagentReadOnlyPaths;
        expect(list.length).toBeGreaterThan(0);
        expect(new Set(list).size).toBe(list.length);
    });

    it('globMatchesPath_generatedSettingsEntry_doesNotMatchTheAuthoredAdapterSettings', () => {
        expect(globMatchesPath('.claude/settings.json', '/repo/.agents/adapters/claude/settings.json')).toBe(false);
    });

    it('globMatchesPath_hooksDirectoryEntry_doesNotMatchTheGateScript', () => {
        expect(globMatchesPath('.agents/hooks/', '/repo/.agents/core/gate.js')).toBe(false);
    });

    it.each([
        '/repo/src/app.js',
        '/repo/.agents/core/gate-signal.js',
        '/repo/.agents/core/__tests__/gate.test.js',
        '/repo/.agents/skills/qa-engineer/SKILL.md',
        '/repo/.agents/core/_lib/improvement-scope.js',
        '/repo/.agents/core/__tests__/gate.test.js',
        '/repo/docs/.output/.state/telemetry/gate-signal.json',
        '/repo/docs/TODO_software-factory.md',
    ])('shippedYaml_subagentReadOnlyPaths_matchesNoneOf_%s', (target) => {
        const list = loadRules(SHIPPED_YAML).subagentReadOnlyPaths;
        expect(list.length).toBeGreaterThan(0);
        expect(list.filter((glob) => globMatchesPath(glob, target))).toEqual([]);
    });
});

// ── SF-1.8 review: closure, state-file, gate-input, fold and keyless-rules regressions ─────────────

describe('SF-1.8 review C1/J-1 — built-in defaults', () => {
    const { loadRules, BUILTIN_SUBAGENT_READ_ONLY_PATHS, applySubagentDefaults } = require('../../../../.agents/core/_lib/guardrail-rules');
    const SHIPPED_YAML = path.resolve(path.dirname(require.resolve('../../../../.agents/core/_lib/guardrail-rules')), '..', '..', 'config', 'guardrail-rules.yaml');

    it('builtInDefaults_areFrozenSoAHookCannotMutateTheSharedList', () => {
        expect(Object.isFrozen(BUILTIN_SUBAGENT_READ_ONLY_PATHS)).toBe(true);
    });

    it('builtInDefaults_equalTheShippedYamlTierInContentAndOrder', () => {
        expect([...BUILTIN_SUBAGENT_READ_ONLY_PATHS]).toEqual(loadRules(SHIPPED_YAML).subagentReadOnlyPaths);
    });

    it('applySubagentDefaults_returnsACopyThatTheCallerMayMutateWithoutTouchingTheFrozenList', () => {
        const held = applySubagentDefaults({ rulesParsed: false });

        held.subagentReadOnlyPaths.push('x');

        expect(BUILTIN_SUBAGENT_READ_ONLY_PATHS).not.toContain('x');
    });
});

describe('SF-1.8 review m4 — a rules file that parses but lacks the tier key', () => {
    const { loadRules, applySubagentDefaults, BUILTIN_SUBAGENT_READ_ONLY_PATHS } = require('../../../../.agents/core/_lib/guardrail-rules');
    let tmpRoot;
    beforeEach(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrail-m4-')); });
    afterEach(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } });
    const write = (content) => writeYaml(tmpRoot, content);

    it('loadRules_parsedFileWithoutTheTierKey_isNotMarkedAsCarryingTheSubagentWall', () => {
        const rules = loadRules(write('zeroAccessPaths:\n  - secrets.txt\n'));

        expect(rules.rulesParsed).not.toBe(true);
        expect(rules.zeroAccessPaths).toEqual(['secrets.txt']);
    });

    it('loadRules_tierKeyPresentButEmpty_isMarkedParsed_aDeliberateLift', () => {
        expect(loadRules(write('zeroAccessPaths:\n  - secrets.txt\nsubagentReadOnlyPaths:\n')).rulesParsed).toBe(true);
    });

    it('loadRules_tierKeyPresentAndOverrideLiftsEveryEntry_isStillMarkedParsed', () => {
        const yamlPath = write('subagentReadOnlyPaths:\n  - .agents/core/gate.js\n');
        fs.writeFileSync(path.join(tmpRoot, 'rules.project.yaml'), 'except:\n  subagentReadOnlyPaths:\n    - .agents/core/gate.js\n');

        const rules = loadRules(yamlPath);

        expect(rules.rulesParsed).toBe(true);
        expect(rules.subagentReadOnlyPaths).toEqual([]);
    });

    it('applySubagentDefaults_unmarkedRules_getTheBuiltInTierAndKeepEveryOtherTier', () => {
        const rules = loadRules(write('zeroAccessPaths:\n  - secrets.txt\n'));

        const held = applySubagentDefaults(rules);

        expect(held.subagentReadOnlyPaths).toEqual([...BUILTIN_SUBAGENT_READ_ONLY_PATHS]);
        expect(held.zeroAccessPaths).toEqual(['secrets.txt']);
    });

    it('applySubagentDefaults_markedRules_areReturnedUnchanged_theSameObject', () => {
        const rules = loadRules(write('subagentReadOnlyPaths:\n  - infra/deploy.sh\n'));

        expect(applySubagentDefaults(rules)).toBe(rules);
    });

    it('applySubagentDefaults_nullAndUndefinedRules_stillYieldTheBuiltInTier', () => {
        expect(applySubagentDefaults(null).subagentReadOnlyPaths).toEqual([...BUILTIN_SUBAGENT_READ_ONLY_PATHS]);
        expect(applySubagentDefaults(undefined).subagentReadOnlyPaths).toEqual([...BUILTIN_SUBAGENT_READ_ONLY_PATHS]);
    });
});

describe('SF-1.8 review m2 — Windows spellings and case folding in globMatchesPath', () => {
    const { globMatchesPath } = require('../../../../.agents/core/_lib/guardrail-rules');

    it.each([
        ['a backslash path with a drive letter', 'C:\\work\\proj\\.agents\\core\\gate.js'],
        ['a mixed-separator path', 'C:/work\\proj/.agents\\core/gate.js'],
        ['an extended-length path', '\\\\?\\C:\\work\\proj\\.agents\\core\\gate.js'],
        ['a forward-slash extended-length path', '//?/C:/work/proj/.agents/core/gate.js'],
        ['a UNC path', '\\\\server\\share\\proj\\.agents\\core\\gate.js'],
        ['a different drive letter and upper-cased directories', 'D:\\PROJ\\.AGENTS\\CORE\\GATE.JS'],
        ['a lower-case drive letter', 'c:\\proj\\.agents\\core\\gate.js'],
    ])('globMatchesPath_gateEntry_matches_%s', (_label, target) => {
        expect(globMatchesPath('.agents/core/gate.js', target)).toBe(true);
    });

    it.each([
        ['a backslash directory path', 'C:\\proj\\.agents\\hooks\\new-hook.cjs'],
        ['an extended-length directory path', '\\\\?\\C:\\proj\\.agents\\hooks\\__tests__\\x.test.js'],
    ])('globMatchesPath_hooksDirectoryEntry_matches_%s', (_label, target) => {
        expect(globMatchesPath('.agents/hooks/', target)).toBe(true);
    });

    it('globMatchesPath_backslashEntryAndForwardSlashPath_match', () => {
        expect(globMatchesPath('.agents\\core\\gate.js', '/proj/.agents/core/gate.js')).toBe(true);
    });

    it.each([
        ['long s U+017F, which NTFS upcases to S', '/proj/.claude/\u017Fettings.json', '.claude/settings.json'],
        ['long s in a directory entry', '/proj/.agents/hook\u017F/x.cjs', '.agents/hooks/'],
        ['Kelvin sign U+212A, which lower-cases to k', '/proj/.agents/hoo\u212As/x.cjs', '.agents/hooks/'],
    ])('globMatchesPath_foldsNtfsCaseEquivalents_%s', (_label, target, entry) => {
        expect(globMatchesPath(entry, target)).toBe(true);
    });

    it('globMatchesPath_foldDoesNotMakeAnUnrelatedNameMatch', () => {
        expect(globMatchesPath('.claude/settings.json', '/proj/.claude/settings.jsx')).toBe(false);
        expect(globMatchesPath('.agents/hooks/', '/proj/.agents/hookless/x.cjs')).toBe(false);
    });

    it('globMatchesPath_plainEntryIsAnUnanchoredSuffixMatch_documentedAsDenyListOnly', () => {
        // n2: harmless for a deny list; the yaml comment says never reuse the matcher for an allow list.
        expect(globMatchesPath('gate.config.json', '/proj/x-gate.config.json')).toBe(true);
    });
});
