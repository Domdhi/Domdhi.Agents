// AC→source map (P2.4 / git-metrics):
//   loadGitMetrics(projectRoot, options?) → { commitCount: number, branch: string, lastCommitAt: string|null, commits7d: number }
//   - Accepts optional { execSync } injection for testability (DI test-seam pattern)
//   - commitCount = total commits on current branch
//   - branch = current branch name (or 'HEAD' if detached)
//   - lastCommitAt = ISO date string of most recent commit, null if no commits
//   - commits7d = commit instances in the last 7 days (F11: renamed from "activeDays")
//   - Returns safe defaults when git is unavailable: { commitCount: 0, branch: 'unknown', lastCommitAt: null, commits7d: 0 }

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { createTmpDir } = require('../../__tests__/_helpers/tmp-dir');

let loadGitMetrics;
try {
    ({ loadGitMetrics } = require('../git-metrics'));
} catch {
    loadGitMetrics = null;
}

function getLoader() {
    if (!loadGitMetrics) {
        try { ({ loadGitMetrics } = require('../git-metrics')); } catch { /* still missing */ }
    }
    return loadGitMetrics;
}

describe('loadGitMetrics', () => {
    let tmp;

    beforeEach(() => {
        tmp = createTmpDir({ prefix: 'git-metrics-' });
        delete require.cache[require.resolve('../git-metrics')];
        try {
            ({ loadGitMetrics } = require('../git-metrics'));
        } catch {
            loadGitMetrics = null;
        }
    });

    afterEach(() => {
        tmp.cleanup();
    });

    it('loadGitMetrics_gitUnavailable_returnsSafeDefaults', () => {
        // Arrange — inject a stub execSync that throws on all git calls
        const loader = getLoader();
        if (!loader) throw new Error('git-metrics.js not yet implemented');

        const stubExecSync = () => { throw new Error('git not found'); };

        // Act
        const result = loadGitMetrics(tmp.root, { execSync: stubExecSync });

        // Assert — safe defaults when git is unavailable
        expect(result.commitCount).toBe(0);
        expect(result.branch).toBe('unknown');
        expect(result.lastCommitAt).toBeNull();
        expect(result.commits7d).toBe(0);
    });

    it('loadGitMetrics_withStubExecSync_parsesCommitCount', () => {
        // Arrange — stub returns fake git log output with 5 lines
        const loader = getLoader();
        if (!loader) throw new Error('git-metrics.js not yet implemented');

        const gitLogOutput = '2024-01-10\n2024-01-09\n2024-01-08\n2024-01-07\n2024-01-06\n';
        const branchOutput = 'main\n';
        const lastCommitOutput = '2024-01-10T12:00:00+00:00\n';

        const stubExecSync = (cmd) => {
            if (cmd.includes('rev-list') && cmd.includes('--count')) return '5\n';
            if (cmd.includes('rev-parse') && cmd.includes('--abbrev-ref')) return branchOutput;
            if (cmd.includes('log') && cmd.includes('%cI') && cmd.includes('-1')) return lastCommitOutput;
            if (cmd.includes('log') && cmd.includes('--date=short')) return gitLogOutput;
            throw new Error(`Unexpected git command: ${cmd}`);
        };

        // Act
        const result = loadGitMetrics(tmp.root, { execSync: stubExecSync });

        // Assert
        expect(result.commitCount).toBe(5);
        expect(result.branch).toBe('main');
        expect(result.lastCommitAt).toBe('2024-01-10T12:00:00+00:00');
    });

    it('loadGitMetrics_withStubExecSync_computesActiveDaysInLast7Days', () => {
        // Arrange — stub returns dates where 3 are within the last 7 days, 2 are older.
        // commits7d uses a 7-day window (matching the "Commits (7d)" label in status.js).
        const loader = getLoader();
        if (!loader) throw new Error('git-metrics.js not yet implemented');

        const now = new Date();
        const recentDate1 = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const recentDate2 = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const recentDate3 = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const oldDate1 = '2020-01-01';
        const oldDate2 = '2019-06-15';

        const gitLogOutput = [recentDate1, recentDate2, recentDate3, oldDate1, oldDate2].join('\n') + '\n';

        const stubExecSync = (cmd) => {
            if (cmd.includes('rev-list') && cmd.includes('--count')) return '5\n';
            if (cmd.includes('rev-parse') && cmd.includes('--abbrev-ref')) return 'feature/test\n';
            if (cmd.includes('log') && cmd.includes('%cI') && cmd.includes('-1')) return '2024-01-10T12:00:00+00:00\n';
            if (cmd.includes('log') && cmd.includes('--date=short')) return gitLogOutput;
            throw new Error(`Unexpected git command: ${cmd}`);
        };

        // Act
        const result = loadGitMetrics(tmp.root, { execSync: stubExecSync });

        // Assert — exactly 3 distinct commit days within 7-day window
        expect(result.commits7d).toBe(3);
        expect(result.branch).toBe('feature/test');
    });

    it('loadGitMetrics_partialGitFailure_returnsAvailableDataAndDefaultsRest', () => {
        // Arrange — branch succeeds but log fails
        const loader = getLoader();
        if (!loader) throw new Error('git-metrics.js not yet implemented');

        let callCount = 0;
        const stubExecSync = (cmd) => {
            callCount++;
            if (cmd.includes('rev-parse') && cmd.includes('--abbrev-ref')) return 'main\n';
            throw new Error('git log failed');
        };

        // Act
        const result = loadGitMetrics(tmp.root, { execSync: stubExecSync });

        // Assert — branch populated, rest defaults
        expect(result.branch).toBe('main');
        expect(result.commitCount).toBe(0);
        expect(result.lastCommitAt).toBeNull();
        expect(result.commits7d).toBe(0);
    });

    it('loadGitMetrics_returnsCorrectShape', () => {
        // Arrange
        const loader = getLoader();
        if (!loader) throw new Error('git-metrics.js not yet implemented');

        const stubExecSync = () => { throw new Error('no git'); };

        // Act
        const result = loadGitMetrics(tmp.root, { execSync: stubExecSync });

        // Assert — correct shape with all required fields
        expect(result).toHaveProperty('commitCount');
        expect(result).toHaveProperty('branch');
        expect(result).toHaveProperty('lastCommitAt');
        expect(result).toHaveProperty('commits7d');
        expect(typeof result.commitCount).toBe('number');
        expect(typeof result.branch).toBe('string');
        expect(typeof result.commits7d).toBe('number');
    });
});
