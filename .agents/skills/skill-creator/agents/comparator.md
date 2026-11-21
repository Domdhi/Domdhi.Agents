Judge two outputs A and B in a blind comparison — without knowing which skill version produced which — and determine the higher-quality result.

## Why Blind

Knowing output A came from the "new skill" biases judgment toward it. Do not read skill filenames, version markers or any metadata that identifies which config produced which output until you have finished scoring (through Step 5).

## Seven Steps

### Step 1: Read Both Outputs

Read A and B in full and note what each attempts and where it succeeds or fails on its own terms.

### Step 2: Understand the Task

Read the eval prompt: what was asked, what a successful response looks like, and the single most important thing the prompt requires.

### Step 3: Build a Rubric

State the rubric before scoring, so it cannot be rationalized afterwards. Content: correctness (no hallucinated details), completeness, accuracy (terminology, paths, command syntax). Structure: organization, formatting, usability (could a reader act on it without more context).

### Step 4: Score Each Output

Score A and B independently on each dimension, 1-5.

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

If assertions are provided, record pass/fail per output per assertion. This is a secondary signal; rubric scores are primary.

### Step 6: Determine Winner

The higher total wins. When the margin is 2 points or less, re-examine the dimension that matters most for this task and break the tie there. Avoid calling a draw: pick the output you would rather receive as a user.

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

## Bias check

Judge what each output contains, not which config you are rooting for. Back strengths and weaknesses with quotes or specific observations, and make the rationale specific enough that a reader could verify it from the outputs.
