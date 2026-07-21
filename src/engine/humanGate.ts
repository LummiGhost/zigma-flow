/**
 * Human gate engine — enterHumanGate, recordHumanDecision, and resumeWithInput.
 *
 * Reference: docs/phases/p15-human-gate/02-development-plan.md
 * AD-P15-003 (enter), AD-P15-005 (record decision)
 * v0.6 Issue #210 — unified resume protocol with input validation and idempotency
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ZigmaFlowEvent } from "../events/index.js";
import { nextSequentialEventId } from "../events/sequence.js";
import {
  JsonlEventWriter,
  LocalStateStore,
} from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import { StateError, UserInputError, deprecationWarn } from "../utils/index.js";
import { advanceJob } from "./index.js";
import { appendArtifactIndex } from "../artifact/artifactIndex.js";
import { artifactId } from "../artifact/artifactMetadata.js";
import type { ArtifactMetadata } from "../artifact/artifactMetadata.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Human step input schema definition.
 *
 * Describes the expected input fields, their types, allowed values (enum),
 * and whether they are required.
 */
export interface HumanInputSchema {
  type: string;
  enum?: string[];
  required?: boolean;
}

/**
 * Parsed and validated human step input submitted via the resume command.
 */
export interface HumanInput {
  [key: string]: string;
}

/**
 * Routing action for on_submit outcomes.
 */
export type SubmitAction =
  | "continue"
  | "fail"
  | "block"
  | { retry_job: string; retry_with?: Record<string, string> }
  | { activate_job: string }
  | { goto_job: string }
  | { status: "blocked" | "failed" }
  | { goto_step: string; goto_with?: Record<string, string> };

// ---------------------------------------------------------------------------
// enterHumanGate
// ---------------------------------------------------------------------------

export interface EnterHumanGateOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  clock: Clock;
  /** Workflow definition needed to read step prompt/approvers/instructions. */
  stepPrompt: string;
  /**
   * @deprecated Informational only (AD-P15-002). MVP does NOT authenticate the
   * caller against this list — it is written to the human_gate_waiting event
   * and the human-gate.md artifact so operators can see who is expected to
   * decide. Identity checks are Host responsibility in v0.6+.
   */
  stepApprovers?: string[];
  stepInstructions?: string;
  /** v0.6: Input schema for the human step (optional). */
  stepInputs?: Record<string, HumanInputSchema>;
  /** Injectable state store (defaults to LocalStateStore). */
  stateStore?: LocalStateStore;
  /** Injectable event writer (defaults to JsonlEventWriter). */
  eventWriter?: JsonlEventWriter;
}

