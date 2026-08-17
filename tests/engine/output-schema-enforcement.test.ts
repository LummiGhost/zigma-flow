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
import { createRequire } from "node:module";

import { createRun } from "../../src/engine/index.js";
import { runAll } from "../../src/engine/runAll.js";
import type { RunAllSummary } from "../../src/engine/runAll.js";
import { acceptAgentReport } from "../../src/engine/accept.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { artifactStepDir } from "../../src/artifact/artifactPaths.js";
import { ValidationError } from "../../src/utils/index.js";
import { loadWorkflowFile } from "../../src/workflow/index.js";
import { compileAgentOutputSchema } from "../../src/agent/index.js";
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

// Ajv is CJS-only (no exports field); load the draft 2020-12 variant via
// createRequire, mirroring src/check/checks/json-schema.ts. This simulates
// the native schema boundary built-in backends (Codex/Claude) enforce.
const _require = createRequire(import.meta.url);
const Ajv2020Ctor = _require("ajv/dist/2020") as {
  new (): { compile(schema: unknown): (data: unknown) => boolean };
};
const ajv2020 = new Ajv2020Ctor();

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

/**
 * Writes a per-step report. The step id is derived from the report path
 * (`.../steps/<stepId>/report.json`); steps without an entry get a valid
 * empty-outputs report.
 */
class StepAwareBackend implements AgentBackend {
  readonly name = "step-aware-fake";
  readonly supportsOutputSchema = true;

  constructor(private readonly reports: Record<string, Record<string, unknown>>) {}

