# Create TODO Epic — Per-Epic Implementation Checklist

Generate `docs/work/todo/TODO_epicNN_{slug}.md` — the tech-lead view of a single epic. Contains story-level task checkboxes, dependency metadata, track assignments, and bottleneck annotations. This is what `/do` and `/run-todo` consume during implementation.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:project-epics-todo
```

## Relationship to Other Commands

```
/create:project-epics       →  docs/work/backlog.md          (raw epic definitions)
/create:project-todo       →  docs/TODO_{Project}.md       (master index — epic-level)
/create:project-epics-todo          →  docs/work/todo/TODO_epicNN.md     (THIS — story-level tasks)
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle gate checks and epic identification. The `project-planner` agent handles checklist generation. Do NOT write the checklist inline — delegate via Task tool.

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
- If YOLO_MODE → warn: "No backlog found. Proceeding in yolo mode." → continue
- Otherwise → **STOP**: "`docs/work/backlog.md` has not been created yet. Run `/create:project-epics` first. Use `--yolo` to bypass this gate."

#### 1c. Optional reads
- `docs/architecture/overview.md` — for tech stack and project structure context
- `docs/TODO_*.md` (master index) — for optimization data and cross-epic dependencies

### 2. Identify Target Epic(s) (main agent)

**If INPUT is a number (e.g., "3"):**
- Find Epic 3 in `backlog.md`
- If not found → ask user to clarify

**If INPUT is "all":**
- Identify all epics in `backlog.md`
- Warn: "This will generate {N} checklist files. Proceed?"

**If no INPUT:**
- Show list of epics and ask which one to generate
- Highlight epics that don't have a checklist yet

### 3. Check for Existing Checklist (main agent)

For each target epic:
- Check if `docs/work/todo/TODO_epic{NN}_{slug}.md` already exists
- If exists → ask: **update** (refresh from current `backlog.md`) or **replace**?

**Also check for misplaced/superseded epic TODOs (F17).** The existence check above only looks at the canonical `docs/work/todo/` path, so an older plan's epic TODOs at a non-canonical path (e.g. `docs/work/TODO_epic00_*.md`, or a different slug) are invisible — generating fresh files leaves them orphaned. Before generating, run the drift detector and reconcile anything it reports:

```bash
node .claude/core/_lib/doc-drift.js
```

