#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { classifySharedFile, classifyClaudeFile } = require('./_lib/zone-classifier');
const { safeDelete, assertNoSymlinkedAncestor } = require('./_lib/fs-safe');
const { hasProjectAdditions } = require('./_lib/skill-merger');

const STATE_PATH = '.agents/render-state.json';
const ROOTS = ['.agents', '.claude', '.codex'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validatePath(rel) {
    // Reject aliases on every platform, including NTFS streams/device names.
    if (typeof rel !== 'string' || !rel || /[\\:<>|"?*\x00-\x1f\x7f]/.test(rel)
        || rel.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)
            || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) {
        throw new Error(`unsafe ledger path: ${JSON.stringify(rel)}`);
    }
}

function assertRoot(target) {
    for (let dir = target; ; dir = path.dirname(dir)) {
        const stat = fs.lstatSync(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('target or its ancestor is not a real directory');
        if (dir === path.dirname(dir)) break;
    }
}

function linkInPath(target, rel) {
    let current = target;
    for (const part of rel.split('/')) {
        current = path.join(current, part);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stat) return false;
        if (stat.isSymbolicLink()) return true;
        if (!stat.isDirectory() && current !== path.join(target, rel)) return false;
    }
    return false;
}

function templateOwned(rel) {
    if (rel.split('/').some(p => /(?:^|\.)local(?:\.|$)/i.test(p)
        || ['__tests__', '_helpers', 'node_modules', '.git'].includes(p))) return false;
    if (rel.startsWith('.agents/')) return classifySharedFile(rel) === 'template';
    if (rel.startsWith('.claude/')) return classifyClaudeFile(rel.slice(8)) === 'template';
    // Codex roles and hook registration/configuration are project or mixed files.
    if (/^\.codex\/(core|hooks)\//.test(rel)) return classifyClaudeFile(rel.slice(7)) === 'template';
    return false;
}

function textDigest(rel, bytes) {
    if (bytes.includes(0)) return null;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
    return sha256(text.replace(/\r\n/g, '\n'));
}

function readRegular(target, rel, stat) {
    const file = path.join(target, rel);
    assertNoSymlinkedAncestor(file, target);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink > 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
            throw new Error(`file changed while reading: ${rel}`);
        }
        return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
}

function inventoryPaths(root) {
    const paths = new Set();
    function walk(rel) {
        const stat = fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false });
        if (!stat) return;
        if (!stat.isDirectory() || stat.isSymbolicLink()) { paths.add(rel); return; }
        for (const name of fs.readdirSync(path.join(root, rel))) {
            if (['.git', 'node_modules', 'agent-memory', '.state'].includes(name)) paths.add(`${rel}/${name}`);
            else walk(`${rel}/${name}`);
        }
    }
    for (const dir of ROOTS) walk(dir);
    return paths;
}

