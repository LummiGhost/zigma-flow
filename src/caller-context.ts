/**
 * Caller Context implementation for the Zigma Flow engine.
 *
 * This module provides the engine-internal representation of the CallerContext
 * type and the PermissionSnapshot factory. It is separate from `src/host-api.ts`
 * (which is a pure-types contract file with zero runtime logic) so that engine
 * code can import from this module without coupling to the Host API contract.
 *
 * CallerContextV1 defines the explicit Core-to-Flow envelope. Its version is
 * validated before an invocation can create a run or dispatch a backend.
 *
 * Reference: docs/caller-context.md, GitHub issues #190-#192, #254
 */

import { UserInputError } from "./utils/index.js";
import {
  CALLER_CONTEXT_CONTRACT_VERSION,
  type CallerActorV1,
  type CallerContextV1,
  type CallerConstraintsV1,
  type CallerSourceV1,
  type RepositoryContextV1,
  type WorkspacePolicyContextV1,
} from "./caller-context-contract.js";

export {
  CALLER_CONTEXT_CONTRACT_VERSION,
  type CallerActorV1,
  type CallerConstraintsV1,
  type CallerContextV1,
  type CallerSourceV1,
  type RepositoryContextV1,
  type WorkspacePolicyContextV1,
} from "./caller-context-contract.js";

/** @deprecated Use the explicit `CallerContextV1` name at new boundaries. */
export type CallerContext = CallerContextV1;

// ---------------------------------------------------------------------------
// PermissionSnapshot
// ---------------------------------------------------------------------------

/**
 * Frozen Core authorization record stored in the run directory at creation time.
 *
 * The snapshot is deep-copied from the original CallerContext so that the
 * caller cannot mutate permissions after the run has started. It is written
 * once and never modified — step executors and evidence collectors read
 * the same immutable record for the entire run lifecycle.
 */
export interface PermissionSnapshot {
  /** ISO 8601 timestamp when the snapshot was created. */
  frozenAt: string;
  /** Run identifier this snapshot belongs to. */
  runId: string;
  /** Deep-copied caller context at creation time. */
  callerContext: CallerContextV1;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a frozen permission snapshot from a caller context.
 *
 * The input `callerContext` is deep-copied via `structuredClone` to ensure
 * the returned snapshot is fully independent of any external references.
 * This prevents TOCTOU issues where a caller might mutate permissions
 * after the run has started.
 *
 * @param callerContext - The caller context to freeze.
 * @param runId - The run identifier to bind this snapshot to.
 * @param frozenAt - ISO 8601 timestamp of the freeze (typically `clock.now()`).
 * @returns A new, deeply-immutable PermissionSnapshot.
 */
export function createPermissionSnapshot(
  callerContext: CallerContextV1,
  runId: string,
  frozenAt: string,
): PermissionSnapshot {
  return {
    frozenAt,
    runId,
    callerContext: structuredClone(callerContext),
  };
}

// ---------------------------------------------------------------------------
// validateCallerContext — parse and validate a --context-file JSON payload
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a caller context JSON payload from --context-file.
 *
 * A context file is always the explicit Core-to-Flow v1 envelope. Direct CLI
 * invocation remains backwards compatible by omitting `--context-file`; an
 * unversioned or legacy context file is not accepted because its authority
 * cannot be interpreted safely.
 *
 * @throws {UserInputError} on validation failure.
 */
export function validateCallerContext(raw: unknown): CallerContextV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UserInputError(
      "caller context must be a JSON object",
      { suggestion: "Provide a valid caller context JSON file with --context-file." },
    );
  }

  const obj = raw as Record<string, unknown>;

  if (obj["contractVersion"] !== CALLER_CONTEXT_CONTRACT_VERSION) {
    throw new UserInputError(
      `caller context contractVersion must be ${CALLER_CONTEXT_CONTRACT_VERSION}, got: ${String(obj["contractVersion"])}`,
      { suggestion: "Use the CallerContextV1 envelope documented in docs/platform-integration-contract.md." },
    );
  }

  const actor = requireRecord(obj, "actor");
  const actorType = requireOneOf(actor, "type", ["user", "agent", "service", "system"] as const);
  const normalizedActor: CallerActorV1 = {
    type: actorType,
    id: requireString(actor, "id"),
    ...optionalString(actor, "displayName"),
    ...optionalString(actor, "provider"),
    ...optionalString(actor, "externalId"),
  };

  const constraints = requireRecord(obj, "constraints");
  const normalizedConstraints: CallerConstraintsV1 = {
    repositoryIds: requireStringArray(constraints, "repositoryIds"),
    workflowRefs: requireStringArray(constraints, "workflowRefs"),
    toolNames: requireStringArray(constraints, "toolNames"),
    branchPatterns: requireStringArray(constraints, "branchPatterns"),
    ...optionalPositiveInteger(constraints, "maxRunDurationMs"),
    ...optionalString(constraints, "expiresAt"),
  };

  const source = requireRecord(obj, "source");
  const normalizedSource: CallerSourceV1 = {
    kind: requireOneOf(source, "kind", ["api", "web", "mail", "code-platform", "schedule", "cli", "system"] as const),
    ...optionalString(source, "provider"),
    ...optionalString(source, "externalId"),
    ...optionalString(source, "url"),
    metadata: requireRecord(source, "metadata"),
  };

  const result: CallerContextV1 = {
    contractVersion: CALLER_CONTEXT_CONTRACT_VERSION,
    actor: normalizedActor,
    capabilities: requireNonEmptyStringArray(obj, "capabilities"),
    constraints: normalizedConstraints,
    source: normalizedSource,
    taskId: requireString(obj, "taskId"),
    flowRunId: requireString(obj, "flowRunId"),
    projectId: requireString(obj, "projectId"),
    permissionSnapshotId: requireString(obj, "permissionSnapshotId"),
    integrityHash: requireString(obj, "integrityHash"),
    ...optionalString(obj, "operationId"),
    ...optionalString(obj, "callbackCorrelationId"),
    ...optionalString(obj, "baseRef"),
    ...optionalString(obj, "coreCallbackUrl"),
  };

  if (obj["repository"] !== undefined) result.repository = validateRepository(obj["repository"]);
  if (obj["workspacePolicy"] !== undefined) result.workspacePolicy = validateWorkspacePolicy(obj["workspacePolicy"]);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(parent: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = parent[field];
  if (!isRecord(value)) throw new UserInputError(`caller context '${field}' is required and must be an object`);
  return value;
}

