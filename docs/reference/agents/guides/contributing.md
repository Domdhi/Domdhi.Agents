# Contributing to the System

This guide is for adopters who want to extend the shared `.agents/` toolkit with a new agent, command, or skill. The template ships with 11 roles, 49 workflows, and 23 knowledge skills as of this writing — enough for most projects to get moving. But every project eventually needs something the template doesn't have: a domain-specific skill, a specialist agent for an unusual stack, a workflow command unique to your team. This guide walks through how to add one without breaking the three-tier architecture.

For a tour of what already exists, see [`../concepts/commands.md`](../concepts/commands.md), [`../concepts/agents.md`](../concepts/agents.md), and [`../concepts/skills.md`](../concepts/skills.md). For the inventory and wiring map, see [`../system-map.md`](../system-map.md). For the abstract command reference, see [`../commands.md`](../commands.md).

## The Three-Tier Refresher

Three kinds of authored files live under `.agents/` and each one has a specific job. Keeping the jobs separate is what makes the system work.

- **Workflows** (`.agents/skills/*/references/workflow.md`) — orchestration. A command is what the user types. It decides which gates run, which agents get dispatched, what gets validated, and what gets committed. Commands don't carry domain knowledge and they don't do implementation work themselves.
- **Agents** (`.agents/roles/*.md`) — workers with personality. A role supplies behavior for native delegation; Claude and Codex deliver it through their own adapters. It has a soul zone (Identity, Decision Philosophy, Working Style, Quality Standards) and auto-loads skills via frontmatter. Agents don't orchestrate and they don't own reference material.
- **Knowledge skills** (`.agents/skills/*/SKILL.md`) — domain knowledge. A skill is a Markdown file with a template, checklist, quality criteria, or reference material. Skills don't *do* anything on their own; they get loaded into the context of whatever agent or command already knows to use them.

The no-duplication rule follows from these jobs: if the same checklist appears in three different commands, it belongs in a skill. If two commands keep copy-pasting the same agent-style persona into dispatch prompts, it belongs in an agent. If you find yourself teaching a skill how to orchestrate, you wrote it at the wrong tier.

## Decision Gate — What Tier Am I Adding?

Before you run `/create:component`, decide what you're actually creating. This is the highest-leverage decision in contribution — most bad additions to the system are mis-tiered.

### Agent or Skill?

Ask two questions:

1. **Does this role require a distinct point of view?** An agent has beliefs. Pilar (the security auditor) thinks like an attacker first, defender second. Murphy (the QA engineer) treats Murphy's Law as a design principle. If what you're adding is knowledge that any competent agent could apply, it's not an agent — it's a skill.
2. **Should Claude auto-delegate to it?** Agents are discoverable via their `description` field. When the main agent sees a task matching an agent's description, it considers delegating. Knowledge skills do not get auto-delegated to; they get loaded into someone else's context. If you want the main agent to hand the whole task over, you want an agent. If you want existing agents to reach for a reference, you want a skill.

Both yes → agent. Either no → skill.

Classic test: "an agent that helps with documentation" is a skill. A system architect who believes every decision is a constraint imposed on the future — that's an agent.

### Command or Inline Behavior?

Ask three questions:

1. **Is this invoked by a user**, not triggered automatically by a hook or an event?
2. **Is it reusable across projects**, not tied to one specific codebase's file layout?
3. **Does it produce a tangible artifact or state change** — a committed file, a published report, a schema change — that needs human initiation?

All three yes → command. Any no → inline behavior in an agent prompt, a hook, or a sub-step of an existing command.

Classic test: "a command that runs tests" is not a command — `npm test` or the gate script already does that. "A command that runs tests, diagnoses failures with a targeted agent, screenshots the browser state, and files structured bug reports" — that's a command, because it orchestrates multiple steps around a human-initiated event.

## The Happy Path: `/create:component`

Once you know what you're adding, let the system scaffold it for you.

```
/create:component {type} {name} {description}
```

Where `{type}` is `agent`, `command`, or `skill`; `{name}` is a kebab-case identifier; and `{description}` is a natural-language sentence explaining what the component does and when to use it.

Examples:

```
/create:component agent data-engineer ETL pipeline design, data modeling, and migration strategy
/create:component skill postgres-patterns Use WHEN implementing Postgres-backed features — covers indexes, partial indexes, JSONB, and migration safety
/create:component command babysit-pr Watch an open PR for CI status, apply review feedback, and re-request review
```

The command reads the creator skill for the component type (`agent-creator`, `command-creator`, or `skill-authoring` + `skill-creator`) for the authoritative conventions, checks for name conflicts, asks a couple of targeted questions if your description leaves anything ambiguous, and writes the file in the right directory with correct frontmatter. It also does the wiring work — if your new skill is listed in an agent's skills list, the agent's frontmatter gets updated automatically.

After `/create:component` runs, you still need to:

- **Flesh out the body.** The scaffolding gives you correct structure and placeholder content. Replace the placeholders with real domain expertise.
- **Run `/review:check-templates`** to verify wiring (see Verification below).

You can also skip the command and write the file by hand. That's legitimate for experienced contributors — the convention rules live in the per-type creator skills (`.agents/skills/agent-creator/SKILL.md`, `.agents/skills/command-creator/SKILL.md`, and `.agents/skills/skill-authoring/SKILL.md`). But the command catches naming mistakes and wiring gaps that are easy to miss when hand-rolling.

## Where Files Go

```
.agents/
├── roles/{name}.md                    — shared role behavior
├── skills/{name}/SKILL.md             — knowledge skill or workflow selector
│   └── references/workflow.md          — workflow body, where applicable
└── adapters/
    ├── workflows.json                — native command mapping
    └── claude/workflow-metadata.json  — Claude command frontmatter
```

Command categories matter for invocation. A command at `.claude/commands/do.md` is invoked as `/do`. A command at `.claude/commands/create/component.md` is invoked as `/create:component`. A command at `.claude/commands/review/check-sync.md` is invoked as `/review:check-sync`. These paths are generated outputs. Author `.agents/skills/{native-skill-name}/references/workflow.md` and its selector, with native mapping in `.agents/adapters/workflows.json` and Claude frontmatter in `.agents/adapters/claude/workflow-metadata.json`. Namespaced commands use hyphenated skill names (e.g. `create-component`). Render with `node .claude/core/render-shared-agents.js`.

## Naming Conventions

One rule to remember, then a handful of specifics that follow from it: **kebab-case everywhere, singular nouns, and descriptive over clever.**

- **File names** — `data-engineer.md`, not `DataEngineer.md` or `data_engineer.md` or `de.md`.
- **Skill directories** — `postgres-patterns/`, matching the `name:` frontmatter field. The directory and the `name:` field must agree.
- **Agent `name:` field** — kebab-case identifier, matches filename. `name: data-engineer`.
- **Agent `nickname:` field** — a short, memorable proper noun. `nickname: Forge`. This is what you call the agent in conversation. Not kebab-case, not plural.
- **Agent `aliases:` field** — 2–5 short lowercase invocation keys. `aliases: [dev, developer, coder, builder, implement]`. Aliases are how you refer to the agent without remembering its full identifier; keep them short.
- **Command invocation namespace** — the command's directory determines its namespace. Build-loop commands live at the top level and are invoked without a namespace (`/do`, `/end`, `/prime`). Setup commands live under `create/` and are invoked with that namespace (`/create:project-brief`, `/create:component`). Review commands live under `review/` (`/review:code-review`, `/review:check-templates`).

## Frontmatter Rules

Each tier has a required frontmatter shape. The full field tables live in the per-type creator skills (`agent-creator`, `command-creator`, `skill-authoring`); this section calls out the fields that matter most for not shooting yourself in the foot.

### Agents

```yaml
---
name: {kebab-case}
nickname: {Short-Name}
aliases: [{alias1}, {alias2}, ...]
description: {What it does. When to use it.}
skills:
  - {skill-name}
---
```

Canonical roles do not contain runtime model/tool/memory fields. Workshop defaults belong in `.agents/adapters/{runtime}/shared-agents.json`; adopter overrides belong in native `.claude/shared-agents.json` or `.codex/shared-agents.json`. Claude uses a Sonnet floor, pinned Opus security-auditor and policy-driven escalation. Codex uses configured native models; do not pass Claude identifiers to it.

