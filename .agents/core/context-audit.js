#!/usr/bin/env node
'use strict';

// Read-only instruction inventory. Sizes are LF-normalized UTF-16 code units,
// not tokenizer output, runtime context usage or billing measurements.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { assertNoSymlinkedAncestor } = require('./_lib/fs-safe');

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 5000;
const MAX_PATH_CHARS = 1024;
// JSON can escape one path character into six bytes; allow a full inventory
// plus each row's fixed metrics while keeping baseline reads finite.
const MAX_BASELINE_BYTES = MAX_FILES * (6 * MAX_PATH_CHARS + 1024);
const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = text => text.replace(/\r\n/g, '\n');

function validatedRoot(value) {
    const root = path.resolve(value);
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid audit root');
    assertNoSymlinkedAncestor(path.join(root, '__audit_probe__'), path.parse(root).root);
    return root;
}

function checked(root, relative) {
    if (typeof relative !== 'string' || !relative || relative.length > MAX_PATH_CHARS || path.isAbsolute(relative)
        || /^[A-Za-z]:/.test(relative) || relative.includes(':') || relative.includes('\\')
        || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Expected a checkout-relative path with forward slashes');
    }
    const target = path.resolve(root, relative);
    assertNoSymlinkedAncestor(target, root);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('Linked audit input refused: ' + relative);
    return { target, stat };
}

function read(root, relative, maxBytes = MAX_BYTES) {
    const { target, stat } = checked(root, relative);
    if (!stat?.isFile() || stat.size > maxBytes) throw new Error('Missing, non-file or oversized audit input: ' + relative);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        // Bound the actual read as well as the initial stat, including a growing file.
        const bytes = Buffer.alloc(stat.size + 1);
        let size = 0, count;
        do { count = fs.readSync(fd, bytes, size, bytes.length - size, null); size += count; }
        while (count && size < bytes.length);
        if (size !== stat.size) throw new Error('Audit input changed during read: ' + relative);
        const buffer = bytes.subarray(0, size);
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
        catch { throw new Error('Non-UTF-8 audit input: ' + relative); }
        return { buffer, text };
    } finally { fs.closeSync(fd); }
}

function inventory(root) {
    const files = [];
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.agents/startup.md', '.agents/startup-reference.md']) {
        if (checked(root, file).stat) files.push(file);
    }
    for (const directory of ['.agents/roles', '.agents/skills']) {
        const { target, stat } = checked(root, directory);
        if (!stat) continue;
        if (!stat.isDirectory()) throw new Error('Invalid instruction directory: ' + directory);
        for (const name of fs.readdirSync(target).sort()) {
            const relative = directory + '/' + name;
            const entry = checked(root, relative);
            if (directory.endsWith('/roles')) {
                if (entry.stat?.isFile() && name.endsWith('.md')) files.push(relative);
            } else if (entry.stat?.isDirectory()) {
                const file = relative + '/SKILL.md';
                if (checked(root, file).stat) files.push(file);
            }
            if (files.length > MAX_FILES) throw new Error('Instruction inventory exceeds the file limit');
        }
    }
    return files;
}

function audit({ root = path.resolve(__dirname, '../..'), files, baseline, maxChars } = {}) {
    root = validatedRoot(root);
    if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || maxChars < 1)) throw new Error('Invalid character budget');
    const selected = files === undefined ? inventory(root) : files;
    if (!Array.isArray(selected) || !selected.length || selected.length > MAX_FILES
        || selected.some(file => typeof file !== 'string')
        || new Set(selected.map(file => file.toLowerCase())).size !== selected.length) throw new Error('Invalid or empty instruction inventory');
    const measured = [...selected].sort().map(file => {
        const { buffer, text } = read(root, file);
        const normalized = normalize(text);
        return { path: file, bytes: buffer.length, characters: normalized.length,
            estimatedTokens: Math.ceil(normalized.length / 4), rawSha256: hash(buffer),
            normalizedSha256: hash(normalized), withinBudget: maxChars === undefined || normalized.length <= maxChars };
    });
    const changes = { added: [], missing: [], changed: [], lineEndingsOnly: [] };
    if (baseline !== undefined) {
        if (!baseline || baseline.schemaVersion !== 1 || !Array.isArray(baseline.files) || !baseline.files.length
            || baseline.files.length > MAX_FILES) throw new Error('Invalid audit baseline');
        const previous = new Map(), names = new Set();
        for (const row of baseline.files) {
            if (!row || typeof row.path !== 'string' || names.has(row.path.toLowerCase())
                || !/^[a-f0-9]{64}$/.test(row.rawSha256) || !/^[a-f0-9]{64}$/.test(row.normalizedSha256)) throw new Error('Invalid audit baseline entry');
            checked(root, row.path);
            names.add(row.path.toLowerCase());
            previous.set(row.path, row);
        }
        for (const row of measured) {
            const prior = previous.get(row.path);
            if (!prior) changes.added.push(row.path);
            else if (prior.rawSha256 !== row.rawSha256) {
                changes.changed.push(row.path);
                if (prior.normalizedSha256 === row.normalizedSha256) changes.lineEndingsOnly.push(row.path);
            }
            previous.delete(row.path);
        }
        changes.missing = [...previous.values()].map(row => row.path).sort();
    }
    return { schemaVersion: 1, measurement: 'LF-normalized UTF-16 code units; characters / 4 is a heuristic, not runtime usage or billing',
        files: measured, totalCharacters: measured.reduce((sum, row) => sum + row.characters, 0),
        maxChars: maxChars ?? null, changes,
        ok: measured.every(row => row.withinBudget) && !changes.added.length && !changes.missing.length && !changes.changed.length };
}

function main(args = process.argv.slice(2)) {
    try {
        const options = {}, files = [], seen = new Set();
        let baselinePath;
        for (let index = 0; index < args.length; index += 2) {
            const flag = args[index], value = args[index + 1];
            if (!['--root', '--file', '--baseline', '--max-chars'].includes(flag) || !value || value.startsWith('--')
                || (flag !== '--file' && seen.has(flag))) throw new Error('Usage: context-audit.js [--root path] [--file relative-path] [--baseline relative-json] [--max-chars positive-integer]');
            seen.add(flag);
            if (flag === '--root') options.root = path.resolve(value);
            if (flag === '--file') files.push(value);
            if (flag === '--baseline') baselinePath = value;
            if (flag === '--max-chars') {
                if (!/^[1-9][0-9]*$/.test(value)) throw new Error('Invalid character budget');
                options.maxChars = Number(value);
            }
        }
        options.root = validatedRoot(options.root || path.resolve(__dirname, '../..'));
        if (files.length) options.files = files;
        if (baselinePath) {
            const input = read(options.root, baselinePath, MAX_BASELINE_BYTES).text;
            try { options.baseline = JSON.parse(input); } catch { throw new Error('Invalid baseline JSON'); }
        }
        const result = audit(options);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return result.ok ? 0 : 1;
    } catch (error) { console.error('[context-audit] ' + error.message); return 2; }
}

module.exports = { audit, inventory, main };
if (require.main === module) process.exitCode = main();
