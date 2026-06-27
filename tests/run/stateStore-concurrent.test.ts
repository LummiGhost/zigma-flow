/**
 * StateStore concurrent write tests — WF-P14-LOCKS Step 1 (Cases and Tests).
 *
 * Verifies that LocalStateStore.writeSnapshot, when wrapped with the per-runDir
 * AsyncQueue (Step 2), serializes writes to the same runDir such that:
 *   - The file always contains the last-called write's content (FIFO).
 *   - No partial or corrupted writes occur.
 *   - Different runDirs have independent queues and don't block each other.
 *
 * Reference:
 *   - docs/phases/p14-concurrent-execution/02-development-plan.md AD-P14-003
 *   - docs/phases/p14-concurrent-execution/workflows/wf-p14-locks/01-cases-and-tests.md
 *
 * Red-phase note:
 *   - T-STORE-CONCURRENT-1 may pass or fail non-deterministically without the
 *     AsyncQueue (concurrent writeFile + rename to same target file).
 *   - T-STORE-CONCURRENT-2 will likely pass without the queue because each
 *     writeSnapshot is atomic in isolation (tmp + rename).
 *   - T-STORE-ISOL-1 will pass without the queue since different runDirs
 *     already have independent files.
 *   - After Step 2 integrates the AsyncQueue, T-STORE-CONCURRENT-1 becomes
 *     deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { LocalStateStore } from "../../src/run/index.js";
import type { RunState } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-08T00:00:00.000Z";

/**
 * Build a minimal valid RunState fixture. Each write gets a distinct
 * `last_event_id` so we can verify which write "won."
 */
function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: "20260608-0001",
    workflow: "code-change",
    task: "test task",
    created_at: FIXED_ISO,
    status: "running",
    last_event_id: "evt-000",
    jobs: { intake: { status: "ready" } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// UC-STORE-CONCURRENT — concurrent writes to same runDir
// ---------------------------------------------------------------------------

describe("LocalStateStore concurrent writeSnapshot (UC-STORE-CONCURRENT)", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-store-concurrent-${randomUUID()}`);
    runDir = join(tmpDir, "20260608-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("file contains last-called write content after 5 concurrent writes (T-STORE-CONCURRENT-1)", async () => {
    const store = new LocalStateStore();
    const COUNT = 5;

    // Submit COUNT writes concurrently via Promise.all.
    // Each write has a distinct last_event_id so we can identify the winner.
    const writes = Array.from({ length: COUNT }, (_, i) =>
      store.writeSnapshot(
        runDir,
        makeRunState({ last_event_id: `evt-${String(i).padStart(3, "0")}` })
      )
    );

    await Promise.all(writes);

    // Read the file and verify it's valid JSON
    const statePath = join(runDir, "state.json");
    const text = await readFile(statePath, "utf-8");
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(text);
    }).not.toThrow();

    // With AsyncQueue serialization, the last-called write (index COUNT-1)
    // must be the one that lands in the file.
    const state = parsed as RunState;
    expect(state.last_event_id).toBe(
      `evt-${String(COUNT - 1).padStart(3, "0")}`
    );
  });

  it("produces valid parseable JSON with correct shape after 10 concurrent writes (T-STORE-CONCURRENT-2)", async () => {
    const store = new LocalStateStore();
    const COUNT = 10;

    const writes = Array.from({ length: COUNT }, (_, i) =>
      store.writeSnapshot(
        runDir,
        makeRunState({
          last_event_id: `evt-${String(i).padStart(3, "0")}`,
          task: `task-${i}`,
        })
      )
    );

    await Promise.all(writes);

    const statePath = join(runDir, "state.json");
    const text = await readFile(statePath, "utf-8");

    // Must be parseable JSON
    let parsed: RunState;
    expect(() => {
      parsed = JSON.parse(text) as RunState;
    }).not.toThrow();

    // Must have the required RunState shape (not truncated or garbled)
    expect(typeof parsed!.run_id).toBe("string");
    expect(parsed!.run_id).toBeTruthy();
    expect(typeof parsed!.last_event_id).toBe("string");
    expect(parsed!.last_event_id).toBeTruthy();
    expect(typeof parsed!.jobs).toBe("object");
    expect(parsed!.jobs).not.toBeNull();
    expect(typeof parsed!.workflow).toBe("string");
    expect(typeof parsed!.task).toBe("string");
    expect(typeof parsed!.created_at).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// UC-STORE-ISOLATION — independent queues per runDir
// ---------------------------------------------------------------------------

describe("LocalStateStore runDir isolation (UC-STORE-ISOLATION)", () => {
  let tmpDir: string;
  let runDirA: string;
  let runDirB: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-store-isolation-${randomUUID()}`);
    runDirA = join(tmpDir, "run-a");
    runDirB = join(tmpDir, "run-b");
    await mkdir(runDirA, { recursive: true });
    await mkdir(runDirB, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("concurrent writes to different runDirs do not block each other (T-STORE-ISOL-1)", async () => {
    const store = new LocalStateStore();
    const completed: string[] = [];

    await Promise.all([
      store
        .writeSnapshot(
          runDirA,
          makeRunState({ run_id: "run-a", last_event_id: "evt-a" })
        )
        .then(() => {
          completed.push("a");
        }),
      store
        .writeSnapshot(
          runDirB,
          makeRunState({ run_id: "run-b", last_event_id: "evt-b" })
        )
        .then(() => {
          completed.push("b");
        }),
    ]);

    // Both writes must complete
    expect(completed).toContain("a");
    expect(completed).toContain("b");

    // Each file must contain the correct content for its runDir
    const textA = await readFile(join(runDirA, "state.json"), "utf-8");
    const textB = await readFile(join(runDirB, "state.json"), "utf-8");
    const stateA = JSON.parse(textA) as RunState;
    const stateB = JSON.parse(textB) as RunState;

    expect(stateA.run_id).toBe("run-a");
    expect(stateA.last_event_id).toBe("evt-a");
    expect(stateB.run_id).toBe("run-b");
    expect(stateB.last_event_id).toBe("evt-b");
  });
});
