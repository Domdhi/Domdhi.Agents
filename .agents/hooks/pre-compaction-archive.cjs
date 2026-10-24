#!/usr/bin/env node

/**
 * Pre-Compaction Archive Hook
 *
 * PreCompact hook — snapshots key project context before Claude Code
 * compresses the conversation. Captures git status, in-progress TODO items,
 * recent commits, and key decisions so context survives compaction.
 *
 * Fires on both manual (/compact) and auto-compact triggers.
 *
 * Output:
 *   - Session snapshot: docs/.output/.state/sessions/{YYYY-MM-DD}/{HHMM}-pre-compaction.md
 *   - Daily log entry:  docs/.output/.state/memory-daily/{YYYY-MM-DD}.md (via daily-log.js)
 *
 * Exit codes:
 *   0 = always (PreCompact hooks cannot block compaction)
 */

const fs = require('fs');
const path = require('path');
const DailyLog = require('../core/daily-log');
const { resolveProjectRoot, resolveWorktreeRoot } = require('../core/_lib/project-root');

// Anchor writes to the repo root — not the caller's CWD. Without this, a prior
// `cd src && ...` in the same shell session leaves the hook's CWD at `src/`,
// and a subsequent /compact dumps the snapshot into `src/docs/.output/.state/sessions/`
// and the daily log into `src/docs/.output/.state/memory-daily/`. Match the
// convention used by command-usage-logger.cjs, gate.js, and ~10 other core
// scripts: CLAUDE_PROJECT_DIR env var first, else resolve worktree-safely via
// _lib/project-root.js's resolveProjectRoot() (git-common-dir — anchors the
// GITIGNORED docs/.output/.state/ writes to the shared MAIN worktree instead
// of whichever linked worktree happens to be current; hook lives at
// .claude/hooks/, so ../../ is repo root).
//
// Resolved lazily (not at module load) so in-process tests can set
// CLAUDE_PROJECT_DIR per test case via beforeEach/afterEach without having to
// reload the module.
function getProjectRoot() {
    return resolveProjectRoot(path.resolve(__dirname, '..', '..'));
}

// F73: shared stdin plumbing — the hand-rolled copy this replaced had DROPPED
// hook-input.js's TTY fast-path (a manual terminal invocation hung on the
// 1000ms timeout instead of resolving immediately). readHookInput() restores it.
const { readHookInput } = require('../core/_lib/hook-input');
const readStdin = () => readHookInput({ timeoutMs: 1000 });

