// AC→source map (SP-1.5 / prune newly excluded outputs on update):
//   switching an installed adopter to `knowledge` removes the excluded skills' generated outputs, Codex
//   projections and canonical copies; --dry-run lists PRUNE and writes nothing; an edited excluded output
//   is a conflict that names the reason; a customised canonical copy is kept with a warning; bespoke skills stay.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createTmpDir } = require('./_helpers/tmp-dir');

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function cliEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^GIT_/i.test(key) || key === 'CLAUDE_PROJECT_DIR' || key === 'AGENTS_RUNTIME' || key === 'AGENT_RUNTIME') delete env[key];
    }
    return env;
}

function run(entry, args) {
    const result = spawnSync(process.execPath, [path.join(TOOLKIT, entry), ...args], { cwd: TOOLKIT, env: cliEnv(), encoding: 'utf8', timeout: 120000 });
    expect(result.error).toBeUndefined();
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function snapshot(dir) {
    const out = {};
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name === '.git') continue;
            const abs = path.join(d, e.name);
            if (e.isDirectory()) walk(abs); else out[path.relative(dir, abs)] = fs.readFileSync(abs).toString('base64');
        }
    };
    walk(dir);
    return out;
}

let tmp;
let target;
beforeEach(() => {
    tmp = createTmpDir({ prefix: 'skill-profile-prune-' });
    target = path.join(tmp.root, 'adopter');
    fs.mkdirSync(target, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', target], { env: cliEnv() });
    const install = run('.agents/core/install.js', [target, '--keep']);
    expect(install.code, install.output).toBe(0);
    fs.writeFileSync(path.join(target, '.claude/update-config.json'), JSON.stringify({ skillProfile: 'knowledge' }));
});
afterEach(() => { tmp.cleanup(); });

const exists = rel => fs.existsSync(path.join(target, rel));

describe('switching to a leaner profile', () => {
    it('dry run lists PRUNE lines and writes nothing', () => {
        const before = snapshot(target);
        const result = run('.agents/core/template-updater.js', ['update', target, '--merge', '--dry-run']);
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('PRUNE    .claude/commands/sweep.md');
        expect(result.output).toMatch(/PRUNE    \.agents\/skills\/sweep\/ \(\d+ files\)/);
        expect(snapshot(target)).toEqual(before);
    }, 240000);

    it('removes the excluded skills everywhere, keeps the rest and bespoke skills, and leaves a closed, current render', () => {
        fs.mkdirSync(path.join(target, '.claude/skills/react-patterns'), { recursive: true });
        fs.writeFileSync(path.join(target, '.claude/skills/react-patterns/SKILL.md'), '---\nname: react-patterns\ndescription: bespoke\n---\n');
        const result = run('.agents/core/template-updater.js', ['update', target, '--merge']);
        expect(result.code, result.output).toBe(0);
        for (const rel of ['.claude/skills/sweep', '.claude/commands/sweep.md', '.agents/skills/sweep', '.claude/commands/retro.md', '.claude/commands/review/qa.md', '.agents/skills/onboard']) {
            expect(exists(rel), rel).toBe(false);
        }
        for (const rel of ['.claude/commands/run-todo.md', '.agents/skills/run-todo/SKILL.md', '.claude/commands/review/check-sync.md', '.claude/skills/react-patterns/SKILL.md']) {
            expect(exists(rel), rel).toBe(true);
        }
        const state = JSON.parse(fs.readFileSync(path.join(target, '.agents/render-state.json'), 'utf8'));
        expect(Object.keys(state).filter(rel => /(skills|commands)\/(sweep|retro|onboard)\b/.test(rel))).toEqual([]);
        const check = run('.agents/core/render-shared-agents.js', ['--check', '--root', target]);
        expect(check.code, check.output).toBe(0);
    }, 240000);

    it('refuses with a named reason when an excluded output was edited, and keeps it', () => {
        fs.appendFileSync(path.join(target, '.claude/commands/retro.md'), '\n# LOCAL EDIT\n');
        const result = run('.agents/core/template-updater.js', ['update', target, '--merge']);
        expect(result.code).toBe(1);
        expect(result.output).toContain(".claude/commands/retro.md — excluded by the project's skill selection but locally edited");
        expect(fs.readFileSync(path.join(target, '.claude/commands/retro.md'), 'utf8')).toContain('# LOCAL EDIT');
    }, 240000);

    it('keeps a customised canonical copy of an excluded skill with a warning', () => {
        fs.appendFileSync(path.join(target, '.agents/skills/sweep/references/workflow.md'), '\n<!-- @@project-additions -->\nOurs.\n');
        const result = run('.agents/core/template-updater.js', ['update', target, '--merge']);
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain(".agents/skills/sweep/ — excluded by the project's skill selection but customised; kept");
        expect(exists('.agents/skills/sweep/references/workflow.md')).toBe(true);
        expect(exists('.claude/commands/sweep.md')).toBe(false);
    }, 240000);
});

describe('render after a profile switch, without an update', () => {
    it('--check fails while unedited excluded outputs are pending, and a plain render prunes and reports them', () => {
        const check = run('.agents/core/render-shared-agents.js', ['--check', '--root', target]);
        expect(check.code).toBe(1);
        expect(check.output).toContain('PRUNE .claude/commands/sweep.md (excluded by the project\'s skill selection; pending)');
        expect(exists('.claude/commands/sweep.md')).toBe(true);
        const render = run('.agents/core/render-shared-agents.js', ['--root', target]);
        expect(render.output).toContain('PRUNE .claude/commands/sweep.md');
        expect(exists('.claude/commands/sweep.md')).toBe(false);
    }, 240000);
});
