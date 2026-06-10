/**
 * `applyRoutingAction` tests for WF-P8-SIGNALS (Step 1 — Cases and Tests).
 *
 * These tests exercise the Engine's signal-handler entry point that maps
 * a `RouterAction` (sourced from a router step's `cases`, a script
 * step's `on_failure`, or a check step's `on_fail` / `on_pass`) into
 * the corresponding job-status transition plus event emissions.
 *
 * Covers:
 *   - T-SIGNALS-1:  continue action — emits signal_received and
 *                   delegates to advanceJob (pointer s1 → s2).
 *   - T-SIGNALS-2:  fail action — emits signal_received and sets
 *                   status = "failed".
 *   - T-SIGNALS-3:  block action — emits signal_received and sets
 *                   status = "blocked".
 *   - T-SIGNALS-4:  retry_job action — emits signal_received →
 *                   job_retrying; resets current_step; increments
 *                   attempt counter.
 *   - T-SIGNALS-5:  activate_job action — emits signal_received →
 *                   job_activated; optional job transitions inactive
 *                   → ready.
 *   - T-SIGNALS-6:  goto_job action — emits signal_received →
 *                   job_skipped; source job → completed; target job →
 *                   ready.
 *   - T-SIGNALS-7:  multiple sequential retries — attempt counter
 *                   monotonically increments through three calls;
 *                   third call hits max_attempts guard.
 *   - T-SIGNALS-8:  retry beyond max_attempts — emits signal_received
 *                   only; sets status = "blocked"; leaves attempt
 *                   unchanged.
 *   - T-SIGNALS-9:  integration — script step on_failure: retry_job
 *                   drives the full retry cycle via the script
 *                   executor.
 *   - T-SIGNALS-10: negative — applyRoutingAction throws WorkflowError
 *                   when source job is in a terminal state and action
 *                   is not a valid retry path.
 *   - T-SIGNALS-11: negative — activate_job on a required job (no
 *                   `activation` field) throws WorkflowError.
 *   - T-SIGNALS-12: negative — unknown target job throws WorkflowError.
 *   - T-SIGNALS-13: integration — check step on_fail: { retry_job }
 *                   drives the full retry cycle via the check
 *                   executor.
 *
 * Reference:
 *   - docs/phases/p8-router-and-signals/workflows/wf-p8-signals/01-cases-and-tests.md
 *   - docs/architecture.md §7.1, §7.2, §7.3
 *   - docs/mvp-contracts.md §2.1, §2.3, §2.4, §2.7, §6
 *   - docs/prd.md §FR-009, §FR-011, §FR-012
 *
 * Red-phase note: `src/engine/index.ts` does not yet export
 * `applyRoutingAction`. The lazy import wrapper below throws a
 * descriptive Error so the test file compiles and every test in this
 * file fails for the same diagnostic reason until WF-P8-SIGNALS Step 2
 * ships the implementation. Step 2 also extends `JobState` with
 * `activated` / `activation_reason` / `retry_reason` fields and
 * adds `job_activated` / `job_skipped` to the event union; the test
 * file therefore reads those properties via `any` casts to avoid a
 * Step-1 dependency on the new types.
 *
 * Test design notes:
 *   - All snapshot writes are observed via real filesystem reads —
 *     no mocking. Real temp directories under `os.tmpdir()`.
 *   - The handler is contracted to be the SOLE place that emits
 *     `signal_received`, `job_retrying`, `job_activated`,
 *     `job_skipped`. The P6 script executor (`on_failure` object
 *     form) and P7 check executor (`on_fail` / `on_pass` object
 *     form) delegate to it after emitting their own step-level
 *     events.
 *   - Negative tests capture events.jsonl + state.json byte content
 *     before and after the call to assert zero mutation when the
 *     handler throws.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createRun, executeCurrentStep } from "../../src/engine/index.js";
import type { Clock, JobState, RunState } from "../../src/run/index.js";
import { LocalStateStore } from "../../src/run/index.js";
import type { RouterAction } from "../../src/workflow/index.js";

// ---------------------------------------------------------------------------
// WF-P8-SIGNALS Step 2: `applyRoutingAction` is exported from engine.
// Lazy import wrapper preserves backward-compatible error isolation.
// ---------------------------------------------------------------------------

interface ApplyRoutingActionOpts {
  runDir: string;
  runId: string;
  sourceJobId: string;
  sourceStepId: string;
  attempt: number;
  action: RouterAction;
  reason: string;
  clock: Clock;
}

async function callApplyRoutingAction(opts: ApplyRoutingActionOpts): Promise<void> {
  const mod = (await import("../../src/engine/index.js")) as unknown as {
    applyRoutingAction?: (o: ApplyRoutingActionOpts) => Promise<void>;
  };
  if (typeof mod.applyRoutingAction !== "function") {
    throw new Error(
      "applyRoutingAction is not exported from src/engine/index.ts — WF-P8-SIGNALS Step 2 has not yet shipped the implementation."
    );
  }
  return mod.applyRoutingAction(opts);
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const FIXED_ISO = "2026-06-10T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly iso: string = FIXED_ISO) {}
  now(): string {
    return this.iso;
  }
}

/**
 * Two-step job used for the literal action (continue / fail / block /
 * illegal-source) direct tests. Pure script steps; the tests do NOT
 * actually run the scripts — they pre-set state via setJobState and
 * invoke `applyRoutingAction` in isolation.
 */
