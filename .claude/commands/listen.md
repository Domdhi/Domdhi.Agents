---
description: Aggregate post-MVP signals (git, telemetry, agent-updates, backlog drift, external, the last gate result) into a dated intake file; --only-if-red is a quiet repeatable gate check
argument-hint: [optional --since {YYYY-MM-DD} | "14d" | source filter (incl. gate) | --only-if-red | --no-commit]
---

<!-- Generated from .agents/skills/listen/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# /listen — Signal Intake Aggregator

The first **post-MVP lifecycle** command. When the initial backlog drains, the harness has no model for *push-from-reality* work — bug reports, telemetry drift, unaddressed agent issues, expiring flags. `/listen` is the listener: it sweeps every available signal source, tags each finding with its provenance, and writes a single dated intake file. It does **not** triage, prioritize, or ask questions — that is `/triage`'s job (Tier 2). `/listen` only gathers.

Not to be confused with `/intake`, which records lessons about the toolkit for its maintainers; the "intake" here is the dated signal file under `docs/.output/evolution/intake/`.

Shape: like `/prime`, but it reads *reality* (git, telemetry, logs, drift) instead of session context, and it persists the result.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js listen
```

**Exception: `--only-if-red`.** That mode is a repeated poll, and a poll that exits quiet must leave no row (an hourly `/loop` would otherwise add a `command_invocation` row every hour and skew the command counts). Under `--only-if-red`, run Step 0 first and self-log only when Step 0 does not exit quiet, right before continuing with the `gate` source.

## Variables

SCOPE: $ARGUMENTS

- `SCOPE` (optional):
  - `--since {YYYY-MM-DD}` or `--since 14d` — window for time-bounded sources (git, telemetry). Default: since the most recent existing `intake/*.md` that holds a sweep (Step 1), else the last **14 days**.
  - A source name (`git`, `telemetry`, `agent-updates`, `backlog`, `external`, `gate`) — run only that source. Default: all sources.
  - `--only-if-red` — the quiet gate check for repeated and scheduled runs. Runs the `gate` source alone, and only when the last local gate result is `red` and its signature is not already in `docs/.output/.state/telemetry/listen-gate-seen.json`; otherwise it writes nothing and exits quietly (see Step 0). Implies `gate`.
  - `--no-commit` — skip the commit step (Step 4). The intake file is still written; a person or the scheduler's own step commits it.

## Output

`docs/.output/evolution/intake/{YYYY-MM-DD}.md` — day-rotated, one file per run-day. If today's file already exists, **append a new run section** (`## Run {HH:MM}`) rather than overwriting — multiple `/listen` runs in a day accumulate.

Every signal is written as a bullet tagged with its origin (provenance model borrowed from Paperclip's `origin_kind`):

```
- [origin: {git|telemetry|agent-updates|backlog|external|gate|run}] {signal} — {why it might matter}
```

A run writes only the intake file and `docs/.output/.state/telemetry/listen-gate-seen.json` (the last recorded gate signature, written only by a run that saw a red gate). Beyond the telemetry self-log row above (which a quiet `--only-if-red` exit does not write), it changes nothing else, and `--no-commit` leaves both uncommitted.

## Workflow

### Step 0: Quiet gate check (`--only-if-red` only)

Skip this step unless `--only-if-red` was given. The check is mechanical; do not judge it yourself:

```bash
node .claude/core/gate-signal.js --only-if-red
```

The command always exits 0 and prints one JSON object:

- It has `"quiet": true` — the gate is not red, or this red signature is already in `listen-gate-seen.json` and no passing gate run has been recorded since it was marked (a later pass expires the mark, so a failure that comes back after a green is reported again). Print one line, `/listen gate: quiet ({state}) — {reason}`, and stop. `--only-if-red` writes nothing on this path: no telemetry self-log row, no intake file, no seen-state update, no commit, no report table. This is the only quiet exit.
- No `quiet` key — it is the red gate signal `{state, signature, reason, ts, failureNames}` for a failure not yet recorded. Self-log the invocation now (the Telemetry section), then continue with the `gate` source as the only source, using this signal (do not run the `2f` command a second time). Step 1b (the suppress set) still applies; if it suppresses the gate bullet, the signature is still marked seen in Step 3, so the suppressed failure does not take the full path on every later poll.

### Step 1: Resolve the window

Determine the time window for time-bounded sources:
- If `--since` is provided, use it.
- Else, Glob `docs/.output/evolution/intake/*.md` and take the newest filename date among the files that hold a sweep as the lower bound. A file whose every `## Run` section holds only a `### run` heading is a log of unattended-run stops written by `/do` and `/run-todo` (`[origin: run]` bullets, which `/listen` never writes), not a sweep, so it does not move the window and would not hide the days before it.
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

Run every applicable source. A source that yields nothing writes its header with `_No new signals._` — **never omit a section** of a run that writes (the one exception is the `--only-if-red` quiet exit in Step 0, which writes no run at all), because a silent gap reads as "checked, all clear" when it might mean "not checked." As each signal is gathered, apply the suppress set from Step 1b: if the signal matches a killed or active-deferred fingerprint (fuzzy substring match), omit it from the intake and increment **SUPPRESSED_COUNT**.

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

**2f. `gate` — the last local gate result**
- Run `node .claude/core/gate-signal.js` (a pure read of the last local gate summary; it exits 0 always) unless Step 0 already supplied the signal. Read only its `state`.
- `red` — one bullet: `- [origin: gate] the last gate run failed ({reason}); signature: {signature}; failing: {failureNames, first 10 and a count of the rest} — a red gate blocks every wave`. Keep `signature: {signature}` in the bullet; Step 3 uses it to detect a rerun.
- `green`, `killed`, `stale`, `unknown` — not a signal. A killed run is not a verdict on the code, a stale or unknown result says nothing about the tree as it is now, and a green one is good news. Write the header with `_No new signals._ (gate: {state})`.
- The gate is not run here. A fresh result exists only if something ran the gate; this source reads the last local one.

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

### gate
- [origin: gate] {signal}; signature: {signature} — {why}
```

De-duplicate within the run (the same TODO surfaced by git and backlog is one signal). Do **not** rank or recommend — leave every item un-prioritized for `/triage`.

**Same-day rerun with no change.** When today's file already exists, compare this run's bullets with it first: a bullet is already there when its text matches an existing bullet, and a gate bullet is already there when its `signature: {signature}` appears in the file. If every bullet this run would write is already there, a same-day rerun with no change appends no `## Run` section: say so in the report (`no change since the last run`), leave the file as it is, skip Step 4, and report the existing file path as the intake file. Only a run that adds at least one new bullet appends a section, and that section lists only the new bullets under every source header.

**Mark the gate signature seen.** After the intake file is on disk (or confirmed unchanged), when this run saw a red gate signal, record its signature. That covers all three outcomes: the run wrote the bullet, the bullet was already in today's file (a same-day rerun), or Step 1b suppressed it. A run whose gate state was not red marks nothing:

```bash
node .claude/core/gate-signal.js --mark-seen {signature}
```

Exit 0 means recorded (a repeat of a still-live mark changes nothing; marking again after a passing gate run refreshes the expired mark). Exit 2 means it was refused (a bad signature, or a symlink or directory where the file belongs): report the printed `error` and finish the run, because the intake file is already written; the next `--only-if-red` run will record this failure again until the cause is fixed.

### Step 4: Commit (main agent)

With `--no-commit`, skip this step: stage nothing, commit nothing, and report `Commit: skipped (--no-commit)`. Otherwise follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage only the intake file (`listen-gate-seen.json` is ignored scratch state and is never staged). Message: `docs: /listen — {N} signals ({YYYY-MM-DD})`.

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
| gate | {n / none} |
| **Total** | **{N}** |
| Suppressed (ledger) | {SUPPRESSED_COUNT} |

**Next:** run `/triage` to turn these signals into backlog items (defer / kill / promote).
```

If `N == 0` across all sources, say so plainly — that itself is a signal (the project is genuinely quiet), and the empty-but-present file records that the sweep happened (a same-day rerun that adds nothing leaves the file as it is, per Step 3).

## Anti-Patterns

- **Triaging.** `/listen` never prioritizes, recommends, or asks the user. It gathers and tags. Ranking is `/triage`'s job — mixing them collapses the intake/decision boundary.
- **Omitting an empty section.** A skipped source must still print its header with `_No new signals._`. Silent omission is indistinguishable from "all clear." The one exception is the quiet exit of `--only-if-red` (Step 0): it writes no file, so there is no section to omit from.
- **Hard-requiring an external tracker.** The command must work with only git + local telemetry. `external` is best-effort.
- **Overwriting today's file.** Append a `## Run {HH:MM}` section instead — same-day runs accumulate.
- **Chat-only output.** The intake file is the artifact; it MUST hit disk before the report.

## Repeated runs via `/loop`

`/listen` is one-shot: it sweeps once and writes. To watch the gate repeatedly, wrap it with the built-in `/loop` primitive instead of building scheduling into the command:

```
/loop 1h /listen gate --only-if-red --no-commit
```

The stateful part is the flags, not a loop: the flags carry the state. `--only-if-red` plus `listen-gate-seen.json` is the "seen" memory (a red signature is recorded once, then every later poll is quiet until the failure changes or a passing gate run is recorded, after which the same failure coming back is reported again), and `--no-commit` keeps an unattended poll from committing. There is no internal poll loop in `/listen`, and there will not be one: `/loop` owns when to run, the flags own what is worth writing. A quiet poll writes nothing, not even a telemetry row, so a long-running loop leaves no trail until the gate is red.

`/loop` is session-scoped: it lives until the session ends or 7 days pass, whichever comes first, and it only fires while a session is open. For scheduling that survives a closed session or a reboot (a systemd user timer, the failure-only CI variant, the unattended run's caps and permission rules), use the scheduled-runs guide, `docs/reference/agents/guides/scheduled-runs.md`. The scheduled run does not call this command: its wrapper runs the same `--only-if-red` check and `--mark-seen` itself, from a pinned copy of `HEAD`, and gives the model no Bash and one writable intake file. `/listen gate` stays the interactive path.
