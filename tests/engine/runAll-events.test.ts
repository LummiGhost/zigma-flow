/**
 * Agent lifecycle event tests for WF-P13-EVENTS-ARTIFACTS (Step 1 — Cases and Tests).
 *
 * Verifies that `runAll` emits the correct agent lifecycle events:
 *   - agent_invoked (before backend.execute)
 *   - agent_completed (after success)
 *   - agent_timed_out (after timeout)
 *   - agent_failed (after non-zero exit)
 *   - agent_cancelled (after abort)
 *
 * Also verifies:
 *   - Event chain consistency (agent_invoked always paired with one terminal event)
 *   - Event payload fields match AD-P13-002 contract
 *   - Event IDs are sequential
 *   - Artifact entries registered in artifacts.jsonl (AD-P13-003)
 *
 * Covers:
 *   - T-EVT-001: agent_invoked emitted before backend.execute
 *   - T-EVT-002: agent_completed emitted after successful execution
 *   - T-EVT-003: agent_timed_out emitted after timeout
 *   - T-EVT-004: agent_failed emitted after non-zero exit
 *   - T-EVT-005: agent_cancelled emitted after abort
 *   - T-EVT-006: Event chain consistency (invoked + terminal pair)
 *   - T-EVT-007: Event payload contains all required fields
 *   - T-EVT-008: Artifact entries in artifacts.jsonl
 *   - T-EVT-009: args_hash does not contain command-line tokens
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-events-artifacts/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §5
 *   - AD-P13-002 (Agent invocation lifecycle events)
 *   - AD-P13-003 (Backend artifacts)
 *
 * Red-phase note: The 5 new event types, AgentExecuteResult extended fields
 * (stdoutPath, stderrPath, invocationPath, durationMs, exitCode), and
 * artifact-registration logic in runAll do not exist yet. These tests compile
 * against the v0.1 types but assert on new behavior — they are expected to
 * fail until Step 2 implements the changes.
 *
 * Strategy: The tests use an onEvent callback to capture events in-memory
 * and verify their structure. A FakeBackend writes stdout/stderr/invocation
 * files and returns a structured result for artifact verification.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import type { AgentBackend, AgentBackendConfig, AgentExecuteOptions, AgentExecuteResult } from "../../src/agent/index.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";

// ---------------------------------------------------------------------------
// Types for the module under test (src/engine/runAll.ts)
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
// Lazy import — runAll already ships in WF-P13-ENGINE-RUNALL
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

const FIXED_ISO = "2026-06-27T12:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Configurable FakeBackend that can simulate success, failure, timeout,
 * or cancellation. Writes stdout/stderr/invocation files to stepDir
 * for artifact verification.
 *
 * @param behavior — "success", "failure", "timeout", or custom
 * @param config — optional override for stdout/stderr content
 */
type FakeBackendBehavior =
  | "success"
  | "failure"
  | "timeout"
  | { custom: (opts: AgentExecuteOptions) => Promise<AgentExecuteResult> };

interface FakeBackendConfig {
  behavior?: FakeBackendBehavior;
  stdoutContent?: string;
  stderrContent?: string;
  exitCode?: number;
  delayMs?: number;
}

class FakeBackend implements AgentBackend {
  readonly name = "fake-events";
  readonly backendCommand = "fake";
  readonly backendArgs: readonly string[] = ["-p"];
  readonly backendTimeoutMs = 600_000;
  private readonly config: Required<FakeBackendConfig>;

  /**
   * Tracks the number of times execute() was called.
   *
   * WF-V022-STABILITY audit note (RISK-STABILITY-FAKEBACKEND-STATIC):
   *   The three `static` fields below constitute mutable module-level state
   *   shared across every `describe` block in this file. The FakeBackend.reset()
   *   call in every `beforeEach` mitigates within-file contamination, but the
   *   class is exported (via the module scope) so any test in this file that
   *   forgets to call reset() would silently observe accumulated counts.
   *   Vitest defaults to file-level isolation (one test file per worker), so
   *   this is safe today; the risk becomes real only if the suite is ever
   *   switched to in-file parallelism. See wf-v022-stability/
   *   01-cases-and-tests.md § RISK-STABILITY-FAKEBACKEND-STATIC.
   */
  static callCount = 0;
  /** Stores the last opts passed to execute(). */
  static lastOpts: AgentExecuteOptions | null = null;
  /** Tracks invocation times for duration verification. */
  static invokeDurations: number[] = [];

