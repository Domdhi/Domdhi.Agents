// Unit tests for _lib/gate-receipt.js: argument parsing, closure, static scan, the reuse
// decision, history, verification and the working-tree hash. Inputs are synthetic; every
// instant is passed in as `now` (no test reads the clock to decide anything).

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const gr = require('../gate-receipt');

const NOW = Date.parse('2026-03-02T12:00:00.000Z');
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

describe('parseGateArgs', () => {
  const parse = (...a) => gr.parseGateArgs(a);
  it('treats no arguments as a build-only run, exactly as before', () => {
    expect(parse()).toMatchObject({ ok: true, command: 'run', runTests: false, runE2e: false, skipBuild: false, mode: 'normal' });
  });
  it('keeps every existing spelling working', () => {
    expect(parse('test')).toMatchObject({ ok: true, runTests: true, full: false, mode: 'normal' });
    expect(parse('--test')).toMatchObject({ runTests: true });
    expect(parse('build')).toMatchObject({ runTests: false });
    expect(parse('e2e')).toMatchObject({ runE2e: true, runTests: false });
    expect(parse('--e2e')).toMatchObject({ runE2e: true });
    expect(parse('--no-build')).toMatchObject({ skipBuild: true, runTests: true });
    expect(parse('test', '--no-build', '--changed')).toMatchObject({ skipBuild: true, changedOnly: true, runTests: true });
  });
  it('full is a test mode that records mode "full"', () => {
    expect(parse('full')).toMatchObject({ ok: true, runTests: true, full: true, mode: 'full' });
    expect(parse('full', 'test')).toMatchObject({ runTests: true, full: true, mode: 'full' });
  });
  it('rejects full combined with --changed or e2e (full means no change-scoping)', () => {
    expect(parse('full', '--changed')).toMatchObject({ ok: false });
    expect(parse('full', 'e2e')).toMatchObject({ ok: false });
  });
  it('--help and -h win over everything else', () => {
    expect(parse('--help')).toMatchObject({ ok: true, help: true });
    expect(parse('-h')).toMatchObject({ ok: true, help: true });
    expect(parse('--bogus', '--help')).toMatchObject({ ok: true, help: true });
  });
  it('an unknown argument is a usage error', () => {
    expect(parse('--bogus')).toMatchObject({ ok: false });
    expect(parse('test', 'frobnicate')).toMatchObject({ ok: false });
  });
  it('verify-receipt takes --mode and --json only', () => {
    expect(parse('verify-receipt')).toMatchObject({ ok: true, command: 'verify-receipt', mode: 'normal', json: false });
    expect(parse('verify-receipt', '--mode', 'full', '--json')).toMatchObject({ command: 'verify-receipt', mode: 'full', json: true });
    expect(parse('verify-receipt', '--mode', 'bogus')).toMatchObject({ ok: false });
    expect(parse('verify-receipt', '--mode')).toMatchObject({ ok: false });
    expect(parse('verify-receipt', 'test')).toMatchObject({ ok: false });
  });
  it('--mode and --json are rejected outside verify-receipt, and stop takes nothing', () => {
    expect(parse('test', '--json')).toMatchObject({ ok: false });
    expect(parse('test', '--mode', 'full')).toMatchObject({ ok: false });
    expect(parse('stop')).toMatchObject({ ok: true, command: 'stop' });
    expect(parse('stop', '--json')).toMatchObject({ ok: false });
    expect(parse('stop', 'verify-receipt')).toMatchObject({ ok: false });
  });
});

describe('receiptsConfig', () => {
  it('defaults to 24 hours, a forced refresh every 5 reuses, and no PR requirement', () => {
    expect(gr.receiptsConfig({})).toMatchObject({ maxAgeHours: 24, forceRunEvery: 5, requireFullForPr: false, warnings: [] });
  });
  it('takes valid values and falls back, with a warning, on invalid ones', () => {
    expect(gr.receiptsConfig({ receipts: { maxAgeHours: 2, forceRunEvery: 3, requireFullForPr: true } })).toMatchObject({ maxAgeHours: 2, forceRunEvery: 3, requireFullForPr: true });
    const bad = gr.receiptsConfig({ receipts: { maxAgeHours: -1, forceRunEvery: 0, requireFullForPr: 'yes' } });
    expect(bad).toMatchObject({ maxAgeHours: 24, forceRunEvery: 5, requireFullForPr: false });
    expect(bad.warnings).toHaveLength(3);
  });
});

