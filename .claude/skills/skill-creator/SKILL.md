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

A skill for **creating new skills and iteratively improving them with measured evidence.** Ported and tuned from Anthropic's official `skill-creator` (anthropics/skills) for this toolkit: **zero-dependency Node** instead of Python, this repo's **subagent dispatch**, and workspaces under `docs/.output/evolution/skills/`.

**This is the operational complement to two other parts of the system:**
- **`skill-authoring`** owns the *doctrine* — when a skill is warranted, the evidence-first rule, description/CSO conventions, the spec. Read it for the "why."
- **`/review:evolve-skills`** is the *autonomous driver* — it mines this repo's own signals (agent-update misalignments → IMPROVE; clustered workflow/pattern memories → CREATE) and runs this skill's loop hands-off, flag-then-confirm. This skill is what it drives.

## The core loop

```
1. Decide what the skill should do (or what's wrong with an existing one)
2. Draft / edit the SKILL.md
3. Run claude-with-the-skill on test prompts AND a baseline (without the skill)
4. Grade + benchmark the difference; show the human the eval viewer
5. Improve based on feedback + the benchmark
6. Repeat until satisfied; optionally optimize the description for triggering
```

Your job is to figure out where the user is in this loop and jump in. "I want a skill for X" → start at step 1. "Here's a draft" → go to step 3. "Just vibe with me, skip the evals" → fine, do that. Be flexible.

**The doctrine that makes this honest** (full version in `skill-authoring`): a skill — new or edited — is justified by **evidence of a real gap first, then a differential eval after**. The gap is the *baseline*: for a new skill it's the `without_skill` run failing; for an edit it's the `old_skill` run (or an agent-update misalignment / repeated gate failure) showing the current behavior is wrong. You are NOT required to pressure-test a subagent *before* writing — that old "failing test first" rule was retired (see the ADR referenced in `skill-authoring`). You ARE required to show the skill measurably closes the gap.

## Communicating with the user

Users span a wide range of technical fluency. Read context cues. "Evaluation" and "benchmark" are usually fine; for "JSON" and "assertion," look for signs the user knows the terms before leaning on them, and briefly define when in doubt.

---

## Creating a skill

### Capture intent

The current conversation may already contain the workflow to capture (e.g. "turn this into a skill"). Mine it first — tools used, the step sequence, corrections the user made, input/output formats. Then confirm gaps with the user before proceeding. Ask:

1. What should this skill enable Claude to do?
2. When should it trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases? Objectively verifiable outputs (file transforms, extraction, code generation, fixed workflows) benefit from them; subjective outputs (writing style, design) often don't. Suggest a default by skill type, but let the user decide.

### Interview and research

Proactively ask about edge cases, I/O formats, example files, success criteria, dependencies. Hold off on test prompts until this is ironed out. If MCPs/subagents are available and useful (searching docs, finding similar skills), research in parallel.

### Write the SKILL.md

Fill in:
- **name** — must equal the skill's directory name (enforced by `skill-conformance.js`).
- **description** — the primary triggering mechanism. State **what it does AND when to use it**, and make it a little **"pushy"** — Claude tends to *under*-trigger skills. e.g. not "Build a dashboard for internal data" but "Build a dashboard for internal data. Use this whenever the user mentions dashboards, data visualization, internal metrics, or wants to display company data, even if they don't say 'dashboard.'" Put ALL "when to use" info here, not in the body. **But do not summarize the step-by-step workflow** in the description — that creates a shortcut Claude follows instead of reading the body (see `skill-authoring` CSO). ≤1024 chars (hard spec ceiling).
- **the body** — see structure below.

### Anatomy & progressive disclosure

```
skill-name/
├── SKILL.md (required: name + description frontmatter, instructions body)
├── scripts/      - executable code for deterministic/repetitive work
├── references/   - docs loaded on demand (TOC if >300 lines)
└── assets/       - templates/resources copied into output
```

Three loading levels: metadata (always, ~100 words) → SKILL.md body (on trigger, **<500 lines** — `skill-conformance.js` WARNs over) → bundled resources (as needed). If the body nears 500 lines, add a layer of hierarchy with clear pointers to the reference file to read next. In this repo, **document templates owned by a producing skill live in that skill's `assets/`** and are wired into `scaffold.js` — see the toolkit CLAUDE.md.

### Writing style

