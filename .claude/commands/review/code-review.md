---
description: Review code changes against architecture standards, security best practices, and project conventions
argument-hint: [file path, PR number, or git diff range]
---

<!-- Generated from .agents/skills/review-code-review/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Code Review

Review code for quality, security, and architecture compliance. Uses the `code-review` skill.

**Operating standard — read-only by design, fix-ready by obligation.** This command produces a review, not a code change: `code-reviewer` has no `Edit` tool, and that read-only stance is full compliance with "resolve it or don't report it," not an exception to it. The reviewer's half of the standard is **exhaustive, precise, immediately-actionable** findings (`file:line` + a concrete fix, no hand-waving, no truncation); the orchestrator's half is resolving the CRITICAL/MAJOR items rather than deferring them. The review dead-ends in a report only if no fix is warranted. Canonical: `.claude/skills/verification-before-completion/SKILL.md`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:code-review
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle scope detection and standards loading. The `code-reviewer` agent handles the actual review analysis. Do NOT perform the review inline — delegate via Task tool. You DO handle the final report output.

**Agent**: `code-reviewer` (via Task tool with `subagent_type: "code-reviewer"`)

## Variables

INPUT: $ARGUMENTS

**Flags:**
- `--deep` — Run a cross-model second opinion: dispatches two review agents in parallel (primary tier determined by risk, backup is the opposite tier), then compares findings for higher-confidence results. Without this flag, only the risk-routed primary tier runs.
- `--council` — Run a **council review** (the N-reviewer generalization of `--deep`): dispatch one `code-reviewer` per LENS (correctness / security / architecture / performance), then have each reviewer **anonymously cross-validate** the others' findings, and the main-agent **chairman** synthesize the consensus. Higher cost (N reviewers + a cross-validation round); use on high-stakes changes. Aggregation is deterministic via `.claude/core/council.js`. See **Council Mode** below. (`--council` supersedes `--deep` when both are passed.)

## Workflow

### 1. Determine Scope (main agent)

**If INPUT is a file path:**
- Read the specific file(s)

**If INPUT is a PR number:**
- Run `gh pr diff {number}` to get the diff

**If INPUT is a git range (e.g., "HEAD~3"):**
- Run `git diff {range}` to get the diff

**If no INPUT:**
- Run `git diff` for unstaged changes
- If no unstaged changes, run `git diff HEAD~1` for last commit

### 2. Load Standards (main agent)

- Read `docs/architecture/overview.md` — Development Standards, API conventions, project structure
- Read `CLAUDE.md` — project-specific rules (if exists)
- Check relevant skills for domain patterns:
  - `.css`/`.html` in a project that uses Tailwind → check `tailwind-css-patterns` skill
- Search memory system for established project patterns:
  ```bash
  # Search for patterns related to the changed files' domain
  node .claude/core/memory-manager.js search "{domain inferred from file extensions}"

  # Check for known constraints that might be violated
  node .claude/core/memory-manager.js list constraints

  # Check for relevant architecture decisions
  node .claude/core/memory-manager.js list decisions
  ```
  Memory patterns complement skill checklists: skills define general best practices, memories capture project-specific conventions discovered during implementation.

**Runtime and verification.** This review changes no application code and runs no build or test gate; where a gate result is cited, in an adopter it comes from the application's own `gate.js` commands and never the Domdhi.Agents toolkit suite, including after agent-file edits, and in Domdhi.Agents itself from the toolkit's Node build and Vitest suite. In Codex, run each `.claude/core/` command in this workflow (telemetry, memory search, `council.js`, `commit.js`) as `.codex/core/` with the same arguments and dispatch the reviewer as `.agents/adapters/codex/execution.md` describes. Note that discovery alone (an installed skill, a listed command or a loaded file) never proves this review ran: claim completion only from the Step 4 report written to `docs/.output/findings/reviews/` and its Step 5 commit hash.

### 2b. Classify Risk Tiers (main agent)

Classify each changed file into a risk tier to determine review depth.

