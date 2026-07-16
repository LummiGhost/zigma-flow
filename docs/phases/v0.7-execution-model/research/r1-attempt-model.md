# Research Report: Execution Attempt Model Detail Design

Date: 2026-07-16
Author: Research agent (R1)
Status: Complete
Inputs: `D:\zigma\zigma-flow\docs\phases\v0.7-execution-model\02-development-plan.md`, codebase analysis

## Question

Design the data model for `Attempt` as a first-class immutable execution record. This covers six interdependent design decisions:

- **Decision a**: Attempt identity and numbering scheme
- **Decision b**: Attempt state shape (rich vs. summary)
- **Decision c**: `failure_kind` taxonomy design
- **Decision d**: Retry policy `when` condition syntax
- **Decision e**: Job conclusion computation from attempts
- **Decision f**: Artifact path compatibility with the new Attempt model

### Constraints

1. Must be backward-compatible with existing retry mechanism (old `retry_job`, `retry_with`, `max_attempts` get internally translated)
2. Completed executions stay terminal -- never mutate status backward
3. Retry always produces new records
4. Engine state only advances forward
5. Agent returns domain results (`failure_kind`), not engine actions (`retry_job`)
6. Must work within the existing TypeScript codebase at `D:\zigma\zigma-flow`

### Current Baseline (from codebase analysis)

**State model** (`src/run/index.ts`):
- `JobState.attempt` is an optional `number` (1-based, defaults to 1 when absent)
- `JobState.status` is mutated in-place on retry: `"failed"` -> `"ready"` (via `"job_retrying"` event)
- `JobState.current_step` is cleared on retry
- `JobState.retry_reason` and `JobState.retry_inputs` are stored alongside the current attempt -- overwritten on each retry
- Old attempt data preserved only in: `events.jsonl` (step events carry `attempt` field) and artifact directories (`jobs/<jobId>/attempts/<n>/steps/<stepId>/`)

**Retry flow** (`src/engine/retryJob.ts`, `src/engine/recordAgentFailure.ts`, `src/engine/routing.ts`):
1. Agent fails -> `recordAgentFailure` writes `step_failed` event
2. If `attempt < max_attempts`: set job `status = "failed"`, call `retryJob`
3. `retryJob` emits `job_retrying` event, sets `status = "ready"`, increments `attempt`, clears `current_step`
4. Next loop iteration picks up `ready` job

**`max_attempts`** comes from `workflow.jobs[jobId].retry.max_attempts` (default 1). Type is `Record<string, unknown>` in schema.
**`on_exceeded`** controls terminal state when attempts exhausted: `{ status: "blocked" | "failed" }` (default `"blocked"`).

**Artifact path** (`src/artifact/artifactPaths.ts`):
```
jobs/<jobId>/attempts/<attempt>/steps/<stepId>/
```
Already scoped by attempt number. Old artifacts preserved.

**Event types** (`src/events/eventTypes.ts`): 45 event types including:
- Retry-related: `job_retrying` (with `JobRetryingPayload: { job_id, attempt, reason }`)
- Step events: `step_started`, `step_completed`, `step_failed` (all carry `attempt` in payload)
- Job terminal: `job_completed` (carries `attempt`), `job_failed` (does NOT carry `attempt`), `job_blocked` (does NOT carry `attempt`)

**Key gap**: There is no structured record of a complete attempt. The "attempt" is an implicit concept derived from event correlation and artifact directories. To compute what happened in attempt 2 of job "implement", you must:
1. Find all events where `job = "implement"` AND `attempt = 2`
2. Look at files under `jobs/implement/attempts/2/`

---

## Options Evaluated

### Decision a: Attempt Identity And Numbering

| Option | Pros | Cons | Validation evidence |
| --- | --- | --- | --- |
| **Per-job monotonic** (1,2,3 within each job) | Human-readable ("attempt 2 of job implement"); already in artifact paths; matches event envelope `attempt` field; minimal migration | Two jobs can both have "attempt 3" -- not globally unique | `artifactPaths.ts` line 62-67: `artifactStepRelativePath` uses `String(attempt)` scoped under `job`; event envelope `attempt: number \| null` (line 432); all event payloads carry `attempt: number` |
| Global monotonic (unique across run) | Globally unique identifier; simplifies cross-job correlation | Not human-readable ("attempt-17" vs "implement attempt 2"); complex to implement; breaks existing artifact path convention; no current use case requiring global uniqueness | No current code uses cross-job attempt correlation |
| Iteration-scoped (reset per iteration) | Matches future Job Group Iteration model | Confusing when reading events without iteration context; iteration concept does not exist yet | No current code; iteration is future concept (WF-7.2) |

