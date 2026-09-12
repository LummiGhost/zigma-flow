/** Flow-owned port for managed workspace isolation. */

import type {
  JobWorkspaceDefinition,
  ManagedWorkflowWorkspaceDefinition,
  WorkspaceRetentionDefinition,
} from "../workflow/index.js";

export interface WorkspaceHandle {
  id: string;
  /** Engine-resolved absolute execution directory. */
  path: string;
  baseCommit?: string;
  headCommit?: string;
  branch?: string;
  /** Row-level retention echoed back by prepare-run (M4.1). */
  retention?: WorkspaceRetentionDefinition;
  [key: string]: unknown;
}

export interface PrepareRunWorkspaceInput {
  operationId: string;
  runId: string;
  /** Flow's absolute project root, used to resolve repository: "." safely. */
  projectRoot: string;
  definition: ManagedWorkflowWorkspaceDefinition;
  signal?: AbortSignal;
}

export interface PrepareJobWorkspaceInput {
  operationId: string;
  runId: string;
  jobId: string;
  attempt: number;
  runWorkspace: WorkspaceHandle;
  definition: JobWorkspaceDefinition;
  signal?: AbortSignal;
}

// ── M4 lifecycle (commit / integrate / publish / reconcile / cleanup) ───────

export interface CommitJobInput {
  operationId: string;
  runId: string;
  jobId: string;
  attempt: number;
  jobWorkspace: WorkspaceHandle;
  message?: string;
  /** CAS: fail unless the attempt workspace is in this state. */
  expectedState?: string;
  signal?: AbortSignal;
}

export interface CommitJobResult {
  operationId: string;
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: string[];
  evidenceDigest: string;
  noOp: boolean;
}

export interface IntegrateJobInput {
  operationId: string;
  runId: string;
  jobId: string;
  attempt: number;
  jobWorkspace: WorkspaceHandle;
  runWorkspace: WorkspaceHandle;
  /** CAS: fail unless the Run workspace HEAD is this commit. */
  expectedHead?: string;
  signal?: AbortSignal;
}

export type IntegrateJobResult =
  | {
      status: "merged";
      operationId: string;
      sourceWorkspaceId: string;
      targetWorkspaceId: string;
      sourceCommit: string;
      previousTargetHead: string;
      resultingCommit: string;
      changedFiles: string[];
    }
  | {
      status: "no-op";
      operationId: string;
      sourceWorkspaceId: string;
      targetWorkspaceId: string;
      sourceCommit: string;
      previousTargetHead: string;
    }
  | {
      /** Typed, not thrown: the provider resolved a merge conflict. */
      status: "conflicted";
      operationId: string;
      sourceWorkspaceId: string;
      targetWorkspaceId: string;
      conflictFiles: string[];
      jobCommit: string;
      runHead: string;
      message: string;
    };

export interface PublishRunInput {
  operationId: string;
  runId: string;
  workspace: WorkspaceHandle;
  strategy: "none" | "branch";
  targetRef: string;
  /** CAS: fail unless the workspace HEAD is this commit. */
  expectedHead?: string;
  signal?: AbortSignal;
}

export interface PublishRunResult {
  operationId: string;
  workspaceId: string;
  strategy: "none" | "branch";
  resultingRef: string | null;
  resultingCommit: string;
  previousRef: string | null;
  changedFiles: string[];
}

export interface ReconcileRunInput {
  workspace: WorkspaceHandle;
  signal?: AbortSignal;
}

export interface ReconcileRunResult {
  workspaceId: string;
  registryStatus: string;
  directoryExists: boolean;
  gitHead: string | null;
  manifestExists: boolean;
  reconciledStatus: "complete" | "incomplete" | "orphaned" | "inconsistent";
  recommendation: string;
}

export interface CleanupRunInput {
  operationId: string;
  workspace: WorkspaceHandle;
  signal?: AbortSignal;
}

export interface CleanupRunResult {
  operationId: string;
  workspaceId: string;
  path: string;
  removed: boolean;
  status: "CLEANED" | "CLEANUP_FAILED";
  message: string;
  blockers: string[];
}

/**
 * Composition-root port implemented by `@zigma-ai/zigma-workspace` adapters.
 * Flow owns workflow state; the provider owns resource allocation only.
 */
export interface WorkspaceProvider {
  prepareRun(input: PrepareRunWorkspaceInput): Promise<WorkspaceHandle>;
  prepareJob(input: PrepareJobWorkspaceInput): Promise<WorkspaceHandle>;
  commitJob(input: CommitJobInput): Promise<CommitJobResult>;
  integrateJob(input: IntegrateJobInput): Promise<IntegrateJobResult>;
  publishRun(input: PublishRunInput): Promise<PublishRunResult>;
  reconcileRun(input: ReconcileRunInput): Promise<ReconcileRunResult>;
  cleanupRun(input: CleanupRunInput): Promise<CleanupRunResult>;
}
