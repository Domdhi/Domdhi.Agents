// AC→source map (SP-1.1 / skill-profiles):
//   resolveSelection — no profile = today's behaviour; profile + skillInclude - skillExclude; roles from the profile;
//                      unknown profile is an error; renamed skills map; bespoke names never excluded
//   findDanglingReferences — every name form, optional "if installed" lines, role frontmatter/strip, self-reference
//   suggestClosure — transitive callers

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const fs = require('node:fs');
const path = require('node:path');
const { resolveSelection, findDanglingReferences, suggestClosure, loadProfiles, formatDangling, checkSelectionClosure } = require('../skill-profiles');

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'skill-profiles-test-' }); });
afterEach(() => { tmp.cleanup(); });

const SKILLS = ['do', 'end', 'sweep', 'review-qa', 'review-code-review', 'create-new-project', 'intake', 'helper-skill'];
const ROLES = ['shadow', 'qa-engineer', 'security-auditor'];

function toolkit({ skillFiles = {}, roleFiles = {}, profiles } = {}) {
    tmp.write('.agents/adapters/skill-profiles.json', JSON.stringify({
        profiles: profiles || {
            app: { skills: SKILLS, roles: ROLES },
            lean: { skills: ['do', 'end', 'helper-skill'], roles: ['shadow'] },
        },
    }));
    tmp.write('.agents/adapters/workflows.json', JSON.stringify({
        do: '.claude/commands/do.md',
        end: '.claude/commands/end.md',
        sweep: '.claude/commands/sweep.md',
        'review-qa': '.claude/commands/review/qa.md',
        'review-code-review': '.claude/commands/review/code-review.md',
        'create-new-project': '.claude/commands/create/new-project.md',
    }));
    for (const s of SKILLS) tmp.write(`.agents/skills/${s}/SKILL.md`, skillFiles[s] ?? `---\nname: ${s}\ndescription: test\n---\n\n# ${s}\n`);
    for (const [rel, text] of Object.entries(skillFiles)) if (rel.includes('/')) tmp.write(`.agents/skills/${rel}`, text);
    for (const r of ROLES) tmp.write(`.agents/roles/${r}.md`, roleFiles[r] ?? `---\nname: ${r}\n---\n\n# ${r}\n`);
    return tmp.root;
}

function dangling(root, config) {
    const sel = resolveSelection({ toolkitRoot: root, config });
    return findDanglingReferences({ root, keptSkills: sel.keptSkills, keptRoles: sel.keptRoles, droppedSkills: sel.excludedSkills, universe: sel.universe.skills });
}

