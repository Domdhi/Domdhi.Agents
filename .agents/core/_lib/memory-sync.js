'use strict';

/**
 * memory-sync.js — carry the markdown notes between machines over git.
 *
 * The notes dir (Claude's native auto-memory dir, or MEMORY_DIR) lives under ~/.claude on ONE machine. The engine's JSON
 * memories already travel over git because they sit in the tracked `docs/.output/.memory/`. This library mirrors the notes
 * into `docs/.output/.memory/notes/` (tracked, invisible to the engine, which only reads its own category folders) and back,
 * so an ordinary commit/pull moves them. Nothing here talks to git or the network.
 *
 * Three-way by content hash, per file name. `base` is the sha both sides last agreed on (kept per machine in the state dir):
 *   same on both sides           -> nothing to do
 *   only one side has the file   -> copy it across
 *   both have it, they differ    -> the side that moved away from `base` wins; if both moved it is a CONFLICT, which is
 *                                   reported and left alone (nothing is overwritten) unless the caller passes prefer=local|tracked
 * Sync never deletes. A note is retired by editing it (`invalid_at:` / `superseded_by:` frontmatter, which recall honors), and
 * that edit syncs like any other. Anything that looks like a secret is neither pushed nor pulled. A local file about to be
 * replaced by a pull is saved to `backupDir` first (always: the base can be stale or from another worktree, so "the local copy
 * still equals the base" never proves the local copy is safe to lose).
 *
 * The local notes dir and the state dir are shared by every worktree of a repo, but the tracked mirror is per worktree (a
 * linked worktree on an older branch holds an older mirror). The base is therefore kept PER TRACKED DIR: a base recorded from
 * one worktree's mirror never decides what to do with another worktree's mirror.
 *
 * Pure helpers take injected fs-free inputs where possible; apply() is the only function that writes.
 */

const fs = require('fs');
const path = require('path');
const { sha1, splitFrontmatter, fmValue } = require('./memory-notes');
const { safeWriteAtomic } = require('./fs-safe');

const isNoteFile = f => f.endsWith('.md') && f !== 'MEMORY.md' && !f.startsWith('.');

/** {name: {sha, text}} for the top-level notes of a directory (missing dir = empty). */
function readNotes(dir) {
    const out = {};
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && isNoteFile(e.name)).map(e => e.name).sort(); } catch { return out; }
    for (const name of names) {
        try {
            const text = fs.readFileSync(path.join(dir, name), 'utf8');
            out[name] = { sha: sha1(text), text };
        } catch { /* unreadable file: ignore */ }
    }
    return out;
}

/**
 * Decide what to do per file. Pure.
 * @param {{local: object, tracked: object, base: object, direction?: 'both'|'push'|'pull', prefer?: 'local'|'tracked'|null, isSecret?: Function}} o
 * @returns {{name: string, op: 'push'|'pull'|'conflict'|'secret'|'same', why?: string}[]}
 */
function plan({ local, tracked, base = {}, direction = 'both', prefer = null, isSecret = () => false }) {
    const names = [...new Set([...Object.keys(local), ...Object.keys(tracked)])].sort();
    const canPush = direction !== 'pull', canPull = direction !== 'push';
    const actions = [];
    for (const name of names) {
        const L = local[name], T = tracked[name], B = base[name] || null;
        if (L && T && L.sha === T.sha) { actions.push({ name, op: 'same' }); continue; }
        let op;
        if (L && !T) op = 'push';
        else if (!L && T) op = 'pull';
        else if (B === L.sha) op = 'pull';       // only the tracked copy moved
        else if (B === T.sha) op = 'push';       // only the local copy moved
        else if (prefer === 'local') op = 'push';
        else if (prefer === 'tracked') op = 'pull';
        else { actions.push({ name, op: 'conflict', why: 'both sides changed since the last sync' }); continue; }
        if ((op === 'push' && !canPush) || (op === 'pull' && !canPull)) continue;
        const src = op === 'push' ? L : T;
        if (isSecret(src.text)) { actions.push({ name, op: 'secret', why: `${op === 'push' ? 'local' : 'tracked'} copy looks like it contains a secret` }); continue; }
        actions.push({ name, op });
    }
    return actions;
}

// A path under docs/.output (the tracked notes mirror, the sync base in the state folder) gets the
// symlinked-ancestor guard; a path outside the project (the native memory dir) gets the leaf guard only.
function writeAtomic(p, text) {
    safeWriteAtomic(p, text);
}