const MULTI_STEP_YAML = `\
name: signals-multi
version: "0.1.0"
jobs:
  build:
    steps:
      - id: s1
        type: script
        run: "echo s1"
      - id: s2
        type: script
        run: "echo s2"
`;

/**
 * Retry workflow used by T-SIGNALS-4, T-SIGNALS-7, T-SIGNALS-8,
 * T-SIGNALS-13. `implement` is retryable with `max_attempts: 3`.
 */
const RETRY_YAML = `\
name: signals-retry
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: code
        type: script
        run: "echo implement"
      - id: static-check
        type: check
        uses: zigma/file-exists
        with:
          file: "no-such-file.txt"
        on_fail:
          retry_job: implement
`;

/**
 * Optional-job workflow used by T-SIGNALS-5, T-SIGNALS-11.
 * `architecture-design` is `activation: optional`.
 */
const OPTIONAL_YAML = `\
name: signals-optional
version: "0.1.0"
jobs:
  architecture-design:
    activation: optional
    steps:
      - id: design
        type: script
        run: "echo design"
  review:
    steps:
      - id: route
        type: script
        run: "echo route"
`;

/**
 * Goto workflow used by T-SIGNALS-6. `cleanup` depends on `review`.
 */
const GOTO_YAML = `\
name: signals-goto
version: "0.1.0"
jobs:
  review:
    steps:
      - id: route
        type: script
        run: "echo route"
  cleanup:
    needs:
      - review
    steps:
      - id: cleanup-step
        type: script
        run: "echo cleanup"
`;

/**
 * Script-retry workflow used by T-SIGNALS-9 — script step exits 1 with
 * `on_failure: { retry_job: implement }`.
 */
