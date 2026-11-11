// Tests for the secret engine wrapper (hooks/secret-engine.cjs) and the contract the hooks rely on:
// the real Betterleaks binary for detection, redaction, the allow marker, ignore files and bypass
// attempts; a fake engine (the node binary behind a preload, see _helpers/fake-engine.js, so it runs
// on Windows too) for the fault paths: missing, failing, hanging, malformed or skipping.
//
// Key-shaped fixtures are built from parts so this file never holds a complete key literal.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
const engine = require('../../../.agents/hooks/secret-engine.cjs');
const patterns = require('../../../.agents/hooks/secret-patterns.cjs');
const binLib = require('../../../.agents/core/_lib/secret-engine-bin');
const { createFakeEngineKit } = require('./_helpers/fake-engine');
const { SIGNATURES } = require('./_helpers/engine-signatures');

const j = (...p) => p.join('');
const STRIPE = j('sk_', 'live_', 'aB3xK9mP2qR7tY1wZ5nC8vD4');
const STRIPE_2 = j('sk_', 'live_', 'Zq8Lm3Xv7Tn2Rb5Wc9Yd4Pf6');
const GITHUB = j('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const AWS = j('AKIA', 'QW3ERTY7UIOPAS2D');
const PASSWORD = j('Zx9Qm4', 'Lp2Rt7');
const MARK = j('betterleaks', ':allow');
const GMARK = j('gitleaks', ':allow');

// The project's ignore list is read from the INDEX (else HEAD), never from the working tree: these helpers build a
// real repository around a project root.
function gitRepo(dir) {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.invalid'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) {
        spawnSync('git', args, { cwd: dir, windowsHide: true });
    }
}
function gitRun(dir, ...args) {
    return spawnSync('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8' });
}
/** Write an ignore file and stage it (so it is the version a commit scan would read). */
function stageIgnore(dir, text, name = '.betterleaksignore') {
    fs.writeFileSync(path.join(dir, name), text);
    gitRun(dir, 'add', '--', name);
}

const savedEnv = {};
const touched = ['AGENTS_SECRET_ENGINE_BIN', 'SECRET_ENGINE_TIMEOUT_MS', 'CLAUDE_PROJECT_DIR', 'SECRET_ENGINE_QUIET', 'AGENTS_SECRET_ENGINE_CACHE_DIR', 'VITEST', 'NODE_ENV'];
let tmp;
let kit;

beforeEach(() => {
    for (const k of touched) savedEnv[k] = process.env[k];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-engine-test-'));
    kit = createFakeEngineKit(path.join(tmp, 'kit'));
    process.env.SECRET_ENGINE_QUIET = '1';
    engine.resetForTests();
});

afterEach(() => {
    kit.restore();
    for (const k of touched) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    engine.resetForTests();
});

// A fake that reports what it scanned, as the real engine does, then runs `inner` with (text, args).
const scanning = inner => `
const chunks = []; process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks); const text = input.toString('utf8'); const args = process.argv.slice(2);
  process.stderr.write('INF scanned ~' + input.length + ' bytes (' + input.length + ' bytes) in 1ms\\n');
  ${inner}
});`;
const raw = body => `process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => { ${body} });`;

// Make `body` the engine for this process and the hooks it spawns. The fake passes the identity check by
// having its own real hash pinned (see _helpers/fake-engine.js); nothing in the environment skips the check.
function useFake(body) {
    engine.resetForTests();
    process.env.AGENTS_SECRET_ENGINE_BIN = kit.exe();
    kit.apply(body);
    kit.usePins();
}

const hookPath = name => path.join(__dirname, '..', name);
function runHook(name, payload, env = {}, extraEnv = {}) {
    return spawnSync(process.execPath, [hookPath(name)], {
        input: JSON.stringify(payload), encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, ...env, ...extraEnv },
    });
}
const writeOf = (content, file = 'src/a.js') => ({ tool_name: 'Write', tool_input: { file_path: file, content } });
const bashOf = stdout => ({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout } });

describe('the real engine is installed', () => {
    it('resolves a verified binary (install: node .claude/core/secret-engine-install.js)', () => {
        const status = engine.engineStatus({ fresh: true });
        expect(status.available, status.message).toBe(true);
        if (status.source !== 'env') expect(binLib.binaryVersion(status.bin)).toBe(binLib.loadPins().version);
    });
});

describe('scanContent: the finding contract', () => {
    it('returns type, name, file, line and a redacted match', () => {
        const findings = engine.scanContent(`const a = 1;\nconst k = "${STRIPE}";\n`, 'src/pay.js');
        expect(findings).toEqual([{
            type: 'SECRET_PATTERN',
            name: 'Stripe Key',
            file: 'src/pay.js',
            line: 2,
            match: `[REDACTED:Stripe Key len=${STRIPE.length}]`,
        }]);
    });

    it('never puts a named-provider value in the match', () => {
        const [f] = engine.scanContent(`token=${GITHUB}`, 'a.env.txt');
        expect(JSON.stringify(f)).not.toContain(GITHUB.slice(4, 20));
    });

    it('keeps a generic value to head...tail', () => {
        const [f] = engine.scanContent(`DB_PASSWORD=${PASSWORD}\n`, 'config.env.txt');
        expect(f.name).toBe('Password Assignment (Unquoted)');
        expect(f.match).toBe(`${PASSWORD.slice(0, 4)}***`);
    });

    it('labels the file <stdin> when no path is given', () => {
        expect(engine.scanContent(`k="${STRIPE}"`)[0].file).toBe('<stdin>');
    });

    it('flags a sensitive file name from the path alone (HIGH_RISK_FILE) and still scans the content', () => {
        const findings = engine.scanContent(`DB_PASSWORD=${PASSWORD}\n`, 'deploy/.env');
        expect(findings[0]).toMatchObject({ type: 'HIGH_RISK_FILE', line: 0, match: '.env' });
        expect(findings.some(f => f.type === 'SECRET_PATTERN')).toBe(true);
    });

    it('does not start the engine for whitespace-only content, but keeps the path check', () => {
        process.env.AGENTS_SECRET_ENGINE_BIN = path.join(tmp, 'no-such-engine');
        engine.resetForTests();
        expect(engine.scanContent('  \n\t\n', 'src/a.js')).toEqual([]);
        expect(engine.scanContent('   ', '.env')).toHaveLength(1);
    });

    it('coerces non-string content instead of throwing', () => {
        expect(engine.scanContent(12345, 'a.js')).toEqual([]);
        expect(engine.scanContent(null, 'a.js')).toEqual([]);
        expect(engine.scanContent(undefined, '.env')[0].type).toBe('HIGH_RISK_FILE');
    });

    it('orders findings by line', () => {
        const text = `a="${STRIPE}"\nb=1\nc="${GITHUB}"\n`;
        expect(engine.scanContent(text, 'x.js').map(f => f.line)).toEqual([1, 3]);
    });

    it('scans an input of several kilobytes and a few megabytes (the engine reports its size in KB and MB)', () => {
        for (const bytes of [1500, 70000, 3000000]) {
            const text = `${'The quick brown fox jumps over the lazy dog.\n'.repeat(Math.ceil(bytes / 45))}k = "${STRIPE}"\n`;
            expect(engine.scanContent(text, 'big.log').map(f => f.name)).toEqual(['Stripe Key']);
        }
    });

    it('counts a multibyte input by bytes, not characters', () => {
        const text = `// ünïcödé ✓ 日本語 😀\nk = "${STRIPE}"\n`;
        expect(engine.scanContent(text, 'u.js').map(f => f.line)).toEqual([2]);
    });

    it('reports a secret that two rules find, with and without its quotes, once', () => {
        const found = engine.scanContent(`password = "${PASSWORD}"\n`, 'infra/main.tf').filter(f => f.type === 'SECRET_PATTERN');
        expect(found.map(f => f.name)).toEqual(['Password Assignment']);
        const named = engine.scanContent(`administrator_login_password = "${PASSWORD}"\n`, 'infra/db.tf').filter(f => f.type === 'SECRET_PATTERN');
        expect(named).toHaveLength(1);
    });

    it('reports a bearer token that is also a JWT as both', () => {
        const jwt = j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
        const names = engine.scanContent(`Authorization: Bearer ${jwt}`, 'req.http').map(f => f.name);
        expect(names).toContain('JWT Token');
        expect(names).toContain('Bearer Token');
    });

    it('reports the same value twice on one line as two findings (each is redacted and baselined on its own)', () => {
        const names = engine.scanContent(`a=${STRIPE} b=${STRIPE}\n`, 'x.txt').map(f => f.name);
        expect(names).toEqual(['Stripe Key', 'Stripe Key']);
        expect(engine.scanContent(`a=${STRIPE}\nb=${STRIPE}\n`, 'x.txt').map(f => f.line)).toEqual([1, 2]);
    });

    it('names a PGP key block as a PGP Private Key and an RSA key as a Private Key', () => {
        const pgp = j('-----BEGIN ', 'PGP PRIVATE KEY BLOCK-----\nlQdGBFabcdEFGH0123456789wxyz\n-----END ', 'PGP PRIVATE KEY BLOCK-----');
        const rsa = j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabcdEFGH0123456789wx\n-----END ', 'RSA PRIVATE KEY-----');
        expect(engine.scanContent(pgp, 'k.txt').map(f => f.name)).toContain('PGP Private Key');
        expect(engine.scanContent(rsa, 'k.txt').map(f => f.name)).toEqual(['Private Key']);
    });

    it('gives a built-in rule with no mapping a readable name', () => {
        expect(engine.titleCase('hashicorp-tf-password')).toBe('Hashicorp TF Password');
        expect(engine.titleCase('some-vendor-api-key.1')).toBe('Some Vendor API Key');
        expect(engine.titleCase('gcp-pat-id')).toBe('GCP PAT ID');
    });
});

