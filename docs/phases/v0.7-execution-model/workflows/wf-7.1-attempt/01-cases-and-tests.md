# WF-7.1: Execution Attempt Model -- Cases and Tests

Date: 2026-07-16
Status: Step 1 -- Red Phase
Inputs: `docs/phases/v0.7-execution-model/02-development-plan.md`, `docs/phases/v0.7-execution-model/research/r1-attempt-model.md`, `docs/architecture.md`, `docs/mvp-contracts.md`

## 0. Slice Boundary

- **Slice name:** Execution Attempt Model
- **Single bounded context this slice belongs to:** Run Runtime
- **This is a non-user-facing backend workflow** -- there are no "user can complete..." tasks. All changes are internal to the Engine, state model, events, and CLI inspect output.
- **Planned test files (maximum 2):**
  - `tests/engine/attempt-model.test.ts` -- Attempt state machine, retry policy evaluation, conclusion derivation
  - `tests/engine/attempt-events.test.ts` -- Event emission for attempt_started/completed/failed, backward compat events

## 1. Functional Points and Use Cases

### 1.1 Attempt Data Model

**FP-1.1 Attempt identity -- per-job monotonic numbering (1-based)**

An Attempt is identified by the combination of `(jobId, attemptNumber)`. Attempt numbers are monotonic within each job: the initial execution is attempt 1, the first retry is attempt 2, and so on. Attempt numbers are never reused or decremented.

**FP-1.2 Attempt state shape -- hybrid (summary fields in Attempt record, step detail in events)**

Each Attempt record carries key summary fields: `number`, `status`, `failure_kind`, `failure_reason`, `started_at`, `ended_at`, `step_count`, optional `outputs`, optional `retry_inputs`, and optional `initiation_reason`. Step-level fidelity (individual step results, timing, artifacts) remains in `events.jsonl`. This avoids duplicating event data in `state.json` while enabling fast CLI inspection of attempt history.

**FP-1.3 Attempt is immutable after sealing**

Once an Attempt's `status` transitions to a terminal value (`"success"`, `"failure"`, or `"cancelled"`) and `ended_at` is set, the record must never be mutated. New retries append new Attempt records; they never overwrite old ones.

### 1.2 FailureKind Taxonomy

**FP-2.1 Seven well-known failure kinds**

| Kind | Meaning | Retry-default |
|------|---------|---------------|
| `timeout` | Agent backend timed out | Yes |
| `infrastructure_error` | Network, disk, or backend infrastructure failure (transient) | Yes |
| `invalid_output` | Agent produced output that fails validation (permanent without input change) | No |
| `agent_error` | Agent execution failed for reasons not covered above | Yes |
| `cancelled` | Agent was cancelled by signal | No |
| `permission_denied` | Agent lacks required permissions | No |
| `config_error` | Misconfiguration (wrong model, missing backend, etc.) | No |

**FP-2.2 Extension slot**

The TypeScript type accepts any string via the `(string & {})` extension slot. Custom values are treated as `agent_error` for retry policy matching purposes. This allows forward-compatible schema evolution without code changes.

**FP-2.3 Default transient set**

`TRANSIENT_FAILURE_KINDS` = `{ "timeout", "infrastructure_error", "agent_error" }`. These are retryable by default when no explicit `when` list is provided.

### 1.3 Retry Policy

**FP-3.1 RetryPolicy shape**

```typescript
interface RetryPolicy {
  max_attempts?: number;       // default: 1 (no retry)
  when?: FailureKind[];        // default: TRANSIENT_FAILURE_KINDS
  on_exceeded?: { status: "blocked" | "failed" }; // default: "blocked"
  max_delay_ms?: number;       // reserved for v0.8
}
```

**FP-3.2 When conditions -- whitelist semantics**

- When `when` is absent: defaults to `["timeout", "infrastructure_error", "agent_error"]`.
- When `when` is present: only the listed failure kinds trigger retry; all others are terminal.
- When `when` is an empty array `[]`: never retry, regardless of `max_attempts`.
- Custom failure kinds (not in the 7 well-known values) are treated as `agent_error` for matching.

**FP-3.3 on_exceeded**

When `max_attempts` is exhausted and the last attempt is a failure, `on_exceeded.status` determines the job's terminal state: `"blocked"` (default) or `"failed"`.

**FP-3.4 max_attempts includes the initial attempt**

