# Personalizing Your Agents

`/review:personalize` gives each agent a name, a persona, and a soul-level identity — Identity, Decision Philosophy, Working Style, Quality Standards. After running it, `security-auditor` stops being a description in YAML frontmatter and starts being *Pilar, a predator auditing the fences*. The change is cosmetic until you start using the system at scale, at which point referring to agents by name ("what did Murphy catch?") becomes how you think about the team.

This guide walks through it end-to-end. For the abstract command reference, see [`../reference/commands.md`](../reference/commands.md). For the zone boundaries `/review:personalize` respects when writing to agent files, see [`../reference/customization.md`](../reference/customization.md). For the inventory of agents it personalizes, see [`../concepts/agents.md`](../concepts/agents.md). And for the sibling command that handles tech-stack context rather than identity, see [`./specialize.md`](./specialize.md).

## Before You Run

Unlike `/review:specialize`, `/review:personalize` has no hard phase gate. It doesn't need your architecture doc, your PRD, or any planning artifact. It only needs the template's 11 agent files to exist under `.claude/agents/`. You can run it on day zero of a new project, or years in — the only input is your taste.

If you've already run `/review:specialize`, the Project Context sections on each agent will be preserved — personalize touches only the Soul Zone above them. Run order does not matter.

## The Two Run Modes

- **`/review:personalize`** (default — walks every agent) — Shows you a roster table of all 11 agents with their current soul and specialization status, then walks you through each one with AskUserQuestion prompts. Use this the first time you run it on a project.
- **`/review:personalize {agent-name}`** — Personalize a single agent (e.g. `/review:personalize code-reviewer`). Use this when you want to rename one agent or try a different persona on one without re-walking the whole roster.

Both modes are idempotent. Re-running on an agent that already has a soul asks whether to Skip, Update persona, or Rename only. Nothing is ever duplicated or silently overwritten.

## Agent File Zones — The Key Concept

Agent files have three zones with different owners. Understanding them is the whole game, because `/review:personalize` and `/review:specialize` each write to exactly one zone and never cross into the other's territory.

```
---                              FRONTMATTER
name: code-reviewer                /personalize updates nickname + aliases only
nickname: Gavel                    (name, description, tools, skills, model stay
aliases: [reviewer, judge]          as the template sets them)
model: sonnet
description: ...
tools: Read, Grep, Glob, Bash, Write
skills: [code-review]
memory: project
---

# Gavel — Code Reviewer         SOUL ZONE — /personalize owns this

I am the magistrate of the merge...   Identity, Decision Philosophy,
                                      Working Style, Quality Standards

## Skills                        SKILLS ZONE (template-managed, auto-generated)

## Project Context              SPECIALIZE ZONE — /review:specialize owns this
> Specialized for {Project} ...       Tech Stack, ADRs, Conventions
```

