# Update Docs

Fix documentation drift detected by `/check-sync`. Reads the actual codebase and updates planning docs to match reality.

**Safe by default** — shows proposed changes before applying. Does NOT modify code — only updates docs to reflect what was built.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:update-docs
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle drift detection, classification, user consent, and committing. The `doc-writer` agent handles applying the actual documentation fixes. Do NOT edit doc files inline — delegate via Task tool. You DO handle the preview, user approval, and context updates.

**Agent**: `doc-writer` (via Task tool with `subagent_type: "doc-writer"`)

## Variables

INPUT: $ARGUMENTS

- `INPUT` (optional): Scope to update. Defaults to `all`.
  - `all` — Fix all detected drift
  - `architecture` — Update tech stack and structure in `architecture/overview.md`
  - `stories` — Update story statuses in TODO checklists (`docs/work/todo/TODO_epic*.md`)
  - `prd` — Update requirement statuses in `product/requirements.md`

## Workflow

### 1. Run Drift Detection (main agent)

Run `/check-sync {INPUT}` to identify all documentation drift. Capture the full report.

If `/check-sync` finds no drift → report "Docs are in sync. Nothing to update." and stop.

### 2. Classify Drift Items (main agent)

For each drift item from the report, classify:

| Type | Delta | Auto-fixable | Action |
|------|-------|-------------|--------|
| Story marked `[ ]` but has commits | ADDED | Yes | Mark as `[x]` in `TODO_epic*.md` checklist |
| Story marked `[x]` but no commits | REMOVED | Confirm | Ask user before unmarking |
| Master index counts stale | MODIFIED | Yes | Recalculate done/total in `TODO_{Project}.md` |
| New dependency in package files not in architecture | ADDED | Yes | Add to tech stack table |
| Architecture references non-existent path | REMOVED | Yes | Update path or remove reference |
| Dead internal doc link | REMOVED | Yes | Update link target or remove |
| Architecture lists removed dependency | REMOVED | Yes | Remove from tech stack table |
| PRD requirement not yet implemented | — | No | Informational only (expected during development) |
| New code pattern not in architecture | ADDED | Manual | Flag for manual architecture update |

> **Note**: `backlog.md` is a **read-only planning artifact** — it defines what to build but does NOT track completion status. Story status lives in per-epic TODO checklists (`docs/work/todo/TODO_epic*.md`). Never modify `backlog.md` to update story markers.

### 3. Preview Changes (main agent)

Present all proposed changes to the user before applying:

```markdown
## Proposed Doc Updates

### Auto-fixable ({count})
| # | File | Delta | Change | Before | After |
|---|------|-------|--------|--------|-------|
| 1 | TODO_epic01_*.md | ADDED | Mark story done | `[ ] Story 1.1` | `[x] Story 1.1` |
| 2 | architecture/overview.md | ADDED | Add dependency | (missing) | `| Backend | express | 4.18 |` |
| 3 | TODO_{Project}.md | MODIFIED | Update epic count | `2/5 done` | `3/5 done` |

### Need Confirmation ({count})
| # | File | Change | Reason |
|---|------|--------|--------|
| 1 | TODO_epic01_*.md | Unmark story | Marked done but no commits found |

### Manual Action Required ({count})
| # | File | Finding | Recommendation |
|---|------|---------|----------------|
| 1 | architecture/overview.md | New pattern: {name} | Add to Component Architecture |
```

### 4. Apply Changes (main agent → doc-writer)

Use AskUserQuestion: "Apply {N} auto-fixable changes? (Manual items listed above for reference)"

If user approves, use the Task tool with `subagent_type: "doc-writer"` to apply the changes.

**Task prompt must include**:
1. The complete list of approved changes (auto-fixable + user-confirmed)
2. The current content of each file to be modified
3. The `doc-writer` agent auto-loads the `project-planning` skill via frontmatter.
4. Specific instructions for each change type:
   - `TODO_epic*.md`: update story checkbox markers, add `<!-- updated by /update-docs on YYYY-MM-DD -->` notes
   - `TODO_{Project}.md`: recalculate epic done counts if story statuses changed
   - `architecture/overview.md`: add/remove dependencies in tech stack tables, update paths
   - `product/requirements.md`: only update if explicitly confirmed by user
   - **NEVER modify `backlog.md`** — it is a read-only planning artifact
   - Dead references: update link targets or remove broken links
5. Instruction to NOT modify any code files — docs only

### 5. Update Project Context (main agent)

If significant changes were made, update `docs/product/context.md`:
- Refresh the Stats section (epic/story counts)
- Update Quick Reference links if any paths changed

### 6. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command and commit with a descriptive message.

### 7. Report (main agent)

```markdown
## Doc Update Complete

**Date**: {YYYY-MM-DD}
**Scope**: {all | architecture | epics | prd}

### Changes Applied
| File | Changes | Type |
|------|---------|------|
| {file} | {description} | {auto/confirmed/manual} |

### Still Out of Sync
| File | Issue | Action Needed |
|------|-------|---------------|
| {file} | {description} | {manual action} |

### Summary
- **Auto-fixed**: {count}
- **User-confirmed**: {count}
- **Remaining**: {count} (manual action required)

**Committed**: {hash} — `docs: /update-docs — {summary}`
**Next step**: Review manual items above, or run `/check-sync` to verify.
```

## When to Run

- After `/check-sync` reports drift
- After completing a batch of stories
- Before `/retro` (ensures docs are current for analysis)
- After major refactors that change project structure
