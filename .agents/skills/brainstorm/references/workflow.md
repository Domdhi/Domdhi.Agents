# Brainstorm

Facilitate a structured brainstorming session. Output is **context-bundled** — if brainstorming a specific feature/module, output goes to `docs/modules/{feature}/brainstorm.md`. If project-wide, output goes to `docs/.output/findings/research/{YYMMDD-HHMM}-brainstorm-{slug}.md`. Also captures ideas into `docs/work/todo/feature-ideas.md` (living backlog).

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js brainstorm
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle mode detection and user interviews. The `product-strategist` agent handles idea generation and analysis. Do NOT write the brainstorm document inline — delegate via Task tool. You DO handle the feature-ideas capture step (lightweight append, not heavy generation).

**Agent**: `product-strategist` (via Task tool with `subagent_type: "product-strategist"`)

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Detect Mode (main agent)

- If project has existing `docs/product/brainstorm.md` → ask: **update** existing or **start fresh**?
- If INPUT provided → use as problem statement seed, go to Context Gathering
- If no INPUT → start with Interview

### 2. Interview (main agent — if no INPUT or new project)

Ask the user three short rounds of **free-form** questions. These expect paragraph answers — do NOT use `AskUserQuestion`, which is reserved for closed-choice questions with finite options. Use plain conversational prompts and read the user's prose responses.

**Round 1: Problem Discovery** *(free-form)*
- "What problem are you trying to solve? (1-2 sentences)"
- "Who experiences this problem? (specific roles or user types)"

**Round 2: Context** *(free-form)*
- "What solutions exist today? What's wrong with them?"
- "What does success look like?"

**Round 3: Constraints** *(free-form)*
- "Any hard constraints? (timeline, budget, tech, regulatory)"
- "What's the simplest version that would still be valuable?"

### 3. Determine Output Path (main agent)

Determine where to write the brainstorm based on context:

```
IF brainstorming a specific feature/module that has docs/modules/{name}/:
  OUTPUT_PATH = docs/modules/{name}/brainstorm.md
ELIF brainstorming a specific feature/module (new):
  mkdir -p docs/modules/{name}/
  OUTPUT_PATH = docs/modules/{name}/brainstorm.md
ELSE (project-wide or general):
  OUTPUT_PATH = docs/.output/findings/research/{YYMMDD-HHMM}-brainstorm-{slug}.md
```

If unclear whether it's feature-scoped or project-wide, ask with AskUserQuestion.

### 4. Context Gathering (main agent)

- If existing code/docs: Read README, package.json, project files for context
- If INPUT references a domain: Use WebSearch to gather relevant context
- Synthesize all gathered context into a research brief

### 5. Delegate to Agent

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow (such as `telemetry-log.js`) as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow has no build or test gate; in an adopter any later gate is the application's own and never the Domdhi.Agents toolkit suite. Its evidence is the written `{OUTPUT_PATH}` document, the updated `feature-ideas.md` and the hash of a commit that stages only the files this command wrote; discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran.

Use the Task tool with `subagent_type: "product-strategist"` to generate the brainstorm analysis.

**Task prompt must include**:
1. Problem statement and where to write output (`{OUTPUT_PATH}`)
2. User's interview answers (problem, constraints, success criteria)
3. Context gathered from codebase or web research
4. The `product-strategist` agent auto-loads the `project-planning` skill via frontmatter.
5. Instruction to: frame the problem, explore 3-5 solution directions, evaluate each on Feasibility/Impact/Effort/Risk, create evaluation matrix, recommend a direction

### 6. Capture Ideas to Feature Backlog (main agent)

After the brainstorm agent completes, read the output and capture ideas into `docs/work/todo/feature-ideas.md`:

1. **If `feature-ideas.md` doesn't exist or contains only template placeholders** → create it from the template structure (see `.claude/skills/project-planning/assets/feature-ideas.md`)
2. **If it already has content** → append new ideas (don't overwrite existing ones)

For each idea explored:
- **Categorize** by the solution domain
- **Set priority** based on evaluation matrix scores
- **Set status** to "Idea"
- **Set source** to "brainstorm"

Also add raw ideas from the interview to the **Parking Lot** section.

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command and commit with a descriptive message.

### 8. Report (main agent)

```markdown
## Brainstorm Complete

**Output**: {OUTPUT_PATH}
**Feature ideas captured**: docs/work/todo/feature-ideas.md ({count} ideas)
**Ideas explored**: {count}
**Recommended direction**: {name}

**Committed**: {hash} — `docs: /brainstorm — {summary}`
**Next step**: Run `/create:project-brief` to capture the strategic vision, or `/research` to validate assumptions.
```
