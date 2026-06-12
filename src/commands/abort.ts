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
import { readActiveRun } from "../run/index.js";
import type { Clock } from "../run/index.js";
import { ConfigError } from "../utils/index.js";

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
}

// ---------------------------------------------------------------------------
// abortAction
// ---------------------------------------------------------------------------

export async function abortAction(opts: AbortActionOpts): Promise<void> {
  const { zigmaflowDir, clock, reason } = opts;

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

  // 2. Abort the run (Engine owns all state transitions)
  await abortRun({
    runDir,
    runId: activeRunId,
    clock,
    ...(reason !== undefined ? { reason } : {}),
  });

  console.log(`Run ${activeRunId} cancelled.`);
}
