/**
 * Outcome/Conclusion model unit tests for WF-7.3a (Step 1 -- Cases and Tests).
 *
 * Tests the pure-function components of the Outcome/Conclusion Model:
 *   - AttemptOutcome enum values
 *   - JobConclusion enum values (extended with success_with_warnings)
 *   - IterationConclusion enum values
 *   - computeJobConclusion() pure mapping function
 *   - computeIterationConclusion() pure mapping function
 *   - computeRunConclusion() pure mapping function
 *   - Backward compat: existing JobConclusion type from src/run/index.ts
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/research/r4-failure-policy-cascade.md
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.3-execution-strategy/01-cases-and-tests.md
 *   - docs/architecture.md section 7.4, 10
 *   - docs/mvp-contracts.md section 2.3
 */

import { describe, expect, it } from "vitest";

import {
  AttemptOutcome,
  JobConclusion,
  IterationConclusion,
} from "../../src/run/index.js";
import {
  computeJobConclusion,
  computeIterationConclusion,
  computeRunConclusion,
} from "../../src/engine/outcomeModel.js";
import type { FailurePolicy } from "../../src/engine/outcomeModel.js";

// ============================================================================
// 1. AttemptOutcome enum values  (FP-1.4.1, UC-1.4.4a-g)
// ============================================================================

describe("AttemptOutcome enum (FP-1.4.1)", () => {
  it("has four distinct values", () => {
    expect(AttemptOutcome.Success).toBe("success");
    expect(AttemptOutcome.Failure).toBe("failure");
    expect(AttemptOutcome.Timeout).toBe("timeout");
    expect(AttemptOutcome.Cancelled).toBe("cancelled");
  });

  it("all values are unique", () => {
    const values = Object.values(AttemptOutcome);
    expect(new Set(values).size).toBe(values.length);
  });

  it("values are stable (string form)", () => {
    expect(typeof AttemptOutcome.Success).toBe("string");
    expect(typeof AttemptOutcome.Failure).toBe("string");
    expect(typeof AttemptOutcome.Timeout).toBe("string");
    expect(typeof AttemptOutcome.Cancelled).toBe("string");
  });

  it("attempt outcome values match research report specification", () => {
    const expected = ["success", "failure", "timeout", "cancelled"];
    const actual = Object.values(AttemptOutcome).sort();
    expect(actual).toEqual(expected.sort());
  });
});

// ============================================================================
// 2. JobConclusion enum values (FP-1.4.2, FP-1.4.7)
// ============================================================================

describe("JobConclusion enum (FP-1.4.2)", () => {
  it("has five distinct values including success_with_warnings", () => {
    expect(JobConclusion.Success).toBe("success");
    expect(JobConclusion.SuccessWithWarnings).toBe("success_with_warnings");
    expect(JobConclusion.Failure).toBe("failure");
    expect(JobConclusion.Blocked).toBe("blocked");
    expect(JobConclusion.Cancelled).toBe("cancelled");
  });

  it("all values are unique", () => {
    const values = Object.values(JobConclusion);
    expect(new Set(values).size).toBe(values.length);
  });

  it("values are stable (string form)", () => {
    expect(typeof JobConclusion.Success).toBe("string");
    expect(typeof JobConclusion.SuccessWithWarnings).toBe("string");
  });

  it("includes success_with_warnings (R4 cross-research reconciliation)", () => {
    const hasSw = Object.values(JobConclusion).includes(JobConclusion.SuccessWithWarnings);
    expect(hasSw).toBe(true);
  });

  it("maintains backward compat with existing type values", () => {
    const existingValues = ["success", "failure", "blocked", "cancelled"];
    for (const v of existingValues) {
      expect(Object.values(JobConclusion)).toContain(v);
    }
  });
});

// ============================================================================
// 3. IterationConclusion enum values (FP-1.4.3)
// ============================================================================

describe("IterationConclusion enum (FP-1.4.3)", () => {
  it("has four distinct values", () => {
    expect(IterationConclusion.Success).toBe("success");
    expect(IterationConclusion.SuccessWithWarnings).toBe("success_with_warnings");
    expect(IterationConclusion.Failure).toBe("failure");
    expect(IterationConclusion.Blocked).toBe("blocked");
  });

  it("all values are unique", () => {
    const values = Object.values(IterationConclusion);
    expect(new Set(values).size).toBe(values.length);
  });

  it("does NOT include cancelled", () => {
    const values = Object.values(IterationConclusion);
    expect(values).not.toContain("cancelled");
    expect(values).not.toContain("cancel");
  });

  it("IterationConclusion and JobConclusion are distinct types", () => {
    const icVals = Object.values(IterationConclusion).sort();
    const jcVals = Object.values(JobConclusion).sort();
    expect(icVals).not.toEqual(jcVals);
  });
});