describe('namedProvidersOnly (test and spec files)', () => {
    it('drops the generic credential rules and keeps the named providers', () => {
        const text = `const password = "${PASSWORD}";\nconst k = "${STRIPE}";\n`;
        expect(engine.scanContent(text, 'src/a.js').map(f => f.name).sort()).toEqual(['Password Assignment', 'Stripe Key']);
        expect(engine.scanContent(text, 'src/a.test.js', { namedProvidersOnly: true }).map(f => f.name)).toEqual(['Stripe Key']);
    });

    it('exempts only the documented AWS example key, and only in test paths', () => {
        const example = j('AKIAIOSFODNN7', 'EXAMPLE');
        expect(engine.scanContent(`k="${example}"`, 'src/a.js').map(f => f.name)).toEqual(['AWS Access Key']);
        expect(engine.scanContent(`k="${example}"`, 'src/a.test.js', { namedProvidersOnly: true })).toEqual([]);
        expect(engine.scanContent(`k="${example}"`, 'src/__tests__/a.js', { namedProvidersOnly: true })).toEqual([]);
        expect(engine.scanContent(`k="${AWS}"`, 'src/a.test.js', { namedProvidersOnly: true })).toHaveLength(1);
    });
});

// ── the allow marker (D3, tightened) ──────────────────────────────────────────

describe('allow marker: a trailing comment, on the same physical line, for one secret', () => {
    const scan = (text, file = 'src/a.js') => engine.scanContent(text, file).filter(f => f.type === 'SECRET_PATTERN');

    it.each([
        ['a // comment', `const k = "${AWS}"; // ${MARK}\n`, 'src/a.js'],
        ['a # comment', `KEY = "${AWS}" # ${GMARK}\n`, 'cfg/a.py'],
        ['a /* block */ comment', `const k = "${AWS}"; /* ${MARK} */\n`, 'src/a.js'],
        ['an html comment', `<p data-k="${AWS}"> <!-- ${MARK} -->\n`, 'docs/a.html'],
        ['a CRLF line ending after the marker', `const k = "${AWS}"; // ${MARK}\r\n`, 'src/a.js'],
        ['code between the key and the comment', `foo("${AWS}", 1); // ${MARK}\n`, 'src/a.js'],
    ])('suppresses a finding with %s', (_n, text, file) => {
        expect(scan(text, file)).toEqual([]);
    });

    it.each([
        ['inside a string literal that follows the key', `const k = "${AWS}", note = "${MARK}";\n`],
        ['inside a string that contains a comment opener', `const k = "${AWS}"; const s = "// ${MARK}";\n`],
        ['glued to the key inside the same literal', `const k = "${AWS}${MARK}";\n`],
        ['glued to the key with no comment opener', `const k = ${AWS} ${MARK}\n`],
        ['before the key on the same line', `/* ${MARK} */ const k = "${AWS}";\n`],
        ['in an identifier', `const k = "${AWS}"; // x${MARK}\n`],
        ['in upper case', `const k = "${AWS}"; // ${MARK.toUpperCase()}\n`],
        ['after a lone CR (a CR is not a line end for the comment)', `const k = "${AWS}"; // note\r${MARK}\n`],
        ['after a U+2028 line separator (it ends a JS comment)', `const k = "${AWS}"; // ${MARK}\n`],
        ['after a U+2029 paragraph separator', `const k = "${AWS}"; // ${MARK}\n`],
    ])('does not suppress a marker %s', (_n, text) => {
        expect(scan(text)).toHaveLength(1);
    });

    it('does not carry over to the next line, with LF or CRLF', () => {
        for (const eol of ['\n', '\r\n']) {
            expect(scan(`// ${MARK}${eol}const k = "${AWS}";${eol}`).map(f => f.line)).toEqual([2]);
        }
    });

    it('never covers a multi-line finding, wherever the marker is (begin, body or end line of a key block)', () => {
        const begin = j('-----BEGIN ', 'RSA PRIVATE KEY-----');
        const end = j('-----END ', 'RSA PRIVATE KEY-----');
        const body = 'MIIEowIBAAKCAQEAabcdEFGH0123456789wxyz';
        for (const text of [
            `${begin} # ${MARK}\n${body}\n${end}\n`,
            `${begin}\n${body} # ${MARK}\n${end}\n`,
            `${begin}\n${body}\n${end} # ${MARK}\n`,
        ]) {
            expect(scan(text, 'key.txt').map(f => f.name)).toContain('Private Key');
        }
    });

    it('covers one secret per marker: of two different keys on a line only one is allowed', () => {
        const found = scan(`const a = "${GITHUB}", b = "${STRIPE}"; // ${MARK}\n`);
        expect(found).toHaveLength(1);
    });

    it('does not cover the second copy of the same value on that line', () => {
        const found = scan(`const a = "${AWS}", b = "${AWS}"; // ${MARK}\n`);
        expect(found).toHaveLength(1);
    });

    it('covers every rule that reported that one value (a token that is also a JWT)', () => {
        const jwt = j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
        expect(scan(`Authorization: Bearer ${jwt} # ${MARK}\n`, 'req.txt')).toEqual([]);
    });

    it('covers only findings that start on the line that carries the marker', () => {
        const found = scan(`const a = "${AWS}";\nconst b = "${GITHUB}"; // ${MARK}\n`);
        expect(found.map(f => f.line)).toEqual([1]);
    });

    it('is not honored by the redactor: a marked key is still masked', () => {
        const text = `const k = "${AWS}"; // ${MARK}\n`;
        expect(engine.redactSecretsInText(text, 'a.js')).not.toContain(AWS);
    });

    it('is not honored when a caller asks for honorMarkers: false (scrubber, safe-write, intake)', () => {
        expect(engine.scanContent(`k="${AWS}" // ${MARK}\n`, 'a.js', { honorMarkers: false })).toHaveLength(1);
    });

    it('is reported on stderr, rule name and line only, never the value', () => {
        delete process.env.SECRET_ENGINE_QUIET;
        const writes = [];
        const original = process.stderr.write;
        process.stderr.write = chunk => { writes.push(String(chunk)); return true; };
        try {
            engine.scanContent(`\nconst k = "${AWS}"; // ${MARK}\n`, 'a.js');
        } finally {
            process.stderr.write = original;
        }
        const note = writes.join('');
        expect(note).toMatch(/suppressed 1 finding\(s\): AWS Access Key@2/);
        expect(note).not.toContain(AWS);
    });
});

