// SF-1.1: tests for `.agents/core/ac-verify.js` (`run` and `red` verbs).
//
// PINNED CONTRACT. The implementer must match these names, signatures and shapes; the tests are the spec.
//
// Module exports (CommonJS, CLI guarded by `require.main === module`, so requiring it never exits):
//   run(opts)  -> result      execute every `verify:` binding of the selected stories and record them
//   red(opts)  -> result      the recorded-red probe: execute them and classify, writing nothing the ship check reads
//   tokenizeVerify(command)   -> { ok: true, tokens: string[] } | { ok: false, reason: string }
//   refusalReason(command, { root }) -> null | string   (null = allowed; a string = why it is refused)
//   main(argv = process.argv.slice(2)) -> exit code number; prints exactly ONE JSON document (the result) to stdout
//
//   opts = { root, todo, stories, env = process.env, spawnSync = require('child_process').spawnSync }
//     root    absolute repository root (children run with cwd = root)
//     todo    path to the TODO markdown file; stories: string[] of exact story ids
//     env     source of AC_VERIFY_TIMEOUT_MS only; spawnSync is the injected child spawner (the
//             implementation MUST spawn the verify commands through this synchronous API,
//             `spawnSync(file, argsArray, { shell: false, windowsHide: true, cwd: root, timeout, ... })`, and
//             ONLY the verify commands go through it: git/head lookups use their own spawner)
//
// CLI: `node ac-verify.js run|red --todo T --stories ID1,ID2`. The repository root is
// `CLAUDE_PROJECT_DIR` when set (the toolkit's convention), else the working directory's repo root.
// The CLI ALWAYS prints one JSON document to stdout (also on every failure) and exits non-zero on failure.
//
// run result:  { ok, exitCode, errors: [{ code, message, ... }],
//                stories: [{ id, status: 'passed'|'failed'|'no-bindings', bindings, manual, records: Record[] }] }
//   ok === (exitCode === 0); exitCode is 0 only when every record has status 'ran' and met === true.
//   Record file: docs/.output/.state/telemetry/ac-verify/{storyId}.json holds a JSON ARRAY of records, one per
//   binding in AC order, rewritten (not appended) by every run. A Record has EXACTLY these keys:
//   story, acLine (1-based TODO line of the criterion), command (as written, without the `=> exit N`
//   clause), expectedExit, exit (number|null), met, status ('ran'|'refused'|'timeout'), durationMs,
//   outputTail (stdout+stderr tail, <= 2048 bytes, whole characters), codeHash (codeTreeHash taken after the
//   command finished), head (git HEAD), ranAt (ISO-8601). A refused record has exit null, met false and
//   its refusal reason inside outputTail.
//
// red result:  { ok, exitCode, errors, stories: [{ id, status, bindings, manual,
//                results: [{ acLine, command, verdict: 'red'|'vacuous'|'infra'|'refused'|'timeout',
//                            infraClass?, digest? }] }] }
//   verdict 'red'     = the check ran and was not met for a real reason; digest is 'expected | saw | file:line'
//                       for vitest output, and contains the first failing line for any other runner
//   verdict 'vacuous' = the check was already met (exit === expectedExit) before implementation. An exit-0 run is
//                       vacuous even when it prints nothing; it is 'infra' (zero tests collected) only when the
//                       output carries the runner's zero-collected signal (`Tests  no tests`, per the gate's parser)
//   verdict 'infra'   = infraClass is exactly one of: 'Cannot find module', 'SyntaxError', 'ENOENT',
//                       'No test files found', 'zero tests collected'
//   exitCode is 0 only when every result is 'red' (or the story has no bindings, status 'no-bindings').
//
// Refusal rules pinned beyond the AC text (security-conservative):
//   * the metacharacters ; & | < > backtick and `$(` are refused anywhere in the raw text, quoted or not
//   * a first token with a path (`/usr/bin/node`), an env assignment (`FOO=1`), or `env` is outside the allowlist
//   * node: -e/--eval/-p/--print (also `--eval=...`, `--print=...`, and a short cluster such as `-pe`)
//   * npx: the second token must be a bare basename (no `/` or `\`) that exists in <root>/node_modules/.bin
//   * git: the second token must be a read-only subcommand (status log diff show rev-parse ls-files are
//     required to be allowed); an option before the subcommand (`git -c ...`) is refused; `--output...` is refused
//
// A `verify:` binding that is malformed (todo-completion's BAD_VERIFY) fails the whole selection closed:
// nothing runs, errors contains code 'BAD_VERIFY', exit non-zero.
//
// NOT COVERED (open, reported to the owner): the record file written for a no-bindings story (none is asserted);
// whether `red` writes any file; `[cut:]`-style dispositions on a criterion that has a binding; digests for
// pytest/dotnet/cargo/go output; real execution of the pytest/dotnet/cargo/go heads; Windows `.cmd` shims;
// node flags placed after the script name.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = path.resolve('.agents/core/ac-verify.js');
const TOOLKIT_NODE_MODULES = path.resolve('node_modules');
const subject = () => require('../ac-verify');
const gr = require('../_lib/gate-receipt');

const RECORD_KEYS = ['acLine', 'codeHash', 'command', 'durationMs', 'exit', 'expectedExit', 'head', 'met', 'outputTail', 'ranAt', 'status', 'story'];
const RECORD_DIR = 'docs/.output/.state/telemetry/ac-verify';
const DEFAULT_TIMEOUT_MS = 300000;
const isWindows = process.platform === 'win32';

// ── fixtures ────────────────────────────────────────────────────────

const SCRIPTS = {
  'ok.js': "console.log('ok');\n",
  'exit.js': 'process.exit(Number(process.argv[2]));\n',
  'mark.js': "require('fs').writeFileSync('MARKER', 'ran');\n",
  'mark2.js': "require('fs').writeFileSync('MARKER2', 'ran');\n",
  'sleep.js': 'setTimeout(() => {}, 60000);\n',
  'cwd.js': 'process.stdout.write(process.cwd());\n',
  'args.js': 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
  'big.js': "process.stdout.write('x'.repeat(10000) + 'END-MARKER');\n",
  'euro.js': "process.stdout.write('\\u20ac'.repeat(3000));\n",
  'both.js': "process.stdout.write('OUT-LINE\\n'); process.stderr.write('ERR-LINE\\n');\n",
  'sigkill.js': "process.kill(process.pid, 'SIGKILL');\n",
  'fail.js': "console.error('FAIL expected 5 saw 3 at check.js:7'); process.exit(1);\n",
  'passing.js': "console.log(' Tests  2 passed (2)');\n",
  'badreq.js': "require('./does-not-exist');\n",
  'syntax.js': 'const x = ;\n',
  'enoent.js': "require('fs').readFileSync('missing-file.txt');\n",
  'notests.js': "console.log('No test files found, exiting with code 1'); process.exit(1);\n",
  'zero-exit0.js': "console.log('      Tests  no tests');\n",
  'zero-exit1.js': "console.log('      Tests  no tests'); process.exit(1);\n",
  'evil.js': "require('fs').writeFileSync('MARKER', 'evil');\n",
  'sub/.keep': '',
};

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

/** TODO text. `stories` maps an id to its criteria: a string bullet, or `{ text, box }` (box 'x' = ticked). */
function todoText(stories) {
  const parts = ['# TODO: fixture\n'];
  for (const [id, criteria] of Object.entries(stories)) {
    const bullets = criteria.map((c) => {
      const { text, box } = typeof c === 'string' ? { text: c, box: ' ' } : c;
      return `    * [${box}] ${text}\n`;
    }).join('');
    parts.push(`* **Story ${id} (S): Title ${id}**\n  * **AC:**\n${bullets}  * **Files:**\n    * \`x.js\`\n`);
  }
  return parts.join('\n');
}
const lineOf = (text, fragment) => text.split('\n').findIndex(l => l.includes(fragment)) + 1;

function makeRepo({ stories = {}, extra = {}, rawTodo = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-')));
  roots.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (rel, content, mode) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, mode ? { mode } : undefined);
    return full;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'commit.gpgsign', 'false');
  write('.gitignore', 'docs/.output/.state/\nnode_modules\n');
  for (const [rel, content] of Object.entries({ ...SCRIPTS, ...extra })) write(rel, content);
  const text = rawTodo ?? todoText(stories);
  const todoPath = write('docs/TODO_fixture.md', text);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const recordFile = (id) => path.join(root, RECORD_DIR, `${id}.json`);
  return {
    root, git, write, todoPath, text,
    recordFile,
    records: (id) => JSON.parse(fs.readFileSync(recordFile(id), 'utf8')),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    head: () => git('rev-parse', 'HEAD'),
  };
}

const STRIPPED_ENV = new Set(['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'AC_VERIFY_TIMEOUT_MS', 'AGENTS_RUNTIME', 'CI']);
function childEnv(root, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIPPED_ENV.has(k) || k === 'VITEST' || k.startsWith('VITEST_')) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_PROJECT_DIR: root, ...extra };
}

/** Run the real CLI. The CLI must print exactly one JSON document, so a missing script fails here, not silently. */
function cli(root, args, { env = {}, cwd = root } = {}) {
  expect(fs.existsSync(SCRIPT), 'ac-verify.js must exist at .agents/core/ac-verify.js').toBe(true);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: childEnv(root, env), encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* asserted below */ }
  expect(json, `stdout must be exactly one JSON document (status ${r.status}, stderr: ${r.stderr})`).not.toBeNull();
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
const verb = (repo, name, ids, options) => cli(repo.root, [name, '--todo', repo.todoPath, '--stories', ids.join(',')], options);
const runCli = (repo, ids = ['T-1.1'], options) => verb(repo, 'run', ids, options);
const redCli = (repo, ids = ['T-1.1'], options) => verb(repo, 'red', ids, options);

const OK_RESULT = { status: 0, signal: null, stdout: 'spy-out', stderr: '', pid: 1, output: null };
function spawnSpy(result = OK_RESULT) {
  const calls = [];
  const fn = (file, args, options) => {
    calls.push({ file, args, options });
    return typeof result === 'function' ? result(file, args, options) : result;
  };
  fn.calls = calls;
  return fn;
}
const inProcess = (name, repo, ids, extra = {}) => subject()[name]({ root: repo.root, todo: repo.todoPath, stories: ids, env: {}, ...extra });

// ── module shape ────────────────────────────────────────────────────

describe('module shape', () => {
  it('exports run, red, tokenizeVerify, refusalReason and main without running the CLI on require', () => {
    const mod = subject();
    for (const name of ['run', 'red', 'tokenizeVerify', 'refusalReason', 'main']) expect(typeof mod[name], name).toBe('function');
  });
});

// ── AC1: records ────────────────────────────────────────────────────

describe('run: records (AC1)', () => {
  it.each([
    ['no clause (default exit 0)', 'verify: node ok.js'],
    ['an explicit exit 0 clause', 'verify: node ok.js => exit 0'],
  ])('%s writes one record with exactly the seam fields', (_label, binding) => {
    const bullet = `Feature works. ${binding}`;
    const repo = makeRepo({ stories: { 'T-1.1': [bullet] } });
    const before = Date.now();

    const out = runCli(repo);

    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: true, exitCode: 0 });
    const records = repo.records('T-1.1');
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(Object.keys(rec).sort()).toEqual(RECORD_KEYS);
    expect(rec.story).toBe('T-1.1');
    expect(rec.acLine).toBe(lineOf(repo.text, 'Feature works.'));
    expect(rec.command).toBe('node ok.js');
    expect(rec.expectedExit).toBe(0);
    expect(rec.exit).toBe(0);
    expect(rec.met).toBe(true);
    expect(rec.status).toBe('ran');
    expect(Number.isInteger(rec.durationMs) && rec.durationMs >= 0).toBe(true);
    expect(rec.outputTail).toBe('ok\n');
    expect(rec.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.head).toBe(repo.head());
    expect(new Date(rec.ranAt).toISOString()).toBe(rec.ranAt);
    expect(Date.parse(rec.ranAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(rec.ranAt)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(out.json.stories[0]).toMatchObject({ id: 'T-1.1', status: 'passed', bindings: 1, manual: 0 });
    expect(out.json.stories[0].records).toEqual(records);
  });

  it('an explicit non-zero expected exit is met when the child exits with it', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Fails loudly. verify: node exit.js 3 => exit 3'] } });

    const out = runCli(repo);

    expect(out.status).toBe(0);
    expect(repo.records('T-1.1')[0]).toMatchObject({ command: 'node exit.js 3', expectedExit: 3, exit: 3, met: true, status: 'ran' });
  });

  it.each([
    ['expected 0 but the child exits 3', 'verify: node exit.js 3', 0, 3],
    ['expected 3 but the child exits 0', 'verify: node ok.js => exit 3', 3, 0],
    ['expected 3 but the child exits 4', 'verify: node exit.js 4 => exit 3', 3, 4],
  ])('%s: the record is not met and the process exits non-zero', (_label, binding, expectedExit, exit) => {
    const repo = makeRepo({ stories: { 'T-1.1': [`Criterion. ${binding}`] } });

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
    expect(repo.records('T-1.1')[0]).toMatchObject({ expectedExit, exit, met: false, status: 'ran' });
    expect(out.json.stories[0].status).toBe('failed');
  });

  it('writes one record per command in AC order, runs every command after a failure, and acLine is unique per record', () => {
    const repo = makeRepo({ stories: { 'T-1.1': [
      'First. verify: node ok.js',
      'Second fails. verify: node exit.js 1',
      'Third still runs. verify: node mark2.js',
    ] } });

    const out = runCli(repo);

    const records = repo.records('T-1.1');
    expect(records.map(r => r.command)).toEqual(['node ok.js', 'node exit.js 1', 'node mark2.js']);
    // review fix M2: mark2.js writes an untracked file, so the tree changed while it ran and its record is not met.
    expect(records.map(r => r.met)).toEqual([true, false, false]);
    expect(records.map(r => r.status)).toEqual(['ran', 'ran', 'tree-changed']);
    expect(new Set(records.map(r => r.acLine)).size).toBe(3);
    expect(records.map(r => r.acLine)).toEqual([lineOf(repo.text, 'First.'), lineOf(repo.text, 'Second fails.'), lineOf(repo.text, 'Third still runs.')]);
    expect(repo.exists('MARKER2')).toBe(true);
    expect(out.status).not.toBe(0);
  });

  it.each([
    [['ok.js', 'ok.js'], true],
    [['ok.js', 'exit.js 1'], false],
    [['exit.js 1', 'ok.js'], false],
    [['exit.js 1', 'exit.js 2'], false],
  ])('commands %j: the process exits 0 only when every record is met (%s)', (commands, allMet) => {
    const repo = makeRepo({ stories: { 'T-1.1': commands.map((c, i) => `Item ${i}. verify: node ${c}`) } });

    const out = runCli(repo);

    expect(out.status === 0).toBe(allMet);
    expect(out.json.ok).toBe(allMet);
  });

  it('a ticked criterion with a binding is executed too', () => {
    const repo = makeRepo({ stories: { 'T-1.1': [{ text: 'Done already. verify: node mark.js', box: 'x' }] } });

    runCli(repo);

    expect(repo.exists('MARKER')).toBe(true);
    expect(repo.records('T-1.1')).toHaveLength(1);
  });

  it('rerunning rewrites the record file instead of appending to it', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js', 'B. verify: node exit.js 1'] } });
    runCli(repo);
    expect(repo.records('T-1.1')).toHaveLength(2);

    runCli(repo);

    expect(repo.records('T-1.1')).toHaveLength(2);
  });

  it('writes one independent record file per selected story and still reports the failing one', () => {
    const repo = makeRepo({ stories: {
      'T-1.1': ['Good. verify: node ok.js'],
      'T-1.2': ['Bad. verify: node exit.js 2'],
    } });

    const out = runCli(repo, ['T-1.1', 'T-1.2']);

    expect(out.status).not.toBe(0);
    expect(repo.records('T-1.1').map(r => [r.story, r.met])).toEqual([['T-1.1', true]]);
    expect(repo.records('T-1.2').map(r => [r.story, r.met])).toEqual([['T-1.2', false]]);
    expect(out.json.stories.map(s => [s.id, s.status])).toEqual([['T-1.1', 'passed'], ['T-1.2', 'failed']]);
  });

  it('leaves an unselected story untouched', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js'], 'T-1.2': ['B. verify: node mark.js'] } });

    runCli(repo, ['T-1.1']);

    expect(repo.exists('MARKER')).toBe(false);
    expect(fs.existsSync(repo.recordFile('T-1.2'))).toBe(false);
  });

  it('executes from the repository root even when invoked from a subdirectory', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Where. verify: node cwd.js'] } });

    const out = runCli(repo, ['T-1.1'], { cwd: path.join(repo.root, 'sub') });

    expect(out.status).toBe(0);
    expect(repo.records('T-1.1')[0].outputTail).toBe(repo.root);
  });
});

// ── AC1: spawn contract ─────────────────────────────────────────────

