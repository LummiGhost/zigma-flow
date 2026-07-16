/**
 * RED-phase tests for WF-7.3a Expression Context extensions and status function pre-resolution.
 *
 * Tests:
 *   - resolveExpression — invocation namespace (FP-1.1.1)
 *   - resolveExpression — attempt namespace (FP-1.1.2)
 *   - resolveExpression — jobs.<id>.status / .attempt (FP-1.1.3)
 *   - resolveExpression — steps.<id>.status (FP-1.1.4)
 *   - evaluateCondition — status function pre-resolution (FP-1.2.1--1.2.10)
 *   - evaluateCondition — StatusScope parameter (FP-1.2.3)
 *   - buildExpressionContext — centralized builder (FP-1.3.1--1.3.8)
 *
 * Reference:
 *   - docs/phases/v0.7-execution-model/workflows/wf-7.3-execution-strategy/01-cases-and-tests.md
 */

import { describe, expect, it } from "vitest";

import {
  resolveExpression,
  evaluateCondition,
  resolveStatusFunctions,
} from "../../src/expression/index.js";
import type {
  ExpressionContext,
  StatusScope,
} from "../../src/expression/index.js";
import { buildExpressionContext } from "../../src/context/index.js";
import type { BuildExpressionContextOpts } from "../../src/context/index.js";

// ============================================================================
// 1. resolveExpression — invocation namespace (FP-1.1.1)
// ============================================================================

describe("resolveExpression — invocation namespace (FP-1.1.1)", () => {
  const ctx: ExpressionContext = {
    inputs: { task: "test" },
    run: { id: "run-1", workflow: "test-wf" },
    invocation: {
      trigger: "manual",
      backend: "claude-code",
    },
  };

  it("UC-1.1.1a: ${{ invocation.trigger }} resolves to 'manual' for CLI-invoked runs", () => {
    expect(resolveExpression("${{ invocation.trigger }}", ctx)).toBe("manual");
  });

  it("UC-1.1.1b: ${{ invocation.trigger }} resolves to 'scheduled' for scheduled runs", () => {
    const schedCtx: ExpressionContext = {
      ...ctx,
      invocation: { trigger: "scheduled" },
    };
    expect(resolveExpression("${{ invocation.trigger }}", schedCtx)).toBe("scheduled");
  });

  it("UC-1.1.1c: ${{ invocation.trigger }} resolves to 'resume' for resumed runs", () => {
    const resumeCtx: ExpressionContext = {
      ...ctx,
      invocation: { trigger: "resume" },
    };
    expect(resolveExpression("${{ invocation.trigger }}", resumeCtx)).toBe("resume");
  });

  it("UC-1.1.1d: ${{ invocation.backend }} resolves to the backend name string", () => {
    expect(resolveExpression("${{ invocation.backend }}", ctx)).toBe("claude-code");
  });

  it("UC-1.1.1e: ${{ invocation.backend }} is literal when not set", () => {
    const noBackendCtx: ExpressionContext = {
      ...ctx,
      invocation: { trigger: "manual" },
    };
    expect(resolveExpression("${{ invocation.backend }}", noBackendCtx)).toBe(
      "${{ invocation.backend }}",
    );
  });

  it("UC-1.1.1f: ${{ invocation.trigger }} is literal when invocation is undefined", () => {
    const noInvCtx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
    };
    expect(resolveExpression("${{ invocation.trigger }}", noInvCtx)).toBe(
      "${{ invocation.trigger }}",
    );
  });
});

// ============================================================================
// 2. resolveExpression — attempt namespace (FP-1.1.2)
// ============================================================================

