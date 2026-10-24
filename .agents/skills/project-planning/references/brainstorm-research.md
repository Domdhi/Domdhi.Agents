# Brainstorm and Research

Expert in problem space exploration, brainstorming facilitation, and research methodology. Knows how to guide structured ideation and validate assumptions.

## Brainstorming Report Template

```markdown
# Brainstorming Report: {Project Name}

**Date**: {YYYY-MM-DD}
**Participants**: {who contributed}
**Facilitator**: Claude (AI-assisted)

---

## Problem Space

### Problem Statement
{1-2 sentences describing the core problem}

### Who Suffers Most
{Primary affected users/stakeholders and the impact on them}

### Current Solutions & Their Gaps
| Current Solution | What Works | What Doesn't |
|-----------------|------------|--------------|
| {solution} | {pros} | {gaps} |

---

## Solution Ideas

### Idea 1: {Name}
- **Description**: {what it does}
- **Feasibility**: {Low/Medium/High} — {why}
- **Impact**: {Low/Medium/High} — {why}
- **Effort**: {S/M/L/XL}
- **Risks**: {key risks}

### Idea 2: {Name}
...

### Idea 3: {Name}
...

---

## Evaluation Matrix

| Idea | Feasibility | Impact | Effort | Risk | Score |
|------|------------|--------|--------|------|-------|
| {name} | H/M/L | H/M/L | S-XL | H/M/L | {1-10} |

---

## Recommended Direction
{Which idea(s) to pursue and why}

## Open Questions
- {Unanswered questions that need research}

## Next Steps
- {Concrete next actions}
```

## Research Findings Template

```markdown
# Research Findings: {Topic}

**Date**: {YYYY-MM-DD}
**Research Type**: {Market / Technical / Domain / Competitive}

---

## Executive Summary
{2-3 sentence summary of key findings}

## Research Questions
1. {Question being investigated}
2. {Question being investigated}

## Methodology
{How the research was conducted — web search, code analysis, documentation review, etc.}

## Findings

### Finding 1: {Title}
- **Evidence**: {What was found}
- **Confidence**: {High/Medium/Low}
- **Implication**: {What this means for the project}

### Finding 2: {Title}
...

## Recommendations
{What to do based on findings}

## Sources
- {Links or references}
```

## Quality Criteria

### Good Brainstorming Report
- Problem statement is specific, not vague ("users can't find documents quickly" not "the system is slow")
- At least 3 solution ideas explored
- Each idea has feasibility AND impact assessed
- Clear recommended direction with rationale
- Open questions are actionable, not rhetorical

### Good Research Findings
- Research questions are stated upfront
- Findings cite specific evidence
- Confidence levels are honest (not everything is "High")
- Recommendations connect directly to findings

### Claim Discipline

Apply these four rules to every claim in a research output:

1. **Permit explicit uncertainty.** When the evidence is thin or absent, say so directly: "I don't have enough information to confirm this." Hedged confidence ("Low") is not a substitute for acknowledging a gap — use both where they apply.

2. **Quote-first grounding.** Anchor each claim in an extracted quote, paraphrase, or source reference before stating the implication. The finding block's `Evidence` field is the vehicle: fill it before writing the implication, not after.

3. **Per-claim cite-or-retract.** Every factual assertion carries a source or is retracted. If a source cannot be named for a claim, either omit the claim or reframe it as an open question. Aggregated citations at the end of a section do not satisfy this rule — citations belong at the claim site.

4. **External and training-knowledge restriction.** Claims sourced from the model's training knowledge (rather than documents or searches conducted in the session) are marked as such: "Based on general knowledge — not verified in session." When the task is technical or time-sensitive, prefer verified sources over training recall, and say so when you cannot.

## Interview Questions (for brainstorming)

Use these when facilitating a brainstorm session:

1. **Problem Discovery**
   - "What problem are you trying to solve?"
   - "Who experiences this problem most acutely?"
   - "What happens today when someone encounters this problem?"
   - "How big is this problem? (users affected, frequency, cost)"

2. **Solution Exploration**
   - "What solutions have been tried before?"
   - "What would the ideal solution look like?"
   - "What constraints exist? (budget, timeline, tech, regulatory)"
   - "What's the simplest version that would still be valuable?"

3. **Validation**
   - "How would you measure success?"
   - "What's the biggest risk?"
   - "Who needs to approve this?"
   - "What's the timeline pressure?"

## Output Paths
- Feature-scoped output: `docs/modules/{feature}/brainstorm.md` or `docs/modules/{feature}/research.md`
- Project-wide output: `docs/.output/findings/research/{date}-{slug}.md`

## Question-Type Self-Check (for command authors)

When a command needs to ask the user something, classify each question as **closed-choice** or **free-form** before writing the prompt. Mismatching the type to the tool produces a worse interview than not asking at all — `AskUserQuestion` on a free-form ask forces an artificial menu; plain prose on a closed-choice ask wastes a round parsing free text into a category.

Run this checklist before merging any new command (or any edit to an existing command's interview/decision step):

- [ ] **Each user question is classified explicitly** as either closed-choice (finite options exist) or free-form (paragraph/sentence prose expected).
- [ ] **Closed-choice questions use `AskUserQuestion`** with 2–4 concrete options. Each option has both a label and a description. The first option is the recommendation when one exists.
- [ ] **Free-form questions use plain conversational prompts.** They are NOT wrapped in `AskUserQuestion` — that tool is for menus, not paragraph capture.
- [ ] **Free-form questions are explicitly marked** in the command file so a future editor doesn't migrate them to `AskUserQuestion` by mistake. Acceptable markers: `*(free-form)*`, `(free-form prose answer)`, or an inline note like "ask the user to describe X (free-form)".
- [ ] **No question with truly open-ended scope is forced into `AskUserQuestion`** (e.g., "describe your problem" should never be a 4-option menu — that's worse than not asking).
- [ ] **Mixed-type rounds split the questions visually** (per-question annotation) so readers can see at a glance which line uses which tool.

Borderline cases:

| Question | Closed or Free-form? | Why |
|---|---|---|
| "What's the project name?" | Free-form | One specific string; no finite menu. Default proposal is fine but the answer is an arbitrary name. |
| "What's the scale?" | Closed-choice | Small / Medium / Enterprise are well-defined buckets that drive routing. |
| "What's the tech stack?" | Free-form (usually) | Combinatoric — "Node + Postgres + React" is a sentence, not a menu. Becomes closed-choice only when you've narrowed to 2–4 specific stacks to compare. |
| "Should we extend X or build new Y?" | Closed-choice | Two pre-defined options with explicit trade-offs. Classic AskUserQuestion fit. |
| "How would you measure success?" | Free-form | Open exploration — wrong shape for a menu. |

When in doubt, run the question through this filter: *"Could a reasonable user respond with something I haven't anticipated?"* If yes → free-form. If no → closed-choice.

## Cross-References
- Produces: feature-scoped output goes to `docs/modules/{feature}/brainstorm.md` or `docs/modules/{feature}/research.md`; project-wide output goes to `docs/.output/findings/research/{date}-{slug}.md`
- Feeds into: `docs/product/brief.md` (via `/create:project-brief`)
