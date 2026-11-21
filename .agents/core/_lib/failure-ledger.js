/**
 * failure-ledger — remembers gate/test failures by signature (SF-1.5).
 *
 * The gate counts failures but not SAMENESS. This ledger records one row per gate run
 * (or per failing focused test run recorded from outside the gate) so "the same failure
 * twice" is detected by code, escalated once, and a budget can be computed from it.
 *
 * Ledger: <root>/docs/.output/.state/telemetry/gate-failures.jsonl, tail-rotated 2000 -> 1500.
 *
 * Row: { ts, head, sig, legs, passed, killed } plus the optional extras `cls` and `log`:
 *   head    opaque working-tree identity string (`<HEAD sha>+<code-tree hash prefix>`, see
 *           currentHead), or null outside a git work tree; null is "unknown" and always counts.
 *   sig     a sha256 hex signature, `empty:<mode>` when no failing ids were found, null for a pass.
 *   legs    the gate legs the row is about: the FAILED legs for a failure row, the legs that RAN
 *           for a pass row (a focused run records the one leg it ran).
 *   killed  null, or a string: a signal name, or 'TIMEOUT' for a leg that hit its time limit.
 *   cls     present only as 'environment' (network, port, disk or memory trouble in the failing
 *           material); such rows never count toward escalation.
 *   log     absolute path of the log the failure was recorded from (the gate log, or the
 *           `record --output-file` file resolved at record time); read back by `last --format prompt`.
 *
 * Counting rule (classify): the same signature on a changed tree is a genuine repeat; the
 * same signature on the same tree is a no-op (not counted again). A failure on a tree that
 * ALREADY PASSED the same legs is flaky. Two different signatures on one tree with no pass in
 * between are two different failures, not flaky: the signature change restarts the streak, so
 * nothing escalates. Environment failures are never counted. A pass resets the streak; KILLED
 * and TIMED OUT rows are neutral (any leg's timeout, including build, lint, visual and E2E).
 * Flaky and environment classes never escalate.
 *
 * Budget: a key is exceeded when used > limit (strict), so `attempts=3` is exhausted only once a
 * fourth attempt has been counted. `gate-failures` counts every non-killed failure row since the
 * stamp INCLUDING environment and flaky rows (they never escalate, but they are still failed runs).
 *
 * Exports: getLedgerPath, signature, extractFailures, describeFailure, describeGateFailure,
 *   splitGateLog, currentHead, appendFailure, readLedger, classify, streak, seenLine,
 *   recordGateRun, lastPrompt, parseBudget, budget, getProjectRoot.
 *
 * CLI: node failure-ledger.js record|streak|last|budget ... (see usage text below).
 * Every write path is best-effort: recording must never change a gate's exit code. Every read of
 * a file whose path is not a constant (the ledger, a row's `log`, `--output-file`, `--limits`) only
 * accepts a regular file and caps what it reads, so a FIFO or device in its place cannot hang a hook.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { appendJsonl } = require('./jsonl-writer');
const { getJsonlPath } = require('./telemetry-paths');
const { resolveProjectRoot } = require('./project-root');

const LEDGER_FILE = 'gate-failures.jsonl';
const MAX_LINES = 2000;
const TAIL_KEEP = 1500;
const BUDGET_KEYS = ['attempts', 'gate-failures', 'dispatches', 'minutes'];
const ENVIRONMENT_RE = /ECONNREFUSED|EADDRINUSE|ENOSPC|ENOMEM|heap out of memory/;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LEDGER_READ_BYTES = 16 * 1024 * 1024;
const MAX_LEG_IDS = 50;
const MAX_HASHED_FILE_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15000;

function getProjectRoot() {
    return resolveProjectRoot(path.resolve(__dirname, '..', '..', '..'));
}

function getLedgerPath(root) {
    return getJsonlPath(root, LEDGER_FILE);
}

/**
 * Read at most `maxBytes` of a REGULAR file (the start, or the end with `fromEnd`). Returns
 * `{ text, start }` (`start` = byte offset the text begins at) or null when the path is missing,
 * unreadable or not a regular file. A FIFO or device in the place of a file would block or never
 * end a plain read, so the path is stat-checked before it is opened, opened non-blocking where the
 * platform has it, and checked again on the descriptor (a swap between the two cannot get through).
 */
