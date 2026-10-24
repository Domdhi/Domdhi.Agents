'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Locate a toolkit installation without requiring git or a particular shell. */
function findInstalledRoot(start, { invocation = false } = {}) {
    if (!start) return null;
    let current = path.resolve(start);
    try { if (fs.statSync(current).isFile()) current = path.dirname(current); } catch { current = path.dirname(current); }
    for (;;) {
        if (fs.existsSync(path.join(current, '.agents', 'core'))) return current;
        // A linked or nested checkout is its own source context even when its
        // installation is elsewhere; do not climb into its parent installation.
        if (fs.existsSync(path.join(current, '.git'))) return invocation ? current : null;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

/**
 * Explicit neutral/legacy environment > native invocation cwd > installed entrypoint.
 * Toolkit assets remain relative to the installed module, independently of data root.
 * This resolves the current worktree only. Shared ignored state must still use
 * _lib/project-root.resolveProjectRoot; do not collapse that established split.
 */
function resolveRuntimeContext({ env = process.env, input = {}, cwd = process.cwd(), entrypoint = __filename } = {}) {
    const installedRoot = findInstalledRoot(entrypoint);
    if (!installedRoot) throw new Error('Runtime entrypoint is outside a toolkit installation');
    const invocationCwd = path.resolve(input.cwd || cwd);
    const explicit = env.AGENTS_PROJECT_DIR || env.AGENT_SOURCE_ROOT || env.CODEX_PROJECT_DIR || env.CLAUDE_PROJECT_DIR;
    const projectRoot = explicit ? path.resolve(explicit) : findInstalledRoot(invocationCwd, { invocation: true }) || (input.cwd ? invocationCwd : installedRoot);
    let sharedStateRoot = projectRoot;
    if (env.AGENT_SHARED_STATE_ROOT) sharedStateRoot = path.resolve(env.AGENT_SHARED_STATE_ROOT);
    else try {
        const common = path.resolve(projectRoot, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim());
        if (path.basename(common) === '.git') sharedStateRoot = path.dirname(common);
    } catch { /* Standalone installation retains its source-root state. */ }
    return { projectRoot, sourceRoot: projectRoot, sharedStateRoot, installedRoot, invocationCwd, assetsRoot: path.join(installedRoot, '.agents') };
}
module.exports = { findInstalledRoot, resolveRuntimeContext };
