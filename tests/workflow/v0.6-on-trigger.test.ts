/**
 * v0.6 on-optional trigger and top-level inputs tests (Issue #211).
 *
 * Covers:
 *   - Workflow with `on` omitted → valid
 *   - Workflow with unknown trigger type → valid (with warning)
 *   - Workflow with on.manual.inputs → deprecated warning, auto-migrated
 *   - Workflow with both old and new inputs → top-level wins
 *   - --host zigma-server validates known triggers strictly
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { loadWorkflow, type WorkflowDefinition, type InputDefinition } from "../../src/workflow/index.js";
import { ValidationError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(extra: string, jobs?: string): string {
  return [
    "name: test-workflow",
    'version: "0.6.0"',
    extra,
    jobs ?? `jobs:
  main:
    steps:
      - id: step1
        type: agent
        uses: zigma/skill`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Get typed input definition from workflow, asserting key exists. */
function inputDef(wf: WorkflowDefinition, key: string): InputDefinition {
  const inp = wf.inputs;
  expect(inp).toBeDefined();
  const def = inp![key];
  expect(def).toBeDefined();
  return def!;
}

/** Assert an input key is not present. */
function assertNoInput(wf: WorkflowDefinition, key: string): void {
  const inp = wf.inputs;
  expect(inp).toBeDefined();
  expect(inp![key]).toBeUndefined();
}

// ---------------------------------------------------------------------------
// on omitted
// ---------------------------------------------------------------------------

