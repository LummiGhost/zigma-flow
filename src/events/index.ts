/**
 * Events module — public API.
 *
 * Reference: docs/mvp-contracts.md §2.4
 * WF-P4-EVENT Step 2.
 */

export { nextSequentialEventId } from "./sequence.js";

export {
  EVENT_TYPES,
  nextEventId,
  type AgentCancelledPayload,
  type AgentCompletedPayload,
  type AgentFailedPayload,
  type AgentInvokedPayload,
  type AgentReportAcceptedPayload,
  type AgentTimedOutPayload,
  type CheckCompletedPayload,
  type EventEnvelope,
  type JobActivatedPayload,
  type JobBlockedPayload,
  type JobCompletedPayload,
  type JobFailedPayload,
  type JobReadyPayload,
  type JobRetryingPayload,
  type JobSkippedPayload,
  type PromptGeneratedPayload,
  type RouterDecidedPayload,
  type RunBlockedPayload,
  type RunCancelledPayload,
  type RunCompletedPayload,
  type RunCreatedPayload,
  type RunFailedPayload,
  type ScriptCompletedPayload,
  type SignalReceivedPayload,
  type StepCompletedPayload,
  type StepFailedPayload,
  type StepStartedPayload,
  type ZigmaFlowEvent,
  type ZigmaFlowEventType,
} from "./eventTypes.js";

export {
  JsonlEventWriter,
  type EventWriter,
  type WorkflowEvent,
} from "./appendEvent.js";
