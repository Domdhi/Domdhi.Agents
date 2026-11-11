'use strict';

/**
 * memory-recall.js — hybrid recall over a memory corpus (see memory-notes.js).
 *
 * Keyword (BM25) and embedding (cosine) rankings are fused with reciprocal rank fusion. Evidence
 * (Domdhi.Vault scale test, 40 to 579 memories): the right memory stayed in the top 3 for 12 of 12
 * findable queries. The cosine floor is 0.70 (rank still does the work). 0.65 was right for that small store, but on
 * two real 320-memory project stores with real prompts it injected on 100% of prompts and about 70% of the
 * injected memories were noise; 0.70 halved the noise and kept the useful hits on those stores and on the Vault's.
 *
 * Embeddings are optional and never required:
 *   MEMORY_EMBED_PROVIDER = auto (default) | ollama | openai | none
 *     auto / ollama  http://127.0.0.1:11434/v1 (a local Ollama that is ALREADY running; nothing is started or installed)
 *     openai         any OpenAI-compatible /v1/embeddings server: MEMORY_EMBED_URL, MEMORY_EMBED_MODEL, MEMORY_EMBED_KEY
 *   MEMORY_EMBED_URL may list several servers, comma-separated, best machine first
 *   ("http://legion:11434/v1,http://pc:11434/v1"). Each call tries them in order; a server that fails is skipped
 *   for HOST_RETRY_MS (remembered in <stateDir>/embed-hosts.json) so a machine that is off does not cost every
 *   prompt its timeout. Every server must carry the same model, or the vectors are not comparable.
 *     none           keyword-only
 *   MEMORY_EMBED_MODEL defaults to "embeddinggemma".
 * When the embedder is unreachable, recall is keyword-only. Keyword-only has its own relevance gate
 * (see minMatched/minScore): without embeddings, OR'd BM25 terms match almost any prompt.
 *
 * The vector index is derived state (content-hashed, incremental, rebuilt on model change) and can be
 * deleted at any time. Leaf module: Node builtins and global fetch only.
 */

const fs = require('fs');
const path = require('path');

const STOP = new Set(('a an the and or but if then else for of to in on at by with from as is are was were be it its this that these those i you we they me my our your do does ' +
    'did not no yes can could should would will may might must have has had please make add update fix change use using need get set run new also into out up down over so than too ' +
    'very just when where what which who how why all any each some more most other such only own same file files code test tests task work step').split(/\s+/));

const GEMMA_DOC = 'title: none | text: ';
const GEMMA_QUERY = 'task: search result | query: ';
const DEFAULT_MODEL = 'embeddinggemma';
const OLLAMA_URL = 'http://127.0.0.1:11434/v1';
const RRF_K = 60;
const FTS_KEEP = 2;
const MAX_TERMS = 10;
const KW_SCORE_PER_LN = 1.75;
const DEFAULT_FLOOR = 0.7;

// ---------------------------------------------------------------- keyword

function stem(w) {
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
}

function tokens(s) {
    const out = [];
    for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
        if (w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)) out.push(stem(w));
    }
    return out;
}

/** Distinct query terms, longest first (longer words are more specific), capped. */
function queryTerms(q) {
    return [...new Set(tokens(q))].sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
}

/** How many distinct query terms a keyword hit must match (all of them for a short query). */
function minMatched(nTerms) {
    return nTerms <= 2 ? 1 : 3;
}

/**
 * Minimum BM25 score for a keyword hit, scaled to the corpus (idf grows with ln N). Evidence (blind-judged real prompts
 * against two real 320-memory project stores): matching 2 terms of a long prompt admits almost anything
 * (16-22% of injected memories useful or adjacent); requiring 3 terms and a score of ~1.75 ln(1+N) (about 10 there)
 * kept the same useful hits and cut the noise by more than half.
 */
function minScore(corpusSize, perLn = KW_SCORE_PER_LN) {
    return perLn * Math.log(1 + corpusSize);
}

/**
 * Recall knobs from the environment: MEMORY_RECALL_FLOOR (cosine floor, 0.3 to 0.95, default 0.70) and
 * MEMORY_RECALL_KW_SCORE (keyword score per ln(1+N), 0.25 to 4, default 1.75). The keyword default was tuned on two
 * 320-memory stores; a 1,400-memory store with long memories kept only 5 of 28 useful prompts at 1.75 and 12 of 28 at 1.0,
 * so it is exposed rather than fixed.
 */