describe('resolveSelection', () => {
    it('keeps every toolkit skill and role minus skillExclude when no profile is set', () => {
        const root = toolkit();
        const sel = resolveSelection({ toolkitRoot: root, config: { skillExclude: ['sweep'] } });
        expect([...sel.excludedSkills]).toEqual(['sweep']);
        expect(sel.keptSkills.has('sweep')).toBe(false);
        expect(sel.keptSkills.size).toBe(SKILLS.length - 1);
        expect(sel.excludedRoles.size).toBe(0);
        expect(sel.keptRoles.size).toBe(ROLES.length);
        expect(sel.errors).toEqual([]);
    });

    it('computes profile + skillInclude - skillExclude and the profile roles', () => {
        const root = toolkit();
        const sel = resolveSelection({ toolkitRoot: root, config: { skillProfile: 'lean', skillInclude: ['review-qa'], skillExclude: ['helper-skill'] } });
        expect([...sel.keptSkills].sort()).toEqual(['do', 'end', 'review-qa']);
        expect([...sel.excludedSkills].sort()).toEqual(['create-new-project', 'helper-skill', 'intake', 'review-code-review', 'sweep']);
        expect([...sel.keptRoles]).toEqual(['shadow']);
        expect([...sel.excludedRoles].sort()).toEqual(['qa-engineer', 'security-auditor']);
    });

    it('reports an unknown profile name as an error naming the value and the known profiles', () => {
        const root = toolkit();
        const sel = resolveSelection({ toolkitRoot: root, config: { skillProfile: 'nope' } });
        expect(sel.errors).toEqual(['unknown skillProfile "nope" (known profiles: app, lean)']);
    });

    it('warns (does not fail) on a skillInclude or skillExclude name outside the toolkit', () => {
        const root = toolkit();
        const sel = resolveSelection({ toolkitRoot: root, config: { skillProfile: 'lean', skillInclude: ['bespoke'], skillExclude: ['gone'] } });
        expect(sel.errors).toEqual([]);
        expect(sel.warnings).toEqual([
            'skillInclude names "bespoke", which is not a toolkit skill',
            'skillExclude names "gone", which is not a toolkit skill',
        ]);
    });

    it('maps a renamed skill to its new name in skillExclude and skillInclude', () => {
        const root = toolkit();
        expect(resolveSelection({ toolkitRoot: root, config: { skillExclude: ['learning-intake'] } }).excludedSkills.has('intake')).toBe(true);
        expect(resolveSelection({ toolkitRoot: root, config: { skillProfile: 'lean', skillInclude: ['learning-intake'] } }).keptSkills.has('intake')).toBe(true);
    });

    it('never excludes a project-bespoke skill or role that is in no profile', () => {
        const root = toolkit();
        tmp.write('.agents/skills/react-patterns/SKILL.md', '# bespoke');
        tmp.write('.agents/roles/db-architect.md', '---\nname: db-architect\n---\n');
        const sel = resolveSelection({ toolkitRoot: root, config: { skillProfile: 'lean' } });
        expect(sel.excludedSkills.has('react-patterns')).toBe(false);
        expect(sel.excludedRoles.has('db-architect')).toBe(false);
    });

    it('rejects a malformed profile', () => {
        const root = toolkit({ profiles: { bad: { skills: 'do' } } });
        expect(() => loadProfiles(root)).toThrow(/profile "bad" must list "skills" and "roles"/);
        expect(resolveSelection({ toolkitRoot: root, config: { skillProfile: 'bad' } }).errors[0]).toMatch(/must list/);
    });
});

