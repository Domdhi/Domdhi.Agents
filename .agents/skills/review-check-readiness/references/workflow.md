# Check Implementation Readiness

Validate that all Phase 1-3 documentation is complete, consistent, and ready for implementation. Returns PASS, CONCERNS, or FAIL.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:check-readiness
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle document existence checks, cross-document consistency, and the final verdict. Domain agents handle completeness validation for their area. Do NOT validate document sections inline — delegate to the domain expert.

**Agents used** (via Task tool):
- `architect` — validates architecture document
- `product-strategist` — validates PRD
- `project-planner` — validates backlog/epics
- `ux-designer` — validates design suite (if UI project)

## Workflow

### 1. Check Required Documents Exist (main agent)

Check each document exists AND is not a template (no `<!-- @@template -->` marker on first line):

| Document | Path | Required |
|----------|------|----------|
| Project Brief | `docs/product/brief.md` | Recommended |
| PRD | `docs/product/requirements.md` | **Required** |
| UX Spec | `docs/design/spec.md` | If UI project |
| Wireframes | `docs/design/wireframes.md` | If UI project |
| Light Theme | `docs/design/theme.light.md` | If UI project |
| Dark Theme | `docs/design/theme.dark.md` | If UI project |
| Mock Layout | `docs/design/mock.html` | If UI project |
| Architecture | `docs/architecture/overview.md` | **Required** |
| Backlog | `docs/work/backlog.md` | **Required** |

**Template check**: Read the first line of each file. If it contains `<!-- @@template -->`, treat the file as non-existent (scaffolded but unfilled).

If any **required** doc is missing or is a template → **FAIL** immediately with instructions.

**Detect UI project**: If any design file exists (non-template), treat all design files as expected.

### 1.5. Detect Epic File Overlap (main agent)

After confirming `backlog.md` exists, run the epic-overlap CLI:

```bash
node .claude/core/_lib/epic-overlap.js docs/work/backlog.md
```

