/**
 * Managed-workspace finalize gate — M4.
 *
 * Runs the `beforeJobCompleted` hook (commit + integrate of the attempt
 * workspace) immediately BEFORE a job is sealed as completed, across every
 * job-completion path: appendJobCompleted (agent steps) and the script /
 * check / router executors (which write the completed transition in-process).
 *
 * When the hook fails, the completion is converted into a typed job failure
 * (attempt_failed + job_failed events, attempt sealed as failure, job marked
 * "failed") and the caller MUST NOT write the completed transition. This
 * preserves the crash invariant: a job observed as "completed" in state
 * always implies its finalize succeeded, so resume never re-finalizes.
 *
 * This module deliberately imports nothing from the engine layer: the
 * executors (script/check/router) import it directly without creating an
 * import cycle through engine/index.ts.
 */

import type { Clock, JsonlEventWriter, LocalStateStore } from "../run/index.js";

export type BeforeJobCompleted = (opts: { jobId: string; attempt: number }) => Promise<
  { ok: true } | { ok: false; reason: string; failureKind: string }
>;

export interface JobCompletionFinalizeOpts {
  runDir: string;
  runId: string;
  jobId: string;
  attempt: number;
  clock: Clock;
  stateStore: LocalStateStore;
  eventWriter: JsonlEventWriter;
  /**
   * Event-id allocator matching the enclosing completion path: the engine
   * path uses the sequential allocator, executors use their in-process
   * counter (both produce "evt-NNN" ids).
   */
  allocateEventId: () => string | Promise<string>;
  beforeJobCompleted?: BeforeJobCompleted;
}

/**
 * Returns `true` when the caller may proceed to seal the job completed.
 * On `false` the job has been transitioned to "failed" (events + state) by
 * this function and the caller must stop the completion path.
 */
export async function finalizeJobCompletion(
  opts: JobCompletionFinalizeOpts,
): Promise<boolean> {
  if (opts.beforeJobCompleted === undefined) return true;

  const outcome = await opts.beforeJobCompleted({
    jobId: opts.jobId,
    attempt: opts.attempt,
  });
  if (outcome.ok) return true;

  const { runDir, runId, jobId, attempt, clock, stateStore, eventWriter } = opts;
  const transitionTimestamp = clock.now();

  const attemptFailedId = await opts.allocateEventId();
  await eventWriter.appendEvent(runDir, {
    id: attemptFailedId,
    run_id: runId,
    type: "attempt_failed",
    timestamp: transitionTimestamp,
    producer: "engine",
    job: jobId,
    step: null,
    attempt,
    payload: {
      job_id: jobId,
      attempt,
      failure_kind: outcome.failureKind,
      reason: outcome.reason,
      step_count: 0,
      duration_ms: 0,
    },
  });

  const jobFailedId = await opts.allocateEventId();
  await eventWriter.appendEvent(runDir, {
    id: jobFailedId,
    run_id: runId,
    type: "job_failed",
    timestamp: transitionTimestamp,
    producer: "engine",
    job: jobId,
    step: null,
    attempt,
    payload: {
      job_id: jobId,
      reason: outcome.reason,
      failure_kind: outcome.failureKind,
    },
  });

  await stateStore.updateState(runDir, (current) => {
    const failedJobState = { ...current.jobs[jobId]! };
    delete failedJobState.current_step;
    failedJobState.status = "failed";
    if (failedJobState.attempts && failedJobState.attempts.length > 0) {
      const lastIdx = failedJobState.attempts.length - 1;
      const lastAttempt = failedJobState.attempts[lastIdx]!;
      if (!lastAttempt.status) {
        failedJobState.attempts = [
          ...failedJobState.attempts.slice(0, lastIdx),
          {
            ...lastAttempt,
            status: "failure" as const,
            ended_at: transitionTimestamp,
            failure_kind: outcome.failureKind,
            failure_reason: outcome.reason,
          },
        ];
      }
    }
    return {
      ...current,
      last_event_id: jobFailedId,
      jobs: { ...current.jobs, [jobId]: failedJobState },
    };
  });

  return false;
}