describe('findDanglingReferences', () => {
    it('finds the hyphenated, slash, path and colon forms', () => {
        const root = toolkit({ skillFiles: {
            do: [
                'Then run review-qa for tests.',
                'Then run /sweep.',
                'Read .claude/skills/review-code-review/SKILL.md.',
                'Finish with `/review:qa`.',
                'Or /create:new-project.',
            ].join('\n'),
        } });
        const refs = dangling(root, { skillProfile: 'lean' });
        expect(refs.map(r => [r.line, r.target, r.form])).toEqual([
            [1, 'review-qa', 'name'],
            [2, 'sweep', 'slash'],
            [3, 'review-code-review', 'name'],
            [4, 'review-qa', 'colon'],
            [5, 'create-new-project', 'colon'],
        ]);
        expect(refs[0]).toMatchObject({ caller: 'skill:do', file: '.agents/skills/do/SKILL.md' });
    });

    it('does not mistake paths, longer names or plain words for a slash invocation', () => {
        const root = toolkit({ skillFiles: {
            do: [
                'See docs/work/sweep/notes.md and https://example.com/sweep.',
                'The review-qa-extended skill and pre-review-qa step.',
                'We sweep the floor.',
            ].join('\n'),
        } });
        expect(dangling(root, { skillProfile: 'lean' })).toEqual([]);
    });

    it('treats a line with "if installed" or "when installed" as optional', () => {
        const root = toolkit({ skillFiles: {
            do: 'Run `/review:qa` if installed.\nUse /sweep when installed.\nRun /sweep.',
        } });
        expect(dangling(root, { skillProfile: 'lean' }).map(r => r.line)).toEqual([3]);
    });

    it('makes only the invocation nearest an "if installed" marker optional', () => {
        const root = toolkit({ skillFiles: {
            do: [
                'Run /end now, then /sweep if installed.',
                'Run /sweep now, then /review:qa if installed.',
                'If installed, chain `/review:qa` as the last step.',
                'The stub says "Run `/sweep`" (literal text, matched if installed or not).',
            ].join('\n'),
        } });
        const refs = dangling(root, { skillProfile: 'lean' });
        expect(refs.map(r => [r.line, r.target])).toEqual([[2, 'sweep']]);
    });

    it('skips a catalogue block in an always-delivered doc but scans the rest of it', () => {
        const root = toolkit();
        tmp.write('.agents/startup.md', 'Always: run /sweep.\n');
        tmp.write('.agents/startup-reference.md', ['Use /review:qa.', '<!-- skill-profile:catalogue-start -->', '- /sweep — cleanup', '<!-- skill-profile:catalogue-end -->'].join('\n'));
        const refs = dangling(root, { skillProfile: 'lean' });
        expect(refs.map(r => `${r.caller}:${r.line}:${r.target}`)).toEqual(['doc:startup:1:sweep', 'doc:startup-reference:1:review-qa']);
    });

    it('scans skill scripts and follows symlinked directories', () => {
        const root = toolkit({ skillFiles: { 'do/scripts/run.js': "// then invoke /sweep\n" } });
        tmp.write('shared/notes.md', 'Run /review:qa.');
        fs.symlinkSync(path.join(root, 'shared'), path.join(root, '.agents/skills/do/linked'), 'dir');
        const refs = dangling(root, { skillProfile: 'lean' });
        expect(refs.map(r => `${r.file}:${r.target}`).sort()).toEqual([
            '.agents/skills/do/linked/notes.md:review-qa',
            '.agents/skills/do/scripts/run.js:sweep',
        ]);
    });

    it('scans every .md and .json file in a kept skill directory, but not dropped skills', () => {
        const root = toolkit({ skillFiles: {
            'do/references/workflow.md': 'Step 9: /sweep',
            'do/evals/evals.json': '{"prompt": "run /review:qa"}',
            sweep: 'Run /review:qa and /sweep again.',
        } });
        const refs = dangling(root, { skillProfile: 'lean' });
        expect(refs.map(r => `${r.file}:${r.target}`).sort()).toEqual([
            '.agents/skills/do/evals/evals.json:review-qa',
            '.agents/skills/do/references/workflow.md:sweep',
        ]);
    });

    it('ignores a skill referring to itself', () => {
        const root = toolkit({ skillFiles: { 'review-qa': 'This is /review:qa.' } });
        expect(dangling(root, { skillProfile: 'app', skillExclude: ['sweep'] })).toEqual([]);
    });

    it('scans kept roles after the skills strip and skips their frontmatter', () => {
        const root = toolkit({ roleFiles: {
            shadow: [
                '---',
                'name: shadow',
                'aliases: [review-qa]',
                'skills:',
                '  - do',
                '  - review-qa',
                '---',
                '',
                '## Skills',
                '- `.claude/skills/review-qa/SKILL.md`',
                '',
                'Dispatched by `/review:qa`.',
            ].join('\n'),
            'qa-engineer': '---\nname: qa-engineer\n---\nRun /review:qa.',
        } });
        const refs = dangling(root, { skillProfile: 'lean' });
        // shadow is kept: only the body prose line remains; qa-engineer is dropped by the profile.
        expect(refs.map(r => [r.caller, r.target, r.text])).toEqual([['role:shadow', 'review-qa', 'Dispatched by `/review:qa`.']]);
    });

    it('matches a knowledge skill only by slash or path form, never by its bare name', () => {
        const root = toolkit({ skillFiles: {
            do: [
                'Stack examples: helper-skill, tailwind and friends.',
                'Read `.claude/skills/helper-skill/SKILL.md` first.',
            ].join('\n'),
        } });
        const refs = dangling(root, { skillProfile: 'app', skillExclude: ['helper-skill'] });
        expect(refs.map(r => [r.line, r.form])).toEqual([[2, 'path']]);
    });

    it('ignores dropped names that are not toolkit skills', () => {
        const root = toolkit({ skillFiles: { do: 'Run /legacy-thing and legacy-thing.' } });
        expect(dangling(root, { skillExclude: ['legacy-thing'] })).toEqual([]);
    });

    it('reports the renamed skill under its new name', () => {
        const root = toolkit({ skillFiles: { do: 'Run /intake.' } });
        expect(dangling(root, { skillExclude: ['learning-intake'] }).map(r => r.target)).toEqual(['intake']);
    });

    it('returns nothing when no skill is dropped', () => {
        const root = toolkit({ skillFiles: { do: 'Run /sweep.' } });
        expect(dangling(root, {})).toEqual([]);
    });

    it('formats one reference per line with file and line', () => {
        const root = toolkit({ skillFiles: { do: 'x\nRun /sweep.' } });
        expect(formatDangling(dangling(root, { skillProfile: 'lean' }))).toBe('  skill:do → sweep (.agents/skills/do/SKILL.md:2)');
    });
});

