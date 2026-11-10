# Engineering Conventions

Durable engineering rules for **contributors to this toolkit** (the `.agents/core/` Node code and tests under `.agents/core/__tests__/`). These are NOT adopter-facing guidance — they describe how the toolkit's own internals are built and tested. Promoted from the agent-memory store (`/sweep` 2026-06-06) so they survive memory decay and are discoverable in review.

## Code patterns

### Constants stay static — override at the call site, identically

Never read `process.env` inside a constants module (e.g. `.agents/core/constants.js`). A `process.env` read at module-load time makes `require()` of that module non-deterministic across tests — the value is captured once at first load and frozen.

When a constant needs an env override:
- Define the **static default** in the constants module.
- Apply the override with an **identical expression at each call site**.
- When two or more files consume the same overridable constant, the call-site expression must be **byte-identical** so the sites can never diverge.

*Why:* the per-category memory cap once drifted between two hardcoded `50`s; a downstream project raised one to `100` and the two silently disagreed (MP-1.1/MP-2.1, memory-performance-analysis, 2026-06-03).

### Additive SQLite migrations go through one idempotent `ensureColumn` seam

To add a column to a table created with `CREATE TABLE IF NOT EXISTS`, route **every** additive migration through one reusable helper — `ensureColumn(table, column, ddl)` — that checks `PRAGMA table_info(table)` and only runs `ALTER TABLE ADD COLUMN` when the column is absent.

Do **not** use a blind per-migration `try/catch`-on-duplicate-column. Two divergent idempotency strategies in one `initDb` are the hardest adopter-DB bug to debug, and a swallowed `ALTER` error leaves a column missing while reads silently default.

*Why:* the `importance` column was added this way (ME-2.1); `invalid_at`/`superseded_by` extend the **same** helper (ME-3.1). The backend-agnostic test simulates a pre-migration DB via `ALTER TABLE DROP COLUMN`.

### A union/`-X union` merge of two `.claude` trees silently DUPLICATES idempotent constructs

Resolving a merge of two divergent `.claude` trees with `git merge -X union` (or a union driver) concatenates both sides instead of conflicting where the content is *idempotent*: identical top-level function definitions, and repeated hook entries inside one `settings.json` matcher block. The code still **runs correctly** (JS last-definition-wins; duplicate hook entries are idempotent) and the **gate still passes**, so neither tests nor build flag the duplication — it accretes silently across syncs.

Do not trust a clean union merge of `.claude` files. After any union-merged sync, scan for duplicated function definitions and repeated hook entries and de-dupe by hand; prefer an explicit three-way resolution over a union driver for `settings.json` and core scripts.

*Why:* surfaced consolidating divergent template trees; the gate's green is a false-negative here because duplication is behavior-preserving (memory `union-merge-duplicates-idempotent-code`).

## Testing conventions

### Focused feedback and full checkpoints

In this workshop, run exact focused test files with:

~~~bash
node tools/run-toolkit-tests.cjs focused .agents/core/__tests__/intake.test.js
~~~

Focused feedback is partial. Map each changed behavior to its affected callers, sibling tests and architecture guards; use the full suite when that map cannot be bounded safely. The runner accepts 1–16 exact ordinary test paths, isolates one worker, verifies the machine-readable report and refuses wildcard/zero-collection runs. Quick mode is also partial.

The run-todo cadence retains full baseline and final gates; runs of three or more waves also run the full suite after the middle wave. An explicit request for a full suite each wave wins. Every wave still needs its build, affected checks and required integration/E2E legs. Review/source changes invalidate affected proof. Same-source full evidence may be reused only when the workflow's checkpoint and scope rules permit it.

Canonical verification remains native gate test and npm run test:coverage. Coverage measures authored .agents implementations: existing global and per-tree floors remain 70% lines/functions/statements and 60% branches. Child-only execution is not measured implementation coverage. Keep package test scripts independent of the workshop-only tools runner.

The runner and toolkit test requirement are not installed into adopters. Their Build/Test/PR gates remain application-only after agent-file changes. Offline fixtures, generated discovery and live service delivery are distinct evidence.

Toolkit contributors need Node 22.12+ for Vitest 5; Node 24 is recommended, and the full gate is green on Node 26. Keep Vitest and its V8 coverage provider on matching versions. The optional better-sqlite3 13 driver requires Node 22+; earlier runtimes retain JSON memory search. Coverage artifacts belong under `docs/.output/.state/telemetry/coverage/`.

### A stub must assert the real subsystem's contract, not just the call

When a test stubs a subsystem call, assert the **invariant the real dependency would enforce** — not merely that the call was made.

