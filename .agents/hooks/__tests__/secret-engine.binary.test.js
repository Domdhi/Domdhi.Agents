// secret-engine.cjs and binary content the engine refuses: a zip/OOXML/pdf signature makes the engine drop the
// input as "a binary file". The managed git hooks read binary blobs out of real histories (images, PDFs,
// spreadsheets, archives), so a refusal must never fail the scan, never be waved through, and never send a big
// history to one engine process per file.
//
// Found with a 1,843-commit, 40,538-object history: three versions of one .xlsx (an OOXML zip, ~80 KB each) made
// the stdin scan write 177 KB into a pipe the engine had already closed, the parent got EPIPE, and the whole push
// failed closed with "secret engine could not run".
//
// Coverage:
//   - the pieces: looksBinary, textProjection (ASCII, UTF-8 and UTF-16LE runs of 8+ characters), hasSkippedSignature
//   - the engine's early exit on a binary signature (EPIPE with status 0 and "scanned ~0 bytes") is a SKIP, not a
//     failure; any other early exit (non-zero status, a signal, no account of what it read) still fails closed
//   - a skipped binary is scanned through its text projection (a key in its printable strings is found), text with
//     a signature prefix keeps the shifted rescan (real line numbers), a redactor never sees a projection
//   - in a batch, skipped binaries (logged skips AND silent archive drops) cost ONE more engine run, never a process
//     per file

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const engine = require('../../../.agents/hooks/secret-engine.cjs');
const { createFakeEngineKit } = require('./_helpers/fake-engine');
const R = require('../../core/__tests__/_helpers/hook-repo');

const AWS = R.AWS_KEY;
const savedEnv = {};
const touched = ['AGENTS_SECRET_ENGINE_BIN', 'CLAUDE_PROJECT_DIR', 'SECRET_ENGINE_QUIET', 'FAKE_COUNT_FILE'];
let tmp;
let kit;

beforeEach(() => {
    for (const k of touched) savedEnv[k] = process.env[k];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-binary-'));
    kit = createFakeEngineKit(path.join(tmp, 'kit'));
    process.env.SECRET_ENGINE_QUIET = '1';
    process.env.CLAUDE_PROJECT_DIR = tmp;
    engine.resetForTests();
});
afterEach(() => {
    kit.restore();
    for (const k of touched) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    engine.resetForTests();
    fs.rmSync(tmp, { recursive: true, force: true });
});

function useFake(body) {
    engine.resetForTests();
    process.env.AGENTS_SECRET_ENGINE_BIN = kit.exe();
    kit.apply(body);
    kit.usePins();
}
const names = list => list.filter(f => f.type === 'SECRET_PATTERN').map(f => f.name);

describe('the pieces', () => {
    it('looksBinary: many NULs or undecodable bytes are binary; a signature prefix on text is not', () => {
        expect(engine.looksBinary(R.makeXlsxLike({ padBytes: 20000 }).toString('utf8'))).toBe(true);
        expect(engine.looksBinary(R.noise(5000).toString('utf8'))).toBe(true);
        expect(engine.looksBinary(`PK\x03\x04\0\0\0\0\0\0\0\0\0\0\0\0\0\0 readme\nconst k = 1;\n`)).toBe(false);   // a zip header's NULs, then text
        expect(engine.looksBinary('SQLite format 3\0 notes\n')).toBe(false);
        expect(engine.looksBinary('plain text\n'.repeat(100))).toBe(false);
        expect(engine.looksBinary('')).toBe(false);
    });

    it('textProjection: printable runs of 8+ characters, one per line; shorter runs and control bytes are dropped', () => {
        const text = `ab\0\x01\x02somewhat long run\x03xyz\x04another run here\0`;
        expect(engine.textProjection(text)).toBe('somewhat long run\nanother run here\n');
        expect(engine.textProjection('\0\0\0\0')).toBe('');
        expect(engine.textProjection('1234567\0')).toBe('');            // seven characters: below the minimum
        expect(engine.textProjection('12345678\0')).toBe('12345678\n');   // eight: kept
    });

    it('textProjection keeps UTF-8 text and finds UTF-16LE strings', () => {
        const utf16 = [...'wide string value'].map(c => `${c}\0`).join('');
        const text = `\0\0café crème brûlée\0\x01${utf16}\0\0`;
        expect(engine.textProjection(text)).toBe('café crème brûlée\nwide string value\n');
    });

    it('textProjection never lets a replacement character stand in for text', () => {
        expect(engine.textProjection('���������')).toBe('');
    });

    it('hasSkippedSignature: the signatures the engine drops, including tar at offset 257', () => {
        for (const sig of ['PK\x03\x04', 'PK\x05\x06', '%PDF-1.4', 'BZh91AY', 'Rar!\x1a\x07\x00', '!<arch>\n', 'MSCF\0\0\0\0', '{\\rtf1', 'SQLite format 3\0', '\x1f\x8b\x08']) {
            expect(engine.hasSkippedSignature(Buffer.from(sig, 'latin1')), JSON.stringify(sig)).toBe(true);
        }
        expect(engine.hasSkippedSignature(Buffer.from('a'.repeat(257) + 'ustar\0', 'latin1'))).toBe(true);
        for (const text of ['const x = 1;\n', '\x89PNG\r\n\x1a\n', '\xff\xd8\xff\xe0', '']) expect(engine.hasSkippedSignature(Buffer.from(text, 'latin1')), JSON.stringify(text)).toBe(false);
    });
});

