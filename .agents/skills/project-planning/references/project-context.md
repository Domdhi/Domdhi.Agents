# Project Context

Defines `docs/product/context.md`, the single-file quick reference `/prime` loads first in every session. A good one lets a reader understand the project in 30 seconds and reflects where it actually stands.

## Document Template

The canonical, scaffold-blessed template is `../assets/context.md` (raw, with the `<!-- @@template -->` first-line marker). `scaffold.js` seeds `docs/product/context.md` from it.

## Maintenance

- Created by `scaffold.js`; `/end` updates state and `/do` updates active work. `/prime` reads it first each session.
- Update it after every completed story or significant change, and keep it under 100 lines: a quick reference, not documentation.
- Keep doc links valid, the current-state section true to actual progress (no done stories shown as pending), and the tech-stack summary matching `architecture/overview.md`. Missing architecture summary or current state are the usual failures.
