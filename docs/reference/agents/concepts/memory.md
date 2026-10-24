# Memory

The curated memory store is tracked JSON under `docs/.output/.memory/`: reusable patterns, constraints, decisions, workflows and rejected approaches. It travels through Git with the project. The SQLite FTS5 index, inbox drafts and daily logs live under ignored `.output/.state/` and can be rebuilt from source. Memory supplies context; current code/config remains the authority.

Runtime helpers need Node with no mandatory npm install. Node 24+ provides built-in SQLite/FTS5; an older runtime can use optional better-sqlite3 or fall back to JSON search. The source, optional index and additive schema migrations are implemented in [memory-manager.js](../../../../.agents/core/memory-manager.js).

## Acquisition and capture

Main Agent creates a small number of curated memories from reusable learning at session-handoff boundaries. Subagents stage drafts in `docs/.output/.state/memory-inbox/`; only the main owner promotes/discards them. A session can produce no useful new memory. Do not store task/branch progress that belongs in a TODO or handoff.

Claude's registered Stop hook captures daily logs and invokes Sonnet curation under strict profile. PreCompact and strict-profile edit capture provide additional log inputs. Manual/brownfield extraction reads historic daily logs through the Claude text-only backend; the selected memory-health procedure can invoke it. Extraction is not automatic session acquisition. Legacy compiled concept files and native Claude agent-memory ingestion remain compatibility bridges, not the primary prescribed write path.

Codex leaves automatic Stop/Post-Bash extraction unregistered. Optional extractor/curator/benchmark inference is disabled before subprocess launch because a supported, verified no-tools invocation is unavailable. Session-handoff acquisition, explicit curated CRUD, inbox promotion and search remain available. A read-only model sandbox does not establish text-only inference. See the [adapter runtime limits](../../../../.agents/adapters/codex/README.md#runtime-limits-and-verification).

## Source and shared state

Tracked JSON is read from the active source checkout. Ignored index/inbox/log state is shared at the main worktree's Git-common-directory root unless explicitly overridden. Installed toolkit assets are resolved independently from the invocation/action context.

The [native context contract](../../../../.agents/adapters/codex/README.md#context-contract) specifies neutral/Codex override precedence and the legacy Claude direct-helper exception. Use native `.codex/core/` helpers in Codex and `.claude/core/` in Claude. A hook child's environment does not select the parent helper runtime. Separate Git-directory layouts use the documented standalone fallback.

```sh
# Codex; Claude uses .claude/core/.
node .codex/core/memory-manager.js report
node .codex/core/memory-manager.js search "source ownership"
node .codex/core/memory-manager.js lint
```

Absent/stale/content-divergent indexes are derived-state repair cases. An empty source set is authoritative too. Corrupt or unreadable source is an incomplete snapshot, not evidence that all records were intentionally removed; inspect rebuild/health failure output before relying on the index.

## Confidence, decay and importance

Confidence records evidence strength. Decay uses active work days rather than calendar time. Category rates and stale/archive thresholds are defined in `MEMORY_DECAY` in [constants.js](../../../../.agents/core/constants.js); rejected approaches have their own rate. Idle calendar time alone does not advance this clock.

Importance is an intrinsic retention score from 1 to 5. Creation accepts `content.importance`, normalizes it and stores `importance` at the top level; legacy content-level values remain readable. Defaults come from `MEMORY_FILTERS.IMPORTANCE_DEFAULT` and its call-site override. Importance scales the confidence decay curve: higher-importance foundational rules resist decay, while low-value records can enter the stale queue sooner. See ADR 0007 (memory value system) in the workshop's architecture records.

Category capacity and near-limit behavior use `MEMORY_FILTERS.MEMORY_MAX_PER_CATEGORY` and `MEMORY_FILTERS.MEMORY_NEAR_LIMIT_PCT`; the `MEMORY_MAX_PER_CATEGORY` environment override is applied by consumers. Near-limit creation attempts prune eligible stale records; writes at the effective cap refuse. Read these constants rather than duplicate literal caps in guidance. `analytics`, lint and decay reports show distinct capacity/quality/age signals.

## Recall and supersession

`searchMemories` increments usage on genuine retrieval; diagnostics can opt out. Writes and passive startup injection do not count as recall. Usage ages according to `MEMORY_DECAY.USAGE_HALVE_EVERY_DAYS`. Startup injection ranks by importance-adjusted decayed confidence times recency, with aged usage as a tiebreaker. Search preserves its own returned relevance/rank; do not invent another sort from injection rules.

Superseded records have `invalid_at` and `superseded_by`, remain on disk as history and are excluded from current-state reads by default. Creation can flag candidates, but the main owner confirms supersession. A valid-but-old record and a replaced/wrong record are different cases.

Startup injection is observed only when memory context is actually visible; installed hooks alone do not prove it ran. Explicit workflow recall loads relevant non-stale source evidence, deduplicates already visible/read memories and keeps task scope. [Memory flow](../memory-flow.md) maps these paths.

## Maintenance and durable guidance

| Need | Path |
| --- | --- |
| Store/read/search curated learning | `memory-manager.js` CRUD/search/report |
| Inspect capacity and genuine-use signals | `memory-manager.js analytics` |
| Inspect source quality and age | Lint and decay report; review-memory-health |
| Reconcile larger overlap clusters | review-memory-defrag |
| Move reusable rules into skills/roles/docs | review-promote-memories; reviewed main-owner application |
| Validate retrieval changes | `memory-eval.js` |

Promote durable behavior into the correct code/skill/doc rather than relying forever on a decaying memory. Avoid recording secrets in curated or generated output. Ignored state is not a secret-protection guarantee.

Design records, kept in the workshop and not shipped: memory unification (ADR 0001), the 2026-06-04 retention research and the memory value system (ADR 0007). See [hooks](hooks.md), [roles](agents.md) and [workflow reference](../commands.md).
