#!/usr/bin/env node
'use strict';

/**
 * Secret Engine — thin synchronous wrapper around the pinned Betterleaks binary.
 *
 * secret-patterns.cjs re-exports scanContent / redactSecretsInText from here, so every consumer
 * (the Write/Edit hook, the commit scan, the output scrubber, secret-safe-write, intake)
 * sees the same finding shape and redaction markers the retired regex engine produced:
 *
 *   scanContent(content, filePath, { namedProvidersOnly, wholeFile, honorMarkers })
 *       -> [{ type, name, file, line, match }]   (match is already redacted)
 *   redactSecretsInText(content, filePath, { namedProvidersOnly })
 *       -> text with <REDACTED:Name> markers
 *
 * Detection rules live in ../config/secret-engine.toml (built-in Betterleaks rules plus the
 * domdhi-* rules). Version, binary hashes and display names live in ../config/secret-engine.json.
 *
 * FAIL CLOSED: a missing or unverified engine throws EngineUnavailableError; a failing, timing-out,
 * malformed or input-skipping engine run throws EngineFailedError. Neither is ever read as "no
 * findings". The callers that must never block (the output scrubber, secret-safe-write, the local
 * capture in intake) catch these two and fall back to the named-provider regex list in
 * secret-patterns.cjs.
 *
 * FOUR THINGS THE ENGINE DOES THAT THIS FILE UNDOES:
 *  1. It silently skips stdin that sniffs as a binary file (a zip, bzip2, rar, ar, cab, pdf, rtf,
 *     sqlite, tar ... signature at the right offset), so text that merely STARTS with such bytes
 *     was never scanned. The engine logs the number of bytes it scanned; a run that scanned fewer
 *     than it was given is repeated with one neutral leading newline (every signature sits at a
 *     fixed offset, so the content cannot match at offset k and k+1), line numbers are mapped
 *     back, and a second skip fails closed.
 *  2. It honors "betterleaks:allow" anywhere on a line, inside strings, and on any line of a
 *     multi-line finding. The engine's own handling is switched off and the marker rule is
 *     applied here, so it is a trailing comment on the same physical line, for one secret.
 *  3. It reads .betterleaksignore / .gitleaksignore from its working directory (and from the scanned
 *     directory). It runs in an empty directory of ours and is never given an ignore file at all: the
 *     project's .betterleaksignore is applied HERE, in Node, from the INDEX (its staged version, falling
 *     back to HEAD) and never from the working tree, so a suppression only counts once it is itself part
 *     of what is reviewed and committed (an untracked or unstaged edit suppresses nothing). It applies to
 *     whole-file scans only (an Edit fragment restarts its line numbers).
 *  4. It refuses binary files by signature or content type (an OOXML/zip/pdf/gzip/sqlite/tar file), logging a skip or
 *     nothing at all, and quits reading a refused input early: a big write into its pipe then fails with EPIPE while it
 *     exits 0 and says "scanned ~0 bytes". That EPIPE is recognised as the skip it is (any other early exit is a failure)
 *     and the file is scanned through its text projection (textProjection), in one batch when many were refused.
 *
 * Per-call cost is one process start (about 30 ms on a clean input). There is deliberately no
 * prefilter in front of it: nothing here can decide that a scan may be skipped.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const binLib = require('../core/_lib/secret-engine-bin');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'secret-engine.toml');

class EngineFailedError extends Error {
    constructor(message, detail) {
        super(message);
        this.name = 'EngineFailedError';
        this.code = 'ENGINE_FAILED';
        this.detail = detail || null;
    }
}

// secret-patterns.cjs requires this module at its end; requiring it back lazily avoids a load-time cycle.
const patterns = () => require('./secret-patterns.cjs');

let tables = null;
let timeoutOverride = 0;
function pinTables() {
    if (tables) return tables;
    const pins = binLib.loadPins();
    const fixed = Number(pins.timeoutMs) > 0 ? Number(pins.timeoutMs) : 10000;
    tables = {
        // The timeout is fixed. No environment variable changes it: a short one would send the redactor to
        // the weaker fallback list. A test shrinks it through setTimeoutForTests, which only code inside the
        // process can call.
        timeoutMs: timeoutOverride > 0 ? timeoutOverride : fixed,
        generic: new Set(pins.genericRuleIds || []),
        names: new Map(pins.ruleNames || []),
    };
    return tables;
}

/** True for a rule that is a generic credential-shape rule rather than a named provider. */
function isGenericRule(ruleId) {
    return pinTables().generic.has(ruleId);
}

/** True for the display name of a generic credential rule (what a person may review and mark as a false positive). */
function isGenericName(name) {
    const { generic, names } = pinTables();
    if (/^(?:Password|Secret) Assignment(?: \(Unquoted\))?$/.test(name)) return true;
    for (const id of generic) if (names.get(id) === name) return true;
    return false;
}

const ACRONYMS = { api: 'API', pat: 'PAT', tf: 'TF', jwt: 'JWT', url: 'URL', uri: 'URI', id: 'ID', aws: 'AWS', gcp: 'GCP', sas: 'SAS', ssh: 'SSH', sql: 'SQL', oauth: 'OAuth', npm: 'npm', pypi: 'PyPI', cli: 'CLI', ci: 'CI', ai: 'AI', db: 'DB', rsa: 'RSA', pgp: 'PGP', sdk: 'SDK', ip: 'IP', sso: 'SSO', ldap: 'LDAP' };

/** "hashicorp-tf-password" -> "Hashicorp TF Password": a readable name for a built-in rule with no mapping. */
function titleCase(ruleId) {
    return String(ruleId).replace(/\.\d+$/, '').split('-').filter(Boolean)
        .map(w => ACRONYMS[w.toLowerCase()] || w[0].toUpperCase() + w.slice(1)).join(' ');
}

