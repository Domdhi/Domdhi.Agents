---
description: Reverse-engineer the doc chain from an existing codebase — brownfield analog of /create:new-project
argument-hint: "[--yolo]"
---

<!-- Generated from .agents/skills/onboard/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Onboard

Bootstrap the Domdhi.Agents doc chain from an existing codebase. Produces `docs/architecture/overview.md` and `docs/product/context.md` from reality — no brief required, no templates to fill, no vision interview. Chains `/review:specialize` once the architecture doc exists.

Intended as the FIRST command after installing Domdhi.Agents into a project that already has code. Where `/create:new-project` starts with a blank slate and interviews the user forward, `/onboard` starts with the codebase and reads backward.

**Hard-gate posture:** `/onboard` has NO doc prerequisites — it is the bootstrapper. It refuses only when there is no detectable source at all (in that case point at `/create:new-project`).

## Variables

INPUT: $ARGUMENTS

### Flag detection
If `$ARGUMENTS` contains `--yolo`:
- Set YOLO_MODE = true
- All gates below downgrade to warnings

## Workflow

### 0. Record Invocation (telemetry)

`/onboard` is user-typed, so it does NOT fire the `PostToolUse:Skill` event that `command-usage-logger.cjs` listens for — without this step the run leaves no `command_invocation` row in `command-usage.jsonl` (only the chained `/review:specialize` and gate runs would show up). Log the invocation up front:

```bash
node .claude/core/telemetry-log.js onboard
```

This is best-effort — if it fails, continue the workflow regardless.

### 1. Source Check

Confirm there is source code to reverse-engineer. Look for any of: `src/`, `lib/`, `app/`, top-level `*.ts`, `*.py`, `*.go`, `*.cs`, `*.rs`, `*.js` files, or a language-specific project file (`package.json`, `Cargo.toml`, `go.mod`, `*.csproj`/`*.sln`, `pyproject.toml`, `Makefile`).

**If no source is detected and YOLO_MODE is false:**

```
ABORT: No source code detected in this directory.
/onboard reverse-engineers an existing codebase — there is nothing to read.

If you are starting from scratch, use /create:new-project instead.
```

**If YOLO_MODE is active and no source is detected:** warn and continue.

### 2. Detect Stack

Reuse the same detection heuristics as `gate.js`:

| Detected file | Stack | Build | Test |
|---|---|---|---|
| `package.json` | Node / JS / TS | `npm run build` | `npm test` |
| `Cargo.toml` | Rust | `cargo build` | `cargo test` |
| `go.mod` | Go | `go build ./...` | `go test ./...` |
| `*.sln` / `*.csproj` | .NET | `dotnet build` | `dotnet test` |
| `pyproject.toml` | Python | `ruff check` + `mypy` | `pytest` |
| `Makefile` | Generic Make | `make` | `make test` |

Record the detected stack — it flows into every delegate prompt below.

### 3. Map the Codebase

Fan out `Explore` agents over the source tree in parallel to map the landscape before asking any questions. Run these threads concurrently:

**Thread A — Entry points & structure**
- Top-level directories (src, lib, app, cmd, api, etc.)
- Entry point files (main.*, index.*, server.*, app.*)
- Module / package / namespace layout
- **Shippable assets inventory (F10):** icons/images, `manifest.json` (extension `action`/`icons`/`options_page`), `public/`/`static/` assets, favicons, app store metadata. These are real surfaces reverse-engineering otherwise misses — list them so the architecture/design docs and backlog account for them, not just the code.

**Thread B — Dependency graph**
- Package manager manifests (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `*.csproj`) for direct and key transitive dependencies
- Internal import graph — which modules depend on which

**Thread C — Test layout**
- Test directories and files
- Test framework in use (jest, pytest, vitest, xUnit, etc.)
- Rough coverage split (unit / integration / E2E)

