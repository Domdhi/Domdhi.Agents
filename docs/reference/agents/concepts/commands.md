# Commands and Workflows

A workflow selects a procedure: what inputs to read, which prerequisites to check, when to delegate, how to verify and what to persist/commit. Workflows are authored under `.agents/skills/`, with native names mapped by `.agents/adapters/workflows.json`. Claude slash-command files are generated; Codex invokes the discovered `$skill-name`. There are 49 workflows. The [complete reference](../commands.md) gives both native names and links every authored procedure.

## Working routes

| Stage | Usual route |
| --- | --- |
| New application planning | create-new-project → brief/requirements/design/architecture/epics → specialize |
| Existing application adoption | onboard → architecture/context → specialize |
| Delivery | route → todo → do or run-todo → review/retro |
| Continuity | prime when cold context is needed; resolver-based handoffs via end or delivery workflows |
| Production feedback | listen → triage → backlog/TODO → delivery |
| Cycle rollover | evolve archives the completed plan and replans from evidence |
| Maintenance | sweep chains review, sync/retro, fixes, promotion, alignment and integrity |

These routes choose depth; they do not skip prerequisites. A real planning document must exist without the unfilled template marker. Generate missing inputs and resume; only explicit user `--yolo` can override that gate.

## The orchestration spine

For delivery, the main owner gathers task context and persists a plan before implementation. Ownership/dependencies determine safe wave boundaries. Relevant roles apply domain skills; the owner independently checks all AC and current build/test evidence, resolves findings, records the ship token where required and commits owned artifacts.

`do` handles one task. `run-todo` handles all stories, checkpoints each wave, requires risk-routed reviews and includes middle/final cross-wave checks where applicable. `run-tests` executes manual/E2E checks and persists results. Their full thresholds, flags and templates live in the authored procedures, not duplicated here.

Adopter gates check the application, even after agent-file changes. Toolkit tests belong only in this workshop. Runtime helper examples translate `.claude/core/` to `.codex/core/` in Codex while retaining arguments and gates.

## Reports, commits and execution evidence

Read-only reviews diagnose rather than modify source, but write findings and follow their own commit steps. The selected workflow owns commit behavior; there is no universal no-commit rule for all reviews. [The reference](../commands.md#source-ownership-and-commits) summarizes the main distinctions.

Persist generated artifacts before reporting them. Plans, findings and handoffs are tracked under `.output/`; `.output/.state/` is ignored transient space. An installed/listed workflow proves availability, not execution. Completion needs that run's actual AC, gates and commit evidence.

Commands orchestrate; [roles](agents.md) supply specialized behavior; [knowledge skills](skills.md) hold shared checklists. Author each rule once and link it. See [contributing](../guides/contributing.md) for new workflow authoring and [migration v6](../migration-v6.md) for native delivery changes.