describe('ignore file: .betterleaksignore, whole-file scans only', () => {
    const fingerprints = (file, line = 1) => [
        `${file}:stripe-access-token:${line}`,
        `${file}:domdhi-stripe-key:${line}`,
    ].join('\n') + '\n';
    let root;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(tmp, 'proj-'));
        gitRepo(root);
        process.env.CLAUDE_PROJECT_DIR = root;
        engine.resetForTests();
    });
    const text = `k = "${STRIPE}"\n`;
    const names = list => list.filter(f => f.type === 'SECRET_PATTERN').map(f => f.name);

    it('suppresses a whole-file finding at the fingerprinted path, rule and line only', () => {
        stageIgnore(root, fingerprints('src/legacy.js'));
        const file = path.join(root, 'src', 'legacy.js');
        expect(names(engine.scanContent(text, file, { wholeFile: true }))).toEqual([]);
        expect(names(engine.scanContent(text, path.join(root, 'src', 'other.js'), { wholeFile: true }))).toHaveLength(1);
        expect(names(engine.scanContent(`x\n${text}`, file, { wholeFile: true }))).toHaveLength(1);
    });

    it('is not applied to a fragment (an Edit restarts its line numbers at 1)', () => {
        stageIgnore(root, fingerprints('src/legacy.js'));
        const file = path.join(root, 'src', 'legacy.js');
        expect(names(engine.scanContent(text, file))).toHaveLength(1);
        expect(names(engine.scanContent(text, file, { wholeFile: false }))).toHaveLength(1);
    });

    it('does not honor .gitleaksignore, even for a whole-file scan', () => {
        stageIgnore(root, fingerprints('src/legacy.js'), '.gitleaksignore');
        expect(names(engine.scanContent(text, path.join(root, 'src', 'legacy.js'), { wholeFile: true }))).toHaveLength(1);
    });

    it('needs every rule that fires: listing one fingerprint for a token that fires two rules leaves a finding', () => {
        const file = 'src/legacy.js';
        stageIgnore(root, `${file}:domdhi-github-token:1\n`);
        const found = engine.scanContent(`t = "${GITHUB}"\n`, path.join(root, file), { wholeFile: true });
        expect(names(found)).toHaveLength(1);
        stageIgnore(root, `${file}:domdhi-github-token:1\n${file}:github-pat:1\n`);
        engine.resetForTests();
        process.env.CLAUDE_PROJECT_DIR = root;
        expect(names(engine.scanContent(`t = "${GITHUB}"\n`, path.join(root, file), { wholeFile: true }))).toEqual([]);
    });

    it('is bound to the line, not the value: a different key on the fingerprinted line stays suppressed (documented limit)', () => {
        stageIgnore(root, fingerprints('src/legacy.js'));
        const other = `k = "${STRIPE_2}"\n`;
        expect(names(engine.scanContent(other, path.join(root, 'src', 'legacy.js'), { wholeFile: true }))).toEqual([]);
    });

    it('ignores a stray ignore file in the process working directory', () => {
        const stray = fs.mkdtempSync(path.join(tmp, 'cwd-'));
        fs.writeFileSync(path.join(stray, '.betterleaksignore'), fingerprints('src/a.js'));
        fs.writeFileSync(path.join(stray, '.gitleaksignore'), fingerprints('src/a.js'));
        const previous = process.cwd();
        process.chdir(stray);
        try {
            expect(names(engine.scanContent(text, 'src/a.js'))).toHaveLength(1);
            expect(names(engine.scanContent(text, 'src/a.js', { wholeFile: true }))).toHaveLength(1);
        } finally {
            process.chdir(previous);
        }
    });

    it('does not apply the project ignore file to content that needed the one-newline rescan (its lines are shifted)', () => {
        stageIgnore(root, fingerprints('src/legacy.js', 2));
        const file = path.join(root, 'src', 'legacy.js');
        const [, prefix] = SIGNATURES[0];
        expect(names(engine.scanContent(`${prefix}\nk = "${STRIPE}"\n`, file, { wholeFile: true }))).toHaveLength(1);
    });

    // SEC-MAJOR-7: a suppression counts once it is part of what is reviewed and committed.
    it('SEC-MAJOR-7: an UNTRACKED ignore file suppresses nothing', () => {
        fs.writeFileSync(path.join(root, '.betterleaksignore'), fingerprints('src/legacy.js'));
        expect(names(engine.scanContent(text, path.join(root, 'src', 'legacy.js'), { wholeFile: true }))).toHaveLength(1);
    });

    it('SEC-MAJOR-7: an UNSTAGED edit of a committed ignore file suppresses nothing (the committed list applies)', () => {
        stageIgnore(root, '# reviewed\n');
        gitRun(root, 'commit', '-q', '-m', 'ignore list', '--no-verify');
        fs.writeFileSync(path.join(root, '.betterleaksignore'), fingerprints('src/legacy.js')); // modified, not staged
        expect(names(engine.scanContent(text, path.join(root, 'src', 'legacy.js'), { wholeFile: true }))).toHaveLength(1);
    });

    it('SEC-MAJOR-7: a STAGED ignore file applies, and so does a committed one when the index lacks it (HEAD fallback)', () => {
        stageIgnore(root, fingerprints('src/legacy.js'));
        const file = path.join(root, 'src', 'legacy.js');
        expect(names(engine.scanContent(text, file, { wholeFile: true }))).toEqual([]);
        gitRun(root, 'commit', '-q', '-m', 'ignore list', '--no-verify');
        gitRun(root, 'rm', '-q', '--cached', '.betterleaksignore');
        expect(names(engine.scanContent(text, file, { wholeFile: true }))).toEqual([]);
    });

    it('SEC-MAJOR-7: outside a repository there is no list at all', () => {
        const plain = fs.mkdtempSync(path.join(tmp, 'plain-'));
        fs.writeFileSync(path.join(plain, '.betterleaksignore'), fingerprints('src/legacy.js'));
        process.env.CLAUDE_PROJECT_DIR = plain;
        expect(names(engine.scanContent(text, path.join(plain, 'src', 'legacy.js'), { wholeFile: true }))).toHaveLength(1);
    });

    it('an explicit ignore set or predicate (the commit scans pass the index version) wins over the project lookup', () => {
        const file = path.join(root, 'src', 'legacy.js');
        const rel = 'src/legacy.js';
        const set = new Set([`${rel}:stripe-access-token:1`, `${rel}:domdhi-stripe-key:1`]);
        expect(names(engine.scanContent(text, rel, { wholeFile: true, ignore: set }))).toEqual([]);
        expect(names(engine.scanContent(text, rel, { wholeFile: true, ignore: () => false }))).toHaveLength(1);
        expect(names(engine.scanContent(text, file, { wholeFile: true, ignore: set }))).toEqual([]);
    });
});

describe('ignore file: value-sha256 entries pin one reviewed value, not a location', () => {
    // A generic match (no provider prefix) built from parts: the shape of a reviewed public key.
    const VALUE = j('Zk3', 'pQ9xL2mN7vB4cR8tY1wE6', 'uI0oP5aS3dF9gH2jK7lZ4x=');
    const OTHER = j('Qw8', 'rT5yU2iO9pA4sD7fG1hJ3', 'kL6zX0cV8bN5mQ2wE9rT4y=');
    const sha = v => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
    const names = list => list.filter(f => f.type === 'SECRET_PATTERN').map(f => f.name);
    let root;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(tmp, 'proj-'));
        gitRepo(root);
        process.env.CLAUDE_PROJECT_DIR = root;
        engine.resetForTests();
    });

    it('valueAllowKey hashes the value with its surrounding quotes removed, and never contains the value', () => {
        expect(engine.valueAllowKey(VALUE)).toBe(`value-sha256:${sha(VALUE)}`);
        expect(engine.valueAllowKey(`"${VALUE}"`)).toBe(engine.valueAllowKey(VALUE));
        expect(engine.valueAllowKey(VALUE)).not.toContain(VALUE);
    });

    it('parseIgnore keeps a full 64-hex entry (any case, optional "# reason"), normalized, and drops malformed ones', () => {
        const h = sha(VALUE);
        const set = engine.parseIgnore([
            `value-sha256:${h}  # reviewed: RustDesk server public key`,
            `VALUE-SHA256:${sha(OTHER).toUpperCase()}`,
            `value-sha256:${h.slice(0, 63)}`,          // a prefix: allows nothing
            `value-sha256:${h}0`,                       // 65 digits
            `value-sha256:${h.slice(0, 60)}zzzz`,       // not hex
            `value-sha256:${h}# glued comment`,          // the reason needs whitespace before it
            'value-sha256:',
            'src/a.js:generic-api-key:3',
        ].join('\n'));
        expect([...set].sort()).toEqual([
            'src/a.js:generic-api-key:3',
            `value-sha256:${h}`,
            `value-sha256:${sha(OTHER)}`,
        ].sort());
    });

    it('suppresses that value at any path and line in a whole-file scan, and no other value', () => {
        stageIgnore(root, `value-sha256:${sha(VALUE)} # reviewed\n`);
        expect(names(engine.scanContent(`key = "${VALUE}"\n`, path.join(root, 'a', 'one.ps1'), { wholeFile: true }))).toEqual([]);
        expect(names(engine.scanContent(`x\ny\nTOKEN=${VALUE}\n`, path.join(root, 'b', 'two.sh'), { wholeFile: true }))).toEqual([]);
        expect(names(engine.scanContent(`key = "${OTHER}"\n`, path.join(root, 'a', 'one.ps1'), { wholeFile: true }))).toHaveLength(1);
    });

    it('a value pin clears generic matches only: a named provider key with a pinned value is still reported', () => {
        const named = engine.scanContent(`const k = "${STRIPE}";\n`, 'src/a.js').filter(f => f.type === 'SECRET_PATTERN');
        expect(named.length).toBeGreaterThan(0);
        stageIgnore(root, `value-sha256:${sha(STRIPE)}\n`);
        expect(names(engine.scanContent(`const k = "${STRIPE}";\n`, path.join(root, 'src', 'a.js'), { wholeFile: true })).length).toBeGreaterThan(0);
    });

    it('parseIgnore reads a file PowerShell 5.1 appended as UTF-16LE', () => {
        const h = sha(VALUE);
        const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`value-sha256:${h} # reviewed\r\n`, 'utf16le')]);
        expect([...engine.parseIgnore(utf16.toString('utf8'))]).toEqual([`value-sha256:${h}`]);
    });

    it('a prefix of the hash allows nothing', () => {
        stageIgnore(root, `value-sha256:${sha(VALUE).slice(0, 32)}\n`);
        expect(names(engine.scanContent(`key = "${VALUE}"\n`, path.join(root, 'one.ps1'), { wholeFile: true }))).toHaveLength(1);
    });

    it('like every ignore entry, it does not apply to an Edit fragment', () => {
        stageIgnore(root, `value-sha256:${sha(VALUE)}\n`);
        expect(names(engine.scanContent(`key = "${VALUE}"\n`, path.join(root, 'one.ps1')))).toHaveLength(1);
    });

    it('findings of a generic match carry the allowKey; named-provider findings do not', () => {
        const generic = engine.scanContent(`key = "${VALUE}"\n`, 'one.ps1').filter(f => f.type === 'SECRET_PATTERN');
        expect(generic.map(f => f.allowKey)).toEqual([`value-sha256:${sha(VALUE)}`]);
        const named = engine.scanContent(`const k = "${STRIPE}";\n`, 'src/a.js').filter(f => f.type === 'SECRET_PATTERN');
        expect(named.length).toBeGreaterThan(0);
        expect(named.every(f => f.allowKey === undefined)).toBe(true);
    });

    it('formatFindings prints the Allow line only when asked (the git hooks), never the value', () => {
        const found = engine.scanContent(`key = "${VALUE}"\n`, 'one.ps1');
        expect(patterns.formatFindings(found)).not.toMatch(/value-sha256/);
        const report = patterns.formatFindings(found, { valueKeys: true });
        expect(report).toContain(`Allow: value-sha256:${sha(VALUE)}`);
        expect(report).not.toContain(VALUE);
        expect(patterns.bypassAdvice(found)).toMatch(/value-sha256/);
        expect(patterns.bypassAdvice(engine.scanContent(`const k = "${STRIPE}";\n`, 'src/a.js'))).not.toMatch(/value-sha256/);
    });
});

