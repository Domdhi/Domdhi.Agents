---
name: ux-design
description: "UX specifications and design artifacts. Use WHEN exploring user journeys, designing interfaces or components, creating wireframes/prototypes, or defining a design system and themes. Triggers: ux, wireframe, Mermaid, Excalidraw, prototype, design system, accessibility, theme, mock"
metadata:
  version: 1.2.0
  author: Domdhi.Agents
  tags: [ux, wireframes, prototypes, design-system, accessibility, themes]
user-invocable: false
allowed-tools: Read Write Grep Glob
---

<!-- Generated from .agents/skills/ux-design/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# UX Design

Choose design tools and artifacts for the question, requested scope, existing stack and discovered capabilities. Use the selected tool and inspect its result. A single component can need one visual with relevant states; a product design needs broader journey, component, responsive, accessibility and theme coverage. Neither a fixed five-file suite, two pages, ASCII, standalone HTML nor both themes is universal. Explicit text-only exploration is supported.

## Tool and artifact selection

First establish the user outcome, surfaces, relevant states, sizes, requested theme modes and required fidelity. Read the PRD for product design, the existing design/architecture and the project's `brand-guidelines`; for a focused request use the supplied requirements and existing context without inventing a product-wide exercise. Keep approved brand values, fonts, component libraries, styling and platform conventions. Unfilled brand placeholders are not approved values. Verify installed component APIs and token definitions before referencing them.

Discover tools in the active session: integrations, renderers/viewers, browser capabilities and project preview commands. A skill's `allowed-tools` preapproves its listed calls; it does not establish availability or restrict all other calls. Host/session permissions apply. Do not assume an integration exists or install tooling, connect an account, upload or publish solely to follow a recipe. If the preferred path is unavailable, choose a suitable available path and record the limitation.

| Design question | Candidate representation | Evidence and limits |
|---|---|---|
| User journey, navigation, state transitions or interaction sequence | Mermaid diagram | Save editable source and inspect a rendered diagram. It explains flow; it does not establish screen layout or working UI behavior. |
| Spatial exploration, annotated wireframe or collaborative layout discussion | Excalidraw; conditionally load `excalidraw-diagram` | Preserve editable source plus inspected preview/export or a verified shared artifact. Record fidelity and access requirements. |
| Layout, responsive behavior or interaction using existing components | Project-native prototype in the existing framework/component stack | Use the real preview path, relevant sizes/states and actual interaction checks. Avoid duplicating the UI in standalone HTML or a new styling system. |
| Portable mock, vector diagram or visual asset | Standalone HTML, SVG, raster or an available visual design tool | Select the medium for the handoff; inspect it in a suitable renderer/viewer. An image proves appearance only. |
| Explicit text-only exploration | Written flows or text/ASCII sketches | Persist the requested exploration; mark rendered inspection not applicable and make no visual/interaction completion claim. |

The official `@mermaid-js/mermaid-cli` (`mmdc`) and `@excalidraw/cli` (`excalidraw render`) are local rendering options when available and permitted. Read installed help or current official documentation before invoking them; do not guess API syntax. An available host viewer/integration may also fit. For frontend output conditionally load `design-taste-frontend`, applying it within the project's stack; load `redesign-existing-projects` for a refresh, `playwright-cli` for available browser inspection, and Tailwind guidance only in an existing Tailwind project. If a suitable image-generation skill/tool is discovered, use it for needed raster assets, not as proof of an editable or interactive UI.

## Design entry point and optional templates

For project design, keep `docs/design/spec.md` as the design entry point, proportionate to the request. Its exact heading `## Design Artifacts` is the handoff contract for workflows and readiness. Record:

- Selected editable source/artifact paths or verified external references, and the scope each covers.
- Relevant states, sizes/viewports and theme coverage, including intentional exclusions.
- Chosen tool and why it fits; versions or environment details needed for reproduction.
- How to open/reproduce each artifact, including project-native preview commands or access requirements.
- Rendered inspection method, evidence, results/status and limitations; interaction checks separately when claimed.

