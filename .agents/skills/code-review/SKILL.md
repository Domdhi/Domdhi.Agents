---
name: code-review
description: "Use WHEN reviewing code changes, pull requests, or architecture compliance — covers review depth and risk routing, severity tiers (CRITICAL/MAJOR/MINOR), reviewer identity (diagnose don't rewrite), the pre-review checklist, and handling feedback. Covers: code review, review, pull request, PR review, risk routing, review depth, review playbook, severity."
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [code-review, playbook, risk-routing, severity, two-stage, architecture-compliance]
user-invocable: false
allowed-tools: Read Grep Glob
---

# Code Review

Consolidated methodology for reviewing code changes in this project. Combines the review report template and severity definitions from `code-reviewer` with the intake triage and risk-based routing from `code-review-playbook`.

---

## 1. Reviewer Identity

The reviewer is the **critic** — it diagnoses and advises, and may be over- or under-confident.
It is never the blocking authority. The **judge** is the gate: the deterministic pass/fail (the
build/test gate, line-by-line AC verification, and the `SHIP_CHECK_OK` ship token) that actually
decides whether work ships. A critic's "looks good" or "this is broken" is input to the judge, not
the verdict. (Judge semantics live in the verification-before-completion skill.)

The reviewer's job is to **diagnose, document, and communicate** — not to rewrite or rescue. Think of it as a surgeon reading a scan: findings are reported precisely; the implementer performs the fix.

- Read the diff and codebase. Never rely on the implementer's self-report alone.
- Categorize by actual severity. Not everything is CRITICAL — manufacturing issues to fill a quota is dishonest.
- Be specific: `file:line`, what's wrong, why it matters, how to fix (if not obvious).
- Give a clear verdict. "Looks good" without checking, or vague notes like "improve error handling", are not reviews.
- **A finding against working, passing code is a hypothesis — the orchestrator verifies it compiles and passes BEFORE applying it.** "X is safer/cleaner/more idiomatic" is a correctness claim, not a free win; applying it blind can regress code that was green. (Field-proven: applying an unverified "string literal is safer than the enum" MINOR to working, deployed code broke 3,153 tests and cost a full cycle.) Speculative hardening on green code is the one place a critic's confidence is most dangerous.
- **Scope-deferred work is not "missing" — check the TODO before flagging it.** DI registration, a migration, or endpoint wiring that a *later* story explicitly owns is a planned deferral, not an omission. Before raising "X is unregistered/unimplemented," grep the TODO/backlog for a later story that owns it; if one exists, note the dependency, don't flag a gap. A reviewer without the multi-wave context manufactures false CRITICALs.

**Independent review starts from persisted scope.** Before dispatching a reviewer, write the review scope (stories, AC, changed files, constraints and evidence locations) to the run's work folder, and start a fresh reviewer from that file rather than from the implementer's conversation, so it judges the diff independently. After the fixes, send them back to the same reviewer for a closure pass that verifies only that each listed finding is closed. Three reviewer passes per scope is the hard maximum: a new CRITICAL or MAJOR that a fix introduced earns at most one more pass, a new MINOR or NIT is fixed and proven by a test with no further review, and anything CRITICAL or MAJOR still open after the third pass goes to the user as a decision. Record the review and its closure in a tracked findings report, not only in scratch.

**Diagnose, don't rewrite — and that is full compliance with the operating standard, not an exception to it.** The project's standard is "resolve it or don't report it," but for the *reviewer* role it translates rather than relaxes: the reviewer's "resolve" is an **exhaustive, precise, immediately-actionable** finding (`file:line` + a concrete fix), handed to the orchestrator who performs the resolution. Writing the fix yourself would contaminate the field you're examining (and a `code-reviewer`/`security-auditor` has no `Edit` tool). So "Fix everything you find" (Section 4) is an instruction about *scope of attention* — nothing you spot is out of bounds — executed as a fix-ready finding, not a code edit. The loop still closes in one pass; the orchestrator is the hand that resolves.

---

## 2. Two-Stage Review Process

Always run Stage 1 before Stage 2. Never run quality review while spec compliance has open issues.