A new agent ships with **soul only** — no `## Project Context` section. That section is owned by `/review:specialize` and added per-project when the agent is deployed against a real architecture. See [`./specialize.md`](./specialize.md) and [`./personalize.md`](./personalize.md) for how the two zones work and why contribution stops at the soul.

### Commands

```yaml
---
description: {1 sentence — what the command does}
argument-hint: [{argument description}]
---
```

Every command needs an `argument-hint`, even commands that don't take arguments (use `[]` or describe the optional args). The hint is what Claude Code shows in autocomplete.

### Skills

```yaml
---
name: {kebab-case}
description: "Use WHEN {triggering conditions} — {optional one-line summary}"
metadata:
  version: 1.0.0
  author: {Your Name or Org}
  tags: [{tag1}, {tag2}]
user-invocable: false
allowed-tools: {tool list}
---
```

**The description field must start with `Use WHEN`.** This is not optional, and the reason is mechanical: Claude Code reads the description to decide whether to load the skill. Descriptions that summarize the workflow ("Dispatches subagent per task...") get followed as shortcuts instead of triggering a skill read. Descriptions that describe triggering conditions ("Use WHEN tests have race conditions...") force a full skill-body read. The `skill-authoring` skill has the detail at `.agents/skills/skill-authoring/SKILL.md` under "Claude Search Optimization (CSO)."

`user-invocable: false` is the default — it means the skill is used by agents or commands but doesn't appear in the `/skill-name` slash-command list. Set it to `true` only if you genuinely want users to invoke the skill directly (like `/simplify` or `/skill-authoring`).

## A Worked Example — Adding a `postgres-patterns` Skill

Your project uses PostgreSQL. You've noticed that every time `/do` touches a migration or a query-heavy feature, the main agent reinvents the same rules — avoid lock contention during index creation, prefer partial indexes over filtered queries, use JSONB operators with care. That knowledge belongs in a skill.

### Step 1 — Run the command

```
/create:component skill postgres-patterns Use WHEN implementing Postgres-backed features, writing migrations, or tuning query performance — covers CONCURRENTLY indexes, partial indexes, JSONB, and migration safety
```

The command creates `.agents/skills/postgres-patterns/SKILL.md` with correct frontmatter and a placeholder body. It also asks you which agent should auto-load this skill. You pick `general-purpose` because Forge is the one implementing migrations. The agent's `skills:` list gets updated to include `postgres-patterns`.

### Step 2 — Replace the placeholders

The scaffolded body will have headings like `## Quality Criteria` and `## References` with placeholder text. You fill those in with the actual rules you want Forge to follow:

```markdown
## Migration Safety

- Never add a NOT NULL column without a DEFAULT on a table >10M rows
  without a three-step migration: add nullable → backfill → add constraint
- Creating indexes on large tables MUST use CREATE INDEX CONCURRENTLY to
  avoid blocking writes. The migration runner must be told not to wrap
  in a transaction.

## Index Strategy

- Measure a query with EXPLAIN before adding an index.
- Document the query and workload an index is intended to support.
```

Domain knowledge only — no orchestration, no "first do X then do Y." That's command territory.

### Step 3 — Verify

```
/review:check-templates
```

This command reads every agent, command, skill, and hook; checks frontmatter; verifies that wiring references resolve. If the new skill has a syntax error, a missing field, or is unwired, the report calls it out. Fix whatever it flags.

### Step 4 — Use it

In Claude, next time Forge runs a migration story, it auto-loads `postgres-patterns/SKILL.md` before its first turn. In Codex, use native role dispatch when supported; otherwise the worker reads the canonical role and declared skills and reports that distinction.

Adding an agent or a command follows the same four-step shape — scaffold with `/create:component`, replace placeholders, verify with `/review:check-templates`, use it. The details differ (agents need a soul zone; commands need gates and a report section) but the loop is identical.

## Anti-Patterns to Avoid

