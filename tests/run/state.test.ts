/**
 * State snapshot consistency tests for WF-P4-STATE (Step 1 — Cases and Tests).
 *
 * Covers:
 *   - Corrupted state.json (invalid JSON, missing required shape)
 *   - Event/state divergence detection (snapshot last_event_id vs events.jsonl tail)
 *   - Round-trip preservation of the contract RunState fields (including `status`)
 *   - Atomic write tmp-file cleanup
 *   - "Only Engine writes state" boundary — detection of a foreign writer
 *
 * Reference:
 *   - docs/phases/p4-event-artifact/workflows/wf-p4-state/01-cases-and-tests.md
 *   - docs/mvp-contracts.md §2.3 (Run State Contract)
 *   - docs/architecture.md §7.3 (Event and snapshot persistence)
 *
 * Red-phase notes:
 *   - StateError must be exported from src/utils/index.js.
 *   - RunState must include a `status` field per mvp-contracts §2.3.
 *   - LocalStateStore.readSnapshot must throw StateError on JSON parse / shape failures.
 *   - LocalStateStore.validateLastEventId(runDir) must read events.jsonl tail and
 *     throw StateError on mismatch (no caller-supplied expected id).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { RunState, WorkflowEvent } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { StateError } from "../../src/utils/index.js";

const FIXED_ISO = "2026-06-08T00:00:00.000Z";

/**
 * Build a fully-populated RunState fixture using the schema mvp-contracts §2.3
 * requires (including the `status` field added by WF-P4-STATE Step 2).
 */
function makeRunState(overrides: Partial<RunState> = {}): RunState {
  const base: RunState = {
    run_id: "20260608-0001",
    workflow: "code-change",
    task: "fix the bug",
    created_at: FIXED_ISO,
    status: "running",
    last_event_id: "evt-002",
    jobs: {
      intake: { status: "ready" },
      "code-map": { status: "waiting" },
    },
  };
  return { ...base, ...overrides };
}

/**
 * Append a JSON line representing a WorkflowEvent directly to events.jsonl.
 * Tests use this rather than JsonlEventWriter so the assertion exercises the
 * StateStore contract independently of the writer implementation.
 */
async function writeEventLine(runDir: string, event: WorkflowEvent): Promise<void> {
  const eventsPath = join(runDir, "events.jsonl");
  await writeFile(eventsPath, JSON.stringify(event) + "\n", { flag: "a", encoding: "utf-8" });
}

// ---------------------------------------------------------------------------
// LocalStateStore.readSnapshot — corruption detection (T-STATE-CORRUPT-1/2)
// ---------------------------------------------------------------------------

describe("LocalStateStore.readSnapshot", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-state-${randomUUID()}`);
    runDir = join(tmpDir, "20260608-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws StateError when state.json contains invalid JSON (T-STATE-CORRUPT-1, UC-STATE-CORRUPT-1)", async () => {
    const store = new LocalStateStore();
    await writeFile(join(runDir, "state.json"), "not-json{", "utf-8");

    await expect(store.readSnapshot(runDir)).rejects.toBeInstanceOf(StateError);
    await expect(store.readSnapshot(runDir)).rejects.toMatchObject({ kind: "StateError" });
  });

  it("throws StateError when state.json JSON is missing required fields (T-STATE-CORRUPT-2, UC-STATE-CORRUPT-2)", async () => {
    const store = new LocalStateStore();
    // Valid JSON, wrong shape — missing run_id, workflow, jobs, etc.
    await writeFile(join(runDir, "state.json"), JSON.stringify({}), "utf-8");

    await expect(store.readSnapshot(runDir)).rejects.toBeInstanceOf(StateError);
  });
});

// ---------------------------------------------------------------------------
// LocalStateStore.validateLastEventId — event/state consistency (SC-S12, SC-S13)
// ---------------------------------------------------------------------------

describe("LocalStateStore.validateLastEventId", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-state-${randomUUID()}`);
    runDir = join(tmpDir, "20260608-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves when snapshot last_event_id matches events.jsonl tail (T-STATE-EVT-1, UC-STATE-EVT-1)", async () => {
    const store = new LocalStateStore();
    const state = makeRunState({ last_event_id: "evt-002" });
    await store.writeSnapshot(runDir, state);

    await writeEventLine(runDir, {
      id: "evt-001",
      type: "run_created",
      run_id: state.run_id,
      timestamp: FIXED_ISO,
      payload: {},
    });
    await writeEventLine(runDir, {
      id: "evt-002",
      type: "job_ready",
      run_id: state.run_id,
      timestamp: FIXED_ISO,
      payload: { job_id: "intake" },
    });

    await expect(store.validateLastEventId(runDir)).resolves.toBeUndefined();
  });

  it("throws StateError when snapshot last_event_id lags behind log tail (T-STATE-EVT-2, UC-STATE-EVT-2)", async () => {
    const store = new LocalStateStore();
    const state = makeRunState({ last_event_id: "evt-002" });
    await store.writeSnapshot(runDir, state);

    await writeEventLine(runDir, {
      id: "evt-001",
      type: "run_created",
      run_id: state.run_id,
      timestamp: FIXED_ISO,
      payload: {},
    });
    await writeEventLine(runDir, {
      id: "evt-002",
      type: "job_ready",
      run_id: state.run_id,
      timestamp: FIXED_ISO,
      payload: { job_id: "intake" },
    });
    await writeEventLine(runDir, {
      id: "evt-003",
      type: "step_started",
      run_id: state.run_id,
      timestamp: FIXED_ISO,
      payload: { job_id: "intake", step_id: "plan" },
    });

    await expect(store.validateLastEventId(runDir)).rejects.toBeInstanceOf(StateError);
    await expect(store.validateLastEventId(runDir)).rejects.toMatchObject({
      kind: "StateError",
      details: { snapshot_last_event_id: "evt-002", events_tail_id: "evt-003" },
    });
  });

  it("throws StateError when events.jsonl is missing but snapshot has an id (T-STATE-EVT-3, UC-STATE-EVT-3)", async () => {
    const store = new LocalStateStore();
    const state = makeRunState({ last_event_id: "evt-001" });
    await store.writeSnapshot(runDir, state);
    // events.jsonl intentionally absent.

    await expect(store.validateLastEventId(runDir)).rejects.toBeInstanceOf(StateError);
  });
});

