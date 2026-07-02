# Specializing for Your Stack

After you've written your architecture document, running `/review:specialize` customizes the generic `.claude/` template for your actual tech stack. It reads your architecture, appends project context to each of the 11 baseline agents, creates stack-specific agents where the architecture calls for them, seeds your memory system with ADR-derived decisions, and generates a code-review risk map from your component architecture.

This guide walks through it on a concrete Next.js 15 project. The command itself is tech-agnostic — nothing about it is Next.js-specific. We use Next.js as the scenario so the shape of inputs and outputs is concrete. Swap your stack in and the same process applies.

For the abstract command reference, see [`../reference/commands.md`](../reference/commands.md). For the zone boundaries `/review:specialize` respects when writing to agent files, see [`../reference/customization.md`](../reference/customization.md). For the inventory of baseline agents it extends, see [`../concepts/agents.md`](../concepts/agents.md).

## Before You Run

`/review:specialize` has a hard phase gate. It refuses to run unless two files exist and have been filled in (not just scaffolded from templates):

- `docs/architecture/overview.md` — your architecture document with ADRs, component architecture, and a `## Tech Stack` section broken into Backend, Frontend, Database, Infrastructure, Auth, and Testing subsections
- `docs/work/backlog.md` — your epics, even as a sketch

If either file is missing, or either still carries the `<!-- @@template -->` marker from scaffold, the command aborts and tells you which planning step to run next. There is no `--yolo` escape hatch here — specialize reads structured data out of the architecture doc, and an empty doc has nothing to read.

Before running, confirm your architecture doc has actual values in the tech stack tables, not placeholder braces. A row that reads `| Framework | {TBD} | {version} | {rationale} |` will cause the command to abort at Step 1h with a pointer to which row is unfilled.

## The Three Run Modes

`/review:specialize` accepts three modes. Pick based on whether you want a preview or changes on disk.

- **`--dry-run`** — Reads everything, generates the full report showing what *would* change, writes nothing. Use this the first time you run it on a project, and whenever the architecture has shifted and you want to see the delta before accepting it.
- **`--fix`** (default) — Same as dry-run, then applies the changes: appends Project Context to agents, creates stack-specific agents, generates the risk map, seeds memory. This is the normal mode after a dry-run looks right.
- **`--report-only`** — Condensed tables, no details. Useful for a quick re-check: "are my agents still aligned with the current architecture doc?" after minor changes.

All three are idempotent — re-running does not duplicate content or re-seed populated memory categories.

## A Concrete Next.js Walkthrough

Imagine you've just finished `/create:project-architecture` for a fintech loan-origination app. Your architecture doc includes these tech stack rows:

**Backend**

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Runtime | Node.js | 20 LTS | Long-term support through 2026 |
| Framework | Next.js | 15 | App Router + server components |
| API | Next.js Route Handlers | 15 | Colocated with pages, reduces context switching |
| ORM | Drizzle ORM | 0.36 | Type-safe schema, minimal runtime overhead |

**Frontend**

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Framework | React | 19 | Server components, use() for async data |
| Styling | Tailwind CSS | 4.0 | Utility-first, matches design system |
| State | React Server Components | — | Default; client state only where needed |

**Database**

| Role | Technology | Version | Rationale |
|------|-----------|---------|-----------|
| Primary | PostgreSQL | 16 | Mature, strong consistency, rich extension ecosystem |
| Cache | Redis | 7 | Session store and rate-limit counters |

**Auth**: NextAuth.js v5, JWT access tokens + refresh rotation, RBAC with `loan-officer`, `underwriter`, `admin` roles.

**Testing**: Vitest (unit, 80% target), Playwright (E2E, critical flows).

Plus three ADRs:

- ADR-001: Server components by default, client islands only when interactivity is required
- ADR-002: Drizzle over Prisma — lighter runtime, schema as TypeScript
- ADR-003: JWT rotation on every refresh — mitigates stolen-token replay

You run `/review:specialize --dry-run` first.

### What the command extracts

The command parses the tech stack tables, ADRs, component architecture, and cross-cutting concerns sections. It does not hardcode a known stack — if your architecture doc contains rows for technologies it's never seen, it picks them up anyway and carries them through. In our example it extracts 11 tech stack entries, 3 ADRs, an RBAC auth model, and two-tier testing strategy.

If any extracted value contains an unfilled placeholder (`{something}`), the command aborts at this step and tells you which row. Fill the placeholder, re-run.

### Baseline agent specialization

The 11 default agents each get a `## Project Context` section appended to their markdown body. What goes in that section depends on the agent — different agents need different slices of your stack.

For `general-purpose` (Forge), the code-implementation agent, the appended section looks roughly like this:

```markdown
## Project Context

> Specialized for Fintech Loan App on 2026-04-20 by /specialize

### Tech Stack
- Next.js 15 — Framework — why: App Router + server components
- React 19 — Frontend — why: Server components, use() for async data
- Drizzle ORM 0.36 — ORM — why: Type-safe schema, minimal runtime overhead
- PostgreSQL 16 — Primary DB — why: Mature, strong consistency
- Tailwind CSS 4.0 — Styling — why: Utility-first, matches design system

### Key Patterns
- Server components by default: render on the server, pass data down as props — solves: unnecessary client bundle weight
- Drizzle schema-first migrations: define tables in TypeScript, generate SQL — solves: schema drift between ORM and DB

### Relevant ADRs
- ADR-001: Server components by default — client islands only when interactive → consequence: all data fetching happens server-side unless explicitly marked "use client"
- ADR-002: Drizzle over Prisma → consequence: smaller runtime, closer to raw SQL

### Conventions
- Colocate route handlers with pages under `app/**/route.ts`
- Client components get an explicit "use client" directive at file top
- All database access through Drizzle schema types — no raw SQL outside migrations
```

The other 10 agents get their own slices. `qa-engineer` gets the testing strategy table (Vitest 80% unit, Playwright E2E). `security-auditor` gets the auth model and any security-flagged ADRs. `code-reviewer` gets the full stack plus a generated risk map (more on that below). `doc-writer` gets a one-line stack summary and the project name.

Each agent's Project Context entirely replaces any previous one — if you re-specialize after ADR-004 lands, the section is regenerated, not appended to. This is the idempotency guarantee.

**Soul Zone preservation.** If you've already run [`/review:personalize`](../reference/commands.md#reviewpersonalize) (or will later), each agent has a personality section above its skills list — identity, decision philosophy, working style. `/review:specialize` does not touch that. It finds the `## Project Context` heading (or appends after the soul zone if it doesn't exist yet) and operates strictly below that anchor. Run order between `specialize` and `personalize` does not matter — they own non-overlapping zones.

### Stack-specific agents the command creates

Beyond the 11 baseline agents, `/review:specialize` scans your architecture for technology domains that warrant their own specialist. For our Next.js fintech app, it produces three new agents:

- **`frontend-specialist`** — React 19 + Tailwind 4.0. Loaded skills: `brand-guidelines` (because `docs/design/spec.md` exists), `tailwind-css-patterns` (because Tailwind is in the stack). System prompt embeds the "server components by default" ADR and the Tailwind theme tokens.
- **`db-architect`** — Drizzle ORM 0.36 + PostgreSQL 16. System prompt embeds ADR-002 and the schema-first migration convention.
- **`auth-builder`** — NextAuth.js v5 + JWT rotation. System prompt embeds ADR-003 and the RBAC role list.

What gets created is dynamic. A backend-only project wouldn't get `frontend-specialist`. A project using Firestore instead of Postgres would get a `db-architect` with Firestore-specific expertise. If your architecture has a section the command doesn't recognize — say, a GraphQL federation layer — it creates an `api-specialist` sized to that section rather than ignoring it. The table in the command's Step 2b is a starting point, not a ceiling.

These agents are **project-specific** — the tech stack details are embedded in the agent's prompt body, not appended as a Project Context section. That's because the 11 baseline agents are template-owned (they get updated when the template updates), while stack-specific agents are yours to edit. See [`../reference/customization.md`](../reference/customization.md) for the zone rules.

### Risk map for code review

`/review:specialize` analyzes your architecture's component structure and generates a risk map — a table of path patterns classified as HIGH, MEDIUM, or LOW risk for code review. The map lives inside the `code-reviewer` agent's Project Context so reviews tier their attention automatically.

For our Next.js fintech app, the map looks something like:

| Path Pattern | Risk Tier | Reason |
|---|---|---|
| `app/api/auth/**` | HIGH | Auth handlers — session tokens, credential validation |
| `app/api/loans/**` | HIGH | Loan origination — financial data, approval logic |
| `db/schema/**` | HIGH | Data access layer — schema integrity |
| `app/(dashboard)/**` | MEDIUM | Business logic UI — decision flows, role-gated views |
| `app/api/**` | MEDIUM | Other route handlers — not payment/auth |
| `lib/utils/**` | LOW | Helpers |
| `tests/**` | LOW | Test scaffolding |

Paths not matching any pattern default to MEDIUM. When code-reviewer runs, it uses this map to decide depth: every change touching a HIGH path gets a deep review; LOW paths get light review unless they interact with something higher-tier.

### Skills audit and gap filling

The command reads every skill under `.claude/skills/` and classifies it against your stack. For our Next.js project:

- `tailwind-css-patterns` — **relevant**, Tailwind is in the stack, already wired to `ux-designer`
- `playwright-cli` — **relevant**, Playwright is your E2E framework
- `qa-engineer` — **relevant**, tech-agnostic planning skill
- ...every other baseline skill gets classified the same way

Then it detects gaps. Our stack uses React 19 and Drizzle 0.36 — neither has a skill yet. The command flags those as `needs-framework-skill` and delegates to the `architect` agent to generate `react-patterns` and `drizzle-patterns` skills. Each generated skill follows the project's conventions from the architecture doc — not generic framework knowledge. If ADR-001 says "server components by default," the React skill leads with that, not with `useState` basics.

