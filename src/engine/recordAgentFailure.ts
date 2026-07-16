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
import type { Clock } from "../run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { WorkflowDefinition } from "../workflow/index.js";
import { StateError } from "../utils/index.js";
import { retryJob } from "./retryJob.js";
import { classifyFailureKind } from "./attemptModel.js";
import { AttemptOutcome, JobConclusion } from "../run/index.js";
import type { Attempt } from "../run/index.js";
import { computeJobConclusion } from "./outcomeModel.js";

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
  action: "retried" | "blocked" | "failed" | "run_failed" | "continue";
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
    // WF-7.1: Seal the last open attempt as failure
    let lastEventId = stepFailedId;
    const currentJobState = currentState.jobs[jobId];
    if (currentJobState?.attempts && currentJobState.attempts.length > 0) {
      const lastIdx = currentJobState.attempts.length - 1;
      const lastAttempt = currentJobState.attempts[lastIdx]!;
      if (!lastAttempt.status) {
        const attemptFailedId = await nextSequentialEventId(runDir, eventWriter);
        await eventWriter.appendEvent(runDir, {
          id: attemptFailedId,
          run_id: runId,
          type: "attempt_failed",
          timestamp: clock.now(),
          producer: "engine",
          job: jobId,
          step: stepId,
          attempt,
          payload: {
            job_id: jobId,
            attempt,
            failure_kind: classifyFailureKind(errorType),
            reason,
            step_count: lastAttempt.step_count ?? 0,
            duration_ms: 0,
          },
        });
        lastEventId = attemptFailedId;
      }
    }

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

    // WF-7.1: Store sealed attempt in state
    await stateStore.updateState(runDir, (current) => {
      const updatedJob = { ...current.jobs[jobId]! };
      updatedJob.status = "failed";
      if (updatedJob.attempts && updatedJob.attempts.length > 0) {
        const li = updatedJob.attempts.length - 1;
        const la = updatedJob.attempts[li]!;
        if (!la.status) {
          updatedJob.attempts = [
            ...updatedJob.attempts.slice(0, li),
            { ...la, status: "failure" as const, ended_at: clock.now() },
          ];
        }
      }
      return {
        ...current,
        status: "failed",
        last_event_id: runFailedId,
        jobs: { ...current.jobs, [jobId]: updatedJob },
      };
    });

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
    await stateStore.updateState(runDir, (current) => ({
      ...current,
      last_event_id: stepFailedId,
      jobs: {
        ...current.jobs,
        [jobId]: {
          ...current.jobs[jobId]!,
          status: "failed",
        },
      },
    }));

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

  // -- 5. Attempt >= max_attempts — apply failure_policy (WF-7.3b) ---------

  // Read the failure_policy from the job definition (default: "fail")
  const failurePolicy: "fail" | "continue" | "block" =
    jobDef?.failure_policy ?? "fail";

  // Read on_exceeded.status for the job-level terminal status (backward compat)
  const onExceededStatus: "blocked" | "failed" =
    retryConfig !== undefined &&
    typeof retryConfig["on_exceeded"] === "object" &&
    retryConfig["on_exceeded"] !== null &&
    (retryConfig["on_exceeded"] as Record<string, unknown>)["status"] === "failed"
      ? "failed"
      : "blocked";

  // Build attempt outcomes for computeJobConclusion
  const jobStateForSeal = currentState.jobs[jobId];
  // WF-7.1: Seal the last open attempt as failure before terminal event
  let lastEventIdBeforeTerminal = stepFailedId;
  let sealedAttempts: Attempt[] = [];

  if (jobStateForSeal?.attempts && jobStateForSeal.attempts.length > 0) {
    sealedAttempts = [...jobStateForSeal.attempts];
    const lastIdx = sealedAttempts.length - 1;
    const lastAttempt = sealedAttempts[lastIdx]!;
    if (!lastAttempt.status) {
      const attemptFailedId = await nextSequentialEventId(runDir, eventWriter);
      await eventWriter.appendEvent(runDir, {
        id: attemptFailedId,
        run_id: runId,
        type: "attempt_failed",
        timestamp: clock.now(),
        producer: "engine",
        job: jobId,
        step: stepId,
        attempt,
        payload: {
          job_id: jobId,
          attempt,
          failure_kind: classifyFailureKind(errorType),
          reason: reason ?? "max attempts exceeded",
          step_count: lastAttempt.step_count ?? 0,
          duration_ms: 0,
        },
      });
      lastEventIdBeforeTerminal = attemptFailedId;

      // Build sealed attempt with failure status
      sealedAttempts[lastIdx] = {
        ...lastAttempt,
        status: "failure" as const,
        ended_at: clock.now(),
        failure_kind: classifyFailureKind(errorType),
        failure_reason: reason ?? "max attempts exceeded",
      };
    }

    // Determine terminal conclusion from failure policy via computeJobConclusion
    const terminalConclusion = computeJobConclusion(
      sealedAttempts.map((a) => {
        if (a.status === "success") return { outcome: AttemptOutcome.Success };
        if (a.status === "cancelled") return { outcome: AttemptOutcome.Cancelled };
        return { outcome: AttemptOutcome.Failure };
      }),
      failurePolicy,
    );

    const terminalEventId = await nextSequentialEventId(runDir, eventWriter);

    if (terminalConclusion === JobConclusion.SuccessWithWarnings) {
      // failure_policy: "continue" — job failed but run continues
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

      // Set job status but do NOT prematurely set run status (reconciliation handles it)
      await stateStore.updateState(runDir, (current) => ({
        ...current,
        last_event_id: terminalEventId,
        jobs: { ...current.jobs, [jobId]: { ...current.jobs[jobId]!, status: "failed" as const, attempts: sealedAttempts } },
      }));

      return { action: "continue" as const, jobStatus: "failed" };
    }

    // Fail or Block policy — job-level status determined by onExceededStatus
    // (backward compat: default on_exceeded maps to "blocked")
    const terminalStatus: "blocked" | "failed" =
      terminalConclusion === JobConclusion.Blocked
        ? "blocked"
        : onExceededStatus;

    if (terminalStatus === "failed") {
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

    await stateStore.updateState(runDir, (current) => ({
      ...current,
      status: terminalStatus,
      last_event_id: terminalEventId,
      jobs: { ...current.jobs, [jobId]: { ...current.jobs[jobId]!, status: terminalStatus, attempts: sealedAttempts } },
    }));

    return { action: terminalStatus, jobStatus: terminalStatus };
  }

  // Fallback: no attempts to seal (should not happen, but defensive)
  const terminalEventId = await nextSequentialEventId(runDir, eventWriter);
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

  await stateStore.updateState(runDir, (current) => ({
    ...current,
    status: "failed",
    last_event_id: terminalEventId,
    jobs: { ...current.jobs, [jobId]: { ...current.jobs[jobId]!, status: "failed" } },
  }));

  return { action: "failed", jobStatus: "failed" };
}