function requireString(parent: Record<string, unknown>, field: string): string {
  const value = parent[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UserInputError(`caller context '${field}' is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(parent: Record<string, unknown>, field: string): Record<string, string> {
  const value = parent[field];
  if (value === undefined) return {};
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UserInputError(`caller context '${field}' must be a non-empty string when provided`);
  }
  return { [field]: value };
}

function requireStringArray(parent: Record<string, unknown>, field: string): string[] {
  const value = parent[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new UserInputError(`caller context '${field}' is required and must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function requireNonEmptyStringArray(parent: Record<string, unknown>, field: string): string[] {
  const value = requireStringArray(parent, field);
  if (value.length === 0) throw new UserInputError(`caller context '${field}' must not be empty`);
  return value;
}

function optionalPositiveInteger(parent: Record<string, unknown>, field: string): Record<string, number> {
  const value = parent[field];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new UserInputError(`caller context '${field}' must be a positive integer when provided`);
  }
  return { [field]: value };
}

function requireOneOf<T extends readonly string[]>(parent: Record<string, unknown>, field: string, values: T): T[number] {
  const value = parent[field];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new UserInputError(`caller context '${field}' must be one of: ${values.join(", ")}`);
  }
  return value as T[number];
}

function validateRepository(value: unknown): RepositoryContextV1 {
  if (!isRecord(value)) throw new UserInputError("caller context 'repository' must be an object when provided");
  return {
    id: requireString(value, "id"),
    provider: requireString(value, "provider"),
    url: requireString(value, "url"),
    defaultRef: requireString(value, "defaultRef"),
    writable: requireBoolean(value, "writable"),
    metadata: requireRecord(value, "metadata"),
  };
}

function validateWorkspacePolicy(value: unknown): WorkspacePolicyContextV1 {
  if (!isRecord(value)) throw new UserInputError("caller context 'workspacePolicy' must be an object when provided");
  return {
    provider: requireString(value, "provider"),
    mode: requireOneOf(value, "mode", ["writable", "read-only"] as const),
    branchTemplate: requireString(value, "branchTemplate"),
    cleanup: requireOneOf(value, "cleanup", ["always", "on-success", "manual"] as const),
    snapshotOnTerminal: requireBoolean(value, "snapshotOnTerminal"),
  };
}

function requireBoolean(parent: Record<string, unknown>, field: string): boolean {
  const value = parent[field];
  if (typeof value !== "boolean") throw new UserInputError(`caller context '${field}' is required and must be a boolean`);
  return value;
}