function tuningFromEnv(env = process.env) {
    const num = (name, lo, hi, dflt) => {
        const raw = env[name];
        if (raw === undefined || raw === '') return dflt;
        const v = Number(raw);
        return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
    };
    return { floor: num('MEMORY_RECALL_FLOOR', 0.3, 0.95, DEFAULT_FLOOR), kwScore: num('MEMORY_RECALL_KW_SCORE', 0.25, 4, KW_SCORE_PER_LN) };
}

/** BM25 over the corpus. Returns [{key, score, matched}] best first, only docs matching at least one term. */
function bm25Rank(corpus, query) {
    const terms = queryTerms(query);
    if (!terms.length) return { ranked: [], nTerms: 0 };
    const docs = Object.values(corpus).map(d => {
        const tf = new Map();
        const toks = tokens(d.text);
        for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        return { key: d.key, tf, len: toks.length };
    });
    const N = docs.length || 1;
    const avg = docs.reduce((s, d) => s + d.len, 0) / N || 1;
    const df = new Map(terms.map(t => [t, docs.reduce((n, d) => n + (d.tf.has(t) ? 1 : 0), 0)]));
    const k1 = 1.2, b = 0.75;
    const ranked = [];
    for (const d of docs) {
        let score = 0, matched = 0;
        for (const t of terms) {
            const f = d.tf.get(t);
            if (!f) continue;
            matched++;
            const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
            score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg));
        }
        if (matched) ranked.push({ key: d.key, score, matched });
    }
    ranked.sort((a, b2) => b2.score - a.score || (a.key < b2.key ? -1 : 1));
    return { ranked, nTerms: terms.length };
}

// ---------------------------------------------------------------- embeddings

/** A comma-separated list of server URLs, trimmed, without trailing slashes or duplicates. */
function urlList(value) {
    return [...new Set(String(value || '').split(',').map(u => u.trim().replace(/\/+$/, '')).filter(Boolean))];
}

function embedConfig(env = process.env) {
    const p = String(env.MEMORY_EMBED_PROVIDER || 'auto').toLowerCase();
    if (p === 'none') return { provider: 'none' };
    const model = env.MEMORY_EMBED_MODEL || DEFAULT_MODEL;
    const key = env.MEMORY_EMBED_KEY || '';
    const listed = urlList(env.MEMORY_EMBED_URL);
    if (p === 'openai') return listed.length ? { provider: 'openai', url: listed[0], urls: listed, model, key } : { provider: 'none' };
    if (p === 'auto' || p === 'ollama') {
        // auto honors an explicit URL list; otherwise only the default local Ollama is tried.
        const urls = p === 'auto' && listed.length ? listed : [OLLAMA_URL];
        return { provider: p === 'auto' && listed.length ? 'openai' : 'ollama', url: urls[0], urls, model, key };
    }
    return { provider: 'none' };
}

// ---------------------------------------------------------------- server fallback

const HOST_RETRY_MS = 2 * 60 * 1000;
const SHORT_BUDGET_MS = 5000;

function readHosts(file) {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

function writeHosts(file, hosts) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(hosts));
        fs.renameSync(tmp, file);
    } catch { /* best effort: a lost write only means one more retry */ }
}

/**
 * The servers to try, in order: those not marked failed within HOST_RETRY_MS keep their listed order and come
 * first, then the recently failed ones (still tried, in case they are back). Pure: `hosts` maps url -> failure time.
 */
function serverOrder(urls, hosts, now) {
    const fresh = u => !(Number.isFinite(hosts[u]) && now - hosts[u] >= 0 && now - hosts[u] < HOST_RETRY_MS);
    return [...urls.filter(fresh), ...urls.filter(u => !fresh(u))];
}

/**
 * Run `call(url, msLeft)` against each server in fallback order until one succeeds, sharing one time budget.
 * A failure marks that server in `hostsFile`; a success clears its mark. Throws the last error when all fail.
 */
