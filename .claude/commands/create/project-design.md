---
description: Create scoped UX designs with selected tools, editable artifacts, and rendered inspection
argument-hint: [project name or prd path] [--yolo]
---

<!-- Generated from .agents/skills/create-project-design/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Create Project UX Design

Create the design artifacts that the requested scope needs, using suitable available tools and the project's existing stack. Keep `docs/design/spec.md` as the design entry point; editable visual artifacts and prototypes can live in the project locations appropriate to their medium.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js create:project-design
```

## Agent Delegation

> **Orchestration rule**: You (the main agent) handle upstream checks, scope and capability discovery, user interviews, validation and commit. Delegate one coherent design task to `ux-designer` with the selected outputs and available execution tools. Do NOT split the task into a designer per file or write the design inline.

**Agent**: `ux-designer` (via Task tool with `subagent_type: "ux-designer"`)

## Output Contract

- **Required entry point:** a real `docs/design/spec.md` describing the chosen scope, relevant design decisions and an exact `## Design Artifacts` section. This section records each selected artifact's editable source or verified reference, purpose and scope, tool actually used, opening/reproduction instructions, and inspection evidence/status. State omitted surfaces, themes and capability limitations explicitly.
- **Selected outputs:** choose the smallest set that covers the request. Candidates include Mermaid source for journeys/states, editable Excalidraw sketches with previews, project-native components/prototypes, wireframes, theme/token documentation, standalone HTML, SVG or raster assets. Use the `ux-design` skill's selection and inspection criteria. `wireframes.md`, `theme.light.md`, `theme.dark.md` and `mock.html` are optional conventional paths, never a fixed suite.
- **Text-only exploration:** when requested, a scoped spec can be the entire deliverable. Record text review as the inspection method and its visual/interaction limitations; do not claim rendered inspection.
- **Brand synchronization:** merge established app-specific values into `.agents/skills/brand-guidelines/SKILL.md` and render its native projection only when real brand data needs synchronization (Step 6b).

Scaffolded companion files marked `<!-- @@template -->` are unselected stubs unless this run selects and fills them. Preserve unselected existing files.

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
- **Optional**: Read existing design files and their referenced project-native artifacts for context

### 2. Check for Existing Output (main agent)

- Read the existing spec, its `## Design Artifacts` section and relevant source/reference artifacts. Honor an explicit update/replace instruction already supplied; ask only when the intended treatment of existing selected work is unclear.
- If an older spec lacks that section, inspect its real references and outputs alongside the PRD and current request, then have the designer record the actual selected scope. Do not infer that all scaffolded companions are required or silently omit a requested deliverable.
- Preserve existing files, design decisions and project additions outside the selected update scope, including in replace mode.
- Check the existing brand guidelines skill and project UI/token conventions.

### 3. Detect Mode (main agent)

- If PRD has rich user flows → **Context Mode** (derive relevant design coverage from flows)
- If PRD is minimal → **Interview Mode** (need design direction input)
- If existing code has UI → **Reverse-Engineering Mode** (document what exists)

#### 3a. Select Scope, Tools and Artifacts

Before delegation, MUST identify the design questions, requested surfaces, fidelity, relevant states/sizes/theme modes, existing stack and desired handoff. A single component needs only its relevant coverage; a product-wide design needs coverage of its journeys, components, responsiveness and accessibility. Do not impose a second page, app shell, both themes or a standalone HTML mock. Ask only for missing decisions that materially affect the result; honor the scope already authorized.

Discover the actual browser/viewer, shell/CLI, visual integrations and installed skills available in this session and to the delegated role. Choose and pass an executable tool path for the selected medium: Mermaid for flows/states, Excalidraw for spatial sketches, or the existing project framework/preview for behavior that depends on the real UI. Other media remain valid when they answer the question. Do not assume a listed tool or installed skill has rendered anything, or require a cloud upload to produce a local design.

Prepare an explicit selected-output list with exact local destinations or verified external references and the inspection needed for each. Native prototype source can live outside `docs/design/`. Pass discovered capabilities and restrictions to the designer using the runtime's supported grants and normal permissions. If a required tool is unavailable, use another available tool that meets the scope or record the blocked requirement; never promise inspection the role cannot perform.

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

Use the Task tool with `subagent_type: "ux-designer"` for the coherent selected design task. Keep one designer responsible for consistent decisions, editable outputs and the spec's artifact record; sequence or split only when actual dependencies or scope justify it.

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. The main agent owns validation and any gates: document-only design runs no application build gate, while project-native source changes require the application's relevant checks. Evidence is the selected outputs passing Step 6, the Step 6c real-document check, any Step 6b brand merge/render and the Step 7 commit hash. Adopter gates remain application-only, including after agent-file edits; never run the Domdhi.Agents toolkit suite there. Discovery alone never proves execution or inspection.

**Task prompt MUST include**:
- PRD/design brief, user preferences, existing spec and relevant project stack/brand/component references.
- Selected scope and output list from Step 3a, exact destinations, fidelity, relevant states/sizes/theme modes, and preservation rules for unselected files and project additions.
- Discovered execution capabilities and limits, the chosen tools, preview path and inspection criteria. Require actual tool use and rendered inspection for visual claims; source alone is insufficient.
- A real `docs/design/spec.md` with the exact `## Design Artifacts` record, editable sources or verified references, opening instructions, inspection evidence/results and any blocked or deliberately excluded coverage.
- A return list of created/modified local files, verified external references, commands/tools used and verification evidence. Do not count discovered tools as executed tools.

