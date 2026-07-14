/**
 * `zigma-flow approve` command handler.
 *
 * @deprecated Use `zigma-flow resume --input decision=approve` instead.
 * This command is kept as a thin wrapper for backward compatibility.
 *
 * Records an approval decision for a human gate step in the active run.
 *
 * Reference: docs/phases/p15-human-gate/02-development-plan.md AD-P15-004
 * v0.6 Issue #210 — deprecated in favor of unified resume command
 */

import { join } from "node:path";

import { recordHumanDecision } from "../engine/humanGate.js";
import { readActiveRun } from "../run/index.js";
import type { Clock } from "../run/index.js";
import { LocalStateStore } from "../run/index.js";
import { ConfigError, StateError, UserInputError, deprecationWarn } from "../utils/index.js";

export interface ApproveActionOpts {
  zigmaflowDir: string;
  jobId: string;
  stepId?: string;
  comment?: string;
  outputs?: Record<string, string>;
  clock: Clock;
}

export async function approveAction(opts: ApproveActionOpts): Promise<void> {
  deprecationWarn(
    "approve command is deprecated",
    "'zigma-flow resume --input decision=approve' instead",
  );

  const { zigmaflowDir, jobId, stepId, comment, outputs, clock } = opts;

  const activeRunId = await readActiveRun(zigmaflowDir);
  if (activeRunId === null) {
    throw new ConfigError(
      "No active run found. Run `zigma-flow run` first.",
      {
        details: { zigmaflowDir },
        suggestion: "Run 'zigma-flow list-runs' to see available runs, or 'zigma-flow run <workflow> --task <task>' to create a new one.",
      }
    );
  }

  const runsDir = join(zigmaflowDir, ".zigma-flow", "runs");
  const runDir = join(runsDir, activeRunId);

  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json not found for run ${activeRunId}`, {
      suggestion: "Run 'zigma-flow verify-run' to check whether the run directory is intact, or 'zigma-flow list-runs' to pick a different run.",
    });
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new UserInputError(
      `Job "${jobId}" not found in run ${activeRunId}`,
      {
        details: { jobId, runId: activeRunId },
        suggestion: "Run 'zigma-flow status' to see the current jobs in this run.",
      }
    );
  }

  // Auto-detect step if not provided
  let resolvedStepId = stepId;
  if (resolvedStepId === undefined) {
    if (jobState.step_status === "awaiting_human" || jobState.step_status === "awaiting_input") {
      resolvedStepId = jobState.current_step;
    } else {
      // Check all jobs for awaiting steps (supporting both old and new status names)
      const awaitingEntries = Object.entries(state.jobs)
        .filter(([, js]) => js.step_status === "awaiting_human" || js.step_status === "awaiting_input");

      if (awaitingEntries.length === 0) {
        throw new UserInputError(
          "No step is currently awaiting human input. Use `zigma-flow status` to check.",
          {
            details: { runId: activeRunId },
            suggestion: "Run 'zigma-flow status --verbose' to see per-step status for each job.",
          }
        );
      }

      if (awaitingEntries.length > 1) {
        throw new UserInputError(
          "Multiple steps are awaiting human input. Use --step to specify which one.",
          {
            details: { awaitingSteps: awaitingEntries.map(([jid, js]) => `${jid}/${js.current_step}`) },
            suggestion: "Re-run with '--job <job> --step <step>' naming one of the awaiting entries above.",
          }
        );
      }

      resolvedStepId = awaitingEntries[0]![1].current_step;
    }
  }

  if (resolvedStepId === undefined) {
    throw new UserInputError(
      "Could not determine which step to approve. Use --step <id>.",
      {
        details: { jobId },
        suggestion: "Run 'zigma-flow status --verbose' to list the steps of this job and pick the awaiting one.",
      }
    );
  }

  // Validate step is awaiting human input (support both old and new status names)
  if (jobState.step_status !== "awaiting_human" && jobState.step_status !== "awaiting_input") {
    throw new StateError(
      `Step "${resolvedStepId}" in job "${jobId}" is not awaiting human input.`,
      {
        details: { jobId, stepId: resolvedStepId, stepStatus: jobState.step_status },
        suggestion: "Run 'zigma-flow status --verbose' to see which step is currently awaiting a decision.",
      }
    );
  }

  // AD-P15-002: `approvers` on the step is informational only in MVP.
  // We do not verify that `decidedBy` (from process env) appears in that list —
  // authorization is delegated to filesystem/OS permissions on the run
  // directory. Identity enforcement is Host responsibility in v0.6+.
  const decidedBy = process.env["USER"] ?? process.env["USERNAME"] ?? undefined;

  const result = await recordHumanDecision({
    runDir,
    runId: activeRunId,
    jobId,
    stepId: resolvedStepId,
    decision: "approved",
    source: "cli",
    ...(comment !== undefined ? { comment } : {}),
    ...(outputs !== undefined ? { outputs } : {}),
    ...(decidedBy !== undefined ? { decidedBy } : {}),
    clock,
    stateStore,
  });

  if (result.status === "duplicate") {
    console.log(`[IDEMPOTENT] Step "${resolvedStepId}" in job "${jobId}" has already been approved. No changes made.`);
  } else {
    console.log(`Approved step "${resolvedStepId}" in job "${jobId}" of run ${activeRunId}.`);
    console.log("Run `zigma-flow run-all <workflow> --resume` to continue.");
  }
}
