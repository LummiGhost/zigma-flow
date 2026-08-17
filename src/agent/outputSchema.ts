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

export interface MergedOutputContract {
  /** Union of outputs and outputs_schema keys — every key is required. */
  names: string[];
  /**
   * Per-key merged declaration: outputs_schema overlays outputs per field.
   * When the step declares returns.status, declarations["status"] carries
   * the returns-merged status declaration; "status" joins names only when
   * explicitly declared in outputs/outputs_schema.
   */
  declarations: Record<string, Record<string, unknown>>;
}

/**
 * Merge an explicitly declared outputs/outputs_schema `status` declaration
 * with the step's returns.status routing domain — the single shared merge
 * rule used by both the compiled schema and the Engine's final-line
 * validator, so the native boundary and the runtime cannot drift.
 *
 * returns.status.values is the Engine's routing domain: applyStatusReturn
 * rejects any reported status outside it. A declaration the compiled schema
 * advertises but the Engine cannot route (or vice versa) is a contract
 * conflict, not a merge candidate. Fail-closed rules:
 *
 *   - declared type must be "string" (or absent) — returns.status values
 *     are strings; any other runnable type is rejected at compile time.
 *   - declared values/enum must be a subset of returns.status.values — a
 *     value outside the routing domain is unrouteable and rejected.
 *   - required semantics never conflict: an explicitly declared `status`
 *     key is required (every declared output key is), which is stricter
 *     than and therefore compatible with an optional returns.status; a
 *     required returns.status additionally requires the key in the compiled
 *     schema.
 *
 * When compatible, the merged declaration keeps the explicit (stricter)
 * values and explicit metadata such as description.
 */
function mergeStatusDeclaration(
  explicit: Record<string, unknown> | undefined,
  returns: { values: string[]; required?: boolean },
): Record<string, unknown> {
  if (explicit === undefined) {
    return { type: "string", values: [...returns.values] };
  }

  const declaredType = explicit["type"];
  if (declaredType !== undefined && declaredType !== "string") {
    throw new ValidationError(
      `Output "status" declares type ${JSON.stringify(declaredType)} which conflicts with returns.status ` +
      `(status values are strings). Declare type: "string" or drop the explicit type.`,
      { details: { output: "status", type: declaredType, returnsValues: returns.values } }
    );
  }

  const explicitValues: unknown[] | undefined =
    Array.isArray(explicit["values"]) ? (explicit["values"] as unknown[])
    : Array.isArray(explicit["enum"]) ? (explicit["enum"] as unknown[])
    : undefined;

  let mergedValues: unknown[] = [...returns.values];
  if (explicitValues !== undefined) {
    const returnsSet = new Set<unknown>(returns.values);
    const unroutable = explicitValues.filter((v) => !returnsSet.has(v));
    if (unroutable.length > 0) {
      throw new ValidationError(
        `Output "status" declares value(s) ${unroutable.map((v) => JSON.stringify(v)).join(", ")} ` +
        `outside returns.status.values [${returns.values.map((v) => JSON.stringify(v)).join(", ")}]. ` +
        `Status values outside the routing domain cannot be routed — restrict the declaration to a subset of returns.status.values.`,
        { details: { output: "status", unroutable, returnsValues: returns.values } }
      );
    }
    mergedValues = explicitValues;
  }

  const merged: Record<string, unknown> = { type: "string", values: mergedValues };
  if (typeof explicit["description"] === "string") {
    merged["description"] = explicit["description"];
  }
  return merged;
}

/**
 * Union outputs + outputs_schema keys and merge each pair with the same
 * semantics the compiled schema uses: outputs_schema overlays its fields
 * (type/values) onto outputs without discarding outputs-only metadata such
 * as description. When the step declares returns.status, the merged
 * `status` declaration additionally folds in the returns routing domain
 * (fail-closed on conflicts — see mergeStatusDeclaration) and is exposed
 * under declarations["status"] WITHOUT joining names: it stays an implicit
 * key unless explicitly declared, so an optional returns.status never
 * makes outputs.status required by itself. Shared by compileAgentOutputSchema
 * and the Engine's final-line report validator so both enforce one
 * identical contract.
 */
