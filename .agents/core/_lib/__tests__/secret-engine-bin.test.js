// Resolution of the pinned secret engine and proof of its identity: override, per-user cache, PATH.
// Every candidate must hash to the pinned binary hash; a version string proves nothing. The "binaries"
// here are small files hashed against a fake release's pins; none of these tests download or run one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const bin = require('../secret-engine-bin');

const isWindows = process.platform === 'win32';
const touched = ['AGENTS_SECRET_ENGINE_BIN', 'AGENTS_SECRET_ENGINE_CACHE_DIR', 'PATH', 'Path', 'AGENTS_RUNTIME', 'NODE_ENV', 'VITEST', 'SECRET_ENGINE_VERIFY_IN_TESTS', 'SECRET_ENGINE_SKIP_VERIFY'];
const saved = {};
let tmp;
let pins;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const GOOD = '#!/bin/sh\n# the pinned build\n';

const file = (target, text = GOOD) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, { mode: 0o755 });
    fs.chmodSync(target, 0o755);
    return target;
};

// A fake release whose pinned binary hash is that of GOOD.
function fakePins(binarySha256 = sha(GOOD)) {
    const key = bin.platformKey();
    return { engine: 'betterleaks', version: '9.9.9', releaseBase: 'https://example.invalid/r', assets: { [key]: { file: 'x.tar.gz', sha256: '0'.repeat(64), binary: bin.binaryName(), binarySha256 } } };
}

beforeEach(() => {
    for (const k of touched) saved[k] = process.env[k];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-engine-bin-'));
    delete process.env.AGENTS_SECRET_ENGINE_BIN;
    delete process.env.AGENTS_RUNTIME;
    process.env.AGENTS_SECRET_ENGINE_CACHE_DIR = path.join(tmp, 'cache');
    process.env.PATH = path.join(tmp, 'emptybin');
    bin.resetForTests();
    pins = bin.loadPins();
});

afterEach(() => {
    for (const k of touched) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    bin.resetForTests();
});

