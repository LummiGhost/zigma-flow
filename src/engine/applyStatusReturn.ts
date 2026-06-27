/**
 * applyStatusReturn — Engine entry point for Step Structured Return Status.
 *
 * Translates an Agent report's `status` field into a routing action via
 * the step's declared `returns` and `on_return` mappings.
 *
 * Pipeline position (AD-P13-013): called from acceptAgentReport after outputs
 * are persisted and context_patches are applied, but before signal handling.
 * Status action takes priority over signals.
 *
 * Reference:
 *   docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-returns/
 *   docs/mvp-contracts.md §2.3, §2.4
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { loadWorkflowFile } from "../workflow/index.js";
import type { Clock, RunState } from "../run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import { StateError, ValidationError } from "../utils/index.js";
import { applyRoutingAction, actionDiscriminator } from "./routing.js";

// ---------------------------------------------------------------------------
// ApplyStatusReturnOpts
// ---------------------------------------------------------------------------

export interface ApplyStatusReturnOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Job identifier whose agent step produced the status. */
  sourceJobId: string;
  /** Step identifier that produced the status. */
  sourceStepId: string;
  /** Current attempt number (1-based). */
  attempt: number;
  /** The status value returned by the Agent. */
  status: string;
  /** Clock for event timestamps. */
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Internal helper: parse run.yml to get the workflow file path
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
// applyStatusReturn
// ---------------------------------------------------------------------------

export async function applyStatusReturn(opts: ApplyStatusReturnOpts): Promise<void> {
  const { runDir, runId, sourceJobId, sourceStepId, attempt, status, clock } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read state snapshot — throw StateError if missing ─────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  // ── 2. Load workflow to resolve step definition ──────────────────────────

  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  const jobDef = wf.jobs[sourceJobId];
  if (jobDef === undefined) {
    throw new StateError(`Job "${sourceJobId}" not found in workflow for run ${runId}`);
  }

  const stepDef = jobDef.steps.find((s) => s.id === sourceStepId);
  if (stepDef === undefined) {
    throw new StateError(`Step "${sourceStepId}" not found in job "${sourceJobId}" for run ${runId}`);
  }

  // ── 3. Validate stepDef has returns.status declared ──────────────────────

  if (!stepDef.returns?.status) {
    throw new ValidationError(
      `Step "${sourceStepId}" does not declare returns.status`,
      { details: { jobId: sourceJobId, stepId: sourceStepId } }
    );
  }

  // ── 4. If required and status is missing (empty), throw ──────────────────

  if (stepDef.returns.status.required === true && (!status || status.length === 0)) {
    throw new ValidationError(
      `Step "${sourceStepId}" requires a return status but none was provided`,
      { details: { jobId: sourceJobId, stepId: sourceStepId, required: true } }
    );
  }

  // ── 5. Validate status is in returns.status.values ───────────────────────

  if (!stepDef.returns.status.values.includes(status)) {
    throw new ValidationError(
      `Status "${status}" is not in returns.status.values for step "${sourceStepId}"`,
      { details: { jobId: sourceJobId, stepId: sourceStepId, status, values: stepDef.returns.status.values } }
    );
  }

  // ── 6. Look up on_return mapping for the status ──────────────────────────

  const action = stepDef.on_return?.[status];
  if (action === undefined) {
    throw new ValidationError(
      `No on_return mapping found for status "${status}" on step "${sourceStepId}"`,
      { details: { jobId: sourceJobId, stepId: sourceStepId, status } }
    );
  }

  // ── 7. Determine action discriminator string ─────────────────────────────

  const mappedActionStr = actionDiscriminator(action);

  // ── 8. Append step_returned event (event-first pattern) ──────────────────

  const eventWriterForSeq = eventWriter;
  const { nextSequentialEventId } = await import("../events/index.js");
  const stepReturnedId = await nextSequentialEventId(runDir, eventWriterForSeq);

  await eventWriter.appendEvent(runDir, {
    id: stepReturnedId,
    run_id: runId,
    type: "step_returned",
    timestamp: clock.now(),
    producer: "engine",
    job: sourceJobId,
    step: sourceStepId,
    attempt,
    payload: {
      job_id: sourceJobId,
      step_id: sourceStepId,
      status,
      mapped_action: mappedActionStr,
    },
  });

  // ── 9. Dispatch the mapped action via applyRoutingAction ──────────────────

  const reason = `Agent returned status "${status}" from job "${sourceJobId}"`;
  await applyRoutingAction({
    runDir,
    runId,
    sourceJobId,
    sourceStepId,
    attempt,
    action,
    reason,
    clock,
  });
}
