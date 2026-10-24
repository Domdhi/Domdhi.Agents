---
description: Break requirements into epics and stories for implementation
argument-hint: [project name or architecture path] [--yolo]
---

<!-- Generated from .agents/skills/create-project-epics/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Create Epics

Break product requirements into implementable epics and stories. Produces `docs/work/backlog.md`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:project-epics
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle upstream checks and requirement analysis. The `project-planner` agent handles epic/story breakdown. Do NOT write the epics document inline — delegate via Task tool.

**Agent**: `project-planner` (via Task tool with `subagent_type: "project-planner"`)

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Check Upstream (main agent)

#### 1a. Check --yolo flag
If `$ARGUMENTS` contains `--yolo`, set YOLO_MODE = true. Strip `--yolo` from INPUT before continuing.

#### 1b. Hard Gate: Require real PRD AND Architecture
Read the first line of each file. Check that both exist AND neither contains `<!-- @@template -->`.

- `docs/product/requirements.md` — source of functional requirements
- `docs/architecture/overview.md` — source of technical structure

**If either is missing or template-only:**
- If YOLO_MODE → warn: "{missing file(s)} not found. Proceeding in yolo mode." → continue with whatever context is available
- Otherwise → **STOP**: "`{missing file}` has not been created yet. Run `/{command}` first. Use `--yolo` to bypass this gate."
  - If `product/requirements.md` missing → suggest `/create:project-requirements`
  - If `architecture/overview.md` missing → suggest `/create:project-architecture`

> **Gate posture (F3) — the default is to SATISFY the gate, not bypass it.** When you stop at a hard gate, the right next action is to **generate the missing prerequisite** (run the suggested `/create:*` command), then resume. If you surface a choice to the user via `AskUserQuestion`, the **Recommended** option must be "create the missing doc first" — **never** present "proceed off the stale/stub doc" or `--yolo` as the recommended path. Bypass is an explicit user override, not a nudge. Quietly building epics off a leftover `_prd.md` or a template stub is the failure mode this gate exists to prevent.

- **Optional**: Read `docs/design/spec.md` for UI-specific stories (only if real, not template)

### 2. Check for Existing Output (main agent)

- If `docs/work/backlog.md` exists → ask: **update** (add new epics) or **replace**?
- If replacing, confirm with user (this is destructive if implementation is in progress)

### 3. Analyze Requirements (main agent)

Synthesize a planning brief from upstream docs:
1. List all Functional Requirements from PRD (by module)
2. List architecture component boundaries
3. Map FRs to architecture components
4. Identify cross-cutting concerns that need their own stories
5. Note any UI-specific requirements from UX spec

### 4. Delegate to Agent

Use the Task tool with `subagent_type: "project-planner"` to generate epics and stories.

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow runs no build gate; its evidence is the written `docs/work/backlog.md` passing Step 5 validation, the Step 6 overlap check, the Step 6b real-document check (no `<!-- @@template -->` marker left) and the Step 7 commit hash. Stories that name build or test commands use the application's own commands in an adopter, never the Domdhi.Agents toolkit suite, also after agent-file edits. Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran; report completion only from that evidence.

**Task prompt must include**:
1. What to produce (`docs/work/backlog.md`)
2. Full list of FRs with their MoSCoW priorities and acceptance criteria
3. Architecture component list and boundaries
4. FR-to-component mapping
5. Cross-cutting concerns identified
6. Phase structure guidance:
   - Phase 0: Foundation & Configuration (ALWAYS first)
   - Phase 1: Data & Core
   - Phase 2: Auth (can merge with Phase 1 if simple)
   - Phase 3+: Feature phases ordered by dependency and Must Have priority
   - Final Phase: Polish & Launch

The `project-planner` agent auto-loads the `project-planning` skill via frontmatter — do NOT tell it to read the skill file.

### 5. Validate (main agent)

After the agent completes, verify the output:
- Every FR from PRD maps to at least one story?
- No circular dependencies?
- Phase 0 is foundation?
- No XL stories without a split recommendation?
- Must-Have FRs are in early phases?
- Stories have acceptance criteria and size estimates?
- **Epic IDs are contiguous** (C9) — the epic numbers run without gaps (e.g. Epic 0..Epic N, not 0–7 then jumping to 11) and the count stated in any summary matches the number of `## Epic` headers. A non-contiguous ID propagates silently into the master index, per-epic filenames, and every story ID downstream — delegate back to renumber before continuing.
- If issues found, delegate back to the agent to fix

These checks and the Step 6 overlap scan are structural: they prove the backlog's shape, not that any acceptance criterion is satisfiable or met. Story estimates are effort, not elapsed time.

### 6. Detect File Overlap (main agent)

Run the epic-overlap CLI against the new `backlog.md` to surface any inadvertent file-ownership overlaps between epics. The wave-based execution model in `/run-todo` requires zero file overlap within a wave — overlaps that aren't explicitly acknowledged will produce silent merge conflicts during parallel dispatch.

```bash
node .claude/core/_lib/epic-overlap.js docs/work/backlog.md
```

- Exit 0 (no overlaps) → continue to commit step
- Exit 1 (overlaps found) → surface in the report as a warning. Overlaps may be intentional (shared interface, cross-cutting refactor); if intentional, the user should add a `## Acknowledged Overlaps` section to `backlog.md` listing each pair and the rationale. `/review:check-readiness` will then accept the overlap as documented.

This is a warning, not a failure — `/create:project-epics` does not block on overlaps.

### 6b. Strip Template Marker (main agent)

Strip the `<!-- @@template -->` marker from the generated backlog so downstream gates (`isRealDoc`, `/review:check-readiness`) see it as a real doc rather than an unfilled stub:

```bash
node -e "require('./.claude/core/_lib/doc-drift.js').stripTemplateMarker(require('path').resolve('docs/work/backlog.md'))"
```

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage each file this command created or modified by its exact path and commit through the native commit helper (`node .claude/core/commit.js`, or `node .codex/core/commit.js` in Codex) with a descriptive message. Do not push, open a PR or take any other outward action without explicit authorization.

### 8. Report (main agent)

```markdown
## Epics Complete

**Output**: docs/work/backlog.md
**Phases**: {count}
**Epics**: {count}
**Stories**: {count} ({S count} S, {M count} M, {L count} L, {XL count} XL)
**Must-Have coverage**: All {count} Must-Have FRs mapped to stories

**Committed**: {hash} — `docs: /create:project-epics — {summary}`
**Next step**: Run `/review:optimize-backlog` for dependency graph analysis and parallel workstreams, then `/review:check-readiness` to validate implementation readiness.
```
