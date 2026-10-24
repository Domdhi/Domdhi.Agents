#!/usr/bin/env node

/**
 * Session-End Doc-Sync Hook
 *
 * SessionEnd hook — runs a lightweight, NON-BLOCKING doc-drift check when a
 * session closes, so docs stop drifting silently just because the explicit
 * update step (`/review:update-docs`) is opt-in. It surfaces only what the
 * cheap `detectDocDrift` primitive covers: legacy-named planning docs,
 * duplicate docs, and misplaced TODO files. It never runs the full
 * `/review:check-sync` cross-reference workflow, and it never blocks the
 * session from ending.
 *
 * Scope boundary: this catches NAMING/PLACEMENT drift only. It does NOT detect
 * SEMANTIC contradictions between documents (e.g. one command saying a feature
 * is "not built" while another command implements it) — that needs
 * cross-reference parsing the primitive deliberately doesn't do.
 *
 * Opt-out: set CLAUDE_NO_DOC_SYNC=1 (e.g. in .claude/settings.local.json) and
 * the hook no-ops before doing any drift work.
 *
 * SessionEnd payload: { session_id, transcript_path, cwd, hook_event_name, source }
 *
 * Output:
 *   - On drift: a non-blocking notice on stderr (surfaced to the model).
 *   - On no drift: nothing (silent — the common production path).
 *
 * Exit codes:
 *   0 = always (SessionEnd hooks must never block session close).
 */

const { readHookInput, parseHookPayload } = require('../core/_lib/hook-input');
const { resolveProjectRoot, resolveWorktreeRoot } = require('../core/_lib/project-root');
const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
// Required as a namespace (not destructured) so tests can spy on detectDocDrift
// to exercise the error/catch branch — the call site reads it off the module.
const docDrift = require('../core/_lib/doc-drift');

/**
 * Run the non-blocking doc-drift check for a resolved project root. Pure of
 * process control (no process.exit) so it is directly unit-testable and counts
 * toward v8 coverage. Writes a notice to stderr on drift; otherwise silent.
 *
 * @param {string} projectRoot
 * @returns {{ status: 'opted-out'|'clean'|'drift'|'error', hasDrift: boolean, noticeEmitted: boolean }}
 */
function runDocSync(projectRoot) {
    // Opt-out short-circuit — bail BEFORE any drift work.
    if (process.env.CLAUDE_NO_DOC_SYNC === '1') {
        return { status: 'opted-out', hasDrift: false, noticeEmitted: false };
    }

    const t = startHookTiming('session-end-doc-sync');
    try {
        const { legacy, duplicates, misplacedTodos, hasDrift } = docDrift.detectDocDrift(projectRoot);

        if (!hasDrift) {
            emitHookEvent(t, 'clean');
            return { status: 'clean', hasDrift: false, noticeEmitted: false };
        }

        const lines = ['', '  Doc-sync notice (non-blocking) — planning-doc drift detected:'];
        for (const l of legacy) {
            lines.push(`    • legacy doc ${l.file} → ${l.canonical}` +
                (l.canonicalExists ? ' (both exist — reconcile)' : ' (rename/migrate)'));
        }
        for (const d of duplicates) {
            lines.push(`    • duplicate ${d.root} vs ${d.canonical} (keep canonical)`);
        }
        for (const m of misplacedTodos) {
            lines.push(`    • misplaced TODO ${m.file} (move to docs/work/todo/)`);
        }
        lines.push('  Run /review:check-sync or /onboard to reconcile. (Set CLAUDE_NO_DOC_SYNC=1 to silence.)', '');
        process.stderr.write(lines.join('\n') + '\n');

        emitHookEvent(t, 'drift');
        return { status: 'drift', hasDrift: true, noticeEmitted: true };
    } catch {
        // Never let a drift-check failure affect session close.
        emitHookEvent(t, 'failure');
        return { status: 'error', hasDrift: false, noticeEmitted: false };
    }
}

async function main() {
    // Read + parse the SessionEnd payload (best-effort; the hook works without it).
    // The parsed payload (session_id/cwd/source) is not needed — drift detection
    // is keyed off the resolved project root — but we drain stdin so the hook
    // doesn't leave the pipe dangling.
    const raw = await readHookInput();
    parseHookPayload(raw);

    const projectRoot = resolveProjectRoot(require('path').resolve(__dirname, '..', '..'));
    runDocSync(process.env.AGENT_SOURCE_ROOT ? resolveWorktreeRoot(projectRoot) : projectRoot);

    process.exit(0);
}

if (require.main === module) {
    main();
}

module.exports = { runDocSync, main };
