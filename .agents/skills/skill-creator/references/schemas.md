# Skill Evolution Schema Reference

JSON schemas for every file the skill-creator harness reads or writes. Agents and scripts depend on these shapes — field names are a contract, not a suggestion.

## Table of Contents

1. [evals.json](#1-evalsjson) — eval definitions for a skill
2. [eval_metadata.json](#2-eval_metadatajson) — per-eval summary written alongside run dirs
3. [grading.json](#3-gradingjson) — grader output per run
4. [timing.json](#4-timingjson) — token and duration capture per run
5. [benchmark.json](#5-benchmarkjson) — aggregated results across all evals and configs
6. [comparison.json](#6-comparisonjson) — blind comparator decision
7. [analysis.json](#7-analysisjson) — post-hoc or benchmark analyzer output
8. [feedback.json](#8-feedbackjson) — human reviewer notes from the eval viewer
9. [Workspace Layout](#9-workspace-layout)
10. [binding.json](#10-bindingjson) — what an iteration graded, recorded for the apply helper

---

## 1. `evals.json`

Lives in the **target skill directory** (e.g. `.claude/skills/my-skill/evals/evals.json`), not in the workspace. Contains the eval definitions that `skill-eval.js run` reads.

An entry takes one of two forms:

- **Legacy, LLM-graded:** `id`, `prompt`, `expected_output`, `files`, `assertions`. A grader agent scores the assertions. `tools/skill-regress.js` skips these (`reason: no-check`); nothing runs them unattended.
- **Persistent suite entry, objectively checked:** an entry that carries a `check` key. `tools/skill-regress.js` re-runs it on every candidate and judges the result through `skill-eval.js`. Prefer this form: an exit code is evidence, an LLM grade is opinion.

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": 1,
      "name": "missing-brief",
      "prompt": "Create a project brief for a SaaS analytics dashboard.",
      "check": "test -s docs/product/brief.md && ! grep -q 'TODO' docs/product/brief.md",
      "split": "dev",
      "fixtures": ["fixtures/missing-brief"],
      "reference": "reference/missing-brief",
      "timeoutSec": 60
    },
    {
      "id": 2,
      "prompt": "Create a project brief for a SaaS analytics dashboard.",
      "expected_output": "A product/brief.md file in docs/ with sections for vision, users, and constraints.",
      "files": [],
      "assertions": [
        "A product/brief.md file exists in docs/",
        "The brief contains a section about target users",
        "The brief does not contain placeholder text"
      ]
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `skill_name` | Must match the parent skill directory name |
| `evals[].id` | Integer, unique within the file, used as the directory name prefix |
| `evals[].prompt` | The exact prompt sent to the agent under test |
| `evals[].expected_output` | Human-readable description of the desired outcome (not machine-parsed) |
| `evals[].files` | Array of file paths to seed into the run environment before the agent starts |
| `evals[].assertions` | Plain-English assertions passed to the grader; each is graded pass/fail |
| `evals[].name` | Suite entries only. A safe path segment (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`) used in the eval directory name `eval-<id-1>-<name>` |
| `evals[].check` | Suite entries only. A non-empty objective command run with `bash -c` in the agent's workdir after the agent finishes, with a scrubbed environment (see the confinement paragraph below); exit 0 is a pass. An entry without this key is a legacy entry |
| `evals[].split` | Suite entries only, required: `dev` or `holdout`. It must match where the file lives: `dev` in the skill's own `evals/` directory, `holdout` in `tools/skill-holdout/<skill>/evals.json` |
| `evals[].fixtures` | Suite entries only. Array of paths relative to the directory holding the `evals.json`. A directory's contents are copied to the workdir root; a file is copied under its basename. Absolute paths, `..` escapes, missing paths and symlinks are refused |
| `evals[].reference` | Suite entries only, required. One relative directory of known-good files. `skill-regress.js dry-run` overlays it on the fixtures to prove the `check` can pass; it is never copied into an agent workdir |
| `evals[].timeoutSec` | Suite entries only, optional. Positive number: the `check` timeout in seconds (default 300) |

**The held-out split.** Entries with `split: holdout` live under `tools/skill-holdout/<skill>/evals.json` (with their fixtures and references beside it), a protected, workshop-only tree the proposer never reads. `skill-regress.js` reports a holdout eval to the proposer as pass or fail only, never its prompt, name, check, output or fixtures, and writes neutral labels (`holdout-<id>`) into the workspace. A `holdout` split inside a skill's own `evals/` directory is a validation error: it would show the proposer the held-out set. The tool never prints the held-out tree's path (a held-out file is labelled `holdout:<skill>` and any path inside the tree is replaced with `<holdout-tree>` in stdout and stderr), and a `--candidate` or `--baseline` skill version that carries a holdout-named entry is refused. Keeping the tree unreadable to the proposer is the job of the Read deny rule and the guardrail tier; keeping it unreadable to the evaluated agents is this tool's job (see the confinement paragraph below: the agent reads only its own workdir).

**A `check` that runs agent code.** When the thing being checked is code or a script the agent wrote, the check never runs it in its own process or with the caller's environment. It copies the workdir into a fresh directory directly under the real OS temp dir (refusing a symlink), runs each call as a child process with an environment of only `PATH`, `HOME` (inside the sandbox), `TMPDIR` and `LANG`, a timeout, the sandbox as working directory and, where the platform offers it cheaply, no network and a read-only host file system (bubblewrap or `unshare --net` on Linux; Node's permission model for a Node child). A script that deletes files runs behind guard shims that refuse any path outside the sandbox. It passes only on positive evidence the check reads itself (the file-system state the work must have produced, plus a per-call marker where the code can print one), so an early `exit(0)`, a swallowed error or a no-op cannot pass; every such check is shipped with saboteur variants that must fail. A check that only reads a review (a code-review `review.md`) runs nothing and judges the findings table by structure (the row a defect is in, the cell a fix is in, the final verdict), accepting any valid wording. A suite file may carry a top-level `notes` array, ignored by the tool, for limits a reader must know (for example that a suite is manual regression only because its skill is a reserved improvement target).

**Tool.** `node tools/skill-regress.js list|validate|dry-run|run`. `dry-run` costs zero tokens and proves each `check` fails on the bare fixtures and passes with the `reference` applied. `run` drives both skill versions headlessly (`claude -p`), writes the layout in section 9, then calls the `skill-eval.js` aggregate and verdict. `--max-runs` bounds the plan before any agent starts. `--max-tokens` (default 2,000,000) and `--max-cost-usd` (default 20) are checked before each run and stop the suite (exit 12, no verdict). Tokens are input plus cache-creation plus cache-read plus output, and every run that reported usage counts, executed or not. Each agent is bounded on its own by `--agent-max-turns` (default 30, `claude --max-turns`), `--agent-max-usd` (default 2, `claude --max-budget-usd`) and `--agent-timeout-sec` (default 600).

The agent sees a fresh workdir with the fixtures and the skill version under test **without the skill's `evals/` folder** (the check commands and references are the answer key) and without any holdout entry. It runs with a scrubbed environment (a short keep list: `PATH`, `HOME`, locale, proxy and certificate variables and the Claude login variables; every other credential variable is dropped) and `--setting-sources project`, so the caller's user settings do not apply. Permission mode is `acceptEdits` with `--permission-prompts none`: an eval that needs a shell command the agent is not allowed to run fails honestly instead of borrowing the caller's allow rules.

**Confinement of the eval agent.** The candidate skill is model-written text that an agent loads with the login in its environment, so `harness-eval.js runAgent` (used by `skill-regress.js`, `/review:evolve-skills` and the weekly cycle) launches every eval agent confined, with the same design as the unattended wrappers (see the "Fix on a branch" recipe in `docs/reference/agents/guides/scheduled-runs.md`). The walls are flags and one `--settings` JSON, never files in the workdir, and a flag setting outranks the workdir's project settings:

| Wall | How |
|---|---|
| A sandbox that fails closed | `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: false`: a host without a sandbox gives a run that never executes (exit 1, UNCHECKED), never an unconfined one. Needs a sandbox-capable host (Linux, WSL2 or macOS) |
| No network, no web tool | `network.allowedDomains: []` for every command the agent runs; `WebFetch` and `WebSearch` denied by rule and by `--disallowedTools` (both run in the CLI process, outside the sandbox) |
| Reads only inside its own workdir | `permissions.blockReadsOutsideWorkingDirectories` for the file tools; the sandbox `denyRead` for the home directory, the workshop repository, the suite root (`--root`: every skill's `evals/` folder and `tools/skill-holdout/`, in the repository and in its rendered `.claude/` and `.codex/` copies), `/proc` and the credential directories (`~/.config/claude`, `~/.claude`, `~/.ssh`, `~/.config/gh`), with `allowRead` for the workdir and the node installation only; the same paths as `Read` and `Edit` deny rules, plus `**/skill-holdout/**`. A root that contains the workdir is never denied |
| Writes only inside its own workdir | `sandbox.filesystem.allowWrite` is the workdir |
| No hook, no inline skill shell, no auto-memory, no MCP | `disableAllHooks` (an arm of `harness-eval.js` whose subject is its hooks opts back in; `skill-regress.js` never does), `disableSkillShellExecution` (a settings key of Claude Code 2.1.328, "Disable inline shell execution in skills and custom slash commands"), `autoMemoryEnabled: false`, `--strict-mcp-config` |
| No planted instructions | `claudeMdExcludes` lists the `CLAUDE.md` files of every parent directory of the workdir |
| No credential for a command | the agent environment always carries `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (no command the agent runs inherits the login) and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, on top of the keep list |

The `check` of an eval runs after the agent finished, with an environment of only `PATH`, `HOME` (the check's own folder), `LANG` and `TMPDIR` under `bash -c`, never the caller's environment (no login variable, no cloud key, no `BASH_ENV`). Every workdir and check sandbox of one run lives in a private per-run directory (mode 0700, under `$XDG_RUNTIME_DIR` when it is set, else under the OS temp directory) that is removed when the run ends, however it ends, so no folder sits directly in a shared temp directory where a planted parent `CLAUDE.md` could reach the agent.

What a run writes to the workspace never carries held-out content: a held-out run keeps only its status, and a dev run's `runReason` (an excerpt of the agent's own output, committed with a staged branch) is redacted first against every held-out prompt, check, name and the text of every held-out fixture and reference file, including any 12-character fragment of them.

**Denominator rule.** A run that never executed (not-run, quota or auth refusal, malformed output, inference failure) is recorded in `run-status.json` and stays out of every pass-rate denominator. A run whose agent **timed out** is different: it started and used its whole time budget, so it is graded as a failed run (`passed: false`, no check run) in either arm and stays in the denominator. Otherwise a candidate that hangs on the hard evals would be graded on the easy ones. The result reports `executed` (real executions), `timedOut` and `notExecuted` separately, and a suite where nothing but timeouts happened is unchecked (exit 1).

---

## 2. `eval_metadata.json`

Written by `skill-eval.js run` once per eval, in the eval directory. Summarizes the eval and carries the grader's per-assertion results for the viewer.

```json
{
  "eval_id": 0,
  "eval_name": "project-brief-creation",
  "prompt": "Create a project brief for a SaaS analytics dashboard.",
  "assertions": [
    {
      "text": "A product/brief.md file exists in docs/",
      "passed": true,
      "evidence": "docs/product/brief.md written at end of run"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `eval_id` | Zero-based index (id from evals.json minus 1, or sequential) |
| `eval_name` | Kebab-case slug derived from the prompt |
| `prompt` | Copied from evals.json for convenience |
| `assertions` | Flattened list of all assertion results across configs for this eval |

---

## 3. `grading.json`

Written by the **grader agent** into each run directory (e.g. `eval-0-project-brief/with_skill/grading.json`). The aggregator reads this to compute pass rates. Field names are a hard contract.

```json
{
  "run_id": "eval-0-with_skill",
  "config": "with_skill",
  "eval_id": 0,
  "expectations": [
    {
      "text": "A product/brief.md file exists in docs/",
      "passed": true,
      "evidence": "docs/product/brief.md written at end of run"
    },
    {
      "text": "The brief contains a section about target users",
      "passed": false,
      "evidence": "no evidence found"
    }
  ],
  "eval_critique": {
    "non_discriminating": [],
    "coverage_gaps": ["No assertion checks that the brief is longer than a stub"],
    "trivial": []
  }
}
```

| Field | Description |
|-------|-------------|
| `run_id` | `eval-{id}-{config}` — matches the run directory name |
| `config` | `with_skill`, `without_skill`, or `old_skill` |
| `eval_id` | Integer matching the eval |
| `expectations` | **Must be named `expectations`** (not `assertions` or `results`) |
| `expectations[].text` | Assertion string verbatim |
| `expectations[].passed` | Boolean — no partial credit |
| `expectations[].evidence` | ≤125 character quote from transcript or output; "no evidence found" when absent |
| `eval_critique` | Optional; omit if no issues. Sub-keys: `non_discriminating`, `coverage_gaps`, `trivial` |

---

## 4. `timing.json`

Captured from the subagent completion notification by `skill-eval.js run`. Sits alongside `grading.json` in each run directory.

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

| Field | Description |
|-------|-------------|
| `total_tokens` | Input + output tokens for the entire run |
| `duration_ms` | Wall-clock milliseconds from subagent dispatch to completion |
| `total_duration_seconds` | `duration_ms / 1000`, rounded to one decimal, for human readability |

---

## 5. `benchmark.json`

Produced by `node .claude/core/skill-eval.js aggregate` after all runs complete. One file per iteration, written to the iteration directory.

**Baseline config convention:** `without_skill` when evaluating a *new* skill (comparing presence vs absence). `old_skill` when *improving* an existing skill (comparing old version vs new version). The `delta` fields subtract baseline from with-skill.

```json
{
  "skill_name": "my-skill",
  "iteration": "iteration-1",
  "generated": "2026-06-06",
  "configs": ["with_skill", "without_skill"],
  "evals": [
    {
      "eval_id": 0,
      "eval_name": "project-brief-creation",
      "prompt": "Create a project brief for a SaaS analytics dashboard.",
      "baseline_config": "without_skill",
      "results": {
        "with_skill": {
          "runs": 3,
          "pass_rate": { "mean": 0.66, "std": 0.05, "min": 0.60, "max": 0.72, "n": 3 },
          "tokens": { "mean": 84852, "std": 1200, "min": 83000, "max": 86000, "n": 3 },
          "duration_ms": { "mean": 23332, "std": 500, "min": 22800, "max": 23900, "n": 3 },
          "assertions": {
            "A product/brief.md file exists in docs/": { "rate": 1.0, "std": 0, "n": 3 }
          }
        },
        "without_skill": {
          "runs": 3,
          "pass_rate": { "mean": 0.33, "std": 0.10, "min": 0.20, "max": 0.45, "n": 3 },
          "tokens": { "mean": 90000, "std": 800, "min": 89000, "max": 91000, "n": 3 },
          "duration_ms": { "mean": 24100, "std": 300, "min": 23800, "max": 24400, "n": 3 },
          "assertions": {
            "A product/brief.md file exists in docs/": { "rate": 1.0, "std": 0, "n": 3 }
          }
        }
      },
      "delta": {
        "pass_rate": 0.33,
        "tokens_pct": -6.7,
        "duration_pct": -3.2
      },
      "assertions": [
        {
          "text": "A product/brief.md file exists in docs/",
          "with_skill": 1.0,
          "baseline": 1.0,
          "discriminating": false,
          "high_variance": false
        }
      ]
    }
  ],
  "summary": {
    "with_skill": {
      "pass_rate": { "mean": 0.66 },
      "tokens": { "mean": 84852 },
      "duration_ms": { "mean": 23332 }
    },
    "without_skill": {
      "pass_rate": { "mean": 0.33 },
      "tokens": { "mean": 90000 },
      "duration_ms": { "mean": 24100 }
    },
    "delta": {
      "pass_rate": 0.33,
      "tokens_pct": -6.7,
      "duration_pct": -3.2
    },
    "n_evals": 1
  }
}
```

| Field | Description |
|-------|-------------|
| `baseline_config` | The config used as the denominator for delta — `without_skill` or `old_skill` |
| `results.{config}.pass_rate` | Descriptive stats across `n` runs |
| `delta.pass_rate` | `with_skill.mean - baseline.mean`; positive = improvement |
| `delta.tokens_pct` | `(with_skill - baseline) / baseline * 100`; negative = cheaper |
| `assertions[].discriminating` | `false` when `with_skill` and `baseline` pass rates are equal across all runs |
| `assertions[].high_variance` | `true` when pass rate std exceeds 0.15 across runs |

---

## 6. `comparison.json`

Written by the **comparator agent** to the eval directory after a blind A/B comparison.

```json
{
  "winner": "A",
  "rubric": {
    "A": {
      "correctness": 4,
      "completeness": 4,
      "accuracy": 4,
      "organization": 5,
      "formatting": 5,
      "usability": 4,
      "total": 26
    },
    "B": {
      "correctness": 3,
      "completeness": 3,
      "accuracy": 3,
      "organization": 3,
      "formatting": 4,
      "usability": 3,
      "total": 19
    }
  },
  "quality_summary": {
    "A": {
      "strengths": ["Includes a concrete user persona with quoted pain points"],
      "weaknesses": ["Constraints section is thin — only one item listed"]
    },
    "B": {
      "strengths": ["Good use of headings throughout"],
      "weaknesses": ["Vision statement is generic; could apply to any SaaS product"]
    }
  },
  "decision_rationale": "A scored higher on completeness and organization. The user persona in A provides concrete grounding that B lacks entirely. The single-item constraints section in A is a weakness but doesn't offset the structural advantage.",
  "assertion_results": {
    "A": { "A product/brief.md file exists in docs/": true },
    "B": { "A product/brief.md file exists in docs/": true }
  }
}
```

| Field | Description |
|-------|-------------|
| `winner` | `"A"` or `"B"` — never null; ties should be broken |
| `rubric.{output}.total` | Sum of all six dimension scores (max 30) |
| `quality_summary.{output}.strengths` | Quote-backed; not impressions |
| `decision_rationale` | Specific enough to verify by re-reading the outputs |
| `assertion_results` | Optional; only present when assertions were provided |

---

## 7. `analysis.json`

Two shapes depending on which analyzer role ran.

**Benchmark Analyzer** (array — multiple observations):

```json
[
  {
    "type": "non_discriminating",
    "evals": [0],
    "assertions": ["A product/brief.md file exists in docs/"],
    "observation": "This assertion passes at 100% in both configs across all 3 runs — it detects file creation, not quality."
  },
  {
    "type": "cost_tradeoff",
    "evals": [1, 2],
    "assertions": [],
    "observation": "with_skill uses 12% more tokens than baseline on evals 1 and 2, but pass_rate delta is only 0.05 — marginal gain for meaningful cost increase."
  }
]
```

**Post-hoc Analyzer** (object — structured improvement plan):

```json
{
  "instruction_following": {
    "winner": { "score": 8, "notes": "Followed the skill's output format precisely; all required sections present." },
    "loser": { "score": 5, "notes": "Skipped the constraints section despite explicit skill instruction to include it." }
  },
  "winner_strengths": [
    "Concrete user persona: 'a growth marketer who needs to present ROI to the CFO'"
  ],
  "loser_weaknesses": [
    "Vision statement is a single sentence with no specificity — skill instructions require at least two differentiating dimensions"
  ],
  "suggestions": [
    {
      "type": "instructions",
      "priority": "high",
      "suggestion": "Add an example constraints section to the skill showing at least three constraint categories (technical, budget, timeline)"
    },
    {
      "type": "examples",
      "priority": "medium",
      "suggestion": "Include a before/after example of a weak vs strong vision statement"
    }
  ]
}
```

| Field (post-hoc) | Description |
|------------------|-------------|
| `instruction_following.{role}.score` | 1–10; lower = larger gap between skill instructions and run behavior |
| `suggestions[].type` | One of: `instructions`, `tools`, `examples`, `error_handling`, `structure`, `references` |
| `suggestions[].priority` | `high`, `medium`, or `low` |

---

## 8. `feedback.json`

Written by the eval viewer when a human reviewer leaves notes on a run.

```json
{
  "reviews": [
    {
      "run_id": "eval-0-with_skill",
      "feedback": "The grader marked assertion 2 as failed but the output clearly contains the users section — check grader evidence.",
      "timestamp": "2026-06-06T14:23:00Z"
    }
  ],
  "status": "complete"
}
```

| Field | Description |
|-------|-------------|
| `reviews[].run_id` | Matches the `run_id` in `grading.json` for correlation |
| `reviews[].feedback` | Free text; no length limit |
| `status` | `"complete"` when the reviewer has finished; `"in_progress"` otherwise |

---

## 9. Workspace Layout

The harness writes to a date-scoped workspace under `docs/.output/evolution/skills/`. The eval definitions themselves live in the target skill directory.

```
docs/.output/evolution/skills/{YYYY-MM-DD}/{skill}-workspace/
  skill-snapshot/               # Present only when IMPROVING an existing skill
  │                             # Contains a verbatim copy of the old skill docs
  candidate/                    # skill-regress.js: a copy of the candidate skill (the prose-growth rule reads it)
  iteration-N/
    eval-<id>-<name>/           # One directory per eval
      eval_metadata.json
      with_skill/
        outputs/                # Agent-produced files from the run
        grading.json            # Written by grader agent
        timing.json             # Captured by skill-eval.js
      without_skill/            # OR old_skill/ when improving
        outputs/
        grading.json
        timing.json
    benchmark.json              # Produced by skill-eval.js aggregate
    benchmark.md                # Human-readable summary
    review.html                 # Eval viewer (opens in browser)
    binding.json                # Written by `skill-evolution.js bind` after aggregate (section 10)
  holdout/
    iteration-N/                # skill-regress.js: held-out evals, redacted (see below)
      eval-<id>-holdout/

.claude/skills/{skill}/
  evals/
    evals.json                  # Eval definitions — lives here, NOT in the workspace
```

The `with_skill` vs `without_skill` naming applies to new skill evaluation. When improving an existing skill, the configs are named `new_skill` and `old_skill`, and `skill-snapshot/` contains the old version for the post-hoc analyzer.

### `skill-regress.js` runs

`tools/skill-regress.js run` writes one `run-<k>/` directory (k from 1) per replicate under each arm:

```
iteration-N/eval-<id-1>-<name>/
  eval_metadata.json            # { eval_id, eval_name, prompt }
  with_skill/                   # the candidate; old_skill/ is the baseline
    run-1/
      run-status.json           # EVERY run: { runStatus, runReason, tokensIn, tokensOut, costUsd, durationMs }
      grading.json              # ONLY an executed run: one expectation, the objective check
      timing.json               # ONLY an executed run: { total_tokens, duration_ms }
```

A run whose `runStatus` is not `executed` and not `timeout` (quota or auth refusal, malformed output, no CLI) has a `run-status.json` and no `grading.json`, so `skill-eval.js aggregate` leaves it out of the denominator. A `timeout` run has both: its `grading.json` records one failed expectation (`passed: false`, evidence names the timeout), so it counts against the arm that timed out.

The `holdout/iteration-N/` tree is redacted: eval directories are `eval-<id-1>-holdout`, `eval_metadata.json` is `{ eval_id, eval_name: "holdout-<id>" }` (no prompt), the single expectation has `text: "holdout-<id>"` and `evidence: ""`, and there is no `outputs/` directory. A holdout run's `runReason` is the bare status, and a dev run's `runReason` is redacted against the held-out entries before it is written.

---

## 10. `binding.json`

Written once per iteration by `skill-evolution.js bind` (the same function `tools/skill-regress.js run` calls after it aggregates), as `iteration-N/binding.json`. It records what that iteration graded, so the apply helper can refuse a candidate, a snapshot or a piece of grading evidence that changed after the evaluation.

```json
{
  "version": 2,
  "iteration": "iteration-1",
  "candidateSha256": "9c1f…",
  "snapshotSha256": "47ab…",
  "gradings": {
    "holdout/iteration-1/benchmark.json": "5d02…",
    "holdout/iteration-1/eval-0-holdout/with_skill/run-1/grading.json": "e175…",
    "iteration-1/benchmark.json": "4e31…",
    "iteration-1/eval-0-e0/old_skill/run-1/grading.json": "9850…",
    "iteration-1/eval-0-e0/with_skill/run-1/grading.json": "e175…"
  }
}
```

| Field | Description |
|-------|-------------|
| `version` | `2`. The earlier shape (`1`, no `gradings`) is refused by `apply` and `propose` exactly like a missing binding, and `bind` never upgrades one: re-evaluate into a new iteration |
| `iteration` | The iteration directory name this binding belongs to; a binding copied from another iteration is refused |
| `candidateSha256` | One hash over `candidate/`: every relative path with the sha256 of its content, in code-unit order (the same value `propose` prints) |
| `snapshotSha256` | The same hash over `skill-snapshot/` |
| `gradings` | sha256 of the raw bytes of every file named `grading.json` or `benchmark.json` under the iteration directory and under its holdout (`holdout/iteration-N/`), keyed by the path relative to the workspace with forward slashes and sorted by code unit. It always holds `iteration-N/benchmark.json` |

`apply` and `propose` recompute every field from the workspace and refuse on a mismatch: an edited, a missing or an extra `grading.json` or `benchmark.json` (a holdout that appeared after the binding is an extra file) is refused with step `candidate-hash`, before any verdict runs, and the verdict's own check that the gradings were not edited after `aggregate` runs after it. A grading or benchmark file that is a symbolic link or a special file is refused (the reader would follow it). `bind` itself is write-once.

What it does not cover: a grading file written *before* `bind` runs. Whoever can write the gradings and then run `bind` gets a binding, so the strongest source is the run that grades and binds in one process (`tools/skill-regress.js run`, objective `check` commands, no grading model). Other files in the iteration (`timing.json`, `eval_metadata.json`, `run-status.json`, `outputs/`) are not hashed: the verdict is computed from the gradings and the benchmark.
