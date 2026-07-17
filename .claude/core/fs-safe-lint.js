#!/usr/bin/env node

/**
 * fs-safe-lint.js — trust-boundary fs-safe regression lint.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/.output/findings/reviews/retro-full-review-260716.md` found the same
 * defect shape three separate times across one epic: a raw `fs.writeFileSync`/
 * `fs.rmSync`-class call bypassing the symlink-safe wrappers in `_lib/fs-safe.js`
 * at a site that crosses the adopter trust boundary (fleet.js/publish.js's
 * `pruneEmptyDirs`, install.js's zone-copy sites, template-updater.js's merge
 * writes). Coverage was reviewer-memory-dependent — this lint makes it mechanical.
 *
 * SCOPE — deliberately NOT `core/`/`hooks/`/`tools/`-wide.
 * -------------------------------------------------------
 * "Trust boundary crossing" is a semantic property (does this write's destination
 * come from an adopter-controlled path?), not something derivable from directory
 * alone. A directory-wide raw-fs-call scan would flag dozens of legitimate
 * workshop-local writes (gate.js reports, telemetry logs, memory store files —
 * none of which ever touch an adopter's tree) and the noise would make the lint
 * something people learn to ignore. Instead `TRUST_BOUNDARY_FILES` hardcodes the
 * confirmed fileset: every module that writes into a *target/adopter* directory
 * (verified by grep — the exact 9 files below, 7 already 100% fs-safe-routed,
 * 2 with a handful of raw calls all confirmed workshop-local: os.tmpdir() diffs,
 * VERSION_PATH/CHANGELOG_PATH, the report path under docs/.output/findings/reviews/).
 * If a new module starts writing into an adopter tree, add it to the list —
 * same operating model as path-drift-lint.js's EXTRA_ROOTS/EXTRA_FILES.
 *
 * RULES
 *   UNGUARDED_WRITE   ERROR  raw fs.writeFileSync/copyFileSync/cpSync with no
 *                            fs-safe-lint:local marker on the line. Fix: route
 *                            through safeWrite/safeCopy (_lib/fs-safe.js), or
 *                            mark the line if the destination is confirmed
 *                            workshop-local (not adopter-controlled).
 *   UNGUARDED_DELETE  ERROR  raw fs.rmSync/rmdirSync with no marker AND no
 *                            assertNoSymlinkedAncestor() call within the
 *                            preceding GUARD_WINDOW lines (the established
 *                            pattern: guard immediately before the delete, as
 *                            fleet.js/publish.js's pruneEmptyDirs does).
 *
 * Lines carrying the `fs-safe-lint:local` marker are a curated exception, same
 * convention as path-drift-lint.js's KEEP_MARKERS — reserved for destinations
 * hand-verified as workshop-local, not a blanket escape hatch.
 *
 * USAGE
 *   node .claude/core/fs-safe-lint.js [--root <dir>] [paths…]
 *
 * Exit codes: 0 clean · 1 any ERROR · 2 usage error.
 */

const fs = require('fs');
const path = require('path');

const LOCAL_MARKER = 'fs-safe-lint:local';
const WRITE_RE = /fs\.(writeFileSync|copyFileSync|cpSync)\s*\(/;
const DELETE_RE = /fs\.(rmSync|rmdirSync)\s*\(/;
const GUARD_RE = /assertNoSymlinkedAncestor\s*\(/;
const GUARD_WINDOW = 6; // lines to look back for a preceding ancestor-symlink guard

// Confirmed adopter-trust-boundary-crossing modules (see header). Relative to
// the project root passed to runLint.
const TRUST_BOUNDARY_FILES = [
    '.claude/core/install.js',
    '.claude/core/template-updater.js',
    '.claude/core/scaffold.js',
    '.claude/core/_lib/skill-merger.js',
    '.claude/core/_lib/agent-merger.js',
    '.claude/core/_lib/zone-copy.js',
    '.claude/core/_lib/settings-merger.js',
    'tools/fleet.js',
    'tools/publish.js',
];

/**
 * Scan file text for raw fs write/delete calls that bypass fs-safe.js.
 * @param {string} text
 * @returns {Array<{line:number, rule:string, severity:string, token:string, hint:string}>}
 */
function scanText(text) {
    const lines = text.split('\n');
    const findings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(LOCAL_MARKER)) continue;

        if (WRITE_RE.test(line)) {
            findings.push({
                line: i + 1,
                rule: 'UNGUARDED_WRITE',
                severity: 'ERROR',
                token: line.trim(),
                hint: 'raw fs write/copy — route through safeWrite/safeCopy (_lib/fs-safe.js), or mark the line `fs-safe-lint:local` if the destination is a confirmed workshop-local path (not adopter-controlled)',
            });
            continue;
        }

        if (DELETE_RE.test(line)) {
            const windowStart = Math.max(0, i - GUARD_WINDOW);
            const guarded = lines.slice(windowStart, i).some((l) => GUARD_RE.test(l));
            if (!guarded) {
                findings.push({
                    line: i + 1,
                    rule: 'UNGUARDED_DELETE',
                    severity: 'ERROR',
                    token: line.trim(),
                    hint: 'raw fs delete — route through safeDelete, or call assertNoSymlinkedAncestor() immediately before it, or mark the line `fs-safe-lint:local`',
                });
            }
        }
    }
    return findings;
}

/**
 * Lint the trust-boundary fileset (or an explicit override).
 * @param {string} projectRoot
 * @param {{ files?: string[] }} [opts]
 * @returns {{ findings: Array, scanned: number }}
 */
function runLint(projectRoot, { files } = {}) {
    const fileset = files && files.length ? files : TRUST_BOUNDARY_FILES;
    const findings = [];
    let scanned = 0;
    for (const rel of fileset) {
        const abs = path.join(projectRoot, rel);
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        scanned++;
        for (const hit of scanText(text)) {
            findings.push({ file: rel, ...hit });
        }
    }
    return { findings, scanned };
}

function formatReport({ findings, scanned }) {
    if (findings.length === 0) {
        return `fs-safe-lint: clean — ${scanned} files scanned.\n`;
    }
    const errors = findings.filter((f) => f.severity === 'ERROR');
    const lines = [`fs-safe-lint: ${errors.length} error(s) across ${scanned} files\n`];
    for (const f of findings) {
        lines.push(`  ${f.severity.padEnd(5)} ${f.file}:${f.line} ${f.rule} '${f.token}' — ${f.hint}`);
    }
    lines.push('');
    return lines.join('\n');
}

module.exports = {
    TRUST_BOUNDARY_FILES,
    scanText,
    runLint,
    formatReport,
};

// ---- CLI ----
if (require.main === module) {
    const argv = process.argv.slice(2);
    let root = process.cwd();
    const explicit = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root') {
            root = path.resolve(argv[++i] || '');
            if (!argv[i]) { process.stderr.write('usage: fs-safe-lint.js [--root <dir>] [paths…]\n'); process.exit(2); }
        } else if (argv[i].startsWith('-')) {
            process.stderr.write(`fs-safe-lint.js: unknown flag ${argv[i]}\nusage: fs-safe-lint.js [--root <dir>] [paths…]\n`);
            process.exit(2);
        } else {
            explicit.push(argv[i]);
        }
    }
    const result = runLint(root, { files: explicit.length ? explicit : undefined });
    process.stdout.write(formatReport(result));
    process.exit(result.findings.some((f) => f.severity === 'ERROR') ? 1 : 0);
}
