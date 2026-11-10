# Hooks

Hooks run deterministic Node handlers on supported runtime events. Shared implementations live in `.agents/hooks/`; native `.claude/hooks/` and `.codex/hooks/` wrappers forward to them. Registration and protocol differences belong in `.agents/adapters/`. Hooks have no mandatory runtime npm dependencies.

## Claude handler inventory

Claude registers 18 handlers. `secret-patterns.cjs` is a shared library, not a seventeenth registered hook. Authoritative shared registration is [Claude adapter settings](../../../../.agents/adapters/claude/settings.json); installed settings may add project hooks.

| Handler | Claude event/tool | Purpose |
| --- | --- | --- |
| `session-start-prime.cjs` | SessionStart | Always-on memory core (full title list on Codex) and pending-candidate reminder |
| `session-end-doc-sync.cjs` | SessionEnd | Advisory legacy/duplicate/misplaced doc check |
| `memory-session-capture.cjs` | SessionEnd | Opt-in detached capture of the finished session into reviewable memory candidates |
| `memory-recall.cjs` | UserPromptSubmit | Per-prompt recall of up to three full memories, capped well under the hook-output limit |
| `secret-scanner.cjs` | Pre Write/Edit/MultiEdit/NotebookEdit | Refuse secret-bearing added text |
| `path-guardrail.cjs` | Pre Write/Edit/MultiEdit/NotebookEdit | Path tiers and freeze-state rules |
| `guardrail.cjs` | Pre Bash/PowerShell | Destructive command/path checks |
| `commit-guard.cjs` | Pre Bash/PowerShell | Route inline commit messages through the commit helper |
| `pre-compaction-archive.cjs` | PreCompact | State snapshot and daily log |
| `post-read-scrubber.cjs` | Post Read/Bash/PowerShell | Secret detection and shell-output redaction |
| `skill-usage-logger.cjs` | Post Read/Agent/Task | Skill-read and declared-dispatch telemetry |
| `organize.cjs` | Post ExitPlanMode/Bash/PowerShell | Plan and screenshot organization |
| `damage-control.cjs` | Post Bash/PowerShell | Failure analysis |
| `command-usage-logger.cjs` | Post Skill/Bash/PowerShell | Command/gate telemetry |
| `memory-guard.cjs` | Post Write | Category-capacity warning |
| `memory-capture.cjs` | Stop and Post Bash/PowerShell | Daily capture, strict-profile Sonnet curation and commit context |
| `edit-capture.cjs` | Post Edit | Strict-profile canonical-doc edit capture |
| `worktree.cjs` | WorktreeCreate/WorktreeRemove | Sibling worktree lifecycle and include copies |

Claude registration covers nine event types: SessionStart, UserPromptSubmit, SessionEnd, PreToolUse, PostToolUse, PreCompact, Stop, WorktreeCreate and WorktreeRemove. ExitPlanMode is a tool matcher under PostToolUse, not another event.

PreToolUse can deny before tool execution. Exit 2 is a blocking refusal; exit 1 is a warning. PostToolUse acts after effects occurred: the scrubber emits redacted shell output, while Claude Read-output replacement remains limited by native support. Post-completion handling cannot undo filesystem/network effects.

The worktree handler creates worktrees under the sibling `.worktrees/{repo}/` root (or `AGENTS_WORKTREE_ROOT`), copies Git-ignored `.worktreeinclude` matches and removes without force. Modified/untracked non-ignored files keep the worktree; ignored files are removed with it. Failure/cleanup diagnostics must be evaluated from the actual result, not assumed from attempted cleanup.

## Codex adaptation and trust

[The Codex adapter](../../../../.agents/adapters/codex/README.md) defines supported events and conversions:

- Bash uses shell guards and post-output handlers; apply_patch is parsed into independent added-text/write/delete/move events.
- MCP output is scrubbed; Agent's supported spawn alias records declared-skill telemetry.
- SessionStart emits additional context; SessionEnd and PreCompact retain their shared handlers.
- Claude `ask` becomes a Codex denial with a review reason. Post-output redaction uses `continue: false` and feedback after tool completion.
- Claude Read/Skill/Task/ExitPlanMode registrations are not invented as Codex tools. Automatic Stop/Post-Bash memory extraction is unregistered; session-handoff and explicit helpers remain the acquisition path.

Repository and exact-hook trust are required. Changed definitions can be skipped pending native review; installation/parity/discovery do not prove trusted model-visible execution. Some hosted/specialized tools and plain terminal commands bypass runtime hooks. Hooks are not a complete enforcement boundary. Current v6 work has no fresh live Windows/trusted native-model proof; historical reference probes are separately attributed in the adapter README.

## Commit scanning

