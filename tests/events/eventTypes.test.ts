/**
 * Event type catalog tests for WF-P4-EVENT (Step 1 — Cases and Tests).
 *
 * Covers:
 *   - The 21-element `ZigmaFlowEventType` catalog (closed string union + runtime tuple).
 *   - `EventEnvelope` common fields (id, run_id, type, timestamp, producer, job, step, attempt).
 *   - `ZigmaFlowEvent` discriminated union — type narrowing + exhaustiveness.
 *   - JSON round-trip of each of the 21 event types (structural equality after serialize/parse).
 *   - `nextEventId(counter)` formatter behavior (first id, sequential ids, width growth).
 *
 * Reference:
 *   - docs/phases/p4-event-artifact/workflows/wf-p4-event/01-cases-and-tests.md
 *   - docs/mvp-contracts.md §2.4
 *   - docs/architecture.md §18 fitness function ("events must save structured fields")
 *
 * Red-phase note: `src/events/index.ts` currently re-exports `{}`. These tests
 * intentionally fail to compile until Step 2 implements the typed catalog,
 * envelope, discriminated union, runtime EVENT_TYPES tuple, and `nextEventId`.
 */

import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  nextEventId,
} from "../../src/events/index.js";
import type {
  AgentCancelledPayload,
  AgentCompletedPayload,
  AgentFailedPayload,
  AgentInvokedPayload,
  AgentReportAcceptedPayload,
  AgentTimedOutPayload,
  CheckCompletedPayload,
  EventEnvelope,
  JobActivatedPayload,
  JobBlockedPayload,
  JobCompletedPayload,
  JobFailedPayload,
  JobReadyPayload,
  JobResetPayload,
  JobRetryingPayload,
  JobSkippedPayload,
  PromptGeneratedPayload,
  RouterDecidedPayload,
  RunBlockedPayload,
  RunCancelledPayload,
  RunCompletedPayload,
  RunCreatedPayload,
  RunFailedPayload,
  ScriptCompletedPayload,
  SignalReceivedPayload,
  StepCompletedPayload,
  StepFailedPayload,
  StepStartedPayload,
  ZigmaFlowEvent,
  ZigmaFlowEventType,
} from "../../src/events/index.js";

// ---------------------------------------------------------------------------
// Fixed envelope helpers — keep tests deterministic and dense.
// ---------------------------------------------------------------------------

const FIXED_TS = "2026-06-08T12:34:56.000Z";
const RUN_ID = "20260608-0001";

/** Envelope fields shared by step-scoped events. */
function stepEnvelope(
  id: string,
  type: ZigmaFlowEventType,
  producer: string,
  job: string,
  step: string,
  attempt: number
): EventEnvelope {
  return {
    id,
    run_id: RUN_ID,
    type,
    timestamp: FIXED_TS,
    producer,
    job,
    step,
    attempt,
  };
}

/** Envelope fields shared by run-scoped events (no job/step/attempt). */
function runEnvelope(id: string, type: ZigmaFlowEventType): EventEnvelope {
  return {
    id,
    run_id: RUN_ID,
    type,
    timestamp: FIXED_TS,
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
  };
}

// ---------------------------------------------------------------------------
// T-EVT-CATALOG-1 — runtime catalog completeness
// ---------------------------------------------------------------------------

