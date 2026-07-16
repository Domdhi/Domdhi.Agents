# Pre-Review Checklist Reference

**Load this when:** completing a task, implementing a major feature, or before merging — to dispatch a code-reviewer subagent and verify work meets requirements.

---

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing a major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing a complex bug

---

## How to Request

**Step 1 — Get git SHAs:**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

**Step 2 — Dispatch code-reviewer subagent** using the template below.

**Step 3 — Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back with technical reasoning if reviewer is wrong

---

## Code Reviewer Subagent Prompt Template

```
Task tool (code-reviewer):
  description: "Review [WHAT_WAS_IMPLEMENTED]"
  prompt: |
    You are reviewing code changes for production readiness.

    ## What Was Implemented

    [DESCRIPTION]

    ## Requirements/Plan

    [PLAN_OR_REQUIREMENTS]

    ## Git Range to Review

    Base: [BASE_SHA]
    Head: [HEAD_SHA]

    git diff --stat [BASE_SHA]..[HEAD_SHA]
    git diff [BASE_SHA]..[HEAD_SHA]

    ## Review Checklist

    Code Quality:
    - Clean separation of concerns?
    - Proper error handling?
    - Type safety (if applicable)?
    - DRY principle followed?
    - Edge cases handled?

    Architecture:
    - Sound design decisions?
    - Scalability considerations?
    - Performance implications?
    - Security concerns?

    Testing:
    - Tests actually test logic (not mocks)?
    - Edge cases covered?
    - Integration tests where needed?
    - All tests passing?

    Requirements:
    - All plan requirements met?
    - Implementation matches spec?
    - No scope creep?
    - Breaking changes documented?

    Production Readiness:
    - Migration strategy (if schema changes)?
    - Backward compatibility considered?
    - Documentation complete?
    - No obvious bugs?

    ## Output Format

    ### Strengths
    [What's well done? Be specific.]

    ### Issues

    #### Critical (Must Fix)
    [Bugs, security issues, data loss risks, broken functionality]

    #### Important (Should Fix)
    [Architecture problems, missing features, poor error handling, test gaps]

    #### Minor (Nice to Have)
    [Code style, optimization opportunities, documentation improvements]

    For each issue:
    - File:line reference
    - What's wrong
    - Why it matters
    - How to fix (if not obvious)

    ### Recommendations
    [Improvements for code quality, architecture, or process]

    ### Assessment

    Ready to merge? [Yes/No/With fixes]
    Reasoning: [Technical assessment in 1-2 sentences]

    ## Critical Rules

    DO:
    - Categorize by actual severity (not everything is Critical)
    - Be specific (file:line, not vague)
    - Explain WHY issues matter
    - Acknowledge strengths
    - Give clear verdict
    - If code is clean and no issues found, say so — do NOT manufacture issues to meet a quota

    DON'T:
    - Say "looks good" without checking
    - Mark nitpicks as Critical
    - Give feedback on code you didn't review
    - Be vague ("improve error handling")
    - Avoid giving a clear verdict
    - Invent issues that don't exist
```

---

## Moved / Relocated Code — Verify It Still Works at the New Home

A diff that **moves** a pattern, rule, or regex between tiers/files (or refactors a matcher) is high-risk for a silent regression: the relocated code can stop matching its canonical target while looking fine in the diff. Don't assume a moved rule still fires.

- When a regex/pattern is moved or edited, confirm there is a **matcher test asserting it still matches the canonical command/input** it is meant to catch — test the form the tool emits *by default*, not a contrived variant. (e.g. a guardrail `Remove-Item .+-Recurse .+-Force` rule silently never matched the canonical single-space `Remove-Item foo -Recurse -Force`; it rode along through a tier-move with zero coverage.)
- When a rule moves between a **hard tier and a softer/escalatable tier**, verify the precedence is still correct — a hard-block invariant must not become reachable through a softer tier that happens to match the same input.

## Gated File Access — Verify the Write Path and the Read Gate Agree

A confidential file-serving feature can ship with the read-side authorizer fully correct and still be completely bypassed, because the write side stores the file somewhere the authorizer never checks. Two independently-correct pieces of code (an upload call site, an endpoint authorize delegate) can each look right in isolation and still leave a live access-control gap between them.

- **Trace where the uploader actually stores the bytes, then confirm that literal path is under the SAME configured base path the read-side authorizer checks** — don't accept "the authorizer looks correct" as sufficient. Grep both the upload call site and the authorizer for the config key they each resolve and confirm they're the same key, not just visually similar values.
- **Generic upload components have no per-entity subfolder by default.** A shared upload component typically writes to one fixed, generic base path, often served by a permissive/no-extra-authorization route for the wider app. A confidential feature that reuses a generic uploader without redirecting its target path silently lands files in the more-permissive tree.
- **A "download URL" that returns null is a signal, not just a bug.** If a gated download-link builder prefix-strips the gated base path and always returns `null`, that's often proof the file never landed there in the first place — investigate the write path before assuming it's merely a broken link.
- **A hand-crafted-path test on the authorizer alone does not prove the feature is safe.** A test that calls the authorizer with a synthetic path verifies the authorizer's logic but never proves a real upload reaches that path. For any new gated-file feature, require (or add) an end-to-end test: real upload → assert the resulting stored path is under the gated base path.

(Field-proven on an adopter project, 2026-07: config keys and the project's uploader/storage-mapping architecture live in that project's own skill — this section is the project-agnostic technique.)

## Red Flags — Never Do These

- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback without reasoning
- Wave through **moved/relocated** patterns without checking they still match at the new home (see above)

If reviewer is wrong: push back with technical reasoning, show code/tests that prove it works, request clarification.
