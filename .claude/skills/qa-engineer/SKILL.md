---
name: qa-engineer
description: "Use WHEN defining a test strategy, generating tests from acceptance criteria, or analyzing test coverage gaps. Triggers: qa, test, testing, coverage, e2e, unit test, integration test"
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [testing, qa, unit-test, integration-test, e2e, coverage]
user-invocable: false
allowed-tools: Read Grep Glob Bash
---

<!-- Generated from .agents/skills/qa-engineer/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# QA Engineer

Test strategy and test generation. A good result is a small set of tests that each verify an acceptance criterion or guard a real contract, fail for the reason they name, and would go red if that behavior broke. A suite that is green over a real defect is worse than a smaller one that is honest.

**TDD first.** Before implementing anything, read `.claude/skills/qa-engineer/references/tdd-enforcement.md`: the Iron Law (no production code without a failing test first), Red-Green-Refactor, and the anti-patterns that let a test-after pass masquerade as test-first.

## Test Strategy Template

```markdown
# Test Strategy: {Project Name}

## Testing Pyramid

| Level | Framework | Coverage Target | Scope |
|-------|-----------|-----------------|-------|
| Unit | {xUnit/Jest/pytest} | 80%+ | Business logic, utilities, models |
| Integration | {same + TestServer} | Key paths | API endpoints, data access, auth |
| E2E | {Playwright/Cypress} | Critical flows | User journeys, cross-module |

## Test Organization

```
tests/
├── unit/
│   ├── {Module}/
│   │   ├── {Service}Tests.{ext}
│   │   └── {Model}Tests.{ext}
├── integration/
│   ├── {Module}/
│   │   ├── {Controller}Tests.{ext}
│   │   └── {Repository}Tests.{ext}
├── e2e/
│   ├── flows/
│   │   ├── {UserJourney}.spec.{ext}
│   └── fixtures/
│       └── {testdata}.json
└── shared/
    ├── builders/      (test data builders)
    ├── fakes/         (fake implementations)
    └── helpers/       (test utilities)
```

## Naming Convention
- Test class: `{ClassUnderTest}Tests`
- Test method: `{Method}_{Scenario}_{ExpectedResult}`
- Example: `LoginService_InvalidPassword_ReturnsUnauthorized`
```

## Test Patterns

### Arrange-Act-Assert (AAA)
Set up the data and dependencies, call the method under test, then assert on the result.

### Test Data Builders
Build complex test objects with a builder: `new UserBuilder().WithRole("Admin").WithEmail("test@test.com").Build()`.

### From Acceptance Criteria
Each AC maps to one or more tests:
```
AC: "Given a valid email, When user submits login, Then redirect to dashboard"
→ Test: LoginFlow_ValidCredentials_RedirectsToDashboard
→ Test: LoginFlow_InvalidEmail_ShowsError
→ Test: LoginFlow_EmptyPassword_ShowsValidation
```

**Test authorship follows the repository's own rule.** Read the project's test-ownership rule before writing or delegating tests (for example, a workflow that requires the orchestrator to author tests from the AC before implementation is dispatched). Do not import another project's convention as universal. A deviation, such as a helper drafting tests that the owner reviews before production starts, is recorded as a deviation, not presented as compliance.

## Coverage Guidelines

### What to Test
Business logic, validation rules, error handling paths and data transformations always; API endpoint contracts at the integration level; critical user journeys end to end.

