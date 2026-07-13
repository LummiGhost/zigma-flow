/**
 * Built-in workflow: github-comment
 *
 * Posts a comment on a GitHub pull request or issue using `gh pr comment`
 * or `gh issue comment`.
 *
 * Inputs:
 *   - target — PR or issue number or URL
 *   - body — Comment body text
 *   - targetType — "pr" or "issue" (default: "pr")
 *
 * Outputs:
 *   - comment_url — URL of the created comment
 */

import type { WorkflowDefinition } from "../workflow/index.js";
import type { GitHubCommentInputs } from "./types.js";

const JOB_NAME = "comment";
const STEP_COMMENT = "post-comment";
const STEP_VALIDATE = "validate-comment";

function escapeShellArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a workflow definition that comments on a PR or issue.
 */
export function githubComment(inputs: GitHubCommentInputs): WorkflowDefinition {
  const target = escapeShellArg(inputs.target);
  const body = escapeShellArg(inputs.body);
  const targetType = inputs.targetType ?? "pr";

  const subcommand = targetType === "issue" ? "issue comment" : "pr comment";
  const command = [
    `gh ${subcommand}`,
    target,
    `--body "${body}"`,
  ].join(" ");

  return {
    name: "github-comment",
    version: "1.0.0",
    on: {
      manual: {
        inputs: {
          target: { type: "string", required: true },
          body: { type: "string", required: true },
          target_type: { type: "string", required: false, default: "pr" },
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
            id: STEP_COMMENT,
            type: "script",
            run: command,
            timeout: "60s",
            on_failure: "fail",
            outputs: {
              comment_url: {},
            },
          },
          {
            id: STEP_VALIDATE,
            type: "check",
            uses: "zigma/json-parse",
            with: {
              file: `jobs/${JOB_NAME}/attempts/1/steps/${STEP_COMMENT}/stdout.txt`,
            },
            on_fail: "fail",
            on_pass: "continue",
          },
        ],
      },
    },
  };
}
