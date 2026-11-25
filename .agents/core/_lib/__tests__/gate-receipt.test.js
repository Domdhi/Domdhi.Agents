// Unit tests for _lib/gate-receipt.js: argument parsing, closure, static scan, the reuse
// decision, history, verification and the working-tree hash. Inputs are synthetic; every
// instant is passed in as `now` (no test reads the clock to decide anything).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const buildLeg = { argv: ['dotnet', 'build', 'App.sln'] };
  it('joins every project in a root solution, and is unknown when one cannot be resolved', () => {
    const sln = 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "A\\A.csproj", "{1}"\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Z", "Z\\Z.csproj", "{2}"\n';
    const files = { ...base(), 'App.sln': sln };
    const r = repo(files);
    const projectClosures = [gr.dotnetClosure({ ...r, projectPath: 'C/C.csproj' })];
    const missing = gr.buildClosure({ projectClosures, snapshot: { hash: 'h', entries: r.entries }, readText: r.readText, meta, buildDisplay: 'b', buildLeg });
    expect(missing.known).toBe(false);
    const r2 = repo({ ...base(), 'Z/Z.csproj': csproj(), 'Z/Z.cs': 'z', 'App.sln': sln });
    const ok = gr.buildClosure({ projectClosures, snapshot: { hash: 'h', entries: r2.entries }, readText: r2.readText, meta, buildDisplay: 'b', buildLeg });
    expect(ok.known).toBe(true);
    expect([...ok.files.keys()]).toContain('Z/Z.cs');
  });
  it('is unknown when any project closure is unknown', () => {
    expect(gr.buildClosure({ projectClosures: [{ known: false }], snapshot: { hash: 'h', entries: new Map() }, readText: () => null, meta, buildDisplay: 'b' }).known).toBe(false);
  });
});

// ── review G: what the closure must see ─────────────────────────────

describe('dotnetClosure: the configuration chain is scanned like the project file (review G, MAJOR)', () => {
  const props = (body) => `<Project>\n${body}\n</Project>\n`;
  const closureOf = (files, projectPath = 'C/C.csproj') => gr.dotnetClosure({ ...repo(files), projectPath });
  const hashOf = (c) => gr.hashFiles(c.files, 'm');

  it('follows an Import in Directory.Build.props, so editing the imported file changes the closure', () => {
    const files = { ...base(), 'Directory.Build.props': props('<Import Project="$(MSBuildThisFileDirectory)eng/Versions.props" />'), 'eng/Versions.props': props('<PropertyGroup><LangVersion>11</LangVersion></PropertyGroup>') };
    const before = closureOf(files);
    expect(before.known).toBe(true);
    expect([...before.files.keys()]).toContain('eng/Versions.props');
    const after = closureOf({ ...files, 'eng/Versions.props': props('<PropertyGroup><LangVersion>12.0</LangVersion></PropertyGroup>') });
    expect(hashOf(after)).not.toBe(hashOf(before));
  });
  it('is unknown when an unconditional Import in Directory.Build.props points at a file that is not in the tree', () => {
    const files = { ...base(), 'Directory.Build.props': props('<Import Project="$(MSBuildThisFileDirectory)eng/Missing.props" />') };
    expect(closureOf(files)).toMatchObject({ known: false });
  });
  it('follows a Compile item in Directory.Build.props that points outside the project directory', () => {
    const files = { ...base(), 'Directory.Build.props': props('<ItemGroup><Compile Include="$(MSBuildThisFileDirectory)shared/Info.cs" /></ItemGroup>'), 'shared/Info.cs': 'class Info {}' };
    const before = closureOf(files);
    expect(before.known).toBe(true);
    expect([...before.files.keys()]).toContain('shared/Info.cs');
    expect(hashOf(closureOf({ ...files, 'shared/Info.cs': 'class Info { int x; }' }))).not.toBe(hashOf(before));
  });
  it('is unknown when a Compile item in Directory.Build.props uses a property it cannot resolve', () => {
    const files = { ...base(), 'Directory.Build.props': props('<ItemGroup><Compile Include="$(GeneratedDir)/x.cs" /></ItemGroup>') };
    expect(closureOf(files)).toMatchObject({ known: false });
  });
  it('scans a Directory.Build.props above a nested project with that project as the project directory', () => {
    const files = {
      ...base(), 'src/App/App.csproj': csproj(), 'src/App/App.cs': 'class App {}',
      'src/Directory.Build.props': props('<ItemGroup><Compile Include="$(MSBuildThisFileDirectory)common/Common.cs" /></ItemGroup>'), 'src/common/Common.cs': 'class Common {}',
    };
    const closure = closureOf(files, 'src/App/App.csproj');
    expect(closure.known).toBe(true);
    expect([...closure.files.keys()]).toContain('src/common/Common.cs');
  });
});

describe('dotnetClosure: item lists, file-valued elements and floating versions (review G, MINOR)', () => {
  const withProject = (body, extra = {}) => gr.dotnetClosure({ ...repo({ ...base(), ...extra, 'C/C.csproj': `<Project Sdk="x">\n${body}\n</Project>` }), projectPath: 'C/C.csproj' });
  const up = (rel) => `../${rel}`; // a path one level above the project directory (C/)

  it('splits an item list on ";" and follows each path', () => {
    const c = withProject(`<ItemGroup><Compile Include="Foo.cs;${up('shared/Bar.cs')}" /></ItemGroup>`, { 'shared/Bar.cs': 'class Bar {}' });
    expect(c.known).toBe(true);
    expect([...c.files.keys()]).toContain('shared/Bar.cs');
    expect(withProject(`<ItemGroup><Compile Include="Foo.cs;${up('shared/Gone.cs')}" /></ItemGroup>`).known).toBe(false);
  });
  it('follows a HintPath and a rule set that live outside the project directory', () => {
    const hintBody = `<ItemGroup><Reference Include="Lib"><HintPath>${up('libs/Lib.dll')}</HintPath></Reference></ItemGroup>`;
    const hint = withProject(hintBody, { 'libs/Lib.dll': 'binary' });
    expect(hint.known).toBe(true);
    expect([...hint.files.keys()]).toContain('libs/Lib.dll');
    const rules = withProject(`<PropertyGroup><CodeAnalysisRuleSet>${up('rules/x.ruleset')}</CodeAnalysisRuleSet></PropertyGroup>`, { 'rules/x.ruleset': '<RuleSet/>' });
    expect(rules.known).toBe(true);
    expect([...rules.files.keys()]).toContain('rules/x.ruleset');
    // A path that cannot be found, or a property it cannot resolve, is unknown (RUN), never skipped.
    expect(withProject(hintBody).known).toBe(false);
    expect(withProject('<PropertyGroup><AssemblyOriginatorKeyFile>$(KeyDir)/k.snk</AssemblyOriginatorKeyFile></PropertyGroup>').known).toBe(false);
    // Inside the project directory the directory contents already cover it.
    expect(withProject('<PropertyGroup><ApplicationIcon>app.ico</ApplicationIcon></PropertyGroup>').known).toBe(true);
  });
  it('is unknown for a floating package version (attribute or child element), known for a pinned one', () => {
    expect(withProject('<ItemGroup><PackageReference Include="X" Version="1.*" /></ItemGroup>')).toMatchObject({ known: false });
    expect(withProject('<ItemGroup><PackageReference Include="X" Version="*" /></ItemGroup>').known).toBe(false);
    expect(withProject('<ItemGroup><PackageReference Include="X"><Version>2.1.*</Version></PackageReference></ItemGroup>').known).toBe(false);
    expect(withProject('<ItemGroup><PackageReference Include="X" Version="1.2.3" /></ItemGroup>').known).toBe(true);
    const packages = gr.dotnetClosure({ ...repo({ ...base(), 'Directory.Packages.props': '<Project><ItemGroup><PackageVersion Include="X" Version="3.*" /></ItemGroup></Project>' }), projectPath: 'C/C.csproj' });
    expect(packages).toMatchObject({ known: false });
  });
});

