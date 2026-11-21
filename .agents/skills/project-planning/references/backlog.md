# Backlog — Epics & Stories

Turns requirements into implementable work: epics (coherent feature groupings) and stories (single-session units) in dependency order. A good backlog can be built in sequence by whoever picks it up: every story has testable acceptance criteria, an estimate, a domain tag and the files it touches.

## Document Template

The artifact's canonical, scaffold-blessed template is `../assets/backlog.md` (raw, with the `<!-- @@template -->` first-line marker). It carries the epic/phase structure and the `## Story Index` section; `scaffold.js` seeds `docs/work/backlog.md` from it.

## Sizing and ordering

- An epic is a coherent feature area ("Authentication", "Dashboard") of roughly 3-8 stories; split a bigger one into sub-epics.
- A story fits one coding session (1-4 hours) and is independently testable. Past about 5 files, consider splitting.
- Order stories by dependency within an epic, call out cross-epic dependencies, and phase the work Foundation → Data → Backend → Frontend → Integration → Polish. The first phase is always foundation/infrastructure.

Size guide:

| Size | Effort | Files Changed | Complexity |
|------|--------|---------------|------------|
| S | < 1 hour | 1-2 files | Configuration, simple CRUD |
| M | 1-2 hours | 2-4 files | New component, service + tests |
| L | 2-4 hours | 4-6 files | Feature with multiple pieces |
| XL | 4+ hours | 6+ files | Complex feature, should consider splitting |

Domain tags help `/do` pick the implementation agent: `(Backend)`, `(Frontend)`, `(DevOps)`, `(Database)`, `(Auth)`, `(Test)`, `(Config)`, `(Docs)`.

## Acceptance criteria

Write criteria that name an observable result: "Script generates `appsettings.Production.json` from template", "API returns 403 when user lacks required role", "Dashboard loads in under 2 seconds with 1000 records". "Works correctly", "User can do stuff" and "System is fast" are not criteria.

## What a good breakdown has

- Phase ordering and explicit dependencies, so stories can be built in sequence.
- Acceptance criteria and a realistic estimate on every story (an XL carries a split recommendation).
- A `**Files:**` block per story listing the files it touches: `epic-overlap.js` parses these to flag epics that claim the same file, which would cause silent merge conflicts when `/run-todo` dispatches them in parallel waves.

## Cross-References
- Reads from: `docs/architecture/overview.md` (required), `docs/product/requirements.md` (required)
- Produces: `docs/work/backlog.md`
- Feeds into: `/do`, `/run-todo`