function displayName(raw) {
    const { names } = pinTables();
    const id = raw.RuleID;
    if (id === 'domdhi-secret-line' || id.startsWith('domdhi-credential-literal')) {
        const head = String(raw.Match || '').split(/[=:]/)[0];
        const kind = /passw|pwd/i.test(head) ? 'Password Assignment' : 'Secret Assignment';
        return id === 'domdhi-secret-line' ? `${kind} (Unquoted)` : kind;
    }
    if ((id === 'domdhi-private-key-block' || id === 'private-key') && /PGP PRIVATE KEY BLOCK/.test(raw.Secret)) return 'PGP Private Key';
    return names.get(id) || titleCase(id);
}

function getProjectRoot() {
    return process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.env.AGENTS_PROJECT_DIR
        || path.resolve(__dirname, '..', '..');
}

// The path the engine sees: relative to the project root with forward slashes, so a
// .betterleaksignore fingerprint ("src/a.js:rule:12") is the same on every machine.
function attributePath(filePath, root) {
    if (!filePath || typeof filePath !== 'string' || filePath.startsWith('<')) return null;
    let p = filePath;
    if (path.isAbsolute(p)) {
        const rel = path.relative(root, p);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) p = rel;
    }
    return p.replace(/\\/g, '/');
}

// The engine reads ignore files from its working directory in addition to the path it is given, so
// it runs in a directory that is ours, owned by the user and empty of those files.
function neutralCwd() {
    const dir = path.join(binLib.cacheRoot(), 'betterleaks', 'cwd');
    try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const unsafe = binLib.unsafeOwnership(dir);
        if (unsafe) throw new Error(unsafe);
        for (const name of ['.betterleaksignore', '.gitleaksignore']) {
            if (fs.existsSync(path.join(dir, name))) throw new Error(`${name} found in the engine working directory`);
        }
    } catch (err) {
        throw new EngineFailedError('secret engine working directory is not usable', { reason: 'cwd', detail: err.message });
    }
    return dir;
}

function engineArgs(filePath, root, ignoreFile) { // ignoreFile: always the empty no-ignore path (see header, point 3)
    const args = ['stdin', '--no-banner', '--no-color', '--exit-code', '0', '--report-format', 'json', '--report-path', '-',
        // info level prints "scanned ~N bytes (M bytes)", which is how a skipped input is noticed.
        '--log-level', 'info', '--config', CONFIG_PATH,
        // The allow marker is applied in Node (applyAllowMarkers), under stricter rules than the engine's.
        '--ignore-gitleaks-allow',
        '--gitleaks-ignore-path', ignoreFile];
    const attr = attributePath(filePath, root);
    if (attr) args.push('--set-attr', `path=${attr}`);
    return args;
}

function validateRaw(list) {
    if (!Array.isArray(list)) throw new EngineFailedError('secret engine returned a report that is not a JSON array', { reason: 'bad-json' });
    for (const f of list) {
        if (!f || typeof f.RuleID !== 'string' || typeof f.Secret !== 'string' || !Number.isInteger(f.StartLine) || f.StartLine < 1) {
            throw new EngineFailedError('secret engine returned a finding without RuleID, Secret and StartLine', { reason: 'bad-finding' });
        }
    }
    return list;
}

// One spawn. Returns the findings and the number of bytes the engine says it scanned. The message of
// every error here is fixed text: neither the engine's stderr nor any input text is ever echoed.
function spawnEngine(bin, args, input, cwd) {
    const r = spawnSync(bin, args, {
        input,
        encoding: 'utf8',
        maxBuffer: Infinity,
        timeout: pinTables().timeoutMs,
        windowsHide: true,
        env: binLib.scrubbedEnv(),
        cwd,
    });
    if (r.error && r.error.code === 'EPIPE' && r.status === 0 && !r.signal) {
        // The engine read the start of the input, sniffed it as a binary file (a zip/OOXML/pdf signature), logged
        // "scanned ~0 bytes" and exited 0 before the rest was written; with input larger than the pipe buffer the
        // parent's write then fails with EPIPE. That is the engine SKIPPING the input, not a fault: report what it
        // scanned and let the caller handle the skip. Anything else (no "scanned" line, or it claims to have read
        // everything, a non-zero status, a signal) stays an engine failure.
        const m = /scanned ~(\d+) bytes?\b/.exec(String(r.stderr || ''));
        if (m && Number(m[1]) < Buffer.byteLength(input)) {
            let parsed;
            try { parsed = JSON.parse(String(r.stdout || '').trim() || '[]'); } catch {
                throw new EngineFailedError('secret engine produced unreadable output', { reason: 'bad-json' });
            }
            return { raw: validateRaw(parsed), scanned: Number(m[1]) };
        }
    }
    if (r.error) {
        const timedOut = r.error.code === 'ETIMEDOUT';
        throw new EngineFailedError(timedOut ? `secret engine timed out after ${pinTables().timeoutMs} ms` : 'secret engine could not run', { reason: timedOut ? 'timeout' : 'spawn', errno: r.error.code || null });
    }
    if (r.signal) throw new EngineFailedError(`secret engine was killed by ${/^SIG[A-Z0-9]+$/.test(r.signal) ? r.signal : 'a signal'}`, { reason: 'signal' });
    if (r.status !== 0) throw new EngineFailedError(`secret engine exited with status ${r.status}`, { reason: 'exit', status: r.status });
    let parsed;
    try {
        parsed = JSON.parse(String(r.stdout || '').trim() || 'null');
    } catch {
        throw new EngineFailedError('secret engine produced unreadable output', { reason: 'bad-json' });
    }
    const raw = validateRaw(parsed);
    // "scanned ~<exact bytes> bytes (<human size>)"; a skipped input reads "~0 bytes".
    const m = /scanned ~(\d+) bytes?\b/.exec(String(r.stderr || ''));
    return { raw, scanned: m ? Number(m[1]) : null };
}

// One scan is often followed by a redaction of the same text (the output scrubber does both);
// remembering the last run keeps that to a single process start.
let lastRun = null;

