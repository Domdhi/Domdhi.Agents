---
description: Re-align agents, skills, and memory with the actual codebase during implementation
argument-hint: "[--dry-run | --fix | --report-only]"
---

<!-- Generated from .agents/skills/review-optimize-agents/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Optimize Agents

Re-align the `.claude/` system with the **actual codebase** during Phase 4 implementation. While `/specialize` sets up agents from planning docs, `/optimize-agents` keeps them aligned as the codebase evolves.

Run this periodically — after completing an epic, when agents feel out of sync, or when `/retro` flags system improvements.

**Idempotent** — safe to re-run. Agent context sections are replaced, not duplicated. Memories are not overwritten.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:optimize-agents
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle phase gate, context assembly, agent updates, memory health, and the final report. The `architect` agent handles codebase scanning (Step 1). The `code-reviewer` agent handles skill effectiveness audit (Step 5). Do NOT perform deep codebase analysis or skill auditing inline — delegate via Task tool. You DO handle comparison logic, agent file updates, and committing.

**Agents used** (via Task tool):
- `architect` — codebase scanning, tech stack detection, pattern discovery
- `code-reviewer` — skill relevance audit, gap detection

## Variables

MODE: $ARGUMENTS (default: `--fix`)
- `--dry-run` — Report drift without fixing anything
- `--fix` — Report drift AND apply updates
- `--report-only` — Condensed tables only

## When to Run

- After completing an epic (suggested by `/retro`)
- When agent output quality degrades
- After major refactors or dependency changes
- After architecture document updates
- On-demand when implementation feels misaligned

## Workflow

### 0. Phase Gate

Verify implementation is underway — actual code must exist beyond planning docs:

- Check for source code: `Glob: src/**/*` or `lib/**/*` or `app/**/*`
- Check for package files: `Glob: package.json, *.csproj, Cargo.toml, go.mod, pyproject.toml`

If no source code or package files found → **STOP**: suggest `/specialize` instead (for initial setup from docs).

### 1. Scan Actual Codebase (main agent → architect)

Delegate codebase scanning to the `architect` agent via Task tool with `subagent_type: "architect"`.

