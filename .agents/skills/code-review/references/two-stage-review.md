# Two-Stage Review Reference

**Load this when:** executing an implementation plan with independent tasks — dispatching a fresh subagent per task with spec compliance review first, then code quality review.

---

## Core Principle

Fresh subagent per task + two-stage review (spec then quality) = high quality, fast iteration.

**Stage 1 — Coverage (Spec Compliance + Candidate Findings):** Did they build what was requested (nothing more, nothing less)? While reading the diff, surface every candidate code finding — including low-confidence ones — each labeled with confidence and severity. Do not filter; discovery is the goal.
**Stage 2 — Adjudicate (Code Quality):** Is it well-built (clean, tested, maintainable)? Receive the candidate findings from stage 1 and apply severity and escalation rules to decide what blocks merge. (Adjudication ranks findings; it is not the ship-level judge — that gate lives in verification-before-completion.)

Always run spec compliance before code quality. Never run code quality review if spec compliance has open issues.

---

## The Process (Per Task)

```
1. Extract task text and context from plan
2. Dispatch implementer subagent
3. If implementer has questions → answer before they proceed
4. Implementer implements, tests, commits, self-reviews, reports back
5. Dispatch spec compliance reviewer
6. If spec reviewer finds issues → implementer fixes → spec reviewer verifies only the listed fixes (one closure pass)
7. Once spec compliance passes → dispatch code quality reviewer
8. If code quality reviewer finds issues → implementer fixes → the same reviewer verifies only the listed fixes (one closure pass)
   - Each reviewer gets at most three passes: the review, its closure, and one more only for a CRITICAL or MAJOR a fix introduced. New MINOR/NIT findings are fixed and proven by a test, not re-reviewed.
9. Once both pass → mark task complete
10. Repeat for next task
11. After all tasks → dispatch final code reviewer for entire implementation
```

---

## Implementer Subagent Prompt Template

```
Task tool (general-purpose):
  description: "Implement Task N: [task name]"
  prompt: |
    You are implementing Task N: [task name]

    ## Task Description

    [FULL TEXT of task from plan — paste it here, don't make subagent read file]

    ## Context

    [Scene-setting: where this fits, dependencies, architectural context]

    ## Before You Begin

    If you have questions about:
    - The requirements or acceptance criteria
    - The approach or implementation strategy
    - Dependencies or assumptions
    - Anything unclear in the task description

    Ask them now. Raise any concerns before starting work.

    ## Your Job

    Once clear on requirements:
    1. Implement exactly what the task specifies
    2. Write tests (following TDD)
    3. Verify implementation works
    4. Commit your work
    5. Self-review (see below)
    6. Report back

    Work from: [directory]

    While you work: If you encounter something unexpected or unclear, ask questions.
    It's always OK to pause and clarify. Don't guess or make assumptions.

    ## Before Reporting Back: Self-Review

    Review your work with fresh eyes:

    Completeness:
    - Did I fully implement everything in the spec?
    - Did I miss any requirements?
    - Are there edge cases I didn't handle?

    Quality:
    - Is this my best work?
    - Are names clear and accurate?
    - Is the code clean and maintainable?

    Discipline:
    - Did I avoid overbuilding (YAGNI)?
    - Did I only build what was requested?
    - Did I follow existing patterns in the codebase?

    Testing:
    - Do tests verify behavior (not just mock behavior)?
    - Did I follow TDD?
    - Are tests comprehensive?

    If you find issues during self-review, fix them before reporting.

    ## Report Format

    - What you implemented
    - What you tested and test results
    - Files changed
    - Self-review findings (if any)
    - Any issues or concerns
```

---

## Spec Compliance Reviewer Prompt Template