*Why:* `install.js` stubbed `scaffold` and 42 tests passed while a CRITICAL bug sailed through — `--force` forwarded into `scaffold` would clobber the adopter's root `.gitignore` — because no test asserted what `scaffold` does to the filesystem under `force`. Stub the call **and** assert the filesystem/state invariant.

### Testing an env override of a module-load-time const: reload the require cache

A top-level `const` that reads `process.env` once at require time is frozen at first load — setting `process.env` mid-test does nothing. To test the override:

1. Delete the module from `require.cache`.
2. Set the env var.
3. Re-`require` to get a fresh module with the new value.
4. **Always** restore env + cache in a `finally` block so the reload can't leak the overridden value into sibling tests.

Notes:
- With `createRequire()` bridges (ESM test files loading CJS), `vi.resetModules()` does **not** help — it resets the Vite registry, not the CJS require cache.
- Close any DB handle the reloaded instance opened before tmp cleanup.

*Why:* the full suite stayed green afterward, proving the reload didn't leak `cap=2` into other describe blocks (MP-2.1, 2026-06-03).

## Publishing & fleet-sync conventions

### `publish.js` ships `__tests__/`; `template-updater.js` skips them — a one-way trapdoor

The two propagation paths have **asymmetric coverage of test sources**:
- **Public artifact** (`publish:public` / `tools/publish.js`) selects tracked allowlisted files and **ships toolkit test files** for workshop/artifact verification. It does not add toolkit tests to adopter application gates.
- **Application install/update** (`template-updater.js update --merge`) **excludes `__tests__/` and `_helpers/`** (`ALWAYS_SKIP_DIRS`) to protect adopter customizations.

Consequence: anything hardcoded in a `__tests__/` file — an absolute path, a username, a secret, a machine-specific value — **leaks into every first-published adopter and is never overwritten by later syncs.** It persists until hand-fixed in each adopter.

*Rules:* never put a personal/absolute path, real secret, or machine-specific value in a test fixture — use `~/...`, tmp dirs, or env. When you fix such a leak in the workshop, remember a plain `template-updater` sync will **not** carry the fix to adopters that already have the stale test; fix those by hand. (Field-proven 2026-06-07: `guardrail.test.js` carried `/home/<user>/...` into two adopters.)

*Why:* surfaced during the v4.71/v4.72 fleet work — the strip-personal-paths fix reached the storefront via publish but not the already-synced adopters via `template-updater`.

### Canonical version changelog is capped; older entries live in workshop-only `CHANGELOG.md`

Canonical `.agents/config/version.json` and rendered `.claude/version.json` travel with toolkit updates, so an ever-growing inline changelog bloats the propagated file. `fleet:release` keeps only the newest `CHANGELOG_INLINE_CAP` releases inline and demotes older entries to root `CHANGELOG.md`.

*Rules:* `CHANGELOG.md` is **workshop-only** — it is not in the publish allowlist (`tools/publish-manifest.json`) and not a `.claude/` subtree, so neither `publish.js` nor `template-updater.js` carries it. Adopters see only the capped newest releases in the `version.json` they sync; the full history lives in the workshop's `CHANGELOG.md`. The cap is enforced in `tools/fleet.js` (`capChangelog` / `mergeChangelogArchive`) — don't hand-edit `version.json` to re-stack old entries.

*Why:* the inline changelog had grown to span v4.59→v4.80 in one string (2026-06-14), bloating every adopter's `version.json`.

### After every sync: reconcile agent `skills:` frontmatter against real skill dirs

`template-updater.js` is additive: it never deletes, and `--merge` **UNIONS** an agent's `skills:` list with the template's rather than replacing it (deliberately — that preserves skills added by `/review:specialize`). Two consequences compound over a long-lived adopter:

- A template **rename/consolidation** (e.g. `architecture-writer`→`architecture`, `code-reviewer`→`code-review`) leaves the agent referencing BOTH names, and the orphaned old skill dir (or command) accretes forever.
- Finishing a rename migration therefore requires hand-work: strip the stale `skills:` lines from agent frontmatter, verify every declared skill resolves to an existing `skills/<name>/` dir, and only then delete the orphan dir.

*Rules:* after any `template-updater`/`fleet:sync` pass — (1) set-diff the target's `skills/` and `commands/` against the source to surface orphans (`fleet:sync` reports them; `--prune-orphans` deletes), (2) verify every agent `skills:` entry resolves to a real dir (`/review:check-templates` checks this).

