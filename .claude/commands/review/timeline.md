---
description: "Generate or update work/timeline.md with weekly commit history"
---

<!-- Generated from .agents/skills/review-timeline/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Timeline

Generate or update `docs/work/timeline.md` — a weekly-grouped, daily-breakdown history of all project commits.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:timeline
```

## Variables

ARGUMENTS: $ARGUMENTS

Parse ARGUMENTS:
- `full` — regenerate from first commit (or if file doesn't exist)
- `update` — incremental from last documented commit (default if no arg)

## Workflow

Run the script:

```bash
node .claude/core/gen-timeline.js $ARGUMENTS
```

The script handles everything: git data gathering, grouping, formatting, and writing.

Report the script output to the user.

After reporting, commit the updated timeline:

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /review:timeline — update project timeline
```

Then run:

```bash
git add docs/work/timeline.md
node .claude/core/commit.js
```

## Format Reference

The script produces this structure:

```markdown
# {ProjectName} Project Timeline

## Week of Mar 17, 2026

### Mon Mar 17 (2 commits, 14 files)
- feat: add Rate Tracker help articles
- feat: add HelpContent.Seeder tool

### Tue Mar 18 (13 commits, 127 files)
**Icon System Migration** (8 commits)
- Migrated Material Symbols to Fluent UI SVGs
- Icons.cs type-safe constants

**Employee Directory** (1 commit)
- Card grid with avatars, smart drawer filters
```

### Rules (implemented in script)
- **5 or fewer commits/day**: list individually
- **More than 5**: group by theme (conventional commit prefix + scope)
- Weekly headers Monday-anchored, most recent at top
- Co-Authored-By lines stripped
- `<!-- last:HASH -->` comment tracks incremental update position

## Staleness Check

`/end` should check if the timeline is >7 days stale and suggest `/review:timeline update`:
```bash
date -r docs/work/timeline.md +%s 2>/dev/null
```
