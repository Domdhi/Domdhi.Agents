---
description: Create a new agent, command, or skill following established conventions
argument-hint: [agent|command|skill] [name] [description]
---

<!-- Generated from .agents/skills/create-component/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Create Component

Create a new agent, command, or skill in the shared toolkit. Roles, workflows and knowledge skills are authored in `.agents/` and rendered for Claude and Codex. Ensures proper structure, frontmatter, wiring, and consistency with the three-tier architecture.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:component
```

## Variables

INPUT: $ARGUMENTS

- `INPUT` (required): Format: `{type} {name} {description}`. Type is `agent`, `command`, or `skill`. Name is kebab-case. Description is natural language.

## Workflow

### Step 1: Parse Input & Load the Type-Specific Creator Skill

Parse `INPUT` into:
- **type**: agent | command | skill
- **name**: kebab-case identifier
- **description**: what it does and when to use it

If any part is ambiguous, ask with `AskUserQuestion`.

Then load the creator skill for that type (each owns its template, field rules, and wiring checklist):

```
agent   → Read .agents/skills/agent-creator/SKILL.md
command → Read .agents/skills/command-creator/SKILL.md
skill   → Read .agents/skills/skill-authoring/SKILL.md   (doctrine + toolkit conventions; use skill-creator for the create→eval→improve loop)
```

The shared three-tier architecture + "no duplication between layers" rule lives in CLAUDE.md.

### Step 2: Check for Conflicts

**For agents:**
```
Read .agents/roles/{name}.md — must NOT exist
Read .claude/agents/{name}.md — check for a legacy or generated role
Glob .agents/roles/*.md — check for role overlap
Glob .claude/agents/*.md — check legacy names with no canonical equivalent
```

**For commands:**
```
Read .agents/skills/{name}/SKILL.md — check canonical names first
Read .claude/commands/{name}.md OR .claude/commands/create/{name}.md OR .claude/commands/review/{name}.md — must NOT exist
```

**For skills:**
```
Read .agents/skills/{name}/SKILL.md — must NOT exist
Read .claude/skills/{name}/SKILL.md — check native or project-owned conflicts
```

If a conflict exists, report it and ask the user whether to update the existing component or create with a different name.

### Step 3: Gather Context

**For agents** — determine:
- Native runtime policy: Claude model floor/escalation and tool permissions, plus any Codex-specific settings? Keep these in runtime adapters; use the configured Codex model, never a Claude model identifier.
- Tools needed: implementation set, research set, or read-only set?
- Existing skills to wire, or does a new skill need to be created too?
- Which commands will delegate to this agent?

**For commands** — determine:
- Category: setup (`create/`), review (`review/`), or build loop (top-level)?
- Does it commit or is it read-only?
- Which agents does it delegate to?
- What prerequisites (gates) does it require?

**For skills** — determine:
- Which agent(s) will load this skill?
- Does it provide a document template, quality criteria, interview questions, or reference material?
- Is there an existing skill it might overlap with?

If the description doesn't make the answers obvious, ask with `AskUserQuestion` — one focused question covering the key decisions, not a multi-part interview.

### Step 4: Generate

Follow the template in the type-specific creator skill loaded in Step 1 exactly. Write the file:

- **Agent** → `.agents/roles/{name}.md`, with runtime settings in `.claude/shared-agents.json` and `.codex/shared-agents.json`; render with `node .claude/core/render-shared-agents.js`
- **Command** → `.agents/skills/{native-skill-name}/references/workflow.md` plus its `SKILL.md` selector; register the native command path in `.agents/adapters/workflows.json` and Claude frontmatter in `.agents/adapters/claude/workflow-metadata.json`
- **Skill** → `.agents/skills/{name}/SKILL.md`

The generated content must:
- Use the exact frontmatter field order from the skill template
- Include all required sections from the body structure template
- Have a distinct personality/perspective (agents) — not generic
- Reference real file paths and agent names (commands) — not placeholders
- Contain domain knowledge, not orchestration (skills) — not process steps

Render all source additions with `node .claude/core/render-shared-agents.js`. Native `.claude/` and `.codex/` files are generated outputs. Namespaced commands use hyphenated skill names, e.g. `/review:example` → `review-example`.

### Step 5: Wire It Up

**For agents:**
- If skills were specified, verify they exist. If a new skill is needed, create it first (repeat Step 4 for the skill).
- Check if any existing command should delegate to this agent. If so, note it in the report (don't modify commands automatically).

**For commands:**
- Verify all agents referenced in the workflow exist.
- If the command uses a new agent, note it in the report.

**For skills:**
- Update canonical `.agents/roles/` sources (legacy `.claude/agents/` only when no canonical role exists), then render; add the skill name to their frontmatter `skills:` list.

### Step 6: Verify

Run the wiring checklist from the type-specific creator skill (loaded in Step 1) against the created component. Report any issues. For skills, also run `node .claude/core/skill-conformance.js` to confirm name/dir match, description CSO, and the ≤500-line budget.

### Step 7: Commit

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified.

### Step 8: Report

```markdown
## Component Created

**Type:** {agent|command|skill}
**Name:** {name}
**File:** {path}

### Wiring
| Connection | Status |
|-----------|--------|
| {skill → agent} | {Wired / Needs manual wiring} |
| {agent → command} | {Wired / Needs manual wiring} |

### Checklist
- [x] {checks that passed}
- [ ] {any manual steps remaining}

**Committed**: {hash} — `feat: /create:component — {summary}`
```

## Examples

```
# New agent
/create:component agent data-engineer ETL pipeline design, data modeling, and migration strategy

# New command
/create:component command remember Query-driven memory enrichment that captures Q&A to daily log

# New skill
/create:component skill supabase-postgres Supabase + PostgreSQL patterns including RLS, edge functions, and migrations
```

## Anti-Patterns

- **DO NOT create agents that overlap with existing ones** — check the inventory first
- **DO NOT put orchestration logic in skills** — that belongs in commands
- **DO NOT put domain knowledge in commands** — that belongs in skills
- **DO NOT create a skill without wiring it to at least one agent**
- **DO NOT generate generic personalities** — every agent needs a distinct point of view
