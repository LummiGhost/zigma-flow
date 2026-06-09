/**
 * Script step execution orchestration — WF-P6-SCRIPT Step 2.
 *
 * `executeScriptStep` is the core pipeline that:
 *   1. Reads current state to locate the step to execute.
 *   2. Emits `step_started`; writes state snapshot (job ready → running).
 *   3. Resolves the command (inline `run` or Skill Pack `uses`).
 *   4. Parses timeout string and invokes the ProcessRunner.
 *   5. Writes stdout/stderr artifacts and result.json.
 *   6. Emits `script_completed`.
 *   7. On success: emits `step_completed` + `job_completed`; job → completed.
 *      On failure: emits `step_failed`; job → failed.
 *   8. Writes the final state snapshot (once, after all events).
 *
 * Reference:
 *   - docs/phases/p6-script-step/02-development-plan.md §4 (WF-P6-SCRIPT), §5.3–5.6, §6
 *   - docs/mvp-contracts.md §2.7, §6, §7
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";

import { nextEventId } from "../events/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import type { ProcessRunner } from "./index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import { WorkflowError, StateError, SkillPackError } from "../utils/index.js";
import { artifactStepDir, artifactId } from "../artifact/index.js";

// ---------------------------------------------------------------------------
// ExecuteScriptStepOpts
// ---------------------------------------------------------------------------

export interface ExecuteScriptStepOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Absolute path to the project root (parent of .zigma-flow/). */
  zigmaflowDir: string;
  /** Run identifier. */
  runId: string;
  /** Job identifier to execute the current step for. */
  jobId: string;
  /** Clock for timestamping events. */
  clock: Clock;
  /** Injectable ProcessRunner; defaults to ExecaProcessRunner in production. */
  runner: ProcessRunner;
}

// ---------------------------------------------------------------------------
// ScriptResult — snake_case JSON persisted to result.json
// ---------------------------------------------------------------------------