describe("resolveExpression — attempt namespace (FP-1.1.2)", () => {
  const baseCtx: ExpressionContext = {
    inputs: { task: "test" },
    run: { id: "run-1", workflow: "test-wf" },
  };

  it("UC-1.1.2a: ${{ attempt.number }} resolves to '1' for the initial attempt", () => {
    const ctx: ExpressionContext = {
      ...baseCtx,
      attempt: { number: 1, trigger: "initial" },
    };
    expect(resolveExpression("${{ attempt.number }}", ctx)).toBe("1");
  });

  it("UC-1.1.2b: ${{ attempt.number }} resolves to '3' for the third attempt", () => {
    const ctx: ExpressionContext = {
      ...baseCtx,
      attempt: { number: 3, trigger: "retry" },
    };
    expect(resolveExpression("${{ attempt.number }}", ctx)).toBe("3");
  });

  it("UC-1.1.2c: ${{ attempt.trigger }} resolves to 'initial' for the first attempt", () => {
    const ctx: ExpressionContext = {
      ...baseCtx,
      attempt: { number: 1, trigger: "initial" },
    };
    expect(resolveExpression("${{ attempt.trigger }}", ctx)).toBe("initial");
  });

  it("UC-1.1.2d: ${{ attempt.trigger }} resolves to 'retry' for retry attempts", () => {
    const ctx: ExpressionContext = {
      ...baseCtx,
      attempt: { number: 2, trigger: "retry" },
    };
    expect(resolveExpression("${{ attempt.trigger }}", ctx)).toBe("retry");
  });

  it("UC-1.1.2e: ${{ attempt.previous_outcome }} resolves to 'timeout' during retry after a timeout", () => {
    const ctx: ExpressionContext = {
      ...baseCtx,
      attempt: { number: 2, trigger: "retry", previous_outcome: "timeout" },
    };
    expect(resolveExpression("${{ attempt.previous_outcome }}", ctx)).toBe("timeout");
  });

  it("UC-1.1.2f: ${{ attempt.previous_outcome }} is literal when not in retry context", () => {
    const ctx: ExpressionContext = {
      ...baseCtx,
      attempt: { number: 1, trigger: "initial" },
    };
    expect(resolveExpression("${{ attempt.previous_outcome }}", ctx)).toBe(
      "${{ attempt.previous_outcome }}",
    );
  });

  it("UC-1.1.2g: ${{ attempt.number }} is literal when attempt is undefined", () => {
    expect(resolveExpression("${{ attempt.number }}", baseCtx)).toBe(
      "${{ attempt.number }}",
    );
  });
});

// ============================================================================
// 3. resolveExpression — jobs extensions (FP-1.1.3)
// ============================================================================

describe("resolveExpression — jobs extensions (FP-1.1.3)", () => {
  const baseCtx: ExpressionContext = {
    inputs: { task: "test" },
    run: { id: "run-1", workflow: "test-wf" },
    jobs: {
      build: {
        outputs: { artifact: "app.zip" },
        status: "completed",
        attempt: 1,
      },
      test: {
        status: "running",
        attempt: 2,
      },
    },
  };

  it("UC-1.1.3a: ${{ jobs.build.status }} resolves to 'completed' for a completed job", () => {
    expect(resolveExpression("${{ jobs.build.status }}", baseCtx)).toBe("completed");
  });

  it("UC-1.1.3b: ${{ jobs.build.status }} resolves to 'running' for an in-progress job", () => {
    expect(resolveExpression("${{ jobs.test.status }}", baseCtx)).toBe("running");
  });

  it("UC-1.1.3c: ${{ jobs.build.status }} resolves to 'failed' for a failed job", () => {
    const ctx: ExpressionContext = {
      ...baseCtx,
      jobs: { build: { status: "failed", attempt: 2 } },
    };
    expect(resolveExpression("${{ jobs.build.status }}", ctx)).toBe("failed");
  });

  it("UC-1.1.3d: ${{ jobs.build.attempt }} resolves to '2' for a job on its second attempt", () => {
    expect(resolveExpression("${{ jobs.build.attempt }}", baseCtx)).toBe("1");
    const ctx: ExpressionContext = {
      ...baseCtx,
      jobs: { build: { status: "running", attempt: 2 } },
    };
    expect(resolveExpression("${{ jobs.build.attempt }}", ctx)).toBe("2");
  });

  it("UC-1.1.3e: ${{ jobs.nonexistent.status }} left as literal when job id not found", () => {
    expect(resolveExpression("${{ jobs.nonexistent.status }}", baseCtx)).toBe(
      "${{ jobs.nonexistent.status }}",
    );
  });

  it("UC-1.1.3f: ${{ jobs.build.unknown_field }} left as literal for non-.status/.attempt/.outputs fields", () => {
    expect(resolveExpression("${{ jobs.build.unknown_field }}", baseCtx)).toBe(
      "${{ jobs.build.unknown_field }}",
    );
  });
});