describe("v0.6 — on omitted", () => {
  it("accepts workflow with on omitted entirely", () => {
    const yaml = makeWorkflow("");
    const wf = loadWorkflow(yaml);
    expect(wf).toBeDefined();
    expect(wf.name).toBe("test-workflow");
    expect(wf.on).toBeUndefined();
  });

  it("rejects workflow with on: null (empty value)", () => {
    const yaml = makeWorkflow("on:");
    // on: with no value is parsed as null — Zod rejects null, expecting object or absent
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Unknown trigger type
// ---------------------------------------------------------------------------

describe("v0.6 — unknown trigger type (warning)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("accepts workflow with unknown trigger type (warning, not error)", () => {
    const yaml = makeWorkflow(`on:
  unknown_trigger:
    some: config`);
    const wf = loadWorkflow(yaml);
    expect(wf).toBeDefined();

    const warnings = warnSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .filter((m: string) => m.includes("Unknown trigger type"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unknown_trigger");
    expect(warnings[0]).toContain("local runtime");
    expect(warnings[0]).toContain("zigma-server");
  });

  it("accepts workflow with schedule trigger (known to zigma-server, warning for local)", () => {
    const yaml = makeWorkflow(`on:
  schedule:
    cron: "0 9 * * 1-5"`);
    const wf = loadWorkflow(yaml);
    expect(wf).toBeDefined();

    const warnings = warnSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .filter((m: string) => m.includes("Unknown trigger type"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("schedule");
  });
});

// ---------------------------------------------------------------------------
// --host zigma-server strict validation
// ---------------------------------------------------------------------------

describe("v0.6 — strict host validation", () => {
  it("rejects unknown trigger type when host is zigma-server", () => {
    const yaml = makeWorkflow(`on:
  unknown_trigger:
    some: config`);

    expect(() => loadWorkflow(yaml, { host: "zigma-server" })).toThrow(ValidationError);
  });

  it("accepts known triggers when host is zigma-server", () => {
    const yaml = makeWorkflow(`on:
  manual:
  schedule:
    cron: "0 9 * * 1-5"
  webhook:
    url: "https://example.com/hook"`);

    // All three are known to zigma-server
    expect(() => loadWorkflow(yaml, { host: "zigma-server" })).not.toThrow();
  });

  it("warns but accepts unknown trigger without host", () => {
    const yaml = makeWorkflow(`on:
  manual:
  schedule:
    cron: "0 9 * * 1-5"`);

    // Without host, even unknown triggers are just warnings
    // (schedule is unknown to local runtime)
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => loadWorkflow(yaml)).not.toThrow();
      const warnings = spy.mock.calls
        .map((c: unknown[]) => c.join(" "))
        .filter((m: string) => m.includes("Unknown trigger type"));
      // manual is known, schedule is unknown → 1 warning
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("schedule");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Top-level inputs
// ---------------------------------------------------------------------------

describe("v0.6 — top-level inputs", () => {
  it("accepts workflow with top-level inputs", () => {
    const yaml = makeWorkflow(`inputs:
  task:
    type: string
    required: true
  target_branch:
    type: string
    required: false
    default: "main"`);

    const wf = loadWorkflow(yaml);
    const taskDef = inputDef(wf, "task");
    expect(taskDef.type).toBe("string");
    expect(taskDef.required).toBe(true);
    const branchDef = inputDef(wf, "target_branch");
    expect(branchDef.type).toBe("string");
    expect(branchDef.default).toBe("main");
    expect(branchDef.required).toBe(false);
  });

  it("accepts workflow with inputs of different types", () => {
    const yaml = makeWorkflow(`inputs:
  count:
    type: number
    default: 42
  enabled:
    type: boolean
    default: true
  items:
    type: array
    default: []
  config:
    type: object`);

    const wf = loadWorkflow(yaml);
    expect(inputDef(wf, "count").type).toBe("number");
    expect(inputDef(wf, "enabled").type).toBe("boolean");
    expect(inputDef(wf, "items").type).toBe("array");
    expect(inputDef(wf, "config").type).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// on.manual.inputs deprecation
// ---------------------------------------------------------------------------

describe("v0.6 — on.manual.inputs deprecation", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("auto-migrates on.manual.inputs to top-level inputs with warning", () => {
    const yaml = makeWorkflow(`on:
  manual:
    inputs:
      task:
        type: string
        required: true
      priority:
        type: string
        required: false
        default: "medium"`);

    const wf = loadWorkflow(yaml);

    // Should have auto-migrated inputs
    const taskDef = inputDef(wf, "task");
    expect(taskDef.type).toBe("string");
    expect(taskDef.required).toBe(true);
    const priDef = inputDef(wf, "priority");
    expect(priDef.type).toBe("string");
    expect(priDef.default).toBe("medium");

    // Should have deprecation warning
    const depWarnings = warnSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .filter((m: string) => m.includes("[DEPRECATED]"));
    expect(depWarnings.length).toBeGreaterThanOrEqual(1);
    expect(depWarnings.some((m: string) => m.includes("on.manual.inputs"))).toBe(true);
    expect(depWarnings.some((m: string) => m.includes("top-level 'inputs'"))).toBe(true);
  });

  it("top-level inputs wins when both sources present", () => {
    const yaml = makeWorkflow(`on:
  manual:
    inputs:
      task:
        type: string
        required: true
      old_input:
        type: string
inputs:
  task:
    type: string
    required: false
    default: "from top level"`);

    const wf = loadWorkflow(yaml);

    // top-level inputs should win
    const taskDef = inputDef(wf, "task");
    expect(taskDef.required).toBe(false);
    expect(taskDef.default).toBe("from top level");

    // old_input from on.manual.inputs should NOT be present
    // because top-level inputs takes precedence
    assertNoInput(wf, "old_input");

    // Should have deprecation warning about ignoring on.manual.inputs
    const depWarnings = warnSpy.mock.calls
      .map((c: unknown[]) => c.join(" "))
      .filter((m: string) => m.includes("[DEPRECATED]"));
    expect(depWarnings.some((m: string) => m.includes("on.manual.inputs is ignored"))).toBe(true);
  });

  it("suppresses deprecation warning when ZIGMA_SUPPRESS_DEPRECATION is set", () => {
    const yaml = makeWorkflow(`on:
  manual:
    inputs:
      task:
        type: string
        required: true`);

    const originalEnv = process.env.ZIGMA_SUPPRESS_DEPRECATION;
    process.env.ZIGMA_SUPPRESS_DEPRECATION = "1";
    try {
      // Clear spy to get fresh calls
      warnSpy.mockClear();

      const wf = loadWorkflow(yaml);
      expect(wf.inputs).toBeDefined();

      const depWarnings = warnSpy.mock.calls
        .map((c: unknown[]) => c.join(" "))
        .filter((m: string) => m.includes("[DEPRECATED]"));
      expect(depWarnings.length).toBe(0);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ZIGMA_SUPPRESS_DEPRECATION;
      } else {
        process.env.ZIGMA_SUPPRESS_DEPRECATION = originalEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// on.manual without inputs (just trigger declaration)
// ---------------------------------------------------------------------------

describe("v0.6 — on.manual without inputs (clean trigger only)", () => {
  it("accepts on.manual without inputs (trigger declaration only)", () => {
    const yaml = makeWorkflow(`on:
  manual:`);

    const wf = loadWorkflow(yaml);
    expect(wf).toBeDefined();
    expect(wf.on).toBeDefined();
    expect(wf.inputs).toBeUndefined(); // No inputs declared
  });

  it("accepts on.manual with inputs alongside top-level inputs (top-level wins)", () => {
    const yaml = makeWorkflow(`on:
  manual:
    inputs:
      legacy_task:
        type: string
inputs:
  task:
    type: string
    required: true`);

    const wf = loadWorkflow(yaml);
    expect(inputDef(wf, "task").type).toBe("string");
    assertNoInput(wf, "legacy_task");
  });
});

// ---------------------------------------------------------------------------
// Inputs with expression scanning
// ---------------------------------------------------------------------------

describe("v0.6 — expression scanning for top-level inputs", () => {
  it("rejects forbidden expressions in top-level input defaults", () => {
    const yaml = makeWorkflow(`inputs:
  task:
    type: string
    default: "\${{ inputs.a + inputs.b }}"`);

    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  it("accepts valid defaults in top-level inputs", () => {
    const yaml = makeWorkflow(`inputs:
  task:
    type: string
    default: "hello world"`);

    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Combined: on triggers + top-level inputs
// ---------------------------------------------------------------------------

describe("v0.6 — combined triggers and inputs", () => {
  it("accepts workflow with on triggers and top-level inputs", () => {
    const yaml = makeWorkflow(`on:
  schedule:
    cron: "0 9 * * 1-5"
inputs:
  task:
    type: string
    required: true
  severity:
    type: string
    required: false
    default: "normal"`);

    const wf = loadWorkflow(yaml);
    expect(wf.on).toBeDefined();
    expect(inputDef(wf, "task").type).toBe("string");
    expect(inputDef(wf, "severity").default).toBe("normal");
  });
});
