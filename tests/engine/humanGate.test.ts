/**
 * Human gate engine tests for WF-P15-ENGINE (Step 1 — Cases and Tests).
 *
 * Covers:
 *  - ENTER-1: enterHumanGate sets step_status=awaiting_human, writes event + artifact
 *  - ENTER-2: enterHumanGate is idempotent (no duplicate events)
 *  - DECISION-1: recordHumanDecision approve → step_status cleared, advanceJob called
 *  - DECISION-2: recordHumanDecision reject → job failed
 *  - DECISION-3: recordHumanDecision on non-awaiting_human step → StateError
 *
 * Reference: docs/phases/p15-human-gate/02-development-plan.md
 * AD-P15-003, AD-P15-005
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createRun } from "../../src/engine/index.js";
import { enterHumanGate, recordHumanDecision } from "../../src/engine/humanGate.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { LocalStateStore, JsonlEventWriter } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-28T00:00:00.000Z";

class FakeClock implements Clock {
  now(): string {
    return FIXED_ISO;
  }
}

const HUMAN_WORKFLOW_YAML = `\
name: human-test
version: "0.1.0"
jobs:
  gate:
    steps:
      - id: approve-merge
        type: human
        prompt: "Review and approve the merge."
        instructions: "Check the diff before approving."
        approvers:
          - alice
`;

interface TempRun {
  rootDir: string;
  workflowPath: string;
  runDir: string;
  runId: string;
  clock: FakeClock;
}

async function setupTempRun(): Promise<TempRun> {
  const rootDir = join(tmpdir(), `zigma-human-gate-${randomUUID()}`);
  const runsDir = join(rootDir, ".zigma-flow", "runs");
  const workflowDir = join(rootDir, "workflows");
  await mkdir(workflowDir, { recursive: true });

  const workflowPath = join(workflowDir, "human-test.yml");
  await writeFile(workflowPath, HUMAN_WORKFLOW_YAML, "utf-8");

  const skillLockPath = join(rootDir, ".zigma-flow", "skill-lock.json");
  await mkdir(join(rootDir, ".zigma-flow"), { recursive: true });
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }), "utf-8");

  // Write config.json (needed by createRun)
  const configPath = join(rootDir, ".zigma-flow", "config.json");
  await writeFile(configPath, JSON.stringify({ active_run: null }), "utf-8");

  const clock = new FakeClock();
  const { runId } = await createRun({
    workflowPath,
    task: "test human gate",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enterHumanGate", () => {
  let t: TempRun;

  beforeEach(async () => {
    t = await setupTempRun();
  });

  afterEach(async () => {
    await cleanupTempRun(t);
  });

  it("sets step_status to awaiting_human and writes event + artifact", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      clock: t.clock,
      stepPrompt: "Review and approve the merge.",
      stepApprovers: ["alice"],
      stepInstructions: "Check the diff before approving.",
      stateStore,
      eventWriter,
    });

    // Verify state
    const state = await stateStore.readSnapshot(t.runDir);
    expect(state).not.toBeNull();
    const job = state!.jobs["gate"]!;
    expect(job.step_status).toBe("awaiting_human");
    expect(job.status).toBe("running");

    // Verify event was written
    const eventsPath = join(t.runDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n").map((l) => JSON.parse(l));
    const waitingEvent = events.find((e: { type: string }) => e.type === "human_gate_waiting");
    expect(waitingEvent).toBeDefined();
    expect(waitingEvent.payload.prompt).toBe("Review and approve the merge.");
    expect(waitingEvent.payload.approvers).toEqual(["alice"]);

    // Verify artifact was written
    const stepDir = join(t.runDir, "jobs", "gate", "attempts", "1", "steps", "approve-merge");
    const artifactRaw = await readFile(join(stepDir, "human-gate.md"), "utf-8");
    expect(artifactRaw).toContain("Human Gate: approve-merge");
    expect(artifactRaw).toContain("Review and approve the merge.");
  });

  it("is idempotent — calling enterHumanGate twice does not duplicate events", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      clock: t.clock,
      stepPrompt: "Review and approve the merge.",
      stateStore,
      eventWriter,
    });

    // Second call should be no-op
    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      clock: t.clock,
      stepPrompt: "Review and approve the merge.",
      stateStore,
      eventWriter,
    });

    // Only one human_gate_waiting event
    const eventsPath = join(t.runDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n").map((l) => JSON.parse(l));
    const waitingEvents = events.filter((e: { type: string }) => e.type === "human_gate_waiting");
    expect(waitingEvents).toHaveLength(1);
  });
});

describe("recordHumanDecision", () => {
  let t: TempRun;

  beforeEach(async () => {
    t = await setupTempRun();
    // Set up awaiting_human state first
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();
    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      clock: t.clock,
      stepPrompt: "Review and approve the merge.",
      stateStore,
      eventWriter,
    });
  });

  afterEach(async () => {
    await cleanupTempRun(t);
  });

  it("approve → job advance (step_status cleared, job status transitions)", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      decision: "approved",
      comment: "LGTM",
      decidedBy: "alice",
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    // Verify state: step_status cleared, outputs set
    const state = await stateStore.readSnapshot(t.runDir);
    expect(state).not.toBeNull();
    const job = state!.jobs["gate"]!;
    expect(job.step_status).toBeUndefined();
    expect(job.outputs).toMatchObject({
      decision: "approved",
      comment: "LGTM",
    });

    // Verify human_decision event
    const eventsPath = join(t.runDir, "events.jsonl");
    const eventsRaw = await readFile(eventsPath, "utf-8");
    const events = eventsRaw.trim().split("\n").map((l) => JSON.parse(l));
    const decisionEvent = events.find((e: { type: string }) => e.type === "human_decision");
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent.payload.decision).toBe("approved");
    expect(decisionEvent.payload.comment).toBe("LGTM");
    expect(decisionEvent.payload.decided_by).toBe("alice");

    // Verify decision artifact
    const stepDir = join(t.runDir, "jobs", "gate", "attempts", "1", "steps", "approve-merge");
    const decisionRaw = await readFile(join(stepDir, "human-decision.json"), "utf-8");
    const decision = JSON.parse(decisionRaw);
    expect(decision.decision).toBe("approved");
    expect(decision.comment).toBe("LGTM");
  });

  it("reject → job failed, outputs include comment", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      decision: "rejected",
      comment: "Needs more tests",
      decidedBy: "bob",
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const state = await stateStore.readSnapshot(t.runDir);
    expect(state).not.toBeNull();
    const job = state!.jobs["gate"]!;
    expect(job.status).toBe("failed");
    expect(job.step_status).toBeUndefined();
    expect(job.outputs).toMatchObject({
      decision: "rejected",
      comment: "Needs more tests",
    });
  });

  it("throws StateError if step is not awaiting_human", async () => {
    const stateStore = new LocalStateStore();

    // First approve, then try to decide again
    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      decision: "approved",
      clock: t.clock,
      stateStore,
    });

    // Second decision should fail
    await expect(
      recordHumanDecision({
        runDir: t.runDir,
        runId: t.runId,
        jobId: "gate",
        stepId: "approve-merge",
        decision: "approved",
        clock: t.clock,
        stateStore,
      })
    ).rejects.toThrow(/not awaiting human input/);
  });

  it("supports custom outputs on approve", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      decision: "approved",
      comment: "Looks good",
      outputs: { custom_key: "custom_value" },
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const state = await stateStore.readSnapshot(t.runDir);
    const job = state!.jobs["gate"]!;
    expect(job.outputs).toMatchObject({
      decision: "approved",
      comment: "Looks good",
      custom_key: "custom_value",
    });
  });
});

// ---------------------------------------------------------------------------
// WF-V022-HUMANGATE — human_decision_record artifact schema tests
// ---------------------------------------------------------------------------
//
// Lock down the on-disk shape of `human-decision.json`. The artifact is the
// audit anchor for a human decision (mvp-contracts §7); its schema must be
// well-defined so downstream tooling (status commands, review scripts) can
// depend on it.
//
// Required fields: `decision`, `timestamp`.
// Optional fields: `comment`, `decided_by`, `outputs`.
// `decision` MUST be exactly "approved" or "rejected"; no other strings.
//
// Reference: docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-humangate/01-cases-and-tests.md
//            docs/phases/p15-human-gate/02-development-plan.md AD-P15-005

// Step 2 will move this schema into `src/artifact/humanDecisionRecord.ts` and
// re-export it so production code can consume the same definition. For now the
// schema is inline in this test so the red phase can assert against it.
const HumanDecisionRecordSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  timestamp: z.string().min(1),
  comment: z.string().optional(),
  decided_by: z.string().optional(),
  outputs: z.record(z.string(), z.string()).optional(),
});

describe("human_decision_record artifact schema", () => {
  let t: TempRun;

  beforeEach(async () => {
    t = await setupTempRun();
    // Enter awaiting_human once so recordHumanDecision has a valid state.
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();
    await enterHumanGate({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      clock: t.clock,
      stepPrompt: "Review and approve the merge.",
      stateStore,
      eventWriter,
    });
  });

  afterEach(async () => {
    await cleanupTempRun(t);
  });

  it("recordHumanDecision(approved) produces a schema-conformant artifact with only required fields", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      decision: "approved",
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const decisionPath = join(
      t.runDir, "jobs", "gate", "attempts", "1", "steps", "approve-merge",
      "human-decision.json",
    );
    const raw = await readFile(decisionPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    const result = HumanDecisionRecordSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decision).toBe("approved");
      expect(result.data.timestamp).toBeTruthy();
    }
  });

  it("recordHumanDecision(rejected) with comment and decided_by produces a schema-conformant artifact", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      decision: "rejected",
      comment: "Needs more tests",
      decidedBy: "alice",
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const decisionPath = join(
      t.runDir, "jobs", "gate", "attempts", "1", "steps", "approve-merge",
      "human-decision.json",
    );
    const raw = await readFile(decisionPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    const result = HumanDecisionRecordSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        decision: "rejected",
        comment: "Needs more tests",
        decided_by: "alice",
      });
    }
  });

  it("recordHumanDecision(approved) with custom outputs writes outputs field into artifact", async () => {
    const stateStore = new LocalStateStore();
    const eventWriter = new JsonlEventWriter();

    await recordHumanDecision({
      runDir: t.runDir,
      runId: t.runId,
      jobId: "gate",
      stepId: "approve-merge",
      decision: "approved",
      outputs: { release_note: "ok" },
      clock: t.clock,
      stateStore,
      eventWriter,
    });

    const decisionPath = join(
      t.runDir, "jobs", "gate", "attempts", "1", "steps", "approve-merge",
      "human-decision.json",
    );
    const raw = await readFile(decisionPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    const result = HumanDecisionRecordSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputs).toEqual({ release_note: "ok" });
    }
  });

  it("schema rejects an arbitrary decision string (only \"approved\" or \"rejected\" allowed)", () => {
    const bad = {
      decision: "maybe",
      timestamp: FIXED_ISO,
    };
    const result = HumanDecisionRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("schema rejects a record missing the required timestamp field", () => {
    const bad = { decision: "approved" };
    const result = HumanDecisionRecordSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("schema accepts a minimal record with only decision + timestamp", () => {
    const minimal = { decision: "approved", timestamp: FIXED_ISO };
    const result = HumanDecisionRecordSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});
