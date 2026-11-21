# TDD Enforcement Reference

Load this when implementing a feature or bugfix, writing or changing tests, or tempted to skip the failing test. The point of test-first is that a test written before the code says what the code should do, while a test written after only records what it happens to do.

---

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Code written before its test is deleted and re-implemented from the tests. It is not kept as "reference" or adapted while writing the tests; adapting it is testing after.

Exploration is fine as a throwaway: discard it, then start with the test.

---

## Red-Green-Refactor

### RED: write one failing test

Write one minimal test for the behavior, run it, and confirm it fails (not errors) with the expected message because the feature is missing, not because of a typo:

```bash
npm test path/to/test.test.ts
```

A test that passes immediately is testing existing behavior; fix the test. Name the behavior and assert on real code:

```typescript
// Good: names the behavior, runs the real function
test('retries failed operations 3 times', async () => {
  let attempts = 0;
  const operation = () => {
    attempts++;
    if (attempts < 3) throw new Error('fail');
    return 'success';
  };
  const result = await retryOperation(operation);
  expect(result).toBe('success');
  expect(attempts).toBe(3);
});

// Bad: vague name, and it tests the mock rather than the code
test('retry works', async () => {
  const mock = jest.fn().mockRejectedValueOnce(new Error()).mockResolvedValueOnce('success');
  await retryOperation(mock);
  expect(mock).toHaveBeenCalledTimes(3);
});
```

### GREEN: minimal code

Write the simplest code that passes, with no extra features or unrelated refactoring, then run the tests to confirm they pass:

```typescript
async function retryOperation<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    try { return await fn(); } catch (e) { if (i === 2) throw e; }
  }
  throw new Error('unreachable');
}
```

### REFACTOR: after green only

Remove duplication, improve names, extract helpers, keeping the tests green and adding no behavior. Then take the next test.

---

## Red Flags: STOP and Start Over

Code before the test; a test that passes immediately; being unable to say why a test failed; "tests added later"; "just this once"; "already spent hours, deleting is wasteful" (sunk cost; unverified code is debt); "TDD is dogmatic, I'm being pragmatic" (test-first is faster than debugging); "too simple to test" (simple code breaks); "already tested it manually" (ad-hoc runs leave no record and cannot be re-run).

Any of these means: delete the code and start over from the test.

---

## Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test written first
- [ ] Watched each test fail before implementing
- [ ] Each test failed for the expected reason (feature missing, not a typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

A box that cannot be checked means TDD was skipped: start over.

---

## Testing Anti-Patterns

**Testing mock behavior.** Asserting that a mock exists proves nothing about the product. Before asserting on a mock element, ask whether the test covers real behavior or just mock existence.

```typescript
// BAD: tests that the mock exists
expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
// GOOD: test the real component, or don't mock it
expect(screen.getByRole('navigation')).toBeInTheDocument();
```

**Test-only methods in production.** A `destroy()` that only tests call looks like production API. Before adding a method to a production class, ask whether only tests use it; if so, put it in a test utility (`export async function cleanupSession(session: Session) { /* ... */ }`).

**Mocking without understanding.** Before mocking a method, know its side effects and whether the test depends on them. If it does, mock at a lower level: mock slow server startup (`vi.mock('MCPServerManager')`), not the catalog call that writes the config the test reads (`discoverAndCacheTools`).

**Incomplete mocks.** Mock the complete data structure as it exists in reality, not just the fields the immediate test uses. Partial mocks hide structural assumptions and fail silently when downstream code reads a field you left out. When mocks get this complex, consider an integration test instead.

**Tests as an afterthought.** Testing is part of implementation, not follow-up; work is not complete without tests.