export async function enterHumanGate(opts: EnterHumanGateOpts): Promise<void> {
  const {
    runDir,
    runId,
    jobId,
    stepId,
    clock,
    stepPrompt,
    stepApprovers,
    stepInstructions,
    stepInputs,
    stateStore = new LocalStateStore(),
    eventWriter = new JsonlEventWriter(),
  } = opts;

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  // Idempotent: if already awaiting_human or awaiting_input, don't duplicate events
  if (jobState.step_status === "awaiting_human" || jobState.step_status === "awaiting_input") {
    return;
  }

  // v0.6 deprecation warning for approvers
  if (stepApprovers !== undefined && stepApprovers.length > 0) {
    deprecationWarn(
      `approvers field on human step "${stepId}" is deprecated. User identity and roles are managed by zigma-server or the calling Host`,
      "'inputs' schema instead",
    );
  }

  // Compute step artifact directory path
  const stepDir = join(
    runDir,
    "jobs",
    jobId,
    "attempts",
    String(jobState.attempt ?? 1),
    "steps",
    stepId,
  );
  const stepArtifactDir = relative(runDir, stepDir).replace(/\\/g, "/");

  // 1. Write human_gate_waiting event
  const eventId = await nextSequentialEventId(runDir, eventWriter);
  const externalGateId = `${runId}::${jobId}::${stepId}`;
  const event: ZigmaFlowEvent = {
    id: eventId,
    type: "human_gate_waiting",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt: jobState.attempt ?? 1,
    payload: {
      job_id: jobId,
      step_id: stepId,
      external_gate_id: externalGateId,
      prompt: stepPrompt,
      ...(stepApprovers !== undefined ? { approvers: stepApprovers } : {}),
      ...(stepInstructions !== undefined ? { instructions: stepInstructions } : {}),
      ...(stepInputs !== undefined ? { input_schema: stepInputs } : {}),
      step_artifact_dir: stepArtifactDir,
    },
  };
  await eventWriter.appendEvent(runDir, event);

  // 2. Write human-gate.md artifact
  await mkdir(stepDir, { recursive: true });
  let artifactContent = `# Human Gate: ${stepId}\n\n`;
  artifactContent += `**Prompt:** ${stepPrompt}\n\n`;
  if (stepInstructions !== undefined) {
    artifactContent += `${stepInstructions}\n\n`;
  }
  if (stepApprovers !== undefined && stepApprovers.length > 0) {
    artifactContent += `**Approvers (deprecated):** ${stepApprovers.join(", ")}\n\n`;
  }

  // v0.6: Show input schema and unified resume command
  if (stepInputs !== undefined && Object.keys(stepInputs).length > 0) {
    artifactContent += "## Required Inputs\n\n";
    for (const [name, schema] of Object.entries(stepInputs)) {
      const required = schema.required !== false ? " (required)" : " (optional)";
      const enumInfo = schema.enum !== undefined ? ` [${schema.enum.join(", ")}]` : "";
      artifactContent += `- **${name}**: ${schema.type}${enumInfo}${required}\n`;
    }
    artifactContent += "\n## How to Respond\n\n";
    artifactContent += "Use the unified resume command:\n\n";
    artifactContent += "```\n";
    const inputExample = Object.entries(stepInputs)
      .map(([name]) => `${name}=<value>`)
      .join(" ");
    artifactContent += `zigma-flow resume <run-id> --job ${jobId} --step ${stepId} --input ${inputExample}\n`;
    artifactContent += "```\n";
  } else {
    artifactContent += "**Approvers:** (anyone with project access)\n\n";
    artifactContent += "## Decision\n\n";
    artifactContent += "To approve:\n";
    artifactContent += `  zigma-flow approve --job ${jobId} --comment "..."\n\n`;
    artifactContent += "To reject:\n";
    artifactContent += `  zigma-flow reject --job ${jobId} --comment "reason"\n\n`;
    artifactContent += "**v0.6+ recommendation:** Use the unified `zigma-flow resume` command instead:\n";
    artifactContent += `  zigma-flow resume --job ${jobId} --step ${stepId} --input decision=approve\n`;
  }

  const artifactPath = join(stepDir, "human-gate.md");
  await writeFile(artifactPath, artifactContent, "utf-8");

  const artifactRelPath = relative(runDir, artifactPath).replace(/\\/g, "/");
  const metadata: ArtifactMetadata = {
    id: artifactId(runId, jobId, jobState.attempt ?? 1, stepId, "human-gate.md"),
    run_id: runId,
    producer: { job: jobId, step: stepId, attempt: jobState.attempt ?? 1 },
    kind: "human_gate_request",
    path: artifactRelPath,
    content_type: "text/markdown",
    size: Buffer.byteLength(artifactContent, "utf-8"),
    summary: stepPrompt.slice(0, 200),
    created_at: clock.now(),
  };
  await appendArtifactIndex(runDir, metadata);

  // 3. Set step status to awaiting_input (v0.6 default), run status to paused
  await stateStore.updateState(runDir, (current) => ({
    ...current,
    last_event_id: eventId,
    status: "paused",
    jobs: {
      ...current.jobs,
      [jobId]: {
        ...current.jobs[jobId]!,
        status: "running",
        step_status: "awaiting_input",
      },
    },
  }));
}

// ---------------------------------------------------------------------------
// recordHumanDecision
// ---------------------------------------------------------------------------

/**
 * Source channel from which a human decision was submitted.
 *
 * - `"cli"` — local CLI command (`zigma-flow approve` / `reject` / `resume`)
 * - `"api"` — Host API programmatic call
 * - `"email"` — email-based approval link
 * - `"web"` — web UI / dashboard
 */
export type DecisionSource = "cli" | "api" | "email" | "web";

/**
 * Structured actor identity for a human decision.
 *
 * Replaces the legacy flat `decidedBy` string with a richer record
 * suitable for audit trails and downstream tooling. See also
 * `src/artifact/humanDecisionRecord.ts` for the on-disk schema.
 */
export interface DecisionActor {
  /** Unique actor identifier (provider-agnostic). */
  id: string;
  /** Display name (optional). */
  name?: string;
  /** Actor category. */
  type: "user" | "system" | "service";
}

