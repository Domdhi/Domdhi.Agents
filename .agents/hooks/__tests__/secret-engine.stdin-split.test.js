// The engine reads its input in chunks and cuts a chunk at an arbitrary byte when no blank line is near, so a secret
// sitting on a cut matched in neither half and was never reported (a 170 KB JSON manifest lost a token this way, on
// stdin; `dir` mode does the same past 100 KB). secret-engine.cjs now scans input the engine cannot read in one chunk
// itself, in overlapping windows staged as files (scanWindows), and routes a file over 100,000 bytes the same way.
//
// Coverage:
//   - the real engine: back-to-back tokens in input of 200 KB to 900 KB (the cuts fall in tokens) are all found,
//     once each, on the right line, through scanContent, scanFiles (batch with small files), a manifest layout, one
//     giant line, multibyte text and a value repeated on one line; a window never ends inside a line (half a digest would
//     no longer be exempt), and a half cut off a too-long line is not reported; allow markers and redaction still work on big input
//   - a fake engine that records what it was given: small input (<= 24,000 bytes) is still ONE stdin run and stages
//     nothing; bigger input is ONE dir run of windows under the private cache (the plan: size, newline, line starts,
//     coverage, overlap, attributed path), removed afterwards; a window the engine skips or miscounts fails closed
//     with the fixed wording; in scanFiles a file over 100,000 bytes is kept out of the batch, one of exactly 100,000
//     stays in it
//
// Key-shaped fixtures are generated at run time and built from parts; this file holds no key literal.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const engine = require('../../../.agents/hooks/secret-engine.cjs');
const binLib = require('../../../.agents/core/_lib/secret-engine-bin');
const { createFakeEngineKit } = require('./_helpers/fake-engine');

const j = (...p) => p.join('');
const MARK = j('betterleaks', ':allow');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const token = () => j('gh', 'p_') + [...crypto.randomBytes(36)].map(b => ALNUM[b % ALNUM.length]).join('');
const isGithub = f => /GitHub/.test(f.name);

const savedEnv = {};
const touched = ['AGENTS_SECRET_ENGINE_CACHE_DIR', 'AGENTS_SECRET_ENGINE_BIN', 'CLAUDE_PROJECT_DIR', 'SECRET_ENGINE_QUIET'];
let tmp;
let cache;
let parent;
let kit;

