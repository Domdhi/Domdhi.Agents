---
description: Identify memory store overlap clusters and walk the user through merge / split / cross-ref proposals
---

<!-- Generated from .agents/skills/review-memory-defrag/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Memory Defrag

Periodic restructuring sweep of the memory store. Dispatches a Sonnet agent to analyze overlap, then walks the user through accepting merge / split / cross-reference proposals one-by-one. Different timing from the `memory-curator.js` Stop hook (which does light dedup on session close): defrag is the heavier, infrequent intervention.

**When to run:** quarterly, OR after a burst of new memory creation, OR when a category approaches its effective cap (`MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY` in `.agents/core/constants.js`, with the consumer-applied `MEMORY_MAX_PER_CATEGORY` environment override; near-limit warnings/pruning use `MEMORY_FILTERS.MEMORY_NEAR_LIMIT_PCT`). Not every session — the analysis cost (Sonnet dispatch) is real.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:memory-defrag
```

## Orchestration Rule

> Sonnet ANALYZES (Step 1). Main Agent EXECUTES (Step 4). Never delegate writes to a sub-agent — Main Agent owns curation and applies all merge / split / cross-ref operations directly.

## Workflow

### Step 0: Pre-flight

#### 0a. Memory count threshold

```bash
node .claude/core/memory-manager.js report | grep -E '"total_memories"|"count"'
```

Read `summary.total_memories`. If `< 30`, abort with:

> Memory corpus is too small for defrag (only N memories). Defrag value scales with overlap surface; at this scale, manual review or `/review:memory-health` is the better tool. Re-run when the corpus exceeds 30 entries.

Stop. Do not proceed to Step 1.

#### 0b. Pending curation check

Mirror `/review:promote-memories` Step 0: surface any unreviewed curation proposals from `memory-curator.js`.

```bash
node .claude/core/memory-curator.js status
```

If pending curation exists, ask the user: **Address curation first?** [Y / n]
- **Y** → stop. Print: "Run `/review:promote-memories` first to address curation, then re-run `/review:memory-defrag`."
- **n** → proceed to Step 1.

If no pending curation, proceed silently.

### Step 1: Dispatch the analysis agent

Dispatch a Sonnet `general-purpose` agent with this prompt template:

```
TASK: Analyze the memory store for overlap clusters. Output a markdown plan
with discrete merge / split / cross-ref proposals.

INPUT: All memories under docs/.output/.memory/{decisions,patterns,constraints,workflows,rejected-approaches}/.
Read every JSON file. Examine the `content` object — particularly `description`,
`evidence`, `wrong_pattern`, `correct_pattern`, `alternatives`, `reference`, and
`code_example` fields. The `metadata.confidence` and `usage_count` are also signals.

OPERATIONS YOU MAY PROPOSE:

1. MERGE — when two memories say substantially the same thing.
   - Pick the primary (higher confidence, more usage, richer content).
   - The secondary's load-bearing fields (evidence anchors, code examples,
     references) must be preserved in the merged version.
   - Output: { type: "merge", primary_id, primary_category, duplicate_id,
              duplicate_category, merged_content_diff, rationale }

2. SPLIT — when one memory has grown to cover two distinct concepts.
   - Identify the two concepts; propose new ids and categories for each.
   - The original memory's id can stay (with reduced content) or be retired
     in favor of two fresh ids — your call, with rationale.
   - Output: { type: "split", source_id, source_category, into: [{new_id,
              new_category, content_subset}, ...], rationale }

3. CROSS-REF — when two memories are related but distinct, and a future agent
   would benefit from finding both via either entry.
   - Add reciprocal `see_also` references in each memory's content.
   - Output: { type: "cross-ref", a_id, a_category, b_id, b_category, rationale }

ELIGIBLE CATEGORIES: decisions, patterns, constraints, workflows, rejected-approaches.

DO NOT propose:
- Operations across non-eligible categories
- Aggressive consolidation (merging substantially different memories just because
  they share a keyword)
- Splits that produce trivial fragments (each split target should be substantive
  on its own)
- Operations that lose evidence anchors (story IDs, commit hashes, file paths)

OUTPUT FORMAT — markdown with sections like:

```
### Proposal 1: MERGE patterns/foo + patterns/bar
- **Primary:** patterns/foo (confidence 0.85, usage 7)
- **Duplicate:** patterns/bar (confidence 0.6, usage 2)
- **Rationale:** Both describe X technique; bar's evidence (commit abc123)
  should fold into foo's evidence list; bar's code_example is identical to foo.
- **Merged content diff:** {what foo gains}

### Proposal 2: SPLIT constraints/big-grab-bag
- **Source:** constraints/big-grab-bag
- **Into:** constraints/specific-thing-a + constraints/specific-thing-b
- **Rationale:** Description currently bundles two distinct constraints
  that fire in different contexts. Splitting lets future agents match the
  specific case, not the bundle.

### Proposal 3: CROSS-REF patterns/x + workflows/y
- **A:** patterns/x — establishes the technique
- **B:** workflows/y — gates the technique behind a process step
- **Rationale:** Each is correct in isolation but readers of either should know
  the other exists.
```

ABSTAIN IF: the corpus has no clear overlap. Output a single line "No overlap
clusters identified — store is well-curated for current scale." and stop.

DO NOT modify any memory files. You are read-only. Report back when done.
```

### Step 2: Persist the plan BEFORE user interaction

Read the agent's reply. Persist it to `docs/.output/findings/reviews/{YYMMDD-HHMM}-memory-defrag.md` with this header:

```markdown
# Memory Defrag — {YYYY-MM-DD}

