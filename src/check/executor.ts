/**
 * Check step execution orchestration — WF-P7-CHECK Step 2.
 *
 * `executeCheckStep` is the core pipeline that:
 *   1. Reads current state to locate the check step to execute.
 *   2. Loads the workflow to resolve the step definition.
 *   3. Resolves the check kind (throws CheckError if unknown — BEFORE any events).
 *   4. Emits `step_started`; writes state snapshot (job ready → running).
 *   5. Invokes the CheckRunner.
 *   6. Writes check-result.json artifact.
 *   7. Emits `check_completed`.
 *   8. On success: emits `step_completed` + `job_completed`; job → completed.
 *      On failure: emits `step_failed`; job → failed (or blocked per on_fail).
 *   9. Writes the final state snapshot (once, after all events).
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-check/01-cases-and-tests.md §Step 2 Handoff Notes
 *   - docs/mvp-contracts.md §2.4, §2.5, §2.8, §7
 *   - docs/architecture.md §7.1, §7.2, §7.3, §9.4, §12.3
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";

import { nextEventId } from "../events/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import type { CheckRunner } from "./index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { RouterAction } from "../workflow/index.js";
import { WorkflowError, StateError } from "../utils/index.js";
import { artifactStepDir, appendArtifactIndex, artifactId, artifactFileRelativePath } from "../artifact/index.js";
import { applyRoutingAction } from "../engine/routing.js";
import { computeReadyJobs } from "../dag/index.js";

// ---------------------------------------------------------------------------
// ExecuteCheckStepOpts
// ---------------------------------------------------------------------------

export interface ExecuteCheckStepOpts {
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
  /** Injectable CheckRunner; defaults to LocalCheckRunner in production. */
  runner: CheckRunner;
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

// ---------------------------------------------------------------------------
// executeCheckStep — main pipeline
// ---------------------------------------------------------------------------

