# Onboard

Bootstrap the Domdhi.Agents doc chain from an existing codebase. Produces `docs/architecture/overview.md` and `docs/product/context.md` from reality (no brief, no templates to fill, no vision interview), then chains `/review:specialize`. A good result documents what the code actually is, marks reconstructed decisions as inferred, and leaves the project ready for `/prime` and the create-chain. It does not generate `product/brief.md`: the brief is a user decision.

It is the first command after installing Domdhi.Agents into a project that already has code. Where `/create:new-project` starts blank and interviews forward, `/onboard` reads the codebase backward.

`/onboard` has no doc prerequisites, since it is the bootstrapper. It refuses only when there is no detectable source at all, and then points at `/create:new-project`.

## Variables

INPUT: $ARGUMENTS

With `--yolo` in `$ARGUMENTS`, set YOLO_MODE = true: every gate below downgrades to a warning.

## Workflow

### 0. Record invocation (telemetry)

`/onboard` is user-typed, so it does not fire `PostToolUse:Skill`. Log the invocation first (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js onboard
```

### 1. Source check

Confirm there is source to reverse-engineer: `src/`, `lib/`, `app/`, top-level source files, or a language project file (`package.json`, `Cargo.toml`, `go.mod`, `*.csproj`/`*.sln`, `pyproject.toml`, `Makefile`).

If none is found and YOLO_MODE is false:

```
ABORT: No source code detected in this directory.
/onboard reverse-engineers an existing codebase — there is nothing to read.

If you are starting from scratch, use /create:new-project instead.
```

With YOLO_MODE, warn and continue.

### 2. Detect stack

Take the stack and the build and test commands from `gate.js` detection (manifest file to stack). Record the stack; it flows into every delegate prompt below.

### 3. Map the codebase

Fan out `Explore` agents in parallel before asking any questions:
- **Entry points and structure:** top-level directories, entry point files, module layout, and a shippable-assets inventory (icons and images, `manifest.json` `action`/`icons`/`options_page`, `public/` and `static/` assets, favicons, app store metadata). Reverse-engineering otherwise misses these surfaces (F10); list them so the architecture and design docs and the backlog account for them.
- **Dependency graph:** package manifests for direct and key transitive dependencies, and the internal import graph.
- **Test layout:** test directories, framework, and the rough unit/integration/E2E split.
- **Existing docs and direction:** root `README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`, any `docs/` markdown present before this run, `git log --oneline -30`, and any existing root `CLAUDE.md`.

Synthesize a codebase map; it drives the questions and the delegate prompts.

### 4. Forcing questions

Using `AskUserQuestion`, ask only what the code cannot answer and what sharpens the architecture doc, at most 3 questions, skipping any the map already answers. Do not interview vision, goals or product strategy; that is `/create:project-brief` territory. Defaults, picked by relevance:

1. Deployment target (cloud provider, on-prem, SaaS, local only); skip if infra files make it obvious.
2. Known pain points: parts of the codebase that are painful or need redesign. Always worth asking; code cannot tell you.
3. Scale expectations (personal tool, team tool, public SaaS, regulated enterprise); skip if the README or manifest says.

Record which answers were stated by the user and which were inferred from code, so the architecture doc can say so.

#### 4a. Persist scan results (before delegation)

Write the codebase map to `docs/.output/.state/work/{YYYY-MM-DD}/onboard-scan.md` so a crash before Step 5 does not force a re-scan. Include the project name, stack and build/test commands, entry points, key dependencies, test layout, existing docs found, recent git direction, and the forcing-question answers (stated or "inferred: …").

#### 4b. Project constraints and verification

**Runtime and verification.** The `gate.js` build and test commands this workflow records and configures are the application's own and never the Domdhi.Agents toolkit suite, including after agent-file edits. In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`, and dispatch the `architect` and `doc-writer` roles as that adapter describes. Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran: report completion only from the written `docs/architecture/overview.md` and `docs/product/context.md` passing their Step 5 and Step 6 validation, and the commit hash.

### 5. Generate architecture doc

Delegate to the `architect` agent (Task tool, `subagent_type: "architect"`) to write `docs/architecture/overview.md` in Reverse-Engineering Mode: document what exists, not what is ideal. The agent auto-loads the `architecture` skill. The prompt includes:
1. The project name (git remote, directory name, or README heading, in that priority).
2. The detected stack, the codebase map (or `onboard-scan.md`) and the forcing-question answers.
3. The instruction to mark every ADR `Status: Inferred` rather than `Status: Accepted`: these are reconstructed decisions, not conscious ones being documented for the first time.
4. Project constraints from Step 4b, only when they apply: the selected reference paths, the verified project constraints, and the instruction to record differences from them as application tasks rather than defects the doc silently fixes.

Validate afterward: `## Tech Stack` is present and populated, at least one ADR exists (even if inferred), and no `{placeholder}` values remain. If validation fails and YOLO_MODE is false, ask the user for the missing detail and re-delegate.

### 6. Generate project context

Delegate to the `doc-writer` agent (Task tool, `subagent_type: "doc-writer"`) to write `docs/product/context.md` from the scan data and the new architecture doc. The agent auto-loads `project-planning` and `documentation`. The prompt includes the stack and build/test commands (Step 2), entry points and key paths, the path to `docs/architecture/overview.md`, the output path, the instruction to write current state rather than aspirational state (it is the quick reference for the next agent that opens the repo), and the Step 4b constraints when they apply.

Structure the delegate should produce:

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

Validate afterward: the Build & Test commands match Step 2, the first line is not `<!-- @@template -->`, and no `{placeholder}` values remain. If validation fails and YOLO_MODE is false, re-delegate with the gap named.

### 6b. Reconcile legacy docs and stray tracked files

Brownfield repos often carry planning docs under old names (`_architecture.md`, `_prd.md`), a root `_backlog.md` beside `work/backlog.md`, or a duplicate `_feature-ideas.md`. <!-- migrate:keep (legacy-name examples retain the old underscore form) --> The create-chain is blind to them, so they silently become drift (two PRDs, two backlogs). Reconcile them now instead of leaving the legacy files beside the new domain docs (F2).

1. Detect: `node .claude/core/_lib/doc-drift.js`.
2. Reconcile each reported item, asking the user before deleting and showing a diff when a legacy doc has content the canonical lacks. Legacy and canonical both exist: merge what is unique into the canonical, then archive the legacy to `docs/.archive/` (or delete with approval). Legacy only: you already wrote the canonical in Steps 5 and 6; archive the legacy. Duplicate basename (root versus `todo/`): keep the canonical `todo/` copy and remove the root one.
3. Untrack stray ignored files (F7). Files committed before the `.gitignore` managed block existed stay tracked even though they now match an ignore rule (a legacy root `domdhi.db`, `docs/.output/.state/` artifacts; not `docs/.output/.memory/`, which is intentionally tracked):
   ```bash
   git ls-files -ci --exclude-standard          # lists tracked-but-now-ignored files
   git ls-files -ci --exclude-standard -z | xargs -0 -r git rm --cached
   ```
   `--cached` leaves the files on disk, since they are working state, not deletions. Report what was untracked.

### 7. CLAUDE.md merge

Inspect whether a `CLAUDE.md` exists at the project root.

**Case 0 — CLAUDE.md exists but is the install stub (C6):** the brownfield installer writes a minimal placeholder whose entire content points back here (it contains *"Run `/onboard`"*; a legacy stub also says *"This project uses the Domdhi Agents template"*). This is NOT a real adopter file to preserve — additively merging around it would leave a stale "Run /onboard" instruction after onboard has already run. If the existing CLAUDE.md matches the install stub (short, and contains that "Run `/onboard`" / "to complete setup" marker), treat it as **Case A** — generate a fresh project CLAUDE.md and overwrite the stub (no diff-confirm needed; there is no user content to protect).

**Case A — No CLAUDE.md exists (or it is the install stub per Case 0):**
Generate a new `CLAUDE.md` grounded in the onboard scan:
- Short project description (1-2 sentences, inferred from README or git log)
- Tech stack (from Step 2)
- Build and test commands (from Step 2)
- Key file paths and entry points (from the Step 3 map)
- Gate configuration note (point at `gate.js` or `gate.config.json`)

Do not copy the Domdhi.Agents workshop CLAUDE.md; generate a lean project-specific one that captures what was learned.

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

This step is self-contained: it does not call the built-in `/init` command.

### 8. Specialize agents

With `docs/architecture/overview.md` in place, chain `/review:specialize` (canonical workflow: `.agents/skills/review-specialize/SKILL.md`) to customize roles for this stack. Migrated roles and skills are edited in `.agents/roles` and `.agents/skills`, then rendered with `node .claude/core/render-shared-agents.js`. Native settings stay in their adapters; generated native files are not authoring targets. Root `CLAUDE.md` keeps only the application instructions from Step 7.

```bash
# Invoked as a sub-command, not a bash command — triggers the specialize workflow
/review:specialize --fix
```

`/onboard` deliberately defers the backlog to the create-chain, so `docs/work/backlog.md` is still a template stub at this point. That is expected: `/review:specialize` runs in architecture-only mode (C7) and does not abort on the missing backlog. Re-running it after `/create:project-epics` folds epic boundaries into the risk map.

Show the specialization report summary, and mention that `/review:personalize` can give the specialized agents names and personality.

### 9. Commit

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage specifically what this run created or modified: `docs/architecture/overview.md`, `docs/product/context.md`, and `CLAUDE.md` only if Step 7 modified it. Never `git add .`: the adopter may have unrelated changes. Do not stage `docs/.output/.state/work/{date}/onboard-scan.md`; `docs/.output/.state/` is ignored scratch and `git add` refuses it, so anything the docs rely on belongs in `overview.md` or `context.md`.

Write the commit message to `docs/.output/.state/.commit-msg`:

```
docs: /onboard — {project name} reverse-engineered
```

Then run:

```bash
node .claude/core/commit.js
```

### 9b. Capture feedback report

Chain `/review:feedback` as the final action. It rolls the captured telemetry (the onboard invocation from Step 0, the chained `/review:specialize`, gate runs, hooks, new memories) plus a short agent self-review into `docs/.output/findings/reviews/feedback-{date}.md` and `.json`, and self-commits. This is how onboarding signal reaches the maintainer from every project, so answer the self-review honestly (what was ambiguous, what you inferred, what you would change). Best-effort: if it fails, note it and continue to the report.

```
/review:feedback
```

### 10. Final report

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
