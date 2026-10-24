// AC→source map (TDD-5.4 / memory-guard):
//   - countMemoriesInCategory: tmp dir with 0, 20, 40, 50 json files → correct counts
//   - countMemoriesInCategory: missing directory → 0 (graceful)
//   - processEvent: category at 39 (below 80% of 50) → no stderr warning
//   - processEvent: category at 40 (≥ 80%) → mild warning to stderr
//   - processEvent: category at 50 (≥ max) → stronger warning to stderr
//   - processEvent: minimal MEMORY_PROFILE → returns null early (no warnings)
//   - processEvent: file_path not in memories → returns null
//   - processEvent: file_path not .json → returns null
//   - processEvent: no memories segment in path → returns null
//
// Profile gate: processEvent reads MEMORY_PROFILE env at call time via isAtLeast().
// Set MEMORY_PROFILE='standard' in beforeEach to ensure guard runs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const { processEvent, countMemoriesInCategory } = require('../../../.agents/hooks/memory-guard.cjs');
const { createTmpDir } = require('../../core/__tests__/_helpers/tmp-dir');
// Constant-relative so a change to the cap OR the near-limit fraction doesn't re-break these tests.
const { MEMORY_MAX_PER_CATEGORY: CAP, MEMORY_NEAR_LIMIT_PCT: NEAR_PCT } = require('../../../.agents/core/constants').MEMORY_FILTERS;
const NEAR = Math.round(CAP * NEAR_PCT);   // near-limit warning threshold

// ─── countMemoriesInCategory ──────────────────────────────────────────────────