describe('run: how children are spawned (AC1, AC7)', () => {
  it('passes an argv array, shell false, windowsHide true and cwd = the repo root', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Spawn. verify: node check.js "b c"'] } });
    const spy = spawnSpy();

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: spy });

    expect(spy.calls).toHaveLength(1);
    const { file, args, options } = spy.calls[0];
    expect(file === 'node' || file === process.execPath).toBe(true);
    expect(args).toEqual(['check.js', 'b c']);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.cwd).toBe(repo.root);
    expect(result.exitCode).toBe(0);
    expect(result.stories[0].records[0].outputTail).toBe('spy-out');
  });

  it('sets windowsHide on every command of a multi-command story', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node a.js', 'B. verify: git status', 'C. verify: npm test'] } });
    const spy = spawnSpy();

    inProcess('run', repo, ['T-1.1'], { spawnSync: spy });

    expect(spy.calls.map(c => c.options.windowsHide)).toEqual([true, true, true]);
    expect(spy.calls.map(c => c.options.shell)).toEqual([false, false, false]);
  });

  it('the child time cap defaults to 300 seconds', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Cap. verify: node ok.js'] } });
    const spy = spawnSpy();

    inProcess('run', repo, ['T-1.1'], { spawnSync: spy, env: {} });

    expect(spy.calls[0].options.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('AC_VERIFY_TIMEOUT_MS overrides the cap', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Cap. verify: node ok.js'] } });
    const spy = spawnSpy();

    inProcess('run', repo, ['T-1.1'], { spawnSync: spy, env: { AC_VERIFY_TIMEOUT_MS: '1234' } });

    expect(spy.calls[0].options.timeout).toBe(1234);
  });

  it.each(['abc', '0', '-5', '', 'NaN'])('an invalid AC_VERIFY_TIMEOUT_MS (%j) falls back to the default, never to no cap', (bad) => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Cap. verify: node ok.js'] } });
    const spy = spawnSpy();

    inProcess('run', repo, ['T-1.1'], { spawnSync: spy, env: { AC_VERIFY_TIMEOUT_MS: bad } });

    expect(spy.calls[0].options.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });
});

// ── AC2: tokenization ───────────────────────────────────────────────

describe('tokenizeVerify (AC2)', () => {
  it.each([
    ['plain words', 'node a.js', ['node', 'a.js']],
    ['runs of spaces and tabs collapse', '  node   a.js \t b  ', ['node', 'a.js', 'b']],
    ['double quotes group one token', 'node "a b" c', ['node', 'a b', 'c']],
    ['single quotes group one token', "node 'c d' e", ['node', 'c d', 'e']],
    ['a single quote inside double quotes is literal', 'node "it\'s"', ['node', "it's"]],
    ['double quotes inside single quotes are literal', 'node \'say "hi"\'', ['node', 'say "hi"']],
    ['a backslash is a literal character (no escapes)', 'node a\\b', ['node', 'a\\b']],
    ['a backslash does not escape the closing quote', 'node "a\\"', ['node', 'a\\']],
  ])('%s', (_label, command, tokens) => {
    expect(subject().tokenizeVerify(command)).toEqual({ ok: true, tokens });
  });

  it.each([
    ['an unterminated double quote', 'node "abc'],
    ['an unterminated single quote', "node 'abc"],
    ['a single quote left open inside double quotes', 'node "it\'s'],
    ['a backslash cannot escape a quote, so this leaves one open', 'node "a\\""'],
    ['an empty command', ''],
    ['a whitespace-only command', '   '],
  ])('refuses %s', (_label, command) => {
    const result = subject().tokenizeVerify(command);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('quoted arguments reach the child as single argv entries', () => {
    const repo = makeRepo({ stories: { 'T-1.1': [`Quotes. verify: node args.js "two words" 'single quoted' plain "it's" a\\b`] } });

    runCli(repo);

    expect(JSON.parse(repo.records('T-1.1')[0].outputTail)).toEqual(['two words', 'single quoted', 'plain', "it's", 'a\\b']);
  });

  it('an unbalanced quote in a binding is refused and nothing runs', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Open quote. verify: node args.js "never closed'] } });

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(repo.records('T-1.1')[0]).toMatchObject({ status: 'refused', exit: null, met: false });
  });
});

// ── AC2: refusal classes ────────────────────────────────────────────

describe('refusalReason (AC2)', () => {
  function binRoot() {
    // node_modules is gitignored in the fixture; the file only has to exist on disk.
    return makeRepo({ extra: { 'node_modules/.bin/vitest': '#!/usr/bin/env node\n' } }).root;
  }

  it.each([
    'node a.js',
    'node a.js --flag value',
    'node a.js "b c"',
    'node a.js $HOME',
    'npm test',
    'npm t',
    'npm run build',
    'npm run-script lint',
    'npm test -- --reporter=dot',
    'npx vitest run a.test.js',
    'git status',
    'git log --oneline -5',
    'git diff HEAD',
    'git show HEAD',
    'git rev-parse HEAD',
    'pytest tests/a.py',
    'dotnet test',
    'cargo test',
    'go test ./...',
  ])('allows %s', (command) => {
    expect(subject().refusalReason(command, { root: binRoot() })).toBeNull();
  });

  it.each([
    ['a semicolon', 'node a.js; node b.js'],
    ['a semicolon inside quotes (raw-text scan)', 'node a.js "a;b"'],
    ['a single ampersand', 'node a.js & node b.js'],
    ['a double ampersand', 'node a.js && node b.js'],
    ['a pipe', 'node a.js | cat'],
    ['a double pipe', 'node a.js || node b.js'],
    ['an output redirect', 'node a.js > out.txt'],
    ['an append redirect', 'node a.js >> out.txt'],
    ['an input redirect', 'node a.js < in.txt'],
    ['a stream redirect', 'node a.js 2>&1'],
    ['a backtick', 'node a.js \u0060id\u0060'],
    ['a command substitution', 'node a.js $(id)'],
    ['a command substitution inside double quotes', 'node a.js "$(id)"'],
  ])('refuses %s', (_label, command) => {
    const reason = subject().refusalReason(command, { root: binRoot() });
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeGreaterThan(0);
  });

  it.each([
    ['rm', 'rm -rf x'],
    ['bash', 'bash a.sh'],
    ['sh', 'sh -c "x"'],
    ['curl', 'curl http://example.com'],
    ['python', 'python a.py'],
    ['env as a launcher', 'env node a.js'],
    ['an env assignment head', 'FOO=1 node a.js'],
    ['an absolute path to node', '/usr/bin/node a.js'],
    ['a relative script path', './a.sh'],
    ['nodejs', 'nodejs a.js'],
  ])('refuses a first token outside the allowlist (%s)', (_label, command) => {
    expect(typeof subject().refusalReason(command, { root: binRoot() })).toBe('string');
  });

  it.each([
    ['-e', 'node -e "1"'],
    ['--eval', 'node --eval "1"'],
    ['-p', 'node -p "1"'],
    ['--print', 'node --print "1"'],
    ['--eval= form', 'node --eval=1'],
    ['--print= form', 'node --print=1'],
    ['a short cluster -pe', 'node -pe "1"'],
  ])('refuses node with %s', (_label, command) => {
    expect(typeof subject().refusalReason(command, { root: binRoot() })).toBe('string');
  });

  it.each([
    ['install', 'npm install'],
    ['i', 'npm i'],
    ['ci', 'npm ci'],
    ['publish', 'npm publish'],
    ['exec', 'npm exec x'],
    ['x', 'npm x -- node a.js'],
    ['start', 'npm start'],
    ['no subcommand', 'npm'],
    ['an option before the subcommand', 'npm --prefix ../elsewhere test'],
  ])('refuses npm %s', (_label, command) => {
    expect(typeof subject().refusalReason(command, { root: binRoot() })).toBe('string');
  });

  it.each([
    ['a binary that is not in node_modules/.bin', 'npx cowsay'],
    ['a file at the root that is not in node_modules/.bin', 'npx evil.js'],
    ['no binary at all', 'npx'],
    ['an option instead of a binary', 'npx -y vitest'],
    ['a parent-directory escape that resolves to a real file', 'npx ../../evil.js'],
    ['an explicit path to the bin', 'npx ./node_modules/.bin/vitest'],
    ['a path-qualified bin', 'npx node_modules/.bin/vitest'],
    ['a traversal behind a real bin name', 'npx vitest/../../../evil.js'],
    ['a backslash escape', 'npx ..\\..\\evil.js'],
  ])('refuses npx with %s', (_label, command) => {
    const root = binRoot();
    fs.writeFileSync(path.join(root, 'evil.js'), 'x');
    expect(typeof subject().refusalReason(command, { root })).toBe('string');
  });

  it.each([
    ['commit', 'git commit -m x'],
    ['push', 'git push'],
    ['reset', 'git reset --hard'],
    ['checkout', 'git checkout -b x'],
    ['clean', 'git clean -fd'],
    ['add', 'git add .'],
    ['rm', 'git rm a'],
    ['merge', 'git merge x'],
    ['rebase', 'git rebase x'],
    ['stash', 'git stash'],
    ['config', 'git config user.name x'],
    ['fetch', 'git fetch'],
    ['pull', 'git pull'],
    ['no subcommand', 'git'],
    ['an option before the subcommand', 'git -c core.pager=evil log'],
    ['log writing a file', 'git log --output=out.txt'],
    ['diff writing a file', 'git diff --output=out.txt'],
  ])('refuses git %s', (_label, command) => {
    expect(typeof subject().refusalReason(command, { root: binRoot() })).toBe('string');
  });

  it('npx is allowed exactly when the binary is present in node_modules/.bin', () => {
    const present = binRoot();
    const absent = makeRepo().root;
    expect(subject().refusalReason('npx vitest', { root: present })).toBeNull();
    expect(typeof subject().refusalReason('npx vitest', { root: absent })).toBe('string');
  });
});

describe('run: refused commands are recorded and never executed (AC2)', () => {
  const MARK_JS = "\"require('fs').writeFileSync('MARKER','x')\"";
  const table = [
    ['semicolon', 'node mark.js ; echo x'],
    ['ampersand', 'node mark.js & echo x'],
    ['pipe', 'node mark.js | cat'],
    ['redirect out', 'node mark.js > out.txt'],
    ['redirect in', 'node mark.js < in.txt'],
    ['backtick', 'node mark.js \u0060id\u0060'],
    ['command substitution', 'node mark.js $(id)'],
    ['unbalanced quote', 'node mark.js "unbalanced'],
    ['node -e', `node -e ${MARK_JS}`],
    ['node --eval', `node --eval ${MARK_JS}`],
    ['node -p', `node -p ${MARK_JS}`],
    ['node --print', `node --print ${MARK_JS}`],
    ['disallowed head sh', "sh -c 'touch MARKER'"],
    ['env launcher', 'env node mark.js'],
    ['npm exec', 'npm exec -- node mark.js'],
    ['git commit', 'git commit --allow-empty -m refused'],
    ['git checkout -b', 'git checkout -b refused-branch'],
  ];

  it.each(table)('%s: status refused, exit null, met false, non-zero exit, and no side effect', (_label, command) => {
    const repo = makeRepo({ stories: { 'T-1.1': [`Refuse me. verify: ${command}`] } });
    const headBefore = repo.head();

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
    const rec = repo.records('T-1.1')[0];
    expect(rec).toMatchObject({ command, status: 'refused', exit: null, met: false });
    expect(typeof rec.codeHash).toBe('string');
    expect(rec.outputTail).toContain(subject().refusalReason(command, { root: repo.root }));
    expect(repo.exists('MARKER')).toBe(false);
    expect(repo.head()).toBe(headBefore);
    expect(repo.git('branch', '--format=%(refname:short)')).toBe('main');
  });

  it('a refused command does not stop the other commands of the story', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Bad. verify: node mark.js ; echo x', 'Good. verify: node mark2.js'] } });

    const out = runCli(repo);

    // review fix M2: mark2.js writes an untracked file, so the second command ran but changed the tree.
    expect(repo.records('T-1.1').map(r => r.status)).toEqual(['refused', 'tree-changed']);
    expect(repo.exists('MARKER')).toBe(false);
    expect(repo.exists('MARKER2')).toBe(true);
    expect(out.status).not.toBe(0);
  });

  it('an allowlisted read-only git command and a node_modules/.bin npx binary really run', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Head. verify: git rev-parse HEAD', 'Status. verify: git status', ...(isWindows ? [] : ['Bin. verify: npx mark'])] },
    });
    if (!isWindows) {
      repo.write('node_modules/.bin/mark', '#!/usr/bin/env node\nconsole.log("mark-bin-ran");\n', 0o755);
    }

    const out = runCli(repo);

    expect(out.status).toBe(0);
    const records = repo.records('T-1.1');
    expect(records[0]).toMatchObject({ status: 'ran', exit: 0, met: true, outputTail: `${repo.head()}\n` });
    expect(records[1]).toMatchObject({ status: 'ran', exit: 0, met: true });
    if (!isWindows) expect(records[2]).toMatchObject({ status: 'ran', exit: 0, met: true, outputTail: 'mark-bin-ran\n' });
  });
});

// ── AC3: time cap, output cap, signals ──────────────────────────────

describe('run: a run in which no test passed is never met (first adopter run, 2026-11-20)', () => {
  const out = (stdout) => spawnSpy({ status: 0, signal: null, stdout, stderr: '', pid: 1, output: null });

  it.each([
    ['vitest, a name filter that matched nothing', '\n Test Files  1 passed (1)\n      Tests  96 skipped (96)\n'],
    ['jest, every test skipped', 'Tests:       5 skipped, 5 total\n'],
    ['vitest, no tests collected', '      Tests  no tests\n'],
  ])('%s: exit 0 as expected but met false, vacuous with a reason', (_name, stdout) => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Filtered. verify: node ok.js'] } });

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: out(stdout) });

    expect(result.exitCode).toBe(1);
    const record = result.stories[0].records[0];
    expect(record).toMatchObject({ status: 'ran', exit: 0, met: false, vacuous: true });
    expect(record.vacuousReason).toMatch(/no test|collected/);
    expect(repo.records('T-1.1')[0]).toMatchObject({ met: false, vacuous: true });
  });

  it.each([
    ['vitest, one filtered test passed', '\n Test Files  1 passed (1)\n      Tests  1 passed | 38 skipped (39)\n'],
    ['jest, all passed', 'Tests:       3 passed, 3 total\n'],
    ['a command with no test summary (typecheck, lint)', 'Found 0 errors.\n'],
  ])('%s: met true, not vacuous', (_name, stdout) => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Fine. verify: node ok.js'] } });

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: out(stdout) });

    expect(result.exitCode).toBe(0);
    expect(result.stories[0].records[0]).toMatchObject({ status: 'ran', exit: 0, met: true });
    expect(result.stories[0].records[0].vacuous).toBeUndefined();
  });

  it('red still calls an all-skipped run vacuous, never a real red', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Filtered. verify: node ok.js'] } });

    const result = inProcess('red', repo, ['T-1.1'], { spawnSync: out('      Tests  4 skipped (4)\n') });

    expect(result.stories[0].results[0].verdict).toBe('vacuous');
    expect(result.exitCode).not.toBe(0);
  });
});

describe('refusal: a test-name filter a nested package-manager script would drop', () => {
  const nested = { 'package.json': JSON.stringify({ scripts: { test: 'cd src && npm run test', unit: 'pnpm -r test' } }) };
  const direct = { 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) };

  it.each([
    ['npm run test -- x.js -t "AC1"', '-t'],
    ['npm test -- x.js --testNamePattern=AC1', '--testNamePattern=AC1'],
    ['npm run unit -- x.js --test-name-pattern AC1', '--test-name-pattern'],
  ])('refuses %s when the script re-invokes a package manager', (command, flag) => {
    const repo = makeRepo({ extra: nested });

    const reason = subject().refusalReason(command, { root: repo.root });

    expect(reason).toMatch(/runs a package manager again/);
    expect(reason).toContain(flag);
    expect(reason).toMatch(/second "--"/);
  });

  it('accepts the filter behind a second "--"', () => {
    const repo = makeRepo({ extra: nested });
    expect(subject().refusalReason('npm run test -- x.js -- -t "AC1"', { root: repo.root })).toBeNull();
  });

  it('accepts a single "--" when the script runs the test runner directly', () => {
    const repo = makeRepo({ extra: direct });
    expect(subject().refusalReason('npm run test -- x.js -t "AC1"', { root: repo.root })).toBeNull();
  });

  it('accepts a nested script with no name filter', () => {
    const repo = makeRepo({ extra: nested });
    expect(subject().refusalReason('npm run test -- x.js', { root: repo.root })).toBeNull();
  });
});

describe('list: parse-only view of the bindings', () => {
  it('reports every binding with its refusal and executes nothing', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Good. verify: node ok.js', 'Bad. verify: curl example.com', 'By hand. [manual]'] } });
    const spy = spawnSpy();

    const result = subject().list({ root: repo.root, todo: repo.todoPath, stories: ['T-1.1'], spawnSync: spy });

    expect(spy.calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.refused).toBe(1);
    const [good, bad] = result.stories[0].bindings;
    expect(good).toMatchObject({ command: 'node ok.js', expectedExit: 0, refusal: null });
    expect(bad.refusal).toMatch(/not an allowed command/);
    expect(result.stories[0].manual).toBe(1);
    expect(repo.exists(RECORD_DIR)).toBe(false);
  });

  it('lists every story of the TODO when --stories is left out', () => {
    const rawTodo = `## Story Index\n\n| Story | Wave |\n|---|---|\n| T-1.1 | — |\n\n${todoText({ 'T-1.1': ['One. verify: node ok.js'], 'T-1.2': ['Two. verify: curl example.com'] })}`;
    const repo = makeRepo({ rawTodo });

    const out = cli(repo.root, ['list', '--todo', repo.todoPath]);

    expect(out.status).toBe(1);
    expect(out.json.stories.map(story => story.id)).toEqual(['T-1.1', 'T-1.2']);
    expect(out.json.refused).toBe(1);
  });

  it('exits 0 from the CLI when nothing is refused', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Good. verify: node ok.js'] } });

    const out = verb(repo, 'list', ['T-1.1']);

    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: true, refused: 0 });
  });
});

