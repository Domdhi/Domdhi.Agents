# Workflow Reference

All 49 workflows below are registered in [.agents/adapters/workflows.json](../../../.agents/adapters/workflows.json). Claude exposes generated slash commands; Codex uses installed canonical skills with hyphenated names. Read the installed selector and authored body before execution. This index preserves the main purposes, gate/commit contracts and routes into the full procedures; those procedures own detailed dispatch prompts and report templates.

## Pick a workflow

| Intent | Claude | Codex |
| --- | --- | --- |
| Choose the scope of a request | `/route` | `$route` |
| Prepare application planning | `/create:new-project` | `$create-new-project` |
| Adopt an existing application | `/onboard` | `$onboard` |
| Prepare an execution checklist | `/todo` | `$todo` |
| Execute one task / a full checklist | `/do` / `/run-todo` | `$do` / `$run-todo` |
| Diagnose a failure | `/investigate` | `$investigate` |
| Review / maintain delivered work | `/review:code-review` / `/sweep` | `$review-code-review` / `$sweep` |
| Inspect progress / save continuity | `/review:status` / `/end` | `$review-status` / `$end` |
| Gather and prioritize new signals | `/listen` / `/triage` | `$listen` / `$triage` |
| Begin the next completed cycle | `/evolve` | `$evolve` |

`/status` and `/organize` are old names; the registered commands are `/review:status` and `/review:organize`. Newly installed Codex skills require actual native discovery; refresh the session when its inventory is stale. Availability and a file read do not prove a workflow ran.

## Complete inventory

Each authored-body link opens the procedure, including supported arguments, outputs and acceptance gates.

