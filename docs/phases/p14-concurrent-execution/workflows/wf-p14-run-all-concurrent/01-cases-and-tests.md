# WF-P14-RUN-ALL-CONCURRENT — Cases and Tests

**Status:** Step 1 (Cases and Tests)
**Date:** 2026-06-28
**Phase:** P14: Concurrent Read-Only Job Execution
**Author:** Step 1 Designer
**Dependencies:** WF-P14-SCHEDULER (merged), WF-P14-LOCKS (merged)

---

## 1. Slice Boundary

| Field | Value |
|---|---|
| **Slice name** | WF-P14-RUN-ALL-CONCURRENT |
| **Bounded context** | Engine / Run Control |
| **User tasks** | 2 ("用户可通过 --parallelism N 控制并发度", "用户可通过 --fail-fast 控制失败传播策略") |
| **Planned test files** | 2 maximum |
| | `tests/engine/runAll-concurrent.test.ts` — happy path, fail-fast, writable queueing |
| | `tests/dogfood/run-all-parallel.test.ts` — end-to-end with fake backend stubs |
| **Planned source changes** | `src/engine/runAll.ts` (main loop refactor), `src/commands/run-all.ts` (CLI params) |

**Scope:** Refactor the main execution loop in `runAll.ts` from sequential (one job per iteration) to scheduler-driven concurrent (`Promise.allSettled` batch execution). Add `--parallelism`/`--fail-fast` CLI parameters. Add `batch_id` to all event payloads emitted during batch execution.

**Out of scope:**
- writable job parallel execution (v0.3)
- Step-level concurrency overrides (AD-P14-008)
- Real backend rate limiting
- Preemptive cancellation (v0.3 stretch)

---

## 2. Function Contract Changes

### 2.1 Updated RunAllOpts

```ts
export interface RunAllOpts {
  // ... existing fields (task, runId, workflowPath, etc.) ...
  
  /** Maximum concurrent job count (default 4 per AD-P14-007). */
  parallelism?: number;
  
  /** Enable fail-fast abort propagation (default false per AD-P14-005). */
  failFast?: boolean;
}
```

### 2.2 Updated executeJobOnce Signature

```ts
/**
 * Execute one step of a single job. Returns a structured result.
 * Does NOT call scheduler or manage loop control — that is runAll's job.
 */
export async function executeJobOnce(ctx: {
  runDir: string;
  runId: string;
  zigmaflowDir: string;
  jobId: string;
  wf: WorkflowDefinition;
  state: RunState;
  backendResolver: (stepBackendName?: string) => AgentBackend;
  stateStore: LocalStateStore;
  eventWriter: JsonlEventWriter;
  clock: Clock;
  signal?: AbortSignal;       // per-job AbortSignal for fail-fast
  batchId: string;             // batch_id for events emitted by this execution
  onEvent?: (e: ZigmaFlowEvent) => void;
}): Promise<JobStepResult>;

export interface JobStepResult {
  jobId: string;
  success: boolean;
  action: "completed" | "retried" | "failed" | "cancelled" | "blocked" | "skipped";
  detail?: string;
}
```

### 2.3 Batch Execution Loop (AD-P14-004)

```
while (!terminal(state) && iterations < maxIterations) {
  const batch = selectExecutable({ state, workflow: wf, config });
  
  if (batch.jobs.length === 0) {
    if (allTerminalOrWaiting(state)) break;
    continue; // or short backoff
  }
  
  const batchId = randomUUID();
  
  const results = await Promise.allSettled(
    batch.jobs.map(j => 
      executeJobOnce({ ...ctx, jobId: j.jobId, batchId, signal: j.controller.signal })
    )
  );
  
  // Post-batch: handle fail-fast, record failures, update state
  // Read fresh state for next iteration
  state = await stateStore.readSnapshot(runDir);
}
```

### 2.4 batch_id on Events (AD-P14-006)

All events emitted during batch execution include an optional `batch_id` field in their payload:

```ts
// Each event payload gains:
{ batch_id?: string }
```

