## Codex runtime adapter

- Canonical workflows, roles and skills may contain render-time model argument tokens. Before acting on tokenized prose, read its resolved form with `node .codex/core/render-shared-agents.js --prose .agents/skills/{name}/references/workflow.md --runtime codex` (use the actual canonical Markdown path, including a role or skill entry point when applicable). This read-only command uses the current checkout's Codex tier map, preserves canonical source and instructs omission of the model parameter for an empty tier. Follow the resolved instructions; do not substitute a Claude model name. Both review tiers may resolve to the same session model when unassigned, so distinct requested tiers alone do not prove model diversity.

- Execute shared helpers through `.codex/core/{helper}.js`. Translate `.claude/core/` command examples to `.codex/core/` before running them, preserving arguments and gates. Follow the helper-routing rule in `.agents/startup.md`; edit implementations under `.agents/core/`.

- Treat `$ARGUMENTS` as the user's invocation arguments. For another slash command, use the corresponding native skill (replace namespace `:` with `-`) and read its authored workflow.
- Read/Edit/Write/Grep/Bash mean the available file, search and executor tools. Adapt shell examples to the current shell; retain paths, checks and failure handling.
- TaskCreate/TaskUpdate mean the native task or plan tools. Keep the workflow's dependency and acceptance checks.
- Agent means native subagent delegation. Use a matching installed `.codex/agents/*.toml` role when the native dispatcher supports named roles. Otherwise have a native worker read `.agents/roles/{role}.md` (or the legacy `.claude/agents/{role}.md`) and its declared skills, and apply that guidance with project context. Record this as a worker applying canonical role guidance; do not claim named-role dispatch.
- Claude model names and Claude-only hook/tool configuration apply to Claude adapters. Use the configured Codex model and native tools; do not pass Claude model identifiers to Codex.
- Do not assume Claude startup hooks ran or project memory was injected. Deduplicate only memory actually visible/read; load handoff files only when relevant to the task.
- Keep all required gates and evidence rules. Agent-system tests belong in Domdhi.Agents; adopter Build/Test/PR gates remain application-only.
