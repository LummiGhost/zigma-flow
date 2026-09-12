/**
 * Platform event contract tests (ISSUE #254).
 *
 * Covers:
 *   - derivePlatformEventId produces stable composite IDs
 *   - mapZigmaFlowEventToPlatformEvent maps internal→platform types
 *   - All known internal event types map to one of 6 platform types
 *   - Unknown event types default to run.progress
 *   - Output shape matches FlowPlatformEvent interface
 */

import { describe, expect, it } from "vitest";

import {
  derivePlatformEventId,
  deriveCallbackSequence,
  mapZigmaFlowEventToCoreCallbackEnvelope,
  mapZigmaFlowEventToPlatformEvent,
  type FlowPlatformEvent,
} from "../../src/events/platformEvent.js";
import type { ZigmaFlowEvent } from "../../src/events/eventTypes.js";

// ---------------------------------------------------------------------------
// derivePlatformEventId
// ---------------------------------------------------------------------------

describe("derivePlatformEventId", () => {
  it("produces composite id from runId and internalEventId", () => {
    expect(derivePlatformEventId("20260714-0001", "evt-042")).toBe("20260714-0001::evt-042");
  });

  it("handles event id with leading zeros", () => {
    expect(derivePlatformEventId("run-abc", "evt-001")).toBe("run-abc::evt-001");
  });

  it("is stable across repeated calls", () => {
    const id1 = derivePlatformEventId("r1", "evt-005");
    const id2 = derivePlatformEventId("r1", "evt-005");
    expect(id1).toBe(id2);
  });

  it("prepends a global scope when provided", () => {
    expect(derivePlatformEventId("20260714-0001", "evt-042", "flowrun-abc"))
      .toBe("flowrun-abc::20260714-0001::evt-042");
  });

  it("keeps run-scoped ids distinct across scopes", () => {
    const scoped = derivePlatformEventId("20260714-0001", "evt-042", "flowrun-abc");
    const sameRunOtherScope = derivePlatformEventId("20260714-0001", "evt-042", "flowrun-def");
    expect(scoped).not.toBe(sameRunOtherScope);
  });
});

describe("deriveCallbackSequence", () => {
  it("derives a positive, stable sequence from a persisted engine event id", () => {
    expect(deriveCallbackSequence("evt-042")).toBe(42);
  });

  it("rejects event IDs that cannot provide a stable callback order", () => {
    expect(() => deriveCallbackSequence("legacy-event")).toThrow("stable callback sequence");
  });
});

// ---------------------------------------------------------------------------
// mapZigmaFlowEventToPlatformEvent — type mapping
// ---------------------------------------------------------------------------

function makeEvent(
  id: string,
  type: string,
  runId: string,
  payload?: Record<string, unknown>,
): ZigmaFlowEvent {
  return {
    id,
    run_id: runId,
    type,
    timestamp: "2026-07-14T00:00:00.000Z",
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
    ...(payload !== undefined ? { payload } : {}),
  } as ZigmaFlowEvent;
}

describe("mapZigmaFlowEventToPlatformEvent — type mapping", () => {
  const runId = "20260714-0001";

  it("maps run_created → run.started", () => {
    const result = mapZigmaFlowEventToPlatformEvent(makeEvent("evt-1", "run_created", runId));
    expect(result.type).toBe("run.started");
  });

  it("maps human_gate_waiting → run.awaiting-human", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-2", "human_gate_waiting", runId, { prompt: "approve?" }),
    );
    expect(result.type).toBe("run.awaiting-human");
  });

  it("maps run_completed → run.completed", () => {
    const result = mapZigmaFlowEventToPlatformEvent(makeEvent("evt-3", "run_completed", runId));
    expect(result.type).toBe("run.completed");
  });

  it("maps run_failed → run.failed", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-4", "run_failed", runId, { reason: "test" }),
    );
    expect(result.type).toBe("run.failed");
  });

  it("maps run_blocked → run.failed", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-5", "run_blocked", runId, { reason: "blocked" }),
    );
    expect(result.type).toBe("run.failed");
  });

  it("maps run_cancelled → run.cancelled", () => {
    const result = mapZigmaFlowEventToPlatformEvent(makeEvent("evt-6", "run_cancelled", runId));
    expect(result.type).toBe("run.cancelled");
  });

  it("maps progress events → run.progress", () => {
    const progressEvents = [
      "job_ready", "step_started", "step_completed", "step_failed",
      "agent_completed", "agent_failed", "check_completed", "script_completed",
      "job_completed", "job_retrying", "job_activated", "router_decided",
      "attempt_started", "attempt_completed", "human_decision",
    ];

    for (const eventType of progressEvents) {
      const result = mapZigmaFlowEventToPlatformEvent(makeEvent("evt-x", eventType, runId));
      expect(result.type).toBe("run.progress");
    }
  });

  it("defaults unknown event types to run.progress", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-x", "totally_unknown_event_type", runId),
    );
    expect(result.type).toBe("run.progress");
  });
});

