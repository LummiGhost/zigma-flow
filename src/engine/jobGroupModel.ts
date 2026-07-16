/**
 * Job Group Iteration Model — pure helper functions for WF-7.2.
 *
 * Contains stateless, side-effect-free functions for job group iteration
 * lifecycle management, repeat config resolution, and group state transitions.
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/research/r2-job-group-dag.md
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.2-job-group/01-cases-and-tests.md
 */

import type {
  IterationState,
  JobGroupState,
  JobGroupDefinition,
  RepeatConfig,
  RunState,
} from "../run/index.js";

// ---------------------------------------------------------------------------
// RepeatConfig resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective RepeatConfig with defaults applied.
 * max_iterations defaults to 1 when not specified.
 */
export function resolveRepeatConfig(raw?: Partial<RepeatConfig>): RepeatConfig {
  const result: RepeatConfig = { max_iterations: raw?.max_iterations ?? 1 };
  if (raw?.until !== undefined) {
    result.until = raw.until;
  }
  return result;
}

// ---------------------------------------------------------------------------
// IterationState factories
// ---------------------------------------------------------------------------

/**
 * Create an open IterationState record (no completed_at, no job_outputs yet).
 */
export function createIterationState(
  index: number,
  started_at: string,
  job_ids: string[],
): IterationState {
  return { index, started_at, job_ids };
}

/**
 * Seal a completed IterationState by adding completed_at and job_outputs.
 */
export function sealIteration(
  iteration: IterationState,
  completed_at: string,
  job_outputs: Record<string, Record<string, unknown>>,
): IterationState {
  return { ...iteration, completed_at, job_outputs };
}

// ---------------------------------------------------------------------------
// JobGroupState factories
// ---------------------------------------------------------------------------

/**
 * Initialize a JobGroupState from its definition.
 */
export function createJobGroupState(
  group_id: string,
  max_iterations: number,
): JobGroupState {
  return {
    group_id,
    status: "pending",
    current_iteration: 0,
    iterations: [],
    iterations_remaining: max_iterations,
  };
}

/**
 * Create a JobGroupState from a JobGroupDefinition.
 */
export function createJobGroupStateFromDef(
  group_id: string,
  def: JobGroupDefinition,
): JobGroupState {
  const resolved = resolveRepeatConfig(def.repeat);
  return createJobGroupState(group_id, resolved.max_iterations);
}

/**
 * Initialize all job_groups from a workflow definition.
 * Returns a record of group_id -> JobGroupState.
 */
