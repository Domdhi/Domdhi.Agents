---
description: Audit .claude/ system health — orphaned agents, unused skills, missing hooks, broken wiring
---

# Check Templates

Self-diagnostic for the `.claude/` system. Scans agents, skills, hooks, commands, and settings for orphans, gaps, and broken cross-references. Read-only — reports findings without making changes.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:check-templates
```

## Workflow

### 0. Check for --multi flag

```
IF $ARGUMENTS contains "--multi":
  Run Steps 1-9 for the current project first (normal single-project audit)
  Then proceed to Step 10 (Cross-Project Scan)
ELSE:
  Run Steps 1-9 only (unchanged behavior)
```

### 1. Scan Agent Inventory

Read all `.claude/agents/*.md` files. For each agent, extract:
- `name` from frontmatter
- `skills` array from frontmatter
- `tools` and `disallowedTools` from frontmatter

### 2. Scan Skill Inventory

```
Glob: .claude/skills/*/SKILL.md
```

For each skill, record the skill directory name.

**CSO linter** — every skill's `description:` field must start with `"Use WHEN"` to satisfy the Conditional Skill Orchestration rule (see `skill-authoring/SKILL.md`). Shell check:

```bash
grep -L "^description: \"Use WHEN" .claude/skills/*/SKILL.md
```

Any file returned by that command violates the rule and MUST be flagged in Step 9's Issues Found section as **CSO VIOLATION**. Skills whose descriptions merely summarize capability ("X expert. Triggers: ...") cause Claude to follow the description as a shortcut and skip reading the skill body.

### 2b. Skill Spec Conformance

Run the deterministic conformance check against the Agent Skills open standard:

```bash
node .claude/core/skill-conformance.js
```

The script scans every `.claude/skills/*/SKILL.md` and applies three rules:

- **Body budget** — `SKILL.md` > 500 lines → **WARN: OVER_BUDGET** (activation cost; advisory, does not fail the gate)
- **Name match** — `name:` frontmatter ≠ parent directory name → **ERROR: NAME_MISMATCH**
- **Description length** — `description:` > 1024 characters → **ERROR: DESC_TOO_LONG**

Exit code is 0 when clean or WARN-only, non-zero only when an ERROR is present. Capture stdout — each line names the offending skill, the rule, and the measured value (e.g. `WARN tailwind-css-patterns: 877 lines (budget 500)`). Any output MUST appear in Step 9's Issues Found section: ERRORs as **SPEC VIOLATION**, WARNs as **OVER BUDGET**.

### 2c. Operating-Standard Enforcement

Assert the project's operating standard ("resolve it or don't report it" — the mission at the top of `CLAUDE.md`) is *enforced* through the agent tier, not merely declared. Run the deterministic checker:

```bash
node .claude/core/operating-standard.js
```

It scans every `.claude/agents/*.md` and applies role-routed rules:
- **Acting** agents (write code/docs) MUST load `verification-before-completion` in frontmatter **and** carry an `## Operating Standard` section.
- **Report-only** agents (`disallowedTools: Edit` — `code-reviewer`, `security-auditor`) MUST carry an `## Operating Standard` section in its **report-only** translation (exhaustive/precise/fix-ready findings, hand the orchestrator the fix). They are NOT required to load the skill — that would imply they write fixes.
- **`shadow`** is exempt — its prose persona is its convention (the documented Shadow exception); it carries the doctrine in its own idiom.

Exit code is 0 when clean, non-zero when any ERROR exists. Each ERROR (a dropped `## Operating Standard` section, or an acting agent missing the skill ref) is a silent doctrine regression. This audit is read-only by design, but the operating standard binds *this command too*: don't dead-end in a report — fold any output into Step 9's Issues Found as **DOCTRINE REGRESSION** and **fix it in place** (add the missing section or `verification-before-completion` skill ref to the named agent), then re-run the checker to confirm green.

### 2d. Frontmatter Skill Resolution

Assert every skill an agent declares in frontmatter **actually preloads**. Subagent `skills:` is *eager full-body injection* at startup (Claude Code native — `sub-agents.md`, "Preload skills into subagents": the full body is injected, firing NO `Read` event), so a broken ref fails **silently** — no runtime error, no telemetry signal, and the agent runs as if it had the knowledge. Run the deterministic checker:

```bash
node .claude/core/skill-resolution.js
```

It scans every `.claude/agents/*.md` frontmatter `skills:` list against the `.claude/skills/` tree and flags two silent failure modes:
- **BROKEN_SKILL_REF** — a listed skill has no `.claude/skills/<name>/SKILL.md` (typo, renamed/removed skill) → preload loads nothing.
- **UNPRELOADABLE** — a listed skill sets `disable-model-invocation: true` → cannot be preloaded, silently skipped.

Exit code is 0 when clean, non-zero on any ERROR. This is the tool-checkable form of the manual "BROKEN SKILL REF" check in Step 6 — same operating standard applies: fold output into Step 9's Issues Found as **BROKEN SKILL REF**, **fix it in place** (correct the agent's frontmatter or add/restore the skill), then re-run to confirm green.

### 2e. Path-Drift Lint

Assert path literals in prose and code match the current resolvers — the mechanical form of the `migrate-all-readers-of-a-shared-path-in-one-wave` workflow memory (four independent writer/reader drift instances in the v4.95 window alone). Run the deterministic checker:

```bash
node .claude/core/path-drift-lint.js
```

It scans the template fileset (`.claude/`, `tools/`, `docs/reference/`, `docs/engineering/`, root `CLAUDE.md`/`docs/CLAUDE.md`/`README.md`) plus the living plan (`docs/work/backlog.md`, `roadmap.md` — the rest of `docs/work/` is historical as-of-date record, deliberately not judged) and applies three rules:

- **LEGACY_TOKEN** (ERROR) — a pre-taxonomy `.output/…` token survives (sourced from `migrate-output-layout.js`'s rewrite table plus the Amendment-2 `memories/` store)
- **FLAT_HANDOFF** (ERROR) — a literal or glob addresses a file directly under `handoffs/` with no `{YYYY-MM}` month segment; `handoff-path.js` writes month-bucketed, so a flat reader glob silently misses every current handoff
- **UNKNOWN_COMPARTMENT** (WARN) — a literal `docs/.output/<seg>` segment absent from `constants.js OUTPUT_PATHS` (WARN because the taxonomy is open — adopters grow compartments; in the workshop it usually means drift)

Exit code is 0 when clean or WARN-only, 1 on any ERROR. Same operating standard as 2c/2d: fold output into Step 9's Issues Found as **PATH DRIFT**, **fix it in place** (update the stale literal to the resolver's current shape — or, for an intentional legacy example, append a `path-lint:keep` marker to that line), then re-run to confirm green.

### 3. Scan Hook Inventory

```
Glob: .claude/hooks/*.cjs
```

For each hook file, record the filename.

### 4. Scan Command Inventory

```
Glob: .claude/commands/**/*.md
```

For each command, read the content and extract:
- Agent references (mentions of `subagent_type:` or agent names like `architect`, `code-reviewer`, etc.)
- Skill references (mentions of skill names or `SKILL.md`)

### 5. Read Settings

Read `.claude/settings.json` — extract the `hooks` section:
- Which hook files are registered under PreToolUse, PostToolUse, PreCompact
- Which matchers are configured

### 6. Cross-Reference Analysis

**6a. Agent wiring:**
- For each agent: is it referenced by at least one command? If not → **ORPHANED**
- Broken skill refs are now caught deterministically in Step 2d (`skill-resolution.js`) — don't re-derive them by eye here; just carry forward any **BROKEN SKILL REF** / **UNPRELOADABLE** findings it reported.

**6b. Skill wiring:**
- For each skill: is it loaded by at least one agent's frontmatter? If not → **UNUSED SKILL**
- For each skill: is it referenced by at least one command? If not → **UNREFERENCED** (may be fine if agent-loaded only)

**6c. Hook wiring:**
- For each hook file: is it registered in settings.json? If not → **UNREGISTERED HOOK**
- For each settings.json hook entry: does the referenced file exist? If not → **MISSING HOOK FILE**

**6d. Command wiring:**
- For each command that references an agent: does the agent file exist? If not → **MISSING AGENT**
- For each command: does it have a matching skill registration entry? (informational only)

### 7. Read Template Version

Read `.claude/version.json` if it exists:
- If found: extract `version`, `updated`, `changelog` fields
- If not found: set version to "unknown (pre-versioning)"

### 8. Score

Rate each category 0-10:

| Category | 10 (perfect) | 0 (broken) |
|----------|-------------|------------|
| **Agents** | All agents referenced by commands, all skill refs valid | Multiple orphans, broken refs |
| **Skills** | All skills loaded by agents | Multiple unused skills |
| **Hooks** | All hooks registered, all registrations point to real files | Orphaned hooks, missing files |
| **Commands** | All agent references valid | Missing agents referenced |
| **Settings** | Hook config complete and consistent | Broken registrations |

**Total health score:** sum of 5 categories (0-50)

### 9. Report

**Persist before reporting:** Write the full report below to `docs/.output/findings/reviews/{YYMMDD-HHMM}-template-health-check.md`. Then display the same content in chat.

```markdown
## Template Health Check