- Exit 0 (no **same-phase** overlaps) → proceed to step 2. Note: the CLI now exits 0 even when **cross-phase** overlaps exist — those are printed as *informational only*. Epics in different `## Phase` sections run in separate `/run-todo` waves and physically cannot collide, so they do **not** require acknowledgment (F6). Do not ask the user to enumerate them.
- Exit 1 (**same-phase** overlaps found) → only same-phase pairs gate. Check whether `backlog.md` contains a `## Acknowledged Overlaps` section listing every **same-phase** pair the CLI reported under "SAME-PHASE". If yes → proceed (intentional). If no → **FAIL** finding; record the same-phase pairs and ask the user to split the files or document them.
- Exit 2 (CLI tool error — e.g., parser crash, malformed backlog the parser can't read) → report the error and halt the readiness check; do **not** treat as a gate decision. The overlap signal is unknown, not pass/fail. Surface the CLI's stderr in the verdict so the user can fix the underlying issue (typically a malformed `backlog.md`) and re-run.

This catches silent merge conflicts before `/run-todo` dispatches parallel agents into the same files — without the false-burden of hand-acknowledging cross-phase pairs that can't collide.

### 1.6. Grade Planning Docs (main agent)

Skip this step if Step 1 already FAILed (the PRD was missing or a template stub) — there is nothing real to grade. Otherwise run the deterministic doc-quality gate over the requirements doc. This catches placeholder tokens and structural gaps that the section-presence check in step 2 does not — an FR with no acceptance criteria, an all-Must MoSCoW, an empty Success Criteria table, or a leftover `{placeholder}`/`TBD`:

```bash
node .claude/core/_lib/doc-drift.js grade docs/product/requirements.md
```

- Exit 0 → the doc is filled and structurally sound; proceed to step 2.
- Exit 1 → the printed failures list what is unfilled. Record each as a readiness finding and **FAIL** the check, pointing the user back to `/create:project-requirements` to fill the gaps. Do not pass readiness on a doc that still carries placeholders.
- A different non-zero exit (the script erroring, not a quality verdict — e.g. the file unreadable for an infrastructure reason) → warn and continue to step 2; do not block readiness on a tooling failure.

### 2. Delegate Completeness Checks (main agent → domain agents)

Launch domain agents **in parallel** via Task tool. Each agent auto-loads its skills via frontmatter — do NOT tell them which skill files to read.

**2a. Architecture validation** — `subagent_type: "architect"`

Task prompt:
1. Read `docs/architecture/overview.md`
2. Validate completeness against the architecture skill's quality checklist
3. Return a structured report: section name, present (Y/N), issues found
4. Rate overall: COMPLETE, PARTIAL, or INCOMPLETE

**2b. PRD validation** — `subagent_type: "product-strategist"`

Task prompt:
1. Read `docs/product/requirements.md`
2. Validate completeness against the project-planning skill's `references/project-requirements.md` quality checklist
3. Return a structured report: section name, present (Y/N), issues found
4. Rate overall: COMPLETE, PARTIAL, or INCOMPLETE

**2c. Backlog validation** — `subagent_type: "project-planner"`

Task prompt:
1. Read `docs/work/backlog.md`
2. Validate completeness against the project-planning skill's quality checklist
3. Check: Phase 0 exists, every story has AC, dependencies specified, estimates present, domain tags present
4. Return a structured report: check name, pass (Y/N), issues found
5. Rate overall: COMPLETE, PARTIAL, or INCOMPLETE

**2d. Design suite validation** (only if design files exist) — `subagent_type: "ux-designer"`

Task prompt:
1. Read all design files: `docs/design/spec.md`, `docs/design/wireframes.md`, `docs/design/theme.light.md`, `docs/design/theme.dark.md`, `docs/design/mock.html`
2. Validate completeness against the ux-design skill's quality checklist
3. Check cross-file consistency: token names match across all 5 files, WCAG compliance table present
4. Return a structured report: file name, complete (Y/N), issues found
5. Rate overall: COMPLETE, PARTIAL, or INCOMPLETE

### 3. Cross-Document Consistency (main agent)

After agent results return, perform cross-document checks yourself:

- **Tech Stack**: Architecture tech stack matches what epics reference
- **FR Coverage**: Every Must-Have FR from PRD maps to at least one story in backlog
- **NFR Coverage**: Performance and security NFRs addressed in architecture
- **Data Model**: PRD entities appear in architecture data design
- **Auth Model**: PRD security requirements match architecture auth section

### 4. Ambiguity Scan (main agent)

Scan for red flags across all docs:
- Acceptance criteria with words: "appropriate", "correctly", "properly", "as needed"
- NFRs without measurable targets
- Stories without acceptance criteria
- Missing error handling in user flows
- Undefined terms not in glossary

### 5. Generate Verdict (main agent)

Combine agent results + consistency checks + ambiguity scan:

**PASS** — All required docs exist, agents rate them COMPLETE, cross-references are consistent

**CONCERNS** — Docs exist but have issues that should be fixed:
- Any agent rates a doc as PARTIAL
- Missing recommended (not required) sections
- Minor inconsistencies
- Vague acceptance criteria (list each one)

**FAIL** — Cannot proceed to implementation:
- Required document missing or is a template
- Any agent rates a doc as INCOMPLETE
- Critical sections empty
- Fundamental inconsistencies (e.g., PRD says REST but architecture says GraphQL)
- No acceptance criteria on Must-Have stories

#### 5b. Remediation (F11) — don't just flag, offer to fix

A readiness check that only reports CONCERNS and stops leaves the items to rot until a human re-notices them. On **CONCERNS** (not FAIL):
- **Auto-fixable items** — legacy/duplicate-doc cleanup (from the doc-drift check), broken internal links, trivially stale cross-references, missing recommended sections you can fill from existing docs: list them, then **ask the user once** "Fix these N safe items now? (y/n)". On yes, apply them (or delegate to `/review:update-docs` for doc edits) and re-verify.
- **Judgment items** — vague AC, scope questions, design taste: do NOT auto-fix; surface them as an explicit, numbered "Recommended Actions" follow-up the user must act on.

Never silently end on CONCERNS without either fixing the safe items or making the remediation an explicit prompted step. On **FAIL**, stop and route to the command that produces the missing prerequisite.

### 6. Persist Output (main agent)

Write the full gate results to disk before reporting:

```bash
mkdir -p docs/.output/findings/reviews
```

Write the complete readiness check output (all agent findings + consistency + verdict) to:
`docs/.output/findings/reviews/{YYMMDD-HHMM}-readiness-check.md`

File format:
```markdown
# Readiness Check — {YYYY-MM-DD}

**Verdict**: {PASS / CONCERNS / FAIL}

{full report content — document status table, agent validation details, consistency checks, ambiguity flags, issues, recommended actions}
```

### 7. Commit (main agent)

Stage and commit the readiness check output file:

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /review:check-readiness — {PASS/CONCERNS/FAIL}, {N} issues found
```

Then run:

```bash
git add docs/.output/findings/reviews/{YYMMDD-HHMM}-readiness-check.md
node .claude/core/commit.js
```

### 8. Report (main agent)

```markdown
## Implementation Readiness Check

**Output**: `docs/.output/findings/reviews/{YYMMDD-HHMM}-readiness-check.md`

### Verdict: {PASS / CONCERNS / FAIL}

### Document Status
| Document | Exists | Complete | Rating | Issues |
|----------|--------|----------|--------|--------|
| product/brief.md | {Y/N} | {Y/N} | {COMPLETE/PARTIAL/INCOMPLETE/—} | {count} |
| product/requirements.md | {Y/N} | {Y/N} | {agent rating} | {count} |
| design/spec.md | {Y/N/NA} | {Y/N} | {agent rating} | {count} |
| design/wireframes.md | {Y/N/NA} | {Y/N} | {agent rating} | {count} |
| design/theme.light.md | {Y/N/NA} | {Y/N} | {agent rating} | {count} |
| design/theme.dark.md | {Y/N/NA} | {Y/N} | {agent rating} | {count} |
| design/mock.html | {Y/N/NA} | {Y/N} | {agent rating} | {count} |
| architecture/overview.md | {Y/N} | {Y/N} | {agent rating} | {count} |
| backlog.md | {Y/N} | {Y/N} | {agent rating} | {count} |

### Agent Validation Details
{For each agent that ran, include their structured findings — section-by-section breakdown}

### Consistency Checks
| Check | Status | Notes |
|-------|--------|-------|
| FR Coverage | {PASS/FAIL} | {details} |
| NFR Coverage | {PASS/FAIL} | {details} |
| Tech Stack Match | {PASS/FAIL} | {details} |
| Data Model Match | {PASS/FAIL} | {details} |
| Auth Model Match | {PASS/FAIL} | {details} |

### Ambiguity Flags
{Numbered list of vague/unmeasurable items with file:section references}

### Issues Found
{Numbered list of all issues from agents + consistency + ambiguity, grouped by severity}

### Recommended Actions
{What to fix before starting implementation, ordered by priority}
```