const COMPACTION_GIT_BUDGET_MS = 2000;
function collectGitContext(log) {
    const deadline = Date.now() + COMPACTION_GIT_BUDGET_MS;
    const read = command => {
        const remaining = deadline - Date.now();
        return remaining > 0 ? log.run(command, { timeoutMs: remaining }) : '';
    };
    // F74: two git spawns, not three — `--branch` folds the branch name into
    // the status output's first line (`## <branch>...<upstream>`), replacing
    // the separate `git branch --show-current` subprocess. Strip that header
    // line back off so gitStatus stays the bare --short listing it always was.
    const statusWithBranch = read('git status --short --branch');
    const statusLines = statusWithBranch.split('\n');
    const branchHeader = statusLines[0] && statusLines[0].startsWith('## ') ? statusLines.shift() : null;
    const gitStatus = statusLines.join('\n').replace(/\n+$/, '');
    const gitLog = read('git log --oneline -5');
    // `## main...origin/main [ahead 1]` → `main`; detached HEAD reports
    // `## HEAD (no branch)` → '' (same empty result `--show-current` gives);
    // an unborn branch reports `## No commits yet on <branch>`.
    let branch = '';
    const unborn = branchHeader?.match(/^## No commits yet on (.+)$/);
    if (branchHeader && !branchHeader.startsWith('## HEAD')) {
        branch = unborn ? unborn[1].trim() : branchHeader.slice(3).split('...')[0].trim();
    }
    return { branch, gitStatus, gitLog, statusAvailable: branchHeader !== null,
        logAvailable: Boolean(gitLog), unborn: Boolean(unborn) };
}

function buildSnapshot(projectRoot, log, trigger, gitContext = collectGitContext(log)) {
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 19).replace('T', ' ');
    const { branch, gitStatus, gitLog } = gitContext;
    const inProgress = log.findInProgressTodos();
    const decisions = log.findKeyDecisions();

    // Read handoff context if available. Handoffs are per-session/per-branch
    // files under docs/.output/handoffs/ — resolve the newest for this branch.
    let handoffContext = '';
    let handoffPath = null;
    try {
        const { resolveLatest, slugBranch } = require('../core/handoff-path');
        // Unknown status cannot select another branch's context. A verified
        // detached HEAD uses the resolver's established `head` key.
        const rel = gitContext.statusAvailable === false ? null
            : resolveLatest({ cwd: projectRoot, branch: branch ? slugBranch(branch) : 'head' });
        if (rel) handoffPath = path.join(projectRoot, rel);
    } catch {
        // resolver unavailable → skip handoff context (best-effort snapshot)
    }
    if (handoffPath && fs.existsSync(handoffPath)) {
        try {
            const handoffContent = fs.readFileSync(handoffPath, 'utf8');
            const decisionsMatch = handoffContent.match(/## Decisions & Context\s*\n([\s\S]*?)(?=\n## |\n---|\n$)/);
            const actionsMatch = handoffContent.match(/## Next Actions\s*\n([\s\S]*?)(?=\n## |\n---|\n$)/);
            const parts = [];
            if (decisionsMatch) parts.push(`### Decisions & Context\n${decisionsMatch[1].trim()}`);
            if (actionsMatch) parts.push(`### Next Actions\n${actionsMatch[1].trim()}`);
            if (parts.length > 0) handoffContext = parts.join('\n\n');
        } catch {
            // Graceful degradation
        }
    }

    // Read recent agent updates if available. The store rotates by day under
    // docs/.output/evolution/agents/{YYYY-MM-DD}.md so no single file grows unbounded;
    // older (pre-rotation) projects may still have the legacy flat
    // docs/.output/evolution/agents.md (path-lint:keep). Prefer the folder (newest day-files), fall
    // back to the flat file.
    let agentUpdates = '';
    try {
        const updatesDir = path.join(projectRoot, 'docs', '.output', 'evolution', 'agents');
        const flatPath = path.join(projectRoot, 'docs', '.output', 'evolution', 'agents.md');
        let updatesContent = '';
        if (fs.existsSync(updatesDir) && fs.statSync(updatesDir).isDirectory()) {
            // Day-files sit flat ({YYYY-MM-DD}.md, native) or one level deep under a
            // {YYYY-MM}/ month dir (homed). Collect both so neither layout is missed.
            const isDayFile = f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f);
            const dayFiles = [];
            for (const ent of fs.readdirSync(updatesDir, { withFileTypes: true })) {
                if (ent.isFile() && isDayFile(ent.name)) {              // skips README.md
                    dayFiles.push({ name: ent.name, abs: path.join(updatesDir, ent.name) });
                } else if (ent.isDirectory() && /^\d{4}-\d{2}$/.test(ent.name)) {
                    const monthDir = path.join(updatesDir, ent.name);
                    for (const f of fs.readdirSync(monthDir)) {
                        if (isDayFile(f)) dayFiles.push({ name: f, abs: path.join(monthDir, f) });
                    }
                }
            }
            // Select the newest 3 distinct DAYS, then read every file for those
            // days — a day present both flat and month-nested (partially-homed
            // store) must not consume two of the three day slots.
            const sorted = dayFiles.sort((a, b) => a.name.localeCompare(b.name));
            const keepDays = new Set([...new Set(sorted.map(d => d.name))].slice(-3));
            updatesContent = sorted
                .filter(d => keepDays.has(d.name))
                .map(d => fs.readFileSync(d.abs, 'utf8'))
                .join('\n');
        } else if (fs.existsSync(flatPath)) {
            updatesContent = fs.readFileSync(flatPath, 'utf8');
        }
        const sections = updatesContent.split(/(?=^## )/m).filter(s => s.trim());
        const recent = sections.slice(-5).join('\n').trim();
        if (recent) agentUpdates = recent;
    } catch {
        // Graceful degradation
    }

    const sessionContext = (handoffContext || agentUpdates)
        ? `\n## Session Context\n\n${handoffContext}${handoffContext && agentUpdates ? '\n\n' : ''}${agentUpdates ? `### Recent Agent Updates\n${agentUpdates}` : ''}\n`
        : '';

    return `# Pre-Compaction Snapshot

**Timestamp:** ${timestamp}
**Trigger:** ${trigger}
**Branch:** ${gitContext.statusAvailable === false ? '(branch unavailable)' : branch}

## Git Status
\`\`\`
${gitContext.statusAvailable === false ? '(git status unavailable)' : gitStatus || '(clean)'}
\`\`\`

## Recent Commits
\`\`\`
${gitLog || (gitContext.unborn ? '(no commits)' : '(recent commits unavailable)')}
\`\`\`

## In-Progress Work
${inProgress}

## Recent Key Decisions
${decisions}
${sessionContext}`;
}

function processEvent(parsedJson) {
    const trigger = parsedJson?.trigger || 'unknown';
    // Ignore parsedJson.cwd — relying on the event's cwd field (or process.cwd())
    // was the source bug this hook had to fix. See getProjectRoot() comment above.
    const projectRoot = getProjectRoot();

    const log = new DailyLog(projectRoot);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');

    const sourceRoot = process.env.AGENT_SOURCE_ROOT ? resolveWorktreeRoot(projectRoot) : projectRoot;
    const gitContext = collectGitContext(log);
    const snapshot = buildSnapshot(sourceRoot, log, trigger, gitContext);

    const sessionsDir = path.join(projectRoot, 'docs', '.output', '.state', 'sessions', dateStr);
    fs.mkdirSync(sessionsDir, { recursive: true });

    const snapshotPath = path.join(sessionsDir, `${timeStr}-pre-compaction.md`);
    fs.writeFileSync(snapshotPath, snapshot, 'utf8');

    process.stderr.write(`\n  Pre-compaction snapshot saved: ${path.relative(projectRoot, snapshotPath)}\n\n`);

    // Write daily log entry via shared utility
    try {
        const { logPath } = log.capture('Pre-Compaction', gitContext);
        process.stderr.write(`  Daily log entry appended: ${path.relative(projectRoot, logPath)}\n\n`);
    } catch {
        // Graceful degradation — daily log failure does not affect snapshot or exit code
    }

    // Memory extraction is no longer triggered from the compaction path.
    // It now fires unconditionally from the session-handoff skill (Step 6)
    // on every /do, /run-todo wave, /run-tests, /todo, /end completion.
    // See .claude/skills/session-handoff/SKILL.md for details.
}

async function main() {
    const input = await readStdin();
    let data = {};
    try {
        data = JSON.parse(input);
    } catch {
        // Continue with defaults
    }

    try {
        processEvent(data);
    } catch {
        // PreCompact hooks cannot block compaction — a snapshot failure
        // (buildSnapshot, mkdirSync, writeFileSync) must never surface as an
        // uncaught exception. Best-effort capture only; exit 0 unconditionally.
    }
    process.exit(0);
}

if (require.main === module) {
    // P1.7 — hook duration instrumentation (F75), same pattern as siblings.
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('pre-compaction-archive');
    process.on('exit', () => {
        try { emitHookEvent(_hookToken, 'success'); } catch { /* never fail on telemetry */ }
    });

    // Backstop for anything that escapes the try/catch in main() (e.g. an
    // async rejection after processEvent's synchronous scope has exited) —
    // mirrors session-start-prime.cjs's top-level guard. This hook's
    // documented contract is "Exit codes: 0 = always"; without these handlers
    // a thrown error here would print a stack trace and exit non-zero instead.
    process.on('uncaughtException', () => process.exit(0));
    process.on('unhandledRejection', () => process.exit(0));

    main();
}

module.exports = { processEvent, buildSnapshot };
