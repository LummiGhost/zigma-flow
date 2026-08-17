import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { compileAgentOutputSchema } from "../../src/agent/index.js";
import { ValidationError } from "../../src/utils/index.js";
import type { StepDefinition } from "../../src/workflow/index.js";

type Envelope = { properties: Record<string, any>; required: string[] };

function schemaFor(step: Partial<StepDefinition>): Envelope {
  return compileAgentOutputSchema(step as StepDefinition) as unknown as Envelope;
}

// Ajv is CJS-only (no exports field); load the draft 2020-12 variant via
// createRequire, mirroring src/check/checks/json-schema.ts. This simulates the
// native schema boundary built-in backends (Codex/Claude) enforce.
const _require = createRequire(import.meta.url);
const Ajv2020Ctor = _require("ajv/dist/2020") as {
  new (): { compile(schema: unknown): (data: unknown) => boolean };
};
const ajv2020 = new Ajv2020Ctor();

function schemaAccepts(step: Partial<StepDefinition>, report: unknown): boolean {
  const validate = ajv2020.compile(compileAgentOutputSchema(step as StepDefinition));
  return validate(report) === true;
}

describe("compileAgentOutputSchema", () => {
  it("builds a closed report envelope from workflow outputs and required status", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      outputs: { verdict: { type: "string", values: ["approved", "rejected"] }, findings: {} },
      returns: { status: { values: ["approved", "rejected"], required: true } },
    });

    // Issue #256 canonical location: a required returns.status makes
    // outputs.status required, not a top-level status field.
    expect(schema.required).toEqual(["outputs", "artifacts", "signals", "summary"]);
    expect(schema.properties.outputs).toMatchObject({
      required: ["findings", "verdict", "status"],
      additionalProperties: false,
      properties: {
        verdict: { type: "string", enum: ["approved", "rejected"] },
        findings: {},
        status: { type: "string", enum: ["approved", "rejected"] },
      },
    });
    // Legacy top-level status stays an optional property (mvp-contracts §2.6).
    expect(schema.properties.status.enum).toEqual(["approved", "rejected"]);
  });

  it("declares outputs.status without requiring it when returns.status is optional", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"] } },
    });

    expect(schema.properties.outputs.properties.status).toEqual({
      type: "string",
      enum: ["fixed", "unfixable"],
    });
    expect(schema.properties.outputs.required).toEqual([]);
    expect(schema.required).toEqual(["outputs", "artifacts", "signals", "summary"]);
  });

  it("accepts the prompt-canonical outputs.status report under a required returns.status (built-in boundary)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      outputs: { verdict: { type: "string" } },
      returns: { status: { values: ["fixed", "unfixable"], required: true } },
    };
    const report = {
      outputs: { verdict: "ok", status: "fixed" },
      artifacts: [],
      signals: [],
      summary: "done",
    };

    expect(schemaAccepts(step, report)).toBe(true);
  });

  it("rejects a missing outputs.status under a required returns.status (built-in boundary)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"], required: true } },
    };

    expect(
      schemaAccepts(step, {
        outputs: {},
        artifacts: [],
        signals: [],
        summary: "done",
      })
    ).toBe(false);
  });

  it("accepts a legacy top-level status report when returns.status is optional (built-in boundary)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"] } },
    };

    expect(
      schemaAccepts(step, {
        outputs: {},
        artifacts: [],
        signals: [],
        summary: "done",
        status: "fixed",
      })
    ).toBe(true);
  });

  it("rejects an undeclared output key even with returns.status declared (closed outputs object)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      outputs: { verdict: { type: "string" } },
      returns: { status: { values: ["fixed"] } },
    };

    expect(
      schemaAccepts(step, {
        outputs: { verdict: "ok", status: "fixed", extra: "x" },
        artifacts: [],
        signals: [],
        summary: "done",
      })
    ).toBe(false);
  });

  it("rejects an outputs.status value outside returns.status.values (built-in boundary)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"], required: true } },
    };

    expect(
      schemaAccepts(step, {
        outputs: { status: "bogus" },
        artifacts: [],
        signals: [],
        summary: "done",
      })
    ).toBe(false);
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
