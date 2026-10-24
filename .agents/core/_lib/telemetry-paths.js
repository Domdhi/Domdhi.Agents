/**
 * Telemetry Paths — canonical path helpers for the telemetry pipeline.
 *
 * Telemetry schema enrichment (A4) adopted from gstack:
 * `docs/.output/findings/research/competitive/_hooks-and-core-scripts-comparison.md` A4.
 *
 * Extracted from duplicated inline implementations across:
 *   - .claude/core/gate.js:39-40 (GATE_DIR, LOG_DIR inline)
 *   - .claude/core/metrics.js:22 (telemetryPath inline)
 *   - .claude/hooks/command-usage-logger.cjs:83,164 (hardcoded paths)
 *   - .claude/core/memory-benchmark.js:53-54 (telemetryDir, jsonlPath inline)
 *   - .claude/core/cleanup-logs.js:20 (logDirs inline)
 *
 * All callers pass a resolved projectRoot — this module does not consult
 * CLAUDE_PROJECT_DIR or __dirname itself (CLAUDE_PROJECT_DIR anchoring
 * semantics stay in the callers).
 */

const path = require('path');

// ADR 0006: telemetry is regenerable state — it lives under the gitignored
// .state/ zone (docs/.output/.state/telemetry). This single constant repoints
// every telemetry consumer (all route through this resolver).
const TELEMETRY_SUBPATH = ['docs', '.output', '.state', 'telemetry'];

/**
 * Return the canonical telemetry directory for a project.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @returns {string}            <projectRoot>/docs/.output/.state/telemetry
 */
function getTelemetryDir(projectRoot) {
    return path.join(projectRoot, ...TELEMETRY_SUBPATH);
}

/**
 * Return a timestamped log file path under the telemetry/logs subdirectory.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @param {string} prefix       Filename prefix (e.g. 'gate')
 * @returns {string}            <telemetryDir>/logs/<prefix>-<timestamp>.log
 */
function getLogPath(projectRoot, prefix) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(getTelemetryDir(projectRoot), 'logs', `${prefix}-${ts}.log`);
}

/**
 * Return the path to a named JSONL file under the telemetry directory.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @param {string} filename     Filename including extension (e.g. 'command-usage.jsonl')
 * @returns {string}            <telemetryDir>/<filename>
 */
function getJsonlPath(projectRoot, filename) {
    return path.join(getTelemetryDir(projectRoot), filename);
}

/**
 * Return the path to the gate summary file under the telemetry directory.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @returns {string}            <telemetryDir>/_latest-summary.json
 */
function getSummaryPath(projectRoot) {
    return path.join(getTelemetryDir(projectRoot), '_latest-summary.json');
}

module.exports = { getTelemetryDir, getLogPath, getJsonlPath, getSummaryPath };
