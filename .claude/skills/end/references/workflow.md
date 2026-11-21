# End Session

Write this session's handoff — a per-session, branch-tagged file under `docs/.output/handoffs/` that `/prime` reads next session. The path is resolved by `node .claude/core/handoff-path.js write end` (see the `session-handoff` skill); per-session files are how parallel branches avoid conflicting on a single shared handoff in PRs.

This is the end-of-session invocation of the handoff writer. `/do`, `/run-todo`, `/run-tests` and `/todo` also produce handoffs in their own pipelines, so `/end` after one of those is optional but gives a dedicated save point.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill`; without this self-log, fleet analytics under-count human-driven runs. Run it before anything else (best-effort; continue if it fails):

```bash
node .claude/core/telemetry-log.js end
```

## Shared writer

The handoff path resolver, template, fill rules and command-specific tailoring live in the **`session-handoff` skill** (`.claude/skills/session-handoff/SKILL.md`). Read it before writing; this command orchestrates.

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

**Authorship reconciliation (session-handoff Step 1):** the log may contain commits you did not author (the user, or a parallel agent on another branch). Run `git show --stat <hash>` on any you don't recognize and capture its intent in Decisions & Context; inspect the changes rather than inferring authorship from the message. Don't write the handoff from conversation memory alone, or real session work is dropped.

### 3. Write the handoff

Resolve this run's handoff path once and reuse it:

```bash
HANDOFF=$(node .claude/core/handoff-path.js write end)
```

Follow the `session-handoff` skill template. Tailor for the `/end` case (Step 4 in the skill): general session close, covering everything that happened this session.

Write `$HANDOFF` completely: do not append, and do not edit a prior run's handoff.

### 4. Commit the handoff (and prune old ones for this branch)

Finish the shared writer's memory-inbox review and finite intake lifecycle before the final staging/commit. That lifecycle can create project-owned `.agents/intake/identity.json` and `policy.json`, even when delivery is disabled. Review their exact changes, validate their project identity/policy, and retain them in this local handoff commit. A legacy project may still use `.agents/learning-intake/`; review and retain those exact two files instead. This is a narrow exception for reviewed intake configuration, not permission to stage the whole `.agents/` tree. Durable request/event records under `docs/.output/evolution/` are also retained when created by the authorized lifecycle; locks and scratch stay ignored. Committing configuration does not authorize GitHub delivery; delivery follows the existing project policy.

Refresh the master tracker from the per-epic checklists before committing — best-effort, silently no-ops if the project has no `TODO_{Project}.md` (offline + idempotent, always safe to call):

```bash
node .claude/core/status.js --regen-master
```

If it changed the master, it rides into the handoff commit below, staged on its own guarded line rather than in the main `git add` (an unmatched `docs/TODO_*.md` glob aborts the whole `git add` under zsh NOMATCH and leaves `$HANDOFF` unstaged).

Prune this branch's older handoffs to the newest 3 (keeping `$HANDOFF`), so the directory doesn't sprawl. `git rm` only files that are tracked; ignore the rest:

```bash
BR=$(node .claude/core/handoff-path.js branch)
# Handoffs are month-nested (docs/.output/handoffs/YYYY-MM/...-$BR.md), so a flat
# glob (docs/.output/handoffs/*-$BR.md) matches nothing (path-lint:keep), and under
# zsh an unmatched glob vanishes, turning `ls -1t <glob>` into a bare `ls -1t` of the
# repo root whose tracked files then get `git rm`'d. Use `find`.
# The grep anchors on the {stamp}-{caller}- boundary (handoff-path.js FILE_RE); a bare
# "*-${BR}.md" suffix also matches other branches whose slug ends in -$BR.
# Newest-3 sorts by basename (the {YYMMDD-HHMM} stamp is chronological); awk/sort/cut/grep
# are POSIX, while find -printf is GNU-only and fails silently on macOS/BSD.
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

Write the commit message to `docs/.output/.state/.commit-msg`:

```
docs: /end — {brief summary of session focus}
```

Then run:

```bash
git add "$HANDOFF"
# After reviewing the session-created/changed intake configuration, stage only
# the known existing ordinary files. Never use git add .agents/.
for intake_file in .agents/intake/identity.json .agents/intake/policy.json .agents/learning-intake/identity.json .agents/learning-intake/policy.json; do
  if [ -f "$intake_file" ] && [ ! -L "$intake_file" ]; then
    git add -- "$intake_file"
  fi
done
# Stage the master tracker ONLY if it exists — guarded so an unmatched glob never aborts the add (zsh NOMATCH):
ls docs/TODO_*.md >/dev/null 2>&1 && git add docs/TODO_*.md
node .claude/core/commit.js
```

