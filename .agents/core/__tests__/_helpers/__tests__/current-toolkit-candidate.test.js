import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const helper = path.resolve('.agents/core/__tests__/_helpers/current-toolkit-candidate.cjs');

function smallSource(work) {
  const source = path.join(work, 'source');
  fs.mkdirSync(path.join(source, '.agents/core'), { recursive: true });
  const hooks = path.join(work, 'hooks'); fs.mkdirSync(hooks);
  const config = path.join(work, 'global.gitconfig'); fs.writeFileSync(config, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, ...args], { cwd: source, env, windowsHide: true });
  fs.writeFileSync(path.join(source, '.agents/core/input.js'), '// tracked fixture\n');
  git('init', '-q', `--template=${hooks}`); git('add', '--all'); git('commit', '-qm', 'fixture');
  return { source, config };
}

it('currentCandidate_externalAncestorJunction_refusesOutsideBytes', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate junction '));
  try {
    const { source } = smallSource(work);
    const outside = path.join(work, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'input.js'), '// outside private fixture\n');
    fs.renameSync(path.join(source, '.agents/core'), path.join(source, 'saved-core'));
    fs.symlinkSync(outside, path.join(source, '.agents/core'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => require(helper).createCurrentToolkitCandidate({ workRoot: path.join(work, 'candidate'), toolkitRoot: source })).toThrow(/outside|symlink|contain|ancestor/i);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

it('currentCandidate_sourceGlobalExclusion_doesNotAdmitIgnoredPrivateAddition', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate exclusions '));
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    const { source, config } = smallSource(work);
    const excludes = path.join(work, 'global-ignore'); fs.writeFileSync(excludes, 'global-private.js\n');
    fs.writeFileSync(config, `[core]\n\texcludesFile = "${excludes.replaceAll('\\', '/')}"\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    fs.writeFileSync(path.join(source, '.agents/global-private.js'), '// ignored private fixture\n');
    const result = require(helper).createCurrentToolkitCandidate({ workRoot: path.join(work, 'candidate'), toolkitRoot: source });
    expect(fs.existsSync(path.join(result.root, '.agents/global-private.js'))).toBe(false);
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(config);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

it('currentCandidate_commitsCurrentManagedBytesAndAuthoredAdditionsWithoutIgnoredStateOrSourceMutation', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'current candidate space '));
  try {
    const source = path.join(work, 'source');
    const hooks = path.join(work, 'empty hooks');
    const config = path.join(work, 'empty.gitconfig');
    fs.mkdirSync(source); fs.mkdirSync(hooks); fs.writeFileSync(config, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config });
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
    const put = (file, text) => { const target = path.join(source, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
    put('.gitattributes', '* text=auto eol=lf\n');
    put('.gitignore', '.agents/ignored.private\n.claude/settings.local.json\n');
    put('.agents/core/_lib/skill-merger.js', 'module.exports = "old";\n');
    put('.agents/core/__tests__/_helpers/shared-pilot.cjs', 'module.exports = {};\n');
    put('.agents/core/__tests__/_fixtures/neutral-adopter/application.cjs', 'module.exports = "fixture";\n');
    put('.agents/core/__tests__/unrelated.test.js', '// excluded suite\n');
    put('.agents/render-state.json', '{}\n');
    put('.codex/shared-agents.json', '{}\n');
    put('.claude/shared-agents.json', '{}\n');
    put('package.json', '{}\n');
    git(source, 'init', '-q', `--template=${hooks}`);
    git(source, 'add', '--all'); git(source, 'commit', '-qm', 'fixture source');
    const sourceHead = git(source, 'rev-parse', 'HEAD');
    put('.agents/core/_lib/skill-merger.js', 'module.exports = "current";\n');
    put('.agents/core/authored-new-helper.js', 'module.exports = "new authored input";\n');
    put('.agents/ignored.private', 'private ignored state\n');
    put('.claude/settings.local.json', '{"private":true}\n');
    const sourceStatus = git(source, 'status', '--porcelain', '--untracked-files=all');

    expect(fs.existsSync(helper), 'shared current-candidate fixture is missing').toBe(true);
    const result = require(helper).createCurrentToolkitCandidate({ workRoot: path.join(work, 'candidate work'), toolkitRoot: source });
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    expect(git(result.root, 'show', 'HEAD:.agents/core/_lib/skill-merger.js')).toBe('module.exports = "current";\n');
    expect(git(result.root, 'show', 'HEAD:.agents/core/authored-new-helper.js')).toBe('module.exports = "new authored input";\n');
    for (const retained of ['.agents/core/__tests__/_helpers/shared-pilot.cjs', '.agents/core/__tests__/_fixtures/neutral-adopter/application.cjs']) {
      expect(fs.existsSync(path.join(result.root, retained)), retained).toBe(true);
    }
    for (const omitted of ['.agents/render-state.json', '.agents/ignored.private', '.claude/settings.local.json', '.agents/core/__tests__/unrelated.test.js']) {
      expect(fs.existsSync(path.join(result.root, omitted)), omitted).toBe(false);
    }
    expect(git(result.root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(git(source, 'status', '--porcelain', '--untracked-files=all')).toBe(sourceStatus);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