describe("ZigmaFlowEventType", () => {
  it("enumerates all 55 event types (T-EVT-CATALOG-1, UC-EVT-CATALOG, RC-E03, RC-E10)", () => {
    const expected: ZigmaFlowEventType[] = [
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
      // WF-7.2: Job Group Iteration event types
      "iteration_started",
      "iteration_completed",
      "iteration_condition_met",
      "iteration_max_reached",
      "group_completed",
      "group_blocked",
      "group_failed",
    ];

    // Set equality both ways — guards against missing or extra types.
    expect(new Set(EVENT_TYPES)).toEqual(new Set(expected));
    expect(EVENT_TYPES.length).toBe(55);
    expect(expected.length).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// T-EVT-ENVELOPE-1 — envelope fields are mandatory
// T-EVT-RUN-SCOPED-1 — null job/step/attempt for run-scoped events
// ---------------------------------------------------------------------------

describe("EventEnvelope", () => {
  it("requires id, run_id, type, timestamp, producer, job, step, attempt fields (T-EVT-ENVELOPE-1, UC-EVT-ENVELOPE, RC-E01..E08)", () => {
    const env: EventEnvelope = stepEnvelope(
      "evt-001",
      "step_started",
      "engine",
      "intake",
      "kickoff",
      1
    );

    // All eight envelope keys are present.
    expect(env.id).toBe("evt-001");
    expect(env.run_id).toBe(RUN_ID);
    expect(env.type).toBe("step_started");
    expect(env.timestamp).toBe(FIXED_TS);
    expect(env.producer).toBe("engine");
    expect(env.job).toBe("intake");
    expect(env.step).toBe("kickoff");
    expect(env.attempt).toBe(1);

    const keys = Object.keys(env).sort();
    expect(keys).toEqual(
      [
        "id",
        "run_id",
        "type",
        "timestamp",
        "producer",
        "job",
        "step",
        "attempt",
      ].sort()
    );
  });

  it("accepts null job/step/attempt for run-scoped events (T-EVT-RUN-SCOPED-1, UC-EVT-RUN-SCOPED, RC-E06..E08)", () => {
    const env: EventEnvelope = runEnvelope("evt-001", "run_created");
    expect(env.job).toBeNull();
    expect(env.step).toBeNull();
    expect(env.attempt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-EVT-NARROW-1 / T-EVT-NARROW-2 — discriminated union narrowing + exhaustiveness
// ---------------------------------------------------------------------------

describe("ZigmaFlowEvent", () => {
  it("narrows payload via switch on type (T-EVT-NARROW-1, UC-EVT-NARROW, RC-E03, RC-E09, RC-E15)", () => {
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-001", "run_created"),
      type: "run_created",
      payload: { workflow: "code-change", task: "fix login bug" },
    };

    // Inside the case branch, ev.payload narrows to RunCreatedPayload —
    // accessing typed fields without a cast must compile.
    let observed = "";
    switch (ev.type) {
      case "run_created": {
        const p: RunCreatedPayload = ev.payload;
        observed = `${p.workflow}|${p.task}`;
        break;
      }
      default:
        // For this single-case smoke test we do not exhaust here.
        observed = "fallthrough";
    }

    expect(observed).toBe("code-change|fix login bug");
  });

  it("exhaustiveness check assigns event to never in default branch (T-EVT-NARROW-2, UC-EVT-EXHAUSTIVE, RC-E15)", () => {
    // A pure type-level helper. If the union is ever widened without updating
    // this switch, the assignment to `_exhaustive` fails to compile.
    function classify(event: ZigmaFlowEvent): string {
      switch (event.type) {
        case "run_created":
          return "run_created";
        case "job_ready":
          return "job_ready";
        case "step_started":
          return "step_started";
        case "step_completed":
          return "step_completed";
        case "step_failed":
          return "step_failed";
        case "prompt_generated":
          return "prompt_generated";
        case "agent_report_accepted":
          return "agent_report_accepted";
        case "agent_invoked":
          return "agent_invoked";
        case "agent_completed":
          return "agent_completed";
        case "agent_timed_out":
          return "agent_timed_out";
        case "agent_failed":
          return "agent_failed";
        case "agent_cancelled":
          return "agent_cancelled";
        case "script_completed":
          return "script_completed";
        case "check_completed":
          return "check_completed";
        case "signal_received":
          return "signal_received";
        case "router_decided":
          return "router_decided";
        case "job_retrying":
          return "job_retrying";
        case "job_completed":
          return "job_completed";
        case "run_blocked":
          return "run_blocked";
        case "run_failed":
          return "run_failed";
        case "run_completed":
          return "run_completed";
        case "run_cancelled":
          return "run_cancelled";
        case "job_activated":
          return "job_activated";
        case "job_skipped":
          return "job_skipped";
        case "job_blocked":
          return "job_blocked";
        case "job_failed":
          return "job_failed";
        case "step_returned":
          return "step_returned";
        case "variable_set":
          return "variable_set";
        case "variable_deleted":
          return "variable_deleted";
        case "context_block_updated":
          return "context_block_updated";
        case "context_block_deleted":
          return "context_block_deleted";
        case "step_skipped":
          return "step_skipped";
        case "step_revisited":
          return "step_revisited";
        case "step_visit_exceeded":
          return "step_visit_exceeded";
        case "human_gate_waiting":
          return "human_gate_waiting";
        case "human_decision":
          return "human_decision";
        case "traverse_started":
          return "traverse_started";
        case "traverse_item_started":
          return "traverse_item_started";
        case "traverse_item_completed":
          return "traverse_item_completed";
        case "traverse_item_failed":
          return "traverse_item_failed";
        case "traverse_completed":
          return "traverse_completed";
        case "execution_paused":
          return "execution_paused";
        case "execution_stopped":
          return "execution_stopped";
        case "job_state_override":
          return "job_state_override";
        case "job_reset":
          return "job_reset";
        // WF-7.1: Attempt model event types
        case "attempt_started":
          return "attempt_started";
        case "attempt_completed":
          return "attempt_completed";
        case "attempt_failed":
          return "attempt_failed";
        case "iteration_started":
          return "iteration_started";
        case "iteration_completed":
          return "iteration_completed";
        case "iteration_condition_met":
          return "iteration_condition_met";
        case "iteration_max_reached":
          return "iteration_max_reached";
        case "group_completed":
          return "group_completed";
        case "group_blocked":
          return "group_blocked";
        case "group_failed":
          return "group_failed";
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    }

    // Runtime smoke: feed one event and confirm the classifier returns the type tag.
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-001", "run_completed"),
      type: "run_completed",
      payload: {},
    };
    expect(classify(ev)).toBe("run_completed");
  });
});

// ---------------------------------------------------------------------------
// T-EVT-RT-1..17 — JSON round-trip per event type
// ---------------------------------------------------------------------------

function roundTrip(ev: ZigmaFlowEvent): ZigmaFlowEvent {
  const json = JSON.stringify(ev);
  return JSON.parse(json) as ZigmaFlowEvent;
}

describe("ZigmaFlowEvent JSON round-trip", () => {
  it("round-trips run_created (T-EVT-RT-1, UC-EVT-ROUND-TRIP-RUN-CREATED, RC-E09..E11, RC-E14)", () => {
    const payload: RunCreatedPayload = { workflow: "code-change", task: "fix login bug" };
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-001", "run_created"),
      type: "run_created",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("run_created");
  });

  it("round-trips job_ready (T-EVT-RT-2, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: JobReadyPayload = { job_id: "intake" };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-002", "job_ready", "engine", "intake", "", 0),
      type: "job_ready",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("job_ready");
  });

  it("round-trips step_started (T-EVT-RT-3, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: StepStartedPayload = { job_id: "intake", step_id: "kickoff", attempt: 1 };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-003", "step_started", "engine", "intake", "kickoff", 1),
      type: "step_started",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("step_started");
  });

  it("round-trips step_completed (T-EVT-RT-4, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: StepCompletedPayload = {
      job_id: "intake",
      step_id: "kickoff",
      attempt: 1,
      outputs: { task_summary: "ok" },
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-004", "step_completed", "engine", "intake", "kickoff", 1),
      type: "step_completed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("step_completed");
  });

  it("round-trips step_failed (T-EVT-RT-5, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: StepFailedPayload = {
      job_id: "intake",
      step_id: "kickoff",
      attempt: 1,
      reason: "agent report missing required outputs",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-005", "step_failed", "engine", "intake", "kickoff", 1),
      type: "step_failed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("step_failed");
  });

  it("round-trips prompt_generated (T-EVT-RT-6, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: PromptGeneratedPayload = {
      job_id: "intake",
      step_id: "kickoff",
      prompt_artifact: "artifact://intake/1/kickoff/prompt.txt",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-006", "prompt_generated", "prompt", "intake", "kickoff", 1),
      type: "prompt_generated",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("prompt_generated");
  });

  it("round-trips agent_report_accepted (T-EVT-RT-7, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: AgentReportAcceptedPayload = {
      job_id: "intake",
      step_id: "kickoff",
      report_artifact: "artifact://intake/1/kickoff/report.json",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-007", "agent_report_accepted", "engine", "intake", "kickoff", 1),
      type: "agent_report_accepted",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("agent_report_accepted");
  });

  it("round-trips agent_invoked (T-EVT-RT-22, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: AgentInvokedPayload = {
      backend_name: "claude-code",
      command: "claude",
      args_hash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      timeout_ms: 600_000,
      step_artifact_dir: "jobs/intake/attempts/1/steps/analyze",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-022", "agent_invoked", "engine", "intake", "analyze", 1),
      type: "agent_invoked",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("agent_invoked");
  });

  it("round-trips agent_completed (T-EVT-RT-23, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: AgentCompletedPayload = {
      duration_ms: 1234,
      stdout_artifact: "jobs/intake/attempts/1/steps/analyze/agent.stdout.log",
      stderr_artifact: "jobs/intake/attempts/1/steps/analyze/agent.stderr.log",
      invocation_artifact: "jobs/intake/attempts/1/steps/analyze/agent.invocation.json",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-023", "agent_completed", "engine", "intake", "analyze", 1),
      type: "agent_completed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("agent_completed");
  });

  it("round-trips agent_timed_out (T-EVT-RT-24, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: AgentTimedOutPayload = {
      duration_ms: 600_000,
      timeout_ms: 600_000,
      stdout_artifact: "jobs/intake/attempts/1/steps/analyze/agent.stdout.log",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-024", "agent_timed_out", "engine", "intake", "analyze", 1),
      type: "agent_timed_out",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("agent_timed_out");
  });

  it("round-trips agent_failed (T-EVT-RT-25, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: AgentFailedPayload = {
      duration_ms: 567,
      exit_code: 1,
      reason: "Agent exited with code 1",
      stdout_artifact: "jobs/intake/attempts/1/steps/analyze/agent.stdout.log",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-025", "agent_failed", "engine", "intake", "analyze", 1),
      type: "agent_failed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("agent_failed");
  });

  it("round-trips agent_cancelled (T-EVT-RT-26, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: AgentCancelledPayload = {
      duration_ms: 89,
      reason: "User aborted the run",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-026", "agent_cancelled", "engine", "intake", "analyze", 1),
      type: "agent_cancelled",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("agent_cancelled");
  });

  it("round-trips script_completed (T-EVT-RT-8, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: ScriptCompletedPayload = {
      job_id: "build",
      step_id: "tsc",
      exit_code: 0,
      timed_out: false,
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-008", "script_completed", "script", "build", "tsc", 1),
      type: "script_completed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("script_completed");
  });

  it("round-trips check_completed (T-EVT-RT-9, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: CheckCompletedPayload = {
      job_id: "verify",
      step_id: "forbidden-paths",
      check_id: "code.checks.forbidden-paths",
      passed: true,
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-009", "check_completed", "check", "verify", "forbidden-paths", 1),
      type: "check_completed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("check_completed");
  });

  it("round-trips signal_received (T-EVT-RT-10, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: SignalReceivedPayload = {
      signal: "code-map-ready",
      from_job: "code-map",
      from_step: "emit",
    };
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-010", "signal_received"),
      type: "signal_received",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("signal_received");
  });

  it("round-trips router_decided (T-EVT-RT-11, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: RouterDecidedPayload = {
      job_id: "review",
      step_id: "route",
      action: "goto_job",
      target: "fix",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-011", "router_decided", "router", "review", "route", 1),
      type: "router_decided",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("router_decided");
  });

  it("round-trips job_retrying (T-EVT-RT-12, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: JobRetryingPayload = {
      job_id: "build",
      attempt: 2,
      reason: "flaky network during npm install",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-012", "job_retrying", "engine", "build", "", 2),
      type: "job_retrying",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("job_retrying");
  });

  it("round-trips job_completed (T-EVT-RT-13, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: JobCompletedPayload = { job_id: "intake", attempt: 1 };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-013", "job_completed", "engine", "intake", "", 1),
      type: "job_completed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("job_completed");
  });

  it("round-trips run_blocked (T-EVT-RT-14, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: RunBlockedPayload = {
      job_id: "review",
      step_id: "gate",
      reason: "human approval required",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-014", "run_blocked", "engine", "review", "gate", 1),
      type: "run_blocked",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("run_blocked");
  });

  it("round-trips run_failed (T-EVT-RT-15, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: RunFailedPayload = { reason: "build job exhausted retries" };
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-015", "run_failed"),
      type: "run_failed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("run_failed");
  });

  it("round-trips run_completed (T-EVT-RT-16, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: RunCompletedPayload = {};
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-016", "run_completed"),
      type: "run_completed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("run_completed");
  });

  it("round-trips run_cancelled (T-EVT-RT-17, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: RunCancelledPayload = { reason: "user pressed Ctrl-C" };
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-017", "run_cancelled"),
      type: "run_cancelled",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("run_cancelled");
  });

  it("round-trips job_activated (T-EVT-RT-18, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: JobActivatedPayload = {
      job_id: "architecture-design",
      reason: "router decided: activate_job",
    };
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-018", "job_activated"),
      type: "job_activated",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("job_activated");
  });

  it("round-trips job_skipped (T-EVT-RT-19, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: JobSkippedPayload = {
      job_id: "review",
      target: "cleanup",
      reason: "router decided: goto_job",
    };
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-019", "job_skipped"),
      type: "job_skipped",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("job_skipped");
  });

  it("round-trips job_blocked (T-EVT-RT-20, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: JobBlockedPayload = {
      job_id: "implement",
      reason: "retry exhausted: max_attempts reached",
    };
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-020", "job_blocked"),
      type: "job_blocked",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("job_blocked");
  });

  it("round-trips job_failed (T-EVT-RT-21, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: JobFailedPayload = {
      job_id: "implement",
      reason: "retry exhausted: on_exceeded.status = failed",
    };
    const ev: ZigmaFlowEvent = {
      ...runEnvelope("evt-021", "job_failed"),
      type: "job_failed",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("job_failed");
  });

  it("round-trips job_reset (T-EVT-RT-44, UC-EVT-ROUND-TRIP, RC-E09..E11, RC-E14)", () => {
    const payload: JobResetPayload = {
      job_id: "implement",
      from_status: "failed",
      to_status: "waiting",
      reason: "reset-run command",
    };
    const ev: ZigmaFlowEvent = {
      ...stepEnvelope("evt-044", "job_reset", "engine", "implement", "", 1),
      type: "job_reset",
      payload,
    };
    const back = roundTrip(ev);
    expect(back).toEqual(ev);
    expect(back.type).toBe("job_reset");
  });
});

// ---------------------------------------------------------------------------
// T-EVT-NEXT-ID-1..3 — counter formatter
// ---------------------------------------------------------------------------

describe("nextEventId", () => {
  it("formats 1 as evt-001 (T-EVT-NEXT-ID-1, UC-EVT-NEXT-ID-FIRST)", () => {
    expect(nextEventId(1)).toBe("evt-001");
  });

  it("is sequential when called with 1, 2, 3 (T-EVT-NEXT-ID-2, UC-EVT-NEXT-ID-SEQUENCE)", () => {
    expect([nextEventId(1), nextEventId(2), nextEventId(3)]).toEqual([
      "evt-001",
      "evt-002",
      "evt-003",
    ]);
  });

  it("pads to at least 3 digits but does not cap at 999 (T-EVT-NEXT-ID-3, UC-EVT-NEXT-ID-WIDTH)", () => {
    expect(nextEventId(42)).toBe("evt-042");
    expect(nextEventId(999)).toBe("evt-999");
    expect(nextEventId(1000)).toBe("evt-1000");
  });
});
