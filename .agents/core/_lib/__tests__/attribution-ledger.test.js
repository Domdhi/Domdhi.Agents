// Tests for attribution-ledger.js — cross-subagent change-attribution ledger (S-PI.7).
//
// AC → source map:
//   AC1 (per-run ledger attribution-{date}.jsonl records per-dispatch
//        {story_id, agent, model, files_touched, status}) → appendAttribution + readAttribution
//   AC4 (regression test for the ledger writer — entry shape + append) → this file
//   AC2 (do.md Step 9c / run-todo.md Phase 2 Step 4b append) → [inspection] (command wiring)
//   AC3 (end.md wrap-up surfaces ledger before staging + never-revert guidance) → [inspection]

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir.js');
const { appendAttribution, readAttribution, dateStamp } = require('../../../../.agents/core/_lib/attribution-ledger.js');

let tmp;
let prevEnv;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'attribution-ledger-' });
    prevEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
});

afterEach(() => {
    if (prevEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevEnv;
    tmp.cleanup();
});

describe('appendAttribution', () => {
    it('appendAttribution_validEntry_writesLineWithAll5KeysPlusTimestamp', () => {
        const written = appendAttribution({
            story_id: 'S-PI.7',
            agent: 'general-purpose',
            model: 'opus',
            files_touched: ['a.js', 'b.js'],
            status: 'DONE',
        });
        // returned entry carries the 5 keys + auto timestamp
        expect(written.story_id).toBe('S-PI.7');
        expect(written.agent).toBe('general-purpose');
        expect(written.model).toBe('opus');
        expect(written.files_touched).toEqual(['a.js', 'b.js']);
        expect(written.status).toBe('DONE');
        expect(typeof written.timestamp).toBe('string');
        expect(written.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // persisted and readable back
        const entries = readAttribution();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            story_id: 'S-PI.7',
            agent: 'general-purpose',
            model: 'opus',
            files_touched: ['a.js', 'b.js'],
            status: 'DONE',
        });
        expect(entries[0].timestamp).toBeTruthy();
    });

    it('appendAttribution_twoAppends_accumulateInSameDayFile', () => {
        appendAttribution({ story_id: 'S-1', agent: 'a', model: 'sonnet', files_touched: ['x'], status: 'DONE' });
        appendAttribution({ story_id: 'S-2', agent: 'b', model: 'opus', files_touched: ['y'], status: 'BLOCKED' });
        const entries = readAttribution();
        expect(entries).toHaveLength(2);
        expect(entries.map(e => e.story_id)).toEqual(['S-1', 'S-2']);
    });

    it('appendAttribution_badEntry_doesNotThrow_andCoercesDefaults', () => {
        // null entry — must not throw, must coerce to a well-formed record
        expect(() => appendAttribution(null)).not.toThrow();
        // entry missing files_touched / model — defaults applied
        const written = appendAttribution({ story_id: 7, status: 'DONE' });
        expect(written.story_id).toBe('7');       // coerced to String
        expect(written.model).toBeNull();          // missing → null
        expect(written.agent).toBeNull();
        expect(written.files_touched).toEqual([]); // missing → []
        const entries = readAttribution();
        expect(entries).toHaveLength(2); // null entry + the partial entry both persisted
    });
});

