# Create TODO Project — Master Implementation Index

Generate `docs/TODO_{ProjectName}.md` — the project-manager view of implementation. Tracks phases, epic status, critical path, parallel workstreams, and phase gates. Does NOT contain story-level task checkboxes — those live in per-epic checklists.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:project-todo
```

## Relationship to Other Commands

```
/create:project-epics       →  docs/work/backlog.md          (raw epic definitions — source of truth)
  ↓
/create:project-todo       →  docs/TODO_{Project}.md       (master index — epic-level status)
  ↓
/create:project-epics-todo          →  docs/work/todo/TODO_epicNN.md     (per-epic checklists — story-level tasks)
  ↓
/do | /run-todo     →  picks next story, implements, updates checklist
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle gate checks, project name discovery, and epic status extraction. The `project-planner` agent handles index generation. Do NOT write the index inline — delegate via Task tool.

**Agent**: `project-planner` (via Task tool with `subagent_type: "project-planner"`)

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Check Prerequisites (main agent)

#### 1a. Check --yolo flag
If `$ARGUMENTS` contains `--yolo`, set YOLO_MODE = true. Strip `--yolo` from INPUT before continuing.

#### 1b. Hard Gate: Require real Epics
Read the first line of `docs/work/backlog.md`. Check that it exists AND does not contain `<!-- @@template -->`.

**If `backlog.md` is missing or template-only:**
- If YOLO_MODE → warn: "No backlog found. Proceeding in yolo mode." → continue (index will be minimal)
- Otherwise → **STOP**: "`docs/work/backlog.md` has not been created yet. Run `/create:project-epics` first. Use `--yolo` to bypass this gate."

#### 1c. Optional reads
- `docs/architecture/overview.md` — for package boundaries and tech stack (only if real, not template)
- `docs/product/requirements.md` — for project name fallback

### 2. Discover Project Name (main agent)

Determine project name from (in priority order):
1. INPUT argument (if provided and not `--yolo`)
2. `docs/product/context.md` — look for "Project Name" field
3. `docs/product/brief.md` — look for "Project Name" field
4. Git repo directory name (fallback)

Use PascalCase for the filename (e.g., "Visual Cockpit" → `TODO_VisualCockpit.md`).

### 3. Check for Existing Index (main agent)

- Glob for `docs/TODO_*.md` (at docs root, not in `docs/work/todo/`)
- If a master index already exists → ask: **update** (refresh from current `backlog.md`) or **replace**?
- If replacing, confirm with user (this is destructive if implementation is in progress)

#### 3a. Structural-mismatch guard (F16)

"Update" runs the **lightweight patch protocol** (Step 11) — it patches per-epic status in place; it does NOT regenerate structure. That is only safe when the existing index and the current `backlog.md` describe the **same plan**. If the backlog has been re-planned since the index was written (e.g. a 5-epic/14-story March index against a 9-epic/40-story current backlog), patching one onto the other silently corrupts the index.

Before offering update-vs-replace, compare the **shape** of the existing index against `backlog.md`:
- **Epic count** — number of epics in the index's Epic Index table vs epics in `backlog.md`
- **Story count** — total stories in the index vs total stories in `backlog.md`
- **Phase set** — the Phase Map's phase IDs vs the backlog's `## Phase` headings
- **Epic ID overlap** — do the index's epic IDs still exist in the backlog?

If any of these differ materially (epic/story counts off by more than a rounding nudge, phase set changed, or epic IDs no longer match), the existing index is **structurally superseded**. In that case:
- Do NOT present "update" as the default/Recommended option — it would patch a mismatched structure.
- Tell the user exactly what changed ("existing index: 5 epics/14 stories across 4 phases; current backlog: 9 epics/40 stories across 8 phases — the index is from an older plan") and recommend **replace**.
- Only offer "update" when the shapes match (same phase set, same epic IDs, story counts within ±1 per epic from in-flight status edits).

### 4. Extract Epic Data (main agent)

Read `docs/work/backlog.md` and extract:
1. **All phases** with their names and goals
2. **All epics** with: number, name, objective, story count, total estimate
3. **Per-story status**: count `[ ]` vs `[x]` per epic to compute completion
4. **Cross-epic dependencies**: stories in one epic that depend on stories in another
5. **Compute per-phase stats**: total epics, total stories, completed, remaining

### 5. Check for Optimization Data (main agent)

Look for optimization annotations in `backlog.md` (added by `/review:optimize-backlog`):
- Critical path markers
- Parallel workstream markers
- Bottleneck annotations

If no optimization data exists, note this — the index will use phase order instead of optimized order.

### 6. Delegate Index Generation (main agent → project-planner)

Use the Task tool with `subagent_type: "project-planner"`.

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow runs no build gate; its evidence is the written index passing Step 7 validation against `docs/work/backlog.md` and the Step 8 commit hash. Phase gates that name build or test evidence use the application's own commands in an adopter, never the Domdhi.Agents toolkit suite, also after agent-file edits. Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran; report completion only from that evidence.

**Task prompt must include**:
1. Project name (PascalCase)
2. Output path: `docs/TODO_{ProjectName}.md`
3. All extracted epic data from Step 4
4. Optimization data from Step 5 (if available)
5. Architecture package boundaries (if `architecture/overview.md` exists)
6. The `project-planner` agent auto-loads the `project-planning` skill via frontmatter.
7. Instruction to read `docs/work/backlog.md` for full context

