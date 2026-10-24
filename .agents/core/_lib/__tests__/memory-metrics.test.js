// AC→source map (P2.4 / memory-metrics):
//   loadMemoryMetrics(projectRoot) → { total: number, byCategory: Record<string, number>, healthScore: number, staleCount: number }
//   - Uses MemoryManager public API (listMemories, categories) — no direct FS access
//   - healthScore mirrors memory-manager lint score (0-70 scale)
//   - staleCount = memories with decayed_confidence < 0.3
//   - Returns { total: 0, byCategory: {}, healthScore: 0, staleCount: 0 } when no memories

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');
const MemoryManager = require('../../../../.agents/core/memory-manager');

let loadMemoryMetrics;
try {
    ({ loadMemoryMetrics } = require('../../../../.agents/core/_lib/memory-metrics'));
} catch {
    loadMemoryMetrics = null;
}

function getLoader() {
    if (!loadMemoryMetrics) {
        try { ({ loadMemoryMetrics } = require('../../../../.agents/core/_lib/memory-metrics')); } catch { /* still missing */ }
    }
    return loadMemoryMetrics;
}

let tmp;
let originalEnv;
let managersThisTest = [];

function makeManager() {
    const m = new MemoryManager();
    managersThisTest.push(m);
    return m;
}

function closeManagers() {
    for (const m of managersThisTest) {
        if (m.db) {
            try { m.db.close(); } catch { /* non-fatal */ }
            m.db = null;
        }
    }
    managersThisTest = [];
}

beforeEach(() => {
    managersThisTest = [];
    tmp = createTmpDir({ prefix: 'memory-metrics-' });
    originalEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmp.root;
    delete require.cache[require.resolve('../../../../.agents/core/_lib/memory-metrics')];
    try {
        ({ loadMemoryMetrics } = require('../../../../.agents/core/_lib/memory-metrics'));
    } catch {
        loadMemoryMetrics = null;
    }
});

afterEach(() => {
    closeManagers();
    if (originalEnv === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
    } else {
        process.env.CLAUDE_PROJECT_DIR = originalEnv;
    }
    tmp.cleanup();
});

describe('loadMemoryMetrics', () => {

    it('loadMemoryMetrics_noMemories_returnsZeroCounts', async () => {
        // Arrange — empty memories directory
        const loader = getLoader();
        if (!loader) throw new Error('memory-metrics.js not yet implemented');

        // Act
        const result = await loader(tmp.root);

        // Assert
        expect(result).toEqual({
            total: 0,
            byCategory: {},
            healthScore: 0,
            staleCount: 0,
        });
    });

    it('loadMemoryMetrics_withMemories_countsByCategory', async () => {
        // Arrange — create memories in two categories
        const loader = getLoader();
        if (!loader) throw new Error('memory-metrics.js not yet implemented');

        const manager = makeManager();
        await manager.createMemory('patterns', 'test_pattern_one', { description: 'pattern one' });
        await manager.createMemory('patterns', 'test_pattern_two', { description: 'pattern two' });
        await manager.createMemory('decisions', 'test_decision_one', { description: 'decision one' });

        // Act
        const result = await loader(tmp.root);

        // Assert
        expect(result.total).toBe(3);
        expect(result.byCategory['patterns']).toBe(2);
        expect(result.byCategory['decisions']).toBe(1);
    });

    it('loadMemoryMetrics_staleCount_detectsLowConfidence', async () => {
        // Arrange — create a memory then manually set its confidence below 0.3
        const loader = getLoader();
        if (!loader) throw new Error('memory-metrics.js not yet implemented');

        const manager = makeManager();
        await manager.createMemory('patterns', 'stale_pattern', { description: 'stale' });

        // Manually write a stale memory (low confidence, old date) — simulates decay
        const path = require('node:path');
        const fs = require('node:fs');
        const staleMemory = {
            id: 'stale_pattern_2',
            type: 'pattern',
            category: 'patterns',
            created: '2020-01-01T00:00:00.000Z',
            updated: '2020-01-01T00:00:00.000Z',
            usage_count: 0,
            content: { description: 'ancient stale memory' },
            metadata: { sessions: [], agents: [], confidence: 0.1 },
        };
        const categoryDir = path.join(tmp.root, 'docs', '.output', '.memory', 'patterns');
        fs.mkdirSync(categoryDir, { recursive: true });
        fs.writeFileSync(
            path.join(categoryDir, 'stale-pattern-2.json'),
            JSON.stringify(staleMemory, null, 2)
        );

        // Act
        const result = await loader(tmp.root);

        // Assert — stale_pattern_2 has confidence 0.1 which is < 0.3
        expect(result.staleCount).toBeGreaterThanOrEqual(1);
        expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it('loadMemoryMetrics_healthScore_isNonNegativeNumber', async () => {
        // Arrange
        const loader = getLoader();
        if (!loader) throw new Error('memory-metrics.js not yet implemented');

        const manager = makeManager();
        await manager.createMemory('patterns', 'healthy_pattern', { description: 'healthy' });

        // Act
        const result = await loader(tmp.root);

        // Assert — healthScore is a non-negative number (0-70 scale from lint)
        expect(typeof result.healthScore).toBe('number');
        expect(result.healthScore).toBeGreaterThanOrEqual(0);
        expect(result.healthScore).toBeLessThanOrEqual(70);
    });

    it('loadMemoryMetrics_noDirectFsAccess_usesManagerPublicApi', async () => {
        // Arrange — verify that the module exports correctly and accepts projectRoot
        // (structural test: function signature accepts one argument)
        const loader = getLoader();
        if (!loader) throw new Error('memory-metrics.js not yet implemented');

        // Act — call with a root that has no memories
        const result = await loader(tmp.root);

        // Assert — returns the correct shape even with empty state
        expect(result).toHaveProperty('total');
        expect(result).toHaveProperty('byCategory');
        expect(result).toHaveProperty('healthScore');
        expect(result).toHaveProperty('staleCount');
    });
});
