---
name: finishing-a-development-branch
description: "Use WHEN implementation is complete on a development branch and tests pass — guides the choice between merging locally, creating a PR, keeping, or discarding, and handles worktree cleanup."
metadata:
  version: 1.1.0
  author: Domdhi.Agents
  tags: [git, workflow, branching, integration]
user-invocable: false
allowed-tools: Read Bash
---

<!-- Generated from .agents/skills/finishing-a-development-branch/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Finishing a Development Branch

## Overview

Guide completion of development work by presenting clear options and handling chosen workflow.

**Core principle:** Verify tests → Present options → Execute choice → Clean up.

**Announce at start:** "I'm using the finishing-a-development-branch skill to complete this work."

## The Process

### Step 1: Verify Tests

**Before presenting options, verify tests pass:**

```bash
# Run project's test suite
npm test / cargo test / pytest / go test ./...
```

**If tests fail:**
```
Tests failing (<N> failures). Must fix before completing:

[Show failures]

Cannot proceed with merge/PR until tests pass.
```

Stop. Don't proceed to Step 2.

**If tests pass:** Continue to Step 2.

### Step 2: Determine Base Branch

```bash
# Try common base branches
git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null
```

Or ask: "This branch split from main - is that correct?"

### Step 3: Present Options

Present exactly these 4 options:

```
Implementation complete. What would you like to do?

1. Merge back to <base-branch> locally
2. Push and create a Pull Request
3. Keep the branch as-is (I'll handle it later)
4. Discard this work

Which option?
```

**Don't add explanation** - keep options concise.

### Step 4: Execute Choice

**Locate the main checkout and the branch's worktree first.** Git refuses to check out a branch that is checked out in another worktree and refuses to delete a branch that is checked out in a worktree. A branch created by `using-git-worktrees` lives in a linked worktree, so every branch command below runs from the main checkout, never from inside the worktree:

```bash
# The main checkout: the same derivation as using-git-worktrees (also correct from inside a worktree).
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

# The linked worktree that has <feature-branch> checked out: an exact match on the
# branch line of the porcelain list, not a substring match on the human-readable list.
worktree="$(git worktree list --porcelain | awk -v ref="refs/heads/<feature-branch>" '/^worktree /{p=substr($0, 10)} $0 == "branch " ref {print p; exit}')"

# Checked out in the main checkout itself means there is no linked worktree to remove.
if [ "$worktree" = "$main" ]; then worktree=""; fi

cd "$main"
```

`$worktree` is non-empty exactly when the feature branch is checked out in a linked worktree. The commands below assume the shell is in `$main`.

#### Option 1: Merge Locally

```bash
# Switch the main checkout to the base branch
git checkout <base-branch>

# Pull latest
git pull

# Merge feature branch
git merge <feature-branch>

# Verify tests on merged result
<test command>
```

If the main checkout holds uncommitted changes that block the checkout or the merge, stop and report them; do not stash or discard them.

If tests pass, remove the linked worktree first (Step 5, `$worktree` non-empty only; Git will not delete a branch that is checked out in a worktree), then delete the branch and prune its handoffs:

```bash
git branch -d <feature-branch>

# Clean up the merged branch's session handoffs (per-branch files under
# docs/.output/handoffs/) so the base branch doesn't accumulate dead handoffs.
# The work itself lives in commits + plan files; the handoff was a pointer.
# NOTE: handoffs are month-nested (YYYY-MM/...-<slug>.md), so a FLAT glob
# (docs/.output/handoffs/*-<slug>.md) matches nothing and silently prunes nothing
# (and under zsh an unmatched glob vanishes). Use `find` + a path-prefix guard.
# The grep anchors on the {stamp}-{caller}- boundary (handoff-path.js FILE_RE):
# a bare "*-<slug>.md" suffix match also hits OTHER branches whose slug merely
# ends in -<slug> (deleting branch `foo`'s handoffs must not touch `bar-foo`'s).
find docs/.output/handoffs -type f -name "*-<feature-branch-slug>.md" 2>/dev/null \
  | grep -E '/[0-9]{6}-[0-9]{4}-(run-todo|run-tests|end|do|todo)-<feature-branch-slug>\.md$' \
  | while read -r f; do case "$f" in docs/.output/handoffs/*) git rm -q "$f" 2>/dev/null || true ;; esac; done
[ -n "$(git diff --cached --name-only -- docs/.output/handoffs/)" ] && \
  (printf 'chore: drop merged-branch handoffs (<feature-branch>)\n' > docs/.output/.state/.commit-msg && node .claude/core/commit.js) || true
```

