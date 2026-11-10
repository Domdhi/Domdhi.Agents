// AC→source map (memory-recall hook, UserPromptSubmit):
//   - injects the relevant full memories as additionalContext; skips short prompts, slash commands, empty store
//   - never repeats a memory within a session; caps count and size well under the ~10 KB hook limit
//   - keyword-only mode injects nothing for an unrelated prompt (relevance gate)
//   - embedder down / unreachable: still answers, quickly; stale index starts ONE detached index run
//   - engine JSON memories are recalled with no migration
//   - disabled by MEMORY_RECALL=off and MEMORY_PROFILE=minimal; as a process it always exits 0 and never writes garbage
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const HOOK = path.resolve(__dirname, '../memory-recall.cjs');
const CLAUDE_WRAPPER = path.resolve(__dirname, '../../../.claude/hooks/memory-recall.cjs');
const hook = require('../memory-recall.cjs');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
const { startEmbedServer } = require('../../core/__tests__/_helpers/memory-fakes');
const R = require('../../core/_lib/memory-recall');
const { loadCorpus } = require('../../core/_lib/memory-notes');

const KEYS = ['MEMORY_RECALL_MAX', 'MEMORY_RECALL_FLOOR', 'AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'MEMORY_DIR', 'MEMORY_PROFILE', 'MEMORY_RECALL', 'MEMORY_EMBED_PROVIDER', 'MEMORY_EMBED_URL', 'MEMORY_EMBED_MODEL', 'CLAUDE_CONFIG_DIR', 'MEMORY_CAPTURE_INNER'];
const saved = {};
let tmp, memDir, servers;

beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    tmp = createTmpDir({ prefix: 'memory-recall-hook-' });
    memDir = path.join(tmp.root, 'mem');
    fs.mkdirSync(memDir);
    servers = [];
    Object.assign(process.env, { AGENT_SHARED_STATE_ROOT: tmp.root, AGENTS_PROJECT_DIR: tmp.root, MEMORY_DIR: memDir, MEMORY_PROFILE: 'standard', MEMORY_EMBED_PROVIDER: 'none', CLAUDE_CONFIG_DIR: path.join(tmp.root, 'claude') });
    delete process.env.MEMORY_RECALL;
});
afterEach(async () => {
    vi.restoreAllMocks();
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await Promise.all(servers.map(s => s.close()));
    tmp.cleanup();
});

const note = (name, desc, body) => fs.writeFileSync(path.join(memDir, `${name}.md`), `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${body}\n`);
const ctxOf = out => out.hookSpecificOutput.additionalContext;
// Terms that appear in every note carry no signal (idf ~ 0), so ranking tests need a store with unrelated notes in it.
const FILLER = ['gardening tomatoes watering', 'violin practice scales', 'sourdough starter feeding', 'marathon training plan', 'kayak paddle storage', 'telescope mirror cleaning', 'beehive winter prep', 'chess opening notes'];
const filler = (copies = 1) => { for (let c = 0; c < copies; c++) FILLER.forEach((f, i) => note(`filler-${c}-${i}`, f, `${f} reminder number ${i} round ${c}`)); };
const MINT = 'what do I pay for my Mint Mobile phone plan each year';

