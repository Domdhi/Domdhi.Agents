# Domdhi.Agents — System Map

Complete inventory of commands, agents, skills, hooks, and core scripts — and how they wire together.

This is a **reference** doc: tables, inventories, and workflow graphs, kept in sync with what's actually on disk. For the conceptual framing — what a command, agent, skill, or hook *is*, and how the three tiers compose — read the explainer docs in [`../concepts/`](../concepts/): [`commands.md`](../concepts/commands.md), [`agents.md`](../concepts/agents.md), [`skills.md`](../concepts/skills.md), [`memory.md`](../concepts/memory.md), [`hooks.md`](../concepts/hooks.md). For the rendered per-command detail (flowcharts, dispatch shape), see [`./commands.md`](./commands.md).

---

## Command Inventory

### Setup Commands (run once per project)

| Command | Agent | Skill | Reads | Produces | Gate |
|---------|-------|-------|-------|----------|------|
| `/brainstorm` | product-strategist | project-planning | user input, codebase | `product/brainstorm.md`, `feature-ideas.md` | — |
| `/research` | product-strategist | project-planning | user topic, web | `product/research.md` | — |
| `/interview` | — (main) | — | user input | decision summary (chat only) | — |
| `/create:project-brief` | product-strategist | project-planning | `product/brainstorm.md`, `product/research.md` | `product/brief.md` | — |
| `/create:project-requirements` | product-strategist | project-planning | brief OR brainstorm OR research | `product/requirements.md` | needs phase 1 artifact |
| `/create:project-design` | ux-designer | ux-design | `product/requirements.md` | `design/spec.md` + 4 design files | needs PRD |
| `/create:project-architecture` | architect | architecture | `product/requirements.md` | `architecture/overview.md` | needs PRD |
| `/create:project-epics` | project-planner | project-planning | PRD + architecture | `work/backlog.md` | needs PRD + arch |
| `/create:project-todo` | project-planner | project-planning | `backlog.md` | `TODO_{Project}.md` | needs backlog |
| `/create:project-epics-todo` | project-planner | project-planning | `backlog.md` | `todo/TODO_epic{NN}.md` | needs backlog |
| `/create:new-project` | — (orchestrator) + chains all setup sub-commands | — (chains all setup skills) | user interview answers | full `docs/` scaffold + planning chain → `product/context.md` | fresh project (no filled planning docs); `--yolo` bypass |

### Build Commands (daily loop)

| Command | Agent | Skill | What it does |
|---------|-------|-------|-------------|
| `/route` | — (main) | — | Front door — assess a request's scale (Complexity rubric + architectural reach) → route to the right pipeline depth (Tier 0 `/do` … Tier 3 `/create:new-project`). Names skipped phases, logs to daily log; routing ≠ gate-bypass. Chat output only. |
| `/prime` | — (main) | — | Load context from the latest per-branch handoff (handoff-path.js) + git log. Chat output only. |
| `/todo` | Explore + project-planner + code-reviewer | — | Research codebase, assemble execution-ready checklist with AC |
| `/do` | Explore + domain agent | — | Execute one task from a TODO. Plan → implement → verify → commit. |
| `/run-todo` | Explore + domain agents + code-reviewer | — | Execute entire TODO checklist. Parallel waves, dev+QA pairs, auto-commit per wave. |
| `/run-tests` | playwright + general-purpose | — | Execute manual/E2E testing checklist with screenshots and verification |
| `/end` | — (main) | — | Write this session's handoff (docs/.output/handoffs/…) for next session |

### Supporting Commands (as needed)

| Command | Agent | Skill | What it does |
|---------|-------|-------|-------------|
| `/status` | — (script) | — | Parse TODO files + telemetry → text + HTML dashboard |
| `/investigate` | — (main) | — | 4-phase root cause diagnosis with 3-strike rule |
| ~~`/recap`~~ | — | — | *Removed — memory auto-compounds via Stop hook* |
| `/organize` | — (hooks) | — | Move plan files to dated folders |
| `/create:module` | product-strategist + architect + ux-designer + general-purpose | project-planning | Add a new module to an existing project |
| `/create:component` | — (main) | agent-creator, command-creator, skill-authoring | Create a new agent, command, or skill following conventions |
| `/listen` | — (main) | — | Post-MVP Tier 1: aggregate push-from-reality signals → dated intake file (no triage) |
| `/triage` | — (main) | project-planning | Post-MVP Tier 2: classify intake signals → ranked backlog (severity≠priority, auto-decide mechanical calls, kill/defer ledger) |

### Review Commands (periodic)

