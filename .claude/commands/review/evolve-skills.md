---
description: Self-improving skills — mine this repo's own signals into skill CREATE/IMPROVE proposals, validate them with a differential eval, and apply on confirm
argument-hint: "[--create-only | --improve-only] [--auto] [--apply <skill-name>] [--since YYYY-MM-DD]"
---

<!-- Generated from .agents/skills/review-evolve-skills/references/workflow.md; edit the canonical source, then run node .claude/core/render-shared-agents.js. -->

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
| **IMPROVE** | `docs/.output/evolution/agents/*.md` misalignments + recurring gate failures, attributed to the skill that owns that domain | The misalignment IS the "current behavior failed" baseline — the `old_skill` already lost in the field |
| **CREATE** | Clusters of recurring `workflows` + `patterns` memories that **no existing skill covers** | The recurrence across N memories is the evidence agents keep re-deriving this unaided — the Voyager/Hermes "write the reusable pattern down" move |

CREATE is deliberately distinct from `/review:promote-memories` (which injects a *single* validated memory into an *existing* skill/CLAUDE.md). This command synthesizes a *new* skill from a *cluster*, or rewrites a skill from *failure traces*.

## Variables

- `--improve-only` / `--create-only` — run just one path (default: both).
- `--auto` — **sweep mode**: propose-only. Run intake + draft candidates + **the differential eval that gates them** (against a **workspace copy** — the live skill in `.agents/skills/` is never touched), but do NOT apply, commit, or iterate. Surface staged proposals for human review. Used by `/sweep` Phase 5b. (Skill *bodies* are the system's brain — never mutate them unattended; there is no safe auto-threshold for a rewrite, unlike memory promotion.) The differential always runs — it is the falsifier — `--auto` only withholds *applying* the result. "Propose-only" ≠ "skip the eval"; a proposal with no Δ is not a proposal.
- `--apply <skill-name>` — apply a previously-staged proposal for that skill: **runs the differential eval (the real gate)**, then re-validates conformance + the build/test gate, then commits. A non-positive `summary.delta.pass_rate` **blocks** the apply (see *What NOT to Do*) — conformance + build passing is necessary but not sufficient.
- `--since YYYY-MM-DD` — only consider agent-updates on/after this date (default: all day-rotated files).

## Orchestration Rule

> You (the main agent) own the reflective diagnosis and the SKILL.md authoring — that is the "why did it fail / what should the skill say" judgment. Dispatch `general-purpose` subagents **on `standard` tier** (pass `model: "sonnet"` on every such dispatch) only for the eval *runs* (with_skill / baseline) and grading — that work is mechanical execution (run the suite, grade against the rubric), not judgment, so it stays on the cheaper tier while Main Agent keeps the diagnosis + authoring. (`general-purpose` is a `standard`-tier agent by its adapter registry; the explicit `model: "sonnet"` makes the rule load-bearing so a future caller can't silently escalate the eval fleet to `deep` tier.) Follow the **`skill-creator`** skill for the loop mechanics and the **`skill-authoring`** skill for the doctrine; read them, don't paste them here.

## Workflow

### Step 1 — Intake (deterministic)

```bash
node .claude/core/skill-evolution.js intake --since <date-or-omit> --date <YYYY-MM-DD>
```

This writes `docs/.output/evolution/skills/{date}/intake.{json,md}` with ranked **IMPROVE** candidates (per-skill, with the agent-update evidence + per-signal `polarity`), **CREATE** candidates (memory clusters with member IDs + keywords), a **`dispatchGaps`** list, and an **`ambiguous`** list. Read `intake.json`. If `improve` and `create` are both empty → report "no skill-evolution signal" (still listing any `ambiguous` signals under the Report's "Ambiguous signals" line for a human call) and stop. IMPROVE `score` is IDF-weighted and not comparable with scores from toolkit versions before 6.2.

> **`ambiguous` signals are NOT attributed.** Each is a near-tie (the winning skill did not beat the runner-up by the confidence margin) listed with its top candidates. They are kept out of IMPROVE so no differential eval is spent on a coin-flip; a person picks the skill, or drops the signal.

> **`dispatchGaps` are NOT skill-evolution candidates.** Each is a signal that attributed to a review/safeguard skill but whose text shows the safeguard *caught* the defect — so the gap is in the **dev-agent dispatch prompt** (e.g. `/run-todo`'s implementation prompt), not in the review skill. Do **not** open a skill eval for these (it would read Δ=0, exactly the wasted cycle two projects reported). Surface them in the Report under "Dispatch-prompt gaps" for the human to route; the scorer attributes by domain keyword and cannot tell *caught* from *slipped*, so it pre-separates them here. Likewise, an IMPROVE evidence line tagged `(caught)` is weaker evidence (a safeguard fired) than one tagged `(slipped)` — weight the diagnosis accordingly.

### Step 2 — Triage with the user (skip under `--auto`)

Present the candidates compactly:
- **IMPROVE** `<skill>` — N misalignments; one-line each.
- **CREATE** `<proposed-name>` — N memories clustered; the keywords + member memory descriptions.

Ask which to pursue (Accept / Skip per candidate). Under `--auto`, pursue every candidate that clears the bar (IMPROVE: ≥1 attributed misalignment; CREATE: cluster size ≥3 OR avg confidence ≥0.8) and stage proposals without applying.

### Step 3 — Reflective diagnosis (Main Agent)

For each pursued candidate, read the evidence and the relevant skill, then diagnose the *gap*:
- **IMPROVE** — read the named skill's `SKILL.md` + each cited agent-update section. What did the skill say (or fail to say) that let the misalignment happen? Is it missing a rule, ambiguous, or contradicted by reality? Confirm the evidence is a genuine empirical RED (an agent actually failed) — if it's speculative, drop it. No "this could be clearer" edits without a failure behind them.
- **CREATE** — read each member memory (`docs/.output/.memory/{cat}/{id}.json`). What single reusable capability do they share? Is it broad enough to be a skill (not project-specific — that belongs in CLAUDE.md per `skill-authoring`)?

### Step 4 — Draft / edit (follow `skill-creator`)

Resolve the canonical `.agents/skills/<name>` source first; a legacy native source is used only when no canonical counterpart exists. Workspace candidates never overwrite generated projections. Render after an accepted canonical change. Under the enclosing `/sweep` Phase 5b, draft/conformance-only staging follows that phase's explicit override; do not claim a measured differential until the standalone apply workflow actually runs it.

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

Read `benchmark.json`. **Check `benchmark.warnings` first** (and watch for a non-zero exit / `WARN:` lines): a present-but-malformed `grading.json` or a dropped baseline makes the harness exit **3** and flag the eval — the delta is then built on incomplete data and is **not** trustworthy until you fix the named file and re-aggregate. The candidate is only legitimate if **`summary.delta.pass_rate > 0`** with **no warnings** (with_skill beats baseline). A zero/negative delta means the edit didn't help — iterate or drop it; do NOT apply a skill change that the differential doesn't justify. Run the analyst pass (`agents/analyzer.md`) and generate the viewer (`eval-viewer/generate-review.js --static`) for the human.

**Mine the failure traces, don't stop at the scalar delta (GEPA).** The pass-rate Δ tells you *whether* the gap moved; it doesn't tell you *why* an assertion still fails. Extract the per-assertion failure evidence the harness now threads through the benchmark — `require('./.claude/core/skill-evolution.js').extractFailureTraces(benchmark)` returns `[{ eval_name, assertion, evidence }]`, one entry per assertion that failed under `with_skill` **and** left a diagnostic note — assertions that failed without evidence are excluded (they fall through to the scalar delta). When the delta is non-positive or the skill needs another iteration, pass these as a **Failure Traces** block back into the Step 3 diagnosis context — each block is the grader's own words on what the skill failed to make the agent do (e.g. "no INSERT observed" for a "seeds the DB" assertion). Ground the next edit in that trace, not in the bare number: it tells you which rule to add or sharpen. An empty traces list means no assertion left diagnostic evidence — fall back to the scalar delta and the original agent-update / memory evidence.

### Step 6 — Gate + apply

For each candidate with a positive, warning-free differential:

1. Conformance gate the workspace candidate:
   ```bash
   node .claude/core/skill-evolution.js check <skill-name> <workspace>/candidate/SKILL.md
   ```
   Must PASS (name, description and body budget). Fix errors before applying.
2. Under `--auto`, record the evaluated proposal and leave live sources untouched. Under the enclosing sweep's draft-only Phase 5b, conformance is evidence for a staged draft, not a measured differential or permission to apply.
3. When the user accepts the candidate, apply the accepted change to the selected canonical source, preserving marked project additions and resources. If that source changed after the snapshot, reconcile it before claiming the benchmark still applies. Render and check native projections:
   ```bash
   node .claude/core/render-shared-agents.js
   node .claude/core/render-shared-agents.js --check
   node .claude/core/skill-evolution.js check <skill-name> .agents/skills/<skill-name>/SKILL.md
   node .claude/core/gate.js test
   ```
   A failing build/test stops application completion; do not claim the change is ready.
4. Record the proposal, measured delta and actual applied/staged disposition in `docs/.output/evolution/skills/{date}/proposals.md`. Accepted commits include canonical source, computed native output and ownership ledger; auto/propose-only commits contain staging artifacts only.

### Step 7 — Commit

Stage the specific accepted canonical skill/resource files, computed native projections, render ledger, workspace artifacts and `proposals.md`. Write the message to `docs/.output/.state/.commit-msg` (Write tool, without automatic attribution), then `node .claude/core/commit.js`:

```
feat: /review:evolve-skills — {CREATE <name> | IMPROVE <skill>} (pass-rate Δ +N pts)

{one line per applied candidate with its benchmark delta}
```

Under `--auto`, do NOT commit applied skill changes (nothing was applied) — the sweep's report carries the staged proposals.

## Report

```markdown
## /review:evolve-skills Complete — {date}

| Path | Skill | Evidence | Δ pass-rate | Action |
|------|-------|----------|-------------|--------|
| IMPROVE | {skill} | {N misalignments} | {+N pts} | Applied / Staged / Dropped |
| CREATE | {name} | {N memories} | {+N pts} | Applied / Staged / Dropped |

**Intake:** {I} IMPROVE · {C} CREATE candidates · {A} ambiguous · {U} unattributed signals
**Applied:** {N}   **Staged (need you):** {M}   **Dropped (no differential):** {K}
```

## What NOT to Do

- Do NOT run the eval/grading subagents on `deep` tier — they are mechanical (execute the suite, grade against the rubric), so they MUST be dispatched as `general-purpose` with `model: "sonnet"`. Main Agent keeps diagnosis and `SKILL.md` authoring.
- Do NOT apply a skill change whose differential `delta.pass_rate` is not positive — the eval is the whole point.
- Do NOT propose an edit without empirical evidence of a gap (an agent-update misalignment, a gate failure, or a recurring memory cluster) — speculative polish is out of scope (`skill-authoring` doctrine).
- Do NOT auto-apply skill-body changes under `--auto` — stage proposals; the human confirms.
- Do NOT duplicate `/review:promote-memories` — that injects one memory into an existing skill; this synthesizes a new skill from a cluster or rewrites from failure traces.
- Do NOT push to remote.
