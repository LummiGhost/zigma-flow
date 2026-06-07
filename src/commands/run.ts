/**
 * run command action handler.
 *
 * Resolves workflow path, locates project .zigma-flow/ directory,
 * and delegates to engine.createRun.
 *
 * Reference: docs/prd.md §17 (CLI commands), FR-004.
 * WF-P3-RUN Step 2.
 */

import { resolve, join } from "node:path";

import { createRun } from "../engine/index.js";

export interface RunOptions {
  task: string;
}

export async function runAction(workflowPath: string, options: RunOptions): Promise<void> {
  const absWorkflowPath = resolve(workflowPath);
  const projectRoot = process.cwd();
  const runsDir = join(projectRoot, ".zigma-flow", "runs");
  const skillLockPath = join(projectRoot, ".zigma-flow", "skill-lock.json");

  const { runId } = await createRun({
    workflowPath: absWorkflowPath,
    task: options.task,
    runsDir,
    skillLockPath,
  });

  console.log(`run: ${runId}`);
  console.log(`next: zigma-flow status ${runId}`);
}
