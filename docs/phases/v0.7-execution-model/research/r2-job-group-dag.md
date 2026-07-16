# Research Report: Job Group DAG Semantics (R2)

## Question

How should Job Groups compose with the existing static DAG (job-level `needs`), how should iterations receive data from previous iterations, and how should deprecated `goto_step`/`goto_job`/`max_visits` be internally translated to the Iteration model?

## Options Evaluated

### (a) Job Group structure

| Option | Pros | Cons | Rating |
|--------|------|------|--------|
| `groups:` at workflow top-level, each containing a subset of jobs | Direct nesting mirrors the conceptual tree (Run > Group > Iteration > Job). Obvious ownership. | Requires jobs to move from flat `jobs:` map into nested `groups[j].jobs`, breaking the existing flat-job lookup model used throughout the engine, scheduler, and DAG resolver. | Weak |
| **Job-level `group: <id>` field, group config in separate `job_groups:` section** | Backward-compatible: jobs without `group` work exactly as today. Consistent with how `traverse:` already lives at top level and references jobs by name. Flat job map is preserved for engine internals. | Requires a separate lookup to find group config from job. Two-part DSL (tag + config) is slightly more indirection. | **Strong** |
| Implicit groups: any jobs sharing a `repeat:` block form a group | Simplest YAML surface — one block defines both repetition and group membership. | No way to separate "same group" from "same repeat config" for jobs with different needs graphs. Reduces flexibility. | Weak |

**Recommendation: Job-level `group:` field + `job_groups:` config section.**

This pattern is already established in the codebase: `traverse:` is a top-level section that references existing jobs by name (via `target.job`). Jobs retain their own `needs` for intra-group ordering. A `job_groups` section at workflow top level holds iteration configuration (`repeat`) and optional group-level `needs`. Individual jobs reference their group with a `group: <id>` field.

**Codebase evidence:**
- `WorkflowDefinition` in `src/workflow/index.ts` has a flat `jobs: Record<string, JobDefinition>` map. Adding `job_groups: Record<string, JobGroupDefinition>` as a new top-level field follows the same pattern as the existing `traverse` (line 532).
- `computeReadyJobs` in `src/dag/index.ts` operates on `DagJobs` (a flat `{ [jobId]: { needs, optional_needs, activation } }` map). The scheduler in `src/engine/scheduler.ts` and the main loop in `src/engine/runAll.ts` both iterate `state.jobs` as a flat record. Keeping the job map flat avoids refactoring all consumers.
- The engine's `createRun` (line 86-251 of `src/engine/index.ts`) builds initial job states by iterating `wf.jobs`. It can be augmented to also initialize `state.job_groups` from `wf.job_groups` without changing the job initialization loop.

### (b) Group-level DAG: can groups have `needs`?

| Option | Pros | Cons | Rating |
|--------|------|------|--------|
| **Groups have `needs: [other_group]`** | Clean semantic model: "groups are DAG nodes." A review group can depend on an implement group, producing a natural sequential pipeline of group iterations. | `computeReadyJobs` would need a two-level readiness check: first compute which groups are ready, then within each ready group compute which jobs are ready for the current iteration. Increases DAG resolver complexity. | **Strong** |
| Only jobs have needs; first-iteration jobs depend on jobs in other groups | No change to the existing DAG model. Cross-group dependency expressed purely through job-level `needs`. | Cannot express "wait for the entire other group to finish all its iterations" — jobs in a group could start iterating while jobs in an upstream group are still in intermediate iterations. | Weak |
| Groups are isolated sub-DAGs | Simplest implementation — no cross-group awareness needed. | Too restrictive for real workflows: review-rewrite loops require data flow between groups. Forces all iteration-aware jobs into one monolithic group. | Reject |

**Recommendation: Groups have `needs: [other_group]` at the JobGroup level, translated internally to first-iteration job dependencies.**

The semantic model: a group is itself a DAG node. Group A `needs` Group B means Group A cannot start any iteration until Group B has reached its terminal iteration state (all iterations complete, or `max_iterations` reached, or `until` satisfied).

