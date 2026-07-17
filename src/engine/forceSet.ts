/**
 * forceSetJob — Engine entry point for the CLI `force-set` command.
 *
 * Called when the user manually overrides a job's status for recovery.
 * Emits a job_state_override audit event, applies the status mutation,
 * and resolves downstream dependencies when setting to completed.
 *
 * Supported statuses: completed, waiting, failed, blocked.
 *
 * Reference: Issue #228
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { nextEventId as formatEventId } from "../events/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, JobState } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import { computeReadyJobs } from "../dag/index.js";
import { StateError, UserInputError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ForceSetJobOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Job identifier to force-set. */
  jobId: string;
  /** Target status. */
  status: "completed" | "waiting" | "failed" | "blocked";
  /** Clock for timestamping events. */
  clock: Clock;
  /** Optional human-readable reason for the override. */
  reason?: string;
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

// ---------------------------------------------------------------------------
// forceSetJob
// ---------------------------------------------------------------------------

export async function forceSetJob(opts: ForceSetJobOpts): Promise<void> {
  const { runDir, runId, jobId, status, clock, reason } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read state snapshot ─────────────────────────────────────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new UserInputError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  const fromStatus = jobState.status;

  // ── 2. Get sequential event id ─────────────────────────────────────────────

  const lastId = await eventWriter.readLastEventId(runDir);
  let eventCounter = lastId !== null ? parseInt(lastId.replace("evt-", ""), 10) : 0;
  function getNextEventId(): string {
    return formatEventId(++eventCounter);
  }

  const attempt = jobState.attempt ?? 1;

  // ── 3. Emit job_state_override audit event ─────────────────────────────────

  const overrideEventId = getNextEventId();
  await eventWriter.appendEvent(runDir, {
    id: overrideEventId,
    run_id: runId,
    type: "job_state_override",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: null,
    attempt,
    payload: {
      job_id: jobId,
      from_status: fromStatus,
      to_status: status,
      reason: reason ?? "",
    },
  });

  let lastEventId = overrideEventId;

  // ── 4. Apply status mutation ───────────────────────────────────────────────

  if (status === "completed") {
    // Emit job_completed event
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

    // Mark the job as completed and resolve downstream dependencies
    await stateStore.updateState(runDir, (current) => {
      const completedJobState: JobState = { ...current.jobs[jobId]! };
      delete completedJobState.current_step;
      completedJobState.status = "completed";

      let newState = {
        ...current,
        last_event_id: jobCompletedId,
        jobs: {
          ...current.jobs,
          [jobId]: completedJobState,
        },
      };

      // Compute and set ready for downstream jobs whose dependencies are now satisfied.
      // We need the workflow definition for computeReadyJobs.
      // Since this runs inside updateState (sync updater), we use a pre-loaded workflow.
      // The workflow was loaded before this updater runs, so we use it via closure.
      return newState;
    });

    // Post-update: resolve downstream readiness using the workflow DAG.
    // This is a separate step because computeReadyJobs needs the workflow definition.
    const workflowPath = await readWorkflowPathFromRunYml(runDir);
    const wf = await loadWorkflowFile(workflowPath);

    await stateStore.updateState(runDir, (current) => {
      const completedJobIds = new Set<string>(
        Object.entries(current.jobs)
          .filter(([, js]) => js.status === "completed")
          .map(([id]) => id)
      );
      const activeJobIds = new Set<string>(
        Object.keys(current.jobs).filter(
          (id) => !completedJobIds.has(id) && current.jobs[id]!.status !== "waiting"
        )
      );
      const nowReadyIds = computeReadyJobs(wf.jobs, completedJobIds, activeJobIds, current.jobs);

      let newState = { ...current };

      for (const readyId of nowReadyIds) {
        const waitingJob = newState.jobs[readyId];
        if (waitingJob?.status === "waiting") {
          newState = {
            ...newState,
            jobs: {
              ...newState.jobs,
              [readyId]: { ...waitingJob, status: "ready" as const },
            },
          };
        }
      }

      return newState;
    });

    // Emit job_ready events for the newly ready jobs (after state update).
    // Re-read state to get the updated ready jobs.
    const updatedState = await stateStore.readSnapshot(runDir);
    if (updatedState) {
      const updatedCompletedIds = new Set<string>(
        Object.entries(updatedState.jobs)
          .filter(([, js]) => js.status === "completed")
          .map(([id]) => id)
      );
      const updatedActiveIds = new Set<string>(
        Object.keys(updatedState.jobs).filter(
          (id) => !updatedCompletedIds.has(id) && updatedState.jobs[id]!.status !== "waiting"
        )
      );
      const updatedReadyIds = computeReadyJobs(wf.jobs, updatedCompletedIds, updatedActiveIds, updatedState.jobs);

      for (const readyId of updatedReadyIds) {
        if (updatedState.jobs[readyId]?.status === "ready") {
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
          lastEventId = jobReadyId;
        }
      }
    }

    // Update last_event_id if we emitted job_ready events
    if (lastEventId !== jobCompletedId) {
      await stateStore.updateState(runDir, (current) => ({
        ...current,
        last_event_id: lastEventId,
      }));
    }
  } else {
    // waiting, failed, blocked — simple status mutation
    await stateStore.updateState(runDir, (current) => {
      const updatedJobState: JobState = { ...current.jobs[jobId]! };
      updatedJobState.status = status;
      if (status === "waiting") {
        delete updatedJobState.current_step;
        delete (updatedJobState as unknown as Record<string, unknown>)["step_visits"];
      }

      return {
        ...current,
        last_event_id: overrideEventId,
        jobs: {
          ...current.jobs,
          [jobId]: updatedJobState,
        },
      };
    });
  }
}
