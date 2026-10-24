---
name: documentation
description: "Use WHEN producing or updating documentation — API docs, changelogs, READMEs, architecture docs, or inline comments; documentation is wayfinding not record-keeping."
metadata:
  version: 1.1.0
  author: Domdhi.Agents
  tags: [documentation, writing, api-docs, changelogs]
user-invocable: false
allowed-tools: Read Write Edit Grep Glob
---

<!-- Generated from .agents/skills/documentation/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Documentation Writing Skill

## Purpose
Technical documentation, API docs, changelogs, READMEs, and project documentation. Load this skill whenever any agent needs to produce or update written documentation — it is not exclusive to a dedicated doc agent.

## Core Philosophy — The Map Must Match the Territory

Documentation is wayfinding, not record-keeping. A changelog isn't a list of what changed — it's a trail map showing how the terrain shifted. An API doc isn't a catalog of endpoints — it's a street guide. A README is the first thing a traveler sees when they arrive in unfamiliar territory, and it needs to orient them in thirty seconds or less.

Write for the person who arrives next — developer, user, or architect. The audience determines the register. Never mix audiences in the same document.


## Rules

1. **Verify before writing.** Read the actual code before documenting it. If the code says one thing and the docs say another, the code wins. No documenting what you *think* the system does.

2. **One source of truth, many signposts.** Write it once in the right place. Link to it everywhere else. Duplicated explanations drift apart within a week — consolidate and leave pointers.

3. **Explain why, not just what.** The code shows what happens. Documentation explains why this approach was chosen, what alternatives were considered, what constraints shaped the design. That's what gets lost when the original author leaves.

4. **Working examples are proof, not decoration.** Every API endpoint, pattern, or command includes a concrete, copy-paste-ready example. If the example doesn't work, the doc is broken.

5. **Write the shortest doc that's still complete.** Every sentence earns its place or gets cut. Structure for scanning first, reading second — clear headings, tables for reference data, prose for explanations.

6. **Broken links are bugs.** Treat dead cross-references with the same urgency as failing tests.

<!-- @@project-additions:start -->
7. **Propagate architecture changes to current navigation.** Update the applicable architecture overview and module brief in the same change as a structural decision. An accurate ADR does not keep those entry points current. Preserve decision history in its existing home while making current guidance accurate.

8. **Check numbered artifacts at write time.** List the actual destination immediately before assigning an ADR number; a number reserved in an earlier plan may now collide with another branch. Reconcile collisions against the integration branch before merging. Listing is a collision check, not an atomic reservation.

For instruction-size or preservation work, run `node .claude/core/context-audit.js --root .` (Codex: `.codex/core/context-audit.js`). The read-only report inventories root/startup guidance, canonical roles and skill entry points without reading private user configuration. Use repeated `--file` paths to select a narrower inventory, `--max-chars` for an explicit per-file budget and `--baseline` with a saved report to check exact preservation. Baseline paths are checkout-relative; raw hash differences remain failures even when only line endings differ. Character-based token estimates are heuristics, not runtime measurements.
<!-- @@project-additions:end -->

## Document Types and Conventions

| Type | Purpose | Key Quality Check |
|------|---------|-------------------|
| README | First-arrival orientation — 30 seconds to orient | Can a stranger find the most important thing in 30s? |
| API docs | Endpoint reference with request/response examples | Every endpoint has a working curl/fetch example |
| Architecture doc | System design rationale + ADRs | Answers "why" not just "what" |
| Changelog | Human-readable diff of what changed and why | Grouped by type: Features / Fixes / Breaking |
| Inline comments | "Why" not "what" — decision rationale only | Would be obvious without the comment? Delete it. |

## Changelog Format

```markdown
## [version] — YYYY-MM-DD

### Features
- Brief description of what was added and why it matters

### Fixes
- What broke, what the root cause was, what changed

### Breaking Changes
- What changed, what users need to do differently
```

## Consistency Rules

- If the codebase calls it a "workspace," docs never call it a "project"
- Same concept = same term everywhere, always
- Update adjacent docs when a change ripples — new endpoint means updating API reference, README, and architecture summary
- **Constants live in code; prose references the constant's NAME.** When a numeric default (cap, threshold, timeout) appears in command/skill/doc prose, phrase it as "the `MEMORY_MAX_PER_CATEGORY` default" (naming where it's defined), not a restated literal — or make ONE prose location canonical and link the rest to it. Restated literals rot: a cap change once left the same file saying both 50 and 100, and a careful two-of-three fix still missed the third instance in the same pass.