describe('buildTargets and the build key (review G, MAJOR)', () => {
  const entriesOf = (...paths) => new Map(paths.map(p => [p, { mode: '100644', blob: `b-${p}` }]));
  const root = entriesOf('App.sln', 'A/A.csproj');

  it('understands dotnet build/publish/pack/msbuild/test with explicit targets, including a non-root solution', () => {
    expect(gr.buildTargets({ argv: ['dotnet', 'build', 'src/App.sln', '--configuration', 'Release'] }, root)).toEqual({ understood: true, targets: ['src/App.sln'] });
    expect(gr.buildTargets({ command: 'dotnet publish src/Web/Web.csproj -c Release' }, root)).toEqual({ understood: true, targets: ['src/Web/Web.csproj'] });
    expect(gr.buildTargets({ legs: [{ argv: ['dotnet', 'build', 'A.sln'] }, { argv: ['dotnet', 'pack', 'B/B.csproj'] }] }, root)).toEqual({ understood: true, targets: ['A.sln', 'B/B.csproj'] });
    expect(gr.buildTargets({ argv: ['C:\\tools\\dotnet.exe', 'build', 'src\\App.sln'] }, root)).toEqual({ understood: true, targets: ['src/App.sln'] });
  });
  it('with no target, takes the one root solution (else the one root project) and nothing ambiguous', () => {
    expect(gr.buildTargets({ argv: ['dotnet', 'build'] }, root)).toEqual({ understood: true, targets: ['App.sln'] });
    expect(gr.buildTargets({ argv: ['dotnet', 'build'] }, entriesOf('Only.csproj'))).toEqual({ understood: true, targets: ['Only.csproj'] });
    expect(gr.buildTargets({ argv: ['dotnet', 'build'] }, entriesOf('One.sln', 'Two.sln')).understood).toBe(false);
    expect(gr.buildTargets({ argv: ['dotnet', 'build'] }, entriesOf('docs/x.md')).understood).toBe(false);
  });
  it('does not understand npm, make, other dotnet verbs, shell lines or paths outside the repository', () => {
    for (const leg of [
      { command: 'npm run build' }, { command: 'make build' }, { argv: ['dotnet', 'format', 'App.sln'] }, { command: 'dotnet build App.sln && npm run build' },
      { argv: ['dotnet', 'build', '/abs/App.sln'] }, { argv: ['dotnet', 'build', 'sub/../../Other.sln'] }, { argv: ['dotnet', 'build', 'C:\\x\\App.sln'] },
      { legs: [{ argv: ['dotnet', 'build', 'App.sln'] }, { command: 'npm run build' }] }, undefined, {}, { argv: [] },
    ]) {
      expect(gr.buildTargets(leg, root).understood, JSON.stringify(leg)).toBe(false);
    }
  });

  const meta = { engine: 'e', configHash: 'c', mode: 'normal' };
  const closureOfBuild = (files, buildLeg, extraMeta = {}) => {
    const r = repo(files);
    const projectClosures = [gr.dotnetClosure({ ...r, projectPath: 'C/C.csproj' })];
    return gr.buildClosure({ projectClosures, snapshot: { hash: 'same-tree-hash', entries: r.entries }, readText: r.readText, meta: { ...meta, ...extraMeta }, buildDisplay: 'b', buildLeg });
  };
  const sln = 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Web", "Web\\Web.csproj", "{1}"\n';
  const webFiles = () => ({ ...base(), 'src/App.sln': sln, 'src/Web/Web.csproj': csproj(), 'src/Web/P.cs': 'class P {}' });

  it('a non-root solution the build names joins the closure: editing a project that no test references changes it', () => {
    const leg = { argv: ['dotnet', 'build', 'src/App.sln'] };
    const before = closureOfBuild(webFiles(), leg);
    expect(before.known, before.reason).toBe(true);
    expect(before.files).toBeInstanceOf(Map);
    expect([...before.files.keys()]).toContain('src/Web/P.cs');
    const edited = closureOfBuild({ ...webFiles(), 'src/Web/P.cs': 'class P { int broken; }' }, leg);
    expect(edited.hash).not.toBe(before.hash);
    // ...and an unrelated file still does not (the reuse that makes the closure worth computing).
    expect(closureOfBuild({ ...webFiles(), 'docs/x.md': 'doc edited' }, leg).hash).toBe(before.hash);
  });
  it('a build command that is not understood is keyed on the whole tree: the key moves with the tree hash alone', () => {
    const closure = closureOfBuild(webFiles(), { command: 'npm run build' });
    expect(closure.known).toBe(true);
    expect(closure.files).toBeNull();
    expect(closure.wholeTree).toEqual(expect.any(String));
    const r = repo({ ...webFiles(), 'web/app.ts': 'export const a = 1;' });
    const projectClosures = [gr.dotnetClosure({ ...r, projectPath: 'C/C.csproj' })];
    const withTree = (treeHash) => gr.buildClosure({ projectClosures, snapshot: { hash: treeHash, entries: r.entries }, readText: r.readText, meta, buildDisplay: 'npm run build', buildLeg: { command: 'npm run build' } });
    expect(withTree('tree-a').hash).not.toBe(withTree('tree-b').hash);
    expect(withTree('tree-a').hash).toBe(withTree('tree-a').hash);
  });
  it('a missing build leg is not understood either (whole tree), never a guess', () => {
    const r = repo(webFiles());
    const projectClosures = [gr.dotnetClosure({ ...r, projectPath: 'C/C.csproj' })];
    const at = (treeHash) => gr.buildClosure({ projectClosures, snapshot: { hash: treeHash, entries: r.entries }, readText: r.readText, meta, buildDisplay: 'b' });
    expect(at('t1').files).toBeNull();
    expect(at('t1').hash).not.toBe(at('t2').hash);
  });
  it('is unknown when a named target is not in the tree or one of its projects cannot be resolved', () => {
    expect(closureOfBuild(base(), { argv: ['dotnet', 'build', 'src/Nope.sln'] }).known).toBe(false);
    const broken = { ...base(), 'App.sln': 'Project("{F}") = "Z", "Z\\Z.csproj", "{2}"\n' };
    expect(closureOfBuild(broken, { argv: ['dotnet', 'build', 'App.sln'] }).known).toBe(false);
  });
  it('the SDK version is part of every key when given, and keys without it keep their shape', () => {
    const files = webFiles();
    const leg = { argv: ['dotnet', 'build', 'src/App.sln'] };
    expect(closureOfBuild(files, leg, { sdk: '8.0.100' }).hash).not.toBe(closureOfBuild(files, leg, { sdk: '8.0.101' }).hash);
    expect(closureOfBuild(files, leg, { sdk: '8.0.100' }).hash).not.toBe(closureOfBuild(files, leg).hash);
    const project = (extraMeta) => gr.projectClosure({ project: { inputs: [], path: 'C/C.csproj', display: 'x' }, snapshot: { hash: 'h', entries: repo(files).entries }, readText: repo(files).readText, meta: { engine: 'e', configHash: 'c', filter: 'f', mode: 'normal', ...extraMeta } });
    expect(project({ sdk: '8.0.100' }).hash).not.toBe(project({ sdk: '8.0.101' }).hash);
    expect(project({}).hash).toBe(project({ sdk: undefined }).hash);
  });
});