| Command | Agent | Skill | Modifies files? |
|---------|-------|-------|----------------|
| `/review:code-review` | code-reviewer | code-review | No (read-only) |
| `/review:security` | security-auditor | code-review | Yes (writes to `docs/.output/findings/reviews/`) |
| `/review:check-readiness` | architect + product-strategist + project-planner + ux-designer | project-planning, architecture, ux-design | No (read-only) |
| `/review:check-sync` | architect + project-planner + product-strategist | — | No (read-only) |
| `/review:check-templates` | — (main) | — | Yes (writes to `docs/.output/findings/reviews/`, `--multi` for cross-project) |
| `/review:update-docs` | doc-writer | project-planning | Yes (fixes drift) |
| `/review:qa` | qa-engineer | qa-engineer | Yes (generates tests) |
| `/review:optimize-backlog` | project-planner | project-planning | Optional |
| `/retro` | code-reviewer + doc-writer | code-review + project-planning | Yes (creates retro doc) |
| `/review:changelog` | doc-writer | project-planning | Yes (creates/updates CHANGELOG) |
| `/review:specialize` | architect | tailwind (as exemplar) | Yes (updates agents, creates skills) |
| `/review:optimize-agents` | — (main) | — | Optional (--fix mode) |
| `/review:personalize` | doc-writer | — | Yes (updates agent files) |
| `/review:memory-health` | — (script) | — | Yes (writes to `docs/.output/findings/reviews/` when not SILENT) |
| `/review:promote-memories` | — (script) | — | Optional (marks promotions) |

---

## Agent Inventory

| Agent | Skill(s) Loaded | Used By Commands |
|-------|----------------|-----------------|
| `architect` | architecture | project-architecture, module, specialize, check-readiness, check-sync |
| `product-strategist` | project-planning | brainstorm, research, project-brief, project-requirements, module, check-readiness, check-sync |
| `ux-designer` | ux-design, brand-guidelines, tailwind-css-patterns, design-taste-frontend, redesign-existing-projects | project-design, module, check-readiness |
| `project-planner` | project-planning | project-epics, project-todo, project-epics-todo, optimize-backlog, todo, check-readiness, check-sync |
| `code-reviewer` | code-review | code-review, run-todo, todo |
| `qa-engineer` | qa-engineer | qa |
| `doc-writer` | project-planning, documentation | changelog, update-docs, retro, personalize |
| `security-auditor` | code-review | security |
| `general-purpose` | full-output-enforcement, systematic-debugging, verification-before-completion, finishing-a-development-branch, using-git-worktrees | module, run-tests, do (domain tasks) |
| `playwright` | playwright-cli | run-tests |
| `shadow` | ghostwriting | (not referenced by any command) |

### Agents with no command usage
- **shadow** — available for direct invocation but no command explicitly calls it

---

## Skill Inventory

| Skill | Loaded By Agent(s) | Referenced By Command(s) | Purpose |
|-------|--------------------|--------------------------| --------|
| architecture | architect | project-architecture, check-readiness | Architecture doc template + quality criteria |
| project-planning | product-strategist, project-planner, doc-writer | brainstorm, research, project-brief, project-requirements, project-epics, project-todo, project-epics-todo, optimize-backlog, module, changelog, update-docs, retro | Navigator: brief / PRD / backlog / project-context templates + guidance (consolidated; folded in epic-writer + project-context) |
| documentation | doc-writer | — | Documentation wayfinding + verification rules |
| ux-design | ux-designer | project-design, check-readiness | UX spec template + quality criteria |
| brand-guidelines | ux-designer | project-design (updates it) | Brand colors/typography guide |
| code-review | code-reviewer, security-auditor | code-review | Navigator: reviewer identity, two-stage process, severity, risk routing, checklists |
| qa-engineer | qa-engineer | qa | Test strategy + generation patterns |
| playwright-cli | playwright | run-tests | Browser automation patterns |
| ghostwriting | shadow | — | Blog/article writing patterns |
| content-formats | — | — | LinkedIn, newsletter, Twitter, YouTube templates |
| agent-creator | — | create:component | Agent creation template + conventions |
| command-creator | — | create:component | Command creation template + conventions |
| tailwind-css-patterns | ux-designer | specialize (as exemplar) | Tailwind utility patterns |
| full-output-enforcement | general-purpose | — | Anti-truncation rules |
| systematic-debugging | general-purpose | — | 4-phase root cause investigation |
| verification-before-completion | general-purpose | — | Blocks success claims without fresh verification |
| finishing-a-development-branch | general-purpose | — | Branch integration workflow (merge, PR, keep, discard) |
| using-git-worktrees | general-purpose | — | Isolated worktree creation for feature work |
| skill-authoring | — | — | TDD for skill creation (baseline test before writing) |
| design-taste-frontend | ux-designer | — | Frontend design standards |
| redesign-existing-projects | ux-designer | — | Upgrade existing UI patterns |
| session-handoff | — | end, do, run-todo, run-tests, todo | Handoff template + fill rules consumed by session-persistence commands |

