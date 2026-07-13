/**
 * Shared types for built-in workflow definitions.
 *
 * Each built-in is a function that takes typed parameters and returns a
 * complete WorkflowDefinition. Parameters are embedded directly into script
 * commands because the script executor does not populate the expression
 * context's `inputs` field for `${{ }}` resolution.
 */

// ---------------------------------------------------------------------------
// GitHub fetch issue
// ---------------------------------------------------------------------------

export interface GitHubFetchIssueInputs {
  /** GitHub issue number (e.g. "42"). */
  issueNumber: string;
  /** Repository in owner/name format (e.g. "zigma-ai/zigma-flow"). */
  repo: string;
}

export interface GitHubFetchIssueOutputs {
  title: string;
  body: string;
  comments: unknown;
  labels: unknown;
  url: string;
}

// ---------------------------------------------------------------------------
// GitHub publish PR
// ---------------------------------------------------------------------------

export interface GitHubPublishPrInputs {
  /** PR title. */
  title: string;
  /** PR body (description). */
  body: string;
  /** Target base branch (default: "main"). */
  base?: string;
  /** Source head branch. */
  head: string;
}

export interface GitHubPublishPrOutputs {
  pr_number: string;
  pr_url: string;
}

// ---------------------------------------------------------------------------
// GitHub comment
// ---------------------------------------------------------------------------

export type GitHubCommentTargetType = "pr" | "issue";

export interface GitHubCommentInputs {
  /** PR or issue number or URL. */
  target: string;
  /** Comment body text. */
  body: string;
  /** Target type: "pr" or "issue" (default: "pr"). */
  targetType?: GitHubCommentTargetType;
}

export interface GitHubCommentOutputs {
  comment_url: string;
}

// ---------------------------------------------------------------------------
// GitHub close and merge
// ---------------------------------------------------------------------------

export type MergeStrategy = "merge" | "squash" | "rebase";

export interface GitHubCloseAndMergeInputs {
  /** Issue number to close. */
  issueNumber: string;
  /** PR number to merge. */
  prNumber: string;
  /** Merge strategy (default: "merge"). */
  mergeStrategy?: MergeStrategy;
}

export interface GitHubCloseAndMergeOutputs {
  issue_closed: string;
  pr_merged: string;
}

// ---------------------------------------------------------------------------
// Worktree create
// ---------------------------------------------------------------------------

export interface WorktreeCreateInputs {
  /** Filesystem path where the worktree will be created. */
  path: string;
  /** Branch name for the new worktree. */
  branch: string;
  /** Starting point commit/branch (default: "HEAD"). */
  base?: string;
}

export interface WorktreeCreateOutputs {
  worktree_path: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// Worktree delete
// ---------------------------------------------------------------------------

export interface WorktreeDeleteInputs {
  /** Filesystem path of the worktree to remove. */
  path: string;
}

export interface WorktreeDeleteOutputs {
  removed_path: string;
}
