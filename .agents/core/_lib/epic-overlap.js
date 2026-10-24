/**
 * epic-overlap — Detect file ownership overlaps between epics in a backlog.md.
 *
 * Wave-based execution in /run-todo dispatches parallel agents per wave. When two
 * epics claim the same file, concurrent agents produce silent merge conflicts.
 * This module makes that problem visible before /run-todo fires.
 *
 * Phase-awareness (F6): /run-todo dispatches waves PER PHASE — epics in
 * different `## Phase` sections never run concurrently, so a file shared across
 * phases cannot cause a wave collision. Only SAME-PHASE overlaps gate readiness;
 * cross-phase overlaps are reported as informational. This avoids forcing the
 * author to hand-acknowledge dozens of physically-impossible collisions.
 *
 * Exports:
 *   extractEpicFiles(backlogPath)        → Map<epicId, Set<filePath>>
 *   extractEpicPhases(backlogPath)       → Map<epicId, phaseLabel|null>
 *   findOverlaps(epicFilesMap, phaseMap?) → Array<{epicA, epicB, sharedFiles, samePhase?}>
 *       (samePhase is only present when a phaseMap is supplied)
 *
 * CLI:
 *   node epic-overlap.js <backlog-path>
 *   Exit 0 — no overlaps, OR only cross-phase (informational) overlaps
 *   Exit 1 — SAME-PHASE overlaps found (gating; report printed to stdout)
 *   Exit non-zero (via throw) — backlog file not readable
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse a backlog.md file and return a map of epic identifiers to the set of
 * file paths claimed by that epic across all of its stories.
 *
 * Epic headings are recognized by the pattern:
 *   ### Epic <something>: <name>
 * e.g. "### Epic 1: Authentication" or "### Epic A: Auth"
 *
 * File paths are extracted from lines matching:
 *   * `some/path/file.ext` — description
 * inside a `* **Files:**` block under a story. Only the path between the first
 * pair of backticks is kept; everything after (` — description`) is discarded.
 *
 * @param {string} backlogPath  Absolute or relative path to the backlog.md file.
 * @returns {Map<string, Set<string>>} Keys are epic headings (e.g. "Epic 1: Authentication").
 * @throws {Error} If the file cannot be read — message contains the path.
 */
function extractEpicFiles(backlogPath) {
    let content;
    try {
        content = fs.readFileSync(backlogPath, 'utf8');
    } catch (err) {
        throw new Error(
            `epic-overlap: could not read backlog file at "${backlogPath}": ${err.message}`
        );
    }

    const result = new Map();
    const lines = content.split(/\r?\n/);

    // Regex for an epic heading: ### Epic <id>: <name>
    // Captures the full "Epic 1: Authentication" portion as the key.
    const epicHeadingRe = /^###\s+(Epic\s+\S+:\s+.+)$/;

    // A `* **Files:**` marker — zero-or-more leading whitespace so we accept
    // both nested-under-story and flat-under-epic formatting.
    const filesBlockRe = /^\s*\*\s+\*\*Files:\*\*\s*$/;

    // A file entry: optional leading whitespace, `* `, then a backtick-delimited path
    // e.g.:   `    * \`src/auth/login.ts\` — new`
    const fileEntryRe = /^\s*\*\s+`([^`]+)`/;

    let currentEpic = null;   // string key for the current epic
    let inFilesBlock = false;  // are we inside a `**Files:**` list?

    for (const line of lines) {
        // Check for a new epic heading
        const epicMatch = line.match(epicHeadingRe);
        if (epicMatch) {
            const epicKey = epicMatch[1].trim();
            currentEpic = epicKey;
            if (!result.has(currentEpic)) {
                result.set(currentEpic, new Set());
            }
            inFilesBlock = false;
            continue;
        }

        if (currentEpic === null) continue;

        // Check for a **Files:** block marker
        if (filesBlockRe.test(line)) {
            inFilesBlock = true;
            continue;
        }

        if (inFilesBlock) {
            const fileMatch = line.match(fileEntryRe);
            if (fileMatch) {
                result.get(currentEpic).add(fileMatch[1]);
            } else {
                // Any non-file-entry line ends the files block
                // (but only if it isn't blank — blank lines between bullets are ok)
                const trimmed = line.trim();
                if (trimmed !== '') {
                    inFilesBlock = false;
                }
            }
        }
    }

    return result;
}

/**
 * Parse a backlog.md and map each epic to the `## Phase` heading it lives under.
 * Epics declared before any phase heading map to null.
 *
 * @param {string} backlogPath
 * @returns {Map<string, string|null>} epicKey → phase label (or null)
 * @throws {Error} If the file cannot be read.
 */
function extractEpicPhases(backlogPath) {
    let content;
    try {
        content = fs.readFileSync(backlogPath, 'utf8');
    } catch (err) {
        throw new Error(
            `epic-overlap: could not read backlog file at "${backlogPath}": ${err.message}`
        );
    }

    const phases = new Map();
    const lines = content.split(/\r?\n/);
    // `## Phase ...` is level-2; the epic regex is level-3 (`###`). `^##\s+`
    // requires whitespace right after two hashes, so it never matches `### Epic`.
    const phaseHeadingRe = /^##\s+(Phase\s+.+)$/;
    const epicHeadingRe = /^###\s+(Epic\s+\S+:\s+.+)$/;

    let currentPhase = null;
    for (const line of lines) {
        const pM = line.match(phaseHeadingRe);
        if (pM) { currentPhase = pM[1].trim(); continue; }
        const eM = line.match(epicHeadingRe);
        if (eM) { phases.set(eM[1].trim(), currentPhase); }
    }
    return phases;
}

