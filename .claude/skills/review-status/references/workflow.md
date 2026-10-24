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
