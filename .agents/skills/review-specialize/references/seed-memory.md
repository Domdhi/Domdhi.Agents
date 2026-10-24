### 4. Seed Memory System

**4a. Ensure directory structure** (if MODE is `--fix`):

Create the directories for **all five** memory categories under `docs/.output/.memory/` (missing any one — e.g. `rejected-approaches` — hard-errors later tools that iterate the full category set):
```bash
for c in patterns constraints decisions workflows rejected-approaches; do
  mkdir -p "docs/.output/.memory/$c"
done
```

**4b. Seed ADR decisions** (only if `decisions/` contains no `.json` files):

For each ADR extracted in Step 1h:

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

**Tag extraction:** Cross-reference the ADR's text against the tech stack model. If the ADR mentions a technology that appears in the extracted tech stack, add it as a tag (lowercased, hyphenated). Also add domain tags like "auth", "data", "infra" based on content.

**4c. Seed architectural patterns** (only if `patterns/` contains no `.json` files):

For each component from the `## Component Architecture` section and each concern from `## Cross-Cutting Concerns`:

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

**4d. Run memory health check** (if script exists):

```bash
node .claude/core/memory-health-check.js
```

**Confidence guide** (include in report):

| Source | Confidence | Set By |
|--------|-----------|--------|
| Architecture-documented (ADRs, patterns) | 0.9 | `/specialize` |
| Retro-validated pattern | 0.8 | `/retro` |
| Proven in implementation | 0.7 | `/do` |
| New pattern from story | 0.6 | `/do` |
| Session observation or workaround | 0.5 | manual |