// ── .betterleaksignore, applied here ──────────────────────────────────────────

/**
 * The fingerprints of a .betterleaksignore, with the semantics the engine gives a single-input run:
 * lines are trimmed, a blank line or one starting with `#` is skipped, every other line is a fingerprint
 * compared whole against `<repo-relative path>:<RuleID>:<StartLine>` (no trailing comment, no commit prefix).
 */
function parseIgnore(text) {
    const set = new Set();
    for (const line of String(text || '').split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('#')) set.add(t);
    }
    return set;
}

/**
 * The project's ignore list as the INDEX holds it (`:0:.betterleaksignore`, the staged version), else as
 * HEAD holds it, else empty. Never the working tree: an untracked or unstaged file is not part of any
 * reviewed change. `.gitleaksignore` is not read. A directory that is not a repository has no list.
 */
function projectIgnoreSet(root) {
    for (const spec of [':0:.betterleaksignore', 'HEAD:.betterleaksignore']) {
        const r = spawnSync('git', ['cat-file', 'blob', spec], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        if (!r.error && r.status === 0) return parseIgnore(r.stdout);
    }
    return new Set();
}

/** Is the finding listed? `ignore` is a Set of fingerprints or a predicate (attributedPath, ruleId, line). */
function isIgnored(ignore, attr, f) {
    if (!ignore || !attr) return false;
    return typeof ignore === 'function' ? Boolean(ignore(attr, f.RuleID, f.StartLine)) : ignore.has(`${attr}:${f.RuleID}:${f.StartLine}`);
}

// ── binary content the engine refuses ─────────────────────────────────────────

const MIN_RUN = 8;

// Byte prefixes the pinned engine (v1.10.0) drops as "a binary file": found by feeding it a table of magic numbers
// (hooks/__tests__/_helpers/engine-signatures.js). Most are logged as "skipping binary file"; a plain archive is
// dropped WITHOUT a word and only shows as a byte-count mismatch, which would send the whole batch to one process
// per file. A binary file that starts like this is therefore routed to its text projection up front.
const SKIPPED_SIGNATURES = ['PK\x03\x04', 'PK\x05\x06', 'PK\x07\x08', 'BZh', 'Rar!\x1a\x07', '!<arch>\n', 'MSCF', '%PDF', '{\\rtf', 'SQLite format 3\0',
    '%!PS', 'Cr24', '\0\x01\0\0\0', 'LZIP', '\x1f\x8b', '7z\xbc\xaf\x27\x1c'];

/** Does this buffer start like something the engine refuses (including a tar's `ustar` at offset 257)? */
function hasSkippedSignature(buf) {
    const head = Buffer.from(buf.subarray(0, 262)).toString('latin1');
    return SKIPPED_SIGNATURES.some(sig => head.startsWith(sig)) || head.slice(257, 262) === 'ustar';
}

/**
 * Does this (already UTF-8-decoded) text come from a binary file, as opposed to text that merely starts with a
 * signature the engine refuses (which carries a handful of NULs: a zip header 14, a tar's `ustar\0`, 'SQLite format
 * 3\0')? Many NULs in the first 8 KB, or a tenth of it being undecodable bytes and control characters.
 */
function looksBinary(text) {
    const head = String(text).slice(0, 8192);
    let nul = 0;
    let odd = 0;   // undecodable bytes and control characters text does not contain (not tab, newline, form feed, return)
    for (const ch of head) {
        const c = ch.charCodeAt(0);
        if (c === 0) nul++;
        if (c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 12 && c !== 13) || c === 0x7f) odd++;
    }
    return nul > 32 || (odd > 32 && odd / head.length > 0.1);
}

/**
 * The text of a binary file: its printable runs of at least MIN_RUN characters (ASCII plus valid UTF-8, and
 * UTF-16LE strings), one per line, UTF-8/ASCII runs first. Nothing printable is dropped, nothing else is kept,
 * and a secret stored as text inside the file stays on one line, which is what the rules need. The engine
 * refuses some binaries outright (an OOXML/zip/pdf signature) and a rescan would feed it the raw bytes; this is
 * scanned instead. A finding's `line` in such a file is the number of the printable run, not a file line.
 */
function textProjection(text) {
    const runs = [];
    for (const m of String(text).matchAll(/[^\u0000-\u0008\u000a-\u001f\u007f-\u009f\ufffd]{8,}/g)) runs.push(m[0]);
    for (const m of String(text).matchAll(/(?:[\x20-\x7e]\u0000){8,}/g)) runs.push(m[0].replace(/\u0000/g, ''));
    return runs.length ? `${runs.join('\n')}\n` : '';
}

/**
 * Raw engine findings for `content`, with the engine's skip of binary-looking input undone.
 * Throws EngineUnavailableError / EngineFailedError.
 * @param {{ wholeFile?: boolean, ignore?: Set<string>|Function }} opts wholeFile: line numbers are whole-file
 *   numbers, so the ignore list applies: `ignore` when given (the commit scans pass the INDEX version
 *   explicitly), else the project's list from the index (see projectIgnoreSet).
 */
