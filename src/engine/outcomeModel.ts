/**
 * Outcome/Conclusion Model — pure mapping functions for WF-7.3a.
 *
 * Contains stateless, side-effect-free functions for computing job, iteration,
 * and run conclusions from attempt outcomes.
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/research/r4-failure-policy-cascade.md
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.3-execution-strategy/01-cases-and-tests.md
 */

import {
  AttemptOutcome,
  JobConclusion,
  IterationConclusion,
} from "../run/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailurePolicy = "fail" | "continue" | "block";

// ---------------------------------------------------------------------------
// computeJobConclusion
// ---------------------------------------------------------------------------

/**
 * Compute the JobConclusion from all attempt outcomes and the failure policy.
 *
 * Rules (from R4 decision E2):
 *   1. Any successful attempt -> Success
 *   2. Any cancelled attempt -> Cancelled (cancelled dominates)
 *   3. All failed/timeout -> evaluate failure_policy:
 *      - "fail" -> Failure
 *      - "continue" -> SuccessWithWarnings
 *      - "block" -> Blocked
 *   4. Empty attempts -> Failure (conservative default)
 */
export function computeJobConclusion(
  attempts: Array<{ outcome: AttemptOutcome }>,
  failurePolicy: FailurePolicy,
): JobConclusion {
  // Empty attempts -> Failure
  if (attempts.length === 0) return JobConclusion.Failure;

  // Check for cancelled first (cancelled dominates)
  const anyCancelled = attempts.some(
    (a) => a.outcome === AttemptOutcome.Cancelled,
  );
  if (anyCancelled) return JobConclusion.Cancelled;

  // Check for success
  const anySuccess = attempts.some(
    (a) => a.outcome === AttemptOutcome.Success,
  );
  if (anySuccess) return JobConclusion.Success;

  // All failed or timed out -> evaluate failure_policy
  switch (failurePolicy) {
    case "fail":
      return JobConclusion.Failure;
    case "continue":
      return JobConclusion.SuccessWithWarnings;
    case "block":
      return JobConclusion.Blocked;
  }
}

// ---------------------------------------------------------------------------
// computeIterationConclusion
// ---------------------------------------------------------------------------

/**
 * Compute iteration-level conclusion from job conclusions and their failure policies.
 *
 * Rules (from R4 decision F2):
 *   1. Any Blocked -> Blocked
 *   2. Any critical job (failure_policy === "fail") with Failure -> Failure
 *   3. Any job with SuccessWithWarnings, or non-critical job
 *      (failure_policy !== "fail") with Failure -> SuccessWithWarnings
 *   4. Otherwise (all Success) -> Success
 *   5. Empty jobs array -> Success
 */
export function computeIterationConclusion(
  jobs: Array<{
    conclusion: JobConclusion;
    failurePolicy: FailurePolicy;
  }>,
): IterationConclusion {
  // Empty jobs -> Success
  if (jobs.length === 0) return IterationConclusion.Success;

  // Check for Blocked first (blocked dominates)
  const hasBlocked = jobs.some(
    (j) => j.conclusion === JobConclusion.Blocked,
  );
  if (hasBlocked) return IterationConclusion.Blocked;

  // Critical job (failure_policy === "fail") with Failure -> Failure
  const hasCriticalFailure = jobs.some(
    (j) => j.failurePolicy === "fail" && j.conclusion === JobConclusion.Failure,
  );
  if (hasCriticalFailure) return IterationConclusion.Failure;

  // Any job with SuccessWithWarnings conclusion, or any non-critical job
  // (failure_policy !== "fail") with Failure -> SuccessWithWarnings
  const hasWarnings = jobs.some(
    (j) =>
      j.conclusion === JobConclusion.SuccessWithWarnings ||
      (j.conclusion === JobConclusion.Failure && j.failurePolicy !== "fail"),
  );
  if (hasWarnings) return IterationConclusion.SuccessWithWarnings;

  // All Success
  return IterationConclusion.Success;
}

// ---------------------------------------------------------------------------
// computeRunConclusion
// ---------------------------------------------------------------------------

/**
 * Aggregate iteration conclusions to derive the run-level conclusion.
 *
 * Rules:
 *   1. Any Blocked -> Blocked
 *   2. Any Failure -> Failure
 *   3. Any SuccessWithWarnings -> SuccessWithWarnings
 *   4. All Success -> Success
 *   5. Empty -> Success (no iterations = no problems)
 */
export function computeRunConclusion(
  iterations: Array<IterationConclusion>,
): IterationConclusion {
  // Empty -> Success
  if (iterations.length === 0) return IterationConclusion.Success;

  // Check for Blocked first (blocked dominates)
  const hasBlocked = iterations.some(
    (i) => i === IterationConclusion.Blocked,
  );
  if (hasBlocked) return IterationConclusion.Blocked;

  // Check for Failure
  const hasFailure = iterations.some(
    (i) => i === IterationConclusion.Failure,
  );
  if (hasFailure) return IterationConclusion.Failure;

  // Check for SuccessWithWarnings
  const hasWarnings = iterations.some(
    (i) => i === IterationConclusion.SuccessWithWarnings,
  );
  if (hasWarnings) return IterationConclusion.SuccessWithWarnings;

  // All Success
  return IterationConclusion.Success;
}
