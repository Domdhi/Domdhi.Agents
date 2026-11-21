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

The reviewer is the **critic**: it diagnoses and advises, and may be over- or under-confident. It is never the blocking authority. The **judge** is the gate: the deterministic pass/fail (the build/test gate, line-by-line AC verification, and the `SHIP_CHECK_OK` ship token) that decides whether work ships. A critic's "looks good" or "this is broken" is input to the judge, not the verdict. (Judge semantics live in the verification-before-completion skill.)

The reviewer's job is to diagnose, document and communicate, not to rewrite or rescue. Findings are reported precisely; the implementer performs the fix.

- Read the diff and codebase. Do not rely on the implementer's self-report alone.
- Categorize by actual severity. Not everything is CRITICAL; manufacturing issues to fill a quota is dishonest.
- Be specific: `file:line`, what is wrong, why it matters, how to fix it (if not obvious).
- Give a clear verdict. "Looks good" without checking, or vague notes like "improve error handling", are not reviews.
- **A finding against working, passing code is a hypothesis.** The orchestrator verifies it compiles and passes before applying it. "X is safer/cleaner/more idiomatic" is a correctness claim, not a free win. (An unverified "string literal is safer than the enum" MINOR applied to deployed code broke 3,153 tests.)
- **Scope-deferred work is not "missing".** DI registration, a migration or endpoint wiring that a later story explicitly owns is a planned deferral. Before raising "X is unregistered/unimplemented," grep the TODO/backlog for a later story that owns it; if one exists, note the dependency instead of flagging a gap.

**Independent review starts from persisted scope.** Before dispatching a reviewer, write the review scope (stories, AC, changed files, constraints and evidence locations) to the run's work folder, and start a fresh reviewer from that file rather than from the implementer's conversation, so it judges the diff independently. Independence means a different prior, not just a different agent: a reviewer handed the implementer's framing, an earlier review's conclusions or the plan's assumptions shares their blind spots, and two such reviews agreeing count as one. Give it the scope and the code, not earlier verdicts.

**When to review** (per wave, mid-epic and final, and what can wait) is in [references/review-cadence.md](references/review-cadence.md), shared by `/todo`, `/do` and `/run-todo`. This section covers a single review.

