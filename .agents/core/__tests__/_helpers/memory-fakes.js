'use strict';
/**
 * Fake HTTP servers for the memory capture/recall tests: an OpenAI-compatible embeddings endpoint
 * (deterministic bag-of-words vectors, so word overlap behaves like meaning) and an Anthropic /v1/messages endpoint.
 * Nothing leaves the machine; no model is loaded.
 */
const http = require('node:http');
const crypto = require('node:crypto');

const DIM = 64;

function hashVec(text) {
    const v = new Array(DIM).fill(0);
    for (const w of String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || []) v[parseInt(crypto.createHash('md5').update(w).digest('hex').slice(0, 8), 16) % DIM] += 1;
    return v;
}

function listen(handler) {
    return new Promise(resolve => {
        const calls = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                let json = null;
                try { json = JSON.parse(body); } catch { /* not json */ }
                calls.push({ url: req.url, headers: req.headers, body: json });
                handler(req, res, json, calls);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`, calls,
            close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
        }));
    });
}

const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

/** OpenAI-compatible embeddings. `fail` makes every call answer 500. */
function startEmbedServer({ fail = false } = {}) {
    return listen((req, res, json) => {
        if (fail || !json || !Array.isArray(json.input)) return send(res, 500, { error: 'down' });
        send(res, 200, { data: json.input.map((t, i) => ({ index: i, embedding: hashVec(t) })) });
    });
}

/** Anthropic /v1/messages. `respond(body, calls)` returns {status?, items?, text?, usage?}. */
function startAnthropicServer(respond) {
    return listen((req, res, json, calls) => {
        const r = respond(json, calls) || {};
        if (r.status && r.status !== 200) return send(res, r.status, { error: { message: r.message || 'nope' } });
        const text = r.text !== undefined ? r.text : JSON.stringify(r.items || []);
        send(res, 200, { content: [{ type: 'text', text }], usage: r.usage || { input_tokens: 1000, output_tokens: 200 } });
    });
}

/**
 * A stand-in for the `claude` CLI: a node script (memory-extract runs *.js bins under process.execPath, so it works on every OS).
 * It records what it was called with to <dir>/claude-call.json and answers with a `--output-format json` envelope.
 * behavior: {items} -> envelope whose result is the JSON array; {exit: n, stderr} -> fails; {raw} -> prints raw stdout; {hang: true} -> never answers.
 */
function writeFakeClaude(dir, behavior = {}) {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(dir, 'fake-claude.js');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `
const fs = require('fs'), path = require('path');
const B = ${JSON.stringify(behavior)};
let stdin = '';
process.stdin.on('data', d => stdin += d);
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'claude-call.json'), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), inner: process.env.MEMORY_CAPTURE_INNER || null, projectDir: process.env.CLAUDE_PROJECT_DIR || null, prompt: stdin }));
  if (B.hang) { setInterval(() => {}, 1000); return; }
  if (B.raw !== undefined) { process.stdout.write(B.raw); return; }
  if (B.exit) { process.stderr.write(B.stderr || 'boom'); process.exit(B.exit); }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(B.items || []), total_cost_usd: 0.0123, usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 500, output_tokens: 300 } }));
});
`);
    return { bin: file, call: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'claude-call.json'), 'utf8')); } catch { return null; } } };
}

module.exports = { startEmbedServer, startAnthropicServer, writeFakeClaude, hashVec, DIM };
