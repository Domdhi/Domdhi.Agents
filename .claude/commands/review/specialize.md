---
description: Specialize the generic .claude/ system for this project's tech stack and architecture
argument-hint: "[--dry-run | --fix | --report-only]"
---

# Specialize

Specialize the generic `.claude/` template system for **this project's** tech stack, patterns, and architectural decisions. Reads the filled-in planning docs and customizes agents, seeds the memory system, and audits skills for relevance.

**Idempotent** — safe to re-run. Agent context sections are replaced (not duplicated). Memories are only seeded into empty categories.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:specialize
```

## Variables

MODE: $ARGUMENTS (default: `--fix`)
- `--dry-run` — Report what would change without making changes
- `--fix` — Report AND apply changes (default)
- `--report-only` — Condensed report tables, no detail

## Workflow

### 0. Phase Gate

Verify the project is ready for specialization:

- Read `docs/architecture/overview.md` — **REQUIRED**: must exist and NOT be a template (`<!-- @@template -->`). The architecture doc is the load-bearing input — specialization extracts the tech stack, components, and risk map from it.
- Read `docs/work/backlog.md` — **OPTIONAL**: if it exists and is real, the risk map can use epic/story boundaries; if it is missing or a template, proceed in **architecture-only mode**.

**If `architecture/overview.md` is missing or a template:**

```
ABORT: /specialize requires a real docs/architecture/overview.md.
Run /onboard (brownfield) or /create:project-architecture (greenfield) first.
```

**Architecture-only mode (C7):** when the backlog is missing/template — the normal state right after `/onboard`, which deliberately defers the backlog to the create-chain — do **NOT** abort. Specialize the agents from the architecture doc (stack extraction, agent `## Project Context`, gate config, risk map all derive from architecture) and note in the report: *"backlog absent — backlog-derived refinements deferred; re-run `/review:specialize` after `/create:project-epics` to incorporate epic boundaries."* This is what lets `/onboard`'s chained specialize actually produce specialized agents instead of silently aborting.

### 1. Extract Project Tech Stack

Read `docs/architecture/overview.md` and dynamically extract the full tech stack. **Nothing is hardcoded** — parse whatever the architecture document contains.

**1a. Backend** — Parse `## Tech Stack > ### Backend` table:
```
| Layer | Technology | Version | Rationale |
```
Extract each row as `{layer, technology, version, rationale}`. Handle variable row counts.

**1b. Frontend** — Parse `### Frontend` table (same format). If section is absent or empty → project is backend-only. Set `FRONTEND = NONE`.

**1c. Database** — Parse `### Database` table:
```
| Role | Technology | Version | Rationale |
```
Roles may include Primary, Cache, Search, etc. Handle multiple databases.

**1d. Infrastructure** — Parse `### Infrastructure` table:
```
| Service | Technology | Rationale |
```

**1e. Authentication & Authorization** — Parse the auth section for:
- Provider (OAuth, JWT, session, API key, etc.)
- Flow (code flow, implicit, client credentials, etc.)
- Token type and storage
- Authorization model (RBAC, ABAC, claims-based)
- Roles and policies

**1f. Testing Strategy** — Parse `## Development Standards > ### Testing Strategy` table:
```
| Level | Framework | Coverage Target | Scope |
```
Extract for each tier (Unit, Integration, E2E).

**1g. Cross-Cutting Concerns** — Parse the cross-cutting section for:
- Logging framework and destinations
- Error handling strategy
- Caching approach
- Configuration source and secrets management
- Feature flag approach

**1h. ADRs** — Scan for ALL `### ADR-\d+:` headings (variable count — do NOT hardcode a range). For each, extract:
- Title, Status, Date
- Context, Decision, Alternatives, Consequences

**1i. Project Identity** — Read `docs/product/brief.md` for:
- Project name (from `# Project Brief: {name}` heading)
- Organization (if present)

**Placeholder detection:** If any extracted technology value contains `{` characters (unfilled template placeholders), abort:
```
ABORT: Architecture doc contains unfilled placeholders.
Found: {example placeholder values}
Run /create:project-architecture to fill in actual values first.
```

### 2. Specialize Agents

For each agent in `.claude/agents/*.md`:

1. Read the agent file
2. Match by agent `name` from the frontmatter
3. Select relevant tech stack slices based on name (see mapping below)
4. Append (or replace) a `## Project Context` section in the markdown body (after the frontmatter section)

**Name-to-tech-stack mapping:**

| Agent | Tech Stack Slices |
|-------|------------------|
| `product-strategist` | Project name, target users, key requirements summary |
| `architect` | Full stack, all ADRs, component architecture, cross-cutting concerns |
| `ux-designer` | Frontend tech, design patterns, accessibility standards |
| `project-planner` | Full stack summary, testing strategy, project phases |
| `general-purpose` | Full stack, project structure, coding conventions |
| `security-auditor` | Auth model, security-related NFRs from PRD, security ADRs |
| `qa-engineer` | Full testing strategy table, framework names, coverage targets |
| `code-reviewer` | Full stack, coding standards, architecture patterns |
| `doc-writer` | Project name, compact one-line tech stack summary |
| `playwright` | Frontend tech, test URLs, browser configuration |
| `shadow` | Project name, tech stack summary for technical writing context |

**Format to append to each agent file (after the `---` frontmatter closing):**

```markdown
## Project Context

> Specialized for {PROJECT_NAME} on {YYYY-MM-DD} by /specialize

### Tech Stack
- {technology} {version} — {layer/role} — why: {rationale from architecture doc's Rationale column}
- ...

### Key Patterns
- {pattern name}: {brief description from Component Architecture} — solves: {one-sentence problem statement this pattern addresses in this project}
- ...

### Relevant ADRs
- ADR-{NNN}: {title} — {decision summary} → consequence: {key consequence from the ADR's Consequences section}
- ...

### Conventions
- {relevant naming/coding standards from Development Standards section}
- ...
```

**Rationale sourcing:** All "why", "solves", and "consequence" annotations MUST be drawn from the architecture document (`docs/architecture/overview.md`) — specifically the Rationale columns, Component Architecture descriptions, and ADR Consequences sections. Do NOT invent rationale. If the architecture doc doesn't provide a rationale for a given item, use "—" instead of guessing.

**Idempotency and Soul Zone preservation:**
- Before appending, check if `## Project Context` already exists in the markdown body (after the `---` frontmatter)
- If found → **replace** everything from `## Project Context` to end of file with the new content
- **CRITICAL**: Do NOT touch anything above `## Project Context`. The content between the closing `---` of frontmatter and `## Project Context` is the agent's **Soul Zone** (managed by `/personalize`). Preserve it exactly as-is.
- If `## Project Context` does not exist → append after existing content (soul or thin instructions) with a blank line separator
- The `> Specialized for` marker line confirms this section was generated by `/specialize`
- In `--dry-run` mode, report "Would update" / "Would add" / "Already current"

### 2b. Create Stack-Specific Agents

Analyze the extracted tech stack and architecture to determine which **additional** specialized agents to create. This is dynamic — not a fixed list. Each distinct technology domain that represents meaningful specialization gets its own agent.

#### Discovery Process

1. **Scan the architecture doc** for technology domains that require deep expertise beyond what the 10 default agents cover. A domain qualifies if it has:
   - Its own section in the architecture doc (e.g., Database, Auth, Infrastructure, Real-time, API Gateway)
   - Specific patterns, conventions, or configuration that an implementation agent needs to know
   - Enough complexity that a generic agent would produce subpar results

2. **Check for overlap** — skip creating an agent if an existing default agent already covers the domain well enough. The default agents cover: product strategy, system architecture, UX design, project planning, security review, QA/testing, code review, documentation, browser automation, and technical writing.

3. **Name each agent** with a descriptive slug matching the domain (e.g., `db-architect`, `auth-builder`, `api-specialist`, `realtime-builder`, `state-manager`).

#### Common Specializations (create when architecture doc has the section)

