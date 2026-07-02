'use strict';

/**
 * memory-paths.js — the single accessor for the SPLIT memory store (ADR 0006
 * Amendment 2). The store used to be one gitignored tree at
 * docs/.output/memories/ (JSON source + derived db + transient drafts/logs,  // path-lint:keep
 * colocated). It is now split along the source / index / transient lifecycle:
 *
 *   .memory/                       curated JSON SOURCE      — TRACKED (syncs over git)
 *   .state/memory-index/           rebuilt FTS5 memories.db — gitignored, regenerable
 *   .state/memory-inbox/           sub-agent draft memories — gitignored, transient
 *   .state/memory-daily/           raw daily capture logs   — gitignored, transient
 *   .state/memory-concepts/        compiled concept articles — gitignored, derived
 *   .state/memory-pending-curation/ curator staging         — gitignored, transient
 *   .state/memory-extracted/       extractor staging        — gitignored, transient
 *
 * THE RESOLVER SPLITS IN TWO (the worktree consequence):
 *   - jsonRoot (the tracked source) resolves via the NORMAL current-worktree
 *     root — git checks .memory/ out into each linked worktree on its own, so
 *     the old main-worktree anchor is no longer needed (or wanted) for it.
 *   - everything under .state/ stays anchored to the MAIN worktree via the
 *     existing resolveProjectRoot(), because it is gitignored and would
 *     otherwise be empty-then-lost in a linked worktree.
 *
 * Callers pass their own repo-root fallback (mirroring the existing
 * resolveProjectRoot call). A caller in `.claude/core/` uses two levels:
 * `memoryPaths(path.resolve(__dirname, '..', '..'))`. The default below uses
 * THREE levels because this file lives one directory deeper, in `.claude/core/_lib/` —
 * both resolve to the same repo root, just from different __dirname depths.
 */

const path = require('path');
const { resolveProjectRoot, resolveWorktreeRoot } = require('./project-root');

const OUTPUT = ['docs', '.output'];

/**
 * Return every absolute path the memory subsystem reads/writes, with the
 * tracked source and the gitignored state resolved by their respective roots.
 *
 * @param {string} fallbackDir  Repo-root fallback (caller's path.resolve(__dirname,'..','..')).
 * @returns {{ jsonRoot, dbPath, inboxDir, dailyDir, conceptsDir, pendingDir, extractedDir, stateRoot }}
 */
function memoryPaths(fallbackDir = path.resolve(__dirname, '..', '..', '..')) {
    // Tracked source — current worktree's checkout.
    const jsonRoot = path.join(resolveWorktreeRoot(fallbackDir), ...OUTPUT, '.memory');
    // Gitignored / regenerable — anchored to the main worktree (shared).
    const stateRoot = path.join(resolveProjectRoot(fallbackDir), ...OUTPUT, '.state');
    return {
        jsonRoot,
        dbPath: path.join(stateRoot, 'memory-index', 'memories.db'),
        inboxDir: path.join(stateRoot, 'memory-inbox'),
        dailyDir: path.join(stateRoot, 'memory-daily'),
        conceptsDir: path.join(stateRoot, 'memory-concepts'),
        pendingDir: path.join(stateRoot, 'memory-pending-curation'),
        extractedDir: path.join(stateRoot, 'memory-extracted'),
        stateRoot,
    };
}

module.exports = { memoryPaths };
