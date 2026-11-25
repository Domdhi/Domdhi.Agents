'use strict';

/**
 * Gate receipts: the trustworthy record of what a gate run proved, and the rules for
 * reusing a passing test project instead of running it again.
 *
 * Pure functions take every input (including `now`) as a parameter and never read the
 * clock. The git and file-system shell is at the bottom (treeSnapshot, readHistory, ...).
 *
 * The one rule that governs the whole module: an unknown is never a pass. An unknown
 * closure, an uncomputable hash, a stale receipt, a failed, interrupted, invalid or flaky
 * project, a changed filter or mode, a missing file — every one of them means RUN.
 *
 * Reuse is an optimisation, so the closure only ever has to be a superset of what a result depends on, and anything
 * not fully understood falls back to a wider key (the whole-tree hash) or to RUN. What the key cannot see, by design:
 * the installed .NET SDK is folded in (`meta.sdk`, `dotnet --version`) and a floating package version makes the
 * closure unknown, but the other environment inputs (the Node or tool versions, ignored local files such as
 * appsettings.Local.json, anything a test reads outside the closure) are the owner's `inputs` responsibility.
 * `maxAgeHours` and `forceRunEvery` bound the exposure.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getTelemetryDir } = require('./telemetry-paths');
const { sameRealDir, assertNoSymlinkedAncestor } = require('./fs-safe');

const RECEIPT_SCHEMA = 1;
const HISTORY_CAP = 200;
/** The by-id receipt archive keeps this many passing receipts, newest by mtime; older receipts past it are gone. */
const ARCHIVE_CAP = 200;
/** Receipts that are not a plain passing run (failed, running, filtered, change-scoped) live in a separate small ring so they never evict a wave's passing receipt. */
const ARCHIVE_FAILED_CAP = 20;
/** A receipt is a few KB; anything larger than this in the archive is not one. */
const ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;
const ARCHIVE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_RECEIPTS = Object.freeze({ maxAgeHours: 24, forceRunEvery: 5, requireFullForPr: false });
/** Gitignored working state; never part of the tree hash, so writing a receipt cannot change it. */
const STATE_PREFIX = 'docs/.output/.state/';
const CORE_DIR = path.resolve(__dirname, '..');

const sha256 = (...parts) => {
    const hash = crypto.createHash('sha256');
    for (const part of parts) hash.update(part);
    return hash.digest('hex');
};
const short = (value) => (typeof value === 'string' && value ? value.slice(0, 12) : String(value));

// ── Command line ────────────────────────────────────────────────────

const USAGE = [
    'Usage: node .claude/core/gate.js [mode] [options]',
    '',
    'Modes (default: build):',
    '  build                    Build only',
    '  test                     Build + test + lint (records mode "normal" in the receipt)',
    '  full                     Like test, never change-scoped: every project runs or is validly reused;',
    '                           records mode "full" in the receipt',
    '  e2e                      Run the e2e/integration leg',
    '  verify-receipt           Check the latest receipt against this exact tree (no build, no lock)',
    '  stop                     Ask a running gate to stop (cooperative; reports stopped or still held)',
    '',
    'Options:',
    '  --test, --e2e            Same as the test / e2e modes',
    '  --no-build               Skip the build (implies test)',
    '  --changed                Change-scope a vitest string test command; unsupported legs run the whole suite',
    '  --mode <normal|full>     verify-receipt only: the mode the receipt must satisfy (default normal)',
    '  --json                   verify-receipt only: print { ok, reasons, receipt }',
    '  --help, -h               Print this help and exit 0',
    '',
    'Exit codes: 0 passed / ok, 1 failed / not verified / still held, 2 usage error, 3 another gate holds the lock.',
].join('\n');

/**
 * Parse the gate command line. Pure. Never exits: the caller decides what to do with
 * `{ ok:false }` (usage to stderr, exit 2) and `{ help:true }` (usage to stdout, exit 0).
 *
 * @param {string[]} args
 * @returns {{ok:true, help?:boolean, command:'run'|'verify-receipt'|'stop'|'help', skipBuild:boolean,
 *   changedOnly:boolean, runE2e:boolean, runTests:boolean, full:boolean, mode:'normal'|'full', json:boolean}
 *   | {ok:false, error:string}}
 */
function parseGateArgs(args) {
    const list = Array.isArray(args) ? args : [];
    const base = { ok: true, command: 'run', skipBuild: false, changedOnly: false, runE2e: false, runTests: false, full: false, mode: 'normal', json: false };
    if (list.includes('--help') || list.includes('-h')) return { ...base, help: true, command: 'help' };
    const known = new Set(['build', 'test', 'full', 'e2e', '--test', '--e2e', '--no-build', '--changed', 'verify-receipt', 'stop', '--json', '--mode']);
    let verify = false; let stop = false; let modeValue; let sawJson = false; let sawMode = false;
    let wantE2e = false; let wantTest = false; let full = false; let skipBuild = false; let changedOnly = false;
    for (let i = 0; i < list.length; i++) {
        const arg = list[i];
        if (arg === '--mode') {
            sawMode = true;
            modeValue = list[i + 1];
            i += 1;
            continue;
        }
        if (!known.has(arg)) return { ok: false, error: `unknown argument ${JSON.stringify(arg)}` };
        if (arg === 'verify-receipt') verify = true;
        else if (arg === 'stop') stop = true;
        else if (arg === '--json') sawJson = true;
        else if (arg === 'e2e' || arg === '--e2e') wantE2e = true;
        else if (arg === 'test' || arg === '--test') wantTest = true;
        else if (arg === 'full') { full = true; wantTest = true; }
        else if (arg === '--no-build') skipBuild = true;
        else if (arg === '--changed') changedOnly = true;
    }
    if (sawMode && modeValue !== 'normal' && modeValue !== 'full') {
        return { ok: false, error: `--mode needs "normal" or "full" (got ${modeValue === undefined ? 'nothing' : JSON.stringify(modeValue)})` };
    }
    if (verify && stop) return { ok: false, error: 'verify-receipt and stop cannot be combined' };
    if (verify || stop) {
        const stray = list.filter(a => !['verify-receipt', 'stop', '--json', '--mode', modeValue].includes(a));
        if (stray.length) return { ok: false, error: `${verify ? 'verify-receipt' : 'stop'} takes no ${stray.map(s => JSON.stringify(s)).join(', ')}` };
        if (stop && (sawJson || sawMode)) return { ok: false, error: 'stop takes no options' };
        return { ...base, command: verify ? 'verify-receipt' : 'stop', mode: modeValue || 'normal', json: sawJson };
    }
    if (sawJson || sawMode) return { ok: false, error: '--json and --mode are only valid with verify-receipt' };
    if (full && wantE2e) return { ok: false, error: '`full` is a test mode and cannot be combined with e2e' };
    if (full && changedOnly) return { ok: false, error: '`full` means no change-scoping and cannot be combined with --changed' };
    // --no-build implies --test (a build-skip without testing is meaningless), exactly as before.
    const runE2e = wantE2e;
    const runTests = !runE2e && (skipBuild || wantTest);
    return { ...base, skipBuild, changedOnly, runE2e, runTests, full: full && runTests, mode: full ? 'full' : 'normal' };
}

// ── Config ──────────────────────────────────────────────────────────

/**
 * The receipts settings with defaults; a malformed value falls back to its default and is reported. `requireFullForPrInvalid`
 * says the owner wrote something for the PR rule that is not a boolean (or a `receipts` that is not an object): the default
 * `false` would then switch off a control they turned on, so the PR check treats it as required.
 */
function receiptsConfig(config) {
    const rawValue = config ? config.receipts : undefined;
    const isObject = typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue);
    const raw = isObject ? rawValue : {};
    const warnings = [];
    if (rawValue !== undefined && !isObject) warnings.push(`receipts ${JSON.stringify(rawValue)} is not an object; using the defaults`);
    const pick = (key, valid) => {
        if (raw[key] === undefined) return DEFAULT_RECEIPTS[key];
        if (valid(raw[key])) return raw[key];
        warnings.push(`receipts.${key} ${JSON.stringify(raw[key])} is not valid; using ${JSON.stringify(DEFAULT_RECEIPTS[key])}`);
        return DEFAULT_RECEIPTS[key];
    };
    return {
        maxAgeHours: pick('maxAgeHours', v => typeof v === 'number' && Number.isFinite(v) && v > 0),
        forceRunEvery: pick('forceRunEvery', v => Number.isSafeInteger(v) && v >= 1),
        requireFullForPr: pick('requireFullForPr', v => typeof v === 'boolean'),
        requireFullForPrInvalid: (rawValue !== undefined && !isObject) || (raw.requireFullForPr !== undefined && typeof raw.requireFullForPr !== 'boolean'),
        warnings,
    };
}

/**
 * Validate `test.projects` and normalize it. Returns `{ projects, errors }`; a config with
 * errors is refused rather than guessed at.
 */
