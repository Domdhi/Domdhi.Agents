// AC→source map (SP-1.4 / role exclusion through install, update and render):
//   install + update of the live toolkit into an adopter on the `agent` profile deliver exactly the profile's
//   skills and roles in both runtimes; render --check in the adopter is clean; no profile renders every role.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createTmpDir } = require('./_helpers/tmp-dir');

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILES = JSON.parse(fs.readFileSync(path.join(TOOLKIT, '.agents/adapters/skill-profiles.json'), 'utf8')).profiles;

function cliEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^GIT_/i.test(key) || key === 'CLAUDE_PROJECT_DIR' || key === 'AGENTS_RUNTIME' || key === 'AGENT_RUNTIME') delete env[key];
    }
    return env;
}

function run(entry, args, cwd = TOOLKIT) {
    const result = spawnSync(process.execPath, [path.join(TOOLKIT, entry), ...args], { cwd, env: cliEnv(), encoding: 'utf8', timeout: 120000 });
    expect(result.error).toBeUndefined();
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function names(dir, ext) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith(ext)).map(n => n.slice(0, -ext.length)).sort();
}

function dirs(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
}

let tmp;
beforeEach(() => { tmp = createTmpDir({ prefix: 'skill-profile-roles-' }); });
afterEach(() => { tmp.cleanup(); });

function adopter(config) {
    const target = path.join(tmp.root, 'adopter');
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', target], { env: cliEnv() });
    fs.writeFileSync(path.join(target, 'README.md'), '# adopter\n');
    if (config) fs.writeFileSync(path.join(target, '.claude/update-config.json'), JSON.stringify(config));
    return target;
}

describe('agent profile — roles and skills delivered', () => {
    it('install and update deliver only the profile roles and skills in both runtimes', () => {
        const target = adopter({ skillProfile: 'agent' });
        const expectedRoles = [...PROFILES.agent.roles].sort();
        const expectedSkills = [...PROFILES.agent.skills].sort();

        const install = run('.agents/core/install.js', [target, '--keep']);
        expect(install.code, install.output).toBe(0);
        expect(names(path.join(target, '.agents/roles'), '.md')).toEqual(expectedRoles);
        expect(names(path.join(target, '.claude/agents'), '.md')).toEqual(expectedRoles);
        expect(names(path.join(target, '.codex/agents'), '.toml')).toEqual(expectedRoles);
        expect(dirs(path.join(target, '.agents/skills'))).toEqual(expectedSkills);
        expect(dirs(path.join(target, '.claude/skills'))).toEqual(expectedSkills);

        const update = run('.agents/core/template-updater.js', ['update', target, '--merge']);
        expect(update.code, update.output).toBe(0);
        expect(update.output).toContain('Excluding roles (per update-config.json profile):');
        expect(names(path.join(target, '.agents/roles'), '.md')).toEqual(expectedRoles);
        expect(names(path.join(target, '.claude/agents'), '.md')).toEqual(expectedRoles);
        expect(names(path.join(target, '.codex/agents'), '.toml')).toEqual(expectedRoles);
        expect(dirs(path.join(target, '.claude/skills'))).toEqual(expectedSkills);

        const check = run('.agents/core/render-shared-agents.js', ['--check', '--root', target]);
        expect(check.code, check.output).toBe(0);
        expect(check.output).not.toContain('PROFILE');
    }, 240000);

    it('without a profile, every toolkit role is delivered', () => {
        const target = adopter();
        const install = run('.agents/core/install.js', [target, '--keep']);
        expect(install.code, install.output).toBe(0);
        expect(names(path.join(target, '.claude/agents'), '.md')).toEqual(names(path.join(TOOLKIT, '.agents/roles'), '.md'));
    }, 240000);
});
