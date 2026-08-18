import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { compileAgentOutputSchema } from "../../src/agent/index.js";
import { ValidationError } from "../../src/utils/index.js";
import type { StepDefinition } from "../../src/workflow/index.js";

type Envelope = { properties: Record<string, any>; required: string[]; allOf?: any[] };

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

  it("compiles a Draft 2020 equality guard between top-level status and outputs.status", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"] } },
    });

    // JSON Schema has no cross-field equality operator; the compiler
    // approximates it with one if/then guard per declared status value.
    // Each guard fires only when BOTH the top-level `status` and
    // `outputs.status` are present and the top-level value matches its
    // const — it then pins outputs.status to the same value.
    expect(schema.allOf).toEqual([
      {
        if: {
          required: ["status"],
          properties: {
            status: { const: "fixed" },
            outputs: { required: ["status"] },
          },
        },
        then: {
          properties: {
            outputs: { properties: { status: { const: "fixed" } } },
          },
        },
      },
      {
        if: {
          required: ["status"],
          properties: {
            status: { const: "unfixable" },
            outputs: { required: ["status"] },
          },
        },
        then: {
          properties: {
            outputs: { properties: { status: { const: "unfixable" } } },
          },
        },
      },
    ]);
  });

  it("rejects conflicting top-level and outputs.status values (built-in boundary)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"], required: true } },
    };

    // Both values are individually in-enum, so per-property validation
    // alone would accept this; the equality guard must reject it.
    expect(
      schemaAccepts(step, {
        outputs: { status: "unfixable" },
        artifacts: [],
        signals: [],
        summary: "done",
        status: "fixed",
      })
    ).toBe(false);
  });

  it("rejects conflicting status values even when returns.status is optional (built-in boundary)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"] } },
    };

    expect(
      schemaAccepts(step, {
        outputs: { status: "fixed" },
        artifacts: [],
        signals: [],
        summary: "done",
        status: "unfixable",
      })
    ).toBe(false);
  });

  it("accepts strictly equal top-level and outputs.status values (built-in boundary)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"], required: true } },
    };

    expect(
      schemaAccepts(step, {
        outputs: { status: "fixed" },
        artifacts: [],
        signals: [],
        summary: "done",
        status: "fixed",
      })
    ).toBe(true);
  });

  it("accepts a nested-only outputs.status when returns.status is optional (built-in boundary)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      returns: { status: { values: ["fixed", "unfixable"] } },
    };

    expect(
      schemaAccepts(step, {
        outputs: { status: "fixed" },
        artifacts: [],
        signals: [],
        summary: "done",
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

describe("compileAgentOutputSchema — explicit status + returns.status merge (Issue #289 P2)", () => {
  it("merges a compatible explicit outputs.status subset with returns.status, preserving metadata", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      outputs: {
        status: {
          type: "string",
          values: ["fixed"],
          description: "review outcome (restricted subset)",
        },
      },
      returns: { status: { values: ["fixed", "unfixable"], required: true } },
    });

    // The explicit (stricter) values win the merge instead of being silently
    // overwritten by returns.status.values; description survives.
    expect(schema.properties.outputs.properties.status).toEqual({
      type: "string",
      enum: ["fixed"],
      description: "review outcome (restricted subset)",
    });
    // Explicit declaration => required regardless of returns.status.required.
    expect(schema.properties.outputs.required).toEqual(["status"]);
    // Legacy top-level status keeps the full routing domain.
    expect(schema.properties.status.enum).toEqual(["fixed", "unfixable"]);
  });

  it("merges an outputs_schema-only status subset with returns.status", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      outputs_schema: { status: { type: "string", values: ["fixed"] } },
      returns: { status: { values: ["fixed", "unfixable"] } },
    });

    expect(schema.properties.outputs.required).toEqual(["status"]);
    expect(schema.properties.outputs.properties.status).toEqual({
      type: "string",
      enum: ["fixed"],
    });
  });

  it("merges a split declaration (outputs metadata + outputs_schema values) with returns.status", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      outputs: { status: { description: "review outcome" } },
      outputs_schema: { status: { type: "string", values: ["fixed"] } },
      returns: { status: { values: ["fixed", "unfixable"] } },
    });

    expect(schema.properties.outputs.properties.status).toEqual({
      type: "string",
      enum: ["fixed"],
      description: "review outcome",
    });
  });

  it("treats an unconstrained explicit status declaration as the full returns domain", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      outputs: { status: {} },
      returns: { status: { values: ["fixed", "unfixable"] } },
    });

    expect(schema.properties.outputs.properties.status).toEqual({
      type: "string",
      enum: ["fixed", "unfixable"],
    });
  });

  it("merges an explicit enum-key declaration with returns.status", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      outputs: { status: { enum: ["fixed"] } },
      returns: { status: { values: ["fixed", "unfixable"] } },
    });

    expect(schema.properties.outputs.properties.status).toEqual({
      type: "string",
      enum: ["fixed"],
    });
  });

  it("requires outputs.status when explicitly declared even if returns.status is optional", () => {
    const schema = schemaFor({
      id: "review",
      type: "agent",
      outputs: { status: { values: ["fixed"] } },
      returns: { status: { values: ["fixed", "unfixable"] } },
    });

    // Every declared output key is required — the explicit status
    // declaration is stricter than (and compatible with) an optional
    // returns.status, so the merged contract requires it.
    expect(schema.properties.outputs.required).toEqual(["status"]);

    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      outputs: { status: { values: ["fixed"] } },
      returns: { status: { values: ["fixed", "unfixable"] } },
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

  it("enforces the explicit subset at the built-in boundary (schema/runtime consistency)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      outputs: { status: { values: ["fixed"] } },
      returns: { status: { values: ["fixed", "unfixable"], required: true } },
    };
    const envelope = {
      outputs: { status: "fixed" },
      artifacts: [],
      signals: [],
      summary: "done",
    };

    expect(schemaAccepts(step, envelope)).toBe(true);
    // "unfixable" is routable by returns.status but outside the explicit
    // subset — the compiled schema must reject it, exactly like the Engine's
    // final-line enum check on the merged declaration.
    expect(
      schemaAccepts(step, {
        ...envelope,
        outputs: { status: "unfixable" },
      })
    ).toBe(false);
  });

  it("rejects a type conflict between explicit status and returns.status (fail-closed)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      outputs: { status: { type: "number" } },
      returns: { status: { values: ["fixed", "unfixable"] } },
    };

    expect(() => compileAgentOutputSchema(step as StepDefinition)).toThrowError(ValidationError);
    try {
      compileAgentOutputSchema(step as StepDefinition);
    } catch (err) {
      expect((err as Error).message).toContain(
        `Output "status" declares type "number" which conflicts with returns.status`
      );
    }
  });

  it("rejects an explicit status value outside returns.status.values (fail-closed)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      outputs: { status: { values: ["bogus"] } },
      returns: { status: { values: ["fixed", "unfixable"] } },
    };

    expect(() => compileAgentOutputSchema(step as StepDefinition)).toThrowError(ValidationError);
    try {
      compileAgentOutputSchema(step as StepDefinition);
    } catch (err) {
      expect((err as Error).message).toContain('Output "status" declares value(s) "bogus"');
      expect((err as Error).message).toContain("outside returns.status.values");
    }
  });

  it("rejects only the unroutable values on partial overlap (fail-closed)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      outputs_schema: { status: { type: "string", values: ["fixed", "bogus"] } },
      returns: { status: { values: ["fixed", "unfixable"] } },
    };

    expect(() => compileAgentOutputSchema(step as StepDefinition)).toThrowError(ValidationError);
    try {
      compileAgentOutputSchema(step as StepDefinition);
    } catch (err) {
      expect((err as Error).message).toContain('declares value(s) "bogus"');
      expect((err as Error).message).not.toContain('"fixed" outside');
    }
  });

  it("rejects non-string explicit status values (unroutable by the string domain)", () => {
    const step: Partial<StepDefinition> = {
      id: "review",
      type: "agent",
      outputs: { status: { values: [1] } },
      returns: { status: { values: ["fixed", "unfixable"] } },
    };

    expect(() => compileAgentOutputSchema(step as StepDefinition)).toThrowError(ValidationError);
    try {
      compileAgentOutputSchema(step as StepDefinition);
    } catch (err) {
      expect((err as Error).message).toContain('declares value(s) 1');
      expect((err as Error).message).toContain("outside returns.status.values");
    }
  });
});
