/**
 * Event type catalog and discriminated union for the Zigma Flow event log.
 *
 * Reference: docs/mvp-contracts.md §2.4
 * WF-P4-EVENT Step 2.
 * WF-7.1: Added attempt_started, attempt_completed, attempt_failed.
 */

// ---------------------------------------------------------------------------
// ZigmaFlowEventType — the 48 event type tags (closed string union)
// ---------------------------------------------------------------------------

export type ZigmaFlowEventType =
  | "run_created"
  | "job_ready"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "prompt_generated"
  | "agent_report_accepted"
  | "agent_invoked"
  | "agent_completed"
  | "agent_timed_out"
  | "agent_failed"
  | "agent_cancelled"
  | "script_completed"
  | "check_completed"
  | "signal_received"
  | "router_decided"
  | "job_retrying"
  | "job_completed"
  | "run_blocked"
  | "run_failed"
  | "run_completed"
  | "run_cancelled"
  | "job_activated"
  | "job_skipped"
  | "job_blocked"
  | "job_failed"
  | "step_returned"
  | "variable_set"
  | "variable_deleted"
  | "context_block_updated"
  | "context_block_deleted"
  | "step_skipped"
  | "step_revisited"
  | "step_visit_exceeded"
  | "human_gate_waiting"
  | "human_decision"
  | "traverse_started"
  | "traverse_item_started"
  | "traverse_item_completed"
  | "traverse_item_failed"
  | "traverse_completed"
  | "execution_paused"
  | "execution_stopped"
  | "job_state_override"
  | "job_reset"
  // WF-7.1: Attempt model event types
  | "attempt_started"
  | "attempt_completed"
  | "attempt_failed";

/**
 * Runtime tuple of all event type tags.
 * Length is statically checked by the test suite.
 */
export const EVENT_TYPES: readonly ZigmaFlowEventType[] = [
  "run_created",
  "job_ready",
  "step_started",
  "step_completed",
  "step_failed",
  "prompt_generated",
  "agent_report_accepted",
  "agent_invoked",
  "agent_completed",
  "agent_timed_out",
  "agent_failed",
  "agent_cancelled",
  "script_completed",
  "check_completed",
  "signal_received",
  "router_decided",
  "job_retrying",
  "job_completed",
  "run_blocked",
  "run_failed",
  "run_completed",
  "run_cancelled",
  "job_activated",
  "job_skipped",
  "job_blocked",
  "job_failed",
  "step_returned",
  "variable_set",
  "variable_deleted",
  "context_block_updated",
  "context_block_deleted",
  "step_skipped",
  "step_revisited",
  "step_visit_exceeded",
  "human_gate_waiting",
  "human_decision",
  "traverse_started",
  "traverse_item_started",
  "traverse_item_completed",
  "traverse_item_failed",
  "traverse_completed",
  "execution_paused",
  "execution_stopped",
  "job_state_override",
  "job_reset",
  // WF-7.1: Attempt model event types
  "attempt_started",
  "attempt_completed",
  "attempt_failed",
] as const;

// ---------------------------------------------------------------------------
// Payload interfaces — one per event type
// ---------------------------------------------------------------------------

export interface RunCreatedPayload {
  workflow: string;
  task: string;
}

export interface JobReadyPayload {
  job_id: string;
}

export interface StepStartedPayload {
  job_id: string;
  step_id: string;
  attempt: number;
}

export interface StepCompletedPayload {
  job_id: string;
  step_id: string;
  attempt: number;
  outputs?: Record<string, unknown>;
}

export interface StepFailedPayload {
  job_id: string;
  step_id: string;
  attempt: number;
  reason: string;
}

export interface PromptGeneratedPayload {
  job_id: string;
  step_id: string;
  prompt_artifact: string;
  prompt_packet_artifacts?: {
    system: string;
    task: string;
    step: string;
    context: string;
    output: string;
    manifest: string;
  };
}

export interface AgentReportAcceptedPayload {
  job_id: string;
  step_id: string;
  report_artifact: string;
}

export interface AgentInvokedPayload {
  backend_name: string;
  command: string;
  args_hash: string;
  timeout_ms: number;
  step_artifact_dir: string;
}

export interface AgentCompletedPayload {
  duration_ms: number;
  stdout_artifact?: string;
  stderr_artifact?: string;
  invocation_artifact?: string;
}

export interface AgentTimedOutPayload {
  duration_ms: number;
  timeout_ms: number;
  stdout_artifact?: string;
  stderr_artifact?: string;
}

export interface AgentFailedPayload {
  duration_ms: number;
  exit_code: number;
  reason: string;
  stdout_artifact?: string;
  stderr_artifact?: string;
}

export interface AgentCancelledPayload {
  duration_ms: number;
  reason: string;
}

export interface ScriptCompletedPayload {
  job_id: string;
  step_id: string;
  exit_code: number;
  timed_out: boolean;
}

export interface CheckCompletedPayload {
  job_id: string;
  step_id: string;
  check_id: string;
  passed: boolean;
  failures?: string[];
}

