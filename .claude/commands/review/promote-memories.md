---
description: Surface high-confidence memory concepts for promotion into templates, skills, and agents
---

<!-- Generated from .agents/skills/review-promote-memories/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Promote Memories

Scan compiled concept articles for promotion candidates and guide the user through accepting, rejecting, or skipping each one. Accepted promotions are applied to target files and committed.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:promote-memories
```

## Orchestration Rule

> You (the main agent) handle everything: scanning, presenting candidates, applying promotions, and committing. Do NOT delegate to subagents.

## Workflow

### Step 0: Surface Pending Curation Proposals

Before scanning for promotions, surface any unreviewed curation proposals from the memory-curator (AMEM-7). Curation may dedup, merge, or flag contradictions that change which concepts are eligible for promotion — reviewing them first avoids promoting a concept that's about to be replaced.

1. Look for the most recent file under `docs/.output/.state/memory-pending-curation/{YYYY-MM-DD}/*.json` (sort by date directory, then by filename).
2. **If the directory is missing or contains no JSON files:** Print `Step 0: No pending curation proposals (memory-curator has not run or MEMORY_PROFILE is not strict).` and proceed to Step 1.
3. **If a file exists:** Read it and surface a summary to the user:
   - **Latest curation file:** path + timestamp
   - **Dedup candidates:** count; show the top 3 with `slug_a + slug_b + rationale`
   - **Contradiction pairs:** count; **show all** (contradictions are always worth reviewing)
   - **Merge proposals:** count; show the top 3 with `proposed_title + source_slugs`
4. Ask the user: **Continue to promotion scan?** `[Y / n / review-first]`
   - **Y** → proceed to Step 1
   - **n** → stop. Print: `Address curation proposals first (edit concept articles, run memory-promoter mark on obsolete slugs, or accept as-is), then re-run /review:promote-memories.`
   - **review-first** → print the paths to all affected concept articles so the user can open them, then stop.

Use the `status` sub-command of memory-curator.js as a quick alternate view if you just need the counts:

```bash
node .claude/core/memory-curator.js status
```

### Step 1: Scan for Candidates

Run:

```bash
node .claude/core/memory-promoter.js scan --top 10
```

Parse the output. If "No concepts meet promotion criteria" → report that and stop.

### Step 2: Present Candidates

For each candidate (in rank order):

1. Read the concept article at `docs/.output/.state/memory-concepts/{category}/{slug}.md`
2. Present to the user:
   - **Title** and **category**
   - **Promotion score** and **decayed confidence**
   - **Summary** (from the concept article's `## Summary` section)
   - **Sources**: list of daily log dates
   - **Cross-references**: related concepts (if any)
   - **Suggested target**: where this would go (based on category)

3. Ask the user: **Accept / Reject / Skip / Done**
   - **Accept**: proceed to Step 3 for this candidate
   - **Reject**: skip this candidate, move to next
   - **Skip**: skip this candidate, move to next
   - **Done**: stop reviewing candidates, proceed to Step 4

### Step 3: Apply Promotion (for accepted candidates)

For each accepted candidate:

1. **Identify the target file.** The suggested target is a starting point — the user may specify a different file. Resolve any migrated native role/skill to its `.agents` source before drafting; generated projections and root instructions are not shared-behavior authoring targets. Confirm the target with the user if ambiguous.

2. **Read the target file** to understand where the promoted content should go.

3. **Draft the addition.** Based on the concept category:
   - `decisions` → Add shared behavior to its existing canonical `.agents/skills` or `.agents/roles` source when present; application decisions stay in the existing project architecture guidance. Root runtime instructions are not a shared-behavior promotion target
   - `patterns` → Add as a checklist item or guideline in the relevant SKILL.md
   - `constraints` → Add to a template's constraints or requirements section
   - `workflows` → Add to a role's Project Context in its Markdown body, using `.agents/roles/{name}.md` when canonical (otherwise the legacy native source)

4. **Show the user the proposed change** before applying it. Wait for confirmation.

5. **Apply the change** to the source file using Edit. For migrated skills, target `.agents/skills`, use project-additions tail/inline markers for adopter guidance, and never edit a generated native file. Run `node .claude/core/render-shared-agents.js` after canonical changes and include the projections in the commit.

6. **Mark the concept as promoted:**
   ```bash
   node .claude/core/memory-promoter.js mark {slug} {target-file-path}
   ```

7. Track the promotion for the commit message.

### Step 4: Commit

If any promotions were accepted and applied:

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /review:promote-memories — promoted {N} concepts

{For each promoted concept: slug → target-file}
```

Then run:

```bash
git add {all modified files — target files + concept articles}
node .claude/core/commit.js
```

### Step 5: Report

```markdown
## /review:promote-memories Complete

| Concept | Category | Score | Action | Target |
|---------|----------|-------|--------|--------|
| {title} | {cat} | {score} | Accepted | {target} |
| {title} | {cat} | {score} | Rejected | — |
| {title} | {cat} | {score} | Skipped | — |

**Promoted:** {N} concepts
**Rejected:** {N}
**Skipped:** {N}
```

## What NOT to Do

- Do NOT auto-accept promotions — every promotion requires explicit user approval
- Do NOT modify concept articles except via the `mark` command
- Do NOT create new files — only modify existing target files
- Do NOT push to remote
- Do NOT promote concepts that are already marked as promoted
