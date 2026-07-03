# Zigma Flow Workflow Language Specification

Version: 0.3.0 (published 2026-07-03)
Status: Published

## 1. Introduction

The Zigma Flow Workflow Language is a declarative YAML DSL for defining agent workflow runs. A workflow file describes the structure, dependencies, state transitions, parallelism, retry behaviour, and failure handling of a multi-step agent-assisted process.

This specification defines every legal field, type, constraint, and execution semantic. It is the single source of truth for what the Zigma Flow runtime accepts. Any field, value, or construct not described in this document is illegal and must be rejected at validation time.

### 1.1 Core design principles

- **Engine is the only state-machine owner.** Steps submit results; the Engine decides what happens next.
- **The DSL is not a general-purpose programming language.** There is no `while`, `for`, arbitrary expression evaluation, or runtime YAML mutation.
- **Skill Packs are capability packages, not workflow steps.** They expose knowledge, prompts, tools, scripts, and checks but never own workflow state.
- **All state changes are auditable.** Every transition produces a structured event in the event log.

### 1.2 Stability labels

Each field carries one of three stability labels:

| Label | Meaning |
|-------|---------|
| `stable` | Fully supported; will not change in a breaking way within v0.x. |
| `experimental` | Supported but the schema, semantics, or both may change in a future minor release. |
| `reserved` | Recognised by the parser but not executed by the current runtime. Using a reserved field or type produces a validation warning; its content must not affect run behaviour. |

---

## 2. Table of Contents

