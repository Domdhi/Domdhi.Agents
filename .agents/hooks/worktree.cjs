#!/usr/bin/env node
'use strict';
/**
 * worktree.cjs — Claude Code WorktreeCreate / WorktreeRemove hook.
 *
 * Places every worktree under a sibling root outside the repository:
 *
 *   <parent of the main checkout>/.worktrees/<repo>/<branch>
 *
 * or, when AGENTS_WORKTREE_ROOT names an absolute directory, <root>/<repo>/<branch>.
 * The location is derived from the main checkout (never hardcoded), so the same
 * registration works on every machine and in every adopter.
 *
 * Contract (Claude Code hooks reference):
 *   WorktreeCreate  stdin {cwd, name, ...}; print the absolute worktree path as the
 *                   last standard-output line; any non-zero exit fails creation. The
 *                   hook replaces Claude Code's own `git worktree add`, so it also
 *                   copies the `.worktreeinclude` files (Git-ignored files that match).
 *   WorktreeRemove  stdin {worktree_path, ...}; exit 0 means removed (the directory
 *                   must be gone); non-zero fails removal while the directory exists.
 *                   Claude Code never deletes a branch a hook created, so this hook
 *                   deletes its own `worktree-<name>` branch, only when merged.
 *
 * Safety: refuses inherited Git redirection, an invalid name, an existing
 * destination, a symbolic link or junction anywhere from the worktree root down,
 * a destination inside the main checkout or one of its worktrees, a relative
 * override, and removal of anything that is not a registered worktree under the
 * resolved root. Removal never forces: uncommitted work keeps the worktree.
 * A creation that fails after Git started (a failing post-checkout hook, for
 * example) attempts rollback and reports any surviving worktree, registration,
 * new branch or created directories. Removing a path that is gone and not registered
 * under the resolved root exits 0 (nothing to remove); any other missing or
 * unregistered path is refused.
 * Diagnostics go to standard error; standard output carries only the path.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_ENV = 'AGENTS_WORKTREE_ROOT';
const BRANCH_PREFIX = 'worktree-';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Variables that point Git at another repository, index or object store, inject command-scope
// configuration (GIT_CONFIG_COUNT/KEY_n/VALUE_n/PARAMETERS can set core.worktree, core.hooksPath or
// core.fsmonitor) or redirect trace output. The harmless GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and
// GIT_CONFIG_NOSYSTEM (which only isolate a run from user configuration) are allowed.
const REDIRECT = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_.+|CONFIG_VALUE_.+|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|SHALLOW_FILE|TRACE.*|REDIRECT_.*)$/i;
const BASE_REFS = ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/heads/main', 'refs/remotes/origin/master', 'refs/heads/master'];

class Refusal extends Error {}
const refuse = message => { throw new Refusal(message); };
const log = message => process.stderr.write(`worktree hook: ${message}\n`);

const key = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const same = (a, b) => key(a) === key(b);
function inside(parent, child) {
    const rel = path.relative(key(parent), key(child));
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** The physical path of `p`: the real path of its deepest existing ancestor plus the missing tail. */
function canonical(p) {
    let current = path.resolve(p);
    const tail = [];
    for (;;) {
        try { return path.join(fs.realpathSync.native(current), ...tail.slice().reverse()); }
        catch {
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(p);
            tail.push(path.basename(current));
            current = parent;
        }
    }
}

function git(args, cwd, input) {
    return execFileSync('git', args, {
        cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
        ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input, stdio: ['pipe', 'pipe', 'pipe'] }),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' },
    });
}
function gitOk(args, cwd) {
    try { git(args, cwd); return true; } catch { return false; }
}

/** Refuse inherited Git redirection: it would make every query below answer for another repository. */
function checkEnvironment(env = process.env) {
    const found = Object.keys(env).filter(k => REDIRECT.test(k) && env[k] !== undefined && env[k] !== '');
    if (found.length) refuse(`inherited Git redirection (${found.join(', ')}) is not allowed`);
}

/** The main checkout that owns `dir`, resolved through the common Git directory. */
function mainCheckout(dir) {
    if (!dir || !path.isAbsolute(dir)) refuse('the event has no absolute working directory');
    let common;
    try { common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir).trim(); } catch { refuse('the working directory is not inside a Git checkout'); }
    if (path.basename(common).toLowerCase() !== '.git') refuse('only a non-bare repository with a .git directory is supported');
    const main = path.dirname(path.resolve(common));
    let top;
    try { top = git(['rev-parse', '--show-toplevel'], main).trim(); } catch { refuse('the main checkout cannot be verified'); }
    if (!same(fs.realpathSync.native(top), fs.realpathSync.native(main))) refuse('the main checkout cannot be verified');
    return main;
}