// ---------------------------------------------------------------------------
// Round-trip preservation including the new `status` field (SC-S01..S07)
// ---------------------------------------------------------------------------

describe("LocalStateStore round-trip", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-state-${randomUUID()}`);
    runDir = join(tmpDir, "20260608-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writeSnapshot then readSnapshot preserves all RunState fields including status (T-STATE-RT-1, UC-STATE-RT-1)", async () => {
    const store = new LocalStateStore();
    const state = makeRunState();

    await store.writeSnapshot(runDir, state);
    const snap = await store.readSnapshot(runDir);

    expect(snap).toEqual(state);
    expect(snap?.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Atomic write tmp-file cleanup (SC-S11)
// ---------------------------------------------------------------------------

describe("LocalStateStore.writeSnapshot atomicity", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-state-${randomUUID()}`);
    runDir = join(tmpDir, "20260608-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("cleans up tmp file after successful rename (T-STATE-ATOMIC-1, UC-STATE-ATOMIC-1)", async () => {
    const store = new LocalStateStore();
    await store.writeSnapshot(runDir, makeRunState());

    const entries = await readdir(runDir);
    expect(entries).toContain("state.json");
    const stray = entries.filter((name) => name.startsWith("state.json.tmp-"));
    expect(stray).toEqual([]);
  });

  it("leaves no stray tmp file after two successive writes (T-STATE-ATOMIC-2, UC-STATE-ATOMIC-2)", async () => {
    const store = new LocalStateStore();
    await store.writeSnapshot(runDir, makeRunState({ last_event_id: "evt-001" }));
    await store.writeSnapshot(runDir, makeRunState({ last_event_id: "evt-002", status: "blocked" }));

    const entries = await readdir(runDir);
    const stray = entries.filter((name) => name.startsWith("state.json.tmp-"));
    expect(stray).toEqual([]);

    const snap = await store.readSnapshot(runDir);
    expect(snap?.last_event_id).toBe("evt-002");
    expect(snap?.status).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// state.json ownership boundary (SC-S10, SC-S13)
// ---------------------------------------------------------------------------

describe("state.json ownership boundary", () => {
  let tmpDir: string;
  let runDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `zigma-state-${randomUUID()}`);
    runDir = join(tmpDir, "20260608-0001");
    await mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("readSnapshot rejects state.json produced by a non-StateStore writer (T-STATE-BOUND-1, UC-STATE-BOUND-1)", async () => {
    const store = new LocalStateStore();
    // 1. Legitimate write through the store.
    await store.writeSnapshot(runDir, makeRunState());

    // 2. Simulate a non-Engine caller (CLI, script, or external process)
    //    bypassing the StateStore and overwriting state.json directly.
    //    mvp-contracts §2.3 SC-S10 says only the Engine via StateStore may write
    //    state.json; MVP enforces the boundary by *detecting* corruption on read.
    await writeFile(join(runDir, "state.json"), "garbage from a non-StateStore writer", "utf-8");

    // 3. Engine subsequently re-reads — must refuse to advance the run.
    await expect(store.readSnapshot(runDir)).rejects.toBeInstanceOf(StateError);
  });
});
