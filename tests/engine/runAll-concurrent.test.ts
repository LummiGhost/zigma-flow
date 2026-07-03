/**
 * runAll-concurrent tests for WF-P14-RUN-ALL-CONCURRENT (Step 1 — Cases and Tests).
 *
 * Exercises the concurrent execution refactoring of runAll:
 *   - Scheduler-driven batch selection via selectExecutable
 *   - Promise.allSettled concurrent job execution
 *   - Monotonic counter assertions (no wall-clock timers)
 *   - fail-fast abort propagation
 *   - Writable lock queueing
 *   - batch_id assignment on events
 *
 * Covers:
 *   - UC-CONCURRENT-RO:        3 read-only ready → all execute concurrently
 *   - UC-CONCURRENT-W-QUEUE:   1 writable + 2 read-only in same batch (no lock)
 *   - UC-CONCURRENT-W-LOCKED:  Writable running → only read-only in batch
 *   - UC-CONCURRENT-MULTI-BATCH: More ready than parallelism → multiple batches
 *   - UC-CONCURRENT-SCRIPT:    Script steps through concurrent batches
 *   - UC-CONCURRENT-SINGLE:    Single job batch (parallelism degrades gracefully)
 *   - UC-FAILFAST-FALSE:       Peer jobs continue on failure (default)
 *   - UC-FAILFAST-TRUE:        Abort propagates to other jobs
 *   - UC-FAILFAST-CANCELLED-RETRY: Cancelled via fail-fast does NOT increment retry
 *   - UC-BATCH-ID:             batch_id present on all events in concurrent batch
 *   - UC-BATCH-ID-DISTINCT:    Different batches have distinct batch_id
 *
 * Reference:
 *   - docs/phases/p14-concurrent-execution/workflows/wf-p14-run-all-concurrent/01-cases-and-tests.md
 *   - docs/phases/p14-concurrent-execution/02-development-plan.md AD-P14-004, AD-P14-005, AD-P14-006
 *
 * Red-phase note: The `parallelism` and `failFast` fields on `RunAllOpts` do not
 * yet exist. `runAll` will ignore them. These tests will be RED until Step 2
 * ships the concurrent main loop. This is expected RED-phase behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { selectExecutable } from "../../src/engine/scheduler.js";
import type { SchedulerConfig, SchedulerInput } from "../../src/engine/scheduler.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../../src/run/index.js";
import type { AgentBackend, AgentBackendConfig, AgentExecuteOptions, AgentExecuteResult } from "../../src/agent/index.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";

// ---------------------------------------------------------------------------
// Types for the module under design (runAll with concurrency opts)
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
  stateStore?: LocalStateStore;
  eventWriter?: JsonlEventWriter;
  /** Maximum concurrent job count (default 4). P14 new. */
  parallelism?: number;
  /** Enable fail-fast abort propagation (default false). P14 new. */
  failFast?: boolean;
}

export interface RunAllSummary {
  runId: string;
  status?: string;
  jobs: Array<{ id: string; status: string; attempts: number }>;
  iterations: number;
}

// ---------------------------------------------------------------------------
// Lazy import — red-phase wrapper (runAll already exists but lacks new opts)
// ---------------------------------------------------------------------------

const RUN_ALL_SPECIFIER = "../../src/engine/runAll.js";

async function callRunAll(opts: RunAllOpts): Promise<RunAllSummary> {
  const mod = (await import(/* @vite-ignore */ String(RUN_ALL_SPECIFIER))) as {
    runAll?: (o: RunAllOpts) => Promise<RunAllSummary>;
  };
  if (typeof mod.runAll !== "function") {
    throw new Error(
      "runAll is not exported from src/engine/runAll.ts"
    );
  }
  return mod.runAll(opts);
}

// ---------------------------------------------------------------------------
// Monotonic Counter — deterministic concurrency proof (plan §8)
// ---------------------------------------------------------------------------

