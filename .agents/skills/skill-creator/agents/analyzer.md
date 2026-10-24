Surface patterns in benchmark data or perform post-hoc quality analysis of a blind comparison. Two distinct roles — read your invocation context to know which applies.

---

## Role 1: Benchmark Analyzer

Used by `/review:evolve-skills` after `node .claude/core/skill-eval.js aggregate` produces `benchmark.json`.

### Task

Read the full `benchmark.json` and report patterns that aggregate statistics hide. Do not suggest improvements — that is a separate step. Report only what the data shows.

### What to Surface

**Non-discriminating assertions** (`"discriminating": false` in the benchmark). Name the specific assertion text and the evals it appears in. These assertions pass at the same rate regardless of config — they measure nothing about the skill's effect.

**High-variance / flaky evals** (`"high_variance": true`). Identify which evals are unstable and quantify the variance in pass rate across runs. Flaky evals produce unreliable delta signals.

**Time and token tradeoffs**. When the with-skill config costs significantly more tokens or time than baseline, flag it — especially when the pass-rate delta doesn't justify the cost. Use the `delta.tokens_pct` and `delta.duration_pct` fields.

**Unexpected patterns**. Evals where baseline outperforms with-skill (negative delta), evals with 0% pass rate across all configs (broken eval?), assertions that are always 100% (ceiling effect).

### Output

Write `analysis.json` to the iteration directory alongside `benchmark.json`.

```json
[
  {
    "type": "non_discriminating" | "high_variance" | "cost_tradeoff" | "anomaly",
    "evals": [0, 2],
    "assertions": ["<assertion text if applicable>"],
    "observation": "<specific, data-grounded description — include numbers>"
  }
]
```

Observations must cite specific eval IDs, assertion text, or numeric values from the benchmark. No speculation, no quality judgments.

---

## Role 2: Post-hoc Analyzer

Used after the blind comparator has made its decision, to produce improvement recommendations for the losing skill version.

### Inputs

- The comparator's `comparison.json` (contains winner, rubric scores, quality summary)
- Both skills' source documents (current and challenger, or with-skill and without-skill)
- Transcripts from both runs

### Task

Read the comparator's decision and both skill versions side-by-side. Produce a structured analysis with actionable improvement suggestions for the skill content.

**Instruction-following score (1–10):** Assess how closely each run followed its skill's instructions. Quote specific deviations. Lower score = larger gap between instructions and execution.

**Strengths and weaknesses:** Cite direct quotes from transcripts. Be specific about what the winner did that the loser did not, and vice versa.

**Improvement suggestions:** Focus on skill *content* (wording, structure, examples, error handling guidance, references) — not agent behavior. Agents are not the variable; the skill text is.

```json
{
  "instruction_following": {
    "winner": { "score": 8, "notes": "..." },
    "loser": { "score": 5, "notes": "..." }
  },
  "winner_strengths": ["<quote-backed observation>"],
  "loser_weaknesses": ["<quote-backed observation>"],
  "suggestions": [
    {
      "type": "instructions" | "tools" | "examples" | "error_handling" | "structure" | "references",
      "priority": "high" | "medium" | "low",
      "suggestion": "<specific, actionable change to skill content>"
    }
  ]
}
```

Write `analysis.json` to the run directory or wherever the comparator's output lives, depending on context.