function normalizeProjects(testConfig, filter) {
    const errors = [];
    const list = testConfig && Array.isArray(testConfig.projects) ? testConfig.projects : null;
    if (!list || list.length === 0) return { projects: [], errors };
    const seen = new Set();
    const projects = [];
    list.forEach((p, index) => {
        const label = `test.projects[${index}]`;
        if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push(`${label} must be an object`); return; }
        if (typeof p.name !== 'string' || !p.name.trim()) { errors.push(`${label} needs a non-empty "name"`); return; }
        if (seen.has(p.name)) { errors.push(`${label} duplicates the name ${JSON.stringify(p.name)}`); return; }
        seen.add(p.name);
        const hasArgv = Array.isArray(p.argv) && p.argv.length > 0 && p.argv.every(a => typeof a === 'string');
        const hasCommand = typeof p.command === 'string' && p.command.trim() !== '';
        const hasPath = typeof p.path === 'string' && p.path.trim() !== '';
        if (p.argv !== undefined && !hasArgv) { errors.push(`${label} "argv" must be a non-empty array of strings`); return; }
        if (!hasArgv && !hasCommand && !hasPath) { errors.push(`${label} (${p.name}) needs "path", "argv" or "command"`); return; }
        if (p.reuse !== undefined && typeof p.reuse !== 'boolean') { errors.push(`${label} "reuse" must be true or false`); return; }
        if (p.inputs !== undefined && !(Array.isArray(p.inputs) && p.inputs.every(i => typeof i === 'string' && i.trim() !== ''))) {
            errors.push(`${label} "inputs" must be an array of paths or globs (or ["tree"])`); return;
        }
        if (p.timeout !== undefined && !(Number.isSafeInteger(p.timeout) && p.timeout > 0)) { errors.push(`${label} "timeout" must be a positive whole number of milliseconds`); return; }
        let argv = null; let command = null;
        if (hasArgv) argv = p.argv.slice();
        else if (hasCommand) command = p.command;
        else {
            argv = ['dotnet', 'test', p.path, '--configuration', 'Release', '--verbosity', 'minimal', '--no-build'];
            if (typeof filter === 'string' && filter !== '') argv.push('--filter', filter);
        }
        projects.push({
            name: p.name, path: hasPath ? p.path.replace(/\\/g, '/') : null, argv, command,
            reuse: p.reuse === true, inputs: Array.isArray(p.inputs) ? p.inputs.slice() : [], timeout: p.timeout || null,
            display: argv ? argv.join(' ') : command,
        });
    });
    return { projects, errors };
}

// ── Static scan (pure) ──────────────────────────────────────────────

const SOURCE_EXT = /\.(?:cs|fs|vb)$/i;
const READ_PATTERNS = [
    [/\b(?:File|Directory)\.[A-Za-z]/, 'File./Directory. call'],
    [/\b(?:FileInfo|DirectoryInfo)\b/, 'FileInfo/DirectoryInfo'],
    [/\b(?:GetFiles|EnumerateFiles|GetDirectories|EnumerateDirectories|EnumerateFileSystemEntries)\b/, 'file enumeration'],
    [/\b(?:Environment\.CurrentDirectory|GetCurrentDirectory)\b/, 'current directory'],
    [/\b(?:XDocument|XmlDocument|XElement|XmlReader)\.(?:Load|Create)\b|\bnew\s+XmlTextReader\b/, 'XML load from a path'],
    [/\bnew\s+(?:StreamReader|StreamWriter|FileStream|BinaryReader|BinaryWriter)\b/, 'stream opened on a path'],
    [/\bAdd(?:Json|Xml|Ini|Yaml)File\b/, 'configuration file source'],
    [/\bProcess\.Start\b|\bnew\s+ProcessStartInfo\b/, 'child process'],
    [/\bAssembly\.(?:LoadFrom|LoadFile)\b/, 'assembly loaded from a path'],
];
const ROOT_HELPER = /FindRepoRoot|SolutionRoot|GitRoot|RepoRoot|SolutionDir|"\.sln"|"src"/;

/**
 * Scan a project's own source for file-system reads. A hit vetoes reuse (unless the project
 * declares inputs). False positives cost time, never correctness.
 *
 * @param {{path:string, text:string}[]} files
 * @returns {{file:string, line:number, kind:string, text:string}[]}
 */
function scanStaticReads(files) {
    const hits = [];
    for (const file of files || []) {
        if (!SOURCE_EXT.test(file.path)) continue;
        const lines = String(file.text).split(/\r?\n/);
        lines.forEach((text, index) => {
            const near = lines.slice(Math.max(0, index - 3), index + 4).join('\n');
            let kind = null;
            for (const [pattern, label] of READ_PATTERNS) if (pattern.test(text)) { kind = label; break; }
            if (!kind && /\bPath\.Combine\b/.test(text) && ROOT_HELPER.test(near)) kind = 'Path.Combine near a repo/solution root helper';
            if (!kind && /AppContext\.BaseDirectory|\bAssembly\b.*\.Location\b|GetExecutingAssembly/.test(text) && /\.\./.test(lines.slice(index, index + 4).join('\n'))) {
                kind = 'base directory followed by ..';
            }
            if (kind) hits.push({ file: file.path, line: index + 1, kind, text: text.trim().slice(0, 160) });
        });
    }
    return hits;
}

// ── Closure (pure over a snapshot) ──────────────────────────────────

const toPosix = (p) => String(p).replace(/\\/g, '/');
function normalizeRel(p) {
    const out = [];
    for (const part of toPosix(p).split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
    }
    return out.join('/');
}
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const join = (dir, rel) => normalizeRel(dir ? `${dir}/${rel}` : rel);
const stripXmlComments = (text) => String(text).replace(/<!--[\s\S]*?-->/g, '');
const ANCESTOR_FILES = ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Build.rsp', 'Directory.Packages.props', 'global.json', 'NuGet.config', '.editorconfig'];
const PATH_ITEMS = new Set(['compile', 'content', 'none', 'embeddedresource', 'additionalfiles', 'page', 'resource', 'applicationdefinition', 'analyzer', 'editorconfigfiles', 'analyzerconfigfiles', 'protobuf', 'codeanalysisdictionary']);
/** Leaf elements whose text is a file path (an assembly hint, a rule set, a key file ...): a path reference like an item's Include. */
const PATH_PROPS = new Set(['hintpath', 'codeanalysisruleset', 'assemblyoriginatorkeyfile', 'applicationicon', 'applicationmanifest', 'win32manifest', 'win32resource', 'documentationfile', 'packageicon', 'packagelicensefile', 'packagereadmefile']);
/** Elements whose Version may float (`1.*`): a new package release then changes a result without changing a byte of the tree. */
const FLOATING_PACKAGE = new Set(['packagereference', 'packageversion', 'globalpackagereference']);
/** The ancestor files that are MSBuild XML: scanned for imports and path items like the project file. */
const SCANNED_ANCESTORS = new Set(['directory.build.props', 'directory.build.targets', 'directory.packages.props']);

/** Case-insensitive lookup over the snapshot with an exact match preferred; ambiguity is "not found". */
function makeLookup(entries) {
    const lower = new Map();
    for (const key of entries.keys()) {
        const k = key.toLowerCase();
        lower.set(k, lower.has(k) ? null : key);
    }
    return (p) => {
        if (p === null || p === undefined) return null;
        if (entries.has(p)) return p;
        return lower.get(p.toLowerCase()) || null;
    };
}

/**
 * Resolve an MSBuild path reference. Only `$(MSBuildThisFileDirectory)` and
 * `$(MSBuildProjectDirectory)` prefixes can be resolved; any other property or a wildcard
 * outside the project directory is unknown.
 */
