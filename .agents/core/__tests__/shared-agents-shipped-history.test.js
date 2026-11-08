import { it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { shippedBefore } = require('../_lib/shared-agents');
const roots = [];
afterEach(() => roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })));
const sha = b => createHash('sha256').update(b).digest('hex');

function sourceWithHistory(versions) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipped-history-')); roots.push(root);
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
    fs.mkdirSync(path.join(root, '.agents/config'), { recursive: true });
    for (const v of versions) { fs.writeFileSync(path.join(root, '.agents/config/version.json'), v); git('add', '.'); git('commit', '-qm', v.trim()); }
    return root;
}

it('bytes the source shipped at an earlier commit are recognized, so a stale ledger is no edit', () => {
    const source = sourceWithHistory(['{"version":"6.4"}\n', '{"version":"6.5"}\n', '{"version":"6.6"}\n']);
    expect(shippedBefore(source, '.agents/config/version.json', sha('{"version":"6.5"}\n'))).toBe(true);
    expect(shippedBefore(source, '.agents/config/version.json', sha('{"version":"6.4"}\n'))).toBe(true);
});

it('bytes the source never shipped are still a local edit', () => {
    const source = sourceWithHistory(['{"version":"6.5"}\n', '{"version":"6.6"}\n']);
    expect(shippedBefore(source, '.agents/config/version.json', sha('{"version":"6.5","local":true}\n'))).toBe(false);
});

it('a source that is not a git checkout has no history to vouch for anything', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipped-nogit-')); roots.push(root);
    expect(shippedBefore(root, '.agents/config/version.json', sha('x'))).toBe(false);
});
