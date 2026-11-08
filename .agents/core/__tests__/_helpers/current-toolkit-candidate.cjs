// Test-only current-source candidate. Production snapshots still consume Git HEAD.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let sourceEnumerationEnvironment;

function withFixtureGitEnvironment(hooks, action) {
  // Git for Windows does not accept Node's \\.\nul device spelling here.
  const globalConfig = `${hooks}.gitconfig`;
  fs.writeFileSync(globalConfig, '');
  // Nested construction scopes retain the original source's ignore context.
  // Fixture commits use isolated configuration; source enumeration is read-only
  // and must still honor the source owner's global excludesFile.
  const priorSourceEnvironment = sourceEnumerationEnvironment;
  if (!sourceEnumerationEnvironment) sourceEnumerationEnvironment = { ...process.env };
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^GIT_/i.test(key)));
  for (const key of Object.keys(process.env)) if (/^GIT_/i.test(key)) delete process.env[key];
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
  });
  try { return action(); }
  finally {
    for (const key of Object.keys(process.env)) if (/^GIT_/i.test(key)) delete process.env[key];
    Object.assign(process.env, saved);
    sourceEnumerationEnvironment = priorSourceEnvironment;
  }
}

const INPUTS = ['.agents', '.claude', '.codex', '.gitattributes', 'tools',
  'docs/reference/agents/intake.md', 'package.json', 'package-lock.json'];
const FIXTURE_FILES = new Set([
  '.agents/core/__tests__/_helpers/shared-pilot.cjs',
  // prepareReleasePair places this exact source-only canary in its fixture.
  '.agents/core/__tests__/shared-agents.test.js',
]);
function selected(file) {
  if (file === '.agents/render-state.json' || file === '.claude/settings.local.json') return false;
  if (/(?:^|\/)(?:agent-memory|node_modules|\.git|\.state)(?:\/|$)/.test(file)) return false;
  if (FIXTURE_FILES.has(file) || file.startsWith('.agents/core/__tests__/_fixtures/neutral-adopter/')) return true;
  return !/(?:^|\/)(?:__tests__|_helpers)(?:\/|$)/.test(file);
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function enumerateSource(sourceRoot, hooks) {
  const env = { ...(sourceEnumerationEnvironment || process.env) };
  // Preserve source configuration/ignore semantics, but never let an inherited
  // repository override redirect this explicit source enumeration elsewhere.
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) && !/^GIT_CONFIG(?:_.*)?$/i.test(key)) delete env[key];
  }
  const output = execFileSync('git', ['--no-optional-locks', '-c', `core.hooksPath=${hooks}`,
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.longpaths=true',
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...INPUTS], {
    cwd: sourceRoot, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  return [...new Set(output.split('\0').filter(Boolean))].filter(selected);
}

function sourceFile(sourceRoot, relative) {
  const source = path.resolve(sourceRoot, relative);
  if (!inside(sourceRoot, source)) throw new Error(`Candidate input is outside the source checkout: ${relative}`);
  let current = sourceRoot;
  const parts = path.relative(sourceRoot, source).split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code === 'ENOENT') return null; // Optional tracked deletions stay absent.
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Candidate input has a symlink ancestor or leaf: ${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Candidate input ancestor is not a directory: ${relative}`);
    if (index === parts.length - 1 && !stat.isFile()) throw new Error(`Candidate input must be a regular file: ${relative}`);
  }
  if (!inside(sourceRoot, fs.realpathSync.native(source))) throw new Error(`Candidate input resolves outside the source checkout: ${relative}`);
  return source;
}

function createCurrentToolkitCandidate({ workRoot, toolkitRoot }) {
  const sourceRoot = fs.realpathSync.native(toolkitRoot);
  const work = path.resolve(workRoot);
  // Resolve existing ancestors before creating anything, including when the
  // caller's temporary root uses a junction or an 8.3 spelling.
  let ancestor = work;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actualWork = path.resolve(fs.realpathSync.native(ancestor), path.relative(ancestor, work));
  if (inside(sourceRoot, actualWork)) throw new Error('Current candidate work root must be outside the source checkout');
  fs.mkdirSync(work, { recursive: true });
  const root = path.join(fs.realpathSync.native(work), 'candidate toolkit');
  if (fs.existsSync(root)) throw new Error('Current candidate directory must be new');
  const hooks = fs.mkdtempSync(path.join(fs.realpathSync.native(work), 'empty candidate hooks '));
  fs.mkdirSync(root);
  const files = enumerateSource(sourceRoot, hooks);
  return withFixtureGitEnvironment(hooks, () => {
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.longpaths=true', ...args], {
      cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    // --others admits authored new inputs without importing ignored runtime or
    // user state. Tracked paths read their current bytes, never their old blobs.
    for (const file of files) {
      const source = sourceFile(sourceRoot, file);
      if (!source) continue;
      const destination = path.join(root, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    git(root, 'init', '-q', `--template=${hooks}`);
    git(root, 'config', 'core.hooksPath', hooks);
    git(root, 'config', 'core.longpaths', 'true');
    git(root, 'add', '--all');
    git(root, 'commit', '-qm', 'synthetic current implementation fixture');
    return { root, head: git(root, 'rev-parse', 'HEAD').trim() };
  });
}

module.exports = { createCurrentToolkitCandidate, withFixtureGitEnvironment };
