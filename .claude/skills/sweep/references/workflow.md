# Maintenance Sweep

Run the **entire post-work maintenance lifecycle** as one autonomous, auto-approved pass. This is the orchestrator for what are otherwise ten separate interactive commands (`/review:code-review`, `/review:check-sync`, `/retro`, `/review:promote-memories`, `/review:optimize-agents`, `/review:evolve-skills`, `/review:memory-defrag`, `/review:memory-health`, `/review:check-templates`, `/review:timeline`).

Use it after cranking out a batch of work (a string of merged PRs, a finished epic, a sprint) when you want the system to review, learn, propagate the learnings, re-align the agents, and clean up — without babysitting per-proposal Accept/Reject prompts.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js sweep
```

## The Ordering Rule (why this order, and why defrag is LAST)

```
1. Code review      → findings feed the retro
2. Retro (+check-sync) → work + review findings + doc drift → Recommendations + System Improvements
3. Implement recs   → auto-apply agent/skill/command fixes + doc-drift fixes + write new memories  ← creates the pile
4. Promote          → auto-promote above-threshold concepts → skills / CLAUDE.md
5. Optimize agents  → re-align agents with codebase + new memories + retro findings
   5b. Evolve skills → propose skill CREATE/IMPROVE from this run's signals (PROPOSE-ONLY)  ← self-improvement
