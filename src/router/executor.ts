/**
 * Router step execution orchestration — WF-P8-ROUTER Step 2.
 *
 * `executeRouterStep` is the deterministic control-flow pipeline that:
 *   1. Reads current state to locate the router step to execute.
 *   2. Loads the workflow to resolve the step definition.
 *   3. Validates `switch` and `cases` fields — throws RouterError BEFORE any events.
 *   4. Resolves the matching case (literal lookup; falls back to "default").
 *   5. Emits `step_started`; writes intermediate state snapshot (ready → running).
 *   6. Emits `router_decided` with the resolved action and optional target.
 *   7. Applies terminal transition:
 *      - "continue" → step_completed + job_completed; job → completed.
 *      - "fail"     → step_failed (reason: "router decided: fail"); job → failed.
 *      - "block"    → step_failed (reason: "router decided: block"); job → blocked.
 *      - object forms (retry_job / activate_job / goto_job) → no terminal event;
 *        job remains "running" (TD-P8-005; WF-P8-SIGNALS picks up the decision).
 *   8. Writes terminal state snapshot once (after the last event of the sequence).
 *
 * Reference:
 *   - docs/phases/p8-router-and-signals/workflows/wf-p8-router/01-cases-and-tests.md
 *   - docs/mvp-contracts.md §2.4, §2.1
 *   - docs/architecture.md §7.1, §7.2, §7.3, §9.4, §12.3
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import { nextEventId } from "../events/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { RouterAction } from "../workflow/index.js";
import { RouterError, StateError, WorkflowError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// ExecuteRouterStepOpts
// ---------------------------------------------------------------------------

export interface ExecuteRouterStepOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Absolute path to the project root (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Run identifier. */
  runId: string;
  /** Job identifier to execute the current step for. */
  jobId: string;
  /** Clock for timestamping events. */
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Internal helpers
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

/**
 * Given a RouterAction, return the string action discriminator and optional
 * target job id. Used to populate router_decided.payload.
 */
function resolveActionFields(action: RouterAction): { action: string; target?: string } {
  if (action === "continue" || action === "fail" || action === "block") {
    return { action };
  }
  if (typeof action === "object" && action !== null) {
    if ("retry_job" in action) return { action: "retry_job", target: action.retry_job };
    if ("activate_job" in action) return { action: "activate_job", target: action.activate_job };
    if ("goto_job" in action) return { action: "goto_job", target: action.goto_job };
    if ("status" in action) {
      // { status: "blocked" | "failed" } is a valid RouterAction from the schema
      // but is not a first-class literal in FR-009. Treat as its status string.
      return { action: action.status };
    }
  }
  throw new RouterError(`Unrecognised RouterAction shape: ${JSON.stringify(action)}`);
}

// ---------------------------------------------------------------------------
// executeRouterStep — main pipeline
// ---------------------------------------------------------------------------

