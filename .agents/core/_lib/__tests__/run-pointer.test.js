// Tests for _lib/run-pointer.js — the shared, never-throwing reader of a session's run pointer (SF-3.2).
//
// AC -> source map:
//   readRunPointer returns {run_id, wave} for a usable pointer, null for every other state
//   (missing/unsafe session, absent, directory, symlink, FIFO, oversized, corrupt, wrong shape)
//   The writer-side wiring (attribution rows, command-usage rows) is covered in attribution-ledger.test.js
//   and command-usage-logger.test.js; this file pins the reader itself, including the size-cap boundary.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { spawnSync } = require('node:child_process');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir.js');
const { readRunPointer, readPointerFile, pointerRoot, sourceDir, pointerFilePath, SESSION_RE, RUN_ID_RE, MAX_POINTER_BYTES, MAX_POINTER_AGE_MS } = require('../../../../.agents/core/_lib/run-pointer.js');
const { createLinkedWorktree } = require('../../__tests__/_helpers/linked-worktree.js');

const MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'run-pointer.js');
const POINTER = { run_id: '261118-1200-run-todo-x', plan: 'p.md', wave: 2, story: 'S-1', since: '261118-1200' };
const posixIt = process.platform === 'win32' ? it.skip : it;

let tmp;
const plant = (session, body) => {
    const p = pointerFilePath(tmp.root, session);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
};

beforeEach(() => { tmp = createTmpDir({ prefix: 'run-pointer-' }); });
afterEach(() => { tmp.cleanup(); });

describe('readRunPointer', () => {
    it('readRunPointer_usablePointer_returnsRunIdAndWaveOnly', () => {
        plant('sess-a', POINTER);

        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toEqual({ run_id: POINTER.run_id, wave: 2 });
    });

    it('readRunPointer_nullOrNonNumericWave_returnsNullWave', () => {
        plant('sess-a', { ...POINTER, wave: null });
        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toEqual({ run_id: POINTER.run_id, wave: null });
        plant('sess-a', { ...POINTER, wave: '2' });
        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toEqual({ run_id: POINTER.run_id, wave: null });
        plant('sess-a', '{"run_id":"r","wave":1e999}'); // parses to Infinity
        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toEqual({ run_id: 'r', wave: null });
    });

    it('readRunPointer_absentPointer_returnsNull', () => {
        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toBeNull();
    });

    it.each([
        ['undefined opts', undefined],
        ['null opts', null],
        ['no root', { session: 'sess-a' }],
        ['no session', { root: '$ROOT' }],
        ['numeric session', { root: '$ROOT', session: 42 }],
        ['object session', { root: '$ROOT', session: {} }],
        ['empty session', { root: '$ROOT', session: '' }],
        ['traversal session', { root: '$ROOT', session: '../evil' }],
        ['slash session', { root: '$ROOT', session: 'a/b' }],
        ['dot-dot session', { root: '$ROOT', session: '..' }],
        ['space session', { root: '$ROOT', session: 'a b' }],
        ['NUL session', { root: '$ROOT', session: 'x\u0000y' }],
        ['129-char session', { root: '$ROOT', session: 'a'.repeat(129) }],
    ])('readRunPointer_%s_returnsNullEvenWhenAPointerExistsForSessA', (_name, raw) => {
        plant('sess-a', POINTER);
        const opts = raw && { ...raw, ...(raw.root === '$ROOT' ? { root: tmp.root } : {}) };

        expect(readRunPointer(opts)).toBeNull();
    });

    it('readRunPointer_128CharSession_isAccepted', () => {
        const session = 'a'.repeat(128);
        plant(session, POINTER);

        expect(SESSION_RE.test(session)).toBe(true);
        expect(readRunPointer({ root: tmp.root, session })).toEqual({ run_id: POINTER.run_id, wave: 2 });
    });

    it.each([
        ['not JSON', '{nope'],
        ['empty', ''],
        ['array', '[]'],
        ['string', '"r"'],
        ['null', 'null'],
        ['no run_id', '{"wave":1}'],
        ['numeric run_id', '{"run_id":7}'],
        ['empty run_id', '{"run_id":""}'],
    ])('readRunPointer_corrupt_%s_returnsNull', (_name, body) => {
        plant('sess-a', body);

        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toBeNull();
    });

    it('readRunPointer_exactlyAtTheCap_isReadAndOneByteOverIsRefused', () => {
        const base = JSON.stringify(POINTER);
        plant('sess-a', base + ' '.repeat(MAX_POINTER_BYTES - base.length));
        expect(fs.statSync(pointerFilePath(tmp.root, 'sess-a')).size).toBe(MAX_POINTER_BYTES);
        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toEqual({ run_id: POINTER.run_id, wave: 2 });

        plant('sess-a', base + ' '.repeat(MAX_POINTER_BYTES - base.length + 1));
        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toBeNull();
    });

    it('readRunPointer_pointerPathIsADirectory_returnsNull', () => {
        fs.mkdirSync(pointerFilePath(tmp.root, 'sess-a'), { recursive: true });

        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toBeNull();
    });

    posixIt('readRunPointer_symlinkToAValidPointer_isNotFollowed', () => {
        const target = path.join(tmp.root, 'elsewhere.json');
        fs.writeFileSync(target, JSON.stringify(POINTER));
        const p = pointerFilePath(tmp.root, 'sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.symlinkSync(target, p);

        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toBeNull();
    });

    posixIt('readRunPointer_fifo_returnsNullWithoutBlocking', () => {
        const p = pointerFilePath(tmp.root, 'sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        expect(spawnSync('mkfifo', [p]).status).toBe(0);
        // A blocked sync open cannot be timed out inside the vitest worker: run it in a child with a hard timeout.
        const code = `const m = require(${JSON.stringify(MODULE)});` +
            `process.stdout.write(JSON.stringify(m.readRunPointer({ root: ${JSON.stringify(tmp.root)}, session: 'sess-a' })));`;

        const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000 });

        expect(res.error).toBeUndefined();
        expect(res.status).toBe(0);
        expect(res.stdout).toBe('null');
    });

    it('readRunPointer_readsUnderTheGivenRootOnly', () => {
        const other = createTmpDir({ prefix: 'run-pointer-other-' });
        try {
            plant('sess-a', POINTER);

            expect(readRunPointer({ root: other.root, session: 'sess-a' })).toBeNull();
        } finally {
            other.cleanup();
        }
    });
});