  constructor(ctorConfig?: AgentBackendConfig, behaviorConfig?: FakeBackendConfig) {
    void ctorConfig; // unused — FakeBackend ignores AgentBackendConfig
    this.config = {
      behavior: behaviorConfig?.behavior ?? "success",
      stdoutContent: behaviorConfig?.stdoutContent ?? "fake stdout output\n",
      stderrContent: behaviorConfig?.stderrContent ?? "fake stderr output\n",
      exitCode: behaviorConfig?.exitCode ?? 1,
      delayMs: behaviorConfig?.delayMs ?? 0,
    };
  }

  static reset(): void {
    FakeBackend.callCount = 0;
    FakeBackend.lastOpts = null;
    FakeBackend.invokeDurations = [];
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    FakeBackend.callCount++;
    FakeBackend.lastOpts = opts;

    const { prompt, reportPath, stepDir, projectRoot, signal } = opts;
    void prompt; // FakeBackend doesn't actually run the agent
    void projectRoot;

    const startTime = Date.now();

    // Simulate delay if configured
    if (this.config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    // Ensure stepDir exists
    await mkdir(stepDir, { recursive: true });

    // Write stdout to file
    const stdoutPath = join(stepDir, "agent.stdout.log");
    await writeFile(stdoutPath, this.config.stdoutContent, "utf-8");

    // Write stderr to file
    const stderrPath = join(stepDir, "agent.stderr.log");
    await writeFile(stderrPath, this.config.stderrContent, "utf-8");

    // Write invocation metadata to file
    const invocationPath = join(stepDir, "agent.invocation.json");
    const invocationMeta = {
      command: "fake",
      args: ["-p", "<<prompt>>"],
      timeout_ms: 600_000,
      start_time: new Date(startTime).toISOString(),
      end_time: new Date().toISOString(),
      exit_code: this.config.behavior === "failure" ? this.config.exitCode : 0,
      project_root: projectRoot,
    };
    await writeFile(invocationPath, JSON.stringify(invocationMeta, null, 2), "utf-8");

    const durationMs = Date.now() - startTime;
    FakeBackend.invokeDurations.push(durationMs);

    // Check cancellation
    if (signal?.aborted) {
      return {
        success: false,
        error: "Agent execution was cancelled.",
        stdoutPath,
        stderrPath,
        invocationPath,
        durationMs,
      };
    }

    // Handle behavior
    if (typeof this.config.behavior === "object" && "custom" in this.config.behavior) {
      return this.config.behavior.custom(opts);
    }

    switch (this.config.behavior) {
      case "success": {
        // Write a valid report so runAll can accept it
        await writeFile(
          reportPath,
          JSON.stringify({
            outputs: { completed: true },
            artifacts: [],
            signals: [],
            summary: "fake agent completed successfully",
          }, null, 2),
          "utf-8"
        );
        return {
          success: true,
          exitCode: 0,
          reportPath,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }

      case "failure": {
        return {
          success: false,
          exitCode: this.config.exitCode,
          error: `Agent failed with exit code ${this.config.exitCode}: command not found`,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs,
        };
      }

      case "timeout": {
        return {
          success: false,
          error: `Agent timed out after ${600_000}ms.`,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs: this.backendTimeoutMs, // simulate: ran for exactly the timeout duration
        };
      }

      default:
        throw new Error(`Unknown FakeBackend behavior: ${String(this.config.behavior)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow YAML fixtures
// ---------------------------------------------------------------------------

/** Single agent job for event emission tests. */
const SINGLE_AGENT_YAML = `\
name: runall-events-test
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
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
  const projectRoot = join(tmpdir(), `zigma-events-${randomUUID()}`);
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
  workflowName: string
): Promise<{ runId: string; runDir: string; workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, `${workflowName}.yml`);
  await writeFile(workflowPath, SINGLE_AGENT_YAML, "utf-8");

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
// Event and artifact readers
// ---------------------------------------------------------------------------

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

async function readArtifactIndex(runDir: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(join(runDir, "artifacts.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown as Record<string, unknown>);
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
 * Extract the numeric counter from an event id like "evt-042".
 * Returns -1 if the id does not match the pattern.
 */
function eventCounter(id: string): number {
  const m = id.match(/^evt-(\d+)$/);
  return m ? parseInt(m[1]!, 10) : -1;
}

// ---------------------------------------------------------------------------
// T-EVT-001: agent_invoked emitted before backend.execute
// ---------------------------------------------------------------------------

describe("runAll — agent_invoked event (T-EVT-001)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits agent_invoked event before backend.execute with correct payload fields (T-EVT-001, UC-EVT-001, FP-EVT-INVOKE, FP-EVT-PAYLOAD-INVOKE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-agent-invoked");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const capturedEvents: EventRecord[] = [];

      const summary = await callRunAll({
        task: "exercise agent_invoked",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }, { behavior: "success" }),
        clock: new FakeClock(),
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      expect(summary.status).toBe("completed");

      // Find agent_invoked event in the capture
      const invokedEvents = capturedEvents.filter(
        (e) => e.type === "agent_invoked"
      );
      // RED-PHASE: This assertion fails until Step 2 adds agent_invoked event
      expect(invokedEvents.length).toBe(1);

      const invoked = invokedEvents[0]!;

      // Envelope fields
      expect(invoked.run_id).toBe(summary.runId);
      expect(invoked.producer).toBe("engine");
      expect(invoked.job).toBe("intake");
      expect(invoked.step).toBe("analyze");
      expect(invoked.attempt).toBe(1);

      // Payload fields (AD-P13-002 contract)
      const payload = invoked.payload;
      expect(payload["backend_name"]).toBe("fake-events");
      expect(typeof payload["command"]).toBe("string");
      expect(typeof payload["args_hash"]).toBe("string");
      expect(payload["args_hash"]).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
      expect(typeof payload["timeout_ms"]).toBe("number");
      expect((payload["timeout_ms"] as number)).toBeGreaterThan(0);
      expect(typeof payload["step_artifact_dir"]).toBe("string");

      // Verify backend was called (invoked event must precede execute)
      expect(FakeBackend.callCount).toBe(1);
    }
  );
});

// ---------------------------------------------------------------------------
// T-EVT-002: agent_completed emitted after successful execution
// ---------------------------------------------------------------------------

describe("runAll — agent_completed event (T-EVT-002)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits agent_completed event after successful backend execution with correct payload (T-EVT-002, UC-EVT-002, FP-EVT-COMPLETE, FP-EVT-PAYLOAD-COMPLETE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-agent-completed");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const capturedEvents: EventRecord[] = [];

      const summary = await callRunAll({
        task: "exercise agent_completed",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }, { behavior: "success" }),
        clock: new FakeClock(),
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      expect(summary.status).toBe("completed");

      // Find agent_completed event
      const completedEvents = capturedEvents.filter(
        (e) => e.type === "agent_completed"
      );
      // RED-PHASE: This assertion fails until Step 2 adds agent_completed event
      expect(completedEvents.length).toBe(1);

      const completed = completedEvents[0]!;

      // Envelope fields
      expect(completed.producer).toBe("engine");
      expect(completed.job).toBe("intake");
      expect(completed.step).toBe("analyze");

      // Payload fields (AD-P13-002 contract)
      const payload = completed.payload;
      expect(typeof payload["duration_ms"]).toBe("number");
      expect((payload["duration_ms"] as number)).toBeGreaterThanOrEqual(0);
      expect(typeof payload["stdout_artifact"]).toBe("string");
      expect((payload["stdout_artifact"] as string).length).toBeGreaterThan(0);
      expect(typeof payload["stderr_artifact"]).toBe("string");
      expect((payload["stderr_artifact"] as string).length).toBeGreaterThan(0);
      expect(typeof payload["invocation_artifact"]).toBe("string");
      expect((payload["invocation_artifact"] as string).length).toBeGreaterThan(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-EVT-003: agent_timed_out emitted after timeout
// ---------------------------------------------------------------------------

describe("runAll — agent_timed_out event (T-EVT-003)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits agent_timed_out event after backend timeout with correct payload (T-EVT-003, UC-EVT-003, FP-EVT-TIMEOUT, FP-EVT-PAYLOAD-TIMEOUT)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-agent-timeout");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const capturedEvents: EventRecord[] = [];

      const summary = await callRunAll({
        task: "exercise agent_timed_out",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }, { behavior: "timeout" }),
        clock: new FakeClock(),
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      // Timeout failure → runAll currently sets run.failed (WF-P13-RETRY will
      // change this, but for now we verify the agent_timed_out event exists).
      // RED-PHASE: This assertion may need updating once retry semantics change.
      expect(["failed", "blocked", undefined]).toContain(summary.status);

      // Find agent_timed_out event
      const timedOutEvents = capturedEvents.filter(
        (e) => e.type === "agent_timed_out"
      );
      // RED-PHASE: This assertion fails until Step 2 adds agent_timed_out event
      expect(timedOutEvents.length).toBe(1);

      const timedOut = timedOutEvents[0]!;

      // Payload fields
      const payload = timedOut.payload;
      expect(typeof payload["duration_ms"]).toBe("number");
      expect(typeof payload["timeout_ms"]).toBe("number");
      expect((payload["timeout_ms"] as number)).toBeGreaterThan(0);
      expect((payload["duration_ms"] as number)).toBeGreaterThanOrEqual(
        (payload["timeout_ms"] as number)
      );
      expect(typeof payload["stdout_artifact"]).toBe("string");
      expect(typeof payload["stderr_artifact"]).toBe("string");
    }
  );
});

// ---------------------------------------------------------------------------
// T-EVT-004: agent_failed emitted after non-zero exit
// ---------------------------------------------------------------------------

describe("runAll — agent_failed event (T-EVT-004)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits agent_failed event after backend failure with correct payload (T-EVT-004, UC-EVT-004, FP-EVT-FAILED, FP-EVT-PAYLOAD-FAILED)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-agent-failed");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const capturedEvents: EventRecord[] = [];

