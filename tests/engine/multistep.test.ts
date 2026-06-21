/**
 * `advanceJob` tests for WF-P8-MULTISTEP (Step 1 — Cases and Tests).
 *
 * These tests exercise the Engine's mechanical step-pointer advancement
 * against real temp directories under `os.tmpdir()`. They drive
 * `advanceJob` in isolation without going through `executeCurrentStep`:
 * each test directly mutates `state.json` via `LocalStateStore` to
 * simulate the post-executor intermediate state, then invokes
 * `advanceJob` and asserts on the resulting `state.json` /
 * `events.jsonl`.
 *
 * Covers:
 *   - T-MULTISTEP-1:  Single-step job — advanceJob appends job_completed,
 *                     clears pointer, returns false.
 *   - T-MULTISTEP-2:  Two-step job — advanceJob advances pointer from
 *                     s1 to s2 and returns true.
 *   - T-MULTISTEP-3:  Three-step job — sequential advanceJob calls
 *                     advance through every step and terminate with
 *                     job_completed.
 *   - T-MULTISTEP-4:  Return value contract — true while more steps
 *                     remain, false when pointer is on the last step.
 *   - T-MULTISTEP-5:  Missing state.json — advanceJob throws StateError
 *                     without touching disk.
 *   - T-MULTISTEP-6:  Unknown job id — advanceJob throws StateError
 *                     without touching disk.
 *   - T-MULTISTEP-7:  current_step points at non-existent step id —
 *                     advanceJob throws StateError without touching
 *                     disk.
 *   - T-MULTISTEP-8:  Failed job — advanceJob is a no-op (does not
 *                     advance, does not complete).
 *   - T-MULTISTEP-9:  current_step undefined on a multi-step job —
 *                     advanceJob treats it as "first step just
 *                     finished" and advances to steps[1].
 *                     (TD-P8-005 baseline.)
 *   - T-MULTISTEP-10: Empty steps[] — advanceJob defensively completes
 *                     the job. (May be skipped in red phase if
 *                     workflow-loader bypass is not yet wired.)
 *   - T-MULTISTEP-11: Already-completed job — advanceJob is idempotent
 *                     (returns false, no writes).
 *
 * Reference:
 *   - docs/phases/p8-router-and-signals/workflows/wf-p8-multistep/01-cases-and-tests.md
 *   - docs/architecture.md §7.1, §7.2
 *   - docs/mvp-contracts.md §2.3
 *
 * Red-phase note: `src/engine/index.ts` does not yet export `advanceJob`;
 * tests fail at module resolution / named-import resolution. WF-P8-MULTISTEP
 * Step 2 ships the `advanceJob` export and turns the tests green.
 *
 * Test design notes:
 *   - `advanceJob` is contracted to be PURELY mechanical: it only mutates
 *     `state.jobs[jobId].current_step` (and on terminal, appends ONE
 *     `job_completed` event and sets `status = "completed"`). It MUST NOT
 *     emit `step_started`, `step_completed`, `step_failed`, or any
 *     routing events — those are owned by the individual step executors
 *     (P6 script, P7 check) and by WF-P8-SIGNALS.
 *   - These tests intentionally exercise `advanceJob` WITHOUT first
 *     running `executeScriptStep` / `executeCheckStep`. That isolation
 *     keeps the pointer-arithmetic contract testable independently of
 *     the executor pipeline integration (which is a Step 2 concern).
 *   - The P6 / P7 single-step tests (`tests/script/executor.test.ts`
 *     T-SCRIPT-1, `tests/check/executor.test.ts` T-CHECK-1) continue
 *     to assert end-to-end `job_completed` adjacency — those must keep
 *     passing after `advanceJob` lands (see Architecture Decision 5 in
 *     the cases-and-tests doc).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// WF-P8-MULTISTEP Step 2: `advanceJob` is now exported from engine.
// Lazy import retained to preserve backward-compatible error isolation.
// ---------------------------------------------------------------------------

interface AdvanceJobOpts {
  runDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
}

async function callAdvanceJob(opts: AdvanceJobOpts): Promise<boolean> {
  const mod = (await import("../../src/engine/index.js")) as unknown as {
    advanceJob?: (o: AdvanceJobOpts) => Promise<boolean>;
  };
  if (typeof mod.advanceJob !== "function") {
    throw new Error(
      "advanceJob is not exported from src/engine/index.ts — WF-P8-MULTISTEP Step 2 has not yet shipped the implementation."
    );
  }
  return mod.advanceJob(opts);
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-10T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Workflow YAML with a single script step. Used by T-MULTISTEP-1.
 *
 * The step body is intentionally a `script` so the workflow loader
 * accepts the YAML; the test does NOT execute the script — it bypasses
 * the executor and drives `advanceJob` directly on the post-executor
 * state simulated via `LocalStateStore.writeSnapshot`.
 */
