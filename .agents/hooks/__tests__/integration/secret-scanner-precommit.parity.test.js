// secret-scanner --git-precommit: the staged set is scanned in ONE engine run (`betterleaks dir` over a private
// staging directory). These tests prove that run reports exactly what the one-process-per-file scan reported
// (same findings, file paths, line numbers, redacted matches), and that the batch really is one engine process.
//
// Coverage:
//   - parity over a mixed fixture: named-provider keys, generic matches, test files (named providers only),
//     the allow marker, .betterleaksignore (matching and non-matching fingerprints, comments, CRLF), a staged
//     ignore file (read from the INDEX), a skipped file whose finding is listed in it, non-ASCII and space names,
//     a rename with a new key, archive-signature prefixes, invalid UTF-8, empty and whitespace-only files, a
//     high-risk file name, case-colliding names, a newline in a name, names that read as revisions (`0:x`, `:x`)
//   - the CLI: exit code, hard-skip paths, the unreadable-file classification
//   - one engine process for hundreds of files, and the staging directory is always removed

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../../core/__tests__/_helpers/tmp-dir');
const { createGitRepo, gitAvailable } = require('../../../core/__tests__/_helpers/git-fixture');
const { createFakeEngineKit } = require('../_helpers/fake-engine');
const gitScan = require('../../secret-git-scan.cjs');
const engineBin = require('../../../core/_lib/secret-engine-bin');

const SCANNER_PATH = path.resolve(__dirname, '..', '..', 'secret-scanner.cjs');
const CG = 'CG-' + 'abcDEF123456ghiJKL789mn';
const AWS = 'AKIA' + 'QW3ERTY7UIOP' + 'AS2D';
const PASSWORD = ['Zx9Qm4', 'Lp2Rt7'].join('');
const sh = it.skipIf(!gitAvailable());

let tmp;
let repo;
let saved;
beforeEach(() => {
    tmp = createTmpDir({ prefix: 'precommit-parity-' });
    saved = { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, AGENTS_GIT_HOOK_ROOT: process.env.AGENTS_GIT_HOOK_ROOT };
    if (gitAvailable()) {
        repo = createGitRepo({ root: path.join(tmp.root, 'repo') }).repoPath;
        process.env.CLAUDE_PROJECT_DIR = repo;
        delete process.env.AGENTS_GIT_HOOK_ROOT;
    }
});
afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    tmp.cleanup();
});

const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim();
function stage(rel, content) {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    git('add', '--', rel);
}
// Blobs are read by id (never by path), so a staged name like `0:clean.txt` cannot be read as another file.
function stageBlob(rel, content) {
    const sha = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content, encoding: 'utf8' }).trim();
    git('update-index', '--add', '--cacheinfo', `100644,${sha},${rel}`);
}

function both() {
    const perFile = gitScan.scanStaged(repo, { batch: false });
    const batch = gitScan.scanStaged(repo, { batch: true });
    expect(batch.order).toEqual(perFile.order);
    return { files: batch.order, perFile: perFile.results, batch: batch.results };
}

