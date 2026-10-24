# Project additions to a template skill

Skills are **Template zone** — `template-updater`/`fleet:sync` overwrites them in every
adopter, so the template stays the single source of truth. The cost: any project-specific
guidance written *into* a template skill is clobbered on the next sync (the reason the
crude `skills/brand-guidelines/**` project-zone exception exists). Two sentinel forms,
both opt-in, both implemented in `_lib/skill-merger.js` and wired into
`template-updater.js`'s template-zone branch (no sentinel, or `--no-merge` → plain
overwrite, exactly as before) — pick the one that matches the shape of the addition.

**Form 1 — whole-tail marker, for a new section appended at the end of the file:**

```
<!-- @@project-additions -->
```

Everything **below** it is adopter-owned and **preserved by the default merge**; everything
above is template-owned and refreshed from source.

**Form 2 — anchored inline fence, for a bullet or paragraph inserted INSIDE an existing
template-owned section** (an escalation rule, a test-design pattern) — the whole-tail
marker can't protect this shape, because it can only ever draw one line in the sand:

```
<!-- @@project-additions:start -->
- your project-specific bullet, inserted anywhere in the document
<!-- @@project-additions:end -->
```

On merge, the fenced block is re-anchored to the nearest preceding Markdown heading and
re-inserted at the **end of that heading's section** in the refreshed template — so it
survives the template body around it changing. If the anchor heading no longer exists
(renamed/removed upstream), the block is recovered under a synthesized
`## Project-Specific Additions (recovered — verify placement)` heading at EOF instead of
being silently dropped, and `mergeSkillFile`'s `detail`/`orphans` flags it so a human
re-homes it.

**Rules:**
- Project-specific content (stack quirks, local conventions, project tokens) added to a
  *template-owned* skill goes inside one of the two sentinel forms above — never edit
  template-owned prose in place (those edits are lost on sync). Prefer a brand-new
  **project-added skill dir** when the content is substantial — entirely new skill dirs
  are never touched by sync.
- Commands that customize template skills (`/review:specialize`, `/sweep`,
  `/review:evolve-skills`) — and any agent hand-adding a field-proven review/test rule to
  a shared skill during normal work — MUST use one of the two forms, creating the
  sentinel if absent. A whole-new top-level section → Form 1. A bullet inserted into an
  existing list/section → Form 2.
- A template skill MAY ship an empty marker stub to invite additions; the merger drops a
  duplicate source stub so the marker never doubles.
- **Showing either sentinel as a usage example in prose (this doc is one) MUST be inside
  a fenced code block (`` ``` ``).** The merger's sentinel scan is fence-aware and ignores
  matches inside a documentation code fence — get this wrong (a bare, unfenced example
  line) and every adopter's unmodified copy of the doc silently starts being routed
  through the merge path instead of a plain overwrite. This was a live bug (found
  2026-07-11): the original single-marker mechanism was a naive substring search with no
  fence awareness, so `skill-authoring/SKILL.md`'s own illustration of the bare marker —
  shown in a code fence exactly like the one above — was mistaken for a real tail marker
  on every adopter's unmodified copy, silently freezing everything below it (the doctrine
  sections that followed, including "The Law" and "Anti-Patterns") from ever refreshing
  on sync. Fixed by making every sentinel scan (`splitAtMarker`, `extractFencedBlocks`,
  `hasProjectAdditions`) line-based and fence-aware instead of a raw substring search.
- `fleet:diverge`'s blob-identity comparison uses `stripAdopterOwned()` (strips both
  forms) rather than raw marker-head text, so a Form-2-only file — one using anchored
  fences but no whole-tail marker — doesn't false-positive as a diverged template edit
  merely because it carries protected local content.