The `batch_id` is a UUID v4 string, identical for all events in the same batch. It is present only for events emitted during concurrent batch execution (not for pre-existing events like `run_created` or `job_ready` that are emitted before the concurrent loop).

### 2.5 fail-fast Strategy (AD-P14-005)

- **`failFast = false` (default):** Failed jobs in a batch go through `recordAgentFailure`. Other jobs in the batch complete normally. Next iteration recalculates via scheduler.
- **`failFast = true`:** Each job in the batch gets an independent `AbortController`. If any job fails, the runAll loop calls `controller.abort()` on all other jobs in the batch. Jobs that abort via signal emit `agent_cancelled` with `reason="fail_fast"`.
- **Cancelled jobs do NOT increment retry count.** Only `agent_failed` triggers retry logic. `agent_cancelled(fail_fast)` preserves state without retry.

### 2.6 CLI Parameters (AD-P14-007)

```ts
// src/commands/run-all.ts — RunAllOptions gains:
export interface RunAllOptions {
  // ... existing fields ...
  
  /** Maximum concurrent job count. Default from config or 4. */
  parallelism?: number;
  
  /** Enable fail-fast abort propagation. Default false. */
  failFast?: boolean;
}
```

---

## 3. Use Case Table

### A. Main Loop Refactoring (AD-P14-004)

| # | Use Case | Preconditions | Expected Behavior |
|---|---|---|---|
| UC-CONCURRENT-RO | 3 read-only ready jobs, parallelism=4 | All 3 execute concurrently in a single batch | 3 jobs all complete; monotonic counter shows same entry tick for all 3 |
| UC-CONCURRENT-W-QUEUE | 1 writable + 2 read-only ready, parallelism=4, no writable running | Writable + both read-only in same batch | 3 jobs execute concurrently; writable alongside read-only |
| UC-CONCURRENT-W-LOCKED | 1 writable running + 2 read-only ready, parallelism=4 | Only read-only jobs enter the batch (writable lock held) | 2 read-only execute concurrently; writable ready job queued for next batch |
| UC-CONCURRENT-ITERATION | After batch completes, more jobs become ready (deps satisfied) | Next iteration re-evaluates state via scheduler | New ready jobs picked up in subsequent batch |
| UC-CONCURRENT-MULTI-BATCH | 6 read-only ready, parallelism=2 | First batch: 2 jobs. After they complete, second batch: next 2 jobs, etc. | 3 batches total (2+2+2), each with distinct batch_id |
| UC-CONCURRENT-SCRIPT | 2 script-step ready jobs, parallelism=4 | Script/check/router steps also execute via concurrent batches | Both script jobs execute; monotonic counter shows concurrent entry |
| UC-CONCURRENT-SINGLE | 1 ready job, parallelism=4 | Batch of size 1 created | Job executes normally (no concurrency but goes through same path) |

### B. fail-fast Behavior (AD-P14-005)

| # | Use Case | Preconditions | Expected Behavior |
|---|---|---|---|
| UC-FAILFAST-FALSE | 3 ready jobs in batch, 1 fails | failFast=false (default) | 2 healthy jobs complete; failed job goes through recordAgentFailure; next iteration re-evaluates |
| UC-FAILFAST-TRUE | 3 ready jobs in batch, 1 fails | failFast=true | Failing job's error triggers abort on other 2 controllers; cancelled jobs emit agent_cancelled with reason="fail_fast" |
| UC-FAILFAST-CANCELLED-RETRY | Job cancelled via fail-fast | failFast=true, one job failed, others got abort signal | Cancelled jobs do NOT increment retry count; only agent_failed triggers retry path |
| UC-FAILFAST-ABORT | Job in mid-execution receives AbortSignal | failFast=true, peer job failed | The backend.execute call is passed an AbortSignal; the job emits agent_cancelled not agent_failed |

### C. batch_id on Events (AD-P14-006)

| # | Use Case | Preconditions | Expected Behavior |
|---|---|---|---|
| UC-BATCH-ID | 3 read-only ready, parallelism=4 | Each batch generates a UUID batch_id | All events emitted during batch execution include `batch_id` in payload |
| UC-BATCH-ID-DISTINCT | 2 consecutive batches | Different batch iterations | Each batch has a distinct batch_id; no overlap |

