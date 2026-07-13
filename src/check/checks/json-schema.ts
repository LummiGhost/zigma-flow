/**
 * json-schema check kind implementation.
 *
 * Reference: docs/phases/p7-check-step/workflows/wf-p7-filecheck/01-cases-and-tests.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";

import type { ValidateFunction } from "ajv";
import type { CheckResult } from "../index.js";
import { CheckError } from "../../utils/errors.js";

// Ajv is a CJS-only package (no `exports` field, no ESM build). Under NodeNext
// + esModuleInterop the named default import is not constructable at the type
// level. We load it at runtime via createRequire so the constructor call is
// always correct, and cast to the structural interface we need.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvCtor = _require("ajv") as {
  new (opts: { allErrors: boolean }): { compile(schema: unknown): ValidateFunction };
};

export async function checkJsonSchema(opts: {
  with: Record<string, unknown>;
  runDir: string;
  /** Job-level workspace directory; used as base for resolving relative file paths. */
  cwd?: string;
}): Promise<CheckResult> {
  const w = opts.with;

  if (typeof w["file"] !== "string") {
    throw new CheckError("json-schema: 'with.file' must be a string", {
      details: { with: w },
    });
  }
  if (typeof w["schema"] !== "string") {
    throw new CheckError("json-schema: 'with.schema' must be a string", {
      details: { with: w },
    });
  }

  const baseDir = opts.cwd ?? opts.runDir;
  const dataFile = w["file"];
  const schemaFile = w["schema"];

  const dataPath = path.isAbsolute(dataFile)
    ? dataFile
    : path.join(baseDir, dataFile);
  const schemaPath = path.isAbsolute(schemaFile)
    ? schemaFile
    : path.join(baseDir, schemaFile);

  // Read and parse both files — errors here are input errors, not semantic failures.
  let data: unknown;
  let schema: unknown;

  try {
    const raw = await fs.readFile(dataPath, "utf-8");
    data = JSON.parse(raw);
  } catch (err) {
    throw new CheckError(`json-schema: failed to read/parse data file: ${dataPath}`, {
      details: { path: dataPath },
      cause: err,
    });
  }

  try {
    const raw = await fs.readFile(schemaPath, "utf-8");
    schema = JSON.parse(raw);
  } catch (err) {
    throw new CheckError(`json-schema: failed to read/parse schema file: ${schemaPath}`, {
      details: { path: schemaPath },
      cause: err,
    });
  }

  const ajv = new AjvCtor({ allErrors: true });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    throw new CheckError(`json-schema: schema file is not a valid JSON Schema: ${schemaPath}`, {
      details: { path: schemaPath },
      cause: err,
    });
  }
  const valid = validate(data);

  if (valid) {
    return {
      passed: true,
      check_id: "zigma/json-schema",
      failures: [],
      artifacts: [],
    };
  }

  const failures = (validate.errors ?? []).map((e) => {
    const instancePath = (e as { instancePath?: string }).instancePath ?? "";
    const message = (e as { message?: string }).message ?? "validation error";
    return `${instancePath}: ${message}`;
  });

  return {
    passed: false,
    check_id: "zigma/json-schema",
    failures,
    artifacts: [],
  };
}