| Architecture Section | Agent Name | Expertise | Skills |
|---------------------|-----------|-----------|--------|
| Database | `db-architect` | Schema design, migrations, query optimization, {specific DB technology} | `[]` |
| Auth | `auth-builder` | {Auth provider}, {flow type}, {authorization model}, token management | `[]` |
| Infrastructure | `config-setup` | {Infra stack}, deployment, environment configuration, CI/CD | `[]` |
| Frontend | `frontend-specialist` | {Framework} components, routing, state management, styling | `[brand-guidelines]` + `[tailwind-css-patterns]` if Tailwind |
| API / GraphQL / gRPC | `api-specialist` | Endpoint design, schema, middleware, versioning, {specific API technology} | `[]` |
| Real-time / WebSocket | `realtime-builder` | {Technology} connections, event handling, state sync | `[]` |
| Search / Elasticsearch | `search-specialist` | Index design, query DSL, relevance tuning, {search technology} | `[]` |
| Message Queue / Events | `event-architect` | {Technology} topics, consumers, dead letters, event schemas | `[]` |
| ML / AI Integration | `ml-integrator` | Model serving, prompt engineering, embedding pipelines, {ML technology} | `[]` |
| Monorepo / Build System | `build-engineer` | {Build tool} configuration, workspace management, dependency graph | `[]` |

**This table is a starting point, not a ceiling.** If the architecture doc contains a significant technology domain not listed above, create an agent for it. Use your judgment — if a developer would seek specialized help for that domain, it deserves an agent.

#### Frontend Skills Selection

When creating `frontend-specialist`:
- Always include `brand-guidelines` if `docs/design/spec.md` exists
- Add `tailwind-css-patterns` if the project uses Tailwind CSS
- Add other relevant skills from `.claude/skills/` that match the frontend stack

#### Agent File Format

Each created agent follows the official Claude Code format:
```yaml
---
name: {agent-name}
description: {what this agent does, when to use it — specific enough for Claude auto-delegation}
tools: Read, Write, Edit, Bash, Grep, Glob
skills: []  # Override per agent-specific needs above
memory: project
---

# {Agent Title}

{System prompt with project-specific expertise. Include:
- The specific technologies and versions from the architecture doc
- Key patterns and conventions for this domain
- Relevant ADRs that affect this domain
- Common pitfalls and best practices
- How this domain integrates with other parts of the system}
```

**Rules:**
- Only create agents that don't already exist (check by `name` in frontmatter)
- These agents are **project-specific** — they embed actual technology details in their prompt body, unlike default agents which get a `## Project Context` appendix
- The `description` field must be specific enough for Claude to auto-delegate correctly (e.g., "PostgreSQL schema design, migrations, and query optimization" not just "database work")
- Include `memory: project` so the agent accumulates domain knowledge across sessions

### 2c. Configure Build & Test Gate

`gate.js` auto-detects the project's build system. If the project needs overrides (e.g., a custom build command, or aligning the gate's bar to the project's real CI), create `.claude/gate.config.json`. **The schema is nested** — `gate.js` reads `config.build.command` / `config.test.command` (NOT flat strings). A flat `{"build": "npm run build"}` makes the gate run `Building... (undefined)` and fail (C14):

```json
{
  "build": { "command": "npm run build", "timeout": 300000 },
  "test":  { "command": "npm test", "timeout": 600000 },
  "stack": "node"
}
```

(For a Python project whose CI is ruff+pytest without mypy, e.g.: `"build": { "command": ".venv/bin/ruff check src tests" }`, `"test": { "command": ".venv/bin/pytest" }`, `"stack": "python"`.)

**Skip** if `gate.js` auto-detection already works for this stack (run `node .claude/core/gate.js build` to verify). Only create `gate.config.json` when the default detection is wrong or incomplete.

### 2d. Generate Risk Map for Code Reviewer

Analyze the architecture document's **Component Architecture** and **Cross-Cutting Concerns** sections to generate a directory-level risk map. The risk map tells the `code-reviewer` agent which areas of the codebase require deep vs. light review.

#### Risk Tier Definitions

| Tier | Criteria | Examples |
|------|----------|---------|
| **HIGH** | Authentication, authorization, payment processing, cryptography, data access layers, security middleware, secrets management | `auth/`, `middleware/auth`, `payments/`, `crypto/`, `data/repositories/` |
| **MEDIUM** | Business logic, API controllers, state management, service layers, domain models | `services/`, `controllers/`, `api/`, `domain/`, `handlers/` |
| **LOW** | Configuration, documentation, tests, utilities, static assets, build scripts, type definitions | `config/`, `docs/`, `tests/`, `utils/`, `assets/`, `types/` |

#### Classification Algorithm

