/**
 * Human gate → router integration tests for WF-V022-HUMANGATE (Step 1 — red/amber).
 *
 * Purpose:
 *   Lock down the semantic contract between `recordHumanDecision` and a downstream
 *   router that switches on `${{ steps.<human-step-id>.outputs.decision }}` /
 *   `.comment`. AD-P15-006 stipulates that once the human step writes its
 *   `decision` and `comment` outputs, the next router should be able to resolve
 *   those expressions through the standard workflow expression evaluator.
 *
 * Scope for these tests:
 *   - Verify that after `enterHumanGate` + `recordHumanDecision(approved)`, the
 *     recorded outputs are visible to `resolveExpression` when the caller builds
 *     an ExpressionContext from state.jobs[jobId].outputs (the same lookup
 *     surface a router-switch expression consumes).
 *   - Verify that on `recordHumanDecision(rejected)` the outputs include
 *     `decision: "rejected"` and `comment` verbatim, and the job transitions
 *     to `failed` (matching the AD-P15-005 "reject without router" path).
 *   - Confirm the outputs are also queryable as `${{ jobs.<id>.outputs.<key> }}`
 *     via the existing expression resolver (already TD-P9-001 in P13).
 *
 * Red-phase note:
 *   - `recordHumanDecision` already writes outputs to `state.jobs[jobId].outputs`.
 *     The router in `src/router/executor.ts` reads `stepDef.switch` verbatim; it
 *     does NOT itself call `resolveExpression` today. These tests intentionally
 *     use `resolveExpression` directly with a context built from state to model
 *     the semantic contract a router-switch expression would exercise once that
 *     wiring exists. The bridging work is tracked separately; this file locks
 *     down the *readability* half of the contract regardless of when the router
 *     starts resolving expressions.
 *
 * Reference:
 *   - docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-humangate/01-cases-and-tests.md
 *   - docs/phases/p15-human-gate/02-development-plan.md AD-P15-005, AD-P15-006
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { enterHumanGate, recordHumanDecision } from "../../src/engine/humanGate.js";
import { resolveExpression } from "../../src/expression/index.js";
import type { ExpressionContext } from "../../src/expression/index.js";
import type { Clock } from "../../src/run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-07-01T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

/**
 * Minimal 2-step workflow:
 *   step 1: human gate `gate-merge`
 *   step 2: router that switches on `${{ steps.gate-merge.outputs.decision }}`
 *
 * The router literal here documents the intended DSL usage. Runtime
 * expression-resolution inside the router executor is a separate concern
 * (see red-phase note at the top of this file).
 */
