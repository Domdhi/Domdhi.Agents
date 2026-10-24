---
description: Investigate a bug with root cause analysis before applying fixes
argument-hint: [error message, file path, or "last failure"]
---

<!-- Generated from .agents/skills/investigate/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# /investigate — Root Cause Investigation

Structured debugging command. Diagnoses failures with root cause analysis before attempting fixes. Four phases: Investigate, Analyze, Hypothesize, Implement.

**Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

**Operating standard — investigation ends at a fix verified green, not at a writeup.** A confirmed root cause with an obvious fix is *resolved here* (Phase 6: smallest targeted fix + gate), then handed back — never dead-ended as a "want me to fix it?" report. "Resolve it or don't report it." The one legitimate read-only exit is the **3-Strike Rule** (Phase 5): three refuted hypotheses is a genuine fork — stop and ask. That is diagnosis-first *by design*, not a doctrine violation. (Commit is still the user's call — Phase 6 resolves but does not commit.) Canonical: `.claude/skills/verification-before-completion/SKILL.md`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js investigate
```

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Gather Failure Context

```
IF INPUT is "last failure" or empty:
  - Read the most recent damage-control output (check git log for "damage-control" or read docs/.output/ for recent failure logs)
  - Read git diff HEAD~1 for what changed last
IF INPUT is an error message:
  - Use the error text as the starting point
IF INPUT is a file path:
  - Read the file, identify the failure point
```

Also gather:
- `git log --oneline -10` — what changed recently
- `git status --short` — current state
- Read recent agent issues from `docs/.output/evolution/agents/` — the newest few day-scoped files (`{YYYY-MM-DD}.md`, sorted descending). Fall back to the legacy flat `docs/.output/evolution/agents.md` if the folder is absent (pre-rotation projects). <!-- path-lint:keep -->

### 2. Investigate — Map the Blast Radius

**Scope the affected area before reading code:**

1. Identify the failing module/directory from the error
2. List all files in that module: `Glob: {module}/**/*`
3. Read the error-producing file(s) fully
4. Trace the call chain: what calls this code? What does it call?
5. Check `git blame` on the failing lines — who changed this last and when?

**Output:** A clear statement of what's failing, where, and what the expected behavior should be.

### 3. Analyze — Find Patterns

Search for similar failures and related context:

1. Search for the error message or key terms: `Grep` across the codebase
2. Check if this error has occurred before: `git log --grep="{error keyword}" --oneline`
3. Read test files for the affected module — what's tested and what isn't?
4. Check for common failure patterns:
   - Race condition (concurrent writes, async timing)
   - Null/undefined propagation (missing guard at boundary)
   - State corruption (shared mutable state, stale cache)
   - Integration failure (contract mismatch between modules)
   - Configuration drift (env var, config file, dependency version)
   - Stale cache or stale import

### 4. Hypothesize — Rank Possible Causes

Generate 1-3 hypotheses, ranked by likelihood:

```markdown
### Hypothesis 1 (most likely): {description}
- **Evidence:** {what points to this cause}
- **Test command:** {specific command that would confirm or refute}
- **Expected if true:** {what the test command would show}
- **Expected if false:** {what it would show instead}

### Hypothesis 2: {description}
...
```

**Rules:**
- Each hypothesis must have a concrete test command
- Hypotheses must be falsifiable — "it might be anything" is not a hypothesis
- Order by evidence strength, not by ease of fix

### 5. Test Hypotheses — Confirm Root Cause

Execute the test command for Hypothesis 1:
- If confirmed → proceed to Phase 6 with this root cause
- If refuted → execute test for Hypothesis 2
- Continue until a hypothesis is confirmed or all are refuted

**3-Strike Rule:** After 3 refuted hypotheses, STOP. Present all evidence gathered so far and ask the user for guidance. Do NOT guess further.

```markdown
## Investigation Stalled

I tested 3 hypotheses and none were confirmed:

1. {Hypothesis 1}: REFUTED — {evidence}
2. {Hypothesis 2}: REFUTED — {evidence}
3. {Hypothesis 3}: REFUTED — {evidence}

### What I Know
- {Fact 1 from investigation}
- {Fact 2}

### What I Don't Know
- {Gap 1}
- {Gap 2}

What would you like me to investigate next?
```

### 6. Fix — Single Targeted Change

Once root cause is confirmed:

1. Make the **smallest possible fix** that addresses the root cause
2. Verify the fix resolves the original error
3. Run the build+test gate to confirm no regressions
4. Do NOT commit — the user decides whether to commit the investigation fix or roll it into a larger change

### 7. Report

Write investigation log to `docs/.output/findings/investigations/{YYMMDD-HHMM}-{slug}.md`:

```markdown
## Investigation: {error summary}

**Date:** {YYYY-MM-DD}
**Root Cause:** {confirmed cause}
**Fix Applied:** {Y/N}

### Error Context
{Original error, affected files, blast radius}

### Hypotheses Tested
| # | Hypothesis | Test | Result |
|---|-----------|------|--------|
| 1 | {description} | {command} | {Confirmed/Refuted} |

### Root Cause Analysis
{Detailed explanation of why the failure occurred}

### Fix
{What was changed and why, or "No fix — user to decide"}

### Prevention
{What would prevent this class of failure in the future — test to add, guard to insert, pattern to follow}
```

Print a summary to the conversation:

```markdown
## Investigation Complete

**Root cause:** {one sentence}
**Fix:** {applied / not applied — user to decide}
**Prevention:** {recommendation}
**Log:** docs/.output/findings/investigations/{YYMMDD-HHMM}-{slug}.md
```
