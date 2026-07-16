/**
 * Attempt model unit tests for WF-7.1 (Step 1 -- Cases and Tests).
 *
 * Tests the pure-function components of the Execution Attempt Model:
 *   - Attempt data model types and constructors
 *   - FailureKind taxonomy and constants
 *   - RetryPolicy evaluation (when conditions, max_attempts, on_exceeded)
 *   - JobConclusion derivation from attempt history
 *   - classifyFailureKind mapping from old errorType to new FailureKind
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/research/r1-attempt-model.md
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.1-attempt/01-cases-and-tests.md
 *   - docs/architecture.md §6.2, §7.2
 *   - docs/mvp-contracts.md §2.3, §2.6
 *
 * Red-phase note: The types and functions tested here do NOT yet exist in the
 * codebase. The types are declared inline (matching the R1 research report)
 * and the functions are shallow stubs that throw. In the green phase (Step 2),
 * these inline declarations will be replaced by real imports from
 * src/run/index.ts and a new src/engine/attemptModel.ts (or equivalent).
 * Every test below should FAIL for a structural reason — stub throws, or
 * the real implementation does not yet produce the expected result.
 */

import { describe, expect, it } from "vitest";

import type {
  Attempt,
  FailureKind,
  RetryPolicy,
} from "../../src/run/index.js";
import {
  JobConclusion,
  TRANSIENT_FAILURE_KINDS,
  WELL_KNOWN_FAILURE_KINDS,
} from "../../src/run/index.js";
import {
  classifyFailureKind,
  createOpenAttempt,
  deriveJobConclusion,
  retryPolicyAllowsRetry,
  sealAttempt,
} from "../../src/engine/attemptModel.js";

// ============================================================================
// Tests
// ============================================================================

// ---------------------------------------------------------------------------
// T-AM-1..T-AM-5: deriveJobConclusion
// ---------------------------------------------------------------------------

