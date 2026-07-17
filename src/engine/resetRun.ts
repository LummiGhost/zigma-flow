/**
 * resetRun — Engine entry point for the CLI `reset-run <run-id>` command.
 *
 * Resets a stuck/errored run's state machine to the most recent valid state,
 * allowing it to be resumed. Called by the reset-run command after the user
 * confirms the operation (or --force is supplied).
 *
 * Contract:
 *   1. Read state snapshot + load workflow from run.yml.
 *   2. For each job:
 *      - running, failed → reset to "waiting", emit job_reset event.
 *      - blocked → reset to "waiting", emit job_reset event.
 *      - completed, done, inactive → skip (no change).
 *      - ready, waiting → skip (no change).
 *   3. Recompute DAG readiness: any waiting job whose needs are all satisfied
 *      (all upstream completed/skipped) → mark "ready", emit job_ready.
 *   4. If the run status is a terminal/error state (failed, completed,
 *      cancelled, blocked, paused), reset it to "running".
 *   5. If dryRun is true, return the result without writing to disk.
 *   6. Otherwise, emit events and write state.
 *
 * Reference: GitHub Issue #237
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { computeReadyJobs } from "../dag/index.js";
import { nextEventId as formatEventId } from "../events/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, JobState, RunState } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import { StateError, UserInputError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ResetRunOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Clock for timestamping events. */
  clock: Clock;
  /** If true, compute what would change without applying. */
  dryRun?: boolean;
}

export interface ResetRunResult {
  /** Number of jobs that were reset to waiting. */
  jobsReset: number;
  /** Number of jobs that became ready after DAG recomputation. */
  jobsReady: number;
  /** Whether the run status was changed (e.g. from failed to running). */
  runStatusChanged: boolean;
  /** The run status before reset (if it was changed). */
  previousRunStatus?: RunState["status"];
  /** Per-job details for dry-run / summary display. */
  jobChanges: ResetJobChange[];
}

export interface ResetJobChange {
  jobId: string;
  fromStatus: string;
  toStatus: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Job statuses that are reset to "waiting". */
const RESETTABLE_STATUSES = new Set<JobState["status"]>([
  "running",
  "failed",
  "blocked",
]);

/** Job statuses that are left unchanged. */
const SKIP_STATUSES = new Set<JobState["status"]>([
  "completed",
  "done",
  "inactive",
  "ready",
  "waiting",
]);

/** Run statuses considered terminal or error — reset to "running". */
const TERMINAL_RUN_STATUSES = new Set<RunState["status"]>([
  "failed",
  "completed",
  "cancelled",
  "blocked",
  "paused",
]);

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
    throw new StateError(`run.yml contains invalid YAML in: ${runDir}`, {
      cause: e,
    });
  }

  const shape = parsed as RunYmlShape;
  const wfPath = shape?.workflow?.path;
  if (typeof wfPath !== "string" || wfPath.length === 0) {
    throw new StateError(`run.yml is missing workflow.path in: ${runDir}`);
  }
  return wfPath;
}

// ---------------------------------------------------------------------------
// resetRun
// ---------------------------------------------------------------------------

