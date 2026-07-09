# Workflow Guide

This guide describes the code-change workflow structure and explains what each
job is expected to produce.

## Workflow DAG

```
intake
  └── code-map
        └── risk-scan
              └── plan
                    ├── architecture-design [optional, activation: manual]
                    └── implement (optional_needs: architecture-design)
                          ├── static-check
                          ├── unit-test
                          └── review
                                └── summarize
```

## report.json Contract

Every agent step must write a `report.json` to the run artifact directory.
The report must include the following fields:

- `outputs`: key-value pairs of step outputs.
- `artifacts`: list of artifact file paths produced during this step.
- `signals`: list of signal names to emit (e.g. `review_rejected`).
- `summary`: a short human-readable summary of what was done.

Example:
```json
{
  "outputs": { "key": "value" },
  "artifacts": ["path/to/artifact.md"],
  "signals": [],
  "summary": "Completed intake analysis."
}
```

## Job Expectations

- **intake**: Analyze the task description. Output an intake-summary artifact.
- **code-map**: Map the relevant code areas. Output a code-map artifact.
- **risk-scan**: Automated check that code-map artifact exists and is valid.
- **plan**: Create an implementation plan. Output a plan artifact. May emit
  `needs_architecture_design` signal to activate the architecture-design job.
- **architecture-design** (optional): Produce an architecture design artifact
  when activated by signal.
- **implement**: Implement the change. Has retry support (max 3 attempts).
- **static-check**: Automated typecheck and lint (script step).
- **unit-test**: Automated test run (script step).
- **review**: Review the implementation. May emit `review_rejected` signal to
  retry the implement job.
- **summarize**: Summarize the completed change. Output a summary artifact.

## Signals

- `needs_architecture_design`: Emitted by plan or review. Activates the
  optional architecture-design job.
- `review_rejected`: Emitted by review. Retries the implement job (up to 3
  total attempts).

## Stop After Completing

Each agent step must stop after writing report.json. Do not proceed to
subsequent steps autonomously.
