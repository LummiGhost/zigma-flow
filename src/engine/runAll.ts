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

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

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
import { StateError, ValidationError } from "../utils/index.js";
import { advanceJob, createRun, executeCurrentStep } from "./index.js";

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

      // Resolve the agent backend (pass step-level backend name if declared)
      const backend = backendResolver(stepDef.backend as string | undefined);

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

      const result = await backend.execute({
        prompt: promptText,
        reportPath,
        stepDir,
        projectRoot: zigmaflowDir,
      });

      if (!result.success) {
        // Mark job as failed
        const failEventId = await nextSequentialEventId(runDir, eventWriter);

        const failEvent: ZigmaFlowEvent = {
          id: failEventId,
          type: "step_failed",
          run_id: runId,
          timestamp: clock.now(),
          producer: "engine",
          job: jobId,
          step: bundle.stepId,
          attempt,
          payload: {
            job_id: jobId,
            step_id: bundle.stepId,
            attempt,
            reason: result.error ?? "Agent backend failed",
          },
        };
        await eventWriter.appendEvent(runDir, failEvent);
        onEvent?.(failEvent);

        const failedState: RunState = {
          ...runningState,
          status: "failed",
          last_event_id: failEventId,
          jobs: {
            ...runningState.jobs,
            [jobId]: {
              ...runningState.jobs[jobId]!,
              status: "failed",
            },
          },
        };
        await stateStore.writeSnapshot(runDir, failedState);
        break;
      }

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
