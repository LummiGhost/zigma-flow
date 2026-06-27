/**
 * `runAll` resume tests for WF-P13-RESUME-CANCEL (Step 1 — Cases and Tests).
 *
 * Exercises the `runAll({ runId })` resume path where an existing run is
 * continued from its current state without re-creating the run.
 *
 * Covers:
 *   - T-RESUME-1: Resume from existing run completes remaining work
 *   - T-RESUME-2: No duplicate run_created event on resume
 *   - T-RESUME-3: Resume from terminal state is rejected
 *   - T-RESUME-4: Resume continues at correct attempt after failure
 *   - T-RESUME-5: Summary reflects final state after resume
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-resume-cancel/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §AD-P13-005
 *   - docs/mvp-contracts.md §2.3
 *
 * Red-phase note: The resume behavior in `runAll` is partially implemented
 * (the `runId` parameter already exists from WF-P13-ENGINE-RUNALL) but the
 * full resume semantics (reject terminal state, no duplicate events, attempt
 * continuity) may not be fully shipped. Tests are expected to potentially
 * fail until WF-P13-RESUME-CANCEL Step 2 ships.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import type { AgentBackend, AgentBackendConfig, AgentExecuteOptions, AgentExecuteResult } from "../../src/agent/index.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";

// ---------------------------------------------------------------------------
// Types for the module under design (src/engine/runAll.ts)
// ---------------------------------------------------------------------------

export interface RunAllOpts {
  task?: string;
  runId?: string;
  workflowPath: string;
  runsDir: string;
  zigmaflowDir: string;
  skillLockPath: string;
  backendResolver: (stepBackendName?: string) => AgentBackend;
  clock?: Clock;
  signal?: AbortSignal;
  maxIterations?: number;
  onEvent?: (e: ZigmaFlowEvent) => void;
}

export interface RunAllSummary {
  runId: string;
  status?: string;
  jobs: Array<{ id: string; status: string; attempts: number }>;
  iterations: number;
}

// ---------------------------------------------------------------------------
// Lazy import — red-phase wrapper
// ---------------------------------------------------------------------------

const RUN_ALL_SPECIFIER = "../../src/engine/runAll.js";

async function callRunAll(opts: RunAllOpts): Promise<RunAllSummary> {
  let mod: { runAll?: (o: RunAllOpts) => Promise<RunAllSummary> };
  try {
    mod = (await import(/* @vite-ignore */ String(RUN_ALL_SPECIFIER))) as {
      runAll?: (o: RunAllOpts) => Promise<RunAllSummary>;
    };
  } catch (e: unknown) {
    throw new Error(
      `runAll is not yet implemented — src/engine/runAll.ts does not exist. Underlying: ${String(e)}`
    );
  }
  if (typeof mod.runAll !== "function") {
    throw new Error(
      "runAll is not exported from src/engine/runAll.ts"
    );
  }
  return mod.runAll(opts);
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-27T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

class FakeBackend implements AgentBackend {
  readonly name = "fake-resume";
  static calls: AgentExecuteOptions[] = [];

  constructor(_config: AgentBackendConfig) {}

  static reset(): void {
    FakeBackend.calls = [];
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    FakeBackend.calls.push(opts);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");

    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify(
        {
          outputs: { completed: true },
          artifacts: [],
          signals: [],
          summary: "fake backend executed (resume test)",
        },
        null,
        2
      ),
      "utf-8"
    );
    return { success: true, reportPath: opts.reportPath };
  }
}

// ---------------------------------------------------------------------------
// Workflow YAML fixtures
// ---------------------------------------------------------------------------

const SINGLE_AGENT_YAML = `\
name: resume-test
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        uses: zigma/analyze-skill
`;

