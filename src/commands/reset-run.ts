/**
 * `zigma-flow reset-run [run-id]` command handler.
 *
 * Resets a stuck/errored run's state machine to the most recent valid state,
 * allowing it to be resumed with `invoke --resume <run-id>`.
 *
 * Pipeline:
 *   1. Resolve run id from positional argument or --latest.
 *   2. Validate state exists and has resettable jobs.
 *   3. Show what will change and prompt for confirmation (unless --force or
 *      --dry-run).
 *   4. Call resetRun({ runDir, runId, clock, dryRun }).
 *   5. Print a summary of changes.
 *
 * Reference: GitHub Issue #237
 */

import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { resetRun } from "../engine/resetRun.js";
import { resolveRunId, LocalStateStore } from "../run/index.js";
import type { Clock } from "../run/index.js";
import { ConfigError, UserInputError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// resetRunAction options
// ---------------------------------------------------------------------------

export interface ResetRunActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Clock for timestamping events. */
  clock: Clock;
  /** Optional explicit run id (from positional argument). */
  runId?: string;
  /** Use the most recently created run (from --latest flag). */
  latest?: boolean;
  /** If true, show what would change without applying. */
  dryRun?: boolean;
  /** If true, skip confirmation prompt. */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// resetRunAction
// ---------------------------------------------------------------------------

export async function resetRunAction(opts: ResetRunActionOpts): Promise<void> {
  const { zigmaflowDir, clock, runId, dryRun, force } = opts;

  // 1. Resolve run id
  const activeRunId = await resolveRunId(
    zigmaflowDir,
    runId,
    opts.latest !== undefined ? { latest: opts.latest } : undefined
  );

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
  const runDir = join(runsDir, activeRunId);

  // 2. Validate state exists
  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new ConfigError(
      `Run directory not found or state.json missing: ${runDir}`
    );
  }

  // 3. Compute what will change (preview — without writing)
  const preview = await resetRun({
    runDir,
    runId: activeRunId,
    clock,
    dryRun: true,
  });

  // 4. Print preview
  console.log(`Run: ${activeRunId}`);
  console.log(
    `  Jobs to reset: ${preview.jobsReset} (${preview.jobChanges.map((c) => `${c.jobId}: ${c.fromStatus} → ${c.toStatus}`).join(", ") || "none"})`
  );
  console.log(`  Jobs that will become ready: ${preview.jobsReady}`);
  if (preview.runStatusChanged) {
    console.log(
      `  Run status: ${preview.previousRunStatus ?? "none"} → running`
    );
  } else {
    console.log(
      `  Run status: ${state.status ?? "running"} (unchanged)`
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: no changes applied.");
    return;
  }

  // 5. Confirmation prompt (skipped with --force)
  if (!force) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await rl.question(
        "\nApply these changes? [y/N] "
      );
      if (answer.trim().toLowerCase() !== "y") {
        console.log("Reset cancelled.");
        return;
      }
    } finally {
      rl.close();
    }
  }

  // 6. Apply the reset
  const result = await resetRun({
    runDir,
    runId: activeRunId,
    clock,
  });

  // 7. Print summary
  console.log(`\nReset complete:`);
  console.log(`  ${result.jobsReset} job(s) reset to waiting`);
  if (result.jobsReady > 0) {
    console.log(`  ${result.jobsReady} job(s) marked ready`);
  }
  if (result.runStatusChanged) {
    console.log(
      `  Run status changed: ${result.previousRunStatus ?? "none"} → running`
    );
  }
  console.log(`\nRun '${activeRunId}' can now be resumed with:`);
  console.log(`  zigma-flow invoke --resume ${activeRunId}`);
}