Prefer the imperative. **Explain the *why*** behind instructions instead of heavy-handed `ALWAYS`/`NEVER` caps — today's models have good theory of mind and a reasoned harness beats rote rules. If you catch yourself writing all-caps MUSTs or rigid scaffolding, that's a yellow flag: reframe and explain the reasoning. Write a draft, then re-read with fresh eyes and improve.

### Test cases

After the draft, write 2-3 realistic prompts a real user would actually say. Save them to the **target skill's** `evals/evals.json` (don't write assertions yet — you'll draft those while runs are in flight):

```json
{ "skill_name": "example-skill",
  "evals": [ { "id": 1, "prompt": "User's task prompt", "expected_output": "Description of expected result", "files": [] } ] }
```

Full schema (including `assertions`, added later): `references/schemas.md`.

---

## Running and evaluating test cases

One continuous sequence — don't stop partway. Put results in the workspace:

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

Create dirs as you go, not upfront.

### Step 1 — spawn all runs (with-skill AND baseline) in the same turn

For each test case, dispatch **two subagents in the same turn** — one given the skill, one without. Don't do all the with-skill runs first and baselines later; launch everything at once so they finish together. Use the repo's subagent dispatch (the Agent/Task tool); these are implementation runs, so `general-purpose` is the right agent type.

**With-skill run** — tell the agent: the skill path, the eval prompt, any input files, and to save outputs to `<workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/`.

**Baseline run** (same prompt):
- **New skill** → no skill at all, save to `without_skill/outputs/`.
- **Improving** → snapshot the current skill first (`cp -r <skill> <workspace>/skill-snapshot/`), point the baseline at the snapshot, save to `old_skill/outputs/`.

Write an `eval_metadata.json` per eval (assertions can be empty for now) with a descriptive `eval_name`:

```json
{ "eval_id": 0, "eval_name": "descriptive-name", "prompt": "...", "assertions": [] }
```

### Step 2 — while runs are in flight, draft assertions

Don't idle. Draft objectively-verifiable assertions with descriptive names (they must read clearly in the viewer) and explain them to the user. Subjective qualities (writing style, design taste) are better judged qualitatively — don't force assertions onto them. Update `eval_metadata.json` and `evals/evals.json`.

### Step 3 — as runs complete, capture timing

Each subagent completion notification carries `total_tokens` and `duration_ms` — **this is the only place that data exists.** Save it immediately to `timing.json` in the run dir: `{ "total_tokens": 84852, "duration_ms": 23332, "total_duration_seconds": 23.3 }`.

### Step 4 — grade, aggregate, view

1. **Grade** each run: dispatch a grader subagent that reads `agents/grader.md` and evaluates each assertion against the outputs, writing `grading.json` per run dir. The array MUST be `expectations` with fields `text`/`passed`/`evidence` (the aggregator + viewer depend on these exact names). For programmatically checkable assertions, write and run a script rather than eyeballing.
2. **Aggregate** into the benchmark (this is the Node math, not an agent):
   ```bash
   node .claude/core/skill-eval.js aggregate <workspace>/iteration-N --skill-name <name> --date <YYYY-MM-DD>
   # (or the skill-local wrapper: node .claude/skills/skill-creator/scripts/aggregate-benchmark.js ...)
   ```
   Produces `benchmark.json` + `benchmark.md` with pass-rate, tokens, and duration per config — mean ± stddev and the **delta**. Schema: `references/schemas.md`.
3. **Analyst pass** — read the benchmark and surface what aggregates hide (non-discriminating assertions where `discriminating:false`; high-variance/flaky evals where `high_variance:true`; time/token tradeoffs). See `agents/analyzer.md`.
4. **Viewer** — generate the static review HTML for the human (headless-safe by default):
   ```bash
   node .claude/skills/skill-creator/eval-viewer/generate-review.js <workspace>/iteration-N \
     --skill-name "<name>" --benchmark <workspace>/iteration-N/benchmark.json \
     --previous <workspace>/iteration-<N-1> --static <workspace>/iteration-N/review.html
   ```
   Then give the user a clickable link to `review.html`. **Generate the viewer BEFORE evaluating outputs yourself** — get examples in front of the human first. Don't hand-write HTML; use the generator.

### Step 5 — read the feedback

The viewer's "Download feedback.json" button writes `{ "reviews": [{ "run_id": "eval-0-with_skill", "feedback": "...", "timestamp": "..." }], "status": "complete" }`. Empty feedback means it was fine. Focus improvements on the cases with specific complaints.

---

## Improving the skill