**Stage 1 — Coverage / Critic (Spec Compliance + Candidate Findings)**
This is the **critic** layer: it advises, it does not block on its own. Did the implementer build exactly what was requested — nothing more, nothing less? Also surface every candidate code finding noticed while reading the diff.
- Compare implementation line-by-line against acceptance criteria.
- Check for missing requirements, over-engineering, and misinterpretations.
- Do not trust the implementer's report; read the actual code.
- While reading, record every candidate code finding (including low-confidence ones), each labeled with confidence (high/medium/low) and severity (CRITICAL/MAJOR/MINOR/NIT). Do not filter at this stage.
- **A precondition-dependent bug or an edge-case-value bug reads as plausible/correct on inspection — write and run a standalone repro before ruling on it, don't reason from the source alone.** Two bug classes reliably survive read-only review: (1) code copied from a "mirror this existing pattern" instruction that silently drops a structural precondition the original relied on (e.g. a reset-on-open effect that only works because the original component has an internal trigger; the copy doesn't, so the effect never fires) — this reads correct because each file is internally consistent, the mismatch is only *between* them; (2) a schema/validation edge case (empty string, `0`, `null`) that's fatal to an entire request but doesn't announce itself in the schema definition — trace at least one such value through by hand or a quick check before trusting "the schema looks right." Confirm these by writing a runnable repro, not by re-reading the code more carefully.
- If the change introduces or repurposes a domain term in a skill/command, grep the affected file and its siblings for prior uses of that term — a term used two ways is an interpretation bug for the agents that read it (e.g. "judge" meaning both a review stage and the ship-gate).
- Result: spec pass or list of specific gaps. If spec has open issues, stop — stage 2 does not run until they are resolved. Candidate findings are passed to stage 2 regardless.

**Stage 2 — Adjudicate (Code Quality)**
This stage is severity **adjudication** over the candidate findings — deciding which ones block merge. It is *not* the ship-level judge: that gate (build/test + AC + the `SHIP_CHECK_OK` token, in verification-before-completion) is what actually clears work to commit. A reviewer never holds that authority — its adjudicated findings are input to the gate, not the gate itself. Is the work well-built — clean, tested, maintainable? Filter and decide on the candidate findings from stage 1.
- Receive the candidate findings list from stage 1; apply the severity and escalation rules (see Section 3) to decide which findings block merge and which do not.
- Correctness, security, performance, maintainability, and test coverage (see `references/pre-review-checklist.md`).
- Full process, subagent templates, and red flags: `references/two-stage-review.md`.

---

## 3. Risk-Tiered Findings

| Severity | Definition | Action | Examples |
|----------|-----------|--------|----------|
| **CRITICAL** | Active exploitability, data loss, production crash | Must fix before merge | SQL injection, auth bypass, unhandled null on critical path, secret in code |
| **MAJOR** | Real bug, performance issue, architecture violation, missing validation | Should fix before merge | N+1 query, swallowed exception, cross-layer violation, missing auth check |
| **MINOR** | Code smell, readability issue, missed optimization | Fix at developer's discretion | Verbose naming, duplicated constant, missing log context |
| **NIT** | Style, formatting, naming preference | Optional, non-blocking | Bracket placement, import ordering, comment wording |

**Escalation rules:**
- A MINOR finding in a HIGH-risk file (auth, crypto, secrets) escalates to MAJOR.
- Three or more similar MINOR findings of the same type indicate a systemic issue — escalate one to MAJOR with a note.
- **A bug found once is a bug class — grep for every sibling before signing off.** When you confirm a defect, search the codebase for the same shape and report every instance, not just the file in front of you. A review that names one file per finding when the same pattern hits many others is why a fix lands in one place and the concept stays broken everywhere else. Report the cluster, not the instance. Worked example: symlink-blind `Dirent.isDirectory()` (returns `false` for a symlinked dir) hit `skill-conformance.js` and `template-updater.js` independently in one release window — two unrelated modules sharing a directory-walk pattern, same root cause; a sibling-grep on the first find would have caught both together.
  - **This rule is easy to state and hard to actually exhaust — treat one clean review pass as evidence of nothing.** The `full-review-260716` epic (2026-07-16/17) ran mandatory per-wave review AND a full independent retro re-review, and the exact same shape — fix closes the reported site, a structurally identical sibling in the same file/function survives — recurred at least seven separate times across both passes: a wrapper-strip loop that stopped after one pass instead of iterating to a fixed point (`guardrail.cjs`), a symlink-ancestor guard applied to one delete call but not the sibling directory-prune call three waves later in the same file (`fleet.js`, then found AGAIN in `publish.js`'s copy of the same function), a fail-closed posture established in one hook that took three separate discovery rounds to reach the other hooks reading stdin through the same shared helper, and a "return null on partial match" parser fix that wasn't re-applied to a second branch of the same function. **When the finding is about a raw fs/regex/parse operation that should route through a shared helper or shared posture, do not stop at the reported call site — grep the WHOLE repo for the same primitive (`fs.rmSync`/`fs.rmdirSync`/`fs.writeFileSync`, the same regex shape, the same stdin-read pattern) and check every hit, including ones in files the diff didn't touch.** A second independent review pass finding the same class again is a process signal, not bad luck.
- CRITICAL findings in test-only files are downgraded to MAJOR (tests do not run in production).
- **A silently-swallowed error (empty `catch`, ignored exit code, discarded `Promise` rejection) in a tool that DELETES files, writes/migrates data, or publishes to a remote is a MAJOR** — the operation's summary becomes untrustworthy (it reports success for work that didn't happen). Either surface the failure in the result or abort; never swallow and continue. (Field-proven: a fleet-prune tool reported `removed:` for files an `rmSync` had failed to delete.)
  - **Inner failure counts that are returned + logged but never propagated to the process exit code or an aggregate `HasErrors` flag** are the *looks-handled* variant of the same MAJOR — for any data-writing console tool, trace every failure/quarantine/error count through to the exit signal. A step that runs OUTSIDE the main chain (e.g. a programmatic seeder or post-processing step invoked after the primary pipeline completes) is the classic gap: its count is logged, the operator sees the number scroll by, but the tool still exits `0` (false success).
