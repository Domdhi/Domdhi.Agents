---
name: agent-creator
description: "Use WHEN creating a new subagent in .agents/roles/ — provides this toolkit's agent template, frontmatter contract, model-tier selection, persona/soul conventions, and the agent-vs-skill decision rule. Triggers: create agent, new agent, subagent, agent frontmatter, agent persona, agent model"
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [meta, system, agent, template, persona]
user-invocable: false
allowed-tools: Read Write Edit Grep Glob
---

# Agent Creator

Template, field rules, and quality criteria for creating a new agent (`.agents/roles/{name}.md`) that follows this toolkit's conventions. An agent owns **personality and working style** and auto-loads skills via frontmatter — it never duplicates command orchestration logic. See the three-tier architecture + "no duplication between layers" rule in CLAUDE.md; for commands use `command-creator`, for skills use `skill-creator` + `skill-authoring`.

## Agent Template

### Frontmatter (required fields, in this order)

```yaml
---
name: {kebab-case-name}
nickname: {short-name}
aliases: [{alias1}, {alias2}, {alias3}]
description: {1-2 sentences. What it does. When to use it.}
skills:
  - {skill-name}
---
```

### Field Rules

| Field | Required | Convention |
|-------|----------|------------|
| `name` | Yes | kebab-case, matches filename without `.md` |
| `nickname` | Yes | Short name used in `# {Nickname} — {Role Title}` heading |
| `aliases` | Yes | Inline YAML array `[...]`, 2-5 aliases for invocation |
| `description` | Yes | Concise, no quotes needed. Format: "{What it does}. Use for {when to use it}." |
| `skills` | Yes | YAML list of skill names, or `[]` if none |

Runtime fields belong in adapters, never canonical role frontmatter. Add a `tier` under `roles[name]` in each `.agents/adapters/{runtime}/shared-agents.json`, applying the tier selection guide below. Each adapter's `model-tiers.json` supplies its model values. Add Claude tools, memory and permissions in its adapter; project-specific overrides belong in `.claude/shared-agents.json`. Add supported Codex overrides (`model`, `model_reasoning_effort`, `sandbox_mode`) in `.codex/shared-agents.json` only when needed. Empty Codex tiers omit the model parameter. Never put Claude model identifiers into Codex settings. Run `node .claude/core/render-shared-agents.js` after canonical changes.

### Body Structure

```markdown
# {Nickname} — {Role Title}

{2-3 sentences: core identity and what makes this agent distinct from others.}

## Identity

{2-3 paragraphs: how this agent thinks, what it prioritizes, what it's skeptical of.
Should read like a person describing their professional worldview.}

## Decision Philosophy

{3-5 numbered principles (max 5). Each principle is bold + explanation.
Principles are first-person beliefs, not duties — convictions the agent holds,
not job responsibilities assigned to it.}

## Working Style

{6-8 bullet points. Concrete behaviors: what the agent does first, how it structures work,
what tools it reaches for, what it produces.}

## Quality Standards

{5-7 bullet points. Observable quality criteria for the agent's output.
Must include anti-sycophancy rule: "No hedging — never say 'that's an interesting approach'..."}
```

### Calibration

Before creating a new agent, read `.agents/roles/architect.md` as a format reference — the prose style, section structure, and principle density set the bar. For complex domains, spawn Task sub-agents to read source material before synthesizing the agent's identity — don't rely on recall for domain-specific standards.

### Thin-Default Shipping

A new agent ships with **soul only** — enough personality to be useful without coupling to any specific project:
- `/personalize` adds deeper personality (optional, per-project)
- `/specialize` adds project context (optional, per-project)

Write the thin default and stop. Don't over-engineer the identity for hypothetical projects.

### Model Selection Guide

The policy is **`standard` by default, `deep` for higher-stakes dispatches, and `audit` for security review** (see the Model Policy in `.agents/startup-reference.md`). Pick the default tier, then decide whether the agent is *dual-use* (needs a higher-stakes route).

| Role Type | Tier | Dual-use? (add `## Model Routing`) |
|-----------|-------|-----------|
| Planning, strategy, research, design | `standard` | **Yes** — select `deep` for new ADRs / strategic briefs / greenfield design from scratch |
| Code implementation | `standard` | **Yes** — select `deep` for multi-component refactors / data-integrity / migration logic |
| Code review | `standard` | **Yes** — select `deep` for HIGH-risk-tier paths / novel patterns |
| Testing, browser automation, documentation, ghostwriting | `standard` | No — keep the default tier |
| Security audit | `audit` 🔒 | No — retain the audit tier; never supply a cheaper override |