const HUMAN_ROUTER_YAML = `\
name: human-router-test
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

interface TempRun {
  rootDir: string;
  workflowPath: string;
  runDir: string;
  runId: string;
  clock: FakeClock;
}

async function setupTempRun(): Promise<TempRun> {
  const rootDir = join(tmpdir(), `zigma-humangate-router-${randomUUID()}`);
  const runsDir = join(rootDir, ".zigma-flow", "runs");
  const workflowDir = join(rootDir, "workflows");
  await mkdir(workflowDir, { recursive: true });

  const workflowPath = join(workflowDir, "human-router.yml");
  await writeFile(workflowPath, HUMAN_ROUTER_YAML, "utf-8");

  const skillLockPath = join(rootDir, ".zigma-flow", "skill-lock.json");
  await mkdir(join(rootDir, ".zigma-flow"), { recursive: true });
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }), "utf-8");

  const configPath = join(rootDir, ".zigma-flow", "config.json");
  await writeFile(configPath, JSON.stringify({ active_run: null }), "utf-8");

  const clock = new FakeClock();
  const { runId } = await createRun({
    workflowPath,
    task: "human gate → router integration",
    runsDir,
    skillLockPath,
    clock,
  });

  return { rootDir, workflowPath, runDir: join(runsDir, runId), runId, clock };
}

async function cleanupTempRun(t: TempRun): Promise<void> {
  await rm(t.rootDir, { recursive: true, force: true });
}

/**
 * Build an ExpressionContext that a downstream router-switch expression would
 * see. Maps `state.jobs[jobId].outputs` under `steps[stepId].outputs` because
 * per-step outputs are persisted at the job level (see humanGate.ts line ~288),
 * which is the persistence surface a router expression must ultimately read.
 */
function buildRouterExprCtx(args: {
  runId: string;
  workflowName: string;
  stepId: string;
  outputs: Record<string, unknown>;
}): ExpressionContext {
  return {
    inputs: {},
    run: { id: args.runId, workflow: args.workflowName },
    steps: {
      [args.stepId]: { outputs: args.outputs },
    },
    jobs: {
      "review-merge": { outputs: args.outputs },
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario A — approve → router sees decision="approved"
// ---------------------------------------------------------------------------

describe("human gate → router integration: approve path", () => {
  let t: TempRun;

  beforeEach(async () => {
    t = await setupTempRun();
  });

  afterEach(async () => {
    await cleanupTempRun(t);
  });

  it("after approve, state.jobs.<job>.outputs contains decision=\"approved\"", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "review-merge",
      stepId: "gate-merge",
      clock: t.clock,
      stepPrompt: "Approve the merge?",
      stateStore,
      eventWriter,
    });

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "review-merge",
      stepId: "gate-merge",
      decision: "approved",
      comment: "Ship it",
      decidedBy: "alice",
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const state = await stateStore.readSnapshot(t.runDir);
    expect(state).not.toBeNull();
    const job = state!.jobs["review-merge"]!;

    expect(job.outputs).toMatchObject({
      decision: "approved",
      comment: "Ship it",
    });
  });

  it("a router switch expression resolves ${{ steps.gate-merge.outputs.decision }} to \"approved\"", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "review-merge",
      stepId: "gate-merge",
      clock: t.clock,
      stepPrompt: "Approve the merge?",
      stateStore,
      eventWriter,
    });

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "review-merge",
      stepId: "gate-merge",
      decision: "approved",
      comment: "Ship it",
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const state = await stateStore.readSnapshot(t.runDir);
    const outputs = state!.jobs["review-merge"]!.outputs ?? {};

    const ctx = buildRouterExprCtx({
      runId: t.runId,
      workflowName: "human-router-test",
      stepId: "gate-merge",
      outputs,
    });

    const switchResolved = resolveExpression(
      "${{ steps.gate-merge.outputs.decision }}",
      ctx,
    );
    expect(switchResolved).toBe("approved");

    // Router "continue" branch is selected by matching resolved switch against
    // the case key "approved". We don't invoke executeRouterStep here (it does
    // not currently expand ${{ }}); the semantic requirement is that the DSL
    // author's expression, given the persisted state, would evaluate to the
    // expected case key.
    expect(switchResolved).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// Scenario B — reject → outputs carry rejection comment, job failed
// ---------------------------------------------------------------------------

describe("human gate → router integration: reject path", () => {
  let t: TempRun;

  beforeEach(async () => {
    t = await setupTempRun();
  });

  afterEach(async () => {
    await cleanupTempRun(t);
  });

  it("after reject with comment, outputs.decision=\"rejected\" and outputs.comment carries the reason", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "review-merge",
      stepId: "gate-merge",
      clock: t.clock,
      stepPrompt: "Approve the merge?",
      stateStore,
      eventWriter,
    });

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "review-merge",
      stepId: "gate-merge",
      decision: "rejected",
      comment: "Missing tests for edge case X",
      decidedBy: "bob",
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const state = await stateStore.readSnapshot(t.runDir);
    expect(state).not.toBeNull();
    const job = state!.jobs["review-merge"]!;

    // AD-P15-005: reject without router → job failed
    expect(job.status).toBe("failed");
    expect(job.outputs).toMatchObject({
      decision: "rejected",
      comment: "Missing tests for edge case X",
    });
  });

  it("a router switch expression resolves ${{ steps.gate-merge.outputs.decision }} to \"rejected\" and .comment carries the reason", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "review-merge",
      stepId: "gate-merge",
      clock: t.clock,
      stepPrompt: "Approve the merge?",
      stateStore,
      eventWriter,
    });

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "review-merge",
      stepId: "gate-merge",
      decision: "rejected",
      comment: "Missing tests",
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const state = await stateStore.readSnapshot(t.runDir);
    const outputs = state!.jobs["review-merge"]!.outputs ?? {};

    const ctx = buildRouterExprCtx({
      runId: t.runId,
      workflowName: "human-router-test",
      stepId: "gate-merge",
      outputs,
    });

    const switchResolved = resolveExpression(
      "${{ steps.gate-merge.outputs.decision }}",
      ctx,
    );
    expect(switchResolved).toBe("rejected");

    const commentResolved = resolveExpression(
      "${{ steps.gate-merge.outputs.comment }}",
      ctx,
    );
    expect(commentResolved).toBe("Missing tests");
  });
});