// F1 (council-260715-2244): getProjectRoot() must route through the
// worktree-safe _lib/project-root.js resolveProjectRoot() instead of the naive
// `CLAUDE_PROJECT_DIR || path.resolve(__dirname,...)` fallback — the latter
// anchors the GITIGNORED docs/.output/.state/telemetry ledger to whichever
// worktree happens to be current instead of the shared main worktree.
describe('getProjectRoot routes through resolveProjectRoot (F1 — worktree-safe root)', () => {
    it('invokes resolveProjectRoot() with the module fallbackDir and writes under ITS resolved root, not a naive __dirname fallback', () => {
        const projectRootCachePath = require.resolve('../../../../.agents/core/_lib/project-root.js');
        const ledgerCachePath = require.resolve('../../../../.agents/core/_lib/attribution-ledger.js');
        const savedProjectRoot = require.cache[projectRootCachePath];
        const savedLedger = require.cache[ledgerCachePath];

        // A fake resolved root, distinct from both CLAUDE_PROJECT_DIR (unset in
        // this test) and the real repo path that a naive __dirname fallback
        // would produce. fs writes are spied/no-op'd so this never touches disk
        // regardless of which path the implementation actually resolves.
        // path.resolve makes the fake root platform-absolute ('C:\fake\…' on win32) so
        // the implementation's path.join output still startsWith it — a bare '/fake/…'
        // gets its separators flipped by win32 path.join and the prefix check fails.
        const fakeRoot = path.resolve('/fake/f1-main-worktree-root');
        let calledWithFallback = null;

        require.cache[projectRootCachePath] = {
            id: projectRootCachePath, filename: projectRootCachePath, loaded: true, children: [], paths: [],
            exports: {
                resolveProjectRoot: (fallbackDir) => { calledWithFallback = fallbackDir; return fakeRoot; },
                resolveWorktreeRoot: (fallbackDir) => fallbackDir,
            },
        };
        delete require.cache[ledgerCachePath];

        const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
        // The append goes through fs-safe (an O_NOFOLLOW open, then a write through the fd), so the open, the write and the
        // close are faked: the fd is never real and nothing touches disk.
        const appendSpy = vi.spyOn(fs, 'openSync').mockReturnValue(999);
        const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => {});
        const savedEnv = process.env.CLAUDE_PROJECT_DIR;
        delete process.env.CLAUDE_PROJECT_DIR;

        try {
            const fresh = require('../../../../.agents/core/_lib/attribution-ledger.js');
            fresh.appendAttribution({ story_id: 'S', agent: 'a', model: 'm', files_touched: [], status: 'DONE' });

            expect(calledWithFallback).toBeTruthy(); // resolveProjectRoot() was actually called
            const call = appendSpy.mock.calls.find(([p]) => typeof p === 'string' && p.includes('attribution-'));
            expect(call).toBeTruthy();
            expect(call[0].startsWith(fakeRoot)).toBe(true);
        } finally {
            mkdirSpy.mockRestore();
            appendSpy.mockRestore();
            writeSpy.mockRestore();
            closeSpy.mockRestore();
            if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = savedEnv;
            require.cache[projectRootCachePath] = savedProjectRoot;
            if (savedLedger) require.cache[ledgerCachePath] = savedLedger;
            else delete require.cache[ledgerCachePath];
        }
    });
});

describe('readAttribution', () => {
    it('readAttribution_missingFile_returnsEmptyArray', () => {
        // No appends in this fresh tmp root → file does not exist
        expect(readAttribution()).toEqual([]);
    });

    it('readAttribution_explicitDate_isolatesByDayStamp', () => {
        appendAttribution({ story_id: 'S-1', agent: 'a', model: null, files_touched: [], status: 'DONE' });
        // today's stamp returns the entry; an unrelated past stamp returns []
        expect(readAttribution(dateStamp())).toHaveLength(1);
        expect(readAttribution('000101')).toEqual([]);
    });
});

// ─── SF-3.2: run_id and wave on attribution rows ──────────────────────────────
//
// PINNED CONTRACT (the tests are the spec; the implementer must not edit them).
//   Source of the pointer: docs/.output/.state/telemetry/current-run-{session}.json under the SAME root the row is
//   written under (opts.root, else the resolved project root) — the "run id and session pointer" seam, written by
//   run-record.js (SF-3.1): { run_id, plan, wave, story, since }.
//   Session source: opts.session when given, else env CLAUDE_CODE_SESSION_ID (the Bash tool sets it for the CLI verb
//   `attribution-ledger.js append`; an in-process caller may pass opts.session). Neither -> no pointer is read.
//   Stamping: a usable pointer (a regular file, <= 64 KiB, JSON object, run_id a non-empty string) adds EXACTLY two keys
//   to the row: run_id (the pointer's string) and wave (the pointer's number, else null — a freshly started run has
//   wave null). Any other state (no session, absent, unreadable, directory, symlink, FIFO, oversized, corrupt, wrong
//   shape, another session's pointer, an unsafe session id) leaves the row exactly as before SF-3.2: the two keys are
//   ABSENT (not null), the entry is still written, and nothing throws or blocks. A pointer is never followed through a
//   symlink and a FIFO is never opened blockingly (memory: hook-reads-of-agent-writable-paths-must-reject-fifos).
//   Every "unchanged" case below is paired with a control: the same path rewritten as a valid pointer MUST stamp, so
//   a green "unchanged" is the reader refusing the shape, not the reader looking in the wrong place.

