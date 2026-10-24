/**
 * Memory Decay — shared decay-confidence calculator.
 *
 * Extracted from memory-manager.js:381-427 to unify 4 previously-divergent call sites
 * (manager.calculateDecayedConfidence, promoter.loadConcepts, promoter.loadHandCreatedMemories,
 * curator.loadConcepts). Before unification, manager used git-active-days per CLAUDE.md
 * doctrine while the other three used calendar-days — same memory ranked differently
 * across /review:memory-health vs /review:promote-memories. This module makes all four
 * consistent (Option A per user decision 2026-04-24).
 *
 * Semantics preserved from the manager implementation:
 *   - Decay power uses activeDays (git commit-days since update) when available.
 *   - RECENT_UPDATE_BOOST checks calendar days — "was this updated in the last 7
 *     real-time days?" — not work days. That distinction is intentional.
 *   - When git is unavailable, resolver falls back to calendar days for activeDays.
 *     In that fallback mode, decay behaves like the old promoter/curator paths.
 */

const { execSync } = require('child_process');
const { MEMORY_DECAY } = require('../constants');

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Cap on the commit-history scan (M4). The resolver only counts DISTINCT active
// work-days, and even the slowest decay curve (decisions 0.98^days) is well past
// the archive threshold by ~150 active days — so a few thousand commits covers all
// decay-relevant history with generous headroom. Bounding the query matters because
// the caller (session-start-prime) runs this on a synchronous execSync: its
// advertised 2s hard-timeout is a setTimeout, which CANNOT preempt a blocked event
// loop, so an unbounded `git log` on a huge repo would block every session start up
// to the inner 5s ceiling. Very old memories in a >cap-commit repo simply see
// slightly less decay (a safe, retention-favoring bias), never a hang.
const GIT_LOG_COMMIT_CAP = 5000;

/**
 * Pure decay calculation.
 *
 * @param {object} args
 * @param {number} args.confidence   Base confidence in [0, 1]
 * @param {string} args.category     Memory category (drives rate lookup)
 * @param {number} args.usageCount   Number of times this memory has been used
 * @param {string} args.updated      ISO timestamp of last update
 * @param {number} [args.activeDays] Git-active-days since `updated`. If omitted,
 *                                   falls back to calendar days.
 * @returns {number} Decayed confidence in [0, 1.0]
 */
function calculateDecayedConfidence({ confidence, category, usageCount, updated, activeDays }) {
    const base = typeof confidence === 'number' ? confidence : 1.0;
    const rate = MEMORY_DECAY.RATES[category] || MEMORY_DECAY.DEFAULT_RATE;
    const calendarDays = (Date.now() - new Date(updated)) / MS_PER_DAY;
    const decayDays = typeof activeDays === 'number' ? activeDays : calendarDays;

    let decayed = base * Math.pow(rate, decayDays);
    decayed += (usageCount || 0) * MEMORY_DECAY.USAGE_BOOST;
    if (calendarDays < MEMORY_DECAY.RECENT_UPDATE_DAYS) {
        decayed += MEMORY_DECAY.RECENT_UPDATE_BOOST;
    }
    return Math.min(decayed, 1.0);
}

/**
 * Halving aging for the usage counter (ME-4.1). Silence decays usage WITHOUT
 * needing a "not-accessed" event: the counter halves every `halveEveryDays`
 * active-work-days since the last genuine recall. Pure arithmetic — no LLM, no
 * I/O. This demotes a once-popular-but-now-cold memory's usage signal so it stops
 * being a permanent ratchet (TinyLFU-style aging sketch).
 *
 * @param {number} usageCount        Current usage count
 * @param {number} activeDaysSilent  Active-work-days since the last recall
 * @param {number} halveEveryDays    Halving period in active-work-days (>0)
 * @returns {number} The aged usage value (>= 0; fractional allowed)
 */
function halveUsageCount(usageCount, activeDaysSilent, halveEveryDays) {
    const u = Number(usageCount);
    if (!Number.isFinite(u) || u <= 0) return 0;
    if (!halveEveryDays || halveEveryDays <= 0) return u;       // disabled → unchanged
    const silent = Number(activeDaysSilent);
    if (!Number.isFinite(silent) || silent <= 0) return u;      // no silence → unchanged
    const halvings = Math.floor(silent / halveEveryDays);
    if (halvings <= 0) return u;
    return u / Math.pow(2, halvings);
}

/**
 * Create a resolver that counts active work days (days with git commits) since a date.
 *
 * The resolver lazily reads `git log --format="%ad" --date=short` on first call and
 * caches the resulting date Set for the lifetime of the resolver. When git fails
 * (no repo, not on PATH, timeout), the resolver permanently falls back to calendar
 * days — matching the old memory-manager behavior.
 *
 * Each resolver instance owns its own cache; creating multiple resolvers in the
 * same process means multiple git-log invocations. That's intentional: matches
 * prior per-MemoryManager-instance cache semantics.
 *
 * @param {object} args
 * @param {string} args.projectRoot Absolute path to the repo root
 * @returns {{ getActiveDaysSince(sinceDate: string|Date): number }}
 */
function createActiveDaysResolver({ projectRoot }) {
    let cache = null;           // Set<string> of YYYY-MM-DD commit dates, or null if git failed
    let resolved = false;       // Have we attempted the git log yet?

    function ensureCache() {
        if (resolved) return;
        resolved = true;
        try {
            const output = execSync(`git log -n ${GIT_LOG_COMMIT_CAP} --format="%ad" --date=short`, {
                cwd: projectRoot,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 5000,
                windowsHide: true,
            });
            cache = new Set(output.trim().split('\n').filter(Boolean));
        } catch {
            cache = null;
        }
    }

    return {
        getActiveDaysSince(sinceDate) {
            ensureCache();

            // Calendar fallback when git is unavailable
            if (!cache) {
                return (Date.now() - new Date(sinceDate)) / MS_PER_DAY;
            }

            const since = new Date(sinceDate);
            since.setHours(0, 0, 0, 0);
            let count = 0;
            for (const dateStr of cache) {
                const d = new Date(dateStr + 'T00:00:00');
                if (d >= since) count++;
            }
            return count;
        },
    };
}

module.exports = { calculateDecayedConfidence, createActiveDaysResolver, halveUsageCount };