function resolveRef(value, baseDir, projectDir) {
    let v = String(value).trim();
    const prop = v.match(/^\$\((MSBuildThisFileDirectory|MSBuildProjectDirectory)\)[\\/]?/i);
    if (prop) {
        const dir = prop[1].toLowerCase() === 'msbuildprojectdirectory' ? projectDir : baseDir;
        v = v.slice(prop[0].length);
        const resolved = join(dir, v.replace(/\\/g, '/'));
        return resolved === null ? { unknown: 'escapes the repository' } : { path: resolved, wildcard: /[*?]/.test(v) };
    }
    if (/\$\(|\$\[|@\(/.test(v)) return { unknown: `uses the MSBuild expression ${v}` };
    const resolved = join(baseDir, v.replace(/\\/g, '/'));
    return resolved === null ? { unknown: `${v} escapes the repository` } : { path: resolved, wildcard: /[*?]/.test(v) };
}

function attrs(tag) {
    const out = {};
    const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
    return out;
}

/**
 * The input closure of a .NET project: its directory (minus bin/obj), every ProjectReference
 * followed transitively, includes/imports that point outside a project directory, the
 * Directory.Build.* chain and root files. Unknown when anything cannot be resolved.
 *
 * @param {{entries:Map<string,{blob:string}>, readText:(p:string)=>string|null, projectPath:string}} input
 * @returns {{known:boolean, reason?:string, files?:Map<string,string>}}
 */
function dotnetClosure({ entries, readText, projectPath }) {
    const lookup = makeLookup(entries);
    const files = new Map();
    const dirs = new Set();
    const visited = new Set();
    const projectQueue = [];
    const fileQueue = [];
    const scanned = new Set();
    const addFile = (p) => files.set(p, entries.get(p).blob);
    // An MSBuild file is scanned with the directory of the project it belongs to (that is what $(MSBuildProjectDirectory)
    // and "inside the project directory" mean for it); each (file, project directory) pair is scanned once.
    const queueScan = (file, projectDir) => {
        const key = `${file}\0${projectDir}`;
        if (scanned.has(key)) return;
        scanned.add(key);
        fileQueue.push({ file, projectDir });
    };
    const root = lookup(normalizeRel(projectPath));
    if (!root) return { known: false, reason: `project file ${projectPath} is not in the tree` };
    projectQueue.push(root);
    visited.add(root);

    const scanFile = (file, projectDir) => {
        const text = readText(file);
        if (text === null || text === undefined) return `could not read ${file}`;
        const xml = stripXmlComments(text);
        if (!/<Project\b/i.test(xml)) return `${file} is not a parseable MSBuild file`;
        const baseDir = dirOf(file);
        // One path reference found in `file`. A path inside the project directory is covered by the directory contents; one
        // outside joins the closure, or makes it unknown when it cannot be resolved to a file in the tree.
        const pathRef = (label, raw, a) => {
            const r = resolveRef(raw, baseDir, projectDir);
            if (r.unknown) return `${file}: ${label} ${r.unknown}`;
            if (projectDir === '' || r.path === projectDir || r.path.startsWith(`${projectDir}/`)) return null;
            if (r.wildcard) return `${file}: ${label} ${raw} is a wildcard outside the project directory`;
            const found = lookup(r.path);
            if (found) addFile(found);
            else if (a.condition !== undefined) files.set(r.path, 'ABSENT');
            else return `${file}: ${label} ${raw} is outside the project directory and not in the tree`;
            return null;
        };
        const tagRe = /<([A-Za-z_][\w.-]*)\b([^>]*?)\/?>/g;
        let m;
        while ((m = tagRe.exec(xml))) {
            const name = m[1].toLowerCase();
            const a = attrs(m[2]);
            if (name === 'projectreference' && a.include !== undefined) {
                const r = resolveRef(a.include, baseDir, projectDir);
                if (r.unknown) return `${file}: ProjectReference ${r.unknown}`;
                const found = r.wildcard ? null : lookup(r.path);
                if (!found) return `${file}: ProjectReference ${a.include} is missing`;
                if (!visited.has(found)) { visited.add(found); projectQueue.push(found); }
                continue;
            }
            if (name === 'import' && a.project !== undefined) {
                if (a.sdk !== undefined) continue;
                const conditional = a.condition !== undefined;
                if (/GetPathOfFileAbove/i.test(a.project)) continue;
                const r = resolveRef(a.project, baseDir, projectDir);
                if (r.unknown) return `${file}: Import ${r.unknown}`;
                if (r.wildcard) return `${file}: Import ${a.project} uses a wildcard`;
                const found = lookup(r.path);
                if (!found) {
                    if (conditional) { files.set(r.path, 'ABSENT'); continue; }
                    return `${file}: Import ${a.project} is missing`;
                }
                addFile(found);
                queueScan(found, projectDir);
                continue;
            }
            if (FLOATING_PACKAGE.has(name)) {
                for (const key of ['version', 'versionoverride']) {
                    if (a[key] !== undefined && a[key].includes('*')) return `${file}: ${m[1]} ${a.include || a.update || ''} uses the floating version ${a[key]}`;
                }
                continue;
            }
            if (!PATH_ITEMS.has(name)) continue;
            for (const key of ['include', 'update']) {
                if (a[key] === undefined) continue;
                // An item list (`a.cs;..\shared\b.cs`) is several paths; items inside the project directory are covered by its contents.
                for (const part of a[key].split(';')) {
                    if (part.trim() === '') continue;
                    const failure = pathRef(`${m[1]} ${key}`, part, a);
                    if (failure) return failure;
                }
            }
        }
        // A package version written as a child element (<PackageReference Include="X"><Version>1.*</Version>).
        const packageRe = /<(PackageReference|PackageVersion|GlobalPackageReference)\b[^>]*[^/>]>([\s\S]*?)<\/\1\s*>/gi;
        let p;
        while ((p = packageRe.exec(xml))) {
            const child = p[2].match(/<Version(?:Override)?>([^<]*\*[^<]*)<\/Version(?:Override)?>/i);
            if (child) return `${file}: ${p[1]} uses the floating version ${child[1].trim()}`;
        }
        // File-valued child elements (an assembly hint path, a rule set, a key file ...).
        const propRe = /<([A-Za-z_][\w.-]*)\b([^>]*)>([^<]*)<\/\1\s*>/g;
        let q;
        while ((q = propRe.exec(xml))) {
            if (!PATH_PROPS.has(q[1].toLowerCase()) || q[3].trim() === '') continue;
            const failure = pathRef(q[1], q[3].trim(), attrs(q[2]));
            if (failure) return failure;
        }
        return null;
    };

    while (projectQueue.length) {
        const file = projectQueue.shift();
        const projectDir = dirOf(file);
        dirs.add(projectDir);
        addFile(file);
        scanned.add(`${file}\0${projectDir}`);
        const failure = scanFile(file, projectDir);
        if (failure) return { known: false, reason: failure };
    }
    // The configuration chain MSBuild/NuGet discovers by walking up from each project directory. The MSBuild files in it
    // are scanned like the project file (their imports and path items join the closure); an absent one is recorded.
    for (const dir of dirs) {
        let walk = dir;
        for (;;) {
            for (const candidate of ANCESTOR_FILES) {
                const target = walk === '' ? candidate : `${walk}/${candidate}`;
                const found = lookup(target);
                if (found) {
                    files.set(found, entries.get(found).blob);
                    if (SCANNED_ANCESTORS.has(candidate.toLowerCase())) queueScan(found, dir);
                } else files.set(target, 'ABSENT');
            }
            if (walk === '') break;
            walk = dirOf(walk);
        }
    }
    while (fileQueue.length) {
        const { file, projectDir } = fileQueue.shift();
        const failure = scanFile(file, projectDir);
        if (failure) return { known: false, reason: failure };
    }

    for (const dir of dirs) {
        const prefix = dir === '' ? '' : `${dir}/`;
        for (const [file, { blob }] of entries) {
            if (!file.startsWith(prefix)) continue;
            const rest = file.slice(prefix.length);
            if (rest.startsWith('bin/') || rest.startsWith('obj/')) continue;
            files.set(file, blob);
        }
    }
    for (const [file, { blob }] of entries) {
        if (!file.includes('/') && /\.(?:sln|slnx)$/i.test(file)) files.set(file, blob);
    }
    return { known: true, files };
}

function globToRegExp(glob) {
    const g = toPosix(glob).replace(/^\.\//, '');
    let out = '';
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') {
            if (g[i + 1] === '*') { out += '.*'; i += 1; if (g[i + 1] === '/') i += 1; } else out += '[^/]*';
        } else if (c === '?') out += '[^/]';
        else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
}

/** Files named by a project's declared inputs. `null` when an input matches nothing (unknown). */
function declaredInputFiles(entries, inputs) {
    const files = new Map();
    for (const input of inputs) {
        const pattern = toPosix(input).replace(/^\.\//, '').replace(/\/+$/, '');
        const glob = /[*?]/.test(pattern);
        const re = glob ? globToRegExp(pattern) : null;
        let matched = false;
        for (const [file, { blob }] of entries) {
            if (glob ? re.test(file) : (file === pattern || file.startsWith(`${pattern}/`))) { files.set(file, blob); matched = true; }
        }
        if (!matched) return { known: false, reason: `declared input ${JSON.stringify(input)} matches no file` };
    }
    return { known: true, files };
}

/**
 * The closure of one test project. `meta` (engine identity, config hash, filter, mode, command)
 * is folded into the hash so any change of rule, rendered config, filter, mode or command reruns.
 *
 * @returns {{known:boolean, reason?:string, hash?:string, fileCount?:number, files?:Map<string,string>}}
 */
function projectClosure({ project, snapshot, readText, meta }) {
    const inputs = project.inputs || [];
    const metaText = JSON.stringify([meta.engine, meta.configHash, meta.filter, meta.mode, project.display, ...sdkPart(meta)]);
    if (inputs.includes('tree')) {
        return { known: true, hash: sha256('tree\0', snapshot.hash, '\0', metaText), fileCount: snapshot.entries.size, files: null };
    }
    let files = new Map();
    const isDotnet = project.path && /\.(?:cs|fs|vb)proj$/i.test(project.path);
    if (isDotnet) {
        const closure = dotnetClosure({ entries: snapshot.entries, readText, projectPath: project.path });
        if (!closure.known) return { known: false, reason: closure.reason };
        files = closure.files;
    } else if (inputs.length === 0) {
        return { known: false, reason: 'not a .NET project and no "inputs" declared' };
    }
    if (inputs.length) {
        const declared = declaredInputFiles(snapshot.entries, inputs);
        if (!declared.known) return { known: false, reason: declared.reason };
        for (const [file, blob] of declared.files) files.set(file, blob);
    }
    return { known: true, hash: hashFiles(files, metaText), fileCount: files.size, files };
}

function hashFiles(files, metaText) {
    const lines = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, blob]) => `${blob}\t${file}\n`);
    return sha256(lines.join(''), '\0', metaText);
}

/** Project paths named by a Visual Studio solution (.sln) or XML solution (.slnx). */
function solutionProjectPaths(text, solutionPath) {
    const dir = dirOf(solutionPath);
    const found = [];
    const sln = /Project\("\{[^}]*\}"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+)"/g;
    const slnx = /<Project\b[^>]*\bPath\s*=\s*"([^"]+)"/g;
    for (const re of [sln, slnx]) {
        let m;
        while ((m = re.exec(text))) {
            const rel = join(dir, m[1].replace(/\\/g, '/'));
            if (rel !== null && /\.(?:cs|fs|vb)proj$/i.test(rel)) found.push(rel);
        }
    }
    return found;
}

