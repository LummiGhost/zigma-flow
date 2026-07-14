/**
 * Human gate resume protocol tests — v0.6 Issue #210.
 *
 * Covers:
 *  - RESUME-1: resumeWithInput with valid input records decision and advances state
 *  - RESUME-2: resumeWithInput with invalid input (schema mismatch) → rejected, state unchanged
 *  - RESUME-3: idempotency — duplicate submission → no-op
 *  - RESUME-4: decision change — approve then reject → ALREADY_DECIDED error
 *  - RESUME-5: awaiting_input state transition
 *  - RESUME-6: resume with actor metadata
 *  - RESUME-7: resume via CLI approve/reject deprecation wrappers
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import {
  enterHumanGate,
  recordHumanDecision,
  resumeWithInput,
} from "../../src/engine/humanGate.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { LocalStateStore, JsonlEventWriter } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-07-14T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

const INPUT_SCHEMA_WORKFLOW_YAML = `\
name: human-input-test
version: "0.1.0"
jobs:
  gate:
    steps:
      - id: approve-deploy
        type: human
        prompt: "Review the implementation and decide whether deployment may continue."
        inputs:
          decision:
            type: string
            enum:
              - approve
              - reject
            required: true
          comment:
            type: string
            required: false
        on_submit:
          decision:
            approve: continue
            reject: fail
`;

const MINIMAL_WORKFLOW_YAML = `\
name: human-minimal-test
version: "0.1.0"
jobs:
  gate:
    steps:
      - id: approve-merge
        type: human
        prompt: "Review and approve the merge."
`;

interface TempRun {
  rootDir: string;
  workflowPath: string;
  runDir: string;
  runId: string;
  clock: FakeClock;
}

async function setupTempRun(workflowYaml?: string): Promise<TempRun> {
  const rootDir = join(tmpdir(), `zigma-resume-${randomUUID()}`);
  const runsDir = join(rootDir, ".zigma-flow", "runs");
  const workflowDir = join(rootDir, "workflows");
  await mkdir(workflowDir, { recursive: true });

  const yaml = workflowYaml ?? INPUT_SCHEMA_WORKFLOW_YAML;
  const workflowPath = join(workflowDir, "human-test.yml");
  await writeFile(workflowPath, yaml, "utf-8");

  const skillLockPath = join(rootDir, ".zigma-flow", "skill-lock.json");
  await mkdir(join(rootDir, ".zigma-flow"), { recursive: true });
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }), "utf-8");

  // Write config.json (needed by createRun)
  const configPath = join(rootDir, ".zigma-flow", "config.json");
  await writeFile(configPath, JSON.stringify({ active_run: null }), "utf-8");

  const clock = new FakeClock();
  const { runId } = await createRun({
    workflowPath,
    task: "test human input resume",
    runsDir,
    skillLockPath,
    clock,
  });

  const runDir = join(runsDir, runId);

  return { rootDir, workflowPath, runDir, runId, clock };
}

async function cleanupTempRun(t: TempRun): Promise<void> {
  await rm(t.rootDir, { recursive: true, force: true });
}

async function enterGate(t: TempRun, jobId = "gate", stepId = "approve-deploy"): Promise<void> {
  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();
  await enterHumanGate({
    runDir: t.runDir,
    runId: t.runId,
    jobId,
    stepId,
    clock: t.clock,
    stepPrompt: "Review the implementation.",
    stateStore,
    eventWriter,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resumeWithInput (v0.6)", () => {
  let t: TempRun;

  beforeEach(async () => {
    t = await setupTempRun();
    await enterGate(t);
  });

  afterEach(async () => {
    await cleanupTempRun(t);
  });

  // ── RESUME-1: Valid input ────────────────────────────────────────────────

  it("records decision and advances state with valid input", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    // Verify we're awaiting input
    const preState = await stateStore.readSnapshot(t.runDir);
    expect(preState!.jobs["gate"]!.step_status).toBe("awaiting_input");
    expect(preState!.status).toBe("paused");

    const result = await resumeWithInput({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "approve", comment: "LGTM" },
      actor: { id: "alice", type: "user" },
      source: "cli",
      clock: t.clock,
      stepDef: {
        inputs: {
          decision: { type: "string", enum: ["approve", "reject"], required: true },
          comment: { type: "string", required: false },
        },
      },
      stateStore,
      eventWriter,
    });

    expect(result.outcome).toBe("approved");
    expect(result.status).toBe("recorded");
    // Single-step job with approve → completed (not just "continue")
    expect(["continue", "completed"]).toContain(result.nextAction);

    // Verify state updated
    const postState = await stateStore.readSnapshot(t.runDir);
    expect(postState).not.toBeNull();
    const job = postState!.jobs["gate"]!;
    expect(job.step_status).toBeUndefined();
    expect(job.outputs).toMatchObject({
      decision: "approved",
      comment: "LGTM",
    });
    // Run status after decision: "running" if more jobs/steps remain,
    // "completed" if this was the final step of the final job.
    expect(["running", "completed"]).toContain(postState!.status);

    // Verify human_decision event
    const eventsPath = join(t.runDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n").map((l: string) => JSON.parse(l));
    const decisionEvent = events.find((e: { type: string }) => e.type === "human_decision");
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent.payload.decision).toBe("approved");

    // Verify decision artifact
    const stepDir = join(t.runDir, "jobs", "gate", "attempts", "1", "steps", "approve-deploy");
    const decisionRaw = await readFile(join(stepDir, "human-decision.json"), "utf-8");
    const decision = JSON.parse(decisionRaw);
    expect(decision.decision).toBe("approved");
    expect(decision.actor).toMatchObject({ id: "alice", type: "user" });
    expect(decision.outputs).toMatchObject({ decision: "approved", comment: "LGTM" });
  });

  // ── RESUME-2: Invalid input (schema mismatch) ─────────────────────────────

  it("rejects invalid input — schema mismatch (missing required field)", async () => {
    const stateStore = new LocalStateStore();

    await expect(
      resumeWithInput({
        runDir: t.runDir,
        runId: t.runId,
        jobId: "gate",
        stepId: "approve-deploy",
        input: { comment: "no decision here" }, // missing required "decision"
        actor: { id: "bob", type: "user" },
        clock: t.clock,
        stepDef: {
          inputs: {
            decision: { type: "string", enum: ["approve", "reject"], required: true },
            comment: { type: "string", required: false },
          },
        },
        stateStore,
      })
    ).rejects.toThrow(/Missing required input/);

    // Verify state is UNCHANGED after failed validation
    const postState = await stateStore.readSnapshot(t.runDir);
    expect(postState!.jobs["gate"]!.step_status).toBe("awaiting_input");
    expect(postState!.jobs["gate"]!.status).toBe("running");
  });

  it("rejects invalid input — enum violation", async () => {
    const stateStore = new LocalStateStore();

    await expect(
      resumeWithInput({
        runDir: t.runDir,
        runId: t.runId,
        jobId: "gate",
        stepId: "approve-deploy",
        input: { decision: "maybe" }, // not in enum [approve, reject]
        actor: { id: "bob", type: "user" },
        clock: t.clock,
        stepDef: {
          inputs: {
            decision: { type: "string", enum: ["approve", "reject"], required: true },
          },
        },
        stateStore,
      })
    ).rejects.toThrow(/Invalid value/);

    // State unchanged
    const postState = await stateStore.readSnapshot(t.runDir);
    expect(postState!.jobs["gate"]!.step_status).toBe("awaiting_input");
  });

  // ── RESUME-3: Idempotency — duplicate submission → no-op ──────────────────

  it("returns duplicate status for identical submission (idempotency)", async () => {
    const stateStore = new LocalStateStore();

    const stepDef = {
      inputs: {
        decision: { type: "string", enum: ["approve", "reject"], required: true },
      },
    };

    // First submission
    const result1 = await resumeWithInput({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "approve" },
      actor: { id: "alice", type: "user" },
      clock: t.clock,
      stepDef,
      stateStore,
    });
    expect(result1.status).toBe("recorded");

    // Second submission — same actor, same decision
    const result2 = await resumeWithInput({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "approve" },
      actor: { id: "alice", type: "user" },
      clock: t.clock,
      stepDef,
      stateStore,
    });
    expect(result2.status).toBe("duplicate");
    expect(result2.outcome).toBe("approved");
  });

  // ── RESUME-4: Decision change → ALREADY_DECIDED ──────────────────────────

  it("rejects decision change — approve then reject → ALREADY_DECIDED", async () => {
    const stateStore = new LocalStateStore();

    const stepDef = {
      inputs: {
        decision: { type: "string", enum: ["approve", "reject"], required: true },
      },
    };

    // First: approve
    await resumeWithInput({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "approve" },
      actor: { id: "alice", type: "user" },
      clock: t.clock,
      stepDef,
      stateStore,
    });

    // Second: try to reject — should fail with ALREADY_DECIDED
    await expect(
      resumeWithInput({
        runDir: t.runDir,
        runId: t.runId,
        jobId: "gate",
        stepId: "approve-deploy",
        input: { decision: "reject" },
        actor: { id: "alice", type: "user" },
        clock: t.clock,
        stepDef,
        stateStore,
      })
    ).rejects.toThrow(/already been decided/);
  });

  // ── RESUME-5: awaiting_input state transition ─────────────────────────────

  it("enterHumanGate sets awaiting_input and paused status", async () => {
    // Create a fresh run for this test
    const t2 = await setupTempRun();
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t2.runDir,
      runId: t2.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      clock: t2.clock,
      stepPrompt: "Review the implementation.",
      stateStore,
      eventWriter,
    });

    const state = await stateStore.readSnapshot(t2.runDir);
    expect(state).not.toBeNull();
    expect(state!.jobs["gate"]!.step_status).toBe("awaiting_input");
    expect(state!.status).toBe("paused");
    expect(state!.jobs["gate"]!.status).toBe("running");

    await cleanupTempRun(t2);
  });

  it("enterHumanGate is idempotent with awaiting_input status", async () => {
    const t2 = await setupTempRun();
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t2.runDir,
      runId: t2.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      clock: t2.clock,
      stepPrompt: "Review please.",
      stateStore,
      eventWriter,
    });

    // Second call — should be no-op
    await enterHumanGate({
      runDir: t2.runDir,
      runId: t2.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      clock: t2.clock,
      stepPrompt: "Review please.",
      stateStore,
      eventWriter,
    });

    // Only one human_gate_waiting event
    const eventsPath = join(t2.runDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n").map((l: string) => JSON.parse(l));
    const waitingEvents = events.filter((e: { type: string }) => e.type === "human_gate_waiting");
    expect(waitingEvents).toHaveLength(1);

    // Status still awaiting_input
    const state = await stateStore.readSnapshot(t2.runDir);
    expect(state!.jobs["gate"]!.step_status).toBe("awaiting_input");

    await cleanupTempRun(t2);
  });

  // ── RESUME-6: Actor metadata ──────────────────────────────────────────────

  it("records actor metadata in the decision artifact", async () => {
    const stateStore = new LocalStateStore();

    await resumeWithInput({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "reject" },
      actor: { id: "bob", name: "Bob Reviewer", type: "user" },
      source: "api",
      comment: "Needs more work",
      clock: t.clock,
      stateStore,
    });

    // Check the artifact
    const stepDir = join(t.runDir, "jobs", "gate", "attempts", "1", "steps", "approve-deploy");
    const decisionRaw = await readFile(join(stepDir, "human-decision.json"), "utf-8");
    const decision = JSON.parse(decisionRaw);
    expect(decision.decision).toBe("rejected");
    expect(decision.actor).toMatchObject({
      id: "bob",
      name: "Bob Reviewer",
      type: "user",
    });
    expect(decision.source).toBe("api");
    expect(decision.comment).toBe("Needs more work");
  });

  // ── RESUME-7: Legacy approve/reject still work ────────────────────────────

  it("recordHumanDecision still works with awaiting_input status", async () => {
    const stateStore = new LocalStateStore();

    // recordHumanDecision should accept awaiting_input status
    const result = await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      decision: "approved",
      comment: "Ship it",
      decidedBy: "alice",
      clock: t.clock,
      stateStore,
    });

    expect(result.status).toBe("recorded");
    expect(result.decision).toBe("approved");

    const postState = await stateStore.readSnapshot(t.runDir);
    expect(postState!.jobs["gate"]!.step_status).toBeUndefined();
    expect(postState!.jobs["gate"]!.outputs).toMatchObject({
      decision: "approved",
      comment: "Ship it",
    });
  });

  // ── RESUME-8: resume with reject decision ─────────────────────────────────

  it("reject decision transitions job to failed", async () => {
    const stateStore = new LocalStateStore();

    const result = await resumeWithInput({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "reject" },
      actor: { id: "admin", type: "user" },
      clock: t.clock,
      stateStore,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.nextAction).toBe("blocked");

    const postState = await stateStore.readSnapshot(t.runDir);
    expect(postState!.jobs["gate"]!.status).toBe("failed");
    // Canonical decision value is "rejected" (not the raw "reject" input)
    expect(postState!.jobs["gate"]!.outputs).toMatchObject({
      decision: "rejected",
    });
  });

  // ── RESUME-9: Minimal workflow (no input schema) ──────────────────────────

  it("resume works with minimal workflow (no input schema defined)", async () => {
    const t2 = await setupTempRun(MINIMAL_WORKFLOW_YAML);
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t2.runDir,
      runId: t2.runId,
      jobId: "gate",
      stepId: "approve-merge",
      clock: t2.clock,
      stepPrompt: "Review and approve the merge.",
      stateStore,
      eventWriter,
    });

    // Verify awaiting_input state
    const preState = await stateStore.readSnapshot(t2.runDir);
    expect(preState!.jobs["gate"]!.step_status).toBe("awaiting_input");

    // Resume without stepDef (no input schema to validate)
    const result = await resumeWithInput({
      runDir: t2.runDir,
      runId: t2.runId,
      jobId: "gate",
      stepId: "approve-merge",
      input: { decision: "approve" },
      actor: { id: "alice", type: "user" },
      clock: t2.clock,
      stateStore,
    });

    expect(result.status).toBe("recorded");
    expect(result.outcome).toBe("approved");

    await cleanupTempRun(t2);
  });

  // ── RESUME-10: Input variants (yes/no, true/false) ────────────────────────

  it("accepts yes/no and true/false as decision value variants", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    // Test "yes" → "approved"
    const t2 = await setupTempRun();
    await enterGate(t2);
    const r2 = await resumeWithInput({
      runDir: t2.runDir,
      runId: t2.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "yes" },
      actor: { id: "u1", type: "user" },
      clock: t2.clock,
      stateStore,
    });
    expect(r2.outcome).toBe("approved");
    await cleanupTempRun(t2);

    // Test "true" → "approved"
    const t3 = await setupTempRun();
    await enterGate(t3);
    const r3 = await resumeWithInput({
      runDir: t3.runDir,
      runId: t3.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "true" },
      actor: { id: "u1", type: "user" },
      clock: t3.clock,
      stateStore,
    });
    expect(r3.outcome).toBe("approved");
    await cleanupTempRun(t3);

    // Test "no" → "rejected"
    const t4 = await setupTempRun();
    await enterGate(t4);
    const r4 = await resumeWithInput({
      runDir: t4.runDir,
      runId: t4.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "no" },
      actor: { id: "u1", type: "user" },
      clock: t4.clock,
      stateStore,
    });
    expect(r4.outcome).toBe("rejected");
    await cleanupTempRun(t4);

    // Test "false" → "rejected"
    const t5 = await setupTempRun();
    await enterGate(t5);
    const r5 = await resumeWithInput({
      runDir: t5.runDir,
      runId: t5.runId,
      jobId: "gate",
      stepId: "approve-deploy",
      input: { decision: "false" },
      actor: { id: "u1", type: "user" },
      clock: t5.clock,
      stateStore,
    });
    expect(r5.outcome).toBe("rejected");
    await cleanupTempRun(t5);
  });
});
