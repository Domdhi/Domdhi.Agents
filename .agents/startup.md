# Required startup rules

These rules apply at the start of every task. Read project-owned root instructions and applicable directory instructions as well; keep their additions, local settings and role personalization intact.

## Working contract

- Build the best software possible together. Precision and details matter. Diagnose, fix, verify with the real command, and finish the authorized goal. Fix clearly worthwhile problems in the same pass; only stop for a genuine fork, an irreversible/outward action requiring authorization, or materially expanded scope.
- Read relevant files before editing or recommending changes. Separate observed evidence from assumptions. Preserve others' staged/uncommitted work and do not overwrite it to simplify a task.
- Use the current task to choose context. Read only missing instructions and task-relevant source, skill references, planning documents and handoff Key Files. A handoff is evidence of earlier intent; current files and git reality take precedence. Skip unrelated files and say why when reporting loaded context.
- On resume, keep these required rules active. Check branch/status and a relevant handoff before continuing unfinished work; use the active runtime’s `core/handoff-path.js` entry point and the native `prime` workflow when a cold-start summary is needed. Do not run the full cold-start sequence for an unrelated self-contained task.
- Startup memory is observed only when a `<project_memory>` block is actually visible. A configured hook alone is not proof of injection. State when injection was not observed. Before domain work, recall directly relevant constraints/patterns/decisions/rejected approaches using the existing memory helper; skip recall when the task supplies no useful query. Read at most three relevant, non-stale additional hits and dedupe against visible/read memory.
- Keep the existing memory engine and ranking: startup injection uses importance-adjusted decayed confidence times recency, with aged usage as a tiebreaker. Search uses its own returned relevance/rank, not an invented confidence-times-relevance sort. Subagents stage memory drafts in the inbox; only the main owner promotes/discards curated memories. Capture reusable learning after work under the invoked workflow's existing protocol.

## Native workflows and source ownership

- Invoke the requested native workflow and read its body before acting. Claude uses slash commands; Codex uses installed `$skill-name` entry points. Availability must come from native discovery; do not claim an uninstalled entry point exists or that discovery proves execution.
- Choose helper entry points by the active runtime before executing any command: Codex uses `.codex/core/{helper}.js`; Claude uses `.claude/core/{helper}.js`. Authored helpers live in `.agents/core/`. Treat `.claude/core/` examples in shared workflows, roles and references as compatibility paths: in Codex replace that prefix with `.codex/core/`, retaining arguments and gates. The Codex wrapper establishes runtime context; direct shared-helper execution must explicitly set `AGENTS_RUNTIME=codex`. Hook configuration and toolkit test locations keep their actual paths.
- Commands/entry points orchestrate; roles supply behavior; skills supply domain knowledge. Reference existing checklists instead of duplicating them across layers. Native projections are generated files: edit shared sources under `.agents/` and runtime metadata under `.agents/adapters/`; keep project-owned native settings and local overrides through the existing merge path.
- Preserve project customization through the existing update/merge path. Canonical roles retain identity/soul, Project Context and bespoke skills; shared skills retain marked project tails/inline fences; local settings stay project-owned. For additions to a template skill, use `<!-- @@project-additions -->` or paired `<!-- @@project-additions:start -->` / `<!-- @@project-additions:end -->` outside code fences. Do not put project customization into generated native projections.
- Honor the runtime's model/tool policy. For Claude role dispatch, read the role's model-routing policy before choosing overrides; never undercut its floor, and security-auditor remains pinned Opus. Codex uses its native configured role settings; do not substitute Claude model names.

## Gates, verification and commits

- Enforce the invoked workflow's prerequisite and acceptance gates. A first-line `<!-- @@template -->` marks an unfilled scaffold, not a real prerequisite document. Generate missing prerequisites and resume; never recommend bypassing a gate or a stale/stub document. `--yolo` is an explicit user override only.
- Verify the changed behavior and acceptance criteria before claiming completion. Use the project's actual build/test/coverage, isolation, integration, lint and PR preflight/security checks. Toolkit agent-system tests belong in Domdhi.Agents only: adopter Build/Test/PR gates remain application-only, including after agent-file changes. No conditional toolkit test leg in adopters.
- Gate (build/test) lock recovery is performed by the gate itself or its supported helper, never by hand-deleting the lock file. On Windows a verified owned-lease lock (recorded owner and children exited, no outstanding process-tree hazard) is recovered with the exact lock bytes and the recovery evidence preserved in worktree-local ignored state (`docs/reference/agents/gate-lock-recovery.md`). On other platforms the gate breaks an idle lock older than its stale ceiling whose recorded owner and child are gone. Age or a dead parent PID alone is not proof; live or ambiguous ownership stays held while you investigate. This covers build/test locks only, never submission or data locks, and does not resume paused builds or tests.
- Follow the selected lifecycle workflow's existing commit rules. Stage specific authored files, never `git add .` or `commit.js --all` in a shared working tree. Write the message to `docs/.output/.state/.commit-msg`, then use `node .codex/core/commit.js` in Codex or `node .claude/core/commit.js` in Claude; it normalizes the message and scans staged content without adding attribution. Do not bypass scans or weaken assertions to obtain a green check. Do not push, publish, deploy, open a PR or run fleet rollout without authorization.
- Never run `git clean -f/-fd/-fdx`, `git reset --hard`, or recursive removal of user directories without explicit permission for the named deletion. Preserve concurrent work.

## Durable output

- Persist generated agent deliverables before reporting completion. Planning documents live in their `docs/` domain; feature-specific work under `docs/modules/{feature}/`; findings, plans and handoffs under `docs/.output/`; transient working files under `docs/.output/.state/work/{date}/{task}/`. Read `docs/CLAUDE.md` when writing or navigating docs. Do not introduce legacy underscore-prefixed planning documents.
- Use one `{YYMMDD-HHMM}` stamp for all fresh-per-run output files and reuse it on resume. Honor existing exceptions for append-style day logs, predictable resume state and epic-keyed retros. Use `handoff-path.js` for session/branch handoff paths.
- Track curated `.output/.memory/` JSON sources; keep derived `.output/.state/` indexes/inbox/daily logs ignored and regenerable. Never assume ignored working files are durable deliverables.

## Read details only when triggered

Read the needed section of `.agents/startup-reference.md` only if the current task touches it; skip unrelated sections. Existing command/skill bodies and the project's own instructions take precedence for their task. Do not import the full reference at startup.

| Task trigger | Reference sections / native entry points |
|---|---|
| Choose a workflow or resume a cold session | `Commands`, `TODO Hierarchy`; native `route` or `prime` when requested/needed |
| Plan requirements, architecture, epics or implementation | `Hard Gates`, then the requested planning/implementation command or skill |
| Delegate, personalize or change a role | `Agents`, including model hierarchy/routing; canonical role and its declared skills |
| Author or split a skill/template | `Template Marker Convention`, `Skill Authoring & Spec Conformance`; existing skill-authoring/skill-creator guidance |
| Write docs, reports, handoffs or commits | `Document Naming`, `Output Persistence Convention`, `Post-Command Commit Convention`; applicable `docs/CLAUDE.md` |
| Modify memory/hook behavior or investigate startup injection | `Memory System`, `Hooks`; actual configured hook and helper source |
| Install/update, customize or publish the toolkit | `Publishing`, `Template Marker Convention`; existing install/updater/publish instructions, with outward actions authorized separately |
| Change/test Domdhi.Agents itself | `Build & Test Gate`, `Build & Test`, `Key File Paths`; toolkit tests here only |