const SCRIPT_RETRY_YAML = `\
name: signals-script-retry
version: "0.1.0"
jobs:
  implement:
    retry:
      max_attempts: 3
    steps:
      - id: code
        type: script
        run: "exit 1"
        on_failure:
          retry_job: implement
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
  const projectRoot = join(tmpdir(), `zigma-signals-${randomUUID()}`);
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

async function bootstrapSignalsRun(
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

async function readEvents(runDir: string): Promise<
  Array<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
  }>
> {
  const text = await readFile(join(runDir, "events.jsonl"), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(
      (l) =>
        JSON.parse(l) as {
          id: string;
          type: string;
          payload: Record<string, unknown>;
        }
    );
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

/**
 * Sentinel passed as `current_step` in `setJobState` patches to mean
 * "delete current_step from the snapshot".
 */
const CLEAR_CURRENT_STEP = Symbol("clear-current-step");

interface JobStatePatch {
  status?: JobState["status"];
  activation?: string;
  attempt?: number;
  current_step?: string | typeof CLEAR_CURRENT_STEP;
}

/**
 * Mutate `state.jobs[jobId]` via LocalStateStore.
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
  if (patch.activation !== undefined) merged.activation = patch.activation;
  if (patch.attempt !== undefined) merged.attempt = patch.attempt;
  if (patch.current_step === CLEAR_CURRENT_STEP) {
    delete merged.current_step;
  } else if (typeof patch.current_step === "string") {
    merged.current_step = patch.current_step;
  }

  snap.jobs[jobId] = merged;
  await store.writeSnapshot(runDir, snap);
}

// ---------------------------------------------------------------------------
// T-SIGNALS-1: continue action — signal_received + delegate to advanceJob
// ---------------------------------------------------------------------------

describe("applyRoutingAction — continue action (T-SIGNALS-1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits signal_received and advances the step pointer via advanceJob (T-SIGNALS-1, UC-SIGNALS-1, FP-SIG-TRANSITION-CONTINUE)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        MULTI_STEP_YAML,
        "signals-multi"
      );

      // Simulate: step s1 just completed; job is "running".
      await setJobState(runDir, "build", { status: "running", current_step: "s1" });

      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "build",
        sourceStepId: "s1",
        attempt: 1,
        action: "continue",
        reason: "step s1 completed; on_pass: continue",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const signalReceived = events.find((e) => e.type === "signal_received");
      expect(signalReceived).toBeDefined();
      expect(signalReceived!.payload).toMatchObject({
        signal: "continue",
        from_job: "build",
        from_step: "s1",
      });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["build"]!.current_step).toBe("s2");
      expect(snap.jobs["build"]!.status).toBe("running");

      // No job_completed expected — still mid-way.
      expect(events.filter((e) => e.type === "job_completed")).toHaveLength(0);

      // last_event_id must be the TAIL of events.jsonl (not pre-signal_received)
      const finalEvents = await readEvents(runDir);
      expect(snap.last_event_id).toBe(finalEvents[finalEvents.length - 1]!.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-2: fail action — signal_received + status = "failed"
// ---------------------------------------------------------------------------

describe("applyRoutingAction — fail action (T-SIGNALS-2)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits signal_received and sets job status to failed (T-SIGNALS-2, UC-SIGNALS-2, FP-SIG-TRANSITION-FAIL)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        MULTI_STEP_YAML,
        "signals-multi"
      );

      await setJobState(runDir, "build", { status: "running", current_step: "s1" });

      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "build",
        sourceStepId: "s1",
        attempt: 1,
        action: "fail",
        reason: "router decided: fail",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const signalReceived = events.find((e) => e.type === "signal_received");
      expect(signalReceived).toBeDefined();
      expect(signalReceived!.payload).toMatchObject({ signal: "fail" });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["build"]!.status).toBe("failed");
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-3: block action — signal_received + status = "blocked"
// ---------------------------------------------------------------------------

describe("applyRoutingAction — block action (T-SIGNALS-3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits signal_received and sets job status to blocked (T-SIGNALS-3, UC-SIGNALS-3, FP-SIG-TRANSITION-BLOCK)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        MULTI_STEP_YAML,
        "signals-multi"
      );

      await setJobState(runDir, "build", { status: "running", current_step: "s1" });

      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "build",
        sourceStepId: "s1",
        attempt: 1,
        action: "block",
        reason: "router decided: block",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const signalReceived = events.find((e) => e.type === "signal_received");
      expect(signalReceived).toBeDefined();
      expect(signalReceived!.payload).toMatchObject({ signal: "block" });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["build"]!.status).toBe("blocked");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-4: retry_job — signal_received + job_retrying; pointer reset;
//              attempt counter incremented
// ---------------------------------------------------------------------------

describe("applyRoutingAction — retry_job action (T-SIGNALS-4)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits signal_received → job_retrying; sets status=ready; clears current_step; increments attempt (T-SIGNALS-4, UC-SIGNALS-4, FP-SIG-TRANSITION-RETRY, FP-SIG-RETRY-ATTEMPT-INCREMENT)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        RETRY_YAML,
        "signals-retry"
      );

      // Simulate: implement.static-check just failed; attempt was 1.
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "static-check",
        attempt: 1,
      });

      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "static-check",
        attempt: 1,
        action: { retry_job: "implement" },
        reason: "check failed: forbidden-paths",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const signalIdx = events.findIndex((e) => e.type === "signal_received");
      const retryIdx = events.findIndex((e) => e.type === "job_retrying");
      expect(signalIdx).toBeGreaterThanOrEqual(0);
      expect(retryIdx).toBeGreaterThan(signalIdx);

      const retryEvent = events[retryIdx]!;
      expect(retryEvent.payload).toMatchObject({
        job_id: "implement",
        attempt: 2,
        reason: "check failed: forbidden-paths",
      });

      const snap = await readStateSnapshot(runDir);
      const implement = snap.jobs["implement"]!;
      expect(implement.status).toBe("ready");
      expect(implement.current_step).toBeUndefined();
      expect(implement.attempt).toBe(2);
      expect((implement as unknown as { retry_reason?: string }).retry_reason).toBe(
        "check failed: forbidden-paths"
      );
      expect(snap.last_event_id).toBe(events[events.length - 1]!.id);
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-5: activate_job — signal_received + job_activated;
//              optional job transitions inactive → ready
// ---------------------------------------------------------------------------

describe("applyRoutingAction — activate_job action (T-SIGNALS-5)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits signal_received → job_activated and transitions optional job inactive → ready (T-SIGNALS-5, UC-SIGNALS-5, FP-SIG-TRANSITION-ACTIVATE, FP-SIG-EVENT-ACTIVATED)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        OPTIONAL_YAML,
        "signals-optional"
      );

      // architecture-design starts inactive (activation: optional).
      const snap0 = await readStateSnapshot(runDir);
      expect(snap0.jobs["architecture-design"]!.status).toBe("inactive");

      // review job is the source; pretend its router step decided to activate.
      await setJobState(runDir, "review", { status: "running", current_step: "route" });

      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "route",
        attempt: 1,
        action: { activate_job: "architecture-design" },
        reason: "router decided: activate_job (case: needs_architecture_design)",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const signalIdx = events.findIndex((e) => e.type === "signal_received");
      const activatedIdx = events.findIndex((e) => e.type === "job_activated");
      expect(signalIdx).toBeGreaterThanOrEqual(0);
      expect(activatedIdx).toBeGreaterThan(signalIdx);

      const activatedEvent = events[activatedIdx]!;
      expect(activatedEvent.payload).toMatchObject({
        job_id: "architecture-design",
        reason: "router decided: activate_job (case: needs_architecture_design)",
      });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["architecture-design"]!.status).toBe("ready");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-6: goto_job — signal_received + job_skipped;
//              source job → completed; target job → ready
// ---------------------------------------------------------------------------

describe("applyRoutingAction — goto_job action (T-SIGNALS-6)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits signal_received → job_skipped; completes source; prepares target (T-SIGNALS-6, UC-SIGNALS-6, FP-SIG-TRANSITION-GOTO, FP-SIG-EVENT-SKIPPED)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(sandbox, GOTO_YAML, "signals-goto");

      // review is running; cleanup is waiting (depends on review).
      await setJobState(runDir, "review", { status: "running", current_step: "route" });

      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "route",
        attempt: 1,
        action: { goto_job: "cleanup" },
        reason: "router decided: goto_job (case: stop)",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const signalIdx = events.findIndex((e) => e.type === "signal_received");
      const skippedIdx = events.findIndex((e) => e.type === "job_skipped");
      expect(signalIdx).toBeGreaterThanOrEqual(0);
      expect(skippedIdx).toBeGreaterThan(signalIdx);

      const skippedEvent = events[skippedIdx]!;
      expect(skippedEvent.payload).toMatchObject({
        job_id: "review",
        target: "cleanup",
        reason: "router decided: goto_job (case: stop)",
      });

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["review"]!.status).toBe("completed");
      expect(snap.jobs["review"]!.current_step).toBeUndefined();
      expect(snap.jobs["cleanup"]!.status).toBe("ready");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-6b: goto_job — target with unmet deps stays waiting
// ---------------------------------------------------------------------------

/**
 * Extended GOTO workflow for T-SIGNALS-6b.
 * `cleanup` depends on BOTH `review` (source) AND `prerequisite`.
 * When goto_job targets `cleanup` from `review`, `prerequisite` is still
 * waiting → cleanup must stay "waiting", not be set to "ready".
 */
const GOTO_UNMET_DEPS_YAML = `\
name: signals-goto-unmet
version: "0.1.0"
jobs:
  prerequisite:
    steps:
      - id: pre
        type: script
        run: "echo pre"
  review:
    steps:
      - id: route
        type: script
        run: "echo route"
  cleanup:
    needs:
      - review
      - prerequisite
    steps:
      - id: cleanup-step
        type: script
        run: "echo cleanup"
