/**
 * `applyStatusReturn` tests for WF-P13-RETURNS (Step 1 — Cases and Tests).
 *
 * These tests exercise the Engine's Step Structured Return Status entry point
 * that translates an Agent report's `status` field into a routing action via
 * the step's declared `on_return` mapping.
 *
 * Pipeline position (AD-P13-013): `applyStatusReturn` is called from
 * `acceptAgentReport` after outputs are persisted and context_patches are
 * applied, but before signal handling. Status action takes priority over
 * signals.
 *
 * Covers:
 *   - FR-STATUS-RETURN-001: status matches on_return key → action + event
 *   - FR-STATUS-RETURN-002: required=true, status missing → ValidationError
 *   - FR-STATUS-RETURN-003: status not in values → ValidationError
 *   - FR-STATUS-RETURN-004: no returns declared, status → outputs (via accept)
 *   - FR-STATUS-RETURN-005: status → retry_job action
 *   - FR-STATUS-RETURN-006: status → goto_job action
 *   - FR-STATUS-RETURN-007: status → continue action
 *   - FR-STATUS-RETURN-008: on_return missing mapping for specific status
 *   - FR-STATUS-RETURN-009: multiple values, second match
 *   - FR-STATUS-RETURN-010: step_returned event payload correctness
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-returns/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-009
 *
 * Red-phase note: `src/engine/applyStatusReturn.ts` does not yet exist. The
 * lazy import wrapper catches the dynamic-import failure and re-throws a
 * descriptive Error so every test fails for the same diagnostic reason until
 * Step 2 ships the module.
 *
 * Test design notes:
 *   - All snapshot writes are observed via real filesystem reads — no mocking.
 *   - Real temp directories under `os.tmpdir()`.
 *   - `applyStatusReturn` is the sole place that emits `step_returned`.
 *   - Negative tests capture events.jsonl + state.json bytes before and after
 *     the call to assert zero mutation on error.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";

// ---------------------------------------------------------------------------
// Lazy import wrappers (red-phase compatible)
// ---------------------------------------------------------------------------

interface ApplyStatusReturnOpts {
  runDir: string;
  runId: string;
  sourceJobId: string;
  sourceStepId: string;
  attempt: number;
  status: string;
  clock: Clock;
}

interface AcceptAgentReportOpts {
  runDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
}

const APPLY_STATUS_RETURN_SPECIFIER = "../../src/engine/applyStatusReturn.js";

async function callApplyStatusReturn(
  opts: ApplyStatusReturnOpts
): Promise<void> {
  let mod: {
    applyStatusReturn?: (o: ApplyStatusReturnOpts) => Promise<void>;
  };
  try {
    // The `String(...)` indirection is a deliberate compile-time opacity barrier.
    mod = (await import(
      /* @vite-ignore */ String(APPLY_STATUS_RETURN_SPECIFIER)
    )) as {
      applyStatusReturn?: (o: ApplyStatusReturnOpts) => Promise<void>;
    };
  } catch (e: unknown) {
    throw new Error(
      `applyStatusReturn is not yet implemented — src/engine/applyStatusReturn.ts does not exist (WF-P13-RETURNS Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.applyStatusReturn !== "function") {
    throw new Error(
      "applyStatusReturn is not exported from src/engine/applyStatusReturn.ts — WF-P13-RETURNS Step 2 has not yet shipped the implementation."
    );
  }
  return mod.applyStatusReturn(opts);
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
 * Workflow: single agent step in job `review` with returns.status.values
 * and on_return mapping to `continue`.
 */
const RETURNS_CONTINUE_YAML = `\
name: returns-continue
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review-step
        type: agent
        uses: zigma/review-skill
        returns:
          status:
            values:
              - approved
              - rejected
            required: false
        on_return:
          approved: continue
          rejected: fail
`;

/**
 * Workflow: step with returns.status.required: true.
 */
const RETURNS_REQUIRED_YAML = `\
name: returns-required
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review-step
        type: agent
        uses: zigma/review-skill
        returns:
          status:
            values:
              - pass
              - fail
            required: true
        on_return:
          pass: continue
          fail: fail
`;

/**
 * Workflow: step with returns but NO on_return mapping for one status value.
 * Values: [approved, rejected]; on_return only maps approved.
 */
const RETURNS_PARTIAL_ON_RETURN_YAML = `\
name: returns-partial
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review-step
        type: agent
        uses: zigma/review-skill
        returns:
          status:
            values:
              - approved
              - rejected
        on_return:
          approved: continue
`;

/**
 * Workflow: step with returns + on_return containing retry_job to another job.
 */
const RETURNS_RETRY_JOB_YAML = `\
name: returns-retry-job
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: implement-step
        type: agent
        uses: zigma/implement-skill
  review:
    steps:
      - id: review-step
        type: agent
        uses: zigma/review-skill
        returns:
          status:
            values:
              - approved
              - rejected
        on_return:
          approved: continue
          rejected:
            retry_job: implement
`;

/**
 * Workflow: step with returns + on_return containing goto_job to another job.
 */
const RETURNS_GOTO_JOB_YAML = `\
name: returns-goto-job
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review-step
        type: agent
        uses: zigma/review-skill
        returns:
          status:
            values:
              - approved
              - escalated
        on_return:
          approved: continue
          escalated:
            goto_job: escalation
  escalation:
    activation: optional
    steps:
      - id: escalation-step
        type: agent
        uses: zigma/escalation-skill
`;

/**
 * Workflow: multiple status values.
 */
const RETURNS_MULTI_VALUES_YAML = `\
name: returns-multi-values
version: "0.1.0"
jobs:
  review:
    steps:
      - id: review-step
        type: agent
        uses: zigma/review-skill
        returns:
          status:
            values:
              - approved
              - rejected
              - needs_clarification
        on_return:
          approved: continue
          rejected:
            retry_job: review
          needs_clarification: fail
`;

/**
 * Workflow: NO returns — for backward compatibility testing.
 */
const NO_RETURNS_YAML = `\
name: no-returns
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: intake
        type: agent
        uses: zigma/intake-skill
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
  const projectRoot = join(tmpdir(), `zigma-returns-${randomUUID()}`);
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

async function readStateBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "state.json"), "utf-8");
}

