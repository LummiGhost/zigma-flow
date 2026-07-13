/**
 * Built-in workflow: github-close-and-merge
 *
 * Closes a GitHub issue and merges a pull request in sequence.
 * Each operation has its own check step for validation.
 *
 * Inputs:
 *   - issueNumber — Issue number to close
 *   - prNumber — PR number to merge
 *   - mergeStrategy — "merge", "squash", or "rebase" (default: "merge")
 *
 * Outputs:
 *   - issue_closed — Confirmation of issue closure
 *   - pr_merged — Confirmation of PR merge
 *
 * Failure behavior: clear diagnostics when permissions or CI prevent merge.
 * The `gh` CLI surfaces HTTP errors to stderr, captured as artifacts.
 */

import type { WorkflowDefinition } from "../workflow/index.js";
import type { GitHubCloseAndMergeInputs } from "./types.js";

const JOB_NAME = "close-merge";
const STEP_CLOSE = "close-issue";
const STEP_MERGE = "merge-pr";
const STEP_VALIDATE_CLOSE = "validate-close";
const STEP_VALIDATE_MERGE = "validate-merge";

function escapeShellArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a workflow definition that closes an issue and merges a PR.
 */
export function githubCloseAndMerge(inputs: GitHubCloseAndMergeInputs): WorkflowDefinition {
  const issueNumber = escapeShellArg(inputs.issueNumber);
  const prNumber = escapeShellArg(inputs.prNumber);
  const strategy = inputs.mergeStrategy ?? "merge";

  const closeCommand = `gh issue close ${issueNumber}`;

  const strategyFlag = strategy === "squash"
    ? "--squash"
    : strategy === "rebase"
      ? "--rebase"
      : "--merge";
  const mergeCommand = `gh pr merge ${prNumber} ${strategyFlag}`;

  return {
    name: "github-close-and-merge",
    version: "1.0.0",
    on: {
      manual: {
        inputs: {
          issue_number: { type: "string", required: true },
          pr_number: { type: "string", required: true },
          merge_strategy: {
            type: "string",
            required: false,
            default: "merge",
          },
        },
      },
    },
    jobs: {
      [JOB_NAME]: {
        workspace: {
          mode: "read-only",
        },
        steps: [
          {
            id: STEP_CLOSE,
            type: "script",
            run: closeCommand,
            timeout: "60s",
            on_failure: {
              status: "failed",
            },
            outputs: {
              issue_closed: {},
            },
          },
          {
            id: STEP_VALIDATE_CLOSE,
            type: "check",
            uses: "zigma/json-parse",
            with: {
              file: `jobs/${JOB_NAME}/attempts/1/steps/${STEP_CLOSE}/stdout.txt`,
            },
            on_fail: "fail",
            on_pass: "continue",
          },
          {
            id: STEP_MERGE,
            type: "script",
            run: mergeCommand,
            timeout: "120s",
            on_failure: {
              status: "failed",
            },
            outputs: {
              pr_merged: {},
            },
          },
          {
            id: STEP_VALIDATE_MERGE,
            type: "check",
            uses: "zigma/json-parse",
            with: {
              file: `jobs/${JOB_NAME}/attempts/1/steps/${STEP_MERGE}/stdout.txt`,
            },
            on_fail: "fail",
            on_pass: "continue",
          },
        ],
      },
    },
  };
}
