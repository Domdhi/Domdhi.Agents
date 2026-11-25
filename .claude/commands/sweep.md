---
description: Autonomous post-work maintenance sweep — code review → retro (+ doc-drift check) → implement recommendations → promote → optimize agents → defrag → health (memory + .claude/ templates audit) → timeline refresh. One command, auto-approved, report at end.
argument-hint: "[PR range / epic names — e.g. '109-128' or 'Auth,Billing,Search'] [--review-scope high-risk|systemic|all] [--gated] [--skip 1,4]"
---

<!-- Generated from .agents/skills/sweep/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Maintenance Sweep

Run the whole post-work maintenance lifecycle as one autonomous pass: review the merged work, learn from it, apply what was learned, re-align the agents, and clean up. It orchestrates what are otherwise ten interactive commands (`/review:code-review`, `/review:check-sync`, `/retro`, `/review:promote-memories`, `/review:optimize-agents`, `/review:evolve-skills`, `/review:memory-defrag`, `/review:memory-health`, `/review:check-templates`, `/review:timeline`) without per-proposal Accept/Reject prompts. Use it after a batch of work (a string of merged PRs, a finished epic, a sprint). A good sweep leaves every finding it can resolve resolved, the memory store tidier than it found it, and a report that names only the decisions that are really the owner's.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill`. Log the invocation first so fleet analytics see human-driven runs (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js sweep
```

## Order of phases

```
1. Code review      → findings feed the retro
2. Retro (+check-sync) → work + review findings + doc drift → Recommendations + System Improvements
3. Implement recs   → auto-apply agent/skill/command fixes + doc-drift fixes + write new memories  ← creates the pile
4. Promote          → auto-promote above-threshold concepts → skills / CLAUDE.md
5. Optimize agents  → re-align agents with codebase + new memories + retro findings
   5b. Evolve skills → the measured propose-only cycle: draft, differential, stage on an auto/ branch  ← self-improvement