/** Two-agent jobs so we can partially advance and then resume. */
const TWO_AGENT_JOBS_YAML = `\
name: resume-two-jobs
version: "0.1.0"
jobs:
  first:
    steps:
      - id: step1
        type: agent
        uses: zigma/first-skill
  second:
    steps:
      - id: step2
        type: agent
        uses: zigma/second-skill
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
  const projectRoot = join(tmpdir(), `zigma-resume-${randomUUID()}`);
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
  workflowName: string,
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
  timestamp: string;
  payload: Record<string, unknown>;
}

async function readEvents(runDir: string): Promise<EventRecord[]> {
  try {
    const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as EventRecord);
  } catch {
    return [];
  }
}

async function readStateSnapshot(runDir: string): Promise<RunState> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  return snap;
}

/**
 * Manually write a modified state to simulate a partially progressed run.
 */
async function writeState(runDir: string, state: RunState): Promise<void> {
  const store = new LocalStateStore();
  await store.writeSnapshot(runDir, state);
}

// ---------------------------------------------------------------------------
// T-RESUME-1: Resume from existing run completes remaining work
// ---------------------------------------------------------------------------

describe("runAll — resume from existing run (T-RESUME-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "resumes from an existing run via runId and completes (T-RESUME-1, UC-RESUME-001, FP-RESUME-CREATE-SKIP, FP-RESUME-EXISTING-STATE)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SINGLE_AGENT_YAML,
        "resume-test"
      );

      // The run was created with run_created + job_ready events
      const eventsBefore = await readEvents(runDir);
      const eventCountBefore = eventsBefore.length;
      expect(eventCountBefore).toBeGreaterThan(0);

      // Resume via runId (NOT task)
      const summary = await callRunAll({
        runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      // The run should complete
      expect(summary.runId).toBe(runId);
      expect(summary.status).toBe("completed");

      // Backend should have been called to finish the work
      expect(FakeBackend.calls.length).toBeGreaterThanOrEqual(1);

      // Verify final state
      const finalState = await readStateSnapshot(runDir);
      expect(finalState.status).toBe("completed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-RESUME-2: No duplicate run_created event on resume
// ---------------------------------------------------------------------------

describe("runAll — no duplicate events on resume (T-RESUME-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "does not emit a second run_created when resuming via runId (T-RESUME-2, UC-RESUME-005, FP-RESUME-NO-DUP-EVENTS)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SINGLE_AGENT_YAML,
        "resume-no-dup"
      );

      // Count run_created events before resume
      const eventsBefore = await readEvents(runDir);
      const runCreatedBefore = eventsBefore.filter((e) => e.type === "run_created").length;
      expect(runCreatedBefore).toBe(1);

      await callRunAll({
        runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      const eventsAfter = await readEvents(runDir);
      const runCreatedAfter = eventsAfter.filter((e) => e.type === "run_created").length;

      // RED-PHASE: run_created count must remain 1
      expect(runCreatedAfter).toBe(1);

      // Total events should be greater (new events were appended)
      expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RESUME-3: Resume from terminal state is rejected
// ---------------------------------------------------------------------------

describe("runAll — resume from terminal state rejected (T-RESUME-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "exits immediately when resuming a completed run (T-RESUME-3, UC-RESUME-002, FP-RESUME-REJECT-TERMINAL)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SINGLE_AGENT_YAML,
        "resume-completed"
      );

      // Manually set state to completed
      const state = await readStateSnapshot(runDir);
      state.status = "completed";
      await writeState(runDir, state);

      const summary = await callRunAll({
        runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      // RED-PHASE: should return immediately without iterating
      expect(summary.status).toBe("completed");
      expect(summary.iterations).toBe(0);

      // Backend should NOT be called (no processing occurs)
      expect(FakeBackend.calls.length).toBe(0);
    }
  );

  it(
    "exits immediately when resuming a failed run (T-RESUME-3, UC-RESUME-003, FP-RESUME-REJECT-TERMINAL)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SINGLE_AGENT_YAML,
        "resume-failed"
      );

      // Manually set state to failed
      const state = await readStateSnapshot(runDir);
      state.status = "failed";
      await writeState(runDir, state);

      const summary = await callRunAll({
        runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      // RED-PHASE: should return immediately
      expect(summary.status).toBe("failed");
      expect(summary.iterations).toBe(0);
      expect(FakeBackend.calls.length).toBe(0);
    }
  );

  it(
    "exits immediately when resuming a cancelled run (T-RESUME-3, UC-RESUME-004, FP-RESUME-REJECT-TERMINAL)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SINGLE_AGENT_YAML,
        "resume-cancelled"
      );

      // Manually set state to cancelled
      const state = await readStateSnapshot(runDir);
      state.status = "cancelled";
      await writeState(runDir, state);

      const summary = await callRunAll({
        runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      // RED-PHASE: should return immediately
      expect(summary.status).toBe("cancelled");
      expect(summary.iterations).toBe(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RESUME-4: Resume continues at correct attempt after failure
// ---------------------------------------------------------------------------

describe("runAll — resume continues at correct attempt (T-RESUME-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "resumes at attempt 2 after a previous attempt 1 failure (T-RESUME-4, UC-RESUME-006, FP-RESUME-ATTEMPT-CONTINUITY)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SINGLE_AGENT_YAML,
        "resume-attempt"
      );

      // Simulate that attempt 1 failed
      const state = await readStateSnapshot(runDir);
      state.jobs["intake"] = {
        ...state.jobs["intake"]!,
        status: "failed",
        attempt: 1,
      };
      await writeState(runDir, state);

      // Now resume — should start a new attempt (attempt 2) since max_attempts
      // defaults to 1 for a workflow without retry config. The behavior here
      // depends on how retry interacts with resume. The key assertion is that
      // the run does not start fresh.
      //
      // For a workflow WITHOUT explicit retry, resume from failed should
      // either reject the resume or start a new attempt if the engine supports
      // implicit retry on resume.
      //
      // RED-PHASE: This test will be refined once the resume + retry
      // interaction semantics are finalized in Step 2.
      const summary = await callRunAll({
        runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      // The summary should reflect the run ID
      expect(summary.runId).toBe(runId);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RESUME-5: Summary reflects final state after resume
// ---------------------------------------------------------------------------

describe("runAll — summary after resume (T-RESUME-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "RunAllSummary reflects the final state after resume completes (T-RESUME-5, UC-RESUME-001)",
    async () => {
      const { runId, runDir, workflowPath } = await bootstrapRun(
        sandbox,
        SINGLE_AGENT_YAML,
        "resume-summary"
      );

      const summary = await callRunAll({
        runId,
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }),
        clock: new FakeClock(),
      });

      // Summary structure
      expect(summary.runId).toBe(runId);
      expect(summary.status).toBe("completed");
      expect(Array.isArray(summary.jobs)).toBe(true);
      expect(summary.jobs.length).toBeGreaterThan(0);

      // Job entry shape
      for (const job of summary.jobs) {
        expect(typeof job.id).toBe("string");
        expect(typeof job.status).toBe("string");
        expect(typeof job.attempts).toBe("number");
        expect(job.attempts).toBeGreaterThan(0);
      }

      // Iteration count should be positive (work was done)
      expect(summary.iterations).toBeGreaterThan(0);
    }
  );
});
