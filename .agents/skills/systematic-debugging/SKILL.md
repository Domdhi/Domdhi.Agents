---
name: systematic-debugging
description: "Use WHEN encountering any bug, test failure, or unexpected behavior — BEFORE proposing any fix; mandates root cause investigation through four phases before a single line of fix code is written"
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [debugging, root-cause-analysis, workflow, quality]
user-invocable: false
allowed-tools: Read Bash Grep Glob
---

# Systematic Debugging

## Overview

Random fixes waste time and create new bugs; quick patches mask underlying issues. Find the root cause before attempting a fix, because a symptom fix is a failed fix. Following the letter of this process is following its spirit.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

Until Phase 1 is complete, do not propose a fix.

## When to Use

Use for any technical issue: test failures, production bugs, unexpected behavior, performance problems, build failures, integration issues.

Use it especially under time pressure, when a quick fix seems obvious, after earlier fixes failed, and when you do not fully understand the issue. Do not skip it because the issue seems simple (simple bugs have root causes too), because you are in a hurry (rushing guarantees rework), or because someone wants it fixed now (systematic is faster than thrashing).

## The Four Phases

Complete each phase before the next.

### Phase 1: Root Cause Investigation

Before attempting any fix:

1. **Read error messages carefully.** Read stack traces completely and note line numbers, file paths and error codes. They often contain the exact solution.

2. **Reproduce consistently.** Establish the exact steps and whether it happens every time. If it is not reproducible, gather more data instead of guessing.

3. **Check recent changes.** Git diff, recent commits, new dependencies, config changes, environmental differences.

4. **Gather evidence in multi-component systems** (CI → build → signing, API → service → database). Before proposing fixes, add diagnostic instrumentation:
   ```
   For EACH component boundary:
     - Log what data enters component
     - Log what data exits component
     - Verify environment/config propagation
     - Check state at each layer

   Run once to gather evidence showing WHERE it breaks
   THEN analyze evidence to identify failing component
   THEN investigate that specific component
   ```

   Example (multi-layer system):
   ```bash
   # Layer 1: Workflow
   echo "=== Secrets available in workflow: ==="
   echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

   # Layer 2: Build script
   echo "=== Env vars in build script: ==="
   env | grep IDENTITY || echo "IDENTITY not in environment"

   # Layer 3: Signing script
   echo "=== Keychain state: ==="
   security list-keychains
   security find-identity -v

   # Layer 4: Actual signing
   codesign --sign "$IDENTITY" --verbose=4 "$APP"
   ```

   This reveals which layer fails (secrets → workflow ✓, workflow → build ✗).

5. **Trace data flow** when the error is deep in the call stack. See `references/root-cause-tracing.md` for the complete backward tracing technique. In short: find where the bad value originates, what called this with it, and keep tracing up to the source. Fix at the source, not the symptom.

### Phase 2: Pattern Analysis

1. **Find working examples.** Locate similar working code in the same codebase.
2. **Compare against references.** When implementing a pattern, read the reference implementation completely and understand it before applying it.
3. **Identify differences.** List every difference between working and broken, however small. Don't assume "that can't matter".
4. **Understand dependencies.** What other components, settings, config and environment does it need, and what assumptions does it make?

### Phase 3: Hypothesis and Testing

1. **Form a single hypothesis.** Write it down, specific and clear: "I think X is the root cause because Y".
2. **Test minimally.** Make the smallest possible change that tests the hypothesis, one variable at a time.
3. **Verify before continuing.** If it worked, go to Phase 4. If not, form a new hypothesis rather than adding fixes on top.
4. **When you don't know,** say "I don't understand X", ask for help or research more. Don't pretend to know.

### Phase 4: Implementation

Fix the root cause, not the symptom.

1. **Create a failing test case** before fixing: the simplest possible reproduction, automated if possible, otherwise a one-off script. A failing test proves the bug is reproducible (see TDD principles).

2. **Implement a single fix** that addresses the identified root cause. One change at a time, with no "while I'm here" improvements and no bundled refactoring.

3. **Verify the fix.** The test passes, no other tests broke, and the issue is actually resolved.

4. **If the fix doesn't work, STOP and count the fixes tried.**
   - Fewer than 3: return to Phase 1 and re-analyze with the new information.
   - 3 or more: STOP and question the architecture (step 5). Do not attempt fix #4 without that discussion.