/** The SDK part of a reuse key: present only when the caller resolved one (`meta.sdk`), so keys without it keep their shape. */
function sdkPart(meta) { return meta.sdk === undefined ? [] : [meta.sdk]; }

const BUILD_VERBS = new Set(['build', 'publish', 'pack', 'msbuild', 'test']);
const SOLUTION_FILE = /\.(?:sln|slnx)$/i;
const PROJECT_FILE = /\.(?:cs|fs|vb)proj$/i;

/** The argv lists a build leg runs ({ argv }, { command } or { legs }); null when any part is not plain words. */
function legArgvs(leg) {
    if (typeof leg === 'string') leg = { command: leg };
    if (!leg || typeof leg !== 'object') return null;
    if (Array.isArray(leg.legs)) {
        const out = [];
        for (const sub of leg.legs) {
            const argvs = legArgvs(sub);
            if (!argvs) return null;
            out.push(...argvs);
        }
        return out.length ? out : null;
    }
    if (Array.isArray(leg.argv)) return leg.argv.length && leg.argv.every(a => typeof a === 'string') ? [leg.argv] : null;
    // A shell string is read as words only when it has no quoting, chaining, redirection, expansion or escapes.
    if (typeof leg.command === 'string' && leg.command.trim() !== '' && !/[&|;<>`$"'()\\*?\r\n]/.test(leg.command)) return [leg.command.trim().split(/\s+/)];
    return null;
}

/**
 * The solution or project files a build command builds, when that is fully understood: `dotnet build|publish|pack|msbuild|test`
 * with explicit targets, or with none and exactly one root solution (else exactly one root project file). Anything else
 * (npm, make, a shell line, another verb, an absolute path) is not understood, and the build is then keyed on the whole tree.
 *
 * @param {object} leg the gate config's `build` leg
 * @param {Map<string,object>} entries the tree snapshot entries
 * @returns {{understood:true, targets:string[]} | {understood:false, reason:string}}
 */
function buildTargets(leg, entries) {
    const argvs = legArgvs(leg);
    if (!argvs) return { understood: false, reason: 'the build command is not a plain argv, command or list of legs' };
    const targets = [];
    for (const argv of argvs) {
        const head = path.posix.basename(toPosix(argv[0])).replace(/\.exe$/i, '').toLowerCase();
        if (head !== 'dotnet' || !BUILD_VERBS.has(String(argv[1] || '').toLowerCase())) {
            return { understood: false, reason: `"${argv.join(' ')}" is not a dotnet build, publish, pack, msbuild or test call` };
        }
        const named = argv.slice(2).filter(t => !t.startsWith('-') && (SOLUTION_FILE.test(t) || PROJECT_FILE.test(t)));
        if (named.some(t => t.startsWith('/') || /^[A-Za-z]:/.test(t))) return { understood: false, reason: `"${argv.join(' ')}" names a path outside the repository root` };
        if (named.length) {
            for (const t of named) {
                const rel = normalizeRel(t);
                if (rel === null) return { understood: false, reason: `"${argv.join(' ')}" names a path outside the repository root` };
                targets.push(rel);
            }
            continue;
        }
        // No explicit target: dotnet takes the one solution (else the one project file) in the working directory.
        const rootFiles = [...entries.keys()].filter(f => !f.includes('/'));
        const solutions = rootFiles.filter(f => SOLUTION_FILE.test(f));
        const implicit = solutions.length ? solutions : rootFiles.filter(f => PROJECT_FILE.test(f));
        if (implicit.length !== 1) return { understood: false, reason: `"${argv.join(' ')}" names no target and the repository root does not hold exactly one solution or project file` };
        targets.push(implicit[0]);
    }
    return { understood: true, targets };
}

/**
 * The closure of the build: every test project's closure, plus what the build command builds. The build is keyed on what it
 * builds only when that is understood (`buildTargets`): each target solution's projects, or the target project, joins the
 * closure through `dotnetClosure`, and a target that cannot be resolved makes the whole closure unknown, so the build runs.
 * For any other build command (npm, make, an unknown tool) nothing says which files it reads, so it is keyed on the whole
 * tree: reused only when no file differs from the run it is reused from.
 */
function buildClosure({ projectClosures, snapshot, readText, meta, buildDisplay, buildLeg }) {
    const wholeTree = (reason) => ({
        known: true, wholeTree: reason, files: null,
        hash: sha256('tree\0', snapshot.hash, '\0', JSON.stringify([meta.engine, meta.configHash, meta.mode, buildDisplay, ...sdkPart(meta)])),
    });
    const files = new Map();
    for (const closure of projectClosures) {
        if (!closure.known) return { known: false, reason: 'a project closure is unknown' };
        if (closure.files === null) return wholeTree('a project is keyed on the whole tree');
        for (const [file, blob] of closure.files) files.set(file, blob);
    }
    const understood = buildTargets(buildLeg, snapshot.entries);
    if (!understood.understood) return wholeTree(understood.reason);
    const lookup = makeLookup(snapshot.entries);
    for (const target of understood.targets) {
        const found = lookup(target);
        if (!found) return { known: false, reason: `build target ${target} is not in the tree` };
        const projectPaths = [];
        if (SOLUTION_FILE.test(found)) {
            files.set(found, snapshot.entries.get(found).blob);
            const text = readText(found);
            if (text === null || text === undefined) return { known: false, reason: `could not read ${found}` };
            projectPaths.push(...solutionProjectPaths(text, found));
        } else projectPaths.push(found);
        for (const projectPath of projectPaths) {
            const closure = dotnetClosure({ entries: snapshot.entries, readText, projectPath });
            if (!closure.known) return { known: false, reason: `build target ${target}, project ${projectPath}: ${closure.reason}` };
            for (const [f, b] of closure.files) files.set(f, b);
        }
    }
    return { known: true, hash: hashFiles(files, JSON.stringify([meta.engine, meta.configHash, meta.mode, buildDisplay, 'build', ...sdkPart(meta)])), files };
}

// ── Reuse decision and history (pure) ───────────────────────────────

const sameKey = (record, { name, closureHash, filter, mode, command }) =>
    record && record.name === name && record.closureHash === closureHash && record.filter === filter &&
    record.mode === mode && record.command === command;

/**
 * Decide whether a project's last real passing run can stand in for running it. The answer is
 * RUN, with the reason, unless every condition holds. Pure: `now` is a millisecond instant.
 *
 * @param {{project:{name:string, reuse?:boolean, inputs?:string[]}, command:string, closureHash:string|null,
 *   closureReason?:string, filter:string|null, mode:string, now:number, history:object[],
 *   staticScan?:{file:string,line:number,kind:string,text:string}[], config:{maxAgeHours:number, forceRunEvery:number}}} input
 * @returns {{reuse:boolean, reason:string, from?:object}}
 */
function decideReuse({ project, command, closureHash, closureReason, filter, mode, now, history, staticScan, config }) {
    const run = (reason) => ({ reuse: false, reason });
    if (!project || project.reuse !== true) return run('not opted in (set "reuse": true to allow it)');
    if (!closureHash) return run(`input closure unknown (${closureReason || 'not computed'})`);
    const hits = staticScan || [];
    const declared = Array.isArray(project.inputs) && project.inputs.length > 0;
    if (hits.length && !declared) {
        const hit = hits[0];
        return run(`static scan vetoed reuse: ${hit.file}:${hit.line} ${hit.kind} (${hit.text}); declare "inputs" that cover it, or "inputs": ["tree"]`);
    }
    const key = { name: project.name, closureHash, filter, mode, command };
    let last = null;
    for (const record of history || []) if (sameKey(record, key)) last = record;
    if (!last) return run('no receipt for this closure, filter, mode and command');
    if (last.status !== 'passed') return run(`the last result for this closure was ${last.status}`);
    if (last.flaky === true) return run('marked flaky (failed then passed on this closure); needs two consecutive real passes');
    const ranAt = Date.parse(last.ranAt);
    if (!Number.isFinite(ranAt)) return run('the receipt has no usable run time');
    const ageMs = now - ranAt;
    if (ageMs < 0) return run('the receipt is dated in the future');
    if (ageMs > config.maxAgeHours * 3600000) return run(`the last real run is ${Math.round(ageMs / 360000) / 10} h old (maxAgeHours ${config.maxAgeHours})`);
    const reused = Number.isSafeInteger(last.reuseCount) && last.reuseCount >= 0 ? last.reuseCount : 0;
    if (reused >= config.forceRunEvery) return run(`forced refresh: reused ${reused} times since the last real run (forceRunEvery ${config.forceRunEvery})`);
    return { reuse: true, reason: 'closure, filter, mode and command match a fresh passing run', from: last };
}

/** Append a real run to a project's history, marking fail-then-pass on the same key as flaky. */
function appendRecord(records, record, cap = HISTORY_CAP) {
    const list = Array.isArray(records) ? records.slice() : [];
    let previous = null;
    for (const r of list) if (sameKey(r, record)) previous = r;
    const next = { ...record, reuseCount: 0 };
    if (record.status === 'passed' && previous && previous.status === 'failed') next.flaky = true;
    list.push(next);
    return list.slice(-cap);
}

function bumpReuse(records, id) {
    return (records || []).map(r => (r.id === id ? { ...r, reuseCount: (Number.isSafeInteger(r.reuseCount) ? r.reuseCount : 0) + 1 } : r));
}

// ── Verification (pure) ─────────────────────────────────────────────

/**
 * Check a receipt against the current tree. Every failed check is reported with its values.
 *
 * @returns {{ok:boolean, reasons:{check:string, message:string}[]}}
 */
function evaluateReceipt({ receipt, current, mode, projectNames, ignoreCurrentTree = false }) {
    const reasons = [];
    const fail = (check, message) => reasons.push({ check, message });
    if (!receipt || typeof receipt !== 'object' || receipt.schema !== RECEIPT_SCHEMA) {
        fail('receipt', 'no valid gate receipt found');
        return { ok: false, reasons };
    }
    if (receipt.changedOnly === true) fail('scope', 'the run was change-scoped (--changed); it does not cover the whole suite');
    if (receipt.status !== 'passed') fail('status', `the latest receipt is "${receipt.status}", not "passed"`);
    if (receipt.exitCode !== 0) fail('exitCode', `the gate exited ${receipt.exitCode}`);
    if (mode === 'full' && receipt.mode !== 'full') fail('mode', `the receipt is mode "${receipt.mode}", a full pass is required`);
    if (mode !== 'full' && receipt.mode !== 'full' && receipt.mode !== 'normal') fail('mode', `the receipt has an unknown mode ${JSON.stringify(receipt.mode)}`);
    if (!receipt.treeHashStart || !receipt.treeHashEnd) fail('treeHash', 'the receipt has no tree hash');
    else if (receipt.treeHashStart !== receipt.treeHashEnd) fail('treeHash', `the tree changed during the run (${short(receipt.treeHashStart)} → ${short(receipt.treeHashEnd)}); that run proves nothing`);
    // `ignoreCurrentTree` is the code-hash caller's switch (verifyReceiptEvidence): the whole-tree comparison is its
    // one omission, because the code hash it checks instead leaves out the files a wave edits after its gate.
    if (!ignoreCurrentTree) {
        if (!current.treeHash) fail('treeHash', 'the current tree hash could not be computed');
        else if (receipt.treeHashStart && receipt.treeHashStart !== current.treeHash) {
            fail('treeHash', `tree hash: the receipt covers ${short(receipt.treeHashStart)} but the tree is now ${short(current.treeHash)} (files were edited, added or removed since the gate ran)`);
        }
    }
    if (!current.head) fail('head', 'the current HEAD could not be read');
    else if (receipt.head !== current.head) fail('head', `HEAD: the receipt was taken at ${short(receipt.head)} but HEAD is ${short(current.head)}`);
    if (!receipt.engine || !current.engine || receipt.engine !== current.engine) fail('engine', `gate engine changed (${short(receipt.engine)} → ${short(current.engine)})`);
    if (!receipt.configHash || receipt.configHash !== current.configHash) fail('config', `gate config changed (${short(receipt.configHash)} → ${short(current.configHash)})`);
    if (!receipt.build || receipt.build.status !== 'passed') fail('build', `the build did not pass in this receipt (${receipt.build ? receipt.build.status : 'missing'})`);
    const byName = new Map((receipt.projects || []).map(p => [p.name, p]));
    for (const name of projectNames || []) {
        const entry = byName.get(name);
        if (!entry) fail('project', `project ${name}: no result in the receipt`);
        else if (entry.status !== 'passed') fail('project', `project ${name}: ${entry.status}`);
    }
    if (receipt.test && receipt.test.status !== undefined && receipt.test.status !== 'passed') fail('test', `the test leg is "${receipt.test.status}"`);
    return { ok: reasons.length === 0, reasons };
}

// ── Shell: git, files, history ──────────────────────────────────────

function gitRun(root, args, input) {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', MSYS_NO_PATHCONV: '1' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE']) delete env[key];
    const result = spawnSync('git', ['-C', root, ...args], {
        encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, windowsHide: true, env,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
}

const sameDir = (a, b) => {
    try { return sameRealDir(a, b); } catch { return false; }
};

/**
 * Content hash of the working tree: tracked files plus untracked files that are not ignored.
 * Staged blob ids come from the index; every path git reports as changed is re-hashed from the
 * file's actual bytes (with the same filters `git add` applies, so a commit does not change the
 * hash). A deleted file is simply absent. Anything that cannot be computed is `{ ok:false }`.
 *
 * @returns {{ok:true, hash:string, entries:Map<string,{mode:string, blob:string}>} | {ok:false, reason:string}}
 */
function treeSnapshot(root) {
    const top = gitRun(root, ['rev-parse', '--show-toplevel']);
    if (top === null) return { ok: false, reason: 'not a git repository (or git failed)' };
    if (!sameDir(top.trim(), root)) return { ok: false, reason: 'the project root is not the repository root' };
    const staged = gitRun(root, ['ls-files', '-s', '-z']);
    if (staged === null) return { ok: false, reason: 'git ls-files failed' };
    const entries = new Map();
    for (const record of staged.split('\0')) {
        if (!record) continue;
        const m = record.match(/^(\d{6}) ([0-9a-f]{40,64}) (\d)\t([\s\S]*)$/);
        if (!m) return { ok: false, reason: 'unreadable git index entry' };
        if (m[3] !== '0') return { ok: false, reason: `unmerged path ${m[4]}` };
        entries.set(m[4], { mode: m[1], blob: m[2] });
    }
    const status = gitRun(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status === null) return { ok: false, reason: 'git status failed' };
    const changed = new Set();
    const fields = status.split('\0');
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (!field) continue;
        const m = field.match(/^(.)(.) ([\s\S]*)$/);
        if (!m) return { ok: false, reason: 'unreadable git status entry' };
        changed.add(m[3]);
        if (m[1] === 'R' || m[1] === 'C' || m[2] === 'R' || m[2] === 'C') { i += 1; if (fields[i]) changed.add(fields[i]); }
    }
    // `git status` never reports a path flagged assume-unchanged (lowercase tag) or skip-worktree (`S`), so an edit to one
    // would leave its indexed blob in the hash. Hash those paths from disk too (an absent one counts as deleted).
    const flagged = gitRun(root, ['ls-files', '-v', '-z']);
    if (flagged === null) return { ok: false, reason: 'git ls-files -v failed' };
    for (const record of flagged.split('\0')) {
        if (record && (record[0] === 'S' || /[a-z]/.test(record[0]))) changed.add(record.slice(2));
    }
    const toHash = [];
    for (const rel of changed) {
        if (rel.startsWith(STATE_PREFIX)) continue;
        if (rel.endsWith('/')) return { ok: false, reason: `nested repository or directory ${rel}` };
        if (rel.includes('\n')) return { ok: false, reason: `a path contains a newline: ${JSON.stringify(rel)}` };
        let stat;
        try { stat = fs.lstatSync(path.join(root, rel)); } catch (error) {
            if (error.code === 'ENOENT') { entries.delete(rel); continue; }
            return { ok: false, reason: `cannot stat ${rel}: ${error.code}` };
        }
        if (stat.isDirectory()) return { ok: false, reason: `${rel} is a directory (nested repository?)` };
        toHash.push({ rel, stat });
    }
    if (toHash.length) {
        const out = gitRun(root, ['hash-object', '--stdin-paths'], `${toHash.map(t => t.rel).join('\n')}\n`);
        if (out === null) return { ok: false, reason: 'git hash-object failed (unreadable file or a line-ending conversion error)' };
        const blobs = out.split('\n').filter(Boolean);
        if (blobs.length !== toHash.length) return { ok: false, reason: 'git hash-object returned an unexpected result' };
        toHash.forEach(({ rel, stat }, index) => {
            const indexed = entries.get(rel);
            let mode = indexed ? indexed.mode : '100644';
            if (process.platform !== 'win32') mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111 ? '100755' : '100644');
            entries.set(rel, { mode, blob: blobs[index] });
        });
    }
    for (const key of [...entries.keys()]) if (key.startsWith(STATE_PREFIX)) entries.delete(key);
    return { ok: true, hash: hashTreeEntries(entries), entries };
}

/**
 * The tree hash over a snapshot's entries: sha256 of one `${mode} ${blob}\t${path}\n` line per
 * entry, sorted by path in UTF-16 code-unit order. With no `exclude` the output is byte-identical
 * to the hash `treeSnapshot` has always produced, so receipts written before this existed verify.
 * `exclude(path)` returning true drops that entry; anything else but undefined throws, because a
 * mistyped exclusion (a string, an array) must never silently hash everything.
 *
 * @param {Map<string,{mode:string, blob:string}>} entries
 * @param {{exclude?: (path:string) => boolean}} [options]
 * @returns {string}
 */
function hashTreeEntries(entries, { exclude } = {}) {
    if (exclude !== undefined && typeof exclude !== 'function') throw new TypeError('hashTreeEntries: exclude must be a function');
    const kept = [...entries.entries()].filter(([file]) => !(exclude && exclude(file)));
    const lines = kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, e]) => `${e.mode} ${e.blob}\t${file}\n`);
    return sha256(lines.join(''));
}

/** Paths a wave edits after its gate (TODO, plan, handoff, review reports, memory): never part of the code hash. */
const CODE_HASH_EXCLUDED_DIRS = ['docs/.output/', 'docs/work/'];
const CODE_HASH_EXCLUDED_TODO = /^docs\/TODO_[^/]*\.md$/;
const CODE_FILE_IN_DOCS = /\.(?:[cm]?[jt]sx?|py|sh|ps1|psm1|rb|go|rs|cs|java|php|pl)$/i;

/**
 * True when a repo-relative, forward-slash path is outside the code hash by the fixed rule (`docs/.output/`,
 * `docs/work/`, `docs/TODO_*.md`). The one definition: `codeTreeHash` uses it, and ac-verify uses it to refuse a
 * `verify:` command that names a path whose contents the hash would never see. Matching is case-insensitive
 * here on purpose (a case-insensitive filesystem reaches the same file under another spelling); the hash
 * itself stays exact-case, so a case variant is refused, never silently trusted.
 *
 * @param {string} rel
 * @returns {boolean}
 */
function isUnderExcludedDocs(rel) {
    const lower = String(rel).toLowerCase();
    return CODE_HASH_EXCLUDED_DIRS.some(dir => lower.startsWith(dir) || `${lower}/` === dir)
        || /^docs\/todo_[^/]*\.md$/.test(lower);
}

function isCodeHashExcluded(rel) {
    const lower = String(rel).toLowerCase();
    return (CODE_HASH_EXCLUDED_DIRS.some(dir => lower.startsWith(dir) || `${lower}/` === dir) && !CODE_FILE_IN_DOCS.test(lower))
        || /^docs\/todo_[^/]*\.md$/.test(lower);
}

/**
 * Hash of the code in the working tree: the `treeSnapshot` entries minus `docs/.output/`,
 * `docs/work/` (except code files there, see CODE_FILE_IN_DOCS), `docs/TODO_*.md` (direct children of
 * docs/) and every `extraExclude` path. An
 * `extraExclude` entry is a repo-relative file or directory (trailing slash optional) matched on a
 * path-segment boundary; '', '.' and '/' are ignored so a blank entry never excludes the whole
 * tree. The ac-verify records and the ship seal share this one definition.
 *
 * `extraExclude` MUST come from tracked configuration, never from the TODO or any other document an
 * agent can edit: an entry such as `.agents` silently drops all of that code from the hash. The fixed
 * exclusions above hide files a binding could still execute (a script under `docs/.output/`), which is
 * why ac-verify refuses any `verify:` path inside them instead of widening this hash.
 *
 * @param {string} root repository root
 * @param {{extraExclude?: string[]}} [options]
 * @returns {{ok:true, hash:string} | {ok:false, reason:string}}
 */
function codeTreeHash(root, { extraExclude } = {}) {
    if (extraExclude !== undefined && !Array.isArray(extraExclude)) throw new TypeError('codeTreeHash: extraExclude must be an array');
    const extras = [];
    for (const entry of extraExclude || []) {
        if (typeof entry !== 'string') throw new TypeError('codeTreeHash: extraExclude entries must be strings');
        const clean = entry.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
        if (clean && clean !== '.') extras.push(clean);
    }
    const snapshot = treeSnapshot(root);
    if (!snapshot.ok) return { ok: false, reason: snapshot.reason };
    // Code files inside the excluded docs folders stay in the hash (wave 1 security M1): a test can
    // `require` a helper that lives under docs/.output/, and editing it after the seal must change the hash.
    // A wave only edits prose and data there after its gate (.md, .json), never these extensions.
    const exclude = (rel) => (CODE_HASH_EXCLUDED_DIRS.some(dir => rel.startsWith(dir)) && !CODE_FILE_IN_DOCS.test(rel))
        || CODE_HASH_EXCLUDED_TODO.test(rel)
        || extras.some(extra => rel === extra || rel.startsWith(`${extra}/`));
    return { ok: true, hash: hashTreeEntries(snapshot.entries, { exclude }) };
}

function headSha(root) {
    const out = gitRun(root, ['rev-parse', 'HEAD']);
    const sha = out === null ? '' : out.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

const receiptPath = (root) => path.join(getTelemetryDir(root), 'gate-receipt.json');
const historyDir = (root) => path.join(getTelemetryDir(root), 'gate-receipts');
const historyFile = (root, name) => {
    const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);
    return path.join(historyDir(root), `${safe}-${sha256(String(name)).slice(0, 8)}.json`);
};

function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readReceipt(root) {
    const receipt = readJson(receiptPath(root));
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
}

// ── By-id archive (SF-2.5) ──────────────────────────────────────────
//
// gate-receipt.json holds only the latest run, and the history rows exist only for a project or build with a known
// closure, so a checkpoint naming a receipt two gate runs old could not be resolved. Every receipt is therefore also
// archived as gate-receipts/by-id/{id}.json (history files all end in a name hash + .json directly under
// gate-receipts/, so the subfolder never reads as history). The archive is evidence for story-checkpoint only; a
// failure here must never change the gate's verdict, and nothing here is ever read through a symlink.

const archiveDir = (root) => path.join(historyDir(root), 'by-id');
const failedArchiveDir = (root) => path.join(archiveDir(root), 'failed');
const archiveFile = (root, id) => path.join(archiveDir(root), `${id}.json`);
const failedArchiveFile = (root, id) => path.join(failedArchiveDir(root), `${id}.json`);
const isArchiveId = (id) => typeof id === 'string' && ARCHIVE_ID.test(id);

/**
 * A receipt belongs in the passing ring only when it is a plain passing run: status passed, exit 0, not change-scoped and
 * not filtered. Everything else (failed, running, interrupted, filtered, change-scoped) goes to the failure ring, so the
 * frequent partial runs of a long wave never evict an earlier wave's passing receipt. story-checkpoint still applies the
 * full complete-pass rules to whatever it reads from either ring.
 */
function isPlainPass(receipt) {
    return receipt.status === 'passed' && receipt.exitCode === 0 && receipt.changedOnly !== true && !receipt.filter;
}

/** Write `${file}` atomically without following a symlink at the temp or the final path. */
function writeArchiveFile(file, text) {
    const leaf = fs.lstatSync(file, { throwIfNoEntry: false });
    if (leaf && !leaf.isFile()) throw new Error(`refusing to replace ${path.basename(file)}: it is not a regular file`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    try {
        fs.writeFileSync(tmp, text, { flag: 'wx' });
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw error;
    }
}

/** Keep the newest `cap` regular .json files (by mtime); `keepName` is never pruned. Symlinks are never touched. */
function pruneArchive(dir, keepName, cap) {
    const rows = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const stat = fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false });
        if (stat && stat.isFile()) rows.push({ name, mtime: stat.mtimeMs });
    }
    if (rows.length <= cap) return;
    rows.sort((a, b) => (b.mtime - a.mtime) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    const keep = new Set(rows.slice(0, cap).map(r => r.name));
    keep.add(keepName);
    for (const row of rows) {
        if (keep.has(row.name)) continue;
        try { fs.unlinkSync(path.join(dir, row.name)); } catch { /* best effort */ }
    }
}

function archiveReceipt(root, receipt) {
    if (!receipt || typeof receipt !== 'object' || !isArchiveId(receipt.id)) return;
    const plain = isPlainPass(receipt);
    const dir = plain ? archiveDir(root) : failedArchiveDir(root);
    const target = plain ? archiveFile(root, receipt.id) : failedArchiveFile(root, receipt.id);
    const other = plain ? failedArchiveFile(root, receipt.id) : archiveFile(root, receipt.id);
    fs.mkdirSync(dir, { recursive: true });
    assertNoSymlinkedAncestor(target, historyDir(root));
    writeArchiveFile(target, JSON.stringify(receipt, null, 2));
    // The gate rewrites one id as its run progresses (running, then passed): the other ring must not keep a superseded copy.
    try {
        assertNoSymlinkedAncestor(other, historyDir(root));
        const stale = fs.lstatSync(other, { throwIfNoEntry: false });
        if (stale && stale.isFile()) fs.unlinkSync(other);
    } catch { /* best effort: archivedReceipt reads the passing ring first, story-checkpoint also judges the current receipt first */ }
    pruneArchive(dir, `${receipt.id}.json`, plain ? ARCHIVE_CAP : ARCHIVE_FAILED_CAP);
}

/** True when this project's gate has ever written a by-id archive (the folder exists as a real directory). */
function hasArchive(root) {
    try {
        const dir = archiveDir(root);
        assertNoSymlinkedAncestor(dir, historyDir(root));
        const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
        return Boolean(stat && stat.isDirectory());
    } catch { return false; }
}

function readArchiveFile(root, file, id) {
    try {
        assertNoSymlinkedAncestor(file, historyDir(root));
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (!stat || !stat.isFile() || stat.size > ARCHIVE_MAX_BYTES) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) && data.id === id ? data : null;
    } catch { return null; }
}

/**
 * The archived receipt with this id (the passing ring, then the failure ring), or null: an invalid id, no file, a
 * symlinked file or folder, a file that is not a regular file or is over the size cap, JSON that is not an object, or a
 * file whose own `id` is another id.
 */
function archivedReceipt(root, id) {
    if (!isArchiveId(id)) return null;
    return readArchiveFile(root, archiveFile(root, id), id) || readArchiveFile(root, failedArchiveFile(root, id), id);
}

/**
 * Write the current receipt, then archive it by id. The archive is best effort and never throws or changes the result,
 * but a failed archive write is not silent: one stderr line says the receipt cannot be found by id later, so a checkpoint
 * that names it will rerun.
 */
function writeReceipt(root, receipt) {
    writeJsonAtomic(receiptPath(root), receipt);
    try {
        archiveReceipt(root, receipt);
    } catch (error) {
        const id = receipt && typeof receipt === 'object' && typeof receipt.id === 'string' ? receipt.id.slice(0, 64) : '?';
        try { process.stderr.write(`[gate-receipt] warning: receipt ${id} was not archived by id (${String(error && error.message).replace(/[\r\n]+/g, ' ').slice(0, 160)}); a story checkpoint naming it will rerun\n`); } catch { /* a closed stderr must not fail the gate */ }
    }
}

/** A project's (or the build's) history records; unreadable history is empty, which means RUN. */
function readHistory(root, name) {
    const data = readJson(historyFile(root, name));
    return data && Array.isArray(data.records) ? data.records : [];
}
function writeHistory(root, name, records) { writeJsonAtomic(historyFile(root, name), { schema: RECEIPT_SCHEMA, name, records }); }

const BUILD_HISTORY = '(build)';

/**
 * The test runner's packages: vitest and vite (vitest's host, a peer dependency) plus the transitive
 * runtime `dependencies` of both. The gate executes this code and believes what it reports, but the
 * code hash never covers it (`node_modules/` is ignored), so a patched reporter makes every test pass
 * and leaves no trace in any diff.
 */
const RUNNER_SEEDS = Object.freeze(['vitest', 'vite']);
/** Executable and manifest files only: native bindings and type declarations are not what reports a verdict. */
const RUNNER_FILE = /\.(?:[cm]?js|json|node|wasm)$/;
const RUNNER_MAX_PACKAGES = 500;
/** Digest used when no runner package is installed (an adopter on another runner): stable, so it never flips a receipt. */
const NO_RUNNER = 'no-vitest-runner';

/** Feed every file of one installed package into `hash`, in sorted order, skipping nested `node_modules`. */
function hashPackageFiles(hash, dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.bin') continue;
        const child = path.join(dir, entry.name);
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) hashPackageFiles(hash, child, childRel);
        else if (entry.isSymbolicLink()) hash.update(`link\0${childRel}\0${fs.readlinkSync(child)}\0`);
        else if (entry.isFile() && RUNNER_FILE.test(entry.name)) {
            const bytes = fs.readFileSync(child);
            hash.update(`file\0${childRel}\0${bytes.length}\0`);
            hash.update(bytes);
        }
    }
}

/**
 * sha256 of the installed test runner (see RUNNER_SEEDS): each package's name, version and files.
 * A runner changed after a receipt was written changes the engine identity, so the receipt is stale.
 * Returns null when a runner file cannot be read (an unknown is never a pass) and the fixed
 * NO_RUNNER marker when no runner package is installed at all. Called once per gate run (the
 * receipt's engine field is computed when the receipt starts), never per project.
 *
 * Limit, stated: this detects a runner that changed after the receipt, or a receipt written by a
 * different runner. A patch applied before the first gate run is the baseline, not a change; the
 * wall on `node_modules/` (`subagentReadOnlyPaths`) is what keeps a subagent from writing it.
 */
function runnerIdentity(root) {
    const modules = path.join(root, 'node_modules');
    const hash = crypto.createHash('sha256');
    const seen = new Set();
    const queue = [...RUNNER_SEEDS.map((name) => ({ name, from: modules }))];
    let found = 0;
    try {
        while (queue.length) {
            const { name, from } = queue.shift();
            if (seen.has(name)) continue;
            seen.add(name);
            if (seen.size > RUNNER_MAX_PACKAGES) return null;
            const dir = [path.join(from, name), path.join(modules, name)].find((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
            if (!dir) { hash.update(`missing\0${name}\0`); continue; }
            found += 1;
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            hash.update(`package\0${name}\0${typeof manifest.version === 'string' ? manifest.version : ''}\0`);
            hashPackageFiles(hash, dir, name);
            for (const dep of Object.keys(manifest.dependencies || {}).sort()) queue.push({ name: dep, from: path.join(dir, 'node_modules') });
        }
    } catch { return null; }
    return found === 0 ? NO_RUNNER : hash.digest('hex');
}

const LOCAL_REQUIRE = /\brequire\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;

/**
 * Every module that can decide a verdict: gate.js and, transitively, each module it requires by a relative path (found by
 * reading the sources, so a lazily required one such as the owned-process-tree bridge is included). Returns
 * Map<path, bytes>; throws when a file that exists cannot be read.
 */
function gateModuleClosure(coreDir) {
    const modules = new Map();
    const queue = [path.join(coreDir, 'gate.js'), path.join(coreDir, '_lib', 'gate-receipt.js')];
    while (queue.length) {
        const file = queue.shift();
        if (modules.has(file)) continue;
        const bytes = fs.readFileSync(file);
        modules.set(file, bytes);
        for (const m of bytes.toString('utf8').matchAll(LOCAL_REQUIRE)) {
            const target = path.resolve(path.dirname(file), m[2]);
            const found = [target, `${target}.js`, `${target}.cjs`, path.join(target, 'index.js')].find((candidate) => {
                try { return fs.statSync(candidate).isFile(); } catch { return false; }
            });
            if (found) queue.push(found);
        }
    }
    return modules;
}

/** sha256 of the gate engine (gate.js and every module it requires), the toolkit version and the installed test runner. */
function engineIdentity(root, coreDir = CORE_DIR) {
    let modules;
    try { modules = gateModuleClosure(coreDir); } catch { return null; }
    const engine = crypto.createHash('sha256');
    for (const file of [...modules.keys()].sort()) {
        const bytes = modules.get(file);
        engine.update(`${toPosix(path.relative(coreDir, file))}\0${bytes.length}\0`);
        engine.update(bytes);
    }
    let version = 'unknown';
    for (const rel of ['.claude/version.json', '.codex/version.json', '.agents/version.json']) {
        const data = readJson(path.join(root, rel));
        if (data && typeof data.version === 'string') { version = data.version; break; }
    }
    const runner = runnerIdentity(root);
    if (runner === null) return null;
    return sha256(engine.digest('hex'), '\0', version, '\0', runner);
}

const GATE_CONFIG_REL = path.join('.claude', 'gate.config.json');

/**
 * The explicit gate config (no auto-detection) and the hash of its exact bytes. A file that is present but is not a JSON
 * object reads as `config: {}` with `parseError` set, so a caller that enforces a rule can tell "not configured" from "damaged".
 */
function readGateConfigFile(root) {
    const file = path.join(root, GATE_CONFIG_REL);
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { return { config: {}, hash: sha256('no gate config'), present: false, parseError: null }; }
    let config = {}; let parseError = null;
    try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
        else parseError = 'the top level is not a JSON object';
    } catch (error) { parseError = String(error && error.message).replace(/[\r\n]+/g, ' ').slice(0, 160); /* the hash still covers the bytes */ }
    return { config, hash: sha256(bytes), present: true, parseError };
}

/**
 * The working-tree paths that differ from HEAD (staged, unstaged and untracked-not-ignored), minus the gitignored
 * state folder. The receipt describes the working tree, but a PR carries only commits, so a PR check needs this to be empty.
 *
 * @returns {{ok:true, paths:string[]} | {ok:false, reason:string}}
 */
function workingTreeChanges(root) {
    const status = gitRun(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status === null) return { ok: false, reason: 'git status failed' };
    const paths = [];
    const fields = status.split('\0');
    for (let i = 0; i < fields.length; i++) {
        const m = fields[i].match(/^(.)(.) ([\s\S]*)$/);
        if (!m) { if (fields[i]) return { ok: false, reason: 'unreadable git status entry' }; continue; }
        if (!m[3].startsWith(STATE_PREFIX)) paths.push(m[3]);
        if (m[1] === 'R' || m[1] === 'C' || m[2] === 'R' || m[2] === 'C') i += 1;
    }
    return { ok: true, paths };
}

/**
 * Verify the latest receipt for `root` against the current tree. Never takes the lock, never builds.
 *
 * @returns {{ok:boolean, reasons:{check:string,message:string}[], receipt:object|null}}
 */
function verifyReceiptForRoot({ root, mode = 'normal' }) {
    const receipt = readReceipt(root);
    if (!receipt) {
        return { ok: false, receipt: null, reasons: [{ check: 'receipt', message: `no gate receipt at ${path.relative(root, receiptPath(root)).replace(/\\/g, '/')}` }] };
    }
    const snapshot = treeSnapshot(root);
    const { config, hash } = readGateConfigFile(root);
    const filter = config.test && typeof config.test.filter === 'string' ? config.test.filter : null;
    const { projects } = normalizeProjects(config.test, filter);
    const result = evaluateReceipt({
        receipt, mode, projectNames: projects.map(p => p.name),
        current: { treeHash: snapshot.ok ? snapshot.hash : null, head: headSha(root), engine: engineIdentity(root), configHash: hash },
    });
    if (!snapshot.ok) result.reasons.unshift({ check: 'treeHash', message: `could not compute the tree hash: ${snapshot.reason}` });
    return { ok: result.ok, reasons: result.reasons, receipt };
}

/**
 * Judge an already-read receipt against a CODE tree instead of the whole tree: everything `verifyReceiptForRoot`
 * checks (status, exit code, schema, HEAD, engine, config hash, change scope, build, projects) except the
 * whole-tree hash, plus a passed test leg and `receipt.codeHash === codeHash`. A wave edits its TODO, plan and review
 * reports after the gate, so the whole-tree hash can never match at commit time; `codeHash` (gate end, written by
 * gate.js) is the part that does. A receipt with no `codeHash` (written by an older gate) is refused. The caller owns
 * reading the receipt (ship-check reads it with its symlink posture) and computing `codeHash`.
 *
 * @param {{root:string, receipt:object|null, codeHash:string, mode?:string}} args
 * @returns {{ok:boolean, reasons:{check:string,message:string}[]}}
 */
function verifyReceiptEvidence({ root, receipt, codeHash, mode = 'normal' }) {
    const { config, hash } = readGateConfigFile(root);
    const filter = config.test && typeof config.test.filter === 'string' ? config.test.filter : null;
    const { projects } = normalizeProjects(config.test, filter);
    const result = evaluateReceipt({
        receipt, mode, projectNames: projects.map(p => p.name), ignoreCurrentTree: true,
        current: { treeHash: null, head: headSha(root), engine: engineIdentity(root), configHash: hash },
    });
    const reasons = result.reasons;
    if (receipt && typeof receipt === 'object' && receipt.schema === RECEIPT_SCHEMA) {
        if (!receipt.test || receipt.test.status === undefined) reasons.push({ check: 'test', message: 'the receipt has no test leg (a build-only or non-test run is not test evidence)' });
        if (typeof receipt.codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.codeHash)) {
            reasons.push({ check: 'codeHash', message: 'the receipt carries no code hash (written by an older gate: run the gate again)' });
        } else if (typeof codeHash !== 'string' || receipt.codeHash !== codeHash) {
            reasons.push({ check: 'codeHash', message: `code hash: the receipt covers ${short(receipt.codeHash)} but the code is ${short(codeHash)} (code was edited, added or removed since the gate ran)` });
        }
    }
    return { ok: reasons.length === 0, reasons };
}

/**
 * The PR helper's gate check. `required` follows `receipts.requireFullForPr`; when it is not set the check passes without
 * looking. A control the owner turned on never switches off by accident: a gate config that is present but unparseable, or
 * a `requireFullForPr` that is not a boolean, counts as required, with a warning. Because a PR carries commits and the
 * receipt describes the working tree, the tree must also be clean (nothing staged, modified or untracked outside
 * `docs/.output/.state/`); otherwise a file the receipt proved could be missing from the pushed commit.
 *
 * @returns {{required:boolean, ok:boolean, reasons:{check:string,message:string}[], warnings?:string[]}}
 */
function checkReceiptForPr({ root }) {
    const { config, parseError } = readGateConfigFile(root);
    const settings = receiptsConfig(config);
    const warnings = settings.warnings.slice();
    let required = settings.requireFullForPr;
    if (parseError) {
        required = true;
        warnings.push(`${GATE_CONFIG_REL.replace(/\\/g, '/')} is present but unreadable (${parseError}); treating receipts.requireFullForPr as true until it is fixed`);
    } else if (settings.requireFullForPrInvalid) {
        required = true;
        warnings.push('receipts.requireFullForPr is not a true/false value; treating it as true until it is fixed');
    }
    const withWarnings = (result) => (warnings.length ? { ...result, warnings } : result);
    if (!required) return withWarnings({ required: false, ok: true, reasons: [] });
    const verdict = verifyReceiptForRoot({ root, mode: 'full' });
    const reasons = verdict.reasons.slice();
    const changes = workingTreeChanges(root);
    if (!changes.ok) reasons.push({ check: 'cleanTree', message: `could not read the working tree state: ${changes.reason}` });
    else if (changes.paths.length) {
        const shown = changes.paths.slice(0, 5).join(', ');
        reasons.push({
            check: 'cleanTree',
            message: `working tree has uncommitted changes: the receipt does not describe the commit that would be pushed (${changes.paths.length} path(s): ${shown}${changes.paths.length > 5 ? ', ...' : ''})`,
        });
    }
    return withWarnings({ required: true, ok: reasons.length === 0, reasons });
}

/** The command that produces a passing receipt, for the runtime that is asking. */
function fixCommand(env = process.env) {
    return `node ${env.AGENTS_RUNTIME === 'codex' ? '.codex' : '.claude'}/core/gate.js full test`;
}

module.exports = {
    RECEIPT_SCHEMA, HISTORY_CAP, DEFAULT_RECEIPTS, STATE_PREFIX, BUILD_HISTORY, fixCommand, USAGE,
    parseGateArgs, receiptsConfig, normalizeProjects, scanStaticReads,
    dotnetClosure, projectClosure, buildClosure, declaredInputFiles, globToRegExp, solutionProjectPaths,
    decideReuse, appendRecord, bumpReuse, evaluateReceipt, hashFiles,
    treeSnapshot, hashTreeEntries, codeTreeHash, isCodeHashExcluded, isUnderExcludedDocs, CODE_FILE_IN_DOCS, headSha, receiptPath, historyDir, readReceipt, writeReceipt, archivedReceipt, hasArchive, readHistory, writeHistory,
    engineIdentity, runnerIdentity, NO_RUNNER, readGateConfigFile, verifyReceiptForRoot, verifyReceiptEvidence, checkReceiptForPr, workingTreeChanges, buildTargets, short,
};
