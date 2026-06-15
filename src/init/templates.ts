/**
 * Built-in template content for zigma-flow init.
 *
 * Reference: docs/prd.md §11 (skill pack manifest), §12 (workflow YAML), §16 (data dir).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

export function configJsonTemplate(version: string): string {
  return JSON.stringify(
    {
      tool_version: version,
      active_run: null
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// skill-lock.json
// ---------------------------------------------------------------------------

export function skillLockJsonTemplate(skillManifestContent: string): string {
  const hash = createHash("sha256").update(skillManifestContent, "utf-8").digest("hex");
  return JSON.stringify(
    {
      skills: {
        "zigma.code-change": {
          resolved: "local://skills/code-change",
          version: "1.0.0",
          hash
        }
      }
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// workflows/code-change.yml
// ---------------------------------------------------------------------------

export function codeChangeWorkflowYml(): string {
  return `name: code-change
version: 0.3.0

on:
  manual:
    inputs:
      task:
        type: string
        required: true

skills:
  code:
    uses: skill://zigma.code-change@1

permissions:
  contents: read
  edits: write
  commands: none
  workflow_state: none

signals:
  needs_architecture_design:
    severity: info
    priority: 50
    allowed_from:
      - plan
      - review
    action:
      activate_job: architecture-design

  review_rejected:
    severity: high
    priority: 100
    allowed_from:
      - review
    action:
      retry_job: implement

jobs:
  intake:
    workspace:
      mode: read-only
    steps:
      - id: analyze
        type: agent
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code

  code-map:
    needs:
      - intake
    workspace:
      mode: read-only
    steps:
      - id: map
        type: agent
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code

  risk-scan:
    needs:
      - code-map
    workspace:
      mode: read-only
    steps:
      - id: validate
        type: check
        uses: zigma/file-exists
        with:
          file: "."
        on_fail: fail

  plan:
    needs:
      - risk-scan
    workspace:
      mode: read-only
    steps:
      - id: plan
        type: agent
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code

  architecture-design:
    activation: "manual"
    needs:
      - plan
    workspace:
      mode: read-only
    steps:
      - id: design
        type: agent
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code

  implement:
    needs:
      - plan
    optional_needs:
      - architecture-design
    retry:
      max_attempts: 3
      on_exceeded:
        status: failed
    steps:
      - id: implement
        type: agent
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code
      - id: collect-diff
        type: script
        run: "git diff HEAD"
        on_failure: fail

  static-check:
    needs:
      - implement
    workspace:
      mode: read-only
    steps:
      - id: check
        type: script
        run: "echo 'static-check placeholder: replace with pnpm typecheck && pnpm lint'"
        on_failure: fail

  unit-test:
    needs:
      - implement
    workspace:
      mode: read-only
    steps:
      - id: test
        type: script
        run: "echo 'unit-test placeholder: replace with pnpm test:ci'"
        on_failure: fail

  review:
    needs:
      - static-check
      - unit-test
    workspace:
      mode: read-only
    steps:
      - id: review
        type: agent
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code

  summarize:
    needs:
      - review
    workspace:
      mode: read-only
    steps:
      - id: summarize
        type: agent
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/skill.yml
// ---------------------------------------------------------------------------

export function skillYml(): string {
  return `id: zigma.code-change
kind: skill-pack
name: zigma.code-change
version: 1.0.0
description: >
  Code change skill pack for Zigma Flow.

knowledge:
  - id: coding-guidelines
    path: knowledge/coding-guidelines.md
  - id: workflow-guide
    path: knowledge/workflow-guide.md
  - id: common-failure-patterns
    path: knowledge/common-failure-patterns.md

prompts:
  - id: intake
    path: prompts/intake.md
  - id: code-map
    path: prompts/code-map.md
  - id: plan
    path: prompts/plan.md
  - id: implement
    path: prompts/implement.md
  - id: review
    path: prompts/review.md
  - id: summarize
    path: prompts/summarize.md

scripts: []
checks: []

functions:
  - id: implement-by-plan
    description: Execute plan steps to modify code according to a given implementation plan
    inputs:
      plan:
        type: string
        description: "Implementation plan to execute"
      context:
        type: string
        description: "Additional context or constraints for the implementation"
    outputs:
      summary:
        type: string
        description: "Summary of changes made"
      files_changed:
        type: string
        description: "Comma-separated list of modified files"
  - id: review-change
    description: Review code changes for quality, correctness, and adherence to guidelines
    inputs:
      diff:
        type: string
        description: "Git diff of changes to review"
      plan:
        type: string
        description: "Original implementation plan for comparison"
    outputs:
      verdict:
        type: string
        description: "approved, rejected, or needs_architecture_design"
      issues:
        type: string
        description: "Description of issues found; empty string if approved"

policies:
  default_permissions:
    contents: read
    edits: none
    commands: none
    workflow_state: none
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/knowledge/coding-guidelines.md
// ---------------------------------------------------------------------------

export function codingGuidelinesMd(): string {
  return `# Coding Guidelines

## General Principles

- Write clear, readable code with meaningful names for variables, functions, and types.
- Keep functions small and focused on a single responsibility.
- Prefer explicit over implicit: avoid magic numbers and unexplained side effects.
- Handle errors explicitly; never silently swallow exceptions.
- Use TypeScript's strict mode features to catch type errors at compile time.

## Code Style

- Use \`const\` by default; use \`let\` only when reassignment is necessary.
- Prefer \`async/await\` over raw Promises for asynchronous code.
- Import only what you need; avoid wildcard imports.
- Keep imports grouped: Node built-ins first, then external packages, then internal modules.

## Incremental Changes

- Make small, incremental changes rather than large rewrites. Each small step should
  compile, pass tests, and be independently reviewable before moving to the next.
- Prefer tight edit loops: modify one logical unit at a time, verify it works,
  then proceed. Avoid sweeping multi-file refactors in a single step.

## Testing

- Write tests alongside implementation; aim for high coverage on business logic.
- Use descriptive test names that explain the expected behavior.
- Test edge cases and failure paths, not just the happy path.

## State and Runtime File Restrictions

You must not modify any files under \`.zigma-flow/\`. You must not modify
\`state.json\`, \`config.json\`, \`skill-lock.json\`, or any other runtime
infrastructure file. These files are owned by the Zigma Flow runtime and must
never be changed by agent or script steps.

Do not modify the \`.zigma-flow/runs/\` directory or any of its contents.
Do not modify \`.zigma-flow/state.json\`. Violations are treated as forbidden
actions and will fail the step.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/knowledge/common-failure-patterns.md
// ---------------------------------------------------------------------------

export function commonFailurePatternsMd(): string {
  return `# Common Failure Patterns

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
order, write \`report.json\` with all required fields, and stop before
proceeding.

## 2. Making Unverified Changes

**Pattern**: Modifying files without verifying that the changes compile or
pass existing tests before writing the \`report.json\`.

**Why it fails**: Unverified changes cause downstream static-check and
unit-test jobs to fail, triggering retry loops and wasting attempts.

**Correct approach**: After each change, verify compilation and test
compatibility. Only report success after confirming the change is valid.

## 3. Unauthorized Modifications

**Pattern**: Modifying files that are off-limits:
- \`.zigma-flow/runs/\` — runtime run state directory
- \`.zigma-flow/state.json\` — workflow state managed by the engine
- \`.zigma-flow/config.json\` — runtime configuration
- \`.zigma-flow/skill-lock.json\` — skill lock file
- Any other file under \`.zigma-flow/\`

**Why it fails**: These files are owned by the Zigma Flow runtime. Modifying
them bypasses engine state transitions and corrupts workflow state. This
triggers a PermissionError and fails the step immediately.

**Correct approach**: Never touch files under \`.zigma-flow/\`. Write outputs
only to the locations specified by the workflow and skill pack.

## 4. Missing or Incomplete Reports

**Pattern**: Not writing \`report.json\` after completing a step, or writing a
\`report.json\` that is missing required fields (\`outputs\`, \`artifacts\`,
\`signals\`, \`summary\`).

**Why it fails**: The engine validates \`report.json\` against the required
schema. Missing files or empty required fields cause the step to be marked as
failed, even if the underlying work was done correctly.

**Correct approach**: Always write a complete \`report.json\` as the final
action of every agent step. Ensure all required fields are populated with
meaningful values, not empty strings or null.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/knowledge/workflow-guide.md
// ---------------------------------------------------------------------------

export function workflowGuideMd(): string {
  return `# Workflow Guide

This guide describes the code-change workflow structure and explains what each
job is expected to produce.

## Workflow DAG

\`\`\`
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
\`\`\`

## report.json Contract

Every agent step must write a \`report.json\` to the run artifact directory.
The report must include the following fields:

- \`outputs\`: key-value pairs of step outputs.
- \`artifacts\`: list of artifact file paths produced during this step.
- \`signals\`: list of signal names to emit (e.g. \`review_rejected\`).
- \`summary\`: a short human-readable summary of what was done.

Example:
\`\`\`json
{
  "outputs": { "key": "value" },
  "artifacts": ["path/to/artifact.md"],
  "signals": [],
  "summary": "Completed intake analysis."
}
\`\`\`

## Job Expectations

- **intake**: Analyze the task description. Output an intake-summary artifact.
- **code-map**: Map the relevant code areas. Output a code-map artifact.
- **risk-scan**: Automated check that code-map artifact exists and is valid.
- **plan**: Create an implementation plan. Output a plan artifact. May emit
  \`needs_architecture_design\` signal to activate the architecture-design job.
- **architecture-design** (optional): Produce an architecture design artifact
  when activated by signal.
- **implement**: Implement the change. Has retry support (max 3 attempts).
- **static-check**: Automated typecheck and lint (script step).
- **unit-test**: Automated test run (script step).
- **review**: Review the implementation. May emit \`review_rejected\` signal to
  retry the implement job.
- **summarize**: Summarize the completed change. Output a summary artifact.

## Signals

- \`needs_architecture_design\`: Emitted by plan or review. Activates the
  optional architecture-design job.
- \`review_rejected\`: Emitted by review. Retries the implement job (up to 3
  total attempts).

## Stop After Completing

Each agent step must stop after writing report.json. Do not proceed to
subsequent steps autonomously.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/intake.md
// ---------------------------------------------------------------------------

export function intakeMd(): string {
  return `# Intake Step Prompt

You are the intake agent for a code-change workflow step.

## Task

Analyze the task description provided in the workflow inputs and produce an
intake summary that will guide subsequent steps.

## What to Read

- The task description from \`inputs.task\`.
- The coding guidelines knowledge file for context.

## Output Requirements

Write a \`report.json\` with the following fields:

- \`outputs\`: include \`task_summary\` (short restatement of the task) and
  \`scope\` (estimated scope: small/medium/large).
- \`artifacts\`: list any artifact files you produce.
- \`signals\`: leave empty unless you detect a blocking issue.
- \`summary\`: a short human-readable summary of the task.

The report schema is described in the workflow-guide knowledge file.

Stop after completing this step — do not proceed to subsequent steps autonomously.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/code-map.md
// ---------------------------------------------------------------------------

export function codeMapMd(): string {
  return `# Code Map Step Prompt

You are the code-map agent for a code-change workflow step.

## Task

Analyze the codebase structure and identify the files, modules, and areas
most relevant to the task.

## What to Read

- The intake summary artifact from the previous step.
- The coding guidelines knowledge file.

## Output Requirements

Write a \`report.json\` with the following fields:

- \`outputs\`: include \`files\` (list of relevant file paths) and
  \`modules\` (list of relevant module names).
- \`artifacts\`: list the code-map artifact file you produce.
- \`signals\`: leave empty unless you detect a blocking issue.
- \`summary\`: a short description of the code areas identified.

The report schema is described in the workflow-guide knowledge file.

Stop after completing this step — do not proceed to subsequent steps autonomously.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/plan.md
// ---------------------------------------------------------------------------

export function planMd(): string {
  return `# Plan Step Prompt

You are the planning agent for a code-change workflow step.

## Task

Create a detailed implementation plan based on the intake summary and code map.

## What to Read

- The intake summary artifact.
- The code-map artifact.
- The coding guidelines knowledge file.

## Output Requirements

Write a \`report.json\` with the following fields:

- \`outputs\`: include \`plan_summary\` and \`steps\` (ordered list of
  implementation steps).
- \`artifacts\`: list the plan artifact file you produce.
- \`signals\`: emit \`needs_architecture_design\` if the change requires
  significant architectural decisions.
- \`summary\`: a short description of the implementation plan.

The report schema is described in the workflow-guide knowledge file.

Stop after completing this step — do not proceed to subsequent steps autonomously.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/implement.md
// ---------------------------------------------------------------------------

export function implementMd(): string {
  return `# Implement Step Prompt

You are the implementation agent for a code-change workflow step.

## Task

Implement the requested change based on the task description and available context.

## What to Read

- The intake summary, code-map, and plan artifacts.
- The architecture design artifact if available.
- The coding guidelines knowledge file.

## Output Requirements

You must output a \`report.json\` matching the report schema described in the
workflow-guide knowledge file. The report must include:

- \`outputs\`: key-value pairs of step outputs (e.g. summary, file paths).
- \`artifacts\`: list of artifact references produced during this step.
- \`signals\`: list of signals to emit (e.g. \`review_rejected\` is not for
  this step — leave empty unless unexpected).
- \`summary\`: a short human-readable summary of what was done.

## Forbidden Actions

You must not modify files under \`.zigma-flow/\`. You must not modify
\`state.json\`, \`config.json\`, or any runtime infrastructure file. You must
not modify \`.zigma-flow/runs/\` or any file under \`.zigma-flow/\`.

Do not modify lock files, CI configuration files, or any file outside the
scope of the implementation plan without explicit authorization.

## Instructions

1. Read the task description and understand the required change.
2. Implement the change according to the coding guidelines.
3. Verify that your changes compile and pass existing tests where applicable.
4. Write the report.json with all required fields populated.
5. Stop after completing this step — do not proceed to subsequent steps autonomously.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/review.md
// ---------------------------------------------------------------------------

export function reviewMd(): string {
  return `# Review Step Prompt

You are the review agent for a code-change workflow step.

## Task

Review the implementation produced in the previous step for correctness,
quality, and adherence to the coding guidelines.

## What to Read

- The implementation artifacts from the implement step.
- The plan artifact to verify the implementation matches the plan.
- The coding guidelines knowledge file.

## Output Verdicts

Your report outputs must include a \`verdict\` field set to one of:
- \`approved\` — the change meets quality standards
- \`rejected\` — the change needs rework; emit \`review_rejected\` signal
- \`needs_architecture_design\` — architectural changes are required; emit
  \`needs_architecture_design\` signal

## Output Requirements

You must output a \`report.json\` matching the report schema described in the
workflow-guide knowledge file. The report must include:

- \`outputs\`: key-value pairs of review findings, including the \`verdict\`
  field (one of: \`approved\`, \`rejected\`, \`needs_architecture_design\`).
- \`artifacts\`: list of artifact references (e.g. review notes).
- \`signals\`: emit \`review_rejected\` if verdict is \`rejected\`; emit
  \`needs_architecture_design\` if verdict is \`needs_architecture_design\`.
- \`summary\`: a short human-readable summary of the review outcome.

## Instructions

1. Review the diff and implementation artifacts from the previous step.
2. Check against the coding guidelines and project architecture constraints.
3. Identify any issues, risks, or improvements.
4. Write the report.json with all required fields populated.
5. Stop after completing this step — do not proceed to subsequent steps autonomously.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/summarize.md
// ---------------------------------------------------------------------------

export function summarizeMd(): string {
  return `# Summarize Step Prompt

You are the summary agent for a code-change workflow step.

## Task

Produce a final summary of the completed code change for human review and
documentation purposes.

## What to Read

- All artifacts from previous steps (intake summary, code-map, plan,
  implementation, review).
- The workflow-guide knowledge file for context.

## Output Requirements

Write a \`report.json\` with the following fields:

- \`outputs\`: include \`final_summary\` (complete narrative of what was changed
  and why) and \`remaining_risks\` (list of outstanding risks or follow-up
  items, empty array if none).
- \`artifacts\`: list the summary artifact file you produce.
- \`signals\`: leave empty.
- \`summary\`: a concise human-readable summary of the entire change.

The report schema is described in the workflow-guide knowledge file.

Stop after completing this step — do not proceed to subsequent steps autonomously.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/scripts/collect-diff.ts
// ---------------------------------------------------------------------------

export function collectDiffTs(): string {
  return `import { execSync } from "node:child_process";

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

const diff = run("git diff HEAD");
const changedFilesRaw = run("git diff --name-only HEAD");
const changed_files = changedFilesRaw ? changedFilesRaw.split("\\n").filter(Boolean) : [];

process.stdout.write(
  JSON.stringify({ changed_files, diff }, null, 2) + "\\n"
);
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/checks/report-schema.json
// ---------------------------------------------------------------------------

export function reportSchemaJson(): string {
  return JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["outputs", "artifacts", "signals", "summary"],
      properties: {
        outputs: {
          type: "object",
          description: "Key-value pairs of step outputs."
        },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "List of artifact references produced in this step."
        },
        signals: {
          type: "array",
          items: { type: "string" },
          description: "List of signal names emitted by the agent."
        },
        summary: {
          type: "string",
          description: "Short human-readable summary of what was done."
        }
      },
      additionalProperties: false
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// skills/code-change/checks/forbidden-paths.yml
// ---------------------------------------------------------------------------

export function forbiddenPathsYml(): string {
  return `kind: path-policy
description: >
  Paths that must not be modified by agent or script steps.
  Violations cause the current step to fail with a PermissionError.

forbidden:
  - .zigma-flow/runs/**
  - .zigma-flow/state.json
  - .zigma-flow/config.json
  - .zigma-flow/skill-lock.json
`;
}
