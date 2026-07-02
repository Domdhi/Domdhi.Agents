# Commands

A command in this system is a slash-invoked workflow — the thing you type with `/`, like `/do` or `/brainstorm`. Each one is a Markdown file in `.claude/commands/` that tells the main agent how to run a specific procedure: which gates to check, what to ask the user, whether to delegate, how to validate, and whether to commit. There are 39 of them as of today, grouped into 4 categories: Setup, Build Loop, Supporting, and Review.

Commands are the **orchestration layer** of the three-tier architecture. They don't contain domain knowledge (skills do) and they don't do the implementation work themselves when it gets large (agents do). They do own the shape of a procedure — the order of steps, where the user gets asked a question, when the gate runs, and what gets committed. If you want to think of it as a verb: commands are the verb the user types, agents are the workers a command can dispatch, and skills are the reference material both agents and the main loop already know.

## The 4 categories

### Setup (run once per project, in order)

| Command | Purpose |
|---------|---------|
| `/brainstorm` | Guided ideation session → `product/brainstorm.md` + topic satellites |
| `/research` | Validate assumptions → `product/research.md` |
| `/interview` | Interactive Q&A to gather requirements |
| `/create:project-brief` | Strategic vision → `product/brief.md` |
| `/create:project-requirements` | PRD with FRs/NFRs → `product/requirements.md` |
| `/create:project-design` | UX spec, wireframes, themes, mock → `docs/design/` |
| `/create:project-architecture` | Tech stack, ADRs → `architecture/overview.md` |
| `/create:project-epics` | Break requirements into stories → `work/backlog.md` |
| `/create:project-todo` | Master implementation index → `TODO_{ProjectName}.md` |
| `/create:project-epics-todo` | Per-epic story checklists → `todo/TODO_epic{NN}.md` |
| `/create:component` | Create a new agent, command, or skill following conventions |
| `/create:new-project` | Master orchestrator — scaffolds `docs/` and runs the full Setup pipeline → `product/context.md` |
| `/onboard` | Brownfield bootstrapper — reverse-engineers `architecture/overview.md` + `product/context.md` from existing code; merges CLAUDE.md additively; chains `/review:specialize` |

Thirteen commands. Run them in roughly that order the first time you drop this template into a repo — or run `/onboard` first if the repo already has code. The `/create:project-*` chain has hard gates — each one checks that the previous artifact exists before it runs (see "Hard gates" below).

### Build Loop (daily)

| Command | Purpose |
|---------|---------|
| `/prime` | Cold-start a session — reads the latest handoff in `docs/.output/handoffs/` + git log |
| `/todo` | Create execution-ready checklist with AC, wave plan, self-review |
| `/do` | Execute one task — size-aware (main-agent direct or Sonnet delegate), gate, AC verify, commit |
| `/run-todo` | Execute an entire checklist — wave-based parallel execution with AC gates and auto-commit |
| `/run-tests` | Manual/E2E testing with parallel playwright agents, screenshots, status protocol |
| `/end` | Save handoff context → `docs/.output/handoffs/{YYYY-MM}/{stamp}-{caller}-{branch}.md` |

Six commands, used dozens of times per session. Every session starts with `/prime` and ends with `/end`. Between them, `/do` and `/run-todo` are the workhorses.

### Supporting

| Command | Purpose |
|---------|---------|
| `/status` | Parse TODO files, show progress, generate HTML dashboard |
| `/create:module` | Add a new feature area → `docs/modules/{module}/` + TODO checklist |
| `/organize` | Move plan files to dated folders |
| `/investigate` | Structured debug investigation with root cause before fixes |
| `/remember` | Capture a conversational insight to the daily log for memory acquisition |

Five utility commands for progress-checking, module scaffolding, cleanup, debugging, and memory.

### Review (periodic)

| Command | Purpose |
|---------|---------|
| `/review:code-review` | Risk-tiered architecture compliance review (read-only) |
| `/review:security` | OWASP audit, vulnerability detection, secret scanning |
| `/review:qa` | Generate tests for existing code |
| `/review:check-readiness` | Gate check before implementation (read-only) |
| `/review:check-sync` | Detect documentation drift (read-only) |
| `/review:check-templates` | Audit `.claude/` system health — orphans, gaps, broken wiring |
| `/review:update-docs` | Fix drift found by `/review:check-sync` |
| `/review:optimize-backlog` | Dependency graph, critical path analysis |
| `/retro` | Epic retrospective + pattern extraction |
| `/review:changelog` | Release notes from stories + git |
| `/review:specialize` | Customize agents for your tech stack |
| `/review:optimize-agents` | Re-align agents with actual codebase |
| `/review:personalize` | Give agents names and personalities |
| `/review:memory-health` | Compile + lint + decay report |
| `/review:promote-memories` | Surface high-confidence concepts for promotion |
| `/review:timeline` | Generate or update weekly commit history |

