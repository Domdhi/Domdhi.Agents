### 4. Seed Memory System

Seed the architecture's decisions and patterns as memories so later workflows start with them. Seed only into empty categories.

**4a. Ensure directory structure** (if MODE is `--fix`). Create all five memory categories under `docs/.output/.memory/`; a missing one (for example `rejected-approaches`) hard-errors later tools that iterate the full category set:
```bash
for c in patterns constraints decisions workflows rejected-approaches; do
  mkdir -p "docs/.output/.memory/$c"
done
```

**4b. Seed ADR decisions** (only if `decisions/` contains no `.json` files). For each ADR extracted in Step 1 (the ADRs bullet):

```bash
node .claude/core/memory-manager.js create decisions "adr-{NNN}" '{
  "title": "ADR-{NNN}: {Title}",
  "decision": "{Decision text}",
  "rationale": "{Context text}",
  "consequence": "{Consequences text}",
  "source": "docs/architecture/overview.md",
  "tags": ["{dynamically extracted tags}"],
  "confidence": 0.9
}'
```

Tags: add each technology from the extracted stack that the ADR mentions (lowercased, hyphenated), plus domain tags such as "auth", "data" or "infra" based on its content.

**4c. Seed architectural patterns** (only if `patterns/` contains no `.json` files). For each component in `## Component Architecture` and each concern in `## Cross-Cutting Concerns`:

```bash
node .claude/core/memory-manager.js create patterns "{component-slug}" '{
  "title": "{Component Name}",
  "description": "{Responsibility}",
  "technology": "{Technology}",
  "source": "docs/architecture/overview.md",
  "tags": ["{relevant tech tags}"],
  "confidence": 0.9
}'
```

**4d. Run the memory health check** (if the script exists):

```bash
node .claude/core/memory-health-check.js
```

**Confidence guide** (include in the report):

| Source | Confidence | Set By |
|--------|-----------|--------|
| Architecture-documented (ADRs, patterns) | 0.9 | `/specialize` |
| Retro-validated pattern | 0.8 | `/retro` (if installed) |
| Proven in implementation | 0.7 | `/do` |
| New pattern from story | 0.6 | `/do` |
| Session observation or workaround | 0.5 | manual |