| Claude command | Codex skill | Purpose | Procedure |
| --- | --- | --- | --- |
| `/brainstorm` | `$brainstorm` | Explore a problem; write module brainstorm or general research plus idea inbox. | [Read](../../../.agents/skills/brainstorm/references/workflow.md) |
| `/create:component` | `$create-component` | Create canonical role, workflow or knowledge skill and wire/render it. | [Read](../../../.agents/skills/create-component/references/workflow.md) |
| `/create:module` | `$create-module` | Plan one module under docs/modules and generate its implementation TODO. | [Read](../../../.agents/skills/create-module/references/workflow.md) |
| `/create:new-project` | `$create-new-project` | Interview, scaffold missing docs, run planning chain, specialize and write context. | [Read](../../../.agents/skills/create-new-project/references/workflow.md) |
| `/create:project-architecture` | `$create-project-architecture` | Write architecture/overview.md and architecture decisions from the PRD. | [Read](../../../.agents/skills/create-project-architecture/references/workflow.md) |
| `/create:project-brief` | `$create-project-brief` | Write product/brief.md from verified product context. | [Read](../../../.agents/skills/create-project-brief/references/workflow.md) |
| `/create:project-design` | `$create-project-design` | Write a scoped UX spec with selected tools, editable artifacts and inspection evidence. | [Read](../../../.agents/skills/create-project-design/references/workflow.md) |
| `/create:project-epics-todo` | `$create-project-epics-todo` | Write per-epic story/AC checklists under docs/work/todo/. | [Read](../../../.agents/skills/create-project-epics-todo/references/workflow.md) |
| `/create:project-epics` | `$create-project-epics` | Turn PRD/architecture into docs/work/backlog.md. | [Read](../../../.agents/skills/create-project-epics/references/workflow.md) |
| `/create:project-requirements` | `$create-project-requirements` | Write product/requirements.md from real planning inputs. | [Read](../../../.agents/skills/create-project-requirements/references/workflow.md) |
| `/create:project-todo` | `$create-project-todo` | Write the master project phase/epic index from the backlog. | [Read](../../../.agents/skills/create-project-todo/references/workflow.md) |
| `/do` | `$do` | Plan, implement, verify AC and commit one story or task. | [Read](../../../.agents/skills/do/references/workflow.md) |
| `/end` | `$end` | Write the resolver-selected session handoff and commit continuity. | [Read](../../../.agents/skills/end/references/workflow.md) |
| `/evolve` | `$evolve` | Archive the completed cycle and replan from production evidence. | [Read](../../../.agents/skills/evolve/references/workflow.md) |
| `/interview` | `$interview` | Gather preferences/decisions and persist the decision summary. | [Read](../../../.agents/skills/interview/references/workflow.md) |
| `/investigate` | `$investigate` | Find root cause, resolve the confirmed defect and verify; no automatic commit. | [Read](../../../.agents/skills/investigate/references/workflow.md) |
| `/intake` | `$intake` | Capture selected toolkit lessons locally; inspect or explicitly deliver retained requests to the configured GitHub receiver. Unrelated to `/listen`'s signal intake. | [Read](../../../.agents/skills/intake/references/workflow.md) |
| `/listen` | `$listen` | Gather production signals into a dated signal-intake file under `evolution/intake/` (not `/intake`); triage separately. | [Read](../../../.agents/skills/listen/references/workflow.md) |
| `/onboard` | `$onboard` | Derive architecture/context from existing application code, then specialize. | [Read](../../../.agents/skills/onboard/references/workflow.md) |
| `/prime` | `$prime` | Load task-relevant handoff/Git/context and observed memory; report readiness. | [Read](../../../.agents/skills/prime/references/workflow.md) |
| `/remember` | `$remember` | Append a conversational insight to the daily log; no commit. | [Read](../../../.agents/skills/remember/references/workflow.md) |
| `/research` | `$research` | Validate assumptions; write module research or general research findings. | [Read](../../../.agents/skills/research/references/workflow.md) |
| `/retro` | `$retro` | Review an epic then record lessons; sweep --skip-review reuses existing findings. | [Read](../../../.agents/skills/retro/references/workflow.md) |
| `/review:changelog` | `$review-changelog` | Write release notes from completed stories, history and timeline. | [Read](../../../.agents/skills/review-changelog/references/workflow.md) |
| `/review:check-readiness` | `$review-check-readiness` | Check real planning documents and unresolved epic overlaps before implementation. | [Read](../../../.agents/skills/review-check-readiness/references/workflow.md) |
| `/review:check-sync` | `$review-check-sync` | Diagnose planning/documentation drift and persist a fix-ready report. | [Read](../../../.agents/skills/review-check-sync/references/workflow.md) |
| `/review:check-templates` | `$review-check-templates` | Audit source/native wiring, skill resolution and toolkit integrity; write report. | [Read](../../../.agents/skills/review-check-templates/references/workflow.md) |
| `/review:code-review` | `$review-code-review` | Risk-route a code review and persist findings; source is read-only. | [Read](../../../.agents/skills/review-code-review/references/workflow.md) |
| `/review:evolve-skills` | `$review-evolve-skills` | Mine demonstrated gaps, evaluate skill proposals and apply according to selected flags. | [Read](../../../.agents/skills/review-evolve-skills/references/workflow.md) |
| `/review:feedback` | `$review-feedback` | Capture telemetry plus agent feedback for toolkit maintainers. | [Read](../../../.agents/skills/review-feedback/references/workflow.md) |
| `/review:memory-defrag` | `$review-memory-defrag` | Propose and apply accepted overlap merge/split/cross-reference changes. | [Read](../../../.agents/skills/review-memory-defrag/references/workflow.md) |
| `/review:memory-health` | `$review-memory-health` | Run the requested health pipeline, lint/decay and diagnostic report; runtime inference limits apply. | [Read](../../../.agents/skills/review-memory-health/references/workflow.md) |
| `/review:optimize-agents` | `$review-optimize-agents` | Compare roles/skills/context with source; apply only in the selected fix mode. | [Read](../../../.agents/skills/review-optimize-agents/references/workflow.md) |
| `/review:optimize-backlog` | `$review-optimize-backlog` | Analyze dependencies, critical path and parallelism; apply agreed plan corrections. | [Read](../../../.agents/skills/review-optimize-backlog/references/workflow.md) |
| `/review:organize` | `$review-organize` | Organize loose plans/screenshots through the existing hook helper. | [Read](../../../.agents/skills/review-organize/references/workflow.md) |
| `/review:personalize` | `$review-personalize` | Write canonical role names/personas/soul; render native roles and commit. | [Read](../../../.agents/skills/review-personalize/references/workflow.md) |
| `/review:promote-memories` | `$review-promote-memories` | Rank memory promotion candidates; apply accepted durable guidance changes. | [Read](../../../.agents/skills/review-promote-memories/references/workflow.md) |
| `/review:qa` | `$review-qa` | Generate meaningful automated tests from existing code/AC and verify. | [Read](../../../.agents/skills/review-qa/references/workflow.md) |
| `/review:security` | `$review-security` | Audit threat surface and write a redacted security report. | [Read](../../../.agents/skills/review-security/references/workflow.md) |
| `/review:specialize` | `$review-specialize` | Use filled planning docs to tailor canonical roles, skills, risk map and memory. | [Read](../../../.agents/skills/review-specialize/SKILL.md) |
| `/review:status` | `$review-status` | Read TODO status; generate status/decision dashboards or text-only output. | [Read](../../../.agents/skills/review-status/references/workflow.md) |
| `/review:timeline` | `$review-timeline` | Generate/update docs/work/timeline.md from Git history. | [Read](../../../.agents/skills/review-timeline/references/workflow.md) |
| `/review:update-docs` | `$review-update-docs` | Reconcile living documentation with implementation and sync findings. | [Read](../../../.agents/skills/review-update-docs/references/workflow.md) |
| `/route` | `$route` | Assess request scope and recommend the appropriate pipeline depth. | [Read](../../../.agents/skills/route/references/workflow.md) |
| `/run-tests` | `$run-tests` | Execute manual/E2E checklists; persist results/screenshots and handoff; supports canary checks. | [Read](../../../.agents/skills/run-tests/references/workflow.md) |
| `/run-todo` | `$run-todo` | Execute all TODO stories in ownership-safe waves with AC/review/commit gates. | [Read](../../../.agents/skills/run-todo/references/workflow.md) |
| `/sweep` | `$sweep` | Review, retro/sync, resolve findings, promote, align, defrag, audit and refresh timeline. | [Read](../../../.agents/skills/sweep/references/workflow.md) |
| `/todo` | `$todo` | Research and write an execution-ready TODO with AC, files, dependencies and waves. | [Read](../../../.agents/skills/todo/references/workflow.md) |
| `/triage` | `$triage` | Drain intake/idea inbox into ranked backlog and durable decisions. | [Read](../../../.agents/skills/triage/references/workflow.md) |