Sixteen review commands. Most run periodically — after an epic, before a release, or when something feels drifted. The `/review:check-*` commands are read-only diagnostics; the rest write artifacts to `docs/.output/findings/reviews/`.

## The orchestration pattern

Every non-trivial command follows roughly the same spine: **gates → interview or prompt assembly → delegation (optional) → validation → commit.** The pattern isn't uniform — `/brainstorm` is mostly interview, `/do` is mostly delegation + validation, `/review:check-sync` is mostly validation — but the five phases are the vocabulary every command is written against.

`/do` is the clearest exemplar because it hits every phase:

1. **Gate:** check for dirty working tree and existing plan before starting.
2. **Interview / prompt assembly:** gather the story's AC, read the files about to change, write a plan file to disk so the work survives a crash.
3. **Delegation:** for large tasks (>5 files, >500 LOC, >8 AC), dispatch a Sonnet agent with a rich prompt including variable names and code snippets. For small/medium, the main agent implements directly.
4. **Validation:** run `gate.js build` + `gate.js test`, then verify every AC bullet independently (not by trusting the implementer's report).
5. **Commit:** stage only the files touched, commit with an AC-verified footer, regenerate the handoff.

`/create:project-requirements` hits the same phases but with a different emphasis: the interview dominates, delegation is minimal, and the "commit" phase also runs a post-command commit convention that applies to every `/create:*` command. `/retro` skips delegation entirely and is mostly validation + reporting.

If you write a new command, picking which of the five phases it needs is the design question.

## Hard gates and `--yolo`

Some commands refuse to run until a prerequisite artifact exists. `/create:project-architecture` requires `product/requirements.md` first. `/create:project-epics` requires both. `/create:project-design` requires `product/requirements.md`. This is deliberate — out-of-sequence execution produces garbage planning docs, so the commands enforce the dependency graph.

Every gated command accepts `--yolo` to bypass the hard gate (it downgrades to a warning). Use it when you know what you're doing — usually when you're iterating on a single phase and don't want the gate re-checking. The full list of gated commands lives in `CLAUDE.md` under "Hard Gates."

## Commit convention

Any lifecycle command that creates or modifies files commits after reporting. That's why after you run `/create:project-brief` you'll immediately see a new `docs: /create:project-brief — brief summary` commit. The convention keeps each command's output as one atomic unit in git history — easy to bisect, easy to revert.

Two commands own their own commit logic instead: `/do` and `/run-todo`. They commit per task (or per wave, for `/run-todo`), with AC counts in the commit footer. `/prime`, `/todo`, and `/organize` are chat-only — they don't commit because they don't write files.

## How to pick one

Start with intent, not inventory:

- **I want to start a new project** → `/brainstorm`, then work down the Setup list.
- **I have an existing codebase and want to bootstrap docs** → `/onboard`.
- **I'm resuming a session** → `/prime`.
- **I have a story ID and want to ship it** → `/do {story-id}`.
- **I have a whole epic ready to execute** → `/run-todo {epic-or-path}`.
- **I need to check progress** → `/status`.
- **Something's broken and I don't know why** → `/investigate`.
- **I want a second opinion on code quality** → `/review:code-review`.
- **I'm about to release** → `/review:changelog` and `/retro`.
- **The docs feel out of sync with reality** → `/review:check-sync`, then `/review:update-docs`.
- **I'm forking this template into a real project** → `/review:specialize`, optionally `/review:personalize`.

Most work is the `/prime` → `/do` → `/end` loop. The rest are for inflection points — start of project, end of epic, pre-release, drift detection.

## Commands vs agents vs skills

The three-tier architecture exists so each layer has one job and zero duplication:

- **Commands** are what the user types. They orchestrate a procedure.
- **Agents** are delegated workers a command (or the main agent) can dispatch. They execute chunks of work.
- **Skills** are the domain knowledge both layers already share — templates, quality criteria, checklists.

Commands reference skills by name, but they don't copy skill contents. Agents auto-load skills via their frontmatter, so commands don't need to tell an agent to "read the skill file first." If you're writing a new command and find yourself pasting a checklist, that checklist belongs in a skill.

---

See also: [`./agents.md`](./agents.md) for the 11-agent inventory, [`./skills.md`](./skills.md) for the skill catalog, [`./hooks.md`](./hooks.md) for the deterministic event layer, [`./memory.md`](./memory.md) for the auto-compound pipeline.
