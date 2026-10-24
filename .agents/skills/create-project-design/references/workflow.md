# Create UX Design Suite

Create a complete UX design package. Produces all design artifacts in `docs/design/`.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:project-design
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle upstream checks, mode detection, and user interviews. The `ux-designer` agent handles all artifact generation. Do NOT write design files inline — delegate via Task tool.

**Agent**: `ux-designer` (via Task tool with `subagent_type: "ux-designer"`)

## Output Files

| File | Description |
|------|-------------|
| `docs/design/spec.md` | Design system, principles, component inventory, interaction patterns |
| `docs/design/wireframes.md` | ASCII wireframes for all key pages |
| `docs/design/theme.light.md` | Light theme color palette and tokens |
| `docs/design/theme.dark.md` | Dark theme color palette and tokens |
| `docs/design/mock.html` | Self-contained HTML mock of the application shell |
| `.agents/skills/brand-guidelines/SKILL.md` (rendered to `.claude/skills/brand-guidelines/SKILL.md`) | Project-owned brand skill; app-specific additions synced from the UX spec (Step 6b) |

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Check Upstream (main agent)

#### 1a. Check --yolo flag
If `$ARGUMENTS` contains `--yolo`, set YOLO_MODE = true. Strip `--yolo` from INPUT before continuing.

#### 1b. Hard Gate: Require real PRD
Read the first line of `docs/product/requirements.md`. Check that it exists AND does not contain `<!-- @@template -->`.

**If `docs/product/requirements.md` is missing or template-only:**
- If YOLO_MODE → warn: "No PRD found. Proceeding in yolo mode with Interview Mode." → go to Interview Mode
- Otherwise → **STOP**: "`docs/product/requirements.md` has not been created yet. Run `/project-requirements` first. Use `--yolo` to bypass this gate."

- **Optional**: Read `docs/product/brief.md` for brand/vision context (only if real, not template)
- **Optional**: Read existing design files in `docs/design/` for reference

### 2. Check for Existing Output (main agent)

- If any design files exist in `docs/design/` with content → ask: **update** or **replace**?
- Check for existing brand guidelines skill content

### 3. Detect Mode (main agent)

- If PRD has rich user flows → **Context Mode** (derive wireframes from flows)
- If PRD is minimal → **Interview Mode** (need design direction input)
- If existing code has UI → **Reverse-Engineering Mode** (document what exists)

#### 3a. Scope Check — full suite vs lightweight (F9)

The full output suite (spec + wireframes + light/dark themes + mock HTML + personas) is right for an app with real surface area. For a **small UI** — a browser-extension popup, a single options page, a CLI, a one-screen tool — it massively over-produces. Before generating, gauge the surface from the PRD/architecture/asset inventory and, if it's small, **ask the user** which scope they want:

- **Lightweight** (recommended for small UIs): a single `docs/design/spec.md` capturing layout, sizing, color/typography tokens, and component notes — skip separate wireframes/theme files/mock HTML/personas.
- **Full suite**: all output files below.

Do not default a 300px popup into the full persona-and-mock pipeline. When in doubt for anything larger than a few screens, full suite is fine.

### 4a. Interview Mode (main agent)

Use AskUserQuestion to gather design direction. Use the Interview Questions from the `ux-design` skill as the question bank — cover design philosophy, visual style, component library, layout approach, and device targets.

### 4b. Context Mode (main agent)

Synthesize a design brief from upstream docs:
- Extract user flows from PRD → derive page inventory
- Map FRs to UI components needed
- Identify data-dense pages (data grids, dashboards)
- Propose layout based on application type
- Note brand-guidelines skill if available

### 5. Delegate to Agent

Use the Task tool with `subagent_type: "ux-designer"` for each artifact.

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. This workflow runs no build gate; its evidence is the written design files passing Step 6 validation, the Step 6c real-document check (no `<!-- @@template -->` marker left), the Step 6b brand-file merge and the Step 7 commit hash. In an adopter, any build or test gate that later checks this design is the application's own command, never the Domdhi.Agents toolkit suite, also after agent-file edits. Discovery alone (an installed skill, a listed command or a loaded file) never proves this workflow ran; report completion only from that evidence.

**Task sequence** (respects dependencies):

1. **UX Spec** — `Task(ux-designer)`: MUST complete first (other files depend on it)
   - Prompt includes: PRD summary, design brief, user interview answers
   - Output: `docs/design/spec.md`
   - Agent auto-loads `ux-design` skill for template/quality criteria

2. **Wireframes + Themes** — Run in parallel after UX spec completes:
   - `Task(ux-designer)`: Create wireframes → `docs/design/wireframes.md`
     - Prompt includes: reference to the UX spec just created, PRD user flows
   - `Task(ux-designer)`: Create light + dark themes → `docs/design/theme.light.md` and `docs/design/theme.dark.md`
     - Prompt includes: reference to the UX spec color system section

3. **HTML Mock** — `Task(ux-designer)`: After themes complete
   - Output: `docs/design/mock.html`
   - Prompt includes: reference to UX spec layout + dark theme tokens
   - Must be self-contained (inline CSS, no external dependencies)

**Each Task prompt must include**:
- What to produce and exact file path
- Reference to UX spec (after first task completes)
- Design brief / user preferences from the interview
The `ux-designer` agent auto-loads the `ux-design` skill via frontmatter — do NOT tell it to read the skill file.