### Decision b: Attempt State Shape

| Option | Pros | Cons | Validation evidence |
| --- | --- | --- | --- |
| **Full record** (Attempt contains status + outputs + step_states) | Self-contained; fast queries; simple inspection | Large state.json; duplicates data already in events.jsonl; output data can be large; breaks single-writer invariant (step executors would need to write to Attempt) | `JobState.outputs` is `Record<string, unknown>` -- can be large; state.json is atomic-write (line 249-258 of `run/index.ts`); event-first-then-state invariant |
| **Light summary** (Attempt is a pointer, data stays in events) | Minimal state.json size; no data duplication; events remain single source of truth | Slow to answer "what happened in attempt 2?" -- requires event log scan; no way to quickly show attempt summary in CLI | `JobState` has no attempt history at all currently; `RunAllSummary` (line 212-221 of `runAll.ts`) derives `attempts: number` from `js.attempt` |
| **Hybrid** (Attempt has key fields: status, timing, outcome, failure_kind; step details in events) | Balanced; fast for common queries (CLI inspect, policy evaluation); compact; no event duplication | Extra schema to maintain; decision boundary: "what goes in Attempt vs. events?" | Current `JobState` already summarizes (status, attempt number); events provide detail |

### Decision c: failure_kind Taxonomy

| Option | Pros | Cons | Validation evidence |
| --- | --- | --- | --- |
| **Closed enum** (`timeout \| infrastructure_error \| invalid_output \| agent_error \| cancelled \| permission_denied \| config_error`) | Type-safe; exhaustive checking; predictable retry policy matching | Inflexible to new failure modes without code change | `recordAgentFailure.ts` line 63: `errorType` already uses `"config" \| "permission" \| "timeout" \| "execution"`; `classifyError()` (line 114-140 of `runAll.ts`) does string matching on error text |
| **Extensible string** with well-known constants | Open for extension; no schema change for new failure kinds | No compile-time checks; typos in policy `when` fields go undetected; harder to audit | N/A |
| **Status codes** (like HTTP/gRPC) | Structured; well-known pattern | Over-engineered for this use case; agents already return human-readable reasons; code-to-label mapping adds indirection | N/A |

### Decision d: Retry Policy `when` Conditions

| Option | Pros | Cons | Validation evidence |
| --- | --- | --- | --- |
| **Whitelist** (`when: [timeout, infra_error]`) | Explicit; safe by default; easy to audit; matches common practice (GitHub Actions, Argo Workflows) | Requires user to know failure taxonomy; verbose if they want "retry on almost everything" | Current `errorType` set: `"config"`, `"permission"`, `"timeout"`, `"execution"` (line 63-67 of `recordAgentFailure.ts`); config/permission never retry (line 164 of `recordAgentFailure.ts`); timeout/execution retryable |
| **Blacklist** (`unless: [invalid_output]`) | Concise when "retry on everything except X" | Dangerous default -- retrying on config errors is wasteful; a new failure kind that should not be retried is silently included | Current code explicitly excludes config/permission from retry (line 164-193 of `recordAgentFailure.ts`) |
| **Explicit object** (`when: { timeout: true, infra_error: true }`) | Very explicit; no ambiguity about defaults | Verbose; no benefit over array whitelist since values are boolean flags | N/A |

### Decision e: Job Conclusion Computation

| Option | Pros | Cons | Validation evidence |
| --- | --- | --- | --- |
| First success | Simple | Makes no sense -- retry is only triggered after failure; by definition, all prior attempts failed. The first success IS the last attempt. | Retry flow (line 208-231 of `recordAgentFailure.ts`): retry only when attempt < max_attempts AND the job failed. Success -> no retry. |
| **Last attempt outcome** (implicit) | Matches current behavior; naturally follows from "retry on failure only" model; no policy config needed | N/A -- this is the only logical option given the retry-on-failure semantics | Current behavior: final `JobState.status` reflects the last outcome (line 237-288 of `recordAgentFailure.ts`) |
| Majority | Robust but | No use case; retry on failure means majority is meaningless (all but last = failed) | N/A |
| Policy-driven | Flexible | Over-engineering for a non-problem; adds configuration complexity with no benefit | N/A |

