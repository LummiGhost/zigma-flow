/**
 * `acceptAgentReport` tests for WF-P9-ACCEPT (Step 1 — Cases and Tests).
 *
 * These tests exercise the Engine's Agent Report acceptance entry point
 * that closes the Agent execution loop: an Agent has written
 * `report.json` to the canonical artifact location
 * (`<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/report.json`),
 * the user runs `zigma-flow next --job <id>`, and the Engine reads the
 * report, validates it, persists `outputs` to job state, dispatches the
 * highest-priority declared signal through `applyRoutingAction`, or on
 * the no-signal path appends `agent_report_accepted` and delegates to
 * `advanceJob`.
 *
 * Covers:
 *   - T-ACCEPT-1:  no-signal report — emits agent_report_accepted +
 *                  advances job pointer.
 *   - T-ACCEPT-2:  outputs persist to JobState.outputs.
 *   - T-ACCEPT-3:  valid signal — dispatches via applyRoutingAction
 *                  (activate_job target reaches "ready"; NO
 *                  agent_report_accepted event).
 *   - T-ACCEPT-4:  undeclared signal → ValidationError; no disk
 *                  mutation.
 *   - T-ACCEPT-5:  signal source not in allowed_from → WorkflowError;
 *                  no disk mutation.
 *   - T-ACCEPT-6:  report.json missing → FilesystemError; no disk
 *                  mutation.
 *   - T-ACCEPT-7:  report.json malformed JSON → ValidationError; no
 *                  disk mutation.
 *   - T-ACCEPT-8:  report.json missing outputs field → ValidationError;
 *                  no disk mutation.
 *   - T-ACCEPT-9:  report.json missing signals field → ValidationError;
 *                  no disk mutation.
 *   - T-ACCEPT-10: multiple valid signals — only highest priority
 *                  signal's action is dispatched.
 *   - T-ACCEPT-11: agent_report_accepted payload has correct fields
 *                  (job_id, step_id, report_artifact + envelope
 *                  run_id, job, step, attempt).
 *   - T-ACCEPT-12: signal with no reason — accepted; dispatched with
 *                  synthesized reason.
 *
 * Reference:
 *   - docs/phases/p9-agent-report-retry/workflows/wf-p9-accept/01-cases-and-tests.md
 *   - docs/architecture.md §7.1, §7.2
 *   - docs/mvp-contracts.md §2.3, §2.4, §2.6
 *   - docs/prd.md §FR-010, §20
 *
 * Red-phase note: `src/engine/accept.ts` does not yet exist. The lazy
 * import wrapper below catches the dynamic-import failure and re-throws
 * a descriptive Error so the test file compiles and every test in this
 * file fails for the same diagnostic reason until WF-P9-ACCEPT Step 2
 * ships the module. Step 2 also extends `JobState` with the `outputs`
 * field and refines `WorkflowDefinition.signals` to a structured
 * `SignalDeclaration` schema; the test file therefore reads
 * `JobState.outputs` via `as unknown as { outputs?: ... }` casts to
 * avoid a Step-1 dependency on the new field.
 *
 * Test design notes:
 *   - All snapshot writes are observed via real filesystem reads —
 *     no mocking. Real temp directories under `os.tmpdir()`.
 *   - The handler is contracted to be the SOLE place that emits
 *     `agent_report_accepted` and the SOLE Engine entry that
 *     interprets Agent-submitted signals. `applyRoutingAction` is
 *     invoked via the workflow signal's declared `action`.
 *   - Negative tests capture events.jsonl + state.json byte content
 *     before and after the call to assert zero mutation when the
 *     handler throws.
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
// WF-P9-ACCEPT Step 2: `acceptAgentReport` is exported from
// `src/engine/accept.ts`. Lazy import wrapper preserves backward-compatible
// error isolation across the red phase.
// ---------------------------------------------------------------------------

interface AcceptAgentReportOpts {
  runDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
}

// Indirect specifier prevents the TypeScript compiler from statically
// resolving the (Step-2) module path while the dynamic import still
// fails at runtime in Step 1. Once Step 2 ships
// `src/engine/accept.ts`, the dynamic import resolves and the tests
// flip from red to green.
const ACCEPT_MODULE_SPECIFIER = "../../src/engine/accept.js";

async function callAcceptAgentReport(opts: AcceptAgentReportOpts): Promise<void> {
  let mod: { acceptAgentReport?: (o: AcceptAgentReportOpts) => Promise<void> };
  try {
    // The `String(...)` indirection is a deliberate compile-time
    // opacity barrier — vitest/Node resolves it at runtime, tsc does
    // not type-check the module path.
    mod = (await import(/* @vite-ignore */ String(ACCEPT_MODULE_SPECIFIER))) as {
      acceptAgentReport?: (o: AcceptAgentReportOpts) => Promise<void>;
    };
  } catch (e: unknown) {
    throw new Error(
      `acceptAgentReport is not yet implemented — src/engine/accept.ts does not exist (WF-P9-ACCEPT Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.acceptAgentReport !== "function") {
    throw new Error(
      "acceptAgentReport is not exported from src/engine/accept.ts — WF-P9-ACCEPT Step 2 has not yet shipped the implementation."
    );
  }
  return mod.acceptAgentReport(opts);
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-11T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Single agent step in job `intake`. No top-level signals declared
 * (the signal array in the report is expected to be empty for the
 * no-signal happy path).
 */
const AGENT_NO_SIGNAL_YAML = `\
name: accept-no-signal
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: intake
        type: agent
        uses: zigma/intake-skill
`;

/**
 * Workflow with a top-level signal `needs_architecture_design`,
 * allowed only from `plan`, with action `activate_job:
 * architecture-design`. Used by T-ACCEPT-3, T-ACCEPT-5, T-ACCEPT-12.
 */
const AGENT_WITH_SIGNAL_YAML = `\
name: accept-with-signal
version: "0.1.0"
signals:
  needs_architecture_design:
    severity: medium
    priority: 50
    allowed_from:
      - plan
    action:
      activate_job: architecture-design
jobs:
  plan:
    steps:
      - id: plan
        type: agent
        uses: zigma/plan-skill
  architecture-design:
    activation: optional
    steps:
      - id: design
        type: agent
        uses: zigma/architecture-skill
`;

/**
 * Workflow declares only `signals.foo`; the test will submit a signal
 * of type `rogue` to trigger ValidationError. Used by T-ACCEPT-4.
 */
const AGENT_UNDECLARED_YAML = `\
name: accept-undeclared
version: "0.1.0"
signals:
  foo:
    priority: 10
    allowed_from:
      - plan
    action: continue
jobs:
  plan:
    steps:
      - id: plan
        type: agent
        uses: zigma/plan-skill
`;

/**
 * Workflow declares two signals (sigA priority 100, sigB priority 50),
 * both allowed from `plan`. Used by T-ACCEPT-10. sigA activates
 * `architecture-design`; sigB activates `cleanup` (also optional).
 */
const AGENT_MULTI_SIGNAL_YAML = `\
name: accept-multi-signal
version: "0.1.0"
signals:
  sigA:
    severity: high
    priority: 100
    allowed_from:
      - plan
    action:
      activate_job: architecture-design
  sigB:
    severity: low
    priority: 50
    allowed_from:
      - plan
    action:
      activate_job: cleanup
jobs:
  plan:
    steps:
      - id: plan
        type: agent
        uses: zigma/plan-skill
  architecture-design:
    activation: optional
    steps:
      - id: design
        type: agent
        uses: zigma/architecture-skill
  cleanup:
    activation: optional
    steps:
      - id: cleanup-step
        type: agent
        uses: zigma/cleanup-skill
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
  const projectRoot = join(tmpdir(), `zigma-accept-${randomUUID()}`);
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

async function readEventsBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "events.jsonl"), "utf-8");
}

