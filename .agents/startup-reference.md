# Conditional startup reference

This reference supplies task-triggered details for the shared toolkit. Required startup rules live in `.agents/startup.md`; native tool and model rules live in the runtime adapters.

## Project

Domdhi.Agents is the toolkit workshop, authored under `.agents/` with generated Claude and Codex entry points. It supplies workflows from idea to implementation, shared roles and skills, and a memory system. Project specialization preserves project-owned customization. See `.agents/README.md` for source and delivery ownership.

## Three-Tier Architecture

```
Workflows (.agents/skills/*/references/workflow.md) — Orchestration (gates, delegation, validation, commit)
Roles (.agents/roles/*.md)                        — Shared behavior, identity and declared skills
Knowledge (.agents/skills/*/SKILL.md + assets)    — Domain techniques, templates and quality criteria
```

**No duplication between layers.** Workflows reference skill checklists rather than copying them. Roles declare their skills; adapters deliver native loading or explicit read instructions. Runtime model/tool metadata stays in `.agents/adapters/`; `.claude/` and `.codex/` are generated compatibility surfaces, with project-owned settings and additions preserved by the existing mergers.

## Agents

If the view you loaded still contains model-argument tokens, read its resolved form before applying the dispatch policy: `node .claude/core/render-shared-agents.js --prose .agents/startup-reference.md --runtime claude` for Claude, or the `.codex/core/` helper with `--runtime codex` for Codex. This read-only view leaves the canonical source intact.

Runtime tier maps live in `.agents/adapters/{runtime}/model-tiers.json`; canonical registries name tiers and native project overrides remain preserved. Claude resolves assigned values into native model arguments. Empty Codex tiers omit the argument and use the configured session model, following `.agents/adapters/codex/execution.md`.

| Agent | Tier | Role | Skills |
|-------|-------|------|--------|
| `product-strategist` | standard ⇡ | Brainstorming, research, briefs, PRDs | project-planning, verification-before-completion |
| `architect` | standard ⇡ | System design, ADRs, tech stack | architecture, verification-before-completion |
| `ux-designer` | standard ⇡ | UX specs, wireframes, themes | ux-design, brand-guidelines, design-taste-frontend, redesign-existing-projects, verification-before-completion |
| `project-planner` | standard ⇡ | Epics, stories, backlog | project-planning, verification-before-completion |
| `general-purpose` | standard ⇡ | Code implementation | full-output-enforcement, systematic-debugging, verification-before-completion, finishing-a-development-branch, using-git-worktrees |
| `code-reviewer` | standard ⇡ | Code quality review (read-only) | code-review |
| `security-auditor` | **audit** 🔒 | Security review (write scope: reviews only) | code-review |
| `qa-engineer` | standard | Test strategy and execution | qa-engineer, verification-before-completion |
| `doc-writer` | standard | Documentation and changelogs | project-planning, documentation, verification-before-completion |
| `playwright` | standard | Browser testing and automation | playwright-cli, verification-before-completion |
| `shadow` | standard | Voice-matched ghostwriting and articles | ghostwriting, content-formats |

Tier column: `standard ⇡` selects `deep` for the higher-stakes cases in the role's `## Model Routing` block; `audit 🔒` retains the security tier without a cheaper override. Bare `standard` has no higher-stakes route. The adapter maps own model names; changing a map updates tokenized prose and generated role settings together.

**Model hierarchy:** Main Agent plans, verifies and owns the TaskList. Subagents normally use `standard`; workflows select `deep` for new ADRs, HIGH-risk review, strategic briefs and multi-component refactors: {{model-arg:deep}}. Security review retains `audit`: {{model-arg:audit}}. The `fast` tier is not used until its bounded evaluation passes; the recorded 2026-06-02 Haiku 4.5 trial reported results it had not verified. A requested tier is a routing policy, not evidence of the model actually used.

