/**
 * Engine — orchestrates run creation and step execution.
 *
 * Reference: docs/mvp-contracts.md §2.3, §2.4 (RC-R01..R12)
 * WF-P3-RUN Step 2 / WF-P6-DISPATCH Step 2.
 */

import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { computeReadyJobs } from "../dag/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { Clock, RunState } from "../run/index.js";
import { ConfigError, StateError, WorkflowError } from "../utils/index.js";
import type { ProcessRunner } from "../script/index.js";
import { ExecaProcessRunner } from "../script/index.js";
import { executeScriptStep } from "../script/executor.js";
import type { CheckRunner } from "../check/index.js";
import { LocalCheckRunner } from "../check/index.js";
import { executeCheckStep } from "../check/executor.js";
import { executeRouterStep } from "../router/executor.js";
import {
  JsonlEventWriter,
  LocalRunIdGenerator,
  LocalStateStore,
  SystemClock,
  createRunDirectory,
  snapshotSkillLock,
  writeActiveRun,
  writeRunYaml,
} from "../run/index.js";
import { nextEventId as formatEventId } from "../events/index.js";

export { applyRoutingAction } from "./routing.js";
export type { ApplyRoutingActionOpts } from "./routing.js";
export { retryJob } from "./retryJob.js";
export type { RetryJobOpts } from "./retryJob.js";
export { abortRun } from "./abort.js";
export type { AbortRunOpts } from "./abort.js";

export interface CreateRunInputs {
  workflowPath: string;
  task: string;
  runsDir: string;
  skillLockPath: string;
  clock?: Clock; // injectable for tests; defaults to SystemClock
}

export interface CreateRunResult {
  runId: string;
}

export async function createRun(inputs: CreateRunInputs): Promise<CreateRunResult> {
  const clock: Clock = inputs.clock ?? new SystemClock();
  const idGenerator = new LocalRunIdGenerator(clock);
  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // RC-R01: Generate runId
  const runId = await idGenerator.nextRunId(inputs.runsDir);

  // RC-R02: Create run directory
  const runDir = await createRunDirectory(runId, inputs.runsDir);

  // Load workflow (prerequisite for RC-R03..R06)
  const wf = await loadWorkflowFile(inputs.workflowPath);

  // RC-R12: Snapshot skill-lock into run directory
  await snapshotSkillLock(runDir, inputs.skillLockPath);

  // RC-R03: Write run.yml
  const createdAt = clock.now();
  await writeRunYaml(runDir, {
    task: inputs.task,
    workflow: {
      name: wf.name,
      path: inputs.workflowPath,
    },
    created_at: createdAt,
    skill_lock_snapshot: "skill-lock.snapshot.json",
  });

  // RC-R04/R05/R06: Compute initial job states (ready / waiting / inactive)
  const readySet = new Set(computeReadyJobs(wf.jobs, new Set(), new Set()));

  const jobs: Record<string, import("../run/index.js").JobState> = {};
  for (const [jobId, jobDef] of Object.entries(wf.jobs)) {
    if (jobDef.activation !== undefined) {
      // activation: optional (or any activation value) → inactive
      const js: import("../run/index.js").JobState = { status: "inactive" };
      js.activation = jobDef.activation;
      jobs[jobId] = js;
    } else if (readySet.has(jobId)) {
      jobs[jobId] = { status: "ready" };
    } else {
      jobs[jobId] = { status: "waiting" };
    }
  }

  // RC-R09/R10: Event counter — sequential evt-NNN ids
  let eventCounter = 1;
  function nextEventId(): string {
    return formatEventId(eventCounter++);
  }

  // RC-R09: Append run_created event (evt-001)
  await eventWriter.appendEvent(runDir, {
    id: nextEventId(),
    type: "run_created",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
    payload: { workflow: wf.name, task: inputs.task },
  });

  // RC-R10: Append one job_ready event per initial ready job
  // Use Object.keys(wf.jobs) order filtered to those in the ready set
  for (const jobId of Object.keys(wf.jobs)) {
    if (readySet.has(jobId)) {
      await eventWriter.appendEvent(runDir, {
        id: nextEventId(),
        type: "job_ready",
        run_id: runId,
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { job_id: jobId },
      });
    }
  }

  // RC-R08/R11: Read confirmed tail event id — MUST be non-null after appending run_created
  const lastEventId = await eventWriter.readLastEventId(runDir);
  if (lastEventId === null) {
    throw new WorkflowError("events.jsonl is empty after appending run_created — write failure", {
      details: { runDir },
    });
  }

  // RC-R11: Build RunState with the confirmed last event id, then atomic write
  const state: RunState = {
    run_id: runId,
    workflow: wf.name,
    task: inputs.task,
    created_at: createdAt,
    last_event_id: lastEventId,
    jobs,
  };

  // RC-R07/R11: Atomically write state.json via StateStore (Engine is sole writer)
  await stateStore.writeSnapshot(runDir, state);

  // WF-P5-PROMPT: Write active_run pointer to config.json.
  // runsDir = <project>/.zigma-flow/runs → zigmaflowDir = <project>
  const zigmaflowDir = dirname(dirname(inputs.runsDir));
  try {
    await writeActiveRun(zigmaflowDir, runId);
  } catch (e: unknown) {
    // Suppress ConfigError (config.json not yet created — first run / test setups).
    // Re-throw all other errors (permission denied, disk full, etc.).
    if (!(e instanceof ConfigError)) throw e;
  }

  return { runId };
}