describe('normalizeProjects', () => {
  it('builds the default dotnet command for a project file, with the filter passed verbatim', () => {
    const { projects, errors } = gr.normalizeProjects({ projects: [{ name: 'A', path: 'tests\\A\\A.csproj', reuse: true }] }, 'Category!=Integration&Category!=AgentHarness');
    expect(errors).toEqual([]);
    // The path stays exactly as configured in the command; only the closure uses the normalized form.
    expect(projects[0].path).toBe('tests/A/A.csproj');
    expect(projects[0].argv).toEqual(['dotnet', 'test', 'tests\\A\\A.csproj', '--configuration', 'Release', '--verbosity', 'minimal', '--no-build', '--filter', 'Category!=Integration&Category!=AgentHarness']);
    expect(projects[0].reuse).toBe(true);
  });
  it('an explicit argv or command wins; reuse defaults to false', () => {
    const { projects } = gr.normalizeProjects({ projects: [{ name: 'T', path: 'x/T.csproj', argv: ['node', 'run.js'] }, { name: 'S', command: 'make test' }] }, 'f');
    expect(projects[0].argv).toEqual(['node', 'run.js']);
    expect(projects[1].command).toBe('make test');
    expect(projects.map(p => p.reuse)).toEqual([false, false]);
  });
  it('refuses duplicate names, missing commands and malformed fields instead of guessing', () => {
    const { projects, errors } = gr.normalizeProjects({ projects: [{ name: 'A', path: 'a.csproj' }, { name: 'A', path: 'b.csproj' }, { name: 'B' }, { name: 'C', path: 'c.csproj', reuse: 'yes' }, { name: 'D', path: 'd.csproj', inputs: 'tree' }, 7] }, null);
    expect(projects.map(p => p.name)).toEqual(['A']);
    expect(errors).toHaveLength(5);
  });
  it('no projects means the single test leg behaves exactly as before', () => {
    expect(gr.normalizeProjects({ command: 'npm test' }, null)).toEqual({ projects: [], errors: [] });
  });
});

describe('scanStaticReads', () => {
  const scan = (text, p = 'T/Arch.cs') => gr.scanStaticReads([{ path: p, text }]);
  it('flags File., Directory., FileInfo, DirectoryInfo and enumeration, naming file and line', () => {
    const hits = scan('class A {\n  void M() {\n    var t = File.ReadAllText("x");\n    var d = new DirectoryInfo(".");\n    foreach (var f in Directory.EnumerateFiles(".")) {}\n  }\n}');
    expect(hits.map(h => h.line)).toEqual([3, 4, 5]);
    expect(hits[0]).toMatchObject({ file: 'T/Arch.cs', line: 3 });
  });
  it('flags Path.Combine only near a repo-root helper', () => {
    expect(scan('var p = Path.Combine(FindRepoRoot(), "src");')).toHaveLength(1);
    expect(scan('var p = Path.Combine(a, b);')).toHaveLength(0);
  });
  it('flags a base directory followed by ..', () => {
    expect(scan('var d = AppContext.BaseDirectory;\nvar up = Path.GetFullPath(d + "/../../..");')).toHaveLength(1);
    expect(scan('var d = AppContext.BaseDirectory;')).toHaveLength(0);
  });
  it('does not match identifiers that merely contain the words, and ignores non-source files', () => {
    expect(scan('var x = Profile.Load(); var y = MyFile.Value;')).toHaveLength(0);
    expect(gr.scanStaticReads([{ path: 'T/data.json', text: 'File.ReadAllText' }])).toHaveLength(0);
  });
});

// ── closure ─────────────────────────────────────────────────────────

