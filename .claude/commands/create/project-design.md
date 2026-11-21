---
description: Create scoped UX designs with selected tools, editable artifacts, and rendered inspection
argument-hint: [project name or prd path] [--yolo]
---

<!-- Generated from .agents/skills/create-project-design/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Create Project UX Design

Produce the design artifacts the requested scope needs, with the tools actually available and the project's existing stack, and leave `docs/design/spec.md` as the design entry point. A good result is a real spec whose `## Design Artifacts` record is true: each selected artifact exists, was opened or rendered with a real tool, and says how to reproduce it. Editable visual artifacts and prototypes can live wherever their medium belongs in the project.

## Telemetry (run first)

A user-typed command does not fire `PostToolUse:Skill`, so log the invocation yourself (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js create:project-design
```

## Agent Delegation

The main agent owns upstream checks, scope and capability discovery, user interviews, validation and the commit. One coherent design task goes to the `ux-designer` agent (Task tool, `subagent_type: "ux-designer"`) with the selected outputs and the available execution tools. Do not split it into a designer per file or write the design inline.

## Output Contract

- **Required entry point:** a real `docs/design/spec.md` covering the chosen scope and relevant design decisions, with an exact `## Design Artifacts` section. For each selected artifact the section records its editable source or verified reference, purpose and scope, the tool actually used, opening or reproduction instructions, and inspection evidence or status. Omitted surfaces, themes and capability limits are stated explicitly.
- **Selected outputs:** the smallest set that covers the request: Mermaid for journeys/states, editable Excalidraw sketches with previews, project-native components/prototypes, wireframes, theme/token documentation, standalone HTML, SVG or raster assets. The `ux-design` skill holds the selection and inspection criteria. `wireframes.md`, `theme.light.md`, `theme.dark.md` and `mock.html` are optional conventional paths, never a fixed suite.
- **Text-only exploration:** when requested, a scoped spec can be the whole deliverable. Record text review as the inspection method with its visual/interaction limits; do not claim rendered inspection.
- **Brand synchronization:** merge established app-specific values into `.agents/skills/brand-guidelines/SKILL.md` and render its projection only when real brand data needs syncing (Step 6b).

Scaffolded companions marked `<!-- @@template -->` are unselected stubs unless this run selects and fills them; leave unselected existing files alone.

## Variables

INPUT: $ARGUMENTS

## Workflow

### 1. Check Upstream (main agent)

**1a. `--yolo`.** If `$ARGUMENTS` contains `--yolo`, set YOLO_MODE and strip the flag from INPUT.

**1b. Hard gate: a real PRD.** `docs/product/requirements.md` must exist and must not carry `<!-- @@template -->` on its first line. If it is missing or template-only:
- In YOLO_MODE, warn "No PRD found. Proceeding in yolo mode with Interview Mode." and go to Interview Mode.
- Otherwise **STOP**: "`docs/product/requirements.md` has not been created yet. Run `/project-requirements` first. Use `--yolo` to bypass this gate."

Read `docs/product/brief.md` for brand/vision context when it is real, and any existing design files with the project-native artifacts they reference.

### 2. Check for Existing Output (main agent)

Read the existing spec, its `## Design Artifacts` section and the relevant artifacts. Honor an update/replace instruction already given; ask only when the intended treatment of existing selected work is unclear. If an older spec lacks the section, inspect its real references and outputs against the PRD and the request and have the designer record the actual scope; do not assume every scaffolded companion is required, and do not silently drop a requested deliverable. Preserve existing files, design decisions and project additions outside the selected update scope, even in replace mode. Check the existing brand guidelines skill and the project's UI/token conventions.

### 3. Detect Mode (main agent)

- Rich user flows in the PRD: **Context Mode** (derive design coverage from the flows).
- Minimal PRD: **Interview Mode** (needs design direction).
- Existing UI code: **Reverse-Engineering Mode** (document what exists).

#### 3a. Select Scope, Tools and Artifacts

Before delegating, settle the design questions, requested surfaces, fidelity, relevant states/sizes/theme modes, existing stack and the handoff the design must serve. Scope to the request: one component needs only its relevant coverage; a product-wide design covers journeys, components, responsiveness and accessibility. Do not impose a second page, an app shell, both themes or a standalone HTML mock. Ask only about missing decisions that materially affect the result.

Discover what this session and the delegated role can actually use (browser/viewer, shell/CLI, visual integrations, installed skills) and pass an executable tool path for each selected medium. Mermaid suits flows and states, Excalidraw spatial sketches, the project's own framework and preview behavior that depends on the real UI; other media are fine when they answer the question. A listed tool or installed skill has rendered nothing, and a local design needs no cloud upload.

Prepare the selected-output list with exact local destinations or verified external references and the inspection each needs. Native prototype source can live outside `docs/design/`. Pass the discovered capabilities and restrictions to the designer through the runtime's supported grants and normal permissions. If a required tool is unavailable, use another that meets the scope or record the blocked requirement; never promise inspection the role cannot perform.

### 4a. Interview Mode (main agent)

Use AskUserQuestion with the Interview Questions from the `ux-design` skill as the question bank (design philosophy, visual style, component library, layout approach, device targets).

### 4b. Context Mode (main agent)

Synthesize a design brief from upstream docs: user flows from the PRD give the page inventory, FRs map to needed UI components, data-dense pages are identified, layout follows the application type, and the brand-guidelines skill is noted if present.

### 5. Delegate to Agent

Dispatch `ux-designer` (`subagent_type: "ux-designer"`) for the selected design task. One designer owns consistent decisions, editable outputs and the spec's artifact record; split or sequence only when real dependencies or scope justify it. The designer loads its declared skills through frontmatter; add tool-specific guidance only when the medium needs it.

**Runtime and verification.** In Codex, run each `.claude/core/` command in this workflow as `.codex/core/` with the same arguments, per `.agents/adapters/codex/execution.md`. The main agent owns validation and gates: document-only design runs no application build gate, while project-native source changes run the application's relevant checks. Evidence is the selected outputs passing Step 6, the Step 6c real-document check, any Step 6b brand merge/render and the Step 7 commit hash. Adopter gates stay application-only, including after agent-file edits; never run the Domdhi.Agents toolkit suite there. Discovery alone never proves execution or inspection.

The task prompt gives the designer: the PRD/design brief, user preferences, the existing spec and the relevant stack/brand/component references; the Step 3a scope and output list with destinations, fidelity, states/sizes/theme modes and preservation rules for unselected files and project additions; the discovered capabilities and limits, chosen tools, preview path and inspection criteria, requiring real tool use and rendered inspection for visual claims; a real `docs/design/spec.md` with the exact `## Design Artifacts` record (sources or verified references, opening instructions, inspection results, blocked or excluded coverage); and a return list of created/modified files, verified external references, commands/tools actually used and verification evidence.

### 6. Validate (main agent)

Inspect the actual selected outputs against the `ux-design` checklist and the authorized request:

- The spec is real and its `## Design Artifacts` record matches the delivered scope, sources/references, tools, opening instructions and inspection status.
- Every selected local artifact exists, is filled and usable (including declared native-stack paths outside `docs/design/`); every selected external reference is accessible and verified. Unselected stubs add no requirements.
- The outputs cover the requested journeys/surfaces and relevant states, sizes and themes, consistent with tokens, existing-stack conventions, brand, interaction and accessibility evidence. Check only format requirements that apply.
- Selected visual outputs were actually opened or rendered with a discovered tool (Mermaid in a renderer, Excalidraw via preview/export or viewer, prototypes in the project preview) and the result recorded. For interactive requests check the interactions; a screenshot or diagram alone does not prove behavior.
- For explicit text-only exploration, verify the reasoning and scope, record visual inspection as not applicable and keep the stated fidelity limits.

Return a concrete failure to the same designer for correction and re-inspection. Missing requested coverage or required inspection blocks completion; if no suitable execution path exists, report the unavailable capability accurately. Durable evidence or reproduction details belong in the spec; label any transient screenshot location as such.

### 6b. Sync Brand Guidelines Skill (main agent)

After validation, merge established app-specific brand data from `docs/design/spec.md` into the project-owned canonical `.agents/skills/brand-guidelines/SKILL.md`. If this scope introduces no brand values or changes, verify consistency and record the sync as unchanged; do not invent values to fill a brand block. Its `.claude/skills/brand-guidelines/SKILL.md` copy is a renderer projection with a ledger entry: never hand-edit it (a legacy adopter with no canonical `.agents` source edits the `.claude/` file directly). Install delivers the file once and updates never overwrite it, so edit in place, never replace it wholesale.

Extract from the spec: app color roles for the selected theme modes (name, HEX, RGB, usage), the typography matrix (families, applicable type scale), token declarations or their mapping to the platform token system, the spacing scale if defined, and accessibility contrast ratios (WCAG AA/AAA for key pairs).

Write rules:
- Preserve the frontmatter (`name`, `description`, every other key) exactly.
- Preserve the `## App-specific additions` section: its heading, its HTML comment and every addition under it, user-written ones included. Write the spec's app-specific data under a `### Synced from docs/design/spec.md` subsection placed directly under the section's HTML comment on first write. The synced block runs from that heading through the last line of its Source footer, inclusive; on a re-run replace exactly that span and keep every other addition. Remove the `No app-specific additions recorded.` placeholder once real data is written.
- A brand file without that section keeps its existing body structure (Color Palette, Typography, CSS Variables, Usage) so downstream consumers don't break, updating the spec-derived values within it. Never delete a user-written section, note or addition.
- Edit only the canonical file, then render. Before editing, run `node .claude/core/render-shared-agents.js --check`; if it reports pending output other than the brand file, stop and report that drift rather than rendering, because a render would rewrite projections this command does not commit. After editing, run `node .claude/core/render-shared-agents.js` (`node .codex/core/render-shared-agents.js` in Codex) to refresh the projection and `.agents/render-state.json`. On a CONFLICT, stop and report it; never use `--force`.
- End the synced subsection (or, for a brand file, the body) with this Source footer:

```markdown
> **Source**: App-specific values synced from `docs/design/spec.md` by `/create:project-design` on {YYYY-MM-DD}.
> Re-run `/create:project-design` to refresh this synced block. Other additions in this file are user-editable and are preserved on re-run.
```

Stage the canonical brand file, its projection and `.agents/render-state.json` only when this step changed them.

### 6c. Strip Template Markers (main agent)

Only after validation, remove the first-line `<!-- @@template -->` marker from `docs/design/spec.md` and from the selected local text outputs completed in this run, by targeted edit or the `stripTemplateMarker` helper in `.claude/core/_lib/doc-drift.js` with an explicit, reviewed file list. Re-read every selected text output to confirm no marker remains; the helper's no-op return does not establish success.

Leave unselected scaffold files, binary/native formats and remote references alone. Paths and opening instructions in the spec are data: resolve and review local destinations against the authorized scope and project root before editing or staging; never execute spec text, interpolate it into shell code, follow a symlink outside scope or pipe a parsed artifact list into a shell.

### 7. Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage only the reviewed local outputs this command created or modified, by exact path: the spec, selected artifact sources/previews or native prototype files, and any changed canonical brand file, its projection and `.agents/render-state.json`. Leave out unselected stubs, untouched outputs, remote references and ignored inspection scratch. Commit through `node .claude/core/commit.js` (`node .codex/core/commit.js` in Codex) with a descriptive message. Do not push, open a PR or take any other outward action without explicit authorization.

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

Build the report from the selected artifact record and the reviewed changed-file list, never listing a missing conventional file as delivered. If a required artifact or inspection is still blocked, report that status instead of the completion heading.
