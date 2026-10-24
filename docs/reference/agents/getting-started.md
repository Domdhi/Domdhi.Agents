# Getting Started

This guide walks you from an application checkout with a pinned Domdhi.Agents release installed to a specialized, implementation-ready project through the planning workflow. You end with filled planning docs (brief, PRD, architecture, backlog), canonical `.agents/` roles/skills with native Claude/Codex delivery, and a first story ready to hand to `/do`.

The path is one command deep: `/create:new-project`. Everything else in this guide is what that command asks you and what it produces. For a wider tour of the system it builds on, see [`concepts/commands.md`](concepts/commands.md), [`concepts/agents.md`](concepts/agents.md), and [`concepts/skills.md`](concepts/skills.md). For adding your own commands or agents after you're moving, see [`guides/contributing.md`](guides/contributing.md).

## The 30-Minute Spine

At a glance, so you can skim and skip:

1. **Install a pinned Domdhi.Agents release** (a few min) — the installer adds the toolkit to your application checkout
2. **Run `/create:new-project`** (25 min)
   - Three-round interview captures the elevator pitch, stack, and constraints (~3 min)
   - Planning pipeline chains `/create:project-brief` → `/create:project-requirements` → `/create:project-architecture` → `/create:project-epics` (~15 min)
   - `/review:specialize --fix` customizes the agents and memory for your stack (~5 min)
   - `product/context.md` is generated; each subcommand commits its output and the orchestrator records the wrap-up
3. **Look around** (4 min) — read the filled brief, confirm the backlog is sensible, decide whether to personalize the agents now or later

If you're in a hurry, the only prerequisite for running the command is a completed installation. Everything else is interactive.

## Before You Start

Two assumptions this guide makes:

- **You have Claude Code installed and working.** If `claude` doesn't launch in your terminal, start with the [Claude Code install docs](https://docs.anthropic.com/claude-code) and come back here.
- **You have an application checkout with a pinned Domdhi.Agents release installed.** For a new application, generate it with the selected stack’s starter first (Step 1 covers the install). Running `/create:new-project` inside an existing project with filled docs is explicitly blocked — `/create:new-project` detects filled planning docs and refuses unless you pass `--yolo`. Start clean.

Everything else — the docs tree, the initial commit, the specialization — is handled for you.

## Step 1 — Install a Pinned Domdhi.Agents Release

Domdhi.Agents is installed into an application checkout; it is not cloned as a project template, and its own repository history is never repurposed as your project. For a new application, generate it with the selected stack’s starter first, then install a pinned Domdhi.Agents release into that checkout:

```bash
node .claude/core/install.js "<path to your application>" --dry-run
```

Run it from the pinned release’s checkout, review the preview, then repeat without `--dry-run`. The installer validates source assets, target paths and project update configuration before mutation. Ordinary updates later use the updater described in [`customization.md`](customization.md).

Launch Claude Code from the project root:

```bash
claude
```

## Step 2 — Run `/create:new-project`

Inside the Claude Code session:

```
/create:new-project
```

This is the command that does all the work. It's safe to re-run on a partially-initialized project — the scaffold step skips existing files, and every sub-command has its own hard gate that prevents overwriting filled docs. Below is what happens in order.

### The Interview

The command opens with three short rounds of questions, asked through Claude Code's interactive prompt. Keep answers honest and specific — every downstream document reads them as source material.

Throughout this walkthrough we'll use a running example: **Lane**, a small CLI task tracker for solo developers. Here's what the interview looks like with Lane's answers filled in.

**Round 1 — The Elevator Pitch**
- *What are you building?* → "A small personal task tracker for solo developers — daily queue in flat files, full-text search across it, no-friction sync across machines."
- *Who is it for?* → "Solo devs and indie hackers who find Jira overkill and a plain text file too unstructured."
- *Project name?* → "Lane"

**Round 2 — Tech & Scope**
- *Tech stack?* → "Node / TypeScript, SQLite for storage. No framework — I want it boring."
- *Scale?* → "Medium — multiple features: storage, search, import, sync."
- *Has a UI?* → "No. CLI only to start; a web UI is maybe Phase 2."

**Round 3 — Constraints**
- *Hard constraints?* → "Has to run fully offline. No cloud sync in v1."
- *Deployment target?* → "Local install via npm."

Before any sub-command runs, the command writes these answers to `docs/.output/.state/work/{YYYY-MM-DD}/new-project-interview.md`. That persistence is deliberate — if your session dies mid-pipeline, the interview is preserved and the re-run skips the questions.

### Phase Routing — Why You Get the Path You Get

Based on the answers, `/create:new-project` classifies the project into one of three tiers. The tier decides which planning commands run.

| Tier | Signal | Pipeline |
|------|--------|----------|
| **Simple** | Small tool with clear scope | `/create:project-requirements` (minimal) → `/create:project-architecture` → `/create:project-epics` |
| **Medium** | App with multiple features | `/create:project-brief` → `/create:project-requirements` → `/create:project-architecture` → `/create:project-epics` |
| **Complex** | Enterprise, regulated, or many integrations | `/brainstorm` → `/create:project-brief` → `/create:project-requirements` → `/create:project-design` → `/create:project-architecture` → `/create:project-epics` |

If Round 2 says **Has UI: yes**, `/create:project-design` is inserted after the PRD regardless of tier — the UX suite (spec, wireframes, light and dark themes, a mock layout HTML) is design-tier-independent.

Lane lands on **medium** and **no UI**, so the pipeline is four commands: brief, PRD, architecture, epics. No brainstorm, no design suite. The command writes the derived tier and pipeline back into the interview file so future sessions can see the routing decision.

### What the Pipeline Produces

