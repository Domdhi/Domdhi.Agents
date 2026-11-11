// AC→source map (memory-capture CLI, run as a real subprocess against fake servers):
//   - no key / no provider: fails before any network call, nothing staged, nothing ledgered
//   - capture: staged candidates are verbatim-quoted, secret-free, non-duplicate; provenance frontmatter; session ledger prevents re-capture
//   - key sources: ANTHROPIC_API_KEY or MEMORY_CAPTURE_KEY_COMMAND; OpenAI-compatible provider needs no key
//   - human gate: list / promote (memory dir + MEMORY.md + index) / discard (never re-proposed)
//   - backfill + pending; import-engine idempotent; recall over notes + engine; status; dry-run sends nothing
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CLI = path.resolve(__dirname, '../memory-capture.js');
const { createTmpDir } = require('./_helpers/tmp-dir');
const { startAnthropicServer, startEmbedServer, writeFakeClaude } = require('./_helpers/memory-fakes');
const { mungePath } = require('../_lib/memory-notes');

let tmp, servers, env, memDir, sessionsDir, stateDir;

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'memory-capture-cli-' });
    servers = [];
    memDir = path.join(tmp.root, 'mem');
    sessionsDir = path.join(tmp.root, 'claude', 'projects', mungePath(tmp.root));
    stateDir = path.join(tmp.root, 'docs', '.output', '.state', 'memory-notes');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // The developer's own MEMORY_* settings (capture, sync, embed servers) must not reach the CLI under test.
    env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MEMORY_'))), AGENT_SHARED_STATE_ROOT: tmp.root, AGENTS_PROJECT_DIR: tmp.root, CLAUDE_CONFIG_DIR: path.join(tmp.root, 'claude'), MEMORY_DIR: memDir,
        MEMORY_EMBED_PROVIDER: 'none', MEMORY_PROFILE: 'standard',
    };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_PROJECT_DIR']) delete env[k];
});
afterEach(async () => { await Promise.all(servers.map(s => s.close())); tmp.cleanup(); });

const cli = (args, extra = {}) => new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }));
});
const anthropic = async respond => { const s = await startAnthropicServer(respond); servers.push(s); return s; };

const user = text => ({ type: 'user', message: { role: 'user', content: text } });
const asst = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const PKILL = 'never run pkill -f on your own pattern, it kills the shell that holds the pattern';
const writeSession = (id, rows) => { const p = path.join(sessionsDir, `${id}.jsonl`); fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return p; };
const longSession = id => writeSession(id, [user(PKILL + ' and please remember that for every later session we run'), asst('Understood, I will avoid that.'), user('also the standby box is dmo while cerebro is the primary server for all deployments')]);
const candidatesLeft = () => fs.existsSync(path.join(stateDir, 'candidates')) ? fs.readdirSync(path.join(stateDir, 'candidates')).filter(f => f.endsWith('.md')) : [];
const goodItems = [
    { type: 'preference', title: 'Never pkill -f own pattern', text: 'pkill -f matches the shell that holds the pattern and kills it.', evidence_quote: PKILL, evidence_role: 'user' },
    { type: 'fact', title: 'Invented fact', text: 'The user prefers tabs.', evidence_quote: 'i never said this in the session at all' },
    { type: 'fact', title: 'Leaked key', text: 'The token is sk-ant-abcdefghijklmnopqrstuv', evidence_quote: 'also the standby box is dmo while cerebro is the primary server for all deployments' },
    { type: 'fact', title: 'Standby is dmo cerebro primary', text: 'dmo is the standby box and cerebro is the primary server.', evidence_quote: 'also the standby box is dmo while cerebro is the primary server for all deployments', evidence_role: 'user' },
];

