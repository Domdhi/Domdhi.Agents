# Handling Code Review Feedback Reference

**Load this when:** receiving code review feedback, before implementing suggestions — especially if feedback seems unclear or technically questionable.

---

## Core Principle

Code review requires technical evaluation, not emotional performance.

Verify before implementing. Ask before assuming. Technical correctness over social comfort.

---

## The Response Pattern

```
WHEN receiving code review feedback:

1. READ: Complete feedback without reacting
2. UNDERSTAND: Restate requirement in own words (or ask)
3. VERIFY: Check against codebase reality
4. EVALUATE: Technically sound for THIS codebase?
5. RESPOND: Technical acknowledgment or reasoned pushback
6. IMPLEMENT: One item at a time, test each
```

---

## Forbidden Responses

**NEVER:**
- "You're absolutely right!" (sycophantic)
- "Great point!" / "Excellent feedback!" (performative)
- "Let me implement that now" (before verification)
- Any expression of gratitude ("Thanks for...", "Thank you for...")

**INSTEAD:**
- Restate the technical requirement
- Ask clarifying questions
- Push back with technical reasoning if wrong
- Just start working (actions > words)

---

## Handling Unclear Feedback

```
IF any item is unclear:
  STOP — do not implement anything yet
  ASK for clarification on ALL unclear items

WHY: Items may be related. Partial understanding = wrong implementation.
```

**Example:**
```
Reviewer says "Fix 1-6"
You understand 1,2,3,6. Unclear on 4,5.

BAD: Implement 1,2,3,6 now, ask about 4,5 later
GOOD: "I understand items 1,2,3,6. Need clarification on 4 and 5 before proceeding."
```

---

## Source-Specific Handling

### From the user (your human partner)
- Trusted — implement after understanding
- Still ask if scope unclear
- No performative agreement
- Skip to action or technical acknowledgment

### From external reviewers / subagents
```
BEFORE implementing:
  1. Check: Technically correct for THIS codebase?
  2. Check: Breaks existing functionality?
  3. Check: Reason for current implementation?
  4. Check: Works on all platforms/versions?
  5. Check: Does reviewer understand full context?

IF suggestion seems wrong:
  Push back with technical reasoning

IF can't easily verify:
  Say so: "I can't verify this without [X]. Should I [investigate/ask/proceed]?"

IF conflicts with prior architectural decisions:
  Stop and discuss with user first
```

---

## YAGNI Check for "Professional" Features

```
IF reviewer suggests "implementing properly":
  grep codebase for actual usage

  IF unused: "This endpoint isn't called. Remove it (YAGNI)?"
  IF used: Then implement properly
```

---

## Implementation Order (Multi-Item Feedback)

```
1. Clarify anything unclear FIRST
2. Then implement in this order:
   - Blocking issues (breaks, security)
   - Simple fixes (typos, imports)
   - Complex fixes (refactoring, logic)
3. Test each fix individually
4. Verify no regressions
```

---

## When To Push Back

Push back when:
- Suggestion breaks existing functionality
- Reviewer lacks full context
- Violates YAGNI (unused feature)
- Technically incorrect for this stack
- Legacy/compatibility reasons exist
- Conflicts with architectural decisions

**How to push back:**
- Use technical reasoning, not defensiveness
- Ask specific questions
- Reference working tests/code
- Involve user if architectural

---

## Acknowledging Correct Feedback

```
GOOD:
  "Fixed. [Brief description of what changed]"
  "Good catch — [specific issue]. Fixed in [location]."
  [Just fix it and show in the code]

BAD:
  "You're absolutely right!"
  "Great point!"
  "Thanks for catching that!"
```

Actions speak. Just fix it. The code itself shows you heard the feedback.

---

## Correcting Your Pushback (When You Were Wrong)

```
GOOD:
  "You were right — I checked [X] and it does [Y]. Implementing now."
  "Verified this and you're correct. My initial understanding was wrong because [reason]. Fixing."

BAD:
  Long apology
  Defending why you pushed back
  Over-explaining
```

State the correction factually and move on.

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Performative agreement | State requirement or just act |
| Blind implementation | Verify against codebase first |
| Batch without testing | One at a time, test each |
| Assuming reviewer is right | Check if it breaks things |
| Avoiding pushback | Technical correctness > comfort |
| Partial implementation | Clarify all items first |
| Can't verify, proceed anyway | State limitation, ask for direction |