describe('binary-looking text is still scanned (the engine skips input that starts with a file signature)', () => {
    it.each(SIGNATURES)('%s: a key behind the signature is found, on its real line', (_label, prefix) => {
        const text = `${prefix}\nnotes\nconst k = "${STRIPE}";\n`;
        const keyLine = text.slice(0, text.indexOf('const k')).split('\n').length;
        const found = engine.scanContent(text, 'src/a.js').filter(f => f.type === 'SECRET_PATTERN');
        expect(found.map(f => [f.name, f.line])).toEqual([['Stripe Key', keyLine]]);
    });

    it.each(SIGNATURES)('%s: the redactor masks it', (_label, prefix) => {
        const out = engine.redactSecretsInText(`${prefix}\nconst k = "${STRIPE}";\n`, 'src/a.js');
        expect(out).not.toContain(STRIPE);
        expect(out).toContain('<REDACTED:Stripe Key>');
    });

    it('works when the key is on the signature line itself', () => {
        const found = engine.scanContent(`PK\x03\x04 ${STRIPE}`, 'src/a.js').filter(f => f.type === 'SECRET_PATTERN');
        expect(found.map(f => f.line)).toEqual([1]);
    });

    it('fails closed if the input is skipped even behind the newline', () => {
        useFake(raw(`process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('[]');`));
        // the fake always says it scanned 0 bytes: the first run and the rescan both look skipped
        let thrown;
        try { engine.scanContent('PK\x03\x04 anything\n', 'a.js'); } catch (err) { thrown = err; }
        expect(thrown).toBeInstanceOf(engine.EngineFailedError);
        expect(thrown.detail.reason).toBe('input-skipped');
    });

    it('fails closed when the engine does not report what it scanned', () => {
        useFake(raw(`process.stderr.write('INF nothing useful\\n'); console.log('[]');`));
        expect(() => engine.scanContent('hello world\n', 'a.js')).toThrow(/did not scan the whole input/);
    });

    it('the redactor falls back to the named-provider list when the input stays skipped', () => {
        useFake(raw(`process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('[]');`));
        const out = patterns.redactSecretsInText(`PK\x03\x04\nk=${GITHUB}\n`, 'a.txt');
        expect(out).toContain('<REDACTED:GitHub Token>');
    });

    describe('on the Write hook', () => {
        it.each(SIGNATURES)('%s: exit 2', (_label, prefix) => {
            const r = runHook('secret-scanner.cjs', writeOf(`${prefix}\nconst k = "${AWS}";\nconst g = "${GITHUB}";\n`));
            expect(r.status).toBe(2);
            expect(r.stderr).toMatch(/AWS Access Key/);
        });
    });

    describe('on the output scrubber', () => {
        it.each(SIGNATURES)('%s: the key comes back redacted', (_label, prefix) => {
            const r = runHook('post-read-scrubber.cjs', bashOf(`${prefix}\nSTRIPE=${STRIPE}\n`));
            expect(r.status).toBe(0);
            const out = JSON.parse(r.stdout.trim()).hookSpecificOutput.updatedToolOutput;
            expect(out).not.toContain(STRIPE);
            expect(out).toContain('<REDACTED:Stripe Key>');
        });
    });
});

describe('bypass attempts the engine must catch', () => {
    const k = STRIPE;
    it.each([
        ['a real-format key next to an interpolation', `const url = \`https://x/\${id}?key=${k}&a=\${b}\`;`, 'src/a.js'],
        ['a key prefix glued to a variable', `const k = prefix${k};`, 'src/a.js'],
        ['a key glued to the end of another word', `const k = "xx${k}";`, 'src/a.js'],
        ['a key concatenated with a function call', `const k = "${k}" + suffix() + "x";`, 'src/a.js'],
        ['a key on the line after an allow marker', `// ${MARK}\nconst k = "${k}";`, 'src/a.js'],
        ['a key inside a markdown fence', `\`\`\`js\nconst k = "${k}";\n\`\`\``, 'docs/guide.md'],
        ['a key in a test file (named provider)', `const k = "${k}";`, 'src/a.test.js'],
        ['a key in a vendor path the engine would skip by default', `const k = "${k}";`, 'vendor/github.com/x/y.js'],
        ['a key in a node_modules-looking path the engine would skip by default', `const k = "${k}";`, 'src/node_modules/x.js'],
        ['a key in an image-looking file name', `const k = "${k}";`, 'assets/logo.png'],
        ['a base64-wrapped key', `blob = "${Buffer.from(k).toString('base64')}"`, 'src/a.js'],
        ['a hex-encoded key', `x = "${Buffer.from(k).toString('hex')}"`, 'src/a.js'],
        ['a url-encoded key', `k=${encodeURIComponent(k)}`, 'src/a.js'],
    ])('%s', (_name, text, file) => {
        const named = patterns.isTestFilePath(file);
        expect(engine.scanContent(text, file, { namedProvidersOnly: named }).some(f => f.type === 'SECRET_PATTERN')).toBe(true);
    });

    // Known gaps. Each is a way to hide a key that the engine cannot see; they are recorded here so a
    // future engine or config change that closes one turns the todo into a test.
    it.todo('a key split across string literals ("sk_li" + "ve_...") is not detected: no engine reassembles code');
    it.todo('a key assembled with [..].join("") is not detected: same reason');
    it.todo('a key with a homoglyph or zero-width character inside it is not detected: the regex no longer matches');
    it.todo('a key broken across two lines of a template literal is not detected: rules match one line');
});