beforeEach(() => {
    for (const k of touched) savedEnv[k] = process.env[k];
    const realBin = binLib.resolveEngine().bin; // the real, hash-verified engine, found BEFORE the cache moves
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-split-'));
    cache = path.join(tmp, 'cache');
    parent = path.join(cache, 'betterleaks');
    kit = createFakeEngineKit(path.join(tmp, 'kit'));
    process.env.AGENTS_SECRET_ENGINE_CACHE_DIR = cache;
    process.env.AGENTS_SECRET_ENGINE_BIN = realBin;
    process.env.CLAUDE_PROJECT_DIR = tmp;
    process.env.SECRET_ENGINE_QUIET = '1';
    engine.resetForTests();
});
afterEach(() => {
    kit.restore();
    for (const k of touched) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    engine.resetForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const stages = () => (fs.existsSync(parent) ? fs.readdirSync(parent).filter(n => n.startsWith('scan-')) : []);

/** One token per line, back to back (41 bytes a line, no blank line): every cut the engine makes falls inside a token. */
function denseTokens(bytes) {
    const tokens = Array.from({ length: Math.floor(bytes / 41) }, token);
    return { tokens, text: `${tokens.join('\n')}\n` };
}

/** Each token is found exactly once, on its own line (1-based), and nothing else is reported. */
function expectEveryTokenOnce(findings, tokens) {
    const hits = findings.filter(isGithub);
    const byLine = new Map();
    for (const f of hits) byLine.set(f.line, (byLine.get(f.line) || 0) + 1);
    const missing = tokens.map((_, i) => i + 1).filter(l => !byLine.has(l));
    const doubled = [...byLine].filter(([, n]) => n > 1).map(([l]) => l);
    expect({ missing: missing.slice(0, 5), doubled: doubled.slice(0, 5), total: hits.length }).toEqual({ missing: [], doubled: [], total: tokens.length });
    expect(findings.length).toBe(tokens.length);
}

describe('the real engine on input it would cut', () => {
    it('finds every token in 200 KB through scanContent (the cuts fall inside tokens)', { timeout: 60000 }, () => {
        const { tokens, text } = denseTokens(200000);
        expectEveryTokenOnce(engine.scanContent(text, 'notes/dense.txt', { wholeFile: false }), tokens);
    });

    it('finds every token in 900 KB, with the overlap of the windows reported once', { timeout: 120000 }, () => {
        const { tokens, text } = denseTokens(900000);
        expectEveryTokenOnce(engine.scanContent(text, 'notes/dense.txt', { wholeFile: false }), tokens);
    });

    it('finds a token in a manifest layout (one "path": "value", entry per line) wherever the engine used to cut it', { timeout: 60000 }, () => {
        // The layout of the file that lost a token: a path-to-value entry per line, no blank line. Every value is a token here.
        const tokens = Array.from({ length: 3200 }, token);
        const entries = tokens.map((t, i) => `    "src/M${i % 40}/C${i}.cs": "${t}",`);
        const text = `{\n${entries.join('\n')}\n}\n`;
        expect(Buffer.byteLength(text)).toBeGreaterThan(150000);
        const found = engine.scanContent(text, 'notes/after.json', { wholeFile: false });
        expect(found.every(isGithub)).toBe(true);
        expect(found.map(f => f.line)).toEqual(tokens.map((_, i) => i + 2)); // the opening brace is line 1
    });

    it('does not hand the engine half a line: hex digests in a path-exempt file stay exempt over several windows', { timeout: 60000 }, () => {
        // render-state.json is exempt for 32..128-hex values by path; a window that ended inside a line would show the engine a
        // truncated digest (35 of 64 characters) that is no longer one of those lengths, and it would be reported.
        const lines = Array.from({ length: 6000 }, () => `  "apiToken": "${crypto.randomBytes(32).toString('hex')}",`);
        expect(engine.scanContent(`${lines.join('\n')}\n`, 'state/render-state.json', { wholeFile: false })).toEqual([]);
    });

    it('does not report the half of a value a cut leaves at the edge of a window, on a line too long to snap', { timeout: 60000 }, () => {
        const entries = Array.from({ length: 2300 }, () => `"apiToken": "${crypto.randomBytes(32).toString('hex')}",`);
        const text = `${entries.join('   ')}\n`;      // one line of about 188 KB
        expect(engine.scanContent(text, 'state/render-state.json', { wholeFile: false })).toEqual([]);
    });

    it('finds every token on one giant line (a minified bundle has no line to cut at)', { timeout: 60000 }, () => {
        const tokens = Array.from({ length: 5000 }, token);
        const found = engine.scanContent(`x = ${tokens.join(' ')}\n`, 'dist/app.min.js', { wholeFile: false }).filter(isGithub);
        expect(found.length).toBe(tokens.length);
        expect(new Set(found.map(f => f.line))).toEqual(new Set([1]));
    });

    it('finds every token in text whose characters are more than one byte (windows are cut by bytes, never inside a character)', { timeout: 60000 }, () => {
        const tokens = Array.from({ length: 3500 }, token);
        const text = `${tokens.map(t => `é日本語 ${t}`).join(' ')}\nend\n`;
        expect(engine.scanContent(text, 'notes/utf8.txt', { wholeFile: false }).filter(isGithub).length).toBe(tokens.length);
    });

    it('keeps a value repeated on one giant line as that many findings, not fewer and not more', { timeout: 60000 }, () => {
        const one = token();
        const found = engine.scanContent(`${Array(3000).fill(one).join(' ')}\n`, 'notes/repeat.txt', { wholeFile: false }).filter(isGithub);
        expect(found.length).toBe(3000);
    });

    it('still honors an allow marker, and reports the other secret on the exact line, in big input', { timeout: 60000 }, () => {
        const { text } = denseTokens(160000);
        const rows = text.split('\n');
        rows[1000] = `${token()} // ${MARK}`;   // line 1001 (marker beside the key: suppressed)
        rows[3000] = `${token()} // note`;       // line 3001 (a comment without the marker: reported)
        const found = engine.scanContent(rows.join('\n'), 'notes/dense.txt', { wholeFile: false }).filter(isGithub);
        expect(found.some(f => f.line === 1001)).toBe(false);
        expect(found.filter(f => f.line === 3001).length).toBe(1);
        expect(found.length).toBe(rows.length - 1 /* trailing empty row */ - 1 /* suppressed */);
    });

    it('redacts every token in big input', { timeout: 60000 }, () => {
        const { tokens, text } = denseTokens(160000);
        const out = engine.redactSecretsInText(text, 'notes/dense.txt', { wholeFile: false });
        expect(tokens.some(t => out.includes(t))).toBe(false);
        expect((out.match(/<REDACTED:/g) || []).length).toBe(tokens.length);
    });

    // The engine reads 0 bytes of a staged file whose NAME says archive (`*.gz`) and logs no skip, so windows staged under
    // that name were never scanned: the text projection of a compressed capture over 24,000 bytes failed the whole scan.
    it('scans big input attributed to a .gz path (windows fall back to a neutral name the engine reads)', { timeout: 60000 }, () => {
        const { tokens, text } = denseTokens(60000);
        expectEveryTokenOnce(engine.scanContent(text, 'evidence/run.after.json.gz', { wholeFile: false }), tokens);
    });

    it('scanFiles: a text file over 100,000 bytes named .gz is scanned in windows, not failed', { timeout: 60000 }, () => {
        const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
        const { tokens, text } = denseTokens(140000);
        fs.writeFileSync(path.join(root, 'capture.json.gz'), text);
        const results = engine.scanFiles(root, ['capture.json.gz']);
        expectEveryTokenOnce(results.get('capture.json.gz').findings, tokens);
        expect(stages()).toEqual([]);
    });

    it('scanFiles: a file over 100,000 bytes beside small ones in a batch is complete too', { timeout: 60000 }, () => {
        const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
        const { tokens, text } = denseTokens(180000);
        const small = token();
        fs.writeFileSync(path.join(root, 'big.txt'), text);
        fs.writeFileSync(path.join(root, 'small.txt'), `${small}\n`);
        fs.writeFileSync(path.join(root, 'clean.txt'), 'nothing here\n');
        const results = engine.scanFiles(root, ['big.txt', 'small.txt', 'clean.txt']);
        expect(results.batchMode).toBe('batch');
        expectEveryTokenOnce(results.get('big.txt').findings, tokens);
        expect(results.get('small.txt').findings.filter(isGithub).length).toBe(1);
        expect(results.get('clean.txt').findings).toEqual([]);
        expect(stages()).toEqual([]);
    });
});

// A fake engine that logs every run and dumps the files a dir run was given, then reports what it "scanned".
function recordingBody({ log, dump, skewBytes = 0, skipFirst = false }) {
    return `
const fs = require('fs'); const path = require('path');
const LOG = ${JSON.stringify(log)}; const DUMP = ${JSON.stringify(dump)};
const args = process.argv.slice(2);
if (args[0] === 'dir') {
  const stage = args[1]; const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(stage);
  let total = 0; const rec = [];
  for (const f of files) {
    const b = fs.readFileSync(f); total += b.length;
    const rel = path.relative(stage, f).split(path.sep).join('/');
    fs.writeFileSync(path.join(DUMP, encodeURIComponent(rel)), b);
    rec.push({ rel, size: b.length });
  }
  fs.appendFileSync(LOG, JSON.stringify({ sub: 'dir', stage, files: rec }) + '\\n');
  ${skipFirst ? 'process.stderr.write("DBG skipping binary file mime_type=application/zip path=" + JSON.stringify(files[0]) + "\\n");' : ''}
  process.stderr.write('INF scanned ~' + (total - ${skewBytes}) + ' bytes (1 B) in 1ms\\n');
  console.log('[]');
} else {
  const chunks = []; process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => {
    const n = Buffer.concat(chunks).length;
    fs.appendFileSync(LOG, JSON.stringify({ sub: 'stdin', bytes: n }) + '\\n');
    process.stderr.write('INF scanned ~' + n + ' bytes (1 B) in 1ms\\n');
    console.log('[]');
  });
}`;
}

describe('what the wrapper hands the engine', () => {
    let log;
    let dump;
    const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
    const useRecorder = (opts = {}) => {
        log = path.join(tmp, 'runs.log');
        dump = path.join(tmp, 'dump');
        fs.mkdirSync(dump, { recursive: true });
        engine.resetForTests();
        process.env.AGENTS_SECRET_ENGINE_BIN = kit.exe();
        kit.apply(recordingBody({ log, dump, ...opts }));
        kit.usePins();
    };
    // Lines that are all different, so a window can be located in the input by its own text.
    const linesOf = bytes => {
        let text = '';
        for (let i = 1; text.length < bytes; i++) text += `line ${String(i).padStart(7, '0')} of the input, plain text with nothing in it\n`;
        return text.slice(0, bytes);
    };

    it('keeps input up to 24,000 bytes on ONE stdin run and stages nothing', () => {
        useRecorder();
        engine.scanContent(linesOf(24000), 'src/a.js', { wholeFile: false });
        expect(runs()).toEqual([{ sub: 'stdin', bytes: 24000 }]);
        expect(stages()).toEqual([]);
        expect(fs.readdirSync(dump)).toEqual([]);
    });

    it('moves input of 24,001 bytes to ONE dir run of one window, never to stdin', () => {
        useRecorder();
        engine.scanContent(linesOf(24001), 'src/a.js', { wholeFile: false });
        const seen = runs();
        expect(seen.map(r => r.sub)).toEqual(['dir']);
        expect(seen[0].files).toEqual([{ rel: 'w0/src/a.js', size: 24002 }]); // the input behind one neutral newline
        expect(stages()).toEqual([]);
    });

    it('cuts big input into overlapping windows that cover it, start and end on a line, hold one chunk and carry the path', () => {
        useRecorder();
        const text = linesOf(260000);
        const whole = Buffer.from(text);
        engine.scanContent(text, 'notes/after.json', { wholeFile: false });
        const seen = runs();
        expect(seen.map(r => r.sub)).toEqual(['dir']);                       // one run for all windows
        expect(path.dirname(seen[0].stage)).toBe(parent);                     // private staging under the cache ...
        expect(path.basename(seen[0].stage).startsWith('scan-')).toBe(true);
        expect(stages()).toEqual([]);                                         // ... removed afterwards
        const windows = seen[0].files.map(f => ({ ...f, k: Number(/^w(\d+)\//.exec(f.rel)[1]) })).sort((a, b) => a.k - b.k);
        expect(windows.length).toBeGreaterThan(3);
        let previousEnd = 0;
        windows.forEach((w, i) => {
            expect(w.rel).toBe(`w${i}/notes/after.json`);
            expect(w.size).toBeLessThanOrEqual(80001);                        // 80,000 bytes and the newline, well under 100,000
            const bytes = fs.readFileSync(path.join(dump, encodeURIComponent(w.rel)));
            expect(bytes[0]).toBe(10);
            const body = bytes.subarray(1);
            const at = whole.indexOf(body.subarray(0, 100));
            expect(at).toBeGreaterThanOrEqual(0);
            expect(whole.subarray(at, at + body.length).equals(body)).toBe(true);   // an exact slice of the input
            expect(at === 0 || whole[at - 1] === 10).toBe(true);                       // starting on a line
            if (i < windows.length - 1) expect(body[body.length - 1]).toBe(10);       // and ending after one, so no window holds half a line
            if (i === 0) expect(at).toBe(0);
            else {
                expect(at).toBeLessThanOrEqual(previousEnd);                           // no gap
                expect(previousEnd - at).toBeGreaterThanOrEqual(15997);                // room for a 16,000-byte secret
            }
            previousEnd = at + body.length;
        });
        expect(previousEnd).toBe(whole.length);                                         // covers the end
    });

    it('stages a window under a neutral name when the attributed path cannot be one', () => {
        useRecorder();
        engine.scanContent(linesOf(30000), '<stdin>', { wholeFile: false });
        expect(runs()[0].files.map(f => f.rel)).toEqual(['w0/input']);
        expect(stages()).toEqual([]);
    });

    it('fails closed, with the fixed wording, when the engine does not account for every window', () => {
        useRecorder({ skewBytes: 5 });
        let error;
        try { engine.scanContent(linesOf(30000), 'src/a.js', { wholeFile: false }); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(engine.EngineFailedError);
        expect(error.message).toBe('secret engine did not scan the whole input (it looks like a binary file to the engine)');
        expect(error.detail.reason).toBe('input-skipped');
        expect(stages()).toEqual([]);
    });

    it('fails closed when the engine says it skipped a window', () => {
        useRecorder({ skipFirst: true });
        let error;
        try { engine.scanContent(linesOf(30000), 'src/a.js', { wholeFile: false }); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(engine.EngineFailedError);
        expect(error.detail.reason).toBe('input-skipped');
    });

    it('scanFiles keeps a 100,000-byte file in the batch and scans a 100,001-byte file by itself, in windows', () => {
        useRecorder();
        const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
        fs.writeFileSync(path.join(root, 'small.txt'), 'hello\n');
        fs.writeFileSync(path.join(root, 'exact.txt'), linesOf(100000));
        fs.writeFileSync(path.join(root, 'over.txt'), linesOf(100001));
        const results = engine.scanFiles(root, ['small.txt', 'exact.txt', 'over.txt']);
        expect(results.batchMode).toBe('batch');
        const seen = runs();
        expect(seen.map(r => r.sub)).toEqual(['dir', 'dir']);
        expect(seen[0].files.map(f => f.rel).sort()).toEqual(['exact.txt', 'small.txt']);
        expect(seen[1].files.map(f => f.rel).sort()).toEqual(['w0/over.txt', 'w1/over.txt']);   // windows of 80,000 bytes, not one 100,001-byte file
        expect(Math.max(...seen[1].files.map(f => f.size))).toBeLessThanOrEqual(80001);
        expect(results.get('over.txt').findings).toEqual([]);
        expect(stages()).toEqual([]);
    });
});

// The cases secret-engine.binary.test.js runs on the stdin transport (an engine that quits early), on the route big input
// takes now: a dir run of windows. Every one must still refuse, never read as "no findings", with fixed wording.
describe('an engine that quits early on big input still fails closed', () => {
    const big = `PK\x03\x04${'x'.repeat(400000)}`;
    const useFake = body => {
        engine.resetForTests();
        process.env.AGENTS_SECRET_ENGINE_BIN = kit.exe();
        kit.apply(body);
        kit.usePins();
    };
    const refusal = () => { try { engine.scanContent(big, 'a.txt'); } catch (e) { return e; } return null; };
    const expectRefused = (error, message, reason) => {
        expect(error).toBeInstanceOf(engine.EngineFailedError);
        expect(error.message).toBe(message);
        expect(error.detail.reason).toBe(reason);
        expect(stages()).toEqual([]);
    };

    it('exits non-zero before reading', () => {
        useFake('process.exit(3);');
        expectRefused(refusal(), 'secret engine exited with status 3 during a batch scan', 'batch');
    });

    it('exits 0 and gives no account of what it scanned', () => {
        useFake("console.log('[]'); process.exit(0);");
        expectRefused(refusal(), 'secret engine did not scan the whole input (it looks like a binary file to the engine)', 'input-skipped');
    });

    it('exits 0 claiming it scanned nothing', () => {
        useFake("process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('[]'); process.exit(0);");
        expectRefused(refusal(), 'secret engine did not scan the whole input (it looks like a binary file to the engine)', 'input-skipped');
    });

    it('is killed by a signal after logging that it scanned nothing', () => {
        useFake("process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); process.kill(process.pid, 'SIGKILL');");
        const error = refusal();
        expect(error).toBeInstanceOf(engine.EngineFailedError);
        expect(error.message).toMatch(/^secret engine (?:was killed by SIGKILL|exited with status \d+) during a batch scan$/);
        expect(stages()).toEqual([]);
    });

    it('exits 0 with a report that cannot be read', () => {
        useFake("process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('not json'); process.exit(0);");
        expectRefused(refusal(), 'secret engine produced unreadable output', 'bad-json');
    });

    it('logs an error line', () => {
        useFake("process.stderr.write('ERR could not read something\\n'); console.log('[]'); process.exit(0);");
        expectRefused(refusal(), 'secret engine logged an error during a batch scan', 'batch-error');
    });
});
