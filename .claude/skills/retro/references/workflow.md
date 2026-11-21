# Retrospective

Analyze a completed epic to extract what worked, what did not, and what the system should learn. A review of the epic's commits runs first and feeds the retro (the same Phase 1 to Phase 2 flow as `/sweep`); the result is `docs/.output/findings/reviews/retro-{epic-slug}.md`. A good retro ties real findings to root causes, records reusable patterns in memory, and, when run standalone, leaves the actionable findings fixed rather than filed.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill`. Log the invocation first so fleet analytics see human-driven runs (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js retro
```

## Agent delegation

The main agent identifies the epic, gathers data, classifies risk, extracts patterns to memory, syncs docs, and owns every git, memory and commit operation. Two agents do the analytical work; delegate both rather than doing them inline:
- `code-reviewer` (Task tool, `subagent_type: "code-reviewer"`) performs the review pass (Step 2).
- `doc-writer` (Task tool, `subagent_type: "doc-writer"`) writes the retrospective (Step 5).

Background reviewers often go idle without delivering their report. On an idle notification with no findings, `SendMessage` a "deliver your full findings now" nudge before anything else; the work is done and only delivery failed. If a reviewer dies, re-dispatch a fresh one; never fall back to an inline review by the orchestrator.

## Variables

INPUT: $ARGUMENTS

Flags:
- `--skip-review`: skip the review pass (Step 2). Use it when the epic's code was already reviewed (a prior `/review:code-review`, or `/sweep` Phase 1). Existing findings still go into the retro (Steps 3 and 5) instead of being regenerated.

## Workflow

### 1. Identify epic (main agent)

With INPUT, match it against epic names or numbers in `docs/work/backlog.md`. Without it, take the most recently completed epic (all stories `[x]`); if none is fully complete, ask which epic to review. Capture the epic's commit range (first to last commit) from `git log --oneline`: Step 2 reviews it and Step 3 derives metrics from it.

Check for an existing `docs/.output/findings/reviews/retro-{epic-slug}.md`. An epic can gain a story after it was retro'd, which makes the prior retro stale but not wrong. Then review only the delta since the prior retro's commit, and have the `doc-writer` write one complete updated retro at the same path, folding in the prior retro's still-valid analysis. The `retro-*.md` glob expects one retro per epic.

### 2. Review pass (main agent → code-reviewer)

Skip this step with `--skip-review`, or when the plan's wave log already holds a `Review — final` entry for this epic (`/run-todo` closed it with a final review; a second review of the same scope is not run). Either way, still gather any existing review findings for the epic (a recent `docs/.output/findings/reviews/*-code-review.md`, or `/sweep` Phase 1 output) and carry them (including that final-review entry's findings) into Steps 3 and 5.

Follow `.agents/skills/code-review/references/review-cadence.md`: this is the final review of finished work against its acceptance criteria. Review the epic's diff (`git diff {first}^..{last}`) grouped by seam; for a large multi-theme epic dispatch one reviewer per theme in parallel and consolidate, as `/sweep` Phase 1 does. Skip generated or vendored code. Money, authentication and access changes also get a `security-auditor` review (review-cadence firm line 2). Findings are the retro's first analytical input and feed *What Didn't Go Well*, *System Improvements* and *Code Review Findings*.

- Read each story's Execution Log entry for a noted dispatch fallback ("Path A", "no subagent available", "implemented directly by main agent"). A story that shipped that way got no independent review at wave time, and an epic-wide diff review has missed real MAJOR bugs in exactly those stories. Give each such story its own review scoped to its files, and call it out in the findings table.
- Classify risk tiers from the `code-reviewer` agent's risk map (`## Project Context > ### Risk Map`) when one exists, else treat every file as MEDIUM. Overall depth is the highest tier present (any HIGH is Deep, all MEDIUM is Standard, all LOW is Fast-Lane).
- Model routing: overall tier HIGH passes `model: "opus"`; MEDIUM or LOW omits `model:` (the `standard` default). The reviewer auto-loads the `code-review` skill; do not paste the rubric.
- The task prompt includes the diff, the architecture standards from `docs/architecture/overview.md` and `CLAUDE.md` (if present), relevant memory (`node .claude/core/memory-manager.js search "{domain}"`, `… list constraints`, `… list decisions`), the risk classification, and the instruction to evaluate correctness, security, performance, architecture compliance, memory-pattern compliance and test coverage, classifying findings CRITICAL > MAJOR > MINOR > NIT.
- Consolidate the full findings table. It goes into the retro's *Code Review Findings* section; there is no separate file, which keeps review dumps out of the `retro-*.md` glob that `/review:optimize-agents` and `/review:changelog` scan.

Posture: a standalone retro is bound by the operating standard (`.agents/skills/verification-before-completion/SKILL.md`, "Autonomous and batch commands") and resolves actionable findings in the same pass (Step 6.5). Under `/sweep`, which passes `--skip-review`, Phase 3 owns the fix loop and the retro stays diagnostic so nothing is fixed twice. For a deeper second opinion, run `/review:code-review --deep` or `--council` separately.

### 3. Gather data (main agent)

- Review findings from Step 2: severity counts and notable items.
- Git: commits for this epic, files changed, lines added and removed, first-to-last commit dates.
- TODO files: the Execution Log and Key Decisions for this epic's stories, and any stories deferred `[~]` or blocked `[!]`.
- Work documents: plans in `docs/.output/plans/` for this epic, and any revisions or course corrections.
- Memory: `node .claude/core/memory-manager.js report`, for existing patterns relevant to this epic.
- Telemetry: `docs/.output/.state/telemetry/command-usage.jsonl` if present, filtered to the epic's date range. Compute command frequency (`command_invocation` events by `command`), gate results (`gate_run` events by `outcome`) and command chains (the command sequence per `session_id`). If the file is missing or empty, note "No telemetry data available" and continue.

### 4. Doc sync check (main agent)

Run `/check-sync` for documentation drift from this epic's implementation, and capture the findings for the retro.

### 5. Delegate to doc-writer (main agent → doc-writer)

Task tool with `subagent_type: "doc-writer"`. The agent auto-loads the `project-planning` skill. The prompt includes:
1. The epic name, number and story list.
2. All data from Step 3 (git stats, TODO context, work doc summaries, memory patterns, telemetry stats).
3. The full review findings table from Step 2, and the doc sync findings from Step 4.
4. The output path `docs/.output/findings/reviews/retro-{epic-slug}.md` and the template below.
5. What to analyze: what went well, what did not, key decisions, metrics, recommendations. Populate *Code Review Findings* from Step 2 and weave CRITICAL and MAJOR findings into *What Didn't Go Well* and *System Improvements* (a shipped bug is a "didn't go well"; a finding that points at a missing convention is a system improvement). Include a *System Improvements* section evaluating agent, skill, command and memory effectiveness, and the Doc Sync Summary.
6. The output boundary, verbatim: *"Your ONLY output is the retro markdown at the specified path. Do NOT create additional files. Do NOT write memories. Do NOT write to `.claude/agent-memory/`, `docs/.output/.memory/`, or anywhere else. Main Agent handles memory extraction in Step 6."* The doc-writer over-delivers when it sees a multi-step workflow and has authored phantom memory directories without this boundary.

Output template:

```markdown
# Retrospective: {Epic Name}

**Date**: {YYYY-MM-DD}
**Epic**: {N} — {name}
**Duration**: {start date} → {end date}
**Stories**: {completed}/{total}

---

## What Went Well
- {item}
- {item}

## What Didn't Go Well
- {item with context and root cause — include any shipped CRITICAL/MAJOR code-review findings}

## Key Decisions Made
| Decision | Rationale | Outcome |
|----------|-----------|---------|
| {decision} | {why} | {good/bad/neutral} |

## Patterns Extracted
| Pattern | Confidence | Status |
|---------|-----------|--------|
| {name} | {0-1} | {New / Promoted / Existing} |

## Code Review Findings
{Summary of the Step 2 code-review pass. Skipped? Write "Review skipped (--skip-review) — findings sourced from {prior review file}" or "No prior review available".}

**Verdict**: {Approved / Approved with Comments / Changes Requested}   **Overall depth**: {Deep / Standard / Fast-Lane}

| Severity | Count | Notable |
|----------|-------|---------|
| CRITICAL | {n} | {one-liner or —} |
| MAJOR | {n} | {one-liner or —} |
| MINOR | {n} | {one-liner or —} |
| NIT | {n} | {one-liner or —} |

{List each CRITICAL and MAJOR finding in full below the table — file:line, what, why it matters. List MINOR/NIT as one line each (file:line + one-liner) — every finding nits-and-up must be visible so Step 6.5 resolves all of them; nothing is buried in a count.}

## Metrics
- **Commits**: {count}
- **Files changed**: {count}
- **Lines**: +{added} / -{removed}
- **Build failures**: {count}
- **Test failures**: {count}
- **Code-review findings**: {critical}C / {major}M / {minor}m / {nit} nits
- **Stories completed first attempt**: {count}/{total}

## Skill Usage Telemetry

### Command Frequency
| Command | Count |
|---------|-------|
| {command} | {count} |

### Gate Results
| Gate | Pass | Fail | Pass Rate |
|------|------|------|-----------|
| gate:build | {n} | {n} | {%} |
| gate:test | {n} | {n} | {%} |

### Common Command Chains
- {session}: {command1} → {command2} → {command3}

*{Or "No telemetry data available for this period" if no data}*

## Recommendations for Next Epic
- {actionable recommendation}
- {actionable recommendation}

## System Improvements
| Area | Finding | Recommendation |
|------|---------|----------------|
| Agent: {name} | {what happened} | {update instructions / create new agent / no change} |
| Skill: {name} | {what happened} | {update template / create new skill / no change} |
| Command: {name} | {what happened} | {add step / fix workflow / no change} |
| Memory | {pattern useful or missing} | {create pattern / update confidence / no change} |

## Doc Sync Summary
{Summary from `/check-sync` — note any architecture drift, story status drift, or dead references}
```

### 6. Extract patterns to memory (main agent)

Review the analysis for reusable patterns and create entries:

```bash
node .claude/core/memory-manager.js create patterns "{pattern-id}" '{"description":"...", "confidence": 0.8}'
```

A pattern `/do` created at confidence 0.6 that this epic validated is promoted to 0.8 or higher.

### 6.5. Resolve actionable findings in-pass (standalone runs only)

Skip this step under `/sweep` (`--skip-review` set): Phase 3 owns resolution there. Otherwise the retro is done when the worth-fixing findings are fixed, not filed:

- Every review finding, CRITICAL down to NIT, is fixed and re-verified (delegate non-trivial fixes to `general-purpose`, batching small ones, as `/do` does), except the three reasons in the `code-review` skill ("One review pass, then done"): wrong, out of scope with a named follow-up, or a coverage-only `TEST-GAP` on a `standard` scope. The limit is scope, not severity: stay within the epic's changed code and skip generated or vendored artifacts.
- Mechanical doc drift from Step 4 is fixed.
- Single-target System Improvement recs are applied unless they change a skill's or a role's behavior (Owner Decision 11). A typo, stale-pointer or pinned-text fix is applied. A skill behavior edit takes the verdict path and stays propose-only; a role behavior edit has no verdict path yet and is staged for review.
- The code classifies a skill edit, never you. Snapshot the live skill directory and write the edited files as a candidate in a workspace (`docs/.output/evolution/skills/{date}/{skill}-workspace/` holding `skill-snapshot/` and `candidate/`), then run `node .claude/core/skill-evolution.js apply <skill> --run <workspace> --route side-door`; it writes nothing. Exit 0 with `kinds` of `typo`, `stale-pointer` or `pinned-text` is a side-door fix. Exit 1 with `failedStep: side-door` is a behavior edit: do not apply it; record it as a proposal in `docs/.output/evolution/skills/{date}/proposals.md` for `/review:evolve-skills`, whose `verdict` decides it.
- Apply a side-door fix only when the retro request explicitly authorizes applying skill fixes: re-run the command with `--mode apply --branch auto/retro-{date}-{skill} --candidate-sha256 {candidateSha256 from the first run}` (the workspace stays untracked under `docs/.output/evolution/`: the helper leaves exactly that path out of its clean-tree check and restore, but needs every other path clean, so take this bullet first, before the review-finding and doc-drift fixes above write tracked files). The delta lands uncommitted on that local branch after the drift, scope, render, conformance and gate steps, and any failure restores the tree. Commit the printed `files` on that branch through `commit.js`, switch back and leave the merge to the owner. Never push.
- Re-run `node .claude/core/gate.js test` after any code fix; everything is green before the Step 7 commit.

Step 8 surfaces only genuine forks: mutually-exclusive approaches, irreversible or outward actions, or scope that materially expands (a new agent, a taxonomy change).

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage everything this command created or modified (the retro, the Step 6.5 fixes, memory updates) and commit with a descriptive message.

### 8. Report (main agent)

```markdown
## Retrospective Complete

**Output**: docs/.output/findings/reviews/retro-{epic-slug}.md
**Code review**: {critical}C/{major}M/{minor}m findings ({Deep/Standard/Fast-Lane}) — or "skipped (--skip-review)"
**Resolved in-pass**: {N findings/recs fixed + re-verified (gate green), or "none — diagnostic only (ran under /sweep; Phase 3 resolves)"}
**Forks for you**: {genuine decisions only — or "none — all actionable findings resolved in-pass"}
**Patterns extracted**: {count}
**Key takeaway**: {1 sentence}

**Committed**: {hash} — `docs: /retro — {summary}`
**Next epic**: {name of next epic to implement}
```