If it reports **misplaced TODO files**, tell the user and offer to remove/relocate them (or fold into `/onboard`'s Step 6b reconcile) so the project doesn't end up with two competing sets of epic checklists.

### 4. Extract Epic Context (main agent)

From `docs/work/backlog.md`, extract for the target epic:
1. **Epic metadata**: number, name, objective, phase
2. **All stories**: ID, title, persona/capability/benefit, acceptance criteria, domain tag, estimate, dependencies
3. **Cross-epic dependencies**: stories in this epic that depend on stories in other epics
4. **Optimization data** (if available): which stories are on critical path, which are bottlenecks, which parallel track they belong to

### 5. Delegate Checklist Generation (main agent → project-planner)

Use the Task tool with `subagent_type: "project-planner"`.

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow runs no build gate; its evidence is the written checklist passing Step 6 validation against `docs/work/backlog.md` and the Step 7 commit hash. The checklist's Validation section names the application's own build and test commands in an adopter, never the Domdhi.Agents toolkit suite, also after agent-file edits; in Domdhi.Agents itself it names the toolkit's Node build and Vitest suite. Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran; report completion only from that evidence.

**Task prompt must include**:
1. Epic number and name
2. Output path: `docs/work/todo/TODO_epic{NN}_{slug}.md`
3. All stories with full details from Step 4
4. Architecture context (tech stack, project structure)
5. Optimization data (critical path, parallel tracks, bottlenecks)
6. The `project-planner` agent auto-loads the `project-planning` skill via frontmatter.
7. Instruction to follow the checklist template from `/todo` command format
9. The repository's actual test-authorship rule, read before dispatch (in this toolkit, `/run-todo` Step 2b: the Main Agent writes AC tests before dev dispatch, with its documented one-round exceptions), so each story's Ownership line matches it

**The agent must produce a checklist following the `/todo` template structure:**

```markdown
# Epic {N}: {Epic Name} - Implementation Checklist

**Parent Document**: [TODO_{Project}.md](../../TODO_{Project}.md)
**Phase**: {N} — {Phase Name}
**Status**: Not Started
**Stories**: {N}.1 - {N}.{M}
**Last Updated**: {YYYY-MM-DD}

---

## Executive Summary

{Brief description of what this epic delivers — 2-3 sentences}

### Key Deliverables
- {Deliverable 1}
- {Deliverable 2}
- {Deliverable 3}

---

## Optimization Summary

### Critical Path ({X}h, {N} stories)
```
Story {N}.{A} → Story {N}.{B} → Story {N}.{C}
```
{One-line explanation}

### Bottleneck Stories (High Fan-Out)
| Story | Title | Dependents | Blocked Hours |
|-------|-------|------------|---------------|
| {N}.{X} | ... | {count} | ~{X}h |

### Parallel Workstreams
| Track | Key Stories | Est. Hours |
|-------|-------------|-----------|
| A: ... | {N}.1–{N}.{M} | {X}h |

### Wave Plan
Concrete wave grouping `/run-todo` consumes directly (R4) — derived from the
critical path + parallel workstreams above, but materialized as a table so the
executor doesn't have to recompute it from prose. **Rule: zero file overlap
within a wave** (two stories that edit the same file go in separate waves, even
with no logical dependency), and respect dependency order across waves.

| Wave | Stories | Strategy | Files Owned (no overlap within a wave) |
|------|---------|----------|----------------------------------------|
| 1 | {N}.1 | direct (1 story) | {files} |
| 2 | {N}.{x} | direct / parallel | {files} |
| 3 | {N}.{y} + {N}.{z} | parallel (disjoint surfaces) | {y: files} \| {z: files} |

> If two stories share a file (e.g. both edit `content.js`), they MUST be in
> different waves — that's file contention, not a logical dependency. Note such
> serialization groups explicitly so the executor doesn't parallelize them.

---

## Execution Log

| # | Story | Date(s) | Session | Notes |
|---|-------|---------|---------|-------|
| - | - | - | - | Not started |

---

## Key Decisions

(Decisions will be logged as they occur during implementation)

---

## AI Task Management Protocol

1. **Review Current State:** Examine the entire TO-DO list.
2. **Identify Progress:** Note which tasks are marked as `[x]` (Completed) and which are `[ ]` (Pending).
3. **Prioritize & Select:** Choose the next logical `[ ]` task to address based on dependency order.
4. **Execute Task:** Perform the development work required.
5. **Update TO-DO List:** Upon completion, change the task's status to `[x]`.
6. **Document Changes:** Update relevant documentation.

---

**Key:**
* `[ ]` - Task Pending
* `[x]` - Task Completed
* `[>]` - Task In Progress
* `[~]` - Task Deferred
* `[!]` - Task Blocked
* `[*]` - Task Persistent/Ongoing
* `[B]` - Backend Responsibility
* `[C]` - Complex task (may need breakdown)

---

## Context

- **Epic**: Epic {N}: {Name}
- **Phase**: Phase {P}: {Phase Name}
- **Checklist location**: `docs/work/todo/TODO_epic{NN}_{slug}.md`
- **Related docs**: [backlog.md](../backlog.md), [architecture/overview.md](../../architecture/overview.md)
- **Dependencies**: {Cross-epic dependencies}
- **Critical Rules**: {Architecture constraints relevant to this epic}

---

## Story {N}.1: {Story Title} {CRITICAL PATH|BOTTLENECK}

**Dependencies:** None | Story {N}.{X}
**Unblocks:** Story {N}.{X}, Story {N}.{X}
**Track:** {A (track name)}
**Domain:** {Backend|Frontend|DevOps|...}
**Estimate:** {S|M|L|XL}
**Complexity:** {1–10}  <!-- persisted routing signal `/do` reads; score per the canonical rubric in `/todo` (≤5 → Opus-direct, ≥6 → Sonnet-delegate). Distinct from Estimate (wall-clock effort). -->
**Ownership:** production {agent type}; tests {owner per the repository's test-authorship rule | owning story ID}; review {fresh independent reviewer}

**As a** {persona}, **I want** {capability}, **So that** {benefit}.

**Acceptance Criteria:**
- {AC 1}
- {AC 2}

**Tasks:**
- [ ] {Task description — WHAT to do, not HOW}
  - [ ] {Sub-task if needed}
- [ ] {Another task}

---

## Story {N}.2: {Story Title}
...

---

## Validation

- [ ] Build succeeds: `{project build command}`
- [ ] Tests pass: `{project test command}`
- [ ] Documentation updated
- [ ] Patterns extracted to memory (if applicable)

---

## Work Document References

| Date | Document | Story | Topic |
|------|----------|-------|-------|
| - | - | - | Not started |

---

## Dependencies to Next

{What completing this epic enables — which epics or features become unblocked}

---

**Last Updated:** {YYYY-MM-DD}
```

### 6. Validate (main agent)

After the agent completes, verify:
- All stories from the epic in `backlog.md` are present
- Stories are in dependency-optimized order
- Acceptance criteria match `backlog.md` (not invented)
- No code blocks or implementation examples (WHAT, not HOW)
- Required sections all present (Execution Log, Key Decisions, Validation, Work Doc References)
- Every story has an Ownership line consistent with the repository's actual test-authorship rule
- Mechanical plan checks pass: every Dependencies/Unblocks ID exists, no wave depends on a later wave, no file is owned by two stories in one wave, and a story that consumes a file another story creates sits in a later wave. These are structural checks, not proof that any AC is met; critical-path hours are effort, not elapsed time
- If issues found, delegate back to agent to fix

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage each file created or modified by its exact path and commit through the native commit helper (`node .claude/core/commit.js`, or `node .codex/core/commit.js` in Codex) with a descriptive message. Do not push, open a PR or take any other outward action without explicit authorization.

### 8. Report (main agent)

```markdown
## Epic Checklist Created

**Output**: docs/work/todo/TODO_epic{NN}_{slug}.md
**Epic**: {N} — {epic name}
**Phase**: {phase name}
**Stories**: {count} ({S count} S, {M count} M, {L count} L)
**Critical path stories**: {count}
**Bottleneck stories**: {count}

**Committed**: {hash} — `docs: /create:project-epics-todo — Epic {N}: {name}`
**Next step**: Run `/do` to implement the first available story, or `/create:project-epics-todo {N+1}` for the next epic.
```

## Output Rules

1. Use status markers as defined in Key
2. Reference files as paths or `file.cs:line` format
3. Link docs with markdown links `[Name](path)`
4. **NEVER include code blocks, code snippets, or implementation examples**
5. Focus on WHAT to do, not HOW to do it
6. Include ALL sections even if empty (for consistency with `/do` and `/review:organize`)
7. **Stories MUST be in dependency-optimized order**
8. **Every story MUST include Dependencies, Unblocks, Track, Domain, Estimate, and Complexity metadata** (Complexity = the 1–10 routing score `/do` reads — score it per the canonical rubric in `/todo`, never restate that rubric here)
9. Acceptance criteria MUST match `backlog.md` exactly — do not paraphrase or invent new ones
10. **Every story MUST include an Ownership line** naming production, test and review ownership per the repository's actual test-authorship rule (see `/todo` Template Rules)
