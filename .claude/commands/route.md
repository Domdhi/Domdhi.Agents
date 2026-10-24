---
name: route
description: Assess a request's scale and route it to the right pipeline depth — bugfix→/do, feature→/todo, epic→full planning. The front door of the build loop.
argument-hint: [what you want to build or change]
---

<!-- Generated from .agents/skills/route/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Route — Scale-Adaptive Planning-Depth Router

The front door. Given any request — a one-line bugfix, a feature, a new module, or a whole new product — this command assesses its **scale** and routes you to the right **pipeline depth**, so a typo fix doesn't walk brief→PRD→architecture while greenfield still gets the full planning walk.

`/route` decides *where to enter* the pipeline. It does **not** bypass any gate: every downstream command keeps its own hard gates, and every phase this router skips is named and logged. Routing is not a `--yolo`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill`. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js route
```

## Variables

REQUEST: $ARGUMENTS

- `REQUEST` (optional): a description of what you want to build or change. If empty, infer from the current conversation; if still unclear, ask one clarifying question, then proceed.

## Workflow

### Step 1: Classify the scale (Main Agent)

Assess REQUEST against two axes and assign a **scale tier**:

1. **Complexity (1–10)** — score the request with `/todo`'s canonical rubric (the "Complexity Score (1–10) — canonical rubric" subsection in `.claude/commands/todo.md`). Do NOT restate that rubric here — read it and apply it. Signals: files touched, new LOC, AC count, mechanical-vs-ambiguous.
2. **Architectural reach** — does it fit inside the existing architecture, add a new feature area, or require *new* product/requirements/architecture decisions?

If the request is an existing checklist story that already carries a persisted `**Complexity:** {1–10}` field, read that score directly rather than re-deriving it (it was scored at authoring time — the routing signal of record).

### Step 2: Map tier → pipeline depth (the documented size→depth mapping)

| Tier | Scale signal | Complexity (typical) | Entry point | Phases explicitly skipped |
|------|--------------|-----------|-------------|---------------------------|
| **0 — Trivial / Bugfix** | one known change, no new design | 1–3 | **`/do {task}`** | ALL planning (brief, PRD, architecture, design, epics, todo) |
| **1 — Feature** | several stories within the *existing* architecture; no new ADRs | 4–6 | **`/todo {feature}`** → `/run-todo` (or `/do` per story) | brief, PRD, architecture, design, epics |
| **2 — Module** | a new feature *area* inside an existing project | 4–7 | **`/create:module {name}`** | project-level brief/PRD/architecture (a module-scoped `brief.md` replaces them) |
| **3 — Epic / Greenfield / Product** | a new product or major subsystem; needs real requirements + architecture | 7–10 | **`/create:new-project`** (greenfield) · **`/onboard`** (existing code with no docs) | none — the full planning pipeline runs |

**The Complexity bands are overlapping guides, not exclusive cutoffs** — **architectural reach is the primary axis** (a Complexity-5 request is Tier 1 if it fits the existing architecture, Tier 2 if it's a new feature area). Use Complexity to *break ties within* a reach band, not to pick the band.

**Boundary judgment:** when a request sits between two tiers, route to the **shallower** tier only if it adds no new architectural decision and no new public contract; otherwise route deeper. A "feature" that introduces a new ADR is Tier 3, not Tier 1. State the deciding factor in the report.

### Step 3: Make every skip explicit + logged (Iron Law — never a silent gate bypass)

Routing is **not** gate-bypass. Consequence of getting this wrong: a request enters mid-pipeline on a missing prerequisite and downstream work is built on a stub.

- **Name each skipped phase** in the report (from the table's "Phases explicitly skipped" column), with the one-line reason it's safe to skip at this tier.
- **Downstream hard gates remain in force.** `/route` NEVER passes `--yolo` and NEVER edits gate state. If the chosen entry point has an unmet hard gate (e.g. routing a feature to `/todo` but `backlog.md` is a stub, or `/create:project-requirements` with no brief), surface that — the downstream command's gate will (correctly) stop, and the right move is to generate the missing prerequisite, not to force past it.
- **Log the decision.** Append a one-line routing record to the daily log so the choice is durable, not just chat:

  ```bash
  node .claude/core/daily-log.js note "route: '{REQUEST one-liner}' → Tier {N} ({entry point}); complexity {score}; skipped: {phases}; reason: {deciding factor}" --trigger route
  ```

### Step 4: Confirm and hand off

Present the routing decision and the **exact next command** to run.

- **Tier 0** (trivial/bugfix): offer to proceed straight to `/do` now — the whole point is no ceremony.
- **Tiers 1–3:** present the entry command and the skipped phases; let the user confirm or override the tier before running anything. The user always owns the final depth choice — `/route` recommends, it does not force.

`/route` itself produces **no committed artifact** (the daily-log note is the durable record) and has **no commit step** — like `/prime`, it is a chat-first dispatcher.

## Report

```markdown
## Route

**Request:** {REQUEST one-liner}
**Scale:** Tier {N} — {tier name}  ·  **Complexity:** {score}/10
**Deciding factor:** {what put it in this tier — the architectural-reach call}

**→ Enter here:** `{entry command}`

**Phases skipped (explicit):**
- {phase} — {why it's safe to skip at this tier}
- ...

**Gates still in force:** {the downstream command's hard gate(s), if any — or "none"}

**Logged:** daily log ({YYYY-MM-DD})

**Next:** run `{entry command}` {— "want me to start now?" for Tier 0}
```

## Anti-Patterns

- **Never bypass a hard gate.** `/route` chooses an entry point; it does not pass `--yolo`, edit gate state, or wave a missing prerequisite through. A skipped *phase* (not needed at this scale) is not a skipped *gate* (a real prerequisite of the entry command).
- **Never route deep work shallow to save time.** A new-ADR "feature" is Tier 3. Under-routing ships a product on a stub PRD — the exact failure the planning pipeline exists to prevent.
- **Don't restate the Complexity rubric.** Reference `/todo`'s canonical rubric; duplicating it violates the three-tier "no duplication between layers" rule.
- **Don't reinvent Claude Code primitives.** Recurrence is `/loop`, not a timer inside `/route`. The router only picks the entry; it layers on top of the existing commands, never parallel to them.
- **Don't produce a planning artifact.** `/route` is a dispatcher — its output is a routing decision + a daily-log note, not a committed doc. No commit step.