export interface SignalReceivedPayload {
  signal: string;
  from_job: string;
  from_step: string;
}

export interface RouterDecidedPayload {
  job_id: string;
  step_id: string;
  action: string;
  target?: string;
}

export interface JobRetryingPayload {
  job_id: string;
  attempt: number;
  reason: string;
  failure_kind?: string; // WF-7.1: failure classification for the concluded attempt
}

export interface JobCompletedPayload {
  job_id: string;
  attempt: number;
}

export interface RunBlockedPayload {
  job_id?: string;
  step_id?: string;
  reason: string;
}

export interface RunFailedPayload {
  reason: string;
}

export type RunCompletedPayload = Record<string, never>;

export interface RunCancelledPayload {
  reason: string;
}

export interface JobActivatedPayload {
  job_id: string;
  reason: string;
}

export interface JobSkippedPayload {
  job_id: string;
  target: string;
  reason: string;
}

export interface JobBlockedPayload {
  job_id: string;
  reason: string;
  failure_kind?: string; // WF-7.1: failure classification
}

export interface JobFailedPayload {
  job_id: string;
  reason: string;
  failure_kind?: string; // WF-7.1: failure classification
}

export interface StepReturnedPayload {
  job_id: string;
  step_id: string;
  status: string;
  mapped_action: string;
}

// ---------------------------------------------------------------------------
// WF-7.1: Attempt model event payload interfaces
// ---------------------------------------------------------------------------

export interface AttemptStartedPayload {
  job_id: string;
  attempt: number;
  /** Reason for this attempt. Empty string for the initial attempt. */
  reason: string;
}

export interface AttemptCompletedPayload {
  job_id: string;
  attempt: number;
  step_count: number;
  duration_ms: number;
}