After new skills are generated, the command wires them into relevant agents automatically. `code-reviewer` gets all stack skills (it reviews everything). `frontend-specialist` gets React and Tailwind. `db-architect` gets Drizzle.

In `--dry-run` mode, gaps are reported as "Would create" — nothing written. In `--fix`, the skills land as new directories under `.claude/skills/`. If you've manually customized a skill already, re-running won't overwrite it — the command skips any skill directory that already exists.

### Memory seeding

`/review:specialize` seeds your memory system with structured data drawn from your architecture. For every ADR, it writes a decision memory at confidence 0.9. For every component in `## Component Architecture` and every cross-cutting concern, it writes a pattern memory at 0.9.

The 0.9 confidence is the highest tier — architecture-documented facts are authoritative because they come from a reviewed design decision, not from an agent's implementation guess. Lower confidences (0.7 from `/do` post-task, 0.8 from `/retro`, 0.5 from session observations) get promoted or decay against this architecture baseline. See [`../concepts/memory.md`](../concepts/memory.md) for the full confidence ladder.

Seeding is conservative. The memory manager only seeds an empty category — if `docs/.output/.memory/decisions/` already has any `.json` files, nothing is written to avoid trampling memories promoted from later runs. If you want to re-seed after a major architecture change, delete the relevant category directory first.

After seeding, the command runs a memory health check (linter + decay report) and includes the results in its final report.

## Reading the Final Report

When the command completes, it emits a Markdown report with sections for extracted tech stack, agent specialization, stack-specific agents created, build/test gate status, risk map, skills audit, skills generated, skill wiring, memory system state, command integration, memory lifecycle, manual actions required, and recommended next steps.

The two sections to read carefully every time:

- **Manual Actions Required** — anything the command could not auto-fix. Most commonly: a command in `/do`/`/run-todo`/`/review:*` that doesn't yet read or write memory via the `memory-manager.js` API. These don't block you, but they represent integration gaps.
- **Recommended Next Steps** — an ordered list based on what the run surfaced. Typically: "regenerate these three stale skills," "fix the auth section placeholder on line 47 of the architecture doc," then "begin your first `/do`."

## Common Manual-Actions Cases

Three things the command commonly flags but cannot fix on its own:

1. **Unfilled placeholders in the architecture doc.** If a tech stack row reads `| Framework | {TBD} | ... |`, the command aborts at Step 1 before making any changes. Fix the row, re-run.
2. **Architecture sections the command expected but couldn't find.** Some agents need specific slices — `qa-engineer` needs a `## Development Standards > ### Testing Strategy` table, `security-auditor` needs an `## Auth` section. Missing sections produce dashes in the Project Context output. The command still runs; the affected agents just get less context.
3. **Skills flagged `needs-framework-skill` that the command couldn't delegate.** Rare, but happens if the `architect` agent returns an error. The gap is reported; you can re-run or create the skill manually following the format shown in the command's Step 3d.

## Idempotency and When to Re-Run

`/review:specialize` is designed to be re-run. Every time you run it:

- Agent `## Project Context` sections are **replaced** (not appended to). Your Soul Zone above that section is preserved.
- Stack-specific agents are **skipped** if they already exist by name. To regenerate, delete the agent file first.
- Generated skills are **skipped** if the directory already exists. To regenerate, delete the directory.
- Memory seeding is **skipped** for any category that already has memories. To re-seed, delete the category's directory.
- The risk map inside `code-reviewer`'s context is **replaced**.

Re-run when:

- Your architecture changes — a new ADR lands, the tech stack shifts, a component gets restructured
- Before starting a new epic — refresh the agents with any architectural evolution since the last epic
- Implementation feels misaligned — you're getting suggestions that ignore a recent ADR, the risk map doesn't match your current directory layout, an agent's examples feel stale

The cost of re-running is a few seconds and a commit. The cost of not re-running after an architecture change is agents working from stale context.

## What's Next

After `/review:specialize` lands cleanly, the natural next step is `/review:personalize` — it gives each agent a name, a persona, and a working style. Specialize and personalize own non-overlapping zones in the agent files and can run in either order. A dedicated walkthrough for `/review:personalize` is coming in a sibling guide; for now, the command's own file at `.claude/commands/review/personalize.md` is the reference.

## See Also

- [`../concepts/agents.md`](../concepts/agents.md) — the 11 baseline agents, model hierarchy, how commands dispatch them
- [`../reference/customization.md`](../reference/customization.md) — zone boundaries that `/review:specialize` respects when editing agent files
- [`../reference/system-map.md`](../reference/system-map.md) — the inventory of commands, agents, skills, and hooks that specialize extends
- [`../concepts/memory.md`](../concepts/memory.md) — the confidence ladder and decay model for seeded memories