export interface RecordHumanDecisionOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  decision: "approved" | "rejected";
  comment?: string;
  outputs?: Record<string, string>;
  /** Legacy flat identity string (kept for backward compatibility). */
  decidedBy?: string;
  /** Structured actor identity (replaces decidedBy for new consumers). */
  actor?: DecisionActor;
  /**
   * Source channel the decision came through.
   *
   * When omitted the engine defaults to `"cli"` if `decidedBy` was resolved
   * from a process environment variable, or `"api"` otherwise.
   */
  source?: DecisionSource;
  clock: Clock;
  stateStore?: LocalStateStore;
  eventWriter?: JsonlEventWriter;
}

/**
 * Result of recording a human decision or resuming with input.
 */
export interface RecordHumanDecisionResult {
  /** The decision that was recorded (or detected as duplicate). */
  decision: "approved" | "rejected";
  /** Whether this was a new decision or a duplicate. */
  status: "recorded" | "duplicate" | "already_decided";
  /** ISO 8601 timestamp when the decision was recorded. */
  recordedAt: string;
  /** Next action hint. */
  nextAction: "continue" | "blocked" | "completed";
}

export async function recordHumanDecision(opts: RecordHumanDecisionOpts): Promise<RecordHumanDecisionResult> {
  const {
    runDir,
    runId,
    jobId,
    stepId,
    decision,
    comment,
    outputs: customOutputs,
    decidedBy,
    actor: explicitActor,
    source: explicitSource,
    clock,
    stateStore = new LocalStateStore(),
    eventWriter = new JsonlEventWriter(),
  } = opts;

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  // 1. Validate step is awaiting human input (v0.6 supports both old and new status names)
  if (jobState.step_status !== "awaiting_human" && jobState.step_status !== "awaiting_input") {
    throw new StateError(
      `Step "${stepId}" in job "${jobId}" is not awaiting human input (status: ${jobState.step_status ?? jobState.status})`,
      { details: { jobId, stepId, stepStatus: jobState.step_status } }
    );
  }

  // Resolve actor and source
  const resolvedActor: DecisionActor | undefined =
    explicitActor ??
    (decidedBy !== undefined
      ? { id: decidedBy, type: "user" as const }
      : undefined);

  const resolvedSource: DecisionSource | undefined =
    explicitSource ??
    (decidedBy !== undefined ? "cli" : "api");

  const attempt = jobState.attempt ?? 1;
  const stepDir = join(
    runDir,
    "jobs",
    jobId,
    "attempts",
    String(attempt),
    "steps",
    stepId,
  );

  // 2. Idempotency check — detect existing decision artifact
  const decisionPath = join(stepDir, "human-decision.json");
  let existingDecision: { decision?: string; decided_by?: string; actor?: { id?: string } } | null = null;
  try {
    const existingRaw = await readFile(decisionPath, "utf-8");
    existingDecision = JSON.parse(existingRaw);
  } catch {
    // File doesn't exist — this is a new decision
  }

  if (existingDecision !== null) {
    const actorId = (resolvedActor?.id ?? decidedBy ?? "").toLowerCase();
    const existingActorId = (
      existingDecision.actor?.id ??
      existingDecision.decided_by ??
      ""
    ).toLowerCase();

    // Same actor + same decision → idempotent no-op
    if (
      existingDecision.decision === decision &&
      actorId === existingActorId
    ) {
      return {
        decision,
        status: "duplicate",
        recordedAt: clock.now(),
        nextAction: decision === "approved" ? "continue" : "blocked",
      };
    }

    // Different decision → ALREADY_DECIDED error
    throw new UserInputError(
      `Step "${stepId}" in job "${jobId}" has already been decided as "${existingDecision.decision}". Cannot change to "${decision}".`,
      {
        details: {
          jobId,
          stepId,
          existingDecision: existingDecision.decision,
          newDecision: decision,
        },
        suggestion: "Create a new run to re-evaluate this human gate.",
      }
    );
  }

  // ── Idempotency check via event log (belt-and-suspenders) ──────────
  // If the decision file was deleted or corrupted, fall back to checking
  // the event log for an existing human_decision event for this step.
  // This is best-effort: it catches edge cases without blocking normal flow.
  let eventLogHasDecision = false;
  try {
    const { readFile: rf } = await import("node:fs/promises");
    const eventsPath = join(runDir, "events.jsonl");
    const eventsRaw = await rf(eventsPath, "utf-8");
    eventLogHasDecision = eventsRaw.includes(`"human_decision"`) &&
      eventsRaw.includes(`"step":"${stepId}"`) &&
      // Only consider it a match if it also mentions this job
      eventsRaw.includes(`"job":"${jobId}"`);
  } catch {
    // events.jsonl doesn't exist — that's fine, continue
  }

  if (eventLogHasDecision) {
    // Already exists in events but no file found — edge case, still treat as new
    // but log that we're proceeding (the file write below will overwrite)
  }

  const stepArtifactDir = relative(runDir, stepDir).replace(/\\/g, "/");

  const decisionRecord: Record<string, unknown> = {
    decision,
    timestamp: clock.now(),
    step_artifact_dir: stepArtifactDir,
  };
  if (comment !== undefined) decisionRecord["comment"] = comment;
  if (decidedBy !== undefined) decisionRecord["decided_by"] = decidedBy;
  if (resolvedActor !== undefined) decisionRecord["actor"] = resolvedActor;
  if (resolvedSource !== undefined) decisionRecord["source"] = resolvedSource;
  if (customOutputs !== undefined && Object.keys(customOutputs).length > 0) {
    decisionRecord["outputs"] = customOutputs;
    decisionRecord["custom_outputs"] = customOutputs;
  }

  const decisionRecordJson = JSON.stringify(decisionRecord, null, 2);

  await mkdir(stepDir, { recursive: true });
  await writeFile(decisionPath, decisionRecordJson, "utf-8");

  const decisionRelPath = relative(runDir, decisionPath).replace(/\\/g, "/");
  const metadata: ArtifactMetadata = {
    id: artifactId(runId, jobId, attempt, stepId, "human-decision.json"),
    run_id: runId,
    producer: { job: jobId, step: stepId, attempt },
    kind: "human_decision_record",
    path: decisionRelPath,
    content_type: "application/json",
    size: Buffer.byteLength(decisionRecordJson, "utf-8"),
    summary: `Decision: ${decision}${comment !== undefined ? ` — ${comment.slice(0, 150)}` : ""}`,
    created_at: clock.now(),
  };
  await appendArtifactIndex(runDir, metadata);

  // 3. Write human_decision event
  const eventId = await nextSequentialEventId(runDir, eventWriter);
  const event: ZigmaFlowEvent = {
    id: eventId,
    type: "human_decision",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: stepId,
    attempt,
    payload: {
      job_id: jobId,
      step_id: stepId,
      decision,
      ...(comment !== undefined ? { comment } : {}),
      ...(decidedBy !== undefined ? { decided_by: decidedBy } : {}),
      ...(customOutputs !== undefined && Object.keys(customOutputs).length > 0 ? { outputs: customOutputs } : {}),
    },
  };
  await eventWriter.appendEvent(runDir, event);

  // 4. Set step.outputs
  const stepOutputs: Record<string, unknown> = {
    decision,
    ...(comment !== undefined ? { comment } : {}),
    ...(customOutputs ?? {}),
  };

  let nextAction: "continue" | "blocked" | "completed";

  if (decision === "approved") {
    // approved → completed, advance job
    await stateStore.updateState(runDir, (current) => {
      const prevJob = current.jobs[jobId]!;
      const { step_status: _prevStepStatus, ...prevJobRest } = prevJob;
      return {
        ...current,
        last_event_id: eventId,
        status: "running",
        jobs: {
          ...current.jobs,
          [jobId]: {
            ...prevJobRest,
            status: "running" as const,
            outputs: {
              ...(prevJob.outputs ?? {}),
              ...stepOutputs,
            },
          },
        },
      };
    });

    const advanced = await advanceJob({ runDir, runId, jobId, clock });
    // Check if the job completed (single-step job where approval was the last step)
    if (!advanced) {
      const postState = await stateStore.readSnapshot(runDir);
      if (postState?.jobs[jobId]?.status === "completed") {
        nextAction = "completed";
      } else {
        nextAction = "continue";
      }
    } else {
      nextAction = "continue";
    }
  } else {
    // rejected → failed
    await stateStore.updateState(runDir, (current) => {
      const prevJob = current.jobs[jobId]!;
      const { step_status: _prevStepStatus, ...prevJobRest } = prevJob;
      return {
        ...current,
        last_event_id: eventId,
        status: "running",
        jobs: {
          ...current.jobs,
          [jobId]: {
            ...prevJobRest,
            status: "failed" as const,
            outputs: {
              ...(prevJob.outputs ?? {}),
              ...stepOutputs,
            },
          },
        },
      };
    });
    nextAction = "blocked";
  }

  return {
    decision,
    status: "recorded",
    recordedAt: clock.now(),
    nextAction,
  };
}

