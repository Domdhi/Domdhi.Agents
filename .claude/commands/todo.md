---
description: Create an execution-ready TODO checklist with AC, file lists, research, and wave plan
argument-hint: [task description, file path, or module name]
---

<!-- Generated from .agents/skills/todo/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# /todo — Create Execution-Ready TODO

Create a TODO checklist that `/run-todo` can execute without additional research. Every story has acceptance criteria, file lists, estimates, and research notes. Dependencies are optimized, waves are pre-computed.

Main Agent does all planning and assembly. Research agents (`standard` tier) scan the codebase. The output is a contract — `/run-todo` trusts it completely.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

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

**Next-epic resolution (empty INPUT — the lifecycle "what now?" loop).** When INPUT is empty and the conversation gives no specific target, consult the master index before falling back to the handoff/git heuristics. This is the source of truth no command previously read for "what's next," and it's what makes the post-`/evolve` loop self-continue (the lead epic is made ready by `/evolve` Step 5.6; *subsequent* epics get picked up here):
1. Find the master index — `docs/TODO_{Project}.md` (the single `TODO_*.md` at the `docs/` root, not the per-epic files under `docs/work/todo/`). If absent or an unfilled `<!-- @@template -->` stub, skip to inference source #3.
2. Parse its epic rows and pick the **next** epic: prefer an **in-progress** epic (🔄 / partially-checked) if one exists — resume it — otherwise the **first not-done** epic (⬜ / `[ ]` todo, in index order). Skip ✅/`[x]` done epics. If every epic is done, say so (the cycle is complete → suggest `/evolve`) and stop.
3. Resolve that epic to its **epic number** and hand off to the **epic-number branch** above (read Epic N's stories from `backlog.md`). Announce the resolution in the report so it's never silent: `No INPUT given — resolved next epic from master index: Epic {N} — {title}.`
This is deterministic and respects the same `backlog.md` source the epic-number branch uses; the handoff/git fallbacks (#3/#4) remain for repos without a master index.

**Epic-number branch (check before treating INPUT as a task description).** INPUT is an epic number when the **entire trimmed INPUT is exactly one integer token** (`12` — but NOT `12 factor app setup`, a multi-token input that merely *starts* with a number, which is a task description), or it matches an `epic N` / `epic-N` / `epicNN` / `EX-NN` style epic identifier (case-insensitive). When it is:
1. Read `docs/work/backlog.md` and locate that epic's section (its heading + story list). If `backlog.md` is missing or is still an unfilled `<!-- @@template -->` stub, fall back to treating INPUT as a literal task description and note it.
2. If the epic isn't found in `backlog.md`, say so and list the epic numbers that *do* exist — do not silently treat the number as a task description.
3. Use that epic's title + objective + stories as the brief. The epic's stories become the seed stories for the TODO (research still resolves exact file paths per story in Phase 2 — the backlog gives titles/AC intent, not file lists).
4. This mirrors `/create:project-epics-todo`'s epic-aware resolution; `/todo {epic}` is the single-epic, execution-ready unit that `/evolve` Step 5.6 calls for the lead epic.

### 2. Gather Project Context

Read in parallel:
- `docs/architecture/overview.md` — architecture boundaries, schemas, ADRs
- Module docs: `docs/modules/{module}/brief.md` (if module-scoped)

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow runs no build gate; its evidence is the written TODO passing the Phase 3b self-review and mechanical checks, accepted review findings applied in Phase 5, the Phase 7 handoff and the Phase 8 commit hash. Every story's verification names the application's own build and test commands in an adopter, never the Domdhi.Agents toolkit suite, also after agent-file edits; in Domdhi.Agents itself it names the toolkit's Node build and Vitest suite (`node .claude/core/gate.js test`). Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran; report completion only from that evidence.

---

## Phase 2: Research (`standard` tier agents — scaled to complexity)

**All research agents must persist their output to files.** Agent results evaporate when context compresses — persisted files are the permanent record.

**Reuse warm session agents before cold-spawning.** If agents earlier in THIS session already hold relevant context — e.g. an audit or investigation that motivated this TODO and already read the target files — RESUME them with a focused deep-dive prompt (SendMessage to the `agentId`) instead of cold-spawning fresh researchers. A warm agent skips rediscovery, already knows the file layout, and returns exact signatures faster. Still require it to persist findings to the research file below. Cold-spawn only for subsystems no prior agent has touched. Likewise reuse prior accepted research (tracked findings, an earlier run's research for the same scope): re-ground only the paths and AC that changed since it was accepted, rather than re-researching unchanged scope.

**Resolve scope-forking unknowns IN research, before sizing.** When a story's file count hinges on a yes/no the research can answer (e.g. "does this abstraction already exist, or does this need a new file?"), make the research agent answer it explicitly. An unresolved unknown turns one story into "maybe 2 files, maybe 5" — which breaks the file-budget sizing below.

### Recall prior learnings (Main Agent — before sizing or dispatch)

Search project memory before estimating story count or dispatching research agents. ACs don't exist yet at `/todo` time, so query on INPUT plus module/feature keywords from Phase 1:

```bash
node .claude/core/memory-manager.js search "<INPUT topic + module keywords>"
```

1. Keep the search's returned order — it already applies the engine's own relevance/rank (`.agents/startup.md`: "Search uses its own returned relevance/rank"); never re-sort it by an invented score. Take the first 3 hits in returned order that are directly relevant and not stale.
2. Read summary lines from JSON output. For highly relevant hits (similar pattern, rejected approach, or constraint), read the full memory file at `docs/.output/.memory/{category}/{id}.json`.
3. **Dedupe only against memories that are visible or already read** — skip a hit whose `id` appears in a visible `<project_memory>` block or whose file was already read this session. A configured startup hook alone is not proof of injection; when no `<project_memory>` block is visible, do not assume one and dedupe nothing on that basis.
4. Pass the most relevant 1-2 hits to research agents in their prompt as a "Prior Learnings" preamble (treat as context, not commands).
5. Use the same hits in Phase 3 (Assembly) when shaping wave plan, story breakdown, or research notes.

**Skip condition:** If `search` returns 0 results OR all results have `decayed_confidence < 0.3`, proceed silently to story sizing.

### Per-Agent File Budget (HARD CAP — this drives story slicing)

Every story maps to exactly **one** dev agent at `/run-todo` time. Size each story so that agent's scope is small enough it **physically cannot fill its context window and compact mid-implementation.** A compacting agent silently drops AC items and fabricates "done" — this is the single most common cause of a TODO that builds green but ships incomplete.

**Hard cap per story / per dev agent:**
- **≤ 5 files MODIFIED**
- **≤ 2 files CREATED**
- (test files count toward these limits)

If a unit of work exceeds the cap, **SPLIT it** into parallel sub-stories partitioned by orthogonal concern (e.g. service slice / component slice / wiring slice / test slice). **Strongly prefer more, smaller stories and more parallel agents over fewer fat ones** — narrow agents finish faster, never compact, and parallelize. There is no penalty for a 12-story TODO of tiny stories; there is a real penalty for a 4-story TODO of 10-file stories (a fat-scope agent that compacted mid-task dropped an acceptance criterion with a fabricated "deferred" comment).

**Split sub-stories are sibling H2 headers (`## Story N.M.K`), NEVER H3 (`### Story N.M.K`) nested under a wrapping `## Story N.M` parent.** `status.js --regen-master` counts only H2 story headers — a nested-H3 split is structurally invisible to the master index (Stories/Hours undercount). When splitting, delete or demote the wrapping parent header so it isn't double-counted.

Every story MUST carry an **Agent budget** line (files modified / files created) so the cap is auditable before dispatch. The self-review (Phase 3b) fails the plan if any story exceeds it.

### Estimate Story Count First

Slice to the file budget FIRST (above), THEN count the resulting stories. This determines how many *research* agents scan the codebase. Bias toward the higher row when borderline — granular is the goal:

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

**Use `general-purpose` (NOT `Explore`) — Explore is read-only and cannot write its findings to disk, which means output evaporates on context compaction.**

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
  4b. **Verify every path before recording it — never assume a directory layout.** A module is often NOT where its conceptual name implies (e.g. several `.claude/core/` modules actually live under `.claude/core/_lib/` after a refactor). Probe subdirectories explicitly and confirm each path resolves: e.g. `find .claude/core -name '*.js' -not -path '*__tests__*' -not -path '*_helpers*'`, then diff that output against any path you were about to hardcode. A wrong path in the TODO costs every dispatched agent a discovery round. (Field-proven: a coverage epic mis-pathed 4 `_lib/` modules; 3 agents each burned a rediscovery round.)

  ## Dependency Analysis
  5. Map every file each proposed change would touch
  6. Identify overlaps — which files appear in multiple changes?
  7. Build dependency graph — which changes must complete before others?
  8. **Hotspot detection:** identify any file that would be touched by 3+ stories. If ALL stories share a single hotspot file, flag the TODO as single-hotspot — Main Agent will apply the collapse shape in Phase 3.
  9. Compute candidate wave groupings under both shapes: (a) file-overlap partitioning (zero overlap per wave) and (b) functional grouping for single-hotspot collapse. Leave the final shape decision to Main Agent.
  10. **Shared-git-index check:** if a wave's stories each run `git mv` / `git rm` / `git add` on the SAME working tree, they contend on `.git/index.lock` even when their files are disjoint — disjoint files ≠ disjoint git state. Flag such a wave `git-serial`: it must execute Main Agent direct sequentially, NOT as parallel agents, regardless of file-overlap partitioning. (Field-proven: skill-owned-templates Wave 2, six disjoint `git mv` migrations — ran sequential to avoid index-lock races.)

  Write findings to: docs/.output/.state/work/{YYYY-MM-DD}/{slug}/{HHMM}-research-codebase.md
  """,
  description: "Research codebase for {slug}"
)
```

### Agent 2: Pattern + Convention Scanner (Large only — 8+ stories)

**Use `general-purpose` (NOT `Explore`) — same reason as Agent 1.**

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

Main Agent writes the TODO directly. Do NOT delegate assembly to a subagent — Main Agent has the full context from Phase 1 + Phase 2 research files.

### Template (ENFORCED — all sections required)

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

## Phase N: {Phase Name}

**Goal:** {One sentence}

---

### Epic {PREFIX}-N: {Epic Name}

**Objective:** {One sentence}

---

* **Story {PREFIX}-N.N ({Size}): {Story Title}**
  * **As a** {role}, **I want** {action}, **So that** {benefit}.
  * **AC:**
    * [ ] {Specific, testable acceptance criterion}
    * [ ] {Another specific criterion}
  * **Estimate:** {XS|S|M|L}
  * **Complexity:** {1–10}
  * **Dependencies:** {None | Story X.X}
  * **Files:**
    * `{exact/path/to/file}` — {what changes}
  * **Agent budget:** {N} modified, {M} created — within ≤5/≤2 cap
  * **Ownership:** production {agent type}; tests {owner per the repository's test-authorship rule | owning story ID}; review {fresh independent reviewer}
  * **Research notes:** {What currently exists, what's missing, gotchas}

---

## Story Index

| Story | Title | Size | Complexity | Wave | Status | Dependencies |
|-------|-------|------|-----------|------|--------|--------------|
| {PREFIX}-N.N | {title} | {XS/S/M/L} | {1–10} | {wave #} | [ ] | {deps} |

**Total: N stories. Estimated: ~N hours.**

**`⚠ PROD-VERIFY-REQUIRED` marker:** if a story ships a behavior change whose safety depends on a fact only provable in staging/prod (a data-coverage query, a human sign-off, a volume check) — tag its Status cell `⚠ PROD-VERIFY-REQUIRED` in addition to `[ ]`/`[x]`, regardless of which wave it's in. Don't rely on "gated on prod verification" language attached only to a LATER wave (e.g. a deferred final-wave retirement step) to imply earlier waves carry no such gate — an earlier-wave story can independently need the same checkpoint (e.g. a Wave 2 story ships a financial- or data-integrity-affecting behavior change while the TODO's gating language only calls out a later wave as "gated on prod verification" — the earlier wave's own risk goes unflagged). `/run-todo` should not mark a `⚠ PROD-VERIFY-REQUIRED` story's wave "complete" without surfacing that the checkpoint is still outstanding.

---

## Wave Plan

**Shape:** {role-based | single-hotspot collapsed | file-overlap partitioned} — {one-sentence justification. If single-hotspot collapsed, also include: "Collapsed N original stories into M bundled stories by functional grouping."}

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
- **{file}** — touched by stories {X, Y}. In file-overlap shape: must be in different waves. In single-hotspot shape: expected (this is the hotspot that drove collapse).

### Critical Path & Parallel Workstreams (REQUIRED)
- **Critical path:** {Story → Story → Story} — the longest dependency chain; ~{hours} of summed story effort. No number of agents shortens it; elapsed time also includes dispatch, gate and review time, so do not report effort hours as elapsed time.
- **Parallel workstreams:** {N} independent chains that run concurrently — {chain A} ∥ {chain B} ∥ {chain C}. Each chain owns a disjoint file set.
- **Max concurrent agents:** {N} (the widest wave).
- **Bottleneck:** {Story ID} — {why; e.g. it adds the interface every Wave-2 story consumes}. If it slips, everything downstream slips.

---

## Key Findings from Research

{Accepted facts, citations and scope decisions that execution relies on — copied here from the ignored research files, never only referenced}

1. **{Finding}** — {detail with file paths}
2. **{Finding}** — {detail}
```

### Template Rules (NON-NEGOTIABLE)

1. **Every story has AC bullets with checkboxes** — specific, testable, used as gates by `/do` and `/run-todo`
2. **Every story has a Files section** — exact paths from codebase research, not guesses
3. **Every story has Research notes** — what exists now, patterns to follow, gotchas
4. **Every story has an Estimate** — XS (< 30 min), S (30-60 min), M (1-2 hr), L (2-4 hr)
4b. **Every story has a Complexity score (1–10)** — the persisted routing signal `/do` reads (see Complexity Score below). Wall-clock effort (Estimate) and routing complexity are distinct: a long-but-mechanical story is high-Estimate / low-Complexity.
5. **Story Index with wave column** — `/run-todo` reads this to know execution order
6. **Wave Plan with file ownership, QA flag, and Shape line** — `/run-todo` reads this directly. Shape line is required (see Wave Shape Decision below).
7. **File overlap constraint depends on the Shape** — in `file-overlap partitioned` shape, zero overlap per wave is mandatory. In `single-hotspot collapsed` shape, the hotspot file appears across waves *by design*. In `role-based` shape, overlap is allowed at the role-wave level but stories within a role-wave have zero overlap when dispatched in parallel.
8. **Dependency Graph** — ASCII art showing what blocks what
9. **No code blocks** — file paths and descriptions only. Implementation is the dev agent's job
10. **AC bullets are NEVER stripped or summarized** — they flow verbatim into `/do` and `/run-todo`
11. **Every story carries an Agent budget line within the HARD CAP** — ≤5 files modified / ≤2 files created (tests count). Split anything larger into parallel sub-stories. Bias toward more, smaller stories + more agents.
12. **Sub-story splits use sibling H2 headers (`## Story N.M.K`), never H3 nested under a wrapping H2** — `status.js --regen-master` only counts H2 headers (see the SPLIT rule above).
13. **Surface the project's recurring implementation constraints in the story's Research Notes at authoring time** — any constraint that has bitten implementers ≥2 times (per memory, retros, or project CLAUDE.md) gets named explicitly in each affected story's Research Notes; memory recall alone has proven insufficient for implementers. Typical shapes: a per-file registration/exports step with no barrel, a write-boundary guard set that must be re-visited by name on every related change, an expensive (AI/embedding) call that must be ordered after every cheap check that could obviate it.
14. **Every story names production, test and review ownership** — read the repository's actual test-authorship rule before assigning it; do not import another repository's rule. In this toolkit, `/run-todo` Step 2b has the Main Agent write AC tests before dev dispatch (with its documented one-round and cross-story test-ownership exceptions); dev agents own production edits; a fresh independent reviewer owns review. A deviation from the actual rule is stated in the story, not hidden.
15. **Accepted evidence is portable** — accepted facts, citations, scope decisions and review evidence that execution relies on go into the TODO itself (Research notes, Key Findings) or another tracked doc. Research files under `docs/.output/.state/` are ignored scratch: useful for reuse, never the sole execution authority a cold clone would lack.
16. **Project constraints land in the affected stories** — when Phase 1 verified project references, name the applicable reference paths and the verified project constraints in each affected story's Research notes; omit them for toolkit or unrelated stories.

---

### Complexity Score (1–10) — canonical rubric

Every story carries a persisted `**Complexity:** {1–10}` field. This is the **routing signal of record**: `/do` reads it to choose Main Agent direct vs delegated (Complexity ≤5 → Main Agent direct; ≥6 → delegate), and `/review:optimize-backlog` can reason over it. Scoring it at authoring time makes the size/route decision **auditable** instead of re-judged ad-hoc on every `/do` run.

Score from the same signals `/do` uses to size a task — files touched, new LOC, AC-bullet count, and nature (mechanical vs ambiguous):

| Score | Band | Signals |
|-------|------|---------|
| 1–3 | Trivial/Small | ≤2 files modified, <150 new LOC, ≤4 AC bullets, mechanical spec→code |
| 4–5 | Medium | ≤5 files, <500 LOC, ≤8 AC, mostly mechanical |
| 6–7 | Large | >5 files OR ≥500 LOC OR >8 AC, some ambiguity |
| 8–10 | Complex | multi-component, cross-cutting, multiple valid approaches |

Complexity is **distinct from Estimate**: Estimate is wall-clock effort, Complexity is routing/ambiguity. A 2-hour but purely mechanical refactor is high-Estimate, low-Complexity (≤5 → stays Main Agent direct). This is the single source of truth for the score; `/create:project-epics-todo` references this rubric rather than restating it.

---

### Wave Shape Decision (Main Agent — apply before writing the Wave Plan)

Wave shape is not always file-overlap partitioning. Choose the shape that minimizes ceremony for the TODO's story composition, then fill in file ownership as a constraint within each wave.

Evaluate in this order and pick the first that fits:

**Shape A — Single-hotspot collapsed (check first).** Triggers when ALL stories would touch the same hotspot file AND no story is > M AND dependencies are strictly linear (story N depends on N−1). Collapse adjacent small stories into bundled M-size stories until there are at most 3 waves, ordered by **functional grouping** (e.g., "Layout + card shell" / "Form chrome" / "Footer + E2E coverage"), not by arbitrary story count.

  - Target: 2–3 bundled stories, 2–3 waves.
  - **Required warning line in the Executive Summary:** `Wave shape: single-hotspot collapsed — collapsed {N_original} stories into {M_bundled} bundled stories by functional grouping. File-overlap partitioning would have produced {N_original} forced-serial waves.`
  - Why: under pure file-overlap partitioning, one-hotspot TODOs force `waves = stories`. That pays full per-wave machinery (commits, handoff regen, gate runs, review cycles) for zero parallelism benefit. Field-measured cost on a 6-story single-hotspot TODO: ~30 min total, ~15 min pure ceremony, ~80k context on orchestration, and no offsetting speedup.
  - **Budget still applies:** each bundled story must respect the ≤5/≤2 file cap. If a functional bundle would exceed it, keep it split even though that forces an extra serial wave — correctness (no compaction) beats ceremony savings.

**Shape B — Role-based (Tests / Code / Verify) — the default for heterogeneous TODOs.** When stories span multiple files and conceptual areas and none of them qualifies for Shape A, organize as three role-scoped waves:
  - **Wave 1 — Tests:** one story per eventual feature that authors failing tests from AC. These stories have no file-overlap with each other (one test file per feature) and dispatch in parallel.
  - **Wave 2 — Code:** implementation stories that make the Wave 1 tests pass. Zero file-overlap within the wave; parallel dispatch.
  - **Wave 3 — Verify:** AC verification, E2E coverage, code review, and final commit.

  This replaces the old "file-overlap is the only partitioning rule" default. `/run-todo`'s per-wave TDD rhythm (Step 2b) still applies *within* each role-wave, but redundancy is minimized because Wave 1 is explicitly and solely about tests.

**Shape C — File-overlap partitioned (fallback).** Use when neither A nor B fits — deeply interdependent stories spanning many files where role-splitting creates artificial couplings, or where story-level AC is so heterogeneous that bundling under roles would lose reviewability. Historical default; remains available.

**Always declare the chosen shape in the Wave Plan heading** so `/run-todo` and human reviewers can see the intent:
- `## Wave Plan` + `**Shape:** single-hotspot collapsed — ...`
- `## Wave Plan` + `**Shape:** role-based (Tests / Code / Verify) — ...`
- `## Wave Plan` + `**Shape:** file-overlap partitioned — ...`

If the research agent flagged single-hotspot in Phase 2 and you chose a different shape anyway, the Executive Summary must include a one-sentence rationale (e.g., "Single-hotspot detected but not collapsed because two stories are M and exceed the collapse threshold").

---

## Phase 3b: Self-Review — No Placeholders (Main Agent — always run)

Before handing off to external review, Main Agent scans its own output for plan failures. If ANY of these are found, fix them before proceeding.

**Automatic failure conditions (fix immediately):**
- [ ] Any story contains "TBD", "TODO", "to be determined", or "placeholder"
- [ ] Any story says "similar to Story X" without specifying exact differences
- [ ] Any AC bullet says "properly", "correctly", "as needed", or "appropriate" without measurable criteria
- [ ] Any AC bullet says "add error handling" without specifying which errors
- [ ] Any story is missing the Files section or has only guessed paths (not from research)
- [ ] Any story is missing Research notes
- [ ] Any story is missing an Estimate
- [ ] Any story is missing its **Complexity** score (1–10) — the persisted routing signal `/do` reads
- [ ] Any story references an undefined story ID in Dependencies
- [ ] Wave Plan is missing the **Shape** line (role-based | single-hotspot collapsed | file-overlap partitioned) — required for every TODO
- [ ] In `file-overlap partitioned` shape: any wave has file overlap between stories (must be zero)
- [ ] In `single-hotspot collapsed` shape: Executive Summary is missing the required warning line (collapsed N → M stories) OR any bundled story is larger than M
- [ ] Research Agent 1 flagged single-hotspot but Main Agent chose a different shape without a one-sentence rationale in the Executive Summary
- [ ] Story Index is missing stories that appear in the body
- [ ] Any story exceeds the HARD CAP (> 5 files modified or > 2 files created) — split it into parallel sub-stories
- [ ] Any story is missing its **Agent budget** line
- [ ] Wave Plan is missing the **Critical Path & Parallel Workstreams** block
- [ ] Any story is missing its **Ownership** line, or its test owner contradicts the repository's actual test-authorship rule without a stated deviation

**This is a 30-second scan that catches 3-5 issues every time.** Do not skip it.

**Mechanical plan checks (structural — run against the written file, not from memory):**

- [ ] Story/index parity — every story in the body appears in the Story Index and every index row has a body story; split sub-stories are sibling H2 headers so `status.js --regen-master` counts them
- [ ] Dependencies — every Dependencies ID exists, and no story depends on a story in the same or a later wave
- [ ] Budget — every Agent budget line matches its Files list and stays within ≤5 modified / ≤2 created
- [ ] Path collisions — per the declared Shape, no unintended file is owned by two stories dispatched in parallel
- [ ] Forward outputs — a story that reads or edits a file another story creates sits in a later wave than its creator
- [ ] Critical path — the stated chain is the longest dependency chain, its hours are summed story effort, and nothing reports them as elapsed time

These checks prove the plan's structure only. They never prove that a story's AC is correct, satisfiable or met; that semantic proof is the spec-bug checks below and execution-time evidence.

**Spec-bug checks (wrong output, not just incomplete):**

These run inline as part of the same scan — no subagent round-trip. Source: code-review severity rubric (wrong behavior, not just missing structure).

- [ ] AC-satisfaction — does each story's impl description match what the AC *says*, not just that tests exist? (A passing test shaped to the wrong output is still wrong.)
- [ ] Edge cases — does any AC bullet imply a boundary condition (empty input, max value, concurrent access) the story body doesn't address?
- [ ] Error paths — if an AC mentions an error scenario ("returns 404", "shows an error message", "rejects invalid input"), is that path explicitly handled in the story's scope?
- [ ] Contract mismatches — does the impl's proposed interface (types, return values, event shapes, parameter order) match what callers described in research or adjacent stories expect?

---

## Phase 4: Review (`standard` tier — Large TODOs only, 8+ stories)

Skip for Small (1-4). Use judgment for Medium (5-7).

Dispatch a **fresh, independent** reviewer: give it the persisted scope (the written TODO path, the research files, the source paths the stories name and verified project constraints and architecture reference paths), not this conversation's context, so it judges the plan as written. Keep its `agentId`: after Phase 5 applies accepted findings, resume the **same reviewer** to confirm each finding is closed, rather than spawning a new one.

```
Agent(
  subagent_type: "code-reviewer",
  prompt: """
  Review the TODO at {path} for execution readiness.
  Persisted scope: {research file paths}, {source paths named in the stories}
  Project constraints: {selected project reference paths and verified project constraints, or "none"}

  ## Coverage
  1. Every AC is specific and testable (no "properly", "correctly", "as needed")
  2. File lists are complete — no story references files outside its list
  3. Missing error/empty/loading states in ACs

  ## Structure
  4. Wave groupings have zero file overlap (check file ownership)
  5. Dependencies are correct — no story depends on something in a later wave
  6. ACs don't contradict each other across stories

  Write findings to: docs/.output/.state/work/{YYYY-MM-DD}/{slug}/{HHMM}-review.md
  DO NOT edit the TODO file.
  """,
  description: "Review TODO for {slug}"
)
```

---

## Phase 5: Synthesis (Main Agent)

Read the review findings. Decide what to accept. Apply accepted findings to the TODO file directly, then resume the same Phase 4 reviewer to confirm closure of each accepted finding. Record the accepted findings, their resolution and any rejected finding with its reason in the TODO's Key Findings, because the review file under `docs/.output/.state/` is ignored scratch.

Main Agent is the single author of the TODO — review agents advise, Main Agent decides.

---

## Phase 6: Report

```markdown
## /todo Complete

**TODO:** {path} ({N} stories, ~{N} estimated hours)
**Research:** `docs/.output/.state/work/{YYYY-MM-DD}/{slug}/` ({N} files)

### Story Breakdown
| Wave | Stories | Sizes | Est. Hours |
|------|---------|-------|------------|
| 1 | {IDs} | {sizes} | {hours} |
| 2 | {IDs} | {sizes} | {hours} |

### Ready for execution:
  /run-todo {path}
  /do {first-story-id}
```

---

## Phase 7: Regenerate the session handoff — session-handoff skill

After the report, refresh the session handoff using the **`session-handoff`** skill (`.claude/skills/session-handoff/SKILL.md`). Resolve this run's path once and reuse it for the `git add` in Phase 8:

```bash
HANDOFF=$(node .claude/core/handoff-path.js write todo)
```

Read that skill for the template, rules, and `/todo`-specific tailoring (Step 4 in the skill).

**Why:** a newly-created TODO is "ready to execute." The handoff's Next Actions should point at `/run-todo {path}` as #1 so the next session's `/prime` immediately surfaces what to do next. The TODO path goes in Key Files (subject to compact resume below); research files are never Key Files.

**Compact resume.** When the TODO exceeds the session-handoff Key Files ceiling (over 20kb per file, or a set over ~15k tokens), do not list it as a Key File. List a compact companion brief instead only when a tracked one already exists (for example a module brief, or the `/run-todo` plan on a resumed TODO); at `/todo` time there usually is none, so list no Key File for the TODO and rely on Next Actions #1 (`/run-todo {path}`) to name it for on-demand reading. A brief never restates or summarizes AC; resume reads them verbatim from the full TODO. Research files under `docs/.output/.state/` are mentioned in Decisions & Context for on-demand reuse, never relied on as the only record (Template Rule 15).

---

## Phase 8: Commit

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /todo — create TODO for {slug} ({N} stories)
```

Then run (in Codex, use `node .codex/core/commit.js`):

```bash
git add {TODO_PATH} "$HANDOFF"
node .claude/core/commit.js
```

Stage exactly these tracked files. The research and review files under `docs/.output/.state/` are gitignored scratch, so they are not staged; their accepted content is already in the TODO (Template Rule 15). Commit only through the native commit helper, and do not push, open a PR or take any other outward action without explicit authorization.

---

## Rules

1. **Main Agent assembles the TODO directly** — do not delegate assembly to a planner agent. Main Agent has the full context.
2. **Research agents scan, Main Agent synthesizes** — agents find files and patterns, Main Agent makes decisions about story breakdown and wave grouping.
3. **ACs are sacred** — never strip, simplify, or summarize acceptance criteria. They are the contract.
4. **File lists come from code, not guessing** — research agents scan the actual codebase for paths.
5. **Wave plan is pre-computed** — `/run-todo` should not have to figure out parallelism.
6. **The TODO is a contract** — `/run-todo` and `/do` trust it completely. If it's wrong, they fail.
7. **No code blocks in stories** — file paths and descriptions only. Implementation is the dev agent's job.
8. **Always regenerate the session handoff (Phase 7) and commit (Phase 8).** A newly-created TODO that isn't surfaced in the handoff won't be picked up by the next session's `/prime`. Use the `session-handoff` skill (path via `handoff-path.js write todo`).
9. **Per-agent file budget is a HARD CAP** — ≤5 files modified / ≤2 files created per dev agent. More small stories + more parallel agents beats fewer fat ones. No background agent should ever compact mid-implementation.
10. **Reuse warm session agents when they already hold the context** — resume via SendMessage over cold-spawn; still persist findings to the research file.
11. **Ownership is explicit and grounded** — every story names production, test and review ownership per the repository's actual test-authorship rule (Template Rule 14).
12. **Review is fresh, closure is warm** — a fresh independent reviewer reads the persisted scope; the same reviewer confirms finding closure (Phase 4/5).
13. **Accepted evidence lives in tracked docs** — ignored scratch is never the sole execution authority (Template Rule 15).
14. **Mechanical checks are structural** — they never stand in for semantic AC proof, and effort hours are never reported as elapsed time (Phase 3b).
15. **Commits are exact and local** — stage exact tracked files, commit through the native commit helper, and take no outward action without authorization (Phase 8).
