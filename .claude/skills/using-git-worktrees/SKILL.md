---
name: using-git-worktrees
description: "Use WHEN starting feature work that needs isolation from the current workspace or before executing implementation plans — creates isolated git worktrees in the sibling worktree root, outside every repository"
metadata:
  version: 1.1.0
  author: Domdhi.Agents
  tags: [git, worktrees, isolation, workflow]
user-invocable: false
allowed-tools: Read Bash Grep
---

<!-- Generated from .agents/skills/using-git-worktrees/SKILL.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

# Using Git Worktrees

## Overview

Git worktrees create isolated workspaces sharing the same repository, allowing work on multiple branches simultaneously without switching.

**Core principle:** One derived sibling root outside every repository + a branch based on the current integration tip = reliable isolation with nothing to ignore or commit.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

## Directory Selection

The default location is derived from the main checkout, never hardcoded:

```text
<parent of the main checkout>/.worktrees/<repo>/<branch>
```

For a checkout at `C:\Users\<you>\Code\Domdhi.Agents`, branch `feat-auth` is `C:\Users\<you>\Code\.worktrees\Domdhi.Agents\feat-auth`. A worktree inside a checkout is picked up by that checkout's searches, linters, test runners and file watchers and needs an ignore rule to stay out of commits; the sibling root avoids all of that, so there is **no project-local `.worktrees/` default, no `.gitignore` edit and no commit step**.

Use the first rule that applies:

1. **An explicit request from the user** for a directory.
2. **A project instruction** that names a worktree directory (check the project's `CLAUDE.md` or `AGENTS.md`).
3. **`AGENTS_WORKTREE_ROOT`**, when set to an absolute directory outside the main checkout: the worktree is `<root>/<repo>/<branch>`. A relative value, or one inside the main checkout, is ignored: say so in the report and fall through to rule 4 (the Claude Code hook refuses both).
4. **The default** above.

```bash
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"   # the main checkout, also from inside a worktree
repo="$(basename "$main")"
root="$(dirname "$main")/.worktrees"
case "${AGENTS_WORKTREE_ROOT:-}" in
  "") ;;                                                  # not set: keep the default
  /*|\\*|[A-Za-z]:[\\/]*)                                # absolute (POSIX, UNC or drive path)
    case "$AGENTS_WORKTREE_ROOT/" in
      "$main"/*) echo "AGENTS_WORKTREE_ROOT is inside the main checkout; ignoring it and using $root" >&2 ;;
      *) root="$AGENTS_WORKTREE_ROOT" ;;
    esac ;;
  *) echo "AGENTS_WORKTREE_ROOT is not an absolute path; ignoring it and using $root" >&2 ;;
esac
path="$root/$repo/$BRANCH_NAME"
```

When rule 1 or 2 names the directory, `path` is the directory it names for this branch instead of the derived value.

**A directory inside the main checkout needs a Git ignore rule.** A worktree there is picked up by the checkout's searches and would show up as untracked. Before creating anything, verify it:

```bash
case "$path/" in
  "$main"/*) git -C "$main" check-ignore -q "$path" || echo "$path is inside the main checkout and is not Git-ignored" >&2 ;;   # exit 0 = ignored
esac
```

If the check reports that the path is not ignored, stop and report that to the user. Never edit `.gitignore` and never commit to make room for the worktree; the user either adds the ignore rule or picks another directory.

Otherwise never place a worktree inside the main checkout or inside another worktree. Claude Code creates and removes its own worktrees through the `WorktreeCreate`/`WorktreeRemove` hooks at the derived location, and the hook refuses a destination inside the main checkout..

## Creation Steps

### 1. Detect the repository

```bash
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
repo="$(basename "$main")"
```

### 2. Create the worktree

```bash
# Create the worktree with a new branch, BASED ON THE CURRENT TIP of the integration
# branch — never on whatever happens to be checked out, and never on a stale commit.
# A worktree branched behind the integration branch is missing recent renames and
# refactors; those surface as compile/merge errors you CANNOT catch inside the
# worktree (the changed symbols aren't there yet). Fetch first so the base is current.
# The chain is the one the Claude Code hook uses: the remote default branch first,
# so a repository whose default is develop or trunk is based on it, then main and
# master, and HEAD only when none of them exists.
git fetch origin 2>/dev/null
base=HEAD
for ref in refs/remotes/origin/HEAD refs/remotes/origin/main refs/heads/main refs/remotes/origin/master refs/heads/master; do
  if git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then base="$ref"; break; fi
done
mkdir -p "$root/$repo"
git worktree add "$path" -b "$BRANCH_NAME" "$base"
cd "$path"
```

### 3. Run project setup

Auto-detect and run appropriate setup:

```bash
# Node.js
if [ -f package.json ]; then npm install; fi

# Rust
if [ -f Cargo.toml ]; then cargo build; fi

# Python
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi

# Go
if [ -f go.mod ]; then go mod download; fi
```

### 4. Verify a clean baseline

Run tests to ensure the worktree starts clean:

```bash
# Examples - use the project-appropriate command
npm test
cargo test
pytest
go test ./...
```

**If tests fail:** Report failures, ask whether to proceed or investigate.

**If tests pass:** Report ready.

### 5. Report the location

```
Worktree ready at <full-path>
Tests passing (<N> tests, 0 failures)
Ready to implement <feature-name>
```

## Quick Reference

| Situation | Action |
|-----------|--------|
| User named a directory | Use it; if it is inside the main checkout, `git check-ignore -q` must pass, else stop and report |
| Project instruction names a directory | Same as above |
| `AGENTS_WORKTREE_ROOT` is set and absolute | `<root>/<repo>/<branch>` |
| `AGENTS_WORKTREE_ROOT` is relative or inside the main checkout | Ignore it, report that, use the default |
| Nothing specified | `<parent of main>/.worktrees/<repo>/<branch>` |
| Tests fail during baseline | Report failures + ask |
| No package.json/Cargo.toml | Skip dependency install |
| Worktree no longer needed | `git worktree remove` from the main checkout (see finishing-a-development-branch) |

## Common Mistakes

### Placing the worktree inside the repository

- **Problem:** The checkout's searches, linters, test runners and watchers read the nested copy, and its contents need an ignore rule to stay out of commits.
- **Fix:** Use the sibling root. Do not create `.worktrees/` or `worktrees/` inside a project. When the user or a project instruction names a directory inside the checkout, verify it is Git-ignored (`git check-ignore -q`) and stop and report if it is not; never edit `.gitignore` to make it pass.

### Hardcoding the location

- **Problem:** A machine-specific path breaks on every other machine and adopter.
- **Fix:** Derive it from the main checkout as above, or honor the override order.

### Proceeding with failing tests

- **Problem:** Can't distinguish new bugs from pre-existing issues
- **Fix:** Report failures, get explicit permission to proceed

### Hardcoding setup commands

- **Problem:** Breaks on projects using different tools
- **Fix:** Auto-detect from project files (package.json, etc.)

### Branching from a stale base commit

- **Problem:** The worktree is created from whatever was checked out (or an old commit), so it's missing recent renames/refactors on main. Everything compiles *inside* the worktree, then breaks on merge (e.g. a `NavGroup.Settings→Admin` rename landed on main while the worktree still references the old name — 19 compile failures at merge).
- **Fix:** Always base the new branch on the current tip of the integration branch (`origin/HEAD` first) — `git fetch` then `git worktree add … "$base"` as in Creation Step 2. Never branch from a detached or behind-HEAD commit.

### Editing main-checkout absolute paths from inside a worktree

- **Problem:** Auto-loaded context files (`CLAUDE.md`, `docs/CLAUDE.md`) carry **absolute paths rooted in the MAIN checkout**, not the worktree. An agent that "edits CLAUDE.md" via that absolute path writes into the main working tree — a change that escapes the worktree's isolation entirely (observed: an architect edited the main-checkout `CLAUDE.md` while working in a worktree).
- **Fix:** Inside a worktree, only ever edit paths *relative to the worktree root* (`$path/...`). Treat any absolute path that doesn't start with the worktree root as out-of-scope — the whole point of the worktree is that your writes stay in it.

## Example Workflow

```
You: I'm using the using-git-worktrees skill to set up an isolated workspace.

[Derive the root: /path/to/code/.worktrees/project]
[Create worktree: git worktree add /path/to/code/.worktrees/project/auth -b auth origin/main]
[Run npm install]
[Run npm test - 47 passing]

Worktree ready at /path/to/code/.worktrees/project/auth
Tests passing (47 tests, 0 failures)
Ready to implement auth feature
```

## Red Flags

**Never:**
- Create a worktree inside the repository unless the user or a project instruction named that directory and `git check-ignore -q` confirms it is ignored
- Edit `.gitignore` or commit anything to make room for a worktree
- Use a relative `AGENTS_WORKTREE_ROOT` or one inside the main checkout
- Skip baseline test verification
- Proceed with failing tests without asking
- Branch from a stale or checked-out commit instead of the integration tip
- Skip the project-instruction check

**Always:**
- Follow the override order: user request > project instruction > `AGENTS_WORKTREE_ROOT` (absolute only) > the derived default
- Auto-detect and run project setup
- Verify a clean test baseline

## Integration

**Called by:**
- `/do` via the `general-purpose` agent — when story implementation needs branch isolation
- Any workflow that requires isolated workspace before executing tasks

**Pairs with:**
- **finishing-a-development-branch** - REQUIRED for cleanup after work complete
