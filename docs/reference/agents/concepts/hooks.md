# Hooks

A hook in this system is a Node script that Claude Code runs automatically on specific events — session start, pre/post tool use, pre-compaction, stop. Hooks are not dispatched by the main agent and have no prompt; they execute deterministically every time their trigger fires, regardless of what the model is doing. This template ships 12 of them, and they're how the system enforces secrets scanning, organizes generated output, captures memory, and guards the shell.

Hooks are the right mechanism when the work must happen *every time* and does not require judgment. If the logic needs model reasoning, it belongs in a command or an agent. If it needs to happen deterministically on a specific event, it belongs in a hook. That boundary is the single most useful thing to keep in mind when reading the catalog below or considering a new one.

## The 12 hooks

| Hook | Trigger | Purpose |
|------|---------|---------|
| `session-start-prime.cjs` | SessionStart | Injects top structured memories (JSON from memory-manager.js) as a system-reminder at session opening |
| `secret-scanner.cjs` | Pre-Write/Edit | Blocks secrets from being written to files |
| `guardrail.cjs` | Pre-Bash | Blocks/confirms destructive commands via `guardrail-rules.yaml` |
| `path-guardrail.cjs` | PreToolUse:Write/Edit/MultiEdit/NotebookEdit | Blocks write/edit ops via the four-tier path schema (zeroAccessPaths/readOnlyPaths/noDeletePaths) and freeze-state checks |
| `pre-compaction-archive.cjs` | Pre-Compact | Snapshots state + daily log before context compaction |
| `post-read-scrubber.cjs` | Post-Read | Warns on secrets in read files (non-blocking) |
| `organize.cjs` | Post-ExitPlanMode, Post-Bash | Moves plans to `docs/.output/plans/{date}/` and screenshots to `docs/.output/.state/screenshots/{date}/{task}/` |
| `damage-control.cjs` | Post-Bash | Error analysis on failures — prevents retry spin loops |
| `command-usage-logger.cjs` | Post-Skill/Bash | Logs command invocations + gate runs to `docs/.output/.state/telemetry/` |
| `memory-guard.cjs` | Post-Write | Warns when a memory category approaches its size limit |
| `memory-capture.cjs` | Stop, PostToolUse:Bash | Auto-compounds memory on Stop (capture → curate under strict profile only); commit enrichment on Bash. Compile pipeline retired 2026-04-20. |
| `edit-capture.cjs` | Post-Edit | Captures edits to canonical docs (CLAUDE.md, architecture, skills) as daily-log entries (`MEMORY_PROFILE=strict` only) |

Each hook file lives at `.claude/hooks/{name}.cjs`. The `.cjs` extension is required — the hooks are CommonJS modules so they load synchronously under the Claude Code hook runner. Each hook is also testable in isolation; unit tests live at `.claude/hooks/__tests__/{name}.test.js`.

A twelfth file in `.claude/hooks/` is `secret-patterns.cjs` — **not a registered hook**, but the shared pattern library used by both `secret-scanner.cjs` (pre-write block) and `post-read-scrubber.cjs` (post-read warn). One source of truth for which strings count as secrets.

Hook wiring — which matcher fires which script — lives in `.claude/settings.json` under `hooks.{event}[].matcher`. That file is the ground truth. If the catalog above disagrees with `settings.json`, trust `settings.json`.

## Trigger taxonomy

Claude Code fires hooks on five event types. This template uses all five:

- **`SessionStart`** — fires once when a new session opens, before the first user message. One hook: `session-start-prime.cjs` primes the context with top memory concepts. Use SessionStart for anything that must precede the first turn.
- **`PreToolUse`** — fires before a tool call executes and can block the call by returning a non-zero exit. Three hooks: `secret-scanner.cjs` and `path-guardrail.cjs` on `Write`/`Edit` (and `MultiEdit`/`NotebookEdit` if registered); `guardrail.cjs` on `Bash` (refuses or confirms destructive shell commands). Pre hooks are the enforcement layer — if you want to *prevent* something, this is the only event that can.
- **`PreCompact`** — fires when Claude Code is about to auto-compress the conversation. One hook: `pre-compaction-archive.cjs` snapshots state + captures a daily log before context is compressed. This is the last safe point to persist anything you want to survive compaction.
- **`Stop`** — fires when the session ends. One hook: `memory-capture.cjs` captures the daily log on every Stop and runs the Haiku curator under MEMORY_PROFILE=strict only. The compile step was retired 2026-04-20; extraction is manual-only via memory-extractor.js. Use Stop for "on-exit" cleanup and persistence.
- **`PostToolUse`** — fires after a tool call completes. Six hooks chain here across multiple matchers: `post-read-scrubber.cjs` (Read), `organize.cjs` (ExitPlanMode + Bash), `damage-control.cjs` (Bash), `command-usage-logger.cjs` (Skill + Bash), `memory-guard.cjs` (Write), `edit-capture.cjs` (Edit), and `memory-capture.cjs` fires here too for Bash (commit context enrichment). Post hooks observe but cannot block — use them for logging, filing, and side-effect work.

Two hooks are registered on multiple events: `memory-capture.cjs` fires on both `Stop` and `PostToolUse:Bash`, and `secret-scanner.cjs` fires on both `PreToolUse:Write` and `PreToolUse:Edit`. Multi-wire is fine when the same script handles multiple triggers with consistent behavior; the hook itself disambiguates based on the event payload.

## When to add a custom hook

Before adding a hook, make sure a hook is the right shape for the work:

- **Does it need to happen on *every* tool call, session event, or compaction?** → Hook.
- **Does it need model reasoning or user interaction?** → Command, not hook.
- **Does it need to happen as part of a specific task and can be delegated?** → Agent, not hook.
- **Does it need to *prevent* an action from happening?** → Hook on `PreToolUse` — nothing else can block.
- **Does it need to run outside Claude Code entirely (e.g., on git commit)?** → Git hook in `.githooks/`, not a Claude Code hook.

When the answer is "hook," the conventions are:

1. Write a `.cjs` file under `.claude/hooks/`. CommonJS, synchronous load. Shared logic goes in a sibling `.cjs` helper (see `secret-patterns.cjs` for the pattern).
2. Wire it in `.claude/settings.json` under the correct event matcher. Match on the tool name (`Write`, `Edit`, `Bash`, `Read`, `Skill`, `ExitPlanMode`) or use `""` for "all."
3. Exit code 0 for allow, non-zero for block (Pre events only). Write structured output to stderr when blocking — Claude Code surfaces it to the model.
4. Add a unit test at `.claude/hooks/__tests__/{name}.test.js`. Hooks run on every event; regressions are expensive. The existing test suite is the precedent to follow.
5. Keep hooks fast. Anything above ~200 ms becomes perceptible friction on every tool call. If the work is expensive, either debounce it (write to a daily log, process later on Stop) or move it to a post-event queue rather than running it inline.

Don't add a hook for project-specific one-off behavior. Hooks are for cross-cutting, always-on system concerns — secrets, memory, telemetry, organization, guardrails. If it's story-specific, it belongs in a command.

## Claude Code hooks vs git hooks

This template runs `secret-scanner.cjs` through two independent paths. The Claude Code hook catches secrets *before Claude writes the file* — a soft enforcement tied to the agent's tool call. The git pre-commit hook at `.githooks/pre-commit` catches secrets *before the commit lands* — a hard enforcement tied to git, independent of how the file got there (Claude, IDE, manual edit, another tool). Both paths share `secret-patterns.cjs` so the rules stay consistent.

This is deliberate dual-enforcement — if you bypass Claude Code (edit a file in your IDE directly), the git hook is still there. When customizing, remember that the two hook systems are separate: `.claude/hooks/` is Claude Code's, `.githooks/` is git's. They don't share a runner, only a pattern library.

---

See also: [`./agents.md`](./agents.md) for the 11-agent inventory, [`./commands.md`](./commands.md) for the orchestration layer, [`./memory.md`](./memory.md) for the auto-compound pipeline that `memory-capture.cjs` drives on `Stop`.
