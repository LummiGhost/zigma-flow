/**
 * `recordAgentFailure` tests for WF-P13-RETRY (Step 1 — Cases and Tests).
 *
 * Exercises the Engine entry point that handles agent backend failures by
 * routing through the workflow's retry configuration instead of directly
 * setting `run.failed`.
 *
 * Covers:
 *   - T-RETRYF-1: Retry succeeds on 2nd attempt (attempt=1 fails, attempt=2 succeeds)
 *   - T-RETRYF-2: Max_attempts exceeded with default on_exceeded (job blocked)
 *   - T-RETRYF-3: Max_attempts exceeded with on_exceeded.status=failed
 *   - T-RETRYF-4: ConfigError bypasses retry (direct run.failed)
 *   - T-RETRYF-5: PermissionError bypasses retry (direct run.failed)
 *   - T-RETRYF-6: Timeout failure is retryable
 *   - T-RETRYF-7: step_failed event payload correctness
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-retry/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md §AD-P13-004
 *   - docs/mvp-contracts.md §2.3, §2.4
 *
 * Red-phase note: `src/engine/recordAgentFailure.ts` does not yet exist.
 * Tests are designed to exercise the retry behavior through runAll (which will
 * call recordAgentFailure internally). The lazy import wrapper below catches
 * the dynamic-import failure and re-throws a descriptive Error so the test
 * file compiles and every test fails for the same diagnostic reason until
 * WF-P13-RETRY Step 2 ships the module.
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
import { ConfigError, PermissionError } from "../../src/utils/index.js";

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
      `runAll is not yet implemented — src/engine/runAll.ts does not exist (WF-P13-RETRY Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.runAll !== "function") {
    throw new Error(
      "runAll is not exported from src/engine/runAll.ts — WF-P13-RETRY Step 2 has not yet shipped the implementation."
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
 * A configurable FakeBackend that can simulate success, failure, timeout,
 * ConfigError, or PermissionError on a per-attempt basis.
 *
 * @param behaviors — array of behaviors, one per call to execute().
 *   The first call uses behaviors[0], the second behaviors[1], etc.
 *   If more calls than behaviors, the last behavior is reused.
 */
type BackendBehavior =
  | "success"
  | "failure"
  | "timeout"
  | { throws: "ConfigError" | "PermissionError"; message?: string };

class RetryFakeBackend implements AgentBackend {
  readonly name = "fake-retry";
  static calls: AgentExecuteOptions[] = [];
  static lastBehavior: string = "none";

  private callIndex = 0;

  constructor(
    _config: AgentBackendConfig,
    private readonly behaviors: BackendBehavior[] = ["success"],
  ) {}

