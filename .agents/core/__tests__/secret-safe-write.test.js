import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { redactSecretsForWrite } = require('../secret-safe-write.js');

// Built at runtime so the repo's own commit scan does not see a key literal.
const awsKey = () => 'AKIA' + 'FAKETESTKEY' + 'X'.repeat(5);

describe('redactSecretsForWrite', () => {
    it('returns clean content unchanged and writes no warning', () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            expect(redactSecretsForWrite('const x = 42;\n', 'src/app.ts')).toBe('const x = 42;\n');
            expect(stderr).not.toHaveBeenCalled();
        } finally {
            stderr.mockRestore();
        }
    });

    it('redacts a named-provider secret and warns with the destination path', () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const out = redactSecretsForWrite(`const k = "${awsKey()}";`, 'notes/memory.json');
            expect(out).toContain('<REDACTED:AWS Access Key>');
            expect(stderr.mock.calls.map(c => c[0]).join('')).toContain('notes/memory.json');
        } finally {
            stderr.mockRestore();
        }
    });

    it.each(['config/server.key', 'certs/site.pem', '.env.local'])(
        'a clean write to the high-risk destination %s is not reported as a redaction',
        dest => {
            // The HIGH_RISK_FILE finding comes from the filename alone; it says nothing about
            // the bytes being written, and redaction (which is content-only) would change nothing.
            const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            try {
                expect(redactSecretsForWrite('plain notes, no credentials\n', dest)).toBe('plain notes, no credentials\n');
                expect(stderr).not.toHaveBeenCalled();
            } finally {
                stderr.mockRestore();
            }
        },
    );

    it('still redacts and warns for a real secret written to a high-risk destination', () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const out = redactSecretsForWrite(`token = "${awsKey()}"`, '.env.local');
            expect(out).toContain('<REDACTED:AWS Access Key>');
            const warning = stderr.mock.calls.map(c => c[0]).join('');
            expect(warning).toContain('redacted 1 secret finding(s)');
            expect(warning).not.toContain('HIGH_RISK_FILE');
        } finally {
            stderr.mockRestore();
        }
    });

    it('applies the same source-file exemptions to the scan and the redaction', () => {
        // A code reference next to a real secret in a source file: only the secret is redacted.
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const content = `const password = String(body.password ?? "");\nconst k = "${awsKey()}";`;
            const out = redactSecretsForWrite(content, 'src/app.ts', null);
            expect(out).toContain('String(body.password ?? "")');
            expect(out).toContain('<REDACTED:AWS Access Key>');
        } finally {
            stderr.mockRestore();
        }
    });
});

// The guard must never throw: when the engine cannot run it falls back to the named-provider list
// (D2 of the engine plan). A generic password is not caught by the fallback; a named key is.
describe('redactSecretsForWrite with a broken engine', () => {
    const engine = require('../../hooks/secret-engine.cjs');
    const { createFakeEngineKit } = require('../../hooks/__tests__/_helpers/fake-engine');
    let tmp;
    let kit;
    const saved = { bin: process.env.AGENTS_SECRET_ENGINE_BIN, quiet: process.env.SECRET_ENGINE_QUIET };

    afterEach(() => {
        if (kit) kit.restore();
        for (const [k, v] of [['AGENTS_SECRET_ENGINE_BIN', saved.bin], ['SECRET_ENGINE_QUIET', saved.quiet]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        engine.resetForTests();
    });

    function breakEngine(body) {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-write-'));
        kit = createFakeEngineKit(path.join(tmp, 'kit'));
        engine.resetForTests();
        process.env.AGENTS_SECRET_ENGINE_BIN = kit.exe();
        kit.apply(body);
        kit.usePins();
        process.env.SECRET_ENGINE_QUIET = '1';
    }

    it.each([
        ['exits non-zero', 'process.exit(4);'],
        ['prints garbage', 'console.log("garbage");'],
        ['reports that it scanned nothing', "process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('[]');"],
    ])('still redacts a named-provider key when the engine %s', (_name, body) => {
        breakEngine(body);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const out = redactSecretsForWrite(`const k = "${awsKey()}";`, 'notes/memory.json');
            expect(out).toContain('<REDACTED:AWS Access Key>');
            expect(out).not.toContain(awsKey());
        } finally {
            stderr.mockRestore();
        }
    });

    it('still redacts when the engine binary is missing', () => {
        process.env.AGENTS_SECRET_ENGINE_BIN = path.join(os.tmpdir(), 'definitely-not-an-engine');
        process.env.SECRET_ENGINE_QUIET = '1';
        engine.resetForTests();
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            expect(redactSecretsForWrite(`const k = "${awsKey()}";`, 'notes/memory.json')).toContain('<REDACTED:AWS Access Key>');
            expect(redactSecretsForWrite('plain notes\n', 'notes/memory.json')).toBe('plain notes\n');
        } finally {
            stderr.mockRestore();
        }
    });
});

// A key repeated in the text must not survive in the copy that is written to disk.
describe('redactSecretsForWrite with repeated keys', () => {
    it('masks every copy of a key that appears twice on one line and again on another', () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const out = redactSecretsForWrite(`k=${awsKey()} again ${awsKey()}\nand ${awsKey()}\n`, 'notes/memory.json');
            expect(out).not.toContain(awsKey());
            expect(out.match(/<REDACTED:AWS Access Key>/g)).toHaveLength(3);
        } finally {
            stderr.mockRestore();
        }
    });
});
