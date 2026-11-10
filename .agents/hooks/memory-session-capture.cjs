#!/usr/bin/env node

/**
 * Memory Session Capture Hook (SessionEnd) — stage candidate memories from the finished session.
 *
 * OPT-IN per project: does nothing unless MEMORY_CAPTURE=on (put it in .claude/settings.local.json "env" or
 * the user environment). It also does nothing, and starts no process, unless a provider is configured:
 *   - Anthropic (default): ANTHROPIC_API_KEY, or MEMORY_CAPTURE_KEY_COMMAND (a command whose stdout is the key)
 *   - MEMORY_CAPTURE_PROVIDER=claude-cli: no key; one `claude -p` call through your own Claude login (counts against your
 *     plan's usage). The child session runs with MEMORY_CAPTURE_INNER=1 and no hooks, so it can never recurse.
 *   - MEMORY_CAPTURE_PROVIDER=openai with MEMORY_CAPTURE_MODEL (+ MEMORY_CAPTURE_BASE_URL): any OpenAI-compatible server
 *
 * PRIVACY: capture sends the session transcript to the provider (Anthropic's API by default). Output is
 * filtered for secrets and every candidate must quote the session verbatim, but do not enable capture in a
 * project where credentials are pasted into sessions. Candidates are staged for human review
 * (`memory-capture.js list|promote|discard`); nothing reaches an agent until promoted.
 *
 * Mechanics: the hook returns immediately. The work runs in one detached child (`memory-capture.js capture
 * --session <transcript> --then-index`, about $0.01 on Haiku), logging to .state/memory-notes/capture.log.
 * ALWAYS exits 0. Disable: unset MEMORY_CAPTURE, or MEMORY_PROFILE=minimal.
 *
 * Notes sync (separate opt-in, MEMORY_SYNC=on): the same hook mirrors this machine's notes into the tracked
 * docs/.output/.memory/notes/ so a normal commit carries them to other machines (see `memory-capture.js sync`).
 *
 * Codex: not registered. Codex rollout transcripts are a different format from Claude's session JSONL.
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { isAtLeast } = require('../core/profile');
const { readHookInput } = require('../core/_lib/hook-input');
const { notesContext, captureEnabled, syncEnabled } = require('../core/_lib/memory-context');

/** True when a capture provider is configured (cheap check; the CLI resolves the key itself). */
function providerConfigured(env) {
    if (String(env.MEMORY_CAPTURE_PROVIDER || '').toLowerCase().replace(/^claude$/, 'claude-cli') === 'claude-cli') return true;
    if (String(env.MEMORY_CAPTURE_PROVIDER || '').toLowerCase() === 'openai') return Boolean(env.MEMORY_CAPTURE_MODEL);
    return Boolean(env.ANTHROPIC_API_KEY || env.MEMORY_CAPTURE_KEY_COMMAND);
}

/** @returns {boolean} true when a capture child was started */
function processEvent(input, { env = process.env, fallbackDir = path.resolve(__dirname, '..', '..'), spawn = childProcess.spawn } = {}) {
    if (!isAtLeast('standard') || env.MEMORY_CAPTURE_INNER) return false;   // MEMORY_CAPTURE_INNER: we ARE the capture's own claude -p child
    if (syncEnabled(env)) {
        try {
            const flagged = require('../core/memory-capture').isSecret;
            require('../core/_lib/memory-sync').autoSync({ direction: 'push', fallbackDir, env, isSecret: flagged });
        } catch { /* sync never fails a session end */ }
    }
    if (!captureEnabled(env) || !providerConfigured(env)) return false;
    const transcript = input && typeof input.transcript_path === 'string' ? input.transcript_path : '';
    if (!transcript || !transcript.endsWith('.jsonl') || !fs.existsSync(transcript)) return false;

    const ctx = notesContext(fallbackDir, env);
    fs.mkdirSync(ctx.stateDir, { recursive: true });
    const log = fs.openSync(ctx.logPath, 'a');
    try {
        fs.writeSync(log, `== ${new Date().toISOString()} capture ${path.basename(transcript)}\n`);
        const cli = path.join(__dirname, '..', 'core', 'memory-capture.js');
        // detached on every OS: the child must outlive Claude Code closing the session (setsid on POSIX).
        const child = spawn(process.execPath, [cli, 'capture', '--session', transcript, '--max-keep', '8', '--quiet', '--then-index'], {
            cwd: ctx.projectRoot, stdio: ['ignore', log, log], windowsHide: true, detached: true, env,
        });
        child.unref();
        return true;
    } finally {
        fs.closeSync(log);
    }
}

module.exports = { processEvent, providerConfigured };

if (require.main === module) {
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const token = startHookTiming('memory-session-capture');
    let outcome = 'success';
    process.on('uncaughtException', () => process.exit(0));
    (async () => {
        try {
            const raw = await readHookInput({ timeoutMs: 800 });
            if (raw && raw.trim()) processEvent(JSON.parse(raw));
        } catch {
            outcome = 'failure';
        }
        try { emitHookEvent(token, outcome); } catch { /* telemetry never fails a session end */ }
        process.exit(0);
    })();
}
