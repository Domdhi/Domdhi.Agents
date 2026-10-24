import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { audit } = require('../context-audit');
const entry = path.resolve('.agents/core/context-audit.js');
let root;
function write(file, content) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
}
function cli(args) {
    return spawnSync(process.execPath, [entry, '--root', root, ...args], { encoding: 'utf8', windowsHide: true });
}
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-audit-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('portable read-only context audit', () => {
    it('inventories canonical instructions without private state or reference expansion', () => {
        for (const file of ['AGENTS.md', 'CLAUDE.md', '.agents/startup.md', '.agents/roles/reviewer.md', '.agents/skills/test/SKILL.md']) write(file, '# Instructions\n');
        write('.agents/skills/test/references/detail.md', 'unrequested detail');
        write('.agents/history/source-snapshot/old.md', 'historical');
        write('.codex/config.toml', 'private-config-marker');
        const result = audit({ root });
        expect(result.files.map(row => row.path)).toEqual(['.agents/roles/reviewer.md', '.agents/skills/test/SKILL.md', '.agents/startup.md', 'AGENTS.md', 'CLAUDE.md']);
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).not.toContain('private-config-marker');
    });

    it('measures LF-normalized UTF-16 units while preserving raw byte identity', () => {
        write('AGENTS.md', 'A\r\n😀\r\n');
        const result = audit({ root });
        expect(result.files[0]).toMatchObject({ bytes: 9, characters: 5, estimatedTokens: 2 });
        expect(result.measurement).toContain('not runtime usage or billing');
        const baseline = result;
        write('AGENTS.md', 'A\n😀\n');
        const next = audit({ root, baseline });
        expect(next.ok).toBe(false);
        expect(next.changes).toMatchObject({ changed: ['AGENTS.md'], lineEndingsOnly: ['AGENTS.md'] });
    });

    it('detects changed, missing and added instruction files', () => {
        write('AGENTS.md', 'original'); write('CLAUDE.md', 'original');
        const baseline = audit({ root });
        write('AGENTS.md', 'changed'); fs.unlinkSync(path.join(root, 'CLAUDE.md'));
        write('.agents/startup.md', 'new');
        expect(audit({ root, baseline })).toMatchObject({ ok: false, changes: { changed: ['AGENTS.md'], missing: ['CLAUDE.md'], added: ['.agents/startup.md'], lineEndingsOnly: [] } });
    });

    it('accepts an unchanged baseline and explicit per-file budget', () => {
        write('AGENTS.md', '12345');
        const baseline = audit({ root, maxChars: 5 });
        expect(audit({ root, maxChars: 5, baseline }).ok).toBe(true);
        expect(audit({ root, maxChars: 4 }).ok).toBe(false);
    });

    it('preserves exact baseline path spelling across filesystems', () => {
        write('AGENTS.md', 'fixture');
        const baseline = audit({ root });
        baseline.files[0].path = 'agents.md';
        expect(audit({ root, baseline })).toMatchObject({ ok: false, changes: { added: ['AGENTS.md'], missing: ['agents.md'] } });
    });

    it('round-trips a valid baseline larger than the per-instruction input cap', () => {
        write('AGENTS.md', 'fixture');
        const baseline = audit({ root });
        // Whitespace is valid JSON and does not change the preserved inventory.
        write('baseline.json', JSON.stringify(baseline) + ' '.repeat(1024 * 1024));
        expect(cli(['--baseline', 'baseline.json']).status).toBe(0);
    });

    it('refuses an oversized baseline without reading its content', () => {
        write('AGENTS.md', 'fixture'); write('oversized.json', 'private-marker');
        const fd = fs.openSync(path.join(root, 'oversized.json'), 'r+');
        try { fs.ftruncateSync(fd, 64 * 1024 * 1024); } finally { fs.closeSync(fd); }
        const result = cli(['--baseline', 'oversized.json']);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('oversized audit input');
        expect(result.stdout + result.stderr).not.toContain('private-marker');
    });

    it('can select files outside the default instruction inventory without scanning neighbors', () => {
        write('selected.md', 'selected'); write('other.md', 'other');
        expect(audit({ root, files: ['selected.md'] }).files.map(row => row.path)).toEqual(['selected.md']);
    });

    it.each(['../outside.md', '/outside.md', 'C:/outside.md', 'C:outside.md', 'folder\\file.md', 'folder/../file.md', 'folder//file.md', 'file.md:stream'])('refuses noncanonical or escaping input %s', file => {
        expect(() => audit({ root, files: [file] })).toThrow();
    });

    it('refuses an empty inventory, duplicates and invalid budgets', () => {
        expect(() => audit({ root })).toThrow(/empty/);
        expect(() => audit({ root, files: [] })).toThrow(/empty/);
        write('AGENTS.md', 'fixture');
        expect(() => audit({ root, files: ['AGENTS.md', 'agents.md'] })).toThrow(/inventory/);
        for (const maxChars of [0, -1, NaN, Infinity, 1.5, '5']) expect(() => audit({ root, maxChars })).toThrow(/budget/);
    });

    it('refuses malformed, duplicate and escaping baseline entries', () => {
        write('AGENTS.md', 'fixture');
        const good = audit({ root });
        for (const baseline of [{}, { schemaVersion: 1, files: [] }, { ...good, files: [good.files[0], good.files[0]] },
            { ...good, files: [{ ...good.files[0], rawSha256: 'invalid' }] },
            { ...good, files: [{ ...good.files[0], path: '../outside.md' }] }]) {
            expect(() => audit({ root, baseline })).toThrow();
        }
    });

    it('refuses linked directories and a linked root before reading a baseline', () => {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'context-outside-'));
        try {
            fs.writeFileSync(path.join(outside, 'AGENTS.md'), 'private-marker');
            fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
            expect(() => audit({ root, files: ['linked/AGENTS.md'] })).toThrow(/symlinked/);
            expect(() => audit({ root: path.join(root, 'linked') })).toThrow(/root/);
            const result = cli(['--root', path.join(root, 'linked'), '--baseline', 'AGENTS.md']);
            expect(result.status).toBe(2);
            expect(result.stdout + result.stderr).not.toContain('private-marker');
        } finally { fs.unlinkSync(path.join(root, 'linked')); fs.rmSync(outside, { recursive: true, force: true }); }
    });

    it('refuses binary, oversized, missing and directory inputs', () => {
        write('binary.md', Buffer.from([0xff])); write('large.md', Buffer.alloc(1024 * 1024 + 1));
        fs.mkdirSync(path.join(root, 'directory'));
        for (const file of ['binary.md', 'large.md', 'missing.md', 'directory']) expect(() => audit({ root, files: [file] })).toThrow();
    });

    it('runs the CLI read-only and uses nonzero results for budgets, preservation and bad input', () => {
        write('AGENTS.md', 'original');
        const initial = cli([]);
        expect(initial.status).toBe(0);
        write('baseline.json', initial.stdout);
        const names = fs.readdirSync(root).sort();
        const bytes = fs.readFileSync(path.join(root, 'AGENTS.md'));
        expect(cli(['--baseline', 'baseline.json']).status).toBe(0);
        expect(cli(['--max-chars', '2']).status).toBe(1);
        expect(cli(['--unknown']).status).toBe(2);
        expect(cli(['--max-chars', '1e3']).status).toBe(2);
        expect(cli(['--baseline', '../outside.json']).status).toBe(2);
        write('bad.json', 'private-marker malformed json');
        const bad = cli(['--baseline', 'bad.json']);
        expect(bad.status).toBe(2); expect(bad.stderr).not.toContain('private-marker');
        fs.unlinkSync(path.join(root, 'bad.json'));
        expect(fs.readdirSync(root).sort()).toEqual(names);
        expect(fs.readFileSync(path.join(root, 'AGENTS.md'))).toEqual(bytes);
        write('AGENTS.md', 'edited');
        expect(cli(['--baseline', 'baseline.json']).status).toBe(1);
    });
});