describe('injection', () => {
    beforeEach(() => {
        note('mint-plan', 'phone plan cost', 'Mint Mobile annual plan renews in July at 206 dollars.');
        note('rustdesk', 'rustdesk lock', 'RustDesk locks the screen after the viewer disconnects.');
    });

    it('injects the matching memory in the UserPromptSubmit envelope', async () => {
        const out = await hook.processEvent({ prompt: MINT, session_id: 's1' });
        expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
        expect(ctxOf(out)).toContain(hook.HEADER);
        expect(ctxOf(out)).toContain('### mint-plan');
        expect(ctxOf(out)).toContain('206 dollars');
        expect(ctxOf(out)).not.toContain('RustDesk');
    });
    it('skips short prompts, slash commands, and an empty store', async () => {
        expect(await hook.processEvent({ prompt: 'hi', session_id: 's1' })).toBeNull();
        expect(await hook.processEvent({ prompt: '/review:status mint mobile phone plan', session_id: 's1' })).toBeNull();
        expect(await hook.processEvent({ session_id: 's1' })).toBeNull();
        fs.rmSync(memDir, { recursive: true });
        expect(await hook.processEvent({ prompt: MINT, session_id: 's1' })).toBeNull();
    });
    it('skips machine-generated prompts (teammate messages, task notifications, delegated-task envelopes)', async () => {
        const body = ' {"type":"idle_notification"} what do I pay for my Mint Mobile phone plan each year';
        for (const head of ['Another Claude session sent a message: <teammate-message teammate_id="w1">', '<teammate-message teammate_id="w1">', '<task-notification><task-id>x</task-id>', 'Delegated task node:abc ']) {
            expect(await hook.processEvent({ prompt: head + body, session_id: 's1' })).toBeNull();
        }
        expect(await hook.processEvent({ prompt: 'Another Claude is wrong about this: ' + MINT, session_id: 's1' })).not.toBeNull();
    });
    it('injects nothing into the capture\'s own claude -p child (recursion guard)', async () => {
        process.env.MEMORY_CAPTURE_INNER = '1';
        expect(await hook.processEvent({ prompt: MINT, session_id: 's1' })).toBeNull();
    });
    it('does not repeat a memory within a session, but does in a new one', async () => {
        expect(await hook.processEvent({ prompt: MINT, session_id: 's1' })).not.toBeNull();
        expect(await hook.processEvent({ prompt: MINT, session_id: 's1' })).toBeNull();
        expect(await hook.processEvent({ prompt: MINT, session_id: 's2' })).not.toBeNull();
    });
    it('injects nothing for an unrelated prompt in keyword-only mode', async () => {
        expect(await hook.processEvent({ prompt: 'please refactor the dashboard layout and tidy the sidebar plan', session_id: 's1' })).toBeNull();
    });
    it('sanitizes the session id used for the dedupe file (no path traversal)', async () => {
        await hook.processEvent({ prompt: MINT, session_id: '../../evil' });
        const seen = path.join(tmp.root, 'docs', '.output', '.state', 'memory-notes', 'seen');
        expect(fs.readdirSync(seen)).toEqual(['evil.json']);
    });
});