function readRegularFile(file, { maxBytes, fromEnd = false } = {}) {
    let fd;
    try {
        if (!fs.statSync(file).isFile()) return null;
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
        const st = fs.fstatSync(fd);
        if (!st.isFile()) return null;
        const len = Math.min(st.size, maxBytes);
        const start = fromEnd ? st.size - len : 0;
        const buf = Buffer.alloc(len);
        let offset = 0;
        while (offset < len) {
            const n = fs.readSync(fd, buf, offset, len - offset, start + offset);
            if (n <= 0) break;
            offset += n;
        }
        return { text: buf.toString('utf8', 0, offset), start };
    } catch {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
}

// ─── Normalization and signature ─────────────────────────────────────────────────

const ANSI_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

function stripAnsi(text) {
    return String(text == null ? '' : text).replace(ANSI_RE, '');
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Make absolute paths under `root` root-relative (both slash styles). */
function relativize(text, root) {
    if (typeof root !== 'string' || !root) return text;
    const bare = root.replace(/[\\/]+$/, '');
    if (!bare) return text;
    const variants = new Set([bare, bare.replace(/\\/g, '/')]);
    let out = text;
    for (const v of variants) {
        out = out.replace(new RegExp(escapeRegExp(v) + '(?![\\w.\\-])[\\\\/]?', 'g'), '');
    }
    return out;
}

/** Strip every token that changes between two runs of the same failure. */
function normalizeText(text, root) {
    return relativize(stripAnsi(text), root)
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
        .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>')
        .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
        .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,64}\b/gi, '<hex>')
        .replace(/\b1\d{9,12}\b/g, '<epoch>')
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|sec|secs|seconds|milliseconds)\b/g, '<dur>')
        .replace(/(\.[A-Za-z0-9]{1,8}):\d+(?::\d+)?/g, '$1')
        .replace(/\bline \d+\b/gi, 'line')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * sha256 over the sorted, de-duplicated, normalized failing ids plus the normalized detail.
 * An empty failing set is `empty:<mode>` whatever the detail says.
 */
function signature({ ids, detail, mode, root } = {}) {
    const list = Array.isArray(ids) ? ids : [];
    const normalized = [...new Set(list.map(id => normalizeText(id, root)).filter(Boolean))].sort();
    if (normalized.length === 0) return `empty:${mode == null || mode === '' ? 'unknown' : String(mode)}`;
    const text = normalizeText(detail == null ? '' : typeof detail === 'string' ? detail : String(detail), root);
    return crypto.createHash('sha256').update(JSON.stringify({ ids: normalized, detail: text })).digest('hex');
}

// ─── Reading runner output ───────────────────────────────────────────────────────

const VITEST_FAIL_RE = /^\s*FAIL\s+(\S.*?)\s*$/;
const VITEST_ASSERT_RE = /AssertionError:\s*expected\s+(.+?)\s+to\s+(?:be deeply equal|deeply equal|strictly equal|equal|be)\s+(.+?)(?:\s+\/\/.*)?\s*$/;
const VITEST_LOC_RE = /❯\s+(\S+?):(\d+)(?::\d+)?\s*$/;
const PYTEST_FAILED_RE = /^FAILED\s+(\S+)/;
const PYTEST_ERROR_RE = /^E\s+(\S.*?)\s*$/;
const DOTNET_FAILED_RE = /^\s*Failed\s+(.+?)\s+\[[^\]]*\]\s*$/;
const GENERIC_ERROR_RE = /\b(Error|Exception)\b/;

// A vitest failure block runs from its `FAIL` line to the next `⎯⎯⎯` separator (or this many lines).
const BLOCK_END_RE = /^\s*⎯{3,}/;
const MAX_BLOCK_LINES = 200;

/**
 * One pass over runner output text: failing ids, per-assertion expected/saw/location, the first
 * error line and `failureText`, the material that belongs to the failures themselves (used for the
 * environment check). A vitest assertion block (AssertionError) is a logic failure, so its text is
 * left out of `failureText`; blocks that threw anything else, the pytest `E` line, the dotnet error
 * message and (when nothing structured exists at all) the first error line are in it. Noise printed
 * by passing tests never reaches `failureText`, and once a failure block exists `firstError` is read
 * from inside the blocks only.
 */