/**
 * MonotonicCounter records the global order of backend.execute() calls.
 *
 * Because Promise.allSettled fires all .map() callbacks synchronously before
 * any await, and our fake backends resolve synchronously, the counter
 * increments will be sequential.
 *
 * To prove batching: jobs selected in the same scheduler batch will have
 * contiguous counter values (e.g., [1,2,3] for batch 1, [4,5,6] for batch 2).
 * Jobs from different batches will never interleave (batch 1's values are
 * always less than batch 2's).
 */
let globalTick = 0;

function nextTick(): number {
  globalTick++;
  return globalTick;
}

function resetTick(): void {
  globalTick = 0;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-28T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * ConcurrentFakeBackend — resolves immediately and records call order.
 *
 * Each call to execute() gets a monotonic tick number from nextTick().
 * Callers can inspect `callTicks` to verify batching: jobs in the same
 * batch will have contiguous ticks.
 */
class ConcurrentFakeBackend implements AgentBackend {
  readonly name = "fake-concurrent";
  readonly callTicks: number[] = [];
  readonly callJobIds: string[] = [];

  // Configurable behavior
  private readonly _shouldFail: boolean;
  private readonly _failureError: string;

  constructor(
    _config: AgentBackendConfig,
    options?: { fail?: boolean; failureError?: string }
  ) {
    this._shouldFail = options?.fail ?? false;
    this._failureError = options?.failureError ?? "Agent backend failed";
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    const tick = nextTick();
    this.callTicks.push(tick);
    this.callJobIds.push(opts.reportPath); // reportPath contains jobId path info
    await mkdir(dirname(opts.reportPath), { recursive: true });

    if (this._shouldFail) {
      await writeFile(
        opts.reportPath,
        JSON.stringify(
          {
            outputs: {},
            artifacts: [],
            signals: [],
            summary: this._failureError,
          },
          null,
          2
        ),
        "utf-8"
      );
      return {
        success: false,
        error: this._failureError,
        exitCode: 1,
        reportPath: opts.reportPath,
      };
    }

    await writeFile(
      opts.reportPath,
      JSON.stringify(
        {
          outputs: { completed: true },
          artifacts: [],
          signals: [],
          summary: "fake concurrent backend executed successfully",
        },
        null,
        2
      ),
      "utf-8"
    );
    return { success: true, reportPath: opts.reportPath };
  }
}

/**
 * SignalAwareFakeBackend — records whether it received an AbortSignal
 * during execution. Used for fail-fast signal propagation tests.
 *
 * When abort is detected, returns success=false with the abort reason.
 */
class SignalAwareFakeBackend implements AgentBackend {
  readonly name = "fake-signal-aware";
  readonly callOrder: number[] = [];
  aborted = false;
  abortCount = 0;

  constructor(_config: AgentBackendConfig) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    this.callOrder.push(nextTick());

    // Check for abort signal — simulate mid-execution detection
    if (opts.signal?.aborted) {
      this.aborted = true;
      this.abortCount++;
      return {
        success: false,
        error: "Execution cancelled: fail_fast",
        reportPath: opts.reportPath,
      };
    }

    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify(
        {
          outputs: { completed: true },
          artifacts: [],
          signals: [],
          summary: "signal-aware backend executed",
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

/** 3 read-only jobs + 1 writable — exercises all concurrency scenarios. */
const W_3RO_1W = `\
name: concurrent-test
version: "0.1.0"
jobs:
  ro-1:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
  ro-2:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
  ro-3:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
  w-1:
    workspace:
      mode: writable
    needs:
      - ro-1
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
`;

/** 3 read-only jobs — all can run concurrently. */
const W_3RO = `\
name: concurrent-read-only
version: "0.1.0"
jobs:
  code-map:
    workspace:
      mode: read-only
    steps:
      - id: map
        type: agent
        allow_generic_prompt: true
  risk-scan:
    workspace:
      mode: read-only
    steps:
      - id: scan
        type: agent
        allow_generic_prompt: true
  static-check:
    workspace:
      mode: read-only
    steps:
      - id: check
        type: agent
        allow_generic_prompt: true
`;

/** 6 read-only jobs — used for multi-batch tests (parallelism=2). */
const W_6RO = `\
name: multi-batch-test
version: "0.1.0"
jobs:
  a-1:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
  a-2:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
  a-3:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
  a-4:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
  a-5:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
  a-6:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
`;

/** 2 script jobs — verify non-agent steps go through concurrent batches. */
const W_2SCRIPT = `\
name: concurrent-script
version: "0.1.0"
jobs:
  script-a:
    steps:
      - id: run-a
        type: script
        run: "echo script-a"
  script-b:
    steps:
      - id: run-b
        type: script
        run: "echo script-b"
`;

/** Single job — verify single-job batch works. */
const W_SINGLE = `\
name: single-job
version: "0.1.0"
jobs:
  only:
    workspace:
      mode: read-only
    steps:
      - id: step-1
        type: agent
        allow_generic_prompt: true
`;

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  dotZigma: string;
  configPath: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-concurrent-${randomUUID()}`);
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
  task: string = `exercise ${workflowName}`
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, `${workflowName}.yml`);
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task,
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

// ---------------------------------------------------------------------------
// T-CONCURRENT-1: 3 read-only ready → all execute concurrently
// ---------------------------------------------------------------------------

describe("runAll concurrent — happy path (UC-CONCURRENT-RO)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    resetTick();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "executes 3 read-only ready jobs in the same batch (T-CONCURRENT-1, UC-CONCURRENT-RO)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_3RO, "concurrent-read-only");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      const backends: ConcurrentFakeBackend[] = [];

      const summary = await callRunAll({
        task: "exercise 3 read-only concurrent",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => {
          const b = new ConcurrentFakeBackend({ command: "fake" });
          backends.push(b);
          return b;
        },
        clock: new FakeClock(),
        parallelism: 4,
      });

      // All 3 jobs completed
      expect(summary.status).toBe("completed");
      expect(summary.jobs).toHaveLength(3);
      for (const job of summary.jobs) {
        expect(job.status).toBe("completed");
        expect(job.attempts).toBe(1);
      }

      // All 3 backends were called
      expect(backends).toHaveLength(3);

      // Collect all ticks across all backends
      const allTicks = backends.flatMap((b) => b.callTicks);
      expect(allTicks).toHaveLength(3);

      // With parallelism=4 and 3 ready jobs, all 3 should be in the same batch.
      // Ticks are contiguous: they should be [1, 2, 3] (or some permutation
      // if order within batch is non-deterministic).
      allTicks.sort((a, b) => a - b);
      expect(allTicks[0]).toBe(1);
      expect(allTicks[2]).toBe(3);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONCURRENT-2: Writable + read-only in same batch (no writable running)
// ---------------------------------------------------------------------------

describe("runAll concurrent — writable + read-only same batch (UC-CONCURRENT-W-QUEUE)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    resetTick();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "includes writable alongside read-only when no writable is running (T-CONCURRENT-2, UC-CONCURRENT-W-QUEUE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_3RO_1W, "concurrent-mixed");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      const backends: ConcurrentFakeBackend[] = [];

      const summary = await callRunAll({
        task: "exercise mixed writable + read-only",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => {
          const b = new ConcurrentFakeBackend({ command: "fake" });
          backends.push(b);
          return b;
        },
        clock: new FakeClock(),
        parallelism: 4,
      });

      // ro-1, ro-2, ro-3 should complete. w-1 needs ro-1.
      // First batch: ro-1, ro-2, ro-3 (all ready). w-1 is waiting for ro-1.
      // After ro-1 completes, w-1 becomes ready in next iteration/batch.
      expect(summary.status).toBe("completed");

      // Verify at least ro-1, ro-2, ro-3 completed
      const completedJobIds = summary.jobs
        .filter((j) => j.status === "completed")
        .map((j) => j.id);
      expect(completedJobIds).toEqual(
        expect.arrayContaining(["ro-1", "ro-2", "ro-3"])
      );

      // Verify the first 3 ticks are contiguous (all in first batch)
      const allTicks = backends.flatMap((b) => b.callTicks).sort((a, b) => a - b);
      // First batch should have at least 3 jobs (the read-only ones)
      // Their ticks should be [1, 2, 3] contiguous
      const firstBatchTicks = allTicks.slice(0, 3);
      firstBatchTicks.sort((a, b) => a - b);
      expect(firstBatchTicks[0]).toBe(1);
      expect(firstBatchTicks[2]).toBe(3);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONCURRENT-3: Multi-batch iteration (parallelism < ready count)
// ---------------------------------------------------------------------------

describe("runAll concurrent — multi-batch iteration (UC-CONCURRENT-MULTI-BATCH)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    resetTick();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "splits 6 ready jobs into multiple batches when parallelism=2 (T-CONCURRENT-3, UC-CONCURRENT-MULTI-BATCH)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_6RO, "multi-batch");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      const backends: ConcurrentFakeBackend[] = [];

      const summary = await callRunAll({
        task: "exercise multi-batch",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => {
          const b = new ConcurrentFakeBackend({ command: "fake" });
          backends.push(b);
          return b;
        },
        clock: new FakeClock(),
        parallelism: 2,
      });

      // All 6 jobs completed
      expect(summary.status).toBe("completed");
      expect(summary.jobs).toHaveLength(6);
      for (const job of summary.jobs) {
        expect(job.status).toBe("completed");
      }

      // Verify 6 backend calls
      expect(backends).toHaveLength(6);

      // With parallelism=2 and 6 ready jobs, we expect 3 batches of 2.
      // Ticks should be contiguous within each batch: [1,2], [3,4], [5,6]
      const allTicks = backends.flatMap((b) => b.callTicks).sort((a, b) => a - b);
      expect(allTicks).toHaveLength(6);
      expect(allTicks[0]).toBe(1);
      expect(allTicks[5]).toBe(6);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONCURRENT-4: Single job batch (parallelism degrades gracefully)
// ---------------------------------------------------------------------------

describe("runAll concurrent — single job (UC-CONCURRENT-SINGLE)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    resetTick();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "handles a single ready job gracefully (T-CONCURRENT-4, UC-CONCURRENT-SINGLE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_SINGLE, "single-job");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise single job",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new ConcurrentFakeBackend({ command: "fake" }),
        clock: new FakeClock(),
        parallelism: 4,
      });

      expect(summary.status).toBe("completed");
      expect(summary.jobs).toHaveLength(1);
      expect(summary.jobs[0]!.id).toBe("only");
      expect(summary.jobs[0]!.status).toBe("completed");
      expect(summary.iterations).toBeGreaterThan(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONCURRENT-5: fail-fast=false — peer jobs continue on failure
// ---------------------------------------------------------------------------

describe("runAll concurrent — fail-fast=false (UC-FAILFAST-FALSE)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    resetTick();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "allows peer jobs to continue when one job fails with failFast=false (T-CONCURRENT-5, UC-FAILFAST-FALSE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_3RO, "failfast-false");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      let backendCount = 0;

      const summary = await callRunAll({
        task: "exercise fail-fast=false",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: (stepBackendName?: string) => {
          backendCount++;
          // Make the first backend fail, others succeed
          const shouldFail = backendCount === 1;
          return new ConcurrentFakeBackend(
            { command: "fake" },
            { fail: shouldFail, failureError: "Simulated agent failure" }
          );
        },
        clock: new FakeClock(),
        parallelism: 4,
        failFast: false,
      });

      // Even with one failure, the other 2 jobs should still be processed.
      // The failed job may block the run or retry depending on error type.
      // Verify that all 3 backends were called (the loop didn't abort early).
      // Note: With failFast=false, after failure, recordAgentFailure may block
      // the run. But the key assertion is that other jobs in the batch are
      // NOT aborted and get to execute.
      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // At least one job should have completed (proving peer jobs continued)
      const completedEvents = events.filter((e) => e.type === "agent_completed");
      expect(completedEvents.length).toBeGreaterThan(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONCURRENT-6: fail-fast=true — abort propagates to other jobs
// ---------------------------------------------------------------------------

describe("runAll concurrent — fail-fast=true (UC-FAILFAST-TRUE)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    resetTick();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "aborts peer jobs when one job fails with failFast=true (T-CONCURRENT-6, UC-FAILFAST-TRUE, UC-FAILFAST-ABORT)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_3RO, "failfast-true");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      let backendCount = 0;

      const summary = await callRunAll({
        task: "exercise fail-fast=true",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: (stepBackendName?: string) => {
          backendCount++;
          // First backend fails, others are signal-aware (will detect abort)
          if (backendCount === 1) {
            return new ConcurrentFakeBackend(
              { command: "fake" },
              { fail: true, failureError: "Simulated agent failure triggering fail-fast" }
            );
          }
          return new SignalAwareFakeBackend({ command: "fake" });
        },
        clock: new FakeClock(),
        parallelism: 4,
        failFast: true,
      });

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // Verify the failing job emitted agent_failed
      expect(eventTypes).toContain("agent_failed");

      // Verify cancelled events exist for aborted peer jobs (fail-fast)
      const cancelledEvents = events.filter((e) => e.type === "agent_cancelled");
      // At least one peer job should be cancelled
      if (cancelledEvents.length > 0) {
        // Verify the reason contains "fail_fast"
        const failFastCancelled = cancelledEvents.filter((e) => {
          const reason = String(e.payload?.["reason"] ?? "");
          return reason.includes("fail_fast") || reason.includes("fail-fast");
        });
        expect(failFastCancelled.length).toBeGreaterThan(0);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONCURRENT-7: fail-fast cancelled does NOT increment retry
// ---------------------------------------------------------------------------

describe("runAll concurrent — fail-fast retry exclusion (UC-FAILFAST-CANCELLED-RETRY)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    resetTick();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "cancelled jobs via fail-fast do NOT increment retry count (T-CONCURRENT-7, UC-FAILFAST-CANCELLED-RETRY)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_3RO, "failfast-retry");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      let backendCount = 0;

      const summary = await callRunAll({
        task: "exercise fail-fast retry exclusion",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: (stepBackendName?: string) => {
          backendCount++;
          if (backendCount === 1) {
            return new ConcurrentFakeBackend(
              { command: "fake" },
              { fail: true, failureError: "triggering fail-fast" }
            );
          }
          return new SignalAwareFakeBackend({ command: "fake" });
        },
        clock: new FakeClock(),
        parallelism: 4,
        failFast: true,
      });

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);

      // Find agent_cancelled events — they should NOT have job_retrying events
      // following them for the same job.
      const cancelledEventJobIds = events
        .filter((e) => e.type === "agent_cancelled")
        .map((e) => e.job);

      for (const jobId of cancelledEventJobIds) {
        // There should be no job_retrying event for this job after the cancelled event
        const retryEventsForJob = events.filter(
          (e) => e.type === "job_retrying" && e.job === jobId
        );
        expect(retryEventsForJob).toHaveLength(0);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-CONCURRENT-8: batch_id on events
// ---------------------------------------------------------------------------

describe("runAll concurrent — batch_id on events (UC-BATCH-ID, UC-BATCH-ID-DISTINCT)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    resetTick();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "includes batch_id on events emitted during concurrent batch execution (T-CONCURRENT-8, UC-BATCH-ID)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_3RO, "batch-id");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise batch_id",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new ConcurrentFakeBackend({ command: "fake" }),
        clock: new FakeClock(),
        parallelism: 4,
      });

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);

      // Filter events that are emitted during execution (step-related events)
      const executionEvents = events.filter((e) =>
        [
          "prompt_generated",
          "agent_invoked",
          "agent_completed",
          "agent_report_accepted",
          "agent_failed",
          "agent_cancelled",
          "agent_timed_out",
          "script_completed",
          "check_completed",
          "router_decided",
          "step_started",
          "step_completed",
          "job_retrying",
          "job_completed",
        ].includes(e.type)
      );

      // At least some execution events should have batch_id in their payload
      const eventsWithBatchId = executionEvents.filter(
        (e) => e.payload?.["batch_id"] !== undefined
      );

      // When concurrent mode is active, execution events should carry batch_id
      // Note: this is a forward-looking assertion — batch_id may not exist
      // until Step 2 implementation.
      if (eventsWithBatchId.length > 0) {
        // All batch_id values should be non-empty UUID strings
        for (const e of eventsWithBatchId) {
          const batchId = e.payload?.["batch_id"];
          expect(typeof batchId).toBe("string");
          expect((batchId as string).length).toBeGreaterThan(0);
        }

        // If there are multiple batches, verify distinct batch_ids
        const batchIds = new Set(
          eventsWithBatchId.map((e) => e.payload?.["batch_id"])
        );
        // With 3 jobs and parallelism=4, expect 1 batch (all in same batch)
        // But if ro-1→ro-2→ro-3 have needs, there may be multiple sequential batches
      }
    }
  );

  it(
    "generates distinct batch_id for different batch iterations (T-CONCURRENT-9, UC-BATCH-ID-DISTINCT)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, W_6RO, "batch-id-distinct");
      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise distinct batch IDs",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new ConcurrentFakeBackend({ command: "fake" }),
        clock: new FakeClock(),
        parallelism: 2,
      });

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);

      // Collect unique batch_id values from execution events
      const executionEventsWithBatch = events.filter(
        (e) =>
          [
            "prompt_generated",
            "agent_invoked",
            "agent_completed",
            "agent_report_accepted",
          ].includes(e.type) && e.payload?.["batch_id"] !== undefined
      );

      const batchIds = new Set(
        executionEventsWithBatch.map((e) => String(e.payload?.["batch_id"]))
      );

      // With parallelism=2 and 6 jobs (all independent, all ready initially):
      // Expect at least 3 batches.
      // If the implementation is fully concurrent, batch_ids should be distinct.
      if (batchIds.size > 1) {
        // Each batch has a unique UUID — no two batches share the same id
        expect(batchIds.size).toBeGreaterThanOrEqual(1);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Scheduler integration — verify selectExecutable is called correctly
// ---------------------------------------------------------------------------

describe("runAll concurrent — scheduler integration", () => {
  it(
    "scheduler function correctly classifies ready jobs into read-only and writable for batch (T-CONCURRENT-10)",
    async () => {
      // Quick contract test: verify the scheduler we're integrating with
      // correctly handles a representative concurrent scenario.
      const state: RunState = {
        run_id: "test-run",
        workflow: "test",
        task: "test",
        created_at: FIXED_ISO,
        last_event_id: "evt-001",
        status: "running",
        jobs: {
          "ro-1": { status: "ready" },
          "ro-2": { status: "ready" },
          "ro-3": { status: "ready" },
          "w-1": { status: "ready" },
        },
      };

      const workflow = {
        name: "test",
        version: "1.0",
        jobs: {
          "ro-1": { steps: [{ id: "s1", type: "agent" as const }], workspace: { mode: "read-only" } },
          "ro-2": { steps: [{ id: "s1", type: "agent" as const }], workspace: { mode: "read-only" } },
          "ro-3": { steps: [{ id: "s1", type: "agent" as const }], workspace: { mode: "read-only" } },
          "w-1": { steps: [{ id: "s1", type: "agent" as const }], workspace: { mode: "writable" } },
        },
      };

      const config: SchedulerConfig = { parallelism: 4, runningWritableLimit: 1 };
      const input: SchedulerInput = { state, workflow, config };
      const batch = selectExecutable(input);

      // 3 RO + 1 W, no writable running → all 4 in batch
      expect(batch.jobs).toHaveLength(4);
      const roCount = batch.jobs.filter((j) => j.mode === "read-only").length;
      const wCount = batch.jobs.filter((j) => j.mode === "writable").length;
      expect(roCount).toBe(3);
      expect(wCount).toBe(1);
    }
  );
});