describe('batch scan parity with the per-file scan', () => {
    sh('reports identical findings (file, line, name, redacted match) over a mixed fixture', () => {
        // A rename that also adds a key (committed first, so only the rename is staged from the seed).
        stage('old.js', 'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\n');
        git('commit', '-q', '-m', 'seed', '--no-verify');
        git('mv', 'old.js', 'renamed.js');
        fs.appendFileSync(path.join(repo, 'renamed.js'), `const k = "${CG}";\n`);
        git('add', 'renamed.js');

        stage('clean.js', 'const x = 1;\nconsole.log(x);\n');
        stage('src/a.js', `const a = 1;\nconst b = 2;\nconst k = "${CG}";\n`);
        stage('src/two.js', `const k1 = "${CG}";\nconst k2 = "${AWS}";\n`);
        stage('test/x.test.js', `const k = "${CG}";\nconst password = "${PASSWORD}";\n`);   // named providers only
        stage('config.js', `const password = "${PASSWORD}";\n`);                           // generic match
        stage('allowed.js', `const password = "${PASSWORD}"; // betterleaks:allow\n`);       // marker-suppressed
        stage('legacy.js', `// old\nconst k = "${CG}";\n`);                                  // ignored by the ignore file
        stage('moved.js', `const k = "${CG}";\n`);                                           // ignore line number is wrong -> still found
        stage('.betterleaksignore', `# reviewed\r\n  legacy.js:domdhi-coingecko-api-key:2  \r\n\r\nmoved.js:domdhi-coingecko-api-key:9\nzipignored.txt:domdhi-coingecko-api-key:2\n`);
        fs.mkdirSync(path.join(repo, 'sub'));
        stage('sub/.betterleaksignore', `moved.js:domdhi-coingecko-api-key:1\n`);            // a nested ignore file ignores nothing
        stage('café notes.md', `token ${CG}\n`);                                          // non-ASCII and a space
        stage('zip.txt', `PK\u0003\u0004 readme\nconst k = "${CG}";\n`);                      // archive signature prefix
        stage('pdf.txt', `%PDF-1.4 text\nconst k = "${AWS}";\n`);
        stage('empty.txt', '');
        stage('blank.txt', '   \n\n');
        stage('crlf.js', `a\r\nconst k = "${CG}";\r\n`);
        fs.writeFileSync(path.join(repo, 'bad-utf8.txt'), Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(`const k = "${CG}";\n`)]));
        git('add', 'bad-utf8.txt');
        stage('.env', 'PLAIN=1\n');                                                           // high-risk file name
        // Windows has case-insensitive file names and forbids a newline in one, so these two cases run on POSIX only.
        if (process.platform !== 'win32') {
            stage('A.js', `const k = "${CG}";\n`);                                           // case-colliding pair
            stage('a.js', `const k = "${AWS}";\n`);
            stage('we\nird.js', `const k = "${CG}";\n`);                                     // newline in the name
        }
        stage('zipignored.txt', `PK\u0003\u0004 readme\nconst k = "${CG}";\n`);          // skipped by the engine; its finding is listed in the ignore file
        stage('.gitleaksignore', 'moved.js:domdhi-coingecko-api-key:1\n');                  // never read
        stage('clean.txt', 'clean\n');
        // Git for Windows refuses a ':' in an index path (core.protectNTFS), so these two run on POSIX only.
        const colonPaths = process.platform !== 'win32';
        if (colonPaths) {
            stageBlob('0:clean.txt', `const k = "${CG}";\n`);                                // reads as stage 0 of clean.txt
            stageBlob(':clean.txt', `const k = "${AWS}";\n`);
        }
        for (let i = 0; i < 25; i++) stage(`bulk/f${i}.js`, `export const n${i} = ${i};\n`);

        const { files, perFile, batch } = both();
        expect(files.length).toBeGreaterThan(30);
        for (const file of files) {
            expect(batch.get(file), file).toEqual(perFile.get(file));
        }
        // The fixture really exercised the interesting outcomes, so equality is not vacuous.
        const names = file => perFile.get(file).findings.map(f => `${f.name}@${f.line}`);
        expect(names('src/a.js')).toEqual(['CoinGecko API Key@3']);
        expect(names('src/two.js')).toHaveLength(2);
        expect(names('test/x.test.js')).toEqual(['CoinGecko API Key@1']);
        expect(names('config.js').length).toBeGreaterThan(0);
        expect(names('allowed.js')).toEqual([]);
        expect(names('legacy.js')).toEqual([]);
        expect(names('moved.js')).toHaveLength(1);
        expect(names('sub/.betterleaksignore')).toEqual([]);
        expect(names('café notes.md')).toHaveLength(1);
        expect(names('zip.txt')).toHaveLength(1);
        // A file the engine skipped is read again behind a newline, where the ignore list does not apply: the
        // finding stays, identically in both scans (the one-file scan and the batch fallback agree).
        expect(names('zipignored.txt')).toHaveLength(1);
        expect(names('.gitleaksignore')).toEqual([]);
        expect(names('clean.txt')).toEqual([]);
        if (colonPaths) {
            expect(names('0:clean.txt')).toEqual(['CoinGecko API Key@1']);
            expect(names(':clean.txt')).toEqual(['AWS Access Key@1']);
        }
        expect(names('pdf.txt')).toHaveLength(1);
        expect(names('crlf.js')).toEqual(['CoinGecko API Key@2']);
        expect(names('bad-utf8.txt')).toHaveLength(1);
        expect(perFile.get('.env').findings.map(f => f.type)).toContain('HIGH_RISK_FILE');
        if (process.platform !== 'win32') {
            expect(names('A.js')).toHaveLength(1);
            expect(names('a.js')).toHaveLength(1);
            expect(names('we\nird.js')).toHaveLength(1);
        }
        expect(names('renamed.js')).toEqual(['CoinGecko API Key@5']);
        expect(JSON.stringify([...batch.values()])).not.toContain(CG);
    });

    sh('the staged blob is what is scanned, not the working copy', () => {
        stage('staged.js', `const k = "${CG}";\n`);
        fs.writeFileSync(path.join(repo, 'staged.js'), 'const clean = 1;\n'); // the worktree is clean, the index is not
        const { perFile, batch } = both();
        expect(batch.get('staged.js').findings).toHaveLength(1);
        expect(batch.get('staged.js')).toEqual(perFile.get('staged.js'));
    });
});