// ---------------------------------------------------------------------------
// executeCurrentStep — script step execution (implemented in WF-P6-SCRIPT)
// ---------------------------------------------------------------------------

export interface ExecuteCurrentStepOpts {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  runner?: ProcessRunner | CheckRunner;
  clock: Clock;
}

export async function executeCurrentStep(opts: ExecuteCurrentStepOpts): Promise<void> {
  const { runDir, zigmaflowDir, runId, jobId, clock } = opts;

  // Read current state to validate job exists
  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  // Load workflow to validate step type (P6: only script steps)
  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  const jobDef = wf.jobs[jobId];
  if (jobDef === undefined) {
    throw new WorkflowError(`Job "${jobId}" not found in workflow definition`);
  }

  const stepId = jobState.current_step ?? jobDef.steps[0]?.id;
  if (stepId === undefined) {
    throw new WorkflowError(`Job "${jobId}" has no steps defined`);
  }

  const stepDef = jobDef.steps.find((s) => s.id === stepId);
  if (stepDef === undefined) {
    throw new WorkflowError(`Step "${stepId}" not found in job "${jobId}"`);
  }

  if (stepDef.type === "script") {
    const actualRunner = (opts.runner as ProcessRunner | undefined) ?? new ExecaProcessRunner();
    await executeScriptStep({
      runDir,
      zigmaflowDir,
      runId,
      jobId,
      clock,
      runner: actualRunner,
    });
  } else if (stepDef.type === "check") {
    const actualRunner = (opts.runner as CheckRunner | undefined) ?? new LocalCheckRunner();
    await executeCheckStep({
      runDir,
      zigmaflowDir,
      runId,
      jobId,
      clock,
      runner: actualRunner,
    });
  } else if (stepDef.type === "router") {
    await executeRouterStep({
      runDir,
      zigmaflowDir,
      runId,
      jobId,
      clock,
    });
  } else {
    throw new WorkflowError(
      `Step "${stepId}" in job "${jobId}" is type "${stepDef.type}", not a script, check, or router step (P8 scope)`,
      { details: { jobId, stepId, stepType: stepDef.type } }
    );
  }
}

// ---------------------------------------------------------------------------
// advanceJob — mechanical step-pointer advancement (WF-P8-MULTISTEP Step 2)
// ---------------------------------------------------------------------------

export interface AdvanceJobOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Job identifier to advance the step pointer for. */
  jobId: string;
  /** Clock for timestamping the job_completed event (terminal path only). */
  clock: Clock;
}