1. [Introduction](#1-introduction)
2. [Table of Contents](#2-table-of-contents)
3. [Top-Level Fields](#3-top-level-fields)
   - [name](#31-name)
   - [version](#32-version)
   - [on](#33-on-triggers)
   - [skills](#34-skills)
   - [permissions](#35-permissions)
   - [signals](#36-signals)
   - [variables](#37-variables)
   - [context_blocks](#38-context_blocks)
   - [jobs](#39-jobs)
4. [Job Fields](#4-job-fields)
   - [needs](#41-needs)
   - [optional_needs](#42-optional_needs)
   - [activation](#43-activation)
   - [retry](#44-retry)
   - [permissions (job-level)](#45-permissions-job-level)
   - [workspace](#46-workspace)
   - [steps](#47-steps)
5. [Step Reference](#5-step-reference)
   - [Common step fields](#51-common-step-fields)
   - [Agent Step](#52-agent-step)
   - [Script Step](#53-script-step)
   - [Check Step](#54-check-step)
   - [Router Step](#55-router-step)
   - [Human Gate Step](#56-human-gate-step)
   - [Workflow Step (reserved)](#57-workflow-step-reserved)
6. [Expression Syntax](#6-expression-syntax)
   - [Variable references](#61-variable-references)
   - [Context block references](#62-context-block-references)
   - [Conditional expressions](#63-conditional-expressions)
   - [Forbidden constructs](#64-forbidden-constructs)
7. [What the Workflow DSL Is NOT](#7-what-the-workflow-dsl-is-not)
8. [Validation Rules](#8-validation-rules)
9. [Appendix: Full Example](#9-appendix-full-example)

---

## 3. Top-Level Fields

The following fields are valid directly under the workflow root.

### 3.1 `name`

| Attribute | Value |
|-----------|-------|
| Type | `string` |
| Stability | `stable` |
| Required | Yes |

A unique, human-readable identifier for the workflow. Used in CLI commands (`zigma-flow run <name>`) and recorded in run metadata.

**Constraints:**
- Must be non-empty.
- Must contain only lowercase letters, digits, and hyphens (`[a-z0-9-]+`).
- Must not exceed 64 characters.

**Example:**
```yaml
name: code-change
```

### 3.2 `version`

| Attribute | Value |
|-----------|-------|
| Type | `string` |
| Stability | `stable` |
| Required | Yes |

Semantic version of the workflow definition. The runtime records this in run metadata for auditability. Does not control runtime behaviour (the installed CLI version governs execution).

**Constraints:**
- Must be a valid SemVer string (e.g. `0.3.0`).

**Example:**
```yaml
version: 0.3.0
```

### 3.3 `on` (triggers)

| Attribute | Value |
|-----------|-------|
| Type | `map` |
| Stability | `stable` |
| Required | Yes |

Declares how the workflow is triggered. Currently only `manual` is supported.

**Fields under `on.manual`:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `inputs` | `map<string, InputDef>` | `stable` | No | Named inputs the user must (or may) provide at `zigma-flow run`. |

**InputDef fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `type` | `string` | `stable` | Yes | One of `string`, `number`, `boolean`. |
| `required` | `boolean` | `stable` | No | Defaults to `false`. |
| `default` | `any` | `stable` | No | Default value when not provided. |

**Example:**
```yaml
on:
  manual:
    inputs:
      task:
        type: string
        required: true
      repository:
        type: string
        default: "."
```

### 3.4 `skills`

| Attribute | Value |
|-----------|-------|
| Type | `map<string, SkillRef>` |
| Stability | `stable` |
| Required | No |

Declares the Skill Packs available to this workflow. Each entry maps a local alias to a resolved skill reference. Agent Steps use these aliases in their `expose` block.

**SkillRef fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `uses` | `string` | `stable` | Yes | Skill Pack URI in the form `skill://<id>@<version>`. |

**Constraints:**
- Every alias referenced in any `step.expose.skills` must be declared here.
- The referenced Skill Pack must exist and its lockfile entry must resolve.

**Example:**
```yaml
skills:
  code:
    uses: skill://zigma.code-change@1
  project:
    uses: skill://datacat.project-rules@1
```

### 3.5 `permissions`

| Attribute | Value |
|-----------|-------|
| Type | `map` |
| Stability | `stable` |
| Required | No |

Default permissions for all steps in the workflow. Individual jobs and steps can override these with more permissive or restrictive settings. When omitted, all permissions default to `none`.

**Permission fields:**

| Field | Type | Stability | Description |
|-------|------|-----------|-------------|
| `contents` | `read` \| `none` | `stable` | Repository file read access. |
| `edits` | `write` \| `none` | `stable` | Repository file write access. |
| `commands` | `limited` \| `none` | `stable` | Shell command execution. |
| `workflow_state` | `none` | `stable` | Always `none` at workflow level; agents must never modify `state.json`. |
| `variables.read` | `string[]` | `experimental` | v0.2: whitelist of variable names this step may read. |
| `variables.write` | `string[]` | `experimental` | v0.2: whitelist of variable names this step may write via `context_patches`. |
| `context_edit` | `none` \| `read` \| `write` | `experimental` | v0.2: whether `context_patches` in the agent report are accepted. |
| `context_blocks.read` | `string[]` | `experimental` | v0.2: whitelist of context block IDs this step may read. |
| `context_blocks.write` | `string[]` | `experimental` | v0.2: whitelist of context block IDs this step may write via `context_patches`. |

**Constraints:**
- `variables.write` entries must each appear in the corresponding `variables.<name>.allowed_writers`.
- `context_blocks.write` entries must each appear in the corresponding `context_blocks.<id>.allowed_writers`.
- `context_edit: none` causes the entire `context_patches` array to be rejected, even if individual write entries are listed.

**Example:**
```yaml
permissions:
  contents: read
  edits: none
  commands: none
  workflow_state: none
```

### 3.6 `signals`

| Attribute | Value |
|-----------|-------|
| Type | `map<string, SignalDef>` |
| Stability | `stable` |
| Required | No |

Declares the signals that agents may emit and the actions the Engine must take in response. An agent emits a signal in `report.signals[]`; the Engine validates it against this declaration and executes the prescribed action.

**SignalDef fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `severity` | `info` \| `low` \| `medium` \| `high` \| `critical` | `stable` | Yes | Severity level for logging and priority. |
| `priority` | `integer` | `stable` | Yes | Numeric priority; higher values are processed first when multiple signals fire. |
| `allowed_from` | `string[]` | `stable` | Yes | List of job IDs that may emit this signal. |
| `action` | `SignalAction` | `stable` | Yes | The action the Engine takes when this signal is received. |

**SignalAction fields (exactly one must be specified):**

| Field | Type | Description |
|-------|------|-------------|
| `activate_job` | `string` | Activate the named optional job. |
| `retry_job` | `string` | Retry the named job. |
| `status` | `blocked` \| `failed` | Set the run status. |

**Example:**
```yaml
signals:
  needs_architecture_design:
    severity: medium
    priority: 50
    allowed_from:
      - plan
      - review
    action:
      activate_job: architecture-design

  blocked:
    severity: high
    priority: 100
    allowed_from:
      - intake
      - plan
      - implement
    action:
      status: blocked
```

### 3.7 `variables`

| Attribute | Value |
|-----------|-------|
| Type | `map<string, VariableDef>` |
| Stability | `experimental` |
| Required | No |

v0.2: Workflow-scoped variables that serve as a data layer separate from the state machine. Variables can be read by steps (via `${{ variables.<name> }}`) and written by agents (via `report.context_patches`), but only through Engine-validated entries.

**VariableDef fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `type` | `string` \| `number` \| `boolean` \| `array` \| `object` | `experimental` | Yes | The variable's type. |
| `initial` | `any` | `experimental` | Yes | Initial value set at run creation. |
| `enum` | `string[]` | `experimental` | No | Allowed values (only for `type: string`). |
| `allowed_writers` | `string[]` | `experimental` | Yes | Job-step references (`<job>.<step>` or `<job>.*`) permitted to write this variable. |

**Example:**
```yaml
variables:
  plan_status:
    type: string
    initial: pending
    enum: [pending, ready, blocked]
    allowed_writers:
      - plan.plan
      - review.review
  iteration_count:
    type: number
    initial: 0
    allowed_writers:
      - implement.*
```

### 3.8 `context_blocks`

| Attribute | Value |
|-----------|-------|
| Type | `map<string, ContextBlockDef>` |
| Stability | `experimental` |
| Required | No |

v0.2: Named, versioned text blocks that agents can read and write through Engine-validated patches. Each block is stored as a versioned artifact under `runs/<runId>/context-blocks/<id>/v<N>.md`.

**ContextBlockDef fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `initial_artifact` | `string` \| `null` | `experimental` | No | Path to an initial artifact; `null` means empty at creation. |
| `allowed_writers` | `string[]` | `experimental` | Yes | Job-step references permitted to write this block. |

**Example:**
```yaml
context_blocks:
  current-plan:
    initial_artifact: null
    allowed_writers: [plan.plan, implement.edit]
  reviewer-notes:
    initial_artifact: null
    allowed_writers: [review.review]
```

### 3.9 `jobs`

| Attribute | Value |
|-----------|-------|
| Type | `map<string, JobDef>` |
| Stability | `stable` |
| Required | Yes |

The set of jobs that make up the workflow. Each job is a named group of steps with its own dependencies, permissions, workspace mode, and retry policy. The job keys form the nodes of the workflow DAG.

See [§4 Job Fields](#4-job-fields) for the full job definition.

**Constraints:**
- At least one job must be declared.
- Job IDs must be unique within the workflow.
- Job IDs must be valid identifiers: lowercase letters, digits, and hyphens (`[a-z0-9-]+`).

---

## 4. Job Fields

Each entry under `jobs` is a map with the following fields.

### 4.1 `needs`

| Attribute | Value |
|-----------|-------|
| Type | `string[]` |
| Stability | `stable` |
| Required | No |

Job IDs that must complete before this job can become `ready`. A job with no `needs` is eligible to run immediately after run creation.

**Constraints:**
- Every referenced job ID must exist in the workflow.
- The resulting DAG must not contain a cycle.

**Example:**
```yaml
needs:
  - intake
  - code-map
```

### 4.2 `optional_needs`

| Attribute | Value |
|-----------|-------|
| Type | `string[]` |
| Stability | `stable` |
| Required | No |

Job IDs that, if activated, must complete before this job. Unlike `needs`, an inactive optional-need does not block the job. If the referenced optional job is activated later, this job's outputs can reference it.

**Constraints:**
- Every referenced job ID must exist in the workflow.
- Referenced jobs should have `activation` set to a non-`required` value (though this is a warning, not a hard error).

**Example:**
```yaml
optional_needs:
  - architecture-design
```

### 4.3 `activation`

| Attribute | Value |
|-----------|-------|
| Type | `required` \| `optional` \| `manual` |
| Stability | `stable` |
| Required | No |
| Default | `required` |

Controls how the job enters the ready state.

| Value | Behaviour |
|-------|-----------|
| `required` (default) | The job is activated at run creation. It becomes `ready` when all `needs` are met. |
| `optional` | The job starts as `inactive`. It is activated only when a signal or router action explicitly requests it. |
| `manual` | The job starts as `inactive`. It is activated by an explicit human trigger (reserved for future human-gate integration; currently treated as `optional`). |

**Constraints:**
- Jobs referenced by another job's `needs` should not be optional (warning).

**Example:**
```yaml
activation: optional
```

### 4.4 `retry`

| Attribute | Value |
|-----------|-------|
| Type | `map` |
| Stability | `stable` |
| Required | No |

Configures automatic retry behaviour for the job when a router or signal triggers `retry_job`.

**Retry fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `max_attempts` | `integer` | `stable` | Yes | Maximum number of execution attempts. Default is `3` if retry is declared. |
| `on_exceeded` | `map` | `stable` | Yes | Action when `max_attempts` is reached. |

**`on_exceeded` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | `blocked` \| `failed` | The job/run status after exceeding max attempts. |

**Constraints:**
- `max_attempts` must be a positive integer.
- Each attempt produces a separate artifact directory (`attempts/<N>/`).
- Retry does not delete or overwrite historical attempts.

**Example:**
```yaml
retry:
  max_attempts: 3
  on_exceeded:
    status: blocked
```

### 4.5 `permissions` (job-level)

| Attribute | Value |
|-----------|-------|
| Type | `map` |
| Stability | `stable` |
| Required | No |

Overrides the workflow-level `permissions` for all steps in this job. Uses the same field schema as the top-level [`permissions`](#35-permissions). When a field is omitted, the workflow-level value applies.

**Example:**
```yaml
permissions:
  contents: read
  edits: write
  commands: limited
```

### 4.6 `workspace`

| Attribute | Value |
|-----------|-------|
| Type | `map` |
| Stability | `stable` |
| Required | No |

Controls the filesystem access mode for this job.

**Workspace fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `mode` | `read-only` \| `writable` | `stable` | Yes | Filesystem access mode. |
| `branch` | `string` | `experimental` | No | Git branch name pattern for isolated writable work (future). |

**Constraints:**
- `read-only` jobs must not modify the working directory. The Workspace Guard detects and rejects modifications.
- At most one `writable` job may be running at any time.
- `read-only` jobs may run concurrently (up to the configured `parallelism` limit).

**Example:**
```yaml
workspace:
  mode: read-only
```

### 4.7 `steps`

| Attribute | Value |
|-----------|-------|
| Type | `list<StepDef>` |
| Stability | `stable` |
| Required | Yes |

An ordered list of steps that execute sequentially within the job. See [§5 Step Reference](#5-step-reference) for the full step definition.

**Constraints:**
- At least one step must be declared.
- Step `id` values must be unique within the job.
- Steps execute in the order listed, subject to `if:` conditions and `goto_step` jumps.

---

## 5. Step Reference

### 5.1 Common step fields

Every step, regardless of type, supports the following fields.

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `id` | `string` | `stable` | Yes | Unique identifier within the job. |
| `type` | `agent` \| `script` \| `check` \| `router` \| `human` \| `workflow` | `stable` | Yes | The step type. |
| `if` | `string` | `experimental` | No | v0.2: A conditional expression. When it evaluates to `false`, the step is skipped (`step_skipped` event). |
| `max_visits` | `integer` | `experimental` | No | v0.2: Maximum number of times this step can be entered (via `goto_step`). Default `3`. |
| `on_failure` | `map` | `stable` | No | Action when the step fails. |
| `outputs` | `map<string, string>` | `stable` | No | Mapping from output keys to report/result paths. |
| `prompt` | `string` | `stable` | No | The primary prompt (Markdown). Used as the step-level instruction for agent and human steps. |

**`on_failure` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | `failed` \| `blocked` | The step/job status after failure. |
| `fail` | `"fail"` | Shorthand: equivalent to `status: failed`. |

**Example (common fields):**
```yaml
- id: lint
  type: script
  if: "${{ variables.run_lint == 'yes' }}"
  max_visits: 3
  on_failure:
    status: failed
  outputs:
    exit_code: result.exit_code
    log: result.stdout
```

### 5.2 Agent Step

**Type:** `agent`
**Stability:** `stable`

An Agent Step is the only step type that involves an LLM. The Engine generates a prompt, an external coding agent processes it, and the agent's report is validated and acted upon by the Engine.

#### Fields

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `uses` | `string` | `stable` | No | Agent backend URI (e.g. `agent://planner`). |
| `with` | `map<string, string>` | `stable` | No | Input values for the agent, typically `${{ }}` expressions. |
| `expose` | `ExposeDef` | `stable` | No | Controls which Skill Pack capabilities are visible to the agent. |
| `returns` | `ReturnsDef` | `experimental` | No | v0.2: Declares a structured status return with allowed values and corresponding actions. |
| `on_return` | `map<string, OnReturnAction>` | `experimental` | No | v0.2: Maps each allowed `returns.status.values` entry to an Engine action. |

**ExposeDef fields:**

| Field | Type | Description |
|-------|------|-------------|
| `skills` | `string[]` | Skill Pack aliases (must match workflow `skills` keys). |
| `knowledge` | `string[]` | Specific knowledge entries (`<skill>.<knowledge-id>`). |
| `functions` | `string[]` | Specific Agent Functions (`<skill>.<function-id>`). |
| `tools` | `string[]` | Specific tools the agent may use. |
| `workflow_templates` | `string[]` | Workflow templates visible to the agent. |

**ReturnsDef fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status.values` | `string[]` | Allowed status values. |
| `status.required` | `boolean` | If `true`, the report must include a `status` field. |

**OnReturnAction fields (exactly one per status value):**

| Field | Type | Description |
|-------|------|-------------|
| `continue` | `"continue"` | Advance to the next step. |
| `retry_job` | `string` | Retry the named job. Optionally paired with `retry_with: map` to pass additional context. |
| `activate_job` | `string` | Activate the named optional job. |
| `goto_job` | `string` | Jump to the named job. |
| `goto_step` | `string` | Jump to the named step within the current job. Optionally paired with `goto_with: map` to pass additional context. |
| `fail` | `"fail"` | Mark the step as failed. |
| `block` | `"block"` | Block the run. |

#### Execution semantics

1. Engine prepares the step: writes `prompt.md` to the step artifact directory.
2. Context Builder assembles the agent context: inputs, exposed skills, artifact summaries, permissions, allowed signals, and output schema.
3. Prompt Builder renders the context as a Markdown prompt.
4. The external agent processes the prompt and writes `report.json` to the step artifact directory.
5. Engine calls `acceptAgentReport`, which processes the report in this fixed order:
   a. Parse and schema-validate `report.json`.
   b. Write `outputs` to `state.jobs[<jobId>].outputs`.
   c. `applyContextPatch` — process `context_patches` (variables and context blocks). Batch-atomic; any failure rolls back the entire batch.
   d. If `status` is present and the step declared `returns.status`: `applyStatusReturn` translates the status to an `on_return` action. This action takes priority over signals.
   e. Otherwise, if `signals` is non-empty: `handleSignals` validates and executes signal actions.
   f. Otherwise: `advanceJob` — advance to the next step (respecting `if:` conditions and `max_visits`).

#### Artifacts produced

| Artifact | Kind | Description |
|----------|------|-------------|
| `prompt.md` | `agent_prompt` | The rendered prompt given to the agent. |
| `output.md` | `agent_output` | Raw agent output (if captured). |
| `report.json` | `agent_report` | The structured agent report. |
| `agent.stdout.log` | `agent_stdout` | Agent subprocess stdout (v0.2). |
| `agent.stderr.log` | `agent_stderr` | Agent subprocess stderr (v0.2). |
| `agent.invocation.json` | `agent_invocation` | Backend invocation metadata (v0.2). |

#### Example

```yaml
- id: plan
  type: agent
  uses: agent://planner
  expose:
    skills:
      - code
      - project
  with:
    task: "${{ inputs.task }}"
    code_map: "${{ jobs.code-map.outputs.code_map }}"
  returns:
    status:
      values: [ready, blocked, needs_clarification]
      required: true
  on_return:
    ready: continue
    blocked: block
    needs_clarification:
      goto_step: gather-context
  outputs:
    plan: report.plan
    test_plan: report.test_plan
```

### 5.3 Script Step

**Type:** `script`
**Stability:** `stable`

A Script Step executes a deterministic shell command or a Skill Pack script. It does not invoke an LLM.

#### Fields

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `run` | `string` | `stable` | Conditional | Inline shell command. Required if `uses` is not set. |
| `uses` | `string` | `stable` | Conditional | Skill Pack script reference (`<skill>.scripts.<id>`). Required if `run` is not set. |
| `shell` | `string` | `stable` | No | Shell to use (e.g. `bash`, `powershell`). If omitted, the platform default applies. |
| `timeout` | `string` | `stable` | No | Duration string (e.g. `300s`, `5m`). |
| `cwd` | `string` | `stable` | No | Working directory for the command. |
| `env` | `map<string, string>` | `stable` | No | Environment variables. |
| `capture.stdout` | `boolean` | `planned` | No | Capture stdout as artifact. Not yet in schema or executor. |
| `capture.stderr` | `boolean` | `planned` | No | Capture stderr as artifact. Not yet in schema or executor. |

**Constraints:**
- Exactly one of `run` or `uses` must be specified.
- If `timeout` is omitted, a default timeout applies (600s).

#### Execution semantics

1. Engine resolves the command (inline `run` or Skill Pack script path).
2. Process Runner spawns the command with the configured `cwd`, `env`, and `timeout`.
3. On completion (or timeout), Engine writes `stdout.log`, `stderr.log`, and `result.json` to the step artifact directory.
4. Engine evaluates the result: maps outputs, checks `on_failure`, and advances or fails the job.

#### Artifacts produced

| Artifact | Kind | Description |
|----------|------|-------------|
| `stdout.log` | `stdout` | Captured standard output. |
| `stderr.log` | `stderr` | Captured standard error. |
| `result.json` | `script_result` | Structured result with `exit_code`, `timed_out`, timestamps, and artifact refs. |

#### Example

```yaml
- id: lint
  type: script
  run: "pnpm lint"
  shell: bash
  timeout: 300s
  outputs:
    exit_code: result.exit_code
    log: result.stdout
  on_failure:
    status: failed
```

### 5.4 Check Step

**Type:** `check`
**Stability:** `stable`

A Check Step evaluates a deterministic condition. It does not invoke an LLM. Checks are the primary gate mechanism: each check produces a pass/fail result that the Engine uses to decide whether to advance.

#### Fields

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `uses` | `string` | `stable` | Conditional | Skill Pack check reference (`<skill>.checks.<id>`). Required if not an inline check. |
| `kind` | `string` | `stable` | No | Override or specify the check kind. |
| `with` | `map<string, string>` | `stable` | No | Parameters for the check (e.g. file paths, expected schemas). |
| `on_pass` | `map` | `stable` | No | Action when the check passes. Default: `continue`. |
| `on_fail` | `map` | `stable` | No | Action when the check fails. |

**`on_pass` / `on_fail` actions (one of):**

| Field | Type | Description |
|-------|------|-------------|
| `continue` | `"continue"` | Advance to the next step. |
| `fail` | `"fail"` | Mark the step as failed. |
| `retry_job` | `string` | Retry the named job. |
| `status` | `failed` \| `blocked` | Set the step/job status. |

#### MVP check capabilities

| Kind | Description |
|------|-------------|
| `file-exists` | Assert a file or directory exists. |
| `json-valid` | Assert a file contains valid JSON. |
| `json-schema` | Assert a JSON file conforms to a JSON Schema. |
| `required-fields` | Assert specific fields exist and are non-empty. |
| `git-diff-exists` | Assert uncommitted changes exist. |
| `test-command` | Run a test command and assert exit code 0. |
| `forbidden-paths` | Assert no file matching forbidden patterns was modified. |
| `protected-files` | Assert no runtime state file was modified. |
| `read-only-violation` | Assert a read-only step did not modify the workspace. |

#### Execution semantics

1. Engine resolves the check definition (Skill Pack reference or inline kind).
2. Check Runner evaluates the condition against the current workspace and provided parameters.
3. Engine writes `check-result.json` to the step artifact directory.
4. Engine evaluates `on_pass` or `on_fail` and applies the corresponding action.

#### Artifacts produced

| Artifact | Kind | Description |
|----------|------|-------------|
| `check-result.json` | `check_result` | Structured result with `passed`, `check_id`, `failures[]`, and artifact refs. |

#### Example

```yaml
- id: check-diff
  type: check
  uses: code.checks.forbidden-paths
  with:
    changed_files: "${{ steps.collect-diff.outputs.changed_files }}"
  on_pass: continue
  on_fail:
    status: failed
```

### 5.5 Router Step

**Type:** `router`
**Stability:** `stable`

A Router Step evaluates a value and branches to a flow-control action. It does not invoke an LLM and does not execute arbitrary expressions. Router steps are the only mechanism for conditional branching within a job.

#### Fields

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `switch` | `string` | `stable` | Yes | A `${{ }}` expression that resolves to a string value. |
| `cases` | `map<string, RouterAction>` | `stable` | Yes | Map of switch values to actions. Must include a `default` case. |

**RouterAction (exactly one action per case):**

| Action | Type | Description | Stability |
|--------|------|-------------|-----------|
| `continue` | `"continue"` | Advance to the next step. | `stable` |
| `fail` | `"fail"` | Mark the step as failed. | `stable` |
| `block` | `"block"` | Block the run. | `stable` |
| `retry_job` | `string` | Retry the named job. Optionally paired with `retry_with: map` to pass additional context. | `stable` |
| `activate_job` | `string` | Activate the named optional job. | `stable` |
| `goto_job` | `string` | Jump to the named job. | `stable` |
| `goto_step` | `string` | v0.2: Jump to the named step within the current job. Optionally paired with `goto_with: map` to pass additional context. | `experimental` |
| `status` | `failed` \| `blocked` | Set the job/run status. | `stable` |

#### Execution semantics

1. Engine resolves the `switch` expression against the current run state.
2. Engine matches the resolved value against the `cases` keys.
3. If no key matches, the `default` case is used.
4. Engine executes the selected action and writes a `router_decided` event.

**`goto_step` constraints:**
- The target step must exist in the same job. Cross-job jumps use `goto_job`.
- When triggered, a `step_revisited` event is written, the target step's state resets to `pending`, and its visit count increments by 1.
- The visit count is checked against the target step's `max_visits`. Exceeding `max_visits` blocks the step.

#### Artifacts produced

| Artifact | Kind | Description |
|----------|------|-------------|
| `router-decision.json` | `router_decision` | The evaluated switch value, matched case, and selected action. |

#### Example

```yaml
- id: route-review
  type: router
  switch: "${{ steps.review.outputs.decision }}"
  cases:
    approved: continue
    rejected:
      retry_job: implement
      retry_with:
        review_comments: "${{ steps.review.outputs.comments }}"
    needs_architecture_design:
      activate_job: architecture-design
    default:
      status: failed
```

### 5.6 Human Gate Step

**Type:** `human`
**Stability:** `experimental`

A Human Gate Step pauses the workflow and waits for explicit human input (approve, reject, or provide additional information). The current runtime recognises this step type but the full human-gate interaction loop is planned for a future release.

#### Fields

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `prompt` | `string` | `experimental` | Yes | Description of what the human needs to decide. |
| `approvers` | `string[]` | `experimental` | Yes | List of user/role identifiers authorised to respond. |
| `instructions` | `string` | `experimental` | No | Additional instructions for the approver. |
| `timeout_minutes` | `number` | `experimental` | No | Maximum wait time in minutes before the gate auto-resolves. |

The following fields are **planned** for a future release and are not yet in the schema or executor: `timeout`, `on_approve`, `on_reject`, `on_timeout`.

#### Execution semantics (planned)

1. Engine sets the step status to `awaiting_human` and writes a `human_gate_waiting` event.
2. The runtime blocks until human input is received (via CLI or future UI).
3. On input, Engine writes a `human_decision` event and executes the corresponding action.

#### Artifacts produced (planned)

| Artifact | Kind | Description |
|----------|------|-------------|
| `human-decision.json` | `human_decision_record` | The decision, rationale, and timestamp. |

#### Example

```yaml
- id: approve-deploy
  type: human
  prompt: "Review the implementation summary. Approve to proceed with the change?"
  approvers:
    - lead-reviewer
  instructions: "Check that all tests pass and the diff is reasonable."
  timeout_minutes: 1440
```

### 5.7 Workflow Step (reserved)

**Type:** `workflow`
**Stability:** `reserved`

The `workflow` step type is reserved for future nested workflow execution. It is recognised by the schema validator but **must not be executed by the current runtime**.

#### Fields

No fields are defined for this step type. Any fields present in a `workflow` step definition are ignored by the current runtime. Implementations must not read, interpret, or act on any field within a `workflow` step.

#### Execution semantics

- The validator accepts `type: workflow` as a legal step type (no validation error).
- At runtime, if the Engine encounters a `workflow` step, it must skip the step and emit a warning.
- No prompt is generated, no subprocess is spawned, and no state transition occurs beyond the skip.

#### Rationale

Nested workflow execution requires sub-workflow state management, input/output contracts, and recursive run directories. These capabilities are planned for a future release. Reserving the type now ensures forward compatibility of workflow definitions without breaking existing schemas.

---

## 6. Expression Syntax

Zigma Flow supports a restricted `${{ }}` expression syntax for referencing values within workflow definitions. The expression resolver operates in two layers:

1. **Static layer (schema validation):** Rejects expressions containing forbidden syntax before runtime.
2. **Evaluation layer (runtime):** Resolves allowed references against the current run state.

### 6.1 Variable references

The following reference namespaces are available in `${{ }}` expressions.

| Namespace | Syntax | Description | Stability | Version |
|-----------|--------|-------------|-----------|---------|
| Inputs | `${{ inputs.<name> }}` | User-provided trigger input. | `stable` | v0.1 |
| Run | `${{ run.id }}` | The current run identifier. | `stable` | v0.1 |
| Run | `${{ run.workflow }}` | The workflow name from the workflow definition. | `stable` | v0.1 |
| Job outputs | `${{ jobs.<id>.outputs.<key> }}` | Output from a completed job. | `stable` | v0.1 |
| Step outputs | `${{ steps.<id>.outputs.<key> }}` | Output from a step in the same job. | `stable` | v0.2 |
| Retry inputs | `${{ retry.inputs.<key> }}` | Additional inputs passed during retry. | `stable` | v0.1 |
| Signals | `${{ signals.<name> }}` | Current signal state (boolean). Not yet implemented in the expression resolver. | `reserved` | v0.1 |
| Signal detail | `${{ signals.<name>.reason }}` | Reason string from a signal. Not yet implemented in the expression resolver. | `reserved` | v0.1 |
| Variables | `${{ variables.<name> }}` | Current value of a workflow variable. | `experimental` | v0.2 |
| Context blocks | `${{ context.<block>.<key> }}` | Context block content is injected into agent prompts via Context Builder, not via `${{ }}` expression substitution. | `reserved` | v0.2 |

### 6.2 Context block references

The `context` namespace is **reserved** for future use. Context block content is injected into agent prompts via the Context Builder, not via `${{ }}` expression substitution. The following references are recognised by the parser but not yet resolved at runtime:

| Syntax | Description | Status |
|--------|-------------|--------|
| `${{ context.<block>.version }}` | Current version number. | `reserved` |
| `${{ context.<block>.artifact }}` | Artifact URI of the current version. | `reserved` |

Access to context block content is gated by `step.permissions.context_blocks.read`. The Context Builder injects the content into the agent prompt rather than making it available as an inline expression value.

### 6.3 Conditional expressions

The `if:` field on steps and switch expressions in routers support a restricted set of operators for combining references:

**Allowed operators:**

| Operator | Meaning |
|----------|---------|
| `==` | Equality |
| `!=` | Inequality |
| `&&` | Logical AND |
| `\|\|` | Logical OR |
| `!` | Logical NOT |
| `( ... )` | Grouping parentheses |

**Reference depth limit:** Object property access is limited to a maximum depth of 3 (e.g. `${{ jobs.foo.outputs.bar }}` is depth 3). Deeper access is rejected at validation time.

**Examples of legal conditional expressions:**
```yaml
if: "${{ variables.plan_status == 'ready' }}"
if: "${{ steps.review.outputs.decision == 'approved' && variables.iteration_count != 3 }}"
if: "${{ variables.plan_status == 'blocked' }}"
```

### 6.4 Forbidden constructs

The following constructs are **explicitly forbidden** in `${{ }}` expressions. Any expression containing them must be rejected at validation time.

| Forbidden construct | Example of illegal syntax |
|---------------------|---------------------------|
| Function calls | `${{ len(inputs.task) }}` |
| Arithmetic operators (`+`, `-`, `*`, `/`, `%`) | `${{ variables.count + 1 }}` |
| String concatenation | `${{ inputs.a + inputs.b }}` |
| Method calls | `${{ inputs.list.join(',') }}` |
| Array/object literals | `${{ [1, 2, 3] }}` |
| JavaScript evaluation | `${{ eval('...') }}` |
| Ternary operator | `${{ x ? y : z }}` |
| Object property depth > 3 | `${{ jobs.a.outputs.b.c.d }}` |
| Template literals / string interpolation | `` ${{ `hello ${name}` }} `` |

---

## 7. What the Workflow DSL Is NOT

This section mirrors the architecture's "Rejected methods" rationale and the PRD's "Non-Goals." It defines the boundaries of the language by stating what it explicitly refuses to become.

### 7.1 NOT a general-purpose programming language

The DSL has no `while` loops, no `for` iteration, no variable assignment (in the imperative sense), no function definitions, and no arbitrary script evaluation. Control flow is limited to the router actions listed in [§5.5](#55-router-step). The only looping construct is `goto_step` with a `max_visits` hard limit — a bounded safety valve, not a general loop primitive.

### 7.2 NOT a YAML-based scripting runtime

Workflow definitions are immutable during a run. There is no runtime YAML patch, no dynamic job insertion, and no self-modifying workflow. The `variables` and `context_blocks` data layer allows state to evolve during a run, but these write to `state.json` — they never modify the workflow YAML itself.

### 7.3 NOT an expression language

`${{ }}` expressions are reference lookups, not an expression evaluator. They resolve named values from a fixed set of namespaces. They do not support arithmetic, string manipulation, type coercion, or function application. See [§6.4](#64-forbidden-constructs) for the complete list of forbidden constructs.

### 7.4 NOT a state-machine bypass

Steps submit structured results (reports, script results, check results). The Engine — and only the Engine — decides what state transition occurs. Agents cannot write `state.json` directly. They cannot set `job.status`, `run.status`, or `step.current_step`. Even `context_patches` are processed through the Engine's `applyContextPatch` entry point with dual permission checks and batch atomicity.

### 7.5 NOT a Skill Pack

The Workflow DSL orchestrates. Skill Packs provide capabilities. A workflow file must not embed large knowledge bases, prompt templates, or tool definitions. Those belong in Skill Packs. Conversely, a Skill Pack manifest must not declare signals, job dependencies, or state transitions.

### 7.6 NOT a concurrent agent dispatcher

While the runtime supports parallel execution of read-only jobs, the DSL itself does not contain concurrency primitives (no `parallel`, `fork`, `join`, or `barrier` keywords). Concurrency is derived from the DAG: jobs whose `needs` are all met are eligible to run in parallel, subject to the Engine's scheduler.

### 7.7 NOT a workflow template engine

The DSL does not support macros, includes, inheritance, or parameterised sub-workflows. Each workflow file is self-contained. The reserved `workflow` step type will eventually enable sub-workflow invocation, but that is a runtime composition mechanism, not a templating feature.

---

## 8. Validation Rules

The following rules are enforced by the workflow validator. Any violation produces a `ValidationError` with a field-level message.

### Structural rules

| # | Rule |
|---|------|
| V01 | `name` and `version` must be present and non-empty. |
| V02 | Job IDs must be unique within the workflow. |
| V03 | Step IDs must be unique within their job. |
| V04 | `needs` and `optional_needs` must reference existing job IDs. |
| V05 | The job DAG must not contain a cycle. |
| V06 | `optional_needs` must reference a job declared with `activation: optional` or `activation: manual` (warning, not error). |
| V07 | At least one job must be present. |
| V08 | Each job must contain at least one step. |

### Type rules

| # | Rule |
|---|------|
| V09 | `step.type` must be one of `agent`, `script`, `check`, `router`, `human`, `workflow`. |
| V10 | Agent Step `expose.skills` must reference keys declared in the workflow `skills` map. |
| V11 | Script Step must specify exactly one of `run` or `uses`. |
| V12 | Router Step must declare `switch` and `cases` with a `default` key. |
| V13 | Router actions must be one of: `continue`, `fail`, `block`, `retry_job`, `activate_job`, `goto_job`, `goto_step`, `status`. |

### Signal rules

| # | Rule |
|---|------|
| V14 | Every signal type emitted by an agent must be declared in the workflow `signals` map. |
| V15 | A signal's `allowed_from` list must contain valid job IDs. |
| V16 | A signal emitted from a job not in `allowed_from` must be rejected at runtime (validation passes; runtime rejects). |

### Expression rules (v0.2)

| # | Rule |
|---|------|
| V17 | `${{ }}` expressions must not contain forbidden constructs (see [§6.4](#64-forbidden-constructs)). |
| V18 | Object property access depth must not exceed 3. |
| V19 | `step.if` must be a syntactically valid conditional expression or omitted. |
| V20 | `step.returns.status.values` must be a non-empty array if `returns.status` is declared. |
| V21 | `step.on_return` keys must be a subset of `step.returns.status.values`. |

### Permission rules (v0.2)

| # | Rule |
|---|------|
| V22 | `permissions.variables.write` entries must each appear in the corresponding `variables.<name>.allowed_writers`. |
| V23 | `permissions.context_blocks.write` entries must each appear in the corresponding `context_blocks.<id>.allowed_writers`. |
| V24 | `variables.<name>.allowed_writers` entries must reference existing job-step pairs (`<job>.<step>` or `<job>.*`). |
| V25 | `context_blocks.<id>.allowed_writers` entries must reference existing job-step pairs. |

### Goto rules (v0.2)

| # | Rule |
|---|------|
| V26 | `router.goto_step` target must exist in the same job. |
| V27 | `step.max_visits` must be a positive integer. Default 3. |

### Reserved type rule

| # | Rule |
|---|------|
| V28 | `type: workflow` passes validation but produces a warning. The runtime must not execute it. |

---

## 9. Appendix: Full Example

The following is a complete, validated workflow definition demonstrating most stable fields.

```yaml
name: code-change
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
    severity: medium
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
          task: "${{ inputs.task }}"
        outputs:
          task_summary: {}
          scope: {}
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
          task: "${{ inputs.task }}"
        outputs:
          files: {}
          modules: {}
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
          task: "${{ inputs.task }}"
        outputs:
          plan_summary: {}
          steps: {}
        expose:
          skills:
            - code

  architecture-design:
    activation: optional
    needs:
      - plan
    workspace:
      mode: read-only
    steps:
      - id: design
        type: agent
        with:
          task: "${{ inputs.task }}"
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
          task: "${{ inputs.task }}"
        outputs:
          summary: {}
          files_changed: {}
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
        run: "pnpm typecheck && pnpm lint"
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
          task: "${{ inputs.task }}"
        outputs:
          verdict: {}
          issues: {}
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
          task: "${{ inputs.task }}"
        outputs:
          final_summary: {}
          remaining_risks: {}
        expose:
          skills:
            - code
```

---

## Document Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-07-03 | 0.3.0 | Initial published language specification. Covers all top-level fields, all 5 step types, reserved `workflow` type, expression syntax, forbidden constructs, and validation rules. |