Implementation approach:
1. At load time, validate group-level `needs` reference existing groups (no cycles).
2. At runtime, `computeReadyJobs` is augmented: a job within a group is only "ready" if its group's group-level `needs` are all complete AND its own job-level `needs` are met.
3. The group-level `needs` is a static constraint — once a downstream group starts iterating, it does not re-check the upstream group.

**Codebase evidence:**
- The two-level readiness check can be a thin wrapper around the existing `computeReadyJobs`: first filter jobs by group readiness, then pass the filtered set to the existing DAG function.
- `StateStore.updateState` in `src/run/index.ts` (line 248-263) supports atomic read-modify-write, so checking group readiness and updating iteration state within a single write queue entry is already supported.

### (c) Iteration execution model

| Option | Pros | Rating |
|--------|------|--------|
| **Sequential-only** | Simplest to implement, verify, and debug. Matches all design constraints: completed stays terminal, DAG stays static, state only advances forward. Works with the existing scheduler without changes. | **Strong** |
| Pipelined | Higher throughput for long-running agent steps. | Requires per-iteration readiness tracking, significantly more complex state machine. Premature optimization for MVP. | Deferred |
| Parallel with barrier | Intra-iteration parallelism (already supported by existing scheduler) with explicit iteration boundaries. | No benefit over sequential: the scheduler already parallelizes jobs within an iteration. The barrier adds latency without throughput gain. | Reject |

**Recommendation: Sequential only for MVP.** Iteration N must fully complete (all its jobs terminal) before iteration N+1 starts. The existing scheduler already handles intra-iteration parallelism for read-only jobs.

**Codebase evidence:**
- The existing `runAll` main loop (`src/engine/runAll.ts`, lines 1337-1640) uses a `while (iteration < maxIterations)` loop with per-iteration batch scheduling. The iteration boundary already exists as a concept — we are layering group iteration semantics on top of the same loop structure.
- The post-batch reconciliation in `reconcileTerminalState` (line 1230-1260) already checks whether all jobs are done. An analogous `reconcileGroupIterationState` would check whether all jobs in a group have reached a terminal status for the current iteration.

### (d) Iteration data access scope

| Option | Pros | Cons | Rating |
|--------|------|------|--------|
| Full previous iteration: `iteration.previous.jobs.<id>.outputs` and `.steps.<id>.outputs` | Maximum flexibility for rework prompts. | Step-level data is transient and not part of the stable data boundary. Creates dependence on implementation details. Blurs the output contract. | Weak |
| **Scoped: job-level outputs only** | Consistent with the existing `${{ jobs.<id>.outputs.<key> }}` expression pattern. Job outputs are the stable, persisted data boundary. No change to the expression resolver. | Cannot access intermediate step results from the previous iteration. In practice, rework loops need "what was produced" (job outputs) more than "how it was produced" (step details). | **Strong** |
| Explicit: jobs declare `exposes_to_next_iteration: [output1, output2]` | Most principled. Explicit data contracts between iterations. Forces workflow authors to think about iteration data flow. | Adds DSL complexity. All job outputs are already available via `${{ jobs.<id>.outputs }}` — the question is only about cross-iteration access. | Deferred |

**Recommendation: Scoped to job-level outputs only.** `iteration.previous` makes the previous iteration's job outputs available via the expression context. This is a thin extension to the existing `ExpressionContext` type.

Data flow:
```
Iteration 1: Job A → outputs.bar = "v1"
             Job B → outputs.qux = "v1"
Iteration 2: Job A → can read ${{ iteration.previous.jobs.A.outputs.bar }}  → evaluates to "v1"
             Job B → can read ${{ iteration.previous.jobs.B.outputs.qux }}  → evaluates to "v1"
```

**Codebase evidence:**
- `ExpressionContext` in `src/expression/index.ts` (lines 28-35) already supports `jobs` and `steps` namespaces. Adding `iteration?: { previous?: { jobs: Record<string, { outputs?: Record<string, unknown> }> } }` and a new `${{ iteration.previous.jobs.<id>.outputs.<key> }}` pattern in `resolveExpression` is a straightforward extension.
- The expression depth limit (line 621: `parts.length > 4`) must be relaxed to 5 to accommodate `iteration.previous.jobs.A.outputs.x` (5 parts). See risk below.

