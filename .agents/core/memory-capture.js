#!/usr/bin/env node
'use strict';

/**
 * memory-capture.js — automatic memory capture and hybrid recall over plain-markdown memories.
 *
 *   capture [--session ID|latest|PATH] [--model haiku|sonnet|ID] [--method W|U] [--max-keep N] [--user-quote-only]
 *           [--min-user-chars N] [--dry-run] [--force] [--quiet] [--then-index]
 *                                       providers (MEMORY_CAPTURE_PROVIDER, or a fallback chain such as claude-cli,anthropic): anthropic (default; API key), claude-cli (no key: your
 *                                       own `claude -p` login), openai (any OpenAI-compatible server)
 *   backfill [--older-than-min 30] [--max-sessions 10] [--max-keep 6] [--user-quote-only] [--dry-run]
 *   pending [--older-than-min 30]       sessions not yet captured (no key, no cost)
 *   list                                staged candidates awaiting review
 *   promote <id>...                     move candidates into the memory dir, add to MEMORY.md, embed
 *   discard <id>...                     reject candidates (kept in .discarded so they are not re-proposed)
 *   index                               embed new/changed memories (incremental, content-hashed)
 *   recall "query" [-k 3] [--full]      hybrid recall over notes + the engine's JSON memories
 *   import-engine [dir]                 copy the engine's JSON memories into the memory dir as markdown (optional)
 *   sync [--push|--pull] [--prefer local|tracked] [--dry-run]
 *                                       mirror the notes to/from the tracked docs/.output/.memory/notes/ so git carries them
 *                                       between machines (three-way by content; conflicts are reported, never overwritten)
 *   status                              what is configured and what is pending
 *
 * Capture is OPT-IN for the automatic SessionEnd hook (MEMORY_CAPTURE=on); running this CLI is an explicit act and works
 * whenever a provider is configured. Candidates are staged outside the memory dir; a human promotes or discards them.
 * See .agents/startup-reference.md "Memory System" for configuration (env vars), evidence and privacy.
 *
 * Exit codes: 0 ok, 1 error. Hooks never see these (they spawn this detached).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { notesContext, captureEnabled, recallEnabled } = require('./_lib/memory-context');
const notes = require('./_lib/memory-notes');
const rec = require('./_lib/memory-recall');
const ex = require('./_lib/memory-extract');
const msync = require('./_lib/memory-sync');

const VALUE_FLAGS = new Set(['session', 'model', 'method', 'max-keep', 'min-user-chars', 'older-than-min', 'max-sessions', 'k', 'prefer']);

// ---------------------------------------------------------------- context & config

function parseArgs(argv) {
    const pos = [], flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-k') flags.k = argv[++i];
        else if (a.startsWith('--')) {
            const name = a.slice(2);
            flags[name] = VALUE_FLAGS.has(name) ? argv[++i] : true;
        } else pos.push(a);
    }
    return { pos, flags };
}

function contextFor(env = process.env) {
    return notesContext(path.resolve(__dirname, '..', '..'), env);
}

/**
 * MEMORY_CAPTURE_PROVIDER is one provider or a comma-separated fallback chain ("claude-cli,anthropic": try your Claude login
 * first, then the API key if that call fails). Unknown names mean anthropic, as before; duplicates are dropped.
 */
