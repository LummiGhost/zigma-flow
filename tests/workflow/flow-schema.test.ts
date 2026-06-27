/**
 * Flow control schema tests for WF-P13-FLOW (Step 1 — Cases and Tests).
 *
 * These tests exercise the Zod schema additions for `if`, `max_visits` on step
 * definitions, and `goto_step` in RouterAction.
 *
 * Schema additions (Step 2 will implement):
 *   - StepBaseSchema: `if?: z.string()`, `max_visits?: z.number().int().min(1)`
 *   - RouterActionObjectSchema: add `{ goto_step: z.string(), goto_with: ... }`
 *
 * Semantic validation (Step 2 will implement):
 *   - `goto_step` target must exist in the same job
 *   - `max_visits` must be >= 1
 *   - `if` must be a non-empty string
 *
 * All tests are validated via `loadWorkflow` which applies Zod schema
 * validation + semantic checks.
 *
 * Red-phase note: `src/workflow/index.ts` does not yet include `if`,
 * `max_visits`, or `goto_step` in the respective schemas. Until Step 2 adds
 * these fields:
 *   - Step-level `if` and `max_visits` are silently stripped by Zod passthrough,
 *     so positive tests pass but fields are not actually validated.
 *   - Router-level `goto_step` fails Zod validation because it is not in the
 *     RouterActionObjectSchema union.
 *   - Semantic validation tests will be RED until the validation logic ships.
 *
 * Covers:
 *   - FR-FLOW-SCHEMA-001 through FR-FLOW-SCHEMA-010
 *
 * Reference:
 *   - docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-flow/01-cases-and-tests.md
 *   - docs/phases/p13-agent-adapter-hardening/02-development-plan.md AD-P13-012
 */