describe('run: time cap, output cap and signals (AC3)', () => {
  it('kills a command that outlives AC_VERIFY_TIMEOUT_MS and records status timeout', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Hangs. verify: node sleep.js'] } });

    const out = runCli(repo, ['T-1.1'], { env: { AC_VERIFY_TIMEOUT_MS: '400' } });

    expect(out.status).not.toBe(0);
    expect(repo.records('T-1.1')[0]).toMatchObject({ status: 'timeout', exit: null, met: false });
  });

  it('a spawn that reports ETIMEDOUT is a timeout and keeps the partial output', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Hangs. verify: node ok.js'] } });
    const spy = spawnSpy({
      status: null, signal: 'SIGTERM', stdout: 'partial', stderr: '', pid: 1, output: null,
      error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: spy });

    expect(result.exitCode).not.toBe(0);
    expect(result.stories[0].records[0]).toMatchObject({ status: 'timeout', exit: null, met: false });
    expect(result.stories[0].records[0].outputTail).toContain('partial');
  });

  it('a command killed by a signal records exit null and met false (injected spawn result)', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Killed. verify: node ok.js'] } });
    const spy = spawnSpy({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', pid: 1, output: null });

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: spy });

    expect(result.exitCode).not.toBe(0);
    expect(result.stories[0].records[0]).toMatchObject({ status: 'ran', exit: null, met: false });
  });

  it.skipIf(isWindows)('a real child that kills itself with SIGKILL records exit null and met false', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Suicide. verify: node sigkill.js'] } });

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(repo.records('T-1.1')[0]).toMatchObject({ status: 'ran', exit: null, met: false });
  });

  it('a spawn error (command could not start) is not met and fails the run', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Cannot start. verify: node ok.js'] } });
    const spy = spawnSpy({
      status: null, signal: null, stdout: '', stderr: '', pid: 0, output: null,
      error: Object.assign(new Error('spawnSync node ENOENT'), { code: 'ENOENT' }),
    });

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: spy });

    expect(result.exitCode).not.toBe(0);
    expect(result.stories[0].records[0].met).toBe(false);
    expect(result.stories[0].records[0].exit).toBeNull();
  });

  it('keeps only the tail of oversized output within 2048 bytes', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Chatty. verify: node big.js'] } });

    runCli(repo);

    const tail = repo.records('T-1.1')[0].outputTail;
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(tail, 'utf8')).toBeGreaterThanOrEqual(2000);
    expect(tail.endsWith('END-MARKER')).toBe(true);
    expect(tail.startsWith('x')).toBe(true);
  });

  it('never cuts a multi-byte character in half when capping', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Euros. verify: node euro.js'] } });

    runCli(repo);

    const tail = repo.records('T-1.1')[0].outputTail;
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(2048);
    expect(tail).toMatch(/^\u20ac+$/u);
    expect(tail.includes('\ufffd')).toBe(false);
  });

  it('captures both stdout and stderr', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Both. verify: node both.js'] } });

    runCli(repo);

    const tail = repo.records('T-1.1')[0].outputTail;
    expect(tail).toContain('OUT-LINE');
    expect(tail).toContain('ERR-LINE');
  });
});

// ── code hash stamp ─────────────────────────────────────────────────

describe('run: codeHash stamp (AC6)', () => {
  it('stamps the codeTreeHash of the tree as the check left it', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Stamp. verify: node ok.js'] } });

    runCli(repo);

    const expected = gr.codeTreeHash(repo.root);
    expect(expected.ok).toBe(true);
    expect(repo.records('T-1.1')[0].codeHash).toBe(expected.hash);
  });

  it('a check that writes an artifact is stamped with the tree that includes it', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Writes. verify: node mark.js'] } });
    const before = gr.codeTreeHash(repo.root).hash;

    runCli(repo);

    const rec = repo.records('T-1.1')[0];
    expect(rec.codeHash).not.toBe(before);
    expect(rec.codeHash).toBe(gr.codeTreeHash(repo.root).hash);
  });

  it('moves when code changes and stays put when only the TODO, plan or state changes', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Stamp. verify: node ok.js'] } });
    runCli(repo);
    const first = repo.records('T-1.1')[0].codeHash;

    repo.write('docs/TODO_fixture.md', `${repo.text}\n- tick\n`);
    repo.write('docs/.output/plans/plan.md', 'plan\n');
    runCli(repo);
    expect(repo.records('T-1.1')[0].codeHash).toBe(first);

    repo.write('ok.js', "console.log('changed');\n");
    runCli(repo);
    expect(repo.records('T-1.1')[0].codeHash).not.toBe(first);
  });
});

// ── AC4: red ────────────────────────────────────────────────────────

describe('red: vacuous checks (AC4)', () => {
  it.each([
    ['a plain command exiting 0', 'verify: node ok.js'],
    ['a test-runner style pass', 'verify: node passing.js'],
    ['an explicit exit 0', 'verify: node ok.js => exit 0'],
    ['a non-zero expected exit that is already met', 'verify: node exit.js 1 => exit 1'],
  ])('%s reports vacuous and exits non-zero', (_label, binding) => {
    const repo = makeRepo({ stories: { 'T-1.1': [`Already true. ${binding}`] } });

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
    expect(out.json.stories[0].results[0].verdict).toBe('vacuous');
    expect(out.json.stories[0].results[0].acLine).toBe(lineOf(repo.text, 'Already true.'));
  });
});

describe('red: infrastructure failures (AC4)', () => {
  it.each([
    ['Cannot find module', 'node badreq.js'],
    ['SyntaxError', 'node syntax.js'],
    ['ENOENT', 'node enoent.js'],
    ['No test files found', 'node notests.js'],
    ['zero tests collected', 'node zero-exit1.js'],
    ['zero tests collected', 'node zero-exit0.js'],
  ])('%s (%s) exits non-zero and names the class', (infraClass, command) => {
    const repo = makeRepo({ stories: { 'T-1.1': [`Broken harness. verify: ${command}`] } });

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    const result = out.json.stories[0].results[0];
    expect(result.verdict).toBe('infra');
    expect(result.infraClass).toBe(infraClass);
  });

  it.skipIf(isWindows)('real vitest with no matching test file is an infra failure, not a red check', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['No file. verify: npx vitest run nope.test.js'] } });
    fs.symlinkSync(TOOLKIT_NODE_MODULES, path.join(repo.root, 'node_modules'));

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'No test files found' });
  });
});

// Code review M4: a test written before its implementation requires a file that does not exist yet. When that file is a
// created non-test file of the story's Files list, the check is red for a real reason (no stub needed); a missing helper
// or a path outside the Files list stays infrastructure.
describe('red: a test that requires a module the story creates (M4)', () => {
  const newModuleTodo = (verify, files) => [
    '# TODO: new module fixture\n',
    `* **Story T-1.1 (S): Title**\n  * **AC:**\n    * [ ] Adds. verify: ${verify}\n  * **Files:** ${files}\n  * **Estimate:** S\n`,
  ].join('\n');
  const FILES = '`src/m.js` (new), `tests/m.test.js` (new)';
  const NODE_TEST = "const m = require('../src/m.js');\nif (m.add(1, 2) !== 3) process.exit(1);\n";

  it('plain node: Cannot find module for a created file is red, exits 0, and the digest names the module and the test line', () => {
    const repo = makeRepo({ rawTodo: newModuleTodo('node tests/m.test.js', FILES), extra: { 'tests/m.test.js': NODE_TEST } });

    const out = redCli(repo);

    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: true, exitCode: 0 });
    expect(out.json.stories[0].status).toBe('red');
    const result = out.json.stories[0].results[0];
    expect(result.verdict).toBe('red');
    expect(result.infraClass).toBeUndefined();
    expect(result.digest).toBe('expected module src/m.js | saw Cannot find module | tests/m.test.js:1');
    expect(repo.exists('src/m.js')).toBe(false);
  });

  it('a repo-wide check of one story failing on a module ANOTHER story of the wave creates is red (first adopter run, 2026-11-20)', () => {
    const rawTodo = [
      '# TODO: wave fixture\n',
      '* **Story T-1.1 (S): Types**\n  * **AC:**\n    * [ ] Typechecks. verify: node tests/m.test.js\n  * **Files:** `types.js`\n  * **Estimate:** S\n',
      `* **Story T-1.2 (S): Module**\n  * **AC:**\n    * [ ] Adds. verify: node tests/m.test.js\n  * **Files:** ${FILES}\n  * **Estimate:** S\n`,
    ].join('\n');
    const repo = makeRepo({ rawTodo, extra: { 'tests/m.test.js': NODE_TEST } });

    const out = redCli(repo, ['T-1.1', 'T-1.2']);

    expect(out.json.stories.map(story => story.status)).toEqual(['red', 'red']);
    expect(out.json.stories[0].results[0].digest).toMatch(/^expected module src\/m\.js \| saw Cannot find module/);
    expect(out.status).toBe(0);
  });

  it('the same failure is infrastructure when the module\'s story is not in the selection', () => {
    const rawTodo = [
      '# TODO: wave fixture\n',
      '* **Story T-1.1 (S): Types**\n  * **AC:**\n    * [ ] Typechecks. verify: node tests/m.test.js\n  * **Files:** `types.js`\n  * **Estimate:** S\n',
      `* **Story T-1.2 (S): Module**\n  * **AC:**\n    * [ ] Adds. verify: node tests/m.test.js\n  * **Files:** ${FILES}\n  * **Estimate:** S\n`,
    ].join('\n');
    const repo = makeRepo({ rawTodo, extra: { 'tests/m.test.js': NODE_TEST } });

    const out = redCli(repo, ['T-1.1']);

    expect(out.json.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'Cannot find module' });
  });

  it('keeps the infra verdict for a missing test helper (not a created file of the story)', () => {
    const repo = makeRepo({ rawTodo: newModuleTodo('node tests/m.test.js', FILES), extra: { 'tests/m.test.js': "require('./helpers/util');\n" } });

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'Cannot find module' });
  });

  it('keeps the infra verdict when the missing module is not in the Files list at all', () => {
    const repo = makeRepo({ rawTodo: newModuleTodo('node tests/m.test.js', '`tests/m.test.js` (new)'), extra: { 'tests/m.test.js': NODE_TEST } });

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'Cannot find module' });
  });

  it('keeps the infra verdict when the Files entry exists but is not marked created (a modified file cannot be missing)', () => {
    const repo = makeRepo({ rawTodo: newModuleTodo('node tests/m.test.js', '`src/m.js`, `tests/m.test.js` (new)'), extra: { 'tests/m.test.js': NODE_TEST } });

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'Cannot find module' });
  });

  it.skipIf(isWindows)('real vitest (red exit 0, no stub): the suite error is red with the test file and line, not zero tests collected', () => {
    const repo = makeRepo({
      rawTodo: newModuleTodo('npx vitest run tests/v.test.js', '`src/v.js` (new), `tests/v.test.js` (new)'),
      extra: { 'tests/v.test.js': "import { it, expect } from 'vitest';\nimport { add } from '../src/v.js';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n" },
    });
    fs.symlinkSync(TOOLKIT_NODE_MODULES, path.join(repo.root, 'node_modules'));

    const out = redCli(repo);

    expect(out.status).toBe(0);
    const result = out.json.stories[0].results[0];
    expect(result.verdict).toBe('red');
    expect(result.digest).toBe('expected module src/v.js | saw Cannot find module | tests/v.test.js:2');
    expect(repo.exists('src/v.js')).toBe(false);
  });

  it.skipIf(isWindows)('real vitest for a helper that is not in the Files list stays infra', () => {
    const repo = makeRepo({
      rawTodo: newModuleTodo('npx vitest run tests/v.test.js', '`tests/v.test.js` (new)'),
      extra: { 'tests/v.test.js': "import { it, expect } from 'vitest';\nimport { add } from './helpers/add.js';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n" },
    });
    fs.symlinkSync(TOOLKIT_NODE_MODULES, path.join(repo.root, 'node_modules'));

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'Cannot find module' });
  });
});

describe('red: real failures (AC4)', () => {
  it('a real failure prints a digest containing the first failing line and exits 0', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Not built yet. verify: node fail.js'] } });

    const out = redCli(repo);

    expect(out.status).toBe(0);
    expect(out.json).toMatchObject({ ok: true, exitCode: 0 });
    const result = out.json.stories[0].results[0];
    expect(result.verdict).toBe('red');
    expect(result.digest).toContain('FAIL expected 5 saw 3 at check.js:7');
    expect(result.command).toBe('node fail.js');
  });

  it('an unmet non-zero expected exit is a real failure too', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Wrong code. verify: node exit.js 1 => exit 3'] } });

    const out = redCli(repo);

    expect(out.status).toBe(0);
    expect(out.json.stories[0].results[0].verdict).toBe('red');
  });

  it.skipIf(isWindows)('real vitest output yields an `expected | saw | file:line` digest', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Adds. verify: npx vitest run t.test.js'] },
      extra: { 't.test.js': "import { it, expect } from 'vitest';\nconst add = (a, b) => a + b;\nit('adds', () => {\n  expect(add(1, 2)).toBe(5);\n});\n" },
    });
    fs.symlinkSync(TOOLKIT_NODE_MODULES, path.join(repo.root, 'node_modules'));

    const out = redCli(repo);

    expect(out.status).toBe(0);
    const result = out.json.stories[0].results[0];
    expect(result.verdict).toBe('red');
    const parts = result.digest.split(' | ');
    expect(parts).toHaveLength(3);
    expect(parts[0].trim()).toBe('5');
    expect(parts[1].trim()).toBe('3');
    expect(parts[2].trim()).toMatch(/(^|\/)t\.test\.js:4$/);
  });

  it('prints one result per criterion with its own digest', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['One. verify: node fail.js', 'Two. verify: node exit.js 2'] } });

    const out = redCli(repo);

    expect(out.status).toBe(0);
    const results = out.json.stories[0].results;
    expect(results.map(r => r.verdict)).toEqual(['red', 'red']);
    expect(results.map(r => r.acLine)).toEqual([lineOf(repo.text, 'One.'), lineOf(repo.text, 'Two.')]);
    expect(new Set(results.map(r => r.acLine)).size).toBe(2);
    expect(results.every(r => typeof r.digest === 'string' && r.digest.length > 0)).toBe(true);
  });

  it('one vacuous or infra criterion among real failures makes the whole probe non-zero but still reports every criterion', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Real. verify: node fail.js', 'Vacuous. verify: node ok.js', 'Infra. verify: node badreq.js'] } });

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results.map(r => r.verdict)).toEqual(['red', 'vacuous', 'infra']);
  });

  it('a refused command is reported refused, never executed, and fails the probe', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Refused. verify: node mark.js ; echo x'] } });

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results[0].verdict).toBe('refused');
    expect(repo.exists('MARKER')).toBe(false);
  });

  it('a command that outlives the cap is reported timeout and fails the probe', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Hangs. verify: node sleep.js'] } });

    const out = redCli(repo, ['T-1.1'], { env: { AC_VERIFY_TIMEOUT_MS: '400' } });

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results[0].verdict).toBe('timeout');
  });
});

// ── AC5: manual criteria and no-bindings ────────────────────────────

describe('manual criteria and no-bindings (AC5)', () => {
  it('run: a story with only manual criteria is reported no-bindings with the manual count, and is not an error', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Looks right to a human', 'Reads well'] } });

    const out = runCli(repo);

    expect(out.status).toBe(0);
    expect(out.json.ok).toBe(true);
    expect(out.json.stories[0]).toMatchObject({ id: 'T-1.1', status: 'no-bindings', bindings: 0, manual: 2, records: [] });
  });

  it('red: zero bindings is reported, not an error', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Looks right to a human', 'Reads well', 'Third'] } });

    const out = redCli(repo);

    expect(out.status).toBe(0);
    expect(out.json.stories[0]).toMatchObject({ id: 'T-1.1', status: 'no-bindings', bindings: 0, manual: 3 });
  });

  it('run: manual criteria are counted next to bindings and never fail the run', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Auto one. verify: node ok.js', 'Manual', 'Auto two. verify: node ok.js'] } });

    const out = runCli(repo);

    expect(out.status).toBe(0);
    expect(out.json.stories[0]).toMatchObject({ status: 'passed', bindings: 2, manual: 1 });
  });

  it('red: manual criteria are counted next to bindings', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Auto. verify: node fail.js', 'Manual one', 'Manual two'] } });

    const out = redCli(repo);

    expect(out.status).toBe(0);
    expect(out.json.stories[0]).toMatchObject({ bindings: 1, manual: 2 });
  });

  it('runs nothing for a no-bindings story', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Manual only'], 'T-1.2': ['Other. verify: node mark.js'] } });

    runCli(repo, ['T-1.1']);

    expect(repo.exists('MARKER')).toBe(false);
  });
});

// ── AC7: fail closed ────────────────────────────────────────────────

