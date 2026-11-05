# Scene authoring and compatibility

Read this before generating or structurally editing scene JSON. Prefer the project's existing exporter and tooling; this skill adds no generator or runtime dependency.

## Use a verified format

Start from an export produced by the target editor, or inspect official source/types for the exact package/editor version being used. Record that version or source revision with the artifact's inspection evidence. Scene format version and npm package version describe different things.

The official [element creation API](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton) distinguishes simplified `ExcalidrawElementSkeleton` input from complete elements: call `convertToExcalidrawElements` before consuming skeletons as scene elements. Its default can regenerate IDs; use the documented ID-preserving option where required. Check the installed signature and browser requirements before writing a generator.

For direct JSON work, read the matching element types and serializer rather than treating examples as a universal schema. A local export carries scene metadata, elements, exportable app state and embedded files. Preserve fields the task does not change. A permissive renderer accepting an incomplete scene is not proof of a valid editable export.

These official source snapshots were checked at revision `7ded689cad49331167e29fd88b38f38d3736d576`; they are discovery references, not a compatibility promise for a different installed release:

- [Element types](https://github.com/excalidraw/excalidraw/blob/7ded689cad49331167e29fd88b38f38d3736d576/packages/element/src/types.ts) define fields, bindings and supported element kinds.
- [Skeleton conversion](https://github.com/excalidraw/excalidraw/blob/7ded689cad49331167e29fd88b38f38d3736d576/packages/element/src/transform.ts) defines accepted generation inputs.
- [Local serialization](https://github.com/excalidraw/excalidraw/blob/7ded689cad49331167e29fd88b38f38d3736d576/packages/excalidraw/data/json.ts) defines exported scene structure and retained files.

For another version, resolve its matching source. Follow actual repository paths when documentation links are stale. Avoid hand-written numeric font mappings or a frozen table of required properties.

## Preserve editability

1. Read the latest source and identify the target elements by ID and content. Keep a recoverable original using the project's existing version control or backup convention. If a live editor has unsaved changes, reconcile its current scene before overwriting disk output.
2. Patch only the requested content and directly affected geometry or references. Retain unrelated elements, ordering, groups, frames, links, custom data and embedded assets. Do not rebuild an existing scene from its screenshot.
3. Update bound text and connectors together using the verified API or format. Check unique IDs, finite coordinates, non-dangling references and image file references. Parse the saved JSON; import it into the compatible editor when available. A visual render alone does not demonstrate that dragging a shape retains its bindings.
4. Inspect the whole rendered scene plus detailed regions when a large overview makes labels unreadable. Confirm the final diff includes the requested edit and preserves the surrounding work.

For local CLI rendering, images must be embedded; external image URLs and live website embeds are not loaded. Use `excalidraw render --help` to confirm supported scale, size, theme and browser options. Preserve the source's theme unless the requested export requires another. [Official CLI rendering reference](https://github.com/excalidraw/cli/blob/v0.2.0/README.md#render-to-png).

## Provenance

This is independently authored toolkit guidance inspired by Cole Medin's [Excalidraw Diagram Skill](https://github.com/coleam00/excalidraw-diagram-skill/tree/8646fcc9f74f38539c6cdb4c969723336a96ddcd), reviewed at commit `8646fcc9f74f38539c6cdb4c969723336a96ddcd`. The useful ideas were matching visual structure to meaning and reviewing rendered output. No upstream prose, templates, palette, scripts or assets are bundled; no license declaration was present in the reviewed snapshot. Official Excalidraw documentation and versioned sources govern API and CLI details.
