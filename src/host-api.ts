/**
 * Host API TypeScript interfaces for Zigma Flow v0.5.
 *
 * Defines the pure-type contract between Zigma Host (upper platform) and
 * Zigma Flow (workflow engine). This file contains zero runtime logic and
 * zero imports from modules with side effects — it is safe to import from
 * any consumer (Host, CLI, tests, adapters) without triggering engine or
 * filesystem initialization.
 *
 * The Host API exposes six methods:
 *   1. createRun          — start a new workflow run
 *   2. resumeRun          — resume a suspended/pending run
 *   3. getRunStatus       — read full run status
 *   4. approveHumanGate   — resolve a human gate step
 *   5. cancelRun          — cancel an active run
 *   6. collectRunEvidence — produce an evidence bundle for audit
 *
 * Reference: docs/mvp-contracts.md, GitHub issues #184-#189
 */

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * Identity and origin of the caller invoking a Host API method.
 *
 * Every Host API method that mutates state requires a CallerContext so
 * the engine can record who triggered the action and under what authority.
 */
export interface CallerContext {
  /** Authenticated end-user who initiated the action. */
  user: {
    /** Unique user identifier (provider-agnostic). */
    id: string;
    /** Display name. */
    name: string;
    /** Contact email. */
    email: string;
  };
  /** Actor that executed the action (may differ from user for service accounts). */
  actor: Actor;
  /** Originating system metadata. */
  source: {
    /** System name (e.g. "zigma-host", "zigma-cli"). */
    system: string;
    /** System version string. */
    version: string;
  };
  /** Permission grants held by the caller. */
  permissions: string[];
  /** Project scope the action targets. */
  project: {
    /** Project identifier. */
    id: string;
    /** Project scope / tenant. */
    scope: string;
  };
}

/**
 * Actor that performs a Host API action.
 *
 * The actor may be the same as the authenticated user or a distinct
 * service identity (e.g. a CI system, webhook handler, or scheduled job).
 */
export interface Actor {
  /** Actor category. */
  type: "user" | "system" | "service";
  /** Unique actor identifier. */
  id: string;
  /** Human-readable name (optional for system actors). */
  name?: string;
}

/**
 * Human gate decision values.
 *
 * - `approve` — the step is accepted; the engine advances the job.
 * - `reject` — the step is refused; the job transitions to failed.
 * - `request_changes` — the step needs revision; the job remains suspended
 *   and the agent is asked to rework before the gate can be resolved.
 */
export type Decision = "approve" | "reject" | "request_changes";

/**
 * Top-level run lifecycle status.
 *
 * Mirrors the `RunState.status` field. When status is absent (undefined)
 * the run is implicitly "running".
 */
export type RunStatus = "running" | "blocked" | "failed" | "completed" | "cancelled";

// ---------------------------------------------------------------------------
// 1. createRun (#184)
// ---------------------------------------------------------------------------

/**
 * Input for {@link createRun}.
 *
 * @precondition The referenced workflow must exist and be valid.
 * @precondition The caller must hold `workflow:execute` permission.
 *
 * @returns HostApiCreateRunResult with the assigned run ID and initial status.
 *
 * @error HostApiError with code `WORKFLOW_NOT_FOUND` if the workflow is missing.
 * @error HostApiError with code `VALIDATION_FAILED` if inputs do not match the
 *   workflow's declared input schema.
 * @error HostApiError with code `PERMISSION_DENIED` if the caller lacks
 *   required permissions.
 */
export interface HostApiCreateRunInput {
  /** Workflow name (as declared in the workflow definition's `name` field). */
  workflow: string;
  /** Named input values keyed by the workflow's declared input names. */
  inputs: Record<string, string>;
  /** Caller identity, origin, and authority. */
  callerContext: CallerContext;
}

/**
 * Result returned by {@link createRun}.
 */
export interface HostApiCreateRunResult {
  /** Opaque run identifier assigned by the engine (e.g. "20260714-0001"). */
  runId: string;
  /** Status immediately after creation — always "running". */
  initialStatus: RunStatus;
}

// ---------------------------------------------------------------------------
// 2. resumeRun (#185)
// ---------------------------------------------------------------------------