`max_attempts: 1` means no retry (the initial attempt is the only attempt). `max_attempts: 3` means the initial attempt plus up to 2 retries.

### 1.4 Job Conclusion Derivation

**FP-4.1 deriveJobConclusion is a pure function**

Input: `attempts: Attempt[]` and `onExceeded: "blocked" | "failed"`. Output: `JobConclusion`.

**FP-4.2 Derivation rules**

| Condition | Conclusion |
|-----------|------------|
| `attempts.length === 0` | `"failure"` (defensive: should not happen) |
| Last attempt `status === "success"` | `"success"` |
| Last attempt `status === "cancelled"` | `"cancelled"` |
| Last attempt `status === "failure"` | `onExceeded` (`"blocked"` or `"failed"`) |

Note: `"success_with_warnings"` is reserved for WF-7.3 (failure_policy: continue). The pure function signature is extensible to accept a `failurePolicy` parameter in the future.

**FP-4.3 Conclusion maps directly to JobState.status**

`JobState.status` is set to the derived `JobConclusion`. This is the existing behavior (last outcome wins) formalized with the Attempt model.

### 1.5 Engine Integration

**FP-5.1 Create Attempt on job start**

When a job transitions from `ready` to `running`, the engine creates a new open Attempt record with `status` unset (internally tracked; `started_at` recorded, `ended_at` left unset) and appends it to `JobState.attempts`. Emits `attempt_started` event.

**FP-5.2 Seal Attempt on job completion**

When a job reaches `completed`, the engine seals the current Attempt: sets `status = "success"`, `ended_at`, `step_count`, and captures `outputs` snapshot. Emits `attempt_completed` event.

**FP-5.3 Seal Attempt on job failure**

When a job reaches `failed` or `blocked` (all attempts exhausted), the engine seals the current Attempt: sets `status = "failure"`, `ended_at`, `step_count`, `failure_kind`, and `failure_reason`. Emits `attempt_failed` event.

**FP-5.4 Seal Attempt on cancellation**

When a job is cancelled, the engine seals the current Attempt: sets `status = "cancelled"`, `ended_at`, `step_count`. Emits `attempt_failed` event with `failure_kind = "cancelled"`.

**FP-5.5 Append new Attempt on retry**

When retry is triggered (either via the new retry policy path or the deprecated `retry_job` router action), the engine:
1. Seals the previous Attempt as `failure` (emits `attempt_failed`)
2. Creates a new open Attempt (emits `attempt_started`)
3. Sets `JobState.status = "ready"`, updates `JobState.attempt` to the new number

**FP-5.6 Attempt timing synchronization**

The `started_at` field on an Attempt and the `timestamp` field on the corresponding `attempt_started` event must use identical values (same `clock.now()` call). Similarly for `ended_at` and `attempt_completed`/`attempt_failed`.

### 1.6 Event Emission

**FP-6.1 New event types**

| Event Type | Payload | Emitted When |
|------------|---------|--------------|
| `attempt_started` | `{ job_id, attempt, reason }` | New attempt begins (initial or retry) |
| `attempt_completed` | `{ job_id, attempt, step_count, duration_ms }` | Attempt terminates successfully |
| `attempt_failed` | `{ job_id, attempt, failure_kind, reason, step_count, duration_ms }` | Attempt terminates with failure or cancellation |

**FP-6.2 Updated existing event payloads**

| Event | New/Optional Fields Added |
|-------|---------------------------|
| `job_failed` | `failure_kind?: FailureKind` |
| `job_blocked` | `failure_kind?: FailureKind` |
| `job_retrying` | `failure_kind?: FailureKind` |

### 1.7 Backward Compatibility

**FP-7.1 Old retry_job internally translated to Attempt model**

When the engine encounters a `retry_job` router action:
1. The concluded attempt is sealed as an Attempt with `status = "failure"`, `failure_kind = "agent_error"` (inferred)
2. A new open Attempt is created
3. `attempt_failed` and `attempt_started` events are emitted (in addition to the existing `job_retrying` event for backward compat)

**FP-7.2 Old `attempt` field preserved as pointer**

`JobState.attempt` (the scalar number) is kept as a derived pointer to `attempts[attempts.length - 1].number`. Old code that reads `jobState.attempt` continues to work.

**FP-7.3 Old retry_reason / retry_inputs preserved**

Data from `retry_reason` and `retry_inputs` is also stored in the latest Attempt record (`initiation_reason` and `retry_inputs`). The old fields are marked deprecated but still written.

