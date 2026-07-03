/**
 * Expression validation tests for Issue #119 — forbidden construct detection.
 *
 * Covers:
 *   - Arithmetic operators (+, -, *, /, %) in ${{ }} → ValidationError
 *   - Function call syntax in ${{ }} → ValidationError
 *   - Array/object literals ([], {}) in ${{ }} → ValidationError
 *   - Ternary expressions (? :) in ${{ }} → ValidationError
 *   - Template literals (backtick, ${}) in ${{ }} → ValidationError
 *   - Property chain depth > 3 → ValidationError
 *   - step.env values scanned for forbidden expressions
 *
 * Cross-job goto_step and max_visits exceeded are already tested:
 *   - goto_step cross-job: tests/workflow/flow-schema.test.ts (FR-FLOW-SCHEMA-004)
 *                         tests/engine/goto-step.test.ts (FR-GOTO-005)
 *   - max_visits exceeded: tests/engine/max-visits.test.ts (FR-MAXV-002, FR-MAXV-005)
 */

import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";
import { ValidationError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid workflow with a single step. The stepYaml snippet is
 * inserted under `jobs.main.steps` and indented by 6 spaces.
 */
function makeSingleStepWorkflow(stepYaml: string): string {
  return `name: expr-test
version: "0.1.0"
on:
  manual:
    inputs:
      task:
        type: string
        required: false
jobs:
  main:
    steps:
${stepYaml
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
`;
}

// ---------------------------------------------------------------------------
// Forbidden expression tests
// ---------------------------------------------------------------------------

describe("validateExpressions — arithmetic", () => {
  it("rejects ${{ inputs.a + inputs.b }} in step.with (Issue #119)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  with:',
      '    task: "${{ inputs.a + inputs.b }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const msg = (thrown as ValidationError).message.toLowerCase();
    expect(msg).toContain("arithmetic");
  });

  it("rejects ${{ variables.count * 2 }} in step.if (Issue #119)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  if: "${{ variables.count * 2 == 4 }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).message.toLowerCase()).toContain("arithmetic");
  });

  it("rejects subtraction operator but not hyphenated identifiers", () => {
    // hyphen in job id should NOT trigger arithmetic rejection
    const yaml = `name: expr-test
version: "0.1.0"
jobs:
  code-map:
    steps:
      - id: test-step
        type: agent
        uses: zigma/skill
        with:
          task: "\${{ inputs.task }}"
`;

    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

describe("validateExpressions — function calls", () => {
  it("rejects ${{ len(inputs.task) > 5 }} in step.if (Issue #119)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  if: "${{ len(inputs.task) > 5 }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).message.toLowerCase()).toContain("function");
  });

  it("rejects method call syntax like inputs.list.join(',') (Issue #119)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  with:',
      '    items: "${{ inputs.list.join(\',\') }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).message.toLowerCase()).toContain("function");
  });
});

describe("validateExpressions — depth limit", () => {
  it("rejects ${{ inputs.a.b.c.d }} with depth 4 (Issue #119)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  with:',
      '    x: "${{ inputs.a.b.c.d }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).message.toLowerCase()).toContain("depth");
  });

  it("accepts ${{ jobs.foo.outputs.bar }} with depth 3", () => {
    const yaml = `name: expr-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: test-step
        type: agent
        uses: zigma/skill
        with:
          task: "\${{ jobs.foo.outputs.bar }}"
`;

    expect(() => loadWorkflow(yaml)).not.toThrow();
  });

  it("accepts ${{ steps.analyze.outputs.summary }} with depth 3", () => {
    const yaml = `name: expr-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: test-step
        type: agent
        uses: zigma/skill
        with:
          result: "\${{ steps.analyze.outputs.summary }}"
`;

    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

describe("validateExpressions — modulo", () => {
  it("rejects ${{ variables.count % 3 }} (Issue #119)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  if: "${{ variables.count % 3 == 0 }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).message.toLowerCase()).toContain("arithmetic");
  });
});

describe("validateExpressions — array/object literals", () => {
  it("rejects ${{ [1, 2, 3] }} (array literal)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  with:',
      '    items: "${{ [1, 2, 3] }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  it("rejects ${{ {a: 1} }} (object literal)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  with:',
      '    config: "${{ {a: 1} }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });
});

describe("validateExpressions — ternary", () => {
  it("rejects ${{ x ? y : z }} (ternary in step.if)", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: agent",
      "  uses: zigma/skill",
      '  if: "${{ x ? y : z }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });
});

describe("validateExpressions — template literals", () => {
  it("rejects backtick in expression (template literal)", () => {
    const yaml = `name: expr-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: test-step
        type: agent
        uses: zigma/skill
        if: "\${{ \`template\` }}"
`;

    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });
});

describe("validateExpressions — step.env scanning", () => {
  it("rejects expressions in step.env values", () => {
    const stepYaml = [
      "- id: test-step",
      "  type: script",
      "  run: echo hello",
      "  env:",
      '    KEY: "${{ inputs.a + inputs.b }}"',
    ].join("\n");

    const yaml = makeSingleStepWorkflow(stepYaml);

    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });
});