function captureProviders(env = process.env) {
    const names = String(env.MEMORY_CAPTURE_PROVIDER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        .map(n => (n === 'openai' ? 'openai' : n === 'claude-cli' || n === 'claude' ? 'claude-cli' : 'anthropic'));
    const chain = [...new Set(names)];
    return chain.length ? chain : ['anthropic'];
}

function captureConfig(env = process.env, which) {
    const asked = which || captureProviders(env)[0];
    const provider = asked === 'openai' ? 'openai' : asked === 'claude-cli' ? 'claude-cli' : 'anthropic';
    if (provider === 'openai') {
        const model = env.MEMORY_CAPTURE_MODEL || '';
        return { provider, model, baseUrl: env.MEMORY_CAPTURE_BASE_URL || 'http://127.0.0.1:11434/v1', key: env.MEMORY_CAPTURE_API_KEY || '', keySource: 'n/a', ready: Boolean(model) };
    }
    const { models, defaultAlias } = ex.modelTable();
    const alias = env.MEMORY_CAPTURE_MODEL || defaultAlias;
    const entry = models[alias];
    // An unknown name is taken as a raw API model id (cost unknown); a known alias with no table entry cannot be resolved.
    const model = entry ? entry.id : /^(haiku|sonnet)$/.test(alias) ? '' : alias;
    if (provider === 'claude-cli') return { provider, alias, model, price: entry || { inPerM: 0, outPerM: 0 }, keySource: 'claude login', ready: Boolean(model) && !env.MEMORY_CAPTURE_INNER };
    const keySource = env.ANTHROPIC_API_KEY ? 'env' : env.MEMORY_CAPTURE_KEY_COMMAND ? 'command' : 'none';
    return { provider, alias, model, price: entry || { inPerM: 0, outPerM: 0 }, keySource, ready: keySource !== 'none' && Boolean(model) };
}

/** The Anthropic key: ANTHROPIC_API_KEY, else the stdout of MEMORY_CAPTURE_KEY_COMMAND. Never logged. */
function resolveKey(env = process.env) {
    if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY.trim();
    if (!env.MEMORY_CAPTURE_KEY_COMMAND) return null;
    try {
        const out = execSync(env.MEMORY_CAPTURE_KEY_COMMAND, { encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env }).trim();
        return out && !/\s/.test(out) ? out : null;
    } catch { return null; }
}

// ---------------------------------------------------------------- secret filter (engine first, regex always)

let scanner;
function engineSecretCheck(text) {
    try {
        if (scanner === undefined) scanner = require('../hooks/secret-patterns.cjs');
        if (!scanner) return false;
        return (scanner.scanContentWithFallback(text, 'memory-candidate.md', { honorMarkers: false }) || []).some(f => f.type === 'SECRET_PATTERN');
    } catch { scanner = null; return false; }
}
const isSecret = t => ex.SECRET_RE.test(t) || engineSecretCheck(t);

// ---------------------------------------------------------------- small fs helpers

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

function writeAtomic(p, text) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
}

const ledgerOf = ctx => readJson(ctx.ledgerPath, {});
function ledgerAdd(ctx, sid, staged, cost) {
    const led = ledgerOf(ctx);
    led[sid] = { at: new Date().toISOString(), staged, cost: Math.round(cost * 1e4) / 1e4 };
    writeAtomic(ctx.ledgerPath, JSON.stringify(led, null, 1));
}

function listMd(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.')).map(e => e.name).sort(); } catch { return []; }
}

function sessionFiles(ctx) {
    try {
        return fs.readdirSync(ctx.sessionsDir).filter(f => f.endsWith('.jsonl')).map(f => {
            const p = path.join(ctx.sessionsDir, f);
            return { path: p, id: f.slice(0, -6), mtime: fs.statSync(p).mtimeMs };
        }).sort((a, b) => a.mtime - b.mtime);
    } catch { return []; }
}

const pendingSessions = (ctx, olderMin) => {
    const led = ledgerOf(ctx), now = Date.now();
    return sessionFiles(ctx).filter(s => !led[s.id] && now - s.mtime > olderMin * 60000);
};

// ---------------------------------------------------------------- capture