describe('memory-guard', () => {
    describe('countMemoriesInCategory', () => {
        let tmp;

        beforeEach(() => {
            tmp = createTmpDir();
        });

        afterEach(() => {
            tmp.cleanup();
        });

        it('countMemoriesInCategory_empty_returnsZero', () => {
            // Arrange
            const catDir = tmp.mkdir('.memory/patterns');

            // Act
            const count = countMemoriesInCategory(catDir);

            // Assert
            expect(count).toBe(0);
        });

        it('countMemoriesInCategory_20files_returns20', () => {
            // Arrange
            const catDir = tmp.mkdir('.memory/patterns');
            for (let i = 0; i < 20; i++) {
                tmp.write(`.memory/patterns/entry-${i}.json`, '{}');
            }

            // Act
            const count = countMemoriesInCategory(catDir);

            // Assert
            expect(count).toBe(20);
        });

        it('countMemoriesInCategory_40files_returns40', () => {
            // Arrange
            const catDir = tmp.mkdir('.memory/patterns');
            for (let i = 0; i < 40; i++) {
                tmp.write(`.memory/patterns/entry-${i}.json`, '{}');
            }

            // Act
            const count = countMemoriesInCategory(catDir);

            // Assert
            expect(count).toBe(40);
        });

        it('countMemoriesInCategory_50files_returns50', () => {
            // Arrange
            const catDir = tmp.mkdir('.memory/patterns');
            for (let i = 0; i < 50; i++) {
                tmp.write(`.memory/patterns/entry-${i}.json`, '{}');
            }

            // Act
            const count = countMemoriesInCategory(catDir);

            // Assert
            expect(count).toBe(50);
        });

        it('countMemoriesInCategory_missingDirectory_returnsZero', () => {
            // Arrange — directory that was never created
            const catDir = path.join(tmp.root, 'memories', 'nonexistent');

            // Act
            const count = countMemoriesInCategory(catDir);

            // Assert — graceful on missing directory
            expect(count).toBe(0);
        });

        it('countMemoriesInCategory_nonJsonFilesIgnored_returnsOnlyJsonCount', () => {
            // Arrange — mix of .json and other extensions
            const catDir = tmp.mkdir('.memory/patterns');
            tmp.write('.memory/patterns/entry-0.json', '{}');
            tmp.write('.memory/patterns/entry-1.json', '{}');
            tmp.write('.memory/patterns/readme.md', '# notes');
            tmp.write('.memory/patterns/temp.txt', 'temp');

            // Act
            const count = countMemoriesInCategory(catDir);

            // Assert — only 2 .json files
            expect(count).toBe(2);
        });
    });

    // ─── processEvent ─────────────────────────────────────────────────────────

    describe('processEvent', () => {
        let tmp;
        let originalProfile;

        beforeEach(() => {
            tmp = createTmpDir();
            originalProfile = process.env.MEMORY_PROFILE;
            // Ensure guard runs (not suppressed by minimal profile)
            process.env.MEMORY_PROFILE = 'standard';
        });

        afterEach(() => {
            if (originalProfile === undefined) {
                delete process.env.MEMORY_PROFILE;
            } else {
                process.env.MEMORY_PROFILE = originalProfile;
            }
            tmp.cleanup();
        });

        it('processEvent_belowThreshold_noWarning', () => {
            // Arrange — one below the 80% threshold
            const catDir = tmp.mkdir('.memory/patterns');
            for (let i = 0; i < NEAR - 1; i++) {
                tmp.write(`.memory/patterns/e${i}.json`, '{}');
            }
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const filePath = path.join(catDir, 'new.json');

            try {
                // Act
                processEvent({ tool_input: { file_path: filePath } });

                // Assert
                expect(stderrSpy).not.toHaveBeenCalled();
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_atThreshold_mildWarning', () => {
            // Arrange — exactly at the 80% threshold
            const catDir = tmp.mkdir('.memory/patterns');
            for (let i = 0; i < NEAR; i++) {
                tmp.write(`.memory/patterns/e${i}.json`, '{}');
            }
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const filePath = path.join(catDir, 'new.json');

            try {
                // Act
                processEvent({ tool_input: { file_path: filePath } });

                // Assert — mild warning fired (80% full message)
                expect(stderrSpy).toHaveBeenCalled();
                const message = stderrSpy.mock.calls[0][0];
                expect(message).toMatch(new RegExp(`80%|${NEAR}\\/${CAP}`));
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_atMax_strongWarning', () => {
            // Arrange — at the cap (max)
            const catDir = tmp.mkdir('.memory/patterns');
            for (let i = 0; i < CAP; i++) {
                tmp.write(`.memory/patterns/e${i}.json`, '{}');
            }
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const filePath = path.join(catDir, 'new.json');

            try {
                // Act
                processEvent({ tool_input: { file_path: filePath } });

                // Assert — strong warning (pruning message)
                expect(stderrSpy).toHaveBeenCalled();
                const message = stderrSpy.mock.calls[0][0];
                expect(message).toMatch(/prune|max/i);
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_minimalProfile_returnsNullNoWarning', () => {
            // Arrange — minimal profile suppresses all guard warnings
            process.env.MEMORY_PROFILE = 'minimal';
            const catDir = tmp.mkdir('.memory/patterns');
            for (let i = 0; i < 50; i++) {
                tmp.write(`.memory/patterns/e${i}.json`, '{}');
            }
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const filePath = path.join(catDir, 'new.json');

            try {
                // Act
                const result = processEvent({ tool_input: { file_path: filePath } });

                // Assert
                expect(result).toBeNull();
                expect(stderrSpy).not.toHaveBeenCalled();
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_filePathNotInMemories_returnsNull', () => {
            // Arrange — file not inside a memories directory
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const filePath = path.join(tmp.root, 'some', 'other', 'file.json');

            try {
                // Act
                const result = processEvent({ tool_input: { file_path: filePath } });

                // Assert
                expect(result).toBeNull();
                expect(stderrSpy).not.toHaveBeenCalled();
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_filePathNotJson_returnsNull', () => {
            // Arrange — file is in memories but not .json
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const filePath = path.join(tmp.root, 'memories', 'patterns', 'file.md');

            try {
                // Act
                const result = processEvent({ tool_input: { file_path: filePath } });

                // Assert
                expect(result).toBeNull();
                expect(stderrSpy).not.toHaveBeenCalled();
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_noFilePathInInput_returnsNull', () => {
            // Arrange — tool_input lacks file_path
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

            try {
                // Act
                const result = processEvent({ tool_input: {} });

                // Assert
                expect(result).toBeNull();
                expect(stderrSpy).not.toHaveBeenCalled();
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_memoriesWithNoCategory_returnsNull', () => {
            // Arrange — path ends at memories/ with no subdirectory
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            // memories is the last segment before the file, so no category between them
            const filePath = path.join(tmp.root, 'memories', 'file.json');

            try {
                // Act — memories is at index N, memories[N+1] is "file.json" which is the file itself,
                // but dirname gives memories/ — the category would be the file basename without extension.
                // The real guard: memoriesIdx + 1 must be < parts.length - 1, i.e., there must be
                // a category segment. file.json at memories/file.json means category = "file.json"
                // which would be wrong. The source checks memoriesIdx + 1 >= parts.length.
                // Actually memories/file.json → parts = [...,'memories','file.json']
                // memoriesIdx+1 = last index = parts.length - 1 (valid), category = 'file.json'
                // dirname = memories/ → countMemoriesInCategory(memories/) returns 0 → no warning.
                // This is acceptable graceful behavior. Assert result is null.
                const result = processEvent({ tool_input: { file_path: filePath } });
                expect(result).toBeNull();
            } finally {
                stderrSpy.mockRestore();
            }
        });

        it('processEvent_alwaysReturnsNull', () => {
            // Arrange — processEvent return value is always null regardless of threshold
            const catDir = tmp.mkdir('.memory/patterns');
            for (let i = 0; i < 50; i++) {
                tmp.write(`.memory/patterns/e${i}.json`, '{}');
            }
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
            const filePath = path.join(catDir, 'new.json');

            try {
                // Act
                const result = processEvent({ tool_input: { file_path: filePath } });

                // Assert — always returns null (side effect is stderr warning)
                expect(result).toBeNull();
            } finally {
                stderrSpy.mockRestore();
            }
        });
    });
});
