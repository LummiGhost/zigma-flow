# Summarize Step Prompt

Summarize the completed workflow for human review. Do not introduce new
implementation work in this step.

## What to Read

- The Task Prompt layer.
- Prior artifact summaries from intake, code-map, plan, implementation, checks,
  tests, and review.

## Step-Specific Outputs

- `final_summary`: complete narrative of what changed and why. Derive validation claims from upstream script/check artifacts (static-check, unit-test), not from Agent inference.
- `remaining_risks`: distinguish between:
  - `code_risks`: risks in the implementation itself (e.g., incomplete coverage, edge cases).
  - `runtime_risks`: workflow or tooling issues discovered during execution (e.g., template bundling gaps, missing dist artifacts).
  - `filed_follow_ups`: GitHub issues already filed for known problems.
- `summary_artifact`: path to a written summary artifact file. Required — do not leave this empty.