**Model Policy (two layers):** Adapter registries and tier maps supply native role defaults; canonical role frontmatter has no runtime model field. Dispatching workflows select the higher-stakes argument above or omit `model` for routine work to retain native role settings. A per-call argument overrides a native default, so never supply a cheaper override to the audit role. **Kill-switch:** for the retained Claude session-wide override, resolve the selected model from its tier map into `CLAUDE_CODE_SUBAGENT_MODEL` and set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`; the model variable alone does not override native role defaults under the retained NA4.27 version evidence. The separate refusal-fallback control is recorded in `.agents/adapters/claude/model-tiers.json`, with dated version/documentation evidence and its limits. Keep launch overrides in the environment or Git-ignored local settings, never committed settings. The forced subagent-model override also affects the security role; never leave it enabled for a security-auditor session. Claude's `/tasks` reports the model actually used. **Review tiers:** HIGH-risk changes select `deep`; LOW/MEDIUM retain `standard`. The `--deep` backup selects the opposite tier, but distinct models are unproved when tiers resolve to the same value or both omit the argument. `--council` varies the review lens.

**Native types:** Commands also use `Explore` (Claude Code's built-in research agent) — not a custom agent in `.claude/agents/`.

**Agent-shape exception:** `shadow` keeps a role-suffix-free heading and its prose persona instead of the standard operating-standard sections, and declares its writing skills in canonical frontmatter while retaining its prose persona and Memory Inbox sections — the shape is kept for compatibility with existing adopter Shadow files. `/review:check-templates` treats Shadow as conforming.

`/review:specialize` creates stack-specific agents from the architecture doc. `/review:personalize` gives agents names and personalities.

## Commands

### Setup (run once per project)
- `/brainstorm` — Context-bundled module/general research + `work/todo/feature-ideas.md`
- `/research` — Validate assumptions → module research or stamped general findings
- `/interview` — Interactive Q&A to gather requirements
- `/create:project-brief` — Strategic vision → `product/brief.md`
- `/create:project-requirements` — PRD with FRs/NFRs → `product/requirements.md`
- `/create:project-design` — UX spec, wireframes, themes, mock → `docs/design/`
- `/create:project-architecture` — Tech stack, ADRs → `architecture/overview.md`
- `/create:project-epics` — Break requirements into stories → `work/backlog.md`
- `/create:project-todo` — Master implementation index → `TODO_{ProjectName}.md`
- `/create:project-epics-todo` — Per-epic story checklists → `todo/TODO_epic{NN}.md`
- `/create:component` — Create a new agent, command, or skill following conventions
- `/create:new-project` — Master orchestrator — scaffolds `docs/` and walks the full planning pipeline (`… → /create:project-epics → /create:project-todo → /review:check-readiness`, so a project ends with a master `TODO_{ProjectName}.md` tracker, not just a backlog), then (after `/review:specialize`) generates a lean, project-specific root `CLAUDE.md` grounded in the planning docs + the specialized stack's real build/test commands (additive-merge, never clobbers an existing real one)
- `/onboard` — Brownfield bootstrapper — reverse-engineers `architecture/overview.md` + `product/context.md`; merges CLAUDE.md additively; chains `/review:specialize`

### Build Loop (daily)
- `/route` — **Front door — scale-adaptive planning-depth router.** Assesses a request's scale (via `/todo`'s Complexity rubric + architectural reach) and routes it to the right pipeline depth: Tier 0 trivial/bugfix → `/do`; Tier 1 feature → `/todo`→`/run-todo`; Tier 2 module → `/create:module`; Tier 3 epic/greenfield → `/create:new-project` (or `/onboard`). **Routing ≠ gate-bypass** — it picks an entry point only; downstream hard gates stay in force, every skipped phase is named, and the decision is logged to the daily log (never a `--yolo`). Chat-first, no commit.
- `/prime` — Load context at session start from the latest per-branch handoff (resolved via `handoff-path.js`) + git log
- `/todo` — Create execution-ready checklist with research, AC, wave plan, self-review
- `/do` — Execute one task: size-aware (Opus direct or Sonnet delegate) → gate → AC verify → commit
- `/run-todo` — Execute entire checklist with wave-based execution, AC gates, auto-commit
- `/run-tests` — Manual/E2E testing with parallel playwright agents, screenshots, status protocol. **Canary Mode** (`--baseline` / `--compare {baseline.json}` / `--tolerance N`) adds post-deploy golden-signal monitoring. Full canary = `/loop 60s /run-tests --compare …` (scheduling is `/loop`'s job; no standalone `/canary`). → `docs/.output/evolution/canary/`
- `/end` — Save handoff context → `docs/.output/handoffs/{YYYY-MM}/{stamp}-{caller}-{branch}.md`

### Supporting
- `/create:module` — Add new feature area → `docs/modules/{module}/` + TODO checklist
- `/investigate` — Structured debug investigation with root cause analysis → `docs/.output/findings/investigations/`
- `/remember` — Capture a conversational insight to the daily log
- `/listen` — **Post-MVP Tier 1:** aggregate signals (git, telemetry, agent-updates, backlog drift, external) → `docs/.output/evolution/intake/{date}.md`. For when the backlog drains and work shifts from pull-from-plan to push-from-reality. Pairs with `/triage`.
- `/triage` — **Post-MVP Tier 2:** turn a `/listen` intake **plus the `feature-ideas.md` inbox** into ranked backlog stories (the ongoing drain of the idea inbox — `--ideas-only` drains just the inbox; the greenfield drain is `/create:project-epics`). Scores **Severity** objectively, then decides **Priority** (promote/defer/kill/research) — auto-deciding mechanical calls, interviewing only genuine judgment calls. Drained ideas are annotated in place (the inbox is never archived); kills/defers land in an append-only ledger (`docs/.output/evolution/triage/_decisions.md`). Severity≠Priority + the durable ledger are the load-bearing ideas. → `docs/work/backlog.md`
- `/evolve` — **Post-MVP Tier 3:** cycle rollover when the backlog is *fully delivered*. Archives drained `backlog.md`/`TODO_*.md` to `docs/work/todo/_archive/cycle-{N}-{stamp}/` via `git mv` (history-preserving) + `_cycle-summary.md`, then regenerates the cycle N+1 plan from production evidence (intake + retros + deferred items), not a blank interview. Gated; `--force` carries incomplete forward; architecture carries forward unless `--replan-arch`; `--dry-run` previews.

### Review (periodic)
- `/review:code-review` — Risk-tiered architecture compliance review (read-only). `--deep` adds a cross-model second opinion (Sonnet+Opus); `--council` runs an N-reviewer council (one `code-reviewer` per lens — correctness/security/architecture/performance — → anonymized cross-validation → Opus chairman, aggregated by `council.js`). Single-vendor by design; the survival rule rewards independent confirmation, never agreement.
- `/review:feedback` — Template-performance report: telemetry digest (`feedback-digest.js`) + agent self-review → `docs/.output/findings/reviews/feedback-{date}.{md,json}`. Auto-chained by `/onboard` + `/create:new-project`. Fleet rollup: `npm run feedback:rollup -- <projectDir>…` (maintainer-only).
- `/review:security` — OWASP audit, vulnerability detection, secret scanning → `docs/.output/findings/reviews/`
- `/review:qa` — Generate tests for existing code
- `/review:check-readiness` — Gate check before implementation (read-only)
- `/review:check-sync` — Detect documentation drift (read-only)
- `/review:check-templates` — Audit `.claude/` system health — orphaned agents, unused skills, missing hooks
- `/review:update-docs` — Fix drift found by check-sync
- `/review:optimize-backlog` — Dependency graph, critical path analysis
- `/retro` — Epic retrospective + pattern extraction. Runs a **code-review pass over the epic's commits first** (findings feed the retro); `--skip-review` skips it when already reviewed (e.g. inside `/sweep`, whose Phase 1 satisfies it)
- `/review:changelog` — Release notes from stories + git
- `/review:specialize` — Customize agents for your tech stack
- `/review:optimize-agents` — Re-align agents with actual codebase
- `/review:evolve-skills` — **Self-improving skills:** mines `agent-updates` misalignments (IMPROVE) + clustered `workflows`/`patterns` memories (CREATE) into skill proposals, gated by a differential eval (`with_skill` must beat baseline, via `skill-eval.js`). Drives `skill-creator`; wired into `/sweep` Phase 5b as propose-only.
- `/review:personalize` — Give agents names and personalities
- `/review:memory-health` — Compile + lint + decay report (headless-compatible)
- `/review:promote-memories` — Surface high-confidence concepts for promotion to templates/skills
- `/sweep` — Autonomous post-work maintenance: code-review → retro → implement recs → promote → optimize-agents → defrag → memory-health, one auto-approved pass (defrag LAST on the grown store). Per-phase commits, resumable Phase Log, final report.
- `/review:timeline` — Generate/update weekly commit history → `work/timeline.md`
- `/review:status` — Parse TODO files, show progress, HTML dashboard → `docs/.output/.state/status.html` (chat-only)
- `/review:organize` — Move plan files to dated folders (chat-only; runs `organize.cjs`)

## Document Naming

All generated docs live in domain folders under `docs/` — **no underscore prefix** (the folder provides the namespace; see `docs/CLAUDE.md`). Producers: `product/brief.md` (`/create:project-brief`), `product/requirements.md` (`/create:project-requirements`), `architecture/overview.md` (`/create:project-architecture`), `design/spec.md` (`/create:project-design`), `work/backlog.md` (`/create:project-epics`), `.output/handoffs/{YYYY-MM}/{stamp}-{caller}-{branch}.md` (`/end` + `/do` + `/run-todo` + `/run-tests` + `/todo` — per-session/per-branch, resolved by `handoff-path.js`), `product/context.md` (scaffold.js), `work/timeline.md` (`/review:timeline`).

`/brainstorm` is a dynamic utility command — it always writes the seed `product/brainstorm.md`, plus topic-driven satellites (e.g. `feature-ideas.md`) as the session warrants, not a fixed schema.

### Directory Structure

`docs/` is organized **by concern** (the 7 domains), not artifact type — see the
navigation contract at `docs/CLAUDE.md`. ADR: docs/ Domain Taxonomy.

```
docs/
├── CLAUDE.md               # The navigation contract (auto-loaded)
├── product/                # brief.md requirements.md context.md brainstorm.md research.md
├── architecture/           # overview.md api.md data-model.md decisions/NNNN-*.md (ADRs)
├── design/                 # spec.md wireframes.md theme.{light,dark}.md mock.html
├── engineering/            # setup.md conventions.md testing.md
├── operations/             # deploy.md observability.md security.md runbooks/
├── work/                   # WHAT now & next — the living plan (durable only)
│   ├── backlog.md roadmap.md timeline.md
│   └── todo/               #   TODO_*.md (+ _archive/ — /evolve closed cycles)
├── reference/              # onboarding.md glossary.md links.md
│   └── agents/             #   toolkit reference (reaches a project only through the publish artifact; install and update do not deliver it)
├── modules/{module}/       # per-feature zoom — brief.md (+ more as earned)
└── .output/                # generated zone (ADR 0006 lifecycle split)
    │  ── durable history — TRACKED ──
    ├── handoffs/           # /end + /do + /run-todo + /run-tests + /todo per-session handoffs
    ├── findings/           #   reviews/ investigations/ research/
    ├── plans/              # /do + /run-todo execution plans
    ├── evolution/          #   intake/ triage/ canary/ skills/ agents/ (the post-MVP loop)
    │  ── curated memory SOURCE — TRACKED (syncs over git) ──
    ├── .memory/            #   patterns/ constraints/ decisions/ workflows/ rejected-approaches/
    │  ── regenerable / derived / transient — GITIGNORED (one folder) ──
    └── .state/             #   memory-{index,inbox,daily}/ telemetry/ sessions/ screenshots/
        └── work/{date}/{task}/  # task working files — ephemeral, never ships (was the "scratch" path)