The heart of the loop. Principles (from Anthropic's skill-creator — the same that drove our `skill-authoring` revision):

1. **Generalize from the feedback.** The skill must work across millions of prompts, not just these examples. Resist fiddly, overfit changes and oppressive MUSTs; if an issue is stubborn, try a different metaphor or working pattern — it's cheap to try.
2. **Keep the prompt lean.** Remove instructions that aren't pulling their weight. Read the *transcripts*, not just final outputs — if the skill made the model waste effort, cut the part causing it.
3. **Explain the why.** Models have good theory of mind. Even terse/frustrated feedback usually has a real reason — understand the task, then transmit that understanding. All-caps `ALWAYS`/`NEVER` is a yellow flag; reframe with reasoning.
4. **Bundle repeated work.** If every test run independently wrote the same helper (`build_chart.py`, etc.), that's a strong signal: write it once into `scripts/` and have the skill call it. Saves every future invocation from reinventing it.

Take your time here — thinking is not the blocker. Draft a revision, re-read it fresh, improve.

### The iteration loop

1. Apply improvements to the skill.
2. Rerun all test cases into `iteration-<N+1>/`, including baselines. New skill → baseline stays `without_skill`. Improving → baseline is the snapshot/previous iteration (your judgment).
3. Regenerate the viewer with `--previous` pointing at iteration N.
4. Wait for review; read feedback; improve; repeat.

Stop when: the user is happy, feedback is all empty, or you're not making meaningful progress.

---

## Advanced: blind comparison

For a rigorous "is the new version actually better?" check, give two outputs to an independent agent without telling it which is which (`agents/comparator.md`), then analyze why the winner won (`agents/analyzer.md`, post-hoc role). Optional; the human review loop is usually enough.

---

## Description optimization

The description determines whether Claude invokes the skill at all. After creating/improving, offer to tune it.

1. **Generate ~20 trigger eval queries** — a mix of should-trigger (8-10) and should-not-trigger (8-10). Make them realistic and specific (file paths, job context, column names, casual phrasing, typos). For negatives, the valuable ones are *near-misses* that share keywords but need something else — not obvious irrelevancies. Save as `[{ "query": "...", "should_trigger": true }]`.
2. **Review with the user** via `assets/eval_review.html` (substitute the `__EVAL_DATA_PLACEHOLDER__` / `__SKILL_NAME_PLACEHOLDER__` / `__SKILL_DESCRIPTION_PLACEHOLDER__` placeholders, open it, let them edit and export `eval_set.json`).
3. **Measure** trigger accuracy with `node .claude/skills/skill-creator/scripts/trigger-eval.js score <results.json>` (run each query a few times for a reliable rate), propose an improved description, re-measure on a held-out split to avoid overfitting, iterate a few times.
4. **Apply** the best description (selected by held-out score, not train) to the frontmatter; show the user before/after + scores.

**How triggering works:** Claude only consults a skill for tasks it can't easily do alone — trivial one-step queries ("read file X") won't trigger regardless of description. So eval queries must be substantive, multi-step tasks where consulting a skill actually helps.

---

## Packaging

If distributing the skill as a file: `node .claude/skills/skill-creator/scripts/package-skill.js <skill-dir>` (zips to `<name>.skill`, falls back to tar). In THIS repo, skills usually ship via the template/publish pipeline, not as standalone `.skill` files — packaging is mainly for handing a skill to an external agent.

**External skills are first-class targets.** The Create/Eval/Improve loop is empirically validated on skills this toolkit does NOT own: `ciso-nist-advisor` (external, 2026-06-25) improved +14.6 then +62.5 pass-rate points across two IMPROVE rounds, each gated by the differential eval. Don't treat non-toolkit skills as an unproven case — the same evidence-first + differential-eval doctrine applies unchanged; only the ship path differs (hand the improved skill back as a packaged `.skill`/PR instead of the template pipeline).

## Reference files

- `agents/grader.md` — grade assertions against outputs → `grading.json`
- `agents/analyzer.md` — benchmark pattern analysis + post-hoc winner analysis
- `agents/comparator.md` — blind A/B comparison
- `references/schemas.md` — every JSON shape (evals, grading, timing, benchmark, comparison, analysis, feedback) + the workspace layout

## Principle of least surprise

Skills must not contain malware or exploit code, and must not surprise the user about their intent. Don't create misleading skills or ones designed to facilitate unauthorized access or exfiltration. (Roleplay-style skills are fine.)
