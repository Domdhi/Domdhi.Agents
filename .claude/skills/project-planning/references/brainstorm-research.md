# Brainstorm and Research

Guides structured problem-space exploration and validates assumptions. A good brainstorm leaves a specific problem statement, several assessed ideas and a recommended direction; good research states its questions up front and backs each finding with evidence and an honest confidence level.

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

## What good looks like

**Brainstorming report:** a specific problem statement ("users can't find documents quickly", not "the system is slow"), at least three ideas each assessed for feasibility and impact, a recommended direction with rationale, and open questions that are actionable.

**Research findings:** questions stated upfront, findings citing specific evidence, honest confidence levels (not everything "High"), and recommendations that follow from the findings.

### Claim Discipline

Apply these four rules to every claim in a research output:

1. **Permit explicit uncertainty.** When evidence is thin or absent, say so directly ("I don't have enough information to confirm this"). A "Low" confidence label does not replace acknowledging a gap; use both where they apply.
2. **Quote-first grounding.** Anchor each claim in an extracted quote, paraphrase or source reference before stating the implication. The finding block's `Evidence` field is the vehicle: fill it before the implication.
3. **Per-claim cite-or-retract.** Every factual assertion carries a source at the claim site, or is retracted or reframed as an open question. A citation list at the end of a section does not satisfy this.
4. **Mark training-knowledge claims.** A claim from the model's own knowledge rather than a document or search in this session is marked "Based on general knowledge — not verified in session". For technical or time-sensitive work, prefer verified sources and say when you cannot.

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

When a command asks the user something, classify the question as closed-choice or free-form first. The wrong tool makes a worse interview than not asking: `AskUserQuestion` on a free-form ask forces an artificial menu, and plain prose on a closed-choice ask costs a round parsing text into a category. Run this before merging a new command or an edit to an interview/decision step:

- [ ] Each user question is classified explicitly as closed-choice (finite options) or free-form (prose expected).
- [ ] Closed-choice questions use `AskUserQuestion` with 2-4 concrete options, each with a label and description, the recommendation first when one exists.
- [ ] Free-form questions use plain conversational prompts, not `AskUserQuestion`, and are marked in the command file (`*(free-form)*`, `(free-form prose answer)` or an inline note) so a later editor does not migrate them.
- [ ] No open-ended-scope question is forced into a menu ("describe your problem" is never a 4-option choice).
- [ ] Mixed-type rounds annotate each question so readers see which tool each uses.

| Question | Type | Why |
|---|---|---|
| "What's the project name?" | Free-form | One arbitrary string; a default proposal is fine. |
| "What's the scale?" | Closed-choice | Small / Medium / Enterprise are defined buckets that drive routing. |
| "What's the tech stack?" | Free-form (usually) | Combinatoric; closed-choice only once narrowed to 2-4 specific stacks. |
| "Should we extend X or build new Y?" | Closed-choice | Two pre-defined options with explicit trade-offs. |
| "How would you measure success?" | Free-form | Open exploration. |

When in doubt: could a reasonable user respond with something unanticipated? If yes, free-form; if no, closed-choice.

## Cross-References
- Produces: feature-scoped output goes to `docs/modules/{feature}/brainstorm.md` or `docs/modules/{feature}/research.md`; project-wide output goes to `docs/.output/findings/research/{date}-{slug}.md`
- Feeds into: `docs/product/brief.md` (via `/create:project-brief`)
