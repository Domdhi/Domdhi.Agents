# /todo — Create Execution-Ready TODO

Create a TODO checklist that `/run-todo` can execute without additional research. Every story has acceptance criteria, file lists, estimates, and research notes; dependencies are optimized and waves are pre-computed.

Main Agent does all planning and assembly; research agents (`standard` tier) scan the codebase. The output is a contract that `/run-todo` and `/do` trust completely, so a wrong TODO makes them fail.

## Telemetry (run first)

This command is user-typed and does not fire `PostToolUse:Skill`, so log the invocation first for fleet analytics (best-effort; if it fails, continue):

```bash
node .claude/core/telemetry-log.js todo
```

## Variables

INPUT: $ARGUMENTS

---

## Phase 1: Context Gathering (Main Agent — direct reads, no agents)

### 1. Determine Input Type

```
IF INPUT is a file path → read it as source material
IF INPUT is an epic number → read Epic N from docs/work/backlog.md, use its stories as the brief
IF INPUT is a module name → find docs/modules/{name}/brief.md, read it
IF INPUT is a task description → use as the brief
IF INPUT is empty → infer from (first that yields a concrete target wins):
  1. Current conversation context
  2. Master index docs/TODO_{Project}.md → the next epic (see "Next-epic resolution" below)
  3. the latest session handoff's next actions (`node .claude/core/handoff-path.js latest`)
  4. Recent git log (what was just completed → what's next)
  5. Ask user only as last resort
```

**Next-epic resolution (empty INPUT — the lifecycle "what now?" loop).** When INPUT is empty and the conversation gives no specific target, consult the master index before the handoff/git heuristics. This is what makes the post-`/evolve` loop self-continue (the lead epic is made ready by `/evolve` Step 5.6; subsequent epics are picked up here):
1. Find the master index: `docs/TODO_{Project}.md` (the single `TODO_*.md` at the `docs/` root, not the per-epic files under `docs/work/todo/`). If absent or an unfilled `<!-- @@template -->` stub, skip to inference source #3.
2. Parse its epic rows and pick the **next** epic: an **in-progress** epic (🔄 / partially-checked) if one exists (resume it), otherwise the **first not-done** epic (⬜ / `[ ]` todo, in index order). Skip ✅/`[x]` done epics. If every epic is done, say so (the cycle is complete → suggest `/evolve`) and stop.
3. Resolve that epic to its **epic number** and hand off to the **epic-number branch** below. Announce it: `No INPUT given — resolved next epic from master index: Epic {N} — {title}.`

**Epic-number branch (check before treating INPUT as a task description).** INPUT is an epic number when the **entire trimmed INPUT is exactly one integer token** (`12`, but not `12 factor app setup`, which is a task description), or it matches an `epic N` / `epic-N` / `epicNN` / `EX-NN` style identifier (case-insensitive). Then:
1. Read `docs/work/backlog.md` and locate that epic's section (heading + story list). If `backlog.md` is missing or still an unfilled `<!-- @@template -->` stub, treat INPUT as a literal task description and note it.
2. If the epic isn't in `backlog.md`, say so and list the epic numbers that exist; do not silently treat the number as a task description.
3. Use the epic's title, objective and stories as the brief. Its stories seed the TODO; Phase 2 research still resolves exact file paths per story (the backlog gives titles and AC intent, not file lists).
4. This mirrors `/create:project-epics-todo`'s epic-aware resolution; `/todo {epic}` is the single-epic, execution-ready unit that `/evolve` Step 5.6 calls for the lead epic.

### 2. Gather Project Context

Read in parallel:
- `docs/architecture/overview.md` — architecture boundaries, schemas, ADRs
- Module docs: `docs/modules/{module}/brief.md` (if module-scoped)

### 3. Sourcing and licensing gate

