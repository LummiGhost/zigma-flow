/**
 * `zigma-flow abort` command handler.
 *
 * Cancels the active run without deleting any artifacts.
 *
 * Pipeline:
 *   1. Read active_run from .zigma-flow/config.json → ConfigError if absent.
 *   2. Resolve run directory from active run id.
 *   3. Call abortRun({ runDir, runId, clock }).
 *   4. Print a success message.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/
 */

import { join } from "node:path";

import { abortRun } from "../engine/abort.js";
import { resolveRunId } from "../run/index.js";
import type { Clock } from "../run/index.js";

// ---------------------------------------------------------------------------
// abortAction options
// ---------------------------------------------------------------------------

export interface AbortActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Clock for timestamping events. */
  clock: Clock;
  /** Optional human-readable reason for the abort. */
  reason?: string;
  /** Optional explicit run id (from --run flag). */
  runId?: string;
  /** Use the most recently created run (from --latest flag, explicit). */
  latest?: boolean;
}

// ---------------------------------------------------------------------------
// abortAction
// ---------------------------------------------------------------------------

export async function abortAction(opts: AbortActionOpts): Promise<void> {
  const { zigmaflowDir, clock, reason, runId } = opts;

  // 1. Resolve run id (explicit --run, --latest, or deprecated fallback from config)
  const activeRunId = await resolveRunId(zigmaflowDir, runId, opts.latest !== undefined ? { latest: opts.latest } : undefined);

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
  const runDir = join(runsDir, activeRunId);

  // 2. Abort the run (Engine owns all state transitions)
  await abortRun({
    runDir,
    runId: activeRunId,
    clock,
    ...(reason !== undefined ? { reason } : {}),
  });

  console.log(`Run ${activeRunId} cancelled.`);
}
