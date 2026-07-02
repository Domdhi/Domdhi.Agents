# Customization Zones

When updating the template (via subtree, copy, or future update mechanism), some files are safe to overwrite and some contain project-specific content that must be preserved. This file maps the zones.

## Zone Map

| Path | Zone | Update Strategy |
|------|------|-----------------|
| `.claude/commands/**/*.md` | Template | **Overwrite** — commands are orchestration, never project-specific |
| `.claude/core/*.js` | Template | **Overwrite** — scripts are project-agnostic |
| `.claude/hooks/*.cjs` | Template | **Overwrite** — hooks are project-agnostic (project-specific hooks preserved) |
| `.claude/skills/**` | Template | **Overwrite** — entire skills tree (SKILL.md + references/, examples/, `assets/`, sibling `.md`/`.ts`/`.dot`/`.sh`) except `brand-guidelines/**` (see below). **Skill `.md` escape hatch under `--merge`:** a file carrying a `<!-- @@project-additions -->` tail is **merged** (template head refreshed, adopter tail preserved) — see Skill Exceptions. **Skill-owned document templates live here** (`<skill>/assets/*`, the scaffold source of record via `SKILL_TEMPLATE_MANIFEST`) |
| `.claude/skills-optional/` | Template | **Overwrite** (gitignored — local-only aesthetic skills) |
| `.claude/templates/` | Template | **Overwrite** — residual no-owner templates only (CLAUDE.md docs-guide + `root/`); doc templates moved to skill `assets/` |
| `.claude/version.json` | Template | **Overwrite** — template version metadata (changelog capped to the newest 3 releases by `fleet:release`) |
| `CHANGELOG.md` (root) | **Workshop-only** | **Not propagated** — archive of older release notes demoted out of `version.json` by `fleet:release`; not in the publish allowlist, not a `.claude/` subtree, so adopters never receive it |
| `.claude/agents/*.md` (11 base) | **Mixed** | **Merge** — see Agent File Zones below |
| `.claude/agents/*.md` (project-added) | **Project** | **Preserve** — agents added by `/specialize` or manually |
| `.claude/settings.json` | **Project** | **Preserve** — project-specific permissions, env vars, hook paths |
| `.claude/update-config.json` | **Project** | **Preserve** — per-project updater config (`skillExclude`); read by the updater to skip opted-out skills |
| `docs/reference/agents/customization.md` | Template | **Overwrite** — this file |
| `CLAUDE.md` (target's root) | **Project** | **Never touch** — projects own their root Claude Code instructions |
| Source `CLAUDE.md` → target `.claude/README.md` | Doc redirect | **Overwrite** — template self-documentation co-located with the files it documents |
| `.githooks/` | Template | **Overwrite** |
| `docs/` | **Project** | **Never touch** — all project content |

## Agent File Zones

Agent files have three zones with clear ownership. `/personalize` and `/specialize` already respect these boundaries:

```
---                              FRONTMATTER (Template)
name: agent-name                   Overwrite on update — except:
nickname: {name}                     nickname  → Preserve (set by /personalize)
aliases: [...]                       aliases   → Preserve (set by /personalize)
model: sonnet                        model     → Overwrite
description: ...                     description → Preserve if personalized/specialized; else Overwrite
tools: ...                           tools     → Overwrite
skills: ...                          skills    → Overwrite
memory: project                      memory    → Overwrite
---

# {Name} — {Role Title}         SOUL ZONE (Project — /personalize)
                                   Preserve on update.
Identity, Decision Philosophy,     Written by /personalize with project-specific
Working Style, Quality Standards   personality. If never personalized, contains
                                   thin template defaults (safe to overwrite).
...

## Skills                        SKILLS ZONE (Template)
                                   Overwrite on update.
Read these files at the start...   Auto-generated from frontmatter skills list.

## Project Context               SPECIALIZE ZONE (Project — /specialize)
                                   Preserve on update.
> Specialized for {Project}...     Written by /specialize with project tech stack,
                                   ADRs, and conventions. If never specialized,
Tech Stack, ADRs, Conventions      this section doesn't exist (nothing to preserve).
```

**Update algorithm for agents:**
1. Overwrite frontmatter (except `nickname` and `aliases`, always preserved; plus `description` and the `skills:` list per steps 2 and 5)
2. If the agent is personalized (`nickname`) or specialized (`## Project Context`) → also preserve its `description` — it's tuned by `/personalize`, `/specialize`, and `/optimize-agents`, and the generic template description would otherwise clobber routing-critical text
3. If Soul Zone was personalized (not thin defaults) → preserve it
4. Overwrite the `## Skills` prose section (template-owned)
5. **Union project-specific skills into the frontmatter `skills:` list** — a `skills:` entry that is NOT a template skill (not shipped by the source) but DOES exist as a skill dir in the target is a `/review:specialize` addition and is preserved; template-renamed/consolidation orphans (no target dir) are dropped. Distinct from step 4: the `## Skills` *prose* is template-owned, but the frontmatter `skills:` *list* can carry project specializations. (Before this, the merge silently stripped specialized agents' domain skills on every update.)
6. If Project Context section exists → preserve it
7. If neither personalized nor specialized → full overwrite is safe (so thin agents still pick up template description improvements)

## Skill Exceptions

Most skills are template content. Two ways a project keeps its own skill content across updates:

| Skill | Zone | Notes |
|-------|------|-------|
| `brand-guidelines/**` (whole tree) | **Project** | Customized per-project with brand colors, typography, visual identity, logo assets, palette files. Whole subtree preserved on update — any sub-docs added in the target stay project-owned. (The crude, whole-subtree precedent for the section-level marker below.) |
| Any skill `.md` with a `<!-- @@project-additions -->` tail | Template head + **Project** tail | **Section-level escape hatch (under `--merge`).** Everything below the marker is adopter-owned and preserved; the template head above it still refreshes. The skill analog of the agent Soul-Zone/Project-Context merge. Logic: `_lib/skill-merger.js`. Commands that add project content to a template skill (`/review:specialize`, `/sweep`, `/review:evolve-skills`) write it below the marker. |
| All others (including `references/`, `assets/`, `scripts/`, `examples/`) | Template | Overwrite on update. SKILL.md **and** its support files (`references/*`, `scripts/*`, `assets/*`, etc.) propagate together — they're authored as a unit in the template, so partial propagation leaves SKILL.md pointing at missing references. |

### Opting out of template skills

A project can permanently decline template skills it doesn't use — e.g. `tailwind-css-patterns` in a DevExpress/Blazor project, or the atomic workflow skills in a project that consolidated them — by listing the skill directory names in `.claude/update-config.json`:

```json
{ "skillExclude": ["tailwind-css-patterns", "design-taste-frontend", "redesign-existing-projects"] }
```

`template-updater.js` reads this file from the **target** project and skips any listed skill on every update, so skills a project deliberately removed don't silently return on the next sync. The config is Project zone — the updater never overwrites it. (Description preservation, above, prevents the parallel problem of `/optimize-agents`-tuned descriptions reverting on update.)

## Detection Heuristics

To detect whether a file has been customized:

| Check | Means |
|-------|-------|
| Agent has `nickname:` in frontmatter | Personalized — preserve Soul Zone |
| Agent has `## Project Context` section | Specialized — preserve that section |
| Agent `skills:` entry is a non-template skill with a target dir | Specialized skill — preserve (union back in) |
| `brand-guidelines/SKILL.md` differs from template | Customized — preserve |
| `settings.json` exists | Project-specific — always preserve |
| Target's root `CLAUDE.md` | Always project-specific — never touched by updater |

## Project-Specific Agents

Projects can add agents beyond the 11 base template agents. These are **Project zone** — template updates will never touch them. Name them by role (e.g., a compliance-reviewer for a regulated-industry project, a growth-experiment-designer for a SaaS product) and give them personas via `/review:personalize`.

These agents follow the same frontmatter format as base agents. The template updater detects them by comparing against the base agent list and skips them entirely.

## Settings.json Merging

`settings.json` is always **Preserve** — never overwritten. When the template adds new hooks, they must be manually wired into project settings. Key areas that differ per project:

- `env` — project-specific environment variables and feature flags
- `permissions.allow` — project-specific tool permissions (npm, supabase, wrangler, etc.)
- `hooks` — project-specific hooks (auto-formatting, linting, typecheck, migration timestamps)

When updating a project, compare the template's `settings.json` hooks section against the project's to find missing entries. Add new template hooks without removing project-specific ones.

## Template Update Mechanism

`template-updater.js` implements the zone-aware merge strategy defined above. Field-tested and manually verified against multiple downstream projects (April 2026).

```bash
node .claude/core/template-updater.js update <target-path> [--merge] [--dry-run]
```

Behavior:
1. Reads this file's zone map to determine template vs project ownership
2. **Overwrite** zones: replaces entirely
3. **Preserve** zones: skips entirely (includes project-specific agents, settings.json, and the target's root CLAUDE.md)
4. **Merge** zones: uses agent zone boundaries (Soul Zone, Project Context preserved)
5. **Doc redirect**: source `CLAUDE.md` is copied to target's `.claude/README.md` as template self-documentation; target's root `CLAUDE.md` is never touched
6. **New files** in template: copies them in
7. **Deleted files** from template: warns but doesn't auto-delete
8. `--dry-run` previews changes without writing; `--merge` enables zone-aware agent merging

### Manual Steps After Template Update
1. Compare `settings.json` hooks — add any new template hooks to project settings
2. Run `node .claude/core/memory-manager.js lint` — verify memory system health
3. Run `/review:check-templates` — verify system wiring integrity
