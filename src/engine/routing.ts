/**
 * applyRoutingAction — signal-handler entry point for WF-P8-SIGNALS.
 *
 * Maps a RouterAction (sourced from a router step's cases, a script
 * step's on_failure, or a check step's on_fail / on_pass) into the
 * corresponding job-status transition plus event emissions.
 *
 * Extracted to a separate file to avoid a circular import between
 * src/engine/index.ts (which imports script/executor and check/executor)
 * and those executors (which delegate to applyRoutingAction).
 *
 * Reference: docs/phases/p8-router-and-signals/workflows/wf-p8-signals/
 *   docs/mvp-contracts.md §2.3, §2.4
 */

import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import { computeReadyJobs } from "../dag/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import type { RouterAction } from "../workflow/index.js";
import { nextEventId as formatEventId } from "../events/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import { StateError, WorkflowError } from "../utils/index.js";
import { createOpenAttempt } from "./attemptModel.js";
import { createImplicitGroup, startNextIteration } from "./jobGroupModel.js";

// ---------------------------------------------------------------------------
// ApplyRoutingActionOpts
// ---------------------------------------------------------------------------

export interface ApplyRoutingActionOpts {
  runDir: string;
  runId: string;
  sourceJobId: string;
  sourceStepId: string;
  attempt: number;
  action: RouterAction;
  reason: string;
  clock: Clock;
  /**
   * Optional override for the `signal` field in the `signal_received` event payload.
   * When provided (e.g. from acceptAgentReport), the workflow signal type name is used
   * instead of the action discriminator. (WF-P9-ACCEPT)
   */
  signalName?: string;
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
// applyRoutingAction
// ---------------------------------------------------------------------------

export async function applyRoutingAction(opts: ApplyRoutingActionOpts): Promise<void> {
  const { runDir, runId, sourceJobId, sourceStepId, attempt, action, reason, clock, signalName } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read state snapshot — throw StateError if missing ─────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  // ── 2. Validate sourceJobId exists in state.jobs ──────────────────────────

  const sourceJobState = state.jobs[sourceJobId];
  if (sourceJobState === undefined) {
    throw new StateError(`Job "${sourceJobId}" not found in state for run ${runId}`);
  }

  // ── 3. Load workflow for target validation (for object-form actions) ──────

  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  // ── 4. Validate object-form action targets before any events ─────────────
  //
  // Per T-SIGNALS-10/11/12: WorkflowError MUST be thrown before any event.

  if (typeof action === "object" && action !== null) {
    let targetJobId: string | undefined;

    if ("retry_job" in action) {
      targetJobId = action.retry_job;
    } else if ("activate_job" in action) {
      targetJobId = action.activate_job;
      // activate_job: validate target exists
      if (wf.jobs[targetJobId] === undefined) {
        throw new WorkflowError(
          `activate_job target "${targetJobId}" does not exist in workflow`,
          { details: { sourceJobId, targetJobId } }
        );
      }
      // activate_job: validate target is an optional (activation-declared) job
      if (wf.jobs[targetJobId]!.activation === undefined) {
        throw new WorkflowError(
          `activate_job target "${targetJobId}" is a required job (no activation declaration)`,
          { details: { sourceJobId, targetJobId } }
        );
      }
    } else if ("goto_job" in action) {
      targetJobId = action.goto_job;
      if (wf.jobs[targetJobId] === undefined) {
        throw new WorkflowError(
          `goto_job target "${targetJobId}" does not exist in workflow`,
          { details: { sourceJobId, targetJobId } }
        );
      }
    }

    // For retry_job: validate target exists in workflow
    if ("retry_job" in action && targetJobId !== undefined) {
      if (wf.jobs[targetJobId] === undefined) {
        throw new WorkflowError(
          `retry_job target "${targetJobId}" does not exist in workflow`,
          { details: { sourceJobId, targetJobId } }
        );
      }
    }
  }

  // ── 5. Legality check: source job in terminal state + action not retry ─────
  //
  // completed/failed/blocked can only be recovered from via retry_job.

  const isTerminalStatus =
    sourceJobState.status === "completed" ||
    sourceJobState.status === "failed" ||
    sourceJobState.status === "blocked";

  const isRetryAction =
    typeof action === "object" && action !== null && "retry_job" in action;

  if (isTerminalStatus && !isRetryAction) {
    throw new WorkflowError(
      `Cannot apply action "${actionDiscriminator(action)}" to job "${sourceJobId}" in terminal state "${sourceJobState.status}"`,
      { details: { sourceJobId, status: sourceJobState.status, action: actionDiscriminator(action) } }
    );
  }

  // ── 6. Append signal_received event ──────────────────────────────────────

  const lastId = await eventWriter.readLastEventId(runDir);
  let eventCounter = lastId !== null ? parseInt(lastId.replace("evt-", ""), 10) : 0;
  function getNextEventId(): string { return formatEventId(++eventCounter); }

  const signalReceivedId = getNextEventId();
  await eventWriter.appendEvent(runDir, {
    id: signalReceivedId,
    run_id: runId,
    type: "signal_received",
    timestamp: clock.now(),
    producer: "engine",
    job: sourceJobId,
    step: sourceStepId,
    attempt,
    payload: {
      signal: signalName ?? actionDiscriminator(action),
      from_job: sourceJobId,
      from_step: sourceStepId,
    },
  });

  // ── 7. Apply the action ───────────────────────────────────────────────────

  if (action === "continue") {
    // Write intermediate snapshot so advanceJob reads last_event_id that includes signal_received.
    // This preserves the event-first-then-snapshot invariant: the snapshot must always point
    // to the tail of events.jsonl before any subsequent reader (advanceJob) calls readSnapshot.
    const afterSignalState: RunState = {
      ...state,
      last_event_id: signalReceivedId,
    };
    await stateStore.writeSnapshot(runDir, afterSignalState);

    // Delegate to advanceJob — it writes its own snapshot
    // Import advanceJob lazily to avoid circular import issues at module load time
    const { advanceJob } = await import("./index.js");
    await advanceJob({ runDir, runId, jobId: sourceJobId, clock });
    return;
  }

  if (action === "fail") {
    const updatedState: RunState = {
      ...state,
      last_event_id: signalReceivedId,
      jobs: {
        ...state.jobs,
        [sourceJobId]: {
          ...sourceJobState,
          status: "failed",
        },
      },
    };
    await stateStore.writeSnapshot(runDir, updatedState);
    return;
  }

  if (action === "block") {
    const updatedState: RunState = {
      ...state,
      last_event_id: signalReceivedId,
      jobs: {
        ...state.jobs,
        [sourceJobId]: {
          ...sourceJobState,
          status: "blocked",
        },
      },
    };
    await stateStore.writeSnapshot(runDir, updatedState);
    return;
  }

  if (typeof action === "object" && action !== null && "retry_job" in action) {
    const targetJobId = action.retry_job;
    const targetJobState = state.jobs[targetJobId];
    if (targetJobState === undefined) {
      throw new StateError(`retry_job target "${targetJobId}" not found in state for run ${runId}`);
    }

    // Read max_attempts from workflow retry config (default 1)
    const retryConfig = wf.jobs[targetJobId]!.retry;
    const maxAttempts =
      retryConfig !== undefined &&
      typeof retryConfig["max_attempts"] === "number"
        ? (retryConfig["max_attempts"] as number)
        : 1;

    const currentAttempt = targetJobState.attempt ?? 1;
    const nextAttempt = currentAttempt + 1;

    if (nextAttempt > maxAttempts) {
      // WF-7.1: Seal the last open attempt as failure before terminal event
      if (targetJobState.attempts && targetJobState.attempts.length > 0) {
        const li = targetJobState.attempts.length - 1;
        const la = targetJobState.attempts[li]!;
        if (!la.status) {
          const attemptFailedId = getNextEventId();
          await eventWriter.appendEvent(runDir, {
            id: attemptFailedId,
            run_id: runId,
            type: "attempt_failed",
            timestamp: clock.now(),
            producer: "engine",
            job: targetJobId,
            step: null,
            attempt: currentAttempt,
            payload: {
              job_id: targetJobId,
              attempt: currentAttempt,
              failure_kind: "agent_error",
              reason,
              step_count: la.step_count ?? 0,
              duration_ms: 0,
            },
          });
        }
      }

      // Exhausted — read on_exceeded.status from workflow config (default: blocked)
      const onExceededStatus: "blocked" | "failed" =
        retryConfig !== undefined &&
        typeof retryConfig["on_exceeded"] === "object" &&
        retryConfig["on_exceeded"] !== null &&
        (retryConfig["on_exceeded"] as Record<string, unknown>)["status"] === "failed"
          ? "failed"
          : "blocked";

      // Emit terminal event (job_blocked or job_failed)
      const terminalEventId = getNextEventId();
      if (onExceededStatus === "failed") {
        await eventWriter.appendEvent(runDir, {
          id: terminalEventId,
          run_id: runId,
          type: "job_failed",
          timestamp: clock.now(),
          producer: "engine",
          job: targetJobId,
          step: null,
          attempt: currentAttempt,
          payload: { job_id: targetJobId, reason },
        });
      } else {
        await eventWriter.appendEvent(runDir, {
          id: terminalEventId,
          run_id: runId,
          type: "job_blocked",
          timestamp: clock.now(),
          producer: "engine",
          job: targetJobId,
          step: null,
          attempt: currentAttempt,
          payload: { job_id: targetJobId, reason },
        });
      }

      // Clear retry_inputs and current_step from terminal state (no future retry)
      const terminalJobState = { ...targetJobState };
      terminalJobState.status = onExceededStatus;
      delete terminalJobState.retry_inputs;
      delete terminalJobState.current_step;
      // WF-7.1: Seal the last open attempt in state
      if (terminalJobState.attempts && terminalJobState.attempts.length > 0) {
        const li = terminalJobState.attempts.length - 1;
        const la = terminalJobState.attempts[li]!;
        if (!la.status) {
          terminalJobState.attempts = [
            ...terminalJobState.attempts.slice(0, li),
            { ...la, status: "failure" as const, ended_at: clock.now() },
          ];
        }
      }

      const updatedState: RunState = {
        ...state,
        last_event_id: terminalEventId,
        jobs: {
          ...state.jobs,
          [targetJobId]: terminalJobState,
        },
      };
      await stateStore.writeSnapshot(runDir, updatedState);
      return;
    }

    // WF-7.1: Seal the last open attempt as failure before creating new attempt
    let sealedAttempts: import("../run/index.js").Attempt[] | undefined;
    if (targetJobState.attempts && targetJobState.attempts.length > 0) {
      sealedAttempts = [...targetJobState.attempts];
      const li = sealedAttempts.length - 1;
      const la = sealedAttempts[li]!;
      if (!la.status) {
        sealedAttempts[li] = { ...la, status: "failure" as const, ended_at: clock.now() };
        const attemptFailedId = getNextEventId();
        await eventWriter.appendEvent(runDir, {
          id: attemptFailedId,
          run_id: runId,
          type: "attempt_failed",
          timestamp: clock.now(),
          producer: "engine",
          job: targetJobId,
          step: null,
          attempt: currentAttempt,
          payload: {
            job_id: targetJobId,
            attempt: currentAttempt,
            failure_kind: "agent_error",
            reason,
            step_count: la.step_count ?? 0,
            duration_ms: 0,
          },
        });
      }
    }

    // WF-7.1: Create new open attempt
    const newAttempt = createOpenAttempt(nextAttempt, clock.now(), reason);
    const newAttempts = [...(sealedAttempts ?? targetJobState.attempts ?? []), newAttempt];
    const attemptStartedId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: attemptStartedId,
      run_id: runId,
      type: "attempt_started",
      timestamp: clock.now(),
      producer: "engine",
      job: targetJobId,
      step: null,
      attempt: nextAttempt,
      payload: { job_id: targetJobId, attempt: nextAttempt, reason },
    });