function runEngine(content, filePath, { wholeFile = false, ignore = null, projectBinary = false } = {}) {
    if (lastRun && lastRun.content === content && lastRun.filePath === filePath && lastRun.wholeFile === wholeFile && lastRun.ignore === ignore && (lastRun.projectBinary === projectBinary || !lastRun.skipped)) return lastRun.raw;
    const root = getProjectRoot();
    const { bin } = binLib.resolveEngine();
    const cwd = neutralCwd();
    const noIgnore = path.join(cwd, 'no-ignore-file');
    const attr = attributePath(filePath, root);

    let { raw, scanned } = spawnEngine(bin, engineArgs(filePath, root, noIgnore), content, cwd);
    const expected = Buffer.byteLength(content);
    if (scanned !== expected && projectBinary && looksBinary(content)) {
        // The engine skipped a BINARY file (or stopped reading it). Nothing is waved through: its printable
        // runs are scanned as text instead (the raw bytes would only be refused again or scanned as noise). The
        // findings' lines are run numbers of the projection, and the allow-marker rule reads the projection too
        // (raw.basis); the ignore list does not apply, as for any rescan.
        const projection = textProjection(content);
        raw = projection ? [...runEngine(projection, filePath, { wholeFile: false, projectBinary: false })] : [];
        Object.defineProperty(raw, 'basis', { value: projection, enumerable: false });
    } else if (scanned !== expected) {
        // Skipped (or unverifiable). Scan again behind one neutral newline; the ignore list is not
        // honored because every line number is one higher than the file's.
        const shifted = spawnEngine(bin, engineArgs(filePath, root, noIgnore), `\n${content}`, cwd);
        if (shifted.scanned !== expected + 1) {
            throw new EngineFailedError('secret engine did not scan the whole input (it looks like a binary file to the engine)', { reason: 'input-skipped', scanned, shiftedScanned: shifted.scanned, expected });
        }
        raw = shifted.raw
            .map(f => ({ ...f, StartLine: f.StartLine - 1, EndLine: Number.isInteger(f.EndLine) ? f.EndLine - 1 : f.EndLine }))
            .filter(f => f.StartLine >= 1);
    } else if (wholeFile && raw.length) {
        const list = ignore || projectIgnoreSet(root);
        raw = raw.filter(f => !isIgnored(list, attr, f));
    }
    lastRun = { content, filePath, wholeFile, ignore, projectBinary, skipped: scanned !== expected, raw };
    return raw;
}

// ── the allow marker ──────────────────────────────────────────────────────────

const MARKER = /(?<![\w-])(?:betterleaks|gitleaks):allow(?![\w-])/g;
const COMMENT_OPENERS = ['<!--', '/*', '//', '--', '#'];
const LINE_BREAKS = /[\r\u2028\u2029\u0085\v\f]/;

// Index of the first comment opener on the line that is outside a string literal, or -1.
function commentStart(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        for (const opener of COMMENT_OPENERS) {
            if (line.startsWith(opener, i)) return i;
        }
    }
    return -1;
}

/**
 * True when `line` carries an allow marker that covers the secret at [start, end): a trailing
 * comment on this same physical line, after the secret, not glued to it, not inside a string literal.
 */
function markerCovers(line, start, end) {
    const open = commentStart(line);
    if (open === -1 || open === end || (open >= start && open < end)) return false;
    MARKER.lastIndex = 0;
    for (let m = MARKER.exec(line); m; m = MARKER.exec(line)) {
        if (m.index < end || m.index <= open) continue;
        if (LINE_BREAKS.test(line.slice(Math.min(open, end), m.index))) continue;
        return true;
    }
    return false;
}

function occurrenceAt(line, secret, nth) {
    let at = -1;
    for (let i = 0; i < nth; i++) {
        at = line.indexOf(secret, at + 1);
        if (at === -1) return -1;
    }
    return at;
}

/**
 * Apply the allow-marker rule (D3, tightened). One marker covers one secret: the first finding on
 * its line that it is positioned to cover, plus other rules' findings of that same value. A
 * finding that spans lines is never covered, and a marker on another line covers nothing.
 */
function applyAllowMarkers(content, findings) {
    if (!/(?:betterleaks|gitleaks):allow/.test(content)) return { kept: findings, suppressed: [] };
    const lines = content.split('\n');
    const chosen = new Map();
    const kept = [];
    const suppressed = [];
    for (const f of findings) {
        const { StartLine, EndLine, Secret } = f.raw;
        const line = lines[StartLine - 1];
        let covered = false;
        if (line !== undefined && StartLine === EndLine && Secret.length) {
            if (!chosen.has(StartLine)) {
                const at = occurrenceAt(line, Secret, f.occurrence);
                if (at !== -1 && f.occurrence === 1 && markerCovers(line, at, at + Secret.length)) chosen.set(StartLine, Secret);
            }
            covered = chosen.get(StartLine) === Secret && f.occurrence === 1;
        }
        (covered ? suppressed : kept).push(f);
    }
    return { kept, suppressed };
}

function noteSuppressed(suppressed) {
    if (!suppressed.length || process.env.SECRET_ENGINE_QUIET === '1') return;
    const list = suppressed.map(f => `${f.name}@${f.raw.StartLine}`).join(', ');
    process.stderr.write(`[secret-engine] allow marker suppressed ${suppressed.length} finding(s): ${list}. Review them; a marker beside a key is a decision a person made.\n`);
}

/**
 * Engine findings, normalised: display name, generic flag, ordered by line. Two rules that name
 * the same thing on the same line and value collapse to one finding; a generic finding is dropped
 * when a named-provider rule already reported that value. Distinct names stay distinct (a bearer
 * token that is also a JWT is both).
 * @param {{ namedProvidersOnly?: boolean, wholeFile?: boolean, honorMarkers?: boolean }} opts
 *   honorMarkers (default true) is for the blocking gates; a redactor passes false.
 */
function normalizeRaw(rawList, { namedProvidersOnly = false } = {}) {
    const all = new Map();
    const namedAt = new Set();
    const perRule = new Map();
    for (const raw of rawList) {
        const generic = isGenericRule(raw.RuleID);
        if (namedProvidersOnly && generic) continue;
        const name = displayName(raw);
        // Two rules can report the same secret with and without its quotes (a literal in a .tf file is found by
        // the generic rule and by the Terraform rule). The span is the same, so the key ignores the quotes.
        const where = `${raw.StartLine}\u0000${raw.Secret.replace(/^["'`]+|["'`]+$/g, '')}`;
        if (!generic) namedAt.add(where);
        // The same value twice on one line is two occurrences (each one is redacted and baselined on
        // its own). Two RULES reporting the same occurrence are one finding.
        const ruleKey = `${where}\u0000${raw.RuleID}`;
        const occurrence = (perRule.get(ruleKey) || 0) + 1;
        perRule.set(ruleKey, occurrence);
        const key = `${where}\u0000${name}\u0000${occurrence}`;
        if (!all.has(key)) all.set(key, { raw, generic, name, where, occurrence });
    }
    return [...all.values()]
        .filter(f => !(f.generic && namedAt.has(f.where)))
        .sort((a, b) => a.raw.StartLine - b.raw.StartLine);
}