describe.each(['run', 'red'])('%s: fails closed (AC7)', (name) => {
  const cliVerb = (repo, ids, options) => verb(repo, name, ids, options);

  function expectRefusedSelection(repo, out) {
    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
    expect(Array.isArray(out.json.errors) && out.json.errors.length > 0).toBe(true);
    expect(repo.exists('MARKER')).toBe(false);
  }

  it('an unknown story id exits non-zero', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node mark.js'] } });
    expectRefusedSelection(repo, cliVerb(repo, ['NOPE']));
  });

  it('an unknown id among valid ids runs nothing at all', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node mark.js'] } });
    expectRefusedSelection(repo, cliVerb(repo, ['T-1.1', 'NOPE']));
  });

  it('a story declared twice is ambiguous and runs nothing', () => {
    const doubled = `${todoText({ 'T-1.1': ['A. verify: node mark.js'] })}\n${todoText({ 'T-1.1': ['B. verify: node mark.js'] })}`;
    const repo = makeRepo({ rawTodo: doubled });
    expectRefusedSelection(repo, cliVerb(repo, ['T-1.1']));
  });

  it('a malformed `=> exit` binding fails the whole selection (BAD_VERIFY) and runs nothing', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Good. verify: node mark.js', 'Broken. verify: node ok.js => exit abc'] } });

    const out = cliVerb(repo, ['T-1.1']);

    expectRefusedSelection(repo, out);
    expect(out.json.errors.map(e => e.code)).toContain('BAD_VERIFY');
  });

  it('an unreadable TODO (missing file) exits non-zero', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node mark.js'] } });
    const out = cli(repo.root, [name, '--todo', path.join(repo.root, 'docs/NOPE.md'), '--stories', 'T-1.1']);
    expectRefusedSelection(repo, out);
  });

  it('a TODO path that is a directory exits non-zero', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node mark.js'] } });
    const out = cli(repo.root, [name, '--todo', path.join(repo.root, 'docs'), '--stories', 'T-1.1']);
    expectRefusedSelection(repo, out);
  });

  it('a TODO that is not valid UTF-8 exits non-zero', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node mark.js'] } });
    fs.appendFileSync(repo.todoPath, Buffer.from([0xff, 0xfe, 0x0a]));
    expectRefusedSelection(repo, cliVerb(repo, ['T-1.1']));
  });

  it('a story id that tries to leave the record directory is refused and writes nothing outside it', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node mark.js'] } });

    const out = cliVerb(repo, ['../../evil']);

    expectRefusedSelection(repo, out);
    expect(repo.exists('docs/.output/.state/evil.json')).toBe(false);
    expect(repo.exists('docs/.output/evil.json')).toBe(false);
  });

  it('a duplicated id in the selection is refused', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node mark.js'] } });
    expectRefusedSelection(repo, cliVerb(repo, ['T-1.1', 'T-1.1']));
  });

  it.each([
    ['no arguments', () => []],
    ['no --todo', (r) => [name, '--stories', 'T-1.1']],
    ['no --stories', (r) => [name, '--todo', r.todoPath]],
    ['an empty --stories', (r) => [name, '--todo', r.todoPath, '--stories', '']],
    ['an unknown verb', (r) => ['bogus', '--todo', r.todoPath, '--stories', 'T-1.1']],
    ['an unknown flag', (r) => [name, '--todo', r.todoPath, '--stories', 'T-1.1', '--skip']],
    ['a stray positional', (r) => [name, '--todo', r.todoPath, '--stories', 'T-1.1', 'extra']],
    ['no verb', (r) => ['--todo', r.todoPath, '--stories', 'T-1.1']],
  ])('refuses %s and runs nothing', (_label, argv) => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node mark.js'] } });
    expectRefusedSelection(repo, cli(repo.root, argv(repo)));
  });

  it('a repository root that is not a git repository exits non-zero (the code hash cannot be stamped)', () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-plain-')));
    roots.push(plain);
    fs.writeFileSync(path.join(plain, 'ok.js'), "console.log('ok');\n");
    const todo = path.join(plain, 'TODO.md');
    fs.writeFileSync(todo, todoText({ 'T-1.1': ['A. verify: node ok.js'] }));

    const out = cli(plain, [name, '--todo', todo, '--stories', 'T-1.1']);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
  });

  it('a thrown exception inside the runner exits non-zero instead of escaping or reporting success', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js'] } });
    const boom = () => { throw new Error('boom'); };

    const result = inProcess(name, repo, ['T-1.1'], { spawnSync: boom });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    if (fs.existsSync(repo.recordFile('T-1.1'))) {
      expect(repo.records('T-1.1').some(r => r.met === true)).toBe(false);
    }
  });
});

describe('run: an unwritable record directory fails closed (AC7)', () => {
  it('exits non-zero when the record directory cannot be created', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js'] } });
    fs.mkdirSync(path.join(repo.root, 'docs/.output/.state/telemetry'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, RECORD_DIR), 'a file where the directory must be');

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
  });

  it('exits non-zero when the record file itself cannot be written', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js'] } });
    fs.mkdirSync(path.join(repo.root, RECORD_DIR, 'T-1.1.json'), { recursive: true });

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// Review fixes (wave 1 security + code review). One describe per finding id.
// ════════════════════════════════════════════════════════════════════

const killSpy = () => {
  const calls = [];
  const fn = (pid) => { calls.push(pid); return true; };
  fn.calls = calls;
  return fn;
};
const withEnv = (patch, fn) => {
  const saved = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
};
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
};
const waitFor = (predicate, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  return predicate();
};

describe('review fix M1: path arguments must stay inside what the code hash covers', () => {
  const root = () => makeRepo({ extra: {
    'a.js': 'x\n', 'ok.js': 'x\n', 'docs/.output/x/check.js': "require('fs').writeFileSync('MARKER', 'ran');\n",
    'docs/work/todo/helper.js': 'x\n', 'docs/TODO_other.md': 'x\n', 'dist/built.js': 'x\n', 'src/real.js': 'x\n',
  } });

  it.each([
    ['an absolute path', 'node /tmp/x.js'],
    ['an absolute Windows path', 'node C:\\x\\y.js'],
    ['a UNC path', 'node \\\\server\\share\\x.js'],
    ['a parent-directory segment', 'node ../outside.js'],
    ['a parent-directory segment mid-path', 'node src/../../outside.js'],
    ['a backslash parent segment', 'node ..\\outside.js'],
    ['an absolute path as an option value', 'node a.js --out=/tmp/x'],
    ['a parent segment as an option value', 'node a.js --out=../x'],
    ['an absolute path for a git pathspec', 'git log -- /etc/passwd'],
    ['an absolute path for pytest', 'pytest /tmp/tests'],
  ])('refuses %s', (_label, command) => {
    expect(typeof subject().refusalReason(command, { root: root().root })).toBe('string');
  });

  it.each([
    'node docs/.output/x/check.js',
    'node ./docs/.output/x/check.js',
    'node docs/.output/does-not-exist-yet.js',
    'node docs/work/todo/helper.js',
    'node docs/TODO_other.md',
    'node Docs/.Output/x/check.js',
    'node .git/config',
    'node --test docs/.output/x',
    'pytest docs/work/todo',
  ])('refuses %s, a path the code hash does not cover', (command) => {
    const reason = subject().refusalReason(command, { root: root().root });
    expect(typeof reason).toBe('string');
    expect(reason).toMatch(/code hash|Git directory/);
  });

  it('refuses a path that Git ignores, and allows the same name once Git tracks it', () => {
    const repo = root();
    repo.write('.gitignore', 'docs/.output/.state/\nnode_modules\ndist/\n');
    repo.git('rm', '-q', '--cached', 'dist/built.js');
    expect(subject().refusalReason('node dist/built.js', { root: repo.root })).toMatch(/Git-ignored/);
    repo.git('add', '-f', 'dist/built.js');
    expect(subject().refusalReason('node dist/built.js', { root: repo.root })).toBeNull();
  });

  it('allows an ordinary tracked path, a not-yet-existing path, "." and a package pattern', () => {
    const repo = root();
    for (const command of ['node src/real.js', 'node src/not-yet.js', 'node --test src', 'git diff .', 'go test ./...', 'pytest .']) {
      expect(subject().refusalReason(command, { root: repo.root }), command).toBeNull();
    }
  });

  it.skipIf(isWindows)('refuses a symlink that leaves the repository, and one that points into an excluded folder', () => {
    const repo = root();
    fs.symlinkSync('/tmp', path.join(repo.root, 'outlink'));
    fs.symlinkSync(path.join(repo.root, 'docs/.output/x/check.js'), path.join(repo.root, 'link.js'));
    expect(subject().refusalReason('node outlink/x.js', { root: repo.root })).toMatch(/outside the repository/);
    expect(subject().refusalReason('node link.js', { root: repo.root })).toMatch(/code hash/);
  });

  it('fails closed when Git cannot say whether an existing path is ignored (not a repository)', () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-plain-')));
    roots.push(plain);
    fs.writeFileSync(path.join(plain, 'a.js'), 'x\n');
    expect(subject().refusalReason('node a.js', { root: plain })).toMatch(/cannot tell/);
  });

  it('a run records the refusal and never executes a script under docs/.output/', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Hidden check. verify: node docs/.output/x/check.js'] },
      extra: { 'docs/.output/x/check.js': "require('fs').writeFileSync('MARKER', 'ran');\n" },
    });

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(repo.records('T-1.1')[0]).toMatchObject({ status: 'refused', met: false, exit: null });
    expect(repo.exists('MARKER')).toBe(false);
  });
});

describe('review fix M2: the tree must not change while a binding runs', () => {
  const countSnapshots = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(e => e.event === 'start' && e.argv.includes('--show-toplevel')).length;

  it('a binding that writes an untracked file is recorded tree-changed and not met, with the reason in the tail', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Writes. verify: node mark.js'] } });
    const before = gr.codeTreeHash(repo.root).hash;

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    const rec = repo.records('T-1.1')[0];
    expect(rec).toMatchObject({ status: 'tree-changed', met: false, exit: 0 });
    expect(rec.outputTail).toMatch(/tree changed while the command ran/);
    expect(rec.codeHash).not.toBe(before);
    expect(rec.codeHash).toBe(gr.codeTreeHash(repo.root).hash);
    expect(out.json.stories[0].status).toBe('failed');
  });

  it('a binding that edits a tracked file is tree-changed too', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Edits. verify: node edit.js'] },
      extra: { 'edit.js': "require('fs').appendFileSync('ok.js', '// edited\\n');\n" },
    });

    runCli(repo);

    expect(repo.records('T-1.1')[0]).toMatchObject({ status: 'tree-changed', met: false });
  });

  it('a binding that changes only the ignored .state zone or docs/.output stays met', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Quiet. verify: node quiet.js'] },
      extra: { 'quiet.js': "const fs = require('fs'); fs.mkdirSync('docs/.output/.state/x', { recursive: true }); fs.writeFileSync('docs/.output/.state/x/f', '1'); fs.mkdirSync('docs/.output/plans', { recursive: true }); fs.writeFileSync('docs/.output/plans/p.md', '1');\n" },
    });

    const out = runCli(repo);

    expect(out.status).toBe(0);
    expect(repo.records('T-1.1')[0]).toMatchObject({ status: 'ran', met: true });
  });

  it('judges each binding against the tree the previous one left, not the tree from before the run', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Writes. verify: node mark.js', 'Quiet afterwards. verify: node ok.js'] } });

    runCli(repo);

    const [first, second] = repo.records('T-1.1');
    expect(first.status).toBe('tree-changed');
    expect(second).toMatchObject({ status: 'ran', met: true });
    expect(second.codeHash).toBe(first.codeHash);
  });

  it('a refused binding after a tree change is stamped with the current tree without a re-hash', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Writes. verify: node mark.js', 'Refused. verify: sh x.sh'] } });

    runCli(repo);

    const [first, second] = repo.records('T-1.1');
    expect(second).toMatchObject({ status: 'refused', met: false });
    expect(second.codeHash).toBe(first.codeHash);
  });

  it('a timeout keeps the timeout status even when the tree changed', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Hangs. verify: node ok.js'] } });
    const spy = spawnSpy((file, args, options) => {
      fs.writeFileSync(path.join(options.cwd, 'late.txt'), 'x');
      return { status: null, signal: 'SIGKILL', stdout: '', stderr: '', pid: 0, output: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) };
    });

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: spy, killProcessGroup: killSpy() });

    expect(result.stories[0].records[0]).toMatchObject({ status: 'timeout', met: false });
  });

  it('run hashes the tree once before the first command and once after each (N2); red hashes it once in total', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node a.js', 'B. verify: node b.js', 'C. verify: node c.js'] } });
    const trace = path.join(repo.root, 'docs/.output/.state/trace2.json');
    fs.mkdirSync(path.dirname(trace), { recursive: true });

    withEnv({ GIT_TRACE2_EVENT: trace }, () => { inProcess('run', repo, ['T-1.1'], { spawnSync: spawnSpy() }); });
    const runSnapshots = countSnapshots(trace);
    fs.unlinkSync(trace);
    withEnv({ GIT_TRACE2_EVENT: trace }, () => { inProcess('red', repo, ['T-1.1'], { spawnSync: spawnSpy() }); });
    const redSnapshots = countSnapshots(trace);

    expect(runSnapshots).toBe(4);
    expect(redSnapshots).toBe(1);
  });

  it('red does not hash per binding: a command that leaves a nested repository behind does not abort the probe', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['One. verify: node nest.js', 'Two. verify: node fail.js'] },
      extra: { 'nest.js': "const { execFileSync } = require('child_process'); require('fs').mkdirSync('nested'); execFileSync('git', ['init', '-q', 'nested']); require('fs').writeFileSync('nested/f', '1'); process.exit(1);\n" },
    });

    const out = redCli(repo);

    expect(out.json.errors).toEqual([]);
    expect(out.json.stories[0].results.map(r => r.verdict)).toEqual(['red', 'red']);
  });
});

describe('review fix M3 and F1: positive per-head allowlists', () => {
  const root = () => makeRepo({ extra: { 'a.js': 'x\n', 'node_modules/.bin/vitest': '#!/usr/bin/env node\n' } }).root;

  it.each([
    ['node --import=data:', 'node --import=data:text/javascript,process.exit(3) x.js'],
    ['node --import', 'node --import data:text/javascript,1 a.js'],
    ['node --require', 'node --require /tmp/x.js a.js'],
    ['node -r', 'node -r x a.js'],
    ['node --loader', 'node --loader x a.js'],
    ['node --experimental-loader', 'node --experimental-loader x a.js'],
    ['node --env-file', 'node --env-file=.env a.js'],
    ['node --run', 'node --run script'],
    ['node - (stdin script)', 'node -'],
    ['node --test-reporter-destination', 'node --test --test-reporter=spec --test-reporter-destination=out.txt a.js'],
    ['node --test-reporter with a module', 'node --test --test-reporter=./reporter.js a.js'],
    ['node --redirect-warnings', 'node --redirect-warnings=out.txt a.js'],
    ['node --cpu-prof-dir', 'node --cpu-prof-dir=prof a.js'],
    ['node --report-directory', 'node --report-directory=r a.js'],
    ['node --diagnostic-dir', 'node --diagnostic-dir=d a.js'],
    ['node --inspect', 'node --inspect a.js'],
    ['node with no script', 'node'],
    ['node with only a flag', 'node --no-warnings'],
    ['node -- separator', 'node -- a.js'],
    ['npm -C', 'npm test -C other'],
    ['npm --prefix after the subcommand', 'npm test --prefix other'],
    ['npm --node-options', 'npm test --node-options=--require=/x'],
    ['npm -w', 'npm run build -w ws'],
    ['npm --workspace', 'npm run build --workspace=ws'],
    ['npm --script-shell', 'npm test --script-shell=/bin/x'],
    ['npm run with no script', 'npm run'],
    ['npm test with a positional', 'npm test foo'],
    ['npm run with a path-like script name', 'npm run ../x'],
    ['pytest --basetemp', 'pytest --basetemp=docs'],
    ['pytest --basetemp separate', 'pytest --basetemp docs'],
    ['pytest -p', 'pytest -p evil'],
    ['pytest -c', 'pytest -c other.ini'],
    ['pytest --rootdir', 'pytest --rootdir=x'],
    ['pytest --confcutdir', 'pytest --confcutdir=x'],
    ['pytest -o', 'pytest -o cache_dir=x'],
    ['pytest --override-ini', 'pytest --override-ini=cache_dir=x'],
    ['pytest an option after --', 'pytest -- --basetemp=x'],
    ['go env', 'go env -w GOFLAGS=-toolexec=/tmp/x'],
    ['go run', 'go run x.go'],
    ['go generate', 'go generate'],
    ['go clean', 'go clean -modcache'],
    ['go install', 'go install x'],
    ['go -C', 'go -C other test'],
    ['go test -toolexec', 'go test -toolexec=/x ./...'],
    ['go test -exec', 'go test -exec /x ./...'],
    ['go test -o', 'go test -o out ./...'],
    ['go test -modfile', 'go test -modfile=x ./...'],
    ['go test -overlay', 'go test -overlay=x ./...'],
    ['go test -coverprofile', 'go test -coverprofile=c.out ./...'],
    ['go test -args', 'go test ./... -args -x'],
    ['cargo install', 'cargo install foo'],
    ['cargo publish', 'cargo publish'],
    ['cargo clean', 'cargo clean'],
    ['cargo run', 'cargo run'],
    ['cargo build', 'cargo build'],
    ['cargo --config first', 'cargo --config x test'],
    ['cargo +toolchain', 'cargo +nightly test'],
    ['cargo test --config', 'cargo test --config x'],
    ['cargo test -Z', 'cargo test -Z unstable-options'],
    ['cargo test --target-dir', 'cargo test --target-dir out'],
    ['cargo test harness --logfile', 'cargo test -- --logfile out.txt'],
    ['dotnet exec', 'dotnet exec x.dll'],
    ['dotnet run', 'dotnet run'],
    ['dotnet build', 'dotnet build'],
    ['dotnet tool install', 'dotnet tool install -g x'],
    ['dotnet nuget locals', 'dotnet nuget locals all --clear'],
    ['dotnet test --results-directory', 'dotnet test --results-directory out'],
    ['dotnet test --logger', 'dotnet test --logger trx'],
    ['dotnet test --settings', 'dotnet test --settings x.runsettings'],
    ['dotnet test -o', 'dotnet test -o out'],
    ['dotnet test after --', 'dotnet test -- RunConfiguration.X=1'],
  ])('refuses %s', (_label, command) => {
    const reason = subject().refusalReason(command, { root: root() });
    expect(typeof reason).toBe('string');
    expect(reason.startsWith('refused:')).toBe(true);
  });

  it.each([
    'node a.js', 'node --no-warnings a.js arg --flag', 'node --test', 'node --test a.js', 'node --test --test-only a.js',
    'node --test --test-name-pattern=adds a.js', 'node --test --test-name-pattern adds a.js', 'node --test --test-reporter=spec a.js',
    'node --test --test-reporter=dot', 'node --experimental-vm-modules a.js',
    'npm test', 'npm t', 'npm run build', 'npm run test:unit', 'npm run-script lint', 'npm test --silent', 'npm run build --if-present',
    'npm test -- --reporter=dot', 'npm run build -- -C elsewhere-is-a-script-argument',
    'pytest', 'pytest tests/a.py', 'pytest -q -x -k "a or b" tests', 'pytest -m slow --maxfail=2 --tb=short', 'pytest -- tests/a.py',
    'go test ./...', 'go test -v -race -run TestX -count=1 -timeout 30s ./pkg', 'go vet ./...',
    'cargo test', 'cargo check --workspace', 'cargo clippy --all-targets -- -D warnings', 'cargo test -p foo --no-fail-fast -- --nocapture --test-threads=1',
    'dotnet test', 'dotnet test x.sln --no-build --filter FullyQualifiedName~Foo -c Release -v minimal',
  ])('allows %s', (command) => {
    expect(subject().refusalReason(command, { root: root() }), command).toBeNull();
  });

  it('a run with node --import=data: refuses it and the inline code never runs', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ["Inline. verify: node --import=data:text/javascript,process.getBuiltinModule('fs').writeFileSync('MARKER','1') x.js => exit 1"] } });

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(repo.records('T-1.1')[0]).toMatchObject({ status: 'refused', met: false });
    expect(repo.exists('MARKER')).toBe(false);
  });

  it('a run with node --test --test-reporter-destination never creates the destination file', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Reporter. verify: node --test --test-reporter=spec --test-reporter-destination=DEST.txt ok.js'] } });

    runCli(repo);

    expect(repo.records('T-1.1')[0].status).toBe('refused');
    expect(repo.exists('DEST.txt')).toBe(false);
  });

  it('a real npm script runs through npm run with its arguments', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Script. verify: npm run show -- one two'] },
      extra: { 'package.json': JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { show: 'node args.js' } }) },
    });

    const out = runCli(repo);

    expect(repo.records('T-1.1')[0], JSON.stringify(out.json)).toMatchObject({ status: 'ran', met: true });
    expect(JSON.parse(repo.records('T-1.1')[0].outputTail.trim().split('\n').pop())).toEqual(['one', 'two']);
  });
});