1. **Parse Component Architecture** — For each component in `## Component Architecture`:
   - Extract the component's responsibility description
   - Map to risk tier based on responsibility keywords:
     - Contains "auth", "security", "credential", "permission", "encrypt", "payment", "sensitive data" → **HIGH**
     - Contains "business logic", "api", "controller", "service", "handler", "state", "domain" → **MEDIUM**
     - Contains "config", "utility", "helper", "test", "doc", "asset", "type", "build" → **LOW**
   - Extract the component's directory path from the architecture doc's project structure

2. **Parse Cross-Cutting Concerns** — For each concern:
   - "Error handling" modules → **MEDIUM**
   - "Logging" modules → **LOW**
   - "Caching" modules → **MEDIUM**
   - "Security" / "Auth" modules → **HIGH**

3. **Generate path patterns** — Convert component paths to glob-style patterns for matching (e.g., `src/auth/**` → HIGH)

#### Output Format

Append a `### Risk Map` subsection inside the `code-reviewer` agent's `## Project Context` section:

```markdown
### Risk Map

> Generated by /specialize on {YYYY-MM-DD}. Based on component architecture analysis.

| Path Pattern | Risk Tier | Reason |
|-------------|-----------|--------|
| {path pattern} | {HIGH/MEDIUM/LOW} | {component name or responsibility} |
| ... | ... | ... |

**Default tier**: MEDIUM (for files not matching any pattern)
```

**Placement:** The risk map is appended **within** the `code-reviewer` agent's `## Project Context` section (after `### Conventions`). If the agent has no `## Project Context` yet, create one with just the risk map.

**Idempotency:** If `### Risk Map` already exists within the code-reviewer's Project Context, replace it. Do not duplicate.

**`--dry-run` mode:** Report "Would generate risk map with {N} entries" without writing.

#### Report Section

Add a `### Risk Map` row to the Specialization Report:

```markdown
### Risk Map

| Tier | Path Patterns | Count |
|------|--------------|-------|
| HIGH | {patterns} | {N} |
| MEDIUM | {patterns} | {N} |
| LOW | {patterns} | {N} |
| Default | (unmatched files) | MEDIUM |
```

### 3. Audit & Generate Skills

For each skill in `.claude/skills/*/SKILL.md`:

**3a. Read the skill's description** (first 5-10 lines for name and purpose).

**3b. Classify against the extracted tech stack:**