### D. CLI Parameters (AD-P14-007)

| # | Use Case | Preconditions | Expected Behavior |
|---|---|---|---|
| UC-CLI-PARALLELISM | `--parallelism 2` passed to runAllAction | runAll receives parallelism=2 in opts | SchedulerConfig.parallelism = 2; at most 2 jobs per batch |
| UC-CLI-FAILFAST | `--fail-fast` flag passed | runAll receives failFast=true | failFast enabled; batch failure triggers abort propagation |
| UC-CLI-DEFAULTS | No CLI flags passed | Neither --parallelism nor --fail-fast specified | parallelism defaults to 4; failFast defaults to false |

---

## 4. Spec Compliance Matrix

### 4.1 AD-P14-004 (runAll Concurrent Main Loop)

| Clause | Description | Status | Covered By |
|---|---|---|---|
| AD-P14-004.MUST.1 | Main loop calls `selectExecutable` to get batch | MUST | UC-CONCURRENT-RO, UC-CONCURRENT-MULTI-BATCH |
| AD-P14-004.MUST.2 | Jobs in batch execute via `Promise.allSettled` | MUST | UC-CONCURRENT-RO (monotonic counter proves concurrent entry) |
| AD-P14-004.MUST.3 | Not `Promise.all` — single failure must not reject the promise | MUST | UC-FAILFAST-FALSE (other jobs still complete) |
| AD-P14-004.MUST.4 | Empty batch + all waiting/inactive → break loop | MUST | UC-CONCURRENT-ITERATION (next iteration re-evaluates) |
| AD-P14-004.MUST.5 | `executeJobOnce` does not call scheduler | MUST | Unit test verifies executeJobOnce only advances one job |
| AD-P14-004.MUST.6 | Each iteration reads fresh state snapshot | MUST | UC-CONCURRENT-ITERATION |
| AD-P14-004.MUST.7 | Script/check/router steps also go through concurrent batches | MUST | UC-CONCURRENT-SCRIPT |

### 4.2 AD-P14-005 (fail-fast Strategy)

| Clause | Description | Status | Covered By |
|---|---|---|---|
| AD-P14-005.MUST.1 | `failFast=false` (default): failed job → recordAgentFailure, others continue | MUST | UC-FAILFAST-FALSE |
| AD-P14-005.MUST.2 | `failFast=true`: first failure → abort all other controllers in batch | MUST | UC-FAILFAST-TRUE |
| AD-P14-005.MUST.3 | Aborted jobs emit `agent_cancelled` with `reason="fail_fast"` | MUST | UC-FAILFAST-ABORT |
| AD-P14-005.MUST.4 | `agent_cancelled` via fail-fast does NOT increment retry count | MUST | UC-FAILFAST-CANCELLED-RETRY |
| AD-P14-005.MUST.5 | Each job in batch gets independent AbortController | MUST | UC-FAILFAST-TRUE (only peer jobs aborted, not the failing job via own signal) |

### 4.3 AD-P14-006 (Concurrent Event ID & Ordering)

| Clause | Description | Status | Covered By |
|---|---|---|---|
| AD-P14-006.MUST.1 | Event payloads include optional `batch_id` (uuid string) | MUST | UC-BATCH-ID |
| AD-P14-006.MUST.2 | All events in same batch share the same `batch_id` | MUST | UC-BATCH-ID (assert all events from batch have identical batch_id) |
| AD-P14-006.MUST.3 | Different batches have distinct `batch_id` | MUST | UC-BATCH-ID-DISTINCT |
| AD-P14-006.MUST.4 | `nextSequentialEventId` still guarantees monotonic IDs | MUST | Event order assertion (evt-001, evt-002, ... monotonic) |
| AD-P14-006.MUST.5 | No concurrent event writing — events still serialized via AsyncQueue | MUST | Inherited from WF-P14-LOCKS; not re-tested here |

