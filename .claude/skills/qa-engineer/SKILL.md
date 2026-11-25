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

<!-- @@project-additions -->
