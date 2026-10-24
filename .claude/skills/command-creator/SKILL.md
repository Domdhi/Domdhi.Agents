---
name: command-creator
description: "Use WHEN creating a shared workflow in .agents/skills/ — provides this toolkit's command template, namespacing, gate/commit/telemetry house-style, obligation language, and the command-vs-inline decision rule. Triggers: create command, new command, slash command, command frontmatter, command gate, command commit"
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [meta, system, command, template, orchestration]
user-invocable: false
allowed-tools: Read Write Edit Grep Glob
---

<!-- Generated from .agents/skills/command-creator/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Command Creator

Template, decision gates, and quality criteria for creating a shared workflow (`.agents/skills/{native-skill-name}/references/workflow.md`) that follows this toolkit's conventions. A command owns **orchestration** — gates, delegation, validation, commit logic — and never inlines skill domain knowledge. See the three-tier architecture + "no duplication between layers" rule in CLAUDE.md; for agents use `agent-creator`, for skills use `skill-creator` + `skill-authoring`.

**Namespacing:** a command's slash name comes from its path. `commands/create/project-brief.md` → `/create:project-brief`; `commands/review/code-review.md` → `/review:code-review`; a top-level `commands/sweep.md` → `/sweep`. Put setup commands in `create/`, periodic/maintenance commands in `review/`, daily build-loop commands at the top level.

## Command Template

### Decision Gate: Command or Inline Behavior?

Apply the **three-test rule** before writing any command:
1. Is this **invoked by a user** (not triggered automatically)?
2. Is it **reusable across projects** (not project-specific)?
3. Does it produce a **tangible artifact or state change** that needs human initiation?

All three yes → command. Any no → inline behavior in an agent prompt or a hook.

### Design Approach: Report-First

Write the **Report section first**, then build the Workflow that produces it. A command without a Report section has no finish line — "done" becomes ambiguous. Knowing what success looks like shapes every step.

### Obligation Language

Non-trivial steps MUST use obligation language — "MUST", "BEFORE", "NEVER" — not "should" or "consider." Claude skips soft suggestions under pressure. Hard obligations hold.

Every step that can fail needs an **explicit failure path**: how many retries, what gets surfaced, when to stop. A command without failure handling is abandoned at the first obstacle.

Use **Iron Law gates** at stage transitions where skipping would invalidate all downstream work.

Use **consequence framing** on critical steps: "Skipping this step means [specific bad outcome]." This is more effective than "this step is important."

### Pressure Test

Before finishing a command, ask: **"Would this hold under production pressure?"** If a step can be rationalized away in 3 seconds, it needs an Iron Law gate. If it can't be rationalized away, it's already clear enough.

### Calibration

Before writing a new command, read existing commands as calibration:
- **Complex pipeline commands**: read `do.md` — size-aware delegation, multi-step verification, failure handling
- **Simple utility commands**: read `review/organize.md` — minimal steps, clear output
- **Always Glob first**: `Glob .agents/skills/*/references/workflow.md` and inspect `.agents/adapters/workflows.json` — never duplicate an existing command

Know when to break the template. Complex commands need inline pipeline stages with explicit failure paths. Simple commands need a checklist output pattern. Fit the format to the work.

### Parallel Agent Delegation

When a command runs multiple agents in parallel, the Task calls MUST be shown in a single message block — not sequenced across separate steps.

### Telemetry First Line

A user-typed command does not fire `PostToolUse:Skill`, so it must self-log its invocation as the **first** workflow step (best-effort — continue on failure):

```bash
node .claude/core/telemetry-log.js {command-name}
```

### Frontmatter

Keep this raw YAML string in `.agents/adapters/claude/workflow-metadata.json` keyed by the native skill name. Register the corresponding `.claude/commands/` output path in `.agents/adapters/workflows.json`. Author the body separately in `references/workflow.md`, and copy the small `SKILL.md` selector structure from an existing workflow such as `do`. Render with `node .claude/core/render-shared-agents.js`; never author generated command files directly.

```yaml
---
description: {1 sentence — what the command does}
argument-hint: [{argument description}]
---
```

### Body Structure

