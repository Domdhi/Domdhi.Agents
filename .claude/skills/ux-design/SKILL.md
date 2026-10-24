---
name: ux-design
description: "Use WHEN creating a UX specification, wireframes, design system, theme files, or HTML mock layout. Triggers: ux, wireframe, design system, color palette, typography, layout, accessibility, theme, mock"
metadata:
  version: 1.1.0
  author: Domdhi.Agents
  tags: [ux, wireframes, design-system, accessibility, themes, mock-layout]
user-invocable: false
allowed-tools: Read Write Grep Glob
---

<!-- Generated from .agents/skills/ux-design/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# UX Design

Expert in UX specification documents. Produces a complete design artifact suite: design system spec, wireframes (ASCII), theme files (light/dark), interaction patterns, accessibility guidelines, and self-contained HTML mock layouts.

**ASCII wireframes are the fast sketch; the HTML mock is the high-fidelity deliverable.** Use ASCII to think through layout in-doc. Produce a self-contained, browser-openable `mock.html` as the primary visual artifact — especially when the project's stack is HTML/CSS, where the mock is most of the real implementation. The mock covers either a full **application shell** OR a **focused single screen/component** (a popup, panel, modal, card): match its scope to the request, and don't force the full app grid onto a single-component mock. Skipping the full multi-file design suite for a small surface (a redesign, one popup) does **not** mean skipping the HTML mock — a targeted single-component mock is often the single highest-value artifact for that work.

## Output Files

| File | Description |
|------|-------------|
| `docs/design/spec.md` | Design system, principles, component inventory, interaction patterns |
| `docs/design/wireframes.md` | ASCII wireframes for all key pages |
| `docs/design/theme.light.md` | Light theme color palette and semantic tokens |
| `docs/design/theme.dark.md` | Dark theme color palette and semantic tokens |
| `docs/design/mock.html` | Self-contained HTML mock — full application shell, or a focused single screen/component (popup, panel, modal) |

**Templates** (load only the one you're producing — `assets/`, per the Agent Skills spec):

| Producing… | Load |
|------------|------|
| UX spec (`design/spec.md`) | `assets/spec.md` |
| Wireframes (`wireframes.md`) | `assets/wireframes.md` |
| Light theme (`theme.light.md`) | `assets/theme.light.md` |
| Dark theme (`theme.dark.md`) | `assets/theme.dark.md` |
| Mock layout (`mock.html`) | `assets/mock.html` |

## Project stack and brand

Read the project’s own `brand-guidelines` before choosing colors, typography or logos. Unfilled scaffold placeholders are not approved brand values. Keep the existing component library and styling system; verify component APIs and token names against the installed versions before using them.

## Required Sections Checklist

### UX Spec (`design/spec.md`)
- [ ] Design Philosophy (clear, opinionated principles)
- [ ] Typography scale (H1-Body minimum)
- [ ] Layout System (shell structure + grid + spacing)
- [ ] Component Inventory (core components with variants)
- [ ] Interaction Patterns (navigation, data entry, feedback)
- [ ] Responsive Behavior (breakpoints with specific changes)
- [ ] Accessibility requirements (WCAG level, contrast, keyboard)

### Wireframes (`wireframes.md`)
- [ ] Page inventory table
- [ ] Navigation flow diagram
- [ ] At least 2 page wireframes (ASCII art)
- [ ] Desktop AND mobile layout for primary pages
- [ ] Purpose, entry points, and key interactions per page

### Light Theme (`theme.light.md`)
- [ ] Brand colors defined
- [ ] Semantic color tokens (primary, success, warning, danger)
- [ ] Background color hierarchy
- [ ] Text color scale (primary, secondary, disabled)
- [ ] Component state mapping
- [ ] WCAG contrast compliance table

### Dark Theme (`theme.dark.md`)
- [ ] All light theme tokens mapped to dark equivalents
- [ ] Surface elevation strategy (lighter surfaces, not shadows)
- [ ] WCAG contrast compliance verified for dark backgrounds
- [ ] Design notes explaining dark-mode principles

### Mock Layout (`mock.html`)
- [ ] Self-contained (inline CSS, no external dependencies)
- [ ] Uses CSS custom properties matching theme tokens
- [ ] Scope matches the request: full **app shell** matches UX spec layout, OR a **single screen/component** (popup, panel, modal, card) is mocked on its own — sized to the real surface, not wrapped in an unrelated app grid
- [ ] For a component mock: shows the relevant states where they fit (e.g. default + empty/error) and the real dimensions (e.g. a 300px popup is mocked at 300px)
- [ ] Responsive (at least mobile + desktop breakpoints, where applicable to the surface)
- [ ] Representative placeholder content
- [ ] Renders correctly in modern browsers

## Quality Criteria

### Good Design Suite
- All 5 files are internally consistent (same tokens, same layout)
- Color tokens use semantic names (`--color-danger`) not raw values
- Wireframes use ASCII art (no external tools needed)
- Mock layout opens in any browser without dependencies
- Dark theme is derived from light theme systematically
- WCAG compliance is verified for both themes

### Bad Design Suite
- Files reference different color values
- No semantic token naming
- Mock layout requires external CSS frameworks
- Wireframes missing or "see Figma"
- Dark theme is a separate design with no light-theme relationship
- No accessibility verification

## Interview Questions

1. "What's the overall feel? (professional, playful, minimal, data-dense)"
2. "What approved brand values and existing design language should this use?"
3. "What devices/screen sizes matter most?"
4. "Any accessibility requirements? (WCAG level, audience needs)"
5. "What's the most important page/view in the app?"
6. "Any design inspirations or anti-inspirations?"
7. "Light mode, dark mode, or both?"
8. "What UI component library and version does the app already use? (or building custom)"

## Cross-References
- Reads from: `docs/product/requirements.md` (required)
- Produces: `docs/design/spec.md`, `docs/design/wireframes.md`, `docs/design/theme.light.md`, `docs/design/theme.dark.md`, `docs/design/mock.html`
- Feeds into: `docs/architecture/overview.md` (component decisions)