interface ScriptResult {
  exit_code: number;
  timed_out: boolean;
  stdout: string;       // artifact:// URI
  stderr: string;       // artifact:// URI
  started_at: string;
  ended_at: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a timeout string ("300s", "5m", "1h") → milliseconds.
 * Returns undefined if input is undefined.
 * Throws WorkflowError on unrecognised format.
 */
function parseTimeoutMs(timeout: string | undefined): number | undefined {
  if (timeout === undefined) return undefined;

  const match = /^(\d+)(s|m|h)$/.exec(timeout);
  if (match === null) {
    throw new WorkflowError(
      `Invalid timeout format "${timeout}": expected <number>(s|m|h), e.g. "300s", "5m", "1h"`,
      { details: { timeout } }
    );
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    default:  throw new WorkflowError(`Unrecognised timeout unit: "${unit}"`);
  }
}

/**
 * Parse run.yml to extract the workflow file path.
 */
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

/**
 * Read skill-lock.snapshot.json and look up a `uses` reference.
 * Returns the resolved command string.
 * Throws SkillPackError if not found.
 */
interface SkillLockSnapshot {
  skills?: Record<string, { scripts?: Record<string, { command?: string }> }>;
}

async function resolveSkillPackCommand(runDir: string, uses: string): Promise<string> {
  const snapshotPath = join(runDir, "skill-lock.snapshot.json");
  let raw: string;
  try {
    raw = await readFile(snapshotPath, "utf-8");
  } catch (e: unknown) {
    throw new SkillPackError(`Cannot read skill-lock.snapshot.json in: ${runDir}`, { cause: e });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    throw new SkillPackError(`skill-lock.snapshot.json contains invalid JSON in: ${runDir}`, { cause: e });
  }

  // uses format: "<skill-alias>/<script-name>"
  const slashIdx = uses.indexOf("/");
  if (slashIdx < 0) {
    throw new SkillPackError(
      `Invalid uses reference "${uses}": expected "<skill-alias>/<script-name>"`,
      { details: { uses } }
    );
  }
  const skillAlias = uses.slice(0, slashIdx);
  const scriptName = uses.slice(slashIdx + 1);

  const snapshot = parsed as SkillLockSnapshot;
  const skillEntry = snapshot?.skills?.[skillAlias];
  if (skillEntry === undefined) {
    throw new SkillPackError(
      `Skill alias "${skillAlias}" not found in skill-lock.snapshot.json`,
      { details: { uses, skillAlias } }
    );
  }

  const scriptEntry = skillEntry.scripts?.[scriptName];
  if (scriptEntry === undefined || typeof scriptEntry.command !== "string") {
    throw new SkillPackError(
      `Script "${scriptName}" not found in skill "${skillAlias}" in skill-lock.snapshot.json`,
      { details: { uses, skillAlias, scriptName } }
    );
  }

  return scriptEntry.command;
}

// ---------------------------------------------------------------------------
// executeScriptStep — main pipeline
// ---------------------------------------------------------------------------

export async function executeScriptStep(opts: ExecuteScriptStepOpts): Promise<void> {
  const { runDir, zigmaflowDir: _zigmaflowDir, runId, jobId, clock, runner } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read current state ────────────────────────────────────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  const attempt = jobState.attempt ?? 1;

  // ── 2. Load workflow to resolve step definition ──────────────────────────

  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  const jobDef = wf.jobs[jobId];
  if (jobDef === undefined) {
    throw new WorkflowError(`Job "${jobId}" not found in workflow definition`);
  }

  // current_step points to step to execute; absent means first step
  const stepId = jobState.current_step ?? jobDef.steps[0]?.id;
  if (stepId === undefined) {
    throw new WorkflowError(`Job "${jobId}" has no steps defined`);
  }

  const stepDef = jobDef.steps.find((s) => s.id === stepId);
  if (stepDef === undefined) {
    throw new WorkflowError(`Step "${stepId}" not found in job "${jobId}"`);
  }

  if (stepDef.type !== "script") {
    throw new WorkflowError(
      `Step "${stepId}" in job "${jobId}" is type "${stepDef.type}", not "script"`,
      { details: { jobId, stepId, stepType: stepDef.type } }
    );
  }

  // ── 3. Helper: get event counter and next event id ───────────────────────

  async function getNextEventId(): Promise<string> {
    const lastId = await eventWriter.readLastEventId(runDir);
    const counter = lastId !== null ? parseInt(lastId.replace("evt-", ""), 10) : 0;
    return nextEventId(counter + 1);
  }

  // ── 4. Emit step_started; write state snapshot (ready → running) ─────────

  const stepStartedId = await getNextEventId();
  await eventWriter.appendEvent(runDir, {
    id: stepStartedId,
    run_id: runId,
    type: "step_started",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt,
    payload: { job_id: jobId, step_id: stepId, attempt },
  });

  // Write intermediate snapshot: job ready → running
  const runningState: RunState = {
    ...state,
    last_event_id: stepStartedId,
    jobs: {
      ...state.jobs,
      [jobId]: {
        ...jobState,
        status: "running",
        current_step: stepId,
        attempt,
      },
    },
  };
  await stateStore.writeSnapshot(runDir, runningState);

  // ── 5. Resolve command ────────────────────────────────────────────────────

  let command: string;
  if (typeof stepDef.run === "string" && stepDef.run.length > 0) {
    command = stepDef.run;
  } else if (typeof stepDef.uses === "string" && stepDef.uses.length > 0) {
    command = await resolveSkillPackCommand(runDir, stepDef.uses);
  } else {
    throw new WorkflowError(
      `Step "${stepId}" in job "${jobId}" has neither "run" nor "uses" defined`,
      { details: { jobId, stepId } }
    );
  }

  // ── 6. Parse timeout and invoke ProcessRunner ─────────────────────────────

  const timeoutMs = parseTimeoutMs(stepDef.timeout);

  const runnerResult = await runner.run({
    command,
    ...(typeof stepDef.shell === "string" ? { shell: stepDef.shell } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof stepDef.cwd === "string" ? { cwd: stepDef.cwd } : {}),
    ...(stepDef.env !== undefined ? { env: stepDef.env } : {}),
  });

  // ── 7. Write stdout/stderr artifacts ─────────────────────────────────────

  const stepArtifactDir = artifactStepDir(runDir, jobId, attempt, stepId);
  await mkdir(stepArtifactDir, { recursive: true });

  await writeFile(join(stepArtifactDir, "stdout.txt"), runnerResult.stdout, "utf-8");
  await writeFile(join(stepArtifactDir, "stderr.txt"), runnerResult.stderr, "utf-8");

  const stdoutArtifactUri = artifactId(runId, jobId, attempt, stepId, "stdout.txt");
  const stderrArtifactUri = artifactId(runId, jobId, attempt, stepId, "stderr.txt");

  // ── 8. Build and write ScriptResult to result.json ───────────────────────

  const scriptResult: ScriptResult = {
    exit_code: runnerResult.exitCode,
    timed_out: runnerResult.timedOut,
    stdout: stdoutArtifactUri,
    stderr: stderrArtifactUri,
    started_at: runnerResult.startedAt,
    ended_at: runnerResult.endedAt,
  };

  await writeFile(
    join(stepArtifactDir, "result.json"),
    JSON.stringify(scriptResult, null, 2),
    "utf-8"
  );

  // ── 9. Emit script_completed ──────────────────────────────────────────────

  const scriptCompletedId = await getNextEventId();
  await eventWriter.appendEvent(runDir, {
    id: scriptCompletedId,
    run_id: runId,
    type: "script_completed",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt,
    payload: {
      job_id: jobId,
      step_id: stepId,
      exit_code: runnerResult.exitCode,
      timed_out: runnerResult.timedOut,
    },
  });

  // ── 10. Determine success/failure and emit terminal events ────────────────

  const isSuccess = runnerResult.exitCode === 0 && !runnerResult.timedOut;

  if (isSuccess) {
    // ── 10a. Success path ──────────────────────────────────────────────────

    const stepCompletedId = await getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: stepCompletedId,
      run_id: runId,
      type: "step_completed",
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: { job_id: jobId, step_id: stepId, attempt },
    });