const csproj = (...refs) => `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${refs.join('\n')}\n  </ItemGroup>\n</Project>\n`;
const pref = (p) => `    <ProjectReference Include="${p}" />`;
function repo(files) {
  const entries = new Map(Object.keys(files).map((p, i) => [p, { mode: '100644', blob: `blob${i}-${files[p].length}-${p}` }]));
  return { entries, readText: (p) => (p in files ? files[p] : null) };
}
const base = () => ({
  'A/A.csproj': csproj(pref('..\\B\\B.csproj')), 'A/A.cs': 'class A {}',
  'B/B.csproj': csproj(), 'B/B.cs': 'class B {}', 'B/bin/Release/B.dll': 'bin', 'B/obj/x.json': 'obj',
  'C/C.csproj': csproj(), 'C/C.cs': 'class C {}', 'Directory.Build.props': '<Project/>', 'docs/x.md': 'doc',
});

describe('dotnetClosure', () => {
  it('covers the project directory, its transitive references and the config chain; drops bin/ and obj/', () => {
    const r = repo(base());
    const c = gr.dotnetClosure({ ...r, projectPath: 'A/A.csproj' });
    expect(c.known).toBe(true);
    const names = [...c.files.keys()];
    expect(names).toEqual(expect.arrayContaining(['A/A.csproj', 'A/A.cs', 'B/B.csproj', 'B/B.cs', 'Directory.Build.props']));
    expect(names).not.toContain('C/C.cs');
    expect(names).not.toContain('docs/x.md');
    expect(names).not.toContain('B/bin/Release/B.dll');
    expect(names).not.toContain('B/obj/x.json');
  });
  it('records an absent Directory.Build.props, so creating one changes the closure', () => {
    const files = base(); delete files['Directory.Build.props'];
    const before = gr.dotnetClosure({ ...repo(files), projectPath: 'C/C.csproj' });
    expect(before.files.get('Directory.Build.props')).toBe('ABSENT');
    const after = gr.dotnetClosure({ ...repo({ ...files, 'Directory.Build.props': '<Project/>' }), projectPath: 'C/C.csproj' });
    expect(gr.hashFiles(before.files, 'm')).not.toBe(gr.hashFiles(after.files, 'm'));
  });
  it('is unknown when a ProjectReference is missing, uses a property, or the file is unparseable', () => {
    expect(gr.dotnetClosure({ ...repo({ ...base(), 'A/A.csproj': csproj(pref('..\\Nope\\Nope.csproj')) }), projectPath: 'A/A.csproj' })).toMatchObject({ known: false });
    expect(gr.dotnetClosure({ ...repo({ ...base(), 'A/A.csproj': csproj(pref('$(Root)\\B\\B.csproj')) }), projectPath: 'A/A.csproj' })).toMatchObject({ known: false });
    expect(gr.dotnetClosure({ ...repo({ ...base(), 'B/B.csproj': 'not xml at all' }), projectPath: 'A/A.csproj' })).toMatchObject({ known: false });
    expect(gr.dotnetClosure({ ...repo(base()), projectPath: 'Missing/M.csproj' })).toMatchObject({ known: false });
  });
  it('is unknown for an Include or Import that uses a property or a wildcard outside the project directory', () => {
    const withItem = (item) => gr.dotnetClosure({ ...repo({ ...base(), 'C/C.csproj': `<Project Sdk="x">\n<ItemGroup>${item}</ItemGroup></Project>` }), projectPath: 'C/C.csproj' });
    expect(withItem('<Compile Include="..\\Shared\\**\\*.cs" />').known).toBe(false);
    expect(withItem('<Compile Include="$(GenDir)\\x.cs" />').known).toBe(false);
    expect(withItem('<Content Include="..\\docs\\x.md" />').known).toBe(true);
    expect(withItem('<Content Include="..\\docs\\missing.md" />').known).toBe(false);
    expect(withItem('<Compile Include="Sub\\**\\*.cs" />').known).toBe(true);
    const withImport = (imp) => gr.dotnetClosure({ ...repo({ ...base(), 'C/C.csproj': `<Project Sdk="x">${imp}</Project>` }), projectPath: 'C/C.csproj' });
    expect(withImport('<Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />').known).toBe(false);
    expect(withImport('<Import Project="..\\Directory.Build.props" />').known).toBe(true);
    expect(withImport('<Import Project="Sdk.props" Sdk="Microsoft.NET.Sdk" />').known).toBe(true);
  });
  it('resolves a reference whose casing differs from the tracked path, and refuses an ambiguous one', () => {
    expect(gr.dotnetClosure({ ...repo({ ...base(), 'A/A.csproj': csproj(pref('..\\b\\b.csproj')) }), projectPath: 'A/A.csproj' }).known).toBe(true);
    expect(gr.dotnetClosure({ ...repo({ ...base(), 'b/B.csproj': csproj(), 'A/A.csproj': csproj(pref('..\\B\\b.csproj')) }), projectPath: 'A/A.csproj' }).known).toBe(false);
  });
  it('survives a reference cycle', () => {
    const files = { ...base(), 'B/B.csproj': csproj(pref('..\\A\\A.csproj')) };
    expect(gr.dotnetClosure({ ...repo(files), projectPath: 'A/A.csproj' }).known).toBe(true);
  });
});

