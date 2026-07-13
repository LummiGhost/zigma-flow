/**
 * Traverse executor — handles the traversal/fan-out construct (Issue #179).
 *
 * The traverse node is a bounded Engine-owned fan-out primitive that:
 *   1. Resolves a list from a previous job's output via ${{ }} expression
 *   2. Iterates over items, passing each item to the target job
 *   3. Supports optional concurrency and per-item failure policies
 *   4. Aggregates per-item results as its own output
 *
 * Reference: docs/prd.md FR-018, docs/architecture.md §6.2
 * WF-P16-TRAVERSE Step 2.
 */

import type { Clock, RunState, TraverseItemResult, TraverseState } from "../run/index.js";
import { JsonlEventWriter, LocalStateStore } from "../run/index.js";
import { nextSequentialEventId } from "../events/sequence.js";
import type { ZigmaFlowEvent } from "../events/index.js";
import type { WorkflowDefinition } from "../workflow/index.js";
import type { ExpressionContext } from "../expression/index.js";
import { resolveExpression } from "../expression/index.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExecuteTraverseOpts {
  /** Absolute path to the run directory. */
  runDir: string;
  /** Run identifier. */
  runId: string;
  /** The parsed workflow definition. */
  wf: WorkflowDefinition;
  /** Current run state snapshot (read prior to this call). */
  state: RunState;
  /** Injectable clock. */
  clock: Clock;
  /** Injectable event writer. */
  eventWriter?: JsonlEventWriter;
  /** Injectable state store. */
  stateStore?: LocalStateStore;
  /** Callback for each event emitted. */
  onEvent?: ((e: ZigmaFlowEvent) => void) | undefined;
}

