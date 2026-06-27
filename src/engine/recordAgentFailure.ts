/**
 * recordAgentFailure — Engine entry point for handling agent step failures.
 *
 * Called by runAll when an agent backend execution fails. Writes the step_failed
 * event, loads the workflow definition to read the retry config, and determines
 * whether to:
 *   - Retry the job via retryJob (when attempt < max_attempts)
 *   - Block or fail the job (when attempt >= max_attempts, using on_exceeded)
 *   - Fail the run directly (for config/permission errors — never retry)
 *
 * Contract:
 *   1. Write step_failed event.
 *   2. If errorType is "config" or "permission": write run_failed event, set
 *      run.status = "failed", return { action: "run_failed" }.
 *   3. Load workflow definition to read JobDefinition.retry config.
 *   4. If attempt < retry.max_attempts: update job to "failed", call retryJob,
 *      return { action: "retried", newAttempt: attempt + 1 }.
 *   5. If attempt >= max_attempts: apply on_exceeded.status (default "blocked"),
 *      write appropriate event (job_blocked / job_failed), set state, and
 *      return { action: "blocked" | "failed" }.
 *
 * Reference:
 *   docs/phases/p13-agent-adapter-hardening/02-development-plan.md §AD-P13-004
 *   docs/mvp-contracts.md §2.3, §2.4
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { nextSequentialEventId } from "../events/sequence.js";
import type { EventWriter, ZigmaFlowEvent } from "../events/index.js";
import type { Clock, RunState } from "../run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { WorkflowDefinition } from "../workflow/index.js";
import { StateError } from "../utils/index.js";
import { retryJob } from "./retryJob.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RecordAgentFailureOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Job identifier that failed. */
  jobId: string;
  /** Step identifier that failed. */
  stepId: string;
  /** Current attempt number (1-based). */
  attempt: number;
  /** Human-readable failure reason. */
  reason: string;
  /**
   * Error classification — determines retry eligibility.
   * - "config" / "permission": never retry — run is failed immediately.
   * - "timeout" / "execution": retryable if attempt < max_attempts.
   */
  errorType?: "config" | "permission" | "timeout" | "execution";
  /** Clock for event timestamps. */
  clock: Clock;
  /** Injectable state store (defaults to LocalStateStore). */
  stateStore?: LocalStateStore;
  /** Injectable event writer (defaults to JsonlEventWriter). */
  eventWriter?: EventWriter;
}

export interface RecordAgentFailureResult {
  /** What the caller (runAll) should do next. */
  action: "retried" | "blocked" | "failed" | "run_failed";
  /** New attempt number when action is "retried". */
  newAttempt?: number;
  /** The status assigned to the job. */
  jobStatus: string;
}

// ---------------------------------------------------------------------------
// Internal: load workflow from run.yml
// ---------------------------------------------------------------------------

interface RunYmlShape {
  workflow?: { path?: string };
}

async function loadWorkflowFromRunYml(runDir: string): Promise<WorkflowDefinition> {
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

  return loadWorkflowFile(wfPath);
}

// ---------------------------------------------------------------------------
// recordAgentFailure
// ---------------------------------------------------------------------------

export async function recordAgentFailure(
  opts: RecordAgentFailureOpts,
): Promise<RecordAgentFailureResult> {
  const {
    runDir,
    runId,
    jobId,
    stepId,
    attempt,
    reason,
    errorType,
    clock,
    stateStore = new LocalStateStore(),
    eventWriter = new JsonlEventWriter(),
  } = opts;

  // -- Read current state snapshot (needed for all paths) -----------------

  const currentState = await stateStore.readSnapshot(runDir);
  if (currentState === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  // -- 1. Write step_failed event -----------------------------------------

  const stepFailedId = await nextSequentialEventId(runDir, eventWriter);
  const stepFailedEvent: ZigmaFlowEvent = {
    id: stepFailedId,
    type: "step_failed",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt,
    payload: {
      job_id: jobId,
      step_id: stepId,
      attempt,
      reason,
    },
  };
  await eventWriter.appendEvent(runDir, stepFailedEvent);

  // -- 2. Config / Permission error ⇒ fail run immediately (no retry) -----

  if (errorType === "config" || errorType === "permission") {
    const runFailedId = await nextSequentialEventId(runDir, eventWriter);
    const runFailedEvent: ZigmaFlowEvent = {
      id: runFailedId,
      type: "run_failed",
      run_id: runId,
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: { reason },
    };
    await eventWriter.appendEvent(runDir, runFailedEvent);

    const failedState: RunState = {
      ...currentState,
      status: "failed" as const,
      last_event_id: runFailedId,
      jobs: {
        ...currentState.jobs,
        [jobId]: {
          ...currentState.jobs[jobId]!,
          status: "failed",
        },
      },
    };
    await stateStore.writeSnapshot(runDir, failedState);

    return { action: "run_failed", jobStatus: "failed" };
  }

  // -- 3. Load workflow definition to read retry config -------------------

  const wf = await loadWorkflowFromRunYml(runDir);
  const jobDef = wf.jobs[jobId];

  const retryConfig = jobDef?.retry;
  const maxAttempts: number =
    retryConfig !== undefined &&
    typeof retryConfig["max_attempts"] === "number"
      ? (retryConfig["max_attempts"] as number)
      : 1;

  // -- 4. Retry if attempt < max_attempts ---------------------------------

  if (attempt < maxAttempts) {
    // Set job status to "failed" so retryJob can validate it as retryable
    const failedJobState: RunState = {
      ...currentState,
      last_event_id: stepFailedId,
      jobs: {
        ...currentState.jobs,
        [jobId]: {
          ...currentState.jobs[jobId]!,
          status: "failed",
        },
      },
    };
    await stateStore.writeSnapshot(runDir, failedJobState);

    // Delegate to retryJob which writes job_retrying event and sets job to ready
    await retryJob({
      runDir,
      runId,
      jobId,
      clock,
      reason,
    });

    return { action: "retried", newAttempt: attempt + 1, jobStatus: "ready" };
  }

  // -- 5. Attempt >= max_attempts — apply on_exceeded ---------------------

  const onExceededStatus: "blocked" | "failed" =
    retryConfig !== undefined &&
    typeof retryConfig["on_exceeded"] === "object" &&
    retryConfig["on_exceeded"] !== null &&
    (retryConfig["on_exceeded"] as Record<string, unknown>)["status"] === "failed"
      ? "failed"
      : "blocked";

  const terminalEventId = await nextSequentialEventId(runDir, eventWriter);

  if (onExceededStatus === "failed") {
    const jobFailedEvent: ZigmaFlowEvent = {
      id: terminalEventId,
      type: "job_failed",
      run_id: runId,
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: { job_id: jobId, reason: reason ?? "max attempts exceeded" },
    };
    await eventWriter.appendEvent(runDir, jobFailedEvent);
  } else {
    const jobBlockedEvent: ZigmaFlowEvent = {
      id: terminalEventId,
      type: "job_blocked",
      run_id: runId,
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: { job_id: jobId, reason: reason ?? "max attempts exceeded" },
    };
    await eventWriter.appendEvent(runDir, jobBlockedEvent);
  }

  const terminalState: RunState = {
    ...currentState,
    status: onExceededStatus,
    last_event_id: terminalEventId,
    jobs: {
      ...currentState.jobs,
      [jobId]: {
        ...currentState.jobs[jobId]!,
        status: onExceededStatus,
      },
    },
  };
  await stateStore.writeSnapshot(runDir, terminalState);

  return { action: onExceededStatus, jobStatus: onExceededStatus };
}
