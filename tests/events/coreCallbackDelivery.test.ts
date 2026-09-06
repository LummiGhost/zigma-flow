import { describe, expect, it, vi } from "vitest";

import {
  coreCallbackEndpoint,
  deliverCoreCallback,
} from "../../src/events/coreCallbackDelivery.js";
import type { FlowCoreCallbackEnvelopeV1 } from "../../src/events/platformEvent.js";

const ENVELOPE: FlowCoreCallbackEnvelopeV1 = {
  contractVersion: 1,
  producer: "zigma-flow",
  callbackVersion: 1,
  eventId: "runtime-1::evt-001",
  runId: "runtime-1",
  flowRunId: "flow-run/1",
  externalRunId: "runtime-1",
  operationId: "operation-1",
  callbackCorrelationId: "callback-1",
  sequence: 1,
  type: "run.started",
  occurredAt: "2026-09-06T00:00:00.000Z",
  payload: {},
};

describe("Core callback delivery", () => {
  it("builds the versioned Flow-run event endpoint without retaining query or credentials", () => {
    expect(coreCallbackEndpoint("http://127.0.0.1:4736/v1/?ignored=true", "flow-run/1"))
      .toBe("http://127.0.0.1:4736/v1/flow-runs/flow-run%2F1/events");
    expect(() => coreCallbackEndpoint("file:///tmp/core", "run-1")).toThrow("http or https");
    expect(() => coreCallbackEndpoint("https://user:secret@example.test/v1", "run-1")).toThrow("credentials");
  });

  it("retries the byte-equivalent envelope and eventually accepts a successful response", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("retry", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await deliverCoreCallback("http://127.0.0.1:4736/v1", ENVELOPE, {
      fetcher,
      retryDelayMs: 0,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  });

  it("fails after the bounded attempt count", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    await expect(deliverCoreCallback("http://127.0.0.1:4736/v1", ENVELOPE, {
      fetcher,
      attempts: 2,
      retryDelayMs: 0,
    })).rejects.toThrow("failed after 2 attempt");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