**Date**: {YYYY-MM-DD}
**Health Score**: {N}/50
**Template Version**: {version} (updated {updated})

### Agent Wiring ({score}/10)
| Agent | Referenced By | Skills Valid | Status |
|-------|-------------|-------------|--------|
| {name} | {command list or "none"} | {Y/N} | {OK/ORPHANED/BROKEN} |

### Skill Wiring ({score}/10)
| Skill | Loaded By | Status |
|-------|----------|--------|
| {name} | {agent list or "none"} | {OK/UNUSED} |

### Hook Wiring ({score}/10)
| Hook | Registered | Event | Matcher | Status |
|------|-----------|-------|---------|--------|
| {file} | {Y/N} | {PreToolUse/PostToolUse/PreCompact} | {matcher} | {OK/UNREGISTERED} |

### Command Wiring ({score}/10)
| Command | Agents Referenced | All Valid | Status |
|---------|-----------------|-----------|--------|
| {name} | {agent list} | {Y/N} | {OK/BROKEN} |

### Settings ({score}/10)
| Check | Status |
|-------|--------|
| All hook registrations resolve | {Y/N} |
| No duplicate matchers | {Y/N} |

### Issues Found
{Numbered list of specific issues}

### Recommendations
{What to fix, ordered by impact}
```

### 9b. Commit (main agent)

After the report file is written, commit it:

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /review:check-templates — {score}/50, {N} issues found
```

