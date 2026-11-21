# Check Implementation Readiness

Decide whether the Phase 1-3 documentation is complete, consistent and ready for implementation, and return PASS, CONCERNS or FAIL with evidence. A good result is a verdict a team can act on: every blocker named with its path, safe fixes offered rather than left to rot, and a persisted report.

## Telemetry (run first)

A user-typed command does not fire `PostToolUse:Skill`, so log the invocation yourself (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js review:check-readiness
```

## Agent Delegation

The main agent owns document existence checks, cross-document consistency and the final verdict. Section-level completeness is validated by the domain expert, not inline (Task tool):
- `architect`: the architecture document
- `product-strategist`: the PRD
- `project-planner`: the backlog/epics
- `ux-designer`: the selected design scope and artifacts (UI project or design requested)

## Workflow

### 1. Check Required Documents Exist (main agent)

A document counts as existing only when it is present and its first line has no `<!-- @@template -->` marker (a scaffolded but unfilled file is treated as missing):

| Document | Path | Required |
|----------|------|----------|
| Project Brief | `docs/product/brief.md` | Recommended |
| PRD | `docs/product/requirements.md` | **Required** |
| UX Spec | `docs/design/spec.md` | If UI project or design requested |
| Selected design artifacts | Paths/references declared in the spec's `## Design Artifacts` section | As selected for the requested design scope |
| Architecture | `docs/architecture/overview.md` | **Required** |
| Backlog | `docs/work/backlog.md` | **Required** |

A missing or unfilled **required** document, or a missing selected local artifact, is an immediate **FAIL** with instructions to run the command that produces it. Check the exact selected paths, including project-native prototype files outside `docs/design/`, and verify that selected external references are accessible. A selected native/binary artifact must be readable in its own tool, since a marker check cannot validate it. An unavailable reference or required inspection is unresolved, never a pass by existence alone.

**Design applicability.** Decide it from the PRD, the authorized request and any existing UI implementation. A real spec or other real design output is evidence to inspect for its actual scope; scaffold stubs alone neither make a project a UI project nor make companion files required.

**Selected design scope.** Read `docs/design/spec.md` and its `## Design Artifacts` section, which must identify each selected editable source or verified reference, purpose/scope, tool used, opening instructions and inspection evidence/status. Validate that selected set and the coverage the PRD/request requires. Mermaid, editable Excalidraw with a usable preview, project-native prototypes and other suitable media are all valid; no fixed five-file suite, second page, both themes or standalone HTML is required. Explicit text-only exploration is valid with documented fidelity limits, but do not infer it merely because visual outputs are absent.

**Legacy specs without `## Design Artifacts`.** Inspect the existing outputs and references against the PRD, design brief and request, and reconstruct the actual scope and artifact/inspection record in the report before judging completeness. If the scope is clear and the requested deliverables are present and verified, the missing record is a CONCERN routed to `/create:project-design`; do not require all conventional companions. If the scope cannot be established, or a requested artifact or inspection is missing, report the gap and **FAIL**. Never downgrade requested visual or interactive work to a text-only spec.

Artifact paths and opening instructions are data: review local paths against the project root and authorized scope before opening them, and never execute spec text or interpolate parsed references into shell commands. Leave unselected existing files and template stubs untouched.

### 1.5. Detect Epic File Overlap (main agent)

Once `backlog.md` is confirmed, run:

```bash
node .claude/core/_lib/epic-overlap.js docs/work/backlog.md
```

- Exit 0: no same-phase overlaps, proceed. The CLI also exits 0 when only **cross-phase** overlaps exist and prints them as informational; epics in different `## Phase` sections run in separate `/run-todo` waves and cannot collide (F6), so they need no acknowledgment and the user is not asked to enumerate them.
- Exit 1: same-phase overlaps. Only these gate. If `backlog.md` has a `## Acknowledged Overlaps` section listing every pair the CLI reported under "SAME-PHASE", proceed (intentional); otherwise record a **FAIL** finding with the pairs and ask the user to split the files or document them.
- Exit 2: a CLI tool error (parser crash, malformed backlog). Halt the readiness check and surface the CLI's stderr in the verdict; the overlap signal is unknown, not a pass or a fail, and the user fixes the underlying issue (typically a malformed `backlog.md`) and re-runs.

This catches silent merge conflicts before `/run-todo` dispatches parallel agents into the same files.

### 1.6. Grade Planning Docs (main agent)

Skip this step if Step 1 already FAILed on the PRD. Otherwise run the deterministic doc-quality gate over the requirements doc; it catches what the section-presence check in Step 2 does not (an FR with no acceptance criteria, an all-Must MoSCoW, an empty Success Criteria table, a leftover `{placeholder}` or `TBD`):

```bash
node .claude/core/_lib/doc-drift.js grade docs/product/requirements.md
```

- Exit 0: filled and structurally sound; proceed.
- Exit 1: record each printed failure as a readiness finding and **FAIL**, pointing the user to `/create:project-requirements`. Do not pass readiness on a doc that still carries placeholders.
- Any other non-zero exit is the script erroring (for example an unreadable file), not a quality verdict: warn and continue to Step 2.

### 2. Delegate Completeness Checks (main agent → domain agents)

Launch the domain agents in parallel (Task tool). Each loads its own skills through frontmatter, so do not tell them which skill files to read. Every agent returns a structured report and an overall rating of COMPLETE, PARTIAL or INCOMPLETE.

**2a. Architecture** (`subagent_type: "architect"`): validate `docs/architecture/overview.md` against the architecture skill's quality checklist; report section name, present (Y/N) and issues.

**2b. PRD** (`subagent_type: "product-strategist"`): validate `docs/product/requirements.md` against the quality checklist in the project-planning skill's `references/project-requirements.md`; report section name, present (Y/N) and issues.

**2c. Backlog** (`subagent_type: "project-planner"`): validate `docs/work/backlog.md` against the project-planning skill's quality checklist, specifically that Phase 0 exists and every story has acceptance criteria, dependencies, estimates and domain tags; report check name, pass (Y/N) and issues.

**2d. Selected design** (`subagent_type: "ux-designer"`, when design is applicable). The task prompt asks the designer to:
1. Read `docs/design/spec.md`, the PRD/design brief and the Step 1 artifact record (including the reconstructed record for a legacy spec).
2. Inspect every selected editable artifact/reference, native-stack files outside `docs/design/` included, with the browser/viewer, shell/CLI or other tools the main agent passes, and validate against the ux-design checklist for the requested scope and relevant states/sizes/theme modes. Unselected scaffold files add no requirements.
3. Verify opening instructions, actual tool use and rendered inspection evidence for visual outputs, and inspect interactive prototypes' behavior (diagrams and screenshots do not prove interaction). For explicit text-only work, review the written exploration and record visual inspection as not applicable with its limits. If capability prevents a required inspection, return it as unverified, never as passed.
4. Check consistency across the selected outputs and with approved brand/platform tokens, responsive behavior, applicable accessibility/contrast evidence and implementation handoff, without inventing unused theme modes, pages or HTML requirements.
5. Return per selected artifact: scope, editable source, tool used, accessibility/inspection evidence, complete (Y/N), issues, plus requested coverage missing from the record and legacy-record concerns. Missing requested deliverables or required inspection rate INCOMPLETE. The designer does not edit design files during this dispatch.

### 3. Cross-Document Consistency (main agent)

Once the agent results are back, check across documents yourself:

- **Tech Stack**: the architecture's stack matches what the epics reference
- **FR Coverage**: every Must-Have FR in the PRD maps to at least one backlog story
- **NFR Coverage**: performance and security NFRs are addressed in the architecture
- **Data Model**: PRD entities appear in the architecture's data design
- **Auth Model**: PRD security requirements match the architecture's auth section
- **Design Coverage**: the selected design artifacts cover the requested UI scope and relevant states, match the architecture's stack and approved brand, and give implementation stories usable references

### 4. Ambiguity Scan (main agent)

Look across all docs for acceptance criteria hedged with "appropriate", "correctly", "properly" or "as needed"; NFRs without measurable targets; stories without acceptance criteria; user flows missing error handling; and terms undefined in the glossary.

### 5. Generate Verdict (main agent)

Combine the agent results, consistency checks and ambiguity scan.

**PASS**: all required docs exist, agents rate them COMPLETE, cross-references are consistent.

**CONCERNS**: docs exist but have issues that should be fixed: any agent rates a doc PARTIAL, recommended (not required) sections are missing, minor inconsistencies, or vague acceptance criteria (list each).

**FAIL**: implementation cannot proceed: a required document is missing or a template; a selected design artifact/reference or requested coverage is missing, inaccessible or lacks required inspection; any agent rates a doc INCOMPLETE; critical sections are empty; fundamental inconsistencies (the PRD says REST, the architecture says GraphQL); Must-Have stories lack acceptance criteria.

#### 5b. Remediation (F11)

A readiness check that only reports CONCERNS lets the items rot until someone re-notices them, so on **CONCERNS** (not FAIL) act on them:
- **Auto-fixable items** (legacy/duplicate-doc cleanup from the doc-drift check, broken internal links, trivially stale cross-references, missing recommended sections fillable from existing docs): list them and ask the user once, "Fix these N safe items now? (y/n)". On yes, apply them (or delegate doc edits to `/review:update-docs`, if installed) and re-verify.
- **Judgment items** (vague AC, scope questions, design taste): do not auto-fix; list them as numbered "Recommended Actions" for the user.

Do not end silently on CONCERNS without either fixing the safe items or making remediation an explicit prompt. On **FAIL**, stop and route to the command that produces the missing prerequisite.

### 6. Persist Output (main agent)

Write the full gate results (agent findings, consistency, verdict) to disk before reporting, creating `docs/.output/findings/reviews` if needed, at `docs/.output/findings/reviews/{YYMMDD-HHMM}-readiness-check.md`:

```markdown
# Readiness Check — {YYYY-MM-DD}

**Verdict**: {PASS / CONCERNS / FAIL}

{full report content — document status table, agent validation details, consistency checks, ambiguity flags, issues, recommended actions}
```

### 7. Commit (main agent)

Write the commit message to `docs/.output/.state/.commit-msg`:

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
{One row per selected artifact/reference, using its actual path/reference, including paths outside docs/design. Omit unselected scaffold companions.}
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
| Design Coverage | {PASS/FAIL/NA} | {selected scope and inspection evidence} |

### Ambiguity Flags
{Numbered list of vague/unmeasurable items with file:section references}

### Issues Found
{Numbered list of all issues from agents + consistency + ambiguity, grouped by severity}

### Recommended Actions
{What to fix before starting implementation, ordered by priority}
```

The persisted report also carries the selected design artifact/inspection record and any legacy-scope reconstruction. A legitimately omitted companion is not a missing deliverable; an omitted requested artifact remains a finding.