**Corpus size at analysis:** {N} memories
**Operations proposed:** {merge_count} merges, {split_count} splits, {crossref_count} cross-refs
**Status:** awaiting user review

---

{Agent's plan content verbatim}

---

## Review log
{Filled in by Step 4 as proposals are applied or rejected}
```

This is the durable artifact. If the user kills the session mid-review, the plan survives.

### Step 3: Walk proposals individually

For each proposal in the agent's plan (in order):

1. Show the proposal block to the user.
2. For MERGE / SPLIT proposals, also `cat` the source memory file(s) so the user sees the actual content (not just the agent's summary).
3. Ask: **Accept / Reject / Modify / Skip / Done**
   - **Accept** → proceed to Step 4 for this proposal
   - **Reject** → log in review section, move to next
   - **Modify** → ask the user what to change (different primary, different new ids, different rationale); apply the modified version in Step 4
   - **Skip** → log as deferred, move to next
   - **Done** → stop reviewing, proceed to Step 5

### Step 4: Apply (Main Agent — never delegate)

For each accepted proposal:

#### MERGE
1. Read primary and duplicate memories: `cat docs/.output/.memory/{cat}/{id}.json`
2. Construct merged `content` object — primary's content wins by default; specific fields from duplicate that are load-bearing (evidence, code_example, reference, alternatives entries) get appended to the corresponding fields in the merged content.
3. Update primary:
   ```bash
   node -e "const M=require('./.claude/core/memory-manager'); (async()=>{const m=new M(); await m.updateMemory('{primary_category}','{primary_id}',{ content: <merged-object> }); m.db?.close();})();"
   ```
4. Delete duplicate:
   ```bash
   node .claude/core/memory-manager.js delete {duplicate_category} {duplicate_id}
   ```
5. Append to the plan file's `## Review log`: `- [x] Proposal N MERGE — {primary_id} ← {duplicate_id} (commit pending)`

#### SPLIT
1. Read source memory.
2. Construct content for each split target.
3. Create new memories:
   ```bash
   node .claude/core/memory-manager.js create {new_category_a} {new_id_a} '<content_a_json>'
   node .claude/core/memory-manager.js create {new_category_b} {new_id_b} '<content_b_json>'
   ```
4. Either reduce source memory's content (if keeping the source) OR delete it (if retiring):
   - Reduce: `updateMemory` with the leftover content
   - Retire: `delete <category> <source_id>`
5. Append to review log.

#### CROSS-REF
1. Read both memories.
2. Add `see_also` field to each: `see_also: [{category, id, rationale}]`. If the field already exists, append the new entry rather than overwrite.
3. Write back via `updateMemory` for both.
4. Append to review log.

#### Memory limit guard

Before SPLIT or CROSS-REF that would create a new memory, check the target category's count:

```bash
node .claude/core/memory-manager.js list {category} | grep -c '"id"'
```

If the category is one below the hard cap (`MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY` in `.agents/core/constants.js`, including the `MEMORY_MAX_PER_CATEGORY` environment override — read the effective cap, do NOT assume a number), warn the user and suggest pruning before proceeding. Do NOT silently fail at the cap.

### Step 5: Commit

Stage the modified memory JSON files plus the plan file:

```bash
git add docs/.output/.memory/ docs/.output/findings/reviews/{YYMMDD-HHMM}-memory-defrag.md
```

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool) then `node .claude/core/commit.js`:
```
docs: /review:memory-defrag — N proposals applied

{Brief summary: M merges, S splits, X cross-refs.}

Plan: docs/.output/findings/reviews/{YYMMDD-HHMM}-memory-defrag.md
```

If zero proposals were accepted, commit only the plan file (it's still a useful audit artifact):

```bash
git add docs/.output/findings/reviews/{YYMMDD-HHMM}-memory-defrag.md
```

Write the commit message to `docs/.output/.state/.commit-msg` then `node .claude/core/commit.js`:
```
docs: /review:memory-defrag — analysis only (0 proposals applied)
```

If the agent abstained (no overlap identified), skip the commit entirely — there's nothing to record.

### Step 6: Report

```markdown
## /review:memory-defrag Complete

**Plan:** docs/.output/findings/reviews/{YYMMDD-HHMM}-memory-defrag.md

| Proposal | Type | Action | Result |
|----------|------|--------|--------|
| 1 | MERGE | Accepted | patterns/foo ← patterns/bar |
| 2 | SPLIT | Modified | constraints/x → constraints/x' + constraints/x-edge |
| 3 | CROSS-REF | Rejected | — |

**Applied:** {N} proposals
**Rejected:** {N}
**Skipped:** {N} (deferred to next defrag)
**Commit:** {hash} (or "no commit — analysis only")

Memory corpus size: before {N_before} → after {N_after}.
```

## What NOT to Do

- Do NOT auto-accept proposals. Every operation requires explicit user choice.
- Do NOT delegate Step 4 (Apply) to a sub-agent. Main Agent does all writes.
- Do NOT run defrag on every session. Quarterly cadence or threshold-triggered only.
- Do NOT modify memories outside the agent's proposed list. The plan is the contract.
- Do NOT push to remote. The user decides when to push.

## Cross-References

- Companion command: `/review:memory-health` (lint + decay, read-only)
- Companion command: `/review:promote-memories` (concept-to-template promotion)
- Light dedup runs on Stop hook via `memory-curator.js` (strict profile only) — defrag is the heavier, less frequent intervention
- Memory architecture decision: `docs/.output/findings/reviews/2026-04-20-adr-memory-unification.md`
