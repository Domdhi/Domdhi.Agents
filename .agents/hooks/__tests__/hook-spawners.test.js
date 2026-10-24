// hook-spawners (NA5.12) — background work a hook starts must outlive the hook.
//
// On Windows, libuv assigns a NON-detached child to its parent's kill-on-close job
// object, so the child dies the moment the hook process exits (Node documents that
// only `detached: true` lets a Windows child continue after its parent exits).
// `unref()` only stops the parent from waiting. The shared helper therefore sets
// `detached` on Windows and keeps stdio ignored, windowsHide and unref everywhere.
//
// The option matrix is asserted with an injected spawn; survival and the SessionStart
// index self-heal are asserted with REAL processes (a mocked spawn cannot prove them).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { spawnBackground, spawnDailyLogCapture } = require('../../../.agents/core/_lib/hook-spawners');

const REPO = path.resolve(__dirname, '../../..');
const HELPER = path.join(REPO, '.agents/core/_lib/hook-spawners.js');
const HOOK = path.join(REPO, '.agents/hooks/session-start-prime.cjs');
const MANAGER = path.join(REPO, '.agents/core/memory-manager.js');

const hasSqlite = (() => {
    try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(':memory:');
        try { db.exec('CREATE VIRTUAL TABLE _probe USING fts5(x)'); return true; } finally { db.close(); }
    } catch { return false; }
})();

async function waitFor(check, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = check();
        if (value || Date.now() > deadline) return value;
        await new Promise(r => setTimeout(r, 100));
    }
}

let tmp;
afterEach(() => {
    vi.restoreAllMocks();
    if (tmp) { tmp.cleanup(); tmp = null; }
});

describe('spawnBackground option matrix (NA5.12)', () => {
    const fakeSpawn = () => vi.fn(() => ({ unref: vi.fn() }));

    it('spawnBackground_windows_detachesAndKeepsHiddenIgnoredUnref', () => {
        const spawn = fakeSpawn();
        const child = spawnBackground('node', ['x.js', 'run'], { cwd: '/proj', spawn, platform: 'win32' });
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(spawn.mock.calls[0]).toEqual(['node', ['x.js', 'run'], { cwd: '/proj', stdio: 'ignore', windowsHide: true, detached: true }]);
        expect(child.unref).toHaveBeenCalledTimes(1);
    });

    it('spawnBackground_posix_doesNotDetach', () => {
        const spawn = fakeSpawn();
        spawnBackground('node', ['x.js'], { cwd: '/proj', spawn, platform: 'linux' });
        expect(spawn.mock.calls[0][2]).toEqual({ cwd: '/proj', stdio: 'ignore', windowsHide: true, detached: false });
    });

    it('spawnDailyLogCapture_goesThroughTheSharedOptions', () => {
        const spawn = fakeSpawn();
        spawnDailyLogCapture('/proj', 'auto-stop', { spawn, platform: 'win32' });
        const [command, args, opts] = spawn.mock.calls[0];
        expect(command).toBe('node');
        expect(args).toEqual([path.join('/proj', '.claude', 'core', 'daily-log.js'), 'capture', '--trigger', 'auto-stop']);
        expect(opts).toEqual({ cwd: '/proj', stdio: 'ignore', windowsHide: true, detached: true });
    });
});

describe('background work survives its parent (NA5.12, real processes)', () => {
    it('spawnBackground_parentExitsImmediately_childStillFinishes', async () => {
        tmp = createTmpDir({ prefix: 'hook-spawners-' });
        const marker = path.join(tmp.root, 'child-finished.txt');
        const parent = path.join(tmp.root, 'parent.cjs');
        fs.writeFileSync(parent, [
            `const { spawnBackground } = require(${JSON.stringify(HELPER)});`,
            `spawnBackground(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok'), 1000)`)}], { cwd: ${JSON.stringify(tmp.root)} });`,
            'process.exit(0);',
        ].join('\n'));

        const r = spawnSync(process.execPath, [parent], { windowsHide: true });

        expect(r.status).toBe(0);
        expect(await waitFor(() => fs.existsSync(marker), 15000)).toBe(true);
    }, 30000);

    it.skipIf(!hasSqlite)('sessionStartHook_partialIndex_isRebuiltToTheFullRecordCount', async () => {
        tmp = createTmpDir({ prefix: 'hook-spawners-heal-' });
        const env = { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, MEMORY_PROFILE: 'standard' };
        // Build a store of 12 records whose index holds only 2 (the 22/204 shape).
        const seed = spawnSync(process.execPath, ['-e', `
            const MM = require(${JSON.stringify(MANAGER)});
            (async () => {
                const m = new MM();
                for (let i = 0; i < 12; i++) await m.createMemory('patterns', 'heal-' + i, { description: 'heal record ' + i });
                m.db.prepare("DELETE FROM memories WHERE id NOT IN ('heal-0','heal-1')").run();
                m.db.prepare("DELETE FROM memories_fts WHERE id NOT IN ('heal-0','heal-1')").run();
                m.db.close();
            })().catch(e => { console.error(e); process.exit(1); });
        `], { env, cwd: tmp.root, encoding: 'utf8', windowsHide: true });
        expect(seed.status, seed.stderr).toBe(0);
        const dbPath = path.join(tmp.root, 'docs', '.output', '.state', 'memory-index', 'memories.db');
        const rows = () => {
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(dbPath, { readOnly: true });
            try { return db.prepare('SELECT COUNT(*) AS c FROM memories').get().c; } finally { db.close(); }
        };
        expect(rows()).toBe(2);

        const hook = spawnSync(process.execPath, [HOOK], { env, cwd: tmp.root, encoding: 'utf8', windowsHide: true });

        expect(hook.status).toBe(0);
        expect(hook.stdout).toContain('<project_memory>');
        expect(await waitFor(() => { try { return rows() === 12; } catch { return false; } }, 20000)).toBe(true);
        // Let the rebuild child release the db before the sandbox is removed.
        await waitFor(() => fs.existsSync(path.join(path.dirname(dbPath), 'rebuild-status.json')), 10000);
    }, 45000);
});
