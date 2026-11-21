---
name: review-specialize
description: "Use WHEN specializing shared agents for a project's tech stack and architecture. Triggers: specialize, project setup, agent project context, stack skills."
---

<!-- Generated from .agents/skills/review-specialize/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Specialize

Specialize the shared agent system for this project's tech stack, patterns and architectural decisions. A good run leaves every agent carrying accurate project context that cites the architecture doc, memory seeded with the architecture's decisions and patterns, a risk map the code reviewer can use, and a clear audit of which skills fit the stack and which are missing.

The run is idempotent: agent context sections are replaced, never duplicated, and memories are seeded only into empty categories.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill`; without a self-log, fleet analytics under-count human-driven runs. Log the invocation before anything else, best-effort (continue if it fails):

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

- `docs/architecture/overview.md` is required and must not be a template (`<!-- @@template -->`). It is the load-bearing input: the tech stack, components and risk map all come from it.
- `docs/work/backlog.md` is optional. When it is real, the risk map can use epic and story boundaries; when it is missing or a template, proceed in architecture-only mode.

If `architecture/overview.md` is missing or a template, stop:

```
ABORT: /specialize requires a real docs/architecture/overview.md.
Run /create:project-architecture first (for a brownfield repo, /onboard if installed).
```

**Architecture-only mode (C7).** A missing or template backlog is the normal state right after brownfield onboarding, which defers the backlog to the create-chain, so do not abort. Specialize from the architecture doc alone (stack, agent `## Project Context`, gate config and risk map all derive from it) and note in the report: *"backlog absent — backlog-derived refinements deferred; re-run `/review:specialize` after `/create:project-epics` to incorporate epic boundaries."*

### 1. Extract Project Tech Stack

Read `docs/architecture/overview.md` and extract the stack from whatever it contains; nothing is hardcoded. Handle variable row counts.

- **Backend**: the `## Tech Stack > ### Backend` table, `| Layer | Technology | Version | Rationale |`, as `{layer, technology, version, rationale}`.
- **Frontend**: the `### Frontend` table, same shape. Absent or empty means backend-only: set `FRONTEND = NONE`.
- **Database**: `### Database`, `| Role | Technology | Version | Rationale |`. Roles include Primary, Cache, Search and so on; there may be several.
- **Infrastructure**: `### Infrastructure`, `| Service | Technology | Rationale |`.
- **Auth**: provider, flow, token type and storage, authorization model (RBAC, ABAC, claims) and the roles and policies.
- **Testing strategy**: `## Development Standards > ### Testing Strategy`, `| Level | Framework | Coverage Target | Scope |`, per tier.
- **Cross-cutting concerns**: logging, error handling, caching, configuration and secrets, feature flags.
- **ADRs**: every `### ADR-\d+:` heading (the count varies, so do not hardcode a range), with title, status, date, context, decision, alternatives and consequences.
- **Project identity**: from `docs/product/brief.md`, the name (the `# Project Brief: {name}` heading) and the organization if present.

**Placeholder detection.** If any extracted technology value contains `{` (an unfilled placeholder), stop:

```
ABORT: Architecture doc contains unfilled placeholders.
Found: {example placeholder values}
Run /create:project-architecture to fill in actual values first.
```

### 2. Specialize Agents

Use `.agents/roles/*.md` for each role whose canonical source exists; otherwise use the legacy `.claude/agents/*.md`. Never edit a generated native role. After canonical edits run `node .claude/core/render-shared-agents.js` to refresh both runtimes. Native model and tool settings belong in `.claude/shared-agents.json` or `.codex/shared-agents.json`, not the canonical role.

Match each role by its frontmatter `name`, pick its slice of the stack from the mapping below, and append (or replace) a `## Project Context` section at EOF, after the existing Skills and operating sections.

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

Section format:

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

**Rationale sourcing.** Every "why", "solves" and "consequence" comes from the architecture doc (Rationale columns, Component Architecture descriptions, ADR Consequences). Do not invent rationale; where the doc gives none, write "—".

