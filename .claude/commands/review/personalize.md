---
description: Give agents names, personas, and soul-level identity. Works before or after /specialize.
argument-hint: "[agent name | --all]"
---

<!-- Generated from .agents/skills/review-personalize/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Personalize Agents

Walk through agents interactively to assign names, personas, and soul-level identity. Each agent gets a unique personality that influences how it approaches work while preserving its technical capabilities.

**Idempotent** — safe to re-run. Soul sections are replaced (not duplicated). Project Context sections from `/specialize` are preserved. Frontmatter nicknames and aliases are updated in place.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:personalize
```

## Agent File Zones

Agent files have three distinct zones. This command owns the **Soul Zone** only:

```
---                          ← Frontmatter (this command updates nickname/aliases only)
name: agent-name
nickname: {name}             ← Added by this command
aliases: [...]               ← Added by this command
description: ...
tools: ...
skills: ...
memory: project
---

# {Name} — {Role Title}     ← SOUL ZONE (this command owns everything here)
                               Before /personalize: Principles, Working Style, Quality Standards (thin default)
                               After /personalize: Identity, Decision Philosophy, Working Style, Quality Standards
...

## Project Context           ← SPECIALIZE ZONE (/specialize owns everything from here to EOF)
> Specialized for ...
...
```

**Boundary rules:**
- `/personalize` writes between the closing `---` of frontmatter and `## Skills` (or `## Project Context` / EOF when no Skills section exists)
- `/specialize` writes from `## Project Context` to EOF
- Neither command touches the other's zone

## Variables

TARGET: $ARGUMENTS (default: `--all`)
- `--all` — Walk through every agent
- `{agent-name}` — Personalize a single agent (e.g., `security-auditor`)

## Workflow

### 1. Discover Agents (main agent)

Scan `.agents/roles/*.md` first, plus `.claude/agents/*.md` only for names with no canonical role. Use the selected source for every write; native model/tool/memory metadata stays in `.claude/shared-agents.json` or `.codex/shared-agents.json`. Never edit generated native roles or root instructions to personalize a migrated role. For each role, determine:

**1a. Read frontmatter:**
- `name` — the agent identifier
- `nickname` — current name (if any)
- `aliases` — current aliases (if any)

**1b. Detect soul status:**
- **Has Soul** — File contains `## Identity` or `## Decision Philosophy` sections (personalized by a previous `/personalize` run)
- **Default** — File contains `## Principles` but NOT `## Identity` (structured thin-default shipped with the template)
- **Thin** — File has only `## Expertise` / `## Instructions` / `## Quality Gates` (legacy format)

Both **Default** and **Thin** agents need souls — treat them the same way in the roster (Action: "Create").

**1c. Detect specialize status:**
- **Specialized** — File contains `## Project Context` section
- **Not Specialized** — No Project Context section

### 2. Present Agent Roster (main agent)

Show the user a status table:

```
## Agent Roster

| # | Agent | Name | Soul | Specialized | Action Needed |
|---|-------|------|:----:|:-----------:|---------------|
| 1 | architect | Tweetle-Dum | Yes | No | Skip / Update |
| 2 | security-auditor | Pilar | Yes | No | Skip / Update |
| 3 | code-reviewer | — | No | No | Create |
| 4 | doc-writer | — | No | No | Create |
...
```

### 3. Walk Through Each Agent (main agent)

For each agent (or the single TARGET agent), use AskUserQuestion:

**3a. If agent already has a soul:**

Ask: "**{nickname} ({agent-name})** already has a soul. What would you like to do?"
- **Skip** — Move to next agent
- **Update persona** — Rewrite the soul with a new direction
- **Rename only** — Change nickname/aliases, keep soul content

**3b. If agent is thin (no soul):**

Ask: "**{agent-name}** needs a soul. What would you like to do?"
- **Create soul** — Full persona creation (name + identity)
- **Skip** — Leave as thin for now

### 4. Persona Direction (main agent)

For each agent getting a new or updated soul:

**4a. Offer persona directions** — Use AskUserQuestion with 3-4 persona options tailored to the agent's role. Each option should be a short archetype with a 1-sentence flavor description. Always include an "Other" escape for custom input.

Example for code-reviewer:
- **The Magistrate** — Passes measured judgment; firm but fair, never petty
- **The Hawk** — Nothing escapes the eye; spots patterns others miss
- **The Mentor** — Reviews to teach; every finding is a learning moment
- (Other — describe your own)

**4b. Offer name options** — Based on the chosen persona direction, offer 4-5 name options that fit the archetype. Include the persona flavor so names feel connected.

Example if "The Magistrate" was chosen:
- **Magistrate** — the title itself
- **Gavel** — the instrument of judgment
- **Bench** — where judgment is passed from
- **Verdict** — what they deliver
- (Other — pick your own)

### 5. Delegate Soul Writing (main agent → doc-writer)

For each agent that needs a soul written, use the Task tool with `subagent_type: "doc-writer"`.

