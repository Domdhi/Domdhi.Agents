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

Claiming work is complete without verification is dishonesty, not efficiency. Evidence comes before claims.

```
No completion claim without fresh verification evidence
```

A claim that something passes needs a verification command run in this message.

## The Gate Function

Before claiming any status or expressing satisfaction:

1. Identify the command that proves the claim.
2. Run the full command, fresh.
3. Read the full output, check the exit code, count failures.
4. Compare the output to the claim. If it does not confirm it, state the actual status with evidence. If it does, state the claim with the evidence.
5. Only then make the claim.
6. Emit the ship token: write the literal `SHIP_CHECK_OK` once, and only when both hold in this message: (a) a fresh verification command ran this message and its output was read, and (b) every acceptance-criteria bullet is checked off (verified, not assumed). Downstream steps (commit, wave-close) look for this exact literal before they proceed.

### Emitting `SHIP_CHECK_OK`

`SHIP_CHECK_OK` is a textual contract, not a parser: it means "fresh verification passed and all AC are checked." Do not emit it speculatively, and do not emit it when verification was skipped or any AC is unchecked.

**Audited override: `SHIP_CHECK_SKIP: <reason>`.** When verification genuinely cannot run (no local runner, CI-only matrix job, manual or UI-only AC), emit the literal followed by a one-line reason instead. It is the one path that lets work proceed without `SHIP_CHECK_OK`, and the reason is the audit record of why the gate was bypassed. Use it only when verification could not run, never to skip one that could have.

**Consumers.** The emit contract lives here; the commands that check for the token are `/do` (Step 8c, per-task precondition for commit) and `/run-todo` (per-wave ship-token gate before the wave commit). Keep this list current when a new command starts gating on the token.

`ship-check.js` is the tool enforcement behind `SHIP_CHECK_OK` and `SHIP_CHECK_SKIP`, enforced when the commit goes through `commit.js --ship-check`, which both commands always pass: it refuses the commit unless the sealed evidence verifies (or the audited skip applies). No hook forces the flag, so a plain `commit.js` skips the check; passing it is part of those workflows.

## Critic vs Judge

Two layers govern whether work ships:

- **Critic** (the review layer) advises and diagnoses, and can be wrong or over- or under-confident. Code-reviewer findings are critic output: signal to weigh, not a verdict that blocks on its own.
- **Judge** (the gate layer) is the deterministic pass/fail that blocks: the build/test gate (exit code), line-by-line AC verification, and the `SHIP_CHECK_OK` token that records both passed.

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
| Edit to existing component is safe | Grep tests that render/construct it: all pass | The component's own test passes |
| Symbol/file safe to delete | Grep all consumers (src/tests/js/barrels): none | The AC says "delete X" |
| Files I claimed to create exist | Re-read each created file: present + correct content | "I wrote it", no write error shown |
| Fix is in the build I tested | The artifact that ran carries the edit: rebuilt after the change, or a timestamp, hash or marker check | A green run from output built before the edit (a stale binary fakes a green) |
| This test catches the bug | Inject exactly that one defect, see this test go red for that reason, restore, rebuild, green | A predicted list of reds; several defects injected at once |
| The check covers this change | Name the gate that ran the check and show its output | A guard that runs only at a later step (CI, deploy, nightly): it is silent at the earlier gate |
| The gate failed | The gate's verdict line says FAILED | A non-zero exit alone: KILLED and TIMED OUT runs say nothing about the code |
| Story or epic gated and closed | A gate log line showing exit 0 on the named commit | A checklist tick, or a status header written while the gate was still running |
| A reuse or skip decision is safe | Proof the inputs match the reused result (commit, config, environment); unknown means run | "Nothing relevant changed", or an inputs check that could not be read |
| A guard or lint rule covers the class | One test per axis the class varies on: case, separator, derived form | One test on the literal that triggered the rule |
| A sweep is complete | State the unit counted (files, call sites, rows, entry points) and that it is the unit the defect lives in | "All 40 files checked" when the defect lives per call site |
| A delegated agent's work is lost | Its status or output shows it failed or stopped | No report yet: a late report is not a lost one, so check before redoing its work |
| Guard/hook/gate/release path is safe | Adversarial test: malformed input, a thrown exception, and a failed sub-step each fail closed and exit non-zero | The happy-path test passed |

