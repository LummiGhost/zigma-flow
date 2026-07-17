# Migration Guide

This document describes what changed between Zigma Flow versions and what workflow authors need to do when upgrading.

## v0.1 → v0.2

### What changed

v0.2 was a major feature release that introduced Agent-driven flow control and concurrent job execution. The changelog (`CHANGELOG.md`) documents three workstreams:

**P13a — Agent Adapter Hardening:**
- New `runAll` engine entry point replacing the sequential CLI loop.
- Agent lifecycle events: `agent_invoked`, `agent_completed`, `agent_timed_out`, `agent_failed`, `agent_cancelled`.
- Agent stdout/stderr written to artifact files instead of embedded in error messages.
- Retry-on-failure for agent backends; config/permission errors skip retry and fail immediately.
- `--resume` and cancel (AbortSignal) support.
- Backend configuration via `.zigma-flow/config.json`.

**P13b — Agent-Driven Flow Control:**
- Step structured return status (`returns.status`, `on_return`): agents can report a status value that triggers a pre-declared Engine action.
- Workflow variables (`variables`): typed, permission-gated data layer writable via `report.context_patches`.
- Context blocks (`context_blocks`): versioned document artifacts writable via patches.
- Expression resolver expanded: `${{ variables.<name> }}`, `${{ steps.<id>.outputs.<key> }}`, `${{ jobs.<id>.outputs.<key> }}`.
- Condition evaluator: `==`, `!=`, `&&`, `||`, `!`, parentheses.
- Step `if:` conditions, router `goto_step`, and `max_visits` bounded loops.
- New events: `step_skipped`, `step_revisited`, `step_visit_exceeded`, `variable_set`, `variable_deleted`, `context_block_updated`, `context_block_deleted`.

**P14 — Concurrent Read-Only Job Execution:**
- Scheduler-driven concurrent batch execution using `Promise.allSettled`.
- `--parallelism N` and `--fail-fast` CLI flags.
- `AsyncQueue` for per-runDir write serialization.
- `batch_id` on events for batch grouping.

### Migration for workflow authors

- **No breaking changes.** All v0.1 workflows remain valid under v0.2 without modification.
- New optional fields (`variables`, `context_blocks`, `returns`, `on_return`, `if`, `max_visits`) are available but not required.
- The expression resolver now supports `${{ steps.<id>.outputs.<key> }}` for same-job step output references.

## v0.2 → v0.3

### What changed

v0.3 is the **Language Freeze release**. The primary change is documentation and stability labelling, not schema changes. Every field in the Workflow Language Specification (`docs/workflow-language.md`) now carries an explicit stability label (`stable`, `experimental`, or `reserved`).

Key additions in v0.3:

- **Published language specification** (`docs/workflow-language.md`): every legal field, type, constraint, and execution semantic is formally documented. This is the single source of truth for what the runtime accepts.
- **Stability labels on all fields**: workflow authors can see at a glance which fields are safe to depend on and which may change.
- **Reserved `workflow` step type**: recognised by the validator but not executed. Using it produces a validation warning. This reserves the type name for future nested workflow execution.
- **`context_patches` documented**: the patch schema, permissions model, batch atomicity, reserved field protection, and rollback semantics are fully specified in the language spec (§10).
- **Reserved field protection**: the Engine now explicitly rejects `context_patches` that touch state machine fields (`status`, `last_event_id`, `jobs`, `signals`, `run_id`, etc.).
- **Human Gate step type** (`type: human`): recognised by schema but full runtime enforcement deferred to a future release.
- **Compatibility policy** (`docs/compatibility.md`): formal stability levels and breaking-change process.

### Migration for workflow authors

**You do not need to change anything.** All v0.2 workflows are fully compatible with v0.3 without modification.

If you choose to update your workflow `version` field to `0.3.0`, the only changes are:

| Change | Required? |
|--------|-----------|
| Update `version` from `0.2.0` to `0.3.0` | Optional |
| Update field references to match stability labels | Not required — the runtime accepts the same YAML |
| Add `variables`, `context_blocks`, `returns`, `on_return`, `if`, `max_visits` | Optional — these are experimental v0.2 fields that remain available |
| Change `activation: "manual"` (string) to documented value | Already compatible |

## v0.3 → v0.7

### What changed

v0.7 is the **Execution Model release**. It introduces a forward-only, immutable-record execution model that replaces v0.6's deprecated dynamic control-flow features. The key change is architectural: retry, re-execution, and iteration now always produce new immutable records (Attempts and Iterations) — the Engine never mutates completed state backward.

**New features (v0.7):**