export function initializeJobGroups(
  jobGroups?: Record<string, JobGroupDefinition>,
): Record<string, JobGroupState> | undefined {
  if (!jobGroups || Object.keys(jobGroups).length === 0) return undefined;
  const groups: Record<string, JobGroupState> = {};
  for (const [groupId, def] of Object.entries(jobGroups)) {
    groups[groupId] = createJobGroupStateFromDef(groupId, def);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Group iteration lifecycle
// ---------------------------------------------------------------------------

/**
 * Advance a group to the next iteration. Returns the new group state.
 */
export function startNextIteration(
  group: JobGroupState,
  started_at: string,
  job_ids: string[],
): JobGroupState {
  const nextIndex = group.current_iteration + 1;
  const newIteration = createIterationState(nextIndex, started_at, job_ids);
  return {
    ...group,
    status: "iterating",
    current_iteration: nextIndex,
    iterations: [...group.iterations, newIteration],
    iterations_remaining: Math.max(0, group.iterations_remaining - 1),
  };
}

/**
 * Complete the current iteration and evaluate repeat config.
 * Returns { group, stopReason } where stopReason is null if iteration should continue.
 */
export function completeCurrentIteration(
  group: JobGroupState,
  completed_at: string,
  job_outputs: Record<string, Record<string, unknown>>,
  repeat: RepeatConfig,
): { group: JobGroupState; stopReason: string | null } {
  const currentIter = group.iterations[group.iterations.length - 1];
  if (!currentIter) {
    throw new Error("No current iteration to complete");
  }
  const sealed = sealIteration(currentIter, completed_at, job_outputs);
  const iterations = [
    ...group.iterations.slice(0, -1),
    sealed,
  ];

  let stopReason: string | null = null;

  // Check max_iterations
  if (group.current_iteration >= repeat.max_iterations) {
    stopReason = "max_reached";
  }

  const newStatus: JobGroupState["status"] =
    stopReason === "max_reached" ? "completed" : "iterating";

  return {
    group: {
      ...group,
      status: newStatus,
      iterations,
    },
    stopReason,
  };
}

/**
 * Mark a group as completed (final state).
 */
export function finalizeGroup(group: JobGroupState): JobGroupState {
  return { ...group, status: "completed", iterations_remaining: 0 };
}

/**
 * Mark a group as blocked.
 */
export function blockGroup(group: JobGroupState, _reason: string): JobGroupState {
  return { ...group, status: "blocked" };
}

/**
 * Mark a group as failed.
 */
export function failGroup(group: JobGroupState, _reason: string): JobGroupState {
  return { ...group, status: "failed" };
}

// ---------------------------------------------------------------------------
// Group-level DAG readiness
// ---------------------------------------------------------------------------

/**
 * Check whether a group is ready to proceed based on its group-level needs.
 * A group is ready when all upstream groups it depends on are in a terminal
 * status (completed, failed, or blocked).
 */
export function isGroupReady(
  groupId: string,
  groupNeeds: Record<string, string[] | undefined>,
  groups: Record<string, JobGroupState>,
): boolean {
  const needs = groupNeeds[groupId];
  if (!needs || needs.length === 0) return true;

  const terminalStatuses: JobGroupState["status"][] = ["completed", "failed", "blocked"];
  return needs.every((upstreamId) => {
    const upstream = groups[upstreamId];
    if (!upstream) return false;
    return (terminalStatuses as readonly JobGroupState["status"][]).includes(upstream.status);
  });
}

/**
 * Filter jobs to only include those whose groups are ready.
 * Jobs without a group are always considered ready (no group constraint).
 */
export function filterReadyGroupJobs(
  state: RunState,
  jobIds: string[],
): string[] {
  const groups = state.job_groups;
  if (!groups) return jobIds; // No groups — all jobs are ready

  return jobIds.filter((jobId) => {
    const js = state.jobs[jobId];
    if (!js?.group) return true; // No group — always ready
    const group = groups[js.group];
    if (!group) return true; // Group not found — allow through (defensive)
    // A group can start iterating if it's pending and ready, or already iterating
    return group.status === "pending" || group.status === "iterating";
  });
}

// ---------------------------------------------------------------------------
// Group conclusion derivation
// ---------------------------------------------------------------------------

/**
 * Derive the terminal status for a group based on its repeat config
 * and current state.
 */
export function deriveGroupConclusion(
  groupState: JobGroupState,
  _repeatConfig: RepeatConfig,
): "completed" | "failed" | "blocked" {
  if (groupState.iterations.length > 0) {
    return "completed";
  }
  return "blocked";
}

// ---------------------------------------------------------------------------
// Implicit group creation (backward compat)
// ---------------------------------------------------------------------------

/**
 * Create an implicit JobGroupState for backward compatibility.
 * Used when goto_step/goto_job is triggered on an ungrouped job.
 *
 * @param jobId - the source job id
 * @param targetJobId - optional target job for goto_job (for naming)
 * @param maxVisits - optional max_visits to map to max_iterations
 */
export function createImplicitGroup(
  jobId: string,
  targetJobId?: string,
  maxVisits?: number,
): { groupId: string; groupState: JobGroupState } {
  const groupId = targetJobId && targetJobId !== jobId
    ? `__implicit__${jobId}__${targetJobId}`
    : `__implicit__${jobId}`;
  const maxIterations = maxVisits ?? 3;
  const groupState = createJobGroupState(groupId, maxIterations);
  return { groupId, groupState };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Check if a step in any job has goto_step/goto_job/max_visits while also
 * having an explicit group. Returns an array of error messages.
 */
export function detectGroupConflicts(
  jobs: Record<string, import("../workflow/index.js").StepDefinition[]>,
): string[] {
  const errors: string[] = [];
  for (const [jobName, steps] of Object.entries(jobs)) {
    for (const step of steps) {
      // Check max_visits
      if (step.max_visits !== undefined) {
        void step;
      }
      // Check goto_step/goto_job in router actions
      if (step.type === "router" && step.cases) {
        for (const [caseName, action] of Object.entries(step.cases)) {
          if (typeof action === "object" && action !== null) {
            if ("goto_step" in action || "goto_job" in action) {
              void caseName;
            }
          }
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Evaluate until condition (stub for green phase)
// ---------------------------------------------------------------------------

/**
 * Evaluate an `until` condition expression against iteration context.
 *
 * This is a stub that returns false (continue iterating) for the green phase.
 * Full implementation with evaluateCondition integration is in the engine.
 */
export function evaluateUntilCondition(
  _condition: string,
  _jobOutputs: Record<string, Record<string, unknown>>,
): boolean {
  // Stub: in the engine, this calls evaluateCondition with the
  // appropriate expression context built from iteration job outputs.
  return false;
}

// ---------------------------------------------------------------------------
// Snapshot job outputs from an iteration
// ---------------------------------------------------------------------------

/**
 * Collect job outputs from the current iteration into a snapshot record.
 */
export function snapshotIterationOutputs(
  state: RunState,
  jobIds: string[],
): Record<string, Record<string, unknown>> {
  const outputs: Record<string, Record<string, unknown>> = {};
  for (const jobId of jobIds) {
    const js = state.jobs[jobId];
    if (js?.outputs) {
      outputs[jobId] = { ...js.outputs };
    }
  }
  return outputs;
}
