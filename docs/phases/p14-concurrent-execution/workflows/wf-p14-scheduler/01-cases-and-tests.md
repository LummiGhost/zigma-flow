# WF-P14-SCHEDULER — Cases and Tests

**Status:** Step 1 (Cases and Tests)
**Date:** 2026-06-28
**Phase:** P14: Concurrent Read-Only Job Execution
**Author:** Step 1 Designer

---

## 1. Slice Boundary

| Field | Value |
|---|---|
| **Slice name** | WF-P14-SCHEDULER |
| **Bounded context** | Engine / Scheduling |
| **User tasks** | N/A (pure function internal to Engine, not user-facing) |
| **Planned test files** | 1 (`tests/engine/scheduler.test.ts`) |
| **Planned source file** | `src/engine/scheduler.ts` (Step 2) |

**Scope:** Only the `selectExecutable` pure function. Does not modify runAll, does not write files, does not call any backend. The function is deterministic given its inputs.

**Dependencies (all read-only):**
- `src/run/index.ts` → `RunState`, `JobState` types
- `src/workflow/index.ts` → `WorkflowDefinition`, `JobDefinition` types
- No IO, no async

---

## 2. Function Contract

### 2.1 Types

```ts
/** Input to the scheduler — all data passed by caller. */
export interface SchedulerInput {
  /** The current run state snapshot (already deserialized from state.json). */
  state: RunState;
  /** The parsed workflow definition that owns the jobs. */
  workflow: WorkflowDefinition;
  /** Execution parameters. */
  config: SchedulerConfig;
}

export interface SchedulerConfig {
  /** Maximum number of jobs allowed to run concurrently. Must be >= 1. */
  parallelism: number;
  /** Hard limit on simultaneously running writable jobs (always 1 per AD-P14-002). */
  runningWritableLimit: 1;
}

/** The decision returned by selectExecutable. */
export interface ExecutableBatch {
  /** Jobs that should be executed in this batch (may be empty). */
  jobs: Array<{
    jobId: string;
    mode: "read-only" | "writable";
  }>;
  /** Human-readable explanation of the scheduling decision. */
  rationale: string;
}

export function selectExecutable(input: SchedulerInput): ExecutableBatch;
```

### 2.2 Deriving Job Mode

A job's mode is determined by its `workspace.mode` field on the `WorkflowDefinition`:

- `workspace.mode === "read-only"` → `"read-only"`
- Everything else (including `undefined`, `"writable"`, or any other value) → `"writable"`

This is a conservative default: unless explicitly marked read-only, the scheduler assumes the job may write and therefore must respect the writable lock.

### 2.3 Scheduling Rules (AD-P14-001)

The scheduler applies these rules in order:

1. **Collect ready jobs.** Filter `state.jobs` for entries with `status === "ready"`.
2. **Check running writable.** Look at all jobs in `state.jobs` with `status === "running"`. If any of them has mode `"writable"`, the writable lock is held.
3. **Fill with read-only.** From the ready pool, take jobs with mode `"read-only"`. Cap at `parallelism - count_of_running_read_only_jobs`.
4. **Add writable (if eligible).** If the read-only batch did not fill parallelism, AND no writable is running, add at most 1 writable job from the ready pool.
5. **Return batch.** Include the selected jobs and a `rationale` string describing why those jobs were chosen.

### 2.4 Edge Cases