const SINGLE_STEP_YAML = `\
name: multistep-single
version: "0.1.0"
jobs:
  build:
    steps:
      - id: only
        type: script
        run: "echo ok"
`;

/**
 * Workflow YAML with two sequential script steps. Used by T-MULTISTEP-2,
 * T-MULTISTEP-4, T-MULTISTEP-7, T-MULTISTEP-8, T-MULTISTEP-9.
 */
const TWO_STEP_YAML = `\
name: multistep-two
version: "0.1.0"
jobs:
  build:
    steps:
      - id: s1
        type: script
        run: "echo s1"
      - id: s2
        type: script
        run: "echo s2"
`;

/**
 * Workflow YAML with three sequential script steps. Used by T-MULTISTEP-3.
 */
const THREE_STEP_YAML = `\
name: multistep-three
version: "0.1.0"
jobs:
  build:
    steps:
      - id: s1
        type: script
        run: "echo s1"
      - id: s2
        type: script
        run: "echo s2"
      - id: s3
        type: script
        run: "echo s3"
`;

/**
 * Workflow YAML with an explicitly empty steps array. Used by T-MULTISTEP-10.
 *
 * The Zod schema in src/workflow/index.ts uses `z.array(StepBaseSchema)` with
 * no `.min(1)` constraint, so `steps: []` is accepted by the loader. The
 * workflow validator does not enforce a non-empty steps array at the current
 * MVP scope, which allows this defensive test to run without mocking.
 */
const EMPTY_STEPS_YAML = `\
name: multistep-empty
version: "0.1.0"
jobs:
  build:
    steps: []
`;

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  configPath: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-multistep-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ tool_version: "0.1.0", active_run: null }, null, 2),
    "utf-8"
  );
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }, null, 2), "utf-8");

  return {
    projectRoot,
    zigmaflowDir: projectRoot,
    dotZigma,
    configPath,
    runsDir,
    skillLockPath,
  };
}

/**
 * Bootstrap a run for the multistep tests. Writes the workflow YAML,
 * calls `createRun`, and returns the resolved `runId` + run directory.
 */
async function bootstrapMultistepRun(
  sandbox: Sandbox,
  yamlBody: string,
  workflowName: string
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, `${workflowName}.yml`);
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: `exercise ${workflowName}`,
    runsDir: sandbox.runsDir,
    skillLockPath: sandbox.skillLockPath,
    clock: new FakeClock(),
  });
  const runDir = join(sandbox.runsDir, runId);
  return { runId, runDir, workflowPath };
}

/**
 * Read events.jsonl as an array of parsed event objects. Drops blank lines.
 */
async function readEvents(runDir: string): Promise<
  Array<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
  }>
> {
  const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          type: string;
          payload: Record<string, unknown>;
        }
    );
}

/**
 * Read state.json as a typed snapshot.
 */
async function readStateSnapshot(runDir: string): Promise<RunState> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  return snap;
}

/**
 * Helper: read events.jsonl as raw bytes (for byte-equality assertions
 * on negative paths).
 */
async function readEventsBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "events.jsonl"), "utf-8");
}

/**
 * Helper: read state.json as raw bytes (for byte-equality assertions on
 * negative paths).
 */
async function readStateBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "state.json"), "utf-8");
}

/**
 * Sentinel passed as `current_step` in `setJobState` patches to mean
 * "delete current_step from the snapshot". Using `undefined` directly
 * would violate `exactOptionalPropertyTypes: true` because
 * `JobState.current_step` is declared as `string | undefined` without
 * the `?: undefined` discriminator.
 */
const CLEAR_CURRENT_STEP = Symbol("clear-current-step");

interface JobStatePatch {
  status?: JobState["status"];
  activation?: string;
  attempt?: number;
  current_step?: string | typeof CLEAR_CURRENT_STEP;
}

/**
 * Mutate `state.jobs[jobId]` via LocalStateStore. Merges `patch` into
 * the existing job state. Passing `current_step: CLEAR_CURRENT_STEP`
 * removes the field from the snapshot (matches the contract that
 * "absent" and "undefined" are observationally identical).
 */
async function setJobState(
  runDir: string,
  jobId: string,
  patch: JobStatePatch
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  const existing = snap.jobs[jobId];
  if (existing === undefined) {
    throw new Error(`job ${jobId} not found in state.json at ${runDir}`);
  }

  const merged: JobState = { ...existing };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.activation !== undefined) merged.activation = patch.activation;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step === CLEAR_CURRENT_STEP) {
    delete merged.current_step;
  } else if (typeof patch.current_step === "string") {
    merged.current_step = patch.current_step;
  }

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

