/** Flow-owned port for managed workspace isolation. */

import type {
  JobWorkspaceDefinition,
  ManagedWorkflowWorkspaceDefinition,
} from "../workflow/index.js";

export interface WorkspaceHandle {
  id: string;
  /** Engine-resolved absolute execution directory. */
  path: string;
  baseCommit?: string;
  headCommit?: string;
  branch?: string;
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

/**
 * Composition-root port implemented by `@zigma-ai/zigma-workspace` adapters.
 * Flow owns workflow state; the provider owns resource allocation only.
 */
export interface WorkspaceProvider {
  prepareRun(input: PrepareRunWorkspaceInput): Promise<WorkspaceHandle>;
  prepareJob(input: PrepareJobWorkspaceInput): Promise<WorkspaceHandle>;
}