export async function executeRouterStep(opts: ExecuteRouterStepOpts): Promise<void> {
  const { runDir, runId, jobId, clock } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read current state ────────────────────────────────────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  const attempt = jobState.attempt ?? 1;

  // ── 2. Load workflow to resolve step definition ──────────────────────────

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

  if (stepDef.type !== "router") {
    throw new WorkflowError(
      `Step "${stepId}" in job "${jobId}" is type "${stepDef.type}", not "router"`,
      { details: { jobId, stepId, stepType: stepDef.type } }
    );
  }

  // ── 3. Validate switch + cases — MUST throw RouterError BEFORE any events ─
  //
  // Per FP-RTR-INVALID-ROUTE: missing/non-string switch, missing cases, or no
  // matching case+default all throw RouterError before step_started is appended.

  const switchValue = stepDef.switch;
  if (typeof switchValue !== "string" || switchValue.length === 0) {
    throw new RouterError(
      `Router step "${stepId}" in job "${jobId}" is missing or has a non-string "switch" field`,
      { details: { jobId, stepId } }
    );
  }

  const cases = stepDef.cases;
  if (cases === undefined || typeof cases !== "object") {
    throw new RouterError(
      `Router step "${stepId}" in job "${jobId}" is missing a "cases" map`,
      { details: { jobId, stepId } }
    );
  }

  // Resolve case: exact match first, fall back to "default"
  const matchedAction: RouterAction | undefined =
    cases[switchValue] ?? cases["default"];

  if (matchedAction === undefined) {
    throw new RouterError(
      `Router step "${stepId}" in job "${jobId}": switch value "${switchValue}" did not match any case and no "default" is defined`,
      { details: { jobId, stepId, switchValue, availableCases: Object.keys(cases) } }
    );
  }

  // Determine whether this router step is the last step in the job (required
  // for the continue → job_completed path). For non-terminal continue we throw
  // WorkflowError (TD-P6-004).
  const isLastStep = jobDef.steps[jobDef.steps.length - 1]?.id === stepId;

  // ── 4. Initialize in-process event counter ──────────────────────────────

  const initialLastId = await eventWriter.readLastEventId(runDir);
  let eventCounter =
    initialLastId !== null ? parseInt(initialLastId.replace("evt-", ""), 10) : 0;
  function getNextEventId(): string {
    return nextEventId(++eventCounter);
  }

  // ── 5. Emit step_started; write intermediate state snapshot ─────────────

  const stepStartedId = getNextEventId();
  await eventWriter.appendEvent(runDir, {
    id: stepStartedId,
    run_id: runId,
    type: "step_started",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt,
    payload: { job_id: jobId, step_id: stepId, attempt },
  });

  // Intermediate snapshot: job → running
  const runningState: RunState = {
    ...state,
    last_event_id: stepStartedId,
    jobs: {
      ...state.jobs,
      [jobId]: {
        ...jobState,
        status: "running",
        current_step: stepId,
        attempt,
      },
    },
  };
  await stateStore.writeSnapshot(runDir, runningState);

  // ── 6. Emit router_decided ───────────────────────────────────────────────

  const { action: actionStr, target } = resolveActionFields(matchedAction);

  const routerDecidedId = getNextEventId();
  const routerDecidedPayload: {
    job_id: string;
    step_id: string;
    action: string;
    target?: string;
  } = {
    job_id: jobId,
    step_id: stepId,
    action: actionStr,
    ...(target !== undefined ? { target } : {}),
  };

  await eventWriter.appendEvent(runDir, {
    id: routerDecidedId,
    run_id: runId,
    type: "router_decided",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt,
    payload: routerDecidedPayload,
  });

  // ── 7. Apply terminal transition ─────────────────────────────────────────

  if (actionStr === "continue") {
    // Terminal success — only valid when this is the last step in the job.
    if (!isLastStep) {
      throw new WorkflowError(
        `Router step "${stepId}" resolved to "continue" but is not the last step in job "${jobId}". Multi-step advancement is TD-P6-004 (WF-P8-MULTISTEP).`,
        { details: { jobId, stepId } }
      );
    }

    const stepCompletedId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: stepCompletedId,
      run_id: runId,
      type: "step_completed",
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: { job_id: jobId, step_id: stepId, attempt },
    });

    const jobCompletedId = getNextEventId();
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

    // Terminal snapshot: job → completed
    const completedState: RunState = {
      ...runningState,
      last_event_id: jobCompletedId,
      jobs: {
        ...runningState.jobs,
        [jobId]: {
          ...runningState.jobs[jobId]!,
          status: "completed",
        },
      },
    };
    await stateStore.writeSnapshot(runDir, completedState);

  } else if (actionStr === "fail") {
    const caseKey = matchedAction === "fail" ? switchValue : switchValue;
    const reason = `router decided: fail (case: ${caseKey})`;

    const stepFailedId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: stepFailedId,
      run_id: runId,
      type: "step_failed",
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: { job_id: jobId, step_id: stepId, attempt, reason },
    });

    // Terminal snapshot: job → failed
    const failedState: RunState = {
      ...runningState,
      last_event_id: stepFailedId,
      jobs: {
        ...runningState.jobs,
        [jobId]: {
          ...runningState.jobs[jobId]!,
          status: "failed",
        },
      },
    };
    await stateStore.writeSnapshot(runDir, failedState);

  } else if (actionStr === "block") {
    const caseKey = switchValue;
    const reason = `router decided: block (case: ${caseKey})`;

    const stepFailedId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: stepFailedId,
      run_id: runId,
      type: "step_failed",
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: { job_id: jobId, step_id: stepId, attempt, reason },
    });

    // Terminal snapshot: job → blocked
    const blockedState: RunState = {
      ...runningState,
      last_event_id: stepFailedId,
      jobs: {
        ...runningState.jobs,
        [jobId]: {
          ...runningState.jobs[jobId]!,
          status: "blocked",
        },
      },
    };
    await stateStore.writeSnapshot(runDir, blockedState);

  } else {
    // Object-form action: retry_job / activate_job / goto_job
    // Per TD-P8-005: emit router_decided only; no terminal event.
    // Job remains "running"; last_event_id advances to router_decided.
    const deferredState: RunState = {
      ...runningState,
      last_event_id: routerDecidedId,
    };
    await stateStore.writeSnapshot(runDir, deferredState);
  }
}