### (e) Repeat condition (`until`) evaluation timing

| Option | Pros | Cons | Rating |
|--------|------|------|--------|
| **Post-iteration** | Natural iteration boundary. All job outputs are available for condition evaluation. Simple to reason about ("has this iteration produced acceptable results?"). | Cannot short-circuit early within an iteration if only one job matters for the exit condition. | **Strong** |
| Post-specific-job | More responsive for workflows where only a single "review" job determines whether to iterate. | Requires DSL to designate a "gate" job. Semantic complexity: what happens to other jobs if the gate says "stop"? | Deferred to v0.8 |
| Continuous (after each job) | Earliest exit from unnecessary work. | Highly complex to reason about. What happens to already-running parallel jobs when short-circuit triggers? Violates sequential iteration model. | Reject |

**Recommendation: Post-iteration evaluation.** After all jobs in an iteration reach terminal status, evaluate `until`. If `true`, stop iterating; if `false`, start the next iteration (if `max_iterations` not yet reached).

**Codebase evidence:**
- The post-batch reconciliation pattern already exists: after each batch, `reconcileTerminalState` checks whether the run is done. A `reconcileGroupIteration` function would analogously check: are all jobs in this group terminal for this iteration? Then evaluate `until` and decide whether to create a new iteration.
- The expression evaluator `evaluateCondition` in `src/expression/index.ts` (line 199-230) can evaluate `until` conditions using the same grammar as `step.if`.

### (f) Backward compat translation: `goto_step`/`goto_job` → Iteration

| Option | Pros | Cons | Rating |
|--------|------|------|--------|
| Static analysis at load time | Would allow emitting deprecation warnings with migration suggestions at validate time. | Detecting "this step loop will form a repeat pattern" is fragile. Many goto_step usages are conditional and the actual control flow can't be determined statically. | Weak |
| **Runtime adaptation** | Matches how the existing `routing.ts` handles goto_step today. When a goto_step or goto_job is triggered, the engine internally creates a new iteration of the containing (implicit) group. No pre-analysis needed. All existing workflow YAML continues to work without changes. | Must handle the case where a job uses both old (goto) and new (repeat) mechanisms — this is a conflict that should be caught at validation time. | **Strong** |
| Thin wrapper (treat each goto cycle as an implicit single-job iteration) | Simplest implementation. | Loses semantics: a job that loops 5 times with goto_step is not "1 iteration with 5 revisits" but "5 iterations of the same job." Recording it as iterations provides better audit trail and prepares for v1.0 removal. | Weak |

**Recommendation: Runtime adaptation with implicit group creation.**

When the engine encounters a `goto_step` or `goto_job` action on a job that does not already belong to an explicit Job Group, it:
1. Creates an implicit Job Group containing the source (and optionally target) job.
2. Records the current execution as Iteration 1.
3. The goto action becomes the trigger that advances the implicit group to Iteration 2.
4. `max_visits` on a step maps to `max_iterations` on the implicit group.
5. `goto_with` payload maps to `iteration.previous` data for the next iteration.

When a job already belongs to an explicit Job Group, `goto_step`/`goto_job` actions on that job are rejected at validation time (the two mechanisms are mutually exclusive per job).

**Codebase evidence:**
- `applyRoutingAction` in `src/engine/routing.ts` already handles `goto_step` (line 502-595) and `goto_job` (line 426-498) with full validation and event emission. The adaptation layer would intercept these handlers.
- A `step_revisited` event is already emitted for `goto_step` (line 558-568). In the new model, this would become `iteration_started` on the implicit group, and the step itself would be recorded as the first step of the new iteration.
- The `max_visits` guard (line 521-555) already checks the visit count against the limit and blocks on exceeded. This maps directly to `max_iterations` on the implicit group.

## Recommendation