function scanFailures(text, { root } = {}) {
    const lines = relativize(stripAnsi(text), root).split(/\r?\n/);
    const ids = [];
    const seenIds = new Set();
    const byId = new Map();
    const addId = id => { if (!seenIds.has(id)) { seenIds.add(id); ids.push(id); } };

    let cur = null;
    let block = null;
    const blocks = [];
    let pytestError = null;
    let dotnetMessage = null;
    let genericAny = null;
    let genericInBlock = null;
    let afterDotnetHeader = false;

    for (const line of lines) {
        const fail = VITEST_FAIL_RE.exec(line);
        if (fail) {
            cur = { id: fail[1] };
            addId(cur.id);
            if (!byId.has(cur.id)) byId.set(cur.id, { id: cur.id, expected: null, saw: null, file: null, line: null, asserted: false });
            block = { lines: [line], asserted: false };
            blocks.push(block);
            continue;
        }
        if (block) {
            if (BLOCK_END_RE.test(line)) block = null;
            else if (block.lines.length < MAX_BLOCK_LINES) block.lines.push(line);
        }
        if (cur) {
            const entry = byId.get(cur.id);
            const assertion = VITEST_ASSERT_RE.exec(line);
            if (assertion && !entry.asserted) {
                entry.saw = assertion[1];
                entry.expected = assertion[2];
                entry.asserted = true;
            }
            if (assertion && block) block.asserted = true;
            const loc = VITEST_LOC_RE.exec(line);
            if (loc && entry.file === null) {
                entry.file = loc[1];
                entry.line = Number(loc[2]);
            }
        }

        const pyFailed = PYTEST_FAILED_RE.exec(line);
        if (pyFailed) addId(pyFailed[1]);
        const dotnet = DOTNET_FAILED_RE.exec(line);
        if (dotnet) addId(dotnet[1]);

        if (pytestError === null) {
            const e = PYTEST_ERROR_RE.exec(line);
            if (e) pytestError = e[1];
        }
        if (afterDotnetHeader && dotnetMessage === null && line.trim()) {
            dotnetMessage = line.trim();
            afterDotnetHeader = false;
        }
        if (/^\s*Error Message:\s*$/.test(line)) afterDotnetHeader = true;
        if (GENERIC_ERROR_RE.test(line)) {
            if (genericAny === null) genericAny = line.trim();
            if (block && genericInBlock === null) genericInBlock = line.trim();
        }
    }

    const assertions = [...byId.values()]
        .filter(e => e.asserted)
        .map(({ id, expected, saw, file, line }) => ({ id, expected, saw, file, line }));
    const genericError = blocks.length > 0 ? genericInBlock : genericAny;
    const firstError = pytestError !== null ? pytestError : dotnetMessage !== null ? dotnetMessage : genericError;

    const parts = blocks.filter(b => !b.asserted).map(b => b.lines.join('\n'));
    if (pytestError !== null) parts.push(pytestError);
    if (dotnetMessage !== null) parts.push(dotnetMessage);
    if (blocks.length === 0 && genericAny !== null) parts.push(genericAny);
    return { ids, assertions, firstError, failureText: parts.join('\n') };
}

/**
 * Read failing check ids, per-assertion expected/saw/location and the first error line from
 * runner output text (vitest, pytest, dotnet). Never throws.
 */
function extractFailures(text, { root } = {}) {
    const { ids, assertions, firstError } = scanFailures(text, { root });
    return { ids, assertions, firstError };
}

/** ids + a stable detail string from runner output; shared by the CLI and recordGateRun. */
function describeFailure(text, { root } = {}) {
    const ex = scanFailures(text, { root });
    const detail = ex.assertions.length
        ? ex.assertions.map(a => `expected ${a.expected} | saw ${a.saw}`).join('\n')
        : (ex.firstError || '');
    return { ids: ex.ids, detail, failureText: ex.failureText };
}

// ─── Reading a whole gate run ────────────────────────────────────────────────────

const SECTION_HEAD_RE = /^--- (Build|Tests|Lint|Visual|E2E)( SKIPPED[^\n]*)? ---$/;
const LOG_RULE_RE = /^={60}$/;

/**
 * Split a gate log into its legs' own text. gate.js writes `--- Build ---`, `--- Tests ---`,
 * `--- Lint ---`, `--- Visual ---` (and `--- E2E ---`) headers; a `SKIPPED` header ends a section and
 * starts none, and so does the `=====` rule that precedes the trailer. Keys are lower-case
 * (`build`, `tests`, `lint`, `visual`, `e2e`).
 */
function splitGateLog(text) {
    const sections = {};
    let name = null;
    let buf = [];
    const flush = () => {
        if (name) sections[name] = sections[name] === undefined ? buf.join('\n') : `${sections[name]}\n${buf.join('\n')}`;
    };
    for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
        const head = SECTION_HEAD_RE.exec(line);
        if (head) {
            flush();
            name = head[2] ? null : head[1].toLowerCase();
            buf = [];
            continue;
        }
        if (LOG_RULE_RE.test(line)) { flush(); name = null; buf = []; continue; }
        if (name) buf.push(line);
    }
    flush();
    return sections;
}

const LEG_SECTION = { build: 'build', test: 'tests', lint: 'lint', visual: 'visual', e2e: 'e2e' };

/** One build/lint error as a stable id: file, code and message; line and column are never in it. */
function describeBuildError(e) {
    if (!e || typeof e !== 'object') return '';
    return [e.file, e.code, e.message].map(x => (x == null ? '' : String(x).trim())).filter(Boolean).join(' ');
}

/**
 * The failing ids, detail and environment-check text of one failed gate run, leg by leg, so two
 * different build, lint, visual or E2E failures get different signatures (and a marker in one
 * leg's passing output is not read as the failure).
 *   build / lint   the parsed errors (`results.<leg>.errors`: file, code, message), ids prefixed `<leg>: `
 *   test           the test section's own runner output (ids unprefixed, so a focused run and a gate
 *                  run of the same failing test share a signature)
 *   visual / e2e   the same, ids prefixed `<leg>: `; falls back to the parsed `failures[].name`
 * A log without gate section headers is read whole for each runner leg.
 */
