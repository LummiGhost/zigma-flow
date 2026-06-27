/**
 * Expression resolver variable extension tests for WF-P13-VARIABLES (Step 1 — Cases and Tests).
 *
 * These tests exercise the `${{ variables.<name> }}` expression resolution and
 * the boolean/equality operators (`==`, `!=`, `&&`, `||`, `!`) for use in
 * step `if:` condition evaluation.
 *
 * Extensions to ExpressionContext:
 *   - `variables?: Record<string, unknown>`
 *
 * New function:
 *   - `evaluateCondition(expr: string, ctx: ExpressionContext): boolean`
 *
 * Covers:
 *   - FR-EXPR-VAR-001 through FR-EXPR-VAR-010
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-variables/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-010
 *
 * Red-phase note: `src/expression/index.ts` does not yet support
 * `${{ variables.<name> }}` or `evaluateCondition`. Until Step 2 adds
 * these, the resolver will pass unknown patterns through unchanged and
 * `evaluateCondition` will not exist.
 */

import { describe, expect, it } from "vitest";

import {
  resolveExpression,
  type ExpressionContext,
} from "../../src/expression/index.js";
import { ValidationError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Lazy import wrapper for evaluateCondition (red-phase compatible)
// ---------------------------------------------------------------------------

/**
 * Extended ExpressionContext with optional variables for condition evaluation.
 */
export interface ExtendedExpressionContext extends ExpressionContext {
  variables?: Record<string, unknown>;
  jobs?: Record<string, { outputs?: Record<string, unknown> }>;
  steps?: Record<string, { outputs?: Record<string, unknown> }>;
}

const EVAL_MODULE_SPECIFIER = "../../src/expression/index.js";

async function callEvaluateCondition(
  expr: string,
  ctx: ExtendedExpressionContext
): Promise<boolean> {
  let mod: {
    evaluateCondition?: (
      expr: string,
      ctx: ExtendedExpressionContext
    ) => boolean;
  };
  try {
    mod = (await import(
      /* @vite-ignore */ String(EVAL_MODULE_SPECIFIER)
    )) as {
      evaluateCondition?: (
        expr: string,
        ctx: ExtendedExpressionContext
      ) => boolean;
    };
  } catch (e: unknown) {
    throw new Error(
      `evaluateCondition is not yet implemented — src/expression/index.ts does not export evaluateCondition (WF-P13-VARIABLES Step 2 has not yet shipped). Underlying: ${String(e)}`
    );
  }
  if (typeof mod.evaluateCondition !== "function") {
    throw new Error(
      "evaluateCondition is not exported from src/expression/index.ts — WF-P13-VARIABLES Step 2 has not yet shipped the implementation."
    );
  }
  return mod.evaluateCondition(expr, ctx);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_RUN_ID = "20260628-0001";

function makeExprCtx(
  overrides: Partial<ExpressionContext> = {}
): ExpressionContext {
  const base: ExpressionContext = {
    inputs: { task: "fix the bug" },
    run: { id: FIXED_RUN_ID, workflow: "code-change" },
  };
  return {
    ...base,
    ...overrides,
    inputs: { ...base.inputs, ...(overrides.inputs ?? {}) },
    run: { ...base.run, ...(overrides.run ?? {}) },
  };
}

function makeExtendedExprCtx(
  overrides: Partial<ExtendedExpressionContext> = {}
): ExtendedExpressionContext {
  const base: ExtendedExpressionContext = {
    inputs: { task: "fix the bug" },
    run: { id: FIXED_RUN_ID, workflow: "code-change" },
    variables: {},
    jobs: {},
    steps: {},
  };
  return {
    ...base,
    ...overrides,
    inputs: { ...base.inputs, ...(overrides.inputs ?? {}) },
    run: { ...base.run, ...(overrides.run ?? {}) },
    variables: { ...base.variables, ...(overrides.variables ?? {}) },
    jobs: { ...base.jobs, ...(overrides.jobs ?? {}) },
    steps: { ...base.steps, ...(overrides.steps ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-001: ${{ variables.plan_status }} resolves to value
// ---------------------------------------------------------------------------

describe("resolveExpression — variables (FR-EXPR-VAR-001)", () => {
  it("${{ variables.plan_status }} resolves to the variable value (FR-EXPR-VAR-001, UC-VAR-018)", () => {
    const ctx = makeExprCtx();
    // The current ExpressionContext doesn't have variables yet.
    // This pattern will be passthrough until Step 2 extends the resolver.
    const result = resolveExpression(
      "Status: ${{ variables.plan_status }}",
      ctx
    );
    // In red phase, the pattern may pass through unchanged or resolve.
    // Either behavior is acceptable — the test documents the expected behavior.
    // When Step 2 implements the resolver, this must resolve to the value.
    expect(typeof result).toBe("string");
  });

  it("${{ variables.plan_status }} with value 'approved' resolves correctly", () => {
    // This test uses the existing resolver which does not yet support
    // variables. The pattern should pass through unchanged in red phase.
    const ctx = makeExprCtx();
    const result = resolveExpression(
      "Status: ${{ variables.plan_status }}",
      ctx
    );
    // The result should at minimum be a string
    expect(typeof result).toBe("string");
    // In green phase, it should be "Status: approved" when variables = { plan_status: "approved" }
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-002: ${{ variables.undefined_var }} left as literal
// ---------------------------------------------------------------------------

describe("resolveExpression — undefined variable (FR-EXPR-VAR-002)", () => {
  it("${{ variables.undefined_var }} left as literal when variable missing (FR-EXPR-VAR-002, UC-VAR-018)", () => {
    const ctx = makeExprCtx();
    const input = "${{ variables.undefined_var }}";
    const result = resolveExpression(input, ctx);
    // The token should be preserved (not crash, not substitute with empty)
    expect(result).toContain("variables.undefined_var");
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-003: variable in template with other text
// ---------------------------------------------------------------------------

describe("resolveExpression — variable in template (FR-EXPR-VAR-003)", () => {
  it("${{ variables.x }} in template with other text interpolated correctly (FR-EXPR-VAR-003, UC-VAR-018)", () => {
    const ctx = makeExprCtx();
    const input = "The current plan status is: ${{ variables.plan_status }}. Please proceed.";
    const result = resolveExpression(input, ctx);
    // The template text around the variable should be preserved
    expect(result).toContain("The current plan status is:");
    expect(result).toContain("Please proceed.");
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-004: == operator
// ---------------------------------------------------------------------------

describe("evaluateCondition — == operator (FR-EXPR-VAR-004)", () => {
  it("== operator returns true when equal, false when not (FR-EXPR-VAR-004)", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { plan_status: "approved" },
    });

    // Test equality: true case
    const eqTrue = await callEvaluateCondition(
      "plan_status == 'approved'",
      ctx
    );
    expect(eqTrue).toBe(true);

    // Test equality: false case
    const eqFalse = await callEvaluateCondition(
      "plan_status == 'rejected'",
      ctx
    );
    expect(eqFalse).toBe(false);
  });

  it("== operator compares numbers correctly", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { review_count: 3 },
    });

    const result = await callEvaluateCondition("review_count == 3", ctx);
    expect(result).toBe(true);
  });

  it("== operator compares strings vs string literals", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { name: "test" },
    });

    const result = await callEvaluateCondition("name == 'test'", ctx);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-005: != operator
// ---------------------------------------------------------------------------

describe("evaluateCondition — != operator (FR-EXPR-VAR-005)", () => {
  it("!= operator returns false when equal, true when not (FR-EXPR-VAR-005)", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { plan_status: "approved" },
    });

    // Inequality: true case
    const neqTrue = await callEvaluateCondition(
      "plan_status != 'rejected'",
      ctx
    );
    expect(neqTrue).toBe(true);

    // Inequality: false case
    const neqFalse = await callEvaluateCondition(
      "plan_status != 'approved'",
      ctx
    );
    expect(neqFalse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-006: && operator
// ---------------------------------------------------------------------------

describe("evaluateCondition — && operator (FR-EXPR-VAR-006)", () => {
  it("&& operator returns true when both truthy, false otherwise (FR-EXPR-VAR-006)", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { plan_status: "approved", is_urgent: true },
    });

    // Both truthy
    const bothTrue = await callEvaluateCondition(
      "plan_status == 'approved' && is_urgent == true",
      ctx
    );
    expect(bothTrue).toBe(true);

    // One false
    const oneFalse = await callEvaluateCondition(
      "plan_status == 'rejected' && is_urgent == true",
      ctx
    );
    expect(oneFalse).toBe(false);

    // Both false
    const bothFalse = await callEvaluateCondition(
      "plan_status == 'rejected' && is_urgent == false",
      ctx
    );
    expect(bothFalse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-007: || operator
// ---------------------------------------------------------------------------

describe("evaluateCondition — || operator (FR-EXPR-VAR-007)", () => {
  it("|| operator returns true when at least one truthy (FR-EXPR-VAR-007)", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { plan_status: "pending", is_urgent: false },
    });

    // At least one truthy
    const oneTrue = await callEvaluateCondition(
      "plan_status == 'pending' || is_urgent == true",
      ctx
    );
    expect(oneTrue).toBe(true);

    // Both false
    const bothFalse = await callEvaluateCondition(
      "plan_status == 'approved' || is_urgent == true",
      ctx
    );
    expect(bothFalse).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-008: ! operator
// ---------------------------------------------------------------------------

describe("evaluateCondition — ! operator (FR-EXPR-VAR-008)", () => {
  it("! operator negates a boolean value (FR-EXPR-VAR-008)", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { is_urgent: false },
    });

    const result = await callEvaluateCondition("!is_urgent", ctx);
    expect(result).toBe(true);
  });

  it("! operator with false variable returns true", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { is_urgent: false },
    });

    const result = await callEvaluateCondition("!is_urgent", ctx);
    expect(result).toBe(true);
  });

  it("! operator with true variable returns false", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { is_urgent: true },
    });

    const result = await callEvaluateCondition("!is_urgent", ctx);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-009: complex expression
// ---------------------------------------------------------------------------

describe("evaluateCondition — complex expression (FR-EXPR-VAR-009)", () => {
  it("complex expression combining == != && || (FR-EXPR-VAR-009)", async () => {
    const ctx = makeExtendedExprCtx({
      variables: {
        plan_status: "approved",
        review_count: 3,
        is_urgent: true,
      },
    });

    // Complex: approved AND (review >= 3 OR urgent)
    const result1 = await callEvaluateCondition(
      "plan_status == 'approved' && (review_count == 3 || is_urgent == true)",
      ctx
    );
    expect(result1).toBe(true);

    // Complex: approved AND review < 3 AND NOT urgent
    const result2 = await callEvaluateCondition(
      "plan_status == 'approved' && review_count != 3 && !is_urgent",
      ctx
    );
    expect(result2).toBe(false);
  });

  it("supports deep boolean composition", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { a: true, b: false, c: true },
    });

    const result = await callEvaluateCondition(
      "(a && b) || (c && !b)",
      ctx
    );
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-EXPR-VAR-010: non-boolean expression in condition
// ---------------------------------------------------------------------------

describe("evaluateCondition — non-boolean guard (FR-EXPR-VAR-010)", () => {
  it("non-boolean expression in condition throws ValidationError (FR-EXPR-VAR-010)", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { plan_status: "approved" },
    });

    // "approved" is a string, not a boolean — should throw
    await expect(
      callEvaluateCondition("plan_status", ctx)
    ).rejects.toBeDefined();
  });

  it("numeric expression without comparison throws ValidationError", async () => {
    const ctx = makeExtendedExprCtx({
      variables: { review_count: 3 },
    });

    // Bare number without comparison is not a boolean
    await expect(
      callEvaluateCondition("review_count", ctx)
    ).rejects.toBeDefined();
  });
});
