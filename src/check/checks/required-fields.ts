/**
 * required-fields check kind implementation.
 *
 * Reference: docs/phases/p7-check-step/workflows/wf-p7-filecheck/01-cases-and-tests.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { CheckResult } from "../index.js";
import { CheckError } from "../../utils/errors.js";

export async function checkRequiredFields(opts: {
  with: Record<string, unknown>;
  runDir: string;
}): Promise<CheckResult> {
  const w = opts.with;

  if (typeof w["file"] !== "string") {
    throw new CheckError("required-fields: 'with.file' must be a string", {
      details: { with: w },
    });
  }
  if (!Array.isArray(w["fields"]) || (w["fields"] as unknown[]).some((f) => typeof f !== "string")) {
    throw new CheckError("required-fields: 'with.fields' must be a string[]", {
      details: { with: w },
    });
  }

  const file = w["file"];
  const fields = w["fields"] as string[];
  const resolved = path.isAbsolute(file)
    ? file
    : path.join(opts.runDir, file);

  let data: unknown;
  try {
    const raw = await fs.readFile(resolved, "utf-8");
    data = JSON.parse(raw);
  } catch (err) {
    throw new CheckError(`required-fields: failed to read/parse file: ${resolved}`, {
      details: { path: resolved },
      cause: err,
    });
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CheckError("required-fields: data file must contain a JSON object at the top level", {
      details: { path: resolved },
    });
  }

  const obj = data as Record<string, unknown>;
  const failures: string[] = [];

  for (const field of fields) {
    if (!(field in obj)) {
      failures.push(`${field}: missing`);
    } else {
      const value = obj[field];
      // Empty: null, "", or []
      if (
        value === null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0)
      ) {
        failures.push(`${field}: empty`);
      }
    }
  }

  return {
    passed: failures.length === 0,
    check_id: "zigma/required-fields",
    failures,
    artifacts: [],
  };
}