6. Defrag           → LAST memory op: merge/clean the now-GROWN store              ← the cleanup
7. Health & integrity → verify: memory lint/decay + check-templates (.claude/ wiring) + timeline refresh
```

**Why these three fold in here.** `check-sync` (doc drift) runs *inside* the retro (Phase 2) because its findings are retro input and its fixes are Phase-3 work. `check-templates` (canonical/native structural audit — orphaned agents, unused skills, broken wiring, skill-conformance) runs in Phase 7 *after* Phases 3 & 5 have edited agents/skills/commands, so it validates the sweep's own edits left nothing dangling. `timeline` regeneration is pure end-of-run housekeeping — it just reflects the commits the sweep itself made.

**Defrag runs last on purpose.** Steps 2–5 spawn a pile of new memories. Defragging *before* that pile lands gets invalidated the moment the new memories are written — you'd have to defrag twice. Defrag is the *final cleanup pass* over the grown store, not the opener.

**The cap is handled by staging, not by defragging early.** Each category has a hard cap of `MEMORY_MAX_PER_CATEGORY` (in `constants.js` — **read it for the current value; never trust a number cited in this doc, it has gone 50→60→100→150**); `createMemory` refuses writes at the cap and auto-prunes stale entries at the `MEMORY_NEAR_LIMIT_PCT` (~80%) threshold. Steps 2–3 do NOT force-write into a near-cap category — new memories **stage into the inbox** (`memory-manager.js create` when the category is below ~80%; otherwise queue a draft via the inbox). The step-6 defrag then processes the inbox (`inbox-promote`) *and* merges overlaps in one pass, so everything lands under the cap. This is what makes "defrag at the end" actually work instead of hitting a wall at step 3.

## Autonomy Contract (read this — it overrides the sub-commands)

> **Everything is auto-approved.** This command does NOT stop for per-proposal Accept/Reject prompts. The interactive gates in `/review:promote-memories` (per-candidate) and `/review:memory-defrag` (per-proposal) are **suspended** — the sweep auto-applies every proposal that clears its threshold and logs what it did. The user reviews the *result* (the final report + the per-phase commits), not each step.
>
> Exceptions that still halt the sweep:
> - A phase agent reports a CRITICAL finding that would corrupt the store (e.g., a merge that loses an evidence anchor) → skip that one operation, log it, continue.
> - A build/test gate fails after an auto-applied code change in Step 3 → **stop, report, leave the rest unrun.**
> - The user passed `--gated` (see Variables) → pause between phases.
>
> **The sweep's own damage is always resolved in-pass — the operating standard.** Any inconsistency this sweep introduces (a Phase-3/5 edit that breaks skill conformance, an orphaned skill, a broken wiring ref) is fixed and re-verified before the final report (Phase 7b) — never just logged. That is "resolve it or don't report it." Pre-existing issues *unrelated* to this sweep are the documented exception: surface them as residual follow-ups, don't churn already-merged code. Canonical statement: `.agents/skills/verification-before-completion/SKILL.md`.

## Execution Notes (generic hardening — apply regardless of stack)

- **CWD discipline.** The Bash tool persists working directory across calls — a single `cd` into a subdir silently breaks later `node .claude/core/*` and `git` calls (module-not-found / pathspec). Run every phase command from the repo root: use **absolute or repo-root-relative script paths** and `git -C <repo-root>`, and never leave the shell parked in a subdir.
- **`doc-writer` and review agents have NO Bash.** Gather all per-epic git stats (commit count, files, +/-, date range) in the main agent and pass them INLINE in the Phase 2 dispatch prompt. The orchestrator (main agent) owns all git/gate/node calls.
- **Promote (Phase 4): cohesive-cluster-first.** When the auto-threshold matches many candidates, promote the largest *cohesive* cluster (same skill/home) as one block; defer *scattered singletons* — especially ones already represented in ADRs/CLAUDE.md — to manual review. Don't scatter single-line edits across many files unattended.
- **Defrag (Phase 6) relieves the hard cap, not necessarily the soft warning.** `memory-guard.cjs` warns at ≥`MEMORY_NEAR_LIMIT_PCT` (~80%) of the cap. A handful of merges clears the *hard cap* (writes work again) but may not clear the warning — that needs a deeper consolidation pass. Phase 7 success = "hard cap relieved + new memories landed," NOT "lint score fully restored."
- **Squash-merge branch check.** `git merge-base --is-ancestor` is fooled by squash-merges (a content-merged commit looks unique by hash). Use `git cherry -v origin/main HEAD` to detect already-upstream commits before branching or cherry-picking.
- **Generated/vendored code.** Tell every reviewer to skip generated artifacts (lockfiles, `dist/`, `*.min.*`, migration scaffolding, snapshots) — sanity-check *intent* only, don't review generated line volume.
- **Idle-without-delivery is expected, not anomalous — nudge immediately.** Background reviewer/drift agents recurringly go idle without sending their report (confirmed in the field twice: 3/4 agents in one epic retro, 3/8 in a sweep). When an agent's idle notification arrives with no findings message and no delivered summary, immediately `SendMessage` it a "deliver your full findings now to main" nudge — do not wait, do not re-dispatch a fresh agent first (the work is done; only the delivery hop failed). Budget for one nudge round in every phase that fans out background agents.

## Variables

INPUT: $ARGUMENTS — optional scope hint. Two forms:
- A **PR range** (`109-128`) → resolve to merge commits via `git log --oneline main`, classify into themes for code review, infer epics for retro.
- A **comma-separated epic list** (`Auth,Billing,Search`) → run a retro per epic; derive the code-review scope from each epic's PRs.
- **Empty** → sweep the most recent completed epic (per `docs/work/backlog.md`) + the commits since the last sweep marker.

**Flags:**
- `--review-scope <high-risk|systemic|all>` — code-review depth (default: `high-risk` — security/auth/data-integrity changes only; cheapest high-ROI on already-merged code).
- `--gated` — auto-apply *within* each phase but pause between phases so you can bail early. Default is fully autonomous, no pauses.
- `--single-commit` — squash all phase work into one commit at the end instead of per-phase commits.
- `--skip <phases>` — comma-separated phase numbers to skip (e.g. `--skip 1` to skip code review).

## Pre-flight

1. **Confirm code exists** (this is a post-implementation command): `Glob: src/**/*` (or the project's source root) must return results. If the project is still tech-agnostic/unspecialized → stop, suggest `/review:specialize` first.
2. **Capture the start state** for the final report:
   ```bash
   node .claude/core/memory-manager.js report | grep -E '"total_memories"|"count"'
   node .claude/core/memory-manager.js lint | grep '"score"'
   ```
   Record `total_memories`, per-category counts, and `lint` score as the BEFORE numbers.
3. **Resolve scope** from INPUT (PR range → themes + epics, or epic list → epics).
4. **Compute the run stamp once** — `date +%y%m%d-%H%M` (e.g. `260606-1642`) — and reuse this SAME `{YYMMDD-HHMM}` for **every** artifact this sweep writes (the plan, each phase's report, the final report) so one run's files sort together and a same-day re-run never clobbers a prior run. **Resuming a dead sweep:** if a `*-sweep.md` from today already exists with an incomplete Phase Log, reuse ITS stamp (the most recent one) instead of minting a new one, so you append to the same plan. Then **write the sweep plan** to `docs/.output/findings/reviews/{YYMMDD-HHMM}-sweep.md` with a `## Phase Log` section. This is the durable artifact — if the session dies mid-sweep, the plan + completed-phase markers survive and the sweep is resumable (skip phases already marked `[x]` in the Phase Log).

