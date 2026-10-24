/**
 * Memory Metrics — memory count, category breakdown, health score, stale count.
 *
 * Extracted from status.js (P2.4) to separate metrics loading from rendering.
 * Uses MemoryManager's public API exclusively — no direct filesystem access.
 * This abstraction boundary keeps the metrics loader insulated from storage
 * implementation details (JSON vs SQLite).
 *
 * Usage:
 *   const { loadMemoryMetrics } = require('./_lib/memory-metrics');
 *   const metrics = await loadMemoryMetrics(projectRoot);
 *   // → { total, byCategory, healthScore, staleCount }
 *
 * Constraints:
 *   - Never reads process.cwd() — anchored to the explicit projectRoot arg via
 *     CLAUDE_PROJECT_DIR env injection before constructing MemoryManager.
 *   - No direct FS access — all memory data comes through MemoryManager.listMemories().
 *   - healthScore: lintMemories().score (0-70 scale, starts at 70, deducts per finding).
 *   - staleCount: memories whose decayed_confidence < STALE_THRESHOLD (0.3).
 *   - Returns zero-valued defaults when memory store is empty or unavailable.
 */

const path = require('path');
const MemoryManager = require('../memory-manager');
const { MEMORY_DECAY } = require('../constants');

/**
 * Load memory metrics for a project.
 *
 * Temporarily sets CLAUDE_PROJECT_DIR to projectRoot so MemoryManager resolves
 * the correct memories directory. Restores the original value after the call.
 *
 * @param {string} projectRoot  Absolute path to the project root
 * @returns {Promise<{ total: number, byCategory: Record<string, number>, healthScore: number, staleCount: number }>}
 */
async function loadMemoryMetrics(projectRoot) {
    const result = {
        total: 0,
        byCategory: {},
        healthScore: 0,
        staleCount: 0,
    };

    // MemoryManager resolves its root from CLAUDE_PROJECT_DIR (or __dirname fallback).
    // We inject projectRoot via the env var so this function is root-agnostic.
    const prevEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectRoot;

    let manager;
    try {
        manager = new MemoryManager();
    } finally {
        // Restore env immediately after construction — manager already captured the root.
        if (prevEnv === undefined) {
            delete process.env.CLAUDE_PROJECT_DIR;
        } else {
            process.env.CLAUDE_PROJECT_DIR = prevEnv;
        }
    }

    try {
        // Count memories by category using the public listMemories() API.
        for (const category of manager.categories) {
            const memories = await manager.listMemories(category);
            if (memories.length === 0) continue;

            result.byCategory[category] = memories.length;
            result.total += memories.length;

            // Count stale memories (decayed_confidence < STALE_THRESHOLD).
            for (const mem of memories) {
                if (mem.decayed_confidence < MEMORY_DECAY.STALE_THRESHOLD) {
                    result.staleCount++;
                }
            }
        }

        // Health score from the lint check — 0-70 scale.
        // Only run lint if there are memories (lint on empty store returns score 70,
        // which would be misleading — treat empty as score 0 for status display).
        if (result.total > 0) {
            try {
                const lintResult = await manager.lintMemories();
                result.healthScore = typeof lintResult.score === 'number' ? lintResult.score : 0;
            } catch {
                // Non-fatal — lint failure does not break the status output.
                result.healthScore = 0;
            }
        }
    } catch {
        // If memories directory doesn't exist yet, everything stays at zero defaults.
    } finally {
        // Close SQLite db if open — prevent file-lock issues in test environments.
        if (manager && manager.db) {
            try { manager.db.close(); } catch { /* non-fatal */ }
        }
    }

    return result;
}

module.exports = { loadMemoryMetrics };
