// AC→source map (SP-1.3 / skill-profile wiring):
//   readUpdateConfig — accepts skillProfile (string) and skillInclude (string[]); other types refused (CONFIG)
//   preflightUpdate — PROFILE refusal listing caller → target (file:line) with a fix, before any write;
//                     unknown profile refused; a closed selection passes
//   loadExcludedSkills / loadExcludedRoles — profile complement + skillExclude
//   render-shared-agents --check — exits 1 on an unclosed selection
//   skill-profile.js check / suggest

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { readUpdateConfig, preflightUpdate, loadExcludedSkills, loadExcludedRoles, pruneGroups } = require('../template-updater');
const skillProfile = require('../skill-profile');

const CORE = path.resolve(__dirname, '..');

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'skill-profile-test-' }); });
afterEach(() => { tmp.cleanup(); });

/** A synthetic toolkit source: do → /sweep, end → nothing, roles shadow + qa-engineer. */
function source(root = 'src') {
    const w = (rel, text) => tmp.write(`${root}/${rel}`, text);
    w('.claude/README.md', '# toolkit\n');
    w('.agents/config/version.json', '{ "version": "0.0" }\n');
    w('.agents/adapters/skill-profiles.json', JSON.stringify({ profiles: {
        app: { skills: ['do', 'end', 'sweep'], roles: ['qa-engineer', 'shadow'] },
        lean: { skills: ['end'], roles: ['shadow'] },
    } }));
    w('.agents/adapters/workflows.json', JSON.stringify({ do: '.claude/commands/do.md', end: '.claude/commands/end.md', sweep: '.claude/commands/sweep.md' }));
    w('.agents/skills/do/SKILL.md', '---\nname: do\ndescription: x\n---\nThen run /sweep.\n');
    w('.agents/skills/end/SKILL.md', '---\nname: end\ndescription: x\n---\nDone.\n');
    w('.agents/skills/sweep/SKILL.md', '---\nname: sweep\ndescription: x\n---\nSweep.\n');
    w('.agents/roles/shadow.md', '---\nname: shadow\n---\nWriter.\n');
    w('.agents/roles/qa-engineer.md', '---\nname: qa-engineer\n---\nTester.\n');
    return path.join(tmp.root, root);
}

function target(config) {
    tmp.write('target/.claude/settings.json', '{}\n');
    if (config !== undefined) tmp.write('target/.claude/update-config.json', typeof config === 'string' ? config : JSON.stringify(config));
    return path.join(tmp.root, 'target');
}

function snapshot(dir) {
    const out = {};
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const abs = path.join(d, e.name);
            if (e.isDirectory()) walk(abs); else out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
        }
    };
    walk(dir);
    return out;
}

describe('readUpdateConfig — profile keys', () => {
    it('accepts skillProfile and skillInclude', () => {
        const t = target({ skillProfile: 'lean', skillInclude: ['do'], skillExclude: [] });
        expect(readUpdateConfig(path.join(t, '.claude'))).toEqual({ ok: true, skillProfile: 'lean', skillInclude: ['do'], skillExclude: [] });
    });

    it.each([
        ['numeric skillProfile', { skillProfile: 3 }],
        ['empty skillProfile', { skillProfile: '' }],
        ['string skillInclude', { skillInclude: 'do' }],
        ['non-string skillInclude item', { skillInclude: [1] }],
    ])('refuses %s with CONFIG naming the new keys', (_label, config) => {
        const result = readUpdateConfig(path.join(target(config), '.claude'));
        expect(result.ok).toBe(false);
        expect(result.code).toBe('CONFIG');
        expect(result.message).toMatch(/skillProfile is a string and optional skillInclude and skillExclude are arrays of strings/);
    });
});