/** The worktree root for a main checkout: the override, or <parent>/.worktrees. */
function worktreeRoot(main, env = process.env) {
    const override = env[ROOT_ENV];
    if (override !== undefined && override !== '') {
        if (!path.isAbsolute(override)) refuse(`${ROOT_ENV} must be an absolute directory`);
        return path.resolve(override);
    }
    return path.join(path.dirname(main), '.worktrees');
}

/** Every existing component from `top` down to `leaf` must be a real directory, never a link or junction. */
function checkChain(top, leaf) {
    const parts = path.relative(top, leaf).split(path.sep).filter(Boolean);
    let current = top;
    for (const part of [null, ...parts]) {
        if (part !== null) current = path.join(current, part);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (!stat) return;
        if (stat.isSymbolicLink()) refuse(`${current} is a symbolic link or junction`);
        if (!stat.isDirectory()) refuse(`${current} is not a directory`);
    }
}

function registeredWorktrees(main) {
    const out = git(['worktree', 'list', '--porcelain'], main);
    const list = [];
    let current = null;
    for (const line of out.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) { current = { path: path.resolve(line.slice(9)) }; list.push(current); }
        else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
    return list;
}

function baseRef(main) {
    for (const ref of BASE_REFS) if (gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], main)) return ref;
    return 'HEAD';
}

