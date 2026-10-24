# Retrospective

Analyze a completed epic to extract lessons learned and patterns. Runs a **code-review pass over the epic's commits first** — its findings feed the retro (mirroring `/sweep`'s Phase 1→2 flow) — then produces `docs/.output/findings/reviews/retro-{epic-slug}.md`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js retro
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle epic identification, data gathering, risk classification, pattern extraction to memory, and doc sync. The `code-reviewer` agent performs the code-review pass (Step 2); the `doc-writer` agent writes the retrospective (Step 5). Do NOT perform the review or write the retro document inline — delegate both via Task tool. You DO own all git/memory/commit operations.

**Agents**:
- `code-reviewer` (via Task tool with `subagent_type: "code-reviewer"`) — the code-review pass (Step 2)
- `doc-writer` (via Task tool with `subagent_type: "doc-writer"`) — the retrospective analysis (Step 5)

> **Idle-without-delivery is expected, not anomalous — nudge immediately.** Background reviewer agents recurringly go idle without sending their report (confirmed in the field twice: 3/4 agents in one epic retro, 3/8 in a maintenance sweep). On an idle notification with no delivered findings, immediately `SendMessage` a "deliver your full findings now" nudge rather than waiting or re-dispatching — the work is done; only the delivery hop failed. If a reviewer agent *dies* (not idles), re-dispatch a fresh reviewer; never silently downgrade to an orchestrator-inline review.

## Variables

INPUT: $ARGUMENTS

**Flags:**
- `--skip-review` — skip the built-in code-review pass (Step 2). Use when this epic's code was **already reviewed** — a prior standalone `/review:code-review` run, or inside `/sweep` (whose Phase 1 already did it). When skipped, still fold any **existing** code-review findings into the retro (Steps 3 & 5) instead of re-generating them.

## Workflow

### 1. Identify Epic (main agent)

**If INPUT provided:**
- Match against epic names/numbers in `docs/work/backlog.md`

**If no INPUT:**
- Find the most recently completed epic (all stories `[x]`)
- If none fully complete, ask user which epic to review

Capture the epic's **commit range** (first → last commit) from `git log --oneline` — Step 2 reviews this range and Step 3 derives metrics from it.

**Prior-retro check.** Before scoping Step 2, check for an existing `docs/.output/findings/reviews/retro-{epic-slug}.md`. An epic can grow a story *after* it was already retro'd (e.g. a cross-epic gap-closure story assigned post-hoc) — the prior retro is then stale, not wrong: an accurate partial record that predates completion. When this happens: scope Step 2's review to only the **delta since the prior retro's commit** (don't re-review code it already covered), and instruct the `doc-writer` (Step 5) to write one **complete, updated** retro at the same path — incorporating the prior retro's still-valid analysis plus the new delta — not a second file (the `retro-*.md` glob expects one retro per epic).

### 2. Run Code-Review Pass (main agent → code-reviewer)

> **Skip this entire step if `--skip-review` is set** — but still gather any pre-existing code-review findings for this epic (a recent `docs/.output/findings/reviews/*-code-review.md`, or `/sweep` Phase 1 output) and carry them into Steps 3 & 5.

Reuses the `/review:code-review` methodology, scoped to the epic. This is the retro's first analytical input — a fresh review whose findings surface in *What Didn't Go Well*, *System Improvements*, and the *Code Review Findings* section.

