/**
 * Job Group State tests for WF-7.2 (Step 1 — Cases and Tests).
 *
 * Covers:
 *   - RepeatConfig resolution (max_iterations default, until passthrough)
 *   - IterationState factory (createIterationState, sealIteration)
 *   - JobGroupState factories (createJobGroupState, createJobGroupStateFromDef,
 *     initializeJobGroups)
 *   - Group iteration lifecycle (startNextIteration, completeCurrentIteration,
 *     finalizeGroup, blockGroup, failGroup)
 *   - createRun integration (initializes job_groups, sets JobState.group)
 *   - 7 new event types in ZigmaFlowEventType
 *   - iteration.previous expression context shape
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.2-job-group/01-cases-and-tests.md
 */

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import type { ZigmaFlowEventType } from "../../src/events/index.js";

// ---------------------------------------------------------------------------
// Helpers and fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-07-15T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/** Minimal valid workflow YAML with job_groups. */
function makeWorkflowYaml(jobGroupsYaml?: string, groupOnJobs?: Record<string, string>): string {
  const groups = jobGroupsYaml ?? "";
  const jobs = Object.entries(groupOnJobs ?? {})
    .map(([name, group]) => `  ${name}:\n    group: ${group}\n    steps:\n      - id: step1\n        type: script\n        run: echo hello`)
    .join("\n");
  return `name: test-wf\nversion: "1.0"\njob_groups:\n${groups}\njobs:\n${jobs || "  default:\n    steps:\n      - id: step1\n        type: script\n        run: echo hello"}`;
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("jobGroupModel pure functions", () => {
  // We test through the exported functions from src/engine/index.ts
  // since jobGroupModel functions are re-exported there.

  it("resolveRepeatConfig defaults max_iterations to 1 when not specified", async () => {
    const { resolveRepeatConfig } = await import("../../src/engine/jobGroupModel.js");
    const result = resolveRepeatConfig(undefined);
    expect(result.max_iterations).toBe(1);
    expect(result.until).toBeUndefined();
  });

  it("resolveRepeatConfig passes through max_iterations and until", async () => {
    const { resolveRepeatConfig } = await import("../../src/engine/jobGroupModel.js");
    const result = resolveRepeatConfig({ max_iterations: 5, until: "${{ condition }}" });
    expect(result.max_iterations).toBe(5);
    expect(result.until).toBe("${{ condition }}");
  });

  it("createIterationState creates an open iteration record", async () => {
    const { createIterationState } = await import("../../src/engine/jobGroupModel.js");
    const iter = createIterationState(1, "2026-01-01T00:00:00.000Z", ["job1", "job2"]);
    expect(iter.index).toBe(1);
    expect(iter.started_at).toBe("2026-01-01T00:00:00.000Z");
    expect(iter.job_ids).toEqual(["job1", "job2"]);
    expect(iter.completed_at).toBeUndefined();
    expect(iter.job_outputs).toBeUndefined();
  });

  it("sealIteration adds completed_at and job_outputs", async () => {
    const { createIterationState, sealIteration } = await import("../../src/engine/jobGroupModel.js");
    const iter = createIterationState(1, "2026-01-01T00:00:00.000Z", ["job1"]);
    const sealed = sealIteration(iter, "2026-01-01T01:00:00.000Z", { job1: { result: "ok" } });
    expect(sealed.index).toBe(1);
    expect(sealed.completed_at).toBe("2026-01-01T01:00:00.000Z");
    expect(sealed.job_outputs).toEqual({ job1: { result: "ok" } });
  });

  it("createJobGroupState initializes with pending status", async () => {
    const { createJobGroupState } = await import("../../src/engine/jobGroupModel.js");
    const gs = createJobGroupState("group1", 3);
    expect(gs.group_id).toBe("group1");
    expect(gs.status).toBe("pending");
    expect(gs.current_iteration).toBe(0);
    expect(gs.iterations).toEqual([]);
    expect(gs.iterations_remaining).toBe(3);
  });

  it("createJobGroupStateFromDef resolves repeat config", async () => {
    const { createJobGroupStateFromDef } = await import("../../src/engine/jobGroupModel.js");
    const gs = createJobGroupStateFromDef("g1", { repeat: { max_iterations: 5 } });
    expect(gs.group_id).toBe("g1");
    expect(gs.iterations_remaining).toBe(5);
  });

  it("initializeJobGroups creates group states from workflow definition", async () => {
    const { initializeJobGroups } = await import("../../src/engine/jobGroupModel.js");
    const groups = initializeJobGroups({
      train: { repeat: { max_iterations: 3 } },
      evaluate: { repeat: { max_iterations: 1 } },
    });
    expect(groups).toBeDefined();
    expect(Object.keys(groups!)).toEqual(["train", "evaluate"]);
    expect(groups!.train!.iterations_remaining).toBe(3);
    expect(groups!.evaluate!.iterations_remaining).toBe(1);
  });

  it("initializeJobGroups returns undefined for empty input", async () => {
    const { initializeJobGroups } = await import("../../src/engine/jobGroupModel.js");
    expect(initializeJobGroups(undefined)).toBeUndefined();
    expect(initializeJobGroups({})).toBeUndefined();
  });

  it("startNextIteration advances group to next iteration", async () => {
    const { createJobGroupState, startNextIteration } = await import("../../src/engine/jobGroupModel.js");
    const gs = createJobGroupState("g1", 3);
    const next = startNextIteration(gs, "2026-01-01T00:00:00.000Z", ["job1"]);
    expect(next.status).toBe("iterating");
    expect(next.current_iteration).toBe(1);
    expect(next.iterations.length).toBe(1);
    expect(next.iterations[0]!.index).toBe(1);
    expect(next.iterations_remaining).toBe(2);
  });

  it("completeCurrentIteration seals iteration and checks max_reached", async () => {
    const { createJobGroupState, startNextIteration, completeCurrentIteration } = await import("../../src/engine/jobGroupModel.js");
    const gs = createJobGroupState("g1", 1);
    const started = startNextIteration(gs, "2026-01-01T00:00:00.000Z", ["job1"]);
    const { group: completed } = completeCurrentIteration(
      started,
      "2026-01-01T01:00:00.000Z",
      { job1: { acc: 0.95 } },
      { max_iterations: 1 },
    );
    expect(completed.status).toBe("completed");
    expect(completed.iterations[0]!.completed_at).toBe("2026-01-01T01:00:00.000Z");
  });

  it("finalizeGroup marks group as completed with 0 remaining", async () => {
    const { createJobGroupState, finalizeGroup } = await import("../../src/engine/jobGroupModel.js");
    const gs = createJobGroupState("g1", 3);
    const finalized = finalizeGroup(gs);
    expect(finalized.status).toBe("completed");
    expect(finalized.iterations_remaining).toBe(0);
  });

  it("blockGroup marks group as blocked", async () => {
    const { createJobGroupState, blockGroup } = await import("../../src/engine/jobGroupModel.js");
    const gs = createJobGroupState("g1", 3);
    const blocked = blockGroup(gs, "upstream failed");
    expect(blocked.status).toBe("blocked");
  });

  it("failGroup marks group as failed", async () => {
    const { createJobGroupState, failGroup } = await import("../../src/engine/jobGroupModel.js");
    const gs = createJobGroupState("g1", 3);
    const failed = failGroup(gs, "error");
    expect(failed.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// createRun integration tests
// ---------------------------------------------------------------------------

describe("createRun integration", () => {
  it("initializes job_groups from workflow definition", async () => {
    const wfYaml = makeWorkflowYaml(
      "  train:\n    repeat:\n      max_iterations: 3\n  eval:\n    repeat:\n      max_iterations: 1",
      { train_job: "train", eval_job: "eval" },
    );

    const tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    const wfPath = join(tmpDir, "wf.yml");
    await writeFile(wfPath, wfYaml, "utf-8");

    const runsDir = join(tmpDir, "runs");
    await mkdir(runsDir, { recursive: true });
    const skillLockPath = join(tmpDir, "skill-lock.json");
    await writeFile(skillLockPath, "{}", "utf-8");

    const clock = new FakeClock();
    const result = await createRun({
      workflowPath: wfPath,
      task: "test",
      runsDir,
      skillLockPath,
      clock,
    });

    // Read state and verify job_groups
    const stateStore = new LocalStateStore();
    const runDir = join(runsDir, result.runId);
    const state = await stateStore.readSnapshot(runDir);
    expect(state).not.toBeNull();
    expect(state!.job_groups).toBeDefined();
    expect(state!.job_groups!.train!.iterations_remaining).toBe(3);
    expect(state!.job_groups!.train!.status).toBe("pending");
    expect(state!.job_groups!.eval!.iterations_remaining).toBe(1);
  });

  it("sets JobState.group from JobDefinition.group", async () => {
    const wfYaml = makeWorkflowYaml(
      "  g1:\n    repeat:\n      max_iterations: 2",
      { job_a: "g1", job_b: "g1" },
    );

    const tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    const wfPath = join(tmpDir, "wf.yml");
    await writeFile(wfPath, wfYaml, "utf-8");

    const runsDir = join(tmpDir, "runs");
    await mkdir(runsDir, { recursive: true });
    const skillLockPath = join(tmpDir, "skill-lock.json");
    await writeFile(skillLockPath, "{}", "utf-8");

    const clock = new FakeClock();
    const result = await createRun({
      workflowPath: wfPath,
      task: "test",
      runsDir,
      skillLockPath,
      clock,
    });

    const stateStore = new LocalStateStore();
    const runDir = join(runsDir, result.runId);
    const state = await stateStore.readSnapshot(runDir);
    expect(state!.jobs!.job_a!.group).toBe("g1");
    expect(state!.jobs!.job_b!.group).toBe("g1");
  });

  it("handles workflow without job_groups (backward compat)", async () => {
    const wfYaml = `name: simple\nversion: "1.0"\njobs:\n  default:\n    steps:\n      - id: s1\n        type: script\n        run: echo hi`;

    const tmpDir = join(tmpdir(), `zigma-test-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });
    const wfPath = join(tmpDir, "wf.yml");
    await writeFile(wfPath, wfYaml, "utf-8");

    const runsDir = join(tmpDir, "runs");
    await mkdir(runsDir, { recursive: true });
    const skillLockPath = join(tmpDir, "skill-lock.json");
    await writeFile(skillLockPath, "{}", "utf-8");

    const clock = new FakeClock();
    const result = await createRun({
      workflowPath: wfPath,
      task: "test",
      runsDir,
      skillLockPath,
      clock,
    });

    const stateStore = new LocalStateStore();
    const runDir = join(runsDir, result.runId);
    const state = await stateStore.readSnapshot(runDir);
    expect(state!).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Event type catalog tests
// ---------------------------------------------------------------------------

describe("ZigmaFlowEventType includes iteration/group event types", () => {
  it("includes the 7 new iteration/group event types", async () => {
    const { EVENT_TYPES } = await import("../../src/events/index.js");
    const allTypes = EVENT_TYPES as readonly string[];
    expect(allTypes).toContain("iteration_started");
    expect(allTypes).toContain("iteration_completed");
    expect(allTypes).toContain("iteration_condition_met");
    expect(allTypes).toContain("iteration_max_reached");
    expect(allTypes).toContain("group_completed");
    expect(allTypes).toContain("group_blocked");
    expect(allTypes).toContain("group_failed");
  });
});

// ---------------------------------------------------------------------------
// Expression context shape tests
// ---------------------------------------------------------------------------

describe("ExpressionContext iteration shape", () => {
  it("supports iteration.previous.jobs.<id>.outputs.<key> in ExpressionContext", async () => {
    // This is a compile-time check: if the type doesn't exist, this won't compile
    const ctx: import("../../src/expression/index.js").ExpressionContext = {
      inputs: {},
      run: { id: "1", workflow: "test" },
      iteration: {
        previous: {
          jobs: {
            train: { outputs: { accuracy: 0.95 } },
          },
        },
      },
    };
    expect(ctx.iteration?.previous?.jobs?.train?.outputs?.accuracy).toBe(0.95);
  });
});
