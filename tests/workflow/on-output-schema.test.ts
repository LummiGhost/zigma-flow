/**
 * on_output schema tests for Issue #172 (Step 1 — Cases and Tests).
 *
 * These tests exercise the Zod schema additions for `on_output` on step
 * definitions. The `StepBaseSchema` in `src/workflow/index.ts` is extended
 * with:
 *   - `on_output?: Record<string, Record<string, RouterAction>>`
 *
 * Cross-field validation:
 *   - `on_output` keys must reference declared `outputs` keys
 *   - `on_output` values must be valid RouterAction objects
 *
 * All tests are validated via `loadWorkflow` which applies Zod schema
 * validation + semantic checks.
 *
 * Covers:
 *   - FR-ON-OUTPUT-SCHEMA-001 through FR-ON-OUTPUT-SCHEMA-010
 *
 * Reference:
 *   - docs/issues/172-output-based-routing.md
 */

import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";
import { ValidationError, WorkflowError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Inline YAML fixtures
// ---------------------------------------------------------------------------

/**
 * Minimum viable workflow YAML for on_output schema testing.
 * Takes a step YAML snippet to insert into the single job's steps array.
 */
function makeOnOutputWorkflow(stepYaml: string): string {
  return `name: on-output-test
version: "0.1.0"
jobs:
  review:
    steps:
${stepYaml
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
`;
}

/**
 * Helper: build a step with outputs and on_output.
 */
function makeStepWithOnOutput(
  outputsBlock: string,
  onOutputBlock: string
): string {
  const lines: string[] = [];
  lines.push('- id: review');
  lines.push('  type: agent');
  lines.push('  uses: zigma/review-skill');

  if (outputsBlock) {
    for (const line of outputsBlock.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  if (onOutputBlock) {
    for (const line of onOutputBlock.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  return lines.join("\n");
}

const VALID_OUTPUTS_BLOCK = `outputs:
  verdict: {}`;

const VALID_ON_OUTPUT_BLOCK = `on_output:
  verdict:
    rejected:
      retry_job: implement
    escalate:
      activate_job: human-escalation`;

const VALID_ON_OUTPUT_YAML = makeOnOutputWorkflow(
  makeStepWithOnOutput(VALID_OUTPUTS_BLOCK, VALID_ON_OUTPUT_BLOCK)
);

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-001: valid on_output with outputs declared
// ---------------------------------------------------------------------------

describe("on_output schema — valid (Issue #172)", () => {
  it("loadWorkflow accepts valid on_output with declared outputs", () => {
    const def = loadWorkflow(VALID_ON_OUTPUT_YAML);
    expect(def).toBeDefined();
    expect(def.name).toBe("on-output-test");
    expect(def.jobs["review"]).toBeDefined();
  });

  it("on_output field survives round-trip through schema", () => {
    const def = loadWorkflow(VALID_ON_OUTPUT_YAML);
    const step = def.jobs["review"]?.steps[0];
    expect(step?.on_output).toBeDefined();
    expect(step?.on_output?.verdict).toBeDefined();
    expect(step?.on_output?.verdict?.rejected).toEqual({ retry_job: "implement" });
    expect(step?.on_output?.verdict?.escalate).toEqual({ activate_job: "human-escalation" });
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-002: on_output key not in declared outputs
// ---------------------------------------------------------------------------

describe("on_output schema — key not declared in outputs", () => {
  it("rejects on_output key that is not a declared output", () => {
    const outputsBlock = `outputs:
  verdict: {}`;

    // on_output references "status" which is not in outputs
    const onOutputBlock = `on_output:
  status:
    rejected:
      retry_job: implement`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(thrown).toBeInstanceOf(ValidationError);
    const err = thrown as ValidationError;
    expect(err.message.toLowerCase()).toContain("status");
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-003: step without on_output → valid (backward compat)
// ---------------------------------------------------------------------------

describe("on_output schema — step without on_output (backward compat)", () => {
  it("accepts step without on_output field", () => {
    const yaml = `name: no-on-output
version: "0.1.0"
jobs:
  intake:
    steps:
      - id: analyze
        type: agent
        uses: zigma/analyze-skill
`;

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });

  it("accepts step with outputs but no on_output", () => {
    const stepYaml = `- id: analyze
  type: agent
  uses: zigma/analyze-skill
  outputs:
    verdict: {}
    details: {}`;

    const yaml = makeOnOutputWorkflow(stepYaml);

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-004: on_output with multiple output keys
// ---------------------------------------------------------------------------

describe("on_output schema — multiple output keys", () => {
  it("accepts on_output with multiple output keys", () => {
    const outputsBlock = `outputs:
  verdict: {}
  risk_level: {}`;

    const onOutputBlock = `on_output:
  verdict:
    rejected:
      retry_job: implement
  risk_level:
    high: block`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
    const step = def.jobs["review"]?.steps[0];
    expect(step?.on_output?.verdict).toBeDefined();
    expect(step?.on_output?.risk_level).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-005: on_output with continue literal
// ---------------------------------------------------------------------------

describe("on_output schema — on_output with continue literal", () => {
  it("accepts on_output with continue action", () => {
    const outputsBlock = `outputs:
  verdict: {}`;

    const onOutputBlock = `on_output:
  verdict:
    passed: continue`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-006: on_output with fail literal
// ---------------------------------------------------------------------------

describe("on_output schema — on_output with fail literal", () => {
  it("accepts on_output with fail action", () => {
    const outputsBlock = `outputs:
  verdict: {}`;

    const onOutputBlock = `on_output:
  verdict:
    rejected: fail`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-007: on_output with block literal
// ---------------------------------------------------------------------------

describe("on_output schema — on_output with block literal", () => {
  it("accepts on_output with block action", () => {
    const outputsBlock = `outputs:
  verdict: {}`;

    const onOutputBlock = `on_output:
  verdict:
    unacceptable: block`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-008: on_output with invalid RouterAction
// ---------------------------------------------------------------------------

describe("on_output schema — invalid RouterAction", () => {
  it("rejects on_output value that is not a valid RouterAction", () => {
    const outputsBlock = `outputs:
  verdict: {}`;

    // "delete_job" is not a valid RouterAction
    const onOutputBlock = `on_output:
  verdict:
    rejected: delete_job`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    let thrown: unknown;
    try {
      loadWorkflow(yaml);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-009: on_output with goto_job action
// ---------------------------------------------------------------------------

describe("on_output schema — on_output with goto_job", () => {
  it("accepts on_output with goto_job action", () => {
    const outputsBlock = `outputs:
  verdict: {}`;

    const onOutputBlock = `on_output:
  verdict:
    skip:
      goto_job: next-job`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// FR-ON-OUTPUT-SCHEMA-010: on_output with retry_job + retry_with
// ---------------------------------------------------------------------------

describe("on_output schema — on_output with retry_job + retry_with", () => {
  it("accepts on_output with retry_job and retry_with payload", () => {
    const outputsBlock = `outputs:
  verdict: {}`;

    const onOutputBlock = `on_output:
  verdict:
    rejected:
      retry_job: implement
      retry_with:
        feedback: needs revision`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// on_output with status action
// ---------------------------------------------------------------------------

describe("on_output schema — on_output with status action", () => {
  it("accepts on_output with status: blocked", () => {
    const outputsBlock = `outputs:
  verdict: {}`;

    const onOutputBlock = `on_output:
  verdict:
    blocked_verdict:
      status: blocked`;

    const yaml = makeOnOutputWorkflow(
      makeStepWithOnOutput(outputsBlock, onOutputBlock)
    );

    const def = loadWorkflow(yaml);
    expect(def).toBeDefined();
  });
});