describe('review fix m1: the head is resolved from PATH, never from the repository', () => {
  const exe = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, name); fs.writeFileSync(file, '#!/bin/sh\n'); fs.chmodSync(file, 0o755); return file; };

  it.skipIf(isWindows)('skips empty, "." and relative PATH entries and entries inside the repository', () => {
    const repo = makeRepo();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-bin-')));
    roots.push(outside);
    exe(repo.root, 'tool'); exe(path.join(repo.root, 'bin'), 'tool'); exe(outside, 'tool');

    const env = { PATH: ['', '.', 'bin', path.join(repo.root, 'bin'), repo.root, outside].join(path.delimiter) };

    expect(subject().resolveHead('tool', { root: repo.root, env })).toEqual({ file: path.join(outside, 'tool') });
  });

  it.skipIf(isWindows)('reports not found (never the repository copy) when only the repository holds the tool', () => {
    const repo = makeRepo();
    exe(repo.root, 'tool');

    const found = subject().resolveHead('tool', { root: repo.root, env: { PATH: `.${path.delimiter}${repo.root}` } });

    expect(found.file).toBeUndefined();
    expect(found.error).toMatch(/not found on PATH/);
  });

  it('on a Windows-style lookup tries .exe before .cmd and finds only files', () => {
    const repo = makeRepo();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-win-')));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, 'tool.cmd'), 'x');
    fs.mkdirSync(path.join(dir, 'other.exe'));
    fs.writeFileSync(path.join(dir, 'tool.exe'), 'x');

    const env = { Path: dir };

    expect(subject().resolveHead('tool', { root: repo.root, env, platform: 'win32' })).toEqual({ file: path.join(dir, 'tool.exe') });
    expect(subject().resolveHead('other', { root: repo.root, env, platform: 'win32' }).error).toMatch(/not found/);
  });

  it('node resolves to this process executable', () => {
    expect(subject().resolveHead('node', { root: os.tmpdir(), env: {} })).toEqual({ file: process.execPath });
  });

  it.skipIf(isWindows)('a run hands the spawner an absolute path outside the repository even when PATH holds "."', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Status. verify: git status'] } });
    exe(repo.root, 'git');
    const spy = spawnSpy();

    withEnv({ PATH: `.${path.delimiter}${process.env.PATH}` }, () => { inProcess('run', repo, ['T-1.1'], { spawnSync: spy }); });

    expect(path.isAbsolute(spy.calls[0].file)).toBe(true);
    expect(spy.calls[0].file.startsWith(repo.root)).toBe(false);
    expect(path.basename(spy.calls[0].file)).toBe('git');
  });

  it.skipIf(isWindows)('a head that cannot be resolved is an unmet record (ENOENT) and red calls it infra, without spawning', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Python. verify: pytest tests'] } });
    const spy = spawnSpy();
    // A PATH holding only git (the toolkit's own hash needs it), so pytest cannot be found whatever else is installed.
    const gitOnly = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-gitonly-')));
    roots.push(gitOnly);
    fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(gitOnly, 'git'));

    const ran = withEnv({ PATH: gitOnly }, () => inProcess('run', repo, ['T-1.1'], { spawnSync: spy }));
    const probed = withEnv({ PATH: gitOnly }, () => inProcess('red', repo, ['T-1.1'], { spawnSync: spy }));

    expect(spy.calls).toHaveLength(0);
    expect(ran.stories[0].records[0]).toMatchObject({ status: 'ran', met: false, exit: null });
    expect(ran.stories[0].records[0].outputTail).toMatch(/ENOENT/);
    expect(probed.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'ENOENT' });
  });
});

describe('review fix m2: the child environment is scrubbed', () => {
  it('childEnvironment drops the injection variables, keeps the rest and turns off git optional locks', () => {
    const env = subject().childEnvironment({
      PATH: '/bin', HOME: '/h', GIT_DIR: '/x', GIT_WORK_TREE: '/x', GIT_INDEX_FILE: '/x', GIT_EXTERNAL_DIFF: '/x', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_PARAMETERS: 'x', git_dir: '/lower', NODE_OPTIONS: '--require /x', NODE_PATH: '/x', npm_config_prefix: '/x', NPM_CONFIG_PREFIX: '/x',
      PYTEST_ADDOPTS: '--basetemp=x', GOFLAGS: '-toolexec=/x', RUSTC_WRAPPER: '/x', DOTNET_STARTUP_HOOKS: '/x', LD_PRELOAD: '/x', KEEP_ME: 'yes',
    });
    expect(Object.keys(env).sort()).toEqual(['GIT_OPTIONAL_LOCKS', 'HOME', 'KEEP_ME', 'PATH']);
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('a run passes the scrubbed environment to the spawner', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Env. verify: node ok.js'] } });
    const spy = spawnSpy();

    withEnv({ GIT_DIR: '/nowhere', NODE_OPTIONS: '--no-warnings', npm_config_prefix: '/nowhere', KEEP_ME: 'yes' }, () => { inProcess('run', repo, ['T-1.1'], { spawnSync: spy }); });

    const env = spy.calls[0].options.env;
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it('a real child never sees the injected variables', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Env. verify: node envprobe.js'] },
      extra: { 'envprobe.js': "process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => /^(GIT_|NODE_OPTIONS|npm_config_)/i.test(k)).sort()));\n" },
    });

    const out = runCli(repo, ['T-1.1'], { env: { GIT_DIR: '/nowhere', NODE_OPTIONS: '--no-warnings', npm_config_prefix: '/nowhere' } });

    expect(out.status).toBe(0);
    expect(JSON.parse(repo.records('T-1.1')[0].outputTail)).toEqual(['GIT_OPTIONAL_LOCKS']);
  });
});

describe('review fix m3: a timeout kills the whole process group', () => {
  it('killProcessGroup ignores a pid that cannot be a group leader, so kill(-1) is unreachable', () => {
    const kills = [];
    for (const pid of [undefined, null, 'x', 0, 1, -1, 1.5]) expect(subject().killProcessGroup(pid, { platform: 'linux', kill: (...a) => kills.push(a) })).toBe(false);
    expect(kills).toEqual([]);
  });

  it('killProcessGroup signals the negative pid on POSIX and survives an already-exited group', () => {
    const kills = [];
    expect(subject().killProcessGroup(4242, { platform: 'linux', kill: (...a) => kills.push(a) })).toBe(true);
    expect(kills).toEqual([[-4242, 'SIGKILL']]);
    expect(subject().killProcessGroup(4242, { platform: 'linux', kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } })).toBe(true);
  });

  it('killProcessGroup asks taskkill for the whole tree on Windows', () => {
    const calls = [];
    expect(subject().killProcessGroup(4242, { platform: 'win32', spawn: (file, args, options) => calls.push({ file, args, options }) })).toBe(true);
    expect(calls).toEqual([{ file: 'taskkill', args: ['/T', '/F', '/PID', '4242'], options: { windowsHide: true, stdio: 'ignore' } }]);
  });

  it.skipIf(isWindows)('a timeout is followed by a group kill of the child pid, and children start in their own group', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Hangs. verify: node ok.js'] } });
    const spy = spawnSpy({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', pid: 4242, output: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) });
    const kills = killSpy();

    inProcess('run', repo, ['T-1.1'], { spawnSync: spy, killProcessGroup: kills });

    expect(spy.calls[0].options.detached).toBe(true);
    expect(kills.calls).toEqual([4242]);
  });

  it('a normal exit does not kill any group', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Fine. verify: node ok.js'] } });
    const kills = killSpy();

    inProcess('run', repo, ['T-1.1'], { spawnSync: spawnSpy({ ...OK_RESULT, pid: 4242 }), killProcessGroup: kills });

    expect(kills.calls).toEqual([]);
  });

  it.skipIf(isWindows)('a real grandchild that outlives the timed-out child is killed', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Orphans. verify: node orphan.js'] },
      extra: { 'orphan.js': "const { spawn } = require('child_process');\nconst child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });\nrequire('fs').writeFileSync('GRANDCHILD_PID', String(child.pid));\nsetInterval(() => {}, 1000);\n" },
    });

    runCli(repo, ['T-1.1'], { env: { AC_VERIFY_TIMEOUT_MS: '800' } });

    const pid = Number(fs.readFileSync(path.join(repo.root, 'GRANDCHILD_PID'), 'utf8'));
    try {
      expect(repo.records('T-1.1')[0].status).toBe('timeout');
      expect(waitFor(() => !alive(pid))).toBe(true);
    } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  });
});

describe('review fix N1: a signal-killed child is not a real red', () => {
  it('injected: classified infra "killed by signal" with the signal named', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Killed. verify: node ok.js'] } });
    const spy = spawnSpy({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', pid: 1, output: null });

    const result = inProcess('red', repo, ['T-1.1'], { spawnSync: spy });

    expect(result.exitCode).not.toBe(0);
    expect(result.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'killed by signal', signal: 'SIGKILL' });
    expect(result.stories[0].status).toBe('not-red');
  });

  it.skipIf(isWindows)('a real child that kills itself is infra, not red', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Suicide. verify: node sigkill.js'] } });

    const out = redCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.stories[0].results[0]).toMatchObject({ verdict: 'infra', infraClass: 'killed by signal' });
  });
});

describe('review fix n1: the record directory guard runs before anything is created', () => {
  it.skipIf(isWindows)('a symlinked .state zone is refused and nothing is created at its target', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js'] } });
    const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-target-')));
    roots.push(target);
    fs.mkdirSync(path.join(repo.root, 'docs/.output'), { recursive: true });
    fs.symlinkSync(target, path.join(repo.root, 'docs/.output/.state'));
    // The fixture .gitignore pattern ends in a slash and so ignores only a directory; ignore the link itself too,
    // otherwise the code hash fails first and the guard under test is never reached.
    fs.appendFileSync(path.join(repo.root, '.git/info/exclude'), 'docs/.output/.state\n');

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.ok).toBe(false);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

describe('review fix n2: the temp file name is unpredictable and never follows a planted link', () => {
  it.skipIf(isWindows)('a symlink planted at the old predictable temp name is not written through', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js'] } });
    const victim = path.join(repo.root, 'VICTIM.txt');
    fs.writeFileSync(victim, 'untouched');
    fs.mkdirSync(path.dirname(repo.recordFile('T-1.1')), { recursive: true });
    fs.symlinkSync(victim, `${repo.recordFile('T-1.1')}.${process.pid}.tmp`);

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: spawnSpy() });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
    expect(repo.records('T-1.1')).toHaveLength(1);
  });
});

describe('review fix n3: output past the buffer cap is infrastructure, not a crash', () => {
  const overflow = { status: null, signal: 'SIGTERM', stdout: 'partial output', stderr: '', pid: 4242, output: null, error: Object.assign(new Error('spawnSync node ENOBUFS'), { code: 'ENOBUFS' }) };

  it('run records the error code in the tail, keeps exit null and kills the group', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Chatty. verify: node ok.js'] } });
    const kills = killSpy();

    const result = inProcess('run', repo, ['T-1.1'], { spawnSync: spawnSpy(overflow), killProcessGroup: kills });

    expect(result.stories[0].records[0]).toMatchObject({ status: 'ran', met: false, exit: null });
    expect(result.stories[0].records[0].outputTail).toMatch(/\[spawn error ENOBUFS\]/);
    expect(kills.calls).toEqual([4242]);
  });

  it('red classifies it infra ENOBUFS and does not abort the probe', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Chatty. verify: node ok.js', 'Real. verify: node fail.js'] } });
    const results = [overflow, { status: 1, signal: null, stdout: 'FAIL boom', stderr: '', pid: 1, output: null }];
    let at = 0;

    const result = inProcess('red', repo, ['T-1.1'], { spawnSync: spawnSpy(() => results[at++]), killProcessGroup: killSpy() });

    expect(result.errors).toEqual([]);
    expect(result.stories[0].results.map(r => r.verdict)).toEqual(['infra', 'red']);
    expect(result.stories[0].results[0].infraClass).toBe('ENOBUFS');
  });
});

describe('review fix n4: output is redacted before it is recorded or printed', () => {
  // Built at run time so this file never contains a token-shaped literal.
  const TOKEN = ['ghp', '_', 'x9Qk2Lm7Zp4Rt8Vb3Nc6Yd1Hf5Gs0Jw2Ae9Kq'].join('');

  it('run: a token in the output never reaches the record or the printed document', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Leaks. verify: node leak.js'] },
      extra: { 'leak.js': `process.stdout.write('before ' + ${JSON.stringify(TOKEN)} + ' after\\n');\n` },
    });

    const out = runCli(repo);

    expect(out.status).toBe(0);
    const tail = repo.records('T-1.1')[0].outputTail;
    expect(tail).toContain('<REDACTED');
    expect(tail).toContain('before');
    expect(tail).not.toContain(TOKEN);
    expect(out.stdout).not.toContain(TOKEN);
    expect(fs.readFileSync(repo.recordFile('T-1.1'), 'utf8')).not.toContain(TOKEN);
  });

  it('run: a token that straddles the 2 KB cut is still masked', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Leaks. verify: node leak.js'] },
      extra: { 'leak.js': `process.stdout.write(${JSON.stringify(TOKEN)} + 'y'.repeat(2030));\n` },
    });

    runCli(repo);

    const tail = repo.records('T-1.1')[0].outputTail;
    expect(tail).not.toContain(TOKEN.slice(0, 20));
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('red: the digest never carries the token', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Leaks. verify: node leakfail.js'] },
      extra: { 'leakfail.js': `console.error('FAIL token ' + ${JSON.stringify(TOKEN)}); process.exit(1);\n` },
    });

    const out = redCli(repo);

    expect(out.json.stories[0].results[0].verdict).toBe('red');
    expect(out.json.stories[0].results[0].digest).toContain('<REDACTED');
    expect(out.stdout).not.toContain(TOKEN);
  });
});

describe('review fix n5: the TODO must be inside the repository', () => {
  it.each(['run', 'red'])('%s refuses a TODO outside the root and runs nothing', (name) => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js'] } });
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-todo-')));
    roots.push(outside);
    const elsewhere = path.join(outside, 'TODO.md');
    fs.writeFileSync(elsewhere, todoText({ 'T-1.1': ['Evil. verify: node mark.js'] }));

    const out = cli(repo.root, [name, '--todo', elsewhere, '--stories', 'T-1.1']);

    expect(out.status).not.toBe(0);
    expect(out.json.errors.map(e => e.code)).toEqual(['TODO_OUTSIDE_ROOT']);
    expect(repo.exists('MARKER')).toBe(false);
  });

  it.skipIf(isWindows)('a symlinked directory that leads out of the repository is refused as well', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: node ok.js'] } });
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-todo-')));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, 'TODO.md'), todoText({ 'T-1.1': ['Evil. verify: node mark.js'] }));
    fs.symlinkSync(outside, path.join(repo.root, 'linked'));

    const out = cli(repo.root, ['run', '--todo', path.join(repo.root, 'linked/TODO.md'), '--stories', 'T-1.1']);

    expect(out.json.errors.map(e => e.code)).toEqual(['TODO_OUTSIDE_ROOT']);
    expect(repo.exists('MARKER')).toBe(false);
  });
});

