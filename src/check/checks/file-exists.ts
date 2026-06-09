/**
 * file-exists check kind implementation.
 *
 * Reference: docs/phases/p7-check-step/workflows/wf-p7-filecheck/01-cases-and-tests.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { CheckResult } from "../index.js";
import { CheckError } from "../../utils/errors.js";

export async function checkFileExists(opts: {
  with: Record<string, unknown>;
  runDir: string;
}): Promise<CheckResult> {
  const w = opts.with;

  // Normalise: file → [file], files → files[]
  let files: string[];
  if (typeof w["file"] === "string") {
    files = [w["file"]];
  } else if (Array.isArray(w["files"])) {
    for (const f of w["files"]) {
      if (typeof f !== "string") {
        throw new CheckError(
          "file-exists: each entry in 'files' must be a string",
          { details: { files: w["files"] } }
        );
      }
    }
    files = w["files"] as string[];
  } else {
    throw new CheckError(
      "file-exists: 'with' must contain a 'file' string or 'files' string[]",
      { details: { with: w } }
    );
  }

  const failures: string[] = [];

  for (const file of files) {
    const resolved = path.isAbsolute(file)
      ? file
      : path.join(opts.runDir, file);
    try {
      await fs.stat(resolved);
    } catch {
      failures.push(`${resolved}: file not found`);
    }
  }

  return {
    passed: failures.length === 0,
    check_id: "zigma/file-exists",
    failures,
    artifacts: [],
  };
}