- **Execution Attempt Model (§234):** Every job execution now produces an immutable `Attempt` record with monotonic numbering (1, 2, 3…). `FailureKind` taxonomy classifies failures into 7 well-known types (`timeout`, `infrastructure_error`, `invalid_output`, `agent_error`, `cancelled`, `permission_denied`, `config_error`) plus an extension slot. `RetryPolicy` with `when` whitelist conditions controls which failure kinds trigger retry (default: transient failures only).

- **Job Group Iteration Model (§233):** Jobs can be collected into named groups (`job_groups`) with `repeat` blocks. Each iteration runs all jobs in the group to completion before the next begins. `max_iterations` provides a hard cap; `until` expressions enable early exit. `iteration.previous.jobs.<id>.outputs.<key>` provides feedback-driven rework data flow.

- **Concurrency Groups (§235):** The `concurrency` field on jobs controls concurrent execution within a named group. Four policies: `allow` (default), `queue` (wait for slot), `cancel_previous` (cancel running job), `reject` (fail immediately).

- **Failure Policy Cascade (§235):** Job-level `failure_policy` with three options: `fail` (default, propagate up), `continue` (mark failed but continue iteration), `block` (stop immediately). Policies cascade hierarchically: job → iteration → run.

- **Expression Extensions (§235):** New namespaces: `invocation` (trigger, backend), `attempt` (number, trigger, previous_outcome), `iteration.previous`. New status functions: `success()`, `failure()`, `always()`, `cancelled()` — pre-resolved to boolean literals, not general function calls. Job and step references now expose `.status` and `.attempt` fields.

- **Outcome vs Conclusion:** Clear separation between technical outcomes (`AttemptOutcome`: success/failure/cancelled) and business conclusions (`JobConclusion`: success/success_with_warnings/failure/blocked/cancelled).

- **Event catalog:** Expanded from 45 to 55+ event types (3 attempt lifecycle, 7 iteration/group, updated payloads).

**Deprecated features — internally translated:**

The following v0.6 deprecated features are now **internally translated** to the new execution model. They continue to work but will be removed in v1.0:

| Deprecated feature | v0.7 internal translation |
|--------------------|--------------------------|
| `goto_step` / `goto_job` router actions | Implicit Job Group Iteration (`__implicit__` prefix) |
| `retry_job` router action / `retry_with` | New Attempt via Attempt model |
| `max_visits` on steps | `repeat.max_iterations` on implicit group |
| `on_failure` object form (`{ status: ... }`) | Normalized to `failure_policy` |
| `variables`, `context_blocks`, `context_patches` | Continue to warn; use job outputs and artifacts instead |

### Migration for workflow authors

**You do not need to change anything.** All v0.3–v0.6 workflows are fully compatible with v0.7 without modification. The deprecated fields your workflow may use (`goto_step`, `goto_job`, `retry_job`, `max_visits`, `on_failure` object form) are internally translated to the new model.

If you choose to adopt v0.7 features:

| Change | How to migrate |
|--------|----------------|
| Replace `goto_step`/`goto_job` with `repeat` blocks | Add a `job_groups` section, assign jobs to a group, add `repeat` with `max_iterations` and optional `until` |
| Replace `max_visits` with `repeat.max_iterations` | Move the limit from step level to group level |
| Replace `retry_job` with `retry.when` | Add `retry.when` array with FailureKind values to the job definition |
| Replace `on_failure: { status: ... }` with `failure_policy` | Use `failure_policy: fail` (default), `continue`, or `block` |
| Use `iteration.previous` for feedback loops | Reference `${{ iteration.previous.jobs.<id>.outputs.<key> }}` in step `with` blocks |
| Add concurrency control | Use `concurrency.group` + `concurrency.policy` on writable jobs |
| Use status functions for conditional logic | Use `success()`, `failure()`, `always()`, `cancelled()` in `if:` and `until:` conditions |
| Update `version` field | Change from `0.3.0` to `0.7.0` (optional) |

## Migration Checklist

**My workflow was working on v0.3–v0.6. Do I need to change anything?**

**Answer: No.** v0.3–v0.6 workflows are fully compatible with v0.7. Deprecated features (`goto_step`, `goto_job`, `retry_job`, `max_visits`, `on_failure` object form) are internally translated to the new execution model and continue to work.

- [ ] **Already done:** Your existing workflow YAML is valid under v0.7.
- [ ] **Optional:** Update `version:` to `0.7.0` to reflect the current schema version.
- [ ] **Optional:** Replace deprecated `goto_step`/`goto_job` with `repeat` blocks in `job_groups`.
- [ ] **Optional:** Replace deprecated `retry_job` router actions with job-level `retry.when`.
- [ ] **Optional:** Replace `on_failure` object form with `failure_policy`.
- [ ] **Optional:** Add `iteration.previous` data flow for feedback-driven iteration.
- [ ] **Optional:** Add `concurrency` controls for writable job serialization.
- [ ] **Optional:** Use status functions (`success()`, `failure()`, etc.) in conditions.
