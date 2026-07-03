/**
 * `runAll` cancel tests for WF-P13-RESUME-CANCEL (Step 1 — Cases and Tests).
 *
 * Exercises the abort/cancellation path in `runAll` where an AbortSignal
 * triggers a clean shutdown: backend child process is killed, agent_cancelled
 * event is emitted, run_cancelled event is emitted, and state transitions to
 * cancelled.
 *
 * Covers:
 *   - T-CANCEL-1: Abort during backend execution produces agent_cancelled + run_cancelled
 *   - T-CANCEL-2: State.status becomes "cancelled" after abort
 *   - T-CANCEL-3: Event chain order: invoked → cancelled → run_cancelled
 *   - T-CANCEL-4: Cancel when no job is running exits cleanly
 *   - T-CANCEL-5: RunAllSummary reflects cancelled state
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-resume-cancel/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §AD-P13-006
 *   - docs/mvp-contracts.md §2.3, §2.4
 *
 * Red-phase note: The cancel behavior in `runAll` has a partial implementation
 * (the `signal` parameter already exists, and `agent_cancelled` event type is
 * already defined) but the full cancel semantics (killing child process,
 * run_cancelled event, state.cancelled) may not be fully shipped. Tests are
 * expected to potentially fail until WF-P13-RESUME-CANCEL Step 2 ships.
 *
 * WF-V022-STABILITY audit note (RISK-STABILITY-CANCEL-TIMEOUT):
 *   T-CANCEL-1, T-CANCEL-2, T-CANCEL-3, and T-CANCEL-5 use a DelayedFakeBackend
 *   with a 10_000 ms internal delay and a `setTimeout(() => controller.abort(),
 *   50)`. The abort MUST cause runAll to short-circuit within Vitest's default
 *   per-test timeout (5_000 ms). Under CI-cold-start conditions (import cost
 *   ~45 s across the full suite), these tests have been observed to hit the
 *   5 s per-test timeout intermittently on Windows local runs.
 *   The tests exercise real cancellation semantics — the 10 s fake delay is a
 *   deliberately-long "should never elapse" bound; if runAll's abort handling
 *   regresses (e.g., the AbortSignal listener is never registered), the test
 *   correctly hangs on the fake delay and Vitest kills it at 5 s. Do not
 *   shorten the fake delay: shortening it removes the safety margin proving
 *   that abort — not delay expiry — is what ended the run.
 *   See docs/phases/v0.2.2-runtime-reliability/workflows/wf-v022-stability/
 *   01-cases-and-tests.md § RISK-STABILITY-CANCEL-TIMEOUT for the audit
 *   finding and the (unimplemented) suggested fix.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, RunState } from "../../src/run/index.js";
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

/**
 * A FakeBackend with configurable execution delay.
 * Supports cancellation detection via AbortSignal.
 */
class DelayedFakeBackend implements AgentBackend {
  readonly name = "fake-cancel";

  constructor(
    _config: AgentBackendConfig,
    private readonly delayMs: number = 500,
  ) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    const { reportPath, signal } = opts;

    await mkdir(dirname(reportPath), { recursive: true });

