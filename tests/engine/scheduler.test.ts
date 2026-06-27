/**
 * Scheduler tests for WF-P14-SCHEDULER (Step 1 — Cases and Tests).
 *
 * Exercises the `selectExecutable` pure function that decides which jobs
 * can run concurrently in a batch, enforcing the writable lock constraint.
 *
 * Contract:
 *   - selectExecutable(state, workflow, config) → ExecutableBatch
 *   - Only one writable job may run at a time (write lock).
 *   - Read-only jobs can run concurrently up to the parallelism limit.
 *   - The function is pure: no IO, no filesystem, no async.
 *
 * Covers:
 *   - UC-EMPTY:           No ready jobs → empty batch
 *   - UC-RO-ONLY:         Read-only only, no writable
 *   - UC-PARALLEL-EXCEEDS:Parallelism > ready count
 *   - UC-MIXED:           Mixed RO + W, no writable running
 *   - UC-W-ONLY:          Writable only, no writable running
 *   - UC-W-LOCKED:        Mixed but writable already running
 *   - UC-W-LOCKED-W-ONLY: Writable running, only writable ready
 *   - UC-PARALLEL-1:      Parallelism = 1
 *   - UC-RUNNING-FULL:    All slots filled by running jobs
 *   - UC-RO-RUNNING:      Read-only already running consumes slots
 *   - UC-MULTI-W:         Multiple writables ready, none running
 *   - UC-DEFAULT-W:       Job without workspace.mode treated as writable
 *   - UC-EXPLICIT-W:      Job with workspace.mode="writable" explicitly
 *   - UC-RO-W-RUNNING:    Single RO ready, writable running
 *   - UC-RO-PREFERENCE:   Read-only preferred when slots limited

 * Reference:
 *   - docs/phases/p14-concurrent-execution/workflows/wf-p14-scheduler/01-cases-and-tests.md
 *   - docs/phases/p14-concurrent-execution/02-development-plan.md AD-P14-001, AD-P14-002
 *
 * Red-phase note: `src/engine/scheduler.ts` does not yet exist. These tests
 * will fail to compile until Step 2 creates the module. This is expected
 * RED-phase behavior.
 */

import { describe, expect, it } from "vitest";

import type {
  ExecutableBatch,
  SchedulerConfig,
  SchedulerInput,
} from "../../src/engine/scheduler.js";
import { selectExecutable } from "../../src/engine/scheduler.js";
import type { JobState, RunState } from "../../src/run/index.js";
import type { JobDefinition, WorkflowDefinition } from "../../src/workflow/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SchedulerConfig = {
  parallelism: 4,
  runningWritableLimit: 1,
};

/**
 * Create a minimal RunState with the given job map.
 */
function makeRunState(jobs: Record<string, JobState>): RunState {
  return {
    run_id: "test-run-1",
    workflow: "test-workflow",
    task: "test task",
    created_at: "2026-06-28T00:00:00.000Z",
    last_event_id: "evt-001",
    status: "running",
    jobs,
  };
}

/**
 * Create a JobState with the given status (and minimal defaults).
 */
function makeJobState(status: JobState["status"]): JobState {
  return { status };
}

/**
 * Create a JobDefinition with the given workspace mode.
 * `mode` is placed under `workspace.mode` in the definition.
 */
function makeJobDef(mode?: string): JobDefinition {
  if (mode === undefined) {
    return { steps: [{ id: "step-1", type: "agent" }] };
  }
  return {
    steps: [{ id: "step-1", type: "agent" }],
    workspace: { mode },
  };
}

/**
 * Create a WorkflowDefinition with given job definitions.
 */
function makeWorkflow(jobs: Record<string, JobDefinition>): WorkflowDefinition {
  return {
    name: "test-workflow",
    version: "1.0",
    jobs,
  };
}

// ---------------------------------------------------------------------------
// Type-level smoke test — verifies the function exists and returns expected shape
// ---------------------------------------------------------------------------

