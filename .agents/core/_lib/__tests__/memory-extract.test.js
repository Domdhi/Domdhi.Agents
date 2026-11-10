// AC→source map (memory-extract): leak guard keeps user text but drops memory writes; quote/secret/duplicate filters;
// truncated-output salvage; candidate file shape; Anthropic call (retry, key never echoed); OpenAI-compatible call.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const X = require('../memory-extract');
const N = require('../memory-notes');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { startAnthropicServer, writeFakeClaude } = require('../../__tests__/_helpers/memory-fakes');

let tmp, servers;
beforeEach(() => { tmp = createTmpDir({ prefix: 'memory-extract-' }); servers = []; });
afterEach(async () => { await Promise.all(servers.map(s => s.close())); tmp.cleanup(); });

const user = text => ({ type: 'user', message: { role: 'user', content: text } });
const asst = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const session = rows => { const p = path.join(tmp.root, 's.jsonl'); fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return p; };

describe('modelTable', () => {
    it('reads the pinned ids and prices from the claude adapter metadata, not from code', () => {
        const t = X.modelTable();
        expect(t.defaultAlias).toBe('haiku');
        expect(t.models.haiku.id).toMatch(/^claude-haiku-/);
        expect(t.models.sonnet.inPerM).toBeGreaterThan(t.models.haiku.inPerM);
        expect(fs.readFileSync(require.resolve('../memory-extract'), 'utf8')).not.toMatch(/claude-(haiku|sonnet)-\d/);
    });
});

describe('renderSession', () => {
    it('drops anything that shows a memory being written but keeps the user and ordinary tool output', () => {
        const r = X.renderSession(session([
            user('always call it legion lowercase'), asst('I saved a memory about that'),
            tool('t1', 'Write', { file_path: '/x/memory/legion.md', content: 'legion' }), result('t1', 'ok'),
            tool('t2', 'Bash', { command: 'ls' }), result('t2', 'file.txt'),
        ]));
        expect(r.raw).toContain('always call it legion lowercase');
        expect(r.raw).not.toContain('saved a memory');
        expect(r.raw).not.toContain('/memory/');
        expect(r.raw).toContain('file.txt');
        expect(r.userRaw).toBe('always call it legion lowercase');
    });
    it('skips system reminders, sidechains, meta rows and unparseable lines', () => {
        const p = path.join(tmp.root, 's.jsonl');
        fs.writeFileSync(p, ['{bad', JSON.stringify(user('<system-reminder>x</system-reminder>')), JSON.stringify({ ...user('side'), isSidechain: true }), JSON.stringify({ ...user('meta'), isMeta: true }), JSON.stringify(user('real'))].join('\n'));
        expect(X.renderSession(p).userRaw).toBe('real');
    });
    it('user-only input carries a short excerpt of what the assistant said before', () => {
        const r = X.renderSession(session([asst('I will use pkill -f'), user('never do that')]));
        expect(X.userOnly(r)).toBe('[ASSISTANT said before] I will use pkill -f\n[USER] never do that');
    });
    it('chunks long input at event boundaries', () => {
        const s = Array.from({ length: 20 }, (_, i) => `[USER] ${'x'.repeat(40)} ${i}`).join('\n');
        const parts = X.chunks(s, 200);
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.join('')).toBe(s);
    });
});

