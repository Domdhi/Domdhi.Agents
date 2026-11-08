'use strict';

/**
 * Locate the pinned secret-scanning engine (Betterleaks) on this machine, and prove it is the
 * binary the toolkit pinned.
 *
 * Where it looks (first hit wins):
 *   1. AGENTS_SECRET_ENGINE_BIN   explicit override.
 *   2. the per-user cache         {AGENTS_SECRET_ENGINE_CACHE_DIR | XDG_CACHE_HOME | ~/.cache | %LOCALAPPDATA%}
 *                                 /domdhi-agents/betterleaks/<version>/betterleaks[.exe], written by
 *                                 secret-engine-install.js.
 *   3. `betterleaks` on PATH      absolute PATH entries only; a relative entry (".", "node_modules/.bin")
 *                                 is repo-controlled and never searched.
 *
 * IDENTITY. Whichever candidate wins, its sha256 must equal `binarySha256` for this platform in
 * .agents/config/secret-engine.json (the hash of the binary extracted from the pinned release). A
 * version string is not identity: any program can print one. A mismatch is refused (reason
 * "binary-hash-mismatch") and callers fail closed. The hash of a 25 MB binary costs about 60 ms, so
 * a successful check is remembered per process and in a small record beside the cache, keyed on
 * path + size + mtime + inode + ctime; any change to the file forces a new hash.
 *
 * Nothing here downloads anything. Leaf module: Node builtins only, no imports from core/ CLIs.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PINS_PATH = path.join(__dirname, '..', '..', 'config', 'secret-engine.json');
const VERSION_TIMEOUT_MS = 5000;

class EngineUnavailableError extends Error {
    constructor(message, detail) {
        super(message);
        this.name = 'EngineUnavailableError';
        this.code = 'ENGINE_UNAVAILABLE';
        this.detail = detail || null;
    }
}

let pinsCache = null;
let pinsOverride = null;

function loadPins() {
    if (pinsOverride) return pinsOverride;
    if (pinsCache) return pinsCache;
    const pins = JSON.parse(fs.readFileSync(PINS_PATH, 'utf8'));
    if (!pins || typeof pins.version !== 'string' || !pins.assets || typeof pins.assets !== 'object') {
        throw new Error(`secret-engine: malformed pins file ${PINS_PATH}`);
    }
    pinsCache = pins;
    return pins;
}

/** 'linux-x64' | 'darwin-arm64' | 'windows-x64' ... or null when the platform has no published asset. */
function platformKey(platform = process.platform, arch = process.arch) {
    const osName = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[platform];
    const cpu = { x64: 'x64', arm64: 'arm64' }[arch];
    return osName && cpu ? `${osName}-${cpu}` : null;
}

function pinnedAsset(pins = loadPins(), key = platformKey()) {
    return key && pins.assets[key] ? { key, ...pins.assets[key] } : null;
}

function cacheRoot(env = process.env, platform = process.platform) {
    if (env.AGENTS_SECRET_ENGINE_CACHE_DIR) return path.resolve(env.AGENTS_SECRET_ENGINE_CACHE_DIR);
    if (platform === 'win32') {
        return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'domdhi-agents');
    }
    return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'domdhi-agents');
}

// Two cache paths on purpose: the engine binary lives in a per-version directory (cacheDir) so a
// version bump never reuses an old binary, while the verification records live one level up
// (cacheRoot/betterleaks) because they describe binaries from any source. Both honor the same
// AGENTS_SECRET_ENGINE_CACHE_DIR override.
function cacheDir(pins = loadPins(), env = process.env, platform = process.platform) {
    return path.join(cacheRoot(env, platform), 'betterleaks', pins.version);
}

function binaryName(platform = process.platform) {
    return platform === 'win32' ? 'betterleaks.exe' : 'betterleaks';
}