**Idempotency and Soul Zone.** If `## Project Context` already exists in the body, replace everything from it to EOF; otherwise append after the existing content with a blank line. Never touch anything above `## Project Context`: the content between the closing frontmatter `---` and that heading is the agent's Soul Zone, managed by `/personalize`, and is preserved exactly. The `> Specialized for` line marks the section as generated by `/specialize`. In `--dry-run`, report "Would update" / "Would add" / "Already current".

### 2b. Create Stack-Specific Agents

Beyond the default agents (product strategy, architecture, UX, planning, security, QA, code review, documentation, browser automation, technical writing), create an agent for each technology domain that has its own architecture section, project-specific patterns or configuration an implementer must know, and enough complexity that a generic agent would do it poorly. Skip a domain a default agent already covers well. Name each with a descriptive slug (`db-architect`, `auth-builder`, `api-specialist`).

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

The table is a starting point, not a ceiling: a significant domain not listed still deserves an agent if a developer would seek specialized help for it.

For `frontend-specialist`, include `brand-guidelines` when `docs/design/spec.md` exists, `tailwind-css-patterns` only when the project uses Tailwind, and any other installed skill matching the frontend stack.

Create new shared roles in `.agents/roles/{agent-name}.md`; the renderer emits the native roles:

```yaml
---
name: {agent-name}
description: {what this agent does, when to use it — specific enough for role selection}
skills: []  # Override per agent-specific needs above
---

# {Agent Title}

{System prompt with project-specific expertise: the technologies and versions from the
architecture doc, key patterns and conventions, relevant ADRs, common pitfalls, and how
this domain integrates with the rest of the system}
```

- Create only agents that do not already exist (check by frontmatter `name`).
- Unlike default agents, these are project-specific: they embed the actual technology details in the prompt body rather than getting a `## Project Context` appendix.
- Make the `description` specific enough for role selection ("PostgreSQL schema design, migrations, and query optimization", not "database work").
- Runtime model, tool and memory settings go in the native `shared-agents.json` adapter (for Claude, `memory: project`). Render after adding a role.

### 2c. Configure Build & Test Gate

`gate.js` auto-detects the build system. Skip this step when detection already works for the stack (check with `node .claude/core/gate.js build`). When detection is wrong or incomplete, author `.agents/gate.config.json` and render the helper's `.claude/gate.config.json`; the config is project-owned and either runtime uses it. The schema is nested: `gate.js` reads `config.build.command` and `config.test.command`, and a flat `{"build": "npm run build"}` makes the gate fail (C14):

```json
{
  "build": { "command": "npm run build", "timeout": 300000 },
  "test":  { "command": "npm test", "timeout": 600000 },
  "stack": "node"
}
```

(A Python project whose CI is ruff plus pytest without mypy, for example: `"build": { "command": ".venv/bin/ruff check src tests" }`, `"test": { "command": ".venv/bin/pytest" }`, `"stack": "python"`.)

Adopter build, test and PR gates run application checks only, including after agent-file edits. Never add an automatic or conditional toolkit suite. Mark an absent lint leg `"lint": { "missing": true }` and keep genuine application lint. Preserve application coverage, integration-isolation filters, security and preflight checks and gate locking. Application tests named Core remain application tests. Agent-system tests run in Domdhi.Agents only.

**Runtime and verification.** In an adopter, `gate.js` runs the application's own build, test and lint commands and never the Domdhi.Agents toolkit suite; in Domdhi.Agents itself it runs the toolkit's Node build and Vitest suite. In Codex, run each `.claude/core/` command here (telemetry, `gate.js`, `memory-manager.js`, `render-shared-agents.js`) as `.codex/core/` with the same arguments, and delegate roles as `.agents/adapters/codex/execution.md` describes. Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran: claim completion only from the updated canonical roles and skills, a renderer run that leaves no drift, the Step 7 report and the Step 6 commit hash.

### 2d. Generate Risk Map for Code Reviewer

From the architecture doc's Component Architecture and Cross-Cutting Concerns, build a directory-level risk map that tells `code-reviewer` where to review deeply and where lightly. Classify each component by what it is responsible for, and map it to its directory path in the doc's project structure.

