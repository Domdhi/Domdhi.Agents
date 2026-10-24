# End Session

Write this session's handoff — a per-session, branch-tagged file under `docs/.output/handoffs/` that `/prime` reads next session. The path is resolved by `node .claude/core/handoff-path.js write end` (see the `session-handoff` skill); per-session files are how parallel branches avoid conflicting on a single shared handoff in PRs.

This command is the **end-of-session** invocation of the handoff writer. `/do`, `/run-todo`, `/run-tests`, and `/todo` also produce handoffs as part of their own pipelines, so running `/end` after one of those is optional — but it's harmless and gives you a dedicated save point.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js end
```

## Shared writer

The handoff path resolver, template, fill rules, and command-specific tailoring all live in the **`session-handoff` skill** (`.claude/skills/session-handoff/SKILL.md`). Read it before writing. That skill is the single source of truth for where the handoff lives and what goes in it; this command is the orchestrator.

## Steps

### 1. Organize loose files

```bash
node .claude/hooks/organize.cjs
```

### 2. Gather live state (per the skill, Step 1 + 2)

```bash
git status --short
git log --oneline -10
ls docs/.output/plans/**/*.md 2>/dev/null
```

Check unfinished plans (grep for `- [ ]` in each plan file).

**Authorship reconciliation (session-handoff Step 1):** the log may contain commits you did NOT author — the user, or a parallel agent on another branch. `git show --stat <hash>` any commit you don't recognize and capture its intent in Decisions & Context. Inspect the changes directly rather than inferring authorship from the message. Don't write the handoff from conversation memory alone, or you'll silently drop real session work.

### 3. Write the handoff

Resolve this run's handoff path once and reuse it:

```bash
HANDOFF=$(node .claude/core/handoff-path.js write end)
```

Follow the `session-handoff` skill template. Tailor for the `/end` case (Step 4 in the skill): general session close, covering everything that happened this session.

**Write `$HANDOFF` completely.** Never append, and never reach back to edit a prior run's handoff.

### 4. Commit the handoff (and prune old ones for this branch)

Refresh the master tracker from the per-epic checklists before committing — best-effort, silently no-ops if the project has no `TODO_{Project}.md` (offline + idempotent, always safe to call):

```bash
node .claude/core/status.js --regen-master
```

If it changed the master, it rides into the handoff commit below — staged on its **own guarded line**, never folded into the main `git add` (an unmatched `docs/TODO_*.md` glob aborts the whole `git add` under zsh NOMATCH and leaves `$HANDOFF` unstaged).

Prune this branch's older handoffs to the newest 3 (keeping `$HANDOFF`), so the directory doesn't sprawl. `git rm` only files that are tracked; ignore the rest:

```bash
BR=$(node .claude/core/handoff-path.js branch)
# Handoffs are month-nested (docs/.output/handoffs/YYYY-MM/...-$BR.md), so a FLAT
# glob (docs/.output/handoffs/*-$BR.md) matches nothing (path-lint:keep) — and under zsh an unmatched
# glob VANISHES, degrading `ls -1t <glob>` into a bare `ls -1t` that lists the repo
# ROOT, whose tracked files then get `git rm`'d (package.json, README.md, ...). Use
# `find` (deterministic, recurses the month dirs, never lists cwd on empty).
# The grep anchors the match on the {stamp}-{caller}- boundary (handoff-path.js
# FILE_RE) — a bare "*-${BR}.md" suffix glob also matches OTHER branches whose
# slug merely ends in -$BR (pruning `foo` must not delete `bar-foo` handoffs).
# Newest-3 selection sorts by BASENAME: the {YYMMDD-HHMM} stamp prefix is
# chronological, and awk/sort/cut/grep are POSIX (find -printf is GNU-only and
# fails SILENTLY on macOS/BSD — stderr is discarded — turning prune into a no-op).
find docs/.output/handoffs -type f -name "*-${BR}.md" 2>/dev/null \
  | grep -E '/[0-9]{6}-[0-9]{4}-(run-todo|run-tests|end|do|todo)-'"${BR}"'\.md$' \
  | awk -F/ '{print $NF "\t" $0}' | sort -r | tail -n +4 | cut -f2- \
  | while read -r f; do
      case "$f" in
        docs/.output/handoffs/*) git rm -q "$f" 2>/dev/null || true ;;
        *) : ;;  # never touch anything outside the handoffs tree
      esac
    done
```

Write the commit message to `docs/.output/.state/.commit-msg` (Write tool — no shell escaping):

```
docs: /end — {brief summary of session focus}
```

Then run:

```bash
git add "$HANDOFF"
# Stage the master tracker ONLY if it exists — guarded so an unmatched glob never aborts the add (zsh NOMATCH):
ls docs/TODO_*.md >/dev/null 2>&1 && git add docs/TODO_*.md
node .claude/core/commit.js
```

### 5. Leave a clean tree (session cleanup)

**Goal: the next session must NOT open on uncommitted old work.** After the handoff commit, sweep up anything this session left behind — but *reviewed*, never a blind `git add .`.

**First, surface the change-attribution ledger (S-PI.7) — BEFORE staging.** Sub-agents dispatched this session edited files the lead did not author. Read today's ledger and present "files touched by which agent" so wrap-up attributes the working tree instead of guessing:
```bash
node .claude/core/_lib/attribution-ledger.js read
```
The ledger is day-rotated (`attribution-{YYMMDD}.jsonl`). If this session started before midnight, also read yesterday's file so an overnight session's earlier dispatches aren't missed: `node .claude/core/_lib/attribution-ledger.js read {yesterday YYMMDD}`. Group the entries by agent and list the files each `{story_id}`/`{agent}` reported touching. **Never `git checkout`/revert a working-tree file the lead did not author without confirming with the user first.** If a stray file in `git status` is not one the lead edited, *describe it and ask* — do not attribute it to anyone, and do not revert it on a hunch. Attribute nothing you cannot prove; surface, then ask. (Empty ledger → no sub-agent work this session; proceed normally.)

```bash
git status --short
```

If the tree is already clean → skip to Step 6.

If anything remains, **review the list before staging** (this is the safety step the Post-Command Commit Convention's "stage specific files" rule protects):

1. **Read what's there.** For each remaining file, confirm it's genuine session output, not a secret, half-finished WIP you shouldn't freeze, or an unrelated change that wandered in.
2. **Stage the safe session zones only** — tracked modifications plus new files under `docs/` and `.claude/` (this session's artifacts, system edits, and reports):
   ```bash
   git add -u                       # tracked modifications + deletions
   git add docs/ .claude/           # new artifacts in the safe zones (gitignore already excludes memories/telemetry/sessions)
   ```
3. **Do NOT auto-stage anything outside those zones** — new files in the repo root, `src/`, `tools/`, or anywhere unexpected. List them in the Report under "Left uncommitted (review these)" so the user decides deliberately. Same for anything that looked like a secret or unfinished WIP in step 1.
4. Commit the swept files (skip if step 2 staged nothing):
   ```
   chore: /end — session cleanup ({N} stray files)
   ```
   Write the message to `docs/.output/.state/.commit-msg`, then `node .claude/core/commit.js`.
5. Re-run `git status --short` to confirm. The tree is now clean, or the only remainder is the explicitly-surfaced out-of-zone files.

### 6. Show the user

Output the handoff content for review, and end with the **tree state**: either `Tree: clean ✓` or an explicit list of the out-of-zone files left uncommitted (with why each was held back).

## Automatic doc-drift surface (SessionEnd hook)

Independently of `/end`, the `session-end-doc-sync.cjs` hook fires on every `SessionEnd` and runs a lightweight, **non-blocking** doc-drift check (`detectDocDrift` — legacy/duplicate planning docs and misplaced TODOs only, not the full `/review:check-sync` cross-reference). If it finds drift it writes a one-time notice to stderr; it **always exits 0 and never blocks the session from closing or the handoff from being written.** Silence its notice with `CLAUDE_NO_DOC_SYNC=1` (env var, e.g. in `.claude/settings.local.json`). This is a passive safety net, not part of the `/end` flow — `/end` neither triggers nor waits on it.

## Rules

All rules live in the `session-handoff` skill — read them there. A few reminders specific to `/end`:

- **Commit, don't push.** `/end` commits the handoff *and* sweeps up any other session work into a cleanup commit (Step 5) so the next session opens on a clean tree — but it does NOT auto-push. The user decides when to push. The cleanup is *reviewed*, never a blind `git add .`: only the `docs/` and `.claude/` safe zones are auto-staged; anything outside them is surfaced for a deliberate decision, not committed.
- **Memory acquisition happens via the session-handoff skill's Step 6** (Main Agent writes 0–3 structured memories from handoff bullets that qualify as reusable learnings). The skill has the full procedure; the load-bearing rules are: **(a) check the inbox first** — `node .claude/core/memory-manager.js inbox-list`, then `inbox-promote`/`inbox-discard` each sub-agent draft; **(b) only promote bullets that generalize** — a pattern, constraint, workflow, or rejected-approach useful on a *future* session or a new project, never pure project state or 24-hour gotchas; **(c) score `importance` 1–5** (default 3) on each write — it's the decay retention floor, so be honest. Zero qualifying bullets is the common, correct outcome — don't manufacture memories to fill a quota. No auto-extraction fires from `/end` or any other command. The Stop hook still captures raw daily logs and runs the curator under `MEMORY_PROFILE=strict`. See `docs/.output/findings/reviews/2026-04-20-adr-memory-unification.md`.
- **Supersession confirm:** Before committing the handoff (Step 4), review any write-time `supersedes_candidates` flags that were attached to memories created this session. For each flagged pair, decide: if the new memory genuinely replaces the old one, confirm by running `node .claude/core/memory-manager.js supersede <category> <oldId> <newId>`; otherwise skip it. This is always flag-then-confirm — nothing supersedes automatically. If no memories were created this session, skip this step.
