/**
 * `zigma-flow retry --job <id>` command handler.
 *
 * Retries a job that is in a terminal state (completed, failed, or blocked)
 * in the active run.
 *
 * Pipeline:
 *   1. Read active_run from .zigma-flow/config.json → ConfigError if absent.
 *   2. Resolve run directory from active run id.
 *   3. Validate job exists in state.
 *   4. Call retryJob({ runDir, runId, jobId, clock, reason, retryInputs }).
 *   5. Print a success message.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/
 */

import { join } from "node:path";

import { retryJob } from "../engine/retryJob.js";
import { readActiveRun, LocalStateStore } from "../run/index.js";
import type { Clock } from "../run/index.js";
import { ConfigError, UserInputError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// retryAction options
// ---------------------------------------------------------------------------

export interface RetryActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Job id to retry. */
  jobId: string;
  /** Optional human-readable reason for the retry. */
  reason?: string;
  /** Optional wholesale-replacement inputs for the retry attempt. */
  retryInputs?: Record<string, string>;
  /** Clock for timestamping events. */
  clock: Clock;
}

// ---------------------------------------------------------------------------
// retryAction
// ---------------------------------------------------------------------------

export async function retryAction(opts: RetryActionOpts): Promise<void> {
  const { zigmaflowDir, jobId, reason, retryInputs, clock } = opts;

  // 1. Read active_run from config.json
  const activeRunId = await readActiveRun(zigmaflowDir);
  if (activeRunId === null) {
    throw new ConfigError(
      "No active run found. Run `zigma-flow run` first to create a run.",
      { details: { zigmaflowDir } }
    );
  }

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
  const runDir = join(runsDir, activeRunId);

  // 2. Validate job exists in state
  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new ConfigError(`Run directory not found or state.json missing: ${runDir}`);
  }

  if (state.jobs[jobId] === undefined) {
    throw new UserInputError(
      `Job "${jobId}" not found in run ${activeRunId}`,
      { details: { jobId, runId: activeRunId } }
    );
  }

  // 3. Retry the job (Engine owns all state transitions)
  await retryJob({
    runDir,
    runId: activeRunId,
    jobId,
    clock,
    ...(reason !== undefined ? { reason } : {}),
    ...(retryInputs !== undefined ? { retryInputs } : {}),
  });

  // 4. Check resulting status — exhausted retries leave job blocked/failed
  const snap = await stateStore.readSnapshot(runDir);
  const newJobStatus = snap?.jobs[jobId]?.status;
  if (newJobStatus === "blocked" || newJobStatus === "failed") {
    console.error(`Job '${jobId}' max attempts exceeded — status: ${newJobStatus}.`);
    process.exitCode = 1;
    return;
  }

  const attempt = snap?.jobs[jobId]?.attempt ?? "?";
  console.log(`Job '${jobId}' retried (attempt ${attempt}).`);
}