**Thread D — Existing docs & recent direction**
- Root `README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, or any `docs/` markdown present before this run
- `git log --oneline -30` for recent commit subjects and direction
- Any existing `CLAUDE.md` in the project root

Synthesize into a **codebase map** (internal scratch data — not written to disk). This drives both the forcing questions and the delegate prompts.

### 4. Forcing Questions

Using `AskUserQuestion`, ask only the questions that code alone cannot answer and that genuinely sharpen the architecture doc. The questions below are the default set — skip any that the codebase map already answers clearly.

**Ask 2–3 questions max.** Stop when you have enough to write a meaningful architecture doc. Do NOT interview vision, goals, or product strategy — that is `/create:project-brief` territory.

Suggested questions (pick the most relevant based on the codebase map):

1. **Deployment target** — "Where does this run? (cloud provider, on-prem, SaaS, local only)" — skip if obvious from infra config files (e.g., `fly.toml`, `Dockerfile`, `.github/workflows/deploy.yml`).
2. **Known pain points** — "What parts of the codebase are actively painful or known to need redesign?" — always worth asking; code can't tell you this.
3. **Scale or load expectations** — "Rough usage expectations? (personal tool, team tool, public SaaS, regulated enterprise)" — skip if README or manifest already says.

Mark each skipped question in the internal codebase map so the architecture doc can note "inferred from code" vs "stated by user."

#### 4a. Persist scan results (BEFORE delegation)

Write the codebase map to `docs/.output/.state/work/{YYYY-MM-DD}/onboard-scan.md` so a session crash before Step 5 doesn't force a full re-scan.

```markdown
# Onboard Scan — {project name inferred from git or directory} ({YYYY-MM-DD})

## Stack Detection
- Language/runtime: {detected}
- Build command: {detected}
- Test command: {detected}

## Entry Points
{list from Thread A}

## Key Dependencies
{list from Thread B}

## Test Layout
{list from Thread C — framework, directories, rough type split}

## Existing Docs Found
{list or "none"}

## Recent Git Direction (last 30 commits)
{summary from Thread D}

## Forcing Question Answers
- Deployment target: {answer or "inferred: {inference}"}
- Pain points: {answer or "skipped — user did not provide"}
- Scale: {answer or "inferred: {inference}"}
```

#### 4b. Project constraints and verification

**Runtime and verification.** The `gate.js` build and test commands this workflow records and configures are the application's own and never the Domdhi.Agents toolkit suite, including after agent-file edits. In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`, and dispatch the `architect` and `doc-writer` roles as that adapter describes. Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran: report completion only from the written `docs/architecture/overview.md` and `docs/product/context.md` passing their Step 5 and Step 6 validation, and the commit hash.

### 5. Generate Architecture Doc

Delegate to the `architect` agent to write `docs/architecture/overview.md` from the scanned reality.

**Delegation via Task tool with `subagent_type: "architect"`.**

The `architect` agent auto-loads the `architecture` skill via frontmatter — do NOT instruct it to read the skill file.

**Task prompt must include:**
1. Project name (from git remote, directory name, or README heading — in that priority)
2. Detected stack (from Step 2)
3. Codebase map (from Step 3 / onboard-scan.md) — entry points, dependency graph, test layout
4. Forcing question answers (from Step 4)
5. Instruction to mark every ADR as `Status: Inferred` rather than `Status: Accepted` — these are reverse-engineered decisions, not conscious decisions being documented for the first time
6. Path: `docs/architecture/overview.md`
7. Mode: **Reverse-Engineering Mode** — document what exists, not what is ideal
8. Project constraints from Step 4b, only when they apply: the selected reference paths, the verified project constraints, and the instruction to record differences from them as application tasks rather than as defects the doc silently fixes

**Validate** after delegation: read `docs/architecture/overview.md` and check that:
- The `## Tech Stack` section is present and populated
- At least one ADR exists (even if inferred)
- No unfilled `{placeholder}` values remain

If validation fails and YOLO_MODE is false, ask the user for the missing detail and re-delegate.

### 6. Generate Project Context

Delegate to the `doc-writer` agent to write `docs/product/context.md` from the scan data and the freshly written architecture doc.

**Delegation via Task tool with `subagent_type: "doc-writer"`.**

The `doc-writer` agent auto-loads `project-planning` and `documentation` skills — do NOT instruct it to read them.

**Task prompt must include:**
1. Detected stack and build/test commands (from Step 2)
2. Entry points and key paths (from Thread A)
3. Path to the completed architecture doc (`docs/architecture/overview.md`)
4. Path to output: `docs/product/context.md`
5. Instruction to write current state, not aspirational state — this is a quick-reference for the next agent that opens the repo
6. Project constraints from Step 4b, only when they apply: the selected reference paths and the verified project constraints

**Context doc structure the delegate should produce:**

```markdown
# Project Context: {Project Name}

**Onboarded**: {date}
**Phase**: Reverse-Engineered
**Tech Stack**: {one-line from architecture doc}

## Quick Reference
- **Architecture**: [docs/architecture/overview.md](../architecture/overview.md)
- **Context**: this file

## Entry Points
- {entry point}: {purpose}

## Build & Test
- **Build**: `{build command}`
- **Test**: `{test command}`

## Key Paths
- `{path}` — {purpose}
- ...

## Implementation Commands
- `/create:project-brief` — capture the vision when ready
- `/create:project-epics` — break work into implementable stories
- `/review:personalize` — give the specialized agents names
- `/review:code-review` — review code changes
- `/review:qa` — generate tests
- `/review:check-sync` — detect doc drift
- `/review:update-docs` — fix doc drift
- `/review:optimize-agents` — re-align agents with codebase
- `/prime` — reload context in new session
- `/do` — execute a single story
- `/run-todo` — execute a full TODO checklist
- `/end` — save session state
```

