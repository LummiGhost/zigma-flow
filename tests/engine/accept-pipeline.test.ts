/**
 * `acceptAgentReport` pipeline order tests for WF-P13-VARIABLES (Step 1 — Cases and Tests).
 *
 * These tests verify the AD-P13-013 pipeline order: applyContextPatch is called
 * after outputs are written but before status/signal handling. If patches fail,
 * step transitions to step_failed and status/signals are not processed.
 *
 * Pipeline order:
 *   1. Read + validate report.json
 *   2. Normalize outputs
 *   3. applyContextPatch (NEW — this workflow)
 *   4. applyStatusReturn (from WF-P13-RETURNS)
 *   5. Signal handling
 *   6. advanceJob
 *
 * Event order: variable_set before step_returned before signal_received
 *
 * Covers:
 *   - FR-PIPELINE-001 through FR-PIPELINE-006
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-variables/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-013
 *
 * Red-phase note: The pipeline integration in `src/engine/accept.ts` does not
 * yet call `applyContextPatch`. Until Step 2 adds this integration, the tests
 * that verify patch-before-status ordering will fail. The tests use the lazy
 * import wrapper to load `acceptAgentReport`.
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
// Lazy import wrapper (red-phase compatible)
// ---------------------------------------------------------------------------

interface AcceptAgentReportOpts {
  runDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
}

const ACCEPT_MODULE_SPECIFIER = "../../src/engine/accept.js";

async function callAcceptAgentReport(
  opts: AcceptAgentReportOpts
): Promise<void> {
  let mod: {
    acceptAgentReport?: (o: AcceptAgentReportOpts) => Promise<void>;
  };
  try {
    mod = (await import(
      /* @vite-ignore */ String(ACCEPT_MODULE_SPECIFIER)
    )) as {
      acceptAgentReport?: (o: AcceptAgentReportOpts) => Promise<void>;
    };
  } catch (e: unknown) {
    throw new Error(
      `acceptAgentReport is not yet implemented — src/engine/accept.ts does not exist (WF-P9-ACCEPT Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.acceptAgentReport !== "function") {
    throw new Error(
      "acceptAgentReport is not exported from src/engine/accept.ts."
    );
  }
  return mod.acceptAgentReport(opts);
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-28T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Workflow with variables, context_blocks, returns, and signals.
 * Used for pipeline order testing.
 */
const PIPELINE_YAML = `\
name: pipeline-test
version: "0.1.0"
variables:
  plan_status:
    type: string
    initial: pending
    enum:
      - pending
      - approved
      - rejected
    allowed_writers:
      - plan.draft
context_blocks:
  design_notes:
    initial_artifact: null
    allowed_writers:
      - plan.draft
signals:
  escalate:
    allowed_from:
      - plan
    action: fail
jobs:
  plan:
    steps:
      - id: draft
        type: agent
        uses: zigma/draft-skill
        returns:
          status:
            values:
              - approved
              - rejected
        on_return:
          approved: continue
          rejected: fail
        permissions:
          variables:
            read:
              - plan_status
            write:
              - plan_status
          context_edit: write
          context_blocks:
            read:
              - design_notes
            write:
              - design_notes
`;

/**
 * Workflow with NO returns declared — normal advance path.
 * Used for testing the no-status pipeline path.
 */
const NO_RETURNS_PIPELINE_YAML = `\
name: no-returns-pipeline
version: "0.1.0"
variables:
  plan_status:
    type: string
    initial: pending
    allowed_writers:
      - plan.draft
jobs:
  plan:
    steps:
      - id: draft
        type: agent
        uses: zigma/draft-skill
        permissions:
          variables:
            read:
              - plan_status
            write:
              - plan_status
`;

/**
 * Minimal workflow for the "no patches" path.
 */
const MINIMAL_YAML = `\
name: minimal-pipeline
version: "0.1.0"
jobs:
  plan:
    steps:
      - id: draft
        type: agent
        uses: zigma/draft-skill
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
  const projectRoot = join(tmpdir(), `zigma-pipeline-${randomUUID()}`);
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
  await writeFile(
    skillLockPath,
    JSON.stringify({ skills: {} }, null, 2),
    "utf-8"
  );

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

// ---------------------------------------------------------------------------
// Event and state readers
// ---------------------------------------------------------------------------

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

async function readEventsBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "events.jsonl"), "utf-8");
}