describe('redactSecretsInText', () => {
    it('replaces a named-provider value with a marker and keeps the text around it', () => {
        const out = engine.redactSecretsInText(`before\nconst k = "${STRIPE}";\nafter\n`, 'a.js');
        expect(out).toBe('before\nconst k = "<REDACTED:Stripe Key>";\nafter\n');
    });

    it('replaces only the generic value, not the whole assignment', () => {
        expect(engine.redactSecretsInText(`DB_PASSWORD=${PASSWORD}\n`, 'a.env.txt')).toBe('DB_PASSWORD=<REDACTED:Password Assignment (Unquoted)>\n');
    });

    it('replaces every occurrence, including two on one line', () => {
        const out = engine.redactSecretsInText(`a=${STRIPE} b=${GITHUB}\nc=${STRIPE}\n`, 'a.txt');
        expect(out).not.toContain(STRIPE);
        expect(out).not.toContain(GITHUB);
        expect(out.match(/<REDACTED:/g)).toHaveLength(3);
    });

    describe('every verbatim copy of a detected value is masked (the engine may report only one)', () => {
        it.each([
            ['two copies on one line', v => `a=${v} b=${v}\n`],
            ['three copies on one line', v => `${v} ${v} ${v}\n`],
            ['copies on one line and the next', v => `${v} ${v}\n${v}\n`],
            ['adjacent copies', v => `${v}${v}\n`],
            ['separated only by a comma', v => `{"a":"${v}","b":"${v}"}\n`],
            ['a copy on the last line without a newline', v => `x\n${v} ${v}`],
        ])('%s', (_n, build) => {
            for (const value of [STRIPE, GITHUB, AWS]) {
                const out = engine.redactSecretsInText(build(value), 'a.txt');
                expect(out, `${value.slice(0, 6)}: ${out}`).not.toContain(value);
                expect(out).toContain('<REDACTED:');
            }
        });

        it('a repeated generic value', () => {
            const out = engine.redactSecretsInText(`DB_PASSWORD=${PASSWORD} APP_PASSWORD=${PASSWORD}\nPASSWORD=${PASSWORD}\n`, 'a.env.txt');
            expect(out).not.toContain(PASSWORD);
        });

        it('overlapping and nested values collapse to one marker', () => {
            useFake(scanning(`console.log(JSON.stringify([
              { RuleID: 'domdhi-stripe-key', Secret: 'AAAA-BBBB-CCCC', Match: 'x', StartLine: 1, EndLine: 1 },
              { RuleID: 'domdhi-github-token', Secret: 'BBBB-CCCC-DDDD', Match: 'x', StartLine: 1, EndLine: 1 },
              { RuleID: 'domdhi-npm-token', Secret: 'BBBB', Match: 'x', StartLine: 1, EndLine: 1 }]));`));
            const out = engine.redactSecretsInText('k=AAAA-BBBB-CCCC-DDDD;\n', 'a.txt');
            expect(out).toBe('k=<REDACTED:Stripe Key>;\n');
        });

        it('a secret nested inside a longer secret on another rule', () => {
            useFake(scanning(`console.log(JSON.stringify([
              { RuleID: 'domdhi-stripe-key', Secret: 'ALPHA-BETA-GAMMA', Match: 'x', StartLine: 1, EndLine: 1 },
              { RuleID: 'domdhi-npm-token', Secret: 'BETA', Match: 'x', StartLine: 1, EndLine: 1 }]));`));
            const out = engine.redactSecretsInText('a=ALPHA-BETA-GAMMA b=BETA\n', 'a.txt');
            expect(out).not.toContain('BETA');
            expect(out).not.toContain('ALPHA');
        });

        it('redacts the second copy even when the engine reports one finding for it', () => {
            useFake(scanning(`console.log(JSON.stringify([{ RuleID: 'domdhi-stripe-key', Secret: 'SECRETVALUE1', Match: 'x', StartLine: 1, EndLine: 1 }]));`));
            expect(engine.redactSecretsInText('a=SECRETVALUE1 b=SECRETVALUE1\n', 'a.txt')).toBe('a=<REDACTED:Stripe Key> b=<REDACTED:Stripe Key>\n');
        });

        it('does not reach into a line outside the reported range', () => {
            useFake(scanning(`console.log(JSON.stringify([{ RuleID: 'domdhi-stripe-key', Secret: 'SECRETVALUE1', Match: 'x', StartLine: 2, EndLine: 2 }]));`));
            expect(engine.redactSecretsInText('SECRETVALUE1 here\nline SECRETVALUE1 SECRETVALUE1\nSECRETVALUE1 after\n', 'a.txt'))
                .toBe('SECRETVALUE1 here\nline <REDACTED:Stripe Key> <REDACTED:Stripe Key>\nSECRETVALUE1 after\n');
        });
    });

    it('redacts a multi-line private key block whole, with LF and CRLF line endings', () => {
        const body = j('MIIEowIBAAKCAQEA', 'abcdEFGH0123456789wxyzQRSTuvwx', '\n', 'zyxwVUTS9876543210ponmLKJIhgfedc', '\n');
        const pem = j('-----BEGIN ', 'RSA PRIVATE KEY-----\n', body, '-----END ', 'RSA PRIVATE KEY-----');
        for (const eol of ['\n', '\r\n']) {
            const text = `top${eol}${pem.replace(/\n/g, eol)}${eol}bottom${eol}`;
            const out = engine.redactSecretsInText(text, 'key.txt');
            expect(out).toBe(`top${eol}<REDACTED:Private Key>${eol}bottom${eol}`);
        }
    });

    it('returns the input unchanged when nothing is found, and for empty input', () => {
        expect(engine.redactSecretsInText('just text\n', 'a.txt')).toBe('just text\n');
        expect(engine.redactSecretsInText('', 'a.txt')).toBe('');
    });

    it('masks a secret in the middle of 5 MB of output without a size cap', () => {
        const filler = 'The quick brown fox jumps over the lazy dog 0123456789.\n'.repeat(50000);
        const text = `${filler}token line: x = "${STRIPE}"\n${filler}`;
        expect(text.length).toBeGreaterThan(5 * 1024 * 1024);
        const out = engine.redactSecretsInText(text, '<bash output>');
        expect(out).not.toContain(STRIPE);
        expect(out).toContain('<REDACTED:Stripe Key>');
        expect(out.length).toBeLessThan(text.length);
    });

    it('redacts the whole reported line range when the secret is not present verbatim (a decoded value)', () => {
        useFake(scanning(`console.log(JSON.stringify([{ RuleID: 'domdhi-stripe-key', Secret: 'a-decoded-value-not-in-the-text', Match: 'x', StartLine: 2, EndLine: 2 }]));`));
        const out = engine.redactSecretsInText('line one\nopaque base64 blob here\nline three\n', 'a.txt');
        expect(out).toBe('line one\n<REDACTED:Stripe Key>\nline three\n');
    });
});

describe('the scrubber and secret-safe-write, end to end, with repeated keys', () => {
    it('the scrubber masks every copy of a key that appears twice on one line', () => {
        const r = runHook('post-read-scrubber.cjs', bashOf(`{"a":"${STRIPE}","b":"${STRIPE}","c":"${GITHUB} ${GITHUB}"}\n`));
        const out = JSON.parse(r.stdout.trim()).hookSpecificOutput.updatedToolOutput;
        expect(out).not.toContain(STRIPE);
        expect(out).not.toContain(GITHUB);
        expect(out.match(/<REDACTED:/g)).toHaveLength(4);
    });

    it('redactSecretsForWrite masks every copy before the text is written', () => {
        const { redactSecretsForWrite } = require('../../../.agents/core/secret-safe-write.js');
        const out = redactSecretsForWrite(`k=${AWS} again ${AWS}\nand ${AWS}\n`, 'notes/memory.json', null);
        expect(out).not.toContain(AWS);
        expect(out.match(/<REDACTED:AWS Access Key>/g)).toHaveLength(3);
    });
});

describe('what the wrapper hands the engine', () => {
    it('runs a local config, exit code 0, JSON on stdout, the content on stdin, a project-relative path and an empty working directory', () => {
        const dump = path.join(tmp, 'argv.json');
        const root = fs.mkdtempSync(path.join(tmp, 'proj-'));
        const cache = path.join(tmp, 'cache');
        process.env.CLAUDE_PROJECT_DIR = root;
        process.env.AGENTS_SECRET_ENGINE_CACHE_DIR = cache;
        useFake(scanning(`require('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: args, stdin: text, cwd: process.cwd(), env: Object.keys(process.env).filter(k => /^(BETTERLEAKS|GITLEAKS)_/.test(k)) })); console.log('[]');`));
        process.env.BETTERLEAKS_CONFIG = '/etc/evil.toml';
        process.env.GITLEAKS_EXIT_CODE = '9';
        try {
            engine.scanContent('hello world\n', path.join(root, 'src', 'a.js'));
        } finally {
            delete process.env.BETTERLEAKS_CONFIG;
            delete process.env.GITLEAKS_EXIT_CODE;
        }
        const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
        const a = seen.argv;
        const at = flag => a[a.indexOf(flag) + 1];
        expect(a[0]).toBe('stdin');
        expect(at('--exit-code')).toBe('0');
        expect(at('--report-format')).toBe('json');
        expect(at('--report-path')).toBe('-');
        expect(at('--config')).toBe(engine.CONFIG_PATH);
        expect(a).toContain('--ignore-gitleaks-allow');
        expect(at('--set-attr')).toBe('path=src/a.js');
        expect(a).not.toContain('--validation');
        expect(a).not.toContain('--unsafe-auto-load-config');
        // a fragment scan points the ignore path at a file that does not exist
        expect(fs.existsSync(at('--gitleaks-ignore-path'))).toBe(false);
        expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(path.join(cache, 'betterleaks', 'cwd')));
        expect(fs.readdirSync(path.join(cache, 'betterleaks', 'cwd'))).toEqual([]);
        expect(seen.stdin).toBe('hello world\n');
        expect(seen.env).toEqual([]);
    });

    it('never points the engine at the project .betterleaksignore, whole-file scan or not', () => {
        const dump = path.join(tmp, 'argv3.json');
        const root = fs.mkdtempSync(path.join(tmp, 'proj-'));
        process.env.CLAUDE_PROJECT_DIR = root;
        useFake(scanning(`require('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify(args)); console.log('[]');`));
        engine.scanContent('hello\n', path.join(root, 'a.js'), { wholeFile: true });
        const a = JSON.parse(fs.readFileSync(dump, 'utf8'));
        // The engine is never pointed at the project's list (it is applied in Node, from the index): it gets an
        // ignore path that does not exist, inside its own empty working directory.
        const given = a[a.indexOf('--gitleaks-ignore-path') + 1];
        expect(given).not.toBe(path.join(root, '.betterleaksignore'));
        expect(fs.existsSync(given)).toBe(false);
    });

    it('sends no path attribute for a synthetic label such as <bash output>', () => {
        const dump = path.join(tmp, 'argv2.json');
        useFake(scanning(`require('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify(args)); console.log('[]');`));
        engine.scanContent('x\n', '<bash output>');
        expect(JSON.parse(fs.readFileSync(dump, 'utf8'))).not.toContain('--set-attr');
    });

    it('reuses one run for a scan followed by a redaction of the same text', () => {
        const counter = path.join(tmp, 'count.txt');
        useFake(scanning(`require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');
            console.log(JSON.stringify([{ RuleID: 'domdhi-stripe-key', Secret: 'SECRETVALUE', Match: 'm', StartLine: 1, EndLine: 1 }]));`));
        const text = 'a=SECRETVALUE\n';
        expect(engine.scanContent(text, 'a.txt')).toHaveLength(1);
        expect(engine.redactSecretsInText(text, 'a.txt')).toBe('a=<REDACTED:Stripe Key>\n');
        expect(fs.readFileSync(counter, 'utf8')).toBe('x');
    });

    it('refuses to run in a working directory that holds an ignore file', () => {
        const cache = path.join(tmp, 'cache2');
        process.env.AGENTS_SECRET_ENGINE_CACHE_DIR = cache;
        useFake(scanning(`console.log('[]');`));
        fs.mkdirSync(path.join(cache, 'betterleaks', 'cwd'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(cache, 'betterleaks', 'cwd', '.gitleaksignore'), 'x\n');
        expect(() => engine.scanContent('hello\n', 'a.js')).toThrow(/working directory is not usable/);
    });
});

