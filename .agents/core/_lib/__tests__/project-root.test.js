import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveProjectRoot, resolveWorktreeRoot } = require('../../../../.agents/core/_lib/project-root.js');
const { memoryPaths } = require('../../../../.agents/core/_lib/memory-paths.js');
const rootOverrides = ['AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'AGENT_SHARED_STATE_ROOT'];

describe('resolveProjectRoot', () => {
    const saved = Object.fromEntries(rootOverrides.map(key => [key, process.env[key]]));
    afterEach(() => {
        for (const key of rootOverrides) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
    });
    beforeEach(() => { for (const key of rootOverrides) delete process.env[key]; });

    it('CLAUDE_PROJECT_DIR overrides everything', () => {
        process.env.CLAUDE_PROJECT_DIR = '/explicit/override';
        expect(resolveProjectRoot('/anything')).toBe('/explicit/override');
    });

    it.each(['AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR'])('%s selects tracked and ignored memory in a standalone source', key => {
        const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-source-'));
        try {
            process.env[key] = explicit;
            expect(resolveWorktreeRoot(process.cwd())).toBe(explicit);
            expect(resolveProjectRoot(process.cwd())).toBe(explicit);
            expect(memoryPaths(process.cwd()).jsonRoot).toBe(path.join(explicit, 'docs/.output/.memory'));
            expect(memoryPaths(process.cwd()).stateRoot).toBe(path.join(explicit, 'docs/.output/.state'));
        } finally { fs.rmSync(explicit, { recursive: true, force: true }); }
    });

    it('uses the documented source precedence and independent highest-priority state override', () => {
        process.env.AGENTS_PROJECT_DIR = '/explicit/agents';
        process.env.AGENT_SOURCE_ROOT = '/explicit/source';
        process.env.CODEX_PROJECT_DIR = '/explicit/codex';
        process.env.CLAUDE_PROJECT_DIR = '/explicit/claude';
        process.env.AGENT_SHARED_STATE_ROOT = 'explicit-state';
        expect(resolveWorktreeRoot('/fallback')).toBe(path.resolve('/explicit/agents'));
        expect(resolveProjectRoot('/fallback')).toBe(path.resolve('explicit-state'));
        delete process.env.AGENTS_PROJECT_DIR;
        expect(resolveWorktreeRoot('/fallback')).toBe(path.resolve('/explicit/source'));
        delete process.env.AGENT_SOURCE_ROOT;
        expect(resolveWorktreeRoot('/fallback')).toBe(path.resolve('/explicit/codex'));
        delete process.env.CODEX_PROJECT_DIR;
        expect(resolveWorktreeRoot('/fallback')).toBe('/explicit/claude');
    });

    it('falls back to the given dir when not in a git repo', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-'));
        try {
            expect(resolveProjectRoot(tmp)).toBe(tmp);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('uses the selected source fallback for a separate Git directory', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'separate-git-'));
        const source = path.join(base, 'source');
        fs.mkdirSync(source);
        try {
            execFileSync('git', ['init', '-q', '--separate-git-dir', path.join(base, 'metadata'), source], { stdio: 'ignore' });
            process.env.CODEX_PROJECT_DIR = source;
            expect(resolveProjectRoot(process.cwd())).toBe(source);
            expect(resolveWorktreeRoot(process.cwd())).toBe(source);
        } finally { fs.rmSync(base, { recursive: true, force: true }); }
    });

    it('resolves the MAIN worktree root from inside a linked worktree (the fix)', () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mainwt-')));
        const wt = path.join(root, '..', `${path.basename(root)}-linked`);
        const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
        try {
            git(['init', '-q'], root);
            git(['config', 'user.email', 't@t.t'], root);
            git(['config', 'user.name', 't'], root);
            fs.writeFileSync(path.join(root, 'f.txt'), 'x');
            git(['add', '.'], root);
            git(['commit', '-qm', 'init'], root);
            git(['worktree', 'add', '-q', wt, '-b', 'feat'], root);

            // Normalize both sides through realpathSync.native: on Windows,
            // os.tmpdir() can yield an 8.3 short path (e.g. FIRST~1.LAS) while
            // git's --git-common-dir returns the long form (first.last). Same
            // directory, different strings — canonicalize before comparing.
            const norm = (p) => fs.realpathSync.native(p);
            // From the linked worktree, the resolved root is the MAIN worktree —
            // so a memory store anchored to it is shared, not worktree-local.
            expect(norm(resolveProjectRoot(wt))).toBe(norm(root));
            // And from the main worktree it stays the main worktree.
            expect(norm(resolveProjectRoot(root))).toBe(norm(root));

            // Query the selected source repository, even if helpers are installed
            // in a different checkout. Source remains linked; ignored state is shared.
            for (const key of ['AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT', 'CODEX_PROJECT_DIR']) {
                process.env[key] = wt;
                expect(norm(resolveWorktreeRoot(process.cwd()))).toBe(norm(wt));
                expect(norm(resolveProjectRoot(process.cwd()))).toBe(norm(root));
                const paths = memoryPaths(process.cwd());
                expect(paths.jsonRoot).toBe(path.join(resolveWorktreeRoot(wt), 'docs/.output/.memory'));
                expect(paths.stateRoot).toBe(path.join(resolveProjectRoot(wt), 'docs/.output/.state'));
                delete process.env[key];
            }
            // Legacy direct callers keep the explicit state root semantics.
            process.env.CLAUDE_PROJECT_DIR = wt;
            expect(resolveProjectRoot(root)).toBe(wt);
            expect(resolveWorktreeRoot(root)).toBe(wt);
            process.env.AGENT_SHARED_STATE_ROOT = root;
            expect(resolveProjectRoot(wt)).toBe(root);
        } finally {
            try { git(['worktree', 'remove', '--force', wt], root); } catch { /* best effort */ }
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(wt, { recursive: true, force: true });
        }
    });
});