describe('SF-3.2 attribution rows carry run_id and wave from the session pointer', () => {
    const { spawnSync } = require('node:child_process');
    const LEDGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'attribution-ledger.js');
    const BASE_KEYS = ['agent', 'files_touched', 'model', 'status', 'story_id', 'timestamp'];
    const ENTRY = { story_id: 'SF-3.2', agent: 'general-purpose', model: 'sonnet', files_touched: ['a.js'], status: 'DONE' };
    const POINTER = { run_id: '261118-1200-run-todo-software-factory', plan: 'docs/.output/plans/p.md', wave: 3, story: 'SF-3.2', since: '261118-1200' };
    const posixIt = process.platform === 'win32' ? it.skip : it;
    const nonRootPosixIt = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? it.skip : it;
    let priorSession;

    const pointerPath = (session) => path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', `current-run-${session}.json`);
    const plant = (session, body) => {
        const p = pointerPath(session);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
        return p;
    };
    const lastRow = () => readAttribution().at(-1);
    const keysOf = (row) => Object.keys(row).sort();
    const unplant = (p) => fs.rmSync(p, { recursive: true, force: true });

    beforeEach(() => {
        priorSession = process.env.CLAUDE_CODE_SESSION_ID;
        process.env.CLAUDE_CODE_SESSION_ID = 'sess-a';
    });

    afterEach(() => {
        if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
        else process.env.CLAUDE_CODE_SESSION_ID = priorSession;
    });

    it('appendAttribution_pointerForEnvSession_stampsRunIdAndWaveOnReturnedAndPersistedRow', () => {
        plant('sess-a', POINTER);

        const written = appendAttribution(ENTRY);

        expect(written.run_id).toBe(POINTER.run_id);
        expect(written.wave).toBe(3);
        expect(lastRow().run_id).toBe(POINTER.run_id);
        expect(lastRow().wave).toBe(3);
        expect(keysOf(lastRow())).toEqual([...BASE_KEYS, 'run_id', 'wave'].sort());
        expect(lastRow()).toMatchObject({ story_id: 'SF-3.2', agent: 'general-purpose', model: 'sonnet', files_touched: ['a.js'], status: 'DONE' });
    });

    it('appendAttribution_optsSessionGiven_winsOverEnvSession', () => {
        plant('sess-a', { ...POINTER, run_id: 'run-from-env', wave: 1 });
        plant('sess-b', { ...POINTER, run_id: 'run-from-opts', wave: 7 });

        const written = appendAttribution(ENTRY, { session: 'sess-b' });

        expect(written.run_id).toBe('run-from-opts');
        expect(written.wave).toBe(7);
    });

    it('appendAttribution_noEnvSessionButOptsSession_stampsFromOptsSession', () => {
        delete process.env.CLAUDE_CODE_SESSION_ID;
        plant('sess-b', { ...POINTER, run_id: 'run-b', wave: 2 });

        const written = appendAttribution(ENTRY, { session: 'sess-b' });

        expect(written.run_id).toBe('run-b');
        expect(written.wave).toBe(2);
    });

    it('appendAttribution_optsRootGiven_readsThePointerUnderThatRootNotTheEnvRoot', () => {
        const other = createTmpDir({ prefix: 'attribution-other-root-' });
        try {
            const p = path.join(other.root, 'docs', '.output', '.state', 'telemetry', 'current-run-sess-a.json');
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify({ ...POINTER, run_id: 'run-under-other-root' }));
            plant('sess-a', { ...POINTER, run_id: 'run-under-env-root' });

            const written = appendAttribution(ENTRY, { root: other.root });

            expect(written.run_id).toBe('run-under-other-root');
            expect(readAttribution(undefined, { root: other.root }).at(-1).run_id).toBe('run-under-other-root');
        } finally {
            other.cleanup();
        }
    });

    it('appendAttribution_pointerJustAfterStartWithNullWave_stampsRunIdAndNullWave', () => {
        plant('sess-a', { ...POINTER, wave: null, story: null, plan: null });

        const written = appendAttribution(ENTRY);

        expect(written.run_id).toBe(POINTER.run_id);
        expect('wave' in written).toBe(true);
        expect(written.wave).toBeNull();
    });

    it('appendAttribution_pointerWaveIsNotANumber_stampsRunIdAndNullWave', () => {
        plant('sess-a', { ...POINTER, wave: 'three' });

        const written = appendAttribution(ENTRY);

        expect(written.run_id).toBe(POINTER.run_id);
        expect(written.wave).toBeNull();
    });

    it('appendAttribution_pointerChangesWaveBetweenAppends_eachRowCarriesTheWaveAtItsOwnTime', () => {
        plant('sess-a', { ...POINTER, wave: 1 });
        appendAttribution(ENTRY);
        plant('sess-a', { ...POINTER, wave: 2 });
        appendAttribution(ENTRY);

        expect(readAttribution().map(r => r.wave)).toEqual([1, 2]);
    });

    it('appendAttribution_hostileNullEntryWithPointer_stillStampsAWellFormedRow', () => {
        plant('sess-a', POINTER);

        const written = appendAttribution(null);

        expect(written.run_id).toBe(POINTER.run_id);
        expect(written.wave).toBe(3);
        expect(written.story_id).toBeNull();
    });

    it('appendAttribution_absentPointer_rowKeysAreExactlyTheOriginalSix', () => {
        const written = appendAttribution(ENTRY);

        expect(keysOf(written)).toEqual(BASE_KEYS);
        expect(keysOf(lastRow())).toEqual(BASE_KEYS);
        expect('run_id' in lastRow()).toBe(false);
        expect('wave' in lastRow()).toBe(false);
    });

    it('appendAttribution_noSessionAtAll_rowUnchangedEvenWhenPointerFilesExist', () => {
        delete process.env.CLAUDE_CODE_SESSION_ID;
        plant('sess-a', POINTER);
        plant('undefined', POINTER);
        plant('null', POINTER);
        plant('', POINTER);

        const written = appendAttribution(ENTRY);
        process.env.CLAUDE_CODE_SESSION_ID = 'sess-a';
        const control = appendAttribution(ENTRY);

        expect(keysOf(written)).toEqual(BASE_KEYS);
        expect(control.run_id).toBe(POINTER.run_id);
    });

    it('appendAttribution_onlyAnotherSessionsPointerExists_rowUnchangedAndAnotherSessionStillStamps', () => {
        plant('sess-b', POINTER);

        const written = appendAttribution(ENTRY);
        const other = appendAttribution(ENTRY, { session: 'sess-b' });

        expect(keysOf(written)).toEqual(BASE_KEYS);
        expect(keysOf(readAttribution()[0])).toEqual(BASE_KEYS);
        expect(other.run_id).toBe(POINTER.run_id);
    });

    it('appendAttribution_twoSessionsInOneTree_eachRowCarriesItsOwnSessionsRun', () => {
        plant('sess-a', { ...POINTER, run_id: 'run-a', wave: 1 });
        plant('sess-b', { ...POINTER, run_id: 'run-b', wave: 9 });

        const a = appendAttribution(ENTRY);
        process.env.CLAUDE_CODE_SESSION_ID = 'sess-b';
        const b = appendAttribution(ENTRY);

        expect([a.run_id, a.wave]).toEqual(['run-a', 1]);
        expect([b.run_id, b.wave]).toEqual(['run-b', 9]);
    });

    it.each([
        ['not JSON', '{nope'],
        ['empty file', ''],
        ['truncated JSON', '{"run_id":"r1","wa'],
        ['a JSON array', '[]'],
        ['a JSON string', '"run-1"'],
        ['JSON null', 'null'],
        ['no run_id', '{"wave":1,"plan":null,"story":null,"since":"261118-1200"}'],
        ['run_id a number', '{"run_id":7,"wave":1}'],
        ['run_id empty string', '{"run_id":"","wave":1}'],
        ['run_id an object', '{"run_id":{"a":1},"wave":1}'],
        ['binary garbage', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]).toString('latin1')],
    ])('appendAttribution_corruptPointer_%s_rowUnchangedThenValidPointerStamps', (_name, body) => {
        const p = plant('sess-a', body);

        const bad = appendAttribution(ENTRY);
        unplant(p);
        plant('sess-a', POINTER);
        const good = appendAttribution(ENTRY);

        expect(keysOf(bad)).toEqual(BASE_KEYS);
        expect(readAttribution()).toHaveLength(2);
        expect(good.run_id).toBe(POINTER.run_id);
    });

    it('appendAttribution_pointerPathIsADirectory_rowUnchangedThenValidPointerStamps', () => {
        const p = pointerPath('sess-a');
        fs.mkdirSync(p, { recursive: true });

        const bad = appendAttribution(ENTRY);
        unplant(p);
        plant('sess-a', POINTER);
        const good = appendAttribution(ENTRY);

        expect(keysOf(bad)).toEqual(BASE_KEYS);
        expect(good.run_id).toBe(POINTER.run_id);
    });

    nonRootPosixIt('appendAttribution_pointerUnreadableMode000_rowUnchangedThenReadablePointerStamps', () => {
        const p = plant('sess-a', POINTER);
        fs.chmodSync(p, 0o000);

        const bad = appendAttribution(ENTRY);
        fs.chmodSync(p, 0o600);
        const good = appendAttribution(ENTRY);

        expect(keysOf(bad)).toEqual(BASE_KEYS);
        expect(good.run_id).toBe(POINTER.run_id);
    });

    it('appendAttribution_pointerOverTheSizeCap_treatedAsCorruptRowUnchanged', () => {
        // Valid JSON padded to 2 MiB: a pointer is < 1 KiB, so a reader that slurps the whole file has no cap.
        const padded = JSON.stringify(POINTER) + ' '.repeat(2 * 1024 * 1024);
        const p = plant('sess-a', padded);

        const bad = appendAttribution(ENTRY);
        unplant(p);
        plant('sess-a', POINTER);
        const good = appendAttribution(ENTRY);

        expect(keysOf(bad)).toEqual(BASE_KEYS);
        expect(good.run_id).toBe(POINTER.run_id);
    });

    posixIt('appendAttribution_pointerIsASymlinkToAValidPointer_notFollowedRowUnchanged', () => {
        const target = path.join(tmp.root, 'elsewhere.json');
        fs.writeFileSync(target, JSON.stringify(POINTER));
        const p = pointerPath('sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.symlinkSync(target, p);

        const bad = appendAttribution(ENTRY);
        unplant(p);
        plant('sess-a', POINTER);
        const good = appendAttribution(ENTRY);

        expect(keysOf(bad)).toEqual(BASE_KEYS);
        expect(good.run_id).toBe(POINTER.run_id);
    });

    posixIt('appendAttribution_pointerIsADanglingSymlink_rowUnchangedAndNoThrow', () => {
        const p = pointerPath('sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.symlinkSync(path.join(tmp.root, 'does-not-exist.json'), p);

        const bad = appendAttribution(ENTRY);
        unplant(p);
        plant('sess-a', POINTER);
        const good = appendAttribution(ENTRY);

        expect(keysOf(bad)).toEqual(BASE_KEYS);
        expect(readAttribution()).toHaveLength(2);
        expect(good.run_id).toBe(POINTER.run_id);
    });

    posixIt('appendAttribution_pointerIsAFifo_neverBlocksAndRowUnchangedThenValidPointerStamps', () => {
        // A blocking read of a FIFO cannot be timed out inside the vitest worker: run the append in a child with a
        // hard spawnSync timeout. The child appends twice: once over the FIFO, once after it is replaced by a valid pointer.
        const p = pointerPath('sess-a');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        expect(spawnSync('mkfifo', [p]).status).toBe(0);
        const code = [
            `const m = require(${JSON.stringify(LEDGER)});`,
            `const fs = require('fs');`,
            `const bad = m.appendAttribution({ story_id: 'fifo' }, { root: process.env.CLAUDE_PROJECT_DIR });`,
            `fs.unlinkSync(${JSON.stringify(p)});`,
            `fs.writeFileSync(${JSON.stringify(p)}, ${JSON.stringify(JSON.stringify(POINTER))});`,
            `const good = m.appendAttribution({ story_id: 'regular' }, { root: process.env.CLAUDE_PROJECT_DIR });`,
            `process.stdout.write(JSON.stringify({ bad, good }));`,
        ].join('\n');

        const res = spawnSync(process.execPath, ['-e', code], {
            env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, CLAUDE_CODE_SESSION_ID: 'sess-a' },
            encoding: 'utf8',
            timeout: 15000,
        });

        expect(res.error).toBeUndefined();
        expect(res.status).toBe(0);
        const out = JSON.parse(res.stdout);
        expect(keysOf(out.bad)).toEqual(BASE_KEYS);
        expect(out.good.run_id).toBe(POINTER.run_id);
    });

    it.each([['../evil'], ['a/b'], ['..'], ['a b'], ['x\u0000y'], ['sess*'], ['']])(
        'appendAttribution_unsafeSessionId_%j_rowUnchangedAndNothingReadOutsideTheTelemetryDir',
        (unsafe) => {
            // Traps: pointers that a naive `current-run-${session}.json` join would resolve to for the traversal ids.
            const trapDir = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'current-run-..');
            fs.mkdirSync(trapDir, { recursive: true });
            fs.writeFileSync(path.join(trapDir, 'current-run-evil.json'), JSON.stringify(POINTER));
            fs.writeFileSync(path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'current-run-.json'), JSON.stringify(POINTER));
            fs.writeFileSync(path.join(tmp.root, 'docs', '.output', '.state', 'current-run-evil.json'), JSON.stringify(POINTER));
            delete process.env.CLAUDE_CODE_SESSION_ID;
            plant('sess-a', POINTER);

            const bad = appendAttribution(ENTRY, { session: unsafe });
            const good = appendAttribution(ENTRY, { session: 'sess-a' });

            expect(keysOf(bad)).toEqual(BASE_KEYS);
            expect(good.run_id).toBe(POINTER.run_id);
        },
    );

    it('appendAttributionCli_envSessionWithPointer_persistsRowWithRunIdAndWave', () => {
        plant('sess-cli', POINTER);

        const res = spawnSync(process.execPath, [LEDGER, 'append', JSON.stringify(ENTRY)], {
            env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, CLAUDE_CODE_SESSION_ID: 'sess-cli' },
            encoding: 'utf8',
            timeout: 15000,
        });

        expect(res.status).toBe(0);
        expect(JSON.parse(res.stdout)).toMatchObject({ run_id: POINTER.run_id, wave: 3 });
        expect(lastRow()).toMatchObject({ run_id: POINTER.run_id, wave: 3, story_id: 'SF-3.2' });
    });

    it('appendAttributionCli_envSessionWithoutPointer_rowUnchangedAndExit0', () => {
        const res = spawnSync(process.execPath, [LEDGER, 'append', JSON.stringify(ENTRY)], {
            env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root, CLAUDE_CODE_SESSION_ID: 'sess-none' },
            encoding: 'utf8',
            timeout: 15000,
        });

        expect(res.status).toBe(0);
        expect(keysOf(JSON.parse(res.stdout))).toEqual(BASE_KEYS);
    });
});