describe('the real engine on a binary it refuses (the OOXML spreadsheet that failed a real push)', () => {
    it('a 150 KB spreadsheet-shaped zip no longer fails the scan with "could not run" (EPIPE)', () => {
        const clean = R.makeXlsxLike({ text: 'quarterly budget', padBytes: 150000 }).toString('utf8');
        expect(Buffer.byteLength(clean)).toBeGreaterThan(65536);          // bigger than a pipe: the write is still in flight when the engine quits
        expect(() => engine.scanContent(clean, 'src/public/downloads/budget.xlsx', { wholeFile: true })).not.toThrow();
        expect(names(engine.scanContent(clean, 'src/public/downloads/budget.xlsx', { wholeFile: true }))).toEqual([]);
    });

    it('a key in the printable strings of that binary is found, not skipped', () => {
        const dirty = R.makeXlsxLike({ text: `token=${AWS}`, padBytes: 150000 }).toString('utf8');
        const found = engine.scanContent(dirty, 'src/public/downloads/budget.xlsx', { wholeFile: true });
        expect(names(found)).toEqual(['AWS Access Key']);
        expect(found[0].file).toBe('src/public/downloads/budget.xlsx');
        expect(found[0].line).toBeGreaterThanOrEqual(1);                   // the number of the printable run
        expect(JSON.stringify(found)).not.toContain(AWS);
    });

    it('the same for a pdf-shaped file and a binary that starts with another refused signature', () => {
        expect(names(engine.scanContent(R.makePdf({ text: `k=${AWS}`, padBytes: 120000 }).toString('utf8'), 'a.pdf', { wholeFile: true }))).toEqual(['AWS Access Key']);
        expect(names(engine.scanContent(R.makePdf({ text: 'a clean title', padBytes: 120000 }).toString('utf8'), 'a.pdf', { wholeFile: true }))).toEqual([]);
        const gz = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]), R.noise(90000), Buffer.from(`\0\0token ${AWS}\0\0`)]).toString('utf8');
        expect(names(engine.scanContent(gz, 'a.gz', { wholeFile: true }))).toEqual(['AWS Access Key']);
    });

    it('a key stored as UTF-16LE inside a binary is found too', () => {
        const wide = [...`secret=${AWS}`].map(c => `${c}\0`).join('');
        const dirty = Buffer.concat([Buffer.from('PK\x03\x04'), R.noise(100000), Buffer.from(`\0\0${wide}\0\0`, 'latin1')]).toString('utf8');
        expect(names(engine.scanContent(dirty, 'wide.zip', { wholeFile: true }))).toEqual(['AWS Access Key']);
    });

    it('TEXT that merely starts with a refused signature keeps the shifted rescan: the key is found on its real line', () => {
        const text = `PK\x03\x04 readme\n\nnotes\nconst k = "${AWS}";\n`;
        const found = engine.scanContent(text, 'notes.txt', { wholeFile: true });
        expect(found.map(f => f.line)).toEqual([4]);
        // ...also when it is bigger than a pipe, where the early exit used to raise EPIPE
        const big = `%PDF-1.4 text\n${'filler line\n'.repeat(12000)}const k = "${AWS}";\n`;
        const bigFound = engine.scanContent(big, 'big.txt', { wholeFile: true });
        expect(bigFound.map(f => f.line)).toEqual([12002]);
    });

    it('a redactor given a BINARY file the engine refuses cuts the secret out of the real bytes, not out of a projection\'s line numbers', () => {
        const pdf = R.makePdf({ text: `k=${AWS}`, padBytes: 100000 }).toString('utf8');
        const redacted = engine.redactSecretsInText(pdf, 'a.pdf');
        expect(redacted).not.toContain(AWS);
        expect(redacted).toContain('<REDACTED:AWS Access Key>');
        expect(redacted.length).toBeGreaterThan(pdf.length / 2);          // the file is still the file
    });

    it('a redactor is never handed a projection: it cuts the secret out of the real text', () => {
        const text = `%PDF-1.4 text\n${'filler line\n'.repeat(12000)}const k = "${AWS}";\n`;
        const redacted = engine.redactSecretsInText(text, 'big.txt');
        expect(redacted).not.toContain(AWS);
        expect(redacted).toContain('<REDACTED:');
        expect(redacted.startsWith('%PDF-1.4 text\n')).toBe(true);
    });

    it('allow markers are read against the projection the lines came from', () => {
        const allowed = R.makePdf({ text: `password = "Zx9Qm4Lp2Rt7" // betterleaks:allow`, padBytes: 100000 }).toString('utf8');
        expect(names(engine.scanContent(allowed, 'a.pdf', { wholeFile: true }))).toEqual([]);
    });
});

