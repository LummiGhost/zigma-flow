/**
 * Scheduler — pure function for selecting which jobs to execute next.
 *
 * AD-P14-001: Scheduler is a pure function with no IO.
 * AD-P14-002: Writer lock semantics — at most 1 writable job running at a time.
 *
 * Reference:
 *   - docs/phases/p14-concurrent-execution/02-development-plan.md §4
 *   - docs/phases/p14-concurrent-execution/workflows/wf-p14-scheduler/01-cases-and-tests.md
 */

import type { RunState } from "../run/index.js";
import type { WorkflowDefinition } from "../workflow/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  /** Maximum number of jobs allowed to run concurrently. Must be >= 1. */
  parallelism: number;
  /** Hard limit on simultaneously running writable jobs (always 1 per AD-P14-002). */
  runningWritableLimit: 1;
}

export interface SchedulerInput {
  /** The current run state snapshot (already deserialized from state.json). */
  state: RunState;
  /** The parsed workflow definition that owns the jobs. */
  workflow: WorkflowDefinition;
  /** Execution parameters. */
  config: SchedulerConfig;
}

export interface ExecutableBatch {
  /** Jobs that should be executed in this batch (may be empty). */
  jobs: Array<{
    jobId: string;
    mode: "read-only" | "writable";
  }>;
  /** Human-readable explanation of the scheduling decision. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a job's mode from its workflow definition.
 *
 * - workspace.mode === "read-only" → "read-only"
 * - Everything else (undefined, "writable", or any other value) → "writable"
 *
 * This is a conservative default: unless explicitly marked read-only, the
 * scheduler assumes the job may write and therefore must respect the writable
 * lock.
 */
function getJobMode(
  jobId: string,
  workflow: WorkflowDefinition,
): "read-only" | "writable" {
  const jobDef = workflow.jobs[jobId];
  if (!jobDef) {
    // Job not found in workflow definition — treat as writable (conservative).
    return "writable";
  }
  const workspace = jobDef.workspace;
  if (!workspace) {
    // No workspace field — treat as writable (conservative default).
    return "writable";
  }
  return workspace.mode === "read-only" ? "read-only" : "writable";
}

// ---------------------------------------------------------------------------
// selectExecutable
// ---------------------------------------------------------------------------

/**
 * Select which jobs should execute in the next batch.
 *
 * Scheduling rules (applied in order):
 *
 * 1. Collect all jobs with `status === "ready"` from `state.jobs`.
 * 2. Determine if any running job is writable: iterate `state.jobs`, filter
 *    for `status === "running"`, check `workflow.jobs[id].workspace.mode`.
 *    If mode is NOT `"read-only"`, it's writable.
 * 3. Take ready read-only jobs, capped at `parallelism - count_of_running_read_only_jobs`.
 * 4. If read-only count < parallelism AND no writable is running, add at most
 *    1 writable job from ready pool.
 * 5. Return batch with human-readable rationale string.
 *
 * This is a PURE FUNCTION. No IO, no filesystem, no async.
 */
export function selectExecutable(input: SchedulerInput): ExecutableBatch {
  const { state, workflow, config } = input;
  const { parallelism } = config;

  // -----------------------------------------------------------------------
  // Step 2: Classify running jobs — determine writable lock state and count
  // running read-only jobs (they consume parallelism slots).
  // -----------------------------------------------------------------------
  let runningReadOnlyCount = 0;
  let writableRunning = false;

  for (const [id, js] of Object.entries(state.jobs)) {
    if (js.status === "running") {
      if (getJobMode(id, workflow) === "read-only") {
        runningReadOnlyCount++;
      } else {
        writableRunning = true;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 1: Collect ready jobs, classifying by mode.
  // -----------------------------------------------------------------------
  const readyReadOnly: string[] = [];
  const readyWritable: string[] = [];

  for (const [id, js] of Object.entries(state.jobs)) {
    if (js.status === "ready") {
      // Silently skip jobs that have no corresponding JobDefinition (caller
      // should ensure consistency).
      if (!workflow.jobs[id]) {
        continue;
      }
      if (getJobMode(id, workflow) === "read-only") {
        readyReadOnly.push(id);
      } else {
        readyWritable.push(id);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Build the batch
  // -----------------------------------------------------------------------
  const selectedJobs: Array<{ jobId: string; mode: "read-only" | "writable" }> = [];

  // Step 3: Take read-only jobs up to free parallelism slots.
  const effectiveSlots = Math.max(0, parallelism - runningReadOnlyCount);
  const roToTake = Math.min(readyReadOnly.length, effectiveSlots);
  for (let i = 0; i < roToTake; i++) {
    selectedJobs.push({ jobId: readyReadOnly[i]!, mode: "read-only" });
  }

  // Step 4: If slots remain AND no writable is running, add 1 writable.
  const remainingSlots = effectiveSlots - roToTake;
  if (remainingSlots > 0 && !writableRunning && readyWritable.length > 0) {
    selectedJobs.push({ jobId: readyWritable[0]!, mode: "writable" });
  }

  // -----------------------------------------------------------------------
  // Build rationale string
  // -----------------------------------------------------------------------
  let rationale: string;

  if (selectedJobs.length === 0) {
    if (readyReadOnly.length === 0 && readyWritable.length === 0) {
      rationale = "No ready jobs available.";
    } else if (writableRunning) {
      rationale = "Writable lock held; queuing writable jobs.";
    } else {
      rationale = "No free slots available.";
    }
  } else {
    const parts: string[] = [];
    const roIds = selectedJobs
      .filter((j) => j.mode === "read-only")
      .map((j) => j.jobId);
    const wIds = selectedJobs
      .filter((j) => j.mode === "writable")
      .map((j) => j.jobId);

    if (roIds.length > 0) {
      parts.push(`${roIds.length} read-only job(s) selected (${roIds.join(", ")})`);
    }
    if (wIds.length > 0) {
      parts.push(`1 writable job selected (${wIds[0]})`);
    }
    if (writableRunning) {
      parts.push("writable lock held");
    }
    rationale = parts.join("; ");
  }

  return { jobs: selectedJobs, rationale };
}