- **Generic agent personality.** "I am a helpful assistant focused on X." Every agent needs a distinct worldview. Read Murphy's soul at `.agents/roles/qa-engineer.md` or Pilar's at `.agents/roles/security-auditor.md` as calibration — if your new agent doesn't read like someone with opinions, rewrite it.
- **Overlapping agents.** If your new agent's description could match an existing agent's description, you don't need a new agent — extend the existing one with a skill. Check the 11-agent inventory in [`../concepts/agents.md`](../concepts/agents.md) before adding.
- **Orchestration logic in knowledge skills.** Knowledge skills carry reference material; workflow skills select authored procedures. "Step 1: Run the linter. Step 2: If errors, dispatch the fix-agent..." belongs in a command, not a skill.
- **Domain knowledge in commands.** Commands orchestrate; they do not own reference material. If your command's workflow has a 40-line checklist of rules, extract the checklist into a skill and have the command reference it by name.
- **Unwired skills.** Every new skill must be loaded by at least one agent, referenced by at least one command, or have `user-invocable: true`. A skill that nothing reads is dead weight — `/review:check-templates` will flag it.
- **Skill descriptions that summarize workflows.** `description: "Dispatches subagent per task"` — Claude will follow that sentence instead of reading the skill. Use `description: "Use WHEN ..."` with triggering conditions only.
- **Shipping `## Project Context` on a new agent.** That section is owned by `/review:specialize` and added per-project. A new agent in the template has only the Soul Zone.

## Verification — `/review:check-templates`

Every contribution ends with this command.

```
/review:check-templates
```

It audits canonical/native toolkit wiring: orphaned agents (no command dispatches to them), unused skills (no agent loads them, no command references them), missing hooks referenced in settings.json, frontmatter drift, broken wiring. Anything your new component touched that isn't quite right will show up in the report at `docs/.output/findings/reviews/{date}-check-templates.md`.

If the report is clean, commit. If it's not, fix what it flagged and re-run. Do not ship contributions that the template audit flags — other adopters inherit your additions, and drift compounds.

## Release Cadence

The private workshop repository is where shared roles, skills, workflows and helpers are authored. The public Domdhi.Agents distribution uses the explicit allowlist in `tools/publish-manifest.json` and tracked-file selection in `tools/publish.js`. Working state, local settings and project-owned configuration never ship; publisher tests and toolkit tests remain workshop verification, while adopter gates remain application-only.

Domdhi.Agents maintainers cut releases on natural milestones — when a meaningful batch of agent/skill/command work has landed, been reviewed and passed the workshop checks — not on a fixed schedule. The canonical version lives in `.agents/config/version.json` and is rendered to `.claude/version.json`; each adopter records the release it installed. Merged contributions reach projects at the next pinned release.

**To propose a change:** open a pull request against the Domdhi.Agents repository through the repository’s review process; the maintainers own review and release. Keep the change focused on toolkit-level value that other projects benefit from; project-specific customizations stay in your own repository. See `./specialize.md` for the line between template additions and project specialization.

## What's Next

- **New baseline agent?** Run [`/review:personalize`](./personalize.md) on it to give it a name and a soul that matches the project's voice.
- **New skill wired to an existing baseline agent?** Next `/do` will pick it up automatically — auto-load via frontmatter is how skills reach agents.
- **New command?** Test it on a representative task. Commands benefit from one or two dry-runs before they become muscle memory.
- **Contributing back to the toolkit?** If the component is generic enough that other projects would benefit, propose it to the Domdhi.Agents maintainers with the new file and a short rationale.

## See Also

- [`../concepts/commands.md`](../concepts/commands.md) — the 49 workflows and their native invocation routes
- [`../concepts/agents.md`](../concepts/agents.md) — the 11 baseline agents, model hierarchy, dispatch mechanics
- [`../concepts/skills.md`](../concepts/skills.md) — the 23 skills and the three consumption paths
- [`../system-map.md`](../system-map.md) — full inventory and wiring map
- [`../commands.md`](../commands.md) — abstract reference for every command, including `/create:component` and `/review:check-templates`
- [`./specialize.md`](./specialize.md) — layering tech-stack context on top of baseline agents
- [`./personalize.md`](./personalize.md) — giving agents names and soul-level identity

For the independent nested public mirror, tracked-source selection and local prepared-version release procedure, see [v6 migration](../migration-v6.md#local-release-preparation-and-later-distribution).
