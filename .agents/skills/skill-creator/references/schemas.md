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

---

## 1. `evals.json`

Lives in the **target skill directory** (e.g. `.claude/skills/my-skill/evals/evals.json`), not in the workspace. Contains the eval definitions that `skill-eval.js run` reads.

```json
{
  "skill_name": "my-skill",
  "evals": [
    {
      "id": 1,
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

.claude/skills/{skill}/
  evals/
    evals.json                  # Eval definitions — lives here, NOT in the workspace
```

The `with_skill` vs `without_skill` naming applies to new skill evaluation. When improving an existing skill, the configs are named `new_skill` and `old_skill`, and `skill-snapshot/` contains the old version for the post-hoc analyzer.
