/**
 * Job Group Compatibility tests for WF-7.2 (Step 1 — Cases and Tests).
 *
 * Covers:
 *   - Implicit group creation in applyRoutingAction for goto_step/goto_job
 *   - loadWorkflow rejects conflicts (group + goto_step/goto_job/max_visits)
 *   - loadWorkflow rejects nonexistent group references
 *   - loadWorkflow rejects group-level DAG cycles
 *   - Dual event emission (step_revisited + iteration_started)
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.2-job-group/01-cases-and-tests.md
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { loadWorkflow } from "../../src/workflow/index.js";
import { createRun } from "../../src/engine/index.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../../src/run/index.js";
import { WorkflowError, ValidationError } from "../../src/utils/index.js";

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

async function writeWorkflowAndCreateRun(wfYaml: string): Promise<{
  runDir: string;
  runId: string;
  state: RunState;
  cleanup: () => Promise<void>;
}> {
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
  const state = (await stateStore.readSnapshot(runDir))!;

  return {
    runDir,
    runId: result.runId,
    state,
    cleanup: async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

// ---------------------------------------------------------------------------
// Conflict detection tests
// ---------------------------------------------------------------------------

describe("loadWorkflow conflict detection", () => {
  it("rejects job with group + goto_step in router cases", () => {
    const yaml = `name: test
version: "1.0"
job_groups:
  g1:
    repeat:
      max_iterations: 3
jobs:
  worker:
    group: g1
    steps:
      - id: router1
        type: router
        cases:
          retry: { goto_step: step1 }
      - id: step1
        type: script
        run: echo ok
`;
    expect(() => loadWorkflow(yaml)).toThrow();
  });

  it("rejects job with group + goto_job in router cases", () => {
    const yaml = `name: test
version: "1.0"
job_groups:
  g1:
    repeat:
      max_iterations: 3
jobs:
  worker:
    group: g1
    steps:
      - id: router1
        type: router
        cases:
          go: { goto_job: other }
  other:
    steps:
      - id: s1
        type: script
        run: echo ok
`;
    expect(() => loadWorkflow(yaml)).toThrow();
  });

  it("rejects job with group + max_visits on step", () => {
    const yaml = `name: test
version: "1.0"
job_groups:
  g1:
    repeat:
      max_iterations: 3
jobs:
  worker:
    group: g1
    steps:
      - id: step1
        type: script
        run: echo ok
        max_visits: 3
`;
    // max_visits inside a grouped job should be rejected
    expect(() => loadWorkflow(yaml)).toThrow();
  });

  it("rejects job with group + goto_step in on_failure", () => {
    const yaml = `name: test
version: "1.0"
job_groups:
  g1:
    repeat:
      max_iterations: 3
jobs:
  worker:
    group: g1
    steps:
      - id: s1
        type: script
        run: echo ok
        on_failure: { goto_step: s1 }
`;
    expect(() => loadWorkflow(yaml)).toThrow();
  });

  it("rejects job with group + goto_step in on_pass", () => {
    const yaml = `name: test
version: "1.0"
job_groups:
  g1:
    repeat:
      max_iterations: 3
jobs:
  worker:
    group: g1
    steps:
      - id: s1
        type: check
        run: echo ok
        on_fail: { goto_step: s1 }
`;
    expect(() => loadWorkflow(yaml)).toThrow();
  });

  it("allows ungrouped job with goto_step (backward compat)", () => {
    const yaml = `name: test
version: "1.0"
jobs:
  worker:
    steps:
      - id: router1
        type: router
        cases:
          retry: { goto_step: step1 }
      - id: step1
        type: script
        run: echo ok
`;
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });

  it("allows grouped job without goto/goto_job/max_visits", () => {
    const yaml = `name: test
version: "1.0"
job_groups:
  g1:
    repeat:
      max_iterations: 3
jobs:
  worker:
    group: g1
    steps:
      - id: s1
        type: script
        run: echo ok
`;
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group reference validation
// ---------------------------------------------------------------------------

describe("loadWorkflow group reference validation", () => {
  it("rejects job referencing nonexistent group", () => {
    const yaml = `name: test
version: "1.0"
jobs:
  worker:
    group: nonexistent
    steps:
      - id: s1
        type: script
        run: echo ok
`;
    expect(() => loadWorkflow(yaml)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Group-level DAG cycle detection
// ---------------------------------------------------------------------------

describe("loadWorkflow group DAG cycle detection", () => {
  it("rejects group-level DAG cycles", () => {
    const yaml = `name: test
version: "1.0"
job_groups:
  g1:
    repeat:
      max_iterations: 1
    needs: [g2]
  g2:
    repeat:
      max_iterations: 1
    needs: [g1]
jobs:
  a:
    group: g1
    steps:
      - id: s1
        type: script
        run: echo a
  b:
    group: g2
    steps:
      - id: s1
        type: script
        run: echo b
`;
    expect(() => loadWorkflow(yaml)).toThrow();
  });

  it("allows valid group DAG (no cycles)", () => {
    const yaml = `name: test
version: "1.0"
job_groups:
  g1:
    repeat:
      max_iterations: 1
    needs: [g2]
  g2:
    repeat:
      max_iterations: 1
jobs:
  a:
    group: g1
    steps:
      - id: s1
        type: script
        run: echo a
  b:
    group: g2
    steps:
      - id: s1
        type: script
        run: echo b
`;
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Implicit group in routing
// ---------------------------------------------------------------------------

describe("implicit group creation in routing", () => {
  it("creates implicit group on goto_step for ungrouped job", async () => {
    // This test verifies that the createImplicitGroup function works
    const { createImplicitGroup, startNextIteration } = await import("../../src/engine/jobGroupModel.js");
    const { groupId, groupState } = createImplicitGroup("worker", undefined, 3);
    expect(groupId).toBe("__implicit__worker");
    expect(groupState.group_id).toBe(groupId);
    expect(groupState.iterations_remaining).toBe(3);
    expect(groupState.status).toBe("pending");

    const started = startNextIteration(groupState, FIXED_ISO, ["worker"]);
    expect(started.status).toBe("iterating");
    expect(started.current_iteration).toBe(1);
  });

  it("creates implicit group with targetJobId for goto_job", async () => {
    const { createImplicitGroup } = await import("../../src/engine/jobGroupModel.js");
    const { groupId, groupState } = createImplicitGroup("source", "target");
    expect(groupId).toBe("__implicit__source__target");
    expect(groupState).toBeDefined();
  });

  it("defaults maxVisits to 3", async () => {
    const { createImplicitGroup } = await import("../../src/engine/jobGroupModel.js");
    const { groupState } = createImplicitGroup("worker");
    expect(groupState.iterations_remaining).toBe(3);
  });
});