describe('scanStaticReads: wider read patterns (review G, MINOR)', () => {
  const scan = (text) => gr.scanStaticReads([{ path: 'T/Arch.cs', text }]);
  it.each([
    'var doc = XDocument.Load(path);', 'var d = XmlDocument.Load(p);', 'using var r = new StreamReader(path);', 'using var s = new FileStream(p, FileMode.Open);',
    'builder.AddJsonFile("appsettings.json");', 'Process.Start("git", "status");', 'var a = Assembly.LoadFrom(p);', 'var i = new ProcessStartInfo("git");',
  ])('flags %s', (line) => {
    expect(scan(line), line).toHaveLength(1);
  });
  it('does not flag look-alike identifiers', () => {
    expect(scan('var x = MyXDocumentLoader.Name; var y = NewStreamReaderFactory();')).toHaveLength(0);
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

// ── review G: snapshot, engine identity and the PR check ────────────

describe('treeSnapshot: files git does not report (review G, MINOR)', () => {
  it.each(['--assume-unchanged', '--skip-worktree'])('an edit to a file flagged %s moves the hash, and reverting it brings the hash back', (flag) => {
    const t = tempRepo();
    const clean = hashOf(t.root);
    t.git('update-index', flag, 'a.txt');
    expect(hashOf(t.root)).toBe(clean);
    t.write('a.txt', 'edited behind git\n');
    const edited = hashOf(t.root);
    expect(edited).not.toBe(clean);
    t.write('a.txt', 'a\n');
    expect(hashOf(t.root)).toBe(clean);
    fs.rmSync(path.join(t.root, 'a.txt'));
    expect(hashOf(t.root)).not.toBe(clean);
  });
});

describe('engineIdentity: the gate\'s whole require closure (review G, MINOR)', () => {
  function coreDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-core-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '_lib'));
    fs.writeFileSync(path.join(dir, 'gate.js'), "const owned = require('./_lib/owned');\nconst r = require('./_lib/gate-receipt');\nfunction later() { return require('./build-lock'); }\n");
    fs.writeFileSync(path.join(dir, '_lib', 'gate-receipt.js'), '// receipt\n');
    fs.writeFileSync(path.join(dir, '_lib', 'owned.js'), "module.exports = require('./deep');\n");
    fs.writeFileSync(path.join(dir, '_lib', 'deep.js'), '// deep v1\n');
    fs.writeFileSync(path.join(dir, 'build-lock.js'), '// lock v1\n');
    fs.writeFileSync(path.join(dir, '_lib', 'unrelated.js'), '// never required\n');
    return dir;
  }
  it('changes with a required, a transitively required and a lazily required module, and not with an unrelated file', () => {
    const t = tempRepo();
    const core = coreDir();
    const before = gr.engineIdentity(t.root, core);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(gr.engineIdentity(t.root, core)).toBe(before);
    fs.writeFileSync(path.join(core, '_lib', 'unrelated.js'), '// edited, still never required\n');
    expect(gr.engineIdentity(t.root, core)).toBe(before);
    for (const [rel, text] of [['_lib/deep.js', '// deep v2\n'], ['build-lock.js', '// lock v2\n'], ['_lib/gate-receipt.js', '// receipt v2\n'], ['gate.js', "require('./_lib/owned'); require('./_lib/gate-receipt'); require('./build-lock'); // v2\n"]]) {
      const changed = coreDir();
      fs.writeFileSync(path.join(changed, rel), text);
      expect(gr.engineIdentity(t.root, changed), rel).not.toBe(before);
    }
  });
  it('is unknown (null) when gate.js is missing, and the real gate engine covers the process-tree bridge', () => {
    const t = tempRepo();
    expect(gr.engineIdentity(t.root, fs.mkdtempSync(path.join(os.tmpdir(), 'gate-core-empty-')))).toBeNull();
    const realCore = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    expect(gr.engineIdentity(t.root, realCore)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the PR check fails closed (review G, MAJOR and MINOR)', () => {
  const GATE_CONFIG = '.claude/gate.config.json';
  const repoWithConfig = (text) => {
    const t = tempRepo();
    t.write(GATE_CONFIG, text);
    t.git('add', '-A'); t.git('commit', '-q', '-m', 'config');
    return t;
  };
  /** A full, passing receipt for the tree as it is right now. */
  const writeFullReceipt = (t) => {
    const snap = gr.treeSnapshot(t.root);
    expect(snap.ok, snap.reason).toBe(true);
    gr.writeReceipt(t.root, {
      schema: gr.RECEIPT_SCHEMA, id: 'pr-check', status: 'passed', exitCode: 0, mode: 'full', changedOnly: false, head: gr.headSha(t.root),
      treeHashStart: snap.hash, treeHashEnd: snap.hash, engine: gr.engineIdentity(t.root), configHash: gr.readGateConfigFile(t.root).hash,
      build: { status: 'passed' }, projects: [], test: { status: 'passed' },
    });
  };
  const REQUIRED = JSON.stringify({ receipts: { requireFullForPr: true } });

  it('receiptsConfig says when the PR rule is not a boolean or receipts is not an object', () => {
    expect(gr.receiptsConfig({ receipts: { requireFullForPr: 'true' } })).toMatchObject({ requireFullForPr: false, requireFullForPrInvalid: true });
    expect(gr.receiptsConfig({ receipts: 'yes' })).toMatchObject({ requireFullForPrInvalid: true });
    expect(gr.receiptsConfig({ receipts: 'yes' }).warnings).toHaveLength(1);
    expect(gr.receiptsConfig({ receipts: { requireFullForPr: true } }).requireFullForPrInvalid).toBe(false);
    expect(gr.receiptsConfig({}).requireFullForPrInvalid).toBe(false);
    expect(gr.receiptsConfig({ receipts: { maxAgeHours: 3 } }).requireFullForPrInvalid).toBe(false);
  });
  it('readGateConfigFile tells an absent config from a damaged one', () => {
    const t = tempRepo();
    expect(gr.readGateConfigFile(t.root)).toMatchObject({ present: false, parseError: null, config: {} });
    t.write(GATE_CONFIG, '{ "receipts": { "requireFullForPr": true, } }');
    expect(gr.readGateConfigFile(t.root)).toMatchObject({ present: true, config: {}, parseError: expect.any(String) });
    t.write(GATE_CONFIG, '[1, 2]');
    expect(gr.readGateConfigFile(t.root)).toMatchObject({ present: true, config: {}, parseError: expect.stringContaining('not a JSON object') });
    t.write(GATE_CONFIG, REQUIRED);
    expect(gr.readGateConfigFile(t.root)).toMatchObject({ present: true, parseError: null, config: { receipts: { requireFullForPr: true } } });
  });
  it('an unparseable gate config counts as requireFullForPr: true, refuses without a receipt, and says so', () => {
    for (const text of ['{ "receipts": { "requireFullForPr": true, } }', '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch']) {
      const t = repoWithConfig(text);
      const check = gr.checkReceiptForPr({ root: t.root });
      expect(check).toMatchObject({ required: true, ok: false });
      expect(check.warnings).toEqual([expect.stringContaining('treating receipts.requireFullForPr as true')]);
    }
  });
  it('a requireFullForPr that is a string counts as required, with a warning naming the fix', () => {
    const t = repoWithConfig(JSON.stringify({ receipts: { requireFullForPr: 'true' } }));
    const check = gr.checkReceiptForPr({ root: t.root });
    expect(check).toMatchObject({ required: true, ok: false });
    expect(check.warnings.join('\n')).toContain('not a true/false value');
    expect(check.warnings.join('\n')).toContain('requireFullForPr');
  });
  it('a valid config with the rule off, or no config, stays not required and carries no warnings', () => {
    expect(gr.checkReceiptForPr({ root: tempRepo().root })).toEqual({ required: false, ok: true, reasons: [] });
    const off = repoWithConfig(JSON.stringify({ receipts: { requireFullForPr: false } }));
    expect(gr.checkReceiptForPr({ root: off.root })).toEqual({ required: false, ok: true, reasons: [] });
  });
  it('workingTreeChanges lists staged, modified and untracked paths and ignores the gitignored state folder', () => {
    const t = tempRepo();
    expect(gr.workingTreeChanges(t.root)).toEqual({ ok: true, paths: [] });
    t.write('docs/.output/.state/telemetry/gate-receipt.json', '{}');
    t.write('ignored.txt', 'x');
    expect(gr.workingTreeChanges(t.root)).toEqual({ ok: true, paths: [] });
    t.write('a.txt', 'edited\n');
    t.write('Helpers.cs', 'class Helpers {}\n');
    t.write('staged.txt', 's\n'); t.git('add', 'staged.txt');
    expect(gr.workingTreeChanges(t.root).paths.sort()).toEqual(['Helpers.cs', 'a.txt', 'staged.txt']);
    expect(gr.workingTreeChanges(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-notgit-')))).toMatchObject({ ok: false });
  });
  it('a full receipt for a tree with an untracked file does not pass: the PR would not carry that file', () => {
    const t = repoWithConfig(REQUIRED);
    writeFullReceipt(t);
    expect(gr.checkReceiptForPr({ root: t.root })).toMatchObject({ required: true, ok: true });
    // The same tree plus a file the tests need but the commit lacks: the receipt is made for the dirty tree.
    t.write('Helpers.cs', 'class Helpers {}\n');
    writeFullReceipt(t);
    expect(gr.verifyReceiptForRoot({ root: t.root, mode: 'full' }).ok).toBe(true);
    const check = gr.checkReceiptForPr({ root: t.root });
    expect(check.required).toBe(true);
    expect(check.ok).toBe(false);
    expect(check.reasons).toEqual([{ check: 'cleanTree', message: expect.stringContaining('working tree has uncommitted changes') }]);
    expect(check.reasons[0].message).toContain('Helpers.cs');
    // Committed, with a receipt for the committed tree, it passes again.
    t.git('add', '-A'); t.git('commit', '-q', '-m', 'helpers');
    writeFullReceipt(t);
    expect(gr.checkReceiptForPr({ root: t.root })).toMatchObject({ required: true, ok: true, reasons: [] });
  });
  it('an edit to a tracked file and a staged file count as uncommitted too', () => {
    const t = repoWithConfig(REQUIRED);
    t.write('a.txt', 'edited\n');
    writeFullReceipt(t);
    expect(gr.checkReceiptForPr({ root: t.root }).reasons.map(r => r.check)).toEqual(['cleanTree']);
    t.git('add', 'a.txt');
    writeFullReceipt(t);
    expect(gr.checkReceiptForPr({ root: t.root }).reasons.map(r => r.check)).toEqual(['cleanTree']);
  });
});

// ── SF-1.1: hashTreeEntries and codeTreeHash ────────────────────────
//
// Pinned contract (the implementer must match these names and shapes):
//   hashTreeEntries(entries, { exclude } = {}) -> string (sha256 hex)
//     entries : Map<repoRelativePath, { mode, blob }> (what treeSnapshot().entries returns)
//     exclude : optional predicate (repoRelativePath) => boolean; true drops the entry.
//               A non-function, non-undefined `exclude` throws (a mistyped exclusion must
//               never silently hash everything).
//     With no exclusion the output is byte-identical to the hash treeSnapshot already produced:
//     sha256 over the entries sorted by path (UTF-16 code-unit order), one line per entry
//     `${mode} ${blob}\t${path}\n`.
//   codeTreeHash(root, { extraExclude } = {}) -> { ok:true, hash } | { ok:false, reason }
//     Same snapshot rules as treeSnapshot, but the hash drops docs/.output/, docs/work/,
//     docs/TODO_*.md (direct children of docs/ only) and every extraExclude path. An
//     extraExclude entry is a repo-relative file or directory (trailing slash optional) that
//     matches on a path-segment boundary; '', '.' and '/' are ignored (never "exclude all").
//     A non-array extraExclude throws.

// The 64-char hex of a golden recomputation, copied from the existing algorithm so a receipt
// written before this change still verifies after it.
const GOLDEN_ENTRIES = () => new Map([
  ['src/b.txt', { mode: '100644', blob: 'b'.repeat(40) }],
  ['a.txt', { mode: '100755', blob: 'a'.repeat(40) }],
  ['dir/é.txt', { mode: '100644', blob: 'c'.repeat(40) }],
  ['B.txt', { mode: '120000', blob: 'd'.repeat(40) }],
]);
const GOLDEN_HASH = '75dbd6303c78ddcf8c7906e056899da485dac37421c54a75a93b36b6bf520297';
const GOLDEN_HASH_WITHOUT_SRC = 'c46c07c4765c4b76164e5da53b2d33f8592917e2ab7bff91439c5bf557f0d8ce';
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// An independent restatement of the pre-existing computation (not a call into the code under test).
const legacyTreeHash = (entries) => {
  const lines = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, e]) => `${e.mode} ${e.blob}\t${file}\n`);
  return require('node:crypto').createHash('sha256').update(lines.join('')).digest('hex');
};

describe('hashTreeEntries', () => {
  it('is exported as a function', () => {
    expect(typeof gr.hashTreeEntries).toBe('function');
  });
  it('with no exclusion is byte-identical to the pre-existing tree hash (golden value)', () => {
    expect(gr.hashTreeEntries(GOLDEN_ENTRIES())).toBe(GOLDEN_HASH);
    expect(legacyTreeHash(GOLDEN_ENTRIES())).toBe(GOLDEN_HASH);
  });
  it.each([
    ['no options object', undefined],
    ['an empty options object', {}],
    ['an undefined exclude', { exclude: undefined }],
  ])('treats %s as no exclusion', (_label, options) => {
    expect(gr.hashTreeEntries(GOLDEN_ENTRIES(), options)).toBe(GOLDEN_HASH);
  });
  it('does not depend on the insertion order of the entries', () => {
    const reversed = new Map([...GOLDEN_ENTRIES()].reverse());
    expect(gr.hashTreeEntries(reversed)).toBe(GOLDEN_HASH);
  });
  it('an empty entry set hashes the empty string', () => {
    expect(gr.hashTreeEntries(new Map())).toBe(EMPTY_HASH);
  });
  it('an exclude predicate drops matching entries and nothing else (golden value)', () => {
    expect(gr.hashTreeEntries(GOLDEN_ENTRIES(), { exclude: (p) => p.startsWith('src/') })).toBe(GOLDEN_HASH_WITHOUT_SRC);
  });
  it('excluding every entry equals the empty hash', () => {
    expect(gr.hashTreeEntries(GOLDEN_ENTRIES(), { exclude: () => true })).toBe(EMPTY_HASH);
  });
  it('an excluded entry no longer influences the hash, an included entry still does', () => {
    const exclude = (p) => p.startsWith('src/');
    const base = gr.hashTreeEntries(GOLDEN_ENTRIES(), { exclude });
    const editedExcluded = GOLDEN_ENTRIES();
    editedExcluded.set('src/b.txt', { mode: '100644', blob: 'e'.repeat(40) });
    expect(gr.hashTreeEntries(editedExcluded, { exclude })).toBe(base);
    const editedIncluded = GOLDEN_ENTRIES();
    editedIncluded.set('a.txt', { mode: '100755', blob: 'e'.repeat(40) });
    expect(gr.hashTreeEntries(editedIncluded, { exclude })).not.toBe(base);
  });
  it('the predicate sees each repo-relative path exactly once and the input map is not mutated', () => {
    const seen = [];
    const entries = GOLDEN_ENTRIES();
    gr.hashTreeEntries(entries, { exclude: (p) => { seen.push(p); return false; } });
    expect(seen.sort()).toEqual(['B.txt', 'a.txt', 'dir/é.txt', 'src/b.txt']);
    expect(entries.size).toBe(4);
  });
  it.each(['src/', ['src/'], 7, {}])('a non-function exclude (%j) throws instead of silently hashing everything', (bad) => {
    expect(typeof gr.hashTreeEntries).toBe('function');
    expect(() => gr.hashTreeEntries(GOLDEN_ENTRIES(), { exclude: bad })).toThrow();
  });
  it('a real repository snapshot still hashes to the legacy value, so existing receipts verify', () => {
    const t = tempRepo({ 'a.txt': 'a\n', 'src/b.txt': 'b\n', 'dir/é.txt': 'accent\n' });
    t.write('untracked.txt', 'u\n');
    const s = gr.treeSnapshot(t.root);
    expect(s.ok, s.reason).toBe(true);
    expect(s.hash).toBe(legacyTreeHash(s.entries));
    expect(gr.hashTreeEntries(s.entries)).toBe(s.hash);
  });
});

describe('codeTreeHash', () => {
  const REPO_FILES = {
    'a.txt': 'a\n',
    'src/b.txt': 'b\n',
    'docs/other.md': 'other\n',
    'docs/.output/handoffs/h.md': 'handoff\n',
    'docs/.output/.memory/patterns/p.json': '{}\n',
    'docs/work/todo/t.md': 'todo\n',
    'docs/TODO_software-factory.md': 'plan\n',
    'docs/workbench/x.md': 'not under docs/work/\n',
    'docs/.outputs/x.md': 'not under docs/.output/\n',
    'docs/TODO_x.txt': 'not markdown\n',
    'docs/TODO.md': 'no underscore\n',
    'docs/sub/TODO_nested.md': 'nested, not a direct child of docs/\n',
    'TODO_root.md': 'root level, not under docs/\n',
    'gen/out.txt': 'generated\n',
    'generated/out.txt': 'not gen/\n',
    'gen.txt': 'not gen/\n',
    'notes.txt': 'notes\n',
  };
  const codeHash = (root, options) => {
    const r = gr.codeTreeHash(root, options);
    expect(r.ok, r.reason).toBe(true);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    return r.hash;
  };

  it('is exported as a function', () => {
    expect(typeof gr.codeTreeHash).toBe('function');
  });
  it('is stable for an unchanged tree', () => {
    const t = tempRepo(REPO_FILES);
    expect(codeHash(t.root)).toBe(codeHash(t.root));
  });
  it('equals the plain tree hash when no excluded path exists in the repository', () => {
    const t = tempRepo();
    expect(codeHash(t.root)).toBe(hashOf(t.root));
  });
  it('is smaller than the plain tree hash domain: an excluded file moves treeSnapshot but not codeTreeHash', () => {
    const t = tempRepo();
    const code0 = codeHash(t.root);
    const plain0 = hashOf(t.root);
    t.write('docs/TODO_new.md', 'plan\n');
    expect(codeHash(t.root)).toBe(code0);
    expect(hashOf(t.root)).not.toBe(plain0);
  });

  it.each([
    'docs/.output/handoffs/h.md',
    'docs/.output/.memory/patterns/p.json',
    'docs/work/todo/t.md',
    'docs/TODO_software-factory.md',
  ])('ignores an edit to the tracked excluded file %s', (rel) => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root);
    t.write(rel, 'edited after the gate\n');
    expect(codeHash(t.root)).toBe(h0);
  });
  it.each([
    'docs/.output/handoffs/h.md',
    'docs/work/todo/t.md',
    'docs/TODO_software-factory.md',
  ])('ignores deleting the tracked excluded file %s', (rel) => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root);
    fs.rmSync(path.join(t.root, rel));
    expect(codeHash(t.root)).toBe(h0);
  });
  it.each([
    'docs/.output/findings/reviews/new.md',
    'docs/work/new/x.md',
    'docs/TODO_new.md',
  ])('ignores a new untracked file at the excluded path %s', (rel) => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root);
    t.write(rel, 'new\n');
    expect(codeHash(t.root)).toBe(h0);
  });

  it.each([
    'a.txt',
    'src/b.txt',
    'docs/other.md',
    'docs/workbench/x.md',
    'docs/.outputs/x.md',
    'docs/TODO_x.txt',
    'docs/TODO.md',
    'docs/sub/TODO_nested.md',
    'TODO_root.md',
    '.gitignore',
  ])('changes when the non-excluded tracked file %s is edited', (rel) => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root);
    t.write(rel, 'edited\n');
    expect(codeHash(t.root)).not.toBe(h0);
  });
  it('changes when a code file is deleted, renamed, or an untracked code file is added', () => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root);
    t.write('fresh.txt', 'new\n');
    const added = codeHash(t.root);
    expect(added).not.toBe(h0);
    fs.renameSync(path.join(t.root, 'fresh.txt'), path.join(t.root, 'renamed.txt'));
    const renamed = codeHash(t.root);
    expect(renamed).not.toBe(added);
    fs.rmSync(path.join(t.root, 'renamed.txt'));
    fs.rmSync(path.join(t.root, 'a.txt'));
    const deleted = codeHash(t.root);
    expect(deleted).not.toBe(h0);
    expect(deleted).not.toBe(renamed);
  });
  it('is unchanged by a commit of the same content (the seal survives the wave commit)', () => {
    const t = tempRepo(REPO_FILES);
    t.write('a.txt', 'edited\n');
    t.write('fresh.txt', 'fresh\n');
    t.write('docs/TODO_software-factory.md', 'ticked\n');
    const dirty = codeHash(t.root);
    t.git('add', '-A');
    expect(codeHash(t.root)).toBe(dirty);
    t.git('commit', '-q', '-m', 'wave');
    expect(codeHash(t.root)).toBe(dirty);
  });
  it('still ignores gitignored files and the .state directory', () => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root);
    t.write('ignored.txt', 'x');
    t.write('docs/.output/.state/telemetry/ac-verify/T-1.1.json', '[]');
    expect(codeHash(t.root)).toBe(h0);
  });

  it.each([
    ['a directory with a trailing slash', ['gen/'], 'gen/out.txt'],
    ['a directory without a trailing slash', ['gen'], 'gen/out.txt'],
    ['an exact file', ['notes.txt'], 'notes.txt'],
  ])('extraExclude %s hides edits under that path', (_label, extraExclude, rel) => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root, { extraExclude });
    t.write(rel, 'edited\n');
    expect(codeHash(t.root, { extraExclude })).toBe(h0);
  });
  it.each([
    ['a sibling directory sharing the prefix', 'generated/out.txt'],
    ['a sibling file sharing the prefix', 'gen.txt'],
    ['an unrelated code file', 'a.txt'],
  ])('extraExclude [gen] does not hide %s', (_label, rel) => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root, { extraExclude: ['gen'] });
    t.write(rel, 'edited\n');
    expect(codeHash(t.root, { extraExclude: ['gen'] })).not.toBe(h0);
  });
  it('an extraExclude path makes the hash differ from the same tree without it', () => {
    const t = tempRepo(REPO_FILES);
    expect(codeHash(t.root, { extraExclude: ['gen/'] })).not.toBe(codeHash(t.root));
  });
  it.each(['', '.', '/'])('an extraExclude entry %j is ignored and never excludes the whole tree', (entry) => {
    const t = tempRepo(REPO_FILES);
    const h0 = codeHash(t.root, { extraExclude: [entry] });
    expect(h0).toBe(codeHash(t.root));
    t.write('a.txt', 'edited\n');
    expect(codeHash(t.root, { extraExclude: [entry] })).not.toBe(h0);
  });
  it.each(['gen/', 7, {}])('a non-array extraExclude (%j) throws', (bad) => {
    expect(typeof gr.codeTreeHash).toBe('function');
    const t = tempRepo(REPO_FILES);
    expect(() => gr.codeTreeHash(t.root, { extraExclude: bad })).toThrow();
  });

  it('is not computable (ok:false with a reason) outside a repository and from a subdirectory', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-plain-'));
    dirs.push(plain);
    const outside = gr.codeTreeHash(plain);
    expect(outside.ok).toBe(false);
    expect(typeof outside.reason).toBe('string');
    expect(outside.reason.length).toBeGreaterThan(0);
    const t = tempRepo(REPO_FILES);
    expect(gr.codeTreeHash(path.join(t.root, 'src'))).toMatchObject({ ok: false });
  });
});