**Runtime and verification.** In an adopter, the Phase 3 gate (`gate.js`) runs the application's own build and test commands and never the Domdhi.Agents toolkit suite, including after the agent, skill and command edits this sweep makes; in Domdhi.Agents itself it runs the toolkit's Node build and Vitest suite. In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments and dispatch roles as `.agents/adapters/codex/execution.md` describes. Note that discovery alone (an installed skill, a listed command or a loaded file) never proves a phase ran: mark a phase `[x]` and claim completion only from its written report, the gate output and the commit hash recorded in the Phase Log.

---

## Phase 1 — Code Review

Reuses the `/review:code-review` methodology, but **dispatches reviewers in parallel by theme** and auto-consolidates (no interactive verdict step).

1. Classify the in-scope PRs/commits into themes (e.g. auth, data, API, UI, infra/CI). **Skip pure-infra/CI and doc-only changes** unless `--review-scope all`.
2. **Tell every reviewer to ignore generated/vendored code** (lockfiles, `dist/`, minified bundles, migration scaffolding/snapshots) — sanity-check intent only.
3. Dispatch one `code-reviewer` agent per theme, in parallel (background OK). Omit the `model:` param so each runs on the **`standard` default** (code-reviewer's default — sweep is broad maintenance, not a high-stakes gate). Escalate a specific theme to `model: "opus"` only if it touches a HIGH-risk-tier path (security, auth, data-integrity, migrations). Each gets the merge commits, diffs via `git diff <hash>^1 <hash>` (fallback `^2`), and returns a CRITICAL/MAJOR/MINOR/NIT findings table. They auto-load the `code-review` skill — do not paste the rubric. For a theme that concerns a specific application area, also pass the project reference paths and verified project constraints that apply to it.
4. Consolidate all findings into `docs/.output/findings/reviews/{YYMMDD-HHMM}-code-review.md`.
5. Commit (unless `--single-commit`) per the convention below: `docs: /sweep p1 — code review, {N} findings ({C}C/{M}M/{m}m)`.
6. Append the findings summary to the sweep plan's Phase Log — **the retro consumes this.**

## Phase 2 — Retro

Reuses `/retro` — **as if invoked with `--skip-review`**, because Phase 1 already ran the code-review pass that `/retro` would otherwise run itself. Do NOT re-review here; feed the Phase 1 findings in instead. One retro per epic in scope (or one consolidated retro if INPUT was a single PR range with no clear epic split).

1. Gather data IN THE MAIN AGENT (agents have no Bash): git stats for the epic's commits, TODO Execution Log, work-doc plans, telemetry (`docs/.output/.state/telemetry/command-usage.jsonl` if present), **and the Phase 1 code-review findings** (these populate the retro's *Code Review Findings* section — no second review).

   1b. **Scan the window's per-epic retros for a named-but-UNDELIVERED review gap, and close it THIS sweep.** Any retro in the window that says a review theme "never delivered", "was not independently re-verified", "the agent went idle without reporting", or "shipped via Path A" is naming a surface that was **built but never independently reviewed**. Do not carry it to the next naturally-scheduled sweep: either fold that theme into the Phase 1 dispatch as a targeted make-up review, or record it in this sweep's own retro as a named open risk with the reason it could not be covered.
   > This step exists because of a measured miss. A retro flagged one review theme (tenancy) as under-reviewed. Nothing turned that flag into an accelerated follow-up, so it waited for the next sweep, which found **three MAJOR cross-tenant write defects in exactly the files the retro had named**. The vulnerability was live for the whole interval. A retro naming its own coverage gap is the single highest-yield input a sweep gets; treat it as a dispatch instruction, not as context.