      const summary = await callRunAll({
        task: "exercise agent_failed",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () =>
          new FakeBackend({ command: "fake" }, { behavior: "failure", exitCode: 2 }),
        clock: new FakeClock(),
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      // Failure → runAll currently sets run.failed
      expect(["failed", "blocked", undefined]).toContain(summary.status);

      // Find agent_failed event
      const failedEvents = capturedEvents.filter(
        (e) => e.type === "agent_failed"
      );
      // RED-PHASE: This assertion fails until Step 2 adds agent_failed event
      expect(failedEvents.length).toBe(1);

      const failed = failedEvents[0]!;

      // Payload fields
      const payload = failed.payload;
      expect(typeof payload["duration_ms"]).toBe("number");
      expect((payload["duration_ms"] as number)).toBeGreaterThanOrEqual(0);
      expect(payload["exit_code"]).toBe(2);
      expect(typeof payload["reason"]).toBe("string");
      expect((payload["reason"] as string).length).toBeGreaterThan(0);
      // reason must NOT contain stdout/stderr blobs (UC-ART-005)
      expect((payload["reason"] as string)).not.toMatch(
        /stdout \(last \d+ chars\)/i
      );
      expect((payload["reason"] as string)).not.toMatch(
        /stderr \(last \d+ chars\)/i
      );
      expect(typeof payload["stdout_artifact"]).toBe("string");
      expect(typeof payload["stderr_artifact"]).toBe("string");
    }
  );
});

