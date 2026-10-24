<!-- Mirror of docs/README.md, links rewritten relative to docs/reference/agents/. Edit docs/README.md and refresh this mirror. Reference documentation is a publish artifact; install/update do not copy it. -->

# Domdhi.Agents Documentation

This is the docs index. Everything under `docs/` is organized around one idea: the path through the docs depends on your role. A newcomer trying to understand what this *is* reads different things than an adopter using it day to day, who reads different things than a contributor extending it. Pick your lane below.

If you just want to try it, skip everything on this page and open [`getting-started.md`](./getting-started.md) — it walks you from an empty directory to a specialized, implementation-ready project in about thirty minutes.

## For Newcomers — Understand What This Is

Start here if you've just landed and want the shape of the system before committing to adopt it.

1. [`getting-started.md`](./getting-started.md) — Install to implementation-ready, via `/create:new-project`. The one-page walkthrough.
2. [`concepts/commands.md`](./concepts/commands.md) — The orchestration tier. What slash commands are, how they decide what to gate, what to delegate, and what to commit.
3. [`concepts/agents.md`](./concepts/agents.md) — The 11 specialists. Model hierarchy — Claude uses Sonnet floors and pinned/escalated Opus; Codex uses configured native models.
4. [`concepts/skills.md`](./concepts/skills.md) — Canonical knowledge skills, workflow selectors and runtime-specific loading/discovery.

Four docs. Read in order. By the end you know what the system is and what role each tier plays.

## For Adopters — Using It Day to Day

Read these once you've initialized a project and want to use it well. For an existing installation, start with [v6 migration](./migration-v6.md).

1. [`reference/commands.md`](./commands.md) — Complete 49-workflow reference with Claude/Codex names and authored procedures.
2. [`guides/specialize.md`](./guides/specialize.md) — `/review:specialize --fix` walkthrough. Appends project context to the baseline agents and generates stack-specific agents from your architecture doc.
3. [`guides/personalize.md`](./guides/personalize.md) — `/review:personalize` walkthrough. Gives agents names, personas, and soul-level identities. Cosmetic until you work at scale — then it becomes how you think about the team.
4. [`concepts/memory.md`](./concepts/memory.md) — How memories compound across sessions. Active-work-day decay (idle projects don't rot), confidence tiers, the session-handoff write path.
5. [`concepts/hooks.md`](./concepts/hooks.md) — The 16 Claude handlers and supported Codex adaptation. Secret scanning, guardrails, session memory capture — what happens without you asking.

## For Contributors — Extending the System

Read these when you want to add an agent, a command, or a skill — or when you need to see exactly how the pieces wire together.

1. [`guides/contributing.md`](./guides/contributing.md) — Decision gate for what you're actually adding (agent vs. skill vs. command), then `/create:component` to scaffold it without breaking the three-tier architecture.
2. [`reference/system-map.md`](./system-map.md) — Full inventory: agents × skills × commands × hooks. The wiring map.
3. [`reference/customization.md`](./customization.md) — Zone map. Which sections of agent files are yours to edit vs. template-managed. Essential before any `/review:specialize` or `/review:personalize` edits.
4. [`reference/memory-flow.md`](./memory-flow.md) — Mermaid diagram of memory writes, reads, and maintenance. Companion to `concepts/memory.md`.

## All Docs — Flat Reference

If you came here from a search engine or a link and just need to find a specific doc:

| Doc | Path | What's in it |
|-----|------|--------------|
| v6 Migration | [`migration-v6.md`](./migration-v6.md) | Canonical sources, native limits and prepared-release distribution |
| Getting Started | [`getting-started.md`](./getting-started.md) | Pinned install, `/create:new-project`, specialize, commit |
| Commands (concept) | [`concepts/commands.md`](./concepts/commands.md) | Orchestration tier explainer |
| Agents (concept) | [`concepts/agents.md`](./concepts/agents.md) | The 11 baseline agents + model hierarchy |
| Skills (concept) | [`concepts/skills.md`](./concepts/skills.md) | Auto-load, user-invocable, the 23-knowledge-skill catalog and 49 workflow selectors |
| Memory (concept) | [`concepts/memory.md`](./concepts/memory.md) | Compounding, confidence, decay, the session-handoff write path |
| Hooks (concept) | [`concepts/hooks.md`](./concepts/hooks.md) | Claude handler inventory, Codex adaptation and trust limits |
| Commands (reference) | [`reference/commands.md`](./commands.md) | Every slash command, alphabetical |
| System Map | [`reference/system-map.md`](./system-map.md) | Full inventory and wiring |
| Customization | [`reference/customization.md`](./customization.md) | Zone map for safe editing |
| Memory Flow | [`reference/memory-flow.md`](./memory-flow.md) | Visual companion to `concepts/memory.md` |
| Specialize Guide | [`guides/specialize.md`](./guides/specialize.md) | `/review:specialize` walkthrough |
| Personalize Guide | [`guides/personalize.md`](./guides/personalize.md) | `/review:personalize` walkthrough |
| Contributing Guide | [`guides/contributing.md`](./guides/contributing.md) | Add a new agent, command, or skill |
| Gate Lock Recovery | [`gate-lock-recovery.md`](./gate-lock-recovery.md) | Evidence and supported recovery for stale build/test locks |
| Learning Intake | [`guides/learning-intake.md`](./guides/learning-intake.md) | Project-owned intake identity, policy and authorized delivery |

## Not on this index

A few things live in `docs/` but are out of scope for adopters reading this index:

- The domain folders' planning docs (`product/`, `architecture/`, `design/`, `work/`) and `docs/work/todo/` — generated per-project by `/create:new-project`. These are your project's content, not the template's documentation.
- `docs/.output/handoffs/` — session continuity, written by `/end` and read by `/prime`.
- `docs/modules/`, `docs/.output/` (incl. `.output/findings/research/`) — working surfaces that each project fills as it runs.
- `docs/CLAUDE.md` — conventions for the docs folder structure itself; auto-loaded by Claude Code when it works inside `docs/`.

For the folder-layout conventions that govern all of the above, see the project's root `CLAUDE.md` (the auto-loaded project instructions) and [`./CLAUDE.md`](../../CLAUDE.md) (the docs-local conventions).
