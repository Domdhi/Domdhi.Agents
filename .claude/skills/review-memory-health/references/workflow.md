# Memory Health Check

Run the memory health pipeline (optional Sonnet extraction, lint, decay report). Suitable for headless automation via `claude -p "/review:memory-health" --model sonnet --allowedTools Bash`.

> **Complementary view:** this command covers *hygiene* (lint + decay). For the *performance/usage* view — cap utilization, usage distribution, prune list, and injection hit-rate — run `node .claude/core/memory-manager.js analytics`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:memory-health
```

## Orchestration Rule

> This command runs directly — do NOT delegate to subagents. No commits. No memory modifications.

> **Exception to `/review:*` commit convention:** `/review:memory-health` intentionally does NOT commit. The report is ephemeral diagnostic output, not a persistent artifact — re-running always produces a fresh report, so committing it would create noise in git history.

## Workflow

### Step 1: Extraction

Run the Sonnet extractor. Extraction is always manual — this command runs it here as part of the health check, and `memory-extractor.js extract` can also be invoked on demand via the CLI for brownfield backfill in adopter projects. No command or hook fires the extractor automatically. If the extractor script does not exist, skip silently.

```bash
test -f .claude/core/memory-extractor.js && node .claude/core/memory-extractor.js extract || echo "extractor not available"
```

The extractor dedups via `[extracted]` markers, so repeated invocations only process new daily-log entries.

### Step 2: Lint

Run:

```bash
node .claude/core/memory-manager.js lint
```

Capture the full output. The result is a JSON object. Parse:

- `score`: integer 0–70
- `checks`: array of 7 check result objects, each with a description and pass/fail status

Track `lint_score` = `score` value.

### Step 3: Decay Report

Run:

```bash
node .claude/core/memory-manager.js decay-report
```

Capture the full output. The result is a JSON array sorted by `decayed_confidence` ascending (stalest first). Each entry has at minimum: `category`, `id`, `decayed_confidence`.

Count:

- `stale_count`: entries where `decayed_confidence < 0.3`
- `archive_count`: entries where `decayed_confidence < 0.1`

### Step 4: Evaluate and Report

#### SILENT mode

If BOTH of the following are true:

1. `lint_score` is 70 (perfect score)
2. `stale_count` is 0

Output ONLY this line and stop:

```
[SILENT] Memory system healthy — nothing to process
```

#### Full report mode

If any condition above is not met, **persist before reporting:** Write the full report below to `docs/.output/findings/reviews/{YYMMDD-HHMM}-memory-health.md`. Then display the same content in chat.

```markdown
## Memory Health Report

### Summary
| Metric | Value |
|--------|-------|
| Lint score | {lint_score}/70 |
| Stale memories (< 0.3) | {stale_count} |
| Archive candidates (< 0.1) | {archive_count} |

### Lint Issues
{If lint_score is 70, write: "No issues — all 7 checks passed."}
{If lint_score < 70, list each failing check with its description and the points deducted.}

### Stale Memories
{If stale_count is 0, write: "No stale memories found."}
{If stale_count > 0, list up to 5 stalest entries (lowest decayed_confidence first):}
{| Category | ID | Decayed Confidence |}
{|----------|----|-------------------|}
{| {category} | {id} | {decayed_confidence} |}

### Recommendations
{Generate 1–3 actionable recommendations based on what was found. Examples:}
{- "Run `node .claude/core/memory-manager.js report` to view all memories, or `node .claude/core/memory-manager.js decay-report` to inspect stalest entries first."}
{- "Consider archiving {archive_count} memories below 0.1 confidence using memory-manager."}
{- "Fix lint issues: {summary of failing checks}."}
{- "Run /retro to re-validate stale pattern memories from recent epics."}
{If nothing actionable was found beyond the silent threshold, write: "Memory system is near-healthy — monitor decay over the next few sessions."}
```

## What NOT to Do

- Do NOT modify any memory files
- Do NOT run `memory-manager create`, `memory-manager delete`, or any write command
- Do NOT commit any changes
- Do NOT delegate to subagents
- Do NOT push to remote