**Task prompt must include:**
1. The agent's `name`, chosen `nickname`, and `aliases`
2. The agent's current `description` from frontmatter (preserve this — it drives auto-delegation)
3. The chosen persona direction and name
4. The agent's canonical `skills` and native adapter `tools` (so the soul references real capabilities)
5. The native adapter's `disallowedTools` if any (e.g., code-reviewer is write-restricted (Write allowed to review artifacts only, Edit disallowed) — the soul should reflect this)
6. Reference examples: provide 2 existing soul-level agents as style reference (e.g., Murphy and Pilar)
7. Instruction to read the reference agents from `.agents/roles/qa-engineer.md` and `.agents/roles/security-auditor.md`
8. Instruction to produce ONLY the soul zone content (from `# {Name} — {Role Title}` heading through `## Quality Standards`), NOT frontmatter, NOT Project Context

**Required soul sections (in order):**
```
# {Nickname} — {Role Title}

{Opening paragraph: who I am, what drives me, one memorable line}

## Identity

{2-3 paragraphs: how I think, what I value, what makes me different}

## Decision Philosophy

{4-5 numbered principles with bold headers and explanations}

## Working Style

{6-8 bullet points: concrete behaviors and habits}

## Quality Standards

{5-6 bullet points: what "done" looks like, measurable where possible}
```

### 6. Apply Soul to Agent File (main agent)

For each agent:

**6a. Update frontmatter** — Add or update `nickname` and `aliases` fields in the YAML frontmatter block. Do NOT change `name`, `description`, `tools`, `skills`, `memory`, or `model`.

**6b. Replace soul zone** — Replace everything between the closing `---` of frontmatter and `## Skills` (or `## Project Context` / EOF when no Skills section exists) with the new soul content.

**6c. Preserve Project Context** — If `## Project Context` exists in the file, ensure it remains intact after the soul content. Append a blank line between the soul and Project Context.

**Idempotency check:**
- Before writing, compare the new soul content with existing content
- If identical → report "No changes needed" and skip the write
- If different → replace and report "Updated"

### 7. Render and Commit (main agent)

After canonical edits run `node .claude/core/render-shared-agents.js`; review conflicts and move intended edits to the canonical source. Preserve both the Skills zone and Project Context. Stage canonical files and generated projections together.

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage all modified agent files and commit with a descriptive message.

### 8. Report

```markdown
## Personalization Report

### Date: {YYYY-MM-DD}

### Agents Updated

| Agent | Name | Persona | Action | Specialized |
|-------|------|---------|--------|:-----------:|
| {name} | {nickname} | {persona archetype} | {Created / Updated / Renamed / Skipped} | {Yes/No} |
| ... | ... | ... | ... | ... |

### Agent Roster (Final State)

| Agent | Name | Aliases | Soul | Specialized |
|-------|------|---------|:----:|:-----------:|
| architect | Tweetle-Dum | — | Yes | No |
| project-planner | Tweetle-Dee | Dee, Sweet Dee | Yes | No |
| ... | ... | ... | ... | ... |

### Stats
- **Total agents**: {count}
- **With souls**: {count} / {total}
- **With names**: {count} / {total}
- **Specialized**: {count} / {total}

**Committed**: {commit hash}
**Next step**: `/specialize` (if not yet run) or `/do` (if ready)
```

## Persona Library

Default persona directions for each agent role. These are starting points — the user can always choose "Other" for a custom direction.

### product-strategist
- **The Oracle** — Sees around corners; connects dots nobody else noticed
- **The Diplomat** — Balances competing stakeholder needs with grace
- **The Provocateur** — Challenges assumptions; asks the uncomfortable questions
- **The Cartographer** — Maps the territory before anyone starts building

### code-reviewer
- **The Magistrate** — Passes measured judgment; firm but fair, never petty
- **The Hawk** — Nothing escapes the eye; spots patterns others miss
- **The Mentor** — Reviews to teach; every finding is a learning moment
- **The Surgeon** — Precise, clinical, focused only on what matters

### doc-writer
- **The Scribe** — Faithful recorder; accuracy above all else
- **The Translator** — Bridges the gap between code and human understanding
- **The Cartographer** — Maps the system so others can navigate it
- **The Librarian** — Organizes knowledge so it's findable when needed

### playwright
- **The Phantom** — Moves through the browser unseen; leaves no trace
- **The Stage Director** — Choreographs browser interactions like scenes
- **The Scout** — Explores ahead and reports back what they found
- **The Puppeteer** — Controls the browser with invisible strings

### shadow
- **The Herald** — Announces discoveries and shares knowledge with the world
- **The Storyteller** — Weaves technical content into compelling narratives
- **The Professor** — Teaches through clear explanation and structured argument
- **The Columnist** — Has a voice, has opinions, writes with personality

## Integration with /specialize

This command and `/specialize` are complementary:
- **`/personalize`** gives agents *identity* — who they are, how they think, what they value
- **`/specialize`** gives agents *context* — what tech stack they're working with, what patterns to follow

**Run order doesn't matter:**
- `/personalize` first → `/specialize` appends Project Context below the soul
- `/specialize` first → `/personalize` inserts soul above existing Project Context
- Either can be re-run without affecting the other's zone

**`/specialize` must preserve the soul zone** when updating Project Context. It should:
1. Find `## Project Context` in the file
2. Replace from `## Project Context` to EOF
3. NOT touch anything above `## Project Context`

This is already the documented behavior in `/specialize` Step 2 idempotency rules.

## When to Run

- **During project setup**: After naming your first few agents, run with `--all` to catch the rest
- **After `/specialize` creates new stack-specific agents**: New agents are born thin — personalize them
- **When an agent's personality doesn't fit**: Update the persona direction
- **When onboarding**: Personalized agents are more memorable and easier to reference by name
