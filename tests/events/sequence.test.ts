/**
 * `nextSequentialEventId` tests for WF-P13-ENGINE-RUNALL (Step 1 — Cases and Tests).
 *
 * Exercises the new event ID sequencing utility that reads the last event from
 * `events.jsonl`, parses the numeric suffix, increments, and formats the next
 * event ID. Replaces all scattered `parseInt(lastId.replace("evt-",""), 10)`
 * calls throughout the codebase.
 *
 * Covers:
 *   - T-SEQ-1: Empty events.jsonl (missing file) returns "evt-001".
 *   - T-SEQ-2: events.jsonl ending at evt-005 returns "evt-006".
 *   - T-SEQ-3: Roundtrip — write event, then nextSequentialEventId returns
 *              correct next (evt-001 → evt-002).
 *   - T-SEQ-4: Malformed last line throws a descriptive error.
 *   - T-SEQ-5: events.jsonl with only whitespace/empty lines returns
 *              "evt-001".
 *   - T-SEQ-6: Width expansion — evt-999 → evt-1000.
 *   - T-SEQ-7: Accepts optional eventWriter parameter for reading.
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-engine-runall/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5
 *   - AD-P13-007 (event ID sequence port)
 *   - docs/mvp-contracts.md §2.4
 *
 * Red-phase note: `src/events/sequence.ts` does not yet exist. The lazy
 * import wrapper below catches the dynamic-import failure and re-throws
 * a descriptive Error so the test file compiles and every test in this
 * file fails for the same diagnostic reason until WF-P13-ENGINE-RUNALL
 * Step 2 ships the module.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { JsonlEventWriter } from "../../src/events/index.js";
import type { EventWriter, ZigmaFlowEvent } from "../../src/events/index.js";

// ---------------------------------------------------------------------------
// Lazy import — red-phase wrapper
// ---------------------------------------------------------------------------

const SEQUENCE_SPECIFIER = "../../src/events/sequence.js";

async function callNextSequentialEventId(
  runDir: string,
  eventWriter?: EventWriter,
): Promise<string> {
  let mod: {
    nextSequentialEventId?: (
      runDir: string,
      eventWriter?: EventWriter,
    ) => Promise<string>;
  };
  try {
    mod = (await import(/* @vite-ignore */ String(SEQUENCE_SPECIFIER))) as {
      nextSequentialEventId?: (
        runDir: string,
        eventWriter?: EventWriter,
      ) => Promise<string>;
    };
  } catch (e: unknown) {
    throw new Error(
      `nextSequentialEventId is not yet implemented — src/events/sequence.ts does not exist (WF-P13-ENGINE-RUNALL Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.nextSequentialEventId !== "function") {
    throw new Error(
      "nextSequentialEventId is not exported from src/events/sequence.ts — WF-P13-ENGINE-RUNALL Step 2 has not yet shipped the implementation."
    );
  }
  return mod.nextSequentialEventId(runDir, eventWriter);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  runDir: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const runDir = join(tmpdir(), `zigma-sequence-${randomUUID()}`);
  await mkdir(runDir, { recursive: true });
  return { runDir };
}

/**
 * Write a sequence of event IDs to events.jsonl (one per line as JSON).
 * Each line is a minimal valid event shape containing only the id field
 * (the tail-parser only needs the id).
 */
async function writeEventSequence(
  runDir: string,
  ids: string[],
  writer: EventWriter = new JsonlEventWriter(),
): Promise<void> {
  for (const id of ids) {
    const event: ZigmaFlowEvent = {
      id,
      run_id: "test-run",
      type: "run_created",
      timestamp: "2026-06-27T00:00:00.000Z",
      producer: "test",
      job: null,
      step: null,
      attempt: null,
      payload: { workflow: "test", task: "test" },
    };
    await writer.appendEvent(runDir, event);
  }
}

/**
 * Write a full event and verify the writer produces sequential IDs.
 */
async function writeEvent(
  runDir: string,
  id: string,
  writer: EventWriter = new JsonlEventWriter(),
): Promise<void> {
  const event: ZigmaFlowEvent = {
    id,
    run_id: "test-run",
    type: "run_created",
    timestamp: "2026-06-27T00:00:00.000Z",
    producer: "test",
    job: null,
    step: null,
    attempt: null,
    payload: { workflow: "test", task: "test" },
  };
  await writer.appendEvent(runDir, event);
}

// ---------------------------------------------------------------------------
// T-SEQ-1: Empty events.jsonl returns "evt-001"
// ---------------------------------------------------------------------------

describe("nextSequentialEventId — empty events.jsonl (T-SEQ-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "returns evt-001 when events.jsonl does not exist (T-SEQ-1, UC-SEQ-002, FP-SEQ-ID-FRESH)",
    async () => {
      // events.jsonl does not exist in fresh sandbox
      const nextId = await callNextSequentialEventId(sandbox.runDir);
      expect(nextId).toBe("evt-001");
    }
  );

  it(
    "returns evt-001 when events.jsonl exists but is empty (T-SEQ-1, UC-SEQ-002, FP-SEQ-ID-FRESH)",
    async () => {
      await writeFile(join(sandbox.runDir, "events.jsonl"), "", "utf-8");
      const nextId = await callNextSequentialEventId(sandbox.runDir);
      expect(nextId).toBe("evt-001");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SEQ-2: events.jsonl ending at evt-005 returns "evt-006"
// ---------------------------------------------------------------------------

describe("nextSequentialEventId — reads tail event (T-SEQ-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "returns evt-006 when last event is evt-005 (T-SEQ-2, UC-SEQ-001, FP-SEQ-ID)",
    async () => {
      const writer = new JsonlEventWriter();
      await writeEventSequence(sandbox.runDir, [
        "evt-001",
        "evt-002",
        "evt-003",
        "evt-004",
        "evt-005",
      ], writer);

      const nextId = await callNextSequentialEventId(sandbox.runDir);
      expect(nextId).toBe("evt-006");
    }
  );

  it(
    "returns evt-003 when last event is evt-002 (T-SEQ-2, UC-SEQ-001, FP-SEQ-ID)",
    async () => {
      const writer = new JsonlEventWriter();
      await writeEventSequence(sandbox.runDir, ["evt-001", "evt-002"], writer);

      const nextId = await callNextSequentialEventId(sandbox.runDir);
      expect(nextId).toBe("evt-003");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SEQ-3: Roundtrip — write event then read next ID
// ---------------------------------------------------------------------------

describe("nextSequentialEventId — roundtrip (T-SEQ-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "after writing evt-001, nextSequentialEventId returns evt-002 (T-SEQ-3, UC-SEQ-003, FP-SEQ-ID-ROUNDTRIP)",
    async () => {
      const writer = new JsonlEventWriter();

      // First call: empty file
      const id1 = await callNextSequentialEventId(sandbox.runDir, writer);
      expect(id1).toBe("evt-001");

      // Write event with that ID
      await writeEvent(sandbox.runDir, id1, writer);

      // Second call: should see evt-001 and return evt-002
      const id2 = await callNextSequentialEventId(sandbox.runDir, writer);
      expect(id2).toBe("evt-002");
    }
  );

  it(
    "multiple roundtrips increment correctly (T-SEQ-3, UC-SEQ-003, FP-SEQ-ID-ROUNDTRIP)",
    async () => {
      const writer = new JsonlEventWriter();

      for (let i = 1; i <= 5; i++) {
        const expectedId = `evt-${String(i).padStart(3, "0")}`;
        const nextId = await callNextSequentialEventId(sandbox.runDir, writer);
        expect(nextId).toBe(expectedId);
        await writeEvent(sandbox.runDir, nextId, writer);
      }

      // After writing evt-001 through evt-005, next should be evt-006
      const nextId = await callNextSequentialEventId(sandbox.runDir, writer);
      expect(nextId).toBe("evt-006");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SEQ-4: Malformed last line throws error
// ---------------------------------------------------------------------------

describe("nextSequentialEventId — malformed file (T-SEQ-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "throws when last line is not valid JSON (T-SEQ-4, UC-SEQ-005, FP-SEQ-ID-ERROR)",
    async () => {
      // Write events with a malformed last line
      await writeFile(
        join(sandbox.runDir, "events.jsonl"),
        '{"id":"evt-001","run_id":"test","type":"run_created","timestamp":"2026-06-27T00:00:00.000Z","producer":"test","job":null,"step":null,"attempt":null,"payload":{}}\n{ not valid json }\n',
        "utf-8"
      );

      await expect(
        callNextSequentialEventId(sandbox.runDir)
      ).rejects.toThrow();
    }
  );

  it(
    "throws when last line is valid JSON but missing id field (T-SEQ-4, UC-SEQ-005, FP-SEQ-ID-ERROR)",
    async () => {
      // Write event without id field
      await writeFile(
        join(sandbox.runDir, "events.jsonl"),
        '{"id":"evt-001","run_id":"test","type":"run_created","timestamp":"2026-06-27T00:00:00.000Z","producer":"test","job":null,"step":null,"attempt":null,"payload":{}}\n{"run_id":"test","type":"run_created"}\n',
        "utf-8"
      );

      await expect(
        callNextSequentialEventId(sandbox.runDir)
      ).rejects.toThrow();
    }
  );
});

// ---------------------------------------------------------------------------
// T-SEQ-5: Whitespace-only lines are treated as empty
// ---------------------------------------------------------------------------

describe("nextSequentialEventId — whitespace handling (T-SEQ-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "returns evt-001 when events.jsonl contains only whitespace lines (T-SEQ-5, UC-SEQ-001, FP-SEQ-ID)",
    async () => {
      await writeFile(
        join(sandbox.runDir, "events.jsonl"),
        "   \n  \t  \n\n",
        "utf-8"
      );

      const nextId = await callNextSequentialEventId(sandbox.runDir);
      expect(nextId).toBe("evt-001");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SEQ-6: Width expansion — evt-999 → evt-1000
// ---------------------------------------------------------------------------

describe("nextSequentialEventId — width expansion (T-SEQ-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "returns evt-1000 when last event is evt-999 (T-SEQ-6, UC-SEQ-001, FP-SEQ-ID)",
    async () => {
      const writer = new JsonlEventWriter();
      await writeEventSequence(sandbox.runDir, [
        "evt-001",
        "evt-998",
        "evt-999",
      ], writer);

      const nextId = await callNextSequentialEventId(sandbox.runDir);
      expect(nextId).toBe("evt-1000");
    }
  );

  it(
    "handles large sequence numbers correctly (T-SEQ-6, UC-SEQ-001, FP-SEQ-ID)",
    async () => {
      const writer = new JsonlEventWriter();
      await writeEventSequence(sandbox.runDir, ["evt-099"], writer);

      const nextId = await callNextSequentialEventId(sandbox.runDir);
      expect(nextId).toBe("evt-100");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SEQ-7: Accepts optional eventWriter parameter
// ---------------------------------------------------------------------------

describe("nextSequentialEventId — eventWriter parameter (T-SEQ-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.runDir, { recursive: true, force: true });
  });

  it(
    "uses provided eventWriter instead of default JsonlEventWriter (T-SEQ-7, UC-SEQ-001, FP-SEQ-ID)",
    async () => {
      const writer = new JsonlEventWriter();
      await writeEventSequence(sandbox.runDir, ["evt-001", "evt-002"], writer);

      // Pass the writer explicitly
      const nextId = await callNextSequentialEventId(sandbox.runDir, writer);
      expect(nextId).toBe("evt-003");
    }
  );

  it(
    "works without explicit eventWriter (defaults to JsonlEventWriter) (T-SEQ-7, UC-SEQ-001, FP-SEQ-ID)",
    async () => {
      // Use the default writer to set up state
      const writer = new JsonlEventWriter();
      await writeEventSequence(sandbox.runDir, ["evt-007"], writer);

      // Call without explicit writer — should still read the file
      const nextId = await callNextSequentialEventId(sandbox.runDir);
      expect(nextId).toBe("evt-008");
    }
  );
});