export async function executeCheckStep(opts: ExecuteCheckStepOpts): Promise<void> {
  const { runDir, zigmaflowDir: _zigmaflowDir, runId, jobId, clock, runner } = opts;

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

  // current_step points to step to execute; absent means first step
  const stepId = jobState.current_step ?? jobDef.steps[0]?.id;
  if (stepId === undefined) {
    throw new WorkflowError(`Job "${jobId}" has no steps defined`);
  }

  const stepDef = jobDef.steps.find((s) => s.id === stepId);
  if (stepDef === undefined) {
    throw new WorkflowError(`Step "${stepId}" not found in job "${jobId}"`);
  }

  if (stepDef.type !== "check") {
    throw new WorkflowError(
      `Step "${stepId}" in job "${jobId}" is type "${stepDef.type}", not "check"`,
      { details: { jobId, stepId, stepType: stepDef.type } }
    );
  }

  // ── 3. Resolve check kind — MUST throw CheckError BEFORE any events ──────
  // The runner's resolveKind() method is the pre-flight that validates the
  // check kind is registered. It MUST throw CheckError if the kind is not
  // known. This call happens before step_started is appended, preserving the
  // invariant that every step_started is paired with a terminal event.

  const checkId = typeof stepDef.uses === "string" && stepDef.uses.length > 0
    ? stepDef.uses
    : stepId;

  await runner.resolveKind(checkId);

  // ── 4. Initialize in-process event counter ──────────────────────────────
  // Read once here; all subsequent IDs are generated in-process.

  const initialLastId = await eventWriter.readLastEventId(runDir);
  let eventCounter = initialLastId !== null ? parseInt(initialLastId.replace("evt-", ""), 10) : 0;
  function getNextEventId(): string { return nextEventId(++eventCounter); }

  // ── 5. Emit step_started; write state snapshot (ready → running) ─────────

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

  // Write intermediate snapshot: job ready → running
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

  // ── 6. Invoke CheckRunner ─────────────────────────────────────────────────

  const checkRunWith = typeof stepDef.with === "object" && stepDef.with !== null
    ? (stepDef.with as Record<string, unknown>)
    : undefined;

  const checkResult = await runner.run({
    checkId,
    jobId,
    stepId,
    runDir,
    ...(checkRunWith !== undefined ? { with: checkRunWith } : {}),
  });

  // ── 7. Write check-result.json artifact ──────────────────────────────────

  const stepArtifactDir = artifactStepDir(runDir, jobId, attempt, stepId);
  await mkdir(stepArtifactDir, { recursive: true });

  await writeFile(
    join(stepArtifactDir, "check-result.json"),
    JSON.stringify(checkResult, null, 2),
    "utf-8"
  );

  // ── 7b. Register check-result.json in artifact index ─────────────────────

  const checkResultSize = await stat(join(stepArtifactDir, "check-result.json")).then(s => s.size).catch(() => 0);
  await appendArtifactIndex(runDir, {
    id: artifactId(runId, jobId, attempt, stepId, "check-result.json"),
    run_id: runId,
    producer: { job: jobId, step: stepId, attempt },
    kind: "check_result",
    path: artifactFileRelativePath(jobId, attempt, stepId, "check-result.json"),
    content_type: "application/json",
    size: checkResultSize,
    summary: `Check result for ${jobId}/${stepId}`,
    created_at: clock.now(),
  });

  // ── 8. Emit check_completed ───────────────────────────────────────────────
  // Per FP-CHECK-EVENT-CHECK-COMPLETED: failures is included only when non-empty.

  const checkCompletedId = getNextEventId();
  const checkCompletedPayload: {
    job_id: string;
    step_id: string;
    check_id: string;
    passed: boolean;
    failures?: string[];
  } = {
    job_id: jobId,
    step_id: stepId,
    check_id: checkId,
    passed: checkResult.passed,
    ...(checkResult.failures.length > 0 ? { failures: checkResult.failures } : {}),
  };

  await eventWriter.appendEvent(runDir, {
    id: checkCompletedId,
    run_id: runId,
    type: "check_completed",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt,
    payload: checkCompletedPayload,
  });

  // ── 9. Determine success/failure and emit terminal events ─────────────────

  if (checkResult.passed) {
    // ── 9a. Success path ───────────────────────────────────────────────────

    const onPass = stepDef.on_pass;

    // Check for object-form routing action (retry_job / activate_job / goto_job)
    const isObjectFormOnPass =
      onPass !== undefined &&
      typeof onPass === "object" &&
      ("retry_job" in onPass || "activate_job" in onPass || "goto_job" in onPass);

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

    if (isObjectFormOnPass) {
      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: jobId,
        sourceStepId: stepId,
        attempt,
        action: onPass as RouterAction,
        reason: `check passed: on_pass routing action`,
        clock,
      });
      return;
    }

    if (onPass !== undefined && onPass !== "continue") {
      throw new WorkflowError(
        `on_pass value "${String(onPass)}" is not supported (TD-P7-003). Only "continue", absent, or object-form routing actions are valid.`,
        { details: { jobId, stepId, onPass } }
      );
    }

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

    // Write final state snapshot: job running → completed, then propagate readiness
    let finalState: RunState = {
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

    // Propagate readiness to downstream jobs whose needs are now all satisfied
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

      const jobReadyId = getNextEventId();
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

    // Emit run_completed if all non-inactive jobs are done
    const allNonInactiveCompleted = Object.values(finalState.jobs).every(
      (js) => js.status === "completed" || js.status === "inactive"
    );
    const hasCompletedJob = Object.values(finalState.jobs).some(
      (js) => js.status === "completed"
    );
    if (allNonInactiveCompleted && hasCompletedJob) {
      const runCompletedId = getNextEventId();
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
  } else {
    // ── 9b. Failure path ───────────────────────────────────────────────────

    const firstFailure = checkResult.failures[0];
    const reason = firstFailure !== undefined
      ? `check failed: ${firstFailure}`
      : "check failed";

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

    const onFail = stepDef.on_fail;

    // Check for object-form routing action (retry_job / activate_job / goto_job)
    const isObjectFormOnFail =
      onFail !== undefined &&
      typeof onFail === "object" &&
      ("retry_job" in onFail || "activate_job" in onFail || "goto_job" in onFail);

    if (isObjectFormOnFail) {
      await applyRoutingAction({
        runDir,
        runId,
        sourceJobId: jobId,
        sourceStepId: stepId,
        attempt,
        action: onFail as RouterAction,
        reason,
        clock,
      });
      return;
    }

    // Apply on_fail override (status "failed" | "blocked"; default is "failed")
    let finalJobStatus: "failed" | "blocked" = "failed";
    if (
      onFail !== undefined &&
      typeof onFail === "object" &&
      "status" in onFail &&
      (onFail.status === "failed" || onFail.status === "blocked")
    ) {
      finalJobStatus = onFail.status;
    } else if (onFail === "fail") {
      finalJobStatus = "failed";
    } else if (onFail === "block") {
      finalJobStatus = "blocked";
    }

    // Write final state snapshot: job running → failed | blocked
    const failedState: RunState = {
      ...runningState,
      last_event_id: stepFailedId,
      jobs: {
        ...runningState.jobs,
        [jobId]: {
          ...runningState.jobs[jobId]!,
          status: finalJobStatus,
        },
      },
    };
    await stateStore.writeSnapshot(runDir, failedState);
  }
}