*Before pruning, check what still points at the fossil.* A fossil skill can still be listed by an adopter-owned agent's `skills:` frontmatter and can still exist in the adopter's canonical `.agents/` tree, where the next render regenerates it. Retiring it means: remove the entry from the canonical role, remove the canonical skill (after confirming any unique content, such as a personal voice profile, exists elsewhere byte for byte), render, `git rm` any generated copy the renderer holds back as edited, and only then let `fleet:sync --prune-orphans` clear the rest. `--prune-orphans` is fleet-wide, so hold back an adopter you have not checked by marking it `exclude` in `tools/fleet.json` for the run. Prove the adopter is stable afterwards: in the adopter, `node .claude/core/render-shared-agents.js --check` must report current (a `RENDER` line for a pruned file means its canonical `.agents/` source still exists), and a `fleet:sync --dry-run` must report it up to date. Compare the adopter's complete canonical skill list against the toolkit's, not a truncated listing.

*Why:* field-proven twice on 2026-06-07 (two adopters: agents carried both `architecture` and `architecture-writer` after `--merge`) and 2026-06-06 (an adopter at v4.46→4.47: `--merge` historically REBUILT frontmatter and silently stripped `/review:specialize`-added skills — the union behavior is the fix, the reconcile pass is its cost). Promoted from memories `template-updater-merge-unions-agent-skills` + `reconcile-agent-skills-after-template-sync` (/sweep 2026-07-02).

## Shell-instruction conventions (command prose)

Commands and skills contain shell the agent executes verbatim — review it like code. Both rules below are field-proven data-loss/no-op classes.

### An unexpanded glob passed to `git mv`/`rm` aborts atomically — or worse, survives literally

In an archive/move step (`git mv docs/todo/TODO_epic*.md <archive>/`), a glob with zero matches is passed as a **literal** to git, which errors **atomically** — the other named files in the same `git mv` are not moved either. If a later step regenerates those files in place, the un-archived originals are silently overwritten: data loss from an *archive* command. (Under zsh the failure mode differs — an unmatched glob can vanish entirely, degrading `ls -1t <glob>` into a bare `ls` of the CWD, whose files then get deleted by the downstream loop.)

*Rules:* move each path individually in a loop with a per-file `[ -e ]` guard; assert the destination is populated before any step that regenerates sources; never feed a glob to a destructive command without an expansion guard.

### Anchor filename matches on the full token boundary; keep prune pipelines POSIX

Two `/sweep` 2026-07-02 findings on the handoff-prune shell (both live-reproduced):
- A **suffix glob** over multi-token filenames (`*-${BR}.md` against `{stamp}-{caller}-{branch}.md`) also matches any *other* branch whose slug merely ends in `-$BR` — pruning `foo` deletes `bar-foo`'s handoffs. Anchor with a `grep -E` that mirrors the canonical resolver regex (`handoff-path.js` `FILE_RE`: stamp shape + caller alternation + branch + extension), and keep it in sync with the resolver.
- `find -printf` is **GNU-only**; on macOS/BSD `find` it fails, and with stderr discarded the pipeline silently yields nothing — the prune no-ops forever. For newest-N over run-stamped files, sort by **basename** instead: the `{YYMMDD-HHMM}` prefix is chronological, and `awk -F/ + sort -r + tail -n +K + cut` are all POSIX.

## Working discipline

### Resolve it or don't report it

A problem found is a problem fixed. When investigation or verification surfaces something clearly worth fixing — a failing test, a broken parser, a typo, dead code, a flaky path — **fix it in the same pass**, then re-verify. Diagnose → fix → re-run the real command → report what you did.

- A report that ends in "want me to fix it?" for an obviously-worthwhile fix is an **incomplete job**, not a courtesy.
- "Pre-existing" / "unrelated" describe a bug's *origin*, not a license to leave it broken.
- If a fix exposes a new failure, follow the thread to green.
- **Only** stop to ask on a genuine fork: mutually-exclusive approaches, an irreversible/outward action, or scope that materially expands the task. A clear bug is never a fork.