// ---------------------------------------------------------------------------
// resolveDecisionFromInput — canonical decision resolution (v0.6)
// ---------------------------------------------------------------------------

/**
 * Resolve a canonical "approved" / "rejected" decision from structured input.
 *
 * Decision values are normalized: "approve", "approved", "yes", "true" → "approved";
 * "reject", "rejected", "no", "false" → "rejected".
 */
function resolveDecisionFromInput(
  input: Record<string, string>,
  stepDef?: { inputs?: Record<string, HumanInputSchema> },
  jobId?: string,
  stepId?: string,
): "approved" | "rejected" {
  const decisionKey = stepDef?.inputs !== undefined
    ? Object.keys(stepDef.inputs).find(k => k === "decision" || stepDef.inputs![k]!.enum?.includes("approve"))
    : "decision";

  const decisionValue = decisionKey !== undefined ? input[decisionKey] : input["decision"];

  if (decisionValue !== undefined) {
    const lower = decisionValue.toLowerCase();
    if (lower === "approve" || lower === "approved" || lower === "yes" || lower === "true") {
      return "approved";
    }
    if (lower === "reject" || lower === "rejected" || lower === "no" || lower === "false") {
      return "rejected";
    }
    throw new UserInputError(
      `Invalid decision value "${decisionValue}". Expected "approve" or "reject".`,
      {
        details: { jobId, stepId, value: decisionValue },
        suggestion: "Use --input decision=approve or --input decision=reject",
      }
    );
  }

  if (input["decision"] === undefined) {
    throw new UserInputError(
      `No decision input provided. Provide --input decision=approve or --input decision=reject.`,
      {
        details: { jobId, stepId, providedInputs: Object.keys(input) },
        suggestion: "Use --input decision=approve or --input decision=reject",
      }
    );
  }

  // Fallback: use input["decision"] directly
  const lower = String(input["decision"]).toLowerCase();
  if (lower === "approve" || lower === "approved" || lower === "yes" || lower === "true") {
    return "approved";
  }
  return "rejected";
}

