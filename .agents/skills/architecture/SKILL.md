---
name: architecture
description: "Use WHEN designing a system's technical architecture, choosing a tech stack, making a structural/scaling/reliability decision, or writing an ADR or the architecture document. Triggers: architecture, system design, ADR, tech stack, infrastructure, deployment, scalability, trade-off, technical decision"
metadata:
  version: 2.0.0
  author: Domdhi.Agents
  tags: [architecture, system-design, ADR, tech-stack, infrastructure, scalability, reliability, trade-offs]
user-invocable: false
allowed-tools: Read Write Edit Grep Glob
---

# Software Architecture

The discipline of making the **structural decisions that are expensive to reverse** — system shape, technology choices, data ownership, failure behavior, security boundaries — and recording them so they survive the people who made them. This skill is two things: the *judgment* to architect well, and the *production* of the architecture document that captures it.

Architecture is not the diagram. It is the set of decisions that constrain everything downstream. Get the reversible things wrong and you refactor; get the irreversible ones wrong and you rewrite. The architect's whole job is telling those two apart and spending judgment on the second kind.

---

## Part 1 — The Discipline (get the decisions right)

### Reason from constraints, not fashion

The requirements/brief carry **constraints** (scale, budget, latency, compliance, team skill, existing systems). Tech choices are *derived* from those constraints — never the reverse. "We'll use Kafka" is not an architecture; "events must survive a consumer outage and replay for 7 days, so we need a durable log → Kafka/Redpanda over a transient queue" is. Every choice traces to a constraint or it is decoration.

When the planning docs volunteered a tool pick (`project-planning` defers picks to you on purpose), treat it as *one candidate*, not a settled decision. Re-derive it from the constraints; confirm or replace it with reasoning.

### The tech-stack decision framework

For every significant choice (language, datastore, framework, host, queue, auth), evaluate against:

1. **Fit** — does it satisfy the hard constraints (scale, latency, consistency, compliance)? Disqualify anything that can't.
2. **Team** — can the people who'll own it operate it at 3am? A "better" tech the team can't run is worse.
3. **Operability** — backup/restore, observability, upgrade path, failure modes. Boring + well-understood beats novel + opaque.
4. **Cost** — total cost at expected scale, including ops time, not just sticker price.
5. **Reversibility** — how hard to swap later? Prefer choices behind a seam (an interface, an adapter) so a wrong call stays cheap.
6. **Maturity** — is it battle-tested for *this* use, or are you the test? Match risk appetite to the project's stakes.

Pick the **most boring technology that satisfies the constraints.** Innovation tokens are scarce — spend them on the problem that is actually novel, default to proven everywhere else.

### Choosing the architecture style

Don't reach for microservices/event-sourcing/CQRS by reflex. Start from the simplest shape the constraints permit and justify every step up in complexity:

- **Modular monolith** — the correct default for most new systems. One deployable, clear internal module boundaries. Split out a service only when a *specific* force demands it (independent scaling, independent deploy cadence, team ownership, fault isolation).
- **Services / microservices** — buy independent scaling and deployment at the cost of network failure modes, distributed data, and operational surface. Justify each split by a named force, not "it's modern."
- **Event-driven** — decouples producers from consumers, buys async resilience; costs eventual consistency and harder debugging. Use when temporal decoupling or replay is a real requirement.
- **Serverless** — great for spiky/low-baseline load and small surfaces; watch cold starts, vendor lock-in, and local-dev friction.

State the style explicitly and name the forces that chose it. "Monolith because the team is 3 people, load is modest, and deploy-as-one is an asset, not a limitation" is a *better* architecture than an unexamined mesh of services.

### Make the -ilities first-class

Happy-path architecture is not architecture. For the system's real load and failure profile, decide and write down:

- **Scalability** — where's the bottleneck (CPU, IO, DB connections, a hot row)? What scales horizontally vs. vertically? What's the stateful choke point?
- **Reliability** — what happens when each dependency is down/slow? Timeouts, retries with backoff+jitter, circuit breakers, idempotency, graceful degradation. Name the blast radius of each failure.
- **Data** — ownership (one writer per entity), consistency model (strong vs eventual, and *why* that's acceptable), transaction boundaries, migration/backfill strategy.
- **Security** — trust boundaries, authN vs authZ, secret handling, data classification, the threat surface. Security is a section, not an afterthought.
- **Observability** — how you'll know it's healthy (the three pillars: logs/metrics/traces), what the SLIs are, what pages a human.
- **Cost & performance targets** — measurable numbers (p99 latency, $/month, req/s), not adjectives.

### ADRs — decide in the open

An Architecture Decision Record captures **context → decision → alternatives considered → consequences (including the bad ones)**. The alternatives and the accepted downsides are the valuable part; a decision with no recorded alternatives is indistinguishable from a guess. Write an ADR for anything expensive to reverse or likely to be re-litigated. ADRs are immutable — supersede, never edit.

### Design for evolution

You will be wrong about something. Build for change: stable seams between modules, contracts at boundaries, no premature coupling to a vendor, and the "reversibility" lens above. The goal is *defer-able* decisions — keep options open until you have the information to choose well, and isolate the choices you must make now so a future reversal is local.

### Architecture smells (push back when you see these)

- Tech chosen before constraints are known ("we're a Rust shop" deciding a data problem)
- Everything is "Must Have" / every component is "critical" — no prioritization of effort
- Distributed system with no story for partial failure
- Shared mutable database table written by multiple services (no clear owner)
- No deployment, rollback, or migration story
- "We'll scale later" with a design that structurally can't
- Resume-driven complexity: novelty whose cost the project can't carry

---

## Part 2 — Producing the Architecture Document

### Document Template

The document you produce — the canonical, scaffold-blessed template — lives in `assets/overview.md` (raw, with the `<!-- @@template -->` first-line marker). Read it to know the artifact's structure; `scaffold.js` seeds `docs/architecture/overview.md` from the same file.

### Required Sections Checklist

An architecture doc is COMPLETE when it has:
- [ ] System Overview with architecture style (and the forces that chose it)
- [ ] Tech Stack with rationale for every choice (traced to a constraint)
- [ ] Architecture Diagram (ASCII)
- [ ] Component Architecture (at least 3 components, with responsibilities + boundaries)
- [ ] Data Architecture (entities, ownership, access patterns, consistency model)
- [ ] API Design (style + endpoint groups)
- [ ] Authentication & Authorization
- [ ] Infrastructure & Deployment (including rollback + migration)
- [ ] At least 1 ADR (with alternatives + consequences)
- [ ] Cross-Cutting Concerns (logging, error handling, caching, observability)
- [ ] Failure & Scaling behavior (bottlenecks, degradation, SLIs)
- [ ] Development Standards (project structure, testing strategy)

### Quality Criteria

**Good architecture doc**
- Every tech choice has a rationale that names the constraint it satisfies (not "we like it")
- ADRs capture alternatives considered and consequences accepted, not just the winner
- Diagrams use ASCII (no external tools required)
- Performance, scale, and cost targets are measurable numbers
- Failure behavior is explicit for each dependency
- Security model (trust boundaries, authN/Z, secrets) is explicit
- Project structure is canonical (not "figure it out")

**Bad architecture doc**
- Tech stack listed with no rationale
- No ADRs (decisions are invisible)
- Only happy-path architecture (no error handling, no monitoring, no failure modes)
- No deployment, rollback, or migration strategy
- Missing testing strategy
- Adjectives ("fast", "scalable") where numbers belong

### Interview Questions

1. "What's the deployment target? (cloud, on-prem, hybrid)"
2. "What's the team's primary expertise and size? (affects tech + style)"
3. "Any existing infrastructure or services to integrate with?"
4. "What's the expected scale? (users, data volume, request rate) — and the growth curve?"
5. "What are the hard latency / availability / consistency requirements?"
6. "Any regulatory or data-residency constraints?"
7. "Monolith or services? What forces (if any) actually require a split?"
8. "What's the auth story? (existing SSO, build new, etc.)"
9. "What databases are acceptable? (constraints from IT/ops)"
10. "What's the budget envelope and who operates this in production?"

## Cross-References
- Reads from: `docs/product/requirements.md` (required), `docs/design/spec.md` (optional)
- Produces: `docs/architecture/overview.md`
- Feeds into: `docs/work/backlog.md` (via `/create:project-epics`)
- Self-contained discipline skill — sibling to `ux-design`; the planning-pipeline *text* docs live in `project-planning`.