describe('an early exit that is not a binary skip still fails closed', () => {
    // Input this big no longer goes to the engine on stdin (it goes to a dir run of windows, covered in
    // secret-engine.stdin-split.test.js); these tests are about the stdin transport, so it is lifted for them.
    beforeAll(() => engine.setStdinLimitForTests(Infinity));
    afterAll(() => engine.setStdinLimitForTests());
    const big = `PK\x03\x04${'x'.repeat(400000)}`;   // far bigger than a pipe, so the engine is gone before the write ends

    it('exits non-zero before reading: engine failure', () => {
        useFake('process.exit(3);');
        expect(() => engine.scanContent(big, 'a.txt')).toThrow(/could not run|exited with status/);
    });

    it('exits 0 before reading but gives no account of what it scanned: engine failure', () => {
        useFake("console.log('[]'); process.exit(0);");
        expect(() => engine.scanContent(big, 'a.txt')).toThrow(/could not run/);
    });

    it('exits 0 claiming to have read everything while the write is unfinished: engine failure', () => {
        useFake(`process.stderr.write('INF scanned ~' + ${Buffer.byteLength(big)} + ' bytes (x) in 1ms\\n'); console.log('[]'); process.exit(0);`);
        expect(() => engine.scanContent(big, 'a.txt')).toThrow(/could not run/);
    });

    it('exits NON-ZERO after logging "scanned ~0 bytes": that is a crash, not a skip, so it is an engine failure', () => {
        useFake("process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('[]'); process.exit(3);");
        expect(() => engine.scanContent(big, 'a.txt')).toThrow(/could not run|exited with status/);
    });

    it('is killed by a signal after logging "scanned ~0 bytes": an engine failure', () => {
        useFake("process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); process.kill(process.pid, 'SIGKILL');");
        expect(() => engine.scanContent(big, 'a.txt')).toThrow(/could not run|killed/);
    });

    it('exits 0 with "scanned ~0 bytes" and a report that cannot be read: engine failure', () => {
        useFake("process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('not json'); process.exit(0);");
        expect(() => engine.scanContent(big, 'a.txt')).toThrow(/unreadable output|could not run/);
    });

    it('a genuine early exit with "scanned ~0 bytes" (status 0) on PLAIN text is a skip that the shifted rescan then settles', () => {
        // The fake quits before reading anything when the input starts with PK (the real engine's behavior) and
        // reads everything otherwise, reporting the exact byte count.
        useFake(`
const chunks = [];
process.stdin.once('data', first => {
  if (first.toString('latin1', 0, 2) === 'PK') { process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('[]'); process.exit(0); }
  chunks.push(first);
  process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => { const n = Buffer.concat(chunks).length; process.stderr.write('INF scanned ~' + n + ' bytes (' + n + ' bytes) in 1ms\\n'); console.log('[]'); });
});`);
        expect(engine.scanContent(big, 'a.txt')).toEqual([]);
    });
});