Secret protection runs where content is written, committed and published: runtime pre-write scanning, the toolkit-managed git hooks, and the scan in native `commit.js`. Read the coverage exactly: the commit hooks cover **commit, merge and `git am`**; the **pre-push hook scans every commit a push would publish** and is the backstop for every route that ran no hook. Nothing here protects a commit that is never pushed, and a human can always skip a hook.

**Managed git hooks.** `install.js` and `template-updater.js update` install five small POSIX `sh` hooks with `git-hooks.js`:

| Hook | Runs for | Scans |
|---|---|---|
| `pre-commit` | `git commit` | the staged files |
| `commit-msg` | `git commit`, the commit a `git merge` makes | the whole message file (anything below a scissors line is the staged diff pre-commit already scanned; not special-casing it leaves no place to hide text) |
| `pre-merge-commit` | a `git merge` that creates a commit | the merge result held in the index |
| `pre-applypatch` | `git am` | the patch result held in the index |
| `pre-push` | `git push` | every OBJECT the push would publish that the remote does not vouch for (`git rev-list --objects`): every new blob under whole-file rules at its path, every commit message and every annotated tag message, whatever a ref points at (a commit, a tag, a tag on a bare blob or tree, nested tags). Any other object type fails the push closed |

They are mode `0755`, LF endings, written into the directory git runs hooks from (`git rev-parse --git-path hooks`, which resolves `core.hooksPath` and linked worktrees) and **never tracked**: nothing is written unless that directory is inside the repository's git common dir, so the non-executable, renamed-scanner fossil of the retired `.githooks/pre-commit` template cannot recur. A `core.hooksPath` at a tracked or project directory (husky's `.husky`, a `.githooks` fossil) is left alone; the helper reports it with the exact line to add to your own hook and, for a recognised fossil, the cleanup it does not run (`git rm .githooks/pre-commit`, `git config --unset core.hooksPath`). `core.hooksPath=/dev/null` (or any path that is not a directory) means git runs **no hook at all**: `--check` reports "hooks disabled" and install writes nothing. A hook is ours only when `# domdhi-agents managed hook: <name> v<N>` is its first comment line (right under the shebang); a hook without it is never overwritten; marker hooks are refreshed by install/update and deleted by `--remove` and `uninstall.js`.

```sh
node .agents/core/git-hooks.js            # install or refresh (also .claude/core/ or .codex/core/)
node .agents/core/git-hooks.js --check    # status; exit 1 when the hooks are not active
node .agents/core/git-hooks.js --remove   # delete the hooks this helper wrote
```

**What the push scan trusts.** Only what the **remote** vouches for: the remote ids git passes to the hook on stdin, plus the ids the remote advertises to `git ls-remote`. A local `refs/remotes/*` is never trusted (`git fetch . main:refs/remotes/origin/x` rewrites it in one line). The advertisement is asked for **only when `ls-remote` provably contacts the URL the push goes to**: `git ls-remote` applies `url.<base>.insteadOf` rewriting that a push can sidestep (an identity `url.<real>.pushInsteadOf` sends the push to the real remote while `insteadOf` sends `ls-remote` to a decoy repository that already holds the secret commit and would "vouch" for it). So the scan first runs `git ls-remote --get-url -- <push url>` and uses the advertisement only if that prints the push URL unchanged. On any mismatch, failure or doubt (no URL; a remote name instead of a URL; `ls-remote` failing) nothing extra is excluded and everything new relative to the remote ids on stdin is scanned: a rewritten URL costs a longer scan, never a skipped one. The agent guard also refuses `url.*.insteadOf` / `pushInsteadOf` as `-c` / `--config-env` operands and in `git config` writes. A first push of 2,000 commits / 5,000 files is scanned in one pass in under two seconds.

**What a hook trusts.** The shim runs `.agents/hooks/secret-scanner.cjs` of the work tree it runs in, and first checks `--hook-protocol`: a checkout whose toolkit predates the managed hooks (an old branch or worktree) has a scanner that would read the call as a Claude Write/Edit event and scan nothing, so the shim refuses it, fails closed, and names the options: merge or update the toolkit on this branch, or the audited bypass for a human-reviewed case. `--check` reports that state as not active. The same applies to a worktree created from a commit that has no `.agents/` at all: it cannot commit until the toolkit is merged in (`git checkout -- .agents`) or the bypass is used. The repository root is always what git says it is for the working directory; **no environment variable redirects a commit or push scan**.