2. Run `/review:check-sync` for doc drift; capture findings.
3. Dispatch `doc-writer` (per the retro template) to write `docs/.output/findings/reviews/retro-{epic-slug}.md`. **Include the output-boundary instruction verbatim** ("Your ONLY output is the retro markdown… Do NOT write memories…") — the main agent owns memory extraction in Phase 3.
4. Commit each retro: `docs: /sweep p2 — retro {epic}`.
5. Append each retro's `## Recommendations` and `## System Improvements` tables to the Phase Log — **Phase 3 implements these.**

## Phase 3 — Implement Recommendations

Auto-apply the retro's concrete outputs. This is the step that turns a retro from a document into changes.

1. **Memory extraction** — for every reusable pattern the retro surfaced and every learning in the code-review findings worth keeping:
   - If the target category is **below ~80% of cap**: `node .claude/core/memory-manager.js create <category> <id> '<content-json>'`. Assign an `importance` (1–5) in the content per the `session-handoff` skill.
   - If the target category is **at/near cap (≥ `MEMORY_NEAR_LIMIT_PCT` of `MEMORY_MAX_PER_CATEGORY` — read `constants.js`)**: **stage a draft to the inbox** (`docs/.output/.state/memory-inbox/`) instead — do NOT force the write. The Phase 6 defrag frees room and promotes from the inbox. Record the staged item in the Phase Log.
2. **System Improvements** — for each row in the retro's `## System Improvements` table:
   - `Agent: …` → edit the named canonical `.agents/roles/*.md` (legacy native source only when no canonical counterpart exists) (surgical fix from the retro; broad re-alignment is Phase 5's job — don't duplicate).
   - `Skill: …` → edit the named canonical `.agents/skills/*/SKILL.md`. **In an adopter** (not the workshop), project-specific additions to a *template* skill MUST use a project-additions sentinel (create if absent) — a new section at the end → `<!-- @@project-additions -->`; a bullet inserted into an existing section → an anchored `<!-- @@project-additions:start -->`/`:end` fence. A plain edit to template prose is clobbered on the next sync. See `skill-authoring`.
   - `Command: …` → edit the named `.agents/skills/*/references/workflow.md` and its existing registry metadata; render the generated command.
   - `Memory: …` → create/boost the memory (cap rule above).
3. **Code-review fixes — every finding, nits-and-up.** Fix each finding CRITICAL down to NIT in-pass (the operating standard: `verification-before-completion` → "Autonomous & batch commands"; no "MINOR/NIT logged not fixed" tier). Dispatch a `general-purpose` agent for anything beyond a trivial edit (batch related small fixes to keep dispatches efficient), then **the orchestrator runs the gate** (`node .claude/core/gate.js test` — auto-detects the stack). Agents never build/test. If the gate fails → **stop the sweep, report.** The only carve-out is SCOPE, not severity: don't expand scope to churn unrelated code the sweep isn't examining, and skip generated/vendored artifacts.
4. Commit: `feat: /sweep p3 — applied {N} retro recs, {M} memories staged, {K} fixes`.

> **Phase 3 ↔ Phase 5 boundary:** Phase 3 applies the retro's *specific, named* improvements (surgical). Phase 5 does the *broad, systematic* codebase→agent re-alignment + proven-pattern injection. They are complementary; do not redo Phase 3's edits in Phase 5.

