# Specialization Report Template

```markdown
## Specialization Report

### Run Mode: {--fix / --dry-run / --report-only}
### Date: {YYYY-MM-DD}
### Project: {PROJECT_NAME}
### Tech Stack: {one-line summary — e.g., "Python 3.12 + Django 5.1 + PostgreSQL 16 + React 19"}

---

### Extracted Tech Stack

#### Backend
| Layer | Technology | Version |
|-------|-----------|---------|
| {layer} | {technology} | {version} |

#### Frontend
| Layer | Technology | Version |
|-------|-----------|---------|
| {layer} | {technology} | {version} |
{or "N/A — backend-only project"}

#### Database
| Role | Technology | Version |
|------|-----------|---------|
| {role} | {technology} | {version} |

#### Infrastructure
| Service | Technology |
|---------|-----------|
| {service} | {technology} |

#### Auth: {provider} via {flow}, {model} authorization
#### Testing: {frameworks summary with coverage targets}
#### ADRs Found: {count}

---

### Agent Specialization

#### Default Agents ({count} updated with Project Context)

| Agent | Action | Context Summary |
|-------|--------|----------------|
| {agent-name} | {Added/Updated/Would add/Skipped} | {summary of what context was added} |
| ... | ... | ... |

#### Stack-Specific Agents Created ({count} from architecture analysis)

| Agent | Domain | Technology | Status |
|-------|--------|-----------|--------|
| {name} | {domain from architecture} | {specific tech} | {Created/Already exists/Would create} |
| ... | ... | ... | ... |

{Or "No stack-specific agents needed — default agents cover all domains"}

#### Build & Test Gate
| Script | Toolchain | Status |
|--------|----------|--------|
| gate.js | {detected build/test tools} | {Already exists — auto-detects project type} |

#### Risk Map

| Tier | Path Patterns | Count |
|------|--------------|-------|
| HIGH | {patterns} | {N} |
| MEDIUM | {patterns} | {N} |
| LOW | {patterns} | {N} |
| Default | (unmatched files) | MEDIUM |

---

### Skills Audit

| Skill | Classification | Reason |
|-------|---------------|--------|
| {skill-name} | {relevant / not-applicable / needs-framework-skill} | {why} |

#### Stack Skills Generated ({count} from gap detection)

| Skill | Technology | Version | Status |
|-------|-----------|---------|--------|
| {tech-slug}-patterns | {Technology} | {version} | {Created / Already exists / Would create / Skipped (no patterns needed)} |
| ... | ... | ... | ... |

{Or "No stack skills needed — all project technologies have corresponding skills"}

#### Skill Wiring

| Agent | Skills Added | Total Skills |
|-------|-------------|-------------|
| {agent-name} | +{skill-1}, +{skill-2} | {total count} |
| ... | ... | ... |

{Or "No skill wiring changes needed"}

---

### Memory System

| Check | Status | Details |
|-------|--------|---------|
| patterns/ directory | {Created / Existed / Would create} | {count} files |
| constraints/ directory | {Created / Existed / Would create} | {count} files |
| decisions/ directory | {Created / Existed / Would create} | {count} files |
| workflows/ directory | {Created / Existed / Would create} | {count} files |
| ADR seeding | {Seeded {N} / Already populated / Would seed {N}} | {ADR numbers} |
| Pattern seeding | {Seeded {N} / Already populated / Would seed {N}} | {pattern names} |
| Health check | {Passed / Warnings / Failed / Skipped} | {details} |

**Memory totals**: {N} memories across {N} categories, avg confidence {0.X}

**Confidence guide:**
- 0.9 — Architecture-documented (seeded by `/specialize`)
- 0.8 — Retro-validated (promoted by `/retro`)
- 0.7 — Proven in implementation (written by `/do`)
- 0.6 — New from story (written by `/do`)
- 0.5 — Session observation (manual)

---

### Command Integration

| Command | Reads Memories | Writes Memories | Status |
|---------|---------------|-----------------|--------|
| /do | {API / Glob / None} | {API / None} | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /run-todo | {API / None} | {API / None} | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /review:code-review | {API / None} | N/A | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /retro | {API / None} | {API / None} | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /prime | {API / None} | N/A | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |
| /end | {API / None} | N/A | {INTEGRATED / PARTIAL / NOT_INTEGRATED} |

---

### Memory Lifecycle

```
/specialize → seeds decisions (0.9) + patterns (0.9) from architecture
/do         → reads patterns during planning, writes new patterns (0.6–0.7) post-task
/retro      → reads all, promotes confidence (→ 0.8), writes validated patterns
```

---

### Manual Actions Required
{Numbered list of items that cannot be auto-fixed, with file paths and recommendations}

### Recommended Next Steps
{Ordered list based on findings — typically: create missing framework skills, fix partial integrations, then begin /do}
```