4b. **Capture rejected approaches (fix count ≥ 3).** Before questioning architecture, log the failed approaches as memory so future sessions don't retry the dead ends. Use `/remember` for a quick capture, or `node .claude/core/memory-manager.js create rejected-approaches <slug> '{"content":{...}}'` for structured storage. This step is required: cross-session retry loops are the failure mode the `rejected-approaches` category (decay rate 0.90, ~7-day half-life) exists to prevent.

   Minimum payload:
   ```json
   {
     "content": {
       "approach": "short description of what was tried",
       "why_rejected": "specific symptom or test that proved it doesn't solve the root cause",
       "hypothesis_id": "<phase-3 hypothesis ID if applicable>"
     }
   }
   ```

5. **If 3+ fixes failed, question the architecture.** Signs of an architectural problem:
   - Each fix reveals new shared state, coupling or problems in a different place
   - Fixes require "massive refactoring" to implement
   - Each fix creates new symptoms elsewhere

   Ask whether the pattern is fundamentally sound, whether you are sticking with it through sheer inertia, and whether to refactor the architecture instead of continuing to fix symptoms. Discuss with your human partner before attempting more fixes. This is a wrong architecture, not a failed hypothesis.

## Red Flags - STOP and Follow Process

If you catch yourself thinking any of these, STOP and return to Phase 1:
- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "Skip the test, I'll manually verify"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Pattern says X but I'll adapt it differently"
- "Here are the main problems: [lists fixes without investigation]"
- Proposing solutions before tracing data flow
- "One more fix attempt" when you have already tried 2+
- Each fix reveals a new problem in a different place

Each pattern is a consequence of skipping a phase:
- **Assuming without verifying:** claiming the issue is X without reproducing it, so the fix lands on the wrong component.
- **Skipping evidence gathering:** forming hypotheses without instrumenting the failure boundary, so they are untethered from data.
- **Proposing fixes before root cause:** each fix uncovers a new symptom because the root is untouched.
- **Treating symptoms as root causes:** fixing the observable failure point instead of tracing to origin, so the bug returns in a different form.
- **Persisting past three failed fixes:** three failures signal a wrong pattern, not a wrong fix. Question the architecture (Phase 4, step 5).

STOP: do not continue until you complete the investigation step you skipped.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Issue is simple, don't need process" | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process" | Systematic debugging is faster than guess-and-check thrashing. |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start. |
| "I'll write test after confirming fix works" | Untested fixes don't stick. Test first proves it. |
| "Multiple fixes at once saves time" | Can't isolate what worked. Causes new bugs. |
| "Reference too long, I'll adapt the pattern" | Partial understanding guarantees bugs. Read it completely. |
| "I see the problem, let me fix it" | Seeing symptoms ≠ understanding root cause. |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question pattern, don't fix again. |

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix, verify | Bug resolved, tests pass |

## When Process Reveals "No Root Cause"

If systematic investigation shows the issue is truly environmental, timing-dependent or external:

1. You've completed the process
2. Document what you investigated
3. Implement appropriate handling (retry, timeout, error message)
4. Add monitoring/logging for future investigation

But 95% of "no root cause" cases are incomplete investigation.

## Supporting Techniques

Available in `references/`:

- **`references/root-cause-tracing.md`** - Trace bugs backward through call stack to find original trigger
- **`references/defense-in-depth.md`** - Add validation at multiple layers after finding root cause
- **`references/condition-based-waiting.md`** - Replace arbitrary timeouts with condition polling

Investigation ends at a fix verified green, not at a root-cause writeup. Once Phase 1 confirms the cause and the fix is obvious and worth making, implement it in this same pass (Phase 4) and re-run the verification; don't hand back a diagnosis that ends in "want me to fix it?". This is the project's operating standard: **resolve it or don't report it.** The only legitimate stop is a genuine fork (the 3-strike architectural question above, mutually-exclusive approaches, an irreversible action). A confirmed bug with an obvious fix is never a fork.

**Related skills:**
- **verification-before-completion** — Verify the fix worked before claiming success; canonical home of the "Resolve, Don't Defer" operating standard (`superpowers:*` refs are from an external library and are not live in this repo)

## Real-World Impact

Systematic approach: 15-30 minutes to fix, 95% first-time fix rate, near-zero new bugs. Random fixes: 2-3 hours of thrashing, 40% first-time fix rate, new bugs common.
