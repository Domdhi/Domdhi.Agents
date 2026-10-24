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
