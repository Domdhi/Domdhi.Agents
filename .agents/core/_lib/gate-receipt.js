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
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getTelemetryDir } = require('./telemetry-paths');
const { sameRealDir } = require('./fs-safe');

const RECEIPT_SCHEMA = 1;
const HISTORY_CAP = 200;
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

/** The receipts settings with defaults; a malformed value falls back to its default and is reported. */
function receiptsConfig(config) {
    const raw = config && typeof config.receipts === 'object' && config.receipts !== null && !Array.isArray(config.receipts) ? config.receipts : {};
    const warnings = [];
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
    const addFile = (p) => files.set(p, entries.get(p).blob);
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
                if (!files.has(found)) { addFile(found); fileQueue.push(found); }
                continue;
            }
            if (!PATH_ITEMS.has(name)) continue;
            for (const key of ['include', 'update']) {
                if (a[key] === undefined) continue;
                const r = resolveRef(a[key], baseDir, projectDir);
                if (r.unknown) return `${file}: ${m[1]} ${key} ${r.unknown}`;
                // Items inside the project directory are covered by the directory contents.
                const inside = projectDir === '' || r.path === projectDir || r.path.startsWith(`${projectDir}/`);
                if (inside) continue;
                if (r.wildcard) return `${file}: ${m[1]} ${key} ${a[key]} is a wildcard outside the project directory`;
                const found = lookup(r.path);
                if (found) addFile(found);
                else if (a.condition !== undefined) files.set(r.path, 'ABSENT');
                else return `${file}: ${m[1]} ${key} ${a[key]} is outside the project directory and not in the tree`;
            }
        }
        return null;
    };

    while (projectQueue.length) {
        const file = projectQueue.shift();
        const projectDir = dirOf(file);
        dirs.add(projectDir);
        addFile(file);
        const failure = scanFile(file, projectDir);
        if (failure) return { known: false, reason: failure };
    }
    while (fileQueue.length) {
        const file = fileQueue.shift();
        const failure = scanFile(file, dirOf(file));
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
        // The configuration chain MSBuild/NuGet discovers by walking up from each project directory.
        let walk = dir;
        for (;;) {
            for (const candidate of ANCESTOR_FILES) {
                const target = walk === '' ? candidate : `${walk}/${candidate}`;
                const found = lookup(target);
                if (found) files.set(found, entries.get(found).blob);
                else files.set(target, 'ABSENT');
            }
            if (walk === '') break;
            walk = dirOf(walk);
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
    const metaText = JSON.stringify([meta.engine, meta.configHash, meta.filter, meta.mode, project.display]);
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

/**
 * The closure of the build: the union of every project's closure, the root solution(s) and the
 * build command. When a root solution exists, every project in it joins the closure (a build
 * builds the solution, not only the tested projects); one that cannot be resolved makes the
 * whole closure unknown, so the build runs.
 */
function buildClosure({ projectClosures, snapshot, readText, meta, buildDisplay }) {
    const files = new Map();
    for (const closure of projectClosures) {
        if (!closure.known) return { known: false, reason: 'a project closure is unknown' };
        if (closure.files === null) return { known: true, hash: sha256('tree\0', snapshot.hash, '\0', JSON.stringify([meta.engine, meta.configHash, meta.mode, buildDisplay])), files: null };
        for (const [file, blob] of closure.files) files.set(file, blob);
    }
    for (const [file, { blob }] of snapshot.entries) {
        if (file.includes('/') || !/\.(?:sln|slnx)$/i.test(file)) continue;
        files.set(file, blob);
        const text = readText(file);
        if (text === null || text === undefined) return { known: false, reason: `could not read ${file}` };
        for (const projectPath of solutionProjectPaths(text, file)) {
            const closure = dotnetClosure({ entries: snapshot.entries, readText, projectPath });
            if (!closure.known) return { known: false, reason: `solution project ${projectPath}: ${closure.reason}` };
            for (const [f, b] of closure.files) files.set(f, b);
        }
    }
    return { known: true, hash: hashFiles(files, JSON.stringify([meta.engine, meta.configHash, meta.mode, buildDisplay, 'build'])), files };
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
function evaluateReceipt({ receipt, current, mode, projectNames }) {
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
    if (!current.treeHash) fail('treeHash', 'the current tree hash could not be computed');
    else if (receipt.treeHashStart && receipt.treeHashStart !== current.treeHash) {
        fail('treeHash', `tree hash: the receipt covers ${short(receipt.treeHashStart)} but the tree is now ${short(current.treeHash)} (files were edited, added or removed since the gate ran)`);
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
    const lines = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, e]) => `${e.mode} ${e.blob}\t${file}\n`);
    return { ok: true, hash: sha256(lines.join('')), entries };
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
function writeReceipt(root, receipt) { writeJsonAtomic(receiptPath(root), receipt); }

/** A project's (or the build's) history records; unreadable history is empty, which means RUN. */
function readHistory(root, name) {
    const data = readJson(historyFile(root, name));
    return data && Array.isArray(data.records) ? data.records : [];
}
function writeHistory(root, name, records) { writeJsonAtomic(historyFile(root, name), { schema: RECEIPT_SCHEMA, name, records }); }

const BUILD_HISTORY = '(build)';

/** sha256 of the gate engine (gate.js + this module) and the toolkit version. */
function engineIdentity(root, coreDir = CORE_DIR) {
    let gate; let self;
    try { gate = fs.readFileSync(path.join(coreDir, 'gate.js')); self = fs.readFileSync(path.join(coreDir, '_lib', 'gate-receipt.js')); } catch { return null; }
    let version = 'unknown';
    for (const rel of ['.claude/version.json', '.codex/version.json', '.agents/version.json']) {
        const data = readJson(path.join(root, rel));
        if (data && typeof data.version === 'string') { version = data.version; break; }
    }
    return sha256(gate, '\0', self, '\0', version);
}

const GATE_CONFIG_REL = path.join('.claude', 'gate.config.json');

/** The explicit gate config (no auto-detection) and the hash of its exact bytes. */
function readGateConfigFile(root) {
    const file = path.join(root, GATE_CONFIG_REL);
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { return { config: {}, hash: sha256('no gate config'), present: false }; }
    let config = {};
    try { const parsed = JSON.parse(bytes.toString('utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed; } catch { /* hash still covers the bytes */ }
    return { config, hash: sha256(bytes), present: true };
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
 * The PR helper's gate check. `required` follows `receipts.requireFullForPr`; when it is not
 * set the check passes without looking.
 */
function checkReceiptForPr({ root }) {
    const { config } = readGateConfigFile(root);
    const settings = receiptsConfig(config);
    if (!settings.requireFullForPr) return { required: false, ok: true, reasons: [] };
    const verdict = verifyReceiptForRoot({ root, mode: 'full' });
    return { required: true, ok: verdict.ok, reasons: verdict.reasons };
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
    treeSnapshot, headSha, receiptPath, historyDir, readReceipt, writeReceipt, readHistory, writeHistory,
    engineIdentity, readGateConfigFile, verifyReceiptForRoot, checkReceiptForPr, short,
};