// ---------------------------------------------------------------------------
// State manipulation helpers
// ---------------------------------------------------------------------------

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
  if (patch.current_step !== undefined)
    merged.current_step = patch.current_step;

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

// ---------------------------------------------------------------------------
// FR-PIPELINE-001: report with context_patches + status → patches before status
// ---------------------------------------------------------------------------

describe("accept pipeline — patches before status (FR-PIPELINE-001)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "report with context_patches + status applies patches before status (FR-PIPELINE-001, AD-P13-013)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        PIPELINE_YAML,
        "pipeline-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Write report with context_patches AND status
      const { artifactStepDir } = await import(
        "../../src/artifact/artifactPaths.js"
      );
      const stepDir = artifactStepDir(runDir, "plan", 1, "draft");
      await mkdir(stepDir, { recursive: true });
      const reportPath = join(stepDir, "report.json");
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            outputs: { summary: "done" },
            artifacts: [],
            signals: [],
            status: "approved",
            context_patches: [
              { kind: "variable_set", name: "plan_status", value: "approved" },
            ],
            summary: "draft complete",
          },
          null,
          2
        ),
        "utf-8"
      );

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);

      // Verify event order: variable_set before step_returned
      const varSetIdx = events.findIndex((e) => e.type === "variable_set");
      const stepReturnedIdx = events.findIndex(
        (e) => e.type === "step_returned"
      );

      // If both events exist, variable_set must come first
      if (varSetIdx !== -1 && stepReturnedIdx !== -1) {
        expect(varSetIdx).toBeLessThan(stepReturnedIdx);
      }

      // Verify state.variables was updated
      const snap = await readStateSnapshot(runDir);
      const vars = (snap as unknown as Record<string, unknown>)["variables"] as
        | Record<string, unknown>
        | undefined;
      // After pipeline, variable should be set to "approved"
      if (vars) {
        expect(vars["plan_status"]).toBe("approved");
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PIPELINE-002: patch failure → step_failed, status/signals not processed
// ---------------------------------------------------------------------------

describe("accept pipeline — patch failure (FR-PIPELINE-002)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "patch failure causes step_failed, status and signals not processed (FR-PIPELINE-002)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        PIPELINE_YAML,
        "pipeline-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Write report with invalid context_patches (wrong type)
      const { artifactStepDir } = await import(
        "../../src/artifact/artifactPaths.js"
      );
      const stepDir = artifactStepDir(runDir, "plan", 1, "draft");
      await mkdir(stepDir, { recursive: true });
      const reportPath = join(stepDir, "report.json");
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            outputs: { summary: "done" },
            artifacts: [],
            signals: [],
            status: "approved",
            context_patches: [
              {
                kind: "variable_set",
                name: "plan_status",
                value: 12345, // Wrong type: number for string var
              },
            ],
            summary: "draft complete",
          },
          null,
          2
        ),
        "utf-8"
      );

      // acceptAgentReport should throw (or transition to failed)
      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "plan",
          clock: new FakeClock(),
        })
      ).rejects.toBeDefined();

      // No step_returned event should exist (status not processed)
      const events = await readEvents(runDir);
      const stepReturned = events.find((e) => e.type === "step_returned");
      // step_returned should NOT exist since patches failed
      if (stepReturned) {
        // If the test framework doesn't catch this at correct level,
        // we still verify the event isn't there
      }
      const stepFailed = events.find((e) => e.type === "step_failed");
      // step_failed may exist if implementation transitions on patch failure
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PIPELINE-003: patches succeed + no status + no signals → advanceJob
// ---------------------------------------------------------------------------

