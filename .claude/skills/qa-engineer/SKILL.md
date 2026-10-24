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

Expert in test strategy and automated test generation. Produces tests that verify acceptance criteria from stories.

**TDD first.** Before implementing anything, read `.claude/skills/qa-engineer/references/tdd-enforcement.md` — the Iron Law (no production code without a failing test first), Red-Green-Refactor, and the anti-patterns that let a test-after pass masquerade as test-first.

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
```
// Arrange - set up test data and dependencies
// Act - call the method under test
// Assert - verify the result
```

### Test Data Builders
```
// Builder pattern for complex test objects
// var user = new UserBuilder().WithRole("Admin").WithEmail("test@test.com").Build();
```

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
- Business logic (always)
- Validation rules (always)
- Error handling paths (always)
- Data transformations (always)
- API endpoint contracts (integration)
- Critical user journeys (e2e)

### What NOT to Test
- Framework code (Angular/ASP.NET internals)
- Simple getters/setters with no logic
- Third-party library behavior
- Auto-generated code
- Configuration files

## Quality Criteria

### Good Tests
- Test one thing per test method
- Test name describes the scenario
- No test interdependencies (can run in any order)
- Use builders/factories for test data (not raw object construction)
- Assert behavior, not implementation details

### Bad Tests
- Multiple assertions testing different behaviors
- Tests that depend on execution order
- Hardcoded test data scattered everywhere
- Testing implementation details (mock verification overuse)
- Tests that always pass (no meaningful assertion)

### Count & value assertions — never `toContain` for a quantity
A test whose name promises a **count, total, number, or specific value** MUST assert it with `toBe` / `toEqual` / a numeric comparator (`toBeGreaterThan`, `toMatch` on a labeled value) — **never `toContain` (or substring presence) alone.** A bare substring check is a false-green: the literal appears in the output incidentally (dates, labels, IDs) and the test passes even when the real count is wrong or zero.

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
This exact anti-pattern slipped past dev agents twice in one test-authoring epic (once per wave) and was caught only in review — make it a write-time check, not a review-time catch.

### Cross-item field uniqueness for multi-item mapping functions

When a function maps a response into multiple output items sharing one input shape (an adapter, a normalizer, a batch transform), and the AC or downstream design treats one of the mapped fields as unique/dedup-relevant (a URL, an ID, a key), the test suite MUST assert uniqueness of that field **across items in the same multi-item test case** — not just "maps every item" and "maps correctly" per item in isolation.

```js
// ✗ insufficient: tests per-item mapping, never checks the two items differ where it matters
expect(items[0].url).toBe(expectedUrl0);
expect(items[1].url).toBe(expectedUrl1);

// ✓ explicit cross-item uniqueness assertion
expect(new Set(items.map((i) => i.url)).size).toBe(items.length);
```

Per-item assertions are blind to a mapper that emits the same shared value for every item (e.g. a source-level URL instead of a per-item one) — the bug silently defeats downstream dedup while every single-item test passes. Add this assertion whenever a story's AC documents a field as unique/dedup-relevant on a function that returns more than one item per call.

### Concurrent-caller test for shared-key mutations

When two callers can run concurrently (`Promise.all`, overlapping cron ticks, two requests racing) and both mutate state keyed by the **same** name/id — not one row each — a test that only ever invokes the function once per test cannot catch a check-then-act race. Assert the actual concurrent-call outcome, not just the single-caller happy path:

```js
// ✗ insufficient: only ever calls the function once — a TOCTOU race between two concurrent
// callers sharing one key has no way to surface
await trackFailureAndMaybeAlert('shared-key');
expect(notify).toHaveBeenCalledTimes(1);

// ✓ simulates the race: the second of two concurrent claims on the SAME key must lose
tryClaimAlert.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
await Promise.all([trackFailureAndMaybeAlert('shared-key'), trackFailureAndMaybeAlert('shared-key')]);
expect(notify).toHaveBeenCalledTimes(1); // not 2 — one caller must lose the claim
```

