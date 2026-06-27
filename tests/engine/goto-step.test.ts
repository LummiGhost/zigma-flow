/**
 * `goto_step` routing action tests for WF-P13-FLOW (Step 1 — Cases and Tests).
 *
 * These tests exercise the `goto_step` branch of `applyRoutingAction`, which
 * handles intra-job step redirection from a router's case mapping.
 *
 * Contract:
 *   - `goto_step` target must exist in the same job as the router step.
 *   - On success: emits `step_revisited` event, increments visit count,
 *     sets current_step to the target step.
 *   - `goto_with` payload is stored as `retry_inputs` on the target job state.
 *   - Attempt number is preserved (step-level redirection, not job-level retry).
 *
 * Covers:
 *   - FR-GOTO-001: goto_step to valid target → target pending, current_step updated
 *   - FR-GOTO-002: Visit count incremented on each goto_step to same target
 *   - FR-GOTO-003: step_revisited event has correct payload
 *   - FR-GOTO-004: goto_step to non-existent target → WorkflowError
 *   - FR-GOTO-005: goto_step across jobs → WorkflowError
 *   - FR-GOTO-006: goto_step with goto_with → retry_inputs populated
 *   - FR-GOTO-007: goto_step preserves source job attempt number
 *
 * Red-phase note: The `goto_step` action is not yet handled in
 * `applyRoutingAction`. Passing `{ goto_step: "target" }` as the action
 * will fall through silently (no state change, no error). Tests asserting
 * state changes or errors will be RED until Step 2 adds the `goto_step` branch.
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-flow/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-012
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { applyRoutingAction } from "../../src/engine/routing.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import type { RouterAction } from "../../src/workflow/index.js";
import { WorkflowError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-28T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

/**
 * Workflow: two agent steps + a router that can goto_step back to step 1.
 */
const GOTO_STEP_YAML = `\
name: goto-step-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: gather-context
        type: agent
        uses: zigma/skill
      - id: route-plan
        type: router
        switch: "dummy"
        cases:
          incomplete: continue
          ready: continue
      - id: finalize
        type: agent
        uses: zigma/skill
`;

/**
 * Workflow: two jobs, for testing cross-job goto_step rejection.
 */