1. **Scope** = the epic's commit range from Step 1. Build the diff, e.g. `git diff {first}^..{last}`. **Skip generated/vendored code** (lockfiles, `dist/`, `*.min.*`, migration scaffolding, snapshots) — sanity-check intent only, never review generated line volume.
1b. **Path-A gap-closure check.** Read each story's Execution Log entry in the epic's TODO for a noted dispatch fallback ("Path A", "no subagent available", "implemented directly by main agent"). A story that shipped via Path A got no independent subagent review at wave time — epic-wide diff review alone has historically missed real MAJOR bugs sitting in exactly these stories. If any story is flagged, dispatch a **dedicated gap-closure review scoped to that story's files** (not just folded into the epic-wide diff) in addition to the normal Step 2 pass, and call it out in the findings table.
2. **Classify risk tiers.** If a risk map exists (`code-reviewer` agent's `## Project Context > ### Risk Map`), match each changed file to a tier (HIGH / MEDIUM / LOW); otherwise default all files to MEDIUM. Overall review depth = the highest tier present (any HIGH → Deep; all MEDIUM → Standard; all LOW → Fast-Lane).
3. **Dispatch `code-reviewer`** via Task tool. **Model routing:** overall tier **HIGH** → pass `model: "opus"`; **MEDIUM or LOW** → omit `model:` (`standard` default). For a large multi-theme epic, dispatch one reviewer per theme in parallel and consolidate (as `/sweep` Phase 1 does). The agent auto-loads the `code-review` skill — do not paste the rubric. The task prompt must include:
   - The diff (or per-theme diffs) to review
   - Architecture standards from `docs/architecture/overview.md` + `CLAUDE.md` (if present)
   - Relevant memory patterns/constraints: `node .claude/core/memory-manager.js search "{domain}"`, `… list constraints`, `… list decisions`
   - The risk classification table (per-file tier + overall depth)
   - Instruction to evaluate Correctness, Security, Performance, Architecture Compliance, Memory Pattern Compliance, Test Coverage, and classify findings CRITICAL > MAJOR > MINOR > NIT
4. **Consolidate** the findings (full table). They are now retro input — the `doc-writer` writes them into the retro's *Code Review Findings* section in Step 5, so there's **no separate file** (one artifact: the retro doc). This keeps the retro out of the `retro-*.md` glob's way (`/review:optimize-agents` + `/review:changelog` scan that glob for retrospectives, not review dumps).

> **Posture: resolve in-pass when standalone; defer to the wrapper inside `/sweep`.** A retro you run directly is bound by the operating standard like everything else — it does NOT just file findings for you to action later. After producing the retro doc it **resolves the actionable findings in the same pass** (Step 6.5): CRITICAL/MAJOR code-review findings, mechanical doc-drift, and clear single-target System-Improvement recs get fixed and re-verified; only genuine FORKS (mutually-exclusive approaches, irreversible/outward actions, a new-agent/taxonomy-scale decision) are surfaced for your call. The ONE exception: when retro runs **under `/sweep`** (which passes `--skip-review`), sweep's Phase 3 owns the fix loop — retro stays diagnostic there so nothing is fixed twice. For a deeper second opinion, run `/review:code-review --deep` or `--council` separately. (Canonical standard: `.claude/skills/verification-before-completion/SKILL.md` → "Autonomous & batch commands".)

### 3. Gather Data (main agent)

**From the Code-Review Pass (Step 2):**
- The consolidated findings table (severity counts + notable items) — feeds *What Didn't Go Well*, *System Improvements*, and the *Code Review Findings* section.

**From Git:**
- `git log --oneline` for commits related to this epic
- Count commits, files changed, lines added/removed
- Identify date range (first commit → last commit)

**From TODO Files:**
- Read Execution Log for this epic's stories
- Read Key Decisions section
- Note any stories that were deferred `[~]` or blocked `[!]`

**From Work Documents:**
- Read plans from `docs/.output/plans/` related to this epic
- Note any plan revisions or course corrections

**From Memory:**
```bash
node .claude/core/memory-manager.js report
```
Review existing patterns for relevance to this epic.

**From Telemetry:**
- Read `docs/.output/.state/telemetry/command-usage.jsonl` (if it exists)
- Filter entries to the epic's date range (use the first/last commit dates from git log)
- Compute:
  - **Command frequency**: count of each `command_invocation` event grouped by `command` field
  - **Gate results**: count of `gate_run` events grouped by `outcome` (pass/fail)
  - **Command chains**: group events by `session_id`, extract the sequence of commands per session
- If the file doesn't exist or is empty, note "No telemetry data available" and continue

### 4. Run Doc Sync Check (main agent)

Run `/check-sync` to detect any documentation drift from this epic's implementation.
Capture findings for inclusion in the retro output.

### 5. Delegate to Agent (main agent → doc-writer)

Use the Task tool with `subagent_type: "doc-writer"` to generate the retrospective analysis.

**Task prompt must include**:
1. Epic name, number, and story list
2. All gathered data from Step 3 (git stats, TODO context, work doc summaries, memory patterns, telemetry stats)
3. **The code-review findings from Step 2** (full findings table)
4. Doc sync findings from Step 4
5. The `doc-writer` agent auto-loads the `project-planning` skill via frontmatter.
6. Instruction to write to `docs/.output/findings/reviews/retro-{epic-slug}.md` using the output template below
7. Instruction to analyze: what went well, what didn't, key decisions, metrics, recommendations
8. Instruction to populate the **Code Review Findings** section from Step 2, and to **weave CRITICAL/MAJOR findings into *What Didn't Go Well* and *System Improvements*** (a real bug that shipped is a "didn't go well"; a finding that points to a missing convention is a system improvement)
9. Instruction to include a System Improvements section evaluating agent/skill/command/memory effectiveness
10. Instruction to include the Doc Sync Summary from the check-sync findings
11. **Output boundary (MUST include verbatim):** *"Your ONLY output is the retro markdown at the specified path. Do NOT create additional files. Do NOT write memories. Do NOT write to `.claude/agent-memory/`, `docs/.output/.memory/`, or anywhere else. Main Agent handles memory extraction in Step 6."* The doc-writer tends to over-deliver when it sees a multi-step workflow described in the prompt — without this boundary, it has authored phantom memory directories outside its assigned task. Reference incident: 2026-04-20 retro MU dispatch.

**Output template for the agent:**

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

### 6. Extract Patterns to Memory (main agent)

After the agent completes, review its analysis for patterns to extract:

For any new patterns discovered, create memory entries:

```bash
node .claude/core/memory-manager.js create patterns "{pattern-id}" '{"description":"...", "confidence": 0.8}'
```

**Promote existing patterns:** If a pattern created by `/do` (confidence 0.6) was validated during this epic, update its confidence to 0.8+.

### 6.5. Resolve actionable findings in-pass (standalone runs only)

> **Skip this step when invoked under `/sweep`** (`--skip-review` is set) — Phase 3 owns resolution there; resolving here too would double-fix.

The retro is not done when findings are *filed* — it's done when the worth-fixing ones are *fixed*. Per the operating standard (`.claude/skills/verification-before-completion/SKILL.md` → "Autonomous & batch commands"), resolve in the same pass rather than handing the user a punch-list:

- **All code-review findings, CRITICAL down to NIT** → fix and re-verify — no skipping, nits included (the operating standard; the only limit is SCOPE, not severity — don't expand beyond the epic's changed code, skip generated/vendored). A finding a retro surfaced is not a "next epic" item; it gets fixed now (delegate to `general-purpose` for non-trivial fixes, batching small ones, same as `/do`).
- **Mechanical doc-drift** (from Step 4 check-sync) → apply the fix.
- **Single-target System-Improvement recs** (update this skill, add this agent step, fix this command line) → apply them in-pass.
- **Re-run `node .claude/core/gate.js test`** after any code fix; everything stays green before the Step 7 commit.

Surface to the user (in Step 8) **only genuine forks**: mutually-exclusive approaches, irreversible/outward actions, or scope that materially expands (standing up a new agent, a taxonomy change). Everything else, the retro fixes.

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command — the retro doc, the in-pass fixes from Step 6.5, and any memory updates — and commit with a descriptive message.

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