describe('size and count caps', () => {
    it('never injects more than 3 memories or more than ~6 KB, whatever the store holds', async () => {
        filler(3);
        for (let i = 0; i < 6; i++) note(`deploy-${i}`, `deploy notes ${i}`, `deploy production server rollout checklist ${'step '.repeat(3000)}`);
        const out = await hook.processEvent({ prompt: 'how do I deploy to the production server rollout checklist', session_id: 's1' });
        const text = ctxOf(out);
        expect((text.match(/^### /gm) || []).length).toBeLessThanOrEqual(3);
        expect(Buffer.byteLength(text)).toBeLessThan(7000);
        expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(10 * 1024);
    });
});

describe('tuning and precision telemetry', () => {
    beforeEach(() => {
        filler();
        for (let i = 0; i < 4; i++) note(`deploy-${i}`, `deploy notes ${i}`, `deploy production server rollout checklist number ${i}`);
    });
    const ask = () => hook.processEvent({ prompt: 'how do I deploy to the production server rollout', session_id: 's1' });

    it('MEMORY_RECALL_MAX caps the number of memories (clamped to 1..5; junk falls back to 3)', async () => {
        process.env.MEMORY_RECALL_MAX = '1';
        expect((ctxOf(await ask()).match(/^### /gm) || []).length).toBe(1);
        expect(hook.tuning({ MEMORY_RECALL_MAX: '99' }).maxHits).toBe(5);
        expect(hook.tuning({ MEMORY_RECALL_MAX: '0' }).maxHits).toBe(1);
        expect(hook.tuning({ MEMORY_RECALL_MAX: 'lots' }).maxHits).toBe(3);
        expect(hook.tuning({}).maxHits).toBe(3);
        delete process.env.MEMORY_RECALL_MAX;
    });
    it('MEMORY_RECALL_KW_SCORE reaches the hook tuning (default 1.75, clamped 0.25..4)', () => {
        expect(hook.tuning({}).kwScore).toBe(1.75);
        expect(hook.tuning({ MEMORY_RECALL_KW_SCORE: '1' }).kwScore).toBe(1);
        expect(hook.tuning({ MEMORY_RECALL_KW_SCORE: '0.01' }).kwScore).toBe(0.25);
    });
    it('MEMORY_RECALL_FLOOR defaults to 0.70 and is clamped', () => {
        expect(hook.tuning({}).floor).toBe(0.7);
        expect(hook.tuning({ MEMORY_RECALL_FLOOR: '0.72' }).floor).toBe(0.72);
        expect(hook.tuning({ MEMORY_RECALL_FLOOR: '5' }).floor).toBe(0.95);
        expect(hook.tuning({ MEMORY_RECALL_FLOOR: '0' }).floor).toBe(0.3);
        expect(hook.tuning({ MEMORY_RECALL_FLOOR: 'x' }).floor).toBe(0.7);
    });
    it('a high floor makes the hybrid ranker quieter: embedding-only hits are dropped', async () => {
        const s = await startEmbedServer(); servers.push(s);
        Object.assign(process.env, { MEMORY_EMBED_PROVIDER: 'openai', MEMORY_EMBED_URL: `${s.url}/v1`, MEMORY_EMBED_MODEL: 'test-embed' });
        await R.syncIndex(loadCorpus({ memoryDir: memDir }), path.join(tmp.root, 'docs', '.output', '.state', 'memory-notes'), R.embedConfig(process.env));
        process.env.MEMORY_RECALL_FLOOR = '0.95';
        const out = await hook.processEvent({ prompt: 'quantum chromodynamics lattice simulation parameters', session_id: 'q1' });
        expect(out).toBeNull();
        delete process.env.MEMORY_RECALL_FLOOR;
    });
    it('records one telemetry line per ranked prompt, with ids and cosines but never the prompt text', async () => {
        await ask();
        await hook.processEvent({ prompt: 'zzzz qqqq wwww xxxx yyyy vvvv uuuu', session_id: 's1' });
        const f = path.join(tmp.root, 'docs', '.output', '.state', 'telemetry', 'memory-recall.jsonl');
        const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ type: 'memory_recall', source: 'keyword-only', session_proxy: 's1' });
        expect(lines[0].injected_count).toBe(3);
        expect(lines[0].injected_ids).toHaveLength(3);
        expect(lines[1].injected_count).toBe(0);
        expect(fs.readFileSync(f, 'utf8')).not.toMatch(/tomato|gardening|deploy to the production/);
    });
});

describe('engine memories', () => {
    it('recalls the engine JSON store with no notes at all', async () => {
        const dir = path.join(tmp.root, 'docs', '.output', '.memory', 'constraints');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'bw-sync-first.json'), JSON.stringify({ id: 'bw-sync-first', content: { description: 'Run bw sync before listing vault items.', correct_pattern: 'bw sync' } }));
        fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ id: 'old-thing', invalid_at: '2026-01-01T00:00:00Z', content: { description: 'Run bw sync before listing vault items, retired.' } }));
        const out = await hook.processEvent({ prompt: 'run bw sync before I list the vault items', session_id: 's1' });
        expect(ctxOf(out)).toContain('### bw-sync-first');
        expect(ctxOf(out)).not.toContain('old-thing');
    });
});

describe('gates', () => {
    beforeEach(() => note('mint-plan', 'phone plan cost', 'Mint Mobile annual plan renews in July at 206 dollars.'));
    it('MEMORY_RECALL=off disables it', async () => {
        process.env.MEMORY_RECALL = 'off';
        expect(await hook.processEvent({ prompt: MINT, session_id: 's1' })).toBeNull();
    });
    it('MEMORY_PROFILE=minimal disables it', async () => {
        process.env.MEMORY_PROFILE = 'minimal';
        expect(await hook.processEvent({ prompt: MINT, session_id: 's1' })).toBeNull();
    });
});