### Decision f: Artifact Path for Attempts

| Option | Pros | Cons | Validation evidence |
| --- | --- | --- | --- |
| **Keep existing path** (`jobs/<jobId>/attempts/<n>/steps/<stepId>/`) | Zero migration; already correct; per-job monotonic numbering maps naturally | None | `artifactStepDir()` (line 89-96 of `artifactPaths.ts`): joins `runDir`, `"jobs"`, `job`, `"attempts"`, `String(attempt)`, `"steps"`, `step`; all callers (accept.ts, runAll.ts) pass `attempt` from `jobState.attempt` |
| Change to global monotonic number | Globally unique paths | Massive migration; breaks all existing run directories; no benefit | N/A |
| Flatten (remove `attempts` nesting) | Simpler paths | Loses scoping; old attempts clobber; no backward compat | Current path structure is correct and intentional |

---

## Recommendation

### Chosen Options Summary

| Decision | Choice | Primary rationale |
| --- | --- | --- |
| (a) Identity | **Per-job monotonic** (1,2,3 within each job) | Already established across codebase; natural naming |
| (b) State shape | **Hybrid** (Attempt has key summary fields; step history stays in events) | Fast CLI inspection + compact state.json + no event duplication |
| (c) failure_kind taxonomy | **Closed string union** with extension slot (`string` fallback) | Type safety for known kinds + future-proofing |
| (d) Retry `when` | **Whitelist array** (`when: ["timeout", "infra_error"]`); default = retry on transient failures | Safe by default; explicit; matches industry practice |
| (e) Conclusion | **Last attempt outcome** (implicit; no policy field) | Retry-on-failure semantics mean last attempt IS the conclusion |
| (f) Artifact path | **No change** (`jobs/<jobId>/attempts/<n>/steps/<stepId>/`) | Already correct; zero migration cost |

### Why These Choices

**Per-job monotonic identity** is the right choice because every existing code path already scopes attempt numbers to a job. The event envelope, artifact paths, prompt artifact writing, and CLI summary all use `jobId + attempt` pairs. Global monotonic would require changing all of these and would provide no practical benefit -- there is no current or planned use case for correlating attempts across jobs by a global ordinal.

**Hybrid state shape** avoids the two extremes. Full records would bloat `state.json` and duplicate the event log (violating single-source-of-truth). Light summaries would make CLI inspection slow (requiring event log scans for basic questions like "did attempt 2 fail because of timeout?"). The hybrid adds key attempt-level fields (status, timing, failure_kind, step count) while keeping step-level fidelity in events. This mirrors how `JobState` itself is a summary that does not replicate every step event.

**Closed string union with extension slot** is the pragmatic TypeScript pattern. Known values: `"timeout"`, `"infrastructure_error"`, `"invalid_output"`, `"agent_error"`, `"cancelled"`, `"permission_denied"`, `"config_error"`. Extension slot allows `string` for future values without schema changes. This maps directly to the existing `errorType` union (`"config" | "permission" | "timeout" | "execution"`) in `recordAgentFailure.ts`, renamed and expanded for clarity.

**Whitelist `when` array** is safer and more explicit than blacklist. The default `when` is `["timeout", "infrastructure_error", "agent_error"]` -- retry on transient failures, not on permanent ones. This matches current behavior where config/permission errors skip retry (line 164 of `recordAgentFailure.ts`). Users can override with explicit `when` or set `when: []` (never retry) or a broader list.