describe('M2 pointerRoot: one root for the writer and every reader', () => {
    const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
    const gitIt = hasGit ? it : it.skip;
    let fx;
    afterEach(() => { if (fx) { fx.cleanup(); fx = null; } });

    it('pointerRoot_aNonGitDirectory_isItsOwnRoot', () => {
        expect(pointerRoot(tmp.root, {})).toBe(tmp.root);
    });

    it('pointerRoot_agentSharedStateRoot_winsOverTheHint', () => {
        const other = createTmpDir({ prefix: 'run-pointer-shared-' });
        try {
            expect(pointerRoot(tmp.root, { AGENT_SHARED_STATE_ROOT: other.root })).toBe(other.root);
        } finally {
            other.cleanup();
        }
    });

    gitIt('pointerRoot_aMainWorktreeTop_isItself_andALinkedWorktreeResolvesToTheMainWorktree', () => {
        fx = createLinkedWorktree();

        expect(pointerRoot(fx.main, {})).toBe(fx.main);
        expect(pointerRoot(fx.linked, {})).toBe(fx.main);
        expect(pointerRoot(path.join(fx.linked), {})).toBe(pointerRoot(fx.main, {}));
    });

    gitIt('pointerRoot_aSubdirectoryOfALinkedWorktree_resolvesToTheMainWorktree', () => {
        fx = createLinkedWorktree();
        const sub = path.join(fx.linked, 'docs');
        fs.mkdirSync(sub, { recursive: true });

        expect(pointerRoot(sub, {})).toBe(fx.main);
    });

    it.each([
        ['AGENTS_PROJECT_DIR', { AGENTS_PROJECT_DIR: '/neutral', CLAUDE_PROJECT_DIR: '/claude' }, '/neutral'],
        ['AGENT_SOURCE_ROOT', { AGENT_SOURCE_ROOT: '/source', CLAUDE_PROJECT_DIR: '/claude' }, '/source'],
        ['CODEX_PROJECT_DIR', { CODEX_PROJECT_DIR: '/codex' }, '/codex'],
        ['CLAUDE_PROJECT_DIR', { CLAUDE_PROJECT_DIR: '/claude' }, '/claude'],
        ['the fallback', {}, '/fallback'],
    ])('sourceDir_%s_isTheHint', (_name, env, expected) => {
        expect(sourceDir('/fallback', env)).toBe(path.resolve(expected));
    });
});

describe('m3 the run id rule is shared and capped', () => {
    it.each([['r'.repeat(100), true], ['r'.repeat(101), false], ['r'.repeat(60000), false], ['-lead', false], ['has space', false], ['ok.id_1-2', true]])(
        'readRunPointer_runId_%#_%s',
        (runId, accepted) => {
            plant('sess-a', { ...POINTER, run_id: runId });

            const read = readRunPointer({ root: tmp.root, session: 'sess-a' });

            expect(RUN_ID_RE.test(runId)).toBe(accepted);
            expect(read === null).toBe(!accepted);
        },
    );
});

describe('m2 a pointer idle past the limit is stale for the row writers', () => {
    const ago = (ms) => new Date(Date.now() - ms);
    const age = (file, ms) => fs.utimesSync(file, ago(ms), ago(ms));

    it('readRunPointer_idleOverTheLimit_isNull_andJustUnderIsRead', () => {
        const p = plant('sess-a', POINTER);

        age(p, MAX_POINTER_AGE_MS + 60000);
        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toBeNull();
        age(p, MAX_POINTER_AGE_MS - 60000);
        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toEqual({ run_id: POINTER.run_id, wave: 2 });
    });

    it('readPointerFile_noIdleLimit_stillReadsAStalePointerForTheWriter', () => {
        const p = plant('sess-a', POINTER);
        age(p, 30 * MAX_POINTER_AGE_MS);

        expect(readPointerFile({ root: tmp.root, session: 'sess-a' })).toBeNull();
        expect(readPointerFile({ root: tmp.root, session: 'sess-a', maxAgeMs: Infinity })).toEqual(POINTER);
    });

    it('readRunPointer_aFutureDatedPointer_isNotStale', () => {
        const p = plant('sess-a', POINTER);
        const future = new Date(Date.now() + 3600000);
        fs.utimesSync(p, future, future);

        expect(readRunPointer({ root: tmp.root, session: 'sess-a' })).toEqual({ run_id: POINTER.run_id, wave: 2 });
    });
});