describe('capture without a provider', () => {
    it('fails before any network call and leaves no trace', async () => {
        const s = await anthropic(() => ({ items: [] }));
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], { ANTHROPIC_BASE_URL: s.url });
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/ANTHROPIC_API_KEY|MEMORY_CAPTURE_KEY_COMMAND/);
        expect(s.calls).toHaveLength(0);
        expect(fs.existsSync(path.join(stateDir, 'ledger.json'))).toBe(false);
    });
    it('--dry-run sends nothing even with a key', async () => {
        const s = await anthropic(() => ({ items: goodItems }));
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a', '--dry-run'], { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: s.url });
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/chars to send/);
        expect(s.calls).toHaveLength(0);
        expect(candidatesLeft()).toEqual([]);
    });
});

describe('capture', () => {
    it('stages only verbatim-quoted, secret-free candidates with provenance, then refuses to re-capture the session', async () => {
        const s = await anthropic(() => ({ items: goodItems }));
        longSession('sess-a');
        const run = () => cli(['capture', '--session', 'sess-a'], { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: s.url });
        const r = await run();
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/model returned 4; dropped .*"no_quote":1.*"secret":1.*staged 2/);
        const files = candidatesLeft();
        expect(files).toHaveLength(2);
        const text = files.map(f => fs.readFileSync(path.join(stateDir, 'candidates', f), 'utf8')).join('\n');
        expect(text).toContain('originSessionId: sess-a');
        expect(text).toContain('**Evidence (verbatim):**');
        expect(text).not.toContain('sk-ant-');
        expect(text).not.toContain('Invented');
        expect(Object.keys(JSON.parse(fs.readFileSync(path.join(stateDir, 'ledger.json'), 'utf8')))).toEqual(['sess-a']);
        const again = await run();
        expect(again.stdout).toMatch(/already captured/);
        expect(s.calls).toHaveLength(1);
        // the API request carries the transcript but never the key in the body
        expect(JSON.stringify(s.calls[0].body)).not.toContain('sk-test');
        expect(s.calls[0].headers['x-api-key']).toBe('sk-test');
    });
    it('tells the model what is already known and does not re-propose staged or discarded candidates (--force)', async () => {
        const s = await anthropic(() => ({ items: goodItems }));
        longSession('sess-a');
        const env1 = { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: s.url };
        await cli(['capture', '--session', 'sess-a'], env1);
        const second = await cli(['capture', '--session', 'sess-a', '--force'], env1);
        expect(second.stdout).toMatch(/staged 0/);
        expect(s.calls[1].body.messages[0].content).toContain('ALREADY IN MEMORY');
        expect(s.calls[1].body.messages[0].content).toContain('never-pkill-f-own-pattern');
        expect(candidatesLeft()).toHaveLength(2);
    });
    it('skips a session with too little user text without calling the API', async () => {
        const s = await anthropic(() => ({ items: goodItems }));
        writeSession('tiny', [user('hi'), asst('hello')]);
        const r = await cli(['capture', '--session', 'tiny'], { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: s.url });
        expect(r.stdout).toMatch(/too little user text/);
        expect(s.calls).toHaveLength(0);
        expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'ledger.json'), 'utf8')).tiny.staged).toBe(0);
    });
    it('honors --max-keep', async () => {
        const s = await anthropic(() => ({ items: goodItems }));
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a', '--max-keep', '1'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url });
        expect(r.stdout).toMatch(/over_cap":1.*staged 1/);
    });
    it('sends the pinned model id from the claude adapter metadata by default, and a raw id as given', async () => {
        const tiers = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../adapters/claude/model-tiers.json'), 'utf8'));
        const s = await anthropic(() => ({ items: [] }));
        longSession('sess-a');
        await cli(['capture', '--session', 'sess-a'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url });
        expect(s.calls[0].body.model).toBe(tiers.directApi.models[tiers.directApi.memoryCaptureDefault].id);
        await cli(['capture', '--session', 'sess-a', '--force', '--model', 'sonnet'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url });
        expect(s.calls[1].body.model).toBe(tiers.directApi.models.sonnet.id);
        await cli(['capture', '--session', 'sess-a', '--force'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url, MEMORY_CAPTURE_MODEL: 'some-future-model-id' });
        expect(s.calls[2].body.model).toBe('some-future-model-id');
    });
    it('--user-quote-only drops candidates whose evidence is not the user\'s own words', async () => {
        const s = await anthropic(() => ({ items: [goodItems[0], { type: 'fact', title: 'Assistant promise', text: 'The assistant promised to avoid pkill.', evidence_quote: 'Understood, I will avoid that.' }] }));
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a', '--user-quote-only'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url });
        expect(r.stdout).toMatch(/not_user_quote":1.*staged 1/);
    });
    it('gets the key from MEMORY_CAPTURE_KEY_COMMAND when ANTHROPIC_API_KEY is unset', async () => {
        const s = await anthropic(() => ({ items: [] }));
        longSession('sess-a');
        const keyScript = path.join(tmp.root, 'key.js');
        fs.writeFileSync(keyScript, "process.stdout.write('sk-from-command\\n');");
        const r = await cli(['capture', '--session', 'sess-a'], { MEMORY_CAPTURE_KEY_COMMAND: `"${process.execPath}" "${keyScript}"`, ANTHROPIC_BASE_URL: s.url });
        expect(r.code).toBe(0);
        expect(s.calls[0].headers['x-api-key']).toBe('sk-from-command');
    });
    it('a failing key command counts as no key', async () => {
        const s = await anthropic(() => ({ items: [] }));
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], { MEMORY_CAPTURE_KEY_COMMAND: `"${process.execPath}" -e "process.exit(3)"`, ANTHROPIC_BASE_URL: s.url });
        expect(r.code).toBe(1);
        expect(s.calls).toHaveLength(0);
    });
    it('works against an OpenAI-compatible server with no key (degraded fallback)', async () => {
        const calls = [];
        const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { calls.push({ url: req.url, auth: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodItems.slice(0, 2)) } }] })); }); });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        servers.push({ close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) });
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], { MEMORY_CAPTURE_PROVIDER: 'openai', MEMORY_CAPTURE_MODEL: 'qwen3.5:9b', MEMORY_CAPTURE_BASE_URL: `http://127.0.0.1:${srv.address().port}/v1` });
        expect(r.code).toBe(0);
        expect(calls[0]).toEqual({ url: '/v1/chat/completions', auth: undefined });
        expect(r.stdout).toMatch(/staged 1/);
    });
    it('the openai provider without a model is an error, not a guess', async () => {
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], { MEMORY_CAPTURE_PROVIDER: 'openai' });
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/MEMORY_CAPTURE_MODEL/);
    });
    it('--then-index embeds the memory dir afterwards when an embedder is configured', async () => {
        const s = await anthropic(() => ({ items: [] }));
        const e = await startEmbedServer(); servers.push(e);
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(path.join(memDir, 'a.md'), '---\nname: a\ndescription: "d"\n---\n\nbody text here\n');
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a', '--then-index'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url, MEMORY_EMBED_PROVIDER: 'openai', MEMORY_EMBED_URL: `${e.url}/v1`, MEMORY_EMBED_MODEL: 'm' });
        expect(r.code).toBe(0);
        expect(e.calls.length).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(stateDir, 'vectors.json'))).toBe(true);
    });
});

