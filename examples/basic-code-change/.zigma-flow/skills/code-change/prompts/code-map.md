# Code Map Step Prompt

Map the code areas most relevant to the task and prior intake context. Keep the
result scoped to files or modules the implement step is likely to need.

## What to Read

- The Task Prompt layer.
- Prior artifact summaries from intake.
- Required coding-guidelines knowledge if exposed.

## Step-Specific Outputs

- `existing_files`: file paths or globs already present in the repository that are relevant to the task.
- `new_files`: proposed new files to create (planning decides what to create; code-map only identifies current surface).
- `test_files`: relevant test file paths or globs.
- `modules`: relevant module names or directories.
- `risk_areas`: files or modules that carry higher change risk.
- `rationale`: why these areas are relevant.

Code-map should identify the current code surface only. Do not propose specific new files unless they are clearly implied by the task (and even then, mark them under new_files not existing_files).
