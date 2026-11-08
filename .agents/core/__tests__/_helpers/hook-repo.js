/**
 * hook-repo — temp git repositories wired to THIS toolkit's scanner, for the managed-git-hook tests.
 * CommonJS (not ESM) — loaded via createRequire() bridge in test files.
 *
 * The managed hooks run `<repo root>/.agents/hooks/secret-scanner.cjs`, so a test repository needs a
 * `.agents` that holds the scanner. It is a link to the toolkit's own `.agents` (excluded from the repo
 * through .git/info/exclude, so it never shows as untracked), which keeps the real scanner and the real
 * engine under test without copying the tree.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createGitRepo } = require('./git-fixture');

const TOOLKIT_AGENTS = path.resolve(__dirname, '..', '..', '..');
const GIT_HOOKS = path.join(TOOLKIT_AGENTS, 'core', 'git-hooks.js');
const COMMIT_JS = path.join(TOOLKIT_AGENTS, 'core', 'commit.js');

// Test key fixtures, built from parts so no matchable literal sits in a source file.
const CG_KEY = 'CG-' + 'abcDEF123456ghiJKL789mn';
const AWS_KEY = 'AKIA' + 'QW3ERTY7UIOP' + 'AS2D';

/** An environment for a spawned git/node: no GIT_* leakage, telemetry confined to `repoPath`. */
function cleanEnv(repoPath, extra = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^GIT_/i.test(key) || /^(CLAUDE_COMMIT_NO_SCAN|AGENTS_SCAN_BYPASS_RECORDED|AGENTS_GIT_HOOK_ROOT|AGENT_SHARED_STATE_ROOT|AGENTS_PROJECT_DIR|AGENT_SOURCE_ROOT|CODEX_PROJECT_DIR)$/.test(key)) delete env[key];
    }
    return { ...env, CLAUDE_PROJECT_DIR: repoPath, ...extra };
}

/** Run git in `cwd`; never throws. */
function git(cwd, args, { env = {}, input } = {}) {
    const r = spawnSync('git', args, { cwd, env: cleanEnv(cwd, env), encoding: 'utf8', windowsHide: true, input });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: `${r.stdout || ''}${r.stderr || ''}` };
}

function gitOut(cwd, args) {
    return execFileSync('git', args, { cwd, env: cleanEnv(cwd), encoding: 'utf8', windowsHide: true }).trim();
}

function excludeToolkitLink(repoPath) {
    const common = path.resolve(repoPath, gitOut(repoPath, ['rev-parse', '--git-common-dir']));
    const file = path.join(common, 'info', 'exclude');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, '/.agents\n');
}

/** Link the toolkit's `.agents` into a work tree (the main one or a linked worktree). */
function linkToolkit(workTree) {
    fs.symlinkSync(TOOLKIT_AGENTS, path.join(workTree, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
}

/** A repository with one commit, `.agents` linked to the toolkit, and NO hooks installed. */
function createHookRepo(root) {
    const repo = createGitRepo({ root });
    excludeToolkitLink(repo.repoPath);
    linkToolkit(repo.repoPath);
    return repo.repoPath;
}

/** Stage a blob under an arbitrary path name (even `0:README`, `:README`) without letting git parse it as a pathspec. */
function stageBlob(repoPath, rel, content) {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repoPath, input: content, env: cleanEnv(repoPath), encoding: 'utf8', windowsHide: true }).trim();
    return git(repoPath, ['update-index', '--add', '--cacheinfo', `100644,${sha},${rel}`]);
}

function stage(repoPath, rel, content) {
    const file = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return git(repoPath, ['add', '--', rel]);
}

function writeMessage(dir, text, name = 'MSG') {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
}

function commitCount(repoPath) {
    try { return Number(gitOut(repoPath, ['rev-list', '--count', 'HEAD'])); } catch { return 0; }
}

