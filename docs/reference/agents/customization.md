# Customization Zones

Updates refresh the shared toolkit while preserving project instructions, role identity, Project Context, bespoke skills and local configuration. Author changes under `.agents/`; generated `.claude/` and `.codex/` files are delivery surfaces. See [v6 migration](migration-v6.md) before updating an older installation.

## Ownership map

| Authored or project path | Ownership | Default update behavior |
| --- | --- | --- |
| `.agents/skills/` | Shared, with project exceptions | Refresh shared knowledge/workflow assets; merge marked Markdown additions; preserve project-added skills |
| `.agents/roles/*.md` | Shared behavior and project identity/context | Merge canonical roles; preserve nickname, aliases, personalized soul, tuned description, Project Context and eligible bespoke skills |
| `.agents/core/`, `hooks/`, `templates/`, `config/`, `adapters/` | Shared | Refresh managed sources; refuse conflicting local changes |
| `.agents/render-state.json` | Generated ownership ledger | Record canonical/native ownership through the renderer; retain it with the delivered sources |
| `.claude/`, `.codex/` managed projections | Generated | Render from canonical sources; edited managed files require reconciliation |
| `.claude/shared-agents.json`, `.codex/shared-agents.json` | Project | Preserve native role overrides; workshop defaults originate in `.agents/adapters/{runtime}/shared-agents.json` |
| `.agents/gate.config.json` | Project | Preserve application gate overrides; render compatible native config |
| `.claude/settings.json` | Shared wiring and project settings | Section-aware merge, described below |
| `.claude/settings.local.json`, `.claude/update-config.json`, `.codex/config.toml` | Project | Preserve; local Codex config is not a canonical or rendered asset |
| `.claude/guardrail-rules.project.yaml` | Project | Preserve project path-tier overrides; not distributed from the workshop |
| Root `CLAUDE.md`, `AGENTS.md` | Project with managed startup block | Preserve project prose and update only toolkit-managed directives |
| `docs/` | Project | Update does not deliver project docs; install/scaffold only seeds missing documents |
| `docs/reference/agents/` | Publish bundle | Install/update do not deliver it; read the workshop or published reference artifact |
| Root `CHANGELOG.md` | Workshop archive | Not published or synced; inline release notes live in canonical version metadata |

Classification is implemented in [zone-classifier.js](../../../.agents/core/_lib/zone-classifier.js), not read from this table. Bespoke native helpers/hooks and unmapped legacy components keep their existing project ownership. Do not copy an entire native tree over an adopter.

## Role zones

Canonical `.agents/roles/{name}.md` frontmatter contains identity, description and declared skills:

```yaml
---
name: data-engineer
nickname: River
aliases: [data, pipelines]
description: Data modeling and ETL implementation.
skills:
  - project-planning
---
```

The body separates the persona/soul, shared `## Skills` guidance and optional project-owned `## Project Context`. The merger preserves personalized soul and context, preserves tuned descriptions when personalized/specialized, refreshes shared Skills prose and retains eligible project-added skill references. Shared renames can leave legacy directories; reconcile declared skills with installed directories after updating.

Runtime model/tool/memory settings belong in the applicable native `shared-agents.json` override; workshop defaults are authored in adapters. The renderer emits Claude Markdown and Codex TOML. [Personalize](guides/personalize.md) edits the canonical soul; [specialize](guides/specialize.md) edits canonical context and skill wiring. A legacy `.claude/agents/` role is an authoring fallback only when no canonical counterpart exists.

## Keeping project skill additions

`brand-guidelines/**` is project-owned. For another shared skill's Markdown, use one of the two markers outside code fences:

- `<!-- @@project-additions -->`: everything below the marker is a preserved project tail.
- `<!-- @@project-additions:start -->` through `<!-- @@project-additions:end -->`: preserve an inline block under its nearest preceding heading.

