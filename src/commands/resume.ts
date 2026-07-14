/**
 * `zigma-flow resume` command handler (v0.6, Issue #210).
 *
 * Unified entry point for submitting human input to a paused run.
 * Replaces the legacy `approve` and `reject` commands.
 *
 * Usage: zigma-flow resume <run-id> --job <job-id> --step <step-id> --input key=value
 */

import { join } from "node:path";

import { resumeWithInput } from "../engine/humanGate.js";
import type { HumanInputSchema } from "../engine/humanGate.js";
import { readActiveRun, resolveRunId } from "../run/index.js";
import type { Clock } from "../run/index.js";
import { LocalStateStore } from "../run/index.js";
import { ConfigError, StateError, UserInputError } from "../utils/index.js";
import { loadWorkflowFile } from "../workflow/index.js";

export interface ResumeActionOpts {
  zigmaflowDir: string;
  /** Explicit run ID (when provided, takes priority over active run). */
  runId?: string;
  jobId: string;
  stepId?: string;
  /** Structured input key-value pairs. */
  input: Record<string, string>;
  clock: Clock;
}

export async function resumeAction(opts: ResumeActionOpts): Promise<void> {
  const { zigmaflowDir, runId: explicitRunId, jobId, stepId, input, clock } = opts;

  // Resolve run ID
  const activeRunId = explicitRunId ?? await readActiveRun(zigmaflowDir);
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
      // Check all jobs for awaiting steps
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
      "Could not determine which step to resume. Use --step <id>.",
      {
        details: { jobId },
        suggestion: "Run 'zigma-flow status --verbose' to list the steps of this job and pick the awaiting one.",
      }
    );
  }

  // Validate step is awaiting input
  if (jobState.step_status !== "awaiting_human" && jobState.step_status !== "awaiting_input") {
    throw new StateError(
      `Step "${resolvedStepId}" in job "${jobId}" is not awaiting human input.`,
      {
        details: { jobId, stepId: resolvedStepId, stepStatus: jobState.step_status },
        suggestion: "Run 'zigma-flow status --verbose' to see which step is currently awaiting a decision.",
      }
    );
  }

  // Load workflow to get step definition (for input schema validation)
  let stepDef: { inputs?: Record<string, HumanInputSchema>; prompt?: string } | undefined;
  try {
    const { readFile } = await import("node:fs/promises");
    const { parse } = await import("yaml");
    const runYmlPath = join(runDir, "run.yml");
    const runYmlRaw = await readFile(runYmlPath, "utf-8");
    const runYml = parse(runYmlRaw) as { workflow?: { path?: string } };
    const wfPath = runYml?.workflow?.path;
    if (wfPath !== undefined) {
      const wf = await loadWorkflowFile(wfPath);
      const jobDef = wf.jobs[jobId];
      if (jobDef !== undefined) {
        const sDef = jobDef.steps.find(s => s.id === resolvedStepId);
        if (sDef !== undefined) {
          const inputs = sDef.inputs as Record<string, HumanInputSchema> | undefined;
          stepDef = {};
          if (inputs !== undefined) {
            stepDef.inputs = inputs;
          }
          if (sDef.prompt !== undefined) {
            stepDef.prompt = sDef.prompt;
          }
        }
      }
    }
  } catch {
    // If we can't load the workflow, continue without input schema validation.
    // The engine's enterHumanGate already has the step prompt stored in the
    // human_gate_waiting event, so this is a best-effort enhancement.
  }

  // Resolve actor from environment (same pattern as approve/reject)
  const userId = process.env["USER"] ?? process.env["USERNAME"] ?? undefined;

  const result = await resumeWithInput({
    runDir,
    runId: activeRunId,
    jobId,
    stepId: resolvedStepId,
    input,
    ...(userId !== undefined ? { actor: { id: userId, type: "user" as const } } : {}),
    source: "cli",
    ...(stepDef !== undefined ? { stepDef } : {}),
    clock,
    stateStore,
  });

  if (result.status === "duplicate") {
    console.log(`[IDEMPOTENT] Step "${resolvedStepId}" in job "${jobId}" has already been decided as "${result.outcome}". No changes made.`);
  } else {
    console.log(`Resumed step "${resolvedStepId}" in job "${jobId}" of run ${activeRunId}.`);
    console.log(`Decision: ${result.outcome}`);
    console.log(`Next action: ${result.nextAction}`);
  }

  if (result.status === "recorded") {
    console.log("Run `zigma-flow run-all <workflow> --resume` to continue.");
  }
}
