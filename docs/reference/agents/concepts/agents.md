# Agents

An agent in this system is a subagent with a specific job — defined by its prompt, model, and skill set — that a command or the main agent can dispatch. There are 11 of them. Each has a nickname, a personality, and a narrow mandate. Most of the time the main agent does the work directly; agents get dispatched only when the job is large enough to justify the overhead or specific enough to benefit from the agent's expertise.

The agents are not redundant with each other. `general-purpose` (Forge) implements code. `architect` (Mason) designs systems. `qa-engineer` writes tests. These are distinct specializations, and calling the wrong one wastes context or produces off-target output. This doc gives you the inventory, the selection rules, and the reasoning behind the model hierarchy.

## The 11 agents

| Agent | Model | Role | Auto-loaded skills |
|-------|-------|------|--------------------|
| `product-strategist` | sonnet | Brainstorming, research, briefs, PRDs | project-planning, verification-before-completion |
| `architect` | sonnet | System design, ADRs, tech stack | architecture, verification-before-completion |
| `ux-designer` | sonnet | UX specs, wireframes, themes | ux-design, brand-guidelines, design-taste-frontend, redesign-existing-projects, verification-before-completion |
| `project-planner` | sonnet | Epics, stories, backlog | project-planning, verification-before-completion |
| `general-purpose` | sonnet | Code implementation | full-output-enforcement, systematic-debugging, verification-before-completion, finishing-a-development-branch, using-git-worktrees |
| `code-reviewer` | sonnet | Code quality review (read-only) | code-review |
| `security-auditor` | opus | Security review (write scope limited to review artifacts) | code-review |
| `qa-engineer` | sonnet | Test strategy and test generation | qa-engineer, verification-before-completion |
| `doc-writer` | sonnet | Documentation and changelogs | project-planning, documentation, verification-before-completion |
| `playwright` | sonnet | Browser testing and automation | playwright-cli, verification-before-completion |
| `shadow` | sonnet | Voice-matched ghostwriting and articles | ghostwriting, content-formats |

Each shared role lives at `.agents/roles/{name}.md` with identity, description, declared skills and persona. Runtime model/tool/memory fields live in adapters and project-native overrides; the renderer emits Claude Markdown and Codex TOML. The Model column above describes Claude floors only. `/review:personalize` writes canonical roles, then renders. IDs match role filenames, not nicknames.

Commands also dispatch a 12th "agent" type that isn't in `.claude/agents/`: `Explore` — Claude Code's built-in, read-only codebase research agent. It's a native type, not a custom file. `/prime`, `/research`, and similar broad-search commands use it.

`/review:specialize` can add more stack-specific agents (e.g., `angular-expert`, `dotnet-backend-patterns`) derived from the project's architecture document, layered on top of the 11 base agents.

## Claude model tiers

The Claude adapter (`.agents/adapters/claude/shared-agents.json`) sets each agent's generated floor, and the split is deliberate:

- **Opus plans and verifies.** The main session owns the TaskList, reviews work, and makes hard decisions.
- **Sonnet is the subagent floor.** Every agent except `security-auditor` runs on Sonnet. The dual-use agents — `product-strategist`, `architect`, `ux-designer`, `project-planner`, `general-purpose`, `code-reviewer` — carry a `## Model Routing` block, and the dispatching command escalates them to Opus per call for high-stakes work by passing `model: opus`. `qa-engineer`, `doc-writer`, `playwright` and `shadow` stay on Sonnet.
- **`security-auditor` is pinned Opus.** Commands never pass it a cheaper override.

Haiku is not used for agent work: the recorded evidence (2026-06-02, Haiku 4.5) is that it reported results it had not verified, and the rule stays in force until the bounded `fast`-tier eval passes. Resolution order when a dispatch happens: `call-time param > frontmatter > CLAUDE_CODE_SUBAGENT_MODEL env var > main-session model` (the order since Claude Code v2.1.251). A command escalates by passing `model: opus` and stays on the floor by omitting `model`; it never pins a model cheaper than an agent's floor. See the Agents section of [`.agents/startup-reference.md`](../../../../.agents/startup-reference.md) for the full model policy.

## Auto-loaded skills

Every shared role declares a `skills:` list in its frontmatter. When that role is dispatched in Claude, Claude Code loads those skill files into its context automatically — commands don't tell agents to "read the skill file first." That duplication is the single biggest anti-pattern in an untuned template.

Example: `qa-engineer` auto-loads the `qa-engineer` skill, which carries the test patterns, naming conventions, and coverage checklist. When `/do` dispatches `qa-engineer` to write tests, the skill content is already there. The command's prompt only passes the acceptance criteria and file paths — not the test framework's entire idiom.

If you write a new command that dispatches an agent, trust the agent's skills. Don't re-type the skill's content into the command prompt. That's why the three-tier architecture has zero duplication between layers.

See [`./skills.md`](./skills.md) for the skill catalog and the auto-load mechanism in detail.

## When to call which

Most tasks don't need an agent — the main agent handles them directly. Dispatch when:

- **The task spans many files or exceeds ~500 new LOC** → `general-purpose` (Forge). Delegation overhead pays off at that size; below it, main-agent-direct is faster and loses nothing in translation.
- **You need an independent second opinion on code quality** → `code-reviewer`. Read-only by design — produces review artifacts at `docs/.output/findings/reviews/`, never modifies source.
- **Pre-merge security review** → `security-auditor`. Writes audit reports to `docs/.output/findings/reviews/`. Scope-limited write: cannot edit source files.
- **A story has acceptance criteria and no tests** → `qa-engineer`. Writes tests from AC *before* implementation — the TDD gate in `/do` Step 5.
- **End-of-epic docs, changelogs, mechanical TODO updates** → `doc-writer`.
- **Browser testing, screenshot-driven verification** → `playwright`.
- **Strategic planning, brainstorming, requirements work** → `product-strategist` for ideation and PRDs, `architect` (Mason) for tech stack and ADRs, `ux-designer` for UX specs, `project-planner` for epic breakdown.
- **Voice-matched article or thought leadership** → `shadow`. It applies the author’s voice and writing conventions from the ghostwriting skill; use `doc-writer` for standard project docs.

If the task doesn't match any of these, the main agent does it directly. Dispatching adds context-passing overhead — don't pay it for work you can do inline.

## The Shadow exception

`shadow` deliberately breaks the standard agent file shape: it omits the `## Skills` section and the role-suffix on its main heading (`# Shadow`, not `# Shadow — Ghostwriter`). This shape is kept for compatibility with existing adopter Shadow files, whose soul zone runs to the end of the file; its writing conventions come from the ghostwriting and content-formats skills.

`/review:check-templates` treats Shadow as conforming. If you fork this template and add a new agent, follow the 10-agent shape (all agents except Shadow) — not Shadow's shape.

---

See also: [`./skills.md`](./skills.md) for the skill catalog, [`./commands.md`](./commands.md) for how commands dispatch agents, [`../system-map.md`](../system-map.md) for the full system inventory.

## Codex role evidence

Use a matching installed role when the native dispatcher supports named selection. Otherwise a native worker reads the canonical role and declared skills; report it as canonical-role guidance execution, without claiming generated TOML dispatch. Codex uses its configured model/tools, not Claude aliases. Discovery, role execution and trusted hook visibility are separate checks. See the [execution adapter](../../../../.agents/adapters/codex/execution.md) and [migration limits](../migration-v6.md#runtime-behavior-and-evidence-limits).