The shared head refreshes under default merging. Inline blocks are reanchored to their headings; if an upstream heading disappears, the merger recovers the block at EOF and reports the orphan. Marker examples inside fenced code do not create ownership boundaries. Substantial project knowledge belongs in a separate project-added skill directory. See [skill-merger.js](../../../.agents/core/_lib/skill-merger.js) and [skill authoring](../../../.agents/skills/skill-authoring/SKILL.md).

## Choosing skills and roles: profiles

A project chooses which shared skills and roles it receives in its `.claude/update-config.json`:

```json
{ "skillProfile": "knowledge", "skillInclude": ["tailwind-css-patterns"], "skillExclude": ["review-status"] }
```

- `skillProfile` selects a toolkit profile from `.agents/adapters/skill-profiles.json`. A profile is an allow-list of skills and roles, so a new toolkit skill stays out of it until the toolkit adds it there. Fleet sync carries profile changes.
  - `app`: the full toolkit, for application repositories.
  - `knowledge`: planning, project creation, the builders and the workflow core, without the `sweep`/`retro`/`onboard` maintenance chain.
  - `agent`: writing and research (`ghostwriting`, `content-formats`, `research`, `remember`), with the `shadow` and `product-strategist` roles.
- `skillInclude` adds skills to the profile, and `skillExclude` removes them. Without `skillProfile`, every skill except `skillExclude` is delivered, and every role ships.
- Project-bespoke skills and roles are never excluded, because a profile only governs toolkit skills.

**Closure check.** The selection must be closed: no kept skill or role may still invoke a dropped skill. Invocations count in any form: `/name`, `review-x`, `/review:x`, or a `skills/name/` path. Update and install refuse an open selection before writing anything, and `render-shared-agents.js --check` fails on one. The refusal lists each `caller → dropped skill (file:line)` and the smallest fix. Two commands help:

```sh
node .claude/core/skill-profile.js check            # the effective set, and whether it is closed
node .claude/core/skill-profile.js suggest sweep    # which kept skills would also have to go
```

A workflow that names an optional workflow writes "if installed" on the same line (for example, ``Run `/review:feedback` if installed.``). The check treats that line as optional. A knowledge skill's bare name in prose (`tailwind-css-patterns` in a list of examples) is a mention, not an invocation.

**Switching to a leaner selection.** The next update removes the toolkit outputs that the selection now drops: generated skills, commands, agents and Codex projections, plus their canonical `.agents/` copies. It removes them only when they are unedited. An edited generated output is reported as a conflict, and the update stops until you move or delete it. A customised canonical copy, such as a personalised role, is kept with a warning. `--dry-run` lists the removals as `PRUNE` lines.

## Settings merge

Default updates refresh managed `hooks`, `plansDirectory` and `statusLine` wiring while preserving project `permissions`, `env`, `$schema` and unknown top-level keys. Custom hook entries survive when they reference an adopter-owned installed hook; inline commands survive unless identical to a template command. Missing-script fossil registrations are dropped. Preserved entries follow shared entries in their matcher group. Custom status lines belong in `settings.local.json`.

The policy is implemented by [settings-merger.js](../../../.agents/core/_lib/settings-merger.js). `--merge` remains a compatible spelling for the default; `--no-merge` skips these merges with warnings. It is not a command to overwrite personalized roles or local settings.

## Update and verify

Run from the pinned toolkit checkout, choosing the active runtime's helper:

```sh
# Codex; Claude uses .claude/core/ with the same arguments.
node .codex/core/template-updater.js update /path/to/project --merge --dry-run
node .codex/core/template-updater.js update /path/to/project --merge
```

Review refusals, warnings and changed-path output. Move intended shared edits into their canonical source and render; do not force over unknown managed-output changes. Managed root directives are merged additively. The legacy source-CLAUDE redirect remains a compatibility document, not authority to replace adopter root instructions.

After an update, inspect native settings and role skill resolution, run the installed `$review-check-templates` or Claude `/review:check-templates`, and verify the application's build/test gates. Toolkit tests belong only in Domdhi.Agents. [Migration v6](migration-v6.md) separates local metadata, verification and later authorized publication/fleet operations.
