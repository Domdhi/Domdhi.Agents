# Organize

Organize loose files into structured date/session folders.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:organize
```

## Execution

```bash
node .claude/hooks/organize.cjs
```

Report the output to the user.

**Note:** This also runs automatically as a hook — after ExitPlanMode (plans) and after Bash (screenshots). This command is for manual cleanup.
