import { createHash } from "node:crypto";
import type { StepDefinition } from "../workflow/index.js";
import { ValidationError } from "../utils/index.js";

export type JsonSchema = Record<string, unknown>;

/**
 * Output `type` vocabulary the Engine runtime can validate. The final-line
 * checks in acceptAgentReport/runAll compare against `typeof` results
 * ("string" | "number" | "boolean" | "object" | "array" | "null"), so any
 * other declaration cannot be enforced and is rejected at compile time.
 */
const SUPPORTED_OUTPUT_TYPES = new Set(["string", "number", "boolean", "object", "array", "null"]);

function parseOutputDeclaration(name: string, value: unknown): Record<string, unknown> {
  // null/undefined is the YAML empty shorthand (e.g. `title:`) — an
  // unconstrained declaration, equivalent to {}.
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(
      `Output "${name}" declaration must be an object (e.g. { type: "string", values: [...] }) or an empty object {}`,
      { details: { output: name, declaration: value } }
    );
  }
  const definition = value as Record<string, unknown>;

  const declaredType = definition["type"];
  if (declaredType !== undefined) {
    if (typeof declaredType !== "string" || !SUPPORTED_OUTPUT_TYPES.has(declaredType)) {
      throw new ValidationError(
        `Output "${name}" declares unsupported type ${JSON.stringify(declaredType)}. ` +
        `Supported types: ${[...SUPPORTED_OUTPUT_TYPES].join(", ")}`,
        { details: { output: name, type: declaredType } }
      );
    }
  }

  for (const constraint of ["values", "enum"]) {
    const declaredValues = definition[constraint];
    if (declaredValues !== undefined && !Array.isArray(declaredValues)) {
      throw new ValidationError(
        `Output "${name}" "${constraint}" must be an array of allowed values`,
        { details: { output: name, constraint, value: declaredValues } }
      );
    }
  }

  return definition;
}

function outputProperty(name: string, value: unknown): JsonSchema {
  const definition = parseOutputDeclaration(name, value);
  const schema: JsonSchema = {};
  if (typeof definition["type"] === "string") schema["type"] = definition["type"];
  const values = Array.isArray(definition["values"]) ? definition["values"] : Array.isArray(definition["enum"]) ? definition["enum"] : undefined;
  if (values !== undefined) schema["enum"] = values;
  if (typeof definition["description"] === "string") schema["description"] = definition["description"];
  return schema;
}

export function compileAgentOutputSchema(step: StepDefinition): JsonSchema {
  const names = [...new Set([
    ...Object.keys(step.outputs ?? {}),
    ...Object.keys(step.outputs_schema ?? {}),
  ])].sort();

  const outputProperties: Record<string, JsonSchema> = {};
  for (const name of names) {
    // Validate each raw declaration BEFORE merging — a non-object declaration
    // (e.g. `title: "a string"`) must raise ValidationError instead of being
    // silently dropped by the per-key merge.
    const outputsDecl = parseOutputDeclaration(name, (step.outputs ?? {})[name]);
    const schemaDecl = parseOutputDeclaration(name, (step.outputs_schema ?? {})[name]);
    // Per-key merge: outputs_schema overlays its fields (type/values) without
    // discarding outputs metadata such as description.
    const merged: Record<string, unknown> = { ...outputsDecl, ...schemaDecl };
    outputProperties[name] = outputProperty(name, merged);
  }

  const properties: Record<string, JsonSchema> = {
    outputs: { type: "object", properties: outputProperties, required: names, additionalProperties: false },
    // Artifact references are strings (relative step-artifact paths or
    // artifact:// refs) — the same shape the Engine's required_artifacts
    // check and the canonical prompt contract consume.
    artifacts: { type: "array", items: { type: "string" } },
    signals: { type: "array", items: { type: "object", properties: { type: { type: "string" }, reason: { type: "string" } }, required: ["type"], additionalProperties: false } },
    summary: { type: "string" },
  };
  const required = ["outputs", "artifacts", "signals", "summary"];
  if (step.returns?.status) {
    properties["status"] = { type: "string", enum: step.returns.status.values };
    if (step.returns.status.required) required.push("status");
  }
  return { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, required, additionalProperties: false };
}

export function outputSchemaHash(schema: JsonSchema): string {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}