function engineFindings(content, filePath, { namedProvidersOnly = false, wholeFile = false, honorMarkers = true, ignore = null } = {}) {
    // A redactor (honorMarkers false) needs lines that are the content's own lines to cut the secret out of it,
    // so only the blocking gates take the text projection of a binary file the engine skipped.
    const raw = runEngine(content, filePath, { wholeFile, ignore, projectBinary: honorMarkers });
    const list = normalizeRaw(raw, { namedProvidersOnly });
    if (!honorMarkers) return list;
    const { kept, suppressed } = applyAllowMarkers(raw.basis !== undefined ? raw.basis : content, list);
    noteSuppressed(suppressed);
    return kept;
}

/**
 * @param {string} content
 * @param {string} [filePath]
 * @param {{ namedProvidersOnly?: boolean, wholeFile?: boolean, honorMarkers?: boolean }} [options]
 *   namedProvidersOnly: test/spec files drop the generic credential rules (fixture noise), every
 *   named-provider rule still applies. wholeFile: the content is the complete file, so
 *   .betterleaksignore applies (never pass it for an Edit fragment). honorMarkers: see engineFindings.
 */
function buildFindings(filePath, engineList) {
    const { isHighRiskFile, redact } = patterns();
    const findings = [];
    if (filePath && isHighRiskFile(filePath)) {
        findings.push({ type: 'HIGH_RISK_FILE', name: 'Sensitive file type', file: filePath, line: 0, match: path.basename(filePath) });
    }
    for (const f of engineList) {
        findings.push({
            type: 'SECRET_PATTERN',
            name: f.name,
            file: filePath || '<stdin>',
            line: f.raw.StartLine,
            match: redact(f.raw.Secret, f.name),
        });
    }
    return findings;
}

function scanContent(content, filePath, options) {
    if (typeof content !== 'string') content = String(content ?? '');
    // Whitespace cannot hold a secret; the high-risk-file check still runs from the path alone.
    if (content.trim() === '') return buildFindings(filePath, []);
    return buildFindings(filePath, engineFindings(content, filePath, options));
}

// ── many files, one engine run ────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;

/** Decode a Go-quoted string ("..." with \" \\ \n \t \xNN \uNNNN \UNNNNNNNN \NNN escapes). Returns null if malformed. */
function goUnquote(text) {
    if (text.length < 2 || text[0] !== '"') return null;
    let out = '';
    let i = 1;
    const bytes = [];
    const flush = () => { if (bytes.length) { out += Buffer.from(bytes).toString('utf8'); bytes.length = 0; } };
    const simple = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
    while (i < text.length) {
        const c = text[i];
        if (c === '"') return i === text.length - 1 ? (flush(), out) : null;
        if (c !== '\\') { flush(); out += c; i++; continue; }
        const e = text[i + 1];
        if (e in simple) { flush(); out += simple[e]; i += 2; continue; }
        const hex = (n) => { const h = text.slice(i + 2, i + 2 + n); return /^[0-9a-fA-F]+$/.test(h) && h.length === n ? parseInt(h, 16) : null; };
        if (e === 'x') { const v = hex(2); if (v === null) return null; bytes.push(v); i += 4; continue; }
        if (e === 'u') { const v = hex(4); if (v === null) return null; flush(); out += String.fromCodePoint(v); i += 6; continue; }
        if (e === 'U') { const v = hex(8); if (v === null || v > 0x10ffff) return null; flush(); out += String.fromCodePoint(v); i += 10; continue; }
        if (/[0-7]/.test(e)) { const o = text.slice(i + 1, i + 4); if (!/^[0-7]{3}$/.test(o)) return null; bytes.push(parseInt(o, 8)); i += 4; continue; }
        return null;
    }
    return null;
}

/** The path of a "skipping ..." log line: quoted (a path with a space, quote or backslash) or bare. Null when unreadable. */
function logPath(line) {
    const m = /\bpath=(.*)$/.exec(line);
    if (!m) return null;
    const value = m[1].replace(/\s+$/, '');
    if (value.startsWith('"')) return goUnquote(value);
    return value && !/\s/.test(value) ? value : null;
}

// The text a one-file scan feeds the engine for a blob: its UTF-8 decoding. Valid UTF-8 is the same bytes (no copy).
const { isUtf8 } = require('buffer');
function utf8Bytes(buf) {
    return typeof isUtf8 === 'function' && isUtf8(buf) ? buf : Buffer.from(Buffer.from(buf).toString('utf8'), 'utf8');
}

// ── staging directory hygiene ─────────────────────────────────────────────────

const STALE_STAGE_MS = 10 * 60 * 1000;

/**
 * Remove `scan-*` staging directories an interrupted run left behind (a SIGKILL, a power loss: they hold
 * plaintext copies of staged files). Only directories this user owns and that are older than ten minutes;
 * a link is never followed (a link is unlinked, not entered). Best effort, never throws.
 */
function sweepStaleStages(parent, now = Date.now()) {
    let names;
    try { names = fs.readdirSync(parent); } catch { return; }
    for (const name of names) {
        if (!name.startsWith('scan-')) continue;
        const dir = path.join(parent, name);
        try {
            const st = fs.lstatSync(dir);
            if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue;
            if (now - st.mtimeMs < STALE_STAGE_MS) continue;
            fs.rmSync(dir, { recursive: true, force: true }); // fs-safe-lint:local — our own stale staging directory in the per-user cache
        } catch { /* best effort */ }
    }
}

