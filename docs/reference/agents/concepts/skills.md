# Skills

A skill in this system is a folder at `.claude/skills/{name}/` with a `SKILL.md` file that carries domain knowledge — a template, a quality checklist, a set of interview questions, an investigation procedure, a style guide. Skills don't *do* anything on their own; they get loaded into a conversation (by an agent, a command, or the user directly) so that whoever is acting has the right reference material already in context. There are 21 of them in this template as of today.

Skills are the **knowledge layer** of the three-tier architecture. Commands orchestrate procedures. Agents execute delegated work. Skills carry the shared reference material both layers lean on. Put another way: if the same checklist or template appears in three different commands, it belongs in a skill. The payoff is that changing the rule in one place updates every downstream consumer — no search-and-replace, no inline-copy drift.

## The three consumption paths

A skill can reach an agent or a command in one of three ways. Most skills travel down one of these paths by design; a few travel down more than one.

1. **Auto-load by an agent (the common case).** Every agent has a `skills:` list in its frontmatter. When the agent is dispatched, Claude Code reads each SKILL.md into the agent's context before the agent's first turn. The command that dispatched the agent doesn't need to tell it "read the skill first" — the skill is already there. See [`./agents.md`](./agents.md) for the full mechanism.
2. **Checklist reference by a command.** A command may mention a skill by name in its instructions — for example, `/do` tells the main agent to "regenerate the handoff using the `session-handoff` skill" at Step 9d. The command doesn't inline the skill's rules; it names it and lets the main agent pull the file. This keeps command files thin and keeps the rules in one place.
3. **Direct user invocation.** Every SKILL.md with proper frontmatter is discoverable by Claude Code as `/skill-name`. Useful when you want to trigger a skill's procedure outside a command — for example, running `/simplify` on code you just wrote, or `/skill-authoring` when authoring a new skill.

The story heading for this doc calls out "user-invocable vs internal," and in practice that distinction is fuzzy: all 21 skills are technically user-invocable because Claude Code picks them up from frontmatter. The meaningful question isn't "is it invocable?" — it's "what's the primary consumer?" For `architecture` the answer is the `architect` agent. For `session-handoff` the answer is five different session-boundary commands. For `skill-authoring` and `content-formats` there is no primary consumer — they're designed for direct invocation when you're extending the system.

## The 21 skills

| Skill | Primary consumer | Purpose |
|-------|------------------|---------|
| `architecture` | `architect` agent + `/create:project-architecture`, `/review:check-readiness` | Architecture doc template + quality criteria |
| `project-planning` | `product-strategist`, `project-planner`, `doc-writer` agents + `/brainstorm`, `/research`, `/create:project-brief`, `/create:project-requirements`, `/create:project-epics`, `/create:project-todo`, `/create:project-epics-todo`, `/review:optimize-backlog`, `/review:check-readiness`, `/review:changelog`, `/review:update-docs`, `/retro` | Consolidated planning-pipeline authoring: brief, PRD, backlog (epics/stories), project-context quick-ref — templates + guidance in `references/`/`assets/` (folded in epic-writer + project-context) |
| `documentation` | `doc-writer` agent | Documentation wayfinding + verification rules |
| `ux-design` | `ux-designer` agent + `/create:project-design`, `/review:check-readiness` | UX spec template + quality criteria |
| `brand-guidelines` | `ux-designer` agent (updates `/create:project-design`) | Brand colors/typography guide |
| `code-review` | `code-reviewer` + `security-auditor` agents + `/review:code-review` | Two-stage review process, severity routing + checklists |
| `qa-engineer` | `qa-engineer` agent + `/review:qa` | Test strategy + generation patterns |
| `playwright-cli` | `playwright` agent + `/run-tests` | Browser automation patterns |
| `ghostwriting` | `shadow` agent | Blog/article writing patterns |
| `content-formats` | direct invocation | LinkedIn, newsletter, Twitter, YouTube templates |
| `agent-creator` | `/create:component` | Agent creation template + conventions |
| `command-creator` | `/create:component` | Command creation template + conventions |
| `tailwind-css-patterns` | `ux-designer` agent + `/review:specialize` (as exemplar) | Tailwind utility patterns |
| `full-output-enforcement` | `general-purpose` agent | Anti-truncation rules |
| `systematic-debugging` | `general-purpose` agent | 4-phase root cause investigation |
| `verification-before-completion` | `general-purpose` agent | Blocks success claims without fresh verification |
| `finishing-a-development-branch` | `general-purpose` agent | Branch integration workflow (merge, PR, keep, discard) |
| `using-git-worktrees` | `general-purpose` agent | Isolated worktree creation for feature work |
| `skill-authoring` | direct invocation | TDD for skill creation (baseline test before writing) |
| `design-taste-frontend` | `ux-designer` agent | Frontend design standards |
| `redesign-existing-projects` | `ux-designer` agent | Upgrade existing UI patterns |
| `session-handoff` | `/end`, `/do`, `/run-todo`, `/run-tests`, `/todo` | Handoff template + fill rules for session-persistence commands |

Every skill file lives at `.claude/skills/{name}/SKILL.md`. Some skills have supplemental files in the same folder (exemplars, templates, rule files) — `SKILL.md` is the entry point, and Claude Code loads just that file on auto-load or reference.

An optional directory `.claude/skills-optional/` exists for aesthetic skills that are gitignored and not shipped by default. Drop them in manually for design-heavy projects, or wire them via `/review:specialize`.

## Auto-load mechanism

Summary (the full explanation lives in [`./agents.md`](./agents.md)): every agent's frontmatter declares a `skills:` list; Claude Code loads each named SKILL.md into the agent's context before the agent's first turn; the command that dispatched the agent does NOT repeat the skill's content in the prompt. If you find yourself writing a command that pastes skill text into the prompt, the skill wiring is wrong — fix the agent frontmatter instead.

Commands can still reference a skill by name ("use the `session-handoff` skill") when the command itself needs the reference material. That's Path 2 above. What they shouldn't do is inline the skill's content — that's duplication, and CLAUDE.md explicitly calls it out as the single biggest anti-pattern in an untuned template.

## When to add a new skill

Add a skill when:

- **The same checklist, template, or rule appears in two or more commands** — the shared reference belongs in a skill, and both commands should reference it by name.
- **An agent's behavior needs tuning that isn't about its persona** — rules about how to name things, how to verify work, how to structure a specific kind of document. The agent's frontmatter gets the new skill added to its `skills:` list.
- **You're codifying a process that other humans (or future-you) will need to follow** — a debugging procedure, a handoff template, a review rubric. Skills are durable; inline prose in a command rots.

Don't add a skill for:

- **Project-specific one-off knowledge.** That belongs in `CLAUDE.md` or the module's `brief.md`.
- **Rules that only apply to one agent and never change.** Just put them in the agent's persona.
- **Knowledge that's already covered by an existing skill.** Check the catalog above first — there are 21 skills, and most territory is already mapped.

Use the [`skill-authoring`](../../.claude/skills/skill-authoring/SKILL.md) skill when authoring a new one. It applies TDD to skill creation: write a failing baseline test before writing the skill, then iterate until the test passes. This keeps new skills grounded in a concrete scenario rather than floating in abstraction.

---

See also: [`./agents.md`](./agents.md) for the agent inventory and auto-load mechanism, [`./commands.md`](./commands.md) for the orchestration layer, [`./hooks.md`](./hooks.md) for the deterministic event layer, [`./memory.md`](./memory.md) for the auto-compound pipeline.