## Phase 4 — Promote Memories

Reuses `/review:promote-memories` in **auto-approve** mode.

1. `node .claude/core/memory-promoter.js scan --top 15`.
2. For each candidate with **promotion score ≥ 0.9 AND decayed confidence ≥ 0.7** (the auto-promote threshold — high bar, since this writes into skills/CLAUDE.md unattended): resolve the promotion to an existing canonical shared target (decisions→existing architecture/skill guidance, patterns→relevant knowledge source, constraints→existing template/reference, workflows→canonical role body); project decisions stay project-owned, and generated projections/root runtime instructions are not shared-behavior targets, then `node .claude/core/memory-promoter.js mark <slug> <target>`.
3. Candidates **below** the auto-threshold are listed in the report as "manual-review promotion candidates" — surfaced, not applied.
4. Commit: `docs: /sweep p4 — promoted {N} concepts`.

## Phase 5 — Optimize Agents

Reuses `/review:optimize-agents --fix`.

1. Dispatch `architect` to scan the actual codebase → detected stack + structure map.
2. Compare each canonical `.agents/roles/*.md` `## Project Context` (legacy native only without a canonical equivalent); classify CURRENT / DRIFTED / MISSING.
3. Retain intentionally portable template roles without project specialization. Inject proven patterns (confidence ≥ 0.7) + this sweep's retro findings + the day-scoped `docs/.output/evolution/agents/{date}.md` issues into DRIFTED/MISSING agents (idempotent replace).
4. Dispatch `code-reviewer` for the skill-effectiveness audit (ACTIVE / NOT_USED / gaps).
5. Write `docs/.output/findings/reviews/{YYMMDD-HHMM}-agent-optimization.md`.
6. Commit: `docs: /sweep p5 — agent re-alignment ({N} agents updated)`.

## Phase 5b — Evolve Skills (PROPOSE-ONLY)