**Last attempt outcome** needs no configuration. Retry is only triggered on failure -- success terminates the job. Therefore, if a job has N attempts, attempts 1..N-1 all failed (that's why retry happened), and attempt N's outcome IS the job's conclusion. There is no ambiguity and no policy needed. The `max_attempts`/`on_exceeded` mechanism already covers the "what if all attempts fail" case.

**No change to artifact paths** because the current structure `jobs/<jobId>/attempts/<n>/steps/<stepId>/` is already correct, already scoped by per-job attempt number, and already used everywhere in the codebase.

### Rejected Options and Reasons

- **Global monotonic numbering**: Would require rewriting all artifact path producers and consumers, event envelope references, and CLI summary logic. No compensating benefit. Cross-job correlation is a non-requirement.
- **Full record Attempt**: Would duplicate step data from events into state.json (the events-first-then-state invariant already writes step events to disk before state mutations). Large outputs would bloat state.json.
- **Light summary Attempt**: Would make CLI `inspect` and retry policy evaluation require full event log scans. Too slow for common operations.
- **Blacklist `unless`**: Dangerous default -- if we add a new failure kind that should NOT be retried, blacklist silently includes it. Whitelist is safe: new kinds are excluded until explicitly added.
- **Conclusion policy field**: Unnecessary complexity. The retry-on-failure model means there is exactly one possible derivation: last attempt outcome.
- **Changing artifact paths**: Zero benefit, high migration cost. Current paths are intentionally designed this way.

---

## Proposed Data Model

### TypeScript Interfaces

```typescript
// ---------------------------------------------------------------------------
// FailureKind — closed string union with extension slot
// ---------------------------------------------------------------------------

/**
 * Well-known failure classifications.
 * Agents return these so the engine can evaluate retry policy.
 *
 * - timeout:          Agent backend timed out
 * - infrastructure_error: Network, disk, or backend infrastructure failure (transient)
 * - invalid_output:   Agent produced output that fails validation (permanent without input change)
 * - agent_error:      Agent execution failed for reasons not covered above
 * - cancelled:        Agent was cancelled by signal
 * - permission_denied: Agent lacks required permissions
 * - config_error:     Misconfiguration (wrong model, missing backend, etc.)
 *
 * Extension: any string is accepted at runtime but only well-known values
 * participate in retry policy matching. Custom values are treated as
 * agent_error for retry purposes.
 */
export type FailureKind =
  | "timeout"
  | "infrastructure_error"
  | "invalid_output"
  | "agent_error"
  | "cancelled"
  | "permission_denied"
  | "config_error"
  | (string & {}); // extension slot

/** Well-known failure kinds that the engine recognizes for policy evaluation. */
export const WELL_KNOWN_FAILURE_KINDS: ReadonlySet<FailureKind> = new Set([
  "timeout",
  "infrastructure_error",
  "invalid_output",
  "agent_error",
  "cancelled",
  "permission_denied",
  "config_error",
]);

/**
 * Transient failure kinds — retryable by default.
 * These represent failures that may resolve on a subsequent attempt
 * without changes to inputs or configuration.
 */
export const TRANSIENT_FAILURE_KINDS: ReadonlySet<FailureKind> = new Set([
  "timeout",
  "infrastructure_error",
  "agent_error",
]);

// ---------------------------------------------------------------------------
// Attempt — first-class immutable execution record
// ---------------------------------------------------------------------------

export interface Attempt {
  /** Per-job monotonic attempt number (1-based). */
  number: number;

  /** Terminal status of this attempt. */
  status: "success" | "failure" | "cancelled";

  /** Failure classification. Present iff status is "failure". */
  failure_kind?: FailureKind;

  /** Human-readable failure reason. Present iff status is "failure" or "cancelled". */
  failure_reason?: string;

  /** ISO 8601 timestamp when the attempt started (first step_started). */
  started_at: string;

  /** ISO 8601 timestamp when the attempt ended (last step_failed / job_completed). */
  ended_at: string;

  /**
   * Number of steps executed in this attempt.
   * Allows fast "was this attempt short or long?" inspection without
   * counting events.
   */
  step_count: number;

  /**
   * Job outputs captured at the end of this attempt.
   * Present iff status is "success" and the job produced outputs.
   *
   * This is a *snapshot* — it captures what outputs looked like when this
   * attempt completed. The active JobState.outputs still holds the latest
   * (for expression resolution during subsequent attempts/jobs), but
   * attempt.outputs preserves the historical value for audit.
   *
   * Can be omitted if outputs are large — the primary source is still the
   * step-level report.json artifacts.
   */
  outputs?: Record<string, unknown>;

  /**
   * Inputs provided to this attempt via retry_with.
   * Present iff this attempt was triggered with retry_inputs.
   */
  retry_inputs?: Record<string, string>;

  /**
   * Reason why this attempt was initiated (from retry_reason).
   * Null for the initial attempt.
   */
  initiation_reason?: string;
}

// ---------------------------------------------------------------------------
// RetryPolicy — declarative retry configuration (replaces max_attempts-only)
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Maximum number of attempts (including the initial one). Default: 1 (no retry). */
  max_attempts?: number;

  /**
   * Failure kinds that trigger a retry.
   *
   * - When absent: defaults to TRANSIENT_FAILURE_KINDS (timeout, infrastructure_error, agent_error).
   * - When present: only the listed kinds trigger retry.
   * - When empty array ([]): never retry, regardless of max_attempts.
   *
   * Non-well-known failure kinds (custom strings) are treated as agent_error
   * for matching purposes. That is, a custom failure kind triggers retry
   * iff "agent_error" is in the when list.
   */
  when?: FailureKind[];

  /**
   * What to do when max_attempts is exhausted.
   * Default: "blocked".
   */
  on_exceeded?: {
    status: "blocked" | "failed";
  };

  /**
   * Maximum delay in milliseconds before starting the next attempt.
   * Not enforced by engine in v0.7 — reserved for v0.8 exponential backoff.
   * @reserved
   */
  max_delay_ms?: number;
}

// ---------------------------------------------------------------------------
// JobConclusion — derived from attempt history
// ---------------------------------------------------------------------------

/**
 * A job's conclusion is derived from its attempt history.
 * It is NOT a mutable field — it is computed from the attempts array.
 *
 * - success:  the last attempt completed successfully
 * - failure:  all attempts failed, max_attempts exhausted
 * - blocked:  all attempts failed, max_attempts exhausted, on_exceeded = "blocked"
 * - cancelled: the last attempt was cancelled
 *
 * The conclusion directly maps to the job's status field:
 *   JobState.status = conclusion
 */
export type JobConclusion = "success" | "failure" | "blocked" | "cancelled";

// ---------------------------------------------------------------------------
// Updated JobState
// ---------------------------------------------------------------------------

/**
 * Updated JobState — adds `attempts` array and `retry_policy` fields.
 *
 * Backward compatibility:
 * - `attempt` (number | undefined): kept as a pointer to the current/last
 *    attempt number. Derived from `attempts[attempts.length-1].number`.
 * - Old fields (retry_reason, retry_inputs): retained but their data is
 *    also stored in the latest Attempt record. Eventually deprecated.
 */
export interface JobState {
  status: "ready" | "waiting" | "inactive" | "running" | "done" | "completed" | "failed" | "blocked";
  activation?: string;
  /** @deprecated Use attempts[attempts.length-1].number instead. Kept for backward compat. */
  attempt?: number;
  current_step?: string;
  activated?: boolean;
  activation_reason?: string;
  /** @deprecated Use attempts[attempts.length-1].initiation_reason. Kept for backward compat. */
  retry_reason?: string;
  /** @deprecated Use attempts[attempts.length-1].retry_inputs. Kept for backward compat. */
  retry_inputs?: Record<string, string>;
  outputs?: Record<string, unknown>;
  step_visits?: Record<string, number>;
  step_status?: "awaiting_human" | "awaiting_input";

  /** Immutable attempt history. New attempts are appended; never modified. */
  attempts?: Attempt[];

  /** Resolved retry policy for this job (from workflow config). */
  retry_policy?: RetryPolicy;
}

// ---------------------------------------------------------------------------
// Helper: derive JobConclusion from attempts
// ---------------------------------------------------------------------------

export function deriveJobConclusion(
  attempts: Attempt[],
  onExceeded: "blocked" | "failed" = "blocked",
): JobConclusion {
  if (attempts.length === 0) return "failure"; // should not happen

  const last = attempts[attempts.length - 1]!;
  if (last.status === "success") return "success";
  if (last.status === "cancelled") return "cancelled";
  // last.status === "failure"
  return onExceeded; // "blocked" or "failed"
}
```

---

## Proposed Event Types

### New Events

```typescript
// ---------------------------------------------------------------------------
// attempt_started — emitted when a new attempt begins
// ---------------------------------------------------------------------------

export interface AttemptStartedPayload {
  job_id: string;
  attempt: number;
  /** Reason for this attempt. Empty string for the initial attempt. */
  reason: string;
}

// ---------------------------------------------------------------------------
// attempt_completed — emitted when an attempt finishes successfully
// ---------------------------------------------------------------------------

export interface AttemptCompletedPayload {
  job_id: string;
  attempt: number;
  step_count: number;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// attempt_failed — emitted when an attempt finishes with failure
// ---------------------------------------------------------------------------

export interface AttemptFailedPayload {
  job_id: string;
  attempt: number;
  failure_kind: FailureKind;
  reason: string;
  step_count: number;
  duration_ms: number;
}
```

### Updated Existing Event Payloads

```typescript
// job_failed — add failure_kind
export interface JobFailedPayload {
  job_id: string;
  reason: string;
  failure_kind?: FailureKind; // NEW
}

// job_blocked — add failure_kind
export interface JobBlockedPayload {
  job_id: string;
  reason: string;
  failure_kind?: FailureKind; // NEW
}

// job_retrying — add failure_kind to distinguish retry reasons
export interface JobRetryingPayload {
  job_id: string;
  attempt: number;
  reason: string;
  failure_kind?: FailureKind; // NEW
}
```

### New Event Type Tags Added to `ZigmaFlowEventType`

```typescript
| "attempt_started"
| "attempt_completed" 
| "attempt_failed"
```

(3 new tags, total goes from 45 to 48)

---

## Proposed State Transitions

### Attempt Lifecycle

```
                 ┌──────────────┐
                 │ attempt open │
                 │ (JobState    │
                 │  .attempts[-1]│
                 │  .status=open)│
                 └──────┬───────┘
                        │
          ┌─────────────┼─────────────┐
          │             │             │
          v             v             v
    ┌──────────┐  ┌──────────┐  ┌───────────┐
    │ success  │  │ failure  │  │ cancelled │
    │ (all     │  │ (step_   │  │ (signal   │
    │  steps   │  │  failed, │  │  abort)   │
    │  ok,     │  │  agent_  │  │           │
    │  job_    │  │  failed, │  │           │
    │  completed│  │  etc.)  │  │           │
    └────┬─────┘  └────┬─────┘  └─────┬─────┘
         │             │              │
         │             │              │
         v             v              v
    ┌──────────┐  ┌──────────┐  ┌───────────┐
    │ attempt  │  │ evaluate │  │ attempt   │
    │ completed│  │ retry    │  │ failed    │
    │ event    │  │ policy   │  │ event     │
    │ emitted  │  └────┬─────┘  │ emitted   │
    │          │       │        │           │
    │ job.concl│  ┌────┼────┐   │ job.concl │
    │ = success│  │yes │ no │   │ = cancelled│
    └──────────┘  │    │    │   └───────────┘
                  v    v    v
          ┌───────┐  ┌──────────────┐
          │ new   │  │ max_attempts │
          │ attempt│  │ exhausted    │
          │ created│  │ → job blocked│
          │        │  │    or failed │
          │ attempt│  └──────────────┘
          │ _started│
          │ event  │
          │ emitted│
          └───────┘
```

### Job Status Relationship to Attempts

| Job Status | Attempts State | Meaning |
| --- | --- | --- |
| `ready` | `attempts.length = 0` or `attempts[-1].status = "failure"` (retry triggered) | Ready to start next attempt |
| `running` | `attempts[-1]` is open (no concluded status) | Currently executing |
| `completed` | `attempts[-1].status = "success"` | Last attempt succeeded |
| `failed` | `attempts[-1].status = "failure"` + `on_exceeded = "failed"` | All attempts exhausted, marked failed |
| `blocked` | `attempts[-1].status = "failure"` + `on_exceeded = "blocked"` | All attempts exhausted, marked blocked |
| `cancelled` | `attempts[-1].status = "cancelled"` | Run was cancelled during this job |

### Backward Compatibility: Translation of Old retry_job to New Attempt Model

When the engine encounters a `retry_job` router action (deprecated path), it internally:

1. Appends a new `Attempt` record to `state.jobs[targetJobId].attempts`:
   ```typescript
   const concludedAttempt: Attempt = {
     number: currentAttempt,
     status: "failure",
     failure_kind: "agent_error", // inferred from context
     failure_reason: reason,
     started_at: /* from first step_started event for this attempt */,
     ended_at: clock.now(),
     step_count: /* from events */,
     retry_inputs: jobState.retry_inputs,
     initiation_reason: jobState.retry_reason,
   };
   ```
2. Creates a new open Attempt:
   ```typescript
   const newAttempt: Attempt = {
     number: nextAttempt,
     status: undefined, // open
     started_at: clock.now(),
     ended_at: undefined, // will be filled when attempt concludes
     step_count: 0,
     retry_inputs: action.retry_with,
     initiation_reason: reason,
   };
   ```
3. Emits `attempt_failed` (for the old attempt) and `attempt_started` (for the new)
4. Sets `JobState.status = "ready"`, `JobState.attempt = nextAttempt`
5. The engine loop picks up the ready job and executes the next attempt

The old `job_retrying` event is still emitted (for backward compatibility) but is now accompanied by `attempt_failed` + `attempt_started`.

Similarly, the initial attempt creation (when a job first becomes `ready`) now appends an open Attempt record and emits `attempt_started`.

---

## Risks

### Risk 1: Attempt record derivation from events requires event replay

When an old (pre-v0.7) run is resumed in a v0.7 engine, the `attempts` array will be empty, but `JobState.attempt` will be an existing number. The engine must handle the migration path.

**Mitigation**: On first access to `attempts` when it is undefined/empty but `attempt > 1`, the engine synthesizes minimal Attempt records from the existing events. This is a one-time migration at read time and only needed for runs created before v0.7.

### Risk 2: State.json size growth from immutable attempt records

Each Attempt adds ~200-500 bytes. At 10 attempts/job and 20 jobs, that's ~40-100 KB of additional state. For most workflows this is negligible, but for long-running workflows with many retries it could accumulate.

**Mitigation**: Start with full records. If size becomes an issue in v0.8+, consider making `attempts` a sparse index (only last N attempts in state.json, full history in events). Monitor with a size check in CI tests.

### Risk 3: Attempt timing (started_at, ended_at) may drift from events

If the engine's clock ticks between writing the Attempt record and the corresponding event, the timestamps could diverge.

**Mitigation**: Use the same `clock.now()` call for both the Attempt record and the event in the same code path. The `attempt_started` event and the Attempt's `started_at` field must use identical timestamps.

### Risk 4: Retry policy evaluation needs the concluded attempt's failure_kind

The engine reads `attempts[-1].failure_kind` to decide whether to retry. If the failure_kind is not set (e.g., for a pre-v0.7 attempt), it must fall back.

**Mitigation**: Default to `"agent_error"` when `failure_kind` is absent and the attempt status is `"failure"`. This matches current behavior where unclassified failures ARE retried.

---

## Next Action

### Plan Update Required

The development plan (`02-development-plan.md`) should be updated with the concrete decisions from this report:

- Line 131: "Attempt identity and numbering" -> **Resolved: per-job monotonic**
- Line 137: "failure_kind taxonomy" -> **Resolved: closed string union with extension slot**

### Implementation Implication

WF-7.1 implementation will need to touch these files:

| File | Change |
| --- | --- |
| `src/run/index.ts` | Add `Attempt`, `FailureKind`, `RetryPolicy`, `JobConclusion` types; extend `JobState` with `attempts`, `retry_policy` |
| `src/events/eventTypes.ts` | Add `attempt_started`, `attempt_completed`, `attempt_failed` event types + payloads; extend `job_failed`, `job_blocked`, `job_retrying` payloads with `failure_kind` |
| `src/engine/recordAgentFailure.ts` | Build Attempt record before retry; fill `failure_kind` from `errorType` mapping; emit `attempt_failed` |
| `src/engine/retryJob.ts` | Conclude current attempt as Attempt record; create new open Attempt; emit `attempt_failed` + `attempt_started` |
| `src/engine/routing.ts` | retry_job action: same treatment as retryJob |
| `src/engine/runAll.ts` | On first step execution, create open Attempt; on job completion, seal Attempt; `RunAllSummary` reads from `attempts` array |
| `src/engine/index.ts` (createRun) | Initialize empty `attempts` array on `JobState` (or omit for empty) |
| `src/workflow/index.ts` | Add `RetryPolicySchema` with `when` field to `JobSchema.retry` |
| `src/expression/index.ts` | Add `attempt` namespace to `ExpressionContext` (for `${{ attempt.number }}` etc.) |

**Backward-compat tests needed**: retry.test.ts, retryJob.test.ts should continue to pass with the new model -- old `retry_job` actions internally produce the same behavior through Attempt records.
