#!/usr/bin/env node
'use strict';

// Test-cost signal: how many test lines a change adds per source line.
//
// Reports added and deleted code lines split into source and test, the ratio of
// test lines added per source line added, and a flag when that ratio passes a
// threshold (default 2:1). The flag is a prompt for a reviewer to look at, never
// a gate: the exit code is 0 whatever the ratio. Only code files count (no docs,
// config, lockfiles, generated or vendored output). Read-only: runs git
// numstat/ls-files and reads untracked files for --worktree, nothing else.
//
// Usage:
//   node .claude/core/test-cost.js                       # current repo, last 28 days
//   node .claude/core/test-cost.js --worktree            # uncommitted work (incl. untracked) vs HEAD
//   node .claude/core/test-cost.js --range <a>..<b>      # a commit range (a wave)
//   node .claude/core/test-cost.js --since 2026-09-01    # commits since a date
//   node .claude/core/test-cost.js --repo <path> ...     # one or more repos
//   node .claude/core/test-cost.js --fleet <dir>         # every git repo directly under <dir>
//   Options: --threshold <n> (default 2)  --min-source <n> (default 20)
//            --include-agents (count .agents/, for the toolkit workshop)  --json

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_THRESHOLD = 2;
const DEFAULT_MIN_SOURCE = 20;
const DEFAULT_SINCE_DAYS = 28;
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

const CODE_EXT = /\.(?:js|jsx|ts|tsx|mjs|cjs|py|cs|go|rs|java|kt|rb|php|swift|c|cc|cpp|h|hpp|vue|svelte|razor|cshtml|gd|lua|ex|exs)$/i;
const EXCLUDED_DIR = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|\.next|\.claude|\.codex|docs|migrations|__snapshots__|bin|obj|wwwroot\/lib)\//i;
const EXCLUDED_FILE = /(?:\.min\.[a-z]+|\.d\.ts|\.generated\.[a-z]+|\.g\.cs|\.designer\.cs|package-lock\.json)$/i;
const TEST_DIR = /(?:^|\/)(?:__tests__|tests?|spec|specs|e2e|__mocks__)\//i;
const TEST_FILE = /(?:\.(?:test|spec)\.[a-z]+|_test\.(?:py|go|rb|exs?)|_spec\.rb|Tests?\.(?:cs|java|kt|swift|php))$|(?:^|\/)test_[^/]*\.py$/;