describe('human gate: list / promote / discard', () => {
    const stage = async () => {
        const s = await anthropic(() => ({ items: [goodItems[0], goodItems[3]] }));
        longSession('sess-a');
        await cli(['capture', '--session', 'sess-a'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url });
        return s;
    };
    it('promote writes the memory, indexes it in MEMORY.md, and recall then finds it; the candidate is gone', async () => {
        await stage();
        const list = await cli(['list']);
        expect(list.stdout).toMatch(/2 candidate/);
        const id = candidatesLeft().find(f => f.includes('never-pkill')).slice(0, 6);   // unique prefix is enough
        const p = await cli(['promote', id]);
        expect(p.stdout).toMatch(/promoted never-pkill-f-own-pattern/);
        expect(fs.existsSync(path.join(memDir, 'never-pkill-f-own-pattern.md'))).toBe(true);
        expect(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8')).toMatch(/- \[never-pkill-f-own-pattern\]\(never-pkill-f-own-pattern\.md\) — /);
        expect(candidatesLeft()).toHaveLength(1);
        const rc = await cli(['recall', 'pkill kills the shell that holds the pattern', '--full']);
        expect(rc.stdout).toContain('never-pkill-f-own-pattern');
    });
    it('promote never overwrites an existing memory; discard parks the candidate and unknown ids are reported', async () => {
        await stage();
        fs.mkdirSync(memDir, { recursive: true });
        fs.writeFileSync(path.join(memDir, 'never-pkill-f-own-pattern.md'), 'mine');
        const id = candidatesLeft().find(f => f.includes('never-pkill')).slice(0, -3);
        expect((await cli(['promote', id])).stdout).toMatch(/already exists; not overwriting/);
        expect(fs.readFileSync(path.join(memDir, 'never-pkill-f-own-pattern.md'), 'utf8')).toBe('mine');
        expect((await cli(['discard', id])).stdout).toMatch(/discarded/);
        expect(fs.existsSync(path.join(stateDir, 'candidates', '.discarded', `${id}.md`))).toBe(true);
        expect((await cli(['promote', 'nope-nope'])).stdout).toMatch(/no such candidate/);
        expect((await cli(['promote', '../../etc/passwd'])).stdout).toMatch(/no such candidate/);
    });
    it('promote and discard demand ids', async () => {
        expect((await cli(['promote'])).code).toBe(1);
        expect((await cli(['discard'])).code).toBe(1);
    });
});

describe('backfill and pending', () => {
    it('captures only sessions not yet in the ledger and honors --max-sessions', async () => {
        const s = await anthropic(() => ({ items: [] }));
        ['s1', 's2', 's3'].forEach(longSession);
        const old = new Date(Date.now() - 3 * 3600 * 1000);
        for (const f of fs.readdirSync(sessionsDir)) fs.utimesSync(path.join(sessionsDir, f), old, old);
        expect((await cli(['pending'])).stdout.trim()).toBe('3');
        const r = await cli(['backfill', '--max-sessions', '2'], { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url });
        expect(r.stdout).toMatch(/2 session\(s\) to capture/);
        expect(s.calls).toHaveLength(2);
        expect((await cli(['pending'])).stdout.trim()).toBe('1');
    });
    it('leaves sessions that may still be open (recently modified) alone', async () => {
        longSession('fresh');
        expect((await cli(['pending'])).stdout.trim()).toBe('0');
    });
});

describe('engine memories and recall', () => {
    const engineMemory = () => {
        const dir = path.join(tmp.root, 'docs', '.output', '.memory', 'constraints');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'bw-sync-first.json'), JSON.stringify({ id: 'bw-sync-first', type: 'constraint', content: { description: 'Run bw sync before listing items. The cache is stale otherwise.', correct_pattern: 'bw sync' } }));
    };
    it('recall finds an engine JSON memory with no migration', async () => {
        engineMemory();
        const r = await cli(['recall', 'run bw sync before I list the vault items', '--full']);
        expect(r.stdout).toContain('bw-sync-first');
        expect(r.stdout).toContain('**Correct pattern:** bw sync');
    });
    it('import-engine copies to markdown once (idempotent), leaves the JSON, and shadows rather than duplicates', async () => {
        engineMemory();
        expect((await cli(['import-engine'])).stdout).toMatch(/imported bw-sync-first/);
        expect((await cli(['import-engine'])).stdout).toMatch(/exists, skipped: bw-sync-first/);
        expect(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8').trim().split('\n')).toHaveLength(1);
        expect(fs.existsSync(path.join(tmp.root, 'docs', '.output', '.memory', 'constraints', 'bw-sync-first.json'))).toBe(true);
        const r = await cli(['recall', 'run bw sync before I list the vault items']);
        expect(r.stdout.match(/## bw-sync-first/g)).toHaveLength(1);
    });
    it('the default memory dir is the native auto-memory dir for the project', async () => {
        const r = await cli(['status'], { MEMORY_DIR: '' });
        expect(r.stdout).toContain(path.join(tmp.root, 'claude', 'projects', mungePath(tmp.root), 'memory'));
        expect(r.stdout).toMatch(/native auto-memory dir/);
    });
});

describe('capture provider fallback chain (MEMORY_CAPTURE_PROVIDER=claude-cli,anthropic)', () => {
    const fake = behavior => writeFakeClaude(path.join(tmp.root, 'fakebin'), behavior);
    const chain = (bin, extra = {}) => ({ MEMORY_CAPTURE_PROVIDER: 'claude-cli,anthropic', MEMORY_CAPTURE_CLAUDE_BIN: bin, ...extra });

    it('parses a list: aliases, case, spaces and duplicates; unknown names mean anthropic; empty means anthropic', () => {
        const { captureProviders } = require('../memory-capture');
        expect(captureProviders({ MEMORY_CAPTURE_PROVIDER: 'claude, ANTHROPIC ,claude-cli' })).toEqual(['claude-cli', 'anthropic']);
        expect(captureProviders({ MEMORY_CAPTURE_PROVIDER: 'openai' })).toEqual(['openai']);
        expect(captureProviders({ MEMORY_CAPTURE_PROVIDER: 'mystery' })).toEqual(['anthropic']);
        expect(captureProviders({})).toEqual(['anthropic']);
    });
    it('uses the first provider and never touches the second when the first works', async () => {
        const s = await anthropic(() => ({ items: goodItems }));
        const f = fake({ items: goodItems });
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], chain(f.bin, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url }));
        expect(r.code).toBe(0);
        expect(f.call()).not.toBeNull();
        expect(s.calls).toHaveLength(0);
        expect(candidatesLeft()).toHaveLength(2);
    });
    it('falls back to the API key when claude -p fails, says so, and stages from the second provider', async () => {
        const s = await anthropic(() => ({ items: goodItems }));
        const f = fake({ exit: 1, stderr: 'Not logged in' });
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], chain(f.bin, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: s.url }));
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/capture provider claude-cli failed .*Not logged in.*trying anthropic/);
        expect(s.calls.length).toBeGreaterThan(0);
        expect(candidatesLeft()).toHaveLength(2);
        expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'ledger.json'), 'utf8'))['sess-a']).toMatchObject({ staged: 2 });
    });
    it('falls back when the first provider is not usable at all (no key for anthropic first, then claude)', async () => {
        const f = fake({ items: goodItems });
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], { MEMORY_CAPTURE_PROVIDER: 'anthropic,claude-cli', MEMORY_CAPTURE_CLAUDE_BIN: f.bin });
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/capture provider anthropic failed .*no Anthropic key.*trying claude-cli/);
        expect(candidatesLeft()).toHaveLength(2);
    });
    it('when every provider fails it exits 1 naming each, and leaves nothing staged or ledgered', async () => {
        const f = fake({ exit: 1, stderr: 'Not logged in' });
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], chain(f.bin));
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/every capture provider failed: claude-cli: .*Not logged in.*anthropic: no Anthropic key/);
        expect(candidatesLeft()).toHaveLength(0);
        expect(fs.existsSync(path.join(stateDir, 'ledger.json'))).toBe(false);
    });
    it('status lists the fallback and its readiness', async () => {
        const f = fake({ items: [] });
        const r = await cli(['status'], chain(f.bin, { ANTHROPIC_API_KEY: 'k' }));
        expect(r.stdout).toMatch(/capture provider:  claude-cli .*ready/);
        expect(r.stdout).toMatch(/capture fallback:  anthropic .*ready/);
        expect((await cli(['status'], chain(f.bin))).stdout).toMatch(/capture fallback:  anthropic .*NOT READY/);
    });
});

