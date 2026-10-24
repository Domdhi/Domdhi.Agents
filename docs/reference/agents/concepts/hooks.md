# Hooks

Hooks run deterministic Node handlers on supported runtime events. Shared implementations live in `.agents/hooks/`; native `.claude/hooks/` and `.codex/hooks/` wrappers forward to them. Registration and protocol differences belong in `.agents/adapters/`. Hooks have no mandatory runtime npm dependencies.

## Claude handler inventory

Claude registers 16 handlers. `secret-patterns.cjs` is a shared library, not a seventeenth registered hook. Authoritative shared registration is [Claude adapter settings](../../../../.agents/adapters/claude/settings.json); installed settings may add project hooks.

| Handler | Claude event/tool | Purpose |
| --- | --- | --- |
| `session-start-prime.cjs` | SessionStart | Structured memory context |
| `session-end-doc-sync.cjs` | SessionEnd | Advisory legacy/duplicate/misplaced doc check |
| `secret-scanner.cjs` | Pre Write/Edit/MultiEdit/NotebookEdit | Refuse secret-bearing added text |
| `path-guardrail.cjs` | Pre Write/Edit/MultiEdit/NotebookEdit | Path tiers and freeze-state rules |
| `guardrail.cjs` | Pre Bash/PowerShell | Destructive command/path checks |
| `commit-guard.cjs` | Pre Bash/PowerShell | Route inline commit messages through the commit helper |
| `pre-compaction-archive.cjs` | PreCompact | State snapshot and daily log |
| `post-read-scrubber.cjs` | Post Read/Bash/PowerShell | Secret detection and shell-output redaction |
| `skill-usage-logger.cjs` | Post Read/Agent/Task | Skill-read and declared-dispatch telemetry |
| `organize.cjs` | Post ExitPlanMode/Bash/PowerShell | Plan and screenshot organization |
| `damage-control.cjs` | Post Bash/PowerShell | Failure analysis |
| `command-usage-logger.cjs` | Post Skill/Bash/PowerShell | Command/gate telemetry |
| `memory-guard.cjs` | Post Write | Category-capacity warning |
| `memory-capture.cjs` | Stop and Post Bash/PowerShell | Daily capture, strict-profile Sonnet curation and commit context |
| `edit-capture.cjs` | Post Edit | Strict-profile canonical-doc edit capture |
| `worktree.cjs` | WorktreeCreate/WorktreeRemove | Sibling worktree lifecycle and include copies |

Claude registration covers eight event types: SessionStart, SessionEnd, PreToolUse, PostToolUse, PreCompact, Stop, WorktreeCreate and WorktreeRemove. ExitPlanMode is a tool matcher under PostToolUse, not another event.

PreToolUse can deny before tool execution. Exit 2 is a blocking refusal; exit 1 is a warning. PostToolUse acts after effects occurred: the scrubber emits redacted shell output, while Claude Read-output replacement remains limited by native support. Post-completion handling cannot undo filesystem/network effects.

The worktree handler creates worktrees under the sibling `.worktrees/{repo}/` root (or `AGENTS_WORKTREE_ROOT`), copies Git-ignored `.worktreeinclude` matches and removes without force. Modified/untracked non-ignored files keep the worktree; ignored files are removed with it. Failure/cleanup diagnostics must be evaluated from the actual result, not assumed from attempted cleanup.

## Codex adaptation and trust

[The Codex adapter](../../../../.agents/adapters/codex/README.md) defines supported events and conversions:

- Bash uses shell guards and post-output handlers; apply_patch is parsed into independent added-text/write/delete/move events.
- MCP output is scrubbed; Agent's supported spawn alias records declared-skill telemetry.
- SessionStart emits additional context; SessionEnd and PreCompact retain their shared handlers.
- Claude `ask` becomes a Codex denial with a review reason. Post-output redaction uses `continue: false` and feedback after tool completion.
- Claude Read/Skill/Task/ExitPlanMode registrations are not invented as Codex tools. Automatic Stop/Post-Bash memory extraction is unregistered; session-handoff and explicit helpers remain the acquisition path.

Repository and exact-hook trust are required. Changed definitions can be skipped pending native review; installation/parity/discovery do not prove trusted model-visible execution. Some hosted/specialized tools and plain terminal commands bypass runtime hooks. Hooks are not a complete enforcement boundary. Current v6 work has no fresh live Windows/trusted native-model proof; historical reference probes are separately attributed in the adapter README.

## Commit scanning

Secret protection has two toolkit paths: runtime pre-write scanning and the staged scan invoked by native `commit.js`. The old `.githooks/pre-commit` installation is retired. A plain terminal `git commit` bypasses the commit helper's scanner.

```sh
# Codex; Claude uses .claude/core/commit.js.
node .codex/core/commit.js --help
```

Use the established commit workflow and explicit owned staging. Shared secret rules live in `.agents/hooks/secret-patterns.cjs`.

## Adding a handler

Author a CommonJS `.cjs` handler under `.agents/hooks/`, register it in the relevant adapter metadata and render native entry points. Preserve project hook registrations through the [settings merger](../customization.md#settings-merge). Add meaningful tests under canonical `.agents/hooks/__tests__/` or the applicable adapter test directory. Native behavior needs actual wrapper/handler checks; unit tests alone do not prove runtime trust.

Use hooks for event-driven checks without model judgment. Use a workflow or role when the action needs reasoning. See [memory](memory.md), [customization](../customization.md) and [migration v6](../migration-v6.md).