const CROSS_JOB_YAML = `\
name: cross-job-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: route-plan
        type: router
        switch: "dummy"
        cases:
          incomplete: continue
          ready: continue
  other:
    steps:
      - id: other-step
        type: agent
        uses: zigma/skill
`;

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-goto-step-${randomUUID()}`);
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
  await writeFile(
    skillLockPath,
    JSON.stringify({ skills: {} }, null, 2),
    "utf-8"
  );

  return { projectRoot, runsDir, skillLockPath };
}

async function bootstrapRun(
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

// ---------------------------------------------------------------------------
// Event and state readers
// ---------------------------------------------------------------------------

interface EventRecord {
  id: string;
  type: string;
  run_id: string;
  job: string | null;
  step: string | null;
  attempt: number | null;
  payload: Record<string, unknown>;
}

async function readEvents(runDir: string): Promise<EventRecord[]> {
  const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EventRecord);
}

async function readStateSnapshot(runDir: string): Promise<RunState> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  return snap;
}

// ---------------------------------------------------------------------------
// State manipulation helpers
// ---------------------------------------------------------------------------

async function setJobState(
  runDir: string,
  jobId: string,
  patch: Partial<Pick<JobState, "status" | "attempt" | "current_step">> & {
    step_visits?: Record<string, number>;
  }
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);

  const existing = snap.jobs[jobId];
  if (existing === undefined) throw new Error(`job ${jobId} not found`);

  const merged = { ...existing };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step !== undefined) merged.current_step = patch.current_step;
  if (patch.step_visits !== undefined) {
    (merged as Record<string, unknown>)["step_visits"] = patch.step_visits;
  }

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

// ---------------------------------------------------------------------------
// FR-GOTO-001: goto_step to valid target → target step pending
// ---------------------------------------------------------------------------

describe("goto_step — valid target (FR-GOTO-001)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "redirects to target step, sets current_step, emits step_revisited (FR-GOTO-001, UC-FLOW-002)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        GOTO_STEP_YAML,
        "goto-step"
      );

      // Put job in running state with route-plan as current step
      await setJobState(runDir, "main", {
        status: "running",
        current_step: "route-plan",
        attempt: 1,
      });

      // Call applyRoutingAction with goto_step.
      // Using type assertion because goto_step is not yet in the RouterAction type.
      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "main",
        sourceStepId: "route-plan",
        attempt: 1,
        action: { goto_step: "gather-context" } as unknown as RouterAction,
        reason: "router decided incomplete",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const jobState = state.jobs["main"]!;

      // In Step 1: RED — current_step unchanged (goto_step not handled).
      // In Step 2: GREEN — current_step set to "gather-context".
      expect(jobState.current_step).toBe("gather-context");
    }
  );
});

// ---------------------------------------------------------------------------
// FR-GOTO-002: Visit count incremented on each goto_step
// ---------------------------------------------------------------------------

describe("goto_step — visit count increment (FR-GOTO-002)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "increments step_visits for target step on each goto_step (FR-GOTO-002)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        GOTO_STEP_YAML,
        "goto-step-visits"
      );

      // Initial state: running, step_visits empty
      await setJobState(runDir, "main", {
        status: "running",
        current_step: "route-plan",
        attempt: 1,
        step_visits: {},
      });

      // First goto_step
      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "main",
        sourceStepId: "route-plan",
        attempt: 1,
        action: { goto_step: "gather-context" } as unknown as RouterAction,
        reason: "loop iteration 1",
        clock: new FakeClock(),
      });

      // Set current_step back to route-plan to simulate second goto
      await setJobState(runDir, "main", {
        current_step: "route-plan",
      });

      // Second goto_step
      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "main",
        sourceStepId: "route-plan",
        attempt: 1,
        action: { goto_step: "gather-context" } as unknown as RouterAction,
        reason: "loop iteration 2",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const js = state.jobs["main"]! as unknown as {
        step_visits?: Record<string, number>;
      };
      const visits = js.step_visits ?? {};

      // In Step 1: RED — step_visits unchanged (no goto_step handling).
      // In Step 2: GREEN — step_visits["gather-context"] === 2.
      expect(visits["gather-context"]).toBe(2);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-GOTO-003: step_revisited event payload
// ---------------------------------------------------------------------------

describe("goto_step — step_revisited event (FR-GOTO-003)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits step_revisited event with correct payload (FR-GOTO-003)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        GOTO_STEP_YAML,
        "goto-step-event"
      );

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "route-plan",
        attempt: 1,
        step_visits: { "gather-context": 0 },
      });

      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "main",
        sourceStepId: "route-plan",
        attempt: 1,
        action: { goto_step: "gather-context" } as unknown as RouterAction,
        reason: "router decided",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const revisitedEvent = events.find((e) => e.type === "step_revisited");

      // In Step 1: RED — no step_revisited event emitted.
      // In Step 2: GREEN — event present with correct payload.
      expect(revisitedEvent).toBeDefined();
      if (revisitedEvent) {
        expect(revisitedEvent.payload.target_step).toBe("gather-context");
        expect(typeof revisitedEvent.payload.visit_count).toBe("number");
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-GOTO-004: goto_step to non-existent target → WorkflowError
// ---------------------------------------------------------------------------

describe("goto_step — non-existent target (FR-GOTO-004)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws WorkflowError when goto_step target does not exist (FR-GOTO-004)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        GOTO_STEP_YAML,
        "goto-step-nonexistent"
      );

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "route-plan",
        attempt: 1,
      });

      // In Step 1: RED — falls through silently, no error thrown.
      // In Step 2: GREEN — validates target exists, throws WorkflowError.
      let thrown: unknown;
      try {
        await applyRoutingAction({
          runDir,
          runId,
          sourceJobId: "main",
          sourceStepId: "route-plan",
          attempt: 1,
          action: { goto_step: "non-existent-step" } as unknown as RouterAction,
          reason: "bad target",
          clock: new FakeClock(),
        });
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect(thrown).toBeInstanceOf(WorkflowError);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-GOTO-005: goto_step across jobs → WorkflowError
// ---------------------------------------------------------------------------

describe("goto_step — cross-job target (FR-GOTO-005)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws WorkflowError when goto_step targets a step in a different job (FR-GOTO-005)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        CROSS_JOB_YAML,
        "goto-step-cross-job"
      );

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "route-plan",
        attempt: 1,
      });

      // In Step 1: RED — falls through silently.
      // In Step 2: GREEN — validates same-job constraint, throws WorkflowError.
      let thrown: unknown;
      try {
        await applyRoutingAction({
          runDir,
          runId,
          sourceJobId: "main",
          sourceStepId: "route-plan",
          attempt: 1,
          action: { goto_step: "other-step" } as unknown as RouterAction,
          reason: "cross-job goto_step",
          clock: new FakeClock(),
        });
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect(thrown).toBeInstanceOf(WorkflowError);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-GOTO-006: goto_step with goto_with → retry_inputs populated
// ---------------------------------------------------------------------------

describe("goto_step — goto_with payload (FR-GOTO-006)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "stores goto_with payload as retry_inputs on target job state (FR-GOTO-006)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        GOTO_STEP_YAML,
        "goto-step-with-payload"
      );

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "route-plan",
        attempt: 1,
      });

      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "main",
        sourceStepId: "route-plan",
        attempt: 1,
        action: {
          goto_step: "gather-context",
          goto_with: { key1: "val1", key2: "val2" },
        } as unknown as RouterAction,
        reason: "with payload",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const js = state.jobs["main"]! as unknown as {
        retry_inputs?: Record<string, string>;
      };

      // In Step 1: RED — retry_inputs not set (goto_step not handled).
      // In Step 2: GREEN — retry_inputs populated from goto_with.
      expect(js.retry_inputs).toBeDefined();
      expect(js.retry_inputs).toEqual({ key1: "val1", key2: "val2" });
    }
  );
});

// ---------------------------------------------------------------------------
// FR-GOTO-007: goto_step preserves source job attempt number
// ---------------------------------------------------------------------------

describe("goto_step — preserves attempt number (FR-GOTO-007)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "preserves job attempt number after goto_step (FR-GOTO-007)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        GOTO_STEP_YAML,
        "goto-step-attempt"
      );

      await setJobState(runDir, "main", {
        status: "running",
        current_step: "route-plan",
        attempt: 2,
      });

      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: "main",
        sourceStepId: "route-plan",
        attempt: 2,
        action: { goto_step: "gather-context" } as unknown as RouterAction,
        reason: "preserve attempt",
        clock: new FakeClock(),
      });

      const state = await readStateSnapshot(runDir);
      const jobState = state.jobs["main"]!;

      // In Step 1: RED — attempt may not be preserved (goto_step not handled).
      // In Step 2: GREEN — attempt remains 2 (step redirection, not job retry).
      expect(jobState.attempt).toBe(2);
    }
  );
});
