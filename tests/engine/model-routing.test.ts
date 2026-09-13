/**
 * Model routing engine integration tests (Issue #286 Phase 1).
 *
 * Exercises the runAll engine path: routing selects a workflow `models:`
 * profile for an agent step with `constraints`, the effective override flows
 * into the backend resolver, the selected model + routing reason appear in
 * the agent_invoked event, and a no-match fails the step with the structured
 * ModelRoutingError evidence.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
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

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/** Records the config it was created with so tests can assert the routed model. */
class RecordingBackend implements AgentBackend {
  readonly name = "fake-routed";
  readonly supportsOutputSchema = true;
  readonly model: string | undefined;
  static calls: AgentExecuteOptions[] = [];
  static lastModel: string | undefined;

  constructor(config: AgentBackendConfig) {
    this.model = config.model;
    RecordingBackend.lastModel = config.model;
  }

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    RecordingBackend.calls.push(opts);
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(
      opts.reportPath,
      JSON.stringify({ outputs: {}, artifacts: [], signals: [], summary: "ok" }, null, 2),
      "utf-8",
    );
    return { success: true, reportPath: opts.reportPath };
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
  const projectRoot = join(tmpdir(), `zigma-model-routing-${randomUUID()}`);
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

const ROUTED_YAML = `\
name: model-routing-test
version: "1.0"
models:
  cheap:
    model: claude-haiku-4-5
    cost_class: low
  premium:
    model: claude-sonnet-4-6
    cost_class: high
    data_classification: [confidential]
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

const NO_MATCH_YAML = `\
name: model-routing-no-match
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

const NO_MODELS_YAML = `\
name: model-routing-no-models
version: "1.0"
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
`;

const EXPLICIT_VERIFIED_YAML = `\
name: model-routing-explicit-verified
version: "1.0"
models:
  premium:
    model: claude-sonnet-4-6
    data_classification: [confidential]
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        backend:
          model: claude-sonnet-4-6
        constraints:
          data_classification: confidential
`;

const EXPLICIT_VIOLATION_YAML = `\
name: model-routing-explicit-violation
version: "1.0"
models:
  public:
    model: claude-haiku-4-5
    data_classification: [public]
jobs:
  main:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        backend:
          model: claude-haiku-4-5
        constraints:
          data_classification: confidential
`;

describe("runAll — capability-based model routing (Issue #286)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    RecordingBackend.calls = [];
    RecordingBackend.lastModel = undefined;
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("routes to the first matching profile and emits model + routing_reason in agent_invoked", async () => {
    const workflowPath = await writeWorkflow(sandbox, "routed", ROUTED_YAML);
    let captured: string | StepBackendOverride | undefined;

    const summary = await callRunAll({
      task: "exercise model routing",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: (stepBackend) => {
        captured = stepBackend;
        return new RecordingBackend({
          command: "fake",
          ...(typeof stepBackend === "object" && stepBackend.model !== undefined
            ? { model: stepBackend.model }
            : {}),
        });
      },
      clock: new FakeClock(),
    });

    expect(summary.status).toBe("completed");
    expect(captured).toEqual({ model: "claude-haiku-4-5" });
    expect(RecordingBackend.lastModel).toBe("claude-haiku-4-5");

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked).toBeDefined();
    expect(invoked!.payload.model).toBe("claude-haiku-4-5");
    expect(invoked!.payload.routing_reason).toContain('matched profile "cheap"');
  });

  it("fails the step with a structured no-match error when no profile satisfies the constraints", async () => {
    const workflowPath = await writeWorkflow(sandbox, "no-match", NO_MATCH_YAML);

    const summary = await callRunAll({
      task: "exercise model routing no-match",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new RecordingBackend({ command: "fake" }),
      clock: new FakeClock(),
    });

    expect(summary.jobs).toHaveLength(1);
    expect(summary.jobs[0]!.status).toBe("failed");
    expect(RecordingBackend.calls).toHaveLength(0);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const stepFailed = events.find((e) => e.type === "step_failed");
    expect(stepFailed).toBeDefined();
    expect(String(stepFailed!.payload.reason)).toContain("No model profile");
  });

  it("keeps unchanged behavior without models/constraints: routing_reason records the skip, no model", async () => {
    const workflowPath = await writeWorkflow(sandbox, "no-models", NO_MODELS_YAML);

    const summary = await callRunAll({
      task: "exercise no models",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new RecordingBackend({ command: "fake" }),
      clock: new FakeClock(),
    });

    expect(summary.status).toBe("completed");
    expect(RecordingBackend.lastModel).toBeUndefined();

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked).toBeDefined();
    expect(invoked!.payload.model).toBeUndefined();
    expect(invoked!.payload.routing_reason).toBe("routing skipped: step declares no model constraints");
  });

  it("verifies an explicit model override against hard constraints and keeps the pinned model", async () => {
    const workflowPath = await writeWorkflow(sandbox, "explicit-verified", EXPLICIT_VERIFIED_YAML);
    let captured: string | StepBackendOverride | undefined;

    const summary = await callRunAll({
      task: "exercise explicit override",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: (stepBackend) => {
        captured = stepBackend;
        return new RecordingBackend({
          command: "fake",
          ...(typeof stepBackend === "object" && stepBackend.model !== undefined
            ? { model: stepBackend.model }
            : {}),
        });
      },
      clock: new FakeClock(),
    });

    expect(summary.status).toBe("completed");
    expect(captured).toEqual({ model: "claude-sonnet-4-6" });

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const invoked = events.find((e) => e.type === "agent_invoked");
    expect(invoked!.payload.model).toBe("claude-sonnet-4-6");
    expect(invoked!.payload.routing_reason).toContain("verified against hard constraints");
  });

  it("fails the step when an explicit model override violates a hard constraint", async () => {
    const workflowPath = await writeWorkflow(sandbox, "explicit-violation", EXPLICIT_VIOLATION_YAML);

    const summary = await callRunAll({
      task: "exercise explicit violation",
      workflowPath,
      runsDir: sandbox.runsDir,
      zigmaflowDir: sandbox.projectRoot,
      skillLockPath: sandbox.skillLockPath,
      backendResolver: () => new RecordingBackend({ command: "fake" }),
      clock: new FakeClock(),
    });

    expect(summary.jobs[0]!.status).toBe("failed");
    expect(RecordingBackend.calls).toHaveLength(0);

    const events = await readEvents(join(sandbox.runsDir, summary.runId));
    const stepFailed = events.find((e) => e.type === "step_failed");
    expect(stepFailed).toBeDefined();
    expect(String(stepFailed!.payload.reason)).toContain("violates hard constraints");
  });
});
