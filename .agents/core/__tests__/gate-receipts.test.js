// End-to-end tests for gate receipts and safe reuse of passing test projects.
//
// Every test builds a temp git repo of three .NET-shaped projects and drives the real gate.js
// against it with a fake runner (runner.js). The runner prints a dotnet-style summary line and
// appends one line per run to a counter file inside the ignored .state directory, so a test can
// tell "ran" from "reused" without the counter changing the tree hash.
//
//   A.csproj --ProjectReference--> B.csproj      C.csproj (independent)
//   root Directory.Build.props, App.sln, docs/x.md
//
// Plan section 5 coverage: closure (1), filter (2), mode (3), interrupted (4), tree change
// mid-run (5), verify-receipt (6), arguments (7), eligibility (8), PR helper (9), stop (10).
// The forced miss on the reuse decision (11) and the unchanged-behavior run (12) are in the report.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const GATE = require.resolve('../../../.agents/core/gate');
const PR_JS = require.resolve('../../../.agents/core/pull-request');
const gr = require('../../../.agents/core/_lib/gate-receipt');
const posix = process.platform !== 'win32';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const RUNNER = `
const fs = require('fs'); const path = require('path');
const name = process.argv[2];
const state = path.join(__dirname, 'docs', '.output', '.state');
fs.mkdirSync(state, { recursive: true });
fs.appendFileSync(path.join(state, 'runs.log'), name + '\\n');
if (process.env.RUNNER_EDIT === name) fs.appendFileSync(path.join(__dirname, 'docs', 'x.md'), 'edited during the run\\n');
if (process.env.RUNNER_SLEEP === name) { setTimeout(() => {}, 120000); return; }
if (name === 'build') process.exit(0);
if (process.env.RUNNER_FAIL === name) { console.log('Failed! - Failed: 1, Passed: 4, Skipped: 1, Total: 6'); process.exit(1); }
if (process.env.RUNNER_ZERO === name) { console.log('Passed! - Failed: 0, Passed: 0, Skipped: 0, Total: 0'); process.exit(0); }
console.log('Passed! - Failed: 0, Passed: 5, Skipped: 1, Total: 6');
`;

const proj = (...refs) => `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${refs.map(r => `    <ProjectReference Include="${r}" />`).join('\n')}\n  </ItemGroup>\n</Project>\n`;
const SLN = ['A', 'B', 'C'].map(n => `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${n}", "${n}\\${n}.csproj", "{${n}}"`).join('\n') + '\n';

function projectEntry(name, extra = {}) {
  return { name, path: `${name}/${name}.csproj`, argv: ['node', 'runner.js', name], reuse: true, ...extra };
}