**One review pass, then done.** A scope gets exactly one review pass: one fresh `code-reviewer`, plus `security-auditor` in the same pass when firm line 2 of the review cadence applies (money, authentication or access; the reference defines access). There is no closure pass, no re-review of fixes and no second reviewer. Scope means the thing reviewed: the mid-epic and final reviews are separate scopes (cross-wave seams and drift, deferred items, the run's acceptance criteria), not re-reviews of fixes. The review is done when all three hold:
1. every finding is fixed, or is recorded as not fixed with a one-line reason. The reasons are: the finding is wrong; it is out of scope and has a named follow-up; it is a coverage-only `TEST-GAP` on a `standard`-tier scope; or it is polish that [references/review-cadence.md](references/review-cadence.md) lets wait for the scheduled mid-epic or final review, which fixes it. That last reason is for a per-wave review only: the final review has nothing later to defer to, so nothing leaves the run except for the first three reasons;
2. each fix is proven by a test or a command that would fail without it;
3. the gate is green after the last fix.

**Label coverage-only findings `TEST-GAP`.** A finding whose only demand is another test (a missing edge case, another input, more branch coverage) with no failing input or defect shown is a `TEST-GAP`. On a `standard`-tier scope (a wave's tier is its highest story tier) it is recorded, not written, at every review including the mid-epic and final: more tests there cost more than the unshown defect risks. This is the one finding that never gets fixed. It is fixed like any other finding on a `deep` (high-stakes) scope, when it sits on the surface that made a story high-stakes, when the reviewer shows a failing input, or when the existing test is wrong or false-green (those are not coverage-only). Do not demand exact-value pins on tuning, copy, layout or other non-contract values; ask for an invariant or bound.

Then commit. A new problem found while fixing is fixed and tested, not reviewed again. Do not dispatch another reviewer to confirm fixes or to look for more. If a fix needs a real design decision, ask the user once and carry on. Record the review in a tracked findings report, not only in scratch.

**Diagnose, don't rewrite: this is full compliance with the operating standard.** The standard is "resolve it or don't report it," and for the reviewer role it translates rather than relaxes: the reviewer's "resolve" is an exhaustive, precise, immediately actionable finding (`file:line` plus a concrete fix), handed to the orchestrator who performs the resolution. Writing the fix would contaminate the field being examined, and a `code-reviewer`/`security-auditor` has no `Edit` tool. "Fix everything you find" (Section 4) is therefore a scope-of-attention rule: nothing you spot is out of bounds, and it is executed as a fix-ready finding. The loop still closes in one pass.

---

## 2. Two-Stage Review Process

Run Stage 1 before Stage 2. Do not run quality review while spec compliance has open issues.

**Stage 1: Coverage / Critic (spec compliance + candidate findings).** This is the critic layer: it advises, it does not block on its own. Did the implementer build exactly what was requested, nothing more and nothing less? Also surface every candidate code finding noticed while reading the diff.
- Compare the implementation line by line against acceptance criteria.
- Check for missing requirements, over-engineering and misinterpretations.
- Read the actual code, not the implementer's report.
- Record every candidate code finding (including low-confidence ones), each labeled with confidence (high/medium/low) and severity (CRITICAL/MAJOR/MINOR/NIT). Do not filter at this stage.
- **A precondition-dependent bug or an edge-case-value bug reads as plausible on inspection, so write and run a standalone repro before ruling on it.** Two bug classes reliably survive read-only review: (1) code copied from a "mirror this existing pattern" instruction that silently drops a structural precondition the original relied on (for example a reset-on-open effect that works only because the original component has an internal trigger the copy lacks); it reads correct because each file is internally consistent and the mismatch is only between them; (2) a schema/validation edge case (empty string, `0`, `null`) that is fatal to a whole request but does not announce itself in the schema. Confirm these with a runnable repro, not by re-reading the code.
- If the change introduces or repurposes a domain term in a skill or command, grep the affected file and its siblings for prior uses of that term. A term used two ways is an interpretation bug for the agents that read it (for example "judge" meaning both a review stage and the ship gate).
- Result: spec pass, or a list of specific gaps. If the spec has open issues, stop: stage 2 does not run until they are resolved. Candidate findings pass to stage 2 regardless.

**Stage 2: Adjudicate (code quality).** This stage is severity adjudication over the candidate findings: deciding which ones block merge. It is not the ship-level judge. That gate (build/test + AC + the `SHIP_CHECK_OK` token, in verification-before-completion) clears work to commit, and a reviewer never holds that authority. Is the work well built: clean, tested, maintainable?
- Apply the severity and escalation rules (Section 3) to the stage 1 candidates to decide which block merge and which do not.
- Review correctness, security, performance, maintainability and test coverage (see `references/pre-review-checklist.md`).
- Full process, subagent templates and red flags: `references/two-stage-review.md`.

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
- Three or more similar MINOR findings of the same type indicate a systemic issue: escalate one to MAJOR with a note.
- **A bug found once is a bug class: grep for every sibling before signing off.** When you confirm a defect, search the codebase for the same shape and report every instance, not just the file in front of you. Report the cluster, not the instance. (Symlink-blind `Dirent.isDirectory()` hit `skill-conformance.js` and `template-updater.js` independently in one release window; a sibling grep on the first find would have caught both.)
  - **Do the sibling grep inside the one review pass; it replaces any second pass.** In the `full-review-260716` epic, the same shape recurred at least seven times across the per-wave and retro reviews: a fix closed the reported site while a structurally identical sibling in the same file or function survived (a wrapper-strip loop in `guardrail.cjs` that did not iterate to a fixed point; a symlink-ancestor guard on one delete call but not the sibling prune call in `fleet.js`, then again in `publish.js`; fail-closed posture reached one hook at a time though all read stdin through the same shared helper; a "return null on partial match" fix not re-applied to a second branch). When the finding is about a raw fs/regex/parse operation that should route through a shared helper or shared posture, grep the whole repo for the same primitive (`fs.rmSync`/`fs.rmdirSync`/`fs.writeFileSync`, the same regex shape, the same stdin-read pattern) and check every hit, including files the diff did not touch.
- CRITICAL findings in test-only files are downgraded to MAJOR (tests do not run in production).
- **A silently swallowed error (empty `catch`, ignored exit code, discarded `Promise` rejection) in a tool that deletes files, writes or migrates data, or publishes to a remote is a MAJOR**: the operation's summary becomes untrustworthy because it reports success for work that did not happen. Surface the failure in the result or abort. (A fleet-prune tool reported `removed:` for files an `rmSync` had failed to delete.)
  - **Inner failure counts that are returned and logged but never propagated to the process exit code or an aggregate `HasErrors` flag** are the looks-handled variant of the same MAJOR. For any data-writing console tool, trace every failure, quarantine or error count through to the exit signal. A step that runs outside the main chain (a seeder or post-processing step invoked after the primary pipeline) is the classic gap: its count is logged, but the tool still exits `0`.
- **Handoff-flagged gaps are MAJOR candidates.** If the branch's prior handoff doc (or a retro note) flags a "known gap", "known unhandled edge" or "out-of-scope follow-up", treat that item as a MAJOR candidate in the next code review on that branch: pre-shipped awareness shows the implementer knew the risk and deferred it. A gap whose failure mode is silent data loss or corruption is MAJOR regardless of its original classification.

**MAJOR-Fix-Inline Discipline:** MAJORs are fixed before commit, not deferred. If a MAJOR genuinely needs design discussion, file a follow-up story in the TODO and block the commit until it is filed. Do not silently downgrade a MAJOR to MINOR to clear the review.

**Security-control changes need a bypass attempt.** Any change that touches a security hook, guardrail, exemption list or matching regex (for example `guardrail-rules.yaml`, `secret-patterns.cjs`, `secret-engine.toml`, path-tier logic) includes an explicit bypass attempt before approval: construct at least one input that should be caught and check the new logic still catches it (chained commands, trailing or sibling tokens, substring look-alikes, encoding tricks). A guardrail `rm -rf` exemption regex shipped a whole-line-lookahead bypass (`rm -rf ~/x && echo /tmp` passed) and a widening amplified it. Treat the widened-control change itself as HIGH-risk regardless of file.

**Secret-engine bypass checks.** For a change to `secret-engine.toml`, the wrapper or an allow rule, also try: a key beside an interpolation, a key prefix glued to a variable, a key concatenated with a call, a key on the line after a `betterleaks:allow` marker (the marker covers its own line only), a key in a markdown fence, a key in a test file (named providers still apply), a key in a path the engine's built-in prefilter would skip (`vendor/`, `node_modules/`, an image name), and an engine that is missing, fails, times out or returns bad JSON (the Write hook and the commit scan must fail closed). A line carrying `betterleaks:allow` beside a key-shaped value is a finding to question, never a pass. Do not add an allowlist entry or marker just to make a fixture pass; the entry must name one exact documented value.

---

<!-- @@project-additions:start -->
## Checks when a change relies on another implementation

- **Verify cross-story guarantees.** When a removal or simplification is justified by a sibling story, read that story's implemented behavior before accepting the guarantee. Record an unresolved dependency when its implementation is unavailable.
- **Separate remedy evidence from defect evidence.** Label a suggested fix as tested by execution or inspected but unexecuted. A confirmed defect does not establish that its proposed remedy is safe; trace the affected consumers before applying it and verify afterward.
- **Keep counting guards meaningful after extraction.** When a refactor moves a literal into a helper, find guards that count that literal. Check that they still measure the risky call sites, with a violating control that fails. A smaller count alone can make a broken guard appear green.
<!-- @@project-additions:end -->

## 4. Pre-existing Issues Are In Scope

Fix everything you find during review; pre-existing issues are not exempt. If a pre-existing problem is inside a file you are already touching, flag and fix it. "That wasn't introduced in this PR" is not a reason to let a bug stand.

The only exception: a pre-existing issue that is genuinely large (separate domain, needs its own ADR) is filed as a follow-up story.

---

## 5. References

Detailed process, subagent prompt templates and red-flag lists:

- **`references/handling-feedback.md`**: how to respond to review feedback (verify before implementing, when to push back, sycophantic responses to avoid).
- **`references/pre-review-checklist.md`**: when to request review, how to dispatch a code-reviewer subagent, the full subagent prompt template, and red flags.
- **`references/two-stage-review.md`**: the per-task two-stage loop, implementer prompt template, spec-compliance reviewer template, code-quality reviewer template.

---

## 6. Review Playbook

Intake triage, risk-based routing (Fast-Lane / Standard / Deep), per-depth checklists, the Risk Map decision tree, the Risk Assessment report section, and the high-risk defect classes that build, tests and grep miss: **`references/playbook.md`**.

Quick routing reference. Depth follows the surface (see [references/review-cadence.md](references/review-cadence.md)); this table is the fallback when nothing more specific is known:

| Change Type | Route |
|-------------|-------|
| Config-only, docs-only | Fast-Lane |
| Dependency update | Fast-Lane + security spot-check |
| Refactor | Fast-Lane + architecture check |
| Bug fix | Standard Review |
| New feature | Deep Review |
| Security-sensitive, architecture-impacting | Deep Review (mandatory) |

When multiple types apply, use the deepest route.
