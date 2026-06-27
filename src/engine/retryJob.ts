/**
 * retryJob — Engine entry point for the CLI `retry --job` command.
 *
 * Called when the user explicitly asks to retry a job that is in a terminal
 * state (completed, failed, or blocked). Unlike the routing.ts retry_job
 * action (which is triggered by a signal), this entry point does NOT emit
 * a signal_received event — it directly emits job_retrying (or the
 * on_exceeded terminal event).
 *
 * Contract:
 *   1. Read state snapshot.
 *   2. Validate job status is completed, failed, or blocked → UserInputError.
 *   3. Read max_attempts from workflow retry config via run.yml.
 *   4. If (attempt >= max_attempts): emit terminal event + set status.
 *   5. Otherwise: emit job_retrying, increment attempt, set status = ready.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/
 *   - docs/mvp-contracts.md §2.3, §2.4
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

import { nextEventId as formatEventId } from "../events/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import { loadWorkflowFile } from "../workflow/index.js";
import { StateError, UserInputError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RetryJobOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Job identifier to retry. */
  jobId: string;
  /** Clock for timestamping events. */
  clock: Clock;
  /** Optional human-readable reason for the retry. */
  reason?: string;
  /** Optional wholesale-replacement inputs for the retry attempt. */
  retryInputs?: Record<string, string>;
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
// retryJob
// ---------------------------------------------------------------------------

export async function retryJob(opts: RetryJobOpts): Promise<void> {
  const { runDir, runId, jobId, clock, reason, retryInputs } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  // ── 1. Read state snapshot ─────────────────────────────────────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  const jobState = state.jobs[jobId];
  if (jobState === undefined) {
    throw new UserInputError(`Job "${jobId}" not found in state for run ${runId}`);
  }

  // ── 2. Validate job status is retryable ────────────────────────────────────

  const retryableStatuses = new Set(["completed", "failed", "blocked"]);
  if (!retryableStatuses.has(jobState.status)) {
    throw new UserInputError(
      `Job "${jobId}" cannot be retried: status is "${jobState.status}" (must be completed, failed, or blocked)`,
      { details: { jobId, status: jobState.status } }
    );
  }

  // ── 3. Read workflow retry config ──────────────────────────────────────────

  const workflowPath = await readWorkflowPathFromRunYml(runDir);
  const wf = await loadWorkflowFile(workflowPath);

  const retryConfig = wf.jobs[jobId]?.retry;
  const maxAttempts =
    retryConfig !== undefined && typeof retryConfig["max_attempts"] === "number"
      ? (retryConfig["max_attempts"] as number)
      : 1;

  const currentAttempt = jobState.attempt ?? 1;
  const nextAttempt = currentAttempt + 1;

  // ── 4. Get next event id ───────────────────────────────────────────────────

  const lastId = await eventWriter.readLastEventId(runDir);
  let eventCounter = lastId !== null ? parseInt(lastId.replace("evt-", ""), 10) : 0;
  function getNextEventId(): string {
    return formatEventId(++eventCounter);
  }

  // ── 5. Check if max_attempts exceeded ─────────────────────────────────────

  if (currentAttempt >= maxAttempts) {
    // Exhausted — read on_exceeded.status (default: "blocked")
    const onExceededStatus: "blocked" | "failed" =
      retryConfig !== undefined &&
      typeof retryConfig["on_exceeded"] === "object" &&
      retryConfig["on_exceeded"] !== null &&
      (retryConfig["on_exceeded"] as Record<string, unknown>)["status"] === "failed"
        ? "failed"
        : "blocked";

    const terminalEventId = getNextEventId();
    if (onExceededStatus === "failed") {
      await eventWriter.appendEvent(runDir, {
        id: terminalEventId,
        run_id: runId,
        type: "job_failed",
        timestamp: clock.now(),
        producer: "engine",
        job: jobId,
        step: null,
        attempt: currentAttempt,
        payload: { job_id: jobId, reason: reason ?? "max attempts exceeded" },
      });
    } else {
      await eventWriter.appendEvent(runDir, {
        id: terminalEventId,
        run_id: runId,
        type: "job_blocked",
        timestamp: clock.now(),
        producer: "engine",
        job: jobId,
        step: null,
        attempt: currentAttempt,
        payload: { job_id: jobId, reason: reason ?? "max attempts exceeded" },
      });
    }

    const terminalJobState = { ...jobState };
    terminalJobState.status = onExceededStatus;
    delete terminalJobState.current_step;
    delete terminalJobState.retry_inputs;

    const updatedState: RunState = {
      ...state,
      last_event_id: terminalEventId,
      jobs: {
        ...state.jobs,
        [jobId]: terminalJobState,
      },
    };
    await stateStore.writeSnapshot(runDir, updatedState);
    return;
  }

  // ── 6. Emit job_retrying event ─────────────────────────────────────────────

  const jobRetryingId = getNextEventId();
  await eventWriter.appendEvent(runDir, {
    id: jobRetryingId,
    run_id: runId,
    type: "job_retrying",
    timestamp: clock.now(),
    producer: "engine",
    job: jobId,
    step: null,
    attempt: nextAttempt,
    payload: { job_id: jobId, attempt: nextAttempt, reason: reason ?? "" },
  });

  // ── 7. Update job state: status → ready, attempt++, clear current_step ─────

  const retryJobState = { ...jobState };
  retryJobState.status = "ready";
  retryJobState.attempt = nextAttempt;
  delete retryJobState.current_step;
  // Reset step_visits on retry (WF-P13-FLOW)
  delete (retryJobState as Record<string, unknown>)["step_visits"];
  if (reason !== undefined) {
    retryJobState.retry_reason = reason;
  }

  // Persist retry_inputs as wholesale replacement
  if (retryInputs !== undefined) {
    retryJobState.retry_inputs = { ...retryInputs };
  } else {
    delete retryJobState.retry_inputs;
  }

  const updatedState: RunState = {
    ...state,
    last_event_id: jobRetryingId,
    jobs: {
      ...state.jobs,
      [jobId]: retryJobState,
    },
  };
  await stateStore.writeSnapshot(runDir, updatedState);
}
