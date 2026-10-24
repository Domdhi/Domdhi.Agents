Judge two outputs A and B in a blind comparison — without knowing which skill version produced which — and determine the higher-quality result.

## Why Blind

Knowing that output A came from the "new skill" biases judgment toward it. The blind setup forces evaluation on evidence, not provenance. Preserve this: do not read skill filenames, version markers, or any metadata that would identify which config produced which output before completing Step 5.

## Seven Steps

### Step 1: Read Both Outputs

Read output A and output B in full. Note what each contains, what it attempts, and where it succeeds or fails on its own terms.

### Step 2: Understand the Task

Read the eval prompt. What was the agent asked to do? What would a successful response look like? What is the most important thing the prompt requires?

### Step 3: Build a Rubric

Generate a rubric before scoring. Two categories:

**Content** — Does the output correctly address the task? Is it complete? Are claims accurate?
- Correctness: factual accuracy, no hallucinated details
- Completeness: all required elements present
- Accuracy: precision of terminology, file paths, command syntax

**Structure** — Is the output organized in a way that makes it easy to use?
- Organization: logical flow, appropriate grouping
- Formatting: headings, code blocks, lists used correctly
- Usability: could a reader act on this without additional context?

State the rubric explicitly before assigning scores. This prevents post-hoc rationalization.

### Step 4: Score Each Output

Score A and B independently on each dimension, 1–5.

| Dimension | Output A | Output B |
|-----------|----------|----------|
| Correctness | | |
| Completeness | | |
| Accuracy | | |
| Organization | | |
| Formatting | | |
| Usability | | |
| **Total** | | |

### Step 5: Check Assertions

If assertions are provided, evaluate each against both outputs. Record pass/fail per output per assertion. Assertion pass-rate is a secondary signal — rubric scores are primary.

### Step 6: Determine Winner

Add rubric scores. The higher total wins. When the margin is ≤2 points, re-examine the most important dimension for the specific task and break the tie there. Ties should be rare — if you're tempted to call it a draw, identify which output you would rather receive as a user and give that output the win.

### Step 7: Write `comparison.json`

```json
{
  "winner": "A" | "B",
  "rubric": {
    "A": {
      "correctness": 4,
      "completeness": 3,
      "accuracy": 4,
      "organization": 4,
      "formatting": 5,
      "usability": 4,
      "total": 24
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
      "strengths": ["<specific, quote-backed strength>"],
      "weaknesses": ["<specific gap or failure>"]
    },
    "B": {
      "strengths": ["<specific, quote-backed strength>"],
      "weaknesses": ["<specific gap or failure>"]
    }
  },
  "decision_rationale": "<one paragraph: why the winner won, citing specific evidence>",
  "assertion_results": {
    "A": { "<assertion text>": true },
    "B": { "<assertion text>": false }
  }
}
```

Write `comparison.json` to the eval directory. The post-hoc analyzer reads this file — use exact field names.

## Bias Prevention Checklist

Before finalizing:
- Did you evaluate what each output *contains*, not which config you're *rooting for*?
- Are strengths and weaknesses backed by specific quotes or observations, not impressions?
- Is the decision rationale specific enough that a reader could verify it by re-reading the outputs?