describe('projectClosure', () => {
  const meta = { engine: 'e', configHash: 'c', filter: 'f', mode: 'normal' };
  const snapshot = (files) => ({ ...repo(files), hash: 'treehash', entries: repo(files).entries });
  const closure = (project, files = base()) => gr.projectClosure({ project: { inputs: [], ...project }, snapshot: snapshot(files), readText: repo(files).readText, meta });
  it('hashes the same closure the same way, and changes when a file in it changes', () => {
    const a = closure({ path: 'A/A.csproj', display: 'x' });
    const same = closure({ path: 'A/A.csproj', display: 'x' });
    expect(a.hash).toBe(same.hash);
    const edited = base();
    edited['B/B.cs'] = 'class B { int x; }';
    expect(closure({ path: 'A/A.csproj', display: 'x' }, edited).hash).not.toBe(a.hash);
    expect(closure({ path: 'C/C.csproj', display: 'x' }, edited).hash).toBe(closure({ path: 'C/C.csproj', display: 'x' }).hash);
  });
  it('changes with the command, the filter, the mode, the engine and the config', () => {
    const p = { path: 'C/C.csproj', display: 'x' };
    const files = base();
    const h = (m, project = p) => gr.projectClosure({ project: { inputs: [], ...project }, snapshot: snapshot(files), readText: repo(files).readText, meta: m }).hash;
    const baseHash = h(meta);
    expect(h({ ...meta, filter: 'other' })).not.toBe(baseHash);
    expect(h({ ...meta, mode: 'full' })).not.toBe(baseHash);
    expect(h({ ...meta, engine: 'e2' })).not.toBe(baseHash);
    expect(h({ ...meta, configHash: 'c2' })).not.toBe(baseHash);
    expect(h(meta, { ...p, display: 'y' })).not.toBe(baseHash);
  });
  it('a non-.NET project with no inputs is unknown; with inputs it is hashed over them; an input that matches nothing is unknown', () => {
    expect(closure({ display: 'x', argv: ['node', 't.js'] })).toMatchObject({ known: false });
    const files = { ...base(), 'tools/a.js': '1', 'tools/b.js': '2' };
    const withInputs = closure({ display: 'x', argv: ['node'], inputs: ['tools/**'] }, files);
    expect(withInputs.known).toBe(true);
    expect([...withInputs.files.keys()]).toEqual(['tools/a.js', 'tools/b.js']);
    expect(closure({ display: 'x', argv: ['node'], inputs: ['nothing/**'] }, files)).toMatchObject({ known: false });
  });
  it('"tree" makes the closure the whole tree hash', () => {
    const t1 = gr.projectClosure({ project: { inputs: ['tree'], display: 'x', path: 'C/C.csproj' }, snapshot: { hash: 'h1', entries: new Map() }, readText: () => null, meta });
    const t2 = gr.projectClosure({ project: { inputs: ['tree'], display: 'x', path: 'C/C.csproj' }, snapshot: { hash: 'h2', entries: new Map() }, readText: () => null, meta });
    expect(t1.known && t2.known).toBe(true);
    expect(t1.hash).not.toBe(t2.hash);
  });
});

