/**
 * Runtime metrics recording integration tests (Issue #286 Phase 2).
 *
 * Exercises the runAll engine path end to end: every invoked agent backend
 * execution writes exactly one metrics.jsonl record at its terminal outcome
 * (completed / failed / timed_out / cancelled), carrying the routed model +
 * cost_class, duration, failure kind, report-acceptance flag, and the
 * agent_invoked event id as the join-back key. Pre-execution failures
 * (routing no-match, config/permission) write NO record.
 *
 * The records are consumed by #286 Phase 3 (historical routing by task
 * class) and Phase 4 (accepted artifact cost) — see
 * docs/architecture.md §8.1 for the run-dir layout contract.
 *
 * Fixture/helper pattern follows tests/engine/model-routing.test.ts
 * (tmpdir sandbox + lazy runAll import + FakeClock).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import type { Clock } from "../../src/run/index.js";
import type {
  AgentBackend,
  AgentBackendConfig,
  AgentExecuteOptions,
  AgentExecuteResult,
} from "../../src/agent/index.js";
import type { StepBackendOverride } from "../../src/agent/config.js";
import type { ZigmaFlowEvent } from "../../src/events/index.js";

const FIXED_ISO = "2026-06-27T00:00:00.000Z";
const FAKE_DURATION_MS = 1234;

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

type MetricsBackendBehavior =
  | "success"
  | "failure"
  | "timeout"
  | "invalid_report"
  | "fail_first_then_succeed";

interface MetricsBackendConfig {
  behavior?: MetricsBackendBehavior;
  /** Simulated execution wall time, reported in the execute result. */
  durationMs?: number;
  /** Simulated execution delay (used by the cancellation test). */
  delayMs?: number;
  /** With fail_first_then_succeed: number of leading calls that fail. */
  failFirstN?: number;
}

/**
 * Configurable backend for metrics tests. Tracks its own invocation count
 * (instance-level — runAll reuses the cached backend across retry attempts)
 * and reports a fixed duration so record assertions are deterministic.
 */
class MetricsBackend implements AgentBackend {
  readonly name = "fake-metrics";
  readonly supportsOutputSchema = true;
  readonly model: string | undefined;
  callCount = 0;
  private readonly config: Required<MetricsBackendConfig>;

  constructor(ctorConfig: AgentBackendConfig, behaviorConfig?: MetricsBackendConfig) {
    this.model = ctorConfig.model;
    this.config = {
      behavior: behaviorConfig?.behavior ?? "success",
      durationMs: behaviorConfig?.durationMs ?? FAKE_DURATION_MS,
      delayMs: behaviorConfig?.delayMs ?? 0,
      failFirstN: behaviorConfig?.failFirstN ?? 0,
    };
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    this.callCount += 1;

    const { reportPath, stepDir, projectRoot, signal } = opts;

    if (this.config.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
    }

    await mkdir(stepDir, { recursive: true });
    const stdoutPath = join(stepDir, "agent.stdout.log");
    const stderrPath = join(stepDir, "agent.stderr.log");
    const invocationPath = join(stepDir, "agent.invocation.json");
    await writeFile(stdoutPath, "fake stdout\n", "utf-8");
    await writeFile(stderrPath, "fake stderr\n", "utf-8");
    await writeFile(
      invocationPath,
      JSON.stringify({ command: "fake", project_root: projectRoot }, null, 2),
      "utf-8",
    );

    if (signal?.aborted) {
      return {
        success: false,
        error: "Agent execution was cancelled.",
        stdoutPath,
        stderrPath,
        invocationPath,
        durationMs: this.config.durationMs,
      };
    }

    const shouldFail =
      this.config.behavior === "failure" ||
      (this.config.behavior === "fail_first_then_succeed" &&
        this.callCount <= this.config.failFirstN);

    if (shouldFail) {
      return {
        success: false,
        exitCode: 2,
        error: "Agent failed with exit code 2: command not found",
        stdoutPath,
        stderrPath,
        invocationPath,
        durationMs: this.config.durationMs,
      };
    }

    if (this.config.behavior === "timeout") {
      return {
        success: false,
        error: "Agent timed out after 600000ms.",
        stdoutPath,
        stderrPath,
        invocationPath,
        durationMs: this.config.durationMs,
      };
    }

    await mkdir(dirname(reportPath), { recursive: true });

    if (this.config.behavior === "invalid_report") {
      // Execution succeeded but the report fails final-line validation.
      await writeFile(reportPath, "this is not json", "utf-8");
      return {
        success: true,
        exitCode: 0,
        reportPath,
        stdoutPath,
        stderrPath,
        invocationPath,
        durationMs: this.config.durationMs,
      };
    }

    await writeFile(
      reportPath,
      JSON.stringify({ outputs: {}, artifacts: [], signals: [], summary: "ok" }, null, 2),
      "utf-8",
    );
    return {
      success: true,
      exitCode: 0,
      reportPath,
      stdoutPath,
      stderrPath,
      invocationPath,
      durationMs: this.config.durationMs,
    };
  }
}