/**
 * Input for {@link resumeRun}.
 *
 * @precondition The run must exist and its status must be "blocked" or
 *   implicitly running (status undefined). Resuming a terminal run
 *   ("completed", "cancelled", "failed") is an error.
 * @precondition The caller must hold `run:resume` permission.
 *
 * @returns HostApiResumeRunResult with the post-resume run status.
 *
 * @error HostApiError with code `RUN_NOT_FOUND` if the run ID is unknown.
 * @error HostApiError with code `INVALID_STATE` if the run is terminal.
 * @error HostApiError with code `PERMISSION_DENIED` if the caller lacks
 *   required permissions.
 */
export interface HostApiResumeRunInput {
  /** Run identifier to resume. */
  runId: string;
  /** Caller identity, origin, and authority. */
  callerContext: CallerContext;
}

/**
 * Result returned by {@link resumeRun}.
 */
export interface HostApiResumeRunResult {
  /** The resumed run identifier. */
  runId: string;
  /** Run status after resumption. */
  status: RunStatus;
  /** Job IDs that transitioned from blocked/suspended back to ready/running. */
  resumedJobIds: string[];
}

// ---------------------------------------------------------------------------
// 3. getRunStatus (#186)
// ---------------------------------------------------------------------------

/**
 * Summary of a single job within a run.
 *
 * Redacted from the full {@link JobState} record — omits internal engine
 * fields (activation, retry_reason, step_visits) and exposes only
 * Host-relevant fields.
 */
export interface HostApiJobSummary {
  /** Job identifier. */
  jobId: string;
  /** Current job status. */
  status: string;
  /** The most recently completed step id, if any. */
  currentStep?: string;
  /** Current attempt number (1-based). */
  attempt?: number;
  /** Per-step status (e.g. "awaiting_human"). */
  stepStatus?: string;
  /** Accumulated job outputs from completed steps. */
  outputs?: Record<string, unknown>;
}

/**
 * A human gate that is currently awaiting a decision.
 */
export interface PendingHumanGate {
  /** Job containing the gated step. */
  jobId: string;
  /** Step awaiting human input. */
  stepId: string;
  /** Prompt presented to the human reviewer. */
  prompt: string;
  /** Expected approvers (informational — MVP does not enforce). */
  approvers?: string[];
  /** Additional instructions for the reviewer. */
  instructions?: string;
  /** ISO 8601 timestamp when the gate was entered. */
  enteredAt: string;
}

/**
 * Lightweight summary of the event log tail.
 *
 * Gives the Host enough information to decide whether to deep-read events
 * without scanning the full log.
 */
export interface HostApiEventSummary {
  /** Id of the most recent event (e.g. "evt-042"). */
  lastEventId: string;
  /** Type of the most recent event, if any events exist. */
  latestEventType?: string;
  /** ISO 8601 timestamp of the most recent event. */
  latestEventTimestamp?: string;
  /** Total number of events in the run's event log. */
  totalEventCount: number;
}

/**
 * Lightweight summary of the artifact index.
 */
export interface HostApiArtifactIndexSummary {
  /** Total number of artifacts produced by the run. */
  totalCount: number;
  /** Most recent artifact entries (newest first, capped at a reasonable limit). */
  latestEntries: HostApiArtifactIndexEntry[];
}

/**
 * A single entry in the artifact index summary.
 */
