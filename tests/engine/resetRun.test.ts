/**
 * `resetRun` tests for Issue #237 (Step 1 — Cases and Tests).
 *
 * Exercises the new Engine entry point that powers
 * `zigma-flow reset-run [run-id]`. The function is invoked by the CLI
 * after the user confirms the operation.
 *
 * Covers:
 *   - T-RESET-1: failed job → waiting, emits job_reset.
 *   - T-RESET-2: running job → waiting, emits job_reset.
 *   - T-RESET-3: blocked job → waiting, emits job_reset.
 *   - T-RESET-4: completed + done jobs unchanged.
 *   - T-RESET-5: DAG readiness — waiting jobs become ready after upstream reset.
 *   - T-RESET-6: run status reset from terminal → running.
 *   - T-RESET-7: run status unchanged when already running.
 *   - T-RESET-8: dry-run returns preview without writing.
 *   - T-RESET-9: mixed scenario — some reset, some stay, some become ready.
 *   - T-RESET-10: no resettable jobs → UserInputError.
 *   - T-RESET-11: cleared current_step, attempt, step_visits on reset.
 *
 * Reference: GitHub Issue #237
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { resetRun } from "../../src/engine/resetRun.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-07-16T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Two-job DAG workflow: implement depends on intake.
 * After reset, implement should only become ready if intake is completed.
 */
const TWO_JOB_YAML = `\
name: two-job
version: "0.6.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: script
        run: "echo intake"
  implement:
    needs:
      - intake
    steps:
      - id: code
        type: script
        run: "echo implement"
`;

/**
 * Single-job workflow for simple reset scenarios.
 */
const SINGLE_JOB_YAML = `\
name: single-job
version: "0.6.0"
jobs:
  implement:
    steps:
      - id: code
        type: script
        run: "echo hello"
`;

/**
 * Three-job linear pipeline: intake → plan → implement.
 */
const THREE_JOB_YAML = `\
name: three-job
version: "0.6.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: script
        run: "echo intake"
  plan:
    needs:
      - intake
    steps:
      - id: design
        type: script
        run: "echo plan"
  implement:
    needs:
      - plan
    steps:
      - id: code
        type: script
        run: "echo implement"
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
  const projectRoot = join(tmpdir(), `zigma-resetrun-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const configPath = join(dotZigma, "config.json");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ tool_version: "0.6.0", active_run: null }, null, 2),
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
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  return snap;
}

async function readEventsBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "events.jsonl"), "utf-8");
}

async function readStateBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "state.json"), "utf-8");
}

interface JobStatePatch {
  status?: JobState["status"];
  attempt?: number;
  current_step?: string;
  step_visits?: Record<string, number>;
}

async function setJobState(
  runDir: string,
  jobId: string,
  patch: JobStatePatch
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  const existing = snap.jobs[jobId];
  if (existing === undefined) {
    throw new Error(`job ${jobId} not found in state.json at ${runDir}`);
  }
  const merged: JobState = { ...existing };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step !== undefined) merged.current_step = patch.current_step;
  if (patch.step_visits !== undefined) merged.step_visits = patch.step_visits;
  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

async function setRunStatus(
  runDir: string,
  status: NonNullable<RunState["status"]>
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) throw new Error(`state.json missing at ${runDir}`);
  snap.status = status;
  await store.writeSnapshot(runDir, snap);
}

// ---------------------------------------------------------------------------
// T-RESET-1: failed job → waiting, emits job_reset event
// ---------------------------------------------------------------------------

describe("resetRun — failed job resets to waiting (T-RESET-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("transitions failed → waiting, emits job_reset, clears current_step/attempt (T-RESET-1)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      SINGLE_JOB_YAML,
      "single-job"
    );

    await setJobState(runDir, "implement", {
      status: "failed",
      attempt: 1,
      current_step: "code",
      step_visits: { code: 2 },
    });

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
    });

    expect(result.jobsReset).toBe(1);
    expect(result.jobsReady).toBe(1); // single job with no deps → ready
    expect(result.jobChanges).toEqual([
      { jobId: "implement", fromStatus: "failed", toStatus: "waiting" },
    ]);

    const snap = await readStateSnapshot(runDir);
    const job = snap.jobs["implement"]!;
    expect(job.status).toBe("ready"); // DAG recompute makes it ready (no deps)
    expect(job.current_step).toBeUndefined();
    expect(job.attempt).toBeUndefined();
    expect(job.step_visits).toBeUndefined();

    const events = await readEvents(runDir);
    const resetEvents = events.filter((e) => e.type === "job_reset");
    expect(resetEvents).toHaveLength(1);
    expect(resetEvents[0]!.payload).toMatchObject({
      job_id: "implement",
      from_status: "failed",
      to_status: "waiting",
    });
    expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
  });
});