    // Append job_retrying
    const jobRetryingId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: jobRetryingId,
      run_id: runId,
      type: "job_retrying",
      timestamp: clock.now(),
      producer: "engine",
      job: targetJobId,
      step: null,
      attempt: nextAttempt,
      payload: { job_id: targetJobId, attempt: nextAttempt, reason },
    });

    // Reset job: status → ready, current_step → undefined, attempt → nextAttempt
    const retryJobState = { ...targetJobState };
    retryJobState.status = "ready";
    delete retryJobState.current_step;
    retryJobState.attempt = nextAttempt;
    retryJobState.retry_reason = reason;
    // WF-7.1: Store updated attempts array
    retryJobState.attempts = newAttempts;
    // Store retry_with data as retry_inputs (wholesale replacement, not merge)
    if (typeof action === "object" && "retry_with" in action && action.retry_with !== undefined) {
      retryJobState.retry_inputs = { ...action.retry_with };
    } else {
      delete retryJobState.retry_inputs;
    }

    const updatedState: RunState = {
      ...state,
      last_event_id: jobRetryingId,
      jobs: {
        ...state.jobs,
        [targetJobId]: retryJobState,
      },
    };
    await stateStore.writeSnapshot(runDir, updatedState);
    return;
  }

  if (typeof action === "object" && action !== null && "activate_job" in action) {
    const targetJobId = action.activate_job;
    const targetJobState = state.jobs[targetJobId];
    if (targetJobState === undefined) {
      throw new StateError(`activate_job target "${targetJobId}" not found in state for run ${runId}`);
    }

    if (targetJobState.status !== "inactive") {
      // Idempotent: job already activated — just update last_event_id
      const updatedState: RunState = {
        ...state,
        last_event_id: signalReceivedId,
      };
      await stateStore.writeSnapshot(runDir, updatedState);
      return;
    }

    // Append job_activated
    const jobActivatedId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: jobActivatedId,
      run_id: runId,
      type: "job_activated",
      timestamp: clock.now(),
      producer: "engine",
      job: targetJobId,
      step: null,
      attempt: null,
      payload: { job_id: targetJobId, reason },
    });

    // Compute readiness: if all `needs` are completed → ready, else waiting
    const completedJobIds = new Set<string>(
      Object.entries(state.jobs)
        .filter(([, js]) => js.status === "completed")
        .map(([id]) => id)
    );
    // Include all non-target non-completed jobs as active so computeReadyJobs
    // only considers the target job for readiness (correct DAG semantics).
    const activeJobIds = new Set<string>(
      Object.keys(state.jobs).filter(
        (id) => id !== targetJobId && !completedJobIds.has(id)
      )
    );
    const readyAfterActivation = new Set(computeReadyJobs(wf.jobs, completedJobIds, activeJobIds, state.jobs));
    const newStatus = readyAfterActivation.has(targetJobId) ? "ready" : "waiting";

    const activatedJobState = { ...targetJobState };
    activatedJobState.status = newStatus;
    activatedJobState.activated = true;
    activatedJobState.activation_reason = reason;

    // WF-7.1: Initialize attempt for jobs that become ready on activation
    let lastEventId = jobActivatedId;
    if (newStatus === "ready") {
      const openAttempt = createOpenAttempt(1, clock.now());
      activatedJobState.attempt = 1;
      activatedJobState.attempts = [openAttempt];

      const attemptStartedId = getNextEventId();
      await eventWriter.appendEvent(runDir, {
        id: attemptStartedId,
        run_id: runId,
        type: "attempt_started",
        timestamp: clock.now(),
        producer: "engine",
        job: targetJobId,
        step: null,
        attempt: 1,
        payload: { job_id: targetJobId, attempt: 1, reason },
      });
      lastEventId = attemptStartedId;
    }

    const updatedState: RunState = {
      ...state,
      last_event_id: lastEventId,
      jobs: {
        ...state.jobs,
        [targetJobId]: activatedJobState,
      },
    };
    await stateStore.writeSnapshot(runDir, updatedState);
    return;
  }

  if (typeof action === "object" && action !== null && "goto_job" in action) {
    const targetJobId = action.goto_job;
    const targetJobState = state.jobs[targetJobId];
    if (targetJobState === undefined) {
      throw new StateError(`goto_job target "${targetJobId}" not found in state for run ${runId}`);
    }

    // Guard: reject if target is already in a terminal or running state.
    // "ready" is allowed — goto_job to an already-ready job is idempotent.
    if (
      targetJobState.status !== "inactive" &&
      targetJobState.status !== "waiting" &&
      targetJobState.status !== "ready"
    ) {
      throw new WorkflowError(
        `goto_job target "${targetJobId}" is already in status "${targetJobState.status}"; cannot transition to ready`,
        { details: { sourceJobId, targetJobId, targetStatus: targetJobState.status } }
      );
    }

    // Append job_skipped
    const jobSkippedId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: jobSkippedId,
      run_id: runId,
      type: "job_skipped",
      timestamp: clock.now(),
      producer: "engine",
      job: sourceJobId,
      step: null,
      attempt,
      payload: { job_id: sourceJobId, target: targetJobId, reason },
    });

    // WF-7.2: Create implicit group for ungrouped source job on goto_job
    // Only when the workflow already has explicit job_groups (backward compat).
    let updatedJobGroups = state.job_groups ? { ...state.job_groups } : undefined;
    let lastEventId = jobSkippedId;
    if (state.job_groups !== undefined && sourceJobState.group === undefined) {
      const sourceJobDef = wf.jobs[sourceJobId];
      const maxVisits = sourceJobDef?.steps.reduce((max, s) => {
        return s.max_visits !== undefined ? Math.max(max, s.max_visits) : max;
      }, 0) || undefined;
      const { groupId, groupState } = createImplicitGroup(sourceJobId, targetJobId, maxVisits);
      updatedJobGroups = updatedJobGroups ?? {};
      if (!updatedJobGroups[groupId]) {
        updatedJobGroups[groupId] = groupState;
        const started = startNextIteration(updatedJobGroups[groupId]!, clock.now(), [sourceJobId]);
        updatedJobGroups[groupId] = started;

        const iterStartedId = getNextEventId();
        await eventWriter.appendEvent(runDir, {
          id: iterStartedId,
          run_id: runId,
          type: "iteration_started",
          timestamp: clock.now(),
          producer: "engine",
          job: sourceJobId,
          step: null,
          attempt,
          payload: {
            group_id: groupId,
            iteration: 1,
            job_ids: [sourceJobId],
          },
        });
        lastEventId = iterStartedId;
      }
      sourceJobState.group = groupId;
    }

    // Complete source job, clear current_step
    const completedSourceState = { ...sourceJobState };
    completedSourceState.status = "completed";
    delete completedSourceState.current_step;

    // Build the updated jobs map with source completed, then use computeReadyJobs
    // to decide whether target's deps are now satisfied (ready) or still unmet (waiting).
    const updatedJobs: RunState["jobs"] = {
      ...state.jobs,
      [sourceJobId]: completedSourceState,
    };

    const completedJobIdsForGoto = new Set<string>(
      Object.entries(updatedJobs)
        .filter(([, js]) => js.status === "completed")
        .map(([id]) => id)
    );
    const activeJobIdsForGoto = new Set<string>(
      Object.keys(state.jobs).filter(
        (id) => id !== targetJobId && !completedJobIdsForGoto.has(id)
      )
    );
    const readyAfterGoto = new Set(computeReadyJobs(wf.jobs, completedJobIdsForGoto, activeJobIdsForGoto, state.jobs));
    const newTargetStatus = readyAfterGoto.has(targetJobId) ? "ready" : "waiting";

    const readyTargetState = { ...targetJobState };
    readyTargetState.status = newTargetStatus;

    // WF-7.1: Initialize attempt for jobs that become ready via goto_job
    lastEventId = jobSkippedId;
    if (newTargetStatus === "ready") {
      const openAttempt = createOpenAttempt(1, clock.now());
      readyTargetState.attempt = 1;
      readyTargetState.attempts = [openAttempt];

      const attemptStartedId = getNextEventId();
      await eventWriter.appendEvent(runDir, {
        id: attemptStartedId,
        run_id: runId,
        type: "attempt_started",
        timestamp: clock.now(),
        producer: "engine",
        job: targetJobId,
        step: null,
        attempt: 1,
        payload: { job_id: targetJobId, attempt: 1, reason },
      });
      lastEventId = attemptStartedId;
    }

    const updatedState: RunState = {
      ...state,
      last_event_id: lastEventId,
      jobs: {
        ...updatedJobs,
        [targetJobId]: readyTargetState,
      },
    };
    await stateStore.writeSnapshot(runDir, updatedState);
    return;
  }

  // ── goto_step branch (WF-P13-FLOW) ──────────────────────────────────────

  if (typeof action === "object" && action !== null && "goto_step" in action) {
    const targetStepId = action.goto_step;

    // Validate target exists in same job in the workflow definition
    const jobDef = wf.jobs[sourceJobId];
    const targetStepDef = jobDef?.steps.find((s) => s.id === targetStepId);
    if (!targetStepDef) {
      throw new WorkflowError(
        `goto_step target "${targetStepId}" not found in job "${sourceJobId}"`,
        { details: { sourceJobId, targetStepId } }
      );
    }

    // Get current visit count for target step, increment
    const stepVisits = { ...(sourceJobState.step_visits ?? {}) };
    const currentVisits = stepVisits[targetStepId] ?? 0;
    const newVisitCount = currentVisits + 1;

    // Check max_visits on the target step
    const maxVisits = typeof targetStepDef.max_visits === "number" ? targetStepDef.max_visits : 3;

    if (newVisitCount > maxVisits) {
      // Exceeded — block step and job
      const exceededEventId = getNextEventId();
      await eventWriter.appendEvent(runDir, {
        id: exceededEventId,
        run_id: runId,
        type: "step_visit_exceeded",
        timestamp: clock.now(),
        producer: "engine",
        job: sourceJobId,
        step: sourceStepId,
        attempt,
        payload: { job_id: sourceJobId, step_id: targetStepId, max_visits: maxVisits, visit_count: newVisitCount },
      });

      stepVisits[targetStepId] = newVisitCount;
      const blockedState: RunState = {
        ...state,
        last_event_id: exceededEventId,
        jobs: {
          ...state.jobs,
          [sourceJobId]: {
            ...sourceJobState,
            status: "blocked",
            current_step: targetStepId,
            step_visits: stepVisits,
          },
        },
      };
      await stateStore.writeSnapshot(runDir, blockedState);
      return;
    }

    // Within limits — append step_revisited event
    const revisitedEventId = getNextEventId();
    await eventWriter.appendEvent(runDir, {
      id: revisitedEventId,
      run_id: runId,
      type: "step_revisited",
      timestamp: clock.now(),
      producer: "engine",
      job: sourceJobId,
      step: sourceStepId,
      attempt,
      payload: { job_id: sourceJobId, step_id: sourceStepId, target_step: targetStepId, visit_count: newVisitCount },
    });

    // Build updated job state: redirect to target step, increment visit count
    stepVisits[targetStepId] = newVisitCount;
    const updatedJobState = {
      ...sourceJobState,
      current_step: targetStepId,
      step_visits: stepVisits,
    };

    // Handle goto_with → retry_inputs (preserves attempt number)
    if ("goto_with" in action && action.goto_with !== undefined) {
      updatedJobState.retry_inputs = { ...action.goto_with };
    } else {
      delete updatedJobState.retry_inputs;
    }

    // WF-7.2: Create implicit group for ungrouped job on goto_step
    // Only when the workflow already has explicit job_groups (backward compat).
    let updatedJobGroups = state.job_groups ? { ...state.job_groups } : undefined;
    let finalEventId = revisitedEventId;
    if (state.job_groups !== undefined && sourceJobState.group === undefined) {
      const { groupId, groupState } = createImplicitGroup(sourceJobId, undefined, maxVisits);
      updatedJobGroups = updatedJobGroups ?? {};
      if (!updatedJobGroups[groupId]) {
        updatedJobGroups[groupId] = groupState;
        const started = startNextIteration(updatedJobGroups[groupId]!, clock.now(), [sourceJobId]);
        updatedJobGroups[groupId] = started;

        const iterStartedId = getNextEventId();
        await eventWriter.appendEvent(runDir, {
          id: iterStartedId,
          run_id: runId,
          type: "iteration_started",
          timestamp: clock.now(),
          producer: "engine",
          job: sourceJobId,
          step: sourceStepId,
          attempt,
          payload: {
            group_id: groupId,
            iteration: 1,
            job_ids: [sourceJobId],
          },
        });
        finalEventId = iterStartedId;
      }
      sourceJobState.group = groupId;
    }

    const updatedState: RunState = {
      ...state,
      last_event_id: finalEventId,
      jobs: {
        ...state.jobs,
        [sourceJobId]: updatedJobState,
      },
      ...(updatedJobGroups !== undefined ? { job_groups: updatedJobGroups } : {}),
    };
    await stateStore.writeSnapshot(runDir, updatedState);
    return;
  }
}

// ---------------------------------------------------------------------------
// Helper: get the string discriminator of a RouterAction
// ---------------------------------------------------------------------------

export function actionDiscriminator(action: RouterAction): string {
  if (action === "continue") return "continue";
  if (action === "fail") return "fail";
  if (action === "block") return "block";
  if (typeof action === "object" && action !== null) {
    if ("retry_job" in action) return "retry_job";
    if ("activate_job" in action) return "activate_job";
    if ("goto_job" in action) return "goto_job";
    if ("goto_step" in action) return "goto_step";
    if ("status" in action) return action.status;
  }
  return String(action);
}
