---
description: Create a Product Requirements Document (PRD) with functional and non-functional requirements
argument-hint: [project name or project-brief path] [--yolo]
---

<!-- Generated from .agents/skills/create-project-requirements/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Create PRD

Create a comprehensive Product Requirements Document. Produces `docs/product/requirements.md`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:project-requirements
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle upstream checks, mode detection, and user interviews. The `product-strategist` agent handles document generation. Do NOT write the PRD inline — delegate via Task tool.

**Agent**: `product-strategist` (via Task tool with `subagent_type: "product-strategist"`)

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Check Upstream (main agent)

#### 1a. Check --yolo flag
If `$ARGUMENTS` contains `--yolo`, set YOLO_MODE = true. Strip `--yolo` from INPUT before continuing.

#### 1b. Hard Gate: Require at least one Phase 1 artifact
Check that at least ONE of these files exists AND does not contain `<!-- @@template -->` on its first line:
- `docs/product/brief.md`
- `docs/product/brainstorm.md`
- Any file matching `docs/modules/*/research.md` or `docs/.output/findings/research/**`
- `docs/architecture/overview.md` — **brownfield exit (C8):** a real reverse-engineered architecture from `/onboard` is a valid upstream artifact. `/onboard` deliberately produces architecture (not a brief), so without this a brownfield repo dead-ends here with no onboard-native path to requirements. When this is the only real artifact, draw requirements from it in Reverse-Engineering Mode.

**If NONE of them are real (all missing or all template-only):**
- If YOLO_MODE → warn: "No Phase 1 artifacts found (brief, brainstorm, research, or architecture). Proceeding in yolo mode with Interview Mode." → go to Interview Mode
- Otherwise → **STOP**: "No upstream artifacts found. Run `/create:project-brief`, `/brainstorm`, `/research`, or `/onboard` (brownfield) first. Use `--yolo` to bypass this gate."

**If at least one is real** → read whichever exist for context and proceed to mode detection.

- **Optional**: Read `docs/work/todo/feature-ideas.md` — if it has captured ideas from brainstorming, use them as input for functional requirements

### 2. Check for Existing Output (main agent)

- If `docs/product/requirements.md` exists → ask: **update** (add/modify sections) or **replace** (start fresh)?

### 3. Detect Mode (main agent)

- If `product/brief.md` exists with substantive content → **Context Mode**
- If no brief or user wants fresh start → **Interview Mode**
- For existing codebases → **Reverse-Engineering Mode** (read code to extract requirements)

### 4a. Interview Mode (main agent)

Use AskUserQuestion to gather requirements. Use the Interview Questions from the `project-planning` skill's `references/project-requirements.md` as the question bank — cover modules, user capabilities, performance, security, data model, and integrations. End with a MoSCoW prioritization round.

### 4b. Context Mode (main agent)

Synthesize a requirements brief from upstream docs:
- Extract personas from project brief's Target Users
- Extract feature areas from Key Features
- Extract constraints from Constraints section
- Extract success criteria from brief
- Gather feature ideas from `feature-ideas.md` if available

### 5. Delegate to Agent

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow (`telemetry-log.js` and `_lib/doc-drift.js grade`) as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow has no build or test gate; in an adopter any later gate is the application's own and never the Domdhi.Agents toolkit suite. Its evidence is `docs/product/requirements.md` passing the real-document check (no `<!-- @@template -->` first line), the Step 6 checklist and the `doc-drift.js grade` exit 0, plus the hash of a commit that stages only the files this command wrote; discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran.

Use the Task tool with `subagent_type: "product-strategist"` to generate the PRD.

**Task prompt must include**:
1. Project name and what to produce (`docs/product/requirements.md`)
2. Summary of upstream context (brief vision, personas, features, constraints)
3. User's answers from interview rounds (if any)
4. Feature ideas from `feature-ideas.md` (if available)
5. Mode (Context/Interview/Reverse-Engineering)
7. The grounding rule: never invent or fabricate project business requirements, personas, targets or constraints; trace each requirement to the user's statements, the upstream documents or verified source, and record anything unknown as an open question or assumption for the Step 5b clarify pass

The `product-strategist` agent auto-loads the `project-planning` skill via frontmatter — do NOT tell it to read the skill file.

### 5b. Post-draft clarify pass (main agent)

The first draft is where ambiguity hides — an FR with an unstated edge case, a persona goal the draft glossed, an NFR with no target. Run one clarify pass to resolve the gaps **into the doc**, so the answers live in the spec and survive compaction (interview answers that stay in chat evaporate — the failure `/interview` Step 6b also fixes).

1. After the Step-5 agent has completed and `docs/product/requirements.md` exists as a real draft, read it. (Do not run this pass while the draft is still being generated.)
2. Identify up to **5** genuine gaps or ambiguities a downstream implementer would have to guess at — missing acceptance criteria, an unscoped NFR, an undecided priority, an unstated assumption. Skip anything the brief or codebase already answers.
3. If there are no real gaps, skip this step — do not invent questions.
4. Ask them with `AskUserQuestion` (concrete options, recommendation first — same rules as `/interview`). One round; don't interrogate.
5. **Write each answer back into the relevant section of the doc** with the Edit tool — into the FR's acceptance criteria, the NFR's target, the assumptions list — not into a chat-only summary. The doc is the record.

Then proceed to validate the now-clarified doc.

### 6. Validate (main agent)

After the agent completes, read `docs/product/requirements.md` and validate against the **Required Sections Checklist** in `.claude/skills/project-planning/references/project-requirements.md`. Also verify MoSCoW is used (not everything Must Have) and NFRs have measurable targets. If anything is missing, delegate back to the agent to fill it.

Then run the deterministic quality gate over the doc:

```bash
node .claude/core/_lib/doc-drift.js grade docs/product/requirements.md
```

- Exit 0 → the doc has no leftover placeholders and passes the structural checks; proceed to step 7.
- Exit 1 → the printed failures list what is unfilled (placeholder tokens, an FR with no Given/When/Then acceptance criteria, an all-Must MoSCoW, or an empty Success Criteria table). Delegate back to the agent to fix each one, then re-run the gate. Do not proceed until it exits 0.

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all files created or modified by this command and commit with a descriptive message.

### 8. Report (main agent)

```markdown
## PRD Complete

**Output**: docs/product/requirements.md
**Modules**: {count}
**Functional Requirements**: {count} ({must-have count} Must Have)
**Non-Functional Requirements**: {count}
**User Flows**: {count}

**Committed**: {hash} — `docs: /create:project-requirements — {summary}`
**Next step**: Run `/create:project-design` for UX design, or `/create:project-architecture` for technical architecture.
```
