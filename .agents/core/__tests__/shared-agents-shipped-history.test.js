import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { shippedBefore, syncSharedAgents, renderSharedAgents } = require('../_lib/shared-agents');
const roots = [];
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })); });
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

it('history is read from the source repository even when the environment points git elsewhere', () => {
    const source = sourceWithHistory(['{"version":"6.5"}\n', '{"version":"6.6"}\n']);
    const other = sourceWithHistory(['{"version":"other"}\n']);
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other, '.git');
    try {
        expect(shippedBefore(source, '.agents/config/version.json', sha('{"version":"6.5"}\n'))).toBe(true);
    } finally {
        if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    }
});

it('a path absent at some commits and present at others still yields every shipped copy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipped-gap-')); roots.push(root);
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
    const file = path.join(root, 'tracked.txt');
    const step = (action, label) => { action(); git('add', '-A'); git('commit', '-qm', label); };
    step(() => fs.writeFileSync(file, 'first\n'), 'first');
    step(() => fs.rmSync(file), 'removed');
    step(() => fs.writeFileSync(file, 'second\n'), 'second');
    expect(shippedBefore(root, 'tracked.txt', sha('first\n'))).toBe(true);
    expect(shippedBefore(root, 'tracked.txt', sha('second\n'))).toBe(true);
    expect(shippedBefore(root, 'tracked.txt', sha('third\n'))).toBe(false);
});

// The 502f99c3 relaxation, driven through the real entry point: a stale render ledger (left by a merge or an
// interrupted update) must not read as a local edit when the output equals bytes the source shipped earlier,
// while a genuine local edit must still conflict.
const SKILL = '.agents/skills/ledger-skill/SKILL.md';
const NATIVE = '.claude/skills/ledger-skill/SKILL.md';
const skillText = marker => `---\nname: ledger-skill\ndescription: Use when testing a stale ledger.\n---\n\n# Ledger skill\n\n${marker}\n`;
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

function staleLedgerFixture() {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-ledger-source-')); roots.push(source);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-ledger-target-')); roots.push(target);
    const git = (...a) => execFileSync('git', ['-C', source, ...a], { stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
    put(source, SKILL, skillText('RELEASE_ONE'));
    expect(renderSharedAgents(source).conflicts).toEqual([]);
    git('add', '-A'); git('commit', '-qm', 'release one');
    expect(syncSharedAgents(source, target, { merge: true }).conflicts).toEqual([]);
    put(source, SKILL, skillText('RELEASE_TWO'));
    expect(renderSharedAgents(source).conflicts).toEqual([]);
    git('add', '-A'); git('commit', '-qm', 'release two');
    // The interrupted-update state: the new canonical skill is already in the target, its native output is
    // still release one, and the ledger records bytes neither of them has.
    put(target, SKILL, skillText('RELEASE_TWO'));
    const ledgerFile = path.join(target, '.agents/render-state.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    ledger[NATIVE] = sha('bytes the ledger recorded before a merge');
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
    expect(fs.readFileSync(path.join(target, NATIVE), 'utf8')).toContain('RELEASE_ONE');
    return { source, target };
}

it('syncSharedAgents accepts a stale ledger when the output equals an earlier shipped release', () => {
    const { source, target } = staleLedgerFixture();
    const result = syncSharedAgents(source, target, { merge: true });
    expect(result.conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(target, NATIVE), 'utf8')).toContain('RELEASE_TWO');
});

it('syncSharedAgents still refuses a genuine local edit under the same stale ledger', () => {
    const { source, target } = staleLedgerFixture();
    fs.appendFileSync(path.join(target, NATIVE), '\nLOCAL EDIT the source never shipped\n');
    const result = syncSharedAgents(source, target, { merge: true });
    expect(result.conflicts).toContain(NATIVE);
    expect(fs.readFileSync(path.join(target, NATIVE), 'utf8')).toContain('LOCAL EDIT');
});