describe('a batch with many skipped binaries costs one more engine run, never a process per file', () => {
    // A fake `dir` engine: a file that starts with ZZZZ is logged as skipped (an engine-refused type this module has
    // no signature for), a file that starts with PK is dropped WITHOUT a word (a plain archive at archive depth 0),
    // everything else is scanned; it reports the bytes it scanned. Every run is logged by subcommand.
    const COUNTING = `
const fs = require('fs'); const path = require('path');
const sub = process.argv[2];
fs.appendFileSync(process.env.FAKE_COUNT_FILE, sub + '\\n');
if (sub === 'dir') {
  let scanned = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { walk(f); continue; }
    const head = fs.readFileSync(f).subarray(0, 4).toString('latin1');
    if (head === 'ZZZZ' || head === '%PDF') { process.stderr.write('DBG skipping binary file mime_type=application/x-test path=' + f + '\\n'); continue; }
    if (head.startsWith('PK')) continue;
    scanned += fs.statSync(f).size;
  } };
  walk(process.argv[3]);
  process.stderr.write('INF scanned ~' + scanned + ' bytes (x) in 1ms\\n');
  console.log('[]');
} else {
  const chunks = []; process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => { const n = Buffer.concat(chunks).length; process.stderr.write('INF scanned ~' + n + ' bytes (' + n + ' bytes) in 1ms\\n'); console.log('[]'); });
}`;

    function run(files) {
        const countFile = path.join(tmp, 'runs.log');
        fs.writeFileSync(countFile, '');
        process.env.FAKE_COUNT_FILE = countFile;
        useFake(COUNTING);
        const rels = Object.keys(files);
        const results = engine.scanFiles(tmp, rels, () => ({}), { contentFor: rel => files[rel] });
        return { results, runs: fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean) };
    }
    const text = i => Buffer.from(`const v${i} = ${i};\n`);
    const binary = (head, i) => Buffer.concat([Buffer.from(head), R.noise(3000, i), Buffer.from(`\0\0printable string number ${i}\0\0`)]);

    it('60 engine-refused binaries (logged skips) among text files: the batch, then one projection batch', () => {
        const files = {};
        for (let i = 0; i < 20; i++) files[`src/f${i}.js`] = text(i);
        for (let i = 0; i < 60; i++) files[`blobs/b${i}.bin`] = binary('ZZZZ', i);
        const { results, runs } = run(files);
        expect(runs).toEqual(['dir', 'dir']);
        expect(results.batchMode).toBe('batch');
        for (const rel of Object.keys(files)) expect(results.get(rel), rel).toEqual({ findings: [] });
    });

    it('60 plain archives the engine drops silently (PK, no log line): routed by signature, same two runs', () => {
        const files = {};
        for (let i = 0; i < 20; i++) files[`src/f${i}.js`] = text(i);
        for (let i = 0; i < 60; i++) files[`archives/a${i}.zip`] = binary('PK\x03\x04', i);
        const { results, runs } = run(files);
        expect(runs).toEqual(['dir', 'dir']);
        expect(results.batchMode).toBe('batch');
        for (const rel of Object.keys(files)) expect(results.get(rel), rel).toEqual({ findings: [] });
    });

    it('a PDF\'s first printable run IS the refused signature: its projection is staged behind a newline, so it is not refused again', () => {
        const files = {};
        for (let i = 0; i < 40; i++) files[`docs/d${i}.pdf`] = R.makePdf({ text: `title ${i}`, padBytes: 4000, seed: i + 1 });
        const { results, runs } = run(files);
        expect(runs).toEqual(['dir']);                      // one run over the 40 projections; none went back to a process of its own
        for (const rel of Object.keys(files)) expect(results.get(rel), rel).toEqual({ findings: [] });
    });

    it('only binaries: a single run, over their projections', () => {
        const files = {};
        for (let i = 0; i < 30; i++) files[`archives/a${i}.zip`] = binary('PK\x03\x04', i);
        expect(run(files).runs).toEqual(['dir']);
    });

    it('a binary with no printable run holds nothing to find and costs no run of its own', () => {
        const files = { 'a.txt': text(1), 'z.zip': Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 0)]) };
        const { results, runs } = run(files);
        expect(runs).toEqual(['dir']);
        expect(results.get('z.zip')).toEqual({ findings: [] });
    });

    it('text that starts with a refused signature is not routed to the projection (it keeps its real line numbers)', () => {
        const files = { 'a.txt': text(1), 'notes.txt': Buffer.from('PK\x03\x04 readme\nconst x = 1;\n') };
        const { runs } = run(files);
        expect(runs[0]).toBe('dir');
        expect(runs.slice(1).every(r => r === 'stdin')).toBe(true);          // the shifted rescan of that one file, not a projection batch
    });

    it('the real engine: a key in one of many skipped binaries is found at its own path', () => {
        delete process.env.AGENTS_SECRET_ENGINE_BIN;
        kit.restore();
        engine.resetForTests();
        const files = {};
        for (let i = 0; i < 12; i++) files[`archives/a${i}.docx`] = R.makeXlsxLike({ text: `harmless text ${i}`, padBytes: 20000, seed: i + 1 });
        files['archives/leaky.xlsx'] = R.makeXlsxLike({ text: `token=${AWS}`, padBytes: 20000, seed: 99 });
        files['src/a.js'] = Buffer.from('const a = 1;\n');
        const rels = Object.keys(files);
        const results = engine.scanFiles(tmp, rels, () => ({}), { contentFor: rel => files[rel] });
        expect(results.batchMode).toBe('batch');
        const dirty = rels.filter(r => results.get(r).findings && results.get(r).findings.length);
        expect(dirty).toEqual(['archives/leaky.xlsx']);
        expect(results.get('archives/leaky.xlsx').findings[0].name).toBe('AWS Access Key');
        // Parity with the one-file scan: the same finding on the same line (the number of the printable run).
        expect(results.get('archives/leaky.xlsx').findings).toEqual(engine.scanContent(files['archives/leaky.xlsx'].toString('utf8'), 'archives/leaky.xlsx', { wholeFile: true }));
    });
});
