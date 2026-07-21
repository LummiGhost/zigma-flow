/**
 * Caller Context implementation for the Zigma Flow engine.
 *
 * This module provides the engine-internal representation of the CallerContext
 * type and the PermissionSnapshot factory. It is separate from `src/host-api.ts`
 * (which is a pure-types contract file with zero runtime logic) so that engine
 * code can import from this module without coupling to the Host API contract.
 *
 * v0.7 (ISSUE #254): Extended CallerContext with platform integration fields
 * (coreTaskId, flowRunId, permissionSnapshotId/Hash, repository, branch,
 * callbackConfig) and added validateCallerContext for --context-file parsing.
 *
 * Reference: docs/caller-context.md, GitHub issues #190-#192, #254
 */

import { UserInputError } from "./utils/index.js";

// ---------------------------------------------------------------------------
// CallbackConfig
// ---------------------------------------------------------------------------

/**
 * Event sink / callback configuration supplied via caller context.
 *
 * When provided, the engine forwards FlowPlatformEvents to the configured
 * destination in addition to writing the internal events.jsonl.
 */
export interface CallbackConfig {
  /** Sink type. "webhook" POSTs events; "file" writes NDJSON; "none" disables. */
  type: "webhook" | "file" | "none";
  /** Target URI (URL for webhook, absolute path for file). */
  uri?: string;
}

// ---------------------------------------------------------------------------
// CallerContext
// ---------------------------------------------------------------------------

/**
 * Identity and origin of the caller invoking an engine operation.
 *
 * This interface mirrors {@link import("../host-api.js").CallerContext} from the
 * Host API contract but lives in the engine layer so that implementations
 * (createRun, step executors, artifact writers) can reference it without
 * importing the pure-types Host API file.
 *
 * Core fields (user, actor, source, permissions, project) are required when
 * supplied via a Host. The CLI may omit the entire CallerContext for backward
 * compatibility.
 *
 * v0.7 (ISSUE #254): Extended with platform integration fields.
 */
export interface CallerContext {
  /** Authenticated end-user who initiated the action. */
  user: {
    /** Unique user identifier (provider-agnostic). */
    id: string;
    /** Display name. */
    name: string;
    /** Contact email. */
    email: string;
  };
  /** Actor that executed the action (may differ from user for service accounts). */
  actor: Actor;
  /** Originating system metadata. */
  source: {
    /** System name (e.g. "zigma-host", "zigma-cli"). */
    system: string;
    /** System version string. */
    version: string;
  };
  /** Permission grants held by the caller at the time of the request. */
  permissions: string[];
  /** Project scope the action targets. */
  project: {
    /** Project identifier. */
    id: string;
    /** Project scope / tenant. */
    scope: string;
  };

  // ── v0.7 platform integration fields (ISSUE #254) ─────────────────────

  /** Core Task ID from the platform control plane. */
  coreTaskId?: string;
  /** Flow Run ID from the platform (may differ from engine-generated runId). */
  flowRunId?: string;
  /** External permission snapshot identifier. */
  permissionSnapshotId?: string;
  /** SHA-256 hash of the permission snapshot (hex-encoded). */
  permissionSnapshotHash?: string;
  /** Repository constraint (e.g. "owner/repo"). */
  repository?: string;
  /** Branch constraint (e.g. "main"). */
  branch?: string;
  /** Workflow name constraint. */
  workflow?: string;
  /** Tool name constraint. */
  tool?: string;
  /** Event sink / callback configuration. */
  callbackConfig?: CallbackConfig;
}

/**
 * Actor that performs an engine operation.
 *
 * The actor may be the same as the authenticated user or a distinct
 * service identity (e.g. a CI system, webhook handler, or scheduled job).
 */
export interface Actor {
  /** Actor category. */
  type: "user" | "system" | "service";
  /** Unique actor identifier. */
  id: string;
  /** Human-readable name (optional for system actors). */
  name?: string;
}

// ---------------------------------------------------------------------------
// PermissionSnapshot
// ---------------------------------------------------------------------------

/**
 * Frozen permission record stored in the run directory at creation time.
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
  callerContext: CallerContext;
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
  callerContext: CallerContext,
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
 * Required top-level fields: user.id, user.name, user.email, actor.type,
 * actor.id, source.system, source.version, project.id, project.scope.
 *
 * Platform fields (coreTaskId, flowRunId, etc.) are optional but type-checked
 * when present.
 *
 * @throws {UserInputError} on validation failure.
 */
