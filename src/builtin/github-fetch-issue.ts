/**
 * Built-in workflow: github-fetch-issue
 *
 * Fetches GitHub issue context using `gh issue view` and validates the JSON
 * output with a check step.
 *
 * Inputs:
 *   - issueNumber — GitHub issue number
 *   - repo — Repository in owner/name format
 *
 * Outputs:
 *   - title, body, comments, labels, url — issue data
 */

import type { WorkflowDefinition } from "../workflow/index.js";
import type { GitHubFetchIssueInputs } from "./types.js";

const JOB_NAME = "fetch";
const STEP_FETCH = "fetch-issue";
const STEP_VALIDATE = "validate-output";

/**
 * Escape a value for safe inclusion in a double-quoted shell string.
 * Replaces backslashes and double quotes.
 */
function escapeShellArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a workflow definition that fetches a GitHub issue.
 */
export function githubFetchIssue(inputs: GitHubFetchIssueInputs): WorkflowDefinition {
  const repo = escapeShellArg(inputs.repo);
  const issueNumber = escapeShellArg(inputs.issueNumber);
  const url = `https://github.com/${inputs.repo}/issues/${inputs.issueNumber}`;

  const command = [
    "gh issue view",
    issueNumber,
    "--repo", repo,
    "--json", "title,body,comments,labels,assignees,url",
  ].join(" ");

  return {
    name: "github-fetch-issue",
    version: "1.0.0",
    on: {
      manual: {
        inputs: {
          issue_number: { type: "string", required: true },
          repo: { type: "string", required: true },
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
            id: STEP_FETCH,
            type: "script",
            run: command,
            timeout: "60s",
            on_failure: "fail",
            outputs: {
              title: {},
              body: {},
              comments: {},
              labels: {},
              url: {},
            },
          },
          {
            id: STEP_VALIDATE,
            type: "check",
            uses: "zigma/json-parse",
            with: {
              file: `jobs/${JOB_NAME}/attempts/1/steps/${STEP_FETCH}/stdout.txt`,
            },
            on_fail: "fail",
            on_pass: "continue",
          },
        ],
      },
    },
  };
}