// ---------------------------------------------------------------------------
// State manipulation
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

/**
 * Read `JobState.outputs` even if the field is not yet present on the
 * public `JobState` type (Step 2 adds it).
 */
function readOutputs(
  snap: RunState,
  jobId: string
): Record<string, unknown> | undefined {
  const js = snap.jobs[jobId] as unknown as {
    outputs?: Record<string, unknown>;
  };
  return js?.outputs;
}

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-001: status matches on_return → action + step_returned
// ---------------------------------------------------------------------------

describe("applyStatusReturn — status match triggers action (FR-STATUS-RETURN-001)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "dispatches on_return.continue action and emits step_returned event (FR-STATUS-RETURN-001, UC-RETURNS-001, FP-STATUS-RETURN-001)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_CONTINUE_YAML,
        "returns-continue"
      );

      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      await callApplyStatusReturn({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "review-step",
        attempt: 1,
        status: "approved",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);

      // step_returned event must be present
      const returnedEvent = events.find((e) => e.type === "step_returned");
      expect(returnedEvent).toBeDefined();
      expect(returnedEvent!.payload).toMatchObject({
        status: "approved",
        mapped_action: "continue",
      });

      // continue action should also produce signal_received (via applyRoutingAction)
      const sigEvent = events.find((e) => e.type === "signal_received");
      expect(sigEvent).toBeDefined();
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-002: required=true, status missing → ValidationError
// ---------------------------------------------------------------------------

describe("applyStatusReturn — required status missing (FR-STATUS-RETURN-002)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ValidationError when required=true and status is missing (FR-STATUS-RETURN-002, UC-RETURNS-002, FP-STATUS-RETURN-002)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_REQUIRED_YAML,
        "returns-required"
      );

      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      // Call with an empty status (simulating missing status field)
      await expect(
        callApplyStatusReturn({
          runDir,
          runId,
          sourceJobId: "review",
          sourceStepId: "review-step",
          attempt: 1,
          status: "",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "ValidationError" });

      // No disk mutation on validation failure
      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-003: status not in values → ValidationError
// ---------------------------------------------------------------------------

describe("applyStatusReturn — status not in values (FR-STATUS-RETURN-003)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ValidationError when status is not in returns.status.values (FR-STATUS-RETURN-003, UC-RETURNS-003, FP-STATUS-RETURN-003)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_CONTINUE_YAML,
        "returns-continue"
      );

      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callApplyStatusReturn({
          runDir,
          runId,
          sourceJobId: "review",
          sourceStepId: "review-step",
          attempt: 1,
          status: "bogus",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "ValidationError" });

      // No disk mutation
      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-004: no returns declared, status → outputs only
// ---------------------------------------------------------------------------

describe("applyStatusReturn — no returns declared (FR-STATUS-RETURN-004)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "when no returns declared, status field goes to outputs without triggering action (FR-STATUS-RETURN-004, UC-RETURNS-004, FP-STATUS-RETURN-004)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        NO_RETURNS_YAML,
        "no-returns"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      // Write a report with status field. This exercises acceptAgentReport
      // which should treat status as data when no returns declared.
      // We import and use artifactPaths for the canonical report location.
      const { artifactStepDir } = await import(
        "../../src/artifact/artifactPaths.js"
      );
      const stepDir = artifactStepDir(runDir, "intake", 1, "intake");
      await mkdir(stepDir, { recursive: true });
      const reportPath = join(stepDir, "report.json");
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            outputs: { summary: "done" },
            artifacts: [],
            signals: [],
            status: "anything",
            summary: "intake complete",
          },
          null,
          2
        ),
        "utf-8"
      );

      // FR-STATUS-RETURN-004: when no returns declared, status goes to outputs
      // without triggering routing action. The acceptAgentReport pipeline:
      // - accepts the status field (no schema rejection)
      // - includes it in outputs alongside other report.outputs
      // - no step_returned event emitted
      // - no routing action triggered
      // - normal signal/advance pipeline proceeds

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
          clock: new FakeClock(),
        })
      ).resolves.toBeUndefined();

      // Verify state was updated — job should be completed
      const store = new LocalStateStore();
      const stateAfter = await store.readSnapshot(runDir);
      expect(stateAfter).not.toBeNull();
      const jobAfter = stateAfter!.jobs["intake"];
      expect(jobAfter).toBeDefined();
      // job should be completed (single-step job, no more steps)
      expect(jobAfter!.status).toBe("completed");

      // Verify no step_returned event in events.jsonl
      const eventsPath = join(runDir, "events.jsonl");
      const eventsText = await readFile(eventsPath, "utf-8");
      expect(eventsText).not.toContain("step_returned");
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-005: status triggers retry_job action
// ---------------------------------------------------------------------------