Then run:

```bash
git add docs/.output/findings/reviews/{YYMMDD-HHMM}-template-health-check.md
node .claude/core/commit.js
```

### 10. Cross-Project Scan (--multi only)

Scan the parent directory of the current project for sibling repos with `.claude/` directories.

**Discovery:** Use Glob to find sibling directories. For each candidate directory name found by listing `../`, check whether `../{dir}/.claude/version.json` exists using the Read tool. A directory qualifies as a sibling project if that file is readable (even if it returns an empty or error result — treat read errors as "version unknown").

For each discovered sibling project:

**10a. Read version:**
- Read `../{project}/.claude/version.json` → extract `version` and `updated` fields
- If not found or unreadable → version = "unknown (pre-versioning)"

**10b. Count inventory (lightweight — no cross-reference analysis):**
- Use Glob on `../{project}/.claude/agents/*.md` → count results → agent count
- Use Glob on `../{project}/.claude/hooks/*.cjs` → count results → hook count
- Use Glob on `../{project}/.claude/skills/*/SKILL.md` → count results → skill count

**10c. Version comparison:**
- Compare sibling version against current project's version (the one read in Step 7)
- Use semver comparison: split each version string on ".", compare major, then minor, then patch numerically
- If sibling version < current project version → status = "OUTDATED"
- If sibling version > current project version → status = "AHEAD"
- If sibling version == current project version → status = "CURRENT"
- If either version is "unknown (pre-versioning)" → status = "UNKNOWN"

### 11. Cross-Project Report (--multi only)

Append the following section to the single-project report produced in Step 9:

```markdown
## Cross-Project Template Status

**Current project version**: {version from Step 7}
**Sibling projects found**: {count of discovered siblings}

| Project | Version | Status | Agents | Hooks | Skills |
|---------|---------|--------|--------|-------|--------|
| {dir name} | {version} | {CURRENT/OUTDATED/AHEAD/UNKNOWN} | {n} | {n} | {n} |

### Version Drift
{List each project whose status is OUTDATED, AHEAD, or UNKNOWN, with its version and the delta from current.}
{If all projects are CURRENT, write: "No version drift detected — all projects are on the same version."}

### Recommendations
{For each OUTDATED project: "Update {project} from {their version} to {current version}."}
{For each AHEAD project: "Current project may need to pull changes from {project} ({their version})."}
{For each UNKNOWN project: "Add version.json to {project} to enable version tracking."}
{If no issues: "All projects are on the same version — no action required."}
```