function describeGateFailure({ legs, output, results, root } = {}) {
    const text = typeof output === 'string' ? output : '';
    const sections = splitGateLog(text);
    const hasSections = Object.keys(sections).length > 0;
    const ids = [];
    const details = [];
    const failureTexts = [];
    for (const leg of toLegs(legs)) {
        const result = results && typeof results === 'object' && results[leg] && typeof results[leg] === 'object' ? results[leg] : null;
        const prefix = leg === 'test' ? '' : `${leg}: `;
        let legIds = [];
        if (leg === 'build' || leg === 'lint') {
            legIds = (result && Array.isArray(result.errors) ? result.errors : []).slice(0, MAX_LEG_IDS).map(describeBuildError).filter(Boolean);
            if (legIds.length) failureTexts.push(legIds.join('\n'));
        } else {
            const section = sections[LEG_SECTION[leg]];
            const legText = section !== undefined ? section : (hasSections ? '' : text);
            const d = describeFailure(legText, { root });
            legIds = d.ids;
            if (d.detail) details.push(d.detail);
            if (d.failureText) failureTexts.push(d.failureText);
            if (legIds.length === 0 && result && Array.isArray(result.failures)) {
                legIds = result.failures.slice(0, MAX_LEG_IDS).map(f => (f && typeof f.name === 'string' ? f.name : '')).filter(Boolean);
            }
        }
        for (const id of legIds) ids.push(prefix + id);
    }
    return { ids, detail: details.join('\n'), failureText: failureTexts.join('\n') };
}

// ─── Working-tree identity ───────────────────────────────────────────────────────

function git(root, args) {
    return execFileSync('git', ['--no-optional-locks', ...args], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
    });
}

function fileDigest(file) {
    try {
        const st = fs.statSync(file);
        if (!st.isFile()) return 'nonfile';
        if (st.size > MAX_HASHED_FILE_BYTES) return `big:${st.size}`;
        return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    } catch {
        return 'gone';
    }
}

/** First 16 hex of the shared code-tree hash (gate-receipt `codeTreeHash`), or null when it cannot be computed. */
function codeTreeIdentity(root) {
    try {
        const result = require('./gate-receipt').codeTreeHash(root);
        return result && result.ok ? result.hash.slice(0, 16) : null;
    } catch {
        return null;
    }
}

/**
 * Opaque working-tree identity: null when `root` is not a git work tree. Changes with HEAD, a
 * code edit (by content) or an untracked code file. It is the SAME tree definition as the ac-verify
 * records and the ship seal: `codeTreeHash` from gate-receipt.js, which leaves out docs/.output/
 * (so the ledger and every plan, handoff, review or memory note never change it), docs/work/ and
 * docs/TODO_*.md. When `codeTreeHash` cannot be computed (the root is a subdirectory of the
 * repository, a nested repository) a `git status` read with the same three exclusions stands in.
 */
function currentHead(root) {
    try {
        const top = git(root, ['rev-parse', '--show-toplevel']).trim();
        if (!top) return null;
        let head = 'nohead';
        try { head = git(root, ['rev-parse', 'HEAD']).trim() || 'nohead'; } catch { /* empty repository */ }
        const code = codeTreeIdentity(root);
        if (code) return `${head}+${code}`;

        const status = git(root, [
            'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.',
            ':(exclude)docs/.output', ':(exclude)docs/work', ':(exclude,glob)docs/TODO_*.md',
        ]);
        const tokens = status.split('\0');
        const entries = [];
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (tok.length < 4) continue;
            const xy = tok.slice(0, 2);
            const rel = tok.slice(3);
            if (xy[0] === 'R' || xy[0] === 'C') i++; // the origin path follows a rename/copy entry
            entries.push(`${xy}\t${rel}\t${fileDigest(path.join(top, rel))}`);
        }
        if (entries.length === 0) return head;
        entries.sort();
        return `${head}+${crypto.createHash('sha1').update(entries.join('\n')).digest('hex').slice(0, 16)}`;
    } catch {
        return null;
    }
}

// ─── Ledger file ─────────────────────────────────────────────────────────────────

/**
 * Append one row (tail-rotated 2000 -> 1500). Returns the written row, or null when the
 * write failed. Never throws.
 */
function appendFailure(row, { root } = {}) {
    try {
        const r = row && typeof row === 'object' ? row : {};
        const record = {
            ts: typeof r.ts === 'string' && r.ts ? r.ts : new Date().toISOString(),
            head: r.head == null ? null : String(r.head),
            sig: r.sig == null ? null : String(r.sig),
            legs: Array.isArray(r.legs) ? r.legs.map(String) : [],
            passed: r.passed === true,
            killed: r.killed == null || r.killed === false ? null : String(r.killed),
        };
        if (r.cls != null) record.cls = String(r.cls);
        if (r.log != null) record.log = String(r.log);
        let failure = null;
        appendJsonl(getLedgerPath(root || getProjectRoot()), record, {
            maxLines: MAX_LINES,
            tailKeep: TAIL_KEEP,
            onError: msg => { failure = msg || 'append failed'; },
        });
        return failure === null ? record : null;
    } catch {
        return null;
    }
}

/**
 * Ledger rows in file order; missing/unreadable/not-a-regular-file -> []; corrupt lines are skipped.
 * `tailBytes` reads only the end of the file (the hook's fast path); without it the newest 16 MB are
 * read, which is far more than the 2000-line cap ever holds.
 */
