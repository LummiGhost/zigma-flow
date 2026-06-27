/**
 * runAll — the Engine's main execution loop, extracted from the CLI shell.
 *
 * Creates or resumes a workflow run and drives it to completion (or until
 * maxIterations is reached). Handles agent, script, check, and router step
 * types through the appropriate engine entry points.
 *
 * Reference: docs/mvp-contracts.md §2.3, §2.4
 * docs/phases/p13-agent-adapter-hardening/workflows/wf-p13-engine-runall/
 * WF-P13-ENGINE-RUNALL Step 2.
 */

import { createHash } from "node:crypto";
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
import { recordAgentFailure } from "./recordAgentFailure.js";
import { appendArtifactIndex } from "../artifact/artifactIndex.js";
import { artifactId } from "../artifact/artifactMetadata.js";
import type { ArtifactMetadata } from "../artifact/artifactMetadata.js";

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
  } = opts;

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

  // ── 3. Main execution loop ─────────────────────────────────────────────

  let iteration = 0;
  let backendCache: { key: string; backend: AgentBackend } | undefined;

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

    // Find the first running job (multi-step continuation) or ready job
    const runningId = Object.entries(state.jobs).find(
      ([, js]) => js.status === "running",
    )?.[0];
    const readyId =
      runningId ??
      Object.entries(state.jobs).find(
        ([, js]) => js.status === "ready",
      )?.[0];

    if (readyId === undefined) {
      // No ready jobs — check if there are pending (waiting/inactive) jobs
      const pendingIds = Object.entries(state.jobs)
        .filter(
          ([, js]) => js.status === "waiting" || js.status === "inactive",
        )
        .map(([id]) => id);

      if (pendingIds.length === 0) {
        // All jobs accounted for — clean exit
        break;
      }

      // Pending jobs exist but none are ready — may indicate unsatisfied
      // dependencies or all-inactive workflows. Exit cleanly.
      break;
    }

    // Process one job per iteration
    const jobId = readyId;
    const jobDef = wf.jobs[jobId];
    if (jobDef === undefined) {
      continue;
    }

    const jobState = state.jobs[jobId];
    const stepId = jobState?.current_step ?? jobDef.steps[0]?.id;
    if (stepId === undefined) {
      continue;
    }

    const stepDef = jobDef.steps.find((s) => s.id === stepId);
    if (stepDef === undefined) {
      continue;
    }

    if (stepDef.type === "agent") {
      // ── Agent step path ──────────────────────────────────────────────

      // Build context (read-only — no disk writes)
      const bundle = await buildContext({
        runDir,
        zigmaflowDir,
        workflowDef: wf,
        state,
        jobId,
      });

      if (bundle.stepType !== "agent") {
        continue;
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
        payload: {
          job_id: jobId,
          step_id: bundle.stepId,
          prompt_artifact: artifactRef,
        },
      };
      await eventWriter.appendEvent(runDir, promptEvent);
      onEvent?.(promptEvent);

      // Transition job to running
      const runningState: RunState = {
        ...state,
        last_event_id: promptEventId,
        jobs: {
          ...state.jobs,
          [jobId]: {
            ...state.jobs[jobId]!,
            status: "running",
            current_step: bundle.stepId,
            attempt,
          },
        },
      };
      await stateStore.writeSnapshot(runDir, runningState);

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
          break;
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
        signal,
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
            payload: { reason: result.error ?? "Agent execution was cancelled." },
          };
          await eventWriter.appendEvent(runDir, runCancelledEvent);
          onEvent?.(runCancelledEvent);

          const cancelledState: RunState = {
            ...runningState,
            status: "cancelled",
            last_event_id: runCancelledEventId,
          };
          await stateStore.writeSnapshot(runDir, cancelledState);
          break;
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

        // Delegate retry/block/fail decision to recordAgentFailure
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
          iteration++;
          continue;
        }
        break;
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
        payload: {
          job_id: jobId,
          step_id: bundle.stepId,
          report_artifact: relative(runDir, reportPath).replace(/\\/g, "/"),
        },
      };
      await eventWriter.appendEvent(runDir, acceptedEvent);
      onEvent?.(acceptedEvent);

      // Write intermediate state snapshot with outputs stored
      const intermediateState: RunState = {
        ...runningState,
        last_event_id: acceptedEventId,
        jobs: {
          ...runningState.jobs,
          [jobId]: {
            ...runningState.jobs[jobId]!,
            outputs,
          },
        },
      };
      await stateStore.writeSnapshot(runDir, intermediateState);

      // Advance the job if the agent signals completion via outputs.completed
      if (outputs.completed === true) {
        await advanceJob({ runDir, runId, jobId, clock });
      }
      // Otherwise the agent has not completed — job stays in "running" state
      // and will be re-processed on the next loop iteration.
    } else if (
      stepDef.type === "script" ||
      stepDef.type === "check" ||
      stepDef.type === "router"
    ) {
      // ── Script/check/router step path ────────────────────────────────

      // Ensure job is ready or running before execution
      const currentJobState = state.jobs[jobId];
      if (
        currentJobState?.status !== "ready" &&
        currentJobState?.status !== "running"
      ) {
        continue;
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
    } else {
      // Skip unsupported step types (workflow, human — MVP-reserved)
      continue;
    }

    // Count this iteration — a job was found and processed
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
