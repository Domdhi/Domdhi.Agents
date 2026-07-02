# Domdhi.Agents Documentation

This is the docs index. Everything under `docs/` is organized around one idea: the path through the docs depends on your role. A newcomer trying to understand what this *is* reads different things than an adopter using it day to day, who reads different things than a contributor extending it. Pick your lane below.

If you just want to try it, skip everything on this page and open [`getting-started.md`](./reference/agents/getting-started.md) — it walks you from an empty directory to a specialized, implementation-ready project in about thirty minutes.

## For Newcomers — Understand What This Is

Start here if you've just landed and want the shape of the system before committing to adopt it.

1. [`getting-started.md`](./reference/agents/getting-started.md) — Clone to implementation-ready in 30 minutes, via `/create:new-project`. The one-page walkthrough.
2. [`concepts/commands.md`](./reference/agents/concepts/commands.md) — The orchestration tier. What slash commands are, how they decide what to gate, what to delegate, and what to commit.
3. [`concepts/agents.md`](./reference/agents/concepts/agents.md) — The 11 specialists. Model hierarchy — Opus plans and verifies, Sonnet implements, Haiku documents.
4. [`concepts/skills.md`](./reference/agents/concepts/skills.md) — Domain knowledge that auto-loads via agent frontmatter. User-invocable (`/skill-name`) vs. implicit (agents reach for them).

Four docs. Read in order. By the end you know what the system is and what role each tier plays.

## For Adopters — Using It Day to Day

Read these once you've initialized a project and want to use it well.

1. [`reference/commands.md`](./reference/agents/commands.md) — Canonical reference for every slash command. Alphabetical; skimmable.
2. [`guides/specialize.md`](./reference/agents/guides/specialize.md) — `/review:specialize --fix` walkthrough. Appends project context to the baseline agents and generates stack-specific agents from your architecture doc.
3. [`guides/personalize.md`](./reference/agents/guides/personalize.md) — `/review:personalize` walkthrough. Gives agents names, personas, and soul-level identities. Cosmetic until you work at scale — then it becomes how you think about the team.
4. [`concepts/memory.md`](./reference/agents/concepts/memory.md) — How memories compound across sessions. Active-work-day decay (idle projects don't rot), confidence tiers, the session-handoff write path.
5. [`concepts/hooks.md`](./reference/agents/concepts/hooks.md) — The 12 automated hooks. Secret scanning, guardrails, session memory capture — what happens without you asking.

## For Contributors — Extending the System

Read these when you want to add an agent, a command, or a skill — or when you need to see exactly how the pieces wire together.

1. [`guides/contributing.md`](./reference/agents/guides/contributing.md) — Decision gate for what you're actually adding (agent vs. skill vs. command), then `/create:component` to scaffold it without breaking the three-tier architecture.
2. [`reference/system-map.md`](./reference/agents/system-map.md) — Full inventory: agents × skills × commands × hooks. The wiring map.
3. [`reference/customization.md`](./reference/agents/customization.md) — Zone map. Which sections of agent files are yours to edit vs. template-managed. Essential before any `/review:specialize` or `/review:personalize` edits.
4. [`reference/memory-flow.md`](./reference/agents/memory-flow.md) — Mermaid diagram of memory writes, reads, and maintenance. Companion to `concepts/memory.md`.

## All Docs — Flat Reference

If you came here from a search engine or a link and just need to find a specific doc:

| Doc | Path | What's in it |
|-----|------|--------------|
| Getting Started | [`getting-started.md`](./reference/agents/getting-started.md) | First 30 minutes — clone, `/create:new-project`, specialize, commit |
| Commands (concept) | [`concepts/commands.md`](./reference/agents/concepts/commands.md) | Orchestration tier explainer |
| Agents (concept) | [`concepts/agents.md`](./reference/agents/concepts/agents.md) | The 11 baseline agents + model hierarchy |
| Skills (concept) | [`concepts/skills.md`](./reference/agents/concepts/skills.md) | Auto-load, user-invocable, the 26-skill catalog |
| Memory (concept) | [`concepts/memory.md`](./reference/agents/concepts/memory.md) | Compounding, confidence, decay, the session-handoff write path |
| Hooks (concept) | [`concepts/hooks.md`](./reference/agents/concepts/hooks.md) | The 12 hooks and their trigger taxonomy |
| Commands (reference) | [`reference/commands.md`](./reference/agents/commands.md) | Every slash command, alphabetical |
| System Map | [`reference/system-map.md`](./reference/agents/system-map.md) | Full inventory and wiring |
| Customization | [`reference/customization.md`](./reference/agents/customization.md) | Zone map for safe editing |
| Memory Flow | [`reference/memory-flow.md`](./reference/agents/memory-flow.md) | Visual companion to `concepts/memory.md` |
| Specialize Guide | [`guides/specialize.md`](./reference/agents/guides/specialize.md) | `/review:specialize` walkthrough |
| Personalize Guide | [`guides/personalize.md`](./reference/agents/guides/personalize.md) | `/review:personalize` walkthrough |
| Contributing Guide | [`guides/contributing.md`](./reference/agents/guides/contributing.md) | Add a new agent, command, or skill |

## Not on this index

A few things live in `docs/` but are out of scope for adopters reading this index:

- The domain folders' planning docs (`product/`, `architecture/`, `design/`, `work/`) and `docs/work/todo/` — generated per-project by `/create:new-project`. These are your project's content, not the template's documentation.
- `docs/.output/handoffs/` — session continuity, written by `/end` and read by `/prime`.
- `docs/modules/`, `docs/.output/` (incl. `.output/findings/research/`) — working surfaces that each project fills as it runs.
- `docs/CLAUDE.md` — conventions for the docs folder structure itself; auto-loaded by Claude Code when it works inside `docs/`.

For the folder-layout conventions that govern all of the above, see [`../CLAUDE.md`](../CLAUDE.md) at the repo root (the auto-loaded project instructions) and [`./CLAUDE.md`](./CLAUDE.md) (the docs-local conventions).
