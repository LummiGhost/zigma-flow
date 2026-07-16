/**
 * Concurrency Group tests for WF-7.3b.
 *
 * Tests the concurrency group filtering in the scheduler and the pre-scheduler
 * mutation policies (cancel_previous, reject).
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/research/r3-concurrency-group.md
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.3-execution-strategy/01-cases-and-tests.md
 */

import { describe, expect, it } from "vitest";

import type {
  ExecutableBatch,
  SchedulerConfig,
  SchedulerInput,
} from "../../src/engine/scheduler.js";
import { selectExecutable } from "../../src/engine/scheduler.js";
import type { JobState, RunState } from "../../src/run/index.js";
import type { ConcurrencyGroupConfig, JobDefinition, WorkflowDefinition } from "../../src/workflow/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SchedulerConfig = {
  parallelism: 4,
  runningWritableLimit: 1,
};

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

function makeJobState(status: JobState["status"]): JobState {
  return { status };
}

function makeJobDef(
  mode?: string,
  concurrency?: ConcurrencyGroupConfig,
): JobDefinition {
  const def: JobDefinition = {
    steps: [{ id: "step-1", type: "agent" }],
  };
  if (mode !== undefined) {
    def.workspace = { mode };
  }
  if (concurrency !== undefined) {
    def.concurrency = concurrency;
  }
  return def;
}

function makeWorkflow(jobs: Record<string, JobDefinition>): WorkflowDefinition {
  return {
    name: "test-workflow",
    version: "1.0",
    jobs,
  };
}

// ---------------------------------------------------------------------------
// CG-QUEUE: Queue policy scheduler filtering
// ---------------------------------------------------------------------------