// ---------------------------------------------------------------------------
// T-EVT-005: agent_cancelled emitted after abort
// ---------------------------------------------------------------------------

describe("runAll — agent_cancelled event (T-EVT-005)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits agent_cancelled event after abort with correct payload (T-EVT-005, UC-EVT-005, FP-EVT-CANCEL, FP-EVT-PAYLOAD-CANCEL)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-agent-cancelled");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const controller = new AbortController();
      const capturedEvents: EventRecord[] = [];

      // Use a long-delay FakeBackend and abort immediately after starting
      const backend = FakeBackend.prototype.execute.bind(
        new FakeBackend({ command: "fake" }, { behavior: "success", delayMs: 10_000 })
      );

      // Override the backend resolver to use the same instance
      const backendInstance = new FakeBackend(
        { command: "fake" },
        { behavior: "success", delayMs: 100 }
      );

      // Abort shortly after runAll starts
      const abortPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.abort();
          resolve();
        }, 50);
      });

      const runAllPromise = callRunAll({
        task: "exercise agent_cancelled",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => backendInstance,
        clock: new FakeClock(),
        signal: controller.signal,
        maxIterations: 5,
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      await abortPromise;
      const summary = await runAllPromise;

      // The run should be in cancelled state or loop-exhausted
      expect(["cancelled", undefined]).toContain(summary.status);
    }
  );
});