## Resolve, Don't Defer

Verification finds problems. The job is done when they are fixed and re-verified. **Resolve it or don't report it.**

- A failing test, a broken parser, a typo, dead code, a flaky path: fix it in the same pass. Diagnose, fix, re-run the verification, report what you did.
- A report that ends in "want me to fix it?" for an obviously worthwhile fix is an incomplete job.
- "Pre-existing" and "unrelated" describe a bug's origin, not a license to leave it broken.
- If a fix exposes a new failure, follow the thread to green.
- Stop to ask only on a genuine fork: mutually-exclusive approaches, an irreversible or outward action, or scope that materially expands the task. A clear bug is never a fork.

### Autonomous and batch commands: fix in the pass, surface forks only

Autonomous commands (`/run-todo`, `/do`) are bound by this standard at full strength. Their default is resolve, not report:

- Every finding, nit and up, gets resolved and re-verified. In the pass, by default; `/run-todo` may defer polish to its scheduled mid-epic or final review (`code-review` skill, `references/review-cadence.md`), which then fixes it, so nothing is left unresolved at the end of the run. There is no "logged for the user" tier and no "too small to bother" tier. A report line such as "consider running X" or "Z still needs attention" for something the command could have done itself is a standard violation.
- **One approved exception: coverage-only `TEST-GAP` findings** (another test demanded, no defect or failing input shown) on a `standard`-tier story are recorded, not written, at every review (`code-review` skill, "Label coverage-only findings"). A gap on a high-stakes surface, a shown failing input, or a wrong or false-green existing test is not coverage-only and is fixed.
- The only carve-out is scope, not severity. Fix everything within what the pass is examining; do not expand into unrelated already-merged code the review is not looking at, and do not review generated or vendored artifacts (lockfiles, `dist/`, `*.min.*`, snapshots). A genuinely unrelated pre-existing issue outside the pass's scope may be surfaced as a residual follow-up. An in-scope nit is fixed like anything else.
- **Fixing vs read-only.** Acting passes that edit (`/run-todo`, `/do`) fix every in-scope finding nit and up (`/run-todo` by the end of the run, as above; `/do` in its one pass). Read-only reviews (`/review:code-review`, a `security-auditor` or `code-reviewer` dispatch) surface every finding nit and up, never filtering nits out, so the acting pass or the human resolves them all.
- A human-facing report section in an autonomous command is for genuine forks only: mutually-exclusive approaches the user must choose between, irreversible or outward actions (push, publish, delete), work that cannot be auto-resolved (needs a credential, an external decision, a human judgment call), or a phase that halted.
- The default posture is autonomous: resolve everything that can be resolved, and interrupt only for the forks above.

## The Operating Standard: two role translations

This skill is the canonical home of the project's operating standard (the mission at the top of `CLAUDE.md`). "Resolve it or don't report it" is literal for roles that act and figurative for roles that only report. It binds both.

- **Acting roles** (any agent that writes code or docs: `general-purpose`, `architect`, `doc-writer`, `project-planner`, `qa-engineer`, `playwright`, `product-strategist`, `ux-designer`, `shadow`): fix what you touch, resolve to green, leave the file cleaner than you found it, and verify before you claim done. The gate above applies literally.
- **Report-only roles** (read-only or write-scoped to reviews: `code-reviewer`, `security-auditor`, `Explore`): the extra mile is exhaustive, precise, immediately actionable findings. No hand-waving ("looks fine"), no truncation, and every finding carries `file:line` and a concrete fix. You do not write the fix, which would exceed your write scope; you hand the orchestrator a fix-ready report so resolution still happens in one pass.
- **The orchestrator** (main session) closes the loop: when a report-only agent surfaces an obviously worthwhile fix, the orchestrator resolves it rather than deferring.