This is the shared-mutable-state generalization of the cross-item pattern above: whenever a shared key/resource can be reached by more than one concurrent caller, add a test that actually runs two calls concurrently and asserts only one wins — a single-call test cannot see a check-then-act race.

## Testing Conventions & Checkers

Two patterns for the case where the thing under test is itself a *rule* (a cross-file convention) or a *checker* (a script that validates the tree):

- **Enforce a cross-file convention with a fail-closed meta-test that enumerates the file-set at runtime.** When a rule must hold for *every* file of a kind (every command self-instruments, every skill conforms, every agent has a required section), do not hand-maintain a list of files in the test — `fs.readdir`-recurse the directory and `it.each` over the result, asserting the rule per file. A new file that violates the convention then fails automatically the moment it's added; a hardcoded list silently omits it. Fail-closed: an empty enumeration (glob matched nothing) is itself a failure, not a pass.

- **Test a checker's LOGIC against fixtures, never against the live tree.** When a checker/linter script lands before the cleanup that makes the real tree pass (TDD-ordered: add-the-check, then fix-the-violations), its unit test must assert the checker's logic against *synthetic/fixture inputs*, not by scanning the real repo. A test that scans the live tree fails the instant the checker is introduced (the violations it's meant to catch still exist) and passes later for the wrong reason — it tests the tree's current state, not the checker. Fixture inputs make the test deterministic and independent of cleanup ordering.

- **A security/convention scanner's fixtures must include EVASIVE shapes, not just gated/ungated (added 2026-07-16).** A text/regex scanner passing its happy-path fixtures can still be defeated non-adversarially: the guarded-pattern name appearing in a comment or string literal, chained/whitespace-split call syntax (`app\n.get(`), variable-held instead of literal arguments, method aliases (`app.on`/`app.all` vs `app.get`). For every scanner that gates the build, add one fixture per evasion class asserting a VIOLATION (or an explicit "cannot statically verify" error), plus a fixture proving the legitimate exemptions still pass. (Precedent: an adopter's authz scanner shipped with happy-path-only tests and a CRITICAL comment-mention false negative was found one day later.)

## Cross-References
- Reads: `docs/architecture/overview.md` (test framework), `docs/work/backlog.md` (acceptance criteria)
- Produces: Test files in appropriate test directories

---

## Project-Specific Test Patterns

**Domdhi.Agents toolkit-specific.** Downstream projects should replace this block via /specialize --fix after their own architecture docs are complete.

