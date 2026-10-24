import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// NOTE: These tests assert the checker LOGIC against synthetic fixtures only.
// They intentionally do NOT scan the live .claude/skills tree — at the wave
// this checker is introduced, real skills are still over budget, and asserting
// live state would fail the gate before the cleanup wave lands.

describe('skill-conformance', () => {
    it('loads without side effects and exports helpers', () => {
        const m = require('../../../.agents/core/skill-conformance');
        expect(m).toBeDefined();
        expect(typeof m.countLines).toBe('function');
        expect(typeof m.parseField).toBe('function');
        expect(typeof m.extractFrontmatter).toBe('function');
        expect(typeof m.checkBody).toBe('function');
        expect(typeof m.checkName).toBe('function');
        expect(typeof m.checkDescription).toBe('function');
        expect(typeof m.evaluateSkill).toBe('function');
        expect(typeof m.scanAll).toBe('function');
    });

    it('countLines matches wc -l semantics (counts newline characters)', () => {
        // N1: wc -l counts NEWLINES, so an unterminated final line is not counted.
        // `printf 'a\nb\nc' | wc -l` → 2; `printf 'a\nb\nc\n' | wc -l` → 3. The old
        // split/pop form over-counted the no-trailing-newline case by one.
        const { countLines } = require('../../../.agents/core/skill-conformance');
        expect(countLines('')).toBe(0);
        expect(countLines('a\nb\nc')).toBe(2);       // no trailing newline → 2 newlines
        expect(countLines('a\nb\nc\n')).toBe(3);     // trailing newline → 3 newlines
        expect(countLines('a\n'.repeat(600))).toBe(600);
    });

    it('checkBody WARNs over budget, clean at or under', () => {
        const { checkBody } = require('../../../.agents/core/skill-conformance');
        expect(checkBody(600)).toMatchObject({ severity: 'WARN', code: 'OVER_BUDGET', value: 600 });
        expect(checkBody(501)).toMatchObject({ severity: 'WARN', code: 'OVER_BUDGET' });
        expect(checkBody(500)).toBeNull(); // exactly at budget is clean (> 500 triggers)
        expect(checkBody(400)).toBeNull();
    });

    it('checkName ERRORs when name does not match the directory', () => {
        const { checkName } = require('../../../.agents/core/skill-conformance');
        expect(checkName('wrong-name', 'my-skill')).toMatchObject({ severity: 'ERROR', code: 'NAME_MISMATCH' });
        expect(checkName('my-skill', 'my-skill')).toBeNull();
        expect(checkName(null, 'my-skill')).toMatchObject({ severity: 'ERROR', code: 'NAME_MISMATCH' });
    });

    it('checkDescription ERRORs above 1024 characters', () => {
        const { checkDescription } = require('../../../.agents/core/skill-conformance');
        expect(checkDescription('x'.repeat(1100))).toMatchObject({ severity: 'ERROR', code: 'DESC_TOO_LONG', value: 1100 });
        expect(checkDescription('x'.repeat(1025))).toMatchObject({ severity: 'ERROR', code: 'DESC_TOO_LONG' });
        expect(checkDescription('x'.repeat(1024))).toBeNull(); // exactly at ceiling is clean
        expect(checkDescription('x'.repeat(900))).toBeNull();
        expect(checkDescription(null)).toBeNull();
    });

    it('parseField extracts and unquotes single-line frontmatter values', () => {
        const { parseField } = require('../../../.agents/core/skill-conformance');
        const fm = '---\nname: my-skill\ndescription: "Use WHEN foo. Triggers: a, b"\nuser-invocable: false\n---';
        expect(parseField(fm, 'name')).toBe('my-skill');
        expect(parseField(fm, 'description')).toBe('Use WHEN foo. Triggers: a, b');
        expect(parseField(fm, 'missing')).toBeNull();
    });

    it('extractFrontmatter returns only the fenced block', () => {
        const { extractFrontmatter } = require('../../../.agents/core/skill-conformance');
        const content = '---\nname: x\n---\n\n# Body\nlots of text\n';
        expect(extractFrontmatter(content)).toBe('---\nname: x\n---');
        expect(extractFrontmatter('# No frontmatter\ntext')).toBe('');
    });

    it('evaluateSkill aggregates all three findings on a bad fixture', () => {
        const { evaluateSkill } = require('../../../.agents/core/skill-conformance');
        const findings = evaluateSkill({
            dir: 'big-skill',
            name: 'mismatched',
            description: 'x'.repeat(1100),
            lineCount: 600,
        });
        const codes = findings.map((f) => f.code).sort();
        expect(codes).toEqual(['DESC_TOO_LONG', 'NAME_MISMATCH', 'OVER_BUDGET']);
        // severities: body is the soft one
        expect(findings.find((f) => f.code === 'OVER_BUDGET').severity).toBe('WARN');
        expect(findings.find((f) => f.code === 'NAME_MISMATCH').severity).toBe('ERROR');
    });

    it('evaluateSkill returns no findings for a conforming fixture', () => {
        const { evaluateSkill } = require('../../../.agents/core/skill-conformance');
        const findings = evaluateSkill({
            dir: 'good-skill',
            name: 'good-skill',
            description: 'Use WHEN doing the thing.',
            lineCount: 120,
        });
        expect(findings).toEqual([]);
    });

    it('evaluateSkill WARN message uses the AC-specified format', () => {
        const { evaluateSkill } = require('../../../.agents/core/skill-conformance');
        const [finding] = evaluateSkill({
            dir: 'tailwind-css-patterns',
            name: 'tailwind-css-patterns',
            description: 'Use WHEN styling.',
            lineCount: 877,
        });
        expect(finding.message).toBe('tailwind-css-patterns: 877 lines (budget 500)');
    });
});