**One scan, not two.** `commit.js` skips its own scan when the commit hooks (pre-commit and commit-msg) are installed, current and executable, the scanner speaks the hook protocol, and git will really run them; otherwise it scans itself. The staged set goes to the engine in **one batch run per ~128 MB of content** (the blobs are written to a private `0700` staging directory that is removed on every exit, including SIGINT, SIGTERM and SIGHUP; stale ones of a killed run are swept at the next scan), so a commit of the full toolkit payload (about 920 files) takes about half a second instead of a process per file. The batch reports exactly what the per-file scan does (a parity test pins it), and falls back to scanning a file on its own when it cannot stage it faithfully (case-colliding names, reserved characters, an ignore file among the staged files) or when the engine's byte count does not add up.

**What is scanned.** Blobs are read **by id** from the raw diff, never by `:<path>` (git reads `:0:README` as "stage 0 of README"). Nothing is skipped because it is large or looks binary (a 100 MB blob with a NUL in its first bytes is scanned). The engine itself refuses some binaries outright (an OOXML/zip/pdf/gzip/sqlite/tar signature, so every `.xlsx`, `.docx`, `.pdf` and archive in a history); those are scanned through their **text projection**, their printable runs of 8+ characters (ASCII and UTF-8, and UTF-16LE strings) one per line, so a key stored as text inside a spreadsheet is found, and a finding's line is the number of the printable run. All of a batch's refused binaries go through ONE more engine run, never a process per file; text that merely starts with such a signature keeps the newline rescan and its real line numbers; an engine that quits early on a binary (a broken pipe on a big input) is a skip, while any other early exit is still an engine failure; a blob git cannot resolve fails the scan closed, and so does a blob so large that the engine cannot scan it inside its timeout (60 s per batch run); a submodule pointer (mode 160000, a commit id) is skipped with a note, because the submodule's own repository scans its content.

**`.betterleaksignore`** is read from the **index** (the staged version, else HEAD), never from the working tree, so a suppression counts only once it is part of the reviewed commit. The push scan reads it from the tree of each commit that introduced the blob. The Write/Edit hook reads the same index version. The guardrail keeps an agent from writing the file.

**The bypass.** `CLAUDE_COMMIT_NO_SCAN=1` is the one audited bypass; each git mode honors it itself, so an owner-written hook that calls the scanner gets it too. It records **one** `bypass` guardrail event per bypassed commit, from whichever hook sees it first (a marker file in the git directory, keyed by the index tree and HEAD, lets commit-msg tell a commit whose pre-commit already recorded it from a reword that ran commit-msg alone; no environment variable can suppress the record), and the message says "recorded" only when the write happened (otherwise it says NOT recorded). `commit.js --no-scan` sets the variable for its child `git commit`; with active hooks the hooks record, otherwise `commit.js` does. The bypass works even when node or the scanner is missing, and then says the bypass was not recorded. A push can be bypassed the same way. The agent guardrail asks the user before any command that mentions the variable name (however the value is written: `$'1'`, `$(echo 1)`, `printf -v`, `export`, `declare`, `env`) or passes `--no-scan`. The scanner itself reads only `=1`; the guardrail does not rely on that.

**What the agent guard blocks and cannot see.** `commit-guard.cjs` blocks, after normalising shell quoting (`"git"`, `$'-n'`, `"core.hooks"Path`): `--no-verify` on commit, merge, am, rebase, pull, push, cherry-pick and revert, `-n` on commit and am (also in clusters such as `-nm` and `-an`), `git commit-tree`, `core.hooksPath` / `include.path` / `includeIf` as `-c` or `--config-env` operands (also as a separate argument), `git config` writes and unsets of them (also the git >= 2.46 `git config set` / `unset` forms, in every scope) and `url.*.insteadOf` / `pushInsteadOf` the same way, `GIT_CONFIG_*` set in a command that commits, merges or pushes, and git aliases (resolved with `git config --get-regexp ^alias\.` in the repository, and `-c alias.x=`) whose expansion does any of that. `git commit -F` is never blocked. Its block message tells the agent to stop and ask the user; it does not name the bypass. A lexical guard cannot see `bash -c` / `sh -c` / `eval` strings, values built at run time (`$var commit`, command substitution), a different `node` earlier on PATH, `NODE_OPTIONS=--require ...`, or a hooks file edited directly. A hook is only as trustworthy as the `node` and the scanner it finds, and a human can always `--no-verify`: **the pre-push scan is the backstop** for all of these (and for compressed archives, which the engine does not open: a deflated zip or `.gz` holding a key is not seen by any scan). If node is replaced on the push machine itself, nothing in a hook helps.