describe("deriveJobConclusion", () => {
  const BASE_ATTEMPT: Attempt = {
    number: 1,
    status: "success",
    started_at: "2026-07-16T00:00:00.000Z",
    ended_at: "2026-07-16T00:01:00.000Z",
    step_count: 3,
  };

  it("T-AM-1: returns 'success' when last attempt is success", () => {
    const attempts: Attempt[] = [
      { ...BASE_ATTEMPT, number: 1, status: "failure", failure_kind: "agent_error" },
      { ...BASE_ATTEMPT, number: 2, status: "success" },
    ];
    expect(deriveJobConclusion(attempts)).toBe("success");
  });

  it("T-AM-2: returns 'failure' when last attempt failed and onExceeded='failed'", () => {
    const attempts: Attempt[] = [
      { ...BASE_ATTEMPT, number: 1, status: "failure", failure_kind: "agent_error" },
      { ...BASE_ATTEMPT, number: 2, status: "failure", failure_kind: "timeout" },
    ];
    expect(deriveJobConclusion(attempts, "failed")).toBe("failure");
  });

  it("T-AM-3: returns 'blocked' when last attempt failed and onExceeded is default", () => {
    const attempts: Attempt[] = [
      { ...BASE_ATTEMPT, number: 1, status: "failure", failure_kind: "agent_error" },
    ];
    expect(deriveJobConclusion(attempts)).toBe("blocked");
  });

  it("T-AM-4: returns 'cancelled' when last attempt is cancelled", () => {
    const attempts: Attempt[] = [
      { ...BASE_ATTEMPT, number: 1, status: "cancelled", failure_reason: "user aborted" },
    ];
    expect(deriveJobConclusion(attempts)).toBe("cancelled");
  });

  it("T-AM-5: returns 'failure' for empty attempts array (defensive)", () => {
    expect(deriveJobConclusion([])).toBe("failure");
  });

  it("T-AM-5b: single success attempt returns 'success'", () => {
    const attempts: Attempt[] = [
      { ...BASE_ATTEMPT, number: 1, status: "success" },
    ];
    expect(deriveJobConclusion(attempts)).toBe("success");
  });

  it("T-AM-5c: success overrides earlier failures (last attempt is success)", () => {
    const attempts: Attempt[] = [
      { ...BASE_ATTEMPT, number: 1, status: "failure", failure_kind: "timeout" },
      { ...BASE_ATTEMPT, number: 2, status: "failure", failure_kind: "infrastructure_error" },
      { ...BASE_ATTEMPT, number: 3, status: "success" },
    ];
    expect(deriveJobConclusion(attempts)).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// T-AM-6..T-AM-11: retryPolicyAllowsRetry
// ---------------------------------------------------------------------------

describe("retryPolicyAllowsRetry", () => {
  it("T-AM-6: returns true for transient kind (timeout) when policy is undefined (default)", () => {
    // Default when absent: TRANSIENT_FAILURE_KINDS = { timeout, infrastructure_error, agent_error }
    expect(retryPolicyAllowsRetry(undefined, "timeout")).toBe(true);
  });

  it("T-AM-6b: returns true for infrastructure_error with default policy", () => {
    expect(retryPolicyAllowsRetry(undefined, "infrastructure_error")).toBe(true);
  });

  it("T-AM-6c: returns true for agent_error with default policy", () => {
    expect(retryPolicyAllowsRetry(undefined, "agent_error")).toBe(true);
  });

  it("T-AM-7: returns false for config_error when policy is undefined (not transient)", () => {
    expect(retryPolicyAllowsRetry(undefined, "config_error")).toBe(false);
  });

  it("T-AM-7b: returns false for permission_denied with default policy", () => {
    expect(retryPolicyAllowsRetry(undefined, "permission_denied")).toBe(false);
  });

  it("T-AM-7c: returns false for invalid_output with default policy", () => {
    expect(retryPolicyAllowsRetry(undefined, "invalid_output")).toBe(false);
  });

  it("T-AM-7d: returns false for cancelled with default policy", () => {
    expect(retryPolicyAllowsRetry(undefined, "cancelled")).toBe(false);
  });

  it("T-AM-8: with explicit when: ['timeout'], only allows timeout", () => {
    const policy: RetryPolicy = { when: ["timeout"] };
    expect(retryPolicyAllowsRetry(policy, "timeout")).toBe(true);
    expect(retryPolicyAllowsRetry(policy, "infrastructure_error")).toBe(false);
    expect(retryPolicyAllowsRetry(policy, "agent_error")).toBe(false);
  });

  it("T-AM-8b: explicit when: ['timeout', 'config_error'] allows both", () => {
    const policy: RetryPolicy = { when: ["timeout", "config_error"] };
    expect(retryPolicyAllowsRetry(policy, "timeout")).toBe(true);
    expect(retryPolicyAllowsRetry(policy, "config_error")).toBe(true);
    expect(retryPolicyAllowsRetry(policy, "infrastructure_error")).toBe(false);
  });

  it("T-AM-9: with empty when: [], returns false for all kinds", () => {
    const policy: RetryPolicy = { when: [] };
    expect(retryPolicyAllowsRetry(policy, "timeout")).toBe(false);
    expect(retryPolicyAllowsRetry(policy, "infrastructure_error")).toBe(false);
    expect(retryPolicyAllowsRetry(policy, "agent_error")).toBe(false);
    expect(retryPolicyAllowsRetry(policy, "config_error")).toBe(false);
  });

  it("T-AM-10: treats unknown failure kind as agent_error for matching with default policy", () => {
    // Default policy includes agent_error, so unknown kinds should match
    const unknownKind = "custom_network_partition" as FailureKind;
    // unknown -> treated as agent_error -> in TRANSIENT -> true
    expect(retryPolicyAllowsRetry(undefined, unknownKind)).toBe(true);
  });

  it("T-AM-10b: unknown failure kind does NOT match when agent_error is excluded", () => {
    const policy: RetryPolicy = { when: ["timeout"] };
    const unknownKind = "custom_network_partition" as FailureKind;
    // unknown -> treated as agent_error -> NOT in [timeout] -> false
    expect(retryPolicyAllowsRetry(policy, unknownKind)).toBe(false);
  });

  it("T-AM-10c: unknown failure kind matches when agent_error is explicitly in when list", () => {
    const policy: RetryPolicy = { when: ["agent_error"] };
    const unknownKind = "custom_network_partition" as FailureKind;
    expect(retryPolicyAllowsRetry(policy, unknownKind)).toBe(true);
  });

  it("T-AM-11: retryPolicyAllowsRetry does NOT check max_attempts (caller responsibility)", () => {
    // This function only checks the `when` filter. It returns true/false based
    // solely on whether the failure_kind matches the policy. max_attempts
    // exhaustion is checked by the caller (engine).
    const policy: RetryPolicy = { when: ["timeout"], max_attempts: 1 };
    // Even with max_attempts: 1, a timeout still "matches" the when filter.
    // The engine checks attempt >= max_attempts separately.
    expect(retryPolicyAllowsRetry(policy, "timeout")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-AM-12..T-AM-15: FailureKind type and constants
// ---------------------------------------------------------------------------

describe("FailureKind taxonomy", () => {
  it("T-AM-12: type accepts the 7 well-known values at compile time", () => {
    // Compile-time test — if this compiles, the type is correct.
    const kinds: FailureKind[] = [
      "timeout",
      "infrastructure_error",
      "invalid_output",
      "agent_error",
      "cancelled",
      "permission_denied",
      "config_error",
    ];
    expect(kinds).toHaveLength(7);
  });

  it("T-AM-13: type accepts custom strings via extension slot", () => {
    // Extension slot (string & {}) allows any string.
    const custom: FailureKind = "custom_disk_full" as FailureKind;
    expect(typeof custom).toBe("string");
  });

  it("T-AM-14: WELL_KNOWN_FAILURE_KINDS contains exactly 7 values", () => {
    expect(WELL_KNOWN_FAILURE_KINDS.size).toBe(7);
    expect(WELL_KNOWN_FAILURE_KINDS.has("timeout")).toBe(true);
    expect(WELL_KNOWN_FAILURE_KINDS.has("infrastructure_error")).toBe(true);
    expect(WELL_KNOWN_FAILURE_KINDS.has("invalid_output")).toBe(true);
    expect(WELL_KNOWN_FAILURE_KINDS.has("agent_error")).toBe(true);
    expect(WELL_KNOWN_FAILURE_KINDS.has("cancelled")).toBe(true);
    expect(WELL_KNOWN_FAILURE_KINDS.has("permission_denied")).toBe(true);
    expect(WELL_KNOWN_FAILURE_KINDS.has("config_error")).toBe(true);
  });

  it("T-AM-15: TRANSIENT_FAILURE_KINDS contains exactly 3 values", () => {
    expect(TRANSIENT_FAILURE_KINDS.size).toBe(3);
    expect(TRANSIENT_FAILURE_KINDS.has("timeout")).toBe(true);
    expect(TRANSIENT_FAILURE_KINDS.has("infrastructure_error")).toBe(true);
    expect(TRANSIENT_FAILURE_KINDS.has("agent_error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-AM-16: Attempt immutability
// ---------------------------------------------------------------------------

describe("Attempt immutability", () => {
  it("T-AM-16: sealed Attempt carries terminal status and ended_at", () => {
    // This is a structural test: a sealed Attempt MUST have status and ended_at.
    const sealed: Attempt = {
      number: 1,
      status: "failure",
      failure_kind: "timeout",
      failure_reason: "backend timed out after 600s",
      started_at: "2026-07-16T00:00:00.000Z",
      ended_at: "2026-07-16T00:10:00.000Z",
      step_count: 2,
    };
    // If Attempt were mutable, we could change these. The type system enforces
    // that status is always one of the three terminal values for a sealed Attempt.
    expect(sealed.status).toBe("failure");
    expect(sealed.ended_at).toBeTruthy();
    expect(sealed.started_at).toBeTruthy();
    // ended_at must be >= started_at
    expect(new Date(sealed.ended_at!).getTime()).toBeGreaterThanOrEqual(
      new Date(sealed.started_at).getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// T-AM-17..T-AM-18: createOpenAttempt and sealAttempt
// ---------------------------------------------------------------------------

describe("createOpenAttempt and sealAttempt factories", () => {
  const START_ISO = "2026-07-16T00:00:00.000Z";

  it("T-AM-17: createOpenAttempt produces record with unset ended_at and step_count=0", () => {
    const open = createOpenAttempt(1, START_ISO);
    expect(open.number).toBe(1);
    expect(open.started_at).toBe(START_ISO);
    expect(open.step_count).toBe(0);
    // In green phase, the open attempt should have no status or ended_at yet
  });

  it("T-AM-17b: createOpenAttempt with initiation_reason", () => {
    const open = createOpenAttempt(2, START_ISO, "retry after timeout");
    expect(open.number).toBe(2);
    expect(open.initiation_reason).toBe("retry after timeout");
  });

  it("T-AM-18: sealAttempt sets ended_at, status, step_count, and failure details", () => {
    const END_ISO = "2026-07-16T00:05:00.000Z";
    const open = createOpenAttempt(1, START_ISO);
    const sealed = sealAttempt(open, "success", END_ISO, 4, {
      outputs: { result: "done" },
    });
    expect(sealed.status).toBe("success");
    expect(sealed.ended_at).toBe(END_ISO);
    expect(sealed.step_count).toBe(4);
    expect(sealed.outputs).toEqual({ result: "done" });
    expect(sealed.failure_kind).toBeUndefined();
    expect(sealed.failure_reason).toBeUndefined();
  });

  it("T-AM-18b: sealAttempt with failure status populates failure_kind and failure_reason", () => {
    const END_ISO = "2026-07-16T00:05:00.000Z";
    const open = createOpenAttempt(1, START_ISO);
    const sealed = sealAttempt(open, "failure", END_ISO, 3, {
      failure_kind: "timeout",
      failure_reason: "backend timed out",
    });
    expect(sealed.status).toBe("failure");
    expect(sealed.failure_kind).toBe("timeout");
    expect(sealed.failure_reason).toBe("backend timed out");
    expect(sealed.step_count).toBe(3);
  });

  it("T-AM-18c: sealAttempt with cancelled status", () => {
    const END_ISO = "2026-07-16T00:01:00.000Z";
    const open = createOpenAttempt(1, START_ISO);
    const sealed = sealAttempt(open, "cancelled", END_ISO, 1, {
      failure_reason: "user aborted",
    });
    expect(sealed.status).toBe("cancelled");
    // cancelled is NOT a failure; failure_kind should not be set for pure cancellation
    expect(sealed.failure_reason).toBe("user aborted");
  });
});

// ---------------------------------------------------------------------------
// T-AM-19..T-AM-20: classifyFailureKind mapping
// ---------------------------------------------------------------------------

describe("classifyFailureKind", () => {
  it("T-AM-19: maps 'timeout' -> 'timeout'", () => {
    expect(classifyFailureKind("timeout")).toBe("timeout");
  });

  it("T-AM-19b: maps 'config' -> 'config_error'", () => {
    expect(classifyFailureKind("config")).toBe("config_error");
  });

  it("T-AM-19c: maps 'permission' -> 'permission_denied'", () => {
    expect(classifyFailureKind("permission")).toBe("permission_denied");
  });

  it("T-AM-19d: maps 'execution' -> 'agent_error'", () => {
    expect(classifyFailureKind("execution")).toBe("agent_error");
  });

  it("T-AM-20: defaults to 'agent_error' for undefined errorType", () => {
    expect(classifyFailureKind(undefined)).toBe("agent_error");
  });
});

// ---------------------------------------------------------------------------
// T-AM-21: Attempt numbering is 1-based and monotonic
// ---------------------------------------------------------------------------

describe("Attempt numbering contract", () => {
  const START_ISO = "2026-07-16T00:00:00.000Z";

  it("T-AM-21: initial attempt is numbered 1", () => {
    const open = createOpenAttempt(1, START_ISO);
    expect(open.number).toBe(1);
  });

  it("T-AM-21b: retry attempt is numbered 2 (or higher)", () => {
    const open = createOpenAttempt(2, START_ISO, "retry after timeout");
    expect(open.number).toBe(2);
  });

  it("T-AM-21c: attempt history is monotonic within a job", () => {
    // Simulate: attempt 1 fails, attempt 2 succeeds
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        failure_kind: "timeout",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:05:00.000Z",
        step_count: 3,
        failure_reason: "timeout",
      },
      {
        number: 2,
        status: "success",
        started_at: "2026-07-16T00:05:01.000Z",
        ended_at: "2026-07-16T00:10:00.000Z",
        step_count: 5,
        initiation_reason: "retry after timeout",
        outputs: { result: "done" },
      },
    ];
    // Verify numbering
    expect(attempts[0]!.number).toBe(1);
    expect(attempts[1]!.number).toBe(2);
    // Verify monotonic
    for (let i = 1; i < attempts.length; i++) {
      expect(attempts[i]!.number).toBeGreaterThan(attempts[i - 1]!.number!);
    }
    // Verify conclusion: last attempt success
    expect(deriveJobConclusion(attempts)).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// T-AM-22: retry policy on_exceeded defaults
// ---------------------------------------------------------------------------

describe("RetryPolicy.on_exceeded defaults", () => {
  it("T-AM-22: on_exceeded.status defaults to 'blocked'", () => {
    // This is tested via deriveJobConclusion: when onExceeded is not passed,
    // it defaults to "blocked".
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        failure_kind: "config_error",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    // Default (no second argument) should produce "blocked"
    const conclusion = deriveJobConclusion(attempts);
    expect(conclusion).toBe("blocked");
  });

  it("T-AM-22b: on_exceeded.status='failed' produces 'failure' conclusion", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        failure_kind: "config_error",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    const conclusion = deriveJobConclusion(attempts, "failed");
    expect(conclusion).toBe("failure");
  });
});

// ============================================================================
// Type-level compile-time checks (these always pass; they guard the type system)
// ============================================================================

describe("Type-level contracts", () => {
  it("JobConclusion enum covers all 4 original values plus success_with_warnings", () => {
    const conclusions = [
      JobConclusion.Success,
      JobConclusion.Failure,
      JobConclusion.Blocked,
      JobConclusion.Cancelled,
      JobConclusion.SuccessWithWarnings,
    ];
    expect(conclusions).toHaveLength(5);
  });

  it("Attempt.status union covers all 3 terminal values", () => {
    const statuses: Attempt["status"][] = ["success", "failure", "cancelled"];
    expect(statuses).toHaveLength(3);
  });

  it("RetryPolicy allows reserved max_delay_ms", () => {
    const policy: RetryPolicy = {
      max_attempts: 3,
      when: ["timeout"],
      on_exceeded: { status: "blocked" },
      max_delay_ms: 5000, // reserved for v0.8, not enforced
    };
    expect(policy.max_delay_ms).toBe(5000);
  });
});

// ============================================================================
// deriveJobConclusion with failurePolicy (WF-7.3b)
// ============================================================================

describe("deriveJobConclusion with failurePolicy (WF-7.3b)", () => {
  it("failurePolicy 'continue' returns success_with_warnings when last attempt failed (T-AM-FP-1)", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    expect(deriveJobConclusion(attempts, "blocked", "continue")).toBe("success_with_warnings");
  });

  it("failurePolicy 'continue' with onExceeded failed returns success_with_warnings (T-AM-FP-2)", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    // When failurePolicy is "continue", onExceeded is ignored
    expect(deriveJobConclusion(attempts, "failed", "continue")).toBe("success_with_warnings");
  });

  it("failurePolicy 'continue' with last success returns success (T-AM-FP-3)", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "success",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    expect(deriveJobConclusion(attempts, "blocked", "continue")).toBe("success");
  });

  it("failurePolicy 'block' returns blocked when last attempt failed (T-AM-FP-4)", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    expect(deriveJobConclusion(attempts, "blocked", "block")).toBe("blocked");
  });

  it("failurePolicy 'block' with onExceeded failed still returns blocked (T-AM-FP-5)", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    // When failurePolicy is "block", onExceeded is ignored
    expect(deriveJobConclusion(attempts, "failed", "block")).toBe("blocked");
  });

  it("failurePolicy 'fail' (default) uses onExceeded (T-AM-FP-6)", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    expect(deriveJobConclusion(attempts, "blocked", "fail")).toBe("blocked");
  });

  it("failurePolicy undefined (not provided) uses onExceeded default (T-AM-FP-7)", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "failure",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    // No failurePolicy passed — should use onExceeded default
    const result = deriveJobConclusion(attempts);
    expect(result).toBe("blocked");
  });

  it("failurePolicy 'continue' with cancelled last attempt returns cancelled (T-AM-FP-8)", () => {
    const attempts: Attempt[] = [
      {
        number: 1,
        status: "cancelled",
        started_at: "2026-07-16T00:00:00.000Z",
        ended_at: "2026-07-16T00:01:00.000Z",
        step_count: 1,
      },
    ];
    // Cancelled takes precedence over failure_policy
    expect(deriveJobConclusion(attempts, "blocked", "continue")).toBe("cancelled");
  });

  it("failurePolicy 'continue' for empty attempts returns failure (T-AM-FP-9)", () => {
    // Empty attempts always returns "failure"
    expect(deriveJobConclusion([], "blocked", "continue")).toBe("failure");
  });
});
