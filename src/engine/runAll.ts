/**
 * runAll — the Engine's main execution loop, extracted from the CLI shell.
 *
 * Creates or resumes a workflow run and drives it to completion (or until
 * maxIterations is reached). Handles agent, script, check, and router step
 * types through the appropriate engine entry points.
 *
 * P14: Main loop refactored from sequential (one-job-per-iteration) to
 * scheduler-driven concurrent batch execution using Promise.allSettled.
 *
 * Reference: docs/mvp-contracts.md §2.3, §2.4
 * docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-engine-runall/
 * WF-P13-ENGINE-RUNALL Step 2.
 * docs/phases/p14-concurrent-execution/02-development-plan.md
 * AD-P14-004 (loop), AD-P14-005 (fail-fast), AD-P14-006 (events).
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import type { AgentBackend } from "../agent/index.js";
import { buildContext } from "../context/index.js";
import type { ZigmaFlowEvent } from "../events/index.js";
import { nextSequentialEventId } from "../events/sequence.js";
import {
  buildPromptPacket,
  renderPromptPacket,
  writePromptArtifact,
} from "../prompt/index.js";
import type { Clock, RunState } from "../run/index.js";
import {
  JsonlEventWriter,
  LocalStateStore,
  SystemClock,
} from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import {
  ConfigError,
  PermissionError,
  StateError,
  ValidationError,
} from "../utils/index.js";
import { advanceJob, createRun, executeCurrentStep } from "./index.js";
import { enterHumanGate } from "./humanGate.js";
import { recordAgentFailure } from "./recordAgentFailure.js";
import { appendArtifactIndex } from "../artifact/artifactIndex.js";
import { artifactId } from "../artifact/artifactMetadata.js";
import type { ArtifactMetadata } from "../artifact/artifactMetadata.js";
import { selectExecutable } from "./scheduler.js";
import type { ExecutableBatch } from "./scheduler.js";

/** Fallback timeout when backend does not expose a timeout value. */
const DEFAULT_BACKEND_TIMEOUT = 600_000;

/**
 * Register a single step artifact in the artifact index.
 * Returns the relative POSIX path if successful, or undefined if the file is missing.
 */