  static reset(): void {
    RetryFakeBackend.calls = [];
    RetryFakeBackend.lastBehavior = "none";
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    RetryFakeBackend.calls.push(opts);

    const behavior = this.behaviors[this.callIndex] ?? this.behaviors[this.behaviors.length - 1]!;
    this.callIndex++;
    RetryFakeBackend.lastBehavior = typeof behavior === "string" ? behavior : behavior.throws;

    await mkdir(dirname(opts.reportPath), { recursive: true });

    // If behavior is a throw instruction, throw the error (simulates backend
    // resolver or constructor failure)
    if (typeof behavior === "object" && "throws" in behavior) {
      if (behavior.throws === "ConfigError") {
        throw new ConfigError(
          behavior.message ?? `Agent backend "fake-retry" is not configured.`,
          {
            details: { backendName: "fake-retry" },
            suggestion: "Add a backends entry to .zigma-flow/config.json.",
          }
        );
      }
      if (behavior.throws === "PermissionError") {
        throw new PermissionError(
          behavior.message ?? "Claude Code is not logged in. Please run `claude login` first.",
          {
            details: { kind: "auth" },
            suggestion: "Run `claude login` to authenticate.",
          }
        );
      }
    }

    const stdoutPath = join(dirname(opts.reportPath), "agent.stdout.log");
    const stderrPath = join(dirname(opts.reportPath), "agent.stderr.log");
    const invocationPath = join(dirname(opts.reportPath), "agent.invocation.json");

    await writeFile(stdoutPath, "fake stdout\n", "utf-8");
    await writeFile(stderrPath, "fake stderr\n", "utf-8");
    await writeFile(
      invocationPath,
      JSON.stringify({ command: "fake", args: ["-p", "<<prompt>>"] }, null, 2),
      "utf-8"
    );

    switch (behavior) {
      case "success": {
        await writeFile(
          opts.reportPath,
          JSON.stringify({
            outputs: { completed: true },
            artifacts: [],
            signals: [],
            summary: "fake backend succeeded",
          }, null, 2),
          "utf-8"
        );
        return {
          success: true,
          exitCode: 0,
          reportPath: opts.reportPath,
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs: 100,
        };
      }

      case "failure": {
        return {
          success: false,
          exitCode: 1,
          error: "Agent backend failed: command returned exit code 1",
          stdoutPath,
          stderrPath,
          invocationPath,
          durationMs: 100,
        };
      }

      case "timeout": {
        return {
          success: false,
          error: "Agent timed out after 600000ms.",
          stdoutPath,
          stderrPath,
          durationMs: 610_000,
        };
      }

      default:
        throw new Error(`Unknown behavior: ${String(behavior)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow YAML fixtures
// ---------------------------------------------------------------------------

/** Single agent job with retry enabled (max_attempts: 2). */
const RETRY_HEADROOM_YAML = `\
name: retry-headroom
version: "0.1.0"
jobs:
  intake:
    retry:
      max_attempts: 2
    steps:
      - id: analyze
        type: agent
        uses: zigma/analyze-skill
`;

/** Retry with max_attempts: 1 — first failure exhausts attempts, default on_exceeded. */
const RETRY_EXCEEDED_DEFAULT_YAML = `\
name: retry-exceeded-default
version: "0.1.0"
jobs:
  intake:
    retry:
      max_attempts: 1
    steps:
      - id: analyze
        type: agent
        uses: zigma/analyze-skill
`;

/** Retry with max_attempts: 2 and on_exceeded.status: "failed". */
const RETRY_ON_EXCEEDED_FAILED_YAML = `\
name: retry-on-exceeded-failed
version: "0.1.0"
jobs:
  intake:
    retry:
      max_attempts: 2
      on_exceeded:
        status: failed
    steps:
      - id: analyze
        type: agent
        uses: zigma/analyze-skill
`;

/** No retry configured (default — should not retry). */
const NO_RETRY_YAML = `\
name: retry-none
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
  const projectRoot = join(tmpdir(), `zigma-retryf-${randomUUID()}`);
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
// T-RETRYF-1: Retry succeeds on 2nd attempt
// ---------------------------------------------------------------------------

describe("recordAgentFailure — retry succeeds on 2nd attempt (T-RETRYF-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    RetryFakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "retries after failure and completes job on 2nd attempt (T-RETRYF-1, UC-RETRY-001, FP-RETRY-ATTEMPT-CHECK, FP-RETRY-JOB-RETRYING)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, RETRY_HEADROOM_YAML, "retry-headroom");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      // First call fails, second call succeeds
      const behaviors: BackendBehavior[] = ["failure", "success"];
      const summary = await callRunAll({
        task: "exercise retry success",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new RetryFakeBackend({ command: "fake" }, behaviors),
        clock: new FakeClock(),
      });

      // RED-PHASE: These assertions fail until WF-P13-RETRY Step 2 ships
      expect(summary.status).toBe("completed");

      const runDir = join(sandbox.runsDir, summary.runId);
      const state = await readStateSnapshot(runDir);
      expect(state.jobs["intake"]!.status).toBe("completed");
      // Should have attempted twice
      expect(state.jobs["intake"]!.attempt).toBe(2);

      // Verify events
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // Must have step_failed from attempt 1
      expect(eventTypes).toContain("step_failed");

      // Must have job_retrying event
      expect(eventTypes).toContain("job_retrying");

      // Must have agent_completed from attempt 2
      expect(eventTypes).toContain("agent_completed");

      // Must complete successfully
      expect(eventTypes).toContain("run_completed");

      // job_retrying event payload
      const retryingEvent = events.find((e) => e.type === "job_retrying");
      expect(retryingEvent).toBeDefined();
      if (retryingEvent) {
        expect(retryingEvent.payload["job_id"]).toBe("intake");
        expect(retryingEvent.payload["attempt"]).toBe(2);
      }

      // step_failed event payload
      const stepFailedEvent = events.find((e) => e.type === "step_failed");
      expect(stepFailedEvent).toBeDefined();
      if (stepFailedEvent) {
        expect(stepFailedEvent.payload["attempt"]).toBe(1);
        expect(typeof stepFailedEvent.payload["reason"]).toBe("string");
        expect((stepFailedEvent.payload["reason"] as string).length).toBeGreaterThan(0);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRYF-2: Max_attempts exceeded with default on_exceeded (blocked)
// ---------------------------------------------------------------------------

describe("recordAgentFailure — max_attempts exceeded default on_exceeded (T-RETRYF-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    RetryFakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "blocks job when max_attempts=1 is exhausted with no on_exceeded declared (T-RETRYF-2, UC-RETRY-002, FP-RETRY-ON-EXCEEDED, FP-RETRY-DEFAULT-ON-EXCEEDED)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, RETRY_EXCEEDED_DEFAULT_YAML, "retry-exceeded-default");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      // All calls fail — exhausts max_attempts=1 on first failure
      const behaviors: BackendBehavior[] = ["failure"];
      const summary = await callRunAll({
        task: "exercise retry exceeded default",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new RetryFakeBackend({ command: "fake" }, behaviors),
        clock: new FakeClock(),
      });

      // RED-PHASE: job should be blocked, run should not be failed
      expect(summary.jobs[0]!.status).toBe("blocked");
      expect(summary.status).toBe("blocked");

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // Must NOT have job_retrying (exhausted)
      expect(eventTypes).not.toContain("job_retrying");

      // Must have job_blocked (default on_exceeded)
      expect(eventTypes).toContain("job_blocked");

      // Must have step_failed
      expect(eventTypes).toContain("step_failed");

      // job_blocked event payload
      const blockedEvent = events.find((e) => e.type === "job_blocked");
      expect(blockedEvent).toBeDefined();
      if (blockedEvent) {
        expect(blockedEvent.payload["job_id"]).toBe("intake");
      }

      // Verify state
      const state = await readStateSnapshot(runDir);
      expect(state.jobs["intake"]!.status).toBe("blocked");
      // Only 1 attempt was used
      expect(state.jobs["intake"]!.attempt).toBe(1);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRYF-3: Max_attempts exceeded with on_exceeded.status=failed
// ---------------------------------------------------------------------------

describe("recordAgentFailure — max_attempts exceeded with on_exceeded.status=failed (T-RETRYF-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    RetryFakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "fails job when max_attempts=2 is exhausted and on_exceeded.status=failed (T-RETRYF-3, UC-RETRY-003, FP-RETRY-ON-EXCEEDED)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, RETRY_ON_EXCEEDED_FAILED_YAML, "retry-on-exceeded-failed");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      // Attempt 1 fails → retry to attempt 2 → attempt 2 also fails → exhausted
      const behaviors: BackendBehavior[] = ["failure", "failure"];
      const summary = await callRunAll({
        task: "exercise retry on_exceeded failed",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new RetryFakeBackend({ command: "fake" }, behaviors),
        clock: new FakeClock(),
        maxIterations: 20,
      });

      // RED-PHASE: with on_exceeded.status=failed, job should be failed
      expect(summary.jobs[0]!.status).toBe("failed");

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // Must have job_retrying after attempt 1 failure
      expect(eventTypes).toContain("job_retrying");

      // Must NOT have job_blocked (on_exceeded overrides to failed)
      expect(eventTypes).not.toContain("job_blocked");

      // Must have job_failed as terminal job event
      expect(eventTypes).toContain("job_failed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRYF-4: ConfigError bypasses retry
// ---------------------------------------------------------------------------

describe("recordAgentFailure — ConfigError bypasses retry (T-RETRYF-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    RetryFakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "directly fails the run without retry when backend throws ConfigError (T-RETRYF-4, UC-RETRY-004, FP-RETRY-CONFIG-ERROR)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, RETRY_HEADROOM_YAML, "retry-headroom");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      // Backend resolver throws ConfigError
      const summary = await callRunAll({
        task: "exercise config error",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => {
          throw new ConfigError(
            'Agent backend "fake-retry" is not configured.',
            {
              details: { backendName: "fake-retry" },
              suggestion: "Add a backends entry to .zigma-flow/config.json.",
            }
          );
        },
        clock: new FakeClock(),
      });

      // RED-PHASE: run should be failed, not retried
      expect(summary.status).toBe("failed");

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // Must NOT have job_retrying
      expect(eventTypes).not.toContain("job_retrying");

      // Must have run_failed
      expect(eventTypes).toContain("run_failed");

      // Only 1 attempt total
      expect(RetryFakeBackend.calls.length).toBeLessThanOrEqual(1);

      // Verify state
      const state = await readStateSnapshot(runDir);
      expect(state.status).toBe("failed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRYF-5: PermissionError bypasses retry
// ---------------------------------------------------------------------------

describe("recordAgentFailure — PermissionError bypasses retry (T-RETRYF-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    RetryFakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "directly fails the run without retry when backend throws PermissionError (T-RETRYF-5, UC-RETRY-005, FP-RETRY-CONFIG-ERROR)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, RETRY_HEADROOM_YAML, "retry-headroom");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      // Backend resolver throws PermissionError
      const summary = await callRunAll({
        task: "exercise permission error",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => {
          throw new PermissionError(
            "Claude Code is not logged in. Please run `claude login` first.",
            {
              details: { kind: "auth" },
              suggestion: "Run `claude login` to authenticate.",
            }
          );
        },
        clock: new FakeClock(),
      });

      // RED-PHASE: run should be failed, not retried
      expect(summary.status).toBe("failed");

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // Must NOT have job_retrying
      expect(eventTypes).not.toContain("job_retrying");

      // Must have run_failed
      expect(eventTypes).toContain("run_failed");

      // Verify state
      const state = await readStateSnapshot(runDir);
      expect(state.status).toBe("failed");
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRYF-6: Timeout failure is retryable
// ---------------------------------------------------------------------------

describe("recordAgentFailure — timeout failure is retryable (T-RETRYF-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    RetryFakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "retries after timeout on attempt=1 and succeeds on attempt=2 (T-RETRYF-6, UC-RETRY-008, FP-RETRY-TIMEOUT-RETRY)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, RETRY_HEADROOM_YAML, "retry-headroom");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      // First call times out, second succeeds
      const behaviors: BackendBehavior[] = ["timeout", "success"];
      const summary = await callRunAll({
        task: "exercise timeout retry",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new RetryFakeBackend({ command: "fake" }, behaviors),
        clock: new FakeClock(),
      });

      // RED-PHASE: should complete after retry
      expect(summary.status).toBe("completed");

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // Must have agent_timed_out for attempt 1
      expect(eventTypes).toContain("agent_timed_out");

      // Must have step_failed
      expect(eventTypes).toContain("step_failed");

      // Must have job_retrying (timeout IS retryable)
      expect(eventTypes).toContain("job_retrying");

      // Must have agent_completed for attempt 2
      expect(eventTypes).toContain("agent_completed");

      // Verify state: job completed with 2 attempts
      const state = await readStateSnapshot(runDir);
      expect(state.jobs["intake"]!.status).toBe("completed");
      expect(state.jobs["intake"]!.attempt).toBe(2);
    }
  );
});

// ---------------------------------------------------------------------------
// T-RETRYF-7: step_failed event payload correctness
// ---------------------------------------------------------------------------

describe("recordAgentFailure — step_failed event payload (T-RETRYF-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    RetryFakeBackend.reset();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "step_failed event carries correct attempt number and reason (T-RETRYF-7, UC-RETRY-007, FP-RETRY-STEP-FAILED)",
    async () => {
      const { runId: _precreatedRunId, runDir: _precreatedRunDir, workflowPath } =
        await bootstrapRun(sandbox, RETRY_HEADROOM_YAML, "retry-headroom");

      await rm(_precreatedRunDir, { recursive: true, force: true });

      const behaviors: BackendBehavior[] = ["failure", "success"];
      const summary = await callRunAll({
        task: "exercise step_failed payload",
        workflowPath,
        runsDir: sandbox.runsDir,
        zigmaflowDir: sandbox.zigmaflowDir,
        skillLockPath: sandbox.skillLockPath,
        backendResolver: () => new RetryFakeBackend({ command: "fake" }, behaviors),
        clock: new FakeClock(),
      });

      const runDir = join(sandbox.runsDir, summary.runId);
      const events = await readEvents(runDir);

      // Find all step_failed events
      const stepFailedEvents = events.filter((e) => e.type === "step_failed");
      // RED-PHASE: at least 1 step_failed event
      expect(stepFailedEvents.length).toBeGreaterThanOrEqual(1);

      const stepFailed = stepFailedEvents[0]!;
      // Payload must have required fields
      expect(stepFailed.payload["job_id"]).toBe("intake");
      expect(stepFailed.payload["step_id"]).toBe("analyze");
      expect(stepFailed.payload["attempt"]).toBe(1);
      expect(typeof stepFailed.payload["reason"]).toBe("string");
      expect((stepFailed.payload["reason"] as string).length).toBeGreaterThan(0);

      // reason must NOT contain raw stdout/stderr blobs (AD-P13-003)
      const reason = stepFailed.payload["reason"] as string;
      expect(reason).not.toMatch(/stdout \(last \d+ chars\)/i);
      expect(reason).not.toMatch(/stderr \(last \d+ chars\)/i);

      // Envelope fields
      expect(stepFailed.job).toBe("intake");
      expect(stepFailed.step).toBe("analyze");
      expect(stepFailed.attempt).toBe(1);
      expect(stepFailed.producer).toBe("engine");
    }
  );
});
