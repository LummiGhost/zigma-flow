/**
 * Human step schema tests for WF-P15-SCHEMA (Step 1 — Cases and Tests).
 *
 * Validates that human steps:
 *  - Require a non-empty `prompt` field
 *  - Reject `expose`, `uses`, `run` fields
 *  - Accept optional `approvers` (string[]), `instructions` (string), `outputs`
 *  - Pass with minimal valid configuration
 *
 * Covers: FR-P15-SCHEMA-001 through FR-P15-SCHEMA-008
 *
 * Reference: docs/phases/p15-human-gate/02-development-plan.md AD-P15-002
 */

import { describe, expect, it } from "vitest";

import { loadWorkflow } from "../../src/workflow/index.js";
import { ValidationError } from "../../src/utils/index.js";

function makeWorkflow(stepYaml: string): string {
  return `name: human-test
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

describe("human step schema", () => {
  // ── Positive cases ──────────────────────────────────────────────────────

  it("accepts a minimal valid human step", () => {
    const yaml = makeWorkflow(`- id: gate\n  type: human\n  prompt: "Approve this change?"`);
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["gate"]!.steps[0]!;
    expect(step.type).toBe("human");
    expect(step.prompt).toBe("Approve this change?");
  });

  it("accepts a human step with approvers and instructions", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve this change?"
  approvers:
    - alice
    - bob
  instructions: "Review the diff before approving."
`);
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["gate"]!.steps[0]!;
    expect(step.type).toBe("human");
    expect(step.prompt).toBe("Approve this change?");
    expect(step.approvers).toEqual(["alice", "bob"]);
    expect(step.instructions).toBe("Review the diff before approving.");
  });

  it("accepts a human step with outputs mapping", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve this change?"
  outputs:
    decision: human.decision
    comment: human.comment
`);
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["gate"]!.steps[0]!;
    expect(step.outputs).toEqual({ decision: "human.decision", comment: "human.comment" });
  });

  it("accepts a human step with empty approvers array", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  approvers: []
`);
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["gate"]!.steps[0]!;
    expect(step.approvers).toEqual([]);
  });

  // ── Negative: missing prompt ─────────────────────────────────────────────

  it("rejects a human step with no prompt", () => {
    const yaml = makeWorkflow(`- id: gate\n  type: human`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
    try {
      loadWorkflow(yaml);
    } catch (e) {
      expect((e as ValidationError).message).toContain("requires a non-empty \"prompt\"");
      expect((e as ValidationError).details).toHaveProperty("missingField", "prompt");
    }
  });

  it("rejects a human step with empty prompt", () => {
    const yaml = makeWorkflow(`- id: gate\n  type: human\n  prompt: ""`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  it("rejects a human step with whitespace-only prompt", () => {
    const yaml = makeWorkflow(`- id: gate\n  type: human\n  prompt: "   "`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  // ── Negative: forbidden fields ───────────────────────────────────────────

  it("rejects a human step with expose field", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  expose:
    skills:
      - code
`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
    try {
      loadWorkflow(yaml);
    } catch (e) {
      expect((e as ValidationError).details).toHaveProperty("forbiddenField", "expose");
    }
  });

  it("rejects a human step with uses field", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  uses: zigma/some-check
`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
    try {
      loadWorkflow(yaml);
    } catch (e) {
      expect((e as ValidationError).details).toHaveProperty("forbiddenField", "uses");
    }
  });

  it("rejects a human step with run field", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  run: echo hello
`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
    try {
      loadWorkflow(yaml);
    } catch (e) {
      expect((e as ValidationError).details).toHaveProperty("forbiddenField", "run");
    }
  });

  // ── Negative: bad approvers type ─────────────────────────────────────────

  it("rejects a human step with string approvers instead of array", () => {
    const yaml = makeWorkflow(`
- id: gate
  type: human
  prompt: "Approve?"
  approvers: alice
`);
    expect(() => loadWorkflow(yaml)).toThrow(ValidationError);
  });

  // ── Cross-type: non-human steps are not affected ─────────────────────────

  it("non-human steps can still use prompt, expose, uses, run", () => {
    const yaml = `name: agent-test
version: "0.1.0"
skills:
  code:
    uses: skill://zigma.code-change@1
jobs:
  analyze:
    steps:
      - id: think
        type: agent
        prompt: analyze
        expose:
          skills:
            - code
`;
    const wf = loadWorkflow(yaml);
    const step = wf.jobs["analyze"]!.steps[0]!;
    expect(step.type).toBe("agent");
    expect(step.expose).toBeDefined();
  });
});
