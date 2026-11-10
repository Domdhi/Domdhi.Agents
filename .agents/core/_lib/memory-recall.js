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
function minScore(corpusSize) {
    return KW_SCORE_PER_LN * Math.log(1 + corpusSize);
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

function embedConfig(env = process.env) {
    const p = String(env.MEMORY_EMBED_PROVIDER || 'auto').toLowerCase();
    if (p === 'none') return { provider: 'none' };
    const model = env.MEMORY_EMBED_MODEL || DEFAULT_MODEL;
    const key = env.MEMORY_EMBED_KEY || '';
    if (p === 'openai') return env.MEMORY_EMBED_URL ? { provider: 'openai', url: env.MEMORY_EMBED_URL.replace(/\/+$/, ''), model, key } : { provider: 'none' };
    if (p === 'auto' || p === 'ollama') {
        // auto honors an explicit URL; otherwise only the default local Ollama is tried.
        const url = (p === 'auto' && env.MEMORY_EMBED_URL ? env.MEMORY_EMBED_URL : OLLAMA_URL).replace(/\/+$/, '');
        return { provider: p === 'auto' && env.MEMORY_EMBED_URL ? 'openai' : 'ollama', url, model, key };
    }
    return { provider: 'none' };
}

function unit(v) {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map(x => x / n);
}

/** kind: 'doc' | 'query'. Returns unit vectors. Throws on any failure (callers degrade to keyword-only). */
async function embed(texts, kind, cfg, { timeoutMs = 600000, fetchImpl = globalThis.fetch } = {}) {
    if (!texts.length) return [];
    if (!cfg || cfg.provider === 'none') throw new Error('no embedding provider');
    const prefix = /gemma/i.test(cfg.model) ? (kind === 'doc' ? GEMMA_DOC : GEMMA_QUERY) : '';
    const headers = { 'content-type': 'application/json' };
    if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
    const out = [];
    for (let i = 0; i < texts.length; i += 32) {
        const res = await fetchImpl(`${cfg.url}/embeddings`, {
            method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({ model: cfg.model, input: texts.slice(i, i + 32).map(t => prefix + t) }),
        });
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
        const vecs = await embed(todo.map(k => corpus[k].text), 'doc', cfg, opts);
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
 * @param {string} o.stateDir   holds vectors.json
 * @param {object} [o.cfg]      embedConfig()
 * @param {boolean} [o.sync=false]  embed new/changed docs first (CLI); hooks pass false and only embed the query
 * @param {number} [o.timeoutMs=400]  budget for the query embedding
 * @returns {Promise<{hits: object[], source: string, stale: boolean}>}
 */
async function recall({ corpus, query, k = 3, floor = DEFAULT_FLOOR, stateDir, cfg = embedConfig(), sync = false, timeoutMs = 400, fetchImpl }) {
    const keys = Object.keys(corpus);
    if (!keys.length || !String(query || '').trim()) return { hits: [], source: 'empty', stale: false };
    const { ranked, nTerms } = bm25Rank(corpus, query);
    const cos = {};
    let source = 'keyword-only', stale = false, usedEmbeddings = false;
    if (cfg && cfg.provider !== 'none') {
        try {
            if (sync) await syncIndex(corpus, stateDir, cfg, { fetchImpl });
            const idx = loadIndex(stateDir);
            const [qv] = await embed([query], 'query', cfg, { timeoutMs, fetchImpl });
            const items = idx && idx.model === cfg.model ? idx.items : {};
            for (const key of keys) {
                const it = items[key];
                if (it && it.sha === corpus[key].sha && it.vec.length === qv.length) cos[key] = it.vec.reduce((s, x, i) => s + x * qv[i], 0);
            }
            stale = staleKeys(corpus, idx, cfg).length > 0;
            usedEmbeddings = Object.keys(cos).length > 0;
            source = usedEmbeddings ? 'hybrid' : 'keyword-only (index empty)';
        } catch (e) {
            source = `keyword-only (${String(e.message || e).slice(0, 60)})`;
        }
    }
    const need = minMatched(nTerms), minKw = minScore(keys.length);
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

module.exports = { STOP, DEFAULT_FLOOR, tokens, queryTerms, minMatched, minScore, bm25Rank, embedConfig, embed, loadIndex, staleKeys, syncIndex, recall, indexFile };
