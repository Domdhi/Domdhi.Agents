# Repo context (for the reviewer: existing code on main, not part of the PR)

`secret-scanner.cjs` is the toolkit's only enforcement point for secrets that do not arrive through a
Claude Code Write/Edit call. The commit helper `commit.js` calls the same scan, and the managed
`.git/hooks/pre-commit` calls `secret-scanner.cjs --git-precommit`. A commit that skips both (a raw
`git commit` from a terminal, a script) is covered only by this pre-commit mode, so a finding it misses
reaches the repository history.

```js
// scanContent(content, file) -> array of findings; used by every mode.
// shouldSkipPath(file)       -> true for lockfiles, images, vendored dirs.
// getProjectRoot()           -> the repo root the hook runs in.
```

The PR's four tests cover the cases its author listed (added, modified, clean, deleted). Developers
stage work with ordinary `git add -A`.
