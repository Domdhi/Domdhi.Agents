# /triage — Signal → Backlog Decision Loop

The decision half of the post-MVP loop (Tier 2). `/listen` gathers push-from-reality signals into a dated intake file without ranking them; `/triage` reads the newest intake plus the `feature-ideas.md` inbox, decides what each item is worth, and turns the keepers into ranked backlog stories. A good run asks the user only about genuine judgment calls, leaves a durable record of every decision, and never makes anyone re-adjudicate a signal twice.

Two sources drain into the one plan of record, `backlog.md`: `/listen` intake (signals) and `feature-ideas.md` (the raw idea inbox written by `/brainstorm`). Per the planning-doc-lifecycle ADR (`docs/.output/findings/reviews/2026-06-13-adr-planning-doc-lifecycle.md` §2) the inbox is a frictionless capture surface that must drain into the backlog, never become a second one; `/triage` is that ongoing drain (the greenfield drain is `/create:project-epics`). The pairing: `/listen` (gather, no opinions) → `/triage` (decide, minimal questions) → backlog → `/do` / `/run-todo`.

## Telemetry (run first)

A user-typed command does not fire `PostToolUse:Skill`, so log the invocation yourself (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js triage
```

## Design basis

- **Severity is not Priority.** Severity is the objective technical impact of a signal, scored mechanically with no user input (Step 3). Priority is the business decision whether and when to act, the disposition (Steps 4-5), where user judgment enters. A high-severity signal can be correctly deferred.
- **Frameworks are lenses.** Promoted items are ordered by a light ICE score (Impact × Confidence × Ease) and tagged MoSCoW, surfaced so the user can override. No RICE/WSJF ceremony for a solo or small team.
- **Decisions are durable.** Kills and defers go into an append-only ledger so the next sweep does not re-surface them. State machine: `intake → triaged → {promoted | deferred | killed | researching}`.
- **Auto-decide the obvious.** The Mechanical / Taste / User-Challenge model is the same as `/do` Step 6c; only User-Challenge signals reach an `AskUserQuestion`.

## Variables

SCOPE: $ARGUMENTS

- An intake file path or `{YYYY-MM-DD}` date triages that file; the default is the newest `docs/.output/evolution/intake/*.md`.
- `--dry-run` classifies and reports but writes nothing: no backlog append, ledger write, intake/inbox markers or commit.
- `--ideas-only` skips the intake and drains only `feature-ideas.md` (for after a `/brainstorm` dump with no fresh intake).

By default the resolved intake file and `docs/work/todo/feature-ideas.md` are folded into one triage set. Naming an intake file or date still drains the inbox unless `--ideas-only` is passed, which inverts it: inbox only.

## Output

- `docs/work/backlog.md`: promoted signals appended as stories under a `## Triage Intake` epic (created if absent).
- `docs/.output/evolution/triage/{YYYY-MM-DD}.md`: the run record, day-rotated (append `## Run {HH:MM}` if today's file exists; never overwrite).
- `docs/.output/evolution/triage/_decisions.md`: the append-only decision ledger, one line per kill/defer with a fingerprint and reason. It is the anti-resurfacing memory.
- The source intake file: each bullet annotated inline with its disposition.
- `docs/work/todo/feature-ideas.md`: each drained idea annotated inline with the same markers. The inbox is never deleted from or archived; the annotation is the drain record, so a promoted idea reads `✅ promoted → Story T.{n}` rather than vanishing.

## Workflow

### Step 1: Resolve the sources

- **Intake** (unless `--ideas-only`): the file or date `SCOPE` names, else the newest in `docs/.output/evolution/intake/`.
- **Inbox:** `docs/work/todo/feature-ideas.md` if it exists, unless `SCOPE` names a specific intake and that is clearly the only intent. Its un-drained bullets are triage input (Step 2).
- Read the resolved files and the ledger `docs/.output/evolution/triage/_decisions.md` if present.
- If **both** sources are absent or empty, stop and tell the user to run `/listen` (signals) or `/brainstorm` (ideas) first; a populated `feature-ideas.md` alone is enough to proceed. Do not invent signals.
- The report states the resolved sources (intake file, whether the inbox was drained) and the ledger status.

### Step 2: Parse, de-dupe, suppress what is already decided

- **Intake signals:** every bullet across all `## Run` sections, shaped `- [origin: {source}] {signal} — {why}`.
- **Feature ideas:** freeform `/brainstorm` output with no fixed schema (plain bullets, maybe headings). Normalize each to `[origin: feature-ideas] {idea text} — (idea inbox)`. Skip any bullet already carrying a disposition marker (`✅ promoted` / `⏸ deferred` / `❌ killed` / `🔬 research`); a prior run drained it.
- De-duplicate across both sources (an idea that also surfaced as a `/listen` backlog-drift signal is one item).
- **Ledger:** fingerprint each item (origin plus its key noun phrase, e.g. `git:expiring-flag:payment-shim`, `feature-ideas:bulk-csv-export`). One that appears in `_decisions.md` as `killed`, or as `deferred` with a revisit date not yet reached, is suppressed. Count suppressions and report them ("N items suppressed by prior triage decisions").

What remains is the triage set.

### Step 3: Score Severity (objective, no user)

Anchor Severity to observable impact, not stakeholder urgency, and never ask the user for it.

| Severity | Rule of thumb |
|----------|---------------|
| **Critical** | data loss, security/credential exposure, broken core workflow with no workaround, production-down |
| **High** | major functionality broken for a real segment; recurring gate/build failure; a **past-due** cleanup obligation (expired flag, `remove after {past-date}`); any security/privacy finding regardless of functional reach |
| **Medium** | degraded-but-usable behavior; churn hotspot (maintenance risk); an actionable agent-update not yet folded in |
| **Low** | cosmetic, one-off TODO/FIXME marker, minor drift, nice-to-have |

Security and data-privacy signals are never below High, even when functional impact looks small.

### Step 4: Classify the decision type and pre-decide

Classify the decision (not the severity) with the `/do` Step 6c model and pre-resolve the non-judgment ones:

| Decision type | Examples | Action |
|---------------|----------|--------|
| **Mechanical** (one correct answer) | already resolved in git → **kill**; exact duplicate of a backlog story or ledger entry → **kill (merge)**; past-due cleanup obligation → **promote** | Decide silently. |
| **Taste** (low-stakes, reversible) | clear maintenance bug of obvious value → **promote**; low-severity noise with no near-term value → **defer** | Decide and log the call in the run record so the user can course-correct. |
| **User Challenge** (shapes product direction, adds scope, or genuinely ambiguous intent) | a feature-shaped signal; "should we even support X?"; anything that meaningfully constrains the project's future | Always ask (Step 5); never auto-decide. |

The four dispositions:

- **promote**: becomes a backlog story now.
- **defer**: not now; recorded with a revisit hint (and optional date) and kept out of sweeps until then.
- **kill**: won't do, with the reason recorded so it does not come back next `/listen`. A kill without a reason is not allowed.
- **research**: can't be sized yet; becomes a research-tagged backlog item pointing to `/research` or `/investigate`.

### Step 5: Interview only the User-Challenge signals

Mechanical and Taste are already decided; bring only the User-Challenge signals to the user, so the command never asks one question per signal.

- Use `AskUserQuestion` under `/interview`'s limits: at most 4 questions per round and 3 rounds, concrete options, headers of 12 characters or fewer, the recommended disposition first and marked "(Recommended)".
- Options per signal: **Promote / Defer / Kill / Research**, plus free-text "Other".
- With more than about 12 User-Challenge signals, triage the highest-Severity ones and defer the tail with an explicit note in the report; a silent cap reads as "triaged everything".
- End with a plain-chat summary of every disposition. The `Elicitation` hook does not fire for `AskUserQuestion` (Issue #44326), so this summary is the only downstream-observable record of the decisions; `/end` and memory-acquisition read it, not the multiple-choice UI.

### Step 6: Score and order the promoted set (ICE + MoSCoW)

For each promoted item, compute (agent-side, no user questions):

- **ICE** = Impact (1-5) × Confidence (1-5) × Ease (1-5); higher means sooner, and Ease is the inverse of effort (5 = trivial).
- **MoSCoW**: `Must` (Critical/High severity blocking real use), `Should` (clear value, not blocking), `Could` (nice-to-have).

Order the promoted stories by ICE descending before appending, so the backlog insert is pre-ranked. If the user disagrees in the Step 5 summary, take their ordering.

### Step 7: Apply dispositions and persist (skip all writes under `--dry-run`)

Everything reaches disk before the report; chat-only triage is lost on compaction.

**7a. Promote.** Append stories to `docs/work/backlog.md` under the `## Triage Intake` epic in the project-planning story format:

```
* **Story T.{n} ({Domain}): {Title}**
  * **As a** {persona}, **I want** {capability}, **So that** {benefit}.
  * **AC:**
    * {criterion}
  * **Estimate:** {S/M/L/XL}   ·   **Severity:** {Critical/High/Medium/Low}
  * **ICE:** {I}×{C}×{E} = {score}   ·   **MoSCoW:** {Must/Should/Could}
  * **Source:** [origin: {source}] {signal}  ·  triaged {YYYY-MM-DD}
  * **Dependencies:** {None | Story X.Y}
```

**7b. Kill / Defer.** Append to the ledger `docs/.output/evolution/triage/_decisions.md`:

```
- {YYYY-MM-DD} · {fingerprint} · **killed** — {reason}
- {YYYY-MM-DD} · {fingerprint} · **deferred** until {revisit hint/date} — {why}
```

**7c. Research.** Append a spike story to the backlog (`Estimate: spike`, AC "the open question is answered") and note the suggested follow-up (`/research` or `/investigate`).

**7d. Annotate each source inline.** Append a marker to each triaged bullet in whichever file it came from (intake and/or `feature-ideas.md`):
`✅ promoted → Story T.{n}` · `⏸ deferred: {hint}` · `❌ killed: {reason}` · `🔬 research: {spike}`
Drained idea bullets stay in place; the marker is what Step 2 skips on the next run.

**7e. Run record.** Write `docs/.output/evolution/triage/{YYYY-MM-DD}.md` (`## Run {HH:MM}` if the file exists): the decision table (signal · severity · decision-type · disposition · ICE/reason).

### Step 8: Commit (main agent; skip under `--dry-run`)

Follow the **Post-Command Commit Convention** in `.agents/startup-reference.md`. Stage the backlog, the intake file, `feature-ideas.md` (if drained), the triage run record and the ledger. Write the message to `docs/.output/.state/.commit-msg`, then run `node .claude/core/commit.js` (inline `git commit -m` is blocked).
Message: `docs: /triage — {P} promoted, {D} deferred, {K} killed ({YYYY-MM-DD})`.

### Step 9: Report

```
## /triage — {YYYY-MM-DD}

**Intake:** {resolved file, or "none — --ideas-only"}  ·  **Inbox:** {`feature-ideas.md`: M ideas drained, or "not present"}  ·  **Ledger:** {N suppressed by prior decisions}
**Commit:** {hash, or "dry-run — nothing written"}

| Disposition | Count |
|-------------|-------|
| Promoted | {P} |
| Deferred | {D} |
| Killed | {K} |
| Research | {R} |
| Suppressed (prior) | {S} |

**Promoted (by ICE):**
1. Story T.{n} — {title} (Sev {x}, ICE {score}, {MoSCoW})

**Auto-decided (Taste — review if you disagree):**
- {signal} → {disposition}: {one-line why}

**Next:** `/review:optimize-backlog` to slot the new stories, or `/do` the top one.
```

An empty triage set (everything suppressed, or no live signals) is a healthy steady state: say so plainly; the run record still notes that the sweep happened.

## Note: the two drains, and forward-looking suppression

The inbox is never a second backlog and is never archived (unlike `backlog.md`/`TODO_*`, which `/evolve` archives at cycle rollover). The drain is non-destructive: drained ideas are annotated in place and the ledger suppresses killed or deferred ones. Suppression works at both ends: `/triage` writes and consults the ledger, and `/listen` also reads it at gather-time (see `/listen` Step 1b) so adjudicated signals do not re-enter intake.
