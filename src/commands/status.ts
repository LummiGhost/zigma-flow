/**
 * status command action handler.
 *
 * Reads the run state from the filesystem and renders a human-readable
 * summary of the run's progress.
 *
 * Reference: docs/prd.md FR-005, docs/mvp-contracts.md §2.3
 * WF-P3-STATUS Step 2.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { FilesystemError, StateError } from "../utils/index.js";
import { LocalStateStore, type RunState } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface StatusOptions {
  run?: string; // specific run_id, or undefined for "latest"
}

// ---------------------------------------------------------------------------
// findRun
// ---------------------------------------------------------------------------

/**
 * Pure: find the run directory. Returns the absolute path to <runsDir>/<runId>/.
 * - If runId is given: check <runsDir>/<runId>/ exists → return it, or throw FilesystemError
 * - If runId is omitted: read entries in runsDir, sort descending, return the first (latest)
 *   If runsDir is empty or doesn't exist → throw FilesystemError
 */
export async function findRun(runsDir: string, runId?: string): Promise<string> {
  if (runId !== undefined) {
    // Explicit run id: verify it exists.
    const runDir = join(runsDir, runId);
    try {
      const entries = await readdir(runDir);
      // If readdir succeeds, the directory exists (even if empty).
      void entries;
      return runDir;
    } catch (e: unknown) {
      throw new FilesystemError(`Run directory not found: ${runDir}`, { cause: e });
    }
  }

  // No run id: find the latest.
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch (e: unknown) {
    throw new FilesystemError(`Cannot read runs directory: ${runsDir}`, { cause: e });
  }

  // Filter to only directories (entries that look like run ids or are actual dirs).
  // We sort all entries descending and take the first; lexicographic sort on
  // YYYYMMDD-NNNN format gives correct chronological order.
  const dirs: string[] = [];
  for (const entry of entries) {
    try {
      // Use readdir on the entry to check if it's a directory.
      await readdir(join(runsDir, entry));
      dirs.push(entry);
    } catch {
      // Not a directory or unreadable — skip.
    }
  }

  if (dirs.length === 0) {
    throw new FilesystemError(`No runs found in: ${runsDir}`);
  }

  // Sort descending, take the first (latest).
  dirs.sort((a, b) => b.localeCompare(a));
  return join(runsDir, dirs[0]!);
}

// ---------------------------------------------------------------------------
// renderRunStatus
// ---------------------------------------------------------------------------

/**
 * Pure: render RunState + optional workflow job metadata to a human-readable string.
 * Returns the string (does NOT write to console — tests check the return value directly).
 */