### Skills-optional (`.claude/skills-optional/` — gitignored, local only)

Optional aesthetic skills not tracked in git. Drop them in manually for design-heavy projects. Wire via `/review:specialize`.

---

## Workflow Graphs

### Setup Flow (run once)

```
brainstorm ──┐
research ────┤
interview ───┘
      │
      ▼
project-brief (optional)
      │
      ▼
project-requirements ──────────► project-design (optional)
      │                                │
      ▼                                │
project-architecture ◄─────────────────┘
      │
      ▼
project-epics
      │
      ├──► project-todo (master index)
      │         │
      └──► project-epics-todo (per-epic checklists)
                │
                ▼
          [ready to build]
```

### Build Loop (daily)

```
prime ──► todo ──► do ──────► end
              │         │
              │    (or)  │
              │         ▼
              └──► run-todo ──► end
                       │
                  (includes)
                       │
              ┌────────┼────────┐
              ▼        ▼        ▼
           plan    implement   verify
          (Explore) (domain)  (gate.js)
              │        │        │
              └────────┼────────┘
                       │
                    commit
```

### Supporting / Review (as needed)

```
run-tests ◄── after significant changes
code-review ◄── before merge / PR
check-sync ──► update-docs (if drift found)
qa ◄── generate tests for new code
retro ◄── after epic completion
changelog ◄── before release
optimize-backlog ◄── re-prioritize
specialize ◄── after architecture exists (once)
optimize-agents ◄── during implementation (periodic)
personalize ◄── give agents personality (once)
module ◄── add new feature area mid-project
```

---

## Duplication & Overlap — RESOLVED

### Commands deduped (2026-04-10)
Removed from all `create/*` commands:
- **Inline interview questions** — commands now reference the agent's skill Interview Questions section
- **Inline validation checklists** — commands now reference the skill's Required Sections Checklist
- **"Read skill" instructions** — removed from 15 commands (agents auto-load skills via frontmatter `skills:` field)

One intentional exception: `specialize.md` tells the architect to read `tailwind-css-patterns` as a format exemplar (not its own skill).

**Principle established**: Commands own orchestration (gates, mode detection, delegation, validation, commit). Skills own domain knowledge (templates, quality criteria, checklists, interview questions). Agents own personality and working style. No overlaps.

### Skills with no command consumers (but wired to agents)
| Skill | Status |
|-------|--------|
| tailwind-css-patterns | Loaded by ux-designer; also used as format exemplar by /specialize |
| full-output-enforcement | Loaded by general-purpose agent |
| systematic-debugging | Loaded by general-purpose agent |
| verification-before-completion | Loaded by general-purpose agent |
| finishing-a-development-branch | Loaded by general-purpose agent |
| using-git-worktrees | Loaded by general-purpose agent |
| design-taste-frontend | Loaded by ux-designer agent |
| redesign-existing-projects | Loaded by ux-designer agent |
| documentation | Loaded by doc-writer agent |
| content-formats | Not wired to any agent — standalone skill |
| skill-authoring | Not wired to any agent — standalone skill |

---

## Core Scripts