#### Option 2: Push and Create PR

```bash
# Push branch
git push -u origin <feature-branch>

# Create PR
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<2-3 bullets of what changed>

## Test Plan
- [ ] <verification steps>
EOF
)"
```

Report the PR and **keep the worktree**: review feedback usually needs follow-up commits. Remove it later with Step 5 once the PR is merged.

#### Option 3: Keep As-Is

Report: "Keeping branch <name>. Worktree preserved at <path>."

**Don't cleanup worktree.**

#### Option 4: Discard

**Confirm first:**
```
This will permanently delete:
- Branch <name>
- All commits: <commit-list>
- Worktree at <path>, including any uncommitted or untracked work in it

Type 'discard' to confirm.
```

Wait for exact confirmation.

If confirmed, remove the worktree before deleting the branch. `--force` is allowed here and only here, because the typed `discard` is the explicit confirmation that the uncommitted work goes too:
```bash
# The worktree first: Git will not delete a branch that is checked out in one.
if [ -n "$worktree" ]; then git worktree remove --force "$worktree"; fi

# A branch checked out in the main checkout itself has to be left before it can be deleted.
if [ "$(git branch --show-current)" = "<feature-branch>" ]; then git checkout <base-branch>; fi

git branch -D <feature-branch>
```

### Step 5: Remove the Worktree

**For Option 1, when `$worktree` is non-empty** (set in Step 4), after the merge and before `git branch -d`. Option 4 removes the worktree in its own block above.

Remove it from the main checkout (`$main`), never from inside the worktree. A worktree the toolkit created lives under `<parent of the main checkout>/.worktrees/<repo>/<branch>` (the `using-git-worktrees` default, outside the repository), so there is no project-local `.worktrees/` directory or ignore entry to clean up. Never delete the directory by hand; Git must unregister it:
```bash
git -C "$main" worktree remove "$worktree"
```
Without `--force` Git keeps a worktree that holds uncommitted work or untracked files; report that and stop, leaving the branch in place, instead of forcing it. Git-ignored files in the worktree (a local `.env`, build output, `.worktreeinclude` copies) are not "uncommitted work" to Git and are deleted with the worktree; mention that when they matter. Claude Code's `WorktreeRemove` hook behaves the same for a worktree Claude created.

**For Options 2 and 3:** Keep the worktree.

## Quick Reference

| Option | Merge | Push | Keep Worktree | Cleanup Branch |
|--------|-------|------|---------------|----------------|
| 1. Merge locally | ✓ | - | - | ✓ |
| 2. Create PR | - | ✓ | ✓ | - |
| 3. Keep as-is | - | - | ✓ | - |
| 4. Discard | - | - | - | ✓ (force) |

## Common Mistakes

**Skipping test verification**
- **Problem:** Merge broken code, create failing PR
- **Fix:** Always verify tests before offering options

**Open-ended questions**
- **Problem:** "What should I do next?" → ambiguous
- **Fix:** Present exactly 4 structured options

**Automatic worktree cleanup**
- **Problem:** Remove worktree when might need it (Option 2, 3)
- **Fix:** Only cleanup for Options 1 and 4

**No confirmation for discard**
- **Problem:** Accidentally delete work
- **Fix:** Require typed "discard" confirmation

**Branch commands from inside the linked worktree**
- **Problem:** `git checkout <base-branch>` fails because the base is checked out in the main checkout, and `git branch -d/-D <feature-branch>` fails because the branch is checked out in the worktree
- **Fix:** Run every branch command from the main checkout, and remove the worktree before deleting its branch

**Detecting the worktree with a substring match**
- **Problem:** `git worktree list | grep <branch>` also matches the main checkout's line and any branch whose name contains the text, so the next command can try to remove the main checkout
- **Fix:** Match `branch refs/heads/<feature-branch>` exactly in `git worktree list --porcelain` and skip the entry that equals the main checkout

## Red Flags

**Never:**
- Proceed with failing tests
- Merge without verifying tests on result
- Delete work without confirmation
- Force-push without explicit request
- Delete a branch before removing the worktree that has it checked out
- Use `--force` on `git worktree remove` without the typed `discard`

**Always:**
- Verify tests before offering options
- Present exactly 4 options
- Get typed confirmation for Option 4
- Run branch commands from the main checkout
- Clean up worktree for Options 1 & 4 only

## Integration

**Called by:**
- `/do` via the `general-purpose` agent — after all tasks in the story are complete

**Pairs with:**
- **using-git-worktrees** - Cleans up worktree created by that skill