**FP-7.4 Pre-v0.7 run migration**

When a run created before v0.7 is loaded and `attempts` is undefined but `attempt > 1`, the engine synthesizes minimal Attempt records from existing events so that the `attempts` array is populated. This is a one-time read-time migration.

### 1.8 CLI Inspect

**FP-8.1 Show attempt history in inspect output**

The `inspect` command shows attempt history for each job: attempt number, status, failure_kind (if failed), timing, step count.

### Out of Scope for WF-7.1

- `failure_policy: continue` and `success_with_warnings` conclusion (WF-7.3)
- `retry_policy.max_delay_ms` enforcement (v0.8)
- Job Group Iteration (WF-7.2)
- Expression namespace `attempt` (WF-7.3)
- Status functions `success()` / `failure()` (WF-7.3)

---

## 2. Spec Compliance Matrix

### 2.1 From R1 Research Report

| # | Clause | Source | Status |
|---|--------|--------|--------|
| R1-1 | Attempt identity MUST be per-job monotonic (1,2,3 within each job) | R1 Decision (a) | 已纳入本工作流 |
| R1-2 | Attempt state shape MUST be hybrid (summary fields in Attempt, step detail in events) | R1 Decision (b) | 已纳入本工作流 |
| R1-3 | `failure_kind` MUST be a closed string union of 7 well-known values + extension slot `(string & {})` | R1 Decision (c) | 已纳入本工作流 |
| R1-4 | `WELL_KNOWN_FAILURE_KINDS` MUST be a ReadonlySet of the 7 values | R1 §Proposed Data Model | 已纳入本工作流 |
| R1-5 | `TRANSIENT_FAILURE_KINDS` MUST be `{ timeout, infrastructure_error, agent_error }` | R1 §Proposed Data Model | 已纳入本工作流 |
| R1-6 | Retry policy `when` MUST be a whitelist array of FailureKind | R1 Decision (d) | 已纳入本工作流 |
| R1-7 | Default `when` MUST be TRANSIENT_FAILURE_KINDS (safe by default) | R1 Decision (d) | 已纳入本工作流 |
| R1-8 | Empty `when: []` MUST mean never retry | R1 Decision (d) | 已纳入本工作流 |
| R1-9 | Non-well-known failure kinds MUST be treated as `agent_error` for matching | R1 Decision (d) | 已纳入本工作流 |
| R1-10 | Job conclusion MUST be derived from last attempt outcome (no policy field) | R1 Decision (e) | 已纳入本工作流 |
| R1-11 | `deriveJobConclusion` MUST be a pure function | R1 §Proposed Data Model | 已纳入本工作流 |
| R1-12 | Artifact paths MUST NOT change (`jobs/<jobId>/attempts/<n>/steps/<stepId>/`) | R1 Decision (f) | 已纳入本工作流 |
| R1-13 | Attempt record MUST include: number, status, failure_kind?, failure_reason?, started_at, ended_at, step_count, outputs?, retry_inputs?, initiation_reason? | R1 §Proposed Data Model | 已纳入本工作流 |
| R1-14 | `Attempt.status` MUST be `"success" | "failure" | "cancelled"` | R1 §Proposed Data Model | 已纳入本工作流 |
| R1-15 | `JobConclusion` MUST be `"success" | "failure" | "blocked" | "cancelled"` (v0.7 baseline; `success_with_warnings` added in WF-7.3) | R1+R4 reconciliation | 已纳入本工作流（without `success_with_warnings`） |
| R1-16 | `RetryPolicy.on_exceeded` MUST default to `"blocked"` | R1 §Proposed Data Model | 已纳入本工作流 |
| R1-17 | `RetryPolicy.max_delay_ms` MUST be reserved for v0.8 (not enforced in v0.7) | R1 §Proposed Data Model | 已纳入本工作流 |
| R1-18 | New event types MUST include: `attempt_started`, `attempt_completed`, `attempt_failed` | R1 §Proposed Event Types | 已纳入本工作流 |
| R1-19 | `job_failed`, `job_blocked`, `job_retrying` payloads MUST be extended with `failure_kind?: FailureKind` | R1 §Updated Existing Event Payloads | 已纳入本工作流 |
| R1-20 | Backward compat: old `retry_job` action MUST be internally translated to Attempt model | R1 §Backward Compatibility | 已纳入本工作流 |
| R1-21 | Backward compat: `JobState.attempt` scalar MUST be preserved as deprecated pointer | R1 §Updated JobState | 已纳入本工作流 |
| R1-22 | Pre-v0.7 run migration path MUST be handled (synthesize Attempts from events on read) | R1 Risk 1 | 计划外（技术债 TD-7.1-MIG） -- v0.7 engine does not yet read old runs; migration is deferred until needed for dogfood resume |
| R1-23 | Attempt timing MUST use identical `clock.now()` for record and event | R1 Risk 3 | 已纳入本工作流 |
| R1-24 | Missing `failure_kind` on failed attempt MUST default to `"agent_error"` | R1 Risk 4 | 已纳入本工作流 |

