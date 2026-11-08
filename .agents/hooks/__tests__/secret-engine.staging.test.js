// secret-engine.cjs scanFiles: the private staging directory holds plaintext copies of staged files, so it is
// removed on every exit, including a signal, and stale ones left by a killed run are swept (SEC-MINOR-1).
//
// Coverage:
//   - sweepStaleStages: only this user's `scan-*` directories older than ten minutes; fresh ones, other names
//     and the target of a link are left alone
//   - a scan sweeps stale directories first and tightens a cache parent an older run created 0755
//   - SIGTERM / SIGINT during a scan: the directory is gone and the signal is re-raised (exit by that signal)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const engine = require('../../../.agents/hooks/secret-engine.cjs');
const binLib = require('../../../.agents/core/_lib/secret-engine-bin');
const { createFakeEngineKit } = require('./_helpers/fake-engine');

const isWin = process.platform === 'win32';
const ENGINE_PATH = path.resolve(__dirname, '..', 'secret-engine.cjs');

let tmp;
let cache;
let parent;
const saved = {};
const touched = ['AGENTS_SECRET_ENGINE_CACHE_DIR', 'AGENTS_SECRET_ENGINE_BIN', 'CLAUDE_PROJECT_DIR'];

beforeEach(() => {
    for (const k of touched) saved[k] = process.env[k];
    const realBin = binLib.resolveEngine().bin; // the real, hash-verified engine, found BEFORE the cache moves
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-staging-'));
    cache = path.join(tmp, 'cache');
    parent = path.join(cache, 'betterleaks');
    process.env.AGENTS_SECRET_ENGINE_CACHE_DIR = cache;
    process.env.AGENTS_SECRET_ENGINE_BIN = realBin;
    process.env.CLAUDE_PROJECT_DIR = tmp;
    engine.resetForTests();
});
afterEach(() => {
    for (const k of touched) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    engine.resetForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const age = (dir, minutes) => {
    const when = new Date(Date.now() - minutes * 60 * 1000);
    fs.utimesSync(dir, when, when);
};
const stages = () => (fs.existsSync(parent) ? fs.readdirSync(parent).filter(n => n.startsWith('scan-')) : []);

describe('sweepStaleStages', () => {
    it('removes this user\'s scan-* directories older than ten minutes, and only those', () => {
        fs.mkdirSync(parent, { recursive: true });
        for (const name of ['scan-old', 'scan-new', 'cwd-old', 'scan-old-file-holder']) fs.mkdirSync(path.join(parent, name));
        fs.writeFileSync(path.join(parent, 'scan-old', 'staged.js'), 'plaintext');
        age(path.join(parent, 'scan-old'), 30);
        age(path.join(parent, 'cwd-old'), 30);
        age(path.join(parent, 'scan-new'), 2);
        engine.sweepStaleStages(parent);
        expect(fs.readdirSync(parent).sort()).toEqual(['cwd-old', 'scan-new', 'scan-old-file-holder']);
    });

    it.skipIf(isWin)('never follows a link: the link goes, its target stays', () => {
        const outside = path.join(tmp, 'precious');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
        fs.mkdirSync(parent, { recursive: true });
        fs.symlinkSync(outside, path.join(parent, 'scan-link'));
        const old = new Date(Date.now() - 30 * 60 * 1000);
        fs.lutimesSync(path.join(parent, 'scan-link'), old, old);
        engine.sweepStaleStages(parent);
        expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('a missing cache parent is not an error', () => {
        expect(() => engine.sweepStaleStages(path.join(tmp, 'nope'))).not.toThrow();
    });
});

describe('a scan tidies the cache it stages in', () => {
    const scanOne = () => engine.scanFiles(tmp, ['a.js'], () => ({}), { contentFor: () => Buffer.from('const x = 1;\n') });

    it('sweeps a stale staging directory of an interrupted run before it starts', () => {
        fs.mkdirSync(path.join(parent, 'scan-hlXAIa'), { recursive: true });
        fs.writeFileSync(path.join(parent, 'scan-hlXAIa', 'staged-secret.txt'), 'plaintext of a staged file');
        age(path.join(parent, 'scan-hlXAIa'), 45);
        scanOne();
        expect(stages()).toEqual([]);
    });

    it.skipIf(isWin)('tightens a cache parent that an older run created world-readable (0755)', () => {
        fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
        fs.chmodSync(parent, 0o755);
        scanOne();
        expect(fs.statSync(parent).mode & 0o077).toBe(0);
    });

    it('leaves no directory behind after a clean scan', () => {
        scanOne();
        expect(stages()).toEqual([]);
    });
});

describe('a signal during a scan', () => {
    // A fake engine that takes 1.5 s to answer, so the signal lands while the batch run is in progress.
    const SLOW = "setTimeout(() => { process.stderr.write('INF scanned ~1 bytes (1 bytes) in 1ms\\n'); console.log('[]'); }, 1500);";

    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        it.skipIf(isWin)(`${signal}: the staging directory (plaintext) is removed and the signal is re-raised`, async () => {
            const kit = createFakeEngineKit(path.join(tmp, 'kit'));
            const script = path.join(tmp, 'scan-child.cjs');
            fs.writeFileSync(script, `const engine = require(${JSON.stringify(ENGINE_PATH)});
(async () => {
  engine.scanFiles(${JSON.stringify(tmp)}, ['a.js'], () => ({}), { contentFor: () => Buffer.from('x') });
  await engine.settleSignals();   // what the scanner does before it exits: a queued signal is delivered here
  process.exit(0);
})();`);
            const child = spawn(process.execPath, [script], {
                env: { ...process.env, ...kit.childEnv(SLOW), AGENTS_SECRET_ENGINE_BIN: kit.exe(), AGENTS_SECRET_ENGINE_CACHE_DIR: cache },
                stdio: 'ignore',
            });
            const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
            const started = Date.now();
            while (stages().length === 0 && Date.now() - started < 10000) await new Promise(r => setTimeout(r, 20));
            expect(stages(), 'the child staged the file').toHaveLength(1);
            child.kill(signal);
            const { code, sig } = await exited;
            expect(sig).toBe(signal);        // re-raised: the sender sees the exit it asked for
            expect(code).toBeNull();
            expect(stages()).toEqual([]);    // and no plaintext copy of a staged file is left
        }, 30000);
    }
});

describe('a signal during the real pre-commit scan', () => {
    const R = require('../../core/__tests__/_helpers/hook-repo');
    const { gitAvailable } = require('../../core/__tests__/_helpers/git-fixture');
    const SLOW_DIR = `
const fs = require('fs'); const path = require('path');
const total = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? total(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
setTimeout(() => { process.stderr.write('INF scanned ~' + total(process.argv[3]) + ' bytes (x) in 1ms\\n'); console.log('[]'); }, 1500);`;

    it.skipIf(isWin || !gitAvailable())('SIGTERM while the staged set is being scanned: no plaintext is left, and the scanner dies by the signal', async () => {
        const repo = R.createHookRepo(path.join(tmp, 'repo'));
        R.stage(repo, 'app.js', 'const x = 1;\n');
        const kit = createFakeEngineKit(path.join(tmp, 'kit'));
        const child = spawn(process.execPath, [path.join(R.TOOLKIT_AGENTS, 'hooks', 'secret-scanner.cjs'), '--git-precommit'], {
            cwd: repo,
            env: { ...R.cleanEnv(repo), ...kit.childEnv(SLOW_DIR), AGENTS_SECRET_ENGINE_BIN: kit.exe(), AGENTS_SECRET_ENGINE_CACHE_DIR: cache },
            stdio: 'ignore',
        });
        const exited = new Promise(resolve => child.on('exit', (code, sig) => resolve({ code, sig })));
        const started = Date.now();
        while (stages().length === 0 && Date.now() - started < 10000) await new Promise(r => setTimeout(r, 20));
        expect(stages()).toHaveLength(1);
        child.kill('SIGTERM');
        const { code, sig } = await exited;
        expect(sig).toBe('SIGTERM');
        expect(code).toBeNull();
        expect(stages()).toEqual([]);
    }, 30000);
});
