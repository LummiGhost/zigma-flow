# Research Report: Failure Policy Cascade and Outcome/Conclusion Model

Date: 2026-07-16
Research task: R4
Phase: v0.7-execution-model
Status: Complete

## Question

How should failure policies at different levels (job, iteration, group) compose, and how should the outcome vs conclusion distinction be modeled to replace the deprecated v0.6 dynamic control-flow features (`goto_step`, `goto_job`, `retry_job`, `max_visits`, `signals`) with a forward-only, immutable-record execution model?

## Current State (v0.6)

### Failure handling inventory

The codebase currently has no formal "failure policy" concept. Failure behavior is distributed across multiple loosely-coordinated mechanisms:

| Mechanism | Location | Scope | Behavior |
|-----------|----------|-------|----------|
| `classifyError` | `src/engine/runAll.ts:114-140` | Per-agent-step | Classifies `result.error` string into `"config"`, `"permission"`, `"timeout"`, or `"execution"` |
| `recordAgentFailure` | `src/engine/recordAgentFailure.ts` | Per-job | Writes `step_failed`, checks `retry.max_attempts`, applies `on_exceeded.status`; config/permission errors fail the run immediately (no retry) |
| `retryJob` | `src/engine/retryJob.ts` | Per-job | Validates retryable status, checks `max_attempts`, emits `job_retrying`, resets job to `ready` |
| `stepDef.on_failure` | `src/workflow/index.ts:282` | Per-step (script/check/router) | RouterAction applied on step failure; default job status is `"failed"`, overridable to `"blocked"` via `{ status: "blocked" }` |
| `retry.on_exceeded` | `src/engine/recordAgentFailure.ts:237-243` | Per-job | When retries exhausted: `"blocked"` (default) or `"failed"` |
| `traverse.on_item_failure` | `src/workflow/index.ts:438` | Per-traverse | `"fail_all"`, `"continue"`, or `"collect"` -- the only existing "continue despite failure" policy |
| `reconcileTerminalState` | `src/engine/runAll.ts:1230-1260` | Run-level | Only required jobs (non-activation) considered; any required job `failed` → `run_failed`; any required job `blocked` → `run_blocked` |
| `applyRoutingAction` | `src/engine/routing.ts` | Per-job | Maps RouterAction (`"continue"`, `"fail"`, `"block"`, object-forms) to state transitions |
| `applyStatusReturn` | `src/engine/applyStatusReturn.ts` | Per-step (agent) | Translates agent `report.status` through `returns.status` + `on_return` mappings |

### Error paths traced

**Path A: Agent backend execution fails (non-timeout, non-config)**

```
executeAgentStep (runAll.ts:668)
  → emit agent_failed event (runAll.ts:761)
  → classifyError → "execution" (runAll.ts:786)
  → recordAgentFailure (recordAgentFailure.ts:118)
    → emit step_failed event
    → errorType is "execution" → NOT config/permission
    → load workflow → read retry.max_attempts (default 1)
    → if attempt < max_attempts:
        set job status → "failed"
        call retryJob → job_retrying, job → "ready", attempt++
        return { action: "retried" }
    → if attempt >= max_attempts:
        apply on_exceeded.status (default "blocked")
        set job status → "blocked" or "failed"
        set run status → "blocked" or "failed"  ← BUG: recordAgentFailure line 277 overwrites run.status
        return { action: onExceededStatus }
  → back in executeAgentStep:
    if retried → return { action: "retried" }
    else → return { action: "failed" }
```

**Path B: Agent config/permission error**

```
executeAgentStep
  → classifyError → "config" or "permission"
  → recordAgentFailure
    → emit run_failed event
    → set run.status = "failed"  (immediate, no retry)
    → return { action: "run_failed" }
```

**Path C: Script step failure**

```
executeNonAgentStep (via script/executor.ts)
  → emit step_failed event
  → check stepDef.on_failure
    → if object-form routing action → delegate to applyRoutingAction
    → else → apply status (default "failed", or from on_failure.status)
    → write final state with job status
```

**Path D: Backend resolution failure (before agent execution)**

```
executeAgentStep
  → backendResolver throws ConfigError/PermissionError
  → recordAgentFailure with errorType "config"/"permission"
  → run_failed immediately (same as Path B)
```

**Path E: Context build failure**

```
executeAgentStep
  → buildContext throws
  → recordAgentFailure with errorType "config"
  → run_failed immediately
```

### Key observations from current code