describe('keyless capture through claude -p (MEMORY_CAPTURE_PROVIDER=claude-cli)', () => {
    const fake = behavior => writeFakeClaude(path.join(tmp.root, 'fakebin'), behavior);
    const keyless = bin => ({ MEMORY_CAPTURE_PROVIDER: 'claude-cli', MEMORY_CAPTURE_CLAUDE_BIN: bin });

    it('needs no API key: stages verified candidates, reports the cli-reported cost, and ledgers the session', async () => {
        const f = fake({ items: goodItems });
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], keyless(f.bin));
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/to claude -p \(claude-haiku/);
        expect(r.stdout).toMatch(/staged 2 \(cost \$0\.0123\)/);
        expect(candidatesLeft()).toHaveLength(2);                       // verbatim-quote + secret filters apply exactly as for the API
        expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'ledger.json'), 'utf8'))['sess-a']).toMatchObject({ staged: 2, cost: 0.0123 });
    });
    it('runs the child text-only, hook-free, persistence-free, in an empty temp dir, with the recursion guard set', async () => {
        const f = fake({ items: [] });
        longSession('sess-a');
        await cli(['capture', '--session', 'sess-a'], { ...keyless(f.bin), CLAUDE_PROJECT_DIR: tmp.root });
        const c = f.call();
        expect(c.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']));
        expect(c.args[c.args.indexOf('--tools') + 1]).toBe('');          // provably no tools
        expect(c.args[c.args.indexOf('--setting-sources') + 1]).toBe(''); // none of the user's hooks, MCP servers or CLAUDE.md
        expect(c.inner).toBe('1');
        expect(c.projectDir).toBeNull();
        expect(c.cwd).not.toContain(tmp.root);
        expect(c.prompt).toContain('SESSION TRANSCRIPT:');
        expect(c.prompt).toContain(PKILL);                              // the transcript travels over stdin, not argv
        expect(c.args.join(' ')).not.toContain(PKILL);
    });
    it('a failing claude leaves nothing staged and nothing ledgered, and says why', async () => {
        const f = fake({ exit: 1, stderr: 'Not logged in' });
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], keyless(f.bin));
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/claude -p failed \(exit 1\): Not logged in/);
        expect(candidatesLeft()).toHaveLength(0);
        expect(fs.existsSync(path.join(stateDir, 'ledger.json'))).toBe(false);
    });
    it('refuses to run inside a capture child (recursion guard)', async () => {
        const f = fake({ items: goodItems });
        longSession('sess-a');
        const r = await cli(['capture', '--session', 'sess-a'], { ...keyless(f.bin), MEMORY_CAPTURE_INNER: '1' });
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/MEMORY_CAPTURE_INNER/);
        expect(f.call()).toBeNull();
    });
    it('status shows it is ready without an API key, and --dry-run never starts claude', async () => {
        const f = fake({ items: [] });
        longSession('sess-a');
        expect((await cli(['status'], keyless(f.bin))).stdout).toMatch(/claude-cli .*claude -p. with your Claude login.*ready/);
        expect((await cli(['capture', '--session', 'sess-a', '--dry-run'], keyless(f.bin))).code).toBe(0);
        expect(f.call()).toBeNull();
    });
});

