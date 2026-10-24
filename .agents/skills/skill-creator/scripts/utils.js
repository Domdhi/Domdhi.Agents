/**
 * Shared helpers for skill-creator scripts.
 *
 * CJS, zero-dependency, works as require() or CLI.
 * Export shape matches .claude/core/*.js conventions.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Re-export parseArgs from skill-eval so callers only need one import.
const { parseArgs } = require('../../../core/skill-eval.js');

/**
 * Read and parse a JSON file. Returns null (never throws) on any error.
 * @param {string} file  absolute or relative path
 * @returns {any|null}
 */
function readJsonSafe(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Write an object to a JSON file with 2-space pretty-print.
 * Creates parent directories if needed.
 * @param {string} file
 * @param {any} obj
 */
function writeJson(file, obj) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Recursively create a directory (mkdir -p). No-op if it already exists.
 * @param {string} dir
 */
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * Return the project root.
 *
 * Resolution order:
 *   1. CLAUDE_PROJECT_DIR env var (set by Claude Code hooks at runtime)
 *   2. Four levels up from this file's __dirname:
 *      .claude/skills/skill-creator/scripts/ → project root
 *
 * Verified: path.resolve(__dirname, '../../../..') from
 * `.claude/skills/skill-creator/scripts/` reaches the repo root.
 * @returns {string}
 */
function projectRoot() {
    return process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '../../../..');
}

if (require.main === module) {
    console.log('projectRoot:', projectRoot());
}

module.exports = {
    readJsonSafe,
    writeJson,
    ensureDir,
    projectRoot,
    parseArgs,
};
