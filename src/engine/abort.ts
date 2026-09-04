/**
 * abortRun — Engine entry point for the CLI `abort` command.
 *
 * Called when the user explicitly cancels an active run. Sets the run status
 * to "cancelled" and appends a run_cancelled event. Does NOT modify individual
 * job statuses (MVP §18 semantics: jobs remain in their current state).
 *
 * Contract:
 *   1. Read state snapshot.
 *   2. Validate run status is "running", "blocked", or undefined (treat as running).
 *      Throw StateError if already terminal (completed, cancelled, failed).
 *   3. Emit run_cancelled event.
 *   4. Set state.status = "cancelled".
 *   5. Write snapshot with last_event_id = run_cancelled event id.
 *
 * Reference:
 *   - docs/phases/p9p10-cli-admin-commands/workflows/wf-cli-commands/
 *   - docs/mvp-contracts.md §2.3, §2.4
 */

import {
  disposeEventSequence,
  disposeEventWriter,
  nextSequentialEventId,
} from "../events/index.js";
import { disposeStateStore, JsonlEventWriter, LocalStateStore } from "../run/index.js";
import type { Clock, RunState } from "../run/index.js";
import { StateError } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AbortRunOpts {
  /** Absolute path to the run directory (e.g. <runsDir>/<runId>). */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** Clock for timestamping the run_cancelled event. */
  clock: Clock;
  /** Optional human-readable reason for the abort. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// abortRun
// ---------------------------------------------------------------------------

export async function abortRun(opts: AbortRunOpts): Promise<void> {
  const { runDir, runId, clock, reason } = opts;

  const stateStore = new LocalStateStore();
  const eventWriter = new JsonlEventWriter();

  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
  // ── 1. Read state snapshot ─────────────────────────────────────────────────

  const state = await stateStore.readSnapshot(runDir);
  if (state === null) {
    throw new StateError(`state.json missing for run ${runId}`);
  }

  // ── 2. Validate run is not already in a terminal state ─────────────────────
  //
  // Terminal statuses: completed, cancelled, failed.
  // Allowed: running, blocked, undefined (treat as running).

  const terminalStatuses = new Set(["completed", "cancelled", "failed"]);
  if (state.status !== undefined && terminalStatuses.has(state.status)) {
    throw new StateError(
      `Run "${runId}" cannot be aborted: status is "${state.status}" (already terminal)`,
      { details: { runId, status: state.status } }
    );
  }

  // ── 3. Emit run_cancelled event ────────────────────────────────────────────

  const cancelledEventId = await nextSequentialEventId(runDir, eventWriter);

  await eventWriter.appendEvent(runDir, {
    id: cancelledEventId,
    run_id: runId,
    type: "run_cancelled",
    timestamp: clock.now(),
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
    payload: { reason: reason ?? "" },
  });

  // ── 4. Set state.status = "cancelled" ─────────────────────────────────────
  //      Do NOT modify individual job statuses.

  const updatedState: RunState = {
    ...state,
    status: "cancelled",
    last_event_id: cancelledEventId,
  };
  await stateStore.writeSnapshot(runDir, updatedState);
  } catch (error: unknown) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupErrors: unknown[] = [];
  const cleanup = await Promise.allSettled([
    disposeEventWriter(runDir),
    disposeEventSequence(runDir),
    disposeStateStore(runDir),
  ]);
  for (const result of cleanup) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Abort failed and teardown reported additional errors",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Abort teardown failed");
  }
}