function readLedger({ root, tailBytes } = {}) {
    let text;
    try {
        const file = getLedgerPath(root || getProjectRoot());
        const cap = tailBytes > 0 ? Math.min(tailBytes, MAX_LEDGER_READ_BYTES) : MAX_LEDGER_READ_BYTES;
        const read = readRegularFile(file, { maxBytes: cap, fromEnd: true });
        if (!read) return [];
        text = read.text;
        if (read.start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    } catch {
        return [];
    }
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed);
        } catch { /* corrupt line */ }
    }
    return rows;
}

// ─── Classification ──────────────────────────────────────────────────────────────

const isKilled = r => r.killed != null && r.killed !== false && r.killed !== '';

/**
 * Whether a pass over `passLegs` says anything about a failure of `failLegs`: every failed leg must
 * have run in the pass. A row with no legs recorded (an older or hand-written row) is unspecific and
 * covers, or is covered by, anything.
 */
function legsCover(passLegs, failLegs) {
    const pass = Array.isArray(passLegs) ? passLegs : [];
    const fail = Array.isArray(failLegs) ? failLegs : [];
    if (pass.length === 0 || fail.length === 0) return true;
    return fail.every(leg => pass.includes(leg));
}

/**
 * Classify the newest non-killed outcome: none | pass | environment | flaky | noop | genuine,
 * with the streak `count` of consecutive counted failures of its signature. `flaky` needs a pass of
 * the same legs on the same tree (a lint pass says nothing about a test failure).
 */
function classify(rows) {
    const list = (Array.isArray(rows) ? rows : []).filter(r => r && typeof r === 'object' && !isKilled(r));
    if (list.length === 0) return { class: 'none', sig: null, count: 0 };
    const newest = list[list.length - 1];
    if (newest.passed === true) return { class: 'pass', sig: null, count: 0 };

    const sig = newest.sig == null ? null : newest.sig;
    if (newest.cls === 'environment') return { class: 'environment', sig, count: 0 };
    if (newest.head != null && list.slice(0, -1).some(r => r.passed === true && r.head === newest.head && legsCover(r.legs, newest.legs))) {
        return { class: 'flaky', sig, count: 0 };
    }

    const counted = list.filter(r => r.cls !== 'environment');
    let count = 0;
    let lastHead = null;
    for (let i = counted.length - 1; i >= 0; i--) {
        const r = counted[i];
        if (r.passed === true || (r.sig == null ? null : r.sig) !== sig) break;
        if (count === 0) { count = 1; lastHead = r.head; continue; }
        if (r.head != null && r.head === lastHead) continue; // same tree as the next-newer counted run
        count++;
        lastHead = r.head;
    }

    const prev = counted.length >= 2 ? counted[counted.length - 2] : null;
    const noop = prev && prev.passed !== true && (prev.sig == null ? null : prev.sig) === sig
        && newest.head != null && prev.head === newest.head;
    return { class: noop ? 'noop' : 'genuine', sig, count };
}

function streak(rows) {
    return classify(rows).count;
}

/** The one-line status text every consumer prints: `failure signature <id> seen <N> times in a row`. */
function seenLine({ sig, count, class: cls } = {}) {
    const id = sig ? String(sig).slice(0, 12) : 'unknown';
    let line = `failure signature ${id} seen ${count || 0} times in a row`;
    if (cls === 'flaky') line += ' (flaky: it also passed on this exact tree; not counted)';
    else if (cls === 'environment') line += ' (environment failure; not counted)';
    else if (cls === 'noop') line += ' (the tree is unchanged since the previous run; not counted again)';
    return line;
}

// ─── Recording ───────────────────────────────────────────────────────────────────

function toLegs(legs) {
    if (Array.isArray(legs)) return legs.map(String);
    if (typeof legs === 'string' && legs) return [legs];
    return [];
}

/**
 * Record one gate (or focused-test) run. Never throws.
 *
 * Input: { root, mode, legs, passed, killed, timedOut, ids, detail, output, results, log, head }
 *   - passed            appends a pass row (resets the streak)
 *   - killed / timedOut appends a neutral row (killed = signal name, or 'TIMEOUT')
 *   - otherwise         appends a failure row; ids/detail default to what describeFailure reads from
 *                       `output` (runner text) or, when `results` (the gate's per-leg result objects,
 *                       keyed build/test/lint/visual/e2e) is given, describeGateFailure reads leg by
 *                       leg; sig = signature(...); an environment marker in the FAILING material (an
 *                       explicit `detail`, a failing test's thrown error, a build error; never the
 *                       passing tests' output) sets cls 'environment'
 * Returns { recorded, row, sig, class, count, line }. `line` is the text to print for a
 * recorded, non-neutral failure (`failure signature <id> seen <N> times in a row`), else null;
 * gate.js prefixes it with `[GATE] `.
 */