// ============================================================================
// 4. computeJobConclusion (FP-1.4.4)
// ============================================================================

describe("computeJobConclusion (FP-1.4.4)", () => {
  it("UC-1.4.4a: returns Success when any attempt succeeded", () => {
    const attempts = [
      { outcome: AttemptOutcome.Failure },
      { outcome: AttemptOutcome.Success },
    ];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Success);
  });

  it("UC-1.4.4a (variant): single successful attempt -> Success", () => {
    const attempts = [{ outcome: AttemptOutcome.Success }];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Success);
  });

  it("UC-1.4.4b: all failed with failure_policy 'fail' -> Failure", () => {
    const attempts = [
      { outcome: AttemptOutcome.Failure },
      { outcome: AttemptOutcome.Failure },
    ];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Failure);
  });

  it("UC-1.4.4b (variant): single failure with failure_policy 'fail' -> Failure", () => {
    const attempts = [{ outcome: AttemptOutcome.Failure }];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Failure);
  });

  it("UC-1.4.4c: all failed with failure_policy 'continue' -> SuccessWithWarnings", () => {
    const attempts = [
      { outcome: AttemptOutcome.Timeout },
      { outcome: AttemptOutcome.Failure },
    ];
    expect(computeJobConclusion(attempts, "continue")).toBe(
      JobConclusion.SuccessWithWarnings,
    );
  });

  it("UC-1.4.4d: all failed with failure_policy 'block' -> Blocked", () => {
    const attempts = [{ outcome: AttemptOutcome.Failure }];
    expect(computeJobConclusion(attempts, "block")).toBe(JobConclusion.Blocked);
  });

  it("UC-1.4.4e: cancelled attempt dominates regardless of failure_policy", () => {
    const attempts = [{ outcome: AttemptOutcome.Cancelled }];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Cancelled);
    expect(computeJobConclusion(attempts, "continue")).toBe(JobConclusion.Cancelled);
    expect(computeJobConclusion(attempts, "block")).toBe(JobConclusion.Cancelled);
  });

  it("UC-1.4.4f: mixed failure then cancelled -> Cancelled", () => {
    const attempts = [
      { outcome: AttemptOutcome.Failure },
      { outcome: AttemptOutcome.Cancelled },
    ];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Cancelled);
  });

  it("UC-1.4.4g: failure then success -> Success", () => {
    const attempts = [
      { outcome: AttemptOutcome.Failure },
      { outcome: AttemptOutcome.Success },
    ];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Success);
  });

  it("UC-1.4.4h: empty attempts -> Failure (conservative default)", () => {
    const attempts: Array<{ outcome: AttemptOutcome }> = [];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Failure);
  });

  it("timeout-only attempts with failure_policy 'fail' -> Failure", () => {
    const attempts = [{ outcome: AttemptOutcome.Timeout }];
    expect(computeJobConclusion(attempts, "fail")).toBe(JobConclusion.Failure);
  });
});

// ============================================================================
// 5. computeIterationConclusion (FP-1.4.5)
// ============================================================================

describe("computeIterationConclusion (FP-1.4.5)", () => {
  it("UC-1.4.5a: all jobs succeeded -> Success", () => {
    const jobs = [
      { conclusion: JobConclusion.Success, failurePolicy: "fail" as const },
      { conclusion: JobConclusion.Success, failurePolicy: "fail" as const },
    ];
    expect(computeIterationConclusion(jobs)).toBe(IterationConclusion.Success);
  });

  it("UC-1.4.5b: one critical job failed -> Failure", () => {
    const jobs = [
      { conclusion: JobConclusion.Success, failurePolicy: "fail" as const },
      { conclusion: JobConclusion.Failure, failurePolicy: "fail" as const },
    ];
    expect(computeIterationConclusion(jobs)).toBe(IterationConclusion.Failure);
  });

  it("UC-1.4.5c: non-critical job failure -> SuccessWithWarnings", () => {
    const jobs = [
      { conclusion: JobConclusion.Success, failurePolicy: "fail" as const },
      {
        conclusion: JobConclusion.SuccessWithWarnings,
        failurePolicy: "continue" as const,
      },
    ];
    expect(computeIterationConclusion(jobs)).toBe(
      IterationConclusion.SuccessWithWarnings,
    );
  });

  it("UC-1.4.5d: mixed non-critical failure + success -> SuccessWithWarnings", () => {
    const jobs = [
      { conclusion: JobConclusion.Success, failurePolicy: "fail" as const },
      {
        conclusion: JobConclusion.Failure,
        failurePolicy: "continue" as const,
      },
      { conclusion: JobConclusion.Success, failurePolicy: "fail" as const },
    ];
    expect(computeIterationConclusion(jobs)).toBe(
      IterationConclusion.SuccessWithWarnings,
    );
  });

  it("UC-1.4.5e: one job blocked -> Blocked", () => {
    const jobs = [
      { conclusion: JobConclusion.Success, failurePolicy: "fail" as const },
      { conclusion: JobConclusion.Blocked, failurePolicy: "block" as const },
    ];
    expect(computeIterationConclusion(jobs)).toBe(IterationConclusion.Blocked);
  });

  it("UC-1.4.5f: empty jobs array -> Success", () => {
    const jobs: Array<{
      conclusion: JobConclusion;
      failurePolicy: FailurePolicy;
    }> = [];
    expect(computeIterationConclusion(jobs)).toBe(IterationConclusion.Success);
  });

  it("blocked dominates failure (priority order)", () => {
    const jobs = [
      { conclusion: JobConclusion.Failure, failurePolicy: "fail" as const },
      { conclusion: JobConclusion.Blocked, failurePolicy: "block" as const },
    ];
    expect(computeIterationConclusion(jobs)).toBe(IterationConclusion.Blocked);
  });

  it("failure dominates success_with_warnings (priority order)", () => {
    const jobs = [
      {
        conclusion: JobConclusion.SuccessWithWarnings,
        failurePolicy: "continue" as const,
      },
      { conclusion: JobConclusion.Failure, failurePolicy: "fail" as const },
    ];
    expect(computeIterationConclusion(jobs)).toBe(IterationConclusion.Failure);
  });
});

