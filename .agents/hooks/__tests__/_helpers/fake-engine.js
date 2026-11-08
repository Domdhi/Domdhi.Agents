'use strict';

// A stand-in for the secret engine binary that runs on every platform, Windows included, and that
// passes the engine's identity check honestly.
//
// A fake engine is the node binary itself (a link or a copy) under a fixed name. A preload script,
// loaded through NODE_OPTIONS, recognises an engine-style invocation (the first argument is an engine
// subcommand: stdin, dir, version or config) and makes the test's script the program that runs; every
// other node process that inherits NODE_OPTIONS (the hooks under test, commit.js) ignores that part.
//
// IDENTITY. Production code accepts only a binary whose sha256 equals the pinned one, and nothing in
// the environment changes that (no NODE_ENV, VITEST or flag skips it). So a test pins the FAKE's real
// sha256 instead: in this process through setPinsForTests (kit.usePins()), and in a hook process that
// the test spawns through the same preload, which calls setPinsForTests from inside that process before
// the hook loads. Only code that runs inside the process can do either; a spawned hook that does not
// load this preload (a plain environment) sees the production pins and refuses the fake. That is
// asserted in secret-engine.test.js.
//
//   const kit = createFakeEngineKit(dir);
//   kit.apply('console.log("[]")');                  // what the fake does when it is run (this process + children)
//   kit.usePins();                                   // this process accepts the fake
//   process.env.AGENTS_SECRET_ENGINE_BIN = kit.exe();
//   ...
//   kit.restore();
//
// The script sees process.argv as [node, script, <subcommand>, ...flags] and runs to completion like
// any node script (read stdin, print JSON, process.exit(n)).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN_LIB = path.resolve(__dirname, '..', '..', '..', 'core', '_lib', 'secret-engine-bin.js');

const PRELOAD = `
'use strict';
const path = require('path');
const Module = require('module');
const oldMain = process.argv[1] || '';
const sub = path.basename(oldMain);
const engineCall = sub === 'stdin' || sub === 'dir' || sub === 'version' || sub === 'config';
if (process.env.FAKE_ENGINE_BODY && engineCall) {
    // Node resolves the main script after the preloads run: point that lookup at the test's script.
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
        if (isMain && request === oldMain) return process.env.FAKE_ENGINE_BODY;
        return resolve.call(this, request, parent, isMain, options);
    };
    process.argv.splice(1, 1, process.env.FAKE_ENGINE_BODY, sub);
} else if (process.env.FAKE_ENGINE_PINS && !engineCall) {
    // A hook (or commit.js) the test spawned: it must accept the fake, so give it the fake's pins.
    try {
        require(${JSON.stringify(BIN_LIB)}).setPinsForTests(JSON.parse(require('fs').readFileSync(process.env.FAKE_ENGINE_PINS, 'utf8')));
    } catch (err) { process.stderr.write('fake-engine preload: ' + err.message + '\\n'); }
}
`;

// One stable executable per node binary, outside any test directory, so the (large) hash of it is
// computed once and remembered rather than once per test.
function stableExe() {
    const tag = crypto.createHash('sha1').update(process.execPath).digest('hex').slice(0, 10);
    const dir = path.join(os.tmpdir(), 'domdhi-fake-engine', tag);
    const file = path.join(dir, process.platform === 'win32' ? 'fake-engine.exe' : 'fake-engine');
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
        if (!fs.existsSync(file) || fs.statSync(file).size !== fs.statSync(process.execPath).size) fs.copyFileSync(process.execPath, file);
    } else {
        let current = null;
        try { current = fs.readlinkSync(file); } catch { /* absent */ }
        if (current !== process.execPath) {
            try { fs.rmSync(file, { force: true }); } catch { /* absent */ }
            fs.symlinkSync(process.execPath, file);
        }
    }
    return file;
}

let hashed = null;
function fakeHash(file) {
    if (!hashed || hashed.file !== file) hashed = { file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    return hashed.sha256;
}

function createFakeEngineKit(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const bin = require(BIN_LIB);
    const preload = path.join(dir, 'fake-engine-preload.cjs');
    fs.writeFileSync(preload, PRELOAD);
    const exePath = stableExe();
    const pinsFile = path.join(dir, 'fake-engine-pins.json');
    let counter = 0;
    const saved = {};

    const pins = () => {
        const real = JSON.parse(JSON.stringify(bin.loadPins()));
        const key = bin.platformKey();
        // The fake is its own "release": same version, and the binary hash of the fake.
        real.assets[key] = { ...real.assets[key], binarySha256: fakeHash(exePath) };
        return real;
    };
    const writePins = () => { fs.writeFileSync(pinsFile, JSON.stringify(pins())); return pinsFile; };
    const bodyFile = body => {
        const file = path.join(dir, `fake-engine-body-${++counter}.cjs`);
        fs.writeFileSync(file, body);
        return file;
    };

    return {
        /** The fake executable (a stable path; the argument is accepted for readability and ignored). */
        exe() { return exePath; },
        pins,
        /** This process accepts the fake as the engine (resetForTests clears it, so call this after any reset). */
        usePins() { bin.setPinsForTests(pins()); },
        /** Write the fake's behaviour and make every engine-style invocation, in this process and its children, run it. */
        apply(body) {
            const file = bodyFile(body);
            for (const key of ['FAKE_ENGINE_BODY', 'FAKE_ENGINE_PINS', 'NODE_OPTIONS']) if (!(key in saved)) saved[key] = process.env[key];
            process.env.FAKE_ENGINE_BODY = file;
            process.env.FAKE_ENGINE_PINS = writePins();
            process.env.NODE_OPTIONS = `${saved.NODE_OPTIONS ? `${saved.NODE_OPTIONS} ` : ''}--require ${JSON.stringify(preload)}`;
            return file;
        },
        /** Environment for a child process only (does not touch process.env). Includes the pins the child needs. */
        childEnv(body) {
            return { FAKE_ENGINE_BODY: bodyFile(body), FAKE_ENGINE_PINS: writePins(), NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
        },
        /** The same child environment WITHOUT the pins: a production hook that is shown the fake must refuse it. */
        childEnvWithoutPins(body) {
            return { FAKE_ENGINE_BODY: bodyFile(body), NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
        },
        restore() {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key]; else process.env[key] = value;
                delete saved[key];
            }
        },
    };
}

module.exports = { createFakeEngineKit };
