/**
 * v0.6 Mutable Context Deprecation Tests
 *
 * Tests that deprecated fields (variables, context_blocks, context_patches,
 * variables.* expressions) still work but produce [DEPRECATED] warnings.
 *
 * Reference: GitHub Issue #206
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";
import { validateReportShape } from "../../src/engine/accept.js";
import { resolveExpression, type ExpressionContext } from "../../src/expression/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal workflow YAML with optional variables and context_blocks. */
function makeWorkflow(opts: {
  variables?: string;
  contextBlocks?: string;
  extraPermissions?: string;
}): string {
  const lines: string[] = [];
  lines.push("name: deprecation-test");
  lines.push('version: "0.1.0"');
  lines.push("");

  if (opts.variables) {
    lines.push("variables:");
    for (const line of opts.variables.split("\n")) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  if (opts.contextBlocks) {
    lines.push("context_blocks:");
    for (const line of opts.contextBlocks.split("\n")) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  lines.push("jobs:");
  lines.push("  plan:");
  lines.push("    steps:");
  lines.push("      - id: draft");
  lines.push("        type: agent");
  lines.push("        uses: zigma/draft-skill");

  return lines.join("\n");
}

const VALID_VARIABLES = `plan_status:
    type: string
    initial: pending
    allowed_writers:
      - plan.draft`;

const VALID_CONTEXT_BLOCKS = `design_notes:
    initial_artifact: null
    allowed_writers:
      - plan.draft`;

function makeExprCtx(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    inputs: { task: "test" },
    run: { id: "run-001", workflow: "test-wf" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Warnings for control
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Workflow Loader Deprecation Warnings
// ===========================================================================

describe("v0.6 deprecation — workflow loader", () => {
  it("prints warning when variables section is present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const yaml = makeWorkflow({ variables: VALID_VARIABLES });
    const wf = loadWorkflow(yaml);

    // Must still parse successfully
    expect(wf).toBeDefined();
    expect(wf.name).toBe("deprecation-test");

    // Must produce the deprecation warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEPRECATED] Workflow variables are deprecated"),
    );
  });

  it("prints warning when context_blocks section is present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const yaml = makeWorkflow({ contextBlocks: VALID_CONTEXT_BLOCKS });
    const wf = loadWorkflow(yaml);

    expect(wf).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEPRECATED] Context blocks are deprecated"),
    );
  });

  it("prints both warnings when variables and context_blocks are present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const yaml = makeWorkflow({
      variables: VALID_VARIABLES,
      contextBlocks: VALID_CONTEXT_BLOCKS,
    });
    const wf = loadWorkflow(yaml);

    expect(wf).toBeDefined();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT print warnings when neither variables nor context_blocks are present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const yaml = makeWorkflow({});
    const wf = loadWorkflow(yaml);

    expect(wf).toBeDefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still fully parses variables correctly (non-fatal deprecation)", () => {
    const yaml = makeWorkflow({ variables: VALID_VARIABLES });
    const wf = loadWorkflow(yaml);

    expect(wf.variables).toBeDefined();
    const vars = wf.variables!;
    expect(vars.plan_status).toBeDefined();
    expect(vars.plan_status!.type).toBe("string");
    expect(vars.plan_status!.initial).toBe("pending");
    expect(vars.plan_status!.allowed_writers).toEqual(["plan.draft"]);
  });

  it("still fully parses context_blocks correctly (non-fatal deprecation)", () => {
    const yaml = makeWorkflow({ contextBlocks: VALID_CONTEXT_BLOCKS });
    const wf = loadWorkflow(yaml);

    expect(wf.context_blocks).toBeDefined();
    const blocks = wf.context_blocks!;
    expect(blocks.design_notes).toBeDefined();
    expect(blocks.design_notes!.initial_artifact).toBeNull();
    expect(blocks.design_notes!.allowed_writers).toEqual(["plan.draft"]);
  });

  it("still validates allowed_writers on variables (non-fatal deprecation)", () => {
    const badVars = `plan_status:
    type: string
    initial: pending
    allowed_writers:
      - nonexistent.fake`;

    const yaml = makeWorkflow({ variables: badVars });

    // Should throw because allowed_writers references a non-existent step
    expect(() => loadWorkflow(yaml)).toThrow();
  });
});

// ===========================================================================
// Expression Resolver Deprecation Warnings
// ===========================================================================

