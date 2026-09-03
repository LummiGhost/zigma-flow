/**
 * Versioned caller-context protocol shared by Zigma Core and Zigma Flow.
 *
 * This file deliberately contains types and constants only.  It is safe for
 * either side of the boundary to import without initializing the engine.
 */

export const CALLER_CONTEXT_CONTRACT_VERSION = 1 as const;

export type CallerActorTypeV1 = "user" | "agent" | "service" | "system";

export interface CallerActorV1 {
  type: CallerActorTypeV1;
  id: string;
  displayName?: string;
  provider?: string;
  externalId?: string;
}

export interface CallerConstraintsV1 {
  repositoryIds: string[];
  workflowRefs: string[];
  toolNames: string[];
  branchPatterns: string[];
  maxRunDurationMs?: number;
  expiresAt?: string;
}

export type CallerSourceKindV1 =
  | "api"
  | "web"
  | "mail"
  | "code-platform"
  | "schedule"
  | "cli"
  | "system";

export interface CallerSourceV1 {
  kind: CallerSourceKindV1;
  provider?: string;
  externalId?: string;
  url?: string;
  metadata: Record<string, unknown>;
}

export interface RepositoryContextV1 {
  id: string;
  provider: string;
  url: string;
  defaultRef: string;
  writable: boolean;
  metadata: Record<string, unknown>;
}

export interface WorkspacePolicyContextV1 {
  provider: string;
  mode: "writable" | "read-only";
  branchTemplate: string;
  cleanup: "always" | "on-success" | "manual";
  snapshotOnTerminal: boolean;
}

/**
 * Canonical context transported by `zigma-flow invoke --context-file`.
 *
 * This is intentionally a Core-to-Flow envelope, not Flow's internal run
 * identity. Flow creates its own runtime run ID after accepting this context.
 */
export interface CallerContextV1 {
  contractVersion: typeof CALLER_CONTEXT_CONTRACT_VERSION;
  actor: CallerActorV1;
  capabilities: string[];
  constraints: CallerConstraintsV1;
  source: CallerSourceV1;
  taskId: string;
  flowRunId: string;
  projectId: string;
  permissionSnapshotId: string;
  integrityHash: string;
  operationId?: string;
  callbackCorrelationId?: string;
  repository?: RepositoryContextV1;
  baseRef?: string;
  workspacePolicy?: WorkspacePolicyContextV1;
  coreCallbackUrl?: string;
}
