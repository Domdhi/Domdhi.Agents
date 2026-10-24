# Skills

Skills are authored under `.agents/skills/{name}/`. Each directory has a `SKILL.md` entry point; references load on demand, assets are copied into outputs and scripts provide executable support. The toolkit has 49 workflow entry points and 23 knowledge skills. Claude receives generated native copies; Codex discovers the canonical repository skills.

Knowledge skills hold reusable domain guidance. Workflows use the same native skill mechanism to select an authored procedure: most bodies live in `references/workflow.md`, while review-specialize keeps its workflow in `SKILL.md`. [Commands](../commands.md) lists all 49 mappings.

## Consumption and discovery

- Claude role `skills:` frontmatter loads declared knowledge at dispatch. Commands reference shared checklists by name rather than repeat their contents.
- Codex named-role availability depends on the native dispatcher. When unavailable, a worker reads the canonical role and declared skills; report that accurately as role-guidance execution.
- Knowledge skills commonly declare `user-invocable: false`; this suppresses Claude slash-menu invocation without preventing role/reference use. It does not mean every knowledge skill is a user command. Codex's discovered `$` inventory must be observed in the actual session.
- Explicit workflow use requires reading the installed selector and its selected body. Discovery proves availability, not execution. Start a fresh session when newly installed skills are absent.

## The 23 knowledge skills

| Skill | Primary use |
| --- | --- |
| `agent-creator` | New canonical role identity and adapter contract |
| `architecture` | System design, architecture docs and ADRs |
| `brand-guidelines` | Project brand identity; project-owned subtree |
| `code-review` | Risk routing, review depth and reviewer checklists |
| `command-creator` | Shared workflow conventions and native mapping |
| `content-formats` | Platform-specific writing formats |
| `design-taste-frontend` | Frontend design quality and component standards |
| `documentation` | Verified docs, examples and cross-references |
| `finishing-a-development-branch` | Branch integration and cleanup choices |
| `full-output-enforcement` | Complete generated artifacts |
| `ghostwriting` | Long-form writing in the author's voice; ships with a blank voice fingerprint the project fills in |
| `playwright-cli` | Browser interaction and testing |
| `project-planning` | Brief, PRD, backlog and project context |
| `qa-engineer` | Test strategy and acceptance coverage |
| `redesign-existing-projects` | Existing UI design improvement |
| `session-handoff` | Resolver-based continuity artifacts |
| `skill-authoring` | Evidence-driven doctrine and structural conventions |
| `skill-creator` | Create/eval/improve/benchmark mechanics |
| `systematic-debugging` | Root-cause investigation before fixes |
| `tailwind-css-patterns` | Tailwind-specific patterns |
| `using-git-worktrees` | Isolated worktree setup |
| `ux-design` | UX specs, themes, wireframes and mock layouts |
| `verification-before-completion` | Fresh evidence before completion claims |

Optional local aesthetic skills remain outside the shipped baseline; legacy `.claude/skills-optional/` is a compatibility location. Project-added canonical skill directories are the normal home for substantial project guidance. Shared additions use the [customization markers](../customization.md#keeping-project-skill-additions).

## Authoring a skill

A repeated checklist, a demonstrated model gap or useful project reference belongs in a skill. A distinct worker mandate/persona belongs in a role; a user-invoked orchestration procedure belongs in a workflow. Use `/create:component skill` or `$create-component skill` to scaffold and wire it.

[Skill authoring](../../../../.agents/skills/skill-authoring/SKILL.md) requires evidence of a real gap plus a differential evaluation showing improvement. It replaces the old strict failing-test-before-draft ordering. [Skill creator](../../../../.agents/skills/skill-creator/SKILL.md) owns the operational evaluation loop. Keep examples runnable, use the existing naming/frontmatter conventions and verify consumers before claiming a skill helps.

See [agents](agents.md) for role skill lists, [contributing](../guides/contributing.md) for creation examples and [system map](../system-map.md) for source/delivery wiring.