// ============================================================================
// 4. resolveExpression — steps extensions (FP-1.1.4)
// ============================================================================

describe("resolveExpression — steps extensions (FP-1.1.4)", () => {
  const baseCtx: ExpressionContext = {
    inputs: { task: "test" },
    run: { id: "run-1", workflow: "test-wf" },
    steps: {
      lint: { outputs: { passed: true }, status: "completed" },
      build: { status: "failed" },
      deploy: { status: "skipped" },
    },
  };

  it("UC-1.1.4a: ${{ steps.lint.status }} resolves to 'completed' for a completed step", () => {
    expect(resolveExpression("${{ steps.lint.status }}", baseCtx)).toBe("completed");
  });

  it("UC-1.1.4b: ${{ steps.lint.status }} resolves to 'failed' for a failed step", () => {
    expect(resolveExpression("${{ steps.build.status }}", baseCtx)).toBe("failed");
  });

  it("UC-1.1.4c: ${{ steps.lint.status }} resolves to 'skipped' for a skipped step", () => {
    expect(resolveExpression("${{ steps.deploy.status }}", baseCtx)).toBe("skipped");
  });

  it("UC-1.1.4d: ${{ steps.nonexistent.status }} left as literal when step id not found", () => {
    expect(resolveExpression("${{ steps.nonexistent.status }}", baseCtx)).toBe(
      "${{ steps.nonexistent.status }}",
    );
  });
});

// ============================================================================
// 5. evaluateCondition — status function pre-resolution (FP-1.2.1--1.2.10)
// ============================================================================

describe("evaluateCondition — status function pre-resolution (FP-1.2)", () => {
  // --- FP-1.2.4: success() semantics ---

  it("UC-1.2.4a: success() in step if: evaluates to true when all prior steps completed", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" }, build: { status: "completed" } },
    };
    expect(evaluateCondition("success()", ctx, "step-if")).toBe(true);
  });

  it("UC-1.2.4b: success() in step if: evaluates to false when a prior step failed", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" }, build: { status: "failed" } },
    };
    expect(evaluateCondition("success()", ctx, "step-if")).toBe(false);
  });

  it("UC-1.2.4c: success() in retry when: evaluates to true when previous_outcome is 'success'", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      attempt: { number: 2, trigger: "retry", previous_outcome: "success" },
    };
    expect(evaluateCondition("success()", ctx, "retry-when")).toBe(true);
  });

  it("UC-1.2.4d: success() in retry when: evaluates to false when previous_outcome is 'failure'", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      attempt: { number: 2, trigger: "retry", previous_outcome: "failure" },
    };
    expect(evaluateCondition("success()", ctx, "retry-when")).toBe(false);
  });

  it("UC-1.2.4e: success() in job-level evaluates to true when last attempt succeeded", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf", status: "completed" },
    };
    expect(evaluateCondition("success()", ctx, "job-level")).toBe(true);
  });

  // --- FP-1.2.5: failure() semantics ---

  it("UC-1.2.5a: failure() in step if: evaluates to true when a prior step failed", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" }, build: { status: "failed" } },
    };
    expect(evaluateCondition("failure()", ctx, "step-if")).toBe(true);
  });

  it("UC-1.2.5b: failure() in step if: evaluates to false when all prior steps completed", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" }, build: { status: "completed" } },
    };
    expect(evaluateCondition("failure()", ctx, "step-if")).toBe(false);
  });

  it("UC-1.2.5c: failure() in retry when: evaluates to true when previous_outcome is 'failure'", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      attempt: { number: 2, trigger: "retry", previous_outcome: "failure" },
    };
    expect(evaluateCondition("failure()", ctx, "retry-when")).toBe(true);
  });

  it("UC-1.2.5d: failure() in retry when: evaluates to false for initial attempt (no previous_outcome)", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      attempt: { number: 1, trigger: "initial" },
    };
    expect(evaluateCondition("failure()", ctx, "retry-when")).toBe(false);
  });

  // --- FP-1.2.6: always() semantics ---

  it("UC-1.2.6: always() evaluates to true regardless of scope or context", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
    };
    expect(evaluateCondition("always()", ctx, "step-if")).toBe(true);
    expect(evaluateCondition("always()", ctx, "retry-when")).toBe(true);
    expect(evaluateCondition("always()", ctx, "job-level")).toBe(true);
  });

  // --- FP-1.2.7: cancelled() semantics ---

  it("UC-1.2.7a: cancelled() evaluates to true when run.status is 'cancelled'", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf", status: "cancelled" },
    };
    expect(evaluateCondition("cancelled()", ctx)).toBe(true);
  });

  it("UC-1.2.7b: cancelled() evaluates to false when run.status is 'running'", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf", status: "running" },
    };
    expect(evaluateCondition("cancelled()", ctx)).toBe(false);
  });

  // --- FP-1.2.8: Status functions NOT valid in template interpolation ---

  it("UC-1.2.8: ${{ success() }} in a step with: value (resolveExpression) remains literal text", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
    };
    // resolveExpression does NOT pre-resolve status functions
    expect(resolveExpression("${{ success() }}", ctx)).toBe("${{ success() }}");
  });

  // --- FP-1.2.9: Combined with other operators ---

  it("UC-1.2.9a: success() && plan_status == 'approved' evaluates correctly", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" } },
      variables: { plan_status: "approved" },
    };
    expect(evaluateCondition("success() && plan_status == 'approved'", ctx, "step-if")).toBe(
      true,
    );
  });

  it("UC-1.2.9b: !success() evaluates to true when prior step failed", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "failed" } },
    };
    expect(evaluateCondition("!success()", ctx, "step-if")).toBe(true);
  });

  it("UC-1.2.9c: failure() || cancelled() evaluates correctly", () => {
    const ctxStepFailed: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "failed" } },
    };
    expect(evaluateCondition("failure() || cancelled()", ctxStepFailed, "step-if")).toBe(true);

    const ctxCancelled: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf", status: "cancelled" },
      steps: { lint: { status: "completed" } },
    };
    expect(evaluateCondition("failure() || cancelled()", ctxCancelled, "step-if")).toBe(true);

    const ctxNeither: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" } },
    };
    expect(evaluateCondition("failure() || cancelled()", ctxNeither, "step-if")).toBe(false);
  });

  // --- FP-1.2.10: Regex safety ---

  it("UC-1.2.10: 'successful' (without ()) is NOT replaced by the status function pre-resolver", () => {
    const expr = "successful";
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      variables: { successful: true },
    };
    // Should NOT throw (UC-1.2.10 + FR-EXPR-VAR-010 exception)
    expect(evaluateCondition(expr, ctx)).toBe(true);
  });

  it("UC-1.2.10 (variant): bare identifier 'successful' when NOT a variable throws FR-EXPR-VAR-010", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
    };
    expect(() => evaluateCondition("successful", ctx)).toThrow();
  });
});