### 4.4 AD-P14-007 (Default Parallelism)

| Clause | Description | Status | Covered By |
|---|---|---|---|
| AD-P14-007.MUST.1 | `--parallelism N` CLI parameter accepted | MUST | UC-CLI-PARALLELISM |
| AD-P14-007.MUST.2 | Default parallelism = 4 when not specified | MUST | UC-CLI-DEFAULTS |
| AD-P14-007.MUST.3 | `--fail-fast` CLI flag accepted | MUST | UC-CLI-FAILFAST |

### 4.5 WF-P14-RUN-ALL-CONCURRENT Acceptance Criteria (from plan §5)

| Acceptance Criterion | Covered By |
|---|---|
| Workflow with 3 read-only ready jobs, fake backend, total time < 100ms (concurrency evidence) | UC-CONCURRENT-RO (monotonic counter, not wall clock) |
| 1 writable + 2 read-only ready, writable runs first then read-only also complete | UC-CONCURRENT-W-QUEUE, UC-CONCURRENT-W-LOCKED |
| fail-fast=true: one failure → other job receives abort, event includes `agent_cancelled` reason="fail_fast" | UC-FAILFAST-TRUE, UC-FAILFAST-ABORT |
| fail-fast=false: one failure does not affect other jobs | UC-FAILFAST-FALSE |

---

## 5. Test Plan Summary

### 5.1 Test File 1: `tests/engine/runAll-concurrent.test.ts`

**Framework:** vitest (`describe`/`it`/`expect`)

**Strategy:**
- Minimal fake workflow (3 read-only agent jobs) + fake backend that immediately resolves
- Monotonic counter to assert concurrent execution (jobs with same counter tick entered concurrently)
- `AbortController` for fail-fast signal propagation tests
- Injectable `FakeStateStore` and `FakeEventWriter` for capturing state writes and events
- No `setTimeout` or real wall-clock assertions — deterministic monotonic counter only

**Test suites:**

| Suite | Tests | Coverage |
|---|---|---|
| Concurrent happy path — 3 read-only jobs execute together | 1 | UC-CONCURRENT-RO |
| Writable + read-only in same batch (no writable running) | 1 | UC-CONCURRENT-W-QUEUE |
| Writable lock held — only read-only in batch | 1 | UC-CONCURRENT-W-LOCKED |
| Multi-batch iteration (parallelism=2, 6 ready) | 1 | UC-CONCURRENT-MULTI-BATCH |
| Script steps through concurrent batches | 1 | UC-CONCURRENT-SCRIPT |
| Single job batch (parallelism degrades gracefully) | 1 | UC-CONCURRENT-SINGLE |
| fail-fast=false — peer jobs continue on failure | 1 | UC-FAILFAST-FALSE |
| fail-fast=true — abort propagates to other jobs | 1 | UC-FAILFAST-TRUE |
| fail-fast cancelled does NOT increment retry | 1 | UC-FAILFAST-CANCELLED-RETRY |
| batch_id present on all events in concurrent batch | 1 | UC-BATCH-ID |
| Different batches have distinct batch_id | 1 | UC-BATCH-ID-DISTINCT |

**Total: ~11 test cases**

### 5.2 Test File 2: `tests/dogfood/run-all-parallel.test.ts`

**Framework:** vitest (`describe`/`it`/`expect`)

**Strategy:**
- Simulates the code-change workflow job DAG: intake -> code-map + risk-scan (parallel-ready)
- Uses fake backend stubs that record call order via monotonic counter
- Asserts code-map and risk-scan entered at the same counter tick (concurrent)
- Asserts architecture-design stays inactive until signal activates it
- No wall-clock assertions — all concurrency verified via monotonic counter

**Test suites:**

| Suite | Tests | Coverage |
|---|---|---|
| code-map + risk-scan execute concurrently | 1 | UC-CONCURRENT-RO (dogfood) |
| architecture-design stays inactive until signal | 1 | Workflow signal behavior preserved under concurrency |
| Full dogfood DAG runs without losing jobs | 1 | Regression: all 9 active jobs reach completed |
| Parallelism CLI parameter limits batch size | 1 | UC-CLI-PARALLELISM (end-to-end) |