describe('preflightUpdate — selection closure', () => {
    it('refuses a selection that leaves a kept skill invoking a dropped one, listing file:line and a fix, and writes nothing', () => {
        const src = source();
        const t = target({ skillExclude: ['sweep'] });
        const before = snapshot(t);
        const result = preflightUpdate({ source: src, target: t, dryRun: false });
        expect(result.ok).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].code).toBe('PROFILE');
        expect(result.errors[0].details).toEqual([
            'kept skills or roles still invoke a dropped skill:',
            '  skill:do → sweep (.agents/skills/do/SKILL.md:5)',
            'fix: keep sweep (remove from skillExclude)',
            '  or also drop do (skillExclude)',
        ]);
        expect(snapshot(t)).toEqual(before);
    });

    it('refuses an unknown profile with the known names', () => {
        const result = preflightUpdate({ source: source(), target: target({ skillProfile: 'nope' }), dryRun: true });
        expect(result.errors[0].code).toBe('PROFILE');
        expect(result.errors[0].details).toEqual(['unknown skillProfile "nope" (known profiles: app, lean)']);
        expect(result.dryRun).toBe(true);
    });

    it('passes a closed profile selection and a config without exclusions', () => {
        const src = source();
        expect(preflightUpdate({ source: src, target: target({ skillProfile: 'lean' }), dryRun: true }).ok).toBe(true);
        tmp.cleanup(); tmp = createTmpDir({ prefix: 'skill-profile-test-' });
        expect(preflightUpdate({ source: source(), target: target(), dryRun: true }).ok).toBe(true);
    });

    it('passes when the excluded skill has no remaining caller', () => {
        expect(preflightUpdate({ source: source(), target: target({ skillExclude: ['sweep', 'do'] }), dryRun: true }).ok).toBe(true);
    });

    it('prints the refusal details from the update CLI and exits 1', () => {
        const src = source();
        const t = target({ skillExclude: ['sweep'] });
        const run = spawnSync(process.execPath, [path.join(CORE, 'template-updater.js'), 'update', t, '--dry-run'], {
            encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: src },
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('PROFILE: Project skill selection');
        expect(run.stderr).toContain('    skill:do → sweep (.agents/skills/do/SKILL.md:5)');
        expect(run.stderr).toContain('update preflight refused; nothing was written.');
    });
});

describe('loadExcludedSkills / loadExcludedRoles with a profile', () => {
    it('excludes the profile complement plus skillExclude, and the roles outside the profile', () => {
        const src = source();
        const t = target({ skillProfile: 'lean' });
        expect([...loadExcludedSkills(path.join(t, '.claude'), src)].sort()).toEqual(['do', 'sweep']);
        expect([...loadExcludedRoles(path.join(t, '.claude'), src)]).toEqual(['qa-engineer']);
    });

    it('keeps the pre-profile behaviour without skillProfile', () => {
        const src = source();
        const t = target({ skillExclude: ['sweep'] });
        expect([...loadExcludedSkills(path.join(t, '.claude'), src)]).toEqual(['sweep']);
        expect(loadExcludedRoles(path.join(t, '.claude'), src).size).toBe(0);
    });
});

describe('render-shared-agents --check', () => {
    it('exits 1 and lists the dangling reference when the local selection is not closed', () => {
        const root = source('repo');
        tmp.write('repo/.claude/update-config.json', JSON.stringify({ skillExclude: ['sweep'] }));
        const run = spawnSync(process.execPath, [path.join(CORE, 'render-shared-agents.js'), '--check', '--root', root], { encoding: 'utf8' });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('PROFILE refused: project skill selection is not closed');
        expect(run.stderr).toContain('skill:do → sweep (.agents/skills/do/SKILL.md:5)');
    });
});

describe('skill-profile.js', () => {
    const capture = () => {
        const lines = { out: [], err: [] };
        return { lines, out: l => lines.out.push(l), err: l => lines.err.push(l) };
    };

    it('check reports a closed profile with exit 0', () => {
        const root = source('repo');
        tmp.write('repo/.claude/update-config.json', JSON.stringify({ skillProfile: 'lean' }));
        const c = capture();
        expect(skillProfile.main(['check', '--root', root], c.out, c.err)).toBe(0);
        expect(c.lines.out).toContain('Profile        : lean');
        expect(c.lines.out).toContain('Excluded skills: do, sweep');
        expect(c.lines.out).toContain('Excluded roles : qa-engineer');
        expect(c.lines.out).toContain('Closure        : closed');
    });

    it('check reports an open selection with exit 1', () => {
        const root = source('repo');
        tmp.write('repo/.claude/update-config.json', JSON.stringify({ skillExclude: ['sweep'] }));
        const c = capture();
        expect(skillProfile.main(['check', '--root', root], c.out, c.err)).toBe(1);
        expect(c.lines.err).toContain('Closure        : NOT closed');
    });

    it('suggest lists the callers that must also go', () => {
        const root = source('repo');
        const c = capture();
        expect(skillProfile.main(['suggest', 'sweep', '--root', root], c.out, c.err)).toBe(0);
        expect(c.lines.out).toEqual(['To drop sweep, also drop: do']);
        expect(skillProfile.main(['suggest', 'nope', '--root', root], c.out, c.err)).toBe(1);
    });
});

describe('pruneGroups', () => {
    it('groups pruned files by skill directory and keeps other paths whole', () => {
        expect(pruneGroups([
            '.agents/skills/sweep/SKILL.md', '.agents/skills/sweep/references/workflow.md',
            '.claude/skills/sweep/SKILL.md', '.claude/commands/sweep.md', '.codex/agents/qa-engineer.toml',
        ])).toEqual([
            ['.agents/skills/sweep/', 2], ['.claude/commands/sweep.md', 1], ['.claude/skills/sweep/', 1], ['.codex/agents/qa-engineer.toml', 1],
        ]);
    });
});