describe('review fix n6: git cannot read outside the repository or run a configured program', () => {
  it.each(['--no-index', '--contents=x', '--ext-diff', '--textconv', '--output=out.txt'])('refuses git diff %s', (option) => {
    expect(typeof subject().refusalReason(`git diff ${option} HEAD`, { root: makeRepo().root })).toBe('string');
  });

  it('refuses git blame --contents and git diff --no-index against an outside file', () => {
    const root = makeRepo().root;
    expect(typeof subject().refusalReason('git blame --contents x.txt ok.js', { root })).toBe('string');
    expect(typeof subject().refusalReason('git diff --no-index /etc/passwd /dev/null', { root })).toBe('string');
  });

  it('inserts --no-ext-diff --no-textconv right after diff, show, log and diff-tree, and nowhere else', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['A. verify: git diff HEAD', 'B. verify: git show HEAD', 'C. verify: git log -1', 'D. verify: git diff-tree HEAD', 'E. verify: git status'] } });
    const spy = spawnSpy();

    inProcess('run', repo, ['T-1.1'], { spawnSync: spy });

    expect(spy.calls.map(c => c.args)).toEqual([
      ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'],
      ['show', '--no-ext-diff', '--no-textconv', 'HEAD'],
      ['log', '--no-ext-diff', '--no-textconv', '-1'],
      ['diff-tree', '--no-ext-diff', '--no-textconv', 'HEAD'],
      ['status'],
    ]);
  });

  it.skipIf(isWindows)('a configured diff.external program does not run for git diff', () => {
    const repo = makeRepo({
      stories: { 'T-1.1': ['Diff. verify: git diff HEAD'] },
      extra: { 'ext.js': "require('fs').writeFileSync('EXT_RAN', '1');\n", 'tracked.txt': 'one\n' },
    });
    repo.git('config', 'diff.external', `node ${path.join(repo.root, 'ext.js')}`);
    repo.write('tracked.txt', 'two\n');

    const out = runCli(repo);

    expect(repo.exists('EXT_RAN')).toBe(false);
    expect(out.json.stories[0].records[0]).toMatchObject({ status: 'ran', met: true });
  });
});

describe('review fix m6 and F8 (end to end): a defanged or malformed binding fails the whole selection', () => {
  it.each([
    ['a capital Verify:', 'Defanged. Verify: node mark.js'],
    ['a full-width colon', 'Defanged. verify\uFF1A node mark.js'],
    ['a backtick-wrapped binding', 'Defanged. `verify: node mark.js`'],
    ['a bold-labelled binding with a command', 'Defanged. **verify:** node mark.js'],
    ['a checkbox marker inside the command', 'Marker. verify: node mark.js [x]'],
  ])('%s is BAD_VERIFY and nothing runs', (_label, bullet) => {
    const repo = makeRepo({ stories: { 'T-1.1': ['Good. verify: node ok.js', bullet] } });

    const out = runCli(repo);

    expect(out.status).not.toBe(0);
    expect(out.json.errors.map(e => e.code)).toEqual(['BAD_VERIFY']);
    expect(repo.exists('MARKER')).toBe(false);
    expect(fs.existsSync(repo.recordFile('T-1.1'))).toBe(false);
  });

  it('a bold prose label is a manual criterion, not an error', () => {
    const repo = makeRepo({ stories: { 'T-1.1': ['**E2E verify:** seed a store, run it, check the log => exit 0'] } });

    const out = runCli(repo);

    expect(out.status).toBe(0);
    expect(out.json.stories[0]).toMatchObject({ status: 'no-bindings', bindings: 0, manual: 1 });
  });
});

// ════════════════════════════════════════════════════════════════════
// SF-1.2: `freeze`, `check` and `unfreeze` — tamper evidence for check files and `verify:` lines.
//
// PINNED CONTRACT (the tests are the spec; the implementer must match these names and shapes):
//
// Module exports, added to the existing ones, same opts shape as run/red plus an optional reason:
//   freeze(opts)   -> result   opts = { root, todo, stories, reason? }
//   check(opts)    -> result   opts = { root, todo, stories }
//   unfreeze(opts) -> result   opts = { root, todo, stories }
//   Every one is guarded like run/red: an exception inside becomes { ok: false, exitCode: 2, errors: [{ code: 'EXCEPTION' }] }.
//
// CLI verbs: `freeze --todo T --stories S [--reason R]`, `check --todo T --stories S`, `unfreeze --todo T --stories S`.
//   `--reason` is accepted by `freeze` only. One JSON document on stdout always; exit 0 only on success, 1 for a
//   tamper finding, non-zero (2) for invalid input, a refusal or an internal error.
//
// Result: { ok, exitCode, errors: [{ code, story?, file?, acLine?, message }], warnings: string[], stories: [...] }
//   `warnings` is ALWAYS an array (empty when there is nothing to warn about). `file` is the repo-relative,
//   forward-slash path as written in the Files list.
//   Error codes: FROZEN_FILE_CHANGED, FROZEN_FILE_MISSING (a deleted or renamed file; `file` is the frozen path),
//   VERIFY_CHANGED (`acLine` is the current TODO line of the first changed binding when one binding was edited in
//   place), BASELINE_MISSING, BASELINE_MALFORMED, REASON_REQUIRED (freeze over an existing baseline without a
//   non-blank reason). Selection failures reuse the existing codes (unknown story, BAD_VERIFY, ...).
//
// Baseline `docs/.output/.state/telemetry/ac-verify/{storyId}.freeze.json`, one per selected story:
//   { story, files: { '<repo-relative path>': '<sha256 hex of the raw file bytes>' },
//     verifyHash: '<sha256 hex>', history: [{ at: ISO-8601, reason?: string }, ...] }
//   `files` holds the TEST files of that story's Files list only (a path containing `__tests__/`, `/tests/`, `.test.`
//   or `.spec.`, or whose basename starts with `test_`). `verifyHash` covers the story's `verify:` bindings (command
//   and expected exit) and nothing else: ticking a box, editing prose or shifting lines never changes it.
//   The exact formula of verifyHash and any extra baseline fields are the implementer's; the tests only require a
//   64-hex string that moves with a binding edit and stays put otherwise.
//
// freeze calls setFrozen with the ABSOLUTE path of every baseline file, MERGED into the existing freeze-state list
// (pre-existing entries survive) and records which entries it added; unfreeze removes exactly those, across a
// re-baseline too, and leaves the baseline in place.
//
// Fail closed (non-zero, nothing half-done): a Files entry that is absolute or climbs out of the repository, an
// unknown story, BAD_VERIFY, a symlinked freeze file or record-directory ancestor, a baseline that cannot be
// written (freeze-state is left unchanged then), an unreadable frozen file, a malformed or missing baseline.
//
// NOT COVERED: a listed test file that does not exist when `freeze` runs (behaviour is the implementer's: refuse or
// warn); a root-level `tests/x.js` (no leading slash, so the literal `/tests/` rule is ambiguous); a malformed
// baseline healed by `freeze --reason`; unfreeze of a story that was never frozen; a test file shared by two
// stories (unfreeze of one drops the freeze of the other); a symlinked frozen test file; Windows (symlink and chmod
// cases are skipped there); two concurrent freeze calls.

const nodeCrypto = require('node:crypto');
const HOOK = path.resolve('.agents/hooks/path-guardrail.cjs');
const STATE_REL = 'docs/.output/.state/freeze-state.json';
const sha256 = (bytes) => nodeCrypto.createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** TODO text with a Files list per story. `stories[id] = { criteria: string[], files: string[], notes?: string }`. */
function freezeTodo(stories) {
  const parts = ['# TODO: freeze fixture\n'];
  for (const [id, story] of Object.entries(stories)) {
    const bullets = story.criteria.map((c) => `    * [ ] ${c}\n`).join('');
    const files = story.files.map((f) => `    * \`${f}\` — fixture file\n`).join('');
    const notes = story.notes ? `  * **Research notes:** ${story.notes}\n` : '';
    parts.push(`* **Story ${id} (S): Title ${id}**\n  * **AC:**\n${bullets}  * **Files:**\n${files}  * **Estimate:** S\n${notes}`);
  }
  return parts.join('\n');
}

const A_TEST = 'src/__tests__/a.test.js';
const B_SPEC = 'src/b.spec.js';
const A_BODY = 'expect(1).toBe(1);\n';
const B_BODY = 'line one\r\nline two\r\n'; // CRLF: the blob is the raw bytes, never newline-normalised
const FREEZE_FILES = { [A_TEST]: A_BODY, [B_SPEC]: B_BODY, 'src/impl.js': 'module.exports = 1;\n' };
const BASIC_CRITERIA = ['Adds the thing. verify: node ok.js', 'Fails loudly. verify: node exit.js 3 => exit 3', 'A manual criterion with no binding'];

function freezeRepo({ stories, extra = {} } = {}) {
  const spec = stories || { 'T-1.1': { criteria: BASIC_CRITERIA, files: [A_TEST, B_SPEC, 'src/impl.js'] } };
  return makeRepo({ rawTodo: freezeTodo(spec), extra: { ...FREEZE_FILES, ...extra } });
}

const freezeFile = (repo, id = 'T-1.1') => path.join(repo.root, RECORD_DIR, `${id}.freeze.json`);
const baseline = (repo, id = 'T-1.1') => JSON.parse(fs.readFileSync(freezeFile(repo, id), 'utf8'));
const stateFile = (repo) => path.join(repo.root, STATE_REL);
const frozenList = (repo) => (fs.existsSync(stateFile(repo)) ? JSON.parse(fs.readFileSync(stateFile(repo), 'utf8')).frozen : []);
const abs = (repo, rel) => path.join(repo.root, rel);

/** The real CLI with an optional `--reason`. */
function sf(repo, name, ids = ['T-1.1'], { reason, env } = {}) {
  const args = [name, '--todo', repo.todoPath, '--stories', ids.join(','), ...(reason === undefined ? [] : ['--reason', reason])];
  return cli(repo.root, args, { env });
}
const freezeCli = (repo, ids, options) => sf(repo, 'freeze', ids, options);
const checkCli = (repo, ids, options) => sf(repo, 'check', ids, options);
const unfreezeCli = (repo, ids, options) => sf(repo, 'unfreeze', ids, options);
const codesOf = (out) => out.json.errors.map((e) => e.code);

/** A fresh repo that is already frozen (the CLI must exit 0, otherwise the fixture itself is the failure). */
function frozenRepo(options) {
  const repo = freezeRepo(options);
  const out = freezeCli(repo, options && options.ids);
  expect(out.status, `fixture freeze must succeed: ${out.stdout}`).toBe(0);
  return repo;
}

const OVERRIDE_VARS = ['AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR'];
/** Run `fn` with the project-root environment pointing at `root`, so freeze-state resolves inside the fixture. */
function withProjectRoot(root, fn) {
  const saved = {};
  for (const key of ['CLAUDE_PROJECT_DIR', ...OVERRIDE_VARS]) saved[key] = process.env[key];
  for (const key of OVERRIDE_VARS) delete process.env[key];
  process.env.CLAUDE_PROJECT_DIR = root;
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const exported = (name) => {
  const fn = subject()[name];
  expect(typeof fn, `ac-verify.js must export ${name}`).toBe('function');
  return fn;
};
const inProcessFs = (name, repo, ids, extra = {}) => withProjectRoot(repo.root, () => exported(name)({ root: repo.root, todo: repo.todoPath, stories: ids, env: {}, ...extra }));

/** The real path hook, fed a PreToolUse payload. Exit 2 means blocked. */
function hookWrite(repo, tool, file) {
  const toolInput = tool === 'Edit' ? { file_path: file, old_string: 'a', new_string: 'b' } : { file_path: file, content: 'x' };
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput }), cwd: repo.root, env: childEnv(repo.root),
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
}

/** Positive control: the verb itself works on a clean fixture, so a refusal below is the verb refusing, not a missing verb. */
function expectVerbWorks(name) {
  const clean = freezeRepo();
  if (name !== 'freeze') expect(freezeCli(clean).status, 'control: freeze on a clean fixture must succeed').toBe(0);
  const out = sf(clean, name);
  expect(out.status, `control: ${name} on a clean fixture must succeed: ${out.stdout}`).toBe(0);
}

