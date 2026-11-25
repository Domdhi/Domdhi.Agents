#!/usr/bin/env node
'use strict';

/**
 * review-coverage — which high-risk commits in a range has no review report cited?
 *
 *   node .claude/core/review-coverage.js <range> [--json] [--keywords a,b,c] [--reviews <dir>]
 *
 * For each non-merge commit in <range> (any `git log` range, e.g. `abc123..HEAD`), it takes
 * the changed files whose path hits a high-risk keyword (auth, money, access, secrets; see
 * DEFAULT_KEYWORDS) and checks the review reports under `docs/.output/findings/reviews/`
 * (recursive, `.md`). A commit is covered when a report cites its hash (the 7-character short
 * form or longer) or names every one of its high-risk files (the repo path, or its last two
 * path segments). Every other high-risk commit is listed: `/sweep` Phase 1 uses the list as
 * its default make-up review themes, and a branch is checked with it before a push or merge.
 *
 * Keyword override: `--keywords` (comma-separated), else `review-coverage.keywords` in the
 * project-owned `.agents/config/review-coverage.json` (`{ "keywords": [...] }`), else the
 * defaults. Matching is case-insensitive against path tokens (split on non-alphanumerics and
 * camelCase); a token matches a keyword it starts with (`auth` matches `authorize`).
 * Generated and documentation trees (`docs/`, `.claude/`, `.codex/`) are not in scope.
 *
 * Exit 0 with the report; exit 2 on bad input or a git failure. Zero dependencies.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_KEYWORDS = [
    'auth', 'login', 'session', 'permission', 'role', 'access',
    'billing', 'payment', 'invoice', 'stripe', 'plaid', 'money', 'ledger',
    'secret', 'credential', 'token',
];
const OUT_OF_SCOPE = [/^docs\//, /^\.claude\//, /^\.codex\//];
const REVIEWS_REL = path.join('docs', '.output', 'findings', 'reviews');

class InputError extends Error {}

function pathTokens(file) {
    return file
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** The keywords a file path hits (sorted, unique). */
function keywordHits(file, keywords) {
    const tokens = pathTokens(file);
    return keywords.filter((kw) => tokens.some((t) => t.startsWith(kw))).sort();
}

function loadKeywords(root, flag) {
    if (typeof flag === 'string') {
        const list = flag.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
        if (list.length === 0) throw new InputError('--keywords needs at least one keyword');
        return list;
    }
    const file = path.join(root, '.agents', 'config', 'review-coverage.json');
    if (fs.existsSync(file)) {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            throw new InputError(`${path.relative(root, file)} is not valid JSON: ${e.message}`);
        }
        if (!Array.isArray(data.keywords) || data.keywords.some((k) => typeof k !== 'string' || !k.trim())) {
            throw new InputError(`${path.relative(root, file)} must hold { "keywords": ["...", ...] }`);
        }
        return data.keywords.map((k) => k.trim().toLowerCase());
    }
    return DEFAULT_KEYWORDS.slice();
}

/** Every `.md` report under `dir`, concatenated (lowercased paths kept as written). */
function readReports(dir) {
    const texts = [];
    const walk = (d) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile() && e.name.endsWith('.md')) texts.push(fs.readFileSync(full, 'utf8'));
        }
    };
    walk(dir);
    return texts.join('\n');
}

/** Non-merge commits in `range` with their changed files, oldest first. */
function commitsIn(root, range) {
    if (typeof range !== 'string' || !range.trim() || range.startsWith('-')) throw new InputError('a git range is required, e.g. abc123..HEAD');
    let out;
    try {
        out = execFileSync('git', ['log', '--no-merges', '--reverse', '--name-only', '--format=%x00%H%x09%s', range, '--'], {
            cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (e) {
        throw new InputError(`git log ${range} failed: ${(e.stderr || e.message || '').toString().trim()}`);
    }
    return out.split('\0').filter((b) => b.trim()).map((block) => {
        const lines = block.split(/\r?\n/);
        const [hash, ...subject] = lines[0].split('\t');
        return { hash, short: hash.slice(0, 7), subject: subject.join('\t'), files: lines.slice(1).filter(Boolean) };
    });
}

function cites(reports, file) {
    if (reports.includes(file)) return true;
    const parts = file.split('/');
    return parts.length > 2 && reports.includes(parts.slice(-2).join('/'));
}

function reviewCoverage({ root, range, keywords, reviewsDir }) {
    const reports = readReports(reviewsDir || path.join(root, REVIEWS_REL));
    const commits = commitsIn(root, range);
    const uncovered = [];
    let highRisk = 0;
    for (const c of commits) {
        const risky = c.files
            .filter((f) => !OUT_OF_SCOPE.some((re) => re.test(f)))
            .map((f) => ({ file: f, keywords: keywordHits(f, keywords) }))
            .filter((f) => f.keywords.length > 0);
        if (risky.length === 0) continue;
        highRisk++;
        if (reports.includes(c.short)) continue;
        const uncited = risky.filter((f) => !cites(reports, f.file));
        if (uncited.length === 0) continue;
        uncovered.push({
            hash: c.hash,
            short: c.short,
            subject: c.subject,
            files: uncited.map((f) => f.file),
            keywords: [...new Set(uncited.flatMap((f) => f.keywords))].sort(),
        });
    }
    return { range, keywords, scanned: commits.length, highRisk, uncovered };
}

function formatTable(result) {
    const lines = [
        `Review coverage for ${result.range}: ${result.scanned} commits, ${result.highRisk} high-risk, ${result.uncovered.length} with no review report cited.`,
    ];
    if (result.uncovered.length === 0) return lines.join('\n');
    lines.push('', '| Commit | Subject | Keywords | Uncited high-risk files |', '|---|---|---|---|');
    for (const c of result.uncovered) {
        const cell = (s) => String(s).replace(/\|/g, '\\|');
        lines.push(`| ${c.short} | ${cell(c.subject)} | ${c.keywords.join(', ')} | ${c.files.map(cell).join('<br>')} |`);
    }
    return lines.join('\n');
}

function parseArgs(argv) {
    const opts = { json: false };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--keywords') opts.keywords = argv[++i];
        else if (a === '--reviews') opts.reviews = argv[++i];
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (a.startsWith('--')) throw new InputError(`unknown flag: ${a}`);
        else rest.push(a);
    }
    if (rest.length > 1) throw new InputError('give one range');
    opts.range = rest[0];
    return opts;
}

function main(argv = process.argv.slice(2)) {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    try {
        const opts = parseArgs(argv);
        if (opts.help) {
            process.stdout.write('Usage: node .claude/core/review-coverage.js <range> [--json] [--keywords a,b] [--reviews <dir>]\n');
            return 0;
        }
        const result = reviewCoverage({
            root,
            range: opts.range,
            keywords: loadKeywords(root, opts.keywords),
            reviewsDir: opts.reviews ? path.resolve(root, opts.reviews) : undefined,
        });
        process.stdout.write((opts.json ? JSON.stringify(result, null, 2) : formatTable(result)) + '\n');
        return 0;
    } catch (e) {
        if (!(e instanceof InputError)) throw e;
        process.stderr.write(`review-coverage: ${e.message}\n`);
        return 2;
    }
}

if (require.main === module) process.exitCode = main();

module.exports = { DEFAULT_KEYWORDS, keywordHits, loadKeywords, reviewCoverage, formatTable, main };
