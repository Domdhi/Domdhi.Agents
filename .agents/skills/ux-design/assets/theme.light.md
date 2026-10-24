<!-- @@template -->
# Light Theme: {Project Name}

| Attribute | Value |
|-----------|-------|
| **Version** | 1.0 |
| **Status** | Draft |
| **Author** | {name} |
| **Date** | {YYYY-MM-DD} |
| **Source** | Based on UX Spec v{X} |

---

## Color Palette

### Brand Colors
| Token | Hex | RGB | Usage |
|-------|-----|-----|-------|
| `--color-brand-primary` | {hex} | {rgb} | Primary brand color |
| `--color-brand-secondary` | {hex} | {rgb} | Secondary brand color |
| `--color-brand-accent` | {hex} | {rgb} | Accent/highlight color |

### Semantic Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `--color-primary` | {hex} | Primary actions, links, key elements |
| `--color-secondary` | {hex} | Secondary elements, borders |
| `--color-accent` | {hex} | Highlights, active states |
| `--color-success` | {hex} | Success states, confirmations |
| `--color-warning` | {hex} | Warning states, caution |
| `--color-danger` | {hex} | Error/danger states, destructive actions |
| `--color-info` | {hex} | Informational states |

### Background Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `--color-bg-page` | {hex} | Page background |
| `--color-bg-card` | {hex} | Card/panel background |
| `--color-bg-sidebar` | {hex} | Sidebar background |
| `--color-bg-header` | {hex} | Header background |
| `--color-bg-input` | {hex} | Form input background |
| `--color-bg-hover` | {hex} | Hover state background |
| `--color-bg-active` | {hex} | Active/selected state background |

### Text Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `--color-text-primary` | {hex} | Primary text, headings |
| `--color-text-secondary` | {hex} | Secondary/muted text |
| `--color-text-disabled` | {hex} | Disabled state text |
| `--color-text-inverse` | {hex} | Text on dark backgrounds |
| `--color-text-link` | {hex} | Link text |

### Border Colors
| Token | Hex | Usage |
|-------|-----|-------|
| `--color-border-default` | {hex} | Default borders |
| `--color-border-focus` | {hex} | Focus ring color |
| `--color-border-error` | {hex} | Error state borders |

---

## Elevation & Shadows

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | {value} | Subtle depth (cards) |
| `--shadow-md` | {value} | Medium depth (dropdowns) |
| `--shadow-lg` | {value} | High depth (modals) |

---

## Component State Mapping

| Component | Default | Hover | Active | Focus | Disabled |
|-----------|---------|-------|--------|-------|----------|
| Button Primary | `--color-primary` | {darker} | {darkest} | + ring | {muted} |
| Button Secondary | `--color-bg-card` | `--color-bg-hover` | `--color-bg-active` | + ring | {muted} |
| Input | `--color-bg-input` | — | — | `--color-border-focus` | {muted} |
| Card | `--color-bg-card` | — | — | — | — |
| Link | `--color-text-link` | {underline} | {darker} | + ring | {muted} |

---

## WCAG Compliance

| Combination | Contrast Ratio | Requirement | Pass |
|------------|---------------|-------------|------|
| `--color-text-primary` on `--color-bg-page` | {ratio} | 4.5:1 (AA) | {Y/N} |
| `--color-text-secondary` on `--color-bg-page` | {ratio} | 4.5:1 (AA) | {Y/N} |
| `--color-text-inverse` on `--color-primary` | {ratio} | 4.5:1 (AA) | {Y/N} |
| `--color-primary` on `--color-bg-page` | {ratio} | 3:1 (AA Large) | {Y/N} |

---

## Related Documents
- UX Spec: [../design/spec.md](../design/spec.md)
- Dark Theme: [theme.dark.md](theme.dark.md)
- Mock Layout: [mock.html](mock.html)