/**
 * Given a Map of epic → Set<filePath>, return all pairs of epics that share at
 * least one file.
 *
 * Each pair appears exactly once. The pair is ordered so that epicA < epicB by
 * string comparison. sharedFiles is sorted alphabetically.
 *
 * When `epicPhaseMap` is supplied, each overlap also carries `samePhase`:
 * true when both epics are in the same phase OR either phase is unknown
 * (conservative — unknown phase still gates); false only when both phases are
 * known and differ (cross-phase → cannot collide in a wave).
 *
 * @param {Map<string, Set<string>>} epicFilesMap
 * @param {Map<string, string|null>} [epicPhaseMap]
 * @returns {Array<{epicA: string, epicB: string, sharedFiles: string[], samePhase?: boolean}>}
 */
function findOverlaps(epicFilesMap, epicPhaseMap = null) {
    const epics = [...epicFilesMap.keys()];
    const overlaps = [];

    for (let i = 0; i < epics.length; i++) {
        for (let j = i + 1; j < epics.length; j++) {
            const keyA = epics[i];
            const keyB = epics[j];
            const setA = epicFilesMap.get(keyA);
            const setB = epicFilesMap.get(keyB);

            const shared = [];
            for (const file of setA) {
                if (setB.has(file)) {
                    shared.push(file);
                }
            }

            if (shared.length === 0) continue;

            shared.sort();

            // Ensure epicA < epicB by string compare
            const [epicA, epicB] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
            const overlap = { epicA, epicB, sharedFiles: shared };
            if (epicPhaseMap) {
                const pa = epicPhaseMap.get(keyA);
                const pb = epicPhaseMap.get(keyB);
                // Unknown phase for either side → treat as same-phase (gate it).
                overlap.samePhase = !(pa && pb) ? true : pa === pb;
            }
            overlaps.push(overlap);
        }
    }

    return overlaps;
}

/**
 * CLI entry point.
 *
 * Usage: node epic-overlap.js <backlog-path>
 *   Exit 0 — no overlaps
 *   Exit 1 — overlaps found (report printed to stdout)
 *   Exit 2 — error (printed to stderr)
 */
function main() {
    const backlogPath = process.argv[2];

    if (!backlogPath) {
        process.stderr.write('Usage: node epic-overlap.js <backlog-path>\n');
        process.exit(2);
    }

    let epicFilesMap, epicPhaseMap;
    try {
        epicFilesMap = extractEpicFiles(backlogPath);
        epicPhaseMap = extractEpicPhases(backlogPath);
    } catch (err) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(2);
    }

    const overlaps = findOverlaps(epicFilesMap, epicPhaseMap);
    const gating = overlaps.filter(o => o.samePhase);
    const crossPhase = overlaps.filter(o => !o.samePhase);

    if (overlaps.length === 0) {
        process.stdout.write(`No epic file overlaps found in ${backlogPath}\n`);
        process.exit(0);
    }

    const lines = [`Epic file overlap report — ${backlogPath}`, ''];

    if (gating.length > 0) {
        lines.push(
            `${gating.length} SAME-PHASE overlap${gating.length === 1 ? '' : 's'} (gating — parallel wave collision risk):`,
            ''
        );
        for (const { epicA, epicB, sharedFiles } of gating) {
            lines.push(`  ${epicA}  ↔  ${epicB}`);
            for (const f of sharedFiles) lines.push(`    • ${f}`);
            lines.push('');
        }
        lines.push(
            'Same-phase epics run in the same /run-todo wave → merge-conflict risk.',
            'Either split the shared files across stories, or add a ## Acknowledged Overlaps',
            'section to backlog.md listing each SAME-PHASE pair and rationale.',
            '/review:check-readiness will then accept them as documented.'
        );
    }

    if (crossPhase.length > 0) {
        lines.push(
            '',
            `${crossPhase.length} cross-phase overlap${crossPhase.length === 1 ? '' : 's'} (informational — different phases run in separate waves, no collision):`,
            ''
        );
        for (const { epicA, epicB, sharedFiles } of crossPhase) {
            const pa = epicPhaseMap.get(epicA) || '?';
            const pb = epicPhaseMap.get(epicB) || '?';
            lines.push(`  ${epicA} [${pa}]  ↔  ${epicB} [${pb}] — ${sharedFiles.length} file(s)`);
        }
        lines.push('', 'These do NOT require acknowledgment.');
    }

    process.stdout.write(lines.join('\n') + '\n');
    // Only SAME-PHASE overlaps gate readiness.
    process.exit(gating.length > 0 ? 1 : 0);
}

module.exports = { extractEpicFiles, extractEpicPhases, findOverlaps, main };

if (require.main === module) {
    main();
}