### 2.2 From Architecture.md

| # | Clause | Source | Status |
|---|--------|--------|--------|
| ARC-1 | `state.json` 只能由 Engine 通过 State Store 写入 | §6.2 Run invariants | 已纳入本工作流 |
| ARC-2 | 每个状态变化都必须对应 event | §6.2 Run invariants | 已纳入本工作流 |
| ARC-3 | Completed job 不应被重新执行，除非 Engine 执行合法 retry transition | §6.2 JobRun invariants | 已纳入本工作流 |
| ARC-4 | Retry 必须增加 attempt，并保留历史 attempt artifacts | §6.2 JobRun invariants | 已纳入本工作流 |
| ARC-5 | Retry 超过 `max_attempts` 后进入 blocked 或 failed，按 workflow 声明执行 | §6.2 JobRun invariants | 已纳入本工作流 |
| ARC-6 | Writable job 同时 running 数量最多为 1 | §6.2 JobRun invariants | 规范不适用（WF-7.1 不改变 scheduler/concurrency） |
| ARC-7 | `step_visits` 在 retry 时必须清零 | §6.2 JobRun invariants | 已纳入本工作流 |
| ARC-8 | `state.json` 的状态机字段只能由 Engine 内部入口写入 | §6.2 Run invariants (v0.2) | 已纳入本工作流 |
| ARC-9 | Job status transition: `completed -> retrying -> ready` | §7.2 State transitions | 计划外（技术债 TD-7.1-STATUS） -- `completed -> retrying -> ready` is the OLD transition via `job_retrying`. In the new model, retry does `failed/sealed -> ready` via `attempt_failed + attempt_started`. The old transition diagram needs updating. |
| ARC-10 | Job status transition: `ready -> running -> failed` | §7.2 State transitions | 已纳入本工作流 |
| ARC-11 | Job status transition: `ready -> running -> blocked` | §7.2 State transitions | 已纳入本工作流 |
| ARC-12 | Job status transition: `running -> cancelled` | §7.2 State transitions | 已纳入本工作流 |
| ARC-13 | Run status transitions: all existing paths preserved | §7.2 State transitions | 已纳入本工作流 |

### 2.3 From MVP Contracts

| # | Clause | Source | Status |
|---|--------|--------|--------|
| MVC-1 | `state.json` 只能由 Engine 通过 State Store 写入 | §2.3 Run State Contract | 已纳入本工作流 |
| MVC-2 | 写入顺序为 append event 后原子替换 state snapshot | §2.3 Run State Contract | 已纳入本工作流 |
| MVC-3 | `state.last_event_id` 必须与 event log 尾部一致 | §2.3 Run State Contract | 已纳入本工作流 |
| MVC-4 | State 损坏或 event/state 不一致时，CLI 不得继续推进 run | §2.3 Run State Contract | 规范不适用（WF-7.1 does not change integrity check logic） |
| MVC-5 | `jobs[*].status` / `attempt` / `current_step` / `retry_*` / `activation*` / `step_visits` 只能由 Engine 内部写入 | §2.3 Run State Contract 写者职责 | 已纳入本工作流 |
| MVC-6 | `jobs[*].outputs` 只能通过 Engine acceptAgentReport 写入 | §2.3 Run State Contract 写者职责 | 已纳入本工作流 |
| MVC-7 | acceptAgentReport 处理顺序: parse+schema -> outputs -> contextPatches -> statusReturn -> signals -> advanceJob | §2.6 Agent Report Contract | 规范不适用（WF-7.1 does not change acceptAgentReport pipeline） |
| MVC-8 | context_patches 触及保留字段（jobs/signals/attempts/last_event_id 等）一律拒绝 | §2.6 Agent Report Contract | 规范不适用（WF-7.1 does not change context patch validation） |
| MVC-9 | Event MUST include: id, run_id, type, timestamp, producer, job, step, attempt, payload | §2.4 Event Contract | 已纳入本工作流 |

