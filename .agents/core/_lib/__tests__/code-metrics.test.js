// AC→source map (P2.4 / code-metrics):
//   loadCodeMetrics(projectRoot) → { loc: number, fileCount: number, byDir: Record<string, number> }
//   - Counts lines of code across .js, .ts, .cjs, .mjs files under projectRoot
//   - byDir maps top-level directory names to their LOC counts
//   - Excludes node_modules, .git, and other non-source directories
//   - Returns { loc: 0, fileCount: 0, byDir: {} } when no source files found

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const fs = require('node:fs');
const path = require('node:path');
const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

// Lazy require — module does not exist yet; tests will fail at require time
// until code-metrics.js is created.
let loadCodeMetrics;
try {
    ({ loadCodeMetrics } = require('../../../../.agents/core/_lib/code-metrics'));
} catch {
    loadCodeMetrics = null;
}

function getLoader() {
    if (!loadCodeMetrics) {
        try { ({ loadCodeMetrics } = require('../../../../.agents/core/_lib/code-metrics')); } catch { /* still missing */ }
    }
    return loadCodeMetrics;
}

describe('loadCodeMetrics', () => {
    let tmp;

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'code-metrics-' });
        // Reset cached require so module is freshly loaded each test
        delete require.cache[require.resolve('../../../../.agents/core/_lib/code-metrics')];
        try {
            ({ loadCodeMetrics } = require('../../../../.agents/core/_lib/code-metrics'));
        } catch {
            loadCodeMetrics = null;
        }
    });

    afterEach(() => {
        tmp.cleanup();
    });

    it('loadCodeMetrics_emptyProject_returnsZeroCounts', () => {
        // Arrange — empty project root with no source files
        const loader = getLoader();
        if (!loader) throw new Error('code-metrics.js not yet implemented');

        // Act
        const result = loader(tmp.root);

        // Assert
        expect(result).toEqual({ loc: 0, fileCount: 0, byDir: {} });
    });

    it('loadCodeMetrics_singleJsFile_countsLinesAndDirectory', () => {
        // Arrange — write a JS file with 5 lines
        const loader = getLoader();
        if (!loader) throw new Error('code-metrics.js not yet implemented');

        tmp.mkdir('src');
        tmp.write('src/index.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n');

        // Act
        const result = loader(tmp.root);

        // Assert
        expect(result.fileCount).toBe(1);
        expect(result.loc).toBe(5);
        expect(result.byDir['src']).toBe(5);
    });

    it('loadCodeMetrics_multipleDirectories_aggregatesPerDir', () => {
        // Arrange — files in two directories
        const loader = getLoader();
        if (!loader) throw new Error('code-metrics.js not yet implemented');

        tmp.mkdir('lib');
        tmp.mkdir('hooks');
        // lib has 3 lines
        tmp.write('lib/util.js', 'line1\nline2\nline3\n');
        // hooks has 2 lines
        tmp.write('hooks/handler.cjs', 'a\nb\n');

        // Act
        const result = loader(tmp.root);

        // Assert
        expect(result.fileCount).toBe(2);
        expect(result.loc).toBe(5);
        expect(result.byDir['lib']).toBe(3);
        expect(result.byDir['hooks']).toBe(2);
    });

    it('loadCodeMetrics_nodeModulesExcluded_notCounted', () => {
        // Arrange — source file plus a node_modules file
        const loader = getLoader();
        if (!loader) throw new Error('code-metrics.js not yet implemented');

        tmp.mkdir('src');
        tmp.mkdir('node_modules/some-pkg');
        tmp.write('src/main.js', 'hello\nworld\n');
        tmp.write('node_modules/some-pkg/index.js', 'ignore\nignore\nignore\n');

        // Act
        const result = loader(tmp.root);

        // Assert — node_modules excluded
        expect(result.fileCount).toBe(1);
        expect(result.loc).toBe(2);
        expect(result.byDir['node_modules']).toBeUndefined();
    });

    it('loadCodeMetrics_nonJsFilesExcluded_notCounted', () => {
        // Arrange — a .js file and a .md file side by side
        const loader = getLoader();
        if (!loader) throw new Error('code-metrics.js not yet implemented');

        tmp.mkdir('docs');
        tmp.write('docs/readme.md', 'line1\nline2\nline3\n');
        tmp.write('src/main.js', 'code\n');
        // src might not exist yet for the .js file
        tmp.mkdir('src');

        // Act
        const result = loader(tmp.root);

        // Assert — only .js counted
        expect(result.fileCount).toBe(1);
        expect(result.loc).toBe(1);
        expect(result.byDir['docs']).toBeUndefined();
    });

    it('loadCodeMetrics_gitDirExcluded_notCounted', () => {
        // Arrange
        const loader = getLoader();
        if (!loader) throw new Error('code-metrics.js not yet implemented');

        tmp.mkdir('.git/objects');
        tmp.write('.git/objects/fake.js', 'ignore\n');
        tmp.write('src/real.js', 'real\ncode\n');
        tmp.mkdir('src');

        // Act
        const result = loader(tmp.root);

        // Assert
        expect(result.byDir['.git']).toBeUndefined();
        expect(result.loc).toBe(2);
    });
});
