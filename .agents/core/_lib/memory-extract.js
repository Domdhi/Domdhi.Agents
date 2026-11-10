'use strict';

/**
 * memory-extract.js — turn a finished Claude Code session into candidate memories.
 *
 * Evidence (Domdhi.Vault capture test, 6 real sessions, 10 hand-written memories as ground truth):
 * a Haiku 5.5 extractor over the whole session recovered 8 to 10 of 10 for $0.003 to $0.014 per
 * session, with 0 to 2% invented quotes. Every kept candidate must quote the session verbatim; that
 * validator is also what makes a weak local model safe (it yields fewer memories, not false ones;
 * qwen3.5:9b recovered 5 of 10 with 18% invented quotes, all dropped).
 *
 * Pipeline: renderSession (leak guard: anything showing a memory being written or read is removed)
 * -> chunks -> provider call -> parseItems -> filterCandidates (quote, secret, duplicate) -> candidate
 * markdown. Candidates are staged OUTSIDE the memory dir; nothing reaches an agent until promoted.
 *
 * Privacy: the transcript text is sent to the configured provider (Anthropic API by default; with
 * MEMORY_CAPTURE_PROVIDER=claude-cli, through the user's own `claude -p` login instead of an API key).
 * Secrets are filtered from OUTPUT only; do not capture sessions in which credentials were pasted.
 *
 * Leaf module: Node builtins and global fetch only (the claude-cli provider spawns the user's own `claude`). Secret detection beyond SECRET_RE is injected by the caller.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { slugify, sha1 } = require('./memory-notes');

// Pinned API model ids and prices live in adapter metadata (model ids are not hard-coded in authored code).
const MODEL_TABLE_PATH = path.join(__dirname, '..', '..', 'adapters', 'claude', 'model-tiers.json');

/** {haiku: {id, inPerM, outPerM}, sonnet: {...}} and the default alias from adapters/claude/model-tiers.json (`directApi`). */
function modelTable() {
    try {
        const d = JSON.parse(fs.readFileSync(MODEL_TABLE_PATH, 'utf8')).directApi || {};
        return { models: d.models && typeof d.models === 'object' ? d.models : {}, defaultAlias: d.memoryCaptureDefault || 'haiku' };
    } catch { return { models: {}, defaultAlias: 'haiku' }; }
}

const LEAK = /MEMORY\.md|\/memory\/|auto-memory|memory file|saved (a |the )?memor|saving (it )?to memory|save (this|that|it) (to|as a) memory|remember(ed)? (this|that)\b/i;
const SECRET_RE = new RegExp([
    'sk-ant-[A-Za-z0-9_-]{8,}', 'sk-or-[A-Za-z0-9_-]{8,}', 'sk-[A-Za-z0-9]{20,}', 'gh[pousr]_[A-Za-z0-9]{20,}', 'AKIA[0-9A-Z]{16}', '-----BEGIN [A-Z ]*PRIVATE KEY',
    '(password|passwd|secret|api[_-]?key|token)\\s*[:=]\\s*\\S{6,}', 'xox[baprs]-[A-Za-z0-9-]{10,}', 'eyJ[A-Za-z0-9_-]{15,}\\.[A-Za-z0-9_-]{10,}\\.',
].join('|'), 'i');

const SYSTEM = `You maintain the long-term memory of a user's AI coding assistant. Read the session below and list the memories worth keeping for FUTURE sessions.

Worth keeping:
1. Corrections or preferences the user expressed about how the assistant should behave (especially after the assistant did something the user did not want).
2. Facts about the user's environment, accounts, machines, plans or decisions that the assistant could not work out from the code or files.
3. Gotchas that cost real time and would recur.

Do not record: task progress, things derivable from the repository, one-off requests, or any secret (passwords, API keys, tokens).

Output ONLY a JSON array. Each item: {"type": "preference"|"fact"|"gotcha", "title": "<=8 words", "text": "1-3 self-contained sentences including the why", "evidence_quote": "an EXACT verbatim quote from the session, at most 200 characters, preferably the user's own words", "evidence_role": "user"|"assistant"|"tool"}.
Return [] if nothing qualifies. Be selective: a handful of high-value memories, not a summary.`;

const DEFAULT_CHUNK = 380000;

// ---------------------------------------------------------------- transcript

function blocks(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return Array.isArray(content) ? content.filter(b => b && typeof b === 'object') : [];
}