/**
 * Create a private staging directory under `parent`, run `fn(dir)` and guarantee the directory is removed: on
 * a normal return, on a throw, and when the process is told to stop (SIGINT, SIGTERM, SIGHUP). The handlers
 * are installed BEFORE the directory exists, so there is no window in which a signal kills Node with the
 * plaintext on disk; they are what keep Node from dying mid-run. A signal that arrives while the synchronous
 * engine run is in progress is queued by Node and delivered the next time the event loop turns: the handler
 * removes the directory and re-raises the signal, so the exit status is the one the sender asked for. A caller
 * that is about to exit synchronously awaits settleSignals() first, to give that delivery its turn. The
 * handlers stay installed until that turn has had its chance, then step aside.
 */
function withStagingDir(parent, fn) {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let dir = null;
    const remove = () => { if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } }; // fs-safe-lint:local — our own staging directory
    const handlers = signals.map(sig => [sig, () => {
        remove();
        for (const [s2, h2] of handlers) process.removeListener(s2, h2);
        process.kill(process.pid, sig);
    }]);
    for (const [sig, handler] of handlers) process.on(sig, handler);
    try {
        dir = fs.mkdtempSync(path.join(parent, 'scan-'));
        return fn(dir);
    } finally {
        remove();
        setImmediate(() => { for (const [sig, handler] of handlers) process.removeListener(sig, handler); });
    }
}

/** Resolves after one turn of the event loop: a signal that arrived during a synchronous scan is delivered (and re-raised) first. */
function settleSignals() {
    return new Promise(resolve => setImmediate(resolve));
}

/**
 * Scan files on disk with ONE `betterleaks dir` run (for tools/tracked-file-scan.cjs). A process per
 * file made that scan about nine times slower than the regex scanner it replaced, and handing the
 * engine a long list of file arguments is nearly as slow (it pays a per-target cost), so the files are
 * copied into a private temporary directory under the engine cache (0700, removed afterwards) and the
 * directory is scanned once. A file the engine reports as skipped (it sniffed as a binary) is scanned
 * again through the single-input path, which undoes the skip (with the same whole-file rules as a
 * one-file scan, so the two report the same findings). The directory is removed on every exit, including
 * SIGINT, SIGTERM and SIGHUP, and stale `scan-*` directories of an interrupted run are swept first.
 *
 * `ignore` (a Set of fingerprints, or a predicate `(rel, ruleId, line) => boolean`) is applied here, in Node,
 * with the semantics the engine gives a single-input run: see parseIgnore. The engine is NOT pointed at an
 * ignore file: in a batch its fingerprints would carry the private staging path, and it would pick up an
 * ignore file that is itself one of the scanned files. tools/tracked-file-scan.cjs has its own reviewed
 * baseline and passes none.
 *
 * `contentFor(rel)` supplies each file's bytes (a Buffer) instead of reading `<root>/<rel>`: the commit scans
 * hand it the STAGED blobs. `reportSuppressed` prints the allow-marker suppressions on stderr, as the
 * single-input scan does.
 *
 * The skip is never taken on trust from the log alone. Fail closed (EngineFailedError) when a skip or
 * error line does not map to a requested file, and cross-check the byte total the engine says it scanned
 * against the sizes of the files it did not report as skipped; on a mismatch every file is scanned one
 * by one (scanContent), and any file that still skips there fails the run.
 *
 * @param {string} root absolute directory the relative paths are under
 * @param {string[]} relPaths repository-relative paths (files that exist)
 * @param {(rel: string) => { namedProvidersOnly?: boolean }} [optionsFor]
 * @returns {Map<string, { findings: object[] } | { error: string }>} with a non-enumerable `batchMode`: 'batch' or 'per-file'
 */