/** The guardrail events written under the project (telemetry is confined by CLAUDE_PROJECT_DIR). */
function guardrailEvents(repoPath) {
    const rel = fs.readdirSync(repoPath, { recursive: true }).map(String).find(f => f.endsWith('guardrail-events.jsonl'));
    if (!rel) return [];
    return fs.readFileSync(path.join(repoPath, rel), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

/** Run commit.js in `repoPath` with an explicit message file. */
function runCommitJs(repoPath, msgFile, extraArgs = [], env = {}) {
    const r = spawnSync(process.execPath, [COMMIT_JS, '--file', msgFile, ...extraArgs], {
        cwd: repoPath, env: cleanEnv(repoPath, env), encoding: 'utf8', windowsHide: true,
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Run the git-hooks CLI. */
function runGitHooksCli(args, cwd, env = {}) {
    const r = spawnSync(process.execPath, [GIT_HOOKS, ...args], { cwd, env: cleanEnv(cwd, env), encoding: 'utf8', windowsHide: true });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** A bare repository to push to, registered as `origin` of `repoPath`. */
function addRemote(repoPath, root) {
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: cleanEnv(repoPath), windowsHide: true });
    git(repoPath, ['remote', 'add', 'origin', remote]);
    return remote;
}

/** Replace the repo's `.agents` link with a directory holding only the given scanner script (an "other" toolkit). */
function useScanner(repoPath, root, scriptText, name = 'other-toolkit') {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'secret-scanner.cjs'), scriptText);
    const link = path.join(repoPath, '.agents');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    return dir;
}

// ── binary fixtures ──────────────────────────────────────────────────────────────────────────────

const crc32Table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = crc32Table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** A deterministic pseudo-random byte string (not text, no NUL-free guarantee: it is meant to look like compressed data). */
function noise(bytes, seed = 1) {
    const out = Buffer.alloc(bytes);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < bytes; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
    return out;
}

/** A stored (uncompressed) zip with the given entries { name: Buffer|string }: what an .xlsx/.docx is, minus the deflate. */
function makeZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, data] of Object.entries(entries)) {
        const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const nameBuf = Buffer.from(name);
        const crc = crc32(body);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBuf.length, 26);
        parts.push(local, nameBuf, body);
        const head = Buffer.alloc(46);
        head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt32LE(crc, 16);
        head.writeUInt32LE(body.length, 20); head.writeUInt32LE(body.length, 24); head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
        central.push(head, nameBuf);
        offset += 30 + nameBuf.length + body.length;
    }
    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, centralBuf, end]);
}

/** An OOXML spreadsheet-shaped zip (the engine refuses these as binary): `text` lands in a stored sharedStrings entry. */
function makeXlsxLike({ text = 'budget template', padBytes = 150000, seed = 1 } = {}) {
    return makeZip({
        '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>',
        'xl/media/image1.bin': noise(padBytes, seed),   // before the text, so the first bytes of the file already look compressed
        'xl/sharedStrings.xml': `<sst>${text}</sst>`,
    });
}

/** A PNG-shaped file: signature, IHDR, a tEXt chunk carrying `text`, noise standing for the pixel data. */
function makePng({ text = 'a screenshot', padBytes = 60000, seed = 2 } = {}) {
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); };
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13, 1)), chunk('tEXt', Buffer.from(`Comment\0${text}`)), chunk('IDAT', noise(padBytes, seed)), chunk('IEND', Buffer.alloc(0))]);
}

/** A PDF-shaped file: header, an object holding `text` as a literal string, a binary stream. */
function makePdf({ text = 'a document', padBytes = 60000, seed = 3 } = {}) {
    return Buffer.concat([Buffer.from(`%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Title (${text}) >>\nendobj\n2 0 obj\n<< /Length ${padBytes} >>\nstream\n`, 'latin1'), noise(padBytes, seed), Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
}

/**
 * Import commits through `git fast-import` (no hooks run). Each commit is { message, files: { path: Buffer|string } }
 * on top of `from` (a commit id, default HEAD) on `branch`. Returns the new tip.
 */
function fastImport(repoPath, commits, { branch = 'imported', from = null } = {}) {
    const chunks = [];
    const base = from || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, env: cleanEnv(repoPath), encoding: 'utf8', windowsHide: true }).trim();
    commits.forEach((c, i) => {
        const msg = Buffer.from(c.message || `commit ${i + 1}\n`);
        chunks.push(Buffer.from(`commit refs/heads/${branch}\nmark :${i + 1}\ncommitter T <t@example.invalid> ${1700000000 + i} +0000\ndata ${msg.length}\n`), msg, Buffer.from(`\nfrom ${i === 0 ? base : `:${i}`}\n`));
        for (const [name, content] of Object.entries(c.files || {})) {
            const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
            chunks.push(Buffer.from(`M 100644 inline ${name}\ndata ${body.length}\n`), body, Buffer.from('\n'));
        }
    });
    const r = spawnSync('git', ['fast-import', '--quiet'], { cwd: repoPath, input: Buffer.concat(chunks), env: cleanEnv(repoPath), windowsHide: true, maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`fast-import failed: ${r.stderr}`);
    return execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: repoPath, env: cleanEnv(repoPath), encoding: 'utf8', windowsHide: true }).trim();
}

module.exports = {
    noise, makeZip, makeXlsxLike, makePng, makePdf, fastImport,
    TOOLKIT_AGENTS, GIT_HOOKS, COMMIT_JS, CG_KEY, AWS_KEY,
    cleanEnv, git, gitOut, linkToolkit, createHookRepo, stage, stageBlob, addRemote, useScanner, writeMessage, commitCount, guardrailEvents,
    runCommitJs, runGitHooksCli,
};