export async function resetRun(opts: ResetRunOpts): Promise<ResetRunResult> {
  const { runDir, runId, clock, dryRun } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read state snapshot ─────────────────────────────────────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  // ── 2. Load workflow for DAG recomputation ─────────────────────────────────

  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  // ── 3. Validate that at least one job is resettable ─────────────────────────

  const resettableJobs = Object.entries(state.jobs).filter(([, js]) =>
    RESETTABLE_STATUSES.has(js.status)
  );

  if (resettableJobs.length === 0) {
    throw new UserInputError(
      `Run ${runId} has no jobs in a resettable state (running, failed, or blocked). Nothing to reset.`,
      { details: { runId } }
    );
  }

  // ── 4. Compute job changes ─────────────────────────────────────────────────

  const jobChanges: ResetJobChange[] = [];

  // Build the new jobs map: reset running/failed/blocked → waiting;
  // keep completed/done/inactive/ready/waiting unchanged.
  const newJobs: Record<string, JobState> = {};
  for (const [jobId, js] of Object.entries(state.jobs)) {
    if (RESETTABLE_STATUSES.has(js.status)) {
      jobChanges.push({
        jobId,
        fromStatus: js.status,
        toStatus: "waiting",
      });
      const resetJob: JobState = { status: "waiting" };
      // Preserve activation for inactive-eligible jobs (blocked jobs that were
      // previously activated retain their activation metadata).
      if (js.activation !== undefined) {
        resetJob.activation = js.activation;
      }
      if (js.activated !== undefined) {
        resetJob.activated = js.activated;
      }
      if (js.activation_reason !== undefined) {
        resetJob.activation_reason = js.activation_reason;
      }
      newJobs[jobId] = resetJob;
    } else {
      // Keep unchanged — but validate it's a known skip status
      if (!SKIP_STATUSES.has(js.status)) {
        throw new StateError(
          `Job "${jobId}" has unexpected status "${js.status}" — cannot determine reset behavior`,
          { details: { jobId, status: js.status } }
        );
      }
      newJobs[jobId] = { ...js };
    }
  }

  // ── 5. Recompute DAG readiness ────────────────────────────────────────────

  const completedJobIds = new Set<string>(
    Object.entries(newJobs)
      .filter(([, js]) => js.status === "completed" || js.status === "done")
      .map(([id]) => id)
  );
  const activeJobIds = new Set<string>(
    Object.entries(newJobs)
      .filter(
        ([id, js]) =>
          js.status === "ready" || js.status === "running" || js.status === "blocked"
      )
      .map(([id]) => id)
  );

  const nowReadyIds = computeReadyJobs(wf.jobs, completedJobIds, activeJobIds, newJobs);

  // Apply readiness to waiting jobs that are now eligible
  let jobsReady = 0;
  for (const readyId of nowReadyIds) {
    const js = newJobs[readyId];
    if (js?.status === "waiting") {
      newJobs[readyId] = { ...js, status: "ready" };
      jobsReady++;
    }
  }

  // ── 6. Determine run status change ────────────────────────────────────────

  let runStatusChanged = false;
  let previousRunStatus: RunState["status"] | undefined;
  let newRunStatus: RunState["status"] | undefined;

  if (state.status !== undefined && TERMINAL_RUN_STATUSES.has(state.status)) {
    previousRunStatus = state.status;
    newRunStatus = "running";
    runStatusChanged = true;
  } else if (state.status === undefined || state.status === "running") {
    // Already running or no status — no change needed for the run status.
    // Keep the existing status.
  }

  // ── 7. Dry-run guard: return result without writing ────────────────────────

  if (dryRun) {
    return {
      jobsReset: jobChanges.length,
      jobsReady,
      runStatusChanged,
      previousRunStatus,
      jobChanges,
    };
  }

  // ── 8. Emit events and write state ─────────────────────────────────────────

  const lastId = await eventWriter.readLastEventId(runDir);
  let eventCounter =
    lastId !== null ? parseInt(lastId.replace("evt-", ""), 10) : 0;
  function getNextEventId(): string {
    return formatEventId(++eventCounter);
  }

  // Emit job_reset events for each reset job
  for (const change of jobChanges) {
    const jobState = state.jobs[change.jobId]!;
    const eventId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: eventId,
      run_id: runId,
      type: "job_reset",
      timestamp: clock.now(),
      producer: "engine",
      job: change.jobId,
      step: null,
      attempt: jobState.attempt ?? null,
      payload: {
        job_id: change.jobId,
        from_status: change.fromStatus,
        to_status: change.toStatus,
        reason: "reset-run command",
      },
    });
  }

  // Emit job_ready events for newly-ready jobs
  for (const readyId of nowReadyIds) {
    if (newJobs[readyId]?.status === "ready") {
      const eventId = getNextEventId();
      await eventWriter.appendEvent(runDir, {
        id: eventId,
        run_id: runId,
        type: "job_ready",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { job_id: readyId },
      });
    }
  }

  // ── 9. Write updated state ─────────────────────────────────────────────────

  const lastEventId = formatEventId(eventCounter);

  await stateStore.updateState(runDir, (current) => {
    const updatedJobs: Record<string, JobState> = { ...current.jobs };
    for (const change of jobChanges) {
      const existing = current.jobs[change.jobId];
      if (existing) {
        updatedJobs[change.jobId] = {
          ...existing,
          status: "waiting",
        };
        delete updatedJobs[change.jobId]!.current_step;
        delete updatedJobs[change.jobId]!.attempt;
        delete (updatedJobs[change.jobId] as unknown as Record<string, unknown>)["step_visits"];
      }
    }
    // Apply readiness from DAG
    for (const readyId of nowReadyIds) {
      if (updatedJobs[readyId]?.status === "waiting") {
        updatedJobs[readyId] = {
          ...updatedJobs[readyId]!,
          status: "ready",
        };
      }
    }

    const updated: RunState = {
      ...current,
      last_event_id: lastEventId,
      jobs: updatedJobs,
    };

    if (runStatusChanged) {
      updated.status = "running";
    }

    return updated;
  });

  return {
    jobsReset: jobChanges.length,
    jobsReady,
    runStatusChanged,
    previousRunStatus,
    jobChanges,
  };
}
