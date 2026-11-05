<!-- @@template -->
# Light Theme: {Project or Surface Name}

| Attribute | Value |
|---|---|
| Version / status | {version} / {status} |
| Author / date | {name} / {YYYY-MM-DD} |
| Design entry point | [spec.md](spec.md) |
| Coverage | {selected surfaces, states and sizes} |

This optional reference is for a selected light theme. Use the project's existing token format and approved brand values; the semantic roles below do not require CSS custom properties or a separate dark-theme file. Omit unused roles/regions.

## Semantic Token Mapping

| Semantic role | Existing platform token / definition | Light value | Usage |
|---|---|---|---|
| Primary action / on-action text | {verified token paths} | {values} | {action and foreground pair} |
| Page / raised surface | {verified token paths} | {values} | {selected surfaces} |
| Primary / secondary text | {verified token paths} | {values} | {text hierarchy} |
| Border / visible focus | {verified token paths} | {values} | {boundaries and focus treatment} |
| Success / warning / danger | {verified token paths} | {values} | {feedback with non-color cues} |

## Typography, Spacing and Elevation

{Reference existing type/spacing tokens and the applicable elevation strategy. Define only foundations needed for the selected scope.}

## Component State Mapping

| Component | Relevant state | Foreground / background / border tokens | Non-color treatment |
|---|---|---|---|
| {component} | {default, hover, active, focus, disabled, loading or error} | {verified tokens} | {label, icon, underline, focus outline or other cue} |

## Contrast Verification

| Actual foreground / background pair and state | Measured ratio | Applicable threshold | Result / method |
|---|---|---|---|
| {pair} | {ratio} | {text, large text or non-text requirement} | {pass/fail and calculation method} |

## Rendered Inspection

{Selected artifact/source references, tool/open instructions, sizes and states viewed, evidence and results. Record limitations and pending checks; a palette table alone is not a rendered UI inspection. Keep the project spec's Design Artifacts record in sync.}

## Selected Companion References

{Link only selected, existing companions or verified external artifacts. A dark-theme companion is optional.}
