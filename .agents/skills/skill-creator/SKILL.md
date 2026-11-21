---
name: skill-creator
description: "Use WHEN authoring a SKILL.md, editing/optimizing an existing skill, running evals or benchmarks on a skill, or tuning a skill's description for better triggering. Create new skills, improve existing ones, and measure skill performance with a differential eval harness. Triggers: create skill, new skill, improve skill, edit skill, skill eval, benchmark skill, skill description, undertrigger, evals.json, with_skill vs without_skill."
metadata:
  version: 1.0.0
  author: Domdhi.Agents
  tags: [skills, evals, benchmark, self-improvement, skill-authoring]
user-invocable: false
allowed-tools: Read Write Edit Bash Grep Glob
---

# Skill Creator

For creating new skills and improving existing ones with measured evidence. A good result is a skill that demonstrably closes a real gap: it beats a baseline on realistic prompts, stays lean, and triggers when it should. Ported from Anthropic's `skill-creator` (anthropics/skills) to zero-dependency Node, this repo's subagent dispatch, and workspaces under `docs/.output/evolution/skills/`.

It is the operational half of two neighbours:
- `skill-authoring` owns the doctrine: when a skill is warranted, the evidence-first rule, description conventions, the spec. Read it for the why.
- `/review:evolve-skills` is the autonomous driver: it mines this repo's signals (agent-update misalignments, clustered workflow/pattern memories) and runs this loop hands-off. This skill is what it drives. Its `--auto` mode is the headless propose-only cycle (see "Regression suite and the unattended cycle" below).

## The loop

Decide what the skill should do (or what is wrong with it), draft or edit the SKILL.md, run it against test prompts and a baseline, grade and benchmark the difference, show the human the viewer, improve, repeat; optionally tune the description. Find where the user is in that loop and jump in: "I want a skill for X" starts at the top, "here's a draft" starts at the runs, "skip the evals" is a legitimate choice.

The doctrine that keeps it honest: a skill, new or edited, is justified by evidence of a real gap first and a differential eval after. The gap is the baseline: the `without_skill` run failing for a new skill, the `old_skill` run (or a misalignment or repeated gate failure) for an edit. No pre-writing pressure test is required, but showing the skill measurably closes the gap is.

Match the user's technical fluency; define "assertion" or "benchmark" briefly when in doubt.

---

## Creating a skill

**Capture intent.** The conversation may already contain the workflow ("turn this into a skill"); mine it first: tools used, step sequence, corrections, input/output formats. Then confirm what is missing: what the skill should enable, what phrases and contexts should trigger it, the expected output, and whether to set up test cases (worth it for verifiable outputs such as transforms, extraction and fixed workflows; usually not for style or design). Ask about edge cases, example files, success criteria and dependencies before drafting tests. Research in parallel when subagents or MCPs help.

**Write the SKILL.md.**
- `name` equals the directory name (`skill-conformance.js` enforces it).
- `description` is the triggering mechanism, at most 1024 characters. Say what the skill does and when to use it, and lean a little pushy, because models under-trigger skills ("...use this whenever the user mentions dashboards, internal metrics, or wants to display company data, even without saying 'dashboard'"). Put every "when to use" in the description, never the body. Do not summarize the workflow there: the model follows the summary instead of reading the body (`skill-authoring` CSO).
- The body opens with what the skill is for and what a good result looks like. State firm lines only where they are real (gates, commands, safety limits, parsed formats) and give judgment, with the reason, for everything else. All-caps rules are a yellow flag: reframe with the reasoning.

**Progressive disclosure.** `SKILL.md` (required), `scripts/` for deterministic work, `references/` loaded on demand (add a table of contents past 300 lines), `assets/` for templates copied into output. Metadata is always loaded, the body on trigger (under 500 lines; `skill-conformance.js` warns above), resources as needed. Past that, push detail into a reference and point to it. In this repo a producing skill's document templates live in its `assets/` and are wired into `scaffold.js`.

**Test cases.** Write 2-3 realistic prompts a user would actually say into the target skill's `evals/evals.json`; draft assertions while the runs are in flight (full schema in `references/schemas.md`):