**If risk map exists** (check `code-reviewer` agent's `## Project Context > ### Risk Map`):
1. Read the risk map from `.claude/agents/code-reviewer.md`
2. For each changed file, match its path against risk map patterns
3. Assign the matching tier: HIGH, MEDIUM, or LOW

**If no risk map exists** (project hasn't run `/specialize`):
- Default all files to **MEDIUM** risk

**Build the risk classification table:**
```markdown
| File | Risk Tier | Review Depth | Source |
|------|-----------|-------------|--------|
| {path} | {HIGH/MEDIUM/LOW} | {Deep/Standard/Fast-Lane} | {risk map pattern or "default"} |
```

**Determine overall review depth** — use the highest tier in the changeset:
- Any HIGH file → overall Deep Review
- All MEDIUM → overall Standard Review
- All LOW → overall Fast-Lane Review

### 3. Delegate to Agent (main agent → code-reviewer)

Use the Task tool with `subagent_type: "code-reviewer"` to perform the review.

**Determine the primary model from the risk tier (Step 2b):**
- Overall tier is **HIGH** → dispatch `code-reviewer` with `model: "opus"`.
- Overall tier is **MEDIUM or LOW** → omit `model:` so the agent runs on its `standard` default.

**If `--deep` flag is set:** Dispatch TWO review agents in parallel:
1. **Primary** — `subagent_type: "code-reviewer"`, model determined by risk tier above.
2. **Backup** — `subagent_type: "code-reviewer"`, model is **the opposite tier from the primary** (if primary ran `standard` tier → `model: "opus"`; if primary ran `deep` tier → `model: "sonnet"`). This gives cross-tier diversity, not a re-run.

Distinct requested tiers do not prove distinct models: when both resolve to an omitted argument or the same model, report that model diversity was not established. Both receive the same prompt. Results are compared in Step 4.

**If no `--deep` flag:** Dispatch single agent using the risk-tier model above.

**Task prompt must include**:
1. The diff or file contents to review
2. Architecture standards and conventions from Step 2
3. Memory patterns and constraints relevant to the changed code
4. The risk classification table from Step 2b (per-file risk tiers and overall review depth)
5. The `code-reviewer` agent auto-loads the `code-review` skill via frontmatter.
6. Instruction to use the playbook's routing: Deep Review checklist for HIGH files, Standard for MEDIUM, Fast-Lane for LOW
7. Instruction to evaluate: Correctness, Security, Performance, Architecture Compliance, Memory Pattern Compliance, Test Coverage
8. Instruction to classify findings by severity: CRITICAL > MAJOR > MINOR > NIT
9. Instruction to include the Risk Assessment section in the report (between Summary and Findings)
10. The verified project constraints and architecture conventions loaded in Step 2, with their source paths (or "none" when absent)

### 3d. Council Mode (`--council`)

When `--council` is set, **replace** the single/`--deep` dispatch in Step 3 with this three-stage flow (Karpathy's llm-council, adapted for a single-vendor panel — diversity comes from LENS, not vendor). Use a workspace dir: `docs/.output/findings/reviews/council-{YYMMDD-HHMM}/`.

**Stage 1 — independent reviews (parallel).** Get the lens set: `node .claude/core/council.js lenses`. Dispatch one `code-reviewer` agent **per lens, in parallel** (background OK). Model is risk-routed, same as the primary dispatch: overall tier **HIGH** → pass `model: "opus"` per lens; overall tier **MEDIUM or LOW** → omit `model:` (`standard` default). Main Agent owns chairman synthesis in Stage 3. Each agent gets the same diff + standards + risk table from Steps 1–2b, **plus a lens instruction**: "Review ONLY through the **{lens}** lens ({focus}). Report findings as a JSON array `[{file,line,title,severity,lens:'{lens}',detail}]`." Collect all findings into `findings.json` (concatenate the arrays; tag each with its `lens`).
- Optional cross-vendor member: if the project has configured an external model (e.g. OpenRouter) AND opted in, add it as one more reviewer for true vendor diversity. Off by default — it breaks the zero-dependency drop-in property, so never enable it implicitly.

**Stage 2 — anonymized cross-validation.** Dedupe + assign stable ids: `node .claude/core/council.js dedupe docs/.output/findings/reviews/council-{YYMMDD-HHMM}/findings.json` → `deduped.json`. (Independent re-raises by multiple lenses auto-merge — that overlap is itself a confirmation signal.) Then dispatch each lens reviewer AGAIN, giving it the **anonymized** deduped findings (present them as "Reviewer A/B/…" via the `anonymization` map — do NOT tell a reviewer which findings are its own) with this instruction: "For each finding NOT your own, vote `confirm` / `refute` / `unsure` and a `severity_vote`. **Default to `refute` if you cannot independently substantiate it** — do not rubber-stamp; we reward independent confirmation, not agreement." Collect votes into `votes.json` as `[{finding_id,voter:'{lens}',verdict,severity_vote}]`.

**Stage 3 — chairman synthesis.** Aggregate deterministically: `node .claude/core/council.js aggregate docs/.output/findings/reviews/council-{YYMMDD-HHMM}/` → `council.json` + `council.md`. This applies the survival rule (a finding **confirmed** = ≥2 independent confirms and confirms>refutes; **refuted** = majority-refuted and not high-severity; a CRITICAL/MAJOR that drew refutes is **contested**, never silently dropped). Then YOU (Main Agent, the chairman) write the synthesis: take the `council.json` consensus and produce the final findings list — lead with **confirmed**, call out **contested** for human judgment, and list **refuted** in an appendix (logged, not actioned). This `council.md` + your synthesis is the review body for Step 4.

### 4. Persist Output (main agent)

Write the full review analysis to disk before reporting:

```bash
mkdir -p docs/.output/findings/reviews
```

Write the complete review output (risk classification table + all agent findings) to:
`docs/.output/findings/reviews/{YYMMDD-HHMM}-code-review.md`

File format:
```markdown
# Code Review — {YYYY-MM-DD}

**Scope**: {files/PR/diff reviewed}
**Verdict**: {Approved / Approved with Comments / Changes Requested}

{full report content — risk table, findings, cross-model analysis if --deep}
```

### 5. Commit (main agent)

Stage and commit the review output file:

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /review:code-review — {verdict}, {N} findings ({critical}C/{major}M/{minor}m)
```

Then run:

```bash
git add docs/.output/findings/reviews/{YYMMDD-HHMM}-code-review.md
node .claude/core/commit.js
```

### 6. Report (main agent)

Read the agent's output and present the final report, including the output file path:

```markdown
## Code Review Complete

**Verdict**: {Approved / Approved with Comments / Changes Requested}
**Files**: {count} reviewed
**Output**: `docs/.output/findings/reviews/{YYMMDD-HHMM}-code-review.md`
**Overall Review Depth**: {Deep / Standard / Fast-Lane}
**Findings**: {critical} critical, {major} major, {minor} minor, {nit} nits

### Risk Assessment

| File | Risk Tier | Review Depth | Source |
|------|-----------|-------------|--------|
| {path} | {HIGH/MEDIUM/LOW} | {Deep/Standard/Fast-Lane} | {risk map pattern or "default"} |

{If Changes Requested: list the critical/major items that must be fixed}

### Cross-Model Analysis (--deep only)

**Models:** {risk-tier model} (primary) + {opposite tier} (backup)
**Agreement rate:** {N}%

| Finding | `standard` tier | `deep` tier | Confidence |
|---------|--------|------|------------|
| {description} | {severity or —} | {severity or —} | {Both agree: HIGH / One only: REVIEW} |

{Findings where both models agree → high confidence, fix these.}
{Findings where only one model flags → surface for human judgment with rationale from each.}

### Council Synthesis (--council only)

**Reviewers (lenses):** {N} (correctness, security, architecture, performance{, +external if opted in})
**Consensus:** {C} confirmed · {X} contested · {U} unconfirmed · {R} refuted

| Status | Severity | Finding | Where | Raised by | Confirms/Refutes |
|--------|----------|---------|-------|-----------|------------------|
| {✅ confirmed / ⚠ contested / ◻ unconfirmed} | {severity} | {title} | {file:line} | {lenses} | {c}/{r} |

{Confirmed → high-confidence, fix these. Contested → human judgment (esp. any CRITICAL/MAJOR that drew refutes — never auto-dropped). Refuted findings are listed in the appendix of the output file, logged but not actioned.}
```