| Tier | Criteria | Examples |
|------|----------|---------|
| **HIGH** | Authentication, authorization, payment processing, cryptography, data access layers, security middleware, secrets management | `auth/`, `middleware/auth`, `payments/`, `crypto/`, `data/repositories/` |
| **MEDIUM** | Business logic, API controllers, state management, service layers, domain models | `services/`, `controllers/`, `api/`, `domain/`, `handlers/` |
| **LOW** | Configuration, documentation, tests, utilities, static assets, build scripts, type definitions | `config/`, `docs/`, `tests/`, `utils/`, `assets/`, `types/` |

Cross-cutting concerns follow the same logic: security and auth modules are HIGH, error handling and caching MEDIUM, logging LOW. Convert component paths to glob patterns (`src/auth/**` → HIGH).

Append a `### Risk Map` subsection inside the `code-reviewer` agent's `## Project Context`, after `### Conventions` (create the Project Context with just the risk map if the agent has none yet):

```markdown
### Risk Map

> Generated by /specialize on {YYYY-MM-DD}. Based on component architecture analysis.

| Path Pattern | Risk Tier | Reason |
|-------------|-----------|--------|
| {path pattern} | {HIGH/MEDIUM/LOW} | {component name or responsibility} |
| ... | ... | ... |

**Default tier**: MEDIUM (for files not matching any pattern)
```

**Fast-iterating product (optional).** When the architecture doc or brief says the product is a game, prototype or other fast-iterating domain, add a `Fast-iterating: yes — {reason}` line to the Risk Map and list its contract surfaces (for a game: seeded RNG and determinism, update ordering, currency, pause and modal state, lifecycle and disposal, persistence). The marker and its surfaces are advice for reviewers and people: `/todo` does not read it (its Pin contracts, not tuning rule applies in every project). Do not infer it from the stack alone; when the docs do not say, omit the line and note in the report that the owner can add it.

If `### Risk Map` already exists in the code-reviewer's Project Context, replace it. In `--dry-run`, report "Would generate risk map with {N} entries" without writing. Add this to the Specialization Report:

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

For each skill in `.agents/skills/*/SKILL.md`, plus legacy `.claude/skills/*/SKILL.md` with no canonical equivalent, read its name and purpose and classify it against the extracted stack:

- **relevant**: tech-agnostic (planning, review, `qa-engineer` and similar) or its technology is in the stack.
- **not-applicable**: teaches a technology this project does not use (`tailwind-css-patterns` without Tailwind).
- **needs-framework-skill**: the project uses a technology with no corresponding skill.

Gap detection: for each technology in Backend, Frontend, Database and Testing, check whether any skill's name or description mentions it (case-insensitive). If none does and it is an implementation framework rather than just a language, flag a gap: `{tech-slug}-patterns` for `{technology} {version}`. This step classifies and finds gaps; it never modifies or deletes an existing skill.

> **Marker rule.** Project-specific guidance added to an existing template skill goes in its `.agents/skills` canonical source (the legacy `.claude/skills` source only when no canonical one exists), never its generated native copy, and must use a project-additions sentinel; plain edits to template prose are clobbered on the next `template-updater` or `fleet:sync`. A whole new section at the end uses `<!-- @@project-additions -->` (create it if absent; everything below is preserved). A bullet or paragraph inside an existing section (a project-specific escalation rule in `code-review/SKILL.md`'s rule list, a stack-specific test pattern in `qa-engineer/SKILL.md`'s patterns) is wrapped in an anchored `<!-- @@project-additions:start -->` / `:end` fence, because the whole-tail marker cannot protect mid-section content. Prefer a brand-new project-added skill directory for substantial content; sync never touches new skill directories. Full doctrine: `skill-authoring`.

### 3d. Generate Stack Skills

Create a skill for each gap worth filling (in `--dry-run`, report "Would create" and skip). A technology earns a skill when it has framework-specific patterns a developer must learn (React hooks, Django views, EF Core migrations), configuration complexity that varies per project (Tailwind themes, Webpack, Docker Compose), or project-specific conventions the architecture doc sets that override defaults ("server components by default", "repository pattern for data access"). Skip plain languages, simple libraries with no project patterns (lodash, uuid), and infrastructure services the agent prompt already covers (Redis as a cache, S3 for storage) unless the architecture doc defines specific patterns.

Delegate each skill to the `architect` role through the runtime's delegation mechanism; if the role or delegation is unavailable, the main agent does the same work. The task prompt includes:

1. Technology name and version from the architecture doc
2. Output path `.agents/skills/{tech-slug}-patterns/SKILL.md`
3. The project-specific patterns and conventions from the architecture sections that mention the technology
4. Relevant ADRs
5. How the technology integrates with the rest of the stack
6. An installed tech-specific skill under `.agents/skills/` (for example `tailwind-css-patterns` when installed) to read as a format exemplar
7. The verified project constraints and architecture conventions loaded in Step 2, with the instruction to cite their source paths rather than restate them

Generated skills use this structure:

```yaml
---
name: {tech-slug}-patterns
description: "{Technology} {version} patterns, conventions, and best practices. Use when {trigger scenarios — specific enough for runtime skill discovery}."
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

Project Conventions is the section that matters most: it captures the architecture doc's decisions, and generic framework knowledge is supplementary. Examples use the project's actual patterns (the repository pattern if that is the decision, not raw SQL), are version-aware for the exact version in the stack, cite the ADRs that shape usage ("Per ADR-003, use server components by default"), and do not duplicate an existing skill's ground.

Idempotency: if `.agents/skills/{tech-slug}-patterns/SKILL.md` already exists, skip and report "Already exists". Regenerating requires the user to delete the directory first, which protects skills customized during implementation.

### 3e. Wire Skills into Agents

Add each new skill name to the `skills:` frontmatter of the agents it serves, without duplicating an entry and without touching anything below the closing frontmatter `---`. Read the canonical role source if present, else the legacy native agent. Stack-specific agents from Step 2b get the skills for their own domain. Default agents get:

| Agent | Gets Skills For |
|-------|----------------|
| `code-reviewer` | All stack skills (needs to review code in any technology) |
| `qa-engineer` | Testing framework skills + backend/frontend framework skills |
| `architect` | All stack skills (needs to validate architecture compliance) |
| `frontend-specialist` | Frontend framework + CSS + state management skills |
| `security-auditor` | Auth-related skills + backend framework skills |

In `--dry-run`, report "Would add {skill} to {agent}" without writing.

### 4. Seed Memory System

Follow `.agents/skills/review-specialize/references/seed-memory.md` for the existing five-category memory seeding workflow. Seed only empty categories; use the same memory-manager helpers.

### 5. Verify Command Integration

Check that each implementation command uses the memory API rather than raw file access. For each command, grep for:

1. `memory-manager.js`: proper API usage (CLI calls)
2. `Glob: docs/.output/.memory/`: a raw Glob pattern (should prefer the API)
3. `Check docs/.output/.memory/`: a vague text mention (should be an actual CLI call)

Status: **INTEGRATED** uses the `memory-manager.js` CLI for reads and writes; **PARTIAL** has some API usage plus raw Glob or text mentions; **NOT_INTEGRATED** has no memory API usage.

| Command | File | Should Read | Should Write |
|---------|------|------------|-------------|
| `/do` | `commands/do.md` | Yes (planning + pre-delegation) | Yes (post-implementation patterns) |
| `/run-todo` | `commands/run-todo.md` | Yes (wave planning) | Yes (post-wave patterns) |
| `/review:code-review` | `commands/review/code-review.md` | Yes (load standards) | No |
| `/retro` (if installed) | `commands/retro.md` | Yes (gather data) | Yes (extract patterns) |
| `/prime` | `commands/prime.md` | Yes (load context) | No |
| `/end` | `commands/end.md` | Yes (memory summary) | No |

This step flags issues for manual action; it does not edit command files.

### 6. Render and Commit (main agent)

After canonical changes run `node .claude/core/render-shared-agents.js`. Resolve any generated-output conflict by reviewing it and applying the intended behavior to its canonical source (native metadata belongs in the adapter); never reverse-import a generated file silently. In `--dry-run`, use the renderer's `--dry-run` flag and do not write or commit.

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`: stage all files this command created or modified and commit with a descriptive message.

### 7. Report

Use the report template in `.agents/skills/review-specialize/references/specialization-report.md`.

## When to Run

- During project setup, after `/check-readiness` passes
- After architecture changes (tech stack or ADRs updated)
- Before a new epic, to refresh agent context with architectural evolution
- On demand, when implementation feels misaligned with the architecture
