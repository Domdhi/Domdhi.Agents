// Tests for the owner-run pin (hooks/secret-pin.cjs, `secret-scanner.cjs --pin <path>:<line>`): it reads the value
// from the file, appends its `value-sha256:` entry to .betterleaksignore and never prints the value or the hash.
// The git hooks' block report prints a location and this command instead of a digest: an unsalted SHA-256 beside a
// redacted preview is an offline verifier for a short secret, and the hook's stderr reaches transcripts and logs.
//
// Uses the real Betterleaks engine (as secret-engine.test.js does). Key-shaped fixtures are built from parts so
// this file never holds a complete key literal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const crypto = require('node:crypto');
const engine = require('../../../.agents/hooks/secret-engine.cjs');
const pin = require('../../../.agents/hooks/secret-pin.cjs');
const SCANNER = require.resolve('../../../.agents/hooks/secret-scanner.cjs');

const j = (...p) => p.join('');
// A 12-character password: the redacted preview of such a value shows its first four characters.
const PASSWORD = j('Zx9Qm4', 'Lp2Rt7');
const STRIPE = j('sk_', 'live_', 'aB3xK9mP2qR7tY1wZ5nC8vD4');
const sha = v => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
const KEY = `value-sha256:${sha(PASSWORD)}`;
const LINE = `const password = "${PASSWORD}";\n`;

const git = (dir, ...args) => spawnSync('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8' });

let root;
let savedQuiet;
beforeEach(() => {
    savedQuiet = process.env.SECRET_ENGINE_QUIET;
    process.env.SECRET_ENGINE_QUIET = '1';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-pin-'));
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.invalid'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false']]) git(root, ...args);
    engine.resetForTests();
});
afterEach(() => {
    if (savedQuiet === undefined) delete process.env.SECRET_ENGINE_QUIET; else process.env.SECRET_ENGINE_QUIET = savedQuiet;
    fs.rmSync(root, { recursive: true, force: true });
    engine.resetForTests();
    vi.restoreAllMocks();
});

const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
};
const ignoreText = () => (fs.existsSync(path.join(root, '.betterleaksignore')) ? fs.readFileSync(path.join(root, '.betterleaksignore'), 'utf8') : null);
/** Run the CLI body in-process and collect everything it printed. */
const runMain = args => {
    const printed = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => printed.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => printed.push(a.join(' ')));
    const status = pin.main(args, { cwd: root });
    vi.restoreAllMocks();
    return { status, out: printed.join('\n') };
};
const leaks = out => [PASSWORD, PASSWORD.slice(0, 4), sha(PASSWORD)].filter(secret => out.includes(secret));

describe('pin: the entry written and what is printed', () => {
    it('appends the value-sha256 entry of the value at that line, and prints neither the value nor the hash', () => {
        write('src/app.js', `const a = 1;\n${LINE}`);
        const { status, out } = runMain(['--pin', 'src/app.js:2', '--reason', 'reviewed by the owner']);
        expect(status, out).toBe(0);
        expect(ignoreText()).toBe(`${KEY} # reviewed by the owner\n`);
        expect(engine.parseIgnore(ignoreText()).has(engine.valueAllowKey(PASSWORD))).toBe(true);
        expect(leaks(out)).toEqual([]);
        expect(out).toMatch(/Pinned 1 value\(s\) from src\/app\.js:2/);
        expect(out).toMatch(/git add \.betterleaksignore/);
    });

    it('a second pin of the same value adds nothing', () => {
        write('src/app.js', LINE);
        expect(runMain(['--pin', 'src/app.js:1', '--reason', 'first']).status).toBe(0);
        const again = runMain(['--pin', 'src/app.js:1', '--reason', 'second']);
        expect(again.status, again.out).toBe(0);
        expect(again.out).toMatch(/Pinned 0 value\(s\).*1 already listed/);
        expect(ignoreText()).toBe(`${KEY} # first\n`);
    });

    it('the default reason is the review date, and a reason cannot add a second line to the file', () => {
        write('src/app.js', LINE);
        pin.pinValues(root, 'src/app.js:1', { now: new Date('2026-01-02T12:00:00Z') });
        expect(ignoreText()).toBe(`${KEY} # reviewed 2026-01-02\n`);
        fs.rmSync(path.join(root, '.betterleaksignore'));
        pin.pinValues(root, 'src/app.js:1', { reason: 'ok\nsrc/other.js:rule:1' });
        expect(ignoreText()).toBe(`${KEY} # ok src/other.js:rule:1\n`);
        expect(ignoreText().trimEnd().split('\n')).toHaveLength(1);
    });

    it('appends after an existing list that has no final newline, keeping its line endings', () => {
        write('src/app.js', LINE);
        fs.writeFileSync(path.join(root, '.betterleaksignore'), '# reviewed\r\nsrc/x.js:generic-api-key:3');
        pin.pinValues(root, 'src/app.js:1', { reason: 'r' });
        expect(ignoreText()).toBe(`# reviewed\r\nsrc/x.js:generic-api-key:3\r\n${KEY} # r\r\n`);
    });

    it('refuses a UTF-16 ignore file (an append would corrupt it) and leaves it as it was', () => {
        write('src/app.js', LINE);
        const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('src/x.js:rule:1\r\n', 'utf16le')]);
        fs.writeFileSync(path.join(root, '.betterleaksignore'), utf16);
        const { status, out } = runMain(['--pin', 'src/app.js:1']);
        expect(status).toBe(1);
        expect(out).toMatch(/not UTF-8/);
        expect(fs.readFileSync(path.join(root, '.betterleaksignore')).equals(utf16)).toBe(true);
    });

    it('the pinned entry clears the finding once the file is staged (the scans read the index version)', () => {
        write('src/app.js', LINE);
        process.env.CLAUDE_PROJECT_DIR = root;
        const generic = () => engine.scanContent(LINE, 'src/app.js', { wholeFile: true }).filter(f => f.type === 'SECRET_PATTERN');
        expect(generic()).toHaveLength(1);
        pin.pinValues(root, 'src/app.js:1', { reason: 'r' });
        git(root, 'add', '--', '.betterleaksignore');
        engine.resetForTests();
        expect(generic()).toEqual([]);
    });
});