import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";
import { ValidationError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Inline YAML fixtures
// ---------------------------------------------------------------------------

/**
 * Build a complete workflow YAML string with one job containing the given
 * step YAML snippet. Indents the step snippet by 6 spaces.
 */
function makeFlowWorkflow(stepYaml: string): string {
  return `name: flow-test
version: "0.1.0"
jobs:
  main:
    steps:
${stepYaml
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
`;
}

/**
 * Build a workflow with two jobs, for testing goto_step across jobs.
 * Each job has one step.
 */
function makeTwoJobWorkflow(
  job1Steps: string,
  job2Steps: string
): string {
  const lines: string[] = [];
  lines.push("name: two-job-test");
  lines.push('version: "0.1.0"');
  lines.push("jobs:");
  lines.push("  main:");
  lines.push("    steps:");
  for (const line of job1Steps.split("\n")) {
    lines.push(`      ${line}`);
  }
  lines.push("  other:");
  lines.push("    steps:");
  for (const line of job2Steps.split("\n")) {
    lines.push(`      ${line}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Helper: build a minimal step YAML string with an id, type, and optional
 * additional properties as multi-line strings.
 */
function makeStep(
  id: string,
  type: string,
  extra: string
): string {
  const lines: string[] = [];
  lines.push(`- id: ${id}`);
  lines.push(`  type: ${type}`);
  if (type === "agent" || type === "agent") {
    lines.push("  uses: zigma/skill");
  }
  if (extra) {
    for (const line of extra.split("\n")) {
      if (line.trim()) lines.push(`  ${line.trim()}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-001: step with `if:` expression → passes validation
// ---------------------------------------------------------------------------

describe("flow schema — step with if expression (FR-FLOW-SCHEMA-001)", () => {
  it("accepts step with if: \"${{ variables.x == 'ready' }}\" (FR-FLOW-SCHEMA-001, UC-FLOW-001)", () => {
    const stepYaml = makeStep("gather", "agent", "if: \"${{ variables.x == 'ready' }}\"");
    const yaml = makeFlowWorkflow(stepYaml);

    // In Step 1: `if` is silently stripped (passthrough), loadWorkflow succeeds.
    // In Step 2: `if` must be a recognized field and pass validation.
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-002: step with `max_visits: 5` → passes
// ---------------------------------------------------------------------------

describe("flow schema — step with max_visits (FR-FLOW-SCHEMA-002)", () => {
  it("accepts step with max_visits: 5 (FR-FLOW-SCHEMA-002, UC-FLOW-003)", () => {
    const stepYaml = makeStep("loop-step", "agent", "max_visits: 5");
    const yaml = makeFlowWorkflow(stepYaml);

    // In Step 1: `max_visits` is silently stripped, loadWorkflow succeeds.
    // In Step 2: `max_visits` must be a recognized field and pass validation.
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-003: router with valid goto_step → passes
// ---------------------------------------------------------------------------

describe("flow schema — router with goto_step valid target (FR-FLOW-SCHEMA-003)", () => {
  it("accepts router case goto_step to existing step in same job (FR-FLOW-SCHEMA-003, UC-FLOW-002)", () => {
    // Built with regular strings to avoid ${{ template literal issues
    const yaml = [
      "name: flow-test",
      'version: "0.1.0"',
      "jobs:",
      "  main:",
      "    steps:",
      "      - id: gather-context",
      "        type: agent",
      "        uses: zigma/skill",
      "      - id: route-plan",
      "        type: router",
      '        switch: "${{ steps.gather-context.outputs.status }}"',
      "        cases:",
      "          incomplete:",
      "            goto_step: gather-context",
      "          ready: continue",
    ].join("\n");

    // In Step 1: `goto_step` is not in RouterActionObjectSchema union,
    // so Zod validation fails → RED.
    // In Step 2: `goto_step` added to union + semantic validation checks
    // target exists → GREEN.
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-004: goto_step target not in same job → validation error
// ---------------------------------------------------------------------------

describe("flow schema — goto_step target cross-job (FR-FLOW-SCHEMA-004)", () => {
  it("rejects goto_step when target is in a different job (FR-FLOW-SCHEMA-004)", () => {
    const job1Step = `- id: route-plan
  type: router
  switch: dummy
  cases:
    retry:
      goto_step: other-step`;
    const job2Step = `- id: other-step
  type: agent
  uses: zigma/skill`;

    const yaml = makeTwoJobWorkflow(job1Step, job2Step);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    // In Step 1: Zod rejects `goto_step` as unknown union member → ValidationError.
    // In Step 2: Zod accepts `goto_step`, but semantic validation rejects
    // cross-job target → ValidationError or WorkflowError.
    // The assertion just checks that an error IS thrown (different reasons in
    // Step 1 vs Step 2 but both count as RED/GREEN transition).
    expect(thrown).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-005: goto_step target non-existent → validation error
// ---------------------------------------------------------------------------

describe("flow schema — goto_step target non-existent (FR-FLOW-SCHEMA-005)", () => {
  it("rejects goto_step when target step does not exist (FR-FLOW-SCHEMA-005)", () => {
    const yaml = `name: flow-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: route-plan
        type: router
        switch: dummy
        cases:
          retry:
            goto_step: non-existent-step
`;

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    // In Step 1: Zod rejects `goto_step` as unknown union member.
    // In Step 2: Semantic validation rejects non-existent target.
    expect(thrown).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-006: goto_step with goto_with payload → passes
// ---------------------------------------------------------------------------

describe("flow schema — goto_step with goto_with payload (FR-FLOW-SCHEMA-006)", () => {
  it("accepts goto_step with goto_with payload (FR-FLOW-SCHEMA-006)", () => {
    const yaml = `name: flow-test
version: "0.1.0"
jobs:
  main:
    steps:
      - id: gather-context
        type: agent
        uses: zigma/skill
      - id: route-plan
        type: router
        switch: dummy
        cases:
          incomplete:
            goto_step: gather-context
            goto_with:
              key1: val1
              key2: val2
          ready: continue
`;

    // In Step 1: RED — `goto_step` + `goto_with` not in Zod union.
    // In Step 2: GREEN — Zod accepts the object.
    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-007: max_visits: 0 → validation error (must be >= 1)
// ---------------------------------------------------------------------------

describe("flow schema — max_visits: 0 rejected (FR-FLOW-SCHEMA-007)", () => {
  it("rejects max_visits: 0 as value must be >= 1 (FR-FLOW-SCHEMA-007)", () => {
    const stepYaml = makeStep("loop-step", "agent", "max_visits: 0");
    const yaml = makeFlowWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    // In Step 1: `max_visits` stripped, no error → RED (test expects throw but none occurs).
    // In Step 2: Zod .min(1) or semantic check rejects 0 → GREEN.
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-008: step without if or max_visits → valid (backward compat)
// ---------------------------------------------------------------------------

describe("flow schema — backward compat (FR-FLOW-SCHEMA-008)", () => {
  it("accepts step without if or max_visits (FR-FLOW-SCHEMA-008)", () => {
    const stepYaml = makeStep("normal-step", "agent", "");
    const yaml = makeFlowWorkflow(stepYaml);

    expect(() => loadWorkflow(yaml)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-009: max_visits not a number → validation error
// ---------------------------------------------------------------------------

describe("flow schema — max_visits non-numeric (FR-FLOW-SCHEMA-009)", () => {
  it("rejects max_visits when value is not a number (FR-FLOW-SCHEMA-009)", () => {
    const stepYaml = makeStep("loop-step", "agent", "max_visits: five");
    const yaml = makeFlowWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    // In Step 1: `max_visits` stripped, "five" is never validated → RED.
    // In Step 2: Zod rejects non-number → GREEN.
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// FR-FLOW-SCHEMA-010: if expression is empty string → validation error
// ---------------------------------------------------------------------------

describe("flow schema — if expression empty string (FR-FLOW-SCHEMA-010)", () => {
  it("rejects step with empty if expression (FR-FLOW-SCHEMA-010)", () => {
    const stepYaml = makeStep("cond-step", "agent", 'if: ""');
    const yaml = makeFlowWorkflow(stepYaml);

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    // In Step 1: `if` stripped, empty string never validated → RED.
    // In Step 2: Semantic check rejects empty string → GREEN.
    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(ValidationError);
  });
});