function recordGateRun(input) {
    try {
        const o = input && typeof input === 'object' ? input : {};
        const root = typeof o.root === 'string' && o.root ? o.root : getProjectRoot();
        const legs = toLegs(o.legs);
        const head = o.head === undefined ? currentHead(root) : o.head;
        const log = typeof o.log === 'string' && o.log ? o.log : undefined;

        let row;
        let neutral = false;
        if (o.passed === true) {
            row = { head, sig: null, legs, passed: true, killed: null };
        } else if ((o.killed != null && o.killed !== false && o.killed !== '') || o.timedOut === true) {
            neutral = true;
            const killed = typeof o.killed === 'string' && o.killed ? o.killed : o.timedOut === true ? 'TIMEOUT' : 'KILLED';
            row = { head, sig: null, legs, passed: false, killed };
            if (log) row.log = log;
        } else {
            const output = typeof o.output === 'string' ? o.output : '';
            const derived = o.results && typeof o.results === 'object'
                ? describeGateFailure({ legs, output, results: o.results, root })
                : output ? describeFailure(output, { root }) : { ids: [], detail: '', failureText: '' };
            const ids = Array.isArray(o.ids) ? o.ids.map(String) : derived.ids;
            const detail = typeof o.detail === 'string' ? o.detail : derived.detail;
            const mode = o.mode == null || o.mode === '' ? legs.join('+') : String(o.mode);
            row = { head, sig: signature({ ids, detail, mode, root }), legs, passed: false, killed: null };
            if (log) row.log = log;
            if (ENVIRONMENT_RE.test(`${typeof o.detail === 'string' ? o.detail : ''}\n${derived.failureText}`)) row.cls = 'environment';
        }

        const written = appendFailure(row, { root });
        if (!written) return { recorded: false, row: null, sig: row.sig, class: 'unrecorded', count: 0, line: null };

        const c = classify(readLedger({ root }));
        const cls = neutral ? 'neutral' : c.class;
        const result = { recorded: true, row: written, sig: written.sig, class: cls, count: c.count, line: null };
        if (!neutral && !written.passed) result.line = seenLine({ sig: written.sig, count: c.count, class: c.class });
        return result;
    } catch {
        return { recorded: false, row: null, sig: null, class: 'unrecorded', count: 0, line: null };
    }
}

function newestFailureIndex(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r && r.passed !== true && !isKilled(r)) return i;
    }
    return -1;
}

function readLogText(file) {
    const read = readRegularFile(file, { maxBytes: MAX_LOG_BYTES });
    return read ? read.text : null;
}

/**
 * Text for the newest non-killed FAILURE row: the signature/streak line, then
 * `expected X | saw Y | file:line` per vitest assertion, or (for other runners) the failing
 * ids, the first error line and the log path.
 */
function lastPrompt({ root } = {}) {
    const rootDir = root || getProjectRoot();
    const rows = readLedger({ root: rootDir });
    const idx = newestFailureIndex(rows);
    if (idx < 0) return 'no failure recorded';

    const row = rows[idx];
    const c = classify(rows.slice(0, idx + 1));
    const out = [seenLine({ sig: row.sig, count: c.count, class: c.class })];

    const text = row.log ? readLogText(path.resolve(rootDir, String(row.log))) : null;
    const ex = text === null ? null : extractFailures(text, { root: rootDir });
    if (ex && ex.assertions.length) {
        for (const a of ex.assertions) {
            out.push(`expected ${a.expected} | saw ${a.saw}${a.file ? ` | ${a.file}${a.line != null ? `:${a.line}` : ''}` : ''}`);
        }
        out.push(`log: ${row.log}`);
    } else {
        out.push(`failing checks: ${ex && ex.ids.length ? ex.ids.join(', ') : 'none parsed'}`);
        out.push(`first error: ${ex && ex.firstError ? ex.firstError : 'none found'}`);
        out.push(`log: ${row.log ? row.log : 'none recorded'}`);
    }
    return out.join('\n');
}

// ─── Budget ──────────────────────────────────────────────────────────────────────

/**
 * Parse `**Budget:** attempts=3 gate-failures=6 dispatches=40 minutes=240` (space and/or comma
 * separated; the `**Budget:**` prefix and a leading `- ` are optional). Returns only the given
 * keys. Throws on an unknown or duplicate key, a non-integer or negative value, or no pairs.
 */
function parseBudget(line) {
    if (typeof line !== 'string') throw new Error('budget line must be a string');
    const body = line.replace(/^\s*[-*]\s+/, '').replace(/^\s*\*\*Budget:\*\*/i, '').replace(/^\s*Budget:/i, '').trim();
    const tokens = body.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) throw new Error('budget line has no key=value pairs');
    const limits = {};
    for (const token of tokens) {
        const eq = token.indexOf('=');
        if (eq < 0) throw new Error(`budget token "${token}" is not key=value`);
        const key = token.slice(0, eq);
        const value = token.slice(eq + 1);
        if (!BUDGET_KEYS.includes(key)) throw new Error(`unknown budget key "${key}" (expected ${BUDGET_KEYS.join(', ')})`);
        if (!/^\d+$/.test(value)) throw new Error(`budget key "${key}" needs a non-negative integer, got "${value}"`);
        if (key in limits) throw new Error(`duplicate budget key "${key}"`);
        limits[key] = Number(value);
    }
    return limits;
}