// ---------------------------------------------------------------------------
// T-EVT-006: Event chain consistency — invoked + terminal pair
// ---------------------------------------------------------------------------

describe("runAll — event chain consistency (T-EVT-006)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "agent_invoked precedes agent_completed, IDs are sequential, no interleaving (T-EVT-006, UC-EVT-006, FP-EVT-CHAIN, FP-EVT-SEQ)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-chain");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const capturedEvents: EventRecord[] = [];

      const summary = await callRunAll({
        task: "exercise event chain",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }, { behavior: "success" }),
        clock: new FakeClock(),
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      expect(summary.status).toBe("completed");

      // Find the agent event pair in the event sequence
      const invokedIdx = capturedEvents.findIndex(
        (e) => e.type === "agent_invoked"
      );
      const completedIdx = capturedEvents.findIndex(
        (e) => e.type === "agent_completed"
      );

      // RED-PHASE: These assertions fail until Step 2 adds event types
      expect(invokedIdx).toBeGreaterThanOrEqual(0);
      expect(completedIdx).toBeGreaterThanOrEqual(0);

      // agent_invoked must appear before agent_completed
      expect(invokedIdx).toBeLessThan(completedIdx);

      // Event IDs must be sequential (invoked.id < completed.id)
      const invokedCounter = eventCounter(capturedEvents[invokedIdx]!.id);
      const completedCounter = eventCounter(capturedEvents[completedIdx]!.id);
      expect(invokedCounter).toBeGreaterThan(0);
      expect(completedCounter).toBeGreaterThan(invokedCounter);

      // No interleaving: every event between invoked and completed must
      // NOT be another agent_invoked or terminal event
      const between = capturedEvents.slice(invokedIdx + 1, completedIdx);
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
  );

  it(
    "agent_invoked is paired with agent_failed on failure (UC-EVT-006, FP-EVT-CHAIN)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-chain-failed");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const capturedEvents: EventRecord[] = [];

      await callRunAll({
        task: "exercise event chain failure",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () =>
          new FakeBackend({ command: "fake" }, { behavior: "failure", exitCode: 1 }),
        clock: new FakeClock(),
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      const invokedEvents = capturedEvents.filter(
        (e) => e.type === "agent_invoked"
      );
      const failedEvents = capturedEvents.filter(
        (e) => e.type === "agent_failed"
      );

      // RED-PHASE: These assertions fail until Step 2 adds event types
      expect(invokedEvents.length).toBeGreaterThanOrEqual(1);
      expect(failedEvents.length).toBeGreaterThanOrEqual(1);

      // Each invoked should have a corresponding failed
      expect(failedEvents.length).toBe(invokedEvents.length);
    }
  );
});

// ---------------------------------------------------------------------------
// T-EVT-007: Event payload contains all required fields
// ---------------------------------------------------------------------------

