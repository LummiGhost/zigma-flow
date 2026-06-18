/**
 * `zigma-flow step --job` command handler.
 *
 * Pipeline:
 *   1. Read active_run from .zigma-flow/config.json → ConfigError if absent.
 *   2. Read state.json from the run directory → StateError if missing.
 *   3. Read run.yml to get the workflow file path.
 *   4. Load workflow definition.
 *   5. Select job:
 *      - If --job is provided, validate it exists in the workflow → UserInputError if not.
 *      - Otherwise auto-detect: exactly one ready job → UserInputError if zero or >1.
 *   6. Assert the job is in "ready" status → StateError if not.
 *   7. Assert the current step is a "script" step → WorkflowError if not (P6 scope).
 *   8. Call executeCurrentStep(opts).
 *   9. Print path to the result file.
 *
 * Reference: docs/phases/p6-script-step/workflows/wf-p6-dispatch/
 * WF-P6-DISPATCH Step 2.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { executeCurrentStep } from "../engine/index.js";
import type { ProcessRunner } from "../script/index.js";
import {
  LocalStateStore,
  readActiveRun,
  type Clock,
} from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import {
  ConfigError,
  StateError,
  UserInputError,
  WorkflowError,
} from "../utils/index.js";
import { artifactStepDir } from "../artifact/index.js";

// ---------------------------------------------------------------------------
// stepAction options
// ---------------------------------------------------------------------------

export interface StepActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Optional job id override. If omitted, auto-detects the single ready job. */
  job?: string;
  /** Clock for timestamping events. */
  clock: Clock;
  /** Injectable ProcessRunner for tests; production code passes undefined. */
  runner?: ProcessRunner;
}

// ---------------------------------------------------------------------------
// Internal: parse run.yml to get the workflow file path
// ---------------------------------------------------------------------------

interface RunYmlShape {
  workflow?: { path?: string };
}

async function readWorkflowPathFromRunYml(runDir: string): Promise<string> {
  const runYmlPath = join(runDir, "run.yml");
  let raw: string;
  try {
    raw = await readFile(runYmlPath, "utf-8");
  } catch (e: unknown) {
    throw new StateError(`Cannot read run.yml in: ${runDir}`, { cause: e });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e: unknown) {
    throw new StateError(`run.yml contains invalid YAML in: ${runDir}`, { cause: e });
  }

  const shape = parsed as RunYmlShape;
  const wfPath = shape?.workflow?.path;
  if (typeof wfPath !== "string" || wfPath.length === 0) {
    throw new StateError(`run.yml is missing workflow.path in: ${runDir}`);
  }
  return wfPath;
}

// ---------------------------------------------------------------------------
// stepAction
// ---------------------------------------------------------------------------

export async function stepAction(opts: StepActionOpts): Promise<void> {
  const { zigmaflowDir, clock } = opts;
  const stateStore = new LocalStateStore();

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

  // 2. Read state.json
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(
      `state.json not found for active run "${activeRunId}" in: ${runDir}`,
      { details: { runId: activeRunId, runDir } }
    );
  }

  // 3. Read workflow path from run.yml
  const workflowPath = await readWorkflowPathFromRunYml(runDir);

  // 4. Load workflow definition
  const workflowDef = await loadWorkflowFile(workflowPath);

  // 5. Select job
  let jobId: string;
  if (opts.job !== undefined) {
    // Validate the supplied job id exists in the workflow
    if (!(opts.job in workflowDef.jobs)) {
      throw new UserInputError(
        `Job "${opts.job}" does not exist in workflow "${workflowDef.name}". ` +
        `Available jobs: ${Object.keys(workflowDef.jobs).join(", ")}`,
        { details: { job: opts.job, available: Object.keys(workflowDef.jobs) } }
      );
    }
    // Guard for job existing in run state as well as workflow definition
    if (!(opts.job in state.jobs)) {
      throw new StateError(
        `Job "${opts.job}" exists in workflow but not in run state`,
        { details: { job: opts.job, runId: activeRunId } }
      );
    }
    jobId = opts.job;
  } else {
    // Auto-detect: find ready jobs
    const readyJobs = Object.entries(state.jobs)
      .filter(([, js]) => js.status === "ready")
      .map(([id]) => id);

    if (readyJobs.length === 0) {
      throw new UserInputError(
        "No ready jobs found in the active run. Use --job to specify a job explicitly.",
        { details: { runId: activeRunId, jobStatuses: state.jobs } }
      );
    }
    if (readyJobs.length > 1) {
      throw new UserInputError(
        `Multiple ready jobs found: ${readyJobs.join(", ")}. Use --job to specify which one.`,
        { details: { readyJobs } }
      );
    }
    jobId = readyJobs[0]!;
  }

  // 6. Resolve current step (needed before the status check for multi-step jobs)
  const selectedJobState = state.jobs[jobId];
  const jobDef = workflowDef.jobs[jobId];
  const currentStepId = selectedJobState?.current_step ?? jobDef?.steps[0]?.id;
  const currentStep = jobDef?.steps.find((s) => s.id === currentStepId);

  if (currentStep === undefined) {
    throw new WorkflowError(
      `Job "${jobId}" has no steps defined.`,
      { details: { jobId } }
    );
  }

  // 7. Assert current step is an executable type (script, check, or router)
  if (currentStep.type !== "script" && currentStep.type !== "check" && currentStep.type !== "router") {
    throw new WorkflowError(
      `Job "${jobId}" current step "${currentStep.id}" is a "${currentStep.type}" step. ` +
      `Only script, check, and router steps can be executed via the step command.`,
      { details: { jobId, stepId: currentStep.id, stepType: currentStep.type } }
    );
  }

  // 8. Assert job is in a state that permits step execution:
  //    "ready" for the first step; "running" for subsequent steps in a multi-step job.
  const status = selectedJobState?.status;
  if (status !== "ready" && status !== "running") {
    throw new StateError(
      `Job "${jobId}" is in status "${status ?? "unknown"}". ` +
      `The step command requires "ready" or "running" (multi-step job).`,
      { details: { jobId, status } }
    );
  }

  // 9. Call executeCurrentStep (Engine owns state transitions)
  const runnerOpt = opts.runner !== undefined ? { runner: opts.runner } : {};
  await executeCurrentStep({
    runDir,
    zigmaflowDir,
    runId: activeRunId,
    jobId,
    clock,
    ...runnerOpt,
  });

  // 9. Print result path
  const attempt = selectedJobState!.attempt ?? 1;
  const resultPath = join(artifactStepDir(runDir, jobId, attempt, currentStep.id), "result.json");
  console.log(`Step completed: ${resultPath}`);
}
