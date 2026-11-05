<!-- @@template -->
# Dark Theme: {Project or Surface Name}

| Attribute | Value |
|---|---|
| Version / status | {version} / {status} |
| Author / date | {name} / {YYYY-MM-DD} |
| Design entry point | [spec.md](spec.md) |
| Coverage | {selected surfaces, states and sizes} |

This optional reference can describe a dark-only design. Preserve the project's token format, approved brand and existing theme behavior. A light-theme document is not a prerequisite. Omit unused roles/regions.

## Design Notes

{Explain surface separation, hierarchy, semantic feedback and elevation for this product. Choose colors for the actual environment and contrast requirements rather than blindly inverting another palette. When other modes are selected, retain equivalent semantic roles and component behavior.}

## Semantic Token Mapping

| Semantic role | Existing platform token / definition | Dark value | Usage / relation to other selected modes |
|---|---|---|---|
| Primary action / on-action text | {verified token paths} | {values} | {action and foreground pair} |
| Page / raised surface | {verified token paths} | {values} | {selected surfaces and elevation} |
| Primary / secondary text | {verified token paths} | {values} | {text hierarchy} |
| Border / visible focus | {verified token paths} | {values} | {boundaries and focus treatment} |
| Success / warning / danger | {verified token paths} | {values} | {feedback with non-color cues} |

## Typography, Spacing and Elevation

{Reference existing type/spacing tokens. Describe applicable surface/border/shadow treatments for cards and overlays; do not add unused application regions.}

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

{Link only selected, existing companions or verified external artifacts. A light-theme companion is optional.}
