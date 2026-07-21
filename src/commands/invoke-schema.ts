/**
 * Versioned JSON output schema for `zigma-flow invoke --json`.
 *
 * Reference: ISSUE #254 — platform integration contract.
 */

// ---------------------------------------------------------------------------
// Contract version
// ---------------------------------------------------------------------------

export const INVOKE_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// InvokeJsonOutput
// ---------------------------------------------------------------------------

export type InvokeJsonStatus =
  | "running"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface PausedGateInfo {
  jobId: string;
  stepId: string;
  prompt: string;
  externalGateId?: string;
  inputSchema?: Record<string, unknown>;
  deadline?: string;
}

export interface ArtifactRef {
  id: string;
  kind: string;
  path: string;
  size: number;
}

export interface InvokeJsonOutput {
  contractVersion: number;
  runId: string;
  status: InvokeJsonStatus;
  exitCode: number;
  pausedGate: PausedGateInfo | null;
  artifacts: ArtifactRef[];
  eventLogUri: string;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map the engine's run status and human-gate state to the platform contract
 * status values.
 *
 * - "running" → run is still in progress
 * - "awaiting_human" → run is paused on a human gate
 * - "completed" → all jobs completed successfully
 * - "failed" → one or more jobs failed (with failure_policy: fail)
 * - "cancelled" → run was cancelled via abort or signal
 */
export function mapRunAllStatusToInvokeStatus(
  runStatus: string | undefined,
  hasPausedGate: boolean,
): InvokeJsonStatus {
  if (hasPausedGate) return "awaiting_human";
  if (runStatus === "completed") return "completed";
  if (runStatus === "failed" || runStatus === "blocked") return "failed";
  if (runStatus === "cancelled") return "cancelled";
  return "running";
}

/**
 * Map invoke status to a POSIX exit code.
 *
 * - completed / awaiting_human → 0 (success / paused is not an error)
 * - failed / cancelled → 1
 * - running → 0 (timed out or max iterations, not a failure)
 */
export function statusToExitCode(status: InvokeJsonStatus): number {
  switch (status) {
    case "completed":
    case "awaiting_human":
    case "running":
      return 0;
    case "failed":
    case "cancelled":
      return 1;
  }
}