/**
 * Advance the step pointer for a job after a step has completed.
 *
 * Contract:
 * - Reads the run state snapshot from disk.
 * - Locates the current step pointer (`state.jobs[jobId].current_step`).
 * - If undefined, treats it as "the implicit first step just finished"
 *   (post-retry-reset baseline, TD-P8-005).
 * - Finds the next step in `JobDefinition.steps` after the pointer.
 * - If a next step exists: writes a new snapshot with `current_step` set
 *   to the next step's id and returns `true`.
 * - If no next step exists (or steps is empty): appends a single
 *   `job_completed` event, sets `state.jobs[jobId].status = "completed"`,
 *   removes `current_step`, writes a snapshot with the updated
 *   `last_event_id`, and returns `false`.
 * - If the job is in a terminal/gated state (`completed`, `failed`,
 *   `blocked`): returns `false` immediately without touching disk.
 * - If state is missing or the job/pointer cannot be resolved: throws
 *   `StateError` without writing any state or event.
 *
 * Reference: docs/phases/p8-router-and-signals/workflows/wf-p8-multistep/01-cases-and-tests.md
 * FP-MULTISTEP-ENGINE-ENTRY, FP-MULTISTEP-POINTER-INIT, FP-MULTISTEP-POINTER-WRITE,
 * FP-MULTISTEP-JOB-COMPLETED, FP-MULTISTEP-FINAL-SEQUENCE, FP-MULTISTEP-FAILED-GATE,
 * FP-MULTISTEP-INVALID-JOB, FP-MULTISTEP-UNKNOWN-POINTER, FP-MULTISTEP-STATE-MISSING,
 * FP-MULTISTEP-EMPTY-STEPS, FP-MULTISTEP-IDEMPOTENT-TERMINAL.
 */
export async function advanceJob(opts: AdvanceJobOpts): Promise<boolean> {
  const { runDir, runId, jobId, clock } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read state snapshot — throw StateError if missing ─────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  // ── 2. Locate job — throw StateError if absent ────────────────────────────

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  // ── 3. Idempotent terminal guard (FP-MULTISTEP-IDEMPOTENT-TERMINAL) ───────

  if (jobState.status === "completed") {
    return false;
  }

  // ── 4. Failed/blocked gate — inert no-op (FP-MULTISTEP-FAILED-GATE) ──────

  if (jobState.status === "failed" || jobState.status === "blocked") {
    return false;
  }

  // ── 5. Load workflow to resolve JobDefinition.steps ──────────────────────

  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  const jobDef = wf.jobs[jobId];
  if (jobDef === undefined) {
    throw new StateError(
      `Job "${jobId}" not found in workflow definition for run ${runId}`
    );
  }

  const steps = jobDef.steps;

  // ── 6. Empty steps array — defensive completion (FP-MULTISTEP-EMPTY-STEPS) ─

  if (steps.length === 0) {
    return await appendJobCompleted({ state, stateStore, eventWriter, runDir, runId, jobId, clock, wf });
  }

  // ── 7. Resolve current step index ────────────────────────────────────────

  const currentStep = jobState.current_step;
  let currentIndex: number;

  if (currentStep === undefined) {
    // FP-MULTISTEP-POINTER-INIT: undefined means "implicit first step just finished"
    currentIndex = 0;
  } else {
    const idx = steps.findIndex((s) => s.id === currentStep);
    if (idx === -1) {
      // FP-MULTISTEP-UNKNOWN-POINTER
      throw new StateError(
        `current_step "${currentStep}" not found in steps for job "${jobId}" in run ${runId}`
      );
    }
    currentIndex = idx;
  }

  // ── 8. Find next step ─────────────────────────────────────────────────────

  const nextIndex = currentIndex + 1;

  if (nextIndex < steps.length) {
    // ── 8a. Non-terminal: advance pointer, write snapshot, return true ──────
    // FP-MULTISTEP-POINTER-WRITE: no new events, just update current_step
    const nextStepId = steps[nextIndex]!.id;
    const updatedState: RunState = {
      ...state,
      jobs: {
        ...state.jobs,
        [jobId]: {
          ...jobState,
          current_step: nextStepId,
        },
      },
    };
    await stateStore.writeSnapshot(runDir, updatedState);
    return true;
  }

  // ── 8b. Terminal: no next step — append job_completed, complete job ───────
  // FP-MULTISTEP-JOB-COMPLETED, FP-MULTISTEP-FINAL-SEQUENCE
  return await appendJobCompleted({ state, stateStore, eventWriter, runDir, runId, jobId, clock, wf });
}

// ---------------------------------------------------------------------------
// appendJobCompleted — shared terminal path for advanceJob
// ---------------------------------------------------------------------------

interface AppendJobCompletedOpts {
  state: RunState;
  stateStore: LocalStateStore;
  eventWriter: JsonlEventWriter;
  runDir: string;
  runId: string;
  jobId: string;
  clock: Clock;
  wf: import("../workflow/index.js").WorkflowDefinition;
}

