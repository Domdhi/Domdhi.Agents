#!/usr/bin/env node
'use strict';

/**
 * Owner-run pin of one reviewed value: `secret-scanner.cjs --pin <path>:<line> [--rev <commit>] [--reason <text>]`.
 *
 * The git hooks' block report names a generic finding by location and prints this command; it never prints the
 * value or a digest of it. An unsalted SHA-256 beside a redacted preview ("Zx9Q***") is an offline verifier for a
 * short secret, and a hook's stderr goes back into the agent transcript, CI logs and scrollback. So the digest is
 * computed here, from the file, and written straight to `.betterleaksignore` as a `value-sha256:` entry; nothing
 * this module prints contains the value or the hash.
 *
 * What it pins: the generic findings the engine reports at `<path>:<line>` (a path from the report, relative to
 * the repository root; `--rev` reads that path from a commit instead of the work tree, which is what a push
 * blocked by an older commit needs). Named-provider findings are never pinned: a provider key is not a reviewed
 * false positive. The entry is the same one the scans read (`value-sha256:<64 hex> # reason`, see
 * secret-engine.cjs parseIgnore) and counts once `.betterleaksignore` is part of a commit.
 *
 * The decision stays the owner's, as it is for `betterleaks:allow`: run it in your own terminal after reviewing
 * the value. The file is read-only to the agent's Write/Edit tools; nothing here can be reached from a hook.
 *
 * Exit codes (via main): 0 pinned or already listed, 1 nothing to pin or any fault, 2 usage.
 */

const fs = require('fs');
const path = require('path');
const { isHardSkipPath, isTestFilePath, scanContent, isEngineError, installHint } = require('./secret-patterns.cjs');
const engine = require('./secret-engine.cjs');
const gitScan = require('./secret-git-scan.cjs');

const IGNORE_FILE = '.betterleaksignore';

class PinError extends Error {}

const USAGE = 'Usage: secret-scanner.cjs --pin <path>:<line> [--rev <commit>] [--reason <text>]\n' +
    '  <path>:<line> is the location the block report names (path relative to the repository root).\n' +
    '  --rev reads the path from that commit instead of the work tree (a push blocked by an older commit).';

// Safe to paste into a POSIX shell or PowerShell unquoted; anything else is single-quoted (a quote inside is
// doubled in PowerShell and closed-escaped-reopened in a POSIX shell).
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quoteInner = value => (process.platform === 'win32' ? value.replace(/'/g, "''") : value.replace(/'/g, "'\\''"));
const shellArg = value => (SHELL_SAFE.test(value) ? value : `'${quoteInner(String(value))}'`);

/**
 * The command the block report prints for one finding. `scannerFile` is the running secret-scanner.cjs; it is
 * shown relative to the repository root when it lives inside it. `loc` is { path, commit|null }.
 */
function pinCommand(root, scannerFile, loc, line) {
    if (!loc || typeof loc.path !== 'string' || !loc.path || !(line > 0)) return null;
    let script = path.relative(root, scannerFile).split(path.sep).join('/');
    if (!script || script.startsWith('..') || path.isAbsolute(script)) script = scannerFile;
    return `node ${shellArg(script)} --pin ${shellArg(`${loc.path}:${line}`)}${loc.commit ? ` --rev ${loc.commit}` : ''}`;
}

function parseSpec(spec) {
    const m = /^(.+):(\d+)$/s.exec(String(spec));
    if (!m || Number(m[2]) < 1) throw new PinError(`"${spec}" is not <path>:<line>`);
    let rel = m[1];
    if (path.sep === '\\') rel = rel.replace(/\\/g, '/');
    if (rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').some(part => part === '..')) {
        throw new PinError('the path must be relative to the repository root and stay inside it');
    }
    return { rel, line: Number(m[2]) };
}

/** The bytes of `rel`: from `rev` when given, else the work tree (a regular file inside the root, never a link). */
function readSource(root, rel, rev) {
    if (rev) {
        if (!/^[0-9a-f]{7,64}$/i.test(rev)) throw new PinError(`--rev "${rev}" is not a commit id`);
        const [object] = gitScan.catBatch(root, [`${rev}:${rel}`]);
        if (!object || object.missing || object.type !== 'blob') throw new PinError(`${rel} is not a file at ${rev}`);
        return object.content;
    }
    const file = path.join(root, rel);
    let stat;
    try { stat = fs.lstatSync(file); } catch { throw new PinError(`${rel} does not exist in the work tree (for a value that only older commits hold, add --rev <commit>)`); }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new PinError(`${rel} is not a regular file`);
    return fs.readFileSync(file);
}

