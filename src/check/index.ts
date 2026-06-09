/**
 * Check step types and port — WF-P7-CHECK Step 2.
 *
 * Reference:
 *   - docs/phases/p7-check-step/workflows/wf-p7-check/01-cases-and-tests.md §Step 2 Handoff Notes
 *   - docs/mvp-contracts.md §2.8, §7
 *   - docs/architecture.md §9.4, §12.3
 */

import { CheckError } from "../utils/errors.js";

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

/**
 * Default `CheckRunner` implementation. Throws `CheckError` for any check
 * kind because no concrete kind implementations ship in this slice
 * (TD-P7-002 deferred to follow-on workflows).
 */
export class LocalCheckRunner implements CheckRunner {
  async resolveKind(checkId: string): Promise<void> {
    throw new CheckError(`Unknown check kind: ${checkId}`, {
      details: { checkId },
    });
  }

  async run(_opts: CheckRunnerRunOpts): Promise<CheckResult> {
    throw new CheckError(`Unknown check kind: ${_opts.checkId}`, {
      details: { checkId: _opts.checkId },
    });
  }
}
