/**
 * `zigma-flow prompt --job` command handler.
 *
 * Pipeline:
 *   1. Read active_run from .zigma-flow/config.json → ConfigError if absent.
 *   2. Read state.json from the run directory → StateError if missing.
 *   3. Read run.yml to get the workflow file path.
 *   4. Load workflow definition.
 *   5. Select job:
 *      - If --job is provided, validate it exists in the workflow → UserInputError if not.
 *      - Otherwise auto-detect: exactly one ready job → UserInputError if zero or >1.
 *   6. Assert the current step of that job is an agent step → WorkflowError if not.
 *   7. buildContext → buildAgentPrompt → writePromptArtifact.
 *   8. Append prompt_generated event (evt-NNN) to events.jsonl.
 *   9. Transition job status from "ready" to "running" in state.json.
 *  10. Print path to current-step.md.
 *
 * Reference: docs/phases/p5-context-prompt/workflows/wf-p5-prompt/
 * WF-P5-PROMPT Step 2.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { buildContext } from "../context/index.js";
import { buildAgentPrompt, writePromptArtifact } from "../prompt/index.js";
import {
  JsonlEventWriter,
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
import { nextEventId } from "../events/index.js";

// ---------------------------------------------------------------------------
// promptAction options
// ---------------------------------------------------------------------------

export interface PromptActionOpts {
  /** Project root directory (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Optional job id override. If omitted, auto-detects the single ready job. */
  job?: string;
  /** Clock for timestamping events. */
  clock: Clock;
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
// promptAction
// ---------------------------------------------------------------------------

export async function promptAction(opts: PromptActionOpts): Promise<void> {
  const { zigmaflowDir, clock } = opts;
  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

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
    // Fix P1-2: guard for job existing in run state as well as workflow definition
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

  // 6. Build context (this also validates the job exists in workflowDef and picks the step)
  const bundle = await buildContext({
    runDir,
    zigmaflowDir,
    workflowDef,
    state,
    jobId,
  });

  // Assert current step is an agent step
  if (bundle.stepType !== "agent") {
    throw new WorkflowError(
      `Job "${jobId}" current step "${bundle.stepId}" is a "${bundle.stepType}" step, not an agent step. ` +
      `Prompt generation is only available for agent steps.`,
      { details: { jobId, stepId: bundle.stepId, stepType: bundle.stepType } }
    );
  }

  // Fix P2-1: read attempt from job state rather than hard-coding 1
  const attempt = state.jobs[jobId]?.attempt ?? 1;

  // 7. Build and write prompt (must happen before state mutation)
  const promptText = buildAgentPrompt(bundle);
  const { artifactRef } = await writePromptArtifact({
    runDir,
    runId: activeRunId,
    jobId,
    stepId: bundle.stepId,
    attempt,
    prompt: promptText,
    clock,
  });

  // 8. Append prompt_generated event
  // Fix P1-1: read authoritative tail from events.jsonl rather than state.last_event_id
  const currentTail = await eventWriter.readLastEventId(runDir);
  if (currentTail === null) {
    throw new StateError(
      `events.jsonl is missing or empty for run "${activeRunId}" — cannot derive event counter`,
      { details: { runDir } }
    );
  }
  const lastNum = parseInt(currentTail.replace("evt-", ""), 10);
  if (isNaN(lastNum)) {
    throw new StateError(
      `Cannot derive event counter from last event id: ${currentTail}`,
      { details: { runDir, currentTail } }
    );
  }
  const newEventId = nextEventId(lastNum + 1);

  await eventWriter.appendEvent(runDir, {
    id: newEventId,
    type: "prompt_generated",
    run_id: activeRunId,
    timestamp: clock.now(),
    producer: "prompt-command",
    job: jobId,
    step: bundle.stepId,
    attempt,
    payload: {
      job_id: jobId,
      step_id: bundle.stepId,
      prompt_artifact: artifactRef,
    },
  });

  // 9. Transition job status from "ready" to "running" and advance last_event_id
  const updatedState = {
    ...state,
    last_event_id: newEventId,
    jobs: {
      ...state.jobs,
      [jobId]: {
        ...state.jobs[jobId],
        status: "running" as const,
        attempt,
      },
    },
  };

  await stateStore.writeSnapshot(runDir, updatedState);

  // 10. Print output path
  const mirrorPath = join(runDir, "current-step.md");
  console.log(`Prompt written to: ${mirrorPath}`);
}
