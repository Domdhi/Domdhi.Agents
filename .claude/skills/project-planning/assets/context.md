<!-- @@template -->
# Project Context: {Project Name}

| Attribute | Value |
|-----------|-------|
| **Initialized** | {YYYY-MM-DD} |
| **Phase** | {current phase} |
| **Tech Stack** | {from architecture/overview.md} |

---

## Quick Reference

| Document | Path | Status |
|----------|------|--------|
| Project Brief | [product/brief.md](brief.md) | {status} |
| PRD | [product/requirements.md](requirements.md) | {status} |
| UX Spec | [design/spec.md](../design/spec.md) | {status} |
| Architecture | [architecture/overview.md](../architecture/overview.md) | {status} |
| Epics | [work/backlog.md](../work/backlog.md) | {status} |
| Feature Ideas | [work/todo/feature-ideas.md](../work/todo/feature-ideas.md) | {status} |

---

## Design Scope and Artifacts

{When design applies, summarize selected surfaces, fidelity, relevant states/sizes/theme modes and intentional exclusions. Use docs/design/spec.md's exact ## Design Artifacts record as the source for the selected outputs, tools, opening instructions and inspection evidence. For no design phase, state "Not applicable" and omit design links/table rows.}

| Selected artifact / reference | Purpose and scope | Open / inspection status |
|-------------------------------|-------------------|--------------------------|
| {actual editable source or verified reference link} | {purpose and coverage} | {verified opening instructions or link to spec record; inspection result} |

{Add only actual selected artifacts, including project-native paths outside docs/design when applicable. Resolve local links relative to docs/product/context.md. Omit unselected scaffold companions; do not imply omitted visual or interactive coverage was verified. Explicit text-only exploration is valid with its documented limits.}

---

## Implementation Commands

| Command | Purpose |
|---------|---------|
| `/do` | Implement next story from backlog |
| `/module` | Full feature lifecycle: brainstorm, plan, TODO |
| `/code-review` | Review code changes |
| `/qa` | Generate tests for code |
| `/retro` | Retrospective after epic completion |
| `/status` | Project status dashboard |
| `/changelog` | Release notes from stories + git history |
| `/check-sync` | Detect documentation drift |
| `/update-docs` | Fix documentation drift |
| `/optimize-agents` | Re-align agents with codebase |
| `/prime` | Reload context in new session |
| `/end` | Save session context for next time |

---

## Stats

- **Phases**: {count}
- **Epics**: {count}
- **Stories**: {count}
- **Must-Have FRs**: {count}

---

## Key Infrastructure

- **Repository**: {repo URL}
- **CI/CD**: {pipeline URL}
- **Environments**: {list}
- **Database**: {connection info or reference}

---

## Notes

{Any important context for developers picking up this project}
