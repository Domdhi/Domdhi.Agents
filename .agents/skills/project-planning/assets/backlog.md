<!-- @@template -->
# Product Backlog: {Project Name}

| Attribute | Value |
|-----------|-------|
| **Project** | {Project Name} |
| **Version** | 1.0 |
| **Status** | Draft |
| **Author** | {name} |
| **Tech Stack** | {from architecture/overview.md} |

---

## Executive Summary

{Brief overview of the full product scope and how work is organized into phases/epics}

---

## Technology Stack

{Copied from architecture/overview.md for quick reference}

---

## Phase 0: Foundation (Sprint 1)

**Goal:** Project setup, infrastructure, and development environment

---

### Epic 0: Project Bootstrap

**Objective:** Establish development environment and core project structure

* **Story 0.1 (Config): Project Initialization**
  * **As a** developer,
  * **I want** a properly configured project with all dependencies,
  * **So that** I can start building features immediately.
  * **AC:**
    * Project scaffolded with chosen framework
    * Dependencies installed and lockfile committed
    * README with setup instructions exists
  * **Estimate:** S
  * **Dependencies:** None

* **Story 0.2 (DevOps): CI/CD Pipeline Setup**
  * **As a** developer,
  * **I want** automated build and test on push,
  * **So that** code quality is maintained.
  * **AC:**
    * Build runs on push to main and PR branches
    * Tests execute as part of pipeline
    * Build status badge in README
  * **Estimate:** M
  * **Dependencies:** 0.1

---

## Phase 1: {Phase Name} (Sprint {X}-{Y})

**Goal:** {What this phase achieves}

---

### Epic 1: {Epic Name}

**Objective:** {What this epic delivers}

* **Story 1.1 ({Domain}): {Story Title}**
  * **As a** {persona},
  * **I want** {capability},
  * **So that** {benefit}.
  * **AC:**
    * {Acceptance criterion 1}
    * {Acceptance criterion 2}
    * {Acceptance criterion 3}
  * **Estimate:** {S/M/L/XL}
  * **Dependencies:** {Story X.Y, or "None"}

* **Story 1.2 ({Domain}): {Story Title}**
  * **As a** {persona},
  * **I want** {capability},
  * **So that** {benefit}.
  * **AC:**
    * {Acceptance criterion 1}
    * {Acceptance criterion 2}
  * **Estimate:** {S/M/L/XL}
  * **Dependencies:** {Story X.Y, or "None"}

---

## Story Index

| Story | Title | Phase | Epic | Estimate | Status | Dependencies |
|-------|-------|-------|------|----------|--------|-------------|
| 0.1 | Project Initialization | 0 | Bootstrap | S | [ ] | None |
| 0.2 | CI/CD Pipeline Setup | 0 | Bootstrap | M | [ ] | 0.1 |
| 1.1 | {title} | 1 | {epic} | {est} | [ ] | {deps} |
| 1.2 | {title} | 1 | {epic} | {est} | [ ] | {deps} |

---

## Related Documents
- PRD: [../product/requirements.md](../product/requirements.md)
- Architecture: [../architecture/overview.md](../architecture/overview.md)
- UX Spec: [../design/spec.md](../design/spec.md)
