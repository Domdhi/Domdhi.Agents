#!/usr/bin/env node

/**
 * Daily Log — Standalone utility for capturing session learnings
 *
 * Appends a timestamped entry to docs/.output/.state/memory-daily/{YYYY-MM-DD}.md
 * with git state, in-progress work, and key decisions.
 *
 * Designed to be called from any trigger:
 *   - Pre-compaction hook (automatic on context compression)
 *   - /end command (every session end)
 *   - Manual: node .claude/core/daily-log.js capture [--trigger <name>]
 *
 * The daily log feeds the memory acquisition pipeline:
 *   daily-log.js → docs/.output/.state/memory-daily/{YYYY-MM-DD}.md
 *     → memory-extractor.js (manual Haiku, brownfield only)
 *     → memory-manager.js create
 *
 * Note: memory-compiler.js was retired 2026-04-20
 * (per .claude/commands/review/memory-health.md:29).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getDailyDir } = require('./_lib/daily-log-paths');
const { resolveProjectRoot, resolveWorktreeRoot } = require('./_lib/project-root');

/**
 * Build a compact commit-specific daily log entry string. Pure — no fs I/O,
 * no `this`, no hidden `Date.now()` — `timeLabel` is supplied by the caller
 * so callers with independent `new Date()` snapshots stay byte-identical.
 *
 * @param {string} hash - Short commit hash (7+ chars)
 * @param {string} subject - Commit subject line
 * @param {number} filesChanged - Number of files changed
 * @param {number} [insertions] - Total lines inserted (optional)
 * @param {number} [deletions] - Total lines deleted (optional)
 * @param {string} timeLabel - Pre-computed HH:MM label
 * @returns {string} The formatted entry text
 */
function formatCommitEntry(hash, subject, filesChanged, insertions, deletions, timeLabel) {
    const hasDiffstat = Number.isFinite(insertions) && Number.isFinite(deletions);
    const diffstatLine = hasDiffstat ? `\n**Diffstat:** +${insertions} -${deletions}` : '';

    return `## ${timeLabel} — post-commit

**Commit:** \`${hash}\` — ${subject}
**Files changed:** ${filesChanged}${diffstatLine}

`;
}

class DailyLog {
    constructor(projectRoot) {
        // F12: route the fallback through resolveProjectRoot() (CLAUDE_PROJECT_DIR
        // > main-worktree git-common-dir > this dir) instead of the raw
        // __dirname/../.. fallback — daily-log.js was the one memory-domain
        // module missed by the worktree-root retrofit. Without it, a bare CLI
        // invocation or a hook-spawned child running inside a linked worktree
        // (cwd set, CLAUDE_PROJECT_DIR not) writes captures into that worktree's
        // local gitignored .state/memory-daily/, which is lost when the worktree
        // is removed instead of landing in the shared main-worktree log.
        this.projectRoot = process.env.AGENT_SOURCE_ROOT ? resolveWorktreeRoot(path.resolve(__dirname, '..', '..')) : projectRoot || resolveProjectRoot(path.resolve(__dirname, '..', '..'));
        const sharedRoot = process.env.AGENT_SHARED_STATE_ROOT ? resolveProjectRoot(this.projectRoot) : this.projectRoot;
        this.dailyDir = getDailyDir(sharedRoot);
    }

