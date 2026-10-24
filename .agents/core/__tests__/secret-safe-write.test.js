import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

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
