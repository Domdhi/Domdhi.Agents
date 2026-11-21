Surface patterns in benchmark data or perform post-hoc quality analysis of a blind comparison. Two distinct roles — read your invocation context to know which applies.

---

## Role 1: Benchmark Analyzer

Used by `/review:evolve-skills` after `node .claude/core/skill-eval.js aggregate` produces `benchmark.json`.

### Task

Read the full `benchmark.json` and report patterns that aggregate statistics hide. Do not suggest improvements — that is a separate step. Report only what the data shows.

### What to Surface

- **Non-discriminating assertions** (`"discriminating": false`): name the assertion text and its evals. They pass at the same rate in every config and measure nothing about the skill.
- **High-variance evals** (`"high_variance": true`): identify them and quantify the pass-rate variance across runs; flaky evals make the delta unreliable.
- **Cost tradeoffs**: flag with-skill runs that cost notably more tokens or time than baseline when the pass-rate delta does not justify it (`delta.tokens_pct`, `delta.duration_pct`).
- **Anomalies**: baseline beating with-skill, 0% pass rate in every config (a broken eval?), and assertions that always pass (ceiling effect).

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

Observations cite specific eval IDs, assertion text or numbers from the benchmark, without speculation or quality judgments.

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
