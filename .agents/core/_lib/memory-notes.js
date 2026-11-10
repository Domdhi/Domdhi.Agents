'use strict';

/**
 * memory-notes.js — the plain-markdown memory corpus used by capture and recall.
 *
 * Two sources, one document shape:
 *   - notes:  `*.md` files (name/description frontmatter + body) in the memory dir. The default
 *             memory dir is Claude Code's native auto-memory dir, so the same files are what
 *             Claude loads through its own MEMORY.md index.
 *   - engine: the toolkit's curated JSON memories (docs/.output/.memory/<category>/*.json),
 *             adapted read-only. Superseded (`invalid_at`) memories never enter the corpus.
 *             A notes file with the same name shadows its engine twin, so `import-engine`
 *             (copying JSON to markdown) never produces a duplicate.
 *
 * Leaf module: Node builtins only. Never throws on a bad file; it skips it.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Claude Code names a project's directory after its path with every non-alphanumeric replaced by "-". */
function mungePath(p) {
    return path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
}

function claudeConfigDir(env = process.env) {
    return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

/** `<claude config>/projects/<munged project root>` — where Claude keeps a project's sessions and auto-memory. */
function claudeProjectDir(projectRoot, env = process.env) {
    return path.join(claudeConfigDir(env), 'projects', mungePath(projectRoot));
}

/** Memory dir: MEMORY_DIR override, else Claude's native auto-memory dir for the project. */
function defaultMemoryDir(projectRoot, env = process.env) {
    if (env.MEMORY_DIR) return path.resolve(env.MEMORY_DIR);
    return path.join(claudeProjectDir(projectRoot, env), 'memory');
}

function splitFrontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    return m ? { fm: m[1], body: m[2] } : { fm: '', body: text };
}

function fmValue(fm, key) {
    const m = new RegExp(`^\\s*${key}:[ \\t]*(.*)$`, 'm').exec(fm);
    return m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1') : '';
}

function sha1(s) {
    return crypto.createHash('sha1').update(s).digest('hex');
}

function slugify(s, max = 60) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

function isLive(fm) {
    return !fmValue(fm, 'invalid_at') && !fmValue(fm, 'superseded_by');
}

/** {key: {key, source:'notes', file, name, description, body, text, sha}} for every live note. MEMORY.md and dot files are excluded. */
function loadNotes(dir) {
    const out = {};
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!e.isFile() || !e.name.endsWith('.md') || e.name === 'MEMORY.md' || e.name.startsWith('.')) continue;
        let raw;
        try { raw = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
        const { fm, body } = splitFrontmatter(raw);
        if (!isLive(fm)) continue;
        const name = fmValue(fm, 'name') || e.name.slice(0, -3);
        const description = fmValue(fm, 'description');
        out[e.name] = { key: e.name, source: 'notes', file: e.name, name, description, body: body.trim(), text: `${name}\n${description}\n${body}`.trim(), sha: sha1(raw) };
    }
    return out;
}

const ENGINE_BODY_KEYS = ['correct_pattern', 'steps', 'evidence', 'reason', 'alternative'];

function engineBody(content) {
    const c = content && typeof content === 'object' ? content : {};
    const parts = [typeof content === 'string' ? content : c.description || c.summary || ''];
    for (const k of ENGINE_BODY_KEYS) {
        const v = c[k];
        if (!v) continue;
        const label = k.replace(/_/g, ' ').replace(/^./, ch => ch.toUpperCase());
        parts.push(`**${label}:** ` + (Array.isArray(v) ? '\n' + v.map(x => `- ${x}`).join('\n') : String(v)));
    }
    return parts.filter(Boolean).join('\n\n');
}

/** Engine JSON memories as read-only documents. `root` = docs/.output/.memory. */
function loadEngine(root) {
    const out = {};
    let cats;
    try { cats = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return out; }
    for (const cat of cats) {
        let files;
        try { files = fs.readdirSync(path.join(root, cat)).filter(f => f.endsWith('.json')).sort(); } catch { continue; }
        for (const f of files) {
            let raw, j;
            try { raw = fs.readFileSync(path.join(root, cat, f), 'utf8'); j = JSON.parse(raw); } catch { continue; }
            if (!j || typeof j !== 'object' || Array.isArray(j) || j.invalid_at) continue;
            const name = slugify(typeof j.id === 'string' && j.id ? j.id : f.slice(0, -5), 70) || f.slice(0, -5);
            const body = engineBody(j.content);
            if (!body) continue;
            const description = body.split(/\.\s/)[0].replace(/\s+/g, ' ').slice(0, 150);
            const key = `engine:${cat}/${f}`;
            out[key] = { key, source: 'engine', file: `${cat}/${f}`, category: cat, name, description, body, text: `${name}\n${description}\n${body}`, sha: sha1(raw) };
        }
    }
    return out;
}

/** Notes + engine, notes shadowing same-named engine memories. */
function loadCorpus({ memoryDir, engineRoot }) {
    const notes = loadNotes(memoryDir);
    const names = new Set(Object.values(notes).map(d => d.name));
    const corpus = { ...notes };
    if (engineRoot) {
        for (const [k, d] of Object.entries(loadEngine(engineRoot))) if (!names.has(d.name)) corpus[k] = d;
    }
    return corpus;
}

module.exports = { mungePath, claudeConfigDir, claudeProjectDir, defaultMemoryDir, splitFrontmatter, fmValue, sha1, slugify, loadNotes, loadEngine, loadCorpus, engineBody };