- **relevant** — Skill is tech-agnostic (planning/review skills like `project-planning`, `architecture`, `ux-design`, `code-review`, `qa-engineer`) OR skill's technology is in the project's tech stack
- **not-applicable** — Skill teaches a specific technology NOT used in this project (e.g., `tailwind-css-patterns` when project doesn't use Tailwind)
- **needs-framework-skill** — Project uses a technology that has no corresponding skill

**3c. Gap detection:**

For each technology in Backend, Frontend, Database, and Testing:
1. Check if any skill's name or description mentions that technology (case-insensitive)
2. If no skill covers it AND it's an implementation framework (not just a language):
   - Flag as gap: `{tech-slug}-patterns` for `{technology} {version}`

**This step does NOT modify or delete existing skills.** It classifies and identifies gaps.

> **Marker rule.** If you ever add project-specific guidance to an existing *template* skill (rather than creating a new project skill in 3d), it MUST use a project-additions sentinel — plain edits to template prose are clobbered on the next `template-updater`/`fleet:sync`. A whole new section appended at the end → `<!-- @@project-additions -->` (create it if absent), everything below preserved. A bullet or paragraph inserted INSIDE an existing section (e.g. adding a project-specific escalation rule to `code-review/SKILL.md`'s existing rule list, or a stack-specific test pattern to `qa-engineer/SKILL.md`'s existing patterns) → wrap it in an anchored `<!-- @@project-additions:start -->` / `:end` fence instead — the whole-tail marker cannot protect content injected mid-section. Prefer a brand-new project-added skill dir for substantial content; new skill dirs are never touched by sync. Full doctrine + rules: `skill-authoring`.

### 3d. Generate Stack Skills

For each gap identified in 3c, create a new skill. In `--dry-run` mode, report "Would create" and skip.

#### Discovery Rules

Not every technology needs a skill. A skill is warranted when the technology has:
- **Framework-specific patterns** — conventions that a developer needs to learn (e.g., React hooks, Django views, EF Core migrations)
- **Configuration complexity** — non-trivial setup that varies per project (e.g., Tailwind themes, Webpack config, Docker Compose)
- **Project-specific conventions** — patterns decided in the architecture doc that override defaults (e.g., "always use server components", "repository pattern for data access")

Skip skill creation for:
- **Languages** without a framework (plain TypeScript, Python, Go — the language itself doesn't need a skill)
- **Simple libraries** with no project-specific patterns (lodash, moment, uuid)
- **Infrastructure services** where the agent prompt covers it (Redis as cache, S3 for storage — unless the architecture doc defines specific patterns)

#### Delegation

For each skill to create, delegate to the `architect` agent via Task tool with `subagent_type: "architect"`.

**Task prompt must include:**
1. Technology name and version from the architecture doc
2. Output path: `.claude/skills/{tech-slug}-patterns/SKILL.md`
3. Project-specific patterns and conventions from the architecture doc sections that mention this technology
4. Relevant ADRs that affect this technology
5. How this technology integrates with other parts of the stack
6. Instruction to read an existing tech-specific skill (e.g., `.claude/skills/tailwind-css-patterns/SKILL.md`) as a format exemplar

#### Skill File Format

Every generated skill must follow this structure:

```yaml
---
name: {tech-slug}-patterns
description: "{Technology} {version} patterns, conventions, and best practices. Use when {trigger scenarios — specific enough for Claude auto-loading}."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---
```

```markdown
# {Technology} Development Patterns

## Overview
{Brief description: what the technology is, how it's used in this project, version-specific features}

## When to Use
{Bullet list of scenarios where this skill applies}

## Project Conventions
{Project-specific patterns from the architecture doc — this is the highest-value section}
- {Convention 1 from architecture doc or ADRs}
- {Convention 2}
- ...

## Instructions
{Numbered steps for using this technology correctly in this project}

## Common Patterns
{Code examples showing idiomatic usage — framework-specific patterns, not generic}

### {Pattern Name}
{Code example with explanation}

### {Pattern Name}
{Code example with explanation}

## Constraints and Warnings
{Gotchas, anti-patterns, version-specific pitfalls, things the architecture doc explicitly prohibits}

## Best Practices
{Numbered list — mix of general framework best practices and project-specific rules}

## Configuration
{Project-specific configuration — from architecture doc's infrastructure/setup sections}
```

#### Quality Rules

- **Project-specific > Generic**: The "Project Conventions" section is the most important — it captures decisions from the architecture doc. Generic framework knowledge is supplementary.
- **Code examples must use the project's actual patterns**: If the architecture doc specifies repository pattern, show that — not raw SQL.
- **Version-aware**: Include version-specific features and deprecation warnings for the exact version in the tech stack.
- **Cross-reference ADRs**: If an ADR affects how this technology is used, cite it (e.g., "Per ADR-003, use server components by default").
- **No overlap with existing skills**: If `tailwind-css-patterns` already exists, don't create a `css-patterns` skill that covers the same ground.

#### Idempotency

- Check if `.claude/skills/{tech-slug}-patterns/SKILL.md` already exists before creating
- If it exists → skip (report "Already exists"). To regenerate, user must delete the skill directory first.
- This prevents overwriting skills that have been manually customized during implementation.

### 3e. Wire Skills into Agents

After creating new skills, update the `skills:` frontmatter of relevant agents to reference them.

**Matching rules:**
- **Stack-specific agents** (created in step 2b) get skills for their domain automatically — the skill was created for the same technology
- **Default agents** get new skills based on role relevance:

| Agent | Gets Skills For |
|-------|----------------|
| `code-reviewer` | All stack skills (needs to review code in any technology) |
| `qa-engineer` | Testing framework skills + backend/frontend framework skills |
| `architect` | All stack skills (needs to validate architecture compliance) |
| `frontend-specialist` | Frontend framework + CSS + state management skills |
| `security-auditor` | Auth-related skills + backend framework skills |

**Update process:**
1. Read the agent file
2. Parse the `skills:` list from frontmatter
3. Add new skill names (if not already present)
4. Write the updated frontmatter
5. **Do NOT touch** anything below the frontmatter closing `---`

In `--dry-run` mode, report "Would add {skill} to {agent}" without writing.

### 4. Seed Memory System

**4a. Ensure directory structure** (if MODE is `--fix`):

Create the directories for **all five** memory categories under `docs/.output/.memory/` (missing any one — e.g. `rejected-approaches` — hard-errors later tools that iterate the full category set):
```bash
for c in patterns constraints decisions workflows rejected-approaches; do
  mkdir -p "docs/.output/.memory/$c"
done
```

**4b. Seed ADR decisions** (only if `decisions/` contains no `.json` files):

For each ADR extracted in Step 1h:

```bash
node .claude/core/memory-manager.js create decisions "adr-{NNN}" '{
  "title": "ADR-{NNN}: {Title}",
  "decision": "{Decision text}",
  "rationale": "{Context text}",
  "consequence": "{Consequences text}",
  "source": "docs/architecture/overview.md",
  "tags": ["{dynamically extracted tags}"],
  "confidence": 0.9
}'
```

**Tag extraction:** Cross-reference the ADR's text against the tech stack model. If the ADR mentions a technology that appears in the extracted tech stack, add it as a tag (lowercased, hyphenated). Also add domain tags like "auth", "data", "infra" based on content.

**4c. Seed architectural patterns** (only if `patterns/` contains no `.json` files):

For each component from the `## Component Architecture` section and each concern from `## Cross-Cutting Concerns`:

```bash
node .claude/core/memory-manager.js create patterns "{component-slug}" '{
  "title": "{Component Name}",
  "description": "{Responsibility}",
  "technology": "{Technology}",
  "source": "docs/architecture/overview.md",
  "tags": ["{relevant tech tags}"],
  "confidence": 0.9
}'
```

**4d. Run memory health check** (if script exists):

```bash
node .claude/core/memory-health-check.js
```

**Confidence guide** (include in report):

| Source | Confidence | Set By |
|--------|-----------|--------|
| Architecture-documented (ADRs, patterns) | 0.9 | `/specialize` |
| Retro-validated pattern | 0.8 | `/retro` |
| Proven in implementation | 0.7 | `/do` |
| New pattern from story | 0.6 | `/do` |
| Session observation or workaround | 0.5 | manual |

### 5. Verify Command Integration

Check each implementation command for proper memory API usage:

**For each command, Grep for:**
1. `memory-manager.js` — proper API usage (CLI calls)
2. `Glob: docs/.output/.memory/` — raw Glob pattern (should prefer API)
3. `Check docs/.output/.memory/` — vague text mention (should be actual CLI call)

**Integration status:**
- **INTEGRATED** — Uses `memory-manager.js` CLI for both reads and writes
- **PARTIAL** — Has some API usage but also raw Glob or text mentions
- **NOT_INTEGRATED** — No memory API usage at all

**Commands to check:**

| Command | File | Should Read | Should Write |
|---------|------|------------|-------------|
| `/do` | `commands/do.md` | Yes (planning + pre-delegation) | Yes (post-implementation patterns) |
| `/run-todo` | `commands/run-todo.md` | Yes (wave planning) | Yes (post-wave patterns) |
| `/review:code-review` | `commands/review/code-review.md` | Yes (load standards) | No |
| `/retro` | `commands/retro.md` | Yes (gather data) | Yes (extract patterns) |
| `/prime` | `commands/prime.md` | Yes (load context) | No |
| `/end` | `commands/end.md` | Yes (memory summary) | No |

This step does NOT auto-fix command files — it flags issues for manual action.

### 6. Commit (main agent)

Follow the **Post-Command Commit Convention** in CLAUDE.md. Stage all files created or modified by this command and commit with a descriptive message.

### 7. Report

```markdown
## Specialization Report

### Run Mode: {--fix / --dry-run / --report-only}
### Date: {YYYY-MM-DD}
### Project: {PROJECT_NAME}
### Tech Stack: {one-line summary — e.g., "Python 3.12 + Django 5.1 + PostgreSQL 16 + React 19"}

---

### Extracted Tech Stack

#### Backend
| Layer | Technology | Version |
|-------|-----------|---------|
| {layer} | {technology} | {version} |

#### Frontend
| Layer | Technology | Version |
|-------|-----------|---------|
| {layer} | {technology} | {version} |
{or "N/A — backend-only project"}

#### Database
| Role | Technology | Version |
|------|-----------|---------|
| {role} | {technology} | {version} |

#### Infrastructure
| Service | Technology |
|---------|-----------|
| {service} | {technology} |

#### Auth: {provider} via {flow}, {model} authorization
#### Testing: {frameworks summary with coverage targets}
#### ADRs Found: {count}

---

### Agent Specialization

#### Default Agents ({count} updated with Project Context)

| Agent | Action | Context Summary |
|-------|--------|----------------|
| {agent-name} | {Added/Updated/Would add/Skipped} | {summary of what context was added} |
| ... | ... | ... |

#### Stack-Specific Agents Created ({count} from architecture analysis)

| Agent | Domain | Technology | Status |
|-------|--------|-----------|--------|
| {name} | {domain from architecture} | {specific tech} | {Created/Already exists/Would create} |
| ... | ... | ... | ... |

{Or "No stack-specific agents needed — default agents cover all domains"}

#### Build & Test Gate
| Script | Toolchain | Status |
|--------|----------|--------|
| gate.js | {detected build/test tools} | {Already exists — auto-detects project type} |

#### Risk Map

| Tier | Path Patterns | Count |
|------|--------------|-------|
| HIGH | {patterns} | {N} |
| MEDIUM | {patterns} | {N} |
| LOW | {patterns} | {N} |
| Default | (unmatched files) | MEDIUM |

---

### Skills Audit

| Skill | Classification | Reason |
|-------|---------------|--------|
| {skill-name} | {relevant / not-applicable / needs-framework-skill} | {why} |

#### Stack Skills Generated ({count} from gap detection)

| Skill | Technology | Version | Status |
|-------|-----------|---------|--------|
| {tech-slug}-patterns | {Technology} | {version} | {Created / Already exists / Would create / Skipped (no patterns needed)} |
| ... | ... | ... | ... |

{Or "No stack skills needed — all project technologies have corresponding skills"}

#### Skill Wiring

| Agent | Skills Added | Total Skills |
|-------|-------------|-------------|
| {agent-name} | +{skill-1}, +{skill-2} | {total count} |
| ... | ... | ... |

{Or "No skill wiring changes needed"}

---

### Memory System

| Check | Status | Details |
|-------|--------|---------|
| patterns/ directory | {Created / Existed / Would create} | {count} files |
| constraints/ directory | {Created / Existed / Would create} | {count} files |
| decisions/ directory | {Created / Existed / Would create} | {count} files |
| workflows/ directory | {Created / Existed / Would create} | {count} files |
| ADR seeding | {Seeded {N} / Already populated / Would seed {N}} | {ADR numbers} |
| Pattern seeding | {Seeded {N} / Already populated / Would seed {N}} | {pattern names} |
| Health check | {Passed / Warnings / Failed / Skipped} | {details} |

**Memory totals**: {N} memories across {N} categories, avg confidence {0.X}

**Confidence guide:**
- 0.9 — Architecture-documented (seeded by `/specialize`)
- 0.8 — Retro-validated (promoted by `/retro`)
- 0.7 — Proven in implementation (written by `/do`)
- 0.6 — New from story (written by `/do`)
- 0.5 — Session observation (manual)

---

### Command Integration

| Command | Reads Memories | Writes Memories | Status |
|---------|---------------|-----------------|--------|
| /do | {API / Glob / None} | {API / None} | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /run-todo | {API / None} | {API / None} | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /review:code-review | {API / None} | N/A | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /retro | {API / None} | {API / None} | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /prime | {API / None} | N/A | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /end | {API / None} | N/A | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |

---

### Memory Lifecycle

```
/specialize → seeds decisions (0.9) + patterns (0.9) from architecture
/do         → reads patterns during planning, writes new patterns (0.6–0.7) post-task
/retro      → reads all, promotes confidence (→ 0.8), writes validated patterns
```

---

### Manual Actions Required
{Numbered list of items that cannot be auto-fixed, with file paths and recommendations}

### Recommended Next Steps
{Ordered list based on findings — typically: create missing framework skills, fix partial integrations, then begin /do}
```

## When to Run

- **During project setup**: After `/check-readiness` passes
- **After architecture changes**: When tech stack or ADRs are updated
- **Before a new epic**: To refresh agent context with any architectural evolution
- **On-demand**: When implementation feels misaligned with architecture
