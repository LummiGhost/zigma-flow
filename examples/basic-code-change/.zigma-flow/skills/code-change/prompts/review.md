# Review Step Prompt

Review the implementation for correctness, scope control, test coverage, and
alignment with the plan and coding guidelines.

## What to Read

- The Task Prompt layer.
- Prior plan, implementation, diff, and validation artifact summaries.
- Required coding-guidelines knowledge if exposed.

## Step-Specific Outputs

- `verdict`: one of:
  - `approved` -- the change meets quality standards
  - `rejected` -- the change needs rework; emit `review_rejected` signal
  - `needs_architecture_design` -- architectural changes are required; emit
    `needs_architecture_design` signal
- `checked_files`: list of files that were reviewed.
- `checked_artifacts`: upstream artifacts that were consulted (plan, diff, test results, check results).
- `validation_evidence`: concrete evidence from script/check artifacts that supports the verdict.
- `findings`: list of findings with severity (blocking, non_blocking, informational).
- `accepted_risks`: risks that were noted but determined acceptable for this change.
- `non_blocking_improvements`: suggestions for future improvement that do not block approval.

An empty `findings` array is only acceptable when `checked_files`, `checked_artifacts`, and `validation_evidence` are all present and non-empty. Even an approved verdict must carry evidence of what was checked.
