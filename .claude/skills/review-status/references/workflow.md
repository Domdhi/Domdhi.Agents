# /review:status — Project Status Dashboard

Parse all TODO files in `docs/` and show progress. Generates an HTML dashboard at `docs/.output/.state/status.html`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:status
```

## Variables

FLAGS: $ARGUMENTS

## Workflow

### 0. Test cost (only when FLAGS contains `--test-cost`)

`--test-cost` is a different report: it measures how many test lines recent work added per source line added, instead of showing TODO progress. Run it with the other arguments and report its output, then stop; do not run the status script or generate the dashboard.

```bash
node .claude/core/test-cost.js {FLAGS without --test-cost}
```

Examples: `--test-cost` (this repo, last 28 days), `--test-cost --fleet ~/code --since 2026-09-01` (every repo under a directory), `--test-cost --worktree` (uncommitted work), `--test-cost --range <a>..<b>`. A `TEST_COST_FLAG` line names scopes above about 2:1; it is a prompt for a reviewer to check whether the tests pin contracts or tuning, not a failure. Read-only.

### 1. Run the status script

```bash
node .claude/core/status.js $FLAGS
```

The script:
- Scans `docs/TODO_*.md`, `docs/work/todo/TODO*.md`, `docs/modules/**/TODO*.md`
- Parses checkbox markers: `[ ]`, `[x]`, `[>]`, `[!]`, `[~]`
- Parses master index tables (Phase Map, Epic Index) if present
- Prints a text summary to stdout
- Generates `docs/.output/.state/status.html` (unless `--text-only`)
- Also generates `docs/.output/.state/decisions.html` — an interactive decision log visualization
  (decision-viz errors are non-fatal; status.html is always produced first)

### 2. Report

Display the text summary from the script output. If HTML was generated, mention the dashboard path.

## Notes

- This is a **read-only** command — no commits, no file modifications (except the generated dashboards)
- Both HTML files are self-contained (inline CSS; `decisions.html` loads vis.js from CDN)
- Works with both master index TODOs and per-epic checklists
- `docs/.output/.state/status.html` and `docs/.output/.state/decisions.html` should be in `.gitignore` — generated artifacts