    const jobCompletedId = await getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: jobCompletedId,
      run_id: runId,
      type: "job_completed",
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: null,
      attempt,
      payload: { job_id: jobId, attempt },
    });

    // Write final state snapshot: job running → completed
    const completedState: RunState = {
      ...runningState,
      last_event_id: jobCompletedId,
      jobs: {
        ...runningState.jobs,
        [jobId]: {
          ...runningState.jobs[jobId]!,
          status: "completed",
        },
      },
    };
    await stateStore.writeSnapshot(runDir, completedState);
  } else {
    // ── 10b. Failure path ──────────────────────────────────────────────────

    const reason = runnerResult.timedOut
      ? timeoutMs !== undefined
        ? `timeout after ${timeoutMs}ms`
        : "timeout"
      : `exit code ${runnerResult.exitCode}`;

    const stepFailedId = await getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: stepFailedId,
      run_id: runId,
      type: "step_failed",
      timestamp: clock.now(),
      producer: "engine",
      job: jobId,
      step: stepId,
      attempt,
      payload: { job_id: jobId, step_id: stepId, attempt, reason },
    });

    // Apply on_failure override (MVP: only status: "failed" | "blocked"; default is "failed")
    // TD-P6-002: retry_job, activate_job, goto_job not implemented.
    let finalJobStatus: "failed" = "failed";
    const onFailure = stepDef.on_failure;
    if (
      onFailure !== undefined &&
      typeof onFailure === "object" &&
      "status" in onFailure
    ) {
      // { status: "failed" | "blocked" } — for now only "failed" is the outcome
      // "blocked" would transition to blocked; TD-P6-002 tracks full implementation
      finalJobStatus = "failed";
    }

    // Write final state snapshot: job running → failed
    const failedState: RunState = {
      ...runningState,
      last_event_id: stepFailedId,
      jobs: {
        ...runningState.jobs,
        [jobId]: {
          ...runningState.jobs[jobId]!,
          status: finalJobStatus,
        },
      },
    };
    await stateStore.writeSnapshot(runDir, failedState);
  }
}