- **Empty ready pool**: Return empty batch. Rationale: "No ready jobs available."
- **Parallelism = 0 or negative**: Invalid configuration. The scheduler assumes `parallelism >= 1`. (Validation of config is the caller's responsibility per AD-P14-001; the scheduler treats parallelism < 1 as 0 available slots.)
- **Parallelism = 1**: At most 1 job per batch. If a writable is running, no batch can start. If no writable is running, the single slot goes to a read-only first; if none ready, a writable.
- **Running writable + writable only ready**: Empty batch (no read-only and writable lock is held). Rationale explains the writable is queued.
- **All read-only already running**: readiness count equals parallelism minus running count → empty batch. No free slots.
- **Multiple writables ready**: Only 1 writable selected per batch, regardless of how many are ready. The rest wait for subsequent batches.
- **Job without `workspace` field in definition**: Treated as writable (conservative default).
- **Job with `workspace.mode: "writable"` explicitly**: Treated as writable.

---

## 3. Use Case Table

| # | Use Case | Preconditions | Expected Batch |
|---|---|---|---|
| UC-EMPTY | No ready jobs | All jobs in other states (waiting, running, done, etc.) | Empty batch |
| UC-RO-ONLY | Read-only only, no writable | 4 read-only ready, parallelism=4, no running jobs | 4 read-only |
| UC-MIXED | Mixed RO + writable, no writable running | 3 RO + 1 W ready, parallelism=4, no running | 3 RO + 1 W (4 total) |
| UC-W-LOCKED | Mixed, but writable already running | 3 RO + 1 W ready, parallelism=4, 1 W running | 3 RO only (writable queued) |
| UC-W-ONLY | Writable only, no writable running | 1 W ready, parallelism=4, no running | 1 W |
| UC-PARALLEL-1 | Parallelism = 1 | 3 RO + 1 W ready, parallelism=1, no running | 1 RO (read-only preferred) |
| UC-PARALLEL-EXCEEDS | Parallelism > ready count | 2 RO ready, parallelism=8, no running | 2 RO |
| UC-RO-RUNNING | Read-only already running consumes slots | 2 RO running, 4 RO ready, parallelism=4 | 2 RO (4-2 free slots) |
| UC-MULTI-W | Multiple writables ready, none running | 2 W ready, parallelism=4, no running | 1 W (write lock limits to 1) |
| UC-W-LOCKED-W-ONLY | Writable running, writable only ready | 1 W running, 2 W ready, parallelism=4 | Empty (writable lock held, no RO to fill) |
| UC-RUNNING-FULL | All slots filled by running jobs | 4 RO running, 2 RO ready, parallelism=4 | Empty (0 free slots) |
| UC-DEFAULT-W | Job without workspace.mode treated as writable | 1 job (no workspace) ready, no running, parallelism=4 | 1 W |
| UC-EXPLICIT-W | Job with workspace.mode="writable" explicitly | 1 W ready, no running, parallelism=4 | 1 W |
| UC-RO-W-RUNNING | Single RO ready, writable running | 1 RO ready, 1 W running, parallelism=4 | 1 RO |
| UC-RO-PREFERENCE | Read-only preferred when slots limited | 2 RO + 2 W ready, parallelism=2, no running | 2 RO (writable only if slots remain) |

---

## 4. Spec Compliance Matrix

### 4.1 AD-P14-001 (Scheduler Pure Function)

| Clause | Description | Status |
|---|---|---|
| AD-P14-001.1 | Scheduler is a pure function with no IO | MUST — tested via import verification (only types imported) |
| AD-P14-001.2 | `selectExecutable` accepts `SchedulerInput` and returns `ExecutableBatch` | MUST — type-level contract tested |
| AD-P14-001.3 | Collect all jobs with `status: ready` | MUST — UC-EMPTY, UC-RO-ONLY, etc. |
| AD-P14-001.4 | Running writable check → restricts batch to read-only | MUST — UC-W-LOCKED, UC-W-LOCKED-W-ONLY |
| AD-P14-001.5 | Read-only capped at `parallelism - running_read_only` | MUST — UC-RO-RUNNING, UC-RUNNING-FULL |
| AD-P14-001.6 | Add 1 writable if read-only doesn't fill parallelism and no writable running | MUST — UC-MIXED, UC-W-ONLY, UC-MULTI-W |
| AD-P14-001.7 | Return `rationale` string | MUST — all test cases assert rationale is non-empty string |
| AD-P14-001.8 | Not called with filesystem or state.json | MUST — all test inputs are constructed in memory |

### 4.2 AD-P14-002 (Writer Lock Semantics)

| Clause | Description | Status |
|---|---|---|
| AD-P14-002.1 | At most 1 writable job running at a time | MUST — UC-W-LOCKED, UC-MULTI-W |
| AD-P14-002.2 | Writable lock is derived from RunState (running jobs) + WorkflowDefinition (mode) | MUST — scheduler checks both sources |
| AD-P14-002.3 | No OS file lock; in-process only | MUST — pure function, no fs access |

### 4.3 §3.1 In-scope Table

| Scope Item | Status |
|---|---|
| New `src/engine/scheduler.ts` with `selectExecutable` | Test file created for it; source to be written in Step 2 |
| Writer lock: 1 writable running max | Covered by UC-W-LOCKED, UC-MULTI-W, UC-W-LOCKED-W-ONLY |

### 4.4 §5 WF-P14-SCHEDULER Acceptance Criteria

| Acceptance Criterion | Covered By |
|---|---|
| Only read-only ready | UC-RO-ONLY |
| Read-only + writable mixed, writable already running | UC-W-LOCKED |
| Ready is empty | UC-EMPTY |
| Parallelism = 1 | UC-PARALLEL-1 |
| Parallelism = 8 while ready = 2 | UC-PARALLEL-EXCEEDS |
| No filesystem or state.json access | All tests — inputs constructed in memory |

---

## 5. Test Plan Summary

**Test file:** `tests/engine/scheduler.test.ts`

**Framework:** vitest (`describe`/`it`/`expect`)

**Strategy:**
- Every test constructs minimal `RunState` and `WorkflowDefinition` objects directly in the test body.
- No mock filesystem, no setup/teardown for state (tests are stateless and independent).
- `RunState.jobs` uses `Record<string, JobState>` with the exact `JobState.status` field.
- `WorkflowDefinition.jobs` uses `Record<string, JobDefinition>` with `workspace.mode`.

**Test suites:**

| Suite | Tests | Coverage |
|---|---|---|
| Scheduler contract (type-level smoke) | 1 | Verifies function exists and returns `ExecutableBatch` shape |
| Empty ready pool | 1 | UC-EMPTY |
| Read-only only scenarios | 2 | UC-RO-ONLY, UC-PARALLEL-EXCEEDS |
| Mixed read-only + writable (no lock) | 2 | UC-MIXED, UC-W-ONLY |
| Writable lock held scenarios | 3 | UC-W-LOCKED, UC-W-LOCKED-W-ONLY, UC-RO-W-RUNNING |
| Parallelism boundaries | 2 | UC-PARALLEL-1, UC-RUNNING-FULL |
| Running read-only slot consumption | 1 | UC-RO-RUNNING |
| Multiple writables ready | 1 | UC-MULTI-W |
| Workspace mode derivation | 2 | UC-DEFAULT-W, UC-EXPLICIT-W |
| Read-only preference over writable | 1 | UC-RO-PREFERENCE |

**Total: ~16 test cases** (including type smoke test)

**Exclusions:**
- No integration tests (these belong in WF-P14-RUN-ALL-CONCURRENT).
- No concurrency or timing tests (scheduler is pure function, timing irrelevant).
- No tests for `parallelism <= 0` edge case (caller validation per AD-P14-001).

---

## 6. Error Conditions

| Condition | Behavior |
|---|---|
| `state.jobs` is empty object | Empty batch (no ready jobs) |
| `workflow.jobs` is empty object | Empty batch (no job definitions to determine mode — but this is a degenerate workflow state) |
| A job exists in `state.jobs` but not in `workflow.jobs` | Skip it (no mode information available); the caller should ensure consistency |
| `config.parallelism` is 0 or negative | The scheduler uses `Math.max(0, parallelism)` internally, producing an empty batch since available slots are 0 |
| Job has `status: "ready"` but no corresponding `JobDefinition` in workflow | Job is silently skipped (treated as if not ready) |