export function validateCallerContext(raw: unknown): CallerContext {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UserInputError(
      "caller context must be a JSON object",
      { suggestion: "Provide a valid caller context JSON file with --context-file." },
    );
  }

  const obj = raw as Record<string, unknown>;

  // Validate required nested objects
  const user = obj["user"];
  if (typeof user !== "object" || user === null) {
    throw new UserInputError("caller context must have a 'user' object");
  }
  const u = user as Record<string, unknown>;
  if (typeof u["id"] !== "string") {
    throw new UserInputError("caller context 'user.id' is required and must be a string");
  }
  if (typeof u["name"] !== "string") {
    throw new UserInputError("caller context 'user.name' is required and must be a string");
  }
  if (typeof u["email"] !== "string") {
    throw new UserInputError("caller context 'user.email' is required and must be a string");
  }

  const actor = obj["actor"];
  if (typeof actor !== "object" || actor === null) {
    throw new UserInputError("caller context must have an 'actor' object");
  }
  const a = actor as Record<string, unknown>;
  if (a["type"] !== "user" && a["type"] !== "system" && a["type"] !== "service") {
    throw new UserInputError(
      `caller context 'actor.type' must be "user", "system", or "service", got: ${String(a["type"])}`,
    );
  }
  if (typeof a["id"] !== "string") {
    throw new UserInputError("caller context 'actor.id' is required and must be a string");
  }

  const source = obj["source"];
  if (typeof source !== "object" || source === null) {
    throw new UserInputError("caller context must have a 'source' object");
  }
  const s = source as Record<string, unknown>;
  if (typeof s["system"] !== "string") {
    throw new UserInputError("caller context 'source.system' is required and must be a string");
  }

  const project = obj["project"];
  if (typeof project !== "object" || project === null) {
    throw new UserInputError("caller context must have a 'project' object");
  }
  const p = project as Record<string, unknown>;
  if (typeof p["id"] !== "string") {
    throw new UserInputError("caller context 'project.id' is required and must be a string");
  }

  // Validate optional platform fields
  if (obj["coreTaskId"] !== undefined && typeof obj["coreTaskId"] !== "string") {
    throw new UserInputError("caller context 'coreTaskId' must be a string");
  }
  if (obj["flowRunId"] !== undefined && typeof obj["flowRunId"] !== "string") {
    throw new UserInputError("caller context 'flowRunId' must be a string");
  }
  if (obj["permissionSnapshotHash"] !== undefined && typeof obj["permissionSnapshotHash"] !== "string") {
    throw new UserInputError("caller context 'permissionSnapshotHash' must be a string");
  }
  if (obj["repository"] !== undefined && typeof obj["repository"] !== "string") {
    throw new UserInputError("caller context 'repository' must be a string");
  }
  if (obj["branch"] !== undefined && typeof obj["branch"] !== "string") {
    throw new UserInputError("caller context 'branch' must be a string");
  }

  const callbackConfig = obj["callbackConfig"];
  let cc: Record<string, unknown> | undefined;
  if (callbackConfig !== undefined) {
    if (typeof callbackConfig !== "object" || callbackConfig === null) {
      throw new UserInputError("caller context 'callbackConfig' must be an object");
    }
    cc = callbackConfig as Record<string, unknown>;
    if (cc["type"] !== "webhook" && cc["type"] !== "file" && cc["type"] !== "none") {
      throw new UserInputError(
        `callbackConfig.type must be "webhook", "file", or "none", got: ${String(cc["type"])}`,
      );
    }
  }

  // Build and return normalized context
  const permissions = Array.isArray(obj["permissions"])
    ? (obj["permissions"] as string[]).filter((v): v is string => typeof v === "string")
    : [];

  return {
    user: { id: u["id"] as string, name: u["name"] as string, email: u["email"] as string },
    actor: { type: a["type"] as Actor["type"], id: a["id"] as string, ...(typeof a["name"] === "string" ? { name: a["name"] } : {}) },
    source: {
      system: s["system"] as string,
      version: typeof s["version"] === "string" ? s["version"] : "0.0.0",
    },
    permissions,
    project: { id: p["id"] as string, scope: typeof p["scope"] === "string" ? p["scope"] : "default" },
    ...(typeof obj["coreTaskId"] === "string" ? { coreTaskId: obj["coreTaskId"] } : {}),
    ...(typeof obj["flowRunId"] === "string" ? { flowRunId: obj["flowRunId"] } : {}),
    ...(typeof obj["permissionSnapshotId"] === "string" ? { permissionSnapshotId: obj["permissionSnapshotId"] } : {}),
    ...(typeof obj["permissionSnapshotHash"] === "string" ? { permissionSnapshotHash: obj["permissionSnapshotHash"] } : {}),
    ...(typeof obj["repository"] === "string" ? { repository: obj["repository"] } : {}),
    ...(typeof obj["branch"] === "string" ? { branch: obj["branch"] } : {}),
    ...(typeof obj["workflow"] === "string" ? { workflow: obj["workflow"] } : {}),
    ...(typeof obj["tool"] === "string" ? { tool: obj["tool"] } : {}),
    ...(cc !== undefined ? { callbackConfig: cc as unknown as CallbackConfig } : {}),
  };
}
