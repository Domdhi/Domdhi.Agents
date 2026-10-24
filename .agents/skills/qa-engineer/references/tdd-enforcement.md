# TDD Enforcement Reference

**Load this when:** implementing any feature or bugfix, writing or changing tests, or tempted to skip writing a failing test first.

---

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over. Implement fresh from tests.

**No exceptions:**
- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

---

## Red-Green-Refactor

### RED — Write Failing Test

Write one minimal test showing what should happen. Then verify it fails correctly:

```bash
npm test path/to/test.test.ts
```

Confirm the test fails (not errors), failure message is expected, and it fails because the feature is missing — not because of typos. If the test passes immediately, you're testing existing behavior. Fix the test.

**Good test:**
```typescript
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
```

**Bad test:**
```typescript
test('retry works', async () => {
  const mock = jest.fn()
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce('success');
  await retryOperation(mock);
  expect(mock).toHaveBeenCalledTimes(3);
}); // Vague name, tests mock not code
```

### GREEN — Minimal Code

Write the simplest code to pass the test. Don't add features, refactor other code, or "improve" beyond the test.

```typescript
// Good — just enough to pass
async function retryOperation<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    try { return await fn(); } catch (e) { if (i === 2) throw e; }
  }
  throw new Error('unreachable');
}
```

Then verify all tests pass: `npm test path/to/test.test.ts`

### REFACTOR — Clean Up

After green only: remove duplication, improve names, extract helpers. Keep tests green. Don't add behavior. Then repeat for the next test.

---

## Common Rationalizations (All Wrong)

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "Tests after achieve same goals" | Tests-after = "what does this do?" Tests-first = "what should this do?" |
| "Already manually tested" | Ad-hoc ≠ systematic. No record, can't re-run. |
| "Deleting X hours is wasteful" | Sunk cost fallacy. Unverified code is technical debt. |
| "Keep as reference, write tests first" | You'll adapt it. That's testing after. Delete means delete. |
| "Need to explore first" | Fine. Throw away exploration, start with TDD. |
| "TDD will slow me down" | TDD is faster than debugging. Pragmatic = test-first. |

---

## Red Flags — STOP and Start Over

- Code before test
- Test passes immediately
- Can't explain why test failed
- "Tests added later"
- Rationalizing "just this once"
- "Already spent X hours, deleting is wasteful"
- "TDD is dogmatic, I'm being pragmatic"
- "This is different because..."

**All of these mean: Delete code. Start over.**

---

## Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test written first
- [ ] Watched each test fail before implementing
- [ ] Each test failed for expected reason (feature missing, not typo)
- [ ] Wrote minimal code to pass each test
- [ ] All tests pass
- [ ] Output pristine (no errors, warnings)
- [ ] Tests use real code (mocks only if unavoidable)
- [ ] Edge cases and errors covered

Can't check all boxes? You skipped TDD. Start over.

---

## Testing Anti-Patterns

### Anti-Pattern 1: Testing Mock Behavior

```typescript
// BAD: Testing that the mock exists
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});

// GOOD: Test real component or don't mock it
test('renders sidebar', () => {
  render(<Page />);
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});
```

**Gate:** Before asserting on any mock element — ask: "Am I testing real behavior or just mock existence?" If testing mock existence, stop.

### Anti-Pattern 2: Test-Only Methods in Production

```typescript
// BAD: destroy() only used in tests
class Session {
  async destroy() { /* cleanup */ }  // Looks like production API!
}

// GOOD: Put cleanup in test utilities
export async function cleanupSession(session: Session) { /* ... */ }
```

**Gate:** Before adding any method to a production class — ask: "Is this only used by tests?" If yes, put it in test utilities instead.

### Anti-Pattern 3: Mocking Without Understanding

```typescript
// BAD: Mock prevents config write the test depends on
vi.mock('ToolCatalog', () => ({
  discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
}));

// GOOD: Mock at the correct level
vi.mock('MCPServerManager'); // Just mock slow server startup
```

**Gate:** Before mocking any method — understand what side effects the real method has. Does the test depend on any of them? If yes, mock at a lower level.

### Anti-Pattern 4: Incomplete Mocks

Mock the COMPLETE data structure as it exists in reality, not just fields your immediate test uses. Partial mocks hide structural assumptions and cause silent failures when downstream code accesses fields you didn't include.

### Anti-Pattern 5: Tests as Afterthought

Testing is part of implementation, not optional follow-up. TDD would have caught this. You cannot claim complete without tests.

---

## Quick Reference

| Anti-Pattern | Fix |
|--------------|-----|
| Assert on mock elements | Test real component or unmock it |
| Test-only methods in production | Move to test utilities |
| Mock without understanding | Understand dependencies first, mock minimally |
| Incomplete mocks | Mirror real API completely |
| Tests as afterthought | TDD — tests first |
| Over-complex mocks | Consider integration tests instead |