describe('filterCandidates', () => {
    const render = () => X.renderSession(session([user('never run pkill -f on your own pattern, it kills the shell'), asst('ok'), user('my key is sk-ant-abcdefghijklmnop')]));
    it('keeps a verbatim-quoted candidate; drops invented quotes, secrets and in-run duplicates', () => {
        const cands = [
            { title: 'Never pkill -f own pattern', text: 'pkill -f matches the shell that holds the pattern and kills it.', evidence_quote: 'never run pkill -f on your own pattern, it kills the shell' },
            { title: 'Invented', text: 'The user likes tabs.', evidence_quote: 'i love tabs so much' },
            { title: 'Key', text: 'User key is sk-ant-abcdefghijklmnop', evidence_quote: 'my key is sk-ant-abcdefghijklmnop' },
            { title: 'Same again', text: 'pkill -f matches the shell that holds the pattern and kills it, never do it.', evidence_quote: 'never run pkill -f on your own pattern, it kills the shell' },
            { title: '', text: 'no title', evidence_quote: 'x' },
        ];
        const { kept, dropped } = X.filterCandidates(cands, render(), []);
        expect(kept.map(c => c.title)).toEqual(['Never pkill -f own pattern']);
        expect(dropped).toEqual({ no_quote: 1, secret: 1, duplicate: 1, empty: 1 });
        expect(kept[0].quote_in_user).toBe(true);
    });
    it('drops a paraphrase of an existing memory', () => {
        const r = X.renderSession(session([user('write it as legion lowercase, never LEGION')]));
        const existing = ['Write the machine name as legion, all lowercase. Never LEGION in docs scripts and replies.'];
        const { kept, dropped } = X.filterCandidates([{ title: 'legion lowercase', text: 'Write the machine name legion in lowercase, not LEGION.', evidence_quote: 'write it as legion lowercase, never LEGION' }], r, existing);
        expect([kept.length, dropped.duplicate]).toEqual([0, 1]);
    });
    it('uses the injected secret detector as well as the built-in patterns', () => {
        const r = X.renderSession(session([user('the staging host is alpha-9 and the vault path is zzz')]));
        const c = { title: 'Staging host', text: 'The staging host is alpha-9.', evidence_quote: 'the staging host is alpha-9 and the vault path is zzz' };
        expect(X.filterCandidates([{ ...c }], r, []).kept).toHaveLength(1);
        expect(X.filterCandidates([{ ...c }], r, [], { isSecret: t => t.includes('alpha-9') }).dropped.secret).toBe(1);
    });
    it('puts candidates quoting the user first', () => {
        const r = X.renderSession(session([asst('the host is cerebro for sure'), user('remember the standby is dmo please')]));
        const { kept } = X.filterCandidates([
            { title: 'A', text: 'alpha alpha alpha one', evidence_quote: 'the host is cerebro for sure' },
            { title: 'B', text: 'bravo bravo bravo two', evidence_quote: 'remember the standby is dmo please' },
        ], r, []);
        expect(kept.map(c => c.title)).toEqual(['B', 'A']);
    });
});

describe('parseItems', () => {
    it('salvages complete items from truncated output', () => {
        const txt = '```json\n[{"title":"a","text":"one","evidence_quote":"q"},{"title":"b","text":"two","evid';
        expect(X.parseItems(txt).map(x => x.title)).toEqual(['a']);
    });
    it('parses a clean array, ignores non-arrays and items without text', () => {
        expect(X.parseItems('[{"title":"a","text":"t"},{"title":"b"}]')).toHaveLength(1);
        expect(X.parseItems('no json here')).toEqual([]);
        expect(X.parseItems('[]')).toEqual([]);
    });
    it('salvage handles braces and escaped quotes inside strings', () => {
        const txt = '[{"title":"a","text":"use {x} and \\"y\\"","evidence_quote":"q"},{"title":"b","te';
        expect(X.parseItems(txt)[0].text).toBe('use {x} and "y"');
    });
});

describe('candidateFile', () => {
    it('writes provenance frontmatter and the verbatim evidence', () => {
        const f = X.candidateFile({ title: 'Cerebro is the server', type: 'fact', text: 'cerebro is the server and dmo the standby. This matters for ssh.', evidence_quote: 'cerebro is the server', quote_in_user: true }, 'abc12345', '2026-11-09');
        expect(f.id).toMatch(/^[0-9a-f]{6}-cerebro-is-the-server$/);
        const { fm, body } = N.splitFrontmatter(f.content);
        expect(N.fmValue(fm, 'name')).toBe('cerebro-is-the-server');
        expect(N.fmValue(fm, 'originSessionId')).toBe('abc12345');
        expect(N.fmValue(fm, 'captured')).toBe('2026-11-09');
        expect(N.fmValue(fm, 'type')).toBe('reference');
        expect(N.fmValue(fm, 'evidence_in_user_message')).toBe('true');
        expect(body).toContain('**Evidence (verbatim):** "cerebro is the server"');
    });
});