// ---------------------------------------------------------------------------
// T-MULTISTEP-1: Single-step job — advanceJob completes the job
// ---------------------------------------------------------------------------

describe("advanceJob — single-step terminal (T-MULTISTEP-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "appends job_completed, clears current_step, sets status to completed, and returns false (T-MULTISTEP-1, UC-MULTISTEP-1, UC-MULTISTEP-5, FP-MULTISTEP-JOB-COMPLETED)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        SINGLE_STEP_YAML,
        "multistep-single"
      );

      // Simulate "running" job whose only step just finished. The executor
      // is responsible for transitioning ready → running; here we
      // hand-set the simulated state.
      await setJobState(runDir, "build", { status: "running" });

      const returned = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });

      expect(returned).toBe(false);

      const events = await readEvents(runDir);
      // run_completed is now appended after job_completed when all jobs finish.
      const jobCompletedEvent = events.find((e) => e.type === "job_completed");
      expect(jobCompletedEvent).toBeDefined();
      expect(jobCompletedEvent!.payload).toMatchObject({ job_id: "build" });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["build"]!.status).toBe("completed");
      expect(snap.jobs["build"]!.current_step).toBeUndefined();
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-2: Two-step job — advanceJob moves pointer from s1 to s2
// ---------------------------------------------------------------------------

describe("advanceJob — two-step non-terminal advance (T-MULTISTEP-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "advances current_step from s1 to s2 without appending events, returns true (T-MULTISTEP-2, UC-MULTISTEP-2, UC-MULTISTEP-4, FP-MULTISTEP-POINTER-WRITE)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        TWO_STEP_YAML,
        "multistep-two"
      );

      await setJobState(runDir, "build", { status: "running", current_step: "s1" });
      const eventsBefore = await readEventsBytes(runDir);

      const returned = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });

      expect(returned).toBe(true);

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["build"]!.current_step).toBe("s2");
      expect(snap.jobs["build"]!.status).toBe("running");

      const eventsAfter = await readEventsBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-3: Three-step job — sequential advance through all steps
// ---------------------------------------------------------------------------

describe("advanceJob — three-step sequential walkthrough (T-MULTISTEP-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "walks current_step s1 → s2 → s3 and terminates with exactly one job_completed (T-MULTISTEP-3, UC-MULTISTEP-3, FP-MULTISTEP-FINAL-SEQUENCE)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        THREE_STEP_YAML,
        "multistep-three"
      );

      await setJobState(runDir, "build", { status: "running", current_step: "s1" });
      const r1 = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });
      expect(r1).toBe(true);
      expect((await readStateSnapshot(runDir)).jobs["build"]!.current_step).toBe("s2");

      await setJobState(runDir, "build", { current_step: "s2" });
      const r2 = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });
      expect(r2).toBe(true);
      expect((await readStateSnapshot(runDir)).jobs["build"]!.current_step).toBe("s3");

      await setJobState(runDir, "build", { current_step: "s3" });
      const r3 = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });
      expect(r3).toBe(false);

      const events = await readEvents(runDir);
      const completedEvents = events.filter((e) => e.type === "job_completed");
      expect(completedEvents.length).toBe(1);
      // run_completed is now appended after job_completed when all jobs finish.
      expect(events.some((e) => e.type === "job_completed")).toBe(true);

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["build"]!.status).toBe("completed");
      expect(snap.jobs["build"]!.current_step).toBeUndefined();
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-4: Return-value contract — true when more remain, false on last
// ---------------------------------------------------------------------------

describe("advanceJob — return value contract (T-MULTISTEP-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "returns true while more steps remain, false when the pointer is on the last step (T-MULTISTEP-4, UC-MULTISTEP-4, UC-MULTISTEP-5)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        TWO_STEP_YAML,
        "multistep-two"
      );

      await setJobState(runDir, "build", { status: "running", current_step: "s1" });
      const r1 = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });
      expect(r1).toBe(true);

      await setJobState(runDir, "build", { current_step: "s2" });
      const r2 = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });
      expect(r2).toBe(false);
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-5: Missing state.json → StateError, no disk mutation
// ---------------------------------------------------------------------------

