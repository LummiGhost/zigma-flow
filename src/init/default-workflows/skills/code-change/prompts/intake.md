# Intake Step Prompt

Analyze the run task and define the handoff scope for later code-change jobs.
Do not inspect the entire repository unless the task text is too ambiguous to
classify.

## What to Read

- The Task Prompt layer.
- Required coding-guidelines knowledge if exposed.

## Step-Specific Outputs

- `task_summary`: short restatement of the requested change.
- `scope`: estimated scope, one of `small`, `medium`, or `large`.
- `complexity_profile`: complexity classification, one of `trivial`, `small`, `medium`, or `large`.
- `risk_notes`: short list of visible ambiguity or blocker notes.