### What NOT to Test
- Framework internals, trivial getters/setters, third-party library behavior, generated code and configuration files
- Exact values that are not contracts: tuning numbers, thresholds, seeded card or spawn orders, pixel layout, UI copy, config defaults, case counts. Assert invariants and bounds instead (stays in range, never negative, monotonic, the same seed gives the same result). Pin exact values only on contracts: money, the output a seeded RNG gives for a seed, wire and storage formats, public signatures, access decisions, ordering guarantees (`/todo` Release Slices and Risk Tiers, Pin contracts, not tuning)
- Pass or fail on balance in soak and survival harnesses: report a balance signal (deaths, win rate, time to clear) and fail only on crashes, hangs and broken invariants
- Private state reached by reflection, full CSS class strings, a constant asserted equal to its own literal, a `data-testid` that only has to exist, or exact UI copy: each pins implementation and fails on harmless changes. Assert the behavior the user or caller sees
- Wall-clock bounds (`< 2 s`) in unit tests: they fail on a busy machine and prove nothing about the code. Measure performance in a benchmark
- Copy-paste families of one-fact tests (including a scanner's self-tests): table-drive them with `it.each` so one case is one row
- Another edge case, input or branch for its own sake: on a `standard` story (no stated high-stakes reason), extra coverage that no defect asked for is cost, not assurance. A suite that adds many test lines per source line (the `test-cost.js` signal) is a prompt to ask which tests guard a contract

## Quality Criteria

### Good Tests
One behavior per test, a name that describes the scenario, no interdependencies (any order), builders or factories for data, and assertions on behavior rather than implementation.

### Bad Tests
Several unrelated behaviors in one test, order dependence, hardcoded data scattered about, mock verification instead of outcomes, or no meaningful assertion so the test always passes.

### Count & value assertions — never `toContain` for a quantity
A test whose name promises a count, total, number or specific value asserts it with `toBe` / `toEqual` / a numeric comparator (`toBeGreaterThan`, `toMatch` on a labeled value), not with `toContain` or substring presence alone. A bare substring check is a false green: the literal appears incidentally (dates, labels, IDs) and the test passes when the real count is wrong or zero. Make it a write-time check; it has slipped past authors and been caught only in review.

```js
// ✗ false-green: "1" appears in dates/labels regardless of the data
expect(output).toContain('1');
// ✗ false-green: the word "commit" is in every day-header
expect(timeline).toContain('commit');
// ✓ assert the labeled value
expect(output).toContain('Concept articles:  1');
expect(timeline).toMatch(/\(2 commits, \d+ files\)/);
expect(report.total).toBe(2);
```

### Cross-item field uniqueness for multi-item mapping functions

When a function maps a response into several output items (an adapter, a normalizer, a batch transform) and the AC or downstream design treats a mapped field as unique or dedup-relevant (a URL, an ID, a key), assert uniqueness of that field across the items of one multi-item case, not only that each item maps correctly in isolation. Per-item assertions are blind to a mapper that emits the same shared value for every item (a source-level URL instead of a per-item one), which silently defeats dedup while every single-item test passes.

```js
// ✗ insufficient: per-item mapping never checks the items differ where it matters
expect(items[0].url).toBe(expectedUrl0);
expect(items[1].url).toBe(expectedUrl1);

// ✓ explicit cross-item uniqueness assertion
expect(new Set(items.map((i) => i.url)).size).toBe(items.length);
```

### Concurrent-caller test for shared-key mutations

When two callers can run concurrently (`Promise.all`, overlapping cron ticks, racing requests) and both mutate state keyed by the same name or id, a test that calls the function once cannot catch a check-then-act race. Run two calls concurrently and assert the actual outcome; this is the shared-state generalization of the cross-item pattern above.

```js
// ✗ insufficient: one call; a TOCTOU race between two callers sharing a key cannot surface
await trackFailureAndMaybeAlert('shared-key');
expect(notify).toHaveBeenCalledTimes(1);

// ✓ simulates the race: the second of two concurrent claims on the SAME key must lose
tryClaimAlert.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
await Promise.all([trackFailureAndMaybeAlert('shared-key'), trackFailureAndMaybeAlert('shared-key')]);
expect(notify).toHaveBeenCalledTimes(1); // not 2 — one caller must lose the claim
```

### What a passing test can and cannot prove

Each of these produced a green suite over a real defect (the largest adopter's memory review, 2026-11).

- **Prove a test can fail by injecting exactly one defect.** Break the one thing the test guards, see that test go red for the stated reason, restore, rebuild and see green. A predicted list of reds is not proof, and several defects at once hide which test caught what. After restoring a file by copying it back, touch it and rebuild: an unchanged timestamp can leave the broken build in place.
- **A helper that computes both the expected and the actual value proves nothing.** If the expectation comes from the code under test (or a copy of its logic), a bug in that logic passes. Take expected values from the spec, a literal or an independent calculation.
- **A fake data provider cannot prove the real database's behavior.** In-memory providers and mocks skip SQL translation, constraints, collation, transactions and concurrency. A test whose claim is about a query, a constraint or a migration runs against the real engine (a container or a disposable database).
- **Mock fixtures cannot prove a data-loading defect is fixed.** If the bug was in what was loaded (a missing include, a lazy load, a projection), load through the real path; a fixture that hands the code the fully loaded object passes either way.
- **Fixtures hide the default production shape.** Hand-built fixtures fill every field; production rows have nulls, empty collections, legacy values and defaults. Include at least one fixture built the way production creates the record (its constructor, factory or a copy of a real row).
- **The first live run of a new end-to-end suite indicts the test first.** Check selectors, timing, data and environment before filing a product bug.

## Testing Conventions & Checkers

For the case where the thing under test is itself a rule (a cross-file convention) or a checker (a script that validates the tree):

- **Enforce a cross-file convention with a fail-closed meta-test that enumerates the file set at runtime.** When a rule must hold for every file of a kind (every command self-instruments, every skill conforms), recurse the directory with `fs.readdir` and `it.each` over the result instead of keeping a hand-maintained list, which silently omits new files. An empty enumeration is itself a failure.

- **Test a checker's logic against fixtures, never the live tree.** When a checker lands before the cleanup that makes the real tree pass, a test that scans the repo fails the moment the checker is introduced and later passes for the wrong reason; it tests the tree's current state, not the checker. Synthetic inputs keep it deterministic and independent of cleanup order.

- **A security or convention scanner's fixtures include evasive shapes, not just gated and ungated ones (added 2026-07-16).** A scanner that passes its happy-path fixtures can still be defeated non-adversarially: the guarded name in a comment or string literal, chained or whitespace-split calls (`app\n.get(`), variable-held arguments, method aliases (`app.on`/`app.all` vs `app.get`). For each evasion class add a fixture asserting a violation (or an explicit "cannot statically verify" error), plus one proving the legitimate exemptions still pass. (An adopter's authz scanner shipped with happy-path tests only and a critical comment-mention false negative surfaced a day later.)

## Cross-References
- Reads: `docs/architecture/overview.md` (test framework), `docs/work/backlog.md` (acceptance criteria)
- Produces: Test files in appropriate test directories

---

## Project-Specific Test Patterns

**Domdhi.Agents toolkit-specific.** Downstream projects should replace this block via /specialize --fix after their own architecture docs are complete.

**Framework:** Vitest 5 (see `package.json`) at repo root. Config: `vitest.config.mjs` (ESM; `.mjs` because Vite's CJS Node API is deprecated).

### ESM Import Pattern (REQUIRED for every test file)

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

### Test File Locations

- Core scripts: `.agents/core/__tests__/{module}.test.js` (colocated)
- Hooks: `.agents/hooks/__tests__/{hook}.test.js` (colocated)
- Runtime adapters: `.agents/adapters/{claude,codex}/__tests__/` — runtime-specific protocol and registration fixtures
- Shared helpers: `.agents/core/__tests__/_helpers/` — underscore prefix, not matched by the `*.test.js` glob, excluded from coverage

### Tmp-Dir Convention

Tests that write files scope them under a per-test temp directory, never the repo root, user home or a path the project itself writes to. Use `.agents/core/__tests__/_helpers/tmp-dir.js`: production code resolves output paths via `process.env.CLAUDE_PROJECT_DIR`, and the helper points that at a fresh scratch directory and tears it down after the test. Route every path through it rather than hardcoding.

### Commands

```bash
npm test                                    # all suites
npm run test:watch                          # watch mode
npm run test:coverage                       # v8 coverage → docs/.output/.state/telemetry/coverage/
node .claude/core/gate.js test              # gate runner; auto-detects node stack, runs npm test
```

### Coverage Thresholds

Enforced on the canonical implementation, `.agents/**/*.{js,cjs,mjs}` (see `vitest.config.mjs`). The generated `.claude`/`.codex` wrappers only forward to it, so they are not measured:

| Metric | Threshold |
|--------|-----------|
| Lines | 70% |
| Functions | 70% |
| Statements | 70% |
| Branches | 60% |

`.agents/core/*.js`, `.agents/core/_lib/**`, `.agents/hooks/**` and `.agents/adapters/**` must each meet the same floor on their own. Exclusions: `**/__tests__/**`, `**/_helpers/**`, `docs/**`, `node_modules/**`. Code a test runs only in a child process is not measured.

### CLI Guard for Testable Core Scripts

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

### AAA + AC Mapping

Use Arrange-Act-Assert with blank-line separation. One AC bullet maps to one or more `it(...)` cases, named `subject_scenario_expectedResult` (snake_case after the subject, camelCase inside segments), so the AC-to-test mapping is traceable in the Execution Log:

```js
it('parseTestOutput_vitestSpacedFormat_returnsCorrectCounts', () => { ... });
```

### AC Reconciliation Table (pre-dispatch step)

Before dispatching a dev agent, especially in parallel waves, put an AC-to-source reconciliation table in the plan file at `docs/.output/plans/{date}/{slug}.md`. It surfaces name, signature and shape mismatches between what the AC says and what the source has before an agent debates them mid-implementation, and every agent then reads the same locked names (zero signature drift across 25 parallel agents in Epics TDD-2 through TDD-6).

| Story | AC says | Source has | Decision | Rationale |
|-------|---------|------------|----------|-----------|
| {ID} | `matchesRule(cmd, rule)` | `matchPatterns(cmd, patterns[])` | Export as **`matchPatterns`** | AC drifted; source is correct. Tests assert against `matchPatterns`. |
| {ID} | `appendJsonl(path, entry)` | inline in `main()` | **Extract** `appendJsonl(jsonlPath, event): void` | Function doesn't exist yet — create during refactor. |
| {ID} | `inferGateRun → {type, mode}` | returns string `'gate:build'` | **Keep string return** | Source is simpler. Update test assertion. |

### Mocking Legacy CJS with Top-Level Destructure

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

### Non-Deterministic Tests: Threshold Widening Rule

Tests that assert on PRNG state (`Math.random`), time-of-day fractions or anything sensitive to suite ordering need wider thresholds than variance math suggests, because PRNG state leaking across the full-suite order fattens the tail. Widen to a natural-language boundary, not a variance boundary:

| Naive threshold | Better threshold | Natural-language meaning |
|---|---|---|
| `< 0.30` (3.75σ on Binomial(100, 0.2)) | `< 0.50` | "no element dominates" |
| `> 0.79` (after PRNG-state-amplified decay) | `> 0.75` | "boosts applied" |

The variance-math thresholds flaked repeatedly (commits `a9ef9cd`, `48a3d6d`, `d22be7c`); the plain-English ones held. The test wants to catch "a broken shuffle always picks the same element", not measure binomial variance.

### Integration Tests: Subprocess + Spy Patterns

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

### Literal AC Numbers + Dynamic Dates

**Literal AC numbers.** An AC that states an exact count ("process 10 items", "JSONL contains 10 entries") is literal, not a lower bound. Seed enough input to trigger exactly that condition and assert `toBe(N)`, never `toBeGreaterThanOrEqual(1)` (an agent once softened `toBe(10)` to `>= 1` to fit its 3-entry seed instead of seeding the 12 entries needed to reach `MAX_ENTRIES_PER_RUN = 10`). If the implementation has a cap or threshold, work back from it so the cap is the binding constraint, which makes `toBe(10)` provable.

**Dynamic dates.** When source code calls `new Date()` for time-window comparisons (files older than `MIN_AGE_DAYS = 7`), tests compute dates dynamically; a hardcoded calendar date goes red on the day it crosses the boundary.

```js
// Bad — flips red on 2026-04-25
const old = '2026-04-18';

// Good — always 8 days ago
const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
```
