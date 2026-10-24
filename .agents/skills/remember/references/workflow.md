# Remember

Pin a conversational insight to the memory pipeline. Use when a Q&A exchange, investigation, or design decision should persist beyond the current session — things that git commits and TODO files can't capture.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js remember
```

## Variables

NOTE: $ARGUMENTS

- `NOTE` (optional): What to remember. If omitted, you MUST synthesize the key insight from recent conversation context yourself.

## Workflow

### Step 1: Synthesize the note

If `NOTE` is provided, use it directly.

If `NOTE` is empty, review the last ~10 messages in conversation and distill the most valuable insight — a decision made, a pattern discovered, a tradeoff analyzed, or a question answered. Write 2-5 sentences capturing the **what** and **why**.

**Iron Law:** NEVER capture trivial observations ("we read a file") or restate what git already shows ("committed fix for X"). The note MUST contain reasoning, context, or synthesis that would be lost without explicit capture.

### Step 2: Write to daily log

```bash
node .claude/core/daily-log.js note "{the synthesized note}"
```

The note is appended to `docs/.output/.state/memory-daily/{YYYY-MM-DD}.md` with a `## HH:MM — remember` header.

### Step 3: Report

```
Remembered: {1-line summary of what was captured}
→ {daily log path}
```

## Anti-Patterns

- **DO NOT capture what git already knows** — commits, file changes, branch state
- **DO NOT capture TODO state** — that's in the checklist files
- **DO NOT write multi-paragraph essays** — 2-5 sentences of insight, not a report
- **DO NOT ask the user what to remember** — if no argument given, synthesize it yourself from conversation context
- **DO NOT commit** — this is a lightweight capture, not a lifecycle event