---

## 3. Test Case Coverage Matrix

### Test File 1: `tests/engine/attempt-model.test.ts` -- State Machine and Logic

| ID | Test | Covered FP | Category |
|----|------|------------|----------|
| T-AM-1 | `deriveJobConclusion` returns `"success"` when last attempt is success | FP-4.2 | Pure function |
| T-AM-2 | `deriveJobConclusion` returns `"failure"` when last attempt failed and `onExceeded = "failed"` | FP-4.2 | Pure function |
| T-AM-3 | `deriveJobConclusion` returns `"blocked"` when last attempt failed and `onExceeded = "blocked"` (default) | FP-4.2 | Pure function |
| T-AM-4 | `deriveJobConclusion` returns `"cancelled"` when last attempt is cancelled | FP-4.2 | Pure function |
| T-AM-5 | `deriveJobConclusion` returns `"failure"` for empty attempts array (defensive) | FP-4.2 | Edge case |
| T-AM-6 | `retryPolicyAllowsRetry` returns true for transient kind when `when` is absent (default) | FP-3.2 | Pure function |
| T-AM-7 | `retryPolicyAllowsRetry` returns false for `config_error` when `when` is absent | FP-3.2 | Pure function |
| T-AM-8 | `retryPolicyAllowsRetry` with explicit `when: ["timeout"]` only allows timeout | FP-3.2 | Pure function |
| T-AM-9 | `retryPolicyAllowsRetry` with empty `when: []` returns false for all kinds | FP-3.2 | Pure function |
| T-AM-10 | `retryPolicyAllowsRetry` treats unknown failure kind as `agent_error` for matching | FP-3.2 | Edge case |
| T-AM-11 | `retryPolicyAllowsRetry` returns false when attempt >= max_attempts (exhausted check outside policy) | FP-3.4 | Pure function |
| T-AM-12 | FailureKind type accepts the 7 well-known values at compile time | FP-2.1 | Type-level |
| T-AM-13 | FailureKind type accepts custom strings (extension slot) | FP-2.2 | Type-level |
| T-AM-14 | `WELL_KNOWN_FAILURE_KINDS` contains exactly 7 values | FP-2.1 | Constants |
| T-AM-15 | `TRANSIENT_FAILURE_KINDS` contains exactly 3 values | FP-2.3 | Constants |
| T-AM-16 | Attempt record is deeply immutable after construction with terminal status | FP-1.3 | Data model |
| T-AM-17 | `createOpenAttempt` produces record with unset ended_at and step_count=0 | FP-1.2 | Factory function |
| T-AM-18 | `sealAttempt` sets ended_at and step_count; produces correct status | FP-1.2 | Factory function |
| T-AM-19 | `classifyFailureKind` maps existing `errorType` values to FailureKind | FP-2.1 | Mapping fn |
| T-AM-20 | `classifyFailureKind` defaults to `"agent_error"` for undefined errorType | FP-2.3 | Mapping fn |
| T-AM-21 | Attempt number is 1-based and monotonic within a job | FP-1.1 | Data model |
| T-AM-22 | `RetryPolicy.on_exceeded` defaults to `"blocked"` when absent | FP-3.3 | Pure function |

### Test File 2: `tests/engine/attempt-events.test.ts` -- Event Emission and Backward Compatibility

