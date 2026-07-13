/**
 * git-diff-exists check kind implementation — WF-P7-GITCHECK Step 2.
 *
 * Passes when the git working tree at `cwd` has at least one uncommitted
 * change (staged, unstaged, or untracked). Fails when the tree is clean.
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-gitcheck/01-cases-and-tests.md §T-GC-1, §T-GC-2
 *   - docs/mvp-contracts.md §2.8
 */

import type { CheckResult } from "../index.js";
import type { GitInspector } from "../../git/index.js";
import { SimpleGitInspector } from "../../git/index.js";
import { CheckError } from "../../utils/errors.js";

export async function checkGitDiffExists(opts: {
  with: Record<string, unknown>;
  runDir: string;
  /** Job-level workspace directory; used as default cwd (lower priority than with.cwd). */
  cwd?: string;
  git?: GitInspector;
}): Promise<CheckResult> {
  const w = opts.with;

  // Resolve cwd: with.cwd > job-level cwd > runDir
  let cwd: string;
  if ("cwd" in w) {
    if (typeof w["cwd"] !== "string") {
      throw new CheckError("git-diff-exists: 'with.cwd' must be a string", {
        details: { cwd: w["cwd"] },
      });
    }
    cwd = w["cwd"];
  } else {
    cwd = opts.cwd ?? opts.runDir;
  }

  const git = opts.git ?? new SimpleGitInspector();
  const hasDiff = await git.diffExists(cwd);

  if (hasDiff) {
    return {
      passed: true,
      check_id: "zigma/git-diff-exists",
      failures: [],
      artifacts: [],
    };
  }

  return {
    passed: false,
    check_id: "zigma/git-diff-exists",
    failures: [`no diff in ${cwd}`],
    artifacts: [],
  };
}