/** Add `- [name](file) — description` lines to MEMORY.md for notes it does not mention yet (native memory reads that index). */
function indexNewNotes(localDir, files) {
    if (!files.length) return 0;
    const indexPath = path.join(localDir, 'MEMORY.md');
    let text = '';
    try { text = fs.readFileSync(indexPath, 'utf8'); } catch { /* new index */ }
    const lines = [];
    for (const file of files) {
        if (text.includes(`(${file})`)) continue;
        let note;
        try { note = fs.readFileSync(path.join(localDir, file), 'utf8'); } catch { continue; }
        const { fm } = splitFrontmatter(note);
        const name = fmValue(fm, 'name') || file.slice(0, -3);
        const desc = fmValue(fm, 'description').replace(/\s+/g, ' ');
        lines.push(`- [${name}](${file})${desc ? ` — ${desc}` : ''}`);
    }
    if (!lines.length) return 0;
    fs.mkdirSync(localDir, { recursive: true });
    fs.appendFileSync(indexPath, `${text && !text.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
    return lines.length;
}

/**
 * Carry out a plan. Updates and returns the new `base`. `dryRun` writes nothing.
 * @returns {{base: object, pushed: string[], pulled: string[], conflicts: object[], secrets: object[], same: number, indexed: number}}
 */
function apply({ actions, local, tracked, base = {}, localDir, trackedDir, backupDir, dryRun = false }) {
    const next = { ...base };
    const res = { base: next, pushed: [], pulled: [], conflicts: [], secrets: [], same: 0, indexed: 0 };
    for (const a of actions) {
        if (a.op === 'same') { res.same++; next[a.name] = local[a.name].sha; continue; }
        if (a.op === 'conflict') { res.conflicts.push(a); continue; }
        if (a.op === 'secret') { res.secrets.push(a); continue; }
        if (a.op === 'push') {
            if (!dryRun) writeAtomic(path.join(trackedDir, a.name), local[a.name].text);
            next[a.name] = local[a.name].sha;
            res.pushed.push(a.name);
        } else {
            if (!dryRun) {
                // Back up whenever a different local copy is about to be replaced. "Local still equals the base" does not make it
                // safe to lose: a base recorded from another worktree's mirror can be newer than this mirror (the only copy of
                // that newer text may be the local file).
                if (local[a.name] && local[a.name].sha !== tracked[a.name].sha && backupDir) writeAtomic(path.join(backupDir, `${a.name.slice(0, -3)}.${local[a.name].sha.slice(0, 8)}.md`), local[a.name].text);
                writeAtomic(path.join(localDir, a.name), tracked[a.name].text);
            }
            next[a.name] = tracked[a.name].sha;
            res.pulled.push(a.name);
        }
    }
    if (!dryRun) res.indexed = indexNewNotes(localDir, res.pulled.filter(n => !local[n]));
    return res;
}

// One base per tracked dir (sync-<sha1 of the resolved path>.json). Without a tracked dir the legacy single `sync.json` is used.
const baseFile = (stateDir, trackedDir) => path.join(stateDir, trackedDir ? `sync-${sha1(path.resolve(trackedDir)).slice(0, 12)}.json` : 'sync.json');
function loadBase(stateDir, trackedDir) {
    try { const j = JSON.parse(fs.readFileSync(baseFile(stateDir, trackedDir), 'utf8')); return j && typeof j.base === 'object' && j.base ? j.base : {}; } catch { return {}; }
}
function saveBase(stateDir, base, trackedDir) { writeAtomic(baseFile(stateDir, trackedDir), JSON.stringify({ at: new Date().toISOString(), base }, null, 1)); }

/**
 * One full sync pass. Returns apply()'s result plus the plan.
 * @param {{localDir: string, trackedDir: string, stateDir: string, direction?: string, prefer?: string|null, dryRun?: boolean, isSecret?: Function}} o
 */
function sync(o) {
    const { localDir, trackedDir, stateDir, direction = 'both', prefer = null, dryRun = false, isSecret } = o;
    const local = readNotes(localDir), tracked = readNotes(trackedDir);
    const base = loadBase(stateDir, trackedDir);
    const actions = plan({ local, tracked, base, direction, prefer, isSecret });
    const res = apply({ actions, local, tracked, base, localDir, trackedDir, backupDir: path.join(stateDir, 'sync-backup'), dryRun });
    if (!dryRun) saveBase(stateDir, res.base, trackedDir);
    return { ...res, actions };
}

/**
 * The opt-in automatic pass the hooks run (MEMORY_SYNC=on): pull at session start, push at session end. Never throws, never
 * touches git or the network, returns null when sync is off or anything goes wrong.
 * @param {{direction: 'push'|'pull', fallbackDir: string, env?: object, isSecret?: Function}} o
 */
function autoSync({ direction, fallbackDir, env = process.env, isSecret }) {
    try {
        const { notesContext, syncEnabled } = require('./memory-context');
        if (!syncEnabled(env)) return null;
        const ctx = notesContext(fallbackDir, env);
        return sync({ localDir: ctx.memoryDir, trackedDir: ctx.trackedNotesDir, stateDir: ctx.stateDir, direction, isSecret });
    } catch { return null; }
}

module.exports = { autoSync, isNoteFile, readNotes, plan, apply, sync, indexNewNotes, loadBase, saveBase, baseFile };