async function captureOne(file, ctx, o, env, io) {
    const cfg = captureConfig(env);
    const sid = path.basename(file).replace(/\.jsonl$/, '');
    const r = ex.renderSession(file);
    if (r.userRaw.length < o.minUserChars) {
        if (!o.quiet) io.log(`session ${sid.slice(0, 8)}: too little user text, skipped`);
        if (!o.dryRun) ledgerAdd(ctx, sid, 0, 0);
        return { staged: 0, cost: 0 };
    }
    const input = o.method === 'U' ? ex.userOnly(r) : r.text;
    const parts = ex.chunks(input);
    io.log(`session ${sid.slice(0, 8)}: ${input.length} chars to send in ${parts.length} call(s) to ${cfg.provider === 'openai' ? cfg.baseUrl : cfg.provider === 'claude-cli' ? `claude -p (${cfg.model}, your Claude login)` : cfg.model}`);
    if (o.dryRun) return { staged: 0, cost: 0 };
    // Recursion guard: the keyless provider's own child session must never start a capture.
    if (env.MEMORY_CAPTURE_INNER) throw new Error('capture refused inside a capture child (MEMORY_CAPTURE_INNER is set)');

    const corpus = notes.loadCorpus({ memoryDir: ctx.memoryDir, engineRoot: ctx.engineRoot });
    const staged = [...listMd(ctx.candidatesDir).map(f => path.join(ctx.candidatesDir, f)), ...listMd(ctx.discardedDir).map(f => path.join(ctx.discardedDir, f))]
        .map(f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } });
    const existing = [...Object.values(corpus).map(d => d.text), ...staged];
    const known = [...Object.values(corpus).map(d => `- ${d.name}: ${d.description.slice(0, 220)}`),
        ...staged.map(t => { const { fm } = notes.splitFrontmatter(t); return `- ${notes.fmValue(fm, 'name')}: ${notes.fmValue(fm, 'description').slice(0, 220)}`; })].join('\n');

    // One provider's whole pass over the session's parts. A failure (preflight or call) throws so the next provider in the chain can try.
    const attempt = async cfgX => {
        const key = cfgX.provider === 'anthropic' ? resolveKey(env) : null;
        if (cfgX.provider !== 'openai' && !cfgX.model) throw new Error(`cannot resolve model "${cfgX.alias}": adapters/claude/model-tiers.json has no directApi.models entry (or set MEMORY_CAPTURE_MODEL to a model id)`);
        if (cfgX.provider === 'anthropic' && !key) throw new Error('no Anthropic key: set ANTHROPIC_API_KEY or MEMORY_CAPTURE_KEY_COMMAND (or MEMORY_CAPTURE_PROVIDER=claude-cli to use your Claude login, or =openai with MEMORY_CAPTURE_MODEL)');
        if (cfgX.provider === 'openai' && !cfgX.model) throw new Error('MEMORY_CAPTURE_MODEL is required with MEMORY_CAPTURE_PROVIDER=openai');
        const out = [];
        let spent = 0;
        const m = cfgX.price || { inPerM: 0, outPerM: 0 };
        for (const text of parts) {
            const res = cfgX.provider === 'openai'
                ? await ex.callOpenAI({ baseUrl: cfgX.baseUrl, model: cfgX.model, key: cfgX.key, text, known, fetchImpl: io.fetchImpl })
                : cfgX.provider === 'claude-cli'
                    ? await ex.callClaudeCli({ model: cfgX.model, text, known, env })
                    : await ex.callAnthropic({ model: cfgX.model, key, text, known, fetchImpl: io.fetchImpl, retryMs: io.retryMs });
            out.push(...ex.parseItems(res.text));
            spent += res.cost !== undefined ? res.cost : res.inputTokens / 1e6 * m.inPerM + res.outputTokens / 1e6 * m.outPerM;
        }
        return { out, spent };
    };

    const chain = captureProviders(env).map(p => captureConfig(env, p));
    let cands = [];
    let cost = 0;
    const failures = [];
    for (const c of chain) {
        try {
            const r2 = await attempt(c);
            cands = r2.out;
            cost = r2.spent;
            failures.length = 0;
            break;
        } catch (e) {
            failures.push(`${c.provider}: ${e.message}`);
            if (chain.indexOf(c) < chain.length - 1) io.log(`  capture provider ${c.provider} failed (${String(e.message).slice(0, 160)}); trying ${chain[chain.indexOf(c) + 1].provider}`);
        }
    }
    if (failures.length) throw new Error(chain.length === 1 ? failures[0].replace(/^[a-z-]+: /, '') : `every capture provider failed: ${failures.join(' | ')}`);
    let { kept, dropped } = ex.filterCandidates(cands, r, existing, { isSecret });
    if (o.userQuoteOnly) {
        dropped.not_user_quote = kept.filter(c => !c.quote_in_user).length;
        kept = kept.filter(c => c.quote_in_user);
    }
    if (o.maxKeep && kept.length > o.maxKeep) { dropped.over_cap = kept.length - o.maxKeep; kept = kept.slice(0, o.maxKeep); }
    const ids = kept.map(c => {
        const f = ex.candidateFile(c, sid);
        writeAtomic(path.join(ctx.candidatesDir, `${f.id}.md`), f.content);
        return f.id;
    });
    ledgerAdd(ctx, sid, kept.length, cost);
    io.log(`  model returned ${cands.length}; dropped ${JSON.stringify(dropped)}; staged ${kept.length} (cost $${cost.toFixed(4)})`);
    if (!o.quiet) kept.forEach((c, i) => io.log(`  ${ids[i]}  [${c.type}] ${c.title}${c.quote_in_user ? '  (user quote)' : ''}`));
    return { staged: kept.length, cost };
}

