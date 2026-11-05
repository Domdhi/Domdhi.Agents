---
name: excalidraw-diagram
description: "Editable Excalidraw scenes. Use WHEN creating or revising .excalidraw files, spatial sketches, annotated flows, or diagrams whose layout needs manual editing. Triggers: Excalidraw, editable diagram, whiteboard sketch, scene JSON."
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [excalidraw, diagrams, visual-design, editable-artifacts]
user-invocable: false
allowed-tools: Read Write Edit Bash Grep Glob
---

<!-- Generated from .agents/skills/excalidraw-diagram/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Excalidraw Diagrams

Create an editable scene and inspect its rendered appearance. Spatial grouping, direction and scale should explain the relationship the reader needs to understand.

## Choose the scope

Use Excalidraw for flexible placement, annotations and visual exploration. Mermaid suits text-maintained graphs; a project-native prototype suits interaction or responsive behavior. A scene file does not create a native chat widget or prove working UI behavior.

Read the supplied source, existing scene and relevant project brand guidance first. Match the audience and requested detail: a small overview does not need code samples, multiple pages or a complete design specification. Verify technical labels against project code or authoritative documentation; add concrete examples when they clarify the point.

## Author the editable source

- Give sequences a clear reading direction, branches distinct destinations and groups meaningful boundaries. Use containers for entities or grouping and free text for annotations; consistent shapes can represent equivalent things.
- Follow project colors and typography, within the editor's supported fonts. Otherwise choose a small, readable palette. Reinforce color with labels or line styles. Set density and roughness for this audience rather than enforcing a palette, font ID or container quota.
- Before writing scene JSON, read [scene authoring](references/scene-authoring.md). Use an editor export or version-matched official APIs/types; simplified element skeletons require conversion. Do not guess fields, bindings or font constants.
- Save the `.excalidraw` source in the relevant existing artifact directory, otherwise `docs/design/`. Keep text and shapes editable. For larger scenes, add coherent sections while keeping valid JSON.
- When editing, reread the current file and patch the requested elements. Preserve unrelated manual edits, IDs, layer order, groups, embedded files and metadata; maintain affected bindings. Review the diff before rendering.

## Render, inspect, fix

Discover the official CLI, its version/help, an installed compatible browser and an image-viewing capability before rendering. The [official CLI](https://github.com/excalidraw/cli/blob/v0.2.0/README.md) supports local PNG rendering without an account:

```bash
excalidraw --version
excalidraw render --help
excalidraw render docs/design/flow.excalidraw --out docs/design/flow.preview.png
```

CLI 0.2.0 uses installed Chrome, Chromium, Edge or Firefox; it does not download a browser. For an undiscovered executable, use the verified `--browser-path` option. For offline rendering use `--fonts-url none`; disclose visible font substitutions. Tool availability and skill tool declarations do not override host permissions. Do not automatically install packages, sign in, upload scenes or create accounts.

Open the resulting PNG with an available image viewer. Check the intended reading order, label legibility, clipping, overlaps, contrast and connector destinations at the intended viewing size. Fix source defects, then render and inspect again; stop when those checks pass. JSON parsing or a successful render command alone does not prove visual quality.

If CLI, browser or viewing capability is missing, use a discovered local alternative when suitable. Preserve the source and state exactly what inspection could not run; do not claim visual verification or silently upload it elsewhere.

## Deliver

Link the source and any preview; explain how to open the scene in a compatible Excalidraw editor. Record inspection method/results and remaining limitations. In a project design workflow, update `docs/design/spec.md` under `## Design Artifacts` with those links and opening instructions. A standalone diagram needs no PRD/spec scaffold.

Inspiration and source boundaries: [provenance](references/scene-authoring.md#provenance).