export interface ExecuteTraverseResult {
  /** Whether any work was done (items were started or progressed). */
  worked: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the traverse input expression against the current run state.
 * Returns the array of items (null if the expression cannot yet be resolved).
 */
export function resolveTraverseInput(
  inputExpression: string,
  state: RunState,
): unknown[] | null {
  const ctx: ExpressionContext = {
    inputs: { task: state.task },
    run: { id: state.run_id, workflow: state.workflow },
    ...(state.variables !== undefined ? { variables: state.variables } : {}),
    jobs: Object.fromEntries(
      Object.entries(state.jobs).map(([id, js]) => [
        id,
        js.outputs !== undefined ? { outputs: js.outputs } : {},
      ])
    ) as Record<string, { outputs?: Record<string, unknown> }>,
  };

  // Resolve the expression. If it still contains ${{, the input is not ready yet.
  const resolved = resolveExpression(inputExpression, ctx);
  if (resolved.includes("${{")) {
    return null; // not ready yet
  }

  // Try to parse the result as JSON, or fall back to treating it as a comma-separated list
  try {
    const parsed = JSON.parse(resolved);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    // If it's a single value, wrap it in an array
    return [parsed];
  } catch {
    // If not valid JSON and not empty, treat as a single-item array
    if (resolved.trim().length > 0) {
      return [resolved.trim()];
    }
    return [];
  }
}

/**
 * Determine which upstream job(s) a traverse depends on by parsing its input
 * expression.
 */
export function getTraverseInputJob(inputExpression: string): string | null {
  const match = /\$\{\{\s*jobs\.([^.]+)\.outputs\./.exec(inputExpression);
  return match?.[1] ?? null;
}

/** Generate a stable virtual job ID for a traverse item. */
function makeVirtualJobId(traverseId: string, itemIndex: number): string {
  return `__traverse/${traverseId}/item-${itemIndex}`;
}

/**
 * Given a virtual job ID, extract the parent traverse id and item index.
 * Returns null if the job ID is not a traverse virtual job.
 */
export function parseVirtualJobId(jobId: string): { traverseId: string; itemIndex: number } | null {
  const match = /^__traverse\/(.+)\/item-(\d+)$/.exec(jobId);
  if (!match) return null;
  return { traverseId: match[1]!, itemIndex: parseInt(match[2]!, 10) };
}

// ---------------------------------------------------------------------------
// checkAndExecuteTraverses — called from the runAll post-batch phase
// ---------------------------------------------------------------------------

/**
 * Check all traverse nodes in the workflow and advance those whose inputs are
 * ready. This function is called after each batch of job execution in runAll.
 *
 * States transition:
 *   (no state) -> pending (when input job completes and input resolves)
 *   pending    -> running (when items start executing)
 *   running    -> completed (when all items are done)
 *                -> failed (when fail_all policy triggers)
 */
export async function checkAndExecuteTraverses(
  opts: ExecuteTraverseOpts,
): Promise<ExecuteTraverseResult> {
  const {
    runDir,
    runId,
    wf,
    state,
    clock,
    eventWriter = new JsonlEventWriter(),
    stateStore = new LocalStateStore(),
    onEvent,
  } = opts;

  const traverseDefs = wf.traverse;
  if (!traverseDefs) {
    return { worked: false };
  }

  let anyWork = false;

  for (const [traverseId, tDef] of Object.entries(traverseDefs)) {
    // Get fresh state before each traverse
    let currentState = await stateStore.readSnapshot(runDir);
    if (currentState === null) continue;

    // Check if the traverse already exists in state
    const existingTraverse = currentState.traverses?.[traverseId];

    // If already completed or failed, skip
    if (existingTraverse?.status === "completed" || existingTraverse?.status === "failed") {
      continue;
    }

    // If the traverse is not yet created, try to resolve its input
    if (!existingTraverse) {
      const items = resolveTraverseInput(tDef.input, currentState);
      if (items === null) {
        continue; // input not ready yet
      }

      // Create the traverse state
      const traverseState: TraverseState = {
        status: "pending",
        input_expression: tDef.input,
        items,
        item_key: tDef.item_context.key,
        ...(tDef.item_context.index_key !== undefined ? { index_key: tDef.item_context.index_key } : {}),
        on_item_failure: tDef.on_item_failure ?? "fail_all",
        concurrency: tDef.concurrency ?? 1,
        target_job: tDef.target.job,
        completed_count: 0,
        failed_count: 0,
        active_count: 0,
        item_results: [],
      };

      // Emit traverse_started event
      const startedEvtId = await nextSequentialEventId(runDir, eventWriter);
      const startedEvt: ZigmaFlowEvent = {
        id: startedEvtId,
        run_id: runId,
        type: "traverse_started",
        timestamp: clock.now(),
        producer: "engine",
        job: null,
        step: null,
        attempt: null,
        payload: {
          traverse_id: traverseId,
          item_count: items.length,
          concurrency: traverseState.concurrency,
          target_job: traverseState.target_job,
        },
      };
      await eventWriter.appendEvent(runDir, startedEvt);
      onEvent?.(startedEvt);

      // Write initial traverse state
      await stateStore.updateState(runDir, (cur) => ({
        ...cur,
        last_event_id: startedEvtId,
        traverses: {
          ...cur.traverses,
          [traverseId]: traverseState,
        },
      }));

      anyWork = true;

      // If the list is empty, complete immediately
      if (items.length === 0) {
        const completedEvtId = await nextSequentialEventId(runDir, eventWriter);
        const completedEvt: ZigmaFlowEvent = {
          id: completedEvtId,
          run_id: runId,
          type: "traverse_completed",
          timestamp: clock.now(),
          producer: "engine",
          job: null,
          step: null,
          attempt: null,
          payload: {
            traverse_id: traverseId,
            results_count: 0,
            errors_count: 0,
          },
        };
        await eventWriter.appendEvent(runDir, completedEvt);
        onEvent?.(completedEvt);

        await stateStore.updateState(runDir, (cur) => ({
          ...cur,
          last_event_id: completedEvtId,
          traverses: {
            ...cur.traverses,
            [traverseId]: {
              ...traverseState,
              status: "completed" as const,
              aggregated_outputs: buildAggregatedOutputs([]),
            },
          },
        }));
        continue;
      }

      // For non-empty lists, create virtual jobs for items up to concurrency
      await startTraverseItems({
        runDir, runId, traverseId, tDef: traverseState,
        targetJobDef: wf.jobs[tDef.target.job]!,
        stateStore, eventWriter, clock, onEvent,
      });
      anyWork = true;
      continue;
    }

    // Traverse exists and is running — check if virtual job items have completed
    if (existingTraverse.status === "running" || existingTraverse.status === "pending") {
      const processed = await finalizeCompletedTraverseItems({
        runDir, runId, traverseId, tState: existingTraverse,
        stateStore, eventWriter, clock, onEvent,
      });

      if (processed) {
        anyWork = true;

        // Re-read traverse state after finalization
        const updatedState = await stateStore.readSnapshot(runDir);
        if (!updatedState) continue;
        const updatedTraverse = updatedState.traverses?.[traverseId];
        if (!updatedTraverse) continue;

        // Check if we need to start more items (concurrency)
        if (updatedTraverse.status === "running") {
          const canStartMore = updatedTraverse.active_count < updatedTraverse.concurrency;
          const hasPendingItems = updatedTraverse.completed_count +
            updatedTraverse.failed_count + updatedTraverse.active_count <
            updatedTraverse.items.length;

          if (canStartMore && hasPendingItems) {
            await startTraverseItems({
              runDir, runId, traverseId, tDef: updatedTraverse,
              targetJobDef: wf.jobs[tDef.target.job]!,
              stateStore, eventWriter, clock, onEvent,
            });
          }
        }
      }
    }
  }

  return { worked: anyWork };
}

// ---------------------------------------------------------------------------
// Internal: startTraverseItems — create virtual jobs for traverse items
// ---------------------------------------------------------------------------

interface StartTraverseItemsOpts {
  runDir: string;
  runId: string;
  traverseId: string;
  tDef: TraverseState;
  targetJobDef: import("../workflow/index.js").JobDefinition;
  stateStore: LocalStateStore;
  eventWriter: JsonlEventWriter;
  clock: Clock;
  onEvent?: ((e: ZigmaFlowEvent) => void) | undefined;
}

async function startTraverseItems(opts: StartTraverseItemsOpts): Promise<void> {
  const {
    runDir, runId, traverseId, tDef, stateStore, eventWriter, clock, onEvent,
  } = opts;

  const concurrency = Math.max(1, tDef.concurrency);
  const nextBatchStart = tDef.completed_count + tDef.failed_count + tDef.active_count;
  const maxToStart = Math.min(
    concurrency - tDef.active_count,
    tDef.items.length - nextBatchStart,
  );

  if (maxToStart <= 0) return;

  let lastEventId = "";

  for (let i = 0; i < maxToStart; i++) {
    const itemIndex = nextBatchStart + i;
    const itemValue = tDef.items[itemIndex];
    const itemKey = String(itemValue);

    // Create a virtual job for this item
    const virtualJobId = makeVirtualJobId(traverseId, itemIndex);

    // Emit traverse_item_started event
    const itemStartedEvtId = await nextSequentialEventId(runDir, eventWriter);
    const itemStartedEvt: ZigmaFlowEvent = {
      id: itemStartedEvtId,
      run_id: runId,
      type: "traverse_item_started",
      timestamp: clock.now(),
      producer: "engine",
      job: virtualJobId,
      step: null,
      attempt: null,
      payload: {
        traverse_id: traverseId,
        item_index: itemIndex,
        item_key: itemKey,
      },
    };
    await eventWriter.appendEvent(runDir, itemStartedEvt);
    onEvent?.(itemStartedEvt);
    lastEventId = itemStartedEvtId;

    // Write the virtual job into state (without outputs field)
    await stateStore.updateState(runDir, (cur) => ({
      ...cur,
      last_event_id: itemStartedEvtId,
      jobs: {
        ...cur.jobs,
        [virtualJobId]: {
          status: "ready" as const,
        },
      },
      traverses: {
        ...cur.traverses,
        [traverseId]: {
          ...cur.traverses![traverseId]!,
          status: "running" as const,
          active_count: (cur.traverses![traverseId]?.active_count ?? 0) + 1,
        },
      },
    }));
  }

  // Emit job_ready events for each virtual job
  for (let i = 0; i < maxToStart; i++) {
    const itemIndex = nextBatchStart + i;
    const virtualJobId = makeVirtualJobId(traverseId, itemIndex);

    const jobReadyEvtId = await nextSequentialEventId(runDir, eventWriter);
    const jobReadyEvt: ZigmaFlowEvent = {
      id: jobReadyEvtId,
      run_id: runId,
      type: "job_ready",
      timestamp: clock.now(),
      producer: "engine",
      job: null,
      step: null,
      attempt: null,
      payload: { job_id: virtualJobId },
    };
    await eventWriter.appendEvent(runDir, jobReadyEvt);
    onEvent?.(jobReadyEvt);
    lastEventId = jobReadyEvtId;
  }

  if (lastEventId) {
    await stateStore.updateState(runDir, (cur) => ({
      ...cur,
      last_event_id: lastEventId,
    }));
  }
}

// ---------------------------------------------------------------------------
// Internal: finalizeCompletedTraverseItems — check for completed/failed items
// ---------------------------------------------------------------------------

interface FinalizeItemsOpts {
  runDir: string;
  runId: string;
  traverseId: string;
  tState: TraverseState;
  stateStore: LocalStateStore;
  eventWriter: JsonlEventWriter;
  clock: Clock;
  onEvent?: ((e: ZigmaFlowEvent) => void) | undefined;
}

async function finalizeCompletedTraverseItems(
  opts: FinalizeItemsOpts,
): Promise<boolean> {
  const {
    runDir, runId, traverseId, tState,
    stateStore, eventWriter, clock, onEvent,
  } = opts;

  let anyChange = false;
  // Read fresh state at the start
  let currentState = await stateStore.readSnapshot(runDir);
  if (!currentState) return false;

  // Track cumulative counts locally to avoid stale tState values
  let completedAccum = tState.completed_count;
  let failedAccum = tState.failed_count;
  let activeAccum = tState.active_count;

  // Check all virtual jobs for this traverse
  for (let itemIndex = 0; itemIndex < tState.items.length; itemIndex++) {
    const virtualJobId = makeVirtualJobId(traverseId, itemIndex);
    const jobState = currentState.jobs[virtualJobId];

    // Skip items not yet started
    if (!jobState) continue;

    // Skip already-recorded items (check from current state's traverse)
    const currentTraverse = currentState.traverses?.[traverseId];
    const alreadyRecorded = currentTraverse?.item_results.some((r) => r.index === itemIndex) ?? false;
    if (alreadyRecorded) continue;

    if (jobState.status === "completed") {
      // Item completed successfully
      const itemCompletedEvtId = await nextSequentialEventId(runDir, eventWriter);
      const itemCompletedEvt: ZigmaFlowEvent = {
        id: itemCompletedEvtId,
        run_id: runId,
        type: "traverse_item_completed",
        timestamp: clock.now(),
        producer: "engine",
        job: virtualJobId,
        step: null,
        attempt: null,
        payload: {
          traverse_id: traverseId,
          item_index: itemIndex,
          ...(jobState.outputs !== undefined ? { outputs: jobState.outputs } : {}),
        },
      };
      await eventWriter.appendEvent(runDir, itemCompletedEvt);
      onEvent?.(itemCompletedEvt);

      const newResult: TraverseItemResult = {
        index: itemIndex,
        key: String(tState.items[itemIndex]),
        outputs: jobState.outputs ?? {},
        status: "completed" as const,
      };

      completedAccum += 1;
      activeAccum = Math.max(0, activeAccum - 1);

      await stateStore.updateState(runDir, (cur) => ({
        ...cur,
        last_event_id: itemCompletedEvtId,
        traverses: {
          ...cur.traverses,
          [traverseId]: {
            ...cur.traverses![traverseId]!,
            completed_count: completedAccum,
            active_count: activeAccum,
            item_results: [
              ...(cur.traverses![traverseId]?.item_results ?? []),
              newResult,
            ],
          },
        },
      }));

      // Check if all items are done
      const updatedState = await stateStore.readSnapshot(runDir);
      if (!updatedState) return anyChange;
      currentState = updatedState;
      const updatedTraverse = updatedState.traverses?.[traverseId];

      if (updatedTraverse) {
        const totalDone = updatedTraverse.completed_count + updatedTraverse.failed_count;
        if (totalDone >= updatedTraverse.items.length) {
          await completeTraverse({
            runDir, runId, traverseId, tState: updatedTraverse,
            stateStore, eventWriter, clock, onEvent,
          });
          return true;
        }
      }

      anyChange = true;
    } else if (jobState.status === "failed" || jobState.status === "blocked") {
      // Item failed
      const itemFailedEvtId = await nextSequentialEventId(runDir, eventWriter);
      const itemFailedEvt: ZigmaFlowEvent = {
        id: itemFailedEvtId,
        run_id: runId,
        type: "traverse_item_failed",
        timestamp: clock.now(),
        producer: "engine",
        job: virtualJobId,
        step: null,
        attempt: null,
        payload: {
          traverse_id: traverseId,
          item_index: itemIndex,
          error: "Item execution failed",
        },
      };
      await eventWriter.appendEvent(runDir, itemFailedEvt);
      onEvent?.(itemFailedEvt);

      const newResult: TraverseItemResult = {
        index: itemIndex,
        key: String(tState.items[itemIndex]),
        error: "Item execution failed",
        status: "failed" as const,
      };

      failedAccum += 1;
      activeAccum = Math.max(0, activeAccum - 1);

      // Handle based on on_item_failure policy
      if (tState.on_item_failure === "fail_all") {
        // Fail the entire traverse immediately
        await stateStore.updateState(runDir, (cur) => ({
          ...cur,
          last_event_id: itemFailedEvtId,
          traverses: {
            ...cur.traverses,
            [traverseId]: {
              ...cur.traverses![traverseId]!,
              status: "failed" as const,
              failed_count: failedAccum,
              active_count: activeAccum,
              item_results: [
                ...(cur.traverses![traverseId]?.item_results ?? []),
                newResult,
              ],
            },
          },
        }));
        return true;
      }

      // For continue/collect, record the failure and keep going
      await stateStore.updateState(runDir, (cur) => ({
        ...cur,
        last_event_id: itemFailedEvtId,
        traverses: {
          ...cur.traverses,
          [traverseId]: {
            ...cur.traverses![traverseId]!,
            failed_count: failedAccum,
            active_count: activeAccum,
            item_results: [
              ...(cur.traverses![traverseId]?.item_results ?? []),
              newResult,
            ],
          },
        },
      }));

      // Check if all items are done
      const updatedState2 = await stateStore.readSnapshot(runDir);
      if (!updatedState2) return anyChange;
      currentState = updatedState2;
      const updatedTraverse2 = updatedState2.traverses?.[traverseId];

      if (updatedTraverse2) {
        const totalDone = updatedTraverse2.completed_count + updatedTraverse2.failed_count;
        if (totalDone >= updatedTraverse2.items.length) {
          await completeTraverse({
            runDir, runId, traverseId, tState: updatedTraverse2,
            stateStore, eventWriter, clock, onEvent,
          });
          return true;
        }
      }

      anyChange = true;
    }
  }

  return anyChange;
}

// ---------------------------------------------------------------------------
// Internal: completeTraverse — finalize the traverse and aggregate outputs
// ---------------------------------------------------------------------------

interface CompleteTraverseOpts {
  runDir: string;
  runId: string;
  traverseId: string;
  tState: TraverseState;
  stateStore: LocalStateStore;
  eventWriter: JsonlEventWriter;
  clock: Clock;
  onEvent?: ((e: ZigmaFlowEvent) => void) | undefined;
}

async function completeTraverse(opts: CompleteTraverseOpts): Promise<void> {
  const { runDir, runId, traverseId, tState, stateStore, eventWriter, clock, onEvent } = opts;

  const completedEvtId = await nextSequentialEventId(runDir, eventWriter);
  const completedEvt: ZigmaFlowEvent = {
    id: completedEvtId,
    run_id: runId,
    type: "traverse_completed",
    timestamp: clock.now(),
    producer: "engine",
    job: null,
    step: null,
    attempt: null,
    payload: {
      traverse_id: traverseId,
      results_count: tState.completed_count,
      errors_count: tState.failed_count,
    },
  };
  await eventWriter.appendEvent(runDir, completedEvt);
  onEvent?.(completedEvt);

  const results = tState.item_results;
  await stateStore.updateState(runDir, (cur) => ({
    ...cur,
    last_event_id: completedEvtId,
    traverses: {
      ...cur.traverses,
      [traverseId]: {
        ...cur.traverses![traverseId]!,
        status: "completed" as const,
        aggregated_outputs: buildAggregatedOutputs(results),
      },
    },
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build aggregated outputs from item results.
 * Always provides the raw results array under the "results" key.
 */
function buildAggregatedOutputs(
  results: TraverseItemResult[],
): Record<string, unknown[]> {
  const aggregated: Record<string, unknown[]> = {};

  // Always provide the raw results
  aggregated["results"] = results.map((r) => ({
    index: r.index,
    key: r.key,
    status: r.status,
    outputs: r.outputs,
    error: r.error,
  }));

  return aggregated;
}
