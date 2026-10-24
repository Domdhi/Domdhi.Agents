/**
 * Daily Log Paths — canonical path helpers for the daily-log pipeline.
 *
 * Extracted from two duplicated inline implementations:
 *   - .claude/core/daily-log.js constructor (path.join inline)
 *   - .claude/hooks/memory-capture.cjs:33-36 (getDailyLogPath local wrapper)
 *
 * All callers pass a resolved projectRoot — this module does not consult
 * CLAUDE_PROJECT_DIR or __dirname itself (CLAUDE_PROJECT_DIR anchoring
 * semantics stay in the callers).
 */

const path = require('path');

const DAILY_SUBPATH = ['docs', '.output', '.state', 'memory-daily'];

/**
 * Return the canonical daily-log directory for a project.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @returns {string}            <projectRoot>/docs/.output/.state/memory-daily
 */
function getDailyDir(projectRoot) {
    return path.join(projectRoot, ...DAILY_SUBPATH);
}

/**
 * Return the canonical daily-log file path for a given date.
 *
 * @param {Date|string} date     Date object, 'YYYY-MM-DD' string, or longer ISO string
 * @param {string}      projectRoot  Absolute path to the project root
 * @returns {string}             <projectRoot>/docs/.output/.state/memory-daily/<YYYY-MM-DD>.md
 */
function getDailyLogPath(date, projectRoot) {
    let dateStr;
    if (date instanceof Date) {
        dateStr = date.toISOString().slice(0, 10);
    } else {
        dateStr = String(date).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            throw new Error(`getDailyLogPath: invalid date "${date}" — expected a Date object or a 'YYYY-MM-DD'-prefixed string`);
        }
    }
    return path.join(getDailyDir(projectRoot), `${dateStr}.md`);
}

module.exports = { getDailyDir, getDailyLogPath };