```markdown
# {Command Title}

{1-2 sentences: what this command does and when to use it.}

## Variables

VARIABLE_NAME: $ARGUMENTS

- `VARIABLE_NAME` (required|optional): {description}

## Workflow

### Step 1: {Name}

{Detailed instructions. Commands should be explicit about:}
- What to read
- What agent to delegate to (if any)
- What gates/checks to run
- What output to produce

### Step N: Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`.

### Step N+1: Report

{Structured output showing what was created/modified.}

## Anti-Patterns

- {What NOT to do — 3-5 bullets}
```

### Command Conventions

| Convention | Rule |
|-----------|------|
| Location | `.agents/skills/{native-skill-name}/references/workflow.md`; native command path is adapter metadata |
| Gates | Check prerequisites exist before proceeding (use `constants.js` for paths) |
| Delegation | Spawn agents via `Task(agent-name, ...)` — never inline agent work |
| Commit | Stage specific files, commit per the Post-Command Commit Convention in `.agents/startup-reference.md`, include hash in report |
| Read-only commands | review commands that don't modify files should NOT have a commit step |
| `$ARGUMENTS` | Always captured in a named variable at the top of the workflow |
| Run-stamp | Fresh-each-run output files carry a `{YYMMDD-HHMM}` prefix, computed once per run (see the Run-Stamp Convention in `.agents/startup-reference.md`) |

### Commands That Commit vs Read-Only

- **Commits**: All `/create:*`, `/brainstorm`, `/research`, `/review:optimize-*`, `/review:specialize`, `/retro`, `/review:changelog`, `/review:update-docs`, `/review:qa`
- **Read-only**: `/prime`, `/review:check-readiness`, `/review:check-sync`, `/review:code-review`, `/review:memory-health`, `/todo`, `/review:organize`, `/review:status`
- **Own commit logic**: `/do`, `/run-todo`

## Don't Duplicate Claude Code Platform Primitives

Before designing a command, check whether Claude Code already provides the verb. The platform's surface grew significantly in 2.1.x — what felt like a gap a few months ago may now be covered.

- **Scheduling/recurrence**: use `/loop {interval} /<command>`. Don't build bespoke timers, cron, or hook re-trigger loops. Layer custom logic INSIDE the wrapped command, not around the scheduling.
- **Project state cleanup**: Anthropic owns `claude project purge [path]`. When designing a `/sunset` or any cleanup command, scope it to PRODUCT-level deprecation rituals (CHANGELOG, migration guide, archival commit) — not Claude Code state.

Ask "is the verb already in Claude Code?" before authoring. If yes, your command layers on top, not parallel to.

## Parser Patterns

When a command or library parses markdown structures (bullet lists, headings, fence blocks, key:value labels), the regex patterns must tolerate variable indentation:

- **Use `\s*` (zero-or-more) for leading whitespace, not `\s+` (one-or-more)** — unless indentation is structurally significant. Markdown authors and dispatched agents both produce mixed indentation; `\s+` silently misses zero-indent occurrences with no error, so the parser returns clean-looking empty results when it should be matching.
- **Verify the source-of-truth template emits the structure your parser keys off** — if a parser reads `**Files:**` blocks under stories, the skill template that generates the markdown MUST include those blocks. A parser dispatched without this verification step ships correct against fixtures and useless against real artifacts. (See `epic-overlap.js` + the `project-planning` backlog/story template in `references/backlog.md` for a worked example.)

Both rules apply at *dispatch time* — a parser-implementing story's prompt should explicitly require both checks.

## Wiring Checklist (New Command)

After creating the command, verify the wiring:
- [ ] Canonical workflow body and selector under `.agents/skills/{native-skill-name}/`
- [ ] Native command mapping and Claude frontmatter registered in adapters
- [ ] Rendered outputs checked with `node .claude/core/render-shared-agents.js --check`
- [ ] Frontmatter has `description` and `argument-hint`
- [ ] Telemetry self-log is the first workflow step
- [ ] Gates check prerequisites before proceeding
- [ ] Agents delegated to actually exist
- [ ] Commit step follows the Post-Command Commit Convention in `.agents/startup-reference.md` (if not read-only)
- [ ] Report section shows structured output

## Related Skills

- **`agent-creator`** — the analog for creating subagents that commands delegate to
- **`skill-creator`** + **`skill-authoring`** — for the domain knowledge a command references (never inlines)
