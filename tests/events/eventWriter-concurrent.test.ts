/**
 * EventWriter concurrent append tests — WF-P14-LOCKS Step 1 (Cases and Tests).
 *
 * Verifies that JsonlEventWriter.appendEvent, when wrapped with the per-runDir
 * AsyncQueue (Step 2), serializes appends such that:
 *   - All events are in the file (no loss).
 *   - Events appear in call order (FIFO).
 *   - No interleaved or corrupted lines.
 *
 * Reference:
 *   - docs/phases/p14-concurrent-execution/02-development-plan.md AD-P14-003
 *   - docs/phases/p14-concurrent-execution/workflows/wf-p14-locks/01-cases-and-tests.md
 *
 * Red-phase note:
 *   - These tests are **reliably RED** without AsyncQueue because Node.js
 *     `appendFile` is NOT safe for concurrent writes to the same file.
 *     Concurrent appends can produce interleaved/corrupted lines and lost
 *     data. After Step 2 wraps appendEvent with queue.run(), the writes
 *     become serialized and deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { JsonlEventWriter } from "../../src/events/index.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-08T00:00:00.000Z";
const RUN_ID = "20260608-0001";

/**
 * Build a minimal ZigmaFlowEvent fixture. Uses a "step_completed" event shape
 * which is simple and self-contained.
 */
function makeEvent(overrides: Partial<ZigmaFlowEvent> = {}): ZigmaFlowEvent {
  return {
    id: "evt-000",
    run_id: RUN_ID,
    type: "step_completed",
    timestamp: FIXED_ISO,
    producer: "test",
    job: "intake",
    step: "plan",
    attempt: 1,
    payload: { job_id: "intake", step_id: "plan", attempt: 1 },
    ...overrides,
  } as ZigmaFlowEvent;
}

// ---------------------------------------------------------------------------
// UC-EVENT-CONCURRENT — concurrent append serialization
// ---------------------------------------------------------------------------

describe("JsonlEventWriter concurrent appendEvent (UC-EVENT-CONCURRENT)", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-event-concurrent-${randomUUID()}`);
    runDir = join(tmpDir, RUN_ID);
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("all events are in the file — no loss with 100 concurrent appends (T-EVENT-CONCURRENT-1)", async () => {
    const writer = new JsonlEventWriter();
    const COUNT = 100;

    const writes = Array.from({ length: COUNT }, (_, i) =>
      writer.appendEvent(
        runDir,
        makeEvent({
          id: `evt-${String(i).padStart(3, "0")}`,
        })
      )
    );

    await Promise.all(writes);

    // Read back and verify
    const eventsPath = join(runDir, "events.jsonl");
    const text = await readFile(eventsPath, "utf-8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);

    // All COUNT events must be present
    expect(lines).toHaveLength(COUNT);

    // All event IDs must be unique
    const ids = lines.map((line) => JSON.parse(line).id);
    expect(new Set(ids).size).toBe(COUNT);
  });

  it("events are appended in call order — line order is strictly increasing (T-EVENT-CONCURRENT-2)", async () => {
    const writer = new JsonlEventWriter();
    const COUNT = 50;

    const writes = Array.from({ length: COUNT }, (_, i) =>
      writer.appendEvent(
        runDir,
        makeEvent({ id: `evt-${String(i).padStart(3, "0")}` })
      )
    );

    await Promise.all(writes);

    const eventsPath = join(runDir, "events.jsonl");
    const text = await readFile(eventsPath, "utf-8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);

    expect(lines).toHaveLength(COUNT);

    // With AsyncQueue serialization, line order matches call order.
    // Since calls were submitted in array index order via Promise.all,
    // line[i] must have id `evt-{i}`.
    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]!) as { id: string };
      expect(parsed.id).toBe(`evt-${String(i).padStart(3, "0")}`);
    }
  });

  it("no interleaved or corrupted lines — every line is valid event JSON (T-EVENT-CONCURRENT-3)", async () => {
    const writer = new JsonlEventWriter();
    const COUNT = 100;

    const writes = Array.from({ length: COUNT }, (_, i) =>
      writer.appendEvent(
        runDir,
        makeEvent({ id: `evt-${String(i).padStart(3, "0")}` })
      )
    );

    await Promise.all(writes);

    const eventsPath = join(runDir, "events.jsonl");
    const text = await readFile(eventsPath, "utf-8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);

    expect(lines).toHaveLength(COUNT);

    // Every line must be parseable JSON with required event envelope fields
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      expect(() => {
        parsed = JSON.parse(line);
      }).not.toThrow();

      expect(parsed!).toHaveProperty("id");
      expect(parsed!).toHaveProperty("type");
      expect(parsed!).toHaveProperty("timestamp");
      expect(parsed!).toHaveProperty("run_id");
      expect(parsed!).toHaveProperty("payload");

      // id must be a string and non-empty
      expect(typeof parsed!.id).toBe("string");
      expect((parsed!.id as string).length).toBeGreaterThan(0);
    }
  });
});