// ---------------------------------------------------------------------------
// T-RESET-2: running job → waiting, emits job_reset
// ---------------------------------------------------------------------------

describe("resetRun — running job resets to waiting (T-RESET-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("transitions running → waiting and emits job_reset (T-RESET-2)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      SINGLE_JOB_YAML,
      "single-job"
    );

    await setJobState(runDir, "implement", {
      status: "running",
      attempt: 2,
      current_step: "code",
    });

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
    });

    expect(result.jobsReset).toBe(1);
    expect(result.jobsReady).toBe(1); // single job with no deps → ready
    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["implement"]!.status).toBe("ready");

    const events = await readEvents(runDir);
    const resetEvents = events.filter((e) => e.type === "job_reset");
    expect(resetEvents).toHaveLength(1);
    expect(resetEvents[0]!.payload).toMatchObject({
      from_status: "running",
      to_status: "waiting",
    });
  });
});

// ---------------------------------------------------------------------------
// T-RESET-3: blocked job → waiting, emits job_reset
// ---------------------------------------------------------------------------

describe("resetRun — blocked job resets to waiting (T-RESET-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("transitions blocked → waiting and emits job_reset (T-RESET-3)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      SINGLE_JOB_YAML,
      "single-job"
    );

    await setJobState(runDir, "implement", {
      status: "blocked",
      attempt: 3,
    });

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
    });

    expect(result.jobsReset).toBe(1);
    expect(result.jobsReady).toBe(1); // single job with no deps → ready
    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["implement"]!.status).toBe("ready");

    const events = await readEvents(runDir);
    const resetEvents = events.filter((e) => e.type === "job_reset");
    expect(resetEvents[0]!.payload).toMatchObject({
      from_status: "blocked",
    });
  });
});

// ---------------------------------------------------------------------------
// T-RESET-4: completed + done jobs unchanged
// ---------------------------------------------------------------------------

describe("resetRun — completed and done jobs stay unchanged (T-RESET-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("leaves completed and done jobs untouched (T-RESET-4)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      TWO_JOB_YAML,
      "two-job"
    );

    await setJobState(runDir, "intake", {
      status: "completed",
      attempt: 1,
    });
    await setJobState(runDir, "implement", {
      status: "done",
      attempt: 1,
    });

    // Since both jobs are in non-resettable states, this should throw
    await expect(
      resetRun({ runDir, runId, clock: new FakeClock() })
    ).rejects.toMatchObject({ kind: "UserInputError" });
  });
});

// ---------------------------------------------------------------------------
// T-RESET-5: DAG readiness after reset
// ---------------------------------------------------------------------------

describe("resetRun — DAG readiness recompute (T-RESET-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("marks waiting jobs ready when dependencies are satisfied after reset (T-RESET-5)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      TWO_JOB_YAML,
      "two-job"
    );

    // intake completed, implement failed
    await setJobState(runDir, "intake", { status: "completed", attempt: 1 });
    await setJobState(runDir, "implement", { status: "failed", attempt: 1 });

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
    });

    expect(result.jobsReset).toBe(1);
    expect(result.jobsReady).toBe(1);

    const snap = await readStateSnapshot(runDir);
    // implement should now be "ready" because intake (its dependency) is completed
    expect(snap.jobs["implement"]!.status).toBe("ready");

    const events = await readEvents(runDir);
    const resetEvents = events.filter((e) => e.type === "job_reset");
    expect(resetEvents).toHaveLength(1);
    const readyEvents = events.filter((e) => e.type === "job_ready");
    // There should be at least one job_ready for implement
    expect(readyEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("does not mark ready if dependencies are not satisfied (T-RESET-5b)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      THREE_JOB_YAML,
      "three-job"
    );

    // intake completed, plan failed, implement waiting
    await setJobState(runDir, "intake", { status: "completed", attempt: 1 });
    await setJobState(runDir, "plan", { status: "failed", attempt: 1 });
    await setJobState(runDir, "implement", { status: "waiting", attempt: 1 });

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
    });

    // plan was reset; plan becomes ready because its dep (intake) is completed.
    // implement should NOT become ready because plan is now ready, not completed.
    expect(result.jobsReady).toBe(1);

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["plan"]!.status).toBe("ready");
    expect(snap.jobs["implement"]!.status).toBe("waiting");
  });
});

// ---------------------------------------------------------------------------
// T-RESET-6: run status reset from terminal → running
// ---------------------------------------------------------------------------

