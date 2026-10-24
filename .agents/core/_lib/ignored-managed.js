/**
 * ignored-managed.js — name the ignore rule that hides a file the toolkit manages.
 *
 * An ignore rule that matches a managed file (the render ledger's entries, the
 * seeded root files such as `.playwright/cli.config.json`, the version marker)
 * leaves it untracked, so a commit silently omits it and a fresh clone does not
 * carry it. The rule may be project-owned (the adopter's own `.gitignore`,
 * `.git/info/exclude` or a global excludes file) or sit inside the toolkit's
 * managed block. This module only reports; it edits nothing, never refuses and
 * never throws, so an update or a status listing keeps its exit status.
 *
 * Contract:
 *   - Only untracked, Git-ignored files are reported. A tracked file is not
 *     subject to ignore rules, and a path a `!` rule re-includes is not ignored.
 *   - A root that is not a Git source (see git-ignored.js) reports nothing.
 *   - A failed Git query is returned as `unavailable`, never thrown.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./git');
const { gitCheckoutRoot, ignoredPaths, isIgnoredPath, READ_ONLY_GIT_ENV } = require('./git-ignored');

const LEDGER = '.agents/render-state.json';
const FIXED_PATHS = [LEDGER, '.claude/version.json'];
const TEMPLATE_ROOT = '.agents/templates/root';
// Seeded under a safe name and merged into the root .gitignore as a block.
const TEMPLATE_ROOT_RENAMED = new Set(['gitignore']);
const QUERY_CHUNK = 100;
const PATHS_PER_RULE = 5;

function isFile(abs) {
    try { return fs.lstatSync(abs).isFile(); } catch { return false; }
}

function templateRootDestinations(root) {
    const base = path.join(root, TEMPLATE_ROOT);
    const found = [];
    (function walk(dir, rel) {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const next = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
            else if (entry.isFile() && !TEMPLATE_ROOT_RENAMED.has(next)) found.push(next);
        }
    })(base, '');
    return found;
}

/**
 * The managed files present on disk under `root`, relative and forward-slash
 * separated: the render ledger's entries, the version marker and the files the
 * template root seeds at the project root.
 *
 * @param {string} root
 * @returns {string[]}
 */
function managedFiles(root) {
    const candidates = new Set(FIXED_PATHS);
    try {
        const ledger = JSON.parse(fs.readFileSync(path.join(root, LEDGER), 'utf8'));
        if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) {
            for (const raw of Object.keys(ledger)) {
                const key = raw.replace(/\\/g, '/');
                if (key && !key.startsWith('/') && !key.includes('..')) candidates.add(key);
            }
        }
    } catch { /* no ledger yet: the fixed and seeded paths still apply */ }
    for (const rel of templateRootDestinations(root)) candidates.add(rel);
    return [...candidates].filter(rel => isFile(path.join(root, rel))).sort();
}