Each sub-command runs in turn. They're chained — you don't re-invoke them manually. For Lane, here's what lands on disk by the end of the pipeline.

| Doc | Path | What's in it |
|-----|------|--------------|
| Brief | `docs/product/brief.md` | Strategic vision, target user, success criteria — the "why" |
| PRD | `docs/product/requirements.md` | Functional + non-functional requirements, MoSCoW priority — the "what" |
| Architecture | `docs/architecture/overview.md` | Tech stack, ADRs, system design — the "how" |
| Backlog | `docs/work/backlog.md` | Epics broken into user stories with acceptance criteria |

Each document may trigger a short follow-up interview of its own — `/create:project-requirements` often asks you to clarify functional-vs-non-functional distinctions, `/create:project-architecture` may ask you to commit to tech choices you left vague. Answer those the same way: honest and specific. The full list of setup commands lives in [`reference/commands.md`](commands.md).

After the backlog is written, `/review:check-readiness` runs automatically. It verifies the planning docs are complete, internally consistent, and cross-referenced. A PASS means the pipeline is coherent. A CONCERNS or FAIL means something needs a second pass — the command shows you what and asks whether to fix now or proceed with warnings.

### Specialization — Customizing the Agents for Your Stack

With planning docs in place, `/create:new-project` invokes `/review:specialize --fix`. This is where the generic template becomes your project's template.

Specialize reads `architecture/overview.md` and:

- Appends a `## Project Context` section to every default agent in `.agents/roles/*.md`, filled with your stack, ADRs, and conventions
- Creates new stack-specific agents where the architecture warrants — a `db-architect.md` if your stack leans on a non-trivial database layer, an `auth-builder.md` if auth is a named concern, and so on
- Seeds the memory system with ADRs and architectural patterns at confidence 0.9
- Audits the skill inventory for relevance and flags framework gaps for you to fill later

For Lane, specialize produces a `cli-designer.md` and a `sqlite-architect.md` agent, appends Node/TypeScript/SQLite context to the eleven baseline agents, and seeds six memory entries from the architecture's ADRs. The command shows you the full report before moving on. If it surfaces skill gaps you care about, note them — you can create them later via [`/create:component`](commands.md) or defer.

### Wrap-up — Project Context and the First Commit

Two small things close out the pipeline:

1. **`docs/product/context.md` is generated.** This is the quick-reference that `/prime` reads at the start of every future session. It lists every planning doc by path, summarizes the stack, and links the implementation commands (`/do`, `/run-todo`, `/review:*`). You rarely edit it by hand — `/review:update-docs` keeps it in sync as the codebase evolves.
2. **The orchestrator commits the wrap-up.** Planning subcommands commit their own outputs. The final initialization commit records project context and the workflow's selected continuity artifacts; ignored interview scratch remains working state rather than the only durable evidence.

The command prints a final report — tier, stack, documents created, specialization summary, readiness check, commit hash, and recommended next commands. Review those outputs before beginning implementation.

## Where You Land

Read the final report. Then take five minutes and look at:

- `docs/product/brief.md` — does the strategic framing match your intent? Small edits are fine; structural disagreements mean the interview was under-specified and you should re-run with `--yolo` or edit directly
- `docs/work/backlog.md` — is the epic breakdown sensible? Are the first two or three stories small enough to execute in a single `/do`?
- `.agents/roles/` — notice the new `## Project Context` sections and any new stack-specific agents

You now have a project that Claude Code understands on its own terms. The next session can open cold with `/prime` and resume from `product/context.md` without you re-explaining anything.

## What's Next

Three reasonable next moves, in rough order of most to least structural:

1. **`/do {first-story-id}`** — implement the first story from `backlog.md`. `/do` reads the story's acceptance criteria, plans the work, routes to the right agent (Main Agent direct if small, delegate to `general-purpose` if not), runs the build/test gate, and commits. This is the daily loop. See [`reference/commands.md`](commands.md) for the full command reference.
2. **`/review:personalize`** (optional) — give the eleven baseline agents names and soul-level identities. After running, `code-reviewer` stops being a description in YAML and starts being *Gavel, the magistrate of the merge queue*. Cosmetic until you work at scale, at which point referring to agents by name becomes how you think about the team. Walkthrough in [`guides/personalize.md`](guides/personalize.md).
3. **`/end`** — save session context to a per-run file under `docs/.output/handoffs/` before closing the terminal. The handoff is what `/prime` reads next session. No more "where was I."

If you want to extend the system itself — a custom command for your team's workflow, a skill for your domain — see [`guides/contributing.md`](guides/contributing.md). For a wider map of what already exists, [`reference/system-map.md`](system-map.md) inventories every agent, command, skill, and hook.

## See Also

- [`guides/specialize.md`](guides/specialize.md) — the `/review:specialize` command in depth, with a real-project example
- [`guides/personalize.md`](guides/personalize.md) — the `/review:personalize` walkthrough, with the zone map that keeps specialize and personalize non-overlapping
- [`guides/contributing.md`](guides/contributing.md) — adding a new agent, command, or skill without breaking the three-tier architecture
- [`concepts/memory.md`](concepts/memory.md) — how the memory system compounds across sessions
- [`reference/commands.md`](commands.md) — canonical reference for every slash command
- [`reference/system-map.md`](system-map.md) — full inventory of agents, commands, skills, and hooks

## Codex walkthrough equivalent

Use `.codex/core/install.js` from the pinned toolkit checkout, launch Codex in the application and invoke the discovered `$create-new-project` or `$onboard`. Namespaced Claude commands map to hyphenated skills, listed in [commands](commands.md). Read the installed body; start a fresh session if discovery is stale. Native trust, live model behavior and Windows execution remain separate verification, as described in [migration v6](migration-v6.md).