describe("resetRun — run status reset from terminal (T-RESET-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("resets run status from failed to running (T-RESET-6)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      SINGLE_JOB_YAML,
      "single-job"
    );

    await setJobState(runDir, "implement", { status: "failed", attempt: 1 });
    await setRunStatus(runDir, "failed");

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
    });

    expect(result.runStatusChanged).toBe(true);
    expect(result.previousRunStatus).toBe("failed");

    const snap = await readStateSnapshot(runDir);
    expect(snap.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// T-RESET-7: run status unchanged when running
// ---------------------------------------------------------------------------

describe("resetRun — run status unchanged when already running (T-RESET-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("does not change run status when it is running (T-RESET-7)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      SINGLE_JOB_YAML,
      "single-job"
    );

    await setJobState(runDir, "implement", { status: "failed", attempt: 1 });

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
    });

    // New runs don't have explicit status by default (undefined)
    expect(result.runStatusChanged).toBe(false);

    const snap = await readStateSnapshot(runDir);
    expect(snap.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-RESET-8: dry-run returns preview without writing
// ---------------------------------------------------------------------------

describe("resetRun — dry-run (T-RESET-8)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("returns preview but does not modify state or events (T-RESET-8)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      TWO_JOB_YAML,
      "two-job"
    );

    await setJobState(runDir, "intake", { status: "completed", attempt: 1 });
    await setJobState(runDir, "implement", { status: "failed", attempt: 1 });
    await setRunStatus(runDir, "failed");

    const eventsBefore = await readEventsBytes(runDir);
    const stateBefore = await readStateBytes(runDir);

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
      dryRun: true,
    });

    expect(result.jobsReset).toBe(1);
    expect(result.jobsReady).toBe(1);
    expect(result.runStatusChanged).toBe(true);
    expect(result.previousRunStatus).toBe("failed");

    // Verify nothing was written
    const eventsAfter = await readEventsBytes(runDir);
    const stateAfter = await readStateBytes(runDir);
    expect(eventsAfter).toBe(eventsBefore);
    expect(stateAfter).toBe(stateBefore);
  });
});

// ---------------------------------------------------------------------------
// T-RESET-9: mixed scenario
// ---------------------------------------------------------------------------

describe("resetRun — mixed scenario (T-RESET-9)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("handles mix of reset, stay, and ready transitions (T-RESET-9)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      THREE_JOB_YAML,
      "three-job"
    );

    // intake completed, plan failed, implement waiting
    await setJobState(runDir, "intake", { status: "completed", attempt: 1 });
    await setJobState(runDir, "plan", { status: "failed", attempt: 2, current_step: "design" });
    // implement is waiting (default state from createRun)
    // Need to set implement to waiting explicitly
    await setJobState(runDir, "implement", { status: "waiting" });
    await setRunStatus(runDir, "failed");

    const result = await resetRun({
      runDir,
      runId,
      clock: new FakeClock(),
    });

    expect(result.jobsReset).toBe(1); // only plan reset
    expect(result.jobsReady).toBe(1); // plan becomes ready because intake is completed
    expect(result.runStatusChanged).toBe(true);

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["intake"]!.status).toBe("completed");
    expect(snap.jobs["plan"]!.status).toBe("ready");
    expect(snap.jobs["implement"]!.status).toBe("waiting");
    expect(snap.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// T-RESET-10: no resettable jobs → UserInputError
// ---------------------------------------------------------------------------

describe("resetRun — no resettable jobs (T-RESET-10)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("throws UserInputError when no jobs are resettable (T-RESET-10)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      SINGLE_JOB_YAML,
      "single-job"
    );

    // implement is in "ready" state (default from createRun)
    // No jobs in resettable statuses

    await expect(
      resetRun({ runDir, runId, clock: new FakeClock() })
    ).rejects.toMatchObject({ kind: "UserInputError" });
  });
});

// ---------------------------------------------------------------------------
// T-RESET-11: cleared current_step, attempt, step_visits on reset
// ---------------------------------------------------------------------------

describe("resetRun — clears job fields on reset (T-RESET-11)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("clears current_step, attempt, and step_visits from reset jobs (T-RESET-11)", async () => {
    const { runId, runDir } = await bootstrapRun(
      sandbox,
      SINGLE_JOB_YAML,
      "single-job"
    );

    await setJobState(runDir, "implement", {
      status: "failed",
      attempt: 3,
      current_step: "code",
      step_visits: { code: 2 },
    });

    await resetRun({ runDir, runId, clock: new FakeClock() });

    const snap = await readStateSnapshot(runDir);
    const job = snap.jobs["implement"]!;
    expect(job.status).toBe("ready"); // single job with no deps → ready
    expect(job.current_step).toBeUndefined();
    expect(job.attempt).toBeUndefined();
    expect(job.step_visits).toBeUndefined();
  });
});
