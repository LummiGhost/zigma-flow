# Research Report: Concurrency Group Integration

Date: 2026-07-16
Status: Resolved
Topic: R3 -- How concurrency groups (Issue #235) integrate with the existing read-only/writable parallelism model in the scheduler.

## Question

How should the Concurrency Group model (`group` key + `policy`: allow/queue/cancel_previous/reject) integrate with the existing pure-function scheduler (`src/engine/scheduler.ts`, AD-P14-001) without breaking the parallelism and writer-lock model for jobs that do not use concurrency groups?

## Options Evaluated

### A. Concurrency Group Scope

What is the "group key" for deduplication?

| Option | Description | Verdict |
|--------|-------------|---------|
| **A1: Static string** | `concurrency: { group: "workspace" }` -- all jobs with the same static group name share a concurrency slot. | **Selected** |
| A2: Expression-based | `concurrency: { group: "workspace-${{ inputs.repository }}" }` -- dynamic group key resolved at dispatch time. | Deferred to post-MVP |
| A3: Job-type-based | Implicit groups by job mode (read-only vs writable). | Rejected -- redundant with existing scheduler |

**Rationale for A1:** A static string covers the core MVP use case (e.g., "never run two deploy jobs concurrently"). Expression-based groups add complexity (expression evaluation at dispatch time requiring run-state context) and are not needed for the per-run, single-workflow MVP scope. Expression-based group keys can be layered on later without breaking the data model: just add expression evaluation to the key lookup in a future version. Option A3 is already handled by the existing read-only/writable parallelism model and would be semantic duplication.

### B. Integration with Existing Parallelism

How does the concurrency group policy interact with the `parallelism` setting?

| Option | Description | Verdict |
|--------|-------------|---------|
| **B1: Separate constraint layer** | First apply parallelism cap (as today), then apply concurrency group policy as a second filter on the batch. | **Selected** |
| B2: Concurrency group replaces parallelism | Matching jobs have their own cap, bypassing the parallelism setting. | Rejected |
| B3: Sub-cap within parallelism | Max N total, but at most 1 per group -- concurrency group as a stricter sub-limit. | Partially true (semantic overlap with B1) |

**Rationale for B1:** Parallelism is a system-wide resource constraint ("how many total jobs run at once"). Concurrency group is an application-level semantic constraint ("do not run two jobs from this logical group simultaneously"). These are orthogonal concerns. Layering them sequentially is the clearest mental model:

1. The scheduler first applies parallelism + writer-lock rules (exactly as it does today) to build a candidate batch.
2. Then, in a second pass, jobs in the candidate batch are checked against concurrency group policies. A job with `policy: queue` that has a running sibling in the same group is excluded from the batch.

This keeps the scheduler's pure-function contract intact and maintains backward compatibility: jobs without concurrency groups are unaffected by the second pass.

**Interaction rule sumarized:**

```
let batch = selectByParallelism(state, workflow, config)  // existing logic
batch = filterByConcurrencyPolicy(batch, state, workflow)  // NEW second pass
```

A job excluded by concurrency group filtering stays in "ready" state and is reconsidered in the next loop iteration (when the sibling may have completed).

### C. Policy Enforcement Point

Where in the execution flow is each concurrency policy enforced?

| Policy | Enforcement Point | Rationale |
|--------|-------------------|-----------|
| `allow` | N/A (no-op) | No restriction -- jobs proceed normally. |
| `queue` | In `selectExecutable` (scheduler, pure function) | The scheduler derives group state from the RunState snapshot and excludes ready jobs whose group has running members. No state mutation needed -- this is a pure filter. |
| `cancel_previous` | Pre-scheduler mutation step in `runAll` loop | Requires cancelling running jobs (state mutation + event emission). Must happen before `selectExecutable` so the mutated state is used for scheduling. After cancelling running siblings, the ready job proceeds as normal. |
| `reject` | Pre-scheduler mutation step in `runAll` loop | Requires failing the ready job (state mutation + event emission). The job transitions to "failed" and is removed from consideration. |

**Enforcement point architecture:**

```
runAll loop iteration:
  1. state = readSnapshot(runDir)
  2. [NEW] preProcessConcurrencyGroups(state, workflow)
     - For each ready job with cancel_previous:
         if group has running jobs → cancel running jobs (emit events, updateState)
     - For each ready job with reject:
         if group has running jobs → fail the ready job (emit events, updateState)
     - If mutations made: state = readSnapshot(runDir)  // re-read
  3. batch = selectExecutable({ state, workflow, config })
     - Inside selectExecutable: filter out ready jobs with queue policy
       when another job in the same group is running
  4. Execute batch (existing logic)
  5. iteration++
```

This three-layer split preserves the pure-function contract of `selectExecutable` while allowing the mutation-requiring policies (`cancel_previous`, `reject`) to operate in the impure `runAll` loop where they belong.

### D. Queue Policy Implementation

When `policy: queue`, how are queued jobs tracked and resumed?

| Option | Description | Verdict |
|--------|-------------|---------|
| **D1: Scheduler excludes; natural retry** | Jobs stay in "ready" status. The scheduler excludes them from the batch while a sibling runs. When the sibling completes, the next iteration's fresh state snapshot shows no running sibling, so the scheduler includes the queued job. | **Selected** |
| D2: Separate concurrency queue in RunState | A dedicated data structure tracks waiting jobs with ordering guarantees. | Rejected (over-engineered for MVP) |
| D3: Queued jobs transitioned to "waiting" | Queued jobs are marked "waiting" with a concurrency-specific dependency, unblocked by a post-completion hook. | Rejected (unnecessary complexity) |

**Rationale for D1:** This is the simplest approach with zero additional state tracking. The existing loop naturally handles it:

1. Iteration N: scheduler sees job-A running in group "deploy". Job-B is ready but also in group "deploy" with `policy: queue`. Scheduler excludes job-B from the batch.
2. Iteration N+1: scheduler sees job-A completed. Job-B is still ready and now selected.
3. No new state fields, no queue management, no ordering bugs. The loop's natural re-read of state at each iteration provides the "wake-up" mechanism.

**Potential concern:** Fairness -- if multiple jobs queue for the same group, which runs next? D1 provides no ordering guarantee (it depends on the order `Object.entries` iterates state.jobs). For MVP, this is acceptable. If fairness is needed later, the group key for `queue` could use FIFO ordering based on the ready-job insertion order (which is already deterministic from DAG topological ordering).

### E. cancel_previous Semantics

When a new job enters a `cancel_previous` group, what gets cancelled?

| Option | Description | Verdict |
|--------|-------------|---------|
| **E1: Cancel only currently-running jobs** | Cancels in-flight jobs in the same group. Completed and ready jobs are left unchanged. | **Selected** |
| E2: Cancel running + reset completed | Full reset of group state including completed jobs. | Rejected (violates immutability) |
| E3: Cancel running + skip pending | Cancel running AND mark all other ready jobs in the group as skipped. | Rejected (too aggressive) |

**Rationale for E1:** This is the only option consistent with v0.7's core design principle: engine state only advances forward. Completed jobs are immutable execution records -- they should never be mutated or "undone." The cancellation targets only in-flight work:

- **Running jobs in the same group:** Transition to "cancelled" with `job_cancelled` event (reason: `concurrency_cancel_previous`).
- **Other ready jobs in the same group:** Left alone. They will run when their turn comes (respecting their own concurrency policies).
- **Completed jobs in the same group:** Unaffected -- they are immutable historical records.
- **The triggering job:** Proceeds normally -- its concurrency slot is now free since the running sibling was cancelled.

**Edge case:** If the new job itself fails or is cancelled before starting, the previously-cancelled job is NOT restored. This is a deliberate simplification -- rollback would violate the forward-only state model.

## Recommendation

### High-Level Design

Concurrency groups are enforced as a **separate constraint layer** on top of the existing parallelism + writer-lock model. The integration uses a **three-layer enforcement strategy**:

1. **Pre-scheduler mutation** (`runAll` loop): Handle `cancel_previous` and `reject` policies by mutating state before scheduling.
2. **Scheduler filter** (`selectExecutable`, pure function): Handle `queue` policy by excluding ready jobs whose group has running members. Handle `allow` policy with no restriction.
3. **No work at executor level** -- all concurrency decisions made before job dispatch.

### Group Scope

- MVP: Static string group keys. Expression-based keys deferred to post-MVP.
- Scope: Per-run only (consistent with the development plan's open decision).

### Queue Policy

- Jobs stay in "ready" status.
- Scheduler excludes them when a sibling runs.
- Natural loop iteration picks them up when the slot frees.
- No new state data structures needed.

### cancel_previous Policy

- Cancels only currently-running jobs in the same group.
- Completed and other ready jobs are untouched.
- Aligned with forward-only state evolution.

## Proposed Data Model

### Workflow Definition Changes (`src/workflow/index.ts`)

```typescript
// New Zod schema for concurrency group configuration
const ConcurrencyGroupSchema = z.object({
  /** Static group key for deduplication. Jobs with the same group key
   *  share a concurrency slot governed by `policy`. */
  group: z.string().min(1),
  /** Concurrency policy for this group.
   *  - allow: No restriction (default).
   *  - queue: Serialize -- at most one job runs at a time in the group.
   *  - cancel_previous: Cancel running jobs in the group when a new job starts.
   *  - reject: Fail the new job if another is already running in the group.
   */
  policy: z.enum(["allow", "queue", "cancel_previous", "reject"]).default("queue"),
});

// TypeScript interface
export interface ConcurrencyGroupConfig {
  group: string;
  policy: "allow" | "queue" | "cancel_previous" | "reject";
}

// Added to JobSchema (in the Zod object)
const JobSchema = z.object({
  // ... existing fields ...
  /** Concurrency group configuration (v0.7). */
  concurrency: ConcurrencyGroupSchema.optional(),
});

// Added to JobDefinition interface
export interface JobDefinition {
  // ... existing fields ...
  concurrency?: ConcurrencyGroupConfig;
}
```

**Default behavior:** When `concurrency` is omitted, the job behaves exactly as it does today -- no concurrency group constraints. The existing parallelism and writer-lock rules apply unchanged.

### Scheduler Config Changes (`src/engine/scheduler.ts`)

```typescript
// SchedulerConfig is unchanged -- the concurrency group state is derived
// from state.jobs and workflow.jobs internally in selectExecutable.
// No new SchedulerInput fields are needed.
```

## Proposed Scheduler Changes

### `selectExecutable` Modifications

The scheduler remains a pure function. Changes are confined to a single new filtering step added between the current Step 1 (collect ready jobs) and Step 3 (fill batch):

```typescript
export function selectExecutable(input: SchedulerInput): ExecutableBatch {
  const { state, workflow, config } = input;
  const { parallelism } = config;

  // Step 1: Classify running jobs (existing -- unchanged)
  // ...

  // Step 2: Build concurrency group state from running jobs (NEW)
  // Map<groupKey, Set<runningJobId>>
  const runningByGroup = new Map<string, Set<string>>();
  for (const [id, js] of Object.entries(state.jobs)) {
    if (js.status === "running") {
      const cc = workflow.jobs[id]?.concurrency;
      if (cc) {
        const set = runningByGroup.get(cc.group);
        if (set) {
          set.add(id);
        } else {
          runningByGroup.set(cc.group, new Set([id]));
        }
      }
    }
  }

  // Step 3: Collect ready jobs (existing -- modified to filter by queue policy)
  const readyReadOnly: string[] = [];
  const readyWritable: string[] = [];

  for (const [id, js] of Object.entries(state.jobs)) {
    if (js.status === "ready") {
      // NEW: queue policy filter
      const cc = workflow.jobs[id]?.concurrency;
      if (cc && cc.policy === "queue") {
        const runningSiblings = runningByGroup.get(cc.group);
        if (runningSiblings && runningSiblings.size > 0) {
          // Another job in this group is running -- skip this job.
          // It stays "ready" and will be reconsidered next iteration.
          continue;
        }
      }
      // (cancel_previous and reject are handled pre-scheduler in runAll.
      // If a job with those policies reaches this point, it means no
      // running sibling exists, so treat as "allow".)

      // ... rest of existing classification logic ...
    }
  }

  // Steps 4-5: Build batch (existing -- unchanged)
  // ...
}
```

**Key properties preserved:**
- No IO -- pure function, same inputs always produce same outputs.
- No mutation of state.
- Backward compatible: jobs without `concurrency` field pass through the filter unchanged.
- Testable: given a snapshot state with running job-A in group "X" and ready job-B in group "X" with `policy: queue`, `selectExecutable` must not include job-B in the batch.

### Pre-Scheduler Logic in `runAll` Loop

Added before the `selectExecutable` call:

```typescript
// ── Pre-scheduler: concurrency group mutation policies ──────

let concurrencyMutations = 0;

for (const [jobId, js] of Object.entries(state.jobs)) {
  if (js.status !== "ready") continue;

  const cc = wf.jobs[jobId]?.concurrency;
  if (!cc) continue;

  if (cc.policy === "cancel_previous") {
    // Find running jobs in the same group
    const runningInGroup = Object.entries(state.jobs)
      .filter(([id, s]) =>
        s.status === "running" &&
        wf.jobs[id]?.concurrency?.group === cc.group
      );

    if (runningInGroup.length > 0) {
      for (const [rid] of runningInGroup) {
        // Cancel each running job in the group
        const evtId = await nextSequentialEventId(runDir, eventWriter);
        const evt: ZigmaFlowEvent = {
          id: evtId,
          type: "job_cancelled",
          run_id: runId,
          timestamp: clock.now(),
          producer: "engine",
          job: rid,
          step: null,
          attempt: null,
          payload: {
            job_id: rid,
            reason: "concurrency_cancel_previous",
            replaced_by: jobId,
          },
        };
        await eventWriter.appendEvent(runDir, evt);
        onEvent?.(evt);

        await stateStore.updateState(runDir, (cur) => ({
          ...cur,
          last_event_id: evtId,
          jobs: {
            ...cur.jobs,
            [rid]: { ...cur.jobs[rid]!, status: "cancelled" as const },
          },
        }));
      }
      concurrencyMutations++;
    }
  }

  if (cc.policy === "reject") {
    // If any job in the same group is running, fail this ready job
    const runningInGroup = Object.entries(state.jobs)
      .filter(([id, s]) =>
        s.status === "running" &&
        wf.jobs[id]?.concurrency?.group === cc.group
      );

    if (runningInGroup.length > 0) {
      const evtId = await nextSequentialEventId(runDir, eventWriter);
      const evt: ZigmaFlowEvent = {
        id: evtId,
        type: "job_failed",
        run_id: runId,
        timestamp: clock.now(),
        producer: "engine",
        job: jobId,
        step: null,
        attempt: null,
        payload: {
          job_id: jobId,
          reason: `Concurrency group "${cc.group}" is occupied (policy: reject)`,
        },
      };
      await eventWriter.appendEvent(runDir, evt);
      onEvent?.(evt);

      await stateStore.updateState(runDir, (cur) => ({
        ...cur,
        last_event_id: evtId,
        jobs: {
          ...cur.jobs,
          [jobId]: { ...cur.jobs[jobId]!, status: "failed" as const },
        },
      }));
      concurrencyMutations++;
    }
  }
}

// Re-read state if pre-scheduler made mutations
if (concurrencyMutations > 0) {
  state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId} after concurrency mutations`);
  }
}
```

## Proposed Event Types

No new event types are strictly required for MVP. Existing event types are reused with specific `reason` payloads:

| Scenario | Event Type | Payload.reason |
|----------|-----------|----------------|
| Running job cancelled by `cancel_previous` | `job_cancelled` | `"concurrency_cancel_previous"` |
| Ready job rejected by `reject` policy | `job_failed` | `"Concurrency group \"<group>\" is occupied (policy: reject)"` |

If more granular observability is desired post-MVP, a `job_mutex_queued` event could be added to record when a `queue`-policy job is skipped in a batch iteration. This is not required for correctness and can be deferred.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Pre-scheduler mutation changes state between snapshot reads:** The pre-scheduler modifies state (cancels jobs, fails jobs) before `selectExecutable` runs. Other concurrent writers (from the same batch's previous iteration) could interleave. | Low | All writes go through `AsyncQueue` (per-runDir serialization). The pre-scheduler's `updateState` calls are serialized with any in-flight writes from `executeJobOnce`. |
| **Deadlock with `queue` policy:** If all remaining ready jobs are in a `queue` group whose sibling is stuck "running" (hung agent), the loop will spin through iterations with empty batches until maxIterations. | Low | Same as existing deadlock scenario for any job stuck in "running" status. The existing maxIterations limit (default 100) provides a hard stop. The deadlock detection logic (Issue #231) already handles this class of problem. |
| **Fairness: multiple queued jobs in same group:** With D1 (scheduler excludes, natural retry), there is no FIFO ordering guarantee. | Low | Job ordering within a workflow is already deterministic from DAG topological order. `Object.entries` iteration order in modern Node.js is insertion-order for string keys, which means the workflow definition order is preserved. |
| **`cancel_previous` cascading:** If job-A has `cancel_previous` and job-B (in same group) also has `cancel_previous`, and both are ready simultaneously, which one wins? | Low | The pre-scheduler iterates ready jobs in `Object.entries` order. The first one processed cancels any running siblings, then proceeds. The second one finds no running siblings (the first one isn't running yet -- it's still ready) and also proceeds. Both can end up in the batch since the pre-scheduler only checks for *running* conflicts, not *ready-ready* conflicts. This is acceptable for MVP: if mutual exclusion between ready jobs is needed, use `policy: queue` instead. |
| **Backward compatibility:** Existing workflows without `concurrency` field. | Low | The `concurrency` field on `JobDefinition` is optional. When absent, the pre-scheduler step is a no-op for that job, and the scheduler filter passes it through. The parallelism + writer-lock model is unchanged. |

## Next Action

1. **Freeze this decision** in the phase development plan (update `02-development-plan.md` open decision "Concurrency group scope: per-run or cross-run?" to "Resolved: per-run static string keys").
2. **Proceed to WF-7.3** (Condition Context & Execution Strategy) implementation, which owns this feature.
3. **Before implementation**, review the concrete test cases needed:
   - Unit test: `selectExecutable` correctly excludes `queue`-policy jobs when sibling is running.
   - Unit test: `selectExecutable` includes `queue`-policy jobs when no sibling runs.
   - Unit test: `selectExecutable` passes `allow`-policy jobs regardless of sibling state.
   - Integration test: `cancel_previous` cancels running sibling and dispatches new job.
   - Integration test: `reject` fails the new job when sibling is running.
   - Integration test: Jobs without `concurrency` field are unaffected by all changes.
   - Snapshot test: `state.json` after `cancel_previous` shows cancelled sibling + new job.