function isExecutableFile(file) {
    try {
        if (!fs.statSync(file).isFile()) return false;
        if (process.platform === 'win32') return true;
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * POSIX only: a directory the engine is run from must belong to the current user and not be
 * writable by group or others. Returns null when fine, else a short reason.
 */
function unsafeOwnership(target) {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
    try {
        const st = fs.statSync(target);
        if (st.uid !== process.getuid()) return `${target} is not owned by the current user`;
        if (st.mode & 0o022) return `${target} is writable by group or others`;
        return null;
    } catch (err) {
        return err.code === 'ENOENT' ? null : `${target}: ${err.message}`;
    }
}

function scrubbedEnv() {
    // Betterleaks reads BETTERLEAKS_* / GITLEAKS_* settings from the environment; none may steer a hook scan.
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!/^(?:BETTERLEAKS|GITLEAKS)_/i.test(k)) env[k] = v;
    }
    return env;
}

/** Runs `<bin> version` and returns the trimmed version without a leading "v", or null when it cannot be read. */
function binaryVersion(bin) {
    const r = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS, windowsHide: true, env: scrubbedEnv() });
    if (r.error || r.status !== 0) return null;
    const first = String(r.stdout || '').trim().split(/\r?\n/)[0] || '';
    return first.replace(/^v/i, '') || null;
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findOnPath(name, env = process.env) {
    const sep = process.platform === 'win32' ? ';' : ':';
    for (const dir of String(env.PATH || env.Path || '').split(sep)) {
        // A relative entry resolves against the working directory, which a cloned repo controls.
        if (!dir || !path.isAbsolute(dir)) continue;
        const candidate = path.join(dir, name);
        if (isExecutableFile(candidate)) return candidate;
    }
    return null;
}

// ── identity verification ─────────────────────────────────────────────────────

const verifiedThisProcess = new Map();

function fileKey(file) {
    const st = fs.statSync(file);
    return { path: file, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs };
}

const sameKey = (a, b) => a && b && a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.ctimeMs === b.ctimeMs;

function recordFile() {
    return path.join(cacheRoot(), 'betterleaks', 'verified.json');
}

function readRecords() {
    try {
        const rec = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
        return rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : {};
    } catch {
        return {};
    }
}

function writeRecord(key, sha256) {
    try {
        const records = readRecords();
        // Forget records of binaries that no longer exist (temporary installs, removed fakes) so the file stays small.
        for (const known of Object.keys(records)) {
            try { fs.statSync(known); } catch { delete records[known]; }
        }
        records[key.path] = { ...key, sha256 };
        const file = recordFile();
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify(records), { mode: 0o600 }); // fs-safe-lint:local — per-user cache dir, not an adopter path
    } catch { /* a record is an optimisation; the hash is recomputed without it */ }
}

/**
 * Prove `file` is the pinned binary for this platform. Throws EngineUnavailableError when it is not.
 * @returns {string} the verified sha256
 */
function verifyBinary(file, pins = loadPins()) {
    // No environment variable, test runner or build flag skips this. A test pins a fake binary's identity
    // through setPinsForTests (below), which only code running inside the process can call.
    const asset = pinnedAsset(pins);
    if (!asset || !asset.binarySha256) {
        throw new EngineUnavailableError(
            `no pinned binary hash for ${process.platform}/${process.arch}, so no engine can be verified here.`,
            { reason: 'unsupported-platform' });
    }
    let key;
    try { key = fileKey(file); } catch (err) {
        throw new EngineUnavailableError(`cannot read the engine binary ${file}: ${err.message}`, { reason: 'unreadable' });
    }
    const memo = verifiedThisProcess.get(file);
    if (memo && sameKey(memo.key, key) && memo.sha256 === asset.binarySha256) return memo.sha256;
    const rec = readRecords()[file];
    if (rec && sameKey(rec, key) && rec.sha256 === asset.binarySha256) {
        verifiedThisProcess.set(file, { key, sha256: rec.sha256 });
        return rec.sha256;
    }
    const actual = sha256File(file);
    if (actual !== asset.binarySha256) {
        throw new EngineUnavailableError(
            `the engine binary ${file} is not the pinned build (sha256 ${actual.slice(0, 12)}..., expected ${asset.binarySha256.slice(0, 12)}...). Refusing to run it.`,
            { reason: 'binary-hash-mismatch', found: actual, expected: asset.binarySha256, bin: file });
    }
    verifiedThisProcess.set(file, { key, sha256: actual });
    writeRecord(key, actual);
    return actual;
}