describe('fault paths fail closed (on every platform)', () => {
    const cases = [
        ['the engine exits non-zero', raw('process.stderr.write("boom"); process.exit(3);'), 'ENGINE_FAILED', /exited with status 3/],
        ['the engine prints text that is not JSON', raw('console.log("not json at all");'), 'ENGINE_FAILED', /unreadable output/],
        ['the engine prints a JSON object, not an array', raw('console.log("{}");'), 'ENGINE_FAILED', /not a JSON array/],
        ['the engine prints nothing', raw(''), 'ENGINE_FAILED', /unreadable output|not a JSON array/],
        ['a finding lacks its fields', scanning('console.log(JSON.stringify([{ RuleID: "x" }]));'), 'ENGINE_FAILED', /without RuleID, Secret and StartLine/],
        ['the engine is killed by a signal', raw('process.kill(process.pid, "SIGKILL");'), 'ENGINE_FAILED', /killed by SIGKILL|exited with status/],
    ];

    it.each(cases)('scanContent throws when %s', (_name, body, code, message) => {
        useFake(body);
        let thrown;
        try { engine.scanContent('some text\n', 'src/a.js'); } catch (err) { thrown = err; }
        expect(thrown, 'scanContent must throw, never return clean').toBeTruthy();
        expect(thrown.code).toBe(code);
        expect(thrown.message).toMatch(message);
    });

    it('never puts the engine\'s stderr, or any input text, in the error message', () => {
        useFake(raw('process.stderr.write("LEAK:" + require("fs").readFileSync(0, "utf8")); process.exit(4);'));
        let thrown;
        try { engine.scanContent(`some text ${STRIPE}\n`, 'src/a.js'); } catch (err) { thrown = err; }
        expect(thrown.message).toBe('secret engine exited with status 4');
        expect(JSON.stringify(thrown.detail)).not.toMatch(/LEAK|sk_live/);
    });

    it('scanContent throws EngineFailedError when the engine hangs past the timeout', () => {
        useFake(raw('setTimeout(() => {}, 30000);'));
        engine.setTimeoutForTests(600);
        let thrown;
        const started = Date.now();
        try { engine.scanContent('some text\n', 'src/a.js'); } catch (err) { thrown = err; }
        expect(thrown.code).toBe('ENGINE_FAILED');
        expect(thrown.message).toMatch(/timed out after 600 ms/);
        expect(Date.now() - started).toBeLessThan(8000);
    });

    it('scanContent throws EngineUnavailableError when the override points at nothing', () => {
        process.env.AGENTS_SECRET_ENGINE_BIN = path.join(tmp, 'does-not-exist');
        engine.resetForTests();
        let thrown;
        try { engine.scanContent('some text\n', 'src/a.js'); } catch (err) { thrown = err; }
        expect(thrown.code).toBe('ENGINE_UNAVAILABLE');
        expect(thrown).toBeInstanceOf(patterns.EngineUnavailableError);
    });

    it('scanContent throws EngineUnavailableError when no engine exists anywhere', () => {
        delete process.env.AGENTS_SECRET_ENGINE_BIN;
        process.env.AGENTS_SECRET_ENGINE_CACHE_DIR = path.join(tmp, 'empty-cache');
        const savedPath = process.env.PATH;
        process.env.PATH = path.join(tmp, 'empty-bin');
        engine.resetForTests();
        try {
            expect(() => engine.scanContent('some text\n', 'src/a.js')).toThrow(/not installed/);
        } finally {
            process.env.PATH = savedPath;
        }
    });

    it('the redactor falls back to the named-provider list instead of throwing', () => {
        useFake(raw('process.exit(5);'));
        const out = patterns.redactSecretsInText(`k=${GITHUB}\nDB_PASSWORD=${PASSWORD}\n`, 'a.txt');
        expect(out).toContain('<REDACTED:GitHub Token>');
        // the fallback list has no generic rules, so the plain password is not masked
        expect(out).toContain(PASSWORD);
    });

    it('scanContentWithFallback scans with the named-provider list when the engine fails', () => {
        useFake(raw('process.exit(5);'));
        const names = patterns.scanContentWithFallback(`k=${GITHUB}\n`, 'a.txt').map(f => f.name);
        expect(names).toEqual(['GitHub Token']);
        expect(() => patterns.scanContent(`k=${GITHUB}\n`, 'a.txt')).toThrow();
    });

    it('the fallback does not hide a bug: a non-engine error still propagates from scanContentWithFallback', () => {
        const hostile = { toString() { throw new Error('not an engine fault'); } };
        expect(() => patterns.scanContentWithFallback(hostile, 'a.txt')).toThrow(/not an engine fault/);
    });
});

describe('the Write/Edit hook fails closed (exit 2) on engine faults', () => {
    const write = writeOf('const a = 1;\n');

    it('blocks with an install hint when the engine is missing', () => {
        const r = runHook('secret-scanner.cjs', write, { AGENTS_SECRET_ENGINE_BIN: path.join(tmp, 'missing') });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/FAIL-CLOSED/);
        expect(r.stderr).toMatch(/secret-engine-install/);
    });

    it('blocks when the engine fails', () => {
        const bad = kit.exe(path.join(tmp, 'hook-bad' + (process.platform === 'win32' ? '.exe' : '')));
        const r = runHook('secret-scanner.cjs', write, { AGENTS_SECRET_ENGINE_BIN: bad }, kit.childEnv(raw('process.exit(7);')));
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/FAIL-CLOSED/);
        expect(r.stderr).toMatch(/exited with status 7/);
    });

    it('blocks when the engine prints [] for everything but reports that it scanned nothing', () => {
        const bad = kit.exe(path.join(tmp, 'hook-empty' + (process.platform === 'win32' ? '.exe' : '')));
        const r = runHook('secret-scanner.cjs', write, { AGENTS_SECRET_ENGINE_BIN: bad }, kit.childEnv(raw(`process.stderr.write('INF scanned ~0 bytes (0) in 1ms\\n'); console.log('[]');`)));
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/did not scan the whole input/);
    });

    it('allows clean content with a working engine, and blocks a key with exit 2', () => {
        const clean = runHook('secret-scanner.cjs', write);
        expect(clean.status).toBe(0);
        const dirty = runHook('secret-scanner.cjs', writeOf(`const k = "${STRIPE}";\n`));
        expect(dirty.status).toBe(2);
        expect(dirty.stderr).toMatch(/Stripe Key/);
        expect(dirty.stderr).not.toContain(STRIPE);
    });

    it('honors a trailing allow marker on a generic match in a Write, and says so only for generic matches', () => {
        const generic = runHook('secret-scanner.cjs', writeOf(`const password = "${PASSWORD}";\n`));
        expect(generic.status).toBe(2);
        expect(generic.stderr).toMatch(/the\s+user may add betterleaks:allow/);
        const named = runHook('secret-scanner.cjs', writeOf(`const k = "${STRIPE}";\n`));
        expect(named.status).toBe(2);
        expect(named.stderr).not.toMatch(/betterleaks:allow/);
        expect(named.stderr).not.toMatch(/\.betterleaksignore/);
    });

    it('records the rule names and the count in the guardrail event, never the value', () => {
        runHook('secret-scanner.cjs', writeOf(`a="${STRIPE}"\nb="${GITHUB}"\n`));
        const dir = fs.readdirSync(tmp, { recursive: true }).map(String).find(f => f.endsWith('guardrail-events.jsonl'));
        expect(dir, 'a guardrail-events.jsonl was written under the project root').toBeTruthy();
        const events = fs.readFileSync(path.join(tmp, dir), 'utf8').trim().split('\n').map(JSON.parse);
        const last = events[events.length - 1];
        expect(last).toMatchObject({ source: 'secret-scanner', decision: 'block', count: 2 });
        expect(last.patterns.sort()).toEqual(['GitHub Token', 'Stripe Key']);
        expect(JSON.stringify(events)).not.toContain(STRIPE);
    });

    describe('ignore files on the hook paths', () => {
        let root;
        beforeEach(() => {
            root = fs.mkdtempSync(path.join(tmp, 'hookproj-'));
            gitRepo(root);
            stageIgnore(root, 'src/legacy.js:stripe-access-token:1\nsrc/legacy.js:domdhi-stripe-key:1\n');
        });
        const withRoot = (payload) => runHook('secret-scanner.cjs', payload, { CLAUDE_PROJECT_DIR: root });

        it('a Write of the whole file honors the fingerprint', () => {
            expect(withRoot(writeOf(`k = "${STRIPE}"\n`, path.join(root, 'src', 'legacy.js'))).status).toBe(0);
        });

        it('SEC-MAJOR-7: the Write hook reads the staged list, not an untracked working-tree file', () => {
            gitRun(root, 'rm', '-q', '--cached', '.betterleaksignore'); // leaves the working-tree file untracked
            expect(withRoot(writeOf(`k = "${STRIPE}"\n`, path.join(root, 'src', 'legacy.js'))).status).toBe(2);
        });

        it('an Edit does not: its new_string restarts at line 1', () => {
            const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src', 'legacy.js'), old_string: 'x', new_string: `k = "${STRIPE}"\n` } };
            expect(withRoot(edit).status).toBe(2);
        });

        it('a MultiEdit does not either', () => {
            const multi = { tool_name: 'MultiEdit', tool_input: { file_path: path.join(root, 'src', 'legacy.js'), edits: [{ old_string: 'a', new_string: `k = "${STRIPE}"\n` }] } };
            expect(withRoot(multi).status).toBe(2);
        });
    });
});