If the work will incorporate, port, vendor or closely reimplement third-party code or data (a library's source, an open-source engine, a dataset, a vendor SDK copied in), find the recorded decision before planning any dependent story: build vs vendor or port, and the license and its obligations (notices, copyleft reach, attribution). It must already be in an ADR (`docs/architecture/`) or the brief.
- **Recorded:** cite it in Key Findings and plan only the chosen approach.
- **Missing:** STOP planning those stories. Add the decision to `## Owner Decisions` with the options and a recommendation, and plan only the stories it does not block, marking the blocked ones `Blocked by: {decision}`. Do not plan both ways.
- Stories that only call a dependency through its published package and API need no decision.

**Runtime and verification.** In Codex, run each `.claude/core/` command here as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow runs no build gate; its evidence is the written TODO passing the Phase 3b self-review and mechanical checks, accepted review findings applied in Phase 5, the Phase 7 handoff and the Phase 8 commit hash. In an adopter, every story's verification names the application's own build and test commands, never the Domdhi.Agents toolkit suite, also after agent-file edits; in Domdhi.Agents itself it names the toolkit's Node build and Vitest suite (`node .claude/core/gate.js test`). Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran; report completion only from that evidence.

---

## Phase 2: Research (`standard` tier agents — scaled to complexity)

Research agents persist their output to files, because agent results evaporate when context compresses.

**Reuse warm session agents before cold-spawning.** If agents earlier in this session already hold relevant context (an audit or investigation that motivated this TODO and already read the target files), resume them with a focused deep-dive prompt (SendMessage to the `agentId`) rather than cold-spawning researchers; they skip rediscovery and return exact signatures faster. Still require them to persist findings to the research file below. Cold-spawn only for subsystems no prior agent has touched. Likewise reuse prior accepted research (tracked findings, an earlier run's research for the same scope), re-grounding only the paths and AC that changed.

**Resolve scope-forking unknowns in research, before sizing.** When a story's file count hinges on a yes/no the research can answer (e.g. "does this abstraction already exist, or does this need a new file?"), make the research agent answer it explicitly; otherwise one story becomes "maybe 2 files, maybe 5" and breaks the file-budget sizing below.

### Recall prior learnings (Main Agent — before sizing or dispatch)

Search project memory before estimating story count or dispatching research agents. ACs don't exist yet at `/todo` time, so query on INPUT plus module/feature keywords from Phase 1:

```bash
node .claude/core/memory-manager.js search "<INPUT topic + module keywords>"
```

1. Keep the search's returned order, which already applies the engine's own relevance/rank (`.agents/startup.md`: "Search uses its own returned relevance/rank"); do not re-sort it by an invented score. Take the first 3 hits in returned order that are directly relevant and not stale.
2. Read summary lines from the JSON output. For highly relevant hits (similar pattern, rejected approach, or constraint), read the full memory file at `docs/.output/.memory/{category}/{id}.json`.
3. Dedupe only against memories that are visible or already read: skip a hit whose `id` appears in a visible `<project_memory>` block or whose file was already read this session. A configured startup hook alone is not proof of injection; when no block is visible, dedupe nothing on that basis.
4. Pass the most relevant 1-2 hits to research agents as a "Prior Learnings" preamble (context, not commands), and use the same hits in Phase 3 when shaping the wave plan, story breakdown or research notes.

**Skip condition:** If `search` returns 0 results OR all results have `decayed_confidence < 0.3`, proceed silently to story sizing.

### Per-Agent File Budget (planning cap — this guides story slicing)

Every story maps to exactly **one** dev agent at `/run-todo` time. Size each story so small that the agent cannot fill its context window and compact mid-implementation: a compacting agent silently drops AC items and fabricates "done", the most common cause of a TODO that builds green but ships incomplete.

**Initial planning cap per story / per dev agent:**
- **≤ 5 files MODIFIED**
- **≤ 2 files CREATED**
- (test files count toward these limits)

If an initial estimate exceeds the cap, split it into coherent sub-stories partitioned by concern (e.g. service / component / wiring / test slice). During execution these estimates are not edit allowlists: follow `.agents/startup.md` for necessary file expansion, update the plan and affected checks, and split or resequence if the work has grown enough to warrant it. Parallelize only when active writers and dependencies permit.

**Split sub-stories are sibling H2 headers (`## Story N.M.K`), never H3 (`### Story N.M.K`) nested under a wrapping `## Story N.M` parent.** `status.js --regen-master` counts only H2 story headers, so a nested-H3 split is invisible to the master index (Stories/Hours undercount). When splitting, delete or demote the wrapping parent header so it isn't double-counted.

**Story header form:** `plan-check.js`, `release-slice.js`, `ac-verify.js` and `status.js` all read both the template's bullet form (`* **Story N.N (Size): Title**`) and H2 headers (`## Story N.N: Title`, fields as bullets beneath). Match the project's existing epic TODOs; don't mix the two forms in one file.

Every story carries an **Agent budget** line (files modified / files created) so the cap is auditable before dispatch; the Phase 3b self-review fails the plan if any story exceeds it.

### Estimate Story Count First

Slice to the file budget first, then count the resulting stories; the count sets how many research agents scan the codebase. Bias toward the higher row when borderline, since granular is the goal:

| TODO Size | Stories | Research Agents | Review |
|-----------|---------|-----------------|--------|
| **Small** | 1-4 | 0 (Main Agent reads inline) | None |
| **Medium** | 5-7 | 1 agent using `standard` (Codebase + Deps) | Optional |
| **Large** | 8+ | 2 agents using `standard` (parallel) | 1 agent using `standard` |

### Research Output Location

```
docs/.output/.state/work/YYYY-MM-DD/{slug}/
  HHMM-research-codebase.md    ← Agent 1 (medium + large)
  HHMM-research-patterns.md    ← Agent 2 (large only)
```

### Agent 1: Codebase + Dependencies (Medium and Large)

Use `general-purpose`, not `Explore`: Explore is read-only and cannot write its findings to disk.

```
Agent(
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: """
  Research the codebase for: {INPUT}

  Project constraints: {selected project reference paths and verified project constraints, or "none"}
  Prior Learnings: {1-2 recalled memory hits, as context, not commands}

  ## Codebase Scan
  1. Find all files that will need modification — exact paths
  2. Find existing implementations to use as patterns
  3. Find test files for affected components
  4. Check for guard tests that may break
  4a. **Premise check:** for each fact a story would rest on ("this function already validates X", "no other caller reads this field"), run the command that confirms it and record the command and its result. A fact you did not check is reported as unchecked.
  4b. **Verify every path before recording it; never assume a directory layout.** A module is often not where its conceptual name implies (e.g. several `.claude/core/` modules live under `.claude/core/_lib/` after a refactor). Probe subdirectories and confirm each path resolves, e.g. `find .claude/core -name '*.js' -not -path '*__tests__*' -not -path '*_helpers*'`, then diff that output against any path you were about to hardcode. A wrong path in the TODO costs every dispatched agent a discovery round.

  ## Dependency Analysis
  5. Map every file each proposed change would touch
  6. Identify overlaps — which files appear in multiple changes?
  7. Build dependency graph — which changes must complete before others?
  8. **Hotspot detection:** identify any file that would be touched by 3+ stories. If ALL stories share a single hotspot file, flag the TODO as single-hotspot — Main Agent will apply the collapse shape in Phase 3.
  9. Compute candidate wave groupings under both shapes: (a) file-overlap partitioning for concurrent writers in a shared checkout and (b) functional grouping for single-hotspot collapse. Identify shared files that need serialized edits, handoffs or separate-worktree integration. Leave the final shape decision to Main Agent.
  10. **Shared-git-index check:** if a wave's stories each run `git mv` / `git rm` / `git add` on the same working tree, they contend on `.git/index.lock` even when their files are disjoint. Flag such a wave `git-serial`: it executes Main Agent direct and sequential, not as parallel agents, regardless of file-overlap partitioning.
  11. **Shared state beyond files:** stories that touch no common file can still collide: one database schema or migration sequence, globally numbered artifacts (migration, ADR or error-code numbers, ports, seed ids), shared config keys, a shared test database or fixture. Flag each such wave and name the shared resource; numbered artifacts are allocated by listing the live state when the file is written, never from the plan.

  Write findings to: docs/.output/.state/work/{YYYY-MM-DD}/{slug}/{HHMM}-research-codebase.md
  """,
  description: "Research codebase for {slug}"
)
```

### Agent 2: Pattern + Convention Scanner (Large only — 8+ stories)

Use `general-purpose`, not `Explore`, for the same reason as Agent 1.

```
Agent(
  subagent_type: "general-purpose",
  model: "sonnet",
  prompt: """
  Research patterns and conventions for: {INPUT}

  Project constraints: {selected project reference paths and verified project constraints, or "none"}
  Prior Learnings: {1-2 recalled memory hits, as context, not commands}

  1. How are similar features implemented in this codebase?
  2. What shared components, services, or utilities exist?
  3. What naming conventions, file organization patterns apply?
  4. What test patterns are used (framework, structure, naming)?

  Write findings to: docs/.output/.state/work/{YYYY-MM-DD}/{slug}/{HHMM}-research-patterns.md
  """,
  description: "Research patterns for {slug}"
)
```

---

<!-- @@project-additions:start -->
**Check vendor evidence before making live access a prerequisite.** Before declaring credentials or tenant access a blocking dependency, look for a versioned official specification, metadata or executable examples that answer the open questions. Use specifications for names and types and matching vendor tests for required fields, envelopes and update behavior; reconcile version differences and contradictions. Neither proves the live tenant's configuration or deployment behavior. Keep live-only acceptance checks explicit, but move them off the critical path when the remaining design questions are already answered.
<!-- @@project-additions:end -->

## Phase 3: Assembly (Main Agent — direct authorship, not delegated)

Main Agent writes the TODO directly, not a subagent: it has the full context from Phase 1 and the Phase 2 research files.

### Template (all sections required)

```markdown
# TODO: {Title}

| Attribute | Value |
|-----------|-------|
| **Status** | Specification Complete |
| **Author** | {user} |
| **Created** | {YYYY-MM-DD} |

---

## Executive Summary

{2-3 sentences: what this TODO accomplishes and why}

---

## Dependency Graph

{ASCII art showing story dependencies and wave groupings}

---

## Seams and Main Flow

**Seams.** Each field, contract or file that crosses a story boundary (one story writes it, a later one reads it), defined once, with its meaning in each case (empty, missing, error, each mode). Only what crosses a boundary belongs here; leave out fields a single story owns. When the stories do not share a field, contract or file, write `none — {reason}`.

* **{Seam name}** — {what it is, who writes it, who reads it, what it means per case}

**Main flow, end to end.** {One walk of the main user or data flow through the stories, naming which story handles each step; one line for a single-surface plan. If a step has no owner, the plan has a gap.}

---

## Phase N: {Phase Name}

**Goal:** {One sentence}

---

### Epic {PREFIX}-N: {Epic Name}

**Objective:** {One sentence}

---

* **Story {PREFIX}-N.N ({Size}): {Story Title}**
  * **As a** {role}, **I want** {action}, **So that** {benefit}.
  * **AC:**
    * [ ] {Specific, testable acceptance criterion} verify: {one command that proves it} => exit 0
    * [ ] {Another specific criterion} verify: {one command that proves it} => exit 0
    * [ ] {A criterion only a person or CI can check} [manual]
  * **Estimate:** {XS|S|M|L}
  * **Complexity:** {1–10}
  * **Release:** {core | later}
  * **Risk tier:** {deep | standard} — {deep: why it is high-stakes, one line by surface, e.g. "money math" or "persisted shape"; standard: what it is, e.g. "wiring only"}
  * **Dependencies:** {None | Story X.X}
  * **After:** {optional: Story X.X, Story Y.Y this story only prefers to come after; omit the line when there is none}
  * **Files:**
    * `{exact/path/to/file}` — {what changes}
  * **Agent budget:** {N} modified, {M} created — within ≤5/≤2 cap
  * **Ownership:** production {agent type}; tests {owner per the repository's test-authorship rule | owning story ID}. A story whose Files match the subagent read-only tier (`guardrail:subagentReadOnlyPaths` in the guardrail rules yaml: the gate, hooks, settings, seal and receipt state, `ac-verify.js`, `commit.js` and the other judge files) names the Main Agent as its production owner, or states that the Main Agent applies a subagent's scratch-copy patch: a dispatched subagent cannot write those paths
  * **Research notes:** {What currently exists, what's missing, gotchas}
  * **Premise check:** {only when the story rests on a fact about the code: the command run and its result, or `UNCHECKED — {fact}; verify first in Wave {N}`}

---

## Story Index

| Story | Title | Size | Complexity | Release | Tier | Wave | Status | Dependencies |
|-------|-------|------|-----------|---------|------|------|--------|--------------|
| {PREFIX}-N.N | {title} | {XS/S/M/L} | {1–10} | {core/later} | {deep/standard} | {wave #} | [ ] | {deps} |

**Total: N stories (core {N}, later {N}). Estimated: ~N hours (core ~N).**

**`⚠ PROD-VERIFY-REQUIRED` marker:** if a story ships a behavior change whose safety depends on a fact only provable in staging or prod (a data-coverage query, a human sign-off, a volume check), tag its Status cell `⚠ PROD-VERIFY-REQUIRED` in addition to `[ ]`/`[x]`, in whichever wave it sits; an earlier-wave story can need the checkpoint even when only a later wave's text mentions it. `/run-todo` does not mark such a story's wave complete without surfacing that the checkpoint is outstanding.

---

## Owner Decisions

Every decision the owner must make that this plan can predict, so they are asked in one round before Wave 1 instead of stopping one wave at a time. `/todo` records them here and `/run-todo` asks them in one round; when `/todo` runs interactively with the owner present, it may ask then and record the answers. Write each decision in plain language with the outcome first (what happens for the owner, then the options). Write "none" when there are none.

| # | Decision | Options | Recommendation | Blocks |
|---|----------|---------|----------------|--------|
| 1 | {e.g. API scope names and who may grant them} | {A; B} | {A — why} | {story IDs} |

Check each category and list what applies: **run scope** (everything not blocked by a gate, or a named subset) and **whether to continue past the ship gate** when nothing outward is left; scopes and permissions; data exposure (what is shown, shared or exported, and to whom); release order and flag defaults; sourcing, licensing and notices; migration and deploy order (who applies migrations, and when); the evidence standard for performance or acceptance claims (real data or stand-in numbers); retention and deletion.

---

## Release Slices

- **Core slice:** {story IDs} — {the smallest release a user or operator can use on its own}
- **Ships on its own because:** {flags, routes, migrations, runbook and rollback that make the core slice releasable without any later story}
- **Later slice:** {story IDs, or "none — single slice: {one-sentence reason}"}
- **Resume trigger for later:** {the evidence or owner decision that justifies building it, e.g. "core in use for two weeks" or "owner asks for saved plans"}

---

## Wave Plan

**Shape:** {role-based | single-hotspot collapsed | file-overlap partitioned} — {one-sentence justification. If single-hotspot collapsed, also include: "Collapsed N original stories into M bundled stories by functional grouping."}

**Review cadence:** per-wave reviews, grouped by seam; mid-epic review after Wave {N} (the wave after which roughly half the work is done, or "none" under three waves); final review when the run completes — {one line: which waves hold `deep` stories and get the closer look, and where `security-auditor` applies per firm line 2 of the review cadence}

**Review groups:** {stories that share a seam, named: "{Group}: {IDs} — share {the field, contract or file}", or "none — no shared seams"}

### Wave 1 — {Tests | functional bundle name | independent stories}
| Story | Agent Type | Files Owned | Budget (mod/new) | Needs QA? |
|-------|-----------|-------------|------------------|-----------|
| {ID} | general-purpose | {files} | {n}/{m} | Yes/No |

### Wave 2 — {Code | next bundle | next independent group} (depends on Wave 1)
| Story | Agent Type | Files Owned | Budget (mod/new) | Needs QA? |
|-------|-----------|-------------|------------------|-----------|
| {ID} | general-purpose | {files} | {n}/{m} | Yes/No |

### Wave 3 — {Verify | final bundle | ...} (depends on Wave 2)
| Story | Agent Type | Files Owned | Budget (mod/new) | Needs QA? |
|-------|-----------|-------------|------------------|-----------|
| {ID} | general-purpose | {files} | {n}/{m} | Yes/No |

### Shared Hotspot Files
- **`{file}`** — touched by stories {X, Y}. Record serialized edits or a writer handoff within a wave, dependency-ordered waves, or separate-worktree integration. In single-hotspot shape: expected (this is the hotspot that drove collapse). Keep the path in backticks: `plan-check.js` reads backticked paths under this heading as acknowledged hotspots, so a same-wave overlap on one is a warning plus an isolation group (never an error, even under `--strict`).

### Critical Path & Parallel Workstreams (REQUIRED)
- **Critical path:** {Story → Story → Story} — the longest dependency chain; ~{hours} of summed story effort. No number of agents shortens it; elapsed time also includes dispatch, gate and review time, so do not report effort hours as elapsed time.
- **Parallel workstreams:** {N} independent chains that run concurrently — {chain A} ∥ {chain B} ∥ {chain C}. Shared-checkout writes have one active writer per file; separate worktrees may overlap with an explicit integration owner.
- **Max concurrent agents:** {N} (the widest wave).
- **Bottleneck:** {Story ID} — {why; e.g. it adds the interface every Wave-2 story consumes}. If it slips, everything downstream slips.

---

## Key Findings from Research

{Accepted facts, citations and scope decisions that execution relies on — copied here from the ignored research files, never only referenced}

1. **{Finding}** — {detail with file paths}
2. **{Finding}** — {detail}
```

### Template Rules

1. **Every story has AC bullets with checkboxes** — specific, testable, used as gates by `/do` and `/run-todo`
2. **Every story has a Files section** — researched starting paths, not guesses or an edit allowlist; apply the outcome-ownership contract in `.agents/startup.md` when execution discovers necessary files
3. **Every story has Research notes** — what exists now, patterns to follow, gotchas
4. **Every story has an Estimate** — XS (< 30 min), S (30-60 min), M (1-2 hr), L (2-4 hr)
4b. **Every story has a Complexity score (1–10)** — the persisted routing signal `/do` reads (see Complexity Score below). Wall-clock effort (Estimate) and routing complexity are distinct: a long-but-mechanical story is high-Estimate / low-Complexity.
5. **Story Index with wave column** — `/run-todo` reads this to know execution order. A wave number is a commitment: two stories of one declared wave that write the same file are an error in `plan-check.js --strict` (`WAVE_COLLISION`) unless that file is listed under Shared Hotspot Files, where the overlap is a warning plus an isolation group. Leave the cell `—` for a story whose wave `/run-todo` should derive: an overlap there is always a warning plus an isolation group.
6. **Wave Plan with file ownership, QA flag, Shape line and Review cadence line** — `/run-todo` reads this directly. The Shape and Review cadence lines are required (see Wave Shape Decision and Review cadence below).
7. **Coordinate writes for every Shape.** Shared-checkout files have one active writer at a time; overlaps use handoffs or serialized edits within a wave, and separate worktrees may overlap with explicit integration and conflict review. In `single-hotspot collapsed` shape the hotspot file appears across waves by design. Record any coordination and verification changes when starting assignments expand.
8. **Dependency Graph** — ASCII art showing what blocks what
9. **No code blocks** — file paths and descriptions only; implementation is the dev agent's job
10. **AC bullets are never stripped or summarized** — they flow verbatim into `/do` and `/run-todo`
11. **Every story carries an Agent budget line within the planning cap** — ≤5 files modified / ≤2 files created (tests count); split larger estimates into coherent sub-stories at authoring time. Budgets size planned work, not runtime edit permissions (see Per-Agent File Budget).
12. **Sub-story splits use sibling H2 headers (`## Story N.M.K`), never H3 nested under a wrapping H2** (see the split rule in Phase 2).
13. **Surface the project's recurring implementation constraints in the story's Research Notes at authoring time** — any constraint that has bitten implementers ≥2 times (per memory, retros, or project CLAUDE.md) is named in each affected story, since memory recall alone has proven insufficient. Typical shapes: a per-file registration/exports step with no barrel, a write-boundary guard set to re-visit by name on every related change, an expensive (AI/embedding) call ordered after every cheap check that could obviate it.
14. **Every story names production and test ownership, and no reviewer** — read the repository's actual test-authorship rule before assigning it; do not import another repository's rule. In this toolkit, `/run-todo` Step 2b has the Main Agent write AC tests before dev dispatch (with its documented one-round and cross-story test-ownership exceptions); dev agents own production edits. Review is planned per wave in the Wave Plan, not per story. A deviation from the actual rule is stated in the story, not hidden.
15. **Accepted evidence is portable** — accepted facts, citations, scope decisions and review evidence that execution relies on go into the TODO itself (Research notes, Key Findings) or another tracked doc. Research files under `docs/.output/.state/` are ignored scratch, never the sole execution authority a cold clone would lack.
16. **Project constraints land in the affected stories** — when Phase 1 verified project references, name the reference paths and verified constraints in each affected story's Research notes; omit them for toolkit or unrelated stories.
17. **Every story has a Release tag** — `core` or `later` (see Release Slices and Risk Tiers below).
18. **Every story has a Risk tier** — `deep` (high-stakes per Risk tier below, with a one-line reason) or `standard`. `/run-todo` and `/do` size tests and the closer review from it.
19. **Owner Decisions are listed up front** — every predictable owner decision, including run scope and whether to continue past the ship gate, with options, a recommendation and the stories it blocks. A story that depends on an open decision says `Blocked by: {decision}`. A numeric target the owner sets (performance, balance, cost, or a target measured over a batch of runs) is provisional until the untuned baseline is measured: the plan measures that before-set first and asks the question with the measurement in hand, and the decision row says "provisional until the baseline exists". A target fixed before anyone measured the starting point can be unreachable from the first run, and then the only levers left weaken what the target was meant to protect.
20. **Seams are defined once, and the main flow is walked once** — the Seams and Main Flow section covers every shared field, contract or file that later stories consume. A seam defined twice, or differently in two stories, is the planning bug that costs review fix rounds later.
21. **A story that rests on a fact about the code records the check that confirmed it** — the command and its result, in the story's Premise check line. A premise nobody checked is the most common cause of a mid-run deviation. When no research agent ran (a Small TODO), Main Agent runs the command itself; a fact that cannot be checked at planning time is written `UNCHECKED — {fact}; verify first in Wave {N}`.
22. **Every testable AC carries a `verify:` binding** — written inline on the AC checkbox bullet as `verify: <command> => exit N`, one command per criterion, with `=> exit 0` as the default when the suffix is omitted. `ac-verify.js` runs it and `ship-check.js` refuses a commit while it is unmet. The command starts with an allowlisted runner (`node`, `npx`, `npm`, `git`, `pytest`, `dotnet`, `cargo`, `go`) and names the test file or script that proves the criterion. Never put a checkbox marker (square brackets around a space or an x) inside the `verify:` text: `status.js` and `metrics.js` count one unanchored on every line under a story. A criterion no command can prove (UI judgment, a visual check, an owner decision) is tagged `[manual]`, and one only CI can run is tagged `[CI-pending]`; an untagged bullet with no `verify:` is a plan defect, not a manual criterion. The lowercase ASCII `verify:` is the only binding form; a variant spelling is an error in `todo-completion.js`, not a silent manual criterion. Check the bindings without running anything: `node .claude/core/ac-verify.js list --todo "{TODO_PATH}"` prints each story's parsed bindings (AC line, command, expected exit) and whether the command policy would refuse it, and exits non-zero when any binding is malformed or would be refused (`--stories A,B` narrows it). A binding whose `missing` list is non-empty names a file that neither exists nor appears in any story's Files: an invented script or test. Rebind it to a real file, add the file to the story that writes it, or tag the criterion `[manual]`. A test-name filter needs care when the root `package.json` script itself re-invokes a package manager (for example `"test": "cd src && npm run test"`): the nested npm swallows a filter placed after one `--`, every test runs and passes, and the criterion is recorded met although the filter never applied. Write the filter after a second `--`: `verify: npm run test -- app/x.test.ts -- -t "name"`. A script that runs the runner directly (`vitest run`) takes the single-`--` form; `ac-verify.js` refuses the single-`--` form for a nested-npm script. Only the script's last command segment counts: `"test": "npm run build && vitest run"` takes the single-`--` form. `node --test` and `go test` report a name filter that matches nothing as a passing run, so `ac-verify.js` refuses `node --test-name-pattern` and `go test -run`: bind one test file (`node --test path/to/ac1.test.js`) or one package (`go test ./pkg`) per criterion.
23. **`**Dependencies:**` means "needs output of"** — a story lists another only when it consumes something that story produces (a file, a field, a contract, a passing behavior). An ordering habit, a shared theme or "it reads better after" is not a dependency. `/run-todo` and `plan-check.js` treat every Dependencies entry as hard: the dependency sits in a strictly earlier wave and must be done before this story starts.
24. **`**After:**` is soft ordering, never a hard dependency** — an optional line between Dependencies and Files naming stories this one merely prefers to follow, written in the nested-bullet shape of the template. It never forces a wave, never blocks a story, never raises a dependency error and is not a Story Index column (an extra column breaks the index parse); `plan-check.js` reads it only to break ties in the order of ready stories. Omit the line when nothing applies.

---

### Complexity Score (1–10) — canonical rubric

Every story carries a persisted `**Complexity:** {1–10}` field, the routing signal of record: `/do` reads it to choose Main Agent direct vs delegated (Complexity ≤5 → Main Agent direct; ≥6 → delegate), and `/review:optimize-backlog` can reason over it. Scoring at authoring time makes the size/route decision auditable instead of re-judged on every `/do` run.

Score from the same signals `/do` uses to size a task: files touched, new LOC, AC-bullet count, and nature (mechanical vs ambiguous):

| Score | Band | Signals |
|-------|------|---------|
| 1–3 | Trivial/Small | ≤2 files modified, <150 new LOC, ≤4 AC bullets, mechanical spec→code |
| 4–5 | Medium | ≤5 files, <500 LOC, ≤8 AC, mostly mechanical |
| 6–7 | Large | >5 files OR ≥500 LOC OR >8 AC, some ambiguity |
| 8–10 | Complex | multi-component, cross-cutting, multiple valid approaches |

Complexity is distinct from Estimate: Estimate is wall-clock effort, Complexity is routing/ambiguity, so a 2-hour purely mechanical refactor is high-Estimate, low-Complexity (≤5, stays Main Agent direct). This is the single source of truth for the score; `/create:project-epics-todo` references this rubric.

---

### Release Slices and Risk Tiers (Main Agent — decide before the Wave Plan)

**Release slice.** Tag each story `core` or `later`. The core slice is the smallest set a user or operator can use once it ships: the engine and the screens or commands that expose it, the flags, routes, migrations and runbook it needs, and nothing that waits on demand. Owner storage, saved state, measurement, admin tooling and polish are `later` unless the core cannot be used without them. Rules:
- The core slice ships on its own, and no core story depends on a later story.
- Every core wave runs before the first later wave; no wave mixes the two.
- A release, runbook or acceptance story that covers several slices is split: its core part is `core`, and each later part travels with its slice.
- A TODO small enough to ship in one piece may be all core; say so in Release Slices ("none — single slice: {reason}") instead of tagging by habit.
- `/run-todo` stops at a ship gate when the core slice is done and builds `later` stories only after the owner's explicit go.

**Risk tier.** `deep` marks a high-stakes story: one where a mistake costs money, data or access. Data means loss, corruption or exposure of stored user data, not any write. This is the one definition; `/run-todo`, `/do` and the epic checklists point here. Write a one-line reason by surface (for example "money math", "persisted shape and validation", "who can delete", "number shown to the user", "guard on every route"). The values stay `deep` and `standard` because `release-slice.js` parses them; `deep` now means high-stakes with a stated reason. Everything else is `standard`.

The `code-review` skill's `references/review-cadence.md` says what a review is for and which surfaces deserve one: code, guards and scripts, persisted shapes and input validation, offline and data-loss paths, displayed numbers, global styling, the first use of a contract. Judge by what the story can break, not by its size, its label or how important it feels. Risky stories often look like wiring (a guard added to every layout, a flag check before credentials load, a cache stamp in the worker entry, the rollback target in a runbook). Prose, docs and seed data are `standard`. When the project has a risk map (`code-review` skill, `references/playbook.md`), a HIGH-risk path is `deep`.

**Pin contracts, not tuning.** Exact-value assertions belong on contracts: values that other code, other systems or users rely on (money, the output a seeded RNG gives for a seed, wire and storage formats, public signatures, access decisions, ordering guarantees). Everything else (thresholds, tuning numbers, content tables, copy, layout, config defaults, case counts) is asserted as an invariant or bound (stays in range, never negative, monotonic, the same input gives the same output), because those values are expected to change and an exact pin turns every change into a test rewrite. This applies in every tier and project, and keeps the `deep` list short in fast-iterating products (a game, a prototype) where most values are not contracts yet. For a game the strict list is seeded RNG and determinism, update ordering, currency, pause and modal state, lifecycle and disposal, and persistence; content tables, tuning numbers, effect values, layout and copy are `standard`.
- Browser specs for layout and copy are tagged `@volatile`; per-story gates skip them and the milestone gates run them (`/run-todo` Step 5).
- Mutation and oracle runs cover the files that carry the surface that made the story high-stakes, not its whole diff.
- Soak and survival harnesses report a balance signal (deaths, win rate, time to clear) and fail only on crashes, hangs and broken invariants, never on balance drift.

**Review cadence.** Reviews follow `references/review-cadence.md` in the `code-review` skill: per wave grouped by seam, one mid-epic and one final. `/todo` plans them: the Wave Plan's Review cadence line, review groups for stories that share a seam, and a `deep` tier with a reason where a closer look is due. No story names its own reviewer. An executing agent may raise a story's tier when it finds a reason and records it; it lowers a tier only with the owner's agreement.

---

### Wave Shape Decision (Main Agent — apply before writing the Wave Plan)

Choose the shape that minimizes ceremony for the TODO's story composition, then record starting file assignments and active-writer coordination within each wave. Evaluate in this order and pick the first that fits:

**Shape A — Single-hotspot collapsed (check first).** Triggers when ALL stories would touch the same hotspot file AND no story is > M AND dependencies are strictly linear (story N depends on N−1). Collapse adjacent small stories into bundled M-size stories until there are at most 3 waves, ordered by **functional grouping** (e.g., "Layout + card shell" / "Form chrome" / "Footer + E2E coverage"), not by arbitrary story count.

  - Target: 2–3 bundled stories, 2–3 waves.
  - **Required warning line in the Executive Summary:** `Wave shape: single-hotspot collapsed — collapsed {N_original} stories into {M_bundled} bundled stories by functional grouping. File-overlap partitioning would have produced {N_original} forced-serial waves.`
  - Why: under pure file-overlap partitioning a one-hotspot TODO forces `waves = stories`, paying full per-wave machinery (commits, handoff regen, gate runs, review cycles) for no parallelism benefit.
  - **Planning budget still applies:** author bundles within the initial ≤5/≤2 estimate by splitting larger work into coherent stories. During execution, necessary file expansion follows `.agents/startup.md`; update estimates and resequence when needed.

**Shape B — Role-based (Tests / Code / Verify) — the default for heterogeneous TODOs.** When stories span multiple files and conceptual areas and none of them qualifies for Shape A, organize as three role-scoped waves:
  - **Wave 1 — Tests:** one story per eventual feature that authors failing tests from AC, under the repository's test-authorship rule. Coordinate shared test files before parallel dispatch.
  - **Wave 2 — Code:** implementation stories that make the Wave 1 tests pass. Parallel dispatch uses one active writer per shared-checkout file, or separate worktrees with explicit integration and conflict review.
  - **Wave 3 — Verify:** AC verification, E2E coverage, and the final commit; the wave's review follows the Review cadence line.

  `/run-todo`'s per-wave TDD rhythm (Step 2b) still applies within each role-wave, with little redundancy because Wave 1 is solely about tests.

**Shape C — File-overlap partitioned (fallback).** Use when neither A nor B fits: deeply interdependent stories spanning many files where role-splitting creates artificial couplings, or where story-level AC is so heterogeneous that bundling under roles would lose reviewability.

**Release order applies to every shape.** Order waves so every core wave finishes before the first later wave. Shape A bundles and Shape B role-waves are formed within a slice, never across it.

**Declare the chosen shape in the Wave Plan heading** so `/run-todo` and human reviewers can see the intent:
- `## Wave Plan` + `**Shape:** single-hotspot collapsed — ...`
- `## Wave Plan` + `**Shape:** role-based (Tests / Code / Verify) — ...`
- `## Wave Plan` + `**Shape:** file-overlap partitioned — ...`

If the research agent flagged single-hotspot in Phase 2 and you chose a different shape, the Executive Summary must include a one-sentence rationale (e.g., "Single-hotspot detected but not collapsed because two stories are M and exceed the collapse threshold").

---

## Phase 3b: Self-Review — No Placeholders (Main Agent — always run)

Before handing off to external review, scan your own output for plan failures and fix any you find before proceeding. This 30-second scan catches 3-5 issues every time.

**Automatic failure conditions (fix immediately):**
- [ ] Any story contains "TBD", "TODO", "to be determined", or "placeholder"
- [ ] Any story says "similar to Story X" without specifying exact differences
- [ ] Any AC bullet says "properly", "correctly", "as needed", or "appropriate" without measurable criteria, or says "add error handling" without specifying which errors
- [ ] Any `verify:` line contains a checkbox marker (square brackets around a space or an x), holds more than one command, or is written in a variant form (capital `Verify:`, a full-width colon, wrapped in backticks)
- [ ] Any Template Rule is violated: a story missing its Files (from research, not guessed paths), Research notes, Estimate, **Complexity** score, **Agent budget**, **Ownership** line (production and test owners only; a story that names its own reviewer fails, as does a test owner contradicting the repository's actual test-authorship rule without a stated deviation), **Release** tag or **Risk tier** (a `deep` tier needs its one-line reason); an estimate above the planning cap (> 5 files modified or > 2 created) not split into coherent sub-stories
- [ ] Wave Plan is missing the **Shape** line (role-based | single-hotspot collapsed | file-overlap partitioned), the **Review cadence** line, the **Review groups** line, or the **Critical Path & Parallel Workstreams** block; or two stories that share a seam are not in one review group
- [ ] In `single-hotspot collapsed` shape: Executive Summary is missing the required warning line (collapsed N → M stories) OR any bundled story is larger than M
- [ ] Research Agent 1 flagged single-hotspot but Main Agent chose a different shape without a one-sentence rationale in the Executive Summary
- [ ] A story on a high-stakes surface (see Risk tier) is tagged `standard`, or a `deep` story has no stated reason
- [ ] The **Seams and Main Flow** section is missing, a shared field, contract or file that a later story consumes is not defined once there (or is defined differently in two stories), or the end-to-end walk has a step no story owns
- [ ] A story rests on a fact about the code with no recorded **Premise check** (command and result)
- [ ] The **Release Slices** section is missing, or the core slice has no "ships on its own" evidence
- [ ] The **Owner Decisions** section is missing, a predictable decision from its category list is not in it (including run scope and continuing past the ship gate), or a decision has no recommendation or no blocked stories
- [ ] A story incorporates, ports or vendors third-party code or data without a recorded build-vs-vendor and license decision (ADR or brief), and is not marked `Blocked by` the open decision
- [ ] A story keeps a superseded artifact (an abandoned approach's docs, manifests or code) instead of deleting it

**Mechanical plan checks (structural — run against the written file, not from memory):**

- [ ] Story/index parity — every story in the body appears in the Story Index and every index row has a body story; split sub-stories are sibling H2 headers so `status.js --regen-master` counts them
- [ ] Dependencies — every Dependencies ID exists, and no story depends on a story in the same or a later wave
- [ ] Budget — every Agent budget line matches its Files list and stays within ≤5 modified / ≤2 created
- [ ] Path collisions — no shared-checkout file has two active writers (shared files have handoffs/serialized edits, or a separate-worktree integration plan)
- [ ] Forward outputs — a story that reads or edits a file another story creates sits in a later wave than its creator
- [ ] Critical path — the stated chain is the longest dependency chain, its hours are summed story effort, and nothing reports them as elapsed time
- [ ] Verify bindings — every testable AC has a `verify:` command or is tagged `[manual]` or `[CI-pending]`: `grep -nE '^ *\* \[ \] ' "{TODO_PATH}" | grep -vE 'verify:|\[manual\]|\[CI-pending\]'` prints nothing
- [ ] Binding policy — `node .claude/core/ac-verify.js list --todo "{TODO_PATH}"` exits 0: every `verify:` binding parses and its command would be accepted by the ac-verify policy (it executes nothing, so a refused binding is found at authoring time rather than at `red` or `run`), and no binding reports a `missing` path
- [ ] Plan structure — `node .claude/core/plan-check.js "{TODO_PATH}" --strict` exits 0: story/index parity, unknown or same-wave dependencies, Files and Agent budget agreement, same-wave path collisions and forward outputs are all clean (`After` is soft ordering and never raises a finding)
- [ ] Release slices — `node .claude/core/release-slice.js "{TODO_PATH}" --strict` exits 0: every Story Index row has a `core`/`later` Release and a `deep`/`standard` Tier, a core slice exists, no core story depends on a later story, and no later wave starts before the last core wave

These checks prove the plan's structure only, never that a story's AC is correct, satisfiable or met; that is the spec-bug checks below and execution-time evidence.

**Spec-bug checks (wrong output, not just incomplete):**

These run inline in the same scan, with no subagent round-trip (source: code-review severity rubric).

- [ ] AC-satisfaction — does each story's impl description match what the AC *says*, not just that tests exist? (A passing test shaped to the wrong output is still wrong.)
- [ ] Edge cases — does any AC bullet imply a boundary condition (empty input, max value, concurrent access) the story body doesn't address?
- [ ] Error paths — if an AC mentions an error scenario ("returns 404", "shows an error message", "rejects invalid input"), is that path explicitly handled in the story's scope?
- [ ] Contract mismatches — does the impl's proposed interface (types, return values, event shapes, parameter order) match what callers described in research or adjacent stories expect?

---

## Phase 4: Review (`standard` tier — Large TODOs only, 8+ stories)

Skip for Small (1-4); use judgment for Medium (5-7).

Dispatch a fresh, independent reviewer with the persisted scope (the written TODO path, the research files, the source paths the stories name, verified project constraints and architecture reference paths) rather than this conversation's context, so it judges the plan as written. It runs once, with no closure pass.

```
Agent(
  subagent_type: "code-reviewer",
  prompt: """
  Review the TODO at {path} for execution readiness.
  Persisted scope: {research file paths}, {source paths named in the stories}
  Project constraints: {selected project reference paths and verified project constraints, or "none"}

  ## Coverage
  1. Every AC is specific and testable (no "properly", "correctly", "as needed")
  2. File lists name the researched starting scope; necessary expansion follows .agents/startup.md and is not rejected merely for being unlisted
  3. Missing error/empty/loading states in ACs

  ## Structure
  4. Wave groupings coordinate shared-checkout writers; handoffs/serialized edits or separate-worktree integration cover shared files
  5. Dependencies are correct — no story depends on something in a later wave
  6. ACs don't contradict each other across stories

  ## Seams, premises and owner decisions
  7. Every field, contract or file that a later story consumes is defined once in Seams and Main Flow, with its meaning per case; walk the main flow end to end and name any step no story owns
  8. Every story that rests on a fact about the code records the check that confirmed it; spot-check two by running the command
  9. List any owner decision a story will hit that is missing from Owner Decisions, including run scope and continuing past the ship gate
  10. Flag any story that brings in third-party code or data without a recorded build-vs-vendor and license decision

  ## Release, risk and review cadence
  11. The core slice can ship and be used on its own; flag later-tagged work the core needs, and core-tagged work it does not
  12. Every high-stakes story (per Risk tier) is `deep` with a one-line reason, and a `deep` with no reason is wrong, including wiring-shaped stories on the shared request pipeline, release flags or rollback procedure; docs, evidence compilation and UI copy are `standard`
  13. The Review cadence line and review groups fit `references/review-cadence.md` in the `code-review` skill, and no story names its own reviewer

  Write findings to: docs/.output/.state/work/{YYYY-MM-DD}/{slug}/{HHMM}-review.md
  DO NOT edit the TODO file.
  """,
  description: "Review TODO for {slug}"
)
```

---

## Phase 5: Synthesis (Main Agent)

Read the review findings and decide what to accept. Apply accepted findings to the TODO directly and rerun the Phase 3b checks; do not send them back to a reviewer. Record accepted findings, their resolution and any rejected finding with its reason in the TODO's Key Findings, because the review file under `docs/.output/.state/` is ignored scratch. Main Agent is the single author of the TODO: review agents advise, Main Agent decides.

---

## Phase 6: Report

```markdown
## /todo Complete

**TODO:** {path} ({N} stories, ~{N} estimated hours)
**Release slices:** core {N} stories (~{N} h) → ship gate → later {N} stories (~{N} h)
**Risk tiers:** deep (high-stakes) {N}, standard {N}
**Review cadence:** per wave, mid-epic after Wave {N} or none, final; review groups {N}
**Owner decisions:** {N} recorded; `/run-todo` asks them in one round before Wave 1
**Research:** `docs/.output/.state/work/{YYYY-MM-DD}/{slug}/` ({N} files)

### Story Breakdown
| Wave | Slice | Stories | Sizes | Est. Hours |
|------|-------|---------|-------|------------|
| 1 | core | {IDs} | {sizes} | {hours} |
| 2 | later | {IDs} | {sizes} | {hours} |

### Ready for execution:
  /run-todo {path}
  /do {first-story-id}
```

---

## Phase 7: Regenerate the session handoff — session-handoff skill

After the report, refresh the session handoff using the **`session-handoff`** skill (`.claude/skills/session-handoff/SKILL.md`); a TODO missing from the handoff is not picked up by the next session's `/prime`. Resolve this run's path once and reuse it for the `git add` in Phase 8:

```bash
HANDOFF=$(node .claude/core/handoff-path.js write todo)
```

The skill has the template, rules, and `/todo`-specific tailoring (Step 4 in the skill). The handoff's Next Actions point at `/run-todo {path}` as #1. The TODO path goes in Key Files (subject to compact resume below); research files are never Key Files.

**Compact resume.** When the TODO exceeds the session-handoff Key Files ceiling (over 20kb per file, or a set over ~15k tokens), do not list it as a Key File. List a compact companion brief instead only when a tracked one already exists (for example a module brief, or the `/run-todo` plan on a resumed TODO); at `/todo` time there usually is none, so list no Key File for the TODO and let Next Actions #1 (`/run-todo {path}`) name it for on-demand reading. A brief never restates or summarizes AC; resume reads them verbatim from the full TODO. Research files under `docs/.output/.state/` are mentioned in Decisions & Context for on-demand reuse, never as the only record (Template Rule 15).

---

## Phase 8: Commit

Write the commit message to `docs/.output/.state/.commit-msg`:

```
docs: /todo — create TODO for {slug} ({N} stories)
```

Then run (in Codex, use `node .codex/core/commit.js`):

```bash
git add {TODO_PATH} "$HANDOFF"
node .claude/core/commit.js
```

Stage exactly these tracked files; the research and review files under `docs/.output/.state/` are gitignored scratch, and their accepted content is already in the TODO (Template Rule 15). Commit only through the native commit helper, and do not push, open a PR or take any other outward action without explicit authorization.

---

## Rules

Each phase carries its own rules; these are the cross-cutting ones.

1. **Main Agent is the single author.** It assembles the TODO directly; research agents scan and review agents advise, and Main Agent decides story breakdown and wave grouping.
2. **The TODO is a contract.** ACs are never stripped, simplified or summarized, file lists come from scanned code, and the wave plan is pre-computed so `/run-todo` need not work out parallelism.
3. **Always finish with the handoff (Phase 7) and the commit (Phase 8).**