describe('buildClosure', () => {
  const meta = { engine: 'e', configHash: 'c', mode: 'normal' };
  it('joins every project in a root solution, and is unknown when one cannot be resolved', () => {
    const sln = 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "A\\A.csproj", "{1}"\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Z", "Z\\Z.csproj", "{2}"\n';
    const files = { ...base(), 'App.sln': sln };
    const r = repo(files);
    const projectClosures = [gr.dotnetClosure({ ...r, projectPath: 'C/C.csproj' })];
    const missing = gr.buildClosure({ projectClosures, snapshot: { hash: 'h', entries: r.entries }, readText: r.readText, meta, buildDisplay: 'b' });
    expect(missing.known).toBe(false);
    const r2 = repo({ ...base(), 'Z/Z.csproj': csproj(), 'Z/Z.cs': 'z', 'App.sln': sln });
    const ok = gr.buildClosure({ projectClosures, snapshot: { hash: 'h', entries: r2.entries }, readText: r2.readText, meta, buildDisplay: 'b' });
    expect(ok.known).toBe(true);
    expect([...ok.files.keys()]).toContain('Z/Z.cs');
  });
  it('is unknown when any project closure is unknown', () => {
    expect(gr.buildClosure({ projectClosures: [{ known: false }], snapshot: { hash: 'h', entries: new Map() }, readText: () => null, meta, buildDisplay: 'b' }).known).toBe(false);
  });
});

// ── the reuse decision ──────────────────────────────────────────────

