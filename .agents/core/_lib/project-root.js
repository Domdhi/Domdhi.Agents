'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Resolve the project root that anchors per-project GITIGNORED working state —
 * above all the regenerable/transient half of the memory store now under
 * docs/.output/.state/memory-{index,inbox,daily} (the rebuilt FTS5 db, the
 * sub-agent inbox drafts, and the raw daily logs). ADR 0006 Amendment 2 split
 * the store: the curated JSON SOURCE moved to docs/.output/.memory/ and is now
 * TRACKED — resolve THAT with resolveWorktreeRoot() below, not this function.
 *
 * WHY THIS EXISTS — the git-worktree memory-loss bug. A worktree only checks out
 * TRACKED files, so any GITIGNORED store starts EMPTY in a fresh worktree and
 * anything written there is deleted with the worktree. The ignored .state/ half
 * must therefore be SHARED across the main repo and every linked worktree by
 * anchoring it to the main worktree. (The tracked .memory/ source no longer
 * needs this — git checks it out into each worktree naturally.)
 *
 * Resolution order:
 *   1. AGENT_SHARED_STATE_ROOT — explicit state override, always wins.
 *   2. A neutral/Codex source override (AGENTS_PROJECT_DIR, AGENT_SOURCE_ROOT,
 *      CODEX_PROJECT_DIR) selects the repository queried in step 4.
 *   3. Legacy CLAUDE_PROJECT_DIR without a neutral source override retains its
 *      historical direct state-root override.
 *   4. The MAIN worktree root, via `git rev-parse --git-common-dir`. The common
 *      dir ("<mainRoot>/.git") is shared by the main repo and every linked
 *      worktree, so this returns the same path everywhere → one shared store,
 *      no copy, nothing lost on worktree removal.
 *   5. The explicit source root, or `fallbackDir` (non-git / standalone template).
 *
 * `fallbackDir` is the caller's `path.resolve(__dirname, '..', '..')`; it is
 * used both as the git-query cwd and as the last-resort root.
 */
function resolveProjectRoot(fallbackDir) {
    if (process.env.AGENT_SHARED_STATE_ROOT) return path.resolve(process.env.AGENT_SHARED_STATE_ROOT);
    const explicit = process.env.AGENTS_PROJECT_DIR || process.env.AGENT_SOURCE_ROOT || process.env.CODEX_PROJECT_DIR;
    if (!explicit && process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
    const sourceRoot = explicit ? path.resolve(explicit) : fallbackDir;
    try {
        const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
            cwd: sourceRoot,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (common) {
            // `--git-common-dir` is relative ("​.git") from the main worktree and
            // absolute ("/main/.git") from a linked one; resolving against the
            // cwd normalizes both to the same absolute "<mainRoot>/.git".
            const abs = path.resolve(sourceRoot, common);
            // Standard layout only: trust the parent of the common dir solely
            // when it is named ".git". A relocation (--separate-git-dir / GIT_DIR)
            // would otherwise anchor the store somewhere surprising — fall through
            // to sourceRoot and let AGENT_SHARED_STATE_ROOT be the escape hatch.
            if (path.basename(abs) === '.git') return path.dirname(abs);
        }
    } catch {
        // not a git repo, or git unavailable — use the fallback
    }
    return sourceRoot;
}

/**
 * Resolve the NORMAL (current-worktree) project root — for TRACKED state that
 * git checks out into each worktree on its own, above all the curated memory
 * SOURCE at docs/.output/.memory/ (ADR 0006 Amendment 2).
 *
 * This is the counterpart to resolveProjectRoot(): where that one anchors the
 * gitignored .state/ half to the MAIN worktree (so it is shared, not lost), this
 * one returns the CURRENT worktree's top — because a tracked file is physically
 * present in whichever worktree you are in, and the source-of-truth edits should
 * land in that worktree's checkout, not the main repo's.
 *
 * Resolution order:
 *   1. AGENTS_PROJECT_DIR, AGENT_SOURCE_ROOT, CODEX_PROJECT_DIR, then legacy
 *      CLAUDE_PROJECT_DIR — the same source override order as runtime-context.
 *   2. The current worktree top, via `git rev-parse --show-toplevel`. In the
 *      MAIN worktree this equals resolveProjectRoot(); they diverge only inside
 *      a linked worktree, which is exactly the case the split is for.
 *   3. `fallbackDir` — the caller's own location (non-git / standalone template).
 */
function resolveWorktreeRoot(fallbackDir) {
    const explicit = process.env.AGENTS_PROJECT_DIR || process.env.AGENT_SOURCE_ROOT || process.env.CODEX_PROJECT_DIR;
    if (explicit) return path.resolve(explicit);
    if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
    try {
        const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: fallbackDir,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (top) return top;
    } catch {
        // not a git repo, or git unavailable — use the fallback
    }
    return fallbackDir;
}

module.exports = { resolveProjectRoot, resolveWorktreeRoot };
