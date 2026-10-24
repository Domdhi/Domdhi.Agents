/**
 * Freeze State — read/write helper for `docs/.output/.state/freeze-state.json`.
 *
 * Freeze-state (A2) adopted from gstack's `/freeze` pattern:
 *   `docs/.output/findings/research/competitive/_hooks-and-core-scripts-comparison.md` §A2.
 * /investigate writes this file with a list of absolute paths the user is
 * actively investigating; the guardrail's Edit/Write path rejects mutations
 * of those paths with "File is frozen by /investigate". This module is the
 * READER. The writer integration (from /investigate) lands in a follow-up.
 *
 * State file schema:
 *   { "frozen": ["/absolute/path/1.ts", "/absolute/path/2.md"] }
 *
 * Graceful degradation (all by design — freeze-state is advisory, not a hard
 * safety boundary):
 *   - Missing file     → isFrozen=false, listFrozen=[]
 *   - Unreadable file  → same
 *   - Malformed JSON   → same
 *
 * Paths are compared by strict string equality (no normalization). Callers
 * should pass absolute paths resolved via CLAUDE_PROJECT_DIR.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveProjectRoot } = require('./project-root');

function getStateFilePath() {
    // F1/CR-3.1 sibling: freeze-state.json lives under the gitignored `.state/`
    // shared across linked worktrees, so anchor to the git-common-dir via
    // resolveProjectRoot (CLAUDE_PROJECT_DIR still wins) rather than the naive
    // __dirname fallback.
    const projectRoot = resolveProjectRoot(path.resolve(__dirname, '..', '..', '..'));
    return path.join(projectRoot, 'docs', '.output', '.state', 'freeze-state.json');
}

// F10: memoize the parsed list per (file, mtime). guardrail.cjs checks freeze
// state once per delete-path candidate — `rm -rf a b c d` used to re-read and
// re-JSON.parse the same file four times in one hook invocation. The mtime key
// keeps the cache honest across processes/sessions; setFrozen() below also
// invalidates explicitly (same-millisecond rewrites would fool mtime alone).
let _frozenCache = null; // { file, mtimeMs, frozen }

/**
 * Load the frozen-path list. Returns [] on any read/parse error.
 * @returns {string[]}
 */
function listFrozen() {
    const stateFile = getStateFilePath();
    let st;
    try {
        st = fs.statSync(stateFile);
    } catch {
        return []; // absent — the common case
    }
    if (_frozenCache && _frozenCache.file === stateFile && _frozenCache.mtimeMs === st.mtimeMs) {
        return _frozenCache.frozen;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (!parsed || !Array.isArray(parsed.frozen)) return [];
        const frozen = parsed.frozen.filter((p) => typeof p === 'string');
        _frozenCache = { file: stateFile, mtimeMs: st.mtimeMs, frozen };
        return frozen;
    } catch {
        return [];
    }
}

/**
 * Test whether a given absolute path is currently frozen.
 * @param {string} absPath
 * @returns {boolean}
 */
function isFrozen(absPath) {
    if (typeof absPath !== 'string' || !absPath) return false;
    const frozen = listFrozen();
    return frozen.includes(absPath);
}

/**
 * Replace the frozen-path list with `paths`. Creates parent dirs as needed.
 * Provided for future /investigate integration and for testability.
 * @param {string[]} paths
 */
function setFrozen(paths) {
    const stateFile = getStateFilePath();
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const payload = { frozen: Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [] };
    fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2));
    _frozenCache = null; // F10: never serve a pre-write list from the memo
}

module.exports = { isFrozen, listFrozen, setFrozen, getStateFilePath };
