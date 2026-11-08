#!/usr/bin/env node
'use strict';

/**
 * secret-engine-install.js — fetch the pinned secret-scanning engine (Betterleaks) into the
 * per-user cache, verifying its sha256 before anything is extracted.
 *
 * The version and the sha256 of every platform asset are pinned in
 * .agents/config/secret-engine.json. The checksum is never fetched from the network: a download
 * that does not hash to the pinned value is refused and nothing is written to the cache.
 *
 * Usage:
 *   node .claude/core/secret-engine-install.js            install (or confirm) the pinned engine
 *   node .claude/core/secret-engine-install.js --check    report status only; exit 1 when missing
 *   node .claude/core/secret-engine-install.js --force    reinstall even when already available
 *
 * A betterleaks of the pinned version already on PATH is accepted as is (no download).
 * Windows, macOS and Linux on x64 and arm64 have published assets. Node builtins only: https for
 * the download, zlib plus a minimal tar/zip reader for extraction (no system tar needed).
 *
 * Environment (tests / mirrors): AGENTS_SECRET_ENGINE_CACHE_DIR relocates the cache;
 * AGENTS_SECRET_ENGINE_RELEASE_BASE replaces the download base URL (plain http is accepted for a
 * loopback host only). The pinned sha256 still applies to whatever the mirror serves.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const bin = require('./_lib/secret-engine-bin');

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60000;        // no data for this long
const DOWNLOAD_TOTAL_MS = 180000;         // the whole download, however slowly it trickles
const MAX_REDIRECTS = 5;

// ── archive readers ───────────────────────────────────────────────────────────

function tarString(block, start, length) {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/** Contents of the regular file whose basename is `wanted` in a tar archive buffer, or null. */
function readTarEntry(tar, wanted) {
    let offset = 0;
    let longName = null;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(b => b === 0)) break;
        const size = parseInt(tarString(header, 124, 12).trim() || '0', 8);
        if (!Number.isFinite(size) || size < 0) throw new Error('tar: unreadable entry size');
        const type = String.fromCharCode(header[156] || 48);
        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        if (dataEnd > tar.length) throw new Error('tar: entry runs past the end of the archive');
        if (type === 'L') {
            longName = tarString(tar.subarray(dataStart, dataEnd), 0, size);
        } else if (type === 'x' || type === 'g') {
            // pax extended header: not needed to locate a plain binary
        } else if (type === '0') {
            const prefix = tarString(header, 345, 155);
            const name = longName || (prefix ? `${prefix}/` : '') + tarString(header, 0, 100);
            longName = null;
            if (path.posix.basename(name.replace(/\\/g, '/')) === wanted) return tar.subarray(dataStart, dataEnd);
        } else {
            longName = null;
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
    }
    return null;
}

function readTarGzEntry(archive, wanted) {
    return readTarEntry(zlib.gunzipSync(archive), wanted);
}

/** Contents of the file whose basename is `wanted` in a zip archive buffer, or null. */
function readZipEntry(zip, wanted) {
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('zip: end-of-central-directory record not found');
    const count = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
        const method = zip.readUInt16LE(p + 10);
        const compressed = zip.readUInt32LE(p + 20);
        const nameLen = zip.readUInt16LE(p + 28);
        const extraLen = zip.readUInt16LE(p + 30);
        const commentLen = zip.readUInt16LE(p + 32);
        const localOffset = zip.readUInt32LE(p + 42);
        const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
        p += 46 + nameLen + extraLen + commentLen;
        if (path.posix.basename(name.replace(/\\/g, '/')) !== wanted) continue;
        if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: bad local header');
        const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
        const data = zip.subarray(dataStart, dataStart + compressed);
        if (method === 0) return data;
        if (method === 8) return zlib.inflateRawSync(data);
        throw new Error(`zip: unsupported compression method ${method}`);
    }
    return null;
}

// ── download ──────────────────────────────────────────────────────────────────

function isLoopback(url) {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
}

