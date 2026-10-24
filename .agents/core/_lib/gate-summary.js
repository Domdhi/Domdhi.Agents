/**
 * Gate Summary — write/read contract for `_latest-summary.json`.
 *
 * The gate writes; command-usage-logger reads. Without a shared contract the
 * two ends drift (see the 3-strikes retro finding at TDD-3/TDD-5/TDD-6 that
 * led to the gate-summary fallback in command-usage-logger).
 *
 * readSummary returns null unless `typeof parsed.overall === 'boolean'`. This
 * null signal is load-bearing: command-usage-logger falls back to the exit-code
 * inference path when readSummary returns null. Do NOT widen the validation.
 */

const fs = require('fs');
const path = require('path');
const { getSummaryPath } = require('./telemetry-paths');

/**
 * Write the gate summary to its canonical path. Creates parent dirs as needed.
 * Pretty-prints the JSON so humans can read `_latest-summary.json` directly.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @param {object} summary      Gate summary object; must have `overall: boolean`
 */
function writeSummary(projectRoot, summary) {
    const summaryPath = getSummaryPath(projectRoot);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

/**
 * Read the gate summary. Returns the parsed object only if it has a boolean
 * `overall` field; returns null otherwise (missing file, invalid JSON, missing
 * field, non-boolean field).
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @returns {object|null}       Parsed summary or null
 */
function readSummary(projectRoot) {
    try {
        const content = fs.readFileSync(getSummaryPath(projectRoot), 'utf8');
        const parsed = JSON.parse(content);
        return typeof parsed.overall === 'boolean' ? parsed : null;
    } catch {
        return null;
    }
}

module.exports = { writeSummary, readSummary };