function resultText(content) {
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '';
}

/** Render a Claude Code session JSONL into {text, raw, userRaw, events}. */
function renderSession(file) {
    const events = [];
    const leaked = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const m = j && j.message;
        if (!j || !['user', 'assistant'].includes(j.type) || !m || typeof m !== 'object' || j.isMeta || j.isSidechain) continue;
        for (const b of blocks(m.content)) {
            if (j.type === 'user' && b.type === 'text') {
                const x = b.text || '';
                if (x.trim().startsWith('<system-reminder>') || x.trim().startsWith('<command-') || x.slice(0, 60).includes('<local-command')) continue;
                events.push(['USER', x, x]);
            } else if (j.type === 'assistant' && b.type === 'text') {
                if (!LEAK.test(b.text || '')) events.push(['ASSISTANT', b.text || '', b.text || '']);
            } else if (j.type === 'assistant' && b.type === 'tool_use') {
                const s = JSON.stringify(b.input || {});
                if (LEAK.test(s)) leaked.add(b.id);
                else events.push(['TOOL_CALL', `${b.name}: ${s.slice(0, 240)}`, s]);
            } else if (j.type === 'user' && b.type === 'tool_result' && !leaked.has(b.tool_use_id)) {
                const x = resultText(b.content);
                if (!LEAK.test(x)) events.push(['TOOL_RESULT', x.slice(0, 300), x]);
            }
        }
    }
    return {
        text: events.map(([r, c]) => `[${r}] ${c}`).join('\n'),
        raw: events.map(e => e[2]).join('\n'),
        userRaw: events.filter(e => e[0] === 'USER').map(e => e[2]).join('\n'),
        events,
    };
}

/** User messages only, each preceded by a short excerpt of what the assistant said before (cheapest method). */
function userOnly(r) {
    const out = [];
    let prev = '';
    for (const [role, , full] of r.events) {
        if (role === 'ASSISTANT') prev = full.trim().replace(/\n/g, ' ').slice(0, 220);
        else if (role === 'USER') out.push(prev ? `[ASSISTANT said before] ${prev}\n[USER] ${full}` : `[USER] ${full}`);
    }
    return out.join('\n\n');
}

function chunks(s, size = Number(process.env.MEMORY_CAPTURE_CHUNK) || DEFAULT_CHUNK) {
    if (s.length <= size) return [s];
    const out = [];
    let i = 0;
    while (i < s.length) {
        let j = Math.min(s.length, i + size);
        if (j < s.length) {
            const k = s.lastIndexOf('\n[', j);
            if (k > i + size / 2) j = k;
        }
        out.push(s.slice(i, j));
        i = j;
    }
    return out;
}

// ---------------------------------------------------------------- providers

function knownPrefix(known) {
    return known ? 'ALREADY IN MEMORY (do not output anything that merely restates one of these, even in different words; only add what is genuinely new):\n' + known + '\n\n' : '';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Anthropic Messages API. Returns the text and token usage. Retries 429/5xx. */
async function callAnthropic({ model, key, text, known, baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', fetchImpl = globalThis.fetch, retryMs = 5000 }) {
    const body = JSON.stringify({ model, max_tokens: 24000, system: SYSTEM, messages: [{ role: 'user', content: `${knownPrefix(known)}SESSION TRANSCRIPT:\n\n${text}` }] });
    for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
            method: 'POST', body, signal: AbortSignal.timeout(300000),
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        });
        if (res.ok) {
            const j = await res.json();
            const u = j.usage || {};
            return {
                text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
                inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
                outputTokens: u.output_tokens || 0,
            };
        }
        if ([429, 500, 502, 503, 529].includes(res.status) && attempt < 3) { await sleep(retryMs * (attempt + 1)); continue; }
        const msg = (await res.text().catch(() => '')).slice(0, 200).split(key).join('[KEY]');
        throw new Error(`API error ${res.status}: ${msg}`);
    }
}

const SAFE_MODEL_RE = /^[A-Za-z0-9._:-]+$/;