function fetchBuffer(url, { allowLoopbackHttp = false, timeoutMs = DOWNLOAD_TIMEOUT_MS, totalMs = DOWNLOAD_TOTAL_MS, deadline = Date.now() + totalMs, hops = 0 } = {}) {
    return new Promise((resolve, reject) => {
        if (Date.now() >= deadline) { reject(new Error('download exceeded its total time limit')); return; }
        let u;
        try { u = new URL(url); } catch (err) { reject(err); return; }
        const client = u.protocol === 'https:' ? https : (u.protocol === 'http:' && allowLoopbackHttp && isLoopback(u) ? http : null);
        if (!client) { reject(new Error(`refusing to download over ${u.protocol} (https only): ${u.href}`)); return; }
        let req;
        // req.setTimeout below resets whenever bytes arrive; this timer is the cap on the whole transfer.
        const total = setTimeout(() => req && req.destroy(new Error('download exceeded its total time limit')), Math.max(1, deadline - Date.now()));
        const done = fn => value => { clearTimeout(total); fn(value); };
        const finish = done(resolve);
        const fail = done(reject);
        req = client.get(u, { headers: { 'User-Agent': 'domdhi-agents-secret-engine-install' } }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume();
                if (hops >= MAX_REDIRECTS || !res.headers.location) { fail(new Error('too many redirects')); return; }
                clearTimeout(total);
                resolve(fetchBuffer(new URL(res.headers.location, u).href, { allowLoopbackHttp, timeoutMs, totalMs, deadline, hops: hops + 1 }));
                return;
            }
            if (res.statusCode !== 200) { res.resume(); fail(new Error(`HTTP ${res.statusCode} from ${u.href}`)); return; }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_DOWNLOAD_BYTES) req.destroy(new Error('download exceeds the size ceiling'));
                else chunks.push(chunk);
            });
            res.on('end', () => finish(Buffer.concat(chunks)));
            res.on('error', fail);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`download timed out after ${timeoutMs} ms`)));
        req.on('error', fail);
    });
}

// ── install ───────────────────────────────────────────────────────────────────

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Download, verify and install the pinned engine for this platform into the per-user cache.
 * Throws (and leaves the cache untouched) on an unsupported platform, a download failure, a
 * checksum mismatch, a missing binary in the archive, or a wrong version after extraction.
 *
 * @param {{ fetch?: (url: string) => Promise<Buffer>, log?: (line: string) => void, pins?: object }} [options]
 *   `fetch` and `pins` are test seams; the CLI uses the real download and the pinned file.
 * @returns {Promise<{ bin: string, version: string, sha256: string }>}
 */