Reuses `/review:evolve-skills --auto`. Runs *after* Phase 5 (so it sees freshly-promoted memories + this run's agent re-alignment) and *before* Phase 7b (so the templates audit validates any staged change). This is the self-improving-skills step: it turns the same signals Phase 5 reads (agent-updates) plus the memory store into skill work.

**Why propose-only inside the sweep.** Skill *bodies* are the system's own brain. Unlike memory promotion (Phase 4, which has a clean ≥0.9 auto-threshold), a skill rewrite or a brand-new skill has no safe unattended threshold — and the `skill-authoring` doctrine requires a positive **differential eval** to justify any change, which is an expensive multi-subagent run that shouldn't fire blind in a maintenance pass. So Phase 5b **stages proposals; it never applies them.**

1. `node .claude/core/skill-evolution.js intake --date {YYYY-MM-DD} --since {last-sweep date}` → reads `intake.json`: IMPROVE candidates (agent-update misalignments attributed to a skill) + CREATE candidates (uncovered recurring memory clusters). A near-tie signal lands in `ambiguous`, not IMPROVE: list it in the report for a human call, never propose an edit for it. **Pass `--since`** (the previous sweep's date, from the newest prior `*-sweep.md`) — without it the intake re-surfaces signals an earlier sweep already adjudicated, and you re-litigate stale evidence every run.
2. For each candidate clearing the bar (IMPROVE: ≥1 attributed misalignment; CREATE: cluster size ≥3 OR avg confidence ≥0.8), the orchestrator (Main Agent) does the **reflective diagnosis** (what gap, what the skill should say) and drafts a candidate edit/new SKILL.md into the workspace under `docs/.output/evolution/skills/{date}/`, then conformance-gates it:
   `node .claude/core/skill-evolution.js check <skill> <candidate>`.
3. **Do NOT apply, do NOT run the full differential benchmark here** (that's the human-confirmed `/review:evolve-skills` standalone run). Record each staged proposal — skill, evidence, the candidate diff, conformance result — in `docs/.output/evolution/skills/{date}/proposals.md`.
4. Commit the staging artifacts only: `docs: /sweep p5b — {N} skill-evolution proposals staged`.
5. Surface the staged proposals under **"Still needs you"** in the final report — the user runs `/review:evolve-skills --apply <skill>` (which runs the differential) to accept any of them.

## Phase 6 — Defrag (LAST)

Reuses `/review:memory-defrag` in **auto-approve** mode — now operating on the GROWN store (new memories from Phases 2–3 included).

1. **Process the inbox first**: `node .claude/core/memory-manager.js inbox-list`. For each staged item, decide its final category and `inbox-promote <id> [--category <cat>]`. If a target category is at cap, that item is resolved by the merges below.
2. Dispatch a `general-purpose` analysis agent (read-only) to produce MERGE / SPLIT / CROSS-REF proposals over `docs/.output/.memory/{decisions,patterns,constraints,workflows,rejected-approaches}/`. Prioritize MERGEs within near-cap categories. **If a prior defrag-analysis from this session already exists, reuse it** rather than re-dispatching.
3. **Auto-apply every proposal** that preserves all evidence anchors (story IDs, commit hashes, file paths). Skip + log any merge that would drop an anchor.
   - MERGE → `memory-manager.js update` primary (fold in duplicate's load-bearing fields) + `memory-manager.js delete <cat> <duplicate_id>`.
   - SPLIT/MOVE → `create` new + `delete`/reduce source.
   - CROSS-REF → append reciprocal `[[…]]` links to both.
4. Write `docs/.output/findings/reviews/{YYMMDD-HHMM}-memory-defrag.md` (plan + review log).
5. Commit: `docs: /sweep p6 — defrag: {M} merges, {S} splits, {X} cross-refs ({before}→{after})`.

## Phase 7 — Health & Integrity (verify + housekeeping)

Reuses `/review:memory-health`, `/review:check-templates`, and `/review:timeline`. The memory + template checks are read-only verification of the sweep's own edits; the timeline refresh is the one write (committed).

### 7a — Memory health (read-only)
1. `node .claude/core/memory-manager.js lint` → confirm the **hard cap is relieved** (every category < `MEMORY_MAX_PER_CATEGORY` so writes work). NOTE: the category-balance warning persists while a category is ≥`MEMORY_NEAR_LIMIT_PCT` (~80%) of the cap, so the lint score may stay below max — that is expected and is NOT a failure. Only flag it if a category is still AT the hard cap or a deeper consolidation is warranted.
2. `node .claude/core/memory-manager.js decay-report` → confirm no `decayed_confidence < 0.3` left unaddressed.
3. If lint is below target or stale entries exist, note them in the report as residual follow-ups.

### 7b — Canonical/native integrity (read-only — validates THIS sweep's edits)
Phases 3 and 5 edited agents/skills/commands. Run the `check-templates` audit to confirm none of it left the system inconsistent:
1. `node .claude/core/skill-conformance.js` → every skill conforms (body ≤500 lines, name==dir, description ≤1024). A FAIL here is almost always a Phase-3/5 edit — flag it.
2. Audit canonical sources and both native adapters/projections using `check-templates`: orphaned agents (no actual dispatch or intentional direct-role use), unused knowledge skills (no frontmatter/workflow/role-body reference; registered workflow selectors are explicit entry points), broken skill references in agent frontmatter (a `skills:` entry with no matching dir — the exact failure class the Phase-5/optimize and template-merge work touches), missing hooks.
3. **Anything CRITICAL that this sweep introduced** (a skill edit that broke conformance, an agent edit that orphaned a skill) → fix it in place and re-verify, since it's the sweep's own damage. Pre-existing issues unrelated to this sweep → log as residual follow-ups, don't auto-fix.

### 7c — Timeline refresh (housekeeping, committed)
1. `node .claude/core/gen-timeline.js` → regenerate/update `docs/work/timeline.md` with the latest weekly commit history (now including this sweep's commits).
2. Commit: `docs: /sweep p7 — timeline refresh`. (Skip the commit if `gen-timeline.js` produced no change.)

---

## Commit Convention (per-phase, this toolkit's gate)

Inline `git commit -m` is blocked by the commit-guard hook. For each phase commit:
1. `git add` the specific files that phase changed (not `git add .`).
2. Write the message to `docs/.output/.state/.commit-msg` with the Write tool, without automatic attribution.
3. Run `node .claude/core/commit.js`.
4. Record the hash in the Phase Log.

With `--single-commit`, stage everything and make one commit after Phase 7 instead.

---

## Final Report

Display (and persist to `docs/.output/findings/reviews/{YYMMDD-HHMM}-sweep.md`):

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
| 5b Evolve skills | {N} proposals staged ({I} IMPROVE / {C} CREATE) | {hash} |
| 6 Defrag | {M} merges / {Sp} splits / {X} cross-refs | {hash} |
| 7a Memory health | lint {before}→{after}, {stale} stale | — |
| 7b Templates audit | {conformance pass/fail}; {orphans} orphaned agents, {unused} unused skills, {broken} broken skill refs | {hash if fixed} |
| 7c Timeline | refreshed `work/timeline.md` | {hash} |

**Memory store:** {total_before} → {total_after} (per-category deltas)
**Lint:** {lint_before} → {lint_after}

### Forks for you (genuine decisions only — everything fixable was already fixed)

Everything this sweep could resolve, it resolved in-pass (the Autonomy Contract + the operating standard). This section is **forks-only** — never a "go run X" or "consider Y" line for something the sweep was capable of doing itself. If it's empty, say so: *"Nothing needs you — all findings resolved in-pass."*

- {a genuine FORK: two mutually-exclusive approaches surfaced by retro/review that need YOUR call (not "here's a fix to apply" — those were applied)}
- {an irreversible / outward action the sweep won't take unattended: push, publish, a destructive migration}
- {a finding that genuinely can't be auto-resolved this run — needs a credential, an external decision, or design judgment beyond a single fix}
- {staged skill-evolution proposals — PROPOSE-ONLY *by design* (gated on a differential eval, the one thing the sweep structurally cannot auto-apply): run `/review:evolve-skills --apply <skill>`}
- {any phase that halted + why}
```

> Security findings need no separate line: Phase 1 already routes security/auth/data-integrity themes to `deep` tier reviewers and Phase 3 resolves their CRITICAL/MAJOR findings in-pass. Agent-drift needs no separate line either: Phase 2 (retro System Improvements) + Phase 5 (optimize-agents) already act on it. The sweep *does* the work those standalone reviews would have surfaced — it does not tell you to go run them.

## What NOT to Do

- Do NOT defrag before Phases 2–5 run — the new memories must land first.
- Do NOT force-write into a near-cap category — stage to inbox, let Phase 6 resolve.
- Fix EVERY in-scope finding, NIT-level and up, in-pass — no "logged for the user" tier (the operating standard; `verification-before-completion` → "Autonomous & batch commands"). The report is forks-only: findings aren't surfaced-and-left, they're resolved. The only limit is SCOPE — don't expand beyond what the sweep is examining to churn unrelated already-merged code, and skip generated/vendored artifacts. A genuinely unrelated pre-existing issue outside scope may be a residual follow-up.
- Do NOT push to remote — the user decides when to push.
- Agents never build/test — only the orchestrator runs `gate.js`.
- Use this repo's commit convention (`.commit-msg` + `commit.js`) — never inline `git commit -m`.

## Relationship to the Sub-Commands

This command *is* the auto-approved orchestration of: `/review:code-review` → `/review:check-sync` (in retro) → `/retro` → (implement) → `/review:promote-memories` → `/review:optimize-agents` → `/review:evolve-skills --auto` (propose-only) → `/review:memory-defrag` → `/review:memory-health` → `/review:check-templates` → `/review:timeline`. Run a sub-command directly when you want the interactive, single-purpose version. Run `/sweep` when you want the whole lifecycle hands-off.
