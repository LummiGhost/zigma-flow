# Workflow Guide

This guide describes the code-change workflow structure and explains what each
job is expected to produce.

## Workflow DAG

```
intake
  └── code-map
        └── risk-scan
              └── plan
                    ├── architecture-design [activation: optional]
                    └── implement (needs: plan + architecture-design)
                          ├── static-check
                          ├── unit-test
                          └── review
                                ├── gate-merge [activation: optional]
                                └── summarize
```

## report.json Contract

Every agent step must write a `report.json` to the run artifact directory.
The report must include the following fields:

- `outputs`: key-value pairs of step outputs.
- `artifacts`: list of artifact file paths produced during this step.
- `signals`: always an empty array (v0.6: signals are deprecated; use status returns instead).
- `summary`: a short human-readable summary of what was done.
- `status` (for steps with `returns`): a structured return status from the
  step's declared `returns.status.values`. Used with `on_return` for flow control.

Example (simple step):
```json
{
  "outputs": { "key": "value" },
  "artifacts": ["path/to/artifact.md"],
  "signals": [],
  "summary": "Completed intake analysis."
}
```

Example (step with status return):
```json
{
  "outputs": { "verdict": "approved", "checked_files": ["src/index.ts"] },
  "artifacts": ["path/to/review-notes.md"],
  "signals": [],
  "summary": "Review completed. All checks passed.",
  "status": "approved"
}
```

## Job Expectations

- **intake**: Analyze the task description. Output an intake-summary artifact.
- **code-map**: Map the relevant code areas. Output a code-map artifact.
- **risk-scan**: Automated script checks that code-map artifact exists and is valid.
- **plan**: Create an implementation plan. Output a plan artifact. Uses
  `returns/on_return` with statuses `ready`, `needs_architecture_design`,
  `blocked`. `needs_architecture_design` activates the optional
  architecture-design job.
- **architecture-design** (optional): Produce an architecture design artifact
  when activated. Job has `activation: optional`.
- **implement**: Implement the change. Has retry support (max 3 attempts).
  Depends on plan and architecture-design (inactive optional deps are satisfied).
- **static-check**: Automated typecheck and lint (script step).
- **unit-test**: Automated test run (script step).
- **review**: Review the implementation. Uses `returns/on_return` with
  statuses `approved`, `rejected`, `needs_architecture_design`.
  `rejected` retries the implement job; `needs_architecture_design`
  activates architecture-design.
- **gate-merge** (optional): Human approval gate. Has `activation: optional`.
- **summarize**: Summarize the completed change. Output a summary artifact.

## Flow Control (v0.6)

Agent steps use `returns/on_return` for structured flow control instead of
signals. Each step declares allowed return statuses via `returns.status.values`
and maps them to routing actions via `on_return`. Optional jobs use
`activation: optional` instead of `activation: manual`.

## Stop After Completing

Each agent step must stop after writing report.json. Do not proceed to
subsequent steps autonomously.
