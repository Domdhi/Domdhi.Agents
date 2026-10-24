// Operating-standard enforcement — unit logic + live-tree invariant.
//
// Two layers, same shape as skill-conformance.test.js + skill-wiring.test.js:
//   1. Unit tests exercise the PURE evaluator (evaluateAgent/classifyRole/
//      parsers) against synthetic input — no fs, deterministic.
//   2. A live-tree assertion runs scanAll() over the REAL .claude/agents tree
//      and demands zero ERROR findings. This is the teeth: if anyone drops the
//      `## Operating Standard` section or the verification-before-completion
//      skill from an acting agent, CI goes red. Mirrors the "live conformance"
//      block in skill-wiring.test.js.
//
// Guards the 2026-06-20 doctrine-enforcement work (mission statement →
// enforced through the three tiers).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .agents/core/__tests__ → repo root
const REPO_ROOT = path.resolve(__dirname, '../../../.agents/core', '..', '..');
const AGENTS_ROOT = path.join(REPO_ROOT, '.claude', 'agents');

const {
    STANDARD_SKILL,
    resolveAnchorSkill,
    extractFrontmatter,
    parseScalar,
    parseCsvField,
    parseSkills,
    classifyRole,
    evaluateAgent,
    scanAll,
} = require('../../../.agents/core/operating-standard');

// ---------------------------------------------------------------------------
// 1. Frontmatter parsing
// ---------------------------------------------------------------------------

describe('frontmatter parsing', () => {
    const fm = extractFrontmatter(
        ['---', 'name: code-reviewer', 'tools: Read, Grep, Glob, Bash, Write', 'disallowedTools: Edit', 'skills:', '  - code-review', '  - verification-before-completion', 'memory: project', '---', '', '# Body'].join('\n'),
    );

    it('extracts the frontmatter block only', () => {
        expect(fm).toContain('name: code-reviewer');
        expect(fm).not.toContain('# Body');
    });

    it('parses a scalar field', () => {
        expect(parseScalar(fm, 'name')).toBe('code-reviewer');
    });

    it('parses a CSV field (disallowedTools)', () => {
        expect(parseCsvField(fm, 'disallowedTools')).toEqual(['Edit']);
    });

    it('returns [] for a missing CSV field', () => {
        expect(parseCsvField(fm, 'nope')).toEqual([]);
    });

    it('parses the skills list block', () => {
        expect(parseSkills(fm)).toEqual(['code-review', 'verification-before-completion']);
    });

    it('handles CRLF line endings (Windows checkout)', () => {
        const crlf = extractFrontmatter('---\r\nname: architect\r\n---\r\n# Body');
        expect(parseScalar(crlf, 'name')).toBe('architect');
    });
});

// ---------------------------------------------------------------------------
// 2. Role classification
// ---------------------------------------------------------------------------

describe('classifyRole', () => {
    it('report-only when disallowedTools includes Edit', () => {
        expect(classifyRole({ name: 'code-reviewer', disallowedTools: ['Edit'] })).toBe('report-only');
    });

    it('exempt for shadow regardless of tools', () => {
        expect(classifyRole({ name: 'shadow', disallowedTools: [] })).toBe('exempt');
    });

    it('acting otherwise', () => {
        expect(classifyRole({ name: 'general-purpose', disallowedTools: [] })).toBe('acting');
    });
});

// ---------------------------------------------------------------------------
// 3. evaluateAgent — the pure rule engine
// ---------------------------------------------------------------------------

