/**
 * protected-runtime-files check kind implementation — WF-P7-GITCHECK Step 2.
 *
 * Fails when any changed file in the working tree matches one of the
 * hardcoded runtime-state glob patterns (state.json, events.jsonl under
 * `.zigma-flow/runs/`). Intended to prevent accidental commits of
 * mutable runtime artifacts.
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-gitcheck/01-cases-and-tests.md §T-GC-5, §T-GC-6
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

/** Hardcoded patterns for mutable runtime artifacts that must never be committed. */
const PROTECTED_PATTERNS = [
  ".zigma-flow/runs/*/state.json",
  ".zigma-flow/runs/*/events.jsonl",
];

export async function checkProtectedRuntimeFiles(opts: {
  with: Record<string, unknown>;
  runDir: string;
  git?: GitInspector;
}): Promise<CheckResult> {
  const w = opts.with;

  // Optional with.cwd — throw if provided but wrong type.
  if ("cwd" in w && typeof w["cwd"] !== "string") {
    throw new CheckError(
      "protected-runtime-files: 'with.cwd' must be a string",
      { details: { cwd: w["cwd"] } }
    );
  }

  // Optional with.run_dir — throw if provided but wrong type.
  if ("run_dir" in w && typeof w["run_dir"] !== "string") {
    throw new CheckError(
      "protected-runtime-files: 'with.run_dir' must be a string",
      { details: { run_dir: w["run_dir"] } }
    );
  }

  const cwd =
    typeof w["cwd"] === "string" ? w["cwd"] : opts.runDir;

  const git = opts.git ?? new SimpleGitInspector();
  const changed = await git.changedFiles(cwd);

  const matched = micromatch(changed, PROTECTED_PATTERNS);

  if (matched.length === 0) {
    return {
      passed: true,
      check_id: "zigma/protected-runtime-files",
      failures: [],
      artifacts: [],
    };
  }

  const failures = matched.map((f) => `${f}: protected runtime file modified`);

  return {
    passed: false,
    check_id: "zigma/protected-runtime-files",
    failures,
    artifacts: [],
  };
}
