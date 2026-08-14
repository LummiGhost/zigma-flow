import { createHash } from "node:crypto";
import type { StepDefinition } from "../workflow/index.js";

export type JsonSchema = Record<string, unknown>;

function outputProperty(value: unknown): JsonSchema {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const definition = value as Record<string, unknown>;
  const schema: JsonSchema = {};
  if (typeof definition["type"] === "string") schema["type"] = definition["type"];
  const values = Array.isArray(definition["values"]) ? definition["values"] : Array.isArray(definition["enum"]) ? definition["enum"] : undefined;
  if (values !== undefined) schema["enum"] = values;
  if (typeof definition["description"] === "string") schema["description"] = definition["description"];
  return schema;
}

export function compileAgentOutputSchema(step: StepDefinition): JsonSchema {
  const declarations = { ...(step.outputs ?? {}), ...(step.outputs_schema ?? {}) };
  const outputProperties = Object.fromEntries(Object.entries(declarations).map(([name, value]) => [name, outputProperty(value)]));
  const properties: Record<string, JsonSchema> = {
    outputs: { type: "object", properties: outputProperties, required: Object.keys(outputProperties).sort(), additionalProperties: false },
    artifacts: { type: "array", items: { type: "object" } },
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