async function appendJobCompleted(opts: AppendJobCompletedOpts): Promise<false> {
  const { state, stateStore, eventWriter, runDir, runId, jobId, clock, wf } = opts;

  const jobState = state.jobs[jobId]!;
  const attempt = jobState.attempt ?? 1;

  // Read the current tail event id to derive the next sequential counter
  const lastId = await eventWriter.readLastEventId(runDir);
  let counter = lastId !== null ? parseInt(lastId.replace("evt-", ""), 10) : 0;
  const jobCompletedId = formatEventId(++counter);

  // Append job_completed event BEFORE writing snapshot (FP-MULTISTEP-FINAL-SEQUENCE)
  await eventWriter.appendEvent(runDir, {
    id: jobCompletedId,
    run_id: runId,
    type: "job_completed",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: null,
    attempt,
    payload: { job_id: jobId, attempt },
  });

  // Build terminal snapshot: remove current_step, set status = "completed",
  // update last_event_id to the appended event id.
  const completedJobState = { ...jobState };
  delete completedJobState.current_step;
  completedJobState.status = "completed";

  let finalState: RunState = {
    ...state,
    last_event_id: jobCompletedId,
    jobs: {
      ...state.jobs,
      [jobId]: completedJobState,
    },
  };

  // Propagate readiness: find dependent jobs whose needs are now all satisfied
  // and transition them from "waiting" → "ready", emitting job_ready events.
  const completedJobIds = new Set<string>(
    Object.entries(finalState.jobs)
      .filter(([, js]) => js.status === "completed")
      .map(([id]) => id)
  );
  const activeJobIds = new Set<string>(
    Object.keys(finalState.jobs).filter(
      (id) => !completedJobIds.has(id) && finalState.jobs[id]!.status !== "waiting"
    )
  );
  const nowReadyIds = computeReadyJobs(wf.jobs, completedJobIds, activeJobIds);

  for (const readyId of nowReadyIds) {
    const waitingJobState = finalState.jobs[readyId];
    if (waitingJobState?.status !== "waiting") continue;

    const jobReadyId = formatEventId(++counter);
    await eventWriter.appendEvent(runDir, {
      id: jobReadyId,
      run_id: runId,
      type: "job_ready",
      timestamp: clock.now(),
      producer: "engine",
      job: null,
      step: null,
      attempt: null,
      payload: { job_id: readyId },
    });

    finalState = {
      ...finalState,
      last_event_id: jobReadyId,
      jobs: {
        ...finalState.jobs,
        [readyId]: { ...waitingJobState, status: "ready" as const },
      },
    };
  }

  // Check if run is now complete: all non-inactive jobs completed
  const allNonInactiveCompleted = Object.values(finalState.jobs).every(
    js => js.status === "completed" || js.status === "inactive"
  );
  const hasCompletedJob = Object.values(finalState.jobs).some(
    js => js.status === "completed"
  );

  if (allNonInactiveCompleted && hasCompletedJob) {
    const runCompletedId = formatEventId(++counter);
    await eventWriter.appendEvent(runDir, {
      id: runCompletedId,
      run_id: runId,
      type: "run_completed",
      timestamp: clock.now(),
      producer: "engine",
      job: null,
      step: null,
      attempt: null,
      payload: {},
    });
    finalState = {
      ...finalState,
      last_event_id: runCompletedId,
      status: "completed",
    };
  }

  await stateStore.writeSnapshot(runDir, finalState);

  return false;
}

// ---------------------------------------------------------------------------
// Internal: parse run.yml to get the workflow file path
// ---------------------------------------------------------------------------

interface RunYmlShape {
  workflow?: { path?: string };
}

async function readWorkflowPathFromRunYml(runDir: string): Promise<string> {
  const runYmlPath = join(runDir, "run.yml");
  let raw: string;
  try {
    raw = await readFile(runYmlPath, "utf-8");
  } catch (e: unknown) {
    throw new StateError(`Cannot read run.yml in: ${runDir}`, { cause: e });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e: unknown) {
    throw new StateError(`run.yml contains invalid YAML in: ${runDir}`, { cause: e });
  }

  const shape = parsed as RunYmlShape;
  const wfPath = shape?.workflow?.path;
  if (typeof wfPath !== "string" || wfPath.length === 0) {
    throw new StateError(`run.yml is missing workflow.path in: ${runDir}`);
  }
  return wfPath;
}