describe('pin: what it refuses', () => {
    it('never pins a named-provider finding', () => {
        write('src/app.js', `const k = "${STRIPE}";\n`);
        const { status, out } = runMain(['--pin', 'src/app.js:1']);
        expect(status).toBe(1);
        expect(out).toMatch(/named-provider/);
        expect(out).not.toContain(STRIPE);
        expect(ignoreText()).toBeNull();
    });

    it('a line with no finding, a missing file and a hard-skip path pin nothing', () => {
        write('src/app.js', `const a = 1;\n${LINE}`);
        write('node_modules/pkg/index.js', LINE);
        for (const spec of ['src/app.js:1', 'src/app.js:9', 'src/missing.js:1', 'node_modules/pkg/index.js:1']) {
            const { status, out } = runMain(['--pin', spec]);
            expect(status, spec).toBe(1);
            expect(leaks(out), spec).toEqual([]);
        }
        expect(ignoreText()).toBeNull();
    });

    it('a test path runs the named-provider rules only, so a generic value there has nothing to pin', () => {
        write('src/__tests__/fixture.js', LINE);
        expect(runMain(['--pin', 'src/__tests__/fixture.js:1']).status).toBe(1);
        expect(ignoreText()).toBeNull();
    });

    it.each([
        ['an absolute path', () => path.join(os.tmpdir(), 'x.js:1')],
        ['a parent traversal', () => '../outside.js:1'],
        ['a drive path', () => 'C:/x/y.js:1'],
        ['no line', () => 'src/app.js'],
        ['line zero', () => 'src/app.js:0'],
    ])('refuses %s', (_label, spec) => {
        write('src/app.js', LINE);
        const { status, out } = runMain(['--pin', spec()]);
        expect(status).toBe(1);
        expect(out).toMatch(/--pin:/);
        expect(ignoreText()).toBeNull();
    });

    const link = it.skipIf(process.platform === 'win32');
    link('refuses a symlinked source file and a symlinked ignore file', () => {
        write('real.js', LINE);
        fs.symlinkSync(path.join(root, 'real.js'), path.join(root, 'src-link.js'));
        const viaLink = runMain(['--pin', 'src-link.js:1']);
        expect(viaLink.status).toBe(1);
        expect(viaLink.out).toMatch(/not a regular file/);
        write('elsewhere.txt', '');
        fs.symlinkSync(path.join(root, 'elsewhere.txt'), path.join(root, '.betterleaksignore'));
        const viaIgnore = runMain(['--pin', 'real.js:1']);
        expect(viaIgnore.status).toBe(1);
        expect(fs.readFileSync(path.join(root, 'elsewhere.txt'), 'utf8')).toBe('');
    });

    it('a --rev that is not a commit id is refused before git sees it', () => {
        write('src/app.js', LINE);
        const { status, out } = runMain(['--pin', 'src/app.js:1', '--rev', 'main;x']);
        expect(status).toBe(1);
        expect(out).toMatch(/not a commit id/);
    });

    it.each([
        ['nothing', []],
        ['--rev alone', ['--rev', 'abcdef1']],
        ['--pin without a value', ['--pin']],
        ['a repeated flag', ['--pin', 'a.js:1', '--pin', 'b.js:1']],
        ['an unknown flag', ['--pin', 'a.js:1', '--force', 'x']],
    ])('usage: %s exits 2 and prints the usage', (_label, args) => {
        const { status, out } = runMain(args);
        expect(status).toBe(2);
        expect(out).toMatch(/Usage: secret-scanner\.cjs --pin/);
    });
});

