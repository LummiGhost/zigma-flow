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
import type { StepDefinition } from "../workflow/index.js";
import { FilesystemError, StateError, ValidationError, WorkflowError } from "../utils/index.js";
import { mergeOutputDeclarations } from "../agent/outputSchema.js";
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
  /** Raw top-level `status` value (uncoerced) — lets the final-line contract
   * check detect a dual-source conflict against `outputs.status` with strict
   * equality instead of comparing String-coerced values. */
  topLevelStatus?: unknown;
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
  } else {
    // Mirrors the compiled schema's artifacts.items: { type: "string" } —
    // artifact refs are strings (step-artifact paths or artifact:// refs).
    // A non-string item must be rejected here on every accept path instead
    // of being silently filtered out by the required_artifacts matcher.
    const nonStringArtifact = obj["artifacts"].find((a) => typeof a !== "string");
    if (nonStringArtifact !== undefined) {
      errors.push(
        `field "artifacts" items must be strings, got non-string item ${JSON.stringify(nonStringArtifact)}`
      );
    }
  }

  if (!Array.isArray(obj["signals"])) {
    errors.push('missing required field "signals" (must be an array)');
  }

  if (typeof obj["summary"] !== "string") {
    errors.push('missing required field "summary" (must be a string)');
  }

  // v0.6 deprecation: context_patches
  if (!process.env.ZIGMA_SUPPRESS_DEPRECATION && obj["context_patches"] !== undefined) {
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
    const type = typeof s["type"] === "string" ? s["type"] : s["signal"];
    if (typeof type !== "string" || type.trim().length === 0) {
      throw new ValidationError(
        `Invalid signal entry: "type" (or legacy "signal") field must be a non-empty string`,
        { details: { signal: s } }
      );
    }
    const entry: { type: string; reason?: string } = { type };
    if (s["reason"] !== undefined) {
      entry.reason = String(s["reason"]);
    }
    return entry;
  });

  const topLevelStatus = obj["status"];
  const outputsStatus =
    typeof obj["outputs"] === "object" && obj["outputs"] !== null && !Array.isArray(obj["outputs"])
      ? (obj["outputs"] as Record<string, unknown>)["status"]
      : undefined;

  return {
    outputs: (obj["outputs"] ?? {}) as Record<string, unknown>,
    artifacts: (obj["artifacts"] ?? []) as unknown[],
    signals,
    summary: obj["summary"] as string,
    // Issue #256: accept status from outputs["status"] when not at top level.
    // The resolved status is used only for status-return dispatch, which
    // requires a string within returns.status.values — the final-line check
    // enforces that on the raw values, so resolution happens WITHOUT String
    // coercion (a non-string value never becomes a routable status).
    topLevelStatus,
    status: topLevelStatus !== undefined
      ? (typeof topLevelStatus === "string" ? topLevelStatus : undefined)
      : (typeof outputsStatus === "string" ? outputsStatus : undefined),
    ...(obj["context_patches"] !== undefined ? { context_patches: obj["context_patches"] as unknown[] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared step-contract validation (acceptAgentReport + runAll inline path)
// ---------------------------------------------------------------------------

/**
 * Validate a parsed Agent report against the step's output contract.
 *
 * This is the Engine's final-line defense: it runs on every accept path
 * (autonomous runAll loop and manual `next`/accept) before any state can
 * advance. The contract is derived from the SAME per-key union/merge of
 * outputs + outputs_schema that compileAgentOutputSchema builds, so the
 * prompt-side schema and the runtime enforcement cannot drift:
 *
 *   1. required_artifacts — each declared artifact path must be present in
 *      report.artifacts (string refs, matched as path segment).
 *   2. Every key in the outputs ∪ outputs_schema union must be present.
 *   3. Closed outputs object (additionalProperties: false) — any reported
 *      key outside the merged contract is rejected before it can be
 *      persisted or influence routing. The one implicit key is "status"
 *      when the step declares returns.status: the prompt contract
 *      (Issue #256) directs agents to write outputs.status.
 *   4. Dual-source status conflict — when the step declares returns.status
 *      and the report carries BOTH a top-level `status` and an
 *      `outputs.status`, the two values must be strictly equal, otherwise
 *      the report is rejected (fail-closed). The compiled schema's
 *      per-property enums cannot detect this (JSON Schema has no
 *      cross-field equality); the schema approximates it with per-value
 *      if/then guards at the native boundary, and this check is the
 *      authoritative enforcement on every accept path.
 *   4b. Legacy top-level status — when the step declares returns.status, a
 *      single-source top-level `status` must be a strict string within
 *      returns.status.values. No String coercion: the compiled schema
 *      declares the top-level `status` as { type: "string", enum: values },
 *      so a numeric/null top-level value is rejected instead of being
 *      coerced into a value that happens to match a routing value.
 *   5. Array-typed outputs (merged type "array") are normalized (JSON.parse,
 *      then newline-split fallback).
 *   6. Type checks against the merged declaration — outputs-only types are
 *      enforced too, and run after normalization. When returns.status is
 *      declared, the returns-merged `status` declaration (type "string")
 *      is enforced on outputs.status exactly like the compiled schema.
 *   7. enum/values checks with strict equality (JSON Schema semantics: no
 *      String coercion). An empty enum (values: []) rejects every value.
 *      outputs.status is held to the same merged enum the compiled schema
 *      declares (an explicit subset when one was declared).
 *
 * Throws ValidationError on any violation — no state transition happens.
 * Returns the normalized outputs to persist.
 */
export function validateReportAgainstStep(
  stepDef: StepDefinition | undefined,
  report: { outputs: Record<string, unknown>; artifacts: unknown[]; topLevelStatus?: unknown },
): Record<string, unknown> {
  // ── 1. required_artifacts ─────────────────────────────────────────────
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

  // ── 2. Union of declared output keys must all be present ──────────────
  // Same union as compileAgentOutputSchema: outputs_schema-only keys are
  // required too.
  const contract = stepDef ? mergeOutputDeclarations(stepDef) : undefined;
  const declarations = contract?.declarations ?? {};
  const declaredKeys = contract?.names ?? [];

  const missingKeys = declaredKeys.filter((k) => !(k in report.outputs));
  if (missingKeys.length > 0) {
    throw new ValidationError(
      `Report is missing declared output(s): ${missingKeys.join(", ")}`,
      { details: { missing: missingKeys, declared: declaredKeys } }
    );
  }

  // ── 3. Closed outputs object — no undeclared keys ─────────────────────
  // Mirrors the compiled schema's additionalProperties: false. Skipped when
  // the step definition is unknown (the contract cannot be derived).
  if (stepDef) {
    const allowedKeys = new Set(declaredKeys);
    if (stepDef.returns?.status) allowedKeys.add("status");
    const extraKeys = Object.keys(report.outputs).filter((k) => !allowedKeys.has(k));
    if (extraKeys.length > 0) {
      throw new ValidationError(
        `Report contains undeclared output(s): ${extraKeys.join(", ")}`,
        { details: { undeclared: extraKeys, declared: declaredKeys } }
      );
    }
  }

  // ── 4. Dual-source status conflict — fail closed ────────────────────────
  // When the step declares returns.status, both the legacy top-level
  // `status` (mvp-contracts §2.6) and the canonical `outputs.status`
  // (Issue #256) are accepted locations. A report carrying BOTH with values
  // that are not strictly equal must be rejected: routing would follow the
  // top-level value while the nested value is the one persisted — a
  // dual-source contradiction. Native schema enforcement can only approximate
  // this (per-value if/then guards), so this check is the authoritative
  // final line for every accept path.
  if (
    stepDef?.returns?.status &&
    report.topLevelStatus !== undefined &&
    report.outputs.status !== undefined &&
    report.topLevelStatus !== report.outputs.status
  ) {
    throw new ValidationError(
      `Report declares conflicting status values: top-level "status" is ${JSON.stringify(report.topLevelStatus)} but "outputs.status" is ${JSON.stringify(report.outputs.status)}. ` +
      `Write "outputs.status" only (the canonical location); when both are present they must be strictly equal.`,
      { details: { topLevelStatus: report.topLevelStatus, outputsStatus: report.outputs.status } }
    );
  }

  // ── 4b. Legacy top-level status: strict string + routing domain ────────
  // The compiled schema declares the legacy top-level `status` as
  // { type: "string", enum: returns.status.values }. The Engine enforces the
  // identical contract on the raw value — no String coercion — so a
  // numeric/null/object top-level status is rejected before any state change
  // instead of being coerced into a string that happens to match a routing
  // value (e.g. a numeric 5 must never route as "5").
  if (stepDef?.returns?.status && report.topLevelStatus !== undefined) {
    if (typeof report.topLevelStatus !== "string") {
      throw new ValidationError(
        `Top-level "status" must be a string (no String coercion): got ${JSON.stringify(report.topLevelStatus)}`,
        { details: { topLevelStatus: report.topLevelStatus } }
      );
    }
    if (!stepDef.returns.status.values.includes(report.topLevelStatus)) {
      throw new ValidationError(
        `Top-level "status" ${JSON.stringify(report.topLevelStatus)} is not in returns.status.values ` +
        `[${stepDef.returns.status.values.map((v) => JSON.stringify(v)).join(", ")}]`,
        { details: { topLevelStatus: report.topLevelStatus, values: stepDef.returns.status.values } }
      );
    }
  }

  // ── 5. Normalize array-typed outputs (merged declaration) ─────────────
  const normalizedOutputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(report.outputs)) {
    const mergedType = declarations[key]?.["type"];

    if (mergedType === "array" && typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
          normalizedOutputs[key] = parsed;
          continue;
        }
      } catch { /* fall through */ }
      normalizedOutputs[key] = value.split("\n").map((s) => s.trim()).filter(Boolean);
    } else {
      normalizedOutputs[key] = value;
    }
  }

  // ── 6. Type checks against the merged declaration ─────────────────────
  // Runs AFTER normalization so a string report for an array-typed output
  // validates as an array. outputs-only types are enforced as well. The
  // iteration covers the implicit `status` key too: when the step declares
  // returns.status, declarations["status"] is the same returns-merged
  // declaration the compiled schema uses, so its type: "string" is enforced
  // identically here (the compiled schema does not String-coerce).
  for (const [key, value] of Object.entries(normalizedOutputs)) {
    const expectedType = declarations[key]?.["type"];
    if (typeof expectedType !== "string") continue;

    const actualType =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

    if (expectedType !== actualType) {
      throw new ValidationError(
        `Output "${key}" type mismatch: expected ${expectedType}, got ${actualType}`,
        { details: { key, expected: expectedType, actual: actualType } }
      );
    }
  }

  // ── 7. enum/values final-line check ───────────────────────────────────
  // Strict equality (JSON Schema semantics) — no String coercion, so 1 does
  // not match "1". An empty enum (values: []) matches nothing and therefore
  // rejects every reported value. When the step declares returns.status,
  // declarations["status"] is the returns-merged declaration, so
  // outputs.status is held to the exact enum the compiled schema declares
  // (an explicit subset when one was declared).
  for (const [key, value] of Object.entries(normalizedOutputs)) {
    const decl = declarations[key];
    if (decl === undefined) continue;

    const allowedValues: unknown[] | undefined =
      Array.isArray(decl["values"]) ? (decl["values"] as unknown[])
      : Array.isArray(decl["enum"]) ? (decl["enum"] as unknown[])
      : undefined;
    if (allowedValues === undefined) continue;

    const matched = allowedValues.some((allowed) => allowed === value);
    if (!matched) {
      throw new ValidationError(
        `Output "${key}" value ${JSON.stringify(value)} is not in declared values: [${allowedValues.map((v) => JSON.stringify(v)).join(", ")}]`,
        { details: { outputKey: key, actualValue: value, allowedValues } }
      );
    }
  }

  return normalizedOutputs;
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

  // ── 3b-4c. Shared final-line contract validation (§2.6) ──────────────────
  // required_artifacts → declared keys → array normalization → outputs_schema
  // types → enum/values. Throws ValidationError before any state transition.
  const normalizedOutputs = validateReportAgainstStep(stepDef, {
    outputs: report.outputs,
    artifacts: report.artifacts,
    topLevelStatus: report.topLevelStatus,
  });

  const signalsArray = report.signals;

  // ── Status handling (AD-P13-013) — before signals ─────────────────────
  // If the step declares returns.status and the report includes a status
  // field, dispatch via applyStatusReturn (which emits step_returned and
  // calls applyRoutingAction). Status action takes priority over signals.

  if (report.status !== undefined && stepDef?.returns?.status) {
    // Write outputs to state first (pipeline step 2)
    await stateStore.updateState(runDir, (current) => ({
      ...current,
      jobs: {
        ...current.jobs,
        [jobId]: { ...current.jobs[jobId]!, outputs: normalizedOutputs },
      },
    }));

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

  // ── Required status validation (Issue #227) ────────────────────────────
  // If the step declares returns.status.required: true but the report omitted
  // the status field, fail with a clear ValidationError instead of silently
  // continuing (which would cause an infinite re-invoke loop in runAll).

  if (report.status === undefined && stepDef?.returns?.status?.required === true) {
    throw new ValidationError(
      `Step "${stepId}" requires a return status but none was provided in report.json`,
      { details: { jobId, stepId, required: true } }
    );
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
        await stateStore.updateState(runDir, (current) => ({
          ...current,
          jobs: {
            ...current.jobs,
            [jobId]: { ...current.jobs[jobId]!, outputs: normalizedOutputs },
          },
        }));

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
    // v0.6 deprecation warning (Issue #209) — signals still processed normally
    if (!process.env.ZIGMA_SUPPRESS_DEPRECATION) {
      console.warn(
        "[DEPRECATED] Agent report signals are deprecated. Use status returns instead. This will be removed in v1.0."
      );
    }

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

    await stateStore.updateState(runDir, (current) => ({
      ...current,
      jobs: {
        ...current.jobs,
        [jobId]: { ...current.jobs[jobId]!, outputs: normalizedOutputs },
      },
    }));

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

  await stateStore.updateState(runDir, (current) => ({
    ...current,
    jobs: {
      ...current.jobs,
      [jobId]: { ...current.jobs[jobId]!, outputs: normalizedOutputs },
    },
  }));

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

  await stateStore.updateState(runDir, (current) => ({
    ...current,
    last_event_id: acceptedEventId,
    jobs: {
      ...current.jobs,
      [jobId]: { ...current.jobs[jobId]!, ...updatedJobState },
    },
  }));

  // ── 10. Delegate to advanceJob (lazy import, avoids circular dependency) ───

  const { advanceJob } = await import("./index.js");
  await advanceJob({ runDir, runId, jobId, clock });
}
