/**
 * FlowPlatformEvent — the simplified, machine-readable event shape for the
 * --event-file NDJSON sink. Every internal ZigmaFlowEvent is mapped to one
 * of the six platform event types.
 *
 * The eventId is derived as "<runId>::<internalEventId>" for stable dedup
 * across retries. Delivery is at-least-once; consumers deduplicate by eventId.
 *
 * Reference: ISSUE #254 — platform integration contract.
 */

import type { ZigmaFlowEvent } from "./eventTypes.js";

// ---------------------------------------------------------------------------
// FlowPlatformEvent
// ---------------------------------------------------------------------------

export type FlowPlatformEventType =
  | "run.started"
  | "run.progress"
  | "run.awaiting-human"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export interface FlowPlatformEvent {
  eventId: string;
  runId: string;
  type: FlowPlatformEventType;
  occurredAt: string;
  status?: string;
  summary?: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

/** Map an internal event type to the closest platform event type. */
const EVENT_TYPE_MAP: Record<string, FlowPlatformEventType> = {
  run_created: "run.started",
  job_ready: "run.progress",
  step_started: "run.progress",
  step_completed: "run.progress",
  step_failed: "run.progress",
  prompt_generated: "run.progress",
  agent_report_accepted: "run.progress",
  agent_invoked: "run.progress",
  agent_completed: "run.progress",
  agent_timed_out: "run.progress",
  agent_failed: "run.progress",
  agent_cancelled: "run.progress",
  script_completed: "run.progress",
  check_completed: "run.progress",
  signal_received: "run.progress",
  router_decided: "run.progress",
  job_retrying: "run.progress",
  job_completed: "run.progress",
  job_activated: "run.progress",
  job_skipped: "run.progress",
  step_returned: "run.progress",
  variable_set: "run.progress",
  variable_deleted: "run.progress",
  context_block_updated: "run.progress",
  context_block_deleted: "run.progress",
  step_skipped: "run.progress",
  step_revisited: "run.progress",
  step_visit_exceeded: "run.progress",
  job_state_override: "run.progress",
  job_reset: "run.progress",
  attempt_started: "run.progress",
  attempt_completed: "run.progress",
  attempt_failed: "run.progress",
  iteration_started: "run.progress",
  iteration_completed: "run.progress",
  iteration_condition_met: "run.progress",
  iteration_max_reached: "run.progress",
  group_completed: "run.progress",
  group_blocked: "run.progress",
  group_failed: "run.progress",
  traverse_started: "run.progress",
  traverse_item_started: "run.progress",
  traverse_item_completed: "run.progress",
  traverse_item_failed: "run.progress",
  traverse_completed: "run.progress",
  execution_paused: "run.progress",
  execution_stopped: "run.progress",
  run_blocked: "run.failed",
  run_failed: "run.failed",
  run_completed: "run.completed",
  run_cancelled: "run.cancelled",
  human_gate_waiting: "run.awaiting-human",
  human_decision: "run.progress",
  job_blocked: "run.progress",
  job_failed: "run.progress",
};

/**
 * Derive a stable, dedup-able platform event ID from the run ID and the
 * internal sequential event ID (e.g. "evt-042").
 */
export function derivePlatformEventId(runId: string, internalEventId: string): string {
  return `${runId}::${internalEventId}`;
}

/**
 * Human-readable one-line summaries per internal event type.
 */
function summarize(event: ZigmaFlowEvent): string {
  // Payload is a discriminated union — access via index signature for generality.
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "run_created":
      return `Run created for workflow "${p["workflow"] ?? "unknown"}"`;
    case "run_completed":
      return "Run completed";
    case "run_failed":
      return `Run failed: ${p["reason"] ?? "unknown"}`;
    case "run_cancelled":
      return `Run cancelled: ${p["reason"] ?? "unknown"}`;
    case "run_blocked":
      return `Run blocked: ${p["reason"] ?? "unknown"}`;
    case "human_gate_waiting":
      return `Awaiting human input on ${event.job}/${event.step}`;
    case "human_decision":
      return `Human decision: ${p["decision"] ?? "?"} on ${event.job}/${event.step}`;
    case "job_completed":
      return `Job ${event.job} completed`;
    case "job_failed":
      return `Job ${event.job} failed: ${p["reason"] ?? "unknown"}`;
    case "job_blocked":
      return `Job ${event.job} blocked: ${p["reason"] ?? "unknown"}`;
    case "job_ready":
      return `Job ${event.job} ready`;
    case "job_activated":
      return `Job ${event.job} activated: ${p["reason"] ?? "unknown"}`;
    case "agent_completed":
      return `Agent step ${event.job}/${event.step} completed`;
    case "agent_failed":
      return `Agent step ${event.job}/${event.step} failed: ${p["reason"] ?? "unknown"}`;
    case "agent_timed_out":
      return `Agent step ${event.job}/${event.step} timed out`;
    case "agent_cancelled":
      return `Agent step ${event.job}/${event.step} cancelled`;
    case "step_completed":
      return `Step ${event.job}/${event.step} completed`;
    case "step_failed":
      return `Step ${event.job}/${event.step} failed: ${p["reason"] ?? "unknown"}`;
    default:
      return event.type;
  }
}

/**
 * Map an internal ZigmaFlowEvent to the platform-visible FlowPlatformEvent.
 *
 * @param event — the internal event emitted by the engine.
 * @param runStatus — current run status at the time the event is being forwarded.
 */
export function mapZigmaFlowEventToPlatformEvent(
  event: ZigmaFlowEvent,
  runStatus?: string,
): FlowPlatformEvent {
  const platformType = EVENT_TYPE_MAP[event.type] ?? "run.progress";

  return {
    eventId: derivePlatformEventId(event.run_id, event.id),
    runId: event.run_id,
    type: platformType,
    occurredAt: event.timestamp,
    ...(runStatus !== undefined ? { status: runStatus } : {}),
    summary: summarize(event),
    payload: (event.payload ?? {}) as Record<string, unknown>,
  };
}