/** A temp repo with the three projects, a fake runner and a gate config. `config` is merged over the default. */
function makeRepo({ config = {}, files = {}, projects } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-receipts-')));
  roots.push(root);
  const write = (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); };
  write('A/A.csproj', proj('..\\B\\B.csproj')); write('A/A.cs', 'class A {}\n');
  write('B/B.csproj', proj()); write('B/B.cs', 'class B {}\n');
  write('C/C.csproj', proj()); write('C/C.cs', 'class C {}\n');
  write('Directory.Build.props', '<Project />\n');
  write('App.sln', SLN);
  write('docs/x.md', 'docs\n');
  write('runner.js', RUNNER);
  write('.gitignore', 'docs/.output/.state/\n');
  for (const [p, c] of Object.entries(files)) write(p, c);
  const cfg = {
    build: { argv: ['node', 'runner.js', 'build'], timeout: 60000 },
    test: { filter: 'Category!=Integration', timeout: 60000, projects: projects || [projectEntry('A'), projectEntry('B'), projectEntry('C')] },
    lint: { missing: true },
    ...config,
  };
  write('.claude/gate.config.json', JSON.stringify(cfg, null, 2));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com'); git('config', 'commit.gpgsign', 'false');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  const state = path.join(root, 'docs/.output/.state');
  const api = {
    root, write, git,
    setConfig(patch) { const c = JSON.parse(fs.readFileSync(path.join(root, '.claude/gate.config.json'), 'utf8')); write('.claude/gate.config.json', JSON.stringify({ ...c, ...patch }, null, 2)); },
    runs() { try { return fs.readFileSync(path.join(state, 'runs.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } },
    resetRuns() { fs.rmSync(path.join(state, 'runs.log'), { force: true }); },
    receipt() { return JSON.parse(fs.readFileSync(path.join(state, 'telemetry/gate-receipt.json'), 'utf8')); },
    lockPath: path.join(state, 'telemetry/.gate.lock'),
    gate(args, env = {}) { return runGate(root, args, env); },
    /** Run the gate and return the runner lines it caused. */
    ran(args, env) { api.resetRuns(); const r = runGate(root, args, env); return { ...r, runs: api.runs() }; },
  };
  return api;
}

function runGate(root, args, env = {}) {
  const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, CI: '', ...env };
  delete childEnv.GATE_TEST_TIMEOUT_MS;
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd: root, encoding: 'utf8', env: childEnv, timeout: 120000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

describe('closure and reuse (plan 1)', () => {
  it('a full pass reuses what did not change, reruns what did, and skips the build only when every project is reused', () => {
    const t = makeRepo();
    const first = t.ran(['full', 'test']);
    expect(first.code, first.out).toBe(0);
    expect(first.runs).toEqual(['build', 'A', 'B', 'C']);
    expect(t.receipt()).toMatchObject({ status: 'passed', mode: 'full', exitCode: 0, build: { status: 'passed', reused: false } });

    // Nothing changed: every project is reused and the build is skipped.
    const second = t.ran(['full', 'test']);
    expect(second.code, second.out).toBe(0);
    expect(second.runs).toEqual([]);
    expect(second.out).toMatch(/A: reused from receipt [0-9a-f]{12} \(5 passed, 1 skipped, ran \d{4}-/);
    expect(second.out).toContain('Build: SKIPPED');
    expect(t.receipt().projects.map(p => [p.name, p.status, p.reused])).toEqual([['A', 'passed', true], ['B', 'passed', true], ['C', 'passed', true]]);
    expect(t.receipt().build).toMatchObject({ status: 'passed', reused: true });

    // Edit B: A depends on B, so A and B rerun; C is reused; the build must run.
    t.write('B/B.cs', 'class B { int x; }\n');
    const edited = t.ran(['full', 'test']);
    expect(edited.runs).toEqual(['build', 'A', 'B']);
    expect(edited.out).toMatch(/C: reused from receipt/);

    // Edit the root Directory.Build.props: every project reruns.
    t.write('Directory.Build.props', '<Project><PropertyGroup /></Project>\n');
    expect(t.ran(['full', 'test']).runs).toEqual(['build', 'A', 'B', 'C']);

    // Edit a docs file: nothing in any closure changed, so everything is reused and the build is skipped.
    t.write('docs/x.md', 'docs changed\n');
    const docsOnly = t.ran(['full', 'test']);
    expect(docsOnly.code, docsOnly.out).toBe(0);
    expect(docsOnly.runs).toEqual([]);
    expect(docsOnly.out).toContain('Build: SKIPPED');
    // ...and the receipt is for the docs change, so it verifies against that exact tree.
    expect(t.gate(['verify-receipt', '--mode', 'full']).code).toBe(0);
  });

  it('a reuse across a commit keeps working: the receipt follows HEAD, the closure does not change', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    t.write('docs/x.md', 'docs two\n');
    t.git('add', '-A'); t.git('commit', '-q', '-m', 'docs only');
    // The old receipt no longer matches HEAD...
    expect(t.gate(['verify-receipt', '--mode', 'full']).code).toBe(1);
    // ...and a cheap full run (everything reused, build skipped) restores a verifiable receipt.
    const again = t.ran(['full', 'test']);
    expect(again.runs).toEqual([]);
    expect(t.gate(['verify-receipt', '--mode', 'full']).code).toBe(0);
  });

  it('a failed project does not stop the others; their passes stay reusable and only the failed one reruns', () => {
    const t = makeRepo();
    const bad = t.ran(['full', 'test'], { RUNNER_FAIL: 'C' });
    expect(bad.code).toBe(1);
    expect(bad.runs).toEqual(['build', 'A', 'B', 'C']);
    expect(t.receipt()).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(t.receipt().projects.map(p => p.status)).toEqual(['passed', 'passed', 'failed']);
    const fixed = t.ran(['full', 'test']);
    expect(fixed.code, fixed.out).toBe(0);
    expect(fixed.runs).toEqual(['build', 'C']);
  });

  it('a project that collects zero tests fails the run (per project)', () => {
    const t = makeRepo();
    const r = t.ran(['full', 'test'], { RUNNER_ZERO: 'B' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('B: FAILED (0 tests collected)');
  });

  it('a failed build runs no project and records no passing receipt', () => {
    const t = makeRepo({ config: { build: { argv: ['node', '-e', 'process.exit(1)'], timeout: 60000 } } });
    const r = t.ran(['full', 'test']);
    expect(r.code).toBe(1);
    expect(r.runs).toEqual([]);
    expect(t.receipt().status).toBe('failed');
    expect(t.gate(['verify-receipt']).code).toBe(1);
  });
});

describe('filter and mode (plan 2, 3)', () => {
  it('a changed test.filter reruns every project', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    t.setConfig({ test: { filter: 'Category!=Integration&Category!=AgentHarness', timeout: 60000, projects: [projectEntry('A'), projectEntry('B'), projectEntry('C')] } });
    const r = t.ran(['full', 'test']);
    expect(r.runs).toEqual(['build', 'A', 'B', 'C']);
    expect(t.receipt().filter).toBe('Category!=Integration&Category!=AgentHarness');
  });

  it('a normal receipt does not satisfy verify --mode full, a full receipt satisfies both, and reuse does not cross modes', () => {
    const t = makeRepo();
    expect(t.ran(['test']).runs).toEqual(['build', 'A', 'B', 'C']);
    expect(t.receipt().mode).toBe('normal');
    expect(t.gate(['verify-receipt']).code).toBe(0);
    const needFull = t.gate(['verify-receipt', '--mode', 'full']);
    expect(needFull.code).toBe(1);
    expect(needFull.out).toMatch(/mode "normal", a full pass is required/);
    // Reuse does not cross modes: the full run reruns everything the normal run just proved.
    expect(t.ran(['full', 'test']).runs).toEqual(['build', 'A', 'B', 'C']);
    expect(t.gate(['verify-receipt', '--mode', 'full']).code).toBe(0);
    expect(t.gate(['verify-receipt']).code).toBe(0);
    // Within a mode, reuse still works: the earlier normal run's results are still valid for this tree.
    expect(t.ran(['test']).runs).toEqual([]);
  });

  it('and the other way: a full run is not reused by a normal run', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    expect(t.ran(['test']).runs).toEqual(['build', 'A', 'B', 'C']);
  });

  it('--changed on a test leg that cannot honor it says so, runs everything and records mode normal', () => {
    const t = makeRepo();
    const r = t.ran(['test', '--changed']);
    expect(r.out).toContain('[GATE] --changed is not supported for this test leg (vitest string commands only); running the whole suite');
    expect(r.runs).toEqual(['build', 'A', 'B', 'C']);
    expect(t.receipt()).toMatchObject({ mode: 'normal', changedOnly: false });
    expect(r.out).not.toContain('changed only');
  });

  it('a --no-build run never verifies (the tests may have run against stale binaries)', () => {
    const t = makeRepo();
    expect(t.ran(['full', '--no-build']).code).toBe(0);
    const v = t.gate(['verify-receipt', '--mode', 'full']);
    expect(v.code).toBe(1);
    expect(v.out).toContain('the build did not pass');
  });
});

describe('interrupted runs (plan 4)', () => {
  /** Start a gate in the background and wait until the runner line `waitFor` appears. */
  async function startAndWait(t, args, env, waitFor) {
    const child = spawn(process.execPath, [GATE, ...args], { cwd: t.root, env: { ...process.env, CLAUDE_PROJECT_DIR: t.root, CI: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 200 && !t.runs().includes(waitFor); i++) await new Promise(r => setTimeout(r, 50));
    expect(t.runs(), out).toContain(waitFor);
    return { child, closed, output: () => out };
  }

  it.skipIf(!posix)('a SIGTERM during a project records interrupted, never verifies, releases the lock, and the next run reruns that project', async () => {
    const t = makeRepo();
    const run = await startAndWait(t, ['full', 'test'], { RUNNER_SLEEP: 'B' }, 'B');
    // The lock records the stage's child PID while a stage runs.
    expect(JSON.parse(fs.readFileSync(t.lockPath, 'utf8'))).toMatchObject({ phase: 'idle', childPid: expect.any(Number) });
    run.child.kill('SIGTERM');
    const { code } = await run.closed;
    expect(code, run.output()).toBe(143);
    const receipt = t.receipt();
    expect(receipt.status).toBe('interrupted');
    expect(receipt.interruptedBy).toBe('SIGTERM');
    expect(receipt.projects.map(p => [p.name, p.status])).toEqual([['A', 'passed'], ['B', 'interrupted'], ['C', 'not-run']]);
    expect(fs.existsSync(t.lockPath)).toBe(false);
    expect(t.gate(['verify-receipt', '--mode', 'full']).code).toBe(1);
    // B is rerun (interrupted is never reused); A is not: its pass is still valid; C was never run.
    const next = t.ran(['full', 'test']);
    expect(next.code, next.out).toBe(0);
    expect(next.runs).toEqual(['build', 'B', 'C']);
  });

  it.skipIf(!posix)('gate.js stop ends a running gate cooperatively: interrupted receipt, lock released', async () => {
    const t = makeRepo();
    const run = await startAndWait(t, ['full', 'test'], { RUNNER_SLEEP: 'A' }, 'A');
    const stop = spawnSync(process.execPath, [GATE, 'stop'], { cwd: t.root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: t.root }, timeout: 60000 });
    expect(stop.status, stop.stdout + stop.stderr).toBe(0);
    expect(stop.stdout).toContain('stop: stopped');
    const { code } = await run.closed;
    expect(code).not.toBe(0);
    expect(t.receipt().status).toBe('interrupted');
    expect(fs.existsSync(t.lockPath)).toBe(false);
    expect(fs.existsSync(path.join(t.root, 'docs/.output/.state/telemetry/.gate.stop'))).toBe(false);
    expect(t.gate(['verify-receipt']).code).toBe(1);
  });

  it('stop with no gate running says so and exits 0; a lock whose owner is gone is reported as still held, never removed', () => {
    const t = makeRepo();
    const none = t.gate(['stop']);
    expect(none.code).toBe(0);
    expect(none.out).toContain('no gate is running');
    fs.mkdirSync(path.dirname(t.lockPath), { recursive: true });
    fs.writeFileSync(t.lockPath, JSON.stringify({ pid: 2147483646, started: new Date().toISOString(), protocol: 'domdhi-gate/lease-v2', phase: 'running', treeInProgress: true }));
    const held = t.gate(['stop']);
    expect(held.code).toBe(1);
    expect(held.out).toContain('still held');
    expect(fs.existsSync(t.lockPath)).toBe(true);
  });
});

describe('tree changed during the run (plan 5)', () => {
  it('a run whose tree changed is invalid: it fails, never verifies, and is never reused', () => {
    const t = makeRepo();
    const r = t.ran(['full', 'test'], { RUNNER_EDIT: 'A' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/the tree changed during the run \([0-9a-f]{12} → [0-9a-f]{12}\); this run proves nothing/);
    expect(t.receipt().status).toBe('invalid');
    expect(t.receipt().treeHashStart).not.toBe(t.receipt().treeHashEnd);
    expect(t.gate(['verify-receipt', '--mode', 'full']).code).toBe(1);
    // The results of that run are marked invalid, so the next run reruns everything it covered.
    const next = t.ran(['full', 'test']);
    expect(next.code, next.out).toBe(0);
    expect(next.runs).toEqual(['build', 'A', 'B', 'C']);
  });

  it('for an adopter that has not opted in, a changed tree is recorded in the receipt but does not change the gate verdict', () => {
    const t = makeRepo({ config: { test: { command: 'node runner.js unit', timeout: 60000 } } });
    const r = t.ran(['test'], { RUNNER_EDIT: 'unit' });
    expect(r.code, r.out).toBe(0);
    expect(t.receipt().status).toBe('invalid');
  });
});

describe('verify-receipt (plan 6)', () => {
  it('matches (exit 0), prints a JSON verdict, and reports the tree hash after an edit (exit 1)', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    const ok = t.gate(['verify-receipt', '--mode', 'full']);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain('verify-receipt (mode full): OK');
    const json = JSON.parse(t.gate(['verify-receipt', '--mode', 'full', '--json']).stdout);
    expect(json).toMatchObject({ ok: true, reasons: [], receipt: { status: 'passed', mode: 'full' } });
    t.write('A/A.cs', 'class A { int changed; }\n');
    const bad = t.gate(['verify-receipt', '--mode', 'full']);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/tree hash: the receipt covers [0-9a-f]{12} but the tree is now [0-9a-f]{12}/);
    expect(bad.out).toContain('Fix: run: node .claude/core/gate.js full test');
    const badJson = JSON.parse(t.gate(['verify-receipt', '--json']).stdout);
    expect(badJson.ok).toBe(false);
    expect(badJson.reasons[0]).toMatchObject({ check: 'treeHash' });
  });

  it('a missing receipt is exit 1, never a crash; it takes no lock and builds nothing', () => {
    const t = makeRepo();
    const r = t.gate(['verify-receipt']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('no gate receipt');
    expect(t.runs()).toEqual([]);
    expect(fs.existsSync(t.lockPath)).toBe(false);
  });

  it('a usage error is exit 2', () => {
    const t = makeRepo();
    expect(t.gate(['verify-receipt', '--mode', 'sometimes']).code).toBe(2);
    expect(t.gate(['verify-receipt', 'test']).code).toBe(2);
  });

  it('a configured project missing from the receipt fails verification', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    // A project added to the config invalidates the config hash, and would also be missing from the receipt.
    t.setConfig({ test: { filter: 'Category!=Integration', timeout: 60000, projects: [projectEntry('A'), projectEntry('B'), projectEntry('C'), projectEntry('D', { path: 'D/D.csproj' })] } });
    const v = t.gate(['verify-receipt', '--mode', 'full']);
    expect(v.code).toBe(1);
    expect(v.out).toContain('project D: no result in the receipt');
  });
});

describe('arguments (plan 7)', () => {
  it('--help prints usage and exits 0 without taking the lock or building', () => {
    const t = makeRepo();
    for (const flag of ['--help', '-h']) {
      const r = t.gate([flag]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: node .claude/core/gate.js');
    }
    expect(t.runs()).toEqual([]);
    expect(fs.existsSync(t.lockPath)).toBe(false);
    expect(fs.existsSync(path.join(t.root, 'docs/.output/.state/telemetry'))).toBe(false);
  });

  it('an unknown argument prints usage and exits 2, also without a lock or a build', () => {
    const t = makeRepo();
    const r = t.gate(['--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown argument "--bogus"');
    expect(r.stderr).toContain('Usage: node .claude/core/gate.js');
    expect(t.runs()).toEqual([]);
    expect(fs.existsSync(t.lockPath)).toBe(false);
    expect(fs.existsSync(path.join(t.root, 'docs/.output/.state/telemetry'))).toBe(false);
    expect(t.gate(['full', '--changed']).code).toBe(2);
  });
});

describe('reuse eligibility (plan 8)', () => {
  it('a project that is not listed with reuse: true always runs', () => {
    const t = makeRepo({ projects: [projectEntry('A', { reuse: false }), projectEntry('B', { reuse: undefined }), projectEntry('C')] });
    t.ran(['full', 'test']);
    const again = t.ran(['full', 'test']);
    expect(again.runs).toEqual(['build', 'A', 'B']);
    expect(again.out).toContain('A: running (not opted in');
    expect(again.out).toMatch(/C: reused from receipt/);
  });

  it('a listed project whose own source reads the file system is not reused, and the run names the file and line', () => {
    const t = makeRepo({ files: { 'C/Guard.cs': 'class G {\n  void M() {\n    var all = File.ReadAllText("../README.md");\n  }\n}\n' } });
    t.ran(['full', 'test']);
    const again = t.ran(['full', 'test']);
    expect(again.runs).toEqual(['build', 'C']);
    expect(again.out).toContain('C: running (static scan vetoed reuse: C/Guard.cs:3');
  });

  it('inputs: ["tree"] clears the veto and the project reruns on any edit, even a docs-only one', () => {
    const t = makeRepo({
      files: { 'C/Guard.cs': 'class G { void M() { var x = File.ReadAllText("a"); } }\n' },
      projects: [projectEntry('A'), projectEntry('B'), projectEntry('C', { inputs: ['tree'] })],
    });
    t.ran(['full', 'test']);
    // No edit at all: every project including the tree-input one is reused.
    expect(t.ran(['full', 'test']).runs).toEqual([]);
    // A docs-only edit: A and B are still reused, C reruns, so the build has to run too.
    t.write('docs/x.md', 'edited\n');
    expect(t.ran(['full', 'test']).runs).toEqual(['build', 'C']);
  });

  it('forceRunEvery: a project is forced to run for real after N consecutive reuses', () => {
    const t = makeRepo({ config: { receipts: { forceRunEvery: 2 } } });
    t.ran(['full', 'test']);
    expect(t.ran(['full', 'test']).runs).toEqual([]);   // reuse 1
    expect(t.ran(['full', 'test']).runs).toEqual([]);   // reuse 2
    const forced = t.ran(['full', 'test']);              // forced refresh
    expect(forced.runs).toEqual(['build', 'A', 'B', 'C']);
    expect(forced.out).toContain('forced refresh');
    expect(t.ran(['full', 'test']).runs).toEqual([]);   // reuse again from the fresh real run
  });

  it('maxAgeHours: an old receipt is not reused (receipts.maxAgeHours is tiny, the run time is real)', () => {
    // The pure decision is pinned with a fixed `now` in gate-receipt.test.js; here, a limit no run can meet.
    const t = makeRepo({ config: { receipts: { maxAgeHours: 0.0000001 } } });
    t.ran(['full', 'test']);
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
    const again = t.ran(['full', 'test']);
    expect(again.runs).toEqual(['build', 'A', 'B', 'C']);
    expect(again.out).toContain('maxAgeHours');
  });

  it('CI runs everything even when valid receipts exist', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    expect(t.ran(['full', 'test']).runs).toEqual([]);
    const ci = t.ran(['full', 'test'], { CI: 'true' });
    expect(ci.runs).toEqual(['build', 'A', 'B', 'C']);
    expect(ci.out).toContain('A: running (CI runs everything)');
  });

  it('a project whose closure cannot be determined runs, and says why', () => {
    const t = makeRepo({ files: { 'C/C.csproj': proj('..\\Missing\\Missing.csproj') } });
    t.ran(['full', 'test']);
    const again = t.ran(['full', 'test']);
    expect(again.runs).toEqual(['build', 'C']);
    expect(again.out).toContain('C: running (input closure unknown');
  });

  it('a hard-killed run (left "running") can never verify and nothing from it is reused', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    const receipt = t.receipt();
    fs.writeFileSync(path.join(t.root, 'docs/.output/.state/telemetry/gate-receipt.json'), JSON.stringify({ ...receipt, status: 'running', exitCode: null, endedAt: null }));
    expect(t.gate(['verify-receipt', '--mode', 'full']).code).toBe(1);
  });

  it('a configuration error in test.projects is refused (exit 2), not guessed at', () => {
    const t = makeRepo({ projects: [projectEntry('A'), projectEntry('A')] });
    const r = t.ran(['full', 'test']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('duplicates the name "A"');
    expect(r.runs).toEqual([]);
  });
});

describe('summary and unchanged behavior', () => {
  it('_latest-summary.json keeps its fields and adds the receipt path', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    const summary = JSON.parse(fs.readFileSync(path.join(t.root, 'docs/.output/.state/telemetry/_latest-summary.json'), 'utf8'));
    expect(summary).toMatchObject({ overall: true, receipt: 'docs/.output/.state/telemetry/gate-receipt.json', build: { succeeded: true }, test: { succeeded: true, passed: 15, skipped: 3, total: 18, reused: 0 } });
  });

  it('a config without test.projects keeps the single test leg exactly as before, and still writes a receipt', () => {
    const t = makeRepo({ config: { test: { command: 'node runner.js unit', timeout: 60000 } } });
    const r = t.ran(['test']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('[GATE] Tests: PASSED (5 passed, 0 failed, 1 skipped)');
    expect(r.runs).toEqual(['build', 'unit']);
    expect(t.receipt()).toMatchObject({ status: 'passed', mode: 'normal', projects: [] });
    expect(t.ran(['test']).runs).toEqual(['build', 'unit']); // no projects, so nothing is ever reused
  });

  it('a build-only run does not touch the test receipt', () => {
    const t = makeRepo();
    t.ran(['full', 'test']);
    const before = fs.readFileSync(path.join(t.root, 'docs/.output/.state/telemetry/gate-receipt.json'), 'utf8');
    t.ran(['build']);
    expect(fs.readFileSync(path.join(t.root, 'docs/.output/.state/telemetry/gate-receipt.json'), 'utf8')).toBe(before);
  });
});

describe('PR helper check (plan 9)', () => {
  function prRepo(config = {}) {
    const t = makeRepo({ config });
    t.git('remote', 'add', 'origin', 'https://github.com/acme/widget.git');
    t.git('checkout', '-q', '-b', 'feat/x');
    return t;
  }
  const runPr = (t, args) => {
    const r = spawnSync(process.execPath, [PR_JS, ...args], {
      cwd: t.root, encoding: 'utf8', timeout: 60000,
      // No network: the fetch of origin is refused at once; --force downgrades that, nothing else.
      env: { ...process.env, CLAUDE_PROJECT_DIR: t.root, GIT_ALLOW_PROTOCOL: 'none', GIT_TERMINAL_PROMPT: '0' },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('with requireFullForPr and no receipt, create refuses with the fix command, and --force does not bypass it', () => {
    const t = prRepo({ receipts: { requireFullForPr: true } });
    const r = runPr(t, ['create', '--title', 'feat: x', '--force']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[pr] refusing: no valid full-gate receipt for this exact tree');
    expect(r.out).toContain('Fix: node .claude/core/gate.js full test, then retry.');
    expect(r.out).toContain('--force given — proceeding despite the unverified base');
  });

  it('a normal-mode receipt is not enough; a full receipt for this exact tree lets the check through', () => {
    const t = prRepo({ receipts: { requireFullForPr: true } });
    t.ran(['test']);
    const normalOnly = runPr(t, ['create', '--title', 'feat: x', '--force']);
    expect(normalOnly.code).toBe(1);
    expect(normalOnly.out).toContain('a full pass is required');
    t.ran(['full', 'test']);
    const withFull = runPr(t, ['create', '--title', 'feat: x', '--force']);
    // Past the receipt check the helper stops at the missing body file; the point is it is not refused for the gate.
    expect(withFull.out).not.toContain('no valid full-gate receipt');
    expect(withFull.out).toContain('body file not found');
  });

  it('an edit after the full pass voids the receipt', () => {
    const t = prRepo({ receipts: { requireFullForPr: true } });
    t.ran(['full', 'test']);
    t.write('A/A.cs', 'class A { int later; }\n');
    const r = runPr(t, ['create', '--title', 'feat: x', '--force']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('tree hash');
  });

  it('--dry-run reports whether the receipt check would pass, and creates nothing', () => {
    const t = prRepo({ receipts: { requireFullForPr: true } });
    const without = runPr(t, ['create', '--title', 'feat: x', '--dry-run']);
    expect(without.code).toBe(0);
    expect(without.out).toContain('gate receipt check: WOULD REFUSE');
    t.ran(['full', 'test']);
    const withIt = runPr(t, ['create', '--title', 'feat: x', '--dry-run']);
    expect(withIt.out).toContain('gate receipt check: would pass');
    expect(withIt.out).toContain('dry-run only');
  });

  it('without requireFullForPr the helper does not look at receipts at all', () => {
    const t = prRepo();
    const r = runPr(t, ['create', '--title', 'feat: x', '--dry-run']);
    expect(r.out).toContain('gate receipt check: not required');
    const live = runPr(t, ['create', '--title', 'feat: x', '--force']);
    expect(live.out).not.toContain('no valid full-gate receipt');
  });
});

describe('static checks of the engine wiring', () => {
  it('requireFullForPr defaults to false in the shared defaults', () => {
    expect(gr.DEFAULT_RECEIPTS.requireFullForPr).toBe(false);
    expect(gr.DEFAULT_RECEIPTS).toMatchObject({ maxAgeHours: 24, forceRunEvery: 5 });
  });
});