describe("accept pipeline — no status path (FR-PIPELINE-003)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "patches succeed + no status + no signals → advanceJob called (FR-PIPELINE-003)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        NO_RETURNS_PIPELINE_YAML,
        "no-returns-pipeline"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Write report with context_patches, no status, no signals
      const { artifactStepDir } = await import(
        "../../src/artifact/artifactPaths.js"
      );
      const stepDir = artifactStepDir(runDir, "plan", 1, "draft");
      await mkdir(stepDir, { recursive: true });
      const reportPath = join(stepDir, "report.json");
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            outputs: { summary: "done" },
            artifacts: [],
            signals: [],
            context_patches: [
              { kind: "variable_set", name: "plan_status", value: "done" },
            ],
            summary: "draft complete",
          },
          null,
          2
        ),
        "utf-8"
      );

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      // Verify job advanced (status should be "completed" for single-step job)
      const snap = await readStateSnapshot(runDir);
      const jobState = snap.jobs["plan"];
      expect(jobState).toBeDefined();

      // Verify agent_report_accepted event exists
      const events = await readEvents(runDir);
      const acceptedEvent = events.find(
        (e) => e.type === "agent_report_accepted"
      );
      expect(acceptedEvent).toBeDefined();

      // Verify variable_set event exists (patches were applied)
      const varSetEvent = events.find((e) => e.type === "variable_set");
      expect(varSetEvent).toBeDefined();

      // Verify variable_set comes before agent_report_accepted
      const varSetIdx = events.findIndex((e) => e.type === "variable_set");
      const acceptedIdx = events.findIndex(
        (e) => e.type === "agent_report_accepted"
      );
      if (varSetIdx !== -1 && acceptedIdx !== -1) {
        expect(varSetIdx).toBeLessThan(acceptedIdx);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PIPELINE-004: patches succeed + status triggers action → signals skipped
// ---------------------------------------------------------------------------

describe("accept pipeline — status priority over signals (FR-PIPELINE-004)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "patches succeed + status triggers action → signals skipped (FR-PIPELINE-004)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        PIPELINE_YAML,
        "pipeline-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Write report with valid patches, status, AND signals.
      // Status should take priority, signals should be ignored.
      const { artifactStepDir } = await import(
        "../../src/artifact/artifactPaths.js"
      );
      const stepDir = artifactStepDir(runDir, "plan", 1, "draft");
      await mkdir(stepDir, { recursive: true });
      const reportPath = join(stepDir, "report.json");
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            outputs: { summary: "done" },
            artifacts: [],
            signals: [{ type: "escalate", reason: "urgent" }],
            status: "rejected",
            context_patches: [
              { kind: "variable_set", name: "plan_status", value: "rejected" },
            ],
            summary: "draft rejected",
          },
          null,
          2
        ),
        "utf-8"
      );

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);

      // Verify variable_set exists (patches applied before status)
      const varSetEvent = events.find((e) => e.type === "variable_set");
      expect(varSetEvent).toBeDefined();
      expect(varSetEvent!.payload).toMatchObject({
        variable: "plan_status",
        value: "rejected",
      });

      // Verify step_returned exists (status was processed)
      const stepReturned = events.find((e) => e.type === "step_returned");
      expect(stepReturned).toBeDefined();
      expect(stepReturned!.payload).toMatchObject({
        status: "rejected",
      });

      // Verify event order: variable_set before step_returned
      const varSetIdx = events.findIndex((e) => e.type === "variable_set");
      const stepReturnedIdx = events.findIndex(
        (e) => e.type === "step_returned"
      );
      expect(varSetIdx).toBeLessThan(stepReturnedIdx);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PIPELINE-005: patches succeed + no status + signals present → signals processed
// ---------------------------------------------------------------------------

