/**
 * Hook Spawners — shared background-process spawn for hooks.
 *
 * One option matrix for every fire-and-forget child a hook starts (the index
 * rebuild in session-start-prime, daily-log capture, the curator):
 *   stdio: 'ignore', cwd, windowsHide: true, detached on Windows, then child.unref().
 *
 * WHY detached on Windows: libuv assigns a NON-detached child to its
 * parent's kill-on-close job object, so the child is killed the moment the hook
 * process exits; `unref()` only stops the parent from waiting. Node documents
 * `detached: true` as the way a Windows child continues after its parent exits.
 * Detaching sets DETACHED_PROCESS, so the child gets no console of its own; any
 * CONSOLE subprocess it then starts without windowsHide opens a visible console
 * window (proved on Windows). That is why every child_process
 * call in the canonical and generated core/hook trees passes windowsHide, enforced
 * by .agents/core/__tests__/windows-hide-guard.test.js. The older
 * "no detached (console-flash)" rule kept these children from ever finishing on
 * Windows. On POSIX a plain child already outlives its parent, so the default
 * stays non-detached there.
 *
 * The spawn function and platform are injectable for tests; production callers
 * pass neither, so `childProcess.spawn` is resolved at call time (a test spy on
 * the module object, or an injected fake child_process module, sees it).
 */

const childProcess = require('child_process');
const path = require('path');

/**
 * Start one background child that survives the calling hook.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @param {string} options.cwd
 * @param {Function} [options.spawn]     Override for child_process.spawn (testing)
 * @param {string}   [options.platform]  Override for process.platform (testing)
 * @returns {object} the child process
 */
function spawnBackground(command, args, { cwd, spawn = childProcess.spawn, platform = process.platform } = {}) {
    const child = spawn(command, args, {
        cwd,
        stdio: 'ignore',
        windowsHide: true,
        detached: platform === 'win32',
    });
    child.unref();
    return child;
}

/**
 * Spawn `.claude/core/daily-log.js capture --trigger <trigger>` in the background
 * so the hook can return immediately without blocking on daily-log work.
 *
 * @param {string} projectRoot         Absolute path to the project root
 * @param {string} trigger             Trigger label (e.g. 'auto-stop')
 * @param {object} [options]           Test overrides passed through to spawnBackground
 */
function spawnDailyLogCapture(projectRoot, trigger, options = {}) {
    return spawnBackground('node', [
        path.join(projectRoot, '.claude', 'core', 'daily-log.js'),
        'capture',
        '--trigger',
        trigger,
    ], { ...options, cwd: projectRoot });
}

module.exports = { spawnBackground, spawnDailyLogCapture };