// ---------------------------------------------------------------------------
// mapZigmaFlowEventToPlatformEvent — output shape
// ---------------------------------------------------------------------------

describe("mapZigmaFlowEventToPlatformEvent — output shape", () => {
  const runId = "20260714-0001";

  it("identifies the versioned Flow producer contract", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-1", "run_created", runId),
    );
    expect(result.contractVersion).toBe(1);
    expect(result.producer).toBe("zigma-flow");
  });

  it("produces correct eventId", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-042", "run_created", runId),
    );
    expect(result.eventId).toBe("20260714-0001::evt-042");
  });

  it("includes runId", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-1", "run_created", runId),
    );
    expect(result.runId).toBe(runId);
  });

  it("includes occurredAt from event timestamp", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-1", "run_created", runId),
    );
    expect(result.occurredAt).toBe("2026-07-14T00:00:00.000Z");
  });

  it("includes status when provided", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-1", "run_created", runId),
      "running",
    );
    expect(result.status).toBe("running");
  });

  it("omits status when not provided", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-1", "run_created", runId),
    );
    expect(result.status).toBeUndefined();
  });

  it("includes a human-readable summary", () => {
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-1", "run_created", runId, { workflow: "test-wf" }),
    );
    expect(typeof result.summary).toBe("string");
    expect(result.summary!.length).toBeGreaterThan(0);
  });

  it("includes payload", () => {
    const payload = { workflow: "test-wf", task: "do something" };
    const result = mapZigmaFlowEventToPlatformEvent(
      makeEvent("evt-1", "run_created", runId, payload),
    );
    expect(result.payload).toEqual(payload);
  });

  it("handles null payload gracefully", () => {
    const event = makeEvent("evt-1", "run_created", runId);
    (event as unknown as Record<string, unknown>)["payload"] = null;
    const result = mapZigmaFlowEventToPlatformEvent(event);
    expect(result.payload).toEqual({});
  });
});

describe("mapZigmaFlowEventToCoreCallbackEnvelope", () => {
  const callerContext = {
    contractVersion: 1 as const,
    actor: { type: "service" as const, id: "core" },
    capabilities: ["workflow:invoke"],
    constraints: { repositoryIds: [], workflowRefs: [], toolNames: [], branchPatterns: [] },
    source: { kind: "api" as const, metadata: {} },
    taskId: "task-1",
    flowRunId: "core-flow-run-1",
    projectId: "project-1",
    permissionSnapshotId: "permission-1",
    integrityHash: "sha256:test",
    operationId: "operation-1",
    callbackCorrelationId: "callback-1",
  };

  it("uses only frozen Core identities and the persisted event sequence", () => {
    const event = makeEvent("evt-007", "run_completed", "runtime-run-1");
    expect(mapZigmaFlowEventToCoreCallbackEnvelope(event, callerContext)).toMatchObject({
      callbackVersion: 1,
      eventId: "core-flow-run-1::runtime-run-1::evt-007",
      externalRunId: "runtime-run-1",
      flowRunId: "core-flow-run-1",
      operationId: "operation-1",
      callbackCorrelationId: "callback-1",
      sequence: 7,
    });
  });

  it("fails closed when the frozen context lacks a Core correlation identity", () => {
    const { callbackCorrelationId: _omitted, ...incomplete } = callerContext;
    expect(() => mapZigmaFlowEventToCoreCallbackEnvelope(
      makeEvent("evt-1", "run_created", "runtime-run-1"),
      incomplete as Parameters<typeof mapZigmaFlowEventToCoreCallbackEnvelope>[1],
    )).toThrow("callbackCorrelationId");
  });
});
