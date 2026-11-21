# /evolve — Cycle Rollover (archive done, re-plan from reality)

The post-MVP lifecycle command that answers "the initial backlog is fully delivered — now what?". `/listen` gathers signals and `/triage` turns them into stories, but both assume a backlog still exists to append to. `/evolve` closes out the completed cycle, archives it without losing history, and re-plans cycle N+1 from production evidence rather than a blank interview. A good result is a committed, history-preserving archive, a fresh brief, PRD and backlog seeded with what the cycle actually taught, and a runnable lead-epic TODO.

It orchestrates existing commands (`/listen`, then `/create:project-brief` → requirements → epics) rather than reimplementing them. The new logic is the close-out gate, the archive, and seeding the re-plan with evidence.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill`. Log the invocation first so fleet analytics see human-driven runs (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js evolve
```

## Design basis

- **Archive, never delete.** The cycle's `backlog.md` and TODO files move to `docs/work/todo/_archive/cycle-{N}-{stamp}/` via `git mv` (history follows in log and blame), with a self-contained `_cycle-summary.md`. Deleting cycle history is never correct.
- **Evolve, don't restart.** Seed the re-plan with reality: what the cycle shipped, what production telemetry says (`/listen`), what the retros learned, what was deferred. A blank re-interview throws that away.
- **Reconcile before you force.** Never archive a half-done cycle, but unchecked is not the same as unfinished: on an actively worked repo the usual cause is trackers left stale after the work shipped. When git shows the open stories shipped, reconcile the trackers and archive clean; `--force` would falsely record shipped work as carried forward. `--force` stays the override for genuinely incomplete work.
- **The stack carries forward.** `architecture/overview.md` is not regenerated unless `--replan-arch`; a delivery cycle rarely changes the stack.
- **Orchestrate, don't reimplement.** Interactively, each chained sub-command commits its own work and `/evolve` commits the archive and summary. Headless, folding the chain into fewer commits is equally valid (adopter finding EV5): the contract is the artifacts (fresh brief, PRD, backlog and master TODO, plus a runnable lead-epic TODO, and a committed archive), not a commit count.
- **End runnable.** A re-plan that stops at the backlog recreates the "pick next epic, but there is no contract to run" stall one rung up. By default `/evolve` materializes only the lead epic into an execution-ready `TODO_epic*.md` (Step 5.6); later epics are broken down just in time.

## Variables

SCOPE: $ARGUMENTS

- `--force`: archive even with incomplete (`[ ]`/`[!]`) stories. The incomplete set is recorded in `_cycle-summary.md` under "Unfinished, carried forward" and seeded into the next backlog, never silently dropped.
- `--dry-run`: report the close-out plan (what would be archived, the evidence digest, the re-plan path) and write nothing: no archive, no `git mv`, no sub-command invocation, no commit. The one-line telemetry row at the top still fires.
- `--replan-arch`: also regenerate `architecture/overview.md`.
- `--no-todo`: skip Step 5.6 and stop at the backlog (to hand-pick the first epic, or re-prioritize before breaking anything down). Default is on.
- A trailing free-text cycle label, folded into the archive dir and summary (`/evolve "MVP launch"` → `cycle-1-260606-mvp-launch/`). Optional.

## Output

- `docs/work/todo/_archive/cycle-{N}-{stamp}[-{label}]/`: the archived `backlog.md`, `TODO_{Project}.md`, `TODO_epic*.md`, snapshots of the cycle's `product/brief.md` and `product/requirements.md`, and `_cycle-summary.md`.
- `docs/work/backlog.md` and `docs/TODO_{Project}.md`: fresh, for cycle N+1.
- `docs/product/brief.md` and `docs/product/requirements.md`: regenerated for cycle N+1 (old copies live in the archive).
- `docs/work/todo/TODO_epic{NN}_{slug}.md`: the lead epic's execution-ready checklist (Step 5.6, unless `--no-todo`), the file `/run-todo` and `/do` consume.
- `docs/.output/.state/work/{stamp}/evolve-evidence.md`: the evidence digest that seeded the re-plan. It is ignored scratch input to Steps 5 and 5.6 and is never committed; `_cycle-summary.md` is the tracked record of what seeded cycle N+1.

`{stamp}` is one `date +%y%m%d-%H%M` run stamp computed at the start and reused verbatim everywhere (the Run-Stamp Convention in `.agents/startup-reference.md`), so a same-day re-run never collides.