| ID | Test | Covered FP | Category |
|----|------|------------|----------|
| T-AE-1 | `attempt_started` event is emitted with correct payload when job first becomes running | FP-5.1, FP-6.1 | Event emission |
| T-AE-2 | `attempt_completed` event is emitted when job completes successfully | FP-5.2, FP-6.1 | Event emission |
| T-AE-3 | `attempt_failed` event is emitted when job fails with failure_kind populated | FP-5.3, FP-6.1 | Event emission |
| T-AE-4 | `attempt_failed` event is emitted with `failure_kind = "cancelled"` when job is cancelled | FP-5.4, FP-6.1 | Event emission |
| T-AE-5 | On retry, old attempt is sealed with `attempt_failed` and new attempt gets `attempt_started` | FP-5.5, FP-6.1 | Event emission |
| T-AE-6 | `attempt_started` timestamp matches Attempt `started_at` (same clock call) | FP-5.6 | Timing sync |
| T-AE-7 | `attempt_completed` timestamp matches Attempt `ended_at` (same clock call) | FP-5.6 | Timing sync |
| T-AE-8 | `job_failed` event payload includes `failure_kind` when triggered by attempt exhaustion | FP-6.2 | Backward compat |
| T-AE-9 | `job_blocked` event payload includes `failure_kind` when triggered by attempt exhaustion | FP-6.2 | Backward compat |
| T-AE-10 | `job_retrying` event payload includes `failure_kind` (backward compat, still emitted) | FP-6.2 | Backward compat |
| T-AE-11 | Old `retry_job` router action produces `attempt_failed` + `attempt_started` events alongside `job_retrying` | FP-7.1 | Backward compat |
| T-AE-12 | `JobState.attempt` scalar is updated alongside `attempts` array | FP-7.2 | Backward compat |
| T-AE-13 | `JobState.attempts` array is appended on new attempt (never mutated in place) | FP-1.3 | Data model |
| T-AE-14 | Step-level events (`step_started`, `step_completed`, `step_failed`) continue to carry `attempt` number in payload | FP-1.2 | Backward compat |
| T-AE-15 | `retry_reason` and `retry_inputs` on JobState are set alongside the corresponding Attempt fields | FP-7.3 | Backward compat |
| T-AE-16 | `step_visits` are cleared when a retry creates a new attempt | FP-3.4, ARC-7 | State mutation |

---

## 4. Test Design Notes (Red Phase)

### Test File 1: `attempt-model.test.ts`

This file tests pure functions and type-level contracts. It does NOT require filesystem or engine infrastructure. All functions under test are new exports that do not yet exist in the codebase. Expected imports in green phase:

- `src/run/index.ts` -- `Attempt`, `FailureKind`, `RetryPolicy`, `JobConclusion`, `WELL_KNOWN_FAILURE_KINDS`, `TRANSIENT_FAILURE_KINDS`
- A new module or exported helpers from `src/engine/` that provide:
  - `deriveJobConclusion(attempts, onExceeded)` -- pure function
  - `retryPolicyAllowsRetry(policy, failureKind, attempt, maxAttempts)` -- pure function
  - `classifyFailureKind(errorType?)` -- mapping from old `errorType` to new `FailureKind`
  - `createOpenAttempt(number, startedAt, reason?)` -- factory
  - `sealAttempt(attempt, status, endedAt, stepCount, opts?)` -- factory

**Red-phase strategy:** Since these functions do not yet exist, tests will import from a placeholder barrel that will be created in the green phase. Tests use `describe`/`it` blocks with specific assertions that will fail because the imports resolve to nothing or throw. The pattern follows `tests/engine/retry.test.ts` and `tests/engine/recordAgentFailure.test.ts`.

### Test File 2: `attempt-events.test.ts`

This file tests engine integration: event emission and state mutation through Engine entry points. It requires filesystem (temp dirs) and the Engine's `createRun`, `runAll`, and related entry points.

**Red-phase strategy:** Tests create runs using the existing `createRun` engine entry point (which does exist), but the attempt-related event types and state fields do not yet exist. Tests will:

1. Create a run with the existing Engine
2. Assert that `attempt_started` / `attempt_completed` / `attempt_failed` events appear (they won't -- RED)
3. Assert that `JobState.attempts` array exists (it won't -- RED)
4. Assert that `failure_kind` appears in `job_failed` / `job_blocked` / `job_retrying` payloads (it won't -- RED)

Tests that need to import types/functions that don't yet exist will use type-only imports or `@ts-expect-error` with descriptive comments for the red phase.

### Compilation Constraint

The test files must compile (no syntax or import-resolution errors) but every test should fail for a structural reason -- missing field, wrong event type, unknown function export. No test should pass incidentally.

---

## 5. Test Fixture Workflows

Both test files will use inline YAML workflow fixtures (string templates), following the convention in `tests/engine/retry.test.ts`:

```yaml
# Basic retry workflow
name: test-attempt-model
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: code
        type: script
        run: "echo hello"
```

```yaml
# Workflow with on_exceeded: failed
name: test-on-exceeded
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 1
      on_exceeded:
        status: failed
    steps:
      - id: code
        type: script
        run: "echo hello"
```

No new skill packs or external fixture files are needed.