async function registerStepArtifact(
  runDir: string,
  runId: string,
  jobId: string,
  stepId: string,
  attempt: number,
  filePath: string | undefined,
  kind: string,
  contentType: string,
  clock: Clock,
): Promise<string | undefined> {
  if (!filePath) return undefined;

  try {
    const stats = await stat(filePath);
    const relPath = relative(runDir, filePath).replace(/\\/g, "/");
    const filename = basename(filePath);

    const metadata: ArtifactMetadata = {
      id: artifactId(runId, jobId, attempt, stepId, filename),
      run_id: runId,
      producer: { job: jobId, step: stepId, attempt },
      kind,
      path: relPath,
      content_type: contentType,
      size: stats.size,
      summary: "",
      created_at: clock.now(),
    };

    await appendArtifactIndex(runDir, metadata);
    return relPath;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// classifyError — classify an agent failure result into a retry category
// ---------------------------------------------------------------------------

/**
 * Classify the error type from an AgentExecuteResult for use with
 * recordAgentFailure. Pure string-matching on `result.error`.
 *
 * - "ConfigError" or "not configured" → "config"
 * - "PermissionError" or "not logged in" or "401" or "403" → "permission"
 * - "timed out" or "timeout" → "timeout"
 * - Otherwise → "execution"
 */
export function classifyError(result: {
  error?: string;
}): "config" | "permission" | "timeout" | "execution" {
  const msg = (result.error ?? "").toLowerCase();

  if (
    msg.includes("configerror") ||
    msg.includes("not configured")
  ) {
    return "config";
  }

  if (
    msg.includes("permissionerror") ||
    msg.includes("not logged in") ||
    msg.includes("401") ||
    msg.includes("403")
  ) {
    return "permission";
  }

  if (msg.includes("timed out") || msg.includes("timeout")) {
    return "timeout";
  }

  return "execution";
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RunAllOpts {
  /** Task description — triggers createRun (mutually exclusive with runId). */
  task?: string;
  /** Existing run ID to resume (mutually exclusive with task). */
  runId?: string;
  /** Absolute path to the workflow YAML file. */
  workflowPath: string;
  /** Directory containing run subdirectories (e.g. <project>/.zigma-flow/runs). */
  runsDir: string;
  /** Project root / zigmaflow root directory. */
  zigmaflowDir: string;
  /** Path to skill-lock.json. */
  skillLockPath: string;
  /**
   * Resolver that returns an AgentBackend for a given step-level backend name.
   * Called with `undefined` when no step-level backend is declared — the
   * resolver should return the default backend.
   */
  backendResolver: (stepBackendName?: string) => AgentBackend;
  /** Injectable clock (defaults to SystemClock). */
  clock?: Clock;
  /** Optional AbortSignal for cancellation support. */
  signal?: AbortSignal;
  /** Maximum loop iterations (defaults to 100). */
  maxIterations?: number;
  /** Callback fired for each event emitted during the loop. */
  onEvent?: (e: ZigmaFlowEvent) => void;
  /** Injectable state store (defaults to LocalStateStore). */
  stateStore?: LocalStateStore;
  /** Injectable event writer (defaults to JsonlEventWriter). */
  eventWriter?: JsonlEventWriter;
  /**
   * Maximum concurrent job count (AD-P14-007).
   * Defaults to 4 when not specified.
   */
  parallelism?: number;
  /**
   * Enable fail-fast abort propagation (AD-P14-005).
   * When true, a single job failure in a batch aborts all other jobs in the
   * same batch. Defaults to false.
   */
  failFast?: boolean;
}

export interface RunAllSummary {
  /** The run identifier. */
  runId: string;
  /** Final run status (undefined if maxIterations was reached). */
  status?: string;
  /** Per-job summary entries. */
  jobs: Array<{ id: string; status: string; attempts: number }>;
  /** Number of loop iterations completed. */
  iterations: number;
}

// ---------------------------------------------------------------------------
// JobStepResult — per-job execution result within a batch
// ---------------------------------------------------------------------------

export interface JobStepResult {
  jobId: string;
  success: boolean;
  action: "completed" | "retried" | "failed" | "cancelled" | "blocked" | "skipped";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Internal: getJobMode — derive "read-only" | "writable" from workflow def
// ---------------------------------------------------------------------------

function getJobMode(
  jobId: string,
  workflow: import("../workflow/index.js").WorkflowDefinition,
): "read-only" | "writable" {
  const jobDef = workflow.jobs[jobId];
  if (!jobDef) return "writable";
  const workspace = jobDef.workspace;
  if (!workspace) return "writable";
  return workspace.mode === "read-only" ? "read-only" : "writable";
}

// ---------------------------------------------------------------------------
// Internal: ExecuteJobOnceCtx — context for a single job-step execution
// ---------------------------------------------------------------------------

interface ExecuteJobOnceCtx {
  runDir: string;
  runId: string;
  zigmaflowDir: string;
  jobId: string;
  wf: import("../workflow/index.js").WorkflowDefinition;
  state: RunState;
  backendResolver: (stepBackendName?: string) => AgentBackend;
  stateStore: LocalStateStore;
  eventWriter: JsonlEventWriter;
  clock: Clock;
  signal: AbortSignal | undefined;
  batchId: string;
  onEvent: ((e: ZigmaFlowEvent) => void) | undefined;
}

// ---------------------------------------------------------------------------
// executeJobOnce — process ONE step for ONE job (AD-P14-004)
//
// Handles agent, script, check, and router step types. Returns a structured
// result so the batch loop can make post-batch decisions (fail-fast, etc.).
// Does NOT manage loop control — that is runAll's responsibility.
// ---------------------------------------------------------------------------

let backendCache: { key: string; backend: AgentBackend } | undefined;

async function executeJobOnce(
  ctx: ExecuteJobOnceCtx,
): Promise<JobStepResult> {
  const {
    runDir,
    runId,
    zigmaflowDir,
    jobId,
    wf,
    state,
    backendResolver,
    stateStore,
    eventWriter,
    clock,
    signal,
    batchId,
    onEvent,
  } = ctx;

  const jobDef = wf.jobs[jobId];
  if (jobDef === undefined) {
    return { jobId, success: false, action: "blocked", detail: "Job not found in workflow definition" };
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    return { jobId, success: false, action: "blocked", detail: "Job not found in run state" };
  }

  const stepId = jobState.current_step ?? jobDef.steps[0]?.id;
  if (stepId === undefined) {
    return { jobId, success: false, action: "blocked", detail: "No steps defined for job" };
  }

  const stepDef = jobDef.steps.find((s) => s.id === stepId);
  if (stepDef === undefined) {
    return { jobId, success: false, action: "blocked", detail: `Step "${stepId}" not found` };
  }

  if (stepDef.type === "agent") {
    return executeAgentStep({
      runDir, runId, zigmaflowDir, jobId, wf, state,
      backendResolver, stateStore, eventWriter, clock,
      signal, batchId, onEvent, stepDef, stepId,
    });
  }

  if (
    stepDef.type === "script" ||
    stepDef.type === "check" ||
    stepDef.type === "router"
  ) {
    return executeNonAgentStep({
      runDir, runId, zigmaflowDir, jobId, wf, state,
      backendResolver, stateStore, eventWriter, clock,
      signal, batchId, onEvent,
      stepDef, stepId,
    });
  }

  if (stepDef.type === "human") {
    return executeHumanStep({
      runDir, runId, jobId, wf, state,
      stateStore, eventWriter, clock,
      stepDef, stepId,
    });
  }

  return { jobId, success: false, action: "skipped", detail: `Unsupported step type: ${stepDef.type}` };
}

// ---------------------------------------------------------------------------
// executeAgentStep — full agent step lifecycle (prompt → invoke → result)
// ---------------------------------------------------------------------------

interface StepCtx extends ExecuteJobOnceCtx {
  stepDef: import("../workflow/index.js").StepDefinition;
  stepId: string;
}

async function executeAgentStep(ctx: StepCtx): Promise<JobStepResult> {
  const {
    runDir, runId, zigmaflowDir, jobId, wf, state,
    backendResolver, stateStore, eventWriter, clock,
    signal, batchId, onEvent, stepDef, stepId,
  } = ctx;

  // Build context (read-only — no disk writes)
  let bundle: Awaited<ReturnType<typeof buildContext>>;
  try {
    bundle = await buildContext({
      runDir,
      zigmaflowDir,
      workflowDef: wf,
      state,
      jobId,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Fail the job explicitly with a clear error message
    await recordAgentFailure({
      runDir,
      runId,
      jobId,
      stepId: stepId,
      attempt: state.jobs[jobId]?.attempt ?? 1,
      reason: `Context build failed: ${errorMsg}`,
      errorType: "config",
      clock,
      stateStore,
      eventWriter,
    });
    return { jobId, success: false, action: "failed", detail: `Context build failed: ${errorMsg}` };
  }

  if (bundle.stepType !== "agent") {
    return { jobId, success: false, action: "blocked", detail: "Step type mismatch in buildContext" };
  }

  const attempt = state.jobs[jobId]?.attempt ?? 1;

  // Build and write prompt artifact
  const packet = buildPromptPacket(bundle);
  const rendered = renderPromptPacket(packet, {
    supportsSystemPrompt: true,
  });
  const promptText = rendered.markdown;

  const { artifactRef } = await writePromptArtifact({
    runDir,
    runId,
    jobId,
    stepId: bundle.stepId,
    attempt,
    prompt: promptText,
    packet,
    clock,
  });

  // Emit prompt_generated event
  const promptEventId = await nextSequentialEventId(runDir, eventWriter);

  const promptEvent: ZigmaFlowEvent = {
    id: promptEventId,
    type: "prompt_generated",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: bundle.stepId,
    attempt,
    batch_id: batchId,
    payload: {
      job_id: jobId,
      step_id: bundle.stepId,
      prompt_artifact: artifactRef,
    },
  };
  await eventWriter.appendEvent(runDir, promptEvent);
  onEvent?.(promptEvent);

  // Transition job to running (atomic within queue — AD-P14-003)
  await stateStore.updateState(runDir, (current) => ({
    ...current,
    last_event_id: promptEventId,
    jobs: {
      ...current.jobs,
      [jobId]: {
        ...current.jobs[jobId]!,
        status: "running",
        current_step: bundle.stepId,
        attempt,
      },
    },
  }));

  // Resolve the agent backend (cached per job+step for retry continuity)
  let backend: AgentBackend;
  const cacheKey = `${jobId}::${stepDef.backend ?? ""}`;
  if (backendCache === undefined || backendCache.key !== cacheKey) {
    try {
      const bk = backendResolver(stepDef.backend as string | undefined);
      backendCache = { key: cacheKey, backend: bk };
      backend = bk;
    } catch (err) {
      if (err instanceof ConfigError || err instanceof PermissionError) {
        const errorType = err instanceof ConfigError ? "config" : "permission";
        await recordAgentFailure({
          runDir,
          runId,
          jobId,
          stepId: bundle.stepId,
          attempt,
          reason: err.message,
          errorType,
          clock,
          stateStore,
          eventWriter,
        });
      }
      return { jobId, success: false, action: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
  } else {
    backend = backendCache.backend;
  }

  // Compute args_hash before execution (prompt MUST NOT be included in hash)
  const argsHashInput = [
    backend.backendCommand ?? "",
    ...(backend.backendArgs ?? []),
  ].join(" ");
  const argsHash = createHash("sha256")
    .update(argsHashInput)
    .digest("hex");

  // Invoke agent backend
  const stepDir = join(
    runDir,
    "jobs",
    jobId,
    "attempts",
    String(attempt),
    "steps",
    bundle.stepId,
  );
  const reportPath = join(stepDir, "report.json");

  // Emit agent_invoked event before backend.execute
  const invokedEventId = await nextSequentialEventId(runDir, eventWriter);
  const invokedEvent: ZigmaFlowEvent = {
    id: invokedEventId,
    type: "agent_invoked",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: bundle.stepId,
    attempt,
    batch_id: batchId,
    payload: {
      backend_name: backend.name,
      command: backend.backendCommand ?? backend.name,
      args_hash: argsHash,
      timeout_ms: backend.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT,
      step_artifact_dir: relative(runDir, stepDir).replace(/\\/g, "/"),
    },
  };
  await eventWriter.appendEvent(runDir, invokedEvent);
  onEvent?.(invokedEvent);

  const result = await backend.execute({
    prompt: promptText,
    reportPath,
    stepDir,
    projectRoot: zigmaflowDir,
    ...(signal !== undefined ? { signal } : {}),
  });

  if (!result.success) {
    // ── Agent failure path ─────────────────────────────────────────

    // Determine failure mode
    const isCancelled = signal?.aborted === true;

    if (isCancelled) {
      // ── Agent cancelled path ──────────────────────────────────────
      const cancelledEventId = await nextSequentialEventId(runDir, eventWriter);
      const cancelledEvent: ZigmaFlowEvent = {
        id: cancelledEventId,
        type: "agent_cancelled",
        run_id: runId,
        timestamp: clock.now(),
        producer: "engine",
        job: jobId,
        step: bundle.stepId,
        attempt,
        batch_id: batchId,
        payload: {
          duration_ms: result.durationMs ?? 0,
          reason: result.error ?? "Agent execution was cancelled.",
        },
      };
      await eventWriter.appendEvent(runDir, cancelledEvent);
      onEvent?.(cancelledEvent);

      // Write run_cancelled event
      const runCancelledEventId = await nextSequentialEventId(runDir, eventWriter);
      const runCancelledEvent: ZigmaFlowEvent = {
        id: runCancelledEventId,
        type: "run_cancelled",
        run_id: runId,
        timestamp: clock.now(),
        producer: "engine",
        job: jobId,
        step: bundle.stepId,
        attempt,
        batch_id: batchId,
        payload: { reason: result.error ?? "Agent execution was cancelled." },
      };
      await eventWriter.appendEvent(runDir, runCancelledEvent);
      onEvent?.(runCancelledEvent);

      await stateStore.updateState(runDir, (current) => ({
        ...current,
        status: "cancelled",
        last_event_id: runCancelledEventId,
      }));
      return { jobId, success: false, action: "cancelled", detail: result.error ?? "cancelled" };
    }

    // Register artifacts for timeout/failure paths
    const failStdoutArtifact = await registerStepArtifact(
      runDir, runId, jobId, bundle.stepId, attempt,
      result.stdoutPath, "agent_stdout", "text/plain", clock,
    );
    const failStderrArtifact = await registerStepArtifact(
      runDir, runId, jobId, bundle.stepId, attempt,
      result.stderrPath, "agent_stderr", "text/plain", clock,
    );

    const terminalEventId = await nextSequentialEventId(runDir, eventWriter);

    const isTimeout = (result.error ?? "").toLowerCase().includes("timed out");

    if (isTimeout) {
      const timeoutEvent: ZigmaFlowEvent = {
        id: terminalEventId,
        type: "agent_timed_out",
        run_id: runId,
        timestamp: clock.now(),
        producer: "engine",
        job: jobId,
        step: bundle.stepId,
        attempt,
        batch_id: batchId,
        payload: {
          duration_ms: result.durationMs ?? 0,
          timeout_ms: backend.backendTimeoutMs ?? result.durationMs ?? 0,
          ...(failStdoutArtifact !== undefined ? { stdout_artifact: failStdoutArtifact } : {}),
          ...(failStderrArtifact !== undefined ? { stderr_artifact: failStderrArtifact } : {}),
        },
      };
      await eventWriter.appendEvent(runDir, timeoutEvent);
      onEvent?.(timeoutEvent);
    } else {
      // Register invocation artifact for failure (not available on timeout)
      const failInvocationArtifact = await registerStepArtifact(
        runDir, runId, jobId, bundle.stepId, attempt,
        result.invocationPath, "agent_invocation", "application/json", clock,
      );

      const failedEvent: ZigmaFlowEvent = {
        id: terminalEventId,
        type: "agent_failed",
        run_id: runId,
        timestamp: clock.now(),
        producer: "engine",
        job: jobId,
        step: bundle.stepId,
        attempt,
        batch_id: batchId,
        payload: {
          duration_ms: result.durationMs ?? 0,
          exit_code: result.exitCode ?? 1,
          reason: result.error ?? "Agent backend failed",
          ...(failStdoutArtifact !== undefined ? { stdout_artifact: failStdoutArtifact } : {}),
          ...(failStderrArtifact !== undefined ? { stderr_artifact: failStderrArtifact } : {}),
        },
      };
      await eventWriter.appendEvent(runDir, failedEvent);
      onEvent?.(failedEvent);
    }

    // Delegate retry/block/fail decision to recordAgentFailure.
    // IMPORTANT: agent_cancelled with reason="fail_fast" does NOT enter
    // recordAgentFailure. Only agent_failed goes through retry (AD-P14-005).
    const errorType = classifyError(result);
    const failureResult = await recordAgentFailure({
      runDir,
      runId,
      jobId,
      stepId: bundle.stepId,
      attempt,
      reason: result.error ?? "Agent backend failed",
      errorType,
      clock,
      stateStore,
      eventWriter,
    });

    if (failureResult.action === "retried") {
      return { jobId, success: false, action: "retried", detail: `Retrying job (attempt ${attempt + 1})` };
    }

    const action = failureResult.action === "run_failed" ? "failed" : (failureResult.action as JobStepResult["action"]);
    return { jobId, success: false, action, detail: result.error ?? "Agent backend failed" };
  }

  // ── Agent success path ──────────────────────────────────────────────

  // Register artifacts for the successful execution
  const successStdoutArtifact = await registerStepArtifact(
    runDir, runId, jobId, bundle.stepId, attempt,
    result.stdoutPath, "agent_stdout", "text/plain", clock,
  );
  const successStderrArtifact = await registerStepArtifact(
    runDir, runId, jobId, bundle.stepId, attempt,
    result.stderrPath, "agent_stderr", "text/plain", clock,
  );
  const successInvocationArtifact = await registerStepArtifact(
    runDir, runId, jobId, bundle.stepId, attempt,
    result.invocationPath, "agent_invocation", "application/json", clock,
  );

  // Emit agent_completed event
  const completedEventId = await nextSequentialEventId(runDir, eventWriter);
  const completedEvent: ZigmaFlowEvent = {
    id: completedEventId,
    type: "agent_completed",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: bundle.stepId,
    attempt,
    batch_id: batchId,
    payload: {
      duration_ms: result.durationMs ?? 0,
      ...(successStdoutArtifact !== undefined ? { stdout_artifact: successStdoutArtifact } : {}),
      ...(successStderrArtifact !== undefined ? { stderr_artifact: successStderrArtifact } : {}),
      ...(successInvocationArtifact !== undefined ? { invocation_artifact: successInvocationArtifact } : {}),
    },
  };
  await eventWriter.appendEvent(runDir, completedEvent);
  onEvent?.(completedEvent);

  // Read and process the agent report inline.
  // runAll handles report acceptance directly rather than delegating to
  // acceptAgentReport so that the loop can decide when to advance based
  // on the agent's reported outputs.
  const reportRaw = await readFile(reportPath, "utf-8");
  const report = JSON.parse(reportRaw) as {
    outputs?: Record<string, unknown>;
    signals?: Array<{ type: string; reason?: string }>;
    artifacts?: string[];
    summary?: string;
  };

  const outputs =
    typeof report.outputs === "object" && report.outputs !== null
      ? (report.outputs as Record<string, unknown>)
      : {};
  const signals = Array.isArray(report.signals) ? report.signals : [];

  // Emit agent_report_accepted event
  const acceptedEventId = await nextSequentialEventId(runDir, eventWriter);
  const acceptedEvent: ZigmaFlowEvent = {
    id: acceptedEventId,
    type: "agent_report_accepted",
    run_id: runId,
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: bundle.stepId,
    attempt,
    batch_id: batchId,
    payload: {
      job_id: jobId,
      step_id: bundle.stepId,
      report_artifact: relative(runDir, reportPath).replace(/\\/g, "/"),
    },
  };
  await eventWriter.appendEvent(runDir, acceptedEvent);
  onEvent?.(acceptedEvent);

  // Write intermediate state snapshot with outputs stored (atomic within queue — AD-P14-003)
  await stateStore.updateState(runDir, (current) => ({
    ...current,
    last_event_id: acceptedEventId,
    jobs: {
      ...current.jobs,
      [jobId]: {
        ...current.jobs[jobId]!,
        outputs,
      },
    },
  }));

  // Advance the job if the agent signals completion via outputs.completed
  if (outputs.completed === true) {
    await advanceJob({ runDir, runId, jobId, clock });
  }
  // Otherwise the agent has not completed — job stays in "running" state
  // and will be re-processed on the next loop iteration.

  return { jobId, success: true, action: "completed" };
}

// ---------------------------------------------------------------------------
// executeNonAgentStep — script/check/router step lifecycle
// ---------------------------------------------------------------------------

async function executeNonAgentStep(ctx: StepCtx): Promise<JobStepResult> {
  const {
    runDir, runId, zigmaflowDir, jobId, wf, state,
    stateStore, eventWriter, clock, batchId, onEvent,
    stepDef, stepId,
  } = ctx;

  // Ensure job is ready or running before execution
  const currentJobState = state.jobs[jobId];
  if (
    currentJobState?.status !== "ready" &&
    currentJobState?.status !== "running"
  ) {
    return { jobId, success: false, action: "blocked", detail: `Job status is "${currentJobState?.status}", not "ready" or "running"` };
  }

  await executeCurrentStep({
    runDir,
    zigmaflowDir,
    runId,
    jobId,
    clock,
  });

  // Check if job needs advancing (multi-step jobs)
  const postState = await stateStore.readSnapshot(runDir);
  if (postState !== null) {
    const postJobState = postState.jobs[jobId];
    if (postJobState?.status === "running") {
      await advanceJob({ runDir, runId, jobId, clock });
    }
  }

  return { jobId, success: true, action: "completed" };
}

// ---------------------------------------------------------------------------
// executeHumanStep — human gate step lifecycle (WF-P15-ENGINE, AD-P15-003)
// ---------------------------------------------------------------------------

interface HumanStepCtx {
  runDir: string;
  runId: string;
  jobId: string;
  wf: import("../workflow/index.js").WorkflowDefinition;
  state: RunState;
  stateStore: LocalStateStore;
  eventWriter: JsonlEventWriter;
  clock: Clock;
  stepDef: import("../workflow/index.js").StepDefinition;
  stepId: string;
}

async function executeHumanStep(ctx: HumanStepCtx): Promise<JobStepResult> {
  const {
    runDir, runId, jobId, state,
    stateStore, eventWriter, clock,
    stepDef, stepId,
  } = ctx;

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    return { jobId, success: false, action: "blocked", detail: "Job not found in run state" };
  }

  // Idempotent: if already awaiting_human, no-op
  if (jobState.step_status === "awaiting_human") {
    return { jobId, success: true, action: "completed", detail: "awaiting_human" };
  }

  const prompt = stepDef.prompt;
  if (prompt === undefined || prompt.trim().length === 0) {
    return { jobId, success: false, action: "failed", detail: "Human step missing prompt" };
  }

  await enterHumanGate({
    runDir,
    runId,
    jobId,
    stepId,
    clock,
    stepPrompt: prompt,
    ...(stepDef.approvers !== undefined ? { stepApprovers: stepDef.approvers } : {}),
    ...(stepDef.instructions !== undefined ? { stepInstructions: stepDef.instructions } : {}),
    stateStore,
    eventWriter,
  });

  return { jobId, success: true, action: "completed", detail: "awaiting_human" };
}

// ---------------------------------------------------------------------------
// runAll
// ---------------------------------------------------------------------------

/**
 * Run a workflow to completion.
 *
 * If `task` is provided a new run is created via `createRun`. If `runId` is
 * provided the function resumes an existing run by reading its state. Exactly
 * one of `task` or `runId` must be set.
 */
export async function runAll(opts: RunAllOpts): Promise<RunAllSummary> {
  const {
    task,
    runId: existingRunId,
    workflowPath,
    runsDir,
    zigmaflowDir,
    skillLockPath,
    backendResolver,
    clock = new SystemClock(),
    signal,
    maxIterations = 100,
    onEvent,
    stateStore = new LocalStateStore(),
    eventWriter = new JsonlEventWriter(),
    parallelism: rawParallelism,
    failFast = false,
  } = opts;

  // Clamp parallelism to at least 1
  const parallelism = Math.max(1, rawParallelism ?? 4);

  // ── Validate: exactly one of task or runId ─────────────────────────────

  if ((task === undefined) === (existingRunId === undefined)) {
    throw new ValidationError(
      "Exactly one of 'task' or 'runId' must be provided to runAll",
      { details: { task, runId: existingRunId } },
    );
  }

  // ── 1. Create or resume run ───────────────────────────────────────────

  let runId: string;

  if (task !== undefined) {
    const result = await createRun({
      workflowPath,
      task,
      runsDir,
      skillLockPath,
      clock,
    });
    runId = result.runId;
  } else {
    runId = existingRunId!;
  }

  const runDir = join(runsDir, runId);

  // ── 2. Load workflow definition (needed for step type resolution) ──────

  const wf = await loadWorkflowFile(workflowPath);

  // ── 3. Main execution loop (concurrent batch, AD-P14-004) ──────────────

  let iteration = 0;
  // Reset module-level backendCache for fresh execution/resume
  backendCache = undefined;

  while (iteration < maxIterations) {
    // Check abort signal
    if (signal?.aborted) {
      break;
    }

    // Read current state snapshot
    const state = await stateStore.readSnapshot(runDir);
    if (state === null) {
      throw new StateError(`state.json missing for run ${runId}`);
    }

    // Check terminal run states
    if (
      state.status === "completed" ||
      state.status === "failed" ||
      state.status === "blocked" ||
      state.status === "cancelled"
    ) {
      break;
    }

    // ── Scheduler-based batch selection ──────────────────────────────────

    const batch = selectExecutable({
      state,
      workflow: wf,
      config: { parallelism, runningWritableLimit: 1 },
    });

    // ── Fallback: include running jobs (multi-step continuation) ─────────
    // The scheduler only picks "ready" jobs. Jobs in "running" state (from
    // a previous batch where the agent did not signal completion) must be
    // re-processed for continuation.
    const runningJobs = Object.entries(state.jobs)
      .filter(([, js]) => js.status === "running")
      .map(([id]) => id);

    const jobsToRun: Array<{ jobId: string; mode: "read-only" | "writable" }> = [...batch.jobs];

    if (jobsToRun.length === 0 && runningJobs.length > 0) {
      for (const jid of runningJobs) {
        jobsToRun.push({ jobId: jid, mode: getJobMode(jid, wf) });
      }
    }

    if (jobsToRun.length === 0) {
      // No ready or running jobs — check if there are pending (waiting/inactive) jobs
      const hasPending = Object.values(state.jobs).some(
        (js) => js.status === "waiting" || js.status === "inactive",
      );

      if (!hasPending) {
        // All jobs accounted for — clean exit
        break;
      }

      // Pending jobs exist but none are ready — may indicate unsatisfied
      // dependencies or all-inactive workflows. Exit cleanly.
      break;
    }

    // ── Create batch ID for event correlation (AD-P14-006) ───────────────

    const batchId = randomUUID();

    // ── Create per-job AbortControllers for fail-fast (AD-P14-005) ───────

    const jobControllers = new Map<string, AbortController>();
    for (const j of jobsToRun) {
      // Merge external signal with per-job controller
      const ctrl = new AbortController();
      jobControllers.set(j.jobId, ctrl);

      // Forward external abort to per-job controller
      if (signal !== undefined) {
        signal.addEventListener("abort", () => ctrl.abort(), { once: true });
      }
    }

    // ── Execute batch concurrently via Promise.allSettled ────────────────

    const jobPromises = jobsToRun.map((j) =>
      executeJobOnce({
        runDir,
        runId,
        zigmaflowDir,
        jobId: j.jobId,
        wf,
        state,
        backendResolver,
        stateStore,
        eventWriter,
        clock,
        signal: jobControllers.get(j.jobId)?.signal,
        batchId,
        onEvent,
      }),
    );

    // ── Fail-fast: abort peer jobs on first failure (AD-P14-005) ─────────

    if (failFast && jobsToRun.length > 1) {
      let failFastTriggered = false;

      for (const p of jobPromises) {
        p.then((r) => {
          if (!r.success && !failFastTriggered) {
            failFastTriggered = true;
            // Abort all jobs EXCEPT the failing one
            for (const [fid, fc] of jobControllers) {
              if (fid !== r.jobId) {
                fc.abort();
              }
            }
          }
        }).catch(() => {
          if (!failFastTriggered) {
            failFastTriggered = true;
            for (const [, fc] of jobControllers) {
              fc.abort();
            }
          }
        });
      }
    }

    // Wait for all jobs in the batch to settle
    const settled = await Promise.allSettled(jobPromises);

    // ── Post-batch: human gate check (WF-P15-ENGINE, AD-P15-007) ─────────

    // If any job entered awaiting_human, break the loop so the user can act.
    const postBatchState = await stateStore.readSnapshot(runDir);
    if (postBatchState !== null) {
      const awaitingHumanJobs = Object.entries(postBatchState.jobs)
        .filter(([, js]) => js.step_status === "awaiting_human");

      if (awaitingHumanJobs.length > 0) {
        // Print human gate instructions to console
        const [hjId, hjState] = awaitingHumanJobs[0]!;
        console.log();
        console.log(`Run ${runId} paused on human gate.`);
        console.log(`  Job: ${hjId} / Step: ${hjState.current_step ?? "?"}`);
        console.log();
        console.log("To approve:");
        console.log(`  zigma-flow approve --job ${hjId} --comment "..."`);
        console.log();
        console.log("To reject and retry:");
        console.log(`  zigma-flow reject --job ${hjId} --comment "..."`);
        console.log();
        console.log(`Then resume:`);
        console.log(`  zigma-flow run-all <workflow> --resume ${runId}`);
        console.log();
        break;
      }
    }

    // ── Post-batch: re-read fresh state (AD-P14-004) ─────────────────────

    // State is re-read at the top of the next iteration via stateStore.readSnapshot.
    // No additional work needed here since executeJobOnce handles all state writes.

    iteration++;
  }

  // ── 4. Build summary from final state ──────────────────────────────────

  const finalState = await stateStore.readSnapshot(runDir);
  const jobs = Object.entries(finalState?.jobs ?? {}).map(([id, js]) => ({
    id,
    status: js.status,
    attempts: js.attempt ?? 1,
  }));

  return {
    runId,
    ...(finalState?.status !== undefined ? { status: finalState.status } : {}),
    jobs,
    iterations: iteration,
  };
}
