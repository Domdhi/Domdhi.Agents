/**
 * Memory profile helper — resolves MEMORY_PROFILE env var to a gate check
 *
 * MEMORY_PROFILE=minimal|standard|strict controls how much work the memory
 * pipeline does. Hooks call isAtLeast('standard') to decide whether to run.
 *
 * - minimal  — only the pre-compaction baseline capture runs
 * - standard — adds Stop pipeline (daily log + compile), commit capture, guard warnings (default)
 * - strict   — adds Haiku extraction, edit capture, curator, benchmark (expensive workers)
 *
 * Default: 'standard'. Unknown values fall back to 'standard' with a one-time stderr warning.
 */

// F53: single-sourced from constants.js (whose file-level contract is "all
// configurable values are defined here") — the local literals this replaced
// could silently drift from MEMORY_PROFILE.ORDER/.DEFAULT.
const { MEMORY_PROFILE } = require('./constants');
const PROFILE_ORDER = MEMORY_PROFILE.ORDER;
const DEFAULT_PROFILE = MEMORY_PROFILE.DEFAULT;

let warned = false;

function getProfile() {
    const raw = process.env.MEMORY_PROFILE;
    if (!raw) return DEFAULT_PROFILE;
    if (PROFILE_ORDER.includes(raw)) return raw;
    if (!warned) {
        process.stderr.write(
            `[memory-profile] Unknown MEMORY_PROFILE="${raw}" — falling back to "${DEFAULT_PROFILE}". Valid: ${PROFILE_ORDER.join('|')}\n`
        );
        warned = true;
    }
    return DEFAULT_PROFILE;
}

function isAtLeast(level) {
    const current = getProfile();
    const currentIdx = PROFILE_ORDER.indexOf(current);
    const requiredIdx = PROFILE_ORDER.indexOf(level);
    if (requiredIdx === -1) {
        throw new Error(
            `[memory-profile] isAtLeast() called with invalid level "${level}". Valid: ${PROFILE_ORDER.join('|')}`
        );
    }
    return currentIdx >= requiredIdx;
}

module.exports = { getProfile, isAtLeast, PROFILE_ORDER, DEFAULT_PROFILE };
