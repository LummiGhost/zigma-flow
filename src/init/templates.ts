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
        kind: file-exists
        path: "."
      - id: route
        type: router
        cases:
          default: continue

  plan:
    needs:
      - risk-scan
    workspace:
      mode: read-only
    steps:
      - id: plan
        type: agent
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
        expose:
          skills:
            - code

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
functions: []

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

## Testing

- Write tests alongside implementation; aim for high coverage on business logic.
- Use descriptive test names that explain the expected behavior.
- Test edge cases and failure paths, not just the happy path.
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

## Output Requirements

You must output a \`report.json\` matching the report schema described in the
workflow-guide knowledge file. The report must include:

- \`outputs\`: key-value pairs of review findings (e.g. approved, issues).
- \`artifacts\`: list of artifact references (e.g. review notes).
- \`signals\`: emit \`review_rejected\` if the implementation has issues that
  require rework; emit \`needs_architecture_design\` if architectural changes
  are needed.
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

- \`outputs\`: include \`summary\` (complete change summary) and
  \`files_changed\` (list of modified files).
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
  return `/**
 * collect-diff script
 *
 * Placeholder script for the collect-diff step. In a real workflow run this
 * script collects the git diff of the current workspace and writes it as an
 * artifact for downstream steps.
 *
 * This file is a template generated by \`zigma-flow init\`. Replace the body
 * with your actual diff-collection logic.
 */

// Example: collect the diff using a git command.
// import { execSync } from "node:child_process";
// const diff = execSync("git diff HEAD", { encoding: "utf-8" });
// process.stdout.write(JSON.stringify({ diff }));

export {};
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
