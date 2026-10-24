# Backlog — Epics & Stories

Breaking requirements into implementable work. Creates epics (logical feature groupings) and stories (single-session implementable units) with proper dependency ordering.

## Document Template

The document you produce — the canonical, scaffold-blessed template — lives in `../assets/backlog.md` (raw, with the `<!-- @@template -->` first-line marker). It carries both the epic/phase structure and the `## Story Index` section. Read it to know the artifact's structure; `scaffold.js` seeds `docs/work/backlog.md` from the same file.

## Breakdown Rules

### Epic Sizing
- An epic represents a **coherent feature area** (e.g., "Authentication", "Dashboard", "User Management")
- An epic should have 3-8 stories
- If an epic has >8 stories, split it into sub-epics

### Story Sizing
- A story should be completable in **one coding session** (1-4 hours)
- If a story requires touching more than 5 files, consider splitting
- Each story must be independently testable

### Estimation Guide
| Size | Effort | Files Changed | Complexity |
|------|--------|---------------|------------|
| S | < 1 hour | 1-2 files | Configuration, simple CRUD |
| M | 1-2 hours | 2-4 files | New component, service + tests |
| L | 2-4 hours | 4-6 files | Feature with multiple pieces |
| XL | 4+ hours | 6+ files | Complex feature, should consider splitting |

### Domain Tags
Use domain tags to help `/do` select the right implementation agent:
- `(Backend)` — API, services, data access
- `(Frontend)` — Components, pages, styling
- `(DevOps)` — Build, deploy, infrastructure
- `(Database)` — Schema, migrations, queries
- `(Auth)` — Authentication, authorization
- `(Test)` — Test creation, test infrastructure
- `(Config)` — Configuration, settings, feature flags
- `(Docs)` — Documentation, API docs

### Dependency Ordering
- Stories within an epic should be ordered by dependency
- Cross-epic dependencies should be explicitly called out
- Phase ordering: Foundation → Data → Backend → Frontend → Integration → Polish

### Acceptance Criteria Patterns

**Good AC:**
- "Script generates `appsettings.Production.json` from template"
- "Login page redirects to dashboard after successful auth"
- "API returns 403 when user lacks required role"
- "Dashboard loads in under 2 seconds with 1000 records"

**Bad AC:**
- "Works correctly"
- "User can do stuff"
- "System is fast"

## Quality Criteria

### Good Epic Breakdown
- Clear phase ordering (foundation → features → polish)
- Stories have dependencies explicitly noted
- Every story has acceptance criteria (not just a title)
- Estimates are present and realistic
- Domain tags help route to correct implementation agent
- First phase is always foundation/infrastructure
- Each story lists the files it touches in a `**Files:**` block — `epic-overlap.js` parses these to flag epics that claim the same file, which would cause silent merge conflicts when `/run-todo` dispatches them in parallel waves

### Bad Epic Breakdown
- No dependency ordering (stories can't be built in sequence)
- Missing acceptance criteria
- Stories are too large (XL without split recommendation)
- No domain tags
- Phase 1 jumps straight to features without foundation

## Cross-References
- Reads from: `docs/architecture/overview.md` (required), `docs/product/requirements.md` (required)
- Produces: `docs/work/backlog.md`
- Feeds into: `/do`, `/run-todo` (for implementation)
