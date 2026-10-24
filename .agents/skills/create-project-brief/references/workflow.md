# Create Project Brief

Create a strategic project brief. Produces `docs/product/brief.md`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:project-brief
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle upstream checks, mode detection, and user interviews. The `product-strategist` agent handles document generation. Do NOT write the brief inline — delegate via Task tool.

**Agent**: `product-strategist` (via Task tool with `subagent_type: "product-strategist"`)

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Check Upstream (main agent)

- Read `docs/product/brainstorm.md` if it exists (use as input context)
- Read `docs/modules/*/research.md` or `docs/.output/findings/research/**` if any research exists (use as input context)
- If neither exists, that's fine — we'll interview from scratch

### 2. Check for Existing Output (main agent)

- If `docs/product/brief.md` exists → ask: **update** or **replace**?

### 3. Detect Mode (main agent)

- If upstream docs exist AND they're substantive → **Context Mode** (extract and organize)
- If no upstream docs → **Interview Mode**
- If INPUT provided → use as seed for either mode

### 4a. Interview Mode (main agent)

Use AskUserQuestion to gather vision and scope. Use the Interview Questions from the `project-planning` skill's `references/project-brief.md` as the question bank — cover vision, users, features, scope boundaries, constraints, and success metrics.

### 4b. Context Mode (main agent)

Synthesize a context brief from upstream docs:
- Extract vision from brainstorm recommended direction
- Extract users from brainstorm problem space
- Extract constraints from research findings

### 5. Delegate to Agent

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow (such as `telemetry-log.js`) as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow has no build or test gate; in an adopter any later gate is the application's own and never the Domdhi.Agents toolkit suite. Its evidence is `docs/product/brief.md` passing the real-document check (no `<!-- @@template -->` first line) and the Step 6 Required Sections Checklist, plus the hash of a commit that stages only the files this command wrote; discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran.

Use the Task tool with `subagent_type: "product-strategist"` to generate the brief.

**Task prompt must include**:
1. Project name and what to produce (`docs/product/brief.md`)
2. Summary of upstream context (brainstorm direction, research findings)
3. User's answers from interview rounds (if any)
4. Mode (Context/Interview)
6. The grounding rule: never invent or fabricate project business requirements, goals, users or constraints; ground each in the user's statements, the upstream documents and verified source, and record anything unknown as an open question

The `product-strategist` agent auto-loads the `project-planning` skill via frontmatter — do NOT tell it to read the skill file.

### 6. Validate (main agent)

After the agent completes, verify the output:
- Check against the Required Sections Checklist in `.claude/skills/project-planning/references/project-brief.md`
- If any section is incomplete, delegate back to the agent to fill it

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command and commit with a descriptive message.

### 8. Report (main agent)

```markdown
## Project Brief Complete

**Output**: docs/product/brief.md
**Vision**: {1-sentence vision}
**Key features**: {count} identified ({must-have count} must-have)

**Committed**: {hash} — `docs: /create:project-brief — {summary}`
**Next step**: Run `/create:project-requirements` to define detailed requirements.
```