6. Defrag           → LAST memory op: merge/clean the now-GROWN store              ← the cleanup
7. Health & integrity → verify: memory lint/decay + check-templates (.claude/ wiring) + timeline refresh
```

The order carries the logic. `check-sync` runs inside the retro because its findings are retro input and its fixes are Phase 3 work. Defrag runs last because Phases 2 to 5 write new memories, and defragging before they land means defragging twice; it removes overlap, so success is "overlaps merged and new memories landed", not "every category is small". Categories have no size cap, so Phases 2 and 3 write memories straight in; use the inbox only for drafts that need review, and Phase 6 processes it. `check-templates` runs in Phase 7 so it validates the sweep's own edits, and the timeline refresh just reflects the commits the sweep made.

## Autonomy contract (overrides the sub-commands)

Everything is auto-approved. The interactive gates in `/review:promote-memories` (per candidate) and `/review:memory-defrag` (per proposal) are suspended: the sweep applies every proposal that clears its threshold and logs what it did. The owner reviews the result (the final report and the per-phase commits), not each step.

These still halt or skip:
- A phase agent reports a CRITICAL finding that would corrupt the store (for example a merge that loses an evidence anchor): skip that one operation, log it, continue.
- A build/test gate fails after an auto-applied code change in Phase 3: stop, report, leave the rest unrun.
- `--gated` was passed: pause between phases.

The sweep's own damage is resolved in-pass (the operating standard: `.agents/skills/verification-before-completion/SKILL.md`). An edit from Phase 3 or 5 that breaks skill conformance, orphans a skill or breaks a wiring reference is fixed and re-verified before the final report (Phase 7b), not logged. Pre-existing issues unrelated to the sweep are surfaced as residual follow-ups; do not churn already-merged code the sweep is not examining.

## Execution notes

- Run every phase command from the repo root with absolute or repo-root-relative script paths and `git -C <repo-root>`. A stray `cd` into a subdirectory persists across Bash calls and breaks later `node .claude/core/*` and `git` calls.
- `doc-writer` and review agents have no Bash. The main agent gathers all git stats (commit count, files, +/-, date range) and passes them inline in the dispatch prompt; it owns every git, gate and node call.
- Promote cohesive clusters. When many candidates clear the threshold, promote the largest cohesive cluster (same skill or home) as one block and leave scattered singletons, especially ones already in ADRs or CLAUDE.md, for manual review.
- `git merge-base --is-ancestor` is fooled by squash-merges; use `git cherry -v origin/main HEAD` to find commits already upstream before branching or cherry-picking.
- Tell every reviewer to skip generated or vendored artifacts (lockfiles, `dist/`, `*.min.*`, migration scaffolding, snapshots): sanity-check intent only.
- Background agents often go idle without delivering their report. On an idle notification with no findings, `SendMessage` a "deliver your full findings now" nudge before anything else, and budget one nudge round for every phase that fans out agents. The work is done; only delivery failed, so do not re-dispatch first.

## Variables

INPUT: $ARGUMENTS, an optional scope hint:
- A PR range (`109-128`): resolve to merge commits via `git log --oneline main`, group into themes for review, infer epics for the retro.
- A comma-separated epic list (`Auth,Billing,Search`): one retro per epic; derive the review scope from each epic's PRs.
- Empty: the most recent completed epic (per `docs/work/backlog.md`) plus the commits since the last sweep marker.

Flags:
- `--review-scope <high-risk|systemic|all>`: review depth. Default `high-risk`: only themes that change money, authentication or access (review-cadence firm line 2) or data integrity, the cheapest high-return review of merged code. `systemic` adds every other product theme; `all` also adds infra/CI and doc-only changes.
- `--gated`: auto-apply within each phase but pause between phases. Default is fully autonomous.
- `--single-commit`: squash all phase work into one commit at the end instead of per-phase commits.
- `--skip <phases>`: comma-separated phase numbers to skip (`--skip 1` skips code review).

## Pre-flight

1. Confirm code exists (`src/**/*` or the project's source root). If the project is still unspecialized, stop and suggest `/review:specialize`.
2. Capture the BEFORE numbers for the final report:
   ```bash
   node .claude/core/memory-manager.js report | grep -E '"total_memories"|"count"'
   node .claude/core/memory-manager.js lint | grep '"score"'
   ```
3. Resolve scope from INPUT (themes and epics).
4. Compute the run stamp once with `date +%y%m%d-%H%M` and reuse it for every artifact the sweep writes, so one run's files sort together and a same-day re-run never clobbers an earlier one. When resuming a dead sweep, reuse the stamp of today's most recent `*-sweep.md` that has an incomplete Phase Log. Write the sweep plan to `docs/.output/findings/reviews/{YYMMDD-HHMM}-sweep.md` with a `## Phase Log`; it is the durable resume point, and phases already marked `[x]` are skipped on resume.

**Runtime and verification.** In an adopter, the Phase 3 gate (`gate.js`) runs the application's own build and test commands and never the Domdhi.Agents toolkit suite, including after the agent, skill and command edits this sweep makes; in Domdhi.Agents itself it runs the toolkit's Node build and Vitest suite. In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments and dispatch roles as `.agents/adapters/codex/execution.md` describes. Discovery alone (an installed skill, a listed command or a loaded file) never proves a phase ran: mark a phase `[x]` and claim completion only from its written report, the gate output and the commit hash recorded in the Phase Log.

---

## Phase 1 — Code Review

Review already-merged work in parallel by theme, following `.agents/skills/code-review/references/review-cadence.md`: group by seam so cross-story problems are seen together, judge each finding by what leaving it would cost, and look harder where a mistake costs money, data or access. The sweep is that cadence's final review of finished work; there is no interactive verdict step.