**Validate** after delegation: read `docs/product/context.md` and check that its Build & Test commands match Step 2, its first line is not `<!-- @@template -->`, and no unfilled `{placeholder}` values remain. If validation fails and YOLO_MODE is false, re-delegate with the gap named.

### 6b. Reconcile Legacy Docs & Stray Tracked Files

Brownfield repos often already have planning docs under OLD names (`_architecture.md`, `_prd.md`), a root `_backlog.md` beside `work/backlog.md`, or duplicate `_feature-ideas.md`. The create-chain is blind to these and they silently become drift (two PRDs, two backlogs). **Reconcile them now** — do not leave both the legacy reals and the new domain docs (`product/`, `architecture/`, `work/`, …) in place (F2). <!-- migrate:keep (legacy-name examples retain the old underscore form) -->

**1. Detect:**
```bash
node .claude/core/_lib/doc-drift.js
```

**2. Reconcile** each reported item (ask the user before deleting; show a diff if a legacy doc has content the canonical lacks):
- Legacy doc + canonical both exist → merge anything unique from the legacy into the canonical, then **archive the legacy** to `docs/.archive/` (or delete with approval).
- Legacy doc, no canonical → you already wrote the canonical in Steps 5–6; archive the legacy.
- Duplicate basename (root vs `todo/`) → keep the canonical (`todo/`), remove the root copy.

**3. Untrack stray ignored files (F7):** files committed BEFORE the `.gitignore` managed block existed stay tracked even though they now match an ignore rule (e.g. a legacy root `domdhi.db` from an upstream-era install, `docs/.output/.state/` artifacts — but NOT `docs/.output/.memory/`, which is intentionally tracked). Untrack them so they stop versioning:
```bash
git ls-files -ci --exclude-standard          # lists tracked-but-now-ignored files
git ls-files -ci --exclude-standard -z | xargs -0 -r git rm --cached
```
Leave the files on disk (`--cached`); they're working state, not deletions. Report what was untracked.

### 7. CLAUDE.md Merge

Inspect whether a `CLAUDE.md` already exists at the project root.

**Case 0 — CLAUDE.md exists but is the install stub (C6):** the brownfield installer writes a minimal placeholder whose entire content points back here (it contains *"Run `/onboard`"*; a legacy stub also says *"This project uses the Domdhi Agents template"*). This is NOT a real adopter file to preserve — additively merging around it would leave a stale "Run /onboard" instruction after onboard has already run. If the existing CLAUDE.md matches the install stub (short, and contains that "Run `/onboard`" / "to complete setup" marker), treat it as **Case A** — generate a fresh project CLAUDE.md and overwrite the stub (no diff-confirm needed; there is no user content to protect).

**Case A — No CLAUDE.md exists (or it is the install stub per Case 0):**
Generate a new `CLAUDE.md` grounded in the onboard scan:
- Short project description (1-2 sentences, inferred from README or git log)
- Tech stack (from Step 2)
- Build and test commands (from Step 2)
- Key file paths and entry points (from Thread A)
- Gate configuration note (point at `gate.js` or `gate.config.json`)

Do NOT copy the Domdhi.Agents workshop CLAUDE.md — generate a lean project-specific one that captures what was learned.

**Case B — CLAUDE.md exists:**
Read the existing CLAUDE.md, then propose an **additive merge** — never clobber.

