/**
 * Built-in template content for zigma-flow init.
 *
 * Reference: docs/prd.md §11 (skill pack manifest), §12 (workflow YAML), §16 (data dir).
 */

import { createHash } from "node:crypto";

import { buildInstallCommand, buildScriptCommand } from "./detect.js";
import type { DetectionResult } from "./detect.js";

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

export function configJsonTemplate(version: string): string {
  return JSON.stringify(
    {
      tool_version: version,
      agent: {
        backend: "claude-code",
        backends: {
          "claude-code": {
            command: "claude",
            args: ["-p"],
            timeout: 600000
          }
        }
      }
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

export function codeChangeWorkflowYml(detection?: DetectionResult): string {
  // Determine build parameters from detection (or fallback defaults)
  const hasPackageJson = detection?.hasPackageJson ?? false;
  const pm = detection?.packageManager ?? "pnpm";
  const scripts = detection?.scripts ?? null;

  // Prepare script commands
  const cmd = (name: string) => buildScriptCommand(pm, name);

  // --- Static-check job ---
  let staticCheckRun: string | null;
  if (!hasPackageJson) {
    // Backward-compatible default: pnpm with all scripts
    staticCheckRun = "pnpm typecheck && pnpm lint";
  } else if (scripts!.typecheck && scripts!.lint) {
    staticCheckRun = `${cmd("typecheck")} && ${cmd("lint")}`;
  } else if (scripts!.typecheck) {
    staticCheckRun = cmd("typecheck");
  } else if (scripts!.lint) {
    staticCheckRun = cmd("lint");
  } else {
    staticCheckRun = null; // → agent step
  }

  // --- Unit-test job ---
  let unitTestRun: string | null;
  if (!hasPackageJson) {
    unitTestRun = "pnpm test:ci";
  } else if (scripts!.testCi) {
    unitTestRun = cmd("test:ci");
  } else if (scripts!.test) {
    unitTestRun = cmd("test");
  } else {
    unitTestRun = null; // → agent step
  }

  // --- Build job ---
  const hasBuild = hasPackageJson && scripts!.build;

  // --- Install-deps job (conditional on hasPackageJson) ---
  let installDepsJob = "";
  if (hasPackageJson) {
    const installCmd = buildInstallCommand(pm);
    installDepsJob = `
  install-deps:
    needs:
      - implement
    workspace:
      mode: writable
    steps:
      - id: install
        type: script
        run: "${installCmd}"
        env:
          CI: "true"
        on_failure: fail
`;
  }

  // --- Needs strings (install-deps prepended when applicable) ---
  const staticCheckNeeds = (() => {
    const deps: string[] = hasBuild ? ["build"] : ["implement"];
    if (hasPackageJson) deps.push("install-deps");
    return deps.map(d => `      - ${d}`).join("\n");
  })();

  const unitTestNeeds = (() => {
    const deps: string[] = ["implement"];
    if (hasPackageJson) deps.push("install-deps");
    return deps.map(d => `      - ${d}`).join("\n");
  })();

  // --- Header (through implement job) ---
  const header = `name: code-change
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
        prompt: intake
        with:
          task: "\${{ inputs.task }}"
        outputs:
          task_summary: {}
          scope: {}
          complexity_profile: {}
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
        prompt: code-map
        with:
          task: "\${{ inputs.task }}"
        outputs:
          existing_files: {}
          new_files: {}
          test_files: {}
          modules: {}
          risk_areas: {}
          rationale: {}
        expose:
          skills:
            - code

  risk-scan:
    needs:
      - code-map
    workspace:
      mode: read-only
    steps:
      - id: validate-report
        type: check
        uses: zigma/file-exists
        with:
          file: "jobs/code-map/attempts/1/steps/map/report.json"
        on_fail: fail
      - id: validate-outputs
        type: check
        uses: zigma/required-fields
        with:
          file: "jobs/code-map/attempts/1/steps/map/report.json"
          fields:
            - outputs
            - summary
        on_fail: fail

  plan:
    needs:
      - risk-scan
    workspace:
      mode: read-only
    steps:
      - id: plan
        type: agent
        prompt: plan
        with:
          task: "\${{ inputs.task }}"
        outputs:
          plan_summary: {}
          steps: {}
          risks: {}
          validation_commands: {}
          contracts_to_preserve: {}
          out_of_scope: {}
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
        prompt: architecture-design
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
        prompt: implement
        with:
          task: "\${{ inputs.task }}"
        outputs:
          summary: {}
          files_changed: {}
        expose:
          skills:
            - code
      - id: collect-diff
        type: script
        run: "git diff HEAD"
        env:
          CI: "true"
        on_failure: fail
`;

  // --- Build job (conditional) ---
  let buildJob = "";
  if (hasBuild) {
    buildJob = `
  build:
    needs:
      - implement
    workspace:
      mode: read-only
    steps:
      - id: build
        type: script
        run: "${cmd("build")}"
        env:
          CI: "true"
        on_failure: fail
`;
  }

  // --- Static-check job ---
  let staticCheckJob: string;
  if (staticCheckRun !== null) {
    staticCheckJob = `
  static-check:
    needs:
${staticCheckNeeds}
    workspace:
      mode: read-only
    steps:
      - id: check
        type: script
        run: "${staticCheckRun}"
        env:
          CI: "true"
        on_failure: fail
`;
  } else {
    staticCheckJob = `
  static-check:
    needs:
${staticCheckNeeds}
    workspace:
      mode: read-only
    steps:
      - id: check
        type: agent
        prompt: |
          No static check scripts (typecheck or lint) were found in your
          package.json. Consider adding them to improve code quality.
`;
  }

  // --- Unit-test job ---
  let unitTestJob: string;
  if (unitTestRun !== null) {
    unitTestJob = `
  unit-test:
    needs:
${unitTestNeeds}
    workspace:
      mode: read-only
    steps:
      - id: test
        type: script
        run: "${unitTestRun}"
        env:
          CI: "true"
        on_failure: fail
`;
  } else {
    unitTestJob = `
  unit-test:
    needs:
${unitTestNeeds}
    workspace:
      mode: read-only
    steps:
      - id: test
        type: agent
        prompt: |
          No test scripts (test or test:ci) were found in your package.json.
          Consider adding a test framework to run automated tests.
`;
  }

  // --- Footer (review through summarize) ---
  const footer = `
  review:
    needs:
      - static-check
      - unit-test
    workspace:
      mode: read-only
    steps:
      - id: review
        type: agent
        prompt: review
        with:
          task: "\${{ inputs.task }}"
        outputs:
          verdict: {}
          checked_files: {}
          checked_artifacts: {}
          validation_evidence: {}
          findings: {}
          accepted_risks: {}
          non_blocking_improvements: {}
        expose:
          skills:
            - code

  gate-merge:
    activation: "manual"
    needs:
      - review
    steps:
      - id: gate-merge
        type: human
        prompt: |
          Review the implementation summary and approve before merging.
        instructions: |
          Use \`zigma-flow approve --job gate-merge\` to proceed,
          or \`zigma-flow reject --job gate-merge --comment "reason"\` to send back.
        approvers: []
        outputs:
          decision: human.decision
          comment: human.comment

  summarize:
    needs:
      - review
    optional_needs:
      - gate-merge
    workspace:
      mode: read-only
    steps:
      - id: summarize
        type: agent
        prompt: summarize
        with:
          task: "\${{ inputs.task }}"
        outputs:
          final_summary: {}
          remaining_risks: {}
          summary_artifact: {}
        required_artifacts:
          - summary.md
        expose:
          skills:
            - code
`;

  return header + installDepsJob + buildJob + staticCheckJob + unitTestJob + footer;
}

// ---------------------------------------------------------------------------
// workflows/code-change-fast.yml
// ---------------------------------------------------------------------------

export function codeChangeFastWorkflowYml(): string {
  return `name: code-change-fast
version: 0.1.0

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

jobs:
  intake:
    workspace:
      mode: read-only
    steps:
      - id: analyze
        type: agent
        prompt: intake
        with:
          task: "\${{ inputs.task }}"
        outputs:
          task_summary: {}
          scope: {}
          complexity_profile: {}
        expose:
          skills:
            - code

  implement:
    needs:
      - intake
    retry:
      max_attempts: 3
      on_exceeded:
        status: failed
    steps:
      - id: implement
        type: agent
        prompt: implement
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code
      - id: collect-diff
        type: script
        run: "git diff HEAD"
        env:
          CI: "true"
        on_failure: fail

  static-check:
    needs:
      - implement
    workspace:
      mode: read-only
    steps:
      - id: check
        type: script
        run: "pnpm typecheck && pnpm lint"
        env:
          CI: "true"
        on_failure: fail

  unit-test:
    needs:
      - implement
    workspace:
      mode: read-only
    steps:
      - id: test
        type: script
        run: "pnpm test:ci"
        env:
          CI: "true"
        on_failure: fail

  summarize:
    needs:
      - static-check
      - unit-test
    workspace:
      mode: read-only
    steps:
      - id: summarize
        type: agent
        prompt: summarize
        with:
          task: "\${{ inputs.task }}"
        outputs:
          final_summary: {}
          remaining_risks: {}
          summary_artifact: {}
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
  - id: architecture-design
    path: prompts/architecture-design.md
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
    jobs:
      - implement
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
    jobs:
      - review
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

Analyze the run task and define the handoff scope for later code-change jobs.
Do not inspect the entire repository unless the task text is too ambiguous to
classify.

## What to Read

- The Task Prompt layer.
- Required coding-guidelines knowledge if exposed.

## Step-Specific Outputs

- \`task_summary\`: short restatement of the requested change.
- \`scope\`: estimated scope, one of \`small\`, \`medium\`, or \`large\`.
- \`complexity_profile\`: complexity classification, one of \`trivial\`, \`small\`, \`medium\`, or \`large\`.
- \`risk_notes\`: short list of visible ambiguity or blocker notes.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/code-map.md
// ---------------------------------------------------------------------------

export function codeMapMd(): string {
  return `# Code Map Step Prompt

Map the code areas most relevant to the task and prior intake context. Keep the
result scoped to files or modules the implement step is likely to need.

## What to Read

- The Task Prompt layer.
- Prior artifact summaries from intake.
- Required coding-guidelines knowledge if exposed.

## Step-Specific Outputs

- \`existing_files\`: file paths or globs already present in the repository that are relevant to the task.
- \`new_files\`: proposed new files to create (planning decides what to create; code-map only identifies current surface).
- \`test_files\`: relevant test file paths or globs.
- \`modules\`: relevant module names or directories.
- \`risk_areas\`: files or modules that carry higher change risk.
- \`rationale\`: why these areas are relevant.

Code-map should identify the current code surface only. Do not propose specific new files unless they are clearly implied by the task (and even then, mark them under new_files not existing_files).
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/plan.md
// ---------------------------------------------------------------------------

export function planMd(): string {
  return `# Plan Step Prompt

Create a concrete implementation plan from the task, intake summary, and code
map. Keep the plan reviewable and limited to the current MVP scope.

## What to Read

- The Task Prompt layer.
- Prior intake and code-map artifact summaries.
- Required coding-guidelines and workflow-guide knowledge if exposed.

## Step-Specific Outputs

- \`plan_summary\`: concise plan overview.
- \`steps\`: ordered implementation steps.
- \`risks\`: known risks for each implementation step, with severity.
- \`validation_commands\`: concrete commands the implementer or downstream script jobs should run to verify correctness.
- \`contracts_to_preserve\`: existing API, schema, or behavioral contracts that must not be broken.
- \`out_of_scope\`: explicitly list what is NOT included in this plan, to prevent scope creep.
- \`alternatives_considered\` (optional): alternative approaches and why they were rejected.
- Signal \`needs_architecture_design\` only when the plan requires an explicit
  architecture decision before implementation.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/architecture-design.md
// ---------------------------------------------------------------------------

export function architectureDesignMd(): string {
  return `# Architecture Design Step Prompt

Resolve the architecture question that activated this optional job. Produce a
decision that the implement step can follow without changing workflow state or
expanding MVP scope.

## What to Read

- The Task Prompt layer.
- Prior plan and context artifact summaries.
- Required workflow-guide knowledge if exposed.

## Step-Specific Outputs

- \`decision\`: selected design direction.
- \`constraints\`: module boundaries and MVP guardrails to preserve.
- \`implementation_notes\`: concrete guidance for the implement step.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/implement.md
// ---------------------------------------------------------------------------

export function implementMd(): string {
  return `# Implement Step Prompt

Implement the requested change using the plan and context blocks. Keep edits
limited to the task scope and preserve runtime state ownership.

## What to Read

- The Task Prompt layer.
- Prior intake, code-map, plan, and architecture-design artifact summaries when available.
- Required coding-guidelines knowledge if exposed.

## Validation

Validation (typecheck and tests) is deferred to downstream script jobs
(\`static-check\` and \`unit-test\`). Do not claim typecheck or test results
in your report — those jobs own the authoritative validation evidence.

## Step-Specific Outputs

- \`summary\`: implementation summary.
- \`files_changed\`: changed repository files.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/review.md
// ---------------------------------------------------------------------------

export function reviewMd(): string {
  return `# Review Step Prompt

Review the implementation for correctness, scope control, test coverage, and
alignment with the plan and coding guidelines.

## What to Read

- The Task Prompt layer.
- Prior plan, implementation, diff, and validation artifact summaries.
- Required coding-guidelines knowledge if exposed.

## Step-Specific Outputs

- \`verdict\`: one of:
  - \`approved\` — the change meets quality standards
  - \`rejected\` — the change needs rework; emit \`review_rejected\` signal
  - \`needs_architecture_design\` — architectural changes are required; emit
    \`needs_architecture_design\` signal
- \`checked_files\`: list of files that were reviewed.
- \`checked_artifacts\`: upstream artifacts that were consulted (plan, diff, test results, check results).
- \`validation_evidence\`: concrete evidence from script/check artifacts that supports the verdict.
- \`findings\`: list of findings with severity (blocking, non_blocking, informational).
- \`accepted_risks\`: risks that were noted but determined acceptable for this change.
- \`non_blocking_improvements\`: suggestions for future improvement that do not block approval.

An empty \`findings\` array is only acceptable when \`checked_files\`, \`checked_artifacts\`, and \`validation_evidence\` are all present and non-empty. Even an approved verdict must carry evidence of what was checked.
`;
}

// ---------------------------------------------------------------------------
// skills/code-change/prompts/summarize.md
// ---------------------------------------------------------------------------

export function summarizeMd(): string {
  return `# Summarize Step Prompt

Summarize the completed workflow for human review. Do not introduce new
implementation work in this step.

## What to Read

- The Task Prompt layer.
- Prior artifact summaries from intake, code-map, plan, implementation, checks,
  tests, and review.

## Step-Specific Outputs

- \`final_summary\`: complete narrative of what changed and why. Derive validation claims from upstream script/check artifacts (static-check, unit-test), not from Agent inference.
- \`remaining_risks\`: distinguish between:
  - \`code_risks\`: risks in the implementation itself (e.g., incomplete coverage, edge cases).
  - \`runtime_risks\`: workflow or tooling issues discovered during execution (e.g., template bundling gaps, missing dist artifacts).
  - \`filed_follow_ups\`: GitHub issues already filed for known problems.
- \`summary_artifact\`: path to a written summary artifact file. Required — do not leave this empty.
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
