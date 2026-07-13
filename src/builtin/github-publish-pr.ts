/**
 * Built-in workflow: github-publish-pr
 *
 * Publishes a pull request using `gh pr create` and validates the output.
 *
 * Inputs:
 *   - title — PR title
 *   - body — PR description
 *   - base — Target base branch (default: "main")
 *   - head — Source head branch
 *
 * Outputs:
 *   - pr_number — Created PR number
 *   - pr_url — URL of the created PR
 */

import type { WorkflowDefinition } from "../workflow/index.js";
import type { GitHubPublishPrInputs } from "./types.js";

const JOB_NAME = "publish";
const STEP_CREATE = "create-pr";
const STEP_VALIDATE = "validate-pr";

function escapeShellArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a workflow definition that publishes a pull request.
 */
export function githubPublishPr(inputs: GitHubPublishPrInputs): WorkflowDefinition {
  const title = escapeShellArg(inputs.title);
  const body = escapeShellArg(inputs.body);
  const base = escapeShellArg(inputs.base ?? "main");
  const head = escapeShellArg(inputs.head);

  const command = [
    "gh pr create",
    `--title "${title}"`,
    `--body "${body}"`,
    `--base "${base}"`,
    `--head "${head}"`,
  ].join(" ");

  return {
    name: "github-publish-pr",
    version: "1.0.0",
    on: {
      manual: {
        inputs: {
          title: { type: "string", required: true },
          body: { type: "string", required: true },
          base: { type: "string", required: false, default: "main" },
          head: { type: "string", required: true },
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
            id: STEP_CREATE,
            type: "script",
            run: command,
            timeout: "120s",
            on_failure: "fail",
            outputs: {
              pr_number: {},
              pr_url: {},
            },
          },
          {
            id: STEP_VALIDATE,
            type: "check",
            uses: "zigma/json-parse",
            with: {
              file: `jobs/${JOB_NAME}/attempts/1/steps/${STEP_CREATE}/stdout.txt`,
            },
            on_fail: "fail",
            on_pass: "continue",
          },
        ],
      },
    },
  };
}