describe('sync (notes travel over git via docs/.output/.memory/notes)', () => {
    const trackedDir = () => path.join(tmp.root, 'docs', '.output', '.memory', 'notes');
    const mk = (dir, file, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), `---\nname: ${file.slice(0, -3)}\ndescription: "d ${file}"\n---\n\n${body}\n`); };
    it('pushes local notes into the tracked folder, pulls tracked ones into the memory dir, and is idempotent', async () => {
        mk(memDir, 'mine.md', 'local note');
        mk(trackedDir(), 'theirs.md', 'from the other machine');
        const r = await cli(['sync']);
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/1 pushed .*1 pulled/);
        expect(fs.existsSync(path.join(trackedDir(), 'mine.md'))).toBe(true);
        expect(fs.existsSync(path.join(memDir, 'theirs.md'))).toBe(true);
        expect(fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8')).toMatch(/\[theirs\]\(theirs\.md\)/);
        expect((await cli(['sync'])).stdout).toMatch(/0 pushed .*0 pulled .*2 already in sync/);
    });
    it('--dry-run changes nothing; --push and --pull limit the direction', async () => {
        mk(memDir, 'mine.md', 'local note');
        mk(trackedDir(), 'theirs.md', 'remote note');
        expect((await cli(['sync', '--dry-run'])).stdout).toMatch(/dry run, nothing written/);
        expect(fs.existsSync(path.join(trackedDir(), 'mine.md'))).toBe(false);
        await cli(['sync', '--push']);
        expect(fs.existsSync(path.join(trackedDir(), 'mine.md'))).toBe(true);
        expect(fs.existsSync(path.join(memDir, 'theirs.md'))).toBe(false);
        await cli(['sync', '--pull']);
        expect(fs.existsSync(path.join(memDir, 'theirs.md'))).toBe(true);
    });
    it('a note edited on both sides is a conflict: exit 1, nothing overwritten, then --prefer resolves it', async () => {
        mk(memDir, 'n.md', 'v1');
        await cli(['sync']);
        mk(memDir, 'n.md', 'mine');
        mk(trackedDir(), 'n.md', 'theirs');
        const bad = await cli(['sync']);
        expect(bad.code).toBe(1);
        expect(bad.stdout).toMatch(/CONFLICT n\.md/);
        expect(bad.stderr).toMatch(/--prefer local or --prefer tracked/);
        expect(fs.readFileSync(path.join(memDir, 'n.md'), 'utf8')).toContain('mine');
        expect((await cli(['sync', '--prefer', 'sideways'])).code).toBe(1);
        expect((await cli(['sync', '--prefer', 'tracked'])).code).toBe(0);
        expect(fs.readFileSync(path.join(memDir, 'n.md'), 'utf8')).toContain('theirs');
    });
    it('never carries a secret into git', async () => {
        mk(memDir, 'leak.md', 'token sk-ant-abcdefghijklmnopqrstuv');
        const r = await cli(['sync']);
        expect(r.stdout).toMatch(/skipped leak\.md/);
        expect(fs.existsSync(path.join(trackedDir(), 'leak.md'))).toBe(false);
    });
    it('status shows the sync state', async () => {
        mk(memDir, 'mine.md', 'x');
        expect((await cli(['status'])).stdout).toMatch(/notes sync:\s+manual .*1 to push/);
        expect((await cli(['status'], { MEMORY_SYNC: 'on' })).stdout).toMatch(/auto ON/);
    });
});

describe('status', () => {
    it('reports provider readiness without printing any secret', async () => {
        const off = await cli(['status']);
        expect(off.stdout).toMatch(/auto capture:\s+off/);
        expect(off.stdout).toMatch(/NOT READY/);
        expect(off.stdout).toMatch(/keyword-only/);
        const on = await cli(['status'], { MEMORY_CAPTURE: 'on', ANTHROPIC_API_KEY: 'sk-ant-supersecretvalue' });
        expect(on.stdout).toMatch(/auto capture:\s+ON/);
        expect(on.stdout).toMatch(/key source: env; ready/);
        expect(on.stdout).not.toContain('supersecretvalue');
    });
    it('rejects an unknown command', async () => {
        const r = await cli(['frobnicate']);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/usage/);
    });
});
