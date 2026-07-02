# Agents

An agent in this system is a subagent with a specific job — defined by its prompt, model, and skill set — that a command or the main agent can dispatch. There are 11 of them. Each has a nickname, a personality, and a narrow mandate. Most of the time the main agent does the work directly; agents get dispatched only when the job is large enough to justify the overhead or specific enough to benefit from the agent's expertise.

The agents are not redundant with each other. `general-purpose` (Forge) implements code. `architect` (Mason) designs systems. `qa-engineer` writes tests. These are distinct specializations, and calling the wrong one wastes context or produces off-target output. This doc gives you the inventory, the selection rules, and the reasoning behind the three-tier model hierarchy.

## The 11 agents

| Agent | Model | Role | Auto-loaded skills |
|-------|-------|------|--------------------|
| `product-strategist` | inherit | Brainstorming, research, briefs, PRDs | project-planning |
| `architect` | inherit | System design, ADRs, tech stack | architecture |
| `ux-designer` | inherit | UX specs, wireframes, themes | ux-design, brand-guidelines, tailwind-css-patterns, design-taste-frontend, redesign-existing-projects |
| `project-planner` | inherit | Epics, stories, backlog | project-planning |
| `general-purpose` | sonnet | Code implementation | full-output-enforcement, systematic-debugging, verification-before-completion, finishing-a-development-branch, using-git-worktrees |
| `code-reviewer` | sonnet | Code quality review (read-only) | code-review |
| `security-auditor` | sonnet | Security review (write scope limited to review artifacts) | code-review |
| `qa-engineer` | sonnet | Test strategy and test generation | qa-engineer |
| `doc-writer` | haiku | Documentation and changelogs | project-planning, documentation |
| `playwright` | haiku | Browser testing and automation | playwright-cli |
| `shadow` | sonnet | Voice-matched ghostwriting and articles | ghostwriting |

Each agent file lives at `.claude/agents/{name}.md` and holds its frontmatter (model, tools, skills list, nickname, aliases), persona, and decision philosophy. `/review:personalize` gives agents their names and personalities. The canonical ID in the table above is always the filename, not the nickname — commands reference agents by ID.

Commands also dispatch a 12th "agent" type that isn't in `.claude/agents/`: `Explore` — Claude Code's built-in, read-only codebase research agent. It's a native type, not a custom file. `/prime`, `/research`, and similar broad-search commands use it.

`/review:specialize` can add more stack-specific agents (e.g., `angular-expert`, `dotnet-backend-patterns`) derived from the project's architecture document, layered on top of the 11 base agents.

## Model tiers

The agents span three tiers, and the tier is deliberate:

- **Opus plans and verifies.** The big model owns the TaskList, reviews work, and makes hard decisions. Planning agents — `product-strategist`, `architect`, `ux-designer`, `project-planner` — are marked `inherit` so they stay on Opus when a command running Opus dispatches them. "Inherit" means *whatever the caller is using*, not a fallback — planning should run at least as strong as the main loop invoking it.
- **Sonnet implements.** Code work is Sonnet: `general-purpose`, `code-reviewer`, `security-auditor`, `qa-engineer`, `shadow`. Sonnet is fast enough for real implementation throughput and strong enough for real code review. It is not a "cheap" tier — it's the implementation tier.
- **Haiku documents.** Mechanical, well-specified work where speed and cost dominate over model reasoning: `doc-writer`, `playwright`.

Resolution order when a dispatch happens: `env var > call-time param > frontmatter > inherit`. You can override a frontmatter `sonnet` to Haiku on the command line if the task is trivial. You can pin Opus with an env var for an entire session. Frontmatter is the sane default, not a hard contract.

## Auto-loaded skills

Every agent declares a `skills:` list in its frontmatter. When that agent is dispatched, Claude Code loads those skill files into its context automatically — commands don't tell agents to "read the skill file first." That duplication is the single biggest anti-pattern in an untuned template.

Example: `qa-engineer` auto-loads the `qa-engineer` skill, which carries the test patterns, naming conventions, and coverage checklist. When `/do` dispatches `qa-engineer` to write tests, the skill content is already there. The command's prompt only passes the acceptance criteria and file paths — not the test framework's entire idiom.

If you write a new command that dispatches an agent, trust the agent's skills. Don't re-type the skill's content into the command prompt. That's why the three-tier architecture has zero duplication between layers.

See [`./skills.md`](./skills.md) for the skill catalog and the auto-load mechanism in detail.

## When to call which

Most tasks don't need an agent — the main agent handles them directly. Dispatch when:

- **The task spans many files or exceeds ~500 new LOC** → `general-purpose` (Forge). Delegation overhead pays off at that size; below it, main-agent-direct is faster and loses nothing in translation.
- **You need an independent second opinion on code quality** → `code-reviewer`. Read-only by design — produces review artifacts at `docs/.output/findings/reviews/`, never modifies source.
- **Pre-merge security review** → `security-auditor`. Writes audit reports to `docs/.output/findings/reviews/`. Scope-limited write: cannot edit source files.
- **A story has acceptance criteria and no tests** → `qa-engineer`. Writes tests from AC *before* implementation — the TDD gate in `/do` Step 5.
- **End-of-epic docs, changelogs, mechanical TODO updates** → `doc-writer`. Haiku is fine for template-driven output.
- **Browser testing, screenshot-driven verification** → `playwright`. Haiku is fine — DOM checks don't need Opus reasoning.
- **Strategic planning, brainstorming, requirements work** → `product-strategist` for ideation and PRDs, `architect` (Mason) for tech stack and ADRs, `ux-designer` for UX specs, `project-planner` for epic breakdown.
- **Voice-matched blog post or long-form thought leadership** → `shadow`. Only when you want the author's fingerprint; don't dispatch for standard project docs.

If the task doesn't match any of these, the main agent does it directly. Dispatching adds context-passing overhead — don't pay it for work you can do inline.

## The Shadow exception

`shadow` deliberately breaks the standard agent file shape: it omits the `## Skills` section and the role-suffix on its main heading (`# Shadow`, not `# Shadow — Ghostwriter`). This is intentional — Shadow's ghostwriting persona *is* its convention, and adding structural scaffolding would fight the voice.

`/review:check-templates` treats Shadow as conforming. If you fork this template and add a new agent, follow the 10-agent shape (all agents except Shadow) — not Shadow's shape.

---

See also: [`./skills.md`](./skills.md) for the skill catalog, [`./commands.md`](./commands.md) for how commands dispatch agents, [`../reference/system-map.md`](../reference/system-map.md) for the full system inventory.