// ── resolution ────────────────────────────────────────────────────────────────

let resolved = null;

/**
 * @returns {{ bin: string, source: 'env'|'cache'|'path', version: string|null, sha256: string|null }}
 * @throws {EngineUnavailableError} when no usable, verified engine exists
 */
function resolveEngine({ fresh = false } = {}) {
    if (resolved && !fresh && isExecutableFile(resolved.bin)) {
        // Cheap re-check of the same file (stat only unless it changed on disk).
        verifyBinary(resolved.bin);
        return resolved;
    }
    resolved = null;
    const pins = loadPins();

    const found = (bin, source) => {
        const sha256 = verifyBinary(bin, pins);
        resolved = { bin, source, version: pins.version, sha256 };
        return resolved;
    };

    const override = process.env.AGENTS_SECRET_ENGINE_BIN;
    if (override) {
        if (!isExecutableFile(override)) {
            throw new EngineUnavailableError(`AGENTS_SECRET_ENGINE_BIN is set but is not an executable file: ${override}`, { reason: 'override-missing' });
        }
        return found(override, 'env');
    }

    const dir = cacheDir(pins);
    const cached = path.join(dir, binaryName());
    if (isExecutableFile(cached)) {
        const unsafe = unsafeOwnership(dir) || unsafeOwnership(cached);
        if (unsafe) throw new EngineUnavailableError(`the engine cache is not safe to run from: ${unsafe}.`, { reason: 'cache-unsafe' });
        return found(cached, 'cache');
    }

    const onPath = findOnPath(binaryName());
    if (onPath) return found(onPath, 'path');

    throw new EngineUnavailableError(`secret engine (betterleaks ${pins.version}) is not installed.`, { reason: 'not-installed' });
}

/** The command that installs the engine, written for the runtime that is running. */
function installCommand() {
    const dir = process.env.AGENTS_RUNTIME === 'codex' ? '.codex' : '.claude';
    return `node ${dir}/core/secret-engine-install.js`;
}

function installHint() {
    return `Install it with: ${installCommand()}`;
}

/** Same resolution as resolveEngine, reported as data instead of thrown. */
function engineStatus(options) {
    const pins = loadPins();
    const asset = pinnedAsset(pins);
    try {
        const r = resolveEngine(options);
        return { available: true, ...r, expectedVersion: pins.version, platform: asset ? asset.key : platformKey() };
    } catch (err) {
        if (!(err instanceof EngineUnavailableError)) throw err;
        return { available: false, reason: err.detail ? err.detail.reason : 'unavailable', message: err.message, expectedVersion: pins.version, platform: asset ? asset.key : platformKey(), cacheDir: cacheDir(pins) };
    }
}

/** Drop the per-process resolution (the installer calls this after it adds a binary). */
function forgetResolution() {
    resolved = null;
    verifiedThisProcess.clear();
}

function resetForTests() {
    resolved = null;
    pinsCache = null;
    pinsOverride = null;
    verifiedThisProcess.clear();
}

/**
 * Test seam: replace the pins (a fake release whose binary hash is the fake engine's) until resetForTests().
 * It is a function, not a setting: nothing in the environment can call it.
 */
function setPinsForTests(pins) {
    pinsOverride = pins;
    resolved = null;
    verifiedThisProcess.clear();
}

module.exports = {
    EngineUnavailableError,
    PINS_PATH,
    loadPins,
    platformKey,
    pinnedAsset,
    cacheRoot,
    cacheDir,
    binaryName,
    binaryVersion,
    sha256File,
    unsafeOwnership,
    scrubbedEnv,
    verifyBinary,
    resolveEngine,
    engineStatus,
    installCommand,
    installHint,
    forgetResolution,
    resetForTests,
    setPinsForTests,
};