/** The existing ignore file as text ('' when absent). A link, or a UTF-16 file an append would corrupt, is refused. */
function readIgnoreFile(file) {
    let stat;
    try { stat = fs.lstatSync(file); } catch { return ''; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new PinError(`${IGNORE_FILE} is not a regular file`);
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) throw new PinError(`${IGNORE_FILE} is not UTF-8 (it holds NUL bytes, e.g. UTF-16 from PowerShell's >>): convert it to UTF-8 first`);
    return bytes.toString('utf8');
}

/**
 * Pin the generic value(s) at `spec` (`<path>:<line>`). Returns { file, rel, line, added, already }.
 * Throws PinError (a message that never carries a value or a hash) or an engine error.
 *
 * @param {string} root repository root
 * @param {string} spec `<path>:<line>`
 * @param {{ rev?: string, reason?: string, now?: Date }} [options]
 */
function pinValues(root, spec, { rev, reason, now } = {}) {
    const { rel, line } = parseSpec(spec);
    if (isHardSkipPath(rel)) throw new PinError(`${rel} is never scanned, so there is nothing to pin`);
    const text = readSource(root, rel, rev).toString('utf8');
    const atLine = scanContent(text, rel, { namedProvidersOnly: isTestFilePath(rel) }).filter(f => f.type === 'SECRET_PATTERN' && f.line === line);
    const keys = [...new Set(atLine.filter(f => f.allowKey).map(f => f.allowKey))];
    if (!keys.length) {
        throw new PinError(atLine.length
            ? `${rel}:${line} holds only a named-provider finding (a provider key); those are never pinned. Remove it and use an environment variable or a secret manager.`
            : `no generic finding at ${rel}:${line}${rev ? ` in ${rev}` : ''}: check the path and line against the report`);
    }

    const file = path.join(root, IGNORE_FILE);
    const existing = readIgnoreFile(file);
    const listed = engine.parseIgnore(existing);
    const fresh = keys.filter(key => !listed.has(key));
    if (fresh.length) {
        const eol = existing.includes('\r\n') ? '\r\n' : '\n';
        const note = String(reason == null ? '' : reason).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200)
            || `reviewed ${(now || new Date()).toISOString().slice(0, 10)}`;
        const lead = existing && !existing.endsWith('\n') ? eol : '';
        fs.appendFileSync(file, lead + fresh.map(key => `${key} # ${note}${eol}`).join(''), 'utf8');
    }
    return { file, rel, line, added: fresh.length, already: keys.length - fresh.length };
}

function parseArgs(args) {
    const flags = { '--pin': 'spec', '--rev': 'rev', '--reason': 'reason' };
    const out = {};
    for (let i = 0; i < args.length; i++) {
        const key = flags[args[i]];
        const value = args[i + 1];
        if (!key || value === undefined || value.startsWith('--') || out[key] !== undefined) return null;
        out[key] = value;
        i++;
    }
    return out.spec ? out : null;
}

/** The CLI body: prints a result that never contains the value or its hash, returns the exit code. */
function main(args, { cwd = process.cwd() } = {}) {
    const parsed = parseArgs(args);
    if (!parsed) { console.error(USAGE); return 2; }
    try {
        const root = gitScan.toplevel(cwd);
        const r = pinValues(root, parsed.spec, { rev: parsed.rev, reason: parsed.reason });
        console.log(`Pinned ${r.added} value(s) from ${r.rel}:${r.line} in ${IGNORE_FILE}${r.already ? ` (${r.already} already listed)` : ''}. The value and its hash were not printed.`);
        console.log(`The entry counts once ${IGNORE_FILE} is part of a commit: git add ${IGNORE_FILE}, then commit it.`);
        return 0;
    } catch (err) {
        if (err instanceof PinError || err instanceof gitScan.GitScanError) {
            console.error(`[secret-scanner] --pin: ${err.message}`);
        } else if (isEngineError(err)) {
            console.error(`[secret-scanner] FAIL-CLOSED: the secret engine could not scan the file.\n  ${err.message}${err.code === 'ENGINE_UNAVAILABLE' ? `\n  ${installHint()}` : ''}`);
        } else {
            console.error(`[secret-scanner] --pin: unexpected error (${err && err.message ? err.message : err}).`);
        }
        return 1;
    }
}

module.exports = { PinError, IGNORE_FILE, pinCommand, parseSpec, pinValues, main };