function scanFiles(root, relPaths, optionsFor = () => ({}), { ignore = null, contentFor = null, reportSuppressed = false } = {}) {
    const results = new Map();
    let mode = 'batch';
    Object.defineProperty(results, 'batchMode', { get: () => mode });
    if (relPaths.length === 0) return results;
    const { bin } = binLib.resolveEngine();
    const cwd = neutralCwd();
    const noIgnore = path.join(cwd, 'no-ignore-file');
    const parent = path.join(binLib.cacheRoot(), 'betterleaks');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { // a parent an older run created 0755 holds plaintext staging dirs below it: tighten it when it is ours
        const st = fs.statSync(parent);
        if ((st.mode & 0o077) && typeof process.getuid === 'function' && st.uid === process.getuid()) fs.chmodSync(parent, 0o700);
    } catch { /* best effort: neutralCwd refuses an unsafe cache */ }
    sweepStaleStages(parent);
    const norm = rel => rel.replace(/\\/g, '/');

    /** One `betterleaks dir` run over `rels`, staged by `writeTo(rel, dest)`; the engine's own account of it is checked. */
    const batchRun = (rels, writeTo, ignoreList) => {
        const rawBy = new Map();
        const skipped = new Set();
        const copyFailed = new Map();
        const sizes = new Map();
        const wanted = new Set(rels.map(norm));
        let batchOk = true;
        withStagingDir(parent, stage => {
            // One mkdir syscall per NEW directory: a recursive mkdir per file re-walked every ancestor and cost six seconds
            // over 19,000 files.
            const made = new Set([stage]);
            const ensureDir = dir => {
                if (made.has(dir)) return;
                const missing = [];
                for (let d = dir; !made.has(d); d = path.dirname(d)) missing.push(d);
                for (const d of missing.reverse()) { try { fs.mkdirSync(d); } catch (err) { if (err.code !== 'EEXIST') throw err; } made.add(d); }
            };
            for (const rel of rels) {
                const dest = path.join(stage, rel);
                try {
                    ensureDir(path.dirname(dest));
                    writeTo(rel, dest);
                    sizes.set(norm(rel), fs.statSync(dest).size);
                } catch (err) { copyFailed.set(rel, err.message); }
            }
            const r = spawnSync(bin, ['dir', stage, '--no-banner', '--no-color', '--exit-code', '0', '--report-format', 'json', '--report-path', '-',
                '--log-level', 'debug', '--config', CONFIG_PATH, '--ignore-gitleaks-allow', '--gitleaks-ignore-path', noIgnore, '--max-archive-depth', '0'],
            { encoding: 'utf8', maxBuffer: Infinity, timeout: pinTables().timeoutMs * 6, windowsHide: true, env: binLib.scrubbedEnv(), cwd });
            if (r.error || r.signal || r.status !== 0) {
                // The same fixed wording as a single-input run: neither the engine's stderr nor any input text is echoed.
                const why = r.error ? (r.error.code === 'ETIMEDOUT' ? `timed out after ${pinTables().timeoutMs * 6} ms` : 'could not run')
                    : r.signal ? `was killed by ${/^SIG[A-Z0-9]+$/.test(r.signal) ? r.signal : 'a signal'}` : `exited with status ${r.status}`;
                throw new EngineFailedError(`secret engine ${why} during a batch scan`, { reason: 'batch', status: r.status });
            }
            let parsed;
            try { parsed = validateRaw(JSON.parse(String(r.stdout || '').trim() || 'null')); } catch (err) {
                if (err instanceof EngineFailedError) throw err;
                throw new EngineFailedError('secret engine produced unreadable output', { reason: 'bad-json' });
            }
            const relOf = f => path.relative(stage, path.resolve(cwd, f)).replace(/\\/g, '/');
            for (const f of parsed) {
                const rel = relOf(f.File || '');
                if (!rel || rel.startsWith('..') || !wanted.has(rel)) throw new EngineFailedError('secret engine reported a finding for a file that was not scanned', { reason: 'bad-finding' });
                if (isIgnored(ignoreList, rel, f)) continue;
                if (!rawBy.has(rel)) rawBy.set(rel, []);
                rawBy.get(rel).push(f);
            }
            let scannedBytes = null;
            for (const rawLine of String(r.stderr || '').split('\n')) {
                const line = rawLine.replace(ANSI, '');
                if (/\b(?:ERR|FTL)\b/.test(line.slice(0, 20))) throw new EngineFailedError('secret engine logged an error during a batch scan', { reason: 'batch-error' });
                // "skipping binary file", "skipping empty file" and any other "skipping <kind> file". ("skipping <rule> finding"
                // lines are the engine choosing between two of its own rules, not a file left unscanned.)
                if (/\bskipping (?:[\w-]+ )*file\b/.test(line)) {
                    const logged = logPath(line);
                    const rel = logged === null ? null : relOf(logged);
                    if (rel === null || !rel || rel.startsWith('..') || !wanted.has(rel)) {
                        throw new EngineFailedError('secret engine skipped something that is not a requested file', { reason: 'unmatched-skip' });
                    }
                    skipped.add(rel);
                    continue;
                }
                const m = /scanned ~(\d+) bytes?\b/.exec(line);
                if (m) scannedBytes = Number(m[1]);
            }
            let expected = 0;
            for (const [rel, size] of sizes) if (!skipped.has(rel)) expected += size;
            if (scannedBytes !== expected) batchOk = false;
        });
        return { rawBy, skipped, copyFailed, batchOk };
    };

    // A binary that starts with a signature the engine refuses never goes into the batch: its text projection does.
    const preRouted = new Set();
    if (contentFor) {
        for (const rel of relPaths) {
            const bytes = contentFor(rel);
            if (hasSkippedSignature(bytes) && looksBinary(Buffer.from(bytes.subarray(0, 8192)).toString('utf8'))) preRouted.add(rel);
        }
    }
    const batchRels = preRouted.size ? relPaths.filter(rel => !preRouted.has(rel)) : relPaths;
    const first = batchRels.length
        ? batchRun(batchRels, (rel, dest) => {
            if (contentFor) fs.writeFileSync(dest, contentFor(rel)); // fs-safe-lint:local — private staging dir in the per-user cache
            else fs.copyFileSync(path.resolve(root, rel), dest); // fs-safe-lint:local — private staging dir in the per-user cache
        }, ignore)
        : { rawBy: new Map(), skipped: new Set(), copyFailed: new Map(), batchOk: true };
    const { rawBy, copyFailed } = first;
    let skipped = first.skipped;

    // The engine's account of itself does not add up: do not trust the batch for any file.
    if (!first.batchOk) {
        mode = 'per-file';
        skipped = new Set(relPaths.map(norm));
    }

    const contents = new Map();
    const contentOf = rel => {
        if (!contents.has(rel)) contents.set(rel, contentFor ? Buffer.from(contentFor(rel)).toString('utf8') : fs.readFileSync(path.resolve(root, rel), 'utf8'));
        return contents.get(rel);
    };

    // Binary files the engine skipped in the batch go, still in ONE batch, through their text projection: a
    // history full of zip/OOXML/pdf documents costs one more engine run, not one process per file. (When the
    // batch itself was not trusted every file is scanned on its own below, and a binary one is projected there.)
    const projected = new Map();
    const projectedRel = new Map();
    if (first.batchOk) {
        for (const rel of relPaths) {
            if (copyFailed.has(rel) || !(preRouted.has(rel) || skipped.has(norm(rel)))) continue;
            try {
                const text = contentOf(rel);
                if (looksBinary(text)) projected.set(rel, textProjection(text));
            } catch (err) {
                if (err instanceof EngineFailedError || err instanceof binLib.EngineUnavailableError) throw err;
                results.set(rel, { error: err.message });
            }
        }
    }
    let second = null;
    const toBatch = [...projected].filter(([, text]) => text).map(([rel]) => rel);
    if (toBatch.length) {
        // Each projection is staged behind one neutral newline: a PDF's first printable run is `%PDF-1.4`, exactly the
        // signature the engine refuses, and every projection would otherwise be refused again. The newline is taken
        // back out of the line numbers below, so a finding's line is the number of its printable run.
        second = batchRun(toBatch, (rel, dest) => fs.writeFileSync(dest, `\n${projected.get(rel)}`), null); // fs-safe-lint:local — private staging dir in the per-user cache
        for (const [key, list] of second.rawBy) {
            second.rawBy.set(key, list
                .map(f => ({ ...f, StartLine: f.StartLine - 1, EndLine: Number.isInteger(f.EndLine) ? f.EndLine - 1 : f.EndLine }))
                .filter(f => f.StartLine >= 1));
        }
        for (const rel of toBatch) projectedRel.set(norm(rel), rel);
    }

    for (const rel of relPaths) {
        if (results.has(rel)) continue;
        const options = optionsFor(rel) || {};
        const key = norm(rel);
        if (copyFailed.has(rel)) { results.set(rel, { error: copyFailed.get(rel) }); continue; }
        try {
            if (projected.has(rel)) {
                const text = projected.get(rel);
                // An empty projection (no printable run) holds nothing to find; a projection the engine refused or
                // that the batch could not account for is scanned on its own (shifted rescan).
                if (!text) { results.set(rel, { findings: buildFindings(rel, []) }); continue; }
                if (!second.batchOk || second.skipped.has(key) || second.copyFailed.has(rel)) {
                    results.set(rel, { findings: scanContent(text, rel, { ...options, wholeFile: false }) });
                    continue;
                }
                const list = normalizeRaw(second.rawBy.get(key) || [], options);
                let kept = list;
                if (list.length) {
                    const applied = applyAllowMarkers(text, list);
                    kept = applied.kept;
                    if (reportSuppressed) noteSuppressed(applied.suppressed);
                }
                results.set(rel, { findings: buildFindings(rel, kept) });
                continue;
            }
            if (skipped.has(key)) {
                // Exactly what a one-file scan does: the whole-file ignore list applies while the engine reads the
                // file complete, and not on the shifted rescan (scanContent decides which one happened).
                results.set(rel, { findings: scanContent(contentOf(rel), rel, { ...options, wholeFile: Boolean(ignore), ignore }) });
                continue;
            }
            const list = normalizeRaw(rawBy.get(key) || [], options);
            let kept = list;
            if (list.length) {
                const applied = applyAllowMarkers(contentOf(rel), list);
                kept = applied.kept;
                if (reportSuppressed) noteSuppressed(applied.suppressed);
            }
            results.set(rel, { findings: buildFindings(rel, kept) });
        } catch (err) {
            if (err instanceof EngineFailedError || err instanceof binLib.EngineUnavailableError) throw err;
            results.set(rel, { error: err.message });
        }
    }
    return results;
}