```json
{ "skill_name": "example-skill",
  "evals": [ { "id": 1, "prompt": "User's task prompt", "expected_output": "Description of expected result", "files": [] } ] }
```

---

## Running and evaluating test cases

Run this as one continuous sequence, creating directories as you go:

```
docs/.output/evolution/skills/{date}/{skill}-workspace/
  iteration-1/  iteration-2/  ...
    eval-<id>-<descriptive-name>/
      eval_metadata.json
      with_skill/    outputs/  grading.json  timing.json
      without_skill/ outputs/  grading.json  timing.json   (new skill)
      # or old_skill/ ... when IMPROVING (snapshot the old skill first)
    benchmark.json  benchmark.md  review.html
```

### Step 1 — spawn all runs (with-skill AND baseline) in the same turn

Dispatch two `general-purpose` subagents per test case in the same turn, one given the skill and one without, so they finish together. Tell the with-skill agent the skill path, the eval prompt, any input files and `<workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/` as the output location.

The baseline gets the same prompt. For a new skill it has no skill and writes to `without_skill/outputs/`. When improving, snapshot first (`cp -r <skill> <workspace>/skill-snapshot/`), point the baseline at the snapshot and write to `old_skill/outputs/`.

Write an `eval_metadata.json` per eval (assertions may be empty for now):

```json
{ "eval_id": 0, "eval_name": "descriptive-name", "prompt": "...", "assertions": [] }
```

### Step 2 — draft assertions while runs are in flight

Draft objectively verifiable assertions with names that read clearly in the viewer, and explain them to the user. Judge subjective qualities qualitatively rather than forcing assertions onto them. Update `eval_metadata.json` and `evals/evals.json`.

### Step 3 — capture timing as runs complete

Each subagent completion notification carries `total_tokens` and `duration_ms`, and nowhere else does that data exist. Save it at once to `timing.json` in the run dir: `{ "total_tokens": 84852, "duration_ms": 23332, "total_duration_seconds": 23.3 }`.

### Step 4 — grade, aggregate, view

1. **Grade.** Dispatch a grader subagent that reads `agents/grader.md` and writes `grading.json` per run dir. The array must be `expectations` with `text`/`passed`/`evidence`: the aggregator and viewer depend on those names. Check programmatically checkable assertions with a script.
2. **Aggregate** (Node math, not an agent):
   ```bash
   node .claude/core/skill-eval.js aggregate <workspace>/iteration-N --skill-name <name> --date <YYYY-MM-DD>
   # (or the skill-local wrapper: node .claude/skills/skill-creator/scripts/aggregate-benchmark.js ...)
   ```
   This writes `benchmark.json` and `benchmark.md`: pass-rate, tokens and duration per config (mean ± stddev) and the delta. Schema: `references/schemas.md`.
3. **Analyst pass.** Read the benchmark for what aggregates hide: assertions with `discriminating:false`, evals with `high_variance:true`, time and token tradeoffs (`agents/analyzer.md`).
4. **Viewer.** Generate the static review HTML for the human, and generate it before you evaluate outputs yourself so the human sees examples first. Use the generator, not hand-written HTML:
   ```bash
   node .claude/skills/skill-creator/eval-viewer/generate-review.js <workspace>/iteration-N \
     --skill-name "<name>" --benchmark <workspace>/iteration-N/benchmark.json \
     --previous <workspace>/iteration-<N-1> --static <workspace>/iteration-N/review.html
   ```
   Give the user a clickable link to `review.html`.

### Step 5 — read the feedback

The viewer's "Download feedback.json" writes `{ "reviews": [{ "run_id": "eval-0-with_skill", "feedback": "...", "timestamp": "..." }], "status": "complete" }`. Empty feedback means it was fine; focus on the cases with specific complaints.

---

## Improving the skill

- **Generalize from the feedback.** The skill has to work across many prompts, not just these examples. Resist fiddly overfit changes; if an issue is stubborn, try a different metaphor or working pattern.
- **Keep the prompt lean.** Read the transcripts, not just the outputs; if the skill made the model waste effort, cut the part that caused it.
- **Explain the why.** Even terse or frustrated feedback usually has a real reason; understand the task, then transmit that understanding rather than a rule.
- **Bundle repeated work.** If every run independently wrote the same helper, write it once into `scripts/` and have the skill call it.

