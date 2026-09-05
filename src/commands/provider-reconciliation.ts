/**
 * Read-only provider reconciliation projection for `inspect --json`.
 *
 * This is intentionally assembled from Flow's persisted state, frozen caller
 * context, and invocation-control record. It neither advances a run nor
 * repairs malformed evidence: Core must retain ambiguity rather than replay a
 * side-effecting invocation.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validateCallerContext } from "../caller-context.js";
import type { RunState } from "../run/index.js";
import {
  inspectInvocationControl,
  type InvocationControlEvidenceV1,
} from "../run/invocationControl.js";

export const PROVIDER_RECONCILIATION_CONTRACT_VERSION = 1 as const;

export type ReconciliationLifecycleStatusV1 =
  | "running"
  | "awaiting_human"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface ProviderReconciliationV1 {
  contractVersion: typeof PROVIDER_RECONCILIATION_CONTRACT_VERSION;
  /** Flow's own runtime identity; this is distinct from Core's flowRunId. */
  externalRunId: string;
  lifecycle: {
    status: ReconciliationLifecycleStatusV1;
    /** True only when Flow has a completed, failed, or cancelled run state. */
    terminal: boolean;
  };
  /** Process ownership/quiescence evidence, never cancellation credentials. */
  invocation: InvocationControlEvidenceV1;
  /** Correlation values only from the already-frozen, accepted CallerContextV1. */
  callerContext: {
    state: "accepted" | "absent" | "invalid";
    operationId?: string;
    callbackCorrelationId?: string;
    taskId?: string;
    flowRunId?: string;
    projectId?: string;
  };
}

interface PermissionSnapshotFile {
  frozenAt?: unknown;
  runId?: unknown;
  callerContext?: unknown;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function normalizeLifecycle(state: RunState): ProviderReconciliationV1["lifecycle"] {
  // `paused` is Flow's persisted form of an awaiting human gate. Expose the
  // machine-facing form already used by invoke --json, while retaining the
  // raw state in the normal inspect payload for backwards compatibility.
  const status: ReconciliationLifecycleStatusV1 = state.status === "paused"
    ? "awaiting_human"
    : state.status === "running" || state.status === "blocked" ||
        state.status === "completed" || state.status === "failed" ||
        state.status === "cancelled"
      ? state.status
      : "unknown";
  return {
    status,
    terminal: status === "completed" || status === "failed" || status === "cancelled",
  };
}

async function readCallerCorrelation(
  runDir: string,
  runId: string,
): Promise<ProviderReconciliationV1["callerContext"]> {
  let text: string;
  try {
    text = await readFile(join(runDir, "caller-context.json"), "utf-8");
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return { state: "absent" };
    return { state: "invalid" };
  }

  try {
    const snapshot = JSON.parse(text) as PermissionSnapshotFile;
    // A valid CallerContext alone is insufficient: this must be the complete
    // immutable snapshot the Engine bound to this runtime run at creation.
    if (snapshot.runId !== runId || !isIsoTimestamp(snapshot.frozenAt)) {
      return { state: "invalid" };
    }
    const callerContext = validateCallerContext(snapshot.callerContext);
    return {
      state: "accepted",
      ...(callerContext.operationId !== undefined ? { operationId: callerContext.operationId } : {}),
      ...(callerContext.callbackCorrelationId !== undefined
        ? { callbackCorrelationId: callerContext.callbackCorrelationId }
        : {}),
      taskId: callerContext.taskId,
      flowRunId: callerContext.flowRunId,
      projectId: callerContext.projectId,
    };
  } catch {
    return { state: "invalid" };
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

/** Build the V1 projection using only read operations. */
export async function inspectProviderReconciliation(
  runDir: string,
  state: RunState,
): Promise<ProviderReconciliationV1> {
  const [invocation, callerContext] = await Promise.all([
    inspectInvocationControl(runDir, state.run_id),
    readCallerCorrelation(runDir, state.run_id),
  ]);
  return {
    contractVersion: PROVIDER_RECONCILIATION_CONTRACT_VERSION,
    externalRunId: state.run_id,
    lifecycle: normalizeLifecycle(state),
    invocation,
    callerContext,
  };
}
