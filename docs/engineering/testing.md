# Toolkit Test Patterns

How this repository's own tests are written: the Node helpers under `.agents/core/` and their Vitest suites under `.agents/**/__tests__/`. These are workshop conventions, not adopter guidance; the shared `qa-engineer` skill stays stack-neutral, and an adopter records its own patterns in that skill's project-additions slot. Broader contributor rules are in [conventions.md](conventions.md#testing-conventions).

Moved here from the `qa-engineer` skill on 2026-11-25, where it shipped to every adopter as active guidance.

**Framework:** Vitest 5 (see `package.json`) at repo root. Config: `vitest.config.mjs` (ESM; `.mjs` because Vite's CJS Node API is deprecated).

## ESM Import Pattern (REQUIRED for every test file)

`package.json` is `"type": "commonjs"` and the `.claude/core/*.js` scripts use `require` / `module.exports`, but Vitest's API is ESM: `require('vitest')` in a CommonJS test fails with "Vitest cannot be imported in a CommonJS module using require()". Test files import ESM and bridge to the CJS source with `createRequire`:

```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('module-under-test', () => {
  it('feature_scenario_expectedResult', () => {
    // Arrange
    const mod = require('../module-under-test'); // CJS require works here
    // Act
    const result = mod.someFn(1, 2);
    // Assert
    expect(result).toBe(3);
  });
});
```

Canonical reference: `.agents/core/__tests__/_smoke.test.js`. Copy its shape for new tests.

## Test File Locations

- Core scripts: `.agents/core/__tests__/{module}.test.js` (colocated)
- Hooks: `.agents/hooks/__tests__/{hook}.test.js` (colocated)
- Runtime adapters: `.agents/adapters/{claude,codex}/__tests__/` — runtime-specific protocol and registration fixtures
- Shared helpers: `.agents/core/__tests__/_helpers/` — underscore prefix, not matched by the `*.test.js` glob, excluded from coverage

## Tmp-Dir Convention

Tests that write files scope them under a per-test temp directory, never the repo root, user home or a path the project itself writes to. Use `.agents/core/__tests__/_helpers/tmp-dir.js`: production code resolves output paths via `process.env.CLAUDE_PROJECT_DIR`, and the helper points that at a fresh scratch directory and tears it down after the test. Route every path through it rather than hardcoding.

## Commands

```bash
npm test                                    # all suites
npm run test:watch                          # watch mode
npm run test:coverage                       # v8 coverage → docs/.output/.state/telemetry/coverage/
node .claude/core/gate.js test              # gate runner; auto-detects node stack, runs npm test
```

## Coverage Thresholds

Enforced on the canonical implementation, `.agents/**/*.{js,cjs,mjs}` (see `vitest.config.mjs`). The generated `.claude`/`.codex` wrappers only forward to it, so they are not measured:

| Metric | Threshold |
|--------|-----------|
| Lines | 70% |
| Functions | 70% |
| Statements | 70% |
| Branches | 60% |

`.agents/core/*.js`, `.agents/core/_lib/**`, `.agents/hooks/**` and `.agents/adapters/**` must each meet the same floor on their own. Exclusions: `**/__tests__/**`, `**/_helpers/**`, `docs/**`, `node_modules/**`. Code a test runs only in a child process is not measured.

## CLI Guard for Testable Core Scripts

A core script that calls `main()` at file scope executes (and `process.exit()`s) the moment a test `require`s it, which kills the Vitest worker. Wrap every CLI entry point; before writing tests for a core script, check the guard exists and add it as part of the story if not:

```js
async function main() { /* ... */ }

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { /* functions exported for tests */ };
```

## AAA + AC Mapping

Use Arrange-Act-Assert with blank-line separation. One AC bullet maps to one or more `it(...)` cases, named `subject_scenario_expectedResult` (snake_case after the subject, camelCase inside segments), so the AC-to-test mapping is traceable in the Execution Log:

```js
it('parseTestOutput_vitestSpacedFormat_returnsCorrectCounts', () => { ... });
```

## AC Reconciliation Table (pre-dispatch step)

Before dispatching a dev agent, especially in parallel waves, put an AC-to-source reconciliation table in the plan file at `docs/.output/plans/{date}/{slug}.md`. It surfaces name, signature and shape mismatches between what the AC says and what the source has before an agent debates them mid-implementation, and every agent then reads the same locked names (zero signature drift across 25 parallel agents in Epics TDD-2 through TDD-6).

| Story | AC says | Source has | Decision | Rationale |
|-------|---------|------------|----------|-----------|
| {ID} | `matchesRule(cmd, rule)` | `matchPatterns(cmd, patterns[])` | Export as **`matchPatterns`** | AC drifted; source is correct. Tests assert against `matchPatterns`. |
| {ID} | `appendJsonl(path, entry)` | inline in `main()` | **Extract** `appendJsonl(jsonlPath, event): void` | Function doesn't exist yet — create during refactor. |
| {ID} | `inferGateRun → {type, mode}` | returns string `'gate:build'` | **Keep string return** | Source is simpler. Update test assertion. |

## Mocking Legacy CJS with Top-Level Destructure

A source module that does `const { execSync } = require('child_process')` at top level cannot be patched with `vi.spyOn(childProcess, 'execSync')`: it captured the original reference before the spy installed, so the spy is never hit and the test runs real `execSync`. Pre-inject a proxy module into `require.cache` before the source is required, using `.agents/core/__tests__/_helpers/claude-mock.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { installExecSyncMock } = require('../../core/__tests__/_helpers/claude-mock');

describe('legacy-cjs-module', () => {
  let mockExecSync, loader;

  beforeEach(() => {
    // Single-method form — most common
    ({ mockExecSync, loader } = installExecSyncMock(vi));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('feature_scenario_expectedResult', () => {
    // Arrange
    mockExecSync.mockReturnValue('faked output');
    const mod = loader('../legacy-module'); // loader requires AFTER cache injection

    // Act / Assert
    expect(mod.someFn()).toBe('expected');
    expect(mockExecSync).toHaveBeenCalledWith(/* ... */, expect.any(Object));
  });
});
```

When the source destructures several methods (`execSync` and `spawn`):

```js
const { mockExecSync, mockSpawn, loader } = installExecSyncMock(vi, ['execSync', 'spawn']);
```

A destructured class (`const { DailyLog } = require('../core/daily-log')`) takes the same `require.cache` injection of a proxy class before the source loads; see `.agents/hooks/__tests__/pre-compaction-archive.test.js`. A module that does not destructure (`childProcess.execSync(...)`) takes a plain `vi.spyOn`.

## Non-Deterministic Tests: Threshold Widening Rule

Tests that assert on PRNG state (`Math.random`), time-of-day fractions or anything sensitive to suite ordering need wider thresholds than variance math suggests, because PRNG state leaking across the full-suite order fattens the tail. Widen to a natural-language boundary, not a variance boundary:

| Naive threshold | Better threshold | Natural-language meaning |
|---|---|---|
| `< 0.30` (3.75σ on Binomial(100, 0.2)) | `< 0.50` | "no element dominates" |
| `> 0.79` (after PRNG-state-amplified decay) | `> 0.75` | "boosts applied" |

The variance-math thresholds flaked repeatedly (commits `a9ef9cd`, `48a3d6d`, `d22be7c`); the plain-English ones held. The test wants to catch "a broken shuffle always picks the same element", not measure binomial variance.

## Integration Tests: Subprocess + Spy Patterns

Integration tests here (gate stack detection, secret-scanner pre-commit, template-updater zones, memory-pipeline) share one shape; match it.

**Subprocess pattern:**

```js
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url); // Windows-safe; do NOT use new URL().pathname
const scriptPath = path.resolve(path.dirname(__filename), '..', '..', 'target-script.js');

const result = execFileSync('node', [scriptPath, 'arg'], {
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.root },
  stdio: ['pipe', 'pipe', 'pipe'],
});

expect(result).toContain('expected stdout');
```

`fileURLToPath` matters on Windows, where `new URL(import.meta.url).pathname` returns `/C:/...` and breaks `path.resolve`.

**Prototype-spy as integration boundary.** Legitimate when the bypassed behavior is already covered by unit tests on the spied class; it hollows the test when the bypassed behavior is the AC. Spy only at proven subsystem boundaries; if the AC under test is "search returns the right results", the spy hollows it.

```js
// Legitimate: MemoryManager.searchMemories has unit-test coverage in memory-manager.test.js
// Integration test's job is to verify the wiring (caller → searchMemories → JSONL records),
// NOT to retest FTS5/JSON keyword matching.
vi.spyOn(MemoryManager.prototype, 'searchMemories').mockReturnValue([
  { id: 'expected-slug', score: 0.9 },
]);
```

**Assert every seeding return value.** When a test spies on any boundary, each seeding call (`createMemory`, `createConcept`, `addCommit`, ...) asserts its return value. Otherwise a silent seeding failure (`createMemory` returns `null` on validation or IO error) leaves the spy returning canned data over an empty store and the test passes with false confidence:

```js
const result = await mgr.createMemory(category, id, payload);
expect(result, 'Stage N: createMemory should succeed').not.toBeNull();
```

## Literal AC Numbers + Dynamic Dates

**Literal AC numbers.** An AC that states an exact count ("process 10 items", "JSONL contains 10 entries") is literal, not a lower bound. Seed enough input to trigger exactly that condition and assert `toBe(N)`, never `toBeGreaterThanOrEqual(1)` (an agent once softened `toBe(10)` to `>= 1` to fit its 3-entry seed instead of seeding the 12 entries needed to reach `MAX_ENTRIES_PER_RUN = 10`). If the implementation has a cap or threshold, work back from it so the cap is the binding constraint, which makes `toBe(10)` provable.

**Dynamic dates.** When source code calls `new Date()` for time-window comparisons (files older than `MIN_AGE_DAYS = 7`), tests compute dates dynamically; a hardcoded calendar date goes red on the day it crosses the boundary.

```js
// Bad — flips red on 2026-04-25
const old = '2026-04-18';

// Good — always 8 days ago
const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
```
