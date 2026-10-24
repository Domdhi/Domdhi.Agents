# Create Module

Orchestrate the full lifecycle of a new module from idea to implementation-ready TODO checklist. Creates the `docs/modules/{module}/` folder structure and generates all planning artifacts.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:module
```

## Variables

MODULE_DESCRIPTION: $ARGUMENTS

- `MODULE_DESCRIPTION` (required): Natural language description of the module idea. Can include scope, motivations, and constraints.

## Workflow

### Phase 1: Context Gathering

1. **Read project context** to understand current state:
   - `docs/product/context.md` — quick-reference index
   - `docs/architecture/overview.md` — tech stack, component architecture, ADRs
   - `docs/product/requirements.md` — existing requirements and scope
   - `docs/CLAUDE.md` — documentation structure conventions
   - `CLAUDE.md` — project conventions

2. **Identify placement** — does this belong as:
   - A new module in `docs/modules/{name}/`?
   - An extension of an existing module?
   - A cross-cutting concern (affects multiple modules)?

3. **Identify scope dimensions:**
   - Data model changes (new tables, schema modifications)
   - API surface area (new endpoints, modified contracts)
   - UI surface area (new routes, components, layouts)
   - Infrastructure changes (new services, config, migrations)
   - Integration points (external APIs, third-party services)
   - Security implications (new auth rules, permissions)

### Phase 2: Stakeholder Brainstorm

**Spawn four parallel Task agents**, each arguing from a different perspective.

**Agent prompts must include:**
- Full module description from `MODULE_DESCRIPTION`
- Current project context (architecture, existing modules, tech stack)
- The placement identified in Phase 1
- Clear instruction to take a stance and be opinionated (150-250 words)

**The four stakeholders:**

1. **Product Strategy** → `Task(product-strategist, ...)`
   - Value proposition, user impact, market positioning
   - Start with: `"**PRODUCT:** **[Recommendation in bold]**"`

2. **Architecture** → `Task(architect, ...)`
   - Data model, system fit, performance, infrastructure impact
   - Start with: `"**ARCHITECTURE:** **[Recommendation in bold]**"`

3. **UX Design** → `Task(ux-designer, ...)`
   - User flow, navigation, visual consistency, accessibility
   - Start with: `"**UX:** **[Recommendation in bold]**"`

4. **Dev Lead** → `Task(general-purpose, ...)`
   - Scope, tech debt, build effort, phasing
   - Start with: `"**DEV LEAD:** **[Recommendation in bold]**"`

### Phase 3: Decision

1. **Present all four opinions** to the user with a concise summary of each stance
2. **Highlight the key tensions** (e.g., "new module" vs "extend existing", "scope big" vs "keep lean")
3. **Ask the user** which direction they want to go using `AskUserQuestion`

### Phase 4: Documentation Generation

Once the user decides, generate the module documentation.

**4a. Create module brief** — `docs/modules/{module}/brief.md`
- Scope, key files (planned), dependencies
- Follow the pattern established in existing `docs/modules/` module briefs

**4b. Update PRD** (if scope warrants it):
- Add new functional requirements to `docs/product/requirements.md`
- Include acceptance criteria for each requirement
- Cross-reference with existing requirements

**4c. Update Architecture** (if infrastructure changes needed):
- Add component descriptions to `docs/architecture/overview.md`
- Add new ADR if an architectural decision was made
- Update data model section if schema changes

### Phase 5: TODO Generation

Generate a comprehensive TODO checklist following the `/todo` command format.

**Save to:** `docs/work/todo/TODO_{ModuleName}.md`

**Adapt phases to module scope** — not every module needs every phase:

1. **Infrastructure & Config** — new configuration, environment setup, dependencies
2. **Data Layer** — schema changes, migrations, data access
3. **Core Logic** — business rules, services, validation
4. **API Layer** — endpoints, contracts, middleware
5. **UI Components** — routes, components, layouts, forms
6. **Integration** — external API connections, event wiring
7. **Testing** — unit, integration, e2e tests matching acceptance criteria
8. **Documentation** — update relevant docs

**Every TODO item must be:**
- Actionable (clear what needs to be done)
- Testable (can verify completion)
- Atomic (single responsibility)
- Ordered (logical sequence with dependencies respected)

### Phase 5.5: Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command and commit with a descriptive message.

### Phase 6: Summary Report

```markdown
## Module Lifecycle Complete

**Module:** {Name}
**Decision:** {What was decided and why}
**Location:** `docs/modules/{module}/`

### Documentation Updated
| Document | Action | Details |
|----------|--------|---------|
| docs/modules/{module}/brief.md | Created | Scope, key files, dependencies |
| product/requirements.md | {Updated/No change} | {N new FRs} |
| architecture/overview.md | {Updated/No change} | {ADR added / component added} |

### TODO Checklist
**File:** docs/work/todo/TODO_{ModuleName}.md
**Phases:** {count}
**Total tasks:** {count}
**Estimated complexity:** {Low/Medium/High}

**Committed**: {hash} — `docs: /create:module — {summary}`
**Next step:** Run `/do` to begin implementation — checklist at docs/work/todo/TODO_{ModuleName}.md
```

## Anti-Patterns

- **DO NOT skip the brainstorm phase** — even for "obvious" modules, different perspectives surface blind spots
- **DO NOT let agents see each other's opinions** — each stakeholder must argue independently
- **DO NOT skip documentation** — the docs ARE the spec; without them, `/do` has no context
- **DO NOT create shallow TODOs** — every phase needs enough detail for an agent to execute without ambiguity
- **DO NOT auto-implement** — this command produces a plan and TODO, not code. Implementation happens via `/do`

## Examples

```
# New module
/create:module Add a notification system with email and push delivery

# Enhancement to existing module
/create:module Add CSV export to the reporting module

# Infrastructure module
/create:module Add a feature flag system with per-tenant toggles

# Cross-cutting concern
/create:module Implement audit logging for all data mutations
```