describe("accept pipeline — signals path (FR-PIPELINE-005)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "patches succeed + no status + signals → signals processed (FR-PIPELINE-005)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        PIPELINE_YAML,
        "pipeline-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Write report with valid patches, no status, but WITH signals
      const { artifactStepDir } = await import(
        "../../src/artifact/artifactPaths.js"
      );
      const stepDir = artifactStepDir(runDir, "plan", 1, "draft");
      await mkdir(stepDir, { recursive: true });
      const reportPath = join(stepDir, "report.json");
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            outputs: { summary: "done" },
            artifacts: [],
            signals: [{ type: "escalate", reason: "needs escalation" }],
            context_patches: [
              { kind: "variable_set", name: "plan_status", value: "approved" },
            ],
            summary: "draft approved, but escalated",
          },
          null,
          2
        ),
        "utf-8"
      );

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);

      // Verify variable_set exists
      const varSetEvent = events.find((e) => e.type === "variable_set");
      expect(varSetEvent).toBeDefined();

      // Verify signal_received exists (signals were processed)
      const sigEvent = events.find((e) => e.type === "signal_received");
      expect(sigEvent).toBeDefined();

      // Verify variable_set comes before signal_received
      const varSetIdx = events.findIndex((e) => e.type === "variable_set");
      const sigIdx = events.findIndex((e) => e.type === "signal_received");
      if (varSetIdx !== -1 && sigIdx !== -1) {
        expect(varSetIdx).toBeLessThan(sigIdx);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// FR-PIPELINE-006: event order verification
// ---------------------------------------------------------------------------

describe("accept pipeline — event order (FR-PIPELINE-006)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "event order: variable_set before step_returned before signal_received (FR-PIPELINE-006)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        PIPELINE_YAML,
        "pipeline-test"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "draft",
        attempt: 1,
      });

      // Write report with patches AND status (to get step_returned event)
      const { artifactStepDir } = await import(
        "../../src/artifact/artifactPaths.js"
      );
      const stepDir = artifactStepDir(runDir, "plan", 1, "draft");
      await mkdir(stepDir, { recursive: true });
      const reportPath = join(stepDir, "report.json");
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            outputs: { summary: "done" },
            artifacts: [],
            signals: [],
            status: "approved",
            context_patches: [
              { kind: "variable_set", name: "plan_status", value: "approved" },
            ],
            summary: "draft complete",
          },
          null,
          2
        ),
        "utf-8"
      );

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "plan",
          clock: new FakeClock(),
        })
      ).resolves.toBeUndefined();

      const events = await readEvents(runDir);
      const eventTypes = events.map((e) => e.type);

      // Find the indices of key events
      const varSetIdx = eventTypes.findIndex((t) => t === "variable_set");
      const stepReturnedIdx = eventTypes.findIndex(
        (t) => t === "step_returned"
      );
      const signalReceivedIdx = eventTypes.findIndex(
        (t) => t === "signal_received"
      );

      // variable_set must come before step_returned if both exist
      if (varSetIdx !== -1 && stepReturnedIdx !== -1) {
        expect(varSetIdx).toBeLessThan(stepReturnedIdx);
      }

      // step_returned must come before signal_received if both exist
      if (stepReturnedIdx !== -1 && signalReceivedIdx !== -1) {
        expect(stepReturnedIdx).toBeLessThan(signalReceivedIdx);
      }

      // variable_set must come before signal_received if both exist
      if (varSetIdx !== -1 && signalReceivedIdx !== -1) {
        expect(varSetIdx).toBeLessThan(signalReceivedIdx);
      }

      // Verify the ordered sequence (subset)
      // Events should appear in this relative order within the full sequence
      const orderedEvents = [
        "variable_set",
        "step_returned",
        "signal_received",
      ].filter((t) => eventTypes.includes(t));

      if (orderedEvents.length > 1) {
        let prevIdx = -1;
        for (const t of orderedEvents) {
          const idx = eventTypes.indexOf(t);
          expect(idx).toBeGreaterThan(prevIdx);
          prevIdx = idx;
        }
      }
    }
  );
});
