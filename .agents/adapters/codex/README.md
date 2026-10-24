# Codex hook adapter

This is the Domdhi.Agents Codex adapter. Author implementations and runtime metadata under `.agents/`; `.codex/` is the generated native surface. Use `.codex/core/` helpers in Codex. Toolkit tests belong to Domdhi.Agents; adopter Build/Test/PR gates remain application-only. `tools/native-smoke.cjs` provides disposable execution and continuation fixtures; generated parity and discovery alone do not prove trusted runtime execution.

This adapter provides patch conversion, installed-hook dispatch, exit-status handling and single-response aggregation. It omits application guards and PR-body policies. Shared implementations remain in `.agents/hooks/`; generated `.codex/hooks/` files forward to those implementations. The converter invokes the registered installation's native hook wrapper, even when an event targets a standalone project. Corrupted or missing wrapper/adapter code refuses protected actions with exit 2.

The native registration is generated from `hooks-config.json`. Commands use Node's portable ancestor lookup rather than absolute checkout paths, POSIX substitutions or PowerShell syntax. `commandWindows` uses the same command. Session cwd can be a subdirectory. Node must be available on PATH.

## Context contract

`.agents/core/runtime-context.js` resolves the current source root in this order:

1. Explicit `AGENTS_PROJECT_DIR`, `AGENT_SOURCE_ROOT`, `CODEX_PROJECT_DIR`, then legacy `CLAUDE_PROJECT_DIR`.
2. Native event `cwd` or invocation cwd, using the nearest toolkit installation or Git checkout boundary. A standalone event cwd remains its own action context.
3. The registered entry point's installed root when no invocation project is found.

Toolkit code/assets resolve relative to the installed module, independently of the action context. `sourceRoot` refers to the active checkout. `sharedStateRoot` uses Git's common directory when it is a conventional `.git` directory, otherwise the source root. The adapter supplies `AGENT_SOURCE_ROOT` and `AGENT_SHARED_STATE_ROOT` to shared consumers; tracked memory is read from the active checkout, while ignored memory indexes/logs/inboxes stay shared with the main worktree. Existing Claude overrides remain compatible when neutral variables are absent. Separate Git directories use the standalone fallback.

Direct `.codex/core/` helpers also establish the Codex runtime when neither `AGENTS_RUNTIME` nor `AGENT_RUNTIME` is explicitly set. Memory helpers honor the same neutral/Codex source override order and derive shared state from that source's Git common directory; `AGENT_SHARED_STATE_ROOT` independently overrides ignored state. Verify direct helper CLI/import use as well as registered hook dispatch: a hook subprocess's environment does not set its parent session's helper context.

An explicit `AGENT_SHARED_STATE_ROOT` takes priority over Git derivation. Direct memory helpers use the same source override order as the context resolver; neutral/Codex source overrides derive shared state from that selected repository. For legacy direct helpers, `CLAUDE_PROJECT_DIR` alone retains its historical direct state-root override. The hook context continues deriving Git common state from a legacy source override before passing both neutral roots to its children.

## Registered behavior

| Native event/tool | Shared handlers |
| --- | --- |
| SessionStart | Structured-memory prime, translated to `additionalContext` |
| SessionEnd | Advisory documentation drift check |
| PreCompact | Snapshot and daily log |
| PreToolUse / Bash | Destructive-command and inline-commit guards |
| PreToolUse / apply_patch | Added-text secret scan; write/delete/move path rules |
| PostToolUse / Bash | Output scrubber, organization, damage control, command telemetry |
| PostToolUse / apply_patch | Memory-capacity warning and edit capture |
| PostToolUse / MCP | Text-output scrubber |
| SubagentStop | Completion-sourced dispatch telemetry and a nonblocking memory-inbox reminder |

Codex supplies `apply_patch.tool_input.command`; it is parsed into independent file events. Move sources and explicit deletes use delete policy; destinations use write policy. Secret scanning preserves the reference adapter's added-text behavior, rather than reconstructing the final file. Post-edit handlers consume completed events without reading deleted move sources. Dispatch telemetry records declared role skills and does not establish that the runtime loaded them.