describe("advanceJob — missing state.json (T-MULTISTEP-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws StateError without appending events when state.json is missing (T-MULTISTEP-5, UC-MULTISTEP-8, FP-MULTISTEP-STATE-MISSING)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        SINGLE_STEP_YAML,
        "multistep-single"
      );

      // Snapshot events.jsonl size BEFORE corrupting the run, then
      // delete state.json. advanceJob MUST throw and MUST NOT append
      // any events.
      const eventsSizeBefore = (await stat(join(runDir, "events.jsonl"))).size;
      await rm(join(runDir, "state.json"), { force: true });

      await expect(
        callAdvanceJob({
          runDir,
          runId,
          jobId: "build",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "StateError" });

      const eventsSizeAfter = (await stat(join(runDir, "events.jsonl"))).size;
      expect(eventsSizeAfter).toBe(eventsSizeBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-6: Unknown job id → StateError, no disk mutation
// ---------------------------------------------------------------------------

describe("advanceJob — unknown job id (T-MULTISTEP-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws StateError without touching events.jsonl or state.json when the job id is unknown (T-MULTISTEP-6, UC-MULTISTEP-9, FP-MULTISTEP-INVALID-JOB)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        TWO_STEP_YAML,
        "multistep-two"
      );

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAdvanceJob({
          runDir,
          runId,
          jobId: "no-such-job",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "StateError" });

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-7: current_step points at non-existent step id → StateError
// ---------------------------------------------------------------------------

describe("advanceJob — pointer references unknown step id (T-MULTISTEP-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws StateError when current_step is not present in JobDefinition.steps, without writing state or events (T-MULTISTEP-7, UC-MULTISTEP-10, FP-MULTISTEP-UNKNOWN-POINTER)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        TWO_STEP_YAML,
        "multistep-two"
      );

      await setJobState(runDir, "build", { status: "running", current_step: "ghost" });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAdvanceJob({
          runDir,
          runId,
          jobId: "build",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "StateError" });

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-8: Failed job → advanceJob is an inert no-op
// ---------------------------------------------------------------------------

describe("advanceJob — failed-job gate (T-MULTISTEP-8)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "returns false and does not mutate disk when the job status is failed (T-MULTISTEP-8, UC-MULTISTEP-6, FP-MULTISTEP-FAILED-GATE)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        TWO_STEP_YAML,
        "multistep-two"
      );

      await setJobState(runDir, "build", { status: "failed", current_step: "s1" });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      const returned = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });
      expect(returned).toBe(false);

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-9: current_step undefined → "implicit first step finished"
// ---------------------------------------------------------------------------

describe("advanceJob — undefined pointer baseline (T-MULTISTEP-9, TD-P8-005)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "treats current_step undefined as 'first step just finished' and advances to steps[1] (T-MULTISTEP-9, UC-MULTISTEP-7, FP-MULTISTEP-POINTER-INIT, TD-P8-005)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        TWO_STEP_YAML,
        "multistep-two"
      );

      // Set the job to running with current_step explicitly cleared.
      // This simulates the post-retry-reset state owned by WF-P8-SIGNALS:
      // retry handler clears the pointer; advanceJob restarts the walk
      // from the first step.
      await setJobState(runDir, "build", {
        status: "running",
        current_step: CLEAR_CURRENT_STEP,
      });

      const returned = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });

      expect(returned).toBe(true);
      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["build"]!.current_step).toBe("s2");
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-10: Empty steps[] → defensive job_completed
// ---------------------------------------------------------------------------

describe("advanceJob — empty steps array defensive completion (T-MULTISTEP-10)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  // NOTE: `z.array(StepBaseSchema)` in src/workflow/index.ts has no `.min(1)`
  // constraint, so `steps: []` is accepted by the loader without mocking.
  // The EMPTY_STEPS_YAML fixture exercises the defensive completion branch
  // in advanceJob directly.
  it(
    "appends job_completed and marks the job completed when JobDefinition.steps is empty (T-MULTISTEP-10, UC-MULTISTEP-11, FP-MULTISTEP-EMPTY-STEPS)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        EMPTY_STEPS_YAML,
        "multistep-empty"
      );

      // Set the job to running (createRun sets it to ready; no steps to execute)
      await setJobState(runDir, "build", { status: "running" });

      const returned = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });

      expect(returned).toBe(false);

      const events = await readEvents(runDir);
      // run_completed is now appended after job_completed when all jobs finish.
      const jobCompletedEvent = events.find((e) => e.type === "job_completed");
      expect(jobCompletedEvent).toBeDefined();
      expect(jobCompletedEvent!.payload).toMatchObject({ job_id: "build" });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["build"]!.status).toBe("completed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-MULTISTEP-11: Already-completed job → idempotent no-op
// ---------------------------------------------------------------------------

describe("advanceJob — idempotent terminal (T-MULTISTEP-11)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "returns false without appending events or writing snapshots when status is already completed (T-MULTISTEP-11, FP-MULTISTEP-IDEMPOTENT-TERMINAL)",
    async () => {
      const { runId, runDir } = await bootstrapMultistepRun(
        sandbox,
        SINGLE_STEP_YAML,
        "multistep-single"
      );

      await setJobState(runDir, "build", { status: "completed" });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      const returned = await callAdvanceJob({
        runDir,
        runId,
        jobId: "build",
        clock: new FakeClock(),
      });
      expect(returned).toBe(false);

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});
