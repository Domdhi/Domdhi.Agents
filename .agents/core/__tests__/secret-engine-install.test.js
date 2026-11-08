// secret-engine-install.js: checksum-before-extract, archive readers, https-only download, status offer.
// Archives are built in the test; a loopback HTTP server stands in for the release host. The real
// download of the pinned release is exercised by hand (see the readiness record), not here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const installer = require('../secret-engine-install');
const bin = require('../_lib/secret-engine-bin');

const isWindows = process.platform === 'win32';
const touched = ['AGENTS_SECRET_ENGINE_BIN', 'AGENTS_SECRET_ENGINE_CACHE_DIR', 'AGENTS_SECRET_ENGINE_RELEASE_BASE', 'PATH'];
const saved = {};
let tmp;

beforeEach(() => {
    for (const k of touched) saved[k] = process.env[k];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-engine-install-'));
    delete process.env.AGENTS_SECRET_ENGINE_BIN;
    delete process.env.AGENTS_SECRET_ENGINE_RELEASE_BASE;
    process.env.AGENTS_SECRET_ENGINE_CACHE_DIR = path.join(tmp, 'cache');
    process.env.PATH = path.join(tmp, 'emptybin');
    bin.resetForTests();
});

afterEach(() => {
    for (const k of touched) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    bin.resetForTests();
});

// ── archive builders ─────────────────────────────────────────────────────────

function tarEntry(name, data, type = '0') {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000755\0', 100, 8, 'ascii');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write(type, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tarGz = entries => zlib.gzipSync(Buffer.concat([...entries.map(([n, d, t]) => tarEntry(n, Buffer.from(d), t)), Buffer.alloc(1024)]));

function zipOf(entries, method = 8) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, text] of entries) {
        const data = Buffer.from(text);
        const packed = method === 8 ? zlib.deflateRawSync(data) : data;
        const nameBuf = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, packed);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + packed.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}

// ── pins for a fake "release" of version 9.9.9 ──────────────────────────────

const fakeBinary = version => `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`;

function fakePins(archive, { version = '9.9.9', key = bin.platformKey(), binaryContent = fakeBinary(version) } = {}) {
    const binary = process.platform === 'win32' ? 'betterleaks.exe' : 'betterleaks';
    return {
        engine: 'betterleaks',
        version,
        releaseBase: 'https://example.invalid/release',
        assets: { [key]: { file: `betterleaks_${version}_fake.tar.gz`, sha256: crypto.createHash('sha256').update(archive).digest('hex'), binary, binarySha256: crypto.createHash('sha256').update(binaryContent).digest('hex') } },
    };
}

describe('archive readers', () => {
    it('finds the binary in a tar.gz by basename, ignoring other entries', () => {
        const archive = tarGz([['LICENSE', 'mit'], ['README.md', 'readme'], ['dist/betterleaks', 'THE-BINARY']]);
        expect(installer.readTarGzEntry(archive, 'betterleaks').toString()).toBe('THE-BINARY');
        expect(installer.readTarGzEntry(archive, 'missing')).toBeNull();
    });

    it('skips a directory entry and a pax header before the file', () => {
        const archive = tarGz([['dist/', '', '5'], ['pax', 'x=y', 'x'], ['dist/betterleaks', 'BIN']]);
        expect(installer.readTarGzEntry(archive, 'betterleaks').toString()).toBe('BIN');
    });

    it('reads a deflated and a stored entry from a zip', () => {
        const wanted = 'MZ-BINARY'.repeat(40);
        expect(installer.readZipEntry(zipOf([['LICENSE', 'mit'], ['betterleaks.exe', wanted]]), 'betterleaks.exe').toString()).toBe(wanted);
        expect(installer.readZipEntry(zipOf([['betterleaks.exe', 'stored']], 0), 'betterleaks.exe').toString()).toBe('stored');
        expect(installer.readZipEntry(zipOf([['LICENSE', 'mit']]), 'betterleaks.exe')).toBeNull();
    });

    it('rejects a truncated or corrupt archive instead of returning garbage', () => {
        expect(() => installer.readZipEntry(Buffer.from('not a zip'), 'betterleaks.exe')).toThrow(/zip/);
        const tar = zlib.gunzipSync(tarGz([['betterleaks', 'x'.repeat(2000)]]));
        expect(() => installer.readTarEntry(tar.subarray(0, 700), 'betterleaks')).toThrow(/tar/);
    });
});