describe('embedder behavior', () => {
    beforeEach(() => {
        note('mint-plan', 'phone plan cost', 'Mint Mobile annual plan renews in July at 206 dollars.');
        note('rustdesk', 'rustdesk lock', 'RustDesk locks the screen after the viewer disconnects.');
    });
    const useEmbedder = async opts => {
        const s = await startEmbedServer(opts); servers.push(s);
        Object.assign(process.env, { MEMORY_EMBED_PROVIDER: 'openai', MEMORY_EMBED_URL: `${s.url}/v1`, MEMORY_EMBED_MODEL: 'test-embed' });
        return s;
    };

    it('an unreachable embedder degrades to keyword-only, fast', async () => {
        Object.assign(process.env, { MEMORY_EMBED_PROVIDER: 'openai', MEMORY_EMBED_URL: 'http://127.0.0.1:9/v1' });
        const t = Date.now();
        const out = await hook.processEvent({ prompt: MINT, session_id: 's1' });
        expect(Date.now() - t).toBeLessThan(1500);
        expect(ctxOf(out)).toContain('### mint-plan');
    });
    it('uses an indexed embedder (hybrid) and only embeds the query', async () => {
        const s = await useEmbedder();
        const cfg = R.embedConfig(process.env);
        await R.syncIndex(loadCorpus({ memoryDir: memDir }), path.join(tmp.root, 'docs', '.output', '.state', 'memory-notes'), cfg);
        const before = s.calls.length;
        const out = await hook.processEvent({ prompt: MINT, session_id: 's1' });
        expect(ctxOf(out)).toContain('### mint-plan');
        expect(s.calls.length - before).toBe(1);
        expect(s.calls[before].body.input).toHaveLength(1);
    });
    it('a stale index starts one detached index run, then not again for ten minutes', async () => {
        await useEmbedder();
        const cfg = R.embedConfig(process.env);
        const stateDir = path.join(tmp.root, 'docs', '.output', '.state', 'memory-notes');
        await R.syncIndex(loadCorpus({ memoryDir: memDir }), stateDir, cfg);
        note('new-one', 'brand new memory', 'Mint Mobile phone plan note added after the index was built.');   // now stale
        const unref = vi.fn();
        const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue({ unref });
        await hook.processEvent({ prompt: MINT, session_id: 's1' });
        await hook.processEvent({ prompt: MINT + ' again please', session_id: 's2' });
        expect(spawn).toHaveBeenCalledTimes(1);
        const [cmd, args, opts] = spawn.mock.calls[0];
        expect(cmd).toBe(process.execPath);
        expect(args.slice(1)).toEqual(['index']);
        expect(args[0]).toMatch(/memory-capture\.js$/);
        expect(opts).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore' });
        expect(unref).toHaveBeenCalled();
    });
    it('does not start an index run when there is no embedder', async () => {
        const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue({ unref() {} });
        await hook.processEvent({ prompt: MINT, session_id: 's1' });
        expect(spawn).not.toHaveBeenCalled();
    });
});

describe('as a process (the contract Claude Code relies on)', () => {
    const run = (script, input) => spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env } });
    beforeEach(() => note('mint-plan', 'phone plan cost', 'Mint Mobile annual plan renews in July at 206 dollars.'));

    for (const [label, script] of [['canonical hook', HOOK], ['generated .claude wrapper', CLAUDE_WRAPPER]]) {
        it(`${label}: valid prompt prints one JSON envelope and exits 0`, () => {
            const r = run(script, JSON.stringify({ prompt: MINT, session_id: 'p1', hook_event_name: 'UserPromptSubmit' }));
            expect(r.status).toBe(0);
            expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('mint-plan');
        });
        it(`${label}: garbage, empty, or irrelevant input exits 0 with no output`, () => {
            for (const input of ['{not json', '', JSON.stringify({ prompt: 'zzzz qqqq wwww xxxx yyyy' }), '[]', 'null']) {
                const r = run(script, input);
                expect(r.status).toBe(0);
                expect(r.stdout).toBe('');
            }
        });
    }
});
