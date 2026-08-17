/**
 * Engine output-schema enforcement tests (Issue #289 follow-up).
 *
 * Verifies the runAll inline accept path applies the final-line contract:
 *   - Illegal enum/values in outputs or outputs_schema fail the job and never
 *     advance state (no agent_report_accepted event).
 *   - Unsupported output type declarations fail at schema compile time as a
 *     config error — the backend is never invoked.
 *   - Backends that do not declare supportsOutputSchema fail closed before
 *     execution (no prompt-only fallback).
 *   - required_artifacts match against string artifact refs (path segments).
 *
 * Reference:
 *   - docs/agent-output-schema.md
 *   - Issue #289 follow-up blockers A/B/C
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import { runAll } from "../../src/engine/runAll.js";
import type { RunAllSummary } from "../../src/engine/runAll.js";
import type { Clock, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import type {
  AgentBackend,
  AgentBackendConfig,
  AgentExecuteOptions,
  AgentExecuteResult,
} from "../../src/agent/index.js";

const FIXED_ISO = "2026-06-27T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

// ---------------------------------------------------------------------------
// Fake backends
// ---------------------------------------------------------------------------

/** Writes a caller-supplied report envelope and records every invocation. */
class ReportingBackend implements AgentBackend {
  readonly name = "reporting-fake";
  readonly supportsOutputSchema = true;
  static calls: AgentExecuteOptions[] = [];

  constructor(private readonly report: Record<string, unknown>) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    ReportingBackend.calls.push(opts);
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(opts.reportPath, JSON.stringify(this.report, null, 2), "utf-8");
    return { success: true, reportPath: opts.reportPath };
  }
}

/** A backend that does not support output-schema enforcement. */
class NoSchemaBackend implements AgentBackend {
  readonly name = "no-schema-fake";
  readonly supportsOutputSchema = false;
  static calls = 0;

  constructor(_config: AgentBackendConfig) {}

  async execute(_opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    NoSchemaBackend.calls += 1;
    return { success: false, error: "should never be invoked" };
  }
}

// ---------------------------------------------------------------------------
// Workflow YAML fixtures
// ---------------------------------------------------------------------------

const ENUM_OUTPUTS_YAML = `\
name: enum-outputs
version: "0.1.0"
jobs:
  intake:
    retry:
      max_attempts: 1
      on_exceeded:
        status: failed
    steps:
      - id: review
        type: agent
        allow_generic_prompt: true
        uses: zigma/review-skill
        outputs:
          verdict:
            type: string
            values:
              - approved
              - rejected
`;

const ENUM_OUTPUTS_SCHEMA_YAML = `\
name: enum-outputs-schema
version: "0.1.0"
jobs:
  intake:
    retry:
      max_attempts: 1
      on_exceeded:
        status: failed
    steps:
      - id: review
        type: agent
        allow_generic_prompt: true
        uses: zigma/review-skill
        outputs_schema:
          verdict:
            type: string
            values:
              - approved
              - rejected
`;

const UNSUPPORTED_TYPE_YAML = `\
name: unsupported-type
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: review
        type: agent
        allow_generic_prompt: true
        uses: zigma/review-skill
        outputs:
          score:
            type: integer
`;

const SIMPLE_AGENT_YAML = `\
name: simple-agent
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
`;

const REQUIRED_ARTIFACT_YAML = `\
name: required-artifact
version: "0.1.0"
jobs:
  intake:
    retry:
      max_attempts: 1
      on_exceeded:
        status: failed
    steps:
      - id: analyze
        type: agent
        allow_generic_prompt: true
        uses: zigma/analyze-skill
        required_artifacts:
          - summary.md
`;

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

interface Sandbox {
  projectRoot: string;
  zigmaflowDir: string;
  runsDir: string;
  skillLockPath: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const projectRoot = join(tmpdir(), `zigma-schema-enf-${randomUUID()}`);
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

  return { projectRoot, zigmaflowDir: projectRoot, runsDir, skillLockPath };
}

async function bootstrapRun(
  sandbox: Sandbox,
  yamlBody: string,
  workflowName: string,
): Promise<{ workflowPath: string }> {
  const workflowPath = join(sandbox.projectRoot, `${workflowName}.yml`);
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: `exercise ${workflowName}`,
    runsDir: sandbox.runsDir,
    skillLockPath: sandbox.skillLockPath,
    clock: new FakeClock(),
  });
  // runAll creates its own run when task is provided; remove the precreated one.
  await rm(join(sandbox.runsDir, runId), { recursive: true, force: true });

  return { workflowPath };
}