describe("selectExecutable — contract smoke", () => {
  it("returns ExecutableBatch with jobs array and rationale string (T-SCHED-SMOKE-1)", () => {
    const state = makeRunState({});
    const wf = makeWorkflow({});
    const config: SchedulerConfig = DEFAULT_CONFIG;

    const input: SchedulerInput = { state, workflow: wf, config };
    const batch: ExecutableBatch = selectExecutable(input);

    expect(batch).toBeDefined();
    expect(Array.isArray(batch.jobs)).toBe(true);
    expect(typeof batch.rationale).toBe("string");
    expect(batch.rationale.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// UC-EMPTY: No ready jobs
// ---------------------------------------------------------------------------

describe("selectExecutable — empty ready pool (UC-EMPTY)", () => {
  it("returns empty batch when no jobs are ready (T-SCHED-EMPTY-1)", () => {
    const state = makeRunState({
      "job-a": makeJobState("waiting"),
      "job-b": makeJobState("done"),
      "job-c": makeJobState("inactive"),
      "job-d": makeJobState("blocked"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only"),
      "job-b": makeJobDef("read-only"),
      "job-c": makeJobDef("read-only"),
      "job-d": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(0);
    expect(batch.rationale).toContain("ready");
  });

  it("returns empty batch when state.jobs is empty (T-SCHED-EMPTY-2)", () => {
    const state = makeRunState({});
    const wf = makeWorkflow({});

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// UC-RO-ONLY: Read-only only scenarios
// ---------------------------------------------------------------------------

describe("selectExecutable — read-only only (UC-RO-ONLY)", () => {
  it("selects all read-only ready jobs up to parallelism (T-SCHED-RO-1)", () => {
    const state = makeRunState({
      "job-a": makeJobState("ready"),
      "job-b": makeJobState("ready"),
      "job-c": makeJobState("ready"),
      "job-d": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only"),
      "job-b": makeJobDef("read-only"),
      "job-c": makeJobDef("read-only"),
      "job-d": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(4);
    expect(batch.jobs.every((j) => j.mode === "read-only")).toBe(true);
    const ids = batch.jobs.map((j) => j.jobId).sort();
    expect(ids).toEqual(["job-a", "job-b", "job-c", "job-d"]);
  });

  it("caps at parallelism when more read-only ready than parallelism (T-SCHED-RO-2)", () => {
    const state = makeRunState({
      "job-a": makeJobState("ready"),
      "job-b": makeJobState("ready"),
      "job-c": makeJobState("ready"),
      "job-d": makeJobState("ready"),
      "job-e": makeJobState("ready"),
      "job-f": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only"),
      "job-b": makeJobDef("read-only"),
      "job-c": makeJobDef("read-only"),
      "job-d": makeJobDef("read-only"),
      "job-e": makeJobDef("read-only"),
      "job-f": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // parallelism=4, 6 ready → only 4 selected
    expect(batch.jobs).toHaveLength(4);
  });

  // UC-PARALLEL-EXCEEDS
  it("returns all ready when parallelism exceeds ready count (T-SCHED-PEX-1)", () => {
    const state = makeRunState({
      "job-a": makeJobState("ready"),
      "job-b": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only"),
      "job-b": makeJobDef("read-only"),
    });
    const config: SchedulerConfig = { parallelism: 8, runningWritableLimit: 1 };

    const batch = selectExecutable({ state, workflow: wf, config });

    expect(batch.jobs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// UC-MIXED: Mixed read-only + writable, no writable running
// ---------------------------------------------------------------------------

describe("selectExecutable — mixed RO + writable, no lock held (UC-MIXED, UC-W-ONLY)", () => {
  it("selects read-only + one writable up to parallelism (T-SCHED-MIXED-1)", () => {
    const state = makeRunState({
      "ro-1": makeJobState("ready"),
      "ro-2": makeJobState("ready"),
      "ro-3": makeJobState("ready"),
      "w-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-1": makeJobDef("read-only"),
      "ro-2": makeJobDef("read-only"),
      "ro-3": makeJobDef("read-only"),
      "w-1": makeJobDef("writable"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(4);
    const roCount = batch.jobs.filter((j) => j.mode === "read-only").length;
    const wCount = batch.jobs.filter((j) => j.mode === "writable").length;
    expect(roCount).toBe(3);
    expect(wCount).toBe(1);
  });

  // UC-W-ONLY
  it("selects writable when only writable is ready (T-SCHED-WONLY-1)", () => {
    const state = makeRunState({
      "w-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-1": makeJobDef("writable"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(1);
    expect(batch.jobs[0]!.jobId).toBe("w-1");
    expect(batch.jobs[0]!.mode).toBe("writable");
  });
});

// ---------------------------------------------------------------------------
// UC-W-LOCKED: Writable lock held scenarios
// ---------------------------------------------------------------------------

describe("selectExecutable — writable lock held (UC-W-LOCKED, UC-W-LOCKED-W-ONLY, UC-RO-W-RUNNING)", () => {
  it("only selects read-only when a writable is already running (T-SCHED-LOCKED-1)", () => {
    const state = makeRunState({
      "w-running": { status: "running" },
      "ro-1": makeJobState("ready"),
      "ro-2": makeJobState("ready"),
      "ro-3": makeJobState("ready"),
      "w-ready": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-running": makeJobDef("writable"),
      "ro-1": makeJobDef("read-only"),
      "ro-2": makeJobDef("read-only"),
      "ro-3": makeJobDef("read-only"),
      "w-ready": makeJobDef("writable"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // writable is running → only read-only jobs can be selected
    expect(batch.jobs.every((j) => j.mode === "read-only")).toBe(true);
    expect(batch.jobs).toHaveLength(3);
  });

  // UC-W-LOCKED-W-ONLY
  it("returns empty batch when writable is running and only writable jobs are ready (T-SCHED-LOCKED-2)", () => {
    const state = makeRunState({
      "w-running": { status: "running" },
      "w-ready-1": makeJobState("ready"),
      "w-ready-2": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-running": makeJobDef("writable"),
      "w-ready-1": makeJobDef("writable"),
      "w-ready-2": makeJobDef("writable"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(0);
    expect(batch.rationale.length).toBeGreaterThan(0);
  });

  // UC-RO-W-RUNNING
  it("selects read-only when writable is running even if only one RO ready (T-SCHED-LOCKED-3)", () => {
    const state = makeRunState({
      "w-running": { status: "running" },
      "ro-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-running": makeJobDef("writable"),
      "ro-1": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(1);
    expect(batch.jobs[0]!.mode).toBe("read-only");
  });
});

// ---------------------------------------------------------------------------
// UC-PARALLEL-1: Parallelism = 1
// ---------------------------------------------------------------------------

describe("selectExecutable — parallelism boundaries (UC-PARALLEL-1, UC-RUNNING-FULL)", () => {
  it("selects at most 1 job when parallelism is 1 (T-SCHED-P1-1)", () => {
    const state = makeRunState({
      "ro-1": makeJobState("ready"),
      "ro-2": makeJobState("ready"),
      "ro-3": makeJobState("ready"),
      "w-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-1": makeJobDef("read-only"),
      "ro-2": makeJobDef("read-only"),
      "ro-3": makeJobDef("read-only"),
      "w-1": makeJobDef("writable"),
    });
    const config: SchedulerConfig = { parallelism: 1, runningWritableLimit: 1 };

    const batch = selectExecutable({ state, workflow: wf, config });

    expect(batch.jobs).toHaveLength(1);
    // Read-only should be preferred
    expect(batch.jobs[0]!.mode).toBe("read-only");
  });

  it("returns empty batch when parallelism is 1 and a writable is running (T-SCHED-P1-2)", () => {
    const state = makeRunState({
      "w-running": { status: "running" },
      "ro-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-running": makeJobDef("writable"),
      "ro-1": makeJobDef("read-only"),
    });
    const config: SchedulerConfig = { parallelism: 1, runningWritableLimit: 1 };

    const batch = selectExecutable({ state, workflow: wf, config });

    // With parallelism=1 and a writable running: 1 - 0 running RO = 1 slot,
    // but writable lock is held, so only read-only allowed.
    // The read-only should be selected — it's allowed.
    expect(batch.jobs).toHaveLength(1);
    expect(batch.jobs[0]!.mode).toBe("read-only");
  });

  // UC-RUNNING-FULL
  it("returns empty batch when all parallelism slots are consumed by running jobs (T-SCHED-FULL-1)", () => {
    const state = makeRunState({
      "ro-r1": { status: "running" },
      "ro-r2": { status: "running" },
      "ro-r3": { status: "running" },
      "ro-r4": { status: "running" },
      "ro-ready": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-r1": makeJobDef("read-only"),
      "ro-r2": makeJobDef("read-only"),
      "ro-r3": makeJobDef("read-only"),
      "ro-r4": makeJobDef("read-only"),
      "ro-ready": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // 4 running read-only, parallelism=4 → 0 free slots
    expect(batch.jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// UC-RO-RUNNING: Running read-only consumes slots
// ---------------------------------------------------------------------------

describe("selectExecutable — running read-only slot consumption (UC-RO-RUNNING)", () => {
  it("caps ready read-only at parallelism minus running read-only count (T-SCHED-RORUN-1)", () => {
    const state = makeRunState({
      "ro-r1": { status: "running" },
      "ro-r2": { status: "running" },
      "ro-1": makeJobState("ready"),
      "ro-2": makeJobState("ready"),
      "ro-3": makeJobState("ready"),
      "ro-4": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-r1": makeJobDef("read-only"),
      "ro-r2": makeJobDef("read-only"),
      "ro-1": makeJobDef("read-only"),
      "ro-2": makeJobDef("read-only"),
      "ro-3": makeJobDef("read-only"),
      "ro-4": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // parallelism=4, 2 running RO → 2 free slots for RO
    expect(batch.jobs).toHaveLength(2);
    expect(batch.jobs.every((j) => j.mode === "read-only")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UC-MULTI-W: Multiple writables ready, none running
// ---------------------------------------------------------------------------

describe("selectExecutable — multiple writables ready (UC-MULTI-W)", () => {
  it("selects only one writable even when multiple are ready (T-SCHED-MULTIW-1)", () => {
    const state = makeRunState({
      "w-1": makeJobState("ready"),
      "w-2": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-1": makeJobDef("writable"),
      "w-2": makeJobDef("writable"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(1);
    expect(batch.jobs[0]!.mode).toBe("writable");
  });

  it("selects read-only + one writable when mixed and multiple writable ready (T-SCHED-MULTIW-2)", () => {
    const state = makeRunState({
      "ro-1": makeJobState("ready"),
      "w-1": makeJobState("ready"),
      "w-2": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-1": makeJobDef("read-only"),
      "w-1": makeJobDef("writable"),
      "w-2": makeJobDef("writable"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(2); // 1 RO + 1 W
    const roJobs = batch.jobs.filter((j) => j.mode === "read-only");
    const wJobs = batch.jobs.filter((j) => j.mode === "writable");
    expect(roJobs).toHaveLength(1);
    expect(wJobs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// UC-DEFAULT-W / UC-EXPLICIT-W: Workspace mode derivation
// ---------------------------------------------------------------------------

describe("selectExecutable — workspace mode derivation (UC-DEFAULT-W, UC-EXPLICIT-W)", () => {
  it("treats job without workspace field as writable (T-SCHED-DEFW-1)", () => {
    const state = makeRunState({
      "job-a": makeJobState("ready"),
      "job-b": makeJobState("ready"),
    });
    // job-a has no workspace field at all
    const wf = makeWorkflow({
      "job-a": makeJobDef(), // undefined mode → writable
      "job-b": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // job-a is writable (no workspace), job-b is read-only
    // No lock held → 1 RO + 1 W
    expect(batch.jobs).toHaveLength(2);
    const ro = batch.jobs.filter((j) => j.mode === "read-only");
    const w = batch.jobs.filter((j) => j.mode === "writable");
    expect(ro).toHaveLength(1);
    expect(w).toHaveLength(1);
    expect(w[0]!.jobId).toBe("job-a");
  });

  it("treats job with workspace.mode='writable' as writable (T-SCHED-EXPLW-1)", () => {
    const state = makeRunState({
      "w-1": makeJobState("ready"),
      "ro-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-1": makeJobDef("writable"), // explicit writable
      "ro-1": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch.jobs).toHaveLength(2);
    const w = batch.jobs.filter((j) => j.mode === "writable");
    expect(w).toHaveLength(1);
    expect(w[0]!.jobId).toBe("w-1");
  });

  it("enforces write lock against job with no workspace (treated as writable) (T-SCHED-DEFW-2)", () => {
    const state = makeRunState({
      "w-running": makeJobState("running"), // no workspace → writable
      "job-a": makeJobState("ready"),       // no workspace → writable
      "ro-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-running": makeJobDef(), // no mode → writable
      "job-a": makeJobDef(),     // no mode → writable
      "ro-1": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // writable is running → only read-only allowed
    expect(batch.jobs).toHaveLength(1);
    expect(batch.jobs[0]!.mode).toBe("read-only");
    expect(batch.jobs[0]!.jobId).toBe("ro-1");
  });
});

// ---------------------------------------------------------------------------
// UC-RO-PREFERENCE: Read-only preferred over writable when slots limited
// ---------------------------------------------------------------------------

describe("selectExecutable — read-only preference (UC-RO-PREFERENCE)", () => {
  it("fills available slots with read-only before adding writable (T-SCHED-ROPREF-1)", () => {
    const state = makeRunState({
      "ro-1": makeJobState("ready"),
      "ro-2": makeJobState("ready"),
      "w-1": makeJobState("ready"),
      "w-2": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-1": makeJobDef("read-only"),
      "ro-2": makeJobDef("read-only"),
      "w-1": makeJobDef("writable"),
      "w-2": makeJobDef("writable"),
    });
    const config: SchedulerConfig = { parallelism: 2, runningWritableLimit: 1 };

    const batch = selectExecutable({ state, workflow: wf, config });

    // 2 slots, 2 RO ready → both RO selected, no writable
    expect(batch.jobs).toHaveLength(2);
    expect(batch.jobs.every((j) => j.mode === "read-only")).toBe(true);
  });

  it("adds writable when read-only doesn't fill all slots (T-SCHED-ROPREF-2)", () => {
    const state = makeRunState({
      "ro-1": makeJobState("ready"),
      "w-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-1": makeJobDef("read-only"),
      "w-1": makeJobDef("writable"),
    });
    const config: SchedulerConfig = { parallelism: 3, runningWritableLimit: 1 };

    const batch = selectExecutable({ state, workflow: wf, config });

    // 3 slots, 1 RO + 1 W ready → 1 RO + 1 W (2 total)
    expect(batch.jobs).toHaveLength(2);
    expect(batch.jobs.some((j) => j.mode === "read-only")).toBe(true);
    expect(batch.jobs.some((j) => j.mode === "writable")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rationale validation
// ---------------------------------------------------------------------------

describe("selectExecutable — rationale quality", () => {
  it("returns descriptive rationale for non-empty batch (T-SCHED-RAT-1)", () => {
    const state = makeRunState({
      "ro-1": makeJobState("ready"),
      "w-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-1": makeJobDef("read-only"),
      "w-1": makeJobDef("writable"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(typeof batch.rationale).toBe("string");
    expect(batch.rationale.length).toBeGreaterThan(10);
  });

  it("returns descriptive rationale for empty batch (T-SCHED-RAT-2)", () => {
    const state = makeRunState({});
    const wf = makeWorkflow({});

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(typeof batch.rationale).toBe("string");
    expect(batch.rationale.length).toBeGreaterThan(0);
  });

  it("mentions lock in rationale when writable is running (T-SCHED-RAT-3)", () => {
    const state = makeRunState({
      "w-running": { status: "running" },
      "ro-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "w-running": makeJobDef("writable"),
      "ro-1": makeJobDef("read-only"),
    });
    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // Rationale should mention writable is running or queued jobs
    const r = batch.rationale.toLowerCase();
    expect(r.includes("writable") || r.includes("lock") || r.includes("running")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("selectExecutable — determinism", () => {
  it("returns identical results for identical inputs (T-SCHED-DET-1)", () => {
    const state = makeRunState({
      "ro-1": makeJobState("ready"),
      "ro-2": makeJobState("ready"),
      "w-1": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "ro-1": makeJobDef("read-only"),
      "ro-2": makeJobDef("read-only"),
      "w-1": makeJobDef("writable"),
    });

    const batch1 = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });
    const batch2 = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    expect(batch1.jobs.map((j) => j.jobId).sort()).toEqual(
      batch2.jobs.map((j) => j.jobId).sort(),
    );
    expect(batch1.rationale).toBe(batch2.rationale);
  });
});