describe('decideReuse', () => {
  const project = { name: 'Features', reuse: true, inputs: [] };
  const record = (over = {}) => ({ id: 'r1', name: 'Features', closureHash: 'H', filter: 'F', mode: 'full', command: 'cmd', status: 'passed', ranAt: iso(NOW - HOUR), passed: 10, skipped: 1, total: 11, reuseCount: 0, ...over });
  const cfg = { maxAgeHours: 24, forceRunEvery: 5 };
  const decide = (over = {}) => gr.decideReuse({
    project, command: 'cmd', closureHash: 'H', filter: 'F', mode: 'full', now: NOW, history: [record()], staticScan: [], config: cfg, ...over,
  });

  it('reuses only when every condition holds, and names where the result came from', () => {
    const d = decide();
    expect(d.reuse).toBe(true);
    expect(d.from.id).toBe('r1');
  });
  it('RUN: the project is not opted in', () => {
    expect(decide({ project: { ...project, reuse: false } }).reuse).toBe(false);
    expect(decide({ project: { name: 'Features' } })).toMatchObject({ reuse: false, reason: expect.stringContaining('not opted in') });
  });
  it('RUN: the closure is unknown', () => {
    expect(decide({ closureHash: null, closureReason: 'missing ref' })).toMatchObject({ reuse: false, reason: expect.stringContaining('missing ref') });
  });
  it('RUN: no record, or a record for a different closure, filter, mode or command', () => {
    expect(decide({ history: [] }).reuse).toBe(false);
    expect(decide({ closureHash: 'H2' }).reuse).toBe(false);
    expect(decide({ filter: 'F2' }).reuse).toBe(false);
    expect(decide({ mode: 'normal' }).reuse).toBe(false);
    expect(decide({ command: 'cmd2' }).reuse).toBe(false);
    expect(decide({ history: [record({ name: 'Other' })] }).reuse).toBe(false);
  });
  it('RUN: the last result was not a pass (failed, interrupted, invalid), or is flaky', () => {
    for (const status of ['failed', 'interrupted', 'invalid', 'running']) expect(decide({ history: [record({ status })] }).reuse).toBe(false);
    expect(decide({ history: [record({ flaky: true })] })).toMatchObject({ reuse: false, reason: expect.stringContaining('flaky') });
  });
  it('the most recent record for the key decides, not an older pass', () => {
    expect(decide({ history: [record({ id: 'old' }), record({ id: 'new', status: 'failed' })] }).reuse).toBe(false);
    expect(decide({ history: [record({ id: 'old', status: 'failed' }), record({ id: 'new' })] })).toMatchObject({ reuse: true, from: { id: 'new' } });
  });
  it('maxAgeHours: a result exactly at the limit is reusable, one millisecond older is not (fixed now)', () => {
    expect(decide({ history: [record({ ranAt: iso(NOW - 24 * HOUR) })] }).reuse).toBe(true);
    expect(decide({ history: [record({ ranAt: iso(NOW - 24 * HOUR - 1) })] })).toMatchObject({ reuse: false, reason: expect.stringContaining('maxAgeHours') });
    expect(decide({ history: [record({ ranAt: iso(NOW - 3 * HOUR) })], config: { ...cfg, maxAgeHours: 2 } }).reuse).toBe(false);
  });
  it('RUN: an unreadable or future run time is unknown, not a pass', () => {
    expect(decide({ history: [record({ ranAt: 'garbage' })] }).reuse).toBe(false);
    expect(decide({ history: [record({ ranAt: iso(NOW + HOUR) })] }).reuse).toBe(false);
  });
  it('forceRunEvery: reuses 1..N are allowed, the next one must run for real', () => {
    for (const reuseCount of [0, 1, 4]) expect(decide({ history: [record({ reuseCount })] }).reuse).toBe(true);
    expect(decide({ history: [record({ reuseCount: 5 })] })).toMatchObject({ reuse: false, reason: expect.stringContaining('forced refresh') });
    expect(decide({ history: [record({ reuseCount: 2 })], config: { ...cfg, forceRunEvery: 2 } }).reuse).toBe(false);
  });
  it('RUN: a static-scan hit names the file and line, unless inputs are declared', () => {
    const hits = [{ file: 'T/Arch.cs', line: 12, kind: 'File./Directory. call', text: 'File.ReadAllText(x)' }];
    const d = decide({ staticScan: hits });
    expect(d.reuse).toBe(false);
    expect(d.reason).toContain('T/Arch.cs:12');
    expect(decide({ staticScan: hits, project: { ...project, inputs: ['tree'] } }).reuse).toBe(true);
  });
});

describe('history', () => {
  const rec = (status, over = {}) => ({ id: `r-${status}`, name: 'P', closureHash: 'H', filter: 'F', mode: 'full', command: 'c', status, ranAt: iso(NOW), ...over });
  it('marks a pass that follows a failure on the same key as flaky, and two real passes clear it', () => {
    let h = gr.appendRecord([], rec('failed'));
    h = gr.appendRecord(h, rec('passed', { id: 'p1' }));
    expect(h[1].flaky).toBe(true);
    h = gr.appendRecord(h, rec('passed', { id: 'p2' }));
    expect(h[2].flaky).toBeUndefined();
  });
  it('a failure on a different closure does not make a pass flaky', () => {
    let h = gr.appendRecord([], rec('failed', { closureHash: 'OTHER' }));
    h = gr.appendRecord(h, rec('passed'));
    expect(h[1].flaky).toBeUndefined();
  });
  it('a new record starts with no reuses, bumpReuse counts them, and history is capped', () => {
    let h = gr.appendRecord([], rec('passed', { id: 'x' }));
    expect(h[0].reuseCount).toBe(0);
    h = gr.bumpReuse(gr.bumpReuse(h, 'x'), 'x');
    expect(h[0].reuseCount).toBe(2);
    let many = [];
    for (let i = 0; i < 205; i++) many = gr.appendRecord(many, rec('passed', { id: `i${i}` }));
    expect(many).toHaveLength(gr.HISTORY_CAP);
    expect(many.at(-1).id).toBe('i204');
  });
});

