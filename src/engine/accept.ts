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
import type { Clock, JobState, RunState } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import { FilesystemError, StateError, ValidationError, WorkflowError } from "../utils/index.js";
import { applyRoutingAction } from "./routing.js";
import type { ContextPatch } from "./applyContextPatch.js";

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
  status?: string | undefined;
  context_patches?: unknown[];
}

export function validateReportShape(parsed: unknown): AgentReport {
  const errors: string[] = [];

  if (typeof parsed !== "object" || parsed === null) {
    throw new ValidationError("report.json must be a JSON object", {
      details: { actual: typeof parsed },
    });
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["outputs"] !== "object" || obj["outputs"] === null || Array.isArray(obj["outputs"])) {
    errors.push('missing required field "outputs" (must be an object)');
  }

  if (!Array.isArray(obj["artifacts"])) {
    errors.push('missing required field "artifacts" (must be an array)');
  }

  if (!Array.isArray(obj["signals"])) {
    errors.push('missing required field "signals" (must be an array)');
  }

  if (typeof obj["summary"] !== "string") {
    errors.push('missing required field "summary" (must be a string)');
  }

  // v0.6 deprecation: context_patches
  if (obj["context_patches"] !== undefined) {
    console.warn(
      "[DEPRECATED] context_patches are deprecated, use outputs and artifacts instead. This will be removed in v1.0.",
    );
  }

  if (errors.length > 0) {
    throw new ValidationError(
      `report.json has ${errors.length} validation error(s):\n  - ${errors.join("\n  - ")}`,
      { details: { errors } }
    );
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
    outputs: (obj["outputs"] ?? {}) as Record<string, unknown>,
    artifacts: (obj["artifacts"] ?? []) as unknown[],
    signals,
    summary: obj["summary"] as string,
    status: obj["status"] !== undefined ? String(obj["status"]) : undefined,
    ...(obj["context_patches"] !== undefined ? { context_patches: obj["context_patches"] as unknown[] } : {}),
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

  // ── 3b. Validate required artifacts against step definition ────────────────
  // If the step declares required_artifacts, each must be present in the
  // report's artifacts array (matched as a path segment or full path, so
  // "summary.md" does not false-match "not-summary.md" or "old/summary.md.bak").

  if (stepDef?.required_artifacts && stepDef.required_artifacts.length > 0) {
    const reportArtifactRefs = report.artifacts
      .filter((a): a is string => typeof a === "string")
      .map((a) => a);

    for (const required of stepDef.required_artifacts) {
      const found = reportArtifactRefs.some((a) => {
        // Match as a path segment: "summary.md" matches ".../summary.md" or "summary.md"
        // but NOT "not-summary.md" (substring match is rejected).
        return a === required || a.endsWith("/" + required);
      });
      if (!found) {
        throw new ValidationError(
          `Required artifact "${required}" not found in report artifacts. ` +
          `The step requires this artifact to be produced.`,
          { details: { required, actual: reportArtifactRefs } }
        );
      }
    }
  }

  // ── 3c. Validate declared output keys are present in report ──────────────

  if (stepDef?.outputs) {
    const declaredKeys = Object.keys(stepDef.outputs);
    const missingKeys = declaredKeys.filter((k) => !(k in report.outputs));
    if (missingKeys.length > 0) {
      throw new ValidationError(
        `Report is missing declared output(s): ${missingKeys.join(", ")}`,
        { details: { missing: missingKeys, declared: declaredKeys } }
      );
    }
  }

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

  // ── 3d. Validate output value types against outputs_schema ─────────────

  if (stepDef?.outputs_schema) {
    for (const [key, schema] of Object.entries(stepDef.outputs_schema)) {
      const value = normalizedOutputs[key];
      if (value === undefined) continue;

      const expectedType = schema.type;
      let actualType: string;
      if (value === null) {
        actualType = "null";
      } else if (Array.isArray(value)) {
        actualType = "array";
      } else {
        actualType = typeof value;
      }

      if (expectedType !== actualType) {
        throw new ValidationError(
          `Output "${key}" type mismatch: expected ${expectedType}, got ${actualType}`,
          { details: { key, expected: expectedType, actual: actualType } }
        );
      }
    }
  }

  // ── 4c. Validate output values against declared constraints (Issue #172) ───
  // If a step declares outputs with a "values" constraint (in outputs or
  // outputs_schema), validate that the report's output value is in the set.

  for (const [key, value] of Object.entries(normalizedOutputs)) {
    const outputDecl = stepDef?.outputs?.[key];
    const outputSchema = stepDef?.outputs_schema?.[key];
    const allowedValues: string[] | undefined =
      (outputSchema?.values) ??
      (outputDecl !== null && typeof outputDecl === "object"
        ? (outputDecl as Record<string, unknown>)["values"] as string[] | undefined
        : undefined);

    if (allowedValues !== undefined && Array.isArray(allowedValues) && allowedValues.length > 0) {
      const strValue = String(value ?? "");
      if (!allowedValues.includes(strValue)) {
        throw new ValidationError(
          `Output "${key}" value "${strValue}" is not in declared values: [${allowedValues.join(", ")}]`,
          { details: { outputKey: key, actualValue: strValue, allowedValues } }
        );
      }
    }
  }

  const signalsArray = report.signals;

  // ── Status handling (AD-P13-013) — before signals ─────────────────────
  // If the step declares returns.status and the report includes a status
  // field, dispatch via applyStatusReturn (which emits step_returned and
  // calls applyRoutingAction). Status action takes priority over signals.

  if (report.status !== undefined && stepDef?.returns?.status) {
    // Write outputs to state first (pipeline step 2)
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

    // ── 3b. Apply context patches (AD-P13-013 pipeline step 3) ────────────
    if (report.context_patches && report.context_patches.length > 0) {
      const { applyContextPatch: acp } = await import("./applyContextPatch.js");
      await acp({
        runDir,
        runId,
        jobId,
        stepId,
        attempt,
        patches: report.context_patches as ContextPatch[],
        clock,
      });
    }

    const { applyStatusReturn: applySR } = await import("./applyStatusReturn.js");
    await applySR({
      runDir,
      runId,
      sourceJobId: jobId,
      sourceStepId: stepId,
      attempt,
      status: report.status,
      clock,
    });

    return;
  }

  // ── on_output routing (Issue #172) — before signals ─────────────────────
  // If the step declares on_output and a reported output value matches a
  // routing rule, dispatch the action via applyRoutingAction. This takes
  // priority over signal routing.

  if (stepDef?.on_output) {
    for (const [outputKey, valueMap] of Object.entries(stepDef.on_output)) {
      const outputValue = String(normalizedOutputs[outputKey] ?? "");
      if (outputValue && valueMap[outputValue] !== undefined) {
        const action = valueMap[outputValue]!;

        // Persist outputs to state before dispatch
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

        // Apply context patches if present
        if (report.context_patches && report.context_patches.length > 0) {
          const { applyContextPatch: acp } = await import("./applyContextPatch.js");
          await acp({
            runDir,
            runId,
            jobId,
            stepId,
            attempt,
            patches: report.context_patches as ContextPatch[],
            clock,
          });
        }

        // Dispatch the routing action
        await applyRoutingAction({
          runDir,
          runId,
          sourceJobId: jobId,
          sourceStepId: stepId,
          attempt,
          action,
          reason: `on_output routing: ${outputKey} = ${outputValue}`,
          clock,
        });

        // Advance the source job after routing dispatch (same as signal path)
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
    }
  }

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

    // ── 3b. Apply context patches (AD-P13-013 pipeline step 3) ────────────
    if (report.context_patches && report.context_patches.length > 0) {
      const { applyContextPatch: acp } = await import("./applyContextPatch.js");
      await acp({
        runDir,
        runId,
        jobId,
        stepId,
        attempt,
        patches: report.context_patches as ContextPatch[],
        clock,
      });
    }

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

  // ── 7. Persist outputs to job state (before context patches) ──────────────

  const outputsState: RunState = {
    ...state,
    jobs: {
      ...state.jobs,
      [jobId]: {
        ...jobState,
        outputs: normalizedOutputs,
      },
    },
  };
  await stateStore.writeSnapshot(runDir, outputsState);

  // ── 8. Apply context patches (AD-P13-013 pipeline step 3) ────────────────

  if (report.context_patches && report.context_patches.length > 0) {
    const { applyContextPatch: acp } = await import("./applyContextPatch.js");
    await acp({
      runDir,
      runId,
      jobId,
      stepId,
      attempt,
      patches: report.context_patches as ContextPatch[],
      clock,
    });
  }

  // ── 9. Emit agent_report_accepted event ───────────────────────────────────

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

  // ── 9b. Register report.json in artifact index ────────────────────────────

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

  // ── 10. Read latest state (includes patch results) and write snapshot ────

  const latestState = await stateStore.readSnapshot(runDir);
  if (latestState === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const latestJobState = latestState.jobs[jobId]!;
  const updatedJobState: JobState = {
    ...latestJobState,
    outputs: normalizedOutputs,
  };

  const intermediateState: RunState = {
    ...latestState,
    last_event_id: acceptedEventId,
    jobs: {
      ...latestState.jobs,
      [jobId]: updatedJobState,
    },
  };
  await stateStore.writeSnapshot(runDir, intermediateState);

  // ── 10. Delegate to advanceJob (lazy import, avoids circular dependency) ───

  const { advanceJob } = await import("./index.js");
  await advanceJob({ runDir, runId, jobId, clock });
}