Diff what Domdhi.Agents conventions would add:
- Gate configuration (build/test commands) if absent
- Key file paths if absent
- A note that the Domdhi.Agents conventions (`.agents/` sources with `.claude/` and `.codex/` runtimes) are now active (if the file doesn't already describe them)

Produce a diff-style proposal:

```
Proposed additions to CLAUDE.md:

--- existing
+++ proposed additions

{diff showing only what would be added}

Apply this merge? (y/n)
```

Wait for confirmation before writing. If the user says no, skip CLAUDE.md modification and note it in the report.

This step is **self-contained** — it does NOT call the built-in `/init` command.

### 8. Specialize Agents

Now that `docs/architecture/overview.md` exists, chain `/review:specialize` (canonical workflow: `.agents/skills/review-specialize/SKILL.md`) to customize roles for this stack. Migrated roles/skills are edited in `.agents/roles` and `.agents/skills`, then rendered with `node .claude/core/render-shared-agents.js`. Native settings stay in their adapters; generated native files are not authoring targets. Root `CLAUDE.md` retains only application instructions from Step 7.

```bash
# Invoked as a sub-command, not a bash command — triggers the specialize workflow
/review:specialize --fix
```

`/onboard` deliberately defers the backlog to the create-chain, so at this point `docs/work/backlog.md` is still a template stub. That is expected: `/review:specialize` runs in **architecture-only mode** (C7) and specializes the agents from the architecture doc — it does NOT abort on the missing backlog. Once the backlog exists (after `/create:project-epics`), re-running `/review:specialize` incorporates epic boundaries into the risk map.

Show the specialization report summary to the user (full report is in the output file).

After specialization completes, mention optionally running `/review:personalize` to give the specialized agents names and personality.

### 9. Commit

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`.

Stage the files created or modified by this run specifically:
- `docs/architecture/overview.md`
- `docs/product/context.md`
- `CLAUDE.md` (only if it was modified in Step 7)

Do not stage `docs/.output/.state/work/{date}/onboard-scan.md`: `docs/.output/.state/` is ignored scratch and `git add` refuses it. Anything from the scan that the docs rely on belongs in `overview.md` or `context.md`.

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /onboard — {project name} reverse-engineered
```

Then run:

```bash
node .claude/core/commit.js
```

### 9b. Capture Feedback Report

Chain `/review:feedback` as the final action. It rolls the just-captured telemetry (the onboard invocation logged in Step 0, the chained `/review:specialize`, gate runs, hooks, the freshly-written memories) plus a short agent self-review into `docs/.output/findings/reviews/feedback-{date}.md` + `.json`, and self-commits.

```
/review:feedback
```

This is what flows onboard-performance signal back to the maintainer for every project — answer the self-review honestly from this run (what was ambiguous, what you inferred, what you'd change). Best-effort: if it fails, note it and continue to the report.

### 10. Final Report

```markdown
## Onboard Complete

**Project**: {name}
**Tech Stack**: {detected stack}
**Source scanned**: {entry point count} entry points, {dependency count} direct dependencies

### Documents Created
| Document | Path | Status |
|----------|------|--------|
| Architecture | docs/architecture/overview.md | Created (reverse-engineered) |
| Project Context | docs/product/context.md | Created |
| CLAUDE.md | CLAUDE.md | {Created / Merged / Unchanged} |

### Specialization: {summary from /review:specialize}

**Committed**: {hash} — `docs: /onboard — {project name}`

### Ready to Work

Recommended next commands:

1. **`/prime`** — in a new session, reload context from the docs just created.
2. **`/create:project-brief`** — when ready to capture vision and goals (deferred from onboard intentionally).
3. **`/create:project-epics`** — break work into implementable stories once the architecture doc is reviewed and `product/requirements.md` exists.
4. **`/do {story-id}`** — start implementing once the backlog is defined.
5. **`/review:personalize`** — give the specialized agents names and personality.

### Tips for this session

**Effort level.** Commands like `/do` and `/run-todo` orchestrate multiple sub-agents. If you see delegation steps being skipped or plans cut short, raise effort to `high` or above (`/config set effort high`) before continuing.

**Troubleshooting bisect.** If something looks wrong and you can't tell whether it's Domdhi.Agents or the runtime itself, start a session with extensions disabled (in Claude Code, `claude --safe-mode` if your version has it) — a clean reproduction there rules out the toolkit. Otherwise temporarily rename the runtime folder (`.claude/` to `_claude_disabled/`, or `.codex/` to `_codex_disabled/`) and test in a plain session; rename it back when done. Either way the goal is the same: disable Domdhi.Agents to isolate the problem.
```

## Anti-Patterns

- **DO NOT interview vision or goals** — that's `/create:project-brief` territory; `/onboard` defers it
- **DO NOT clobber an existing CLAUDE.md** — always propose an additive merge, never overwrite
- **DO NOT call the built-in `/init`** — this command is self-contained
- **DO NOT generate `product/brief.md`** — `/onboard` produces architecture + context only; the brief is a user decision
- **DO NOT use `git add .` in the commit** — stage specific files; the adopter may have unrelated changes in their working tree
- **DO NOT mark ADRs as `Status: Accepted`** when reverse-engineering — use `Status: Inferred` to signal these are reconstructed decisions, not original ones
- **DO NOT ask more than 3 forcing questions** — the whole point is that code answers most questions; humans fill only the gaps code genuinely cannot