Every scan runs the pinned Betterleaks engine (`.agents/hooks/secret-engine.cjs`, rules in `.agents/config/secret-engine.toml`, version, archive hashes and extracted-binary hashes in `.agents/config/secret-engine.json`). The binary is installed per user with `secret-engine-install.js`, not stored in the repository. **Identity:** whichever binary is used (the user cache, `AGENTS_SECRET_ENGINE_BIN` or a `betterleaks` on an absolute `PATH` entry) must hash to the pinned sha256 of the extracted binary for the platform; a version string is not identity, and a relative `PATH` entry is never searched. A mismatch is refused: the Write/Edit hook and the commit scan fail closed with a hint to run the installer, and the redactor falls back. The check is remembered per process and in a record beside the cache (keyed on path, size, mtime, inode and ctime), so it costs one hash per change to the file, not one per hook call. The cache directory is created `0700` and refused if it is not owned by the current user or is writable by group or others.

| Situation | Write/Edit hook, commit scan, commit message, intake export | Output scrubber, `secret-safe-write`, local learning capture |
|---|---|---|
| Engine installed and verified | Scans; a finding blocks (hook exit 2, commit exit 1) | Scans and redacts with `<REDACTED:Name>` markers (every verbatim copy of a detected value) |
| Engine missing, unverified, failing, timing out, returning bad output, or skipping the input | **Blocks** with an install hint (fail closed); nothing is exported to GitHub | Falls back to the built-in named-provider regex list and never blocks |

The engine drops input that looks like a binary file (a zip, bzip2, rar, ar, cab, pdf, rtf, sqlite, tar ... signature at its offset) without a word, so text that merely starts with such bytes would never be scanned. The wrapper reads the number of bytes the engine says it scanned; a run that scanned fewer is repeated behind one neutral newline (line numbers are mapped back), and a second skip fails closed.

**Reviewed false positives.** For a *generic* match only (a password or secret assignment, not a provider key), the **user** (not the agent) may add `betterleaks:allow` (or `gitleaks:allow`) as a **trailing comment on the same physical line**, after the secret: `//`, `#`, `/* */`, `<!-- -->` or `--`. The marker counts only on the line it is on (never the next line, and a `\r` or U+2028 between the key and the marker breaks it); never inside a string literal or glued to the key; never for a multi-line finding (a private key block); and one marker covers one secret (plus other rules' findings of that same value), not every key on the line. The wrapper applies this rule itself; the engine's looser handling is switched off. Every suppression is reported on stderr (rule name and line, never the value). The redactor, `secret-safe-write` and intake ignore markers, because they exist to keep a value out of context, a file or an issue. A named-provider key is never a false positive to mark, and the block message does not offer the marker for one.

**`.betterleaksignore`** (project root, one fingerprint per line, `path:rule:line`, read from the INDEX, else HEAD, never from the working tree) applies to whole-file scans only: the commit scans, the push scan, a Write with full content and `--file`. It never applies to an Edit or MultiEdit fragment (its line numbers restart at 1) or to content that needed the newline rescan. `.gitleaksignore` is not read. A fingerprint is bound to a line, not a value, and one token can fire two rules (a GitHub token fires `github-pat` and `domdhi-github-token`), so list every rule that fires. The engine runs in an empty directory of its own, so an ignore file in the working directory has no effect.

`commit.js` also scans the **commit message** (inline `-m` or the message file) and blocks on a finding. `commit.js --no-scan` remains a last resort and is logged as its own `bypass` event (a raw `git commit` bypassed with `CLAUDE_COMMIT_NO_SCAN=1` logs a `git-hook-no-scan` event from the hook); blocks log the rule names that fired and a count, never a value, and `/review:feedback` shows the top rules. A `git commit -F` run outside `commit.js` is scanned by the managed git hooks when they are installed and active.

Test and spec files are scanned with the named-provider rules only. Known gaps: a key split across string literals, a homoglyph or zero-width character inside a key, and a key broken across two lines are not detected. `tools/tracked-file-scan.cjs` scans all tracked files in one batch engine run (about a second for the whole toolkit).

```sh
# Codex; Claude uses .claude/core/commit.js.
node .codex/core/commit.js --help
```

Use the established commit workflow and explicit owned staging. Shared secret behavior lives in `.agents/hooks/secret-patterns.cjs` (path rules, redaction, the named-provider fallback) and `.agents/hooks/secret-engine.cjs` (the engine wrapper).

## Adding a handler

Author a CommonJS `.cjs` handler under `.agents/hooks/`, register it in the relevant adapter metadata and render native entry points. Preserve project hook registrations through the [settings merger](../customization.md#settings-merge). Add meaningful tests under canonical `.agents/hooks/__tests__/` or the applicable adapter test directory. Native behavior needs actual wrapper/handler checks; unit tests alone do not prove runtime trust.

Use hooks for event-driven checks without model judgment. Use a workflow or role when the action needs reasoning. See [memory](memory.md), [customization](../customization.md) and [migration v6](../migration-v6.md).