describe('SF-1.2 freeze/check/unfreeze', () => {
  describe('module shape and CLI verbs', () => {
    it('exports freeze, check and unfreeze next to run and red', () => {
      const mod = subject();
      for (const name of ['freeze', 'check', 'unfreeze', 'run', 'red']) expect(typeof mod[name], name).toBe('function');
    });

    it.each(['check', 'unfreeze'])('%s rejects --reason (only freeze takes one) and changes nothing', (verbName) => {
      const repo = frozenRepo();
      const before = fs.readFileSync(freezeFile(repo), 'utf8');
      const stateBefore = fs.readFileSync(stateFile(repo), 'utf8');

      const out = sf(repo, verbName, ['T-1.1'], { reason: 'because' });

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(fs.readFileSync(freezeFile(repo), 'utf8')).toBe(before);
      expect(fs.readFileSync(stateFile(repo), 'utf8')).toBe(stateBefore);
    });
  });

  // ── AC1 ───────────────────────────────────────────────────────────
  describe('freeze writes the baseline and freezes the check files (AC1)', () => {
    it('writes {storyId}.freeze.json with the sha256 of each test file as raw bytes and a sha256 verifyHash', () => {
      const repo = freezeRepo();

      const out = freezeCli(repo);

      expect(out.status).toBe(0);
      expect(out.json).toMatchObject({ ok: true, exitCode: 0, errors: [], warnings: [] });
      const base = baseline(repo);
      expect(base.story).toBe('T-1.1');
      expect(base.files).toEqual({
        [A_TEST]: sha256(Buffer.from(A_BODY)),
        [B_SPEC]: sha256(Buffer.from(B_BODY)),
      });
      expect(base.verifyHash).toMatch(HEX64);
      expect(Array.isArray(base.history)).toBe(true);
      for (const entry of base.history) expect(new Date(entry.at).toISOString()).toBe(entry.at);
    });

    it('classifies test files by path: __tests__/, /tests/, .test., .spec. and a test_ basename; every other Files entry is ignored', () => {
      const tests = ['lib/__tests__/one.js', 'pkg/tests/two.js', 'src/three.test.js', 'src/four.spec.ts', 'py/test_five.py'];
      // contest.js and latest_tool.js contain the letters "test" / "test_" but are not test files (basename rule).
      const others = ['src/impl.js', 'src/contest.js', 'src/latest_tool.js', 'docs/notes.md'];
      const extra = Object.fromEntries([...tests, ...others].map((rel) => [rel, `body of ${rel}\n`]));
      const repo = freezeRepo({ stories: { 'T-1.1': { criteria: ['A. verify: node ok.js'], files: [...tests, ...others] } }, extra });

      const out = freezeCli(repo);

      expect(out.status).toBe(0);
      expect(Object.keys(baseline(repo).files).sort()).toEqual([...tests].sort());
      expect(frozenList(repo).sort()).toEqual(tests.map((rel) => abs(repo, rel)).sort());
    });

    it('ignores a path that only appears in another field of the story (a Research note), not in its Files list', () => {
      const repo = freezeRepo({
        stories: { 'T-1.1': { criteria: ['A. verify: node ok.js'], files: [A_TEST], notes: 'see `src/b.spec.js` for the old shape' } },
      });

      const out = freezeCli(repo);

      expect(out.status).toBe(0);
      expect(Object.keys(baseline(repo).files)).toEqual([A_TEST]);
      expect(frozenList(repo)).toEqual([abs(repo, A_TEST)]);
    });

    it('freezes the absolute path of every baseline file in freeze-state and leaves a non-test Files entry unfrozen (isFrozen, exact match)', () => {
      const repo = freezeRepo();

      freezeCli(repo);

      const { isFrozen } = require('../_lib/freeze-state');
      withProjectRoot(repo.root, () => {
        expect(isFrozen(abs(repo, A_TEST))).toBe(true);
        expect(isFrozen(abs(repo, B_SPEC))).toBe(true);
        expect(isFrozen(abs(repo, 'src/impl.js'))).toBe(false);
      });
      expect(frozenList(repo).sort()).toEqual([abs(repo, A_TEST), abs(repo, B_SPEC)].sort());
    });

    it.each(['Write', 'Edit'])('the real path-guardrail hook blocks a %s to a frozen check file but not to the implementation file', (tool) => {
      const repo = freezeRepo();
      expect(hookWrite(repo, tool, abs(repo, A_TEST)).status, 'control: not blocked before the freeze').toBe(0);

      freezeCli(repo);
      const blocked = hookWrite(repo, tool, abs(repo, A_TEST));
      const allowed = hookWrite(repo, tool, abs(repo, 'src/impl.js'));

      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain(abs(repo, A_TEST));
      expect(allowed.status).toBe(0);
    });

    it('freezes and baselines each selected story separately, with only its own files and verify lines', () => {
      const repo = freezeRepo({
        stories: {
          'T-1.1': { criteria: ['One. verify: node ok.js'], files: [A_TEST] },
          'T-1.2': { criteria: ['Two. verify: node exit.js 3 => exit 3'], files: [B_SPEC] },
        },
      });

      const out = freezeCli(repo, ['T-1.1', 'T-1.2']);

      expect(out.status).toBe(0);
      expect(Object.keys(baseline(repo, 'T-1.1').files)).toEqual([A_TEST]);
      expect(Object.keys(baseline(repo, 'T-1.2').files)).toEqual([B_SPEC]);
      expect(baseline(repo, 'T-1.1').verifyHash).not.toBe(baseline(repo, 'T-1.2').verifyHash);
      expect(frozenList(repo).sort()).toEqual([abs(repo, A_TEST), abs(repo, B_SPEC)].sort());
    });

    it('a Files list with no test files yields a baseline holding only the verify hash and prints a warning', () => {
      const repo = freezeRepo({ stories: { 'T-1.1': { criteria: ['A. verify: node ok.js'], files: ['src/impl.js'] } } });

      const out = freezeCli(repo);

      expect(out.status).toBe(0);
      const base = baseline(repo);
      expect(base.files).toEqual({});
      expect(base.verifyHash).toMatch(HEX64);
      expect(out.json.warnings).toHaveLength(1);
      expect(out.json.warnings[0]).toMatch(/no test files/i);
      expect(frozenList(repo)).toEqual([]);
    });

    it('works through the in-process export with the same result shape as the CLI', () => {
      const repo = freezeRepo();

      const result = inProcessFs('freeze', repo, ['T-1.1']);

      expect(result).toMatchObject({ ok: true, exitCode: 0, errors: [], warnings: [] });
      expect(Object.keys(baseline(repo).files).sort()).toEqual([A_TEST, B_SPEC]);
    });

    it.each([
      ['an absolute path', (repo) => path.join(path.dirname(repo.root), 'outside.test.js')],
      ['a parent-directory segment', () => 'src/../../outside.test.js'],
    ])('refuses a Files entry that is %s: non-zero, no baseline, nothing frozen', (_label, entry) => {
      expectVerbWorks('freeze');
      const repo = freezeRepo();
      const outside = path.join(path.dirname(repo.root), 'outside.test.js');
      fs.writeFileSync(outside, 'outside\n');
      roots.push(outside);
      fs.writeFileSync(repo.todoPath, freezeTodo({ 'T-1.1': { criteria: ['A. verify: node ok.js'], files: [A_TEST, entry(repo)] } }));

      const out = freezeCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(fs.existsSync(freezeFile(repo))).toBe(false);
      expect(frozenList(repo)).toEqual([]);
    });

    it.each([
      ['an unknown story id', ['T-9.9'], null],
      ['a malformed verify binding (BAD_VERIFY)', ['T-1.1'], 'A. Verify: node ok.js'],
    ])('%s fails the whole selection closed: non-zero, no baseline, nothing frozen', (_label, ids, badBullet) => {
      expectVerbWorks('freeze');
      const repo = freezeRepo();
      if (badBullet) fs.writeFileSync(repo.todoPath, freezeTodo({ 'T-1.1': { criteria: ['Good. verify: node ok.js', badBullet], files: [A_TEST] } }));

      const out = freezeCli(repo, ids);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(fs.existsSync(freezeFile(repo, ids[0]))).toBe(false);
      expect(frozenList(repo)).toEqual([]);
    });

    it('freeze-state is unchanged when the baseline cannot be written (no lock without evidence)', () => {
      expectVerbWorks('freeze');
      const repo = freezeRepo();
      fs.mkdirSync(path.join(repo.root, 'docs/.output/.state/telemetry'), { recursive: true });
      fs.writeFileSync(path.join(repo.root, RECORD_DIR), 'a file where the directory must be');

      const out = freezeCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(frozenList(repo)).toEqual([]);
    });

    it.skipIf(isWindows)('refuses a symlinked freeze file and writes nothing through it', () => {
      expectVerbWorks('freeze');
      const repo = freezeRepo();
      const victim = path.join(repo.root, 'VICTIM.txt');
      fs.writeFileSync(victim, 'untouched');
      fs.mkdirSync(path.dirname(freezeFile(repo)), { recursive: true });
      fs.symlinkSync(victim, freezeFile(repo));

      const out = freezeCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
      expect(frozenList(repo)).toEqual([]);
    });

    it.skipIf(isWindows)('a symlinked .state zone is refused before anything is created at its target, freeze-state included', () => {
      expectVerbWorks('freeze');
      const repo = freezeRepo();
      const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-freeze-target-')));
      roots.push(target);
      fs.mkdirSync(path.join(repo.root, 'docs/.output'), { recursive: true });
      fs.symlinkSync(target, path.join(repo.root, 'docs/.output/.state'));
      fs.appendFileSync(path.join(repo.root, '.git/info/exclude'), 'docs/.output/.state\n');

      const out = freezeCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(fs.readdirSync(target)).toEqual([]);
    });
  });

  // ── AC2 ───────────────────────────────────────────────────────────
  describe('freeze over an existing baseline needs --reason (AC2)', () => {
    it('without --reason exits non-zero with REASON_REQUIRED and leaves the baseline and freeze-state byte-identical', () => {
      const repo = frozenRepo();
      const baseBefore = fs.readFileSync(freezeFile(repo), 'utf8');
      const stateBefore = fs.readFileSync(stateFile(repo), 'utf8');
      fs.writeFileSync(abs(repo, A_TEST), 'expect(1).toBe(2);\n');

      const out = freezeCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(codesOf(out)).toContain('REASON_REQUIRED');
      expect(fs.readFileSync(freezeFile(repo), 'utf8')).toBe(baseBefore);
      expect(fs.readFileSync(stateFile(repo), 'utf8')).toBe(stateBefore);
      expect(codesOf(checkCli(repo))).toEqual(['FROZEN_FILE_CHANGED']); // the refused freeze did not launder the edit
    });

    it('with --reason rewrites the baseline to the new content and appends the reason to the history', () => {
      const repo = frozenRepo();
      const historyBefore = baseline(repo).history;
      const edited = 'expect(1).toBe(2);\n';
      fs.writeFileSync(abs(repo, A_TEST), edited);

      const out = freezeCli(repo, ['T-1.1'], { reason: 'Main Agent fixed a wrong expectation' });

      expect(out.status).toBe(0);
      const base = baseline(repo);
      expect(base.files[A_TEST]).toBe(sha256(Buffer.from(edited)));
      expect(base.history).toHaveLength(historyBefore.length + 1);
      expect(base.history.at(-1).reason).toBe('Main Agent fixed a wrong expectation');
      expect(new Date(base.history.at(-1).at).toISOString()).toBe(base.history.at(-1).at);
      expect(base.history.slice(0, historyBefore.length)).toEqual(historyBefore);
      expect(checkCli(repo).status).toBe(0);
    });

    it('keeps every earlier reason, in order, across repeated re-baselines', () => {
      const repo = frozenRepo();
      fs.writeFileSync(abs(repo, A_TEST), 'expect(1).toBe(2);\n');
      freezeCli(repo, ['T-1.1'], { reason: 'first edit' });
      fs.writeFileSync(abs(repo, A_TEST), 'expect(1).toBe(3);\n');

      const out = freezeCli(repo, ['T-1.1'], { reason: 'second edit' });

      expect(out.status).toBe(0);
      expect(baseline(repo).history.map((h) => h.reason).filter(Boolean)).toEqual(['first edit', 'second edit']);
    });

    it('a re-baseline with no change keeps the same file hashes and verifyHash (deterministic)', () => {
      const repo = frozenRepo();
      const before = baseline(repo);

      const out = freezeCli(repo, ['T-1.1'], { reason: 'no-op refresh' });

      expect(out.status).toBe(0);
      expect(baseline(repo).files).toEqual(before.files);
      expect(baseline(repo).verifyHash).toBe(before.verifyHash);
    });

    it('a re-baseline picks up a newly listed test file and freezes it', () => {
      const repo = frozenRepo();
      repo.write('src/c.test.js', 'new test\n');
      fs.writeFileSync(repo.todoPath, freezeTodo({ 'T-1.1': { criteria: BASIC_CRITERIA, files: [A_TEST, B_SPEC, 'src/c.test.js', 'src/impl.js'] } }));

      const out = freezeCli(repo, ['T-1.1'], { reason: 'added a test' });

      expect(out.status).toBe(0);
      expect(Object.keys(baseline(repo).files).sort()).toEqual([A_TEST, B_SPEC, 'src/c.test.js']);
      expect(frozenList(repo)).toContain(abs(repo, 'src/c.test.js'));
    });

    it.each([['an empty string', ''], ['whitespace only', '   ']])('a re-baseline with %s as the reason is refused and changes nothing', (_label, reason) => {
      const repo = frozenRepo();
      const baseBefore = fs.readFileSync(freezeFile(repo), 'utf8');

      const result = inProcessFs('freeze', repo, ['T-1.1'], { reason });

      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(fs.readFileSync(freezeFile(repo), 'utf8')).toBe(baseBefore);
    });

    it('a reason given on the first freeze is recorded in the history', () => {
      const repo = freezeRepo();

      const out = freezeCli(repo, ['T-1.1'], { reason: 'dispatch of wave 1' });

      expect(out.status).toBe(0);
      expect(baseline(repo).history.at(-1).reason).toBe('dispatch of wave 1');
    });
  });

  // ── AC3 and AC4 ───────────────────────────────────────────────────
  describe('check reports tampering (AC3, AC4)', () => {
    it('exits 0 for an untouched freeze', () => {
      const repo = frozenRepo();

      const out = checkCli(repo);

      expect(out.status).toBe(0);
      expect(out.json).toMatchObject({ ok: true, exitCode: 0, errors: [] });
    });

    it('an edit of a frozen file exits 1 and names the file', () => {
      const repo = frozenRepo();
      fs.writeFileSync(abs(repo, A_TEST), 'expect(1).toBe(1); // weakened\n');

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(out.json.ok).toBe(false);
      expect(out.json.errors).toMatchObject([{ code: 'FROZEN_FILE_CHANGED', story: 'T-1.1', file: A_TEST }]);
    });

    it('a Bash-style write (fs.writeFileSync, the path hook never sees it) is still reported, even when size and mtime are restored', () => {
      const repo = frozenRepo();
      const file = abs(repo, A_TEST);
      const stat = fs.statSync(file);
      fs.writeFileSync(file, 'expect(2).toBe(2);\n'); // same length as the original
      fs.utimesSync(file, stat.atime, stat.mtime); // a `touch -r`
      expect(fs.statSync(file).size).toBe(stat.size);

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(out.json.errors).toMatchObject([{ code: 'FROZEN_FILE_CHANGED', file: A_TEST }]);
    });

    it('an edit that is reverted to the identical bytes is not a finding', () => {
      const repo = frozenRepo();
      fs.writeFileSync(abs(repo, A_TEST), 'something else\n');
      fs.writeFileSync(abs(repo, A_TEST), A_BODY);

      expect(checkCli(repo).status).toBe(0);
    });

    it('a deleted frozen file exits 1 and names the file', () => {
      const repo = frozenRepo();
      fs.rmSync(abs(repo, B_SPEC));

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(out.json.errors).toMatchObject([{ code: 'FROZEN_FILE_MISSING', story: 'T-1.1', file: B_SPEC }]);
    });

    it('a renamed frozen file exits 1 and names the old path', () => {
      const repo = frozenRepo();
      fs.renameSync(abs(repo, A_TEST), abs(repo, 'src/__tests__/renamed.test.js'));

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(out.json.errors).toMatchObject([{ code: 'FROZEN_FILE_MISSING', story: 'T-1.1', file: A_TEST }]);
    });

    it('reports every changed file, not just the first', () => {
      const repo = frozenRepo();
      fs.writeFileSync(abs(repo, A_TEST), 'changed a\n');
      fs.writeFileSync(abs(repo, B_SPEC), 'changed b\n');

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(out.json.errors.map((e) => e.file).sort()).toEqual([A_TEST, B_SPEC]);
    });

    it('an edit to a verify command exits 1, names the story and the TODO line of the edited binding', () => {
      const repo = frozenRepo();
      const edited = repo.text.replace('verify: node ok.js', 'verify: node exit.js 0');
      fs.writeFileSync(repo.todoPath, edited);

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(out.json.errors).toMatchObject([{ code: 'VERIFY_CHANGED', story: 'T-1.1', acLine: lineOf(edited, 'verify: node exit.js 0') }]);
    });

    it('a weakened expected exit (=> exit 3 becomes => exit 0) is a verify edit', () => {
      const repo = frozenRepo();
      const edited = repo.text.replace('=> exit 3', '=> exit 0');
      fs.writeFileSync(repo.todoPath, edited);

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(out.json.errors).toMatchObject([{ code: 'VERIFY_CHANGED', story: 'T-1.1', acLine: lineOf(edited, 'Fails loudly.') }]);
    });

    it.each([
      ['a binding removed (the criterion turns manual)', (t) => t.replace(' verify: node ok.js', '')],
      ['a binding added to a manual criterion', (t) => t.replace('A manual criterion with no binding', 'A manual criterion with no binding. verify: node ok.js')],
    ])('%s is a verify edit', (_label, edit) => {
      const repo = frozenRepo();
      fs.writeFileSync(repo.todoPath, edit(repo.text));

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(codesOf(out)).toEqual(['VERIFY_CHANGED']);
      expect(out.json.errors[0].story).toBe('T-1.1');
    });

    it.each([
      ['ticking every checkbox', (t) => t.replaceAll('[ ]', '[x]')],
      ['rewording an AC sentence without touching its binding', (t) => t.replace('Adds the thing.', 'Adds a different thing.')],
      ['inserting lines above the story (every line number shifts)', (t) => `\n\nA new preface paragraph.\n\n${t}`],
      ['appending a review section', (t) => `${t}\n**Review — Wave 1**\n* all good\n`],
    ])('%s is not a finding', (_label, edit) => {
      const repo = frozenRepo();
      fs.writeFileSync(repo.todoPath, edit(repo.text));

      const out = checkCli(repo);

      expect(out.status).toBe(0);
      expect(out.json.errors).toEqual([]);
    });

    it("an edit to another story's verify line is not a finding for a story that was frozen on its own", () => {
      const spec = {
        'T-1.1': { criteria: ['One. verify: node ok.js'], files: [A_TEST] },
        'T-1.2': { criteria: ['Two. verify: node exit.js 3 => exit 3'], files: [B_SPEC] },
      };
      const repo = frozenRepo({ stories: spec, ids: ['T-1.1'] });
      fs.writeFileSync(repo.todoPath, repo.text.replace('=> exit 3', '=> exit 0'));

      expect(checkCli(repo, ['T-1.1']).status).toBe(0);
    });

    it('with two stories selected, a finding in one is attributed to that story and the other stays clean', () => {
      const repo = frozenRepo({
        stories: {
          'T-1.1': { criteria: ['One. verify: node ok.js'], files: [A_TEST] },
          'T-1.2': { criteria: ['Two. verify: node exit.js 3 => exit 3'], files: [B_SPEC] },
        },
        ids: ['T-1.1', 'T-1.2'],
      });
      fs.writeFileSync(abs(repo, B_SPEC), 'tampered\n');

      const out = checkCli(repo, ['T-1.1', 'T-1.2']);

      expect(out.status).toBe(1);
      expect(out.json.errors).toMatchObject([{ code: 'FROZEN_FILE_CHANGED', story: 'T-1.2', file: B_SPEC }]);
    });

    it('a baseline with only the verify hash (no test files) still catches a verify edit and passes when nothing changed', () => {
      const repo = frozenRepo({ stories: { 'T-1.1': { criteria: ['A. verify: node ok.js'], files: ['src/impl.js'] } } });
      expect(checkCli(repo).status).toBe(0);
      fs.writeFileSync(repo.todoPath, repo.text.replace('verify: node ok.js', 'verify: node exit.js 0'));

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(codesOf(out)).toEqual(['VERIFY_CHANGED']);
    });

    it('check never rewrites the baseline or freeze-state', () => {
      const repo = frozenRepo();
      fs.writeFileSync(abs(repo, A_TEST), 'tampered\n');
      const baseBefore = fs.readFileSync(freezeFile(repo), 'utf8');
      const stateBefore = fs.readFileSync(stateFile(repo), 'utf8');

      checkCli(repo);

      expect(fs.readFileSync(freezeFile(repo), 'utf8')).toBe(baseBefore);
      expect(fs.readFileSync(stateFile(repo), 'utf8')).toBe(stateBefore);
    });
  });

  // ── AC5 ───────────────────────────────────────────────────────────
  describe('unfreeze removes only what freeze added (AC5)', () => {
    it('removes the frozen check files, keeps unrelated freeze-state entries in order, and leaves the baseline', () => {
      const repo = freezeRepo();
      const unrelated = ['/elsewhere/investigate-target.js', abs(repo, 'src/impl.js')];
      fs.mkdirSync(path.dirname(stateFile(repo)), { recursive: true });
      fs.writeFileSync(stateFile(repo), JSON.stringify({ frozen: unrelated }));
      freezeCli(repo);
      expect(frozenList(repo).sort()).toEqual([...unrelated, abs(repo, A_TEST), abs(repo, B_SPEC)].sort());
      const baseBefore = fs.readFileSync(freezeFile(repo), 'utf8');

      const out = unfreezeCli(repo);

      expect(out.status).toBe(0);
      expect(out.json).toMatchObject({ ok: true, exitCode: 0, errors: [] });
      expect(frozenList(repo)).toEqual(unrelated);
      expect(fs.readFileSync(freezeFile(repo), 'utf8')).toBe(baseBefore);
    });

    it('an entry that was already frozen before freeze ran was not added by freeze, so unfreeze leaves it', () => {
      const repo = freezeRepo();
      fs.mkdirSync(path.dirname(stateFile(repo)), { recursive: true });
      fs.writeFileSync(stateFile(repo), JSON.stringify({ frozen: [abs(repo, A_TEST)] }));
      freezeCli(repo);

      const out = unfreezeCli(repo);

      expect(out.status).toBe(0);
      expect(frozenList(repo)).toEqual([abs(repo, A_TEST)]);
    });

    it('after unfreeze the real hook allows a Write to the check file again', () => {
      const repo = frozenRepo();
      expect(hookWrite(repo, 'Write', abs(repo, A_TEST)).status, 'control: blocked while frozen').toBe(2);

      unfreezeCli(repo);

      expect(hookWrite(repo, 'Write', abs(repo, A_TEST)).status).toBe(0);
    });

    it('check still works after unfreeze: it passes on an untouched tree and still catches an edit', () => {
      const repo = frozenRepo();
      unfreezeCli(repo);
      expect(checkCli(repo).status).toBe(0);
      fs.writeFileSync(abs(repo, A_TEST), 'tampered after unfreeze\n');

      const out = checkCli(repo);

      expect(out.status).toBe(1);
      expect(out.json.errors).toMatchObject([{ code: 'FROZEN_FILE_CHANGED', file: A_TEST }]);
    });

    it('removes every entry freeze added across a re-baseline, including a file added by the re-baseline', () => {
      const repo = frozenRepo();
      repo.write('src/c.test.js', 'new test\n');
      fs.writeFileSync(repo.todoPath, freezeTodo({ 'T-1.1': { criteria: BASIC_CRITERIA, files: [A_TEST, B_SPEC, 'src/c.test.js', 'src/impl.js'] } }));
      freezeCli(repo, ['T-1.1'], { reason: 'added a test' });

      const out = unfreezeCli(repo);

      expect(out.status).toBe(0);
      expect(frozenList(repo)).toEqual([]);
    });

    it("with two stories frozen, unfreezing one removes only that story's entries", () => {
      const repo = frozenRepo({
        stories: {
          'T-1.1': { criteria: ['One. verify: node ok.js'], files: [A_TEST] },
          'T-1.2': { criteria: ['Two. verify: node ok.js'], files: [B_SPEC] },
        },
        ids: ['T-1.1', 'T-1.2'],
      });

      const out = unfreezeCli(repo, ['T-1.1']);

      expect(out.status).toBe(0);
      expect(frozenList(repo)).toEqual([abs(repo, B_SPEC)]);
      expect(fs.existsSync(freezeFile(repo, 'T-1.1'))).toBe(true);
      expect(fs.existsSync(freezeFile(repo, 'T-1.2'))).toBe(true);
    });
  });

  // ── AC6 ───────────────────────────────────────────────────────────
  describe('fail closed (AC6)', () => {
    it('check with no baseline exits non-zero with BASELINE_MISSING', () => {
      const repo = freezeRepo();

      const out = checkCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(codesOf(out)).toContain('BASELINE_MISSING');
    });

    it('check passes a manual-only story with no test files and no baseline: there was nothing to freeze', () => {
      const repo = freezeRepo({ stories: { 'T-1.1': { criteria: ['Docs read well. [manual]'], files: ['docs/guide.md'] } } });

      const out = checkCli(repo);

      expect(out.status).toBe(0);
      expect(out.json.ok).toBe(true);
      expect(out.json.stories).toMatchObject([{ id: 'T-1.1', status: 'nothing-to-freeze' }]);
    });

    it.each([
      ['a manual-only story that lists a test file', { criteria: ['By hand. [manual]'], files: [A_TEST] }],
      ['a story with a verify: binding', { criteria: ['One. verify: node ok.js'], files: ['docs/guide.md'] }],
    ])('check still refuses %s with no baseline', (_name, story) => {
      const repo = freezeRepo({ stories: { 'T-1.1': story } });

      const out = checkCli(repo);

      expect(out.status).not.toBe(0);
      expect(codesOf(out)).toContain('BASELINE_MISSING');
    });

    it('check on a story absent from the TODO exits non-zero', () => {
      const repo = frozenRepo();

      const out = checkCli(repo, ['T-9.9']);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
    });

    it('check with two stories selected fails when one of them has no baseline', () => {
      const repo = frozenRepo({
        stories: {
          'T-1.1': { criteria: ['One. verify: node ok.js'], files: [A_TEST] },
          'T-1.2': { criteria: ['Two. verify: node ok.js'], files: [B_SPEC] },
        },
        ids: ['T-1.1'],
      });

      const out = checkCli(repo, ['T-1.1', 'T-1.2']);

      expect(out.status).not.toBe(0);
      expect(out.json.errors).toMatchObject([{ code: 'BASELINE_MISSING', story: 'T-1.2' }]);
    });

    it.each([
      ['an empty file', ''],
      ['text that is not JSON', 'this is not json {'],
      ['a JSON array', '[]'],
      ['JSON null', 'null'],
      ['an empty object (no files, no verifyHash)', '{}'],
      ['files that is not an object', JSON.stringify({ story: 'T-1.1', files: 'x', verifyHash: 'a'.repeat(64), history: [] })],
      ['a file hash that is not a sha256', JSON.stringify({ story: 'T-1.1', files: { [A_TEST]: 5 }, verifyHash: 'a'.repeat(64), history: [] })],
      ['a verifyHash that is not a sha256', JSON.stringify({ story: 'T-1.1', files: {}, verifyHash: 'nope', history: [] })],
    ])('check on a baseline that is %s exits non-zero with BASELINE_MALFORMED', (_label, body) => {
      const repo = frozenRepo();
      fs.writeFileSync(freezeFile(repo), body);

      const out = checkCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
      expect(codesOf(out)).toContain('BASELINE_MALFORMED');
    });

    it('a baseline path that is a directory is not treated as an unchanged freeze', () => {
      const repo = frozenRepo();
      fs.rmSync(freezeFile(repo));
      fs.mkdirSync(freezeFile(repo));

      const out = checkCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
    });

    it.skipIf(isWindows)('check refuses a symlinked baseline even when its target is a valid baseline', () => {
      const repo = frozenRepo();
      const real = path.join(repo.root, 'valid-baseline-copy.json');
      fs.renameSync(freezeFile(repo), real);
      fs.symlinkSync(real, freezeFile(repo));

      const out = checkCli(repo);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
    });

    it.skipIf(isWindows || isRoot)('an unreadable frozen file is a failure, never "unchanged"', () => {
      const repo = frozenRepo();
      fs.chmodSync(abs(repo, A_TEST), 0o000);

      const out = checkCli(repo);

      fs.chmodSync(abs(repo, A_TEST), 0o644);
      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
    });

    it.each(['freeze', 'check', 'unfreeze'])('a thrown exception inside %s exits non-zero instead of escaping or reporting success', (name) => {
      const repo = frozenRepo();
      const opts = { root: repo.root, todo: repo.todoPath };
      Object.defineProperty(opts, 'stories', { get() { throw new Error('boom'); }, enumerable: true });

      const result = withProjectRoot(repo.root, () => exported(name)(opts));

      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(result.errors.map((e) => e.code)).toContain('EXCEPTION');
    });

    it.each(['freeze', 'check', 'unfreeze'])('%s with a missing or relative root is invalid input, non-zero', (name) => {
      const repo = freezeRepo();

      const missing = withProjectRoot(repo.root, () => exported(name)({ todo: repo.todoPath, stories: ['T-1.1'] }));
      const relative = withProjectRoot(repo.root, () => exported(name)({ root: '.', todo: repo.todoPath, stories: ['T-1.1'] }));

      for (const result of [missing, relative]) {
        expect(result.ok).toBe(false);
        expect(result.exitCode).not.toBe(0);
      }
    });

    it.each(['freeze', 'check', 'unfreeze'])('%s through the CLI with a missing --stories prints one JSON document and exits non-zero', (name) => {
      expectVerbWorks(name);
      const repo = freezeRepo();

      const out = cli(repo.root, [name, '--todo', repo.todoPath]);

      expect(out.status).not.toBe(0);
      expect(out.json.ok).toBe(false);
    });
  });
});

