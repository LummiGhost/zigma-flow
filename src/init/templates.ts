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
          path: "local://skills/code-change",
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
    expose_to_agent: true

permissions:
  contents: read
  edits: none
  commands: none
  workflow_state: none

signals:
  blocked:
    severity: high
    priority: 100
    allowed_from:
      - intake
    action:
      status: blocked

jobs:
  intake:
    workspace:
      mode: read-only
    steps:
      - id: analyze
        type: agent
        uses: agent://planner
        expose:
          skills:
            - code
        with:
          task: "\${{ inputs.task }}"
        outputs:
          summary: report.summary
          signals: report.signals

      - id: collect-diff
        type: script
        uses: code.scripts.collect-diff
        outputs:
          diff: result.diff

      - id: route
        type: router
        switch: "\${{ steps.analyze.outputs.signals }}"
        cases:
          blocked:
            status: blocked
          default:
            continue
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
  Code change skill pack for Zigma Flow. Provides knowledge, prompts,
  scripts, checks, and policies for implementing and reviewing code changes.

knowledge:
  - path: knowledge/coding-guidelines.md
    id: coding-guidelines

prompts:
  - path: prompts/implement.md
    id: implement
  - path: prompts/review.md
    id: review

scripts:
  - path: scripts/collect-diff.ts
    id: collect-diff

checks:
  - path: checks/report-schema.json
    id: report-schema
    kind: json-schema
  - path: checks/forbidden-paths.yml
    id: forbidden-paths
    kind: path-policy

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
// skills/code-change/prompts/implement.md
// ---------------------------------------------------------------------------

export function implementMd(): string {
  return `# Implement Step Prompt

You are the implementation agent for a code-change workflow step.

## Task

Implement the requested change based on the task description and available context.

## Output Requirements

You must output a \`report.json\` matching the report schema defined in
\`checks/report-schema.json\`. The report must include:

- \`outputs\`: key-value pairs of step outputs (e.g. summary, file paths).
- \`artifacts\`: list of artifact references produced during this step.
- \`signals\`: list of signals to emit (e.g. \`blocked\` if blocked).
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

## Output Requirements

You must output a \`report.json\` matching the report schema defined in
\`checks/report-schema.json\`. The report must include:

- \`outputs\`: key-value pairs of review findings (e.g. approved, issues).
- \`artifacts\`: list of artifact references (e.g. review notes).
- \`signals\`: list of signals to emit (e.g. \`blocked\` if issues require rework).
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