### 5. Leave a clean tree (session cleanup)

The next session should not open on uncommitted old work. After the handoff commit, sweep up what this session left behind with a reviewed stage, never a blind `git add .`.

**First, before staging, surface the change-attribution ledger (S-PI.7).** Sub-agents dispatched this session edited files the lead did not author. Read today's ledger and present "files touched by which agent" so wrap-up attributes the working tree instead of guessing:
```bash
node .claude/core/_lib/attribution-ledger.js read
```
The ledger is day-rotated (`attribution-{YYMMDD}.jsonl`). If the session started before midnight, also read yesterday's file: `node .claude/core/_lib/attribution-ledger.js read {yesterday YYMMDD}`. Group the entries by agent and list the files each `{story_id}`/`{agent}` reported touching. Do not `git checkout`/revert a working-tree file the lead did not author without confirming with the user first. If a stray file in `git status` is not one the lead edited, describe it and ask; attribute nothing you cannot prove. An empty ledger means no sub-agent work this session.

```bash
git status --short
```

If the tree is already clean → skip to Step 6.

If anything remains, review the list before staging (the safety step behind the Post-Command Commit Convention's "stage specific files" rule):

1. For each remaining file, confirm it is genuine session output, not a secret, half-finished WIP, or an unrelated change that wandered in.
2. Stage the safe session zones only: tracked modifications plus new files under `docs/` and `.claude/` (this session's artifacts, system edits and reports):
   ```bash
   git add -u                       # tracked modifications + deletions
   git add docs/ .claude/           # new artifacts in the safe zones (gitignore already excludes memories/telemetry/sessions)
   ```
3. Do not auto-stage unrelated files outside those zones. The reviewed intake configuration named in Step 4 is the explicit exception and belongs in the session commit; never sweep the whole `.agents/` directory. List other new files in the repo root, `src/`, `tools/` or anywhere unexpected, and anything that looked like a secret or unfinished WIP, in the Report under "Left uncommitted (review these)" so the user decides.
4. Commit the swept files (skip if step 2 staged nothing):
   ```
   chore: /end — session cleanup ({N} stray files)
   ```
   Write the message to `docs/.output/.state/.commit-msg`, then run `node .claude/core/commit.js`.
5. Re-run `git status --short` to confirm. The tree is now clean, or the only remainder is the explicitly-surfaced out-of-zone files.

### 6. Show the user

Output the handoff content for review, and end with the **tree state**: either `Tree: clean ✓` or an explicit list of the out-of-zone files left uncommitted (with why each was held back).

## Automatic doc-drift surface (SessionEnd hook)

Independently of `/end`, the `session-end-doc-sync.cjs` hook fires on every `SessionEnd` and runs a lightweight, non-blocking doc-drift check (`detectDocDrift`: legacy/duplicate planning docs and misplaced TODOs only, not the full `/review:check-sync` cross-reference). On drift it writes a one-time notice to stderr and always exits 0, so it never blocks the session closing or the handoff being written. Silence the notice with `CLAUDE_NO_DOC_SYNC=1` (e.g. in `.claude/settings.local.json`). It is a passive safety net; `/end` neither triggers nor waits on it.

## Rules

All rules live in the `session-handoff` skill. Reminders specific to `/end`:

- **Commit, don't push.** `/end` commits the handoff and reviewed session output, including the exact intake configuration files, so the next session opens on a clean tree. Cleanup stays reviewed: explicit paths for intake, `docs/` and `.claude/` for session artifacts, and unrelated new files surfaced rather than swept in.
- **Memory acquisition happens in the session-handoff skill's Step 6** (the Main Agent writes 0-3 structured memories from handoff bullets that qualify as reusable learnings). Check the inbox first with `node .claude/core/memory-manager.js inbox-list`, then `inbox-promote`/`inbox-discard` each sub-agent draft. Promote only bullets that generalize (a pattern, constraint, workflow or rejected approach useful in a future session or new project), never pure project state or 24-hour gotchas. Score `importance` 1-5 (default 3) honestly on each write, since it is the decay retention floor. Zero qualifying bullets is the common, correct outcome. No auto-extraction fires from `/end` or any other command; the Stop hook still captures raw daily logs and runs the curator under `MEMORY_PROFILE=strict`. See `docs/.output/findings/reviews/2026-04-20-adr-memory-unification.md`.
- **Supersession confirm:** before committing the handoff (Step 4), review any write-time `supersedes_candidates` flags on memories created this session. If the new memory genuinely replaces the old one, confirm with `node .claude/core/memory-manager.js supersede <category> <oldId> <newId>`; otherwise skip. Nothing supersedes automatically. Skip this if no memories were created.