describe("applyStatusReturn — retry_job action (FR-STATUS-RETURN-005)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "dispatches retry_job action and emits step_returned event (FR-STATUS-RETURN-005, UC-RETURNS-005, FP-STATUS-RETURN-005)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_RETRY_JOB_YAML,
        "returns-retry-job"
      );

      // implement is completed (attempt 1), review is running
      await setJobState(runDir, "implement", {
        status: "completed",
        attempt: 1,
      });
      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      await callApplyStatusReturn({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "review-step",
        attempt: 1,
        status: "rejected",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);

      // step_returned event
      const returnedEvent = events.find((e) => e.type === "step_returned");
      expect(returnedEvent).toBeDefined();
      expect(returnedEvent!.payload).toMatchObject({
        status: "rejected",
        mapped_action: "retry_job",
      });

      // job_retrying event for the target job
      const retryEvent = events.find((e) => e.type === "job_retrying");
      expect(retryEvent).toBeDefined();
      expect(retryEvent!.job).toBe("implement");

      // implement should be reset to ready with incremented attempt
      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["implement"]!.status).toBe("ready");
      expect(snap.jobs["implement"]!.attempt).toBe(2);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-006: status triggers goto_job action
// ---------------------------------------------------------------------------

describe("applyStatusReturn — goto_job action (FR-STATUS-RETURN-006)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "dispatches goto_job action and emits step_returned event (FR-STATUS-RETURN-006, UC-RETURNS-006, FP-STATUS-RETURN-006)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_GOTO_JOB_YAML,
        "returns-goto-job"
      );

      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      await callApplyStatusReturn({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "review-step",
        attempt: 1,
        status: "escalated",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);

      // step_returned event
      const returnedEvent = events.find((e) => e.type === "step_returned");
      expect(returnedEvent).toBeDefined();
      expect(returnedEvent!.payload).toMatchObject({
        status: "escalated",
        mapped_action: "goto_job",
      });

      // job_skipped event (source job completed, target activated)
      const skippedEvent = events.find((e) => e.type === "job_skipped");
      expect(skippedEvent).toBeDefined();
      expect(skippedEvent!.job).toBe("review");
      expect(skippedEvent!.payload).toMatchObject({ target: "escalation" });

      const snap = await readStateSnapshot(runDir);
      // Source job completed
      expect(snap.jobs["review"]!.status).toBe("completed");
      // Target job activated
      expect(["ready", "waiting"]).toContain(
        snap.jobs["escalation"]!.status
      );
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-007: status triggers continue → advanceJob
// ---------------------------------------------------------------------------

describe("applyStatusReturn — continue action (FR-STATUS-RETURN-007)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "dispatches continue action, advances job, and emits step_returned (FR-STATUS-RETURN-007, UC-RETURNS-007, FP-STATUS-RETURN-007)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_CONTINUE_YAML,
        "returns-continue"
      );

      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      await callApplyStatusReturn({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "review-step",
        attempt: 1,
        status: "approved",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);

      // step_returned event
      const returnedEvent = events.find((e) => e.type === "step_returned");
      expect(returnedEvent).toBeDefined();
      expect(returnedEvent!.payload).toMatchObject({
        status: "approved",
        mapped_action: "continue",
      });

      // signal_received from applyRoutingAction
      const sigEvent = events.find((e) => e.type === "signal_received");
      expect(sigEvent).toBeDefined();

      // Job should advance (single-step → completed)
      const snap = await readStateSnapshot(runDir);
      expect(
        ["completed", "running"].includes(snap.jobs["review"]!.status)
      ).toBe(true);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-008: on_return missing mapping for specific status
// ---------------------------------------------------------------------------

describe("applyStatusReturn — on_return missing mapping (FR-STATUS-RETURN-008)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ValidationError when status is in values but has no on_return mapping (FR-STATUS-RETURN-008, UC-RETURNS-008, FP-STATUS-RETURN-008)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_PARTIAL_ON_RETURN_YAML,
        "returns-partial"
      );

      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      // rejected is in values [approved, rejected] but on_return only maps approved
      await expect(
        callApplyStatusReturn({
          runDir,
          runId,
          sourceJobId: "review",
          sourceStepId: "review-step",
          attempt: 1,
          status: "rejected",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "ValidationError" });

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-009: multiple values, second match
// ---------------------------------------------------------------------------

describe("applyStatusReturn — multiple values, second match (FR-STATUS-RETURN-009)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "correctly dispatches action when status matches a later value in the list (FR-STATUS-RETURN-009, UC-RETURNS-009, FP-STATUS-RETURN-009)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_MULTI_VALUES_YAML,
        "returns-multi-values"
      );

      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      // needs_clarification maps to fail
      await callApplyStatusReturn({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "review-step",
        attempt: 1,
        status: "needs_clarification",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);

      const returnedEvent = events.find((e) => e.type === "step_returned");
      expect(returnedEvent).toBeDefined();
      expect(returnedEvent!.payload).toMatchObject({
        status: "needs_clarification",
        mapped_action: "fail",
      });

      // fail action should set job status to failed
      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["review"]!.status).toBe("failed");
    }
  );
});

