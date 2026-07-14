/**
 * Human gate engine — enterHumanGate and recordHumanDecision.
 *
 * Reference: docs/phases/p15-human-gate/02-development-plan.md
 * AD-P15-003 (enter), AD-P15-005 (record decision)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ZigmaFlowEvent } from "../events/index.js";
import { nextSequentialEventId } from "../events/sequence.js";
import {
  JsonlEventWriter,
  LocalStateStore,
} from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import { StateError } from "../utils/index.js";
import { advanceJob } from "./index.js";
import { appendArtifactIndex } from "../artifact/artifactIndex.js";
import { artifactId } from "../artifact/artifactMetadata.js";
import type { ArtifactMetadata } from "../artifact/artifactMetadata.js";

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
   * Informational only (AD-P15-002). MVP does NOT authenticate the caller of
   * `zigma-flow approve` / `reject` against this list — it is written to the
   * human_gate_waiting event and the human-gate.md artifact so operators can
   * see who is expected to decide. Identity checks are v0.3+ scope.
   */
  stepApprovers?: string[];
  stepInstructions?: string;
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

  // Idempotent: if already awaiting_human, don't duplicate events
  if (jobState.step_status === "awaiting_human") {
    return;
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
      prompt: stepPrompt,
      ...(stepApprovers !== undefined ? { approvers: stepApprovers } : {}),
      ...(stepInstructions !== undefined ? { instructions: stepInstructions } : {}),
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
    artifactContent += `**Approvers:** ${stepApprovers.join(", ")}\n\n`;
  } else {
    artifactContent += `**Approvers:** (anyone with project access)\n\n`;
  }
  artifactContent += "## Decision\n\n";
  artifactContent += "To approve:\n";
  artifactContent += `  zigma-flow approve --job ${jobId} --comment "..."\n\n`;
  artifactContent += "To reject:\n";
  artifactContent += `  zigma-flow reject --job ${jobId} --comment "reason"\n`;

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

  // 3. Set step status awaiting_human, job.status stays running
  await stateStore.updateState(runDir, (current) => ({
    ...current,
    last_event_id: eventId,
    jobs: {
      ...current.jobs,
      [jobId]: {
        ...current.jobs[jobId]!,
        status: "running",
        step_status: "awaiting_human",
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
 * - `"cli"` — local CLI command (`zigma-flow approve` / `reject`)
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

export async function recordHumanDecision(opts: RecordHumanDecisionOpts): Promise<void> {
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

  // 1. Validate step is awaiting_human
  if (jobState.step_status !== "awaiting_human") {
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

  // 2. Write human_decision_record artifact
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

  const decisionPath = join(stepDir, "human-decision.json");
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

  if (decision === "approved") {
    // approved → completed, advance job
    await stateStore.updateState(runDir, (current) => {
      const prevJob = current.jobs[jobId]!;
      const { step_status: _prevStepStatus, ...prevJobRest } = prevJob;
      return {
        ...current,
        last_event_id: eventId,
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

    await advanceJob({ runDir, runId, jobId, clock });
  } else {
    // rejected → failed
    await stateStore.updateState(runDir, (current) => {
      const prevJob = current.jobs[jobId]!;
      const { step_status: _prevStepStatus, ...prevJobRest } = prevJob;
      return {
        ...current,
        last_event_id: eventId,
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
  }
}