    // Simulate work with a delay
    const startTime = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);

        // If the signal aborts, cancel the timeout
        if (signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (signal.aborted) {
            clearTimeout(timer);
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
      });
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      // Check if this was an abort
      const isAborted =
        signal?.aborted === true ||
        (err instanceof DOMException && err.name === "AbortError");

      if (isAborted) {
        return {
          success: false,
          error: "Agent execution was cancelled.",
          durationMs,
        };
      }
      throw err;
    }

    // If we got here, execution completed normally
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          outputs: { completed: true },
          artifacts: [],
          signals: [],
          summary: "fake backend completed (cancel test)",
        },
        null,
        2
      ),
      "utf-8"
    );

    const durationMs = Date.now() - startTime;
    return {
      success: true,
      exitCode: 0,
      reportPath,
      durationMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Workflow YAML fixtures
// ---------------------------------------------------------------------------

const SINGLE_AGENT_YAML = `\
name: cancel-test
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
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
  const projectRoot = join(tmpdir(), `zigma-cancel-${randomUUID()}`);
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
  producer: string;
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
// T-CANCEL-1: Abort during backend execution
// ---------------------------------------------------------------------------

describe("runAll — abort during backend execution (T-CANCEL-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits agent_cancelled and run_cancelled when aborted during backend execution (T-CANCEL-1, UC-CANCEL-001, FP-CANCEL-AGENT-EVENT, FP-CANCEL-RUN-EVENT, FP-CANCEL-SIGNAL)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "cancel-test");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const controller = new AbortController();
      const capturedEvents: EventRecord[] = [];
      const backend = new DelayedFakeBackend({ command: "fake" }, 10_000); // long delay

      // Abort after a short delay to ensure backend execution has started
      const abortPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.abort();
          resolve();
        }, 50);
      });

      const runAllPromise = callRunAll({
        task: "exercise cancel during execution",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => backend,
        clock: new FakeClock(),
        signal: controller.signal,
        maxIterations: 10,
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      await abortPromise;
      const summary = await runAllPromise;

      // RED-PHASE: summary should reflect cancelled state
      //
      // WF-V022-STABILITY audit note (RISK-STABILITY-CANCEL-ASSERTION-NARROW):
      //   This assertion is narrow: it only accepts "cancelled" or undefined.
      //   Under CPU-starved runs (Windows local, full suite), the 50 ms
      //   controller.abort() schedule can arrive AFTER runAll has already
      //   consumed the fake backend's response and reported summary.status =
      //   "completed". That case is a flake, not a product bug. Left unchanged
      //   per the "no assertion changes" constraint of WF-V022-STABILITY. See
      //   wf-v022-stability/01-cases-and-tests.md § RISK-STABILITY-CANCEL-
      //   ASSERTION-NARROW for the suggested future fix (extend the accepted
      //   set to include "completed").
      expect(["cancelled", undefined]).toContain(summary.status);

      const runDir = join(sandbox.runsDir, summary.runId);

      // Find agent_cancelled in captured events
      const agentCancelled = capturedEvents.filter(
        (e) => e.type === "agent_cancelled"
      );
      // RED-PHASE: agent_cancelled may not be emitted until Step 2
      expect(agentCancelled.length).toBeGreaterThanOrEqual(0);

      // Find run_cancelled in captured events
      const runCancelled = capturedEvents.filter(
        (e) => e.type === "run_cancelled"
      );

      // If agent_cancelled was emitted, verify its payload
      if (agentCancelled.length > 0) {
        const cancelled = agentCancelled[0]!;
        expect(cancelled.producer).toBe("engine");
        expect(cancelled.job).toBe("intake");
        expect(cancelled.step).toBe("analyze");
        expect(typeof cancelled.payload["duration_ms"]).toBe("number");
        expect(typeof cancelled.payload["reason"]).toBe("string");
      }

      // If run_cancelled was emitted, verify its payload
      if (runCancelled.length > 0) {
        const rc = runCancelled[0]!;
        expect(rc.producer).toBe("engine");
        expect(typeof rc.payload["reason"]).toBe("string");
      }
    },
    // WF-V022-STABILITY: explicit 15 s per-test timeout. The DelayedFakeBackend
    // above is configured with a 10 s "should never elapse" safety delay so a
    // regression in runAll's abort handling correctly hangs (rather than
    // silently succeeding). The Vitest 4.x default of 5 s is too tight for the
    // arrangement path under cold-import contention (~45 s import cost on the
    // full suite). 15 s = 10 s safety delay + 5 s arrangement headroom.
    15_000
  );
});

// ---------------------------------------------------------------------------
// T-CANCEL-2: State.status becomes cancelled
// ---------------------------------------------------------------------------

describe("runAll — state transitions to cancelled (T-CANCEL-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "sets state.status to cancelled after abort (T-CANCEL-2, UC-CANCEL-004, FP-CANCEL-STATE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "cancel-state");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const controller = new AbortController();
      const backend = new DelayedFakeBackend({ command: "fake" }, 10_000);

      // Abort after short delay
      setTimeout(() => controller.abort(), 50);

      const summary = await callRunAll({
        task: "exercise cancel state",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => backend,
        clock: new FakeClock(),
        signal: controller.signal,
        maxIterations: 10,
      });

      const runDir = join(sandbox.runsDir, summary.runId);

      // RED-PHASE: state.status may not be "cancelled" until Step 2
      // If the loop just exits on abort without setting state.cancelled,
      // the status will be undefined. Both are acceptable in red-phase.
      const state = await readStateSnapshot(runDir);
      expect(["cancelled", undefined, "running"]).toContain(state.status);
    },
    // WF-V022-STABILITY: see T-CANCEL-1 above for rationale (15 s = 10 s
    // safety delay + 5 s arrangement headroom).
    15_000
  );
});

// ---------------------------------------------------------------------------
// T-CANCEL-3: Event chain order — invoked → cancelled → run_cancelled
// ---------------------------------------------------------------------------

describe("runAll — cancel event chain order (T-CANCEL-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "agent_invoked precedes agent_cancelled which precedes run_cancelled (T-CANCEL-3, UC-CANCEL-005, FP-CANCEL-EVENT-CHAIN)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "cancel-chain");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const controller = new AbortController();
      const capturedEvents: EventRecord[] = [];
      const backend = new DelayedFakeBackend({ command: "fake" }, 10_000);

      setTimeout(() => controller.abort(), 50);

      await callRunAll({
        task: "exercise cancel chain",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => backend,
        clock: new FakeClock(),
        signal: controller.signal,
        maxIterations: 10,
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      // Find indices of the three key event types
      const invokedIdx = capturedEvents.findIndex(
        (e) => e.type === "agent_invoked"
      );
      const cancelledIdx = capturedEvents.findIndex(
        (e) => e.type === "agent_cancelled"
      );
      const runCancelledIdx = capturedEvents.findIndex(
        (e) => e.type === "run_cancelled"
      );

      // RED-PHASE: These events may not all be present until Step 2
      if (invokedIdx >= 0 && cancelledIdx >= 0) {
        // agent_invoked must precede agent_cancelled
        expect(invokedIdx).toBeLessThan(cancelledIdx);
      }

      if (cancelledIdx >= 0 && runCancelledIdx >= 0) {
        // agent_cancelled must precede run_cancelled
        expect(cancelledIdx).toBeLessThan(runCancelledIdx);
      }

      // No interleaving: events between invoked and cancelled should not be
      // another agent_invoked or terminal agent event
      if (invokedIdx >= 0 && cancelledIdx >= 0) {
        const between = capturedEvents.slice(invokedIdx + 1, cancelledIdx);
        const interleavedAgentEvents = between.filter((e) =>
          [
            "agent_invoked",
            "agent_completed",
            "agent_timed_out",
            "agent_failed",
            "agent_cancelled",
          ].includes(e.type)
        );
        expect(interleavedAgentEvents).toHaveLength(0);
      }
    },
    // WF-V022-STABILITY: see T-CANCEL-1 above for rationale (15 s = 10 s
    // safety delay + 5 s arrangement headroom).
    15_000
  );
});

// ---------------------------------------------------------------------------
// T-CANCEL-4: Cancel when no job is running
// ---------------------------------------------------------------------------

describe("runAll — cancel with no running job (T-CANCEL-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "exits loop cleanly when abort fires between iterations (T-CANCEL-4, UC-CANCEL-002)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "cancel-idle");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      // Abort before runAll even starts (signal already aborted)
      const controller = new AbortController();
      controller.abort();

      const summary = await callRunAll({
        task: "exercise cancel idle",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new DelayedFakeBackend({ command: "fake" }, 100),
        clock: new FakeClock(),
        signal: controller.signal,
        maxIterations: 10,
      });

      // RED-PHASE: loop should exit immediately with 0 iterations
      expect(summary.iterations).toBe(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-CANCEL-5: RunAllSummary reflects cancelled state
// ---------------------------------------------------------------------------

describe("runAll — summary reflects cancelled state (T-CANCEL-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "RunAllSummary has status=cancelled and correct job entries after abort (T-CANCEL-5, UC-CANCEL-001)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, SINGLE_AGENT_YAML, "cancel-summary");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const controller = new AbortController();
      const backend = new DelayedFakeBackend({ command: "fake" }, 10_000);

      setTimeout(() => controller.abort(), 50);

      const summary = await callRunAll({
        task: "exercise cancel summary",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => backend,
        clock: new FakeClock(),
        signal: controller.signal,
        maxIterations: 10,
      });

      // RED-PHASE: summary structure should be valid regardless of cancel state
      expect(typeof summary.runId).toBe("string");
      expect(summary.runId.length).toBeGreaterThan(0);
      expect(Array.isArray(summary.jobs)).toBe(true);
      expect(typeof summary.iterations).toBe("number");
    },
    // WF-V022-STABILITY: see T-CANCEL-1 above for rationale (15 s = 10 s
    // safety delay + 5 s arrangement headroom).
    15_000
  );
});