function lineStartOffsets(content) {
    const starts = [0];
    for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) starts.push(i + 1);
    return starts;
}

/**
 * Replace every detected secret in `content` with `<REDACTED:Name>`. The exact Secret string is
 * located from the start of its reported line (columns are not trusted across engines) and EVERY
 * verbatim occurrence of it up to the end of the reported line range is replaced: identical bytes
 * are always safe to redact, and the engine may have reported only one of several copies. A secret
 * that cannot be found verbatim (a decoded value, say) redacts its whole reported line range.
 * Overlapping and nested spans are merged so no nested byte is reinserted. No size cap. An allow
 * marker does not exempt anything here: the marker is for the blocking gates.
 */
function redactSecretsInText(content, filePath, options) {
    if (!content) return content;
    const found = engineFindings(content, filePath, { ...options, honorMarkers: false });
    if (found.length === 0) return content;

    const starts = lineStartOffsets(content);
    const lineEnd = n => (n < starts.length ? starts[n] - 1 : content.length);
    const spans = [];
    for (const f of found) {
        const { StartLine, EndLine, Secret } = f.raw;
        const from = starts[Math.min(StartLine, starts.length) - 1];
        const lastLine = Math.min(Math.max(EndLine || StartLine, StartLine), starts.length);
        const limit = lineEnd(lastLine);
        let hits = 0;
        if (Secret.length) {
            for (let at = content.indexOf(Secret, from); at !== -1 && at <= limit; at = content.indexOf(Secret, at + 1)) {
                spans.push({ start: at, end: at + Secret.length, name: f.name, generic: f.generic });
                hits++;
            }
        }
        if (hits === 0) spans.push({ start: from, end: limit, name: f.name, generic: f.generic });
    }
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s.start < last.end) {
            if (s.end > last.end) last.end = s.end;
            if (last.generic && !s.generic) { last.name = s.name; last.generic = false; }
        } else {
            merged.push({ ...s });
        }
    }
    let cursor = 0;
    const parts = [];
    for (const s of merged) {
        parts.push(content.slice(cursor, s.start), `<REDACTED:${s.name}>`);
        cursor = s.end;
    }
    parts.push(content.slice(cursor));
    return parts.join('');
}

function resetForTests() {
    lastRun = null;
    tables = null;
    timeoutOverride = 0;
    binLib.resetForTests();
}

module.exports = {
    CONFIG_PATH,
    EngineFailedError,
    EngineUnavailableError: binLib.EngineUnavailableError,
    scanContent,
    redactSecretsInText,
    engineFindings,
    scanFiles,
    goUnquote,
    logPath,
    parseIgnore,
    hasSkippedSignature,
    utf8Bytes,
    looksBinary,
    textProjection,
    projectIgnoreSet,
    sweepStaleStages,
    settleSignals,
    applyAllowMarkers,
    markerCovers,
    isGenericRule,
    isGenericName,
    titleCase,
    resolveEngine: binLib.resolveEngine,
    engineStatus: binLib.engineStatus,
    installHint: binLib.installHint,
    setTimeoutForTests(ms) { timeoutOverride = ms; tables = null; },
    resetForTests,
};
