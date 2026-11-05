<!-- @@template -->
# UX Design Specification: {Project or Surface Name}

| Attribute | Value |
|---|---|
| Version / status | {version} / {status} |
| Author / date | {name} / {YYYY-MM-DD} |
| Requirements source | {PRD version or focused task reference} |

Use this scaffold for project design; scale its sections to the selected scope. Reference existing foundations for a focused change. Remove unrelated rows/sections rather than inventing pages, components or themes.

## Scope and User Goal

{User outcome, entry points, requested surfaces, fidelity and relevant recovery paths. State intentional exclusions.}

## Design Artifacts

| Selected artifact / editable source or verified reference | Scope and relevant states | Sizes / viewports | Theme coverage | Chosen tool and reason |
|---|---|---|---|---|
| {real source path and preview/export path, or verified external reference} | {surface, journey and relevant states} | {actual dimensions or relevant sizes} | {requested modes or not applicable} | {tool and why it fits} |

| Artifact | Open / reproduce | Rendered inspection evidence and status | Interaction evidence | Limitations |
|---|---|---|---|---|
| {selected artifact} | {verified opening steps, preview command, renderer/version or access requirements} | {viewer/method, date, sizes/themes inspected, evidence path/reference, result or unverified status} | {observed checks and result, or not claimed} | {fidelity, capability/access gaps, pending checks} |

For text-only scope, record rendered inspection as not applicable and explain why. For visual scope, inspect the rendered result; source review or a successful export command alone does not prove appearance. A diagram or screenshot does not establish working interactions. If inspection is blocked, record the attempted path and exact limitation without claiming completion. Preserve editable sources. Link only selected artifacts that exist or external references verified with authorized access.

## Design Philosophy

{Clear direction and principles tied to the user task and approved brand.}

## Typography and Tokens

{Reference the existing platform token definitions, or define the needed semantic roles. Separate theme documents are optional.}

| Role / token | Existing definition or value | Usage |
|---|---|---|
| {type role / token} | {verified source or value} | {hierarchy and readability} |
| {spacing / color role} | {verified source or value} | {usage} |

## Layout System

{Describe the selected surface and reference its inspected layout artifact. Include a shell only when the requested scope needs one.}

| Constraint | Decision |
|---|---|
| Surface dimensions / container | {real dimensions, min/max width and padding} |
| Grid / spacing | {existing layout system or selected rules} |
| Responsive behavior | {specific changes at relevant sizes; bounded surface behavior if applicable} |

## Component Inventory and States

| Component / existing implementation | Relevant variants and states | Behavior / token references |
|---|---|---|
| {component} | {default, focus, disabled, empty, loading, error, overflow as applicable} | {verified API/tokens and behavior} |

## Interaction Patterns

{Navigation/entry and exit paths, input/validation timing, feedback and recovery for the selected task. Separate requirements from interactions actually observed in the artifact record.}

## Accessibility

| Requirement / check | Evidence or implementation requirement |
|---|---|
| Target standard | {project accessibility target} |
| Contrast | {measured foreground/background pairs, ratios and applicable threshold} |
| Keyboard / focus | {tab order, visible focus, focus return and observed or pending checks} |
| Semantics / labels | {names, roles, label/error association and screen-reader requirements} |
| Motion / touch | {reduced-motion behavior and target sizes where relevant} |

## Selected Companion References

{Link only actual selected companions and relevant existing requirements/architecture. Omit this section when the artifact record contains all needed references.}
