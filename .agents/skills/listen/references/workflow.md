# /listen — Signal Intake Aggregator

The first **post-MVP lifecycle** command. When the initial backlog drains, the harness has no model for *push-from-reality* work — bug reports, telemetry drift, unaddressed agent issues, expiring flags. `/listen` is the listener: it sweeps every available signal source, tags each finding with its provenance, and writes a single dated intake file. It does **not** triage, prioritize, or ask questions — that is `/triage`'s job (Tier 2). `/listen` only gathers.

Shape: like `/prime`, but it reads *reality* (git, telemetry, logs, drift) instead of session context, and it persists the result.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js listen
```

## Variables

SCOPE: $ARGUMENTS

- `SCOPE` (optional):
  - `--since {YYYY-MM-DD}` or `--since 14d` — window for time-bounded sources (git, telemetry). Default: since the most recent existing `intake/*.md`, else the last **14 days**.
  - A source name (`git`, `telemetry`, `agent-updates`, `backlog`, `external`) — run only that source. Default: all sources.

## Output

`docs/.output/evolution/intake/{YYYY-MM-DD}.md` — day-rotated, one file per run-day. If today's file already exists, **append a new run section** (`## Run {HH:MM}`) rather than overwriting — multiple `/listen` runs in a day accumulate.

Every signal is written as a bullet tagged with its origin (provenance model borrowed from Paperclip's `origin_kind`):

```
- [origin: {git|telemetry|agent-updates|backlog|external}] {signal} — {why it might matter}
```

## Workflow

### Step 1: Resolve the window

Determine the time window for time-bounded sources:
- If `--since` is provided, use it.
- Else, Glob `docs/.output/evolution/intake/*.md` and take the newest filename date as the lower bound.
- Else, default to 14 days ago.

State the resolved window in the report.

### Step 1b: Consult the triage ledger

Read `docs/.output/evolution/triage/_decisions.md` if it exists. This is a **read-only** step — `/listen` never writes to the ledger (that belongs to `/triage`). If the file is absent or empty, skip this step silently and proceed with an empty suppress set.

Parse each line matching the format:

```
- {YYYY-MM-DD} · {fingerprint} · **killed|deferred** [until {hint}] — {reason}
```

Build two suppress sets:

- **Killed:** every entry with `**killed**` — always suppress, no expiry.
- **Active-deferred:** entries with `**deferred**` are suppressed ONLY while the deferral is still active:
  - If the line has no parseable ISO date after `until` (e.g. `until pipeline-weight is reassessed` — vague text, no `YYYY-MM-DD`) → treat as active, suppress.
  - If the line has a parseable `YYYY-MM-DD` after `until` and that date is **in the future** (≥ today) → active, suppress.
  - If the parseable date is **in the past** (< today) → deferral has expired; do NOT suppress — allow the signal back into intake for re-evaluation.

Matching during sweep (Step 2) is **fuzzy**: a gathered signal is suppressed if the fingerprint's key noun phrase appears as a **substring** of the signal text or origin tag, or vice versa. Do not require exact equality — `git:expiring-flag:payment-shim` suppresses a git signal whose text contains `payment-shim` or `payment shim`. Count the total number of suppressed signals across all sources into **SUPPRESSED_COUNT**.

### Step 2: Sweep each source (provenance-tagged)

Run every applicable source. A source that yields nothing writes its header with `_No new signals._` — **never omit a section**, because a silent gap reads as "checked, all clear" when it might mean "not checked." As each signal is gathered, apply the suppress set from Step 1b: if the signal matches a killed or active-deferred fingerprint (fuzzy substring match), omit it from the intake and increment **SUPPRESSED_COUNT**.

**2a. `git` — code reality**
- `git log --oneline --since={window}` — recent commits; flag anything that looks like a revert, hotfix, or "WIP/TODO" commit message.
- Churn/hotspot: `git log --since={window} --name-only --pretty=format: | sort | uniq -c | sort -rn | head -15` — files changed most often are maintenance risk.
- In-code markers: grep the tracked source tree for `TODO|FIXME|HACK|XXX|BUG` added/visible. Surface counts + the highest-signal ones.
- Expiring flags: grep for `remove once`, `remove after`, `TODO: remove`, `@deprecated`, and dated `TODO({date})` markers whose date is **past today** — these are the cleanup obligations the harness otherwise forgets.

**2b. `telemetry` — usage reality**
- Read `docs/.output/.state/telemetry/command-usage.jsonl` (if present). Within the window: count `gate_run` events with `outcome: "failure"` (recurring build/test pain), and note any command spikes or absences. Skip gracefully if the file is missing.

**2c. `agent-updates` — unaddressed friction**
- Read the newest few day-files in `docs/.output/evolution/agents/` (`{YYYY-MM-DD}.md`; fall back to legacy flat `agent-updates.md`). Surface misalignments/decisions that have **not** yet been folded into a command or agent (i.e., still actionable). These are the `/optimize-agents` candidates that haven't been picked up.

**2d. `backlog` — plan drift**
- Grep `docs/work/todo/TODO_*.md` for deferred `[~]` and blocked `[!]` items — work that fell out of waves and never came back.
- Read `docs/work/todo/_design-notes.md` open items (un-promoted gaps).
- Scan recent `docs/.output/plans/*.md` for "Deferred" / "Next Task" residue.

**2e. `external` — bug tracker / feedback (only if configured)**
- If a GitHub remote is configured AND `gh` is available: `gh issue list --state open --limit 30` — open issues are direct push-from-reality signal. Skip silently if `gh` is unauthenticated or there is no remote.
- If a `docs/feedback/` inbox exists, read new entries.
- This source is **optional and tech-agnostic** — the template must produce a useful intake file with only git + local telemetry. NEVER hard-require an external tracker.

### Step 3: Write the intake file

MUST write `docs/.output/evolution/intake/{YYYY-MM-DD}.md` before reporting (output-persistence convention — chat-only intake is lost on compaction). Structure:

```markdown
# Signal Intake — {YYYY-MM-DD}

**Window:** {resolved window}  ·  **Sources:** {which ran}  ·  **Signals:** {N}

## Run {HH:MM}

### git
- [origin: git] {signal} — {why}

### telemetry
- [origin: telemetry] {signal} — {why}

### agent-updates
...

### backlog
...

### external
...
```

De-duplicate within the run (the same TODO surfaced by git and backlog is one signal). Do **not** rank or recommend — leave every item un-prioritized for `/triage`.

### Step 4: Commit (main agent)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage only the intake file. Message: `docs: /listen — {N} signals ({YYYY-MM-DD})`.

### Step 5: Report

```
## /listen — {YYYY-MM-DD}

**Window:** {resolved}
**Intake file:** docs/.output/evolution/intake/{YYYY-MM-DD}.md
**Commit:** {hash}

| Source | Signals |
|--------|---------|
| git | {n} |
| telemetry | {n} |
| agent-updates | {n} |
| backlog | {n} |
| external | {n / skipped} |
| **Total** | **{N}** |
| Suppressed (ledger) | {SUPPRESSED_COUNT} |

**Next:** run `/triage` to turn these signals into backlog items (defer / kill / promote).
```

If `N == 0` across all sources, say so plainly — that itself is a signal (the project is genuinely quiet), and the empty-but-present file records that the sweep happened.

## Anti-Patterns

- **Triaging.** `/listen` never prioritizes, recommends, or asks the user. It gathers and tags. Ranking is `/triage`'s job — mixing them collapses the intake/decision boundary.
- **Omitting an empty section.** A skipped source must still print its header with `_No new signals._`. Silent omission is indistinguishable from "all clear."
- **Hard-requiring an external tracker.** The command must work with only git + local telemetry. `external` is best-effort.
- **Overwriting today's file.** Append a `## Run {HH:MM}` section instead — same-day runs accumulate.
- **Chat-only output.** The intake file is the artifact; it MUST hit disk before the report.
