/**
 * forbidden-paths check kind implementation — WF-P7-GITCHECK Step 2.
 *
 * Fails when any changed file in the working tree matches one of the
 * caller-supplied glob patterns (`with.paths`). Uses micromatch for
 * glob evaluation.
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-gitcheck/01-cases-and-tests.md §T-GC-3, §T-GC-4
 *   - docs/mvp-contracts.md §2.8
 */

import { createRequire } from "node:module";

import type { CheckResult } from "../index.js";
import type { GitInspector } from "../../git/index.js";
import { SimpleGitInspector } from "../../git/index.js";
import { CheckError } from "../../utils/errors.js";

// micromatch ships as a CommonJS module; @types/micromatch uses `export =`
// which conflicts with ESM `import default` under NodeNext. Use createRequire
// to avoid the TypeScript type conflict.
const _require = createRequire(import.meta.url);
const micromatch = _require("micromatch") as {
  (list: string[], patterns: string[]): string[];
  isMatch(file: string, pattern: string): boolean;
};

export async function checkForbiddenPaths(opts: {
  with: Record<string, unknown>;
  runDir: string;
  /** Job-level workspace directory; used as default cwd (lower priority than with.cwd). */
  cwd?: string;
  git?: GitInspector;
}): Promise<CheckResult> {
  const w = opts.with;

  // with.paths is required and must be a string[].
  if (
    !Array.isArray(w["paths"]) ||
    !(w["paths"] as unknown[]).every((p) => typeof p === "string")
  ) {
    throw new CheckError(
      "forbidden-paths: 'with.paths' must be a non-empty string[]",
      { details: { paths: w["paths"] } }
    );
  }
  const patterns = w["paths"] as string[];

  // Resolve cwd: with.cwd > job-level cwd > runDir
  let cwd: string;
  if ("cwd" in w) {
    if (typeof w["cwd"] !== "string") {
      throw new CheckError("forbidden-paths: 'with.cwd' must be a string", {
        details: { cwd: w["cwd"] },
      });
    }
    cwd = w["cwd"];
  } else {
    cwd = opts.cwd ?? opts.runDir;
  }

  const git = opts.git ?? new SimpleGitInspector();
  const changed = await git.changedFiles(cwd);

  // Find all changed files that match any of the forbidden patterns.
  const matched = micromatch(changed, patterns);

  if (matched.length === 0) {
    return {
      passed: true,
      check_id: "zigma/forbidden-paths",
      failures: [],
      artifacts: [],
    };
  }

  // Build failure messages: one per matched file, identifying the pattern.
  const failures = matched.map((f) => {
    const pattern =
      patterns.find((p) => micromatch.isMatch(f, p)) ?? patterns[0] ?? "*";
    return `${f}: matched forbidden pattern ${pattern}`;
  });

  return {
    passed: false,
    check_id: "zigma/forbidden-paths",
    failures,
    artifacts: [],
  };
}
