/**
 * git-history.js — shared "every path this repo has ever tracked" query (F83).
 *
 * Extracted from the two acknowledged duplicates — tools/publish.js
 * everShippedFiles() and tools/fleet.js everShippedTemplateFiles() — which both
 * ran the same `git log --all --pretty=format: --name-only [-- <scope>]` shape
 * to gate orphan detection (a file is a fossil only if the source once shipped
 * it; adopter/mirror-local additions must never be flagged).
 *
 * Failure policy stays with the CALLER (they deliberately differ: publish
 * degrades to null → history gate skipped; fleet warns → empty set → flags
 * nothing), so this helper THROWS on a failed git query.
 */

'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Every path the repo at `repoRoot` has ever tracked across all refs,
 * normalized to forward slashes. Optionally scoped to a pathspec.
 *
 * @param {string} repoRoot           Absolute repo path (passed to `git -C`)
 * @param {object} [opts]
 * @param {string} [opts.scope]      Pathspec to limit history to (e.g. '.claude')
 * @returns {Set<string>}            Repo-relative paths, '/'-separated
 * @throws When the git query fails (not a repo, git absent, …)
 */
function everTrackedFiles(repoRoot, { scope } = {}) {
    const args = ['-C', repoRoot, 'log', '--all', '--pretty=format:', '--name-only'];
    if (scope) args.push('--', scope);
    const out = execFileSync('git', args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const set = new Set();
    for (const line of out.split('\n')) {
        const t = line.trim();
        if (t) set.add(t.replace(/\\/g, '/'));
    }
    return set;
}

module.exports = { everTrackedFiles };