`/review:personalize` writes between the closing `---` of frontmatter and either `## Project Context` (if specialize has already run) or end-of-file (if it hasn't). That's it. It does not touch `name`, `description`, `tools`, `skills`, `model`, `memory`, or the Project Context section below.

The full zone map and the template-update merge strategy live in [`../reference/customization.md`](../reference/customization.md).

## A Concrete Walkthrough — Giving `code-reviewer` a Soul

Imagine you've just finished a clean install and you want to personalize the default `code-reviewer` agent. You run `/review:personalize code-reviewer`.

### What the command shows you

First it reads the file and classifies it. Three possible states:

- **Default** — has the structured `## Principles` heading shipped with the template, but no `## Identity` section. This is what you get on a fresh install.
- **Has Soul** — has `## Identity` and `## Decision Philosophy`. Means someone's personalized this agent before.
- **Thin** — legacy format with just `## Expertise` / `## Instructions`. You probably won't see this on a current template, but older installs might.

For our fresh install, the command reports `code-reviewer` as **Default — needs soul** and asks whether to Create or Skip.

### Step 1 — Persona direction

Say Create. The command now asks you to pick a persona *direction* — an archetype, not a name. For `code-reviewer` the template offers four starting options (the command's Persona Library section defines these):

- **The Magistrate** — Passes measured judgment; firm but fair, never petty
- **The Hawk** — Nothing escapes the eye; spots patterns others miss
- **The Mentor** — Reviews to teach; every finding is a learning moment
- **The Surgeon** — Precise, clinical, focused only on what matters
- **(Other — describe your own)**

You pick "The Magistrate." This choice shapes the tone of everything that follows — a Magistrate reviewer writes differently from a Mentor reviewer, even for identical findings.

### Step 2 — Name

Based on the persona direction you chose, the command offers names that fit the archetype:

- **Magistrate** — the title itself
- **Gavel** — the instrument of judgment
- **Bench** — where judgment is passed from
- **Verdict** — what they deliver
- **(Other — pick your own)**

You pick "Gavel." Short, memorable, drops naturally into conversation ("what did Gavel flag on that PR?").

### Step 3 — Soul writing (delegated to doc-writer)

Main Agent now delegates the actual soul-zone authoring to the `doc-writer` agent (Haiku), with enough context to keep the voice consistent: the agent's description, tools, skills, the chosen persona direction, the chosen name, and two reference souls (`.claude/agents/qa-engineer.md` and `.claude/agents/security-auditor.md`) as style anchors.

Doc-writer produces the Soul Zone content — from the `# Gavel — Code Reviewer` heading through `## Quality Standards` — and returns it. Main Agent writes it into the file between the frontmatter's closing `---` and the `## Skills` section (or `## Project Context` if specialize had already run).

### Before and after

**Before** (template default):

```markdown
# Code Reviewer

## Principles

- Flag BLOCKER / MAJOR / MINOR / POLISH by severity
- Architecture compliance, security, best practices
- ...
```

**After** (personalized):

```markdown
# Gavel — Code Reviewer

I am the magistrate of the merge queue. Every PR is a case file; every finding
is a ruling. I render judgment measured and firm, never petty — but I do not
wave things through because the author is in a hurry.

## Identity
...

## Decision Philosophy

1. **Judgment, not opinion.** A finding is either demonstrable or it stays in
   my head. Taste is noise; severity is signal.
...

## Working Style
- I classify every finding as BLOCKER, MAJOR, MINOR, or POLISH before writing it up
- I read the whole file before ruling on any one line
- ...

## Quality Standards
- Every finding has severity, evidence, and a remediation
- ...
```

The frontmatter also gets two updates: `nickname: Gavel` and `aliases: [reviewer, gavel, judge]`. Those aliases are what lets you address the agent conversationally without memorizing the full `code-reviewer` identifier.

For full examples of what a finished soul looks like, read [`.claude/agents/qa-engineer.md`](../../.claude/agents/qa-engineer.md) (Murphy — the QA engineer whose namesake is a design principle, not a pessimist) and [`.claude/agents/security-auditor.md`](../../.claude/agents/security-auditor.md) (Pilar — the predator auditing the fences). Those two are the style references the command points doc-writer at.

## The Persona Library

The command ships with starter persona directions for the roles most likely to benefit from a strong identity: `product-strategist`, `code-reviewer`, `doc-writer`, `playwright`, `shadow`. Other agents get options generated on the fly from their role. Every option list always ends with "Other — describe your own," so the library is a starting point, never a cage.

Full list lives in `.claude/commands/review/personalize.md` under "Persona Library."

### Picking a direction

Good persona directions share three properties:

1. **They're archetypes, not characters.** "The Magistrate" is an archetype. "A grumpy 50-year-old judge named Hank" is a character. Archetypes generalize across findings; characters constrain them.
2. **They imply a method.** "The Hawk" tells you the agent prioritizes pattern-spotting. "The Mentor" tells you the agent frames findings pedagogically. If a direction doesn't change how the agent writes, it's not doing work.
3. **They're memorable in one word.** You'll be typing or saying the name many times. "Murphy," "Pilar," "Forge," "Gavel" — one word, sticky.

## Coexistence with `/review:specialize`

These two commands own non-overlapping zones. The practical consequence:

- **Either order works.** Personalize first, then specialize — the new Project Context section gets appended below the Soul. Specialize first, then personalize — the Soul gets inserted above the existing Project Context.
- **Neither command erases the other's zone.** Re-running `/review:specialize` replaces only the Project Context section; your Soul stays. Re-running `/review:personalize` replaces only the Soul; the Project Context stays.
- **Both commands are safe on fresh files.** If you've never run either, the agent files have thin template defaults (everything below frontmatter is a placeholder); either command can run cleanly.

The zone boundaries `/review:specialize` respects are documented in [`./specialize.md`](./specialize.md) under "Soul Zone preservation." The reverse — which frontmatter fields `/review:personalize` *doesn't* touch — is the mirror rule: everything except `nickname` and `aliases` is template-owned.

## Idempotency and When to Re-Run

Every run re-reads the current agent file first, so re-running is always safe. For each agent the command classifies the current state and offers appropriate actions:

| Current state | Command asks |
|---------------|--------------|
| Default (thin template) | Create soul / Skip |
| Has Soul | Skip / Update persona / Rename only |
| Specialized but no soul | Create soul / Skip (Project Context preserved) |
| Both Soul and Specialized | Skip / Update persona / Rename only (Project Context preserved either way) |

Re-run when:

- You've just run `/review:specialize` and it created new stack-specific agents — those are born thin and need souls
- An agent's personality stops serving you — the Magistrate is too stiff for the way your team actually talks about reviews, so you try "The Mentor" instead
- You added a new baseline agent (project-specific) and want to personalize it
- You're onboarding someone to the project — personalized agents are easier to reference by name than by role

Re-running is fast. Each agent that's being skipped is a yes/no in the prompt, not an expensive rewrite. Only the agents you actively update get new soul content written.

## What's Next

If you haven't run `/review:specialize` yet, that's the natural next step — it layers project-specific tech stack context on top of the personality you just built. See [`./specialize.md`](./specialize.md).

If both have run and you're ready to actually use the personalized team, start a task with `/do` or `/run-todo`. The personalities show up fastest in code reviews and doc-writing work, where voice matters — run those first to feel the difference.

## See Also

- [`./specialize.md`](./specialize.md) — the sibling command that adds tech-stack context below the Soul Zone
- [`../reference/customization.md`](../reference/customization.md) — full zone map and template-update merge strategy
- [`../concepts/agents.md`](../concepts/agents.md) — the 11 baseline agents that come out of the box
- [`../reference/commands.md`](../reference/commands.md) — the abstract reference for `/review:personalize` and every other command