// ---------------------------------------------------------------------------
// resumeWithInput — unified resume protocol (v0.6 Issue #210)
// ---------------------------------------------------------------------------

export interface ResumeWithInputOpts {
  runDir: string;
  runId: string;
  jobId: string;
  stepId: string;
  /** Structured input key-value pairs submitted by the caller. */
  input: Record<string, string>;
  /** Optional comment. */
  comment?: string;
  /** Structured actor identity. */
  actor?: DecisionActor;
  /** Source channel. */
  source?: DecisionSource;
  /**
   * Workflow step definition (optional). When provided, the engine validates
   * the submitted input against the step's input schema before recording.
   */
  stepDef?: {
    inputs?: Record<string, HumanInputSchema>;
    on_submit?: Record<string, Record<string, SubmitAction>>;
    prompt?: string;
  };
  clock: Clock;
  stateStore?: LocalStateStore;
  eventWriter?: JsonlEventWriter;
}

export interface ResumeWithInputResult {
  /** The resolved decision outcome. */
  outcome: string;
  /** Mapping of effect per input field (e.g. decision → approve). */
  effects: Record<string, string>;
  /** Whether this was a new submission or a duplicate. */
  status: "recorded" | "duplicate" | "already_decided";
  /** ISO 8601 timestamp. */
  recordedAt: string;
  /** Next action hint. */
  nextAction: "continue" | "blocked" | "completed";
}

/**
 * Unified resume entry point (v0.6).
 *
 * 1. Validates input against the step's input schema (if present).
 * 2. Resolves the "decision" from the input (or defaults from on_submit).
 * 3. Delegates to recordHumanDecision for audit trail and state advancement.
 * 4. Returns a structured result with outcome metadata.
 */