// ============================================================================
// 6. evaluateCondition — StatusScope parameter (FP-1.2.3)
// ============================================================================

describe("evaluateCondition — StatusScope parameter (FP-1.2.3)", () => {
  it("default scope is 'step-if' when not provided", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" } },
    };
    expect(evaluateCondition("success()", ctx)).toBe(true);
  });

  it("retry-when scope uses ctx.attempt.previous_outcome", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      attempt: { number: 2, trigger: "retry", previous_outcome: "success" },
    };
    expect(evaluateCondition("success()", ctx, "retry-when")).toBe(true);
    expect(evaluateCondition("failure()", ctx, "retry-when")).toBe(false);
  });

  it("job-level scope uses run.status", () => {
    const ctx: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf", status: "completed" },
    };
    expect(evaluateCondition("success()", ctx, "job-level")).toBe(true);
    expect(evaluateCondition("failure()", ctx, "job-level")).toBe(false);
  });

  it("step-if scope checks steps status", () => {
    const allPassed: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" }, build: { status: "completed" } },
    };
    expect(evaluateCondition("success()", allPassed, "step-if")).toBe(true);
    expect(evaluateCondition("failure()", allPassed, "step-if")).toBe(false);

    const someFailed: ExpressionContext = {
      inputs: { task: "test" },
      run: { id: "run-1", workflow: "test-wf" },
      steps: { lint: { status: "completed" }, build: { status: "failed" } },
    };
    expect(evaluateCondition("success()", someFailed, "step-if")).toBe(false);
    expect(evaluateCondition("failure()", someFailed, "step-if")).toBe(true);
  });
});

