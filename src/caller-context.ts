/**
 * Caller Context implementation for the Zigma Flow engine v0.5.
 *
 * This module provides the engine-internal representation of the CallerContext
 * type and the PermissionSnapshot factory. It is separate from `src/host-api.ts`
 * (which is a pure-types contract file with zero runtime logic) so that engine
 * code can import from this module without coupling to the Host API contract.
 *
 * Reference: docs/caller-context.md, GitHub issues #190-#192
 */

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
 * Every field is required. The Host is responsible for populating all fields
 * before passing the context to the engine. The CLI may omit the entire
 * CallerContext for backward compatibility.
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
