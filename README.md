# Domdhi.Agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Built for Claude Code](https://img.shields.io/badge/Built_for-Claude_Code-orange.svg)](https://claude.com/claude-code)

A portable `.claude/` directory that turns Claude Code into a full development lifecycle system. Drop it into any project for structured workflows from brainstorm to deployment — slash commands, 11 specialized agents, 23 skill modules, and a memory system that compounds across sessions.

**Tech-agnostic by default.** Works with any stack. Run `/review:specialize` to generate project-specific agents from your architecture doc.

## What You Get

- **Three-tier architecture** — commands orchestrate, agents work with personality, skills hold domain knowledge. No duplication between layers.
- **11 baseline agents** — product strategist, architect, UX designer, planner, coder, reviewer, security auditor, QA engineer, doc-writer, browser tester, ghostwriter. Extend with `/review:specialize` for your stack; name and personalize them with `/review:personalize`.
- **23 skill modules** — templates, checklists, and quality criteria for everything from ADR writing to code review to TDD.
- **Memory that compounds** — every session handoff writes structured memories; FTS5 search surfaces them on demand. On Node 24+ this runs on the built-in `node:sqlite` with **zero dependencies**; older Node falls back to the optional `better-sqlite3` or a plain JSON scan. Confidence decays on active work days, so idle projects don't rot.
- **Hooks as rails** — secret scanning, destructive-command guardrails, and command telemetry out of the box.
- **Build gate on autopilot** — `gate.js` auto-detects Node, Rust, Go, .NET, and Make projects. Override with `gate.config.json`.

## Repo Layout

```
.claude/                     Template runtime — this is what you're adopting
├── agents/                  11 agent definitions (extensible)
├── commands/                Slash commands — setup, build loop, review
├── skills/                  23 domain-knowledge modules
├── hooks/                   14 event-driven hooks
├── core/                    Runtime scripts (gate, scaffold, memory, status)
├── templates/               Blank doc templates with marker convention
└── settings.json            Permissions, hook wiring, plan directory

docs/                        Adopter-facing documentation + generated planning docs
CLAUDE.md                    Auto-loaded project instructions for Claude Code
```

## Install

**Prerequisites.** Claude Code installed and working in your terminal. If `claude` doesn't launch, start with the [Claude Code install docs](https://docs.claude.com/claude-code) before adopting this template. **Node 24+ is recommended** — its built-in `node:sqlite` gives the memory system FTS5 search with zero dependencies. The toolkit still works on older Node (JSON-scan fallback, or `npm install` for the optional `better-sqlite3`), and the hooks need no Node at all.

There are two ways to adopt the template, depending on whether you're starting fresh or adding it to an existing project.

### New project (greenfield)

```bash
# Clone the template into a fresh project directory
git clone https://github.com/Domdhi/Domdhi.Agents.git my-project
cd my-project
rm -rf .git && git init

# Open in Claude Code
claude
```

Inside Claude Code, run:

```
/create:new-project
```

That's the one command to get from zero to implementation-ready. It scaffolds the `docs/` tree, interviews you, chains the planning pipeline (brief → PRD → architecture → epics), specializes the agents for your stack, and commits the whole initialization.

### Existing codebase (brownfield)

Don't run `/create:new-project` in a project that already has code — it's built for an empty repo. Instead, use the one-command installer to copy `.claude/` in (it has zero runtime dependencies and prompts on any conflict):

```bash
# From a clone of this template, install .claude/ into your existing project
node .claude/core/install.js /path/to/your-project
```

This preserves your `settings.json`, agent personalities, and any local customizations while bringing in the commands, agents, skills, and hooks. Then open your project in Claude Code and run:

```
/onboard
```

`/onboard` is the brownfield analog of `/create:new-project` — it reverse-engineers `architecture/overview.md` and `product/context.md` from your existing code, merges `CLAUDE.md` additively (never clobbering your instructions), and chains `/review:specialize` to tailor the agents to your stack.

**To update an existing install later, run the zone-aware updater — don't re-clone:** `node .claude/core/template-updater.js update /path/to/your-project --merge`.

## Configuration

### Recommended effort level

