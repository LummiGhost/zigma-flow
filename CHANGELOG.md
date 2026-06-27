# Changelog

All notable changes to Zigma Flow are documented in this file.

## [v0.2.0] — P14 Concurrent Read-Only Job Execution (2026-06-28)

### Scheduler

- **`selectExecutable` pure function** (`src/engine/scheduler.ts`): scheduler accepts `RunState`, `WorkflowDefinition`, and `SchedulerConfig`; returns an `ExecutableBatch` with `jobs` array and `rationale` string. No IO, no async.
- **Scheduling rules**: read-only jobs run concurrently up to `parallelism`; writable jobs are strictly serialized (at most 1 per batch). A writable lock blocks further writable jobs until the running writable completes.
- **Workspace mode derivation**: `workspace.mode: "read-only"` is the sole indicator for concurrency eligibility; all other values (including `undefined` and `"writable"`) are treated as writable and serialized.

### AsyncQueue — Per-runDir Write Serialization

- **`AsyncQueue`** (`src/run/asyncQueue.ts`): FIFO serial execution queue. `run<T>(fn: () => Promise<T>): Promise<T>` — functions execute one at a time; errors propagate but do not prevent subsequent tasks.
- **`LocalStateStore.writeSnapshot`** now wraps writes through a per-runDir AsyncQueue, eliminating concurrent-write race conditions.
- **`JsonlEventWriter.appendEvent`** now wraps appends through a per-runDir AsyncQueue, ensuring events are appended in call order with no line interleaving.

### Concurrent Batch Loop

- **`runAll` main loop refactored** (`src/engine/runAll.ts`): from sequential (one job per iteration) to scheduler-driven concurrent batch execution using `Promise.allSettled`.
- **`--parallelism N` CLI flag** (default 4): maximum concurrent jobs in a batch.
- **`--fail-fast` CLI flag** (default false): when enabled, a single job failure aborts all peer jobs in the same batch.
- **`batch_id` on events**: each scheduling batch generates a UUID; all events emitted during the batch carry `batch_id` in their payload for grouping.
- **`updateState` atomic read-modify-write**: `StateStore` now exposes `updateState(runDir, fn)` which performs atomic read-modify-write within the AsyncQueue.
- **`parallelism` agent config**: `AgentConfig.parallelism` can be set in `.zigma-flow/config.json` under `agent.parallelism`. A `getParallelism()` helper resolves the effective value.

### Documentation

- `docs/architecture.md` §7.4: Concurrency Model — scheduler pure function, AsyncQueue serialization, batch loop, fail-fast, event ordering.
- `README.md`: "并发执行" section with `--parallelism`, `--fail-fast` usage, and batch loop description.
- `CHANGELOG.md`: this section.

### Test Coverage

- 8 new test files for scheduler, AsyncQueue, concurrent state store, concurrent event writer, and concurrent runAll.
- Total test suite: ~740+ tests across 69+ test files.
- Pre-existing 714 tests: zero regressions.

## [v0.2.0] — P13a Agent Adapter Hardening (2026-06-28)

### Engine — runAll Loop

- **Extracted `runAll` engine entry** (`src/engine/runAll.ts`): the main execution loop is now a standalone function callable without CLI dependencies. `commands/run-all.ts` is a thin CLI shell (~100 lines).
- **Event ID sequencing** (`src/events/sequence.ts`): `nextSequentialEventId(runDir)` reads `events.jsonl` to determine the next sequential event ID, replacing scattered manual `parseInt(lastId.replace(...))` calls in the engine.

### Agent Lifecycle Events

- **5 new event types** in `src/events/eventTypes.ts`: `agent_invoked`, `agent_completed`, `agent_timed_out`, `agent_failed`, `agent_cancelled`.
- Every agent backend invocation is bracketed by an `agent_invoked` → terminal event pair, making backend behavior independently auditable from `events.jsonl`.

### Backend Artifacts

- **Stdout/stderr written to files**: `ClaudeCodeBackend.execute` writes `agent.stdout.log`, `agent.stderr.log`, and `agent.invocation.json` to the step artifact directory. Error messages no longer embed truncated stdout/stderr strings.
- **Artifact registration**: `runAll` registers these files as artifacts (`kind=agent_stdout`, `agent_stderr`, `agent_invocation`) in `artifacts.jsonl`.

