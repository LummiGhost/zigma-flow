/**
 * Built-in workflow: worktree-create
 *
 * Creates a new git worktree at the specified path with a new branch.
 *
 * Inputs:
 *   - path — Filesystem path where the worktree will be created
 *   - branch — Branch name for the new worktree
 *   - base — Starting point commit/branch (default: "HEAD")
 *
 * Outputs:
 *   - worktree_path — Absolute path of the created worktree
 *   - branch — Branch name
 *
 * Check step validates the path exists and is a git worktree.
 */

import type { WorkflowDefinition } from "../workflow/index.js";
import type { WorktreeCreateInputs } from "./types.js";

const JOB_NAME = "create";
const STEP_CREATE = "create-worktree";
const STEP_VALIDATE = "validate-worktree";

function escapeShellArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a workflow definition that creates a git worktree.
 */
export function worktreeCreate(inputs: WorktreeCreateInputs): WorkflowDefinition {
  const targetPath = escapeShellArg(inputs.path);
  const branch = escapeShellArg(inputs.branch);
  const base = escapeShellArg(inputs.base ?? "HEAD");

  const command = [
    "git worktree add",
    `"${targetPath}"`,
    "-b", `"${branch}"`,
    `"${base}"`,
  ].join(" ");

  return {
    name: "worktree-create",
    version: "1.0.0",
    on: {
      manual: {
        inputs: {
          path: { type: "string", required: true },
          branch: { type: "string", required: true },
          base: { type: "string", required: false, default: "HEAD" },
        },
      },
    },
    jobs: {
      [JOB_NAME]: {
        steps: [
          {
            id: STEP_CREATE,
            type: "script",
            run: command,
            timeout: "60s",
            on_failure: "fail",
            outputs: {
              worktree_path: {},
              branch: {},
            },
          },
          {
            id: STEP_VALIDATE,
            type: "check",
            uses: "zigma/file-exists",
            with: {
              file: `${escapeShellArg(inputs.path)}/.git`,
            },
            on_fail: "fail",
            on_pass: "continue",
          },
        ],
      },
    },
  };
}