export async function resumeWithInput(opts: ResumeWithInputOpts): Promise<ResumeWithInputResult> {
  const {
    runDir,
    runId,
    jobId,
    stepId,
    input,
    comment,
    actor,
    source,
    stepDef,
    clock,
    stateStore = new LocalStateStore(),
    eventWriter = new JsonlEventWriter(),
  } = opts;

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new StateError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  // 1. Check for existing decision first (idempotency / ALREADY_DECIDED).
  //    This check runs BEFORE the awaiting-input gate so duplicate submissions
  //    are handled gracefully even after the step has been resolved.
  const attempt = jobState.attempt ?? 1;
  const stepDir = join(
    runDir,
    "jobs",
    jobId,
    "attempts",
    String(attempt),
    "steps",
    stepId,
  );
  const decisionPath = join(stepDir, "human-decision.json");

  let existingDecision: { decision?: string; decided_by?: string; actor?: { id?: string } } | null = null;
  try {
    const existingRaw = await readFile(decisionPath, "utf-8");
    existingDecision = JSON.parse(existingRaw);
  } catch {
    // No existing decision — proceed with normal flow
  }

  if (existingDecision !== null) {
    const actorId = (actor?.id ?? "").toLowerCase();
    const existingActorId = (
      existingDecision.actor?.id ??
      existingDecision.decided_by ??
      ""
    ).toLowerCase();

    // Resolve the canonical decision from input
    const resolvedDecision = resolveDecisionFromInput(input, stepDef);
    const existingCanonical = existingDecision.decision;

    // Same actor + same decision → idempotent no-op
    if (
      existingCanonical === resolvedDecision &&
      (actorId === existingActorId || existingActorId === "")
    ) {
      const nextActionHint =
        existingCanonical === "approved" ? "continue" as const : "blocked" as const;
      // Check if job actually completed (single-step job with approve)
      let actualNextAction: "continue" | "blocked" | "completed" = nextActionHint;
      if (existingCanonical === "approved") {
        const curJobState = (await stateStore.readSnapshot(runDir))?.jobs[jobId];
        if (curJobState?.status === "completed") {
          actualNextAction = "completed";
        }
      }
      return {
        outcome: existingCanonical,
        effects: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v])),
        status: "duplicate",
        recordedAt: clock.now(),
        nextAction: actualNextAction,
      };
    }

    // Different decision → ALREADY_DECIDED error
    throw new UserInputError(
      `Step "${stepId}" in job "${jobId}" has already been decided as "${existingDecision.decision}". Cannot change decision.`,
      {
        details: {
          jobId,
          stepId,
          existingDecision: existingDecision.decision,
          newDecision: resolvedDecision,
        },
        suggestion: "Create a new run to re-evaluate this human gate.",
      }
    );
  }

  // 2. Validate step is awaiting input
  if (jobState.step_status !== "awaiting_human" && jobState.step_status !== "awaiting_input") {
    throw new StateError(
      `Step "${stepId}" in job "${jobId}" is not awaiting human input (status: ${jobState.step_status ?? jobState.status})`,
      { details: { jobId, stepId, stepStatus: jobState.step_status } }
    );
  }

  // 3. Validate input against step's input schema (if defined)
  if (stepDef?.inputs !== undefined) {
    for (const [fieldName, fieldSchema] of Object.entries(stepDef.inputs)) {
      const value = input[fieldName];
      const isRequired = fieldSchema.required !== false; // default to required

      if (value === undefined) {
        if (isRequired) {
          throw new UserInputError(
            `Missing required input "${fieldName}" for step "${stepId}" in job "${jobId}"`,
            {
              details: {
                jobId,
                stepId,
                missingField: fieldName,
                schema: fieldSchema,
              },
              suggestion: `Provide --input ${fieldName}=<value>`,
            }
          );
        }
        continue; // optional field, skip
      }

      // Validate enum if present
      if (fieldSchema.enum !== undefined && fieldSchema.enum.length > 0) {
        if (!fieldSchema.enum.includes(value)) {
          throw new UserInputError(
            `Invalid value "${value}" for input "${fieldName}". Allowed values: ${fieldSchema.enum.join(", ")}`,
            {
              details: {
                jobId,
                stepId,
                field: fieldName,
                value,
                allowedValues: fieldSchema.enum,
              },
              suggestion: `Provide one of: ${fieldSchema.enum.join(", ")}`,
            }
          );
        }
      }
    }
  }

  // 4. Resolve decision from input
  const decision = resolveDecisionFromInput(input, stepDef, jobId, stepId);

  // 5. Delegate to recordHumanDecision (with canonical decision value in outputs)
  const canonicalOutputs = {
    ...input,
    decision, // canonical value ("approved"/"rejected")
  };

  const result = await recordHumanDecision({
    runDir,
    runId,
    jobId,
    stepId,
    decision,
    ...(comment !== undefined ? { comment } : {}),
    outputs: canonicalOutputs,
    ...(actor !== undefined ? { actor } : {}),
    ...(source !== undefined ? { source } : {}),
    clock,
    stateStore,
    eventWriter,
  });

  return {
    outcome: decision,
    effects: Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, v])
    ),
    status: result.status,
    recordedAt: result.recordedAt,
    nextAction: result.nextAction,
  };
}