describe('the CLI on the batch scan', () => {
    const run = (env = {}) => spawnSync(process.execPath, [SCANNER_PATH, '--git-precommit'], {
        cwd: repo, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo, ...env },
    });

    sh('blocks a key, names the rule and file, never prints the value; hard-skip paths are not scanned', () => {
        stage('node_modules/pkg/index.js', `const k = "${CG}";\n`);
        stage('src/ok.js', 'const x = 1;\n');
        expect(run().status).toBe(0);
        stage('src/leak.js', `const k = "${CG}";\n`);
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/CoinGecko API Key/);
        expect(r.stderr).toContain('src/leak.js');
        expect(r.stderr).not.toContain(CG);
    });

    sh('a staged allow marker is reported on stderr and lets the commit through', () => {
        stage('allowed.js', `const password = "${PASSWORD}"; // betterleaks:allow\n`);
        const r = run();
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/allow/i);
    });

    sh('a staged .betterleaksignore is the list that applies (the entry travels with the commit); a staged .gitleaksignore is not read', () => {
        stage('.betterleaksignore', 'leak.js:domdhi-coingecko-api-key:1\n');
        stage('leak.js', `const k = "${CG}";\n`);
        expect(run().status).toBe(0);
        git('rm', '-q', '--cached', '.betterleaksignore');
        stage('.gitleaksignore', 'leak.js:domdhi-coingecko-api-key:1\n');
        expect(run().status).toBe(1);
    });

    sh('an untracked or unstaged .betterleaksignore is not read', () => {
        stage('leak.js', `const k = "${CG}";\n`);
        fs.writeFileSync(path.join(repo, '.betterleaksignore'), 'leak.js:domdhi-coingecko-api-key:1\n');
        expect(run().status).toBe(1);
    });

    sh('a submodule pointer is skipped with a note: a commit of only the pointer passes, a key elsewhere still blocks', () => {
        const sub = path.join(tmp.root, 'subrepo');
        createGitRepo({ root: sub });
        git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub');
        const clean = run();
        expect(clean.status, clean.stderr).toBe(0);
        expect(clean.stderr).toMatch(/"vendor\/sub" is a submodule pointer/);
        stage('src/leak.js', `const k = "${CG}";\n`);
        const blocked = run();
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toMatch(/CoinGecko API Key/);
        expect(blocked.stderr).not.toMatch(/could not read/);
    });

    sh('a blob git cannot resolve fails closed, naming the file', () => {
        git('update-index', '--add', '--cacheinfo', `100644,${'1'.repeat(40)},ghost.bin`);
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/FAIL-CLOSED: could not read the content of "ghost\.bin"/);
    });

    sh('removes its staging directory after a clean run, a finding and an engine failure', () => {
        // A private cache so other test files running in parallel cannot add staging directories to the count.
        const cache = path.join(tmp.root, 'cache');
        const realBin = engineBin.resolveEngine().bin;
        const env = { AGENTS_SECRET_ENGINE_CACHE_DIR: cache, AGENTS_SECRET_ENGINE_BIN: realBin };
        const parent = path.join(cache, 'betterleaks');
        const stages = () => (fs.existsSync(parent) ? fs.readdirSync(parent).filter(n => n.startsWith('scan-')) : []);
        stage('a.js', 'const x = 1;\n');
        expect(run(env).status).toBe(0);
        expect(fs.existsSync(parent)).toBe(true); // the batch really staged somewhere under the private cache
        stage('b.js', `const k = "${CG}";\n`);
        expect(run(env).status).toBe(1);
        const kit = createFakeEngineKit(path.join(tmp.root, 'kit'));
        const failing = run({ ...env, AGENTS_SECRET_ENGINE_BIN: kit.exe(), ...kit.childEnv("process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(9));") });
        expect(failing.status).toBe(1);
        expect(failing.stderr).toMatch(/exited with status 9 during a batch scan/);
        expect(stages()).toEqual([]);
    });
});

