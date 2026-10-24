<!-- @@template -->
# Dark Theme: {Project Name}

| Attribute | Value |
|-----------|-------|
| **Version** | 1.0 |
| **Status** | Draft |
| **Author** | {name} |
| **Date** | {YYYY-MM-DD} |
| **Source** | Based on UX Spec v{X}, Light Theme v{X} |

---

## Design Notes

Dark theme is derived from the light theme with these principles:
- Backgrounds use dark surfaces (not pure black — use `#121212` or similar)
- Text lightens to maintain contrast
- Semantic colors may shift saturation/brightness for dark backgrounds
- Elevation is conveyed through lighter surfaces, not shadows

---

## Color Palette

### Semantic Colors
| Token | Light Value | Dark Value | Notes |
|-------|------------|------------|-------|
| `--color-primary` | {light hex} | {dark hex} | {adjustment notes} |
| `--color-secondary` | {light hex} | {dark hex} | {adjustment notes} |
| `--color-accent` | {light hex} | {dark hex} | {adjustment notes} |
| `--color-success` | {light hex} | {dark hex} | {adjustment notes} |
| `--color-warning` | {light hex} | {dark hex} | {adjustment notes} |
| `--color-danger` | {light hex} | {dark hex} | {adjustment notes} |
| `--color-info` | {light hex} | {dark hex} | {adjustment notes} |

### Background Colors
| Token | Light Value | Dark Value | Notes |
|-------|------------|------------|-------|
| `--color-bg-page` | {light hex} | {dark hex} | Base surface |
| `--color-bg-card` | {light hex} | {dark hex} | Elevated surface |
| `--color-bg-sidebar` | {light hex} | {dark hex} | Navigation surface |
| `--color-bg-header` | {light hex} | {dark hex} | Top bar surface |
| `--color-bg-input` | {light hex} | {dark hex} | Input fields |
| `--color-bg-hover` | {light hex} | {dark hex} | Hover state |
| `--color-bg-active` | {light hex} | {dark hex} | Active/selected |

### Text Colors
| Token | Light Value | Dark Value | Notes |
|-------|------------|------------|-------|
| `--color-text-primary` | {light hex} | {dark hex} | Primary text |
| `--color-text-secondary` | {light hex} | {dark hex} | Muted text |
| `--color-text-disabled` | {light hex} | {dark hex} | Disabled text |
| `--color-text-inverse` | {light hex} | {dark hex} | On colored bg |
| `--color-text-link` | {light hex} | {dark hex} | Links |

### Border Colors
| Token | Light Value | Dark Value | Notes |
|-------|------------|------------|-------|
| `--color-border-default` | {light hex} | {dark hex} | Default borders |
| `--color-border-focus` | {light hex} | {dark hex} | Focus ring |
| `--color-border-error` | {light hex} | {dark hex} | Error borders |

---

## Elevation & Shadows

In dark mode, elevation is conveyed through surface lightness rather than shadows:

| Level | Surface Color | Shadow | Usage |
|-------|--------------|--------|-------|
| Base (0) | `--color-bg-page` | none | Page background |
| Raised (1) | {hex} | subtle | Cards, panels |
| Overlay (2) | {hex} | medium | Dropdowns, popovers |
| Modal (3) | {hex} | strong | Modals, dialogs |

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
- Light Theme: [theme.light.md](theme.light.md)
- Mock Layout: [mock.html](mock.html)
