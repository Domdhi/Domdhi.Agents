---
name: project-planning
description: "Use WHEN creating or updating any project planning document — brainstorm/research, project brief, requirements/PRD, epics/stories backlog, or the project-context quick-reference. Covers: brainstorm, research, problem space, ideation, market analysis, validation, project brief, vision, strategic, PRD, requirements, functional requirements, non-functional, MoSCoW, user stories, epic, story, backlog, sprint, acceptance criteria, dependency ordering, estimation, project context, project setup, project overview."
metadata:
  version: 1.1.0
  author: Domdhi.Agents
  tags: [brainstorming, research, project-brief, prd, requirements, MoSCoW, user-stories, ideation, market-analysis, vision, strategic, epics, stories, backlog, estimation, project-context]
user-invocable: false
allowed-tools: Read Write Edit Grep Glob WebSearch WebFetch
---

<!-- Generated from .agents/skills/project-planning/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Project Planning

Consolidated methodology for the product planning pipeline — from problem space exploration through brainstorm/research, to project brief, to full product requirements document (PRD), to the epics/stories backlog, plus the project-context quick-reference. Consolidates `project-analyst`, `project-brief-writer`, `prd-writer`, `epic-writer`, and `project-context`.

The genuine design disciplines — technical architecture and UX design — stay as their own self-contained skills (see Navigation). This skill owns the planning-pipeline *text* documents.

---

## Planning Pipeline Position

```
brainstorm / research   →   references/brainstorm-research.md
       ↓
project brief           →   references/project-brief.md
       ↓
PRD / requirements      →   references/project-requirements.md
       ↓
epics / stories backlog →   references/backlog.md
       ↓
project context         →   references/project-context.md   (quick-ref for /prime; maintained across the lifecycle)

architecture / design   →   self-contained `architecture` / `ux-design` skills (see Navigation)
```

---

## Cross-Cutting Rules

These rules apply across every document in the pipeline:

1. **Interview before generating.** Never fabricate user requirements, personas, or constraints. Use AskUserQuestion to gather what you don't know before writing any section.

2. **Every FR needs Given/When/Then acceptance criteria.** A functional requirement without a testable AC is not a requirement — it is a wish. Format: `Given {precondition}, When {action}, Then {expected result}`.

3. **MoSCoW must be mixed.** The target distribution is approximately Must Have ~40%, Should Have ~30%, Could Have ~20%, Won't Have ~10%. If everything is "Must Have", the prioritization is wrong — push back and force trade-offs.

4. **Problem-space only — capture constraints, defer picks.** Planning docs (brief and PRD) describe *the user, the use case, goals, and constraints* — never *how to build it*. The architecture phase owns HOW (tools, libraries, hosts, services). The line is between a **constraint** and a **pick**:
   - A **constraint** *bounds* the solution space and comes from the user's reality — keep it: "no build step", "$0/month", "must work offline", "must decouple from the X platform", "vanilla JS only", locked business facts.
   - A **pick** *selects one option* when alternatives would satisfy the constraint — defer it to architecture: "use Web3Forms", "host on Netlify", "store leads in Redis", a proposed section flow.
   - If the user volunteers a pick, record it as a **stated preference for the architecture phase to weigh**, not as a locked decision. Don't recommend tools the user didn't ask for. A premature pick in a planning doc anchors every downstream agent into rubber-stamping or arguing against it, and collides with the architecture phase's own (correct) reasoning. Strip the pick and the architect reasons cleanly from the constraints — which is its job.

5. **Verify an asserted fact before you build a plan on it.** Before sizing a TODO/backlog around a claimed *system behavior* (a capability gap, a missing dependency, a limitation) or around a *research/synthesis doc's recommendation*, prove the claim against reality first — a 30-second probe, or a grep/read of the live code. Do not trust the assertion (or a stale research doc) on faith. A whole remediation backlog was once built on "FTS5 needs an npm install" — false; a one-line `node -e` probe disproved it. Verify *each* "we should fix X" against the actual files before it becomes scoped work; an unverified premise produces a plan that solves a problem that does not exist.

6. **File Ownership Matrix: trace each AC bullet to the file it actually forces a change in.** A wave's "disjoint files" claim built from each story's *stated* file budget is unreliable: a story whose AC dictates new branching logic INSIDE a method owned by another story in the same wave is a same-file conflict regardless of its stated budget (calling another file's public method is parallel-safe; requiring new behavior inside it is not). Trace the AC → behavior-target file before declaring a wave parallelizable. (Field-proven on an adopter project: a wave collapsed to sequential when two stories' ACs both forced changes inside one method — retro-calendar-recurrence.)

7. **Precedent citations in dispatch prompts must name the file TYPE and match it.** When a plan or dispatch prompt cites an existing file as precedent for a pattern that a guard test polices (e.g. direct factory injection), verify the cited file's type matches the target's — a code-behind precedent does NOT justify the same pattern in a markup file when the guard exempts one and fails the other. (Field-proven: a story failed its gate because the cited precedent was a file type the guard exempted.)

8. **HIGH-risk epics get the 4-layer review chain as standing wave-plan line items:** per-wave review → mid-epic checkpoint → full-epic cross-wave pass → independent retro. Each layer has found real, non-overlapping MAJORs in the field (one integration-breaking bug survived 3 prior passes and fell to the fourth). Schedule the mid-epic checkpoint and full-epic pass in the plan itself, not ad hoc.

9. **Mechanical plan checks prove structure, not semantics.** For a large backlog or TODO, check the story-to-index-to-wave mapping, dependency order, per-story file budgets, same-wave path collisions and forward outputs (a file a later story modifies exists or is created earlier) with a short script rather than by eye. A passing structural check proves no acceptance criterion; semantic acceptance still needs the actual files or commands. Report effort as summed estimates along the dependency chain, never as elapsed time, and keep the project's own per-story file caps: a story that outgrows them gets a bounded sibling story before mutation, not a silent widening.

---

<!-- @@project-additions:start -->
## Acceptance and claim checks

- **Keep story and criterion states coherent.** Update a completed story and its verified acceptance bullets together. Explicitly label criteria that were cut, superseded, moved or not applicable; do not check them as delivered or leave their meaning ambiguous. Retain the project's actual status syntax and structural validation.
- **Mark unverified factual claims.** Label an unchecked claim in a TODO as `UNVERIFIED`, especially a security or risk assertion. Resolve it with evidence, correct it or explicitly carry the unresolved dependency before accepting the story. A plausible risk statement is not evidence that the event occurred.
<!-- @@project-additions:end -->

## Navigation

| Task | Where |
|------|-------|
| Brainstorm / problem-space research | `references/brainstorm-research.md` |
| Project brief / vision | `references/project-brief.md` |
| PRD / requirements / MoSCoW / FR-NFR | `references/project-requirements.md` |
| Epics / stories / backlog / estimation / AC | `references/backlog.md` |
| Project context quick-ref for /prime | `references/project-context.md` |
| Technical architecture / ADRs / tech stack | self-contained `architecture` skill |
| UX design spec / wireframes / themes | self-contained `ux-design` skill |