Domdhi.Agents commands like `/do`, `/run-todo`, and `/onboard` orchestrate multiple sub-agents, read and write files, run build gates, and commit. For these to work reliably, Claude Code's **effort level** should be set to `high` or above. At lower effort levels the model may cut planning steps short or skip agent delegation — both break the orchestration contract. Set effort before running any lifecycle command:

```
/config set effort high
```

(Or use the Claude Code settings UI. This is a per-session setting.)

### Troubleshooting: isolating Domdhi.Agents from Claude Code itself

If something goes wrong and you can't tell whether the issue is in Domdhi.Agents or in Claude Code's built-in behavior, the fastest bisect is to disable the template entirely and reproduce in a bare session.

Claude Code's `--safe-mode` flag (if available in your version) disables extensions when starting a session — use it to rule out the `.claude/` hooks and commands:

```bash
claude --safe-mode
```

If the problem disappears in safe mode, it originates in Domdhi.Agents (hooks, commands, or agents). If it persists, the issue is in Claude Code itself.

**If `--safe-mode` is not available in your version**, the same bisect works manually: temporarily rename `.claude/` to `_claude_disabled/`, open a plain Claude Code session, reproduce the issue, then rename the directory back. The goal is the same — remove all of Domdhi.Agents and confirm whether the problem follows.

### Domdhi.Agents vs first-party Claude Code extensions

There are two first-party Claude Code extensions that are sometimes compared to this template: `feature-dev` and `claude-code-setup`. The differences are architectural:

| | Domdhi.Agents | `feature-dev` / `claude-code-setup` |
|---|---|---|
| **Lifecycle** | End-to-end: brainstorm → PRD → architecture → epics → implementation → review → retro | Implementation-phase only |
| **Design phase** | First-class: UX spec, wireframes, themes, mock layout via `ux-designer` agent | Not covered |
| **Doc governance** | Zone-aware two-repo model (template zone vs project zone; `template-updater.js` syncs without clobbering adopter customizations) | Single-repo, no zone model |
| **Agent layer** | 11 specialized agents with skill auto-loading; extensible via `/review:specialize` | Generalist agents, no skill system |
| **Memory** | Persistent, decay-weighted, FTS5-searchable memory that compounds across sessions | Session-scoped only |

If you only need a coding assistant for an in-progress feature, the first-party tools may be enough. If you want a system that covers ideation through deployment and compounds knowledge over time, that's what this template is for.

## Getting Started

Full walkthrough with a concrete sample project: [**docs/reference/agents/getting-started.md**](./docs/reference/agents/getting-started.md) — about thirty minutes from clone to specialized, implementation-ready project.

## Customize for Your Stack

- [`docs/reference/agents/guides/specialize.md`](./docs/reference/agents/guides/specialize.md) — `/review:specialize` reads your architecture doc, appends stack context to every baseline agent, and generates new stack-specific agents
- [`docs/reference/agents/guides/personalize.md`](./docs/reference/agents/guides/personalize.md) — `/review:personalize` gives your agents names, personas, and soul-level identities — cosmetic until you work at scale, then it becomes how you think about the team

## Documentation

See [`docs/README.md`](./docs/README.md) for the full index — three reading orders by role (newcomer / adopter / contributor). Highlights:

- **Concepts** — [commands](./docs/reference/agents/concepts/commands.md), [agents](./docs/reference/agents/concepts/agents.md), [skills](./docs/reference/agents/concepts/skills.md), [memory](./docs/reference/agents/concepts/memory.md), [hooks](./docs/reference/agents/concepts/hooks.md)
- **Reference** — [commands](./docs/reference/agents/commands.md), [system-map](./docs/reference/agents/system-map.md), [customization](./docs/reference/agents/customization.md), [memory-flow](./docs/reference/agents/memory-flow.md)
- **Guides** — [specialize](./docs/reference/agents/guides/specialize.md), [personalize](./docs/reference/agents/guides/personalize.md), [contributing](./docs/reference/agents/guides/contributing.md)

## Contributing

To extend the system with a new agent, command, or skill without breaking the three-tier architecture, see [`docs/reference/agents/guides/contributing.md`](./docs/reference/agents/guides/contributing.md). The decision gate at the top of that guide — *agent vs. skill vs. command* — is the highest-leverage choice in any contribution.

## License

MIT. See [LICENSE](./LICENSE).
