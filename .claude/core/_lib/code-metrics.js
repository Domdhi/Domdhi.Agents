/**
 * Code Metrics — LOC and file-count loader for status.js.
 *
 * Extracted from status.js (P2.4) to separate metrics loading from rendering.
 * Scans source files (.js, .ts, .cjs, .mjs) under projectRoot, counts lines,
 * and aggregates by top-level directory.
 *
 * Usage:
 *   const { loadCodeMetrics } = require('./_lib/code-metrics');
 *   const metrics = loadCodeMetrics(projectRoot);
 *   // → { loc: number, fileCount: number, byDir: Record<string, number> }
 *
 * Constraints:
 *   - Never reads process.cwd() — always anchored to the explicit projectRoot arg.
 *   - Excludes node_modules, .git, .archive, and hidden dot-dirs.
 *   - Only counts .js, .ts, .cjs, .mjs extensions (source files only).
 */

const fs = require('fs');
const path = require('path');
// F2: the tree walk is _lib/file-walker.js's generic generator (skipHidden
// prunes dot-dirs — the pattern rule the old private copy hardcoded); this
// module keeps only the extension filter + line counting.
const { walkDir } = require('./file-walker');

/** Extensions counted as source code lines. */
const SOURCE_EXTENSIONS = new Set(['.js', '.ts', '.cjs', '.mjs']);

/** Top-level directory names to skip entirely. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.archive', '.claude-v1']);

/**
 * Count the lines in a file. Empty files return 0.
 *
 * @param {string} absPath
 * @returns {number}
 */
function countLines(absPath) {
    try {
        const content = fs.readFileSync(absPath, 'utf8');
        if (!content) return 0;
        // Count newlines — a file with N lines has at least N-1 newlines.
        // Standard: if content ends with '\n', the trailing empty segment is not a line.
        const lines = content.split('\n');
        const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
        return Math.max(0, count);
    } catch {
        return 0;
    }
}

/**
 * Load code metrics for a project.
 *
 * Scans all source files under `projectRoot`, counting lines of code and
 * file counts. Never uses process.cwd() — always anchors to projectRoot.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @returns {{ loc: number, fileCount: number, byDir: Record<string, number> }}
 */
function loadCodeMetrics(projectRoot) {
    let loc = 0;
    let fileCount = 0;
    const byDir = {};

    let topLevelEntries;
    try {
        topLevelEntries = fs.readdirSync(projectRoot, { withFileTypes: true });
    } catch {
        return { loc, fileCount, byDir };
    }

    for (const entry of topLevelEntries) {
        if (!entry.isDirectory()) {
            // Handle source files directly in projectRoot (no top-level dir key)
            const ext = path.extname(entry.name);
            if (SOURCE_EXTENSIONS.has(ext)) {
                const lines = countLines(path.join(projectRoot, entry.name));
                loc += lines;
                fileCount++;
            }
            continue;
        }

        // Skip blacklisted top-level dirs
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

        const topDirName = entry.name;
        const topDirPath = path.join(projectRoot, topDirName);
        let dirLoc = 0;
        let dirFileCount = 0;

        for (const absPath of walkDir(topDirPath, [...SKIP_DIRS], { skipHidden: true })) {
            if (!SOURCE_EXTENSIONS.has(path.extname(absPath))) continue;
            dirLoc += countLines(absPath);
            dirFileCount++;
        }

        if (dirFileCount > 0) {
            byDir[topDirName] = dirLoc;
            loc += dirLoc;
            fileCount += dirFileCount;
        }
    }

    return { loc, fileCount, byDir };
}

module.exports = { loadCodeMetrics };