interface RunAllOpts {
  task?: string;
  runId?: string;
  workflowPath: string;
  runsDir: string;
  zigmaflowDir: string;
  skillLockPath: string;
  backendResolver: (stepBackend?: string | StepBackendOverride) => AgentBackend;
  clock?: Clock;
  signal?: AbortSignal;
  maxIterations?: number;
  onEvent?: (e: ZigmaFlowEvent) => void;
}

interface RunAllSummary {
  runId: string;
  status?: string;
  jobs: Array<{ id: string; status: string; attempts: number }>;
  iterations: number;
}

const RUN_ALL_SPECIFIER = "../../src/engine/runAll.js";

async function callRunAll(opts: RunAllOpts): Promise<RunAllSummary> {
  const mod = (await import(/* @vite-ignore */ String(RUN_ALL_SPECIFIER))) as {
    runAll: (o: RunAllOpts) => Promise<RunAllSummary>;
  };
  return mod.runAll(opts);
}

interface Sandbox {
  projectRoot: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-metrics-${randomUUID()}`);
  const dotZigma = join(projectRoot, ".zigma-flow");
  const runsDir = join(dotZigma, "runs");
  const skillLockPath = join(dotZigma, "skill-lock.json");

  await mkdir(runsDir, { recursive: true });
  await writeFile(
    join(dotZigma, "config.json"),
    JSON.stringify({ tool_version: "0.1.0", active_run: null }, null, 2),
    "utf-8",
  );
  await writeFile(skillLockPath, JSON.stringify({ skills: {} }, null, 2), "utf-8");

  return { projectRoot, runsDir, skillLockPath };
}

async function writeWorkflow(sandbox: Sandbox, name: string, yamlBody: string): Promise<string> {
  const workflowPath = join(sandbox.projectRoot, `${name}.yml`);
  await writeFile(workflowPath, yamlBody, "utf-8");
  return workflowPath;
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

type MetricsLine = Record<string, unknown>;

/** Reads metrics.jsonl; returns [] when the file does not exist yet. */
async function readMetrics(runDir: string): Promise<MetricsLine[]> {
  try {
    const text = await readFile(join(runDir, "metrics.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as MetricsLine);
  } catch {
    return [];
  }
}

/** Resolver factory returning a MetricsBackend that inherits the routed model. */
function routedResolver(
  captured?: { value: string | StepBackendOverride | undefined },
): (stepBackend?: string | StepBackendOverride) => MetricsBackend {
  return (stepBackend) => {
    if (captured) captured.value = stepBackend;
    return new MetricsBackend({
      command: "fake",
      ...(typeof stepBackend === "object" && stepBackend.model !== undefined
        ? { model: stepBackend.model }
        : {}),
    });
  };
}

const ROUTED_YAML = `\
name: metrics-routed
version: "1.0"
models:
  cheap:
    model: claude-haiku-4-5
    cost_class: low
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        constraints:
          max_cost_class: low
`;

const COST_DEFAULT_YAML = `\
name: metrics-cost-default
version: "1.0"
models:
  internal:
    model: claude-haiku-4-5
    data_classification: [internal]
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        constraints:
          data_classification: internal
`;

const NO_MODELS_YAML = `\
name: metrics-no-models
version: "1.0"
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
`;

const NO_MATCH_YAML = `\
name: metrics-no-match
version: "1.0"
models:
  internal:
    model: claude-haiku-4-5
    data_classification: [internal]
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        constraints:
          data_classification: restricted
`;

const RETRY_YAML = `\
name: metrics-retry
version: "1.0"
models:
  cheap:
    model: claude-haiku-4-5
    cost_class: low
jobs:
  main:
    retry:
      max_attempts: 2
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        constraints:
          max_cost_class: low
`;

describe("runAll — runtime metrics recording (Issue #286 Phase 2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("records exact fields for a routed success and links via invocation_id", async () => {
    const workflowPath = await writeWorkflow(sandbox, "routed", ROUTED_YAML);
    const captured: { value: string | StepBackendOverride | undefined } = {
      value: undefined,
    };

    const summary = await callRunAll({
      task: "exercise metrics success",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: routedResolver(captured),
      clock: new FakeClock(),
    });

    expect(summary.status).toBe("completed");
    expect(captured.value).toEqual({ model: "claude-haiku-4-5" });

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    const completed = events.find((e) => e.type === "agent_completed");
    expect(invoked).toBeDefined();
    expect(completed).toBeDefined();

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toHaveLength(1);
    const rec = metrics[0]!;

    expect(rec["timestamp"]).toBe(FIXED_ISO);
    expect(rec["run_id"]).toBe(summary.runId);
    expect(rec["workflow"]).toBe("metrics-routed");
    expect(rec["job"]).toBe("main");
    expect(rec["step"]).toBe("analyze");
    expect(rec["attempt"]).toBe(1);
    expect(rec["skill"]).toBe("zigma/analyze-skill");
    expect(rec["backend"]).toBe("fake-metrics");
    expect(rec["model"]).toBe("claude-haiku-4-5");
    expect(rec["cost_class"]).toBe("low");
    expect(rec["duration_ms"]).toBe(FAKE_DURATION_MS);
    expect(rec["status"]).toBe("completed");
    expect(rec["report_accepted"]).toBe(true);
    expect(rec["invocation_id"]).toBe(invoked!.id);
    expect("failure_kind" in rec).toBe(false);
    expect("exit_code" in rec).toBe(false);

    // agent_completed carries the routed model + cost_class (additive fields)
    expect(completed!.payload["model"]).toBe("claude-haiku-4-5");
    expect(completed!.payload["cost_class"]).toBe("low");
  });

  it("defaults cost_class to high when the routed profile omits it", async () => {
    const workflowPath = await writeWorkflow(sandbox, "cost-default", COST_DEFAULT_YAML);

    const summary = await callRunAll({
      task: "exercise cost default",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: routedResolver(),
      clock: new FakeClock(),
    });

    expect(summary.status).toBe("completed");

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!["model"]).toBe("claude-haiku-4-5");
    expect(metrics[0]!["cost_class"]).toBe("high");
  });

  it("records a failure with failure_kind, exit_code and report_accepted false", async () => {
    const workflowPath = await writeWorkflow(sandbox, "failed", ROUTED_YAML);

    const summary = await callRunAll({
      task: "exercise metrics failure",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: (stepBackend) =>
        new MetricsBackend(
          {
            command: "fake",
            ...(typeof stepBackend === "object" && stepBackend.model !== undefined
              ? { model: stepBackend.model }
              : {}),
          },
          { behavior: "failure" },
        ),
      clock: new FakeClock(),
    });

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const failed = events.find((e) => e.type === "agent_failed");
    expect(failed).toBeDefined();
    // agent_failed carries the routed model (additive field)
    expect(failed!.payload["model"]).toBe("claude-haiku-4-5");

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toHaveLength(1);
    const rec = metrics[0]!;
    expect(rec["status"]).toBe("failed");
    expect(rec["failure_kind"]).toBe("agent_error");
    expect(rec["exit_code"]).toBe(2);
    expect(rec["report_accepted"]).toBe(false);
    expect(rec["duration_ms"]).toBe(FAKE_DURATION_MS);
  });

  it("records a timeout without an exit_code key", async () => {
    const workflowPath = await writeWorkflow(sandbox, "timed-out", ROUTED_YAML);

    const summary = await callRunAll({
      task: "exercise metrics timeout",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: (stepBackend) =>
        new MetricsBackend(
          {
            command: "fake",
            ...(typeof stepBackend === "object" && stepBackend.model !== undefined
              ? { model: stepBackend.model }
              : {}),
          },
          { behavior: "timeout" },
        ),
      clock: new FakeClock(),
    });

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toHaveLength(1);
    const rec = metrics[0]!;
    expect(rec["status"]).toBe("timed_out");
    expect(rec["failure_kind"]).toBe("timeout");
    expect(rec["report_accepted"]).toBe(false);
    expect("exit_code" in rec).toBe(false);
    expect(rec["duration_ms"]).toBe(FAKE_DURATION_MS);
  });

  it("records a report-validation failure with exit_code 0 (execution happened, report rejected)", async () => {
    const workflowPath = await writeWorkflow(sandbox, "report-invalid", ROUTED_YAML);

    const summary = await callRunAll({
      task: "exercise metrics report validation",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: (stepBackend) =>
        new MetricsBackend(
          {
            command: "fake",
            ...(typeof stepBackend === "object" && stepBackend.model !== undefined
              ? { model: stepBackend.model }
              : {}),
          },
          { behavior: "invalid_report" },
        ),
      clock: new FakeClock(),
    });

    // No agent_completed: a rejected report never produces a success signal.
    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    expect(events.some((e) => e.type === "agent_completed")).toBe(false);
    expect(events.some((e) => e.type === "step_failed")).toBe(true);

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toHaveLength(1);
    const rec = metrics[0]!;
    expect(rec["status"]).toBe("failed");
    expect(rec["failure_kind"]).toBe("agent_error");
    expect(rec["exit_code"]).toBe(0);
    expect(rec["report_accepted"]).toBe(false);
    expect(rec["duration_ms"]).toBe(FAKE_DURATION_MS);
  });

  it("records a cancelled execution after abort", async () => {
    const workflowPath = await writeWorkflow(sandbox, "cancelled", ROUTED_YAML);

    const controller = new AbortController();
    const abortPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 50);
    });

    const summaryPromise = callRunAll({
      task: "exercise metrics cancellation",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: (stepBackend) =>
        new MetricsBackend(
          {
            command: "fake",
            ...(typeof stepBackend === "object" && stepBackend.model !== undefined
              ? { model: stepBackend.model }
              : {}),
          },
          { behavior: "success", delayMs: 100 },
        ),
      clock: new FakeClock(),
      signal: controller.signal,
    });
    const [summary] = await Promise.all([summaryPromise, abortPromise]);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    expect(events.some((e) => e.type === "agent_cancelled")).toBe(true);

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toHaveLength(1);
    const rec = metrics[0]!;
    expect(rec["status"]).toBe("cancelled");
    expect(rec["failure_kind"]).toBe("cancelled");
    expect(rec["report_accepted"]).toBe(false);
    expect("exit_code" in rec).toBe(false);
  });

  it("records one record per attempt across a retry with distinct invocation_ids", async () => {
    const workflowPath = await writeWorkflow(sandbox, "retry", RETRY_YAML);

    const summary = await callRunAll({
      task: "exercise metrics retry",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: (stepBackend) =>
        new MetricsBackend(
          {
            command: "fake",
            ...(typeof stepBackend === "object" && stepBackend.model !== undefined
              ? { model: stepBackend.model }
              : {}),
          },
          { behavior: "fail_first_then_succeed", failFirstN: 1 },
        ),
      clock: new FakeClock(),
      maxIterations: 10,
    });

    expect(summary.status).toBe("completed");
    expect(summary.jobs[0]!.attempts).toBe(2);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.filter((e) => e.type === "agent_invoked");
    expect(invoked).toHaveLength(2);

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toHaveLength(2);

    const first = metrics[0]!;
    expect(first["attempt"]).toBe(1);
    expect(first["status"]).toBe("failed");
    expect(first["failure_kind"]).toBe("agent_error");
    expect(first["exit_code"]).toBe(2);
    expect(first["report_accepted"]).toBe(false);
    expect(first["invocation_id"]).toBe(invoked[0]!.id);

    const second = metrics[1]!;
    expect(second["attempt"]).toBe(2);
    expect(second["status"]).toBe("completed");
    expect(second["report_accepted"]).toBe(true);
    expect("failure_kind" in second).toBe(false);
    expect("exit_code" in second).toBe(false);
    expect(second["invocation_id"]).toBe(invoked[1]!.id);

    expect(first["invocation_id"]).not.toBe(second["invocation_id"]);
  });

  it("omits model and cost_class when the workflow declares no models", async () => {
    const workflowPath = await writeWorkflow(sandbox, "no-models", NO_MODELS_YAML);

    const summary = await callRunAll({
      task: "exercise metrics no models",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: routedResolver(),
      clock: new FakeClock(),
    });

    expect(summary.status).toBe("completed");

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const completed = events.find((e) => e.type === "agent_completed");
    expect(completed).toBeDefined();
    expect("model" in completed!.payload).toBe(false);
    expect("cost_class" in completed!.payload).toBe(false);

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toHaveLength(1);
    const rec = metrics[0]!;
    expect(rec["backend"]).toBe("fake-metrics");
    expect("model" in rec).toBe(false);
    expect("cost_class" in rec).toBe(false);
  });

  it("writes no record and never invokes the backend when routing finds no match", async () => {
    const workflowPath = await writeWorkflow(sandbox, "no-match", NO_MATCH_YAML);
    let resolvedBackend: MetricsBackend | undefined;

    const summary = await callRunAll({
      task: "exercise metrics no match",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => {
        resolvedBackend = new MetricsBackend({ command: "fake" });
        return resolvedBackend;
      },
      clock: new FakeClock(),
    });

    expect(summary.jobs[0]!.status).toBe("failed");
    expect(resolvedBackend).toBeUndefined();

    const metrics = await readMetrics(join(sandbox.runsDir, summary.runId));
    expect(metrics).toEqual([]);
  });
});
