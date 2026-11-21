---
description: Audit .claude/ system health — orphaned agents, unused skills, missing hooks, broken wiring
---

<!-- Generated from .agents/skills/review-check-templates/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Check Templates

Self-diagnostic for the canonical `.agents/` sources and the installed Claude/Codex projections: find orphaned agents, skills, hooks and commands, broken cross-references and silent doctrine regressions, then score template health. A good result is a persisted, scored report whose findings are specific enough to act on, with every deterministic-checker failure repaired and re-verified.

## Telemetry (run first)

A user-typed command does not fire `PostToolUse:Skill`, so log the invocation yourself (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js review:check-templates
```

## Workflow

### 0. Check for --multi flag

If `$ARGUMENTS` contains `--multi`, run Steps 1-9 for the current project, then Step 10 (Cross-Project Scan). Otherwise run Steps 1-9 only.

### 1. Scan Agent Inventory

Read canonical `.agents/roles/*.md` first, plus legacy native roles that have no canonical equivalent. Identity and declared `skills` come from the source frontmatter. Actual tools, model and permission wiring come from the generated Claude frontmatter / Codex TOML and each runtime's project-owned `shared-agents.json`; those fields do not belong in canonical role frontmatter.

### 2. Scan Skill Inventory

Enumerate `.agents/skills/*/SKILL.md` (legacy native skills only where canonical sources are absent). Partition the inventory with `.agents/adapters/workflows.json`: registered explicit workflow selectors and conditional knowledge skills have different description and wiring contracts.

**CSO check.** Only conditional knowledge skills need a `Use WHEN` triggering clause. Registered workflow selectors intentionally use explicit-invocation descriptions; they are neither violations nor unused knowledge. This read-only check implements the partition (use the active runtime's helper prefix):

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

For a legacy-only installation use its actual knowledge inventory rather than inferring missing selector registration from an older layout. Flag genuine knowledge violations in Step 9.

### 2b. Skill Spec Conformance

Check skills against the Agent Skills open standard:

```bash
node .claude/core/skill-conformance.js
```

The CLI scans the installed Claude skill projections (compare Codex entry points through their adapter; the canonical inventory/CSO check above is separate):

- **Body budget**: `SKILL.md` over 500 lines is **WARN: OVER_BUDGET** (advisory; does not fail the gate).
- **Name match**: `name:` frontmatter differing from the parent directory is **ERROR: NAME_MISMATCH**.
- **Description length**: `description:` over 1024 characters is **ERROR: DESC_TOO_LONG**.

Exit is non-zero only on an ERROR. Every output line goes into Step 9's Issues Found: ERRORs as **SPEC VIOLATION**, WARNs as **OVER BUDGET**.

### 2c. Operating-Standard Enforcement

The project's operating standard ("resolve it or don't report it", the mission at the top of `CLAUDE.md`) has to be enforced through the agent tier, not just declared:

```bash
node .claude/core/operating-standard.js
```

The CLI scans installed Claude role projections:

- **Acting** agents (write code/docs) load `verification-before-completion` in frontmatter and carry an `## Operating Standard` section.
- **Report-only** agents (`disallowedTools: Edit`, e.g. `code-reviewer`, `security-auditor`) carry the section in its report-only translation (exhaustive, precise, fix-ready findings; hand the orchestrator the fix). They do not load the skill, which would imply they write fixes.
- **`shadow`** is exempt: its prose persona carries the doctrine in its own idiom.

Each ERROR (a dropped section, or an acting agent missing the skill) is a silent doctrine regression. The audit is read-only by design, but the standard binds this command too: record the output in Step 9 as **DOCTRINE REGRESSION**, fix it in place in the canonical source selected in Step 1 (add the section or the skill ref) and render, then re-run to confirm green.

### 2d. Frontmatter Skill Resolution

A subagent's `skills:` frontmatter is eager full-body injection at startup (Claude Code native, no `Read` event), so a broken ref fails silently: the agent runs without the knowledge and nothing reports it.

```bash
node .claude/core/skill-resolution.js
```

The CLI checks installed Claude frontmatter `skills:` against installed Claude skill directories:

- **BROKEN_SKILL_REF**: a listed skill has no installed `.claude/skills/<name>/SKILL.md` (typo, missing projection, renamed or removed source).
- **UNPRELOADABLE**: a listed skill sets `disable-model-invocation: true`, so preload silently skips it.

Same handling as 2c: record as **BROKEN SKILL REF**, fix in place (correct the agent frontmatter or restore the skill, in the canonical source, then render), re-run to green. Step 6 uses these results rather than re-deriving them.

### 2e. Path-Drift Lint

Path literals in prose and code must match the current resolvers (the mechanical form of the `migrate-all-readers-of-a-shared-path-in-one-wave` workflow memory):

```bash
node .claude/core/path-drift-lint.js
```

It scans the template fileset (`.claude/`, `tools/`, `docs/reference/`, `docs/engineering/`, root `CLAUDE.md`/`docs/CLAUDE.md`/`README.md`) plus the living plan (`docs/work/backlog.md`, `roadmap.md`; the rest of `docs/work/` is historical record and is not judged):

- **LEGACY_TOKEN** (ERROR): a pre-taxonomy `.output/…` token survives.
- **FLAT_HANDOFF** (ERROR): a literal or glob addresses a file directly under `handoffs/` with no `{YYYY-MM}` month segment; `handoff-path.js` writes month-bucketed, so a flat glob misses every current handoff.
- **UNKNOWN_COMPARTMENT** (WARN): a `docs/.output/<seg>` segment absent from `constants.js OUTPUT_PATHS`. Only a WARN because adopters grow compartments; in the workshop it usually means drift.

Exit is 1 on any ERROR. Record as **PATH DRIFT**, fix in place (update the literal to the resolver's current shape, or append a `path-lint:keep` marker to an intentional legacy example), re-run to green.

### 2f. fs-safe Trust-Boundary Lint

Every raw filesystem write or delete in a module that crosses the adopter trust boundary (writes into a target/adopter directory, not a workshop-local path) must go through the symlink-safe wrappers in `_lib/fs-safe.js`. Per `[[fs-safe-hardening-needs-every-callsite-not-just-most]]`, this class was re-discovered three times by review before it was made mechanical.

```bash
node .claude/core/fs-safe-lint.js
```

It scans a fixed fileset of canonical sources: `core/install.js`, `core/template-updater.js`, `core/scaffold.js`, `core/_lib/{skill-merger,agent-merger,zone-copy,settings-merger,shared-agents,git-ignored}.js`, plus the workshop-only `tools/fleet.js`, `tools/publish.js` and `tools/sync-work.js` (skipped and counted when absent, as in an adopter). It is deliberately not `core/`-wide, which would false-positive on legitimate workshop-local fs calls. The default run fails closed: a missing shipped entry is **MISSING_ENTRY** (ERROR); an entry that is a generated wrapper or holds no filesystem call is **VACUOUS_ENTRY** (ERROR), because scanning it proves nothing. Rules:

- **UNGUARDED_WRITE** (ERROR): a raw `fs.writeFileSync`/`fs.copyFileSync`/`fs.cpSync` with no `fs-safe-lint:local` marker on the line.
- **UNGUARDED_DELETE** (ERROR): a raw `fs.rmSync`/`fs.rmdirSync` with no marker and no `assertNoSymlinkedAncestor()` call within the preceding 6 lines (the `pruneEmptyDirs` pattern).

Exit is 1 on any ERROR. Record as **UNGUARDED FS CALL**, fix in place (route through `safeWrite`/`safeCopy`/`safeDelete`, or add an `assertNoSymlinkedAncestor()` guard right before the delete; for a hand-verified workshop-local destination such as `os.tmpdir()` scratch or `VERSION_PATH`, append a `fs-safe-lint:local` marker), re-run to green. When a new module starts writing into an adopter tree, add it to `TRUST_BOUNDARY_FILES` in `fs-safe-lint.js`.

### 3. Scan Hook Inventory

Glob `.agents/hooks/*.cjs` and compare the installed `.claude`/`.codex` wrappers and each adapter registration. Record executable handlers separately from shared libraries such as `secret-patterns.cjs`; a library is not an orphaned hook.

### 4. Scan Command Inventory

Glob `.agents/skills/*/references/workflow.md`, and use `.agents/adapters/workflows.json` to sanity-check the generated command/skill entry points. From each command extract the agent references (`subagent_type:` or role names) and skill references (skill names, `SKILL.md`).

### 5. Read Settings

Read Claude `.claude/settings.json` and Codex `.codex/hooks.json` against their adapter metadata. For each active runtime, extract which hook files are registered under PreToolUse, PostToolUse and PreCompact, and which matchers are configured.

### 6. Cross-Reference Analysis

**6a. Agent wiring.** A role is **ORPHANED** only if no workflow dispatches or reads it and it is not intentionally direct-use (such as Shadow); do not invent a workflow to register a valid direct-use role. Carry forward the **BROKEN SKILL REF** / **UNPRELOADABLE** findings from Step 2d.

**6b. Skill wiring.** A knowledge skill loaded by neither frontmatter nor an explicit workflow/role-body read is **UNUSED SKILL**. Registered workflow selectors are judged as command wiring, not eager preloads. A skill no command references is **UNREFERENCED** (fine if agent-loaded only).

**6c. Hook wiring.** An executable handler its runtime's adapter does not register is **UNREGISTERED HOOK**, only where that runtime promises the event; shared libraries and intentionally unsupported events are exempt. An installed registration whose file does not exist is **MISSING HOOK FILE**.

**6d. Command wiring.** A command that references an agent whose file does not exist is **MISSING AGENT**. A command without a matching skill registration entry is informational only.

### 7. Read Template Version

Read canonical `.agents/config/version.json` when present and compare it with the rendered `.claude/version.json` (the native marker is the legacy fallback). Extract `version`, `updated`, `changelog`; when absent, the version is "unknown (pre-versioning)".

### 8. Score

Rate each category 0-10; the health score is the sum (0-50):

| Category | 10 (perfect) | 0 (broken) |
|----------|-------------|------------|
| **Agents** | Every role dispatched/read or intentionally direct-use; declared skill refs valid | Multiple orphans, broken refs |
| **Skills** | Knowledge wired by frontmatter/workflow/role-body reads; explicit selectors registered | Multiple unused skills |
| **Hooks** | Supported handlers/registrations resolve per runtime; libraries and documented omissions classified | Orphaned hooks, missing files |
| **Commands** | All agent references valid | Missing agents referenced |
| **Settings** | Hook config complete and consistent | Broken registrations |

### 9. Report

Write the full report to `docs/.output/findings/reviews/{YYMMDD-HHMM}-template-health-check.md` first, then show the same content in chat.

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

Write the commit message to `docs/.output/.state/.commit-msg`:

```
docs: /review:check-templates — {score}/50, {N} issues found
```

Stage the report plus every file the Step 2 fixes and the render changed (specific files, per the Post-Command Commit Convention), then run:

```bash
git add docs/.output/findings/reviews/{YYMMDD-HHMM}-template-health-check.md
node .claude/core/commit.js
```

### 10. Cross-Project Scan (--multi only)

List the sibling directories of the project (`../`) and treat one as a sibling project when `../{dir}/.claude/version.json` is readable; read errors mean "version unknown". For each sibling:

- **Version**: `version` and `updated` from `../{project}/.claude/version.json`, or "unknown (pre-versioning)".
- **Inventory** (lightweight, no cross-reference analysis): counts of `.claude/agents/*.md`, `.claude/hooks/*.cjs` and `.claude/skills/*/SKILL.md`.
- **Status** against the Step 7 version, comparing major, then minor, then patch numerically: lower is `OUTDATED`, higher is `AHEAD`, equal is `CURRENT`, and either side "unknown (pre-versioning)" is `UNKNOWN`.

### 11. Cross-Project Report (--multi only)

Append this section to the Step 9 report:

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