async function withFallback(urls, call, { timeoutMs, hostsFile, now = Date.now }) {
    const hosts = hostsFile ? readHosts(hostsFile) : {};
    const start = now();
    const deadline = start + timeoutMs;
    let lastError = new Error('no server listed');
    let changed = false;
    try {
        for (const url of serverOrder(urls, hosts, start)) {
            const left = deadline - now();
            if (left <= 0) { lastError = new Error(`no answer within ${timeoutMs} ms`); break; }
            try {
                const out = await call(url, left);
                if (url in hosts) { delete hosts[url]; changed = true; }
                return out;
            } catch (e) {
                lastError = e;
                // A server loading its model takes seconds on the first call after idle; inside a short budget (a prompt's
                // recall) that timeout is not a fault, and the load finishes for the next prompt. Other failures (refused,
                // unreachable, model missing) and timeouts with a long budget mark the server.
                const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
                if (!(timedOut && timeoutMs < SHORT_BUDGET_MS)) { hosts[url] = now(); changed = true; }
            }
        }
    } finally {
        if (changed && hostsFile) writeHosts(hostsFile, hosts);
    }
    throw urls.length > 1 ? new Error(`all ${urls.length} embedding servers failed; last: ${lastError.message || lastError}`) : lastError;
}

function unit(v) {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map(x => x / n);
}

/**
 * kind: 'doc' | 'query'. Returns unit vectors. Throws on any failure (callers degrade to keyword-only).
 * With several servers (cfg.urls) each is tried in order within the one `timeoutMs` budget; `hostsFile`
 * remembers which failed recently (see withFallback).
 */
async function embed(texts, kind, cfg, { timeoutMs = 600000, fetchImpl = globalThis.fetch, hostsFile, now } = {}) {
    if (!texts.length) return [];
    if (!cfg || cfg.provider === 'none') throw new Error('no embedding provider');
    const urls = Array.isArray(cfg.urls) && cfg.urls.length ? cfg.urls : [cfg.url];
    return withFallback(urls, (url, left) => embedFrom(url, texts, kind, cfg, left, fetchImpl), { timeoutMs, hostsFile, now });
}

async function embedFrom(url, texts, kind, cfg, timeoutMs, fetchImpl) {
    const prefix = /gemma/i.test(cfg.model) ? (kind === 'doc' ? GEMMA_DOC : GEMMA_QUERY) : '';
    const headers = { 'content-type': 'application/json' };
    if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
    const out = [];
    const signal = AbortSignal.timeout(Math.max(1, timeoutMs));
    for (let i = 0; i < texts.length; i += 32) {
        const res = await fetchImpl(`${url}/embeddings`, {
            method: 'POST', headers, signal,
            body: JSON.stringify({ model: cfg.model, input: texts.slice(i, i + 32).map(t => prefix + t) }),
        });
        // Ollama answers 404 for a model it has not pulled (the default "embeddinggemma" is not the "embeddinggemma-2" some
        // installs carry); name the model and the fix, since this text is all that reaches the recall log and status line.
        if (res.status === 404) throw new Error(`embedding model "${cfg.model}" not found (ollama list; set MEMORY_EMBED_MODEL)`);
        if (!res.ok) throw new Error(`embedding server answered ${res.status}`);
        const j = await res.json();
        if (!Array.isArray(j.data)) throw new Error('unexpected embedding response');
        for (const d of [...j.data].sort((a, b) => a.index - b.index)) out.push(unit(d.embedding));
    }
    if (out.length !== texts.length) throw new Error('embedding count mismatch');
    return out;
}

// ---------------------------------------------------------------- vector index

const indexFile = stateDir => path.join(stateDir, 'vectors.json');
const hostsFileFor = stateDir => (stateDir ? path.join(stateDir, 'embed-hosts.json') : undefined);

function loadIndex(stateDir) {
    try {
        const j = JSON.parse(fs.readFileSync(indexFile(stateDir), 'utf8'));
        return j && typeof j === 'object' && j.items && typeof j.items === 'object' ? j : null;
    } catch { return null; }
}