// 'test' | 'source' | null (not counted).
function classifyPath(file, options = {}) {
    const f = String(file).replace(/\\/g, '/');
    if (!CODE_EXT.test(f) || EXCLUDED_FILE.test(f) || EXCLUDED_DIR.test(f)) return null;
    if (!options.includeAgents && /(?:^|\/)\.agents\//.test(f)) return null;
    return TEST_DIR.test(f) || TEST_FILE.test(f) ? 'test' : 'source';
}

function emptyTotals() {
    return { sourceAdded: 0, sourceDeleted: 0, testAdded: 0, testDeleted: 0, sourceFiles: 0, testFiles: 0 };
}

// rows: [{ file, added, deleted }]; a file seen twice counts once per call.
function summarize(rows, options = {}) {
    const totals = emptyTotals();
    const seen = new Set();
    for (const row of rows) {
        const kind = classifyPath(row.file, options);
        if (!kind) continue;
        const added = Number(row.added) || 0;
        const deleted = Number(row.deleted) || 0;
        if (kind === 'test') { totals.testAdded += added; totals.testDeleted += deleted; if (!seen.has(row.file)) totals.testFiles++; }
        else { totals.sourceAdded += added; totals.sourceDeleted += deleted; if (!seen.has(row.file)) totals.sourceFiles++; }
        seen.add(row.file);
    }
    return withDerived(totals, options);
}

function withDerived(totals, options = {}) {
    const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;
    const minSource = Number.isFinite(options.minSource) ? options.minSource : DEFAULT_MIN_SOURCE;
    const addedAll = totals.sourceAdded + totals.testAdded;
    const ratio = totals.sourceAdded > 0 ? totals.testAdded / totals.sourceAdded : null;
    // A change that adds tests but (almost) no source is a test-only story or a backfill: the ratio is
    // meaningless there, so it is reported but not flagged.
    const flagged = ratio !== null && totals.sourceAdded >= minSource && ratio > threshold;
    return {
        ...totals,
        testShareOfAdded: addedAll > 0 ? totals.testAdded / addedAll : null,
        testPerSourceAdded: ratio,
        threshold,
        flagged,
    };
}

function cleanEnv() {
    const env = { ...process.env };
    // Inherited git location overrides would make `-C <repo>` operate on a different repository.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) delete env[key];
    return env;
}

function git(repo, args) {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: cleanEnv(), windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} failed in ${repo}: ${(result.stderr || '').trim().split('\n')[0]}`);
    return result.stdout;
}

function isRepoRoot(dir) {
    try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; }
}

// Parse `git ... --numstat` lines "added<TAB>deleted<TAB>path" (binary files show "-"; renames "a => b" resolve to the new path).
function parseNumstat(text) {
    const rows = [];
    for (const line of String(text).split('\n')) {
        const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m || m[1] === '-') continue;
        let file = m[3];
        const brace = file.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
        if (brace) file = (brace[1] + brace[3] + brace[4]).replace(/\/\//g, '/');
        else if (file.includes(' => ')) file = file.split(' => ').pop();
        rows.push({ file, added: Number(m[1]), deleted: Number(m[2]) });
    }
    return rows;
}

function untrackedRows(repo) {
    const names = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    const rows = [];
    for (const name of names) {
        if (!classifyPath(name, { includeAgents: true })) continue;
        const full = path.join(repo, name);
        try {
            const stat = fs.statSync(full);
            if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) continue;
            const text = fs.readFileSync(full, 'utf8');
            const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
            rows.push({ file: name, added: lines, deleted: 0 });
        } catch { /* unreadable or vanished: skip */ }
    }
    return rows;
}

function measureRepo(repo, options = {}) {
    let rows;
    let scope;
    let commits = null;
    if (options.worktree) {
        rows = parseNumstat(git(repo, ['diff', 'HEAD', '--numstat', '--no-renames'])).concat(untrackedRows(repo));
        scope = 'worktree vs HEAD';
    } else if (options.range) {
        rows = parseNumstat(git(repo, ['log', '--no-merges', '--numstat', '--no-renames', '--format=', options.range]));
        commits = Number(git(repo, ['rev-list', '--no-merges', '--count', options.range]).trim());
        scope = `range ${options.range}`;
    } else {
        const since = options.since || new Date(Date.now() - DEFAULT_SINCE_DAYS * 86400000).toISOString().slice(0, 10);
        rows = parseNumstat(git(repo, ['log', '--no-merges', '--numstat', '--no-renames', '--format=', `--since=${since}`]));
        commits = Number(git(repo, ['rev-list', '--no-merges', '--count', `--since=${since}`, 'HEAD']).trim());
        scope = `since ${since}`;
    }
    return { repo: path.basename(path.resolve(repo)), scope, commits, ...summarize(rows, options) };
}

function parseArgs(argv) {
    const args = { repos: [], fleet: null, since: null, range: null, worktree: false, json: false, includeAgents: false, threshold: DEFAULT_THRESHOLD, minSource: DEFAULT_MIN_SOURCE, help: false, error: null };
    const need = (name, i) => {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) { args.error = `${name} needs a value`; return null; }
        return value;
    };
    for (let i = 0; i < argv.length && !args.error; i++) {
        const a = argv[i];
        if (a === '--worktree') args.worktree = true;
        else if (a === '--json') args.json = true;
        else if (a === '--include-agents') args.includeAgents = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else if (a === '--repo') { const v = need(a, i); if (v) { args.repos.push(v); i++; } }
        else if (a === '--fleet') { const v = need(a, i); if (v) { args.fleet = v; i++; } }
        else if (a === '--since') { const v = need(a, i); if (v) { args.since = v; i++; } }
        else if (a === '--range') { const v = need(a, i); if (v) { args.range = v; i++; } }
        else if (a === '--threshold' || a === '--min-source') {
            const v = need(a, i);
            if (v) {
                const n = Number(v);
                if (!Number.isFinite(n) || n < 0) args.error = `${a} must be a non-negative number`;
                else if (a === '--threshold') args.threshold = n; else args.minSource = n;
                i++;
            }
        } else args.error = `unknown argument ${a}`;
    }
    const modes = [args.worktree, !!args.range, !!args.since].filter(Boolean).length;
    if (!args.error && modes > 1) args.error = 'use only one of --worktree, --range, --since';
    if (!args.error && args.fleet && (args.worktree || args.range)) args.error = '--fleet works with --since only';
    if (!args.error && args.range && !/^[^\s-][^\s]*$/.test(args.range)) args.error = '--range must be a single git revision range';
    if (!args.error && args.since && !/^[^\s-][^\s]*$/.test(args.since)) args.error = '--since must be a date such as 2026-09-01';
    return args;
}

const pct = v => v === null ? '  -' : `${Math.round(v * 100)}%`.padStart(4);
const ratioText = v => v === null ? '   -' : `${v.toFixed(1)}:1`.padStart(6);

function formatTable(results, threshold) {
    const lines = [];
    const name = Math.max(4, ...results.map(r => r.repo.length));
    lines.push(`${'repo'.padEnd(name)}  ${'commits'.padStart(7)}  ${'src +/-'.padStart(15)}  ${'test +/-'.padStart(15)}  test share  test:src  flag`);
    for (const r of results) {
        const sp = `${r.sourceAdded}/${r.sourceDeleted}`.padStart(15);
        const tp = `${r.testAdded}/${r.testDeleted}`.padStart(15);
        lines.push(`${r.repo.padEnd(name)}  ${String(r.commits ?? '-').padStart(7)}  ${sp}  ${tp}  ${pct(r.testShareOfAdded).padStart(10)}  ${ratioText(r.testPerSourceAdded)}  ${r.flagged ? 'REVIEW' : ''}`);
    }
    const flagged = results.filter(r => r.flagged);
    lines.push('');
    lines.push(flagged.length
        ? `TEST_COST_FLAG: ${flagged.map(r => r.repo).join(', ')} above ${threshold}:1 test lines per source line added. A prompt for the reviewer to check whether the tests pin contracts or tuning; not a gate.`
        : `TEST_COST_OK: no scope above ${threshold}:1 test lines per source line added (scopes with under the minimum source lines are never flagged).`);
    return lines.join('\n');
}

function main(argv, out = process.stdout, err = process.stderr) {
    const args = parseArgs(argv);
    if (args.help) {
        const header = [];
        for (const line of fs.readFileSync(__filename, 'utf8').split('\n').slice(3)) {
            if (!line.startsWith('//')) break;
            header.push(line.replace(/^\/\/ ?/, ''));
        }
        out.write(header.join('\n') + '\n');
        return 0;
    }
    if (args.error) { err.write(`test-cost: ${args.error}\n`); return 2; }
    let repos = args.repos.slice();
    if (args.fleet) {
        let entries;
        try { entries = fs.readdirSync(args.fleet, { withFileTypes: true }); } catch (e) { err.write(`test-cost: cannot read ${args.fleet}: ${e.message}\n`); return 2; }
        repos = repos.concat(entries.filter(e => e.isDirectory()).map(e => path.join(args.fleet, e.name)).filter(isRepoRoot));
    }
    if (!repos.length) repos = [process.cwd()];
    const results = [];
    const skipped = [];
    for (const repo of repos) {
        try { results.push(measureRepo(repo, args)); } catch (e) { skipped.push(`${path.basename(path.resolve(repo))}: ${e.message}`); }
    }
    results.sort((a, b) => (b.testPerSourceAdded ?? -1) - (a.testPerSourceAdded ?? -1));
    if (args.json) out.write(JSON.stringify({ threshold: args.threshold, results, skipped }, null, 2) + '\n');
    else {
        if (results.length) out.write(`Scope: ${results[0].scope}\n${formatTable(results, args.threshold)}\n`);
        for (const s of skipped) err.write(`test-cost: skipped ${s}\n`);
    }
    return results.length || !skipped.length ? 0 : 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { classifyPath, summarize, parseNumstat, measureRepo, parseArgs, formatTable, main };
