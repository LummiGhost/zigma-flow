/**
 * DAG pure-function module for WF-P3-DAG.
 *
 * This module MUST NOT import from the file system, commander, execa,
 * simple-git, or any infrastructure adapter. It only consumes
 * JobDefinition-shaped data produced by src/workflow/index.ts.
 *
 * Reference: docs/prd.md FR-002 (RC-07, RC-08)
 *   docs/architecture.md §5.2 (dag module boundary), §6.2
 *   docs/mvp-contracts.md §2.1 Workflow Contract, §4 DoD
 *   docs/phases/p3-run/workflows/wf-p3-dag/01-cases-and-tests.md
 */

// ---------------------------------------------------------------------------
// Type definition
// ---------------------------------------------------------------------------

export interface DagJobs {
  [jobId: string]: {
    needs?: string[];
    optional_needs?: string[];
    /**
     * Job activation mode. Jobs with `activation: optional` or
     * `activation: manual` (v0.6: manual is treated as optional)
     * start as inactive and can be activated at runtime.
     */
    activation?: string;
    /** Failure policy (WF-7.3b). Default: "fail". */
    failure_policy?: "fail" | "continue" | "block";
  };
}

// ---------------------------------------------------------------------------
// validateNeedsReferences (RC-07)
// ---------------------------------------------------------------------------

/**
 * Validates that every id listed in `needs` and `optional_needs` of every job
 * exists as a key in the `jobs` map.
 *
 * Returns `{ valid: true, errors: [] }` when all references resolve.
 * Returns `{ valid: false, errors: [...] }` with one entry per missing reference.
 * Does NOT stop at the first error — all missing references are collected.
 */
export function validateNeedsReferences(
  jobs: DagJobs
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const jobIds = new Set(Object.keys(jobs));

  for (const [jobId, jobDef] of Object.entries(jobs)) {
    for (const dep of jobDef.needs ?? []) {
      if (!jobIds.has(dep)) {
        errors.push(
          `Job "${jobId}" has a needs reference to "${dep}" which does not exist`
        );
      }
    }
    for (const dep of jobDef.optional_needs ?? []) {
      if (!jobIds.has(dep)) {
        errors.push(
          `Job "${jobId}" has an optional_needs reference to "${dep}" which does not exist`
        );
      }
    }
  }

  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// detectCycles (RC-08)
// ---------------------------------------------------------------------------

type Color = "white" | "grey" | "black";

/**
 * Detects cycles in the hard-dependency (`needs`) graph using DFS with
 * white/grey/black color marking.
 *
 * - `optional_needs` edges are completely ignored.
 * - Returns `null` if the graph is acyclic.
 * - Returns an array of cycle paths (each path is an ordered list of job ids)
 *   if one or more cycles are found.
 */
export function detectCycles(jobs: DagJobs): string[][] | null {
  const color = new Map<string, Color>();

  for (const jobId of Object.keys(jobs)) {
    color.set(jobId, "white");
  }

  const cycles: string[][] = [];

  function dfs(nodeId: string, stack: string[]): void {
    color.set(nodeId, "grey");
    stack.push(nodeId);

    const jobDef = jobs[nodeId];
    const neighbors = jobDef?.needs ?? [];

    for (const neighborId of neighbors) {
      const neighborColor = color.get(neighborId);

      if (neighborColor === "grey") {
        // Found a cycle — extract the cycle path from the stack.
        // We break after recording the first back-edge per frame; the normal
        // cleanup (pop + blacken) still runs after the loop.  This is sufficient
        // for the binary cycle/no-cycle signal that loadWorkflow requires.
        const cycleStart = stack.indexOf(neighborId);
        const cyclePath =
          cycleStart >= 0
            ? [...stack.slice(cycleStart), neighborId]
            : [neighborId, neighborId];
        cycles.push(cyclePath);
        break;
      } else if (neighborColor === "white") {
        dfs(neighborId, stack);
      }
      // black = already fully processed, no cycle through this node
    }

    stack.pop();
    color.set(nodeId, "black");
  }

  for (const jobId of Object.keys(jobs)) {
    if (color.get(jobId) === "white") {
      dfs(jobId, []);
    }
  }

  return cycles.length === 0 ? null : cycles;
}

// ---------------------------------------------------------------------------
// computeReadyJobs
// ---------------------------------------------------------------------------

/**
 * Returns the ids of jobs that are currently eligible to start:
 *   1. Not in `completedJobIds`
 *   2. Not in `activeJobIds`
 *   3. Every id in `needs` is in `completedJobIds`, OR is an inactive
 *      optional job (activation: optional | manual) that has not been
 *      activated yet.
 *   4. `optional_needs` are ignored for readiness (they never block)
 *
 * Order of the returned array is not guaranteed.
 */
export function computeReadyJobs(
  jobs: DagJobs,
  completedJobIds: Set<string>,
  activeJobIds: Set<string>,
  stateJobs?: Record<string, { status: string }>,
): string[] {
  const ready: string[] = [];

  for (const [jobId, jobDef] of Object.entries(jobs)) {
    if (completedJobIds.has(jobId)) continue;
    if (activeJobIds.has(jobId)) continue;

    const needs = jobDef.needs ?? [];
    const allNeedsMet = needs.every((dep) => {
      if (completedJobIds.has(dep)) return true;
      // v0.6: inactive optional jobs (activation: optional or manual) are
      // treated as satisfied dependencies so they don't block readiness.
      const depDef = jobs[dep];
      if (depDef?.activation === "optional" || depDef?.activation === "manual") {
        return true;
      }
      // WF-7.3b: jobs that failed with failure_policy: "continue" satisfy
      // their dependents' needs (Issue #253).
      if (stateJobs && stateJobs[dep]?.status === "failed" && depDef?.failure_policy === "continue") {
        return true;
      }
      return false;
    });

    if (allNeedsMet) {
      ready.push(jobId);
    }
  }

  return ready;
}
