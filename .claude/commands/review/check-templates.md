---
description: Audit .claude/ system health — orphaned agents, unused skills, missing hooks, broken wiring
---

<!-- Generated from .agents/skills/review-check-templates/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Check Templates

Self-diagnostic for canonical `.agents/` sources and the installed Claude/Codex projections. Scans agents, skills, hooks, commands, and settings for orphans, gaps, and broken cross-references. Read-only — reports findings without making changes.

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

Read canonical `.agents/roles/*.md` first, plus legacy native roles without canonical equivalents. Extract identity and declared `skills` from source frontmatter. Read generated Claude frontmatter/Codex TOML and each runtime's project-owned `shared-agents.json` for actual tools, model and permission wiring; those fields do not belong in canonical role frontmatter.

### 2. Scan Skill Inventory

Enumerate `.agents/skills/*/SKILL.md` (legacy native skills only where canonical sources are absent). Partition the inventory using `.agents/adapters/workflows.json`: registered explicit workflow selectors and conditional knowledge skills have different description and wiring contracts.

**CSO check** — only conditional knowledge skills require a `Use WHEN` triggering clause. Registered workflow selectors intentionally use explicit invocation descriptions; do not classify them as violations or unused knowledge. The following read-only check implements the partition (use the active runtime's native helper prefix):

```bash
node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./.claude/core/_lib/frontmatter');
const selectors = new Set(Object.keys(require('./.agents/adapters/workflows.json')));
const root = '.agents/skills';
let errors = 0;
for (const name of fs.readdirSync(root)) {
  const file = path.join(root, name, 'SKILL.md');
  if (!fs.existsSync(file) || selectors.has(name)) continue;
  const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!fm || !/Use WHEN/.test(fm.description || '')) {
    console.error('CSO VIOLATION: ' + file);
    errors++;
  }
}
process.exitCode = errors ? 1 : 0;
NODE
```

For a legacy-only installation, use its actual knowledge inventory; do not infer missing selector registration from an older source layout. Flag genuine knowledge violations in Step 9.

### 2b. Skill Spec Conformance

Run the deterministic conformance check against the Agent Skills open standard:

```bash
node .claude/core/skill-conformance.js
```

The current CLI scans the installed Claude skill projections and applies three rules. Keep the canonical inventory/CSO checks above separate, and compare Codex entry points through their adapter:

- **Body budget** — `SKILL.md` > 500 lines → **WARN: OVER_BUDGET** (activation cost; advisory, does not fail the gate)
- **Name match** — `name:` frontmatter ≠ parent directory name → **ERROR: NAME_MISMATCH**
- **Description length** — `description:` > 1024 characters → **ERROR: DESC_TOO_LONG**

Exit code is 0 when clean or WARN-only, non-zero only when an ERROR is present. Capture stdout — each line names the offending skill, the rule, and the measured value (e.g. `WARN tailwind-css-patterns: 877 lines (budget 500)`). Any output MUST appear in Step 9's Issues Found section: ERRORs as **SPEC VIOLATION**, WARNs as **OVER BUDGET**.

### 2c. Operating-Standard Enforcement

Assert the project's operating standard ("resolve it or don't report it" — the mission at the top of `CLAUDE.md`) is *enforced* through the agent tier, not merely declared. Run the deterministic checker:

```bash
node .claude/core/operating-standard.js
```

The current CLI scans installed Claude role projections and applies role-routed rules. Repair any underlying canonical source selected in Step 1 and render; the CLI result verifies that native surface:
- **Acting** agents (write code/docs) MUST load `verification-before-completion` in frontmatter **and** carry an `## Operating Standard` section.
- **Report-only** agents (`disallowedTools: Edit` — `code-reviewer`, `security-auditor`) MUST carry an `## Operating Standard` section in its **report-only** translation (exhaustive/precise/fix-ready findings, hand the orchestrator the fix). They are NOT required to load the skill — that would imply they write fixes.
- **`shadow`** is exempt — its prose persona is its convention (the documented Shadow exception); it carries the doctrine in its own idiom.

Exit code is 0 when clean, non-zero when any ERROR exists. Each ERROR (a dropped `## Operating Standard` section, or an acting agent missing the skill ref) is a silent doctrine regression. This audit is read-only by design, but the operating standard binds *this command too*: don't dead-end in a report — fold any output into Step 9's Issues Found as **DOCTRINE REGRESSION** and **fix it in place** (add the missing section or `verification-before-completion` skill ref to the named agent), then re-run the checker to confirm green.

### 2d. Frontmatter Skill Resolution

Assert every skill an agent declares in frontmatter **actually preloads**. Subagent `skills:` is *eager full-body injection* at startup (Claude Code native — `sub-agents.md`, "Preload skills into subagents": the full body is injected, firing NO `Read` event), so a broken ref fails **silently** — no runtime error, no telemetry signal, and the agent runs as if it had the knowledge. Run the deterministic checker:

```bash
node .claude/core/skill-resolution.js
```

The current CLI scans installed Claude frontmatter `skills:` against installed Claude skill directories and flags two silent failure modes. The canonical and Codex inventories remain the separate checks above:
- **BROKEN_SKILL_REF** — a listed skill has no installed `.claude/skills/<name>/SKILL.md` (typo, missing projection or renamed/removed source) → Claude preload loads nothing. Repair the selected canonical/legacy source and render.
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

### 2f. fs-safe Trust-Boundary Lint

Assert every raw filesystem write/delete in a module that crosses the adopter trust boundary (writes into a *target/adopter* directory, not a workshop-local path) is routed through the symlink-safe wrappers in `_lib/fs-safe.js` — the mechanical form of `[[fs-safe-hardening-needs-every-callsite-not-just-most]]`, which the `full-review-260716` retro's own fresh review pass re-discovered a THIRD time (fleet.js/publish.js's `pruneEmptyDirs`). Run the deterministic checker:

```bash
node .claude/core/fs-safe-lint.js
```

It scans a hardcoded fileset of the canonical `.agents/` sources — `core/install.js`, `core/template-updater.js`, `core/scaffold.js`, `core/_lib/{skill-merger,agent-merger,zone-copy,settings-merger,shared-agents,git-ignored}.js` — plus the workshop-only `tools/fleet.js`, `tools/publish.js` and `tools/sync-work.js` (skipped and counted when absent, as in an adopter): the confirmed adopter-trust-boundary-crossing modules, deliberately NOT `core/`/`hooks/`/`tools/`-wide (that would false-positive on the many legitimate workshop-local raw fs calls elsewhere, like gate.js reports or telemetry logs). The default run fails closed: a missing shipped entry is **MISSING_ENTRY** (ERROR), and an entry that is a generated compatibility wrapper or holds no filesystem call is **VACUOUS_ENTRY** (ERROR), because scanning it proves nothing. Applies two rules:

- **UNGUARDED_WRITE** (ERROR) — a raw `fs.writeFileSync`/`fs.copyFileSync`/`fs.cpSync` call with no `fs-safe-lint:local` marker on the line
- **UNGUARDED_DELETE** (ERROR) — a raw `fs.rmSync`/`fs.rmdirSync` call with no marker AND no `assertNoSymlinkedAncestor()` guard call within the preceding 6 lines (the established `pruneEmptyDirs` pattern)

Exit code is 0 when clean, 1 on any ERROR. Same operating standard as 2c/2d/2e: fold output into Step 9's Issues Found as **UNGUARDED FS CALL**, **fix it in place** (route through `safeWrite`/`safeCopy`/`safeDelete`, or add an `assertNoSymlinkedAncestor()` guard immediately before the delete — or, for a hand-verified workshop-local destination like `os.tmpdir()` scratch or `VERSION_PATH`, append a `fs-safe-lint:local` marker to that line), then re-run to confirm green. If a new module starts writing into an adopter tree, add it to `TRUST_BOUNDARY_FILES` in `fs-safe-lint.js`.

### 3. Scan Hook Inventory

```
Glob: .agents/hooks/*.cjs
# Compare installed .claude/.codex wrappers and each adapter registration.
```

Record executable handlers separately from shared libraries such as `secret-patterns.cjs`; a library is not an orphaned hook.

### 4. Scan Command Inventory

```
Glob: .agents/skills/*/references/workflow.md
# Use .agents/adapters/workflows.json and sanity-check generated command/skill entry points.
```

For each command, read the content and extract:
- Agent references (mentions of `subagent_type:` or agent names like `architect`, `code-reviewer`, etc.)
- Skill references (mentions of skill names or `SKILL.md`)

### 5. Read Settings

Read Claude `.claude/settings.json` and Codex `.codex/hooks.json` against their adapter metadata. Extract the installed event/handler wiring for each active runtime:
- Which hook files are registered under PreToolUse, PostToolUse, PreCompact
- Which matchers are configured

### 6. Cross-Reference Analysis

**6a. Agent wiring:**
- For each role: is it actually dispatched/read by a workflow or intentionally available for direct use (such as Shadow)? Only if neither → **ORPHANED**. Do not invent a workflow to register a valid direct-use role.
- Broken skill refs are now caught deterministically in Step 2d (`skill-resolution.js`) — don't re-derive them by eye here; just carry forward any **BROKEN SKILL REF** / **UNPRELOADABLE** findings it reported.

**6b. Skill wiring:**
- For each knowledge skill: is it loaded by frontmatter or explicitly read by a workflow/role body? Only if neither → **UNUSED SKILL**. Registered workflow selectors are evaluated as command wiring, not eager knowledge preloads.
- For each skill: is it referenced by at least one command? If not → **UNREFERENCED** (may be fine if agent-loaded only)

**6c. Hook wiring:**
- For each executable hook handler: is it registered by the relevant adapter/runtime? If not → **UNREGISTERED HOOK** only when that runtime promises the event. Shared libraries and intentionally unsupported runtime events are exempt.
- For each installed Claude/Codex hook registration: does the referenced file exist? If not → **MISSING HOOK FILE**

**6d. Command wiring:**
- For each command that references an agent: does the agent file exist? If not → **MISSING AGENT**
- For each command: does it have a matching skill registration entry? (informational only)

### 7. Read Template Version

Read canonical `.agents/config/version.json` when present and compare its rendered `.claude/version.json`; use the native marker as the legacy fallback:
- If found: extract `version`, `updated`, `changelog` fields
- If not found: set version to "unknown (pre-versioning)"

### 8. Score

Rate each category 0-10:

| Category | 10 (perfect) | 0 (broken) |
|----------|-------------|------------|
| **Agents** | Every role dispatched/read or intentionally direct-use; declared skill refs valid | Multiple orphans, broken refs |
| **Skills** | Knowledge wired by frontmatter/workflow/role-body reads; explicit selectors registered | Multiple unused skills |
| **Hooks** | Supported handlers/registrations resolve per runtime; libraries and documented omissions classified | Orphaned hooks, missing files |
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