describe('pins', () => {
    it('pins a version, an archive sha256 and an extracted-binary sha256 for every supported platform', () => {
        expect(pins.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(Object.keys(pins.assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-arm64', 'windows-x64']);
        for (const [key, asset] of Object.entries(pins.assets)) {
            expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/);
            expect(asset.binarySha256, key).toMatch(/^[0-9a-f]{64}$/);
            expect(asset.binarySha256, key).not.toBe(asset.sha256);
            expect(asset.file, key).toContain(pins.version);
            expect(asset.file, key).toMatch(key.startsWith('windows') ? /\.zip$/ : /\.tar\.gz$/);
            expect(asset.binary, key).toBe(key.startsWith('windows') ? 'betterleaks.exe' : 'betterleaks');
        }
        expect(new Set(Object.values(pins.assets).map(a => a.binarySha256)).size).toBe(6);
        expect(pins.releaseBase).toMatch(/^https:\/\/github\.com\/betterleaks\/betterleaks\/releases\/download\/v/);
        expect(pins.releaseBase.endsWith(`v${pins.version}`)).toBe(true);
    });

    it('has no checksumsFile key (the pinned hashes are the only authority; nothing is fetched)', () => {
        expect(pins).not.toHaveProperty('checksumsFile');
    });

    it('maps node platform and architecture to an asset key', () => {
        expect(bin.platformKey('linux', 'x64')).toBe('linux-x64');
        expect(bin.platformKey('darwin', 'arm64')).toBe('darwin-arm64');
        expect(bin.platformKey('win32', 'x64')).toBe('windows-x64');
        expect(bin.platformKey('win32', 'arm64')).toBe('windows-arm64');
        expect(bin.platformKey('freebsd', 'x64')).toBeNull();
        expect(bin.platformKey('linux', 'ia32')).toBeNull();
    });
});

describe('cache location', () => {
    it('honors the test override, then XDG_CACHE_HOME, then ~/.cache, then %LOCALAPPDATA% on Windows', () => {
        expect(bin.cacheRoot({ AGENTS_SECRET_ENGINE_CACHE_DIR: '/x/cache' }, 'linux')).toBe(path.resolve('/x/cache'));
        expect(bin.cacheRoot({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe(path.join('/xdg', 'domdhi-agents'));
        expect(bin.cacheRoot({}, 'linux')).toBe(path.join(os.homedir(), '.cache', 'domdhi-agents'));
        // Built from parts so the shipped-content lint does not mistake the fixture for a machine path.
        const localAppData = ['C:', 'Users', 'x', 'AppData', 'Local'].join('\\');
        expect(bin.cacheRoot({ LOCALAPPDATA: localAppData }, 'win32')).toBe(path.join(localAppData, 'domdhi-agents'));
    });

    it('puts the binary in a per-version directory', () => {
        expect(bin.cacheDir(pins, { AGENTS_SECRET_ENGINE_CACHE_DIR: '/c' }, 'linux')).toBe(path.join(path.resolve('/c'), 'betterleaks', pins.version));
    });

    it('names the install command for the running runtime', () => {
        expect(bin.installCommand()).toBe('node .claude/core/secret-engine-install.js');
        process.env.AGENTS_RUNTIME = 'codex';
        expect(bin.installCommand()).toBe('node .codex/core/secret-engine-install.js');
        expect(bin.installHint()).toContain('.codex/core/secret-engine-install.js');
    });
});

describe.skipIf(isWindows)('identity: every engine must be the pinned binary', () => {
    const cached = () => path.join(bin.cacheDir(), bin.binaryName());
    beforeEach(() => bin.setPinsForTests(fakePins()));

    it('accepts the override when it hashes to the pin', () => {
        const fake = file(path.join(tmp, 'override'));
        process.env.AGENTS_SECRET_ENGINE_BIN = fake;
        expect(bin.resolveEngine()).toMatchObject({ bin: fake, source: 'env', sha256: sha(GOOD) });
    });

    it('refuses an override that does not hash to the pin, even one that prints the pinned version', () => {
        const fake = file(path.join(tmp, 'override'), '#!/bin/sh\necho 9.9.9\n');
        process.env.AGENTS_SECRET_ENGINE_BIN = fake;
        let thrown;
        try { bin.resolveEngine(); } catch (err) { thrown = err; }
        expect(thrown).toBeInstanceOf(bin.EngineUnavailableError);
        expect(thrown.detail).toMatchObject({ reason: 'binary-hash-mismatch', expected: sha(GOOD) });
        expect(thrown.message).toMatch(/not the pinned build/);
    });

    it('refuses an override that is not an executable file', () => {
        process.env.AGENTS_SECRET_ENGINE_BIN = path.join(tmp, 'nope');
        expect(() => bin.resolveEngine()).toThrow(/not an executable file/);
    });

    it('accepts a cached binary that hashes to the pin and refuses a swapped one', () => {
        file(cached());
        expect(bin.resolveEngine()).toMatchObject({ bin: cached(), source: 'cache' });
        bin.resetForTests();
        bin.setPinsForTests(fakePins());
        file(cached(), '#!/bin/sh\necho swapped\n');
        expect(() => bin.resolveEngine()).toThrow(/not the pinned build/);
    });

    it('accepts a PATH binary only by hash: the matching build is taken, a same-version impostor is refused', () => {
        const onPath = file(path.join(tmp, 'pathbin', bin.binaryName()));
        process.env.PATH = path.dirname(onPath);
        expect(bin.resolveEngine()).toMatchObject({ bin: onPath, source: 'path' });
        bin.resetForTests();
        bin.setPinsForTests(fakePins());
        file(onPath, '#!/bin/sh\necho 9.9.9\n');
        let thrown;
        try { bin.resolveEngine(); } catch (err) { thrown = err; }
        expect(thrown.detail.reason).toBe('binary-hash-mismatch');
        expect(thrown.message).toMatch(/Refusing to run it/);
    });

    it('ignores a relative PATH entry entirely, even when it holds the pinned build', () => {
        const relDir = path.join(tmp, 'rel');
        file(path.join(relDir, bin.binaryName()));
        const previous = process.cwd();
        process.chdir(tmp);
        try {
            process.env.PATH = ['rel', '.', '', 'node_modules/.bin'].join(':');
            expect(() => bin.resolveEngine()).toThrow(/not installed/);
        } finally {
            process.chdir(previous);
        }
    });

    it('prefers the override over the cache and the cache over PATH', () => {
        file(cached());
        const onPath = file(path.join(tmp, 'pathbin', bin.binaryName()));
        process.env.PATH = path.dirname(onPath);
        expect(bin.resolveEngine({ fresh: true }).source).toBe('cache');
        process.env.AGENTS_SECRET_ENGINE_BIN = file(path.join(tmp, 'override'));
        expect(bin.resolveEngine({ fresh: true }).source).toBe('env');
    });

    it('ignores a PATH entry that is not executable', () => {
        const f = path.join(tmp, 'pathbin', bin.binaryName());
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, GOOD, { mode: 0o644 });
        process.env.PATH = path.dirname(f);
        expect(() => bin.resolveEngine()).toThrow(/not installed/);
    });

    it('fails with an unsupported-platform reason when the platform has no pinned hash', () => {
        const noHash = fakePins();
        delete noHash.assets[bin.platformKey()].binarySha256;
        bin.setPinsForTests(noHash);
        process.env.AGENTS_SECRET_ENGINE_BIN = file(path.join(tmp, 'override'));
        expect(() => bin.resolveEngine()).toThrow(/no pinned binary hash/);
    });

    describe('the verification is remembered, keyed on path + size + mtime (+ inode, ctime)', () => {
        const records = () => JSON.parse(fs.readFileSync(path.join(bin.cacheRoot(), 'betterleaks', 'verified.json'), 'utf8'));

        it('writes a record after the first hash and trusts it in a later process', () => {
            const f = file(cached());
            bin.resolveEngine();
            expect(records()[f]).toMatchObject({ path: f, sha256: sha(GOOD), size: GOOD.length });
            // a later process: no in-memory memo, only the record; replace the content with different bytes of
            // the same size and restore the old mtime/ctime is not possible, so prove the record is what is read
            bin.resetForTests();
            bin.setPinsForTests(fakePins());
            const rec = records();
            rec[f].sha256 = sha('something else');          // a record that disagrees with the pin is not trusted
            fs.writeFileSync(path.join(bin.cacheRoot(), 'betterleaks', 'verified.json'), JSON.stringify(rec));
            expect(bin.resolveEngine().sha256).toBe(sha(GOOD));   // rehashed, and the file is still the pinned build
        });

        it('hashes again when the file changes (a same-length swap is caught)', () => {
            const f = file(cached());
            bin.resolveEngine();
            bin.resetForTests();
            bin.setPinsForTests(fakePins());
            const swapped = GOOD.replace('pinned', 'forged');
            expect(swapped.length).toBe(GOOD.length);
            fs.writeFileSync(f, swapped);
            expect(() => bin.resolveEngine()).toThrow(/not the pinned build/);
        });

        it('hashes the binary once per process however often it is resolved', () => {
            const f = file(cached());
            const reads = [];
            const real = fs.readFileSync;
            fs.readFileSync = function patched(target, ...rest) { if (target === f) reads.push(target); return real.call(this, target, ...rest); };
            try {
                bin.resolveEngine();
                bin.resolveEngine();
                bin.resolveEngine({ fresh: true });
            } finally {
                fs.readFileSync = real;
            }
            expect(reads).toHaveLength(1);
        });
    });

    describe('cache directory safety', () => {
        it('refuses a cache directory that group or others can write to', () => {
            file(cached());
            fs.chmodSync(path.dirname(cached()), 0o777);
            let thrown;
            try { bin.resolveEngine(); } catch (err) { thrown = err; }
            expect(thrown.detail.reason).toBe('cache-unsafe');
            expect(thrown.message).toMatch(/writable by group or others/);
        });

        it('refuses a binary in the cache that group or others can write to', () => {
            const f = file(cached());
            fs.chmodSync(f, 0o775);
            expect(() => bin.resolveEngine()).toThrow(/writable by group or others/);
        });

        it('reports the ownership rule as data', () => {
            const dir = path.join(tmp, 'owned');
            fs.mkdirSync(dir, { mode: 0o700 });
            expect(bin.unsafeOwnership(dir)).toBeNull();
            fs.chmodSync(dir, 0o770);
            expect(bin.unsafeOwnership(dir)).toMatch(/writable by group or others/);
            expect(bin.unsafeOwnership(path.join(tmp, 'absent'))).toBeNull();
        });
    });

    it('reports status as data', () => {
        expect(bin.engineStatus({ fresh: true })).toMatchObject({ available: false, reason: 'not-installed', expectedVersion: '9.9.9' });
        file(cached());
        expect(bin.engineStatus({ fresh: true })).toMatchObject({ available: true, source: 'cache', expectedVersion: '9.9.9' });
        file(cached(), 'tampered\n');
        expect(bin.engineStatus({ fresh: true })).toMatchObject({ available: false, reason: 'binary-hash-mismatch' });
    });
});

describe.skipIf(isWindows)('no environment variable skips the hash check', () => {
    it.each([
        ['NODE_ENV=test', { NODE_ENV: 'test' }],
        ['VITEST set', { VITEST: 'true' }],
        ['SECRET_ENGINE_VERIFY_IN_TESTS=0', { SECRET_ENGINE_VERIFY_IN_TESTS: '0' }],
        ['SECRET_ENGINE_VERIFY_IN_TESTS=1', { SECRET_ENGINE_VERIFY_IN_TESTS: '1' }],
        ['SECRET_ENGINE_SKIP_VERIFY=1', { SECRET_ENGINE_SKIP_VERIFY: '1' }],
        ['all of them', { NODE_ENV: 'test', VITEST: 'true', SECRET_ENGINE_VERIFY_IN_TESTS: '0', SECRET_ENGINE_SKIP_VERIFY: '1' }],
    ])('refuses an impostor override with %s', (_name, env) => {
        Object.assign(process.env, env);
        bin.setPinsForTests(fakePins());
        process.env.AGENTS_SECRET_ENGINE_BIN = file(path.join(tmp, 'impostor'), '#!/bin/sh\necho 9.9.9\n');
        expect(() => bin.resolveEngine()).toThrow(/not the pinned build/);
        process.env.PATH = path.dirname(file(path.join(tmp, 'pathbin', bin.binaryName()), 'also not it\n'));
        delete process.env.AGENTS_SECRET_ENGINE_BIN;
        bin.setPinsForTests(fakePins());
        expect(() => bin.resolveEngine({ fresh: true })).toThrow(/not the pinned build/);
    });

    it('exports no test-runner switch', () => {
        expect(bin.underTestRunner).toBeUndefined();
    });

    it('prunes verification records of binaries that no longer exist', () => {
        bin.setPinsForTests(fakePins());
        const gone = file(path.join(tmp, 'gone', 'engine'));
        process.env.AGENTS_SECRET_ENGINE_BIN = gone;
        bin.resolveEngine();
        const recordsFile = path.join(bin.cacheRoot(), 'betterleaks', 'verified.json');
        expect(Object.keys(JSON.parse(fs.readFileSync(recordsFile, 'utf8')))).toContain(gone);
        fs.rmSync(path.dirname(gone), { recursive: true });
        const other = file(path.join(tmp, 'other', 'engine'));
        process.env.AGENTS_SECRET_ENGINE_BIN = other;
        bin.resetForTests();
        bin.setPinsForTests(fakePins());
        bin.resolveEngine();
        expect(Object.keys(JSON.parse(fs.readFileSync(recordsFile, 'utf8')))).toEqual([other]);
    });
});

describe('child environment', () => {
    it('drops BETTERLEAKS_* and GITLEAKS_* settings and keeps the rest', () => {
        process.env.BETTERLEAKS_CONFIG_TOML = 'title="x"';
        process.env.gitleaks_exit_code = '9';
        process.env.KEEP_ME = '1';
        try {
            const env = bin.scrubbedEnv();
            expect(Object.keys(env).filter(k => /^(betterleaks|gitleaks)_/i.test(k))).toEqual([]);
            expect(env.KEEP_ME).toBe('1');
            expect(env.PATH).toBeDefined();
        } finally {
            delete process.env.BETTERLEAKS_CONFIG_TOML;
            delete process.env.gitleaks_exit_code;
            delete process.env.KEEP_ME;
        }
    });
});