### Summary of decisions

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| (a) Group structure | `group:` field on Job + `job_groups:` top-level section | Consistent with existing `traverse:` pattern; backward-compatible |
| (b) Group-level DAG | Groups have `needs: [other_group]` | Clean DAG semantics; maps to first-iteration readiness |
| (c) Iteration execution | Sequential only | Simplest; existing scheduler handles intra-iteration parallelism |
| (d) Data access scope | Job-level outputs only via `iteration.previous.jobs.<id>.outputs` | Consistent with existing `${{ jobs.<id>.outputs }}` pattern |
| (e) `until` evaluation | Post-iteration | Natural iteration boundary; all outputs available |
| (f) goto translation | Runtime adaptation with implicit group creation | Matches existing routing.ts flow; no static analysis fragility |

### Workflow YAML example

```yaml
name: code-review-loop
version: "1.0"

inputs:
  task:
    type: string
    required: true

jobs:
  implement:
    group: dev_loop
    needs: []
    steps:
      - id: code
        type: agent
        exposes:
          skills: [ coding ]
        outputs:
          patch: { type: string }
          summary: { type: string }
        with:
          prompt: |
            Implement: ${{ inputs.task }}
            Previous patch: ${{ iteration.previous.jobs.implement.outputs.patch }}

  review:
    group: dev_loop
    needs: [ implement ]
    steps:
      - id: review
        type: agent
        exposes:
          skills: [ code_review ]
        outputs:
          verdict: { type: string }
          feedback: { type: string }
        with:
          prompt: |
            Review patch: ${{ jobs.implement.outputs.patch }}
            Previous feedback: ${{ iteration.previous.jobs.review.outputs.feedback }}

job_groups:
  dev_loop:
    repeat:
      max_iterations: 5
      until: "${{ jobs.review.outputs.verdict == 'approved' }}"
```

## Proposed Data Model

### TypeScript interfaces

```typescript
// ── src/workflow/index.ts — new types ──────────────────────────────

export interface RepeatConfig {
  /** Maximum number of iterations. Defaults to 1 (no repetition). */
  max_iterations: number;
  /** Boolean expression evaluated after each iteration. When true, stop. */
  until?: string;
}

export interface JobGroupDefinition {
  /** Iteration configuration for the group. */
  repeat: RepeatConfig;
  /** Group-level DAG dependencies (other group ids). */
  needs?: string[];
}

// Added to WorkflowDefinition:
export interface WorkflowDefinition {
  // ... existing fields ...
  /** Job Group definitions (new in v0.7). */
  job_groups?: Record<string, JobGroupDefinition>;
}

// Added to JobDefinition:
export interface JobDefinition {
  // ... existing fields ...
  /** Group membership (new in v0.7). */
  group?: string;
}

// ── src/run/index.ts — new state types ─────────────────────────────

export interface IterationState {
  /** 1-based iteration index within the group. */
  index: number;
  /** ISO 8601 timestamp when this iteration started. */
  started_at: string;
  /** ISO 8601 timestamp when this iteration completed (all jobs terminal). */
  completed_at?: string;
  /** Job states for this iteration (references into state.jobs). */
  job_ids: string[];
  /** Snapshot of job outputs from this iteration for `iteration.previous` access. */
  job_outputs?: Record<string, Record<string, unknown>>;
}

export interface JobGroupState {
  /** Matches the key in WorkflowDefinition.job_groups. */
  group_id: string;
  /** Iteration execution status. */
  status: "pending" | "iterating" | "completed" | "failed" | "blocked";
  /** 1-based current iteration index. */
  current_iteration: number;
  /** Ordered list of completed iterations. */
  iterations: IterationState[];
  /** Computed from max_iterations - current_iteration. */
  iterations_remaining: number;
}

// Added to RunState:
export interface RunState {
  // ... existing fields ...
  /** Job Group states (new in v0.7). */
  job_groups?: Record<string, JobGroupState>;
}

// Modified JobState:
export interface JobState {
  // ... existing fields ...
  /** Group membership (new in v0.7). Matches a key in state.job_groups. */
  group?: string;
}
```

### Expression context extension