| Script | Purpose |
|--------|---------|
| `gate.js` | Build/test gate with auto-detection. Output: `docs/.output/.state/telemetry/` |
| `constants.js` | System-wide constants, phase artifacts, doc chain, memory decay config |
| `scaffold.js` | Copies templates → `docs/` and root configs |
| `memory-manager.js` | Memory CRUD + search + active-day decay + linting (JSON + SQLite FTS5) + inbox pattern (`inboxList/Promote/Discard`) + `deleteMemory` for /review:memory-defrag merge operations |
| `memory-manager-cli.js` | CLI dispatcher for memory-manager — adds `delete <category> <id>`, `inbox-list`, `inbox-promote <id> [--category <c>] [--id <i>]`, `inbox-discard <id>` |
| `memory-compiler.js` | Daily log → concept article compilation pipeline + cross-references (retired 2026-04-20 — preserved as backward-compat module; not prescribed in new pipeline) |
| `memory-extractor.js` | Haiku-powered structured extraction from daily logs via `claude -p` |
| `memory-curator.js` | Haiku-powered dedup/contradiction/merge analyzer — runs on Stop when `MEMORY_PROFILE=strict` |
| `memory-promoter.js` | Scan/rank/mark concepts for promotion to templates/skills |
| `memory-ingester.js` | Convert legacy daily recaps to daily log format (`ingest`, `status`, `--dry-run`) |
| `daily-log.js` | Standalone daily log capture — called by `memory-capture.cjs` Stop hook and pre-compaction hook |
| `decision-viz.js` | Decision log visualization — 6 data source parsers → vis.js Timeline + Network HTML |
| `metrics.js` | Workflow metrics from telemetry + git + TODOs |
| `template-updater.js` | Zone-aware template sync to downstream projects (`--merge`, `--dry-run`) |
| `guardrail-stats.js` | Guardrail hit-counter reporter — aggregates `guardrail-events.jsonl` (block/nudge/confirm) by decision + rule (`npm run guardrail:stats`, `--json`/`--since`/`--top`) |
| `_lib/hook-telemetry.js` | Hook telemetry emitters — `emitHookEvent` (timing) + `emitGuardrailHit` (guardrail hit counter, secret-safe: rule/decision/tier, never the raw command) |
| `_lib/project-root.js` | `resolveProjectRoot()` — anchors the **gitignored** `.state/memory-*` parts (FTS5 index, inbox, daily logs) to the MAIN git worktree via `git rev-parse --git-common-dir`, so all linked worktrees share one index/inbox (no copy, no loss on worktree removal). The **tracked** `.memory/` JSON source instead resolves via `resolveWorktreeRoot()` — a linked worktree checks it out naturally (ADR 0006 Am. 2). Precedence: `CLAUDE_PROJECT_DIR` > git-common-dir > `__dirname/../..` (non-git fallback). Used by `memory-manager.js` + the `memory-capture`/`session-start-prime` hooks |
| `tools/fleet.js` | Fleet orchestrator (workshop-only, not shipped) — roster-driven (`tools/fleet.json`) `status`/`sync`/`release` wrapping template-updater + publish + gate into one pass with a rollup (`npm run fleet:status\|sync\|release`). `release` caps `version.json` at `CHANGELOG_INLINE_CAP` (3) releases inline; older entries overflow to root `CHANGELOG.md` (workshop-only, never synced) |
| `status.js` | TODO progress + metrics → text + HTML dashboard |
| `memory-health-check.js` | Headless memory health check — FTS5 index freshness (vs the tracked JSON source, session-start-prime's criterion), inbox backlog, search backend, perf, quality, recency |
| `path-drift-lint.js` | Writer/reader path-drift lint — legacy `.output` tokens (incl. the Amendment-2 `memories/` store), flat-handoff literals/globs, unknown compartments vs `constants.js OUTPUT_PATHS` (`npm run path:lint`; wired into `/review:check-templates` Step 2e) |
| `cleanup-logs.js` | Prune old gate logs |
| `gen-timeline.js` | Weekly commit history generator → `docs/work/timeline.md` |
| `profile.js` | Memory profile resolver (`MEMORY_PROFILE=minimal\|standard\|strict`). Hooks call `isAtLeast()` to gate expensive work |
| `memory-benchmark.js` | Weekly recall hit-rate benchmark — Haiku picks expected slug per daily-log entry, compared against `searchMemories()` top-5 |
| `_lib/epic-overlap.js` | Parses `backlog.md` for per-epic file ownership and reports cross-epic overlaps. CLI used by `/create:project-epics` (warning) and `/review:check-readiness` (gate, with `## Acknowledged Overlaps` escape hatch) |

### Hooks (`.claude/hooks/`)

| Hook | Trigger | Purpose |
|------|---------|---------|
| `secret-scanner.cjs` | Pre-Write/Edit | Blocks secrets from being written to files |
| `guardrail.cjs` | Pre-Bash | Blocks/confirms destructive commands via `guardrail-rules.yaml` |
| `pre-compaction-archive.cjs` | Pre-Compact | Snapshots state + daily log before context compaction |
| `post-read-scrubber.cjs` | Post-Read | Warns on secrets in read files (non-blocking) |
| `organize.cjs` | Post-ExitPlanMode, Post-Bash | Organizes plans + screenshots into dated folders |
| `damage-control.cjs` | Post-Bash | Error analysis on failures — prevents retry spin loops |
| `command-usage-logger.cjs` | Post-Read/Bash | Logs command invocations + gate runs to `docs/.output/.state/telemetry/` |
| `memory-guard.cjs` | Post-Write | Warns when memory category approaches limit |
| `memory-capture.cjs` | Stop, PostToolUse:Bash | Captures daily log on Stop + curates under strict profile; commit enrichment on Bash. Compile pipeline retired 2026-04-20. |
| `session-start-prime.cjs` | SessionStart | Injects top structured memories (JSON from `memory-manager.js`) as system-reminder at session opening |
| `edit-capture.cjs` | Post-Edit | Captures edits to canonical docs (CLAUDE.md, architecture, skills) as daily-log entries (`MEMORY_PROFILE=strict` only) |
| `path-guardrail.cjs` | PreToolUse:Write/Edit/MultiEdit/NotebookEdit | Blocks write/edit ops via four-tier path schema (zeroAccessPaths/readOnlyPaths/noDeletePaths) and freeze-state |
| `secret-patterns.cjs` | (shared module) | Secret/credential regex patterns — used by `secret-scanner.cjs` and git pre-commit hook |