// ============================================================================
// 6. computeRunConclusion (FP-1.4.6)
// ============================================================================

describe("computeRunConclusion (FP-1.4.6)", () => {
  it("UC-1.4.6a: all iterations succeeded -> Success", () => {
    const iterations = [
      IterationConclusion.Success,
      IterationConclusion.Success,
    ];
    expect(computeRunConclusion(iterations)).toBe(IterationConclusion.Success);
  });

  it("UC-1.4.6b: one iteration failed -> Failure", () => {
    const iterations = [
      IterationConclusion.Success,
      IterationConclusion.Failure,
      IterationConclusion.Success,
    ];
    expect(computeRunConclusion(iterations)).toBe(IterationConclusion.Failure);
  });

  it("UC-1.4.6c: mixed success and success_with_warnings -> SuccessWithWarnings", () => {
    const iterations = [
      IterationConclusion.Success,
      IterationConclusion.SuccessWithWarnings,
    ];
    expect(computeRunConclusion(iterations)).toBe(
      IterationConclusion.SuccessWithWarnings,
    );
  });

  it("UC-1.4.6d: empty iterations -> Success", () => {
    const iterations: Array<IterationConclusion> = [];
    expect(computeRunConclusion(iterations)).toBe(IterationConclusion.Success);
  });

  it("blocked dominates failure (priority order)", () => {
    const iterations = [
      IterationConclusion.Failure,
      IterationConclusion.Blocked,
    ];
    expect(computeRunConclusion(iterations)).toBe(IterationConclusion.Blocked);
  });

  it("failure dominates success_with_warnings (priority order)", () => {
    const iterations = [
      IterationConclusion.SuccessWithWarnings,
      IterationConclusion.Failure,
    ];
    expect(computeRunConclusion(iterations)).toBe(IterationConclusion.Failure);
  });

  it("single iteration conclusion is passed through", () => {
    expect(computeRunConclusion([IterationConclusion.Success])).toBe(
      IterationConclusion.Success,
    );
    expect(computeRunConclusion([IterationConclusion.Failure])).toBe(
      IterationConclusion.Failure,
    );
    expect(computeRunConclusion([IterationConclusion.Blocked])).toBe(
      IterationConclusion.Blocked,
    );
    expect(
      computeRunConclusion([IterationConclusion.SuccessWithWarnings]),
    ).toBe(IterationConclusion.SuccessWithWarnings);
  });
});

// ============================================================================
// 7. Backward compat: existing JobConclusion type (FP-1.4.7)
// ============================================================================

describe("JobConclusion backward compat (FP-1.4.7)", () => {
  it("the existing JobConclusion type alias (src/run/index.ts) compiles with values from the enum", () => {
    const enumValues = Object.values(JobConclusion);
    expect(enumValues.length).toBe(5);
    expect(enumValues).toContain("success_with_warnings");
  });

  it("existing code paths that use 'success' | 'failure' | 'blocked' | 'cancelled' are compatible", () => {
    const oldValues = ["success", "failure", "blocked", "cancelled"];
    const enumValues = Object.values(JobConclusion);
    for (const v of oldValues) {
      expect(enumValues).toContain(v);
    }
  });
});