function sourceInventory(source) {
    const files = new Map();
    const paths = inventoryPaths(source);
    for (const rel of [...paths].sort()) {
        const stat = fs.lstatSync(path.join(source, rel));
        if (stat.isSymbolicLink()) throw new Error(`symlinked source path: ${rel}`);
        if (!stat.isFile() || !templateOwned(rel)) continue;
        if (stat.nlink > 1) throw new Error(`hardlinked source file: ${rel}`);
        const bytes = readRegular(source, rel, stat);
        const canonical = rel.replace(/^\.(claude|codex)\//, '.agents/');
        // These exact renderer branches produce strings. Other assets are raw
        // Buffers even when named .txt/.md or containing valid printable UTF-8.
        const wrapper = /^\.(claude|codex)\/(core|hooks)\/.+\.(js|cjs)$/.test(rel)
            || /^\.claude\/templates\/.+\.(js|cjs)$/.test(rel);
        const normalize = wrapper && paths.has(canonical)
            && bytes.toString('utf8').includes(`// Generated compatibility entry point from ${canonical}.`);
        files.set(rel, { raw: sha256(bytes), text: normalize ? textDigest(rel, bytes) : null });
    }
    if (!files.size) throw new Error('source contains no template files');
    return files;
}

function inspect(target, rel, digest, shipped) {
    if (rel === STATE_PATH) return 'project-owned';
    if (linkInPath(target, rel)) return 'symlink';
    const file = path.join(target, rel);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return 'missing';
    if (!stat.isFile()) return 'not-file';
    if (stat.nlink > 1) return 'hardlink';
    if (!digest) return 'unrecorded';
    if (!templateOwned(rel)) return 'project-owned';
    const bytes = readRegular(target, rel, stat);
    // A renderer can record a merged projection; reuse its fence-aware parser
    // so documentation examples do not masquerade as personal additions.
    if (/\.md$/i.test(rel) && hasProjectAdditions(bytes.toString('utf8'))) return 'project-additions';
    const raw = sha256(bytes);
    const original = shipped.get(rel);
    const text = original?.text ? textDigest(rel, bytes) : null;
    if (raw !== digest && (!text || text !== digest)) return 'edited';
    if (!shipped.has(rel)) return 'not-shipped';
    if (raw !== original.raw && (!text || text !== original.text)) return 'different-source';
    return null;
}

function approvalId(plan) {
    return sha256(JSON.stringify({ version: plan.version, target: plan.target,
        stateDigest: plan.stateDigest, source: plan.source, sourceDigest: plan.sourceDigest, removable: plan.removable }));
}

/** Read-only inventory. Never follow links, rewrite state or infer ownership from absence. */
function planUninstall(target, { source = path.resolve(__dirname, '../..') } = {}) {
    target = path.resolve(target);
    source = path.resolve(source);
    assertRoot(target);
    assertRoot(source);
    // Resolve platform aliases (including Windows short paths) only after
    // rejecting links, so aliases cannot hide an overlapping source/target.
    target = fs.realpathSync.native(target);
    source = fs.realpathSync.native(source);
    const within = (a, b) => { const rel = path.relative(a, b); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
    if (within(source, target) || within(target, source)) throw new Error('source and target must be separate, non-overlapping trees');
    const shipped = sourceInventory(source);
    if (linkInPath(target, STATE_PATH)) throw new Error('symlinked render-state ledger');
    const stateFile = path.join(target, STATE_PATH);
    if (!fs.lstatSync(stateFile).isFile()) throw new Error('render-state ledger is not a regular file');
    const stateBytes = fs.readFileSync(stateFile);
    const state = JSON.parse(stateBytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!record(state)) throw new Error('render-state ledger must be an object');
    const paths = inventoryPaths(target);
    paths.add(STATE_PATH);
    const aliases = new Set();
    for (const [rel, digest] of Object.entries(state)) {
        validatePath(rel);
        if (!validDigest(digest)) throw new Error(`invalid digest for ${rel}`);
        const alias = rel.toLowerCase();
        if (aliases.has(alias)) throw new Error(`aliased ledger path: ${rel}`);
        aliases.add(alias);
        paths.add(rel);
    }
    for (const rel of ['AGENTS.md', 'CLAUDE.md', '.gitignore']) {
        if (fs.lstatSync(path.join(target, rel), { throwIfNoEntry: false })) paths.add(rel);
    }
    const plan = { version: 1, target, source, sourceDigest: sha256(JSON.stringify([...shipped])),
        stateDigest: sha256(stateBytes), removable: [], kept: [] };
    for (const rel of [...paths].sort()) {
        const digest = Object.hasOwn(state, rel) ? state[rel] : undefined;
        const reason = inspect(target, rel, digest, shipped);
        if (reason) plan.kept.push({ path: rel, reason });
        else plan.removable.push({ path: rel, digest });
    }
    plan.planId = approvalId(plan);
    return plan;
}

function validateApproval(plan, approved) {
    if (!record(approved) || approved.version !== 1 || !Array.isArray(approved.removable)
        || approved.target !== plan.target || approved.stateDigest !== plan.stateDigest
        || approved.source !== plan.source || approved.sourceDigest !== plan.sourceDigest
        || approved.planId !== approvalId(approved)) throw new Error('reviewed plan missing, malformed or changed');
    const expected = [];
    const seen = new Set();
    for (const item of approved.removable) {
        if (!record(item)) throw new Error('malformed reviewed candidate');
        validatePath(item.path);
        if (!validDigest(item.digest) || seen.has(item.path)) throw new Error('malformed reviewed candidate');
        seen.add(item.path);
        // Repeat application is safe only when a formerly approved file is absent.
        const missing = plan.kept.some(x => x.path === item.path && x.reason === 'missing');
        if (!missing) expected.push(item);
    }
    if (JSON.stringify(expected) !== JSON.stringify(plan.removable)) throw new Error('reviewed candidates changed; run a new dry-run');
}

/** A refusal occurs before mutation. I/O errors report actual removed paths. */
function runUninstall({ target = '.', source, dryRun = true, approvedPlan } = {}) {
    const result = { ok: false, dryRun, removed: [] };
    try {
        let plan = planUninstall(target, { source });
        result.plan = plan;
        if (dryRun) { result.ok = true; return result; }
        validateApproval(plan, approvedPlan);
        // Recheck the complete set before touching its first file.
        plan = planUninstall(target, { source });
        validateApproval(plan, approvedPlan);
        const shipped = sourceInventory(plan.source);
        if (sha256(JSON.stringify([...shipped])) !== plan.sourceDigest) throw new Error('source changed before deletion');
        for (const item of plan.removable) {
            assertRoot(plan.target);
            if (inspect(plan.target, item.path, item.digest, shipped) !== null) throw new Error(`candidate changed: ${item.path}`);
            safeDelete(path.join(plan.target, item.path), plan.target);
            result.removed.push(item.path);
        }
        result.ok = true;
    } catch (err) { result.error = err.message; }
    return result;
}

function main(argv = process.argv.slice(2)) {
    try {
        let target, source, review, dryRun = true, preview = false;
        for (let i = 0; i < argv.length; i++) {
            const arg = argv[i];
            if (arg === '--dry-run' && !preview) preview = true;
            else if (arg === '--source' && !source && argv[i + 1] && !argv[i + 1].startsWith('--')) source = argv[++i];
            else if (arg === '--apply' && !review && argv[i + 1] && !argv[i + 1].startsWith('--')) {
                review = argv[++i]; dryRun = false;
            } else if (arg.startsWith('--') || target) throw new Error(`invalid argument: ${arg}`);
            else target = arg;
        }
        if (preview && review) throw new Error('--dry-run and --apply are mutually exclusive');
        const approvedPlan = review ? JSON.parse(fs.readFileSync(review, 'utf8').replace(/^\uFEFF/, '')) : undefined;
        const result = runUninstall({ target: target || '.', source, dryRun, approvedPlan });
        if (!result.ok) throw new Error(`${result.error}; removed ${result.removed.length} files: ${JSON.stringify(result.removed)}`);
        console.log(JSON.stringify(dryRun ? result.plan : { ok: true, removed: result.removed }, null, 2));
        return result;
    } catch (err) {
        console.error(`uninstall: ${err.message}`);
        process.exitCode = 1;
        return { ok: false, error: err.message };
    }
}

if (require.main === module) main();
module.exports = { planUninstall, runUninstall, main };
