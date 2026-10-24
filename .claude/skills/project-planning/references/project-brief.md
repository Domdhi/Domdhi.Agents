# Project Brief

Expert in capturing strategic product vision. Produces concise briefs that inform PRDs and architecture documents downstream.

## Document Template

The document you produce — the canonical, scaffold-blessed template — lives in `../assets/brief.md` (raw, with the `<!-- @@template -->` first-line marker). Read it to know the artifact's structure; `scaffold.js` seeds `docs/product/brief.md` from the same file.

## Required Sections Checklist

A project brief is COMPLETE when it has:
- [ ] Vision (1-2 sentences, clear value proposition)
- [ ] Problem Statement (specific, measurable pain)
- [ ] At least 1 Target User persona
- [ ] Key Features with priorities (Must/Should/Nice)
- [ ] Success Metrics (at least 2)
- [ ] Constraints listed
- [ ] Out of Scope defined
- [ ] Open Questions (even if empty — acknowledge there are none)

## Quality Criteria

### Good Brief
- Vision fits in a tweet (concise, compelling)
- Problem is specific: "HR managers spend 3 hours/week on manual reports" not "reporting is hard"
- Features map directly to user pain points
- Out of scope is explicit (prevents scope creep)
- Constraints are realistic, not aspirational
- **Stays in problem-space** — captures *what must be true*, never *which tool to use*. The architecture phase picks the stack.

### Bad Brief
- Vision is generic: "improve the user experience"
- No personas defined
- Features are solutions, not outcomes
- No success metrics
- Missing constraints (everything is possible!)
- **Makes premature tool picks** — "use Web3Forms", "host on Netlify", "store in Redis". These anchor the architecture phase and collide with its reasoning. (See Cross-Cutting Rule 4 in `SKILL.md`.)

### Constraint vs. pick (the load-bearing distinction)

The `Constraints → Technical` line is where tool picks leak in. Discipline it:

| Keep (constraint — bounds the solution space) | Defer to architecture (pick — selects one option) |
|---|---|
| "no build step", "$0/month", "must work offline" | "use Vite", "deploy on Vercel" |
| "must decouple from the legacy vendor platform" | "use Cloudflare Pages Functions + D1" |
| "vanilla JS only, no framework" | "use Alpine.js for the form" |
| "send the operator an email on each lead" | "use Resend for transactional email" |

A constraint comes from the user's reality and *every* valid solution must honor it. A pick chooses one tool when others would satisfy the constraint just as well — that's the architect's call. If the user volunteers a pick, record it under Open Questions or as a noted preference "for the architecture phase to weigh," not as settled.

## Interview Questions

1. "In one sentence, what are you building?"
2. "Who is the primary user, and what's their biggest frustration today?"
3. "If this succeeds, what changes? How would you measure it?"
4. "What are the 3-5 must-have features for v1?"
5. "What is explicitly NOT in scope?"
6. "What constraints do you have? (timeline, tech, budget, team)"
7. "Are there any regulatory or compliance requirements?"

## Output Paths
- Reads from: brainstorm/research docs if available — feature-scoped: `docs/modules/{feature}/brainstorm.md`; general: `docs/.output/findings/research/{date}-{slug}.md`
- Produces: `docs/product/brief.md`
- Feeds into: `docs/product/requirements.md` (via `/create:project-requirements`)
