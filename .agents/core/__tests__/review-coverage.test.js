// review-coverage.js: lists the high-risk commits in a range that no review report cites.
// Runs against a throwaway local git repository (no remote).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { keywordHits, reviewCoverage, loadKeywords, formatTable, DEFAULT_KEYWORDS } = require('../../../.agents/core/review-coverage');
const { createTmpDir } = require('./_helpers/tmp-dir');

const SCRIPT = path.resolve(__dirname, '../review-coverage.js');

let tmp;
const git = (...args) => execFileSync('git', args, { cwd: tmp.root, encoding: 'utf8', windowsHide: true }).trim();
function commit(files, subject) {
    for (const [rel, text] of Object.entries(files)) tmp.write(rel, text);
    git('add', '-A');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
}

beforeEach(() => {
    tmp = createTmpDir({ prefix: 'review-coverage-' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    commit({ 'README.txt': 'base\n' }, 'base');
});
afterEach(() => { tmp.cleanup(); });

describe('keywordHits', () => {
    it.each([
        ['src/lib/auth.server.ts', ['auth']],
        ['src/routes/loginForm.tsx', ['login']],
        ['app/billing/InvoiceSection.tsx', ['billing', 'invoice']],
        ['lib/plaid-read-route.ts', ['plaid']],
        ['src/components/Button.tsx', []],
    ])('%s -> %j', (file, expected) => {
        expect(keywordHits(file, DEFAULT_KEYWORDS)).toEqual(expected);
    });
});

describe('reviewCoverage', () => {
    it('lists a high-risk commit no report cites, and skips low-risk and out-of-scope commits', () => {
        commit({ 'src/ui/button.ts': 'x\n' }, 'ui tweak');
        commit({ 'docs/auth.md': 'x\n' }, 'docs only');
        const risky = commit({ 'src/lib/session-store.ts': 'x\n', 'src/ui/panel.ts': 'x\n' }, 'session change');

        const r = reviewCoverage({ root: tmp.root, range: 'HEAD~3..HEAD', keywords: DEFAULT_KEYWORDS });

        expect(r.scanned).toBe(3);
        expect(r.highRisk).toBe(1);
        expect(r.uncovered).toEqual([{ hash: risky, short: risky.slice(0, 7), subject: 'session change', files: ['src/lib/session-store.ts'], keywords: ['session'] }]);
    });

    it('a report citing the short hash covers the commit', () => {
        const risky = commit({ 'src/payments/charge.ts': 'x\n' }, 'charge');
        tmp.write('docs/.output/findings/reviews/261125-0900-code-review.md', `Reviewed ${risky.slice(0, 7)}: no findings.\n`);

        expect(reviewCoverage({ root: tmp.root, range: 'HEAD~1..HEAD', keywords: DEFAULT_KEYWORDS }).uncovered).toEqual([]);
    });

    it('a report naming every high-risk file covers the commit; naming only some does not', () => {
        commit({ 'src/auth/login.ts': 'x\n', 'src/auth/roles.ts': 'x\n' }, 'auth pair');
        tmp.write('docs/.output/findings/reviews/nested/r1.md', 'Checked `auth/login.ts:12`.\n');
        let r = reviewCoverage({ root: tmp.root, range: 'HEAD~1..HEAD', keywords: DEFAULT_KEYWORDS });
        expect(r.uncovered[0].files).toEqual(['src/auth/roles.ts']);

        tmp.write('docs/.output/findings/reviews/nested/r2.md', 'And src/auth/roles.ts.\n');
        r = reviewCoverage({ root: tmp.root, range: 'HEAD~1..HEAD', keywords: DEFAULT_KEYWORDS });
        expect(r.uncovered).toEqual([]);
    });

    it('formats a markdown table', () => {
        commit({ 'src/ledger.ts': 'x\n' }, 'ledger | pipe');
        const text = formatTable(reviewCoverage({ root: tmp.root, range: 'HEAD~1..HEAD', keywords: DEFAULT_KEYWORDS }));
        expect(text).toMatch(/1 with no review report cited/);
        expect(text).toContain('ledger \\| pipe');
    });
});

describe('keyword override', () => {
    it('--keywords wins, then the project config file, then the defaults', () => {
        expect(loadKeywords(tmp.root)).toEqual(DEFAULT_KEYWORDS);
        tmp.write('.agents/config/review-coverage.json', JSON.stringify({ keywords: ['Tenant'] }));
        expect(loadKeywords(tmp.root)).toEqual(['tenant']);
        expect(loadKeywords(tmp.root, 'quota, refund')).toEqual(['quota', 'refund']);
    });

    it('a malformed config is an input error', () => {
        tmp.write('.agents/config/review-coverage.json', '{"keywords": "auth"}');
        expect(() => loadKeywords(tmp.root)).toThrow(/keywords/);
    });
});

describe('CLI', () => {
    const run = (args) => spawnSync('node', [SCRIPT, ...args], {
        cwd: tmp.root, env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root }, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });

    it('prints JSON with --json and exits 0', () => {
        commit({ 'src/secrets/vault.ts': 'x\n' }, 'vault');
        const r = run(['HEAD~1..HEAD', '--json']);
        expect(r.status).toBe(0);
        const json = JSON.parse(r.stdout);
        expect(json.uncovered).toHaveLength(1);
        expect(json.uncovered[0].keywords).toEqual(['secret']);
    });

    it('exits 2 on a missing or bad range and on an unknown flag', () => {
        expect(run([]).status).toBe(2);
        expect(run(['nope..HEAD']).status).toBe(2);
        expect(run(['HEAD', '--bogus']).status).toBe(2);
    });
});
