/**
 * Human step `timeout_minutes` schema tests for WF-V022-HUMANGATE (Step 1 — red).
 *
 * Locks down the DSL contract for the new `timeout_minutes` field on `type: human`
 * steps. v0.2.2 only **reserves the field in the zod schema** — the engine does
 * not enforce the timeout. Runtime enforcement is deferred to v0.3+.
 *
 * The field is:
 *   - optional (omitting it MUST still validate),
 *   - integer (fractional values are rejected),
 *   - strictly positive (0 and negative values are rejected).
 *
 * These tests are RED until v0.2.2 Step 2 adds `timeout_minutes` to the human
 * step branch of `StepBaseSchema` in `src/workflow/index.ts`.
 *
 * Reference:
 *   - docs/phases/v0.2.2-runtime-reliability/02-development-plan.md WF-V022-HUMANGATE
 *   - docs/phases/p15-human-gate/02-development-plan.md AD-P15-002 (schema)
 */

import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";
import { ValidationError } from "../../src/utils/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(stepYaml: string): string {
  return `name: human-timeout-test
version: "0.1.0"
jobs:
  gate:
    steps:
${stepYaml
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
`;
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe("human step timeout_minutes — positive cases", () => {
  it("accepts a typical positive integer (10)", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  timeout_minutes: 10
`);
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["gate"]!.steps[0]!;
    expect(step.type).toBe("human");
    expect((step as { timeout_minutes?: number }).timeout_minutes).toBe(10);
  });

  it("accepts the lower boundary value (1)", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  timeout_minutes: 1
`);
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["gate"]!.steps[0]!;
    expect((step as { timeout_minutes?: number }).timeout_minutes).toBe(1);
  });

  it("accepts a human step WITHOUT timeout_minutes (field is optional)", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
`);
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["gate"]!.steps[0]!;
    expect(step.type).toBe("human");
    expect((step as { timeout_minutes?: number }).timeout_minutes).toBeUndefined();
  });

  it("accepts a human step with timeout_minutes together with approvers/instructions", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve merge?"
  timeout_minutes: 60
  approvers:
    - alice
  instructions: "Review the diff."
`);
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["gate"]!.steps[0]!;
    expect((step as { timeout_minutes?: number }).timeout_minutes).toBe(60);
    expect(step.approvers).toEqual(["alice"]);
    expect(step.instructions).toBe("Review the diff.");
  });
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe("human step timeout_minutes — negative cases", () => {
  it("rejects timeout_minutes: 0", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  timeout_minutes: 0
`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  it("rejects a negative timeout_minutes (-5)", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  timeout_minutes: -5
`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  it("rejects a fractional timeout_minutes (1.5) — must be an integer", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  timeout_minutes: 1.5
`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  it("rejects a string timeout_minutes (\"10\") — must be a number", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  timeout_minutes: "10"
`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });
});
