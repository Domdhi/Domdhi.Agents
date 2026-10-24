/**
 * Generate work/timeline.md from git history.
 *
 * Usage:
 *   node .claude/core/gen-timeline.js [full|update]
 *
 * - full:   regenerate from first commit (default if file doesn't exist)
 * - update: incremental from last documented commit
 *
 * Called by /timeline command. Can also run standalone.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DOC_PATHS } = require('./constants');

// ── Date helpers (timezone-safe, uses local date strings) ───────────────────

function getMonday(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}`;
}

function formatWeekHeader(mondayStr) {
    const [y, m, d] = mondayStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `Week of ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

// ── Theme grouping (for days with >5 commits) ──────────────────────────────

function groupByTheme(dayCommits) {
    const groups = {};
    for (const c of dayCommits) {
        const prefixMatch = c.msg.match(/^(\w+)(?:\(([^)]+)\))?:/);
        let theme;
        if (prefixMatch) {
            const type = prefixMatch[1];
            const scope = prefixMatch[2];
            if (scope) {
                theme = scope.charAt(0).toUpperCase() + scope.slice(1);
            } else {
                const typeMap = {
                    feat: 'Features', fix: 'Fixes', docs: 'Documentation',
                    refactor: 'Refactoring', test: 'Testing', chore: 'Chores',
                    style: 'Styling', perf: 'Performance',
                };
                theme = typeMap[type] || type.charAt(0).toUpperCase() + type.slice(1);
            }
        } else {
            theme = 'Other';
        }
        if (!groups[theme]) groups[theme] = [];
        groups[theme].push(c);
    }
    return groups;
}

// ── Incremental merge (update mode) ─────────────────────────────────────────
//
// Update mode fetches only commits AFTER the last documented hash, then splices
// them onto the existing timeline. A naive prepend duplicates the boundary week's
// `## Week of …` header (and its shared day) whenever the new commits land in a
// week the timeline already covers. These helpers merge by header instead: a week
// present on both sides is merged at the day level (shared day = summed counts +
// concatenated commit bullets, existing-then-new), never re-emitted twice.

// Split a weeks-only markdown body into blocks keyed by their `## Week of …` line.
function splitWeekBlocks(text) {
    const blocks = [];
    let cur = null;
    for (const line of text.split('\n')) {
        if (/^## Week of /.test(line)) {
            if (cur) blocks.push(cur);
            cur = { header: line.trim(), body: [] };
        } else if (cur) {
            cur.body.push(line);
        }
    }
    if (cur) blocks.push(cur);
    return blocks;
}

// Trim leading blank lines and trailing blank/`---` separator lines from a week body.
function normalizeWeekBody(lines) {
    const out = [...lines];
    while (out.length && out[0].trim() === '') out.shift();
    while (out.length && (out[out.length - 1].trim() === '' || out[out.length - 1].trim() === '---')) out.pop();
    return out;
}

// Parse a normalized week body into day blocks: `### {base} (N commits, M files)`.
function parseDayBlocks(lines) {
    const days = [];
    let cur = null;
    for (const line of lines) {
        const dh = line.match(/^### (.*?) \((\d+) commits?, (\d+) files?\)\s*$/);
        if (dh) {
            cur = { base: dh[1], commits: parseInt(dh[2], 10), files: parseInt(dh[3], 10), body: [] };
            days.push(cur);
        } else if (cur) {
            cur.body.push(line);
        }
    }
    for (const d of days) {
        while (d.body.length && d.body[0].trim() === '') d.body.shift();
        while (d.body.length && d.body[d.body.length - 1].trim() === '') d.body.pop();
    }
    return days;
}

function emitDay(d) {
    const label = `${d.commits} commit${d.commits !== 1 ? 's' : ''}, ${d.files} files`;
    return `### ${d.base} (${label})\n` + (d.body.length ? d.body.join('\n') + '\n' : '') + '\n';
}

function emitWeek(header, days) {
    return `${header}\n\n` + days.map(emitDay).join('') + '---\n\n';
}

// Merge two ascending day lists. New commits are strictly newer, so the only
// possible overlap is existing's LAST day vs new's FIRST day (same calendar day):
// merge those (sum counts, existing bullets then new bullets); everything else
// concatenates in order, preserving the ascending-by-date layout.
function mergeWeekDays(oldDays, newDays) {
    const result = oldDays.map((d) => ({ ...d, body: [...d.body] }));
    if (result.length && newDays.length && result[result.length - 1].base === newDays[0].base) {
        const last = result[result.length - 1];
        const first = newDays[0];
        result[result.length - 1] = {
            base: last.base,
            commits: last.commits + first.commits,
            files: last.files + first.files,
            body: [...last.body, ...first.body],
        };
        result.push(...newDays.slice(1).map((d) => ({ ...d, body: [...d.body] })));
    } else {
        result.push(...newDays.map((d) => ({ ...d, body: [...d.body] })));
    }
    return result;
}

// Merge the freshly-generated weeks with the existing weeks. New weeks are all
// >= the newest existing week, so [merged/new weeks…] then [remaining old weeks…]
// stays newest-first. A week header shared by both sides is merged once, never
// duplicated.
function mergeTimeline(newWeeksText, oldWeeksText) {
    const newBlocks = splitWeekBlocks(newWeeksText);
    const oldBlocks = splitWeekBlocks(oldWeeksText);
    const oldByHeader = new Map(oldBlocks.map((b) => [b.header, b]));
    const usedOld = new Set();
    let out = '';
    for (const nb of newBlocks) {
        const ob = oldByHeader.get(nb.header);
        const nDays = parseDayBlocks(normalizeWeekBody(nb.body));
        if (ob) {
            const oDays = parseDayBlocks(normalizeWeekBody(ob.body));
            out += emitWeek(nb.header, mergeWeekDays(oDays, nDays));
            usedOld.add(nb.header);
        } else {
            out += emitWeek(nb.header, nDays);
        }
    }
    for (const ob of oldBlocks) {
        if (usedOld.has(ob.header)) continue;
        out += emitWeek(ob.header, parseDayBlocks(normalizeWeekBody(ob.body)));
    }
    return out;
}

// ── Ref safety (F33 / M5) ────────────────────────────────────────────────────
//
// Git ref names legally ALLOW shell metacharacters ($ ( ) ` ; | & and more —
// unlike filenames, `git check-ref-format` does not forbid them). `--base <ref>`
// (default 'HEAD') used to be string-interpolated into an `execSync` shell
// command, so a hostile ref (`x$(touch PROOF)`) achieved RCE the moment the
// gate ran. The primary fix is argv-mode `execFileSync` below (the ref is
// delivered as ONE argv element, never re-parsed by a shell); this validation
// is defense-in-depth on top of that — reject anything containing a shell
// metacharacter or whitespace so a hostile/malformed --base value fails loudly
// and immediately instead of being silently accepted.
//
// M5: a leading `-` is ALSO rejected. Argv-mode kills shell RCE, but git itself
// still parses a leading-dash argv element as a FLAG, not a revision — e.g.
// `--base '--output=/path/to/file'` makes `git log … --output=/path/to/file`
// write git-log content to an arbitrary file (confirmed: `git log --output=<f>`
// really does this). `git check-ref-format` itself forbids a ref from starting
// with `-`, so rejecting it here costs no legitimate ref. This is layered with
// (not a substitute for) the `--end-of-options` guard at the execFileSync call
// site below, which neutralizes flag-injection even for any value that slips
// past this check (e.g. inside a `hash..ref` range, where the ref itself can't
// start the whole argv element).

function assertSafeRef(ref) {
    if (/[\s$`;|&()]/.test(ref) || ref.startsWith('-')) {
        console.error(`[gen-timeline] refusing --base "${ref}": contains shell/ref-hostile characters ($ ( ) \` ; | & or whitespace) or a leading "-" (git-flag injection).`);
        process.exit(1);
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
    const timelinePath = path.join(projectDir, 'docs', DOC_PATHS.timeline);

    // Parse argv: a positional mode (full|update) plus an optional `--base <ref>`.
    // Default base is HEAD (always valid on the current branch) — the old hardcoded
    // literal `main` broke on any repo whose default branch isn't named "main".
    const argv = process.argv.slice(2);
    let baseRef = 'HEAD';
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--base') { baseRef = argv[++i] || baseRef; continue; }
        if (a.startsWith('--')) continue;
        positional.push(a);
    }
    assertSafeRef(baseRef);
    const mode = positional[0] || (fs.existsSync(timelinePath) ? 'update' : 'full');

    // ── Gather git data ─────────────────────────────────────────────────────
    //
    // F33: baseRef (and, in update mode, the `hash..baseRef` range) is passed as
    // a single argv element to execFileSync — NEVER string-interpolated into a
    // shell command. A commit range is one git revision argument, so it's built
    // in JS and passed as one element, same as a bare ref.

    let revArg = baseRef;

    if (mode === 'update' && fs.existsSync(timelinePath)) {
        const existing = fs.readFileSync(timelinePath, 'utf8');
        const hashMatch = existing.match(/<!-- last:([a-f0-9]{40}) -->/);
        if (hashMatch) {
            revArg = `${hashMatch[1]}..${baseRef}`;
        }
    }

    // M5: `--end-of-options` tells git that every argv element AFTER it is a
    // revision/pathspec, never a flag — so even a value that begins with `-`
    // (which assertSafeRef already rejects for `baseRef` alone, but which could
    // otherwise still reach git via other paths, e.g. embedded in a range) can
    // never be reinterpreted as `--output=<file>` or any other git flag. Applies
    // to both the bare-ref (full mode) and `hash..ref` range (update mode) forms.
    let raw;
    try {
        raw = execFileSync('git', ['log', '--format=%H|%ai|%s', '--reverse', '--numstat', '--end-of-options', revArg], {
            cwd: projectDir,
            maxBuffer: 50 * 1024 * 1024,
            windowsHide: true,
        }).toString().trim();
    } catch (err) {
        console.log(JSON.stringify({ feedback: `git log failed: ${err.message}` }));
        process.exit(0);
    }

    // Parse numstat output: commit lines have |, stat lines have tabs
    const lines = raw.split('\n');
    const commits = [];
    let current = null;

    for (const line of lines) {
        if (line.match(/^[a-f0-9]{40}\|/)) {
            if (current) commits.push(current);
            const parts = line.split('|');
            const localDate = parts[1].trim().split(' ')[0]; // YYYY-MM-DD in local time
            current = {
                hash: parts[0],
                shortHash: parts[0].slice(0, 7),
                localDate,
                // F34: rejoin everything after the second `|` — a subject
                // containing a literal pipe ("fix: handle a|b case") was
                // silently truncated at its first embedded `|` by parts[2].
                msg: parts.slice(2).join('|').replace(/Co-Authored-By:.*/gi, '').trim(),
                files: 0,
            };
        } else if (current && (line.match(/^\d/) || line.match(/^-\t/))) {
            current.files++;
        }
    }
    if (current) commits.push(current);

    if (commits.length === 0) {
        console.log(JSON.stringify({ feedback: 'No new commits to process.' }));
        process.exit(0);
    }

    // ── Build week/day structure ────────────────────────────────────────────

    const weeks = new Map();

    for (const c of commits) {
        const monday = getMonday(c.localDate);
        if (!weeks.has(monday)) weeks.set(monday, new Map());
        const week = weeks.get(monday);
        if (!week.has(c.localDate)) week.set(c.localDate, []);
        week.get(c.localDate).push(c);
    }

    const sortedWeeks = [...weeks.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const lastHash = commits[commits.length - 1].hash;

    // ── Format output ───────────────────────────────────────────────────────

    // Derive project name from directory
    const projectName = path.basename(projectDir);
    let output = `# ${projectName} Project Timeline\n\n`;
    output += `*Generated ${new Date().toISOString().split('T')[0]} — ${commits.length} commits, ${sortedWeeks.length} weeks*\n\n`;
    output += `<!-- last:${lastHash} -->\n\n`;

    for (const [monday, days] of sortedWeeks) {
        output += `## ${formatWeekHeader(monday)}\n\n`;
        const sortedDays = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));

        for (const [dayStr, dayCommits] of sortedDays) {
            const totalFiles = dayCommits.reduce((sum, c) => sum + c.files, 0);
            output += `### ${formatDate(dayStr)} (${dayCommits.length} commit${dayCommits.length > 1 ? 's' : ''}, ${totalFiles} files)\n`;

            if (dayCommits.length <= 5) {
                for (const c of dayCommits) {
                    output += `- ${c.msg}\n`;
                }
            } else {
                const groups = groupByTheme(dayCommits);
                for (const [theme, themeCommits] of Object.entries(groups)) {
                    output += `**${theme}** (${themeCommits.length} commit${themeCommits.length > 1 ? 's' : ''})\n`;
                    for (const c of themeCommits) {
                        const cleanMsg = c.msg.replace(/^\w+(\([^)]+\))?:\s*/, '');
                        output += `- ${cleanMsg}\n`;
                    }
                    output += '\n';
                }
            }
            output += '\n';
        }
        output += '---\n\n';
    }

    // ── Write (full or incremental) ─────────────────────────────────────────

    if (mode === 'update' && fs.existsSync(timelinePath)) {
        // For update: merge new weeks into existing content by header (M2) — a
        // boundary week shared with the existing timeline is merged, not duplicated.
        const existing = fs.readFileSync(timelinePath, 'utf8');
        const existingWeekIdx = existing.indexOf('\n## Week of');
        const newWeekIdx = output.indexOf('## Week of');
        if (existingWeekIdx !== -1 && newWeekIdx !== -1) {
            const headerPart = output.slice(0, newWeekIdx); // refreshed title + last-hash marker
            const newWeeks = output.slice(newWeekIdx);
            const existingWeeks = existing.slice(existingWeekIdx + 1);
            output = headerPart + mergeTimeline(newWeeks, existingWeeks);
        }
    }

    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });  // work/ may not exist yet
    fs.writeFileSync(timelinePath, output);

    console.log(JSON.stringify({
        feedback: `Timeline ${mode === 'full' ? 'generated' : 'updated'}: ${commits.length} commits, ${sortedWeeks.length} weeks (${commits[0].localDate} → ${commits[commits.length - 1].localDate})`,
    }));
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = {
    getMonday, formatDate, formatWeekHeader, groupByTheme, main,
    splitWeekBlocks, normalizeWeekBody, parseDayBlocks, mergeWeekDays, mergeTimeline,
    assertSafeRef,
};
