/**
 * Built-in workflow definitions for common repository automation tasks.
 *
 * Each built-in is a function that returns a complete WorkflowDefinition.
 * Parameters are embedded directly into script commands because the script
 * executor does not populate the expression context's `inputs` field for
 * `${{ }}` resolution.
 *
 * Usage:
 *   import { githubFetchIssue, githubPublishPr } from "../builtin/index.js";
 *   const wf = githubFetchIssue({ issueNumber: "42", repo: "owner/name" });
 *
 * All built-in workflows use script steps for command execution and check
 * steps for output validation. Command failures surface as workflow
 * failures with diagnostics from stdout/stderr.
 *
 * Module boundary: these are pure data generators — they produce
 * WorkflowDefinition objects and do not import CLI adapters, execute
 * commands, or modify run state.
 */

// GitHub built-ins
export { githubFetchIssue } from "./github-fetch-issue.js";
export { githubPublishPr } from "./github-publish-pr.js";
export { githubComment } from "./github-comment.js";
export { githubCloseAndMerge } from "./github-close-and-merge.js";

// Worktree built-ins
export { worktreeCreate } from "./worktree-create.js";
export { worktreeDelete } from "./worktree-delete.js";

// Types
export type {
  GitHubFetchIssueInputs,
  GitHubFetchIssueOutputs,
  GitHubPublishPrInputs,
  GitHubPublishPrOutputs,
  GitHubCommentInputs,
  GitHubCommentOutputs,
  GitHubCommentTargetType,
  GitHubCloseAndMergeInputs,
  GitHubCloseAndMergeOutputs,
  MergeStrategy,
  WorktreeCreateInputs,
  WorktreeCreateOutputs,
  WorktreeDeleteInputs,
  WorktreeDeleteOutputs,
} from "./types.js";