// ── wave-2 review fixes (docs/.output/findings/reviews/261118-1228-software-factory-wave2-review.md) ──

/** A TODO with one story whose Files field is `filesBlock` verbatim (inline text, bullets, or both). */
const f1Todo = (filesBlock) => `# TODO: freeze fixture\n\n* **Story T-1.1 (S): Title**\n  * **AC:**\n    * [ ] Adds the thing. verify: node ok.js\n${filesBlock}  * **Estimate:** S\n`;
const C_TEST = 'src/c.test.js';
const TIMESPLIT_TEST = '.agents/core/__tests__/session-timesplit.test.js';

describe('wave-2 review F1: freeze reads the Files list through plan-check (no second parser)', () => {
  it('the real RC-1.1 Files shape (inline, several paths, each marked (new)) freezes the test file, and a weakened one is caught by check', () => {
    // Verbatim shape of docs/TODO_review-cadence.md RC-1.1.
    const files = '  * **Files:** `.agents/core/session-timesplit.js` (new), `.agents/core/__tests__/session-timesplit.test.js` (new)\n';
    const repo = makeRepo({ rawTodo: f1Todo(files), extra: { ...FREEZE_FILES, '.agents/core/session-timesplit.js': 'module.exports = 1;\n', [TIMESPLIT_TEST]: 'expect(1).toBe(1);\n' } });

    const out = freezeCli(repo);

    expect(out.status).toBe(0);
    expect(Object.keys(baseline(repo).files)).toEqual([TIMESPLIT_TEST]);
    expect(out.json.warnings).toEqual([]);
    expect(frozenList(repo)).toEqual([abs(repo, TIMESPLIT_TEST)]);
    expect(checkCli(repo).status).toBe(0);

    fs.writeFileSync(abs(repo, TIMESPLIT_TEST), 'expect(1).toBe(1); // weakened\n');
    const tampered = checkCli(repo);

    expect(tampered.status).toBe(1);
    expect(tampered.json.errors).toMatchObject([{ code: 'FROZEN_FILE_CHANGED', file: TIMESPLIT_TEST }]);
  });

  it('an inline list of several test files (the first marked (new), the others bare) freezes every one of them', () => {
    const files = `  * **Files:** \`${A_TEST}\` (new), \`${B_SPEC}\`, \`${C_TEST}\`, \`src/impl.js\`\n`;
    const repo = makeRepo({ rawTodo: f1Todo(files), extra: { ...FREEZE_FILES, [C_TEST]: 'c\n' } });

    const out = freezeCli(repo);

    expect(out.status).toBe(0);
    expect(Object.keys(baseline(repo).files).sort()).toEqual([A_TEST, B_SPEC, C_TEST].sort());
    for (const rel of [A_TEST, B_SPEC, C_TEST]) {
      fs.writeFileSync(abs(repo, rel), `weakened ${rel}\n`);
      expect(checkCli(repo).json.errors.map((e) => e.file), rel).toContain(rel);
      fs.writeFileSync(abs(repo, rel), rel === A_TEST ? A_BODY : rel === B_SPEC ? B_BODY : 'c\n');
    }
  });

  it('a Files bullet that lists several paths freezes every test file on it, and a nested one-path-per-bullet list still works', () => {
    const files = `  * **Files:**\n    * \`${A_TEST}\` (new), \`${B_SPEC}\` (new)\n    * \`${C_TEST}\` — covers the edge\n`;
    const repo = makeRepo({ rawTodo: f1Todo(files), extra: { ...FREEZE_FILES, [C_TEST]: 'c\n' } });

    const out = freezeCli(repo);

    expect(out.status).toBe(0);
    expect(Object.keys(baseline(repo).files).sort()).toEqual([A_TEST, B_SPEC, C_TEST].sort());
  });

  it('ac-verify no longer carries its own Files parser (one parser: plan-check)', () => {
    const source = fs.readFileSync(path.resolve('.agents/core/ac-verify.js'), 'utf8');
    for (const name of ['pathsFromText', 'filesListOf', 'FILES_LABEL', 'FILES_HEADING', 'STORY_HEADER_LINE']) expect(source, name).not.toContain(name);
    expect(source).toContain("require('./plan-check')");
  });
});

describe('wave-2 review F5: a test file shared by two stories stays locked until the last one unfreezes', () => {
  const SHARED = {
    'T-1.1': { criteria: ['One. verify: node ok.js'], files: [A_TEST] },
    'T-1.2': { criteria: ['Two. verify: node ok.js'], files: [A_TEST, B_SPEC] },
  };
  const locksFile = (repo) => path.join(repo.root, RECORD_DIR, '_freeze-locks.json');

  it.each([
    ['the first story', ['T-1.1'], ['T-1.2']],
    ['the second story', ['T-1.2'], ['T-1.1']],
  ])('unfreezing %s keeps the lock the other still needs; the last unfreeze releases it', (_label, first, second) => {
    const repo = frozenRepo({ stories: SHARED, ids: ['T-1.1', 'T-1.2'] });
    expect(frozenList(repo).sort()).toEqual([abs(repo, A_TEST), abs(repo, B_SPEC)].sort());

    const one = unfreezeCli(repo, first);

    expect(one.status).toBe(0);
    expect(frozenList(repo)).toContain(abs(repo, A_TEST));
    expect(hookWrite(repo, 'Write', abs(repo, A_TEST)).status, 'the other story is still in flight, so the hook still blocks').toBe(2);

    const two = unfreezeCli(repo, second);

    expect(two.status).toBe(0);
    expect(frozenList(repo)).toEqual([]);
    expect(hookWrite(repo, 'Write', abs(repo, A_TEST)).status).toBe(0);
  });

  it('unfreezing both stories in one call releases the shared entry once', () => {
    const repo = frozenRepo({ stories: SHARED, ids: ['T-1.1', 'T-1.2'] });

    const out = unfreezeCli(repo, ['T-1.1', 'T-1.2']);

    expect(out.status).toBe(0);
    expect(frozenList(repo)).toEqual([]);
  });

  it('an entry that was frozen before either story ran is never removed, however many stories share it', () => {
    const repo = freezeRepo({ stories: SHARED });
    fs.mkdirSync(path.dirname(stateFile(repo)), { recursive: true });
    fs.writeFileSync(stateFile(repo), JSON.stringify({ frozen: [abs(repo, A_TEST)] }));
    expect(freezeCli(repo, ['T-1.1', 'T-1.2']).status).toBe(0);

    expect(unfreezeCli(repo, ['T-1.1']).status).toBe(0);
    expect(unfreezeCli(repo, ['T-1.2']).status).toBe(0);

    expect(frozenList(repo)).toEqual([abs(repo, A_TEST)]);
  });

  it('the baselines are not rewritten by unfreeze (the ship seal covers them)', () => {
    const repo = frozenRepo({ stories: SHARED, ids: ['T-1.1', 'T-1.2'] });
    const before = ['T-1.1', 'T-1.2'].map((id) => fs.readFileSync(freezeFile(repo, id), 'utf8'));

    unfreezeCli(repo, ['T-1.1']);

    expect(['T-1.1', 'T-1.2'].map((id) => fs.readFileSync(freezeFile(repo, id), 'utf8'))).toEqual(before);
  });

  it('a story frozen alone, with the lock bookkeeping file lost, still releases what its baseline says freeze added', () => {
    const repo = frozenRepo({ stories: { 'T-1.1': SHARED['T-1.1'] }, ids: ['T-1.1'] });
    fs.rmSync(locksFile(repo));

    const out = unfreezeCli(repo, ['T-1.1']);

    expect(out.status).toBe(0);
    expect(frozenList(repo)).toEqual([]);
  });

  it('a malformed lock bookkeeping file refuses unfreeze (non-zero) and leaves freeze-state alone', () => {
    const repo = frozenRepo({ stories: SHARED, ids: ['T-1.1', 'T-1.2'] });
    fs.writeFileSync(locksFile(repo), '{"locks": 7}');
    const before = fs.readFileSync(stateFile(repo), 'utf8');

    const out = unfreezeCli(repo, ['T-1.1']);

    expect(out.status).toBe(2);
    expect(codesOf(out)).toEqual(['LOCKS_MALFORMED']);
    expect(fs.readFileSync(stateFile(repo), 'utf8')).toBe(before);
  });

  it('a failed freeze leaves the lock bookkeeping exactly as it was', () => {
    const repo = frozenRepo({ stories: { 'T-1.1': SHARED['T-1.1'] }, ids: ['T-1.1'] });
    const before = fs.readFileSync(locksFile(repo), 'utf8');
    fs.writeFileSync(repo.todoPath, freezeTodo({ 'T-1.2': { criteria: ['Two. verify: node ok.js'], files: [A_TEST, '../outside.test.js'] } }));

    const out = freezeCli(repo, ['T-1.2']);

    expect(out.status).not.toBe(0);
    expect(fs.readFileSync(locksFile(repo), 'utf8')).toBe(before);
  });
});

describe('wave-2 review N1: a tamper finding keeps exit 1 even beside another failure', () => {
  it('check over a tampered story and a story with no baseline exits 1 and lists both codes', () => {
    const repo = frozenRepo({
      stories: {
        'T-1.1': { criteria: ['One. verify: node ok.js'], files: [A_TEST] },
        'T-1.2': { criteria: ['Two. verify: node ok.js'], files: [B_SPEC] },
      },
      ids: ['T-1.1'],
    });
    fs.writeFileSync(abs(repo, A_TEST), 'tampered\n');

    const out = checkCli(repo, ['T-1.1', 'T-1.2']);

    expect(out.status).toBe(1);
    expect(out.json.exitCode).toBe(1);
    expect(codesOf(out).sort()).toEqual(['BASELINE_MISSING', 'FROZEN_FILE_CHANGED']);
  });

  it('a result with only non-tamper failures still exits 2', () => {
    const repo = freezeRepo();

    const out = checkCli(repo);

    expect(out.status).toBe(2);
    expect(codesOf(out)).toEqual(['BASELINE_MISSING']);
  });
});

describe('wave-2 review N2: a listed test file that does not exist is surfaced, not silent', () => {
  it('the warning stays and the story report names the missing file', () => {
    const repo = freezeRepo({ stories: { 'T-1.1': { criteria: ['A. verify: node ok.js'], files: [A_TEST, 'src/__tests__/typo.test.js'] } } });

    const out = freezeCli(repo);

    expect(out.status).toBe(0);
    expect(out.json.warnings).toHaveLength(1);
    expect(out.json.warnings[0]).toMatch(/typo\.test\.js.*does not exist/);
    expect(out.json.stories[0].missing).toEqual(['src/__tests__/typo.test.js']);
    expect(Object.keys(baseline(repo).files)).toEqual([A_TEST]);
  });
});
