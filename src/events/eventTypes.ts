/**
 * Event type catalog and discriminated union for the Zigma Flow event log.
 *
 * Reference: docs/mvp-contracts.md §2.4
 * WF-P4-EVENT Step 2.
 */

// ---------------------------------------------------------------------------
// ZigmaFlowEventType — the 21 MVP event type tags (closed string union)
// ---------------------------------------------------------------------------

export type ZigmaFlowEventType =
  | "run_created"
  | "job_ready"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "prompt_generated"
  | "agent_report_accepted"
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
  | "job_failed";

/**
 * Runtime tuple of all 21 event type tags.
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
}

export interface JobFailedPayload {
  job_id: string;
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
}

// ---------------------------------------------------------------------------
// ZigmaFlowEvent — discriminated union of all 19 concrete event types
// ---------------------------------------------------------------------------

export type ZigmaFlowEvent =
  | (EventEnvelope & { type: "run_created"; payload: RunCreatedPayload })
  | (EventEnvelope & { type: "job_ready"; payload: JobReadyPayload })
  | (EventEnvelope & { type: "step_started"; payload: StepStartedPayload })
  | (EventEnvelope & { type: "step_completed"; payload: StepCompletedPayload })
  | (EventEnvelope & { type: "step_failed"; payload: StepFailedPayload })
  | (EventEnvelope & { type: "prompt_generated"; payload: PromptGeneratedPayload })
  | (EventEnvelope & { type: "agent_report_accepted"; payload: AgentReportAcceptedPayload })
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
  | (EventEnvelope & { type: "job_failed"; payload: JobFailedPayload });

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