1. Derive the scope from `git log --name-only` over the sweep window, not from memory of what was worked on. Run `node .claude/core/review-coverage.js {window-start}..HEAD` first: it lists the window's commits that touch high-risk paths (auth, money, access, secrets; keywords overridable in `.agents/config/review-coverage.json`) and that no report in `docs/.output/findings/reviews/` cites by hash or file. Those commits are the default make-up review themes, ahead of everything else: work that landed outside a planned run (a direct commit, a follow-up fix batch) is the work most likely to have had no review. Then group the remaining changed paths and the in-scope commits into themes (auth, data, API, UI, infra/CI). Skip pure-infra/CI and doc-only changes unless `--review-scope all`.
2. Before dispatching, read the window's per-epic retros for a named-but-undelivered review gap ("never delivered", "not independently re-verified", "went idle without reporting", "shipped via Path A"). That surface was built and never independently reviewed. Close it this sweep: fold the theme into the dispatch as a targeted make-up review, or record it in this sweep's retro as a named open risk with the reason it could not be covered. A retro naming its own coverage gap is the highest-yield input a sweep gets (one such gap sat a full interval and the next sweep found three MAJOR cross-tenant write defects in exactly those files).
3. Dispatch one `code-reviewer` per theme in parallel (background is fine). Omit `model:` so each runs on the `standard` default; sweep is broad maintenance, not a high-stakes gate. Escalate a theme to `model: "opus"` when it touches a HIGH-risk-tier path (security, auth, data integrity, migrations). A theme that changes money, authentication or access also gets a `security-auditor` review (review-cadence firm line 2); every review scope includes such themes, so the default scope never skips them. Each reviewer gets the merge commits, diffs via `git diff <hash>^1 <hash>` (fallback `^2`), the instruction to skip generated code, and, for a theme tied to a specific application area, the project reference paths and verified project constraints. Reviewers auto-load the `code-review` skill; do not paste the rubric. They return a CRITICAL/MAJOR/MINOR/NIT findings table.
4. Consolidate into `docs/.output/findings/reviews/{YYMMDD-HHMM}-code-review.md`.
5. Commit (unless `--single-commit`): `docs: /sweep p1 — code review, {N} findings ({C}C/{M}M/{m}m)`.
6. Append the findings summary to the Phase Log; the retro consumes it.

## Phase 2 — Retro

Reuses `/retro` as if invoked with `--skip-review`: Phase 1 already ran the review, so feed its findings in instead of reviewing again. One retro per epic in scope (or one consolidated retro for a single PR range with no clear epic split).

1. In the main agent, gather git stats for the epic's commits, the TODO Execution Log, work-doc plans, telemetry (`docs/.output/.state/telemetry/command-usage.jsonl` if present) and the Phase 1 findings (they populate the retro's *Code Review Findings* section).
2. Run `/review:check-sync` for doc drift and capture the findings.
3. Dispatch `doc-writer` per the retro template to write `docs/.output/findings/reviews/retro-{epic-slug}.md`. Include the output-boundary instruction verbatim ("Your ONLY output is the retro markdown… Do NOT write memories…"); the main agent owns memory extraction in Phase 3.
4. Commit each retro: `docs: /sweep p2 — retro {epic}`.
5. Append each retro's `## Recommendations` and `## System Improvements` tables to the Phase Log; Phase 3 implements them.

## Phase 3 — Implement Recommendations

Turn the retro from a document into changes.