describe('pin --rev: a value only older commits hold', () => {
    it('reads the path from that commit, and the work tree alone does not have it', () => {
        write('deploy/install.sh', LINE);
        git(root, 'add', '--', 'deploy/install.sh');
        const commit = git(root, 'commit', '-q', '-m', 'add installer');
        expect(commit.status, commit.stderr).toBe(0);
        const rev = git(root, 'rev-parse', 'HEAD').stdout.trim();
        write('deploy/install.sh', 'echo clean\n');

        expect(runMain(['--pin', 'deploy/install.sh:1']).status).toBe(1);
        const { status, out } = runMain(['--pin', 'deploy/install.sh:1', '--rev', rev, '--reason', 'older commit']);
        expect(status, out).toBe(0);
        expect(ignoreText()).toBe(`${KEY} # older commit\n`);
        expect(leaks(out)).toEqual([]);
    });

    it('a path that is not in that commit is reported, not guessed', () => {
        write('a.txt', 'x\n');
        git(root, 'add', '--', 'a.txt');
        git(root, 'commit', '-q', '-m', 'a');
        const rev = git(root, 'rev-parse', 'HEAD').stdout.trim();
        const { status, out } = runMain(['--pin', 'b.txt:1', '--rev', rev]);
        expect(status).toBe(1);
        expect(out).toMatch(/not a file at/);
    });
});

describe('pin: the scanner command and the printed command', () => {
    it('secret-scanner.cjs --pin runs it end to end and prints neither the value nor the hash', () => {
        write('src/app.js', `const a = 1;\n${LINE}`);
        const r = spawnSync(process.execPath, [SCANNER, '--pin', 'src/app.js:2', '--reason', 'cli'], { cwd: root, encoding: 'utf8', windowsHide: true });
        const out = `${r.stdout}${r.stderr}`;
        expect(r.status, out).toBe(0);
        expect(ignoreText()).toBe(`${KEY} # cli\n`);
        expect(leaks(out)).toEqual([]);
    });

    it('--rev or --reason without --pin is a usage error, not the Claude hook reading stdin', () => {
        const r = spawnSync(process.execPath, [SCANNER, '--rev', 'abcdef1'], { cwd: root, encoding: 'utf8', windowsHide: true, input: '' });
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/Usage: secret-scanner\.cjs --pin/);
    });

    it('pinCommand shows the script relative to the repository, the location, and --rev only for a commit', () => {
        const script = path.join(root, '.agents', 'hooks', 'secret-scanner.cjs');
        expect(pin.pinCommand(root, script, { path: 'src/app.js', commit: null }, 7)).toBe('node .agents/hooks/secret-scanner.cjs --pin src/app.js:7');
        const commit = 'a'.repeat(40);
        expect(pin.pinCommand(root, script, { path: 'src/app.js', commit }, 7)).toBe(`node .agents/hooks/secret-scanner.cjs --pin src/app.js:7 --rev ${commit}`);
        // A script outside the repository (a linked toolkit) is shown by its full path.
        const outside = path.join(os.tmpdir(), 'toolkit', 'secret-scanner.cjs');
        expect(pin.pinCommand(root, outside, { path: 'a.js', commit: null }, 1)).toBe(`node ${outside} --pin a.js:1`);
        expect(pin.pinCommand(root, script, null, 7)).toBeNull();
        expect(pin.pinCommand(root, script, { path: 'a.js', commit: null }, 0)).toBeNull();
    });

    it('pinCommand quotes a path with spaces or a quote so it pastes as one argument', () => {
        const script = path.join(root, 'secret-scanner.cjs');
        const cmd = pin.pinCommand(root, script, { path: 'my docs/it\'s.js', commit: null }, 3);
        expect(cmd.startsWith('node secret-scanner.cjs --pin \'my docs/it')).toBe(true);
        expect(cmd.endsWith(":3'")).toBe(true);
    });
});
