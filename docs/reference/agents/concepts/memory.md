# Memory

Memory in this system is a persistent, compounding record of what each session learned — written to disk, scored by confidence, decayed over time, and surfaced into future sessions automatically. It is how the template gets smarter as you use it, without you having to keep re-explaining things. When a new session starts and `session-start-prime.cjs` injects a block of `[patterns]` concepts into the context, that's memory in action: the top-ranked things this project has figured out, handed to you before the first turn.

It is deliberately not a database. There's no query language, no schema migration, no indexing beyond SQLite FTS5 for search. It's a pile of files under `docs/.output/.memory/` that five small scripts shape into something useful. The point is durability across sessions, not structured retrieval.

### What kind of thing this is

The memory store is repo-native: it lives under `docs/.output/.memory/`, travels with the project directory, and requires nothing beyond Node and the scripts already in `.claude/core/`. No hosted service, no vendor account, no API key. You can move the repo, rename it, or hand it to someone else and the memories come with it.

It is split along a source/index line (ADR 0006 Amendment 2). The **curated JSON source** (`docs/.output/.memory/`) is **tracked in git** — it is the durable record, and tracking it is exactly what lets memories sync across machines. The **derived/transient parts** (`docs/.output/.state/memory-*`: the SQLite index, the `_inbox` drafts, the raw daily logs) are gitignored and regenerable — delete them and the next session rebuilds the index from the JSON automatically (a stale/absent check in `session-start-prime.cjs` self-heals it). Keeping the index and logs out of git also means no accidental secret-in-a-derived-file commit; and because the source itself is tracked, two machines reconcile memories through ordinary git merges of small, append-mostly JSON files rather than losing them.

Claude Code's native memory (Project Memory, `/memory`) offers similar persistence — context that survives across conversations without you re-explaining it. This system is not a replacement for that. They coexist: native memory is the right place for general guidance about how you want Claude to behave across all your projects; this store is the right place for project-specific learned facts, rejected approaches, and architectural decisions that belong to *this* codebase. Neither is the wrong choice — they answer different questions.

## The pipeline

Each session runs memory through five stages. The four-stage automated pipeline runs on hooks; **Acquire** is Main Agent's job at session-handoff time and lives outside the pipeline diagram below.

```
┌─────────┐    ┌─────────────────┐    ┌──────────────────┐    ┌─────────┐
│ capture │ -> │ curate (strict) │ -> │ extract (manual) │ -> │ promote │
└─────────┘    └─────────────────┘    └──────────────────┘    └─────────┘
 daily logs     dedup,                 Haiku-powered            mark for
 from session   merge,                 structured               templates
 events         contradict             extraction               and skills
```

1. **Capture** — every session ends with `memory-capture.cjs` firing on the `Stop` hook. It writes a daily log entry summarizing what happened (tasks, commits, decisions). `pre-compaction-archive.cjs` also captures a log before context compaction, so work survives auto-compression. Opt-in: `edit-capture.cjs` records edits to canonical docs (CLAUDE.md, architecture, skills) as daily-log entries when `MEMORY_PROFILE=strict`.
2. **Acquire** — Main Agent writes 0–3 structured memories per session via `memory-manager.js create`; the daily log feeds optional brownfield extraction (`memory-extractor.js extract`) for adopter projects.
3. **Curate** — `memory-curator.js` runs on `Stop` when `MEMORY_PROFILE=strict`. Haiku analyzes the concept set for duplicates, contradictions, and merge candidates. Outside strict profile, this stage is skipped.
4. **Extract** — `memory-extractor.js` pulls structured facts from daily logs via `claude -p` (Haiku). Manual/brownfield-only: no hook or command fires this automatically. Run it by hand via `node .claude/core/memory-extractor.js extract` when onboarding an existing project with historical daily logs, or via `/review:memory-health` which runs it as part of the periodic health check. In-process memory acquisition is owned by Main Agent at session-handoff time — see `docs/.output/findings/reviews/2026-04-20-adr-memory-unification.md`.
5. **Promote** — `memory-promoter.js scan` ranks concepts by their decayed confidence × recency × usage. High-ranked concepts get reviewed for promotion into templates, skills, or agent instructions — the point where a memory graduates from "knowledge the system remembers" to "knowledge the system enforces."

Most of this runs on hooks without you thinking about it (see [`./hooks.md`](./hooks.md)). The `memory-*.js` scripts are also runnable directly when you want to inspect, search, or manually curate.

## Confidence

Every memory carries a confidence score from 0.5 to 0.9. The scale corresponds to how much evidence backs it:

| Level | Label | Assigned when |
|-------|-------|---------------|
| 0.9 | architecture | Locked by an ADR or the architecture document |
| 0.8 | retro-validated | Confirmed by an epic retrospective |
| 0.7 | implementation-proven | Survived actual implementation and stayed true |
| 0.6 | story-discovered | Surfaced during a single story's execution |
| 0.5 | session-observed | Noticed in one session, not yet repeated |

A memory can start at 0.5 and climb as it accumulates sources and gets validated. It can also start higher if it's written hand — `memory-manager.js create` lets you assign confidence directly. Hand-created memories bypass the `sources >= 2` filter because intentional human curation doesn't need a noise floor.

## Decay

Confidence doesn't stay fixed. Memories decay on **active work-days** — days with at least one git commit in this repo — not calendar days. A project untouched for three months has the same memory state it had when you left it. The clock only moves when you do.

Per-category decay rates:

| Category | Rate | ~Half-life (work-days) |
|----------|------|------------------------|
| `decisions` | `0.98^days` | ~35 |
| `constraints` | `0.97^days` | ~23 |
| `patterns` | `0.95^days` | ~14 |
| `workflows` | `0.93^days` | ~10 |

Workflows decay fastest because how a team works changes fastest. Architecture decisions decay slowest because they're expensive to change. The rates are tuned in `constants.js MEMORY_DECAY` — overridable per project.

Thresholds: below 0.3 is stale (still visible, but deprioritized in ranking). Below 0.1 is archive-candidate (hide from defaults, keep on disk for audit). `node .claude/core/memory-manager.js decay-report` lists the stalest memories first so you can prune or refresh them.

### Memory data model — hand-created vs (retired) compiled

The primary path into the memory system is hand-created:

- **Hand-created memories** — `docs/.output/.memory/{cat}/{slug}.json`. Produced by `memory-manager.js create`. No source-count filter. Represents deliberate human curation — use for rules, decisions, or context you want remembered whether or not it came up in session transcripts. Main Agent writes 0–3 of these per session at handoff time.
- **Compiled concepts (legacy)** — `docs/.output/.state/memory-concepts/{cat}/{slug}.md`. Produced by `memory-compiler.js` from daily logs. Needed 2+ sources to file. Represents observed reality accumulated across sessions.

Both paths feed the same ranking and decay pipeline. `memory-promoter.js scan` and `mark` operate on both. The distinction matters only when you're deciding how to add a new memory: want to lock in a fact now? Create it by hand via `memory-manager.js create`. Working from historical logs in an adopter project? Run `memory-extractor.js extract` (manual Haiku).

Note: compiled concept articles produced by `memory-compiler.js` were retired 2026-04-20 — the file remains for backward compat in adopter projects but is not part of the active pipeline.

## Importance (the retention floor)

Confidence answers "how sure are we this is true?" — it doesn't answer "how much does this matter?" Those are different questions, and on an actively-committed project they pull apart: a true-but-trivial memory and a true-and-foundational one both sit at high confidence and neither decays, so the store only grows. **Importance** is the second axis that fixes this.

Every memory carries an `importance` score from 1 to 5, assigned **once at write time** by the author (the Main Agent, at session-handoff). It lives at `content.importance` and defaults to 3 when omitted (and for legacy memories with no score — backfill-on-read).

| Importance | Meaning |
|------------|---------|
| 5 | Architecture-level / foundational — platform constraints, ADR-locked decisions, things that rarely change |
| 3 | Default — a useful cross-project insight |
| 1 | Ephemeral / narrow — story-specific tips that will be obsolete in weeks (e.g. most `rejected-approaches`) |

Importance is the **retention floor**: `calculateDecayedConfidence` multiplies the active-work-day decay curve by `importance / 3`. A score of 3 leaves a memory unchanged (so the whole existing store is untouched); importance ≤2 lowers the effective floor so a low-value, never-recalled memory can cross the stale threshold **even on an active repo where decay alone never fires**; importance ≥4 resists decay. This is the fix for the hoarding root cause — decay-based pruning could never reach never-recalled memories on a project that keeps committing.

Why write-time and not measured-after: the signal you'd want — "was this memory actually used?" — is unmeasurable here, because the biggest consumer (session-start injection) reads memories without leaving any trace. So `usage_count` is a *lower bound*, not a usage truth. Scoring intrinsic importance once, at the moment of authoring (when full context is in hand), sidesteps the unmeasurable signal entirely. See [[importance-at-write-beats-usage-after]] and [[memory-eviction-prefer-admission-over-access-count]].

## Supersession (forgetting by validity)

Some memories don't decay — they become *wrong*. A memory that was true when written but has since been replaced should be forgotten, regardless of confidence or importance. Supersession handles this as a pure validity filter, no live model at query time.

