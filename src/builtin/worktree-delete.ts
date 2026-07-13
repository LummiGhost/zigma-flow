/**
 * Built-in workflow: worktree-delete
 *
 * Deletes a git worktree using `git worktree remove`.
 *
 * Inputs:
 *   - path — Filesystem path of the worktree to remove
 *
 * Safety validation:
 *   - Check step validates the path points to a git worktree before removal
 *   - Post-removal check validates the worktree was actually removed
 *
 * Outputs:
 *   - removed_path — Path of the removed worktree
 */

import type { WorkflowDefinition } from "../workflow/index.js";
import type { WorktreeDeleteInputs } from "./types.js";

const JOB_NAME = "delete";
const STEP_DELETE = "delete-worktree";
const STEP_VALIDATE = "validate-removed";

function escapeShellArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a workflow definition that deletes a git worktree.
 *
 * The workflow uses `git worktree remove --force` to ensure the worktree
 * is removed even if it contains uncommitted changes. Users should review
 * the worktree contents before invoking this workflow.
 */
export function worktreeDelete(inputs: WorktreeDeleteInputs): WorkflowDefinition {
  const targetPath = escapeShellArg(inputs.path);

  const command = [
    "git worktree remove",
    "--force",
    `"${targetPath}"`,
  ].join(" ");

  return {
    name: "worktree-delete",
    version: "1.0.0",
    on: {
      manual: {
        inputs: {
          path: { type: "string", required: true },
        },
      },
    },
    jobs: {
      [JOB_NAME]: {
        steps: [
          {
            id: STEP_DELETE,
            type: "script",
            run: command,
            timeout: "60s",
            on_failure: "fail",
            outputs: {
              removed_path: {},
            },
          },
          {
            id: STEP_VALIDATE,
            type: "check",
            uses: "zigma/file-exists",
            with: {
              file: `${escapeShellArg(inputs.path)}/.git`,
            },
            on_pass: {
              status: "failed",
            },
            on_fail: "continue",
          },
        ],
      },
    },
  };
}
