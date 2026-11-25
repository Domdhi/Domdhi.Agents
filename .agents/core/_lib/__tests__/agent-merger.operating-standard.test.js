// Regression: `## Operating Standard` was lost on adopter refresh (`template-updater --merge`).
// Five canonical roles carried it in the soul zone (before `## Skills`). A personalized
// adopter keeps its own soul zone, so the section was never delivered; an adopter that
// re-added it after the template-owned sections lost it on the next refresh, because the
// skills zone is taken wholesale from the template. The section now lives in the
// template-owned skills zone, and a stale copy in a preserved soul zone is dropped.
// The check: `operating-standard.js` passes on every merged acting/report-only role.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { parseAgentSections, mergeAgentContent } = require('../../../../.agents/core/_lib/agent-merger');
const { scanAll, EXEMPT } = require('../../../../.agents/core/operating-standard');

const ROLES_DIR = path.resolve(__dirname, '../../../roles');
// operating-standard.js scans the rendered native roles (they carry disallowedTools).
const NATIVE_DIR = path.resolve(__dirname, '../../../../.claude/agents');
const HEADING = /^## Operating Standard\s*$/gm;

const roles = fs.readdirSync(ROLES_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .filter((name) => !EXEMPT.includes(name));

/** An adopter copy of `srcContent`: personalized soul, an older skills zone, Project Context. */
function adopterCopy(srcContent, { soulExtra = '', dropFromSkills = true } = {}) {
    const src = parseAgentSections(srcContent);
    const frontmatter = src.frontmatter.replace(/^name:.*$/m, (line) => `${line}\nnickname: Testy`);
    let skillsZone = src.skillsZone;
    if (dropFromSkills) skillsZone = skillsZone.replace(/## Operating Standard\n\n[^\n]*\n\n/, '');
    return `---\n${frontmatter}\n---\n\n# Testy\n\nA project-tuned persona.\n${soulExtra}\n${skillsZone}\n\n## Project Context\n\nProject facts.\n`;
}

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'agent-merger-opstd-' }); });
afterEach(() => { tmp.cleanup(); });

describe('Operating Standard survives a merged adopter refresh', () => {
    it('finds the roles under test', () => {
        expect(roles.length).toBeGreaterThan(5);
    });

    it.each(roles)('%s: canonical role carries the section in the template-owned skills zone', (name) => {
        const src = parseAgentSections(fs.readFileSync(path.join(ROLES_DIR, `${name}.md`), 'utf8'));
        expect(src.skillsZone).toMatch(HEADING);
        expect(src.soulZone).not.toMatch(HEADING);
    });

    it.each(roles)('%s: a personalized adopter without the section gets it, and operating-standard passes', (name) => {
        const srcContent = fs.readFileSync(path.join(NATIVE_DIR, `${name}.md`), 'utf8');
        const { content } = mergeAgentContent(srcContent, adopterCopy(srcContent), { retiredRoleContent: {} });

        expect(content.match(HEADING)).toHaveLength(1);
        expect(content).toContain('A project-tuned persona.');
        expect(content).toContain('Project facts.');
        fs.writeFileSync(path.join(tmp.root, `${name}.md`), content);
        expect(scanAll(tmp.root).filter((f) => f.agent === name)).toEqual([]);
    });

    it.each(roles)('%s: a template copy in a preserved soul zone is dropped, not duplicated', (name) => {
        const srcContent = fs.readFileSync(path.join(ROLES_DIR, `${name}.md`), 'utf8');
        const body = /## Operating Standard\n\n([^\n]+)/.exec(srcContent)[1];
        const dest = adopterCopy(srcContent, { soulExtra: `\n## Operating Standard\n\n${body}\n\n## Persona Notes\n\nKept.\n` });
        const { content } = mergeAgentContent(srcContent, dest, { retiredRoleContent: {} });

        expect(content.match(HEADING)).toHaveLength(1);
        expect(content).not.toContain('(project notes)');
        expect(content).toContain('## Persona Notes\n\nKept.');
    });

    it.each(roles)('%s: adopter text under a stale heading is kept as project notes', (name) => {
        const srcContent = fs.readFileSync(path.join(ROLES_DIR, `${name}.md`), 'utf8');
        const dest = adopterCopy(srcContent, { soulExtra: '\n## Operating Standard\n\nAn adopter-written rule.\n' });
        const { content } = mergeAgentContent(srcContent, dest, { retiredRoleContent: {} });

        expect(content.match(HEADING)).toHaveLength(1);
        expect(content).toContain('## Operating Standard (project notes)\n\nAn adopter-written rule.');
    });
});
