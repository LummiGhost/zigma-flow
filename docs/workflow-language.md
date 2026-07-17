# Zigma Flow Workflow Language Specification

Version: 0.7.0 (published 2026-07-17)
Status: Published

## 1. Introduction

The Zigma Flow Workflow Language is a declarative YAML DSL for defining agent workflow runs. A workflow file describes the structure, dependencies, state transitions, parallelism, retry behaviour, and failure handling of a multi-step agent-assisted process.

This specification defines every legal field, type, constraint, and execution semantic. It is the single source of truth for what the Zigma Flow runtime accepts. Any field, value, or construct not described in this document is illegal and must be rejected at validation time.

### 1.1 Core design principles

- **Engine is the only state-machine owner.** Steps submit results; the Engine decides what happens next.
- **The DSL is not a general-purpose programming language.** There is no `while`, `for`, arbitrary expression evaluation, or runtime YAML mutation.
- **Skill Packs are capability packages, not workflow steps.** They expose knowledge, prompts, tools, scripts, and checks but never own workflow state.
- **All state changes are auditable.** Every transition produces a structured event in the event log.
- **Execution is forward-only.** The Engine never mutates completed state backward. Retry and re-execution always produce new immutable records (Attempts and Iterations), never overwrite history.

### 1.2 Stability labels

Each field carries one of three stability labels:

| Label | Meaning |
|-------|---------|
| `stable` | Fully supported; will not change in a breaking way within v0.x. |
| `experimental` | Supported but the schema, semantics, or both may change in a future minor release. |
| `reserved` | Recognised by the parser but not executed by the current runtime. Using a reserved field or type produces a validation warning; its content must not affect run behaviour. |

> **Note on experimental fields:** Fields marked as `experimental` may change or be removed in any minor version release without a deprecation period. Avoid depending on experimental field behavior in production workflows.

### 1.3 v0.7 deprecation notice

The following fields are **deprecated** in v0.7 and internally translated to the new Execution Model (Attempt, Job Group Iteration, failure_policy). They continue to work but will be removed in v1.0:

| Deprecated field | v0.7 replacement | Translation |
|------------------|------------------|-------------|
| `retry_job` (router/signal action) | `retry` with `when` conditions | Router `retry_job` triggers a new Attempt via the Attempt model |
| `goto_step` (router action) | `repeat` block in job group | `goto_step` creates an implicit Job Group Iteration |
| `goto_job` (router action) | `repeat` block in job group | `goto_job` creates an implicit Job Group Iteration |
| `max_visits` (step field) | `repeat.max_iterations` | `max_visits` translated to iteration cap on implicit group |
| `on_failure` (object form with `retry_job`) | `failure_policy` + `retry.when` | Object-form `on_failure` normalised to `failure_policy` |
| `retry_with` (router action) | `retry.when` conditions | Retry inputs passed via Attempt context |

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
   - [job_groups](#310-job_groups)
4. [Job Fields](#4-job-fields)
   - [needs](#41-needs)
   - [optional_needs](#42-optional_needs)
   - [activation](#43-activation)
   - [retry](#44-retry)
   - [permissions (job-level)](#45-permissions-job-level)
   - [workspace](#46-workspace)
   - [steps](#47-steps)
   - [group](#48-group)
   - [concurrency](#49-concurrency)
   - [failure_policy](#410-failure_policy)
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
   - [Status functions](#64-status-functions)
   - [Forbidden constructs](#65-forbidden-constructs)
7. [What the Workflow DSL Is NOT](#7-what-the-workflow-dsl-is-not)
8. [Validation Rules](#8-validation-rules)
9. [Abstract Data Layer](#9-abstract-data-layer)
   - [9.1 Variables (§3.7)](#91-variables-37)
   - [9.2 Context Blocks (§3.8)](#92-context-blocks-38)
10. [Agent Report: context_patches](#10-agent-report-context_patches)
   - [10.1 Patch schema](#101-patch-schema)
   - [10.2 Permissions model](#102-permissions-model)
   - [10.3 Batch atomicity](#103-batch-atomicity)
   - [10.4 Reserved fields](#104-reserved-fields)
   - [10.5 Rollback semantics](#105-rollback-semantics)
11. [Appendix: Full Example](#11-appendix-full-example)

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
| `variables.read` | `string[]` | `experimental ⚠` | v0.2: whitelist of variable names this step may read. |
| `variables.write` | `string[]` | `experimental ⚠` | v0.2: whitelist of variable names this step may write via `context_patches`. |
| `context_edit` | `none` \| `read` \| `write` | `experimental ⚠` | v0.2: whether `context_patches` in the agent report are accepted. |
| `context_blocks.read` | `string[]` | `experimental ⚠` | v0.2: whitelist of context block IDs this step may read. |
| `context_blocks.write` | `string[]` | `experimental ⚠` | v0.2: whitelist of context block IDs this step may write via `context_patches`. |

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

> ⚠ Experimental fields may change in any minor version release.

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
| Stability | `experimental ⚠` |
| Required | No |

v0.2: Workflow-scoped variables that serve as a data layer separate from the state machine. Variables can be read by steps (via `${{ variables.<name> }}`) and written by agents (via `report.context_patches`), but only through Engine-validated entries.

**VariableDef fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `type` | `string` \| `number` \| `boolean` \| `array` \| `object` | `experimental ⚠` | Yes | The variable's type. |
| `initial` | `any` | `experimental ⚠` | Yes | Initial value set at run creation. |
| `enum` | `string[]` | `experimental ⚠` | No | Allowed values (only for `type: string`). |
| `allowed_writers` | `string[]` | `experimental ⚠` | Yes | Job-step references (`<job>.<step>` or `<job>.*`) permitted to write this variable. |

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

> ⚠ Experimental fields may change in any minor version release.

### 3.8 `context_blocks`

| Attribute | Value |
|-----------|-------|
| Type | `map<string, ContextBlockDef>` |
| Stability | `experimental ⚠` |
| Required | No |

v0.2: Named, versioned text blocks that agents can read and write through Engine-validated patches. Each block is stored as a versioned artifact under `runs/<runId>/context-blocks/<id>/v<N>.md`.

**ContextBlockDef fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `initial_artifact` | `string` \| `null` | `experimental ⚠` | No | Path to an initial artifact; `null` means empty at creation. |
| `allowed_writers` | `string[]` | `experimental ⚠` | Yes | Job-step references permitted to write this block. |

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

> ⚠ Experimental fields may change in any minor version release.

### 3.9 `jobs`

| Attribute | Value |
|-----------|-------|
| Type | `map<string, JobDef>` |
| Stability | `stable` |
| Required | Yes |

The set of jobs that make up the workflow. Each job is a named group of steps with its own dependencies, permissions, workspace mode, retry policy, and optional group membership. The job keys form the nodes of the workflow DAG.

See [§4 Job Fields](#4-job-fields) for the full job definition.

**Constraints:**
- At least one job must be declared.
- Job IDs must be unique within the workflow.
- Job IDs must be valid identifiers: lowercase letters, digits, and hyphens (`[a-z0-9-]+`).
- A job's `group` field, if set, must reference a key in the top-level `job_groups` map.

### 3.10 `job_groups`

| Attribute | Value |
|-----------|-------|
| Type | `map<string, JobGroupDef>` |
| Stability | `stable` |
| Required | No |
| Version | v0.7 |

Declares job groups that enable iteration-based re-execution. A job group collects one or more jobs into a unit that can repeat as a whole. Each iteration runs all jobs in the group to completion before the next iteration begins.

**JobGroupDef fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `needs` | `string[]` | `stable` | No | Other job groups that must complete before this group starts. Translates to first-iteration job readiness. |
| `repeat` | `RepeatConfig` | `stable` | No | Iteration configuration. When omitted, the group executes exactly once. |

**RepeatConfig fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `max_iterations` | `integer` | `stable` | Yes | Maximum number of iterations (inclusive upper bound). |
| `until` | `string` | `stable` | No | A `${{ }}` expression evaluated after each iteration. When it resolves to `true`, iteration stops early. Must not reference forbidden constructs (see [§6.5](#65-forbidden-constructs)). |

**Constraints:**
- `max_iterations` must be a positive integer.
- `until` is evaluated after all jobs in the iteration reach a terminal status.
- Iterations are sequential: iteration N+1 starts only after iteration N fully completes.
- `repeat` on a singleton job group replaces `max_visits` on individual steps.
- `needs` between groups must not create a cycle (DAG level).

**Example:**
```yaml
job_groups:
  implement-review:
    needs:
      - intake-plan
    repeat:
      max_iterations: 3
      until: "${{ success() }}"
```

**Iteration data access:**

Within a job group iteration, steps may reference outputs from the previous iteration using the `iteration.previous` namespace:

```
${{ iteration.previous.jobs.<id>.outputs.<key> }}
```

This path has a maximum depth of 4 (one more than the standard depth limit of 3) to accommodate the extra `iteration.previous` prefix.

**Backward compatibility:**
- Jobs without a `group` field that use `goto_step` or `goto_job` are automatically wrapped in an implicit job group at runtime. The implicit group has a `max_iterations` derived from the step's `max_visits`.
- This internal translation is transparent to workflow authors; existing v0.6 workflows continue to work without modification.

**Example (full group with repeat):**
```yaml
job_groups:
  code-review-loop:
    repeat:
      max_iterations: 3
      until: "${{ success() }}"

jobs:
  implement:
    group: code-review-loop
    steps:
      - id: edit
        type: agent
        # ...
  review:
    group: code-review-loop
    needs:
      - implement
    steps:
      - id: review
        type: agent
        # ...
```

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
| Version | v0.1 (updated v0.7) |

Configures automatic retry behaviour for the job when a step failure occurs or when a router triggers retry.

**Retry fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `max_attempts` | `integer` | `stable` | Yes | Maximum number of execution attempts. |
| `when` | `string[]` | `stable` | No | v0.7: Whitelist of `FailureKind` values that trigger retry. When omitted, defaults to transient failures only: `["timeout", "infrastructure_error", "agent_error"]`. |
| `on_exceeded` | `map` | `stable` | Yes | Action when `max_attempts` is reached. |

**`on_exceeded` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | `blocked` \| `failed` | The job status after exceeding max attempts. |

**`when` — FailureKind values (v0.7):**

The `when` array accepts any of the following well-known failure kinds, plus extension values:

| Value | Description |
|-------|-------------|
| `timeout` | The step or agent backend exceeded its configured timeout. |
| `infrastructure_error` | A system-level failure (network, filesystem, subprocess crash). |
| `invalid_output` | The agent produced a report that failed schema validation. |
| `agent_error` | The agent backend returned a non-zero exit code. |
| `cancelled` | The step was cancelled (SIGINT, AbortSignal, or fail-fast abort). |
| `permission_denied` | The agent attempted an operation it lacks permission for. |
| `config_error` | The step or backend configuration is invalid (e.g. missing command). |

Additional string values are accepted via the extension slot for forward compatibility.

**Constraints:**
- `max_attempts` must be a positive integer.
- Each attempt produces a separate artifact directory (`attempts/<N>/`).
- Retry does not delete or overwrite historical attempts.
- `when` values not in the well-known list produce a validation warning but are accepted.
- Config errors (`config_error`) and permission errors (`permission_denied`) default to **not** retrying (excluded from the default `when`).

**Example:**
```yaml
retry:
  max_attempts: 3
  when:
    - timeout
    - infrastructure_error
    - agent_error
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
| `branch` | `string` | `experimental ⚠` | No | Git branch name pattern for isolated writable work (future). |

**Constraints:**
- `read-only` jobs must not modify the working directory. The Workspace Guard detects and rejects modifications.
- At most one `writable` job may be running at any time.
- `read-only` jobs may run concurrently (up to the configured `parallelism` limit).

**Example:**
```yaml
workspace:
  mode: read-only
```

> ⚠ Experimental fields may change in any minor version release.

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
- Steps execute in the order listed, subject to `if:` conditions.

### 4.8 `group`

| Attribute | Value |
|-----------|-------|
| Type | `string` |
| Stability | `stable` |
| Required | No |
| Version | v0.7 |

Assigns this job to a Job Group declared in the top-level [`job_groups`](#310-job_groups) map. Jobs in the same group execute together within each iteration.

**Constraints:**
- The value must match a key in the top-level `job_groups` map.
- Jobs without a `group` field execute exactly once (single-iteration, no repeat).
- `group` is incompatible with `goto_step` and `goto_job` router actions (validation error).

**Example:**
```yaml
group: code-review-loop
```

### 4.9 `concurrency`

| Attribute | Value |
|-----------|-------|
| Type | `map` |
| Stability | `stable` |
| Required | No |
| Version | v0.7 |

Controls concurrency behaviour for this job within a concurrency group. Concurrency groups prevent conflicting jobs from running simultaneously.

**Concurrency fields:**

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `group` | `string` | `stable` | Yes | Concurrency group key (static string). Jobs with the same key share the concurrency slot. |
| `policy` | `allow` \| `queue` \| `cancel_previous` \| `reject` | `stable` | Yes | Behaviour when another job in the same group is already running. |

**Policy behaviours:**

| Policy | Behaviour |
|--------|-----------|
| `allow` | Run immediately. Multiple jobs in the same group may run concurrently. |
| `queue` | Wait until the currently-running job in the group completes. The scheduler will not start this job until the slot is free. |
| `cancel_previous` | Cancel the currently-running job in the group and start this one. The interrupted job enters `cancelled` status with a `failure_kind` of `cancelled`. |
| `reject` | Fail immediately. The job transitions to `failed` without executing. A `job_rejected` event is written. |

**Constraints:**
- `cancel_previous` only cancels currently-running jobs in the same group; completed jobs are not affected.
- `cancel_previous` and `reject` are enforced in a **pre-scheduler mutation step** (state changes before the scheduler selects jobs).
- `queue` and `allow` are enforced in the **scheduler** (pure filter function, no state mutation).

**Example:**
```yaml
concurrency:
  group: writable-jobs
  policy: queue
```

### 4.10 `failure_policy`

| Attribute | Value |
|-----------|-------|
| Type | `fail` \| `continue` \| `block` |
| Stability | `stable` |
| Required | No |
| Default | `fail` |
| Version | v0.7 |

Controls how the Engine handles job failure within a Job Group iteration.

| Policy | Behaviour |
|--------|-----------|
| `fail` (default) | The job failure propagates up. The current iteration fails and no further iterations are started. |
| `continue` | The failed job is marked `failed` but the iteration continues through remaining jobs. DAG dependents of the failed job are correctly blocked. The job's conclusion is `success_with_warnings` if the iteration otherwise succeeds. |
| `block` | The job and its iteration are blocked immediately. A `job_blocked` event is written. |

**Cascade (v0.7):**

Failure policies cascade hierarchically: **job → iteration → run**. Each level can contain or escalate the failure:

- A job with `failure_policy: fail` causes the iteration to evaluate its own failure handling.
- An iteration where all jobs complete (possibly with `continue` on some) evaluates the `repeat` block's `until` condition.
- A run composed of multiple groups/iterations completes with the most severe conclusion across all iterations.

**Backward compatibility:**

The v0.6 `on_failure` object form (`on_failure: { status: failed }` or `on_failure: { status: blocked }`) is internally normalised to the equivalent `failure_policy` value. Workflow authors should migrate to `failure_policy` for new workflows.

**Example:**
```yaml
failure_policy: continue
```

---

## 5. Step Reference

### 5.1 Common step fields

Every step, regardless of type, supports the following fields.

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `id` | `string` | `stable` | Yes | Unique identifier within the job. |
| `type` | `agent` \| `script` \| `check` \| `router` \| `human` \| `workflow` | `stable` | Yes | The step type. |
| `if` | `string` | `experimental ⚠` | No | v0.2: A conditional expression. When it evaluates to `false`, the step is skipped (`step_skipped` event). |
| `max_visits` | `integer` | `deprecated` | No | **Deprecated in v0.7.** Internally translated to `repeat.max_iterations` on an implicit job group. Use `repeat` blocks in `job_groups` instead. Will be removed in v1.0. |
| `on_failure` | `fail` \| `map` | `stable` | No | Action when the step fails. The shorthand `fail` or `block` string form is stable. The object form `{ status: ... }` is **deprecated in v0.7** — use job-level [`failure_policy`](#410-failure_policy) instead. |
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

> ⚠ Experimental fields may change in any minor version release.

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
| `returns` | `ReturnsDef` | `experimental ⚠` | No | v0.2: Declares a structured status return with allowed values and corresponding actions. |
| `on_return` | `map<string, OnReturnAction>` | `experimental ⚠` | No | v0.2: Maps each allowed `returns.status.values` entry to an Engine action. |

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
| `retry_job` | `string` | **Deprecated in v0.7.** Retry the named job. Internally translated to an Attempt. Use job-level `retry.when` instead. |
| `activate_job` | `string` | Activate the named optional job. |
| `goto_job` | `string` | **Deprecated in v0.7.** Jump to the named job. Internally translated to an implicit Job Group Iteration. |
| `goto_step` | `string` | **Deprecated in v0.7.** Jump to the named step within the current job. Internally translated to an implicit Job Group Iteration. |
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

> ⚠ Experimental fields may change in any minor version release.

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
| `retry_job` | `string` | **Deprecated in v0.7.** Retry the named job. Internally translated to an Attempt via the Attempt model. Use job-level `retry.when` instead. | `deprecated` |
| `activate_job` | `string` | Activate the named optional job. | `stable` |
| `goto_job` | `string` | **Deprecated in v0.7.** Jump to the named job. Internally translated to an implicit Job Group Iteration. Use `repeat` blocks in `job_groups` instead. | `deprecated` |
| `goto_step` | `string` | **Deprecated in v0.7.** Jump to the named step within the current job. Internally translated to an implicit Job Group Iteration. Use `repeat` blocks in `job_groups` instead. | `deprecated` |
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

> ⚠ Experimental fields may change in any minor version release.

### 5.6 Human Gate Step

**Type:** `human`
**Stability:** `experimental ⚠`

A Human Gate Step pauses the workflow and waits for explicit human input (approve, reject, or provide additional information). The current runtime recognises this step type but the full human-gate interaction loop is planned for a future release.

#### Fields

| Field | Type | Stability | Required | Description |
|-------|------|-----------|----------|-------------|
| `prompt` | `string` | `experimental ⚠` | Yes | Description of what the human needs to decide. |
| `approvers` | `string[]` | `experimental ⚠` | Yes | List of user/role identifiers authorised to respond. |
| `instructions` | `string` | `experimental ⚠` | No | Additional instructions for the approver. |
| `timeout_minutes` | `number` | `experimental ⚠` | No | Maximum wait time in minutes before the gate auto-resolves. |

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

> ⚠ Experimental fields may change in any minor version release.

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
| Job status | `${{ jobs.<id>.status }}` | Current status of a job (`pending`, `ready`, `running`, `completed`, `failed`, `blocked`, `cancelled`). | `stable` | v0.7 |
| Job attempt | `${{ jobs.<id>.attempt }}` | Current attempt number for the job (integer). | `stable` | v0.7 |
| Step outputs | `${{ steps.<id>.outputs.<key> }}` | Output from a step in the same job. | `stable` | v0.2 |
| Step status | `${{ steps.<id>.status }}` | Current status of a step in the same job. | `stable` | v0.7 |
| Step attempt | `${{ steps.<id>.attempt }}` | Attempt number during which this step executed. | `stable` | v0.7 |
| Invocation | `${{ invocation.trigger }}` | How the run was triggered: `"manual"`, `"scheduled"`, or `"resume"`. | `stable` | v0.7 |
| Invocation | `${{ invocation.backend }}` | The agent backend name (e.g. `"claude-code"`). | `stable` | v0.7 |
| Attempt | `${{ attempt.number }}` | The current attempt number (integer, starting at 1). | `stable` | v0.7 |
| Attempt | `${{ attempt.trigger }}` | What triggered this attempt: `"initial"` or `"retry"`. | `stable` | v0.7 |
| Attempt | `${{ attempt.previous_outcome }}` | The outcome of the previous attempt (`"success"`, `"failure"`, `"cancelled"`). `undefined` on attempt 1. | `stable` | v0.7 |
| Iteration | `${{ iteration.previous.jobs.<id>.outputs.<key> }}` | Outputs from a job in the previous iteration. `undefined` on iteration 1. Maximum depth 4. | `stable` | v0.7 |
| Retry inputs | `${{ retry.inputs.<key> }}` | Additional inputs passed during retry. | `deprecated` | v0.1 |
| Signals | `${{ signals.<name> }}` | Current signal state (boolean). Not yet implemented in the expression resolver. | `reserved` | v0.1 |
| Signal detail | `${{ signals.<name>.reason }}` | Reason string from a signal. Not yet implemented in the expression resolver. | `reserved` | v0.1 |
| Variables | `${{ variables.<name> }}` | Current value of a workflow variable. | `deprecated` | v0.2 |
| Context blocks | `${{ context.<block>.<key> }}` | Context block content is injected into agent prompts via Context Builder, not via `${{ }}` expression substitution. | `reserved` | v0.2 |

> ⚠ Experimental fields may change in any minor version release.

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

**Reference depth limit:** Object property access is limited to a maximum depth of 3 (e.g. `${{ jobs.foo.outputs.bar }}` is depth 3). The `iteration.previous.jobs.<id>.outputs.<key>` path has a relaxed limit of depth 4 to accommodate the extra `iteration.previous` prefix. All other paths exceeding depth 3 are rejected at validation time.

**Examples of legal conditional expressions:**
```yaml
if: "${{ variables.plan_status == 'ready' }}"
if: "${{ steps.review.outputs.decision == 'approved' && variables.iteration_count != 3 }}"
if: "${{ variables.plan_status == 'blocked' }}"
if: "${{ iteration.previous.jobs.implement.outputs.summary != '' }}"
if: "${{ attempt.previous_outcome == 'failure' }}"
```

### 6.4 Status functions

v0.7 introduces four **status functions** that provide context-dependent evaluation in `if:` conditions (step-level) and `when:` conditions (retry policy). These are not general function calls; they are resolved via pre-resolution before tokenization — the function name is replaced with a boolean literal (`true` or `false`) based on the current run state.

| Function | Scope | Meaning in step `if:` | Meaning in retry `when:` |
|----------|-------|-----------------------|--------------------------|
| `success()` | `step-if` / `retry-when` | All prior steps in the current job completed successfully. | The previous Attempt succeeded. |
| `failure()` | `step-if` / `retry-when` | At least one prior step in the current job failed. | The previous Attempt failed. |
| `always()` | `step-if` / `retry-when` | Always `true` (used as unconditional trigger). | Always `true`. |
| `cancelled()` | `step-if` / `retry-when` | The current job or step was cancelled. | The previous Attempt was cancelled. |

**Constraints:**
- Status functions are **only valid in `if:` conditions and retry `when:` conditions**. They are rejected in general `${{ }}` interpolation expressions.
- Status functions take no arguments. `success(foo)` is illegal and rejected at validation time.
- Pre-resolution happens before tokenization — no grammar change, no general function call support.
- Status functions must appear as standalone tokens; they cannot be nested inside other expressions.

**Examples:**
```yaml
# Repeat until all jobs pass
repeat:
  max_iterations: 3
  until: "${{ success() }}"

# Retry only on transient failures
retry:
  max_attempts: 3
  when:
    - timeout
    - infrastructure_error
  on_exceeded:
    status: failed

# Step condition: only run if prior steps passed
- id: deploy
  type: script
  if: "${{ success() }}"
  run: "pnpm deploy"
```

### 6.5 Forbidden constructs

The following constructs are **explicitly forbidden** in `${{ }}` expressions. Any expression containing them must be rejected at validation time.

| Forbidden construct | Example of illegal syntax |
|---------------------|---------------------------|
| Function calls (except status functions) | `${{ len(inputs.task) }}` |
| Arithmetic operators (`+`, `-`, `*`, `/`, `%`) | `${{ variables.count + 1 }}` |
| String concatenation | `${{ inputs.a + inputs.b }}` |
| Method calls | `${{ inputs.list.join(',') }}` |
| Array/object literals | `${{ [1, 2, 3] }}` |
| JavaScript evaluation | `${{ eval('...') }}` |
| Ternary operator | `${{ x ? y : z }}` |
| Object property depth > 3 (except `iteration.previous`) | `${{ jobs.a.outputs.b.c.d }}` |
| Template literals / string interpolation | `` ${{ `hello ${name}` }} `` |

---

## 7. What the Workflow DSL Is NOT

This section mirrors the architecture's "Rejected methods" rationale and the PRD's "Non-Goals." It defines the boundaries of the language by stating what it explicitly refuses to become.

### 7.1 NOT a general-purpose programming language

The DSL has no `while` loops, no `for` iteration, no variable assignment (in the imperative sense), no function definitions, and no arbitrary script evaluation. The only iteration construct is the `repeat` block on job groups — a bounded iteration with a hard `max_iterations` cap and an optional `until` condition. This is a structured re-execution mechanism, not a general loop primitive.

### 7.2 NOT a YAML-based scripting runtime

Workflow definitions are immutable during a run. There is no runtime YAML patch, no dynamic job insertion, and no self-modifying workflow. The `variables` and `context_blocks` data layer allows state to evolve during a run, but these write to `state.json` — they never modify the workflow YAML itself.

### 7.3 NOT an expression language

`${{ }}` expressions are reference lookups, not an expression evaluator. They resolve named values from a fixed set of namespaces. They do not support arithmetic, string manipulation, type coercion, or arbitrary function application. The four status functions (`success()`, `failure()`, `always()`, `cancelled()`) are pre-resolved to boolean literals before tokenization — they are not a function-call mechanism. See [§6.5](#65-forbidden-constructs) for the complete list of forbidden constructs.

### 7.4 NOT a state-machine bypass

Steps submit structured results (reports, script results, check results). The Engine — and only the Engine — decides what state transition occurs. Agents cannot write `state.json` directly. They cannot set `job.status`, `run.status`, or `step.current_step`. Even `context_patches` are processed through the Engine's `applyContextPatch` entry point with dual permission checks and batch atomicity.

### 7.5 NOT a Skill Pack

The Workflow DSL orchestrates. Skill Packs provide capabilities. A workflow file must not embed large knowledge bases, prompt templates, or tool definitions. Those belong in Skill Packs. Conversely, a Skill Pack manifest must not declare signals, job dependencies, or state transitions.

### 7.6 NOT a concurrent agent dispatcher

While the runtime supports parallel execution of read-only jobs, the DSL provides concurrency **control** (via the `concurrency` field on jobs) but not concurrency **primitives** (`parallel`, `fork`, `join`, `barrier`). Job-level concurrency is derived from the DAG: jobs whose `needs` are all met are eligible to run in parallel, subject to the Engine's scheduler and concurrency group policies.

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

### Job Group rules (v0.7)

| # | Rule |
|---|------|
| V29 | `job.group` must reference a key in the top-level `job_groups` map. |
| V30 | `job_groups` keys must be valid identifiers: lowercase letters, digits, and hyphens (`[a-z0-9-]+`). |
| V31 | Job Group `needs` must reference existing job group keys. |
| V32 | The job group DAG must not contain a cycle. |
| V33 | A job with a `group` field must not use `goto_step`, `goto_job`, or `retry_job` router actions. |
| V34 | `repeat.max_iterations` must be a positive integer. |
| V35 | `repeat.until` must be a valid conditional expression (see [§6.3](#63-conditional-expressions)). |
| V36 | `concurrency.group` must be a non-empty string. |
| V37 | `concurrency.policy` must be one of `allow`, `queue`, `cancel_previous`, `reject`. |

### Failure policy rules (v0.7)

| # | Rule |
|---|------|
| V38 | `failure_policy` must be one of `fail`, `continue`, `block`. |
| V39 | `retry.when` values must be non-empty strings; each value should match a known `FailureKind` (see [§4.4](#44-retry)). Unknown values produce a validation warning. |

---

## 9. Abstract Data Layer

Zigma Flow separates persistent state into two categories: the **State Machine** (owned by the Engine) and the **Abstract Data Layer** (workflow-scoped data that steps may read and write through Engine-validated patches). The Abstract Data Layer is composed of two subsystems: variables (§3.7) and context blocks (§3.8).

### 9.1 Variables (§3.7)

Variables are typed, enumerated, permission-gated values declared at the workflow level. Each variable has a declared type (`string`, `number`, `boolean`, `array`, `object`), an initial value, optional enum constraints, and an `allowed_writers` list of job-step references (`<job>.<step>` or `<job>.*`).

Steps read variables through `${{ variables.<name> }}` expressions. Steps write variables through `report.context_patches` (see [§10](#10-agent-report-context_patches)). The Engine validates every write against type, enum, permission, and reserved-field rules before applying any change.

### 9.2 Context Blocks (§3.8)

Context blocks are named, versioned text blocks stored as artifacts under `runs/<runId>/context-blocks/<id>/v<N>.md`. Each block has an `allowed_writers` list and an optional `initial_artifact`. Context block content is injected into agent prompts via the Context Builder, not via `${{ }}` expression substitution.

---

## 10. Agent Report: context_patches

When an Agent step completes, it may submit a `context_patches` array in its `report.json`. Each patch updates the workflow's Abstract Data Layer (variables or context blocks). The Engine processes the batch atomically: all patches are validated before any are applied. If any patch fails validation, the entire batch is rejected and no state changes are written.

### 10.1 Patch schema

`context_patches` is an array where each item conforms to:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `variable_set` \| `variable_delete` \| `context_block_set` \| `context_block_append` \| `context_block_delete` | Yes | The patch operation. |
| `name` | `string` | Yes | Variable name (for `variable_*`) or context block ID (for `context_block_*`). |
| `value` | `any` | Conditional | Required for `variable_set`, `context_block_set`, and `context_block_append`. Must match the variable's declared type for `variable_set`. |

**Patch kind semantics:**

| Kind | Behaviour |
|------|-----------|
| `variable_set` | Set `state.variables.<name>` to `value`. Validates type, enum, and permissions. |
| `variable_delete` | Remove `state.variables.<name>`. Validates permissions. |
| `context_block_set` | Replace a context block's content with `value`. Creates a new versioned artifact. |
| `context_block_append` | Append `value` to a context block's existing content. Creates a new versioned artifact. |
| `context_block_delete` | Remove a context block from state. Does not delete historical artifacts. |

**Example:**
```json
{
  "context_patches": [
    { "kind": "variable_set", "name": "plan_status", "value": "approved" },
    { "kind": "context_block_append", "name": "reviewer-notes", "value": "\n\nLGTM — ship it." }
  ]
}
```

### 10.2 Permissions model

A step may only write a variable or context block if **all** of the following conditions are met:

1. **Write permission:** `step.permissions.variables.write` (or `context_blocks.write`) includes the name.
2. **Allowed writers:** The variable or context block declaration's `allowed_writers` includes the step reference (`<job>.<step>`) or a job-level wildcard (`<job>.*`).
3. **Context edit gate:** `step.permissions.context_edit` is not `"none"`. When `context_edit` is `"none"`, all `context_patches` are rejected regardless of individual write entries.

These checks are performed per patch during the validation phase. A patch whose name is not declared in the workflow's `variables` or `context_blocks` map is rejected with a `ValidationError`.

### 10.3 Batch atomicity

All patches in the `context_patches` array are **validated before** any writes are performed. The sequence is:

1. Read the current state snapshot.
2. Load the workflow definition.
3. Validate every patch against permissions, declarations, types, enums, and reserved fields.
4. **If all pass:** apply all patches in-memory, write artifacts, append events, and write the updated state snapshot.
5. **If any fail:** no artifacts are written, no events are emitted, and `state.json` is not modified. The error is thrown to the caller.

This guarantees that a partially valid batch never leaves the data layer in an inconsistent state.

### 10.4 Reserved fields

To prevent accidental or malicious overwriting of Engine-owned state, the following field names **must not** be used as variable names in `context_patches`:

| Reserved field | Rationale |
|----------------|-----------|
| `status` | Run status; owned by Engine state machine transitions. |
| `last_event_id` | Event log cursor; owned by Engine sequential event numbering. |
| `jobs` | Job state map; owned by Engine `advanceJob` and scheduler. |
| `signals` | Signal state array; owned by Engine `handleSignals`. |
| `run_id` | Run identifier; immutable after run creation. |
| `workflow` | Workflow reference; immutable after run creation. |
| `task` | Task description; immutable after run creation. |
| `created_at` | Creation timestamp; immutable after run creation. |
| `step_visits` | Step visit counters; owned by Engine `goto_step` visit tracking. |

Attempting to patch a reserved field via `variable_set` or `variable_delete` throws a `ValidationError` and rejects the entire batch, even if other patches in the batch are valid.

### 10.5 Rollback semantics

On validation failure:
- No artifacts are written to disk.
- No events are appended to `events.jsonl`.
- `state.json` is not modified — the snapshot at the start of the call remains on disk.
- A `ValidationError` (or `StateError` for structural failures) is thrown with diagnostic details including the offending patch and the reason for rejection.

The caller (typically `acceptAgentReport`) should catch this error and treat it as a step failure. The run may then enter a retry, block, or fail state depending on the step's `on_failure` configuration.

---

## 11. Appendix: Full Example

The following is a complete, validated workflow definition demonstrating v0.7 features including job groups, repeat blocks, concurrency control, failure policies, retry with `when` conditions, and expression extensions.

```yaml
name: code-change
version: 0.7.0

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

job_groups:
  implement-review:
    needs:
      - intake-plan
    repeat:
      max_iterations: 3
      until: "${{ success() }}"

jobs:
  intake:
    group: intake-plan
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
    group: intake-plan
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
    group: intake-plan
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
    group: intake-plan
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
    group: implement-review
    needs:
      - plan
    optional_needs:
      - architecture-design
    retry:
      max_attempts: 3
      when:
        - timeout
        - infrastructure_error
        - agent_error
      on_exceeded:
        status: failed
    concurrency:
      group: writable-jobs
      policy: queue
    steps:
      - id: implement
        type: agent
        with:
          task: "${{ inputs.task }}"
          previous_summary: "${{ iteration.previous.jobs.implement.outputs.summary }}"
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
    group: implement-review
    needs:
      - implement
    workspace:
      mode: read-only
    failure_policy: continue
    steps:
      - id: check
        type: script
        run: "pnpm typecheck && pnpm lint"
        on_failure: fail

  unit-test:
    group: implement-review
    needs:
      - implement
    workspace:
      mode: read-only
    failure_policy: continue
    steps:
      - id: test
        type: script
        run: "pnpm test:ci"
        on_failure: fail

  review:
    group: implement-review
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
          attempt_number: "${{ attempt.number }}"
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
| 2026-07-17 | 0.7.0 | v0.7 Execution Model. Added `job_groups` top-level field with `repeat` blocks (§3.10), `group` field on jobs (§4.8), `concurrency` with four policies (§4.9), `failure_policy` with cascade semantics (§4.10). Updated `retry` with `when` FailureKind whitelist (§4.4). Extended expression namespaces: `invocation`, `attempt`, `iteration.previous`, job/step status and attempt (§6.1). Added status functions `success()`, `failure()`, `always()`, `cancelled()` with pre-resolution semantics (§6.4). Relaxed depth limit to 4 for `iteration.previous` paths. Marked `goto_step`, `goto_job`, `retry_job`, `max_visits`, `retry_with`, `on_failure` object form as deprecated with internal translation notes. Added validation rules V29–V39 for job groups, concurrency, and failure policies. Updated full example to demonstrate v0.7 features. |
| 2026-07-03 | 0.3.0 | Initial published language specification. Covers all top-level fields, all 5 step types, reserved `workflow` type, expression syntax, forbidden constructs, and validation rules. |
| 2026-07-03 | 0.3.1 | Added §9 Abstract Data Layer and §10 Agent Report: context_patches. Documents patch schema, permissions model, batch atomicity, reserved fields, and rollback semantics. |
