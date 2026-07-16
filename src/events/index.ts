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
  type AttemptCompletedPayload,
  type AttemptFailedPayload,
  type AttemptStartedPayload,
  type ContextBlockDeletedPayload,
  type ContextBlockUpdatedPayload,
  type VariableDeletedPayload,
  type VariableSetPayload,
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
  type StepReturnedPayload,
  type StepSkippedPayload,
  type StepRevisitedPayload,
  type StepVisitExceededPayload,
  type StepStartedPayload,
  type HumanGateWaitingPayload,
  type HumanDecisionPayload,
  type TraverseStartedPayload,
  type TraverseItemStartedPayload,
  type TraverseItemCompletedPayload,
  type TraverseItemFailedPayload,
  type TraverseCompletedPayload,
  type ExecutionPausedPayload,
  type ExecutionStoppedPayload,
  type JobStateOverridePayload,
  type JobResetPayload,
  type ZigmaFlowEvent,
  type ZigmaFlowEventType,
} from "./eventTypes.js";

export {
  JsonlEventWriter,
  type EventWriter,
  type WorkflowEvent,
} from "./appendEvent.js";
