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

## Migration Checklist

**My workflow was working on v0.2. Do I need to change anything?**

**Answer: No.** v0.2 workflows are fully compatible with v0.3. The v0.3 release adds documentation and stability labelling but does not change the schema in any breaking way.

- [ ] **Already done:** Your v0.2 workflow YAML is valid under v0.3.
- [ ] **Optional:** Update `version:` to `0.3.0` to reflect the current schema version.
- [ ] **Optional:** Review `docs/workflow-language.md` to understand which fields are stable vs. experimental.
- [ ] **Optional:** Add v0.2 experimental features (`variables`, `context_blocks`, `returns`, `on_return`, `if`, `max_visits`) if your workflow would benefit from them.