### Retry on Failure

- **`recordAgentFailure`** (`src/engine/recordAgentFailure.ts`): agent failures now follow the job's `retry` configuration (attempt+1) instead of directly failing the run.
- **ConfigError/PermissionError bypass**: backend-not-found, not-logged-in, and similar configuration errors skip retry and fail the run immediately with exit code 4.

### Resume and Cancel

- **`--resume <run-id>`**: resumes an interrupted run from its last state. Mutually exclusive with `--task`.
- **AbortSignal propagation**: `runAll` accepts an `AbortSignal`; the CLI wires SIGINT to abort. On cancel, the Engine writes `agent_cancelled` + `run_cancelled` events and sets `state.status=cancelled`.

### Backend Configuration

- **Config module** (`src/agent/config.ts`): `loadAgentConfig`, `resolveBackendForStep`, `createBackend` extracted from the CLI for reuse.
- **Error classification**: `ClaudeCodeBackend` classifies command-not-found, not-logged-in, and rate-limited errors for appropriate retry/skip decisions.

### Documentation

- `docs/architecture.md` §11.1: Agent Backend Lifecycle section.
- `README.md`: `run-all --resume` usage and `.zigma-flow/config.json` agent backend example.
- `CHANGELOG.md`: this file.

### Test Coverage

- 77 new test cases across 7 new test files.
- Total test suite: 556 tests, 46 test files, zero regressions.

## [v0.2.0] — P13b Agent-Driven Flow Control (2026-06-28)

### Step Structured Return Status (AD-P13-009)

- **`applyStatusReturn`** (`src/engine/applyStatusReturn.ts`): new Engine entry that translates Agent `report.status` into `on_return` routing actions.
- **Workflow schema**: `step.returns` (status values + required flag) and `step.on_return` (status → action mappings).
- **Event**: `step_returned` (payload: `job_id`, `step_id`, `status`, `mapped_action`).
- **Pipeline**: status is processed after context_patches but before signals (AD-P13-013); status-triggered actions take priority over signals.

### Workflow Variables & Context Blocks (AD-P13-010, AD-P13-011)

- **Variables namespace** (`workflow.variables`): type-declared variables with `initial` values and `allowed_writers`. Agent can modify via `context_patches`. Stored in `state.json` `variables` segment.
- **Context blocks namespace** (`workflow.context_blocks`): versioned document artifacts (`context-blocks/<id>/v<N>.md`) that agents can write through patches. Old versions preserved.
- **`applyContextPatch`** (`src/engine/applyContextPatch.ts`): batch-atomic engine entry. Pre-validates all patches before writing; any failure rolls back the entire batch.
- **Permission model**: step permissions expand with `variables.read/write`, `context_edit` (none|read|write), `context_blocks.read/write` — independent of file `edits` permission.
- **Reserved field protection**: patch operations rejected if they touch state machine fields.
- **Events**: `variable_set`, `variable_deleted`, `context_block_updated`, `context_block_deleted`.
- **Context Builder**: variables and context blocks injected into Agent prompt, filtered by step read permissions.

### Expression Resolver Expansion

- **`${{ variables.<name> }}`**: resolve workflow variable values.
- **`${{ steps.<id>.outputs.<key> }}`**: resolve step outputs within the same job (清偿 TD-P9-002).
- **`${{ jobs.<id>.outputs.<key> }}`**: resolve cross-job outputs (清偿 TD-P9-001).
- **`evaluateCondition(expr, ctx)`**: boolean expression evaluator supporting `==`, `!=`, `&&`, `||`, `!`, parentheses. No `eval()`.

### Conditions, Goto, and Bounded Loops (AD-P13-012)

- **Step `if:`**: condition evaluated before step start; false → step skipped with `step_skipped` event.
- **Router `goto_step`**: same-job step redirection with `step_revisited` event; cross-job rejected at load time.
- **`max_visits`**: per-step visit limit (default 3). Exceeded → step + job blocked with `step_visit_exceeded` event.
- **Visit counting**: `JobState.step_visits`; skipped steps don't increment; retryJob resets.
- **Events**: `step_skipped`, `step_revisited`, `step_visit_exceeded`.

### Test Coverage

- 159 new test cases across 17 new test files.
- Total test suite: 714 tests, 61 test files.
- Pre-existing 556 tests: zero regressions.
