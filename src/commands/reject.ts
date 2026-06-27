/**
 * `zigma-flow reject` command handler.
 *
 * Records a rejection decision for a human gate step in the active run.
 *
 * Reference: docs/phases/p15-human-gate/02-development-plan.md AD-P15-004
 */

import { join } from "node:path";

import { recordHumanDecision } from "../engine/humanGate.js";
import { readActiveRun } from "../run/index.js";
import type { Clock } from "../run/index.js";
import { LocalStateStore } from "../run/index.js";
import { ConfigError, StateError, UserInputError } from "../utils/index.js";

export interface RejectActionOpts {
  zigmaflowDir: string;
  jobId: string;
  comment: string;
  stepId?: string;
  clock: Clock;
}

export async function rejectAction(opts: RejectActionOpts): Promise<void> {
  const { zigmaflowDir, jobId, stepId, comment, clock } = opts;

  const activeRunId = await readActiveRun(zigmaflowDir);
  if (activeRunId === null) {
    throw new ConfigError(
      "No active run found. Run `zigma-flow run` first.",
      { details: { zigmaflowDir } }
    );
  }

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
  const runDir = join(runsDir, activeRunId);

  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json not found for run ${activeRunId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new UserInputError(
      `Job "${jobId}" not found in run ${activeRunId}`,
      { details: { jobId, runId: activeRunId } }
    );
  }

  // Auto-detect step if not provided
  let resolvedStepId = stepId;
  if (resolvedStepId === undefined) {
    if (jobState.step_status === "awaiting_human") {
      resolvedStepId = jobState.current_step;
    } else {
      const awaitingEntries = Object.entries(state.jobs)
        .filter(([, js]) => js.step_status === "awaiting_human");

      if (awaitingEntries.length === 0) {
        throw new UserInputError(
          "No step is currently awaiting human input. Use `zigma-flow status` to check.",
          { details: { runId: activeRunId } }
        );
      }

      if (awaitingEntries.length > 1) {
        throw new UserInputError(
          "Multiple steps are awaiting human input. Use --step to specify which one.",
          { details: { awaitingSteps: awaitingEntries.map(([jid, js]) => `${jid}/${js.current_step}`) } }
        );
      }

      resolvedStepId = awaitingEntries[0]![1].current_step;
    }
  }

  if (resolvedStepId === undefined) {
    throw new UserInputError(
      "Could not determine which step to reject. Use --step <id>.",
      { details: { jobId } }
    );
  }

  // Validate step is awaiting_human
  if (jobState.step_status !== "awaiting_human") {
    throw new StateError(
      `Step "${resolvedStepId}" in job "${jobId}" is not awaiting human input.`,
      { details: { jobId, stepId: resolvedStepId, stepStatus: jobState.step_status } }
    );
  }

  const decidedBy = process.env["USER"] ?? process.env["USERNAME"] ?? undefined;

  await recordHumanDecision({
    runDir,
    runId: activeRunId,
    jobId,
    stepId: resolvedStepId,
    decision: "rejected",
    comment,
    ...(decidedBy !== undefined ? { decidedBy } : {}),
    clock,
    stateStore,
  });

  console.log(`Rejected step "${resolvedStepId}" in job "${jobId}" of run ${activeRunId}.`);
  console.log(`Comment: ${comment}`);
  console.log("The router (if configured) may retry the upstream job.");
}