describe('one engine process for the whole staged set', () => {
    // A fake engine that counts its runs by subcommand and, for `dir`, reports the bytes it "scanned".
    const COUNTING = `
const fs = require('fs'); const path = require('path');
const sub = process.argv[2];
fs.appendFileSync(process.env.FAKE_COUNT_FILE, sub + '\\n');
const total = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? total(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
if (sub === 'dir') {
  process.stderr.write('INF scanned ~' + total(process.argv[3]) + ' bytes (x) in 1ms\\n');
  console.log('[]');
} else {
  const chunks = []; process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => { const n = Buffer.concat(chunks).length; process.stderr.write('INF scanned ~' + n + ' bytes (' + n + ' bytes) in 1ms\\n'); console.log('[]'); });
}`;

    sh('300 staged files cost exactly one engine run', () => {
        const kit = createFakeEngineKit(path.join(tmp.root, 'kit'));
        const countFile = path.join(tmp.root, 'runs.log');
        fs.writeFileSync(countFile, '');
        for (let i = 0; i < 300; i++) stage(`bulk/f${i}.js`, `export const n${i} = ${i};\n`);
        const r = spawnSync(process.execPath, [SCANNER_PATH, '--git-precommit'], {
            cwd: repo, encoding: 'utf8',
            env: { ...process.env, CLAUDE_PROJECT_DIR: repo, AGENTS_SECRET_ENGINE_BIN: kit.exe(), FAKE_COUNT_FILE: countFile, ...kit.childEnv(COUNTING) },
        });
        expect(r.status, r.stderr).toBe(0);
        expect(fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean)).toEqual(['dir']);
    });

    sh('an engine whose byte count does not add up is not trusted: every file is scanned one by one', () => {
        const kit = createFakeEngineKit(path.join(tmp.root, 'kit'));
        const countFile = path.join(tmp.root, 'runs.log');
        fs.writeFileSync(countFile, '');
        for (let i = 0; i < 5; i++) stage(`bulk/f${i}.js`, `export const n${i} = ${i};\n`);
        const lying = COUNTING.replace("total(process.argv[3])", "1");
        const r = spawnSync(process.execPath, [SCANNER_PATH, '--git-precommit'], {
            cwd: repo, encoding: 'utf8',
            env: { ...process.env, CLAUDE_PROJECT_DIR: repo, AGENTS_SECRET_ENGINE_BIN: kit.exe(), FAKE_COUNT_FILE: countFile, ...kit.childEnv(lying) },
        });
        expect(r.status, r.stderr).toBe(0);
        const runs = fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean);
        expect(runs[0]).toBe('dir');
        expect(runs.filter(x => x === 'stdin')).toHaveLength(5);
    });
});