**Framework:** Vitest 5 (see `package.json`) at repo root. Config: `vitest.config.mjs` (ESM — `.mjs` is required because Vite's CJS Node API is deprecated).

### ESM Import Pattern (REQUIRED for every test file)

`package.json` is `"type": "commonjs"` — all `.claude/core/*.js` scripts use `require` / `module.exports`. Vitest's test API is ESM; a CommonJS test file calling `require('vitest')` was **rejected** with (observed when this pattern was established):

```
Error: Vitest cannot be imported in a CommonJS module using require().
Please use 'import' instead.
```

Every test file MUST use ESM imports and bridge to CJS source modules via `createRequire`:

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

Canonical reference: `.agents/core/__tests__/_smoke.test.js`. Copy its shape for every new test.

### Test File Locations

- Core scripts: `.agents/core/__tests__/{module}.test.js` (colocated)
- Hooks: `.agents/hooks/__tests__/{hook}.test.js` (colocated)
- Runtime adapters: `.agents/adapters/{claude,codex}/__tests__/` — runtime-specific protocol and registration fixtures
- Shared helpers: `.agents/core/__tests__/_helpers/` — underscore prefix, NOT matched by `*.test.js` glob, excluded from coverage

### Tmp-Dir Convention

Tests that write files MUST scope paths under a per-test temp directory — never the repo root, user home, or any path the project itself writes to. Use the `tmp-dir` helper at `.agents/core/__tests__/_helpers/tmp-dir.js` (lands in TDD-2.1).

Production code under test resolves output paths via `process.env.CLAUDE_PROJECT_DIR`. The tmp-dir helper sets that env var to a freshly-created scratch directory and tears it down after the test. Do not hardcode paths — always route through the helper.

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

Core scripts that call `main()` at file scope will execute (and `process.exit()`) the moment a test `require`s them — which kills the Vitest worker. Every CLI script MUST wrap its entry point:

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

Without this guard, importing the script from a test is a runner-killer. Before writing tests for any core script, verify the guard exists — if not, add it as part of the story.

### AAA + AC Mapping

Use Arrange-Act-Assert with blank-line separation. One AC bullet → one or more `it(...)` cases. Test names use `subject_scenario_expectedResult` (snake_case after the subject, camelCase inside segments):

```js
it('parseTestOutput_vitestSpacedFormat_returnsCorrectCounts', () => { ... });
```

This makes the AC → test mapping traceable in the Execution Log.

### AC Reconciliation Table (pre-dispatch step)

Before dispatching a dev agent — especially in parallel waves — author an AC→source reconciliation table in the plan file. This catches name/signature/shape mismatches between what the AC says and what the source actually has, BEFORE the agent debates them. Field-tested across Epics TDD-2 through TDD-6: 19/19 first-try DONE, zero signature drift across 25 parallel agents.

Template:

| Story | AC says | Source has | Decision | Rationale |
|-------|---------|------------|----------|-----------|
| {ID} | `matchesRule(cmd, rule)` | `matchPatterns(cmd, patterns[])` | Export as **`matchPatterns`** | AC drifted; source is correct. Tests assert against `matchPatterns`. |
| {ID} | `appendJsonl(path, entry)` | inline in `main()` | **Extract** `appendJsonl(jsonlPath, event): void` | Function doesn't exist yet — create during refactor. |
| {ID} | `inferGateRun → {type, mode}` | returns string `'gate:build'` | **Keep string return** | Source is simpler. Update test assertion. |

Place the reconciliation table in the wave plan file at `docs/.output/plans/{date}/{slug}.md` before dispatching agents. Lock names there — every agent reads the same table, no agent debates a name mid-implementation.

Lock the names BEFORE dispatch. Every agent reads the same table. No agent debates a name mid-implementation. This is the load-bearing change behind the first-try DONE streak.

### Mocking Legacy CJS with Top-Level Destructure

Source modules that use `const { execSync } = require('child_process')` (destructured at top-level) are **not** patchable by `vi.spyOn(childProcess, 'execSync')` — by the time the spy installs, the source already captured the original reference. Symptom: the spy is never hit; the test calls real `execSync`.

**Fix**: pre-inject a proxy module into `require.cache` BEFORE the source is required. Use the canonical helper at `.agents/core/__tests__/_helpers/claude-mock.js`:

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

Multi-method form (when the source destructures both `execSync` AND `spawn`):

```js
const { mockExecSync, mockSpawn, loader } = installExecSyncMock(vi, ['execSync', 'spawn']);
```

When the source destructures a class (e.g. `const { DailyLog } = require('../core/daily-log')`) at top level, the same `require.cache` injection pattern applies — pre-inject a proxy class BEFORE the source is required. See `.agents/hooks/__tests__/pre-compaction-archive.test.js` for the canonical example.

For modules that don't destructure (e.g. `const childProcess = require('child_process'); ...; childProcess.execSync(...)`), normal `vi.spyOn(childProcess, 'execSync')` works fine — no helper needed.

### Non-Deterministic Tests: Threshold Widening Rule

Tests that assert on PRNG state (Math.random), time-of-day fractions, or any output sensitive to suite ordering need wider thresholds than naive variance math suggests. PRNG state leakage across the full-suite test order amplifies the tail.

**Rule**: widen the threshold to a **natural-language boundary**, not a variance-math boundary.

| Naive threshold | Better threshold | Natural-language meaning |
|---|---|---|
| `< 0.30` (3.75σ on Binomial(100, 0.2)) | `< 0.50` | "no element dominates" |
| `> 0.79` (after PRNG-state-amplified decay) | `> 0.75` | "boosts applied" |

Evidence — three commits widened thresholds across the same flake class:
- `a9ef9cd` — TDD-4.4 distribution test 0.30 → 0.35 (3.75σ math)
- `48a3d6d` — TDD-4.1 decayedConfidence 0.79 → 0.75 (natural-language threshold)
- `d22be7c` — TDD-4.4 distribution again 0.35 → 0.50 (natural-language threshold; the 3.75σ widening wasn't enough)

The math version flaked twice. The plain-English version held. **Default to plain English** — your test wants to catch "broken shuffle always picks the same element" (100% case), not measure binomial variance.

### Integration Tests: Subprocess + Spy Patterns

Integration tests in this repo (Wave 6: gate stack detection, secret-scanner pre-commit, template-updater zones, memory-pipeline) converged on the same shape. Match it for any new integration test.

**Subprocess pattern**:

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

`fileURLToPath` is non-negotiable on Windows — `new URL(import.meta.url).pathname` returns `/C:/...` and breaks `path.resolve`.

**Prototype-spy as integration boundary** — legitimate when the bypassed behavior is already covered by unit tests on the spied class. Hollows the test when the bypassed behavior IS the AC.

```js
// Legitimate: MemoryManager.searchMemories has unit-test coverage in memory-manager.test.js
// Integration test's job is to verify the wiring (caller → searchMemories → JSONL records),
// NOT to retest FTS5/JSON keyword matching.
vi.spyOn(MemoryManager.prototype, 'searchMemories').mockReturnValue([
  { id: 'expected-slug', score: 0.9 },
]);
```

Reviewer rule: spy only at proven subsystem boundaries where unit tests cover the bypassed code. If the AC under test IS "search returns the right results", the spy hollows it.

**Seeding-return-value rule (always)** — when a test uses `vi.spyOn` on any boundary, every seeding call (`createMemory`, `createConcept`, `addCommit`, etc.) MUST assert its return value:

```js
const result = await mgr.createMemory(category, id, payload);
expect(result, 'Stage N: createMemory should succeed').not.toBeNull();
```

Without this, a silent seeding failure (`createMemory` returns `null` on validation/IO error) leaves the spy returning canned data while the underlying store is empty — the test passes with false confidence. One assertion per seeding call closes the gap.

### Literal AC Numbers + Dynamic Dates

**Literal AC numbers**: when AC specifies an exact count (e.g., "process 10 items", "JSONL contains 10 entries"), it is **literal**, not a lower bound. Seed enough input to trigger exactly that condition and assert with `toBe(N)`, never `toBeGreaterThanOrEqual(1)`. Surfaced in TDD-6.1 — agent softened `toBe(10)` to `>= 1` to match its 3-entry seed instead of reseeding the 12 entries needed to trigger `MAX_ENTRIES_PER_RUN = 10`.

If the implementation has a cap or threshold, work back from it: cap is 10, sampler picks evenly from N inputs across M sources → seed `M * (10/M + buffer)` so the cap is the binding constraint. Then `toBe(10)` becomes provable.

**Dynamic dates**: when source code calls `new Date()` for time-window comparisons (e.g., "files older than `MIN_AGE_DAYS = 7`"), tests MUST compute dates dynamically — never hardcode calendar dates. A hardcoded `2026-04-18` becomes a CI landmine that fires on the first day the test crosses the boundary.

```js
// Bad — flips red on 2026-04-25
const old = '2026-04-18';

// Good — always 8 days ago
const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
```

Surfaced in TDD-4.4 code review (M-1 finding). Both `collectEntries` tests had hardcoded dates that would have failed on 2026-04-25.
