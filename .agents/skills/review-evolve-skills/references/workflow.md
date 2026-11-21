# Evolve Skills

The autonomous driver for self-improving skills. It reads the failure/learning signals the toolkit already collects, turns them into **skill work** — a brand-new skill (CREATE) or a fix to an existing one (IMPROVE) — validates each candidate with the `skill-creator` skill's **differential eval harness**, and applies it on your confirmation.

This is the *autonomous* layer over two other parts of the system:
- **`skill-creator`** (the skill) — the manual Create/Eval/Improve/Benchmark loop + the Node eval harness. This command drives it.
- **`skill-authoring`** (the skill) — the doctrine: a skill is justified by **evidence of a real gap first, then a differential eval after** (the rule that replaced "failing test first"). This command operationalizes that.

## Telemetry (run first)

This command is user-typed, so it does not fire `PostToolUse:Skill` — without this it leaves no `command_invocation` row and fleet analytics under-count human-driven runs. Self-log the invocation before anything else (best-effort — if it fails, continue regardless):

```bash
node .claude/core/telemetry-log.js review:evolve-skills
```

## The two signals (and why each is legitimate evidence)

| Path | Signal source | Why it's a real baseline |
|------|---------------|--------------------------|
| **IMPROVE** | `docs/.output/evolution/agents/*.md` misalignments, attributed to the skill that owns that domain: a structured issue row's `Skill` cell when it names an indexed skill, token overlap otherwise | The misalignment IS the "current behavior failed" baseline — the `old_skill` already lost in the field |
| **Gate failures** (report only) | `gateFailures`: a failure signature from the failure ledger (`docs/.output/.state/telemetry/gate-failures.jsonl`) seen on 2 or more changed trees | A signal about the gate, not about a skill: the ledger names no skill, so it never creates an IMPROVE candidate on its own |
| **CREATE** | Clusters of recurring `workflows` + `patterns` memories that **no existing skill covers** | The recurrence across N memories is the evidence agents keep re-deriving this unaided — the Voyager/Hermes "write the reusable pattern down" move |

CREATE is deliberately distinct from memory promotion (which injects a *single* validated memory into an *existing* skill/CLAUDE.md). This command synthesizes a *new* skill from a *cluster*, or rewrites a skill from *failure traces*.

## Variables