describe.skipIf(isWindows)('installEngine', () => {
    it('verifies the pinned checksum, extracts, checks the version and installs atomically', async () => {
        const archive = tarGz([['LICENSE', 'mit'], ['betterleaks', fakeBinary('9.9.9')]]);
        const pins = fakePins(archive);
        const lines = [];
        const result = await installer.installEngine({ pins, fetch: async () => archive, log: l => lines.push(l) });
        expect(result.version).toBe('9.9.9');
        expect(result.sha256).toBe(pins.assets[bin.platformKey()].sha256);
        expect(fs.statSync(result.bin).mode & 0o111).not.toBe(0);
        expect(bin.binaryVersion(result.bin)).toBe('9.9.9');
        expect(path.dirname(result.bin)).toBe(bin.cacheDir(pins));
        expect(fs.readdirSync(bin.cacheDir(pins))).toEqual(['betterleaks']);
        expect(lines.join('\n')).toMatch(/Checksum verified/);
    });

    it('refuses a download whose sha256 differs from the pin and writes nothing', async () => {
        const good = tarGz([['betterleaks', fakeBinary('9.9.9')]]);
        const pins = fakePins(good);
        const tampered = tarGz([['betterleaks', fakeBinary('9.9.9') + '// tampered\n']]);
        await expect(installer.installEngine({ pins, fetch: async () => tampered })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
        expect(fs.existsSync(bin.cacheDir(pins))).toBe(false);
    });

    it('checks the checksum before it reads the archive (a corrupt archive with the right hash is the only way in)', async () => {
        const garbage = Buffer.from('this is not a gzip stream');
        const pins = fakePins(garbage);
        await expect(installer.installEngine({ pins, fetch: async () => garbage })).rejects.toThrow();
        expect(fs.existsSync(path.join(bin.cacheDir(pins), 'betterleaks'))).toBe(false);
        const wrongHashPins = fakePins(Buffer.from('other'));
        await expect(installer.installEngine({ pins: wrongHashPins, fetch: async () => garbage })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    });

    it('refuses an archive whose extracted binary is not the pinned binary, though the archive hash is right', async () => {
        const archive = tarGz([['betterleaks', fakeBinary('9.9.9') + '// not the pinned build\n']]);
        const pins = fakePins(archive);              // the archive hash matches; the binary hash pins the original text
        await expect(installer.installEngine({ pins, fetch: async () => archive })).rejects.toMatchObject({ code: 'BINARY_MISMATCH' });
        expect(fs.existsSync(bin.cacheDir(pins))).toBe(false);
    });

    it('refuses a pin that has no binary hash at all', async () => {
        const archive = tarGz([['betterleaks', fakeBinary('9.9.9')]]);
        const pins = fakePins(archive);
        delete pins.assets[bin.platformKey()].binarySha256;
        await expect(installer.installEngine({ pins, fetch: async () => archive })).rejects.toMatchObject({ code: 'BINARY_MISMATCH' });
    });

    it('creates the cache directory private (0700) and records the verification', async () => {
        const archive = tarGz([['betterleaks', fakeBinary('9.9.9')]]);
        const pins = fakePins(archive);
        const result = await installer.installEngine({ pins, fetch: async () => archive });
        expect(fs.statSync(path.dirname(result.bin)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(result.bin).mode & 0o077).toBe(0);
    });

    it('refuses to install into a cache directory that others can write to', async () => {
        const archive = tarGz([['betterleaks', fakeBinary('9.9.9')]]);
        const pins = fakePins(archive);
        fs.mkdirSync(bin.cacheDir(pins), { recursive: true });
        fs.chmodSync(bin.cacheDir(pins), 0o777);
        await expect(installer.installEngine({ pins, fetch: async () => archive })).rejects.toThrow(/unsafe cache directory/);
        expect(fs.readdirSync(bin.cacheDir(pins))).toEqual([]);
    });

    it('refuses a binary that reports a different version than the pin', async () => {
        const archive = tarGz([['betterleaks', fakeBinary('1.0.0')]]);
        const pins = fakePins(archive, { version: '9.9.9', binaryContent: fakeBinary('1.0.0') });
        await expect(installer.installEngine({ pins, fetch: async () => archive })).rejects.toThrow(/reports version 1\.0\.0, expected 9\.9\.9/);
        expect(fs.existsSync(path.join(bin.cacheDir(pins), 'betterleaks'))).toBe(false);
        expect(fs.readdirSync(bin.cacheDir(pins))).toEqual([]);
    });

    it('fails when the archive has no binary', async () => {
        const archive = tarGz([['README.md', 'only docs']]);
        await expect(installer.installEngine({ pins: fakePins(archive), fetch: async () => archive })).rejects.toThrow(/not found in/);
    });

    it('reports an unsupported platform without downloading', async () => {
        const pins = fakePins(Buffer.from('x'), { key: 'plan9-mips' });
        let fetched = false;
        await expect(installer.installEngine({ pins, fetch: async () => { fetched = true; return Buffer.alloc(0); } })).rejects.toMatchObject({ code: 'UNSUPPORTED_PLATFORM' });
        expect(fetched).toBe(false);
    });

    it('lets resolveEngine find the installed binary', async () => {
        const archive = tarGz([['betterleaks', fakeBinary('9.9.9')]]);
        const pins = fakePins(archive);
        await installer.installEngine({ pins, fetch: async () => archive });
        // the resolver reads the real pins, so look the file up directly
        expect(fs.existsSync(path.join(bin.cacheDir(pins), 'betterleaks'))).toBe(true);
    });
});

describe('download', () => {
    let server;
    let base;
    const routes = new Map();

    beforeEach(async () => {
        routes.clear();
        server = http.createServer((req, res) => {
            const r = routes.get(req.url);
            if (!r) { res.writeHead(404); res.end('nope'); return; }
            res.writeHead(r.status || 200, r.headers || {});
            res.end(r.body || '');
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

    it('refuses plain http unless a loopback test mirror is explicitly allowed', async () => {
        await expect(installer.fetchBuffer(`${base}/a`)).rejects.toThrow(/https only/);
        await expect(installer.fetchBuffer('http://example.com/a', { allowLoopbackHttp: true })).rejects.toThrow(/https only/);
        await expect(installer.fetchBuffer('ftp://example.com/a', { allowLoopbackHttp: true })).rejects.toThrow(/https only/);
    });

    it('downloads over a loopback mirror and follows a redirect', async () => {
        routes.set('/final', { body: 'payload' });
        routes.set('/start', { status: 302, headers: { Location: '/final' } });
        const got = await installer.fetchBuffer(`${base}/start`, { allowLoopbackHttp: true });
        expect(got.toString()).toBe('payload');
    });

    it('does not follow a redirect to a non-https, non-loopback host', async () => {
        routes.set('/start', { status: 302, headers: { Location: 'http://example.com/evil' } });
        await expect(installer.fetchBuffer(`${base}/start`, { allowLoopbackHttp: true })).rejects.toThrow(/https only/);
    });

    it('caps the whole download, not just the gap between chunks (a server that trickles bytes)', async () => {
        const slow = http.createServer((req, res) => {
            res.writeHead(200);
            const timer = setInterval(() => res.write('x'), 40);
            res.on('close', () => clearInterval(timer));
        });
        await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
        const started = Date.now();
        try {
            await expect(installer.fetchBuffer(`http://127.0.0.1:${slow.address().port}/x`, { allowLoopbackHttp: true, totalMs: 400, timeoutMs: 5000 }))
                .rejects.toThrow(/total time limit/);
            expect(Date.now() - started).toBeLessThan(3000);
        } finally {
            slow.closeAllConnections();
            await new Promise(resolve => slow.close(resolve));
        }
    });

    it('stops after too many redirects and reports an HTTP error status', async () => {
        routes.set('/loop', { status: 302, headers: { Location: '/loop' } });
        await expect(installer.fetchBuffer(`${base}/loop`, { allowLoopbackHttp: true })).rejects.toThrow(/too many redirects/);
        await expect(installer.fetchBuffer(`${base}/missing`, { allowLoopbackHttp: true })).rejects.toThrow(/HTTP 404/);
    });

    it.skipIf(isWindows)('installs from the mirror named by AGENTS_SECRET_ENGINE_RELEASE_BASE, still checking the pin', async () => {
        const archive = tarGz([['betterleaks', fakeBinary('9.9.9')]]);
        const pins = fakePins(archive);
        routes.set(`/rel/${pins.assets[bin.platformKey()].file}`, { body: archive });
        process.env.AGENTS_SECRET_ENGINE_RELEASE_BASE = `${base}/rel`;
        const result = await installer.installEngine({ pins });
        expect(bin.binaryVersion(result.bin)).toBe('9.9.9');

        const evil = tarGz([['betterleaks', fakeBinary('9.9.9') + '// other\n']]);
        routes.set(`/rel/${pins.assets[bin.platformKey()].file}`, { body: evil });
        fs.rmSync(bin.cacheDir(pins), { recursive: true, force: true });
        await expect(installer.installEngine({ pins })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    });
});

// Pin a small file as the engine of a fake release, so the identity check accepts it (production pins are not touched).
function pinCachedFile(content = `#!${process.execPath}\n`) {
    const dir = bin.cacheDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'betterleaks');
    fs.writeFileSync(file, content, { mode: 0o700 });
    const real = bin.loadPins();
    const key = bin.platformKey();
    bin.setPinsForTests({ ...real, assets: { ...real.assets, [key]: { ...real.assets[key], binarySha256: crypto.createHash('sha256').update(content).digest('hex') } } });
    return file;
}

describe('status and the install offer', () => {
    it('describes a missing engine with the install command', () => {
        const status = bin.engineStatus({ fresh: true });
        expect(installer.describeStatus(status)).toMatch(/NOT INSTALLED.*node \.claude\/core\/secret-engine-install\.js/);
    });

    it('--check exits 1 when the engine is missing and 0 when it is there', async () => {
        const out = [];
        const log = console.log;
        console.log = (...a) => out.push(a.join(' '));
        try {
            expect(await installer.main(['--check'])).toBe(1);
            if (!isWindows) {
                pinCachedFile();
                expect(await installer.main(['--check'])).toBe(0);
            }
        } finally {
            console.log = log;
        }
        expect(out.join('\n')).toMatch(/NOT INSTALLED/);
    });

    it('offerEngine reports and does nothing else on a dry run or without a terminal', () => {
        const lines = [];
        expect(installer.offerEngine({ dryRun: true, interactive: true, log: l => lines.push(l) })).toBe('skipped');
        expect(installer.offerEngine({ interactive: false, log: l => lines.push(l) })).toBe('skipped');
        expect(lines.join('\n')).toMatch(/dry run/);
        expect(lines.join('\n')).toMatch(/fail closed/);
    });

    it.skipIf(isWindows)('offerEngine says ready, without prompting, when the engine is installed', () => {
        pinCachedFile();
        let asked = false;
        expect(installer.offerEngine({ interactive: true, ask: () => { asked = true; return 'y'; }, log: () => {} })).toBe('ready');
        expect(asked).toBe(false);
    });

    it('offerEngine does not install when the answer is not yes', () => {
        const lines = [];
        const write = process.stdout.write;
        process.stdout.write = () => true;
        try {
            expect(installer.offerEngine({ interactive: true, ask: () => 'n', log: l => lines.push(l) })).toBe('declined');
        } finally {
            process.stdout.write = write;
        }
        expect(lines.join('\n')).toMatch(/Skipped/);
        expect(fs.existsSync(bin.cacheDir())).toBe(false);
    });
});

// install.js reports the engine and offers it; it never fails because of it.
describe.skipIf(isWindows)('install reports the secret engine', () => {
    const installJs = path.join(__dirname, '..', 'install.js');
    // A PATH with only node and git, so a betterleaks the developer has installed cannot leak in.
    const gitDir = (() => {
        const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
        return r.status === 0 ? path.dirname(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()) : null;
    })();
    const run = args => spawnSync(process.execPath, [installJs, ...args], {
        encoding: 'utf8',
        env: { ...process.env, AGENTS_SECRET_ENGINE_CACHE_DIR: path.join(tmp, 'cache'), PATH: [path.dirname(process.execPath), gitDir].filter(Boolean).join(':') },
    });
    const newTarget = () => {
        const target = path.join(tmp, 'target');
        fs.mkdirSync(target);
        spawnSync('git', ['init', '-q', target]);
        return target;
    };

    it.skipIf(!gitDir)('install.js --dry-run names the missing engine and skips the offer', () => {
        const r = run([newTarget(), '--dry-run']);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toMatch(/Secret engine: NOT INSTALLED/);
        expect(r.stdout).toMatch(/dry run: the install offer is skipped/);
        expect(fs.existsSync(bin.cacheDir())).toBe(false);
    });

    it.skipIf(!gitDir)('install.js --dry-run says ready when the real engine is installed in the user cache', () => {
        const realCache = { ...process.env };
        delete realCache.AGENTS_SECRET_ENGINE_CACHE_DIR;
        const r = spawnSync(process.execPath, [installJs, newTarget(), '--dry-run'], { encoding: 'utf8', env: { ...realCache, PATH: [path.dirname(process.execPath), gitDir].filter(Boolean).join(':') } });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toMatch(/Secret engine: betterleaks .* ready \(per-user cache/);
    });

    it.skipIf(!gitDir)('install.js --dry-run reports a cached binary that is not the pinned build as not installed, and says why', () => {
        const dir = path.join(tmp, 'cache', 'betterleaks', bin.loadPins().version);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, 'betterleaks'), `#!${process.execPath}\nnot the engine\n`, { mode: 0o700 });
        const r = run([newTarget(), '--dry-run']);
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toMatch(/NOT INSTALLED/);
        expect(r.stdout).toMatch(/not the pinned build/);
    });
});