**Task prompt must include**:
1. Instruction to scan all package/dependency files: `package.json`, `*.csproj`, `*.sln`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`
2. Instruction to map project structure: `src/**/*`, `lib/**/*`, `app/**/*`, `tests/**/*`, config files
3. Instruction to detect frameworks from code patterns (imports, decorators, config files) and build a `DETECTED_STACK` model: `{backend: [...], frontend: [...], database: [...], testing: [...]}`
4. Instruction to identify recurring implementation patterns: base classes, shared interfaces, DI registrations, middleware chains, test fixtures
5. Instruction to extract actual dependency versions — this is ground truth, not what the architecture doc planned
6. The `architect` agent auto-loads the `architecture` skill via frontmatter

**Agent must return**: A structured report with detected stack, project structure map, framework evidence, and implemented patterns.

### 2. Compare Against Current Agent Context

For each `.agents/roles/*.md`, plus legacy `.claude/agents/*.md` with no canonical equivalent:

1. Read the current `## Project Context` section from the markdown body (after frontmatter `---`), if it exists from `/specialize`
2. Compare against the scanned codebase:
   - **New dependencies** not reflected in agent context
   - **Removed dependencies** still listed in agent context
   - **New patterns** that emerged during implementation
   - **Structural changes** (new directories, renamed modules)

**Classify each agent's alignment:**
- **CURRENT** — Agent context matches codebase reality
- **DRIFTED** — Agent context exists but is outdated
- **MISSING** — No `## Project Context` section (never specialized)

### 3. Read Proven Patterns from Memory

```bash
node .claude/core/memory-manager.js report
```

Collect all patterns with confidence ≥ 0.7 (proven in implementation or higher). These represent **validated knowledge** that agents should know about.

Also check for:
- Patterns created by `/do` (confidence 0.6) that haven't been promoted
- Constraints discovered during implementation
- Decisions made that aren't in the original architecture ADRs

### 4. Read Agent Updates Log

Check for runtime agent issues tracked by `/do` and `/run-todo`:

```
Read: docs/.output/evolution/agents/*.md (newest day-files; e.g. last 30 days)
      ↳ fall back to legacy flat docs/.output/evolution/agents.md if the folder is absent (path-lint:keep)
```

The `agent-updates/` folder rotates by day (`{YYYY-MM-DD}.md`) so no single file grows unbounded — read across the recent files. These contain:
- **Agent Issues** — misalignments, file ownership violations, naming mismatches logged per wave/story
- **New Decisions** — implementation decisions that affect future agent prompts
- **Prompt Improvements Needed** — specific changes to prevent recurring issues

(This log is failure-only by design — `/do` and `/run-todo` do not record "what worked well.")

Cross-reference issues against agent context sections. If an agent repeatedly causes the same type of misalignment, update its `## Project Context` with explicit constraints to prevent it.

### 5. Read Retro Findings

Search for system improvement recommendations:

```
Glob: docs/.output/findings/reviews/retro-*.md
```

For each retro file, extract the `## System Improvements` table:
- Agent findings (should instructions be updated?)
- Skill findings (should templates be updated? new skills needed?)
- Command findings (missing steps?)
- Memory findings (patterns missing or stale?)

These are the **explicit recommendations** from previous retrospectives that haven't been applied yet.

### 6. Update Agent Context (if --fix)

For each agent that is DRIFTED or MISSING, update the `## Project Context` section in its canonical `.agents/roles/*.md` source when present, otherwise its legacy `.claude/agents/*.md`. Append at EOF, after the existing Skills and operating sections. Never edit a generated native role or root instructions to optimize shared behavior. Render after canonical writes with `node .claude/core/render-shared-agents.js`:

```markdown
## Project Context

> Optimized for {PROJECT_NAME} on {YYYY-MM-DD} by /optimize-agents
> Based on: codebase scan + {N} proven patterns + {N} retro findings + {N} agent-updates issues

### Tech Stack (from codebase)
- {technology} {actual version from package files} — {detected role}
- ...

### Proven Patterns
- {pattern name} (confidence {0.X}): {description} — see {file path}
- ...

### Active Constraints
- {constraint}: {description} — discovered {date}
- ...

### Key Decisions (post-architecture)
- {decision}: {rationale} — from retro-{epic}.md or memory
- ...

### Project Structure
- {directory}: {what it contains, key files}
- ...
```

**Idempotency:** Check for existing `## Project Context` in the markdown body (after frontmatter). If found, replace it entirely (detect by the `> Optimized for` or `> Specialized for` marker). The optimize version replaces the specialize version — it's a superset with real codebase knowledge.

### 7. Audit Skill Effectiveness (main agent → code-reviewer)

Delegate skill audit to the `code-reviewer` agent via Task tool with `subagent_type: "code-reviewer"`.

**Task prompt must include**:
1. The `DETECTED_STACK` from Step 1 (architect agent's output)
2. List of skill sources: `.agents/skills/*/SKILL.md`, plus legacy `.claude/skills/*/SKILL.md` without a canonical equivalent. Edit the source and preserve project-additions markers; never edit generated native skills
3. Instruction to classify each skill: `ACTIVE` (covers tech in codebase), `NOT_USED` (covers tech not in codebase)
4. Instruction to identify gaps: technologies in `DETECTED_STACK` with no corresponding skill
5. Instruction to cross-reference retro findings from `Glob: docs/.output/findings/reviews/retro-*.md` for skill improvement recommendations
6. The `code-reviewer` agent auto-loads the `code-review` skill via frontmatter

**Agent must return**: Skill classification table, gap list with suggested names, and unapplied retro recommendations.

### 8. Memory System Health (main agent)

**6a. Check memory counts and age:**
```bash
node .claude/core/memory-manager.js report
```

**6b. Run health check if available:**
```bash
node .claude/core/memory-health-check.js
```

**6c. Identify stale patterns:**
- Patterns referencing files that no longer exist
- Patterns with technologies no longer in the project
- Patterns older than 30 days that were never promoted past 0.6 confidence

**6d. Identify missing patterns:**
- Recurring code structures in the codebase with no corresponding memory entry
- Common imports or utilities used across 3+ files that aren't documented as patterns

### 9. Persist Output (main agent)

Write the full scan results to disk before committing:

```bash
mkdir -p docs/.output/findings/reviews
```

Write the complete optimization report (stack scan + agent alignment + skill audit + memory health) to:
`docs/.output/findings/reviews/{YYMMDD-HHMM}-agent-optimization.md`

File format:
```markdown
# Agent Optimization — {YYYY-MM-DD}

**Mode**: {--fix / --dry-run / --report-only}
**Project**: {PROJECT_NAME}

{full report content — detected stack, agent alignment table, proven patterns, skill audit, memory health, retro findings}
```

### 10. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command — including `docs/.output/findings/reviews/{YYMMDD-HHMM}-agent-optimization.md` — and commit with a descriptive message.

### 11. Report (main agent)

```markdown
## Agent Optimization Report

### Run Mode: {--fix / --dry-run / --report-only}
### Date: {YYYY-MM-DD}
### Project: {PROJECT_NAME}
### Output: `docs/.output/findings/reviews/{YYMMDD-HHMM}-agent-optimization.md`

---

### Detected Tech Stack (from codebase)

#### Dependencies
| Source | Technology | Version | Role |
|--------|-----------|---------|------|
| {package file} | {name} | {version} | {detected role} |

#### Project Structure
| Directory | Contents | Key Files |
|-----------|----------|-----------|
| {dir} | {description} | {notable files} |

#### Frameworks Detected
{List with evidence — e.g., "Angular 19 (from package.json)", "ASP.NET Core 10 (from .csproj)"}

---

### Agent Alignment ({count} agents)

| Agent | Previous State | Current State | Action | Changes |
|-------|---------------|---------------|--------|---------|
| product-strategist | {Specialized/Optimized/None} | {CURRENT/DRIFTED/MISSING} | {Updated/Would update/No change} | {summary} |
| architect | ... | ... | ... | ... |
| ux-designer | ... | ... | ... | ... |
| project-planner | ... | ... | ... | ... |
| general-purpose | ... | ... | ... | ... |
| security-auditor | ... | ... | ... | ... |
| qa-engineer | ... | ... | ... | ... |
| code-reviewer | ... | ... | ... | ... |
| doc-writer | ... | ... | ... | ... |
| playwright | ... | ... | ... | ... |
| shadow | ... | ... | ... | ... |

> Plus any stack-specific agents created by `/specialize` (e.g., db-architect, auth-builder)

---

### Proven Patterns Injected

| Pattern | Confidence | Source | Injected Into |
|---------|-----------|--------|---------------|
| {name} | {0.X} | {memory / retro} | {which agents} |

---

### Skill Audit

| Skill | Status | Reason |
|-------|--------|--------|
| {name} | {ACTIVE / NOT_USED / NEEDS_UPDATE} | {why} |

#### Framework Gaps
{Technologies with no skill, with suggested skill names}

#### Retro Recommendations (Unapplied)
{Skill improvement recommendations from retro files not yet addressed}

---

### Memory Health

| Metric | Value |
|--------|-------|
| Total memories | {count} |
| By category | patterns: {N}, constraints: {N}, decisions: {N}, workflows: {N} |
| Avg confidence | {0.X} |
| Stale (>30d, conf <0.7) | {count} |
| Referencing missing files | {count} |
| Health check | {Passed / Warnings / Failed} |

#### Stale Patterns (candidates for removal)
| Pattern | Age | Confidence | Issue |
|---------|-----|-----------|-------|
| {name} | {days} | {0.X} | {references missing file / never promoted / etc.} |

---

### Agent Updates Log (from /do and /run-todo)

| Date | Story/Wave | Agent | Issue | Applied to Context? |
|------|-----------|-------|-------|-------------------|
| {date} | {ID} | {type} | {issue summary} | {Yes / No} |

**Recurring Issues** (same agent, same issue type, 2+ occurrences):
{List recurring patterns that warrant agent context updates or prompt template changes}

---

### Retro Findings Applied

| Source | Finding | Applied |
|--------|---------|---------|
| retro-{epic}.md | Agent: {finding} | {Yes (updated) / No (manual)} |
| retro-{epic}.md | Skill: {finding} | {Yes / No} |

---

### Manual Actions Required
{Numbered list of items that need human intervention}

### Recommendations
{Ordered next steps — e.g., create missing skills, remove stale patterns, update architecture docs}
```

## Relationship to Other Commands

```
/specialize     → Initial setup: docs → agents (Phase 3→4 bridge)
/optimize-agents → Runtime alignment: codebase → agents (during Phase 4)
/retro          → Analysis: identifies drift + proposes improvements (after epic)
/check-sync     → Detection: finds doc drift (anytime)
```

**Typical flow during implementation:**
```
/specialize --fix          (once, during initial project setup)
    ↓
/do | /run-todo            (builds code, logs agent issues to docs/.output/evolution/agents/{date}.md)
    ↓
/retro                     (after epic, promotes patterns to 0.8, flags system issues)
    ↓
/optimize-agents --fix     (reads agent-updates/ day-files + retro findings + codebase scan,
                            fixes recurring issues, updates agent context)
    ↓
/do | /run-todo            (agents now aligned — fewer misalignments, better prompts)
```

**Data sources for optimization:**
```
docs/.output/evolution/agents/{date}.md  ← runtime issues from /do and /run-todo (day-rotated, continuous)
docs/.output/findings/reviews/retro-*.md                ← system improvements from /retro (per epic)
codebase scan                  ← actual dependencies, patterns, structure (live)
memory system                  ← proven patterns at confidence ≥ 0.7 (accumulated)
```
