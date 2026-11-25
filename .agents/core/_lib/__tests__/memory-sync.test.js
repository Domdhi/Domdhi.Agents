// AC→source map (memory-sync): notes travel over git via the tracked docs/.output/.memory/notes mirror.
//   - first sync pushes local-only notes and pulls tracked-only notes; identical files are left alone
//   - three-way: only the side that moved since the last sync wins; both moved = CONFLICT, nothing overwritten
//   - --prefer resolves a conflict and the replaced local copy is saved first
//   - never deletes; MEMORY.md and dot files are not notes; pulled notes are added to MEMORY.md exactly once
//   - secrets are neither pushed nor pulled; dry-run writes nothing; direction flags limit the pass
//   - autoSync is a no-op unless MEMORY_SYNC=on and never throws
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const S = require('../memory-sync');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

let tmp, local, tracked, state;
beforeEach(() => {
    tmp = createTmpDir({ prefix: 'memory-sync-' });
    local = path.join(tmp.root, 'local');
    tracked = path.join(tmp.root, 'tracked');
    state = path.join(tmp.root, 'state');
    fs.mkdirSync(local);
});
afterEach(() => tmp.cleanup());

const note = (name, body, desc = `about ${name}`) => `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${body}\n`;
const put = (dir, file, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const run = (o = {}) => S.sync({ localDir: local, trackedDir: tracked, stateDir: state, ...o });

describe('first sync', () => {
    it('pushes local-only notes, pulls tracked-only notes, and ignores what is not a note', () => {
        put(local, 'a.md', note('a', 'local a'));
        put(local, 'MEMORY.md', '- [a](a.md)\n');
        put(local, '.hidden.md', note('h', 'hidden'));
        put(local, 'x.txt', 'not markdown');
        put(tracked, 'b.md', note('b', 'tracked b'));
        const r = run();
        expect(r.pushed).toEqual(['a.md']);
        expect(r.pulled).toEqual(['b.md']);
        expect(read(tracked, 'a.md')).toBe(note('a', 'local a'));
        expect(read(local, 'b.md')).toBe(note('b', 'tracked b'));
        expect(fs.existsSync(path.join(tracked, 'MEMORY.md'))).toBe(false);
        expect(fs.existsSync(path.join(tracked, '.hidden.md'))).toBe(false);
        expect(fs.existsSync(path.join(tracked, 'x.txt'))).toBe(false);
    });
    it('is idempotent: a second pass has nothing to do', () => {
        put(local, 'a.md', note('a', 'x'));
        run();
        const r = run();
        expect(r.pushed).toEqual([]);
        expect(r.pulled).toEqual([]);
        expect(r.same).toBe(1);
    });
    it('adds each pulled note to MEMORY.md once, with its description', () => {
        put(tracked, 'b.md', note('b', 'body', 'the b note'));
        run();
        run();
        const idx = read(local, 'MEMORY.md');
        expect(idx.match(/\(b\.md\)/g)).toHaveLength(1);
        expect(idx).toContain('- [b](b.md) — the b note');
    });
    it('does not duplicate an index line the note already has', () => {
        put(local, 'MEMORY.md', '- [b](b.md) — already here\n');
        put(tracked, 'b.md', note('b', 'body'));
        run();
        expect(read(local, 'MEMORY.md')).toBe('- [b](b.md) — already here\n');
    });
});

describe('three-way changes', () => {
    beforeEach(() => { put(local, 'a.md', note('a', 'v1')); run(); });

    it('a local edit is pushed', () => {
        put(local, 'a.md', note('a', 'v2 local'));
        expect(run().pushed).toEqual(['a.md']);
        expect(read(tracked, 'a.md')).toContain('v2 local');
    });
    it('a tracked edit (another machine, arrived by git pull) is pulled', () => {
        put(tracked, 'a.md', note('a', 'v2 remote'));
        expect(run().pulled).toEqual(['a.md']);
        expect(read(local, 'a.md')).toContain('v2 remote');
    });
    it('both sides editing the same note is a conflict and nothing is overwritten', () => {
        put(local, 'a.md', note('a', 'mine'));
        put(tracked, 'a.md', note('a', 'theirs'));
        const r = run();
        expect(r.conflicts.map(c => c.name)).toEqual(['a.md']);
        expect(r.pushed).toEqual([]);
        expect(r.pulled).toEqual([]);
        expect(read(local, 'a.md')).toContain('mine');
        expect(read(tracked, 'a.md')).toContain('theirs');
        expect(run().conflicts).toHaveLength(1); // still reported until someone decides
    });
    it('--prefer local pushes, --prefer tracked pulls and saves the local copy first', () => {
        put(local, 'a.md', note('a', 'mine'));
        put(tracked, 'a.md', note('a', 'theirs'));
        expect(run({ prefer: 'local' }).pushed).toEqual(['a.md']);
        expect(read(tracked, 'a.md')).toContain('mine');

        put(local, 'a.md', note('a', 'mine again'));
        put(tracked, 'a.md', note('a', 'theirs again'));
        expect(run({ prefer: 'tracked' }).pulled).toEqual(['a.md']);
        expect(read(local, 'a.md')).toContain('theirs again');
        const saved = fs.readdirSync(path.join(state, 'sync-backup'));
        expect(saved.some(f => read(path.join(state, 'sync-backup'), f).includes('mine again'))).toBe(true);
    });
    it('never deletes: a note missing on one side comes back from the other', () => {
        fs.unlinkSync(path.join(tracked, 'a.md'));
        expect(run().pushed).toEqual(['a.md']);
        fs.unlinkSync(path.join(local, 'a.md'));
        expect(run().pulled).toEqual(['a.md']);
    });
});

describe('a tracked mirror that lags the shared local dir (several worktrees, one local dir and one state dir)', () => {
    it('keeps one base per tracked dir, so another worktree\'s base never turns a lagging mirror into a pull', () => {
        const trackedMain = path.join(tmp.root, 'wt-main'), trackedOld = path.join(tmp.root, 'wt-old');
        put(local, 'n.md', note('n', 'v1'));
        S.sync({ localDir: local, trackedDir: trackedMain, stateDir: state });
        put(trackedOld, 'n.md', note('n', 'v1'));            // the lagging worktree's committed mirror
        put(local, 'n.md', note('n', 'v2 only here'));
        S.sync({ localDir: local, trackedDir: trackedMain, stateDir: state, direction: 'push' });
        expect(read(trackedMain, 'n.md')).toContain('v2 only here');

        // The other worktree starts a session (pull). It has no base of its own: both sides differ, so this is a conflict.
        const r = S.sync({ localDir: local, trackedDir: trackedOld, stateDir: state, direction: 'pull' });
        expect(r.pulled).toEqual([]);
        expect(r.conflicts.map(c => c.name)).toEqual(['n.md']);
        expect(read(local, 'n.md')).toContain('v2 only here');
        expect(S.baseFile(state, trackedMain)).not.toBe(S.baseFile(state, trackedOld));
    });
    it('saves the local copy before any pull that replaces it, even when the local copy equals the recorded base', () => {
        const backupDir = path.join(tmp.root, 'backup');
        const L = { 'n.md': { sha: 'sha-v2', text: note('n', 'v2') } };
        const T = { 'n.md': { sha: 'sha-v1', text: note('n', 'v1') } };
        put(local, 'n.md', L['n.md'].text);
        const actions = S.plan({ local: L, tracked: T, base: { 'n.md': 'sha-v2' } });
        expect(actions).toEqual([{ name: 'n.md', op: 'pull' }]);   // the stale-base pull the plan cannot tell apart
        S.apply({ actions, local: L, tracked: T, base: { 'n.md': 'sha-v2' }, localDir: local, trackedDir: tracked, backupDir });
        expect(read(local, 'n.md')).toContain('v1');
        const saved = fs.readdirSync(backupDir);
        expect(saved).toHaveLength(1);
        expect(read(backupDir, saved[0])).toContain('v2');
    });
});

describe('guards', () => {
    const isSecret = t => /sk-ant-[a-z0-9]{10,}/.test(t);
    it('does not push or pull a note that looks like a secret', () => {
        put(local, 'leak.md', note('leak', 'key sk-ant-abcdefghijklmnop'));
        put(tracked, 'leak2.md', note('leak2', 'key sk-ant-abcdefghijklmnop'));
        const r = run({ isSecret });
        expect(r.secrets.map(s => s.name).sort()).toEqual(['leak.md', 'leak2.md']);
        expect(fs.existsSync(path.join(tracked, 'leak.md'))).toBe(false);
        expect(fs.existsSync(path.join(local, 'leak2.md'))).toBe(false);
    });
    it('--dry-run writes nothing, not even the ledger', () => {
        put(local, 'a.md', note('a', 'x'));
        put(tracked, 'b.md', note('b', 'y'));
        const r = run({ dryRun: true });
        expect(r.pushed).toEqual(['a.md']);
        expect(r.pulled).toEqual(['b.md']);
        expect(fs.existsSync(path.join(tracked, 'a.md'))).toBe(false);
        expect(fs.existsSync(path.join(local, 'b.md'))).toBe(false);
        expect(fs.existsSync(path.join(state, 'sync.json'))).toBe(false);
        expect(fs.existsSync(state) ? fs.readdirSync(state).filter(f => /^sync.*\.json$/.test(f)) : []).toEqual([]);
    });
    it('direction limits the pass', () => {
        put(local, 'a.md', note('a', 'x'));
        put(tracked, 'b.md', note('b', 'y'));
        expect(run({ direction: 'push' }).pulled).toEqual([]);
        expect(fs.existsSync(path.join(tracked, 'a.md'))).toBe(true);
        expect(fs.existsSync(path.join(local, 'b.md'))).toBe(false);
        expect(run({ direction: 'pull' }).pulled).toEqual(['b.md']);
    });
    it('works when either directory does not exist yet', () => {
        const r = S.sync({ localDir: path.join(tmp.root, 'nope'), trackedDir: path.join(tmp.root, 'nope2'), stateDir: state });
        expect(r.actions).toEqual([]);
    });
});

describe('autoSync', () => {
    const fallbackDir = () => tmp.root;
    it('does nothing unless MEMORY_SYNC is on', () => {
        put(local, 'a.md', note('a', 'x'));
        expect(S.autoSync({ direction: 'push', fallbackDir: fallbackDir(), env: { MEMORY_DIR: local } })).toBeNull();
        expect(S.autoSync({ direction: 'push', fallbackDir: fallbackDir(), env: { MEMORY_DIR: local, MEMORY_SYNC: 'off' } })).toBeNull();
    });
    it('pushes into <repo>/docs/.output/.memory/notes when on, and never throws', () => {
        put(local, 'a.md', note('a', 'x'));
        const env = { MEMORY_DIR: local, MEMORY_SYNC: 'on', AGENT_SHARED_STATE_ROOT: tmp.root, AGENTS_PROJECT_DIR: tmp.root };
        const r = S.autoSync({ direction: 'push', fallbackDir: fallbackDir(), env });
        expect(r.pushed).toEqual(['a.md']);
        expect(fs.existsSync(path.join(tmp.root, 'docs', '.output', '.memory', 'notes', 'a.md'))).toBe(true);
        put(local, 'b.md', note('b', 'new'));
        expect(S.autoSync({ direction: 'push', fallbackDir: fallbackDir(), env, isSecret: () => { throw new Error('boom'); } })).toBeNull();
    });
});