### 6. Validate (main agent)

After all agents complete, verify each file:
- UX Spec: all required sections present (philosophy, typography, layout, components, interaction, responsive, accessibility)
- Wireframes: at least 2 pages with ASCII art, desktop AND mobile for primary pages
- Themes: semantic tokens used, WCAG contrast verified
- Mock Layout: self-contained HTML, responsive, uses correct color tokens

If any file fails validation, delegate back to the agent to fix.

### 6b. Sync Brand Guidelines Skill (main agent)

After all design artifacts pass validation, merge the app-specific brand data from the generated `docs/design/spec.md` into the project-owned brand file, the canonical `.agents/skills/brand-guidelines/SKILL.md`. Its native `.claude/skills/brand-guidelines/SKILL.md` copy is a renderer projection with a ledger entry, so never edit it by hand (in a legacy adopter with no canonical `.agents` source, edit the `.claude/` file directly). Install delivers the file once and updates never overwrite it, so edit it in place; never replace it wholesale.

**Extract from the UX spec (app-specific data):**
- App color roles for all theme modes (light, dark) — name, HEX, RGB, usage
- Typography matrix — font families per mode, type scale (headline through code)
- App CSS variable declarations (the app's own tokens)
- Spacing scale (if defined)
- Accessibility contrast ratios (WCAG AA/AAA results for key pairs)


**Write rules:**
- **Preserve the frontmatter** (`name`, `description` and every other key) exactly as-is.
- **Preserve the `## App-specific additions` section** — its heading, its HTML comment and every addition already recorded under it, including user-written ones. Write the spec's app-specific data (app roles, tokens, type scale, contrast results) into that section under a `### Synced from docs/design/spec.md` subsection, placed directly under the section's HTML comment on first write. The synced block runs from that heading through the last line of its Source footer, inclusive; on a re-run, replace exactly that span and nothing after it, and keep every other addition. Remove the `No app-specific additions recorded.` placeholder once real data is written.
- **Existing brand structure** (the brand file has no `## App-specific additions` section): keep the existing body structure (Color Palette, Typography, CSS Variables, Usage) so downstream consumers don't break, and update the spec-derived values within it. Still never delete a user-written section, note or addition.
- **Edit only the canonical file, then render.** Before editing, run `node .claude/core/render-shared-agents.js --check`; if it reports any pending output other than the brand file, stop and report that drift instead of rendering, because a render would rewrite projections this command does not commit. After editing `.agents/skills/brand-guidelines/SKILL.md`, run `node .claude/core/render-shared-agents.js` (`node .codex/core/render-shared-agents.js` in Codex) to refresh the `.claude/skills/brand-guidelines/SKILL.md` projection and `.agents/render-state.json`. On a CONFLICT, stop and report it; never use `--force`.
- End the synced subsection (or, for a brand file, the body) with this **Source footer**:

```markdown
> **Source**: App-specific values synced from `docs/design/spec.md` by `/create:project-design` on {YYYY-MM-DD}.
> Re-run `/create:project-design` to refresh this synced block. Other additions in this file are user-editable and are preserved on re-run..
```

- Add `.agents/skills/brand-guidelines/SKILL.md`, its rendered `.claude/skills/brand-guidelines/SKILL.md` and `.agents/render-state.json` to the staged files for the commit step

### 6c. Strip Template Markers (main agent)

Strip the `<!-- @@template -->` marker from all generated design files so downstream gates (`isRealDoc`, `/review:check-readiness`) see them as real docs rather than unfilled stubs. The call is idempotent — it no-ops on any file that was written fresh without the marker:

```bash
node -e "
const { stripTemplateMarker } = require('./.claude/core/_lib/doc-drift.js');
const path = require('path');
[
  'docs/design/spec.md',
  'docs/design/wireframes.md',
  'docs/design/theme.light.md',
  'docs/design/theme.dark.md',
  'docs/design/mock.html',
].forEach(f => stripTemplateMarker(path.resolve(f)));
"
```

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage each file this command created or modified by its exact path, including the canonical brand file, its rendered projection and `.agents/render-state.json`, and commit through the native commit helper (`node .claude/core/commit.js`, or `node .codex/core/commit.js` in Codex) with a descriptive message. Do not push, open a PR or take any other outward action without explicit authorization.

### 8. Report (main agent)

```markdown
## UX Design Suite Complete

### Files Created
| File | Status |
|------|--------|
| `docs/design/spec.md` | Created |
| `docs/design/wireframes.md` | Created |
| `docs/design/theme.light.md` | Created |
| `docs/design/theme.dark.md` | Created |
| `docs/design/mock.html` | Created |
| `.agents/skills/brand-guidelines/SKILL.md` | Updated (app-specific additions) |
| `.claude/skills/brand-guidelines/SKILL.md` | Rendered from the canonical file |

**Brand conflicts reported**: {spec values that contradict approved project brand values, or "none"}
**Design philosophy**: {1 sentence}
**Pages wireframed**: {count}
**Components identified**: {count}
**Themes**: {light/dark/both}

**Committed**: {hash} — `docs: /create:project-design — {summary}`
**Next step**: Run `/create:project-architecture` to make technical decisions.
```