export function mergeOutputDeclarations(step: StepDefinition): MergedOutputContract {
  const names = [...new Set([
    ...Object.keys(step.outputs ?? {}),
    ...Object.keys(step.outputs_schema ?? {}),
  ])].sort();

  const declarations: Record<string, Record<string, unknown>> = {};
  for (const name of names) {
    // Validate each raw declaration BEFORE merging — a non-object declaration
    // (e.g. `title: "a string"`) must raise ValidationError instead of being
    // silently dropped by the per-key merge.
    const outputsDecl = parseOutputDeclaration(name, (step.outputs ?? {})[name]);
    const schemaDecl = parseOutputDeclaration(name, (step.outputs_schema ?? {})[name]);
    declarations[name] = { ...outputsDecl, ...schemaDecl };
  }

  if (step.returns?.status) {
    declarations["status"] = mergeStatusDeclaration(declarations["status"], step.returns.status);
  }
  return { names, declarations };
}

export function compileAgentOutputSchema(step: StepDefinition): JsonSchema {
  const { names, declarations } = mergeOutputDeclarations(step);

  const outputProperties: Record<string, JsonSchema> = {};
  for (const name of names) {
    outputProperties[name] = outputProperty(name, declarations[name]!);
  }

  // Issue #256 canonical location: the prompt contract directs agents to
  // write `outputs.status`, and the Engine's final-line validator accepts
  // that key (a legacy top-level `status` is still recognized too). The
  // compiled schema therefore declares status INSIDE outputs so built-in
  // backends (Codex/Claude native schema enforcement) accept the exact shape
  // the prompt demands; a required returns.status makes outputs.status
  // required. The schema is NOT hardcoded here: it is the merged status
  // declaration produced by mergeOutputDeclarations (explicit
  // outputs/outputs_schema `status` merged with returns.status, fail-closed
  // on conflicts), so the native boundary and the Engine's final-line
  // validator enforce the exact same type/values contract. The legacy
  // top-level `status` remains an OPTIONAL property (mvp-contracts §2.6) so
  // older report shapes still pass native validation when returns.status is
  // not required (a required returns.status makes outputs.status required,
  // so a top-level-only report fails native enforcement).
  const outputsRequired = [...names];
  if (step.returns?.status) {
    outputProperties["status"] = outputProperty("status", declarations["status"]!);
    if (step.returns.status.required && !outputsRequired.includes("status")) {
      outputsRequired.push("status");
    }
  }

  const properties: Record<string, JsonSchema> = {
    outputs: { type: "object", properties: outputProperties, required: outputsRequired, additionalProperties: false },
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
  }

  // Dual-source equality guard: a report may legitimately carry a legacy
  // top-level `status` OR the canonical `outputs.status`, but when BOTH are
  // present their values must be strictly equal — otherwise routing follows
  // the top-level value while the nested value is the one persisted. JSON
  // Schema has no cross-field equality operator, so the compiler approximates
  // it with one if/then guard per declared status value: the constraint
  // fires only when both locations are present and the top-level value
  // matches the guard's const. The Engine's final-line check remains the
  // authoritative enforcement (manual/custom accept paths bypass the native
  // schema boundary entirely).
  const statusGuards: JsonSchema[] = (step.returns?.status?.values ?? []).map((v) => ({
    if: {
      required: ["status"],
      properties: {
        status: { const: v },
        outputs: { required: ["status"] },
      },
    },
    then: {
      properties: {
        outputs: {
          properties: { status: { const: v } },
        },
      },
    },
  }));

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: false,
    ...(statusGuards.length > 0 ? { allOf: statusGuards } : {}),
  };
}

export function outputSchemaHash(schema: JsonSchema): string {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}