/** `YYMMDD-HHMM` (local time) -> Date; throws on a malformed stamp. */
function parseStamp(stamp) {
    const m = /^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(stamp == null ? '' : stamp));
    if (!m) throw new Error(`malformed --since "${stamp}" (expected YYMMDD-HHMM)`);
    const [yy, mo, dd, hh, mi] = m.slice(1).map(Number);
    const d = new Date(2000 + yy, mo - 1, dd, hh, mi, 0, 0);
    if (d.getFullYear() !== 2000 + yy || d.getMonth() !== mo - 1 || d.getDate() !== dd || d.getHours() !== hh || d.getMinutes() !== mi) {
        throw new Error(`malformed --since "${stamp}" (not a real date)`);
    }
    return d;
}

function dayStamps(from, to) {
    const { dateStamp } = require('./attribution-ledger');
    const stamps = [];
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12, 0, 0, 0);
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 12, 0, 0, 0);
    for (let i = 0; d <= end && i < 400; i++) {
        stamps.push(dateStamp(d));
        d.setDate(d.getDate() + 1);
    }
    return stamps;
}

/** Hook-written agent launches (PostToolUse `agent_dispatch` rows) at or after sinceMs. Never throws. */
function hookDispatches(rootDir, sinceMs) {
    let text;
    try { text = fs.readFileSync(getJsonlPath(rootDir, 'skill-usage.jsonl'), 'utf8'); } catch { return 0; }
    let n = 0;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || e.type !== 'agent_dispatch' || e.hook_event_name === 'SubagentStop') continue;
        const t = Date.parse(e.timestamp);
        if (Number.isFinite(t) && t >= sinceMs) n++;
    }
    return n;
}

/**
 * Compare usage since `since` (YYMMDD-HHMM, local) to `limits` (parseBudget output).
 * used: gate-failures (non-killed failure rows), dispatches, attempts (largest per-story
 * attribution count) and minutes elapsed. dispatches is the larger of the attribution entries and
 * the hook-written `agent_dispatch` launch rows in skill-usage.jsonl (SubagentStop rows are the same
 * dispatch ending and are not counted), so a run that skips the manual attribution append is still
 * counted (first adopter run, 2026-11-20: 0 counted after about 20 dispatches). A limited key is exceeded when
 * used > limit (strict); a key with no limit is never exceeded.
 */
function budget({ root, since, limits, now } = {}) {
    const rootDir = root || getProjectRoot();
    const sinceDate = parseStamp(since);
    const sinceMs = sinceDate.getTime();
    const nowDate = now instanceof Date ? now : new Date();
    const lim = limits && typeof limits === 'object' ? limits : {};

    const gateFailures = readLedger({ root: rootDir }).filter(r => {
        if (r.passed === true || isKilled(r)) return false;
        const t = Date.parse(r.ts);
        return Number.isFinite(t) && t >= sinceMs;
    }).length;

    const { readAttribution } = require('./attribution-ledger');
    const perStory = new Map();
    let dispatches = 0;
    for (const day of dayStamps(sinceDate, nowDate)) {
        for (const e of readAttribution(day, { root: rootDir })) {
            const t = Date.parse(e && e.timestamp);
            if (!Number.isFinite(t) || t < sinceMs) continue;
            dispatches++;
            if (e.story_id != null) perStory.set(e.story_id, (perStory.get(e.story_id) || 0) + 1);
        }
    }

    const launches = hookDispatches(rootDir, sinceMs);

    const used = {
        attempts: perStory.size ? Math.max(...perStory.values()) : 0,
        'gate-failures': gateFailures,
        dispatches: Math.max(dispatches, launches),
        minutes: Math.max(0, Math.floor((nowDate.getTime() - sinceMs) / 60000)),
    };
    const exceeded = BUDGET_KEYS.filter(k => lim[k] !== undefined && used[k] > lim[k]);
    return { used, limits: lim, exceeded, ok: exceeded.length === 0 };
}

module.exports = {
    getLedgerPath,
    getProjectRoot,
    signature,
    extractFailures,
    describeFailure,
    describeGateFailure,
    splitGateLog,
    currentHead,
    appendFailure,
    readLedger,
    classify,
    legsCover,
    streak,
    seenLine,
    recordGateRun,
    lastPrompt,
    parseBudget,
    budget,
    BUDGET_KEYS,
    parseStamp,
    dayStamps,
    isKilled,
};

// ─── CLI ─────────────────────────────────────────────────────────────────────────

const USAGE = [
    'usage: node failure-ledger.js <verb> ...',
    '  record --leg L --exit N --output-file F [--head H] [--mode M]',
    '  record --leg L --exit N (--killed SIGNAL | --timed-out) [--output-file F] [--head H]',
    '         a killed or timed-out focused run is recorded as a neutral row (never counted)',
    '  streak',
    '  last [--format prompt|json]',
    '  budget --since YYMMDD-HHMM --limits <"**Budget:** line"|plan-file>',
].join('\n');