function writeIndex(stateDir, idx) {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = `${indexFile(stateDir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...idx, updated: new Date().toISOString() }));
    fs.renameSync(tmp, indexFile(stateDir));
}

/** Documents whose vector is missing or out of date for the current model. */
function staleKeys(corpus, idx, cfg) {
    const items = idx && idx.model === cfg.model ? idx.items : {};
    return Object.keys(corpus).filter(k => !items[k] || items[k].sha !== corpus[k].sha);
}

/** Bring the index in line with the corpus: embed new/changed docs, drop deleted ones, rebuild on model change. */
async function syncIndex(corpus, stateDir, cfg, opts = {}) {
    if (!cfg || cfg.provider === 'none') return { embedded: 0, removed: 0, total: 0, skipped: 'no embedding provider' };
    let idx = loadIndex(stateDir);
    if (!idx || idx.model !== cfg.model) idx = { model: cfg.model, items: {} };
    const removed = Object.keys(idx.items).filter(k => !corpus[k]);
    for (const k of removed) delete idx.items[k];
    const todo = staleKeys(corpus, idx, cfg);
    if (todo.length) {
        const vecs = await embed(todo.map(k => corpus[k].text), 'doc', cfg, { hostsFile: hostsFileFor(stateDir), ...opts });
        todo.forEach((k, i) => { idx.items[k] = { sha: corpus[k].sha, vec: vecs[i].map(x => Math.round(x * 1e5) / 1e5) }; });
    }
    if (todo.length || removed.length || !fs.existsSync(indexFile(stateDir))) writeIndex(stateDir, idx);
    return { embedded: todo.length, removed: removed.length, total: Object.keys(idx.items).length };
}

// ---------------------------------------------------------------- recall

/**
 * @param {object} o
 * @param {object} o.corpus   {key: doc} from memory-notes.loadCorpus
 * @param {string} o.query
 * @param {number} [o.k=3]
 * @param {number} [o.floor=0.7]
 * @param {number} [o.kwScore=1.75] keyword score per ln(1+N) a keyword-only hit must reach (see tuningFromEnv)
 * @param {string} o.stateDir   holds vectors.json
 * @param {object} [o.cfg]      embedConfig()
 * @param {boolean} [o.sync=false]  embed new/changed docs first (CLI); hooks pass false and only embed the query
 * @param {number} [o.timeoutMs=400]  budget for the query embedding
 * @returns {Promise<{hits: object[], source: string, stale: boolean}>}
 */
async function recall({ corpus, query, k = 3, floor = DEFAULT_FLOOR, kwScore = KW_SCORE_PER_LN, stateDir, cfg = embedConfig(), sync = false, timeoutMs = 400, fetchImpl }) {
    const keys = Object.keys(corpus);
    if (!keys.length || !String(query || '').trim()) return { hits: [], source: 'empty', stale: false };
    const { ranked, nTerms } = bm25Rank(corpus, query);
    const cos = {};
    let source = 'keyword-only', stale = false, usedEmbeddings = false;
    if (cfg && cfg.provider !== 'none') {
        try {
            if (sync) await syncIndex(corpus, stateDir, cfg, { fetchImpl });
            const idx = loadIndex(stateDir);
            const [qv] = await embed([query], 'query', cfg, { timeoutMs, fetchImpl, hostsFile: hostsFileFor(stateDir) });
            const items = idx && idx.model === cfg.model ? idx.items : {};
            for (const key of keys) {
                const it = items[key];
                if (it && it.sha === corpus[key].sha && it.vec.length === qv.length) cos[key] = it.vec.reduce((s, x, i) => s + x * qv[i], 0);
            }
            stale = staleKeys(corpus, idx, cfg).length > 0;
            usedEmbeddings = Object.keys(cos).length > 0;
            source = usedEmbeddings ? 'hybrid' : 'keyword-only (index empty)';
        } catch (e) {
            source = `keyword-only (${String(e.message || e).slice(0, 100)})`;
        }
    }
    const need = minMatched(nTerms), minKw = minScore(keys.length, kwScore);
    const kwOk = r => r.matched >= need && r.score >= minKw;
    const kw = usedEmbeddings ? ranked : ranked.filter(kwOk);
    const kwKeys = kw.map(r => r.key);
    const embRank = Object.keys(cos).sort((a, b) => cos[b] - cos[a]);
    const score = {};
    for (const list of [kwKeys, embRank]) list.forEach((key, i) => { score[key] = (score[key] || 0) + 1 / (RRF_K + i + 1); });
    // A top keyword hit is kept below the cosine floor only with real lexical support (enough distinct matching terms and score).
    const keep = new Set(kw.slice(0, FTS_KEEP).filter(kwOk).map(r => r.key));
    const hits = [];
    for (const key of Object.keys(score).sort((a, b) => score[b] - score[a] || (a < b ? -1 : 1))) {
        if (usedEmbeddings && !(keep.has(key) || (cos[key] || 0) >= floor)) continue;
        hits.push({ ...corpus[key], cos: Math.round((cos[key] || 0) * 1000) / 1000, source });
        if (hits.length >= k) break;
    }
    return { hits, source, stale };
}

module.exports = { STOP, DEFAULT_FLOOR, tokens, queryTerms, minMatched, minScore, tuningFromEnv, KW_SCORE_PER_LN, bm25Rank, embedConfig, embed, loadIndex, staleKeys, syncIndex, recall, indexFile, urlList, serverOrder, withFallback, readHosts, hostsFileFor, HOST_RETRY_MS };