A standalone diagram/component request can use the requested output and a concise artifact/inspection handoff without creating a PRD or product spec. When incorporated into project design, add its record to the existing spec. For text-only work, record that scope and why visual inspection is not applicable. For visual work, required rendered inspection cannot be replaced by source review, a renderer exit code or a bare external link. If rendering/viewing is blocked, record the attempted path, exact capability limit and unverified status; do not report visual completion. Verify external references can be opened with the available authorized access.

**Document templates:** load only the template for a selected output. `assets/spec.md` is the project-design entry-point scaffold. The other assets are optional recipes, not required companions:

| Selected output | Template |
|---|---|
| Layout/wireframe notes with source/export references | `assets/wireframes.md` |
| Separate light-theme reference, if useful | `assets/theme.light.md` |
| Separate dark-theme reference, if useful | `assets/theme.dark.md` |
| Portable standalone HTML mock | `assets/mock.html` |

Existing scaffold stubs do not select themselves. Preserve unselected files and project additions. Link only selected companions that actually exist or verified external artifacts. Remove the leading template marker only from filled deliverables. Token guidance can live in the spec or the existing platform token system; separate theme files are optional, and a dark-only request does not require a light theme.

## Required outcomes checklist

Apply each item to the selected scope; record reasons for non-applicable areas rather than creating unrelated pages or components.

- [ ] User goal, entry points, primary task and relevant recovery/empty/loading/error/overflow states are clear.
- [ ] Project-design handoffs have a filled `## Design Artifacts` record in `docs/design/spec.md` with the selected source, tool, coverage, opening instructions and inspection status. Standalone work carries equivalent concise handoff evidence.
- [ ] Visual artifacts are rendered and visually inspected at the relevant sizes and theme modes; labels, clipping, hierarchy and readability are checked and corrected.
- [ ] Interaction claims are backed by observed behavior in an interactive artifact; keyboard/focus, navigation, input validation and recovery are checked where relevant. A diagram/screenshot is not interaction evidence.
- [ ] Layout, components, typography and semantic tokens fit the existing design system. Focused work references existing foundations; a full product design defines the needed inventory, type/spacing scales and layout rules.
- [ ] Responsive/platform behavior is specified for applicable sizes, with real dimensions for a bounded component; no unrelated shell or second page is required.
- [ ] Accessibility requirements include applicable contrast measurements, visible focus, keyboard order/semantics, labels and reduced motion. Distinguish measured/observed checks from requirements awaiting implementation.
- [ ] Requested themes share semantic roles and have verified contrast for their actual foreground/background pairs; no unrequested theme is implied.
- [ ] Selected artifacts agree on tokens, terminology, content and interaction rules; the handoff records remaining limitations accurately.

## Quality criteria

Good output answers the design question, preserves editable sources, fits project conventions, covers the relevant states and is inspectable by the recipient. Rendered inspection records what was actually seen and at which sizes/themes. A verified external artifact is valid; a source-only diagram or inaccessible "see Figma" link is insufficient evidence of a rendered visual. A full product design still needs journeys, components, responsive behavior, accessibility and consistent tokens regardless of medium.

Bad output selects formats before the question, adds unused pages/themes, treats a scaffold as finished, invents tool/component APIs, replaces native components with a redundant mock, or claims an interaction works from a picture. Correct issues found during inspection and inspect again before claiming completion.

## Interview questions

Use existing context first; ask only for material gaps.

1. What task and surface should this design resolve, and is the request visual, interactive or explicitly text-only?
2. Which approved brand, existing components and preview path should it use?
3. Which devices/sizes, states and theme modes matter?
4. What fidelity/editability does the recipient need, and how will they open the result?
5. What accessibility requirements, inspirations or constraints change the direction?

## Cross-references

- Reads: `docs/product/requirements.md` for product design; existing design, architecture and task requirements as applicable.
- Produces: `docs/design/spec.md` for project design plus only selected artifacts, which may live in `docs/design/`, the project's native source/example locations, or verified external tools.
- Feeds: implementation and `docs/architecture/overview.md` component decisions through the project spec's artifact record.
