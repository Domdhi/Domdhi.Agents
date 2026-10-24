/**
 * Test fixture — mimics the pattern used by source modules under test:
 *   `const { execSync, spawn } = require('child_process')` at module load.
 *
 * Used by claude-mock.test.js to verify that `installExecSyncMock` intercepts
 * the destructured references (the exact case vi.spyOn fails on).
 *
 * Tests must flush this file from require.cache between runs so the destructure
 * re-captures a fresh mock each time:
 *   delete require.cache[require.resolve('./fixtures/destructure-fixture.cjs')];
 */

const { execSync, spawn } = require('child_process');

module.exports = {
    runExec: (cmd, opts) => execSync(cmd, opts),
    runSpawn: (cmd, args, opts) => spawn(cmd, args, opts),
};
