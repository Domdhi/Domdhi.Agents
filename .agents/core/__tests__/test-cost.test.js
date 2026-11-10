import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { classifyPath, summarize, parseNumstat, parseArgs, main } = require('../test-cost');
const script = path.resolve('.agents/core/test-cost.js');

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function git(cwd, ...args) {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}

function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-cost-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    return dir;
}

const lines = n => Array.from({ length: n }, (_, i) => `line ${i};`).join('\n') + '\n';
function write(dir, file, n) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), lines(n));
}
function commit(dir, message) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); return git(dir, 'rev-parse', 'HEAD'); }

function run(args, cwd) {
    return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

describe('classifyPath', () => {
    it('splits source from test across naming conventions', () => {
        expect(classifyPath('src/engine.ts')).toBe('source');
        expect(classifyPath('src/engine.test.ts')).toBe('test');
        expect(classifyPath('src/engine.spec.tsx')).toBe('test');
        expect(classifyPath('tests/e2e/login.js')).toBe('test');
        expect(classifyPath('pkg/__tests__/a.js')).toBe('test');
        expect(classifyPath('app/test_models.py')).toBe('test');
        expect(classifyPath('app/models_test.go')).toBe('test');
        expect(classifyPath('src/Billing/BillingTests.cs')).toBe('test');
        expect(classifyPath('spec/models/user_spec.rb')).toBe('test');
    });

    it('does not count docs, config, lockfiles, generated or vendored output', () => {
        for (const f of ['README.md', 'package.json', 'package-lock.json', 'docs/x.js', 'dist/a.js', 'node_modules/a/i.js', 'a.min.js', 'types.d.ts', 'db/migrations/1.js', '.claude/core/x.js', '.codex/core/x.js', 'a.css']) {
            expect(classifyPath(f)).toBeNull();
        }
    });

    it('skips .agents/ unless the toolkit workshop asks for it', () => {
        expect(classifyPath('.agents/core/gate.js')).toBeNull();
        expect(classifyPath('.agents/core/gate.js', { includeAgents: true })).toBe('source');
        expect(classifyPath('.agents/core/__tests__/gate.test.js', { includeAgents: true })).toBe('test');
    });

    it('normalizes Windows separators', () => {
        expect(classifyPath('src\\a.test.js')).toBe('test');
        expect(classifyPath('node_modules\\a\\i.js')).toBeNull();
    });
});

describe('parseNumstat', () => {
    it('reads rows, skips binary files and resolves renames to the new path', () => {
        const rows = parseNumstat('3\t1\tsrc/a.js\n-\t-\timg/x.png\n5\t0\tsrc/{old => new}/b.js\n2\t2\told.js => new.js\n');
        expect(rows).toEqual([
            { file: 'src/a.js', added: 3, deleted: 1 },
            { file: 'src/new/b.js', added: 5, deleted: 0 },
            { file: 'new.js', added: 2, deleted: 2 },
        ]);
    });
});

describe('summarize', () => {
    it('computes the test lines added per source line added', () => {
        const r = summarize([{ file: 'src/a.js', added: 100, deleted: 10 }, { file: 'src/a.test.js', added: 250, deleted: 5 }]);
        expect(r.sourceAdded).toBe(100);
        expect(r.testAdded).toBe(250);
        expect(r.testPerSourceAdded).toBe(2.5);
        expect(r.testShareOfAdded).toBeCloseTo(250 / 350);
        expect(r.flagged).toBe(true);
    });

    it('does not flag at or below the threshold', () => {
        expect(summarize([{ file: 'a.js', added: 100, deleted: 0 }, { file: 'a.test.js', added: 200, deleted: 0 }]).flagged).toBe(false);
        expect(summarize([{ file: 'a.js', added: 100, deleted: 0 }, { file: 'a.test.js', added: 201, deleted: 0 }]).flagged).toBe(true);
    });

    it('honors a custom threshold', () => {
        const rows = [{ file: 'a.js', added: 100, deleted: 0 }, { file: 'a.test.js', added: 150, deleted: 0 }];
        expect(summarize(rows, { threshold: 1 }).flagged).toBe(true);
        expect(summarize(rows, { threshold: 3 }).flagged).toBe(false);
    });

    it('never flags a scope with too little source or none (test-only work, tiny diffs)', () => {
        expect(summarize([{ file: 'a.test.js', added: 500, deleted: 0 }]).testPerSourceAdded).toBeNull();
        expect(summarize([{ file: 'a.test.js', added: 500, deleted: 0 }]).flagged).toBe(false);
        expect(summarize([{ file: 'a.js', added: 5, deleted: 0 }, { file: 'a.test.js', added: 500, deleted: 0 }]).flagged).toBe(false);
        expect(summarize([{ file: 'a.js', added: 5, deleted: 0 }, { file: 'a.test.js', added: 500, deleted: 0 }], { minSource: 1 }).flagged).toBe(true);
    });

    it('ignores uncounted files and handles an empty change', () => {
        const r = summarize([{ file: 'README.md', added: 999, deleted: 0 }]);
        expect(r.testPerSourceAdded).toBeNull();
        expect(r.testShareOfAdded).toBeNull();
        expect(r.flagged).toBe(false);
    });
});

describe('parseArgs', () => {
    it('rejects bad input', () => {
        expect(parseArgs(['--bogus']).error).toMatch(/unknown argument/);
        expect(parseArgs(['--threshold']).error).toMatch(/needs a value/);
        expect(parseArgs(['--threshold', 'abc']).error).toMatch(/non-negative/);
        expect(parseArgs(['--threshold', '-1']).error).toMatch(/needs a value|non-negative/);
        expect(parseArgs(['--worktree', '--since', '2026-01-01']).error).toMatch(/only one/);
        expect(parseArgs(['--fleet', '.', '--worktree']).error).toMatch(/--since only/);
        expect(parseArgs(['--range', '--output=x']).error).toBeTruthy();
        expect(parseArgs(['--range', 'a b']).error).toMatch(/single git revision/);
    });

    it('accepts the documented forms', () => {
        const a = parseArgs(['--range', 'abc..def', '--threshold', '3', '--json']);
        expect(a.error).toBeNull();
        expect(a.range).toBe('abc..def');
        expect(a.threshold).toBe(3);
        expect(a.json).toBe(true);
    });
});

describe('measuring real repositories', () => {
    it('measures a commit range and flags an over-tested wave', () => {
        const dir = makeRepo();
        write(dir, 'src/base.js', 10);
        const base = commit(dir, 'base');
        write(dir, 'src/engine.js', 100);
        write(dir, 'src/engine.test.js', 350);
        write(dir, 'README.md', 40);
        commit(dir, 'wave');
        const r = run(['--repo', dir, '--range', `${base}..HEAD`, '--json'], os.tmpdir());
        expect(r.status).toBe(0);
        const data = JSON.parse(r.stdout);
        expect(data.results[0]).toMatchObject({ sourceAdded: 100, testAdded: 350, commits: 1, flagged: true });
        expect(data.results[0].testPerSourceAdded).toBe(3.5);
    });

    it('measures uncommitted work including untracked files, ignoring the exit-code', () => {
        const dir = makeRepo();
        write(dir, 'src/a.js', 30);
        commit(dir, 'base');
        write(dir, 'src/a.js', 60);            // modified: +60 -30 (whole-file rewrite of different lines)
        write(dir, 'src/new.js', 40);          // untracked source
        write(dir, 'tests/new.test.js', 200);  // untracked test
        const r = run(['--repo', dir, '--worktree', '--json'], os.tmpdir());
        expect(r.status).toBe(0);
        const res = JSON.parse(r.stdout).results[0];
        expect(res.testAdded).toBe(200);
        expect(res.sourceAdded).toBeGreaterThanOrEqual(40 + 30);
        expect(res.flagged).toBe(res.testPerSourceAdded > 2);
    });

    it('prints a flag line for the reviewer and a clean OK line otherwise', () => {
        const loud = makeRepo();
        write(loud, 'src/a.js', 50);
        write(loud, 'src/a.test.js', 300);
        commit(loud, 'loud');
        const quiet = makeRepo();
        write(quiet, 'src/a.js', 50);
        write(quiet, 'src/a.test.js', 40);
        commit(quiet, 'quiet');
        const a = run(['--repo', loud, '--since', '2000-01-01'], os.tmpdir());
        expect(a.status).toBe(0);
        expect(a.stdout).toContain('TEST_COST_FLAG');
        expect(a.stdout).toContain('REVIEW');
        const b = run(['--repo', quiet, '--since', '2000-01-01'], os.tmpdir());
        expect(b.status).toBe(0);
        expect(b.stdout).toContain('TEST_COST_OK');
    });

    it('sweeps every repo under a fleet directory, worst first, skipping non-repos', () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'test-cost-fleet-'));
        dirs.push(parent);
        for (const [name, tests] of [['calm', 10], ['loud', 400]]) {
            const repo = path.join(parent, name);
            fs.mkdirSync(repo);
            git(repo, 'init', '-q', '-b', 'main');
            write(repo, 'src/a.js', 100);
            write(repo, 'src/a.test.js', tests);
            commit(repo, name);
        }
        fs.mkdirSync(path.join(parent, 'not-a-repo'));
        const r = run(['--fleet', parent, '--since', '2000-01-01', '--json'], os.tmpdir());
        expect(r.status).toBe(0);
        const names = JSON.parse(r.stdout).results.map(x => x.repo);
        expect(names).toEqual(['loud', 'calm']);
    });

    it('is not fooled by an inherited GIT_DIR pointing at another repository', () => {
        const target = makeRepo();
        write(target, 'src/a.js', 25);
        commit(target, 'target');
        const decoy = makeRepo();
        write(decoy, 'src/b.js', 999);
        commit(decoy, 'decoy');
        const r = spawnSync(process.execPath, [script, '--repo', target, '--since', '2000-01-01', '--json'], {
            cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, GIT_DIR: path.join(decoy, '.git') },
        });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).results[0].sourceAdded).toBe(25);
    });

    it('reports a non-repository as skipped with a nonzero exit, never a stack trace', () => {
        const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'test-cost-plain-'));
        dirs.push(plain);
        const r = run(['--repo', plain], os.tmpdir());
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('skipped');
        expect(r.stderr).not.toContain('    at ');
    });

    it('exits 2 on a bad argument and 0 for --help', () => {
        expect(run(['--nope'], os.tmpdir()).status).toBe(2);
        const help = run(['--help'], os.tmpdir());
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('--worktree');
    });
});

describe('main (in process)', () => {
    it('returns 2 for conflicting modes without touching git', () => {
        let err = '';
        const code = main(['--worktree', '--range', 'a..b'], { write() {} }, { write: s => { err += s; } });
        expect(code).toBe(2);
        expect(err).toMatch(/only one/);
    });
});
