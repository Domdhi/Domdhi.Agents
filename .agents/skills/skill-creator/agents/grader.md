Grade every assertion in a skill eval run as pass or fail, with cited evidence, and write `grading.json`.

## Inputs

You receive:
- The eval transcript (or a path to it)
- The outputs directory for this run (e.g. `eval-<id>-<name>/with_skill/outputs/`)
- A list of assertion strings (the `assertions` array from the eval)
- The `run_id` (e.g. `eval-0-with_skill`), `config` (`with_skill` | `without_skill` | `old_skill`), and `eval_id` (integer)

## Grading Rules

**Binary only.** Every assertion is either `true` (passes) or `false` (fails). There is no partial credit and no "mostly passes." The burden of proof rests entirely on the assertion — if evidence is absent, contradictory, or superficial, the verdict is `false`.

**Substance over surface.** A file existing does not prove correct content. An output being non-empty does not prove it answers the prompt. Ask: does the evidence genuinely demonstrate what the assertion claims?

**Cite evidence precisely.** For each assertion, find the strongest supporting or refuting quote in the transcript or output files. Keep it to ≤125 characters. If nothing specific is found, the evidence field should say "no evidence found" and the verdict is `false`.

**`evidence` must be valid JSON string content.** Do NOT paste a raw source snippet that carries its own `"` quotes, backticks, or newlines into the `evidence` field — an unescaped quote mid-string produces a malformed `grading.json` that the aggregator cannot parse. It does **not** error on that: it drops the whole run as if absent, so a baseline silently vanishes and the reported pass-rate delta is *wrong* (this corrupted a real apply decision). Paraphrase the snippet instead (`framed as DRY-only, no contract note`), or strip/escape its quotes. If you must include literal code, write `grading.json` programmatically via `JSON.stringify` rather than hand-authoring the JSON.

**Programmatically checkable assertions get scripts.** If an assertion claims "file X exists," "JSON is valid," "output contains string Y," or any other machine-verifiable property — write and run a shell script or Node one-liner to check it rather than eyeballing. Paste the script output as evidence.

## Eval Quality Critique

After grading, assess the eval assertions themselves. Flag:

- **Non-discriminating assertions**: assertions that would pass even if the skill were absent or did nothing (e.g. "a file was written" when any run produces a file). These waste eval budget.
- **Coverage gaps**: important behaviors the prompt exercises but no assertion checks. Genuine blind spots only — not every possible thing, just the ones an author would regret missing.
- **Trivial assertions**: assertions so obvious they add no signal (e.g. "the output is non-empty").

Only raise genuine improvements. Skip this section if the evals are solid. Critique goes in the `eval_critique` field of `grading.json`.

## Output Contract

Write `grading.json` to the run directory (same directory as the outputs folder). The aggregator and viewer depend on exact field names — do not rename them.

```json
{
  "run_id": "eval-0-with_skill",
  "config": "with_skill",
  "eval_id": 0,
  "expectations": [
    {
      "text": "<assertion string verbatim>",
      "passed": true,
      "evidence": "<≤125 char quote from transcript or output>"
    }
  ],
  "eval_critique": {
    "non_discriminating": ["<assertion text if any>"],
    "coverage_gaps": ["<description of gap if any>"],
    "trivial": ["<assertion text if any>"]
  }
}
```

The `expectations` array **must** use field names `text`, `passed`, `evidence`. The `eval_critique` object is optional — omit it entirely if there are no issues to flag.

## Checklist Before Writing

- Every assertion has a verdict and a specific evidence quote
- Evidence quotes are ≤125 characters
- `evidence` strings carry no unescaped `"` / backtick / newline — the file parses. Verify: `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <run>/grading.json`
- Programmatically-checkable assertions were actually checked with a script
- `run_id`, `config`, and `eval_id` match the inputs exactly
- `expectations` array name is spelled correctly (not `assertions`, not `results`)
- File is written to the run directory, not the outputs directory