  async execute(opts: AgentExecuteOptions): Promise<AgentExecuteResult> {
    const parts = opts.reportPath.split(/[\\/]/);
    const stepId = parts[parts.length - 2] ?? "";
    const report =
      this.reports[stepId] ?? { outputs: {}, artifacts: [], signals: [], summary: "ok" };
    await mkdir(dirname(opts.reportPath), { recursive: true });
    await writeFile(opts.reportPath, JSON.stringify(report, null, 2), "utf-8");
    return { success: true, reportPath: opts.reportPath };
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

const SCHEMA_ONLY_YAML = `\
name: schema-only
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
`;

const OUTPUTS_ONLY_TYPE_YAML = `\
name: outputs-only-type
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
          score:
            type: number
`;

const NUMERIC_ENUM_YAML = `\
name: numeric-enum
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
          code:
            values:
              - 1
              - 2
`;

const EMPTY_ENUM_YAML = `\
name: empty-enum
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
            values: []
`;

const ACCEPT_SCHEMA_ONLY_YAML = `\
name: accept-schema-only
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review
        type: agent
        uses: zigma/review-skill
        outputs_schema:
          verdict:
            type: string
            values:
              - passed
`;

const ACCEPT_OUTPUTS_ONLY_TYPE_YAML = `\
name: accept-outputs-only-type
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review
        type: agent
        uses: zigma/review-skill
        outputs:
          score:
            type: number
`;

const ACCEPT_NUMERIC_ENUM_YAML = `\
name: accept-numeric-enum
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review
        type: agent
        uses: zigma/review-skill
        outputs:
          code:
            values:
              - 1
              - 2
`;

const ACCEPT_EMPTY_ENUM_SCHEMA_YAML = `\
name: accept-empty-enum-schema
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review
        type: agent
        uses: zigma/review-skill
        outputs_schema:
          verdict:
            type: string
            values: []
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

const NO_DECLARED_OUTPUTS_YAML = `\
name: no-declared-outputs
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
`;

const ON_OUTPUT_EXTRA_YAML = `\
name: on-output-extra
version: "0.1.0"
jobs:
  review:
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
          verdict: {}
        on_output:
          verdict:
            rejected:
              retry_job: implement
  implement:
    retry:
      max_attempts: 2
    steps:
      - id: code
        type: agent
        allow_generic_prompt: true
        uses: zigma/code-skill
`;

const ACCEPT_DECLARED_OUTPUT_YAML = `\
name: accept-declared-output
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review
        type: agent
        uses: zigma/review-skill
        outputs:
          verdict: {}
`;

const ACCEPT_ON_OUTPUT_EXTRA_YAML = `\
name: accept-on-output-extra
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review
        type: agent
        uses: zigma/review-skill
        outputs:
          verdict: {}
        on_output:
          verdict:
            rejected:
              retry_job: implement
  implement:
    retry:
      max_attempts: 2
    steps:
      - id: code
        type: agent
        uses: zigma/code-skill
`;

const ACCEPT_RETURNS_STATUS_YAML = `\
name: accept-returns-status
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review
        type: agent
        uses: zigma/review-skill
        returns:
          status:
            values:
              - fixed
              - unfixable
        on_return:
          fixed: continue
          unfixable: fail
`;

const RUNALL_RETURNS_STATUS_YAML = `\
name: runall-returns-status
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
        returns:
          status:
            values:
              - fixed
              - unfixable
            required: true
        on_return:
          fixed: continue
          unfixable: fail
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

  it("accepts the prompt-canonical outputs.status report under a required returns.status (built-in schema compatible)", async () => {
    // Issue #256: the prompt directs agents to write outputs.status. The
    // compiled schema must declare that location (required) so a built-in
    // backend enforcing the schema natively accepts exactly this report.
    const report = {
      outputs: { status: "fixed" },
      artifacts: [],
      signals: [],
      summary: "review done",
    };
    const backend = new ReportingBackend(report);

    const { summary, runDir } = await runWithBackend(
      sandbox,
      RUNALL_RETURNS_STATUS_YAML,
      "runall-returns-status",
      backend,
    );

    expect(summary.status).toBe("completed");
    expect(summary.jobs[0]!.status).toBe("completed");

    expect(ReportingBackend.calls).toHaveLength(1);
    const passedSchema = ReportingBackend.calls[0]!.outputSchema as
      | {
          properties: {
            outputs: { properties: Record<string, any>; required: string[] };
            status: any;
          };
          required: string[];
        }
      | undefined;
    expect(passedSchema?.properties.outputs.properties.status).toEqual({
      type: "string",
      enum: ["fixed", "unfixable"],
    });
    expect(passedSchema?.properties.outputs.required).toContain("status");
    // The legacy top-level status stays optional — never in the top-level
    // required list.
    expect(passedSchema?.required).not.toContain("status");
    expect(passedSchema?.properties.status).toEqual({
      type: "string",
      enum: ["fixed", "unfixable"],
    });

    // Simulate the native schema boundary: the exact report the backend
    // wrote must validate against the compiled schema.
    const validate = ajv2020.compile(passedSchema);
    expect(validate(report)).toBe(true);

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "step_returned")).toBe(true);
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

  it("rejects a report missing an outputs_schema-only key and never advances state", async () => {
    const backend = new ReportingBackend({
      outputs: {},
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      SCHEMA_ONLY_YAML,
      "schema-only",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain("missing declared output(s): verdict");
  });

  it("enforces outputs-only type declarations (number vs string) and never advances state", async () => {
    const backend = new ReportingBackend({
      outputs: { score: "high" },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      OUTPUTS_ONLY_TYPE_YAML,
      "outputs-only-type",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain(
      'Output "score" type mismatch: expected number, got string'
    );
  });

  it("accepts a legal outputs-only typed value", async () => {
    const backend = new ReportingBackend({
      outputs: { score: 7 },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary } = await runWithBackend(
      sandbox,
      OUTPUTS_ONLY_TYPE_YAML,
      "outputs-only-type",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("completed");
  });

  it("rejects enum values with strict equality (no String coercion) and never advances state", async () => {
    const backend = new ReportingBackend({
      outputs: { code: "1" },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      NUMERIC_ENUM_YAML,
      "numeric-enum",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain(
      'Output "code" value "1" is not in declared values'
    );
  });

  it("accepts a strictly-equal numeric enum value", async () => {
    const backend = new ReportingBackend({
      outputs: { code: 1 },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary } = await runWithBackend(
      sandbox,
      NUMERIC_ENUM_YAML,
      "numeric-enum",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("completed");
  });

  it("treats an empty enum (values: []) as rejecting every value", async () => {
    const backend = new ReportingBackend({
      outputs: { verdict: "approved" },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      EMPTY_ENUM_YAML,
      "empty-enum",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain(
      'Output "verdict" value "approved" is not in declared values'
    );
  });

  it("rejects undeclared output keys (additionalProperties: false) and never advances state", async () => {
    const backend = new ReportingBackend({
      outputs: { verdict: "approved", confidence: 0.9 },
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

    const state = await readStateSnapshot(runDir);
    expect(state.status).toBe("failed");
    expect(state.jobs["intake"]!.status).toBe("failed");
    // The rejected outputs must never be persisted.
    const jobOutputs = state.jobs["intake"] as unknown as { outputs?: Record<string, unknown> };
    expect(jobOutputs.outputs).toBeUndefined();

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(failedStep).toBeDefined();
    expect(String(failedStep!.payload.reason)).toContain("undeclared output(s): confidence");
  });

  it("rejects any output key when the step declares no outputs", async () => {
    const backend = new ReportingBackend({
      outputs: { note: "hi" },
      artifacts: [],
      signals: [],
      summary: "ok",
    });

    const { summary, runDir } = await runWithBackend(
      sandbox,
      NO_DECLARED_OUTPUTS_YAML,
      "no-declared-outputs",
      backend,
    );

    expect(summary.jobs[0]!.status).toBe("failed");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(failedStep).toBeDefined();
    expect(String(failedStep!.payload.reason)).toContain("undeclared output(s): note");
  });

  it("does not route on_output when the report carries an undeclared key", async () => {
    const backend = new StepAwareBackend({
      review: {
        outputs: { verdict: "rejected", extra: "x" },
        artifacts: [],
        signals: [],
        summary: "ok",
      },
    });

    const { runDir } = await runWithBackend(
      sandbox,
      ON_OUTPUT_EXTRA_YAML,
      "on-output-extra",
      backend,
    );

    const state = await readStateSnapshot(runDir);
    expect(state.jobs["review"]!.status).toBe("failed");
    // on_output routing must NOT have retried the target job.
    expect(state.jobs["implement"]!.attempt ?? 1).toBe(1);

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    expect(events.some((e) => e.type === "job_retrying")).toBe(false);
    const failedStep = events.find((e) => e.type === "step_failed");
    expect(String(failedStep!.payload.reason)).toContain("undeclared output(s): extra");
  });
});

// ---------------------------------------------------------------------------
// Manual accept path — acceptAgentReport (Issue #289 P1)
// ---------------------------------------------------------------------------
//
// The shared validator must enforce the same merged outputs + outputs_schema
// contract on the manual `next`/accept path. On any violation, state must not
// advance: the job stays running on the same step, outputs are not persisted,
// and no agent_report_accepted event is emitted.

async function bootstrapAcceptRun(
  sandbox: Sandbox,
  yamlBody: string,
  workflowName: string,
): Promise<{ runId: string; runDir: string }> {
  const workflowPath = join(sandbox.projectRoot, `${workflowName}.yml`);
  await writeFile(workflowPath, yamlBody, "utf-8");

  const { runId } = await createRun({
    workflowPath,
    task: `exercise ${workflowName}`,
    runsDir: sandbox.runsDir,
    skillLockPath: sandbox.skillLockPath,
    clock: new FakeClock(),
  });
  return { runId, runDir: join(sandbox.runsDir, runId) };
}

async function setJobState(
  runDir: string,
  jobId: string,
  patch: { status?: JobState["status"]; attempt?: number; current_step?: string },
): Promise<void> {
  const store = new LocalStateStore();
  const snap = await store.readSnapshot(runDir);
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  const existing = snap.jobs[jobId];
  if (existing === undefined) {
    throw new Error(`job ${jobId} not found in state.json at ${runDir}`);
  }

  const merged: JobState = { ...existing };
  if (patch.status !== undefined) merged.status = patch.status;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step !== undefined) merged.current_step = patch.current_step;

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

async function writeReport(
  runDir: string,
  jobId: string,
  attempt: number,
  stepId: string,
  body: unknown,
): Promise<void> {
  const dir = artifactStepDir(runDir, jobId, attempt, stepId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.json"), JSON.stringify(body, null, 2), "utf-8");
}

function readJobOutputs(snap: RunState, jobId: string): Record<string, unknown> | undefined {
  const js = snap.jobs[jobId] as unknown as { outputs?: Record<string, unknown> };
  return js?.outputs;
}

describe("acceptAgentReport — merged output-contract enforcement (Issue #289 P1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("rejects a report missing an outputs_schema-only key without advancing state", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_SCHEMA_ONLY_YAML,
      "accept-schema-only",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    await writeReport(runDir, "review", 1, "review", {
      outputs: {},
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    let thrown: unknown;
    try {
      await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toContain("missing declared output(s): verdict");

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["review"]!.status).toBe("running");
    expect(snap.jobs["review"]!.current_step).toBe("review");
    expect(readJobOutputs(snap, "review")?.verdict).toBeUndefined();

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
  });

  it("rejects an outputs-only type violation without advancing state", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_OUTPUTS_ONLY_TYPE_YAML,
      "accept-outputs-only-type",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    await writeReport(runDir, "review", 1, "review", {
      outputs: { score: "high" },
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    let thrown: unknown;
    try {
      await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toContain(
      'Output "score" type mismatch: expected number, got string'
    );

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["review"]!.status).toBe("running");
    expect(snap.jobs["review"]!.current_step).toBe("review");
    expect(readJobOutputs(snap, "review")?.score).toBeUndefined();

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
  });

  it("rejects enum values with strict equality (no String coercion) without advancing state", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_NUMERIC_ENUM_YAML,
      "accept-numeric-enum",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    // "1" (string) must NOT match values [1, 2] (numbers) under strict equality.
    await writeReport(runDir, "review", 1, "review", {
      outputs: { code: "1" },
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    let thrown: unknown;
    try {
      await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toContain(
      'Output "code" value "1" is not in declared values'
    );

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["review"]!.status).toBe("running");
    expect(snap.jobs["review"]!.current_step).toBe("review");
    expect(readJobOutputs(snap, "review")?.code).toBeUndefined();

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
  });

  it("accepts a strictly-equal numeric enum value and advances state", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_NUMERIC_ENUM_YAML,
      "accept-numeric-enum",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    await writeReport(runDir, "review", 1, "review", {
      outputs: { code: 1 },
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["review"]!.status).toBe("completed");
    expect(readJobOutputs(snap, "review")?.code).toBe(1);

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(true);
  });

  it("treats an empty outputs_schema enum (values: []) as rejecting every value without advancing state", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_EMPTY_ENUM_SCHEMA_YAML,
      "accept-empty-enum-schema",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "passed" },
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    let thrown: unknown;
    try {
      await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toContain(
      'Output "verdict" value "passed" is not in declared values'
    );

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["review"]!.status).toBe("running");
    expect(snap.jobs["review"]!.current_step).toBe("review");
    expect(readJobOutputs(snap, "review")?.verdict).toBeUndefined();

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
  });

  it("rejects undeclared output keys without advancing state", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_DECLARED_OUTPUT_YAML,
      "accept-declared-output",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "passed", confidence: 0.9 },
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    let thrown: unknown;
    try {
      await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toContain("undeclared output(s): confidence");

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["review"]!.status).toBe("running");
    expect(snap.jobs["review"]!.current_step).toBe("review");
    expect(readJobOutputs(snap, "review")?.verdict).toBeUndefined();
    expect(readJobOutputs(snap, "review")?.confidence).toBeUndefined();

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
  });

  it("rejects an undeclared key before on_output routing can dispatch", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_ON_OUTPUT_EXTRA_YAML,
      "accept-on-output-extra",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    // verdict: "rejected" alone would route retry_job → implement; the
    // undeclared "extra" key must block the whole report first.
    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "rejected", extra: "x" },
      artifacts: [],
      signals: [],
      summary: "review found issues",
    });

    let thrown: unknown;
    try {
      await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toContain("undeclared output(s): extra");

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["review"]!.status).toBe("running");
    expect(snap.jobs["review"]!.current_step).toBe("review");
    expect(readJobOutputs(snap, "review")?.verdict).toBeUndefined();
    // The routing target must be untouched.
    expect(snap.jobs["implement"]!.status).toBe("ready");

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "agent_report_accepted")).toBe(false);
    expect(events.some((e) => e.type === "job_retrying")).toBe(false);
  });

  it("accepts outputs.status when the step declares returns.status (Issue #256 carve-out)", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_RETURNS_STATUS_YAML,
      "accept-returns-status",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    await writeReport(runDir, "review", 1, "review", {
      outputs: { status: "fixed" },
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "step_returned")).toBe(true);

    const snap = await readStateSnapshot(runDir);
    expect(snap.jobs["review"]!.status).toBe("completed");
  });

  it("compiled schema accepts the same outputs.status report the manual path accepts (schema/runtime consistency)", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ACCEPT_RETURNS_STATUS_YAML,
      "accept-returns-status",
    );
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    const report = {
      outputs: { status: "fixed" },
      artifacts: [],
      signals: [],
      summary: "review done",
    };
    await writeReport(runDir, "review", 1, "review", report);

    // The schema compiled from the SAME workflow must accept the exact
    // report the runtime accepts — no schema/runtime drift for the
    // prompt-canonical outputs.status location.
    const wf = await loadWorkflowFile(join(sandbox.projectRoot, "accept-returns-status.yml"));
    const stepDef = wf.jobs["review"]!.steps.find((s) => s.id === "review")!;
    const validate = ajv2020.compile(compileAgentOutputSchema(stepDef));
    expect(validate(report)).toBe(true);

    await acceptAgentReport({ runDir, runId, jobId: "review", clock: new FakeClock() });

    const events = await readEvents(runDir);
    expect(events.some((e) => e.type === "step_returned")).toBe(true);
  });
});