## Red Flags: STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!")
- About to commit, push or open a PR without verification
- Trusting agent success reports
- Relying on partial verification
- Wanting the work over
- Any wording that implies success without a verification run

Rationalizations such as "I'm confident", "just this once", "the linter passed" (a linter is not a compiler) or "the agent said success" are not evidence. Run the check.

## Key Patterns

**Acceptance evidence is tracked.** The facts, citations, gate output and review evidence a completion claim relies on go into tracked documents (the TODO, the plan or a findings record). Ignored scratch, such as `docs/.output/.state/`, is same-checkout working space and never the only authority; `git add` refuses an ignored path, so evidence staged from there silently never lands.

**Discovery is not execution.** An installed skill, a listed command or a loaded file proves availability, not that a workflow ran. A completion claim cites that run's own gate output, AC table and commit.

**Tests.** Run the test command, see "34/34 pass", then say "all tests pass". "Should pass now" and "looks correct" are not claims.

**Regression tests (red-green).** Write the test, run it (pass), revert the fix, run it (it must fail), restore, run it (pass). "I've written a regression test" without the red-green cycle is unverified.

**Build.** Run the build and see exit 0. A passing linter does not check compilation.

**Requirements.** Re-read the plan, create a checklist, verify each item, report gaps or completion. "Tests pass, phase complete" is not a requirements check.

**Agent delegation.** When an agent reports success, check the VCS diff, verify the changes, and report the actual state.

**Fail-closed / surface-non-zero (guards, gates, hooks, release pipelines).** On any unexpected error or failed sub-step, block or abort and exit non-zero, and test it: throw an exception, pass malformed input, fail a sub-step. A guard that only warns is not a guard, and a pipeline that prints an error but exits 0 is a false green. A try/catch that swallows and continues, or a sub-step failure printed but not folded into the exit code, is the failure to look for. Fixing one instance does not inoculate the class: after closing a fail-open, grep its sibling call sites for the same shape. (Evidence: the 2026-07-09 sweep found the secret-scanner exit-1 fix reappearing as an uncaught-exception fail-open, a false-green `fleet release` and a crash-after-success `metrics report`. See memory `fail-open-recurs-as-a-class-not-an-instance`.)

**Fix-site enumeration (any guard, validation or data-model fix).** Fix the named site, then enumerate every entry point on the runtime surface (siblings in the same file, shadow or duplicate implementations in hooks and CLIs, twin writers and readers of the same shared file) and confirm the fix reaches each. Fixing only the sites the finding or the tests named leaves the runtime surface exposed. (Evidence: the 2026-07-16 remediation epic hit this in all three waves: inbox siblings of guarded CRUD verbs, a hook's shadow `loadRules()` that never called the fixed `_lib`, a telemetry file's twin writer left on the old path. Green unit tests caught none; adversarial review with independent repros did. See memories `shadow-loader-defeats-lib-security-fix`, `worktree-root-retrofit-must-sweep-all-callsites`.)

**Merge/parser fixes (mergers, syncers, format parsers).** Passing unit tests is necessary but not sufficient: dogfood against one real, messy input (an actual adopter checkout, a real log, real divergent content) and observe the output. Synthetic fixtures encode the author's assumptions, and the gap lives outside them. (Evidence: skill-merger's anchored-fence rewrite `a0cb9c6` passed its full suite, then produced Form-1 duplication bugs on its first real application to an adopter project, fixed in `8715e9d`.)

## Why This Matters

- **Trust.** Repeated unverified success claims make every later claim suspect and erase the value of delegation.
- **Crash-path shipping.** Undefined functions, missing imports and broken contract assumptions reach review or production when success is claimed without running the code.
- **AC gap masking.** Tests shaped to pass rather than to verify the acceptance criterion hide the gap between "tests pass" and "requirement met".
- **Rework.** Redirecting after a false completion claim costs more than the verification step would have.

A claim without evidence is a hypothesis, not a completion.

## When To Apply

Before any success or completion claim, any expression of satisfaction, committing, PR creation, task completion, moving to the next task, or delegating to agents, including paraphrases and implied success.

Run the command, read the output, then claim the result.