- `--improve-only` / `--create-only` — run just one path (default: both).
- `--auto` — **the headless propose-only cycle** (see *The `--auto` cycle* below; it is what a weekly schedule and the sweep's Phase 5b run). Intake, the top candidate drafted by the model, `skill-regress.js run` on the dev and holdout suites, `verdict`, then **staging on a local `auto/evolve-{skill}-{date}` branch** with a `staged` ledger entry; it returns the run-record exit code and never merges, never pushes and never changes the live skill. The differential always runs — it is the falsifier — and a candidate with no measured delta is not a proposal. Skill *bodies* are the system's brain: with `improvement.autoApply` at its default of `off` the cycle only stages, and even with it on the only unattended apply is an additive reference bullet (Owner Decision 12), on a branch.
  - `--candidates N` (default 1), `--max-runs N`, `--max-tokens N`, `--max-cost-usd N` state the plan; the budget block `improvement.budget` in the gate config is the ceiling, and a plan above it makes the cycle refuse to start.
- `--apply <skill-name>` — apply a previously-staged proposal for that skill through `skill-evolution.js apply` (Step 6): it re-reads the `verdict` on the latest iteration, then copies, renders, re-validates conformance and runs the build/test gate, restoring everything on any failure, and leaves the delta uncommitted on a local `auto/` branch for the Step 7 commit. Only a `verdict` of accept (`skill-eval.js verdict` exit 0) allows the apply (see *What NOT to Do*); a `lowPower` accept is proposed, never auto-applied — conformance + build passing is necessary but not sufficient.
- `--since YYYY-MM-DD` — only agent-updates dated after this date (default: all day-rotated files). The comparison is exclusive and day-granular: the date itself is skipped whole, so pass the last day that was read in full, and a row appended later on a day that an earlier run already read is not seen again (the fingerprints below, not `--since`, are the dedupe for a same-day rerun). A bare `--since`, or a value that is not `YYYY-MM-DD`, exits 2.

## Orchestration Rule

> You (the main agent) own the reflective diagnosis and the SKILL.md authoring — that is the "why did it fail / what should the skill say" judgment. Dispatch `general-purpose` subagents **on `standard` tier** (pass `{{model-arg:standard}}` on every such dispatch) only for the eval *runs* (with_skill / baseline) and grading — that work is mechanical execution (run the suite, grade against the rubric), not judgment, so it stays on the cheaper tier while Main Agent keeps the diagnosis + authoring. (`general-purpose` is a `standard`-tier agent by its adapter registry; the explicit `{{model-arg:standard}}` makes the rule load-bearing so a future caller can't silently escalate the eval fleet to `deep` tier.) Follow the **`skill-creator`** skill for the loop mechanics and the **`skill-authoring`** skill for the doctrine; read them, don't paste them here.

## Workflow

### Step 1 — Watch, then intake (deterministic)

First look at the changes this loop already applied, so that a regression of one reaches this intake as a revert candidate:

```bash
node .claude/core/skill-evolution.js watch
```

`watch` reads the ledgers, the run scoreboard and git, and writes nothing but the revert-candidate queue `docs/.output/evolution/skills/revert-candidates.json` (only when it finds a plausible regression; it never reverts, resets or checks anything out). The ledger is evidence, not the source of truth: an applied entry counts only when git proves it (its commit is reachable from the repository's **default branch**: `origin/HEAD`, else `main`, else `master`, never the branch you are on; its diff on the skill's files is exactly the evaluated change; one commit serves one entry), and the watch window starts at that commit's time on the default branch. An entry whose change has not reached the default branch is `not-merged`, one with no commit is `no-commit` (Step 7b records it once it has landed), one git cannot tie to its change is `unverified`. Stage `revert-candidates.json` when `watch` wrote it, with the day's intake files in Step 7.

```bash
node .claude/core/skill-evolution.js intake --since <date-or-omit> --date <YYYY-MM-DD>
```

`--date` is a real calendar day that only names the output folder (anything else exits 2).

This writes `docs/.output/evolution/skills/{date}/intake.{json,md}` with ranked **IMPROVE** candidates (per-skill, with the agent-update evidence, per-signal `polarity` and `attribution` of `exact` or `tokens`), **CREATE** candidates (memory clusters with member IDs + keywords), a **`dispatchGaps`** list, an **`ambiguous`** list, a **`protectedTargets`** list and a **`gateFailures`** list. `revertCandidates` are rebuilt from the evidence (the ledger entry, a fresh watch window, the revert command computed from the validated commit), never copied from the queue file: a queue entry that is malformed, or that matches no applied change, is listed in `rejectedRevertCandidates` and never rendered; repair or remove it. They are for a person to decide, never IMPROVE candidates. Read `intake.json`. If `improve` and `create` are both empty → report "no skill-evolution signal" (still listing any `ambiguous`, `protectedTargets` and `gateFailures` entries under the Report's lines for a human call) and stop. IMPROVE `score` is IDF-weighted and not comparable with scores from toolkit versions before 6.2.

The agent-update logs carry structured issue rows (`agent-issue-log.js`: `| Agent | Story | Skill | Step | Signature | Run | Issue | Fix Applied |`). A row whose `Skill` cell exactly names an indexed skill is a confident attribution (`attribution: exact`); a row naming no known skill, and a legacy prose section, fall back to token overlap (`attribution: tokens`). A section that holds both prose and structured rows is read as both: each row is a signal and the section's remaining prose (its text without the structured tables) is one more. `signals` reports `rows`, `exactAttributed`, `attributed`, `ambiguous`, `unattributed`, `adjudicated` and `gateFailures`. The skill index is read from the canonical `.agents/skills`, with `.claude/skills` only as the fallback when the canonical directory is absent.

> **Every signal carries a `fingerprint`, and decided ones are not resurfaced.** That covers IMPROVE evidence, `protectedTargets` evidence, `ambiguous`, `unattributed`, `dispatchGaps`, `gateFailures` and each CREATE cluster (`cl-…`, over its member memory ids). The adjudication ledger `docs/.output/evolution/skills/_decisions.md` holds one line per decided signal, in the triage ledger pattern: `- {YYYY-MM-DD} · {fingerprint} · **killed|deferred|applied** — {reason}`. Intake only reads it; Step 2 (and Step 6 for an applied candidate) appends the lines. Missing or garbage content suppresses nothing. Limits of the fingerprints: any decision, `deferred` included, suppresses its signal permanently (nothing re-reads a deferral to revisit it); a gate-failure fingerprint is the signature alone, so a decision hides that signature however often it recurs afterwards; a prose section's fingerprint is its prose text (its structured tables excluded), so an edit to that prose revives it; a CREATE cluster's changes when its membership does; two identical rows (a retried `add`) are two signals and need one line each.

> **`protectedTargets` are NOT improvable.** Each is a skill that attracted evidence but sits in the protected set (`_lib/improvement-scope.js`, read from the project's guardrail rules; the toolkit's rules when the project has none; an unusable rules file protects every target). They never reach `improve`. Report them with their `reason`; a person changes them, never an improvement run. The check classifies one path, `.agents/skills/{skill}/SKILL.md` (also when the index fell back to `.claude/skills`), so a skill whose protected files are elsewhere in its tree (for example `skill-creator`'s `agents/` and `scripts/`) still reaches `improve`: every candidate for it is bounded afterwards by `_lib/improvement-scope.js check` on the resulting diff.

> **`gateFailures` are NOT skill candidates.** Each is a failure signature that recurred on 2 or more changed trees in the failure ledger (flaky and environment failures are never counted; an absent ledger is simply empty). The ledger names no skill, so a gate failure never creates an IMPROVE entry. Surface them under the Report's gate-failure line; if a person judges that one points at a skill gap, that skill enters Step 3 as a diagnosis with the failure log as its evidence.

> **`ambiguous` signals are NOT attributed.** Each is a near-tie (the winning skill did not beat the runner-up by the confidence margin) listed with its top candidates. They are kept out of IMPROVE so no differential eval is spent on a coin-flip; a person picks the skill, or drops the signal.

> **`dispatchGaps` are NOT skill-evolution candidates.** Each is a signal that attributed to a review/safeguard skill but whose text shows the safeguard *caught* the defect — so the gap is in the **dev-agent dispatch prompt** (e.g. `/run-todo`'s implementation prompt), not in the review skill. Do **not** open a skill eval for these (it would read Δ=0, exactly the wasted cycle two projects reported). Surface them in the Report under "Dispatch-prompt gaps" for the human to route; the scorer attributes by domain keyword and cannot tell *caught* from *slipped*, so it pre-separates them here. Likewise, an IMPROVE evidence line tagged `(caught)` is weaker evidence (a safeguard fired) than one tagged `(slipped)` — weight the diagnosis accordingly.

### Step 2 — Triage with the user (skip under `--auto`)

Present the candidates compactly:
- **IMPROVE** `<skill>` — N misalignments; one-line each.
- **CREATE** `<proposed-name>` — N memories clustered; the keywords + member memory descriptions.

Ask which to pursue (Accept / Skip per candidate). Under `--auto` there is no triage: the cycle takes the top eligible IMPROVE candidate by the rule in *The `--auto` cycle*, step A3 (a CREATE cluster needs a person, and `protectedTargets`, `gateFailures`, `ambiguous` and `dispatchGaps` are listed for the human and never pursued automatically).

Record every decided signal in the adjudication ledger (`docs/.output/evolution/skills/_decisions.md`): one `- {YYYY-MM-DD} · {fingerprint} · **killed|deferred** — {reason}` line per skipped or dropped signal (the fingerprints are in `intake.json`), so the next intake does not resurface it. Under `--auto` nothing is decided on the human's behalf, so no line is written.

### Step 3 — Reflective diagnosis (Main Agent)

For each pursued candidate, read the evidence and the relevant skill, then diagnose the *gap*:
- **IMPROVE** — read the named skill's `SKILL.md` + each cited agent-update section. What did the skill say (or fail to say) that let the misalignment happen? Is it missing a rule, ambiguous, or contradicted by reality? Confirm the evidence is a genuine empirical RED (an agent actually failed) — if it's speculative, drop it. No "this could be clearer" edits without a failure behind them.
- **CREATE** — read each member memory (`docs/.output/.memory/{cat}/{id}.json`). What single reusable capability do they share? Is it broad enough to be a skill (not project-specific — that belongs in CLAUDE.md per `skill-authoring`)?

### Step 4 — Draft / edit (follow `skill-creator`)

Resolve the canonical `.agents/skills/<name>` source first; a legacy native source is used only when no canonical counterpart exists. Workspace candidates never overwrite generated projections. Render after an accepted canonical change. Under `--auto` (including the sweep's Phase 5b) the draft goes through Step 5's differential like any other: there is no draft-and-conformance-only tier.

- **IMPROVE** → snapshot the selected canonical source into `<workspace>/skill-snapshot/`, then draft the surgical change at `<workspace>/candidate/SKILL.md`. The snapshot is the `old_skill` baseline. Do not edit live canonical source or generated native copies while drafting/evaluating. In an adopter, retained template additions still use the existing project-additions tail/inline fences; keep those in the candidate and apply only the accepted source change.
- **CREATE** → scaffold `<workspace>/candidate/SKILL.md` (matching `name`, concrete triggering description, complete body/resources). The baseline is `without_skill`. Only an accepted candidate becomes `.agents/skills/<name>/SKILL.md`; an unmigrated installation may use its supported legacy source.

Write the workspace + test cases per `skill-creator` Step "Running and evaluating test cases":
`docs/.output/evolution/skills/{date}/<skill>-workspace/`.

### Step 5 — Differential eval (the proof the gap closed)

Follow `skill-creator` Steps 1–4: dispatch with_skill + baseline runs in the same turn, capture `timing.json`, grade via `agents/grader.md` into `grading.json`, then aggregate:

```bash
node .claude/core/skill-eval.js aggregate <workspace>/iteration-1 --skill-name <name> --date <YYYY-MM-DD>
```

**Replicates & fixtures (esp. IMPROVE):** run **≥2 replicates per config** (`with_skill/run-1/`, `run-2/`, … and the same for the baseline) — a single sample per cell is too noisy to justify a skill-body rewrite. Include **at least one fixture where the targeted gap is the *only* thing that discriminates**, and do **not** telegraph the planted defect (no `# raises KeyError here` comments next to the bug): a fixture that signposts the issue saturates detection in *both* configs, so the delta collapses to framing and measures nothing.

**Expected layout** (the aggregator globs exactly this — wrong names load 0 records):
```
<workspace>/iteration-1/
  eval-<id>-<name>/
    eval_metadata.json
    with_skill/    grading.json (+ timing.json)   |  with_skill/run-<k>/grading.json …
    without_skill/ | old_skill/   (same shape — the baseline)
```

Record what the iteration graded, right after the aggregate (the held-out iteration, `<workspace>/holdout/iteration-1`, is aggregated the same way) and before `candidate/` is touched again:

```bash
node .claude/core/skill-evolution.js bind --run <workspace>
```

`bind` writes `<workspace>/iteration-<N>/binding.json`: the sha256 of `candidate/` and `skill-snapshot/` as the evaluation graded them, and `gradings`, the sha256 of every `grading.json` and `benchmark.json` under the iteration and its holdout (workspace-relative path to hash). It refuses (exit 1) when a file in either tree is newer than that iteration's `benchmark.json`: it was edited after the evaluation. Bind after BOTH the iteration and its holdout are aggregated, because a holdout aggregated afterwards is an added file. It is write-once and a repeat for the same hashes is a no-op. Step 6's apply (and a propose run) recomputes all of it, so a candidate edited after its evaluation can never ride the old verdict, and neither can a grading or benchmark file edited, deleted or added after the binding (those are ordinary files the verdict is computed from). A binding without `gradings` (the earlier shape) is refused like a missing one. The hashes catch an edit after the binding: whoever writes the gradings and then runs `bind` still gets a binding, so the run that grades and binds in one process (`skill-regress.js run`, which calls the same `bind`) is the stronger source. Edit anything here and you evaluate again into a new iteration.

Then let code decide. Do not read `benchmark.json` and judge the delta yourself:

```bash
node .claude/core/skill-eval.js verdict <workspace>/iteration-1 [--holdout <workspace>/holdout/iteration-1] [--min-replicates 2]
```

`verdict` reads the `benchmark.json` that `aggregate` wrote (it writes nothing) and prints one JSON object. Its exit code is the decision: **exit 0 accept**, **exit 4 reject**, **exit 3 data-quality** (the benchmark has warnings, or is not a usable benchmark: a present-but-malformed `grading.json` or a dropped baseline means the delta is built on incomplete data, so fix the named file and re-aggregate), exit 1 could not run (missing or unparseable `benchmark.json`, bad `--holdout` dir), exit 2 bad usage. Accept needs all of: no warnings; at least `--min-replicates` runs (default 2) in both arms of every eval; no eval whose own pass-rate delta is negative; a headline delta above zero; a holdout delta at or above zero when `--holdout` is given (a second iteration directory on held-out evals, the 60/40 split in `skill-creator`); and, when `tools/skill-prose-metrics.cjs` is present with the snapshot and candidate bodies in the workspace, a body that does not grow past `proseGrowth.bound` unless the delta is larger than the growth. A delta within 0.0001 of zero counts as zero (the benchmark rounds to 4 dp). The JSON carries every failed rule in `reasons` (`insufficient-replicates`, `negative-eval-delta`, `no-improvement`, `holdout-regression`, `prose-growth`), the `delta` and `holdoutDelta`, token and duration `totals`, and `proseGrowth` (`null` when the prose tool or a body is absent).

`fragile: true` means exactly one assertion discriminates and it is high-variance. It never changes the exit code, but say so when you present an accepted candidate: the win rests on one noisy assertion.

`lowPower: true` means the accept stands on thin evidence: `lowPowerReasons` names each floor missed (`evals<2`, `runs-per-arm<3`, `discordant-assertions<6`) and `nEvals`, `minRunsPerArm` and `discordantAssertions` give the counts. It never changes the exit code either, but a `lowPower` accept is **propose, never auto-apply**: stage it, say which floors it missed and let the human decide (or rerun with more evals and replicates first). `verdict` also decides on the benchmark recomputed from the raw gradings, not on the stored `benchmark.json`: a stored file that disagrees with them exits 3 (re-run `aggregate`), and an unknown or misspelled flag exits 2.

On a reject, `failureTraces` already holds the `extractFailureTraces` output (see below): feed it to the next Step 3 diagnosis rather than re-extracting it. A rejected candidate is iterated or dropped; do NOT apply a skill change the verdict rejected. Run the analyst pass (`agents/analyzer.md`) and generate the viewer (`eval-viewer/generate-review.js --static`) for the human.

**Mine the failure traces, don't stop at the scalar delta (GEPA).** The pass-rate Δ tells you *whether* the gap moved; it doesn't tell you *why* an assertion still fails. Extract the per-assertion failure evidence the harness threads through the benchmark — `verdict` prints it as `failureTraces` on a reject (it is `require('./.claude/core/skill-evolution.js').extractFailureTraces(benchmark)`), shaped `[{ eval_name, assertion, evidence }]`, one entry per assertion that failed under `with_skill` **and** left a diagnostic note — assertions that failed without evidence are excluded (they fall through to the scalar delta). When the delta is non-positive or the skill needs another iteration, pass these as a **Failure Traces** block back into the Step 3 diagnosis context — each block is the grader's own words on what the skill failed to make the agent do (e.g. "no INSERT observed" for a "seeds the DB" assertion). Ground the next edit in that trace, not in the bare number: it tells you which rule to add or sharpen. An empty traces list means no assertion left diagnostic evidence — fall back to the scalar delta and the original agent-update / memory evidence.

### Step 6 — Gate + apply

For each candidate whose Step 5 `verdict` returned exit 0 (accept). A candidate with exit 4 or exit 3 stops here: iterate or drop it, never apply it. An accept with `lowPower: true` is staged as a proposal only (never auto-applied, even when the user is not asked, as under `--auto`); a human may still accept it on review:

1. Conformance gate the workspace candidate:
   ```bash
   node .claude/core/skill-evolution.js check <skill-name> <workspace>/candidate/SKILL.md
   ```
   Must PASS: a name or description error fails it, and an over-budget body is a warning that is reported but does not fail it. Fix errors before applying. A candidate for a reference file (`<workspace>/candidate/references/<name>.md`, or in a subdirectory of `references/`) is accepted too: the frontmatter rules are skipped and only the size warning is kept. A file named `SKILL.md` is always checked as a skill, even inside `references/`.
2. Under `--auto`, stage the evaluated proposal exactly as *The `--auto` cycle* (steps A6 and A7) says and leave live sources untouched; the only unattended apply is the additive reference bullet that `skill-evolution.js auto-apply-check` allows (step A8).
3. The only apply path is `skill-evolution.js apply` (`_lib/skill-apply.js`), which replaces the hand-run snapshot, copy, scope check, render, conformance and gate sequence. It is propose-only by default (Owner Decisions 12 and 15; `improvement.autoApply` stays off): the first command writes nothing and prints the verdict, the candidate hash and the files it would write; the second runs only when the user accepts the candidate, and needs the hash the first one printed:
   ```bash
   node .claude/core/skill-evolution.js apply <skill-name> --run <workspace> [--min-replicates 2]
   node .claude/core/skill-evolution.js apply <skill-name> --run <workspace> --mode apply --branch auto/{skill-name}-{date} --candidate-sha256 {candidateSha256 from the propose run}
   ```
   `<workspace>` holds `skill-snapshot/` (the whole old skill directory), `candidate/` (an overlay of the changed files; nothing is deleted), `iteration-<N>/` and `holdout/iteration-<N>/`. The helper judges the highest-numbered `iteration-<N>` of the workspace and the holdout beside it, and nothing else: `--iteration` and `--holdout` are only accepted when they name exactly those directories, so a foreign or older iteration never supplies the evidence. It also refuses a candidate or snapshot that differs from what `iteration-<N>/binding.json` recorded (Step 5's `bind`: `failedStep: candidate-hash`), and an accept with no `holdout/iteration-<N>` is a low-power accept (`no-holdout-evidence`): proposed, never applied. `--mode apply` needs a clean working tree (run it in a checkout or worktree nobody else is writing to); the workspace itself may stay where Step 4 builds it, untracked under `docs/.output/evolution/` (or at an ignored path): exactly that path is left out of the clean-tree check, the scope judgement, the restore and the printed `files`, and any other in-repository location is refused. It refuses, with a JSON `failedStep`, when: a tracked file carries assume-unchanged or skip-worktree (`dirty-tree`: git cannot see edits to it, so a restore could not be verified; clear the flag), the `verdict` is not an accept (`verdict`; a `lowPower` accept is `lowpower`: rerun Step 5 with more evals, replicates and a holdout, or have a person make the edit by hand), the snapshot no longer equals the live skill directory (`drift`: reconcile, then re-evaluate), the candidate touches an eval, a hook, a grader, a test, a skill's `scripts/` or any other executable or protected file (`scope`), or the branch already exists (`branch`). Then it records the bytes of every file it may overwrite (the skill's three directories, ignored files included, and the ship seal, freeze state and ac-verify records), creates the local `auto/` branch, copies the candidate, runs `improvement-scope.js check` from a trusted copy of the base commit with a baseline kept outside the repository (BEFORE the render, because a rendered copy classifies `outside-scope` by design), `render-shared-agents.js`, `render-shared-agents.js --check`, `skill-evolution.js check` on the skill and `gate.js test`, and a final scope check that tolerates only the render outputs and the gate's own receipt, receipt history and appended failure-ledger rows (a changed seal, freeze state, ac-verify record, rewritten ledger or any other changed file is a `scope` failure). A failure at any step (`copy`, `render`, `render-check`, `conformance`, `gate`, `scope`) restores the whole tree byte-exactly, verifies the restore by sha256 and `git status`, deletes the branch and exits 1; `restored: true` is only printed once that verification passed, and `failedStep: restore` means it did not (the tree is not back: inspect it before anything else); exit 2 is invalid input.
   The helper's scope step is the caller contract of `_lib/improvement-scope.js`: record the base and a baseline outside the repository BEFORE the change, then judge the diff before the render, from a trusted copy of the base commit's checker. To reproduce a `scope` failure by hand (never as a substitute for the helper):
   ```bash
   base="$(git rev-parse HEAD)"
   node .claude/core/_lib/improvement-scope.js snapshot --base "$base" --out "{path outside the repository}/improvement-baseline.json"
   # ...the candidate is copied onto the canonical source...
   node .claude/core/_lib/improvement-scope.js check --base "$base" --target <skill-name> --baseline "{path outside the repository}/improvement-baseline.json"
   # ...only then the render: render-shared-agents.js
   ```
   Any non-zero exit stops here: exit 1 lists the refused paths in `violations`, exit 2 means the check could not run (unusable rules, a bad base, a baseline path inside the repository); the helper reports both as `failedStep: scope` and restores the tree. Never render, commit or claim the change applied past a non-zero check.
   On success it prints `files`, exactly what `git status` reports: stage those and no others. It never commits, never stages and never pushes; the commit goes through `commit.js` on the `auto/` branch in Step 7, and merging that branch is the owner's decision. A CREATE candidate (a new skill directory) is refused as unknown input: promote an accepted new skill by hand per Step 4, then render, run the conformance check and the gate. The side-door route (`--route side-door`) is not used here: it exists for the sweep and retro to take a typo, stale-pointer or pinned-text fix without a verdict, and the code refuses it for any other edit.
4. Record the proposal, the `verdict` with its `reasons`, `fragile` and `lowPower` (with `lowPowerReasons`), the measured `delta` and the actual applied/staged disposition in `docs/.output/evolution/skills/{date}/proposals.md`. For an applied candidate, append an `**applied**` line for each evidence fingerprint to the adjudication ledger. An applied candidate's commit holds the helper's `files` (canonical source, computed native output and the ownership ledger) plus the workspace artifacts **and the evolution ledger** `docs/.output/evolution/skills/{date}/ledger.json` (the helper leaves it out of `files` on purpose, so stage it by name: an unstaged ledger is lost audit trail, and it is what Step 7b completes); auto/propose-only commits contain staging artifacts and that ledger only.

### Step 7 — Commit

Stage the specific accepted canonical skill/resource files, computed native projections, render ledger, workspace artifacts, `proposals.md`, the day's `ledger.json` (every disposition the helper reached is recorded there, a proposal or a refusal included) and `revert-candidates.json` when `watch` wrote it; for an applied candidate the first three are exactly the helper's `files` list, and the commit goes on the `auto/` branch the helper created. Write the message to `docs/.output/.state/.commit-msg` (Write tool, without automatic attribution), then `node .claude/core/commit.js`:

```
feat: /review:evolve-skills — {CREATE <name> | IMPROVE <skill>} (pass-rate Δ +N pts)

{one line per applied candidate with its benchmark delta}
```

Under `--auto`, the commit is the cycle's staging commit on its local `auto/evolve-…` branch (step A7), made through `commit.js` like any other and never a skill change on the branch you started on.

**Step 7b — Record the landed commit (after the owner merges).** An applied entry is written with `commit: null` and cannot graduate, be watched or carry its `git revert <hash>` pointer until the change has landed on the default branch and its commit is recorded. Merging is the owner's decision (fast-forward, `--no-ff` merge or squash all work), so this step runs after the merge, on the default branch, in this session or at the start of the next one (`watch` lists every applied entry that still shows `no-commit`, with its `candidate_sha256`):

```bash
node .claude/core/skill-evolution.js record-commit --candidate-sha256 {candidateSha256 from the apply output} --commit {the commit that holds the change on the default branch}
```

The commit is the fast-forwarded apply commit, the merge commit or the squash commit: `git log -1 --format=%H -- .agents/skills/{skill}` on the default branch right after the merge names it; if later commits touched the skill, try the newest ones first, because the helper verifies instead of trusting. It refuses (exit 1, `failedStep: record`, nothing written) a commit that is not reachable from the default branch (a commit that exists only on the `auto/` branch is refused, whatever branch you are on), whose diff on the skill's files is not exactly the change the entry evaluated, or that another entry already holds; and it fills in the commit and the exact `git revert {commit}` text once (write-once). It never runs the revert. Then stage `docs/.output/evolution/skills/{date}/ledger.json` (the date of the entry's ledger) and commit it through `commit.js`, message `docs: /review:evolve-skills — record {skill} commit {short hash}`: a ledger entry cannot carry the hash of the commit that holds it, so this is a second commit. A candidate applied again after a revert is a new application with its own entry and its own commit.

`status` reports, per change class, the consecutive accepted changes that landed on the default branch with no revert and no scoreboard regression inside the watch window, against the graduation thresholds in the gate config (read as committed at HEAD: an uncommitted edit changes nothing). A change with too few scoreboard runs around it is `unmeasured` and counts for nothing until there are enough; a ledger line that git cannot tie to a commit is `unverified`. Run it before anyone considers turning `improvement.autoApply` on; `ready` on a class is a measured decision, never a hand-written entry.

## The `--auto` cycle (headless, propose-only)

`--auto` is the whole improvement loop with a person left out of every step except the last one: a person reads a branch. Three rules hold throughout: **the worker never grades itself** (the evaluator is code, `skill-regress.js` and `skill-eval.js verdict`, and the drafting step never edits it or the suite: in a wrapper run that is enforced by code, in an in-session run it is the session's own discipline, see the table below), **nothing lands without a candidate diff plus evidence** (the verdict, the ledger entry and the failure traces ride on the branch), and **it never merges, never pushes and never touches the live skill**. Not in this cycle: editing the proposer itself, an archive of evolved agents, an overseer model, auto-merge. Prune by default: a net addition to a skill needs a size justification, because instruction bloat is the failure this loop is most likely to cause.

An unattended schedule (the weekly recipe in `docs/reference/agents/guides/scheduled-runs.md`, "Weekly improvement cycle") runs every command below from a wrapper, and the model performs only step A4 (the draft), with file tools. The steps are the contract either way: run by the Main Agent in a session, or by that wrapper.

**What is enforced where.** The two ways of running the cycle do not have the same walls, and the table says which are code:

| Wall | Wrapper run (`improve-cycle.sh`) | In-session run (the Main Agent follows this file) |
|------|----------------------------------|----------------------------------------------------|
| the drafting step cannot edit the evaluator, the suite, the ledger, the gate config or a hook | code: the model has file tools only, confined to the draft folder in a throwaway copy, and a before/after tree check blocks the run | the session's own discipline: the drafter is the Main Agent, which can write any file (the gate config and the held-out suite are read-only to subagents only). Nothing here stops a compromised session |
| the budget | code: `auto-check --skill` counts the suite and derives the runs and the caps; the wrapper passes its printed values | code computes the plan (`auto-check --skill {skill}` prints it), and the session passes the printed values on; that it ran the check and used the values is the session's honesty, visible in the transcript and in the ledger's token totals |
| `improvement.autoApply` and `improvement.budget` | code: read from the gate config as committed at `HEAD` | the same code |
| whether a staged candidate may be applied | never decided: the wrapper applies nothing and only logs the committed switch | code: `auto-apply-check` (A8), then the apply helper's own protected-set check, render, conformance check and full gate |
| never push, never merge | the wrapper contains no such command | prose: the commit guardrail blocks force forms only, so a plain `git push` is not stopped by code; do not run one |

Where a row says "the session's own", this file is an instruction and not a wall. Run the cycle unattended from the wrapper when the walls matter.

**A0. Preconditions** (a refusal prints the reason and exits 2 with no run record and no model call): a git work tree; `HEAD` on a branch, not detached (or detached only on a commit a non-`auto/*` branch holds) and not an `auto/*` branch (unmerged work nobody has reviewed); an empty `git status --porcelain`; `tools/skill-regress.js` present (it is workshop-only: a project that wants the cycle vendors it with its suite). Record the starting branch name, `orig`. Then open the run record: `node .claude/core/run-record.js start --command do --input "evolve-skills --auto {date}"` (the helper files every scheduled run under `do`; the id it prints is `{run-id}`). The gate config's `improvement.budget` and `improvement.autoApply` are read by code at A5 and A8; a value that is not valid exits 2 there and the run fails closed.

**A1. Watch, then intake.** `node .claude/core/skill-evolution.js watch` (Step 1: it writes only `revert-candidates.json`, and only when it finds a plausible regression). When it queued a candidate, commit that file alone through `commit.js` on `{orig}` before anything else (message `docs: /review:evolve-skills --auto — queue revert candidates`; it is the audit trail, no skill file is touched): the file is never part of the staged branch, and an uncommitted file would fail A9's clean-tree check. Then `node .claude/core/skill-evolution.js intake --date {YYYY-MM-DD}` (add `--since {date}` when one was given) and read `intake.json`. Nothing to report (`improve` and `create` both empty) ends the cycle `nothing-to-do`.

**A2. Rank.** `improve` is already ranked by score. Take the candidates in order.

**A3. Pick the top eligible candidate(s).** A candidate is eligible when all of these hold, checked by code and not by judgment: it is an IMPROVE entry (not `ambiguous`, `protectedTargets`, `gateFailures`, `dispatchGaps` or `revertCandidates`); `node tools/skill-regress.js list --skill {skill}` reports at least 2 checkable `dev` evals and at least one checkable `holdout` eval (a skill with no holdout cannot be measured honestly, and the verdict calls an accept on fewer than 2 dev evals low-power: a candidate measured on a smaller suite could only ever be proposed and never applied, so it is not staged); `node tools/skill-regress.js validate --skill {skill}` exits 0; and the skill has not been worked on lately: no local `auto/evolve-{skill}-*` branch that `HEAD` does not hold (unreviewed work), and not every evidence id of the candidate already appears in a ledger entry of that skill from the last 28 days (a candidate with one new id is a new case). Keep the first `--candidates` eligible ones (default 1). None eligible ends the cycle `nothing-to-do`, with the reason per skipped candidate in the report.

**A4. Draft (the only model step).** For each picked candidate, diagnose the gap from the cited evidence (Step 3), then draft the change. Build the draft at `<workspace>/draft/`: a copy of the live skill directory without `evals/`, plus the change. The regression run in A5 writes the rest of the workspace from it: `<workspace>/candidate/` (a copy of the draft, the directory the evaluation binds and the apply helper reads) and `<workspace>/skill-snapshot/` (a copy of `--baseline`, the whole live directory, which the apply helper compares with the live one for drift). The workspace is `docs/.output/.state/work/{date}/evolve-{skill}/`: ignored state, so a cycle that ends before it stages anything leaves the working tree clean; only the ledger and the evidence copied onto the staging branch (A6) are ever written to the tracked `docs/.output/evolution/skills/` folder. The draft is a whole skill version because the regression run measures one: files you do not change ride along byte for byte (a skill's `scripts/` included), and the apply helper judges only what differs from the live skill, so a changed or new file outside `SKILL.md` and `references/`, or a deleted file, is the offence. Rules the draft keeps: **prefer an additive reference bullet** (a new or extended file under `references/` that keeps every existing line; it is the only class that can ever apply unattended); a `SKILL.md` body edit may be staged but never applies unattended and meets the verdict's prose-growth rule; the `SKILL.md` frontmatter (the skill's grant of tools, hooks and triggers) stays byte for byte; no inline shell form (an exclamation mark and a backtick), no `allowed-tools`, `hooks` or `shell` line and no invisible or direction-changing character in anything you add; no edit to an eval, a grader, a script, a hook, a test or anything the protected set names; never read the held-out suite under `tools/skill-holdout/` or name it, or the dev answer keys, in the draft (the proposer sees pass or fail for it, nothing more). Gate the draft before any eval spend: `node .claude/core/skill-evolution.js check {skill} <draft file>` must PASS, for `SKILL.md` and for each changed reference file.

**A5. Budget check, then measure.** Code derives the plan; the cycle does not state one. `candidates` is the number picked:

```bash
node .claude/core/skill-evolution.js auto-check --candidates {N} --skill {skill}
```

It counts the suite (`skill-regress.js list`), derives `runs` as `(dev + holdout checkable evals) × 2 arms × 3 repeats` (3 runs per arm is the verdict's low-power floor: with 2 the accept is low-power and can never be applied), takes the caps from the committed `improvement.budget` block less the spend that is not the regression run's (one agent's cap for the run that crosses a cap), and prints them under `regress` (`repeat`, `maxRuns`, `maxTokens`, `maxCostUsd`, `agentMaxUsd`). Exit 0 is within budget. **Exit 12 means the plan is above the `improvement.budget` block (max candidates, max runs, max tokens, max cost), or that its runs at the measured cost of a run (the estimate and its source are in the output) could not finish inside its own caps: the cycle refuses to start, makes no further model or eval spend and finishes the run record `budget-exhausted` (exit 12).** Exit 1 is a suite below the minimum (not a candidate: `nothing-to-do`), exit 2 a missing flag or a bad config: finish `failed`. (A caller that must state its own numbers passes `--runs {R} --tokens {T} --cost-usd {C} [--extra-cost-usd {X}]` instead of `--skill`; the same checks apply.) Within budget, run each candidate (the model's draft is the only input it gets), with exactly the values printed:

```bash
node tools/skill-regress.js run {skill} --candidate <workspace>/draft --baseline .agents/skills/{skill} --out <workspace> --repeat {repeat} --max-runs {maxRuns} --max-tokens {maxTokens} --max-cost-usd {maxCostUsd} --agent-max-usd {agentMaxUsd}
```

It runs the dev and holdout suites in one pass (objective `check` commands, no grading subagents), writes the dev and holdout `iteration-N` directories, aggregates, binds the evaluation (`binding.json`) and prints its token and cost totals. Its exit code is the verdict's (0 accept, 4 reject, 3 data-quality, 1 unchecked) or 12 when a cap stopped it; a partial suite is never judged. **A stop is still recorded:** on exit 12, a timeout or exit 1 (no run executed), run `node .claude/core/skill-evolution.js record-stop --skill {skill} --run <workspace> --evidence {fingerprints from intake.json}` (it writes a `dropped` ledger entry with the tokens and time the workspace's own run records show), stage it as A6 and A7 describe, and finish the run `budget-exhausted` (exit 12). Then the decision, as in Step 5 (`{N}` is the highest iteration number):

```bash
node .claude/core/skill-eval.js verdict <workspace>/iteration-{N} --holdout <workspace>/holdout/iteration-{N}
```

**A6. Stage on a local branch.** Create `auto/evolve-{skill}-{date}` from `HEAD` (`git switch -c`; the cycle holds a clean tree, and the workspace is ignored, so nothing but the intake files written so far comes with it), copy the evidence into the tracked folder with `cp -a <workspace>/. docs/.output/evolution/skills/{date}/{skill}-workspace/` (then delete its `draft/` folder: the regression run already copied it to `candidate/`; `-a` keeps the file times the apply helper's staleness check reads) and record the disposition through the apply helper's propose path against that copy, which writes nothing but the ledger:

```bash
node .claude/core/skill-evolution.js apply {skill} --run docs/.output/evolution/skills/{date}/{skill}-workspace --evidence {fingerprints from intake.json}
```

An accept becomes a ledger entry with status `staged` in `docs/.output/evolution/skills/{date}/ledger.json` (a `lowPower` accept too, with its `lowPowerReasons`); a reject, a data-quality verdict or a refusal is recorded `rejected` or `dropped` by the same call. The entry carries the delta, holdout delta, replicates, fragile flag and the token totals. Copy the token total and cost from the `skill-regress.js` output into `proposals.md` (Step 6.4's file) beside the verdict, its `reasons`, `fragile` and `lowPower`.

**A7. Commit the staging artifacts on that branch, nothing else.** Stage the specific files (the day's `intake.{json,md}`, the evidence folder, the day's `ledger.json`, `proposals.md`; never `revert-candidates.json`, which A1 already committed on `{orig}`) and commit through `commit.js` as Step 7 describes, message `docs: /review:evolve-skills --auto — {skill} {accept|reject} (staged)`. The branch is local and is never pushed: The owner merges it to main and deletes the branch and any worktree when done (Owner Decision 15).

**A8. Auto-apply, only when it is on.** `node .claude/core/skill-evolution.js auto-apply-check --candidate-sha256 {candidateSha256 from the A6 output}`. The default is `improvement.autoApply: off`, read from the gate config as committed at HEAD (`.claude/gate.config.json`; an edit counts once it is committed, and the file is in the protected set, so only the owner turns it on: `commit.js` refuses a staged change to `improvement.autoApply`, `.graduation`, `.watch` or `.budget` unless the owner runs it with `AGENTS_ALLOW_IMPROVEMENT_CONFIG=1`, which the Bash guardrail refuses from an agent); then the answer is exit 1 and the cycle goes on to A9 with the candidate staged. With it `on`, exit 0 requires every condition of Owner Decision 12's upgrade path that the ledger records: the entry is still the newest for its hash and still `staged`, the change class is `additive-reference`, the dev delta is above 0, the holdout delta is at or above 0, replicates are at least 3, the entry is not fragile, the benchmark it points at is not low-power by the verdict's floors (at least 2 dev evals, 3 runs per arm and 6 discordant assertions: the apply helper refuses a low-power accept, so the check must not say yes to one), and the class has graduated on changes git proves (`status`: the consecutive landed, unreverted, measured changes reach `improvement.graduation.consecutive`; a hand-written ledger cannot graduate a class). Only then, still on the staging branch with its clean tree, `node .claude/core/skill-evolution.js apply {skill} --run docs/.output/evolution/skills/{date}/{skill}-workspace --mode apply --branch auto/evolve-{skill}-{date}-apply --candidate-sha256 {candidateSha256}`, which adds the protected-set check, the render, the conformance check and the full gate and restores everything on any failure; then Step 7's commit of its `files` and the ledger on that branch. `record-commit` (Step 7b) waits for the owner's merge: it refuses a commit that is only on a branch, so the entry stays `no-commit` until the next cycle's A1 `watch` shows it landed. Never push. A refused or failed apply leaves the candidate staged.

**A9. Return to where you started.** `git switch {orig}`. The live skill directories, the generated native copies and the branch you started on are exactly as they were: `git branch --show-current` prints `{orig}` and `git status --porcelain` is empty, which the cycle checks (anything else finishes the run `blocked`).

**A10. Finish and return the run-record exit code.** `node .claude/core/run-record.js finish --run-id {run-id} --status {status}`; its exit code is the cycle's exit code (a stop is non-zero by design, only exit 2 is a refusal of the record itself):

| What happened | `--status` | Exit |
|---------------|-----------|------|
| a candidate was accepted and staged (the branch is ready to read), or applied under A8 | `needs-human` | 10 |
| nothing eligible, nothing in the intake, or the candidate was rejected or dropped (the branch holds the evidence) | `nothing-to-do` | 0 |
| the A5 budget check refused, or `skill-regress.js` stopped on a cap (a `dropped` entry with the tokens spent is on the branch) | `budget-exhausted` | 12 |
| `HEAD` is not back on `{orig}` or the tree is dirty after A9 | `blocked` | 11 |
| the outer timeout of a wrapper fired | `killed` | 13 |
| the regression run could not run at all (no CLI, no run executed), a step crashed, or the ledger could not be written | `failed` | 1 |

The report is Step 7's table with the branch name, the status and exit code, the run id, and the tokens and cost of the evaluation. Staged candidates go in the "Staged (need you)" count and the report says which branch to merge or delete.

## Report

```markdown
## /review:evolve-skills Complete — {date}

| Path | Skill | Evidence | Δ pass-rate | Action |
|------|-------|----------|-------------|--------|
| IMPROVE | {skill} | {N misalignments} | {+N pts} | Applied / Staged / Dropped |
| CREATE | {name} | {N memories} | {+N pts} | Applied / Staged / Dropped |

**Intake:** {I} IMPROVE · {C} CREATE candidates · {A} ambiguous · {U} unattributed signals · {P} protected targets · {G} recurring gate failures · {J} adjudicated (suppressed)
**Applied:** {N}   **Staged (need you):** {M}   **Dropped (no differential):** {K}
```

## What NOT to Do

- Do NOT run the eval/grading subagents on `deep` tier — they are mechanical (execute the suite, grade against the rubric), so they MUST be dispatched as `general-purpose` with `{{model-arg:standard}}`. Main Agent keeps diagnosis and `SKILL.md` authoring.
- Do NOT apply a skill change unless `skill-eval.js verdict` accepts it (exit 0) — the eval is the whole point. A `lowPower: true` accept is a proposal for a human to weigh, never an auto-apply.
- Do NOT propose an edit without empirical evidence of a gap (an agent-update misalignment, a recurring gate failure a person attributed to the skill, or a recurring memory cluster) — speculative polish is out of scope (`skill-authoring` doctrine).
- Do NOT apply anything under `--auto` unless `improvement.autoApply` is `on` in the gate config and `skill-evolution.js auto-apply-check` exits 0: the default is `off`, the file is protected (only the owner changes it: `commit.js` refuses a staged change to the switch, the graduation and watch thresholds or the budget without the owner's `AGENTS_ALLOW_IMPROVEMENT_CONFIG=1`), and the only change that can ever apply unattended is an additive reference bullet, on a branch that is never pushed (the managed pre-push hook refuses any push to `refs/heads/auto/*` without the owner's `AGENTS_ALLOW_AUTO_PUSH=1`).
- Do NOT start an `--auto` cycle past the budget block, and do NOT let the model pick the budget, the candidate count or the regression suite: those are code and config, not judgment (`auto-check --skill` derives the plan; pass its printed values, not your own).
- Do NOT duplicate memory promotion — that injects one memory into an existing skill; this synthesizes a new skill from a cluster or rewrites from failure traces.
- Do NOT push to remote.