export function renderRunStatus(
  state: RunState,
  workflowJobs: Record<string, { needs?: string[] }>,
): string {
  const lines: string[] = [];

  // --- Header (RC-S01) ---
  lines.push(`Run:      ${state.run_id}`);
  lines.push(`Workflow: ${state.workflow}`);
  lines.push(`Task:     ${state.task}`);
  lines.push(`Created:  ${state.created_at}`);
  lines.push("");

  // --- Jobs table (RC-S02) ---
  lines.push("Jobs:");
  for (const [jobId, job] of Object.entries(state.jobs)) {
    const parts: string[] = [`  ${jobId.padEnd(16)}${job.status}`];
    if (job.activation !== undefined) {
      parts.push(`  [activation: ${job.activation}]`);
    }
    if (job.attempt !== undefined) {
      parts.push(`  [attempt: ${job.attempt}]`);
    }
    lines.push(parts.join(""));
  }
  lines.push("");

  // --- Categorise jobs ---
  const readyJobs: string[] = [];
  const waitingJobs: string[] = [];
  const inactiveJobs: string[] = [];
  const runningJobs: string[] = [];
  const failedJobs: string[] = [];
  // Only "done" satisfies a dependency — "ready" jobs are still pending execution.
  const fulfilledStatuses = new Set(["done"]);

  for (const [jobId, job] of Object.entries(state.jobs)) {
    if (job.status === "ready") {
      readyJobs.push(jobId);
    } else if (job.status === "waiting") {
      waitingJobs.push(jobId);
    } else if (job.status === "inactive") {
      inactiveJobs.push(jobId);
    } else if (job.status === "running") {
      runningJobs.push(jobId);
    } else if (job.status === "failed") {
      failedJobs.push(jobId);
    }
  }

  // --- Ready section (RC-S03) ---
  if (readyJobs.length > 0) {
    lines.push(`Ready:    ${readyJobs.join(", ")}`);
  } else {
    lines.push("Ready:    (none)");
  }

  // --- Running section ---
  if (runningJobs.length > 0) {
    lines.push(`Running:  ${runningJobs.join(", ")}`);
  }

  // --- Waiting section (RC-S04) ---
  for (const jobId of waitingJobs) {
    const jobDef = workflowJobs[jobId];
    const needs = jobDef?.needs ?? [];
    // Unfulfilled: needs entries NOT yet done in state.jobs
    const unfulfilled = needs.filter((dep) => {
      const depJob = state.jobs[dep];
      return depJob === undefined || !fulfilledStatuses.has(depJob.status);
    });
    if (unfulfilled.length > 0) {
      lines.push(`Waiting:  ${jobId}  (needs: ${unfulfilled.join(", ")})`);
    } else {
      lines.push(`Waiting:  ${jobId}`);
    }
  }

  // --- Inactive section ---
  if (inactiveJobs.length > 0) {
    lines.push(`Inactive: ${inactiveJobs.join(", ")}`);
  }

  // --- Failed section ---
  if (failedJobs.length > 0) {
    lines.push(`Failed:   ${failedJobs.join(", ")}`);
  }

  lines.push("");

  // --- Next section (RC-S05) ---
  if (failedJobs.length > 0) {
    lines.push(`Next: zigma-flow prompt --job ${failedJobs[0]}  (retry failed job)`);
  } else if (readyJobs.length > 0) {
    lines.push(`Next: zigma-flow prompt --job ${readyJobs[0]}`);
  } else if (runningJobs.length > 0) {
    lines.push(`Next: waiting for running jobs (zigma-flow status)`);
  } else if (waitingJobs.length > 0) {
    lines.push(`Next: waiting for jobs to become ready (zigma-flow status)`);
  } else if (inactiveJobs.length > 0) {
    lines.push(`Next: zigma-flow prompt --job ${inactiveJobs[0]}  (optional job)`);
  } else {
    lines.push("Next: zigma-flow status  (no pending jobs)");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// statusAction
// ---------------------------------------------------------------------------

/**
 * CLI action: reads state, renders, prints to console.
 * runsDir: injectable for tests; defaults to join(process.cwd(), ".zigma-flow", "runs")
 */
export async function statusAction(options: StatusOptions, runsDir?: string): Promise<void> {
  const dir = runsDir ?? join(process.cwd(), ".zigma-flow", "runs");

  const runDir = await findRun(dir, options.run);

  const store = new LocalStateStore();
  let state: RunState | null;
  try {
    state = await store.readSnapshot(runDir);
  } catch (e: unknown) {
    if (e instanceof StateError) {
      // Re-throw as FilesystemError so that the status command surfaces it as a
      // filesystem/data corruption failure (P3 behavior contract).
      throw new FilesystemError(e.message, { cause: e });
    }
    throw e;
  }

  if (state === null) {
    throw new FilesystemError(`state.json not found in run: ${runDir}`);
  }

  // Try to load workflow for dependency info; silently fall back to {} on failure.
  let workflowJobs: Record<string, { needs?: string[] }> = {};
  try {
    const runYmlText = await readFile(join(runDir, "run.yml"), "utf-8");
    const runMeta = parseYaml(runYmlText) as { workflow?: { path?: string } };
    const workflowPath = runMeta?.workflow?.path;
    if (typeof workflowPath === "string") {
      const wf = await loadWorkflowFile(workflowPath);
      workflowJobs = wf.jobs;
    }
  } catch {
    // Silently fall back — tests don't provide a real workflow YAML.
    workflowJobs = {};
  }

  const output = renderRunStatus(state, workflowJobs);
  console.log(output);
}