/** 1-based line numbers of the toolkit's managed block in the root `.gitignore`, or null. */
function managedBlockLines(root) {
    let lines;
    try { lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/); } catch { return null; }
    // The marker text names the toolkit that wrote the block and the legacy marker name is still
    // written, so match the shape instead of importing scaffold.js's constants from a CLI.
    const start = lines.findIndex(line => /^# === (?!End )\S+ managed block — do not edit between markers ===$/.test(line.trim()));
    const end = lines.findIndex(line => /^# === End \S+ managed block ===$/.test(line.trim()));
    return start !== -1 && end > start ? { start: start + 1, end: end + 1 } : null;
}

/**
 * Git reports a rule's source relative to the enclosing work tree (an adopter
 * that is a subdirectory of another checkout gets `adopter/.gitignore`, and the
 * enclosing checkout's own root file is plain `.gitignore`). Name it relative to
 * the adopter, with `../` when it lives outside it, and say whether it is the
 * adopter's own file: only a rule inside the adopter's own file can sit in its
 * managed block. A global excludes file keeps Git's absolute spelling.
 */
function sourceRelativeToRoot(source, top, realRoot) {
    const rel = path.relative(realRoot, path.resolve(top, source));
    const inside = Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (inside || (rel && !path.isAbsolute(rel) && !path.isAbsolute(source))) {
        return { source: rel.replace(/\\/g, '/'), inside };
    }
    return { source: source.replace(/\\/g, '/'), inside: false };
}

/** The rule that matches each path, from `git check-ignore -v -z --stdin`. */
function matchingRules(root, relPaths) {
    const rules = new Map();
    const top = gitCheckoutRoot(root);
    const realRoot = fs.realpathSync(root);
    for (let index = 0; index < relPaths.length; index += QUERY_CHUNK) {
        let output = '';
        try {
            // `-z` is only valid with `--stdin`; NUL-separated in and out keeps any path name exact.
            output = git(['--no-optional-locks', 'check-ignore', '-v', '-z', '--stdin'], {
                cwd: root, env: READ_ONLY_GIT_ENV, raw: true,
                input: `${relPaths.slice(index, index + QUERY_CHUNK).join('\0')}\0`,
            });
        } catch (error) {
            // check-ignore exits 1 when no path is ignored; anything else is a failed query.
            if (error && error.status === 1) continue;
            throw error;
        }
        const fields = output.split('\0');
        for (let at = 0; at + 3 < fields.length; at += 4) {
            const [source, line, pattern, file] = fields.slice(at, at + 4);
            if (!file) continue;
            rules.set(file.replace(/\\/g, '/'), { ...sourceRelativeToRoot(source, top, realRoot), line: Number(line), pattern });
        }
    }
    return rules;
}

/**
 * Managed files under `root` that an ignore rule hides.
 *
 * @param {string} root  adopter checkout
 * @returns {{ hidden: Array<{ path: string, source: string, line: number, pattern: string, origin: 'managed-block'|'project' }>, unavailable: string|null }}
 */
function hiddenManagedFiles(root) {
    try {
        const ignored = ignoredPaths(root);
        if (!ignored) return { hidden: [], unavailable: null };
        const candidates = managedFiles(root).filter(rel => isIgnoredPath(rel, ignored));
        if (!candidates.length) return { hidden: [], unavailable: null };
        const rules = matchingRules(root, candidates);
        const block = managedBlockLines(root);
        const hidden = [];
        for (const rel of candidates) {
            const rule = rules.get(rel);
            if (!rule) continue;
            const inBlock = block && rule.inside && rule.source === '.gitignore' && rule.line > block.start && rule.line < block.end;
            hidden.push({ path: rel, source: rule.source, line: rule.line, pattern: rule.pattern, origin: inBlock ? 'managed-block' : 'project' });
        }
        return { hidden, unavailable: null };
    } catch (error) {
        return { hidden: [], unavailable: String((error && error.message) || error).split('\n')[0] };
    }
}

/**
 * Report lines for a result, empty when nothing is hidden. Grouped by rule so
 * one project line that hides several files is one entry.
 *
 * @param {{ hidden: Array, unavailable: string|null }} result
 * @param {{ indent?: string }} [options]
 * @returns {string[]}
 */
function describeHidden(result, options = {}) {
    const indent = options.indent || '';
    if (result.unavailable) return [`${indent}NOTE     could not check for ignore rules that hide managed files (${result.unavailable})`];
    if (!result.hidden.length) return [];
    const groups = new Map();
    for (const item of result.hidden) {
        const key = `${item.source}:${item.line}\0${item.pattern}\0${item.origin}`;
        if (!groups.has(key)) groups.set(key, { ...item, paths: [] });
        groups.get(key).paths.push(item.path);
    }
    const lines = [`${indent}Ignore rules hide managed files (a commit would leave them out; this notice changes nothing and does not affect the exit status):`];
    for (const group of groups.values()) {
        const owner = group.origin === 'managed-block' ? "rule inside the toolkit's managed block" : 'project-owned rule';
        lines.push(`${indent}  ${group.source}:${group.line} "${group.pattern}" (${owner}) hides ${group.paths.length} managed file${group.paths.length === 1 ? '' : 's'}:`);
        for (const rel of group.paths.slice(0, PATHS_PER_RULE)) lines.push(`${indent}      ${rel}`);
        if (group.paths.length > PATHS_PER_RULE) lines.push(`${indent}      ... and ${group.paths.length - PATHS_PER_RULE} more`);
    }
    const origins = new Set([...groups.values()].map(group => group.origin));
    if (origins.has('project')) {
        lines.push(`${indent}  Resolve a project-owned rule: narrow or remove it where it is defined (the toolkit never edits it), then commit the files; \`git check-ignore -v <path>\` names the rule.`);
    }
    if (origins.has('managed-block')) {
        lines.push(`${indent}  Resolve a managed-block rule: an update replaces the managed block; if the rule persists after updating from the current release, report it to the toolkit maintainers.`);
    }
    return lines;
}

module.exports = { managedFiles, hiddenManagedFiles, describeHidden };