**Dual-use agents** carry a `## Model Routing` block (after `## Skills`, before `## Memory Inbox Protocol`) listing `deep` versus `standard` criteria; the dispatching **command** enforces it by selecting `{{model-arg:deep}}` for higher-stakes work or omitting `model` to retain native role settings. The security role uses `{{model-arg:audit}}`. Do not dispatch the `fast` tier until its bounded evaluation passes: the recorded 2026-06-02 Haiku 4.5 evidence showed fabricated results. An empty Codex tier means omit the argument and use the configured session model; it does not promise a distinct model for each tier.

### Decision Gate: Agent or Skill?

Before creating an agent, apply the **agents-vs-skills decision rule**:
- Does this role require a **distinct point of view** AND should Claude auto-delegate to it? → Agent
- Is it **knowledge or methodology** that multiple agents could use? → Skill

An agent that "helps with documentation" is a skill. A system architect who believes every decision is a constraint imposed on the future — that's an agent.

**Existing specialty overlapping ~100% with general-purpose + skills? Retire it, don't keep both.** When a specialty agent (e.g. a stack-specific `{framework}-specialist` agent) has no distinct point of view beyond the domain skills a properly-skilled `general-purpose` agent already loads, fold its knowledge into skills and retire the agent. Skills use progressive disclosure — metadata loads at startup, body loads on-demand by trigger — so a skill referenced by 3 agents isn't loaded 3x. This also closes a reviewer/implementer drift gap: `code-reviewer` and `qa-engineer` loading the same stack skills as the implementer means all three reason from the same domain knowledge. Keep a specialty agent only when it earns a genuinely distinct decision philosophy the Obvious Test above would keep — not just a different tech-stack label.

### The Obvious Test for Principles

Every principle in Decision Philosophy must pass the **Obvious Test**: "Would this be obvious to anyone in this role?" If yes, cut it.
- "Write clean code" → obvious to any developer. **Cut.**
- "Every commit is documentation for the developer who hasn't been hired yet" → not obvious. **Keep.**

If a principle applies equally to every agent in the same role, it adds no value.

### First Principle Pattern

The first principle should always activate expert domain knowledge:
```
1. **Channel expert [domain] knowledge: draw upon [specific frameworks, mental models, patterns].**
```
This primes the agent with the right lens before it starts working.

### Two-Zone Rule

Agent files have two zones with clear ownership:
1. **Soul Zone** (Identity, Decision Philosophy, Working Style, Quality Standards) — written at creation, preserved on template update
2. **Specialize Zone** (`## Project Context`) — written by `/specialize` only, never included at creation time

A new agent ships **without** `## Project Context`. That section gets added when deployed to a real project.

### Anti-Patterns

- Generic personality ("I am a helpful assistant...") — every agent must have a distinct perspective
- Overlapping with existing agents — check the agent inventory first
- Tools that don't match the role — review agents (code-reviewer, security-auditor) get `Write` for review artifacts only; do NOT include `Edit` (the Claude native tools list is a whitelist — omitting a tool already disallows it); pure inspectors (e.g., `Explore`) get neither. Match tools to the agent's actual write surface, not its label.
- Missing anti-sycophancy rule in Quality Standards
- Principles that fail the Obvious Test — cut anything that's just a job description
- Including `## Project Context` — that's for `/specialize`, not creation

## Wiring Checklist (New Agent)

After creating the agent, verify the wiring:
- [ ] Canonical file at `.agents/roles/{name}.md`, with rendered `.claude/agents/{name}.md` and `.codex/agents/{name}.toml`
- [ ] Frontmatter has all required fields in correct order
- [ ] Skills listed in frontmatter resolve in canonical `.agents/skills/` or legacy `.claude/skills/`
- [ ] No tool/role overlap with existing agents
- [ ] At least one command delegates to it, OR it's for direct invocation

## Related Skills

- **`command-creator`** — the analog for creating slash commands
- **`skill-creator`** + **`skill-authoring`** — for creating the skills an agent loads
- **`/review:personalize`** / **`/review:specialize`** — add personality + project context post-creation
