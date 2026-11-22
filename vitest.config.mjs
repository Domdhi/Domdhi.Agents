import { defineConfig } from 'vitest/config';

// The workshop gate pins its checkout; tests establish their own fixture roots.
// Clear inherited context here too so direct npm test has the runner's isolation.
const fixtureContext = new Set([
  'AGENT_SHARED_STATE_ROOT', 'AGENTS_PROJECT_DIR', 'AGENT_SOURCE_ROOT',
  'CODEX_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'AGENT_PROJECT_ROOT',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);
for (const key of Object.keys(process.env)) {
  if (fixtureContext.has(process.platform === 'win32' ? key.toUpperCase() : key)) delete process.env[key];
}

// Hook spawns leave a systemd session scope when they run inside one (hook-spawners scopeEscape). The suite
// asserts exact spawn argv, so it must not depend on the cgroup it happens to run in; tests of the escape
// inject their own inputs.
process.env.AGENTS_SCOPE_ESCAPE = 'off';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      '.agents/**/__tests__/**/*.test.{js,cjs}',
      'tools/**/__tests__/**/*.test.{js,cjs}',
    ],
    exclude: ['node_modules', 'docs/.output/**'],
    // Warns once when the secret engine binary is not installed (the engine suites run the real binary).
    globalSetup: ['./.agents/hooks/__tests__/_helpers/warn-secret-engine.js'],
    // Each test file runs with os.tmpdir() redirected to a private directory that is removed when the file ends,
    // so a test that forgets its own cleanup cannot leak into the real temp dir.
    setupFiles: ['./.agents/core/__tests__/_helpers/vitest-tmp-sandbox.setup.mjs'],
    testTimeout: 30000,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 4,
    // Coverage measures the canonical implementation under .agents. The
    // generated .claude/.codex entry points only forward to it (in-process
    // require or a node subprocess), so wrapper execution is not implementation
    // coverage and the wrapper trees are deliberately outside the include list.
    // Code a test runs only in a child process is not measured by the v8
    // provider; the readiness record lists those files.
    coverage: {
      provider: 'v8',
      include: ['.agents/**/*.{js,cjs,mjs}'],
      exclude: [
        '**/__tests__/**',
        '**/_helpers/**',
        'docs/**',
        'node_modules/**',
      ],
      reportsDirectory: 'docs/.output/.state/telemetry/coverage',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
        // Required paths: each canonical tree behind a native wrapper must
        // meet the floor on its own, so a well-tested tree cannot mask an
        // untested one in the global total.
        '.agents/core/*.js': { lines: 70, functions: 70, branches: 60, statements: 70 },
        '.agents/core/_lib/**': { lines: 70, functions: 70, branches: 60, statements: 70 },
        '.agents/hooks/**': { lines: 70, functions: 70, branches: 60, statements: 70 },
        '.agents/adapters/**': { lines: 70, functions: 70, branches: 60, statements: 70 },
      },
    },
  },
});