```

## Template Marker Convention

Template files contain `<!-- @@template -->` as their first line; `scaffold.js` preserves it when copying into `docs/`. **Hard gate checks treat files with this marker as non-existent.** When a command fills a template it writes new content *without* the marker — distinguishing "scaffolded but unfilled" from "actually created."

**Skill-owned document templates live in each producing skill's `assets/`** (e.g. `ux-design/assets/spec.md`, `project-planning/assets/backlog.md`) — single-sourced so skill and scaffold share one copy. `scaffold.js` seeds `docs/` from them via `SKILL_TEMPLATE_MANIFEST`. Only no-owner templates remain in `.claude/templates/`: the `CLAUDE.md` docs-structure guide and `root/` configs.

**Project additions to a template skill.** Skills are Template zone (overwritten on sync), so any project-specific guidance added to a *template-owned* skill would be clobbered on the next `template-updater`/`fleet:sync`. Two sentinel forms, both implemented in `_lib/skill-merger.js` and wired into `template-updater.js`'s template-zone branch: (1) whole-tail marker `<!-- @@project-additions -->` — everything **below** it is adopter-owned and **preserved under `--merge`**, the template head above still refreshes; (2) anchored inline fence `<!-- @@project-additions:start -->` / `:end` — for a bullet or paragraph inserted INSIDE an existing template-owned section (an escalation rule, a test pattern), which the whole-tail marker can't protect since it only ever draws one line in the sand. On merge, a fenced block is re-anchored to its nearest preceding heading and reinserted at the end of that section; an orphaned anchor (heading renamed/removed upstream) is recovered under a synthesized EOF heading and flagged, never silently dropped. Both forms generalize the crude `skills/brand-guidelines/**` project-zone exception in `zone-classifier.js` (a one-off whole-subtree opt-out) into a section-level mechanism for *any* skill. **Fence-aware matching:** both sentinels are matched only outside fenced (` ``` `) code blocks, so a doc showing the marker as a usage *example* (`skill-authoring/SKILL.md` does) is never mistaken for a file carrying real additions — this was a live bug (found 2026-07-11): the naive substring match previously treated that doctrine section's own illustration as a real tail marker, silently freezing everything below it in every adopter on every sync. `fleet:diverge`'s blob-identity comparison uses the companion `stripAdopterOwned()` (strips both forms) rather than raw marker-head text, so a Form-2-only file doesn't false-positive as diverged. **Enforcement:** commands that add project content to a template skill (`/review:specialize`, `/sweep`, `/review:evolve-skills`) — and any agent hand-adding a field-proven rule to a shared skill during normal work — MUST use one of the two forms, never edit template-owned prose in place.

## Skill Authoring & Spec Conformance

Skills follow the [Agent Skills open standard](https://agentskills.io/specification). Enforced by `node .claude/core/skill-conformance.js` (wired into `/review:check-templates` Step 2b): `SKILL.md` body ≤ 500 lines (WARN), `name` frontmatter must equal the parent directory name (ERROR), `description` ≤ 1024 chars (ERROR).

**`description` content (CSO):** state **both** what the skill does (a brief clause) **and** when to use it, keeping the `"Use WHEN… Triggers: …"` structure. Naming *what it covers* is fine; **never summarize the step-by-step workflow** — that lets Claude follow the description as a shortcut and skip the body. (Authoritative: `skill-authoring/SKILL.md`.)

**Progressive disclosure** — move heavy content out of `SKILL.md` into spec subdirectories, one logical unit per file, referenced one level deep: `references/` (read on demand), `assets/` (copied into output — **the scaffold source of record** for doc templates, raw with the marker, wired into `SKILL_TEMPLATE_MANIFEST`), `scripts/` (executable code). The split is the largest recurring token win: the whole `SKILL.md` loads on every activation; subdirectory files load only when a pointer calls for them. When relocating content, move it **verbatim** (byte-for-byte) and verify with a set-difference against the git blob — do not paraphrase.

**Skill doctrine & evolution** (2026-06-06, ADR `docs/architecture/decisions/0003-self-improving-skills.md`): the old `skill-authoring` "**failing test FIRST**" Iron Law was replaced by **evidence-of-a-gap-first + differential-eval-after** (`with_skill` must beat `without_skill`/`old_skill`) — one rule for human and machine authoring. The operational loop is the ported **`skill-creator`** skill (Create/Eval/Improve/Benchmark; zero-dep harness in `skill-eval.js`). The autonomous driver is **`/review:evolve-skills`**. `skill-authoring` owns *doctrine*; `skill-creator` owns *mechanics*.

## Hard Gates

Create commands enforce prerequisite checks (real, non-template files) to prevent out-of-sequence execution:

| Command | Requires |
|---------|----------|
| `/create:project-requirements` | One of: `product/brief.md`, `product/brainstorm.md`, `product/research.md` |
| `/create:project-architecture` | `product/requirements.md` |
| `/create:project-epics` | `product/requirements.md` AND `architecture/overview.md` |
| `/create:project-design` | `product/requirements.md` |
| `/create:project-todo`, `/create:project-epics-todo`, `/review:optimize-backlog` | `work/backlog.md` |
| `/review:check-readiness` | Required docs PLUS no unacknowledged epic overlaps in `backlog.md` (`epic-overlap.js`) |

**`--yolo`** bypasses hard gates (downgrades to warnings) — an explicit user override only.

**Gate posture (F3):** hitting a hard gate means *generate the missing prerequisite, then resume* — not bypass. Commands must never present "proceed off the stub/stale doc" or `--yolo` as the **Recommended** option in a clarifying question. **Enforcement (F8):** gate checks (the `<!-- @@template -->` first-line test) are instruction-level, not tool-enforced — they rely on the agent performing the check. `doc-drift.js`'s `isRealDoc()` is the reusable tool-checkable primitive (real doc vs scaffold stub).

## TODO Hierarchy

```
/create:project-epics       →  docs/work/backlog.md        (epic definitions — source of truth)
/create:project-todo        →  docs/TODO_{Project}.md       (master index — epic-level status)
/create:project-epics-todo  →  docs/work/todo/TODO_epic{NN}.md   (per-epic checklists — story tasks)
/do | /run-todo             →  picks task, implements, updates checklists
```

## Build & Test Gate

`gate.js` auto-detects the build system: `package.json` → `npm run build`/`npm test`; `Cargo.toml` → cargo; `go.mod` → go; `*.sln`/`*.csproj` → dotnet; `pyproject.toml` → ruff+mypy/pytest; `Makefile` → make. Override with `gate.config.json`.

**Domdhi.Agents (self-hosted toolkit workshop):** `package.json` at the repo root means `node .claude/core/gate.js test` auto-detects `node` and runs the real Vitest suite — no `gate.config.json` needed. In Codex use `node .codex/core/gate.js test`; toolkit tests run in Domdhi.Agents only. Adopter Build/Test/PR gates remain application-only, including after agent-file changes. `_latest-summary.json` records `{ stack, overall, ... }`.

## Publishing

Two-repo workflow: the private workshop repository publishes a curated subset to the public `Domdhi.Agents` storefront on GitHub. The storefront is a separate git repo checked out **inside** the workshop at `_Domdhi.Agents/` (gitignored here, excluded from the publish walk); commit and push it from there.

```bash
npm run publish:dry                          # preview (also shows what --prune would remove)
npm run publish:public                       # sync into _Domdhi.Agents/
npm run publish:release -- "release: vX.Y"   # sync + commit inside the mirror (pushing it is a separate, authorized step: `node tools/publish.js _Domdhi.Agents --prune --commit "msg" --push`)
```

The source set is **git-tracked files only** (`git ls-files`) — gitignored files cannot ship, and an untracked file will not ship until `git add`ed (the run warns with a count). A source that is not a git top level falls back to a filesystem walk.

Ships only what `tools/publish-manifest.json` (the allowlist) permits. A hardcoded `DEFAULT_EXCLUDES` in `tools/publish.js` always strips working state (`docs/.output/**` — which covers handoffs — `docs/work/todo/**`, `docs/research/**`, `docs/modules/**`, `docs/design/**`, `.claude/settings.local.json`, `.claude/agent-memory/**`, `tools/**`, etc.) even if the manifest would match.

**Publish vs update — two operations.** Use `publish:public` for the FIRST publish to an empty target (creates the target's `.claude/`). For incremental sync to an existing `.claude/`-bearing project, use `node .claude/core/template-updater.js update <path>` — it enforces the zone model (Template/Project/Mixed) to preserve customizations.

### Fleet orchestration

`publish:public` and `template-updater` act on **one** repo. The fleet (every adopter that carries a copy of `.claude/`) is driven from a single roster, `tools/fleet.json` (storefront + adopters with `path`/`branch`/optional `exclude` reason). `tools/fleet.js` wraps the per-repo CLIs into one roster-driven pass with a consolidated pass/fail rollup, so the fleet list lives in a file, not in prose.

```bash
npm run fleet:status                                  # roster + each adopter's version vs the workshop
npm run fleet:diverge                                 # audit adopters for LOCAL edits to harvest UP before a sync (read-only)
npm run fleet:diverge -- --adopter <name>             # audit one adopter by roster name
npm run fleet:sync -- --dry-run                       # preview a fleet-wide template-updater --merge + orphan scan
npm run fleet:sync                                    # sync all active adopters, commit .claude/ locally, rollup
npm run fleet:sync -- --gate                          # ALSO run each adopter's gate (off by default — sync touches .claude/, not code)
npm run fleet:sync -- --no-commit                     # leave adopter trees uncommitted (old behavior)
npm run fleet:sync -- --prune-orphans                 # also delete template fossils (+ their colocated tests)
npm run fleet:release -- --note "<changelog prose>"  # gate workshop → bump version.json → publish → sync → rollup
```

**Divergence audit (`fleet:diverge`):** the reconciliation counterpart to sync — **read-only**, it answers "did an adopter locally *improve* a shared template file we should harvest UP before a sync overwrites it?" and writes a decision sheet to `docs/.output/findings/reviews/{stamp}-fleet-diverge.md`. The load-bearing idea is **content-identity, not a version baseline**: `template-updater` only ever writes *workshop* content into an adopter, so any adopter file whose blob SHA matches **some historical workshop blob for that path** was synced (current or behind) and is skipped — only a file matching *no* historical blob is a genuine local edit. This cancels the "behind" delta exactly, at any version distance, so a stale adopter shows its real edits and not the version gap (the whole point — a v4.95 adopter must not read as diverged just for lagging v4.97). Historical blobs come from `git rev-list --all --objects` (tree enumeration — captures merge-introduced blobs a `git log --raw` diff would miss); adopter SHAs are computed in-process (`sha1("blob <len>\0"+bytes)`, robust to the symlinked skill-dirs that abort a batched `git hash-object`). Skill files split at the `<!-- @@project-additions -->` marker — an edited *above-marker head* harvests, a changed tail is `preserved` (sync-safe). **Agents (Mixed zone) and settings (Project zone) are excluded** — their per-adopter divergence is personalization/config a sync already preserves, not a template signal. Adopter-added files (never shipped) are a secondary `added-local` list, never the harvest headline (dominated by adopter-private trees like `skills/.archive/`).

**Safety model:** `fleet:sync` **commits each adopter locally but NEVER pushes** — it stages the **`.claude/` subtree only** and commits just that pathspec, so an adopter's own files (its `CLAUDE.md` — a Mixed-zone file that mixes template + adopter prose — its `docs`, its output) are left untouched for manual review; you push each adopter by hand. `--no-commit` restores the old write-only behavior. The **per-adopter gate is OFF by default** (`--gate` opts in): a `.claude/` sync changes the template, not the adopter's code, so its test suite is irrelevant — and a red adopter env (e.g. an un-provisioned linter) would otherwise read as a false sync failure. `release` requires `--note` (the version bump is mechanical bookkeeping — `--bump minor|major` on the two-part `X.Y` version — but the changelog prose is never fabricated) and **gates the workshop before publishing** so a red template aborts. **Changelog cap:** `version.json` ships to every adopter on sync, so `release` keeps only the newest `CHANGELOG_INLINE_CAP` (3) releases inline and demotes older entries into root `CHANGELOG.md` (workshop-only — not in the publish allowlist, not a `.claude/` subtree, so it never propagates). **Orphan detection** uses the git-history intersection (a file is a fossil only if the template once shipped it *and* no longer does) confined to template-owned subtrees (`commands/ core/ hooks/ skills/ templates/` — never `agents/` or `settings*`); orphans are **report-only** unless `--prune-orphans` is passed. Excluded adopters (e.g. an adopter with an unprovisioned `.venv`) are skipped, not deleted from the roster.

## Output Persistence Convention

**All agent output MUST be written to a file before reporting to chat.** Work that only exists in chat is lost on compaction. No exceptions.

**Path rules** (by output type): planning docs → their domain folder under `docs/` (`product/`, `architecture/`, `design/`, `work/` — never `docs/_project-*.md`); feature-scoped research/brainstorm/investigation → `docs/modules/{feature}/`; general research → `docs/.output/findings/research/`; reviews & audits (incl. `retro-{epic-slug}.md`) → `docs/.output/findings/reviews/`; investigations → `docs/.output/findings/investigations/`; execution plans → `docs/.output/plans/`; session handoffs → `docs/.output/handoffs/{YYYY-MM}/{stamp}-{caller}-{branch}.md` (resolved via `handoff-path.js`); task working files → `docs/.output/.state/work/{date}/{task}/`; status/metrics → `docs/.output/`; telemetry → `docs/.output/.state/telemetry/`; agent feedback → `docs/.output/evolution/agents/{date}.md`; signal intake → `docs/.output/evolution/intake/{date}.md`; triage → `docs/.output/evolution/triage/{date}.md` + `_decisions.md`; cycle archive → `docs/work/todo/_archive/cycle-{N}-{stamp}/`; canary → `docs/.output/evolution/canary/`; skill evolution → `docs/.output/evolution/skills/{date}/`.

**Context-bundled output:** when brainstorm/research/investigation is about a specific feature, it goes under `docs/modules/{feature}/`; when project-wide, under `.output/`. The command decides; if unclear, ask.

### Run-Stamp Convention (universal)

Every fresh-each-run output **file** is named with a `{YYMMDD-HHMM}` prefix (from `date +%y%m%d-%H%M`). **Compute the stamp once per command run and reuse it verbatim for every file that run writes** (so same-day re-runs never clobber and one run's artifacts sort together). In `/sweep` all phases share one stamp; on resume, reuse the in-progress stamp. When a command writes a file early and `git add`s it later (`/do`, `/run-todo` plans), the stamp must be identical at both points.

**Applies to:** all `/review:*` reports + workspaces under `reviews/` (incl. `feedback-{stamp}.{md,json}`, `council-{stamp}/`); `research/`, `investigations/` slugs; `/do`/`/run-todo` plans (`plans/{stamp}-do-{slug}.md` — these stay **flat**; `organize.cjs` recognizes the stamp as already-organized). Commands **write flat** under their target folder; the `{YYYY-MM}/` month buckets you'll also see in `findings/{reviews,research,investigations}/` are post-hoc housekeeping (organize/codemod homing) — readers must accept both layouts, writers never hand-build a month path.

**Does NOT apply to** (deliberate exceptions): append-style day logs (`intake/`, `triage/`, `agent-updates/`, `memories/daily/` — stay `YYYY-MM-DD`, append a `## Run {HH:MM}` section inside); per-day/per-run dirs whose inner files already carry a time/slug (`work/`, `screenshots/`, `canary/`, `pending-curation/`, `skill-evolution/`); predictable resume-state files (`onboard-scan.md`, `new-project-interview.md`, epic-keyed `retro-{slug}.md`); and date values inside file *content* (display, not filenames).

## Post-Command Commit Convention

After any lifecycle command that creates/modifies files, commit before reporting:

1. Stage the specific files created/modified (not `git add .`)
2. Write the commit message to `docs/.output/.state/.commit-msg` (Write tool, no shell escaping). Format: `docs|feat|refactor: /command-name — brief summary`. Do not add automatic attribution. Then run `node .claude/core/commit.js`. Inline `git commit -m` is blocked by the commit-guard hook.
3. Do NOT push — commit locally only.
4. Include the commit hash in the Report output.

**Commit:** all `/create:*`, `/brainstorm`, `/research`, `/todo`, `/review:*` (except chat-only `/review:status` + `/review:organize`), `/investigate`, `/retro`. **Chat-only:** `/prime`, `/route`, `/review:status`, `/review:organize`. **Own commit logic:** `/do`, `/run-todo` (commit per wave).

### Commit & PR helpers (`commit.js`, `pull-request.js`)

**`commit.js`** commits only-staged by default (no `git add` of its own) — multi-process-safe. `--all` sweeps everything (`git add -A`) — UNSAFE when a concurrent process (parallel `/run-todo`, background agent) shares the working tree. **`--paths <pathspec…>`** stages an explicit, reviewable set (`git add -- <paths>`) then commits only-staged — the multi-process-safe way to commit specific files. `--paths` and `--all` are mutually exclusive. Composes with `--amend`/`--dry-run`/`--file`/`-m`/`--no-scan`.

**`pull-request.js`** — host-detecting PR helper (orchestrator-facing; agents don't open PRs). Auto-detects the host from `origin` (GitHub → `gh`, Azure DevOps → `az`) and bakes in auto-merge + squash + delete-source. `create` runs a pre-flight gate (refuses on the default branch / when behind `origin/<default>`, pushes first) and a **post-create verification that auto-merge actually took** (both CLIs silently leave it unset). Body sourced from `docs/.output/.state/.pr-body` (Write tool, no escaping) or `--body-file`. Hard guardrails: explicit-invocation only (a green build is NOT approval), current branch as-is (never re-scopes/switches), never `--no-verify`. `--dry-run` prints every command and does nothing.
```bash
node .claude/core/pull-request.js create --title "feat: thing" [--draft] [--dry-run] [--force]
node .claude/core/pull-request.js status [--id N]
node .claude/core/pull-request.js watch  [--id N]
```

## Memory System

```bash
node .claude/core/memory-manager.js report                       # View all memories
node .claude/core/memory-manager.js search "topic"               # Search by relevance
node .claude/core/memory-manager.js create|update|delete {cat} {id} ['{json}']
node .claude/core/memory-manager.js inbox-list|inbox-promote|inbox-discard {id}
node .claude/core/memory-manager.js decay-report | lint | analytics | prune-unused | supersede
node .claude/core/memory-promoter.js scan [--top N] | mark <slug> <target>
```

`scan`/`mark` operate on hand-created JSON memories (`docs/.output/.memory/{cat}/{slug}.json`) + extractor output. Hand-created memories bypass the minimum-source filter (intentional human curation). Confidence levels: 0.9 (architecture) → 0.8 (retro-validated) → 0.7 (implementation-proven) → 0.6 (story-discovered) → 0.5 (session-observed).

**Tracked source + ignored index (F5, ADR 0006 Am. 2):** the curated JSON source `docs/.output/.memory/{cat}/*.json` is **tracked** — it syncs over git, which is what delivers cross-machine memory continuity. Only the derived/transient parts live under `docs/.output/.state/memory-*` (the FTS5 `memory-index/` db, `memory-inbox/` drafts, `memory-daily/` raw logs) and stay **gitignored/regenerable** — the db self-heals from the JSON via a stale/absent check in `session-start-prime.cjs`. So `git add docs/.output/.memory/...` now versions real source (no longer a no-op); `git add` of an ignored `.state/` path is refused (it exits 1 and omits the path), so never stage `.state/` parts. (`/onboard`'s reconcile + `git ls-files -ci` untrack any *`.state/`* parts committed before the ignore rule — F7.)

**Worktree behavior (F9, ADR 0006 Am. 2):** tracked `.memory/` JSON is checked out naturally in each linked worktree and read from the active source checkout. Ignored `.state/` parts (FTS5 index, inbox and daily logs) remain shared at the main worktree's Git-common-directory root, not a separate per-worktree index. `_lib/project-root.js` and `_lib/memory-paths.js` retain that source/state distinction. Neutral source overrides (`AGENTS_PROJECT_DIR`, `AGENT_SOURCE_ROOT`), then `CODEX_PROJECT_DIR`, then legacy `CLAUDE_PROJECT_DIR` select source context; `AGENT_SHARED_STATE_ROOT` independently overrides ignored state. Direct legacy Claude-only helpers retain their historical state-root override, while hook context derives common state and passes neutral roots. Installed code/assets resolve separately. See `.agents/adapters/codex/README.md` Context contract for exact precedence/fallbacks and native helper CLI/import behavior; do not assume a hook subprocess selects the parent runtime. Codex uses `.codex/core/`, Claude `.claude/core/`.

**Acquisition:** the Main Agent writes 0–3 structured memories per session-handoff (every `/do`, `/run-todo` wave, `/run-tests`, `/todo`, `/end`) by promoting reusable-learning bullets from the session handoff it just authored, via `memory-manager.js create`. Zero extra LLM cost (it already holds context). `memory-extractor.js` is now manual/brownfield-only (ADR `docs/architecture/decisions/0001-memory-unification.md`). Assign each memory an `importance` 1–5 (creation accepts `content.importance`; storage normalizes it to top-level `importance`, with the `MEMORY_FILTERS.IMPORTANCE_DEFAULT` default) — the retention floor.

**Recall:** before working, every sub-agent searches the curated store for relevant patterns/constraints/decisions/rejected-approaches (per each agent's **Memory Recall Protocol**) — Bash-capable agents via `memory-manager.js search`, the rest via Grep over the JSON. Recall-before and capture-after are the two halves of the agent memory contract.

**Inbox staging:** sub-agents never write straight into the curated store — they drop draft JSON into `docs/.output/.state/memory-inbox/` (per each agent's **Memory Inbox Protocol**). Only the Main Agent promotes (`inbox-promote`) or discards. The Stop hook (`memory-capture.cjs`) captures raw daily logs + optionally runs the Sonnet curator (`MEMORY_PROFILE=strict`) which *dedups*, it does not create.

**Decay** (active work days, not calendar — untouched project = zero decay): `decisions 0.98^days` (~35-day half-life), `constraints 0.97^days` (~23), `patterns 0.95^days` (~14), `workflows 0.93^days` (~10). <0.3 stale, <0.1 archive. Config: `constants.js MEMORY_DECAY`. **Importance is the retention floor:** `calculateDecayedConfidence` multiplies the curve by `importance/3` so importance ≤2 can cross the stale threshold even on an active repo (the hoarding root cause), ≥4 resists. Decay-independent dead-weight → `memory-manager.js analytics` / `prune-unused` (dry-run by default).

**Supersession forgets by validity:** memories that became *wrong* (not just decayed) get `invalid_at` + `superseded_by` and are hidden from current-state reads (`includeSuperseded: true` reads history). Flag-then-confirm: `createMemory` flags overlapping predecessors via a cheap FTS5 query; the Main Agent confirms at `/end` with `memory-manager.js supersede`. Never automatic. **Honest usage:** `usage_count` increments only on genuine retrieval (not passive injection / update); ages via `halveUsageCount` (every 14 silent active-days). Injection ranking (`session-start-prime.cjs`) = importance-floored decayed_confidence × recency primary, aged usage as tiebreaker only, hard top-N budget. Validated by `npm run memory:eval`.

## Hooks

| Hook | Trigger | Purpose |
|------|---------|---------|
| `session-start-prime.cjs` | SessionStart | Inject top structured memories as a system-reminder |
| `session-end-doc-sync.cjs` | SessionEnd | Non-blocking doc-drift check (legacy/duplicate/misplaced docs only) when a session closes |
| `secret-scanner.cjs` | Pre-Write/Edit/MultiEdit/NotebookEdit | Block secrets from being written |
| `guardrail.cjs` | Pre-Bash/PowerShell | Block/nudge/confirm destructive commands via `guardrail-rules.yaml`; logs each **hit** (block/nudge/confirm — not allows) to `guardrail-events.jsonl` for the hit counter (`npm run guardrail:stats`) |
| `commit-guard.cjs` | Pre-Bash/PowerShell | Block inline `git commit -m/-am` so every commit routes through `commit.js` for consistent trailer + message sanitization |
| `pre-compaction-archive.cjs` | Pre-Compact | Snapshot state + daily log before compaction |
| `post-read-scrubber.cjs` | Post-Read, Post-Bash/PowerShell | Scan tool output for secrets; redact from shell output and WARN on Read (Read redaction is forward-compat — Claude Code does not yet honor `updatedToolOutput` for Read) |
| `skill-usage-logger.cjs` | Post-Read, Post-Agent/Task | Log skill-frontmatter auto-loads on agent dispatch and on-demand skill-file reads to telemetry |
| `organize.cjs` | Post-ExitPlanMode, Post-Bash/PowerShell | Organize plans + screenshots into dated folders |
| `damage-control.cjs` | Post-Bash/PowerShell | Error analysis on failures — prevents retry spin loops |
| `command-usage-logger.cjs` | Post-Skill, Post-Bash/PowerShell | Log command invocations + gate runs to telemetry |
| `memory-guard.cjs` | Post-Write | Warn when a memory category nears its limit |
| `memory-capture.cjs` | Stop, Post-Bash/PowerShell | Daily-log capture + curate (strict); commit context on shell commands |
| `edit-capture.cjs` | Post-Edit | Capture edits to canonical docs as daily-log entries (strict) |
| `path-guardrail.cjs` | Pre-Write/Edit/MultiEdit/NotebookEdit | Enforce the four-tier path schema + freeze-state checks |
| `worktree.cjs` | WorktreeCreate, WorktreeRemove | Create each Claude worktree under `<parent of repo>/.worktrees/<repo>/<branch>` (override `AGENTS_WORKTREE_ROOT`), copy Git-ignored `.worktreeinclude` matches, remove without force |

Secret hooks share `secret-patterns.cjs`. The scanner fires on two paths: (1) the Claude Code `PreToolUse:Write/Edit` hook (blocks Claude writing a secret), and (2) **`commit.js` runs `secret-scanner.cjs --git-precommit` over the staged set before every commit** — this is the project's pre-commit gate, living in our own commit flow rather than a fossil-prone `.git/hooks/pre-commit` (the old `.githooks/` fallback stays retired). Bypass the commit scan only with `--no-scan` / `CLAUDE_COMMIT_NO_SCAN=1`. **Gap that remains:** a raw `git commit` typed in a plain terminal (not via `commit.js`) still gets no scan — use `commit.js`. **`docs/.output/` is deliberately NOT on the scanner skip-list** (its generated reviews/digests quote config — the likeliest place to echo a real secret; a `/review:security` report leaked a live key there once), and `/review:security` now redacts secrets in its reports so a finding stays safe to commit.

## Key File Paths

Authored implementations live in `.agents/core/`; execute through the active native `.claude/core/` or `.codex/core/` entry point. Important helpers: `gate.js` (build/test gate, auto-detect) · `constants.js` (system constants, phase artifacts, doc chain, `MEMORY_DECAY`) · `daily-log.js` · `memory-manager.js` (CRUD + search + decay + lint, JSON + SQLite FTS5) · `memory-extractor.js` (manual/brownfield only) · `memory-curator.js` (Sonnet dedup, strict) · `memory-promoter.js` · `gen-timeline.js` · `telemetry-log.js` (self-instrument user-typed commands) · `feedback-digest.js` (`/review:feedback` rollup, headless) · `_lib/doc-drift.js` (`isRealDoc()` + `gradeDoc()`/`grade` CLI deterministic PRD quality gate + legacy/dup planning-doc detection) · `skill-conformance.js` · `skill-eval.js` (differential eval math) · `skill-evolution.js` (`/review:evolve-skills` intake) · `council.js` (council aggregation) · `metrics.js` · `template-updater.js` (zone-aware sync) · `guardrail-stats.js` (guardrail hit-counter reporter — reads `guardrail-events.jsonl`) · `status.js` · `scaffold.js` (seeds from `SKILL_TEMPLATE_MANIFEST`) · `branch-audit.js` (`npm run branch:audit` — read-only safe-to-prune audit of local branches + worktrees; never deletes) · `adr-lint.js` (`npm run adr:lint` — ADR registry consistency linter over `docs/architecture/decisions/`; exit 1 on ERROR) · `path-drift-lint.js` (`npm run path:lint` — writer/reader path-drift lint: legacy `.output` tokens, flat-handoff literals, unknown compartments vs `OUTPUT_PATHS`; wired into `/review:check-templates`; `path-lint:keep` marks intentional legacy examples) · `memory-backup.js` (`npm run memory:backup` — mirrors the memory store to an out-of-repo sibling, with db integrity check + dated snapshots) · `_lib/hook-telemetry.js` (`emitHookEvent` timing + `emitGuardrailHit` hit counter).

`.agents/`: canonical `config/version.json` · `roles/*.md` (11 roles) · `skills/` (49 workflow entry points and 23 knowledge skills) · `core/`, `hooks/`, `templates/` · `adapters/{claude,codex}/` (runtime metadata/protocol) · `render-state.json` (source/native ownership ledger). Native `.claude/` and `.codex/` roles/hooks/helpers are generated delivery; `.claude/version.json` is rendered compatibility metadata. `runtime-context.js`, `_lib/project-root.js` and `_lib/memory-paths.js` distinguish installed assets, active source and ignored shared state.

`docs/reference/agents/`: the toolkit's reference home (reaches a project only through the publish artifact; install and update do not deliver it) — `system-map.md` (system inventory + workflow graphs) · `customization.md` (zone map) · `commands.md` · `getting-started.md` · `concepts/` · `guides/` · `README.md` (mirror of `docs/README.md`, relative links rewritten) + `LICENSE` (mirror of root LICENSE); edit their originals and refresh the copies. `migration-v6.md` explains canonical/native changes and local prepared-release distribution. Namespaced under `agents/` so it never collides with a project's own reference docs (`onboarding.md`, `glossary.md`, `links.md`) at `docs/reference/` root. `docs/engineering/conventions.md`: durable rules for contributors (moved from `reference/` in the domain-taxonomy migration).

## Build & Test

**The toolkit has zero runtime dependencies** — `git clone` and the hooks work immediately. `npm install` pulls only devDeps (vitest), needed solely to run the test suite. (The guardrail rule-file validator is hand-rolled — `zod` was dropped so non-Node adopters stay drop-in.)

**Memory FTS5 search is also zero-dependency on Node 24+** — runs on built-in `node:sqlite` (ships FTS5 as of Node 24 stable). `better-sqlite3` is an **optional** fallback for Node < 24; without either, search degrades to a JSON linear scan. No mandatory `npm install` for memory search.

Vitest is configured at the repo root. Shared tests colocate under `.agents/core/__tests__/`, `.agents/core/_lib/__tests__/` and `.agents/hooks/__tests__/`; runtime-specific suites colocate under `.agents/adapters/{claude,codex}/**/__tests__/`. Workshop delivery tests stay under `tools/__tests__/`.

- `npm test` — run all suites · `npm run test:watch` — watch · `npm run test:coverage` — v8 coverage (→ `docs/.output/.state/telemetry/coverage/`)

In Domdhi.Agents, `node .claude/core/gate.js test` (Claude) or `node .codex/core/gate.js test` (Codex) runs the toolkit build and Vitest suite. Toolkit tests stay here; adopter Build/Test/PR gates remain application-only. Coverage measures the canonical `.agents/**/*.{js,cjs,mjs}` source, not the generated wrappers, at 70% lines, functions and statements and 60% branches; `.agents/core/*.js`, `.agents/core/_lib/**`, `.agents/hooks/**` and `.agents/adapters/**` must each meet that floor on their own. Test dirs (`__tests__/`, `_helpers/`) are excluded from `template-updater.js` propagation. After `/review:specialize`, this section should also describe the project's actual build/test commands.