    /**
     * Run a shell command, return output or empty string on failure.
     */
    run(cmd, { timeoutMs } = {}) {
        const timeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 5000) : 5000;
        try {
            return execSync(cmd, { cwd: this.projectRoot, encoding: 'utf8', timeout, windowsHide: true }).trim();
        } catch {
            return '';
        }
    }

    /**
     * Recursively collect TODO*.md files under `rootDir`, skipping generated/
     * vendored subtrees. Mirrors the recursion in status.js/metrics.js so
     * per-module TODOs (docs/modules/{module}/TODO*.md) are not missed.
     *
     * @param {string} rootDir - Directory to walk.
     * @returns {string[]} Absolute paths to TODO*.md files, sorted for determinism.
     */
    _scanTodoFiles(rootDir) {
        const SKIP_DIRS = new Set(['.archive', '.output', 'node_modules', '.git']);
        const found = [];
        const scan = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (SKIP_DIRS.has(entry.name)) continue;
                const full = path.join(dir, entry.name);
                if (entry.isFile() && /^TODO.*\.md$/i.test(entry.name)) {
                    found.push(full);
                } else if (entry.isDirectory()) {
                    scan(full);
                }
            }
        };
        scan(rootDir);
        return found.sort();
    }

    /**
     * Find in-progress [>] and blocked [!] items from TODO files.
     * Recurses all of docs/ (skip-dirs excluded) so module TODOs are included.
     */
    findInProgressTodos() {
        const docsDir = path.join(this.projectRoot, 'docs');
        const results = [];

        for (const filePath of this._scanTodoFiles(docsDir)) {
            const file = path.basename(filePath);
            let content;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch {
                continue;
            }
            for (const line of content.split('\n')) {
                if (line.match(/\[>\]/)) {
                    results.push(`  - [>] ${line.replace(/^[\s\-*]*\[>\]\s*/, '').trim()} (${file})`);
                }
                if (line.match(/\[!\]/)) {
                    results.push(`  - [!] ${line.replace(/^[\s\-*]*\[!\]\s*/, '').trim()} (${file})`);
                }
            }
        }

        return results.length > 0 ? results.join('\n') : '  None';
    }

    /**
     * Find key decisions from TODO files' Key Decisions tables.
     *
     * Scans the docs/ root (flat — the master TODO_{Project}.md lives there) plus
     * per-module TODOs under docs/modules/** (recursive). It deliberately does NOT
     * scan docs/work/todo/ — per-epic checklists carry no master Key Decisions table.
     */
    findKeyDecisions() {
        const docsDir = path.join(this.projectRoot, 'docs');
        if (!fs.existsSync(docsDir)) return '  None';

        // docs/ root, flat.
        const files = [];
        try {
            for (const f of fs.readdirSync(docsDir)) {
                if (/^TODO.*\.md$/i.test(f)) files.push(path.join(docsDir, f));
            }
        } catch {
            // ignore — fall through to module scan
        }
        // Per-module TODOs (recursive).
        files.push(...this._scanTodoFiles(path.join(docsDir, 'modules')));

        const results = [];
        for (const filePath of files) {
            let content;
            try {
                content = fs.readFileSync(filePath, 'utf8');
            } catch {
                continue;
            }
            const decisionMatch = content.match(/## Key Decisions\s*\n\n?\|[^\n]*\n\|[^\n]*\n([\s\S]*?)(?=\n##|\n---|\n$)/);
            if (decisionMatch) {
                const rows = decisionMatch[1].split('\n').filter(r => r.startsWith('|') && !r.includes('---'));
                for (const row of rows.slice(-5)) {
                    results.push(`  ${row.trim()}`);
                }
            }
        }

        return results.length > 0 ? results.join('\n') : '  None';
    }

    /**
     * Capture a daily log entry. Returns the path to the daily log file.
     *
     * @param {string} trigger - What triggered this capture (e.g., 'pre-compaction', 'end', 'manual')
     * @returns {{ logPath: string, dateStr: string }} Path to the log file and the date string
     */
    capture(trigger = 'manual', snapshot) {
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeLabel = now.toISOString().slice(11, 16); // HH:MM

        const branch = typeof snapshot?.branch === 'string' ? snapshot.branch : this.run('git branch --show-current');
        const gitLog = typeof snapshot?.gitLog === 'string' ? snapshot.gitLog : this.run('git log --oneline -5');
        const recentCommits = (gitLog || (snapshot?.logAvailable === false && !snapshot?.unborn
            ? '(recent commits unavailable)' : '(no commits)')).split('\n').slice(0, 3).join('\n');
        const inProgress = this.findInProgressTodos();
        const decisions = this.findKeyDecisions();

        const entry = `## ${timeLabel} — ${trigger}

**Branch:** ${snapshot?.statusAvailable === false ? '(branch unavailable)' : branch}

### Recent Commits
\`\`\`
${recentCommits}
\`\`\`

### In-Progress Work
${inProgress}

### Key Decisions
${decisions}

`;

        fs.mkdirSync(this.dailyDir, { recursive: true });
        const logPath = path.join(this.dailyDir, `${dateStr}.md`);
        fs.appendFileSync(logPath, entry, 'utf8');

        return { logPath, dateStr };
    }

    /**
     * Capture a free-text note as a daily log entry.
     * Called by /remember to persist conversational insights that git can't capture.
     *
     * @param {string} note - The text to remember
     * @param {string} trigger - What triggered this capture (default: 'remember')
     * @returns {{ logPath: string, dateStr: string }}
     */
    captureNote(note, trigger = 'remember') {
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeLabel = now.toISOString().slice(11, 16);

        const entry = `## ${timeLabel} — ${trigger}

${note}

`;

        fs.mkdirSync(this.dailyDir, { recursive: true });
        const logPath = path.join(this.dailyDir, `${dateStr}.md`);
        fs.appendFileSync(logPath, entry, 'utf8');

        return { logPath, dateStr };
    }

    /**
     * Capture a compact commit-specific daily log entry.
     * Called by memory-capture.cjs when a git commit is detected.
     *
     * @param {string} hash - Short commit hash (7+ chars)
     * @param {string} subject - Commit subject line
     * @param {number} filesChanged - Number of files changed
     * @param {number} [insertions] - Total lines inserted (optional)
     * @param {number} [deletions] - Total lines deleted (optional)
     * @returns {{ logPath: string, dateStr: string }}
     */
    captureCommit(hash, subject, filesChanged, insertions, deletions) {
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeLabel = now.toISOString().slice(11, 16);

        const entry = formatCommitEntry(hash, subject, filesChanged, insertions, deletions, timeLabel);

        fs.mkdirSync(this.dailyDir, { recursive: true });
        const logPath = path.join(this.dailyDir, `${dateStr}.md`);
        fs.appendFileSync(logPath, entry, 'utf8');

        return { logPath, dateStr };
    }
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

if (require.main === module) {
    const args = process.argv.slice(2);
    const command = args[0];

    if (command === 'capture') {
        const triggerIdx = args.indexOf('--trigger');
        const trigger = triggerIdx !== -1 ? args[triggerIdx + 1] || 'manual' : 'manual';

        const log = new DailyLog();
        const { logPath } = log.capture(trigger);
        const rel = path.relative(log.projectRoot, logPath);
        console.log(`Daily log entry appended: ${rel}`);
    } else if (command === 'note') {
        const note = args.slice(1).filter(a => !a.startsWith('--')).join(' ');
        if (!note) {
            console.error('Usage: node daily-log.js note "text to remember"');
            process.exit(1);
        }
        const triggerIdx = args.indexOf('--trigger');
        const trigger = triggerIdx !== -1 ? args[triggerIdx + 1] || 'remember' : 'remember';

        const log = new DailyLog();
        const { logPath } = log.captureNote(note, trigger);
        const rel = path.relative(log.projectRoot, logPath);
        console.log(`Note captured: ${rel}`);
    } else {
        console.log(`Daily Log — capture session learnings for the memory pipeline

Usage:
  node daily-log.js capture [--trigger <name>]   Capture git state + TODOs
  node daily-log.js note "text" [--trigger name]  Capture a free-text note

Triggers: pre-compaction, end, remember, manual (default)
Output:   docs/.output/.state/memory-daily/{YYYY-MM-DD}.md (appended)
Pipeline: daily-log.js → docs/.output/.state/memory-daily/{YYYY-MM-DD}.md (captured) → memory-extractor.js extract (manual) → memory-manager.js create`);
    }
}

DailyLog.formatCommitEntry = formatCommitEntry;

module.exports = DailyLog;
