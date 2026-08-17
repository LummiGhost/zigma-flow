import { describe, expect, it } from "vitest";
import { compileAgentOutputSchema } from "../../src/agent/index.js";
import { ValidationError } from "../../src/utils/index.js";
import type { StepDefinition } from "../../src/workflow/index.js";

type Envelope = { properties: Record<string, any>; required: string[] };

function schemaFor(step: Partial<StepDefinition>): Envelope {
  return compileAgentOutputSchema(step as StepDefinition) as unknown as Envelope;
}

describe("compileAgentOutputSchema", () => {
  it("builds a closed report envelope from workflow outputs and required status", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      outputs: { verdict: { type: "string", values: ["approved", "rejected"] }, findings: {} },
      returns: { status: { values: ["approved", "rejected"], required: true } },
    });

    expect(schema.required).toContain("status");
    expect(schema.properties.outputs).toMatchObject({
      required: ["findings", "verdict"],
      additionalProperties: false,
      properties: { verdict: { type: "string", enum: ["approved", "rejected"] }, findings: {} },
    });
    expect(schema.properties.status.enum).toEqual(["approved", "rejected"]);
  });

  it("treats the YAML empty shorthand (title:) as an unconstrained declaration", () => {
    const schema = schemaFor({ id: "s", type: "agent", outputs: { title: undefined } });

    expect(schema.properties.outputs.required).toEqual(["title"]);
    expect(schema.properties.outputs.properties.title).toEqual({});
  });

  it("rejects non-object output declarations with ValidationError", () => {
    expect(() =>
      schemaFor({ id: "s", type: "agent", outputs: { title: "just a string" } })
    ).toThrowError(ValidationError);
    try {
      schemaFor({ id: "s", type: "agent", outputs: { title: "just a string" } });
    } catch (err) {
      expect((err as Error).message).toContain(`Output "title" declaration must be an object`);
    }
  });

  it("rejects unsupported output types with ValidationError", () => {
    expect(() =>
      schemaFor({ id: "s", type: "agent", outputs: { score: { type: "integer" } } })
    ).toThrowError(ValidationError);
    try {
      schemaFor({ id: "s", type: "agent", outputs: { score: { type: "integer" } } });
    } catch (err) {
      expect((err as Error).message).toContain(`Output "score" declares unsupported type "integer"`);
      expect((err as Error).message).toContain("Supported types: string, number, boolean, object, array, null");
    }
  });

  it("rejects non-array values/enum declarations with ValidationError", () => {
    expect(() =>
      schemaFor({ id: "s", type: "agent", outputs: { verdict: { type: "string", values: "approved" } } })
    ).toThrowError(ValidationError);
    expect(() =>
      schemaFor({ id: "s", type: "agent", outputs: { verdict: { type: "string", enum: "approved" } } })
    ).toThrowError(ValidationError);
  });

  it("compiles artifacts as an array of string refs (Issue #289 follow-up)", () => {
    const schema = schemaFor({ id: "s", type: "agent" });

    expect(schema.properties.artifacts).toEqual({ type: "array", items: { type: "string" } });
  });

  it("merges outputs_schema over outputs without discarding outputs metadata", () => {
    const schema = schemaFor({
      id: "s",
      type: "agent",
      outputs: {
        verdict: { type: "string", values: ["approved", "rejected"], description: "final verdict" },
      },
      outputs_schema: { verdict: { type: "string", values: ["approved"] } },
    });

    // outputs_schema's values overlay outputs' values, but the description
    // from outputs survives the per-key merge.
    expect(schema.properties.outputs.properties.verdict).toEqual({
      type: "string",
      enum: ["approved"],
      description: "final verdict",
    });
  });

  it("flows outputs enum declarations into the compiled schema", () => {
    const schema = schemaFor({
      id: "s",
      type: "agent",
      outputs: { verdict: { type: "string", enum: ["a", "b"] } },
    });

    expect(schema.properties.outputs.properties.verdict).toEqual({ type: "string", enum: ["a", "b"] });
  });

  it("compiles outputs_schema-only declarations into the envelope", () => {
    const schema = schemaFor({
      id: "s",
      type: "agent",
      outputs_schema: { verdict: { type: "string", values: ["x"] } },
    });

    expect(schema.properties.outputs.required).toEqual(["verdict"]);
    expect(schema.properties.outputs.properties.verdict).toEqual({ type: "string", enum: ["x"] });
  });
});