`SubagentStop` records the native `agent_type`, child ID and nullable `last_assistant_message` in local `skill-usage.jsonl`, retaining the existing `agent_dispatch` consumer fields and labeling its completion source. Current canonical role declarations supply inferred skills; telemetry uses the independently resolved shared-state root. The handler caps stdin at 64 KiB/one second, recorded message at 4,096 characters and quoted reminder excerpt at 256. Role metadata is bounded and omissions are labeled. It ignores payload-provided destinations/transcripts, refuses static telemetry symlink escapes and creates no memory drafts. Its JSON `systemMessage` is a native warning containing untrusted quoted child data and an inbox-review reminder; it does not force continuation or inject parent prompt context. The October 18 native proof verified ordinary hooks in a child before implementation, then verified this registered lifecycle handler with a child that used no tools.

The scrubber normalizes native string/output/MCP text-array responses. Claude's `updatedToolOutput` becomes Codex's supported `continue: false` plus redacted feedback. This changes what the model receives after completion and cannot undo tool effects. Claude's `permissionDecision: ask` becomes a Codex denial with a review reason because Codex currently parses but does not support `ask`; users review the action explicitly before retrying.

## Runtime limits and verification

Rendering also manages `.codex/hook-identities.json` alongside `.codex/hooks.json` in the projection ledger. Each entry records an ID, a canonical SHA-256 definition fingerprint and its native group/handler position. A render preview or render reports `this change invalidates trust for N handlers` when existing metadata shows changed definitions, moved positions or new registrations. A handler changed and moved is counted once; removed handlers are not counted. The first sidecar establishes a baseline without a warning. Formatting and object-property order do not affect fingerprints. These toolkit fingerprints are change detectors; they are not native `currentHash` values and do not establish trust or execution.

Toolkit IDs use event, matcher and the launcher's literal `process.argv[2]` script name. Launcher, timeout and Windows-command edits retain the ID; changing the event, matcher or script replaces the registration. Other command handlers use their exact portable command as identity, so command edits replace their identity too. Duplicate identities and malformed prior metadata fail before writes rather than guessing matches by position. An existing unmanaged sidecar conflicts, including with `--force`; preserve or relocate the adopter file before rendering. Install/update also refuse a different, unledgered adopter helper at the new `.agents/core/_lib/codex-hook-identities.js` path before writes. The sidecar follows the renderer's dry-run, selected-output and deferred-output rules, and output conflicts prevent the complete render transaction.

Official behavior reference: [Codex hooks](https://learn.chatgpt.com/docs/hooks), checked October 7, 2026. Repository `.codex/` trust and review/trust of each exact hook definition are required; new or changed hooks are skipped pending review. Installation and generated-byte checks do not establish trust or model-visible execution. No trust settings are changed by this toolkit.

Claude's `Skill`, `Read`, `Task` and `ExitPlanMode` tool registrations are not copied as fictitious Codex tools. MCP and Bash outputs are covered; completion telemetry uses `SubagentStop` rather than a registered `Agent` alias. The dispatcher retains legacy `spawn_agent` translation for compatibility, and explicit workflows still provide skill/command usage and organization. Some specialized/hosted tools bypass native hooks; hooks are not a complete enforcement boundary. Plain terminal commands also bypass runtime hooks; commit scanning remains in the commit helper.

The reference adapter deliberately leaves automatic Stop/Post-Bash memory extraction unregistered. That limitation remains: use the established session-handoff workflow or explicit memory helpers. Prompt/agent hook handler types, unsupported output fields and PermissionRequest auto-approval are not synthesized.

Optional Codex model inference for the memory extractor, curator and benchmark is disabled. The installed CLI has no supported, verified tool-free invocation matching the established memory isolation requirement; read-only sandboxing still permits private-file reads. The backend returns unavailable/null with a diagnostic before launching a subprocess, and failed extraction remains unmarked for retry. Use session handoff and explicit curated-memory CRUD/inbox promotion instead. Claude's existing tool-free backend remains available. The retained JSONL decoder rejects command, MCP and other tool items as defense in depth; rejecting a response after execution cannot prevent tool effects.

Behavioral tests remain in `.agents/core/__tests__/runtime-adapter.test.js`. They exercise inherited conversion cases, native wrapper corruption/absence, emitted launch commands from nested directories, and actual linked-worktree memory consumers. Retained reference evidence from the earlier converter describes a Windows Node v25.2.1 probe through `cmd.exe` in a relocated path with spaces: patch/commit denials, startup context, MCP redaction and corrupted adapter refusal. This is historical handler/launcher evidence, not a fresh Windows execution result for Domdhi's local v6 update. Live Windows and trusted fresh-session native-model execution remain unverified in the current release work; installed Codex trust and model visibility require their own observed evidence.
