---
name: brand-guidelines
description: "Use WHEN applying project brand colors, typography, or visual identity to any output — dashboards, reports, emails, presentations, or web components."
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [brand, colors, typography, visual-identity, design-system]
user-invocable: false
allowed-tools: Read Write Edit Grep Glob
---

# Brand Guidelines

## Overview

Official brand identity for this project. Use this skill when generating any visual output — web components, dashboards, reports, emails, presentations, or documents — that should carry the project's look and feel.

**To customize:** Replace the placeholder values below with your project's actual brand colors, typography, and logo rules. This skill is referenced by `/create:project-design` and the `ux-design` skill when generating design specs.

---

## Color Palette

### Primary Colors

| Name | HEX | RGB | Usage |
|------|-----|-----|-------|
| **Primary** | `#000000` | 0, 0, 0 | Primary brand color — buttons, links, headers, nav |
| **Accent** | `#000000` | 0, 0, 0 | CTA accent — action buttons, links |
| **Text** | `#000000` | 0, 0, 0 | Body text |
| **Background** | `#FFFFFF` | 255, 255, 255 | Page backgrounds |

### Secondary Colors

| Name | HEX | RGB | Usage |
|------|-----|-----|-------|
| **Light Primary** | `#000000` | 0, 0, 0 | Hover states, layered depth |
| **Light Accent** | `#000000` | 0, 0, 0 | Soft highlights |

### Color Rules

- **Primary** is the dominant brand color — use for structure (headers, nav, sections, footers)
- **Accent is CTA only** — never structural. Only for action triggers (buttons, links)
- **Secondary colors** layer on primaries for depth and hover states

---

## Typography

### Font Family

| Role | Font | Weight | Color |
|------|------|--------|-------|
| **Headline** | {Font} | 700 | Primary |
| **Subhead** | {Font} | 600 | Primary |
| **Body** | {Font} | 400 | Text |
| **Code** | {Mono Font} | 400 | Text |

### Fallback Font Stack

```css
font-family: {Font}, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

---

## CSS Variables Template

```css
:root {
  /* Primary */
  --brand-primary: #000000;
  --brand-accent: #000000;
  --brand-text: #000000;
  --brand-bg: #FFFFFF;

  /* Secondary */
  --brand-light-primary: #000000;
  --brand-light-accent: #000000;

  /* Typography */
  --font-primary: '{Font}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: '{Mono Font}', 'JetBrains Mono', monospace;
  --color-heading: var(--brand-primary);
  --color-body: var(--brand-text);
}
```

---

## Usage

This skill is a **template**. To activate it for your project:

1. Replace all `{Font}` and `#000000` placeholders with your actual brand values
2. Add logo rules, photo guidelines, and layout patterns as needed
3. The `/create:project-design` command will reference this skill when generating design specs