export interface AttemptFailedPayload {
  job_id: string;
  attempt: number;
  failure_kind: string;
  reason: string;
  step_count: number;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// WF-P13-VARIABLES payload interfaces
// ---------------------------------------------------------------------------

export interface VariableSetPayload {
  variable: string;
  value: unknown;
  producer: string;
}

export interface VariableDeletedPayload {
  variable: string;
  producer: string;
}

export interface ContextBlockUpdatedPayload {
  block: string;
  version: number;
  artifact_ref: string;
  producer: string;
  operation?: string;
}

export interface ContextBlockDeletedPayload {
  block: string;
  producer: string;
}

// ---------------------------------------------------------------------------
// WF-P13-FLOW payload interfaces
// ---------------------------------------------------------------------------

export interface StepSkippedPayload {
  job_id: string;
  step_id: string;
  condition: string;
}

export interface StepRevisitedPayload {
  job_id: string;
  step_id: string;
  target_step: string;
  visit_count: number;
}

export interface StepVisitExceededPayload {
  job_id: string;
  step_id: string;
  max_visits: number;
  visit_count: number;
}

// ---------------------------------------------------------------------------
// WF-P15-HUMAN-GATE payload interfaces
// ---------------------------------------------------------------------------

export interface HumanGateWaitingPayload {
  job_id: string;
  step_id: string;
  prompt: string;
  approvers?: string[];
  instructions?: string;
  step_artifact_dir: string;
}

export interface HumanDecisionPayload {
  job_id: string;
  step_id: string;
  decision: "approved" | "rejected";
  comment?: string;
  decided_by?: string;
  outputs?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// WF-P16-TRAVERSE payload interfaces (Issue #179)
// ---------------------------------------------------------------------------

export interface TraverseStartedPayload {
  traverse_id: string;
  item_count: number;
  concurrency: number;
  target_job: string;
}

export interface TraverseItemStartedPayload {
  traverse_id: string;
  item_index: number;
  item_key: string;
}

export interface TraverseItemCompletedPayload {
  traverse_id: string;
  item_index: number;
  outputs?: Record<string, unknown>;
}

export interface TraverseItemFailedPayload {
  traverse_id: string;
  item_index: number;
  error: string;
}

export interface TraverseCompletedPayload {
  traverse_id: string;
  results_count: number;
  errors_count: number;
}

// ---------------------------------------------------------------------------
// Debugging checkpoint payload interfaces (--pause-before, --stop-after)
// ---------------------------------------------------------------------------

export interface ExecutionPausedPayload {
  reason: string;
  instruction: string;
}

export interface ExecutionStoppedPayload {
  reason: string;
  instruction: string;
}

export interface JobStateOverridePayload {
  job_id: string;
  from_status: string;
  to_status: string;
  reason: string;
}

export interface JobResetPayload {
  job_id: string;
  from_status: string;
  to_status: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// EventEnvelope — the common envelope wrapping every event
// ---------------------------------------------------------------------------

export interface EventEnvelope {
  id: string;
  run_id: string;
  type: ZigmaFlowEventType;
  timestamp: string;         // ISO 8601
  producer: string;
  job: string | null;
  step: string | null;
  attempt: number | null;
  /** UUID v4 identifying the concurrent batch that emitted this event (AD-P14-006). */
  batch_id?: string;
}

// ---------------------------------------------------------------------------
// ZigmaFlowEvent — discriminated union of all 36 concrete event types
// ---------------------------------------------------------------------------

export type ZigmaFlowEvent =
  | (EventEnvelope & { type: "run_created"; payload: RunCreatedPayload })
  | (EventEnvelope & { type: "job_ready"; payload: JobReadyPayload })
  | (EventEnvelope & { type: "step_started"; payload: StepStartedPayload })
  | (EventEnvelope & { type: "step_completed"; payload: StepCompletedPayload })
  | (EventEnvelope & { type: "step_failed"; payload: StepFailedPayload })
  | (EventEnvelope & { type: "prompt_generated"; payload: PromptGeneratedPayload })
  | (EventEnvelope & { type: "agent_report_accepted"; payload: AgentReportAcceptedPayload })
  | (EventEnvelope & { type: "agent_invoked"; payload: AgentInvokedPayload })
  | (EventEnvelope & { type: "agent_completed"; payload: AgentCompletedPayload })
  | (EventEnvelope & { type: "agent_timed_out"; payload: AgentTimedOutPayload })
  | (EventEnvelope & { type: "agent_failed"; payload: AgentFailedPayload })
  | (EventEnvelope & { type: "agent_cancelled"; payload: AgentCancelledPayload })
  | (EventEnvelope & { type: "script_completed"; payload: ScriptCompletedPayload })
  | (EventEnvelope & { type: "check_completed"; payload: CheckCompletedPayload })
  | (EventEnvelope & { type: "signal_received"; payload: SignalReceivedPayload })
  | (EventEnvelope & { type: "router_decided"; payload: RouterDecidedPayload })
  | (EventEnvelope & { type: "job_retrying"; payload: JobRetryingPayload })
  | (EventEnvelope & { type: "job_completed"; payload: JobCompletedPayload })
  | (EventEnvelope & { type: "run_blocked"; payload: RunBlockedPayload })
  | (EventEnvelope & { type: "run_failed"; payload: RunFailedPayload })
  | (EventEnvelope & { type: "run_completed"; payload: RunCompletedPayload })
  | (EventEnvelope & { type: "run_cancelled"; payload: RunCancelledPayload })
  | (EventEnvelope & { type: "job_activated"; payload: JobActivatedPayload })
  | (EventEnvelope & { type: "job_skipped"; payload: JobSkippedPayload })
  | (EventEnvelope & { type: "job_blocked"; payload: JobBlockedPayload })
  | (EventEnvelope & { type: "job_failed"; payload: JobFailedPayload })
  | (EventEnvelope & { type: "step_returned"; payload: StepReturnedPayload })
  | (EventEnvelope & { type: "variable_set"; payload: VariableSetPayload })
  | (EventEnvelope & { type: "variable_deleted"; payload: VariableDeletedPayload })
  | (EventEnvelope & { type: "context_block_updated"; payload: ContextBlockUpdatedPayload })
  | (EventEnvelope & { type: "context_block_deleted"; payload: ContextBlockDeletedPayload })
  | (EventEnvelope & { type: "step_skipped"; payload: StepSkippedPayload })
  | (EventEnvelope & { type: "step_revisited"; payload: StepRevisitedPayload })
  | (EventEnvelope & { type: "step_visit_exceeded"; payload: StepVisitExceededPayload })
  | (EventEnvelope & { type: "human_gate_waiting"; payload: HumanGateWaitingPayload })
  | (EventEnvelope & { type: "human_decision"; payload: HumanDecisionPayload })
  | (EventEnvelope & { type: "traverse_started"; payload: TraverseStartedPayload })
  | (EventEnvelope & { type: "traverse_item_started"; payload: TraverseItemStartedPayload })
  | (EventEnvelope & { type: "traverse_item_completed"; payload: TraverseItemCompletedPayload })
  | (EventEnvelope & { type: "traverse_item_failed"; payload: TraverseItemFailedPayload })
  | (EventEnvelope & { type: "traverse_completed"; payload: TraverseCompletedPayload })
  | (EventEnvelope & { type: "execution_paused"; payload: ExecutionPausedPayload })
  | (EventEnvelope & { type: "execution_stopped"; payload: ExecutionStoppedPayload })
  | (EventEnvelope & { type: "job_state_override"; payload: JobStateOverridePayload })
  | (EventEnvelope & { type: "job_reset"; payload: JobResetPayload })
  // WF-7.1: Attempt model event types
  | (EventEnvelope & { type: "attempt_started"; payload: AttemptStartedPayload })
  | (EventEnvelope & { type: "attempt_completed"; payload: AttemptCompletedPayload })
  | (EventEnvelope & { type: "attempt_failed"; payload: AttemptFailedPayload });

// ---------------------------------------------------------------------------
// nextEventId — sequential event id formatter
// ---------------------------------------------------------------------------

/**
 * Formats a sequential event counter as an event id string.
 * nextEventId(1) → "evt-001", nextEventId(42) → "evt-042", nextEventId(1000) → "evt-1000".
 */
export function nextEventId(counter: number): string {
  return `evt-${String(counter).padStart(3, "0")}`;
}