describe('suggestClosure', () => {
    it('drops callers transitively until the set is closed', () => {
        const root = toolkit({ skillFiles: {
            end: 'Run /do at the end.',
            do: 'Run /review:qa.',
            'helper-skill': 'Calls /end.',
        } });
        const result = suggestClosure({ root, keptSkills: SKILLS, keptRoles: [], droppedSkills: ['review-qa'] });
        expect(result.skills).toEqual(['do', 'end', 'helper-skill']);
        expect(result.references).toEqual([]);
    });

    it('lists roles that still reference a dropped skill', () => {
        const root = toolkit({ roleFiles: { shadow: '---\nname: shadow\n---\nRun /sweep.' } });
        const result = suggestClosure({ root, keptSkills: SKILLS, keptRoles: ['shadow'], droppedSkills: ['sweep'] });
        expect(result.skills).toEqual([]);
        expect(result.roles).toEqual(['role:shadow']);
    });
});

describe('checkSelectionClosure', () => {
    it('reports a kept skill or role missing from the tree as unverified, not as closed-and-checked', () => {
        const root = toolkit({ skillFiles: { end: 'Run /sweep.' } });
        fs.rmSync(path.join(root, '.agents/skills/do'), { recursive: true });
        fs.rmSync(path.join(root, '.agents/roles/shadow.md'));
        const result = checkSelectionClosure(root, { skillProfile: 'lean', skillInclude: ['do'] });
        expect(result.unverified).toEqual([
            'unverified (kept but not in this tree): skills do',
            'unverified (kept but not in this tree): roles shadow',
        ]);
        expect(result.ok).toBe(false); // end's /sweep still dangles
        tmp.write('.agents/skills/end/SKILL.md', '# end');
        const closed = checkSelectionClosure(root, { skillProfile: 'lean', skillInclude: ['do'] });
        expect(closed.ok).toBe(true);
        expect(closed.unverified).toHaveLength(2);
    });

    it('accepts a kept skill delivered only under .claude/skills (an adopter-owned skill zone)', () => {
        const root = toolkit();
        fs.rmSync(path.join(root, '.agents/skills/helper-skill'), { recursive: true });
        tmp.write('.claude/skills/helper-skill/SKILL.md', 'Run /sweep.');
        const result = checkSelectionClosure(root, { skillProfile: 'lean' });
        expect(result.ok).toBe(false);
        expect(result.references.map(r => r.file)).toEqual(['.claude/skills/helper-skill/SKILL.md']);
    });

    it('is closed for a closed selection', () => {
        expect(checkSelectionClosure(toolkit(), { skillProfile: 'lean' }).ok).toBe(true);
    });
});