// ── nothing in the environment weakens the engine ─────────────────────────────

describe('a production hook ignores NODE_ENV, VITEST and the old test switches', () => {
    // Everything that could name "a test run" or loosen the scan, set at once, for a process that does NOT
    // load the fake-engine preload (so it sees the production pins).
    const hostile = {
        NODE_ENV: 'test', VITEST: '1', VITEST_WORKER_ID: '1', CI: 'true',
        SECRET_ENGINE_VERIFY_IN_TESTS: '0', SECRET_ENGINE_SKIP_VERIFY: '1', SECRET_ENGINE_TIMEOUT_MS: '1',
    };
    const productionEnv = extra => {
        const env = { ...process.env, CLAUDE_PROJECT_DIR: tmp, ...hostile, ...extra };
        for (const k of ['FAKE_ENGINE_BODY', 'FAKE_ENGINE_PINS']) delete env[k];
        if (!extra.NODE_OPTIONS) delete env.NODE_OPTIONS;
        return env;
    };
    const impostor = () => kit.childEnvWithoutPins(scanning(`console.log('[]');`));   // reports the right byte count and no findings
    const run = (hook, payload, extra) => spawnSync(process.execPath, [hookPath(hook)], { input: JSON.stringify(payload), encoding: 'utf8', env: productionEnv(extra) });

    it('refuses a fake engine on the Write hook: exit 2, even though the fake finds nothing in a file that holds a key', () => {
        const r = run('secret-scanner.cjs', writeOf(`const k = "${AWS}";\n`), { AGENTS_SECRET_ENGINE_BIN: kit.exe(), ...impostor() });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/not the pinned build/);
        expect(r.stderr).toMatch(/secret-engine-install/);
    });

    it('refuses it for clean content too: the gate fails closed, it does not pass', () => {
        const r = run('secret-scanner.cjs', writeOf('const a = 1;\n'), { AGENTS_SECRET_ENGINE_BIN: kit.exe(), ...impostor() });
        expect(r.status).toBe(2);
    });

    it('the scrubber falls back to the named-provider list instead of trusting the fake', () => {
        const r = run('post-read-scrubber.cjs', bashOf(`AWS=${AWS}\nDB_PASSWORD=${PASSWORD}\n`), { AGENTS_SECRET_ENGINE_BIN: kit.exe(), SECRET_ENGINE_QUIET: '', ...impostor() });
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout.trim()).hookSpecificOutput.updatedToolOutput;
        expect(out).toContain('<REDACTED:AWS Access Key>');
        expect(out).toContain(PASSWORD);              // no generic rules: this is the fallback, not the fake and not the engine
        expect(r.stderr).toMatch(/not the pinned build/);
    });

    it('refuses it in-process under the same variables', () => {
        Object.assign(process.env, hostile);
        useFake(scanning(`console.log('[]');`));
        binLib.setPinsForTests(null);                 // back to the production pins: the fake is an impostor again
        engine.resetForTests();
        process.env.AGENTS_SECRET_ENGINE_BIN = kit.exe();
        expect(() => engine.scanContent(`k = "${AWS}"\n`, 'a.js')).toThrow(/not the pinned build/);
    });

    it('SECRET_ENGINE_TIMEOUT_MS cannot shorten the scan: the real engine still finds a key and masks a generic secret', () => {
        const block = run('secret-scanner.cjs', writeOf(`const k = "${STRIPE}";\n`), {});
        expect(block.status).toBe(2);
        expect(block.stderr).toMatch(/Stripe Key/);
        expect(block.stderr).not.toMatch(/timed out|FAIL-CLOSED/);
        expect(run('secret-scanner.cjs', writeOf('const a = 1;\n'), {}).status).toBe(0);
        const scrub = run('post-read-scrubber.cjs', bashOf(`DB_PASSWORD=${PASSWORD}\n`), {});
        const out = JSON.parse(scrub.stdout.trim()).hookSpecificOutput.updatedToolOutput;
        expect(out).toBe('DB_PASSWORD=<REDACTED:Password Assignment (Unquoted)>\n');   // the engine did it; the fallback list cannot
        expect(scrub.stderr).not.toMatch(/fallback/);
    });

    it('the library has no environment switch left: no variable name from the old switches appears in the shipped code', () => {
        const dir = path.join(__dirname, '..', '..');
        const sources = ['core/_lib/secret-engine-bin.js', 'core/secret-engine-install.js', 'hooks/secret-engine.cjs', 'hooks/secret-patterns.cjs', 'hooks/secret-scanner.cjs']
            .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
        expect(sources).not.toMatch(/VERIFY_IN_TESTS|SECRET_ENGINE_TIMEOUT_MS|underTestRunner|process\.env\.(?:VITEST|NODE_ENV)/);
    });
});

// ── the batch scan (tools/tracked-file-scan.cjs) does not trust the engine's log alone ────────────────

