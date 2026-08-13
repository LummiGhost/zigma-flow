import { describe, expect, it } from "vitest";
import { compileAgentOutputSchema } from "../../src/agent/index.js";
import type { StepDefinition } from "../../src/workflow/index.js";

describe("compileAgentOutputSchema", () => {
  it("builds a closed report envelope from workflow outputs and required status", () => {
    const schema = compileAgentOutputSchema({
      id: "review",
      type: "agent",
      outputs: { verdict: { type: "string", values: ["approved", "rejected"] }, findings: {} },
      returns: { status: { values: ["approved", "rejected"], required: true } },
    } as StepDefinition) as { properties: Record<string, any>; required: string[] };

    expect(schema.required).toContain("status");
    expect(schema.properties.outputs).toMatchObject({
      required: ["findings", "verdict"],
      additionalProperties: false,
      properties: { verdict: { type: "string", enum: ["approved", "rejected"] }, findings: {} },
    });
    expect(schema.properties.status.enum).toEqual(["approved", "rejected"]);
  });
});