## Planning gates and outputs

A first-line `<!-- @@template -->` is an unfilled scaffold, not a prerequisite. A failed gate means create/fill the missing prerequisite and resume. `--yolo` is an explicit user override; routing never bypasses gates.

| Workflow | Real prerequisite | Main output |
| --- | --- | --- |
| create-project-brief | Verified product context/input | `docs/product/brief.md` |
| create-project-requirements | Brief, brainstorm or research | `docs/product/requirements.md` |
| create-project-architecture | PRD | `docs/architecture/overview.md` |
| create-project-design | PRD | `docs/design/spec.md` plus selected artifacts |
| create-project-epics | PRD and architecture | `docs/work/backlog.md` |
| create-project-todo | Backlog | Master `docs/TODO_{Project}.md` |
| create-project-epics-todo | Backlog | `docs/work/todo/TODO_epicNN_{slug}.md` |
| review-check-readiness | Required planning docs; no unacknowledged overlaps | Readiness report |
| review-specialize | Filled planning prerequisites in its selected scope | Canonical roles/context/skills and native projections |

Backlog defines work; TODO checklists track completion. Module work is context-bundled under `docs/modules/{name}/`. General brainstorm/research findings use stamped `.output/findings/research/` paths; don't treat every brainstorm as a root product doc. Toolkit architecture/PRD absence is valid when check-sync has nothing to compare; it skips those domain checks rather than inventing scaffolds.

