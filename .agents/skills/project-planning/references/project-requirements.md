# Project Requirements (PRD)

Expert in product requirements documentation. Produces comprehensive PRDs that define WHAT to build (not HOW — that's architecture's job).

## Document Template

The document you produce — the canonical, scaffold-blessed template — lives in `../assets/requirements.md` (raw, with the `<!-- @@template -->` first-line marker). Read it to know the artifact's structure; `scaffold.js` seeds `docs/product/requirements.md` from the same file.

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

## Quality Criteria

### Good PRD
- Each FR has clear acceptance criteria (Given/When/Then)
- MoSCoW prioritization is used — not everything is "Must Have"
- NFRs have measurable targets ("page loads in <2s" not "fast")
- User flows cover happy path AND error paths
- Data model uses domain language, not database terms
- Security section is explicit about auth model

### Bad PRD
- Acceptance criteria are vague ("system works correctly")
- Everything is Must Have priority
- NFRs have no targets ("should be secure")
- Only happy-path flows, no error handling
- Mixes WHAT (requirements) with HOW (implementation)
- No personas — requirements float without user context

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
