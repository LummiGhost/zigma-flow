/**
 * Expression-resolution integration tests for `executeRouterStep`.
 *
 * WF-V022-HUMANGATE Step 2 — confirms that a router `switch` field containing
 * a `${{ ... }}` template is resolved against the current run state before the
 * case lookup is performed.
 *
 * Covers:
 *   - T-ROUTER-EXPR-1: switch "${{ steps.gate-merge.outputs.decision }}" resolves
 *     to "approved" when job outputs contain decision="approved", and the router
 *     selects the "approved" → continue case; job reaches "completed".
 *   - T-ROUTER-EXPR-2: switch resolves to "rejected", selects the "rejected" → fail
 *     case; job reaches "failed".
 *   - T-ROUTER-EXPR-3: literal switch value ("approved") continues to work unchanged
 *     — resolveExpression is a no-op when no ${{ }} tokens are present.
 *
 * Reference:
 *   - docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-humangate/
 *   - src/router/executor.ts §2b "Resolve switch expression"
 *   - src/expression/index.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { executeRouterStep } from "../../src/router/executor.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-07-01T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-router-expr-${randomUUID()}`);
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

  return {
    projectRoot,
    zigmaflowDir: projectRoot,
    dotZigma,
    runsDir,
    skillLockPath,
  };
}

/**
 * Bootstrap a run from a YAML fixture and return the runId + runDir.
 * Mirrors the pattern used in tests/router/executor.test.ts.
 */
async function bootstrapRun(
  sandbox: Sandbox,
  yamlBody: string
): Promise<{ runId: string; runDir: string }> {
  const workflowPath = join(sandbox.projectRoot, "workflow.yml");
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: "router expression resolution test",
    runsDir: sandbox.runsDir,
    skillLockPath: sandbox.skillLockPath,
    clock: new FakeClock(),
  });
  const runDir = join(sandbox.runsDir, runId);
  return { runId, runDir };
}

/**
 * Inject outputs into `state.jobs[jobId].outputs` and set `current_step` to
 * the router step so that `executeRouterStep` picks it up. This simulates
 * what a human gate (or script step) would have persisted prior to the router
 * running.
 */
async function injectJobOutputsAndAdvanceToRouterStep(
  runDir: string,
  jobId: string,
  routerStepId: string,
  outputs: Record<string, unknown>
): Promise<void> {
  const stateStore = new LocalStateStore();
  await stateStore.updateState(runDir, (current: RunState): RunState => {
    return {
      ...current,
      jobs: {
        ...current.jobs,
        [jobId]: {
          ...current.jobs[jobId]!,
          current_step: routerStepId,
          outputs,
        },
      },
    };
  });
}

/**
 * Read events.jsonl as an array of parsed event objects.
 */
async function readEvents(runDir: string): Promise<Array<{ id: string; type: string; payload: Record<string, unknown> }>> {
  const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { id: string; type: string; payload: Record<string, unknown> });
}

/**
 * Read state.json and return the job status for a given jobId.
 */
async function readJobStatus(runDir: string, jobId: string): Promise<string> {
  const text = await readFile(join(runDir, "state.json"), "utf-8");
  const state = JSON.parse(text) as { jobs: Record<string, { status: string }> };
  return state.jobs[jobId]?.status ?? "unknown";
}

// ---------------------------------------------------------------------------
// Workflow YAML fixtures
// ---------------------------------------------------------------------------

/**
 * Two-step workflow: human gate step (id: gate-merge) followed by a router
 * that switches on the expression template. The human gate step itself is
 * not driven here — we inject the outputs directly into state to isolate
 * the expression-resolution path.
 */
const ROUTER_EXPR_WORKFLOW_YAML = `\
name: expr-router-test
version: "0.1.0"
jobs:
  review-merge:
    steps:
      - id: gate-merge
        type: human
        prompt: "Approve the merge?"
      - id: route-decision
        type: router
        switch: "\${{ steps.gate-merge.outputs.decision }}"
        cases:
          approved: continue
          rejected: fail
`;