1. System Improvements, one row at a time, the `Agent:`, `Skill:` and `Command:` rows before the `Memory:` rows and before step 2 (memory writes dirty the tracked tree under `docs/.output/.memory/`, and `skill-evolution.js apply --mode apply` needs a clean one). A skill or role prompt is the system's own behavior (Owner Decision 11): a behavior edit never lands in this pass without an eval, and only a typo, stale-pointer or pinned-text fix skips it. The code classifies the edit, never the caller (see "Skill edits" below):
   - `Agent: …`: a typo, stale-pointer or pinned-text fix is edited directly in the named canonical `.agents/roles/*.md` (a legacy native source only when no canonical counterpart exists). A role behavior edit has no verdict path yet: stage it as a proposal (below) and do not edit it; broad re-alignment is Phase 5's job.
   - `Skill: …`: a behavior edit takes the verdict path (`skill-evolution.js apply`, below), never a direct edit; only a typo, stale-pointer or pinned-text fix takes the side door. In an adopter, project-specific additions to a template skill must use a project-additions sentinel, created if absent: a new section at the end goes under `<!-- @@project-additions -->`; a bullet inside an existing section goes in an anchored `<!-- @@project-additions:start -->`/`:end` fence. A plain edit to template prose is clobbered on the next sync (see `skill-authoring`).
   - `Command: …`: the workflow lives in its skill directory (`.agents/skills/*/references/workflow.md`), so the `Skill:` rule applies; after an accepted edit render the generated command and update its registry metadata.
   - `Memory: …`: create or boost the memory (after every skill and agent row above).

   Skill edits (propose-only). For each `Skill:` and `Command:` row, snapshot the live skill directory into `docs/.output/evolution/skills/{date}/{skill}-workspace/skill-snapshot/` and write the edited files to `candidate/` beside it (an overlay of changed files; nothing is edited in place), then ask the code which class the delta is:
   ```bash
   node .claude/core/skill-evolution.js apply <skill> --run <workspace> --route side-door
   ```
   Exit 0 means every changed line is a typo fix, a stale-pointer fix (the old path is gone, the new one exists) or a pinned-text restore (the new line is already in a test or in the file's history at the base commit; you cannot list or assert a pin); `kinds` names which. Exit 1 with `failedStep: side-door` is a behavior edit: do not apply it. Stage it as a proposal in `docs/.output/evolution/skills/{date}/proposals.md` (the skill, the rec, the candidate path) for `/review:evolve-skills`, whose differential and `verdict` decide it, and which applies an accepted one through `skill-evolution.js apply <skill> --run <workspace> --mode apply --branch auto/... --candidate-sha256 ...` once its evaluation is bound (`skill-evolution.js bind`).
   **What an adopter can and cannot do.** The verdict route needs the `skill-regress` harness and a dev and holdout eval suite per skill, which only the toolkit workshop has; an adopter can stage a proposal but cannot measure it. Skills the improvement loop reserves (`RESERVED_TARGETS` in `.agents/core/_lib/improvement-scope.js`: the loop's own driver and judge chain) are owner-edit only everywhere. In an adopter, an owner-approved skill change lands as an owner-applied project-additions fence (the sentinels above), recorded as an owner edit; a general lesson is also sent upstream through `/intake` so the workshop can land it in the shipped text. Say which route each staged proposal takes in `proposals.md`. A project-owned skill that exists only under `.claude/skills/` or `.codex/skills/` (no `.agents/skills/` source) is outside both routes, and the helper refuses it by name: fix a typo or stale pointer in it by a direct edit, verified like any other Phase 3 fix, and stage a behavior edit to it as a proposal for its owner.
   Phase 3 stays propose-only for skills: the command above writes nothing. Apply a side-door fix only when the sweep request explicitly authorizes applying skill fixes; then re-run it with `--mode apply --branch auto/sweep-{date}-{skill} --candidate-sha256 {candidateSha256 from the first run}`. The workspace stays where it is, untracked under `docs/.output/evolution/`: the helper leaves exactly that path out of its clean-tree check, scope judgement and restore. The delta lands uncommitted on that local branch after the same drift, scope, render, conformance and gate steps as the verdict route, and any failure restores the tree. Commit the printed `files` on that branch through `commit.js`, switch back to the sweep's branch and leave the merge to the owner. Never push.
2. Memory extraction: for every reusable pattern the retro surfaced and every learning in the review findings worth keeping, run `node .claude/core/memory-manager.js create <category> <id> '<content-json>'` with an `importance` (1–5) in the content per the `session-handoff` skill.
3. Fix every code-review finding, CRITICAL down to NIT, in this pass (`verification-before-completion`, "Autonomous and batch commands"). The only findings left unfixed are the three reasons in the `code-review` skill ("One review pass, then done"): wrong, out of scope with a named follow-up, or a coverage-only `TEST-GAP` on a `standard` scope. Dispatch a `general-purpose` agent for anything beyond a trivial edit, batching related small fixes. When a fix touches a file the guardrail walls off from subagents (`subagentReadOnlyPaths` in the guardrail rules), say so in the brief up front: the agent edits tests and docs in place and returns a unified patch for each walled source, and the Main Agent reviews, applies and tests the patch. Do not have the agent work on a scratch copy instead: the wall matches the path suffix, so a copy under another directory is walled too. The orchestrator then runs `node .claude/core/gate.js test`; agents never build or test. If the gate fails, stop the sweep and report. The only limit is scope, not severity: no churn in unrelated code the sweep is not examining, and no review of generated artifacts.
4. Commit: `feat: /sweep p3 — applied {N} retro recs, {M} memories staged, {K} fixes`.

Phase 3 applies the retro's specific, named improvements; Phase 5 does the broad codebase-to-agent re-alignment. Do not redo Phase 3's edits in Phase 5.

## Phase 4 — Promote Memories

Reuses `/review:promote-memories` in auto-approve mode.

1. `node .claude/core/memory-promoter.js scan --top 15`.
2. For each candidate with promotion score >= 0.9 and decayed confidence >= 0.7 (a high bar, since this writes into skills and CLAUDE.md unattended), resolve the promotion to an existing canonical shared target (decisions to existing architecture or skill guidance, patterns to the relevant knowledge source, constraints to the existing template or reference, workflows to the canonical role body), then `node .claude/core/memory-promoter.js mark <slug> <target>`. Project decisions stay project-owned; generated projections and root runtime instructions are not shared-behavior targets.
3. List candidates below the threshold in the report as manual-review promotion candidates; surface them, do not apply them.
4. Commit: `docs: /sweep p4 — promoted {N} concepts`.

## Phase 5 — Optimize Agents

Reuses `/review:optimize-agents --fix`.

1. Dispatch `architect` to scan the codebase for the detected stack and structure map.
2. Compare each canonical `.agents/roles/*.md` `## Project Context` (legacy native only without a canonical equivalent) and classify it CURRENT / DRIFTED / MISSING.
3. Keep intentionally portable template roles unspecialized. Inject proven patterns (confidence >= 0.7), this sweep's retro findings and the day-scoped `docs/.output/evolution/agents/{date}.md` issues into DRIFTED and MISSING agents (idempotent replace).
4. Dispatch `code-reviewer` for the skill-effectiveness audit (ACTIVE / NOT_USED / gaps).
5. Write `docs/.output/findings/reviews/{YYMMDD-HHMM}-agent-optimization.md`.
6. Commit: `docs: /sweep p5 — agent re-alignment ({N} agents updated)`.

## Phase 5b — Evolve Skills (the propose-only cycle)

Runs `/review:evolve-skills --auto`, after Phase 5 (so it sees fresh promotions and re-alignment) and before Phase 7b (so the templates audit validates anything staged). `--auto` is the headless improvement cycle defined in that workflow's "The `--auto` cycle" section: intake, the top eligible candidate drafted by the orchestrator, the differential (`skill-regress.js run` on the dev and holdout suites, then `verdict`), and staging on a local `auto/evolve-{skill}-{date}` branch with a ledger entry. The differential always runs: it is the falsifier, and a draft with no measured delta is not a proposal. This phase therefore does not stage a draft that was only conformance-checked, and there is no sweep-only "no differential" tier.

It stays propose-only: skill bodies are the system's own brain, so the cycle never applies, merges or pushes anything (`improvement.autoApply` is `off` by default, and only an additive reference bullet could ever apply unattended). The phase does not change the branch the sweep is on: the cycle's branch is separate and `HEAD` is back where it started when the phase ends. Run in a session, the cycle's walls are the session's own (that workflow's "What is enforced where" table says which walls are code): the budget numbers come from code (`auto-check --skill`), but nothing in a session stops the orchestrator editing the evaluator or pushing, so do neither; the weekly wrapper is the route where those walls are code.

**In an adopter**, this phase runs the intake only (`node .claude/core/skill-evolution.js intake --since {day} --date {YYYY-MM-DD}`, with `{day}` chosen as in step 1), not the `--auto` cycle: there is no `skill-regress` harness or eval suite, so nothing can be drafted, measured or staged on a branch. Route each IMPROVE or CREATE candidate the intake lists as a proposal to the approver, in `docs/.output/evolution/skills/{date}/proposals.md`, and record the count in the 5b row. An approved change lands by the adopter route in Phase 3 (an owner-applied project-additions fence, with a general lesson sent upstream through `/intake`). The steps below, and the verdict route, apply only in the toolkit workshop.

1. Start from a clean tree: every earlier phase committed its own work, and the cycle refuses a dirty one (exit 2, nothing spent). Pass `--since {last-sweep day}`: `--since` is exclusive and day-granular, and rows can land on a day after a sweep on that day has run, so take the day before the newest prior `*-sweep.md` date (the last day that sweep read in full); without it the intake re-surfaces signals an earlier sweep already adjudicated, and the overlap day is deduped by the fingerprints in the adjudication ledger, not by `--since`.
2. Run `/review:evolve-skills --auto --since {day} --date {YYYY-MM-DD}` and read its report and exit code. The cycle checks its own budget first (`skill-evolution.js auto-check`, the `improvement.budget` block): exit 12 means it refused to start or stopped on a cap, and the report says so instead of the phase retrying.
3. Everything the cycle could not measure is listed for a human and not drafted: a near-tie in `ambiguous`, a CREATE cluster, an IMPROVE candidate whose skill has no dev and holdout suite (or fewer than 2 dev evals: a candidate measured on less is low-power and could never be applied), `protectedTargets`, `gateFailures`, `dispatchGaps`.
4. The cycle's own commit (the staging artifacts on its `auto/evolve-…` branch) is this phase's commit; the sweep adds none on its branch for 5b. Record the branch, the verdict, the tokens and the hash in the report's 5b row.
5. Surface the staged branch in the final report; the owner merges it and deletes the branch and any worktree when done. Offer `/review:evolve-skills --apply <skill>` only for a staged accept that is not low-power (the ledger entry and the report say; the apply helper refuses a low-power accept as `lowpower`), and say plainly when a staged accept is low-power: it is a proposal to read, not a change to apply.

## Phase 6 — Defrag (last)

Reuses `/review:memory-defrag` in auto-approve mode, over the grown store.

1. Process the inbox first: `node .claude/core/memory-manager.js inbox-list`, then `inbox-promote <id> [--category <cat>]` with each item's final category.
2. Dispatch a read-only `general-purpose` analysis agent for MERGE / SPLIT / CROSS-REF proposals over `docs/.output/.memory/{decisions,patterns,constraints,workflows,rejected-approaches}/`, prioritizing MERGEs in the largest categories. Reuse a defrag analysis already produced this session rather than re-dispatching.
3. Apply every proposal that preserves all evidence anchors (story IDs, commit hashes, file paths); skip and log any merge that would drop one.
   - MERGE: `memory-manager.js update` the primary (fold in the duplicate's load-bearing fields), then `memory-manager.js delete <cat> <duplicate_id>`.
   - SPLIT/MOVE: `create` the new memory, then `delete` or reduce the source.
   - CROSS-REF: append reciprocal `[[…]]` links to both.
4. Write `docs/.output/findings/reviews/{YYMMDD-HHMM}-memory-defrag.md` (plan and review log).
5. Commit: `docs: /sweep p6 — defrag: {M} merges, {S} splits, {X} cross-refs ({before}→{after})`.

## Phase 7 — Health & Integrity

Reuses `/review:memory-health`, `/review:check-templates` and `/review:timeline`. The memory and template checks are read-only verification of the sweep's own edits; the timeline refresh is the one write.

**7a Memory health.** `node .claude/core/memory-manager.js lint` should show the score did not drop and the overlaps Phase 6 targeted gone (duplicates, contradictions; size alone is never a finding). `node .claude/core/memory-manager.js decay-report` should show nothing with `decayed_confidence < 0.3` left unaddressed. Note anything remaining as residual follow-ups.

**7b Canonical/native integrity.** Phases 3 and 5 edited agents, skills and commands; confirm none of it left the system inconsistent.
1. `node .claude/core/skill-conformance.js`: every skill conforms (body <= 500 lines, name equals dir, description <= 1024). A failure here is almost always a Phase 3 or 5 edit.
2. Run the `check-templates` audit over canonical sources and both native adapters/projections: orphaned agents (no actual dispatch or intentional direct-role use), unused knowledge skills (no frontmatter, workflow or role-body reference; registered workflow selectors are explicit entry points), broken `skills:` references in agent frontmatter, missing hooks.
3. Fix in place and re-verify anything CRITICAL that this sweep introduced. Log pre-existing unrelated issues as residual follow-ups.

**7c Timeline refresh.** `node .claude/core/gen-timeline.js` updates `docs/work/timeline.md`; commit `docs: /sweep p7 — timeline refresh`, skipping the commit if nothing changed.

---

## Commit convention

Inline `git commit -m` is blocked by the commit-guard hook. For each phase commit: `git add` the specific files that phase changed (never `git add .`), write the message to `docs/.output/.state/.commit-msg` without automatic attribution, run `node .claude/core/commit.js`, and record the hash in the Phase Log. With `--single-commit`, stage everything and make one commit after Phase 7.

Do not push; the owner decides when to push. Agents never build or test; only the orchestrator runs `gate.js`.

---

## Final Report

Display and persist to `docs/.output/findings/reviews/{YYMMDD-HHMM}-sweep.md`. Log each review (Phase 1, and the review inside each retro) in the Phase Log using the decision-log shape from review-cadence (reviewed / fixed now / deferred / skipped or light / risk call).

```markdown
## /sweep Complete — {YYYY-MM-DD}

**Scope:** {PRs / epics swept}    **Mode:** {autonomous | gated}

| Phase | Result | Commit |
|-------|--------|--------|
| 1 Code review | {N} findings ({C}C/{M}M/{m}m); {K} auto-fixed | {hash} |
| 2 Retro | {E} epics; {R} recommendations, {S} system improvements | {hash} |
| 3 Implement | {applied} recs applied, {staged} memories staged, {fixed} bug fixes | {hash} |
| 4 Promote | {P} promoted, {Q} manual-review candidates | {hash} |
| 5 Optimize | {A} agents updated, {G} skill gaps flagged | {hash} |
| 5b Evolve skills | cycle exit {code}: {branch or none}, verdict {accept/reject/none}, {tokens} tokens | {hash on the auto/ branch} |
| 6 Defrag | {M} merges / {Sp} splits / {X} cross-refs | {hash} |
| 7a Memory health | lint {before}→{after}, {stale} stale | — |
| 7b Templates audit | {conformance pass/fail}; {orphans} orphaned agents, {unused} unused skills, {broken} broken skill refs | {hash if fixed} |
| 7c Timeline | refreshed `work/timeline.md` | {hash} |

**Memory store:** {total_before} → {total_after} (per-category deltas)
**Lint:** {lint_before} → {lint_after}

### Forks for you (genuine decisions only — everything fixable was already fixed)

{Nothing needs you — all findings resolved in-pass.}

- {a genuine fork: two mutually-exclusive approaches surfaced by retro or review that need the owner's call}
- {an irreversible or outward action the sweep will not take unattended: push, publish, a destructive migration}
- {a finding that cannot be auto-resolved this run: needs a credential, an external decision, or design judgment beyond a single fix}
- {a staged skill-evolution branch `auto/evolve-…`, propose-only by design: merge it, or run `/review:evolve-skills --apply <skill>`, then delete the branch}
- {any phase that halted, and why}
```

This section is forks-only: never a "go run X" or "consider Y" line for something the sweep could do itself. If it is empty, say so. Security and agent drift need no separate line: Phase 1 routes money, auth, access and data-integrity themes to `security-auditor` and `deep` reviewers, Phase 3 resolves their findings in-pass, and Phases 2 and 5 already act on agent drift.

## Relationship to the sub-commands

This command is the auto-approved orchestration of `/review:code-review` → `/review:check-sync` (in retro) → `/retro` → (implement) → `/review:promote-memories` → `/review:optimize-agents` → `/review:evolve-skills --auto` (propose-only) → `/review:memory-defrag` → `/review:memory-health` → `/review:check-templates` → `/review:timeline`. Run a sub-command directly for the interactive, single-purpose version.
