'use strict';

/**
 * memory-context.js — where the notes memory system keeps things for one project.
 *
 *   projectRoot    main-worktree root (the same anchor as the rest of the memory state)
 *   stateDir       <root>/docs/.output/.state/memory-notes  — ignored, regenerable: vectors, ledger, candidates, seen-sets, log
 *   engineRoot     the engine's TRACKED JSON memories (read-only here)
 *   memoryDir      the markdown memory dir (Claude's native auto-memory dir for the repo unless MEMORY_DIR)
 *   sessionsDir    where Claude Code keeps this project's session transcripts
 *
 * The env flags the hooks share also live here so the hooks and the CLI agree on what "enabled" means.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { memoryPaths } = require('./memory-paths');
const { claudeProjectDir, defaultMemoryDir } = require('./memory-notes');

/** The main-worktree root of the repository containing `dir` (Claude Code keys auto-memory per repo, not per worktree). */
function repoRootOf(dir) {
    try {
        const common = path.resolve(dir, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim());
        if (path.basename(common) === '.git') return path.dirname(common);
    } catch { /* not a git repo */ }
    return dir;
}

/** @param {string} fallbackDir the caller's repo-root fallback (path.resolve(__dirname, '..', '..')) */
function notesContext(fallbackDir, env = process.env) {
    const mp = memoryPaths(fallbackDir);
    const projectRoot = path.resolve(mp.stateRoot, '..', '..', '..');
    const stateDir = path.join(mp.stateRoot, 'memory-notes');
    const sourceRoot = path.resolve(env.AGENTS_PROJECT_DIR || env.AGENT_SOURCE_ROOT || env.CODEX_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || fallbackDir);
    return {
        projectRoot, stateDir, engineRoot: mp.jsonRoot,
        // Native auto-memory is shared by every worktree of a repo; session transcripts are per working directory.
        memoryDir: defaultMemoryDir(repoRootOf(sourceRoot), env),
        sessionsDir: claudeProjectDir(sourceRoot, env),
        // Tracked mirror of the notes (docs/.output/.memory/notes): the engine reads only its own category folders, so it ignores this.
        trackedNotesDir: path.join(mp.jsonRoot, 'notes'),
        candidatesDir: path.join(stateDir, 'candidates'),
        discardedDir: path.join(stateDir, 'candidates', '.discarded'),
        ledgerPath: path.join(stateDir, 'ledger.json'),
        logPath: path.join(stateDir, 'capture.log'),
    };
}

const isOn = v => ['on', '1', 'true', 'yes'].includes(String(v || '').toLowerCase());
const isOff = v => ['off', '0', 'false', 'no'].includes(String(v || '').toLowerCase());

/** Per-prompt recall is on unless MEMORY_RECALL=off (MEMORY_PROFILE=minimal is checked by the hook). */
const recallEnabled = (env = process.env) => !isOff(env.MEMORY_RECALL);
/** Automatic capture is opt-in per project. */
const captureEnabled = (env = process.env) => isOn(env.MEMORY_CAPTURE);

/** Automatic notes sync (pull at session start, push at session end) is opt-in: it moves notes into a tracked folder. */
const syncEnabled = (env = process.env) => isOn(env.MEMORY_SYNC);

const STARTUP_MODES = ['titles', 'core', 'off'];

function runtimeOf(env = process.env) {
    return env.AGENTS_RUNTIME || env.AGENT_RUNTIME || (env.CODEX_PROJECT_DIR ? 'codex' : 'claude');
}

/**
 * What the SessionStart injection shows. The 8-title list scored 35% in the fact-recall test (no memory 16%,
 * per-prompt recall of full memories 72%), so where per-prompt recall actually delivers (Claude runtime,
 * recall on) the startup block shrinks to the always-on core: importance >= 4 only.
 * Codex registers no UserPromptSubmit hook, so it keeps the titles. MEMORY_STARTUP=titles|core|off forces a mode.
 */
function startupMode(env = process.env) {
    const forced = String(env.MEMORY_STARTUP || '').toLowerCase();
    if (STARTUP_MODES.includes(forced)) return forced;
    return runtimeOf(env) === 'claude' && recallEnabled(env) ? 'core' : 'titles';
}

module.exports = { startupMode, runtimeOf, STARTUP_MODES, notesContext, recallEnabled, captureEnabled, syncEnabled, isOn, isOff };
