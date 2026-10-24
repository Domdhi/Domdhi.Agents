---
description: Generate a changelog from completed stories and git history
argument-hint: [version or date range — e.g., "v1.0" or "2026-01-01..2026-02-01"]
---

<!-- Generated from .agents/skills/review-changelog/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Changelog

Generate a structured changelog from completed stories, git commits, and retrospective findings. Release-oriented view of what's new for users since last release.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:changelog
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle scope detection and raw data gathering (git, epics, retros, daily logs). The `doc-writer` agent handles change classification and changelog generation. Do NOT write the changelog inline — delegate via Task tool. You DO handle existing changelog merging and committing.

**Agent**: `doc-writer` (via Task tool with `subagent_type: "doc-writer"`)

## Variables

INPUT: $ARGUMENTS

- `INPUT` (optional): Version tag or date range. Defaults to all unreleased work since last changelog.

## Workflow

### 1. Determine Scope (main agent)

**If INPUT is a version tag** (e.g., `v1.0`, `v2.3.1`):
- Find the git tag: `git tag -l "{INPUT}"`
- If tag exists → changelog covers commits from previous tag to this tag
- If tag doesn't exist → this is a new release; scope from last tag to HEAD

**If INPUT is a date range** (e.g., `2026-01-01..2026-02-01`):
- Scope commits within that range

**If no INPUT**:
- Find the most recent git tag: `git describe --tags --abbrev=0`
- If tags exist → scope from last tag to HEAD
- If no tags → scope all commits

### 2. Gather Data (main agent)

**From Git:**
```bash
# Commits in scope
git log --oneline {from}..{to}

# Files changed summary
git diff --stat {from}..{to}

# Contributors
git log --format="%aN" {from}..{to} | sort -u
```

**From Epics:**
- Read `docs/work/backlog.md`
- Find stories marked `[x]` that were completed within the scope period
- Group by epic

**From Retros:**
- Read any `docs/.output/findings/reviews/retro-*.md` files created during this period
- Extract key decisions and pattern changes

**From Daily Logs:**
- Read `docs/.output/.state/memory-daily/*.md` files within the scope period
- Extract session context and key decisions

### 3. Delegate to Agent (main agent → doc-writer)

Use the Task tool with `subagent_type: "doc-writer"` to classify changes and generate the changelog.

**Task prompt must include**:
1. Version or scope identifier and date range
2. All gathered data from Step 2 (commit list, file stats, contributors, epic stories, retro findings, daily log summaries)
3. The `doc-writer` agent auto-loads the `project-planning` skill via frontmatter.
4. Instruction to classify changes into: Added, Changed, Fixed, Removed, Security, Infrastructure, Documentation
5. Instruction to derive categories from commit prefixes (feat, fix, docs, refactor, chore, security), story titles, and daily log entries
6. Instruction to write the changelog section using the output template below
7. Whether `docs/CHANGELOG.md` already exists (if so, provide its current content for prepending)

**Output template for the agent:**

```markdown
## [{version or Unreleased}] - {YYYY-MM-DD}

### Added
- **{Feature Name}** — {user-facing description} ([Story {N.M}])
- **{Feature Name}** — {description}

### Changed
- {What changed and why} ([Story {N.M}])

### Fixed
- {Bug description and fix} ([#{commit-hash}])

### Removed
- {What was removed and why}

### Security
- {Security improvement}

### Infrastructure
- {Tooling, deps, CI changes}

---

### Stats
- **Stories completed**: {count}
- **Commits**: {count}
- **Files changed**: {count}
- **Lines**: +{added} / -{removed}
- **Contributors**: {names}
- **Epics progressed**: {list}
```

### 4. Merge with Existing Changelog (main agent)

- **If `docs/CHANGELOG.md` exists** → prepend new version section above existing content
- **If it doesn't exist** → create with header:

```markdown
# Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

---

{version section}
```

### 5. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command and commit with a descriptive message.

### 6. Report (main agent)

```markdown
## Changelog Generated

**Version**: {version or "Unreleased"}
**Period**: {from date} → {to date}
**Output**: docs/CHANGELOG.md

### Summary
- **Added**: {count} features
- **Changed**: {count} modifications
- **Fixed**: {count} bug fixes
- **Stories covered**: {count}
- **Commits processed**: {count}

**Committed**: {hash} — `docs: /changelog — {summary}`
**Next step**: Review the changelog, then tag the release with `git tag {version}`.
```

## When to Run

- Before tagging a release
- At the end of an epic (after `/retro`)
- Periodically to generate an "Unreleased" section
- When preparing release notes for stakeholders