describe('evaluateReceipt', () => {
  const receipt = (over = {}) => ({
    schema: 1, status: 'passed', exitCode: 0, mode: 'full', head: 'a'.repeat(40), treeHashStart: 'T'.repeat(64), treeHashEnd: 'T'.repeat(64),
    engine: 'E', configHash: 'C', build: { status: 'passed' }, projects: [{ name: 'A', status: 'passed' }, { name: 'B', status: 'passed', reused: true }], ...over,
  });
  const current = (over = {}) => ({ treeHash: 'T'.repeat(64), head: 'a'.repeat(40), engine: 'E', configHash: 'C', ...over });
  const ev = (r, c = current(), mode = 'full', names = ['A', 'B']) => gr.evaluateReceipt({ receipt: r, current: c, mode, projectNames: names });
  const checks = (r) => r.reasons.map(x => x.check);

  it('verifies a matching receipt; a reused project counts as a pass', () => {
    expect(ev(receipt())).toEqual({ ok: true, reasons: [] });
  });
  it('a full receipt satisfies normal, a normal receipt does not satisfy full', () => {
    expect(ev(receipt({ mode: 'full' }), current(), 'normal').ok).toBe(true);
    expect(ev(receipt({ mode: 'normal' }), current(), 'normal').ok).toBe(true);
    expect(checks(ev(receipt({ mode: 'normal' }), current(), 'full'))).toContain('mode');
  });
  it('names each failed check with its values', () => {
    expect(checks(ev(null))).toEqual(['receipt']);
    expect(checks(ev(receipt({ status: 'running' })))).toContain('status');
    expect(checks(ev(receipt({ status: 'interrupted' })))).toContain('status');
    expect(checks(ev(receipt({ exitCode: 1 })))).toContain('exitCode');
    const tree = ev(receipt(), current({ treeHash: 'X'.repeat(64) }));
    expect(tree.reasons.find(r => r.check === 'treeHash').message).toContain('tree hash');
    expect(checks(ev(receipt({ treeHashEnd: 'Y'.repeat(64) })))).toContain('treeHash');
    expect(checks(ev(receipt(), current({ treeHash: null })))).toContain('treeHash');
    expect(checks(ev(receipt({ treeHashStart: null, treeHashEnd: null })))).toContain('treeHash');
    expect(checks(ev(receipt(), current({ head: 'b'.repeat(40) })))).toContain('head');
    expect(checks(ev(receipt(), current({ engine: 'E2' })))).toContain('engine');
    expect(checks(ev(receipt(), current({ configHash: 'C2' })))).toContain('config');
    expect(checks(ev(receipt({ build: { status: 'skipped' } })))).toContain('build');
    expect(checks(ev(receipt({ changedOnly: true })))).toContain('scope');
  });
  it('requires every configured project to be present and passed', () => {
    expect(ev(receipt(), current(), 'full', ['A', 'B', 'C']).reasons.map(r => r.message)).toContain('project C: no result in the receipt');
    expect(checks(ev(receipt({ projects: [{ name: 'A', status: 'passed' }, { name: 'B', status: 'not-run' }] })))).toContain('project');
  });
  it('a missing engine or config hash on both sides is not a match', () => {
    expect(checks(ev(receipt({ engine: null }), current({ engine: null })))).toContain('engine');
  });
});

// ── the working-tree hash ───────────────────────────────────────────

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tempRepo(files = { 'a.txt': 'a\n', 'src/b.txt': 'b\n' }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tree-')));
  dirs.push(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.com'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\ndocs/.output/.state/\n');
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); }
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  return { root, git, write: (p, c) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), c); } };
}
const hashOf = (root) => { const s = gr.treeSnapshot(root); expect(s.ok, s.reason).toBe(true); return s.hash; };

