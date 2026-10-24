// windows-hide-guard (NA5.14) — every child process the toolkit starts must pass
// windowsHide. Hook background work is detached on Windows (NA5.12) so it survives
// the hook; a detached child has no console, so any console subprocess it starts
// without windowsHide opens a VISIBLE console window (proved on Windows in the
// Wave 14 review, N1). This source scan keeps the class closed across
// .agents/core/** and .agents/hooks/**.
//
// A call counts when it is a child_process function reached through:
//   - a member call on a binding of require('child_process' | 'node:child_process')
//   - a destructured (optionally renamed) import from that module
//   - a local alias assigned from either (e.g. `const exec = opts.execSync || cp.execSync`)
// It is safe when its argument list sets windowsHide inline, or passes an options
// identifier whose same-file declaration sets it, directly or through a spread of
// another such identifier. A windowsHide that appears only in a comment does not count.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const CP_FUNCS = ['execFileSync', 'execSync', 'spawnSync', 'spawn', 'execFile', 'exec', 'fork'];

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

function balanced(src, openIdx, open = '(', close = ')') {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === open) depth++;
        else if (src[i] === close && --depth === 0) return src.slice(openIdx + 1, i);
    }
    return src.slice(openIdx + 1);
}

/** Split a call's argument text at top-level commas. */
function topLevelArgs(argText) {
    const out = [];
    let depth = 0, start = 0, quote = null;
    for (let i = 0; i < argText.length; i++) {
        const c = argText[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ',' && depth === 0) { out.push(argText.slice(start, i).trim()); start = i + 1; }
    }
    out.push(argText.slice(start).trim());
    return out.filter(Boolean);
}

/** Does identifier `name` resolve, in this file, to an object that sets windowsHide? */
function declarationSetsHide(src, name, depth = 3) {
    if (depth === 0) return false;
    const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`, 'g');
    let m;
    while ((m = re.exec(src))) {
        const body = balanced(src, m.index + m[0].length - 1, '{', '}');
        if (/\bwindowsHide\b/.test(body)) return true;
        for (const s of body.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) if (declarationSetsHide(src, s[1], depth - 1)) return true;
    }
    return false;
}

/**
 * Report every child_process call in `source` that does not pass windowsHide.
 * @returns {Array<{line: number, call: string}>}
 */
function unsafeCalls(source) {
    const src = stripComments(source);
    const cpModules = [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)].map(m => m[1]);
    const names = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)) {
        for (const part of m[1].split(',')) {
            const [orig, alias] = part.split(':').map(s => s.trim());
            if (CP_FUNCS.includes(orig)) names.add(alias || orig);
        }
    }
    const fnAlt = CP_FUNCS.join('|');
    for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;\\n]*\\b(?:${cpModules.map(c => c.replace(/\$/g, '\\$')).join('|') || '__none__'})\\.(?:${fnAlt})\\b`, 'g'))) names.add(m[1]);
    const calls = [];
    const memberRe = cpModules.length ? new RegExp(`\\b(?:${cpModules.map(c => c.replace(/\$/g, '\\$')).join('|')})\\.(${fnAlt})\\s*\\(`, 'g') : null;
    if (memberRe) for (const m of src.matchAll(memberRe)) calls.push({ index: m.index, open: m.index + m[0].length - 1, call: m[0].replace(/\s*\($/, '') });
    // Inline member call on the require itself — the generated compatibility-wrapper shape.
    for (const m of src.matchAll(new RegExp(`require\\(\\s*['"](?:node:)?child_process['"]\\s*\\)\\.(${fnAlt})\\s*\\(`, 'g'))) {
        calls.push({ index: m.index, open: m.index + m[0].length - 1, call: `require('child_process').${m[1]}` });
    }
    if (names.size) {
        const bareRe = new RegExp(`(?<![\\w$.])(${[...names].map(n => n.replace(/\$/g, '\\$')).join('|')})\\s*\\(`, 'g');
        for (const m of src.matchAll(bareRe)) {
            const before = src.slice(Math.max(0, m.index - 40), m.index);
            if (/function\s*$|function\s+$/.test(before)) continue; // a declaration, not a call
            calls.push({ index: m.index, open: m.index + m[0].length - 1, call: m[1] });
        }
    }
    const unsafe = [];
    for (const c of calls) {
        const args = topLevelArgs(balanced(src, c.open));
        const safe = args.some(a => /\bwindowsHide\b/.test(a)
            || (/^[A-Za-z_$][\w$]*$/.test(a) && declarationSetsHide(src, a))
            || (a.startsWith('{') && [...a.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)].some(s => declarationSetsHide(src, s[1]))));
        if (!safe) unsafe.push({ line: src.slice(0, c.index).split('\n').length, call: c.call });
    }
    return unsafe.sort((a, b) => a.line - b.line);
}

function sourceFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...sourceFiles(p)); }
        else if (/\.(c?js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

describe('windowsHide guard analyzer — adversarial fixtures (NA5.14)', () => {
    it('flags a call whose windowsHide appears only in a comment', () => {
        const src = "const cp = require('child_process');\ncp.execSync('git status', { encoding: 'utf8' /* windowsHide: true */ });\ncp.execSync('git log'); // windowsHide";
        expect(unsafeCalls(src)).toEqual([{ line: 2, call: 'cp.execSync' }, { line: 3, call: 'cp.execSync' }]);
    });

    it('flags destructured, renamed and node:-prefixed imports', () => {
        const src = "const { execFileSync, spawnSync: run } = require('node:child_process');\nexecFileSync('git', ['a']);\nrun('node', ['x'], { stdio: 'inherit' });";
        expect(unsafeCalls(src)).toEqual([{ line: 2, call: 'execFileSync' }, { line: 3, call: 'run' }]);
    });

    it('flags a local alias of a child_process function', () => {
        const src = "const childProcess = require('child_process');\nfunction f(o = {}) {\n  const exec = o.execSync || childProcess.execSync;\n  return exec('git rev-parse HEAD', { cwd: '.' });\n}";
        expect(unsafeCalls(src)).toEqual([{ line: 4, call: 'exec' }]);
    });

    it('accepts inline windowsHide, identifier options and spread options', () => {
        const src = [
            "const childProcess = require('child_process');",
            "const BASE = { encoding: 'utf8', windowsHide: true };",
            "childProcess.execSync('a', { windowsHide: true });",
            "const opts = { cwd: '.', ...BASE };",
            "childProcess.execSync('b', opts);",
            "const exec = childProcess.execSync;",
            "exec('c', { ...BASE });",
        ].join('\n');
        expect(unsafeCalls(src)).toEqual([]);
    });

    it('flags identifier options whose declaration never sets windowsHide', () => {
        const src = "const cp = require('child_process');\nconst opts = { cwd: '.' };\ncp.spawnSync('git', ['x'], opts);";
        expect(unsafeCalls(src)).toEqual([{ line: 3, call: 'cp.spawnSync' }]);
    });

    it('flags an inline require member call (the generated-wrapper shape)', () => {
        const src = "const result = require('child_process').spawnSync(process.execPath, [entry], { stdio: 'inherit' });\nrequire('node:child_process').execSync('x', { windowsHide: true });";
        expect(unsafeCalls(src)).toEqual([{ line: 1, call: "require('child_process').spawnSync" }]);
    });

    it('ignores RegExp/db exec and same-named functions that are not child_process', () => {
        const src = "const re = /x/g; re.exec('x');\nconst db = open(); db.exec('BEGIN');\nfunction spawn(a) { return a; }\nspawn(1);";
        expect(unsafeCalls(src)).toEqual([]);
    });
});

describe('windowsHide guard — real tree (NA5.14 / NA5.15)', () => {
    // Canonical sources, runtime adapters (loaded by background children such as the
    // curator, review N3) and the generated compatibility wrappers: hook background
    // children run `.claude/core/*.js` wrappers, whose spawnSync of the canonical
    // entry is itself a console subprocess of a console-less detached parent.
    it('every child_process call in the canonical, adapter and generated core/hook trees passes windowsHide', () => {
        const offenders = [];
        for (const dir of ['.agents/core', '.agents/hooks', '.agents/adapters', '.claude/core', '.claude/hooks', '.codex/core', '.codex/hooks']) {
            for (const file of sourceFiles(path.join(ROOT, dir))) {
                for (const u of unsafeCalls(fs.readFileSync(file, 'utf8'))) {
                    offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${u.line} ${u.call}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
