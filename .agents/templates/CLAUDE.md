# Documentation Structure

The single navigation contract for `docs/` in projects using the Domdhi.Agents
toolkit. `docs/` is organized **by concern — the question each doc answers** —
not by artifact type or producer. The domain names are identical on every
project, so any path here is correct everywhere (ADR: docs/ Domain Taxonomy).

## The seven domains

| Domain | Question it answers | Canonical contents |
|--------|---------------------|--------------------|
| **product/** | *Why does this exist & what must it do?* | `brief.md`, `requirements.md`, `context.md`, `brainstorm.md`, `research.md` |
| **architecture/** | *How is it built & why these choices?* | `overview.md`, `api.md`, `data-model.md`, `decisions/NNNN-*.md` (ADRs) |
| **design/** | *How is it experienced?* (UI only) | `spec.md`, `wireframes.md`, `theme.light.md`, `theme.dark.md`, `mock.html` |
| **engineering/** | *How do we work on it?* | `setup.md`, `conventions.md`, `testing.md` |
| **operations/** | *How do we ship & run it?* | `deploy.md`, `observability.md`, `security.md`, `runbooks/*.md` |
| **work/** | *What now & next?* (the living plan) | `backlog.md`, `roadmap.md`, `timeline.md`, `todo/` (+ `_archive/`) |
| **reference/** | *How do I find my way?* | `onboarding.md`, `glossary.md`, `links.md` (+ `agents/` — the toolkit's own reference docs, shipped with the publish artifact only) |

Plus two non-domain elements:

- **`modules/{name}/`** — a *fractal* axis, not a domain. Per-feature zoom: each
  module folder is a mini domain-set, usually just `brief.md` until it earns more.
- **`.output/`** — the ephemeral/generated zone (the only deep tree). Agents
  **write** here and rarely re-read; quarantining it keeps the seven domains
  clean to scan. Holds generated reports **and** task working files
  (`.output/.state/work/{date}/{task}/`).

## Folder Structure

```
docs/
├── CLAUDE.md                  # This file — the navigation contract (auto-loaded)
│
├── product/                   # WHY & WHAT
│   ├── brief.md               # Strategic vision and project scope
│   ├── requirements.md        # Product requirements (WHAT, not HOW)
│   ├── context.md             # Quick-reference: links, commands, current state
│   ├── brainstorm.md          # /brainstorm seed
│   └── research.md            # /research validated assumptions
│
├── architecture/              # HOW it's built & WHY
│   ├── overview.md            # Tech stack, system design
│   ├── api.md                 # External contract (optional)
│   ├── data-model.md          # Persistent data shape (optional)
│   └── decisions/             # ADRs — NNNN-title.md, append-only, never deleted
│
├── design/                    # HOW it's experienced (UI only)
│   ├── spec.md  wireframes.md  theme.light.md  theme.dark.md  mock.html
│
├── engineering/               # HOW we work on it
│   └── setup.md  conventions.md  testing.md
│
├── operations/                # HOW we ship & run it
│   └── deploy.md  observability.md  security.md  runbooks/
│
├── work/                      # WHAT now & next (the living plan)
│   ├── backlog.md             # Epic definitions (source of truth)
│   ├── roadmap.md  timeline.md
│   └── todo/                  # Implementation checklists (+ _archive/)
│
├── reference/                 # HOW to find your way
│   ├── onboarding.md  glossary.md  links.md
│   └── agents/                # toolkit reference docs (reach a project only through the publish artifact; install and update do not deliver them; never put project docs here)
│
├── modules/{name}/            # Per-feature zoom — mirrors the codebase
│   └── brief.md               # Scope, key files, dependencies (+ more as earned)
│
└── .output/                   # Generated zone (ADR 0006 lifecycle split)
    ├── handoffs/  findings/  plans/  evolution/   # durable history — TRACKED
    │      # findings/ = reviews + investigations + research
    │      # evolution/ = intake + triage + canary + skills + agents
    ├── .memory/                # curated memory SOURCE — TRACKED, syncs over git
    │      # patterns/ constraints/ decisions/ workflows/ rejected-approaches/
    └── .state/                 # ALL regenerable/derived/transient — GITIGNORED (one folder)
           # memory-{index,inbox,daily}/ telemetry/ sessions/ screenshots/ work/{date}/{task}/
```

## Conventions

- **No `_` prefix.** The folder provides the namespace: `product/requirements.md`,
  not `_requirements.md`. The `<!-- @@template -->` first-line marker still does
  the "scaffolded-but-unfilled" gate job.
- **Every domain is a folder, even single-file ones.** Predictability beats saving
  a directory level — the set degrades by leaving a folder empty/absent, never by
  relocating its file.
- **Cross-cutting concerns are not domains.** Security/performance/accessibility
  live *within* domains (the threat model is `architecture/decisions/`, secret
  handling is `operations/security.md`), never as a sibling folder.
- **`work/` owns the durable plan** (backlog, roadmap, timeline, todo). Ephemeral
  task working files live in the generated zone at `.output/.state/work/{date}/{task}/`,
  not in `work/` — so the living plan stays scannable and scratch never ships.
- **`.output/` is operational (ADR 0006 lifecycle split).** One gitignored folder —
  `.output/.state/` — holds ALL regenerable/derived/transient state (the rebuilt
  memory index, drafts, daily logs, telemetry, sessions, screenshots, `work/` scratch,
  `status.html`). Durable history (`handoffs/`, `findings/`, `plans/`, `evolution/`)
  and the curated memory SOURCE (`.memory/`) are **tracked**. The boundary is a
  folder, not a path list — nothing under `.state/` can be tracked-despite-ignored.

## Adding a New Module

```bash
mkdir -p docs/modules/{module-name}
# Create brief.md with: scope, key files, dependencies
```

## Where To Look

| Need To... | Look Here |
|------------|-----------|
| Understand the product | `docs/product/requirements.md` |
| Understand the tech stack | `docs/architecture/overview.md` |
| Find an architecture decision | `docs/architecture/decisions/` |
| Understand the design system | `docs/design/spec.md` |
| Learn how we work / conventions | `docs/engineering/conventions.md` |
| Ship & run it | `docs/operations/` |
| Understand a specific module | `docs/modules/{module}/brief.md` |
| Track implementation | `docs/work/backlog.md`, `docs/work/todo/` |
| Find reviews and audits | `docs/.output/findings/reviews/` |
| Session continuity | `docs/.output/handoffs/` (latest, via handoff-path.js) |