async function installEngine({ fetch, log = () => {}, pins = bin.loadPins() } = {}) {
    const asset = bin.pinnedAsset(pins);
    if (!asset) {
        const err = new Error(`no published ${pins.engine} ${pins.version} asset for ${process.platform}/${process.arch}. Install it yourself and put it on PATH (version ${pins.version}).`);
        err.code = 'UNSUPPORTED_PLATFORM';
        throw err;
    }
    const base = (process.env.AGENTS_SECRET_ENGINE_RELEASE_BASE || pins.releaseBase).replace(/\/+$/, '');
    const url = `${base}/${asset.file}`;
    const getter = fetch || (u => fetchBuffer(u, { allowLoopbackHttp: Boolean(process.env.AGENTS_SECRET_ENGINE_RELEASE_BASE) }));

    log(`Downloading ${asset.file} ...`);
    const archive = await getter(url);
    const actual = sha256(archive);
    if (actual !== asset.sha256) {
        const err = new Error(`checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${actual}. Refusing to install.`);
        err.code = 'CHECKSUM_MISMATCH';
        throw err;
    }
    log(`Checksum verified (sha256 ${actual.slice(0, 12)}...)`);

    const binary = asset.file.endsWith('.zip') ? readZipEntry(archive, asset.binary) : readTarGzEntry(archive, asset.binary);
    if (!binary || binary.length === 0) throw new Error(`${asset.binary} was not found in ${asset.file}`);
    // The archive hash proves the download; this proves what came out of it is the binary the toolkit pinned.
    if (!asset.binarySha256 || sha256(binary) !== asset.binarySha256) {
        const err = new Error(`the extracted ${asset.binary} does not match the pinned binary hash. Refusing to install.`);
        err.code = 'BINARY_MISMATCH';
        throw err;
    }

    const dir = bin.cacheDir(pins);
    const target = path.join(dir, bin.binaryName());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const unsafe = bin.unsafeOwnership(dir);
    if (unsafe) throw new Error(`refusing to install into an unsafe cache directory: ${unsafe}`);
    const staging = `${target}.partial-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        fs.writeFileSync(staging, binary, { mode: 0o700 }); // fs-safe-lint:local — per-user cache dir, not an adopter path
        if (process.platform !== 'win32') fs.chmodSync(staging, 0o700);
        const version = bin.binaryVersion(staging);
        if (version !== pins.version) {
            throw new Error(`the extracted binary reports version ${version || 'unknown'}, expected ${pins.version}. Refusing to install.`);
        }
        fs.renameSync(staging, target);
    } catch (err) {
        try { fs.rmSync(staging, { force: true }); } catch { /* best effort */ } // fs-safe-lint:local — our own staging file in the per-user cache
        throw err;
    }
    bin.forgetResolution();
    bin.verifyBinary(target, pins);   // records the check so the first hook run does not pay for the hash
    return { bin: target, version: pins.version, sha256: actual };
}

// ── CLI + helper for install.js / template-updater.js ─────────────────────────

function describeStatus(status) {
    if (status.available) {
        const where = status.source === 'cache' ? 'per-user cache' : status.source === 'path' ? 'PATH' : 'AGENTS_SECRET_ENGINE_BIN';
        return `Secret engine: betterleaks ${status.version || status.expectedVersion} ready (${where}: ${status.bin})`;
    }
    const why = status.reason && status.reason !== 'not-installed' && status.message ? ` ${status.message}` : '';
    return `Secret engine: NOT INSTALLED (need betterleaks ${status.expectedVersion} for ${status.platform || `${process.platform}/${process.arch}`}).${why} ${bin.installHint()}`;
}

function readLineSync() {
    const bytes = [];
    const buf = Buffer.alloc(1);
    for (;;) {
        let n;
        try { n = fs.readSync(0, buf, 0, 1, null); } catch { break; }
        if (n === 0 || buf[0] === 0x0a) break;
        if (buf[0] !== 0x0d) bytes.push(buf[0]);
    }
    return Buffer.from(bytes).toString('utf8');
}

/**
 * Report the engine status and, on an interactive terminal, offer to install it. Never installs
 * silently and never fails the caller. Used by install.js and `template-updater.js update`.
 *
 * @param {{ dryRun?: boolean, interactive?: boolean, ask?: () => string, log?: (line: string) => void }} [options]
 * @returns {'ready'|'declined'|'installed'|'failed'|'skipped'}
 */
function offerEngine({ dryRun = false, interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY), ask = readLineSync, log = console.log } = {}) {
    let status;
    try { status = bin.engineStatus(); } catch (err) {
        log(`Secret engine: status unavailable (${err.message})`);
        return 'failed';
    }
    log(describeStatus(status));
    if (status.available) return 'ready';
    if (dryRun) { log('  (dry run: the install offer is skipped)'); return 'skipped'; }
    if (!interactive) {
        log('  Commits and Write/Edit will be blocked until it is installed (fail closed).');
        return 'skipped';
    }
    const pins = bin.loadPins();
    process.stdout.write(`  Download betterleaks ${pins.version} (about 10 MB, sha256 pinned in the toolkit) into ${bin.cacheDir(pins)}? [y/N] `);
    const answer = String(ask() || '').trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
        log('  Skipped. Install later with: ' + bin.installCommand());
        return 'declined';
    }
    const r = spawnSync(process.execPath, [__filename], { stdio: 'inherit', windowsHide: true });
    return r.status === 0 ? 'installed' : 'failed';
}

async function main(argv = process.argv.slice(2)) {
    const check = argv.includes('--check');
    const force = argv.includes('--force');
    let status;
    try { status = bin.engineStatus({ fresh: true }); } catch (err) {
        console.error(`secret-engine-install: ${err.message}`);
        return 1;
    }
    if (check) {
        console.log(describeStatus(status));
        return status.available ? 0 : 1;
    }
    if (status.available && !force) {
        console.log(describeStatus(status));
        return 0;
    }
    try {
        const result = await installEngine({ log: line => console.log(line) });
        console.log(`Installed betterleaks ${result.version} at ${result.bin}`);
        return 0;
    } catch (err) {
        console.error(`secret-engine-install: ${err.message}`);
        return err.code === 'UNSUPPORTED_PLATFORM' ? 2 : 1;
    }
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }, err => { console.error(err); process.exitCode = 1; });
}

module.exports = { installEngine, offerEngine, describeStatus, readTarEntry, readTarGzEntry, readZipEntry, fetchBuffer, sha256, main };
