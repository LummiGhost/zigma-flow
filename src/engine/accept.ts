/**
 * acceptAgentReport — Engine entry point for the Agent Report acceptance loop.
 *
 * Called when the user runs `zigma-flow next --job <id>` after an Agent has
 * written `report.json` to the canonical artifact location:
 *   `<runDir>/jobs/<jobId>/attempts/<attempt>/steps/<stepId>/report.json`
 *
 * Contract (§2.6 Agent Report schema, WF-P9-ACCEPT):
 *   1. Read state snapshot; locate current_step and attempt.
 *   2. Read and parse report.json — FilesystemError if missing, ValidationError
 *      if malformed JSON or missing required fields.
 *   3. Store report.outputs into state.jobs[jobId].outputs.
 *   4. If signals array is non-empty:
 *      a. Validate each signal type is declared in wf.signals (ValidationError
 *         for undeclared, WorkflowError for disallowed source).
 *      b. Select the highest-priority valid signal (priority descending, default 0).
 *      c. Dispatch via applyRoutingAction — NO agent_report_accepted emitted.
 *   5. If signals array is empty: emit agent_report_accepted, write intermediate
 *      snapshot, delegate to advanceJob.
 *
 * Reference:
 *   - docs/phases/p9-agent-report-retry/workflows/wf-p9-accept/
 *   - docs/mvp-contracts.md §2.3, §2.4, §2.6
 */

import { join, relative } from "node:path";
import { readFile, stat } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { artifactStepDir } from "../artifact/artifactPaths.js";
import { appendArtifactIndex, artifactId, artifactFileRelativePath } from "../artifact/index.js";
import { nextEventId as formatEventId } from "../events/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import { FilesystemError, StateError, ValidationError, WorkflowError } from "../utils/index.js";
import { applyRoutingAction } from "./routing.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AcceptAgentReportOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Job identifier whose current agent step has produced a report. */
  jobId: string;
  /** Clock for timestamping the agent_report_accepted event. */
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
// Internal: minimum report shape (§2.6)
// ---------------------------------------------------------------------------

interface AgentReport {
  outputs: Record<string, unknown>;
  artifacts: unknown[];
  signals: Array<{ type: string; reason?: string }>;
  summary: string;
}

function validateReportShape(parsed: unknown): AgentReport {
  if (typeof parsed !== "object" || parsed === null) {
    throw new ValidationError("report.json must be a JSON object", {
      details: { actual: typeof parsed },
    });
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["outputs"] !== "object" || obj["outputs"] === null || Array.isArray(obj["outputs"])) {
    throw new ValidationError('report.json is missing required field "outputs" (must be an object)', {
      details: { field: "outputs" },
    });
  }

  if (!Array.isArray(obj["artifacts"])) {
    throw new ValidationError('report.json is missing required field "artifacts" (must be an array)', {
      details: { field: "artifacts" },
    });
  }

  if (!Array.isArray(obj["signals"])) {
    throw new ValidationError('report.json is missing required field "signals" (must be an array)', {
      details: { field: "signals" },
    });
  }

  if (typeof obj["summary"] !== "string") {
    throw new ValidationError('report.json is missing required field "summary" (must be a string)', {
      details: { field: "summary" },
    });
  }

  const signals: Array<{ type: string; reason?: string }> = (
    obj["signals"] as Array<Record<string, unknown>>
  ).map((s) => {
    if (typeof s["type"] !== "string" || s["type"].length === 0) {
      throw new ValidationError(
        `Invalid signal entry: "type" field must be a non-empty string`,
        { details: { signal: s } }
      );
    }
    const entry: { type: string; reason?: string } = { type: s["type"] };
    if (s["reason"] !== undefined) {
      entry.reason = String(s["reason"]);
    }
    return entry;
  });

  return {
    outputs: obj["outputs"] as Record<string, unknown>,
    artifacts: obj["artifacts"] as unknown[],
    signals,
    summary: obj["summary"],
  };
}

