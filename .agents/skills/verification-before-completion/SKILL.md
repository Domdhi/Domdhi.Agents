---
name: verification-before-completion
description: "Use WHEN about to claim work is complete, fixed, or passing — BEFORE committing or creating PRs; blocks any success claim until a fresh verification command has been run and its output read"
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [quality, verification, workflow, testing]
user-invocable: false
allowed-tools: Read Bash
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is dishonesty, not efficiency.

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim
6. EMIT THE SHIP TOKEN: emit the literal `SHIP_CHECK_OK` once — and only once —
   BOTH of these hold in this message:
     (a) a fresh verification command ran THIS message and its output was read, AND
     (b) every acceptance-criteria bullet is checked off (verified, not assumed).
   The token is the deterministic signal that the work passed the gate. Downstream
   steps (commit, wave-close) look for this exact literal before they proceed.

Skip any step = lying, not verifying
```

### Emitting `SHIP_CHECK_OK`

`SHIP_CHECK_OK` is a textual contract, not a parser: emit the bare literal once the two
preconditions above are both true. It means "fresh verification passed AND all AC are
checked." Do not emit it speculatively, and do not emit it when verification was skipped
or any AC is unchecked.

**Audited override — `SHIP_CHECK_SKIP: <reason>`.** When verification genuinely cannot
run (no local runner, CI-only matrix job, manual/UI-only AC), emit `SHIP_CHECK_SKIP: <reason>`
instead — the literal followed by a one-line reason. This is the one path that lets work
proceed without `SHIP_CHECK_OK`, and it is audited: the reason is the record of why the
gate was bypassed. Use it for true cannot-verify cases, never as a shortcut to skip a
verification that could have run.

**Consumers.** The emit contract lives here; the commands that check for the token are `/do` (Step 8c, per-task precondition for commit) and `/run-todo` (per-wave ship-token gate before the wave commit). Keep this list current when a new command starts gating on the token, so the full producer→consumer contract is findable from one place.

## Critic vs Judge

Two distinct layers govern whether work ships. Keep them separate:

- **Critic** — the **review** layer. It advises and diagnoses; it can be wrong, over-confident,
  or under-confident. Code-reviewer findings are critic output: signal to weigh, not a verdict
  that blocks on its own.
- **Judge** — the **gate** layer. It is the deterministic pass/fail that actually blocks: the
  build/test gate (exit code), the line-by-line AC verification, and the `SHIP_CHECK_OK` ship
  token that records both passed. A critic can advise "this looks fine"; only the judge's
  evidence lets the work ship.

The token belongs to the judge: it is emitted by evidence, not by opinion.

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |
| Symbol exists (enum/icon/method/path) | Grep finds its definition | "Confirmed present", remembering it |
| Edit to existing component is safe | Grep tests that render/construct it — all pass | The component's own test passes |
| Symbol/file safe to delete | Grep all consumers (src/tests/js/barrels): none | The AC says "delete X" |
| Files I claimed to create exist | Re-read each created file: present + correct content | "I wrote it", no write error shown |
| Guard/hook/gate/release path is safe | Adversarial test: malformed input, a thrown exception, and a failed sub-step each → fails CLOSED **and** exits non-zero | The happy-path test passed |

## Resolve, Don't Defer — the other half of the gate

Verification finds problems. The job is not done when you've *found* them — it's done when they're *fixed and re-verified*. **Resolve it or don't report it.**

- A failing test, a broken parser, a typo, dead code, a flaky path — fix it in the same pass. Diagnose → fix → re-run the verification → report what you did.
- A report that ends in "want me to fix it?" for an obviously-worthwhile fix is an **incomplete job**, not a courtesy.
- "Pre-existing" and "unrelated" describe a bug's *origin* — they are not a license to leave it broken. Broken is broken.
- If a fix exposes a new failure, follow the thread to green. Completing every task down to the last detail is how quality is built — perfection is not an accident.
- **Only** stop to ask on a genuine fork: mutually-exclusive approaches, an irreversible/outward action, or scope that materially expands the task. A clear bug is never a fork.

### Autonomous & batch commands: fix-in-pass, surface forks ONLY

Autonomous / auto-approved commands — `/sweep`, `/retro`, `/run-todo`, `/do` — are bound by this standard at full strength. Their default is **resolve, not report**:

- **Every finding, NIT-level and up, gets resolved in the same pass, then re-verified — no skipping.** There is no "MINOR/NIT logged for the user" tier and no "too small to bother" tier. A report line that says "consider running X", "you should fix Y", or "Z still needs attention" for something the command *could have done itself* is a standard violation, not a courtesy. Don't hand the human a to-do list of things the command was capable of resolving. Perfect means perfect: fix the nit too.
- **The only carve-out is SCOPE, not severity.** Fix everything within what the pass is examining; don't *expand scope* to churn unrelated already-merged code the review isn't looking at (a security review of auth code doesn't reformat an untouched module), and don't review generated/vendored artifacts (lockfiles, `dist/`, `*.min.*`, snapshots). A genuinely unrelated pre-existing issue *outside* the pass's scope may be surfaced as a residual follow-up. But an in-scope nit is fixed like anything else — "already-merged" and "pre-existing" describe a finding's origin, never a license to leave it.
- **Role translation — fixing vs read-only.** Acting passes that *edit* (`/sweep`, `/retro` resolution, `/run-todo`, `/do`) **fix** every in-scope finding nits-and-up in-pass. Read-only reviews that only report (`/review:code-review`, a `security-auditor`/`code-reviewer` dispatch) **surface** every finding nits-and-up — never filter nits out of the findings — so the acting pass or human resolves them all. Both honor "no skipping," each in its nature.
- **A human-facing report section in an autonomous command is for GENUINE FORKS ONLY** — mutually-exclusive approaches the user must choose between, irreversible/outward actions (push, publish, delete), work that genuinely cannot be auto-resolved (needs a credential, an external decision, a human judgment call), or a phase that halted. Nothing else earns a line.
- **Default posture is autonomous.** Assume the user wants the run to resolve everything it can without pausing. Reserve interruption for the forks above. "Almost always, autonomous" is the rule — perfectionism means *being* awesome by default, not narrating a punch-list of what awesome would require.

This is the same standard, applied to the command layer: the canonical statement is above; commands enforce it by auto-resolving and keeping their report sections fork-only.

## The Operating Standard — two role translations

This skill is the canonical home of the project's operating standard (the mission at the top of `CLAUDE.md`). "Resolve it or don't report it" is literal for roles that act and figurative for roles that only report — but it **binds both**; it never relaxes for either.

- **Acting roles** — any agent that writes code or docs (`general-purpose`, `architect`, `doc-writer`, `project-planner`, `qa-engineer`, `playwright`, `product-strategist`, `ux-designer`, `shadow`): fix what you touch, resolve to green, leave the file cleaner than you found it, and verify before you claim done. The gate above is yours, literally.
- **Report-only roles** — read-only or write-scoped-to-reviews (`code-reviewer`, `security-auditor`, `Explore`): the "extra mile" is **exhaustive, precise, immediately-actionable** findings — no hand-waving ("looks fine"), no truncation, every finding carries `file:line` and a concrete fix. You do **not** write the fix — that would violate your write scope — you hand the orchestrator a fix-ready report so resolution still happens in one pass. Read-only-by-design is how you comply with the standard, never a license to dead-end in a report.
- **The orchestrator** (main session) closes the loop: when a report-only agent surfaces an obviously-worthwhile fix, the orchestrator resolves it rather than deferring. This is where "resolve it or don't report it" bites hardest — a report that ends in "want me to fix it?" for an obvious fix is an incomplete job.

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Acceptance evidence is tracked.** The facts, citations, gate output and review evidence a completion claim relies on go into tracked documents (the TODO, the plan or a findings record). Ignored scratch, such as `docs/.output/.state/`, is same-checkout working space and never the only authority; `git add` refuses an ignored path, so evidence staged from there silently never lands.

**Discovery is not execution.** An installed skill, a listed command or a loaded file proves availability, not that a workflow ran. A completion claim cites that run's own gate output, AC table and commit.

**Tests:**
```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