Then rerun every test case into `iteration-<N+1>/` with baselines (a new skill keeps `without_skill`; an improvement baselines against the snapshot or previous iteration, your call), regenerate the viewer with `--previous` pointing at iteration N, and read the feedback. Stop when the user is happy, the feedback is empty, or progress stalls.

## Blind comparison

For a rigorous "is the new version actually better?", give two outputs to an independent agent without saying which is which (`agents/comparator.md`), then analyze why the winner won (`agents/analyzer.md`, post-hoc role). Optional; the human review loop is usually enough.

## Description optimization

The description decides whether the skill is invoked at all, so offer to tune it after creating or improving a skill.

1. Generate about 20 trigger queries, 8-10 should-trigger and 8-10 should-not, realistic and specific (file paths, job context, casual phrasing, typos). The valuable negatives are near-misses that share keywords but need something else. Save as `[{ "query": "...", "should_trigger": true }]`.
2. Review them with the user through `assets/eval_review.html` (substitute the `__EVAL_DATA_PLACEHOLDER__`, `__SKILL_NAME_PLACEHOLDER__` and `__SKILL_DESCRIPTION_PLACEHOLDER__` placeholders, open it, let them edit and export `eval_set.json`).
3. Measure with `node .claude/skills/skill-creator/scripts/trigger-eval.js score <results.json>` (run each query a few times), propose a better description, re-measure on a held-out split to avoid overfitting, and iterate a few times.
4. Apply the best description by held-out score, not train, and show the user before/after with scores.

Models consult a skill only for tasks they cannot easily do alone, so trivial one-step queries never trigger regardless of description; the eval queries must be substantive multi-step tasks.

## Packaging

To hand a skill to an external agent: `node .claude/skills/skill-creator/scripts/package-skill.js <skill-dir>` (zips to `<name>.skill`, falls back to tar). In this repo skills ship through the template/publish pipeline, not as `.skill` files.

External skills are first-class targets: the same evidence-first, differential-eval doctrine applies (`ciso-nist-advisor` improved +14.6 then +62.5 pass-rate points over two gated rounds); only the ship path differs, a packaged `.skill` or PR handed back instead of the template pipeline.

## Regression suite and the unattended cycle

Accepted fixtures are kept and re-run so a later edit cannot undo an earlier gain. A fixture with an objective `check` command lives in the skill's `evals/evals.json` (dev: the proposer may read it) or in the protected held-out suite under `tools/skill-holdout/` (the proposer sees only pass or fail); `references/schemas.md` section 1 has the fields. `node tools/skill-regress.js list|validate|dry-run|run` is the evaluator: `run` measures a candidate directory against the live skill on both splits, binds the evaluation and exits with the verdict.

`/review:evolve-skills --auto` drives that evaluator without a person and stops at a local `auto/evolve-…` branch: intake, the top eligible candidate (a skill with dev and holdout fixtures), your draft, `skill-regress.js run`, `skill-eval.js verdict`, a `staged` entry in the evolution ledger, never a merge, a push or an edit to the live skill. In that mode you are the proposer only: prefer an additive reference bullet over a body rewrite, never edit the suite, the verdict code or the held-out fixtures, and justify any net growth in size. Its budget block (`improvement.budget`) and its auto-apply switch (`improvement.autoApply`, off by default) live in the protected gate config. The weekly trigger recipe is the "Weekly improvement cycle" section of `docs/reference/agents/guides/scheduled-runs.md`.

## Reference files

- `agents/grader.md`: grade assertions against outputs into `grading.json`
- `agents/analyzer.md`: benchmark pattern analysis and post-hoc winner analysis
- `agents/comparator.md`: blind A/B comparison
- `references/schemas.md`: every JSON shape (evals, grading, timing, benchmark, comparison, analysis, feedback) and the workspace layout

Skills must not contain malware or exploit code, and must not mislead the user about their intent or be designed to facilitate unauthorized access or data exfiltration; roleplay-style skills are fine.