**Total: ~4 test cases**

**Overall total: ~15 test cases across 2 files**

---

## 6. Monotonic Counter Protocol

Per plan §8, all concurrency tests use a monotonic counter instead of wall-clock timers:

```ts
/**
 * MonotonicCounter records the order and "tick" of backend.execute() calls.
 *
 * - `enter()` increments the counter and returns the new value.
 * - Jobs that call `enter()` "at the same time" (before any await) get
 *   the same tick value because the counter was incremented in the same
 *   synchronous block (Promise.allSettled fires all map callbacks
 *   synchronously before any await).
 * - Assertions: jobs in the same batch have the same tick value.
 */
class MonotonicCounter {
  private _value = 0;
  enter(): number {
    this._value++;
    return this._value;
  }
  get current(): number {
    return this._value;
  }
}
```

**Assertion pattern:**
```ts
// After runAll completes:
expect(codeMapEntryTick).toBe(riskScanEntryTick); // same tick = concurrent
expect(codeMapEntryTick).toBeLessThan(implementEntryTick); // later tick = later batch
```

**IMPORTANT:** The monotonic counter assertion works because `Promise.allSettled` fires all `.map()` callbacks synchronously before any promise settles. If the fake backend is synchronous (returns a pre-resolved promise or immediately resolves), all `enter()` calls happen in the same synchronous block and thus get sequential counter values. To detect true concurrency, the counter must be incremented INSIDE the fake backend's `execute()` method, and the assertion checks that the VALUES are within the batch range, not that they are literally equal.

Actual implementation: Since fake backends resolve synchronously (return `{ success: true }` immediately), the counter increments will be sequential even under `Promise.allSettled`. Instead, use a **tick-based** approach:

```ts
class FakeBackend {
  private callOrder: number[] = [];
  
  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    const tick = counter.enter(); // increments synchronously
    this.callOrder.push(tick);
    // ... synchronously return success
    return { success: true, reportPath: opts.reportPath };
  }
}
```

Then assert that jobs in the same batch were all called before any job from the next batch (their ticks form a contiguous block):

```ts
// Jobs from batch 1 have ticks [1, 2, 3]
// Jobs from batch 2 have ticks [4, 5, 6]
// Contiguity proves batch grouping (no interleaving across batches)
```

---

## 7. Error Conditions

| Condition | Behavior |
|---|---|
| `parallelism < 1` | Clamped to 1 (or throw ValidationError) |
| `failFast=true` but batch has only 1 job | No other jobs to abort; fails normally |
| `failFast=true` and multiple jobs fail in same batch | First failure triggers abort; subsequent failures from aborted jobs emit `agent_cancelled` (reason="fail_fast"), not `agent_failed` |
| `failFast=true` and all jobs fail | Worst case: all jobs fail or cancel; run terminates with "failed" or "blocked" status |
| Backend throws (unexpected exception) instead of returning `{ success: false }` | `Promise.allSettled` catches the rejection; treated as failure |
| `AbortController` already aborted before job starts | Job skips execution, emits `agent_cancelled` immediately |
| `signal` (external abort, e.g. SIGINT) arrives during batch execution | External signal propagates to all jobs; run cancels |

---

## 8. Design Questions / Open Items

1. **Q:** Should `executeJobOnce` be extracted from `runAll` as a standalone export, or remain internal to the module?
   **A:** As a standalone export — it must be testable independently and has a clear contract (`JobStepResult`).

2. **Q:** How should the `batch_id` be threaded through `executeJobOnce` to event writers?
   **A:** Pass `batchId` in the context object. Each event emission helper (prompt_generated, agent_invoked, etc.) accepts `batchId?: string` and includes it in the payload.

3. **Q:** Should the `batch_id` be a required field on payloads or optional?
   **A:** Optional per AD-P14-006 ("payload 增加可选 batch_id"). Events emitted outside the concurrent loop (e.g., `run_created` during createRun) do not have a batch_id.