/**
 * Keyless provider: one `claude -p` call through the user's own Claude login (subscription), for people with no API key.
 * Text in, text out:
 *   - the prompt goes over stdin (a transcript chunk is far past the OS argv limit, and nothing is shell-quoted)
 *   - `--tools ''` grants NO tools, so an injection inside the transcript cannot read a file and echo it into a memory
 *   - `--no-session-persistence` writes no transcript (backfill would otherwise capture the capture)
 *   - `--setting-sources ''`, `--strict-mcp-config`, `--disable-slash-commands`: none of the user's hooks, MCP servers or CLAUDE.md load,
 *     and the child runs in one fixed empty temp dir (Claude Code makes a per-cwd project folder even without persistence, so a fresh
 *     dir per call would litter ~/.claude/projects with one empty folder per capture)
 *   - RECURSION GUARD: the child gets MEMORY_CAPTURE_INNER=1, which the recall, capture and startup hooks honor, so even a
 *     hook that did load can never start another capture or inject memories into the extraction
 * Not available outside Claude Code (Codex transcripts are a different format anyway).
 * @param {{model: string, text: string, known: string, bin?: string, timeoutMs?: number, env?: object, spawnImpl?: Function}} o
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, cost: number}>}
 */
function callClaudeCli({ model, text, known, bin, timeoutMs = 300000, env = process.env, spawnImpl = childProcess.spawn }) {
    if (!SAFE_MODEL_RE.test(String(model))) return Promise.reject(new Error(`refusing unsafe model id: ${JSON.stringify(model)}`));
    const prompt = `${SYSTEM}\n\n---\n\n${knownPrefix(known)}SESSION TRANSCRIPT:\n\n${text}`;
    // A .js bin runs under this node (portable test double and wrapper scripts); anything else is executed directly (no shell).
    const exe = bin || env.MEMORY_CAPTURE_CLAUDE_BIN || 'claude';
    const isScript = /\.(c|m)?js$/i.test(exe);
    const args = [...(isScript ? [exe] : []), '-p', '--model', model, '--tools', '', '--output-format', 'json', '--no-session-persistence',
        '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands'];
    const childEnv = { ...env, MEMORY_CAPTURE_INNER: '1' };
    delete childEnv.CLAUDE_PROJECT_DIR;
    const cwd = path.join(os.tmpdir(), 'domdhi-memory-capture-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    return new Promise((resolve, reject) => {
        let out = '', err = '', done = false;
        const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
        let child;
        try { child = spawnImpl(isScript ? process.execPath : exe, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return finish(reject, e); }
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(reject, new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
        child.stdout.on('data', d => { if (out.length < 20e6) out += d; });
        child.stderr.on('data', d => { if (err.length < 1e5) err += d; });
        child.on('error', e => finish(reject, new Error(e.code === 'ENOENT' || e.code === 'EINVAL' ? 'the claude CLI could not be started: not found on PATH, or a .cmd shim that Windows cannot run without a shell (shell mode is avoided on purpose: it would drop the empty --tools argument). Set MEMORY_CAPTURE_CLAUDE_BIN to claude.exe or a .js wrapper, or use an API key' : `claude -p failed to start: ${e.message}`)));
        child.on('close', code => {
            let j;
            try { j = JSON.parse(out); } catch { /* not an envelope */ }
            if (code !== 0 || !j || j.is_error || typeof j.result !== 'string') {
                const why = (j && typeof j.result === 'string' ? j.result : err || out).trim().replace(/\s+/g, ' ').slice(0, 200);
                return finish(reject, new Error(`claude -p failed (exit ${code}): ${why || 'no output'}`));
            }
            const u = j.usage || {};
            finish(resolve, {
                text: j.result,
                inputTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
                outputTokens: u.output_tokens || 0,
                cost: Number(j.total_cost_usd) || 0,
            });
        });
        child.stdin.on('error', () => { /* the close handler reports the failure */ });
        child.stdin.end(prompt);
    });
}

/** OpenAI-compatible chat completions (Ollama, vLLM, OpenRouter, LM Studio). Degraded fallback: measured weaker than Haiku. */
async function callOpenAI({ baseUrl, model, key, text, known, fetchImpl = globalThis.fetch }) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', headers, signal: AbortSignal.timeout(1800000),
        body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${knownPrefix(known)}SESSION TRANSCRIPT:\n\n${text}` }] }),
    });
    if (!res.ok) throw new Error(`chat server answered ${res.status}`);
    const j = await res.json();
    return { text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '', inputTokens: 0, outputTokens: 0 };
}

/** Parse the model output; salvages complete items from truncated JSON. */
function parseItems(text) {
    const t = String(text || '').trim();
    const i = t.indexOf('[');
    if (i < 0) return [];
    try {
        const arr = JSON.parse(t.slice(i, t.lastIndexOf(']') + 1));
        return Array.isArray(arr) ? arr.filter(x => x && typeof x === 'object' && x.text) : [];
    } catch { /* fall through to salvage */ }
    const items = [];
    let pos = i + 1;
    while (pos < t.length) {
        const start = t.indexOf('{', pos);
        if (start < 0) break;
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let p = start; p < t.length; p++) {
            const c = t[p];
            if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
            if (c === '"') inStr = true;
            else if (c === '{') depth++;
            else if (c === '}' && --depth === 0) { end = p; break; }
        }
        if (end < 0) break;
        try { const o = JSON.parse(t.slice(start, end + 1)); if (o && o.text) items.push(o); } catch { /* skip malformed item */ }
        pos = end + 1;
    }
    return items;
}

// ---------------------------------------------------------------- filters

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const WORD_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'not', 'you', 'are', 'was', 'when', 'use', 'dom', 'his', 'their']);

function words(s) {
    const set = new Set(norm(s).match(/[a-z0-9_.-]{3,}/g) || []);
    for (const w of WORD_STOP) set.delete(w);
    return set;
}

function similar(a, b) {
    const wa = words(a), wb = words(b);
    if (!wa.size || !wb.size) return 0;
    let n = 0;
    for (const w of wa) if (wb.has(w)) n++;
    return n / Math.min(wa.size, wb.size);
}

/**
 * Keep candidates that (1) quote the session verbatim, (2) contain no secret, (3) are not already known.
 * @param {object[]} cands
 * @param {{raw: string, userRaw: string}} r  renderSession() result
 * @param {string[]} existing  text of existing memories/candidates
 * @param {{isSecret?: (s: string) => boolean}} [o]
 */
function filterCandidates(cands, r, existing, { isSecret = t => SECRET_RE.test(t) } = {}) {
    const kept = [];
    const dropped = { no_quote: 0, secret: 0, duplicate: 0, empty: 0 };
    const rawN = norm(r.raw), userN = norm(r.userRaw);
    const seenHere = [];
    for (const c of cands) {
        const title = c.title || '', text = c.text || '', q = c.evidence_quote || '';
        if (!title || !text) { dropped.empty++; continue; }
        if (!norm(q) || !rawN.includes(norm(q))) { dropped.no_quote++; continue; }
        if (isSecret(`${title} ${text} ${q}`) || SECRET_RE.test(`${title} ${text} ${q}`)) { dropped.secret++; continue; }
        const blob = `${title} ${text}`;
        if (existing.some(e => similar(blob, e) >= 0.5 || similar(title, e.slice(0, 200)) >= 0.8) || seenHere.some(s => similar(blob, s) >= 0.6)) { dropped.duplicate++; continue; }
        c.quote_in_user = userN.includes(norm(q));
        seenHere.push(blob);
        kept.push(c);
    }
    kept.sort((a, b) => Number(b.quote_in_user) - Number(a.quote_in_user));
    return { kept, dropped };
}

/** The markdown file text for one staged candidate, plus its id (sha prefix + slug). */
function candidateFile(c, session, date = new Date().toISOString().slice(0, 10)) {
    const slug = slugify(c.title) || 'memory';
    const id = `${sha1(session + c.title).slice(0, 6)}-${slug}`;
    const type = { preference: 'feedback', fact: 'reference', gotcha: 'feedback' }[c.type] || 'reference';
    const desc = c.text.split('. ')[0].replace(/"/g, "'").replace(/\s+/g, ' ').slice(0, 150);
    const quote = String(c.evidence_quote).replace(/\s+/g, ' ');
    const content = `---\nname: ${slug}\ndescription: "${desc}"\nmetadata:\n  type: ${type}\n  originSessionId: ${session}\n  captured: ${date}\n  evidence_in_user_message: ${c.quote_in_user ? 'true' : 'false'}\n---\n\n${c.text}\n\n**Evidence (verbatim):** "${quote}"\n`;
    return { id, slug, desc, content };
}

module.exports = { modelTable, SECRET_RE, SYSTEM, DEFAULT_CHUNK, LEAK, renderSession, userOnly, chunks, callAnthropic, callOpenAI, callClaudeCli, parseItems, norm, similar, filterCandidates, candidateFile };