/** Single-step workflow with a literal switch value — no ${{ }} tokens. */
const ROUTER_LITERAL_SWITCH_YAML = `\
name: literal-switch-test
version: "0.1.0"
jobs:
  review:
    steps:
      - id: route-decision
        type: router
        switch: approved
        cases:
          approved: continue
`;

// ---------------------------------------------------------------------------
// T-ROUTER-EXPR-1: expression resolves to "approved" → job completed
// ---------------------------------------------------------------------------

describe("executeRouterStep — expression switch resolves to 'approved' (T-ROUTER-EXPR-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "resolves ${{ steps.gate-merge.outputs.decision }} from job outputs and selects the 'approved' → continue case, completing the job",
    async () => {
      const { runId, runDir } = await bootstrapRun(sandbox, ROUTER_EXPR_WORKFLOW_YAML);

      // Simulate: a prior human gate step wrote decision="approved" to job outputs
      await injectJobOutputsAndAdvanceToRouterStep(runDir, "review-merge", "route-decision", {
        decision: "approved",
        comment: "Ship it",
      });

      await executeRouterStep({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review-merge",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      // (a) Full success event sequence present in order
      const stepStartedIdx = types.indexOf("step_started");
      const routerDecidedIdx = types.indexOf("router_decided");
      const stepCompletedIdx = types.indexOf("step_completed");
      const jobCompletedIdx = types.indexOf("job_completed");

      expect(stepStartedIdx).toBeGreaterThanOrEqual(0);
      expect(routerDecidedIdx).toBeGreaterThan(stepStartedIdx);
      expect(stepCompletedIdx).toBeGreaterThan(routerDecidedIdx);
      expect(jobCompletedIdx).toBeGreaterThan(stepCompletedIdx);

      // (b) router_decided.payload.action === "continue"
      const routerDecidedEvent = events[routerDecidedIdx]!;
      expect(routerDecidedEvent.payload["action"]).toBe("continue");

      // (c) job status transitions to "completed"
      const jobStatus = await readJobStatus(runDir, "review-merge");
      expect(jobStatus).toBe("completed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-EXPR-2: expression resolves to "rejected" → job failed
// ---------------------------------------------------------------------------

describe("executeRouterStep — expression switch resolves to 'rejected' (T-ROUTER-EXPR-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "resolves ${{ steps.gate-merge.outputs.decision }} from job outputs and selects the 'rejected' → fail case, failing the job",
    async () => {
      const { runId, runDir } = await bootstrapRun(sandbox, ROUTER_EXPR_WORKFLOW_YAML);

      // Simulate: human gate wrote decision="rejected"
      await injectJobOutputsAndAdvanceToRouterStep(runDir, "review-merge", "route-decision", {
        decision: "rejected",
        comment: "Needs more tests",
      });

      await executeRouterStep({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review-merge",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      // (a) event sequence: step_started, router_decided, step_failed
      expect(types).toContain("step_started");
      expect(types).toContain("router_decided");
      expect(types).toContain("step_failed");
      expect(types).not.toContain("step_completed");
      expect(types).not.toContain("job_completed");

      // (b) router_decided.payload.action === "fail"
      const routerDecidedEvent = events.find((e) => e.type === "router_decided")!;
      expect(routerDecidedEvent.payload["action"]).toBe("fail");

      // (c) job status transitions to "failed"
      const jobStatus = await readJobStatus(runDir, "review-merge");
      expect(jobStatus).toBe("failed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-ROUTER-EXPR-3: literal switch value (no ${{ }}) continues to work
// ---------------------------------------------------------------------------

describe("executeRouterStep — literal switch value unchanged (T-ROUTER-EXPR-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "literal switch value 'approved' with no template tokens matches the 'approved' case and completes the job",
    async () => {
      const { runId, runDir } = await bootstrapRun(sandbox, ROUTER_LITERAL_SWITCH_YAML);

      await executeRouterStep({
        runDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        runId,
        jobId: "review",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      expect(types).toContain("router_decided");
      const routerDecidedEvent = events.find((e) => e.type === "router_decided")!;
      expect(routerDecidedEvent.payload["action"]).toBe("continue");

      const jobStatus = await readJobStatus(runDir, "review");
      expect(jobStatus).toBe("completed");
    }
  );
});