## Workflow

### Step 1: Gate — is the cycle closeable?

Compute `STAMP=$(date +%y%m%d-%H%M)` once. Detect the project name (the `docs/TODO_*.md` filename, else `product/context.md`, else the repo basename). Read `docs/work/backlog.md`, `docs/TODO_{Project}.md` and every `docs/work/todo/TODO_epic*.md`, and tally story checkboxes: `[x]` done, `[ ]` open, `[~]` deferred, `[!]` blocked. Checkboxes decide the gate.

**Emoji cross-check (EV4).** `backlog.md` and `TODO_{Project}.md` often carry an emoji Story-Index (✅ done, ⬜ todo, 🔲) beside or instead of checkboxes. Compare the two views per story. Where they disagree, print a warning naming file, line and both values: a checkbox-only tally is blind to a stale representation. Disagreement alone does not block (checkboxes win), but if the emoji view would make the cycle look incomplete while the checkboxes say done, say so in the report so the human can confirm the code shipped before sealing. A file with only emoji is tallied from the emoji, and there ⬜/🔲 and any non-✅ state carry the same gate weight as `[ ]`; otherwise an incomplete emoji-only file passes the gate and gets archived.

**Gate decision: reconcile, stop or force.** If any `[ ]`/`[!]` story (or non-✅ emoji state) exists and `--force` is not set, check the open set against git and gate reality before deciding. For each open story or its epic, look for a completion commit in `git log` referencing it, the feature present in the code, and a green build and test gate (`docs/.output/.state/telemetry/_latest-summary.json` `overall`, or `node .claude/core/gate.js test`).

- **Reconcile** (preferred when reality says done). If the open stories map to epic-complete commits and the gate is green, the trackers are stale, not the work, and `--force` would be wrong. Confirm with the user via `AskUserQuestion` (for example "git shows epics {X,Y} shipped and the gate is green, but {K} checkboxes are still `[ ]`. Reconcile the trackers to git reality, then archive?"). On confirm, rewrite `[ ]` to `[x]` (and ⬜/🔲 to ✅) only for stories git corroborates, commit that reconciliation on its own (`docs: /evolve — reconcile cycle {N} trackers to git reality before archive`), then archive as a clean, complete cycle. EV4 detects the drift; this resolves it (memory `evolve-reconcile-tracker-drift-before-archive`).
- **Stop** (work genuinely incomplete). If git does not corroborate the open stories (no completion commits, feature absent, or gate red), the trackers are right. STOP, print the incomplete stories (file and line), and:

  ```
  Cycle not complete — {K} stories still open/blocked, and git does not show them shipped.
  Finish them (/do, /run-todo), or re-run with --force to archive anyway (incomplete items carry forward).
  ```
- **Force** (explicit override). `--force` archives regardless and records the incomplete set under "Unfinished, carried forward". Use it to deliberately carry genuinely incomplete work forward, never to paper over stale trackers.

A gate means resolve the prerequisite, then resume (CLAUDE.md gate posture, F3). Reconcile is that resolution when the work is done but untracked, and it is never offered when git cannot corroborate the work, since that would be a silent `--force` sealing an incomplete cycle.

Determine cycle number **N** as the highest existing cycle number plus one, not a directory count: parse `^cycle-(\d+)-` from each `docs/work/todo/_archive/cycle-{NN}-*` dir and take `max(NN) + 1` (a count miscomputes N when `_archive/` holds a stray or aborted dir). With no such dirs this is cycle 1, the original `/create:new-project` backlog. State N, the project name and the completion tally in the report.

### Step 2: Gather re-planning evidence

This is what makes it evolve and not restart. Collect, then synthesize into the evidence digest:

- **2a. Production signals.** Take the newest `docs/.output/evolution/intake/*.md`. Staleness is coverage-based, not mtime-based: an intake is fresh only if it covers this cycle's work, so a same-day file that predates the cycle is stale (one intake was same-day but from an earlier epic's era). The cycle window starts at the most recent `_archive/cycle-*` date (or the cycle's first commit for cycle 1) and ends at `HEAD`. Read the intake's `generated:` frontmatter timestamp (file mtime only if absent); it is stale if `git log --oneline --since="<intake generated>"` still shows substantive feature commits from the cycle, not just the chore, handoff and intake commits that followed it. If stale or missing, run `/listen` for a fresh sweep, except under `--dry-run` (`/listen` writes and commits an intake, violating the writes-nothing contract): read the existing intake only and report "(would refresh stale intake — predates the cycle's commit range)".
- **2b. Lessons.** Every `docs/.output/findings/reviews/retro-*.md` from this cycle. A cycle with no retros re-plans on thinner evidence; say so.
- **2c. Deferred and waiting work.** The triage ledger `docs/.output/evolution/triage/_decisions.md` (deferred items whose revisit window has arrived) and `docs/work/todo/feature-ideas.md`: candidate cycle N+1 stories.
- **2d. What shipped.** The `[x]` stories from the backlog about to be archived, plus headline commits since the cycle's first commit or the prior archive date.
- **2e. Session decisions and pivots.** On a repo where real work happened in-session, this is the highest-signal input (adopter finding EV3). Read the memory store (`node .claude/core/memory-manager.js report` and `search` on the project's themes) for recent high-importance `decisions`, `patterns` and `workflows`, and scan the newest `docs/.output/.state/memory-daily/*.md` for in-session pivots not yet promoted to a memory or to `feature-ideas.md`. Daily logs are local-only (gitignored), so an unpromoted pivot never travels in git and is lost unless read here.

Synthesize everything into the close-out narrative for Step 4 and the seed for Step 5. If a session pivot or decision from 2e contradicts or extends the shipped vision, name it explicitly in the digest; the cycle N+1 brief must honor it, not silently re-derive cycle N's direction.

### Step 3: Archive the completed cycle (skip all writes under `--dry-run`)

Create `docs/work/todo/_archive/cycle-{N}-{STAMP}[-{label-slug}]/` and move the cycle's files in with `git mv`, each file individually with an existence guard. Never pass a bare `TODO_epic*.md` glob to `git mv`: a `--no-todo` cycle has no such files, an unexpanded glob makes `git mv` fail atomically, `backlog.md` is left un-moved, and Step 5 then regenerates over it, silently destroying the un-archived backlog. Fall back to plain `mv` for an untracked file:

```bash
ARCH=docs/work/todo/_archive/cycle-{N}-{STAMP}[-{label-slug}]
mkdir -p "$ARCH"
for f in docs/work/backlog.md docs/TODO_{Project}.md docs/work/todo/TODO_epic*.md; do
  [ -e "$f" ] || continue                      # skip globs that didn't expand
  git mv "$f" "$ARCH/" 2>/dev/null || mv "$f" "$ARCH/"
done
```

Assert the archive is populated before Step 5: `backlog.md` must now be inside `$ARCH/` and absent from `docs/work/todo/`. If not, STOP; do not let Step 5 regenerate over an un-archived backlog.

Snapshot the cycle's planning context into the archive too. These are copies (the create-chain overwrites the live files in Step 5), guarded so a missing or stub doc cannot abort mid-archive; say in the summary that they are content copies, not history-preserving moves:

```bash
for f in docs/product/brief.md docs/product/requirements.md; do
  [ -e "$f" ] && cp "$f" "$ARCH/"
done
```

Do not archive `feature-ideas.md`: it bridges cycles and carries forward.

### Step 4: Write `_cycle-summary.md` (skip if `--dry-run`)

Into the archive dir, so the folder alone tells the story of cycle N:

```markdown
# Cycle {N} Summary — {Project} {label}

**Closed:** {YYYY-MM-DD}  ·  **Span:** {first commit date} → {today}  ·  **Stamp:** {STAMP}
**Completion:** {D} done / {O} open / {DF} deferred / {B} blocked  ({pct}%)

## What shipped
- Epic {NN}: {title} — {n} stories ({headline commits})
- ...

## What production is telling us  (from /listen intake {date})
- {top signals, by source}

## Lessons  (from {n} retros)
- {key pattern / what worked / what didn't}

## Carried forward to cycle {N+1}
- Deferred (triage ledger / feature-ideas): {items}
- Unfinished, carried forward (only if --force): {open/blocked stories}
```

### Step 5: Regenerate the plan for cycle N+1 (skip if `--dry-run`)

Write the Step 2 synthesis to `docs/.output/.state/work/{STAMP}/evolve-evidence.md` as upstream context (vision-relevant signals, validated demand from shipped scope, lessons, carried-forward items). Then chain the planning pipeline, each invocation seeded with that digest as context (the way `/create:new-project` passes interview answers down). Regeneration is safe because Step 3 snapshotted the live docs:

1. `/create:project-brief`: pass the digest as input context (Context Mode) and answer "replace" when it detects the existing brief.
2. `/create:project-requirements`: a delta PRD from the new brief and evidence.
3. `/create:project-architecture`: skipped unless `--replan-arch`.
4. `/create:project-epics`: a fresh `docs/work/backlog.md` seeded with the carried-forward deferred items as candidate stories.
5. `/create:project-todo`: regenerate the master `docs/TODO_{Project}.md` index.

The active `docs/work/todo/` workspace now holds a clean cycle N+1 backlog; cycle N lives entirely in `_archive/`.

### Step 5.6: Materialize the lead epic's execution-ready TODO (skip if `--dry-run` or `--no-todo`)

Without this the report's `Next:` line points at `/run-todo` or `/do {first story}` with no per-epic `TODO_epic*.md` behind it, and neither can run.

- Pick the lead epic: the first dependency-root epic in the fresh backlog (lowest-numbered, no unmet dependencies). Materialize only it; later breakdowns shift as it is built. When it finishes, `/todo` with no argument auto-resolves the next epic from the master index, so the loop continues without re-running `/evolve`.
- Chain `/create:project-epics-todo {lead epic}` to produce `docs/work/todo/TODO_epic{NN}_{slug}.md`, then `/todo {lead epic}` to make it execution-ready (AC, file lists from real codebase research, wave plan); `/todo` reads the epic's stories from `backlog.md`. Seed both with the evidence digest. Both write the same epic-keyed file and `/todo` enriches it in place (epic-keyed files are a deliberate run-stamp exception), so running `/todo` over an already-adequate `/create:project-epics-todo` output is still valid and adds the file lists `/run-todo` trusts.
- The Step 7 `Next:` line points at this real file: `/run-todo docs/work/todo/TODO_epic{NN}_{slug}.md` (or `/do {first story id}`).
- With `--no-todo`, skip all of this and let Step 7 say the cycle is planned, not yet broken down: `Next: /create:project-epics-todo {lead epic}` then `/todo {lead epic}`.

### Step 6: Commit (skip if `--dry-run`)

The chained sub-commands commit their own regenerated docs per the Post-Command Commit Convention. This step commits only what `/evolve` produced: the archive dir (git-mv'd files, snapshots, `_cycle-summary.md`). The evidence digest stays in ignored scratch, since `git add` refuses ignored paths.

Follow the Post-Command Commit Convention in `.agents/startup-reference.md`. Stage specifically, never `git add .`:

```bash
git add docs/work/todo/_archive/cycle-{N}-{STAMP}/
```

Write the message to `docs/.output/.state/.commit-msg` (inline `git commit -m` is blocked), then run `node .claude/core/commit.js`:

```
feat: /evolve — cycle {N} archived, cycle {N+1} planned

{one-line: what shipped in N, what seeds N+1}
```

### Step 7: Report

```
## /evolve — cycle {N} → {N+1}

**Project:** {name}  ·  **Cycle {N} completion:** {pct}% ({D}/{total})
**Archive:** docs/work/todo/_archive/cycle-{N}-{STAMP}/
**Commit:** {hash, or "dry-run — nothing written"}

### Cycle {N} closed
- Shipped: {epic/story headline counts}
- Lessons folded in: {n retros, n intake signals}

### Cycle {N+1} planned
- Brief: {1-line new vision}
- Backlog: {epic count} epics, {story count} stories ({n} carried forward from deferred)
- Architecture: {regenerated | carried forward unchanged}
- Lead epic made ready: {`TODO_epic{NN}_{slug}.md` — {story count} stories | skipped (--no-todo)}

**Next:** `/review:check-readiness` to validate the new cycle, then:
- (default) `/run-todo docs/work/todo/TODO_epic{NN}_{slug}.md` — the lead epic is execution-ready.
- (if `--no-todo`) `/create:project-epics-todo {lead epic}` then `/todo {lead epic}` to break down the lead epic first.
```

Under `--dry-run`, render the same report with each write marked *(would write)* and end with the literal: `Dry run — nothing archived or regenerated.`

The archive, summary, evidence digest, fresh backlog and lead-epic TODO hit disk before the report (except under `--dry-run`, which writes nothing and says so). If there is genuinely no evidence (no intake, no retros, no deferred work), say so plainly in the report; do not invent a v2 vision.