// ============================================================================
// 7. buildExpressionContext — centralized builder (FP-1.3.1--1.3.8)
// ============================================================================

describe("buildExpressionContext — centralized builder (FP-1.3)", () => {
  const minimalState = {
    run_id: "run-1",
    workflow: "test-wf",
    task: "test",
    created_at: "2026-07-16T00:00:00Z",
    last_event_id: "evt-1",
    jobs: {},
  };

  it("FP-1.3.1: when invocation is provided, it populates ctx.invocation with trigger and backend", () => {
    const ctx = buildExpressionContext({
      state: minimalState,
      invocation: { trigger: "manual", backend: "claude-code" },
    });
    expect(ctx.invocation).toBeDefined();
    expect(ctx.invocation!.trigger).toBe("manual");
    expect(ctx.invocation!.backend).toBe("claude-code");
  });

  it("FP-1.3.2: when invocation is omitted, ctx.invocation is undefined", () => {
    const ctx = buildExpressionContext({ state: minimalState });
    expect(ctx.invocation).toBeUndefined();
  });

  it("FP-1.3.3: when attempt is provided, it populates ctx.attempt with number, trigger, and optional previous_outcome", () => {
    const ctx = buildExpressionContext({
      state: minimalState,
      attempt: { number: 2, trigger: "retry", previous_outcome: "timeout" },
    });
    expect(ctx.attempt).toBeDefined();
    expect(ctx.attempt!.number).toBe(2);
    expect(ctx.attempt!.trigger).toBe("retry");
    expect(ctx.attempt!.previous_outcome).toBe("timeout");
  });

  it("FP-1.3.4: when attempt is omitted, ctx.attempt is undefined", () => {
    const ctx = buildExpressionContext({ state: minimalState });
    expect(ctx.attempt).toBeUndefined();
  });

  it("FP-1.3.5/1.3.8: when state.jobs has entries, ctx.jobs includes .status and .attempt for each job", () => {
    const stateWithJobs = {
      ...minimalState,
      jobs: {
        build: { status: "completed" as const, attempt: 1, outputs: { artifact: "app.zip" } },
        test: { status: "running" as const, attempt: 2 },
      },
    };
    const ctx = buildExpressionContext({ state: stateWithJobs });
    expect(ctx.jobs).toBeDefined();
    expect(ctx.jobs!["build"]!.status).toBe("completed");
    expect(ctx.jobs!["build"]!.attempt).toBe(1);
    expect(ctx.jobs!["build"]!.outputs).toEqual({ artifact: "app.zip" });
    expect(ctx.jobs!["test"]!.status).toBe("running");
    expect(ctx.jobs!["test"]!.attempt).toBe(2);
  });

  it("FP-1.3.6: when jobId and stepIdx are provided, ctx.steps includes .status for prior steps", () => {
    const state = {
      ...minimalState,
      jobs: {
        build: { status: "running" as const },
      },
    };
    const workflow = {
      name: "test-wf",
      jobs: {
        build: {
          steps: [
            { id: "lint", type: "script" as const, run: "echo lint" },
            { id: "test", type: "script" as const, run: "echo test" },
            { id: "package", type: "script" as const, run: "echo package" },
          ],
        },
      },
    };
    const ctx = buildExpressionContext({
      state,
      workflow: workflow as any,
      jobId: "build",
      stepIdx: 2, // prior steps: lint (idx 0), test (idx 1)
    });
    expect(ctx.steps).toBeDefined();
    expect(Object.keys(ctx.steps!)).toHaveLength(2);
    expect(ctx.steps!["lint"]!.status).toBe("completed");
    expect(ctx.steps!["test"]!.status).toBe("completed");
    expect(ctx.steps!["package"]).toBeUndefined();
  });

  it("FP-1.3.7: existing namespaces (inputs, run, variables) are populated unchanged", () => {
    const state = {
      ...minimalState,
      variables: { plan_status: "approved" },
      status: "running" as const,
    };
    const ctx = buildExpressionContext({ state });
    expect(ctx.inputs).toEqual({ task: "test" });
    expect(ctx.run.id).toBe("run-1");
    expect(ctx.run.workflow).toBe("test-wf");
    expect(ctx.run.status).toBe("running");
    expect(ctx.variables).toEqual({ plan_status: "approved" });
  });
});
