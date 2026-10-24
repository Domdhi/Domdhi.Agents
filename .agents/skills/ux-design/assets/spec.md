<!-- @@template -->
# UX Design Specification: {Project Name}

| Attribute | Value |
|-----------|-------|
| **Version** | 1.0 |
| **Status** | Draft |
| **Author** | {name} |
| **Date** | {YYYY-MM-DD} |
| **Source** | Based on PRD v{X} |

---

## 1. Design Philosophy

{2-3 sentences describing the overall design approach. Examples: "Cockpit-style data density", "Minimal and focused", "Playful and approachable"}

### Design Principles
1. **{Principle}**: {explanation}
2. **{Principle}**: {explanation}
3. **{Principle}**: {explanation}

---

## 2. Typography

| Role | Font | Weight | Size | Line Height |
|------|------|--------|------|-------------|
| H1 | {font} | {weight} | {size} | {lh} |
| H2 | {font} | {weight} | {size} | {lh} |
| H3 | {font} | {weight} | {size} | {lh} |
| Body | {font} | {weight} | {size} | {lh} |
| Caption | {font} | {weight} | {size} | {lh} |
| Code | {monospace font} | {weight} | {size} | {lh} |

---

## 3. Layout System

### Shell Structure
```
+----------------------------------------------------------+
|  [Logo]           Navigation Bar              [User Menu] |
+----------------------------------------------------------+
|        |                                                  |
| Sidebar|              Main Content                        |
|        |                                                  |
|  Nav   |  +------------------------------------------+   |
|  Items |  |                                          |   |
|        |  |         Content Area                     |   |
|        |  |                                          |   |
|        |  +------------------------------------------+   |
|        |                                                  |
+----------------------------------------------------------+
|                     Footer                                |
+----------------------------------------------------------+
```

### Grid System
- **Container**: {max-width, padding}
- **Columns**: {grid system — 12-col, etc.}
- **Gutter**: {spacing between columns}
- **Breakpoints**:
  - Mobile: {px}
  - Tablet: {px}
  - Desktop: {px}
  - Wide: {px}

### Spacing Scale
| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | {value} | {usage} |
| `--space-sm` | {value} | {usage} |
| `--space-md` | {value} | {usage} |
| `--space-lg` | {value} | {usage} |
| `--space-xl` | {value} | {usage} |

---

## 4. Component Inventory

### Core Components
| Component | Variants | Usage |
|-----------|----------|-------|
| Button | Primary, Secondary, Ghost, Danger | Actions |
| Card | Standard, Compact, Interactive | Content containers |
| Table/DataGrid | Sortable, Filterable, Virtual scroll | Data display |
| Form Field | Text, Select, Checkbox, Radio, Date | Data input |
| Modal/Dialog | Standard, Confirmation, Full-screen | Overlays |
| Toast/Notification | Info, Success, Warning, Error | Feedback |
| Navigation | Sidebar, Tabs, Breadcrumbs | Wayfinding |

### Component States
All interactive components must define: Default, Hover, Active, Focus, Disabled, Loading, Error

---

## 5. Interaction Patterns

### Navigation
- {How users move between sections}

### Data Entry
- {Form validation timing — on blur, on submit, real-time}
- {Error display — inline, toast, summary}
- {Auto-save behavior}

### Data Display
- {Loading states — skeleton, spinner, progressive}
- {Empty states — illustration, call-to-action}
- {Error states — retry, fallback}

### Feedback
- {Success confirmation — toast, redirect, inline}
- {Error messaging — specificity, recovery actions}
- {Progress indicators — determinate, indeterminate}

---

## 6. Responsive Behavior

| Breakpoint | Layout Changes |
|------------|---------------|
| Mobile (<{px}) | {what changes} |
| Tablet ({px}-{px}) | {what changes} |
| Desktop (>{px}) | {what changes} |

---

## 7. Accessibility

- **Target**: WCAG {2.1 AA / 2.1 AAA}
- **Color Contrast**: Minimum {4.5:1} for text, {3:1} for large text
- **Keyboard Navigation**: All interactive elements reachable via Tab
- **Screen Reader**: All images have alt text, forms have labels
- **Focus Indicators**: Visible focus ring on all interactive elements
- **Motion**: Respect `prefers-reduced-motion`

---

## Related Documents
- PRD: [../product/requirements.md](../product/requirements.md)
- Wireframes: [wireframes.md](wireframes.md)
- Light Theme: [theme.light.md](theme.light.md)
- Dark Theme: [theme.dark.md](theme.dark.md)
- Mock Layout: [mock.html](mock.html)
- Architecture: [../architecture/overview.md](../architecture/overview.md)