## Execution and verification

`do` persists its plan before implementation, designs necessary tests from AC, verifies behavior and performs risk-routed review before commit. `run-todo` persists the full ownership/dependency wave plan, updates it at each checkpoint, verifies every AC and records the wave ship token before its commit. Three-or-more-wave epics include the middle-wave checkpoint and final cross-wave review. Independent review checks evidence; passing tests alone do not satisfy AC.

The [verification skill](../../../.agents/skills/verification-before-completion/SKILL.md) owns the `SHIP_CHECK_OK` and audited `SHIP_CHECK_SKIP: reason` contract. No stale result or agent report substitutes for the current gate/AC evidence.

```sh
# Codex; use .claude/core/ in Claude with the same arguments.
node .codex/core/gate.js build
node .codex/core/gate.js test
```

Toolkit tests run only in Domdhi.Agents. An adopter gate runs the application's build/test/lint/security commands, including after agent-file changes. E2E/manual/post-deploy checks follow the relevant workflow and actual configured runner; an absent runner is an explicit skip, not execution proof. `run-tests --baseline` / `--compare` supports post-deploy canary comparisons through its existing procedure.

## Review and maintenance

Code/security reviewers diagnose and write findings; they do not edit application source. Sync diagnoses drift, while update-docs reconciles it. Read-only means no source rewrite; reports and configured commit steps still apply. Each procedure's commit section is authoritative—do not assume all `/review:*` workflows have identical behavior.

`sweep` chains review → retro/sync → root-owned fixes → promotion/alignment → skill evaluation → memory defrag/health/integrity → timeline. It resolves in-scope actionable findings and verifies them before phase commits. Its `--gated`/skip flags are documented in the authored procedure. Standalone retro resolves its actionable findings; `retro --skip-review` under sweep remains diagnostic so Phase 3 owns the fix loop.

`review-evolve-skills` starts from demonstrated gaps and differential evidence; proposing a skill is not permission to claim it improved behavior. `review-memory-defrag` is the heavier periodic overlap pass; ordinary strict-profile curation is a separate Claude path. Codex optional memory inference is unavailable—see [memory](concepts/memory.md) and [hooks](concepts/hooks.md).

## Source ownership and commits

Create/personalize/specialize edit `.agents/roles/`, canonical skills/workflows and appropriate adapters, then render native delivery. Shared commands remain callable through compatible Claude paths. Native runtime overrides are project-owned; preserve [customization zones](customization.md).

The selected lifecycle workflow decides when to commit. Common examples: do and run-todo commit verified work; todo commits its planning artifacts; run-tests commits test evidence/handoff; end commits continuity. Prime, route and remember do not commit, and investigate fixes/verifies without an automatic commit. Memory-health has its explicit no-commit exception. Read each procedure for conditional dry-run/fix/accept behavior.

Use explicit owned staging and native `commit.js`; do not stage all files in a shared tree. The helper scans staged content and the message for secrets, through the managed git hooks when they are active (a plain terminal `git commit` runs them too, and a push scans every commit it would publish) and itself otherwise. No workflow's local commit implies permission for push, deployment, publication or fleet rollout.

## Runtime and continuity

Claude model floors/escalation come from its adapter and routing policy. Codex uses configured native models/tools; it does not accept Claude model identifiers as substitutes. Named-role availability and worker-applied role guidance are distinct evidence. Hooks require native trust; parity/discovery cannot prove model-visible enforcement.

`prime` loads task-relevant gaps and only memory actually observed/read. `end`, do, run-todo, todo and run-tests use [session-handoff](../../../.agents/skills/session-handoff/SKILL.md) and the resolver; avoid inventing a flat handoff path. Tracked findings/plans/handoffs and curated memory hold durable evidence. Ignored `.output/.state/` is transient working/index/log space.

See [system map](system-map.md), [concepts](concepts/commands.md), [contributing](guides/contributing.md) and [migration v6](migration-v6.md). The reference bundle reaches projects through the workshop/publish artifact; install/update do not copy it.
