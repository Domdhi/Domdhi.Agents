# Code Review: PR #231, secret-scanner git pre-commit mode

## Summary

The mode is the right idea and the staged-content read (`git show :<path>`) is correct. The PR claims that
every staged file that can carry content is scanned, but the file list is built with
`--diff-filter=ACM`, which does not cover every staged status. A renamed file is reported by git with
status `R`, so `ACM` silently drops it, and so does a type change (`T`). The gate then passes without
scanning content it was installed to scan.

## Findings

| Severity | Location | Finding | Suggested action |
|---|---|---|---|
| MAJOR | `secret-scanner.cjs`, `runGitPrecommit()`, the `git diff --cached --name-only --diff-filter=ACM` call | `ACM` means Added, Copied, Modified. A file that is renamed (a rename of at least 50% similarity) and edited in the same change is reported with status `R` (for example `R068`), so it is excluded from the list even though `--name-only` would print its new path and `git show :<new path>` would return the staged, modified content. Reproduced in a scratch repo: `git mv old.js new.js`, append a credential, `git add -A`, then `ACM` prints nothing while `ACMRT` prints `new.js`. A secret appended during a rename therefore commits unscanned and exits 0. The type-change status `T` has the same gap. This is the last line of defense for content staged by scripts and humans, so a bypass reaches history. | Use `--diff-filter=ACMRT` (add Renamed and Type-changed), or exclude only deletions with `--diff-filter=d`. Update the comment so it does not claim "every staged file". |
| MAJOR | `__tests__/secret-scanner-precommit.test.js` | The four tests exercise Added, Modified, clean and Deleted, which are exactly the statuses `ACM` already handles, so 4/4 green says nothing about the statuses the filter omits. There is no rename-plus-edit case, which is the case that fails. | Add a test: stage a file, commit it, `git mv` it, append the key, `git add -A`, and expect exit 1. It fails on the current `ACM` filter, which proves it catches the gap. Add a type-change case as well. |
| MINOR | `runGitPrecommit()`, `.trim().split('\n')` | Without `-z`, git quotes paths that contain spaces or non-ASCII characters, so such a path would not resolve in `git show :<path>` and the scan would skip it with only a warning. | Use `--name-only -z` and split on NUL. |

## Verdict

**Changes Requested.** The scan misses renamed and type-changed files, so a secret added while renaming a file
commits unscanned although the PR says all staged content is scanned. Widen the filter to `ACMRT` and add the
rename-plus-edit regression test before merge.
