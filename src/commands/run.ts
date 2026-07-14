/**
 * run command action handler.
 *
 * Resolves workflow path, locates project .zigma-flow/ directory,
 * and delegates to engine.createRun.
 *
 * Reference: docs/prd.md §17 (CLI commands), FR-004.
 * WF-P3-RUN Step 2.
 */

import { access, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { createRun } from "../engine/index.js";
import { LocalStateStore } from "../run/index.js";

export interface RunOptions {
  task: string;
  inputs?: Record<string, string>;
  /** Project root directory (defaults to process.cwd()). */
  projectRoot?: string;
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
  const projectRoot = options.projectRoot ?? process.cwd();
  const absWorkflowPath = await resolveWorkflowPath(workflowPath, projectRoot);
  const runsDir = join(projectRoot, ".zigma-flow", "runs");
  const skillLockPath = join(projectRoot, ".zigma-flow", "skill-lock.json");

  // v0.6: active_run is deprecated and new runs no longer update it.
  // Check legacy active_run silently (without triggering deprecation warnings)
  // to warn users about stale config pointers.
  let legacyActiveRun: string | null = null;
  try {
    const configPath = join(projectRoot, ".zigma-flow", "config.json");
    const configRaw = await readFile(configPath, "utf-8");
    const config = JSON.parse(configRaw) as Record<string, unknown>;
    if (typeof config["active_run"] === "string") {
      legacyActiveRun = config["active_run"];
    }
  } catch {
    // Config missing or unparseable — no legacy pointer to check.
  }
  if (legacyActiveRun !== null) {
    const stateStore = new LocalStateStore();
    const existingRunDir = join(runsDir, legacyActiveRun);
    const existingState = await stateStore.readSnapshot(existingRunDir);
    if (existingState !== null && existingState.status !== "completed" && existingState.status !== "cancelled") {
      console.warn(
        `Note: config.json "active_run" ("${legacyActiveRun}", status: ${existingState.status ?? "unknown"}) ` +
        "is deprecated and will NOT be updated by this command. " +
        "Use --run <run-id> or --latest to target runs explicitly. " +
        "This field will be removed in v1.0."
      );
      console.warn(
        `Use 'zigma-flow list-runs' to see all runs, or 'zigma-flow status --run ${legacyActiveRun}' to check its status.`
      );
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
