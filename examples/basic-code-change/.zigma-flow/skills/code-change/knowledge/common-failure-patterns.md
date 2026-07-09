# Common Failure Patterns

This file documents known failure patterns that agent steps must avoid.
Review these patterns before beginning any implementation or review step.

## 1. Skipping Steps

**Pattern**: Jumping from planning directly to implementation without following
the defined workflow steps, or skipping intermediate steps (e.g., going from
intake straight to implement without code-map and plan).

**Why it fails**: Each step produces artifacts that subsequent steps depend on.
Skipping steps means missing context, producing incomplete outputs, and
triggering validation failures downstream.

**Correct approach**: Follow the workflow DAG exactly. Complete each step in
order, write `report.json` with all required fields, and stop before
proceeding.

## 2. Making Unverified Changes

**Pattern**: Modifying files without verifying that the changes compile or
pass existing tests before writing the `report.json`.

**Why it fails**: Unverified changes cause downstream static-check and
unit-test jobs to fail, triggering retry loops and wasting attempts.

**Correct approach**: After each change, verify compilation and test
compatibility. Only report success after confirming the change is valid.

## 3. Unauthorized Modifications

**Pattern**: Modifying files that are off-limits:
- `.zigma-flow/runs/` — runtime run state directory
- `.zigma-flow/state.json` — workflow state managed by the engine
- `.zigma-flow/config.json` — runtime configuration
- `.zigma-flow/skill-lock.json` — skill lock file
- Any other file under `.zigma-flow/`

**Why it fails**: These files are owned by the Zigma Flow runtime. Modifying
them bypasses engine state transitions and corrupts workflow state. This
triggers a PermissionError and fails the step immediately.

**Correct approach**: Never touch files under `.zigma-flow/`. Write outputs
only to the locations specified by the workflow and skill pack.

## 4. Missing or Incomplete Reports

**Pattern**: Not writing `report.json` after completing a step, or writing a
`report.json` that is missing required fields (`outputs`, `artifacts`,
`signals`, `summary`).

**Why it fails**: The engine validates `report.json` against the required
schema. Missing files or empty required fields cause the step to be marked as
failed, even if the underlying work was done correctly.

**Correct approach**: Always write a complete `report.json` as the final
action of every agent step. Ensure all required fields are populated with
meaningful values, not empty strings or null.