describe('treeSnapshot', () => {
  it('is stable for an unchanged tree and changes when a tracked file is edited', () => {
    const t = tempRepo();
    const h0 = hashOf(t.root);
    expect(hashOf(t.root)).toBe(h0);
    t.write('a.txt', 'changed\n');
    const h1 = hashOf(t.root);
    expect(h1).not.toBe(h0);
    t.write('a.txt', 'a\n');
    expect(hashOf(t.root)).toBe(h0);
  });
  it('changes when an untracked file is added, edited or removed, and when a tracked file is deleted', () => {
    const t = tempRepo();
    const h0 = hashOf(t.root);
    t.write('new.txt', '1');
    const h1 = hashOf(t.root);
    expect(h1).not.toBe(h0);
    t.write('new.txt', '2');
    expect(hashOf(t.root)).not.toBe(h1);
    fs.rmSync(path.join(t.root, 'new.txt'));
    expect(hashOf(t.root)).toBe(h0);
    fs.rmSync(path.join(t.root, 'a.txt'));
    expect(hashOf(t.root)).not.toBe(h0);
  });
  it('ignores gitignored files and the .state directory, so writing a receipt cannot change the hash', () => {
    const t = tempRepo();
    const h0 = hashOf(t.root);
    t.write('ignored.txt', 'x');
    t.write('docs/.output/.state/telemetry/gate-receipt.json', '{}');
    expect(hashOf(t.root)).toBe(h0);
    // Even when .state is NOT ignored, it is excluded.
    fs.writeFileSync(path.join(t.root, '.gitignore'), 'ignored.txt\n');
    const h1 = hashOf(t.root);
    t.write('docs/.output/.state/telemetry/other.json', '{"y":1}');
    expect(hashOf(t.root)).toBe(h1);
  });
  it('does not change when the same content is staged or committed (a commit keeps the tree hash)', () => {
    const t = tempRepo();
    t.write('a.txt', 'edited\n');
    t.write('fresh.txt', 'fresh\n');
    const dirty = hashOf(t.root);
    t.git('add', '-A');
    expect(hashOf(t.root)).toBe(dirty);
    t.git('commit', '-q', '-m', 'second');
    expect(hashOf(t.root)).toBe(dirty);
  });
  it('a commit keeps the hash under line-ending conversion too', () => {
    const t = tempRepo();
    t.git('config', 'core.autocrlf', 'true');
    t.write('crlf.txt', 'one\r\ntwo\r\n');
    const dirty = hashOf(t.root);
    t.git('add', '-A'); t.git('commit', '-q', '-m', 'crlf');
    expect(hashOf(t.root)).toBe(dirty);
  });
  it('is not computable (ok:false) outside a repository, from a subdirectory, and with a nested repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-plain-'));
    dirs.push(plain);
    expect(gr.treeSnapshot(plain)).toMatchObject({ ok: false });
    const t = tempRepo();
    t.write('sub/f.txt', '1');
    expect(gr.treeSnapshot(path.join(t.root, 'sub'))).toMatchObject({ ok: false });
    fs.mkdirSync(path.join(t.root, 'nested'));
    execFileSync('git', ['init', '-q'], { cwd: path.join(t.root, 'nested') });
    fs.writeFileSync(path.join(t.root, 'nested', 'x.txt'), 'x');
    expect(gr.treeSnapshot(t.root)).toMatchObject({ ok: false });
  });
  it('exposes the per-file entries closure hashing reads', () => {
    const t = tempRepo();
    const s = gr.treeSnapshot(t.root);
    expect([...s.entries.keys()].sort()).toEqual(['.gitignore', 'a.txt', 'src/b.txt']);
    expect(s.entries.get('a.txt').blob).toMatch(/^[0-9a-f]{40,64}$/);
  });
});

describe('verifyReceiptForRoot and checkReceiptForPr', () => {
  it('reports a missing receipt; and the PR check passes without looking unless requireFullForPr is true', () => {
    const t = tempRepo();
    const v = gr.verifyReceiptForRoot({ root: t.root, mode: 'full' });
    expect(v.ok).toBe(false);
    expect(v.reasons[0].message).toContain('no gate receipt');
    expect(gr.checkReceiptForPr({ root: t.root })).toEqual({ required: false, ok: true, reasons: [] });
    t.write('.claude/gate.config.json', JSON.stringify({ receipts: { requireFullForPr: true } }));
    const pr = gr.checkReceiptForPr({ root: t.root });
    expect(pr.required).toBe(true);
    expect(pr.ok).toBe(false);
  });
});