Each memory has two nullable columns: `invalid_at` (an ISO timestamp) and `superseded_by` (the replacing memory's id). A memory with `invalid_at` set is **hidden from all current-state reads** — `listMemories`, `searchMemories`, and session-start injection all exclude it by default — but kept on disk as history (readable with `{ includeSuperseded: true }`).

It's **flag-then-confirm**, never automatic: at write time `createMemory` runs a cheap FTS5 same-category overlap query and attaches likely-superseded predecessor ids to the result as `supersedes_candidates` (an LLM-free flag). The Main Agent reviews these at `/end` and confirms each with `memory-manager.js supersede <category> <oldId> <newId>`, which stamps the columns and deindexes the old entry from the active FTS. Nothing is forgotten without a human/Main-Agent decision. See [[forget-by-validity-not-usage-signal]].

## Honest usage and injection ranking

`usage_count` used to grow on any write (metadata patch, echo-boost, confidence bump) and was a primary multiplier in injection ranking — both wrong, because a write isn't a recall and an unmeasurable lower bound shouldn't dominate. Now:

- `usage_count` increments **only on genuine retrieval** (`searchMemories`), write-through to both the JSON source of truth and the SQLite row, exactly once per recall. `updateMemory` no longer touches it, and passive session-start injection still never does (so the lower-bound honesty is preserved).
- It ages: `halveUsageCount` (in `_lib/memory-decay.js`) halves the counter every `USAGE_HALVE_EVERY_DAYS` (14) silent active-days, so a once-popular-now-cold memory stops winning forever.
- **Injection ranking** (`session-start-prime.cjs`) is now `importance-floored decayed_confidence × recency` as the primary score, with the aged usage count as a **tiebreaker only**. A hard top-N size budget (`MEMORY_PRIME_COUNT` or `DEFAULT_N=8`) forces ranking down to the budget even when nothing has aged.

The custom retrieval-accuracy harness (`node .claude/core/memory-eval.js`, or `npm run memory:eval`) validates that this pruning *improves* retrieval rather than just shrinking the store: it scores hit@k for a pruned store vs a keep-everything store and reports the delta (keep-everything is measurably worse — consistent with LongMemEval's finding).

Design record: `docs/.output/findings/research/2026-06-04-memory-eviction-retention-research.md`.

## Key scripts

| Script | What it does |
|--------|--------------|
| `memory-manager.js` | CRUD + search + decay + 7-point health lint (SQLite FTS5 index) |
| `memory-compiler.js` | Daily logs → concept articles (retired 2026-04-20 — preserved for backward compat; not part of active pipeline) |
| `memory-extractor.js` | Haiku-powered structured extraction from daily logs (manual/brownfield only — no auto-fire) |
| `memory-curator.js` | Haiku-powered dedup / contradiction / merge analyzer (strict profile only) |
| `memory-promoter.js` | Scan/rank/mark concepts for promotion to templates and skills |

`memory-manager.js report` is the one-liner for "show me everything." `memory-manager.js search "topic"` hits the FTS5 index. `memory-manager.js decay-report` lists the stalest memories first. Running these by hand never hurts.

The hook that drives the auto-compound is `memory-capture.cjs`, not a `memory-*.js` script — it lives under `.claude/hooks/`. See [`./hooks.md`](./hooks.md) for the full hook inventory.

## When to lean on memory (and when not to)

Lean on it when:

- **A future session will benefit from something you figured out now.** Store the rule, the decision, the rejected approach. Future-you or a future agent will thank you.
- **You want the next `/prime` to surface context automatically.** `session-start-prime.cjs` pulls top-ranked concepts into every new session's opening context. Memory is the way to get something on that list.
- **You keep re-explaining the same thing.** If you've corrected the same mistake twice, that's a memory. Create it by hand if the compiler hasn't caught it yet.

Don't lean on it when:

- **The information belongs in code or config.** Memory is not a substitute for writing the rule into a hook, skill, or command. Memories are what you notice; artifacts are what you enforce. The promotion pipeline exists exactly to migrate high-signal memories from one to the other.
- **The knowledge is ephemeral.** In-session state belongs in a plan file or a TaskList, not memory. Memory is for things that will still matter next week.
- **You want authoritative answers right now.** Memory can be stale, decayed, or contradicted by newer state. Read the file or run the command when you need ground truth — memory is context, not oracle.

---

See also: [`./hooks.md`](./hooks.md) for the hooks that drive the auto-compound (`memory-capture.cjs`, `session-start-prime.cjs`, `edit-capture.cjs`, `pre-compaction-archive.cjs`), [`./agents.md`](./agents.md) for the agents that read and write memory during their work, [`./commands.md`](./commands.md) for `/remember`, `/review:memory-health`, and `/review:promote-memories`, [`./skills.md`](./skills.md) for the skill catalog.