```typescript
// Added to ExpressionContext in src/expression/index.ts:

export interface ExpressionContext {
  // ... existing fields ...
  /** Previous iteration's job outputs (new in v0.7). */
  iteration?: {
    previous?: {
      jobs: Record<string, { outputs?: Record<string, unknown> }>;
    };
  };
}
```

New expression pattern: `${{ iteration.previous.jobs.<id>.outputs.<key> }}`

This is a 5-part path (`iteration.previous.jobs.A.outputs.x`). The current depth limit of 3 (4 parts) must be relaxed to 4 (5 parts) for iteration paths only.

## Proposed Event Types

| Event Type | Trigger | Key Payload |
|------------|---------|-------------|
| `iteration_started` | Engine creates a new iteration of a Job Group | `group_id`, `iteration_index`, `job_ids` |
| `iteration_completed` | All jobs in iteration reach terminal status | `group_id`, `iteration_index`, `job_outputs` |
| `iteration_condition_met` | `until` evaluates to true, stopping iteration | `group_id`, `iteration_index`, `condition` |
| `iteration_max_reached` | `max_iterations` reached for a group | `group_id`, `iteration_index`, `max_iterations` |
| `group_completed` | Group's final iteration completes | `group_id`, `total_iterations` |
| `group_blocked` | Group cannot proceed (e.g., all jobs blocked in current iteration) | `group_id`, `iteration_index`, `reason` |
| `group_failed` | Group fails (e.g., required job failed, `failure_policy: fail`) | `group_id`, `iteration_index`, `reason` |

**Removed/replaced event types** (mapped from deprecated events):
| Old Event | New Event | Notes |
|-----------|-----------|-------|
| `step_revisited` | `iteration_started` | When goto_step triggered on an implicit group |
| `step_visit_exceeded` | `iteration_max_reached` + `group_blocked` | When max_visits exceeded on an implicit group |

## Proposed State Transitions

### Iteration lifecycle

```
Iteration:
  (created by engine) → active → completed
                              → failed  (if failure_policy: fail and a job fails)
                              → blocked (if all jobs blocked or max_iterations reached with unsatisfied until)

Group:
  pending → iterating → completed  (normal termination via until condition)
                      → failed     (failure_policy: fail propagated)
                      → blocked    (iteration blocked and no recovery)
```

### Run state transitions (augmented)

```
Run:
  running → completed  (all groups completed, or all non-group jobs completed + no groups)
  running → failed     (any group failed with failure_policy: fail at run level)
  running → blocked    (any group blocked with no recovery possible)
```

### Job state within iteration (no change to existing transitions)

```
Job (within an iteration):
  waiting → ready → running → completed
                            → failed
                            → blocked
  ready → running → cancelled
  completed → ready  (only via retry, not via iteration — iteration always creates new job records)
```

Key invariant: A job's status within iteration N does not change once iteration N is declared completed. Iteration N+1 creates fresh job state records (via `iteration.previous` data access).

## Backward Compatibility Design

### Translation table: deprecated features → new model

| Deprecated Feature | Internal Translation | Mechanism |
|-------------------|---------------------|-----------|
| `goto_step: <target>` | Create implicit group for the job. Record current execution as Iteration 1. Goto triggers Iteration 2 start, resetting step pointer to `<target>`. | `applyRoutingAction` in `routing.ts` intercepts goto_step when job does not already have a `group` field. |
| `goto_job: <target>` | Create implicit group containing source job and target job (if in same group). Goto triggers Iteration 2, making target ready. | `applyRoutingAction` intercepts goto_job when no group exists. |
| `max_visits: N` | Maps to `max_iterations: N` on implicit group. `step_visit_exceeded` event becomes `iteration_max_reached`. | `advanceJob` and routing.ts visitor limit checks translated. |
| `goto_with: {key: val}` | Maps to `iteration.previous` data for the next iteration. | Payload stored in iteration state. |
| `retry_job` with `retry_with` | `retry_with` data maps to attempt-level inputs (not iteration data). Existing Attempt model in v0.7 WF-7.1 absorbs this. | No change to retry_job; separate from iteration model. |

### Conflict detection (validation time)

