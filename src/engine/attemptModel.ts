/**
 * Attempt Model — pure helper functions for the Execution Attempt model (WF-7.1).
 *
 * Contains stateless, side-effect-free functions for attempt lifecycle management,
 * failure kind classification, retry policy evaluation, and job conclusion derivation.
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/research/r1-attempt-model.md
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.1-attempt/01-cases-and-tests.md
 */

import type { Attempt, FailureKind, RetryPolicy } from "../run/index.js";
import { TRANSIENT_FAILURE_KINDS, WELL_KNOWN_FAILURE_KINDS } from "../run/index.js";

// ---------------------------------------------------------------------------
// JobConclusion derivation
// ---------------------------------------------------------------------------

/**
 * Derives the job conclusion from the attempt history.
 * Pure function — no side effects, no file I/O.
 *
 * Rules:
 * - Empty attempts → "failure" (defensive: should not happen)
 * - Last attempt success → "success"
 * - Last attempt cancelled → "cancelled"
 * - Last attempt failure:
 *   - failurePolicy === "continue" → "success_with_warnings"
 *   - failurePolicy === "block" → "blocked"
 *   - otherwise → onExceeded ("blocked" or "failed", default "blocked")
 *
 * When failurePolicy is "continue", return "success_with_warnings"
 * regardless of onExceeded.
 */
export function deriveJobConclusion(
  attempts: Attempt[],
  onExceeded: "blocked" | "failed" = "blocked",
  failurePolicy?: "fail" | "continue" | "block",
): "success" | "failure" | "blocked" | "cancelled" | "success_with_warnings" {
  if (attempts.length === 0) return "failure";

  const last = attempts[attempts.length - 1]!;
  if (last.status === "success") return "success";
  if (last.status === "cancelled") return "cancelled";

  // last.status === "failure" — apply failure policy
  if (failurePolicy === "continue") return "success_with_warnings";

  // When "block" policy, always return blocked (ignores onExceeded)
  if (failurePolicy === "block") return "blocked";

  // Default or "fail" policy: use existing onExceeded behavior
  return onExceeded === "failed" ? "failure" : onExceeded;
}

// ---------------------------------------------------------------------------
// Retry policy evaluation
// ---------------------------------------------------------------------------

/**
 * Determines whether a retry is allowed given the policy and failure context.
 *
 * Rules:
 * - When `when` is absent: defaults to TRANSIENT_FAILURE_KINDS
 * - When `when` is present: only listed kinds trigger retry
 * - When `when` is empty ([]): never retry
 * - Unknown failure kinds: treated as "agent_error" for matching
 *
 * Returns true if retry should be attempted, false otherwise.
 * Does NOT check max_attempts — that is the caller's responsibility.
 */
export function retryPolicyAllowsRetry(
  policy: RetryPolicy | undefined,
  failureKind: FailureKind,
): boolean {
  // Resolve the effective when-list
  let allowedKinds: ReadonlySet<FailureKind>;
  if (policy === undefined || policy.when === undefined) {
    allowedKinds = TRANSIENT_FAILURE_KINDS;
  } else {
    allowedKinds = new Set(policy.when);
  }

  // Normalize unknown failure kinds to "agent_error" for matching
  const effectiveKind: FailureKind =
    WELL_KNOWN_FAILURE_KINDS.has(failureKind) ? failureKind : "agent_error";

  return allowedKinds.has(effectiveKind);
}

// ---------------------------------------------------------------------------
// FailureKind classification
// ---------------------------------------------------------------------------

/**
 * Maps the old `errorType` string (from recordAgentFailure.ts) to the new
 * FailureKind taxonomy.
 *
 * Mapping:
 *   "config"     → "config_error"
 *   "permission" → "permission_denied"
 *   "timeout"    → "timeout"
 *   "execution"   → "agent_error"
 *   undefined    → "agent_error" (default)
 */
export function classifyFailureKind(
  errorType?: "config" | "permission" | "timeout" | "execution",
): FailureKind {
  switch (errorType) {
    case "config":
      return "config_error";
    case "permission":
      return "permission_denied";
    case "timeout":
      return "timeout";
    case "execution":
      return "agent_error";
    default:
      return "agent_error";
  }
}

// ---------------------------------------------------------------------------
// Attempt factory functions
// ---------------------------------------------------------------------------

/** The shape of an open (in-progress) attempt before it is sealed. */
export interface OpenAttempt {
  number: number;
  status?: "success" | "failure" | "cancelled";
  failure_kind?: FailureKind;
  failure_reason?: string;
  started_at: string;
  ended_at?: string;
  step_count: number;
  outputs?: Record<string, unknown>;
  retry_inputs?: Record<string, string>;
  initiation_reason?: string;
}

/**
 * Creates a new open Attempt record when a job transition starts.
 *
 * @param number - per-job monotonic attempt number (1-based)
 * @param startedAt - ISO 8601 timestamp (same clock call as attempt_started event)
 * @param initiationReason - why this attempt was started (undefined for initial attempt)
 */
export function createOpenAttempt(
  number: number,
  startedAt: string,
  initiationReason?: string,
): OpenAttempt {
  const attempt: OpenAttempt = {
    number,
    started_at: startedAt,
    step_count: 0,
  };
  if (initiationReason !== undefined) {
    attempt.initiation_reason = initiationReason;
  }
  return attempt;
}

/**
 * Seals an open Attempt with its terminal status.
 *
 * @param attempt - the open attempt (status/ended_at not yet set)
 * @param status - terminal status: "success", "failure", or "cancelled"
 * @param endedAt - ISO 8601 timestamp (same clock call as terminal event)
 * @param stepCount - number of steps executed in this attempt
 * @param opts - optional failure details (required when status is "failure")
 */
export function sealAttempt(
  attempt: OpenAttempt,
  status: "success" | "failure" | "cancelled",
  endedAt: string,
  stepCount: number,
  opts?: { failure_kind?: FailureKind; failure_reason?: string; outputs?: Record<string, unknown> },
): Attempt {
  const sealed: Attempt = {
    number: attempt.number,
    status,
    started_at: attempt.started_at,
    ended_at: endedAt,
    step_count: stepCount,
    ...(attempt.initiation_reason !== undefined ? { initiation_reason: attempt.initiation_reason } : {}),
    ...(attempt.retry_inputs !== undefined ? { retry_inputs: attempt.retry_inputs } : {}),
    ...(attempt.outputs !== undefined ? { outputs: attempt.outputs } : {}),
  };

  if (opts?.failure_kind !== undefined) {
    sealed.failure_kind = opts.failure_kind;
  }
  if (opts?.failure_reason !== undefined) {
    sealed.failure_reason = opts.failure_reason;
  }
  if (opts?.outputs !== undefined) {
    sealed.outputs = opts.outputs;
  }

  return sealed;
}