`;

describe("applyRoutingAction — goto_job target with unmet deps stays waiting (T-SIGNALS-6b)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "goto_job target stays waiting when it has unmet deps beyond the source job (T-SIGNALS-6b, FP-SIG-TRANSITION-GOTO)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        GOTO_UNMET_DEPS_YAML,
        "signals-goto-unmet"
      );

      // review is running; prerequisite is still waiting; cleanup is waiting.
      await setJobState(runDir, "review", { status: "running", current_step: "route" });

      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "review",
        sourceStepId: "route",
        attempt: 1,
        action: { goto_job: "cleanup" },
        reason: "router decided: goto_job (case: skip_review)",
        clock: new FakeClock(),
      });

      const snap = await readStateSnapshot(runDir);
      // Source should be completed
      expect(snap.jobs["review"]!.status).toBe("completed");
      // prerequisite is still not completed → cleanup stays waiting
      expect(snap.jobs["cleanup"]!.status).toBe("waiting");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-7: multiple sequential retries — attempt counter increments;
//              third call hits max_attempts guard
// ---------------------------------------------------------------------------

describe("applyRoutingAction — sequential retry loop (T-SIGNALS-7)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "increments attempt across three calls; final call hits max_attempts and blocks (T-SIGNALS-7, UC-SIGNALS-7, UC-SIGNALS-8, FP-SIG-RETRY-MAX-GUARD)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        RETRY_YAML,
        "signals-retry"
      );

      // Initial attempt = 1; first retry → attempt = 2.
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "static-check",
        attempt: 1,
      });
      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "static-check",
        attempt: 1,
        action: { retry_job: "implement" },
        reason: "check failed (1)",
        clock: new FakeClock(),
      });
      expect((await readStateSnapshot(runDir)).jobs["implement"]!.attempt).toBe(2);

      // Simulate next attempt running; second retry → attempt = 3.
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "static-check",
        attempt: 2,
      });
      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "static-check",
        attempt: 2,
        action: { retry_job: "implement" },
        reason: "check failed (2)",
        clock: new FakeClock(),
      });
      expect((await readStateSnapshot(runDir)).jobs["implement"]!.attempt).toBe(3);

      // Third call: next attempt would be 4 > max_attempts (3); guard fires.
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "static-check",
        attempt: 3,
      });
      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "static-check",
        attempt: 3,
        action: { retry_job: "implement" },
        reason: "check failed (3)",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      // Exactly TWO job_retrying events (for attempts 2 and 3); none for the
      // would-be attempt 4.
      expect(events.filter((e) => e.type === "job_retrying")).toHaveLength(2);

      const finalSnap = await readStateSnapshot(runDir);
      expect(finalSnap.jobs["implement"]!.attempt).toBe(3);
      expect(finalSnap.jobs["implement"]!.status).toBe("blocked");
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-8: retry beyond max_attempts — signal_received only;
//              status → blocked; attempt unchanged
// ---------------------------------------------------------------------------

describe("applyRoutingAction — max_attempts guard (T-SIGNALS-8)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "emits signal_received but NOT job_retrying when next attempt would exceed max_attempts; sets status to blocked; leaves attempt unchanged (T-SIGNALS-8, UC-SIGNALS-8, FP-SIG-RETRY-MAX-GUARD)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        RETRY_YAML,
        "signals-retry"
      );

      // attempt is already at max (3); next would be 4 > 3.
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "static-check",
        attempt: 3,
      });

      await callApplyRoutingAction({
        runDir,
        runId,
        sourceJobId: "implement",
        sourceStepId: "static-check",
        attempt: 3,
        action: { retry_job: "implement" },
        reason: "check failed (final)",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      expect(events.filter((e) => e.type === "signal_received").length).toBeGreaterThanOrEqual(1);
      expect(events.filter((e) => e.type === "job_retrying")).toHaveLength(0);

      const snap = await readStateSnapshot(runDir);
      expect(snap.jobs["implement"]!.status).toBe("blocked");
      expect(snap.jobs["implement"]!.attempt).toBe(3);
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-9: integration — script step on_failure: { retry_job }
//              drives full retry cycle via the script executor
// ---------------------------------------------------------------------------

describe("applyRoutingAction — script executor on_failure: retry_job integration (T-SIGNALS-9)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "script step exit=1 with on_failure: { retry_job } → executor delegates to applyRoutingAction → job_retrying emitted; attempt incremented; current_step cleared (T-SIGNALS-9, UC-SIGNALS-9, FP-SIG-EXECUTOR-DELEGATION)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        SCRIPT_RETRY_YAML,
        "signals-script-retry"
      );

      await executeCurrentStep({
        runDir,
        zigmaflowDir: sandbox.projectRoot,
        runId,
        jobId: "implement",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);
      // Must contain the full sequence emitted by script executor + handler.
      expect(types).toContain("step_started");
      expect(types).toContain("script_completed");
      expect(types).toContain("step_failed");
      expect(types).toContain("signal_received");
      expect(types).toContain("job_retrying");

      // step_failed must precede signal_received which must precede job_retrying.
      const stepFailedIdx = types.lastIndexOf("step_failed");
      const signalIdx = types.lastIndexOf("signal_received");
      const retryIdx = types.lastIndexOf("job_retrying");
      expect(stepFailedIdx).toBeLessThan(signalIdx);
      expect(signalIdx).toBeLessThan(retryIdx);

      const snap = await readStateSnapshot(runDir);
      const implement = snap.jobs["implement"]!;
      expect(implement.status).toBe("ready");
      expect(implement.current_step).toBeUndefined();
      expect(implement.attempt).toBe(2);
    }
  );
});

// ---------------------------------------------------------------------------
// T-SIGNALS-10: negative — illegal source-state transition throws WorkflowError
// ---------------------------------------------------------------------------

describe("applyRoutingAction — illegal source transition (T-SIGNALS-10)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws WorkflowError when source job is in a terminal state and action is not a valid retry path; does not mutate disk (T-SIGNALS-10, UC-SIGNALS-10, FP-SIG-INVALID-TRANSITION)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        MULTI_STEP_YAML,
        "signals-multi"
      );

      // Source job is already failed; "continue" is an illegal transition.
      await setJobState(runDir, "build", { status: "failed", current_step: "s1" });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callApplyRoutingAction({
          runDir,
          runId,
          sourceJobId: "build",
          sourceStepId: "s1",
          attempt: 1,
          action: "continue",
          reason: "illegal transition",
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
// T-SIGNALS-11: negative — activate_job on a required job throws WorkflowError
// ---------------------------------------------------------------------------

describe("applyRoutingAction — activate_job required-job guard (T-SIGNALS-11)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws WorkflowError when activate_job target has no activation declaration; does not mutate disk (T-SIGNALS-11, UC-SIGNALS-11, FP-SIG-ACTIVATE-OPTIONAL-GUARD)",
    async () => {
      // OPTIONAL_YAML has both an optional job and a required `review` job;
      // attempt to activate the required one.
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        OPTIONAL_YAML,
        "signals-optional"
      );

      await setJobState(runDir, "review", { status: "running", current_step: "route" });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callApplyRoutingAction({
          runDir,
          runId,
          sourceJobId: "review",
          sourceStepId: "route",
          attempt: 1,
          action: { activate_job: "review" }, // review is required, no activation field
          reason: "illegal activation",
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
// T-SIGNALS-12: negative — unknown target job throws WorkflowError
// ---------------------------------------------------------------------------

describe("applyRoutingAction — unknown target (T-SIGNALS-12)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "throws WorkflowError when the action target does not exist in the workflow; does not mutate disk (T-SIGNALS-12, UC-SIGNALS-12, FP-SIG-UNKNOWN-TARGET)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        GOTO_YAML,
        "signals-goto"
      );

      await setJobState(runDir, "review", { status: "running", current_step: "route" });

      const eventsBefore = await readEventsBytes(runDir);
      const stateBefore = await readStateBytes(runDir);

      await expect(
        callApplyRoutingAction({
          runDir,
          runId,
          sourceJobId: "review",
          sourceStepId: "route",
          attempt: 1,
          action: { goto_job: "ghost-job" },
          reason: "illegal target",
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
// T-SIGNALS-13: integration — check step on_fail: { retry_job } drives full
//               retry cycle via the check executor
// ---------------------------------------------------------------------------

describe("applyRoutingAction — check executor on_fail: retry_job integration (T-SIGNALS-13)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await rm(sandbox.projectRoot, { recursive: true, force: true });
  });

  it(
    "check step fail with on_fail: { retry_job } → executor delegates to applyRoutingAction → signal_received → job_retrying emitted (T-SIGNALS-13, UC-SIGNALS-9 variant, FP-SIG-EXECUTOR-DELEGATION)",
    async () => {
      const { runId, runDir } = await bootstrapSignalsRun(
        sandbox,
        RETRY_YAML,
        "signals-retry"
      );

      // Drive the static-check step directly. The workflow's check kind is
      // `code.checks.file-exists` against a missing path, so it will fail.
      // implement starts in "ready"; we manually advance to running with
      // current_step set to the check step.
      await setJobState(runDir, "implement", {
        status: "running",
        current_step: "static-check",
        attempt: 1,
      });

      await executeCurrentStep({
        runDir,
        zigmaflowDir: sandbox.projectRoot,
        runId,
        jobId: "implement",
        clock: new FakeClock(),
      });

      const events = await readEvents(runDir);
      const types = events.map((e) => e.type);
      expect(types).toContain("step_started");
      expect(types).toContain("check_completed");
      expect(types).toContain("step_failed");
      expect(types).toContain("signal_received");
      expect(types).toContain("job_retrying");

      const snap = await readStateSnapshot(runDir);
      const implement = snap.jobs["implement"]!;
      expect(implement.status).toBe("ready");
      expect(implement.attempt).toBe(2);
      expect(implement.current_step).toBeUndefined();
    }
  );
});