// ---------------------------------------------------------------------------
// FR-STATUS-RETURN-010: step_returned event payload fields
// ---------------------------------------------------------------------------

describe("applyStatusReturn — step_returned event payload (FR-STATUS-RETURN-010)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "step_returned event has correct payload: job_id, step_id, status, mapped_action (FR-STATUS-RETURN-010, UC-RETURNS-010, FP-STATUS-RETURN-010)",
    async () => {
      const { runId, runDir } = await bootstrapRun(
        sandbox,
        RETURNS_CONTINUE_YAML,
        "returns-continue"
      );

      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      await callApplyStatusReturn({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "review-step",
        attempt: 1,
        status: "approved",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const returnedEvent = events.find((e) => e.type === "step_returned");
      expect(returnedEvent).toBeDefined();

      // Verify envelope fields
      expect(returnedEvent!.run_id).toBe(runId);
      expect(returnedEvent!.job).toBe("review");
      expect(returnedEvent!.step).toBe("review-step");
      expect(returnedEvent!.attempt).toBe(1);

      // Verify payload fields per StepReturnedPayload contract
      expect(returnedEvent!.payload).toMatchObject({
        job_id: "review",
        step_id: "review-step",
        status: "approved",
        mapped_action: "continue",
      });
    }
  );
});