export interface HostApiArtifactIndexEntry {
  /** Artifact identifier. */
  id: string;
  /** Artifact kind (e.g. "human_gate_request", "agent_report", "script_output"). */
  kind: string;
  /** Relative path to the artifact file within the run directory. */
  path: string;
  /** MIME content type. */
  contentType: string;
  /** Size in bytes. */
  size: number;
  /** Short summary / first line of artifact content. */
  summary: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/**
 * Result returned by {@link getRunStatus}.
 *
 * This is the primary read path — it returns everything the Host needs
 * to render a run detail view without making multiple calls.
 */
export interface HostApiGetRunStatusResult {
  /** Run identifier. */
  runId: string;
  /** Current run status. */
  status: RunStatus;
  /** Workflow name. */
  workflow: string;
  /** Task description from run creation. */
  task: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp of the most recent state mutation. */
  updatedAt?: string;
  /** All jobs in the run with their current summaries. */
  jobs: HostApiJobSummary[];
  /** Human gates currently awaiting a decision. */
  pendingHumanGates: PendingHumanGate[];
  /** Tail-of-log event summary. */
  latestEventSummary: HostApiEventSummary;
  /** Artifact index summary. */
  artifactIndex: HostApiArtifactIndexSummary;
}

// ---------------------------------------------------------------------------
// 4. approveHumanGate (#187)
//
// @deprecated since v0.6 — use resumeRun (#210) instead for a more general
//   pause-and-resume protocol with structured input. approveHumanGate is kept
//   for backward compatibility. It will be removed in v1.0.
// ---------------------------------------------------------------------------

/**
 * Input for {@link approveHumanGate}.
 *
 * @deprecated since v0.6 — use {@link HostApiResumeRunWithInputInput} instead.
 *   The resumeRun protocol accepts arbitrary structured input and is not
 *   limited to approve/reject decisions.
 *
 * @precondition The referenced run, job, and step must exist and the step
 *   must be in `step_status: "awaiting_human"` or `"awaiting_input"`.
 * @precondition The caller must hold `run:decide` permission.
 *
 * @returns HostApiApproveHumanGateResult describing the outcome.
 *
 * @error HostApiError with code `RUN_NOT_FOUND` if the run ID is unknown.
 * @error HostApiError with code `JOB_NOT_FOUND` if the job ID is unknown.
 * @error HostApiError with code `STEP_NOT_FOUND` if the step ID is unknown.
 * @error HostApiError with code `NOT_AWAITING_HUMAN` if the step is not in
 *   the awaiting_human state.
 * @error HostApiError with code `PERMISSION_DENIED` if the caller lacks
 *   required permissions.
 */
export interface HostApiApproveHumanGateInput {
  /** Run identifier. */
  runId: string;
  /** Job containing the human gate step. */
  jobId: string;
  /** Step awaiting a human decision. */
  stepId: string;
  /** The decision being rendered. */
  decision: Decision;
  /** Optional comment explaining the decision. */
  comment?: string;
  /** The actor issuing the decision (recorded in the audit trail). */
  actor: Actor;
}

/**
 * Result returned by {@link approveHumanGate}.
 */
export interface HostApiApproveHumanGateResult {
  /** Run identifier. */
  runId: string;
  /** Job identifier. */
  jobId: string;
  /** Step identifier. */
  stepId: string;
  /** The decision that was recorded. */
  decision: Decision;
  /** ISO 8601 timestamp when the decision was recorded. */
  recordedAt: string;
  /**
   * Next action hint:
   * - `"continue"` — decision was "approve" / "request_changes"; job is still running.
   * - `"blocked"` — decision was "reject"; job moved to failed, run may be blocked.
   * - `"completed"` — decision was "approve" on the final step; job completed.
   */
  nextAction: "continue" | "blocked" | "completed";
}

// ---------------------------------------------------------------------------
// 4b. resumeRunWithInput (v0.6, Issue #210)
// ---------------------------------------------------------------------------

/**
 * Input for submitting structured human input to resume a paused run.
 *
 * This is the v0.6+ preferred mechanism for human gate resolution. Unlike
 * {@link approveHumanGate}, which only accepts approve/reject decisions,
 * `resumeRunWithInput` accepts arbitrary structured input defined by the
 * step's `inputs` schema.
 *
 * @precondition The referenced run, job, and step must exist and the step
 *   must be in `step_status: "awaiting_input"` or `"awaiting_human"`.
 * @precondition The caller must hold `run:resume` permission.
 *
 * @returns HostApiResumeRunWithInputResult describing the outcome.
 *
 * @error HostApiError with code `RUN_NOT_FOUND` if the run ID is unknown.
 * @error HostApiError with code `JOB_NOT_FOUND` if the job ID is unknown.
 * @error HostApiError with code `STEP_NOT_FOUND` if the step ID is unknown.
 * @error HostApiError with code `NOT_AWAITING_INPUT` if the step is not
 *   awaiting human input.
 * @error HostApiError with code `INPUT_VALIDATION_FAILED` if the submitted
 *   input does not match the step's input schema.
 * @error HostApiError with code `ALREADY_DECIDED` if a different decision
 *   has already been recorded for this step.
 * @error HostApiError with code `PERMISSION_DENIED` if the caller lacks
 *   required permissions.
 */
export interface HostApiResumeRunWithInputInput {
  /** Run identifier. */
  runId: string;
  /** Job containing the human gate step. */
  jobId: string;
  /** Step awaiting human input. */
  stepId: string;
  /** Structured input key-value pairs matching the step's input schema. */
  input: Record<string, string>;
  /** Optional comment explaining the input. */
  comment?: string;
  /** The actor submitting the input (recorded in the audit trail). */
  actor: Actor;
}

/**
 * Result returned by `resumeRunWithInput`.
 */
export interface HostApiResumeRunWithInputResult {
  /** Run identifier. */
  runId: string;
  /** Job identifier. */
  jobId: string;
  /** Step identifier. */
  stepId: string;
  /** The resolved outcome (e.g. "approved", "rejected"). */
  outcome: string;
  /** Whether this was a new submission or a duplicate. */
  status: "recorded" | "duplicate" | "already_decided";
  /** ISO 8601 timestamp when the input was recorded. */
  recordedAt: string;
  /**
   * Next action hint:
   * - `"continue"` — the step was resolved; job is still running.
   * - `"blocked"` — the step was rejected; job moved to failed.
   * - `"completed"` — the resolved step was the final step; job completed.
   */
  nextAction: "continue" | "blocked" | "completed";
}

// ---------------------------------------------------------------------------
// 5. cancelRun (#188)
// ---------------------------------------------------------------------------

/**
 * Run statuses from which cancellation is valid.
 *
 * A run can be cancelled only when it is actively "running" or "blocked".
 * Terminal statuses ("completed", "cancelled", "failed") are not cancellable.
 */
export type CancellableRunStatus = "running" | "blocked";

/**
 * Input for {@link cancelRun}.
 *
 * @precondition The run must exist and be in a cancellable state
 *   ("running" or "blocked"). Cancelling a terminal run is an error.
 * @precondition The caller must hold `run:cancel` permission.
 *
 * @returns HostApiCancelRunResult recording the cancellation.
 *
 * @error HostApiError with code `RUN_NOT_FOUND` if the run ID is unknown.
 * @error HostApiError with code `ALREADY_TERMINAL` if the run is already
 *   completed, cancelled, or failed.
 * @error HostApiError with code `PERMISSION_DENIED` if the caller lacks
 *   required permissions.
 */
export interface HostApiCancelRunInput {
  /** Run identifier to cancel. */
  runId: string;
  /** Human-readable reason for the cancellation. */
  reason: string;
  /** The actor requesting cancellation (recorded in the audit trail). */
  actor: Actor;
}

/**
 * Result returned by {@link cancelRun}.
 */
export interface HostApiCancelRunResult {
  /** The cancelled run identifier. */
  runId: string;
  /** Status before cancellation was applied. */
  previousStatus: CancellableRunStatus;
  /** New status — always "cancelled". */
  newStatus: "cancelled";
  /** ISO 8601 timestamp when cancellation was recorded. */
  cancelledAt: string;
  /** Reason supplied with the cancellation request. */
  reason: string;
  /** Actor who requested the cancellation. */
  cancelledBy: Actor;
}

// ---------------------------------------------------------------------------
// 6. collectRunEvidence (#189)
// ---------------------------------------------------------------------------

/**
 * High-level summary of a run for the evidence bundle.
 */
export interface RunEvidenceSummary {
  /** Run identifier. */
  runId: string;
  /** Workflow name. */
  workflow: string;
  /** Task description. */
  task: string;
  /** Final run status. */
  status: RunStatus;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 completion/cancellation/failure timestamp, if terminal. */
  completedAt?: string;
  /** Total number of jobs defined in the workflow. */
  totalJobs: number;
  /** Number of jobs that reached "completed" status. */
  completedJobs: number;
  /** Number of jobs that reached "failed" status. */
  failedJobs: number;
  /** Total number of events in the run's event log. */
  totalEvents: number;
}

/**
 * A single event entry in the evidence bundle.
 *
 * A filtered subset of the full {@link ZigmaFlowEvent} envelope — the Host
 * does not need the full discriminated union, only the common envelope
 * fields plus a payload summary.
 */
export interface EventEvidenceEntry {
  /** Event identifier (e.g. "evt-042"). */
  id: string;
  /** Event type tag. */
  type: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Component that emitted the event. */
  producer: string;
  /** Associated job, if any. */
  job?: string;
  /** Associated step, if any. */
  step?: string;
  /** Attempt number, if applicable. */
  attempt?: number;
  /** Serialisable snapshot of the event payload. */
  payloadSummary: Record<string, unknown>;
}

/**
 * A single entry from the artifact index, included in the evidence bundle.
 */
export interface ArtifactIndexEntry {
  /** Artifact identifier. */
  id: string;
  /** Artifact kind. */
  kind: string;
  /** Relative path to the artifact file. */
  path: string;
  /** MIME content type. */
  contentType: string;
  /** Size in bytes. */
  size: number;
  /** Short summary / first line of content. */
  summary: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/**
 * Evidence from a check-type step execution.
 */
export interface ValidationEvidence {
  /** Check identifier (matches the step definition's check id). */
  checkId: string;
  /** Job that ran the check. */
  jobId: string;
  /** Step that ran the check. */
  stepId: string;
  /** Whether the check passed. */
  passed: boolean;
  /** Failure messages if the check did not pass. */
  failures?: string[];
  /** ISO 8601 timestamp of the check execution. */
  timestamp: string;
}

/**
 * Evidence from a recorded human gate decision.
 */
export interface HumanDecisionEvidence {
  /** Job containing the human gate step. */
  jobId: string;
  /** Gated step. */
  stepId: string;
  /** The decision rendered. */
  decision: Decision;
  /** Optional comment from the reviewer. */
  comment?: string;
  /** Identity of the reviewer, if recorded. */
  decidedBy?: string;
  /** ISO 8601 timestamp of the decision. */
  timestamp: string;
}

/**
 * A known risk identified during run execution.
 *
 * Risks are surfaced by the engine when it detects conditions that do not
 * cause outright failure but may warrant operator attention (e.g. agent
 * timeouts, partial traverse failures, skipped steps due to conditions).
 */
export interface KnownRisk {
  /** Risk identifier (stable within the run). */
  riskId: string;
  /** Severity classification. */
  severity: "low" | "medium" | "high";
  /** Human-readable description of the risk. */
  description: string;
  /** Optional mitigation or recommended follow-up action. */
  mitigation?: string;
}

/**
 * Result returned by {@link collectRunEvidence}.
 *
 * This is a complete evidence bundle suitable for audit, compliance review,
 * or downstream analysis. It aggregates data from the run state, event log,
 * artifact index, and validation/human-decision records.
 */
export interface HostApiCollectEvidenceResult {
  /** Top-level run summary. */
  summary: RunEvidenceSummary;
  /** Filtered event log entries (all events, redacted to envelope + payload). */
  events: EventEvidenceEntry[];
  /** All artifact index entries. */
  artifacts: ArtifactIndexEntry[];
  /** Validation results from check-type steps. */
  validation: ValidationEvidence[];
  /** Recorded human gate decisions. */
  humanDecisions: HumanDecisionEvidence[];
  /** Known risks surfaced by the engine. */
  knownRisks: KnownRisk[];
}

// ---------------------------------------------------------------------------
// HostApiError
// ---------------------------------------------------------------------------

/**
 * Serializable error returned by every Host API method.
 *
 * Consumers MUST NOT depend on engine-internal error classes. The Host API
 * layer translates all internal errors into this flat shape before returning
 * to the upper platform.
 */
export interface HostApiError {
  /**
   * Machine-readable error code (e.g. "RUN_NOT_FOUND", "PERMISSION_DENIED").
   *
   * Stable across versions — consumers may match on this value.
   */
  code: string;
  /** Human-readable error message. */
  message: string;
  /**
   * Optional structured details (e.g. { runId: "abc", status: "completed" }).
   *
   * May contain arbitrary serialisable values. Consumers should treat this
   * as best-effort diagnostic data rather than a stable contract.
   */
  details?: Record<string, unknown>;
  /**
   * Optional suggestion for how to resolve the error (e.g. "Check that the
   * workflow exists and retry with a valid workflow name.").
   */
  suggestion?: string;
}
