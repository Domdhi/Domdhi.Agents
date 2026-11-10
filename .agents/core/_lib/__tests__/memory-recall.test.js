// AC→source map (memory-recall): keyword ranking + keyword-only relevance gate (3 distinct terms and a corpus-scaled BM25 score); embedding config; incremental content-hashed index;
// model change rebuilds; embedder failure degrades to keyword-only; hybrid floor/rank; OpenAI-compatible request shape.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../memory-recall');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const { startEmbedServer } = require('../../__tests__/_helpers/memory-fakes');

let tmp, servers;
beforeEach(() => { tmp = createTmpDir({ prefix: 'memory-recall-' }); servers = []; });
afterEach(async () => { await Promise.all(servers.map(s => s.close())); tmp.cleanup(); });

const doc = (key, name, description, body) => ({ key, source: 'notes', file: key, name, description, body, text: `${name}\n${description}\n${body}`, sha: `${key}:${body}` });
const corpusOf = (...docs) => Object.fromEntries(docs.map(d => [d.key, d]));
const ssh = doc('ssh.md', 'ssh-dmo-timeouts', 'dmo ssh drops idle sessions', 'Use ServerAliveInterval when ssh to dmo or the connection drops after idle.');
const mint = doc('mint.md', 'mint-plan', 'phone plan cost', 'Mint Mobile annual plan renews in July at 206 dollars.');
const pkill = doc('pkill.md', 'pkill', 'never pkill -f own pattern', 'pkill -f matches its own command line and kills the shell.');

async function embedServer(opts) { const s = await startEmbedServer(opts); servers.push(s); return s; }
const cfgFor = (s, model = 'test-embed') => ({ provider: 'openai', url: `${s.url}/v1`, model, key: '' });

describe('keyword ranking', () => {
    it('ranks the matching memory first and stems plurals', () => {
        const { ranked } = R.bm25Rank(corpusOf(ssh, mint, pkill), 'how much is the phone plans Mint renewal');
        expect(ranked[0].key).toBe('mint.md');
    });
    it('keyword-only recall injects nothing for a prompt that shares only one incidental word', async () => {
        const { hits, source } = await R.recall({ corpus: corpusOf(ssh, mint, pkill), query: 'please refactor the dashboard layout and the sidebar plan', stateDir: tmp.root, cfg: { provider: 'none' } });
        expect(source).toBe('keyword-only');
        expect(hits).toEqual([]);
    });
    it('keyword-only recall finds a memory when three or more distinct terms match', async () => {
        const { hits } = await R.recall({ corpus: corpusOf(ssh, mint, pkill), query: 'pkill matched its own command line and killed the shell', stateDir: tmp.root, cfg: { provider: 'none' } });
        expect(hits.map(h => h.name)).toEqual(['pkill']);
    });
    it('keyword-only needs a corpus-scaled score: terms present in most memories carry no signal', async () => {
        const common = Array.from({ length: 12 }, (_, i) => doc(`c${i}.md`, `common-${i}`, 'deploy production server notes', `deploy production server checklist ${i} for the rollout`));
        const { hits } = await R.recall({ corpus: corpusOf(...common), query: 'deploy the production server rollout checklist', stateDir: tmp.root, cfg: { provider: 'none' } });
        expect(hits).toEqual([]);
        const rare = doc('r.md', 'rare', 'quasar telemetry decoder', 'quasar telemetry decoder drops frames when the buffer overflows');
        const { hits: found } = await R.recall({ corpus: corpusOf(...common, rare), query: 'quasar telemetry decoder drops frames', stateDir: tmp.root, cfg: { provider: 'none' } });
        expect(found.map(h => h.name)).toEqual(['rare']);
    });
    it('minScore scales with corpus size and minMatched wants three terms for a real prompt', () => {
        expect(R.minScore(320)).toBeGreaterThan(R.minScore(100));
        expect(R.minScore(320)).toBeCloseTo(10.1, 0);
        expect(R.minMatched(2)).toBe(1);
        expect(R.minMatched(3)).toBe(3);
        expect(R.DEFAULT_FLOOR).toBe(0.7);
    });
    it('returns nothing for nonsense, an empty corpus, or an empty query', async () => {
        const base = { stateDir: tmp.root, cfg: { provider: 'none' } };
        expect((await R.recall({ ...base, corpus: corpusOf(mint), query: 'zzzz qqqq' })).hits).toEqual([]);
        expect((await R.recall({ ...base, corpus: {}, query: 'phone plan' })).hits).toEqual([]);
        expect((await R.recall({ ...base, corpus: corpusOf(mint), query: '   ' })).hits).toEqual([]);
    });
});

