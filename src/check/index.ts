/**
 * Check step types and port — WF-P7-CHECK Step 2.
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-check/01-cases-and-tests.md §Step 2 Handoff Notes
 *   - docs/mvp-contracts.md §2.8, §7
 *   - docs/architecture.md §9.4, §12.3
 */

import { CheckError } from "../utils/errors.js";
import { checkFileExists } from "./checks/file-exists.js";
import { checkJsonParse } from "./checks/json-parse.js";
import { checkJsonSchema } from "./checks/json-schema.js";
import { checkRequiredFields } from "./checks/required-fields.js";
import { checkGitDiffExists } from "./checks/git-diff-exists.js";
import { checkForbiddenPaths } from "./checks/forbidden-paths.js";
import { checkProtectedRuntimeFiles } from "./checks/protected-runtime-files.js";

// ---------------------------------------------------------------------------
// CheckResult — snake_case shape; identical to the on-disk check-result.json
// ---------------------------------------------------------------------------

export interface CheckResult {
  passed: boolean;
  check_id: string;
  failures: string[];
  artifacts: string[];
}

// ---------------------------------------------------------------------------
// CheckRunnerRunOpts — options passed to CheckRunner.run()
// ---------------------------------------------------------------------------

export interface CheckRunnerRunOpts {
  checkId: string;
  jobId: string;
  stepId: string;
  runDir: string;
  with?: Record<string, unknown>;
  /** Job-level working directory resolved from `jobs.<id>.workspace`. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// CheckRunner — port interface
// ---------------------------------------------------------------------------

/**
 * CheckRunner is the port through which the executor dispatches to a
 * concrete check-kind implementation. The executor calls `resolveKind()`
 * as a pre-flight BEFORE appending any events; if the kind is not
 * registered, `resolveKind()` MUST throw `CheckError`. `run()` is then
 * called on the success path only.
 */
export interface CheckRunner {
  /**
   * Pre-flight resolution check. MUST throw `CheckError` if the given
   * `checkId` is not registered in this runner. Called BEFORE any events
   * are appended so that unknown-kind failures leave the event log and
   * state.json completely unchanged.
   */
  resolveKind(checkId: string): Promise<void>;

  /**
   * Execute the check. Only called after `resolveKind()` has returned
   * without throwing. The runner MUST NOT write state.json or events.jsonl.
   */
  run(opts: CheckRunnerRunOpts): Promise<CheckResult>;
}

// ---------------------------------------------------------------------------
// LocalCheckRunner — default stub; all kinds are unregistered (TD-P7-002)
// ---------------------------------------------------------------------------

const KNOWN_KINDS = new Set([
  "zigma/file-exists",
  "zigma/json-parse",
  "zigma/json-schema",
  "zigma/required-fields",
  "zigma/git-diff-exists",
  "zigma/forbidden-paths",
  "zigma/protected-runtime-files",
]);

/**
 * Default `CheckRunner` implementation. Dispatches to concrete check-kind
 * implementations for known kinds; throws `CheckError` for unknown kinds.
 */
export class LocalCheckRunner implements CheckRunner {
  async resolveKind(checkId: string): Promise<void> {
    if (!KNOWN_KINDS.has(checkId)) {
      throw new CheckError(`Unknown check kind: ${checkId}`, {
        details: { checkId },
      });
    }
    return Promise.resolve();
  }

  async run(opts: CheckRunnerRunOpts): Promise<CheckResult> {
    const w = opts.with ?? {};
    const runDir = opts.runDir;
    const cwd = opts.cwd;

    switch (opts.checkId) {
      case "zigma/file-exists":
        return checkFileExists({ with: w, runDir, ...(cwd !== undefined ? { cwd } : {}) });
      case "zigma/json-parse":
        return checkJsonParse({ with: w, runDir, ...(cwd !== undefined ? { cwd } : {}) });
      case "zigma/json-schema":
        return checkJsonSchema({ with: w, runDir, ...(cwd !== undefined ? { cwd } : {}) });
      case "zigma/required-fields":
        return checkRequiredFields({ with: w, runDir, ...(cwd !== undefined ? { cwd } : {}) });
      case "zigma/git-diff-exists":
        return checkGitDiffExists({ with: w, runDir, ...(cwd !== undefined ? { cwd } : {}) });
      case "zigma/forbidden-paths":
        return checkForbiddenPaths({ with: w, runDir, ...(cwd !== undefined ? { cwd } : {}) });
      case "zigma/protected-runtime-files":
        return checkProtectedRuntimeFiles({ with: w, runDir, ...(cwd !== undefined ? { cwd } : {}) });
      default:
        throw new CheckError(`Unknown check kind: ${opts.checkId}`, {
          details: { checkId: opts.checkId },
        });
    }
  }
}