/** Copy the `.worktreeinclude` matches that Git ignores (never a tracked file or a link) into the worktree. */
function copyIncludes(main, dest) {
    const include = path.join(main, '.worktreeinclude');
    const stat = fs.lstatSync(include, { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isFile()) { log('.worktreeinclude is not a regular file; nothing copied'); return []; }
    const matched = git(['ls-files', '--others', '--ignored', `--exclude-from=${include}`, '-z'], main).split('\0').filter(Boolean);
    if (!matched.length) return [];
    let ignored;
    try {
        ignored = git(['check-ignore', '--stdin', '-z'], main, matched.join('\0') + '\0').split('\0').filter(Boolean);
    } catch (error) {
        if (error.status === 1) ignored = []; // check-ignore exits 1 when nothing is ignored
        else throw error;
    }
    // One file: true when copied. A conflict on one path (a tracked file where a directory is needed, an
    // existing destination) is reported and never aborts the remaining copies.
    const copyOne = rel => {
        const parts = rel.split('/');
        if (path.isAbsolute(rel) || parts.some(p => p === '..' || p === '.' || p === '')) { log(`skipped ${rel}: unsafe path`); return false; }
        // Neither the source nor the destination may pass through a link.
        for (const [base, label] of [[main, 'source'], [dest, 'destination']]) {
            let current = base;
            for (const part of parts) {
                current = path.join(current, part);
                const s = fs.lstatSync(current, { throwIfNoEntry: false });
                if (!s) break;
                if (s.isSymbolicLink()) { log(`skipped ${rel}: ${label} passes through a link`); return false; }
            }
        }
        const src = path.join(main, ...parts);
        const srcStat = fs.lstatSync(src, { throwIfNoEntry: false });
        if (!srcStat || !srcStat.isFile()) return false;
        const target = path.join(dest, ...parts);
        if (!inside(dest, target)) { log(`skipped ${rel}: outside the worktree`); return false; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL);
        return true;
    };
    const copied = [];
    for (const rel of ignored) {
        try { if (copyOne(rel)) copied.push(rel); }
        catch (error) { log(`skipped ${rel}: ${error.code || error.message}`); }
    }
    return copied;
}

function create(event, env = process.env) {
    checkEnvironment(env);
    const name = event && event.name;
    if (typeof name !== 'string' || !NAME.test(name) || name.includes('..') || name.endsWith('.lock') || name.endsWith('.')) refuse('the worktree name must be a simple slug (letters, digits, ".", "_" and "-")');
    const main = mainCheckout(event.cwd);
    const branch = `${BRANCH_PREFIX}${name}`;
    if (!gitOk(['check-ref-format', '--branch', branch], main)) refuse(`"${branch}" is not a valid branch name`);
    const root = worktreeRoot(main, env);
    const repoDir = path.join(root, path.basename(main));
    const dest = path.join(repoDir, branch);
    if (fs.lstatSync(dest, { throwIfNoEntry: false })) refuse(`${dest} already exists`);
    if (inside(main, root) || inside(main, dest)) refuse('the worktree root must be outside the main checkout');
    // The same test on physical paths, so a junction, alias or short name above the root cannot land the
    // worktree inside the checkout or inside another worktree.
    const physicalDest = canonical(dest);
    if (inside(canonical(main), physicalDest)) refuse('the worktree root must be outside the main checkout');
    for (const wt of registeredWorktrees(main)) {
        if (inside(wt.path, dest) || inside(canonical(wt.path), physicalDest)) {
            refuse(`the destination is inside the worktree ${wt.path} (if that directory was deleted by hand, run git worktree prune in ${main})`);
        }
    }
    checkChain(root, repoDir);
    // Directories this call creates, deepest first, so a failure can take back exactly those.
    const madeDirs = [];
    for (let at = repoDir; !fs.lstatSync(at, { throwIfNoEntry: false }); at = path.dirname(at)) madeDirs.push(at);
    const madeDirPaths = new Map(madeDirs.map(dir => [dir, canonical(dir)]));
    const madeDirStats = new Map();
    const cleanupErrors = [];
    const takeBackDirs = () => {
        for (const dir of madeDirs) {
            try {
                const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
                if (!stat) continue;
                if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('created directory was replaced; kept it');
                const prior = madeDirStats.get(dir);
                if (!same(canonical(dir), madeDirPaths.get(dir)) || (prior && (prior.dev !== stat.dev || prior.ino !== stat.ino))) throw new Error('created directory was replaced; kept it');
                fs.rmdirSync(dir); // Only empty directories this call created, never recursive.
            } catch (error) { cleanupErrors.push(`directory ${dir}: ${error.message}`); }
        }
    };
    const survivingDirs = () => {
        const leftovers = [];
        for (const dir of madeDirs) {
            try { if (fs.lstatSync(dir, { throwIfNoEntry: false })) leftovers.push(`created directory ${dir}`); }
            catch (error) { leftovers.push(`created directory ${dir} (cannot verify removal: ${error.message})`); }
        }
        return leftovers;
    };
    fs.mkdirSync(repoDir, { recursive: true });
    try {
        checkChain(root, repoDir);
        for (const dir of madeDirs) madeDirStats.set(dir, fs.lstatSync(dir));
    }
    catch (error) {
        takeBackDirs();
        const leftovers = survivingDirs();
        if (leftovers.length) refuse(`${error.message}; cleanup incomplete: ${leftovers.join('; ')}. Cleanup errors: ${cleanupErrors.join('; ')}`);
        throw error;
    } // re-check after creating, so a link swapped in meanwhile still refuses
    const base = baseRef(main);
    const branchExisted = gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], main);
    try {
        const out = git(['worktree', 'add', '-b', branch, dest, base], main);
        if (out.trim()) log(out.trim());
    } catch (error) {
        const reason = String((error.stderr || error.message) || '').trim();
        // Git can create state before a post-checkout hook fails. Keep that
        // original failure even if cleanup or a final state query also fails.
        const cleanGit = args => {
            try { git(args, main); return true; }
            catch (cleanupError) {
                cleanupErrors.push(`git ${args.join(' ')}: ${String(cleanupError.stderr || cleanupError.message).trim()}`);
                return false;
            }
        };
        const checkRollbackDestination = () => {
            checkChain(root, dest);
            if (!inside(repoDir, dest) || !same(canonical(dest), physicalDest)) throw new Error('destination changed; kept it');
            if (!fs.lstatSync(dest, { throwIfNoEntry: false })) return; // only registration remains
            // Containment alone cannot prove ownership if a user directory
            // replaced this worktree. Require this repository's registered
            // branch and regular worktree marker before either removal path.
            const entry = registeredWorktrees(main).find(wt => same(wt.path, dest));
            const marker = fs.lstatSync(path.join(dest, '.git'), { throwIfNoEntry: false });
            if (!entry || entry.branch !== branch || !marker || !marker.isFile() || marker.isSymbolicLink()
                || !same(mainCheckout(dest), main) || !same(git(['rev-parse', '--show-toplevel'], dest).trim(), dest)) {
                throw new Error('destination is no longer the worktree created by this call; kept it');
            }
        };
        try {
            if (fs.lstatSync(dest, { throwIfNoEntry: false }) || registeredWorktrees(main).some(wt => same(wt.path, dest))) {
                checkRollbackDestination();
                if (!cleanGit(['worktree', 'remove', '--force', dest])) {
                    try {
                        // The destination was absent before this call. Recheck
                        // containment and every link after failed Git cleanup,
                        // since a concurrent replacement must never be removed.
                        checkRollbackDestination();
                        fs.rmSync(dest, { recursive: true, force: true });
                    } catch (cleanupError) { cleanupErrors.push(`worktree path ${dest}: ${cleanupError.message}`); }
                    cleanGit(['worktree', 'prune']);
                }
            }
        } catch (cleanupError) { cleanupErrors.push(`worktree cleanup ${dest}: ${cleanupError.message}`); }
        if (!branchExisted && gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], main)) cleanGit(['branch', '-D', branch]);
        takeBackDirs();
        const leftovers = survivingDirs();
        try { if (fs.lstatSync(dest, { throwIfNoEntry: false })) leftovers.unshift(`worktree path ${dest}`); }
        catch (cleanupError) { leftovers.unshift(`worktree path ${dest} (cannot verify removal: ${cleanupError.message})`); }
        try {
            if (registeredWorktrees(main).some(wt => same(wt.path, dest))) leftovers.push(`worktree registration ${dest} (run git worktree prune after resolving the path)`);
        } catch (cleanupError) { leftovers.push(`worktree registration ${dest} (cannot verify removal: ${cleanupError.message})`); }
        if (!branchExisted) {
            // show-ref's status 1 means absent; any other query fault leaves the
            // branch unverified, so it cannot support a clean-rollback promise.
            try {
                git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], main);
                leftovers.push(`new branch ${branch} (delete it after resolving the worktree registration)`);
            } catch (cleanupError) {
                if (cleanupError.status !== 1) leftovers.push(`new branch ${branch} (cannot verify removal: ${cleanupError.message})`);
            }
        }
        if (leftovers.length) {
            refuse(`git worktree add failed: ${reason}\nCleanup incomplete: ${leftovers.join('; ')}. Inspect and clean these artifacts before retrying. Cleanup errors: ${cleanupErrors.join('; ') || 'artifacts remain after cleanup'}`);
        }
        refuse(`git worktree add failed (nothing was left behind): ${reason}`);
    }
    // The worktree exists now; a failed include copy is reported, never turned into a
    // failed creation that would leave an orphan worktree behind.
    try {
        const copied = copyIncludes(main, dest);
        if (copied.length) log(`copied ${copied.length} .worktreeinclude file(s)`);
    } catch (error) {
        log(`warning: .worktreeinclude files were not copied: ${error.message}`);
    }
    return dest;
}

