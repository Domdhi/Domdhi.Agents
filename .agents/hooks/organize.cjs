/**
 * Organize Hook — Plans + Screenshots
 *
 * Moves loose files into dated folder structures:
 *   Plans:       docs/.output/plans/{YYYY-MM-DD}/{HHMM}-{story}-{slug}.md
 *   Screenshots: docs/.output/.state/screenshots/{YYYY-MM-DD}/{task}/
 *
 * Also updates Work Document References in Epic TODO files (plans only).
 *
 * Triggers:
 *   - PostToolUse:ExitPlanMode (plans)
 *   - PostToolUse:Bash (screenshots)
 *   - Manual: node .claude/hooks/organize.cjs ["task description"]
 */

const fs = require('fs');
const path = require('path');

// ── Shared Utilities ────────────────────────────────────────────────

function toSlug(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}

function dateFolder(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timePrefix(date) {
    return `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
}

function uniquePath(targetPath) {
    if (!fs.existsSync(targetPath)) return targetPath;
    const ext = path.extname(targetPath);
    const base = targetPath.slice(0, -ext.length || undefined);
    let counter = 2;
    let candidate;
    do {
        candidate = ext ? `${base}-${counter}${ext}` : `${base}-${counter}`;
        counter++;
    } while (fs.existsSync(candidate));
    return candidate;
}

const isDateDir = (name) => /^\d{4}-\d{2}-\d{2}$/.test(name);

// ── Race-tolerant fs helpers ────────────────────────────────────────
// This hook fires on ~every PostToolUse:Bash. Concurrent invocations (e.g.
// parallel /run-todo) race over the same dirs: a file one pass lists in readdir
// is renamed away by another pass before this one stats/renames it → ENOENT.
// These wrappers make each fs step idempotent under that race.

function safeReaddirSync(dir) {
    try {
        return fs.readdirSync(dir);
    } catch {
        // Missing/removed dir → nothing to organize
        return [];
    }
}

/** readdir with Dirents (F68) — one syscall pass instead of readdir + per-entry stat. */
function safeReaddirEntsSync(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        // Missing/removed dir → nothing to organize
        return [];
    }
}

function safeStatSync(p) {
    try {
        return fs.statSync(p);
    } catch {
        // File vanished between readdir and stat (concurrent pass moved it)
        return null;
    }
}

function safeReadFileSync(p) {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        // File vanished between stat and read (concurrent pass moved it).
        // Returns null (not '') so callers can tell "vanished" from "genuinely empty".
        return null;
    }
}

/**
 * Rename src→dest, tolerating the concurrent-move race.
 * @returns {boolean} true if the file was moved, false if the source was already
 *   gone (ENOENT) — another pass moved it, so this pass just skips it.
 */
function safeRename(src, dest) {
    try {
        fs.renameSync(src, dest);
        return true;
    } catch (e) {
        if (e && e.code === 'ENOENT') return false; // already moved by a concurrent pass
        throw e; // unexpected — let the top-level guard in processEvent catch it
    }
}

// ── Plans ───────────────────────────────────────────────────────────

function organizePlans(results) {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ||
        path.resolve(__dirname, '..', '..');

    const sourceDirs = [
        path.join(projectDir, 'docs', '.output', 'plans'),
        path.join(projectDir, '.claude', 'plans'),
    ];
    const targetDir = path.join(projectDir, 'docs', '.output', 'plans');

    // Collect unorganized markdown files from all source directories.
    // Single stat per file (null-guarded) so a file vanishing mid-scan is skipped,
    // not fatal.
    const files = [];
    for (const plansDir of sourceDirs) {
        for (const f of safeReaddirSync(plansDir)) {
            if (!f.endsWith('.md')) continue;
            // Not already organized: skip YYYY-MM-DD date folders AND YYMMDD-HHMM
            // run-stamp prefixes (e.g. do/run-todo plans).
            if (/^(?:\d{4}-\d{2}-\d{2}|\d{6}-\d{4})/.test(f)) continue;
            const stat = safeStatSync(path.join(plansDir, f));
            if (!stat || !stat.isFile()) continue;
            files.push({
                name: f,
                path: path.join(plansDir, f),
                created: stat.birthtime || stat.mtime
            });
        }
    }

    if (files.length === 0) return;

    for (const plan of files) {
        const content = safeReadFileSync(plan.path);
        // Vanished between stat-collect and read (a concurrent pass moved it) —
        // skip just this one file, not the whole batch.
        if (content === null) continue;

        // Extract story number from content
        const storyMatch = content.match(/Story\s+(\d+\.\d+)/i);
        const storyNumber = storyMatch ? `story-${storyMatch[1]}` : null;

        // Extract topic from content
        let topic = null;
        const summaryMatch = content.match(/^##\s+(?:Executive\s+)?Summary\s*\n+([^\n#]+)/im);
        if (summaryMatch) {
            topic = summaryMatch[1].trim().replace(/^[-*]\s*/, '');
        }
        if (!topic) {
            const topicMatch = content.match(/^##\s+(?:Topic|Purpose|Goal)\s*\n+([^\n#]+)/im);
            if (topicMatch) {
                topic = topicMatch[1].trim().replace(/^[-*]\s*/, '');
            }
        }

        // Fall back to first heading
        const titleMatch = content.match(/^#\s+(?:Plan:\s*)?(.+)/m);
        let title = titleMatch ? titleMatch[1] : 'untitled-plan';
        title = title.replace(/Story\s+\d+\.\d+[:\s]*/i, '').trim();

        if (!topic) topic = title;

        // Clean topic for Work Refs table
        topic = topic
            .replace(/^(implementation|plan|research|fix|add|update|create)\s+(for\s+)?/i, '')
            .slice(0, 50)
            .trim();

        const slug = toSlug(title).slice(0, 50);
        const dateFolderName = dateFolder(plan.created);
        const time = timePrefix(plan.created);

        // Create target directory
        const dateFolderPath = path.join(targetDir, dateFolderName);
        fs.mkdirSync(dateFolderPath, { recursive: true });

        // Build new filename
        const nameParts = [time];
        if (storyNumber) nameParts.push(storyNumber);
        nameParts.push(slug);
        const newName = `${nameParts.join('-')}.md`;
        const newPath = uniquePath(path.join(dateFolderPath, newName));

        // Skip cleanly if a concurrent pass already moved this file.
        if (!safeRename(plan.path, newPath)) continue;
        const relativePath = path.relative(projectDir, newPath);
        const finalName = path.basename(newPath);
        results.push(`plan: ${plan.name} -> ${relativePath}`);

        // Update Work Document References in TODO files
        updateWorkRefs(projectDir, dateFolderName, finalName, storyNumber, topic, plan.name);
    }
}

// The canonical Work Document References row shape: Date | Document | Story | Topic.
const WORK_REFS_COLUMNS = 4;

/**
 * Locate the insertion point right after the Work Document References table's
 * header separator row.
 *
 * @returns {{ index: number, columns: number } | null} — null when the
 *   section/table isn't present. `columns` is the separator row's column count,
 *   so a caller can flag a table whose shape doesn't match the row it writes.
 */
function findWorkRefsInsertPoint(content) {
    const workRefsIndex = content.indexOf('## Work Document References');
    if (workRefsIndex === -1) return null;

    const afterHeader = content.slice(workRefsIndex);
    // Layout-generic separator match. The old pattern hardcoded FOUR columns and
    // omitted `:`, so it rejected both a 3- or 5-column table and the perfectly
    // ordinary alignment syntax `|:---|:---|:---|:---|` — and `updateWorkRefs`
    // then returned silently, never recording the plan. Now: ≥2 columns, `:`
    // allowed, and no newline in the character class so the match can't span rows.
    // At least one `-` is required so a blank row (`|   |   |`) isn't mistaken
    // for the separator.
    let sepMatch = null;
    for (const m of afterHeader.matchAll(/\|[ \t:-]+(?:\|[ \t:-]+)+\|/g)) {
        if (m[0].includes('-')) { sepMatch = m; break; }
    }
    if (!sepMatch) return null;

    return {
        index: workRefsIndex + sepMatch.index + sepMatch[0].length,
        columns: sepMatch[0].split('|').length - 2,
    };
}

function updateWorkRefs(projectDir, dateFolderName, finalName, storyNumber, topic, originalName) {
    const phaseNumber = storyNumber ? storyNumber.match(/story-(\d+)\./)?.[1] : null;
    const phaseFromFilename = originalName.match(/phase(\d+)/i)?.[1];
    const effectivePhase = phaseNumber || phaseFromFilename;

    if (!effectivePhase) return;

    // Dynamic TODO file discovery — sorted for determinism across filesystems
    const todoFilePaths = [];
    const todoSubDir = path.join(projectDir, 'docs', 'work', 'todo');
    if (fs.existsSync(todoSubDir)) {
        fs.readdirSync(todoSubDir)
            .filter(f => f.match(/TODO.*\.md$/i) || f.match(/^_.*\.md$/i))
            .sort()
            .forEach(f => todoFilePaths.push(path.join(todoSubDir, f)));
    }
    const docsRootDir = path.join(projectDir, 'docs');
    if (fs.existsSync(docsRootDir)) {
        fs.readdirSync(docsRootDir)
            .filter(f => f.match(/^TODO_.*\.md$/i))
            .sort()
            .forEach(f => todoFilePaths.push(path.join(docsRootDir, f)));
    }

    const todoFile = todoFilePaths[0];
    if (!todoFile || !fs.existsSync(todoFile)) return;

    // Cheap early bail on the first read: no Work Refs table, or this row
    // already present (e.g. from a prior run). safeReadFileSync (not a bare
    // read) because the file can vanish between the existsSync check above
    // and this read under a concurrent organize pass — same race class as
    // organizePlans's per-plan read.
    const todoContent = safeReadFileSync(todoFile);
    if (todoContent === null) return;
    const found = findWorkRefsInsertPoint(todoContent);
    if (found === null) {
        // Was a silent return: a tracker whose Work Refs table the matcher can't
        // locate simply never got the plan row, with no signal anywhere. Name the
        // file so the layout can be fixed. stderr only — organize is best-effort.
        process.stderr.write(
            `[organize] no usable "## Work Document References" table found in ` +
            `${path.relative(projectDir, todoFile)} — plan row for "${finalName}" not recorded.\n`
        );
        return;
    }
    if (todoContent.includes(finalName)) return;
    if (found.columns !== WORK_REFS_COLUMNS) {
        // The row written below is Date|Document|Story|Topic. Which of those a
        // differently-shaped table wants is not inferable, so write the canonical
        // row anyway and say so — better a visible shape mismatch than a silent
        // drop (the pre-fix behaviour) or a guessed column mapping.
        process.stderr.write(
            `[organize] "## Work Document References" in ${path.relative(projectDir, todoFile)} ` +
            `has ${found.columns} column(s); writing the canonical ` +
            `${WORK_REFS_COLUMNS}-column row (Date | Document | Story | Topic).\n`
        );
    }

    const displayTopic = topic || 'Implementation';
    const storyDisplay = storyNumber ? storyNumber.replace('story-', '') : `Phase ${effectivePhase}`;
    const planAbsPath = path.join(projectDir, 'docs', '.output', 'plans', dateFolderName, finalName);
    const relLink = path.relative(path.dirname(todoFile), planAbsPath).replace(/\\/g, '/');
    const newRow = `\n| ${dateFolderName} | [${finalName}](${relLink}) | ${storyDisplay} | ${displayTopic} |`;

    // Light-touch race mitigation (lower-value secondary note, MINOR finding):
    // this read-modify-write is otherwise unlocked, so two concurrent organize
    // passes updating the same TODO file could both read stale content at
    // function entry and the second write would clobber the first pass's row.
    // Re-read immediately before writing and recompute the insert point + the
    // finalName check against THAT fresh content (not the todoContent read
    // above) to narrow the race window right up to the write itself — a
    // concurrent pass that already inserted this exact row is detected and
    // skipped instead of silently overwritten. Not a full lock (a gap remains
    // between this read and the write), but proportionate for a MINOR/
    // lower-value finding.
    const freshContent = safeReadFileSync(todoFile);
    if (freshContent === null || freshContent.includes(finalName)) return;
    const fresh = findWorkRefsInsertPoint(freshContent);
    if (fresh === null) return;

    const updatedContent = freshContent.slice(0, fresh.index) + newRow + freshContent.slice(fresh.index);
    fs.writeFileSync(todoFile, updatedContent);
}

// ── Screenshots ─────────────────────────────────────────────────────

function organizeScreenshots(results) {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ||
        path.resolve(__dirname, '..', '..');

    const verifyDir = path.join(projectDir, 'docs', '.output', '.state', 'screenshots');
    if (!fs.existsSync(verifyDir)) return;

    const description = process.argv[2] || '';

    function getSlug(fileNames) {
        if (description) return toSlug(description);
        const names = fileNames.map(f => f.replace(/\.[^.]+$/, ''));
        let prefix = names[0] || 'screenshots';
        for (const name of names.slice(1)) {
            while (!name.startsWith(prefix) && prefix.length > 0) {
                const lastHyphen = prefix.lastIndexOf('-');
                prefix = lastHyphen > 0 ? prefix.slice(0, lastHyphen) : '';
            }
        }
        return toSlug(prefix || 'manual-test');
    }

    // F68: ONE withFileTypes pass over screenshots/ root serves BOTH cases
    // (loose root files + date-dir discovery) — the old shape did two full
    // readdirs plus a statSync per entry, on every Bash call, forever.
    // Dirent types are lstat-shaped (a symlink reports neither file nor dir),
    // so symlinked entries fall back to safeStatSync to match the old
    // stat-based behavior; regular entries need no extra syscall.
    const entryIsFile = (parent, e) =>
        e.isFile() || (e.isSymbolicLink() && !!(safeStatSync(path.join(parent, e.name))?.isFile()));
    const entryIsDir = (parent, e) =>
        e.isDirectory() || (e.isSymbolicLink() && !!(safeStatSync(path.join(parent, e.name))?.isDirectory()));
    const rootEntries = safeReaddirEntsSync(verifyDir);

    // Case 1: Loose files in screenshots/ root (null-guarded stats tolerate races)
    const rootFiles = rootEntries
        .filter(e => entryIsFile(verifyDir, e))
        .map(e => e.name);

    if (rootFiles.length > 0) {
        const slug = getSlug(rootFiles);
        const firstStat = safeStatSync(path.join(verifyDir, rootFiles[0]));
        const earliest = rootFiles.reduce((min, f) => {
            const s = safeStatSync(path.join(verifyDir, f));
            if (!s) return min;
            return s.mtime < min ? s.mtime : min;
        }, firstStat ? firstStat.mtime : new Date());

        const dateFolderName = dateFolder(earliest);
        const targetPath = uniquePath(path.join(verifyDir, dateFolderName, slug));
        fs.mkdirSync(targetPath, { recursive: true });

        let moved = 0;
        for (const f of rootFiles) {
            if (safeRename(path.join(verifyDir, f), path.join(targetPath, f))) moved++;
        }
        if (moved > 0) results.push(`screenshots: ${moved} root files -> ${path.relative(verifyDir, targetPath)}/`);
    }

    // Case 2: Loose files inside the NEWEST date folder only (F68). This hook
    // fires on every Bash call; new screenshots only ever land in the current
    // (lexically-newest, YYYY-MM-DD) folder, and prior days were organized by
    // the pass that saw them — re-scanning the whole archive re-paid an
    // unbounded, ever-growing readdir+stat sweep for data that cannot change.
    // (Trade-off: a file hand-dropped into an OLD dated folder is no longer
    // auto-organized; run `node .claude/hooks/organize.cjs` won't touch it
    // either — move it into a task subfolder by hand.)
    const dateDirs = rootEntries
        .filter(e => isDateDir(e.name) && entryIsDir(verifyDir, e))
        .map(e => e.name)
        .sort();
    const newestDateDir = dateDirs[dateDirs.length - 1];

    if (newestDateDir) {
        const datePath = path.join(verifyDir, newestDateDir);
        const looseFiles = safeReaddirEntsSync(datePath)
            .filter(e => entryIsFile(datePath, e))
            .map(e => e.name);

        if (looseFiles.length > 0) {
            const slug = getSlug(looseFiles);
            const targetPath = uniquePath(path.join(datePath, slug));
            fs.mkdirSync(targetPath, { recursive: true });

            let moved = 0;
            for (const f of looseFiles) {
                if (safeRename(path.join(datePath, f), path.join(targetPath, f))) moved++;
            }
            if (moved > 0) results.push(`screenshots: ${moved} files in ${newestDateDir}/ -> ${newestDateDir}/${path.basename(targetPath)}/`);
        }
    }
}

// ── processEvent ────────────────────────────────────────────────────

/**
 * Called by Claude Code hooks (PostToolUse:ExitPlanMode, PostToolUse:Bash).
 * Re-callable: results array is local per invocation.
 *
 * @param {object} _parsedJson — Hook event payload (unused; files discovered via filesystem)
 * @returns {{ feedback: string } | null}
 */
function processEvent(_parsedJson) {
    const results = [];
    // Top-level guard: this hook fires constantly and may run concurrently. A race
    // (or any unexpected fs error) must never throw out of the hook — worst case we
    // organize nothing this pass and a later pass picks it up.
    try {
        organizePlans(results);
        organizeScreenshots(results);
    } catch {
        // Swallow — never block or crash the PostToolUse hook on an organize failure.
    }

    if (results.length === 0) return null;

    return { feedback: `Organized ${results.length} item(s):\n${results.join('\n')}` };
}

// ── Main ────────────────────────────────────────────────────────────

if (require.main === module) {
    // P1.7 — hook duration instrumentation (F69), same pattern as siblings.
    const { startHookTiming, emitHookEvent } = require('../core/_lib/hook-telemetry');
    const _hookToken = startHookTiming('organize');
    process.on('exit', () => {
        try { emitHookEvent(_hookToken, 'success'); } catch { /* never fail on telemetry */ }
    });
    const result = processEvent({});

    if (!result) {
        process.exit(0);
    }

    console.log(JSON.stringify(result));
    process.exit(0);
}

module.exports = { processEvent, toSlug, dateFolder, timePrefix, uniquePath };