describe('scanFiles: files that start with a signature are scanned, whatever their path looks like', () => {
    const NAMES = {
        'plain.txt': 'plain',
        'sp dir/bz.txt': 'a path with a space',
        'a b.txt': 'a space in the file name',
        'ü ñ/ünï.txt': 'non-ASCII with a space',
        'ünï/ö.txt': 'non-ASCII without a space',
        'q/we=ird.txt': 'an equals sign',
        "q/it's.txt": 'an apostrophe',
        'q/sp =x.txt': 'space and equals',
        '日本 語/ファイル.txt': 'CJK with a space',
    };
    // Windows forbids " \ and control characters in file names, so those cases run on POSIX only.
    const POSIX_ONLY = { 'q/qu"ote.txt': 'a double quote', 'q/sp "both" =x.txt': 'space, quotes and equals', 'q/back\\slash.txt': 'a backslash', 'q/new\nline.txt': 'a newline', 'q/tab\tname.txt': 'a tab' };
    const keyFor = i => j('sk_', 'live_', 'aB3xK9mP2qR7tY1wZ5nC8vD', String(i % 10));

    function makeTree(extra = {}) {
        const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
        const rels = Object.keys({ ...NAMES, ...(process.platform === 'win32' ? {} : POSIX_ONLY), ...extra });
        rels.forEach((rel, i) => {
            const file = path.join(root, rel);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // every file starts with a signature the engine sniffs as a binary, then holds its own key
            fs.writeFileSync(file, `${SIGNATURES[i % SIGNATURES.length][1]}\nk = "${keyFor(i)}"\n`);
        });
        return { root, rels };
    }

    it('finds the key in every one of them, in one batch run', () => {
        const { root, rels } = makeTree();
        const results = engine.scanFiles(root, rels);
        expect(results.batchMode).toBe('batch');
        for (const rel of rels) {
            const r = results.get(rel);
            expect(r.error, rel).toBeUndefined();
            expect(r.findings.filter(f => f.type === 'SECRET_PATTERN').map(f => f.name), rel).toEqual(['Stripe Key']);
        }
    });

    it('also scans the same files when none starts with a signature', () => {
        const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
        const rels = Object.keys(NAMES);
        rels.forEach((rel, i) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `k = "${keyFor(i)}"\n`); });
        const results = engine.scanFiles(root, rels);
        expect(results.batchMode).toBe('batch');
        for (const rel of rels) expect(results.get(rel).findings.filter(f => f.type === 'SECRET_PATTERN'), rel).toHaveLength(1);
    });

    it('applies the test-file rule and the sensitive-name rule per file', () => {
        const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src/a.test.js'), `const password = "${PASSWORD}";\nconst k = "${STRIPE}";\n`);
        fs.writeFileSync(path.join(root, '.env'), 'X=1\n');
        const results = engine.scanFiles(root, ['src/a.test.js', '.env'], rel => ({ namedProvidersOnly: patterns.isTestFilePath(rel) }));
        expect(results.get('src/a.test.js').findings.map(f => f.name)).toEqual(['Stripe Key']);
        expect(results.get('.env').findings.map(f => f.type)).toEqual(['HIGH_RISK_FILE']);
    });

    describe('the log is parsed, not guessed', () => {
        it.each([
            ['"sp dir/bz.txt"', 'sp dir/bz.txt'],
            ['"a \\"quoted\\" name.txt"', 'a "quoted" name.txt'],
            ['"back\\\\slash x.txt"', 'back\\slash x.txt'],
            ['"tab\\tname x"', 'tab\tname x'],
            ['"new\\nline x"', 'new\nline x'],
            ['"caf\\u00e9 x"', 'caf\u00e9 x'],
            ['"caf\\xc3\\xa9 x"', 'caf\u00e9 x'],
            ['"octal\\101 x"', 'octalA x'],
            ['"emoji \\U0001F600 x"', 'emoji \u{1F600} x'],
            ['"raw 日本 語"', 'raw 日本 語'],
        ])('goUnquote(%s)', (quoted, expected) => {
            expect(engine.goUnquote(quoted)).toBe(expected);
        });

        it.each(['"unterminated', '"bad \\q escape"', '"short \\x4"', '"trailing" junk', 'noquote', '"'])('goUnquote(%s) is null', text => {
            expect(engine.goUnquote(text)).toBeNull();
        });

        it('logPath reads quoted and bare values and refuses what it cannot read', () => {
            expect(engine.logPath('DBG skipping binary file mime_type=application/zip path="D/sp dir/x.txt"')).toBe('D/sp dir/x.txt');
            expect(engine.logPath('DBG skipping binary file mime_type=application/zip path=D/q/we=ird.txt')).toBe('D/q/we=ird.txt');
            expect(engine.logPath('DBG skipping empty file path=D/empty.txt  ')).toBe('D/empty.txt');
            expect(engine.logPath('DBG skipping binary file mime_type=application/zip')).toBeNull();
            expect(engine.logPath('DBG skipping binary file path=has space unquoted')).toBeNull();
            expect(engine.logPath('DBG skipping binary file path="bad \\q"')).toBeNull();
        });
    });

    describe('when the engine\'s account does not add up', () => {
        const dirBody = (logLines, extra = '') => scanning(`
          if (args[0] === 'dir') {
            ${logLines.map(l => `process.stderr.write(${JSON.stringify(l)} + '\\n');`).join('\n')}
            ${extra}
            console.log('[]');
          } else {
            console.log(JSON.stringify(text.includes('NEEDLE') ? [{ RuleID: 'domdhi-stripe-key', Secret: 'NEEDLE', Match: 'm', StartLine: 1, EndLine: 1, File: '' }] : []));
          }`);
        const tree = () => {
            const root = fs.mkdtempSync(path.join(tmp, 'tree-'));
            fs.writeFileSync(path.join(root, 'one.txt'), 'k = NEEDLE\n');
            fs.writeFileSync(path.join(root, 'two.txt'), 'hello\n');
            return { root, rels: ['one.txt', 'two.txt'] };
        };
        // the fake's dir run prints the right total (6 + 11 bytes) unless a test says otherwise
        const TOTAL = 'k = NEEDLE\n'.length + 'hello\n'.length;

        it('accepts a fake whose account is right (control)', () => {
            const { root, rels } = tree();
            useFake(dirBody([`INF scanned ~${TOTAL} bytes (17 B) in 1ms`]));
            const results = engine.scanFiles(root, rels);
            expect(results.batchMode).toBe('batch');
            expect(results.get('two.txt').findings).toEqual([]);
        });

        it('fails closed on a skip line whose path is not a requested file', () => {
            const { root, rels } = tree();
            useFake(dirBody([`DBG skipping binary file mime_type=application/zip path="${path.join(os.tmpdir(), 'elsewhere dir', 'x.txt')}"`, `INF scanned ~${TOTAL} bytes (17 B) in 1ms`]));
            let thrown;
            try { engine.scanFiles(root, rels); } catch (err) { thrown = err; }
            expect(thrown).toBeInstanceOf(engine.EngineFailedError);
            expect(thrown.detail.reason).toBe('unmatched-skip');
        });

        it('fails closed on a skip line with a path it cannot read', () => {
            const { root, rels } = tree();
            useFake(dirBody(['DBG skipping binary file mime_type=application/zip path="broken \\q escape"', `INF scanned ~${TOTAL} bytes (17 B) in 1ms`]));
            expect(() => engine.scanFiles(root, rels)).toThrow(/not a requested file/);
        });

        it('fails closed on a skip line with no path at all', () => {
            const { root, rels } = tree();
            useFake(dirBody(['DBG skipping binary file mime_type=application/zip', `INF scanned ~${TOTAL} bytes (17 B) in 1ms`]));
            expect(() => engine.scanFiles(root, rels)).toThrow(/not a requested file/);
        });

        it('fails closed on an error line in the log', () => {
            const { root, rels } = tree();
            useFake(dirBody(['ERR could not read something', `INF scanned ~${TOTAL} bytes (17 B) in 1ms`]));
            let thrown;
            try { engine.scanFiles(root, rels); } catch (err) { thrown = err; }
            expect(thrown.detail.reason).toBe('batch-error');
        });

        it('ignores the engine\'s own "skipping <rule> finding" lines', () => {
            const { root, rels } = tree();
            useFake(dirBody(['DBG skipping generic-api-key finding (key: REDACTED), domdhi-secret-line rule takes precedence (x)', `INF scanned ~${TOTAL} bytes (17 B) in 1ms`]));
            expect(engine.scanFiles(root, rels).batchMode).toBe('batch');
        });

        it('a byte total that does not match the files falls back to scanning each file, and still finds the key', () => {
            const { root, rels } = tree();
            useFake(dirBody([`INF scanned ~${TOTAL - 5} bytes (12 B) in 1ms`]));
            const results = engine.scanFiles(root, rels);
            expect(results.batchMode).toBe('per-file');
            expect(results.get('one.txt').findings.map(f => f.name)).toEqual(['Stripe Key']);
            expect(results.get('two.txt').findings).toEqual([]);
        });

        it('a missing byte total falls back the same way', () => {
            const { root, rels } = tree();
            useFake(dirBody([]));
            expect(engine.scanFiles(root, rels).batchMode).toBe('per-file');
        });

        it('a file that still skips on the per-file rescan fails the run', () => {
            const { root, rels } = tree();
            useFake(raw(`process.stderr.write(${JSON.stringify(`INF scanned ~1 bytes (1 B) in 1ms`)} + '\\n'); console.log('[]');`));
            let thrown;
            try { engine.scanFiles(root, rels); } catch (err) { thrown = err; }
            expect(thrown).toBeInstanceOf(engine.EngineFailedError);
            expect(thrown.detail.reason).toBe('input-skipped');
        });

        it('a skipped file named in the log is subtracted from the expected total and rescanned alone', () => {
            const { root, rels } = tree();
            const skippedPath = path.join(root, 'two.txt');
            // the dir run is told to run inside a staging copy, so name the staged path the way the engine would
            useFake(scanning(`
              if (args[0] === 'dir') {
                const stage = args[1];
                // Go-quoted like the real engine's log, so a Windows path's backslashes arrive escaped
                process.stderr.write('DBG skipping binary file mime_type=application/zip path=' + JSON.stringify(stage + '/two.txt') + '\\n');
                process.stderr.write('INF scanned ~${'k = NEEDLE\n'.length} bytes (11 B) in 1ms\\n');
                console.log(JSON.stringify([{ RuleID: 'domdhi-stripe-key', Secret: 'NEEDLE', Match: 'm', StartLine: 1, EndLine: 1, File: stage + '/one.txt' }]));
              } else { console.log('[]'); }`));
            const results = engine.scanFiles(root, rels);
            expect(results.batchMode).toBe('batch');
            expect(results.get('one.txt').findings.map(f => f.name)).toEqual(['Stripe Key']);
            expect(fs.existsSync(skippedPath)).toBe(true);
        });
    });
});