interface EventRecord {
  type: string;
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

async function runWithBackend(
  sandbox: Sandbox,
  yamlBody: string,
  workflowName: string,
  backend: AgentBackend,
): Promise<{ summary: RunAllSummary; runDir: string }> {
  const { workflowPath } = await bootstrapRun(sandbox, yamlBody, workflowName);
  const summary = await runAll({
    task: `exercise ${workflowName}`,
    workflowPath,
    runsDir: sandbox.runsDir,
    zigmaflowDir: sandbox.zigmaflowDir,
    skillLockPath: sandbox.skillLockPath,
    backendResolver: () => backend,
    clock: new FakeClock(),
  });
  return { summary, runDir: join(sandbox.runsDir, summary.runId) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAll — output-schema final-line enforcement (Issue #289)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    ReportingBackend.calls = [];
    NoSchemaBackend.calls = 0;
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("passes the compiled schema to the backend and completes on a legal value", async () => {
    const backend = new ReportingBackend({
      outputs: { verdict: "approved" },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      ENUM_OUTPUTS_YAML,
      "enum-outputs",
      backend,
    );

    expect(summary.status).toBe("completed");
    expect(summary.jobs[0]!.status).toBe("completed");

    // The backend received the compiled schema with the enum contract.
    expect(ReportingBackend.calls).toHaveLength(1);
    const passedSchema = ReportingBackend.calls[0]!.outputSchema as
      | { properties: { artifacts: any; outputs: { properties: { verdict: any } } } }
      | undefined;
    expect(passedSchema?.properties.artifacts).toEqual({ type: "array", items: { type: "string" } });
    expect(passedSchema?.properties.outputs.properties.verdict.enum).toEqual(["approved", "rejected"]);

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(true);
  });

  it("rejects an illegal outputs value and never advances state", async () => {
    const backend = new ReportingBackend({
      outputs: { verdict: "bogus" },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      ENUM_OUTPUTS_YAML,
      "enum-outputs",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");
    expect(ReportingBackend.calls).toHaveLength(1);

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");
    expect(state.jobs["intake"]!.status).toBe("failed");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(failedStep).toBeDefined();
    expect(String(failedStep!.payload.reason)).toContain('Output "verdict" value "bogus" is not in declared values');
  });

  it("rejects an illegal outputs_schema value and never advances state", async () => {
    const backend = new ReportingBackend({
      outputs: { verdict: "c" },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      ENUM_OUTPUTS_SCHEMA_YAML,
      "enum-outputs-schema",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain("is not in declared values");
  });

  it("fails at compile time on an unsupported output type without invoking the backend", async () => {
    const backend = new ReportingBackend({
      outputs: { score: 7 },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      UNSUPPORTED_TYPE_YAML,
      "unsupported-type",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");
    expect(ReportingBackend.calls).toHaveLength(0);

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");

    const events = await readEvents(runDir);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain("Agent output schema compile failed");
    expect(String(failedStep!.payload.reason)).toContain('unsupported type "integer"');
    expect(events.some((e) => e.type === "run_failed")).toBe(true);
  });

  it("fails closed when the backend does not support output-schema enforcement", async () => {
    const backend = new NoSchemaBackend({ command: "fake" });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      SIMPLE_AGENT_YAML,
      "simple-agent",
      backend,
    );

    expect(NoSchemaBackend.calls).toBe(0);
    expect(summary.jobs[0]!.status).toBe("failed");

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");

    const events = await readEvents(runDir);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain(
      'Agent backend "no-schema-fake" does not support output schema enforcement'
    );
    expect(events.some((e) => e.type === "run_failed")).toBe(true);
  });

  it("matches required_artifacts against string artifact refs by path segment", async () => {
    const backend = new ReportingBackend({
      outputs: {},
      artifacts: ["docs/summary.md"],
      signals: [],
      summary: "ok",
    });

    const { summary } = await runWithBackend(
      sandbox,
      REQUIRED_ARTIFACT_YAML,
      "required-artifact",
      backend,
    );

    expect(summary.status).toBe("completed");
    expect(summary.jobs[0]!.status).toBe("completed");
  });

  it("rejects a report missing a required artifact", async () => {
    const backend = new ReportingBackend({
      outputs: {},
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      REQUIRED_ARTIFACT_YAML,
      "required-artifact",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain('Required artifact "summary.md" not found');
  });
});
