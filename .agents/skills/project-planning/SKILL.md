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

# Project Planning

Methodology for the product planning pipeline: problem-space exploration (brainstorm, research), project brief, product requirements (PRD), the epics/stories backlog, and the project-context quick reference. A good result is a set of documents that each answer their own question (why, what, then how it breaks into work), stay in the problem space until architecture takes over, and are specific enough that a later agent can act on them without guessing.

Technical architecture and UX design are their own self-contained skills (see Navigation).

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

These apply to every document in the pipeline.

1. **Interview before generating.** Do not fabricate user requirements, personas or constraints. Ask (AskUserQuestion for closed choices) what you do not know before writing the section.

2. **Every FR needs Given/When/Then acceptance criteria**: `Given {precondition}, When {action}, Then {expected result}`. A requirement without a testable AC is a wish.

3. **MoSCoW must be mixed.** Roughly Must 40%, Should 30%, Could 20%, Won't 10%. If everything is Must, the prioritization is wrong: push back and force trade-offs.

4. **Problem-space only: capture constraints, defer picks.** Briefs and PRDs describe the user, the use case, goals and constraints, never how to build it; the architecture phase owns HOW. A **constraint** bounds the solution space and comes from the user's reality, so keep it ("no build step", "$0/month", "must work offline", "vanilla JS only", locked business facts). A **pick** selects one option when alternatives would satisfy the constraint ("use Web3Forms", "host on Netlify", "store leads in Redis", a proposed section flow), so defer it. A volunteered pick is recorded as a stated preference for architecture to weigh, not a locked decision, and do not recommend tools the user did not ask for. A premature pick anchors every downstream agent into rubber-stamping or fighting it.

5. **Verify an asserted fact before building a plan on it.** Before sizing a TODO or backlog around a claimed system behavior (a capability gap, a missing dependency, a limitation) or a research doc's recommendation, probe reality: a quick command or a read of the live code. An unverified premise produces a plan that solves a problem that does not exist (a whole remediation backlog was once built on "FTS5 needs an npm install"; a one-line `node -e` disproved it).

6. **File Ownership Matrix: trace each AC bullet to its actual behavior-target files.** Starting file lists and budgets can miss shared implementation points. Follow the outcome-ownership contract in `.agents/startup.md`: update assignments as necessary files emerge, keep one active writer per shared-checkout file through handoffs or serialization, and plan integration and conflict review for overlapping worktrees. Calling another file's public method is parallel-safe; needing new behavior inside it means coordinating its writer. Keep dependency ordering without adding a wave solely for file contention.

7. **A precedent citation in a plan or dispatch prompt names the file type and matches it.** When a guard test polices a pattern (for example direct factory injection), a code-behind precedent does not justify the pattern in a markup file the guard treats differently (a story once failed its gate on exactly this).

8. **Review is one pass per scope.** Plan reviews by the shared cadence in `code-review/references/review-cadence.md`: a review per wave, a mid-epic review (looking back and forward) and a final review, with a closer look where a mistake costs money, data or access. No per-story reviewer, no separate retro pass and no re-review of fixes: a fix is proven by a test and the gate. The definition of done is "One review pass, then done" in the `code-review` skill.

9. **Mechanical plan checks prove structure, not semantics.** For a large backlog or TODO, check the story-to-index-to-wave mapping, dependency order, per-story file budgets, same-wave writer coordination and forward outputs (a file a later story modifies exists or is created earlier) with a short script rather than by eye. A passing structural check proves no acceptance criterion; semantic acceptance still needs the actual files or commands. Report effort as summed estimates along the dependency chain, never as elapsed time. File budgets are planning estimates: update them and coordinate necessary expansion under `.agents/startup.md`, splitting or resequencing when the work warrants it. Explicit project constraints still apply.

10. **A file list that must be complete comes from a recorded grep.** When a change alters a count or a set of named items that tests and scripts pin (how many stages, steps, levels or variants exist), build the migration list from a grep of every old literal across the tests and scripts, not only from the failures a trial run shows: a trial run shows the pins it happens to hit; the grep shows all of them. The same holds for a follow-up story that closes a bug class (every writer of a field, every route behind a guard): its Files list comes from a grep for the class, and the story records that grep command so a reviewer can re-run it. A list written from memory misses the file nobody was looking at.

11. **Every measured acceptance criterion names its data producer.** For each criterion that measures or counts something, name what produces the data (a recorder field, a fixture, a helper, a log line) and confirm it exists or is created by an earlier story. A criterion whose data nothing produces cannot pass, and it is usually found mid-run, after the stories around it are built.

---

<!-- @@project-additions:start -->
## Acceptance and claim checks

- **Delete superseded artifacts; git history is the record.** When an approach is abandoned (a vendoring attempt replaced by a clean-room build, a rejected design), delete its docs, manifests and code from the module folder in the same change that supersedes it. The ADR or decision record names the commit that last held them. Do not keep them "as historical record" beside the live work.
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