// ── Wave 4 Group B review: M2 (the pointer root) ──────────────────────────────────────────────────────────────
describe('M2 attribution rows from a linked worktree read the pointer under the main worktree', () => {
    const { spawnSync } = require('node:child_process');
    const { createLinkedWorktree } = require('../../__tests__/_helpers/linked-worktree');
    const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
    const gitIt = hasGit ? it : it.skip;
    const POINTER = { run_id: '261118-1200-run-todo-wt', plan: null, wave: 2, story: null, since: '261118-1200' };
    let fx = null;
    afterEach(() => { if (fx) { fx.cleanup(); fx = null; } });

    gitIt('appendAttribution_rootIsTheLinkedWorktree_stampsFromThePointerUnderTheMainWorktree', () => {
        fx = createLinkedWorktree();
        const pointer = path.join(fx.main, 'docs', '.output', '.state', 'telemetry', 'current-run-sess-wt.json');
        fs.mkdirSync(path.dirname(pointer), { recursive: true });
        fs.writeFileSync(pointer, JSON.stringify(POINTER));

        const written = appendAttribution({ story_id: 'S-1' }, { root: fx.linked, session: 'sess-wt' });

        expect(written).toMatchObject({ run_id: POINTER.run_id, wave: 2 });
        expect(readAttribution(undefined, { root: fx.linked }).at(-1)).toMatchObject({ story_id: 'S-1', run_id: POINTER.run_id });
    });
});
