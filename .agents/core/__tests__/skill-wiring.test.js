// Live structural-wiring invariants for the .claude/ skill system.
//
// Unlike skill-conformance.test.js (which exercises the checker's logic against
// fixtures), THIS suite asserts the REAL repo tree is internally consistent. It
// guards the failure modes a skill rename/fold introduces — the exact risk
// surface of the 2026-06-06 skill-consolidation refactor (project-context +
// epic-writer folded into project-planning; architecture-writer→architecture,
// article-writer→ghostwriting, writing-skills→skill-authoring, ux-designer
// skill→ux-design):
//
//   1. Every SKILL_TEMPLATE_MANIFEST `from:` points to a real asset on disk.
//      (A rename that forgets to repoint the manifest silently stops scaffolding
//      that doc — this is the same class as the .gitignore template-match bug.)
//   2. Every agent `skills:` frontmatter entry resolves to a real skill dir.
//      (The orphan-skill-ref failure mode — see memory
//      reconcile-agent-skills-after-template-sync.)
//   3. The live skills tree has zero ERROR-severity conformance findings
//      (name == directory). A rename that misses the `name:` field is caught.
//   4. The consolidation shape holds: folded/renamed dirs are gone, the new
//      homes exist, and project-planning owns the consolidated assets+guidance.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .agents/core/__tests__ → repo root
const REPO_ROOT = path.resolve(__dirname, '../../../.agents/core', '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, '.claude', 'skills');
const AGENTS_ROOT = path.join(REPO_ROOT, '.claude', 'agents');

const { SKILL_TEMPLATE_MANIFEST } = require('../../../.agents/core/scaffold');
const { scanAll } = require('../../../.agents/core/skill-conformance');

/** Parse the `skills:` YAML list from an agent markdown's frontmatter. */
function parseAgentSkills(content) {
    const lines = content.split('\n');
    const skills = [];
    let inList = false;
    for (const line of lines) {
        if (/^skills:\s*$/.test(line)) {
            inList = true;
            continue;
        }
        if (inList) {
            const m = line.match(/^\s*-\s*(\S+)\s*$/);
            if (m) {
                skills.push(m[1]);
            } else {
                break; // first non-list line ends the block
            }
        }
    }
    return skills;
}

// ---------------------------------------------------------------------------
// 1. Manifest integrity — every from: path exists
// ---------------------------------------------------------------------------

describe('SKILL_TEMPLATE_MANIFEST — live integrity', () => {
    it('has at least one entry', () => {
        expect(SKILL_TEMPLATE_MANIFEST.length).toBeGreaterThan(0);
    });

    it.each(SKILL_TEMPLATE_MANIFEST)(
        'source asset exists on disk: $from',
        ({ from }) => {
            const abs = path.join(REPO_ROOT, from);
            expect(fs.existsSync(abs), `manifest from: "${from}" does not exist`).toBe(true);
        },
    );

    it('every from: lives under a real skill directory', () => {
        for (const { from } of SKILL_TEMPLATE_MANIFEST) {
            const m = from.match(/^\.claude\/skills\/([^/]+)\//);
            expect(m, `from: "${from}" is not under .claude/skills/<skill>/`).not.toBeNull();
            const skillDir = path.join(SKILLS_ROOT, m[1], 'SKILL.md');
            expect(fs.existsSync(skillDir), `owning skill "${m[1]}" missing SKILL.md`).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// 2. Agent skills: frontmatter resolves to real skill dirs
// ---------------------------------------------------------------------------

describe('agent skills: frontmatter — live resolution', () => {
    const agentFiles = fs
        .readdirSync(AGENTS_ROOT)
        .filter((f) => f.endsWith('.md'))
        .map((f) => ({ file: f, skills: parseAgentSkills(fs.readFileSync(path.join(AGENTS_ROOT, f), 'utf8')) }));

    it('found agent definitions', () => {
        expect(agentFiles.length).toBeGreaterThan(0);
    });

    it.each(agentFiles)('$file: every skill resolves to a real skill dir', ({ file, skills }) => {
        for (const skill of skills) {
            const skillMd = path.join(SKILLS_ROOT, skill, 'SKILL.md');
            expect(
                fs.existsSync(skillMd),
                `${file} references skill "${skill}" but .claude/skills/${skill}/SKILL.md does not exist`,
            ).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// 3. Live conformance — no name/dir mismatches (or any ERROR finding)
// ---------------------------------------------------------------------------

describe('live skill conformance', () => {
    it('the real skills tree has zero ERROR-severity findings (name == dir, desc ≤ 1024)', () => {
        const findings = scanAll(SKILLS_ROOT).filter((f) => f.severity === 'ERROR');
        expect(findings, findings.map((f) => f.message).join('\n')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 4. Consolidation shape (2026-06-06 refactor)
// ---------------------------------------------------------------------------

describe('skill-consolidation shape', () => {
    const GONE = ['project-context', 'epic-writer', 'architecture-writer', 'article-writer', 'writing-skills', 'ux-designer', 'system-builder'];
    const PRESENT = ['project-planning', 'architecture', 'ghostwriting', 'skill-authoring', 'ux-design', 'skill-creator', 'agent-creator', 'command-creator'];

    it.each(GONE)('folded/renamed skill dir no longer exists: %s', (dir) => {
        expect(fs.existsSync(path.join(SKILLS_ROOT, dir)), `stale skill dir "${dir}" still present`).toBe(false);
    });

    it.each(PRESENT)('consolidated/renamed skill exists: %s', (dir) => {
        expect(fs.existsSync(path.join(SKILLS_ROOT, dir, 'SKILL.md'))).toBe(true);
    });

    it('project-planning owns the folded-in assets', () => {
        const assets = path.join(SKILLS_ROOT, 'project-planning', 'assets');
        expect(fs.existsSync(path.join(assets, 'context.md'))).toBe(true);
        expect(fs.existsSync(path.join(assets, 'backlog.md'))).toBe(true);
    });

    it('project-planning owns the folded-in guidance references', () => {
        const refs = path.join(SKILLS_ROOT, 'project-planning', 'references');
        expect(fs.existsSync(path.join(refs, 'project-context.md'))).toBe(true);
        expect(fs.existsSync(path.join(refs, 'backlog.md'))).toBe(true);
    });

    it('every canonical skill ships through the Claude projection', () => {
        const dirs = fs
            .readdirSync(SKILLS_ROOT, { withFileTypes: true })
            .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_ROOT, d.name, 'SKILL.md')));
        const canonical = fs.readdirSync(path.join(REPO_ROOT, '.agents/skills'), { withFileTypes: true }).filter(d => d.isDirectory() && fs.existsSync(path.join(REPO_ROOT, '.agents/skills', d.name, 'SKILL.md')));
        expect(dirs.map(d => d.name).sort()).toEqual(canonical.map(d => d.name).sort());
    });
});