describe('evaluateAgent', () => {
    it('passes a correct acting agent (skill + section)', () => {
        expect(
            evaluateAgent({ name: 'general-purpose', disallowedTools: [], skills: [STANDARD_SKILL, 'systematic-debugging'], hasSection: true }),
        ).toEqual([]);
    });

    it('flags an acting agent missing the skill', () => {
        const f = evaluateAgent({ name: 'architect', disallowedTools: [], skills: ['architecture'], hasSection: true });
        expect(f).toHaveLength(1);
        expect(f[0].code).toBe('MISSING_SKILL');
    });

    it('flags an acting agent missing the section', () => {
        const f = evaluateAgent({ name: 'architect', disallowedTools: [], skills: ['architecture', STANDARD_SKILL], hasSection: false });
        expect(f).toHaveLength(1);
        expect(f[0].code).toBe('MISSING_SECTION');
    });

    it('flags both when an acting agent has neither', () => {
        const f = evaluateAgent({ name: 'architect', disallowedTools: [], skills: ['architecture'], hasSection: false });
        expect(f.map((x) => x.code).sort()).toEqual(['MISSING_SECTION', 'MISSING_SKILL']);
    });

    it('passes a report-only agent with the section and WITHOUT the skill', () => {
        // report-only roles must NOT be required to load the skill (that would
        // imply they write fixes — they don't).
        expect(
            evaluateAgent({ name: 'code-reviewer', disallowedTools: ['Edit'], skills: ['code-review'], hasSection: true }),
        ).toEqual([]);
    });

    it('flags a report-only agent missing the section', () => {
        const f = evaluateAgent({ name: 'security-auditor', disallowedTools: ['Edit'], skills: ['code-review'], hasSection: false });
        expect(f).toHaveLength(1);
        expect(f[0].code).toBe('MISSING_SECTION');
    });

    it('exempts shadow entirely (no section, no skill, no findings)', () => {
        expect(
            evaluateAgent({ name: 'shadow', disallowedTools: [], skills: ['ghostwriting'], hasSection: false }),
        ).toEqual([]);
    });

    it('respects a custom anchorSkill (adopter that consolidated the skill)', () => {
        // Domdhi.Agents-shaped: anchor is `dev-process`, NOT verification-before-completion.
        const ok = evaluateAgent({ name: 'architect', disallowedTools: [], skills: ['architecture', 'dev-process'], hasSection: true, anchorSkill: 'dev-process' });
        expect(ok).toEqual([]);

        const bad = evaluateAgent({ name: 'architect', disallowedTools: [], skills: ['architecture', STANDARD_SKILL], hasSection: true, anchorSkill: 'dev-process' });
        expect(bad).toHaveLength(1);
        expect(bad[0].code).toBe('MISSING_SKILL');
        expect(bad[0].message).toContain('dev-process');
    });
});

// ---------------------------------------------------------------------------
// 3b. resolveAnchorSkill — adopter config
// ---------------------------------------------------------------------------

describe('resolveAnchorSkill', () => {
    it('defaults to the workshop skill when no update-config.json exists', () => {
        // REPO_ROOT (the workshop) ships no update-config.json.
        expect(resolveAnchorSkill(REPO_ROOT)).toBe(STANDARD_SKILL);
    });

    it('defaults when the project dir is bogus', () => {
        expect(resolveAnchorSkill(path.join(REPO_ROOT, 'no-such-dir'))).toBe(STANDARD_SKILL);
    });

    it('accepts an explicit fallback', () => {
        expect(resolveAnchorSkill(path.join(REPO_ROOT, 'no-such-dir'), 'dev-process')).toBe('dev-process');
    });
});

// ---------------------------------------------------------------------------
// 4. Live tree — the enforcement invariant
// ---------------------------------------------------------------------------

describe('live agents tree', () => {
    it('found agent definitions', () => {
        const count = fs.readdirSync(AGENTS_ROOT).filter((f) => f.endsWith('.md')).length;
        expect(count).toBeGreaterThan(0);
    });

    it('every agent enforces the operating standard (zero ERROR findings)', () => {
        const findings = scanAll(AGENTS_ROOT);
        expect(findings, findings.map((f) => f.message).join('\n')).toEqual([]);
    });

    it('the two report-only agents carry the report-only section', () => {
        // sanity: code-reviewer + security-auditor are the disallowedTools:Edit set
        const reportOnly = fs
            .readdirSync(AGENTS_ROOT)
            .filter((f) => f.endsWith('.md'))
            .filter((f) => /^disallowedTools:.*\bEdit\b/m.test(fs.readFileSync(path.join(AGENTS_ROOT, f), 'utf8')))
            .map((f) => f.replace(/\.md$/, ''))
            .sort();
        expect(reportOnly).toEqual(['code-reviewer', 'security-auditor']);
    });
});