**Fail-closed / surface-non-zero (guards, gates, hooks, release pipelines):**
```
✅ On ANY unexpected error or failed sub-step → block/abort AND exit non-zero → test it (throw an exception, pass malformed input, fail a sub-step)
❌ try/catch that swallows and continues; a sub-step failure printed but not folded into the exit code; "the happy path works"
```
A guard that only WARNS is not a guard, and a pipeline that prints an error but exits 0 is a false-green. Fixing one instance does not inoculate the class — after closing a fail-open, grep its sibling call sites for the same shape. (Evidence: 2026-07-09 sweep found the secret-scanner exit-1 fix reappearing as an uncaught-exception fail-open, plus a false-green `fleet release` and a crash-after-success `metrics report` — same class, three mechanisms. See memory `fail-open-recurs-as-a-class-not-an-instance`.)

**Fix-site enumeration (any guard/validation/data-model fix):**
```
✅ Fix the named site → enumerate EVERY entry point on the runtime surface (siblings in the same file, shadow/duplicate implementations in hooks/CLIs, twin writers/readers of the same shared file) → confirm the fix reaches each → "done"
❌ Fix the sites the finding (or the tests) named; ship green
```
The fix must reach the runtime surface, not just the named function. (Evidence: the 2026-07-16 remediation epic hit this class in ALL THREE waves — inbox siblings of guarded CRUD verbs, a hook's shadow `loadRules()` that never called the fixed `_lib`, a telemetry file's twin in-session writer left on the old path — and green unit tests caught none of them; only adversarial review with independent repros did. See memories `shadow-loader-defeats-lib-security-fix`, `worktree-root-retrofit-must-sweep-all-callsites`.)

**Merge/parser fixes (mergers, syncers, format parsers):**
```
✅ Unit tests pass → dogfood against one real, messy input (an actual adopter checkout, a real log, real divergent content) → observe output → "done"
❌ "All fixture tests pass" on synthetic fixtures alone
```
For code whose job is reconciling real-world messy content, passing unit tests is necessary but not sufficient — synthetic fixtures encode the author's assumptions, and the gap lives outside them. (Evidence: skill-merger's anchored-fence rewrite `a0cb9c6` passed its full test suite, then produced Form-1 duplication bugs on its first real application to an adopter project — `8715e9d`.)

## Why This Matters

False completion claims produce compounding failures:

- **Trust destruction** — Repeated unverified success claims make every subsequent claim suspect, requiring the reviewer to independently verify everything the agent says. This eliminates the value of delegation.
- **Crash-path shipping** — Undefined functions, missing imports, and broken contract assumptions reach review or production when the agent claims success without running the code.
- **AC gap masking** — When tests are shaped to pass rather than to verify the acceptance criterion, the gap between "tests pass" and "requirement met" is invisible until integration or production.
- **Rework cycles** — Time spent on redirecting after a false completion claim exceeds the time the verification step would have taken. False completion is not a time savings — it is a time debt.

Verification gates exist to make the agent's claims checkable. A claim without evidence is not a completion — it is a hypothesis.

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

## The Bottom Line

**No shortcuts for verification.**

Run the command. Read the output. THEN claim the result.

This is non-negotiable.
