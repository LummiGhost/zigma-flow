/**
 * `zigma-flow force-set <run-id>` command handler.
 *
 * Manually overrides a job's status for recovery when a run gets stuck
 * in a bad state (e.g. infinite re-invoke loop, engine bug).
 *
 * Supported statuses: completed, waiting, failed, blocked.
 *
 * Reference: Issue #228
 */

import { join } from "node:path";

import { forceSetJob } from "../engine/forceSet.js";
import { resolveRunId, LocalStateStore } from "../run/index.js";
import type { Clock } from "../run/index.js";
import { ConfigError, UserInputError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// forceSetAction options
// ---------------------------------------------------------------------------

export interface ForceSetActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Run identifier (positional argument). */
  runId?: string;
  /** Job id to force-set (required --job flag). */
  jobId: string;
  /** Target status (required --status flag). */
  status: string;
  /** Clock for timestamping events. */
  clock: Clock;
  /** Optional human-readable reason for the override. */
  reason?: string;
  /** Use the most recently created run (from --latest flag). */
  latest?: boolean;
}

// ---------------------------------------------------------------------------
// forceSetAction
// ---------------------------------------------------------------------------

export async function forceSetAction(opts: ForceSetActionOpts): Promise<void> {
  const { zigmaflowDir, jobId, status, clock, reason } = opts;

  // 1. Resolve run id (explicit positional, --latest, or deprecated fallback)
  const activeRunId = await resolveRunId(
    zigmaflowDir,
    opts.runId,
    opts.latest !== undefined ? { latest: opts.latest } : undefined,
  );

  // 2. Validate status
  const validStatuses = new Set(["completed", "waiting", "failed", "blocked"]);
  if (!validStatuses.has(status)) {
    throw new UserInputError(
      `Invalid status "${status}". Must be one of: completed, waiting, failed, blocked.`,
    );
  }

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
  const runDir = join(runsDir, activeRunId);

  // 3. Validate job exists in state
  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new ConfigError(`Run directory not found or state.json missing: ${runDir}`);
  }

  if (state.jobs[jobId] === undefined) {
    throw new UserInputError(
      `Job "${jobId}" not found in run ${activeRunId}`,
      { details: { jobId, runId: activeRunId } },
    );
  }

  // 4. Force-set the job (Engine owns all state transitions)
  await forceSetJob({
    runDir,
    runId: activeRunId,
    jobId,
    status: status as "completed" | "waiting" | "failed" | "blocked",
    clock,
    ...(reason !== undefined ? { reason } : {}),
  });

  console.log(`Job '${jobId}' in run ${activeRunId} force-set to '${status}'.`);
}