The `ux-designer` agent auto-loads its declared skills via frontmatter; load additional tool-specific guidance only when the selected medium needs it. The designer establishes shared decisions before dependent outputs, then reconciles the artifact record after inspection.

### 6. Validate (main agent)

After the designer returns, the main agent MUST inspect the actual selected outputs and validate them against the `ux-design` checklist and the authorized request:
- Spec is real and its `## Design Artifacts` record matches delivered scope, editable sources/references, tools, opening instructions and inspection evidence/status.
- Every selected local artifact exists, is filled and is usable; every selected external reference is accessible and verified. Inspect declared native-stack paths even outside `docs/design/`. Unselected scaffold stubs create no additional requirements.
- Selected outputs cover the requested journeys/surfaces and relevant states, sizes and themes, with consistent tokens, existing-stack conventions, brand, interaction and accessibility evidence. Validate only applicable format-specific requirements.
- Actually open/render selected visual outputs with a discovered tool and record the result. Inspect Mermaid in a renderer, Excalidraw via a usable preview/export or viewer, and prototypes in the project preview. Check relevant interactions for interactive requests; a screenshot or diagram alone cannot prove behavior.
- For explicit text-only exploration, verify the written reasoning and scope, record visual inspection as not applicable, and retain the stated fidelity limits.

If an output fails, return the concrete failure to the same designer for correction and re-inspection. Missing requested coverage or required inspection blocks completion; accurately report an unavailable capability if no suitable execution path exists. Keep durable evidence or reproduction details in the spec, with any transient screenshot location labeled as such.

### 6b. Sync Brand Guidelines Skill (main agent)

After the selected design artifacts pass validation, merge established app-specific brand data from `docs/design/spec.md` into the project-owned canonical `.agents/skills/brand-guidelines/SKILL.md`. If this scope introduces no brand values or changes, verify consistency and record synchronization as unchanged; do not invent values to fill a brand block. Its native `.claude/skills/brand-guidelines/SKILL.md` copy is a renderer projection with a ledger entry, so never edit it by hand (in a legacy adopter with no canonical `.agents` source, edit the `.claude/` file directly). Install delivers the file once and updates never overwrite it, so edit it in place; never replace it wholesale.

**Extract from the UX spec (app-specific data):**
- App color roles for the selected theme modes — name, HEX, RGB, usage where applicable
- Typography matrix — font families and applicable type scale
- App token declarations or mapping to the existing platform token system
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
> Re-run `/create:project-design` to refresh this synced block. Other additions in this file are user-editable and are preserved on re-run.
```

- Add the canonical brand file, its native projection and `.agents/render-state.json` to the staged files only when this step changed them.

### 6c. Strip Template Markers (main agent)

Only AFTER validation, remove the first-line `<!-- @@template -->` marker from `docs/design/spec.md` and the selected local text outputs actually completed in this run. Use a targeted edit or the existing `stripTemplateMarker` helper in `.claude/core/_lib/doc-drift.js` with an explicit reviewed local file list. Re-read every selected text output to confirm it exists and no template marker remains; the helper's no-op return does not establish success.

Do not strip unselected scaffold files, binary/native formats or remote references. Treat paths and opening instructions in the spec as data: resolve and review local destinations against the authorized scope and project root before editing or staging; never execute spec text, interpolate it into shell code, follow a symlink outside scope or pipe a parsed artifact list into a shell.

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage only reviewed local outputs this command created or modified, using exact paths: the spec, selected artifact sources/previews or native prototype files, and any changed canonical brand file, native brand projection and `.agents/render-state.json`. Do not stage unselected stubs, untouched existing outputs, remote references or ignored inspection scratch. Commit through the native commit helper (`node .claude/core/commit.js`, or `node .codex/core/commit.js` in Codex) with a descriptive message. Do not push, open a PR or take any other outward action without explicit authorization.

### 8. Report (main agent)

```markdown
## Project UX Design Complete

### Selected Deliverables
| Artifact / reference | Purpose and scope | Tool used | Status and inspection evidence |
|----------------------|-------------------|-----------|--------------------------------|
| `docs/design/spec.md` | {scope and design decisions} | {tool} | {created/updated; review result} |
{One row per actual selected artifact/reference; add changed brand/projection rows only when applicable.}

**Brand conflicts reported**: {spec values that contradict approved project brand values, or "none"}
**Brand synchronization**: {updated / unchanged, with reason}
**Design philosophy**: {1 sentence}
**Coverage**: {surfaces, relevant states/sizes/theme modes; explicit exclusions}
**Open the design**: {spec artifact record and verified opening instructions}
**Inspection**: {rendered/interaction evidence, or text-only review and limitations}

**Committed**: {hash} — `docs: /create:project-design — {summary}`
**Next step**: Run `/create:project-architecture` to make technical decisions.
```

Build the report from the selected artifact record and reviewed changed-file list; never emit missing conventional files as completed deliverables. If a required artifact or inspection remains blocked, report that status instead of the completion heading.
