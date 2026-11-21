# Project Requirements (PRD)

Defines WHAT to build, never HOW (architecture owns that). A good PRD gives every requirement a testable acceptance criterion and a priority, ties requirements to personas, and gives non-functional requirements measurable targets.

## Document Template

The canonical, scaffold-blessed template is `../assets/requirements.md` (raw, with the `<!-- @@template -->` first-line marker). `scaffold.js` seeds `docs/product/requirements.md` from it.

## Required Sections Checklist

A PRD is COMPLETE when it has:
- [ ] Executive Summary (readable by non-technical stakeholders)
- [ ] At least 1 User Persona with goals and frustrations
- [ ] Functional Requirements with MoSCoW priority and acceptance criteria
- [ ] Non-Functional Requirements (at minimum: performance, security)
- [ ] At least 1 User Flow
- [ ] Data Model (conceptual entities and relationships)
- [ ] Security Requirements
- [ ] Assumptions & Dependencies
- [ ] Success Criteria

## What good looks like

- Each FR has Given/When/Then acceptance criteria and a MoSCoW priority that is not all Must.
- NFRs have measurable targets ("page loads in <2s", not "fast" or "should be secure").
- Flows cover happy path and error paths. The data model uses domain language, not database terms. The security section states the auth model.
- Personas give requirements user context, and WHAT is not mixed with HOW.

## Interview Questions

1. "What are the main modules or feature areas?"
2. For each module: "What must a user be able to do?" (extract FRs)
3. "Walk me through the most important user journey start to finish"
4. "What are the performance expectations? (concurrent users, response times)"
5. "What security/compliance requirements exist?"
6. "What systems does this need to integrate with?"
7. "What are the hard constraints vs nice-to-haves?"
8. "Is there an existing data model or database to work with?"

## Output Paths
- Reads from: `docs/product/brief.md` (recommended)
- Produces: `docs/product/requirements.md`
- Feeds into: `docs/architecture/overview.md`, `docs/design/spec.md`, `docs/work/backlog.md`
