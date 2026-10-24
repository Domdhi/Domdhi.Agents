// Frontmatter skill-resolution checker — unit logic + live-tree invariant.
//
// Two layers, same shape as operating-standard.test.js + skill-conformance.test.js:
//   1. Unit tests exercise the PURE evaluator (evaluateAgentSkillRefs +
//      isModelInvocationDisabled) against synthetic input — no fs, deterministic.
//   2. A live-tree assertion runs scanAll() over the REAL .claude/agents +
//      .claude/skills trees and demands zero findings. This is the teeth: if
//      anyone lists a skill in an agent's frontmatter that doesn't exist (typo,
//      renamed/removed skill) or sets disable-model-invocation, CI goes red —
//      catching the SILENT preload-loads-nothing failure mode that eager
//      frontmatter injection hides (no Read event fires).
//
// Guards the 2026-06-20 finding: subagent `skills:` is eager full-body injection
// (Claude Code native, sub-agents.md), so a broken ref produces no runtime error
// and no telemetry signal — only this checker surfaces it.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .agents/core/__tests__ → repo root
const REPO_ROOT = path.resolve(__dirname, '../../../.agents/core', '..', '..');
const AGENTS_ROOT = path.join(REPO_ROOT, '.claude', 'agents');
const SKILLS_ROOT = path.join(REPO_ROOT, '.claude', 'skills');

const {
    isModelInvocationDisabled,
    evaluateAgentSkillRefs,
    buildSkillIndex,
    scanAll,
} = require('../../../.agents/core/skill-resolution');

// ---------------------------------------------------------------------------
// 1. isModelInvocationDisabled — frontmatter boolean
// ---------------------------------------------------------------------------

describe('isModelInvocationDisabled', () => {
    it('true when the field is exactly true', () => {
        expect(isModelInvocationDisabled('---\ndisable-model-invocation: true\n---')).toBe(true);
    });

    it('case-insensitive on the value', () => {
        expect(isModelInvocationDisabled('---\ndisable-model-invocation: TRUE\n---')).toBe(true);
    });

    it('false when absent', () => {
        expect(isModelInvocationDisabled('---\nname: x\n---')).toBe(false);
    });

    it('false when explicitly false', () => {
        expect(isModelInvocationDisabled('---\ndisable-model-invocation: false\n---')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 2. evaluateAgentSkillRefs — the pure rule engine
// ---------------------------------------------------------------------------

describe('evaluateAgentSkillRefs', () => {
    const index = {
        good: { exists: true, disabled: false },
        gone: { exists: false, disabled: false },
        off: { exists: true, disabled: true },
    };

    it('passes when every listed skill resolves and is preloadable', () => {
        expect(evaluateAgentSkillRefs({ agent: 'a', skills: ['good'], skillIndex: index })).toEqual([]);
    });

    it('flags a skill with no directory as BROKEN_SKILL_REF', () => {
        const f = evaluateAgentSkillRefs({ agent: 'a', skills: ['gone'], skillIndex: index });
        expect(f).toHaveLength(1);
        expect(f[0].code).toBe('BROKEN_SKILL_REF');
        expect(f[0].skill).toBe('gone');
    });

    it('flags a skill not present in the index at all as BROKEN_SKILL_REF', () => {
        const f = evaluateAgentSkillRefs({ agent: 'a', skills: ['never-heard-of-it'], skillIndex: index });
        expect(f).toHaveLength(1);
        expect(f[0].code).toBe('BROKEN_SKILL_REF');
    });

    it('flags a disable-model-invocation skill as UNPRELOADABLE', () => {
        const f = evaluateAgentSkillRefs({ agent: 'a', skills: ['off'], skillIndex: index });
        expect(f).toHaveLength(1);
        expect(f[0].code).toBe('UNPRELOADABLE');
    });

    it('reports one finding per offending skill, in order', () => {
        const f = evaluateAgentSkillRefs({ agent: 'a', skills: ['good', 'gone', 'off'], skillIndex: index });
        expect(f.map((x) => x.code)).toEqual(['BROKEN_SKILL_REF', 'UNPRELOADABLE']);
    });

    it('handles an empty / missing skills list', () => {
        expect(evaluateAgentSkillRefs({ agent: 'a', skills: [], skillIndex: index })).toEqual([]);
        expect(evaluateAgentSkillRefs({ agent: 'a', skills: undefined, skillIndex: index })).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 3. Live tree — the resolution invariant
// ---------------------------------------------------------------------------

describe('buildSkillIndex — symlinked skill dirs', () => {
    it('counts a symlinked skill dir (bespoke-skill shape) and guards broken links', () => {
        // Adopter bespoke skills are frequently symlinks into ../.agents/skills/ —
        // Dirent.isDirectory() is false for symlinks (same class as skill-conformance.js).
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-res-'));
        try {
            const skillsRoot = path.join(tmp, 'skills');
            fs.mkdirSync(path.join(skillsRoot, 'real-skill'), { recursive: true });
            fs.writeFileSync(path.join(skillsRoot, 'real-skill', 'SKILL.md'), '---\nname: real-skill\n---\n');
            const linkTarget = path.join(tmp, 'agents-skills', 'linked-skill');
            fs.mkdirSync(linkTarget, { recursive: true });
            fs.writeFileSync(path.join(linkTarget, 'SKILL.md'), '---\nname: linked-skill\n---\n');
            fs.symlinkSync(linkTarget, path.join(skillsRoot, 'linked-skill'), 'dir');
            fs.symlinkSync(path.join(tmp, 'nonexistent'), path.join(skillsRoot, 'broken-link'), 'dir');

            const idx = buildSkillIndex(skillsRoot);
            expect(idx['real-skill']).toEqual({ exists: true, disabled: false });
            expect(idx['linked-skill']).toEqual({ exists: true, disabled: false }); // the fix
            expect(idx['broken-link']).toBeUndefined(); // broken symlink guarded out
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe('live trees', () => {
    it('builds a non-empty skill index from the real skills tree', () => {
        const idx = buildSkillIndex(SKILLS_ROOT);
        expect(Object.keys(idx).length).toBeGreaterThan(0);
        // every present skill dir with a SKILL.md is marked exists:true
        expect(idx['verification-before-completion']).toEqual({ exists: true, disabled: false });
    });

    it('every agent frontmatter skill resolves to a real, preloadable skill (zero findings)', () => {
        const findings = scanAll(AGENTS_ROOT, SKILLS_ROOT);
        expect(findings, findings.map((f) => f.message).join('\n')).toEqual([]);
    });
});