class UsageError extends Error {}

function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const eq = a.indexOf('=');
        if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
        else { flags[a.slice(2)] = next; i++; }
    }
    return flags;
}

const str = (flags, name) => (typeof flags[name] === 'string' && flags[name] !== '' ? flags[name] : null);

const BUDGET_LITERAL_RE = /^\s*(?:[-*]\s+)?\*\*Budget:\*\*/i;

function readLimits(arg) {
    // A literal budget line is never a file name, even when a file of that name exists.
    if (BUDGET_LITERAL_RE.test(arg)) return parseBudget(arg);
    let isFile = false;
    try { isFile = fs.statSync(arg).isFile(); } catch { /* not a file: treat as a literal line */ }
    if (!isFile) return parseBudget(arg);
    const read = readRegularFile(arg, { maxBytes: MAX_LOG_BYTES });
    if (!read) throw new UsageError(`cannot read the --limits file ${arg}`);
    const match = /^[ \t]*(?:[-*][ \t]+)?\*\*Budget:\*\*.*$/m.exec(read.text);
    if (!match) throw new UsageError(`no **Budget:** line found in ${arg}`);
    return parseBudget(match[0]);
}

const flagOn = (flags, name) => flags[name] !== undefined && flags[name] !== false && flags[name] !== 'false' && flags[name] !== '0';

function cliRecord(flags, root, write) {
    const leg = str(flags, 'leg');
    if (!leg) throw new UsageError('record: --leg is required');
    const exitArg = str(flags, 'exit');
    if (exitArg === null || !/^-?\d+$/.test(exitArg)) throw new UsageError('record: --exit must be an integer');
    const head = str(flags, 'head') === null ? undefined : str(flags, 'head');
    if (Number(exitArg) === 0) {
        recordGateRun({ root, legs: [leg], passed: true, head });
        return 0;
    }
    const file = str(flags, 'output-file');
    // Resolved now, so a later `last --format prompt` from another working directory reads the same file.
    const log = file ? path.resolve(file) : undefined;

    const killedArg = str(flags, 'killed');
    const timedOut = flagOn(flags, 'timed-out');
    if (killedArg || timedOut) {
        const neutral = recordGateRun({ root, legs: [leg], passed: false, killed: killedArg || null, timedOut, head, log });
        if (neutral.recorded) write(`neutral run recorded (${neutral.row.killed}); not counted toward escalation\n`);
        else process.stderr.write('failure-ledger: could not write the ledger; the run was not recorded\n');
        return 0;
    }

    if (!file) throw new UsageError('record: --output-file is required for a failing --exit');
    const read = readRegularFile(file, { maxBytes: MAX_LOG_BYTES });
    if (!read) throw new UsageError(`record: cannot read --output-file ${file} (missing, unreadable or not a regular file)`);
    const result = recordGateRun({ root, legs: [leg], passed: false, output: read.text, log, head, mode: str(flags, 'mode') || undefined });
    if (result.recorded && result.line) write(result.line + '\n');
    else if (!result.recorded) process.stderr.write('failure-ledger: could not write the ledger; the failure was not recorded\n');
    return 0;
}

function cliLast(flags, root, write) {
    const format = flags.format === undefined ? 'json' : flags.format;
    if (format !== 'json' && format !== 'prompt') throw new UsageError(`last: unknown --format "${format}" (json|prompt)`);
    if (format === 'prompt') { write(lastPrompt({ root }) + '\n'); return 0; }
    const rows = readLedger({ root });
    const idx = newestFailureIndex(rows);
    write((idx < 0 ? 'null' : JSON.stringify(rows[idx])) + '\n');
    return 0;
}

function cliBudget(flags, root, write) {
    const since = str(flags, 'since');
    if (!since) throw new UsageError('budget: --since is required');
    const limitsArg = str(flags, 'limits');
    if (!limitsArg) throw new UsageError('budget: --limits is required');
    parseStamp(since);
    const limits = readLimits(limitsArg);
    const result = budget({ root, since, limits });
    for (const key of BUDGET_KEYS) {
        if (limits[key] !== undefined) write(`${key}: ${result.used[key]}/${limits[key]}\n`);
    }
    write(result.ok ? 'budget: ok\n' : `budget: EXHAUSTED (${result.exceeded.join(', ')})\n`);
    return result.ok ? 0 : 12;
}

function main(argv) {
    const [verb, ...rest] = argv;
    const flags = parseFlags(rest);
    const root = getProjectRoot();
    const write = s => process.stdout.write(s);
    try {
        if (verb === 'record') return cliRecord(flags, root, write);
        if (verb === 'streak') { write(`${streak(readLedger({ root }))}\n`); return 0; }
        if (verb === 'last') return cliLast(flags, root, write);
        if (verb === 'budget') return cliBudget(flags, root, write);
        throw new UsageError(verb ? `unknown verb "${verb}"` : 'a verb is required');
    } catch (e) {
        process.stderr.write(`failure-ledger: ${e.message}\n${USAGE}\n`);
        return 2;
    }
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}