The following combinations are errors at `loadWorkflow` time:
1. A job has both `group: <id>` (explicit group) and uses `goto_step`/`goto_job`/`max_visits` in any of its steps.
2. A job has `group: <id>` referencing a `job_groups` entry that does not exist.
3. A `job_groups.<id>.needs` references a `job_groups` entry that does not exist.
4. A `job_groups` cycle is detected.

When a job has NO `group` but uses `goto_step`/`goto_job`/`max_visits`, the engine silently wraps it in an implicit group at runtime. This ensures all existing v0.6 workflows continue to work without modification.

### Implicit group naming

Implicit groups are named `__implicit__<job_id>` for single-job goto_step groups, or `__implicit__<source_job>__<target_job>` for goto_job groups. These names are internal and do not appear in the workflow YAML. The `__implicit__` prefix prevents collisions with user-defined group names (which cannot start with `__`).

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Expression depth limit breakage: `iteration.previous.jobs.A.outputs.x` is 5 parts, exceeding current limit of 3 (4 parts). | Medium | Raise the depth limit for `iteration.previous` paths only. Hardcode the allowed prefix `iteration.previous.jobs.<id>.outputs` (5 parts exactly, no deeper) in `validateExpressions`. Alternatively, raise the general limit to 4 depth (5 parts) — the expression validator already rejects constructs beyond `.`-chained property access, so this is low risk. |
| State file size growth: storing all iteration job outputs in `IterationState.job_outputs` adds data per iteration. | Low | Job outputs are already stored in `JobState.outputs`. The iteration snapshot is a copy of the final output values, not the full step history. For a typical 5-iteration loop with 2 jobs each producing ~1KB outputs, total added is ~10KB. Acceptable for MVP. |
| Implicit group creation race: if two jobs in the same workflow both use `goto_step`, they would create separate implicit groups rather than sharing one. | Low | This is correct behavior — two independent looping jobs form separate groups. If the user wanted them in the same group, they would use explicit `group:` + `repeat:`. |
| Old `step_revisited` events removed: existing tooling that consumes `step_revisited` events would break. | Low | `step_revisited` is emitted as before for backward compat; additionally, `iteration_started` is emitted as a new parallel event. The old event type is kept in the catalog but marked deprecated. Full removal in v1.0. |
| `computeReadyJobs` two-level DAG complexity: jobs in a group with unmet group-level `needs` must appear as "not ready" even if their own `needs` are satisfied. | Medium | Add a pre-filter to `computeReadyJobs` that removes jobs whose groups are not yet ready. The existing function already accepts `completedJobIds` and `activeJobIds` — adding a `blockedGroupIds` or `readyGroupIds` parameter is a backward-compatible overload. |

## Next Action

1. **Proceed to WF-7.2 Step 2** (Implementation) using the decisions in this report.
2. **Priority order for implementation:**
   i. Add `group` field to `JobDefinition` schema and `RepeatConfig`/`JobGroupDefinition` types. Validate group references and detect conflicts.
   ii. Add `JobGroupState` and `IterationState` to RunState. Initialize in `createRun`.
   iii. Implement the iteration loop in the engine: after a group's jobs are completed, check `until`, create next iteration or finalize.
   iv. Extend `ExpressionContext` and `resolveExpression` for `${{ iteration.previous.jobs.<id>.outputs.<key> }}`.
   v. Implement backward compat translation in `applyRoutingAction`: goto_step/goto_job on ungrouped jobs creates implicit groups.
   vi. Add new event types and emit them at iteration boundaries.
   vii. Update `validateDeprecations` to warn on goto/goto_job/max_visits when used outside of implicit groups.
3. **Test cases needed:**
   - Unit: Group readiness (computeReadyJobs with group filter), iteration state transitions, until evaluation, implicit group creation from goto_step.
   - Integration: 3-iteration loop with `iteration.previous` data flow, backward compat: old goto_step workflow runs and produces iteration events.
   - Snapshot: state.json with `job_groups` and `iterations` fields.
4. **Dependencies:** WF-7.1 (Execution Attempt) must land first — iterations reference attempts. The Attempt model's `attempt` counter within a job resets per iteration (not per job lifetime).