describe('embedConfig', () => {
    it('defaults to the local Ollama URL and never invents another', () => {
        expect(R.embedConfig({})).toMatchObject({ provider: 'ollama', url: 'http://127.0.0.1:11434/v1', model: 'embeddinggemma' });
    });
    it('none disables; openai without a URL is none; an explicit URL under auto is openai-compatible', () => {
        expect(R.embedConfig({ MEMORY_EMBED_PROVIDER: 'none' }).provider).toBe('none');
        expect(R.embedConfig({ MEMORY_EMBED_PROVIDER: 'openai' }).provider).toBe('none');
        expect(R.embedConfig({ MEMORY_EMBED_URL: 'http://h:1/v1/', MEMORY_EMBED_MODEL: 'm', MEMORY_EMBED_KEY: 'k' })).toEqual({ provider: 'openai', url: 'http://h:1/v1', model: 'm', key: 'k' });
        expect(R.embedConfig({ MEMORY_EMBED_PROVIDER: 'bogus' }).provider).toBe('none');
    });
});

describe('embeddings against an OpenAI-compatible server', () => {
    it('sends gemma prefixes for gemma models only, auth when a key is set, and returns unit vectors', async () => {
        const s = await embedServer();
        const v = await R.embed(['one', 'two'], 'doc', { provider: 'openai', url: `${s.url}/v1`, model: 'embeddinggemma', key: 'sekret' });
        expect(v).toHaveLength(2);
        expect(v[0].reduce((a, x) => a + x * x, 0)).toBeCloseTo(1, 5);
        expect(s.calls[0].body.input[0]).toBe('title: none | text: one');
        expect(s.calls[0].headers.authorization).toBe('Bearer sekret');
        await R.embed(['q'], 'query', cfgFor(s, 'nomic'));
        expect(s.calls[1].body.input[0]).toBe('q');
    });
    it('throws on a server error so callers can degrade', async () => {
        const s = await embedServer({ fail: true });
        await expect(R.embed(['x'], 'doc', cfgFor(s))).rejects.toThrow(/500/);
    });
});

describe('incremental index', () => {
    it('embeds only new/changed docs, drops deleted ones, and rebuilds on a model change', async () => {
        const s = await embedServer();
        const cfg = cfgFor(s);
        expect(await R.syncIndex(corpusOf(ssh, mint), tmp.root, cfg)).toEqual({ embedded: 2, removed: 0, total: 2 });
        expect(await R.syncIndex(corpusOf(ssh, mint), tmp.root, cfg)).toEqual({ embedded: 0, removed: 0, total: 2 });
        const mint2 = { ...mint, sha: 'changed', text: mint.text + ' now 210' };
        expect(await R.syncIndex(corpusOf(mint2, pkill), tmp.root, cfg)).toEqual({ embedded: 2, removed: 1, total: 2 });
        expect(await R.syncIndex(corpusOf(mint2, pkill), tmp.root, cfgFor(s, 'other-model'))).toEqual({ embedded: 2, removed: 0, total: 2 });
    });
    it('does nothing without a provider', async () => {
        expect((await R.syncIndex(corpusOf(mint), tmp.root, { provider: 'none' })).skipped).toBeTruthy();
    });
});

describe('hybrid recall', () => {
    it('finds the memory by meaning words and labels the result hybrid', async () => {
        const s = await embedServer();
        const cfg = cfgFor(s);
        const corpus = corpusOf(ssh, mint, pkill);
        await R.syncIndex(corpus, tmp.root, cfg);
        const { hits, source, stale } = await R.recall({ corpus, query: 'what do I pay for the Mint Mobile phone plan every year', stateDir: tmp.root, cfg });
        expect(source).toBe('hybrid');
        expect(stale).toBe(false);
        expect(hits[0].name).toBe('mint-plan');
    });
    it('a lone incidental keyword match is not enough to inject, even in hybrid mode (measured: this admitted every unrelated prompt)', async () => {
        const s = await embedServer();
        const cfg = cfgFor(s);
        const corpus = corpusOf(ssh, mint, pkill);
        await R.syncIndex(corpus, tmp.root, cfg);
        const { hits } = await R.recall({ corpus, query: 'please refactor the dashboard layout and tidy the sidebar plan', stateDir: tmp.root, cfg });
        expect(hits).toEqual([]);
    });
    it('is keyword-only when the embedder is down, and says why', async () => {
        const s = await embedServer({ fail: true });
        const { hits, source } = await R.recall({ corpus: corpusOf(pkill), query: 'pkill matched its own command line and killed the shell', stateDir: tmp.root, cfg: cfgFor(s) });
        expect(hits[0].name).toBe('pkill');
        expect(source).toMatch(/^keyword-only \(/);
    });
    it('hooks (sync:false) never embed documents: unindexed docs make the result stale and keyword-only', async () => {
        const s = await embedServer();
        const { hits, stale, source } = await R.recall({ corpus: corpusOf(mint, ssh), query: 'Mint Mobile phone plan renewal', stateDir: tmp.root, cfg: cfgFor(s) });
        expect(s.calls).toHaveLength(1);                       // the query only
        expect(s.calls[0].body.input).toEqual(['Mint Mobile phone plan renewal']);
        expect(stale).toBe(true);
        expect(source).toMatch(/keyword-only/);
        expect(hits[0].name).toBe('mint-plan');
    });
    it('sync:true embeds first (CLI path)', async () => {
        const s = await embedServer();
        const { stale } = await R.recall({ corpus: corpusOf(mint), query: 'Mint Mobile plan', stateDir: tmp.root, cfg: cfgFor(s), sync: true });
        expect(stale).toBe(false);
    });
});
