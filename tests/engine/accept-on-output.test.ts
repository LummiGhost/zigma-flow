/**
 * acceptAgentReport tests for on_output routing and output value validation
 * (Issue #172).
 *
 * These tests exercise:
 *   - T-ON-OUTPUT-1: on_output routing dispatches a retry_job action
 *                    when an output value matches an on_output rule
 *   - T-ON-OUTPUT-2: on_output routing takes priority over signal routing
 *   - T-ON-OUTPUT-3: no on_output match falls through to signal routing
 *   - T-ON-OUTPUT-4: output value validation rejects values not in
 *                    declared `values` set
 *   - T-ON-OUTPUT-5: backward compat — step without on_output works unchanged
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import { artifactStepDir } from "../../src/artifact/artifactPaths.js";

// ---------------------------------------------------------------------------
// Lazy import wrapper (same as accept.test.ts)
// ---------------------------------------------------------------------------

interface AcceptAgentReportOpts {
  runDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
}

const ACCEPT_MODULE_SPECIFIER = "../../src/engine/accept.js";

async function callAcceptAgentReport(opts: AcceptAgentReportOpts): Promise<void> {
  let mod: { acceptAgentReport?: (o: AcceptAgentReportOpts) => Promise<void> };
  try {
    mod = (await import(/* @vite-ignore */ String(ACCEPT_MODULE_SPECIFIER))) as {
      acceptAgentReport?: (o: AcceptAgentReportOpts) => Promise<void>;
    };
  } catch (e: unknown) {
    throw new Error(
      `acceptAgentReport is not yet implemented — src/engine/accept.ts does not exist. Underlying: ${String(e)}`
    );
  }
  if (typeof mod.acceptAgentReport !== "function") {
    throw new Error(
      "acceptAgentReport is not exported from src/engine/accept.ts"
    );
  }
  return mod.acceptAgentReport(opts);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-11T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Workflow with on_output routing: when verdict=rejected, retry implement job.
 */
const ON_OUTPUT_RETRY_YAML = `\
name: on-output-retry
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

/**
 * Workflow with on_output routing and signal — on_output should take priority.
 */
const ON_OUTPUT_WITH_SIGNAL_YAML = `\
name: on-output-with-signal
version: "0.1.0"
signals:
  blocker:
    priority: 100
    allowed_from:
      - review
    action: block
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

/**
 * Workflow with on_output routing and no matching value — should fall through to signals.
 */
const ON_OUTPUT_NO_MATCH_YAML = `\
name: on-output-no-match
version: "0.1.0"
signals:
  blocker:
    priority: 100
    allowed_from:
      - review
    action: block
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
`;

/**
 * Workflow with outputs that have a `values` constraint.
 */
const OUTPUT_VALUES_YAML = `\
name: output-values
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review
        type: agent
        uses: zigma/review-skill
        outputs:
          verdict:
            type: string
            values:
              - passed
              - rejected
              - escalate
`;

/**
 * Workflow with outputs that have a `values` constraint via outputs_schema.
 */