function remove(event, env = process.env) {
    checkEnvironment(env);
    const target = event && event.worktree_path;
    if (typeof target !== 'string' || !path.isAbsolute(target)) refuse('the event has no absolute worktree_path');
    const wtPath = path.resolve(target);
    const lookup = fs.existsSync(wtPath) ? wtPath : event.cwd;
    const main = mainCheckout(lookup);
    const physical = canonical(wtPath);
    const entry = registeredWorktrees(main).find(wt => same(wt.path, wtPath) || same(canonical(wt.path), physical));
    const root = worktreeRoot(main, env);
    const repoDir = path.join(root, path.basename(main));
    if (!fs.existsSync(wtPath)) {
        if (entry) refuse(`${wtPath} is missing but still registered; run git worktree prune in ${main}`);
        // Idempotent success only for a path this hook could have created; anything else is not "such a worktree".
        if (!inside(repoDir, wtPath)) refuse(`${wtPath} does not exist and is not under the worktree root ${root}`);
        log(`${wtPath} does not exist; nothing to remove`);
        return;
    }
    if (!entry || same(entry.path, main)) refuse(`${wtPath} is not a linked worktree of ${main}`);
    if (!inside(repoDir, wtPath) && !inside(canonical(repoDir), physical)) refuse(`${wtPath} is not under the worktree root ${root}; it was not created by this hook`);
    checkChain(root, wtPath);
    try { git(['worktree', 'remove', wtPath], main); }
    catch (error) { refuse(`git worktree remove refused (uncommitted or untracked work stays): ${String((error.stderr || error.message) || '').trim()}`); }
    if (entry.branch && entry.branch.startsWith(BRANCH_PREFIX)) {
        try { git(['branch', '-d', entry.branch], main); log(`deleted merged branch ${entry.branch}`); }
        catch { log(`kept branch ${entry.branch}: it has commits that are not merged`); }
    }
    if (fs.existsSync(wtPath)) refuse(`${wtPath} still exists after removal`);
}

function readEvent(text) {
    try { return JSON.parse(text); } catch { refuse('standard input is not a JSON event'); }
}

/**
 * Handle one event given as JSON text: returns the path to print for a creation, null for a removal,
 * and throws a Refusal for anything refused. Kept separate from main() so it runs in-process.
 */
function handle(text, argvKind, env = process.env) {
    const event = readEvent(text);
    if (event === null || typeof event !== 'object' || Array.isArray(event)) refuse('standard input is not a JSON object');
    const kind = event.hook_event_name || argvKind;
    if (kind === 'WorktreeCreate' || kind === 'create') return create(event, env);
    if (kind === 'WorktreeRemove' || kind === 'remove') { remove(event, env); return null; }
    return refuse(`unsupported event ${JSON.stringify(kind)}`);
}

function main() {
    try {
        const dest = handle(fs.readFileSync(0, 'utf8'), process.argv[2]);
        if (dest) process.stdout.write(`${dest}\n`);
        process.exitCode = 0;
    } catch (error) {
        log(error instanceof Refusal ? `refused: ${error.message}` : `failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { create, remove, handle, canonical, inside, worktreeRoot, mainCheckout, registeredWorktrees, baseRef, copyIncludes, checkEnvironment, Refusal, ROOT_ENV, BRANCH_PREFIX };

if (require.main === module) main();
