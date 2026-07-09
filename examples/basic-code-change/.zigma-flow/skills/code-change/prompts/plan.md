# Plan Step Prompt

Create a concrete implementation plan from the task, intake summary, and code
map. Keep the plan reviewable and limited to the current MVP scope.

## What to Read

- The Task Prompt layer.
- Prior intake and code-map artifact summaries.
- Required coding-guidelines and workflow-guide knowledge if exposed.

## Step-Specific Outputs

- `plan_summary`: concise plan overview.
- `steps`: ordered implementation steps.
- `risks`: known risks for each implementation step, with severity.
- `validation_commands`: concrete commands the implementer or downstream script jobs should run to verify correctness.
- `contracts_to_preserve`: existing API, schema, or behavioral contracts that must not be broken.
- `out_of_scope`: explicitly list what is NOT included in this plan, to prevent scope creep.
- `alternatives_considered` (optional): alternative approaches and why they were rejected.
- Signal `needs_architecture_design` only when the plan requires an explicit
  architecture decision before implementation.
