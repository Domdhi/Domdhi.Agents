# Domdhi.Agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Built for Claude Code](https://img.shields.io/badge/Built_for-Claude_Code-orange.svg)](https://claude.com/claude-code)

A portable toolkit authored in `.agents/`, with generated Claude Code and Codex entry points. Install it into any project for structured workflows from brainstorm to deployment — 49 workflows, 11 specialized roles, 23 knowledge skills, and a memory system that compounds across sessions.

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
.agents/                     Canonical authored toolkit
├── roles/                   11 shared role definitions
├── skills/                  49 workflows and 23 knowledge skills/assets
├── core/ and hooks/         Shared executable helpers and lifecycle behavior
├── adapters/                Claude/Codex protocol, model and native metadata
├── templates/ and config/   Shared document templates and policy
└── startup.md               Required shared guidance; reference is conditional

.claude/                     Generated Claude commands, roles, hooks and wrappers
.codex/                      Generated Codex roles, hook config and wrappers
docs/                        Adopter-facing documentation + planning outputs
CLAUDE.md and AGENTS.md       Project-owned instructions with managed startup directives
```

## Install

**Prerequisites.** Claude Code or Codex installed and working in your terminal. If `claude` doesn't launch, start with the [Claude Code install docs](https://docs.claude.com/claude-code) before adopting this template. **Node 24+ is recommended** — its built-in `node:sqlite` gives the memory system FTS5 search with zero dependencies. On Node 22–23, the optional `better-sqlite3` package supplies SQLite; earlier Node versions retain the JSON-scan fallback. Toolkit contributors running Vitest 5 need Node 22.12+ (Node 24 recommended). Runtime hooks and helpers require Node and have no mandatory npm dependencies.

Install from a pinned toolkit checkout into your application's own repository. Keep the toolkit's history separate from application history.

```sh
# Codex helper; Claude uses .claude/core/ with the same arguments.
node .codex/core/install.js /path/to/your-project --dry-run
node .codex/core/install.js /path/to/your-project
```

For a new application with no filled planning docs, launch your runtime in the application checkout and run Claude `/create:new-project` or Codex `$create-new-project`. It scaffolds missing docs, interviews you, chains the planning pipeline, specializes roles and writes project context. Existing application code uses `/onboard` or `$onboard` to derive architecture/context from reality before specialization.

Ordinary install/update requires no organization declaration. Existing settings, project instructions, role identity/context, bespoke skills and marked additions use the established preservation/merge path. Preview later updates before applying:

```sh
node .codex/core/template-updater.js update /path/to/your-project --merge --dry-run
node .codex/core/template-updater.js update /path/to/your-project --merge
```

**Secret-scanning engine.** The hooks and `commit.js` scan with a pinned [Betterleaks](https://github.com/betterleaks/betterleaks) binary. It is not stored in your repository: install it once per machine and user with `node .codex/core/secret-engine-install.js` (Claude: `.claude/core/`). The installer downloads the pinned release, refuses it unless its sha256 matches the value pinned in the toolkit, checks the extracted binary against its own pinned sha256, and keeps it in a private (`0700`) user cache. `install.js` and `template-updater.js update` report its status and offer the install on a terminal. Whatever binary is used, including `AGENTS_SECRET_ENGINE_BIN` or a `betterleaks` on an absolute `PATH` entry, must hash to the pinned binary; a version string alone is not accepted. Until it is installed, commits and Write/Edit are blocked (they fail closed), and so is any export to GitHub; the output scrubber and the memory writers fall back to a built-in list of provider key patterns. Check with `--check`.

**Git hooks.** `install.js` and `template-updater.js update` also install five small, untracked git hooks (`pre-commit`, `commit-msg`, `pre-merge-commit`, `pre-applypatch`, `pre-push`) so the same secret scan runs where git creates and publishes commits, including a plain `git commit -F <file>` in a terminal. Coverage, exactly: the commit hooks cover commit, merge and `git am`; the pre-push hook scans every object a push would publish (blobs, commit messages and annotated tag messages, trusting only what the remote itself vouches for), which backstops the paths that run no hook (cherry-pick, rebase, `commit-tree`, stash merges, tags). A commit you never push is not covered, and you can always skip a hook yourself. They are written into the repository's git directory (never into the tracked tree), and only when git runs hooks from there: a `core.hooksPath` that points at a project directory such as `.husky` is left alone and reported with the exact line to add to your own hook. A hook you wrote is never overwritten (only files whose first comment line is the toolkit's `domdhi-agents managed hook` marker are refreshed or removed). They fail closed like the engine: a missing `node`, scanner, or a scanner from a toolkit that predates the managed hooks (an old branch or worktree) blocks with a message that says how to fix it or remove the hook. Check, install or remove them with `node .agents/core/git-hooks.js [--check|--remove]`. `CLAUDE_COMMIT_NO_SCAN=1` is the one audited bypass (one recorded event per bypassed commit).

See [v6 migration](./docs/reference/agents/migration-v6.md) for canonical authoring, native helpers, conflicts, runtime limits and the distinction between local release preparation and publication.

### Codex workflows

The same install/update path supplies native repository skills under `.agents/skills`. Launch Codex in the installed project and select `$todo`, `$run-todo`, `$prime`, or another workflow through `$` or `/skills`. Namespaced Claude commands use hyphenated Codex names: `/review:qa` becomes `$review-qa`; `/create:module` becomes `$create-module`. If an existing session does not show newly installed skills, start a fresh session.

Most workflow bodies live in `.agents/skills/{name}/references/workflow.md` (review-specialize keeps its body in `SKILL.md`); knowledge and assets live beside their canonical skill. Roles, helpers, hooks and templates are also authored under `.agents/`, with runtime-specific metadata in `.agents/adapters/`. Run `node .claude/core/render-shared-agents.js --check` to inspect generated output, or omit `--check` to render. Existing helper and Claude command paths remain compatible. Root `CLAUDE.md` and `AGENTS.md` load a small required policy; detailed references load for the current task. Ordinary updates retain project root prose, marked additions and local settings. Toolkit tests colocate under `.agents/**/__tests__/` and workshop `tools/__tests__/`; they run only in Domdhi.Agents. Adopter Build/Test/PR gates remain application-only.

## Configuration

### Recommended effort level

Domdhi.Agents commands like `/do`, `/run-todo`, and `/onboard` orchestrate multiple sub-agents, read and write files, run build gates, and commit. For these to work reliably, Claude Code's **effort level** should be set to `high` or above. At lower effort levels the model may cut planning steps short or skip agent delegation — both break the orchestration contract. Set effort before running any lifecycle command:

```
/config set effort high
```

(Or use the Claude Code settings UI. This is a per-session setting.)

### Troubleshooting runtime behavior

Check the actual runtime, installed helper path, discovered workflow and trusted hook definitions first. Inspect registered handlers and their output rather than infer execution from matching generated bytes. The [hook guide](./docs/reference/agents/concepts/hooks.md) documents supported events, post-output redaction, plain-terminal gaps and native trust limits.

Codex optional memory inference is unavailable; session handoff and explicit curated-memory helpers remain supported. Current local v6 preparation does not establish fresh live Windows or trusted native-model execution. The [migration guide](./docs/reference/agents/migration-v6.md) preserves those evidence boundaries.

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
