# Project Brief

Captures the strategic product vision in a concise brief that informs the PRD and architecture downstream. A good brief says who hurts, how, and what must be true for the product to succeed, and stops there: it never says which tool to use.

## Document Template

The canonical, scaffold-blessed template is `../assets/brief.md` (raw, with the `<!-- @@template -->` first-line marker). `scaffold.js` seeds `docs/product/brief.md` from it.

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

## What good looks like

- The vision fits in a tweet. The problem is specific ("HR managers spend 3 hours/week on manual reports", not "reporting is hard"). Features map to user pain as outcomes, not solutions.
- Out of scope is explicit, and constraints are realistic rather than aspirational.
- It stays in problem space: what must be true, never which tool. The architecture phase picks the stack.

A weak brief has a generic vision ("improve the user experience"), no personas or success metrics, no constraints, or makes premature tool picks that anchor the architecture phase (Cross-Cutting Rule 4 in `SKILL.md`).

### Constraint vs. pick

The `Constraints → Technical` line is where tool picks leak in. A constraint comes from the user's reality and every valid solution must honor it; a pick chooses one tool when others would satisfy the constraint equally well, which is the architect's call.

| Keep (constraint — bounds the solution space) | Defer to architecture (pick — selects one option) |
|---|---|
| "no build step", "$0/month", "must work offline" | "use Vite", "deploy on Vercel" |
| "must decouple from the legacy vendor platform" | "use Cloudflare Pages Functions + D1" |
| "vanilla JS only, no framework" | "use Alpine.js for the form" |
| "send the operator an email on each lead" | "use Resend for transactional email" |

A volunteered pick goes under Open Questions or as a noted preference "for the architecture phase to weigh", not as settled.

## Interview Questions

1. "In one sentence, what are you building?"
2. "Who is the primary user, and what's their biggest frustration today?"
3. "If this succeeds, what changes? How would you measure it?"
4. "What are the 3-5 must-have features for v1?"
5. "What is explicitly NOT in scope?"
6. "What constraints do you have? (timeline, tech, budget, team)"
7. "Are there any regulatory or compliance requirements?"

## Output Paths
- Reads from: brainstorm/research docs if available (feature-scoped `docs/modules/{feature}/brainstorm.md`; general `docs/.output/findings/research/{date}-{slug}.md`)
- Produces: `docs/product/brief.md`
- Feeds into: `docs/product/requirements.md` (via `/create:project-requirements`)
