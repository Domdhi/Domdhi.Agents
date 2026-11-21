Grade every assertion in a skill eval run as pass or fail, with cited evidence, and write `grading.json`.

## Inputs

You receive:
- The eval transcript (or a path to it)
- The outputs directory for this run (e.g. `eval-<id>-<name>/with_skill/outputs/`)
- A list of assertion strings (the `assertions` array from the eval)
- The `run_id` (e.g. `eval-0-with_skill`), `config` (`with_skill` | `without_skill` | `old_skill`), and `eval_id` (integer)

## Grading Rules

Grade each assertion as `true` or `false`, with no partial credit. The burden of proof is on the assertion: absent, contradictory or superficial evidence is `false`. A file existing does not prove correct content, and a non-empty output does not prove it answers the prompt, so ask whether the evidence genuinely shows what the assertion claims.

Cite the strongest supporting or refuting quote from the transcript or output files, at most 125 characters. With nothing specific, write "no evidence found" and grade `false`.

`evidence` must be valid JSON string content. Paraphrase a snippet that carries its own quotes, backticks or newlines instead of pasting it, or write `grading.json` programmatically with `JSON.stringify`. A malformed file does not error: the aggregator silently drops the run, a baseline vanishes and the reported delta is wrong (this corrupted a real apply decision).

Check machine-verifiable assertions (file exists, JSON valid, output contains a string) with a script, and paste its output as evidence.

## Eval Quality Critique

After grading, flag genuine problems in the assertions themselves: non-discriminating ones that would pass without the skill, coverage gaps an author would regret (behaviors the prompt exercises that nothing checks), and trivial ones that add no signal. Skip this when the evals are solid. It goes in the `eval_critique` field.

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

## Before Writing

Every assertion has a verdict and evidence, `run_id`/`config`/`eval_id` match the inputs exactly, the array is spelled `expectations`, and the file goes in the run directory, not the outputs directory. Verify the file parses: `node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <run>/grading.json`