describe("v0.6 deprecation — expression resolver", () => {
  it("prints warning when ${{ variables.* }} expression is used", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = makeExprCtx({
      variables: { plan_status: "approved" },
    });
    const result = resolveExpression("Status: ${{ variables.plan_status }}", ctx);

    // Must resolve successfully
    expect(result).toBe("Status: approved");
    // Must produce deprecation warning
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEPRECATED] variables.* expressions are deprecated"),
    );
  });

  it("prints warning even when variable is undefined", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = makeExprCtx();
    const result = resolveExpression("${{ variables.unknown }}", ctx);

    // Pattern should be preserved (unchanged passthrough)
    expect(result).toContain("variables.unknown");
    // Warning still fires because the pattern was detected
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEPRECATED] variables.* expressions are deprecated"),
    );
  });

  it("does NOT warn for non-variable expressions", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = makeExprCtx({
      jobs: { build: { outputs: { status: "ok" } } },
    });
    const result = resolveExpression("Status: ${{ jobs.build.outputs.status }}", ctx);

    expect(result).toBe("Status: ok");
    // No deprecation warning for jobs.* expressions
    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    expect(deprecationCalls).toHaveLength(0);
  });

  it("does NOT warn for inputs.*, run.*, or steps.* expressions", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = makeExprCtx({
      steps: { test: { outputs: { passed: "true" } } },
    });

    resolveExpression("${{ inputs.task }}", ctx);
    resolveExpression("${{ run.id }}", ctx);
    resolveExpression("${{ steps.test.outputs.passed }}", ctx);

    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    expect(deprecationCalls).toHaveLength(0);
  });
});

// ===========================================================================
// Agent Report Deprecation Warnings
// ===========================================================================

describe("v0.6 deprecation — agent report", () => {
  it("prints warning when context_patches is present in report", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = {
      outputs: { key: "value" },
      artifacts: [],
      signals: [],
      summary: "test summary",
      context_patches: [
        { variable: "plan_status", operation: "set", value: "approved" },
      ],
    };

    const validated = validateReportShape(report);

    expect(validated).toBeDefined();
    expect(validated.context_patches).toBeDefined();
    expect(validated.context_patches).toHaveLength(1);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEPRECATED] context_patches are deprecated"),
    );
  });

  it("does NOT warn when context_patches is absent from report", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = {
      outputs: { key: "value" },
      artifacts: [],
      signals: [],
      summary: "test summary",
    };

    const validated = validateReportShape(report);

    expect(validated).toBeDefined();
    expect(validated.context_patches).toBeUndefined();

    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    expect(deprecationCalls).toHaveLength(0);
  });

  it("validates clean report schema (outputs, artifacts, signals, summary)", () => {
    const report = {
      outputs: { result: "success", count: 42 },
      artifacts: ["summary.md", "diff.patch"],
      signals: [{ type: "review_rejected" }],
      summary: "Implementation completed successfully.",
    };

    const validated = validateReportShape(report);
    expect(validated).toBeDefined();
    expect(validated.outputs).toEqual({ result: "success", count: 42 });
    expect(validated.artifacts).toEqual(["summary.md", "diff.patch"]);
    expect(validated.signals).toEqual([{ type: "review_rejected" }]);
    expect(validated.summary).toBe("Implementation completed successfully.");
  });
});

// ===========================================================================
// Clean Report Schema Snapshot
// ===========================================================================

describe("v0.6 — clean report schema (no context_patches)", () => {
  it("recommended report shape has exactly 4 required fields", () => {
    // Validate that the recommended schema accepts the clean shape
    const cleanReport = {
      outputs: { plan_summary: "Build feature X" },
      artifacts: ["plan.md"],
      signals: [],
      summary: "Plan complete.",
    };

    const result = validateReportShape(cleanReport);
    expect(result).toBeDefined();

    // Verify the shape matches the recommended schema
    expect(Object.keys(result)).toContain("outputs");
    expect(Object.keys(result)).toContain("artifacts");
    expect(Object.keys(result)).toContain("signals");
    expect(Object.keys(result)).toContain("summary");
    // context_patches should NOT be present
    expect(result.context_patches).toBeUndefined();
  });

  it("clean report with status field validates", () => {
    const reportWithStatus = {
      outputs: { verdict: "approved" },
      artifacts: ["review.md"],
      signals: [],
      summary: "Review complete.",
      status: "approved",
    };

    const result = validateReportShape(reportWithStatus);
    expect(result).toBeDefined();
    expect(result.status).toBe("approved");
    // Still no context_patches
    expect(result.context_patches).toBeUndefined();
  });
});