```
Task tool (general-purpose):
  description: "Review spec compliance for Task N"
  prompt: |
    You are reviewing whether an implementation matches its specification.

    ## What Was Requested

    [FULL TEXT of task requirements]

    ## What Implementer Claims They Built

    [From implementer's report]

    ## Do Not Trust the Report

    The implementer may have been optimistic. You MUST verify everything independently.

    DO NOT:
    - Take their word for what they implemented
    - Trust their claims about completeness
    - Accept their interpretation of requirements

    DO:
    - Read the actual code they wrote
    - Compare actual implementation to requirements line by line
    - Check for missing pieces they claimed to implement
    - Look for extra features they didn't mention

    ## Your Job

    Read the implementation code and verify:

    Missing requirements:
    - Did they implement everything that was requested?
    - Are there requirements they skipped or missed?
    - Did they claim something works but didn't actually implement it?

    Extra/unneeded work:
    - Did they build things that weren't requested?
    - Did they over-engineer or add unnecessary features?
    - Did they add "nice to haves" that weren't in spec?

    Misunderstandings:
    - Did they interpret requirements differently than intended?
    - Did they solve the wrong problem?

    Verify by reading code, not by trusting the report.

    Report:
    - ✅ Spec compliant (if everything matches after code inspection)
    - ❌ Issues found: [list specifically what's missing or extra, with file:line references]

    Candidate Findings (pass to stage 2 regardless of spec result):
    While reading the diff, record every code finding you notice — do not filter here.
    For each finding include:
    - file:line
    - what the issue is and why it matters
    - confidence: high | medium | low
    - severity: CRITICAL | MAJOR | MINOR | NIT
    If you find nothing, write: "No candidate findings."
```

---

## AC-vs-Test Anti-Patterns (spec-compliance flags)

When an implementation passes its tests but the tests themselves were bent to fit a gap, spec compliance is fake. Watch for these — each is a MAJOR finding because it masks a missing requirement behind a green suite:

- **Implementation gaps masked by test rewrites.** If the AC says "skip path X" and the test asserts "skip path Y" instead, the implementation is missing X — the agent worked around the gap by editing the test. Force the implementation change, not the test change.
- **Test asserts literal AC numbers/strings instead of behavior.** Hard-coding the exact value from the AC into the assertion (rather than deriving it) can pass while the logic that should produce it is absent. Verify the value is computed, not pasted.
- **Seeding return values ignored when spies/mocks are present.** When a test mocks a boundary, every setup call that seeds state (create, insert, add) MUST assert its return value. Otherwise silent seeding failures pass on canned mock data while the real store is empty — one assertion per seeding call closes the false-confidence gap.
- **Spy-on-the-subject boundary check.** Spying on / mocking the very method that the AC is about hollows the test. Mocking a boundary is legitimate when the bypassed behavior has its own coverage; it is not when the bypassed behavior IS the AC under review. If the AC is "search returns the right results" and the test mocks `search` → flag as MAJOR.

---

## Code Quality Reviewer Prompt Template

**Only dispatch after spec compliance passes.**

```
Task tool (code-reviewer):
  Use the pre-review-checklist.md template

  WHAT_WAS_IMPLEMENTED: [from implementer's report]
  PLAN_OR_REQUIREMENTS: Task N from [plan-file]
  BASE_SHA: [commit before task]
  HEAD_SHA: [current commit]
  DESCRIPTION: [task summary]
  CANDIDATE_FINDINGS: [paste the full "Candidate Findings" block from the stage-1 report]

  Your job as code quality reviewer:
  - Start from the candidate findings list. Apply the severity and escalation rules (SKILL.md Section 3) to decide which findings block merge.
  - Add any further findings you surface during your own quality pass.
  - Do not invent findings to fill a count — report only what you actually observe.

  Return: Strengths, Issues (Critical/Important/Minor), Assessment (Ready to merge? Yes/No/With fixes).
```

---

## Red Flags — Never Do These

- Skip spec compliance review
- Run code quality review before spec compliance passes
- Dispatch multiple implementation subagents in parallel (causes conflicts)
- Make subagent read plan file themselves (provide full text instead)
- Skip scene-setting context (subagent needs to know where task fits)
- Ignore subagent questions (answer before letting them proceed)
- Accept "close enough" on spec compliance (issues found = not done)
- Skip review loops (reviewer found issues = implementer fixes = review again)
- Let implementer self-review replace actual review (both are needed)
- Move to next task while either review has open issues

---

## Integration

This pattern works best when combined with:
- `using-git-worktrees` skill — isolate feature work on a clean branch first
- `verification-before-completion` skill — after all tasks complete, verify the full implementation
- `finishing-a-development-branch` skill — merge/PR/keep/discard decision after the full review passes