async function readStateBytes(runDir: string): Promise<string> {
  return readFile(join(runDir, "state.json"), "utf-8");
}

interface JobStatePatch {
  status?: JobState["status"];
  attempt?: number;
  current_step?: string;
}

/**
 * Mutate `state.jobs[jobId]` via LocalStateStore. Mirrors the helper in
 * `tests/engine/signals.test.ts` but trimmed to the fields this slice
 * needs to pre-set.
 */
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

/**
 * Write a `report.json` artifact at the canonical location.
 *
 * The `body` argument is either a JSON-serializable object (in which
 * case it is `JSON.stringify`ed) or a raw string (used by T-ACCEPT-7
 * for the malformed-JSON case).
 */
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

/**
 * Helper to read `JobState.outputs` even though the field is not yet
 * declared on the public `JobState` type (Step 2 adds it).
 */
function readOutputs(snap: RunState, jobId: string): Record<string, unknown> | undefined {
  const js = snap.jobs[jobId] as unknown as { outputs?: Record<string, unknown> };
  return js?.outputs;
}

// ---------------------------------------------------------------------------
// T-ACCEPT-1: no-signal report — agent_report_accepted + advanceJob
// ---------------------------------------------------------------------------

describe("acceptAgentReport — no-signal report (T-ACCEPT-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits agent_report_accepted and delegates to advanceJob (T-ACCEPT-1, UC-ACCEPT-1, UC-ACCEPT-11, FP-ACCEPT-NO-SIGNAL-PATH)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { summary: "intake complete" },
        artifacts: [],
        signals: [],
        summary: "intake step done",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "intake",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const accepted = events.find((e) => e.type === "agent_report_accepted");
      expect(accepted).toBeDefined();

      const snap = await readStateSnapshot(runDir);
      // last_event_id MUST equal events.jsonl tail
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
      // Job advances: single-step job → completed; OR multi-step would
      // have advanced the pointer. Either way the snapshot reflects the
      // advanceJob delegation.
      const intake = snap.jobs["intake"]!;
      expect(["completed", "running"]).toContain(intake.status);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-2: outputs persist to JobState.outputs
// ---------------------------------------------------------------------------

describe("acceptAgentReport — outputs persistence (T-ACCEPT-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "writes report.outputs to state.jobs[jobId].outputs (T-ACCEPT-2, UC-ACCEPT-2, FP-ACCEPT-OUTPUTS-PERSIST)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      const outputs = { summary: "done", risks: ["x", "y"] };
      await writeReport(runDir, "intake", 1, "intake", {
        outputs,
        artifacts: [],
        signals: [],
        summary: "intake step done",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "intake",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const persisted = readOutputs(snap, "intake");
      expect(persisted).toBeDefined();
      expect(persisted).toEqual(outputs);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-3: valid signal — dispatches via applyRoutingAction
// ---------------------------------------------------------------------------

describe("acceptAgentReport — valid signal dispatch (T-ACCEPT-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "dispatches signal via applyRoutingAction (activate_job) — emits signal_received → job_activated; NO agent_report_accepted (T-ACCEPT-3, UC-ACCEPT-3, FP-ACCEPT-DISPATCH, FP-ACCEPT-SIGNAL-EMIT)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_WITH_SIGNAL_YAML,
        "accept-with-signal"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "plan",
        attempt: 1,
      });

      await writeReport(runDir, "plan", 1, "plan", {
        outputs: { plan: "proposed architecture" },
        artifacts: [],
        signals: [
          {
            type: "needs_architecture_design",
            reason: "module coupling uncertain",
          },
        ],
        summary: "plan complete",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      // signal_received emitted; payload signal slot carries workflow
      // signal NAME (not the action discriminator).
      const sigIdx = types.lastIndexOf("signal_received");
      const activatedIdx = types.lastIndexOf("job_activated");
      expect(sigIdx).toBeGreaterThanOrEqual(0);
      expect(activatedIdx).toBeGreaterThan(sigIdx);

      const sigEvent = events[sigIdx]!;
      expect(sigEvent.payload).toMatchObject({
        signal: "needs_architecture_design",
        from_job: "plan",
        from_step: "plan",
      });

      // Target job transitions to ready.
      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["architecture-design"]!.status).toBe("ready");

      // NO agent_report_accepted on the signal-dispatch path.
      expect(events.filter((e) => e.type === "agent_report_accepted")).toHaveLength(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-4: undeclared signal → ValidationError; no disk mutation
// ---------------------------------------------------------------------------

describe("acceptAgentReport — undeclared signal (T-ACCEPT-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ValidationError for undeclared signal; does not mutate disk (T-ACCEPT-4, UC-ACCEPT-4, FP-ACCEPT-SIGNAL-VALIDATE)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_UNDECLARED_YAML,
        "accept-undeclared"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "plan",
        attempt: 1,
      });

      await writeReport(runDir, "plan", 1, "plan", {
        outputs: {},
        artifacts: [],
        signals: [{ type: "rogue", reason: "agent went off-script" }],
        summary: "plan complete",
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "plan",
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
// T-ACCEPT-5: signal source not in allowed_from → WorkflowError; no
// disk mutation
// ---------------------------------------------------------------------------

describe("acceptAgentReport — disallowed source job (T-ACCEPT-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws WorkflowError when current jobId is not in signals.<type>.allowed_from; does not mutate disk (T-ACCEPT-5, UC-ACCEPT-5, FP-ACCEPT-SIGNAL-VALIDATE)",
    async () => {
      // Modify the YAML: the signal is allowed only from "plan" but
      // we will submit from a *different* job. To reuse
      // AGENT_WITH_SIGNAL_YAML, we add a job `intake` (not allowed)
      // and submit from there.
      const yaml = `\
name: accept-with-signal-disallowed
version: "0.1.0"
signals:
  needs_architecture_design:
    priority: 50
    allowed_from:
      - plan
    action:
      activate_job: architecture-design
jobs:
  intake:
    steps:
      - id: intake
        type: agent
        uses: zigma/intake-skill
  plan:
    needs:
      - intake
    steps:
      - id: plan
        type: agent
        uses: zigma/plan-skill
  architecture-design:
    activation: optional
    steps:
      - id: design
        type: agent
        uses: zigma/architecture-skill
`;
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        yaml,
        "accept-with-signal-disallowed"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      await writeReport(runDir, "intake", 1, "intake", {
        outputs: {},
        artifacts: [],
        signals: [
          {
            type: "needs_architecture_design",
            reason: "intake noticed coupling",
          },
        ],
        summary: "intake complete",
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "WorkflowError" });

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-6: report.json missing → FilesystemError; no disk mutation
// ---------------------------------------------------------------------------

describe("acceptAgentReport — missing report.json (T-ACCEPT-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws FilesystemError when report.json is missing; does not mutate disk (T-ACCEPT-6, UC-ACCEPT-6, FP-ACCEPT-REPORT-MISSING)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      // NOTE: deliberately do NOT write report.json.

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
          clock: new FakeClock(),
        })
      ).rejects.toMatchObject({ kind: "FilesystemError" });

      const eventsAfter = await readEventsBytes(runDir);
      const stateAfter = await readStateBytes(runDir);
      expect(eventsAfter).toBe(eventsBefore);
      expect(stateAfter).toBe(stateBefore);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-7: report.json malformed JSON → ValidationError; no disk
// mutation
// ---------------------------------------------------------------------------

describe("acceptAgentReport — malformed JSON (T-ACCEPT-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ValidationError when report.json contains malformed JSON; does not mutate disk (T-ACCEPT-7, UC-ACCEPT-7, FP-ACCEPT-REPORT-PARSE)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      await writeReport(runDir, "intake", 1, "intake", "{ not json", {
        raw: true,
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
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
// T-ACCEPT-8: report.json missing outputs field → ValidationError; no
// disk mutation
// ---------------------------------------------------------------------------

describe("acceptAgentReport — missing outputs field (T-ACCEPT-8)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ValidationError when report.json lacks outputs; does not mutate disk (T-ACCEPT-8, UC-ACCEPT-8, FP-ACCEPT-SCHEMA-GUARD)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      // Outputs key intentionally absent.
      await writeReport(runDir, "intake", 1, "intake", {
        artifacts: [],
        signals: [],
        summary: "",
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
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
// T-ACCEPT-9: report.json missing signals field → ValidationError; no
// disk mutation
// ---------------------------------------------------------------------------

describe("acceptAgentReport — missing signals field (T-ACCEPT-9)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws ValidationError when report.json lacks signals; does not mutate disk (T-ACCEPT-9, UC-ACCEPT-9, FP-ACCEPT-SCHEMA-GUARD)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      // signals key intentionally absent.
      await writeReport(runDir, "intake", 1, "intake", {
        outputs: {},
        artifacts: [],
        summary: "",
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
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
// T-ACCEPT-10: multiple valid signals — only highest-priority dispatched
// ---------------------------------------------------------------------------

describe("acceptAgentReport — priority selection (T-ACCEPT-10)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "selects highest-priority signal; only that signal's action is dispatched (T-ACCEPT-10, UC-ACCEPT-10, FP-ACCEPT-PRIORITY-SELECT)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_MULTI_SIGNAL_YAML,
        "accept-multi-signal"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "plan",
        attempt: 1,
      });

      await writeReport(runDir, "plan", 1, "plan", {
        outputs: {},
        artifacts: [],
        signals: [
          { type: "sigB", reason: "lower priority" },
          { type: "sigA", reason: "higher priority" },
        ],
        summary: "plan complete",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const sigReceived = events.filter((e) => e.type === "signal_received");
      // Exactly ONE signal_received for the selected (priority-100) signal.
      expect(sigReceived).toHaveLength(1);
      expect(sigReceived[0]!.payload).toMatchObject({ signal: "sigA" });

      const snap = await readStateSnapshot(runDir);
      // architecture-design (sigA's target) becomes ready;
      // cleanup (sigB's target) stays inactive.
      expect(snap.jobs["architecture-design"]!.status).toBe("ready");
      expect(snap.jobs["cleanup"]!.status).toBe("inactive");
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-11: agent_report_accepted payload has correct fields
// ---------------------------------------------------------------------------

describe("acceptAgentReport — agent_report_accepted event fields (T-ACCEPT-11)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "agent_report_accepted carries job_id / step_id / report_artifact plus envelope fields (T-ACCEPT-11, UC-ACCEPT-11, FP-ACCEPT-EVENT-EMIT)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { foo: "bar" },
        artifacts: [],
        signals: [],
        summary: "intake done",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "intake",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const accepted = events.find((e) => e.type === "agent_report_accepted");
      expect(accepted).toBeDefined();

      // Envelope fields
      expect(accepted!.run_id).toBe(runId);
      expect(accepted!.job).toBe("intake");
      expect(accepted!.step).toBe("intake");
      expect(accepted!.attempt).toBe(1);

      // Payload fields per AgentReportAcceptedPayload
      expect(accepted!.payload).toMatchObject({
        job_id: "intake",
        step_id: "intake",
      });
      // report_artifact is the run-relative path to report.json
      const reportArtifact = (accepted!.payload as Record<string, unknown>)[
        "report_artifact"
      ];
      expect(typeof reportArtifact).toBe("string");
      expect(reportArtifact as string).toContain("jobs/intake/attempts/1/steps/intake/report.json");
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-12: signal with no reason — accepted; dispatched with
// synthesized reason
// ---------------------------------------------------------------------------

describe("acceptAgentReport — signal without reason (T-ACCEPT-12)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "accepts signal with no reason; dispatches with synthesized reason (T-ACCEPT-12, UC-ACCEPT-12, FP-ACCEPT-SIGNAL-VALIDATE, FP-ACCEPT-DISPATCH)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_WITH_SIGNAL_YAML,
        "accept-with-signal"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "plan",
        attempt: 1,
      });

      await writeReport(runDir, "plan", 1, "plan", {
        outputs: {},
        artifacts: [],
        // type only, no reason.
        signals: [{ type: "needs_architecture_design" }],
        summary: "plan complete",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);
      expect(types).toContain("signal_received");
      expect(types).toContain("job_activated");

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["architecture-design"]!.status).toBe("ready");
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-13: signal path — outputs persist to JobState.outputs
// ---------------------------------------------------------------------------

describe("acceptAgentReport — signal path outputs persistence (T-ACCEPT-13)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "writes report.outputs to state.jobs[jobId].outputs even when a signal is dispatched (T-ACCEPT-13, UC-ACCEPT-2, FP-ACCEPT-OUTPUTS-PERSIST)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_WITH_SIGNAL_YAML,
        "accept-with-signal"
      );

      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "plan",
        attempt: 1,
      });

      const outputs = { plan: "proposed architecture", confidence: 0.9 };
      await writeReport(runDir, "plan", 1, "plan", {
        outputs,
        artifacts: [],
        signals: [
          {
            type: "needs_architecture_design",
            reason: "module coupling uncertain",
          },
        ],
        summary: "plan complete",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const persisted = readOutputs(snap, "plan");
      expect(persisted).toBeDefined();
      expect(persisted).toEqual(outputs);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-16: typed output normalization — array type coercion
// ---------------------------------------------------------------------------
//
// When a step definition declares `outputs.<key>.type: "array"` and the
// agent submits a JSON-array string, acceptAgentReport must coerce the
// string to an actual array before persisting to JobState.outputs.
//
// Also covers the newline-split fallback when the string is not valid JSON.
// ---------------------------------------------------------------------------

/**
 * Workflow with a step that declares one output as type: array.
 */
const AGENT_ARRAY_OUTPUT_YAML = `\
name: accept-array-output
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: intake
        type: agent
        uses: zigma/intake-skill
        outputs:
          risks:
            type: array
          summary:
            type: string
`;

describe("acceptAgentReport — typed output normalization (T-ACCEPT-16)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "coerces JSON-array string output to array when step declares type: array (T-ACCEPT-16a, FP-TYPED-OUTPUT-ARRAY-JSON)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_ARRAY_OUTPUT_YAML,
        "accept-array-output"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { risks: '["dep-a","dep-b"]', summary: "all done" },
        artifacts: [],
        signals: [],
        summary: "intake done",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "intake",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const outputs = readOutputs(snap, "intake");
      expect(outputs).toBeDefined();
      // risks should be coerced to an array, not kept as string
      expect(Array.isArray(outputs!["risks"])).toBe(true);
      expect(outputs!["risks"]).toEqual(["dep-a", "dep-b"]);
      // summary is type: string — no coercion
      expect(outputs!["summary"]).toBe("all done");
    }
  );

  it(
    "splits newline-delimited string when JSON parse fails for type: array output (T-ACCEPT-16b, FP-TYPED-OUTPUT-ARRAY-NEWLINE)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_ARRAY_OUTPUT_YAML,
        "accept-array-output"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { risks: "dep-a\ndep-b\ndep-c", summary: "done" },
        artifacts: [],
        signals: [],
        summary: "intake done",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "intake",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const outputs = readOutputs(snap, "intake");
      expect(outputs).toBeDefined();
      expect(Array.isArray(outputs!["risks"])).toBe(true);
      expect(outputs!["risks"]).toEqual(["dep-a", "dep-b", "dep-c"]);
    }
  );

  it(
    "does not coerce outputs when no type declaration is present (T-ACCEPT-16c, FP-TYPED-OUTPUT-NO-DECL)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { summary: '["a","b"]' },
        artifacts: [],
        signals: [],
        summary: "intake done",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "intake",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      const outputs = readOutputs(snap, "intake");
      expect(outputs).toBeDefined();
      // No type declaration — string should remain a string
      expect(outputs!["summary"]).toBe('["a","b"]');
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-14: signal path retry_job — source job advances to completed
// ---------------------------------------------------------------------------
//
// WF-P10-ENGINE-FIX (TD-P10-ACCEPT-ADVANCE):
// After `applyRoutingAction` dispatches a `retry_job` action, the SOURCE job
// (the job that submitted the report) is left in "running" by P9.
// `acceptAgentReport` MUST call `advanceJob(sourceJobId)` to advance the
// source job to "completed" (single-step agent job → terminal advanceJob
// path). The fix lives entirely in `src/engine/accept.ts`.
//
// Red-phase note: BEFORE the fix is applied, this test fails on the
// assertion `state.jobs["review"].status === "completed"` because P9's
// signal-path return-after-dispatch leaves review in "running".
// ---------------------------------------------------------------------------

/**
 * Workflow: `implement` (1 agent step, retry: max_attempts: 3) +
 * `review` (1 agent step, needs: [implement]).
 * Signal: `review_rejected` allowed_from [review], action retry_job: implement.
 */
const AGENT_REVIEW_RETRY_YAML = `\
name: accept-review-retry
version: "0.1.0"
signals:
  review_rejected:
    severity: medium
    priority: 50
    allowed_from:
      - review
    action:
      retry_job: implement
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: implement-step
        type: agent
        uses: zigma/implement-skill
  review:
    needs:
      - implement
    steps:
      - id: review-step
        type: agent
        uses: zigma/review-skill
`;

describe("acceptAgentReport — signal path retry_job advances source job (T-ACCEPT-14)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "after retry_job signal dispatch, source job (review) transitions running → completed; target job (implement) transitions to ready with incremented attempt; events ordered signal_received → job_retrying → job_completed (T-ACCEPT-14, UC-ACCEPT-14, FP-ENGFIX-RETRY-ADV, FP-ENGFIX-NO-REGRESSION)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_REVIEW_RETRY_YAML,
        "accept-review-retry"
      );

      // Set up: implement is completed (attempt 1), review is running on
      // its single agent step (attempt 1). retry_job will reset implement
      // to ready/attempt-2 while review must advance to completed.
      await setJobState(runDir, "implement", {
        status: "completed",
        attempt: 1,
      });
      await setJobState(runDir, "review", {
        status: "running",
        current_step: "review-step",
        attempt: 1,
      });

      await writeReport(runDir, "review", 1, "review-step", {
        outputs: { decision: "rejected" },
        artifacts: [],
        signals: [
          {
            type: "review_rejected",
            reason: "tests are insufficient",
          },
        ],
        summary: "review complete — rejected",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "review",
        clock: new FakeClock(),
      });

      // ── Source job (review) must be completed (THIS IS THE RED ASSERT). ──
      const snap = await readStateSnapshot(runDir);
      const review = snap.jobs["review"]!;
      expect(review.status).toBe("completed");

      // ── Target job (implement) must be ready, attempt incremented. ──
      const implement = snap.jobs["implement"]!;
      expect(implement.status).toBe("ready");
      expect(implement.attempt).toBe(2);

      // ── Events: signal_received → job_retrying → job_completed (review). ──
      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      const sigIdx = types.lastIndexOf("signal_received");
      const retryIdx = types.lastIndexOf("job_retrying");
      const completedIdx = types.lastIndexOf("job_completed");

      expect(sigIdx).toBeGreaterThanOrEqual(0);
      expect(retryIdx).toBeGreaterThan(sigIdx);
      expect(completedIdx).toBeGreaterThan(retryIdx);

      // signal_received carries the workflow signal name (not action discriminator).
      expect(events[sigIdx]!.payload).toMatchObject({
        signal: "review_rejected",
        from_job: "review",
        from_step: "review-step",
      });

      // job_completed must target the source (review), not implement.
      expect(events[completedIdx]!.job).toBe("review");

      // last_event_id must point to the events.jsonl tail.
      // (After dependency propagation, the tail may be job_completed rather than
      // job_retrying, since implement is already "ready" and not "waiting".)
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);

      // NO agent_report_accepted on the signal-dispatch path.
      expect(events.filter((e) => e.type === "agent_report_accepted")).toHaveLength(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-15: signal path activate_job — source job advances to completed
// ---------------------------------------------------------------------------
//
// WF-P10-ENGINE-FIX (TD-P10-ACCEPT-ADVANCE):
// Same source-job advancement contract as T-ACCEPT-14, but for the
// `activate_job` action: after `applyRoutingAction` activates the optional
// target job, `acceptAgentReport` MUST advance the source job to
// "completed". The fix lives entirely in `src/engine/accept.ts`.
//
// Red-phase note: BEFORE the fix is applied, this test fails on the
// assertion `state.jobs["plan"].status === "completed"` because P9's
// signal-path return-after-dispatch leaves plan in "running".
// ---------------------------------------------------------------------------

/**
 * Workflow: `plan` (1 agent step) + `architecture-design`
 * (1 agent step, activation: "manual", needs: [plan]).
 * Signal: `needs_architecture_design` allowed_from [plan],
 *   action activate_job: architecture-design.
 */
const AGENT_PLAN_ACTIVATE_YAML = `\
name: accept-plan-activate
version: "0.1.0"
signals:
  needs_architecture_design:
    severity: medium
    priority: 50
    allowed_from:
      - plan
    action:
      activate_job: architecture-design
jobs:
  plan:
    steps:
      - id: plan-step
        type: agent
        uses: zigma/plan-skill
  architecture-design:
    activation: manual
    needs:
      - plan
    steps:
      - id: design-step
        type: agent
        uses: zigma/architecture-skill
`;

// ---------------------------------------------------------------------------
// T-ACCEPT-16: artifact index contains report.json entry after acceptAgentReport
// ---------------------------------------------------------------------------

describe("acceptAgentReport — artifact index registration (T-ACCEPT-16)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "artifacts.jsonl contains an entry for report.json after acceptAgentReport on the no-signal path (T-ACCEPT-16)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_NO_SIGNAL_YAML,
        "accept-no-signal"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { result: "done" },
        artifacts: [],
        signals: [],
        summary: "intake complete",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "intake",
        clock: new FakeClock(),
      });

      // Read artifacts.jsonl
      const artifactsText = await readFile(join(runDir, "artifacts.jsonl"), "utf-8");
      const entries = artifactsText
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      // Must have at least one entry for report.json
      const reportEntry = entries.find(
        (e) => typeof e["path"] === "string" && (e["path"] as string).endsWith("report.json")
      );
      expect(reportEntry).toBeDefined();
      expect(reportEntry!["kind"]).toBe("agent_report");
      expect(reportEntry!["run_id"]).toBe(runId);
      expect(reportEntry!["content_type"]).toBe("application/json");
      const producer = reportEntry!["producer"] as Record<string, unknown>;
      expect(producer["job"]).toBe("intake");
      expect(producer["step"]).toBe("intake");
      expect(producer["attempt"]).toBe(1);
    }
  );
});

describe("acceptAgentReport — signal path activate_job advances source job (T-ACCEPT-15)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "after activate_job signal dispatch, source job (plan) transitions running → completed; target job (architecture-design) is ready or waiting per DAG; events ordered signal_received → job_activated → job_completed (T-ACCEPT-15, UC-ACCEPT-15, FP-ENGFIX-ACTIVATE-ADV, FP-ENGFIX-NO-REGRESSION)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_PLAN_ACTIVATE_YAML,
        "accept-plan-activate"
      );

      // Set up: plan is running on its single agent step (attempt 1).
      // architecture-design is inactive (set by createRun via activation
      // declaration; verified below). activate_job will flip architecture-design
      // to ready/waiting while plan must advance to completed.
      await setJobState(runDir, "plan", {
        status: "running",
        current_step: "plan-step",
        attempt: 1,
      });

      // Sanity check: bootstrapping placed architecture-design at "inactive"
      // because of the activation declaration.
      const initialSnap = await readStateSnapshot(runDir);
      expect(initialSnap.jobs["architecture-design"]!.status).toBe("inactive");

      await writeReport(runDir, "plan", 1, "plan-step", {
        outputs: { suggested_design: "module-split" },
        artifacts: [],
        signals: [
          {
            type: "needs_architecture_design",
            reason: "module coupling uncertain",
          },
        ],
        summary: "plan complete",
      });

      await callAcceptAgentReport({
        runDir,
        runId,
        jobId: "plan",
        clock: new FakeClock(),
      });

      // ── Source job (plan) must be completed (THIS IS THE RED ASSERT). ──
      const snap = await readStateSnapshot(runDir);
      const plan = snap.jobs["plan"]!;
      expect(plan.status).toBe("completed");

      // ── Target job (architecture-design) becomes ready (preferred) or
      //    waiting (DAG order-sensitive fallback). ──────────────────────────
      const archDesign = snap.jobs["architecture-design"]!;
      expect(["ready", "waiting"]).toContain(archDesign.status);
      expect(archDesign.activated).toBe(true);

      // ── Events: signal_received → job_activated → job_completed (plan). ──
      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);

      const sigIdx = types.lastIndexOf("signal_received");
      const activatedIdx = types.lastIndexOf("job_activated");
      const completedIdx = types.lastIndexOf("job_completed");

      expect(sigIdx).toBeGreaterThanOrEqual(0);
      expect(activatedIdx).toBeGreaterThan(sigIdx);
      expect(completedIdx).toBeGreaterThan(activatedIdx);

      // signal_received carries the workflow signal name (not action discriminator).
      expect(events[sigIdx]!.payload).toMatchObject({
        signal: "needs_architecture_design",
        from_job: "plan",
        from_step: "plan-step",
      });

      // job_completed must target the source (plan).
      expect(events[completedIdx]!.job).toBe("plan");

      // last_event_id must point to the events.jsonl tail. After dependency
      // propagation, architecture-design's needs are satisfied once plan
      // completes, so a job_ready event follows job_completed.
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
      expect(archDesign.status).toBe("ready");

      // NO agent_report_accepted on the signal-dispatch path.
      expect(events.filter((e) => e.type === "agent_report_accepted")).toHaveLength(0);
    }
  );
});

// ---------------------------------------------------------------------------
// T-ACCEPT-17: required_artifacts policy — exact matching
// ---------------------------------------------------------------------------

/**
 * Workflow with a step that declares required_artifacts: ["summary.md"].
 */
const AGENT_REQUIRED_ARTIFACT_YAML = `\
name: accept-required-artifact
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: intake
        type: agent
        uses: zigma/intake-skill
        required_artifacts:
          - summary.md
`;

describe("acceptAgentReport — required_artifacts policy (T-ACCEPT-17)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "REJECTS report when required artifact is missing (FP-REQUIRED-ARTIFACT-MISSING)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_REQUIRED_ARTIFACT_YAML,
        "accept-required-artifact"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      // Report has no artifacts at all — missing required "summary.md"
      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { summary: "done" },
        artifacts: [],
        signals: [],
        summary: "intake done",
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
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

  it(
    "REJECTS substring false-positive match (FP-REQUIRED-ARTIFACT-SUBSTRING)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_REQUIRED_ARTIFACT_YAML,
        "accept-required-artifact"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      // Report has "not-summary.md" — "summary.md" is NOT a substring of
      // "not-summary.md", but a naive includes("summary.md") would match
      // "document-summary.md". This test confirms the match is exact
      // (no false-positive on "document-summary.md" either).
      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { summary: "done" },
        artifacts: ["not-summary.md"],
        signals: [],
        summary: "intake done",
      });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
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

  it(
    "ACCEPTS exact artifact ref match when required artifact is present (FP-REQUIRED-ARTIFACT-EXACT)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_REQUIRED_ARTIFACT_YAML,
        "accept-required-artifact"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      // Report has exactly "summary.md" — should pass
      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { summary: "done" },
        artifacts: ["summary.md"],
        signals: [],
        summary: "intake done",
      });

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
          clock: new FakeClock(),
        })
      ).resolves.toBeUndefined();
    }
  );

  it(
    "ACCEPTS path-segment match when artifact ref ends with /required (FP-REQUIRED-ARTIFACT-PATH)",
    async () => {
      const { runId, runDir } = await bootstrapAcceptRun(
        sandbox,
        AGENT_REQUIRED_ARTIFACT_YAML,
        "accept-required-artifact"
      );

      await setJobState(runDir, "intake", {
        status: "running",
        current_step: "intake",
        attempt: 1,
      });

      // Report has "jobs/intake/attempts/1/steps/intake/summary.md" — should match
      // via endsWith("/summary.md")
      await writeReport(runDir, "intake", 1, "intake", {
        outputs: { summary: "done" },
        artifacts: ["jobs/intake/attempts/1/steps/intake/summary.md"],
        signals: [],
        summary: "intake done",
      });

      await expect(
        callAcceptAgentReport({
          runDir,
          runId,
          jobId: "intake",
          clock: new FakeClock(),
        })
      ).resolves.toBeUndefined();
    }
  );
});