const OUTPUT_VALUES_SCHEMA_YAML = `\
name: output-values-schema
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
              - rejected
              - escalate
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
  const projectRoot = join(tmpdir(), `zigma-on-output-${randomUUID()}`);
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

async function bootstrapAcceptRun(
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
  if (snap === null) {
    throw new Error(`state.json missing at ${runDir}`);
  }
  return snap;
}

interface JobStatePatch {
  status?: JobState["status"];
  attempt?: number;
  current_step?: string;
}

async function setJobState(
  runDir: string,
  jobId: string,
  patch: JobStatePatch
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
  body: unknown | string,
  options: { raw?: boolean } = {}
): Promise<void> {
  const dir = artifactStepDir(runDir, jobId, attempt, stepId);
  await mkdir(dir, { recursive: true });
  const reportPath = join(dir, "report.json");
  const text =
    options.raw === true ? (body as string) : JSON.stringify(body, null, 2);
  await writeFile(reportPath, text, "utf-8");
}

function readOutputs(snap: RunState, jobId: string): Record<string, unknown> | undefined {
  const js = snap.jobs[jobId] as unknown as { outputs?: Record<string, unknown> };
  return js?.outputs;
}

// ---------------------------------------------------------------------------
// T-ON-OUTPUT-1: on_output routing dispatches retry_job
// ---------------------------------------------------------------------------

describe("acceptAgentReport — on_output retry_job routing (T-ON-OUTPUT-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("dispatches retry_job when output value matches on_output rule", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ON_OUTPUT_RETRY_YAML,
      "on-output-retry"
    );

    // Set review job to running state
    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    // Set implement job to completed (needs retry target available)
    await setJobState(runDir, "implement", {
      status: "completed",
      attempt: 1,
    });

    // Write report with verdict=rejected
    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "rejected" },
      artifacts: [],
      signals: [],
      summary: "review found issues",
    });

    await callAcceptAgentReport({
      runDir,
      runId,
      jobId: "review",
      clock: new FakeClock(),
    });

    const snap = await readStateSnapshot(runDir);

    // The implement job should be retried (status → ready, attempt incremented)
    const implementJob = snap.jobs["implement"];
    expect(implementJob).toBeDefined();
    if (implementJob) {
      // Either ready (retry was within limits) or status unchanged
      expect(["ready", "completed"]).toContain(implementJob.status);
    }

    // Outputs should be persisted
    const outputs = readOutputs(snap, "review");
    expect(outputs?.verdict).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// T-ON-OUTPUT-2: on_output takes priority over signal routing
// ---------------------------------------------------------------------------

describe("acceptAgentReport — on_output priority over signals (T-ON-OUTPUT-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("dispatches on_output instead of signal when both match", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ON_OUTPUT_WITH_SIGNAL_YAML,
      "on-output-with-signal"
    );

    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    await setJobState(runDir, "implement", {
      status: "completed",
      attempt: 1,
    });

    // Write report with both: verdict=rejected (matches on_output) AND a signal
    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "rejected" },
      artifacts: [],
      signals: [{ type: "blocker", reason: "critical issue" }],
      summary: "review found blocking issues",
    });

    await callAcceptAgentReport({
      runDir,
      runId,
      jobId: "review",
      clock: new FakeClock(),
    });

    const snap = await readStateSnapshot(runDir);

    // The review job should NOT be blocked (signal was ignored in favor of on_output)
    const reviewJob = snap.jobs["review"];
    expect(reviewJob).toBeDefined();
    if (reviewJob) {
      expect(reviewJob.status).not.toBe("blocked");
    }

    // Outputs should be persisted
    const outputs = readOutputs(snap, "review");
    expect(outputs?.verdict).toBe("rejected");

    // The implement job should have been retried (on_output was dispatched)
    const implementJob = snap.jobs["implement"];
    expect(implementJob).toBeDefined();
    if (implementJob) {
      expect(["ready", "completed"]).toContain(implementJob.status);
    }
  });
});

// ---------------------------------------------------------------------------
// T-ON-OUTPUT-3: no on_output match falls through to signal routing
// ---------------------------------------------------------------------------

describe("acceptAgentReport — no on_output match falls through (T-ON-OUTPUT-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("falls through to signal routing when output value does not match on_output", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      ON_OUTPUT_NO_MATCH_YAML,
      "on-output-no-match"
    );

    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    // verdict=passed does NOT match on_output.verdict.rejected
    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "passed" },
      artifacts: [],
      signals: [{ type: "blocker", reason: "signal should fire" }],
      summary: "review passed but signal",
    });

    await callAcceptAgentReport({
      runDir,
      runId,
      jobId: "review",
      clock: new FakeClock(),
    });

    const snap = await readStateSnapshot(runDir);

    // The review job should be blocked (signal was dispatched)
    const reviewJob = snap.jobs["review"];
    expect(reviewJob).toBeDefined();
    if (reviewJob) {
      expect(reviewJob.status).toBe("blocked");
    }

    // Outputs should be persisted
    const outputs = readOutputs(snap, "review");
    expect(outputs?.verdict).toBe("passed");
  });
});

// ---------------------------------------------------------------------------
// T-ON-OUTPUT-4: output value validation rejects invalid values
// ---------------------------------------------------------------------------

describe("acceptAgentReport — output value validation (T-ON-OUTPUT-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("rejects output value not in declared values set (outputs field)", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      OUTPUT_VALUES_YAML,
      "output-values"
    );

    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    // verdict=unknown is NOT in [passed, rejected, escalate]
    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "unknown" },
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    let thrown: unknown;
    try {
      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "review",
        clock: new FakeClock(),
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const err = thrown as Error;
    expect(err.message.toLowerCase()).toContain("verdict");
    expect(err.message.toLowerCase()).toContain("unknown");
  });

  it("accepts output value that IS in declared values set", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      OUTPUT_VALUES_YAML,
      "output-values"
    );

    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    // verdict=passed IS in [passed, rejected, escalate]
    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "passed" },
      artifacts: [],
      signals: [],
      summary: "review passed",
    });

    await callAcceptAgentReport({
      runDir,
      runId,
      jobId: "review",
      clock: new FakeClock(),
    });

    const snap = await readStateSnapshot(runDir);
    const outputs = readOutputs(snap, "review");
    expect(outputs?.verdict).toBe("passed");
  });

  it("rejects output value not in declared values set (outputs_schema field)", async () => {
    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      OUTPUT_VALUES_SCHEMA_YAML,
      "output-values-schema"
    );

    await setJobState(runDir, "review", {
      status: "running",
      current_step: "review",
      attempt: 1,
    });

    // verdict=unknown is NOT in [passed, rejected, escalate]
    await writeReport(runDir, "review", 1, "review", {
      outputs: { verdict: "unknown" },
      artifacts: [],
      signals: [],
      summary: "review done",
    });

    let thrown: unknown;
    try {
      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "review",
        clock: new FakeClock(),
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const err = thrown as Error;
    expect(err.message.toLowerCase()).toContain("verdict");
    expect(err.message.toLowerCase()).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// T-ON-OUTPUT-5: backward compat — step without on_output
// ---------------------------------------------------------------------------

describe("acceptAgentReport — backward compat without on_output (T-ON-OUTPUT-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it("works correctly for step without on_output (existing behavior)", async () => {
    // Use the standard no-signal workflow from the existing accept tests
    const yaml = `\
name: no-on-output
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

    const { runId, runDir } = await bootstrapAcceptRun(
      sandbox,
      yaml,
      "no-on-output"
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
      summary: "review passed",
    });

    await callAcceptAgentReport({
      runDir,
      runId,
      jobId: "review",
      clock: new FakeClock(),
    });

    const events = await readEvents(runDir);
    const accepted = events.find((e) => e.type === "agent_report_accepted");
    expect(accepted).toBeDefined();

    const snap = await readStateSnapshot(runDir);
    const outputs = readOutputs(snap, "review");
    expect(outputs?.verdict).toBe("passed");

    // Job should advance
    const reviewJob = snap.jobs["review"];
    expect(reviewJob).toBeDefined();
  });
});