describe("concurrency group — queue policy (scheduler filter)", () => {
  it("excludes ready queue-policy job when sibling is running in same group (T-CG-QUEUE-1)", () => {
    const state = makeRunState({
      "job-a": makeJobState("running"),
      "job-b": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "deploy", policy: "queue" }),
      "job-b": makeJobDef("read-only", { group: "deploy", policy: "queue" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // job-b should be excluded because job-a (same group "deploy") is running
    const selectedIds = batch.jobs.map((j) => j.jobId);
    expect(selectedIds).not.toContain("job-b");
    expect(batch.jobs).toHaveLength(0);
  });

  it("includes ready queue-policy job when no sibling is running (T-CG-QUEUE-2)", () => {
    const state = makeRunState({
      "job-a": makeJobState("completed"),
      "job-b": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "deploy", policy: "queue" }),
      "job-b": makeJobDef("read-only", { group: "deploy", policy: "queue" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // job-b should be included because no sibling is running
    const selectedIds = batch.jobs.map((j) => j.jobId);
    expect(selectedIds).toContain("job-b");
  });

  it("includes ready queue-policy job in different group from running (T-CG-QUEUE-3)", () => {
    const state = makeRunState({
      "job-a": makeJobState("running"),
      "job-b": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "deploy", policy: "queue" }),
      "job-b": makeJobDef("read-only", { group: "build", policy: "queue" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // job-b is in a different group, so it should be included
    const selectedIds = batch.jobs.map((j) => j.jobId);
    expect(selectedIds).toContain("job-b");
  });

  it("allows multiple queue-policy jobs from different groups to run concurrently (T-CG-QUEUE-4)", () => {
    const state = makeRunState({
      "job-a": makeJobState("ready"),
      "job-b": makeJobState("ready"),
      "job-c": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "group-1", policy: "queue" }),
      "job-b": makeJobDef("read-only", { group: "group-2", policy: "queue" }),
      "job-c": makeJobDef("read-only", { group: "group-3", policy: "queue" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // All jobs are in different groups so all should be selected
    expect(batch.jobs).toHaveLength(3);
  });

  it("excludes only the matching group when multiple groups exist (T-CG-QUEUE-5)", () => {
    const state = makeRunState({
      "job-a": makeJobState("running"),
      "job-b": makeJobState("ready"),
      "job-c": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "deploy", policy: "queue" }),
      "job-b": makeJobDef("read-only", { group: "deploy", policy: "queue" }),
      "job-c": makeJobDef("read-only", { group: "build", policy: "queue" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // job-b (same group as running job-a) should be excluded
    // job-c (different group) should be included
    const selectedIds = batch.jobs.map((j) => j.jobId);
    expect(selectedIds).not.toContain("job-b");
    expect(selectedIds).toContain("job-c");
  });
});

// ---------------------------------------------------------------------------
// CG-ALLOW: Allow policy — no restriction
// ---------------------------------------------------------------------------

describe("concurrency group — allow policy", () => {
  it("includes ready allow-policy job even when sibling is running (T-CG-ALLOW-1)", () => {
    const state = makeRunState({
      "job-a": makeJobState("running"),
      "job-b": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "deploy", policy: "allow" }),
      "job-b": makeJobDef("read-only", { group: "deploy", policy: "allow" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // Allow policy means no restriction — job-b should be included
    const selectedIds = batch.jobs.map((j) => j.jobId);
    expect(selectedIds).toContain("job-b");
  });
});

// ---------------------------------------------------------------------------
// CG-NO-CONCURRENCY: Jobs without concurrency config pass through unchanged
// ---------------------------------------------------------------------------

describe("concurrency group — no config (backward compat)", () => {
  it("includes ready jobs without concurrency config when sibling has config (T-CG-NOCONF-1)", () => {
    const state = makeRunState({
      "job-a": makeJobState("running"),
      "job-b": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "deploy", policy: "queue" }),
      "job-b": makeJobDef("read-only"), // no concurrency config
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // job-b has no concurrency config, so it passes through unchanged
    const selectedIds = batch.jobs.map((j) => j.jobId);
    expect(selectedIds).toContain("job-b");
  });

  it("all jobs without concurrency config are unaffected (T-CG-NOCONF-2)", () => {
    const state = makeRunState({
      "job-a": makeJobState("ready"),
      "job-b": makeJobState("ready"),
      "job-c": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only"),
      "job-b": makeJobDef("writable"),
      "job-c": makeJobDef("read-only"),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // No concurrency config — normal scheduler behavior
    expect(batch.jobs.length).toBeGreaterThan(0);
    expect(batch.jobs.every((j) => j.mode === "read-only" || j.mode === "writable")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CG-CANCEL-PREVIOUS: Pre-scheduler mutation policy (pure function test)
// Note: The cancel_previous mutation is performed in runAll, not in the scheduler.
// These tests verify the scheduler's behavior after mutations are applied.
// ---------------------------------------------------------------------------

describe("concurrency group — cancel_previous (scheduler perspective)", () => {
  it("treats cancel_previous ready job as allow when no sibling is running (T-CG-CP-1)", () => {
    // After cancel_previous mutation in runAll, the running sibling is cancelled.
    // The scheduler should then allow the ready job.
    const state = makeRunState({
      "job-a": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "deploy", policy: "cancel_previous" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // No running sibling — job-a is included
    const selectedIds = batch.jobs.map((j) => j.jobId);
    expect(selectedIds).toContain("job-a");
  });
});

// ---------------------------------------------------------------------------
// CG-REJECT: Pre-scheduler mutation policy (pure function test)
// ---------------------------------------------------------------------------

describe("concurrency group — reject (scheduler perspective)", () => {
  it("treats reject-policy ready job as allow when no sibling is running (T-CG-REJ-1)", () => {
    // After reject mutation in runAll, the ready job would have been failed.
    // But from scheduler perspective, if no sibling running, it's just allowed.
    const state = makeRunState({
      "job-a": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "deploy", policy: "reject" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // No running sibling — job-a is included
    const selectedIds = batch.jobs.map((j) => j.jobId);
    expect(selectedIds).toContain("job-a");
  });
});

// ---------------------------------------------------------------------------
// CG-PARALLELISM-INTERACTION: Concurrency groups + parallelism
// ---------------------------------------------------------------------------

describe("concurrency group — parallelism interaction", () => {
  it("applies parallelism cap first, then concurrency group filter (T-CG-PAR-1)", () => {
    const state = makeRunState({
      "job-a": makeJobState("ready"),
      "job-b": makeJobState("ready"),
      "job-c": makeJobState("ready"),
      "job-d": makeJobState("ready"),
      "job-e": makeJobState("ready"),
      "job-f": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "job-a": makeJobDef("read-only", { group: "g1", policy: "queue" }),
      "job-b": makeJobDef("read-only", { group: "g2", policy: "queue" }),
      "job-c": makeJobDef("read-only", { group: "g3", policy: "queue" }),
      "job-d": makeJobDef("read-only", { group: "g4", policy: "queue" }),
      "job-e": makeJobDef("read-only", { group: "g5", policy: "queue" }),
      "job-f": makeJobDef("read-only", { group: "g6", policy: "queue" }),
    });
    const config: SchedulerConfig = { parallelism: 3, runningWritableLimit: 1 };

    const batch = selectExecutable({ state, workflow: wf, config });

    // parallelism=3, all ready, all in different groups — only 3 selected
    expect(batch.jobs).toHaveLength(3);
  });

  it("running jobs with concurrency group consume parallelism slots (T-CG-PAR-2)", () => {
    const state = makeRunState({
      "running-a": makeJobState("running"),
      "ready-a": makeJobState("ready"),
      "ready-b": makeJobState("ready"),
    });
    const wf = makeWorkflow({
      "running-a": makeJobDef("read-only", { group: "g1", policy: "queue" }),
      "ready-a": makeJobDef("read-only", { group: "g2", policy: "queue" }),
      "ready-b": makeJobDef("read-only", { group: "g3", policy: "queue" }),
    });

    const batch = selectExecutable({ state, workflow: wf, config: DEFAULT_CONFIG });

    // parallelism=4, 1 running (consumes 1 slot), 2 ready in different groups = 2 selected
    // both ready jobs are in different groups from running-a, so both pass through
    expect(batch.jobs).toHaveLength(2);
  });
});
