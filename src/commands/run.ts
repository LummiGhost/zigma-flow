/**
 * run command action handler.
 *
 * Resolves workflow path, locates project .zigma-flow/ directory,
 * and delegates to engine.createRun.
 *
 * Reference: docs/prd.md §17 (CLI commands), FR-004.
 * WF-P3-RUN Step 2.
 */

import { access } from "node:fs/promises";
import { resolve, join } from "node:path";

import { createRun } from "../engine/index.js";
import { readActiveRun, LocalStateStore } from "../run/index.js";

export interface RunOptions {
  task: string;
  inputs?: Record<string, string>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isBareWorkflowName(workflowPath: string): boolean {
  return (
    !workflowPath.includes("/") &&
    !workflowPath.includes("\\") &&
    !workflowPath.endsWith(".yml") &&
    !workflowPath.endsWith(".yaml")
  );
}

export async function resolveWorkflowPath(
  workflowPath: string,
  projectRoot = process.cwd(),
): Promise<string> {
  const explicitPath = resolve(projectRoot, workflowPath);
  if (await fileExists(explicitPath)) {
    return explicitPath;
  }

  if (isBareWorkflowName(workflowPath)) {
    const workflowsDir = join(projectRoot, ".zigma-flow", "workflows");
    for (const ext of [".yml", ".yaml"]) {
      const candidate = join(workflowsDir, `${workflowPath}${ext}`);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  return explicitPath;
}

export async function runAction(workflowPath: string, options: RunOptions): Promise<void> {
  const projectRoot = process.cwd();
  const absWorkflowPath = await resolveWorkflowPath(workflowPath, projectRoot);
  const runsDir = join(projectRoot, ".zigma-flow", "runs");
  const skillLockPath = join(projectRoot, ".zigma-flow", "skill-lock.json");

  // Warn if overwriting an active run that is not yet completed
  const existingActive = await readActiveRun(projectRoot);
  if (existingActive !== null) {
    const stateStore = new LocalStateStore();
    const existingRunDir = join(runsDir, existingActive);
    const existingState = await stateStore.readSnapshot(existingRunDir);
    if (existingState !== null && existingState.status !== "completed" && existingState.status !== "cancelled") {
      console.warn(`Warning: active_run (${existingActive}, status: ${existingState.status ?? "running"}) will be replaced.`);
      console.warn(`Use 'zigma-flow list-runs' to see all runs, or 'zigma-flow status --run ${existingActive}' to check its status.`);
    }
  }

  const { runId } = await createRun({
    workflowPath: absWorkflowPath,
    task: options.task,
    runsDir,
    skillLockPath,
    ...(options.inputs !== undefined ? { inputs: options.inputs } : {}),
  });

  console.log(`run: ${runId}`);
  console.log(`next: zigma-flow status ${runId}`);
}