**The agent must produce an index with these sections:**

```markdown
# TODO: {Project Name}

> Master implementation index. Generated by `/create:project-todo`.
> Source of truth for story content: `docs/work/backlog.md`
> Last updated: {YYYY-MM-DD}

---

## Phase Map

| Phase | Name | Goal | Epics | Stories | Done | Status |
|-------|------|------|-------|---------|------|--------|
| 0 | Foundation | {goal} | 2 | 6 | 0 | PENDING |
| 1 | Core | {goal} | 3 | 12 | 0 | PENDING |
| ... | ... | ... | ... | ... | ... | ... |
| **Total** | | | **{N}** | **{N}** | **{N}** | **{%}%** |

---

## Epic Index

| Epic | Title | Stories | Est. Hours | Status | Checklist |
|------|-------|---------|-----------|--------|-----------|
| 1 | {Epic Name} | 4 | 5.5h | [ ] | [TODO](work/todo/TODO_epic01_{slug}.md) |
| 2 | {Epic Name} | 6 | 12h | [ ] | [TODO](work/todo/TODO_epic02_{slug}.md) |
| ... | ... | ... | ... | ... | ... |

> **Status key:** `[ ]` Not started · `[>]` In progress · `[x]` Complete

---

## Cross-Epic Dependencies

{Dependencies between epics — which epics must complete before others can start}

| Blocked Epic | Depends On | Blocking Story | Reason |
|-------------|-----------|----------------|--------|
| Epic 5: Auth | Epic 2: API | Story 2.3 | Needs API client for auth endpoints |

---

## Optimization Summary

{If /optimize-backlog has run:}

### Critical Path
```
Epic 2 (Story 2.1) → Epic 3 (Story 3.2) → Epic 5 (Story 5.1) → ... → total {N}h
```
{The longest dependency chain — controls minimum project duration}

### Bottleneck Stories
| Story | Title | Epic | Dependents | Blocked Hours |
|-------|-------|------|------------|---------------|
| 2.3 | API Client | Core API | 8 stories | ~16h |

### Parallel Workstreams
| Track | Package(s) | Epics | Est. Hours |
|-------|-----------|-------|-----------|
| A: Runtime | @project/runtime | 2, 3, 5 | 24h |
| B: Frontend | @project/gui | 10, 11, 12 | 36h |
| C: Types | @project/types | 1, 2 | 8h |

{If /review:optimize-backlog has NOT run:}
> Run `/review:optimize-backlog` for dependency graph analysis, critical path, and parallel workstream recommendations.

---

## Phase Gates

| Gate | Condition | Verified |
|------|-----------|----------|
| Phase 0 → 1 | All foundation epics complete | [ ] |
| Phase 1 → 2 | Core data models + API scaffolding done | [ ] |
| ... | ... | [ ] |

---

> **Next steps:**
> - Run `/create:project-epics-todo all` to generate all per-epic checklists
> - Or run `/create:project-epics-todo {N}` for a single epic
> - Then `/do` to begin implementation
```

### 7. Validate (main agent)

After the agent completes, verify:
- Phase Map totals are correct (spot-check against extracted data)
- Epic Index has entries for every epic in `backlog.md`
- Checklist links use correct naming and location: `work/todo/TODO_epicNN_{slug}.md`, relative to the index at the `docs/` root
- Cross-Epic Dependencies are real (not invented) and every referenced epic and story ID exists in `backlog.md`
- Critical-path hours are summed story effort along the chain, labeled as effort, not elapsed time
- If issues found, delegate back to agent to fix

These checks are structural: they prove the index matches the backlog, not that any story's acceptance criteria are met.

### 8. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage each file created or modified by its exact path and commit through the native commit helper (`node .claude/core/commit.js`, or `node .codex/core/commit.js` in Codex) with a descriptive message. Do not push, open a PR or take any other outward action without explicit authorization.

### 9. Report (main agent)

```markdown
## Master Index Created

**Output**: docs/TODO_{ProjectName}.md
**Project**: {project name}
**Phases**: {count}
**Epics**: {count}
**Stories**: {total} ({done} complete, {remaining} remaining)
**Cross-epic dependencies**: {count}

**Committed**: {hash} — `docs: /create:project-todo — {summary}`
**Next step**: Run `/create:project-epics-todo all` to generate per-epic checklists.
```

## Lightweight Status Update

Other commands update the master index after epic-level changes. This is the lightweight update protocol — it patches status, it does NOT regenerate.

### Update Protocol (for `/do` and `/run-todo`)

After completing a story:

1. **Find the master index**: Glob for `docs/TODO_*.md` (at docs root, not `docs/work/todo/`)
2. **If no index exists**: Skip — the user hasn't run `/create:project-todo` yet
3. **Update the Epic Index row**: Increment "Done" count in the Stories column for the epic. If all stories in the epic are done, change status from `[>]` to `[x]`.
4. **Update Phase Map**: Recalculate "Done" count for the phase. If all epics in the phase are `[x]`, update Phase status to COMPLETE and check the Phase Gate.
5. **Update "Last updated" date**
6. **DO NOT regenerate** the full index — just patch the specific cells. For a full refresh, the user should run `/create:project-todo` again.
