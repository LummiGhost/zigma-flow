/**
 * Engine — orchestrates run creation and step execution.
 *
 * Reference: docs/mvp-contracts.md §2.3, §2.4 (RC-R01..R12)
 * WF-P3-RUN Step 2 / WF-P6-DISPATCH Step 2.
 */

import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { computeReadyJobs } from "../dag/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { Clock, RunState } from "../run/index.js";
import { ConfigError, StateError, WorkflowError } from "../utils/index.js";
import type { ProcessRunner } from "../script/index.js";
import { ExecaProcessRunner } from "../script/index.js";
import { executeScriptStep } from "../script/executor.js";
import type { CheckRunner } from "../check/index.js";
import { LocalCheckRunner } from "../check/index.js";
import { executeCheckStep } from "../check/executor.js";
import {
  JsonlEventWriter,
  LocalRunIdGenerator,
  LocalStateStore,
  SystemClock,
  createRunDirectory,
  snapshotSkillLock,
  writeActiveRun,
  writeRunYaml,
} from "../run/index.js";
import { nextEventId as formatEventId } from "../events/index.js";

export interface CreateRunInputs {
  workflowPath: string;
  task: string;
  runsDir: string;
  skillLockPath: string;
  clock?: Clock; // injectable for tests; defaults to SystemClock
}

export interface CreateRunResult {
  runId: string;
}

export async function createRun(inputs: CreateRunInputs): Promise<CreateRunResult> {
  const clock: Clock = inputs.clock ?? new SystemClock();
  const idGenerator = new LocalRunIdGenerator(clock);
  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // RC-R01: Generate runId
  const runId = await idGenerator.nextRunId(inputs.runsDir);

  // RC-R02: Create run directory
  const runDir = await createRunDirectory(runId, inputs.runsDir);

  // Load workflow (prerequisite for RC-R03..R06)
  const wf = await loadWorkflowFile(inputs.workflowPath);

  // RC-R12: Snapshot skill-lock into run directory
  await snapshotSkillLock(runDir, inputs.skillLockPath);

  // RC-R03: Write run.yml
  const createdAt = clock.now();
  await writeRunYaml(runDir, {
    task: inputs.task,
    workflow: {
      name: wf.name,
      path: inputs.workflowPath,
    },
    created_at: createdAt,
    skill_lock_snapshot: "skill-lock.snapshot.json",
  });

  // RC-R04/R05/R06: Compute initial job states (ready / waiting / inactive)
  const readySet = new Set(computeReadyJobs(wf.jobs, new Set(), new Set()));

  const jobs: Record<string, import("../run/index.js").JobState> = {};
  for (const [jobId, jobDef] of Object.entries(wf.jobs)) {
    if (jobDef.activation !== undefined) {
      // activation: optional (or any activation value) → inactive
      const js: import("../run/index.js").JobState = { status: "inactive" };
      js.activation = jobDef.activation;
      jobs[jobId] = js;
    } else if (readySet.has(jobId)) {
      jobs[jobId] = { status: "ready" };
    } else {
      jobs[jobId] = { status: "waiting" };
    }
  }

  // RC-R09/R10: Event counter — sequential evt-NNN ids
  let eventCounter = 1;
  function nextEventId(): string {
    return formatEventId(eventCounter++);
  }

  // RC-R09: Append run_created event (evt-001)
  await eventWriter.appendEvent(runDir, {
    id: nextEventId(),
    type: "run_created",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
    payload: { workflow: wf.name, task: inputs.task },
  });

  // RC-R10: Append one job_ready event per initial ready job
  // Use Object.keys(wf.jobs) order filtered to those in the ready set
  for (const jobId of Object.keys(wf.jobs)) {
    if (readySet.has(jobId)) {
      await eventWriter.appendEvent(runDir, {
        id: nextEventId(),
        type: "job_ready",
        run_id: runId,
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: { job_id: jobId },
      });
    }
  }

  // RC-R08/R11: Read confirmed tail event id — MUST be non-null after appending run_created
  const lastEventId = await eventWriter.readLastEventId(runDir);
  if (lastEventId === null) {
    throw new WorkflowError("events.jsonl is empty after appending run_created — write failure", {
      details: { runDir },
    });
  }

  // RC-R11: Build RunState with the confirmed last event id, then atomic write
  const state: RunState = {
    run_id: runId,
    workflow: wf.name,
    task: inputs.task,
    created_at: createdAt,
    last_event_id: lastEventId,
    jobs,
  };

  // RC-R07/R11: Atomically write state.json via StateStore (Engine is sole writer)
  await stateStore.writeSnapshot(runDir, state);

  // WF-P5-PROMPT: Write active_run pointer to config.json.
  // runsDir = <project>/.zigma-flow/runs → zigmaflowDir = <project>
  const zigmaflowDir = dirname(dirname(inputs.runsDir));
  try {
    await writeActiveRun(zigmaflowDir, runId);
  } catch (e: unknown) {
    // Suppress ConfigError (config.json not yet created — first run / test setups).
    // Re-throw all other errors (permission denied, disk full, etc.).
    if (!(e instanceof ConfigError)) throw e;
  }

  return { runId };
}

// ---------------------------------------------------------------------------
// executeCurrentStep — script step execution (implemented in WF-P6-SCRIPT)
// ---------------------------------------------------------------------------

export interface ExecuteCurrentStepOpts {
  runDir: string;
  zigmaflowDir: string;
  runId: string;
  jobId: string;
  runner?: ProcessRunner | CheckRunner;
  clock: Clock;
}

export async function executeCurrentStep(opts: ExecuteCurrentStepOpts): Promise<void> {
  const { runDir, zigmaflowDir, runId, jobId, clock } = opts;

  // Read current state to validate job exists
  const stateStore = new LocalStateStore();
  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  // Load workflow to validate step type (P6: only script steps)
  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  const jobDef = wf.jobs[jobId];
  if (jobDef === undefined) {
    throw new WorkflowError(`Job "${jobId}" not found in workflow definition`);
  }

  const stepId = jobState.current_step ?? jobDef.steps[0]?.id;
  if (stepId === undefined) {
    throw new WorkflowError(`Job "${jobId}" has no steps defined`);
  }

  const stepDef = jobDef.steps.find((s) => s.id === stepId);
  if (stepDef === undefined) {
    throw new WorkflowError(`Step "${stepId}" not found in job "${jobId}"`);
  }

  if (stepDef.type === "script") {
    const actualRunner = (opts.runner as ProcessRunner | undefined) ?? new ExecaProcessRunner();
    await executeScriptStep({
      runDir,
      zigmaflowDir,
      runId,
      jobId,
      clock,
      runner: actualRunner,
    });
  } else if (stepDef.type === "check") {
    const actualRunner = (opts.runner as CheckRunner | undefined) ?? new LocalCheckRunner();
    await executeCheckStep({
      runDir,
      zigmaflowDir,
      runId,
      jobId,
      clock,
      runner: actualRunner,
    });
  } else {
    throw new WorkflowError(
      `Step "${stepId}" in job "${jobId}" is type "${stepDef.type}", not a script or check step (P7 scope)`,
      { details: { jobId, stepId, stepType: stepDef.type } }
    );
  }
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