*Why:* established 2026-06-20 after a "4 tests fail, here's why, want me to fix them?" report — the diagnosis was right but stopping there wasted a round-trip on work that was plainly worth doing. (Mirrors the global Rule 5 and the `verification-before-completion` skill's "Resolve, Don't Defer.")

## Cross-platform / Windows portability

The test suite runs on Windows (Node 24) as well as Linux/macOS CI. Several classes of bug pass on POSIX and break only on Windows — guard against all of them. (All five field-proven 2026-06-20 when a Windows + Node 24 run surfaced them at once.)

### Split on `/\r?\n/`, never bare `\n`; normalize to LF via `.gitattributes`

A Windows checkout with `core.autocrlf=true` and no override leaves `\r` on every line. A parser that does `content.split('\n')` then exact-matches a fence (`lines[0] === '---'`) silently fails because `lines[0]` is `"---\r"`. **Rule:** split text on `/\r?\n/` in any parser that exact-matches whole lines. The repo's root `.gitattributes` (`* text=auto eol=lf`) is the systemic guard — keep it. *Field case:* `skill-conformance.js` reported all 23 skills' `name` as `null`.

### `fileURLToPath(import.meta.url)`, never `new URL(import.meta.url).pathname`

On Windows the latter returns `/C:/Users/<name>/...` (leading slash), which `path.resolve` turns into the bogus `C:\C:\...`. **Rule:** always `import { fileURLToPath } from 'node:url'` and use `fileURLToPath(import.meta.url)`. *Field case:* `guardrail.test.js` failed to load its rules file with `ENOENT C:\C:\...`. (Also documented in `qa-engineer/SKILL.md`.)

### `fs.cpSync` onto an existing destination directory fails on Node 26

With `{ recursive: true, force: false, errorOnExist: true }`, Node 26 throws `EEXIST` when the destination directory itself already exists; older Node merged into it. A helper that accepts a pre-made empty destination (`copyGitRepo` in the test fixtures does) must copy the source's entries into it one by one, or only call `cpSync` when the destination does not exist. *Field case:* this single behavior change caused all 17 test failures on Node 26 (one fixture test plus 16 delivery-commit tests); the gate is green on Node 26 after the helper fix.

### Prefer built-in `node:sqlite` on Node 24+; PROBE a native backend, don't trust `require()`

`require('better-sqlite3')` loads only the JS wrapper — the native `.node` binary loads lazily at `new DatabaseSync()` and throws on an ABI mismatch (a build for a different Node major). **Rule:** on Node 24+ prefer the zero-dependency built-in `node:sqlite`; when adopting any SQLite backend, validate it by actually constructing an in-memory FTS5 table (`probeFts5`) before committing to it, so a broken candidate falls through instead of silently degrading every later call to JSON-only. *Field case:* memory search silently fell back to JSON (0 hits, 167 errors) on a box with a stale `better-sqlite3` build.

### Canonicalize paths with `fs.realpathSync.native` before string-comparing

`os.tmpdir()` can return an 8.3 short path with a shortened directory segment, while `git --git-common-dir` returns its long spelling. Same directory, different strings → a `toBe` comparison fails. **Rule:** run both sides through `fs.realpathSync.native()` before comparing paths. *Field case:* the `resolveProjectRoot` worktree test.

### Close SQLite handles before `rmSync` of a temp dir

Windows refuses to delete a directory containing a file with an open handle (`EPERM`); POSIX allows it. A test that opens a DB and `rmSync`s its dir in `finally` must close **every** handle first. **Rule:** track and close all managers/handles a fixture opens before removing its directory — not just the ones the assertion used. *Field case:* a `seedTempStores` helper opened two managers; the test closed one, and the leaked second handle locked the `.db` against cleanup.

## Source ownership after universal migration

Author workflows and knowledge in `.agents/skills/`, roles in `.agents/roles/`, shared helpers/hooks/templates in their matching `.agents/` directories, and runtime metadata in `.agents/adapters/`. Native helper paths remain compatibility entry points; edit the source named in their generated notice. Keep tests in the existing `.agents/**/__tests__/` locations. Test imports and source inspections should target canonical implementations; native entry behavior requires subprocess checks of the generated files.

Reuse inherited behavior and assertions during compatibility migrations. Trace conditional consumers and source/shared-state root semantics. Verify changed seams and the final gate; do not expand a source move into helper redesign or repeat unchanged broad proofs. Generated parity, offline execution, native discovery and trusted model-visible hook execution are separate evidence.

## Native helpers and prepared release delivery

Use `.codex/core/` helpers in Codex and `.claude/core/` in Claude; implementations are canonical under `.agents/core/`. Preserve source/native/ledger completeness in commits and keep direct helper runtime context separate from hook subprocess context. Source checkout and ignored shared state follow the [context contract](../../.agents/adapters/codex/README.md#context-contract).

The public storefront is the independent nested `_Domdhi.Agents/` repository. Publisher selection is tracked-only in a checkout and follows the manifest/exclusions, containment and own-root checks. Failed source selection or copy/prune must not become a committed/pushed release. A local prepared version is distinct from authorized publication/fleet sync; see [v6 migration](../reference/agents/migration-v6.md#local-release-preparation-and-later-distribution).