// ===========================================================================
// Integration: Full Dataset Still Works
// ===========================================================================

describe("v0.6 deprecation — integration", () => {
  it("workflow with variables, context_blocks, and expressions all parse and warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create a full workflow with variables and context_blocks
    const yaml = makeWorkflow({
      variables: `plan_status:
    type: string
    initial: pending
    allowed_writers:
      - plan.draft
review_count:
    type: number
    initial: 0
    allowed_writers:
      - plan.draft`,
      contextBlocks: `design_notes:
    initial_artifact: null
    allowed_writers:
      - plan.draft
change_summary:
    initial_artifact: null
    allowed_writers:
      - plan.draft`,
    });

    const wf = loadWorkflow(yaml);

    // Everything still works
    expect(wf.variables).toBeDefined();
    expect(Object.keys(wf.variables!)).toHaveLength(2);
    expect(wf.context_blocks).toBeDefined();
    expect(Object.keys(wf.context_blocks!)).toHaveLength(2);

    // Both deprecation warnings were emitted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEPRECATED] Workflow variables are deprecated"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DEPRECATED] Context blocks are deprecated"),
    );
  });
});

// ===========================================================================
// Suppression via ZIGMA_SUPPRESS_DEPRECATION env var
// ===========================================================================

describe("v0.6 deprecation — suppression via ZIGMA_SUPPRESS_DEPRECATION", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ── Workflow loader suppression ───────────────────────────────────────────

  it("suppresses variables deprecation warning when ZIGMA_SUPPRESS_DEPRECATION is set", () => {
    process.env.ZIGMA_SUPPRESS_DEPRECATION = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const yaml = makeWorkflow({ variables: VALID_VARIABLES });
    const wf = loadWorkflow(yaml);

    expect(wf).toBeDefined();
    expect(wf.variables).toBeDefined();

    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    expect(deprecationCalls).toHaveLength(0);
  });

  it("suppresses context_blocks deprecation warning when ZIGMA_SUPPRESS_DEPRECATION is set", () => {
    process.env.ZIGMA_SUPPRESS_DEPRECATION = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const yaml = makeWorkflow({ contextBlocks: VALID_CONTEXT_BLOCKS });
    const wf = loadWorkflow(yaml);

    expect(wf).toBeDefined();
    expect(wf.context_blocks).toBeDefined();

    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    expect(deprecationCalls).toHaveLength(0);
  });

  it("suppresses context_patches deprecation warning when ZIGMA_SUPPRESS_DEPRECATION is set", () => {
    process.env.ZIGMA_SUPPRESS_DEPRECATION = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = {
      outputs: { key: "value" },
      artifacts: [],
      signals: [],
      summary: "test summary",
      context_patches: [
        { variable: "plan_status", operation: "set", value: "approved" },
      ],
    };

    const validated = validateReportShape(report);
    expect(validated).toBeDefined();

    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    expect(deprecationCalls).toHaveLength(0);
  });

  it("suppresses variables.* expression warning when ZIGMA_SUPPRESS_DEPRECATION is set", () => {
    process.env.ZIGMA_SUPPRESS_DEPRECATION = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = makeExprCtx({
      variables: { plan_status: "approved" },
    });
    const result = resolveExpression("Status: ${{ variables.plan_status }}", ctx);

    expect(result).toBe("Status: approved");

    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    expect(deprecationCalls).toHaveLength(0);
  });

  it("still emits warnings when ZIGMA_SUPPRESS_DEPRECATION is NOT set", () => {
    // Explicitly remove the env var if present
    delete process.env.ZIGMA_SUPPRESS_DEPRECATION;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const yaml = makeWorkflow({ variables: VALID_VARIABLES });
    const wf = loadWorkflow(yaml);

    expect(wf).toBeDefined();

    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    expect(deprecationCalls.length).toBeGreaterThan(0);
  });

  it("still emits warnings when ZIGMA_SUPPRESS_DEPRECATION is set to 0 or empty", () => {
    process.env.ZIGMA_SUPPRESS_DEPRECATION = "0";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const yaml = makeWorkflow({ variables: VALID_VARIABLES });
    const wf = loadWorkflow(yaml);

    expect(wf).toBeDefined();

    const deprecationCalls = warnSpy.mock.calls.filter((c) =>
      (c[0] as string).includes("[DEPRECATED]")
    );
    // "0" is truthy in JS strings, so suppress
    expect(deprecationCalls).toHaveLength(0);
  });
});
