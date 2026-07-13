/**
 * json-parse check kind implementation.
 *
 * Reference: docs/phases/p7-check-step/workflows/wf-p7-filecheck/01-cases-and-tests.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { CheckResult } from "../index.js";
import { CheckError } from "../../utils/errors.js";

export async function checkJsonParse(opts: {
  with: Record<string, unknown>;
  runDir: string;
  /** Job-level workspace directory; used as base for resolving relative file paths. */
  cwd?: string;
}): Promise<CheckResult> {
  const w = opts.with;

  if (typeof w["file"] !== "string") {
    throw new CheckError("json-parse: 'with.file' must be a string", {
      details: { with: w },
    });
  }

  const baseDir = opts.cwd ?? opts.runDir;
  const file = w["file"];
  const resolved = path.isAbsolute(file)
    ? file
    : path.join(baseDir, file);

  let content: string;
  try {
    content = await fs.readFile(resolved, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      check_id: "zigma/json-parse",
      failures: [`${resolved}: read error: ${msg}`],
      artifacts: [],
    };
  }

  try {
    JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        passed: false,
        check_id: "zigma/json-parse",
        failures: [`${resolved}: SyntaxError at ${err.message}`],
        artifacts: [],
      };
    }
    throw err;
  }

  return {
    passed: true,
    check_id: "zigma/json-parse",
    failures: [],
    artifacts: [],
  };
}