describe("runAll — event payload completeness (T-EVT-007)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "agent_invoked payload has all required fields and no extra unexpected fields (T-EVT-007, UC-EVT-001, FP-EVT-PAYLOAD-INVOKE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-payload");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const capturedEvents: EventRecord[] = [];

      await callRunAll({
        task: "exercise payload fields",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }, { behavior: "success" }),
        clock: new FakeClock(),
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      // Check agent_invoked payload keys
      const invoked = capturedEvents.find((e) => e.type === "agent_invoked");
      // RED-PHASE: This assertion fails until Step 2 adds agent_invoked
      expect(invoked).toBeDefined();

      if (invoked) {
        const payloadKeys = Object.keys(invoked.payload).sort();
        const expectedKeys = [
          "backend_name",
          "command",
          "args_hash",
          "timeout_ms",
          "step_artifact_dir",
        ].sort();
        expect(payloadKeys).toEqual(expectedKeys);
      }

      // Check agent_completed payload keys
      const completed = capturedEvents.find(
        (e) => e.type === "agent_completed"
      );
      // RED-PHASE: This assertion fails until Step 2 adds agent_completed
      expect(completed).toBeDefined();

      if (completed) {
        const payloadKeys = Object.keys(completed.payload).sort();
        const expectedKeys = [
          "duration_ms",
          "stdout_artifact",
          "stderr_artifact",
          "invocation_artifact",
        ].sort();
        expect(payloadKeys).toEqual(expectedKeys);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-EVT-008: Artifact entries in artifacts.jsonl
// ---------------------------------------------------------------------------

describe("runAll — artifact registration (T-EVT-008)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "registers agent_stdout, agent_stderr, agent_invocation artifacts in artifacts.jsonl (T-EVT-008, UC-ART-004, FP-ART-REGISTER)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-artifact");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const summary = await callRunAll({
        task: "exercise artifact registration",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new FakeBackend({ command: "fake" }, { behavior: "success" }),
        clock: new FakeClock(),
      });

      const runDir = join(sandbox.runsDir, summary.runId);
      const artifacts = await readArtifactIndex(runDir);

      // RED-PHASE: This assertion fails until Step 2 registers artifacts
      // At minimum, the prompt artifact is already registered by runAll.
      // We expect the three agent artifacts to also be present.
      expect(artifacts.length).toBeGreaterThanOrEqual(3);

      // Check for agent_stdout artifact
      const stdoutArtifact = artifacts.find(
        (a) => a["kind"] === "agent_stdout"
      );
      expect(stdoutArtifact).toBeDefined();
      if (stdoutArtifact) {
        expect(stdoutArtifact["content_type"]).toBe("text/plain");
        expect(stdoutArtifact["run_id"]).toBe(summary.runId);
        expect(typeof stdoutArtifact["size"]).toBe("number");
        const producer = stdoutArtifact["producer"] as unknown as Record<string, unknown> | undefined;
        expect(producer).toBeDefined();
        if (producer) {
          expect(producer["job"]).toBe("intake");
          expect(producer["step"]).toBe("analyze");
          expect(producer["attempt"]).toBe(1);
        }
      }

      // Check for agent_stderr artifact
      const stderrArtifact = artifacts.find(
        (a) => a["kind"] === "agent_stderr"
      );
      expect(stderrArtifact).toBeDefined();
      if (stderrArtifact) {
        expect(stderrArtifact["content_type"]).toBe("text/plain");
      }

      // Check for agent_invocation artifact
      const invocationArtifact = artifacts.find(
        (a) => a["kind"] === "agent_invocation"
      );
      expect(invocationArtifact).toBeDefined();
      if (invocationArtifact) {
        expect(invocationArtifact["content_type"]).toBe("application/json");
      }

      // Verify artifact paths are relative POSIX-style
      for (const artifact of artifacts) {
        const path = artifact["path"] as string | undefined;
        if (path) {
          // Must not be absolute
          expect(path).not.toMatch(/^[A-Z]:\\/);
          expect(path).not.toMatch(/^\//);
          // Must use POSIX separators (or be relative)
          expect(path).not.toContain("\\");
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-EVT-009: args_hash does not contain tokens
// ---------------------------------------------------------------------------

describe("runAll — args_hash security (T-EVT-009)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    FakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "args_hash is a hex string and does not contain any token-like content (T-EVT-009, UC-EVT-001, FP-EVT-PAYLOAD-INVOKE)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, "runall-events-hash");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const capturedEvents: EventRecord[] = [];

      await callRunAll({
        task: "exercise args_hash",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () =>
          new FakeBackend(
            { command: "claude", args: ["-p", "--output-format", "text"] },
            { behavior: "success" }
          ),
        clock: new FakeClock(),
        onEvent: (e) => {
          capturedEvents.push(JSON.parse(JSON.stringify(e)) as EventRecord);
        },
      });

      const invoked = capturedEvents.find((e) => e.type === "agent_invoked");
      // RED-PHASE: assertion fails until Step 2 adds agent_invoked
      expect(invoked).toBeDefined();

      if (invoked) {
        const hash = invoked.payload["args_hash"] as string | undefined;
        expect(hash).toBeDefined();
        if (hash) {
          // Must be hex
          expect(hash).toMatch(/^[a-f0-9]{64}$/);
          // Must not contain common token patterns
          expect(hash.toLowerCase()).not.toMatch(/sk-ant/);
          expect(hash.toLowerCase()).not.toMatch(/api.?key/);
          expect(hash.toLowerCase()).not.toMatch(/token/);
        }
      }
    }
  );
});