// ---------------------------------------------------------------------------
// acceptAgentReport
// ---------------------------------------------------------------------------

export async function acceptAgentReport(opts: AcceptAgentReportOpts): Promise<void> {
  const { runDir, runId, jobId, clock } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read state snapshot ─────────────────────────────────────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  const stepId = jobState.current_step;
  if (stepId === undefined) {
    throw new StateError(
      `Job "${jobId}" has no current_step in state for run ${runId} — cannot locate report.json`
    );
  }

  const attempt = jobState.attempt ?? 1;

  // ── 2. Locate and read report.json ─────────────────────────────────────────

  const stepDir = artifactStepDir(runDir, jobId, attempt, stepId);
  const reportPath = join(stepDir, "report.json");

  let reportText: string;
  try {
    reportText = await readFile(reportPath, "utf-8");
  } catch (e: unknown) {
    const isEnoent =
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as Record<string, unknown>)["code"] === "ENOENT";
    if (isEnoent) {
      throw new FilesystemError(`report.json not found at: ${reportPath}`, { cause: e });
    }
    throw new FilesystemError(`Cannot read report.json at: ${reportPath}`, { cause: e });
  }

  let reportParsed: unknown;
  try {
    reportParsed = JSON.parse(reportText);
  } catch (e: unknown) {
    throw new ValidationError(`report.json contains malformed JSON at: ${reportPath}`, { cause: e });
  }

  // ── 3. Validate report schema (§2.6) ──────────────────────────────────────

  const report = validateReportShape(reportParsed);

  // ── 4. Validate signals against workflow declarations (before any disk writes) ─

  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  // ── 4b. Normalize array-typed outputs ────────────────────────────────────
  // If the step definition declares an output with type: "array" and the
  // agent submitted a string value, coerce it: try JSON.parse first, then
  // fall back to newline-split.

  const stepDef = wf.jobs[jobId]?.steps.find((s) => s.id === stepId);

  const normalizedOutputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(report.outputs)) {
    const outputDef = stepDef?.outputs?.[key];
    const declaredType =
      outputDef !== null && typeof outputDef === "object"
        ? (outputDef as Record<string, unknown>)["type"]
        : undefined;

    if (declaredType === "array" && typeof value === "string") {
      // Try JSON parse first
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
          normalizedOutputs[key] = parsed;
          continue;
        }
      } catch { /* fall through */ }
      // Fall back: split by newline, filter empty
      normalizedOutputs[key] = value.split("\n").map((s) => s.trim()).filter(Boolean);
    } else {
      normalizedOutputs[key] = value;
    }
  }

  const signalsArray = report.signals;

  if (signalsArray.length > 0) {
    // Validate each signal before any disk mutation
    for (const sig of signalsArray) {
      const decl = wf.signals?.[sig.type];
      if (decl === undefined) {
        throw new ValidationError(
          `Signal type "${sig.type}" is not declared in workflow "${wf.name}"`,
          { details: { signalType: sig.type, jobId } }
        );
      }

      const allowedFrom = decl.allowed_from;
      if (allowedFrom !== undefined && !allowedFrom.includes(jobId)) {
        throw new WorkflowError(
          `Signal "${sig.type}" is not allowed from job "${jobId}" (allowed_from: ${allowedFrom.join(", ")})`,
          { details: { signalType: sig.type, jobId, allowedFrom } }
        );
      }
    }

    // ── 5. Select highest-priority signal ─────────────────────────────────────

    let selectedSignal = signalsArray[0]!;
    let selectedPriority = wf.signals?.[selectedSignal.type]?.priority ?? 0;

    for (let i = 1; i < signalsArray.length; i++) {
      const sig = signalsArray[i]!;
      const priority = wf.signals?.[sig.type]?.priority ?? 0;
      if (priority > selectedPriority) {
        selectedSignal = sig;
        selectedPriority = priority;
      }
    }

    const selectedDecl = wf.signals![selectedSignal.type]!;
    const action = selectedDecl.action ?? "continue";
    const reason =
      selectedSignal.reason ??
      `Agent submitted signal "${selectedSignal.type}" from job "${jobId}"`;

    // ── 6. Persist outputs before signal dispatch ─────────────────────────────
    // applyRoutingAction re-reads the snapshot internally, so we write outputs
    // to disk first so they are included in the state it reads and spreads.

    const stateWithOutputs: RunState = {
      ...state,
      jobs: {
        ...state.jobs,
        [jobId]: {
          ...jobState,
          outputs: normalizedOutputs,
        },
      },
    };
    await stateStore.writeSnapshot(runDir, stateWithOutputs);

    // ── 7. Dispatch selected signal via applyRoutingAction ────────────────────
    // (NO agent_report_accepted on the signal path)

    await applyRoutingAction({
      runDir,
      runId,
      sourceJobId: jobId,
      sourceStepId: stepId,
      attempt,
      action,
      reason,
      clock,
      signalName: selectedSignal.type,
    });

    // Advance the source job after signal dispatch — lazy import avoids circular dependency.
    // Only fire for object routing actions (retry_job / activate_job) where the source job
    // remains "running" after applyRoutingAction and needs to be advanced to completed.
    // - continue: advanceJob is already called inside applyRoutingAction (calling again
    //   would double-advance multi-step source jobs).
    // - fail/block: source is already in a terminal state (advanceJob would be a no-op,
    //   but skip for clarity).
    // - goto_job: source is already completed inside applyRoutingAction (no-op here).
    const isObjectRoutingAction =
      typeof action === "object" &&
      action !== null &&
      ("retry_job" in action || "activate_job" in action);
    if (isObjectRoutingAction) {
      const { advanceJob } = await import("./index.js");
      await advanceJob({ runDir, runId, jobId, clock });
    }

    return;
  }

  // ── No-signal path ─────────────────────────────────────────────────────────

  // ── 7. Persist outputs to job state ───────────────────────────────────────

  // ── 8. Emit agent_report_accepted event ───────────────────────────────────

  const lastId = await eventWriter.readLastEventId(runDir);
  const counter = lastId !== null ? parseInt(lastId.replace("evt-", ""), 10) : 0;
  const acceptedEventId = formatEventId(counter + 1);

  // Compute run-relative report artifact path (forward slashes for portability)
  const reportArtifact = relative(runDir, reportPath).replace(/\\/g, "/");

  await eventWriter.appendEvent(runDir, {
    id: acceptedEventId,
    run_id: runId,
    type: "agent_report_accepted",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt,
    payload: {
      job_id: jobId,
      step_id: stepId,
      report_artifact: reportArtifact,
    },
  });

  // ── 8b. Register report.json in artifact index ────────────────────────────

  const reportSize = await stat(reportPath).then(s => s.size).catch(() => 0);
  const reportArtifactId = artifactId(runId, jobId, attempt, stepId, "report.json");
  const reportRelPath = artifactFileRelativePath(jobId, attempt, stepId, "report.json");
  await appendArtifactIndex(runDir, {
    id: reportArtifactId,
    run_id: runId,
    producer: { job: jobId, step: stepId, attempt },
    kind: "agent_report",
    path: reportRelPath,
    content_type: "application/json",
    size: reportSize,
    summary: `Agent report for ${jobId}/${stepId}`,
    created_at: clock.now(),
  });

  // ── 9. Write intermediate snapshot (outputs + last_event_id) ──────────────

  const updatedJobState = {
    ...jobState,
    outputs: normalizedOutputs,
  };

  const intermediateState: RunState = {
    ...state,
    last_event_id: acceptedEventId,
    jobs: {
      ...state.jobs,
      [jobId]: updatedJobState,
    },
  };
  await stateStore.writeSnapshot(runDir, intermediateState);

  // ── 10. Delegate to advanceJob (lazy import, avoids circular dependency) ───

  const { advanceJob } = await import("./index.js");
  await advanceJob({ runDir, runId, jobId, clock });
}