describe('providers', () => {
    it('Anthropic: sends key, model and transcript; returns text and usage', async () => {
        const s = await startAnthropicServer(() => ({ items: [{ title: 't', text: 'x' }], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } }));
        servers.push(s);
        const r = await X.callAnthropic({ model: 'claude-haiku-5-5', key: 'sk-test-key', text: 'hello', known: '- a: b', baseUrl: s.url });
        expect(JSON.parse(r.text)[0].title).toBe('t');
        expect([r.inputTokens, r.outputTokens]).toEqual([15, 3]);
        const c = s.calls[0];
        expect(c.headers['x-api-key']).toBe('sk-test-key');
        expect(c.body.model).toBe('claude-haiku-5-5');
        expect(c.body.messages[0].content).toContain('ALREADY IN MEMORY');
        expect(c.body.messages[0].content).toContain('SESSION TRANSCRIPT:\n\nhello');
    });
    it('Anthropic: retries a 529 and then succeeds', async () => {
        const s = await startAnthropicServer((body, calls) => (calls.length === 1 ? { status: 529 } : { items: [] }));
        servers.push(s);
        const r = await X.callAnthropic({ model: 'm', key: 'k', text: 't', baseUrl: s.url, retryMs: 1 });
        expect(r.text).toBe('[]');
        expect(s.calls).toHaveLength(2);
    });
    it('Anthropic: an error message never contains the key', async () => {
        const s = await startAnthropicServer(() => ({ status: 401, message: 'bad key sk-ant-live-SECRET123' }));
        servers.push(s);
        const err = await X.callAnthropic({ model: 'm', key: 'sk-ant-live-SECRET123', text: 't', baseUrl: s.url }).catch(e => e);
        expect(err.message).toMatch(/^API error 401/);
        expect(err.message).not.toContain('sk-ant-live-SECRET123');
        expect(err.message).toContain('[KEY]');
    });
    it('OpenAI-compatible: posts chat completions with optional bearer key', async () => {
        const http = require('node:http');
        const calls = [];
        const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] })); }); });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        try {
            const r = await X.callOpenAI({ baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, model: 'qwen', key: 'k', text: 'T' });
            expect(r.text).toBe('[]');
            expect(calls[0].url).toBe('/v1/chat/completions');
            expect(calls[0].auth).toBe('Bearer k');
            expect(calls[0].body).toMatchObject({ model: 'qwen', temperature: 0 });
        } finally { srv.closeAllConnections?.(); await new Promise(r => srv.close(r)); }
    });
});

describe('callClaudeCli (keyless provider)', () => {
    const run = (behavior, extra = {}) => {
        const f = writeFakeClaude(path.join(tmp.root, 'bin'), behavior);
        return { f, p: X.callClaudeCli({ model: 'claude-haiku-5-5', text: 'T', known: '', bin: f.bin, env: { ...process.env }, ...extra }) };
    };
    it('returns the envelope result with tokens (cache included) and the reported cost', async () => {
        const { p } = run({ items: [{ type: 'fact' }] });
        expect(await p).toEqual({ text: '[{"type":"fact"}]', inputTokens: 2510, outputTokens: 300, cost: 0.0123 });
    });
    it('rejects a failing exit, a non-envelope reply and an error envelope with a short reason', async () => {
        await expect(run({ exit: 2, stderr: 'rate limited' }).p).rejects.toThrow(/exit 2\): rate limited/);
        await expect(run({ raw: 'not json at all' }).p).rejects.toThrow(/claude -p failed/);
        await expect(run({ raw: JSON.stringify({ is_error: true, result: 'Credit balance is too low' }) }).p).rejects.toThrow(/Credit balance is too low/);
    });
    it('kills a hung child at the timeout', async () => {
        await expect(run({ hang: true }, { timeoutMs: 300 }).p).rejects.toThrow(/timed out/);
    });
    it('says what to do when claude is not installed, and refuses an unsafe model id before spawning anything', async () => {
        await expect(X.callClaudeCli({ model: 'claude-haiku-5-5', text: 'T', known: '', bin: path.join(tmp.root, 'no-such-claude'), env: {} })).rejects.toThrow(/could not be started: not found on PATH.*MEMORY_CAPTURE_CLAUDE_BIN/);
        const f = writeFakeClaude(path.join(tmp.root, 'bin2'), {});
        await expect(X.callClaudeCli({ model: 'x; echo pwned', text: 'T', known: '', bin: f.bin, env: {} })).rejects.toThrow(/unsafe model id/);
        expect(f.call()).toBeNull();
    });
    it('always runs in the same neutral temp directory (a new one per call would litter ~/.claude/projects)', async () => {
        const f = writeFakeClaude(path.join(tmp.root, 'bin3'), { items: [] });
        await X.callClaudeCli({ model: 'claude-haiku-5-5', text: 'T', known: '', bin: f.bin, env: {} });
        const first = f.call().cwd;
        await X.callClaudeCli({ model: 'claude-haiku-5-5', text: 'T', known: '', bin: f.bin, env: {} });
        expect(f.call().cwd).toBe(first);
        expect(path.basename(first)).toBe('domdhi-memory-capture-cwd');
        expect(first.startsWith(tmp.root)).toBe(false);
    });
});