1. **No `failure_kind` taxonomy**: `classifyError` is pure string-matching on `result.error`. The four categories (`config`, `permission`, `timeout`, `execution`) are ad-hoc and not surfaced to workflow authors.

2. **No `outcome`/`conclusion` distinction**: Job status (`"failed"`, `"blocked"`, `"completed"`) serves double duty as both execution result and policy decision. There is no record of *why* a job reached its terminal status.

3. **run.status is prematurely overwritten**: `recordAgentFailure` line 277 sets `state.status = onExceededStatus` even when other jobs may still be running. The `reconcileTerminalState` function in `runAll.ts` was added (Issue #229) specifically to fix this -- it re-derives the run-level status from all job states after the loop exits.

4. **`on_item_failure` is the only "continue despite failure" pattern**: The traverse node's `on_item_failure: "continue"` is the single existing implementation of "don't fail the whole thing when one item fails." It is isolated to traverse nodes and not generalized.

5. **Retry logic is duplicated**: Both `recordAgentFailure.ts` and `routing.ts` independently implement `max_attempts` checking and `on_exceeded` application. `retryJob.ts` is called from both `recordAgentFailure` and the CLI `retry` command.

## Options Evaluated

### a. Failure policy scope

**Option A1: Job-level only**

`failure_policy` declared once per job. Simplest model; all steps in the job share the same policy.

```yaml
jobs:
  lint:
    failure_policy: continue
    steps: [...]
```

Pros: Simple, one place to look. Cons: No per-step granularity; all-or-nothing within a job.

**Option A2: Step-level only**

Each step declares its own `failure_policy`. Maximum granularity.

```yaml
jobs:
  lint:
    steps:
      - id: check
        failure_policy: continue
      - id: fix
        failure_policy: fail
```

Pros: Fine-grained. Cons: Verbose; most jobs will repeat the same policy on every step.

**Option A3: Both, step overrides job (recommended)**

Job declares a default; individual steps can override.

```yaml
jobs:
  lint:
    failure_policy: continue  # default for all steps
    steps:
      - id: check
      - id: critical_check
        failure_policy: fail  # override
```

Pros: Expressive, non-verbose, backward-compatible with `on_failure` (which is already step-level). Cons: Slightly more complex schema.

**Recommendation: A3 -- Job-level as default, step-level override.**

This mirrors the existing `on_failure` pattern (which is step-level) and the `workspace.mode` pattern (job-level default, per-step `cwd` override). The migration path is clean: `on_failure: fail` maps to `failure_policy: fail` on the step, and new workflows can use job-level for brevity.

### b. Policy cascade order

**Option B1: Hierarchical (job → iteration → group)**

Each scope has its own `failure_policy`. A job failure is first evaluated against the job policy; if the job policy says `continue`, the iteration proceeds. If all critical jobs in an iteration fail, the iteration policy is evaluated. If the iteration policy says `continue`, the group proceeds to the next iteration.

```
Job fails → job.failure_policy evaluates
  fail    → job.conclusion = failure, escalate to iteration
  continue → job.conclusion = success_with_warnings, iteration unaffected
  block   → job.conclusion = blocked, pause for human

Iteration has failures → iteration.failure_policy evaluates  
  fail    → iteration.conclusion = failure, escalate to group
  continue → iteration.conclusion = success_with_warnings, group proceeds
  
Group has failures → group.failure_policy evaluates
  fail    → run.conclusion = failure
  continue → run.conclusion = success_with_warnings
  block   → run.conclusion = blocked
```

Pros: Models real escalation chains; each level can contain or escalate. Cons: Three-level hierarchy may be overly complex for MVP.

**Option B2: Flat**

Single policy determined by closest scope that declares one. If job declares `failure_policy: continue`, that's the only policy that matters.

Pros: Simple. Cons: Loses ability to express "job can fail but iteration cannot."

**Option B3: Event-driven**

Failure emits an event; policies are listeners that decide the response. Flexible but adds indirection and debugging complexity.

Pros: Maximum flexibility. Cons: Complex, non-deterministic, hard to audit. Rejected per the phase plan constraint that "Engine state only advances forward" and avoids event-listener patterns.

**Recommendation: B1 -- Hierarchical with explicit escalation.**

The hierarchical model is the only one that cleanly supports the three-level data model (Job → Iteration → Group) and allows each level to independently decide whether to contain or escalate a failure. For MVP, the two most common configurations are:

1. **Strict** (default): all levels use `fail` → any failure fails the run.
2. **Lenient job, strict iteration**: job can `continue`, but iteration must not fail.

The full three-level cascade can be simplified in the schema: omit `failure_policy` at group level by default (inherits from iteration), and omit at iteration level by default (inherits from job).

### c. `continue` policy semantics

What does it mean to "continue" after a job failure?

**Option C1: Skip failed job, continue to next job in iteration**

- Job marked `failed`, but iteration does not abort
- Downstream jobs that `needs` this job remain blocked (they genuinely need the outputs)
- Independent jobs proceed normally
- This is how `traverse.on_item_failure: continue` works today

**Option C2: Treat as `completed_with_warnings` (fake success)**

- Job appears "successful" for DAG purposes
- Downstream jobs receive potentially incomplete/broken outputs
- Violates "completed executions stay terminal" and auditability

**Option C3: Continue iteration but mark for review**

- Job marked `failed`, iteration status = `completed_with_issues`
- Human can review and decide
- Adds a manual gate

**Recommendation: C1 -- Skip failed job, iteration continues, job marked `failed`.**

This preserves auditability (the job is genuinely failed), maintains DAG integrity (downstream deps are correctly blocked), and allows independent jobs to proceed. The iteration-level conclusion reflects the presence of failures (`success_with_warnings`).

The key semantic: `failure_policy: continue` means "this job's failure does not fail the iteration." It does NOT mean "pretend this job succeeded." The job still failed, its outputs are absent, and anything that depends on it is stuck.

### d. Outcome vs Conclusion model

**Option D1: Two-phase**

- `outcome`: raw execution result (technical) -- `"success" | "failure" | "timeout" | "cancelled"`
- `conclusion`: outcome + policy evaluation (domain) -- `"success" | "success_with_warnings" | "failure" | "blocked"`
- Computed by a pure mapping function: `(outcome, attempt_history, failure_policy) → conclusion`

**Option D2: Single field with qualifier**

- `status: "completed"`, `qualifier: "with_warnings"` as a sub-field
- Compact but harder to query and reason about
- TypeScript would need discriminated unions on the qualifier

**Option D3: Separate enums with mapping function (recommended)**

- `AttemptOutcome` enum: purely technical, set by the engine when an attempt finishes
- `JobConclusion` enum: business-level, computed from all attempts + failure_policy
- `IterationConclusion` enum: business-level, computed from all job conclusions in the iteration
- Mapping functions are pure and independently testable

```typescript
enum AttemptOutcome {
  Success = "success",
  Failure = "failure",
  Timeout = "timeout",
  Cancelled = "cancelled",
}

enum JobConclusion {
  Success = "success",
  SuccessWithWarnings = "success_with_warnings",
  Failure = "failure",
  Blocked = "blocked",
}

enum IterationConclusion {
  Success = "success",
  SuccessWithWarnings = "success_with_warnings",
  Failure = "failure",
  Blocked = "blocked",
}
```

**Recommendation: D3 -- Separate enums with mapping function.**

This is the most type-safe approach, makes the mapping logic independently testable, and clearly separates the engine's domain (outcomes) from the workflow author's domain (conclusions). The two-phase approach (D1) is semantically equivalent but less type-safe.

### e. Conclusion computation rule

Given multiple attempts for a job, how is the JobConclusion derived?

**Option E1: Policy-driven**

```yaml
retry:
  max_attempts: 3
  conclusion: any_success  # or last_attempt, all_success
```

Pros: Flexible. Cons: Adds configuration complexity.

**Option E2: Fixed rule (first success wins)**

- Any successful attempt → `JobConclusion.Success`
- All attempts failed → evaluate `failure_policy`
  - `fail` → `JobConclusion.Failure`
  - `continue` → `JobConclusion.SuccessWithWarnings`
  - `block` → `JobConclusion.Blocked`

Pros: Matches current behavior; simple mental model. Cons: No ability to configure the rule.

**Option E3: Weighted per failure_kind**

```yaml
retry:
  when:
    - timeout
    - execution
  # config/permission failures never retry
```

This is already specified as part of WF-7.1 (Attempt-based retry with `when` conditions). It is orthogonal to the conclusion rule.

**Recommendation: E2 -- Fixed rule as default.**

The fixed rule (first success → success; all failed → policy evaluation) matches current behavior exactly and is the least surprising. WF-7.1's `retry.when` conditions add selective retry based on `failure_kind`, which is the right granularity. No need for an additional `conclusion` configuration field.

### f. Iteration conclusion

How is iteration-level conclusion computed from job conclusions?

**Option F1: All jobs must succeed**

Any job failure → iteration failure. Strictest, matches current `reconcileTerminalState` behavior.

**Option F2: Only critical jobs must succeed**

Jobs with `failure_policy: continue` are non-critical. Only critical job failures (those with `failure_policy: fail`) cause iteration failure.

**Option F3: Separate `critical` field**

`critical: true/false` is independent of `failure_policy`. A job could be `failure_policy: fail` but `critical: false` (meaning: try your best, but if you fail, don't fail the iteration).

**Recommendation: F2 -- Criticality is derived from `failure_policy`.**

The mapping is direct:
- `failure_policy: fail` (default) → job is critical → failure cascades to iteration
- `failure_policy: continue` → job is non-critical → failure does not cascade
- `failure_policy: block` → job is critical (but paused, not failed) → iteration blocks

No separate `critical` field is needed. The policy itself encodes criticality. This keeps the schema minimal and avoids contradictory configurations (e.g., `critical: true` + `failure_policy: continue`).

## Recommendation

### Consolidated design

**Schema additions (workflow YAML):**

```yaml
jobs:
  <job_id>:
    failure_policy: fail | continue | block   # default: fail
    steps:
      - id: <step_id>
        failure_policy: fail | continue | block   # optional, overrides job-level
    retry:
      max_attempts: 3
      when: [timeout, execution]              # from WF-7.1
      on_exceeded: fail | block               # default: block
```

**New state fields (RunState/JobState):**

```typescript
interface JobState {
  // ... existing fields ...
  outcome?: AttemptOutcome;          // raw result of the last attempt
  conclusion?: JobConclusion;        // policy-adjusted result (terminal state)
  failure_kind?: FailureKind;        // classified failure reason
}

interface RunState {
  // ... existing fields ...
  iteration_conclusions?: Record<number, IterationConclusion>;
}
```

**New enums:**

```typescript
enum FailureKind {
  Config = "config",
  Permission = "permission",
  Timeout = "timeout",
  Execution = "execution",
  InvalidOutput = "invalid_output",
  Validation = "validation",
  Cancelled = "cancelled",
  Unknown = "unknown",
}

enum AttemptOutcome {
  Success = "success",
  Failure = "failure",
  Timeout = "timeout",
  Cancelled = "cancelled",
}

enum JobConclusion {
  Success = "success",
  SuccessWithWarnings = "success_with_warnings",
  Failure = "failure",
  Blocked = "blocked",
}

enum IterationConclusion {
  Success = "success",
  SuccessWithWarnings = "success_with_warnings",
  Failure = "failure",
  Blocked = "blocked",
}
```

### Mapping function: AttemptOutcome → JobConclusion

```typescript
function computeJobConclusion(
  attempts: Array<{ outcome: AttemptOutcome }>,
  failurePolicy: FailurePolicy,
): JobConclusion {
  const anySuccess = attempts.some(a => a.outcome === AttemptOutcome.Success);
  if (anySuccess) return JobConclusion.Success;
  
  // All attempts failed or timed out or cancelled
  switch (failurePolicy) {
    case "fail":    return JobConclusion.Failure;
    case "continue": return JobConclusion.SuccessWithWarnings;
    case "block":   return JobConclusion.Blocked;
  }
}
```

### Mapping function: JobConclusion[] → IterationConclusion

```typescript
function computeIterationConclusion(
  jobs: Array<{ conclusion: JobConclusion; failurePolicy: FailurePolicy }>,
): IterationConclusion {
  const hasBlocked = jobs.some(j => j.conclusion === JobConclusion.Blocked);
  if (hasBlocked) return IterationConclusion.Blocked;
  
  const criticalFailures = jobs.filter(
    j => j.failurePolicy === "fail" && j.conclusion === JobConclusion.Failure
  );
  if (criticalFailures.length > 0) return IterationConclusion.Failure;
  
  const hasWarnings = jobs.some(
    j => j.conclusion === JobConclusion.SuccessWithWarnings
  );
  if (hasWarnings) return IterationConclusion.SuccessWithWarnings;
  
  return IterationConclusion.Success;
}
```

## Proposed State Transitions

```
┌─────────────────────────────────────────────────────────────────┐
│                    ATTEMPT EXECUTION                             │
│                                                                  │
│  Agent runs → result has outcome                                 │
│    success → AttemptOutcome.Success                              │
│    failure → AttemptOutcome.Failure (with FailureKind)           │
│    timeout → AttemptOutcome.Timeout                              │
│    cancel  → AttemptOutcome.Cancelled                            │
│                                                                  │
│  Write attempt record (immutable)                                │
│                                                                  │
│  IF outcome == Success:                                          │
│    job.conclusion = JobConclusion.Success                        │
│    advance step pointer                                          │
│    DONE                                                          │
│                                                                  │
│  IF outcome != Success:                                          │
│    check retry.when conditions against failure_kind              │
│    IF matches retry.when AND attempt < max_attempts:             │
│      create new Attempt (immutable record)                       │
│      increment attempt counter                                   │
│      retry                                                        │
│    ELSE:                                                         │
│      computeJobConclusion(all_attempts, failure_policy)           │
│      set job.conclusion                                           │
│      set job.status = terminal status (matched to conclusion)    │
│      DONE                                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ITERATION CONCLUSION                          │
│                                                                  │
│  After all jobs in iteration reach terminal state:               │
│    computeIterationConclusion(all_jobs)                           │
│    set iteration.conclusion                                       │
│                                                                  │
│  IF conclusion == Failure:                                       │
│    evaluate group.failure_policy                                 │
│      fail → terminate run                                        │
│      continue → mark iteration, proceed to next (if any)        │
│      block → pause for human                                     │
│                                                                  │
│  IF conclusion == SuccessWithWarnings:                           │
│    proceed to next iteration (warnings persisted in state)       │
│                                                                  │
│  IF conclusion == Success:                                       │
│    proceed to next iteration                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    RUN CONCLUSION                                │
│                                                                  │
│  After all iterations complete:                                  │
│    run.conclusion = aggregate of iteration conclusions           │
│    Same cascade: any Failure → run failed                        │
│                  any Blocked → run blocked                       │
│                  any SuccessWithWarnings → run success+warnings  │
│                  all Success → run success                       │
└─────────────────────────────────────────────────────────────────┘
```

### Terminality constraint

Completed executions stay terminal. Once a job's `conclusion` is set, it is never changed. Retry always creates a new Attempt; Iteration always creates a new Iteration record. The engine only advances forward.

## Backward Compatibility

### Direct mapping of v0.6 constructs to v0.7

| v0.6 construct | v0.7 representation | Notes |
|---|---|---|
| `step.on_failure: "fail"` | `step.failure_policy: fail` | Trivial rename; same semantics |
| `step.on_failure: "block"` | `step.failure_policy: block` | Trivial rename |
| `step.on_failure: "continue"` | `step.failure_policy: continue` | Trivial rename |
| `step.on_failure: { retry_job: X }` | Internal translation: job-level `retry` config on target job X | Deprecated object form; engine translates internally |
| `step.on_failure: { activate_job: X }` | Internal translation: activate target job X | Deprecated object form |
| `step.on_failure: { goto_step: X }` | Internal translation: create new Iteration, set `current_step` to X | Deprecated; replaced by Iteration model |
| `step.on_failure: { status: "blocked" }` | `step.failure_policy: block` | Same effect |
| `retry.max_attempts` | `retry.max_attempts` | Unchanged |
| `retry.on_exceeded: { status: "failed" }` | `retry.on_exceeded: fail` | String instead of object |
| `retry.on_exceeded: { status: "blocked" }` | `retry.on_exceeded: block` | String instead of object |
| `retry.retry_with` | Removed; use explicit upstream outputs via iteration data flow | Deprecated in v0.6 already |
| `traverse.on_item_failure: "fail_all"` | `traverse.failure_policy: fail` | Same semantics |
| `traverse.on_item_failure: "continue"` | `traverse.failure_policy: continue` | Same semantics |
| `traverse.on_item_failure: "collect"` | `traverse.failure_policy: continue` + collect results in `item_results` | `collect` is a superset of `continue`; results always collected |
| `step.max_visits` | `retry.max_attempts` (job-level) or `repeat.max_iterations` (group-level) | Deprecated in v0.6 already |
| `step.if` condition | Remains as `step.if` (unchanged) | Not a failure mechanism |
| `step.returns.status` + `on_return` | `step.returns.status` (unchanged); `on_return` still maps status to RouterAction | Status return is a success-path mechanism, not failure |
| `reconcileTerminalState` function | Replaced by `computeRunConclusion` (pure function applied after each batch) | Same logic, extracted to pure function |
| `recordAgentFailure` `errorType` param | Replaced by `failure_kind` field (FailureKind enum) | String → typed enum |

### Migration strategy

1. **Schema parser**: Accept both `on_failure` (deprecated) and `failure_policy` (new) on step definitions. When both present, `failure_policy` wins. Emit deprecation warning for `on_failure`.

2. **Internal translation**: In `loadWorkflow`, normalize `on_failure` to `failure_policy`:
   - `"fail"` → `"fail"`
   - `"block"` → `"block"` 
   - `"continue"` → `"continue"`
   - `{ status: "failed" }` → `"fail"`
   - `{ status: "blocked" }` → `"block"`
   - Object-form routing actions → keep as `on_failure_action` (internal field, not exposed to new model)

3. **State migration**: The `JobState.status` field remains for backward compatibility. New fields (`outcome`, `conclusion`, `failure_kind`) are added alongside, not replacing. Old code that reads `job.status` continues to work.

4. **Compatibility window**: v0.7 accepts both old and new forms. v1.0 removes `on_failure` and object-form routing actions from the schema.

### Compatibility with existing `reconcileTerminalState` logic

The current `reconcileTerminalState` (runAll.ts:1230-1260) is defined as:

```
if any required job failed → run failed
if any required job blocked → run blocked
if all non-inactive jobs completed → run completed
```

The new `computeRunConclusion` is a superset:

```
for each iteration:
  computeIterationConclusion(jobs)
    critical job failed → iteration failed
    critical job blocked → iteration blocked
    non-critical job failed → success_with_warnings
    all success → success

aggregate iterations:
  any iteration failed → run failed
  any iteration blocked → run blocked
  any iteration success_with_warnings → run success_with_warnings
  all success → run success
```

For v0.6 workflows with no `failure_policy` declared (all jobs implicitly `fail`), all jobs are critical, and the behavior is identical to the current `reconcileTerminalState`.

### Known issue to fix

`recordAgentFailure.ts` line 277 prematurely sets `run.status = onExceededStatus` before other jobs in the batch have completed. This is already mitigated by `reconcileTerminalState` (Issue #229), but the v0.7 model fixes it properly: `recordAgentFailure` sets only `job.conclusion` and `job.status`, never `run.status`. The run conclusion is computed after all jobs in the batch settle.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Three-level cascade (job → iteration → group) is too complex for users | Medium | Default all levels to `fail` (current behavior); only advanced users configure `continue` at specific levels. Schema can flatten to two levels if feedback indicates three is too many. |
| `failure_kind` taxonomy is incomplete | Medium | Start with the seven known values; add an extension mechanism (`failure_kind: "custom"` + `failure_reason: string`) for unknown cases. The enum is closed to ensure exhaustive handling in `when` conditions. |
| `success_with_warnings` could mask real failures | Low | Warnings are always persisted in state and events. CLI inspect shows them prominently. The `block` policy is available for workflows that need human review. |
| Object-form `on_failure` actions (retry_job, activate_job) have complex internal translation | Medium | These are already deprecated in v0.6. The internal translation layer handles them; they are not exposed in the new model. |
| Duplicated retry logic between `recordAgentFailure` and `routing.ts` | Low | v0.7 consolidates retry into a single `evaluateRetryPolicy` function called from both paths. Already tracked as part of WF-7.1. |
| `recordAgentFailure` premature run.status overwrite | Low | Fixed by the new model: `recordAgentFailure` only sets job-level state; run conclusion is computed separately. |

## Next Action

1. **Update phase plan** (`02-development-plan.md`) with the decisions from this report, specifically:
   - Confirmed: `failure_policy` at job level with step-level override (A3)
   - Confirmed: Hierarchical cascade job → iteration → group (B1)
   - Confirmed: `continue` = skip failed job, mark job `failed`, continue iteration (C1)
   - Confirmed: Separate `AttemptOutcome` and `JobConclusion` enums (D3)
   - Confirmed: Fixed conclusion rule (first success wins) + `retry.when` for selectivity (E2)
   - Confirmed: Criticality derived from `failure_policy` (F2)

2. **Proceed to WF-7.3 Step 2** (implementation) with the consolidated data model in this report.

3. **Coordinate with R1** (Attempt model) to align `failure_kind` taxonomy and `retry.when` conditions.

4. **Coordinate with R2** (Job Group DAG) to align iteration conclusion computation with group-level `failure_policy`.