// ── Review fixes (wave 1): the code-hash exclusion set and its one definition ──

describe('review fix M1: isCodeHashExcluded is the one definition of what the code hash does not cover', () => {
  it('is exported as a function', () => {
    expect(typeof gr.isCodeHashExcluded).toBe('function');
  });

  it.each([
    'docs/.output/handoffs/h.md', 'docs/.output/.state/telemetry/a.json', 'docs/.output',
    'docs/work/todo/t.md', 'docs/work',
    'docs/TODO_software-factory.md', 'docs/TODO_x.md',
    'Docs/.Output/x/notes.md', 'DOCS/WORK/x.json', 'docs/todo_lower.md',
  ])('treats %s as excluded', (rel) => {
    expect(gr.isCodeHashExcluded(rel)).toBe(true);
  });

  it.each(['docs/.output/x/check.js', 'docs/work/helper.js', 'Docs/.Output/x/check.js', 'DOCS/WORK/x.js'])(
    'M1 part 2: keeps the code file %s in the hash, while isUnderExcludedDocs still flags its folder for ac-verify', (rel) => {
      expect(gr.isCodeHashExcluded(rel)).toBe(false);
      expect(gr.isUnderExcludedDocs(rel)).toBe(true);
    });

  it.each([
    'a.txt', 'src/b.txt', 'docs/other.md', 'docs/workbench/x.md', 'docs/.outputs/x.md', 'docs/TODO_x.txt', 'docs/TODO.md',
    'docs/sub/TODO_nested.md', 'TODO_root.md', '.agents/core/ac-verify.js', 'docs/.output-x/y.js', 'docs/worker.js',
  ])('treats %s as covered', (rel) => {
    expect(gr.isCodeHashExcluded(rel)).toBe(false);
  });

  it('agrees with codeTreeHash on every path of a real repository: an edit moves the hash exactly when the path is covered', () => {
    const files = {
      'a.txt': 'a\n', 'docs/other.md': 'o\n', 'docs/.output/x/check.js': 'x\n', 'docs/.output/handoffs/h.md': 'h\n', 'docs/work/todo/t.md': 't\n',
      'docs/TODO_plan.md': 'p\n', 'docs/workbench/x.md': 'w\n', 'docs/sub/TODO_nested.md': 'n\n',
    };
    for (const rel of Object.keys(files)) {
      const t = tempRepo(files);
      const before = gr.codeTreeHash(t.root).hash;
      t.write(rel, 'edited\n');
      const moved = gr.codeTreeHash(t.root).hash !== before;
      expect(moved, rel).toBe(!gr.isCodeHashExcluded(rel));
    }
  });

  it('an executable file under docs/.output/ is part of the hash (M1 part 2 closed the earlier documented limit)', () => {
    const t = tempRepo({ 'a.txt': 'a\n', 'docs/.output/x/check.js': 'console.log(1)\n' });
    const before = gr.codeTreeHash(t.root).hash;
    t.write('docs/.output/x/check.js', 'console.log(2)\n');
    expect(gr.codeTreeHash(t.root).hash).not.toBe(before);
    expect(gr.isCodeHashExcluded('docs/.output/x/check.js')).toBe(false);
  });

  it('a committed symlink is hashed as its link text, not its target: an edit behind a link to outside the tree does not move the hash', () => {
    if (process.platform === 'win32') return;
    const t = tempRepo({ 'a.txt': 'a\n' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-receipt-outside-'));
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'x.js'), 'one\n');
    fs.symlinkSync(path.join(outside, 'x.js'), path.join(t.root, 'link.js'));
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'link');
    const before = gr.codeTreeHash(t.root).hash;
    fs.writeFileSync(path.join(outside, 'x.js'), 'two\n');
    expect(gr.codeTreeHash(t.root).hash).toBe(before);
  });
});