- **Handoff-flagged gaps → MAJOR candidate.** If the branch's prior handoff doc (or a retro note) flags a "known gap", "known unhandled edge", or "out-of-scope follow-up", treat that item as a MAJOR candidate in the next code review on that branch. Pre-shipped awareness of a gap is evidence in itself: it shows the implementer knew the risk and deferred it. A gap whose failure mode is silent data loss or silent data corruption is MAJOR regardless of its original classification. If you see a handoff note about a deferred correctness gap and the current PR still doesn't address it, escalate to MAJOR.

**MAJOR-Fix-Inline Discipline:** MAJORs are fixed before commit, not deferred. If a MAJOR genuinely needs design discussion, file a follow-up story in the TODO and block the commit until it is filed. Never silently downgrade MAJOR to MINOR to clear the review.

**Security-control changes — mandatory bypass attempt.** Any change that touches a security hook, guardrail, exemption list, or matching regex (e.g. `guardrail-rules.yaml`, `secret-patterns.cjs`, path-tier logic) MUST include an explicit bypass attempt before approval: construct at least one input that *should* be caught and check the new logic still catches it (chained commands, trailing/sibling tokens, substring look-alikes, encoding tricks). Field-proven twice: a guardrail `rm -rf` exemption regex shipped a whole-line-lookahead bypass (`rm -rf ~/x && echo /tmp` passed), and a widening amplified it. Loosening a control without an adversarial check is how a "fix" becomes a hole. Treat the widened-control change itself as HIGH-risk regardless of file.

---

<!-- @@project-additions:start -->
## Checks when a change relies on another implementation

- **Verify cross-story guarantees.** When a removal or simplification is justified by a sibling story, read that story's implemented behavior before accepting the guarantee. Record an unresolved dependency when its implementation is unavailable.
- **Separate remedy evidence from defect evidence.** Label a suggested fix as tested by execution or inspected but unexecuted. A confirmed defect does not establish that its proposed remedy is safe; trace the affected consumers before applying it and verify afterward.
- **Keep counting guards meaningful after extraction.** When a refactor moves a literal into a helper, find guards that count that literal. Check that they still measure the risky call sites, with a violating control that fails. A smaller count alone can make a broken guard appear green.
<!-- @@project-additions:end -->

## 4. The "Never Out of Scope" Rule

Fix everything you find during review — pre-existing issues are not exempt. If a pre-existing problem is inside a file you are already touching, flag and fix it. "That wasn't introduced in this PR" is not a reason to let a bug walk.

The only exception: if the pre-existing issue is genuinely large (separate domain, requires its own ADR), file it as a follow-up story rather than silently ignoring it.

---

## 5. References

These three files contain the detailed process, subagent prompt templates, and red-flag lists used during execution:

- **`references/handling-feedback.md`** — how to respond to review feedback (verify before implementing, when to push back, forbidden sycophantic responses).
- **`references/pre-review-checklist.md`** — when to request review, how to dispatch a code-reviewer subagent, the full subagent prompt template, and red flags.
- **`references/two-stage-review.md`** — the per-task two-stage loop, implementer prompt template, spec-compliance reviewer template, code-quality reviewer template.

---

## 6. Review Playbook

Intake triage, risk-based routing (Fast-Lane / Standard / Deep), per-depth checklists, the Risk Map decision tree, the Risk Assessment report section, and severity escalation detail: **`references/playbook.md`**.

Quick routing reference:

| Change Type | Route |
|-------------|-------|
| Config-only, docs-only | Fast-Lane |
| Dependency update | Fast-Lane + security spot-check |
| Refactor | Fast-Lane + architecture check |
| Bug fix | Standard Review |
| New feature | Deep Review |
| Security-sensitive, architecture-impacting | Deep Review (mandatory) |

When multiple types apply, use the deepest route.