function optsFrom(flags, defaults = {}) {
    return {
        method: flags.method === 'U' ? 'U' : 'W', dryRun: Boolean(flags['dry-run']), quiet: Boolean(flags.quiet), userQuoteOnly: Boolean(flags['user-quote-only']),
        maxKeep: Number(flags['max-keep'] ?? defaults.maxKeep ?? 0) || 0, minUserChars: Number(flags['min-user-chars'] ?? 200) || 200,
    };
}

async function syncIndexQuiet(ctx, env, io, timeoutMs = 60000) {
    const cfg = rec.embedConfig(env);
    if (cfg.provider === 'none') return null;
    try {
        const corpus = notes.loadCorpus({ memoryDir: ctx.memoryDir, engineRoot: ctx.engineRoot });
        return await rec.syncIndex(corpus, ctx.stateDir, cfg, { timeoutMs, fetchImpl: io.fetchImpl });
    } catch (e) {
        io.log(`(index not updated: ${String(e.message).slice(0, 100)}; recall still works keyword-only)`);
        return null;
    }
}

// ---------------------------------------------------------------- commands

const commands = {
    async capture(a, ctx, env, io) {
        const o = optsFrom(a.flags);
        const want = a.flags.session || 'latest';
        const sessions = sessionFiles(ctx);
        const file = want === 'latest' ? (sessions.length ? sessions[sessions.length - 1].path : '') : fs.existsSync(want) ? want : path.join(ctx.sessionsDir, `${want}.jsonl`);
        if (!file || !fs.existsSync(file)) throw new Error(`session not found: ${file || want}`);
        const sid = path.basename(file).replace(/\.jsonl$/, '');
        if (a.flags.model) env = { ...env, MEMORY_CAPTURE_MODEL: a.flags.model };
        if (ledgerOf(ctx)[sid] && !a.flags.force && !o.dryRun) io.log(`session ${sid.slice(0, 8)} already captured (use --force to redo)`);
        else await captureOne(file, ctx, o, env, io);
        if (a.flags['then-index']) await syncIndexQuiet(ctx, env, io);
    },

    async backfill(a, ctx, env, io) {
        const o = optsFrom(a.flags, { maxKeep: 6 });
        if (a.flags.model) env = { ...env, MEMORY_CAPTURE_MODEL: a.flags.model };
        const todo = pendingSessions(ctx, Number(a.flags['older-than-min'] ?? 30)).slice(0, Number(a.flags['max-sessions'] ?? 10));
        io.log(`${todo.length} session(s) to capture`);
        let total = 0, spent = 0;
        for (const s of todo) {
            const r = await captureOne(s.path, ctx, { ...o, quiet: true }, env, io);
            total += r.staged; spent += r.cost;
        }
        io.log(`backfill done: ${total} candidate(s) staged from ${todo.length} session(s), cost $${spent.toFixed(3)}`);
    },

    async pending(a, ctx, env, io) { io.log(String(pendingSessions(ctx, Number(a.flags['older-than-min'] ?? 30)).length)); },

    async list(a, ctx, env, io) {
        const files = listMd(ctx.candidatesDir);
        io.log(`${files.length} candidate(s) in ${ctx.candidatesDir}`);
        for (const f of files) {
            const { fm } = notes.splitFrontmatter(fs.readFileSync(path.join(ctx.candidatesDir, f), 'utf8'));
            io.log(`  ${f.slice(0, -3)}: ${notes.fmValue(fm, 'name')} - ${notes.fmValue(fm, 'description')}${notes.fmValue(fm, 'evidence_in_user_message') === 'true' ? '  (user quote)' : ''}`);
        }
    },

    async promote(a, ctx, env, io) {
        if (!a.pos.length) throw new Error('promote: give at least one candidate id (see `list`)');
        fs.mkdirSync(ctx.memoryDir, { recursive: true });
        const indexPath = path.join(ctx.memoryDir, 'MEMORY.md');
        let promoted = 0;
        for (const given of a.pos) {
            const id = resolveCandidate(ctx, given);
            if (!id) { io.log(`no such candidate: ${given}`); continue; }
            const src = path.join(ctx.candidatesDir, `${id}.md`);
            const text = fs.readFileSync(src, 'utf8');
            const { fm } = notes.splitFrontmatter(text);
            const name = notes.slugify(notes.fmValue(fm, 'name')) || id;
            const dest = path.join(ctx.memoryDir, `${name}.md`);
            if (fs.existsSync(dest)) { io.log(`${name}.md already exists; not overwriting (discard the candidate or rename)`); continue; }
            fs.writeFileSync(dest, text, { flag: 'wx' });
            fs.unlinkSync(src);
            const prior = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
            fs.appendFileSync(indexPath, `${prior && !prior.endsWith('\n') ? '\n' : ''}- [${name}](${name}.md) — ${notes.fmValue(fm, 'description')}\n`);
            io.log(`promoted ${name}`);
            promoted++;
        }
        if (promoted) await syncIndexQuiet(ctx, env, io);
    },

    async discard(a, ctx, env, io) {
        if (!a.pos.length) throw new Error('discard: give at least one candidate id (see `list`)');
        fs.mkdirSync(ctx.discardedDir, { recursive: true });
        for (const given of a.pos) {
            const id = resolveCandidate(ctx, given);
            if (!id) { io.log(`no such candidate: ${given}`); continue; }
            fs.renameSync(path.join(ctx.candidatesDir, `${id}.md`), path.join(ctx.discardedDir, `${id}.md`));
            io.log(`discarded ${id}`);
        }
    },

    async index(a, ctx, env, io) {
        const cfg = rec.embedConfig(env);
        if (cfg.provider === 'none') { io.log('index: no embedding provider configured (MEMORY_EMBED_PROVIDER=none); recall is keyword-only'); return; }
        const corpus = notes.loadCorpus({ memoryDir: ctx.memoryDir, engineRoot: ctx.engineRoot });
        const r = await rec.syncIndex(corpus, ctx.stateDir, cfg, { fetchImpl: io.fetchImpl, timeoutMs: 120000 });
        io.log(`index: embedded ${r.embedded}, removed ${r.removed}, total ${r.total} (${cfg.provider}/${cfg.model})`);
    },

    async recall(a, ctx, env, io) {
        const query = a.pos.join(' ');
        if (!query) throw new Error('recall: give a query');
        const corpus = notes.loadCorpus({ memoryDir: ctx.memoryDir, engineRoot: ctx.engineRoot });
        const { floor, kwScore } = rec.tuningFromEnv(env);
        const { hits } = await rec.recall({ corpus, query, k: Number(a.flags.k || 3), floor, kwScore, stateDir: ctx.stateDir, cfg: rec.embedConfig(env), sync: true, timeoutMs: 5000, fetchImpl: io.fetchImpl });
        if (!hits.length) io.log('no relevant memory');
        for (const h of hits) io.log(`## ${h.name}  (${h.source}, ${h.file}${h.cos ? `, cos ${h.cos}` : ''})\n${a.flags.full ? h.body : h.description}\n`);
    },

    async 'import-engine'(a, ctx, env, io) {
        const root = a.pos[0] ? path.resolve(a.pos[0]) : ctx.engineRoot;
        const engine = notes.loadEngine(root);
        fs.mkdirSync(ctx.memoryDir, { recursive: true });
        const indexPath = path.join(ctx.memoryDir, 'MEMORY.md');
        let n = 0;
        for (const d of Object.values(engine)) {
            const dest = path.join(ctx.memoryDir, `${d.name}.md`);
            if (fs.existsSync(dest)) { io.log(`exists, skipped: ${d.name}`); continue; }
            const type = { constraints: 'feedback', 'rejected-approaches': 'feedback', decisions: 'project' }[d.category] || 'reference';
            const desc = d.description.replace(/"/g, "'");
            fs.writeFileSync(dest, `---\nname: ${d.name}\ndescription: "${desc}"\nmetadata:\n  type: ${type}\n  importedFrom: toolkit-engine ${d.file}\n---\n\n${d.body}\n`, { flag: 'wx' });
            const prior = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
            fs.appendFileSync(indexPath, `${prior && !prior.endsWith('\n') ? '\n' : ''}- [${d.name}](${d.name}.md) — ${desc}\n`);
            io.log(`imported ${d.name}`);
            n++;
        }
        io.log(`import-engine: ${n} imported from ${root} (the JSON source is untouched; a markdown copy shadows its JSON twin in recall)`);
        if (n) await syncIndexQuiet(ctx, env, io);
    },

    async sync(a, ctx, env, io) {
        const prefer = a.flags.prefer === undefined ? null : String(a.flags.prefer);
        if (prefer !== null && prefer !== 'local' && prefer !== 'tracked') throw new Error('sync: --prefer takes local or tracked');
        const r = msync.sync({ localDir: ctx.memoryDir, trackedDir: ctx.trackedNotesDir, stateDir: ctx.stateDir, direction: a.flags.push ? 'push' : a.flags.pull ? 'pull' : 'both', prefer, dryRun: Boolean(a.flags['dry-run']), isSecret });
        const dry = a.flags['dry-run'] ? ' (dry run, nothing written)' : '';
        io.log(`sync${dry}: ${r.pushed.length} pushed to ${path.relative(ctx.projectRoot, ctx.trackedNotesDir)}, ${r.pulled.length} pulled into the memory dir, ${r.same} already in sync`);
        for (const n of r.pushed) io.log(`  push  ${n}`);
        for (const n of r.pulled) io.log(`  pull  ${n}`);
        for (const s of r.secrets) io.log(`  skipped ${s.name}: ${s.why}`);
        for (const c of r.conflicts) io.log(`  CONFLICT ${c.name}: ${c.why}`);
        if (r.pushed.length) io.log('  commit the pushed notes with your normal flow (git add docs/.output/.memory/notes) to carry them to other machines');
        if (r.pulled.length && !a.flags['dry-run']) await syncIndexQuiet(ctx, env, io);
        if (r.conflicts.length) throw new Error(`${r.conflicts.length} conflict(s): left untouched. Re-run with --prefer local or --prefer tracked (the replaced local copy is saved under ${path.join(ctx.stateDir, 'sync-backup')})`);
    },

    async status(a, ctx, env, io) {
        const cap = captureConfig(env), emb = rec.embedConfig(env), corpus = notes.loadCorpus({ memoryDir: ctx.memoryDir, engineRoot: ctx.engineRoot });
        const idx = rec.loadIndex(ctx.stateDir);
        const on = captureEnabled(env), rOff = !recallEnabled(env);
        io.log([
            `memory dir:        ${ctx.memoryDir}${env.MEMORY_DIR ? '  (MEMORY_DIR)' : '  (native auto-memory dir)'}`,
            `corpus:            ${Object.values(corpus).filter(d => d.source === 'notes').length} notes + ${Object.values(corpus).filter(d => d.source === 'engine').length} engine memories`,
            `recall hook:       ${rOff ? 'OFF (MEMORY_RECALL)' : 'on'}${env.MEMORY_PROFILE === 'minimal' ? ' but disabled by MEMORY_PROFILE=minimal' : ''}`,
            `embeddings:        ${emb.provider === 'none' ? 'none (keyword-only)' : `${emb.provider} ${emb.url} model ${emb.model}`}; indexed ${idx ? Object.keys(idx.items).length : 0}/${Object.keys(corpus).length}`,
            `auto capture:      ${on ? 'ON (MEMORY_CAPTURE)' : 'off (set MEMORY_CAPTURE=on to enable the SessionEnd hook)'}`,
            `capture provider:  ${cap.provider} ${cap.model || '(no model)'}; ${cap.provider === 'openai' ? `server ${cap.baseUrl}` : cap.provider === 'claude-cli' ? `runs \`claude -p\` with your Claude login (no API key)` : `key source: ${cap.keySource}`}; ${cap.ready ? 'ready' : 'NOT READY'}`,
            ...captureProviders(env).slice(1).map(p => { const f = captureConfig(env, p); return `capture fallback:  ${f.provider} ${f.model || '(no model)'}; ${f.ready ? 'ready' : 'NOT READY'}`; }),
            `notes sync:       ${syncLine(ctx)}`,
            `candidates:        ${listMd(ctx.candidatesDir).length} awaiting review; ${pendingSessions(ctx, 30).length} session(s) not yet captured`,
        ].join('\n'));
    },
};

function syncLine(ctx) {
    const p = msync.sync({ localDir: ctx.memoryDir, trackedDir: ctx.trackedNotesDir, stateDir: ctx.stateDir, dryRun: true, isSecret });
    const auto = process.env.MEMORY_SYNC && ['on', '1', 'true', 'yes'].includes(process.env.MEMORY_SYNC.toLowerCase()) ? 'auto ON (MEMORY_SYNC)' : 'manual (MEMORY_SYNC=on automates it)';
    return `${auto}; ${path.relative(ctx.projectRoot, ctx.trackedNotesDir)}: ${p.same} in sync, ${p.pushed.length} to push, ${p.pulled.length} to pull${p.conflicts.length ? `, ${p.conflicts.length} CONFLICT` : ''}`;
}

function resolveCandidate(ctx, given) {
    const id = String(given).replace(/\.md$/, '');
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
    if (fs.existsSync(path.join(ctx.candidatesDir, `${id}.md`))) return id;
    const m = listMd(ctx.candidatesDir).filter(f => f.startsWith(id));
    return m.length === 1 ? m[0].slice(0, -3) : null;
}

async function run(argv, { env = process.env, log = console.log, fetchImpl = globalThis.fetch, retryMs } = {}) {
    const a = parseArgs(argv);
    const cmd = a.pos.shift();
    if (!cmd || !commands[cmd]) throw new Error(`usage: memory-capture.js <${Object.keys(commands).join('|')}> (see the header of .agents/core/memory-capture.js)`);
    await commands[cmd](a, contextFor(env), env, { log, fetchImpl, retryMs });
}

if (require.main === module) {
    run(process.argv.slice(2)).catch(e => { console.error(`memory-capture: ${e.message}`); process.exitCode = 1; });
}

module.exports = { run, parseArgs, contextFor, captureConfig, captureProviders, resolveKey, isSecret };