describe('review fix M1 (documentation pin): extraExclude is caller-supplied and drops whatever it names', () => {
  it('an extraExclude of a code directory removes that code from the hash, which is why it must never come from the TODO', () => {
    const t = tempRepo({ 'src/a.js': 'a\n', 'lib/b.js': 'b\n' });
    const dropped = gr.codeTreeHash(t.root, { extraExclude: ['src'] }).hash;
    t.write('src/a.js', 'edited\n');
    expect(gr.codeTreeHash(t.root, { extraExclude: ['src'] }).hash).toBe(dropped);
    expect(gr.codeTreeHash(t.root).hash).not.toBe(gr.codeTreeHash(t.root, { extraExclude: ['src'] }).hash);
  });

  it('the source states the rule next to the option', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'gate-receipt.js'), 'utf8');
    expect(source).toMatch(/extraExclude` MUST come from tracked configuration/);
  });
});

describe('review fix M1 part 2: code files inside the excluded docs folders stay in codeTreeHash', () => {
  it.each([
    'docs/.output/evolution/skills/fixture/lib/store.js',
    'docs/work/helpers/check.cjs',
    'docs/.output/tools/run.py',
  ])('an edit to %s changes the code hash', (rel) => {
    const t = tempRepo({ 'a.txt': 'a\n', [rel]: 'module.exports = 1;\n', 'docs/.output/plans/p.md': 'plan\n' });
    const h0 = gr.codeTreeHash(t.root).hash;
    t.write(rel, 'module.exports = 2;\n');
    expect(gr.codeTreeHash(t.root).hash).not.toBe(h0);
  });
  it('prose and data beside them stay excluded', () => {
    const t = tempRepo({ 'a.txt': 'a\n', 'docs/.output/tools/run.js': 'x\n', 'docs/.output/plans/p.md': 'plan\n', 'docs/.output/.memory/m.json': '{}\n' });
    const h0 = gr.codeTreeHash(t.root).hash;
    t.write('docs/.output/plans/p.md', 'edited\n');
    t.write('docs/.output/.memory/m.json', '{"a":1}\n');
    expect(gr.codeTreeHash(t.root).hash).toBe(h0);
  });
});

// ── SF-1.3 review (security M3, review M1/m5): the receipt carries the code hash and is judged for CODE ──

describe('evaluateReceipt: ignoreCurrentTree (security M3)', () => {
  const receipt = (over = {}) => ({
    schema: 1, status: 'passed', exitCode: 0, mode: 'normal', head: 'a'.repeat(40), treeHashStart: 'T'.repeat(64), treeHashEnd: 'T'.repeat(64),
    engine: 'E', configHash: 'C', build: { status: 'passed' }, projects: [], ...over,
  });
  const current = (over = {}) => ({ treeHash: 'X'.repeat(64), head: 'a'.repeat(40), engine: 'E', configHash: 'C', ...over });
  const checks = (r) => r.reasons.map((x) => x.check);

  it('skips only the whole-tree comparison: a receipt for another tree passes, every other check still fails', () => {
    expect(gr.evaluateReceipt({ receipt: receipt(), current: current(), mode: 'normal', projectNames: [] }).ok).toBe(false);
    expect(gr.evaluateReceipt({ receipt: receipt(), current: current(), mode: 'normal', projectNames: [], ignoreCurrentTree: true })).toEqual({ ok: true, reasons: [] });
    const bad = gr.evaluateReceipt({
      receipt: receipt({ status: 'failed', exitCode: 1, changedOnly: true, build: { status: 'failed' } }),
      current: current({ head: 'b'.repeat(40), engine: 'E2', configHash: 'C2' }), mode: 'normal', projectNames: [], ignoreCurrentTree: true,
    });
    expect(checks(bad).sort()).toEqual(['build', 'config', 'engine', 'exitCode', 'head', 'scope', 'status']);
  });

  it('still refuses a run during which the tree changed (start differs from end), and a receipt with no tree hash', () => {
    expect(checks(gr.evaluateReceipt({ receipt: receipt({ treeHashEnd: 'Y'.repeat(64) }), current: current(), mode: 'normal', projectNames: [], ignoreCurrentTree: true }))).toEqual(['treeHash']);
    expect(checks(gr.evaluateReceipt({ receipt: receipt({ treeHashStart: null, treeHashEnd: null }), current: current(), mode: 'normal', projectNames: [], ignoreCurrentTree: true }))).toEqual(['treeHash']);
  });
});

describe('verifyReceiptEvidence: a receipt judged for the code hash (security M3, review M1/m5)', () => {
  const makeReceipt = (t, over = {}) => {
    const snap = gr.treeSnapshot(t.root);
    return {
      schema: gr.RECEIPT_SCHEMA, id: 'abc', status: 'passed', exitCode: 0, mode: 'normal', changedOnly: false, head: gr.headSha(t.root),
      treeHashStart: snap.hash, treeHashEnd: snap.hash, engine: gr.engineIdentity(t.root), configHash: gr.readGateConfigFile(t.root).hash,
      build: { status: 'passed' }, projects: [], test: { status: 'passed' }, codeHash: gr.codeTreeHash(t.root).hash, ...over,
    };
  };
  const verdict = (t, receipt) => gr.verifyReceiptEvidence({ root: t.root, receipt, codeHash: gr.codeTreeHash(t.root).hash });
  const checks = (v) => v.reasons.map((r) => r.check);

  it('accepts a full, passed receipt whose code hash is the current one', () => {
    const t = tempRepo();

    expect(verdict(t, makeReceipt(t))).toEqual({ ok: true, reasons: [] });
  });

  it('accepts the receipt after docs the code hash excludes were edited (the whole-tree hash would not match)', () => {
    const t = tempRepo({ 'a.txt': 'a\n', 'docs/.output/plans/p.md': 'plan\n' });
    const receipt = makeReceipt(t);
    t.write('docs/.output/plans/p.md', 'edited after the gate\n');
    expect(gr.verifyReceiptForRoot({ root: t.root }).ok, 'control: the whole-tree verdict would refuse it').toBe(false);
    gr.writeReceipt(t.root, receipt);

    expect(verdict(t, receipt).ok).toBe(true);
  });

  it('refuses a receipt whose code hash is not the code hash it is judged against (code edited after the gate)', () => {
    const t = tempRepo();
    const receipt = makeReceipt(t);
    t.write('src/late.txt', 'late\n');

    const v = verdict(t, receipt);

    expect(v.ok).toBe(false);
    expect(checks(v)).toEqual(['codeHash']);
    expect(v.reasons[0].message).toMatch(/code hash: the receipt covers/);
  });

  it.each([
    ['no code hash at all (a receipt written by an older gate)', { codeHash: undefined }, 'codeHash'],
    ['a malformed code hash', { codeHash: 'nope' }, 'codeHash'],
    ['no test leg (a build-only run)', { test: undefined }, 'test'],
    ['a test leg that failed', { test: { status: 'failed' } }, 'test'],
    ['a change-scoped run', { changedOnly: true }, 'scope'],
    ['a failed status', { status: 'failed', exitCode: 1 }, 'status'],
    ['another head', { head: 'a'.repeat(40) }, 'head'],
    ['another engine', { engine: 'other' }, 'engine'],
    ['another config hash', { configHash: 'other' }, 'config'],
  ])('refuses %s', (_label, over, check) => {
    const t = tempRepo();

    const v = verdict(t, makeReceipt(t, over));

    expect(v.ok).toBe(false);
    expect(checks(v)).toContain(check);
  });

  it('refuses a null receipt and a receipt of another schema without throwing', () => {
    const t = tempRepo();

    expect(checks(verdict(t, null))).toEqual(['receipt']);
    expect(checks(verdict(t, { ...makeReceipt(t), schema: 99 }))).toEqual(['receipt']);
  });
});

// ── SF-2.5: every receipt is also archived by id ──

describe('SF-2.5 receipt archive by id', () => {
  const rec = (id, over = {}) => ({ schema: gr.RECEIPT_SCHEMA, id, status: 'passed', exitCode: 0, mode: 'normal', projects: [], ...over });
  const archiveDir = (t) => path.join(gr.historyDir(t.root), 'by-id');
  const archiveFile = (t, id) => path.join(archiveDir(t), `${id}.json`);
  const outside = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-archive-outside-')));
    dirs.push(dir);
    return dir;
  };
  const jsonFiles = (t) => fs.readdirSync(archiveDir(t)).filter((n) => n.endsWith('.json')).sort();

  it('writeReceipt_alsoWritesTheSameReceiptToTheByIdArchive', () => {
    const t = tempRepo();
    const receipt = rec('aaaaaaaaaaaa', { head: 'h1' });

    gr.writeReceipt(t.root, receipt);

    expect(JSON.parse(fs.readFileSync(gr.receiptPath(t.root), 'utf8'))).toEqual(receipt);
    expect(JSON.parse(fs.readFileSync(archiveFile(t, 'aaaaaaaaaaaa'), 'utf8'))).toEqual(receipt);
    expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toEqual(receipt);
  });

  it('writeReceipt_calledAgainWithTheSameId_replacesTheArchiveWithTheLatestWrite', () => {
    const t = tempRepo();
    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa', { status: 'running' }));
    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa', { status: 'passed' }));

    expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa').status).toBe('passed');
    expect(jsonFiles(t)).toEqual(['aaaaaaaaaaaa.json']);
  });

  it('writeReceipt_olderReceiptsSurviveLaterRuns_whileTheCurrentFileHoldsOnlyTheLast', () => {
    const t = tempRepo();
    for (const id of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) gr.writeReceipt(t.root, rec(id));

    expect(gr.readReceipt(t.root).id).toBe('cccccccccccc');
    expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa').id).toBe('aaaaaaaaaaaa');
    expect(gr.archivedReceipt(t.root, 'bbbbbbbbbbbb').id).toBe('bbbbbbbbbbbb');
    expect(jsonFiles(t)).toEqual(['aaaaaaaaaaaa.json', 'bbbbbbbbbbbb.json', 'cccccccccccc.json']);
  });

  it('writeReceipt_archivesNothingOnTheHistoryRowPath_soReadHistoryNeverSeesTheArchive', () => {
    const t = tempRepo();
    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'));

    expect(fs.readdirSync(gr.historyDir(t.root)).filter((n) => n.endsWith('.json'))).toEqual([]);
  });

  it.each([
    ['a path traversal', '../escape'],
    ['a nested path', 'a/b'],
    ['a backslash path', 'a\\b'],
    ['a dot-dot id', '..'],
    ['an id with a dot', 'abc.json'],
    ['an id with a space', 'abc def'],
    ['an empty id', ''],
    ['an id over 64 characters', 'a'.repeat(65)],
    ['a NUL byte', 'abc\0def'],
  ])('writeReceipt_%s_isNeverArchived_andTheMainReceiptStillWrites', (_label, id) => {
    const t = tempRepo();
    const receipt = rec(id);

    expect(() => gr.writeReceipt(t.root, receipt)).not.toThrow();

    expect(gr.readReceipt(t.root)).toEqual(receipt);
    expect(fs.existsSync(archiveDir(t)) ? fs.readdirSync(archiveDir(t)) : []).toEqual([]);
    expect(fs.existsSync(path.join(gr.historyDir(t.root), 'escape.json'))).toBe(false);
    expect(gr.archivedReceipt(t.root, id)).toBeNull();
  });

  it.each([[undefined], [null], [42], [{}], [['a']]])('writeReceipt_receiptIdOf_%j_isNeverArchived', (id) => {
    const t = tempRepo();
    gr.writeReceipt(t.root, { schema: gr.RECEIPT_SCHEMA, id, status: 'passed' });

    expect(fs.existsSync(archiveDir(t))).toBe(false);
    expect(gr.archivedReceipt(t.root, id)).toBeNull();
  });

  it('writeReceipt_prunesTheArchiveToTheNewest200ByMtime_keepingTheJustWrittenOne', () => {
    const t = tempRepo();
    fs.mkdirSync(archiveDir(t), { recursive: true });
    const base = Date.now() / 1000 - 100000;
    // 200 seeded files, i = 0 oldest .. 199 newest.
    for (let i = 0; i < 200; i += 1) {
      const id = `seed${String(i).padStart(4, '0')}`;
      fs.writeFileSync(archiveFile(t, id), JSON.stringify(rec(id)));
      fs.utimesSync(archiveFile(t, id), base + i, base + i);
    }
    fs.writeFileSync(path.join(archiveDir(t), 'notes.txt'), 'not a receipt');

    gr.writeReceipt(t.root, rec('freshfresh01'));

    const kept = jsonFiles(t);
    expect(kept).toHaveLength(200);
    expect(kept).toContain('freshfresh01.json');
    expect(kept).not.toContain('seed0000.json');
    expect(kept).toContain('seed0001.json');
    expect(kept).toContain('seed0199.json');
    expect(fs.existsSync(path.join(archiveDir(t), 'notes.txt'))).toBe(true);
  });

  it('writeReceipt_atExactlyTheCapDoesNotPruneAnything', () => {
    const t = tempRepo();
    fs.mkdirSync(archiveDir(t), { recursive: true });
    for (let i = 0; i < 199; i += 1) {
      const id = `seed${String(i).padStart(4, '0')}`;
      fs.writeFileSync(archiveFile(t, id), JSON.stringify(rec(id)));
    }

    gr.writeReceipt(t.root, rec('freshfresh01'));

    expect(jsonFiles(t)).toHaveLength(200);
    expect(jsonFiles(t)).toContain('seed0000.json');
  });

  it('writeReceipt_archiveFailure_neverThrows_andTheMainReceiptIsIntact', () => {
    const t = tempRepo();
    // A regular file where the by-id directory must be: the archive cannot be created.
    fs.mkdirSync(gr.historyDir(t.root), { recursive: true });
    fs.writeFileSync(archiveDir(t), 'blocker');
    const receipt = rec('aaaaaaaaaaaa');

    let result;
    expect(() => { result = gr.writeReceipt(t.root, receipt); }).not.toThrow();

    expect(result).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(gr.receiptPath(t.root), 'utf8'))).toEqual(receipt);
    expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
  });

  it('writeReceipt_mainWriteFailure_stillThrows_theArchiveDoesNotMaskIt', () => {
    const t = tempRepo();
    fs.mkdirSync(path.dirname(gr.receiptPath(t.root)), { recursive: true });
    fs.mkdirSync(gr.receiptPath(t.root)); // a directory where the receipt file must be: the rename fails

    expect(() => gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'))).toThrow();
  });

  it('writeReceipt_leavesNoTempFileInTheArchive', () => {
    const t = tempRepo();
    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'));

    expect(fs.readdirSync(archiveDir(t))).toEqual(['aaaaaaaaaaaa.json']);
  });

  describe.skipIf(process.platform === 'win32')('symlink refusal', () => {
    it('writeReceipt_archiveLeafThatIsASymlink_isNotWrittenThrough', () => {
      const t = tempRepo();
      const out = outside();
      const target = path.join(out, 'victim.json');
      fs.writeFileSync(target, 'original');
      fs.mkdirSync(archiveDir(t), { recursive: true });
      fs.symlinkSync(target, archiveFile(t, 'aaaaaaaaaaaa'));

      expect(() => gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'))).not.toThrow();

      expect(fs.readFileSync(target, 'utf8')).toBe('original');
      expect(gr.readReceipt(t.root).id).toBe('aaaaaaaaaaaa');
    });

    it('writeReceipt_byIdDirectoryThatIsASymlink_writesNothingThroughIt', () => {
      const t = tempRepo();
      const out = outside();
      fs.mkdirSync(gr.historyDir(t.root), { recursive: true });
      fs.symlinkSync(out, archiveDir(t));

      expect(() => gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'))).not.toThrow();

      expect(fs.readdirSync(out)).toEqual([]);
      expect(gr.readReceipt(t.root).id).toBe('aaaaaaaaaaaa');
    });

    it('archivedReceipt_symlinkedFile_isRefused', () => {
      const t = tempRepo();
      const out = outside();
      const target = path.join(out, 'real.json');
      fs.writeFileSync(target, JSON.stringify(rec('aaaaaaaaaaaa')));
      fs.mkdirSync(archiveDir(t), { recursive: true });
      fs.symlinkSync(target, archiveFile(t, 'aaaaaaaaaaaa'));

      expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
    });

    it('archivedReceipt_symlinkedByIdDirectory_isRefused', () => {
      const t = tempRepo();
      const out = outside();
      fs.writeFileSync(path.join(out, 'aaaaaaaaaaaa.json'), JSON.stringify(rec('aaaaaaaaaaaa')));
      fs.mkdirSync(gr.historyDir(t.root), { recursive: true });
      fs.symlinkSync(out, archiveDir(t));

      expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
    });

    it('writeReceipt_pruneNeverFollowsOrDeletesThroughASymlinkedEntry', () => {
      const t = tempRepo();
      const out = outside();
      const target = path.join(out, 'keep.json');
      fs.writeFileSync(target, 'precious');
      fs.mkdirSync(archiveDir(t), { recursive: true });
      for (let i = 0; i < 200; i += 1) {
        const id = `seed${String(i).padStart(4, '0')}`;
        fs.writeFileSync(archiveFile(t, id), JSON.stringify(rec(id)));
      }
      fs.symlinkSync(target, archiveFile(t, 'linked000001'));

      gr.writeReceipt(t.root, rec('freshfresh01'));

      expect(fs.readFileSync(target, 'utf8')).toBe('precious');
      expect(jsonFiles(t).filter((n) => n !== 'linked000001.json')).toHaveLength(200);
    });
  });

  describe('archivedReceipt', () => {
    it('returnsNullForAnIdThatWasNeverArchived', () => {
      const t = tempRepo();
      gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'));

      expect(gr.archivedReceipt(t.root, 'bbbbbbbbbbbb')).toBeNull();
    });

    it('returnsNullWhenTheArchiveDirectoryDoesNotExist', () => {
      expect(gr.archivedReceipt(tempRepo().root, 'aaaaaaaaaaaa')).toBeNull();
    });

    it.each([
      ['not JSON', '{ not json'],
      ['a JSON array', '[1,2]'],
      ['JSON null', 'null'],
      ['a JSON string', '"abc"'],
    ])('returnsNullForAFileThatIs_%s', (_label, text) => {
      const t = tempRepo();
      fs.mkdirSync(archiveDir(t), { recursive: true });
      fs.writeFileSync(archiveFile(t, 'aaaaaaaaaaaa'), text);

      expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
    });

    it('returnsNullForAFileWhoseOwnIdIsAnotherId_aCopiedFileProvesNothing', () => {
      const t = tempRepo();
      fs.mkdirSync(archiveDir(t), { recursive: true });
      fs.writeFileSync(archiveFile(t, 'aaaaaaaaaaaa'), JSON.stringify(rec('bbbbbbbbbbbb')));

      expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
    });

    it('returnsNullForADirectoryNamedLikeTheReceiptFile', () => {
      const t = tempRepo();
      fs.mkdirSync(archiveFile(t, 'aaaaaaaaaaaa'), { recursive: true });

      expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
    });

    it('returnsNullForAFileOverTheSizeCap_butReadsOneJustUnderIt', () => {
      const t = tempRepo();
      fs.mkdirSync(archiveDir(t), { recursive: true });
      const pad = (id, bytes) => JSON.stringify({ ...rec(id), pad: 'x'.repeat(bytes) });
      fs.writeFileSync(archiveFile(t, 'aaaaaaaaaaaa'), pad('aaaaaaaaaaaa', 5 * 1024 * 1024));
      fs.writeFileSync(archiveFile(t, 'bbbbbbbbbbbb'), pad('bbbbbbbbbbbb', 1024 * 1024));

      expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
      expect(gr.archivedReceipt(t.root, 'bbbbbbbbbbbb').id).toBe('bbbbbbbbbbbb');
    });

    it.each([[undefined], [null], [7], ['../x'], ['']])('returnsNullForTheIdArgument_%j', (id) => {
      expect(gr.archivedReceipt(tempRepo().root, id)).toBeNull();
    });
  });
});

// ── SF-2.5 review m8: the archive's two rings, its loud failure and its presence probe ──

describe('m8 receipt archive: the failure ring, the warning and hasArchive', () => {
  const rec = (id, over = {}) => ({ schema: gr.RECEIPT_SCHEMA, id, status: 'passed', exitCode: 0, mode: 'normal', projects: [], ...over });
  const archiveDir = (t) => path.join(gr.historyDir(t.root), 'by-id');
  const failedDir = (t) => path.join(archiveDir(t), 'failed');
  const names = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  const seed = (dir, count, prefix) => {
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.now() / 1000 - 100000;
    for (let i = 0; i < count; i += 1) {
      const id = `${prefix}${String(i).padStart(4, '0')}`;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec(id)));
      fs.utimesSync(path.join(dir, `${id}.json`), base + i, base + i);
    }
  };

  it.each([
    ['failed', { status: 'failed', exitCode: 1 }],
    ['running', { status: 'running' }],
    ['interrupted', { status: 'interrupted' }],
    ['filtered', { filter: 'unit' }],
    ['change-scoped', { changedOnly: true }],
    ['passed with a non-zero exit', { exitCode: 1 }],
  ])('writeReceipt_%sReceipt_goesToTheFailureRingNotThePassingRing', (_label, over) => {
    const t = tempRepo();

    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa', over));

    expect(names(failedDir(t))).toEqual(['aaaaaaaaaaaa.json']);
    expect(names(archiveDir(t))).toEqual([]);
    expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa').id).toBe('aaaaaaaaaaaa');
  });

  it('writeReceipt_aPlainPassGoesToThePassingRing', () => {
    const t = tempRepo();

    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'));

    expect(names(archiveDir(t))).toEqual(['aaaaaaaaaaaa.json']);
    expect(fs.existsSync(failedDir(t))).toBe(false);
  });

  it('writeReceipt_theSameIdRunningThenPassed_leavesOneCopyInThePassingRing', () => {
    const t = tempRepo();
    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa', { status: 'running' }));
    expect(names(failedDir(t))).toEqual(['aaaaaaaaaaaa.json']);

    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'));

    expect(names(archiveDir(t))).toEqual(['aaaaaaaaaaaa.json']);
    expect(names(failedDir(t))).toEqual([]);
    expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa').status).toBe('passed');
  });

  it('writeReceipt_theSameIdPassedThenFailed_leavesOneCopyInTheFailureRing', () => {
    const t = tempRepo();
    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'));

    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa', { status: 'failed', exitCode: 1 }));

    expect(names(archiveDir(t))).toEqual([]);
    expect(names(failedDir(t))).toEqual(['aaaaaaaaaaaa.json']);
    expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa').status).toBe('failed');
  });

  it('writeReceipt_manyFailedAndFilteredRuns_neverEvictAnEarlyPassingReceipt', () => {
    const t = tempRepo();
    gr.writeReceipt(t.root, rec('earlywave001'));
    for (let i = 0; i < 230; i += 1) gr.writeReceipt(t.root, rec(`noise${String(i).padStart(4, '0')}`, { status: 'failed', exitCode: 1 }));

    expect(gr.archivedReceipt(t.root, 'earlywave001').status).toBe('passed');
    expect(names(failedDir(t))).toHaveLength(20);
    expect(names(failedDir(t))).toContain('noise0229.json');
    expect(names(failedDir(t))).not.toContain('noise0000.json');
  });

  it('writeReceipt_theFailureRingKeepsTheNewest20ByMtimeAndTheJustWrittenOne', () => {
    const t = tempRepo();
    seed(failedDir(t), 20, 'oldfail');

    gr.writeReceipt(t.root, rec('newfail00001', { status: 'failed', exitCode: 1 }));

    const kept = names(failedDir(t));
    expect(kept).toHaveLength(20);
    expect(kept).toContain('newfail00001.json');
    expect(kept).not.toContain('oldfail0000.json');
    expect(kept).toContain('oldfail0019.json');
  });

  it('writeReceipt_thePassingRingCapIsStill200_andIgnoresTheFailureFolder', () => {
    const t = tempRepo();
    seed(archiveDir(t), 200, 'seed');
    seed(failedDir(t), 5, 'failx');

    gr.writeReceipt(t.root, rec('freshfresh01'));

    expect(names(archiveDir(t))).toHaveLength(200);
    expect(names(archiveDir(t))).not.toContain('seed0000.json');
    expect(names(failedDir(t))).toHaveLength(5);
  });

  it('archivedReceipt_readsThePassingRingFirstThenTheFailureRing', () => {
    const t = tempRepo();
    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'));
    gr.writeReceipt(t.root, rec('bbbbbbbbbbbb', { status: 'failed', exitCode: 1 }));

    expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa').status).toBe('passed');
    expect(gr.archivedReceipt(t.root, 'bbbbbbbbbbbb').status).toBe('failed');
    expect(gr.archivedReceipt(t.root, 'cccccccccccc')).toBeNull();
  });

  describe.skipIf(process.platform === 'win32')('the failure ring refuses symlinks too', () => {
    it('archivedReceipt_symlinkedFailureFile_isRefused', () => {
      const t = tempRepo();
      const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-failed-outside-')));
      dirs.push(outsideDir);
      const target = path.join(outsideDir, 'victim.json');
      fs.writeFileSync(target, JSON.stringify(rec('aaaaaaaaaaaa', { status: 'failed', exitCode: 1 })));
      fs.mkdirSync(failedDir(t), { recursive: true });
      fs.symlinkSync(target, path.join(failedDir(t), 'aaaaaaaaaaaa.json'));

      expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
    });

    it('writeReceipt_symlinkedFailureFolder_isNotWrittenThrough', () => {
      const t = tempRepo();
      const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-failed-dir-outside-')));
      dirs.push(outsideDir);
      fs.mkdirSync(archiveDir(t), { recursive: true });
      fs.symlinkSync(outsideDir, failedDir(t));
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      try { gr.writeReceipt(t.root, rec('aaaaaaaaaaaa', { status: 'failed', exitCode: 1 })); } finally { warn.mockRestore(); }

      expect(fs.readdirSync(outsideDir)).toEqual([]);
      expect(gr.archivedReceipt(t.root, 'aaaaaaaaaaaa')).toBeNull();
    });
  });

  it('writeReceipt_archiveFailure_printsOneWarningLineNamingTheReceipt_andDoesNotThrow', () => {
    const t = tempRepo();
    fs.mkdirSync(gr.historyDir(t.root), { recursive: true });
    fs.writeFileSync(archiveDir(t), 'blocker');
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let lines;

    try { gr.writeReceipt(t.root, rec('aaaaaaaaaaaa')); lines = warn.mock.calls.map((c) => String(c[0])); } finally { warn.mockRestore(); }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[gate-receipt\] warning: receipt aaaaaaaaaaaa was not archived by id \(.+\); a story checkpoint naming it will rerun\n$/);
    expect(JSON.parse(fs.readFileSync(gr.receiptPath(t.root), 'utf8')).id).toBe('aaaaaaaaaaaa');
  });

  it('writeReceipt_archiveSuccess_printsNothing', () => {
    const t = tempRepo();
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let written;

    try { gr.writeReceipt(t.root, rec('aaaaaaaaaaaa')); written = warn.mock.calls.length; } finally { warn.mockRestore(); }

    expect(written).toBe(0);
  });

  it('hasArchive_isFalseWithoutTheFolder_trueAfterAnyArchiveWrite_falseForAFileOrSymlink', () => {
    const t = tempRepo();
    expect(gr.hasArchive(t.root)).toBe(false);

    gr.writeReceipt(t.root, rec('aaaaaaaaaaaa'));
    expect(gr.hasArchive(t.root)).toBe(true);

    const blocked = tempRepo();
    fs.mkdirSync(gr.historyDir(blocked.root), { recursive: true });
    fs.writeFileSync(archiveDir(blocked), 'blocker');
    expect(gr.hasArchive(blocked.root)).toBe(false);

    if (process.platform !== 'win32') {
      const linked = tempRepo();
      const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-has-archive-')));
      dirs.push(outsideDir);
      fs.mkdirSync(gr.historyDir(linked.root), { recursive: true });
      fs.symlinkSync(outsideDir, archiveDir(linked));
      expect(gr.hasArchive(linked.root)).toBe(false);
    }
  });
});

// Security M3: the test runner lives in node_modules/, which the code hash never covers. The engine identity
// folds in a content hash of the runner (vitest, vite and their runtime dependencies), so a changed runner
// makes every receipt written by the old one stale.
describe('engineIdentity / runnerIdentity (test runner content)', () => {
  const pkg = (t, name, files = {}, deps = {}, version = '1.0.0') => {
    t.write(`node_modules/${name}/package.json`, JSON.stringify({ name, version, dependencies: deps }));
    for (const [rel, content] of Object.entries(files)) t.write(`node_modules/${name}/${rel}`, content);
  };
  const runnerRepo = () => {
    const t = tempRepo();
    pkg(t, 'vitest', { 'vitest.mjs': 'run();\n', 'dist/reporter.js': 'report();\n' }, { tinyexec: '^1.0.0' });
    pkg(t, 'vite', { 'dist/index.js': 'vite();\n' });
    pkg(t, 'tinyexec', { 'dist/index.js': 'exec();\n' });
    return t;
  };

  it('is stable for an unchanged runner and is a 64-hex digest', () => {
    const t = runnerRepo();
    const first = gr.runnerIdentity(t.root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(gr.runnerIdentity(t.root)).toBe(first);
    expect(gr.engineIdentity(t.root)).toBe(gr.engineIdentity(t.root));
  });

  it.each([
    ['a patched vitest dist file', 'vitest', 'dist/reporter.js', 'report(); /* every test passes */\n'],
    ['a patched vitest entry point', 'vitest', 'vitest.mjs', 'process.exit(0);\n'],
    ['a patched vite file (vitest host)', 'vite', 'dist/index.js', 'vite(); evil();\n'],
    ['a patched transitive runtime dependency', 'tinyexec', 'dist/index.js', 'exec(); evil();\n'],
  ])('changes the engine identity when %s is rewritten', (_label, name, rel, content) => {
    const t = runnerRepo();
    const runnerBefore = gr.runnerIdentity(t.root);
    const engineBefore = gr.engineIdentity(t.root);

    t.write(`node_modules/${name}/${rel}`, content);

    expect(gr.runnerIdentity(t.root)).not.toBe(runnerBefore);
    expect(gr.engineIdentity(t.root)).not.toBe(engineBefore);
  });

  it('changes when a new file appears in the runner package or the version changes', () => {
    const t = runnerRepo();
    const before = gr.runnerIdentity(t.root);
    t.write('node_modules/vitest/dist/extra.js', 'x\n');
    const withExtra = gr.runnerIdentity(t.root);
    expect(withExtra).not.toBe(before);
    pkg(t, 'vitest', { 'vitest.mjs': 'run();\n', 'dist/reporter.js': 'report();\n', 'dist/extra.js': 'x\n' }, { tinyexec: '^1.0.0' }, '1.0.1');
    expect(gr.runnerIdentity(t.root)).not.toBe(withExtra);
  });

  it('ignores a file the runner never executes (a type declaration) so a harmless install tweak is not a change', () => {
    const t = runnerRepo();
    const before = gr.runnerIdentity(t.root);
    t.write('node_modules/vitest/dist/index.d.ts', 'export {};\n');
    expect(gr.runnerIdentity(t.root)).toBe(before);
  });

  it('prefers a nested dependency copy and reflects a rewrite of it', () => {
    const t = runnerRepo();
    t.write('node_modules/vitest/node_modules/tinyexec/package.json', JSON.stringify({ name: 'tinyexec', version: '2.0.0' }));
    t.write('node_modules/vitest/node_modules/tinyexec/index.js', 'nested();\n');
    const before = gr.runnerIdentity(t.root);
    t.write('node_modules/vitest/node_modules/tinyexec/index.js', 'nested(); evil();\n');
    expect(gr.runnerIdentity(t.root)).not.toBe(before);
  });

  it('is a fixed marker when no runner is installed, and never flips on its own', () => {
    const t = tempRepo();
    expect(gr.runnerIdentity(t.root)).toBe(gr.NO_RUNNER);
    expect(gr.engineIdentity(t.root)).toBe(gr.engineIdentity(t.root));
    expect(gr.engineIdentity(t.root)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is unknown (null) when a runner file cannot be read, so an unknown is never a pass', () => {
    const t = runnerRepo();
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
      if (String(file).endsWith(`${path.sep}reporter.js`)) throw new Error('EACCES');
      return real(file, ...rest);
    });
    try {
      expect(gr.runnerIdentity(t.root)).toBeNull();
      expect(gr.engineIdentity(t.root)).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('is unknown (null) on a malformed runner manifest', () => {
    const t = runnerRepo();
    t.write('node_modules/vitest/package.json', '{ not json');
    expect(gr.runnerIdentity(t.root)).toBeNull();
  });

  it('hashes the runner once per call and stays fast on the real installed runner', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const started = process.hrtime.bigint();
    const digest = gr.runnerIdentity(repoRoot);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ms, 'one gate run pays this once; keep it well under a second').toBeLessThan(2000);
  });

  describe('a receipt written by the old runner is stale for the patched one', () => {
    const makeReceipt = (t) => {
      const snap = gr.treeSnapshot(t.root);
      return {
        schema: gr.RECEIPT_SCHEMA, id: 'abc', status: 'passed', exitCode: 0, mode: 'normal', changedOnly: false, head: gr.headSha(t.root),
        treeHashStart: snap.hash, treeHashEnd: snap.hash, engine: gr.engineIdentity(t.root), configHash: gr.readGateConfigFile(t.root).hash,
        build: { status: 'passed' }, projects: [], test: { status: 'passed' }, codeHash: 'C'.repeat(64),
      };
    };
    const checksOf = (t, receipt) => gr.verifyReceiptEvidence({ root: t.root, receipt, codeHash: receipt.codeHash }).reasons.map((r) => r.check);

    it('accepts the receipt while the runner is unchanged (control)', () => {
      const t = runnerRepo();
      expect(checksOf(t, makeReceipt(t))).not.toContain('engine');
    });

    it('refuses the receipt on the engine check once the runner is patched', () => {
      const t = runnerRepo();
      const receipt = makeReceipt(t);
      t.write('node_modules/vitest/dist/reporter.js', 'report(); /* forged green */\n');
      expect(checksOf(t, receipt)).toContain('engine');
    });
  });
});
