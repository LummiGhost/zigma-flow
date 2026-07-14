/**
 * `zigma-flow next --job` command handler.
 *
 * Accepts the Agent report for the current step of a job in the active run.
 * Called after an Agent has written `report.json` to the canonical artifact
 * location for the current step.
 *
 * Pipeline:
 *   1. Read active_run from .zigma-flow/config.json → ConfigError if absent.
 *   2. Resolve run directory from active run id.
 *   3. Call acceptAgentReport({ runDir, runId, jobId, clock }).
 *   4. Print a success message.
 *
 * Reference: docs/phases/p9-agent-report-retry/workflows/wf-p9-accept/
 * WF-P9-ACCEPT Step 2.
 */

import { join } from "node:path";

import { acceptAgentReport } from "../engine/accept.js";
import { resolveRunId } from "../run/index.js";
import type { Clock } from "../run/index.js";
import { deprecationWarn } from "../utils/index.js";

// ---------------------------------------------------------------------------
// nextAction options
// ---------------------------------------------------------------------------

export interface NextActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Job id whose current agent step report should be accepted. */
  jobId: string;
  /** Clock for timestamping the agent_report_accepted event. */
  clock: Clock;
  /** Optional explicit run id (from --run flag). */
  runId?: string;
  /** Use the most recently created run (from --latest flag, explicit). */
  latest?: boolean;
}

// ---------------------------------------------------------------------------
// nextAction
// ---------------------------------------------------------------------------

export async function nextAction(opts: NextActionOpts): Promise<void> {
  deprecationWarn("'zigma-flow next' is deprecated", "zigma-flow invoke");
  const { zigmaflowDir, jobId, clock, runId } = opts;

  // 1. Resolve run id (explicit --run, --latest, or deprecated fallback from config)
  const activeRunId = await resolveRunId(zigmaflowDir, runId, opts.latest !== undefined ? { latest: opts.latest } : undefined);

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
  const runDir = join(runsDir, activeRunId);

  // 2. Accept agent report (Engine owns all state transitions)
  await acceptAgentReport({
    runDir,
    runId: activeRunId,
    jobId,
    clock,
  });

  console.log(`Agent report accepted for job "${jobId}" in run ${activeRunId}.`);
}
