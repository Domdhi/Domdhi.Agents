// AC→source map (SP-1.6 / live profile guard):
//   every shipped profile resolves without error and is closed on the live tree — a later edit that adds
//   `/review:x` (or `/sweep`, `skills/x/`) to a kept workflow or role fails this suite, not an adopter;
//   `app` holds every toolkit skill and role, so the universe is complete.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { loadProfiles, checkSelectionClosure, formatDangling } = require('../_lib/skill-profiles');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const profiles = loadProfiles(ROOT);

describe('shipped skill profiles (live tree)', () => {
    it('ships the app, knowledge and agent profiles', () => {
        expect(Object.keys(profiles).sort()).toEqual(['agent', 'app', 'knowledge']);
    });

    it('app lists every toolkit skill and role', () => {
        const skills = fs.readdirSync(path.join(ROOT, '.agents/skills')).filter(d => fs.existsSync(path.join(ROOT, '.agents/skills', d, 'SKILL.md'))).sort();
        const roles = fs.readdirSync(path.join(ROOT, '.agents/roles')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort();
        expect([...profiles.app.skills].sort()).toEqual(skills);
        expect([...profiles.app.roles].sort()).toEqual(roles);
    });

    it('every profile names only toolkit skills and roles', () => {
        const skills = new Set(profiles.app.skills);
        const roles = new Set(profiles.app.roles);
        for (const [name, profile] of Object.entries(profiles)) {
            expect(profile.skills.filter(s => !skills.has(s)), name).toEqual([]);
            expect(profile.roles.filter(r => !roles.has(r)), name).toEqual([]);
        }
    });

    it.each(Object.keys(profiles))('profile %s is closed: no kept skill or role invokes a dropped skill', name => {
        const result = checkSelectionClosure(ROOT, { skillProfile: name });
        expect(result.selection.errors).toEqual([]);
        expect(formatDangling(result.references)).toBe('');
    });
});
